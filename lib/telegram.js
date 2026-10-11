/* =========================================================================
 * telegram.js — perintah Boss lewat bot Telegram → Visual Office → laporan balik ke Telegram.
 *
 *   POST /api/telegram + header X-Telegram-Bot-Api-Secret-Token  (dipanggil server Telegram)
 *   (satu endpoint saja: paket Hobby Vercel membatasi jumlah function per deployment)
 *   GET  /api/telegram?action=status   (login) status bot, webhook & chat yang terhubung
 *   GET  /api/telegram?action=inbox    (login) browser mengambil perintah baru + tanda "kantor sedang dibuka"
 *   POST /api/telegram {action:'setup'}            pasang webhook ke domain ini
 *   POST /api/telegram {action:'link'}             buat kode tautan sekali pakai (/link KODE di bot)
 *   POST /api/telegram {action:'reply', chatId, text}   kirim laporan ke chat yang sudah terhubung
 *   POST /api/telegram {action:'unlink', chatId}
 *
 * Alur: pesan masuk → bila kantor sedang dibuka di browser, perintah masuk antrean dan dikerjakan
 * oleh seluruh hierarki (animasi kantor, laporan, Gudang Dokumen) lalu laporan dikirim balik.
 * Bila kantor sedang tidak dibuka, perintah langsung dikerjakan di server oleh AI (atas nama
 * divisi/karyawan tujuan), laporan disimpan ke Gudang Dokumen & dikirim ke Telegram.
 * Env: TELEGRAM_BOT_TOKEN (wajib), TELEGRAM_WEBHOOK_SECRET (opsional).
 * ========================================================================= */
import { createHash, randomBytes } from 'node:crypto';
import { gate } from './auth.js';
import { readJson, runStream } from './llm.js';
import { pipeline, redis, hasDb, PREFIX, keys } from './db.js';

const token = () => (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const secret = () => (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim() || createHash('sha256').update('vo-tg:' + token()).digest('hex').slice(0, 48);
const K = {
  chat: (id) => `${PREFIX}:tg:chat:${id}`, // chat id → email akun
  link: (code) => `${PREFIX}:tg:link:${code}`, // kode tautan → email (15 menit)
  seen: (id) => `${PREFIX}:tg:upd:${id}`, // anti duplikat update
  inbox: (email) => `${PREFIX}:u:${email}:tginbox`, // antrean perintah untuk browser
  alive: (email) => `${PREFIX}:u:${email}:tgalive`, // browser sedang membuka kantor
  chats: (email) => `${PREFIX}:u:${email}:tgchats`, // chat yang terhubung
};

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };

async function tg(method, body) {
  const r = await fetch(`${(process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '')}/bot${token()}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw Object.assign(new Error('Telegram: ' + (j.description || 'HTTP ' + r.status)), { status: 502 });
  return j.result;
}

// Markdown sederhana (hasil AI) → HTML Telegram
const escH = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function mdToHtml(md) {
  return String(md).split('\n').map((line) => {
    let l = escH(line);
    const h = /^\s*#{1,6}\s+(.*)$/.exec(l);
    if (h) return `<b>${h[1]}</b>`;
    l = l.replace(/^(\s*)[-*]\s+/, '$1• ').replace(/^&gt;\s?/, '▎ ');
    l = l.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
    return l;
  }).join('\n');
}
/** Kirim teks panjang (dipotong per ±3800 karakter di batas baris). */
export async function sendLong(chatId, text) {
  const parts = [];
  let cur = '';
  for (const line of String(text || '').split('\n')) {
    if ((cur + '\n' + line).length > 3800 && cur) { parts.push(cur); cur = ''; }
    cur = cur ? cur + '\n' + line : line.slice(0, 3800);
  }
  if (cur) parts.push(cur);
  for (const p of parts.slice(0, 8)) {
    try { await tg('sendMessage', { chat_id: chatId, text: mdToHtml(p), parse_mode: 'HTML', disable_web_page_preview: true }); }
    catch { await tg('sendMessage', { chat_id: chatId, text: p, disable_web_page_preview: true }); }
  }
}

/* ------------------------------------------------------------ tujuan perintah */
// "@Finance buat laporan…" / "@Hadi Prime cek…" → divisi / departemen / karyawan; tanpa @ → seluruh kantor.
// Nama lengkap (boleh berspasi) dicocokkan dulu; bila hanya sebagian nama dan cocok ke beberapa
// karyawan, dikembalikan `ambiguous` agar bot menanyakan yang dimaksud.
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function parseTarget(office, text) {
  const all = { type: 'all', id: null, label: 'Seluruh kantor' };
  const raw = text.trim();
  if (!raw.startsWith('@') || !office) return { target: all, title: raw };
  const cands = [
    ...(office.divisions || []).map((d) => ({ name: d.name, t: { type: 'division', id: d.id, label: 'Divisi ' + d.name } })),
    ...(office.departments || []).map((d) => ({ name: d.name, t: { type: 'dept', id: d.id, label: 'Dept. ' + d.name } })),
    ...(office.agents || []).map((a) => ({ name: a.name, t: { type: 'agent', id: a.id, label: `${a.name} (${a.role || 'karyawan'})` } })),
  ].filter((c) => norm(c.name));
  // 1) nama lengkap persis di awal, termasuk yang berspasi: "@Hadi Prime …"
  const rest = raw.slice(1);
  const low = rest.toLowerCase();
  for (const c of [...cands].sort((a, b) => b.name.length - a.name.length)) {
    const n = c.name.toLowerCase();
    if (low.startsWith(n) && (low.length === n.length || /[\s:,]/.test(low[n.length]))) {
      const title = rest.slice(n.length).replace(/^[\s:,]+/, '').trim();
      if (title) return { target: c.t, title };
    }
  }
  // 2) satu kata setelah @, tanpa spasi: "@HadiPrime …", "@Finance …", "@Hadi …"
  const m = /^@(\S+)\s+([\s\S]+)$/.exec(raw);
  if (!m) return { target: all, title: raw };
  const key = norm(m[1]);
  const exact = cands.filter((c) => norm(c.name) === key);
  if (exact.length === 1) return { target: exact[0].t, title: m[2].trim() };
  const part = cands.filter((c) => norm(c.name).startsWith(key) || (c.t.type === 'agent' && norm(c.name.split(' ')[0]) === key));
  if (part.length === 1) return { target: part[0].t, title: m[2].trim() };
  if (part.length > 1 || exact.length > 1) return { ambiguous: (exact.length > 1 ? exact : part).map((c) => c), title: m[2].trim(), key: m[1] };
  return { target: all, title: raw, unknown: m[1] };
}

/* ------------------------------------------------------------ kerjakan di server (kantor tidak dibuka) */
async function runOnServer(office, cmd) {
  const s = office || {};
  const company = (s.company && (s.company.name || s.company)) || 'Kantor AI';
  const divs = (s.divisions || []).map((d) => {
    const deps = (s.departments || []).filter((x) => x.divisionId === d.id).map((x) => x.name).join(', ');
    return `- Divisi ${d.name}${deps ? ` (departemen: ${deps})` : ''}`;
  }).join('\n');
  let who = 'Direktur Utama yang memimpin seluruh kantor', model = s.boss && s.boss.model, persona = '';
  const t = cmd.target;
  if (t.type === 'division' || t.type === 'dept') {
    const divId = t.type === 'division' ? t.id : ((s.departments || []).find((d) => d.id === t.id) || {}).divisionId;
    const dir = (s.agents || []).find((a) => a.isDirector && a.divisionId === divId);
    who = `${dir ? dir.name + ', ' + dir.role : 'pimpinan'} ${t.label}`;
    if (dir) { model = dir.model || model; persona = dir.prompt || ''; }
  } else if (t.type === 'agent') {
    const a = (s.agents || []).find((x) => x.id === t.id);
    if (a) { who = `${a.name}, ${a.role}`; model = a.model || model; persona = a.prompt || ''; }
  }
  const system = [
    `Kamu adalah ${who} di perusahaan "${company}" (kantor virtual berisi karyawan AI).`,
    divs ? `Struktur perusahaan:\n${divs}` : '',
    persona ? `Instruksi peranmu: ${persona}` : '',
    'Boss memberi perintah lewat Telegram. Kerjakan langsung dan tuntas, tulis dalam Bahasa Indonesia yang rapi',
    '(Markdown sederhana: judul, poin, tebal). Jangan mengarang data internal yang tidak kamu punya — sebutkan asumsi bila perlu.',
  ].filter(Boolean).join('\n\n');
  let out = '';
  await runStream({ model: model || '', system, prompt: cmd.title, long: false }, (x) => { out += x; }, AbortSignal.timeout(50000));
  return out.trim();
}

/* ------------------------------------------------------------ webhook (dari Telegram) */
const HELP = (chatId) => [
  '<b>Visual Office — bot perintah Boss</b>',
  '',
  'Kirim perintah biasa → dikerjakan <b>seluruh kantor</b>.',
  'Awali dengan <code>@Nama</code> untuk divisi / departemen / karyawan tertentu, mis.:',
  '<code>@Finance buat ringkasan arus kas minggu ini</code>',
  '',
  'Per karyawan: <code>@HadiPrime rangkum progres minggu ini</code>',
  '',
  '/tim — daftar divisi & karyawan (nama untuk @)',
  '/status — 5 tugas terakhir',
  '/link KODE — hubungkan chat ini ke akun Visual Office (kode dari menu Telegram di aplikasi)',
  '/unlink — putuskan chat ini',
  '',
  `Chat ID kamu: <code>${chatId}</code>`,
].join('\n');

export async function handleTelegramHook(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method Not Allowed' });
  if (!token() || !hasDb()) return json(res, 503, { error: 'Bot belum dikonfigurasi' });
  if ((req.headers['x-telegram-bot-api-secret-token'] || '') !== secret()) return json(res, 401, { error: 'secret salah' });
  let up;
  try { up = await readJson(req, 200_000); } catch { return json(res, 200, { ok: true }); }
  const msg = up.message || up.edited_message;
  if (!msg || typeof msg.text !== 'string' || !msg.chat) return json(res, 200, { ok: true });
  // Telegram mengulang update bila respons lambat → abaikan duplikat
  if ((await redis('SET', K.seen(up.update_id), '1', 'NX', 'EX', 86400)) !== 'OK') return json(res, 200, { ok: true });
  const chatId = msg.chat.id, text = msg.text.trim();
  try {
    const cmd0 = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
    const arg1 = text.split(/\s+/)[1] || '';
    if ((cmd0 === '/start' && !arg1) || cmd0 === '/help') { await tg('sendMessage', { chat_id: chatId, text: HELP(chatId), parse_mode: 'HTML' }); return json(res, 200, { ok: true }); }
    if (cmd0 === '/link' || cmd0 === '/start') { // /start KODE = tautan sekali klik t.me/<bot>?start=KODE
      const code = arg1.toUpperCase();
      const email = code && (await redis('GET', K.link(code)));
      if (!email) { await tg('sendMessage', { chat_id: chatId, text: 'Kode tidak valid / kedaluwarsa. Buat kode baru di Visual Office → tombol Telegram.' }); return json(res, 200, { ok: true }); }
      await pipeline([['SET', K.chat(chatId), email], ['SADD', K.chats(email), String(chatId)], ['DEL', K.link(code)]]);
      await tg('sendMessage', { chat_id: chatId, text: '✅ Chat ini terhubung ke kantor Visual Office kamu. Kirim perintah apa saja — ketik /help untuk contoh.' });
      return json(res, 200, { ok: true });
    }
    const email = await redis('GET', K.chat(chatId));
    if (!email) {
      await tg('sendMessage', { chat_id: chatId, text: `Chat ini belum terhubung ke Visual Office.\nBuka aplikasi → tombol Telegram → "Hubungkan chat Telegram", lalu kirim /link KODE di sini.\n\nChat ID: ${chatId}` });
      return json(res, 200, { ok: true });
    }
    if (cmd0 === '/unlink') {
      await pipeline([['DEL', K.chat(chatId)], ['SREM', K.chats(email), String(chatId)]]);
      await tg('sendMessage', { chat_id: chatId, text: 'Chat ini sudah diputus dari Visual Office.' });
      return json(res, 200, { ok: true });
    }
    const raw = await redis('GET', keys.office(email));
    const office = raw ? JSON.parse(raw) : null;
    if (cmd0 === '/status') {
      const ts = ((office && office.tasks) || []).slice(0, 5);
      const ico = { done: '✅', failed: '⚠️' };
      const lines = ts.map((t) => `${ico[t.status] || '⏳'} ${escH(t.title).slice(0, 120)}`);
      await tg('sendMessage', { chat_id: chatId, text: lines.length ? '<b>Tugas terakhir</b>\n' + lines.join('\n') : 'Belum ada tugas.', parse_mode: 'HTML' });
      return json(res, 200, { ok: true });
    }
    if (cmd0 === '/tim') {
      const o = office || {};
      const lines = [];
      for (const d of o.divisions || []) {
        lines.push(`<b>${escH(d.name)}</b> → <code>@${escH(d.name.replace(/\s+/g, ''))}</code>`);
        for (const a of (o.agents || []).filter((x) => x.divisionId === d.id)) lines.push(`  • ${escH(a.name)} — ${escH(a.role || '')} → <code>@${escH(a.name.replace(/\s+/g, ''))}</code>`);
      }
      if (!lines.length) await tg('sendMessage', { chat_id: chatId, text: 'Belum ada divisi.' });
      for (let i = 0; i < lines.length; i += 60) await tg('sendMessage', { chat_id: chatId, text: (i ? '' : '<b>Tim kantor</b> (ketuk untuk menyalin)\n') + lines.slice(i, i + 60).join('\n'), parse_mode: 'HTML' });
      return json(res, 200, { ok: true });
    }
    if (text.startsWith('/')) { await tg('sendMessage', { chat_id: chatId, text: HELP(chatId), parse_mode: 'HTML' }); return json(res, 200, { ok: true }); }

    const parsed = parseTarget(office, text);
    if (parsed.ambiguous) {
      const list = parsed.ambiguous.slice(0, 10).map((c) => `• <code>@${escH(c.name.replace(/\s+/g, ''))}</code> — ${escH(c.t.label)}`).join('\n');
      await tg('sendMessage', { chat_id: chatId, text: `Ada beberapa yang cocok dengan <b>@${escH(parsed.key)}</b>. Kirim ulang dengan nama lengkap (tanpa spasi), mis.:\n${list}`, parse_mode: 'HTML' });
      return json(res, 200, { ok: true });
    }
    if (parsed.unknown) {
      await tg('sendMessage', { chat_id: chatId, text: `Tidak ada divisi / departemen / karyawan bernama <b>@${escH(parsed.unknown)}</b>. Ketik /tim untuk melihat daftar nama.`, parse_mode: 'HTML' });
      return json(res, 200, { ok: true });
    }
    const { target, title } = parsed;
    const cmd = { id: 'tg_' + randomBytes(5).toString('hex'), t: Date.now(), chatId, title: title.slice(0, 2000), target };
    const alive = await redis('GET', K.alive(email));
    if (alive) {
      // kantor sedang dibuka → dikerjakan seluruh hierarki di browser, laporan dikirim dari sana
      await redis('RPUSH', K.inbox(email), JSON.stringify(cmd));
      await tg('sendMessage', { chat_id: chatId, text: `📥 Diterima → <b>${escH(target.label)}</b>\nKantor mulai bekerja; laporan dikirim ke sini setelah selesai.`, parse_mode: 'HTML' });
      return json(res, 200, { ok: true });
    }
    // kantor tidak dibuka → kerjakan langsung di server
    await tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    let result;
    try { result = await runOnServer(office, cmd); }
    catch (e) { await tg('sendMessage', { chat_id: chatId, text: '⚠️ Gagal mengerjakan: ' + e.message }); return json(res, 200, { ok: true }); }
    const doc = { id: 'doc_' + cmd.id, t: Date.now(), kind: 'report', title: 'Laporan (Telegram): ' + cmd.title.slice(0, 120), author: target.label, authorId: null, deptId: null, taskId: cmd.id, content: result.slice(0, 20000) };
    await pipeline([['HSET', keys.docs(email), doc.id, JSON.stringify(doc)], ['RPUSH', K.inbox(email), JSON.stringify({ ...cmd, done: true, result: result.slice(0, 8000), docId: doc.id })]]);
    await sendLong(chatId, `✅ **${target.label}**\n\n${result}`);
    return json(res, 200, { ok: true });
  } catch (e) {
    console.error('telegram-hook', e);
    return json(res, 200, { ok: true }); // jangan biarkan Telegram mengulang terus
  }
}

/* ------------------------------------------------------------ API untuk aplikasi (wajib login) */
// Satu pintu: webhook Telegram (punya header secret) atau API aplikasi (wajib login)
export async function handleTelegramAll(req, res) {
  if (req.headers['x-telegram-bot-api-secret-token'] != null) return handleTelegramHook(req, res);
  return handleTelegram(req, res);
}

export async function handleTelegram(req, res) {
  // '/api/telegram' publik di middleware (untuk Telegram) → cek sesi login di sini
  const g = await gate('/api/telegram-app', req.headers.cookie);
  if (!g.ok) return json(res, 401, { error: 'Belum login' });
  if (!hasDb() || !g.user) return json(res, 404, { error: 'Fitur Telegram butuh database (Upstash) & login akun.' });
  const email = g.user.id;
  const u = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET') {
      const action = u.searchParams.get('action') || 'status';
      if (action === 'inbox') {
        if (!token()) return json(res, 200, { configured: false, cmds: [] });
        // alive=1 hanya saat tab kantor terlihat (tab tersembunyi tidak menjalankan animasi/alur kerja)
        const cmds = [['LRANGE', K.inbox(email), 0, 9]];
        if (u.searchParams.get('alive') === '1') cmds.unshift(['SET', K.alive(email), '1', 'EX', 25]);
        const items = (await pipeline(cmds)).pop();
        if (items && items.length) await redis('LTRIM', K.inbox(email), items.length, -1);
        return json(res, 200, { configured: true, cmds: (items || []).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean) });
      }
      if (!token()) return json(res, 200, { configured: false });
      const [me, hook, chats] = await Promise.all([tg('getMe').catch(() => null), tg('getWebhookInfo').catch(() => null), redis('SMEMBERS', K.chats(email))]);
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      return json(res, 200, {
        configured: true, bot: me && me.username, chats: chats || [],
        webhook: hook ? { url: hook.url || '', ok: hook.url === `https://${host}/api/telegram`, pending: hook.pending_update_count, lastError: hook.last_error_message || '' } : null,
      });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method Not Allowed' });
    if (!token()) return json(res, 400, { error: 'TELEGRAM_BOT_TOKEN belum diatur di Vercel (Settings → Environment Variables), lalu redeploy.' });
    const body = await readJson(req, 100_000);
    if (body.action === 'setup') {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      if (!host || /^(localhost|127\.)/.test(host)) return json(res, 400, { error: 'Webhook butuh alamat HTTPS publik (buka dari domain Vercel, bukan localhost).' });
      const url = `https://${host}/api/telegram`;
      await tg('setWebhook', { url, secret_token: secret(), allowed_updates: ['message', 'edited_message'], drop_pending_updates: true });
      await tg('setMyCommands', { commands: [{ command: 'help', description: 'Cara memberi perintah' }, { command: 'tim', description: 'Daftar divisi & karyawan' }, { command: 'status', description: '5 tugas terakhir' }, { command: 'link', description: 'Hubungkan ke akun Visual Office' }] }).catch(() => {});
      return json(res, 200, { ok: true, url });
    }
    if (body.action === 'link') {
      const code = randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
      await redis('SET', K.link(code), email, 'EX', 900);
      const me = await tg('getMe').catch(() => null);
      return json(res, 200, { code, bot: me && me.username });
    }
    if (body.action === 'reply' || body.action === 'unlink') {
      const chatId = String(body.chatId || '');
      if (!/^-?\d{1,20}$/.test(chatId) || !(await redis('SISMEMBER', K.chats(email), chatId))) return json(res, 403, { error: 'Chat tidak terhubung ke akun ini' });
      if (body.action === 'unlink') { await pipeline([['DEL', K.chat(chatId)], ['SREM', K.chats(email), chatId]]); return json(res, 200, { ok: true }); }
      await sendLong(chatId, String(body.text || '').slice(0, 30000));
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { error: 'action tidak dikenal' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
}

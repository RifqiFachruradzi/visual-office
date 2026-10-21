/* =========================================================================
 * render.js — ANTREAN RENDER VIDEO untuk worker Remotion di VPS (lihat remotion/README.md).
 * Dilayani lewat /api/office?render=… (satu function dengan /api/office — batas paket Hobby).
 *
 * Aplikasi (wajib login):
 *   GET  ?render=status            → { worker: bool, pexels, tts }  (worker aktif = detak < 45 dtk)
 *   POST ?render=enqueue {sb, format, assets?:[{url,type}], imageUrl?, telegram?, itemId?}  → { id }
 *   GET  ?render=job&id=…          → status / progres / hasil job milik akun ini
 * Worker (header x-render-secret = RENDER_WORKER_SECRET):
 *   POST ?render=claim  {pexels}   → { job | null, upload: 'blob'|'local', auth }   (sekaligus detak)
 *   POST ?render=beat   {pexels}   → detak saja (saat sedang merender)
 *   POST ?render=progress {id, progress, stage}
 *   POST ?render=done {id, file, thumb, duration}  → server kirim ke Telegram / Galeri bila perlu
 *   POST ?render=fail {id, error}
 *   POST ?render=tts {text, voice}  → audio/wav (Gemini TTS memakai GEMINI_API_KEY di Vercel)
 *   POST ?render=llm {system, prompt} → { text }  (AI menulis kode animasi adegan khusus)
 *   GET  ?render=photo&id=<file_id Telegram>  → foto produk dari bot
 * ========================================================================= */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { gate } from './auth.js';
import { readJson, runStream } from './llm.js';
import { pipeline, redis, hasDb, PREFIX, keys } from './db.js';
import { fileMode, blobAuth, readStored } from './files.js';

const K = {
  queue: `${PREFIX}:render:queue`,
  alive: `${PREFIX}:render:alive`,
  job: (id) => `${PREFIX}:render:job:${id}`,
};
const JOB_TTL = 7 * 86400;
const STALE_MS = 6 * 60 * 1000; // worker tidak melapor selama ini → job dianggap gagal
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const workerSecret = () => String(process.env.RENDER_WORKER_SECRET || '').trim();
const sha = (x) => createHash('sha256').update(String(x)).digest();
export const isWorker = (req) => { const s = workerSecret(), h = String((req.headers && req.headers['x-render-secret']) || ''); return !!s && !!h && timingSafeEqual(sha(h), sha(s)); };

/* ------------------------------------------------------------ naskah di server (js/videoboard.js) */
let board = null;
export function videoBoard() {
  if (board) return board;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = [path.join(here, '..', 'js', 'videoboard.js'), path.join(process.cwd(), 'js', 'videoboard.js')].find((f) => fs.existsSync(f));
  if (!file) throw new Error('js/videoboard.js tidak ditemukan di server');
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: 'videoboard.js' });
  board = ctx.window.VO.videoBoard;
  return board;
}
/** Storyboard dari brief (AI server; cadangan tanpa AI). → objek JSON biasa */
export async function serverStoryboard(o, model) {
  const B = videoBoard();
  const { system, prompt } = B.prompt(o, '');
  let out = '';
  try { await runStream({ model: model || '', system, prompt, long: true }, (x) => { out += x; }, AbortSignal.timeout(45000)); }
  catch (e) { out = ''; }
  return JSON.parse(JSON.stringify(out ? B.parse(out, o) : B.fallback(o)));
}

/* ------------------------------------------------------------ antrean */
export async function workerOnline() {
  const raw = await redis('GET', K.alive).catch(() => null);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
/** Masukkan job. o: { email, sb, format, assets [{url,type}], imageUrl, photoId, telegram (true|chatId|null), itemId, server, target } */
export async function enqueue(o) {
  const id = 'rj_' + randomBytes(6).toString('hex');
  const job = {
    id, email: o.email, status: 'queued', progress: 0, stage: 'antre', created: Date.now(), updated: Date.now(),
    sb: o.sb, format: o.format === '16:9' ? '16:9' : '9:16', assets: o.assets || [], imageUrl: o.imageUrl || null, photoId: o.photoId || null,
    telegram: o.telegram == null || o.telegram === false ? null : o.telegram, itemId: o.itemId || null, server: !!o.server, target: o.target || null,
  };
  await pipeline([['SET', K.job(id), JSON.stringify(job), 'EX', JOB_TTL], ['RPUSH', K.queue, id]]);
  return job;
}
async function getJob(id) {
  if (!/^rj_[0-9a-f]{12}$/.test(String(id || ''))) return null;
  const raw = await redis('GET', K.job(id));
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
const saveJob = (job) => redis('SET', K.job(job.id), JSON.stringify({ ...job, updated: Date.now() }), 'EX', JOB_TTL);
const publicJob = (j) => ({ id: j.id, status: j.status, progress: j.progress, stage: j.stage, error: j.error, file: j.file, thumb: j.thumb, duration: j.duration, sb: j.status === 'done' ? j.sb : undefined, created: j.created, updated: j.updated });

/* ------------------------------------------------------------ narasi (Gemini TTS) */
const TTS_VOICES = { female: 'Kore', male: 'Charon' };
const TTS_MODELS = () => [process.env.GEMINI_TTS_MODEL, 'gemini-2.5-flash-preview-tts', 'gemini-2.5-flash-tts', 'gemini-2.5-pro-preview-tts'].filter(Boolean);
function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
export async function tts(text, voice) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) throw Object.assign(new Error('GEMINI_API_KEY belum diisi di Vercel — narasi dilewati'), { status: 501 });
  const base = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const body = {
    contents: [{ parts: [{ text: 'Bacakan naskah video pendek berikut dalam bahasa Indonesia dengan gaya narator konten media sosial: santai, hangat, bersemangat, tempo sedang. Beri jeda kira-kira satu detik di setiap pergantian paragraf.\n\n' + String(text).slice(0, 4000) }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICES[voice] || TTS_VOICES.female } } } },
  };
  let last = null;
  for (const model of TTS_MODELS()) {
    const r = await fetch(`${base}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(55000) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 404) { last = j; continue; } // model tidak tersedia → coba berikutnya
    if (!r.ok) throw Object.assign(new Error('Gemini TTS: ' + ((j.error && j.error.message) || 'HTTP ' + r.status)), { status: 502 });
    const part = (((j.candidates || [])[0] || {}).content || {}).parts || [];
    const d = (part.find((p) => p.inlineData) || {}).inlineData;
    if (!d || !d.data) throw Object.assign(new Error('Gemini TTS tidak mengembalikan audio'), { status: 502 });
    const rate = Number((/rate=(\d+)/.exec(d.mimeType || '') || [])[1]) || 24000;
    const pcm = Buffer.from(d.data, 'base64');
    return /wav/.test(d.mimeType || '') ? pcm : wav(pcm, rate);
  }
  throw Object.assign(new Error('Model Gemini TTS tidak tersedia' + (last && last.error ? ': ' + last.error.message : '')), { status: 502 });
}

/* ------------------------------------------------------------ selesai → Telegram / Galeri */
async function finish(job) {
  const tg = await import('./telegram.js');
  const sb = job.sb || {};
  const caption = `🎬 ${sb.title || 'Video'}\n\n${sb.caption || ''}`;
  if (job.telegram != null) {
    try {
      const chats = job.telegram === true ? (await redis('SMEMBERS', tg.tgKeys.chats(job.email))) || [] : [String(job.telegram)];
      if (chats.length) {
        const { buf, type } = await readStored(job.file.url);
        for (const c of chats) await tg.sendFile(c, buf, job.file.name, type || 'video/mp4', caption);
      }
    } catch (e) { job.tgError = e.message; }
  }
  if (job.server) {
    // dibuat saat kantor tidak dibuka → dokumen tersimpan sekarang, Galeri diisi saat kantor dibuka
    const docId = 'doc_' + job.id;
    const script = (sb.scenes || []).map((x, i) => `${i + 1}. **${x.t}** (${x.sec} dtk) — ${x.title || x.text || x.label || ''}${x.customOk ? ' · ✨ animasi buatan AI' : ''}${x.narration ? `\n   _“${x.narration}”_` : ''}`).join('\n');
    const doc = { id: docId, t: Date.now(), kind: 'work', title: 'Video: ' + (sb.title || 'Video'), author: (job.target && job.target.label) || 'Tim Kreatif', authorId: null, deptId: null, taskId: null, content: `## ${sb.title}\n\n**Caption:** ${sb.caption || ''}\n\n### Naskah per adegan\n${script}`, file: job.file };
    const item = { id: 'vd_' + job.id.slice(3), created: job.created, title: sb.title || 'Video', status: 'draft', format: job.format, pack: sb.pack, duration: job.duration, file: job.file, thumb: job.thumb, caption: sb.caption, storyboard: sb, docId, engine: 'remotion', platforms: job.format === '16:9' ? ['youtube'] : ['tiktok', 'instagram', 'youtube'], schedule: null };
    await pipeline([['HSET', keys.docs(job.email), docId, JSON.stringify(doc)], ['RPUSH', tg.tgKeys.inbox(job.email), JSON.stringify({ id: job.id, t: Date.now(), videoDone: item, doc })]]);
  }
}

/* ------------------------------------------------------------ HTTP */
export async function handleRender(req, res) {
  const u = new URL(req.url, 'http://x');
  const action = u.searchParams.get('render');
  if (!hasDb()) return json(res, 404, { error: 'Antrean render butuh database (Upstash).' });
  try {
    if (isWorker(req)) return await workerAction(req, res, action, u);
    const g = await gate('/api/office', req.headers.cookie);
    if (!g.ok) return json(res, 401, { error: 'Belum login' });
    const email = g.user ? g.user.id : 'local';
    if (action === 'status') {
      const w = workerSecret() ? await workerOnline() : null;
      const online = !!(w && Date.now() - w.t < 45000);
      return json(res, 200, { configured: !!workerSecret(), worker: online, pexels: !!(w && w.pexels), tts: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY), busy: online ? Number(await redis('LLEN', K.queue)) || 0 : 0 });
    }
    if (action === 'enqueue' && req.method === 'POST') {
      if (!workerSecret()) return json(res, 400, { error: 'RENDER_WORKER_SECRET belum diisi' });
      const b = await readJson(req, 300_000);
      if (!b.sb || !Array.isArray(b.sb.scenes) || !b.sb.scenes.length) return json(res, 400, { error: 'Naskah kosong' });
      const okUrl = (u) => typeof u === 'string' && /^(https:\/\/[\w.-]+\.blob\.vercel-storage\.com\/|\/files\/)/.test(u);
      const imageUrl = okUrl(b.imageUrl) ? b.imageUrl : null;
      const assets = (Array.isArray(b.assets) ? b.assets : []).filter((a) => a && okUrl(a.url)).slice(0, 8).map((a) => ({ url: a.url, type: /^video\//.test(a.type) ? 'video' : 'photo' }));
      let telegram = null;
      if (b.telegram === true) telegram = true;
      else if (b.telegram != null && b.telegram !== false) {
        const c = String(b.telegram);
        const tg = await import('./telegram.js');
        if (await redis('SISMEMBER', tg.tgKeys.chats(email), c)) telegram = c;
      }
      const job = await enqueue({ email, sb: b.sb, format: b.format, assets, imageUrl, telegram, itemId: String(b.itemId || '').slice(0, 40) || null });
      return json(res, 200, { id: job.id });
    }
    if (action === 'job') {
      const job = await getJob(u.searchParams.get('id'));
      if (!job || job.email !== email) return json(res, 404, { error: 'Job tidak ditemukan' });
      if ((job.status === 'rendering' || job.status === 'queued') && Date.now() - job.updated > (job.status === 'queued' ? 30 * 60 * 1000 : STALE_MS)) {
        job.error = job.status === 'queued' ? 'Worker render tidak mengambil job (VPS mati?)' : 'Worker render berhenti di tengah jalan';
        job.status = 'failed';
        await saveJob(job);
      }
      return json(res, 200, publicJob(job));
    }
    return json(res, 400, { error: 'aksi render tidak dikenal' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
}

async function workerAction(req, res, action, u) {
  if (action === 'photo') {
    const tg = await import('./telegram.js');
    const { buf, type } = await tg.tgDownload(String(u.searchParams.get('id') || ''));
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    return res.end(buf);
  }
  const b = req.method === 'POST' ? await readJson(req, 200_000) : {};
  if (action === 'beat') { // detak worker saat sedang merender (tanpa mengambil job baru)
    await redis('SET', K.alive, JSON.stringify({ t: Date.now(), pexels: !!b.pexels, version: String(b.version || '').slice(0, 20) }), 'EX', 60);
    return json(res, 200, { ok: true });
  }
  if (action === 'claim') {
    await redis('SET', K.alive, JSON.stringify({ t: Date.now(), pexels: !!b.pexels, version: String(b.version || '').slice(0, 20) }), 'EX', 60);
    const id = await redis('LPOP', K.queue);
    const job = id ? await getJob(id) : null;
    if (job) { job.status = 'rendering'; job.stage = 'mulai'; await saveJob(job); }
    return json(res, 200, { job: job ? { id: job.id, sb: job.sb, format: job.format, assets: job.assets || [], imageUrl: job.imageUrl, photoId: job.photoId } : null, upload: fileMode(), auth: fileMode() === 'blob' ? blobAuth() : undefined });
  }
  if (action === 'llm') { // tingkat 2: AI menulis kode animasi adegan (9router VPS → Gemini, kunci tetap di Vercel)
    let text = '';
    await runStream({ model: '', system: String(b.system || '').slice(0, 20000), prompt: String(b.prompt || '').slice(0, 30000), long: true }, (x) => { text += x; }, AbortSignal.timeout(55000));
    return json(res, 200, { text });
  }
  if (action === 'tts') {
    const audio = await tts(String(b.text || ''), b.voice);
    res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' });
    return res.end(audio);
  }
  const job = await getJob(b.id);
  if (!job) return json(res, 404, { error: 'Job tidak ditemukan' });
  if (action === 'progress') {
    job.progress = Math.max(0, Math.min(1, Number(b.progress) || 0)); job.stage = String(b.stage || 'render').slice(0, 30);
    await saveJob(job);
    await redis('SET', K.alive, JSON.stringify({ t: Date.now(), pexels: !!b.pexels }), 'EX', 60);
    return json(res, 200, { ok: true });
  }
  if (action === 'done') {
    const okUrl = (x) => x && typeof x.url === 'string' && /^(https:\/\/[\w.-]+\.blob\.vercel-storage\.com\/|\/files\/)/.test(x.url);
    if (!okUrl(b.file)) return json(res, 400, { error: 'URL file tidak valid' });
    job.status = 'done'; job.progress = 1; job.stage = '';
    job.file = { url: b.file.url, name: String(b.file.name || 'video.mp4').slice(-90), type: 'video/mp4', size: Number(b.file.size) || 0 };
    job.thumb = okUrl(b.thumb) ? { url: b.thumb.url, name: String(b.thumb.name || 'thumb.jpg').slice(-90), type: 'image/jpeg', size: Number(b.thumb.size) || 0 } : null;
    job.duration = Math.round(Number(b.duration) || 0);
    if (b.sb && Array.isArray(b.sb.scenes)) job.sb = b.sb; // durasi adegan disesuaikan dengan narasi
    await finish(job);
    await saveJob(job);
    return json(res, 200, { ok: true });
  }
  if (action === 'fail') {
    job.status = 'failed'; job.error = String(b.error || 'Render gagal').slice(0, 300); job.stage = '';
    await saveJob(job);
    if (job.telegram != null && job.telegram !== true) {
      const tg = await import('./telegram.js');
      await tg.sendLong(String(job.telegram), '⚠️ Render video gagal: ' + job.error).catch(() => {});
    }
    return json(res, 200, { ok: true });
  }
  return json(res, 400, { error: 'aksi worker tidak dikenal' });
}

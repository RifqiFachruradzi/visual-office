/* =========================================================================
 * Handler HTTP (Node req/res) untuk akun & data kantor — dipakai Vercel
 * Functions (api/*.js) dan server lokal (local/server.js).
 *   POST /api/login     {email|username, password}
 *   GET  /api/register  → info apakah pendaftaran dibuka
 *   POST /api/register  {name, email, password, code?}
 *   GET  /api/logout
 *   GET  /api/me
 *   GET  /api/office    → { office, docs }   (mode database)
 *   POST /api/office    { office?, docOps? }
 * ========================================================================= */
import { authConfig, checkEnvCredentials, createSession, sessionCookie, clearCookie, gate, safeEqual } from './auth.js';
import { readJson } from './llm.js';
import { pipeline, redis, keys } from './db.js';

const isSecure = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
const json = (res, code, obj, headers = {}) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
};
const fail = (res, err) => json(res, err.status || 500, { error: err.status ? err.message : 'Terjadi kesalahan di server.' });
const notConfigured = (res, cfg) =>
  json(res, cfg.required ? 503 : 400, {
    error: cfg.required
      ? 'Login belum dikonfigurasi: hubungkan Upstash Redis di Vercel → Storage (atau set APP_USERNAME & APP_PASSWORD), lalu redeploy.'
      : 'Login tidak aktif di server ini.',
  });

async function startSession(req, res, user) {
  const token = await createSession(user);
  return json(res, 200, { ok: true, user: user.name }, { 'set-cookie': sessionCookie(token, isSecure(req)) });
}

export async function handleLogin(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method Not Allowed' });
  const cfg = authConfig();
  if (!cfg.configured) return notConfigured(res, cfg);
  try {
    const body = await readJson(req, 10_000);
    if (cfg.mode === 'db') {
      const { login } = await import('./accounts.js');
      return await startSession(req, res, await login(body.email || body.username, body.password));
    }
    const user = await checkEnvCredentials(body.username || body.email, body.password);
    if (!user) {
      await new Promise((r) => setTimeout(r, 600)); // perlambat tebak-tebakan password
      return json(res, 401, { error: 'Username atau password salah' });
    }
    return await startSession(req, res, user);
  } catch (err) {
    return fail(res, err);
  }
}

export async function handleRegister(req, res) {
  const cfg = authConfig();
  if (req.method === 'GET') {
    const out = { mode: cfg.mode, canRegister: cfg.canRegister, codeRequired: cfg.canRegister && cfg.codeRequired, configured: cfg.configured };
    // Bantu diagnosis saat belum terkonfigurasi: tampilkan NAMA variabel database yang terbaca (tanpa nilainya)
    if (!cfg.configured) out.dbEnvNames = Object.keys(process.env).filter((k) => /KV|REDIS|UPSTASH|STORAGE/i.test(k)).sort();
    return json(res, 200, out);
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method Not Allowed' });
  if (!cfg.configured) return notConfigured(res, cfg);
  if (!cfg.canRegister) return json(res, 403, { error: 'Pendaftaran akun tidak dibuka di server ini.' });
  try {
    const body = await readJson(req, 10_000);
    if (cfg.codeRequired && !(await safeEqual(String(body.code || '').trim(), String(process.env.REGISTER_CODE).trim()))) {
      return json(res, 403, { error: 'Kode undangan salah.' });
    }
    const { register } = await import('./accounts.js');
    return await startSession(req, res, await register(body.name, body.email, body.password));
  } catch (err) {
    return fail(res, err);
  }
}

export async function handleLogout(req, res) {
  res.writeHead(302, { location: '/login.html', 'set-cookie': clearCookie(isSecure(req)), 'cache-control': 'no-store' });
  res.end();
}

export async function handleMe(req, res) {
  const cfg = authConfig();
  const g = await gate('/api/me', req.headers.cookie);
  if (!g.ok) return json(res, 401, { error: 'Belum login' });
  return json(res, 200, {
    user: g.user ? g.user.name : null,
    id: g.user ? g.user.id : null,
    authRequired: cfg.required,
    mode: cfg.mode,
    cloud: cfg.mode === 'db' && !!g.user, // data kantor disimpan di database
  });
}

/* ------------------------------------------------------------ data kantor per akun */
const DOC_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_OFFICE = 900_000; // byte JSON, di bawah batas request Upstash gratis (1 MB)

function cleanDoc(d) {
  if (!d || !DOC_ID.test(d.id)) return null;
  return {
    id: d.id,
    t: Number(d.t) || Date.now(),
    kind: ['report', 'work', 'upload'].includes(d.kind) ? d.kind : 'work',
    title: String(d.title || '').slice(0, 160),
    author: String(d.author || '-').slice(0, 80),
    authorId: d.authorId ? String(d.authorId).slice(0, 64) : null,
    deptId: d.deptId ? String(d.deptId).slice(0, 64) : null,
    taskId: d.taskId ? String(d.taskId).slice(0, 64) : null,
    content: String(d.content || '').slice(0, 20000),
  };
}

export async function handleOffice(req, res) {
  const cfg = authConfig();
  const g = await gate('/api/office', req.headers.cookie);
  if (!g.ok) return json(res, 401, { error: 'Belum login' });
  if (cfg.mode !== 'db' || !g.user) return json(res, 404, { error: 'Penyimpanan cloud tidak aktif (database belum terhubung).' });
  const email = g.user.id;
  try {
    if (req.method === 'GET') {
      const [office, docs, rev] = await pipeline([['GET', keys.office(email)], ['HVALS', keys.docs(email)], ['GET', keys.office(email) + ':rev']]);
      const list = (docs || []).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean).sort((a, b) => b.t - a.t);
      return json(res, 200, { office: office ? JSON.parse(office) : null, docs: list, rev: Number(rev) || 0 });
    }
    if (req.method !== 'POST' && req.method !== 'PUT') return json(res, 405, { error: 'Method Not Allowed' });
    const body = await readJson(req, 4_000_000);
    const cmds = [];
    if (body.office) {
      // kantor diubah server (mis. divisi baru dari Telegram) setelah tab ini memuat → jangan ditimpa
      if (body.rev != null) {
        const cur = Number(await redis('GET', keys.office(email) + ':rev')) || 0;
        if (Number(body.rev) < cur) return json(res, 409, { error: 'Kantor sudah diubah dari tempat lain (mis. Telegram). Muat ulang halaman.', rev: cur });
      }
      const raw = JSON.stringify({ ...body.office, docs: [] });
      if (raw.length > MAX_OFFICE) return json(res, 413, { error: 'Data kantor terlalu besar untuk disimpan.' });
      cmds.push(['SET', keys.office(email), raw]);
    }
    for (const op of (body.docOps || []).slice(0, 100)) {
      if (op.op === 'clear') cmds.push(['DEL', keys.docs(email)]);
      else if (op.op === 'del' && DOC_ID.test(op.id || '')) cmds.push(['HDEL', keys.docs(email), op.id]);
      else if (op.op === 'put') {
        const d = cleanDoc(op.doc);
        if (d) cmds.push(['HSET', keys.docs(email), d.id, JSON.stringify(d)]);
      }
    }
    if (cmds.length) await pipeline(cmds);
    return json(res, 200, { ok: true, saved: cmds.length });
  } catch (err) {
    return fail(res, err);
  }
}

/* ------------------------------------------------------------ data Gudang-Document (hanya baca) */
export async function handleGudang(req, res) {
  const g = await gate('/api/gudang', req.headers.cookie);
  if (!g.ok) return json(res, 401, { error: 'Belum login' });
  if (req.method !== 'GET') return json(res, 405, { error: 'Method Not Allowed' });
  try {
    const { readGudang } = await import('./gudang.js');
    return json(res, 200, await readGudang());
  } catch (err) {
    return fail(res, err);
  }
}

/* ------------------------------------------------------------ data MiniMarket (hanya baca) */
export async function handleMinimarket(req, res) {
  const g = await gate('/api/minimarket', req.headers.cookie);
  if (!g.ok) return json(res, 401, { error: 'Belum login' });
  if (req.method !== 'GET') return json(res, 405, { error: 'Method Not Allowed' });
  try {
    const { readMinimarket } = await import('./minimarket.js');
    return json(res, 200, await readMinimarket());
  } catch (err) {
    return fail(res, err.status ? err : Object.assign(new Error('Gagal membaca database MiniMarket: ' + err.message), { status: 502 }));
  }
}

// Data publik gratis (kurs, hari libur, cuaca) dari daftar public-apis — hanya baca
export async function handlePublic(req, res) {
  const g = await gate('/api/public', req.headers.cookie);
  if (!g.ok) return json(res, 401, { error: 'Belum login' });
  if (req.method !== 'GET') return json(res, 405, { error: 'Method Not Allowed' });
  try {
    const u = new URL(req.url, 'http://x');
    const { readPublic } = await import('./publicapi.js');
    return json(res, 200, await readPublic(u.searchParams.get('kind') || 'publik', { city: u.searchParams.get('city') || '' }));
  } catch (err) {
    return fail(res, err.status ? err : Object.assign(new Error('Gagal membaca API publik: ' + err.message), { status: 502 }));
  }
}

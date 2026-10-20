/* =========================================================================
 * files.js — penyimpanan file hasil kerja (video, PDF, gambar, apa pun) agar bisa
 * dibuka di web app dan dikirim ke Telegram. Dilayani lewat /api/office?files=…
 * (satu function dengan /api/office karena paket Hobby Vercel membatasi jumlah function).
 *
 *   GET  /api/office?files=status            → { mode: 'blob' | 'local' | 'none', max }
 *   POST /api/office?files=token             → handshake upload langsung browser → Vercel Blob
 *   PUT  /api/office?files=put&name=…        → (server lokal saja) simpan ke folder sementara
 *   POST /api/office?files=del  {url}        → hapus file
 *   GET  /files/<id>                         → (server lokal saja) unduh file
 *
 * Mode:
 *   blob  — Vercel Blob (Vercel → Storage → Blob → Connect). Dua cara autentikasi:
 *           · OIDC (cara baru Vercel): env BLOB_STORE_ID (+ token OIDC per request) → upload presigned
 *           · token lama: env BLOB_READ_WRITE_TOKEN → upload dengan client token
 *   local — server lokal (npm start) tanpa Blob: file disimpan di folder sementara OS
 *   none  — di Vercel tanpa Blob: file hanya bisa diunduh di browser yang membuatnya
 * ========================================================================= */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { gate } from './auth.js';
import { readJson } from './llm.js';
import { isWorker } from './render.js';

export const MAX_FILE = 50 * 1024 * 1024; // batas kirim file oleh bot Telegram
const LOCAL_DIR = path.join(os.tmpdir(), 'visual-office-files');
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };

export const fileMode = () => (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID ? 'blob' : process.env.VERCEL ? 'none' : 'local');
// OIDC diutamakan (rekomendasi Vercel; token lama boleh dicabut), token lama sebagai cadangan
export const blobAuth = () => (process.env.BLOB_STORE_ID ? 'oidc' : 'token');
// token OIDC Vercel: dikirim di header request function (atau env saat build/dev)
const oidcOpts = (req) => { const t = (req && req.headers && req.headers['x-vercel-oidc-token']) || process.env.VERCEL_OIDC_TOKEN; return t ? { oidcToken: String(t) } : {}; };
const safeName = (n) => String(n || 'file').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '-').slice(-90) || 'file';

/** Baca isi file dari URL hasil upload (Blob publik atau /files/ lokal). → { buf, type } */
export async function readStored(url) {
  const m = /^\/files\/([\w.-]+)$/.exec(String(url));
  if (m) {
    const p = path.join(LOCAL_DIR, m[1]);
    if (!p.startsWith(LOCAL_DIR) || !fs.existsSync(p)) throw Object.assign(new Error('File tidak ditemukan'), { status: 404 });
    return { buf: fs.readFileSync(p), type: guessType(p) };
  }
  if (!/^https:\/\/[\w.-]+\.blob\.vercel-storage\.com\//.test(String(url))) throw Object.assign(new Error('Alamat file tidak dikenal'), { status: 400 });
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw Object.assign(new Error('Gagal mengambil file (HTTP ' + r.status + ')'), { status: 502 });
  const len = Number(r.headers.get('content-length') || 0);
  if (len > MAX_FILE) throw Object.assign(new Error('File lebih dari 50 MB'), { status: 413 });
  return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || 'application/octet-stream' };
}
const TYPES = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.zip': 'application/zip', '.json': 'application/json' };
export const guessType = (p) => TYPES[path.extname(String(p)).toLowerCase()] || 'application/octet-stream';

// Server lokal: GET /files/<id>
export function serveLocalFile(req, res, id) {
  const p = path.join(LOCAL_DIR, path.basename(id));
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': guessType(p), 'cache-control': 'private, max-age=86400' });
  fs.createReadStream(p).pipe(res);
}

export async function handleFiles(req, res) {
  const u = new URL(req.url, 'http://x');
  const action = u.searchParams.get('files');
  const mode = fileMode();
  if (action === 'token') {
    // handshake Vercel Blob: browser meminta token upload; di sini wajib login
    if (mode !== 'blob') return json(res, 400, { error: 'Penyimpanan Blob belum diaktifkan' });
    const g = isWorker(req) ? { ok: true, user: { id: 'render-worker' } } : await gate('/api/office', req.headers.cookie); // worker render boleh mengunggah hasil
    if (!g.ok) return json(res, 401, { error: 'Belum login' });
    try {
      const { handleUpload, handleUploadPresigned } = await import('@vercel/blob/client');
      const body = await readJson(req, 100_000);
      if (blobAuth() === 'oidc') { // cara baru: URL upload presigned dari token bertanda tangan (OIDC)
        const { issueSignedToken } = await import('@vercel/blob');
        const out = await handleUploadPresigned({
          body, request: req,
          getSignedToken: async (pathname) => {
            if (!/^vo\//.test(pathname)) throw new Error('Path tidak diizinkan');
            const token = await issueSignedToken({ ...oidcOpts(req), pathname, operations: ['put'], maximumSizeInBytes: MAX_FILE, validUntil: Date.now() + 15 * 60 * 1000 });
            return { token, urlOptions: { addRandomSuffix: true, maximumSizeInBytes: MAX_FILE } };
          },
        });
        return json(res, 200, out);
      }
      const out = await handleUpload({
        body, request: req,
        onBeforeGenerateToken: async (pathname) => {
          if (!/^vo\//.test(pathname)) throw new Error('Path tidak diizinkan');
          return { maximumSizeInBytes: MAX_FILE, addRandomSuffix: true, tokenPayload: JSON.stringify({ user: g.user ? g.user.id : '' }) };
        },
      });
      return json(res, 200, out);
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  const g = isWorker(req) && action === 'put' ? { ok: true } : await gate('/api/office', req.headers.cookie);
  if (!g.ok) return json(res, 401, { error: 'Belum login' });
  if (action === 'status') return json(res, 200, { mode, auth: mode === 'blob' ? blobAuth() : undefined, max: MAX_FILE });
  if (action === 'put') {
    if (mode !== 'local') return json(res, 400, { error: 'Upload langsung hanya untuk server lokal' });
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
    const id = randomBytes(6).toString('hex') + '-' + safeName(u.searchParams.get('name'));
    const p = path.join(LOCAL_DIR, id);
    let size = 0;
    const out = fs.createWriteStream(p);
    try {
      for await (const c of req) { size += c.length; if (size > MAX_FILE) throw Object.assign(new Error('File lebih dari 50 MB'), { status: 413 }); out.write(c); }
    } catch (e) { out.destroy(); fs.rmSync(p, { force: true }); return json(res, e.status || 400, { error: e.message }); }
    await new Promise((r) => out.end(r));
    return json(res, 200, { url: '/files/' + id, size });
  }
  if (action === 'del' && req.method === 'POST') {
    const { url } = await readJson(req, 10_000);
    try {
      if (/^\/files\//.test(url || '')) fs.rmSync(path.join(LOCAL_DIR, path.basename(url)), { force: true });
      else if (mode === 'blob' && /^https:\/\/[\w.-]+\.blob\.vercel-storage\.com\//.test(url || '')) { const { del } = await import('@vercel/blob'); await del(url, blobAuth() === 'oidc' ? oidcOpts(req) : undefined); }
    } catch (e) { /* file sudah tidak ada */ }
    return json(res, 200, { ok: true });
  }
  return json(res, 400, { error: 'aksi file tidak dikenal' });
}

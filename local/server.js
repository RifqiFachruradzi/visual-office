#!/usr/bin/env node
/* =========================================================================
 * local/server.js — server lokal opsional untuk Visual Office (tanpa dependency
 * wajib). Fungsi:
 *   1. Menyajikan file statis (index.html, js/, css/).
 *   2. POST /api/run    → menjalankan satu agent memakai Gemini (gratis,
 *                          GEMINI_API_KEY) atau Claude (ANTHROPIC_API_KEY).
 *   3. POST /api/event  → menerima event dari Claude Code hooks,
 *      GET  /api/events → menyiarkannya ke browser (Server-Sent Events).
 *
 * Catatan: sengaja TIDAK diletakkan di root sebagai server.js, karena Vercel
 * akan mendeteksinya sebagai entrypoint server dan tidak menyajikan file statis.
 *
 * Jalankan:  npm start        (default port 4317, ubah dengan PORT=xxxx)
 * ========================================================================= */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { status, handleRun } from '../lib/llm.js';
import { gate, authConfig } from '../lib/auth.js';
import { handleTelegram, handleTelegramHook } from '../lib/telegram.js';
import { handleLogin, handleLogout, handleMe, handleRegister, handleOffice, handleGudang, handleMinimarket, handlePublic } from '../lib/session-http.js';

// folder root proyek (file ini ada di local/)
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// baca .env bila ada (Node 20.12+)
try { process.loadEnvFile(path.join(here, '.env')); } catch { /* tidak ada .env */ }
const PORT = Number(process.env.PORT || 4317);
const HOST = process.env.HOST || '127.0.0.1';

/* ------------------------------------------------------------ util */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8', '.glb': 'model/gltf-binary' };

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body terlalu besar')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const sse = (res) => res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
const send = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

/* ------------------------------------------------------------ live events */
const listeners = new Set();
function broadcast(ev) { for (const res of listeners) send(res, ev); }
setInterval(() => { for (const res of listeners) res.write(': ping\n\n'); }, 25_000).unref();

/* ------------------------------------------------------------ server */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    // hook Claude Code mengirim event tanpa cookie (server hanya mendengar 127.0.0.1)
    if (url.pathname === '/api/event' && req.method === 'POST') {
      const ev = JSON.parse((await readBody(req)) || '{}');
      broadcast(ev);
      return json(res, 200, { ok: true, delivered: listeners.size });
    }
    // login: sama seperti middleware Vercel
    const g = await gate(url.pathname === '/' ? '/index.html' : url.pathname, req.headers.cookie);
    if (!g.ok) {
      if (g.api) return json(res, 401, { error: 'Belum login' });
      res.writeHead(302, { location: '/login.html' });
      return res.end();
    }
    if (url.pathname === '/api/login') return handleLogin(req, res);
    if (url.pathname === '/api/logout') return handleLogout(req, res);
    if (url.pathname === '/api/me') return handleMe(req, res);
    if (url.pathname === '/api/register') return handleRegister(req, res);
    if (url.pathname === '/api/office') return handleOffice(req, res);
    if (url.pathname === '/api/gudang') return handleGudang(req, res);
    if (url.pathname === '/api/minimarket') return handleMinimarket(req, res);
    if (url.pathname === '/api/public') return handlePublic(req, res);
    if (url.pathname === '/api/telegram') return handleTelegram(req, res);
    if (url.pathname === '/api/telegram-hook') return handleTelegramHook(req, res);
    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, ...status(), live: true, host: 'local', listeners: listeners.size });
    }
    if (url.pathname === '/api/run' && req.method === 'POST') return handleRun(req, res);
    if (url.pathname === '/api/events') {
      sse(res);
      res.write(': connected\n\n');
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
      return;
    }

    // file statis
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.normalize(path.join(here, rel));
    if (!file.startsWith(here + path.sep) || rel.includes('node_modules') || rel.includes('/.git') || rel.startsWith('/local/') || rel.startsWith('/lib/') || rel.startsWith('/.env')) return json(res, 403, { error: 'forbidden' });
    fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\nVisual Office berjalan di http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  const st = status();
  const auth = authConfig();
  console.log(`   Mode AI   : ${st.ai ? '[aktif] ' : '[mati]  '}${st.reason}`);
  const loginTxt = { db: '[aktif] akun di Upstash Redis (daftar/masuk dengan email)', env: '[aktif] ' + auth.users.size + ' akun dari APP_USERNAME/APP_USERS', none: '[mati]  isi KV_REST_API_URL/TOKEN (atau APP_USERNAME & APP_PASSWORD) di .env' }[auth.mode];
  console.log(`   Login     : ${loginTxt}`);
  console.log(`   Live hook : POST http://localhost:${PORT}/api/event  (lihat README.md)\n`);
});

/* =========================================================================
 * lib/auth.js — sesi login berbasis cookie bertanda tangan (HMAC).
 * Hanya memakai Web Crypto, sehingga bisa jalan di:
 *   - Vercel Routing Middleware (Edge)   → middleware.js
 *   - Vercel Functions (Node)            → api/*.js
 *   - server lokal                        → local/server.js
 *
 * Mode akun (otomatis):
 *   'db'   Upstash Redis terhubung (KV_REST_API_URL/TOKEN) → daftar & masuk
 *          dengan email + kata sandi di halaman login (seperti SimpananMu).
 *   'env'  Tanpa database: akun tetap dari APP_USERNAME + APP_PASSWORD
 *          atau APP_USERS="nama:pass,nama2:pass2" (tanpa fitur daftar).
 *   'none' Tidak ada keduanya: lokal = terbuka, Vercel = terkunci.
 * APP_SECRET (opsional) = kunci tanda tangan cookie; default diturunkan dari
 * token database / password, jadi tidak wajib diisi.
 * ========================================================================= */
import { hasDb, dbToken } from './db.js';

export const COOKIE = 'vo_session';
export const MAX_AGE = 60 * 60 * 24 * 30; // 30 hari
const enc = new TextEncoder();
const env = () => (globalThis.process && globalThis.process.env) || {};

function envUsers() {
  const e = env();
  const users = new Map();
  if (e.APP_USERS) {
    for (const pair of String(e.APP_USERS).split(',')) {
      const i = pair.indexOf(':');
      if (i > 0) users.set(pair.slice(0, i).trim(), pair.slice(i + 1));
    }
  }
  if (e.APP_USERNAME && e.APP_PASSWORD) users.set(String(e.APP_USERNAME).trim(), String(e.APP_PASSWORD));
  return users;
}

export function authConfig() {
  const e = env();
  const users = envUsers();
  const mode = hasDb() ? 'db' : users.size ? 'env' : 'none';
  return {
    mode,
    users,
    configured: mode !== 'none',
    required: mode !== 'none' || !!e.VERCEL,
    canRegister: mode === 'db' && String(e.ALLOW_REGISTER ?? 'true') !== 'false',
    codeRequired: !!e.REGISTER_CODE,
    secret: e.APP_SECRET || (mode === 'db' ? 'vo-db:' + dbToken() : 'vo1:' + [...users].map(([u, p]) => u + '=' + p).join('|')),
  };
}

const b64url = (buf) => {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (str) => {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));
};

async function sign(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

// Perbandingan konstan: bandingkan HMAC kedua nilai
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sign('cmp', String(a)), sign('cmp', String(b))]);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.min(x.length, y.length); i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** Mode 'env': cek akun dari environment variable. → { id, name } atau null */
export async function checkEnvCredentials(username, password) {
  const u = String(username || '').trim();
  let found = null;
  for (const [name, pass] of envUsers()) {
    // jalankan semua perbandingan agar waktu respons tidak membocorkan nama
    const match = (await safeEqual(name.toLowerCase(), u.toLowerCase())) & (await safeEqual(pass, String(password || '')));
    if (match) found = { id: name, name };
  }
  return found;
}

/** user = { id, name } — id adalah email (mode db) atau username (mode env) */
export async function createSession(user) {
  const cfg = authConfig();
  const payload = b64url(enc.encode(JSON.stringify({ u: user.id, n: user.name, m: cfg.mode, exp: Date.now() + MAX_AGE * 1000 })));
  return payload + '.' + (await sign(cfg.secret, payload));
}

export async function verifySession(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const cfg = authConfig();
  if (!cfg.configured) return null;
  const [payload, sig] = token.split('.');
  if (!(await safeEqual(sig, await sign(cfg.secret, payload)))) return null;
  try {
    const d = JSON.parse(fromB64url(payload));
    if (!d.u || d.exp < Date.now() || d.m !== cfg.mode) return null;
    if (cfg.mode === 'env' && !cfg.users.has(d.u)) return null;
    return { id: d.u, name: d.n || d.u };
  } catch {
    return null;
  }
}

export function readCookie(header, name = COOKIE) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(token, secure) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure ? '; Secure' : ''}`;
}
export function clearCookie(secure) {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

// Halaman / endpoint yang boleh dibuka tanpa login
const PUBLIC = new Set(['/login.html', '/favicon.svg', '/api/login', '/api/logout', '/api/register', '/api/telegram']); // /api/telegram: webhook dicek secret token, API aplikasi cek sesi sendiri
export const isPublicPath = (p) => PUBLIC.has(p);

/**
 * Keputusan akses untuk satu request.
 * → { ok: true, user } atau { ok: false, api: boolean }
 */
export async function gate(pathname, cookieHeader) {
  const cfg = authConfig();
  if (isPublicPath(pathname)) return { ok: true, user: null, public: true };
  if (!cfg.required) return { ok: true, user: null };
  const user = await verifySession(readCookie(cookieHeader));
  if (user) return { ok: true, user };
  return { ok: false, api: pathname.startsWith('/api/') };
}

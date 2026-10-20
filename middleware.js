// Vercel Routing Middleware: semua halaman & API wajib login, kecuali halaman login.
import { gate } from './lib/auth.js';

export const config = { matcher: '/:path*' };

// Setara `next()` dari @vercel/functions: lanjutkan request ke tujuan aslinya.
const next = () => new Response(null, { headers: { 'x-middleware-next': '1' } });

export default async function middleware(request) {
  const url = new URL(request.url);
  // worker render di VPS (tanpa cookie): rahasianya diperiksa di dalam function /api/office
  if (url.pathname === '/api/office' && request.headers.get('x-render-secret')) return next();
  const g = await gate(url.pathname, request.headers.get('cookie'));
  if (g.ok) return next();
  if (g.api) {
    return new Response(JSON.stringify({ error: 'Belum login' }), { status: 401, headers: { 'content-type': 'application/json' } });
  }
  const login = new URL('/login.html', url);
  if (url.pathname !== '/' && url.pathname !== '/index.html') login.searchParams.set('next', url.pathname);
  return Response.redirect(login.toString(), 302);
}

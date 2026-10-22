/* =========================================================================
 * worker.mjs — WORKER RENDER VIDEO (Remotion) untuk Visual Office. Dijalankan di VPS (systemd).
 *
 *   1. Ambil job dari antrean Visual Office  (POST {VO_URL}/api/office?render=claim)
 *   2. Siapkan bahan: foto produk, foto/video stok Pexels (kata kunci "media" tiap adegan),
 *      narasi suara (Gemini TTS lewat Visual Office) + waktu tiap kata untuk subtitle, musik latar
 *   3. Render MP4 H.264 dengan Remotion (src/Video.jsx) + thumbnail
 *   4. Unggah ke penyimpanan Visual Office (Vercel Blob / server lokal) → lapor selesai
 *      (Visual Office lalu mengirim ke Telegram & memasukkan ke Galeri)
 *
 * Env (lihat /etc/visual-office-worker.env):
 *   VO_URL                 alamat Visual Office, mis. https://visual-office.vercel.app
 *   RENDER_WORKER_SECRET   rahasia yang sama dengan env di Vercel
 *   PIXABAY_API_KEY        (opsional) foto/video stok gratis — https://pixabay.com/api/docs/
 *   PEXELS_API_KEY         (opsional) alternatif stok — https://www.pexels.com/api/
 *   BROWSER_EXECUTABLE     (opsional) Chrome/Chromium headless; default diunduh Remotion
 *   RENDER_CONCURRENCY     (opsional) tab paralel saat render, default 1 (VPS 2 core / 2 GB)
 *
 * Tes tanpa server:  node worker.mjs --test [bold|minimal|neon|editorial|playful|all] [--still] [--sb naskah.json] [--image foto.png] [--assets a.jpg,b.mp4] [--music] [16:9]
 * ========================================================================= */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { ensureBrowser, renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { makeMusic } from './scripts/make-music.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '1.0.0';
const FPS = 30;
const env = (k, d = '') => String(process.env[k] || d).trim();
const VO_URL = env('VO_URL').replace(/\/+$/, '');
const SECRET = env('RENDER_WORKER_SECRET');
const PEXELS = env('PEXELS_API_KEY');
const PIXABAY = env('PIXABAY_API_KEY');
const STOCK = !!(PIXABAY || PEXELS); // ada sumber foto/video stok
const BROWSER = env('BROWSER_EXECUTABLE') || undefined;
const CONCURRENCY = Math.max(1, Number(env('RENDER_CONCURRENCY', '1')) || 1);
const PORT = Number(env('ASSET_PORT', '3123'));
const WORK = path.join(os.tmpdir(), 'vo-render');
const MUSIC_DIR = path.join(HERE, 'public', 'music');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ server bahan lokal (dibaca Chromium saat render) */
function startAssetServer() {
  const TYPES = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.wav': 'audio/wav' };
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const base = u.startsWith('/music/') ? MUSIC_DIR : WORK;
    const p = path.normalize(path.join(base, u.replace(/^\/(music|job)\//, '')));
    if (!p.startsWith(base) || !fs.existsSync(p) || !fs.statSync(p).isFile()) { res.writeHead(404); return res.end(); }
    const size = fs.statSync(p).size, type = TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream';
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    const head = { 'content-type': type, 'accept-ranges': 'bytes', 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
    if (m) {
      const s = m[1] ? Number(m[1]) : 0, e = m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
      res.writeHead(206, { ...head, 'content-range': `bytes ${s}-${e}/${size}`, 'content-length': e - s + 1 });
      return fs.createReadStream(p, { start: s, end: e }).pipe(res);
    }
    res.writeHead(200, { ...head, 'content-length': size });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => srv.listen(PORT, '127.0.0.1', () => r(srv)));
}
const assetUrl = (jobId, name) => `http://127.0.0.1:${PORT}/job/${jobId}/${name}`;

/* ------------------------------------------------------------ API Visual Office */
async function api(action, body, raw) {
  const r = await fetch(`${VO_URL}/api/office?render=${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-render-secret': SECRET }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(70000),
  });
  if (raw) { if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'HTTP ' + r.status); } return Buffer.from(await r.arrayBuffer()); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}
async function download(url, file, headers = {}, max = 40e6) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('Unduh gagal (HTTP ' + r.status + ')');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > max) throw new Error('File terlalu besar');
  fs.writeFileSync(file, buf);
  return file;
}

/* ------------------------------------------------------------ media stok (Pexels) */
async function pexels(kind, query, orientation, pick) {
  const u = kind === 'video'
    ? `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=${orientation}&per_page=6&size=medium`
    : `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&orientation=${orientation}&per_page=6`;
  const r = await fetch(u, { headers: { Authorization: PEXELS }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Pexels HTTP ' + r.status);
  const j = await r.json();
  const list = (kind === 'video' ? j.videos : j.photos) || [];
  if (!list.length) return null;
  const it = list[pick % Math.min(3, list.length)];
  if (kind === 'photo') return { url: (orientation === 'portrait' ? it.src.portrait : it.src.landscape) || it.src.large, credit: 'Foto: ' + it.photographer + ' / Pexels' };
  const files = (it.video_files || []).filter((f) => f.file_type === 'video/mp4' && f.width && f.height && Math.min(f.width, f.height) >= 540 && Math.min(f.width, f.height) <= 1080)
    .sort((a, b) => Math.abs(Math.min(a.width, a.height) - 720) - Math.abs(Math.min(b.width, b.height) - 720));
  return files[0] ? { url: files[0].link, credit: 'Video: ' + ((it.user && it.user.name) || 'Pexels') + ' / Pexels' } : null;
}
// Pixabay: https://pixabay.com/api/docs/
async function pixabay(kind, query, orientation, pick) {
  const base = kind === 'video' ? 'https://pixabay.com/api/videos/' : 'https://pixabay.com/api/';
  const u = `${base}?key=${encodeURIComponent(PIXABAY)}&q=${encodeURIComponent(String(query).slice(0, 100))}&per_page=10&safesearch=true${kind === 'photo' ? `&image_type=photo&orientation=${orientation === 'portrait' ? 'vertical' : 'horizontal'}` : ''}`;
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Pixabay HTTP ' + r.status);
  let list = (await r.json()).hits || [];
  if (!list.length) return null;
  if (kind === 'photo') { const it = list[pick % Math.min(3, list.length)]; return { url: it.largeImageURL || it.webformatURL, credit: 'Foto: ' + it.user + ' / Pixabay' }; }
  // video: utamakan yang orientasinya cocok, resolusi ±720p
  const pickFile = (v) => ['medium', 'small', 'large'].map((q) => v.videos && v.videos[q]).find((f) => f && f.url && Math.min(f.width, f.height) >= 540);
  const fit = list.filter((v) => { const f = pickFile(v); return f && (orientation === 'portrait' ? f.height >= f.width : f.width >= f.height); });
  if (fit.length) list = fit;
  const it = list[pick % Math.min(3, list.length)], f = pickFile(it);
  return f ? { url: f.url, credit: 'Video: ' + it.user + ' / Pixabay' } : null;
}
const stock = (kind, q, o, i) => (PIXABAY ? pixabay(kind, q, o, i) : pexels(kind, q, o, i));
async function prepareMedia(job, dir, sb) {
  if (!STOCK) return;
  const orientation = job.format === '16:9' ? 'landscape' : 'portrait';
  let n = 0;
  for (const [i, sc] of sb.scenes.entries()) {
    if (sc.own) continue; // sudah memakai aset dari Boss
    const want = sc.t === 'media' || (sc.t === 'title' && i === 0) || (sc.t === 'image' && !job.imageLocal);
    if (!want || !sc.media || n >= 5) continue;
    try {
      let m = sc.t === 'media' ? await stock('video', sc.media, orientation, i).catch(() => null) : null;
      let type = 'video';
      if (!m) { m = await stock('photo', sc.media, orientation, i); type = 'photo'; }
      if (!m) continue;
      const name = `m${i}.${type === 'video' ? 'mp4' : 'jpg'}`;
      await download(m.url, path.join(dir, name));
      sc.mediaSrc = assetUrl(job.id, name); sc.mediaType = type; sc.credit = m.credit; n++;
    } catch (e) { log('  media gagal untuk', JSON.stringify(sc.media), '-', e.message); }
  }
}

/* ------------------------------------------------------------ narasi: TTS → potong per adegan di jeda hening */
function readWav(buf) {
  let off = 12, rate = 24000, ch = 1, bits = 16, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), len = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') { ch = buf.readUInt16LE(off + 10); rate = buf.readUInt32LE(off + 12); bits = buf.readUInt16LE(off + 22); }
    if (id === 'data') { data = buf.subarray(off + 8, off + 8 + len); break; }
    off += 8 + len + (len % 2);
  }
  if (!data || bits !== 16) throw new Error('Format audio narasi tidak dikenal');
  const n = Math.floor(data.length / 2 / ch), s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = data.readInt16LE(i * 2 * ch) / 32768;
  return { rate, samples: s, duration: n / rate };
}
/** → { cuts:[detik], voiced:[[awal, akhir]] per segmen } */
function segment(wav, weights) {
  const win = Math.round(wav.rate * 0.01), rms = [];
  for (let i = 0; i + win <= wav.samples.length; i += win) { let a = 0; for (let j = i; j < i + win; j++) a += wav.samples[j] * wav.samples[j]; rms.push(Math.sqrt(a / win)); }
  const sorted = [...rms].sort((a, b) => a - b), p95 = sorted[Math.floor(sorted.length * 0.95)] || 0.1;
  const thr = Math.max(0.006, p95 * 0.07), loud = rms.map((v) => v > thr);
  const first = loud.indexOf(true), last = loud.lastIndexOf(true);
  const start = Math.max(0, first) * 0.01, end = (last < 0 ? rms.length : last + 1) * 0.01;
  const sil = []; // jeda hening ≥ 0,15 dtk di tengah ucapan
  for (let i = first, s0 = -1; i <= last; i++) {
    if (!loud[i] && s0 < 0) s0 = i;
    if (loud[i] && s0 >= 0) { if (i - s0 >= 15) sil.push({ mid: ((s0 + i) / 2) * 0.01, len: (i - s0) * 0.01, a: s0 * 0.01, b: i * 0.01 }); s0 = -1; }
  }
  const total = weights.reduce((a, b) => a + b, 0), cuts = [];
  let acc = 0, prev = start;
  for (let j = 0; j < weights.length - 1; j++) {
    acc += weights[j];
    const exp = start + ((end - start) * acc) / total;
    let best = null;
    for (const s of sil) { if (s.mid <= prev + 0.3) continue; const score = Math.abs(s.mid - exp) - s.len * 1.5; if (Math.abs(s.mid - exp) < 2.5 && (!best || score < best.score)) best = { ...s, score }; }
    const c = best ? best.mid : Math.max(prev + 0.3, exp);
    cuts.push(c); prev = c;
  }
  const bounds = [Math.max(0, start - 0.05), ...cuts, Math.min(wav.duration, end + 0.08)];
  // bagian bersuara tiap segmen (untuk waktu subtitle)
  const voiced = bounds.slice(0, -1).map((a, j) => {
    const b = bounds[j + 1];
    let s = Math.ceil(a / 0.01), e = Math.floor(b / 0.01);
    while (s < e && !loud[s]) s++;
    while (e > s && !loud[e - 1]) e--;
    return [s * 0.01, Math.max(s + 1, e) * 0.01];
  });
  return { bounds, voiced };
}
const MIN_SEC = { compare: 3.6, versus: 3.6, bullets: 3.2, steps: 3.2, stat: 2.6 };
async function prepareVoice(job, dir, sb) {
  if (sb.voice === 'none') return { voice: null, words: [] };
  const idx = sb.scenes.map((x, i) => (x.narration ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return { voice: null, words: [] };
  let buf;
  try { buf = await api('tts', { text: idx.map((i) => sb.scenes[i].narration).join('\n\n'), voice: sb.voice }, true); }
  catch (e) { log('  narasi dilewati:', e.message); return { voice: null, words: [] }; }
  fs.writeFileSync(path.join(dir, 'voice.wav'), buf);
  const wav = readWav(buf);
  const { bounds, voiced } = segment(wav, idx.map((i) => sb.scenes[i].narration.length + 8));
  // durasi adegan menyesuaikan panjang narasi
  const clips = [], words = [];
  let t = 0;
  sb.scenes.forEach((sc, i) => {
    const j = idx.indexOf(i);
    if (j >= 0) {
      const from = bounds[j], to = bounds[j + 1], lead = 0.2;
      sc.sec = Math.round(Math.min(14, Math.max(sc.t === 'countdown' ? sc.sec : MIN_SEC[sc.t] || 2.2, to - from + lead + 0.25)) * 10) / 10;
      clips.push({ at: t + lead, from, to });
      const [va, vb] = voiced[j], ws = sc.narration.split(/\s+/).filter(Boolean), tot = ws.reduce((a, w) => a + w.length + 1, 0);
      let q = 0;
      for (const w of ws) { const a = t + lead + (va - from) + ((vb - va) * q) / tot; q += w.length + 1; words.push({ text: w, t0: Math.round(a * 100) / 100, t1: Math.round((t + lead + (va - from) + ((vb - va) * q) / tot) * 100) / 100 }); }
    }
    t += sc.sec;
  });
  return { voice: { src: assetUrl(job.id, 'voice.wav'), clips }, words };
}

/* ------------------------------------------------------------ unggah hasil */
async function uploadFile(file, name, type, mode, auth) {
  const buf = fs.readFileSync(file);
  if (mode === 'local') {
    const r = await fetch(`${VO_URL}/api/office?files=put&name=${encodeURIComponent(name)}`, { method: 'PUT', body: buf, headers: { 'content-type': type, 'x-render-secret': SECRET } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Upload gagal: ' + (j.error || r.status));
    return { url: j.url, name, type, size: buf.length };
  }
  if (mode !== 'blob') throw new Error('Penyimpanan file Visual Office belum aktif (hubungkan Vercel Blob)');
  const { upload, uploadPresigned } = await import('@vercel/blob/client');
  const fn = auth === 'oidc' ? uploadPresigned : upload;
  const r = await fn('vo/' + name, new Blob([buf], { type }), { access: 'public', contentType: type, handleUploadUrl: `${VO_URL}/api/office?files=token`, headers: { 'x-render-secret': SECRET }, multipart: auth !== 'oidc' && buf.length > 8e6 });
  return { url: r.url, name, type, size: buf.length };
}

/* ------------------------------------------------------------ render */
let serveUrl = null;
async function getBundle() {
  if (serveUrl) return serveUrl;
  makeMusic(false);
  log('Membundel komposisi Remotion…');
  serveUrl = await bundle({ entryPoint: path.join(HERE, 'src', 'index.jsx'), publicDir: path.join(HERE, 'public') });
  return serveUrl;
}
const baseProps = (job, sb, extra) => ({ format: job.format, sb, imageUrl: extra.imageUrl || null, voice: extra.voice, words: extra.words, music: sb.music && sb.music !== 'none' && fs.existsSync(path.join(MUSIC_DIR, sb.music + '.wav')) ? { src: `http://127.0.0.1:${PORT}/music/${sb.music}.wav` } : null });
async function renderJob(job, dir, sb, extra, onProgress) {
  const props = baseProps(job, sb, extra);
  const url = extra.serveUrl || (await getBundle()); // bundel khusus job bila ada adegan kustom
  const composition = await selectComposition({ serveUrl: url, id: 'Video', inputProps: props, browserExecutable: BROWSER });
  const out = path.join(dir, 'video.mp4'), thumb = path.join(dir, 'thumb.jpg');
  let last = 0;
  await renderMedia({
    composition, serveUrl: url, codec: 'h264', crf: 23, audioCodec: 'aac', outputLocation: out, inputProps: props,
    concurrency: CONCURRENCY, browserExecutable: BROWSER, timeoutInMilliseconds: 120000, x264Preset: 'veryfast',
    onProgress: ({ progress }) => { if (Date.now() - last > 4000) { last = Date.now(); onProgress(progress); } },
  });
  await renderStill({ composition, serveUrl: url, output: thumb, inputProps: props, frame: Math.round(Math.min(1.6, sb.scenes[0].sec * 0.6) * FPS), imageFormat: 'jpeg', jpegQuality: 75, scale: 0.5, browserExecutable: BROWSER });
  return { out, thumb, duration: composition.durationInFrames / FPS };
}

/* ------------------------------------------------------------ TINGKAT 2: adegan yang kodenya ditulis AI */
// Adegan bertanda sc.custom (ide animasi) → AI menulis komponen Remotion (JSX) → dicek (aturan, sintaks,
// bundel, render cuplikan di 3 titik waktu) → error dikirim balik ke AI untuk diperbaiki (maks. 3 putaran).
// Tetap gagal → adegan memakai template biasa. Kode AI hanya berjalan di Chrome headless (tanpa akses rahasia).
const CUSTOM_DIR = path.join(HERE, 'src', 'custom');
const GEN_DIR = path.join(CUSTOM_DIR, 'gen');
const CUSTOM_ROUNDS = Math.max(1, Number(env('CUSTOM_ROUNDS', '3')) || 3);
function writeRegistry(ids) {
  fs.writeFileSync(path.join(CUSTOM_DIR, 'index.js'), ids.length
    ? ids.map((id) => `import ${id} from './gen/${id}.jsx';`).join('\n') + `\nexport const CUSTOM = { ${ids.join(', ')} };\n`
    : '// Registri adegan kustom (tingkat 2): ditulis ulang worker untuk tiap job yang punya animasi buatan AI.\n// Kosong = semua adegan memakai template biasa.\nexport const CUSTOM = {};\n');
}
const CODE_SYSTEM = [
  'Kamu motion designer sekaligus engineer Remotion (React) yang membuat adegan video pendek media sosial yang memukau, rapi, dan profesional.',
  'Tulis SATU file JSX berisi `export default function Scene(props) { ... }`.',
  'ATURAN WAJIB:',
  "- Import HANYA dari 'react' dan 'remotion' (AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, Easing, random, Img, OffthreadVideo, Sequence). Tanpa library lain, tanpa file CSS, tanpa fetch/URL luar, tanpa window/document, tanpa Math.random (pakai random('seed-apa-saja')).",
  '- props: scene (isi adegan: title, sub, kicker, items, value, unit, label, narration, …), theme {bg1,bg2,accent,text} (warna hex), fonts {head, body, headWeight}, media {src,type:"photo"|"video"}|null, durationInFrames, safeTop, safeBottom (px area atas/bawah yang dipakai subtitle — jangan taruh teks penting di sana), vertical (true = 9:16).',
  '- Semua gerak dihitung dari useCurrentFrame() (deterministik) dan berlangsung sepanjang durationInFrames (30 fps). Ukuran kanvas dari useVideoConfig().width/height; ukuran huruf relatif terhadap width.',
  '- Akar komponen <AbsoluteFill>. Latar paket sudah digambar di bawah; boleh ditimpa dengan latar sendiri.',
  '- Teks dari scene dipakai persis (bahasa Indonesia), harus terbaca (kontras), tidak keluar layar, tidak bertumpuk. Pakai fonts.head untuk judul.',
  '- Ilustrasi dibuat dari div / SVG inline (ikon, grafik, partikel, bentuk) — kreatif, bukan sekadar teks muncul. Bila media ada, tampilkan dengan <Img> / <OffthreadVideo muted>.',
  'STANDAR DESAIN (agar terlihat seperti iklan profesional, bukan slide):',
  '- Satu fokus utama per adegan; judul besar (± 8–11% dari lebar), pakai ruang layar penuh — tidak ada area kosong besar, tapi beri jarak napas di tepi (± 6% lebar).',
  '- Maksimal 3 warna dari theme + putih/hitam; kontras teks tinggi; bayangan lembut untuk kedalaman.',
  '- Ritme: elemen masuk bertahap di 0–30% durasi (spring/Easing.out), aksen/puncak di tengah (angka berhitung, ikon memantul, garis tergambar), tetap bergerak halus sampai akhir (parallax / zoom pelan). Hindari kedip & gerak acak.',
  '- Ilustrasikan ide secara literal & jelas dengan bentuk/ikon SVG sederhana yang rapi (garis tebal, sudut membulat), bukan dekorasi acak.',
  '- Maksimal ±180 baris. Balas HANYA kode dalam satu blok ```jsx.',
].join('\n');
function codePrompt(t, sb, job) {
  const sc = t.sc, vert = job.format !== '16:9';
  const pick = {}; for (const k of ['kicker', 'title', 'sub', 'items', 'value', 'unit', 'prefix', 'label', 'text', 'author', 'price', 'old', 'left', 'right', 'from']) if (sc[k] != null && sc[k] !== '') pick[k] = sc[k];
  return [
    `Video: "${sb.title}" — ${vert ? 'vertikal 9:16 (720×1280)' : 'horizontal 16:9 (1280×720)'}, paket visual "${sb.pack}".`,
    `Adegan ${t.i + 1} dari ${sb.scenes.length}, durasi ${sc.sec} detik (${Math.round(sc.sec * FPS)} frame).`,
    `IDE ANIMASI: ${sc.custom}`,
    `Isi adegan (template asal "${sc.t}"): ${JSON.stringify(pick)}`,
    sc.narration ? `Narasi yang dibacakan saat adegan ini: "${sc.narration}"` : '',
    `Media: ${sc.mediaSrc ? 'ada (props.media, ' + sc.mediaType + ')' : 'tidak ada'}.`,
    t.err && t.code ? `\nPERCOBAAN SEBELUMNYA GAGAL:\n${t.err}\n\nKode sebelumnya:\n\`\`\`jsx\n${t.code.slice(0, 9000)}\n\`\`\`\nPerbaiki penyebabnya dan tulis ulang file lengkapnya.` : '',
  ].filter(Boolean).join('\n');
}
const extractCode = (text) => { const m = /```(?:jsx|tsx|javascript|js|react)?\s*\n([\s\S]*?)```/.exec(String(text || '')); return (m ? m[1] : String(text || '')).trim(); };
function lintCode(code) {
  if (!/export\s+default/.test(code)) return 'Tidak ada `export default function Scene(props)`.';
  for (const m of code.matchAll(/import\s[^;]*?from\s*['"]([^'"]+)['"]/g)) if (!['react', 'remotion'].includes(m[1])) return `Import "${m[1]}" tidak diizinkan — hanya 'react' dan 'remotion'.`;
  const bad = [[/\brequire\s*\(/, 'require()'], [/\bimport\s*\(/, 'import() dinamis'], [/\bprocess\./, 'process'], [/\beval\s*\(/, 'eval'], [/new\s+Function\b/, 'new Function'], [/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/, 'akses jaringan'], [/\b(window|document|localStorage)\./, 'window/document'], [/Math\.random/, "Math.random (pakai random('seed') dari remotion)"]];
  for (const [re, what] of bad) if (re.test(code)) return `Kode memakai ${what} — tidak diizinkan.`;
  return null;
}
async function syntaxError(code) {
  try { const { transform } = await import('esbuild'); await transform(code, { loader: 'jsx', jsx: 'automatic' }); return null; }
  catch (e) { return 'Error sintaks: ' + String(e.message).split('\n').slice(0, 8).join(' ').slice(0, 700); }
}
async function prepareCustom(job, dir, sb, propsBase, stage) {
  const targets = sb.creative === false ? [] : sb.scenes.map((sc, i) => ({ sc, i, id: 'c' + (i + 1), err: null, code: null, tries: 0 })).filter((t) => t.sc.custom).slice(0, 2);
  if (!targets.length) return null;
  fs.rmSync(GEN_DIR, { recursive: true, force: true }); fs.mkdirSync(GEN_DIR, { recursive: true });
  const starts = []; let acc = 0; for (const sc of sb.scenes) { starts.push(acc); acc += sc.sec; }
  const entryPoint = path.join(HERE, 'src', 'index.jsx'), publicDir = path.join(HERE, 'public');
  let pending = targets.slice(), url = null, bundled = [];
  const good = [];
  for (let round = 0; round < CUSTOM_ROUNDS && pending.length; round++) {
    stage(round);
    for (const t of pending) {
      t.tries++;
      try {
        const r = await api('llm', { system: CODE_SYSTEM, prompt: codePrompt(t, sb, job) });
        let code = extractCode(r.text);
        if (!/import\s+(\*\s+as\s+)?React\b/.test(code)) code = "import React from 'react';\n" + code;
        t.code = code; t.err = lintCode(code) || (await syntaxError(code));
      } catch (e) { t.err = 'AI tidak menjawab: ' + e.message; }
    }
    const cand = pending.filter((t) => t.code && !t.err);
    if (cand.length) {
      for (const t of cand) fs.writeFileSync(path.join(GEN_DIR, t.id + '.jsx'), t.code);
      bundled = [...good, ...cand];
      writeRegistry(bundled.map((t) => t.id));
      try {
        if (url) fs.rmSync(url, { recursive: true, force: true });
        url = await bundle({ entryPoint, publicDir });
        const sbTest = JSON.parse(JSON.stringify(sb)); for (const t of bundled) sbTest.scenes[t.i].customId = t.id;
        const props = { ...propsBase, sb: sbTest, strictCustom: true }; // validasi: error tidak ditutupi template
        const comp = await selectComposition({ serveUrl: url, id: 'Video', inputProps: props, browserExecutable: BROWSER });
        for (const t of cand) {
          try {
            for (const f of [0.15, 0.55, 0.92]) {
              const frame = Math.min(comp.durationInFrames - 1, Math.round((starts[t.i] + t.sc.sec * f) * FPS));
              const out = path.join(dir, `cek-${t.id}.jpg`);
              await renderStill({ composition: comp, serveUrl: url, output: out, inputProps: props, frame, imageFormat: 'jpeg', jpegQuality: 60, scale: 0.25, browserExecutable: BROWSER, timeoutInMilliseconds: 45000 });
              if (fs.statSync(out).size < 2500) throw new Error(`frame di ${Math.round(f * 100)}% durasi terlihat kosong (hampir satu warna) — pastikan ada isi yang terlihat sepanjang adegan`);
            }
            good.push(t);
          } catch (e) { t.err = 'Error saat dirender: ' + String(e.message).split('\n').slice(0, 8).join(' ').slice(0, 700); }
        }
      } catch (e) { for (const t of cand) t.err = 'Error saat dibundel: ' + String(e.message).split('\n').slice(0, 8).join(' ').slice(0, 700); }
    }
    pending = pending.filter((t) => !good.includes(t));
    for (const t of pending) log(`  adegan ${t.i + 1} (kustom) percobaan ${t.tries} gagal: ${t.err}`);
  }
  for (const t of targets) log(`  adegan ${t.i + 1}: ${good.includes(t) ? 'animasi buatan AI ✓' : 'kembali ke template ' + t.sc.t}`);
  if (!good.length) { if (url) fs.rmSync(url, { recursive: true, force: true }); return null; }
  if (bundled.length !== good.length) { // bundel terakhir masih memuat kode yang gagal → bundel ulang hanya yang lolos
    for (const t of bundled) if (!good.includes(t)) fs.rmSync(path.join(GEN_DIR, t.id + '.jsx'), { force: true });
    writeRegistry(good.map((t) => t.id));
    if (url) fs.rmSync(url, { recursive: true, force: true });
    url = await bundle({ entryPoint, publicDir });
  }
  for (const t of good) { sb.scenes[t.i].customId = t.id; sb.scenes[t.i].customOk = true; }
  return url;
}

/* ------------------------------------------------------------ aset dari Boss */
async function fetchAssets(job, dir, list) {
  const out = [];
  for (const [i, a] of list.slice(0, 8).entries()) {
    const isVid = a.type === 'video';
    const name = `asset${i + 1}.${isVid ? 'mp4' : 'jpg'}`;
    try {
      await download(/^\//.test(a.url) ? VO_URL + a.url : a.url, path.join(dir, name), { 'x-render-secret': SECRET }, 60e6);
      out.push({ src: assetUrl(job.id, name), type: isVid ? 'video' : 'photo' });
    } catch (e) { log(`  aset ${i + 1} gagal diunduh:`, e.message); out.push(null); }
  }
  job.imageLocal = out.some((a) => a && a.type === 'photo');
  return out;
}
// adegan yang menunjuk nomor aset (sc.asset = 1..N) memakai file itu
function applyAssets(sb, assets) {
  for (const sc of sb.scenes) {
    const a = sc.asset && assets[sc.asset - 1];
    if (!a) continue;
    sc.mediaSrc = a.src; sc.mediaType = a.type; sc.own = true; delete sc.credit;
  }
}

async function processJob(job, upload) {
  const dir = path.join(WORK, job.id);
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const progress = (p, stage) => api('progress', { id: job.id, progress: p, stage, pexels: STOCK }).catch(() => {});
  try {
    const sb = JSON.parse(JSON.stringify(job.sb));
    log(`Job ${job.id}: "${sb.title}" (${job.format}, paket ${sb.pack}, ${sb.scenes.length} adegan)`);
    // aset Boss (foto/video): daftar dari aplikasi, atau satu foto lama (Telegram / imageUrl) sebagai aset #1
    const list = Array.isArray(job.assets) && job.assets.length ? job.assets
      : job.photoId ? [{ url: `/api/office?render=photo&id=${encodeURIComponent(job.photoId)}`, type: 'photo' }]
      : job.imageUrl ? [{ url: job.imageUrl, type: 'photo' }] : [];
    const assets = await fetchAssets(job, dir, list);
    const imageUrl = (assets.find((a) => a && a.type === 'photo') || {}).src || null; // cadangan untuk adegan image tanpa nomor
    applyAssets(sb, assets);
    await progress(0.02, 'media');
    await prepareMedia(job, dir, sb);
    await progress(0.05, 'narasi');
    const { voice, words } = await prepareVoice(job, dir, sb);
    let customUrl = null;
    try { customUrl = await prepareCustom(job, dir, sb, baseProps(job, sb, { imageUrl, voice, words }), (round) => progress(0.06 + round * 0.01, 'kode')); }
    catch (e) { log('  adegan kustom dilewati:', e.message); }
    finally { writeRegistry([]); } // bundel dasar tetap tanpa kode AI
    await progress(0.1, 'render');
    let r;
    try { r = await renderJob(job, dir, sb, { imageUrl, voice, words, serveUrl: customUrl }, (p) => progress(0.1 + p * 0.83, 'render')); }
    finally { if (customUrl) fs.rmSync(customUrl, { recursive: true, force: true }); }
    await progress(0.95, 'upload');
    const slug = String(sb.title || 'video').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 50) || 'video';
    const file = await uploadFile(r.out, `${slug}.mp4`, 'video/mp4', upload.mode, upload.auth);
    const thumb = await uploadFile(r.thumb, `${slug}-thumb.jpg`, 'image/jpeg', upload.mode, upload.auth).catch(() => null);
    // URL lokal (127.0.0.1) tidak berguna di luar VPS → buang dari naskah yang dikembalikan
    for (const sc of sb.scenes) { delete sc.mediaSrc; delete sc.mediaType; delete sc.own; delete sc.customId; }
    sb.narrated = !!voice;
    await api('done', { id: job.id, file, thumb, duration: r.duration, sb });
    log(`  selesai dalam ${Math.round((Date.now() - t0) / 1000)} dtk → ${file.url}`);
  } catch (e) {
    log('  GAGAL:', e.stack || e.message);
    await api('fail', { id: job.id, error: String(e.message || e).slice(0, 280) }).catch(() => {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------ mode tes (tanpa Visual Office) */
const SAMPLE = {
  title: 'Kenapa AI Boros Listrik?', brand: '@kantorai', music: 'upbeat', voice: 'none', caption: 'Fakta AI #fyp',
  scenes: [
    { t: 'title', kicker: 'FAKTA AI', title: 'Satu pertanyaan ke ChatGPT = 10× listrik Google?', sub: 'Asal angkanya di sini 👇', sec: 3, narration: 'Satu pertanyaan ke ChatGPT, butuh listrik sepuluh kali lipat pencarian Google?', media: 'data center servers' },
    { t: 'media', title: 'Semua jalan di pusat data raksasa', sub: 'Ribuan GPU menyala 24 jam', media: 'data center', sec: 3.5, narration: 'Semua itu jalan di pusat data raksasa dengan ribuan GPU.' },
    { t: 'compare', title: 'Energi per permintaan', unit: 'Wh', items: [{ label: 'ChatGPT', value: 2.9 }, { label: 'Google', value: 0.3 }], highlight: 0, sec: 4.5, narration: 'Perkiraannya, ChatGPT dua koma sembilan watt jam, Google cuma nol koma tiga.' },
    { t: 'stat', value: 16.7, decimals: 1, unit: 'ms', label: 'waktu 1 frame game 60 fps', sec: 3, narration: 'Sebagai pembanding, satu frame game cuma enam belas milidetik.' },
    { t: 'bullets', title: 'Cara hemat', items: ['Tanya yang jelas', 'Pakai model kecil', 'Gabung pertanyaan'], sec: 4, narration: 'Mau hemat? Tanya yang jelas, pakai model kecil, dan gabungkan pertanyaan.' },
    { t: 'cta', title: 'Follow buat fakta AI lainnya!', sub: '@kantorai', sec: 3, narration: 'Follow buat fakta AI lainnya!' },
  ],
};
// adegan lain untuk tes tampilan (--more)
const SAMPLE2 = {
  title: 'Kopi Susu Gula Aren', brand: '@kopikantor', music: 'calm', voice: 'none', caption: 'Promo #kopi',
  scenes: [
    { t: 'countdown', from: 3, label: 'Promo dimulai…', sec: 3, narration: 'Tiga, dua, satu!' },
    { t: 'image', title: 'Kopi Susu Gula Aren', sub: 'Diseduh dari biji pilihan', sec: 3.5, narration: 'Kenalin, kopi susu gula aren kami.' },
    { t: 'steps', title: 'Cara pesan', items: ['Pilih menu', 'Bayar via QRIS', 'Ambil di kasir'], sec: 4, narration: 'Pilih menu, bayar pakai QRIS, ambil di kasir.' },
    { t: 'versus', title: 'Kopi sachet vs kami', left: { label: 'Sachet', items: ['Manis buatan', 'Rasa datar'] }, right: { label: 'Kami', items: ['Gula aren asli', 'Espresso segar'] }, sec: 4.5, narration: 'Beda sama kopi sachet, kami pakai gula aren asli.' },
    { t: 'quote', text: 'Kopi terenak di kantor, wajib coba!', author: 'Rina, pelanggan', sec: 3.5, narration: 'Kata pelanggan, ini kopi terenak di kantor.' },
    { t: 'price', title: 'Harga spesial', price: 'Rp18.000', old: 'Rp25.000', sec: 3.5, narration: 'Sekarang cuma delapan belas ribu.' },
  ],
};
const THEMES = { bold: ['#0b1020', '#1c2a5a', '#ffcc33', '#ffffff'], minimal: ['#f5f3ee', '#e9e5dc', '#111111', '#111111'], neon: ['#05010f', '#140a2e', '#00f0ff', '#ffffff'], editorial: ['#fbf7ef', '#f1e9da', '#d7263d', '#141414'], playful: ['#ffe5ec', '#d7f2ff', '#7b2cbf', '#2b2140'] };
async function testMode(args) {
  const which = args.find((a) => THEMES[a] || a === 'all') || 'bold';
  const packs = which === 'all' ? Object.keys(THEMES) : [which];
  const fmt = args.includes('16:9') ? '16:9' : '9:16';
  const outDir = path.join(HERE, 'out'); fs.mkdirSync(outDir, { recursive: true });
  await startAssetServer();
  const url = await getBundle();
  for (const pack of packs) {
    const [bg1, bg2, accent, text] = THEMES[pack];
    const own = args.includes('--sb') ? JSON.parse(fs.readFileSync(args[args.indexOf('--sb') + 1], 'utf8')) : null; // naskah sendiri (JSON storyboard)
    const sb = { ...JSON.parse(JSON.stringify(own || (args.includes('--more') ? SAMPLE2 : SAMPLE))), pack, theme: { bg1, bg2, accent, text } };
    const job = { id: 'test-' + pack, format: fmt };
    const dir = path.join(WORK, job.id); fs.mkdirSync(dir, { recursive: true });
    const img = args[args.indexOf('--image') + 1];
    let imageUrl = null;
    if (args.includes('--image') && img && fs.existsSync(img)) { fs.copyFileSync(img, path.join(dir, 'image.jpg')); imageUrl = assetUrl(job.id, 'image.jpg'); job.imageLocal = true; }
    if (args.includes('--assets')) { // tes beberapa aset: --assets foto1.jpg,video.mp4,…
      const files = args[args.indexOf('--assets') + 1].split(',').filter((f) => fs.existsSync(f));
      const assets = files.map((f, i) => { const v = /\.(mp4|webm|mov)$/i.test(f), name = `asset${i + 1}.${v ? 'mp4' : 'jpg'}`; fs.copyFileSync(f, path.join(dir, name)); return { src: assetUrl(job.id, name), type: v ? 'video' : 'photo' }; });
      applyAssets(sb, assets); job.imageLocal = assets.some((a) => a.type === 'photo');
    }
    await prepareMedia(job, dir, sb);
    // subtitle contoh (tanpa TTS): waktu kata dibagi rata per adegan
    const words = []; let t = 0;
    if (args.includes('--captions')) for (const sc of sb.scenes) { const ws = sc.narration.split(' '); ws.forEach((w, i) => words.push({ text: w, t0: t + 0.2 + (i * (sc.sec - 0.5)) / ws.length, t1: t + 0.2 + ((i + 1) * (sc.sec - 0.5)) / ws.length })); t += sc.sec; }
    const music = args.includes('--music') && fs.existsSync(path.join(MUSIC_DIR, (sb.music || 'upbeat') + '.wav')) ? { src: `http://127.0.0.1:${PORT}/music/${sb.music || 'upbeat'}.wav` } : null;
    const props = { format: fmt, sb, imageUrl, voice: null, words, music };
    const composition = await selectComposition({ serveUrl: url, id: 'Video', inputProps: props, browserExecutable: BROWSER });
    if (args.includes('--still')) {
      let acc = 0;
      for (const [i, sc] of sb.scenes.entries()) {
        const out = path.join(outDir, `${pack}-${fmt.replace(':', 'x')}-${args.includes('--more') ? 'b' : 'a'}${i}-${sc.t}.jpg`);
        await renderStill({ composition, serveUrl: url, output: out, inputProps: props, frame: Math.round((acc + sc.sec * 0.75) * FPS), imageFormat: 'jpeg', jpegQuality: 80, scale: 0.5, browserExecutable: BROWSER });
        acc += sc.sec;
      }
      log('still', pack, 'OK');
    } else {
      const t1 = Date.now(), out = path.join(outDir, `test-${pack}.mp4`);
      await renderMedia({ composition, serveUrl: url, codec: 'h264', crf: 23, audioCodec: 'aac', outputLocation: out, inputProps: props, concurrency: CONCURRENCY, browserExecutable: BROWSER, x264Preset: 'veryfast' });
      log(`render ${pack}: ${out} (${Math.round((Date.now() - t1) / 1000)} dtk)`);
    }
  }
  process.exit(0);
}

/* ------------------------------------------------------------ loop utama */
async function main() {
  const args = process.argv.slice(2);
  if (!BROWSER) await ensureBrowser();
  writeRegistry([]); // sisa job yang terhenti tidak boleh ikut ke bundel dasar
  if (args.includes('--test')) return testMode(args);
  if (!VO_URL || !SECRET) { console.error('VO_URL dan RENDER_WORKER_SECRET wajib diisi (lihat /etc/visual-office-worker.env)'); process.exit(1); }
  await startAssetServer();
  await getBundle();
  log(`Worker render Visual Office ${VERSION} siap → ${VO_URL} (foto/video stok: ${PIXABAY ? 'Pixabay' : PEXELS ? 'Pexels' : 'tidak'})`);
  let busy = false;
  setInterval(() => { if (busy) api('beat', { pexels: STOCK, version: VERSION }).catch(() => {}); }, 20000);
  for (;;) {
    try {
      const r = await api('claim', { pexels: STOCK, version: VERSION });
      if (r.job) { busy = true; await processJob(r.job, { mode: r.upload, auth: r.auth }); busy = false; continue; }
    } catch (e) { busy = false; log('Tidak bisa menghubungi Visual Office:', e.message); await sleep(15000); }
    await sleep(4000);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

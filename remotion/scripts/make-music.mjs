/* =========================================================================
 * make-music.mjs — membuat musik latar bebas royalti (disintesis dari kode) → public/music/*.wav
 *   upbeat : 118 bpm, kick-clap-hihat, bass, akor pluck (I–V–vi–IV)
 *   calm   : 78 bpm lo-fi, akor rhodes lembut, kick pelan, desis piringan hitam
 *   drama  : 90 bpm sinematik, drone senar, pukulan taiko, arpeggio naik
 * Jalankan: node scripts/make-music.mjs   (otomatis dijalankan worker bila file belum ada)
 * ========================================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 44100, LEN = 72; // detik (video maks ±60 dtk)
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'music');
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

function render(fn) {
  const n = SR * LEN, buf = new Float32Array(n);
  fn(buf);
  // normalisasi lembut + fade
  let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v));
  const g = 0.85 / (peak || 1);
  for (let i = 0; i < n; i++) { const t = i / SR; buf[i] = Math.tanh(buf[i] * g * 1.1) * Math.min(1, t / 0.5, (LEN - t) / 2); }
  return buf;
}
const add = (buf, start, len, f) => { const s = Math.floor(start * SR), e = Math.min(buf.length, s + Math.floor(len * SR)); for (let i = Math.max(0, s); i < e; i++) buf[i] += f((i - s) / SR); };
const kick = (buf, at, v = 1) => add(buf, at, 0.35, (t) => Math.sin(2 * Math.PI * (50 * t + 90 * (1 - Math.exp(-t * 30)) / 30)) * Math.exp(-t * 9) * v);
const snare = (buf, at, v = 0.5) => add(buf, at, 0.25, (t) => (rnd() * 0.8 + Math.sin(2 * Math.PI * 190 * t) * 0.3) * Math.exp(-t * 18) * v);
const hat = (buf, at, v = 0.12) => add(buf, at, 0.05, (t) => rnd() * Math.exp(-t * 90) * v);
const tone = (buf, at, len, f, v, shape = 'sine', att = 0.01, rel = 4) => add(buf, at, len, (t) => {
  const ph = 2 * Math.PI * f * t;
  const w = shape === 'saw' ? ((f * t) % 1) * 2 - 1 : shape === 'tri' ? Math.asin(Math.sin(ph)) * 0.64 : shape === 'pluck' ? Math.sin(ph) * 0.7 + Math.sin(2 * ph) * 0.2 * Math.exp(-t * 8) : Math.sin(ph);
  return w * v * Math.min(1, t / att) * Math.exp(-t * rel);
});
// filter low-pass satu kutub (untuk melembutkan saw)
const lowpass = (buf, cut) => { const a = Math.exp((-2 * Math.PI * cut) / SR); let y = 0; for (let i = 0; i < buf.length; i++) { y = (1 - a) * buf[i] + a * y; buf[i] = y; } return buf; };

const PROG = [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]]; // C G Am F

const upbeat = () => render((b) => {
  const bpm = 118, beat = 60 / bpm, bar = beat * 4;
  for (let t = 0, i = 0; t < LEN; t += beat, i++) {
    kick(b, t, 0.9); hat(b, t + beat / 2, 0.14); hat(b, t, 0.06);
    if (i % 2 === 1) snare(b, t, 0.45);
  }
  for (let t = 0, j = 0; t < LEN; t += bar, j++) {
    const ch = PROG[j % 4];
    for (let s = 0; s < 8; s++) tone(b, t + s * beat / 2, 0.4, midi(ch[0] - 24), 0.28, 'tri', 0.005, 6); // bass 8th
    for (let s = 0; s < 8; s++) tone(b, t + s * beat / 2, 0.3, midi(ch[s % 3] + 12), 0.08, 'pluck', 0.002, 9); // arpeggio
    ch.forEach((n) => tone(b, t, bar, midi(n), 0.035, 'saw', 0.05, 0.6));
  }
});

const calm = () => render((b) => {
  const bpm = 78, beat = 60 / bpm, bar = beat * 4;
  const prog = [[57, 60, 64, 67], [53, 57, 60, 64], [48, 52, 55, 59], [55, 59, 62, 65]]; // Am7 Fmaj7 Cmaj7 G7
  for (let t = 0, i = 0; t < LEN; t += beat, i++) {
    if (i % 4 === 0) kick(b, t, 0.5);
    if (i % 4 === 2) kick(b, t + beat / 2, 0.35);
    if (i % 2 === 1) snare(b, t, 0.18);
    hat(b, t + beat / 2, 0.05);
  }
  for (let t = 0, j = 0; t < LEN; t += bar, j++) {
    const ch = prog[j % 4];
    ch.forEach((n, q) => { tone(b, t + q * 0.03, bar * 0.95, midi(n), 0.07, 'sine', 0.02, 0.9); tone(b, t + q * 0.03, bar * 0.95, midi(n + 12), 0.015, 'sine', 0.02, 1.4); });
    tone(b, t, bar, midi(ch[0] - 24), 0.2, 'sine', 0.02, 0.8);
  }
  for (let i = 0; i < b.length; i++) b[i] += rnd() * 0.004 + (Math.random() < 0.0002 ? rnd() * 0.08 : 0); // desis vinyl
});

const drama = () => render((b) => {
  const bpm = 90, beat = 60 / bpm, bar = beat * 4;
  const prog = [[50, 57, 62], [46, 53, 58], [48, 55, 60], [45, 52, 57]]; // Dm Bb C A
  const pad = new Float32Array(b.length);
  for (let t = 0, j = 0; t < LEN; t += bar, j++) {
    const ch = prog[j % 4];
    ch.forEach((n) => { tone(pad, t, bar + 0.3, midi(n), 0.09, 'saw', 0.6, 0.15); tone(pad, t, bar + 0.3, midi(n) * 1.003, 0.07, 'saw', 0.6, 0.15); });
    tone(b, t, bar, midi(ch[0] - 24), 0.25, 'sine', 0.3, 0.3);
    for (let s = 0; s < 8; s++) tone(b, t + s * beat / 2, 0.25, midi(ch[s % 3] + 12 + (s > 3 ? 12 : 0)), 0.045, 'pluck', 0.002, 10);
  }
  lowpass(pad, 900); for (let i = 0; i < b.length; i++) b[i] += pad[i];
  for (let t = 0, i = 0; t < LEN; t += beat, i++) {
    if (i % 4 === 0) kick(b, t, 1); if (i % 8 === 6) { kick(b, t, 0.7); kick(b, t + beat / 2, 0.6); }
    if (i % 4 === 2) snare(b, t, 0.3);
  }
});

function wav(f32) {
  const n = f32.length, out = Buffer.alloc(44 + n * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + n * 2, 4); out.write('WAVE', 8); out.write('fmt ', 12);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(SR, 24); out.writeUInt32LE(SR * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(f32[i] * 32767))), 44 + i * 2);
  return out;
}

export function makeMusic(force) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, fn] of Object.entries({ upbeat, calm, drama })) {
    const p = path.join(OUT, name + '.wav');
    if (!force && fs.existsSync(p)) continue;
    fs.writeFileSync(p, wav(fn()));
    console.log('musik dibuat:', p);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) makeMusic(process.argv.includes('--force'));

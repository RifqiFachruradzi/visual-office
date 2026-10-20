/* =========================================================================
 * Video.jsx — komposisi Remotion untuk video Visual Office.
 * Props: { format, sb (storyboard dari js/videoboard.js), imageUrl, voice, words, music }
 *   sb.pack   → paket visual (font, latar, animasi teks, kartu, transisi, subtitle berbeda)
 *   sb.scenes → adegan; tiap adegan satu template (title, stat, compare, …, media, cta)
 *               sc.mediaSrc / sc.mediaType diisi worker (foto/video stok Pexels)
 *   voice     → { src, clips:[{at, from, to}] } potongan narasi per adegan (detik)
 *   words     → [{ text, t0, t1 }] waktu tiap kata narasi (subtitle kata per kata)
 *   music     → { src, volume } musik latar (diredam otomatis saat narasi)
 * ========================================================================= */
import React, { useEffect, useState } from 'react';
import {
  AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, continueRender, delayRender,
  interpolate, random, spring, useCurrentFrame, useVideoConfig,
} from 'remotion';

export const FPS = 30;
export const SIZES = { '9:16': [720, 1280], '16:9': [1280, 720] };
export const totalSeconds = (sb) => (sb && sb.scenes ? sb.scenes.reduce((a, x) => a + (Number(x.sec) || 3), 0) : 10);

/* ------------------------------------------------------------ paket visual */
export const PACKS = {
  bold: { head: 'Montserrat', hw: 900, body: 'Montserrat', bw: 700, upper: true, enter: 'pop', trans: 'slide', bg: 'blobs', radius: 28, card: 'glass', caption: 'stroke', kicker: 'pill', progress: 'stories', track: -0.01 },
  minimal: { head: 'Inter', hw: 800, body: 'Inter', bw: 500, upper: false, enter: 'rise', trans: 'fade', bg: 'paper', radius: 16, card: 'flat', caption: 'pill', kicker: 'text', progress: 'line', track: -0.03 },
  neon: { head: 'Space Grotesk', hw: 700, body: 'Space Grotesk', bw: 500, upper: true, enter: 'glitch', trans: 'glitch', bg: 'grid', radius: 6, card: 'outline', caption: 'glow', kicker: 'bracket', progress: 'stories', track: 0.02 },
  editorial: { head: 'Playfair Display', hw: 800, body: 'Inter', bw: 500, upper: false, enter: 'mask', trans: 'wipe', bg: 'blocks', radius: 0, card: 'rule', caption: 'bar', kicker: 'rule', progress: 'folio', track: -0.01 },
  playful: { head: 'Fredoka', hw: 700, body: 'Fredoka', bw: 500, upper: false, enter: 'wobble', trans: 'zoom', bg: 'confetti', radius: 40, card: 'sticker', caption: 'bubble', kicker: 'sticker', progress: 'dots', track: 0 },
};
const FONTS = ['900 40px Montserrat', '700 40px Montserrat', '800 40px Inter', '500 40px Inter', '700 40px "Space Grotesk"', '500 40px "Space Grotesk"', '800 40px "Playfair Display"', 'italic 700 40px "Playfair Display"', '700 40px Fredoka', '500 40px Fredoka'];

/* ------------------------------------------------------------ util */
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };
const lum = (hex) => { const n = parseInt(String(hex).slice(1), 16); const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const onColor = (hex) => (lum(hex) > 0.4 ? '#111111' : '#ffffff');
const alpha = (hex, a) => { const n = parseInt(String(hex).slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
const fmt = (v, d = 0) => Number(v).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d });
const decs = (v) => (String(v).includes('.') ? Math.min(2, String(v).split('.')[1].length) : 0);

// Konteks gaya: paket + tema + ukuran
function useLook(sb, hasCaptions) {
  const { width: W, height: H } = useVideoConfig();
  const pack = PACKS[sb.pack] || PACKS.bold;
  const th = sb.theme || {};
  const vert = H > W, k = Math.min(W, H) / 720;
  const dark = lum(th.bg1 || '#000000') < 0.3;
  return {
    W, H, vert, k, pack, dark,
    bg1: th.bg1 || '#0b1020', bg2: th.bg2 || '#1c2a5a', accent: th.accent || '#ffcc33', text: th.text || '#ffffff',
    onAccent: onColor(th.accent || '#ffcc33'),
    padX: vert ? 56 * k : W * 0.12,
    top: (vert ? 150 : 100) * k,
    bottom: (hasCaptions ? (vert ? 330 : 150) : vert ? 130 : 80) * k,
  };
}
const LookCtx = React.createContext(null);
const useL = () => React.useContext(LookCtx);

/* ------------------------------------------------------------ teks beranimasi */
function Word({ children, i, delay, size, color, L, italic }) {
  const f = useCurrentFrame(), { fps } = useVideoConfig();
  const p = L.pack, d = Math.round(delay * fps) + i * (p.enter === 'wobble' ? 3 : 2);
  const t = f - d;
  let style = {};
  if (p.enter === 'pop') {
    const s = spring({ frame: t, fps, config: { damping: 11, stiffness: 160 } });
    style = { transform: `scale(${0.4 + 0.6 * s})`, opacity: interpolate(t, [0, 4], [0, 1], clamp), textShadow: `0 ${4 * L.k}px 0 rgba(0,0,0,0.25)` };
  } else if (p.enter === 'rise') {
    const e = interpolate(t, [0, 12], [0, 1], { ...clamp, easing: (x) => 1 - Math.pow(1 - x, 3) });
    style = { transform: `translateY(${(1 - e) * 26 * L.k}px)`, opacity: e };
  } else if (p.enter === 'glitch') {
    const on = t >= 0 && (t > 8 || random(`g${i}-${t}`) > 0.35);
    const j = t < 8 ? (random(`x${i}-${t}`) - 0.5) * 14 * L.k : 0;
    const sh = t < 12 ? 3 * L.k * (1 - t / 12) : 0;
    style = { opacity: on ? 1 : 0, transform: `translateX(${j}px)`, textShadow: `${sh + 1}px 0 #ff2bd6, ${-sh - 1}px 0 #00f0ff, 0 0 ${18 * L.k}px ${alpha(L.accent, 0.6)}` };
  } else if (p.enter === 'mask') {
    const e = interpolate(t, [0, 14], [0, 1], { ...clamp, easing: (x) => 1 - Math.pow(1 - x, 4) });
    return (
      <span style={{ display: 'inline-block', overflow: 'hidden', verticalAlign: 'bottom', padding: '0 0.04em', marginBottom: '-0.12em', paddingBottom: '0.12em' }}>
        <span style={{ display: 'inline-block', transform: `translateY(${(1 - e) * 110}%)`, color, fontStyle: italic ? 'italic' : 'normal' }}>{children}</span>
      </span>
    );
  } else if (p.enter === 'wobble') {
    const s = spring({ frame: t, fps, config: { damping: 7, stiffness: 140 } });
    const rot = (random(`r${i}`) - 0.5) * 16 * (1 - s);
    style = { transform: `scale(${s}) rotate(${rot}deg)`, opacity: interpolate(t, [0, 3], [0, 1], clamp) };
  }
  return <span style={{ display: 'inline-block', color, ...style }}>{children}</span>;
}

function Headline({ text, size, delay = 0.1, color, align = 'center', style, accentLast }) {
  const L = useL();
  const p = L.pack;
  const words = String(text || '').split(/\s+/).filter(Boolean);
  return (
    <div style={{ fontFamily: `"${p.head}"`, fontWeight: p.hw, fontSize: size * L.k, lineHeight: p.head === 'Playfair Display' ? 1.08 : 1.05, letterSpacing: `${p.track}em`, textTransform: p.upper ? 'uppercase' : 'none', textAlign: align, color: color || L.text, ...style }}>
      {words.map((w, i) => (
        <React.Fragment key={i}>
          <Word i={i} delay={delay} L={L} color={accentLast && i === words.length - 1 ? L.accent : color || L.text} italic={p.enter === 'mask' && i === words.length - 1}>{w}</Word>{' '}
        </React.Fragment>
      ))}
    </div>
  );
}

function Body({ text, size = 36, delay = 0.45, align = 'center', color, style }) {
  const L = useL(), f = useCurrentFrame(), { fps } = useVideoConfig();
  if (!text) return null;
  const e = interpolate(f - delay * fps, [0, 12], [0, 1], clamp);
  return <div style={{ fontFamily: `"${L.pack.body}"`, fontWeight: L.pack.bw, fontSize: size * L.k, lineHeight: 1.35, textAlign: align, color: color || L.text, opacity: e * 0.9, transform: `translateY(${(1 - e) * 16 * L.k}px)`, ...style }}>{text}</div>;
}

function Kicker({ text, delay = 0, align = 'center' }) {
  const L = useL(), f = useCurrentFrame(), { fps } = useVideoConfig();
  if (!text) return null;
  const p = L.pack, k = L.k, s = spring({ frame: f - delay * fps, fps, config: { damping: 14 } });
  const base = { fontFamily: `"${p.body}"`, fontWeight: 800, fontSize: 26 * k, letterSpacing: '0.12em', textTransform: 'uppercase', display: 'inline-block', opacity: s };
  const wrap = (el) => <div style={{ textAlign: align, marginBottom: 24 * k }}>{el}</div>;
  if (p.kicker === 'pill') return wrap(<span style={{ ...base, background: L.accent, color: L.onAccent, padding: `${10 * k}px ${22 * k}px`, borderRadius: 99, transform: `scale(${0.6 + 0.4 * s})` }}>{text}</span>);
  if (p.kicker === 'text') return wrap(<span style={{ ...base, color: L.accent, opacity: s * 0.75, letterSpacing: '0.2em', fontWeight: 600 }}>{text}</span>);
  if (p.kicker === 'bracket') return wrap(<span style={{ ...base, color: L.accent, textShadow: `0 0 ${14 * k}px ${L.accent}` }}>[ {text} ]</span>);
  if (p.kicker === 'rule') return wrap(<span style={{ ...base, color: L.accent, fontFamily: 'Inter', borderTop: `${4 * k}px solid ${L.accent}`, paddingTop: 10 * k, width: `${interpolate(s, [0, 1], [0, 100])}%`, maxWidth: 420 * k, textAlign: align }}>{text}</span>);
  return wrap(<span style={{ ...base, background: '#ffffff', color: L.accent, padding: `${10 * k}px ${24 * k}px`, borderRadius: 18 * k, boxShadow: `0 ${6 * k}px 0 ${L.accent}`, transform: `rotate(-4deg) scale(${s})` }}>{text}</span>);
}

function Card({ children, style, accent }) {
  const L = useL(), k = L.k, c = L.pack.card;
  const st = {
    glass: { background: accent ? alpha(L.accent, 0.22) : 'rgba(255,255,255,0.12)', border: `1px solid rgba(255,255,255,${accent ? 0.35 : 0.14})` },
    flat: { background: '#ffffff', boxShadow: `0 ${10 * k}px ${30 * k}px rgba(0,0,0,0.07)`, border: accent ? `${3 * k}px solid ${L.accent}` : '1px solid rgba(0,0,0,0.06)' },
    outline: { background: 'rgba(255,255,255,0.04)', border: `${2 * k}px solid ${accent ? L.accent : alpha(L.accent, 0.45)}`, boxShadow: accent ? `0 0 ${24 * k}px ${alpha(L.accent, 0.5)}, inset 0 0 ${18 * k}px ${alpha(L.accent, 0.2)}` : `0 0 ${10 * k}px ${alpha(L.accent, 0.2)}` },
    rule: { background: accent ? alpha(L.accent, 0.08) : 'transparent', borderLeft: `${8 * k}px solid ${accent ? L.accent : L.text}`, borderRadius: 0 },
    sticker: { background: '#ffffff', border: `${4 * k}px solid ${L.text}`, boxShadow: `0 ${8 * k}px 0 ${accent ? L.accent : L.text}` },
  }[c];
  return <div style={{ borderRadius: L.pack.radius * k, ...st, ...style }}>{children}</div>;
}

/* ------------------------------------------------------------ latar per paket */
function Background({ sceneIndex, start }) {
  const L = useL(), f = useCurrentFrame(), { W, H, k } = L, t = (f + start) / FPS; // t: waktu absolut (latar mengalir antar-adegan)
  const p = L.pack;
  if (p.bg === 'blobs') {
    const blobs = [0, 1, 2].map((i) => {
      const x = W * (0.2 + 0.6 * ((Math.sin(t * 0.25 + i * 2.1) + 1) / 2)), y = H * (0.15 + 0.7 * ((Math.cos(t * 0.2 + i * 1.7) + 1) / 2)), r = (380 + i * 120) * k;
      return <div key={i} style={{ position: 'absolute', left: x - r / 2, top: y - r / 2, width: r, height: r, borderRadius: '50%', background: i === 1 ? L.accent : '#ffffff', opacity: i === 1 ? 0.18 : 0.06, filter: `blur(${90 * k}px)` }} />;
    });
    return <AbsoluteFill style={{ background: `linear-gradient(160deg, ${L.bg1} 0%, ${L.bg2} 100%)`, overflow: 'hidden' }}>{blobs}</AbsoluteFill>;
  }
  if (p.bg === 'paper') {
    return (
      <AbsoluteFill style={{ background: L.bg1, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, backgroundImage: `radial-gradient(${alpha(L.text, 0.08)} ${1.6 * k}px, transparent ${1.8 * k}px)`, backgroundSize: `${34 * k}px ${34 * k}px`, opacity: 0.8 }} />
        <div style={{ position: 'absolute', right: -260 * k, bottom: -260 * k + Math.sin(t * 0.4) * 20 * k, width: 720 * k, height: 720 * k, borderRadius: '50%', background: L.bg2 }} />
        <div style={{ position: 'absolute', left: L.padX, top: L.top - 22 * k, width: 60 * k, height: 6 * k, background: L.accent }} />
      </AbsoluteFill>
    );
  }
  if (p.bg === 'grid') {
    return (
      <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 30%, ${L.bg2} 0%, ${L.bg1} 70%)`, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: '-50%', right: '-50%', bottom: '-10%', height: '55%', transform: 'perspective(600px) rotateX(62deg)', transformOrigin: '50% 100%', backgroundImage: `linear-gradient(${alpha(L.accent, 0.55)} ${2 * k}px, transparent ${2 * k}px), linear-gradient(90deg, ${alpha(L.accent, 0.55)} ${2 * k}px, transparent ${2 * k}px)`, backgroundSize: `${70 * k}px ${70 * k}px`, backgroundPosition: `0 ${(t * 60 * k) % (70 * k)}px`, maskImage: 'linear-gradient(to top, black 30%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to top, black 30%, transparent 100%)' }} />
        <div style={{ position: 'absolute', inset: 0, backgroundImage: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.25) 0px, rgba(0,0,0,0.25) 1px, transparent 2px, transparent 4px)', opacity: 0.5 }} />
        <div style={{ position: 'absolute', left: 0, right: 0, top: `${(t * 18) % 100}%`, height: 120 * k, background: `linear-gradient(transparent, ${alpha(L.accent, 0.06)}, transparent)` }} />
      </AbsoluteFill>
    );
  }
  if (p.bg === 'blocks') {
    const side = sceneIndex % 2;
    const e = spring({ frame: f, fps: FPS, config: { damping: 30 } });
    return (
      <AbsoluteFill style={{ background: L.bg1, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, backgroundImage: `repeating-linear-gradient(0deg, ${alpha(L.text, 0.035)} 0 1px, transparent 1px ${48 * k}px)` }} />
        <div style={{ position: 'absolute', [side ? 'left' : 'right']: 0, top: 0, width: `${L.vert ? 34 : 26}%`, height: '100%', background: L.bg2, transform: `translateY(${(1 - e) * -100}%)` }} />
        <div style={{ position: 'absolute', left: 0, top: 0, width: 18 * k, height: '100%', background: L.accent }} />
      </AbsoluteFill>
    );
  }
  // confetti (playful)
  const shapes = Array.from({ length: 14 }, (_, i) => {
    const sx = random(`cx${i}`), sy = random(`cy${i}`), sz = (24 + random(`cs${i}`) * 46) * k, kind = i % 3;
    const x = sx * W, y = ((sy * H + t * (30 + i * 4) * k) % (H + 100 * k)) - 50 * k, rot = t * (i % 2 ? 40 : -30) + i * 20;
    const col = [L.accent, '#ffb703', '#06d6a0', '#ef476f', '#118ab2'][i % 5];
    return <div key={i} style={{ position: 'absolute', left: x, top: y, width: sz, height: kind === 1 ? sz * 0.4 : sz, borderRadius: kind === 0 ? '50%' : kind === 1 ? 99 : 8 * k, background: col, opacity: 0.35, transform: `rotate(${rot}deg)` }} />;
  });
  return <AbsoluteFill style={{ background: `linear-gradient(170deg, ${L.bg1}, ${L.bg2})`, overflow: 'hidden' }}>{shapes}</AbsoluteFill>;
}

/* ------------------------------------------------------------ media (foto / video stok, foto produk) */
function MediaFill({ src, type, sec, dim = 0.45 }) {
  const f = useCurrentFrame(), L = useL();
  const z = interpolate(f, [0, sec * FPS], [1.04, 1.16], clamp), dx = interpolate(f, [0, sec * FPS], [-1.5, 1.5], clamp);
  const st = { width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${z}) translateX(${dx}%)` };
  return (
    <AbsoluteFill style={{ overflow: 'hidden', background: '#000' }}>
      {type === 'video' ? <OffthreadVideo src={src} muted style={st} /> : <Img src={src} style={st} />}
      <AbsoluteFill style={{ background: `linear-gradient(180deg, rgba(0,0,0,${dim * 0.6}) 0%, rgba(0,0,0,${dim * 0.3}) 40%, rgba(0,0,0,${Math.min(0.92, dim + 0.35)}) 100%)` }} />
      {L.pack.bg === 'grid' ? <AbsoluteFill style={{ background: alpha(L.bg1, 0.25), mixBlendMode: 'multiply' }} /> : null}
    </AbsoluteFill>
  );
}

/* ------------------------------------------------------------ template adegan */
const Stack = ({ children, justify = 'center', style }) => {
  const L = useL();
  return <AbsoluteFill style={{ padding: `${L.top}px ${L.padX}px ${L.bottom}px`, display: 'flex', flexDirection: 'column', justifyContent: justify, ...style }}>{children}</AbsoluteFill>;
};

const T = {};
T.title = ({ sc }) => {
  const L = useL();
  const onMedia = !!sc.mediaSrc;
  const f = useCurrentFrame();
  const bar = interpolate(f, [12, 26], [0, 1], clamp);
  const align = L.pack.bg === 'blocks' || L.pack.bg === 'paper' ? 'left' : 'center';
  return (
    <>
      {onMedia ? <MediaFill src={sc.mediaSrc} type={sc.mediaType} sec={sc.sec} dim={0.5} /> : null}
      <Stack>
        <Kicker text={sc.kicker} align={align} />
        <Headline text={sc.title} size={L.vert ? 84 : 72} align={align} accentLast={L.pack.enter !== 'glitch'} color={onMedia ? '#ffffff' : undefined} />
        <div style={{ height: 10 * L.k, width: `${bar * (align === 'left' ? 30 : 40)}%`, background: L.accent, margin: `${28 * L.k}px ${align === 'left' ? '0' : 'auto'}`, borderRadius: 99, boxShadow: L.pack.bg === 'grid' ? `0 0 ${16 * L.k}px ${L.accent}` : 'none' }} />
        <Body text={sc.sub} size={38} align={align} color={onMedia ? '#ffffff' : undefined} />
      </Stack>
    </>
  );
};

T.media = ({ sc }) => {
  const L = useL();
  if (!sc.mediaSrc) return <T.title sc={sc} />;
  const align = L.pack.bg === 'confetti' ? 'center' : 'left';
  return (
    <>
      <MediaFill src={sc.mediaSrc} type={sc.mediaType} sec={sc.sec} dim={0.42} />
      <Stack justify="flex-end">
        <Kicker text={sc.kicker} align={align} />
        <Headline text={sc.title} size={L.vert ? 70 : 60} align={align} color="#ffffff" delay={0.25} />
        <Body text={sc.sub} size={34} align={align} color="#ffffff" delay={0.6} style={{ marginTop: 18 * L.k }} />
      </Stack>
      {sc.credit ? <div style={{ position: 'absolute', right: 18 * L.k, top: (L.vert ? 110 : 70) * L.k, fontFamily: 'Inter', fontSize: 16 * L.k, color: 'rgba(255,255,255,0.6)' }}>{sc.credit}</div> : null}
    </>
  );
};

T.stat = ({ sc }) => {
  const L = useL(), f = useCurrentFrame(), { fps } = useVideoConfig();
  const p = interpolate(f, [6, Math.min(sc.sec * fps * 0.55, 42)], [0, 1], { ...clamp, easing: (x) => 1 - Math.pow(1 - x, 3) });
  const s = spring({ frame: f - 3, fps, config: { damping: 12 } });
  const txt = (sc.prefix || '') + fmt(sc.value * p, sc.decimals || 0);
  const big = Math.min(L.vert ? 200 : 180, (L.vert ? 1100 : 1500) / Math.max(3, txt.length));
  const glow = L.pack.bg === 'grid' ? `0 0 ${30 * L.k}px ${L.accent}` : L.pack.card === 'sticker' ? `0 ${8 * L.k}px 0 ${L.text}` : 'none';
  return (
    <Stack>
      {sc.title ? <Headline text={sc.title} size={L.vert ? 52 : 46} /> : null}
      <div style={{ textAlign: 'center', margin: `${30 * L.k}px 0`, transform: `scale(${0.8 + 0.2 * s})` }}>
        <div style={{ fontFamily: `"${L.pack.head}"`, fontWeight: L.pack.hw, fontSize: big * L.k, lineHeight: 1, color: L.accent, textShadow: glow, fontVariantNumeric: 'tabular-nums' }}>{txt}</div>
        {sc.unit ? <div style={{ fontFamily: `"${L.pack.head}"`, fontWeight: L.pack.hw, fontSize: big * 0.34 * L.k, color: L.text, marginTop: 8 * L.k }}>{sc.unit}</div> : null}
      </div>
      <Body text={sc.label} size={40} delay={0.8} />
    </Stack>
  );
};

T.compare = ({ sc }) => {
  const L = useL(), f = useCurrentFrame(), { fps } = useVideoConfig(), k = L.k;
  const n = sc.items.length, max = Math.max(...sc.items.map((i) => i.value), 1e-9);
  const a = sc.items[0].value, b = sc.items[1] ? sc.items[1].value : 0, r = n === 2 ? Math.max(a, b) / Math.max(1e-9, Math.min(a, b)) : 0;
  const showBadge = r >= 1.5 && isFinite(r);
  // tinggi grafik menyesuaikan ruang (judul, label, badge rasio, subtitle)
  const avail = L.H - L.top - L.bottom - (L.vert ? 150 : 110) * k - (L.vert ? 70 : 40) * k - 80 * k - (showBadge && L.vert ? 130 * k : 0);
  const chartH = Math.max(220 * k, Math.min((L.vert ? 560 : 360) * k, avail));
  const badge = spring({ frame: f - Math.round(Math.min(1.6, sc.sec * 0.55) * fps), fps, config: { damping: 9 } });
  return (
    <Stack justify="flex-start">
      <Headline text={sc.title || 'Perbandingan'} size={L.vert ? 58 : 48} />
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 40 * k, height: chartH, marginTop: (L.vert ? 70 : 40) * k, borderBottom: `${3 * k}px solid ${alpha(L.text, 0.3)}`, position: 'relative' }}>
        {sc.items.map((it, i) => {
          const d = Math.round((Math.min(0.35, sc.sec * 0.1) + i * Math.min(0.25, (sc.sec * 0.3) / n)) * fps);
          const p = interpolate(f - d, [0, Math.min(27, sc.sec * fps * 0.3)], [0, 1], { ...clamp, easing: (x) => 1 - Math.pow(1 - x, 3) });
          const hi = i === sc.highlight, h = Math.max(6 * k, (it.value / max) * (chartH - 90 * k) * p);
          const w = Math.min(170 * k, ((L.W - 2 * L.padX) - 40 * k * (n - 1)) / n);
          const fill = hi ? L.accent : alpha(L.text, 0.32);
          return (
            <div key={i} style={{ width: w, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
              <div style={{ fontFamily: `"${L.pack.head}"`, fontWeight: L.pack.hw, fontSize: 44 * k, color: hi ? L.accent : L.text, opacity: p, marginBottom: 12 * k, whiteSpace: 'nowrap', textShadow: hi && L.pack.bg === 'grid' ? `0 0 ${14 * k}px ${L.accent}` : 'none' }}>{fmt(it.value * p, decs(it.value))}{sc.unit ? ' ' + sc.unit : ''}</div>
              <div style={{ width: '100%', height: h, background: fill, borderRadius: `${Math.min(L.pack.radius, 18) * k}px ${Math.min(L.pack.radius, 18) * k}px 0 0`, border: L.pack.card === 'sticker' ? `${4 * k}px solid ${L.text}` : 'none', boxShadow: hi && L.pack.bg === 'grid' ? `0 0 ${26 * k}px ${L.accent}` : 'none' }} />
              <div style={{ position: 'absolute', bottom: -64 * k, fontFamily: `"${L.pack.body}"`, fontWeight: 700, fontSize: 30 * k, color: L.text, width: w + 30 * k, textAlign: 'center' }}>{it.label}</div>
            </div>
          );
        })}
      </div>
      {showBadge ? (
        <div style={L.vert ? { alignSelf: 'center', marginTop: 96 * k, transform: `scale(${badge}) rotate(-4deg)` } : { position: 'absolute', right: L.padX * 0.5, top: '45%', transform: `scale(${badge}) rotate(-4deg)` }}>
          <Card accent style={{ padding: `${14 * k}px ${40 * k}px`, background: L.accent }}>
            <span style={{ fontFamily: `"${L.pack.head}"`, fontWeight: L.pack.hw, fontSize: 52 * k, color: L.onAccent }}>≈ {fmt(r, r < 10 ? 1 : 0)}×</span>
          </Card>
        </div>
      ) : null}
      <Body text={sc.sub} size={30} delay={1.4} style={{ marginTop: 30 * k }} />
    </Stack>
  );
};

const List = ({ sc, numbered }) => {
  const L = useL(), f = useCurrentFrame(), { fps } = useVideoConfig(), k = L.k;
  const n = sc.items.length, st = Math.min(0.5, (sc.sec * 0.55) / n);
  const cardText = L.pack.card === 'flat' || L.pack.card === 'sticker' ? L.text : L.text;
  return (
    <Stack justify="flex-start">
      <Headline text={sc.title || (numbered ? 'Langkahnya' : 'Poin penting')} size={L.vert ? 60 : 50} align={L.pack.bg === 'blocks' ? 'left' : 'center'} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: (L.vert ? 22 : 14) * k, marginTop: (L.vert ? 60 : 36) * k }}>
        {sc.items.map((it, i) => {
          const d = Math.round((Math.min(0.5, sc.sec * 0.12) + i * st) * fps);
          const s = spring({ frame: f - d, fps, config: { damping: L.pack.enter === 'wobble' ? 8 : 15 } });
          const enter = L.pack.trans === 'wipe' ? `translateY(${(1 - s) * 30 * k}px)` : L.pack.trans === 'zoom' ? `scale(${0.6 + 0.4 * s}) rotate(${(1 - s) * (i % 2 ? 4 : -4)}deg)` : `translateX(${(1 - s) * 120 * k}px)`;
          return (
            <div key={i} style={{ opacity: Math.min(1, s * 1.4), transform: enter }}>
              <Card style={{ display: 'flex', alignItems: 'center', gap: 26 * k, padding: `${(L.vert ? 24 : 16) * k}px ${28 * k}px` }}>
                <div style={{ flex: 'none', width: 64 * k, height: 64 * k, borderRadius: L.pack.radius ? '50%' : 0, background: L.accent, color: L.onAccent, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: `"${L.pack.head}"`, fontWeight: 900, fontSize: 34 * k, boxShadow: L.pack.bg === 'grid' ? `0 0 ${14 * k}px ${L.accent}` : 'none' }}>{numbered ? i + 1 : '✓'}</div>
                <div style={{ fontFamily: `"${L.pack.body}"`, fontWeight: 700, fontSize: (it.length > 34 ? 32 : 38) * k, lineHeight: 1.2, color: cardText }}>{it}</div>
              </Card>
            </div>
          );
        })}
      </div>
    </Stack>
  );
};
T.bullets = ({ sc }) => <List sc={sc} />;
T.steps = ({ sc }) => <List sc={sc} numbered />;

T.quote = ({ sc }) => {
  const L = useL(), f = useCurrentFrame(), { fps } = useVideoConfig(), k = L.k;
  const q = spring({ frame: f, fps, config: { damping: 12 } });
  return (
    <Stack>
      <div style={{ fontFamily: '"Playfair Display"', fontWeight: 800, fontSize: 300 * k, lineHeight: 0.6, color: L.accent, textAlign: L.pack.bg === 'blocks' ? 'left' : 'center', transform: `scale(${q})`, textShadow: L.pack.bg === 'grid' ? `0 0 ${24 * k}px ${L.accent}` : 'none' }}>“</div>
      <Headline text={sc.text} size={L.vert ? 52 : 44} delay={0.3} align={L.pack.bg === 'blocks' ? 'left' : 'center'} style={{ fontWeight: L.pack.head === 'Playfair Display' ? 700 : 600, textTransform: 'none', fontStyle: L.pack.head === 'Playfair Display' ? 'italic' : 'normal' }} />
      <Body text={sc.author ? '— ' + sc.author : ''} size={32} delay={1} color={L.accent} align={L.pack.bg === 'blocks' ? 'left' : 'center'} style={{ marginTop: 30 * k }} />
    </Stack>
  );
};

T.countdown = ({ sc }) => {
  const L = useL(), f = useCurrentFrame(), { fps } = useVideoConfig(), k = L.k;
  const step = Math.max(0.5, (sc.sec - 0.6) / sc.from) * fps, i = Math.min(sc.from - 1, Math.floor(f / step)), fr = (f - i * step) / step;
  const R = (L.vert ? 210 : 170) * k, C = 2 * Math.PI * R;
  const s = spring({ frame: f - i * step, fps, config: { damping: 10 } });
  return (
    <Stack>
      <div style={{ position: 'relative', width: R * 2 + 40 * k, height: R * 2 + 40 * k, alignSelf: 'center' }}>
        <svg width={R * 2 + 40 * k} height={R * 2 + 40 * k} style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)' }}>
          <circle cx={R + 20 * k} cy={R + 20 * k} r={R} stroke={alpha(L.text, 0.15)} strokeWidth={18 * k} fill="none" />
          <circle cx={R + 20 * k} cy={R + 20 * k} r={R} stroke={L.accent} strokeWidth={18 * k} fill="none" strokeLinecap={L.pack.radius ? 'round' : 'butt'} strokeDasharray={C} strokeDashoffset={C * fr} style={{ filter: L.pack.bg === 'grid' ? `drop-shadow(0 0 ${10 * k}px ${L.accent})` : 'none' }} />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: `"${L.pack.head}"`, fontWeight: L.pack.hw, fontSize: 240 * k, color: L.text, transform: `scale(${0.6 + 0.4 * s})` }}>{sc.from - i}</div>
      </div>
      <Body text={sc.label} size={44} delay={0.2} style={{ marginTop: 50 * k }} />
    </Stack>
  );
};

T.versus = ({ sc }) => {
  const L = useL(), f = useCurrentFrame(), { fps } = useVideoConfig(), k = L.k;
  const q = Math.min(1, sc.sec / 5);
  const col = (side, j) => {
    const s = spring({ frame: f - Math.round((0.3 + j * 0.3) * q * fps), fps, config: { damping: 14 } });
    return (
      <div style={{ flex: 1, opacity: s, transform: `translateY(${(1 - s) * 60 * k}px)` }}>
        <Card accent={j === 1} style={{ height: '100%', padding: `${30 * k}px ${22 * k}px` }}>
          <div style={{ fontFamily: `"${L.pack.head}"`, fontWeight: L.pack.hw, fontSize: 38 * k, color: j ? L.accent : L.text, textAlign: 'center', textTransform: 'uppercase', marginBottom: 26 * k }}>{side.label}</div>
          {side.items.map((it, i) => {
            const a = interpolate(f - Math.round((0.8 + j * 0.3 + i * 0.3) * q * fps), [0, 10], [0, 1], clamp);
            return <div key={i} style={{ display: 'flex', gap: 14 * k, opacity: a, marginBottom: 22 * k, fontFamily: `"${L.pack.body}"`, fontWeight: 600, fontSize: 29 * k, lineHeight: 1.25, color: L.text }}><span style={{ color: j ? L.accent : alpha(L.text, 0.6), fontWeight: 900 }}>{j ? '✓' : '✗'}</span><span>{it}</span></div>;
          })}
        </Card>
      </div>
    );
  };
  const vs = spring({ frame: f - Math.round(0.7 * fps), fps, config: { damping: 8 } });
  return (
    <Stack justify="flex-start">
      <Headline text={sc.title || `${sc.left.label} vs ${sc.right.label}`} size={L.vert ? 54 : 46} />
      <div style={{ display: 'flex', gap: 24 * k, marginTop: 50 * k, flex: 1, position: 'relative' }}>
        {col(sc.left, 0)}{col(sc.right, 1)}
        <div style={{ position: 'absolute', left: '50%', top: '45%', width: 100 * k, height: 100 * k, marginLeft: -50 * k, borderRadius: L.pack.radius ? '50%' : 0, background: L.bg1, border: `${5 * k}px solid ${L.accent}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: `"${L.pack.head}"`, fontWeight: 900, fontSize: 36 * k, color: L.accent, transform: `scale(${vs})` }}>VS</div>
      </div>
    </Stack>
  );
};

T.image = ({ sc, imageUrl }) => {
  const L = useL(), f = useCurrentFrame(), { fps } = useVideoConfig(), k = L.k;
  const s = spring({ frame: f, fps, config: { damping: 13 } });
  const z = interpolate(f, [0, sc.sec * fps], [1, 1.08], clamp);
  const src = imageUrl || sc.mediaSrc;
  const p = L.pack;
  const tilt = p.card === 'glass' ? -3 : p.card === 'sticker' ? 3 : 0;
  const size = L.vert ? L.W - 2 * L.padX - 40 * k : L.H * 0.62;
  const frame = {
    glass: { borderRadius: 32 * k, boxShadow: `0 ${30 * k}px ${60 * k}px rgba(0,0,0,0.5)`, border: `${10 * k}px solid #ffffff` },
    flat: { borderRadius: 16 * k, boxShadow: `0 ${16 * k}px ${40 * k}px rgba(0,0,0,0.12)` },
    outline: { borderRadius: 8 * k, border: `${3 * k}px solid ${L.accent}`, boxShadow: `0 0 ${30 * k}px ${L.accent}` },
    rule: { borderRadius: 0 },
    sticker: { borderRadius: 12 * k, border: `${14 * k}px solid #ffffff`, borderBottomWidth: 60 * k, boxShadow: `0 ${10 * k}px 0 ${L.text}` },
  }[p.card];
  const pic = (
    <div style={{ width: size, height: L.vert ? size : size, overflow: 'hidden', transform: `rotate(${tilt * s}deg) scale(${0.8 + 0.2 * s})`, opacity: s, background: alpha(L.text, 0.1), flex: 'none', ...frame }}>
      {src ? <Img src={src} style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${z})` }} /> : <div style={{ width: '100%', height: '100%', background: `linear-gradient(135deg, ${L.accent}, ${L.bg2})`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 140 * k, color: '#fff' }}>✦</div>}
    </div>
  );
  if (!L.vert) {
    return (
      <Stack style={{ flexDirection: 'row', alignItems: 'center', gap: 60 * k }}>
        {pic}
        <div style={{ flex: 1 }}><Headline text={sc.title} size={56} align="left" delay={0.3} /><Body text={sc.sub} size={32} align="left" delay={0.8} style={{ marginTop: 20 * k }} /></div>
      </Stack>
    );
  }
  return (
    <Stack justify="flex-start" style={{ alignItems: 'center' }}>
      {pic}
      <div style={{ marginTop: 50 * k, width: '100%' }}><Headline text={sc.title} size={60} delay={0.3} /><Body text={sc.sub} size={34} delay={0.8} style={{ marginTop: 16 * k }} /></div>
    </Stack>
  );
};

T.price = ({ sc }) => {
  const L = useL(), f = useCurrentFrame(), { fps } = useVideoConfig(), k = L.k;
  const s = spring({ frame: f - 8, fps, config: { damping: 9 } }), s2 = spring({ frame: f - 14, fps, config: { damping: 10 } });
  const R = (L.vert ? 250 : 190) * k;
  const pts = Array.from({ length: 32 }, (_, i) => { const r = i % 2 ? R * 0.87 : R, a = (i / 32) * Math.PI * 2; return `${R + Math.cos(a) * r},${R + Math.sin(a) * r}`; }).join(' ');
  const pulse = 1 + Math.sin((f / fps) * 7) * 0.025;
  const shape = L.pack.bg === 'blocks' || L.pack.bg === 'paper'
    ? <div style={{ width: R * 2, height: R * 1.2, background: L.accent, borderRadius: L.pack.radius * k }} />
    : <svg width={R * 2} height={R * 2} style={{ transform: `rotate(${(f / fps) * 20}deg)`, filter: L.pack.bg === 'grid' ? `drop-shadow(0 0 ${20 * k}px ${L.accent})` : 'none' }}><polygon points={pts} fill={L.accent} stroke={L.pack.card === 'sticker' ? L.text : 'none'} strokeWidth={6 * k} /></svg>;
  const fs = Math.min(96, 1400 / Math.max(6, sc.price.length)) * k;
  return (
    <Stack>
      <Headline text={sc.title || 'Harga spesial'} size={L.vert ? 60 : 50} />
      <div style={{ position: 'relative', alignSelf: 'center', marginTop: 40 * k, transform: `scale(${s})`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {shape}
        <div style={{ position: 'absolute', textAlign: 'center', transform: `scale(${s2 * pulse})` }}>
          {sc.old ? <div style={{ fontFamily: `"${L.pack.body}"`, fontWeight: 600, fontSize: 36 * k, color: L.onAccent, opacity: 0.7, textDecoration: 'line-through' }}>{sc.old}</div> : null}
          <div style={{ fontFamily: `"${L.pack.head}"`, fontWeight: L.pack.hw, fontSize: fs, color: L.onAccent, whiteSpace: 'nowrap' }}>{sc.price}</div>
        </div>
      </div>
      <Body text={sc.sub} size={36} delay={0.8} style={{ marginTop: 40 * k }} />
    </Stack>
  );
};

T.cta = ({ sc, brand }) => {
  const L = useL(), f = useCurrentFrame(), { fps } = useVideoConfig(), k = L.k;
  const s = spring({ frame: f - 14, fps, config: { damping: 11 } });
  const pulse = 1 + Math.sin((f / fps) * 6) * 0.04;
  const label = (sc.sub || brand || 'FOLLOW').slice(0, 22);
  return (
    <Stack>
      <Headline text={sc.title || 'Follow untuk info berikutnya!'} size={L.vert ? 70 : 58} accentLast />
      <div style={{ alignSelf: 'center', marginTop: (L.vert ? 80 : 50) * k, transform: `scale(${s * pulse})` }}>
        <div style={{ background: L.accent, color: L.onAccent, padding: `${26 * k}px ${56 * k}px`, borderRadius: L.pack.radius ? 99 : 0, fontFamily: `"${L.pack.head}"`, fontWeight: L.pack.hw, fontSize: 42 * k, boxShadow: L.pack.bg === 'grid' ? `0 0 ${30 * k}px ${L.accent}` : L.pack.card === 'sticker' ? `0 ${8 * k}px 0 ${L.text}` : `0 ${14 * k}px ${30 * k}px rgba(0,0,0,0.25)`, border: L.pack.card === 'sticker' ? `${4 * k}px solid ${L.text}` : 'none', whiteSpace: 'nowrap' }}>
          {label} {L.pack.bg === 'blocks' ? '→' : '➜'}
        </div>
      </div>
      {L.pack.bg === 'confetti' || L.pack.bg === 'blobs' ? <div style={{ alignSelf: 'center', fontSize: 90 * k, marginTop: 20 * k, marginLeft: 260 * k, transform: `translateY(${Math.sin((f / fps) * 8) * 12 * k}px)`, opacity: s }}>👆</div> : null}
    </Stack>
  );
};

/* ------------------------------------------------------------ transisi antar-adegan */
function Transition({ children, sec, last, index }) {
  const L = useL(), f = useCurrentFrame(), { fps } = useVideoConfig(), dur = sec * fps;
  const tin = interpolate(f, [0, 10], [0, 1], clamp), tout = last ? 0 : interpolate(f, [dur - 8, dur], [0, 1], clamp);
  let style = {};
  switch (L.pack.trans) {
    case 'slide': style = { transform: `translateX(${(1 - tin) * 8 - tout * 8}%)`, opacity: Math.min(tin, 1 - tout) }; break;
    case 'fade': style = { opacity: Math.min(tin, 1 - tout), transform: `scale(${0.985 + 0.015 * tin})` }; break;
    case 'glitch': {
      const g = f < 7 || (!last && f > dur - 6);
      const j = g ? (random(`t${index}-${f}`) - 0.5) * 50 * L.k : 0;
      style = { transform: `translateX(${j}px)`, opacity: g && random(`o${index}-${f}`) > 0.7 ? 0.3 : 1, filter: g ? `hue-rotate(${random(`h${f}`) * 90}deg)` : 'none' };
      break;
    }
    case 'wipe': style = { clipPath: `inset(0 ${(1 - tin) * 100}% 0 0)`, opacity: 1 - tout }; break;
    case 'zoom': { const s = spring({ frame: f, fps, config: { damping: 12 } }); style = { transform: `scale(${(0.8 + 0.2 * s) * (1 + tout * 0.12)})`, opacity: Math.min(1, tin * 1.5) * (1 - tout) }; break; }
    default: break;
  }
  return <AbsoluteFill style={style}>{children}</AbsoluteFill>;
}

/* ------------------------------------------------------------ bingkai: progres & brand */
function Chrome({ sb, starts }) {
  const L = useL(), f = useCurrentFrame(), k = L.k, t = f / FPS;
  const total = totalSeconds(sb), n = sb.scenes.length;
  let si = 0; while (si < n - 1 && t >= starts[si + 1]) si++;
  const p = L.pack;
  const brandStyle = { fontFamily: `"${p.body}"`, fontWeight: 700, fontSize: 26 * k, color: L.text, opacity: 0.9 };
  let bar = null;
  if (p.progress === 'stories') {
    const gw = (L.W - 60 * k - (n - 1) * 8 * k) / n;
    bar = sb.scenes.map((x, i) => {
      const fill = i < si ? 1 : i > si ? 0 : Math.min(1, (t - starts[i]) / x.sec);
      return <div key={i} style={{ position: 'absolute', left: 30 * k + i * (gw + 8 * k), top: 30 * k, width: gw, height: 7 * k, borderRadius: 4 * k, background: alpha(L.text, 0.25), overflow: 'hidden' }}><div style={{ width: `${fill * 100}%`, height: '100%', background: p.bg === 'grid' ? L.accent : L.text, boxShadow: p.bg === 'grid' ? `0 0 ${8 * k}px ${L.accent}` : 'none' }} /></div>;
    });
  } else if (p.progress === 'line') {
    bar = <div style={{ position: 'absolute', left: 0, top: 0, height: 5 * k, width: `${(t / total) * 100}%`, background: L.accent }} />;
  } else if (p.progress === 'folio') {
    bar = <div style={{ position: 'absolute', right: 40 * k, top: 40 * k, fontFamily: '"Playfair Display"', fontWeight: 700, fontStyle: 'italic', fontSize: 28 * k, color: L.text }}>{String(si + 1).padStart(2, '0')} / {String(n).padStart(2, '0')}</div>;
  } else {
    bar = <div style={{ position: 'absolute', left: 0, right: 0, top: 34 * k, display: 'flex', justifyContent: 'center', gap: 12 * k }}>{sb.scenes.map((_, i) => <div key={i} style={{ width: (i === si ? 34 : 14) * k, height: 14 * k, borderRadius: 99, background: i <= si ? L.accent : alpha(L.text, 0.25) }} />)}</div>;
  }
  const brand = p.progress === 'folio'
    ? <div style={{ position: 'absolute', left: 50 * k, top: 34 * k, fontFamily: '"Playfair Display"', fontWeight: 800, fontSize: 32 * k, color: L.text, borderBottom: `${3 * k}px solid ${L.text}`, paddingBottom: 4 * k }}>{sb.brand}</div>
    : <div style={{ position: 'absolute', left: 34 * k, top: (p.progress === 'line' ? 34 : 56) * k, ...brandStyle }}>{p.progress === 'dots' ? '' : '● '}{sb.brand}</div>;
  // di atas media layar penuh, teks bingkai selalu putih
  const sc = sb.scenes[si], onMedia = sc && sc.mediaSrc && (sc.t === 'media' || sc.t === 'title');
  return <AbsoluteFill style={onMedia ? { filter: 'brightness(0) invert(1)' } : {}}>{bar}{p.progress === 'dots' ? <div style={{ position: 'absolute', left: 0, right: 0, top: 66 * k, textAlign: 'center', ...brandStyle }}>{sb.brand}</div> : brand}</AbsoluteFill>;
}

/* ------------------------------------------------------------ subtitle kata per kata */
function Captions({ words }) {
  const L = useL(), f = useCurrentFrame(), t = f / FPS, k = L.k, p = L.pack;
  // kelompokkan 3–4 kata (putus di tanda baca)
  const groups = React.useMemo(() => {
    const out = []; let cur = [];
    words.forEach((w, i) => {
      cur.push(w);
      const next = words[i + 1];
      if (cur.length >= 4 || /[.,!?;:]$/.test(w.text) || !next || next.t0 - w.t1 > 0.35) { out.push(cur); cur = []; }
    });
    return out;
  }, [words]);
  const g = groups.find((x) => t >= x[0].t0 - 0.05 && t <= x[x.length - 1].t1 + 0.15);
  if (!g) return null;
  const pop = spring({ frame: f - Math.round(g[0].t0 * FPS), fps: FPS, config: { damping: 14, stiffness: 220 } });
  const box = {
    stroke: { color: '#ffffff', WebkitTextStroke: `${7 * k}px #000`, paintOrder: 'stroke fill', textTransform: 'uppercase', fontFamily: '"Montserrat"', fontWeight: 900 },
    pill: { color: '#111', background: '#ffffff', padding: `${10 * k}px ${22 * k}px`, borderRadius: 14 * k, boxShadow: `0 ${6 * k}px ${20 * k}px rgba(0,0,0,0.12)`, fontFamily: '"Inter"', fontWeight: 700 },
    glow: { color: '#ffffff', textShadow: `0 0 ${10 * k}px ${L.accent}, 0 0 ${24 * k}px ${L.accent}`, textTransform: 'uppercase', fontFamily: '"Space Grotesk"', fontWeight: 700 },
    bar: { color: L.bg1, background: L.text, padding: `${8 * k}px ${20 * k}px`, fontFamily: '"Playfair Display"', fontWeight: 700, fontStyle: 'italic' },
    bubble: { color: L.text, background: '#ffffff', padding: `${12 * k}px ${26 * k}px`, borderRadius: 40 * k, border: `${4 * k}px solid ${L.text}`, boxShadow: `0 ${6 * k}px 0 ${L.accent}`, fontFamily: '"Fredoka"', fontWeight: 700 },
  }[p.caption];
  const hl = { stroke: L.accent, pill: L.accent === '#111111' ? '#d7263d' : L.accent, glow: L.accent, bar: L.accent, bubble: L.accent }[p.caption];
  return (
    <div style={{ position: 'absolute', left: L.padX * 0.6, right: L.padX * 0.6, bottom: (L.vert ? 190 : 50) * k, display: 'flex', justifyContent: 'center' }}>
      <div style={{ fontSize: (L.vert ? 52 : 44) * k, lineHeight: 1.2, textAlign: 'center', transform: `scale(${0.85 + 0.15 * pop})`, ...box }}>
        {g.map((w, i) => {
          const on = t >= w.t0 && t < w.t1;
          return <span key={i} style={{ color: on ? hl : box.color, display: 'inline-block', marginRight: i < g.length - 1 ? '0.26em' : 0, transform: on && p.caption !== 'bar' ? `translateY(${-3 * k}px)` : 'none' }}>{w.text}</span>;
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ audio */
function Sound({ voice, music, total }) {
  const clips = (voice && voice.src && voice.clips) || [];
  const speaking = (fr) => { const t = fr / FPS; return clips.some((c) => t >= c.at - 0.15 && t <= c.at + (c.to - c.from) + 0.15); };
  const base = (music && music.volume) || (clips.length ? 0.22 : 0.4);
  return (
    <>
      {clips.map((c, i) => (
        <Sequence key={i} from={Math.round(c.at * FPS)} durationInFrames={Math.max(1, Math.round((c.to - c.from) * FPS) + 2)} layout="none">
          <Audio src={voice.src} trimBefore={Math.round(c.from * FPS)} volume={1} />
        </Sequence>
      ))}
      {music && music.src ? (
        <Audio src={music.src} volume={(fr) => {
          const fade = interpolate(fr, [0, 15, total * FPS - 30, total * FPS], [0, 1, 1, 0], clamp);
          return fade * (speaking(fr) ? base * 0.45 : base);
        }} />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------ komposisi utama */
export const Video = ({ sb, imageUrl, voice, words, music }) => {
  const [handle] = useState(() => delayRender('Memuat font'));
  useEffect(() => {
    const done = () => continueRender(handle);
    Promise.all(FONTS.map((x) => document.fonts.load(x).catch(() => null))).then(done, done);
  }, [handle]);
  const caps = Array.isArray(words) && words.length > 0;
  const L = useLook(sb, caps);
  const starts = []; let acc = 0;
  for (const x of sb.scenes) { starts.push(acc); acc += x.sec; }
  const total = acc;
  return (
    <LookCtx.Provider value={L}>
      <AbsoluteFill style={{ background: L.bg1 }}>
        {sb.scenes.map((sc, i) => {
          const Tpl = T[sc.t] || T.title;
          return (
            <Sequence key={i} from={Math.round(starts[i] * FPS)} durationInFrames={Math.max(1, Math.round(sc.sec * FPS))}>
              <Background sceneIndex={i} start={Math.round(starts[i] * FPS)} />
              <Transition sec={sc.sec} last={i === sb.scenes.length - 1} index={i}>
                <Tpl sc={sc} imageUrl={imageUrl} brand={sb.brand} />
              </Transition>
            </Sequence>
          );
        })}
        <Chrome sb={sb} starts={starts} />
        {caps ? <Captions words={words} /> : null}
        <Sound voice={voice} music={music} total={total} />
      </AbsoluteFill>
    </LookCtx.Provider>
  );
};

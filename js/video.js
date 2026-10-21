/* =========================================================================
 * video.js — PROGRAMMATIC VIDEO: video dibuat dari kode, bukan diedit manual.
 *
 *  1. Boss memberi tugas video ke divisi Sosmed (mis. "buat video penjelasan biaya listrik AI").
 *  2. Tim mengerjakan seperti tugas biasa (animasi kantor), lalu AI menyusun NASKAH TERSTRUKTUR
 *     (storyboard JSON): tiap adegan memakai satu TEMPLATE + isinya (judul, angka, poin).
 *  3. Render:
 *     · SERVER VIDEO (Remotion di VPS, bila worker aktif): 5 paket visual, narasi suara + subtitle
 *       kata per kata, musik latar, foto/video stok (Pixabay / Pexels) — lihat remotion/ & lib/render.js
 *     · cadangan: template digambar di <canvas> lalu di-encode MP4 di browser (WebCodecs + mp4-muxer)
 *  4. Hasil masuk Galeri (+ jadwal tayang YouTube / TikTok / IG …) dan bisa dikirim ke Telegram.
 *
 * Naskah, template & paket visual: js/videoboard.js (dipakai juga oleh server & worker).
 * Format: 9:16 (TikTok/Reels/Shorts) atau 16:9 (YouTube).
 * ========================================================================= */
(function () {
  const VO = window.VO;
  const V = (VO.video = { busy: false, queue: [] });
  const FPS = 30;
  const FONT = "system-ui, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
  const SIZES = { '9:16': [720, 1280], '16:9': [1280, 720] };

  const B = VO.videoBoard; // naskah bersama (js/videoboard.js): template, gaya, paket visual, prompt AI
  V.TEMPLATES = B.TEMPLATES;
  V.STYLES = B.STYLES;
  V.PACKS = B.PACKS;
  V.isRequest = B.isRequest;
  V.supported = () => typeof VideoEncoder !== 'undefined' || (typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream);

  /** Naskah terstruktur dari AI (bila Mode AI aktif). context = laporan tim (riset/naskah kasar). */
  V.storyboard = async function (o, context) {
    const s = VO.app.state;
    o = { brand: s.company.name || 'Visual Office', ...o };
    if (!(s.settings.aiMode && VO.ai.available)) return B.fallback(o);
    const { system, prompt } = B.prompt(o, context);
    try { return B.parse(await VO.ai.run({ model: s.boss.model, system, prompt, long: true }), o); }
    catch (e) { return B.fallback(o); }
  };

  /* ------------------------------------------------------------ server video (Remotion di VPS) */
  // status worker: { configured, worker (aktif?), pexels, tts } — disimpan sebentar agar tidak dipanggil terus
  let engineCache = null;
  V.engine = async function (fresh) {
    if (!fresh && engineCache && Date.now() - engineCache.t < 20000) return engineCache.v;
    let v = { worker: false };
    try { const r = await fetch('/api/office?render=status', { cache: 'no-store' }); if (r.ok) v = await r.json(); } catch (e) { /* offline */ }
    engineCache = { t: Date.now(), v };
    return v;
  };
  async function renderOnServer(item, sb, o, who) {
    // semua aset Boss (foto/video) diunggah dulu → worker mengunduhnya dari penyimpanan
    const assets = [];
    for (const [i, f] of (o.files || []).entries()) {
      item.stage = 'upload'; VO.app.changed();
      const ext = (/\.(\w{2,5})$/.exec(f.name || '') || [, /video/.test(f.type) ? 'mp4' : 'jpg'])[1].toLowerCase();
      const up = await VO.files.upload(f, `aset-${i + 1}.${ext}`);
      if (up.localOnly) throw new Error('Aset video butuh penyimpanan cloud (Vercel Blob) agar bisa dipakai server video');
      assets.push({ url: up.url, type: up.type });
    }
    const r = await fetch('/api/office?render=enqueue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sb, format: o.format, assets, telegram: o.telegram, itemId: item.id }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Antrean render: HTTP ' + r.status);
    item.jobId = j.id; item.engine = 'remotion'; VO.app.changed();
    const STAGE = { antre: 'antre', mulai: 'render', media: 'media', narasi: 'narasi', kode: 'kode', render: 'render', upload: 'upload' };
    let lastP = -1;
    for (;;) {
      await new Promise((res) => setTimeout(res, 3000));
      let job;
      try { const q = await fetch('/api/office?render=job&id=' + encodeURIComponent(j.id), { cache: 'no-store' }); job = await q.json(); if (!q.ok) throw new Error(job.error); }
      catch (e) { continue; } // jaringan putus sesaat
      if (job.status === 'failed') throw new Error(job.error || 'Render di server gagal');
      item.progress = job.progress || 0; item.stage = STAGE[job.stage] || 'render';
      const p = Math.round(item.progress * 100);
      if (job.status === 'rendering' && p >= lastP + 25) { lastP = p; VO.sim.say(who, `🎬 Server video: ${item.stage} ${p}%`, 3); }
      VO.app.changed();
      if (job.status === 'done') return job;
    }
  }

  /* ------------------------------------------------------------ gambar */
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const ease = (x) => 1 - Math.pow(1 - clamp01(x), 3);
  const back = (x) => { x = clamp01(x); const c = 1.7; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
  const fmt = (v, d = 0) => Number(v).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d });
  function wrap(ctx, text, maxW) {
    const words = String(text || '').split(/\s+/).filter(Boolean); const lines = []; let cur = '';
    for (const w of words) { const t = cur ? cur + ' ' + w : w; if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; }
    if (cur) lines.push(cur);
    return lines;
  }
  function rr(ctx, x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  const font = (w, px) => `${w} ${Math.round(px)}px ${FONT}`;

  // Konteks gambar per frame: ukuran, skala, area konten
  function frameCtx(ctx, W, H) {
    const vert = H > W, k = Math.min(W, H) / 720;
    return { ctx, W, H, vert, k, cx: W / 2, cw: vert ? W - 110 : W * 0.7, top: vert ? 150 * k : 90 * k, bottom: H - (vert ? 140 : 70) * k };
  }
  // judul: kata per kata muncul
  function headline(F, P, text, y, lt, size, opt = {}) {
    const { ctx, cx, cw } = F;
    ctx.font = font(800, size); ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const lines = wrap(ctx, text, opt.maxW || cw); const lh = size * 1.13;
    const y0 = opt.top ? y + size : y - ((lines.length - 1) * lh) / 2; let k = 0;
    lines.forEach((ln, li) => {
      const words = ln.split(' '); let x = cx - ctx.measureText(ln).width / 2;
      for (const w of words) {
        const ww = ctx.measureText(w).width, d = (opt.delay || 0.1) + k * 0.06, a = ease((lt - d) / 0.3), s = 0.65 + 0.35 * back((lt - d) / 0.4);
        ctx.save(); ctx.globalAlpha *= a; ctx.translate(x + ww / 2, y0 + li * lh); ctx.scale(s, s);
        ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillText(w, 2, 4); ctx.fillStyle = opt.color || P.text; ctx.fillText(w, 0, 0); ctx.restore();
        x += ww + ctx.measureText(' ').width; k++;
      }
    });
    return { bottom: y0 + (lines.length - 1) * lh + size * 0.3, lines: lines.length };
  }
  function para(F, P, text, y, lt, size, delay = 0.45, alpha = 0.9) {
    if (!text) return y;
    const { ctx, cx, cw } = F;
    ctx.font = font(600, size); ctx.textAlign = 'center';
    const a = ease((lt - delay) / 0.4); const lines = wrap(ctx, text, cw);
    ctx.save(); ctx.globalAlpha *= a * alpha; ctx.fillStyle = P.text;
    lines.forEach((ln, i) => ctx.fillText(ln, cx, y + (1 - a) * 18 + i * size * 1.3));
    ctx.restore();
    return y + lines.length * size * 1.3;
  }
  function kicker(F, P, text, y, lt) {
    if (!text) return;
    const { ctx, cx, k } = F;
    ctx.font = font(800, 26 * k); const w = ctx.measureText(text.toUpperCase()).width + 40 * k;
    ctx.save(); ctx.globalAlpha *= ease(lt / 0.3); ctx.fillStyle = P.accent; rr(ctx, cx - w / 2, y - 34 * k, w, 48 * k, 24 * k); ctx.fill();
    ctx.fillStyle = P.bg1; ctx.textAlign = 'center'; ctx.fillText(text.toUpperCase(), cx, y); ctx.restore();
  }

  const T = {}; // fungsi gambar per template: (F, P, sc, lt, img)
  T.title = (F, P, sc, lt) => {
    const { k, H, ctx } = F;
    const size = (F.vert ? 86 : 74) * k;
    ctx.font = font(800, size);
    const n = wrap(ctx, sc.title, F.cw).length, cy = H * 0.46;
    kicker(F, P, sc.kicker, cy - ((n - 1) * size * 1.13) / 2 - size - 30 * k, lt);
    const h = headline(F, P, sc.title, cy, lt, size);
    const w = F.cw * 0.4 * ease((lt - 0.5) / 0.4);
    F.ctx.fillStyle = P.accent; rr(F.ctx, F.cx - w / 2, h.bottom + 20 * k, w, 10 * k, 5 * k); F.ctx.fill();
    para(F, P, sc.sub, h.bottom + 90 * k, lt, 38 * k);
  };
  T.stat = (F, P, sc, lt) => {
    const { ctx, k, cx, H } = F;
    if (sc.title) headline(F, P, sc.title, F.top + 30 * k, lt, 52 * k, { top: true });
    const p = ease((lt - 0.2) / 1.2), v = sc.value * p;
    const txt = (sc.prefix || '') + fmt(v, sc.decimals || 0);
    let fs = (F.vert ? 190 : 170) * k; ctx.font = font(900, fs);
    const unitFs = fs * 0.36;
    while (ctx.measureText(txt).width > F.cw * 0.9 && fs > 60) { fs -= 6; ctx.font = font(900, fs); }
    const y = H * 0.5 + fs * 0.32, s = 0.85 + 0.15 * back((lt - 0.1) / 0.5);
    ctx.save(); ctx.translate(cx, y); ctx.scale(s, s); ctx.textAlign = 'center';
    ctx.shadowColor = P.accent; ctx.shadowBlur = 40 * k; ctx.fillStyle = P.accent; ctx.fillText(txt, 0, 0); ctx.shadowBlur = 0;
    if (sc.unit) { ctx.font = font(800, unitFs); ctx.fillStyle = P.text; ctx.fillText(sc.unit, 0, unitFs * 1.35); }
    ctx.restore();
    para(F, P, sc.label, y + (sc.unit ? unitFs * 2.2 : 70 * k), lt, 40 * k, 0.9);
  };
  T.compare = (F, P, sc, lt) => {
    const { ctx, k, cx, H } = F;
    const h = headline(F, P, sc.title || 'Perbandingan', F.top + 20 * k, lt, (F.vert ? 60 : 50) * k, { top: true });
    const n = sc.items.length, max = Math.max(...sc.items.map((i) => i.value), 1e-9);
    const chartTop = h.bottom + (F.vert ? 120 : 100) * k, chartBot = F.bottom - (F.vert ? 230 : 120) * k, chH = chartBot - chartTop;
    const gap = 40 * k, bw = Math.min(170 * k, (F.cw - gap * (n - 1)) / n), x0 = cx - (n * bw + (n - 1) * gap) / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 3 * k; ctx.beginPath(); ctx.moveTo(x0 - 20 * k, chartBot); ctx.lineTo(x0 + n * bw + (n - 1) * gap + 20 * k, chartBot); ctx.stroke();
    const st = Math.min(0.25, (sc.sec * 0.3) / n), dur = Math.min(0.9, sc.sec * 0.3);
    sc.items.forEach((it, i) => {
      const d = Math.min(0.35, sc.sec * 0.1) + i * st, p = ease((lt - d) / dur), bh = Math.max(4 * k, (it.value / max) * chH * p), x = x0 + i * (bw + gap), hi = i === sc.highlight;
      const g = ctx.createLinearGradient(0, chartBot - bh, 0, chartBot);
      g.addColorStop(0, hi ? P.accent : 'rgba(255,255,255,0.75)'); g.addColorStop(1, hi ? P.accent + 'aa' : 'rgba(255,255,255,0.35)');
      ctx.fillStyle = g; rr(ctx, x, chartBot - bh, bw, bh, 14 * k); ctx.fill();
      ctx.textAlign = 'center';
      ctx.font = font(900, 46 * k); ctx.fillStyle = hi ? P.accent : P.text; ctx.globalAlpha = ease((lt - d) / 0.4);
      const dec = String(it.value).includes('.') ? Math.min(2, String(it.value).split('.')[1].length) : 0;
      ctx.fillText(fmt(it.value * p, dec) + (sc.unit ? ' ' + sc.unit : ''), x + bw / 2, chartBot - bh - 22 * k);
      ctx.font = font(700, 32 * k); ctx.fillStyle = P.text; ctx.fillText(it.label, x + bw / 2, chartBot + 48 * k);
      if (it.note) { ctx.font = font(500, 24 * k); ctx.globalAlpha *= 0.75; ctx.fillText(it.note, x + bw / 2, chartBot + 84 * k); }
      ctx.globalAlpha = 1;
    });
    // badge rasio (mis. "≈ 9,7×") untuk 2 nilai
    if (n === 2) {
      const a = sc.items[0].value, b = sc.items[1].value, r = Math.max(a, b) / Math.max(1e-9, Math.min(a, b));
      if (isFinite(r) && r >= 1.5) {
        const p = back((lt - Math.min(1.5, sc.sec * 0.55)) / 0.5);
        // badge di bawah grafik (9:16) / di kanan grafik (16:9) agar tidak menutupi angka batang
        const bx = F.vert ? cx : Math.min(F.W - 170 * k, x0 + n * bw + (n - 1) * gap + 190 * k), by = F.vert ? chartBot + 160 * k : (chartTop + chartBot) / 2;
        ctx.save(); ctx.translate(bx, by); ctx.scale(p, p); ctx.rotate(-0.06);
        ctx.fillStyle = P.accent; rr(ctx, -150 * k, -48 * k, 300 * k, 90 * k, 45 * k); ctx.fill();
        ctx.fillStyle = P.bg1; ctx.font = font(900, 52 * k); ctx.textAlign = 'center'; ctx.fillText('≈ ' + fmt(r, r < 10 ? 1 : 0) + '×', 0, 16 * k); ctx.restore();
      }
    }
    para(F, P, sc.sub, F.bottom + (F.vert ? 50 : 30) * k, lt, 30 * k, 1.4, 0.8);
  };
  const listT = (numbered) => (F, P, sc, lt) => {
    const { ctx, k, W } = F;
    const h = headline(F, P, sc.title || (numbered ? 'Langkahnya' : 'Poin penting'), F.top + 20 * k, lt, (F.vert ? 62 : 52) * k, { top: true });
    const n = sc.items.length, rowH = Math.min((F.vert ? 170 : 100) * k, (F.bottom - h.bottom - 60 * k) / n), x0 = F.vert ? 55 : W * 0.15, w = F.vert ? W - 110 : W * 0.7;
    const st = Math.min(0.5, (sc.sec * 0.55) / n);
    sc.items.forEach((it, i) => {
      const d = Math.min(0.5, sc.sec * 0.12) + i * st, a = ease((lt - d) / Math.min(0.4, st + 0.1)), y = h.bottom + 60 * k + i * rowH;
      ctx.save(); ctx.globalAlpha *= a; ctx.translate((1 - a) * 100 * k, 0);
      ctx.fillStyle = 'rgba(255,255,255,0.12)'; rr(ctx, x0, y, w, rowH - 22 * k, 26 * k); ctx.fill();
      const cy = y + (rowH - 22 * k) / 2, r = Math.min(36 * k, (rowH - 22 * k) / 2 - 6 * k);
      ctx.fillStyle = P.accent; ctx.beginPath(); ctx.arc(x0 + 30 * k + r, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = P.bg1; ctx.font = font(900, r * 1.15); ctx.textAlign = 'center'; ctx.fillText(numbered ? String(i + 1) : '✓', x0 + 30 * k + r, cy + r * 0.4);
      ctx.fillStyle = P.text; ctx.textAlign = 'left'; let fs = 38 * k; ctx.font = font(700, fs);
      let lines = wrap(ctx, it, w - 2 * r - 80 * k); while (lines.length > 2 && fs > 24 * k) { fs -= 2; ctx.font = font(700, fs); lines = wrap(ctx, it, w - 2 * r - 80 * k); }
      lines.slice(0, 2).forEach((ln, j) => ctx.fillText(ln, x0 + 2 * r + 55 * k, cy + fs * 0.35 + (j - (Math.min(2, lines.length) - 1) / 2) * fs * 1.15));
      ctx.restore();
      if (numbered && i < n - 1) { ctx.globalAlpha = ease((lt - d - 0.3) / 0.3) * 0.5; ctx.fillStyle = P.accent; ctx.fillRect(x0 + 30 * k + r - 2 * k, cy + r, 4 * k, rowH - 2 * r); ctx.globalAlpha = 1; }
    });
  };
  T.bullets = listT(false);
  T.media = (F, P, sc, lt) => T.title(F, P, sc, lt); // foto/video stok hanya di server video
  T.steps = listT(true);
  T.quote = (F, P, sc, lt) => {
    const { ctx, k, cx, H } = F;
    ctx.save(); ctx.globalAlpha = ease(lt / 0.4) * 0.9; ctx.fillStyle = P.accent; ctx.font = font(900, 260 * k); ctx.textAlign = 'center'; ctx.fillText('“', cx, H * 0.33); ctx.restore();
    ctx.font = font(700, (F.vert ? 54 : 46) * k); ctx.textAlign = 'center';
    const lines = wrap(ctx, sc.text, F.cw); const lh = (F.vert ? 54 : 46) * k * 1.3, y0 = H * 0.5 - ((lines.length - 1) * lh) / 2;
    lines.forEach((ln, i) => { ctx.save(); ctx.globalAlpha *= ease((lt - 0.3 - i * 0.25) / 0.4); ctx.fillStyle = P.text; ctx.fillText(ln, cx, y0 + i * lh); ctx.restore(); });
    if (sc.author) { ctx.save(); ctx.globalAlpha *= ease((lt - 0.4 - lines.length * 0.25) / 0.4); ctx.font = font(600, 34 * k); ctx.fillStyle = P.accent; ctx.fillText('— ' + sc.author, cx, y0 + lines.length * lh + 30 * k); ctx.restore(); }
  };
  T.countdown = (F, P, sc, lt) => {
    const { ctx, k, cx, H } = F;
    const step = Math.max(0.5, (sc.sec - 0.6) / sc.from), i = Math.min(sc.from - 1, Math.floor(lt / step)), f = (lt - i * step) / step;
    const n = sc.from - i, R = (F.vert ? 210 : 170) * k, cy = H * 0.47;
    ctx.lineWidth = 18 * k; ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = P.accent; ctx.lineCap = 'round'; ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - f)); ctx.stroke(); ctx.lineCap = 'butt';
    const s = 0.6 + 0.4 * back(f / 0.35);
    ctx.save(); ctx.translate(cx, cy); ctx.scale(s, s); ctx.globalAlpha *= 1 - clamp01((f - 0.8) / 0.2) * 0.6;
    ctx.font = font(900, 240 * k); ctx.textAlign = 'center'; ctx.fillStyle = P.text; ctx.fillText(String(n), 0, 85 * k); ctx.restore();
    para(F, P, sc.label, cy + R + 90 * k, lt, 44 * k, 0.2);
  };
  T.versus = (F, P, sc, lt) => {
    const { ctx, k, cx, W } = F;
    const h = headline(F, P, sc.title || `${sc.left.label} vs ${sc.right.label}`, F.top + 20 * k, lt, (F.vert ? 56 : 48) * k, { top: true });
    const top = h.bottom + 50 * k, bot = F.bottom - 40 * k, gw = 24 * k, w = ((F.vert ? W - 80 * k : W * 0.8) - gw) / 2, x0 = cx - w - gw / 2;
    [[sc.left, 0, 'rgba(255,255,255,0.10)', P.text], [sc.right, 1, P.accent + '33', P.accent]].forEach(([side, j, bg, col]) => {
      const x = x0 + j * (w + gw), q = Math.min(1, sc.sec / 5), a = ease((lt - (0.3 + j * 0.3) * q) / 0.4);
      ctx.save(); ctx.globalAlpha *= a; ctx.translate(0, (1 - a) * 60 * k);
      ctx.fillStyle = bg; rr(ctx, x, top, w, bot - top, 28 * k); ctx.fill();
      ctx.fillStyle = col; ctx.font = font(900, 40 * k); ctx.textAlign = 'center'; ctx.fillText(side.label.toUpperCase(), x + w / 2, top + 64 * k);
      ctx.fillStyle = P.text; ctx.textAlign = 'left';
      let y = top + 130 * k;
      side.items.forEach((it, i) => {
        ctx.save(); ctx.globalAlpha *= ease((lt - (0.8 + j * 0.3 + i * 0.3) * q) / 0.35);
        ctx.font = font(700, 30 * k); const ln = wrap(ctx, it, w - 70 * k).slice(0, 3);
        ctx.fillStyle = col; ctx.fillText(j ? '✓' : '✗', x + 22 * k, y);
        ctx.fillStyle = P.text; ln.forEach((l, q) => ctx.fillText(l, x + 58 * k, y + q * 38 * k));
        ctx.restore(); y += ln.length * 38 * k + 34 * k;
      });
      ctx.restore();
    });
    const p = back((lt - 0.7) / 0.4);
    ctx.save(); ctx.translate(cx, (top + bot) / 2); ctx.scale(p, p); ctx.fillStyle = P.bg1; ctx.beginPath(); ctx.arc(0, 0, 50 * k, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = P.accent; ctx.lineWidth = 5 * k; ctx.stroke(); ctx.fillStyle = P.accent; ctx.font = font(900, 38 * k); ctx.textAlign = 'center'; ctx.fillText('VS', 0, 13 * k); ctx.restore();
  };
  T.image = (F, P, sc, lt, img) => {
    const { ctx, k, cx, H, W } = F;
    const a = ease(lt / 0.5), bw = F.vert ? W - 150 * k : W * 0.42, bh = F.vert ? bw : H * 0.62, bx = F.vert ? cx - bw / 2 : W * 0.08, by = F.vert ? F.top + 60 * k + (1 - a) * 60 * k : (H - bh) / 2;
    ctx.save(); ctx.globalAlpha *= a; ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 50 * k; ctx.shadowOffsetY = 20 * k; ctx.fillStyle = '#fff'; rr(ctx, bx, by, bw, bh, 32 * k); ctx.fill(); ctx.restore();
    ctx.save(); ctx.globalAlpha *= a; rr(ctx, bx + 12 * k, by + 12 * k, bw - 24 * k, bh - 24 * k, 24 * k); ctx.clip();
    if (img) { const z = 1 + lt * 0.035, s0 = Math.max((bw - 24 * k) / img.width, (bh - 24 * k) / img.height) * z; ctx.drawImage(img, bx + bw / 2 - (img.width * s0) / 2, by + bh / 2 - (img.height * s0) / 2, img.width * s0, img.height * s0); }
    else { const g = ctx.createLinearGradient(bx, by, bx + bw, by + bh); g.addColorStop(0, P.accent); g.addColorStop(1, P.bg2); ctx.fillStyle = g; ctx.fillRect(bx, by, bw, bh); ctx.font = font(900, 120 * k); ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.fillText('✦', bx + bw / 2, by + bh / 2 + 40 * k); }
    ctx.restore();
    if (F.vert) { const h = headline(F, P, sc.title, by + bh + 110 * k, lt - 0.3, 62 * k); para(F, P, sc.sub, h.bottom + 60 * k, lt, 36 * k, 0.8); }
    else {
      const F2 = { ...F, cx: W * 0.74, cw: W * 0.4 };
      const h = headline(F2, P, sc.title, H * 0.45, lt - 0.3, 58 * k); para(F2, P, sc.sub, h.bottom + 60 * k, lt, 32 * k, 0.8);
    }
  };
  T.price = (F, P, sc, lt) => {
    const { ctx, k, cx, H } = F;
    const h = headline(F, P, sc.title || 'Harga spesial', F.top + 20 * k, lt, (F.vert ? 62 : 52) * k, { top: true });
    const cy = F.vert ? H * 0.52 : H * 0.58, R = (F.vert ? 250 : 190) * k;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(lt * 0.35); const s = back((lt - 0.3) / 0.5); ctx.scale(s, s);
    ctx.fillStyle = P.accent; ctx.beginPath();
    for (let i = 0; i < 32; i++) { const r = i % 2 ? R * 0.88 : R, a = (i / 32) * Math.PI * 2; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
    ctx.closePath(); ctx.fill(); ctx.restore();
    ctx.save(); ctx.translate(cx, cy); const s2 = back((lt - 0.5) / 0.45) * (1 + Math.sin(lt * 7) * 0.025); ctx.scale(s2, s2);
    ctx.fillStyle = P.bg1; ctx.textAlign = 'center'; let fs = 96 * k; ctx.font = font(900, fs);
    while (ctx.measureText(sc.price).width > R * 1.5 && fs > 30) { fs -= 4; ctx.font = font(900, fs); }
    ctx.fillText(sc.price, 0, fs * 0.35);
    if (sc.old) { ctx.font = font(600, 38 * k); ctx.globalAlpha = 0.7; const w = ctx.measureText(sc.old).width; ctx.fillText(sc.old, 0, -fs * 0.65); ctx.fillRect(-w / 2, -fs * 0.65 - 12 * k, w, 4 * k); }
    ctx.restore();
    para(F, P, sc.sub, cy + R + 80 * k, lt, 38 * k, 0.8);
  };
  T.cta = (F, P, sc, lt) => {
    const { ctx, k, cx, H } = F;
    const h = headline(F, P, sc.title || 'Follow untuk info berikutnya!', H * (F.vert ? 0.4 : 0.36), lt, (F.vert ? 72 : 60) * k);
    const a = ease((lt - 0.5) / 0.4), pu = 1 + Math.sin(lt * 6) * 0.045, by = h.bottom + (F.vert ? 170 : 110) * k;
    ctx.save(); ctx.globalAlpha *= a; ctx.translate(cx, by); ctx.scale(pu, pu);
    ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 30 * k; ctx.shadowOffsetY = 12 * k;
    ctx.fillStyle = P.accent; rr(ctx, -230 * k, -58 * k, 460 * k, 116 * k, 58 * k); ctx.fill(); ctx.shadowColor = 'transparent';
    ctx.fillStyle = P.bg1; ctx.font = font(900, 42 * k); ctx.textAlign = 'center'; ctx.fillText(sc.sub ? sc.sub.slice(0, 18) : 'FOLLOW ➜', 0, 15 * k); ctx.restore();
    ctx.save(); ctx.globalAlpha *= a; ctx.font = font(400, 84 * k); ctx.textAlign = 'center'; ctx.fillText('👆', cx + 180 * k, by + 130 * k + Math.sin(lt * 8) * 12 * k); ctx.restore();
  };

  // Satu frame utuh: latar, progres adegan, brand, adegan aktif (+ transisi)
  function drawFrame(ctx, W, H, sb, t, img) {
    const P = sb.theme, F = frameCtx(ctx, W, H), k = F.k;
    const g = ctx.createLinearGradient(0, 0, W * 0.45, H); g.addColorStop(0, P.bg1); g.addColorStop(1, P.bg2);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 7; i++) { // lingkaran lembut bergerak
      const r = (70 + (i % 3) * 50) * k, x = W * ((i * 0.37 + t * 0.025 * (i % 2 ? 1 : -1) + 2) % 1.2) - 60 * k, y = H * ((i * 0.23 + t * 0.018 * (1 + (i % 3))) % 1.15) - 60 * k;
      ctx.globalAlpha = 0.025 + (i % 3) * 0.015; ctx.fillStyle = i % 2 ? P.accent : '#ffffff'; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    let acc = 0, si = 0;
    while (si < sb.scenes.length - 1 && t >= acc + sb.scenes[si].sec) { acc += sb.scenes[si].sec; si++; }
    const sc = sb.scenes[si], lt = t - acc, out = clamp01((lt - (sc.sec - 0.3)) / 0.3), last = si === sb.scenes.length - 1;
    ctx.save(); if (!last) { ctx.globalAlpha = 1 - out; ctx.translate(-out * 60 * k, 0); }
    (T[sc.t] || T.title)(F, P, sc, lt, img);
    ctx.restore();
  }
  V.drawFrame = drawFrame;
  V.size = (fmt) => SIZES[fmt] || SIZES['9:16'];
  V.duration = (sb) => sb.scenes.reduce((a, x) => a + x.sec, 0);

  /* ------------------------------------------------------------ encode MP4 */
  const newCanvas = (W, H) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H }));
  async function pickCodec(W, H) {
    if (typeof VideoEncoder === 'undefined') return null;
    for (const [codec, mux] of [['avc1.4d401f', 'avc'], ['avc1.42e01f', 'avc'], ['avc1.640028', 'avc'], ['vp09.00.31.08', 'vp9']]) {
      const c = { codec, width: W, height: H, bitrate: 3_500_000, framerate: FPS };
      if (mux === 'avc') c.avc = { format: 'avc' };
      try { if ((await VideoEncoder.isConfigSupported(c)).supported) return { cfg: c, mux }; } catch (e) { /* coba berikutnya */ }
    }
    return null;
  }
  async function encodeWebCodecs(sb, W, H, img, onProgress, pick) {
    const { Muxer, ArrayBufferTarget } = await import('../vendor/mp4-muxer/mp4-muxer.js');
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({ target, video: { codec: pick.mux, width: W, height: H, frameRate: FPS }, fastStart: 'in-memory' });
    let err = null;
    const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (err = e) });
    enc.configure(pick.cfg);
    const cv = newCanvas(W, H), ctx = cv.getContext('2d'), frames = Math.round(V.duration(sb) * FPS);
    for (let i = 0; i < frames; i++) {
      if (err) throw err;
      drawFrame(ctx, W, H, sb, i / FPS, img);
      const vf = new VideoFrame(cv, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
      enc.encode(vf, { keyFrame: i % (FPS * 2) === 0 }); vf.close();
      if (enc.encodeQueueSize > 6 || i % 10 === 0) { onProgress && onProgress(i / frames); await new Promise((r) => setTimeout(r, 0)); }
    }
    await enc.flush(); if (err) throw err;
    muxer.finalize(); enc.close();
    return new Blob([target.buffer], { type: 'video/mp4' });
  }
  async function encodeRecorder(sb, W, H, img, onProgress) {
    const cv = Object.assign(document.createElement('canvas'), { width: W, height: H }), ctx = cv.getContext('2d');
    const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(cv.captureStream(FPS), { mimeType: mime, videoBitsPerSecond: 3_500_000 });
    const parts = []; rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    const total = V.duration(sb);
    drawFrame(ctx, W, H, sb, 0, img); rec.start(500);
    const t0 = performance.now();
    await new Promise((resolve) => { const tick = () => { const t = (performance.now() - t0) / 1000; drawFrame(ctx, W, H, sb, Math.min(t, total), img); onProgress && onProgress(Math.min(1, t / total)); if (t >= total) return resolve(); setTimeout(tick, 1000 / FPS); }; tick(); });
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    return new Blob(parts, { type: mime.split(';')[0] });
  }

  /** storyboard → { blob, thumb (Blob JPEG), codec } */
  V.render = async function (sb, { format = '9:16', image, onProgress } = {}) {
    const [W, H] = V.size(format);
    let img = null;
    if (image) { try { img = await createImageBitmap(image); } catch (e) { img = null; } }
    // thumbnail: frame di tengah adegan pertama
    const tc = Object.assign(document.createElement('canvas'), { width: Math.round(W / 2), height: Math.round(H / 2) }), tctx = tc.getContext('2d');
    tctx.scale(0.5, 0.5); drawFrame(tctx, W, H, sb, Math.min(1.6, sb.scenes[0].sec * 0.7), img);
    const thumb = await new Promise((r) => tc.toBlob(r, 'image/jpeg', 0.72));
    const pick = await pickCodec(W, H);
    let blob, codec;
    // urutan: H.264 cepat (WebCodecs) → rekam real-time MP4 → VP9 dalam MP4 → WebM
    if (pick && pick.mux === 'avc') { blob = await encodeWebCodecs(sb, W, H, img, onProgress, pick); codec = 'h264'; }
    else if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/mp4;codecs=avc1')) { blob = await encodeRecorder(sb, W, H, img, onProgress); codec = 'h264'; }
    else if (pick) { blob = await encodeWebCodecs(sb, W, H, img, onProgress, pick); codec = 'vp9'; }
    else { blob = await encodeRecorder(sb, W, H, img, onProgress); codec = /mp4/.test(blob.type) ? 'mp4' : 'webm'; }
    return { blob, thumb, codec };
  };

  /* ------------------------------------------------------------ alur kerja kantor */
  const CREATIVE = /sosmed|sosial|social|media|konten|content|marketing|pemasaran|kreatif|creative|iklan|brand|promosi/i;
  V.creativeDivision = (s, preferId) => s.divisions.find((d) => d.id === preferId) || s.divisions.find((d) => CREATIVE.test(d.name))
    || s.divisions.find((d) => s.departments.some((p) => p.divisionId === d.id && CREATIVE.test(p.name))) || null;
  const waitTask = (task) => new Promise((resolve) => { const iv = setInterval(() => { if (task.status === 'done' || task.status === 'failed') { clearInterval(iv); resolve(task); } }, 800); });

  /**
   * Buat video dari brief. o: { brief, style, format ('9:16'|'16:9'), duration, brand, cta, files: [File] (foto/video) atau image (Blob),
   *   divisionId, telegram: true|false|chatId, platforms:[…], schedule (ms) }  → item galeri
   */
  V.create = function (o) { return new Promise((resolve, reject) => { V.queue.push({ o, resolve, reject }); pump(); }); };
  V.pending = () => V.queue.length + (V.busy ? 1 : 0);
  async function pump() {
    if (V.busy || !V.queue.length) return;
    V.busy = true;
    const { o, resolve, reject } = V.queue.shift();
    try { resolve(await run(o)); } catch (e) { reject(e); } finally { V.busy = false; pump(); }
  }
  async function run(o) {
    const s = VO.app.state;
    const div = V.creativeDivision(s, o.divisionId);
    const lead = div && (VO.director(s, div.id) || s.agents.find((a) => a.divisionId === div.id));
    const who = lead ? lead.id : 'boss';
    o.style = V.STYLES[o.style] ? o.style : B.guessStyle(o.brief);
    o.format = o.format === '16:9' ? '16:9' : '9:16';
    // aset Boss: banyak file (dialog) atau satu foto (Telegram) → o.files + ringkasan untuk naskah AI
    if (!Array.isArray(o.files) || !o.files.length) o.files = o.image ? [o.image] : [];
    o.files = o.files.slice(0, 8);
    o.assets = o.files.map((f, i) => ({ kind: /^video\//.test(f.type) ? 'video' : 'photo', name: String(f.name || `aset ${i + 1}`).slice(0, 40) }));
    o.image = o.files.find((f) => /^image\//.test(f.type)) || null; // render di browser hanya memakai satu foto
    const short = String(o.brief).replace(/^(tolong\s+)?(buat(kan)?|bikin(in|kan)?|siapkan|render|produksi)\s+(sebuah\s+)?video\s*/i, '').trim() || o.brief;
    const item = V.addItem(s, { title: (short.charAt(0).toUpperCase() + short.slice(1)).slice(0, 90), status: 'producing', format: o.format, style: o.style, divisionId: div ? div.id : null, platforms: o.platforms || (o.format === '16:9' ? ['youtube'] : ['tiktok', 'instagram', 'youtube']), schedule: o.schedule || null });
    try {
      // 1) tim mengerjakan riset & naskah kasar (alur kantor biasa)
      const task = VO.tasks.create({ title: `[Video] ${o.brief}`.slice(0, 300), targetType: div ? 'division' : 'all', targetId: div ? div.id : null });
      task.source = typeof o.telegram === 'number' || typeof o.telegram === 'string' ? 'telegram' : 'web';
      task.videoId = item.id; item.taskId = task.id;
      await waitTask(task);
      // 2) naskah terstruktur
      VO.sim.say(who, '🎬 Menyusun naskah per adegan…', 4); item.stage = 'naskah'; VO.app.changed();
      const sb = await V.storyboard(o, task.status === 'done' ? task.result : '');
      item.title = sb.title; item.storyboard = sb; item.caption = sb.caption; item.stage = 'render';
      // 3) render: server video (Remotion di VPS: narasi, subtitle, musik, foto stok) bila aktif, selain itu di browser
      const eng = await V.engine(true);
      let sentByServer = false, size = 0;
      if (eng.worker) {
        VO.sim.say(who, '🎬 Naskah dikirim ke server video…', 4);
        const job = await renderOnServer(item, sb, o, who);
        item.file = job.file; item.thumb = job.thumb; item.duration = job.duration; item.codec = 'h264';
        if (job.sb) { item.storyboard = job.sb; item.narrated = !!job.sb.narrated; }
        sentByServer = o.telegram != null && o.telegram !== false; size = job.file.size;
      } else {
        if (!V.supported()) throw new Error('Server video (VPS) sedang tidak aktif dan browser ini belum bisa membuat video — pakai Chrome/Edge terbaru.');
        let lastP = -1;
        const r = await V.render(sb, { format: o.format, image: o.image, onProgress: (f) => {
          item.progress = f; const p = Math.round(f * 100);
          if (p >= lastP + 25) { lastP = p; VO.sim.say(who, `🎬 Render video ${p}%`, 3); }
        } });
        // simpan: video + thumbnail
        const slug = sb.title.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 50) || 'video';
        const ext = /mp4/.test(r.blob.type) ? 'mp4' : 'webm';
        item.stage = 'upload'; VO.app.changed();
        item.file = await VO.files.upload(r.blob, `${slug}.${ext}`);
        item.thumb = await VO.files.upload(r.thumb, `${slug}-thumb.jpg`).catch(() => null);
        item.duration = Math.round(V.duration(sb)); item.codec = r.codec; item.engine = 'browser'; size = r.blob.size;
      }
      const fin = item.storyboard || sb;
      item.pack = fin.pack;
      item.status = item.schedule ? 'scheduled' : 'draft'; item.stage = ''; item.progress = 1;
      const script = fin.scenes.map((x, i) => `${i + 1}. **${x.t}** (${x.sec} dtk) — ${x.title || x.text || x.label || ''}${x.items && x.items.map ? ' · ' + x.items.map((q) => (typeof q === 'string' ? q : `${q.label} ${q.value}`)).join(', ') : ''}${x.value != null && x.t === 'stat' ? ' · ' + x.value + ' ' + (x.unit || '') : ''}${x.customOk ? ' · ✨ animasi buatan AI' : ''}${x.narration ? `\n   _“${x.narration}”_` : ''}`).join('\n');
      const doc = VO.addDoc(s, { kind: 'work', title: 'Video: ' + sb.title, author: div ? 'Divisi ' + div.name : 'Tim Kreatif', taskId: task.id, content: `## ${sb.title}\n\n**Caption:** ${sb.caption}\n\n### Naskah per adegan\n${script}` });
      doc.file = item.file; item.docId = doc.id;
      VO.sim.say(who, '🎬 Video siap — cek Galeri!', 4, 'check');
      VO.log(s, `Video "${sb.title}" selesai (${item.duration} dtk, ${VO.files.fmtSize(size)}${item.engine === 'remotion' ? ', server video' : ''}) — masuk Galeri`, 'check');
      VO.app.changed();
      if (o.telegram != null && o.telegram !== false && !sentByServer) {
        try { await VO.files.sendTelegram(item.file, `🎬 ${sb.title}\n\n${sb.caption}`, o.telegram === true ? undefined : o.telegram); }
        catch (e) { VO.ui.toast('Telegram: ' + e.message, 'alert'); }
      }
      return item;
    } catch (e) {
      item.status = 'failed'; item.stage = ''; item.error = String(e.message || e); VO.app.changed();
      throw e;
    }
  }

  /* ------------------------------------------------------------ data galeri */
  V.addItem = function (s, o) {
    if (!Array.isArray(s.videos)) s.videos = [];
    const it = { id: VO.uid('vd'), created: Date.now(), title: 'Video', status: 'draft', platforms: [], schedule: null, ...o };
    s.videos.unshift(it);
    if (s.videos.length > 80) s.videos.length = 80;
    VO.app.changed();
    return it;
  };
})();

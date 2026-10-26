/* =========================================================================
 * render.js — renderer ISOMETRIK 2.5D (gaya pixel / Habbo) di <canvas>.
 *
 * Simulasi tetap bekerja di koordinat grid (tile). Renderer memproyeksikan
 * setiap tile (tx, ty) ke layar isometrik:
 *     x = OX + (tx - ty) * 32        y = OY + (tx + ty) * 16
 * Lantai di-cache di offscreen canvas; dinding, meja, furnitur, dan karakter
 * digambar tiap frame dan diurutkan berdasarkan kedalaman (tx + ty) agar
 * benda di depan menutupi benda di belakang.
 * ========================================================================= */
(function () {
  const VO = window.VO;
  const T = VO.TILE; // ukuran tile simulasi (px) — rt.x / T = posisi tile
  const HW = 32, HH = 16; // setengah lebar & tinggi belah ketupat isometrik
  const R = (VO.render = { cam: { x: 0, y: 0, zoom: 1 }, staticDirty: true, hover: null, selected: null, hoverObj: null });

  let floorCanvas = null;
  // Tema: 'modern' (terang, kantor terbuka — default) atau 'pixel' (gelap, gaya Habbo)
  // Tema: 'robot' (default — karakter robot, pulau kerja putih, aksen biru kobalt),
  // 'modern' (kantor terbuka terang, karakter manusia) atau 'pixel' (gelap, gaya Habbo)
  const theme = () => (VO.app && VO.app.state && VO.app.state.settings.theme) || 'studio';
  const modern = () => theme() === 'robot' || theme() === 'modern' || theme() === 'studio'; // kantor terbuka terang
  // 'studio' = kantor 2 lantai terang (mezanin + tangga), zona departemen berwarna, kamera depan (3D)
  const studio = () => theme() === 'studio';
  R.isStudio = studio;
  const robot = () => theme() === 'robot';
  // 'classic' = kantor pixel isometrik klasik: lantai ubin lavender, dinding abu berjendela,
  // meja krem berlaci, kursi biru, sekat kubikel kaca, sofa biru di karpet hijau
  const classic = () => theme() === 'classic';
  R.isClassic = classic;
  const CL = { floorA: '#b9bde8', floorB: '#b3b7e3', wallL: '#eceef4', wallR: '#d7dae6', wallTop: '#bcc0d2', desk: '#efe6cf', chair: '#3d5fd6', chairBack: '#2f4fc4', glass: 'rgba(175,205,255,0.42)', frame: '#4a66cf' };
  R.isModern = modern;
  R.theme = theme;
  // 'luxe' = Penthouse: lantai kayu hangat, dinding kaca dengan pemandangan kota malam,
  // ruang rapat kaca + TV, kolam renang & dek, label nama pil gelap
  const luxe = () => theme() === 'luxe';
  R.isLuxe = luxe;
  const LX = {
    woodA: '#0d0d0f', woodB: '#111114', plank: 'rgba(255,255,255,0.045)', edgeL: '#0e121b', edgeR: '#090c13',
    rug: '#26304a', rugEdge: '#3d4a6d', walnut: { top: '#6b4429', left: '#4f311d', right: '#3e2616' },
    chair: '#1f2127', chairBack: '#17191e', gold: '#d6a95b', frame: '#23262e',
  };
  // angka acak deterministik dari koordinat (skyline, papan kayu, bintang)
  const hash = (a, b = 0) => { const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return v - Math.floor(v); };
  const NAVY = '#2633c9', CORAL = '#f04e5e', ORANGE = '#f28a30';
  let props = [];
  const geo = { OX: 0, OY: 90, W: 0, H: 0 };

  /* ------------------------------------------------------------ util warna & geometri */
  const hexToRgb = (hex) => {
    const n = parseInt(String(hex).slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const shade = (hex, f) => {
    const [r, g, b] = hexToRgb(hex);
    const m = (v) => Math.max(0, Math.min(255, Math.round(f >= 1 ? v + (255 - v) * (f - 1) : v * f)));
    return `rgb(${m(r)},${m(g)},${m(b)})`;
  };
  const mix = (a, b, t) => {
    const x = hexToRgb(a), y = hexToRgb(b);
    const c = x.map((v, i) => Math.round(v + (y[i] - v) * t));
    return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  };
  const alpha = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };

  // Kamera 3D bebas (ortografis): yaw = putar mengelilingi gedung, pitch = sudut pandang dari atas.
  // 3D default = menghadap depan (yaw 0°, pitch 36°): dinding belakang sejajar layar; 2D = dari atas.
  const U = 34, ZM = 2.4 * U; // px per tile (1 tile = 1 m), tinggi lantai 2 (2,4 m)
  const VIEW = (R.view = { yaw: 0, pitch: 36 });
  let FLAT = false, OBL = true, MZ = null, ELEV_OFF = false, PROBE = null;
  let CYA = 1, SYA = 0, SP = 0.57, CP = 0.82;
  // Perspektif (3D): mata kamera tetap di depan-atas gedung, PERSP = jaraknya (px) ke pusat lantai.
  // Skala = 1 tepat di bidang pusat; yang lebih dekat tampak lebih besar. 0 = ortografis (denah 2D).
  let PERSP = 0;
  const PERSP_K = 1.9; // × sisi terpanjang denah — makin kecil, makin kuat efek perspektifnya
  // sudut kamera 3D tetap (menghadap depan); pengguna hanya bisa zoom & geser
  R.viewOf = (st) => (st && st.view === '2d' ? { yaw: 0, pitch: 88 } : { yaw: 0, pitch: 36 });
  function updateGeo(s) {
    const v = R.viewOf(s.settings);
    VIEW.yaw = v.yaw; VIEW.pitch = Math.max(18, Math.min(89, v.pitch));
    FLAT = VIEW.pitch >= 70;
    MZ = VO.mezz(s);
    const a = (VIEW.yaw * Math.PI) / 180, b = (VIEW.pitch * Math.PI) / 180;
    CYA = Math.cos(a); SYA = Math.sin(a); SP = Math.sin(b); CP = Math.cos(b);
    PERSP = FLAT ? 0 : Math.max(s.map.w, s.map.h) * U * PERSP_K;
    geo.MH = s.map.h; geo.CXW = (s.map.w / 2) * U; geo.CYW = (s.map.h / 2) * U;
    geo.OX = 0; geo.OY = 0;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [tx, ty] of [[-1, -1], [s.map.w + 1, -1], [-1, s.map.h + 1], [s.map.w + 1, s.map.h + 1]])
      for (const z of [-30, 260]) { const p = proj(tx, ty, z); x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    geo.OX = -x0 + 40; geo.OY = -y0 + 40;
    geo.W = Math.ceil(x1 - x0 + 80); geo.H = Math.ceil(y1 - y0 + 80);
  }
  // basis kamera dalam ruang (dx, dy, z): kanan r = (C, −S, 0), bawah-layar d = (S·SP, C·SP, −CP),
  // ke arah penonton b = (S·CP, C·CP, SP)
  const proj = (tx, ty, z) => {
    const dx = tx * U - geo.CXW, dy = ty * U - geo.CYW;
    let X = dx * CYA - dy * SYA, Y = (dx * SYA + dy * CYA) * SP - z * CP;
    if (PERSP) {
      const k = PERSP / Math.max(PERSP * 0.15, PERSP - ((dx * SYA + dy * CYA) * CP + z * SP));
      X *= k; Y *= k;
    }
    return { x: geo.OX + X, y: geo.OY + Y };
  };
  // kedalaman (semakin besar = semakin dekat kamera) untuk urutan gambar
  const depthOf = (tx, ty) => (tx * U - geo.CXW) * SYA + (ty * U - geo.CYW) * CYA;
  R.depthOf = depthOf;
  R.updateGeo = (s) => updateGeo(s);
  // ketinggian lantai: mezanin (ty <= M) = ZM, tangga = landai, selain itu 0
  const elevAt = (tx, ty) => {
    if (!MZ || ELEV_OFF) return 0;
    if (tx > MZ.sx && tx < MZ.sx + 2 && ty > MZ.M && ty < MZ.M + 3) return (ZM * (MZ.M + 3 - ty)) / 3;
    return ty <= MZ.M ? ZM : 0;
  };
  const iso = (tx, ty, z = 0) => {
    if (PROBE) PROBE.push(tx, ty);
    return proj(tx, ty, z + elevAt(tx, ty));
  };
  // layar → tile (dicoba di lantai 2 dulu bila ada mezanin)
  const toTile = (ix, iy) => {
    const rx = ix - geo.OX;
    const Y = iy - geo.OY;
    for (const Z of MZ ? [ZM, 0] : [0]) {
      let dx, dy;
      if (PERSP) { // perspektif: titik layar → sinar dari mata, potong bidang lantai setinggi Z
        const D = PERSP, b0 = SYA * CP, b1 = CYA * CP, w = D - Z * SP;
        const a11 = D * CYA + rx * b0, a12 = -D * SYA + rx * b1, c1 = rx * w;
        const a21 = D * SYA * SP + Y * b0, a22 = D * CYA * SP + Y * b1, c2 = Y * w + D * Z * CP;
        const det = a11 * a22 - a12 * a21 || 1e-9;
        dx = (c1 * a22 - a12 * c2) / det; dy = (a11 * c2 - c1 * a21) / det;
      } else {
        const ry = (Y + Z * CP) / SP;
        dx = rx * CYA + ry * SYA; dy = -rx * SYA + ry * CYA;
      }
      const t = { x: (dx + geo.CXW) / U, y: (dy + geo.CYW) / U };
      if (Z === ZM && t.y > MZ.M) continue;
      return t;
    }
  };
  R.iso = iso;

  const poly = (ctx, pts, fill, stroke) => {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
  };
  const rr = (ctx, x, y, w, h, r) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };
  R.roundRect = rr;

  const diamond = (tx, ty, w = 1, d = 1, z = 0) => [iso(tx, ty, z), iso(tx + w, ty, z), iso(tx + w, ty + d, z), iso(tx, ty + d, z)];

  /**
   * Balok isometrik dari (x0,y0) sampai (x1,y1) di grid, alas di ketinggian z,
   * tinggi h (px layar). c = warna dasar; sisi diberi bayangan otomatis.
   * Mengembalikan sudut-sudut sisi depan untuk dekorasi (jendela, layar, dll.).
   */
  function box(ctx, x0, y0, x1, y1, z, h, c, opt = {}) {
    const top = c.top || shade(c.base || c, 1.12);
    const left = c.left || shade(c.base || c, 0.86); // sisi y (depan/belakang)
    const right = c.right || shade(c.base || c, 0.7); // sisi x (kiri/kanan)
    // sisi vertikal yang menghadap kamera saja (kamera bisa diputar ke segala arah)
    const fy = CYA >= 0 ? y1 : y0, fx = SYA >= 0 ? x1 : x0;
    const showY = Math.abs(CYA) > 0.02, showX = Math.abs(SYA) > 0.02;
    const fL = [iso(x0, fy, z), iso(x1, fy, z), iso(x1, fy, z + h), iso(x0, fy, z + h)];
    const fR = [iso(fx, y0, z), iso(fx, y1, z), iso(fx, y1, z + h), iso(fx, y0, z + h)];
    const fT = [iso(x0, y0, z + h), iso(x1, y0, z + h), iso(x1, y1, z + h), iso(x0, y1, z + h)];
    if (showX) poly(ctx, fR, right);
    if (showY) poly(ctx, fL, left);
    poly(ctx, fT, top);
    if (opt.outline !== false) {
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const f of [showY && fL, showX && fR, fT].filter(Boolean)) { ctx.moveTo(f[0].x, f[0].y); for (let i = 1; i < 4; i++) ctx.lineTo(f[i].x, f[i].y); ctx.closePath(); }
      ctx.stroke();
    }
    const dead = (f) => [f[0], f[0], f[0], f[0]]; // sisi tak terlihat: dekorasi di atasnya tidak digambar
    return { fL: showY ? fL : dead(fL), fR: showX ? fR : dead(fR), fT };
  }

  // Titik di sisi depan-kiri (+ty) balok: u = 0..1 sepanjang x, v = 0..1 dari bawah ke atas
  const onFace = (f, u, v) => ({
    x: f[0].x + (f[1].x - f[0].x) * u + (f[3].x - f[0].x) * v,
    y: f[0].y + (f[1].y - f[0].y) * u + (f[3].y - f[0].y) * v,
  });
  const facePanel = (ctx, f, u0, u1, v0, v1, fill) => poly(ctx, [onFace(f, u0, v0), onFace(f, u1, v0), onFace(f, u1, v1), onFace(f, u0, v1)], fill);

  /* ------------------------------------------------------------ lantai (cache) */
  function buildFloor(s) {
    updateGeo(s);
    if (!floorCanvas) floorCanvas = document.createElement('canvas');
    floorCanvas.width = geo.W;
    floorCanvas.height = geo.H;
    const ctx = floorCanvas.getContext('2d');
    if (studio()) return buildFloorStudio(ctx, s);
    const M = modern();
    const RB = robot();
    const CLS = classic();
    const fl = RB ? { a: '#e9ebf4', b: '#e9ebf4' } : M ? { a: '#eef0f4', b: '#eceef3' } : CLS ? { a: CL.floorA, b: CL.floorB } : VO.FLOORS[s.settings.floor] || VO.FLOORS.wood;

    // tepi platform (tebal) agar lantai terlihat seperti blok 3D
    const depth = 14;
    const A = iso(0, s.map.h), B = iso(s.map.w, s.map.h), C = iso(s.map.w, 0);
    poly(ctx, [A, B, { x: B.x, y: B.y + depth }, { x: A.x, y: A.y + depth }], shade(fl.a, M ? 0.88 : 0.55));
    poly(ctx, [B, C, { x: C.x, y: C.y + depth }, { x: B.x, y: B.y + depth }], shade(fl.a, M ? 0.8 : 0.42));

    if (luxe()) return buildFloorLuxe(ctx, s);

    const tint = new Map(); // "x,y" → warna lantai ruangan
    const setRect = (r, color, inset = 0) => {
      for (let y = r.y + inset; y < r.y + r.h - inset; y++) for (let x = r.x + inset; x < r.x + r.w - inset; x++) tint.set(x + ',' + y, color);
    };
    if (!RB) for (const div of s.divisions) setRect(div.zone, mix(fl.a, div.color, M ? 0.05 : 0.22));
    for (const d of s.departments) {
      if (RB) break;
      const div = s.divisions.find((x) => x.id === d.divisionId);
      setRect(d.room, CLS ? '#c3c6ee' : M ? mix('#f7f8fb', div ? div.color : '#888888', 0.04) : mix('#e9edf2', div ? div.color : '#888888', 0.16));
    }
    for (const f of s.facilities) {
      if (RB) break;
      setRect(f, CLS ? '#c3c6ee' : M ? mix('#f7f8fb', f.color, 0.05) : mix('#ece6dc', f.color, 0.2));
      if (f.type === 'boss') setRect({ x: f.x + 2, y: f.y + 2, w: f.w - 4, h: f.h - 3 }, CLS ? '#5b6fd0' : M ? '#e4e8f0' : '#9c3b45');
      if (f.type === 'lounge') setRect({ x: f.x + 2, y: f.y + 2, w: f.w - 4, h: f.h - 4 }, CLS ? '#3f9d4b' : mix(M ? '#f7f8fb' : '#ece6dc', '#9d4edd', M ? 0.12 : 0.45));
      if (CLS && f.type === 'pantry') setRect({ x: f.x + 1, y: f.y + 2, w: f.w - 2, h: f.h - 3 }, '#d9dcf3');
    }

    for (let y = 0; y < s.map.h; y++)
      for (let x = 0; x < s.map.w; x++) {
        const c = tint.get(x + ',' + y);
        const base = c || ((x + y) % 2 ? fl.a : fl.b);
        const fill = c ? ((x + y) % 2 ? base : shade(base, 0.96)) : base;
        poly(ctx, diamond(x, y), M ? (c || fl.a) : fill, M ? 'rgba(40,50,70,0.035)' : 'rgba(0,0,0,0.06)');
      }
    if (RB) {
      // pulau kerja putih yang terangkat untuk tiap departemen & ruangan, zona divisi bertitik
      const island = (r, inset, h) => {
        const x0 = r.x + inset, y0 = r.y + inset, x1 = r.x + r.w - inset, y1 = r.y + r.h - inset;
        const sh = [iso(x0, y0), iso(x1, y0), iso(x1, y1), iso(x0, y1)].map((p) => ({ x: p.x + 6, y: p.y + 10 }));
        poly(ctx, sh, 'rgba(60,70,140,0.08)');
        const A2 = iso(x0, y1), B2 = iso(x1, y1), C2 = iso(x1, y0);
        poly(ctx, [A2, B2, { x: B2.x, y: B2.y + h }, { x: A2.x, y: A2.y + h }], '#dde0ee');
        poly(ctx, [B2, C2, { x: C2.x, y: C2.y + h }, { x: B2.x, y: B2.y + h }], '#cbd0e4');
        poly(ctx, diamond(x0, y0, x1 - x0, y1 - y0), '#ffffff');
      };
      ctx.lineWidth = 2;
      ctx.setLineDash([2, 7]);
      for (const div of s.divisions) poly(ctx, diamond(div.zone.x + 0.15, div.zone.y + 0.15, div.zone.w - 0.3, div.zone.h - 0.3), null, alpha(NAVY, 0.28));
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      for (const f of s.facilities) island(f, 0.25, 8);
      for (const d of s.departments) island(d.room, 0.25, 8);
      for (const div of s.divisions) island({ x: div.directorDesk.x - 1, y: div.directorDesk.y - 0.6, w: 3, h: 3 }, 0.1, 6);
      for (const div of s.divisions) floorText(ctx, div.name.toUpperCase(), div.zone.x + 1, div.zone.y + div.zone.h - 0.7, 22, alpha(NAVY, 0.35));
      for (const d of s.departments) floorText(ctx, d.name.toUpperCase(), d.room.x + 0.9, d.room.y + d.room.h - 0.6, 12, alpha(NAVY, 0.55));
      for (const f of s.facilities) floorText(ctx, f.name.toUpperCase(), f.x + 0.9, f.y + f.h - 0.6, 12, alpha(NAVY, 0.5));
      return;
    }
    if (M) {
      // garis tipis batas zona & ruangan + nama tim ditulis di lantai (gaya kantor terbuka)
      ctx.lineWidth = 1.5;
      for (const div of s.divisions) poly(ctx, diamond(div.zone.x, div.zone.y, div.zone.w, div.zone.h), null, alpha(div.color, 0.35));
      for (const d of s.departments) poly(ctx, diamond(d.room.x + 0.5, d.room.y + 0.5, d.room.w - 1, d.room.h - 1), null, 'rgba(60,70,90,0.18)');
      ctx.lineWidth = 1;
      for (const div of s.divisions) floorText(ctx, div.name.toUpperCase(), div.zone.x + 1, div.zone.y + div.zone.h - 0.9, 22, alpha(div.color, 0.55));
      for (const d of s.departments) floorText(ctx, d.name.toUpperCase(), d.room.x + 0.9, d.room.y + d.room.h - 0.55, 12, 'rgba(60,70,90,0.55)');
      for (const f of s.facilities) floorText(ctx, f.name.toUpperCase(), f.x + 0.9, f.y + f.h - 0.55, 12, 'rgba(60,70,90,0.5)');
      return;
    }
    // garis putus-putus batas zona divisi
    for (const div of s.divisions) {
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 2;
      poly(ctx, diamond(div.zone.x, div.zone.y, div.zone.w, div.zone.h), null, alpha(div.color, 0.85));
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
    }
  }

  function buildFloorLuxe(ctx, s) {
    const depth = 26;
    const A = iso(0, s.map.h), B = iso(s.map.w, s.map.h), C = iso(s.map.w, 0);
    poly(ctx, [A, B, { x: B.x, y: B.y + depth }, { x: A.x, y: A.y + depth }], LX.edgeL);
    poly(ctx, [B, C, { x: C.x, y: C.y + depth }, { x: B.x, y: B.y + depth }], LX.edgeR);
    // lampu LED hangat di tepi gedung
    const led = (p) => {
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 9);
      g.addColorStop(0, 'rgba(255,214,140,0.55)'); g.addColorStop(1, 'rgba(255,214,140,0)');
      ctx.fillStyle = g; ctx.fillRect(p.x - 9, p.y - 9, 18, 18);
      ctx.fillStyle = '#ffe3a8'; ctx.beginPath(); ctx.arc(p.x, p.y, 1.6, 0, 7); ctx.fill();
    };
    for (let x = 0.5; x < s.map.w; x += 1.5) { const p = iso(x, s.map.h); led({ x: p.x, y: p.y + 9 }); }
    for (let y = 0.5; y < s.map.h; y += 1.5) { const p = iso(s.map.w, y); led({ x: p.x, y: p.y + 9 }); }

    const tint = new Map();
    const setRect = (r, color, inset = 0) => {
      for (let y = r.y + inset; y < r.y + r.h - inset; y++) for (let x = r.x + inset; x < r.x + r.w - inset; x++) tint.set(x + ',' + y, color);
    };
    for (const div of s.divisions) setRect(div.zone, 'z:' + div.color);
    const FAC = { pantry: 'marble' }; // ruangan lain memakai lantai panel seperti Ruang Boss
    for (const f of s.facilities) setRect(f, FAC[f.type] || 'tech');
    const marble = new Set();
    for (let y = 0; y < s.map.h; y++)
      for (let x = 0; x < s.map.w; x++) {
        const c = tint.get(x + ',' + y);
        if (c === 'marble') {
          marble.add(x + ',' + y);
          poly(ctx, diamond(x, y), (x + y) % 2 ? '#ece6dc' : '#ddd4c6', 'rgba(120,100,80,0.12)');
          continue;
        }
        // lantai panel gelap bergaris cahaya cyan (sama dengan Ruang Boss); zona divisi diberi sedikit warna divisi
        let a = '#161b27', b = '#141924';
        if (c && c.startsWith('z:')) { a = mix(a, c.slice(2), 0.06); b = mix(b, c.slice(2), 0.06); }
        poly(ctx, diamond(x, y), (x + y) % 2 ? a : b, 'rgba(53,224,255,0.12)');
      }
    // karpet: biru tua di area kerja, merah anggur di ruang Boss, krem di lounge
    const rug = (x, y, w, h, fill, edge) => {
      if (w <= 0 || h <= 0) return;
      poly(ctx, diamond(x, y, w, h), fill);
      ctx.lineWidth = 2; poly(ctx, diamond(x + 0.12, y + 0.12, w - 0.24, h - 0.24), null, edge); ctx.lineWidth = 1;
    };
    for (const d of s.departments) rug(d.room.x + 0.7, d.room.y + 1.3, d.room.w - 1.4, d.room.h - 2, LX.rug, LX.rugEdge);
    for (const div of s.divisions) rug(div.directorDesk.x - 1.4, div.directorDesk.y - (VO.openPlan(s) ? 1.5 : 0.4), 3.8, 2.9, '#33283e', '#5b4870');
    for (const f of s.facilities) {
      if (f.type === 'boss') { // garis cahaya cyan di lantai mengelilingi area kerja Boss
        ctx.save(); ctx.shadowColor = '#35e0ff'; ctx.shadowBlur = 8; ctx.lineWidth = 2;
        poly(ctx, diamond(f.x + 1.5, f.y + 1.5, f.w - 3, f.h - 2.6), null, 'rgba(53,224,255,0.75)');
        ctx.lineWidth = 1; poly(ctx, diamond(f.x + 1.8, f.y + 1.8, f.w - 3.6, f.h - 3.2), null, 'rgba(53,224,255,0.3)');
        ctx.restore();
      }
      if (f.type === 'lounge') rug(f.x + 1.5, f.y + 1.5, f.w - 3, f.h - 3, '#d8c6a4', '#b89f76');
      if (f.type === 'billiard') { const b = VO.billiardTable(f); rug(b.x - 1.2, b.y - 1.2, b.w + 2.4, b.h + 2.4, '#3b2230', LX.gold); }
    }
    // garis emas tipis batas zona divisi
    ctx.lineWidth = 1.5;
    for (const div of s.divisions) poly(ctx, diamond(div.zone.x + 0.1, div.zone.y + 0.1, div.zone.w - 0.2, div.zone.h - 0.2), null, alpha(LX.gold, 0.45));
    ctx.lineWidth = 1;
  }

  // Warna pastel zona departemen (tema Studio)
  const PASTEL = ['#f6c48f', '#a9c4f5', '#f4a9b8', '#a8e0c9', '#c9b6f2', '#f7d98b', '#9fd8e8', '#f2b48c'];
  const deptColor = (s, d) => { const i = s.departments.indexOf(d); return PASTEL[(i < 0 ? 0 : i) % PASTEL.length]; };
  R.deptColor = deptColor;

  function buildFloorStudio(ctx, s) {
    const mw = s.map.w, mh = s.map.h;
    const mz = VO.mezz(s);
    const M = mz ? mz.M : -1;
    // Cache the platform shadow with the floor, not in the animation loop.
    ELEV_OFF = true;
    ctx.save(); ctx.shadowColor = 'rgba(29,59,49,0.22)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 16;
    poly(ctx, diamond(0, 0, mw, mh), '#d3ddd5'); ctx.restore();
    ELEV_OFF = false;
    // pelat fondasi tebal (sisi yang menghadap kamera ikut putaran)
    ELEV_OFF = true;
    box(ctx, -0.35, -0.35, mw + 0.35, mh + 0.35, -22, 22, { top: '#a9b2bc', left: '#6d7884', right: '#5d6873' }, { outline: false });
    ELEV_OFF = false;
    const zoneOf = new Map();
    const setRect = (r, v) => { for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) zoneOf.set(x + ',' + y, v); };
    for (const div of s.divisions) setRect(div.zone, 'z:' + div.color);
    for (const f of s.facilities) setRect(f, 'f:' + mix(f.color, '#ffffff', 0.82));
    for (const d of s.departments) setRect({ x: d.room.x, y: d.room.y + 1, w: d.room.w, h: d.room.h - 1 }, 'd:' + deptColor(s, d));
    const tileAt = (x, y) => {
      const z = zoneOf.get(x + ',' + y);
      const up = mz && y < M;
      const y0 = mz && y === M ? M + 0.002 : y; // baris pertama lantai 1 dimulai tepat di bawah tepi mezanin
      const pts = diamond(x, y0, 1, 1 - (y0 - y));
      if (z && z.startsWith('d:')) return poly(ctx, pts, mix(z.slice(2), '#e9eee9', 0.77), 'rgba(32,62,54,0.025)');
      if (z && z.startsWith('f:')) return poly(ctx, pts, z.slice(2), 'rgba(0,0,0,0.05)');
      if (up) return poly(ctx, pts, (x + y) % 2 ? '#e9ece7' : '#e5e9e4', 'rgba(0,0,0,0.04)');
      // lantai ubin krem kotak-kotak (checker) seperti office_ai_expanded_v2
      const tile = (x + y) % 2 ? '#e0cfae' : '#d8c5a0';
      poly(ctx, pts, z && z.startsWith('z:') ? mix(tile, z.slice(2), 0.05) : tile, 'rgba(120,96,60,0.06)');
    };
    // lantai 1 dulu, lalu blok mezanin, lalu lantai 2 (urutan benar dari arah kamera mana pun)
    for (let y = mz ? M : 0; y < mh; y++) for (let x = 0; x < mw; x++) tileAt(x, y);
    if (!mz) return;
    ELEV_OFF = true;
    box(ctx, 0, 0, mw, M + 0.002, 0, ZM, { top: '#e7eae6', left: '#f2f3f5', right: '#dfe3e8' }, { outline: false });
    ELEV_OFF = false;
    if (CYA > 0.05 && !FLAT) {
      // dinding depan mezanin (dinding belakang lantai 1): jendela, pintu, rak buku
      const top = (x) => iso(x, M, 0), bot = (x, z = 0) => iso(x, M + 0.002, z);
      poly(ctx, [top(0), top(mw), bot(mw, ZM - 6), bot(0, ZM - 6)], '#d9dde3'); // tepi pelat lantai
      const panel = (x0, x1, z0, z1, fill) => poly(ctx, [bot(x0, z0), bot(x1, z0), bot(x1, z1), bot(x0, z1)], fill);
      for (let x = 3; x < mw - 3; x += 9) {
        if (x + 3 > mz.sx - 1 && x < mz.sx + 3) continue;
        const kind = Math.floor(x / 9) % 4;
        if (kind === 1) { panel(x, x + 1.4, 0, 44, '#b9875a'); panel(x + 1.15, x + 1.25, 20, 24, '#f2d29b'); continue; } // pintu
        if (kind === 3) { // rak buku
          panel(x, x + 2.4, 0, 46, '#c49a6c');
          for (let r = 0; r < 3; r++) for (let i = 0; i < 6; i++) panel(x + 0.15 + i * 0.36, x + 0.42 + i * 0.36, 6 + r * 13, 16 + r * 13, ['#e57373', '#64b5f6', '#81c784', '#ffd54f', '#ba68c8', '#4db6ac'][(r + i) % 6]);
          continue;
        }
        panel(x, x + 3, 18, 52, '#ffffff'); panel(x + 0.12, x + 2.88, 21, 49, '#a7d8ff'); panel(x + 1.45, x + 1.55, 21, 49, '#ffffff');
      }
    }
    for (let y = 0; y < M; y++) for (let x = 0; x < mw; x++) tileAt(x, y);
  }

  // Tulisan yang "dicat" di lantai, mengikuti sumbu x isometrik (size = px per 32 unit tile)
  function floorText(ctx, text, tx, ty, size, color) {
    const o = iso(tx, ty);
    ctx.save();
    ctx.setTransform(HW / 32, HH / 32, -HW / 32, HH / 32, o.x, o.y);
    ctx.font = `800 ${size}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = color;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  /* ------------------------------------------------------------ props (benda 3D) */
  // Setiap prop: { k: kedalaman (tx+ty pusat), d: fungsi gambar(ctx, now, s) }
  function buildProps(s) {
    props = [];
    // posisi tiap objek dicari otomatis (probe: rekam koordinat tile yang dipakai saat menggambar)
    const add = (k, d) => props.push({ fixed: k <= -500 ? k : null, d });

    const walls = (r, color, fac) => {
      if (robot()) return; // tema robot: pulau terbuka tanpa dinding
      if (modern()) return partitions(r, fac);
      if (luxe()) return luxeWalls(r, fac);
      if (studio()) return studioWalls(r, color, fac);
      const doors = VO.doorTiles(r, fac);
      const isDoor = (x, y) => doors.some((d) => d.x === x && d.y === y);
      const CLS = classic();
      const wallBase = CLS ? CL.wallL : mix('#efe9df', color, 0.18);
      const TALL = CLS ? 52 : 46, LOW = CLS ? 26 : 12, TH_ = CLS ? 0.22 : 0.32; // tinggi dinding belakang/depan & ketebalan
      const L = r.x, Tp = r.y, Rr = r.x + r.w - 1, B = r.y + r.h - 1;
      const seg = (x0, y0, x1, y1, h, kind, win) =>
        add((x0 + x1) / 2 + (y0 + y1) / 2, (ctx) => {
          if (CLS && h === LOW) { // sekat kubikel kaca berbingkai biru
            const g = box(ctx, x0, y0, x1, y1, 0, h, { top: CL.frame, left: CL.glass, right: 'rgba(150,185,245,0.42)' }, { outline: false });
            ctx.strokeStyle = CL.frame; ctx.lineWidth = 1.4;
            for (const f2 of [g.fL, g.fR]) { ctx.beginPath(); ctx.moveTo(f2[3].x, f2[3].y); ctx.lineTo(f2[2].x, f2[2].y); ctx.stroke(); }
            ctx.lineWidth = 1;
            return;
          }
          const f = box(ctx, x0, y0, x1, y1, 0, h, CLS ? { top: CL.wallTop, left: CL.wallL, right: CL.wallR } : { top: '#5a6172', left: shade(wallBase, 0.95), right: shade(wallBase, 0.78) });
          const winCol = CLS ? '#8fc4f5' : 'rgba(150,205,255,0.75)';
          const face = kind === 'top' ? f.fL : kind === 'left' ? f.fR : null;
          if (win && face) {
            if (CLS) facePanel(ctx, face, 0.12, 0.88, 0.36, 0.86, '#ffffff'); // bingkai jendela
            facePanel(ctx, face, 0.18, 0.82, 0.4, 0.82, winCol);
            if (CLS) facePanel(ctx, face, 0.48, 0.52, 0.4, 0.82, '#ffffff');
          } else if (CLS && face && ((x0 * 7 + y0 * 13) | 0) % 5 === 0) {
            // poster / papan pengumuman di dinding
            facePanel(ctx, face, 0.3, 0.7, 0.45, 0.82, '#ffffff');
            facePanel(ctx, face, 0.36, 0.64, 0.52, 0.75, ['#6aa9ff', '#ffb74d', '#81c784', '#f06292'][((x0 + y0) | 0) % 4]);
          }
          if (h > LOW) { // list warna di kaki dinding
            if (kind === 'top') facePanel(ctx, f.fL, 0, 1, 0, 0.12, shade(color, 0.85));
            if (kind === 'left') facePanel(ctx, f.fR, 0, 1, 0, 0.12, shade(color, 0.75));
          }
        });
      // dinding belakang (tinggi): baris atas & kolom kiri
      for (let x = L; x <= Rr; x++) {
        if (isDoor(x, Tp)) continue;
        const x0 = x === L ? x + 1 - TH_ : x, x1 = x === Rr ? x + TH_ : x + 1;
        seg(x0, Tp + 1 - TH_, x1, Tp + 1, TALL, 'top', (x - L) % 3 === 1);
      }
      for (let y = Tp + 1; y <= B; y++) {
        if (isDoor(L, y)) continue;
        const y1 = y === B ? y + TH_ : y + 1;
        seg(L + 1 - TH_, y, L + 1, y1, TALL, 'left', (y - Tp) % 3 === 2);
      }
      // dinding depan (rendah) agar isi ruangan tetap terlihat
      for (let x = L + 1; x <= Rr; x++) {
        if (isDoor(x, B)) continue;
        const x1 = x === Rr ? x + TH_ : x + 1;
        seg(x, B, x1, B + TH_, LOW, 'bottom');
      }
      for (let y = Tp + 1; y < B; y++) {
        if (isDoor(Rr, y)) continue;
        seg(Rr, y, Rr + TH_, y + 1, LOW, 'right');
      }
    };

    // Studio: dinding putih bergaris warna di atas, jendela biru; sisi depan kaca rendah
    const studioWalls = (r, color, fac) => {
      const doors = VO.doorTiles(r, fac);
      const isDoor = (x, y) => doors.some((d) => d.x === x && d.y === y);
      if (fac && fac.type === 'zone') return partitionWalls(r, color, isDoor);
      const TALL = 58, TH_ = 0.16;
      const L = r.x, Tp = r.y, Rr = r.x + r.w - 1, B = r.y + r.h - 1;
      const wall = (x0, y0, x1, y1, face, win) => add((x0 + x1) / 2 + (y0 + y1) / 2, (ctx) => {
        const f = box(ctx, x0, y0, x1, y1, 0, TALL, { top: color, left: '#f4f5f7', right: '#e3e6eb' }, { outline: false });
        const fc = face === 'L' ? f.fL : f.fR;
        facePanel(ctx, fc, 0, 1, 0.9, 1, color); // garis warna di atas
        if (win) { facePanel(ctx, fc, 0.12, 0.88, 0.38, 0.8, '#ffffff'); facePanel(ctx, fc, 0.18, 0.82, 0.42, 0.76, '#a7d8ff'); }
      });
      const glass = (x0, y0, x1, y1) => add((x0 + x1) / 2 + (y0 + y1) / 2, (ctx) => {
        const g = box(ctx, x0, y0, x1, y1, 0, 28, { top: color, left: 'rgba(190,225,255,0.35)', right: 'rgba(170,210,245,0.3)' }, { outline: false });
        ctx.strokeStyle = color; ctx.lineWidth = 2.5;
        for (const f2 of [g.fL, g.fR]) { ctx.beginPath(); ctx.moveTo(f2[3].x, f2[3].y); ctx.lineTo(f2[2].x, f2[2].y); ctx.stroke(); }
        ctx.lineWidth = 1;
      });
      for (let x = L; x <= Rr; x++) if (!isDoor(x, Tp)) wall(x === L ? x + 1 - TH_ : x, Tp + 1 - TH_, x === Rr ? x + TH_ : x + 1, Tp + 1, 'L', (x - L) % 3 === 1);
      for (let y = Tp + 1; y <= B; y++) if (!isDoor(L, y)) wall(L + 1 - TH_, y, L + 1, y === B ? y + TH_ : y + 1, 'R', false);
      for (let y = Tp + 1; y < B; y++) if (!isDoor(Rr, y)) wall(Rr, y, Rr + TH_, y + 1, 'R', false);
      for (let x = L + 1; x <= Rr; x++) if (!isDoor(x, B)) glass(x, B, x === Rr ? x + TH_ : x + 1, B + TH_);
    };

    // Studio: ruangan divisi berdinding sekat kaca — rangka putih, tiang tiap tile, list warna divisi di atas
    const partitionWalls = (r, color, isDoor) => {
      const TH_ = 0.12, H = 46, HF = 30;
      const L = r.x, Tp = r.y, Rr = r.x + r.w - 1, B = r.y + r.h - 1;
      const pane = (x0, y0, x1, y1, h, side) => add((x0 + x1) / 2 + (y0 + y1) / 2, (ctx) => {
        // alas putih (plint), kaca, list warna di atas, tiang di ujung
        box(ctx, x0, y0, x1, y1, 0, 6, { top: '#ffffff', left: '#eef0f3', right: '#dfe3e8' }, { outline: false });
        const g = box(ctx, x0, y0, x1, y1, 6, h - 10, { top: 'rgba(255,255,255,0.4)', left: 'rgba(185,222,255,0.32)', right: 'rgba(165,205,240,0.28)' }, { outline: false });
        box(ctx, x0, y0, x1, y1, h - 4, 4, { top: color, left: shade(color, 0.92), right: shade(color, 0.78) }, { outline: false });
        const f = side === 'L' ? g.fL : g.fR;
        ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1;
        ctx.beginPath(); const a = onFace(f, 0.25, 0.15), b = onFace(f, 0.45, 0.85); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); // kilau kaca
        const px = side === 'L' ? [[x0, y0], [x1 - 0.05, y0]] : [[x0, y0], [x0, y1 - 0.05]];
        for (const [qx, qy] of px) box(ctx, qx, qy, qx + 0.05 + (side === 'L' ? 0 : TH_ - 0.05), qy + 0.05 + (side === 'L' ? TH_ - 0.05 : 0), 0, h, { top: '#ffffff', left: '#f4f5f7', right: '#e3e6eb' }, { outline: false });
      });
      for (let x = L; x <= Rr; x++) if (!isDoor(x, Tp)) pane(x, Tp + 0.5 - TH_ / 2, x + 1, Tp + 0.5 + TH_ / 2, H, 'L');
      for (let y = Tp; y <= B; y++) {
        if (!isDoor(L, y)) pane(L + 0.5 - TH_ / 2, y, L + 0.5 + TH_ / 2, y + 1, H, 'R');
        if (!isDoor(Rr, y)) pane(Rr + 0.5 - TH_ / 2, y, Rr + 0.5 + TH_ / 2, y + 1, H, 'R');
      }
      for (let x = L; x <= Rr; x++) if (!isDoor(x, B)) pane(x, B + 0.5 - TH_ / 2, x + 1, B + 0.5 + TH_ / 2, HF, 'L');
    };

    // Penthouse: dinding belakang kaca (pemandangan kota malam) diselingi pilar kayu
    // berlampu; dinding depan pagar kaca rendah; ruang rapat berdinding kaca penuh
    const luxeWalls = (r, fac) => {
      const doors = VO.doorTiles(r, fac);
      const isDoor = (x, y) => doors.some((d) => d.x === x && d.y === y);
      const type = fac && fac.type;
      const open = type === 'pool'; // teras terbuka: pagar kaca di semua sisi
      const TALL = 66, TH_ = 0.18;
      const L = r.x, Tp = r.y, Rr = r.x + r.w - 1, B = r.y + r.h - 1;
      const back = (x0, y0, x1, y1, kind, idx) => add((x0 + x1) / 2 + (y0 + y1) / 2, (ctx) => {
        if (open) return railing(ctx, x0, y0, x1, y1);
        const win = idx % 3 !== 0;
        const f = box(ctx, x0, y0, x1, y1, 0, TALL, win ? { top: '#2b2724', left: '#141b2c', right: '#101624' } : { top: '#2b2724', left: '#8b6a49', right: '#6d5136' }, { outline: false });
        const face = kind === 'top' ? f.fL : f.fR;
        if (win) skyline(ctx, face, kind === 'top' ? x0 : 1000 + y0);
        else {
          facePanel(ctx, face, 0.1, 0.9, 0.08, 0.92, kind === 'top' ? '#7d5e40' : '#634830'); // panel kayu
          facePanel(ctx, face, 0.4, 0.6, 0.6, 0.7, LX.gold); // lampu dinding
          const c = onFace(face, 0.5, 0.66);
          const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 22);
          g.addColorStop(0, 'rgba(255,205,130,0.55)'); g.addColorStop(1, 'rgba(255,205,130,0)');
          ctx.fillStyle = g; ctx.fillRect(c.x - 22, c.y - 22, 44, 44);
        }
        // kusen gelap
        facePanel(ctx, face, 0, 1, 0.94, 1, LX.frame);
        facePanel(ctx, face, 0, 1, 0, 0.05, '#3a2c20');
        facePanel(ctx, face, 0, 0.035, 0, 1, LX.frame);
      });
      const front = (x0, y0, x1, y1) => add((x0 + x1) / 2 + (y0 + y1) / 2, (ctx) => {
        if (type === 'meeting' || type === 'zone') { // dinding kaca penuh: ruang rapat & ruangan divisi/direktur
          const g = box(ctx, x0, y0, x1, y1, 0, type === 'zone' ? 56 : 50, { top: '#2b2f38', left: 'rgba(170,210,240,0.13)', right: 'rgba(150,190,230,0.11)' }, { outline: false });
          ctx.strokeStyle = 'rgba(220,235,255,0.35)'; ctx.lineWidth = 1;
          for (const f2 of [g.fL, g.fR]) { ctx.beginPath(); ctx.moveTo(f2[3].x, f2[3].y); ctx.lineTo(f2[2].x, f2[2].y); ctx.moveTo(f2[0].x, f2[0].y); ctx.lineTo(f2[3].x, f2[3].y); ctx.stroke(); }
          return;
        }
        railing(ctx, x0, y0, x1, y1);
      });
      for (let x = L; x <= Rr; x++) {
        if (isDoor(x, Tp)) continue;
        back(x === L ? x + 1 - TH_ : x, Tp + 1 - TH_, x === Rr ? x + TH_ : x + 1, Tp + 1, 'top', x - L);
      }
      for (let y = Tp + 1; y <= B; y++) {
        if (isDoor(L, y)) continue;
        back(L + 1 - TH_, y, L + 1, y === B ? y + TH_ : y + 1, 'left', y - Tp);
      }
      for (let x = L + 1; x <= Rr; x++) if (!isDoor(x, B)) front(x, B, x === Rr ? x + TH_ : x + 1, B + TH_);
      for (let y = Tp + 1; y < B; y++) if (!isDoor(Rr, y)) front(Rr, y, Rr + TH_, y + 1);
    };

    // Modern: sekat rendah putih + tiang tipis di sudut (kantor terbuka)
    const partitions = (r, fac) => {
      const doors = VO.doorTiles(r, fac);
      const isDoor = (x, y) => doors.some((d) => d.x === x && d.y === y);
      const H = 9, TH_ = 0.1;
      const L = r.x + 0.45, Tp = r.y + 0.45, Rr = r.x + r.w - 0.45, B = r.y + r.h - 0.45;
      const col = { top: '#ffffff', left: '#e6e9ef', right: '#d6dae2' };
      const seg = (x0, y0, x1, y1) => add((x0 + x1) / 2 + (y0 + y1) / 2, (ctx) => box(ctx, x0, y0, x1, y1, 0, H, col, { outline: false }));
      for (let x = r.x; x < r.x + r.w; x++) {
        const a = Math.max(L, x), b = Math.min(Rr, x + 1);
        if (b <= a) continue;
        if (!isDoor(x, r.y)) seg(a, Tp - TH_, b, Tp + TH_);
        if (!isDoor(x, r.y + r.h - 1)) seg(a, B - TH_, b, B + TH_);
      }
      for (let y = r.y; y < r.y + r.h; y++) {
        const a = Math.max(Tp, y), b = Math.min(B, y + 1);
        if (b <= a) continue;
        if (!isDoor(r.x, y)) seg(L - TH_, a, L + TH_, b);
        if (!isDoor(r.x + r.w - 1, y)) seg(Rr - TH_, a, Rr + TH_, b);
      }
      for (const [px, py] of [[L, Tp], [Rr, Tp], [L, B], [Rr, B]])
        add(px + py + 0.01, (ctx) => box(ctx, px - 0.05, py - 0.05, px + 0.05, py + 0.05, 0, 64, { top: '#c9ced8', left: '#d5d9e1', right: '#bfc5d0' }, { outline: false }));
    };

    for (const f of s.facilities) {
      walls(f, f.color, f);
      facilityProps(s, f, add);
    }
    const OPEN = VO.openPlan(s);
    const STU = studio();
    // open plan: satu ruangan untuk tiap divisi (direktur + semua departemennya)
    if (OPEN) for (const div of s.divisions) walls(div.zone, div.color, { type: 'zone' }); // Studio: sekat kaca per divisi
    if (STU) studioShell(s, add);
    for (const d of s.departments) {
      const div = s.divisions.find((x) => x.id === d.divisionId);
      if (STU) { // zona departemen: sekat rendah putih bergaris warna di sisi belakang
        const col = shade(deptColor(s, d), 0.85);
        for (let x = d.room.x; x < d.room.x + d.room.w; x++) {
          const x0 = Math.max(x, d.room.x + 0.2), x1 = Math.min(x + 1, d.room.x + d.room.w - 0.2);
          add(x0 / 2 + x1 / 2 + d.room.y + 0.7, (ctx) => { const b = box(ctx, x0, d.room.y + 0.62, x1, d.room.y + 0.76, 0, 16, { top: col, left: '#f7f8fa', right: '#e6e9ee' }, { outline: false }); facePanel(ctx, b.fL, 0, 1, 0.75, 1, col); });
        }
      } else if (!OPEN) walls(d.room, div ? div.color : '#888888', null);
      const members = VO.deptAgents(s, d.id);
      if (luxe() && d.room.w >= 5) {
        // papan tugas besar di dinding: daftar permintaan tugas dari atasan untuk departemen ini.
        // Digambar per kolom (dipotong per tile) agar urutan kedalaman benar dengan direktur/kursi di depannya.
        const bw = Math.min(d.room.w - 1, 6), bx = d.room.x + (d.room.w - bw) / 2;
        const wy = OPEN && div ? div.zone.y + 0.98 : d.room.y + 0.98;
        for (let c = Math.floor(bx); c < bx + bw; c++)
          add(c + wy + 0.62, (ctx, now, st) => {
            const L = iso(Math.max(c, bx), wy).x, Rt = iso(Math.min(c + 1, bx + bw), wy).x;
            ctx.save(); ctx.beginPath(); ctx.rect(Math.min(L, Rt) - (c <= bx ? 4 : 0), -1e5, Math.abs(Rt - L) + (c <= bx ? 4 : 0) + (c + 1 >= bx + bw ? 4 : 0), 2e5); ctx.clip();
            drawTaskBoard(ctx, bx, wy, bw, st, d, now, div ? div.color : '#7fb2ff');
            ctx.restore();
          });
      }
      VO.deskSlots(d.room).forEach((sl, i) => {
        // meja pertama milik ketua tim (manager): meja L khusus + kursi eksekutif sebagai pembeda
        const mgr = i === 0 && members[0] && members[0].isLead;
        add(sl.desk.x + sl.desk.y + 1, (ctx, now) => mgr ? drawManagerDesk(ctx, sl.desk.x, sl.desk.y, now, members[0]) : drawDesk(ctx, sl.desk.x, sl.desk.y, now, members[i], modern() ? '#ffffff' : '#a47148'));
        add(sl.chair.x + sl.chair.y + 0.9, (ctx) => drawChair(ctx, sl.chair.x, sl.chair.y, mgr));
        add(sl.chair.x + sl.chair.y + 1.3, (ctx) => drawChairBack(ctx, sl.chair.x, sl.chair.y, mgr));
      });
    }
    for (const div of s.divisions) {
      const dd = div.directorDesk;
      add(dd.x + dd.y + 1, (ctx, now) => drawDesk(ctx, dd.x, dd.y, now, VO.director(s, div.id), robot() ? '#e6e9fb' : modern() ? '#ece8f5' : '#6d4c7d', OPEN));
      if (OPEN) { // kursi eksekutif di belakang meja, direktur menghadap timnya
        add(dd.x + dd.y - 1 + 0.8, (ctx) => drawExecChair(ctx, dd.x, dd.y - 1));
        continue;
      }
      add(dd.x + dd.y + 1.9, (ctx) => drawChair(ctx, dd.x, dd.y + 1));
      add(dd.x + dd.y + 2.3, (ctx) => drawChairBack(ctx, dd.x, dd.y + 1));
    }
    for (const fu of s.furniture) add(fu.x + fu.y + 1, (ctx) => drawFurniture(ctx, fu));
    const pc = document.createElement('canvas').getContext('2d');
    for (const p of props) {
      if (p.fixed != null) continue;
      PROBE = [];
      try { p.d(pc, 0, s); } catch (e) {}
      let ax = 0, ay = 0, n = PROBE.length / 2;
      for (let i = 0; i < PROBE.length; i += 2) { ax += PROBE[i]; ay += PROBE[i + 1]; }
      p.ax = n ? ax / n : 0; p.ay = n ? ay / n : 0;
      PROBE = null;
    }
    rekey();
  }
  // urutkan ulang objek sesuai arah kamera (dipanggil saat kamera diputar)
  function rekey() {
    for (const p of props) p.k = p.fixed != null ? -1e9 + p.fixed : depthOf(p.ax, p.ay);
    props.sort((a, b) => a.k - b.k);
  }

  // Kerangka gedung tema Studio: dinding kiri & belakang, pagar tepi mezanin, tangga
  function studioShell(s, add) {
    const mw = s.map.w, mh = s.map.h;
    const mz = VO.mezz(s);
    const M = mz ? mz.M : 0;
    // dinding samping kiri & kanan simetris (lantai 1 + lantai 2), berjendela seperti office_ai_expanded_v2
    for (const side of [-1, 1]) {
      const x0 = side < 0 ? -0.35 : mw, x1 = side < 0 ? 0 : mw + 0.35;
      add(-1000 + (side > 0 ? 0.5 : 0), (ctx) => {
        const W = { top: '#c9ced6', left: '#eceef1', right: '#f3f4f6' };
        // dinding penuh hanya bila sisi dalamnya menghadap kamera (gaya rumah boneka); selain itu cukup plint rendah
        const inside = side < 0 ? SYA > 0.05 : SYA < -0.05;
        if (!inside) { box(ctx, x0, 0, x1, mh, 0, 8, W, { outline: false }); return; }
        const g = box(ctx, x0, mz ? M + 0.002 : 0, x1, mh, 0, mz ? ZM : 64, W, { outline: false });
        facePanel(ctx, g.fR, 0, 1, 0, 0.07, '#d6dae0'); // plint
        const n = Math.max(1, Math.floor((mh - M) / 6));
        for (let i = 0; i < n; i++) { const u0 = (i + 0.25) / n, u1 = (i + 0.75) / n; facePanel(ctx, g.fR, u0, u1, 0.3, 0.84, '#ffffff'); studioWindow(ctx, g.fR, u0 + 0.012, u1 - 0.012, 0.34, 0.8, i + (side > 0 ? 7 : 0)); }
        if (mz) {
          const u = box(ctx, x0, 0, x1, M, 0, 66, W, { outline: false });
          facePanel(ctx, u.fR, 0.25, 0.75, 0.32, 0.84, '#ffffff'); studioWindow(ctx, u.fR, 0.265, 0.735, 0.36, 0.8, side > 0 ? 3 : 1);
        }
      });
    }
    // meja resepsionis "OFFICE AI" di depan-tengah + tanaman di sudut depan (seperti office_ai_expanded_v2)
    const rc = VO.studioFront && VO.studioFront(s);
    if (rc) {
      add(rc.desk.x + rc.desk.y + 1.5, (ctx) => {
        const d = rc.desk;
        const b = box(ctx, d.x, d.y + 0.15, d.x + d.w, d.y + 0.85, 0, 26, { top: '#f4f1ea', left: '#3f9a8f', right: '#2f7f75' }, { outline: false });
        for (let i = 0; i < 14; i++) facePanel(ctx, b.fL, 0.03 + i * 0.07, 0.06 + i * 0.07, 0.08, 0.72, 'rgba(255,255,255,0.18)'); // lamel
        box(ctx, d.x - 0.05, d.y + 0.1, d.x + d.w + 0.05, d.y + 0.9, 26, 3, { top: '#ffffff', left: '#e3e6eb', right: '#d4d8de' }, { outline: false });
        const lp = box(ctx, d.x + d.w / 2 - 0.3, d.y + 0.35, d.x + d.w / 2 + 0.3, d.y + 0.4, 29, 11, '#2b3140', { outline: false });
        facePanel(ctx, lp.fL, 0.08, 0.92, 0.12, 0.88, '#7fd3ff');
        const p = iso(d.x + d.w / 2, d.y + 0.85, 12);
        ctx.save(); ctx.font = "bold 9px 'Courier New', ui-monospace, monospace"; try { ctx.letterSpacing = '2px'; } catch (e) {}
        const tw = ctx.measureText('OFFICE AI').width;
        ctx.fillStyle = '#ffffff'; ctx.fillText('OFFICE AI', p.x - tw / 2, p.y + 3); ctx.restore();
      });
      for (const pl of rc.plants) add(pl.x + pl.y + 1, (ctx) => drawFurniture(ctx, { type: 'plant', x: pl.x, y: pl.y }));
    }
    if (!mz) return;
    add(-999, (ctx) => { // dinding belakang lantai 2 (hanya bila dilihat dari depan)
      if (CYA < 0.05) { box(ctx, 0, -0.35, mw, 0, 0, 8, { top: '#d5d9df', left: '#f4f5f7', right: '#e3e6eb' }, { outline: false }); return; }
      const g = box(ctx, 0, -0.35, mw, 0, 0, 64, { top: '#d5d9df', left: '#f4f5f7', right: '#e3e6eb' }, { outline: false });
      for (let x = 4; x < mw - 3; x += 7) { facePanel(ctx, g.fL, x / mw, (x + 3) / mw, 0.21, 0.9, '#667f79'); studioWindow(ctx, g.fL, (x + 0.1) / mw, (x + 2.9) / mw, 0.25, 0.86, x); }
    });
    add(-998, (ctx) => { // dinding depan hanya saat kamera di belakang gedung
      if (CYA > -0.05) return;
      const g = box(ctx, 0, mh, mw, mh + 0.35, 0, 64, { top: '#c9ced6', left: '#eceef1', right: '#f3f4f6' }, { outline: false });
      for (let x = 3; x < mw - 3; x += 7) { facePanel(ctx, g.fL, x / mw, (x + 3) / mw, 0.3, 0.84, '#ffffff'); studioWindow(ctx, g.fL, (x + 0.1) / mw, (x + 2.9) / mw, 0.34, 0.8, x); }
    });
    // pagar kaca tepi mezanin (kecuali di mulut tangga)
    for (let x = 0; x < mw; x++) {
      if (x >= mz.sx && x <= mz.sx + 1) continue;
      add(x + M - 0.2, (ctx) => {
        const g = box(ctx, x, M - 0.1, x + 1, M - 0.02, 0, 22, { top: '#2f3440', left: 'rgba(190,225,255,0.3)', right: 'rgba(170,210,245,0.25)' }, { outline: false });
        ctx.strokeStyle = '#2f3440'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(g.fL[3].x, g.fL[3].y); ctx.lineTo(g.fL[2].x, g.fL[2].y); ctx.stroke();
        ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(g.fL[0].x, g.fL[0].y); ctx.lineTo(g.fL[3].x, g.fL[3].y); ctx.stroke(); ctx.lineWidth = 1;
      });
    }
    // tangga kayu turun ke lantai 1
    const sx = mz.sx;
    for (let i = 0; i < 6; i++) {
      const y0 = M + i * 0.5, y1 = y0 + 0.5, zt = (ZM * (5.6 - i)) / 6;
      add(sx + 1 + y1, (ctx) => { ELEV_OFF = true; box(ctx, sx + 0.05, y0, sx + 1.95, y1, 0, Math.max(3, zt), { top: '#d8b787', left: '#c79f6d', right: '#b38c5c' }, { outline: false }); ELEV_OFF = false; });
    }
    add(sx + 2 + M + 3.1, (ctx) => { // pegangan tangga
      ELEV_OFF = true;
      ctx.strokeStyle = '#2f3440'; ctx.lineWidth = 2;
      for (const x of [sx + 0.05, sx + 1.95]) {
        const a = iso(x, M - 0.05, ZM + 22), b = iso(x, M + 3, 22);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        for (let k = 0; k <= 3; k++) { const p = iso(x, M + k, ZM * (3 - k) / 3), q = iso(x, M + k, ZM * (3 - k) / 3 + 22); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); }
      }
      ctx.lineWidth = 1; ELEV_OFF = false;
    });
  }

  // Cached architectural details; windows are part of the existing wall props.
  function studioWindow(ctx, face, u0, u1, v0, v1, seed) {
    const a = onFace(face, u0, v1), b = onFace(face, u1, v0);
    const sky = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    sky.addColorStop(0, '#99bcb9'); sky.addColorStop(0.55, '#d1e3dc'); sky.addColorStop(1, '#f1e9cf');
    facePanel(ctx, face, u0, u1, v0, v1, sky);
    const du = (u1 - u0) / 9, dv = v1 - v0;
    for (let i = 0; i < 9; i++) {
      const h = 0.15 + hash(seed, i) * 0.38;
      facePanel(ctx, face, u0 + i * du, u0 + (i + 0.82) * du, v0, v0 + dv * h, i % 2 ? '#8aa9a4' : '#a6beb6');
    }
    facePanel(ctx, face, u0 + (u1 - u0) * 0.49, u0 + (u1 - u0) * 0.51, v0, v1, '#667f79');
    poly(ctx, [onFace(face, u0, v1), onFace(face, u0 + (u1-u0)*0.35, v1), onFace(face, u0 + (u1-u0)*0.75, v0), onFace(face, u0 + (u1-u0)*0.6, v0)], 'rgba(255,255,255,0.22)');
  }

  // Pemandangan kota malam di permukaan dinding kaca (seed = posisi agar menyambung)
  function skyline(ctx, face, seed) {
    const sky = (u0, u1, v0, v1, c) => facePanel(ctx, face, u0, u1, v0, v1, c);
    sky(0, 1, 0, 1, '#1b2a4a');
    sky(0, 1, 0.55, 1, '#22355c');
    sky(0, 1, 0.8, 1, '#2c4470');
    for (let i = 0; i < 3; i++) {
      const u0 = i / 3 + hash(seed, i) * 0.08, u1 = u0 + 0.22 + hash(seed, i + 9) * 0.1;
      const top = 0.25 + hash(seed, i + 3) * 0.55;
      const far = i % 2 === 0;
      sky(u0, Math.min(1, u1), 0, top, far ? '#121b30' : '#0c1324');
      // jendela gedung yang menyala
      for (let r = 0; r < 7; r++) for (let c = 0; c < 3; c++) {
        const v = 0.06 + r * 0.1;
        if (v + 0.05 > top) break;
        if (hash(seed * 3 + i, r * 5 + c) < 0.45) continue;
        const uu = u0 + 0.03 + c * ((Math.min(1, u1) - u0 - 0.06) / 3);
        sky(uu, uu + 0.04, v, v + 0.04, hash(seed + r, c) > 0.8 ? '#9fd3ff' : '#ffd88a');
      }
    }
    // pantulan kaca
    ctx.save(); ctx.globalAlpha = 0.12; sky(0.55, 0.7, 0.1, 1, '#ffffff'); ctx.restore();
  }

  // Pagar kaca rendah dengan pegangan gelap
  function railing(ctx, x0, y0, x1, y1) {
    const g = box(ctx, x0, y0, x1, y1, 0, 17, { top: '#3a3f4a', left: 'rgba(180,215,240,0.2)', right: 'rgba(160,200,230,0.17)' }, { outline: false });
    ctx.strokeStyle = '#2a2e36'; ctx.lineWidth = 2;
    for (const f2 of [g.fL, g.fR]) { ctx.beginPath(); ctx.moveTo(f2[3].x, f2[3].y); ctx.lineTo(f2[2].x, f2[2].y); ctx.stroke(); }
    ctx.lineWidth = 1;
  }

  function facilityProps(s, f, add) {
    if (f.type === 'boss') {
      bossProps(s, f, add);
    } else if (f.type === 'meeting') {
      const t = VO.meetingTable(f);
      for (let y = t.y; y < t.y + t.h; y++)
        for (let x = t.x; x < t.x + t.w; x++)
          add(x + y + 1, (ctx) => {
            box(ctx, x - (x === t.x ? -0.1 : 0), y - (y === t.y ? -0.1 : 0), x + 1 - (x === t.x + t.w - 1 ? 0.1 : 0), y + 1 - (y === t.y + t.h - 1 ? 0.1 : 0), 0, 14,
              robot() ? { top: '#ffffff', left: '#dfe2f0', right: '#c9cee3' } : classic() ? { top: CL.desk, left: '#ddd2b6', right: '#cbbf9f' } : luxe() ? LX.walnut : { top: '#8a6648', left: '#6b4f3a', right: '#56402f' }, { outline: false });
          });
      for (const p of VO.sim.spots(s, 'meeting'))
        add(p.x + p.y + 0.9, (ctx) => box(ctx, p.x + 0.28, p.y + 0.28, p.x + 0.72, p.y + 0.72, 0, 7, robot() ? NAVY : classic() ? CL.chair : luxe() ? LX.chair : '#3a3f4b'));
      // layar presentasi di dinding belakang
      add(f.x + f.w / 2 + f.y + (luxe() ? 3.6 : 1.2), (ctx, now, st) => {
        if (luxe()) return wallTV(ctx, f.x + f.w / 2 - 2, f.y + 0.98, 4, st, now);
        const b = box(ctx, f.x + f.w / 2 - 1.5, f.y + 0.95, f.x + f.w / 2 + 1.5, f.y + 1.02, 18, 22, '#22252c');
        facePanel(ctx, b.fL, 0.06, 0.94, 0.12, 0.88, '#4fc3f7');
      });
    } else if (f.type === 'pantry') {
      for (let x = f.x + 1; x < f.x + f.w - 1; x++) {
        const y = f.y + 1;
        add(x + y + 1, (ctx) => {
          box(ctx, x, y + 0.1, x + 1, y + 0.9, 0, 18, robot() ? { top: '#ffffff', left: NAVY, right: '#1f2aa8' } : luxe() ? { top: '#efe9e0', left: '#5a3a24', right: '#462c1a' } : { top: '#d5d9df', left: '#9aa1ad', right: '#858c98' });
          if (x === f.x + 1) { // mesin kopi
            const b = box(ctx, x + 0.25, y + 0.25, x + 0.75, y + 0.65, 18, 16, '#2a2a2e');
            facePanel(ctx, b.fL, 0.3, 0.7, 0.55, 0.75, '#e53935');
          }
          if (x === f.x + f.w - 2) box(ctx, x + 0.1, y + 0.15, x + 0.9, y + 0.85, 18, 26, '#eceff1'); // kulkas
          if (x === f.x + 3) { const p = iso(x + 0.5, y + 0.5, 18); ctx.fillStyle = '#ffb74d'; ctx.beginPath(); ctx.arc(p.x, p.y - 3, 4, 0, 7); ctx.fill(); }
        });
      }
      for (let i = 0; i < Math.floor((f.w - 2) / 3); i++) {
        const x = f.x + 2 + i * 3, y = f.y + f.h - 3;
        add(x + y + 1, (ctx) => {
          if (luxe()) { // meja bar bundar + bangku
            box(ctx, x + 0.45, y + 0.45, x + 0.55, y + 0.55, 0, 14, '#2a2b30', { outline: false });
            const p = iso(x + 0.5, y + 0.5, 14);
            ctx.fillStyle = '#5a3a24'; ctx.beginPath(); ctx.ellipse(p.x, p.y + 1.5, 15, 7.5, 0, 0, 7); ctx.fill();
            ctx.fillStyle = '#6f4a2e'; ctx.beginPath(); ctx.ellipse(p.x, p.y, 15, 7.5, 0, 0, 7); ctx.fill();
            return;
          }
          box(ctx, x + 0.2, y + 0.2, x + 0.8, y + 0.8, 0, 13, { top: '#efebe9', left: '#bcaaa4', right: '#a1887f' });
        });
      }
    } else if (f.type === 'lounge') {
      add(f.x + 2 + f.y + 1.5, (ctx) => drawFurniture(ctx, { type: 'sofa', x: f.x + 2, y: f.y + 1 }));
      add(f.x + 4 + f.y + 1.5, (ctx) => drawFurniture(ctx, { type: 'sofa', x: f.x + 4, y: f.y + 1 }));
      add(f.x + f.w - 1.5 + f.y + 1.5, (ctx) => drawFurniture(ctx, { type: 'arcade', x: f.x + f.w - 2, y: f.y + 1 }));
      if (luxe()) add(f.x + 3.5 + f.y + 3, (ctx) => {
        const b = box(ctx, f.x + 2.6, f.y + 2.6, f.x + 4.4, f.y + 3.4, 0, 8, LX.walnut);
        poly(ctx, diamond(f.x + 3.2, f.y + 2.8, 0.4, 0.3, 8), '#f5f5f5');
        return b;
      });
    } else if (f.type === 'billiard') {
      billiardProps(s, f, add);
    } else if (f.type === 'pool') {
      const w = VO.poolWater(f);
      VO.poolLoungers(f).forEach((l, i) => {
        add(l.x + l.y + 1, (ctx) => drawLounger(ctx, l.x, l.y));
        if (i % 2 === 0) add(l.x + l.y + 1.6, (ctx) => drawUmbrella(ctx, l.x - 0.15, l.y + 1));
      });
      // lampu taman di sudut kolam
      for (const [lx, ly] of [[w.x - 0.6, w.y - 0.6], [w.x + w.w + 0.3, w.y - 0.6], [w.x - 0.6, w.y + w.h + 0.3], [w.x + w.w + 0.3, w.y + w.h + 0.3]])
        add(lx + ly + 0.6, (ctx) => drawGardenLamp(ctx, lx, ly));
    }
  }

  // Kursi eksekutif: sandaran tinggi di belakang (sisi -ty), duduk menghadap ke depan
  function drawExecChair(ctx, cx, cy) {
    box(ctx, cx + 0.2, cy + 0.15, cx + 0.8, cy + 0.3, 0, 30, robot() ? '#1f2aa8' : classic() ? CL.chairBack : luxe() ? '#1b1d22' : '#3b2418');
    box(ctx, cx + 0.22, cy + 0.25, cx + 0.78, cy + 0.8, 7, 5, robot() ? NAVY : classic() ? CL.chair : luxe() ? '#26282f' : '#5a3826');
  }

  /* ---------- Ruang Boss berteknologi: meja kaca gelap ber-LED + laptop di kanan ruangan, video wall ---------- */
  const CY = '#35e0ff';
  function bossProps(s, f, add) {
    const seat = VO.bossSeat(s);
    const dx = seat.desk.x, dy = seat.desk.y;
    const TOP = robot() ? '#ffffff' : '#1d2330', SIDE_L = robot() ? NAVY : '#141924', SIDE_R = robot() ? '#1f2aa8' : '#0f131c';
    for (let i = -1; i <= 1; i++)
      add(dx + i + dy + 1, (ctx, now) => {
        const x0 = dx + i + (i === -1 ? 0.05 : 0), x1 = dx + i + 1 - (i === 1 ? 0.05 : 0);
        // kaki logam ramping di ujung meja
        if (i !== 0) box(ctx, i === -1 ? x0 + 0.08 : x1 - 0.2, dy + 0.3, i === -1 ? x0 + 0.2 : x1 - 0.08, dy + 0.7, 0, 12, '#3a4150', { outline: false });
        const b = box(ctx, x0, dy + 0.14, x1, dy + 0.86, 12, 6, { top: TOP, left: SIDE_L, right: SIDE_R }, { outline: false });
        const pulse = 0.65 + Math.sin(now / 500) * 0.35;
        ctx.save(); ctx.globalAlpha = pulse;
        facePanel(ctx, b.fL, 0, 1, 0.1, 0.32, CY); // strip LED depan
        if (i === 1) facePanel(ctx, b.fR, 0, 1, 0.1, 0.32, CY);
        ctx.restore();
        poly(ctx, diamond(x0 + 0.04, dy + 0.18, x1 - x0 - 0.08, 0.64, 18), 'rgba(120,200,255,0.08)'); // kilau kaca
        if (i === 0) { // hanya laptop: alas di depan Boss, layar menghadap Boss (dari depan terlihat punggungnya)
          box(ctx, dx + 0.2, dy + 0.22, dx + 0.8, dy + 0.6, 18, 1.5, { top: '#cfd2d9', left: '#aeb2bb', right: '#9a9ea8' }, { outline: false });
          poly(ctx, diamond(dx + 0.27, dy + 0.27, 0.46, 0.18, 19.6), '#2a2f3a'); // keyboard
          const lid = box(ctx, dx + 0.2, dy + 0.58, dx + 0.8, dy + 0.62, 19, 15, { top: '#c4c8d0', left: '#b7bbc4', right: '#a3a7b1' }, { outline: false });
          const c = onFace(lid.fL, 0.5, 0.55);
          ctx.fillStyle = alpha(CY, 0.35 + 0.25 * Math.sin(now / 700)); ctx.beginPath(); ctx.arc(c.x, c.y, 2.4, 0, 7); ctx.fill(); // logo menyala
          // pantulan cahaya layar ke Boss
          const g = iso(dx + 0.5, dy + 0.4, 30);
          const gl = ctx.createRadialGradient(g.x, g.y, 0, g.x, g.y, 18);
          gl.addColorStop(0, alpha(CY, 0.14)); gl.addColorStop(1, alpha(CY, 0));
          ctx.fillStyle = gl; ctx.fillRect(g.x - 18, g.y - 18, 36, 36);
        }
      });
    // kursi eksekutif
    add(seat.chair.x + seat.chair.y + 0.8, (ctx) => drawExecChair(ctx, seat.chair.x, seat.chair.y));
    // video wall di dinding belakang: dashboard kantor real-time
    const vx1 = Math.min(seat.chair.x + 2, f.x + f.w - 1), vx0 = Math.max(f.x + 2, vx1 - 5);
    add(seat.chair.x + seat.chair.y + 0.95, (ctx, now, st) => drawVideoWall(ctx, vx0, f.y + 0.97, vx1 - vx0, st, now));
    // sofa tamu, meja kopi, meja meeting kecil, kursi, tanaman
    for (const it of VO.bossExtras(f)) {
      const n = it.len || 1;
      add(it.x + it.y + n - 1 + 1 + (it.kind === 'coffee' ? 0.05 : 0), (ctx, now) => {
        if (it.kind === 'sofa') drawSideSofa(ctx, it.x, it.y, n);
        else if (it.kind === 'coffee') drawCoffeeTable(ctx, it.x, it.y, n);
        else if (it.kind === 'mtable') drawRoundTable(ctx, it.x, it.y);
        else if (it.kind === 'tub') drawTubChair(ctx, it.x, it.y);
        else drawFurniture(ctx, { type: 'plant', x: it.x, y: it.y });
      });
    }
    // server rack berkedip di pojok kiri & tanaman di kanan
    add(f.x + 1.5 + f.y + 1.5, (ctx, now) => drawServerRack(ctx, f.x + 1, f.y + 1, now));
    add(f.x + f.w - 1.5 + f.y + 1.5, (ctx) => drawFurniture(ctx, { type: 'plant', x: f.x + f.w - 2, y: f.y + 1 }));
  }

  // Sofa tamu memanjang searah sumbu y, sandaran di sisi -x (menghadap ke tengah ruangan)
  function drawSideSofa(ctx, x, y, n) {
    const C = luxe() ? { base: '#e8dcc5', back: '#d8caad' } : robot() ? { base: '#ffffff', back: NAVY } : classic() ? { base: '#3d63d8', back: '#2f50c2' } : modern() ? { base: '#c9ced8', back: '#b3b9c6' } : { base: '#4a5068', back: '#3b4056' };
    const sh = [iso(x + 0.1, y + 0.1), iso(x + 0.95, y + 0.1), iso(x + 0.95, y + n - 0.05), iso(x + 0.1, y + n - 0.05)];
    poly(ctx, sh.map((p) => ({ x: p.x + 3, y: p.y + 4 })), 'rgba(0,0,0,0.15)');
    box(ctx, x + 0.1, y + 0.08, x + 0.3, y + n - 0.08, 0, 24, { base: C.back }); // sandaran
    box(ctx, x + 0.25, y + 0.12, x + 0.9, y + n - 0.12, 0, 10, { base: C.base }); // dudukan
    for (let i = 0; i < n; i++) box(ctx, x + 0.3, y + i + 0.18, x + 0.86, y + i + 0.92, 10, 3, { base: mix(C.base, '#ffffff', 0.12) }, { outline: false }); // bantal
    box(ctx, x + 0.1, y + 0.05, x + 0.9, y + 0.2, 0, 16, { base: C.back }); // lengan
    box(ctx, x + 0.1, y + n - 0.2, x + 0.9, y + n - 0.05, 0, 16, { base: C.back });
    // bantal hias
    box(ctx, x + 0.3, y + 0.35, x + 0.45, y + 0.75, 10, 10, { base: luxe() ? LX.gold : CORAL }, { outline: false });
  }

  // Meja kopi kaca dengan kaki logam, buku & cangkir
  function drawCoffeeTable(ctx, x, y, n) {
    for (const [lx, ly] of [[0.3, 0.35], [0.7, 0.35], [0.3, n - 0.35], [0.7, n - 0.35]]) box(ctx, x + lx - 0.03, y + ly - 0.03, x + lx + 0.03, y + ly + 0.03, 0, 9, '#8f96a3', { outline: false });
    box(ctx, x + 0.22, y + 0.3, x + 0.78, y + n - 0.3, 9, 2, { top: 'rgba(170,225,255,0.55)', left: 'rgba(120,180,220,0.6)', right: 'rgba(100,160,200,0.6)' }, { outline: false });
    poly(ctx, diamond(x + 0.35, y + 0.55, 0.3, 0.4, 11), '#c0392b'); // buku
    poly(ctx, diamond(x + 0.37, y + 0.58, 0.26, 0.34, 12.5), '#f5f0e6');
    box(ctx, x + 0.45, y + n - 0.7, x + 0.55, y + n - 0.6, 11, 4, '#ffffff', { outline: false }); // cangkir
  }

  // Meja meeting bundar kecil dengan laptop & kopi
  function drawRoundTable(ctx, x, y) {
    const c = iso(x + 0.5, y + 0.5);
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.beginPath(); ctx.ellipse(c.x + 2, c.y + 2, 22, 11, 0, 0, 7); ctx.fill();
    box(ctx, x + 0.44, y + 0.44, x + 0.56, y + 0.56, 0, 14, '#3a3f4b', { outline: false });
    const top = luxe() ? '#6f4a2e' : robot() ? '#ffffff' : classic() ? CL.desk : modern() ? '#ffffff' : '#8a6648';
    const p = iso(x + 0.5, y + 0.5, 14);
    ctx.fillStyle = shade(top, 0.8); ctx.beginPath(); ctx.ellipse(p.x, p.y + 2, 26, 13, 0, 0, 7); ctx.fill();
    ctx.fillStyle = top; ctx.beginPath(); ctx.ellipse(p.x, p.y, 26, 13, 0, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.15)'; ctx.stroke();
    // laptop terbuka & dua cangkir
    poly(ctx, diamond(x + 0.3, y + 0.35, 0.3, 0.22, 14), '#c9ccd3');
    const lid = box(ctx, x + 0.3, y + 0.33, x + 0.6, y + 0.36, 14, 9, '#b9bcc4', { outline: false });
    facePanel(ctx, lid.fR, 0.1, 0.9, 0.15, 0.9, '#7fd3ff');
    box(ctx, x + 0.62, y + 0.6, x + 0.7, y + 0.68, 14, 4, '#ffffff', { outline: false });
    box(ctx, x + 0.25, y + 0.68, x + 0.33, y + 0.76, 14, 4, '#ffffff', { outline: false });
  }

  // Kursi tub bundar modern (tanpa arah)
  function drawTubChair(ctx, x, y) {
    const C = luxe() ? '#2b2e36' : robot() ? NAVY : classic() ? CL.chair : modern() ? '#7f8ba0' : '#3a3f4b';
    const p = iso(x + 0.5, y + 0.5);
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.beginPath(); ctx.ellipse(p.x, p.y + 1, 12, 6, 0, 0, 7); ctx.fill();
    ctx.fillStyle = shade(C, 0.75); ctx.beginPath(); ctx.ellipse(p.x, p.y - 4, 11, 5.5, 0, 0, Math.PI); ctx.lineTo(p.x - 11, p.y - 10); ctx.ellipse(p.x, p.y - 10, 11, 5.5, 0, Math.PI, 0, true); ctx.closePath(); ctx.fill();
    ctx.fillStyle = C; ctx.beginPath(); ctx.ellipse(p.x, p.y - 10, 11, 5.5, 0, 0, 7); ctx.fill();
    ctx.fillStyle = luxe() ? '#e8dcc5' : shade(C, 1.25); ctx.beginPath(); ctx.ellipse(p.x, p.y - 10.5, 7.5, 3.6, 0, 0, 7); ctx.fill();
    ctx.fillStyle = shade(C, 0.9); ctx.beginPath(); ctx.ellipse(p.x, p.y - 14, 11, 5.5, 0, Math.PI, 0); ctx.lineTo(p.x + 11, p.y - 10); ctx.ellipse(p.x, p.y - 10, 11, 5.5, 0, 0, Math.PI, true); ctx.closePath(); ctx.fill(); // sandaran melingkar belakang
  }

  function drawVideoWall(ctx, x, y, w, s, now) {
    const b = box(ctx, x, y, x + w, y + 0.05, 18, 50, '#07090f', { outline: false });
    const done = s.tasks.filter((t) => t.status === 'done').length;
    const busy = s.agents.filter((a) => VO.sim.isBusy(a.id)).length;
    const active = s.tasks.find((t) => !['done', 'failed'].includes(t.status));
    // 3 panel: KPI · grafik · jam
    const P = [[0.02, 0.32], [0.34, 0.66], [0.68, 0.98]];
    P.forEach(([u0, u1], i) => facePanel(ctx, b.fL, u0, u1, 0.05, 0.95, ['#0c1a2e', '#0a1424', '#0c1a2e'][i]));
    const glow = 0.85 + Math.sin(now / 900) * 0.15;
    // grafik area di panel tengah
    ctx.save(); ctx.globalAlpha = glow;
    ctx.beginPath();
    for (let k = 0; k <= 16; k++) {
      const u = 0.36 + k * (0.28 / 16), v = 0.18 + 0.35 * (0.5 + 0.5 * Math.sin(now / 1200 + k * 0.7)) * (0.6 + k / 40);
      const p = onFace(b.fL, u, v); k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
    }
    const e1 = onFace(b.fL, 0.64, 0.1), e0 = onFace(b.fL, 0.36, 0.1);
    ctx.lineTo(e1.x, e1.y); ctx.lineTo(e0.x, e0.y); ctx.closePath();
    ctx.fillStyle = alpha(CY, 0.25); ctx.fill();
    ctx.strokeStyle = CY; ctx.lineWidth = 1.3; ctx.stroke(); ctx.lineWidth = 1;
    for (let k = 0; k < 8; k++) facePanel(ctx, b.fL, 0.05 + k * 0.032, 0.07 + k * 0.032, 0.1, 0.12 + ((Math.sin(now / 800 + k) + 1) / 2) * 0.16, k % 2 ? '#ff6fb1' : '#7cf29a');
    ctx.restore();
    if (FLAT) return; // teks hanya di tampilan 3D
    const px = w * 32;
    const F = (sz) => `bold ${sz}px Inter, system-ui, sans-serif`;
    faceText(ctx, b.fL, 0.04, 0.84, 'TUNTAS', F(5.5), '#7fb2ff');
    faceText(ctx, b.fL, 0.04, 0.5, String(done), F(14), '#ffffff', px * 0.14);
    faceText(ctx, b.fL, 0.19, 0.84, 'SIBUK', F(5.5), '#7fb2ff');
    faceText(ctx, b.fL, 0.19, 0.5, `${busy}`, F(14), '#7cf29a', px * 0.13);
    faceText(ctx, b.fL, 0.37, 0.84, active ? 'SEDANG BERJALAN' : 'KINERJA KANTOR', F(6), '#ffb347', px * 0.27);
    faceText(ctx, b.fL, 0.37, 0.7, active ? active.title : (s.company && s.company.name) || 'Kantor AI', F(8), '#ffd27a', px * 0.27);
    const d = new Date();
    faceText(ctx, b.fL, 0.71, 0.84, d.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase(), F(6), '#7fb2ff', px * 0.28);
    faceText(ctx, b.fL, 0.71, 0.42, d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }), F(14), '#ffffff', px * 0.28);
    faceText(ctx, b.fL, 0.71, 0.16, VO.ai && VO.ai.available ? '● AI ONLINE' : '○ MODE SIMULASI', F(6), VO.ai && VO.ai.available ? '#7cf29a' : '#9aa3b8', px * 0.26);
  }

  function drawServerRack(ctx, x, y, now) {
    const b = box(ctx, x + 0.15, y + 0.25, x + 0.85, y + 0.75, 0, 50, { top: '#2b3242', left: '#141924', right: '#0f131c' });
    for (let i = 0; i < 7; i++) {
      facePanel(ctx, b.fL, 0.1, 0.9, 0.08 + i * 0.125, 0.16 + i * 0.125, '#1d2433');
      for (let j = 0; j < 3; j++) {
        const on = Math.sin(now / (180 + j * 70) + i * 2.1 + j * 1.3) > 0;
        facePanel(ctx, b.fL, 0.15 + j * 0.09, 0.2 + j * 0.09, 0.1 + i * 0.125, 0.14 + i * 0.125, on ? (j === 2 ? '#ffb347' : CY) : '#24405a');
      }
    }
    const g = onFace(b.fL, 0.5, 0.5);
    const gl = ctx.createRadialGradient(g.x, g.y, 0, g.x, g.y, 28);
    gl.addColorStop(0, alpha(CY, 0.12)); gl.addColorStop(1, alpha(CY, 0));
    ctx.fillStyle = gl; ctx.fillRect(g.x - 28, g.y - 28, 56, 56);
  }

  // Meja biliar: digambar per tile (kaki, badan kayu, rel, kain hijau, lubang) agar
  // urutan kedalaman benar dengan pemain di sekelilingnya; bola & lampu gantung sesudahnya
  function billiardProps(s, f, add) {
    const t = VO.billiardTable(f);
    const WOOD = luxe() ? LX.walnut : classic() ? { top: '#8a5a36', left: '#6e4528', right: '#5a381f' } : robot() ? { top: '#ffffff', left: NAVY, right: '#1f2aa8' } : { top: '#7a4f30', left: '#5e3c24', right: '#4b2f1c' };
    const FELT = '#1f8a4c', FELT2 = '#1a7743', Z = 17;
    for (let y = t.y; y < t.y + t.h; y++)
      for (let x = t.x; x < t.x + t.w; x++)
        add(x + y + 1, (ctx) => {
          const L = x === t.x, Rt = x === t.x + t.w - 1, Tp = y === t.y, B = y === t.y + t.h - 1;
          const x0 = x + (L ? 0.05 : 0), x1 = x + 1 - (Rt ? 0.05 : 0), y0 = y + (Tp ? 0.05 : 0), y1 = y + 1 - (B ? 0.05 : 0);
          for (const [cx, cy, on] of [[x0 + 0.1, y0 + 0.1, L && Tp], [x1 - 0.22, y0 + 0.1, Rt && Tp], [x0 + 0.1, y1 - 0.22, L && B], [x1 - 0.22, y1 - 0.22, Rt && B]])
            if (on) box(ctx, cx, cy, cx + 0.12, cy + 0.12, 0, 11, WOOD, { outline: false }); // kaki
          box(ctx, x0, y0, x1, y1, 11, Z - 11, WOOD, { outline: false }); // badan & rel
          const fx0 = x0 + (L ? 0.16 : 0), fx1 = x1 - (Rt ? 0.16 : 0), fy0 = y0 + (Tp ? 0.16 : 0), fy1 = y1 - (B ? 0.16 : 0);
          poly(ctx, diamond(fx0, fy0, fx1 - fx0, fy1 - fy0, Z), (x + y) % 2 ? FELT : FELT2);
          if (Tp) poly(ctx, diamond(fx0, fy0, fx1 - fx0, 0.05, Z), 'rgba(0,0,0,0.18)'); // bayangan rel
          if (L) poly(ctx, diamond(fx0, fy0, 0.05, fy1 - fy0, Z), 'rgba(0,0,0,0.18)');
          const pocket = (px, py) => { const p = iso(px, py, Z); ctx.fillStyle = '#111'; ctx.beginPath(); ctx.ellipse(p.x, p.y, 3.6, 2.2, 0, 0, 7); ctx.fill(); };
          if (L && Tp) pocket(x0 + 0.14, y0 + 0.14);
          if (Rt && Tp) pocket(x1 - 0.14, y0 + 0.14);
          if (L && B) pocket(x0 + 0.14, y1 - 0.14);
          if (Rt && B) pocket(x1 - 0.14, y1 - 0.14);
          if (x === t.x + 1 && Tp) pocket(x + 0.5, y0 + 0.12);
          if (x === t.x + 1 && B) pocket(x + 0.5, y1 - 0.12);
        });
    // bola: segitiga di kanan, bola putih bergulir pelan di kiri
    const k = t.x + t.y + t.w + t.h - 1;
    add(k + 0.02, (ctx, now) => {
      const cyy = t.y + t.h / 2;
      const rack = [[0, 0], [0.13, -0.08], [0.13, 0.08], [0.26, -0.16], [0.26, 0], [0.26, 0.16], [0.39, -0.08], [0.39, 0.08], [0.39, 0.24], [0.39, -0.24]];
      const COLS = ['#f9d71c', '#1e5bd8', '#d62828', '#6a2c91', '#111111', '#f77f00', '#1b7f3b', '#7b2d26', '#f9d71c', '#1e5bd8'];
      const ball = (bx, by, c) => {
        const p = iso(bx, by, Z);
        ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(p.x + 1, p.y + 0.5, 2.8, 1.4, 0, 0, 7); ctx.fill();
        ctx.fillStyle = c; ctx.beginPath(); ctx.arc(p.x, p.y - 2.2, 2.7, 0, 7); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.beginPath(); ctx.arc(p.x - 0.9, p.y - 3.1, 0.9, 0, 7); ctx.fill();
      };
      rack.forEach(([dx, dy], i) => ball(t.x + t.w - 1.05 + dx, cyy + dy, COLS[i]));
      ball(t.x + 0.75 + Math.sin(now / 1800) * 0.25, cyy + Math.sin(now / 2600) * 0.3, '#fafafa');
    });
    // lampu gantung di atas meja (3D)
    add(k + 0.04, (ctx) => {
      if (FLAT) return;
      const c = iso(t.x + t.w / 2, t.y + t.h / 2, 0);
      const g = ctx.createRadialGradient(c.x, c.y - Z, 0, c.x, c.y - Z, 60);
      g.addColorStop(0, 'rgba(255,236,170,0.28)'); g.addColorStop(1, 'rgba(255,236,170,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(c.x, c.y - Z, 62, 31, 0, 0, 7); ctx.fill();
      const top = iso(t.x + t.w / 2, t.y + t.h / 2, 112);
      ctx.strokeStyle = '#2a2b30'; ctx.beginPath(); ctx.moveTo(top.x, top.y - 30); ctx.lineTo(top.x, top.y); ctx.stroke();
      box(ctx, t.x + 0.55, t.y + 0.85, t.x + t.w - 0.55, t.y + t.h - 0.85, 104, 6, { top: '#1f5b38', left: '#17472b', right: '#123a23' }, { outline: false });
      for (const u of [0.2, 0.5, 0.8]) { const p = iso(t.x + 0.55 + (t.w - 1.1) * u, t.y + t.h - 0.85, 104); ctx.fillStyle = '#fff1c4'; ctx.beginPath(); ctx.ellipse(p.x, p.y + 1, 4, 1.6, 0, 0, 7); ctx.fill(); }
    });
    // rak stik biliar di dinding belakang
    add(f.x + 2.5 + f.y + 1.6, (ctx) => {
      const b = box(ctx, f.x + 1.2, f.y + 0.95, f.x + 2.4, f.y + 1.02, 10, 44, WOOD, { outline: false });
      ctx.strokeStyle = '#d9b98a'; ctx.lineWidth = 1.6;
      for (let i = 0; i < 5; i++) { const a = onFace(b.fL, 0.15 + i * 0.17, 0.06), c2 = onFace(b.fL, 0.15 + i * 0.17, 0.95); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c2.x, c2.y); ctx.stroke(); }
      ctx.lineWidth = 1;
    });
  }

  function drawLounger(ctx, x, y) {
    box(ctx, x + 0.1, y + 0.2, x + 0.9, y + 0.8, 0, 6, { top: '#8d5a33', left: '#6e4426', right: '#5a371f' }, { outline: false });
    box(ctx, x + 0.14, y + 0.24, x + 0.86, y + 0.76, 6, 3, { top: '#f6f2ea', left: '#e2dccf', right: '#d3ccbe' }, { outline: false });
    box(ctx, x + 0.14, y + 0.24, x + 0.34, y + 0.76, 9, 9, { top: '#f6f2ea', left: '#e8e2d6', right: '#d9d2c4' }, { outline: false }); // sandaran
  }

  function drawUmbrella(ctx, x, y) {
    const b = iso(x, y), top = { x: b.x, y: b.y - 46 };
    ctx.strokeStyle = '#6b4a2e'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(top.x, top.y); ctx.stroke(); ctx.lineWidth = 1;
    for (let i = 0; i < 8; i++) {
      const a0 = (i / 8) * Math.PI * 2, a1 = ((i + 1) / 8) * Math.PI * 2;
      ctx.fillStyle = i % 2 ? '#efe6d2' : '#d9cba8';
      ctx.beginPath(); ctx.moveTo(top.x, top.y - 6);
      ctx.lineTo(top.x + Math.cos(a0) * 26, top.y + Math.sin(a0) * 13 + 4);
      ctx.lineTo(top.x + Math.cos(a1) * 26, top.y + Math.sin(a1) * 13 + 4);
      ctx.closePath(); ctx.fill();
    }
  }

  function drawGardenLamp(ctx, x, y) {
    box(ctx, x - 0.08, y - 0.08, x + 0.08, y + 0.08, 0, 16, '#2a2b30', { outline: false });
    const p = iso(x, y, 18);
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 20);
    g.addColorStop(0, 'rgba(255,214,140,0.6)'); g.addColorStop(1, 'rgba(255,214,140,0)');
    ctx.fillStyle = g; ctx.fillRect(p.x - 20, p.y - 20, 40, 40);
    ctx.fillStyle = '#ffe2a6'; ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 7); ctx.fill();
  }

  // Teks di permukaan vertikal yang menghadap +ty (mengikuti sumbu x isometrik)
  function faceText(ctx, face, u, v, text, font, color, maxW) {
    const o = onFace(face, u, v);
    ctx.save();
    ctx.setTransform(ctx.getTransform().multiply(new DOMMatrix([HW / 32, HH / 32, 0, 1, o.x, o.y])));
    ctx.font = font; ctx.fillStyle = color;
    let s2 = String(text);
    while (maxW && s2.length > 3 && ctx.measureText(s2).width > maxW) s2 = s2.slice(0, -2);
    if (s2 !== String(text)) s2 = s2.trimEnd() + '…';
    ctx.fillText(s2, 0, 0);
    ctx.restore();
  }

  // TV besar di dinding: menampilkan tugas yang sedang berjalan (seperti papan status)
  function wallTV(ctx, x, y, w, s, now) {
    const b = box(ctx, x, y, x + w, y + 0.06, 14, 42, '#0d0f14', { outline: false });
    facePanel(ctx, b.fL, 0.03, 0.97, 0.06, 0.94, '#121a30');
    if (FLAT) return; // di denah 2D layar hanya terlihat sebagai garis gelap
    const active = s.tasks.find((t) => !['done', 'failed'].includes(t.status));
    const glow = 0.85 + Math.sin(now / 600) * 0.15;
    ctx.save(); ctx.globalAlpha = glow;
    const px = w * 32; // lebar teks dalam satuan lokal
    if (active) {
      faceText(ctx, b.fL, 0.07, 0.66, active.status === 'meeting' ? 'RAPAT' : 'SEDANG DIKERJAKAN', 'bold 7.5px Inter, system-ui, sans-serif', '#ff8a65', px * 0.8);
      faceText(ctx, b.fL, 0.07, 0.24, active.title, 'bold 12px Inter, system-ui, sans-serif', '#ffd27a', px * 0.84);
    } else {
      faceText(ctx, b.fL, 0.07, 0.66, 'STATUS KANTOR', 'bold 7.5px Inter, system-ui, sans-serif', '#7fb2ff', px * 0.8);
      faceText(ctx, b.fL, 0.07, 0.24, (s.company && s.company.name) || 'Kantor AI', 'bold 12px Inter, system-ui, sans-serif', '#ffd27a', px * 0.84);
    }
    ctx.restore();
  }

  // Layar dinding departemen: grafik batang (bergerak saat tim bekerja)
  // Tugas dari atasan yang relevan untuk departemen d (aktif dulu, lalu yang terbaru selesai)
  function deptTasks(s, d) {
    const ids = new Set(VO.deptAgents(s, d.id).map((a) => a.id));
    const rel = s.tasks.filter((t) => t.targetType === 'all' || (t.targetType === 'division' && t.targetId === d.divisionId) || (t.targetType === 'dept' && t.targetId === d.id) || (t.targetType === 'agent' && ids.has(t.targetId)) || t.subtasks.some((st) => ids.has(st.agentId)));
    const active = rel.filter((t) => !['done', 'failed'].includes(t.status));
    const rest = rel.filter((t) => ['done', 'failed'].includes(t.status));
    return [...active, ...rest].slice(0, 4).map((t) => {
      const subs = t.subtasks.filter((st) => ids.has(st.agentId));
      const prog = t.status === 'done' ? 1 : subs.length ? subs.reduce((a, st) => a + (st.status === 'done' ? 1 : st.progress || 0), 0) / subs.length : 0;
      return { title: t.title, status: t.status, prog };
    });
  }
  const TB_STATUS = { briefing: ['BRIEFING', '#ffd166'], meeting: ['RAPAT', '#ffd166'], in_progress: ['DIKERJAKAN', '#5ec8ff'], done: ['SELESAI', '#7cf29a'], failed: ['GAGAL', '#ff6b6b'] };

  // Layar papan tugas di dinding departemen
  function drawTaskBoard(ctx, x, y, w, s, d, now, color) {
    const b = box(ctx, x, y, x + w, y + 0.06, 12, 64, '#07090f', { outline: false });
    const f = b.fL;
    facePanel(ctx, f, 0.012, 0.988, 0.03, 0.97, '#0b1526');
    facePanel(ctx, f, 0.012, 0.988, 0.81, 0.97, '#13233d');
    facePanel(ctx, f, 0.012, 0.03, 0.03, 0.97, color); // aksen warna divisi
    const rows = deptTasks(s, d);
    const px = w * 32;
    const F = (sz) => `bold ${sz}px Inter, system-ui, sans-serif`;
    rows.forEach((r, i) => {
      const top = 0.78 - i * 0.19;
      const [lbl, col] = TB_STATUS[r.status] || ['-', '#9aa3b8'];
      const pulse = r.status === 'in_progress' ? 0.6 + Math.sin(now / 300 + i) * 0.4 : 1;
      ctx.save(); ctx.globalAlpha = pulse; facePanel(ctx, f, 0.045, 0.06, top - 0.09, top - 0.03, col); ctx.restore();
      facePanel(ctx, f, 0.08, 0.96, top - 0.16, top - 0.14, '#1c2740');
      facePanel(ctx, f, 0.08, 0.08 + 0.88 * Math.max(0.02, r.prog), top - 0.16, top - 0.14, col);
      if (FLAT) return;
      faceText(ctx, f, 0.08, top - 0.11, r.title, F(7.5), '#e8ecf5', px * 0.6);
      faceText(ctx, f, 0.74, top - 0.11, lbl, F(5.5), col, px * 0.22);
    });
    if (FLAT) return;
    faceText(ctx, f, 0.05, 0.86, 'TUGAS DARI ATASAN', F(6.5), '#ffd27a', px * 0.6);
    faceText(ctx, f, 0.7, 0.86, d.name, F(6), '#9fb3d9', px * 0.27);
    if (!rows.length) faceText(ctx, f, 0.08, 0.5, 'Belum ada tugas dari atasan', F(7), '#6f7fa3', px * 0.85);
  }


  function drawDesk(ctx, x, y, now, ent, topColor, exec) {
    if (exec) return drawExecDesk(ctx, x, y, now, ent);
    if (luxe()) return drawDeskLuxe(ctx, x, y, now, ent);
    if (studio()) {
      const q = iso(x + 0.56, y + 0.58);
      const sh = ctx.createRadialGradient(q.x, q.y, 2, q.x, q.y, 28);
      sh.addColorStop(0, 'rgba(33,48,42,0.18)'); sh.addColorStop(1, 'rgba(33,48,42,0)');
      ctx.fillStyle = sh; ctx.beginPath(); ctx.ellipse(q.x, q.y, 30, 17, 0, 0, Math.PI * 2); ctx.fill();
      topColor = '#f5eedf';
    }
    if (modern()) { // meja putih dengan kaki ramping
      box(ctx, x + 0.06, y + 0.14, x + 0.94, y + 0.86, 12, 3, { top: topColor, left: '#dde1e8', right: '#cdd2db' }, { outline: false });
      for (const [lx, ly] of [[0.1, 0.18], [0.86, 0.18], [0.1, 0.78], [0.86, 0.78]]) box(ctx, x + lx, y + ly, x + lx + 0.04, y + ly + 0.04, 0, 12, '#b8bfcb', { outline: false });
    } else if (classic()) { // meja krem dengan laci
      const d = box(ctx, x + 0.06, y + 0.14, x + 0.94, y + 0.86, 0, 15, { top: CL.desk, left: '#ddd2b6', right: '#cbbf9f' });
      facePanel(ctx, d.fR, 0.08, 0.92, 0.55, 0.85, '#e4dac1');
      facePanel(ctx, d.fR, 0.08, 0.92, 0.18, 0.48, '#e4dac1');
      facePanel(ctx, d.fR, 0.42, 0.58, 0.68, 0.74, '#8d8470');
      facePanel(ctx, d.fR, 0.42, 0.58, 0.31, 0.37, '#8d8470');
      // tempat sampah kecil di samping meja
      box(ctx, x + 0.93, y + 0.62, x + 1.05, y + 0.76, 0, 8, '#9aa0b4', { outline: false });
    } else box(ctx, x + 0.06, y + 0.14, x + 0.94, y + 0.86, 0, 15, { top: topColor, left: shade(topColor, 0.78), right: shade(topColor, 0.62) });
    // monitor menghadap kursi (sisi +ty)
    const rt = ent && VO.sim.rt.get(ent.id);
    const working = rt && rt.working;
    box(ctx, x + 0.46, y + 0.32, x + 0.54, y + 0.42, 15, 5, '#2a2d34'); // kaki monitor
    const m = box(ctx, x + 0.22, y + 0.3, x + 0.78, y + 0.38, 19, 15, classic() ? '#e8e3d3' : '#1d2129');
    let scr = '#20242c';
    if (ent) scr = working ? '#16466e' : '#2d3a4f';
    facePanel(ctx, m.fL, 0.08, 0.92, 0.12, 0.9, scr);
    if (working) {
      for (let i = 0; i < 3; i++) {
        const len = 0.25 + ((Math.sin(now / 170 + i * 2 + x * 3) + 1) / 2) * 0.5;
        ctx.strokeStyle = ['#4fc3f7', '#81c784', '#ffd54f'][i];
        ctx.lineWidth = 1.2;
        const a = onFace(m.fL, 0.15, 0.7 - i * 0.2), bb = onFace(m.fL, 0.15 + len * 0.7, 0.7 - i * 0.2);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(bb.x, bb.y); ctx.stroke();
      }
      const c = onFace(m.fL, 0.5, 0.5);
      ctx.fillStyle = 'rgba(79,195,247,0.13)'; ctx.beginPath(); ctx.arc(c.x, c.y + 6, 18, 0, 7); ctx.fill();
    }
    // keyboard & cangkir
    poly(ctx, diamond(x + 0.3, y + 0.55, 0.4, 0.14, 15), '#d9dce3');
    box(ctx, x + 0.8, y + 0.2, x + 0.88, y + 0.28, 15, 5, '#ffffff', { outline: false });
  }

  // Meja eksekutif direktur (open plan): meja lebar, laptop menghadap direktur, tanaman kecil
  function drawExecDesk(ctx, x, y, now, ent) {
    const col = luxe() ? LX.walnut : robot() ? { top: '#ffffff', left: NAVY, right: '#1f2aa8' } : classic() ? { top: CL.desk, left: '#ddd2b6', right: '#cbbf9f' } : modern() ? { top: '#ffffff', left: '#dde1e8', right: '#cdd2db' } : { top: '#6d4c7d', left: '#553a62', right: '#45304f' };
    const d = box(ctx, x - 0.35, y + 0.12, x + 1.35, y + 0.88, 0, 16, col);
    facePanel(ctx, d.fL, 0, 1, 0.8, 0.9, luxe() ? LX.gold : 'rgba(0,0,0,0.12)');
    const rt = ent && VO.sim.rt.get(ent.id);
    // laptop: layar di sisi belakang meja (menghadap direktur), terlihat dari depan sebagai punggung laptop
    box(ctx, x + 0.25, y + 0.3, x + 0.75, y + 0.62, 16, 1.5, '#c9ccd3', { outline: false });
    const lid = box(ctx, x + 0.25, y + 0.28, x + 0.75, y + 0.32, 17, 13, '#b9bcc4', { outline: false });
    facePanel(ctx, lid.fL, 0.42, 0.58, 0.45, 0.6, rt && rt.working ? '#7fe0ff' : '#e4e6ea');
    poly(ctx, diamond(x - 0.15, y + 0.35, 0.3, 0.35, 16), '#f5f5f5'); // dokumen
    const p = iso(x + 1.1, y + 0.45, 16); // tanaman kecil
    ctx.fillStyle = '#3f9a4a'; ctx.beginPath(); ctx.arc(p.x, p.y - 6, 5, 0, 7); ctx.fill();
    ctx.fillStyle = '#2f7a3a'; ctx.beginPath(); ctx.arc(p.x + 3, p.y - 9, 3.5, 0, 7); ctx.fill();
  }

  // Meja kayu walnut dengan dua monitor (layar grafik menyala saat bekerja)
  function drawDeskLuxe(ctx, x, y, now, ent) {
    const d = box(ctx, x + 0.04, y + 0.14, x + 0.96, y + 0.86, 0, 15, LX.walnut);
    facePanel(ctx, d.fL, 0.04, 0.96, 0.82, 0.9, '#7a5233');
    const rt = ent && VO.sim.rt.get(ent.id);
    const working = rt && rt.working;
    for (const [u0, u1] of [[0.1, 0.48], [0.52, 0.9]]) {
      box(ctx, x + (u0 + u1) / 2 - 0.03, y + 0.32, x + (u0 + u1) / 2 + 0.03, y + 0.38, 15, 5, '#1a1c22', { outline: false });
      const m = box(ctx, x + u0, y + 0.3, x + u1, y + 0.36, 19, 14, '#14161b', { outline: false });
      facePanel(ctx, m.fL, 0.07, 0.93, 0.1, 0.9, !ent ? '#16181e' : working ? '#0f2547' : '#1c2740');
      if (working) {
        const hue = u0 < 0.5 ? ['#5ec8ff', '#7cf29a', '#ffd166'] : ['#ff7ab6', '#9d8bff', '#5ec8ff'];
        for (let i = 0; i < 4; i++) {
          const h = 0.2 + ((Math.sin(now / 260 + i * 1.7 + x * 2 + u0 * 5) + 1) / 2) * 0.55;
          facePanel(ctx, m.fL, 0.15 + i * 0.19, 0.27 + i * 0.19, 0.18, 0.18 + h * 0.7, hue[i % 3]);
        }
      }
    }
    if (working) {
      const c = onFace(d.fL, 0.5, 2.2);
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 26);
      g.addColorStop(0, 'rgba(94,200,255,0.18)'); g.addColorStop(1, 'rgba(94,200,255,0)');
      ctx.fillStyle = g; ctx.fillRect(c.x - 26, c.y - 26, 52, 52);
    }
    poly(ctx, diamond(x + 0.3, y + 0.55, 0.4, 0.14, 15), '#2a2d34');
    box(ctx, x + 0.82, y + 0.22, x + 0.9, y + 0.3, 15, 5, '#f4efe6', { outline: false });
  }

  // Meja manager (ketua tim): meja L lebih lebar dengan aksen, monitor besar + monitor kedua,
  // lampu meja, papan nama, dan karpet kecil — pembeda dari meja staf
  const mgrColors = () => luxe() ? { top: '#8a5a36', left: '#6b4429', right: '#55361f', trim: LX.gold, rug: '#3a2a1a' }
    : robot() ? { top: '#ffffff', left: ORANGE, right: '#d9741f', trim: NAVY, rug: '#dfe3f5' }
    : classic() ? { top: '#ffffff', left: '#d4d9ea', right: '#c2c8dc', trim: '#4a66cf', rug: '#a9b0e6' }
    : modern() ? { top: '#2d3342', left: '#232836', right: '#1b1f2b', trim: '#3b7cff', rug: '#e4e8f0' }
    : { top: '#6d4c7d', left: '#553a62', right: '#45304f', trim: '#ffd166', rug: '#3a3150' };
  function drawManagerDesk(ctx, x, y, now, ent) {
    const C = mgrColors();
    // karpet kecil penanda area manager
    poly(ctx, diamond(x - 0.2, y + 0.05, 1.6, 1.9), alpha(C.rug.length === 7 ? C.rug : '#888888', luxe() ? 0.9 : 0.55));
    ctx.lineWidth = 1.5; poly(ctx, diamond(x - 0.12, y + 0.12, 1.44, 1.76), null, alpha(C.trim, 0.8)); ctx.lineWidth = 1;
    // meja utama + sayap kanan (bentuk L)
    const d = box(ctx, x + 0.02, y + 0.1, x + 1.0, y + 0.9, 0, 16, C);
    box(ctx, x + 1.0, y + 0.1, x + 1.32, y + 1.25, 0, 16, C);
    facePanel(ctx, d.fL, 0, 1, 0.82, 0.92, C.trim); // list aksen
    // monitor besar + monitor kedua miring
    const rt = ent && VO.sim.rt.get(ent.id);
    const working = rt && rt.working;
    box(ctx, x + 0.46, y + 0.3, x + 0.56, y + 0.38, 16, 6, '#1a1c22', { outline: false });
    const m = box(ctx, x + 0.12, y + 0.26, x + 0.88, y + 0.33, 21, 20, '#14161b', { outline: false });
    facePanel(ctx, m.fL, 0.05, 0.95, 0.08, 0.92, working ? '#0f2547' : '#1c2740');
    if (working) for (let i = 0; i < 5; i++) {
      const h = 0.2 + ((Math.sin(now / 280 + i * 1.4 + x) + 1) / 2) * 0.55;
      facePanel(ctx, m.fL, 0.12 + i * 0.16, 0.22 + i * 0.16, 0.16, 0.16 + h * 0.7, ['#5ec8ff', '#7cf29a', '#ffd166', '#ff7ab6', '#9d8bff'][i]);
    }
    const m2 = box(ctx, x + 1.04, y + 0.2, x + 1.1, y + 0.75, 19, 13, '#14161b', { outline: false });
    facePanel(ctx, m2.fR, 0.08, 0.92, 0.1, 0.9, working ? '#123a5c' : '#1c2740');
    // keyboard, lampu meja, papan nama
    poly(ctx, diamond(x + 0.28, y + 0.52, 0.44, 0.15, 16), '#2a2d34');
    const lp = iso(x + 1.17, y + 0.95, 16);
    ctx.strokeStyle = '#2a2b30'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(lp.x, lp.y); ctx.lineTo(lp.x, lp.y - 14); ctx.lineTo(lp.x - 5, lp.y - 18); ctx.stroke(); ctx.lineWidth = 1;
    ctx.fillStyle = C.trim; ctx.beginPath(); ctx.ellipse(lp.x - 6, lp.y - 18, 4, 2.2, 0, 0, 7); ctx.fill();
    const gl = ctx.createRadialGradient(lp.x - 6, lp.y - 12, 0, lp.x - 6, lp.y - 12, 16);
    gl.addColorStop(0, 'rgba(255,214,140,0.35)'); gl.addColorStop(1, 'rgba(255,214,140,0)');
    ctx.fillStyle = gl; ctx.fillRect(lp.x - 22, lp.y - 28, 32, 32);
    const np = box(ctx, x + 0.6, y + 0.74, x + 0.92, y + 0.8, 16, 4, C.trim, { outline: false }); // papan nama
    facePanel(ctx, np.fL, 0.1, 0.9, 0.25, 0.75, '#1b1f2a');
  }

  function drawChair(ctx, x, y, mgr) {
    if (mgr) { // kursi eksekutif manager: dudukan lebih lebar
      box(ctx, x + 0.26, y + 0.28, x + 0.74, y + 0.74, 6, 5, luxe() ? '#7a4a2c' : classic() ? '#1f2f7a' : robot() ? ORANGE : '#3b2f2a');
      box(ctx, x + 0.46, y + 0.46, x + 0.54, y + 0.54, 0, 6, '#22252c', { outline: false });
      return;
    }
    box(ctx, x + 0.3, y + 0.32, x + 0.7, y + 0.72, 6, 4, luxe() ? LX.chair : classic() ? CL.chair : robot() ? NAVY : modern() ? '#7f8ba0' : '#353a46'); // dudukan
    box(ctx, x + 0.46, y + 0.46, x + 0.54, y + 0.54, 0, 6, '#22252c', { outline: false }); // tiang
  }
  // sandaran digambar SETELAH karyawan yang duduk, agar menutupi punggungnya
  function drawChairBack(ctx, x, y, mgr) {
    if (mgr) { // sandaran tinggi berlapis kulit
      const b = box(ctx, x + 0.26, y + 0.7, x + 0.74, y + 0.8, 10, 26, luxe() ? '#7a4a2c' : classic() ? '#1f2f7a' : robot() ? ORANGE : '#3b2f2a');
      facePanel(ctx, b.fL, 0.15, 0.85, 0.55, 0.9, 'rgba(255,255,255,0.08)');
      return;
    }
    box(ctx, x + 0.3, y + 0.7, x + 0.7, y + 0.78, 10, 16, luxe() ? LX.chairBack : classic() ? CL.chairBack : robot() ? '#1f2aa8' : modern() ? '#6f7b90' : '#2b2f3a');
  }

  function drawFurniture(ctx, f) {
    const x = f.x, y = f.y;
    const sh = iso(x + 0.5, y + 0.5);
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.beginPath(); ctx.ellipse(sh.x, sh.y, 20, 9, 0, 0, 7); ctx.fill();
    switch (f.type) {
      case 'plant': {
        if (robot()) { // pohon bulat biru dengan pot koral
          box(ctx, x + 0.36, y + 0.36, x + 0.64, y + 0.64, 0, 10, CORAL, { outline: false });
          const q = iso(x + 0.5, y + 0.5, 10);
          ctx.fillStyle = '#5a3a2a'; ctx.fillRect(q.x - 1.5, q.y - 10, 3, 10);
          const g = ctx.createRadialGradient(q.x - 5, q.y - 26, 2, q.x, q.y - 20, 16);
          g.addColorStop(0, '#5d6bff'); g.addColorStop(1, NAVY);
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.ellipse(q.x, q.y - 22, 11, 15, 0, 0, 7); ctx.fill();
          break;
        }
        if (luxe() || studio()) { // tanaman tropis dalam pot hitam tinggi
          box(ctx, x + 0.32, y + 0.32, x + 0.68, y + 0.68, 0, 16, studio() ? { top: '#e4d7c6', left: '#c3b39e', right: '#a99781' } : { top: '#3a3b40', left: '#2a2b30', right: '#1f2024' }, { outline: false });
          const q = iso(x + 0.5, y + 0.5, 16);
          ctx.fillStyle = '#3b2a1c'; ctx.beginPath(); ctx.ellipse(q.x, q.y, 8, 4, 0, 0, 7); ctx.fill();
          for (let i = 0; i < 9; i++) {
            const a = -Math.PI / 2 + (i - 4) * 0.36;
            const len = 18 + hash(x + i, y) * 8;
            ctx.save(); ctx.translate(q.x, q.y - 2); ctx.rotate(a + Math.PI / 2);
            ctx.fillStyle = i % 2 ? '#2f7a3a' : '#3f9a4a';
            ctx.beginPath(); ctx.ellipse(0, -len / 2, 4.2, len / 2, 0, 0, 7); ctx.fill();
            ctx.strokeStyle = 'rgba(20,60,25,0.6)'; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -len); ctx.stroke();
            ctx.restore();
          }
          break;
        }
        if (classic()) { // pohon bonsai bulat dalam pot terakota
          box(ctx, x + 0.33, y + 0.33, x + 0.67, y + 0.67, 0, 12, '#b5653c');
          const q = iso(x + 0.5, y + 0.5, 12);
          ctx.strokeStyle = '#6b4226'; ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.quadraticCurveTo(q.x + 4, q.y - 12, q.x - 1, q.y - 22); ctx.stroke(); ctx.lineWidth = 1;
          for (const [ox, oy, r, c] of [[0, -26, 12, '#2f7d32'], [-9, -20, 8, '#357f39'], [9, -21, 8, '#2f7d32'], [-3, -31, 7, '#4caf50'], [4, -24, 5, '#66bb6a']]) {
            ctx.fillStyle = c; ctx.beginPath(); ctx.arc(q.x + ox, q.y + oy, r, 0, 7); ctx.fill();
          }
          break;
        }
        box(ctx, x + 0.32, y + 0.32, x + 0.68, y + 0.68, 0, 14, '#8d5a3b');
        const p = iso(x + 0.5, y + 0.5, 14);
        for (const [ox, oy, r, c] of [[0, -10, 10, '#2e7d32'], [-8, -4, 8, '#388e3c'], [8, -5, 8, '#2e7d32'], [0, -20, 8, '#43a047'], [-4, -13, 6, '#66bb6a']]) {
          ctx.fillStyle = c; ctx.beginPath(); ctx.arc(p.x + ox, p.y + oy, r, 0, 7); ctx.fill();
        }
        break;
      }
      case 'sofa':
        if (luxe()) { // sofa kulit krem
          box(ctx, x + 0.05, y + 0.2, x + 0.95, y + 0.85, 0, 10, { top: '#eadfca', left: '#d6c8ad', right: '#c3b498' });
          box(ctx, x + 0.05, y + 0.12, x + 0.95, y + 0.32, 0, 22, { top: '#e2d5bb', left: '#cdbd9f', right: '#b9a989' });
          box(ctx, x + 0.05, y + 0.2, x + 0.17, y + 0.85, 0, 15, { top: '#e2d5bb', left: '#cdbd9f', right: '#b9a989' });
          box(ctx, x + 0.83, y + 0.2, x + 0.95, y + 0.85, 0, 15, { top: '#e2d5bb', left: '#cdbd9f', right: '#b9a989' });
          break;
        }
        if (classic()) {
          box(ctx, x + 0.05, y + 0.2, x + 0.95, y + 0.85, 0, 10, '#3d63d8');
          box(ctx, x + 0.05, y + 0.12, x + 0.95, y + 0.32, 0, 22, '#2f50c2');
          box(ctx, x + 0.05, y + 0.2, x + 0.17, y + 0.85, 0, 15, '#2f50c2');
          box(ctx, x + 0.83, y + 0.2, x + 0.95, y + 0.85, 0, 15, '#2f50c2');
          break;
        }
        box(ctx, x + 0.05, y + 0.2, x + 0.95, y + 0.85, 0, 10, '#5c6bc0');
        box(ctx, x + 0.05, y + 0.12, x + 0.95, y + 0.32, 0, 22, '#4a59ad');
        box(ctx, x + 0.05, y + 0.2, x + 0.17, y + 0.85, 0, 16, '#4a59ad');
        box(ctx, x + 0.83, y + 0.2, x + 0.95, y + 0.85, 0, 16, '#4a59ad');
        break;
      case 'bookshelf': {
        const b = box(ctx, x + 0.08, y + 0.3, x + 0.92, y + 0.7, 0, 46, classic() ? { top: '#4a66cf', left: '#cfe0ff', right: '#9fb6ee' } : luxe() ? LX.walnut : '#6d4c41');
        for (let r = 0; r < 4; r++) for (let i = 0; i < 6; i++)
          facePanel(ctx, b.fL, 0.08 + i * 0.145, 0.08 + i * 0.145 + 0.11, 0.08 + r * 0.23, 0.08 + r * 0.23 + 0.17, VO.SHIRTS[(r * 6 + i) % VO.SHIRTS.length]);
        break;
      }
      case 'whiteboard': {
        box(ctx, x + 0.47, y + 0.5, x + 0.53, y + 0.56, 0, 14, '#90a4ae');
        const b = box(ctx, x + 0.05, y + 0.48, x + 0.95, y + 0.54, 14, 28, '#fafafa');
        ctx.strokeStyle = '#e53935'; ctx.lineWidth = 1.5;
        const pts = [[0.1, 0.3], [0.3, 0.6], [0.5, 0.45], [0.7, 0.8], [0.9, 0.6]].map(([u, v]) => onFace(b.fL, u, v));
        ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y); ctx.stroke();
        break;
      }
      case 'cooler': {
        box(ctx, x + 0.3, y + 0.3, x + 0.7, y + 0.7, 0, 22, '#eceff1');
        const p = iso(x + 0.5, y + 0.5, 22);
        ctx.fillStyle = 'rgba(66,165,245,0.85)'; rr(ctx, p.x - 7, p.y - 16, 14, 16, 4); ctx.fill();
        break;
      }
      case 'printer': {
        if (classic()) { // mesin fotokopi besar
          const c = box(ctx, x + 0.08, y + 0.15, x + 0.92, y + 0.85, 0, 24, { top: '#f2f3f6', left: '#dfe2ea', right: '#c9cdd8' });
          facePanel(ctx, c.fL, 0.1, 0.9, 0.15, 0.45, '#cfd3de');
          facePanel(ctx, c.fL, 0.1, 0.9, 0.55, 0.62, '#9aa0b2');
          box(ctx, x + 0.15, y + 0.2, x + 0.7, y + 0.7, 24, 4, '#e3e6ee');
          poly(ctx, diamond(x + 0.7, y + 0.25, 0.18, 0.2, 24), '#4a66cf');
          break;
        }
        const b = box(ctx, x + 0.15, y + 0.2, x + 0.85, y + 0.8, 0, 14, '#cfd8dc');
        facePanel(ctx, b.fL, 0.15, 0.85, 0.35, 0.5, '#37474f');
        poly(ctx, diamond(x + 0.3, y + 0.3, 0.4, 0.35, 15), '#ffffff');
        break;
      }
      case 'server': {
        const b = box(ctx, x + 0.15, y + 0.2, x + 0.85, y + 0.8, 0, 46, '#263238');
        for (let i = 0; i < 6; i++) facePanel(ctx, b.fL, 0.15, 0.3, 0.1 + i * 0.14, 0.15 + i * 0.14, i % 2 ? '#66bb6a' : '#29b6f6');
        break;
      }
      case 'lamp': { // lampu lantai dengan cahaya hangat
        box(ctx, x + 0.38, y + 0.38, x + 0.62, y + 0.62, 0, 3, '#2a2b30', { outline: false });
        const b0 = iso(x + 0.5, y + 0.5, 3);
        ctx.strokeStyle = '#3a3b40'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(b0.x, b0.y); ctx.lineTo(b0.x, b0.y - 40); ctx.stroke(); ctx.lineWidth = 1;
        const p = { x: b0.x, y: b0.y - 44 };
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 34);
        g.addColorStop(0, 'rgba(255,210,140,0.5)'); g.addColorStop(1, 'rgba(255,210,140,0)');
        ctx.fillStyle = g; ctx.fillRect(p.x - 34, p.y - 34, 68, 68);
        ctx.fillStyle = '#f3e3c3'; ctx.beginPath(); ctx.moveTo(p.x - 6, p.y - 6); ctx.lineTo(p.x + 6, p.y - 6); ctx.lineTo(p.x + 9, p.y + 5); ctx.lineTo(p.x - 9, p.y + 5); ctx.closePath(); ctx.fill();
        break;
      }
      case 'arcade': {
        const b = box(ctx, x + 0.2, y + 0.25, x + 0.8, y + 0.75, 0, 44, '#6a1b9a');
        facePanel(ctx, b.fL, 0.15, 0.85, 0.55, 0.85, '#00e5ff');
        facePanel(ctx, b.fL, 0.25, 0.4, 0.4, 0.47, '#ffeb3b');
        facePanel(ctx, b.fL, 0.6, 0.75, 0.4, 0.47, '#f44336');
        break;
      }
    }
  }
  R.drawFurniture = drawFurniture;

  /* ------------------------------------------------------------ karakter gaya Habbo */
  /**
   * Gambar avatar dengan kaki di (0,0) koordinat lokal. Menghadap kanan-bawah
   * secara default; o.mirror membalik ke kiri; o.back = tampak belakang.
   */
  // Studio characters: rounded silhouettes, shaded materials and expressive faces.
  // Uses the same feet origin / head-height contract as the other avatar renderers.
  function drawStudioAvatar(ctx, a, o) {
    const skin = a.skin || '#dba67b', hair = a.hair || '#32302e';
    const top = a.top || a.shirt || '#607e78', pants = a.pants || '#33434b';
    const step = o.moving ? Math.sin(o.phase * 13) : 0;
    const lift = o.sitting ? -9 : Math.abs(step) * 1.4;
    const grad = (x, y, w, h, color) => {
      const g = ctx.createLinearGradient(x, y, x+w, y+h);
      g.addColorStop(0, shade(color, 1.2)); g.addColorStop(0.45, color); g.addColorStop(1, shade(color, 0.72)); return g;
    };
    const oval = (x,y,rx,ry,color) => { ctx.fillStyle=color; ctx.beginPath(); ctx.ellipse(x,y,rx,ry,0,0,Math.PI*2); ctx.fill(); };
    const capsule = (x,y,w,h,r,color) => { ctx.fillStyle=color; rr(ctx,x,y,w,h,r);ctx.fill(); };
    ctx.save(); if (o.mirror) ctx.scale(-1,1);
    oval(0,1,14,4.5,'rgba(30,48,43,0.18)');
    ctx.translate(0,-lift);
    // Tapered trousers and white-soled shoes.
    for (const [x,off] of [[-7,step*2],[1,-step*2]]) {
      capsule(x,-21+off,6.5,o.sitting?12:19,2.8,grad(x,-21,7,18,pants));
      capsule(x-1,(o.sitting?-10:-4)+off,9,5,2.4,'#f0eee6');
      capsule(x-1,(o.sitting?-11:-5)+off,9,4,2.2,'#35423f');
      ctx.fillStyle='#c8d3ce';ctx.fillRect(x+1,(o.sitting?-10:-4)+off,3,1);
    }
    capsule(-10,-40,20,22,6,grad(-10,-40,20,22,top));
    if (!o.back) {
      if (a.style === 'suit' || a.style === 'shirt') {
        poly(ctx,[{x:-4,y:-40},{x:4,y:-40},{x:0,y:-28}],'#faf4e9');
        poly(ctx,[{x:-1.3,y:-37},{x:1.3,y:-37},{x:2,y:-28},{x:0,y:-26},{x:-2,y:-28}],a.tie||'#b96b4b');
        if(a.style==='suit') {
          poly(ctx,[{x:-7,y:-39},{x:-4,y:-30},{x:-1,y:-32},{x:-4,y:-40}],shade(top,1.25));
          poly(ctx,[{x:7,y:-39},{x:4,y:-30},{x:1,y:-32},{x:4,y:-40}],shade(top,0.82));
        }
      } else {
        capsule(-3.5,-39,7,17,2,'#f4ead7');
        oval(0,-34,1.2,1.2,'#ddb66a');
      }
      // Lanyard badge adds a readable workplace detail at close zoom.
      capsule(4,-30,4,5.5,0.8,'#f5f2e9');ctx.fillStyle='#74a99a';ctx.fillRect(4.7,-28.8,2.6,1.4);
    } else { ctx.strokeStyle=shade(top,0.82);ctx.lineWidth=0.7;ctx.beginPath();ctx.moveTo(0,-36);ctx.lineTo(0,-21);ctx.stroke(); }
    const arm = (x,phase) => {
      const off = o.working ? Math.sin(o.now/110+phase)*1.1 : step*(phase?2:-2);
      capsule(x,-38+off,5,16,2.5,grad(x,-38,5,16,top));
      oval(x+2.5,-21+off,2.8,3.2,grad(x,-23,5,6,skin));
      capsule(x,-25+off,5,2,0.5,'#e8e8df');
    };
    arm(-14,0);arm(9,1);
    capsule(-3,-44,6,6,2,shade(skin,0.9));
    const hy=-53;
    if(a.hairStyle===2) capsule(-12,hy-6,24,25,8,grad(-12,hy-6,24,25,hair));
    oval(-10.5,hy+1,2.6,3.7,shade(skin,0.9));oval(10.5,hy+1,2.6,3.7,shade(skin,0.87));
    oval(0,hy,11.7,12.5,grad(-10,hy-10,22,24,skin));
    if(o.back) {
      oval(0,hy-1,12,12.5,grad(-12,hy-13,24,25,hair));
      if(a.hairStyle===4)oval(0,hy-5,10,9,grad(-9,hy-12,18,18,skin));
      if(a.hairStyle===2)capsule(-11,hy,22,17,7,grad(-11,hy,22,17,hair));
      if(a.hairStyle===3)oval(-3,hy-13,6,5.5,grad(-8,hy-18,12,11,hair));
    } else {
      const blink = o.now > 0 && (o.now + String(o.seed||'').length*283)%4700 < 130;
      for(const x of [-3,5]) {
        if(blink) capsule(x-1.5,hy+1,3,0.9,0.4,'#263332');
        else { oval(x,hy,1.65,2.25,'#263332');oval(x-0.45,hy-0.65,0.55,0.7,'#fff'); }
        capsule(x-2,hy-4,3.6,1,0.5,shade(hair,0.85));
      }
      oval(-6,hy+4,2.5,1.3,'rgba(199,97,75,0.2)');oval(8,hy+4,2,1.2,'rgba(199,97,75,0.2)');
      oval(2,hy+3,1.4,1.2,shade(skin,0.86));
      ctx.strokeStyle=shade(skin,0.52);ctx.lineWidth=1;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(-1,hy+7);ctx.quadraticCurveTo(2,hy+9,5,hy+6.5);ctx.stroke();
      if(o.talking)oval(2,hy+7,1.8,1.4,'#855a4b');
      if(a.mustache)capsule(-1,hy+5,7,2,1,hair);
      // All six saved hairstyles remain distinct.
      ctx.fillStyle=grad(-12,hy-15,24,17,hair);
      if(a.hairStyle===4) {
        capsule(-11,hy-4,3,8,1.5,hair);capsule(9,hy-4,3,7,1.5,hair);
      } else if(a.hairStyle===5) {
        for(const [x,y,r] of [[-9,-7,4.5],[-6,-12,5.3],[0,-13,5.5],[6,-11,5.4],[10,-6,4]])oval(x,hy+y,r,r,grad(x-r,hy+y-r,r*2,r*2,hair));
      } else {
        ctx.beginPath();ctx.moveTo(-11,hy+1);ctx.bezierCurveTo(-16,hy-17,9,hy-20,12,hy-5);
        ctx.quadraticCurveTo(5,hy-4,0,hy-8);ctx.quadraticCurveTo(-3,hy-1,-8,hy-3);ctx.lineTo(-8,hy+2);ctx.closePath();ctx.fill();
        ctx.strokeStyle=shade(hair,1.22);ctx.lineWidth=1.1;ctx.beginPath();ctx.moveTo(-8,hy-10);ctx.quadraticCurveTo(0,hy-16,7,hy-10);ctx.stroke();
        if(a.hairStyle===2)capsule(-11,hy-3,5,18,2,hair);
        if(a.hairStyle===3)oval(-4,hy-15,6,5.5,grad(-10,hy-20,12,11,hair));
        if(a.hairStyle===1){ctx.fillStyle=hair;ctx.beginPath();ctx.moveTo(-7,hy-8);ctx.quadraticCurveTo(2,hy+1,11,hy-5);ctx.lineTo(6,hy-12);ctx.fill();}
      }
      if(a.glasses) {
        ctx.strokeStyle='#40544e';ctx.lineWidth=1.1;
        rr(ctx,-6,hy-2.8,6,5.5,1.8);ctx.stroke();rr(ctx,2,hy-2.8,6,5.5,1.8);ctx.stroke();
        ctx.beginPath();ctx.moveTo(0,hy-0.5);ctx.lineTo(2,hy-0.5);ctx.stroke();
      }
    }
    ctx.restore();return hy-20-lift;
  }

  function drawAvatar(ctx, a, o) {
    const skin = a.skin, hair = a.hair, top = a.top || a.shirt, pants = a.pants || '#3b3f4a', tie = a.tie || '#c62828';
    const style = a.style || 'suit';
    const female = style === 'cardigan';
    const sw = o.moving ? Math.sin(o.phase * 13) : 0; // ayunan langkah
    const sit = o.sitting;
    ctx.save();
    if (o.mirror) ctx.scale(-1, 1);
    ctx.lineJoin = 'round';

    // bayangan
    ctx.fillStyle = 'rgba(0,0,0,0.24)';
    ctx.beginPath(); ctx.ellipse(0, 0, 13, 5, 0, 0, 7); ctx.fill();

    // duduk: pinggul turun ke dudukan kursi (±10 px di atas lantai); jalan: badan naik turun
    const lift = sit ? -10 : Math.abs(sw) * 1.2;
    ctx.translate(0, -lift);

    // ---- kaki
    const legTop = -20;
    if (!sit) {
      const legs = [[-6, sw * 2.5], [1, -sw * 2.5]];
      legs.forEach(([lx, off], i) => {
        if (female) {
          ctx.fillStyle = shade(skin, i ? 0.92 : 1);
          ctx.fillRect(lx + 1, legTop + 6 + off * 0.3, 3.5, 13);
        } else {
          ctx.fillStyle = shade(pants, i ? 0.82 : 1);
          ctx.fillRect(lx, legTop + off * 0.3, 5.5, 18);
        }
        ctx.fillStyle = female ? shade(top, 0.6) : '#26272b';
        rr(ctx, lx - 0.5 + off * 0.4, -3.5 + off * 0.2, 7.5, 4, 1.5); ctx.fill();
      });
    } else {
      // duduk: paha mendatar di dudukan, tulang kering & sepatu turun ke lantai (terlihat dari depan)
      ctx.fillStyle = female ? shade(skin, 0.95) : pants;
      ctx.fillRect(-7, legTop - 1, 14, 6);
      if (!o.back) {
        ctx.fillStyle = female ? shade(skin, 0.9) : shade(pants, 0.85);
        ctx.fillRect(-6.5, legTop + 5, 5, 6); ctx.fillRect(1.5, legTop + 5, 5, 6);
        ctx.fillStyle = female ? shade(top, 0.6) : '#26272b';
        rr(ctx, -7.5, legTop + 10, 7, 3.5, 1.5); ctx.fill(); rr(ctx, 0.5, legTop + 10, 7, 3.5, 1.5); ctx.fill();
      }
    }
    if (female) { // rok
      ctx.fillStyle = shade(pants === '#c2b49a' ? '#3b3f6a' : pants, 1.05);
      poly(ctx, [{ x: -8, y: legTop - 1 }, { x: 8, y: legTop - 1 }, { x: 10, y: legTop + 10 }, { x: -10, y: legTop + 10 }], ctx.fillStyle);
    }

    // ---- badan
    const bodyTop = -41, bodyH = 22;
    const torso = top;
    ctx.fillStyle = torso;
    rr(ctx, -9.5, bodyTop, 19, bodyH, 5); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.12)'; // bayangan sisi kanan
    rr(ctx, 4.5, bodyTop + 1, 5, bodyH - 2, 3); ctx.fill();
    if (!o.back) {
      if (style === 'suit') {
        ctx.fillStyle = '#f5f7fa';
        poly(ctx, [{ x: -3.5, y: bodyTop }, { x: 3.5, y: bodyTop }, { x: 0, y: bodyTop + 10 }], '#f5f7fa');
        ctx.fillStyle = tie; ctx.fillRect(-1.1, bodyTop + 1.5, 2.4, 11);
        poly(ctx, [{ x: -1.6, y: bodyTop + 12 }, { x: 1.9, y: bodyTop + 12 }, { x: 0.15, y: bodyTop + 15 }], tie);
        ctx.strokeStyle = shade(torso, 0.7); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(-3.5, bodyTop); ctx.lineTo(0, bodyTop + 13); ctx.lineTo(3.5, bodyTop); ctx.stroke();
      } else if (style === 'shirt') {
        poly(ctx, [{ x: -3.5, y: bodyTop }, { x: 3.5, y: bodyTop }, { x: 0, y: bodyTop + 4 }], shade(torso, 0.85));
        ctx.fillStyle = tie; ctx.fillRect(-1.1, bodyTop + 2, 2.4, 12);
        poly(ctx, [{ x: -1.6, y: bodyTop + 13 }, { x: 1.9, y: bodyTop + 13 }, { x: 0.15, y: bodyTop + 16 }], tie);
        ctx.fillStyle = '#2b2b30'; ctx.fillRect(-9, bodyTop + bodyH - 3, 18, 2.5); // ikat pinggang
      } else {
        ctx.fillStyle = '#f7f1e8'; // atasan dalam
        rr(ctx, -4, bodyTop + 1, 8, bodyH - 4, 2); ctx.fill();
        ctx.fillStyle = '#ffd54f'; ctx.beginPath(); ctx.arc(0, bodyTop + 5, 1.3, 0, 7); ctx.fill(); // kalung
      }
    }
    // lengan
    const arm = (x, swing) => {
      ctx.fillStyle = shade(torso, 0.92);
      rr(ctx, x, bodyTop + 2 + swing, 4.5, 17, 2); ctx.fill();
      ctx.fillStyle = skin; ctx.beginPath(); ctx.arc(x + 2.2, bodyTop + 20 + swing, 2.6, 0, 7); ctx.fill();
    };
    const armSw = o.working ? Math.sin(o.now / 85) * 1.5 : sw * 2.5;
    arm(-13.5, armSw);
    arm(9, -armSw);
    // leher
    ctx.fillStyle = shade(skin, 0.9); ctx.fillRect(-2.5, bodyTop - 3, 5, 4);

    // ---- kepala (besar, khas Habbo)
    const hy = bodyTop - 12;
    // rambut panjang di belakang kepala
    if (a.hairStyle === 2 && !o.back) { ctx.fillStyle = shade(hair, 0.85); rr(ctx, -10.5, hy - 6, 21, 22, 6); ctx.fill(); }
    ctx.fillStyle = skin;
    ctx.beginPath(); ctx.ellipse(0.5, hy, 9.5, 10.5, 0, 0, 7); ctx.fill();
    ctx.fillStyle = shade(skin, 0.9); // telinga
    ctx.beginPath(); ctx.ellipse(-8.5, hy + 1, 2, 3, 0, 0, 7); ctx.fill();

    if (o.back) {
      ctx.fillStyle = hair;
      if (a.hairStyle === 4) { ctx.beginPath(); ctx.ellipse(0.5, hy + 3, 9.6, 6, 0, 0, Math.PI); ctx.fill(); }
      else { ctx.beginPath(); ctx.ellipse(0.5, hy - 0.5, 9.9, 10.8, 0, 0, 7); ctx.fill(); }
      if (a.hairStyle === 2) { rr(ctx, -10, hy, 21, 17, 6); ctx.fill(); }
      if (a.hairStyle === 3) { ctx.beginPath(); ctx.arc(0.5, hy - 11, 5, 0, 7); ctx.fill(); }
    } else {
      // wajah menghadap kanan-bawah (3/4)
      ctx.fillStyle = '#1b1b1f';
      ctx.fillRect(1.5, hy - 1, 2, 3.2); ctx.fillRect(6.5, hy - 1, 2, 3.2);
      ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.fillRect(1.5, hy - 1, 1, 1); ctx.fillRect(6.5, hy - 1, 1, 1);
      ctx.fillStyle = shade(hair, 0.8); ctx.fillRect(1, hy - 3.5, 3, 1); ctx.fillRect(6, hy - 3.5, 3, 1); // alis
      ctx.fillStyle = shade(skin, 0.82); ctx.fillRect(5, hy + 2.5, 1.8, 2); // hidung
      ctx.strokeStyle = shade(skin, 0.55); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(2.5, hy + 6); ctx.quadraticCurveTo(5, hy + 7.2, 7.5, hy + 6); ctx.stroke(); // senyum
      if (female) { ctx.fillStyle = 'rgba(240,98,146,0.35)'; ctx.beginPath(); ctx.arc(0, hy + 4, 1.8, 0, 7); ctx.fill(); ctx.beginPath(); ctx.arc(8.5, hy + 4, 1.6, 0, 7); ctx.fill(); }
      if (a.mustache) { ctx.fillStyle = shade(hair, 0.9); rr(ctx, 1.5, hy + 4, 7, 2, 1); ctx.fill(); }
      if (a.glasses) {
        ctx.strokeStyle = '#2b2b30'; ctx.lineWidth = 1;
        ctx.strokeRect(0.5, hy - 2, 4, 4); ctx.strokeRect(5.5, hy - 2, 4, 4);
        ctx.beginPath(); ctx.moveTo(4.5, hy); ctx.lineTo(5.5, hy); ctx.stroke();
      }
      // rambut
      ctx.fillStyle = hair;
      switch (a.hairStyle) {
        case 4: // botak: hanya samping
          ctx.beginPath(); ctx.ellipse(-6.5, hy - 1, 3.5, 5, 0, 0, 7); ctx.fill();
          break;
        case 1: // belah samping
          ctx.beginPath(); ctx.ellipse(0.5, hy - 5, 10.2, 7, 0, Math.PI, 0); ctx.fill();
          ctx.beginPath(); ctx.moveTo(-9.5, hy - 5); ctx.quadraticCurveTo(2, hy - 13, 10.5, hy - 3); ctx.lineTo(10, hy - 6); ctx.quadraticCurveTo(1, hy - 9, -9, hy - 2); ctx.fill();
          ctx.fillRect(-10, hy - 5, 4, 8);
          break;
        case 2: // panjang
          ctx.beginPath(); ctx.ellipse(0.5, hy - 4.5, 10.4, 7.5, 0, Math.PI, 0); ctx.fill();
          ctx.fillRect(-10.5, hy - 5, 5, 18);
          ctx.beginPath(); ctx.moveTo(-6, hy - 9); ctx.quadraticCurveTo(4, hy - 6, 10.8, hy - 2); ctx.lineTo(10.8, hy - 6); ctx.fill();
          break;
        case 3: // cepol
          ctx.beginPath(); ctx.ellipse(0.5, hy - 4.5, 10.2, 7.2, 0, Math.PI, 0); ctx.fill();
          ctx.beginPath(); ctx.arc(-5, hy - 12, 5, 0, 7); ctx.fill();
          ctx.fillRect(-10, hy - 5, 3.5, 7);
          break;
        case 5: // ikal
          for (const [cx, cy, r] of [[-6, -8, 4.5], [-1, -10, 4.8], [4.5, -9.5, 4.5], [8.5, -6.5, 3.5], [-8.5, -3, 3.8]]) { ctx.beginPath(); ctx.arc(cx + 0.5, hy + cy, r, 0, 7); ctx.fill(); }
          break;
        default: // pendek
          ctx.beginPath(); ctx.ellipse(0.5, hy - 5, 10, 6.8, 0, Math.PI, 0); ctx.fill();
          ctx.fillRect(-10, hy - 5, 4, 6);
          ctx.beginPath(); ctx.moveTo(-6, hy - 8); ctx.lineTo(9, hy - 7); ctx.lineTo(10.3, hy - 3.5); ctx.lineTo(4, hy - 5.5); ctx.fill();
      }
    }
    ctx.restore();
    return hy - 11 - lift; // posisi puncak kepala (untuk mahkota/ikon)
  }

  /**
   * Karakter robot (tema Robot): kepala putih dengan layar wajah, badan putih,
   * lengan & kaki oranye. Aksesori menyesuaikan jabatan. Kaki di (0,0).
   */
  function drawRobot(ctx, a, o) {
    const role = String(a.role || '').toLowerCase();
    const accent = a.id === 'boss' ? '#ffca28' : a.top || ORANGE;
    const limb = a.id === 'boss' ? '#3a3f6b' : ORANGE;
    const limbDark = shade(limb, 0.82);
    const t = (o.now || 0) / 1000;
    let seed = 0; for (const c of String(o.seed || '')) seed = (seed * 31 + c.charCodeAt(0)) % 997;
    const sit = o.sitting;
    const walk = o.moving ? o.phase * 9.5 : 0; // siklus langkah
    const step = o.moving ? Math.sin(walk) : 0;
    const happy = o.happy || 0; // 0..1 selama selebrasi
    const hop = happy ? Math.sin(happy * Math.PI) * 9 : 0;
    const breathe = Math.sin(t * 2.1 + seed) * 0.8;
    const bounce = o.moving ? Math.abs(Math.sin(walk)) * 2.2 : 0;
    const lift = (sit ? -9 : 0) + bounce + hop; // duduk: pinggul turun ke dudukan kursi

    // capsule yang berputar di titik sendi; mengembalikan titik ujungnya
    const seg = (x, y, ang, len, w, col) => {
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
      ctx.fillStyle = col; rr(ctx, -w / 2, -w / 2 + 0.5, w, len + w / 2, w / 2); ctx.fill();
      ctx.restore();
      return { x: x - Math.sin(ang) * len, y: y + Math.cos(ang) * len };
    };
    const joint = (p, r, col) => { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill(); };

    ctx.save();
    if (o.mirror) ctx.scale(-1, 1);
    // bayangan mengecil saat melompat
    ctx.fillStyle = 'rgba(40,50,120,0.18)';
    ctx.beginPath(); ctx.ellipse(0, 0, 13 - hop * 0.4, 5 - hop * 0.15, 0, 0, 7); ctx.fill();
    ctx.translate(0, -lift);

    // ---- kaki (pinggul → lutut → telapak)
    const hipY = -19;
    if (!sit) {
      const legs = [[-3.5, step, true], [3.5, -step, false]];
      for (const [hx, s, far] of legs) {
        const thighA = s * 0.55 - (happy ? 0.25 : 0);
        const kneeA = thighA + Math.max(0, -s) * 0.75 + (happy ? 0.5 : 0); // lutut menekuk saat kaki di belakang
        const knee = seg(hx, hipY, -thighA, 6.5, 5, far ? limbDark : limb);
        const foot = seg(knee.x, knee.y, -kneeA * 0.4, 5.5, 4.5, far ? limbDark : limb);
        ctx.fillStyle = far ? '#dde0ea' : '#f5f6fb';
        rr(ctx, foot.x - 3.5, foot.y - 2.5, 8.5, 5, 2.4); ctx.fill();
        ctx.fillStyle = '#3a3f55'; ctx.fillRect(foot.x - 3.5, foot.y + 1.6, 8.5, 1.4);
      }
    } else {
      for (const [hx, far] of [[-3.5, true], [3.5, false]]) {
        const knee = seg(hx, hipY + 1, -Math.PI / 2 + 0.15, 7, 5, far ? limbDark : limb);
        seg(knee.x, knee.y, 0.1 + Math.sin(t * 1.3 + seed + hx) * 0.08, 5, 4.5, far ? limbDark : limb); // kaki berayun pelan
      }
    }

    // ---- badan (condong ke depan saat berjalan, bernapas saat diam)
    const lean = o.moving ? 0.08 : 0;
    ctx.save();
    ctx.translate(0, hipY);
    ctx.rotate(lean);
    ctx.translate(0, -hipY);
    ctx.fillStyle = '#3a3f55'; rr(ctx, -8, hipY - 2, 16, 5, 2); ctx.fill(); // pinggul
    const bt = -37 - breathe * 0.4;
    // lengan belakang (jauh) digambar sebelum badan
    const typing = o.working;
    const armBase = (side) => {
      if (happy) return -2.5 + Math.sin(t * 14 + side) * 0.2; // tangan terangkat
      if (o.moving) return side * step * 0.7;
      if (typing) return sit && o.back ? -0.6 : -0.9;
      return 0.12 * side + Math.sin(t * 1.6 + seed + side) * 0.06;
    };
    const elbow = (side) => (typing ? -0.9 + Math.sin(t * 11 + side * 1.7) * 0.25 : o.moving ? -0.35 - Math.max(0, side * step) * 0.4 : -0.15);
    const drawArm = (sx, side, far) => {
      const sh = { x: sx, y: bt + 4 };
      const el = seg(sh.x, sh.y, armBase(side), 6.5, 4.5, far ? limbDark : limb);
      const hd = seg(el.x, el.y, armBase(side) + elbow(side), 6, 4.2, far ? limbDark : limb);
      joint(sh, 3.3, far ? limbDark : limb);
      joint(hd, 2.8, far ? '#dde0ea' : '#f5f6fb');
    };
    drawArm(-10.5, -1, true);

    const bg = ctx.createLinearGradient(-10, bt, 10, bt + 18);
    bg.addColorStop(0, '#ffffff'); bg.addColorStop(1, '#e3e6f1');
    ctx.fillStyle = bg; rr(ctx, -10.5, bt, 21, 18 + breathe * 0.4, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(40,50,110,0.10)'; ctx.lineWidth = 1; rr(ctx, -10.5, bt, 21, 18, 7); ctx.stroke();
    if (!o.back) {
      ctx.fillStyle = accent; rr(ctx, -5.5, bt + 4, 11, 8, 2.5); ctx.fill(); // panel dada
      const pulse = 0.55 + Math.sin(t * (typing ? 8 : 2.5) + seed) * 0.35; // lampu dada berdenyut
      ctx.fillStyle = `rgba(255,255,255,${pulse.toFixed(2)})`; ctx.beginPath(); ctx.arc(-2, bt + 8, 1.4, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.fillRect(1, bt + 7.2, 3, 1.5);
    } else {
      ctx.fillStyle = '#dfe2ee'; rr(ctx, -6, bt + 3, 12, 11, 3); ctx.fill();
      ctx.fillStyle = '#c9cde0'; ctx.fillRect(-3, bt + 6, 6, 1.2); ctx.fillRect(-3, bt + 9, 6, 1.2);
    }
    drawArm(10.5, 1, false);
    ctx.fillStyle = '#3a3f55'; ctx.fillRect(-2.5, bt - 3, 5, 4); // leher

    // ---- kepala: miring pelan, mengangguk saat mengetik, menoleh sesekali
    const nod = typing ? Math.sin(t * 5.5 + seed) * 0.05 : 0;
    const tilt = Math.sin(t * 0.8 + seed) * 0.06 + nod + (happy ? Math.sin(t * 12) * 0.1 : 0);
    const hy = bt - 21; // sisi atas kepala
    ctx.save();
    ctx.translate(0, bt - 1);
    ctx.rotate(tilt);
    ctx.translate(0, -(bt - 1));
    const hg = ctx.createLinearGradient(-12, hy, 12, hy + 20);
    hg.addColorStop(0, '#ffffff'); hg.addColorStop(1, '#e4e7f2');
    ctx.fillStyle = hg; rr(ctx, -12, hy, 24, 20, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(40,50,110,0.12)'; rr(ctx, -12, hy, 24, 20, 7); ctx.stroke();
    ctx.fillStyle = '#d4d8e6'; rr(ctx, -13.5, hy + 7, 3, 7, 1.5); ctx.fill(); // telinga
    if (!o.back) {
      ctx.fillStyle = '#16193a'; rr(ctx, -7.5, hy + 4, 17, 12, 4); ctx.fill(); // layar wajah
      ctx.fillStyle = 'rgba(139,233,255,0.08)'; rr(ctx, -6.5, hy + 5, 15, 4, 2); ctx.fill(); // kilau layar
      // mata: berkedip, melirik, senang (^ ^), hijau saat bekerja
      const blink = ((t + seed) % 4.2) < 0.12;
      const glanceT = (t + seed * 0.37) % 7;
      const look = o.moving ? 1.5 : glanceT < 1 ? -1.6 : glanceT < 1.6 ? 1.4 : 0;
      const eye = o.working ? '#7dffb2' : '#8be9ff';
      ctx.fillStyle = eye; ctx.strokeStyle = eye; ctx.lineWidth = 1.4;
      if (happy || o.cheer) {
        for (const ex of [-1.5, 5.5]) { ctx.beginPath(); ctx.moveTo(ex - 2, hy + 11); ctx.lineTo(ex, hy + 8.5); ctx.lineTo(ex + 2, hy + 11); ctx.stroke(); }
      } else if (blink) {
        ctx.fillRect(-3.5 + look, hy + 10, 4, 1.2); ctx.fillRect(3.5 + look, hy + 10, 4, 1.2);
      } else {
        rr(ctx, -3.5 + look, hy + 7, 4, 5.5, 1.3); ctx.fill(); rr(ctx, 3.5 + look, hy + 7, 4, 5.5, 1.3); ctx.fill();
      }
      if (o.talking) { // gelombang suara saat bicara
        ctx.fillStyle = eye;
        for (let k = 0; k < 5; k++) { const h = 0.8 + Math.abs(Math.sin(t * 16 + k * 1.3)) * 2; ctx.fillRect(-3 + k * 2.4, hy + 14.2 - h / 2, 1.3, h); }
      }
      if (a.glasses) { ctx.strokeStyle = '#8be9ff'; ctx.lineWidth = 0.8; ctx.strokeRect(-4.5, hy + 6, 13, 7.5); }
    } else {
      ctx.fillStyle = '#d9dcea'; rr(ctx, -6, hy + 5, 12, 10, 3); ctx.fill();
    }

    // aksesori sesuai jabatan + antena yang bergoyang seperti per
    let topY = hy;
    if (/voice|audio|suara|musik|music|call|support|customer|cs\b|telemarket/.test(role)) {
      ctx.strokeStyle = accent; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, hy + 6, 14, Math.PI * 1.08, Math.PI * 1.92); ctx.stroke();
      ctx.fillStyle = accent; rr(ctx, -15.5, hy + 4, 5, 10, 2); ctx.fill(); rr(ctx, 10.5, hy + 4, 5, 10, 2); ctx.fill();
      topY = hy - 9;
    } else if (/video|film|editor|render|reel|motion|animat/.test(role)) {
      const spin = t * (o.working ? 4 : 0.8);
      for (const [x, y] of [[-5, hy - 6], [5, hy - 7]]) {
        ctx.fillStyle = '#3a3f55'; ctx.beginPath(); ctx.arc(x, y, 5.5, 0, 7); ctx.fill();
        ctx.fillStyle = '#f4f5fa';
        for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.arc(x + Math.cos(spin + k * 1.57) * 2.8, y + Math.sin(spin + k * 1.57) * 2.8, 1.1, 0, 7); ctx.fill(); }
      }
      topY = hy - 13;
    } else if (a.id !== 'boss') {
      const wob = Math.sin(t * 3.2 + seed) * 0.18 + (o.moving ? Math.sin(walk * 2) * 0.25 : 0) + (happy ? Math.sin(t * 20) * 0.4 : 0);
      const tip = { x: Math.sin(wob) * 7, y: hy - Math.cos(wob) * 7 };
      ctx.strokeStyle = '#3a3f55'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(0, hy); ctx.quadraticCurveTo(tip.x * 0.3, hy - 4, tip.x, tip.y); ctx.stroke();
      ctx.fillStyle = a.isDirector ? '#9b5de5' : a.isLead ? '#ffca28' : CORAL;
      ctx.beginPath(); ctx.arc(tip.x, tip.y - 1, 2.6, 0, 7); ctx.fill();
      if (o.working) { ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.beginPath(); ctx.arc(tip.x - 0.8, tip.y - 1.8, 0.9, 0, 7); ctx.fill(); }
      topY = hy - 10;
    }
    ctx.restore(); // kepala
    ctx.restore(); // badan
    ctx.restore();
    return topY - lift;
  }
  R.drawRobot = drawRobot;

  /* ------------------------------------------------------------ karakter 3D (office_cast_lineup.glb) */
  // 14 karakter dari office_cast_lineup.glb dipra-render (three.js, tools/cast/) menjadi sprite sheet:
  // baris = depan | belakang | samping(kanan); kolom = idle, jalan×4, duduk, mengetik×2, sorak.
  const CAST = (R.cast = { ready: false, meta: null, chars: [], img: {} });
  fetch('assets/cast/cast.json').then((r) => r.json()).then((j) => {
    CAST.meta = j.meta; CAST.chars = j.chars;
    let left = j.chars.length;
    for (const c of j.chars) {
      const im = new Image();
      im.onload = () => { CAST.img[c.id] = im; if (--left === 0) { CAST.ready = true; portraitCache.clear(); } };
      im.onerror = () => { left--; };
      im.src = `assets/cast/cast-${c.id}.png`;
    }
  }).catch(() => {});
  // kelompok karakter per gaya; dipilih deterministik dari id agen (bisa ditimpa ent.cast)
  const CAST_GROUP = { suit: ['01', '06', '07', '11', '12', '13', '04'], shirt: ['02', '08', '10', '14'], cardigan: ['03', '05', '09'] };
  VO.CAST_LIST = [
    ['01', 'Manajer jas navy'], ['02', 'Kemeja biru'], ['03', 'Kardigan pink'], ['04', 'Jas coklat berkacamata'], ['05', 'Kardigan pirang'],
    ['06', 'Manajer jas abu (botak)'], ['07', 'Jas navy dasi merah (berjenggot)'], ['08', 'Dasi hijau'], ['09', 'Kardigan magenta (kepang)'],
    ['10', 'Kemeja biru muda'], ['11', 'Senior jas (botak)'], ['12', 'Jas hitam'], ['13', 'Jas dasi merah'], ['14', 'Kemeja berkumis'],
  ];
  VO.castOf = function (ent) {
    if (ent.cast && /^\d\d$/.test(ent.cast)) return ent.cast;
    if (ent.id === 'boss') return '12';
    if (ent.glasses) return '04';
    if (ent.mustache) return '14';
    const g = CAST_GROUP[ent.style] || CAST_GROUP.suit;
    let h = 0; for (const ch of String(ent.id || ent.name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return g[h % g.length];
  };
  const CAST_SCALE = 0.4; // tinggi berdiri ≈ 57 px dunia
  // Gambar satu karakter; kaki di (0,0). Mengembalikan y puncak kepala (lokal).
  function drawCast(ctx, ent, o) {
    const im = CAST.img[VO.castOf(ent)];
    const M = CAST.meta;
    let col = 0;
    if (o.happy > 0 || o.cheer) col = 8;
    else if (o.moving) col = 1 + (Math.floor(o.phase * 7) % 4);
    else if (o.sitting) col = o.working ? 6 + (Math.floor(o.now / 170) % 2) : 5;
    const row = o.side ? 2 : o.back ? 1 : 0;
    const sw = M.frameW, sh = M.frameH;
    const dw = sw * CAST_SCALE, dh = sh * CAST_SCALE;
    const ax = M.anchorX * CAST_SCALE, ay = M.anchorY * CAST_SCALE;
    // bayangan
    ctx.fillStyle = 'rgba(30,35,50,0.18)';
    ctx.beginPath(); ctx.ellipse(0, 0, 12, 4.5, 0, 0, 7); ctx.fill();
    ctx.save();
    if (o.mirror && o.side) ctx.scale(-1, 1);
    const bob = !o.moving && !o.sitting ? Math.sin(o.now / 520 + (o.seedN || 0)) * 0.4 : 0;
    ctx.drawImage(im, col * sw, row * sh, sw, sh, -ax, -ay + bob, dw, dh);
    ctx.restore();
    return (M.headY - M.anchorY) * CAST_SCALE + (o.sitting ? 0.45 * M.unitPx * CAST_SCALE : 0) - 2;
  }

  function drawPerson(ctx, s, ent, rt, now) {
    const fx = rt.x / T, fy = rt.y / T;
    const p = iso(fx, fy);
    const moving = rt.cur && rt.cur.type === 'goto' && rt.path && rt.path.length > 0;
    let back = false, mirror = false, side = false;
    // arah hadap di dunia → arah di layar (ikut putaran kamera)
    let hx = null, hy = null;
    if (rt.sitting) { hx = 0; hy = VO.facesFront(s, ent) ? 1 : -1; } // boss/direktur menghadap +y, karyawan menghadap meja (-y)
    else if (rt.mdx != null) { hx = rt.mdx; hy = rt.mdy; }
    if (hx != null) {
      const sx = hx * CYA - hy * SYA, sy = hx * SYA + hy * CYA;
      side = Math.abs(sx) > Math.abs(sy) * 1.3;
      back = !side && sy < 0;
      mirror = sx < -0.1;
    }
    const sel = R.selected === ent.id, hov = R.hover === ent.id;
    if (sel || hov) {
      ctx.strokeStyle = sel ? '#ffd166' : 'rgba(255,255,255,0.75)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, 16, 7, 0, 0, 7); ctx.stroke(); ctx.lineWidth = 1;
    }
    ctx.save();
    ctx.translate(p.x, p.y + (rt.sitting && back ? -2 : 0));
    const castOn = CAST.ready && CAST.img[VO.castOf(ent)];
    const SC = castOn ? (FLAT ? 0.85 : 1) : FLAT ? 0.95 : luxe() ? 1.25 : 1.15;
    ctx.scale(SC, SC);
    const look = ent.live ? { ...ent, top: '#d97757', style: 'shirt', tie: '#5e2b1c' } : ent;
    const happy = rt.happyUntil && rt.happyUntil > now ? 1 - (rt.happyUntil - now) / 1400 : 0;
    const talking = !!(rt.bubble && rt.bubble.until > now && now - (rt.bubble.until - 3000) < 1600);
    const opts = { back, mirror, moving, phase: rt.phase, sitting: rt.sitting, working: rt.working, now, seed: ent.id, happy, talking, cheer: rt.status === 'chat' };
    opts.side = side; opts.seedN = (ent.id || '').length;
    const headTop = castOn ? drawCast(ctx, look, opts) : robot() ? drawRobot(ctx, look, opts) : studio() ? drawStudioAvatar(ctx, look, opts) : drawAvatar(ctx, look, opts);
    if (ent.id === 'boss') { // mahkota
      ctx.fillStyle = '#ffca28';
      const y = headTop + 2;
      poly(ctx, [{ x: -7, y }, { x: -7, y: y - 7 }, { x: -3.5, y: y - 3 }, { x: 0, y: y - 9 }, { x: 3.5, y: y - 3 }, { x: 7, y: y - 7 }, { x: 7, y }], '#ffca28', '#b8860b');
    }
    ctx.restore();
    rt._screen = { x: p.x, y: p.y, head: p.y + headTop * SC };
  }

  /* ------------------------------------------------------------ overlay: label, nama, balon */
  function drawLabels(ctx, s) {
    if (studio()) return drawLabelsStudio(ctx, s);
    if (modern()) return; // nama tim sudah dicat di lantai
    if (luxe()) return drawLabelsLuxe(ctx, s);
    ctx.font = 'bold 13px Inter, system-ui, sans-serif';
    for (const div of s.divisions) {
      const p = iso(div.zone.x + 0.5, div.zone.y + 0.5);
      const label = 'Divisi ' + div.name;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = div.color; rr(ctx, p.x - 6, p.y - 12, tw + 32, 22, 6); ctx.fill();
      VO.drawIcon(ctx, 'layers', p.x + 6, p.y - 1, 12, '#fff');
      ctx.fillStyle = '#fff'; ctx.fillText(label, p.x + 17, p.y + 4);
    }
    ctx.font = 'bold 11px Inter, system-ui, sans-serif';
    const plate = (r, text, color, z = 50) => {
      const p = iso(r.x + 1.2, r.y + 1, z);
      const tw = ctx.measureText(text).width + 14;
      ctx.fillStyle = color; rr(ctx, p.x - 4, p.y - 9, tw, 17, 5); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.fillText(text, p.x + 3, p.y + 3);
    };
    for (const f of s.facilities) plate(f, f.name, f.color);
    for (const d of s.departments) {
      const div = s.divisions.find((x) => x.id === d.divisionId);
      plate(d.room, d.name, div ? div.color : '#888888', VO.openPlan(s) ? 22 : 50);
    }
  }

  // Studio: papan nama gelap dengan huruf berwarna (gaya piksel), jumlah orang di departemen
  function drawLabelsStudio(ctx, s) {
    const plate = (p, text, color) => {
      ctx.save();
      ctx.font = "600 11px Inter, system-ui, sans-serif";
      try { ctx.letterSpacing = '1px'; } catch (e) {}
      const tw = ctx.measureText(text).width + 16;
      ctx.fillStyle = 'rgba(32,58,50,0.93)'; rr(ctx, p.x - tw / 2, p.y - 9, tw, 19, 6); ctx.fill();
      ctx.fillStyle = color; ctx.fillText(text, p.x - tw / 2 + 8, p.y + 3.5);
      ctx.restore();
    };
    for (const f of s.facilities) plate(iso(f.x + f.w / 2, f.y + f.h - 0.2, 40), f.name.toUpperCase(), mix(f.color, '#ffffff', 0.45));
    for (const d of s.departments) {
      const n = VO.deptAgents(s, d.id).length;
      plate(iso(d.room.x + d.room.w / 2, d.room.y + 0.7, 26), `${d.name.toUpperCase()} · ${n}`, shade(deptColor(s, d), 1.08));
    }
    for (const div of s.divisions) {
      const p = iso(div.zone.x + 1.2, div.zone.y + 1.4);
      ctx.save(); ctx.font = "bold 10px 'Courier New', ui-monospace, monospace";
      const tw = ctx.measureText(div.name.toUpperCase()).width + 22;
      ctx.fillStyle = div.color; rr(ctx, p.x, p.y - 8, tw, 16, 8); ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.fillText(div.name.toUpperCase(), p.x + 11, p.y + 3.5); ctx.restore();
    }
  }

  // Papan nama gelap mengambang di atas dinding belakang ruangan
  function drawLabelsLuxe(ctx, s) {
    const plate = (r, text, color, icon, z = 74) => {
      const p = iso(r.x + 1.3, r.y + 1, z);
      ctx.font = 'bold 11px Inter, system-ui, sans-serif';
      const tw = ctx.measureText(text).width + 30;
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
      ctx.fillStyle = 'rgba(18,20,28,0.9)'; rr(ctx, p.x - 6, p.y - 10, tw, 20, 10); ctx.fill(); ctx.restore();
      ctx.strokeStyle = alpha(LX.gold, 0.55); rr(ctx, p.x - 6, p.y - 10, tw, 20, 10); ctx.stroke();
      VO.drawIcon(ctx, icon, p.x + 6, p.y, 10, color);
      ctx.fillStyle = '#f4efe6'; ctx.fillText(text, p.x + 16, p.y + 4);
    };
    for (const div of s.divisions) plate({ x: div.zone.x, y: div.zone.y - 0.4 }, div.name, div.color, 'layers', 30);
    const FI = { boss: 'crown', meeting: 'meeting', pantry: 'coffee', lounge: 'sofa', pool: 'droplet', billiard: 'gamepad' };
    for (const f of s.facilities) plate(f, f.name, LX.gold, FI[f.type] || 'door', f.type === 'pool' ? 24 : 74);
    for (const d of s.departments) {
      const div = s.divisions.find((x) => x.id === d.divisionId);
      plate(d.room, d.name, div ? div.color : LX.gold, VO.integ && VO.integ.forDept(s, d)?.icon || 'building', VO.openPlan(s) ? 26 : 74);
    }
  }

  // Gaya Penthouse: label pil gelap di bawah kaki, balon putih di atas kepala, lencana "!" merah
  // ukuran label nama (pil) — dipakai untuk menggambar & menata agar tidak saling tumpuk
  function luxeLabel(ctx, ent) {
    const sel = R.selected === ent.id, hov = R.hover === ent.id;
    if (!(R.cam.zoom >= 0.45 || sel || hov)) return null;
    const name = ent.name;
    const role = ent.id === 'boss' ? 'Boss' : (ent.role || '').split(' ').slice(0, 2).join(' ');
    const showRole = R.cam.zoom >= 0.9 || sel || hov;
    ctx.font = 'bold 9.5px Inter, system-ui, sans-serif';
    const w1 = ctx.measureText(name).width;
    ctx.font = '8.5px Inter, system-ui, sans-serif';
    const w2 = showRole && role ? ctx.measureText(role).width + 5 : 0;
    return { name, role, w1, w2, pw: w1 + w2 + 22, ph: 15 };
  }
  // Label yang bertabrakan digeser ke baris bawah/atas (meja berjajar sejajar di tampilan depan)
  let labelFrame = 0;
  function layoutLabels(ctx, people) {
    labelFrame++;
    if (!(luxe() || studio())) return;
    const placed = [];
    const hit = (r) => placed.some((q) => r.x < q.x + q.w + 3 && q.x < r.x + r.w + 3 && r.y < q.y + q.h + 2 && q.y < r.y + r.h + 2);
    const items = people.filter(([, rt]) => rt._screen).map(([e, rt]) => ({ e, rt, L: luxeLabel(ctx, e) })).filter((i) => i.L);
    // yang dipilih ditata dulu agar tetap di tempatnya
    items.sort((a, b) => (R.selected === b.e.id) - (R.selected === a.e.id) || a.rt._screen.x - b.rt._screen.x);
    for (const { rt, L } of items) {
      const sc = rt._screen;
      let dy = 0;
      for (const k of [0, 1, 2, -1, 3]) {
        const r = { x: sc.x - L.pw / 2, y: sc.y + 7 + k * (L.ph + 3), w: L.pw, h: L.ph };
        if (!hit(r)) { dy = k * (L.ph + 3); placed.push(r); break; }
      }
      rt._labelDy = dy; rt._labelF = labelFrame;
    }
  }

  function drawOverlayLuxe(ctx, ent, rt, now, sc) {
    const busy = rt.working || ['briefing', 'reporting', 'meeting'].includes(rt.status);
    const sel = R.selected === ent.id, hov = R.hover === ent.id;
    const L = luxeLabel(ctx, ent);
    if (L) {
      const { name, role, w1, w2, pw, ph } = L;
      const px = sc.x - pw / 2, py = sc.y + 7 + (rt._labelF === labelFrame ? rt._labelDy : 0);
      ctx.fillStyle = sel ? 'rgba(48,40,22,0.95)' : 'rgba(16,18,24,0.86)'; rr(ctx, px, py, pw, ph, 7.5); ctx.fill();
      if (sel) { ctx.strokeStyle = LX.gold; ctx.lineWidth = 1.2; rr(ctx, px, py, pw, ph, 7.5); ctx.stroke(); ctx.lineWidth = 1; }
      ctx.fillStyle = busy ? '#ffb347' : rt.status === 'walking' ? '#9aa3b8' : '#4cd38a';
      ctx.beginPath(); ctx.arc(px + 8, py + ph / 2, 2.8, 0, 7); ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.font = 'bold 9.5px Inter, system-ui, sans-serif'; ctx.fillText(name, px + 14, py + 10.8);
      if (w2) { ctx.fillStyle = '#a9b0c2'; ctx.font = '8.5px Inter, system-ui, sans-serif'; ctx.fillText(role, px + 19 + w1, py + 10.8); }
      if (rt.working && rt.progress > 0 && rt.progress < 1 && !ent.live) {
        ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(px + 8, py + ph + 2, pw - 16, 2.5);
        ctx.fillStyle = '#ffb347'; ctx.fillRect(px + 8, py + ph + 2, (pw - 16) * rt.progress, 2.5);
      }
    }
    // lencana merah "!" saat menunggu Boss (melapor / briefing) atau tugas gagal
    let by = sc.head - 28;
    if (rt.status === 'reporting' || rt.status === 'briefing' || rt.alert) {
      const bx = sc.x + 11, byy = sc.head - 6 + Math.sin(now / 250) * 1.5;
      ctx.fillStyle = '#e53935'; ctx.beginPath(); ctx.arc(bx, byy, 6, 0, 7); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.3; ctx.stroke(); ctx.lineWidth = 1;
      ctx.fillStyle = '#fff'; ctx.font = 'bold 9px Inter, system-ui, sans-serif'; ctx.fillText('!', bx - 1.5, byy + 3.3);
    }
    if (!(rt.bubble && rt.bubble.until > now) && rt.working && rt.activity && (R.cam.zoom >= 0.7 || sel || hov)) {
      drawPill(ctx, sc.x, by, rt.activity, 'monitor', 1);
      return;
    }
    if (rt.bubble && rt.bubble.until > now) drawPill(ctx, sc.x, by, rt.bubble.text, rt.bubble.icon || VO.sim.STATUS_ICON[rt.status], Math.min(1, (rt.bubble.until - now) / 300));
  }

  // Balon pil putih dengan ikon (gaya "Tayang Kam 18.00")
  function drawPill(ctx, cx, y, text, icon, a) {
    ctx.font = '10.5px Inter, system-ui, sans-serif';
    let s2 = String(text);
    while (s2.length > 4 && ctx.measureText(s2).width > 190) s2 = s2.slice(0, -2);
    if (s2 !== String(text)) s2 = s2.trimEnd() + '…';
    const iw = icon ? 15 : 0;
    const w = ctx.measureText(s2).width + iw + 16, h = 19;
    const x = cx - w / 2;
    ctx.globalAlpha = a;
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#ffffff'; rr(ctx, x, y, w, h, 9.5); ctx.fill(); ctx.restore();
    ctx.strokeStyle = 'rgba(30,40,70,0.18)'; rr(ctx, x, y, w, h, 9.5); ctx.stroke();
    if (icon) VO.drawIcon(ctx, icon, x + 12, y + h / 2, 10, '#5b6cff');
    ctx.fillStyle = '#1d2230'; ctx.fillText(s2, x + 8 + iw, y + 13.3);
    ctx.globalAlpha = 1;
  }

  function drawPersonOverlay(ctx, ent, rt, now) {
    const sc = rt._screen;
    if (!sc) return;
    if (luxe() || studio()) return drawOverlayLuxe(ctx, ent, rt, now, sc);
    const icon = rt.liveTool && rt.liveTool !== 'thinking' ? 'tool' : rt.liveTool === 'thinking' ? 'brain' : VO.sim.STATUS_ICON[rt.status];
    const sel0 = R.selected === ent.id, hov0 = R.hover === ent.id;
    let bubbleY = sc.head - 30;
    if (robot() && (R.cam.zoom >= 0.45 || sel0 || hov0)) {
      // label pil: titik status · Nama · Jabatan, plus chip aktivitas saat bekerja
      const name = ent.name;
      const showRole = R.cam.zoom >= 1.7 || sel0 || hov0;
      const role = showRole ? (ent.id === 'boss' ? 'Boss (Kamu)' : ent.role || '') : '';
      ctx.font = 'bold 9.5px Inter, system-ui, sans-serif';
      const w1 = ctx.measureText(name).width;
      ctx.font = '9px Inter, system-ui, sans-serif';
      const w2 = role ? ctx.measureText(' · ' + role).width : 0;
      const pw = w1 + w2 + 24, ph = 16;
      const px = sc.x - pw / 2, py = sc.head - ph - 10;
      ctx.save();
      ctx.shadowColor = 'rgba(40,50,120,0.16)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
      ctx.fillStyle = '#ffffff'; rr(ctx, px, py, pw, ph, 9); ctx.fill();
      ctx.restore();
      if (sel0) { ctx.strokeStyle = NAVY; ctx.lineWidth = 1.5; rr(ctx, px, py, pw, ph, 9); ctx.stroke(); ctx.lineWidth = 1; }
      const busy = rt.working || ['briefing', 'reporting', 'meeting'].includes(rt.status);
      ctx.fillStyle = busy ? ORANGE : rt.status === 'walking' ? '#9aa3b8' : '#2fb36b';
      ctx.beginPath(); ctx.arc(px + 9, py + ph / 2, 3.2, 0, 7); ctx.fill();
      ctx.fillStyle = '#1b2140'; ctx.font = 'bold 9.5px Inter, system-ui, sans-serif'; ctx.fillText(name, px + 16, py + 11.3);
      if (role) { ctx.fillStyle = '#6b7190'; ctx.font = '9px Inter, system-ui, sans-serif'; ctx.fillText(' · ' + role, px + 16 + w1, py + 11.3); }
      const chipTxt = rt.liveTool && rt.liveTool !== 'thinking' ? 'Pakai ' + rt.liveTool
        : rt.working ? (rt.activity || 'Sedang bekerja') + (rt.progress > 0 && rt.progress < 1 ? ` · ${Math.round(rt.progress * 100)}%` : '')
        : ({ briefing: 'Menerima briefing', reporting: 'Melapor ke atasan', meeting: 'Rapat' })[rt.status];
      let top = py;
      if (chipTxt) {
        ctx.font = 'bold 9px Inter, system-ui, sans-serif';
        const cw = Math.min(170, ctx.measureText(chipTxt).width) + 14;
        const cx = sc.x - cw / 2, cy = py + ph + 3;
        ctx.fillStyle = ORANGE; rr(ctx, cx, cy, cw, 15, 4); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.save(); ctx.beginPath(); ctx.rect(cx + 4, cy, cw - 8, 15); ctx.clip();
        ctx.fillText(chipTxt, cx + 7, cy + 10.8); ctx.restore();
      }
      if (!chipTxt) drawBubble(ctx, rt, sc, top - 26, now); // chip sudah menjelaskan aktivitas
      return;
    }
    if (modern() && (R.cam.zoom >= 0.5 || sel0 || hov0)) {
      // kartu nama melayang: nama (tebal) + jabatan
      const name = ent.name, role = ent.id === 'boss' ? 'Boss (Kamu)' : ent.role || '';
      ctx.font = 'bold 10.5px Inter, system-ui, sans-serif';
      const w1 = ctx.measureText(name).width;
      ctx.font = '9px Inter, system-ui, sans-serif';
      const w2 = ctx.measureText(role).width;
      const iw = icon || ent.isLead || ent.isDirector ? 14 : 0;
      const cw = Math.max(w1, w2) + 16 + iw, ch = 29;
      const cx = sc.x - cw / 2, cy = sc.head - ch - 8;
      ctx.save();
      ctx.shadowColor = 'rgba(30,40,70,0.18)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
      ctx.fillStyle = sel0 ? '#fff8e6' : '#ffffff'; rr(ctx, cx, cy, cw, ch, 7); ctx.fill();
      ctx.restore();
      ctx.strokeStyle = sel0 ? '#f0b429' : 'rgba(40,50,80,0.12)'; ctx.lineWidth = 1; rr(ctx, cx, cy, cw, ch, 7); ctx.stroke();
      if (iw) VO.drawIcon(ctx, icon || (ent.isDirector ? 'briefcase' : 'star'), cx + 11, cy + ch / 2, 9, rt.working ? '#3b7cff' : ent.isDirector ? '#8e44ad' : ent.isLead && !icon ? '#e0a100' : '#6b7385');
      ctx.fillStyle = '#1d2230'; ctx.font = 'bold 10.5px Inter, system-ui, sans-serif'; ctx.fillText(name, cx + 8 + iw, cy + 12.5);
      ctx.fillStyle = '#6b7385'; ctx.font = '9px Inter, system-ui, sans-serif'; ctx.fillText(role, cx + 8 + iw, cy + 23.5);
      if (rt.working && rt.progress > 0 && rt.progress < 1 && !ent.live) {
        ctx.fillStyle = '#e6eaf1'; ctx.fillRect(cx + 6, cy + ch - 3.5, cw - 12, 2.5);
        ctx.fillStyle = '#3b7cff'; ctx.fillRect(cx + 6, cy + ch - 3.5, (cw - 12) * rt.progress, 2.5);
      }
      bubbleY = cy - 24;
      drawBubble(ctx, rt, sc, bubbleY, now);
      return;
    }
    if (icon) VO.drawIcon(ctx, icon, sc.x - 15, sc.head + 6, 8, '#1d1f27', 'rgba(255,255,255,0.94)');
    if (ent.isDirector || ent.isLead) VO.drawIcon(ctx, ent.isDirector ? 'briefcase' : 'star', sc.x + 14, sc.head + 6, 7, '#fff', ent.isDirector ? '#ab47bc' : '#ffb300');
    if (rt.working && rt.progress > 0 && rt.progress < 1 && !ent.live) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(sc.x - 13, sc.head - 6, 26, 5);
      ctx.fillStyle = '#66bb6a'; ctx.fillRect(sc.x - 12, sc.head - 5, 24 * rt.progress, 3);
    }
    const sel = R.selected === ent.id, hov = R.hover === ent.id;
    if (R.cam.zoom >= 0.8 || sel || hov) {
      ctx.font = `${ent.id === 'boss' ? 'bold ' : ''}10px Inter, system-ui, sans-serif`;
      const tw = ctx.measureText(ent.name).width;
      ctx.fillStyle = 'rgba(20,22,30,0.78)'; rr(ctx, sc.x - tw / 2 - 5, sc.y + 6, tw + 10, 14, 4); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(ent.name, sc.x - tw / 2, sc.y + 16.5);
    }
    drawBubble(ctx, rt, sc, bubbleY, now);
  }

  function drawBubble(ctx, rt, sc, by, now) {
    if (rt.bubble && rt.bubble.until > now) {
      const text = rt.bubble.text, bi = rt.bubble.icon;
      ctx.font = '11px Inter, system-ui, sans-serif';
      const iw = bi ? 14 : 0;
      const tw = Math.min(200, ctx.measureText(text).width) + iw;
      const bx = sc.x - tw / 2 - 7;
      ctx.globalAlpha = Math.min(1, (rt.bubble.until - now) / 300);
      ctx.fillStyle = '#ffffff'; rr(ctx, bx, by, tw + 14, 19, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(sc.x - 4, by + 19); ctx.lineTo(sc.x, by + 24); ctx.lineTo(sc.x + 4, by + 19); ctx.fill();
      if (bi) VO.drawIcon(ctx, bi, bx + 12, by + 9.5, 10, '#4f8cff');
      ctx.fillStyle = '#1d1f27';
      ctx.save(); ctx.beginPath(); ctx.rect(bx + 4, by, tw + 6, 19); ctx.clip();
      ctx.fillText(text, bx + 7 + iw, by + 13.5); ctx.restore();
      ctx.globalAlpha = 1;
    }
  }

  function drawEditOverlay(ctx, s, ui) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = modern() ? 'rgba(40,50,80,0.08)' : 'rgba(255,255,255,0.07)';
    for (let x = 0; x <= s.map.w; x++) { const a = iso(x, 0), b = iso(x, s.map.h); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    for (let y = 0; y <= s.map.h; y++) { const a = iso(0, y), b = iso(s.map.w, y); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    const outline = (r, col) => {
      ctx.lineWidth = 2;
      poly(ctx, diamond(r.x, r.y, r.w, r.h), null, col);
      const h = iso(r.x + r.w, r.y + r.h);
      poly(ctx, [{ x: h.x, y: h.y - 9 }, { x: h.x + 9, y: h.y }, { x: h.x, y: h.y + 9 }, { x: h.x - 9, y: h.y }], col);
      ctx.lineWidth = 1;
    };
    for (const div of s.divisions) outline(div.zone, R.hoverObj === div ? '#ffffff' : div.color);
    for (const d of s.departments) outline(d.room, R.hoverObj === d ? '#ffffff' : 'rgba(255,209,102,0.95)');
    for (const f of s.facilities) outline(f, R.hoverObj === f ? '#ffffff' : 'rgba(129,212,250,0.95)');
    if (ui.hoverTile) {
      const { x, y } = ui.hoverTile;
      if (ui.tool && ui.tool.startsWith('furn:')) { ctx.globalAlpha = 0.6; drawFurniture(ctx, { type: ui.tool.slice(5), x, y }); ctx.globalAlpha = 1; }
      ctx.lineWidth = 2;
      poly(ctx, diamond(x, y), ui.tool === 'erase' ? 'rgba(239,83,80,0.25)' : 'rgba(255,209,102,0.25)', ui.tool === 'erase' ? '#ef5350' : '#ffd166');
      ctx.lineWidth = 1;
    }
  }

  // Air kolam beranimasi: tepi batu, dinding dalam, kilau kaustik bergerak
  function drawWater(ctx, w, now) {
    poly(ctx, diamond(w.x - 0.18, w.y - 0.18, w.w + 0.36, w.h + 0.36), '#ebe6dc', 'rgba(0,0,0,0.12)');
    const pts = diamond(w.x, w.y, w.w, w.h);
    const g = ctx.createLinearGradient(pts[0].x, pts[0].y, pts[2].x, pts[2].y);
    g.addColorStop(0, '#4fc6ef'); g.addColorStop(1, '#1d93d6');
    poly(ctx, pts, g);
    // dinding dalam kolam (sisi belakang terlihat)
    const D = 9;
    poly(ctx, [pts[0], pts[1], { x: pts[1].x, y: pts[1].y + D }, { x: pts[0].x + (pts[1].x - pts[0].x) * 0.03, y: pts[0].y + D }], 'rgba(150,225,250,0.75)');
    poly(ctx, [pts[0], pts[3], { x: pts[3].x, y: pts[3].y + D }, { x: pts[0].x, y: pts[0].y + D }], 'rgba(120,205,240,0.75)');
    ctx.save();
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y); ctx.closePath(); ctx.clip();
    // ubin dasar kolam
    ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.beginPath();
    for (let x = w.x; x <= w.x + w.w; x += 0.5) { const a = iso(x, w.y), b = iso(x, w.y + w.h); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    for (let y = w.y; y <= w.y + w.h; y += 0.5) { const a = iso(w.x, y), b = iso(w.x + w.w, y); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    ctx.stroke();
    // kaustik
    const tt = now / 1000;
    ctx.strokeStyle = 'rgba(255,255,255,0.38)'; ctx.lineWidth = 1.2;
    for (let j = 0; j < w.h * 3; j++) {
      ctx.beginPath();
      for (let i = 0; i <= w.w * 6; i++) {
        const fx = w.x + i / 6, fy = w.y + (j + 0.5) / 3 + Math.sin(tt * 1.3 + i * 0.9 + j * 1.7) * 0.07;
        const p = iso(fx, fy);
        i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    for (let i = 0; i < w.w * 3; i++) {
      ctx.beginPath();
      for (let j = 0; j <= w.h * 6; j++) {
        const fy = w.y + j / 6, fx = w.x + (i + 0.5) / 3 + Math.sin(tt * 1.1 + j * 0.8 + i * 2.1) * 0.07;
        const p = iso(fx, fy);
        j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
      }
      ctx.stroke();
    }
    ctx.restore();
    ctx.lineWidth = 1;
    // tangga besi
    const lx = w.x + w.w - 0.6, ly = w.y;
    ctx.strokeStyle = '#d7dde3'; ctx.lineWidth = 2;
    for (const o of [0, 0.3]) { const a = iso(lx + o, ly, 0), b = iso(lx + o, ly - 0.25, 14); ctx.beginPath(); ctx.moveTo(a.x, a.y + 6); ctx.lineTo(a.x, a.y - 8); ctx.quadraticCurveTo(b.x, b.y - 4, b.x, b.y + 4); ctx.stroke(); }
    ctx.lineWidth = 1;
  }

  /* ------------------------------------------------------------ frame 3D (WebGL + overlay 2D) */
  const S3 = () => VO.scene3d;
  let canvasDirty = true;
  function draw3d(canvas, ctx, s, ui, now, dpr) {
    const s3 = S3();
    if (s3.dirty) s3.build(s);
    s3.show(true);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const z = R.cam.zoom * dpr;
    ctx.setTransform(z, 0, 0, z, -R.cam.x * z, -R.cam.y * z);
    const people = [s.boss, ...s.agents].map((e) => [e, VO.sim.rt.get(e.id)]).filter(([, rt]) => rt);
    const list = [];
    for (const [e, rt] of people) {
      const fx = rt.x / T, fy = rt.y / T;
      const p = iso(fx, fy);
      const moving = rt.cur && rt.cur.type === 'goto' && rt.path && rt.path.length > 0;
      let hx = 0, hy = 1;
      if (rt.sitting) hy = VO.facesFront(s, e) ? 1 : -1;
      else if (rt.mdx != null && (rt.mdx || rt.mdy)) { hx = rt.mdx; hy = rt.mdy; }
      const happy = rt.happyUntil && rt.happyUntil > now;
      let pose = { type: 'idle' };
      if (happy || rt.status === 'chat') pose = { type: 'cheer' };
      else if (moving) pose = { type: 'walk', s: Math.sin(rt.phase * 11), ph: rt.phase * 11 };
      else if (rt.sitting) pose = rt.working ? { type: 'type', s: Math.sin(now / 85) } : { type: 'sit' };
      const sel = R.selected === e.id, hov = R.hover === e.id;
      if (sel || hov) {
        ctx.strokeStyle = sel ? '#ffd166' : 'rgba(255,255,255,0.85)'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.ellipse(p.x, p.y, 17, 17 * SP, 0, 0, 7); ctx.stroke(); ctx.lineWidth = 1;
      }
      rt._screen = { x: p.x, y: p.y, head: iso(fx, fy, (rt.sitting ? 1.5 : 1.95) * U).y };
      list.push({ id: e.id, cast: VO.castOf(e), boss: e.id === 'boss', x: fx * U, y: elevAt(fx, fy), z: fy * U, rot: Math.atan2(hx, hy), pose });
    }
    S3().render({ geo, CYA, SYA, SP, CP, persp: PERSP, cam: R.cam, w: canvas.clientWidth, h: canvas.clientHeight, dpr }, list);
    if (ui.edit) drawEditOverlay(ctx, s, ui);
    layoutLabels(ctx, people);
    for (const [e, rt] of people) drawPersonOverlay(ctx, e, rt, now);
  }

  /* ------------------------------------------------------------ frame */
  R.draw = function (canvas, s, ui) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const now = performance.now();
    if (R.staticDirty) { canvasDirty = true; if (S3()) S3().dirty = true; R.staticDirty = false; }
    updateGeo(s);
    // Tampilan 3D sungguhan (three.js + aset GLB) — kanvas ini hanya menggambar overlay di atasnya
    const s3 = S3();
    if (s3 && !FLAT && !s3.ready && !s3.loading && !s3.failed) s3.init(canvas);
    if (s3 && !FLAT && s3.ready) return draw3d(canvas, ctx, s, ui, now, dpr);
    if (s3) s3.show(false);
    if (canvasDirty || !floorCanvas) {
      buildFloor(s);
      buildProps(s);
      canvasDirty = false; R.camDirty = false;
    } else if (R.camDirty) { // kamera diputar: gambar ulang lantai & urutkan ulang objek (tanpa probe ulang)
      buildFloor(s);
      rekey();
      R.camDirty = false;
    }
    updateGeo(s);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
    if (studio()) { g.addColorStop(0, '#1b2328'); g.addColorStop(1, '#0f1417'); } // latar gelap
    else if (robot()) { g.addColorStop(0, '#f3f4fa'); g.addColorStop(1, '#e3e6f2'); }
    else if (modern()) { g.addColorStop(0, '#f6f8fb'); g.addColorStop(1, '#e4e9f1'); }
    else if (classic()) { g.addColorStop(0, '#f4f4fb'); g.addColorStop(1, '#e2e3f2'); }
    else if (luxe()) { g.addColorStop(0, '#070b18'); g.addColorStop(1, '#141c33'); }
    else { g.addColorStop(0, '#1b1f2a'); g.addColorStop(1, '#12141a'); }
    ctx.fillStyle = g; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (luxe()) { // bintang malam (berkelip pelan)
      for (let i = 0; i < 90; i++) {
        const sx = hash(i, 1) * canvas.width, sy = hash(i, 2) * canvas.height;
        ctx.globalAlpha = 0.25 + 0.5 * Math.abs(Math.sin(now / 1500 + i));
        ctx.fillStyle = '#dfe8ff'; ctx.fillRect(sx, sy, hash(i, 3) > 0.85 ? 2 * dpr : dpr, hash(i, 3) > 0.85 ? 2 * dpr : dpr);
      }
      ctx.globalAlpha = 1;
    }
    const z = R.cam.zoom * dpr;
    ctx.setTransform(z, 0, 0, z, -R.cam.x * z, -R.cam.y * z);
    ctx.drawImage(floorCanvas, 0, 0);
    for (const f of s.facilities) if (f.type === 'pool') drawWater(ctx, VO.poolWater(f), now);
    // cincin cahaya berdenyut di lantai sekitar meja Boss
    const bs = s.facilities.find((f) => f.type === 'boss') && VO.bossSeat(s);
    if (bs && !robot() && !modern()) {
      const c = iso(bs.desk.x + 0.5, bs.desk.y + 0.1);
      const ph = (now / 2400) % 1;
      ctx.save(); ctx.strokeStyle = alpha(CY, 0.5 * (1 - ph)); ctx.lineWidth = 2;
      const rx = FLAT ? 60 + ph * 30 : 70 + ph * 34, ry = FLAT ? 40 + ph * 20 : 35 + ph * 17;
      ctx.beginPath(); ctx.ellipse(c.x, c.y, rx, ry, 0, 0, 7); ctx.stroke(); ctx.restore();
    }

    // gabungkan props + karakter, urutkan dari belakang ke depan
    const people = [s.boss, ...s.agents].map((e) => [e, VO.sim.rt.get(e.id)]).filter(([, rt]) => rt);
    const items = props.slice();
    for (const [e, rt] of people) items.push({ k: depthOf(rt.x / T, rt.y / T) + 0.5, d: (c) => drawPerson(c, s, e, rt, now) });
    items.sort((a, b) => a.k - b.k);
    for (const it of items) it.d(ctx, now, s);

    drawLabels(ctx, s);
    if (ui.edit) drawEditOverlay(ctx, s, ui);
    layoutLabels(ctx, people);
    for (const [e, rt] of people) drawPersonOverlay(ctx, e, rt, now);
  };

  /* ------------------------------------------------------------ kamera & hit test */
  // Koordinat layar → "dunia" dalam satuan simulasi (tile × T), dipakai editor & klik
  R.screenToIso = (sx, sy) => ({ x: sx / R.cam.zoom + R.cam.x, y: sy / R.cam.zoom + R.cam.y });
  R.screenToWorld = (sx, sy) => {
    const p = R.screenToIso(sx, sy);
    const t = toTile(p.x, p.y);
    return { x: t.x * T, y: t.y * T };
  };

  R.hitPerson = function (s, wx, wy) {
    const p = iso(wx / T, wy / T); // kembali ke koordinat isometrik
    let best = null, bd = Infinity;
    for (const e of [s.boss, ...s.agents]) {
      const rt = VO.sim.rt.get(e.id);
      const sc = rt && rt._screen;
      if (!sc) continue;
      if (p.x < sc.x - 16 || p.x > sc.x + 16 || p.y < sc.head - 4 || p.y > sc.y + 4) continue;
      const d = Math.abs(p.x - sc.x) + Math.abs(p.y - (sc.y + sc.head) / 2) * 0.5 - sc.y * 0.001;
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  };

  R.focus = function (canvas, wx, wy) {
    const p = iso(wx / T, wy / T, 20);
    const vw = canvas.clientWidth / R.cam.zoom, vh = canvas.clientHeight / R.cam.zoom;
    R.cam.x = p.x - vw / 2;
    R.cam.y = p.y - vh / 2;
  };

  // Posisi kamera agar titik dunia (wx, wy) tampil di fx × lebar layar, tengah vertikal
  R.camFor = function (canvas, wx, wy, zoom, fx = 0.5) {
    const p = iso(wx / T, wy / T, 20);
    return { zoom, x: p.x - (canvas.clientWidth / zoom) * fx, y: p.y - canvas.clientHeight / zoom / 2 };
  };

  // Zoom kamera ke satu ruangan / zona (tab ruangan)
  // dry = true → hanya hitung posisi kamera tujuan (untuk animasi), tanpa memindahkan kamera
  R.focusRect = function (canvas, s, r, dry) {
    updateGeo(s);
    const pts = [iso(r.x, r.y, 70), iso(r.x + r.w, r.y, 70), iso(r.x + r.w, r.y + r.h), iso(r.x, r.y + r.h)];
    const x0 = Math.min(...pts.map((p) => p.x)), x1 = Math.max(...pts.map((p) => p.x));
    const y0 = Math.min(...pts.map((p) => p.y)), y1 = Math.max(...pts.map((p) => p.y));
    const zoom = VO.clamp(Math.min(canvas.clientWidth / (x1 - x0), canvas.clientHeight / (y1 - y0)) * 0.85, 0.5, 2.4);
    const t = { zoom, x: (x0 + x1) / 2 - canvas.clientWidth / zoom / 2, y: (y0 + y1) / 2 - canvas.clientHeight / zoom / 2 };
    if (!dry) Object.assign(R.cam, t);
    return t;
  };

  // Tampilkan area yang berisi ruangan/zona/furnitur (bukan seluruh lantai kosong)
  R.fit = function (canvas, s, dry) {
    updateGeo(s);
    const rects = [...s.facilities, ...s.departments.map((d) => d.room), ...s.divisions.map((d) => d.zone), ...s.furniture.map((f) => ({ x: f.x, y: f.y, w: 1, h: 1 }))];
    if (!rects.length || (s.settings && s.settings.theme === 'studio')) rects.push({ x: 0, y: 0, w: s.map.w, h: s.map.h }); // studio: seluruh gedung terlihat
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of rects) {
      for (const p of [iso(r.x - 1, r.y - 1, 60), iso(r.x + r.w + 1, r.y - 1, 60), iso(r.x + r.w + 1, r.y + r.h + 1), iso(r.x - 1, r.y + r.h + 1)]) {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
    }
    const W = x1 - x0, H = y1 - y0;
    const zoom = VO.clamp(Math.min(canvas.clientWidth / W, canvas.clientHeight / H) * 0.97, 0.2, 2.2);
    const t = { zoom, x: x0 + W / 2 - canvas.clientWidth / zoom / 2, y: y0 + H / 2 - canvas.clientHeight / zoom / 2 };
    if (!dry) Object.assign(R.cam, t);
    return t;
  };

  /* ------------------------------------------------------------ potret (inspector) */
  const portraitCache = new Map();
  R.portrait = function (ent) {
    if (CAST.ready && CAST.img[VO.castOf(ent)]) { // potret = kepala & bahu karakter 3D (frame depan, idle)
      const id = VO.castOf(ent), key = 'cast|' + id + '|' + (ent.id === 'boss');
      if (portraitCache.has(key)) return portraitCache.get(key);
      const M = CAST.meta, c = document.createElement('canvas');
      c.width = 88; c.height = 88;
      const ctx = c.getContext('2d');
      const hy = M.headY, crop = M.frameW * 0.62;
      ctx.drawImage(CAST.img[id], (M.frameW - crop) / 2, hy - 6, crop, crop, 0, 0, 88, 88);
      if (ent.id === 'boss') poly(ctx, [{ x: 30, y: 16 }, { x: 30, y: 4 }, { x: 37, y: 10 }, { x: 44, y: 1 }, { x: 51, y: 10 }, { x: 58, y: 4 }, { x: 58, y: 16 }], '#ffca28');
      const url = c.toDataURL();
      portraitCache.set(key, url);
      return url;
    }
    const key = [theme(), ent.role, ent.skin, ent.hair, ent.hairStyle, ent.top, ent.pants, ent.tie, ent.style, ent.glasses, ent.mustache, ent.id === 'boss', ent.isLead, ent.isDirector].join('|');
    if (portraitCache.has(key)) return portraitCache.get(key);
    const c = document.createElement('canvas');
    c.width = 88; c.height = 88;
    const ctx = c.getContext('2d');
    ctx.scale(2, 2);
    ctx.translate(22, studio() ? 78 : 70);
    const po = { back: false, mirror: false, moving: false, phase: 0, sitting: false, working: false, now: 0, seed: ent.id };
    const top = theme() === 'robot' ? drawRobot(ctx, ent, po) : studio() ? drawStudioAvatar(ctx, ent, po) : drawAvatar(ctx, ent, po);
    if (ent.id === 'boss') poly(ctx, [{ x: -7, y: top + 2 }, { x: -7, y: top - 5 }, { x: -3.5, y: top - 1 }, { x: 0, y: top - 7 }, { x: 3.5, y: top - 1 }, { x: 7, y: top - 5 }, { x: 7, y: top + 2 }], '#ffca28');
    const url = c.toDataURL();
    portraitCache.set(key, url);
    return url;
  };
})();

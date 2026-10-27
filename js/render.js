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
  // Satu-satunya tampilan: Studio (kantor 2 lantai, kamera depan). Tema lama (Penthouse, Klasik, Robot,
  // Modern, Pixel) sudah dihapus.
  const LX = { gold: '#d6a95b' }; // aksen emas label karyawan terpilih
  // angka acak deterministik dari koordinat
  const hash = (a, b = 0) => { const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return v - Math.floor(v); };
  const CORAL = '#f04e5e';
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
    buildFloorStudio(ctx, s);
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

  /* ------------------------------------------------------------ props (benda 3D) */
  // Setiap prop: { k: kedalaman (tx+ty pusat), d: fungsi gambar(ctx, now, s) }
  function buildProps(s) {
    props = [];
    // posisi tiap objek dicari otomatis (probe: rekam koordinat tile yang dipakai saat menggambar)
    const add = (k, d) => props.push({ fixed: k <= -500 ? k : null, d });

    // sekat rendah putih + tiang tipis di sudut (kantor terbuka)
    const walls = (r, color, fac) => {
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
    // open plan: satu ruangan untuk tiap divisi (direktur + semua departemennya)
    if (OPEN) for (const div of s.divisions) walls(div.zone, div.color, { type: 'zone' });
    studioShell(s, add);
    for (const d of s.departments) {
      const div = s.divisions.find((x) => x.id === d.divisionId);
      // zona departemen: sekat rendah putih bergaris warna di sisi belakang
      const col = shade(deptColor(s, d), 0.85);
      for (let x = d.room.x; x < d.room.x + d.room.w; x++) {
        const x0 = Math.max(x, d.room.x + 0.2), x1 = Math.min(x + 1, d.room.x + d.room.w - 0.2);
        add(x0 / 2 + x1 / 2 + d.room.y + 0.7, (ctx) => { const b = box(ctx, x0, d.room.y + 0.62, x1, d.room.y + 0.76, 0, 16, { top: col, left: '#f7f8fa', right: '#e6e9ee' }, { outline: false }); facePanel(ctx, b.fL, 0, 1, 0.75, 1, col); });
      }
      const members = VO.deptAgents(s, d.id);
      VO.deskSlots(d.room).forEach((sl, i) => {
        // meja pertama milik ketua tim (manager): meja L khusus + kursi eksekutif sebagai pembeda
        const mgr = i === 0 && members[0] && members[0].isLead;
        add(sl.desk.x + sl.desk.y + 1, (ctx, now) => mgr ? drawManagerDesk(ctx, sl.desk.x, sl.desk.y, now, members[0]) : drawDesk(ctx, sl.desk.x, sl.desk.y, now, members[i], '#ffffff'));
        add(sl.chair.x + sl.chair.y + 0.9, (ctx) => drawChair(ctx, sl.chair.x, sl.chair.y, mgr));
        add(sl.chair.x + sl.chair.y + 1.3, (ctx) => drawChairBack(ctx, sl.chair.x, sl.chair.y, mgr));
      });
    }
    for (const div of s.divisions) {
      const dd = div.directorDesk;
      add(dd.x + dd.y + 1, (ctx, now) => drawDesk(ctx, dd.x, dd.y, now, VO.director(s, div.id), '#ece8f5', OPEN));
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

  function facilityProps(s, f, add) {
    if (f.type === 'boss') {
      bossProps(s, f, add);
    } else if (f.type === 'meeting') {
      const t = VO.meetingTable(f);
      for (let y = t.y; y < t.y + t.h; y++)
        for (let x = t.x; x < t.x + t.w; x++)
          add(x + y + 1, (ctx) => {
            box(ctx, x - (x === t.x ? -0.1 : 0), y - (y === t.y ? -0.1 : 0), x + 1 - (x === t.x + t.w - 1 ? 0.1 : 0), y + 1 - (y === t.y + t.h - 1 ? 0.1 : 0), 0, 14,
              { top: '#8a6648', left: '#6b4f3a', right: '#56402f' }, { outline: false });
          });
      for (const p of VO.sim.spots(s, 'meeting'))
        add(p.x + p.y + 0.9, (ctx) => box(ctx, p.x + 0.28, p.y + 0.28, p.x + 0.72, p.y + 0.72, 0, 7, '#3a3f4b'));
      // layar presentasi di dinding belakang
      add(f.x + f.w / 2 + f.y + 1.2, (ctx) => {
        const b = box(ctx, f.x + f.w / 2 - 1.5, f.y + 0.95, f.x + f.w / 2 + 1.5, f.y + 1.02, 18, 22, '#22252c');
        facePanel(ctx, b.fL, 0.06, 0.94, 0.12, 0.88, '#4fc3f7');
      });
    } else if (f.type === 'pantry') {
      for (let x = f.x + 1; x < f.x + f.w - 1; x++) {
        const y = f.y + 1;
        add(x + y + 1, (ctx) => {
          box(ctx, x, y + 0.1, x + 1, y + 0.9, 0, 18, { top: '#d5d9df', left: '#9aa1ad', right: '#858c98' });
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
          box(ctx, x + 0.2, y + 0.2, x + 0.8, y + 0.8, 0, 13, { top: '#efebe9', left: '#bcaaa4', right: '#a1887f' });
        });
      }
    } else if (f.type === 'lounge') {
      add(f.x + 2 + f.y + 1.5, (ctx) => drawFurniture(ctx, { type: 'sofa', x: f.x + 2, y: f.y + 1 }));
      add(f.x + 4 + f.y + 1.5, (ctx) => drawFurniture(ctx, { type: 'sofa', x: f.x + 4, y: f.y + 1 }));
      add(f.x + f.w - 1.5 + f.y + 1.5, (ctx) => drawFurniture(ctx, { type: 'arcade', x: f.x + f.w - 2, y: f.y + 1 }));
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
    box(ctx, cx + 0.2, cy + 0.15, cx + 0.8, cy + 0.3, 0, 30, '#3b2418');
    box(ctx, cx + 0.22, cy + 0.25, cx + 0.78, cy + 0.8, 7, 5, '#5a3826');
  }

  /* ---------- Ruang Boss berteknologi: meja kaca gelap ber-LED + laptop di kanan ruangan, video wall ---------- */
  const CY = '#35e0ff';
  function bossProps(s, f, add) {
    const seat = VO.bossSeat(s);
    const dx = seat.desk.x, dy = seat.desk.y;
    const TOP = '#1d2330', SIDE_L = '#141924', SIDE_R = '#0f131c';
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
    const C = { base: '#c9ced8', back: '#b3b9c6' };
    const sh = [iso(x + 0.1, y + 0.1), iso(x + 0.95, y + 0.1), iso(x + 0.95, y + n - 0.05), iso(x + 0.1, y + n - 0.05)];
    poly(ctx, sh.map((p) => ({ x: p.x + 3, y: p.y + 4 })), 'rgba(0,0,0,0.15)');
    box(ctx, x + 0.1, y + 0.08, x + 0.3, y + n - 0.08, 0, 24, { base: C.back }); // sandaran
    box(ctx, x + 0.25, y + 0.12, x + 0.9, y + n - 0.12, 0, 10, { base: C.base }); // dudukan
    for (let i = 0; i < n; i++) box(ctx, x + 0.3, y + i + 0.18, x + 0.86, y + i + 0.92, 10, 3, { base: mix(C.base, '#ffffff', 0.12) }, { outline: false }); // bantal
    box(ctx, x + 0.1, y + 0.05, x + 0.9, y + 0.2, 0, 16, { base: C.back }); // lengan
    box(ctx, x + 0.1, y + n - 0.2, x + 0.9, y + n - 0.05, 0, 16, { base: C.back });
    // bantal hias
    box(ctx, x + 0.3, y + 0.35, x + 0.45, y + 0.75, 10, 10, { base: CORAL }, { outline: false });
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
    const top = '#ffffff';
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
    const C = '#7f8ba0';
    const p = iso(x + 0.5, y + 0.5);
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.beginPath(); ctx.ellipse(p.x, p.y + 1, 12, 6, 0, 0, 7); ctx.fill();
    ctx.fillStyle = shade(C, 0.75); ctx.beginPath(); ctx.ellipse(p.x, p.y - 4, 11, 5.5, 0, 0, Math.PI); ctx.lineTo(p.x - 11, p.y - 10); ctx.ellipse(p.x, p.y - 10, 11, 5.5, 0, Math.PI, 0, true); ctx.closePath(); ctx.fill();
    ctx.fillStyle = C; ctx.beginPath(); ctx.ellipse(p.x, p.y - 10, 11, 5.5, 0, 0, 7); ctx.fill();
    ctx.fillStyle = shade(C, 1.25); ctx.beginPath(); ctx.ellipse(p.x, p.y - 10.5, 7.5, 3.6, 0, 0, 7); ctx.fill();
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
    const WOOD = { top: '#7a4f30', left: '#5e3c24', right: '#4b2f1c' };
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

  const TB_STATUS = { briefing: ['BRIEFING', '#ffd166'], meeting: ['RAPAT', '#ffd166'], in_progress: ['DIKERJAKAN', '#5ec8ff'], done: ['SELESAI', '#7cf29a'], failed: ['GAGAL', '#ff6b6b'] };


  function drawDesk(ctx, x, y, now, ent, topColor, exec) {
    if (exec) return drawExecDesk(ctx, x, y, now, ent);
    const q = iso(x + 0.56, y + 0.58);
    const sh = ctx.createRadialGradient(q.x, q.y, 2, q.x, q.y, 28);
    sh.addColorStop(0, 'rgba(33,48,42,0.18)'); sh.addColorStop(1, 'rgba(33,48,42,0)');
    ctx.fillStyle = sh; ctx.beginPath(); ctx.ellipse(q.x, q.y, 30, 17, 0, 0, Math.PI * 2); ctx.fill();
    // meja putih dengan kaki ramping
    box(ctx, x + 0.06, y + 0.14, x + 0.94, y + 0.86, 12, 3, { top: '#f5eedf', left: '#dde1e8', right: '#cdd2db' }, { outline: false });
    for (const [lx, ly] of [[0.1, 0.18], [0.86, 0.18], [0.1, 0.78], [0.86, 0.78]]) box(ctx, x + lx, y + ly, x + lx + 0.04, y + ly + 0.04, 0, 12, '#b8bfcb', { outline: false });
    // monitor menghadap kursi (sisi +ty)
    const rt = ent && VO.sim.rt.get(ent.id);
    const working = rt && rt.working;
    box(ctx, x + 0.46, y + 0.32, x + 0.54, y + 0.42, 15, 5, '#2a2d34'); // kaki monitor
    const m = box(ctx, x + 0.22, y + 0.3, x + 0.78, y + 0.38, 19, 15, '#1d2129');
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
    const col = { top: '#ffffff', left: '#dde1e8', right: '#cdd2db' };
    const d = box(ctx, x - 0.35, y + 0.12, x + 1.35, y + 0.88, 0, 16, col);
    facePanel(ctx, d.fL, 0, 1, 0.8, 0.9, 'rgba(0,0,0,0.12)');
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

  // Meja manager (ketua tim): meja L lebih lebar dengan aksen, monitor besar + monitor kedua,
  // lampu meja, papan nama, dan karpet kecil — pembeda dari meja staf
  const MGR = { top: '#2d3342', left: '#232836', right: '#1b1f2b', trim: '#3b7cff', rug: '#e4e8f0' };
  function drawManagerDesk(ctx, x, y, now, ent) {
    const C = MGR;
    // karpet kecil penanda area manager
    poly(ctx, diamond(x - 0.2, y + 0.05, 1.6, 1.9), alpha(C.rug, 0.55));
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
      box(ctx, x + 0.26, y + 0.28, x + 0.74, y + 0.74, 6, 5, '#3b2f2a');
      box(ctx, x + 0.46, y + 0.46, x + 0.54, y + 0.54, 0, 6, '#22252c', { outline: false });
      return;
    }
    box(ctx, x + 0.3, y + 0.32, x + 0.7, y + 0.72, 6, 4, '#7f8ba0'); // dudukan
    box(ctx, x + 0.46, y + 0.46, x + 0.54, y + 0.54, 0, 6, '#22252c', { outline: false }); // tiang
  }
  // sandaran digambar SETELAH karyawan yang duduk, agar menutupi punggungnya
  function drawChairBack(ctx, x, y, mgr) {
    if (mgr) { // sandaran tinggi berlapis kulit
      const b = box(ctx, x + 0.26, y + 0.7, x + 0.74, y + 0.8, 10, 26, '#3b2f2a');
      facePanel(ctx, b.fL, 0.15, 0.85, 0.55, 0.9, 'rgba(255,255,255,0.08)');
      return;
    }
    box(ctx, x + 0.3, y + 0.7, x + 0.7, y + 0.78, 10, 16, '#6f7b90');
  }

  function drawFurniture(ctx, f) {
    const x = f.x, y = f.y;
    const sh = iso(x + 0.5, y + 0.5);
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.beginPath(); ctx.ellipse(sh.x, sh.y, 20, 9, 0, 0, 7); ctx.fill();
    switch (f.type) {
      case 'plant': { // tanaman tropis dalam pot krem tinggi
        box(ctx, x + 0.32, y + 0.32, x + 0.68, y + 0.68, 0, 16, { top: '#e4d7c6', left: '#c3b39e', right: '#a99781' }, { outline: false });
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
      case 'sofa':
        box(ctx, x + 0.05, y + 0.2, x + 0.95, y + 0.85, 0, 10, '#5c6bc0');
        box(ctx, x + 0.05, y + 0.12, x + 0.95, y + 0.32, 0, 22, '#4a59ad');
        box(ctx, x + 0.05, y + 0.2, x + 0.17, y + 0.85, 0, 16, '#4a59ad');
        box(ctx, x + 0.83, y + 0.2, x + 0.95, y + 0.85, 0, 16, '#4a59ad');
        break;
      case 'bookshelf': {
        const b = box(ctx, x + 0.08, y + 0.3, x + 0.92, y + 0.7, 0, 46, '#6d4c41');
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
    const SC = castOn ? (FLAT ? 0.85 : 1) : FLAT ? 0.95 : 1.15;
    ctx.scale(SC, SC);
    const look = ent;
    const happy = rt.happyUntil && rt.happyUntil > now ? 1 - (rt.happyUntil - now) / 1400 : 0;
    const talking = !!(rt.bubble && rt.bubble.until > now && now - (rt.bubble.until - 3000) < 1600);
    const opts = { back, mirror, moving, phase: rt.phase, sitting: rt.sitting, working: rt.working, now, seed: ent.id, happy, talking, cheer: rt.status === 'chat' };
    opts.side = side; opts.seedN = (ent.id || '').length;
    const headTop = castOn ? drawCast(ctx, look, opts) : drawStudioAvatar(ctx, look, opts);
    if (ent.id === 'boss') { // mahkota
      ctx.fillStyle = '#ffca28';
      const y = headTop + 2;
      poly(ctx, [{ x: -7, y }, { x: -7, y: y - 7 }, { x: -3.5, y: y - 3 }, { x: 0, y: y - 9 }, { x: 3.5, y: y - 3 }, { x: 7, y: y - 7 }, { x: 7, y }], '#ffca28', '#b8860b');
    }
    ctx.restore();
    rt._screen = { x: p.x, y: p.y, head: p.y + headTop * SC };
  }

  /* ------------------------------------------------------------ overlay: label, nama, balon */
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
      if (rt.working && rt.progress > 0 && rt.progress < 1) {
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
    if (rt._screen) drawOverlayLuxe(ctx, ent, rt, now, rt._screen);
  }

  function drawEditOverlay(ctx, s, ui) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(40,50,80,0.08)';
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

  /* ------------------------------------------------------------ label ruangan (overlay 2D di atas WebGL) */
  // Pil gelap melayang dengan teks mono berwarna ("DIGITAL MARKETING · 5"): selalu tajam & terbaca,
  // ukurannya di layar hampir tetap (± 10–14 px) berapa pun zoom-nya.
  const FAC_COL = { boss: '#7fd39a', meeting: '#8fd0d6', pantry: '#f0c27d', lounge: '#8fd0d6', pool: '#6fe0d2', billiard: '#7fd39a' };
  function drawRoomLabels(ctx, s) {
    const z = R.cam.zoom, fs = VO.clamp(8.5 + 3.5 * z, 9.5, 14) / z;
    const items = [];
    for (const v of s.divisions) items.push({ t: v.name.toUpperCase(), c: mix(v.color, '#ffffff', 0.45), x: v.zone.x + v.zone.w / 2, y: v.zone.y + 0.2, h: 2.25, k: 1.1 });
    for (const d of s.departments) {
      const div = s.divisions.find((v) => v.id === d.divisionId), r = d.room;
      items.push({ t: `${d.name.toUpperCase()} · ${VO.deptAgents(s, d.id).length}`, c: mix(div ? div.color : '#6ca1dd', '#ffffff', 0.35), x: r.x + r.w / 2, y: r.y + 0.3, h: 1.3, k: 1 });
    }
    for (const f of s.facilities) items.push({ t: f.name.toUpperCase(), c: FAC_COL[f.type] || '#c9d6dc', x: f.x + f.w / 2, y: f.y + 0.8, h: 1.7, k: 1 });
    ctx.save();
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    try { ctx.letterSpacing = (fs * 0.08).toFixed(2) + 'px'; } catch (e) { /* tidak didukung */ }
    for (const it of items) {
      const f = fs * it.k, p = iso(it.x, it.y, it.h * U);
      ctx.font = `bold ${f}px 'Courier New', ui-monospace, monospace`;
      const w = ctx.measureText(it.t).width + f * 1.3, h = f * 1.75;
      ctx.fillStyle = 'rgba(32,38,44,0.86)'; rr(ctx, p.x - w / 2, p.y - h / 2, w, h, h * 0.28); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = Math.max(0.5, f * 0.06); ctx.stroke();
      ctx.fillStyle = it.c; ctx.fillText(it.t, p.x, p.y + f * 0.04);
    }
    ctx.restore();
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
    if (!ui.edit) drawRoomLabels(ctx, s);
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
    g.addColorStop(0, '#1b2328'); g.addColorStop(1, '#0f1417'); // latar gelap
    ctx.fillStyle = g; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const z = R.cam.zoom * dpr;
    ctx.setTransform(z, 0, 0, z, -R.cam.x * z, -R.cam.y * z);
    ctx.drawImage(floorCanvas, 0, 0);
    for (const f of s.facilities) if (f.type === 'pool') drawWater(ctx, VO.poolWater(f), now);

    // gabungkan props + karakter, urutkan dari belakang ke depan
    const people = [s.boss, ...s.agents].map((e) => [e, VO.sim.rt.get(e.id)]).filter(([, rt]) => rt);
    const items = props.slice();
    for (const [e, rt] of people) items.push({ k: depthOf(rt.x / T, rt.y / T) + 0.5, d: (c) => drawPerson(c, s, e, rt, now) });
    items.sort((a, b) => a.k - b.k);
    for (const it of items) it.d(ctx, now, s);

    drawLabelsStudio(ctx, s);
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
    const key = [ent.role, ent.skin, ent.hair, ent.hairStyle, ent.top, ent.pants, ent.tie, ent.style, ent.glasses, ent.mustache, ent.id === 'boss', ent.isLead, ent.isDirector].join('|');
    if (portraitCache.has(key)) return portraitCache.get(key);
    const c = document.createElement('canvas');
    c.width = 88; c.height = 88;
    const ctx = c.getContext('2d');
    ctx.scale(2, 2);
    ctx.translate(22, 78);
    const po = { back: false, mirror: false, moving: false, phase: 0, sitting: false, working: false, now: 0, seed: ent.id };
    const top = drawStudioAvatar(ctx, ent, po);
    if (ent.id === 'boss') poly(ctx, [{ x: -7, y: top + 2 }, { x: -7, y: top - 5 }, { x: -3.5, y: top - 1 }, { x: 0, y: top - 7 }, { x: 3.5, y: top - 1 }, { x: 7, y: top - 5 }, { x: 7, y: top + 2 }], '#ffca28');
    const url = c.toDataURL();
    portraitCache.set(key, url);
    return url;
  };
})();

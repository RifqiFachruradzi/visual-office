/* =========================================================================
 * icons.js — set ikon garis (gaya Lucide, viewBox 24×24) tanpa dependency.
 *   VO.icon(name, cls)   → string <svg> untuk HTML
 *   VO.iconPath(name)    → Path2D untuk digambar di <canvas>
 * ========================================================================= */
(function () {
  const VO = (window.VO = window.VO || {});

  const P = {
    building: 'M3 21h18M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2',
    crown: 'M2 19h20M3 7l5 4 4-7 4 7 5-4-2 10H5z',
    user: 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
    users: 'M16 21a6 6 0 0 0-12 0M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21a5 5 0 0 0-4-5M15 3.3a4 4 0 0 1 0 7.4',
    bot: 'M12 8V4H8M5 8h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM2 14h2M20 14h2M9 13v2M15 13v2',
    briefcase: 'M3 8h18v12H3zM8 8V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v3M3 13h18',
    star: 'M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z',
    layers: 'M12 2L2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
    door: 'M3 21h18M6 21V3h12v18M14 12h.01',
    plus: 'M12 5v14M5 12h14',
    edit: 'M16 3l5 5L8 21H3v-5zM13 6l5 5',
    trash: 'M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15M10 11v6M14 11v6',
    task: 'M9 3h6v4H9zM15 5h3v16H6V5h3M9 12h6M9 16h4',
    eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    layout: 'M3 3h18v18H3zM3 9h18M9 21V9',
    maximize: 'M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5',
    download: 'M12 3v12M7 10l5 5 5-5M4 21h16',
    upload: 'M12 16V4M7 9l5-5 5 5M4 21h16',
    reset: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
    file: 'M14 3H6v18h12V7zM14 3v4h4M9 13h6M9 17h6',
    folder: 'M3 6h6l2 2h10v11H3z',
    sparkles: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
    dice: 'M4 4h16v16H4zM8.5 8.5h.01M15.5 15.5h.01M15.5 8.5h.01M8.5 15.5h.01M12 12h.01',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3',
    logout: 'M9 21H4V3h5M16 17l5-5-5-5M21 12H9',
    eraser: 'M20 20H9l-6-6 9-9 9 9-6 6M7 10l7 7',
    hand: 'M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8a8 8 0 0 0 16 0v-3a2 2 0 0 0-4 0',
    wand: 'M15 4V2M15 10V8M11 6h2M17 6h2M3 21L14 10M13 7l2 2',
    monitor: 'M3 4h18v12H3zM8 20h8M12 16v4',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4',
    coffee: 'M4 8h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM17 9h2a2 2 0 0 1 0 4h-2M8 2v3M12 2v3',
    chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
    check: 'M20 6L9 17l-5-5',
    alert: 'M12 3l10 18H2zM12 10v4M12 17h.01',
    tool: 'M14.5 4.5a4 4 0 0 0 5 5L12 17l-5 5-3-3 5-5 7.5-7.5zM4.5 4.5l5 5',
    leaf: 'M11 20a7 7 0 0 1-7-7c0-6 7-10 16-10 0 9-4 16-9 17zM4 21c4-4 7-7 11-11',
    book: 'M4 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4zM20 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z',
    lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
    activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
    zap: 'M13 2L3 14h9l-1 8 10-12h-9z',
    live: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM5.6 5.6a9 9 0 0 0 0 12.8M18.4 18.4a9 9 0 0 0 0-12.8',
    info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
    megaphone: 'M3 10v4l13 5V5zM16 8a4 4 0 0 1 0 8M6 15v4h3',
    brain: 'M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V4.5A2.5 2.5 0 0 0 9 4zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1',
    meeting: 'M8 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 22v-4a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v4M14 14h4a4 4 0 0 1 4 4v4',
    inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v7H2v-7z',
    x: 'M18 6L6 18M6 6l12 12',
    sofa: 'M4 11V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3M2 11h20v6H2zM4 17v2M20 17v2',
    board: 'M3 4h18v12H3zM12 16v4M8 20h8M7 12l3-3 2 2 4-4',
    droplet: 'M12 2s7 7 7 12a7 7 0 0 1-14 0c0-5 7-12 7-12z',
    printer: 'M6 9V3h12v6M6 18H4v-7h16v7h-2M6 14h12v7H6z',
    server: 'M3 4h18v7H3zM3 13h18v7H3zM7 7.5h.01M7 16.5h.01',
    gamepad: 'M6 12h4M8 10v4M15 13h.01M18 11h.01M5 6h14a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3z',
    plant: 'M12 22v-9M12 13c0-4 3-7 7-7 0 4-3 7-7 7zM12 13c0-3-2-6-6-6 0 4 2 6 6 6zM7 22h10',
    pin: 'M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11zM12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
    clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
    wave: 'M7 11V5a2 2 0 0 1 4 0v5M11 10V4a2 2 0 0 1 4 0v6M15 10V6a2 2 0 0 1 4 0v8a8 8 0 0 1-15 4l-2-4a2 2 0 0 1 3.5-2L7 14',
    puzzle: 'M10 3h4v3a2 2 0 1 0 4 0V3h3v7h-3a2 2 0 1 0 0 4h3v7h-7v-3a2 2 0 1 0-4 0v3H3v-7h3a2 2 0 1 0 0-4H3V3h7z',
    bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 0 0 4 0',
    sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
    moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
    sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  };
  VO.ICONS = P;

  VO.icon = function (name, cls = '') {
    const d = P[name] || P.info;
    return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  };

  // Ganti semua <i data-icon="nama"> di dalam root dengan SVG
  VO.hydrateIcons = function (root = document) {
    root.querySelectorAll('i[data-icon]').forEach((el) => {
      el.outerHTML = VO.icon(el.dataset.icon, el.className);
    });
  };

  const cache = {};
  VO.iconPath = function (name) {
    if (!cache[name]) cache[name] = new Path2D(P[name] || P.info);
    return cache[name];
  };

  // Gambar ikon di canvas: (cx, cy) = tengah, size = lebar dalam piksel dunia
  VO.drawIcon = function (ctx, name, cx, cy, size, color = '#1d1f27', bg = null) {
    if (bg) {
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.arc(cx, cy, size * 0.75, 0, Math.PI * 2); ctx.fill();
    }
    ctx.save();
    ctx.translate(cx - size / 2, cy - size / 2);
    ctx.scale(size / 24, size / 24);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(VO.iconPath(name));
    ctx.restore();
  };
})();

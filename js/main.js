/* =========================================================================
 * main.js — bootstrap aplikasi, game loop, input kamera & editor layout.
 * ========================================================================= */
(function () {
  const VO = window.VO;
  const T = VO.TILE;
  const R = VO.render;
  const sim = VO.sim;
  const $ = (id) => document.getElementById(id);

  const app = (VO.app = {
    state: null,
    sel: null,
    ui: { edit: false, tool: 'move', hoverTile: null },
    _dirty: true,
    _saveDirty: false,
  });

  /* ------------------------------------------------------------ perubahan state */
  app.changed = function () { app._dirty = true; app._saveDirty = true; };
  app.layoutChanged = function () {
    sim.dirty = true;
    R.staticDirty = true;
    sim.sync(app.state);
    sim.reseatAll(app.state);
    syncControls();
    app.changed();
  };
  app.select = function (sel, focus) {
    app.sel = sel;
    R.selected = sel && sel.kind === 'agent' ? sel.id : null;
    if (focus && sel) {
      const s = app.state;
      let p = null;
      if (sel.kind === 'agent') { const rt = sim.rt.get(sel.id); if (rt) p = { x: rt.x, y: rt.y }; }
      const rect = sel.kind === 'dept' ? s.departments.find((d) => d.id === sel.id)?.room
        : sel.kind === 'division' ? s.divisions.find((d) => d.id === sel.id)?.zone
        : sel.kind === 'facility' ? s.facilities.find((d) => d.id === sel.id) : null;
      if (rect) p = { x: (rect.x + rect.w / 2) * T, y: (rect.y + rect.h / 2) * T };
      if (p) R.focus($('office'), p.x, p.y);
    }
    app._dirty = true;
  };

  // perbesar zona divisi agar memuat semua ruang departemennya
  app.fitZone = function (div) {
    if (!div) return;
    const s = app.state;
    const rooms = s.departments.filter((d) => d.divisionId === div.id).map((d) => d.room);
    const z = div.zone;
    for (const r of rooms) {
      z.w = Math.max(z.w, r.x + r.w + 1 - z.x);
      z.h = Math.max(z.h, r.y + r.h + 1 - z.y);
    }
    s.map.w = Math.max(s.map.w, z.x + z.w + 2);
    s.map.h = Math.max(s.map.h, z.y + z.h + 2);
  };

  const rects = (s) => [...s.facilities, ...s.departments.map((d) => d.room), ...s.divisions.map((d) => d.zone)];
  const overlap = (a, b, m = 1) => a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;

  app.findFreeRect = function (w, h, minY = 2) {
    const s = app.state;
    const all = rects(s);
    for (let y = minY; y + h < s.map.h - 1; y++)
      for (let x = 2; x + w < s.map.w - 1; x++) {
        const r = { x, y, w, h };
        if (!all.some((o) => overlap(r, o))) return r;
      }
    const bottom = Math.max(2, ...all.map((o) => o.y + o.h)) + 2;
    s.map.h = Math.max(s.map.h, bottom + h + 2);
    return { x: 2, y: bottom, w, h };
  };

  /* ------------------------------------------------------------ init */
  async function init() {
    VO.hydrateIcons();
    // Boss = pengguna yang login. Data kantor disimpan terpisah per akun.
    const me = await VO.ai.me();
    app.user = me && me.user;
    const storeId = (me && (me.id || me.user)) || '';
    if (storeId) VO.STORAGE_KEY = 'visual-office:v2:' + storeId.toLowerCase();
    $('who').classList.toggle('hidden', !app.user);
    $('btnLogout').classList.toggle('hidden', !(me && me.authRequired));

    let s = VO.load();
    // Mode database: kantor disimpan per akun di cloud (bisa dibuka di perangkat lain)
    if (me && me.cloud) {
      VO.cloud.enabled = true;
      try {
        const remote = await VO.cloud.load();
        if (remote.office) s = VO.migrate({ ...remote.office, docs: remote.docs || [] });
        else app._saveDirty = true; // akun baru: unggah kantor lokal (atau kosong)
      } catch (e) {
        VO.ui.toast(e.message + ' — memakai data lokal', 'alert');
      }
      $('who').title = 'Kamu adalah Boss · data tersimpan di cloud';
    }
    if (!s) { s = VO.defaultState(); app._saveDirty = true; }
    s.agents = s.agents.filter((a) => !a.live); // sesi live tidak bertahan setelah reload
    app.state = s;
    // Penthouse: kantor lama mendapat kolam renang sekali (bisa dihapus/dipindah di Edit Layout)
    if (!s.settings.poolV4) {
      s.settings.poolV4 = true;
      if (!s.facilities.some((f) => f.type === 'pool')) { const d = VO.FACILITY_TYPES.pool; VO.addFacility(s, 'pool', app.findFreeRect(d.w, d.h)); }
      app._saveDirty = true;
    }
    // fasilitas baru: ruang biliar (sekali untuk kantor lama)
    if (!s.settings.billiardV6) {
      s.settings.billiardV6 = true;
      if (!s.facilities.some((f) => f.type === 'billiard')) { const d = VO.FACILITY_TYPES.billiard; VO.addFacility(s, 'billiard', app.findFreeRect(d.w, d.h)); }
      app._saveDirty = true;
    }
    syncBoss();
    sim.sync(s);

    const canvas = $('office');
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, canvas.clientWidth * dpr);
      canvas.height = Math.max(1, canvas.clientHeight * dpr);
    };
    new ResizeObserver(resize).observe(canvas);
    resize();
    R.fit(canvas, s);

    bindTop();
    bindCanvas(canvas);
    bindEditBar();
    bindRoomTabs();
    VO.ui.bindTree();
    VO.ui.bindInspector();
    VO.ui.bindDocs();
    bindTasks();
    syncControls();

    VO.ai.check().then(() => {
      // Gemini tersedia → mode AI aktif otomatis (kecuali Boss pernah mematikannya)
      if (VO.ai.available && !app.state.settings.aiModeTouched && !app.state.settings.aiMode) {
        app.state.settings.aiMode = true;
        $('aiMode').checked = true;
        app.changed();
      }
      aiPill();
      app._dirty = true;
      VO.ai.listen((ev) => VO.live.handle(ev)); // hanya aktif di server lokal
    });

    let last = performance.now();
    const loop = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      sim.update(app.state, dt);
      R.draw(canvas, app.state, app.ui);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);

    // panel UI di-refresh dengan ritme rendah agar ringan
    setInterval(() => {
      emptyStage();
      renderRoomTabs();
      VO.ui.renderTree();
      VO.ui.renderInspector();
      if (app._dirty) {
        VO.ui.renderTargets();
        VO.ui.renderTasks();
        VO.ui.renderThread();
        VO.ui.renderDocs();
        app._dirty = false;
      }
    }, 300);
    // simpan lokal tiap 2,5 dtk; ke cloud paling sering tiap 8 dtk (hemat kuota Upstash)
    let cloudDirty = false, lastCloud = 0;
    setInterval(() => {
      if (app._saveDirty) {
        app._saveDirty = false;
        cloudDirty = true;
        VO.save(app.state);
      }
      if (VO.cloud.enabled && cloudDirty && Date.now() - lastCloud > 8000) {
        cloudDirty = false;
        lastCloud = Date.now();
        VO.cloud.save(app.state).catch(() => { cloudDirty = true; });
      }
    }, 2500);
    window.addEventListener('beforeunload', () => VO.save(app.state));
  }

  function syncBoss() {
    const b = app.state.boss;
    if (app.user) b.name = app.user;
    b.role = 'Boss (Kamu)';
    $('whoName').textContent = b.name;
  }

  // Tab ruangan di atas kanvas (Lobby, Pantry, Kolam, divisi…) → kamera terbang ke ruangan itu
  let tabsSig = '';
  function renderRoomTabs() {
    const s = app.state;
    const items = [
      ...s.facilities.map((f) => ({ kind: 'facility', id: f.id, name: f.name })),
      ...s.divisions.map((d) => ({ kind: 'division', id: d.id, name: d.name })),
    ];
    const sig = items.map((i) => i.id + i.name).join('|');
    if (sig === tabsSig) return;
    tabsSig = sig;
    $('roomTabs').innerHTML = `<button class="rt" data-all="1" title="Lihat seluruh kantor">${VO.icon('maximize')}</button>` +
      items.map((i) => `<button class="rt" data-kind="${i.kind}" data-id="${i.id}">${VO.esc(i.name)}</button>`).join('');
  }
  function bindRoomTabs() {
    $('roomTabs').addEventListener('click', (e) => {
      const b = e.target.closest('button.rt');
      if (!b) return;
      const s = app.state;
      if (b.dataset.all) return R.fit($('office'), s);
      const r = b.dataset.kind === 'facility' ? s.facilities.find((f) => f.id === b.dataset.id) : s.divisions.find((d) => d.id === b.dataset.id)?.zone;
      if (r) R.focusRect($('office'), s, r);
      document.querySelectorAll('#roomTabs .rt').forEach((x) => x.classList.toggle('on', x === b));
    });
  }

  function emptyStage() {
    $('emptyStage').classList.toggle('hidden', app.state.divisions.length > 0 || app.ui.edit);
  }

  function aiPill() {
    const p = $('aiStatus');
    const s = app.state;
    p.innerHTML = VO.ai.available
      ? VO.icon('sparkles') + ' ' + VO.ai.label() + (s.settings.aiMode ? ' aktif' : ' siap')
      : VO.icon('dice') + ' Simulasi';
    p.title = VO.ai.reason + ' — klik untuk memilih sumber AI';
    p.classList.toggle('on', VO.ai.available && s.settings.aiMode);
    $('aiMode').disabled = !VO.ai.available;
    $('aiMode').parentElement.title = VO.ai.available ? 'Agen mengerjakan tugas dengan AI sungguhan (' + VO.ai.reason + ')' : VO.ai.reason;
  }

  VO.ai.onChange = () => aiPill();

  // Pilih sumber AI: 9router di komputer ini (gratis, saat di rumah) atau Gemini lewat server (saat di luar)
  async function aiSourceDialog() {
    const ai = VO.ai;
    const v = ui().form('Sumber AI', [
      { key: 'mode', label: 'Pakai AI dari', type: 'select', value: ai.src.mode, options: [
        { value: 'auto', label: 'Otomatis — 9router lokal bila terdeteksi, selain itu Gemini (disarankan)' },
        { value: 'local', label: 'Selalu 9router lokal (komputer ini)' },
        { value: 'server', label: 'Selalu Gemini (server)' },
      ] },
      { key: 'url', label: 'Alamat 9router lokal', value: ai.src.url, placeholder: 'http://localhost:20128/v1' },
      { key: 'key', label: 'API key 9router (kosongkan bila tidak diwajibkan)', value: ai.src.key },
      { key: 'model', label: 'Model / combo 9router (kosongkan = pertama di daftar)', value: ai.src.model, placeholder: 'mis. combo-gratis' },
    ], 'Simpan');
    // tombol tes + daftar model dari 9router
    const body = $('dlgBody');
    const info = document.createElement('div');
    info.className = 'field';
    info.innerHTML = '<button type="button" class="small" id="aiTest">Tes koneksi 9router</button> <span id="aiTestOut" class="muted"></span><datalist id="aiModels"></datalist>' +
      '<p class="muted" style="margin-top:8px">9router dipanggil langsung dari browser ini, jadi hanya bekerja di komputer tempat 9router berjalan. Bila Chrome menanyakan izin <b>akses jaringan lokal</b>, pilih <b>Izinkan</b>. Pengaturan ini tersimpan per perangkat. Perintah dari Telegram saat kantor tidak dibuka tetap memakai Gemini (server).</p>';
    body.appendChild(info);
    $('f_model').setAttribute('list', 'aiModels');
    const fill = () => { $('aiModels').innerHTML = ai.local.models.map((m) => `<option value="${VO.esc(m)}">`).join(''); };
    fill();
    $('aiTest').onclick = async () => {
      const keep = { ...ai.src };
      ai.src.url = $('f_url').value.trim(); ai.src.key = $('f_key').value.trim(); ai.src.mode = 'auto';
      $('aiTestOut').textContent = 'Mengecek…';
      const ok = await ai.probeLocal();
      Object.assign(ai.src, { mode: keep.mode });
      $('aiTestOut').textContent = ok ? `✓ Terhubung — ${ai.local.models.length} model tersedia` : '✗ ' + ai.local.error;
      fill();
    };
    const r = await v;
    if (!r) { ai.probeLocal(); return; }
    ai.saveSource({ mode: r.mode, url: r.url || 'http://localhost:20128/v1', key: r.key, model: r.model });
    await ai.probeLocal();
    aiPill();
    VO.ui.toast('Sumber AI: ' + (ai.usingLocal() ? '9router lokal' : ai.serverAvailable ? 'Gemini (server)' : 'tidak tersedia'), 'sparkles');
  }
  const ui = () => VO.ui;

  // Satu tampilan saja: Studio (kantor 2 lantai). Pilihan tema lain sudah dihapus.
  function applyTheme() {
    const t = app.state.settings.theme || 'studio';
    document.body.classList.remove('light'); // mode gelap untuk semua (lebih nyaman di mata)
    document.body.classList.add('dark');
    document.body.classList.toggle('luxe', t === 'luxe');
    document.body.classList.toggle('studio', t === 'studio');
    // (tidak ada tombol tema)
  }

  // Tombol 2D / 3D: ganti proyeksi kamera, posisi & data kantor tetap sama
  function applyView() {
    const v = app.state.settings.view === '2d' ? '2d' : '3d';
    $('view2d').classList.toggle('active', v === '2d');
    $('view3d').classList.toggle('active', v === '3d');
  }
  app.setView = function (v) {
    const st = app.state.settings;
    if ((st.view || '3d') === v) return;
    st.view = v;
    applyView();
    R.staticDirty = true;
    R.fit($('office'), app.state);
    app.changed();
    VO.ui.toast(v === '2d' ? 'Tampilan 2D (denah dari atas)' : 'Tampilan 3D (isometrik)', v === '2d' ? 'layout' : 'layers');
  };

  // Tombol + / − : zoom di titik tengah layar, dengan animasi halus
  let zoomAnim = null;
  app.zoomBy = function (f) {
    const c = $('office');
    const sx = c.clientWidth / 2, sy = c.clientHeight / 2;
    const target = VO.clamp((zoomAnim ? zoomAnim.target : R.cam.zoom) * f, 0.2, 3);
    const start = performance.now(), from = R.cam.zoom;
    if (zoomAnim) cancelAnimationFrame(zoomAnim.raf);
    zoomAnim = { target };
    const step = (now) => {
      const k = Math.min(1, (now - start) / 180), e = 1 - (1 - k) * (1 - k);
      const before = R.screenToIso(sx, sy);
      R.cam.zoom = from + (target - from) * e;
      R.cam.x = before.x - sx / R.cam.zoom;
      R.cam.y = before.y - sy / R.cam.zoom;
      if (k < 1) zoomAnim.raf = requestAnimationFrame(step); else zoomAnim = null;
    };
    zoomAnim.raf = requestAnimationFrame(step);
  };

  function syncControls() {
    const s = app.state;
    applyTheme();
    applyView();
    $('companyName').value = s.company.name;
    $('ambient').checked = !!s.settings.ambient;
    $('aiMode').checked = !!s.settings.aiMode && VO.ai.available;
    $('speed').value = String(s.settings.speed || 1);
    $('rpm').value = String(s.settings.rpm || 10);
    $('floorSel').value = s.settings.floor;
    $('layoutSel').value = VO.openPlan(s) ? 'open' : 'rooms';
    $('mapW').value = s.map.w;
    $('mapH').value = s.map.h;
    aiPill();
  }

  /* ------------------------------------------------------------ top bar */
  function setMode(edit) {
    app.ui.edit = edit;
    $('modeView').classList.toggle('active', !edit);
    $('modeEdit').classList.toggle('active', edit);
    $('editBar').classList.toggle('hidden', !edit);
    $('office').classList.toggle('edit', edit);
    $('hint').textContent = edit
      ? 'Drag ruangan/zona untuk memindah · drag kotak kecil di pojok kanan-bawah untuk ubah ukuran · klik kanan = hapus furnitur'
      : 'Scroll = zoom · Drag = geser · Klik karyawan untuk detail · Klik 2× untuk edit';
  }

  function bindTop() {
    const s = () => app.state;
    $('companyName').addEventListener('change', (e) => { s().company.name = e.target.value.trim() || 'Kantor AI'; app.changed(); });
    $('modeView').onclick = () => setMode(false);
    $('modeEdit').onclick = () => setMode(true);
    $('ambient').onchange = (e) => { s().settings.ambient = e.target.checked; app.changed(); };
    $('aiStatus').onclick = () => aiSourceDialog();
    $('aiMode').onchange = (e) => {
      s().settings.aiMode = e.target.checked;
      s().settings.aiModeTouched = true;
      aiPill(); app.changed();
      VO.ui.toast(e.target.checked ? `Tugas baru akan dikerjakan oleh ${VO.ai.label()}` : 'Kembali ke mode simulasi', e.target.checked ? 'sparkles' : 'dice');
    };
    $('rpm').onchange = (e) => { s().settings.rpm = parseInt(e.target.value, 10); app.changed(); };
    $('speed').onchange = (e) => { s().settings.speed = parseFloat(e.target.value); app.changed(); };
    $('btnFit').onclick = () => R.fit($('office'), s());
    $('zoomIn').onclick = () => app.zoomBy(1.25);
    $('zoomOut').onclick = () => app.zoomBy(1 / 1.25);
    $('zoomFit').onclick = () => R.fit($('office'), s());
    setInterval(() => { $('zoomPct').textContent = Math.round(R.cam.zoom * 100) + '%'; }, 150);
    $('zoomPct').onclick = () => R.fit($('office'), s());
    $('view2d').onclick = () => app.setView('2d');
    $('view3d').onclick = () => app.setView('3d');
    $('btnExport').onclick = () => {
      const blob = new Blob([JSON.stringify(s(), null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (s().company.name || 'kantor').replace(/[^\w-]+/g, '_') + '.office.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    $('btnImport').onclick = () => $('importFile').click();
    $('importFile').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const st = VO.migrate(JSON.parse(await f.text()));
        replaceState(st);
        VO.ui.toast('Kantor dimuat: ' + st.company.name, 'upload');
      } catch (err) {
        VO.ui.toast('Gagal import: ' + err.message, 'alert');
      }
      e.target.value = '';
    };
    $('btnReset').onclick = async () => {
      if (!(await VO.ui.confirm('Kosongkan kantor? Semua divisi, karyawan, tugas, dan dokumen akan dihapus.'))) return;
      replaceState(VO.emptyState());
      VO.ui.toast('Kantor dikosongkan — mulai dari nol', 'reset');
    };
    const loadSample = async () => {
      if (s().divisions.length && !(await VO.ui.confirm('Ganti kantor saat ini dengan kantor contoh?'))) return;
      replaceState(VO.sampleState(s()));
      VO.ui.toast('Kantor contoh dimuat', 'sparkles');
    };
    $('btnSample').onclick = loadSample;
    $('emptySample').onclick = loadSample;
    $('emptyAddDiv').onclick = () => VO.ui.addDivision();
    $('addDivision').onclick = () => VO.ui.addDivision();

    document.addEventListener('keydown', (e) => {
      if (e.target.closest('input,textarea,select,dialog')) return;
      if (e.key === 'e' || e.key === 'E') setMode(!app.ui.edit);
      if (e.key === 'v' || e.key === 'V') setMode(false);
      if (e.key === 'f' || e.key === 'F') R.fit($('office'), app.state);
      if (e.key === '+' || e.key === '=') app.zoomBy(1.25);
      if (e.key === '-' || e.key === '_') app.zoomBy(1 / 1.25);
      if (e.key === '2') app.setView('2d');
      if (e.key === '3') app.setView('3d');
      if (e.key === 'Escape') { app.select(null); VO.chat.close(); }
      if (e.key === 'Delete' && app.sel && app.sel.id !== 'boss') VO.ui.remove(app.sel.kind, app.sel.id);
    });
  }

  function replaceState(st) {
    for (const rt of sim.rt.values()) sim.flush(rt);
    sim.rt.clear();
    app.state = st;
    syncBoss();
    app.sel = null;
    R.selected = null;
    app.layoutChanged();
    R.fit($('office'), st);
    VO.save(st);
    app._saveDirty = true;
  }

  /* ------------------------------------------------------------ edit bar */
  function bindEditBar() {
    const pal = $('furniturePalette');
    for (const [k, f] of Object.entries(VO.FURNITURE)) {
      const b = document.createElement('button');
      b.className = 'tool small';
      b.dataset.tool = 'furn:' + k;
      b.title = f.label;
      b.textContent = f.icon;
      pal.appendChild(b);
    }
    $('editBar').addEventListener('click', (e) => {
      const t = e.target.closest('[data-tool]');
      if (t) {
        app.ui.tool = t.dataset.tool;
        document.querySelectorAll('#editBar .tool').forEach((x) => x.classList.toggle('active', x === t));
      }
      const fac = e.target.closest('[data-fac]');
      if (fac) {
        const def = VO.FACILITY_TYPES[fac.dataset.fac];
        const spot = app.findFreeRect(def.w, def.h);
        const f = VO.addFacility(app.state, fac.dataset.fac, spot);
        VO.log(app.state, `Ruangan baru: ${f.name}`, 'door');
        app.layoutChanged();
        app.select({ kind: 'facility', id: f.id }, true);
      }
    });
    $('layoutSel').onchange = (e) => {
      const s = app.state;
      s.settings.layout = e.target.value;
      for (const div of s.divisions) VO.placeDirector(s, div);
      VO.log(s, e.target.value === 'open' ? 'Tata ruang: satu ruangan per divisi (open plan)' : 'Tata ruang: ruang terpisah per departemen', 'layout');
      app.layoutChanged();
    };
    $('floorSel').innerHTML = Object.entries(VO.FLOORS).map(([k, f]) => `<option value="${k}">${f.label}</option>`).join('');
    $('floorSel').onchange = (e) => { app.state.settings.floor = e.target.value; app.layoutChanged(); };
    const mapSize = () => {
      const s = app.state;
      s.map.w = VO.clamp(parseInt($('mapW').value, 10) || s.map.w, 30, 160);
      s.map.h = VO.clamp(parseInt($('mapH').value, 10) || s.map.h, 20, 120);
      app.layoutChanged();
    };
    $('mapW').onchange = mapSize;
    $('mapH').onchange = mapSize;
    $('btnAuto').onclick = () => {
      VO.autoLayout(app.state);
      app.layoutChanged();
      R.fit($('office'), app.state);
      VO.ui.toast('Layout dirapikan', 'wand');
    };
  }

  /* ------------------------------------------------------------ tugas */
  function bindTasks() {
    $('taskForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const title = $('taskTitle').value.trim();
      if (!title) return;
      const [targetType, targetId] = $('taskTarget').value.split(':');
      // perintah membuat video → alur programmatic video (naskah → template → MP4 → Galeri)
      if (VO.video && VO.video.isRequest(title) && VO.video.supported()) {
        const s = app.state;
        const divId = targetType === 'division' ? targetId : targetType === 'dept' ? (s.departments.find((d) => d.id === targetId) || {}).divisionId : targetType === 'agent' ? (s.agents.find((a) => a.id === targetId) || {}).divisionId : null;
        $('taskTitle').value = '';
        VO.gallery.start({ brief: title, divisionId: divId || null }).catch(() => {});
        return;
      }
      const t = VO.tasks.create({ title, targetType, targetId });
      $('taskTitle').value = '';
      VO.ui.toast(t.ai ? `Tugas dikirim — agen memakai ${VO.ai.label()}` : 'Tugas dikirim ke tim', 'send');
    });
    $('taskTitle').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('taskForm').requestSubmit();
    });
    // navigasi atas: Kantor (kantor penuh) atau Tugas/Dokumen/Galeri/Aktivitas (kantor jadi banner + isi di bawahnya)
    const PANES = { tasks: 'taskPane', docs: 'docPane', gallery: 'galleryPane', log: 'logPane' };
    const showView = (v) => {
      if (v !== 'office' && $('modeEdit').classList.contains('active')) $('modeView').click();
      document.body.dataset.view = v;
      document.querySelectorAll('.mainnav .tab').forEach((x) => { x.classList.toggle('active', x.dataset.tab === v); x.setAttribute('aria-selected', x.dataset.tab === v); });
      for (const [k, id] of Object.entries(PANES)) $(id).classList.toggle('hidden', k !== v);
      if (v === 'gallery') VO.gallery.render();
      app._dirty = true;
      // kanvas berubah ukuran → pas-kan ulang kantor setelah tata letak selesai
      requestAnimationFrame(() => requestAnimationFrame(() => R.fit($('office'), app.state)));
    };
    VO.ui.showView = showView;
    document.querySelectorAll('.mainnav .tab').forEach((tab) => tab.addEventListener('click', () => showView(tab.dataset.tab)));
    $('btnOpenOffice').addEventListener('click', () => showView('office'));
    $('thread').addEventListener('click', (e) => {
      const t = e.target.closest('[data-task]');
      if (t) return VO.ui.showTask(t.dataset.task);
      const g = e.target.closest('[data-video]');
      if (g) { showView('gallery'); VO.gallery.show(g.dataset.video); }
    });
    $('targetChips').addEventListener('click', (e) => {
      const c = e.target.closest('[data-target]');
      if (!c) return;
      $('taskTarget').value = c.dataset.target;
      VO.ui.renderTargets(); $('taskTitle').focus();
    });
    $('taskTarget').addEventListener('change', () => VO.ui.renderTargets());
    // status server video (worker Remotion di VPS)
    const videoPill = async () => {
      const e = VO.video ? await VO.video.engine(true) : { worker: false };
      const p = $('videoStatus');
      p.classList.toggle('on', !!e.worker);
      p.title = e.worker ? 'Server video (VPS) aktif — klik untuk membuat video' : 'Server video (VPS) tidak aktif — video dirender di browser';
    };
    videoPill(); setInterval(videoPill, 30000);
    $('videoStatus').addEventListener('click', () => VO.gallery.openCreate());
    $('taskList').addEventListener('click', (e) => {
      const t = e.target.closest('.task');
      if (t) VO.ui.showTask(t.dataset.id);
    });
  }

  /* ------------------------------------------------------------ kanvas: kamera & editor */
  const MIN = { boss: [7, 6], meeting: [8, 7], pantry: [6, 5], lounge: [6, 5], pool: [9, 7], billiard: [7, 6] };

  function hitTest(s, wx, wy) {
    const tx = Math.floor(wx / T), ty = Math.floor(wy / T);
    const inR = (r) => tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h;
    const onHandle = (r) => wx >= (r.x + r.w) * T - 14 && wx <= (r.x + r.w) * T + 2 && wy >= (r.y + r.h) * T - 14 && wy <= (r.y + r.h) * T + 2;
    for (const d of s.departments) if (onHandle(d.room)) return { kind: 'dept', obj: d, rect: d.room, resize: true };
    for (const f of s.facilities) if (onHandle(f)) return { kind: 'facility', obj: f, rect: f, resize: true };
    for (const v of s.divisions) if (onHandle(v.zone)) return { kind: 'division', obj: v, rect: v.zone, resize: true };
    const fu = s.furniture.find((f) => f.x === tx && f.y === ty);
    if (fu) return { kind: 'furniture', obj: fu, rect: fu };
    for (const v of s.divisions) if (v.directorDesk.x === tx && (v.directorDesk.y === ty || v.directorDesk.y + (VO.openPlan(s) ? -1 : 1) === ty)) return { kind: 'dirdesk', obj: v, rect: v.directorDesk };
    for (const d of s.departments) if (inR(d.room)) return { kind: 'dept', obj: d, rect: d.room };
    for (const f of s.facilities) if (inR(f)) return { kind: 'facility', obj: f, rect: f };
    for (const v of s.divisions) if (inR(v.zone)) return { kind: 'division', obj: v, rect: v.zone };
    return null;
  }

  function bindCanvas(canvas) {
    let drag = null;
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return { sx: e.clientX - r.left, sy: e.clientY - r.top };
    };

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { sx, sy } = pos(e);
      const before = R.screenToIso(sx, sy);
      R.cam.zoom = VO.clamp(R.cam.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.2, 3);
      R.cam.x = before.x - sx / R.cam.zoom;
      R.cam.y = before.y - sy / R.cam.zoom;
    }, { passive: false });

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      const { sx, sy } = pos(e);
      const w = R.screenToWorld(sx, sy);
      const s = app.state;
      const tile = { x: Math.floor(w.x / T), y: Math.floor(w.y / T) };
      const pan = { type: 'pan', sx, sy, cx: R.cam.x, cy: R.cam.y, moved: false };

      if (e.button !== 0) { drag = pan; return; }
      if (!app.ui.edit) { drag = { ...pan, click: w }; return; }

      // ---- mode edit
      const tool = app.ui.tool;
      if (tool === 'erase') { eraseAt(tile); drag = { type: 'erase' }; return; }
      if (tool.startsWith('furn:')) { placeAt(tool.slice(5), tile); drag = { type: 'place', kind: tool.slice(5) }; return; }
      const hit = hitTest(s, w.x, w.y);
      if (!hit) { drag = pan; return; }
      drag = { type: hit.resize ? 'resize' : 'move', hit, start: tile, orig: { ...hit.rect }, moved: false };
      if (['dept', 'facility', 'division'].includes(hit.kind)) app.select({ kind: hit.kind, id: hit.obj.id });
    });

    canvas.addEventListener('pointermove', (e) => {
      const { sx, sy } = pos(e);
      const w = R.screenToWorld(sx, sy);
      const s = app.state;
      const tile = { x: Math.floor(w.x / T), y: Math.floor(w.y / T) };
      app.ui.hoverTile = app.ui.edit && tile.x >= 0 && tile.y >= 0 && tile.x < s.map.w && tile.y < s.map.h ? tile : null;
      if (!drag) {
        const p = R.hitPerson(s, w.x, w.y);
        R.hover = p ? p.id : null;
        R.hoverObj = app.ui.edit ? hitTest(s, w.x, w.y)?.obj : null;
        canvas.style.cursor = app.ui.edit ? '' : p ? 'pointer' : '';
        return;
      }
      if (drag.type === 'pan') {
        if (Math.abs(sx - drag.sx) + Math.abs(sy - drag.sy) > 4) drag.moved = true;
        if (drag.moved) canvas.classList.add('dragging');
        R.cam.x = drag.cx - (sx - drag.sx) / R.cam.zoom;
        R.cam.y = drag.cy - (sy - drag.sy) / R.cam.zoom;
        return;
      }
      if (drag.type === 'erase') return eraseAt(tile);
      if (drag.type === 'place') return placeAt(drag.kind, tile);
      const dx = tile.x - drag.start.x, dy = tile.y - drag.start.y;
      if (!dx && !dy && !drag.moved) return;
      drag.moved = true;
      applyDrag(drag, dx, dy);
    });

    const up = (e) => {
      canvas.classList.remove('dragging');
      if (!drag) return;
      const d = drag;
      drag = null;
      if (d.type === 'pan' && !d.moved && d.click) clickSelect(d.click);
      if ((d.type === 'move' || d.type === 'resize') && d.moved) {
        if (d.hit.kind === 'dept') app.fitZone(app.state.divisions.find((v) => v.id === d.hit.obj.divisionId));
        app.layoutChanged();
      }
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);

    canvas.addEventListener('dblclick', (e) => {
      if (app.ui.edit) return;
      const { sx, sy } = pos(e);
      const w = R.screenToWorld(sx, sy);
      const p = R.hitPerson(app.state, w.x, w.y);
      if (p) VO.ui.editEntity(p.id);
    });
  }

  function clickSelect(w) {
    const s = app.state;
    const p = R.hitPerson(s, w.x, w.y);
    if (p) {
      app.select({ kind: 'agent', id: p.id });
      if (p.id !== 'boss') VO.chat.open(p.id); // klik karyawan = buka chat
      return;
    }
    const hit = hitTest(s, w.x, w.y);
    if (hit && ['dept', 'facility', 'division'].includes(hit.kind)) return app.select({ kind: hit.kind, id: hit.obj.id });
    app.select(null);
  }

  function applyDrag(drag, dx, dy) {
    const s = app.state;
    const { hit, orig } = drag;
    const r = hit.rect;
    if (drag.type === 'move') {
      const nx = VO.clamp(orig.x + dx, 0, s.map.w - (orig.w || 1));
      const ny = VO.clamp(orig.y + dy, 0, s.map.h - (orig.h || 1));
      if (hit.kind === 'division') VO.setZone(s, hit.obj, { ...r, x: nx, y: ny }, true);
      else { r.x = nx; r.y = ny; }
    } else {
      let minW = 4, minH = 4;
      if (hit.kind === 'facility') [minW, minH] = MIN[hit.obj.type] || [6, 5];
      if (hit.kind === 'dept') {
        minW = 5; minH = 5;
        const need = VO.deptAgents(s, hit.obj.id).length;
        const nw = VO.clamp(orig.w + dx, minW, s.map.w - r.x);
        const nh = VO.clamp(orig.h + dy, minH, s.map.h - r.y);
        if (VO.deskSlots({ ...r, w: nw, h: nh }).length < need) return; // tidak muat semua meja
        r.w = nw; r.h = nh;
      } else {
        r.w = VO.clamp(orig.w + dx, minW, s.map.w - r.x);
        r.h = VO.clamp(orig.h + dy, minH, s.map.h - r.y);
      }
    }
    sim.dirty = true;
    R.staticDirty = true;
    sim.reseatAll(s);
  }

  function placeAt(type, t) {
    const s = app.state;
    if (t.x < 0 || t.y < 0 || t.x >= s.map.w || t.y >= s.map.h) return;
    if (s.furniture.some((f) => f.x === t.x && f.y === t.y)) return;
    s.furniture.push({ id: VO.uid('fu'), type, x: t.x, y: t.y });
    sim.dirty = true; R.staticDirty = true; app.changed();
  }
  function eraseAt(t) {
    const s = app.state;
    const n = s.furniture.length;
    s.furniture = s.furniture.filter((f) => !(f.x === t.x && f.y === t.y));
    if (n !== s.furniture.length) { sim.dirty = true; R.staticDirty = true; app.changed(); }
  }

  // klik kanan di mode edit = hapus furnitur
  document.addEventListener('DOMContentLoaded', () => {
    $('office').addEventListener('mousedown', (e) => {
      if (e.button === 2 && app.ui.edit) {
        const r = $('office').getBoundingClientRect();
        const w = R.screenToWorld(e.clientX - r.left, e.clientY - r.top);
        eraseAt({ x: Math.floor(w.x / T), y: Math.floor(w.y / T) });
      }
    });
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

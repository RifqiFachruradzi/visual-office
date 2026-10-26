/* =========================================================================
 * model.js — data kantor: struktur organisasi, layout ruangan, persistensi.
 * Semua koordinat layout dalam satuan TILE (grid), bukan pixel.
 * ========================================================================= */
(function () {
  const VO = (window.VO = window.VO || {});

  VO.TILE = 32;
  VO.STORAGE_KEY = 'visual-office:v2';

  VO.uid = (p = 'id') => p + '_' + Math.random().toString(36).slice(2, 9);
  VO.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  VO.rand = (a, b) => a + Math.random() * (b - a);
  VO.pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  VO.esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  VO.PALETTE = ['#4f8cff', '#ff7a59', '#2ec4b6', '#ffbf3c', '#9b5de5', '#f15bb5', '#00bbf9', '#8ac926', '#e76f51'];
  VO.SKINS = ['#f6d5bd', '#eab894', '#c98b62', '#8d5a3b', '#5e3b26'];
  VO.HAIRS = ['#2b1d14', '#4a3020', '#7a4a22', '#c9a15b', '#d0d0d0', '#151515', '#a33b20', '#3d2b5c'];
  VO.SHIRTS = ['#4f8cff', '#ff7a59', '#2ec4b6', '#ffbf3c', '#9b5de5', '#f15bb5', '#3a86ff', '#8ac926', '#ef476f', '#118ab2'];

  // Gemini dipakai dulu karena ada free tier. Alias *-latest selalu menunjuk versi terbaru.
  VO.DEFAULT_MODEL = 'gemini-flash-latest';
  VO.MODELS = [
    { id: '9router', label: '9router (VPS — model default router)', provider: '9router' },
    { id: 'gemini-flash-latest', label: 'Gemini Flash (gratis)', provider: 'gemini' },
    { id: 'gemini-flash-lite-latest', label: 'Gemini Flash-Lite (gratis, paling hemat)', provider: 'gemini' },
    { id: 'gemini-pro-latest', label: 'Gemini Pro (kuota gratis terbatas)', provider: 'gemini' },
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (butuh key Claude)', provider: 'claude' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (butuh key Claude)', provider: 'claude' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (butuh key Claude)', provider: 'claude' },
  ];

  VO.FURNITURE = {
    plant: { label: 'Tanaman', icon: 'plant' },
    sofa: { label: 'Sofa', icon: 'sofa' },
    bookshelf: { label: 'Rak Buku', icon: 'book' },
    whiteboard: { label: 'Whiteboard', icon: 'board' },
    cooler: { label: 'Dispenser', icon: 'droplet' },
    printer: { label: 'Printer', icon: 'printer' },
    server: { label: 'Server Rack', icon: 'server' },
    arcade: { label: 'Arcade', icon: 'gamepad' },
    lamp: { label: 'Lampu Lantai', icon: 'sun' },
  };

  VO.FACILITY_TYPES = {
    // ukuran (tile = meter) mengikuti aset GLB: boss_room 7,2×6,7 · billiard_room 9×7 · swimming_pool 12×10
    boss: { label: 'Ruang Boss', w: 7, h: 8, color: '#5b4636' },
    meeting: { label: 'Ruang Rapat', w: 10, h: 7, color: '#3d5a80' },
    pantry: { label: 'Pantry', w: 7, h: 6, color: '#6a994e' },
    lounge: { label: 'Lounge', w: 8, h: 6, color: '#9d4edd' },
    pool: { label: 'Kolam Renang', w: 12, h: 11, color: '#1e88e5' },
    billiard: { label: 'Ruang Biliar', w: 9, h: 7, color: '#2e7d32' },
  };

  VO.FLOORS = {
    wood: { label: 'Kayu', a: '#c9a27a', b: '#bf966d' },
    tile: { label: 'Keramik', a: '#d9dde3', b: '#cfd4db' },
    dark: { label: 'Gelap', a: '#2f3542', b: '#2a2f3b' },
    mint: { label: 'Mint', a: '#cfe8dc', b: '#c3dfd1' },
  };

  const FIRST = ['Andi', 'Budi', 'Citra', 'Dewi', 'Eka', 'Fajar', 'Gita', 'Hadi', 'Indah', 'Joko', 'Kirana', 'Lukman', 'Maya', 'Nanda', 'Oki', 'Putri', 'Rama', 'Sari', 'Tono', 'Umi', 'Vina', 'Wawan', 'Yudi', 'Zahra', 'Bayu', 'Laras', 'Raka', 'Tiara'];
  VO.randomName = () => VO.pick(FIRST) + ' ' + VO.pick(['AI', 'Bot', '-01', '-02', '-X', 'GPT', 'Agent', 'Prime', 'Nova', 'Byte']);

  // Penampilan gaya Habbo: style = suit (jas) | shirt (kemeja) | cardigan (cardigan + rok)
  VO.STYLES = { suit: 'Jas & dasi', shirt: 'Kemeja & dasi', cardigan: 'Cardigan & rok' };
  VO.HAIR_STYLES = ['Pendek', 'Belah samping', 'Panjang', 'Cepol', 'Botak', 'Ikal'];
  VO.PANTS = ['#2b3a67', '#3b3f4a', '#5b4a3a', '#2d2d33', '#4a5568', '#c2b49a'];
  VO.TIES = ['#7b1fa2', '#c62828', '#1565c0', '#2e7d32', '#ef6c00', '#37474f'];
  VO.TOPS = { suit: ['#2b3a67', '#3b3f4a', '#5b4a3a', '#1f2430', '#4a4f5c'], shirt: ['#a9c7f0', '#dfe9f7', '#b7e0c9', '#f4f6f8'], cardigan: ['#d97aa6', '#f0ead6', '#8e5aa8', '#e8a87c'] };

  // nilai acak yang stabil per id (agar penampilan agen lama tetap sama setelah update)
  const seeded = (id, salt) => {
    let h = 2166136261;
    for (const c of String(id) + salt) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return (h >>> 0) / 4294967296;
  };
  const spick = (id, salt, arr) => arr[Math.floor(seeded(id, salt) * arr.length)];

  VO.ensureLook = function (a) {
    const id = a.id || VO.uid('ag');
    if (!a.style) a.style = a.isDirector || a.id === 'boss' ? 'suit' : spick(id, 'st', ['suit', 'shirt', 'shirt', 'cardigan']);
    if (a.hairStyle == null) a.hairStyle = a.style === 'cardigan' ? spick(id, 'hs', [2, 3, 5]) : spick(id, 'hs', [0, 1, 1, 4, 5]);
    if (!a.top || !a.topV2) { a.top = a.shirt && a.style === 'suit' && a.shirt.startsWith('#2') ? a.shirt : spick(id, 'tp', VO.TOPS[a.style]); a.topV2 = true; }
    if (!a.pants) a.pants = spick(id, 'pn', VO.PANTS);
    if (!a.tie) a.tie = spick(id, 'ti', VO.TIES);
    if (a.glasses == null) a.glasses = seeded(id, 'gl') < 0.25;
    if (a.mustache == null) a.mustache = a.style !== 'cardigan' && seeded(id, 'mu') < 0.12;
    return a;
  };

  VO.makeAgent = (o = {}) => VO.ensureLook({
    id: o.id || VO.uid('ag'),
    name: o.name || VO.randomName(),
    role: o.role || 'Staff',
    model: o.model || VO.DEFAULT_MODEL,
    prompt: o.prompt || '',
    deptId: o.deptId || null,
    divisionId: o.divisionId || null,
    isLead: !!o.isLead,
    isDirector: !!o.isDirector,
    skin: o.skin || VO.pick(VO.SKINS),
    hair: o.hair || VO.pick(VO.HAIRS),
    shirt: o.shirt || VO.pick(VO.SHIRTS),
    live: !!o.live,
    memory: Array.isArray(o.memory) ? o.memory : [],
    cast: o.cast || '', style: o.style, hairStyle: o.hairStyle, top: o.top, topV2: o.top ? true : undefined, pants: o.pants, tie: o.tie, glasses: o.glasses, mustache: o.mustache,
  });

  /* ---------------------------------------------------------------- default */
  // Kantor kosong: hanya ruang Boss, ruang rapat, dan pantry — siap untuk demo dari nol.
  VO.emptyState = function () {
    const s = VO.baseState();
    VO.autoLayout(s);
    s.furniture.push({ id: VO.uid('fu'), type: 'plant', x: 1, y: 1 });
    VO.log(s, 'Kantor baru siap. Tambahkan divisi pertamamu!', 'building');
    return s;
  };
  VO.defaultState = VO.emptyState;

  VO.baseState = function () {
    const s = {
      version: 1,
      company: { name: 'Kantor AI Saya' },
      settings: { floor: 'wood', ambient: true, aiMode: false, speed: 1, rpm: 10, modelsV2: true, theme: 'studio', themeV3: true, themeV4: true, themeV8: true, layoutV9: true, assetsV10: true, symV11: true, layout: 'open', layoutV5: true, dirPosV7: true },
      map: { w: 64, h: 44 },
      // Boss = kamu (pengguna yang login). Namanya mengikuti akun login.
      boss: VO.makeAgent({ id: 'boss', name: 'Boss', role: 'Boss (Kamu)', model: VO.DEFAULT_MODEL, style: 'suit', top: '#1f2430', tie: '#c62828', pants: '#1f2430', hair: '#1c1c1c', hairStyle: 1 }),
      facilities: [],
      divisions: [],
      departments: [],
      agents: [],
      furniture: [],
      tasks: [],
      docs: [],
      videos: [], // galeri video (programmatic video)
      log: [],
    };
    for (const t of ['boss', 'meeting', 'pantry', 'lounge', 'billiard']) VO.addFacility(s, t); // kolam renang tetap bisa ditambah lewat Edit layout
    return s;
  };

  // Kantor contoh lengkap (tombol "Contoh")
  VO.sampleState = function (keep) {
    const s = VO.baseState();
    if (keep) { s.boss = keep.boss; s.company = keep.company; s.docs = keep.docs || []; s.settings = { ...s.settings, ...keep.settings }; }

    const org = [
      ['Teknologi', '#4f8cff', 'CTO', [
        ['Engineering', [['Tech Lead', 1], ['Backend Engineer'], ['Frontend Engineer'], ['QA Engineer']]],
        ['Data & AI', [['Head of Data', 1], ['Data Scientist'], ['ML Engineer']]],
      ]],
      ['Bisnis', '#ff7a59', 'CMO', [
        ['Marketing', [['Marketing Lead', 1], ['Copywriter'], ['Social Media Specialist']]],
        ['Sales', [['Sales Manager', 1], ['Account Executive']]],
      ]],
      ['Operasional', '#2ec4b6', 'COO', [
        ['HR', [['HR Manager', 1], ['Recruiter']]],
        ['Finance', [['Finance Manager', 1], ['Accountant']]],
      ]],
    ];
    for (const [dName, color, dirRole, depts] of org) {
      const div = VO.addDivision(s, { name: dName, color, directorRole: dirRole });
      for (const [deptName, roles] of depts) {
        const dept = VO.addDepartment(s, div.id, { name: deptName });
        for (const [role, lead] of roles) VO.addAgent(s, dept.id, { role, isLead: !!lead });
      }
    }
    // dekorasi
    VO.autoLayout(s);
    // dekorasi di sebelah kanan baris fasilitas (tidak menimpa ruangan)
    const fx = Math.max(0, ...s.facilities.map((f) => f.x + f.w)) + 1;
    const deco = [['plant', 1, 1], ['plant', fx, 1], ['cooler', fx + 1, 5], ['printer', fx + 1, 7], ['bookshelf', fx + 2, 2], ['sofa', fx + 4, 2], ['lamp', fx + 5, 4], ['arcade', fx + 6, 2], ['plant', fx + 8, 2]];
    for (const [type, x, y] of deco) s.furniture.push({ id: VO.uid('fu'), type, x, y });
    VO.autoLayout(s);
    VO.log(s, 'Kantor contoh dimuat: 3 divisi, 6 departemen.', 'building');
    return s;
  };

  /* ---------------------------------------------------------------- CRUD */
  VO.addFacility = function (s, type, at) {
    const def = VO.FACILITY_TYPES[type];
    const f = { id: VO.uid('fa'), type, name: def.label, x: at?.x ?? 2, y: at?.y ?? 2, w: def.w, h: def.h, color: def.color };
    s.facilities.push(f);
    return f;
  };

  VO.addDivision = function (s, o = {}) {
    const color = o.color || VO.PALETTE[s.divisions.length % VO.PALETTE.length];
    const div = { id: VO.uid('dv'), name: o.name || 'Divisi Baru', color, zone: { x: 2, y: 12, w: 12, h: 8 }, directorDesk: { x: 4, y: 13 } };
    if (o.integration) div.integration = o.integration; // berlaku untuk semua departemen & direktur divisi
    s.divisions.push(div);
    if (o.directorRole !== null) {
      const dir = VO.makeAgent({ divisionId: div.id, isDirector: true, role: o.directorRole || 'Direktur ' + div.name, shirt: '#2d3142', prompt: o.directorPrompt });
      s.agents.push(dir);
    }
    return div;
  };

  VO.addDepartment = function (s, divisionId, o = {}) {
    const div = s.divisions.find((d) => d.id === divisionId);
    const dept = { id: VO.uid('dp'), divisionId, name: o.name || 'Departemen Baru', room: { x: (div?.zone.x ?? 2) + 1, y: (div?.zone.y ?? 12) + 4, w: 9, h: 6 } };
    if (o.integration) dept.integration = o.integration; // mis. 'gudang' = terhubung ke Gudang-Document
    s.departments.push(dept);
    return dept;
  };

  VO.addAgent = function (s, deptId, o = {}) {
    const dept = s.departments.find((d) => d.id === deptId);
    const a = VO.makeAgent({ ...o, deptId, divisionId: dept?.divisionId });
    if (a.isLead) s.agents.filter((x) => x.deptId === deptId).forEach((x) => (x.isLead = false));
    s.agents.push(a);
    if (dept) VO.ensureRoomCapacity(s, dept);
    return a;
  };

  VO.director = (s, divId) => s.agents.find((a) => a.isDirector && a.divisionId === divId);
  VO.deptAgents = (s, deptId) => {
    const list = s.agents.filter((a) => a.deptId === deptId && !a.isDirector);
    return list.sort((a, b) => (b.isLead ? 1 : 0) - (a.isLead ? 1 : 0));
  };
  VO.deptLead = (s, deptId) => VO.deptAgents(s, deptId)[0] || null;
  VO.findEntity = (s, id) => (id === 'boss' ? s.boss : s.agents.find((a) => a.id === id));

  VO.removeDivision = function (s, id) {
    for (const d of s.departments.filter((d) => d.divisionId === id)) VO.removeDepartment(s, d.id);
    s.agents = s.agents.filter((a) => !(a.isDirector && a.divisionId === id));
    s.divisions = s.divisions.filter((d) => d.id !== id);
  };
  VO.removeDepartment = function (s, id) {
    s.agents = s.agents.filter((a) => a.deptId !== id);
    s.departments = s.departments.filter((d) => d.id !== id);
  };
  VO.removeAgent = function (s, id) {
    s.agents = s.agents.filter((a) => a.id !== id);
  };

  VO.log = function (s, text, icon = 'activity') {
    s.log.unshift({ t: Date.now(), text, icon });
    if (s.log.length > 200) s.log.length = 200;
  };

  /* ---------------------------------------------------------------- simpanan & gudang dokumen */
  // Ingatan agen: catatan singkat hasil kerja terakhir, ikut dikirim sebagai konteks AI.
  VO.MEMORY_MAX = 6;
  VO.remember = function (agent, text) {
    if (!agent) return;
    agent.memory = agent.memory || [];
    agent.memory.unshift({ t: Date.now(), text: String(text).replace(/[#*`>_]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 400) });
    agent.memory.length = Math.min(agent.memory.length, VO.MEMORY_MAX);
  };

  // Gudang dokumen: hasil kerja & laporan + dokumen yang diunggah (basis pengetahuan).
  VO.DOCS_MAX = 300;
  VO.addDoc = function (s, d) {
    const doc = {
      id: VO.uid('doc'), t: Date.now(), kind: d.kind || 'work', title: String(d.title || 'Tanpa judul').slice(0, 160),
      author: d.author || '-', authorId: d.authorId || null, deptId: d.deptId || null, taskId: d.taskId || null,
      content: String(d.content || '').slice(0, 20000),
    };
    s.docs.unshift(doc);
    if (s.docs.length > VO.DOCS_MAX) s.docs.length = VO.DOCS_MAX;
    return doc;
  };

  const words = (t) => (String(t).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []);
  // Cari dokumen paling relevan (pencocokan kata sederhana, jalan offline)
  VO.relevantDocs = function (s, query, n = 3, excludeTaskId = null) {
    const q = new Set(words(query));
    if (!q.size) return [];
    return s.docs
      .filter((d) => d.taskId !== excludeTaskId || !excludeTaskId)
      .map((d) => {
        let score = 0;
        for (const w of words(d.title)) if (q.has(w)) score += 3;
        for (const w of words(d.content.slice(0, 4000))) if (q.has(w)) score += 1;
        if (d.kind === 'upload') score *= 1.5;
        return { d, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, n)
      .map((x) => x.d);
  };

  /* ---------------------------------------------------------------- geometri ruangan */
  // Slot meja dalam ruang departemen. Baris interior: aisle, meja, kursi, aisle, ...
  VO.deskSlots = function (room) {
    const iw = room.w - 2, ih = room.h - 2;
    const cols = Math.max(1, Math.floor((iw - 1) / 2));
    const rows = Math.max(0, Math.floor((ih - 1) / 3));
    const out = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const dx = room.x + 1 + 1 + c * 2, dy = room.y + 1 + 1 + r * 3;
        out.push({ desk: { x: dx, y: dy }, chair: { x: dx, y: dy + 1 } });
      }
    return out;
  };

  VO.roomSizeFor = function (n) {
    const cols = VO.clamp(n, 2, 4);
    const rows = Math.max(1, Math.ceil(n / cols));
    return { w: cols * 2 + 1 + 2, h: rows * 3 + 1 + 2 };
  };

  VO.ensureRoomCapacity = function (s, dept) {
    const n = VO.deptAgents(s, dept.id).length;
    while (VO.deskSlots(dept.room).length < n) dept.room.h += 3;
  };

  VO.doorTiles = function (room, facility) {
    const cx = room.x + Math.floor(room.w / 2);
    const doors = [{ x: cx, y: room.y + room.h - 1 }];
    // ruangan divisi (open plan): pintu belakang di kiri agar tidak tepat di belakang meja direktur
    if (facility && facility.type === 'zone') { doors.push({ x: room.x + 2, y: room.y }); return doors; }
    if (!facility || facility.type === 'meeting' || facility.type === 'lounge') doors.push({ x: cx, y: room.y });
    return doors;
  };

  VO.bossSeat = function (s) {
    const f = s.facilities.find((f) => f.type === 'boss');
    if (!f) return { desk: { x: 3, y: 3 }, chair: { x: 3, y: 2 }, room: null };
    // meja Boss di tengah ruangan (sesuai boss_room.glb; meja 3 tile: cx-1..cx+1)
    const cx = f.x + Math.floor(f.w / 2);
    return { desk: { x: cx, y: f.y + 3 }, chair: { x: cx, y: f.y + 2 }, room: f };
  };

  // Lantai mezanin (tema Studio): fasilitas di baris atas berada di lantai 2, divisi di lantai 1.
  // M = baris pertama lantai 1 (tepi mezanin); tangga 2 tile di kolom sx..sx+1, baris M..M+2.
  VO.mezz = function (s) {
    if (!s || !s.settings || s.settings.theme !== 'studio' || !s.facilities.length) return null;
    const divTop = s.divisions.length ? Math.min(...s.divisions.map((d) => d.zone.y)) : Infinity;
    const ups = s.facilities.filter((f) => f.y + f.h + 4 <= divTop);
    if (!ups.length) return null;
    const M = Math.max(...ups.map((f) => f.y + f.h)) + 1;
    const sx = Math.min(Math.max(...ups.map((f) => f.x + f.w)) + 1, s.map.w - 3);
    return { M, sx, ups };
  };

  // Perabot depan lantai 1 tema Studio: meja resepsionis di tengah baris terakhir + tanaman di dua sudut depan
  VO.studioFront = function (s) {
    if (!s || !s.settings || s.settings.theme !== 'studio' || !s.divisions.length) return null;
    const mw = s.map.w, mh = s.map.h;
    const w = 4, x = Math.round(mw / 2 - w / 2);
    return { desk: { x, y: mh - 1, w }, plants: [{ x: 0, y: mh - 1 }, { x: mw - 1, y: mh - 1 }] };
  };

  // Kolam renang: air di tengah-kiri, kursi berjemur di sisi kanan (dek kayu di sekelilingnya)
  VO.poolWater = function (f) { // swimming_pool.glb: kolam 8×5 m di tengah dek 12×10 m
    return { x: f.x + 2, y: f.y + 3, w: Math.max(2, f.w - 4), h: Math.max(2, f.h - 6) };
  };
  VO.poolLoungers = function (f) {
    const out = [];
    for (let y = f.y + 2; y < f.y + f.h - 2; y += 2) out.push({ x: f.x + f.w - 2, y });
    return out;
  };

  // Meja biliar 3×2 tile di tengah ruangan
  VO.billiardTable = function (f) {
    return { x: f.x + Math.floor((f.w - 3) / 2), y: f.y + Math.floor((f.h - 2) / 2), w: 3, h: 2 };
  };

  // (Dulu: sofa tamu, meja meeting kecil, tanaman.) Perabot Ruang Boss kini berasal dari boss_room.glb.
  VO.bossExtras = function () { return []; };
  // tile yang ditempati perabot tambahan (untuk grid jalan)
  VO.bossExtraTiles = function (f) {
    const out = [];
    for (const it of VO.bossExtras(f)) for (let i = 0; i < (it.len || 1); i++) out.push({ x: it.x, y: it.y + i });
    return out;
  };

  VO.meetingTable = function (f) {
    return { x: f.x + 3, y: f.y + 3, w: Math.max(1, f.w - 6), h: Math.max(1, f.h - 6) };
  };

  // Tata ruang: 'open' (default) = satu ruangan per divisi — direktur & semua timnya
  // bekerja di ruangan yang sama, departemen ditandai karpet/kluster meja (tanpa dinding).
  // 'rooms' = gaya lama, tiap departemen punya ruangan berdinding sendiri.
  VO.openPlan = (s) => ((s && s.settings && s.settings.layout) || 'open') === 'open';
  // Meja direktur: open plan → di depan-tengah ruangan, menghadap tim; gaya lama → pojok kiri atas
  VO.placeDirector = function (s, div) {
    const z = div.zone;
    const pos = div.dirPos || (VO.openPlan(s) ? 'center' : 'left'); // posisi meja direktur: left | center | right
    const x = pos === 'right' ? z.x + z.w - 3 : pos === 'left' ? z.x + 2 : z.x + Math.floor(z.w / 2);
    div.directorDesk = { x, y: VO.openPlan(s) ? z.y + 2 : z.y + 1 };
  };
  // Direktur di open plan duduk di belakang meja menghadap tim (seperti Boss)
  VO.facesFront = (s, ent) => ent.id === 'boss' || (ent.isDirector && VO.openPlan(s));

  // Posisi kursi/meja setiap entitas (dipakai renderer + simulasi)
  VO.seatOf = function (s, ent) {
    if (ent.id === 'boss') return VO.bossSeat(s);
    if (ent.isDirector) {
      const div = s.divisions.find((d) => d.id === ent.divisionId);
      if (!div) return null;
      return { desk: { ...div.directorDesk }, chair: { x: div.directorDesk.x, y: div.directorDesk.y + (VO.openPlan(s) ? -1 : 1) } };
    }
    const dept = s.departments.find((d) => d.id === ent.deptId);
    if (!dept) return null;
    const idx = VO.deptAgents(s, dept.id).findIndex((a) => a.id === ent.id);
    return VO.deskSlots(dept.room)[idx] || null;
  };

  /* ---------------------------------------------------------------- auto layout */
  VO.autoLayout = function (s) {
    // Fasilitas di baris atas
    let x = 2;
    const order = ['boss', 'meeting', 'pantry', 'lounge', 'pool', 'billiard'];
    const facs = [...s.facilities].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
    for (const f of facs) {
      f.x = x; f.y = 0; x += f.w + 1; // menempel dinding belakang lantai atas
    }
    let maxX = x;
    // lebar lantai mengikuti baris fasilitas (min 46) agar denah mendekati persegi; divisi berlebih turun ke baris berikutnya
    const maxW = Math.max(x + 2, 46);
    // Divisi sebagai zona berisi ruang departemen
    // divisi mulai 4 baris di bawah fasilitas (ruang untuk koridor / tangga lantai mezanin)
    const facBottom = Math.max(0, ...s.facilities.map((f) => f.y + f.h));
    let cx = 2, cy = Math.max(12, facBottom + 4), rowH = 0;
    const rows = [[]];
    for (const div of s.divisions) {
      const depts = s.departments.filter((d) => d.divisionId === div.id);
      const sizes = depts.map((d) => VO.roomSizeFor(Math.max(1, VO.deptAgents(s, d.id).length)));
      const innerW = sizes.reduce((acc, z) => acc + z.w, 0) + Math.max(0, sizes.length - 1);
      const zw = Math.max(12, innerW + 2);
      const zh = 5 + Math.max(4, ...sizes.map((z) => z.h));
      if (cx + zw > maxW && cx > 2) { cx = 2; cy += rowH + 2; rowH = 0; rows.push([]); }
      rows[rows.length - 1].push(div);
      VO.setZone(s, div, { x: cx, y: cy, w: zw, h: zh }, false);
      VO.placeDirector(s, div);
      let rx = cx + 1;
      depts.forEach((d, i) => {
        d.room = { x: rx, y: cy + 4, w: sizes[i].w, h: sizes[i].h };
        rx += sizes[i].w + 1;
      });
      cx += zw + 2;
      rowH = Math.max(rowH, zh);
      maxX = Math.max(maxX, cx);
    }
    // peta mengikuti isi (furnitur tetap dipertahankan di dalam peta)
    const fx = Math.max(0, ...s.furniture.map((f) => f.x + 2));
    const fy = Math.max(0, ...s.furniture.map((f) => f.y + 2));
    const facRight = Math.max(0, ...s.facilities.map((f) => f.x + f.w));
    s.map.w = Math.max(40, maxX, fx, facRight + 4); // margin kiri = kanan (2 tile) agar simetris; sisakan ruang tangga
    // tiap baris divisi diletakkan di tengah lantai agar denah simetris kiri-kanan
    for (const row of rows) {
      if (!row.length) continue;
      const right = Math.max(...row.map((d) => d.zone.x + d.zone.w));
      const shift = Math.floor((s.map.w - right - 2) / 2);
      if (shift > 0) for (const d of row) { VO.setZone(s, d, { ...d.zone, x: d.zone.x + shift }, true); }
    }
    s.map.h = Math.max(24, cy + rowH + 2, fy);
    // baris fasilitas (lantai atas) di tengah agar kiri-kanan simetris; sisakan ruang tangga di kanan
    if (facs.length) {
      const L = Math.min(...facs.map((f) => f.x)), Rr = Math.max(...facs.map((f) => f.x + f.w));
      const shift = Math.min(Math.floor((s.map.w - (Rr - L)) / 2) - L, s.map.w - 4 - Rr);
      if (shift > 0) for (const f of facs) f.x += shift;
    }
  };

  /* ---------------------------------------------------------------- perubahan struktur (Telegram) */
  // Dipakai di browser DAN di server (lib/officeops.js memuat file ini) agar hasilnya identik.
  const normName = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  /** Cari berdasarkan nama: persis (tanpa spasi/tanda baca) lalu awalan unik. → {hit} | {many} | {} */
  VO.findByName = function (list, key) {
    const k = normName(key);
    if (!k) return {};
    const exact = list.filter((x) => normName(x.name) === k);
    if (exact.length === 1) return { hit: exact[0] };
    const part = exact.length ? exact : list.filter((x) => normName(x.name).startsWith(k));
    return part.length === 1 ? { hit: part[0] } : part.length ? { many: part } : {};
  };
  const addDeptWithTeam = (s, div, name, staff) => {
    const dept = VO.addDepartment(s, div.id, { name });
    VO.addAgent(s, dept.id, { role: 'Team Lead', isLead: true });
    for (let i = 0; i < staff; i++) VO.addAgent(s, dept.id, { role: 'Staff' });
    return dept;
  };
  const pickErr = (r, what, key) => (r.many ? `Ada beberapa ${what} yang cocok dengan "${key}": ${r.many.map((x) => x.name).join(', ')}. Tulis lebih lengkap.` : `${what[0].toUpperCase() + what.slice(1)} "${key}" tidak ditemukan.`);
  /**
   * Terapkan satu perubahan struktur. op:
   *   { type:'division', name, depts:[nama…], staff }   divisi baru (+ direktur, + departemen opsional)
   *   { type:'dept', division, name, staff }           departemen baru di divisi (ketua + staf)
   *   { type:'agent', dept, role, name? }              rekrut karyawan ke departemen
   * → { ok, text }  (s diubah & ditata ulang bila ok)
   */
  VO.applyOp = function (s, op) {
    const staff = Math.max(0, Math.min(20, parseInt(op.staff, 10) >= 0 ? parseInt(op.staff, 10) : 2));
    if (op.type === 'division') {
      const name = String(op.name || '').trim().slice(0, 60);
      if (!name) return { ok: false, text: 'Nama divisi kosong.' };
      if (s.divisions.some((d) => normName(d.name) === normName(name))) return { ok: false, text: `Divisi "${name}" sudah ada.` };
      const div = VO.addDivision(s, { name, directorRole: 'Direktur ' + name });
      const depts = (op.depts || []).map((x) => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 8);
      for (const dn of depts) addDeptWithTeam(s, div, dn, staff);
      VO.autoLayout(s);
      VO.log(s, `Divisi baru dari Telegram: ${name}${depts.length ? ' (' + depts.join(', ') + ')' : ''}`, 'layers');
      const n = s.agents.filter((a) => a.divisionId === div.id).length;
      return { ok: true, text: `Divisi **${name}** dibuat dengan direktur${depts.length ? ` dan ${depts.length} departemen (${depts.join(', ')})` : ''} — ${n} karyawan.` };
    }
    if (op.type === 'dept') {
      const r = VO.findByName(s.divisions, op.division);
      if (!r.hit) return { ok: false, text: pickErr(r, 'divisi', op.division) };
      const name = String(op.name || '').trim().slice(0, 60);
      if (!name) return { ok: false, text: 'Nama departemen kosong.' };
      if (s.departments.some((d) => d.divisionId === r.hit.id && normName(d.name) === normName(name))) return { ok: false, text: `Departemen "${name}" sudah ada di divisi ${r.hit.name}.` };
      addDeptWithTeam(s, r.hit, name, staff);
      VO.autoLayout(s);
      VO.log(s, `Departemen baru dari Telegram: ${name} (divisi ${r.hit.name})`, 'building');
      return { ok: true, text: `Departemen **${name}** dibuat di divisi ${r.hit.name} — 1 ketua tim + ${staff} staf.` };
    }
    if (op.type === 'agent') {
      const r = VO.findByName(s.departments, op.dept);
      if (!r.hit) return { ok: false, text: pickErr(r, 'departemen', op.dept) };
      const role = String(op.role || 'Staff').trim().slice(0, 60) || 'Staff';
      const a = VO.addAgent(s, r.hit.id, { role, name: op.name ? String(op.name).slice(0, 40) : undefined });
      VO.autoLayout(s);
      VO.log(s, `Karyawan baru dari Telegram: ${a.name} — ${role} (${r.hit.name})`, 'user');
      return { ok: true, text: `**${a.name}** (${role}) bergabung ke departemen ${r.hit.name}.` };
    }
    return { ok: false, text: 'Perintah tidak dikenal.' };
  };

  // Geser zona divisi (ikut memindahkan ruang departemen & meja direktur)
  VO.setZone = function (s, div, z, moveChildren = true) {
    const dx = z.x - div.zone.x, dy = z.y - div.zone.y;
    if (moveChildren && (dx || dy)) {
      for (const d of s.departments.filter((d) => d.divisionId === div.id)) { d.room.x += dx; d.room.y += dy; }
      div.directorDesk.x += dx; div.directorDesk.y += dy;
    }
    div.zone = { ...z };
  };

  /* ---------------------------------------------------------------- persistensi */
  VO.save = function (s) {
    try { localStorage.setItem(VO.STORAGE_KEY, JSON.stringify(s)); return true; } catch (e) { return false; }
  };
  VO.load = function () {
    try {
      const raw = localStorage.getItem(VO.STORAGE_KEY);
      if (!raw) return null;
      return VO.migrate(JSON.parse(raw));
    } catch (e) { return null; }
  };
  VO.migrate = function (s) {
    if (!s || typeof s !== 'object' || !s.boss || !Array.isArray(s.agents)) throw new Error('Format file tidak dikenali');
    const d = VO.defaultState();
    const needV2 = !(s.settings && s.settings.modelsV2);
    const needV3 = !(s.settings && s.settings.themeV3);
    const needV4 = !(s.settings && s.settings.themeV4);
    const needV5 = !(s.settings && s.settings.layoutV5);
    const needV7 = !(s.settings && s.settings.dirPosV7);
    const needV8 = !(s.settings && s.settings.themeV8);
    const needV9 = !(s.settings && s.settings.layoutV9);
    const needV10 = !(s.settings && s.settings.assetsV10);
    const needV11 = !(s.settings && s.settings.symV11);
    for (const k of ['facilities', 'divisions', 'departments', 'agents', 'furniture', 'tasks', 'docs', 'log', 'videos']) if (!Array.isArray(s[k])) s[k] = [];
    // video yang sedang diproduksi tidak bisa dilanjutkan setelah halaman dimuat ulang
    for (const v of s.videos) if (v.status === 'producing') { v.status = 'failed'; v.error = 'Terputus (halaman dimuat ulang)'; }
    s.settings = { ...d.settings, ...(s.settings || {}) };
    s.company = s.company || d.company;
    // v2: pindah ke Gemini (gratis) sebagai model default
    if (needV2) {
      for (const a of [s.boss, ...s.agents]) if (String(a.model).startsWith('claude-')) a.model = VO.DEFAULT_MODEL;
      s.settings.modelsV2 = true;
    }
    for (const a of [s.boss, ...s.agents]) { if (!Array.isArray(a.memory)) a.memory = []; VO.ensureLook(a); }
    // v3: tampilan default berganti ke Kantor Klasik (tema lain tetap bisa dipilih)
    if (needV3) { s.settings.theme = 'classic'; s.settings.themeV3 = true; }
    // v4: tampilan default berganti ke Penthouse (kantor mewah malam hari)
    if (needV4) { s.settings.theme = 'luxe'; s.settings.themeV4 = true; }
    // v5: tata ruang open plan — direktur pindah ke depan-tengah ruangan divisinya
    if (needV5) { s.settings.layout = 'open'; s.settings.layoutV5 = true; for (const div of s.divisions) if (div.zone) VO.placeDirector(s, div); }
    // v7: atasan Finance Division duduk di sisi kanan ruangan (bisa diubah di Edit Divisi)
    // v8: tampilan default "Studio" (kantor 2 lantai); tata ulang sekali agar ada ruang tangga
    s.settings.theme = 'studio'; // hanya ada satu tampilan (Studio)
    // v9: denah simetris (perspektif depan, baris divisi di tengah, resepsionis) → tata ulang sekali
    if (needV9) { s.settings.layoutV9 = true; if (!needV8 && (s.divisions.length || s.facilities.length)) VO.autoLayout(s); }
    if (needV8) { s.settings.theme = 'studio'; s.settings.themeV8 = true; if (s.divisions.length || s.facilities.length) VO.autoLayout(s); }
    // v10: tampilan 3D dari aset GLB → ukuran fasilitas mengikuti model (1 tile = 1 m), tata ulang sekali
    if (needV10) {
      s.settings.assetsV10 = true;
      for (const f of s.facilities) { const d = VO.FACILITY_TYPES[f.type]; if (d) { f.w = d.w; f.h = d.h; } }
      if (s.divisions.length || s.facilities.length) VO.autoLayout(s);
    }
    // v11: kamera tetap + fasilitas lantai atas di tengah (simetris) → tata ulang sekali
    if (needV11) {
      s.settings.symV11 = true; delete s.settings.camYaw; delete s.settings.camPitch;
      if (!needV10 && (s.divisions.length || s.facilities.length)) VO.autoLayout(s);
    }
    if (needV7) {
      s.settings.dirPosV7 = true;
      for (const div of s.divisions) if (div.zone && /financ|keuangan/i.test(div.name) && !div.dirPos) { div.dirPos = 'right'; VO.placeDirector(s, div); }
    }
    s.map = s.map || d.map;
    // tugas yang sedang berjalan tidak bisa dilanjutkan setelah reload
    for (const t of s.tasks) if (!['done', 'failed'].includes(t.status)) t.status = 'failed', (t.note = 'Terputus (halaman dimuat ulang)');
    return s;
  };
})();

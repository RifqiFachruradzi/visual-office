/* =========================================================================
 * sim.js — grid jalan, pathfinding, dan "otak" setiap karyawan agent.
 * Setiap entitas punya antrean aksi: goto / wait / work / fn.
 * ========================================================================= */
(function () {
  const VO = window.VO;
  const T = VO.TILE;

  const sim = (VO.sim = {
    grid: null,
    rt: new Map(), // id -> runtime entity
    dirty: true,
    visitorRot: {},
  });

  /* ------------------------------------------------------------ grid */
  const ZONE = { type: 'zone' };
  sim.buildGrid = function (s) {
    const w = s.map.w, h = s.map.h;
    const block = new Uint8Array(w * h);
    const set = (x, y, v = 1) => { if (x >= 0 && y >= 0 && x < w && y < h) block[y * w + x] = v; };
    const walls = (room, fac) => {
      for (let x = room.x; x < room.x + room.w; x++) { set(x, room.y); set(x, room.y + room.h - 1); }
      for (let y = room.y; y < room.y + room.h; y++) { set(room.x, y); set(room.x + room.w - 1, y); }
      for (const d of VO.doorTiles(room, fac)) set(d.x, d.y, 0);
    };
    for (const f of s.facilities) {
      walls(f, f);
      if (f.type === 'meeting') {
        const t = VO.meetingTable(f);
        for (let y = t.y; y < t.y + t.h; y++) for (let x = t.x; x < t.x + t.w; x++) set(x, y);
      }
      if (f.type === 'pantry') for (let x = f.x + 1; x < f.x + f.w - 1; x++) set(x, f.y + 1);
      if (f.type === 'boss') for (const c of VO.bossExtraTiles(f)) set(c.x, c.y);
      if (f.type === 'billiard') {
        const b = VO.billiardTable(f);
        for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) set(x, y);
      }
      if (f.type === 'pool') {
        const w = VO.poolWater(f);
        for (let y = w.y; y < w.y + w.h; y++) for (let x = w.x; x < w.x + w.w; x++) set(x, y);
        for (const l of VO.poolLoungers(f)) set(l.x, l.y);
      }
    }
    const open = VO.openPlan(s);
    const mz = VO.mezz(s);
    if (open) for (const div of s.divisions) walls(div.zone, ZONE); // satu ruangan per divisi (berdinding)
    const fr = VO.studioFront && VO.studioFront(s);
    if (fr) { for (let x = fr.desk.x; x < fr.desk.x + fr.desk.w; x++) set(x, fr.desk.y); for (const pl of fr.plants) set(pl.x, pl.y); }
    if (mz) { // tema Studio: tepi mezanin berpagar, hanya bisa turun lewat tangga
      for (let x = 0; x < w; x++) if (x < mz.sx || x > mz.sx + 1) set(x, mz.M);
      set(mz.sx - 1, mz.M + 1); set(mz.sx + 2, mz.M + 1); // pegangan tangga; keluar tangga lewat baris M+2
    }
    for (const d of s.departments) {
      if (!open && !mz) walls(d.room, null);
      for (const slot of VO.deskSlots(d.room)) set(slot.desk.x, slot.desk.y);
    }
    for (const div of s.divisions) {
      set(div.directorDesk.x, div.directorDesk.y);
      if (open) { set(div.directorDesk.x - 1, div.directorDesk.y); set(div.directorDesk.x + 1, div.directorDesk.y); } // meja eksekutif lebar
    }
    const bs = VO.bossSeat(s);
    set(bs.desk.x, bs.desk.y); set(bs.desk.x - 1, bs.desk.y); set(bs.desk.x + 1, bs.desk.y);
    for (const f of s.furniture) set(f.x, f.y);
    sim.grid = { w, h, block };
    sim.dirty = false;
  };

  const blocked = (x, y) => {
    const g = sim.grid;
    if (x < 0 || y < 0 || x >= g.w || y >= g.h) return true;
    return g.block[y * g.w + x] === 1;
  };
  sim.isBlocked = blocked;

  sim.nearestFree = function (t) {
    if (!blocked(t.x, t.y)) return t;
    const g = sim.grid, seen = new Set([t.y * g.w + t.x]), q = [t];
    while (q.length) {
      const c = q.shift();
      for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
        const n = { x: c.x + dx, y: c.y + dy };
        if (n.x < 0 || n.y < 0 || n.x >= g.w || n.y >= g.h) continue;
        const k = n.y * g.w + n.x;
        if (seen.has(k)) continue;
        seen.add(k);
        if (!blocked(n.x, n.y)) return n;
        q.push(n);
      }
    }
    return t;
  };

  // BFS (biaya seragam) — cukup cepat untuk grid kantor
  sim.findPath = function (from, to) {
    const g = sim.grid;
    to = sim.nearestFree(to);
    if (from.x === to.x && from.y === to.y) return [];
    const prev = new Int32Array(g.w * g.h).fill(-1);
    const start = from.y * g.w + from.x, goal = to.y * g.w + to.x;
    prev[start] = start;
    const q = [start];
    let head = 0;
    while (head < q.length) {
      const c = q[head++];
      if (c === goal) break;
      const cx = c % g.w, cy = (c / g.w) | 0;
      for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
        const k = ny * g.w + nx;
        if (prev[k] !== -1 || (blocked(nx, ny) && k !== goal)) continue;
        prev[k] = c;
        q.push(k);
      }
    }
    if (prev[goal] === -1) return null;
    const path = [];
    for (let c = goal; c !== start; c = prev[c]) path.push({ x: c % g.w, y: (c / g.w) | 0 });
    return smoothPath(from, path.reverse());
  };

  // Garis pandang bebas halangan antara dua titik tile (sampling tiap 1/4 tile)
  function clearLine(a, b) {
    const ax = a.x + 0.5, ay = a.y + 0.5, bx = b.x + 0.5, by = b.y + 0.5;
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) * 4);
    for (let i = 1; i < n; i++) {
      const x = ax + ((bx - ax) * i) / n, y = ay + ((by - ay) * i) / n;
      // cek juga sedikit ke samping agar badan tidak menyerempet sudut
      for (const [ox, oy] of [[0, 0], [0.22, 0.22], [-0.22, -0.22], [0.22, -0.22], [-0.22, 0.22]]) {
        if (blocked(Math.floor(x + ox), Math.floor(y + oy))) return false;
      }
    }
    return true;
  }

  // "String pulling": lompati titik antara bila jalurnya lurus & bebas → jalan diagonal yang luwes
  function smoothPath(from, path) {
    if (path.length < 3) return path;
    const out = [];
    let cur = from, i = 0;
    while (i < path.length) {
      let j = path.length - 1;
      while (j > i && !clearLine(cur, path[j])) j--;
      out.push(path[j]);
      cur = path[j];
      i = j + 1;
    }
    return out;
  }

  /* ------------------------------------------------------------ runtime entitas */
  const tileOf = (rt) => ({ x: Math.floor(rt.x / T), y: Math.floor(rt.y / T) });
  sim.tileOf = tileOf;

  sim.sync = function (s) {
    if (sim.dirty || !sim.grid) sim.buildGrid(s);
    const all = [s.boss, ...s.agents];
    const ids = new Set(all.map((e) => e.id));
    for (const [id, rt] of sim.rt) if (!ids.has(id)) { sim.flush(rt); sim.rt.delete(id); }
    for (const e of all) {
      if (sim.rt.has(e.id)) continue;
      const seat = VO.seatOf(s, e);
      const start = seat ? seat.chair : sim.nearestFree({ x: 2, y: s.map.h - 2 });
      sim.rt.set(e.id, {
        id: e.id, x: (start.x + 0.5) * T, y: (start.y + 0.5) * T,
        queue: [], cur: null, path: null, status: 'idle', bubble: null,
        sitting: !!seat, facing: 1, phase: Math.random() * 10,
        idleT: VO.rand(3, 15), working: false, progress: 0,
      });
    }
  };

  // Hentikan semua aksi & selesaikan promise yang menggantung
  sim.flush = function (rt, onlyAmbient = false) {
    const keep = [];
    const all = rt.cur ? [rt.cur, ...rt.queue] : rt.queue;
    for (const a of all) {
      if (onlyAmbient && !a.ambient) { keep.push(a); continue; }
      a.resolve && a.resolve(false);
    }
    if (onlyAmbient && rt.cur && !rt.cur.ambient) { rt.cur = keep.shift(); rt.queue = keep; return; }
    rt.cur = null;
    rt.queue = keep;
    rt.path = null;
  };

  sim.reseatAll = function (s) {
    // setelah layout berubah: semua orang kembali ke kursi barunya bila sedang duduk
    sim.buildGrid(s);
    for (const rt of sim.rt.values()) {
      rt.path = null;
      if (!rt.cur && rt.sitting) {
        const e = VO.findEntity(s, rt.id);
        const seat = e && VO.seatOf(s, e);
        if (seat) { rt.x = (seat.chair.x + 0.5) * T; rt.y = (seat.chair.y + 0.5) * T; }
      }
      const t = tileOf(rt);
      if (blocked(t.x, t.y) && !rt.sitting) {
        const f = sim.nearestFree(t);
        rt.x = (f.x + 0.5) * T; rt.y = (f.y + 0.5) * T;
      }
    }
  };

  /**
   * Jalankan rangkaian aksi untuk entitas. Mengembalikan Promise yang selesai
   * saat aksi terakhir selesai. Aksi non-ambient menyingkirkan aksi ambient.
   */
  sim.act = function (id, actions, opts = {}) {
    const rt = sim.rt.get(id);
    if (!rt || !actions.length) return Promise.resolve(false);
    if (!opts.ambient) sim.flush(rt, true);
    return new Promise((resolve) => {
      actions.forEach((a, i) => {
        a.ambient = !!opts.ambient;
        if (i === actions.length - 1) a.resolve = resolve;
      });
      rt.queue.push(...actions);
    });
  };

  // Balon chat di atas kepala. icon = nama ikon dari icons.js (opsional).
  sim.say = function (id, text, sec = 3, icon = null) {
    const rt = sim.rt.get(id);
    if (rt) rt.bubble = { text, icon, until: performance.now() + sec * 1000 };
  };
  sim.STATUS_ICON = { working: 'monitor', coffee: 'coffee', meeting: 'meeting', briefing: 'task', reporting: 'inbox', chat: 'chat', break: 'leaf' };

  sim.isBusy = (id) => {
    const rt = sim.rt.get(id);
    return !!rt && ((rt.cur && !rt.cur.ambient) || rt.queue.some((a) => !a.ambient));
  };

  /* ------------------------------------------------------------ helper aksi */
  const A = (sim.A = {
    goto: (tile, status) => ({ type: 'goto', tile, status }),
    wait: (sec, status, bubble) => ({ type: 'wait', t: sec, status, bubble }),
    sit: () => ({ type: 'sit' }),
    fn: (f) => ({ type: 'fn', f }),
    work: (job) => ({ type: 'work', job }),
  });

  sim.homeActions = function (s, id) {
    const e = VO.findEntity(s, id);
    const seat = e && VO.seatOf(s, e);
    return seat ? [A.goto(seat.chair, 'walking'), A.sit()] : [];
  };

  sim.visitorTile = function (s, superiorId) {
    const e = VO.findEntity(s, superiorId);
    const seat = e && VO.seatOf(s, e);
    if (!seat) return { x: 3, y: 3 };
    const n = (sim.visitorRot[superiorId] = ((sim.visitorRot[superiorId] || 0) + 1) % 5);
    const offs = [0, -1, 1, -2, 2][n];
    const y = VO.facesFront(s, e) ? seat.desk.y + 1 : seat.desk.y + 2;
    return sim.nearestFree({ x: seat.desk.x + offs, y });
  };

  sim.spots = function (s, type) {
    const out = [];
    for (const f of s.facilities.filter((f) => f.type === type)) {
      if (type === 'pantry') for (let x = f.x + 1; x < f.x + f.w - 1; x++) out.push({ x, y: f.y + 2 });
      else if (type === 'meeting' || type === 'billiard') {
        const t = type === 'meeting' ? VO.meetingTable(f) : VO.billiardTable(f);
        for (let x = t.x; x < t.x + t.w; x++) { out.push({ x, y: t.y - 1 }); out.push({ x, y: t.y + t.h }); }
        for (let y = t.y; y < t.y + t.h; y++) { out.push({ x: t.x - 1, y }); out.push({ x: t.x + t.w, y }); }
      } else for (let y = f.y + 2; y < f.y + f.h - 1; y++) for (let x = f.x + 1; x < f.x + f.w - 1; x++) out.push({ x, y });
    }
    return out.filter((p) => !blocked(p.x, p.y));
  };

  /* ------------------------------------------------------------ update */
  sim.update = function (s, dt) {
    if (sim.dirty || !sim.grid) sim.buildGrid(s);
    for (const rt of sim.rt.values()) step(s, rt, dt);
  };

  function step(s, rt, dt) {
    rt.phase += dt;
    if (!rt.cur && rt.queue.length) rt.cur = rt.queue.shift();
    const a = rt.cur;
    if (!a) return idle(s, rt, dt);

    let done = false;
    switch (a.type) {
      case 'goto': {
        rt.sitting = false;
        rt.working = false;
        if (a.status) rt.status = a.status;
        if (!rt.path) {
          rt.path = sim.findPath(tileOf(rt), a.tile) || [];
        }
        done = move(rt, dt);
        if (done) rt.path = null;
        break;
      }
      case 'sit': rt.sitting = true; rt.status = 'idle'; done = true; break;
      case 'wait': {
        if (a.status) rt.status = a.status;
        if (a.bubble && !a.said) { sim.say(rt.id, a.bubble, Math.min(a.t, 6), sim.STATUS_ICON[a.status]); a.said = true; }
        a.t -= dt;
        done = a.t <= 0;
        break;
      }
      case 'fn': a.f(); done = true; break;
      case 'work': {
        const job = a.job;
        rt.sitting = true; rt.working = true; rt.status = 'working';
        if (!a.started) { a.started = true; job.start && job.start(); }
        job.tick && job.tick(dt);
        rt.progress = job.progress || 0;
        done = !!job.done;
        if (done) rt.working = false;
        break;
      }
    }
    if (done) {
      rt.cur = null;
      a.resolve && a.resolve(true);
    }
  }

  function move(rt, dt) {
    const sp = 3.4 * T * dt;
    let budget = sp;
    while (rt.path && rt.path.length && budget > 0) {
      const n = rt.path[0];
      const tx = (n.x + 0.5) * T, ty = (n.y + 0.5) * T;
      const dx = tx - rt.x, dy = ty - rt.y, d = Math.hypot(dx, dy);
      if (Math.abs(dx) > 0.5) rt.facing = dx > 0 ? 1 : -1;
      if (d > 0.5) { rt.mdx = dx; rt.mdy = dy; } // arah gerak terakhir (untuk arah hadap isometrik)
      if (d <= budget) { rt.x = tx; rt.y = ty; budget -= d; rt.path.shift(); }
      else { rt.x += (dx / d) * budget; rt.y += (dy / d) * budget; budget = 0; }
    }
    return !rt.path || rt.path.length === 0;
  }

  function idle(s, rt, dt) {
    const e = VO.findEntity(s, rt.id);
    if (!e) return;
    const seat = VO.seatOf(s, e);
    if (seat && !rt.sitting) {
      sim.act(rt.id, sim.homeActions(s, rt.id), { ambient: true });
      return;
    }
    rt.status = 'idle';
    if (!s.settings.ambient) return;
    rt.idleT -= dt;
    if (rt.idleT > 0) return;
    rt.idleT = VO.rand(10, 30);
    const r = Math.random();
    const home = sim.homeActions(s, rt.id);
    if (r < 0.3) {
      const spot = VO.pick(sim.spots(s, 'pantry'));
      if (spot) sim.act(rt.id, [A.goto(spot, 'walking'), A.wait(VO.rand(3, 6), 'coffee', VO.pick(['Ngopi dulu', 'Snack time', 'Refill kafein'])), ...home], { ambient: true });
    } else if (r < 0.37 && s.facilities.some((f) => f.type === 'billiard')) {
      // main biliar di sisi meja
      const spot = VO.pick(sim.spots(s, 'billiard'));
      if (spot) sim.act(rt.id, [A.goto(spot, 'walking'), A.wait(VO.rand(5, 9), 'break', VO.pick(['Main biliar dulu', 'Bola 8 masuk!', 'Giliranmu', 'Nice shot!'])), ...home], { ambient: true });
    } else if (r < 0.44 && (s.facilities.some((f) => f.type === 'pool' || f.type === 'lounge'))) {
      // rehat sebentar di kolam renang / lounge
      const spot = VO.pick([...sim.spots(s, 'pool'), ...sim.spots(s, 'lounge')]);
      if (spot) sim.act(rt.id, [A.goto(spot, 'walking'), A.wait(VO.rand(4, 8), 'break', VO.pick(['Cari angin dulu', 'Rehat sebentar', 'Lihat pemandangan', 'Brainstorm santai'])), ...home], { ambient: true });
    } else if (r < 0.55 && rt.id !== 'boss') {
      // ngobrol dengan rekan satu departemen yang sedang di mejanya
      const mates = s.agents.filter((x) => x.id !== rt.id && x.deptId && x.deptId === e.deptId && !sim.isBusy(x.id));
      const m = mates.length && VO.pick(mates);
      const mrt = m && sim.rt.get(m.id);
      if (mrt && mrt.sitting) {
        const t = tileOf(mrt);
        sim.act(rt.id, [
          A.goto({ x: t.x + 1, y: t.y }, 'walking'),
          A.fn(() => sim.say(m.id, VO.pick(['Haha iya', 'Masuk akal', 'Setuju', 'Ide bagus!']), 3, 'chat')),
          A.wait(3, 'chat', VO.pick(['Eh, udah liat PR baru?', 'Prompt-mu keren', 'Token kita cukup?', 'Makan siang di mana?'])),
          ...home,
        ], { ambient: true });
      }
    } else if (r < 0.58) {
      const items = s.furniture.filter((f) => ['cooler', 'bookshelf', 'whiteboard', 'arcade', 'printer'].includes(f.type));
      const f = items.length && VO.pick(items);
      if (f) {
        const label = { cooler: 'Minum', bookshelf: 'Baca docs', whiteboard: 'Brainstorm', arcade: 'Main sebentar', printer: 'Print laporan' }[f.type];
        sim.act(rt.id, [A.goto({ x: f.x, y: f.y + 1 }, 'walking'), A.wait(VO.rand(2, 4), 'break', label), ...home], { ambient: true });
      }
    } else if (r < 0.7) {
      sim.say(rt.id, VO.pick(['Memproses...', 'Cek metrik', 'Menjalankan tes', 'Optimasi prompt']), 3, 'sparkles');
    }
  }
})();

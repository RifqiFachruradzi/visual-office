/* =========================================================================
 * scene3d.js — tampilan 3D sungguhan (three.js / WebGL) dari aset GLB:
 *   assets/office/office_empty.glb   → struktur gedung (lantai, mezanin, tangga, dinding, jendela)
 *   assets/office/boss_room.glb      → Ruang Boss
 *   assets/office/billiard_room.glb  → Ruang Biliar
 *   assets/office/swimming_pool.glb  → Kolam Renang
 *   assets/office_ai_expanded_v2.glb → cetakan perabot: meja kerja, kursi, meja direktur, meja rapat,
 *                                      layar, pantry, lounge, resepsionis, server, tanaman
 *   assets/cast/office_cast_lineup.glb → karakter (lengan & kaki dipose langsung)
 *
 * Kantor disusun ulang dari data (divisi, departemen, fasilitas) — 1 tile simulasi = 1 meter.
 * Kamera ortografis memakai proyeksi yang sama persis dengan render.js (yaw/pitch, R.cam),
 * sehingga label, balon chat, hit-test & Edit Layout di kanvas 2D tetap pas di atasnya.
 * Semua geometri statis digabung (vertex color) menjadi beberapa mesh saja agar ringan.
 *
 * Kualitas grafis (VO.scene3d.quality, disimpan per perangkat):
 *   2 = HD    — material PBR + cahaya lingkungan, bayangan lembut, ambient occlusion (GTAO), resolusi tinggi
 *   1 = Sedang — tanpa ambient occlusion
 *   0 = Hemat  — tanpa bayangan & AO, resolusi layar biasa
 * Bila frame terlalu lambat, kualitas diturunkan otomatis satu tingkat.
 * ========================================================================= */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const VO = (window.VO = window.VO || {});
const S3 = (VO.scene3d = { ready: false, failed: false, loading: false, dirty: true });
const U = 34; // px per meter — sama dengan U di render.js (1 tile = 1 m)
const UP = 2.4; // tinggi lantai atas (m)
const BASE = 'assets/';

let renderer = null, scene = null, camera = null, glCanvas = null, sun = null;
let staticGroup = null, rearMesh = null, leftMesh = null, signGroup = null;
let composer = null, aoPass = null;

const GFX_KEY = 'vo.gfx';
const readGfx = () => { try { const v = localStorage.getItem(GFX_KEY); return v == null ? 2 : Math.max(0, Math.min(2, Number(v) || 0)); } catch { return 2; } };
S3.quality = readGfx();
S3.setQuality = function (q, save = true) {
  S3.quality = Math.max(0, Math.min(2, q));
  if (save) { try { localStorage.setItem(GFX_KEY, String(S3.quality)); } catch { /* tanpa penyimpanan */ } }
  slow = 0; frames = 0;
  if (renderer) applyQuality();
};
let slow = 0, frames = 0, lastT = 0;
const people = new Map(); // id -> instance karakter
let A = null; // prefab hasil ekstraksi

/* ------------------------------------------------------------ ekstraksi geometri */
// Satu "part" = segitiga non-indexed + warna material, dalam koordinat dunia GLB (meter)
function partOf(mesh) {
  mesh.updateWorldMatrix(true, false);
  let g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
  g.applyMatrix4(mesh.matrixWorld);
  if (!g.attributes.normal) g.computeVertexNormals();
  const c = (mesh.material && mesh.material.color) || new THREE.Color(1, 1, 1);
  const p = { pos: g.attributes.position.array, nor: g.attributes.normal.array, col: [c.r, c.g, c.b], name: mesh.name };
  const b = new THREE.Box3().setFromBufferAttribute(g.attributes.position);
  p.min = b.min; p.max = b.max; p.c = b.getCenter(new THREE.Vector3());
  return p;
}
function partsOf(root) {
  const out = [];
  root.traverse((o) => { if (o.isMesh) out.push(partOf(o)); });
  return out;
}
const near = (p, x, z, r) => Math.abs(p.c.x - x) <= r && Math.abs(p.c.z - z) <= r;

// Prefab: kumpulan part relatif terhadap titik asal (ox, oy, oz)
function prefab(parts, ox = 0, oy = 0, oz = 0) {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const out = parts.map((p) => {
    const pos = new Float32Array(p.pos.length);
    for (let i = 0; i < pos.length; i += 3) {
      pos[i] = p.pos[i] - ox; pos[i + 1] = p.pos[i + 1] - oy; pos[i + 2] = p.pos[i + 2] - oz;
      min.x = Math.min(min.x, pos[i]); min.y = Math.min(min.y, pos[i + 1]); min.z = Math.min(min.z, pos[i + 2]);
      max.x = Math.max(max.x, pos[i]); max.y = Math.max(max.y, pos[i + 1]); max.z = Math.max(max.z, pos[i + 2]);
    }
    return { pos, nor: p.nor, col: p.col, name: p.name };
  });
  return { parts: out, min, max };
}

/* ------------------------------------------------------------ penggabung geometri */
class Batch {
  constructor() { this.p = []; this.n = []; this.c = []; }
  // o: posisi (m) + skala + rotasi Y (rad); warna bisa diganti (tint)
  add(pf, o = {}) {
    const x = o.x || 0, y = o.y || 0, z = o.z || 0, sx = o.sx ?? 1, sy = o.sy ?? 1, sz = o.sz ?? 1;
    const cr = Math.cos(o.rot || 0), sr = Math.sin(o.rot || 0);
    for (const part of pf.parts) {
      if (o.skip && o.skip.test(part.name)) continue;
      const col = (o.recolor && o.recolor(part)) || part.col;
      const P = part.pos, N = part.nor;
      for (let i = 0; i < P.length; i += 3) {
        const px = P[i] * sx, py = P[i + 1] * sy, pz = P[i + 2] * sz;
        this.p.push(x + px * cr + pz * sr, y + py, z - px * sr + pz * cr);
        let nx = N[i] / sx, ny = N[i + 1] / sy, nz = N[i + 2] / sz;
        const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
        this.n.push(nx * cr + nz * sr, ny, -nx * sr + nz * cr);
        this.c.push(col[0], col[1], col[2]);
      }
    }
  }
  // Tempatkan prefab agar kotak batasnya pas di kotak tujuan (y1 = null → tinggi asli)
  fit(pf, x0, y0, z0, x1, y1, z1, o = {}) {
    const sx = (x1 - x0) / (pf.max.x - pf.min.x || 1), sz = (z1 - z0) / (pf.max.z - pf.min.z || 1);
    const sy = y1 == null ? 1 : (y1 - y0) / (pf.max.y - pf.min.y || 1);
    this.add(pf, { ...o, sx, sy, sz, x: x0 - pf.min.x * sx, y: y0 - pf.min.y * sy, z: z0 - pf.min.z * sz });
  }
  box(x0, y0, z0, x1, y1, z1, hex) {
    const c = new THREE.Color(hex);
    const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).toNonIndexed();
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    const P = g.attributes.position.array, N = g.attributes.normal.array;
    for (let i = 0; i < P.length; i++) { this.p.push(P[i]); this.n.push(N[i]); }
    for (let i = 0; i < P.length; i += 3) this.c.push(c.r, c.g, c.b);
  }
  mesh(mat) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    const m = new THREE.Mesh(g, mat);
    m.scale.setScalar(U);
    return m;
  }
}

/* ------------------------------------------------------------ muat aset */
async function load() {
  const L = new GLTFLoader();
  const get = (f) => L.loadAsync(BASE + f).then((g) => g.scene);
  const [empty, boss, billiard, pool, v2, cast] = await Promise.all([
    get('office/office_empty.glb'), get('office/boss_room.glb'), get('office/billiard_room.glb'),
    get('office/swimming_pool.glb'), get('office_ai_expanded_v2.glb'), get('cast/office_cast_lineup.glb'),
  ]);
  const E = partsOf(empty), V = partsOf(v2);
  const pick = (arr, re, f) => arr.filter((p) => re.test(p.name) && (!f || f(p)));
  const one = (arr, re) => pick(arr, re)[0];
  // kursi: semua bagian di sekitar dudukan tertentu
  const chairAt = (x, z) => {
    const seats = pick(V, /^chair_seat/).sort((a, b) => Math.hypot(a.c.x - x, a.c.z - z) - Math.hypot(b.c.x - x, b.c.z - z));
    const s = seats[0];
    return prefab(pick(V, /^chair_/, (p) => near(p, s.c.x, s.c.z, 0.42) && Math.abs(p.c.y - s.c.y) < 0.8), s.c.x, s.min.y - 0.42, s.c.z);
  };
  const plantAt = (arr, x, z, floor) => {
    const pl = pick(arr, /^planter/).sort((a, b) => Math.hypot(a.c.x - x, a.c.z - z) - Math.hypot(b.c.x - x, b.c.z - z))[0];
    return prefab(pick(arr, /^(planter|soil|plant_stem|voxel_leaf)/, (p) => near(p, pl.c.x, pl.c.z, 0.45)), pl.c.x, floor, pl.c.z);
  };
  const desktop = one(V, /^division_agent_01_desktop/);
  const ddesk = one(V, /^director_desk/);
  const mt = pick(V, /^meeting_table/).sort((a, b) => a.c.x - b.c.x)[0];
  const md = pick(V, /^meeting_display/).sort((a, b) => a.c.x - b.c.x)[0];
  const rc = one(V, /^reception_reception_counter/);
  const rug = one(V, /^lounge_lounge_rug/);
  const counter = one(V, /^pantry_kitchen_counter/);
  const rack = one(V, /^server_server_rack/);
  const part0 = pick(V, /^room_partition/).sort((a, b) => a.c.x - b.c.x)[0];
  const sofaB = one(V, /^lounge_sofa_base/);
  const stairs = pick(E, /^stair_/);
  const win0 = pick(E, /^rear_window/).sort((a, b) => a.c.x - b.c.x)[0];
  A = {
    E: {
      foundation: prefab([one(E, /^foundation/)]), lower: prefab([one(E, /^lower_floor/)]),
      tile: prefab([one(E, /^floor_tile/)]), upTile: prefab([one(E, /^upper_tile/)]),
      wingBase: prefab([one(E, /^raised_wing_base/)]), wingFloor: prefab([one(E, /^raised_wing_floor/)]),
      rearWall: prefab([one(E, /^rear_wall/)]), leftWall: prefab([one(E, /^left_wall/)]),
      rearWin: prefab(pick(E, /^(rear_window|window_frame)/, (p) => p.c.x >= win0.min.x - 0.1 && p.c.x <= win0.max.x + 0.1), win0.c.x, 0, 0),
      sideWin: prefab([one(E, /^side_window/)], 0, 0, one(E, /^side_window/).c.z),
      post: prefab([one(E, /^balcony_post/)], one(E, /^balcony_post/).c.x, 0, 0),
      rail: prefab([one(E, /^balcony_top/)]),
      stairs: prefab(stairs),
    },
    boss: prefab(partsOf(boss)), billiard: prefab(partsOf(billiard)), pool: prefab(partsOf(pool)),
    desk: prefab(pick(V, /^division_agent_01_/), desktop.c.x, 0, desktop.c.z),
    dirDesk: prefab(pick(V, /^(director_desk|director_pedestal|director_agent_01_)/), ddesk.c.x, UP, ddesk.c.z),
    chair: chairAt(-9.9, -9.5),
    mTable: prefab(pick(V, /^(meeting_table|meeting_pedestal|meeting_notebook)/, (p) => p.c.x >= mt.min.x - 0.05 && p.c.x <= mt.max.x + 0.05), mt.c.x, UP, mt.c.z),
    mDisplay: prefab(pick(V, /^meeting_(display|screen)/, (p) => p.c.x >= md.min.x - 0.05 && p.c.x <= md.max.x + 0.05), md.c.x, UP, md.min.z),
    partition: prefab(pick(V, /^(room_partition|glass_partition)/, (p) => Math.abs(p.c.x - part0.c.x) < 0.2), part0.c.x, UP, part0.c.z),
    pantry: prefab(pick(V, /^pantry_/, (p) => !/wall_shelf|shelf_folder/.test(p.name)), counter.c.x, 0, counter.c.z),
    lounge: prefab(pick(V, /^lounge_/), rug.c.x, 0, rug.c.z),
    sofa: prefab(pick(V, /^lounge_sofa/), sofaB.c.x, 0, sofaB.c.z),
    reception: prefab(pick(V, /^(reception_|sign_OFFICE|letter_OFFICE)/), rc.c.x, 0, rc.c.z),
    server: prefab(pick(V, /^server_/), rack.c.x, 0, rack.c.z),
    plant: plantAt(V, -12.8, -10.4, UP),
  };
  A.cast = buildCast(cast);
}

/* ------------------------------------------------------------ karakter */
const kindOf = (n) => {
  if (/left_(trouser|leg|shoe)/.test(n)) return 'legL';
  if (/right_(trouser|leg|shoe)/.test(n)) return 'legR';
  if (/left_(shoulder|sleeve|cuff|hand|thumb)/.test(n)) return 'armL';
  if (/right_(shoulder|sleeve|cuff|hand|thumb)/.test(n)) return 'armR';
  return 'body';
};
let charMat = null;
function buildCast(root) {
  const chars = new Map();
  for (const p of partsOf(root)) {
    const id = p.name.slice(0, 2);
    if (!/^\d\d$/.test(id)) continue;
    if (!chars.has(id)) chars.set(id, []);
    chars.get(id).push(p);
  }
  const out = {};
  for (const [id, parts] of chars) {
    let x0 = Infinity, x1 = -Infinity, top = 0;
    for (const p of parts) { x0 = Math.min(x0, p.min.x); x1 = Math.max(x1, p.max.x); top = Math.max(top, p.max.y); }
    const cx = (x0 + x1) / 2;
    const G = {};
    for (const p of parts) (G[kindOf(p.name)] = G[kindOf(p.name)] || []).push(p);
    const groups = {};
    let hip = 0.63;
    for (const [k, ps] of Object.entries(G)) {
      const b = new THREE.Box3();
      for (const p of ps) { b.expandByPoint(p.min); b.expandByPoint(p.max); }
      const piv = k === 'body' ? new THREE.Vector3(cx, 0, 0) : new THREE.Vector3((b.min.x + b.max.x) / 2, k.startsWith('leg') ? b.max.y : b.max.y - 0.06, (b.min.z + b.max.z) / 2);
      if (k.startsWith('leg')) hip = b.max.y;
      const bt = new Batch();
      bt.add(prefab(ps, piv.x, piv.y, piv.z));
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(bt.p, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(bt.n, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(bt.c, 3));
      groups[k] = { geo: g, piv: new THREE.Vector3(piv.x - cx, piv.y, piv.z) };
    }
    out[id] = { groups, hip, height: top };
  }
  return out;
}
function makePerson(castId, boss) {
  const t = A.cast[castId] || A.cast[Object.keys(A.cast)[0]];
  const root = new THREE.Group(), inner = new THREE.Group();
  root.add(inner);
  const G = {};
  for (const [k, g] of Object.entries(t.groups)) {
    const grp = new THREE.Group(); grp.position.copy(g.piv);
    const m = new THREE.Mesh(g.geo, charMat);
    m.castShadow = true; m.receiveShadow = true;
    grp.add(m);
    inner.add(grp); G[k] = grp;
  }
  if (boss) { // mahkota emas
    const b = new Batch(), y = t.height + 0.02, gold = '#ffca28';
    b.box(-0.17, y, -0.15, 0.17, y + 0.07, 0.15, gold);
    for (const [x, z] of [[-0.15, 0], [0, 0], [0.15, 0], [0, -0.13], [0, 0.13]]) b.box(x - 0.035, y + 0.07, z - 0.035, x + 0.035, y + 0.17, z + 0.035, gold);
    const m = b.mesh(charMat); m.scale.setScalar(1); m.castShadow = true; inner.add(m);
  }
  root.scale.setScalar(U);
  return { root, inner, G, hip: t.hip, castId };
}
const deg = Math.PI / 180;
function pose(P, p) {
  const G = P.G, R = (g, a) => { if (g) g.rotation.x = a; };
  P.inner.position.y = 0;
  for (const k of ['legL', 'legR', 'armL', 'armR']) if (G[k]) G[k].rotation.set(0, 0, 0);
  if (p.type === 'idle') { R(G.armL, 4 * deg); R(G.armR, 4 * deg); if (G.armL) G.armL.rotation.z = -5 * deg; if (G.armR) G.armR.rotation.z = 5 * deg; }
  else if (p.type === 'walk') {
    const s = p.s; R(G.legL, -28 * deg * s); R(G.legR, 28 * deg * s); R(G.armL, 24 * deg * s); R(G.armR, -24 * deg * s);
    P.inner.position.y = Math.abs(Math.cos(p.ph || 0)) * 0.03;
  } else if (p.type === 'sit' || p.type === 'type') {
    R(G.legL, -84 * deg); R(G.legR, -84 * deg);
    P.inner.position.y = -(P.hip - 0.5);
    if (p.type === 'type') { R(G.armL, (-62 + p.s * 7) * deg); R(G.armR, (-62 - p.s * 7) * deg); }
    else { R(G.armL, -24 * deg); R(G.armR, -24 * deg); }
  } else if (p.type === 'cheer') { R(G.armL, 165 * deg); R(G.armR, 165 * deg); }
}

/* ------------------------------------------------------------ papan nama (teks) */
function signMesh(text, color, w, h) {
  const px = 160, cv = document.createElement('canvas');
  cv.width = Math.max(64, Math.round(w * px)); cv.height = Math.round(h * px);
  const c = cv.getContext('2d');
  c.fillStyle = color; c.fillRect(0, 0, cv.width, cv.height);
  c.fillStyle = 'rgba(245,243,232,0.96)';
  let fs = Math.round(cv.height * 0.56);
  c.font = `bold ${fs}px "Courier New", ui-monospace, monospace`;
  while (c.measureText(text).width > cv.width * 0.9 && fs > 8) { fs -= 2; c.font = `bold ${fs}px "Courier New", ui-monospace, monospace`; }
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(text, cv.width / 2, cv.height / 2 + fs * 0.06);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 4;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 }));
  m.receiveShadow = true;
  return m;
}
// papan berdiri menghadap +Z (ke depan), bawah papan setinggi `lift` dari lantai
function addSign(b, text, color, cx, floorY, z, lift = 0.22, h = 0.62) {
  const w = Math.max(1.6, text.length * 0.27 + 0.7);
  b.box(cx - w / 2, floorY + lift, z - 0.08, cx + w / 2, floorY + lift + h, z, color);
  const m = signMesh(text, color, w - 0.08, h - 0.08);
  m.position.set(cx * U, (floorY + lift + h / 2) * U, (z + 0.006) * U);
  m.scale.setScalar(U);
  signGroup.add(m);
}

/* ------------------------------------------------------------ lantai zona + pembatas */
const BORDER = '#f5f3e8';
function zone(b, r, floorY, color, doors = [], hgt = 0.03) {
  const x0 = r.x + 0.05, x1 = r.x + r.w - 0.05, z0 = r.y + 0.05, z1 = r.y + r.h - 0.05;
  if (color) b.box(x0, floorY, z0, x1, floorY + hgt, z1, color);
  const y0 = floorY + 0.01, y1 = floorY + 0.19;
  // sisi depan/belakang dengan celah pintu 2 m
  const side = (z, gaps) => {
    let x = x0;
    for (const g of gaps.sort((a, b) => a - b)) {
      if (g - 1 > x) b.box(x, y0, z - 0.05, g - 1, y1, z + 0.05, BORDER);
      x = Math.max(x, g + 1);
    }
    if (x < x1) b.box(x, y0, z - 0.05, x1, y1, z + 0.05, BORDER);
  };
  side(z0, doors.filter((d) => d.y === r.y).map((d) => d.x + 0.5));
  side(z1, doors.filter((d) => d.y === r.y + r.h - 1).map((d) => d.x + 0.5));
  b.box(x0 - 0.05, y0, z0, x0 + 0.05, y1, z1, BORDER);
  b.box(x1 - 0.05, y0, z0, x1 + 0.05, y1, z1, BORDER);
}
const mixHex = (a, bb, t) => '#' + new THREE.Color(a).lerp(new THREE.Color(bb), t).getHexString();

/* ------------------------------------------------------------ bangun scene dari state */
S3.build = function (s) {
  if (!S3.ready) return;
  if (staticGroup) {
    scene.remove(staticGroup);
    staticGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material.map) { o.material.map.dispose(); o.material.dispose(); } });
  }
  staticGroup = new THREE.Group(); signGroup = new THREE.Group(); staticGroup.add(signGroup);
  const b = new Batch(), rear = new Batch(), left = new Batch();
  const W = s.map.w, H = s.map.h, E = A.E;
  const mz = VO.mezz(s), M = mz ? mz.M : 0;
  const elevOf = (r) => (mz && r.y + (r.h || 1) <= M ? UP : 0);

  // --- gedung (office_empty.glb, disesuaikan dengan ukuran denah)
  b.fit(E.foundation, -0.2, E.foundation.min.y, -0.2, W + 0.2, null, H + 0.2);
  b.fit(E.lower, 0, E.lower.min.y, 0, W, null, H);
  for (let j = M; j < H; j++) for (let i = 0; i < W; i++) if ((i + j) % 2 === 0) b.fit(E.tile, i + 0.01, E.tile.min.y, j + 0.01, i + 0.99, null, j + 0.99);
  const wallY = mz ? UP : 0;
  if (mz) {
    b.fit(E.wingBase, 0, 0, 0, W, UP - 0.02, M);
    b.fit(E.wingFloor, 0, UP - 0.05, 0, W, UP, M);
    // ruangan GLB punya lantai sendiri → ubin di bawahnya dilewati (hindari z-fighting)
    const own = s.facilities.filter((f) => ['boss', 'billiard', 'pool'].includes(f.type));
    const covered = (i, j) => own.some((f) => i >= f.x && i < f.x + f.w && j >= f.y && j < f.y + f.h);
    for (let j = 0; j < M; j++) for (let i = 0; i < W; i++) if ((i + j) % 2 === 0 && !covered(i, j)) b.fit(E.upTile, i + 0.01, UP, j + 0.01, i + 0.99, null, j + 0.99);
    // pagar balkon di tepi mezanin (sampai tangga)
    for (let x = 0.1; x < mz.sx - 0.1; x += 0.8) b.add(E.post, { x, y: 0, z: M - E.post.max.z });
    b.fit(E.rail, 0.05, E.rail.min.y, M - 0.05, mz.sx - 0.05, null, M + 0.02);
    // tangga: 2 tile (sx..sx+2), turun dari tepi mezanin (M) ke baris M+3
    b.fit(E.stairs, mz.sx - 0.03, 0, M, mz.sx + 2.03, null, M + 3);
  }
  rear.fit(E.rearWall, -0.1, wallY, -0.12, W + 0.1, wallY + (E.rearWall.max.y - E.rearWall.min.y), 0);
  const nWin = Math.max(1, Math.round(W / 5.6));
  for (let k = 0; k < nWin; k++) rear.add(E.rearWin, { x: (W * (k + 0.5)) / nWin, y: wallY - UP, z: 12 });
  // dinding kiri & kanan simetris (dinding kanan = cermin dinding kiri, ikut jendela samping)
  left.fit(E.leftWall, -0.11, 0, M, 0.01, null, H);
  b.fit(E.leftWall, W - 0.01, 0, M, W + 0.11, null, H);
  const lowD = H - M - 1, nSide = Math.max(1, Math.floor(lowD / 4.5));
  for (let k = 0; k < nSide; k++) {
    const z = M + 1 + (lowD * (k + 0.5)) / nSide;
    left.add(E.sideWin, { x: 14, z });
    b.add(E.sideWin, { x: W - 14, z, rot: Math.PI });
  }

  // --- fasilitas
  for (const f of s.facilities) {
    const fy = elevOf(f), cx = f.x + f.w / 2, cz = f.y + f.h / 2;
    const room = (pf, o) => {
      const isRear = /room_rear_wall|room_window|window_frame|director_dashboard|dashboard_chart/;
      b.add(pf, { ...o, skip: /room_left_wall|room_rear_wall|room_window|window_frame|director_dashboard|dashboard_chart/ });
      rear.add({ parts: pf.parts.filter((p) => isRear.test(p.name)) }, o);
      left.add({ parts: pf.parts.filter((p) => /room_left_wall/.test(p.name)) }, o);
    };
    if (f.type === 'boss') {
      const seat = VO.bossSeat(s);
      room(A.boss, { x: seat.chair.x + 0.5, y: fy + 0.015, z: seat.chair.y + 0.5 + 1.5 });
    } else if (f.type === 'billiard') room(A.billiard, { x: cx, y: fy + 0.015, z: cz, sx: f.w / 9, sz: f.h / 7 });
    // dek kolam dinaikkan sedikit agar air (di bawah permukaan dek) tidak tertutup lantai gedung
    else if (f.type === 'pool') b.add(A.pool, { x: cx, y: fy + 0.26, z: f.y + (f.h - 1) / 2 + 0.5, sx: f.w / 12, sz: (f.h - 1) / 10 });
    else if (f.type === 'meeting') {
      zone(b, f, fy, '#dce2e3', VO.doorTiles(f, f));
      const t = VO.meetingTable(f);
      b.add(A.mTable, { x: t.x + t.w / 2, y: fy, z: t.y + t.h / 2, sx: (t.w + 0.5) / 4.8, sz: (t.h + 0.45) / 1.6 });
      for (let x = t.x; x < t.x + t.w; x++) {
        b.add(A.chair, { x: x + 0.5, y: fy, z: t.y - 0.35 });
        b.add(A.chair, { x: x + 0.5, y: fy, z: t.y + t.h + 0.35, rot: Math.PI });
      }
      for (let y = t.y; y < t.y + t.h; y++) {
        b.add(A.chair, { x: t.x - 0.4, y: fy, z: y + 0.5, rot: Math.PI / 2 });
        b.add(A.chair, { x: t.x + t.w + 0.4, y: fy, z: y + 0.5, rot: -Math.PI / 2 });
      }
      rear.add(A.mDisplay, { x: cx, y: fy, z: f.y + (f.y === 0 ? 0.04 : 0.15) });
      b.fit(A.partition, f.x + 0.0, fy, f.y + 0.4, f.x + 0.1, null, f.y + f.h - 0.6);
    } else if (f.type === 'pantry') {
      zone(b, f, fy, '#e5e9e8', VO.doorTiles(f, f));
      b.add(A.pantry, { x: cx, y: fy, z: f.y + 1.5 });
    } else if (f.type === 'lounge') {
      zone(b, f, fy, '#e5e9e8', VO.doorTiles(f, f));
      b.add(A.lounge, { x: cx, y: fy, z: cz - 0.2 });
    }
    const signCol = { boss: '#508c62', meeting: '#6a8e92', pantry: '#b69264', lounge: '#6a8e92', pool: '#40b8ac', billiard: '#508c62' }[f.type] || '#6a8e92';
    addSign(b, f.name.toUpperCase(), signCol, cx, fy, f.y + f.h - 0.05, 0.3);
  }

  // --- divisi & departemen
  for (const div of s.divisions) {
    const z = div.zone;
    zone(b, z, 0, '#e5e9e8', VO.doorTiles(z, { type: 'zone' }));
    addSign(b, div.name.toUpperCase(), mixHex(div.color, '#43515b', 0.15), z.x + z.w / 2, 0, z.y + 0.12);
    // meja direktur (meja eksekutif dari office_ai_expanded_v2), kursi di belakang menghadap tim
    const dd = div.directorDesk;
    if (dd) {
      b.add(A.dirDesk, { x: dd.x + 0.5, y: 0, z: dd.y + 0.5 });
      b.add(A.chair, { x: dd.x + 0.5, y: 0, z: dd.y - 0.5 });
    }
  }
  for (const d of s.departments) {
    const div = s.divisions.find((x) => x.id === d.divisionId);
    const col = div ? div.color : '#6ca1dd';
    const r = d.room;
    b.box(r.x + 0.15, 0.03, r.y + 0.15, r.x + r.w - 0.15, 0.04, r.y + r.h - 0.15, mixHex(col, '#e5e9e8', 0.72));
    const n = VO.deptAgents(s, d.id).length;
    addSign(b, `${d.name.toUpperCase()} · ${n}`, col, r.x + r.w / 2, 0, r.y + 0.35, 0.05, 0.42);
    VO.deskSlots(r).slice(0, Math.max(n, 0)).forEach((sl) => {
      b.add(A.desk, { x: sl.desk.x + 0.5, y: 0, z: sl.desk.y + 0.5 });
      b.add(A.chair, { x: sl.chair.x + 0.5, y: 0, z: sl.chair.y + 0.5, rot: Math.PI });
    });
  }

  // --- depan: resepsionis "OFFICE AI" + tanaman
  const fr = VO.studioFront(s);
  if (fr) {
    b.add(A.reception, { x: fr.desk.x + fr.desk.w / 2, y: 0, z: H - 0.78 });
    for (const p of fr.plants) b.add(A.plant, { x: p.x + 0.5, y: 0, z: p.y + 0.5 });
  }

  // --- perabot bebas
  for (const f of s.furniture) {
    const y = mz && f.y < M ? UP : 0, x = f.x + 0.5, z = f.y + 0.5;
    if (f.type === 'plant') b.add(A.plant, { x, y, z });
    else if (f.type === 'server') b.add(A.server, { x, y, z });
    else if (f.type === 'sofa') b.add(A.sofa, { x, y, z, sx: 0.32, sz: 0.9 });
    else if (f.type === 'bookshelf') {
      b.box(x - 0.45, y, z - 0.2, x + 0.45, y + 1.8, z + 0.2, '#d2af7e');
      for (let k = 0; k < 3; k++) for (let i = 0; i < 5; i++) b.box(x - 0.38 + i * 0.16, y + 0.12 + k * 0.58, z + 0.05, x - 0.27 + i * 0.16, y + 0.5 + k * 0.58, z + 0.21, ['#40b8ac', '#6ca1dd', '#e2ba53', '#d774a3', '#f5f3e8'][(i + k) % 5]);
    } else if (f.type === 'whiteboard') {
      b.box(x - 0.6, y, z - 0.05, x + 0.6, y + 1.7, z + 0.05, '#535e66');
      b.box(x - 0.55, y + 0.8, z + 0.05, x + 0.55, y + 1.65, z + 0.08, '#f5f3e8');
    } else if (f.type === 'cooler') {
      b.box(x - 0.18, y, z - 0.18, x + 0.18, y + 1.0, z + 0.18, '#f5f3e8');
      b.box(x - 0.14, y + 1.0, z - 0.14, x + 0.14, y + 1.38, z + 0.14, '#b0d9e5');
    } else if (f.type === 'printer') {
      b.box(x - 0.3, y, z - 0.25, x + 0.3, y + 0.75, z + 0.25, '#535e66');
      b.box(x - 0.3, y + 0.75, z - 0.25, x + 0.3, y + 0.95, z + 0.25, '#f5f3e8');
    } else if (f.type === 'arcade') {
      b.box(x - 0.32, y, z - 0.3, x + 0.32, y + 1.7, z + 0.3, '#344654');
      b.box(x - 0.26, y + 1.05, z + 0.3, x + 0.26, y + 1.5, z + 0.32, '#40b8ac');
    } else if (f.type === 'lamp') {
      b.box(x - 0.15, y, z - 0.15, x + 0.15, y + 0.05, z + 0.15, '#535e66');
      b.box(x - 0.025, y, z - 0.025, x + 0.025, y + 1.5, z + 0.025, '#535e66');
      b.box(x - 0.2, y + 1.45, z - 0.2, x + 0.2, y + 1.75, z + 0.2, '#e2ba53');
    }
  }

  const main = b.mesh(S3.mat);
  rearMesh = rear.mesh(S3.mat); leftMesh = left.mesh(S3.mat);
  for (const m of [main, rearMesh, leftMesh]) { m.castShadow = true; m.receiveShadow = true; }
  staticGroup.add(main, rearMesh, leftMesh);
  scene.add(staticGroup);
  // matahari: frustum bayangan pas menutupi seluruh denah
  const cx = (W / 2) * U, cz = (H / 2) * U, rad = (Math.hypot(W, H) / 2 + 2) * U;
  sun.target.position.set(cx, 0, cz);
  sun.position.set(cx + SUN.x * rad * 2, SUN.y * rad * 2, cz + SUN.z * rad * 2);
  const sc = sun.shadow.camera;
  sc.left = -rad; sc.right = rad; sc.top = rad; sc.bottom = -rad; sc.near = rad * 0.5; sc.far = rad * 4;
  sc.updateProjectionMatrix();
  sun.shadow.needsUpdate = true;
  S3.radius = rad;
  S3.dirty = false;
};

/* ------------------------------------------------------------ frame */
// v: { geo, CYA, SYA, SP, CP, cam, w, h, dpr }, list: [{ id, cast, boss, x, y, z (px), rot, pose }]
S3.render = function (v, list) {
  if (!S3.ready) return;
  const cw = v.w, ch = v.h;
  const pr = pixelRatio(v.dpr, cw, ch);
  if (glCanvas.width !== Math.round(cw * pr) || glCanvas.height !== Math.round(ch * pr)) {
    renderer.setPixelRatio(pr); renderer.setSize(cw, ch, false);
    if (composer) { composer.setPixelRatio(pr); composer.setSize(cw, ch); }
  }
  // kamera: basis r (kanan), u (atas), back (ke arah penonton) — identik dengan proj() di render.js
  const c = v.CYA, sn = v.SYA, SP = v.SP, CP = v.CP;
  const r = new THREE.Vector3(c, 0, -sn), u = new THREE.Vector3(-sn * SP, CP, -c * SP), back = new THREE.Vector3(sn * CP, SP, c * CP);
  const D = 30000;
  camera.position.set(v.geo.CXW + back.x * D, back.y * D, v.geo.CYW + back.z * D);
  camera.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(r, u, back));
  const z = v.cam.zoom;
  camera.left = v.cam.x - v.geo.OX; camera.right = v.cam.x + cw / z - v.geo.OX;
  camera.top = v.geo.OY - v.cam.y; camera.bottom = v.geo.OY - v.cam.y - ch / z;
  const rad = S3.radius || 3000;
  camera.near = D - rad * 1.5; camera.far = D + rad * 1.5;
  camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  // dinding yang menghalangi pandangan disembunyikan (seperti rumah boneka)
  if (rearMesh) rearMesh.visible = back.z > -0.05;
  if (leftMesh) leftMesh.visible = back.x > -0.05;
  // karakter
  const seen = new Set();
  for (const it of list) {
    seen.add(it.id);
    let P = people.get(it.id);
    if (!P || P.castId !== it.cast || P.boss !== it.boss) {
      if (P) scene.remove(P.root);
      P = makePerson(it.cast, it.boss); P.boss = it.boss; P.castId = it.cast;
      people.set(it.id, P); scene.add(P.root);
    }
    P.root.position.set(it.x, it.y, it.z);
    P.root.rotation.y = it.rot;
    pose(P, it.pose);
  }
  for (const [id, P] of people) if (!seen.has(id)) { scene.remove(P.root); people.delete(id); }
  if (S3.quality >= 2 && composer) composer.render();
  else renderer.render(scene, camera);
  adapt();
};

/* ------------------------------------------------------------ kualitas */
const SUN = new THREE.Vector3(-0.7, 0.8, -0.45).normalize(); // dari kiri-belakang → bayangan jatuh ke arah penonton
function pixelRatio(dpr, w, h) {
  if (S3.quality === 0) return Math.min(dpr, 1.25);
  // HD: supersampling ringan di layar biasa, dibatasi ± 4 juta piksel
  const want = S3.quality >= 2 ? Math.max(dpr, 1.5) : dpr;
  return Math.max(1, Math.min(want, 2, Math.sqrt(4.2e6 / Math.max(1, w * h))));
}
function applyQuality() {
  const q = S3.quality;
  renderer.shadowMap.enabled = q >= 1;
  sun.castShadow = q >= 1;
  S3.mat.needsUpdate = true; charMat.needsUpdate = true;
  scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  if (q >= 2 && !composer) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    aoPass = new GTAOPass(scene, camera, glCanvas.clientWidth || 800, glCanvas.clientHeight || 600);
    aoPass.updateGtaoMaterial({ radius: 0.55 * U, distanceExponent: 1.4, thickness: 1.2 * U, scale: 1.1, samples: 16, distanceFallOff: 1 });
    aoPass.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
    aoPass.blendIntensity = 0.85;
    composer.addPass(aoPass);
    composer.addPass(new OutputPass());
  }
  glCanvas.width = 0; // paksa ukur ulang resolusi pada frame berikutnya
}
// turunkan kualitas otomatis bila rata-rata frame > 40 ms selama ± 2 detik
function adapt() {
  const now = performance.now(), dt = now - lastT;
  lastT = now;
  if (dt > 200 || document.hidden || S3.autoAdapt === false) return; // tab tidak aktif / jeda
  frames++;
  slow = slow * 0.95 + (dt > 40 ? 1 : 0) * 0.05;
  if (frames > 120 && slow > 0.6 && S3.quality > 0) {
    S3.setQuality(S3.quality - 1, false);
    console.info('Grafis 3D diturunkan otomatis ke tingkat', S3.quality);
    if (VO.ui && VO.ui.toast) VO.ui.toast('Grafis 3D diturunkan agar tetap lancar', 'layers');
  }
}
S3.show = function (on) { if (glCanvas) glCanvas.style.visibility = on ? 'visible' : 'hidden'; };

/* ------------------------------------------------------------ init */
S3.init = async function (canvas2d) {
  if (S3.loading || S3.ready) return;
  S3.loading = true;
  try {
    glCanvas = document.createElement('canvas');
    glCanvas.className = 'office3d';
    canvas2d.parentNode.insertBefore(glCanvas, canvas2d);
    renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0x000000, 0);
    scene = new THREE.Scene();
    // cahaya lingkungan (pantulan lembut seperti studio foto) + langit/lantai + matahari berbayang
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromScene(new RoomEnvironment(renderer), 0.04).texture;
    pm.dispose();
    scene.add(new THREE.HemisphereLight(0xf4f8ff, 0x6d6255, 0.7));
    sun = new THREE.DirectionalLight(0xfff1dc, 2.3);
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.6; sun.shadow.radius = 3;
    scene.add(sun, sun.target);
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1000);
    S3.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0, envMapIntensity: 0.1 });
    charMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0, envMapIntensity: 0.25 });
    applyQuality();
    await load();
    S3.ready = true; S3.dirty = true;
  } catch (e) {
    console.error('Tampilan 3D gagal dimuat:', e);
    S3.failed = true;
    if (glCanvas) glCanvas.remove();
  } finally { S3.loading = false; }
};

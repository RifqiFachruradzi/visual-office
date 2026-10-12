/* =========================================================================
 * officeops.js — ubah struktur kantor (divisi / departemen / karyawan) di server,
 * dipakai bot Telegram saat kantor sedang tidak dibuka di browser.
 * Logikanya memakai js/model.js yang sama dengan aplikasi (dimuat dalam sandbox vm),
 * sehingga hasilnya identik dengan menambah lewat tombol di aplikasi.
 * ========================================================================= */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let VO = null;
function model() {
  if (VO) return VO;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = [path.join(here, '..', 'js', 'model.js'), path.join(process.cwd(), 'js', 'model.js')].find((f) => fs.existsSync(f));
  if (!file) throw new Error('js/model.js tidak ditemukan di server');
  const ctx = { window: {}, console, localStorage: { getItem: () => null, setItem() {} } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: 'model.js' });
  VO = ctx.window.VO;
  return VO;
}

/** Terapkan op ke objek kantor (JSON dari Upstash). → { ok, text, office } */
export function applyOfficeOp(office, op) {
  const M = model();
  // kerjakan pada salinan; hasil dikembalikan sebagai objek JSON biasa
  const s = JSON.parse(JSON.stringify(office));
  if (!Array.isArray(s.docs)) s.docs = [];
  const r = M.applyOp(s, op);
  return { ...r, office: JSON.parse(JSON.stringify(s)) };
}

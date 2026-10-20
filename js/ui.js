/* =========================================================================
 * ui.js — panel samping: pohon organisasi, inspector, daftar tugas, log,
 * dan dialog form generik.
 * ========================================================================= */
(function () {
  const VO = window.VO;
  const $ = (id) => document.getElementById(id);
  const esc = VO.esc;
  const ui = (VO.ui = {});
  const S = () => VO.app.state;

  /* ------------------------------------------------------------ toast & dialog */
  let toastT;
  ui.toast = function (msg, icon = 'info') {
    const t = $('toast');
    t.innerHTML = VO.icon(icon) + ' ' + esc(msg);
    t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('show'), 2200);
  };

  /** fields: [{key,label,type,value,options,placeholder}] → Promise<object|null> */
  ui.form = function (title, fields, okLabel = 'Simpan') {
    const dlg = $('dlg');
    $('dlgTitle').textContent = title;
    $('dlgOk').textContent = okLabel;
    $('dlgBody').innerHTML = fields.map((f) => {
      const id = 'f_' + f.key;
      if (f.type === 'select')
        return `<div class="field"><label for="${id}">${esc(f.label)}</label><select id="${id}">${f.options.map((o) => `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>`;
      if (f.type === 'textarea')
        return `<div class="field"><label for="${id}">${esc(f.label)}</label><textarea id="${id}" rows="4" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea></div>`;
      if (f.type === 'colors')
        return `<div class="field"><label>${esc(f.label)}</label><div class="colors">${f.value.map((c, i) => `<label title="${esc(f.names[i])}"><input type="color" id="${id}_${i}" value="${esc(c)}"/></label>`).join('')}</div></div>`;
      if (f.type === 'checkbox')
        return `<div class="field inline"><input type="checkbox" id="${id}" ${f.value ? 'checked' : ''}/><label for="${id}">${esc(f.label)}</label></div>`;
      return `<div class="field"><label for="${id}">${esc(f.label)}</label><input type="text" id="${id}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''}/></div>`;
    }).join('');
    dlg.returnValue = '';
    dlg.showModal();
    const first = dlg.querySelector('input,select,textarea');
    if (first) first.focus();
    return new Promise((resolve) => {
      dlg.addEventListener('close', function h() {
        dlg.removeEventListener('close', h);
        if (dlg.returnValue !== 'ok') return resolve(null);
        const out = {};
        for (const f of fields) {
          const id = 'f_' + f.key;
          if (f.type === 'colors') out[f.key] = f.value.map((_, i) => $(id + '_' + i).value);
          else if (f.type === 'checkbox') out[f.key] = $(id).checked;
          else out[f.key] = $(id).value.trim();
        }
        resolve(out);
      });
    });
  };

  ui.confirm = async function (msg) {
    return (await ui.form(msg, [], 'Ya, lanjutkan')) !== null;
  };

  /* ------------------------------------------------------------ aksi CRUD */
  const app = () => VO.app;

  ui.addDivision = async function () {
    const v = await ui.form('Tambah Divisi', [
      { key: 'template', label: 'Template', type: 'select', value: 'blank', options: [
        { value: 'blank', label: 'Kosong (atur sendiri)' },
        { value: 'minimarket', label: 'Minimarket — terhubung ke aplikasi MiniMarket (3 departemen, 7 karyawan siap pakai)' },
      ] },
      { key: 'name', label: 'Nama divisi (kosongkan untuk nama template)', value: '', placeholder: 'mis. Riset & Pengembangan' },
      { key: 'director', label: 'Jabatan direktur (kosongkan bila tanpa direktur)', value: 'Direktur' },
      { key: 'color', label: 'Warna', type: 'colors', value: [VO.PALETTE[S().divisions.length % VO.PALETTE.length]], names: ['Warna divisi'] },
    ]);
    if (!v) return;
    const T = v.template === 'minimarket' ? VO.minimarket.TEMPLATE : null;
    if (!v.name && !T) return ui.toast('Nama divisi wajib diisi', 'alert');
    const s = S();
    const name = v.name || T.name;
    const dirRole = !v.director ? null : T && v.director === 'Direktur' ? T.director.role : v.director;
    const div = VO.addDivision(s, { name, color: T && v.color[0] === VO.PALETTE[(s.divisions.length) % VO.PALETTE.length] ? T.color : v.color[0], directorRole: dirRole, directorPrompt: T && dirRole ? T.director.prompt : undefined, integration: T ? 'minimarket' : undefined });
    const w = T ? T.departments.length * 10 + 1 : 14;
    const mz = VO.mezz(s);
    const spot = app().findFreeRect(w, 11, mz ? mz.M + 3 : 2); // tema Studio: divisi di lantai 1 (di bawah mezanin)
    VO.setZone(s, div, { x: spot.x, y: spot.y, w, h: 11 }, false);
    VO.placeDirector(s, div);
    if (T) {
      T.departments.forEach((td, i) => {
        const dept = VO.addDepartment(s, div.id, { name: td.name });
        dept.room = { x: spot.x + 1 + i * 10, y: spot.y + 4, w: 9, h: 6 };
        for (const r of td.roles) VO.addAgent(s, dept.id, { ...r });
      });
      app().fitZone(div);
    }
    VO.log(s, `Divisi baru: ${div.name}${T ? ' — terhubung ke MiniMarket' : ''}`, T ? 'inbox' : 'layers');
    app().layoutChanged();
    app().select({ kind: 'division', id: div.id });
  };

  // template departemen siap pakai: { name, roles, integration }
  function deptTemplates() {
    const list = [{ value: 'gudang', label: 'Gudang — terhubung ke Gudang-Document', tpl: { ...VO.gudang.TEMPLATE, integration: 'gudang' } }];
    VO.minimarket.TEMPLATE.departments.forEach((d, i) => list.push({ value: 'minimarket:' + i, label: `Minimarket · ${d.name} — terhubung ke MiniMarket`, tpl: { ...d, integration: 'minimarket' } }));
    return list.map((x) => ({ ...x, label: `${x.label} (${x.tpl.roles.length} karyawan siap pakai)` }));
  }

  ui.addDept = async function (divisionId) {
    const s = S();
    const tpls = deptTemplates();
    const v = await ui.form('Tambah Departemen', [
      { key: 'template', label: 'Template', type: 'select', value: 'blank', options: [{ value: 'blank', label: 'Kosong (atur sendiri)' }, ...tpls.map(({ value, label }) => ({ value, label }))] },
      { key: 'name', label: 'Nama departemen (kosongkan untuk nama template)', value: '', placeholder: 'mis. Customer Support / Gudang' },
      { key: 'divisionId', label: 'Divisi', type: 'select', value: divisionId, options: s.divisions.map((d) => ({ value: d.id, label: d.name })) },
      { key: 'lead', label: 'Jabatan ketua tim (template Kosong)', value: 'Team Lead' },
      { key: 'count', label: 'Jumlah anggota awal selain ketua (template Kosong)', value: '2' },
    ]);
    if (!v) return;
    const T = tpls.find((x) => x.value === v.template)?.tpl || null;
    if (!v.name && !T) return ui.toast('Nama departemen wajib diisi', 'alert');
    const div = s.divisions.find((d) => d.id === v.divisionId);
    // integrasi yang sama dengan divisinya cukup diwarisi dari divisi
    const integration = T && T.integration !== div.integration ? T.integration : undefined;
    const dept = VO.addDepartment(s, v.divisionId, { name: v.name || (T ? T.name : ''), integration });
    // taruh di kanan departemen terakhir dalam zona
    const sibs = s.departments.filter((d) => d.divisionId === v.divisionId && d !== dept);
    const rx = sibs.length ? Math.max(...sibs.map((d) => d.room.x + d.room.w)) + 1 : div.zone.x + 1;
    dept.room = { x: rx, y: div.zone.y + 4, w: 9, h: 6 };
    let n;
    if (T) {
      for (const r of T.roles) VO.addAgent(s, dept.id, { ...r });
      n = T.roles.length - 1;
    } else {
      VO.addAgent(s, dept.id, { role: v.lead || 'Team Lead', isLead: true });
      n = VO.clamp(parseInt(v.count, 10) || 0, 0, 20);
      for (let i = 0; i < n; i++) VO.addAgent(s, dept.id, { role: 'Staff' });
    }
    app().fitZone(div);
    const m = VO.integ.forDept(s, dept);
    VO.log(s, `Departemen baru: ${dept.name} (${n + 1} agen)${m ? ' — terhubung ke ' + m.label : ''}`, m ? m.icon : 'building');
    app().layoutChanged();
    app().select({ kind: 'dept', id: dept.id });
  };

  ui.addAgent = async function (deptId) {
    const s = S();
    const v = await agentForm('Rekrut Agen Baru', VO.makeAgent({ deptId, role: 'Staff' }), true);
    if (!v) return;
    const a = VO.addAgent(s, deptId, v);
    const dept = s.departments.find((d) => d.id === deptId);
    app().fitZone(s.divisions.find((d) => d.id === dept.divisionId));
    VO.log(s, `${a.name} bergabung sebagai ${a.role} di ${dept.name}`, 'user');
    app().layoutChanged();
    app().select({ kind: 'agent', id: a.id });
  };

  // Kolom penampilan karakter (gaya Habbo)
  function lookFields(a) {
    VO.ensureLook(a);
    return [
      { key: 'cast', label: 'Karakter 3D', type: 'select', value: a.cast || '', options: [{ value: '', label: 'Otomatis (sesuai gaya pakaian)' }, ...(VO.CAST_LIST || []).map(([value, label]) => ({ value, label: value + ' · ' + label }))] },
      { key: 'style', label: 'Gaya pakaian', type: 'select', value: a.style, options: Object.entries(VO.STYLES).map(([value, label]) => ({ value, label })) },
      { key: 'hairStyle', label: 'Model rambut', type: 'select', value: String(a.hairStyle), options: VO.HAIR_STYLES.map((label, i) => ({ value: String(i), label })) },
      { key: 'colors', label: 'Warna (atasan · celana/rok · dasi · rambut · kulit)', type: 'colors', value: [a.top, a.pants, a.tie, a.hair, a.skin], names: ['Atasan', 'Celana / rok', 'Dasi', 'Rambut', 'Kulit'] },
      { key: 'glasses', label: 'Pakai kacamata', type: 'checkbox', value: !!a.glasses },
      { key: 'mustache', label: 'Berkumis', type: 'checkbox', value: !!a.mustache },
    ];
  }
  function lookValues(v) {
    const [top, pants, tie, hair, skin] = v.colors;
    return { cast: v.cast || '', style: v.style, hairStyle: parseInt(v.hairStyle, 10) || 0, top, topV2: true, shirt: top, pants, tie, hair, skin, glasses: v.glasses, mustache: v.mustache };
  }

  async function agentForm(title, a, isNew) {
    const s = S();
    if (a.id === 'boss') {
      // Boss = kamu: tidak ada model / prompt AI. Nama mengikuti akun login bila ada.
      const bf = lookFields(a);
      if (!VO.app.user) bf.unshift({ key: 'name', label: 'Nama kamu', value: a.name, required: true });
      const v = await ui.form('Profil Boss (kamu)', bf);
      if (!v) return null;
      return { name: v.name || a.name, ...lookValues(v) };
    }
    const fields = [
      { key: 'name', label: 'Nama', value: a.name, required: true },
      { key: 'role', label: 'Jabatan / peran', value: a.role },
      { key: 'model', label: 'Model AI', type: 'select', value: a.model, options: VO.MODELS.map((m) => ({ value: m.id, label: m.label })) },
      { key: 'prompt', label: 'Instruksi / kepribadian (system prompt)', type: 'textarea', value: a.prompt, placeholder: 'mis. Kamu ahli SEO yang teliti dan suka data.' },
      ...lookFields(a),
    ];
    if (a.id !== 'boss' && !a.isDirector && !a.live) {
      fields.push({ key: 'deptId', label: 'Departemen', type: 'select', value: a.deptId, options: s.departments.map((d) => ({ value: d.id, label: (s.divisions.find((x) => x.id === d.divisionId)?.name || '') + ' › ' + d.name })) });
      fields.push({ key: 'isLead', label: 'Jadikan ketua tim (lead)', type: 'checkbox', value: a.isLead });
    }
    const v = await ui.form(title, fields, isNew ? 'Rekrut' : 'Simpan');
    if (!v || !v.name) return null;
    const out = { name: v.name, role: v.role || 'Staff', model: v.model, prompt: v.prompt, ...lookValues(v) };
    if ('deptId' in v) { out.deptId = v.deptId; out.isLead = v.isLead; }
    return out;
  }

  ui.editEntity = async function (id) {
    const s = S();
    const a = VO.findEntity(s, id);
    if (!a) return;
    const v = await agentForm('Edit ' + a.name, a, false);
    if (!v) return;
    const oldDept = a.deptId;
    Object.assign(a, v);
    if (v.deptId && v.deptId !== oldDept) {
      a.divisionId = s.departments.find((d) => d.id === v.deptId)?.divisionId;
      const dept = s.departments.find((d) => d.id === v.deptId);
      VO.ensureRoomCapacity(s, dept);
      app().fitZone(s.divisions.find((d) => d.id === dept.divisionId));
      VO.log(s, `${a.name} pindah ke ${dept.name}`, 'users');
    }
    if (v.isLead) s.agents.filter((x) => x.deptId === a.deptId && x !== a).forEach((x) => (x.isLead = false));
    app().layoutChanged();
  };

  ui.editDivision = async function (id) {
    const s = S();
    const div = s.divisions.find((d) => d.id === id);
    const dir = VO.director(s, id);
    const v = await ui.form('Edit Divisi', [
      { key: 'name', label: 'Nama divisi', value: div.name, required: true },
      { key: 'color', label: 'Warna', type: 'colors', value: [div.color], names: ['Warna'] },
      { key: 'hasDir', label: 'Punya direktur divisi', type: 'checkbox', value: !!dir },
      { key: 'dirPos', label: 'Posisi meja direktur (atasan)', type: 'select', value: div.dirPos || (VO.openPlan(s) ? 'center' : 'left'), options: [{ value: 'left', label: 'Kiri' }, { value: 'center', label: 'Tengah' }, { value: 'right', label: 'Kanan' }] },
      { key: 'integration', label: 'Integrasi data (dibaca semua departemen & direktur divisi ini)', type: 'select', value: div.integration || '', options: VO.integ.options() },
      { key: 'city', label: 'Kota untuk data Cuaca (berlaku untuk seluruh kantor)', value: s.settings.city || 'Jakarta' },
    ]);
    if (!v) return;
    div.name = v.name || div.name;
    div.color = v.color[0];
    if (v.integration) div.integration = v.integration; else delete div.integration;
    if (v.city) s.settings.city = v.city;
    if (v.dirPos !== (div.dirPos || '')) { div.dirPos = v.dirPos; VO.placeDirector(s, div); }
    if (v.hasDir && !dir) s.agents.push(VO.makeAgent({ divisionId: id, isDirector: true, role: 'Direktur ' + div.name, shirt: '#2d3142' }));
    if (!v.hasDir && dir) VO.removeAgent(s, dir.id);
    app().layoutChanged();
  };

  ui.editDept = async function (id) {
    const s = S();
    const d = s.departments.find((x) => x.id === id);
    const v = await ui.form('Edit Departemen', [
      { key: 'name', label: 'Nama departemen', value: d.name, required: true },
      { key: 'divisionId', label: 'Divisi', type: 'select', value: d.divisionId, options: s.divisions.map((x) => ({ value: x.id, label: x.name })) },
      { key: 'integration', label: 'Integrasi data', type: 'select', value: d.integration || '', options: [{ value: '', label: 'Ikut divisi / tidak ada' }, ...VO.integ.options().slice(1)] },
      { key: 'city', label: 'Kota untuk data Cuaca (berlaku untuk seluruh kantor)', value: s.settings.city || 'Jakarta' },
    ]);
    if (!v) return;
    d.name = v.name || d.name;
    if (v.integration) d.integration = v.integration; else delete d.integration;
    if (v.city) s.settings.city = v.city;
    if (v.divisionId !== d.divisionId) {
      d.divisionId = v.divisionId;
      s.agents.filter((a) => a.deptId === d.id).forEach((a) => (a.divisionId = v.divisionId));
      VO.log(s, `Departemen ${d.name} pindah ke divisi ${s.divisions.find((x) => x.id === v.divisionId).name} (klik Tata Otomatis untuk merapikan)`, 'layers');
    }
    app().layoutChanged();
  };

  ui.editFacility = async function (id) {
    const f = S().facilities.find((x) => x.id === id);
    const v = await ui.form('Edit Ruangan', [
      { key: 'name', label: 'Nama ruangan', value: f.name, required: true },
      { key: 'color', label: 'Warna', type: 'colors', value: [f.color], names: ['Warna'] },
    ]);
    if (!v) return;
    f.name = v.name || f.name;
    f.color = v.color[0];
    app().layoutChanged();
  };

  ui.remove = async function (kind, id) {
    const s = S();
    const names = {
      division: () => 'divisi ' + s.divisions.find((d) => d.id === id).name + ' beserta semua departemen & agennya',
      dept: () => 'departemen ' + s.departments.find((d) => d.id === id).name + ' beserta semua agennya',
      agent: () => VO.findEntity(s, id).name,
      facility: () => s.facilities.find((f) => f.id === id).name,
    };
    if (!(await ui.confirm('Hapus ' + names[kind]() + '?'))) return;
    if (kind === 'division') VO.removeDivision(s, id);
    if (kind === 'dept') VO.removeDepartment(s, id);
    if (kind === 'agent') { const a = VO.findEntity(s, id); VO.removeAgent(s, id); VO.log(s, `${a.name} keluar dari perusahaan`, 'wave'); }
    if (kind === 'facility') s.facilities = s.facilities.filter((f) => f.id !== id);
    app().select(null);
    app().layoutChanged();
  };

  ui.makeLead = function (id) {
    const s = S();
    const a = VO.findEntity(s, id);
    s.agents.filter((x) => x.deptId === a.deptId).forEach((x) => (x.isLead = x === a));
    VO.log(s, `${a.name} sekarang ketua tim`, 'star');
    app().layoutChanged();
  };

  ui.assign = function (type, id) {
    const sel = $('taskTarget');
    sel.value = type + ':' + id;
    $('taskTitle').focus();
  };

  /* ------------------------------------------------------------ pohon organisasi */
  const acts = (btns) => `<span class="acts">${btns.map(([a, t, ic]) => `<button class="icon" data-act="${a}" title="${t}">${VO.icon(ic)}</button>`).join('')}</span>`;
  const ni = (name, cls = '') => `<span class="ni ${cls}">${VO.icon(name)}</span>`;

  // baris & tombol integrasi data di inspector
  ui._integTest = {};
  const integRow = (m, inherited) => m ? `<span>Integrasi</span><span class="integ">${VO.icon(m.icon)} ${esc(m.label)} (hanya baca${inherited ? ', dari divisi' : ''})<br/><small>${esc(ui._integTest[m.key] || 'Klik "Tes koneksi" untuk memeriksa')}</small></span>` : '';
  const integBtn = (m) => m ? `<button class="small" data-i="integTest" data-key="${m.key}">${VO.icon('activity')} Tes koneksi</button>` : '';

  ui.renderTree = function () {
    const s = S();
    const sel = VO.app.sel;
    const isSel = (k, id) => sel && sel.kind === k && sel.id === id ? 'sel' : '';
    const busy = (id) => (VO.sim.isBusy(id) ? '<span class="badge busy">sibuk</span>' : '');
    let h = `<div class="node boss ${isSel('agent', 'boss')}" data-kind="agent" data-id="boss">${ni('crown')}<span class="name">${esc(s.boss.name)} <span class="sub">· ${esc(s.boss.role)}</span></span>${acts([['edit', 'Edit', 'edit']])}</div>`;
    for (const div of s.divisions) {
      const depts = s.departments.filter((d) => d.divisionId === div.id);
      h += `<div class="node div ${isSel('division', div.id)}" data-kind="division" data-id="${div.id}"><span class="dot" style="background:${esc(div.color)}"></span><span class="name">${esc(div.name)}</span>${div.integration ? `<span class="ni" title="Terhubung ke ${esc(VO.integ.forDivision(s, div)?.label || div.integration)}">${VO.icon(VO.integ.forDivision(s, div)?.icon || 'server')}</span>` : ''}${acts([['addDept', 'Tambah departemen', 'plus'], ['assign', 'Beri tugas', 'task'], ['edit', 'Edit', 'edit'], ['del', 'Hapus', 'trash']])}</div>`;
      const dir = VO.director(s, div.id);
      if (dir) h += `<div class="node director ${isSel('agent', dir.id)}" data-kind="agent" data-id="${dir.id}">${ni('briefcase', 'director')}<span class="name">${esc(dir.name)} <span class="sub">· ${esc(dir.role)}</span></span>${busy(dir.id)}${acts([['edit', 'Edit', 'edit'], ['del', 'Hapus', 'trash']])}</div>`;
      for (const d of depts) {
        const ag = VO.deptAgents(s, d.id);
        h += `<div class="node dept ${isSel('dept', d.id)}" data-kind="dept" data-id="${d.id}">${ni(VO.integ.forDept(s, d)?.icon || 'building')}<span class="name">${esc(d.name)}</span><span class="badge">${ag.length}</span>${acts([['addAgent', 'Rekrut agen', 'plus'], ['assign', 'Beri tugas', 'task'], ['edit', 'Edit', 'edit'], ['del', 'Hapus', 'trash']])}</div>`;
        for (const a of ag)
          h += `<div class="node agent ${isSel('agent', a.id)}" data-kind="agent" data-id="${a.id}">${a.live ? ni('live', 'live') : a.isLead ? ni('star', 'lead') : ni('bot')}<span class="name">${esc(a.name)} <span class="sub">· ${esc(a.role)}</span></span>${busy(a.id)}${acts([['assign', 'Beri tugas', 'task'], ['edit', 'Edit', 'edit'], ['del', 'Hapus', 'trash']])}</div>`;
        // tombol yang selalu terlihat (tidak hanya saat hover)
        h += `<div class="node add agent-add" data-kind="dept" data-id="${d.id}"><button class="link" data-act="addAgent">${VO.icon('plus')} Rekrut karyawan</button></div>`;
      }
      h += `<div class="node add dept-add" data-kind="division" data-id="${div.id}"><button class="link" data-act="addDept">${VO.icon('plus')} ${depts.length ? 'Tambah departemen' : 'Tambah departemen (wajib sebelum merekrut karyawan)'}</button></div>`;
    }
    if (!s.divisions.length) h += `<p class="empty">Belum ada divisi. Klik <b>Divisi</b> di atas untuk mulai membangun kantor.</p>`;
    h += `<div class="node" style="margin-top:10px;color:var(--muted)" data-kind="none">${ni('door')}<span class="name">Fasilitas</span></div>`;
    for (const f of s.facilities)
      h += `<div class="node dept ${isSel('facility', f.id)}" data-kind="facility" data-id="${f.id}"><span class="dot" style="background:${esc(f.color)}"></span><span class="name">${esc(f.name)}</span>${acts(f.type === 'boss' ? [['edit', 'Edit', 'edit']] : [['edit', 'Edit', 'edit'], ['del', 'Hapus', 'trash']])}</div>`;
    const tree = $('orgTree');
    if (tree._html !== h) { tree.innerHTML = h; tree._html = h; }

    const nAg = s.agents.length;
    const nBusy = s.agents.filter((a) => VO.sim.isBusy(a.id)).length;
    $('stats').innerHTML = `<span>${VO.icon('layers')} ${s.divisions.length} divisi</span><span>${VO.icon('building')} ${s.departments.length} dept</span><span>${VO.icon('bot')} ${nAg} agen</span><span>${VO.icon('zap')} ${nBusy} sibuk</span>`;
  };

  ui.bindTree = function () {
    $('orgTree').addEventListener('click', (e) => {
      const node = e.target.closest('.node');
      if (!node || node.dataset.kind === 'none') return;
      const { kind, id } = node.dataset;
      const btn = e.target.closest('button[data-act]');
      if (!btn) { VO.app.select({ kind, id }, true); return; }
      const act = btn.dataset.act;
      if (act === 'edit') ({ agent: ui.editEntity, division: ui.editDivision, dept: ui.editDept, facility: ui.editFacility })[kind](id);
      if (act === 'del') ui.remove(kind, id);
      if (act === 'addDept') ui.addDept(id);
      if (act === 'addAgent') ui.addAgent(id);
      if (act === 'assign') ui.assign(kind === 'division' ? 'division' : kind === 'dept' ? 'dept' : 'agent', id);
    });
  };

  /* ------------------------------------------------------------ inspector */
  const STATUS_TXT = { idle: 'Santai di meja', walking: 'Berjalan', working: 'Bekerja', coffee: 'Ngopi', meeting: 'Rapat', briefing: 'Menerima briefing', reporting: 'Melapor', chat: 'Ngobrol', break: 'Istirahat' };

  ui.renderInspector = function () {
    const s = S();
    const sel = VO.app.sel;
    const el = $('inspector');
    let h = '';
    if (!sel) {
      h = `<h3>${VO.icon('search')} Inspector</h3><p class="empty">Klik karyawan, ruangan, atau item di struktur organisasi untuk melihat detail.<br/><br/><b>Kamu (Boss)</b> memberi perintah → <b>Direktur</b> → <b>Ketua tim</b> → <b>Anggota</b>. Setiap level briefing, bekerja, lalu melapor balik.</p>`;
    } else if (sel.kind === 'agent') {
      const a = VO.findEntity(s, sel.id);
      if (!a) return VO.app.select(null);
      const rt = VO.sim.rt.get(a.id);
      const dept = s.departments.find((d) => d.id === a.deptId);
      const div = s.divisions.find((d) => d.id === a.divisionId);
      const model = VO.MODELS.find((m) => m.id === a.model)?.label || a.model;
      const running = s.tasks.flatMap((t) => t.subtasks.filter((st) => st.agentId === a.id && st.status === 'working').map((st) => t.title));
      const icon = a.id === 'boss' ? 'crown' : a.isDirector ? 'briefcase' : a.isLead ? 'star' : a.live ? 'live' : 'bot';
      h = `<div class="insp-head"><div class="avatar portrait"><img src="${VO.render.portrait(a)}" alt="" /></div><div><div class="insp-name">${esc(a.name)}</div><div class="insp-role">${esc(a.role)}</div></div></div>
        <div class="kv">
          <span>Status</span><span>${esc(rt?.liveTool && rt.liveTool !== 'thinking' ? 'Pakai tool: ' + rt.liveTool : STATUS_TXT[rt?.status] || rt?.status || '-')}</span>
          ${a.id !== 'boss' ? `<span>Model</span><span>${esc(model)}</span>` : `<span>Peran</span><span>Kamu — pemberi perintah</span>`}
          ${div ? `<span>Divisi</span><span>${esc(div.name)}</span>` : ''}
          ${dept ? `<span>Departemen</span><span>${esc(dept.name)}</span>` : ''}
          ${running.length ? `<span>Mengerjakan</span><span>${running.map(esc).join('<br/>')}</span>` : ''}
          ${a.prompt ? `<span>Instruksi</span><span>${esc(a.prompt)}</span>` : ''}
        </div>
        ${a.memory && a.memory.length ? `<div class="memory"><b>${VO.icon('brain')} Ingatan (${a.memory.length})</b>${a.memory.map((m) => `<div class="m">${esc(m.text)}</div>`).join('')}</div>` : ''}
        <div class="btns">
          <button class="small" data-i="edit">${VO.icon('edit')} Edit</button>
          ${a.id !== 'boss' ? `<button class="small primary" data-i="chat">${VO.icon('chat')} Chat</button>` : ''}
          ${a.id !== 'boss' ? `<button class="small" data-i="assign">${VO.icon('task')} Beri tugas</button>` : ''}
          ${a.deptId && !a.isLead && !a.live ? `<button class="small" data-i="lead">${VO.icon('star')} Jadikan lead</button>` : ''}
          ${a.memory && a.memory.length ? `<button class="small" data-i="forget">${VO.icon('eraser')} Lupakan</button>` : ''}
          ${a.id !== 'boss' ? `<button class="small danger" data-i="del">${VO.icon('trash')} Hapus</button>` : ''}
        </div>`;
    } else if (sel.kind === 'dept') {
      const d = s.departments.find((x) => x.id === sel.id);
      if (!d) return VO.app.select(null);
      const ag = VO.deptAgents(s, d.id);
      const div = s.divisions.find((x) => x.id === d.divisionId);
      h = `<div class="insp-head"><div class="avatar" style="background:${esc(div?.color || '#555')}">${VO.icon('building')}</div><div><div class="insp-name">${esc(d.name)}</div><div class="insp-role">Departemen · ${esc(div?.name || '-')}</div></div></div>
        <div class="kv"><span>Ketua</span><span>${esc(ag[0]?.name || '-')}</span><span>Anggota</span><span>${ag.length} agen</span><span>Kapasitas</span><span>${VO.deskSlots(d.room).length} meja</span>
          ${integRow(VO.integ.forDept(s, d), !d.integration)}</div>
        <div class="btns">${integBtn(VO.integ.forDept(s, d))}<button class="small" data-i="addAgent">${VO.icon('plus')} Rekrut agen</button><button class="small" data-i="assign">${VO.icon('task')} Beri tugas</button><button class="small" data-i="edit">${VO.icon('edit')} Edit</button><button class="small danger" data-i="del">${VO.icon('trash')} Hapus</button></div>`;
    } else if (sel.kind === 'division') {
      const d = s.divisions.find((x) => x.id === sel.id);
      if (!d) return VO.app.select(null);
      const depts = s.departments.filter((x) => x.divisionId === d.id);
      const dir = VO.director(s, d.id);
      h = `<div class="insp-head"><div class="avatar" style="background:${esc(d.color)}">${VO.icon('layers')}</div><div><div class="insp-name">${esc(d.name)}</div><div class="insp-role">Divisi</div></div></div>
        <div class="kv"><span>Direktur</span><span>${esc(dir?.name || '— (tanpa direktur)')}</span><span>Departemen</span><span>${depts.map((x) => esc(x.name)).join(', ') || '-'}</span><span>Total agen</span><span>${s.agents.filter((a) => a.divisionId === d.id).length}</span>${integRow(VO.integ.forDivision(s, d))}</div>
        <div class="btns">${integBtn(VO.integ.forDivision(s, d))}<button class="small" data-i="addDept">${VO.icon('plus')} Departemen</button><button class="small" data-i="assign">${VO.icon('task')} Beri tugas</button><button class="small" data-i="edit">${VO.icon('edit')} Edit</button><button class="small danger" data-i="del">${VO.icon('trash')} Hapus</button></div>`;
    } else if (sel.kind === 'facility') {
      const f = s.facilities.find((x) => x.id === sel.id);
      if (!f) return VO.app.select(null);
      h = `<div class="insp-head"><div class="avatar" style="background:${esc(f.color)}">${VO.icon('door')}</div><div><div class="insp-name">${esc(f.name)}</div><div class="insp-role">${esc(VO.FACILITY_TYPES[f.type].label)} · ${f.w}×${f.h}</div></div></div>
        <div class="btns" style="margin-top:10px"><button class="small" data-i="edit">${VO.icon('edit')} Edit</button>${f.type !== 'boss' ? `<button class="small danger" data-i="del">${VO.icon('trash')} Hapus</button>` : ''}</div>`;
    }
    if (el._html !== h) { el.innerHTML = h; el._html = h; }
  };

  ui.bindInspector = function () {
    $('inspector').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      const sel = VO.app.sel;
      if (!b || !sel) return;
      const i = b.dataset.i;
      if (i === 'edit') ({ agent: ui.editEntity, division: ui.editDivision, dept: ui.editDept, facility: ui.editFacility })[sel.kind](sel.id);
      if (i === 'del') ui.remove(sel.kind, sel.id);
      if (i === 'lead') ui.makeLead(sel.id);
      if (i === 'chat') VO.chat.open(sel.id);
      if (i === 'forget') { const a = VO.findEntity(S(), sel.id); a.memory = []; VO.app.changed(); ui.toast('Ingatan ' + a.name + ' dihapus', 'eraser'); }
      if (i === 'addAgent') ui.addAgent(sel.id);
      if (i === 'integTest') {
        const m = VO.integ.get(b.dataset.key);
        ui._integTest[m.key] = `Menghubungi ${m.label}...`;
        m.test().then((t) => { ui._integTest[m.key] = 'Terhubung: ' + t; }, (e) => { ui._integTest[m.key] = 'Gagal: ' + e.message; });
      }
      if (i === 'addDept') ui.addDept(sel.id);
      if (i === 'assign') ui.assign(sel.kind, sel.id);
    });
  };

  /* ------------------------------------------------------------ tugas & log */
  ui.renderTargets = function () {
    const s = S();
    const sel = $('taskTarget');
    const cur = sel.value;
    let h = `<option value="all:">Seluruh kantor (rapat besar)</option>`;
    for (const div of s.divisions) {
      h += `<optgroup label="Divisi ${esc(div.name)}"><option value="division:${div.id}">Seluruh divisi ${esc(div.name)}</option>`;
      for (const d of s.departments.filter((x) => x.divisionId === div.id)) {
        h += `<option value="dept:${d.id}">› Tim ${esc(d.name)}</option>`;
        for (const a of VO.deptAgents(s, d.id)) h += `<option value="agent:${a.id}">   · ${esc(a.name)} (${esc(a.role)})</option>`;
      }
      h += `</optgroup>`;
    }
    if (sel._html !== h) {
      sel.innerHTML = h; sel._html = h;
      if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
    }
  };

  const ST_TXT = { briefing: 'briefing', meeting: 'rapat', in_progress: 'dikerjakan', done: 'selesai', failed: 'gagal' };
  const fmtTime = (t) => new Date(t).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  ui.renderTasks = function () {
    const s = S();
    const tl = $('taskList');
    let h = '';
    for (const t of s.tasks) {
      const n = t.subtasks.length;
      const p = t.status === 'done' ? 1 : n ? t.subtasks.reduce((a, b) => a + (b.progress || 0), 0) / n : 0.03;
      h += `<div class="task" data-id="${t.id}"><div class="t">${esc(t.title)}</div>
        <div class="meta"><span class="st ${t.status}">${ST_TXT[t.status] || t.status}</span><span>→ ${esc(VO.tasks.targetLabel(s, t.targetType, t.targetId))}</span><span>· ${n} subtugas</span>${t.ai ? `<span>· ${VO.icon('sparkles')} AI</span>` : ''}</div>
        <div class="bar"><i style="width:${Math.round(p * 100)}%"></i></div></div>`;
    }
    if (!h) h = `<p class="empty">Belum ada tugas. Tulis perintah di atas lalu klik <b>Kirim</b> — lihat bagaimana kantor bergerak!</p>`;
    if (tl._html !== h) { tl.innerHTML = h; tl._html = h; }

    const ll = $('logList');
    const lh = s.log.slice(0, 120).map((l) => `<div class="log"><time>${fmtTime(l.t)}</time>${VO.icon(l.icon || 'activity')}${esc(l.text)}</div>`).join('');
    if (ll._html !== lh) { ll.innerHTML = lh; ll._html = lh; }
  };

  /* ------------------------------------------------------------ gudang dokumen */
  const KIND = { report: 'laporan', work: 'hasil kerja', upload: 'unggahan' };

  ui.renderDocs = function () {
    const s = S();
    const q = ($('docSearch').value || '').toLowerCase().trim();
    const list = q ? s.docs.filter((d) => (d.title + ' ' + d.author + ' ' + d.content).toLowerCase().includes(q)) : s.docs;
    const size = (d) => (d.file ? '📎 ' + VO.files.fmtSize(d.file.size) : (d.content.length < 1000 ? d.content.length : Math.round(d.content.length / 100) / 10 + 'k') + ' karakter');
    let h = list.slice(0, 150).map((d) => `<div class="doc" data-id="${d.id}"><div class="t">${VO.icon(d.file ? VO.files.icon(d.file) : 'file')} ${esc(d.title)}</div>
      <div class="meta"><span class="kind ${d.kind}">${KIND[d.kind] || d.kind}</span><span>${esc(d.author)}</span><span>· ${fmtTime(d.t)}</span><span>· ${size(d)}</span></div></div>`).join('');
    if (!h) h = q ? `<p class="empty">Tidak ada dokumen cocok.</p>` : `<p class="empty">Gudang dokumen masih kosong. Laporan tugas yang selesai tersimpan di sini otomatis, dan kamu bisa <b>Unggah</b> file .txt/.md sebagai pengetahuan — agen akan membacanya bila relevan dengan tugas.</p>`;
    const el = $('docList');
    if (el._html !== h) { el.innerHTML = h; el._html = h; }
    $('docCount').textContent = s.docs.length;
  };

  ui.showDoc = function (id) {
    const d = S().docs.find((x) => x.id === id);
    if (!d) return;
    $('resultTitle').textContent = d.title;
    const f = d.file, fk = f && VO.files.kindOf(f.type, f.name);
    const preview = !f ? '' : fk === 'video' ? `<video src="${esc(f.url)}" controls playsinline class="gvideo"></video>`
      : fk === 'image' ? `<img src="${esc(f.url)}" alt="" class="gimg">` : fk === 'pdf' ? `<iframe src="${esc(f.url)}" class="gpdf" title="PDF"></iframe>` : '';
    const fileBtns = f ? `<button type="button" class="small primary" data-doc="file" data-id="${d.id}">${VO.icon('download')} Unduh ${esc(f.name)}</button><button type="button" class="small" data-doc="tgfile" data-id="${d.id}">${VO.icon('send')} Kirim ke Telegram</button>`
      : `<button type="button" class="small primary" data-doc="pdf" data-id="${d.id}">${VO.icon('download')} Unduh PDF</button><button type="button" class="small" data-doc="tgpdf" data-id="${d.id}">${VO.icon('send')} Kirim PDF ke Telegram</button><button type="button" class="small" data-doc="download" data-id="${d.id}">${VO.icon('file')} Unduh .md</button>`;
    $('resultBody').innerHTML = `<div style="color:var(--muted)">${KIND[d.kind] || d.kind} · ${esc(d.author)} · ${new Date(d.t).toLocaleString('id-ID')}${f ? ' · ' + VO.files.fmtSize(f.size) : ''}</div>
      ${f && f.localOnly ? '<div class="gwarn">File hanya ada di browser ini (penyimpanan cloud belum aktif).</div>' : ''}
      <div class="btns" style="margin:8px 0">${fileBtns}<button type="button" class="small danger" data-doc="delete" data-id="${d.id}">${VO.icon('trash')} Hapus</button></div>
      ${preview}<div>${ui.md(d.content)}</div>`;
    $('resultDlg').showModal();
  };

  ui.bindDocs = function () {
    $('docList').addEventListener('click', (e) => { const d = e.target.closest('.doc'); if (d) ui.showDoc(d.dataset.id); });
    $('docSearch').addEventListener('input', () => ui.renderDocs());
    $('docUpload').addEventListener('click', () => $('docFile').click());
    $('docFile').addEventListener('change', async (e) => {
      let n = 0;
      for (const f of e.target.files) {
        const textual = /^text\/|json|csv|markdown/.test(f.type) || /\.(txt|md|markdown|csv|json)$/i.test(f.name);
        try {
          if (textual && f.size <= 500_000) { // teks → jadi pengetahuan yang dibaca agen
            VO.addDoc(S(), { kind: 'upload', title: f.name, author: (S().boss.name || 'Boss') + ' (unggahan)', content: await f.text() });
          } else { // PDF, video, gambar, dll. → disimpan sebagai file (bisa dibuka & dikirim ke Telegram)
            ui.toast('Mengunggah ' + f.name + '…', 'upload');
            const file = await VO.files.upload(f, f.name);
            const d = VO.addDoc(S(), { kind: 'upload', title: f.name, author: (S().boss.name || 'Boss') + ' (unggahan)', content: '' });
            d.file = file;
          }
          n++;
        } catch (err) { ui.toast(f.name + ': ' + err.message, 'alert'); }
      }
      e.target.value = '';
      if (n) { VO.log(S(), `${n} dokumen diunggah ke Gudang Dokumen`, 'book'); VO.app.changed(); ui.renderDocs(); ui.toast(`${n} dokumen tersimpan`, 'book'); }
    });
    $('resultBody').addEventListener('click', (e) => {
      const tp = e.target.closest('[data-task-pdf]');
      if (tp) {
        const t = S().tasks.find((x) => x.id === tp.dataset.taskPdf);
        if (!t) return;
        const sections = [];
        if (t.result) sections.push({ heading: 'Laporan akhir', body: t.result });
        sections.push({ heading: 'Hasil per karyawan', body: t.subtasks.map((st) => `### ${st.agentName} (${st.role})\n${st.output || '-'}`).join('\n\n') });
        VO.pdf.download({ title: t.title, meta: `Target: ${VO.tasks.targetLabel(S(), t.targetType, t.targetId)} · Mode: ${t.ai ? 'AI' : 'Simulasi'} · ${new Date(t.created).toLocaleString('id-ID')}`, sections })
          .catch((err) => ui.toast('Gagal membuat PDF: ' + err.message, 'alert'));
        return;
      }
      const b = e.target.closest('[data-doc]');
      if (!b) return;
      const s = S();
      const d = s.docs.find((x) => x.id === b.dataset.id);
      if (!d) return;
      if (b.dataset.doc === 'pdf') {
        VO.pdf.download({ title: d.title, meta: `${KIND[d.kind] || d.kind} · ${d.author} · ${new Date(d.t).toLocaleString('id-ID')}`, sections: [{ body: d.content }] })
          .catch((err) => ui.toast('Gagal membuat PDF: ' + err.message, 'alert'));
      } else if (b.dataset.doc === 'download') {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([`# ${d.title}\n\n_${d.author} · ${new Date(d.t).toLocaleString('id-ID')}_\n\n${d.content}`], { type: 'text/markdown' }));
        a.download = d.title.replace(/[^\w\- ]+/g, '_').slice(0, 80) + '.md';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } else if (b.dataset.doc === 'file') {
        VO.files.download(d.file);
      } else if (b.dataset.doc === 'tgfile' || b.dataset.doc === 'tgpdf') {
        b.disabled = true;
        (async () => {
          let file = d.file;
          if (!file) { // laporan teks → PDF dulu
            const pdfB = await VO.pdf.build({ title: d.title, meta: `${KIND[d.kind] || d.kind} · ${d.author} · ${new Date(d.t).toLocaleString('id-ID')}`, sections: [{ body: d.content }] });
            file = await VO.files.upload(pdfB.blob, pdfB.name);
          }
          const n = await VO.files.sendTelegram(file, d.title);
          ui.toast(`Terkirim ke ${n} chat Telegram`, 'send');
        })().catch((err) => ui.toast('Telegram: ' + err.message, 'alert')).finally(() => { b.disabled = false; });
      } else {
        // file video tetap dipakai Galeri → hanya dihapus bila tidak ada video yang memakainya
        if (d.file && !(s.videos || []).some((v) => v.file && v.file.url === d.file.url)) VO.files.remove(d.file);
        s.docs = s.docs.filter((x) => x !== d);
        $('resultDlg').close();
        VO.app.changed(); ui.renderDocs();
      }
    });
  };

  // markdown mini: judul, tebal, miring, kode inline, bullet
  ui.md = function (text) {
    return esc(text || '')
      .replace(/^#{1,6} (.*)$/gm, '<b style="color:var(--accent)">$1</b>')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/(^|\W)_(.+?)_(?=\W|$)/g, '$1<i>$2</i>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/^[-*] /gm, '• ');
  };

  ui.showTask = function (id) {
    const s = S();
    const t = s.tasks.find((x) => x.id === id);
    if (!t) return;
    $('resultTitle').textContent = t.title;
    let h = `<div><b>Status:</b> ${ST_TXT[t.status] || t.status} · <b>Target:</b> ${esc(VO.tasks.targetLabel(s, t.targetType, t.targetId))} · <b>Mode:</b> ${t.ai ? 'AI (' + esc(VO.ai.label()) + ')' : 'Simulasi'}</div>`;
    if (t.note) h += `<div style="color:#ef9a9a">${esc(t.note)}</div>`;
    h += `<div class="btns" style="margin:8px 0"><button type="button" class="small primary" data-task-pdf="${t.id}">${VO.icon('download')} Unduh PDF</button></div>`;
    if (t.result) h += `<h4>${VO.icon('file')} Laporan akhir</h4><div>${ui.md(t.result)}</div>`;
    h += `<h4>${VO.icon('users')} Hasil per agen</h4>`;
    for (const st of t.subtasks) h += `<div class="sub"><b>${esc(st.agentName)}</b> <span style="color:var(--muted)">(${esc(st.role)}) · ${esc(st.status)} ${Math.round((st.progress || 0) * 100)}%</span>\n${st.refs && st.refs.length ? `<span style="color:var(--muted)">Referensi: ${st.refs.map(esc).join(', ')}</span>\n` : ''}${st.wait ? esc(st.wait) + '\n' : ''}${ui.md(st.output || '…')}</div>`;
    $('resultBody').innerHTML = h;
    $('resultDlg').showModal();
  };
})();

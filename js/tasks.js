/* =========================================================================
 * tasks.js — alur kerja hierarkis kantor:
 *   Boss → (rapat) → Direktur Divisi → Lead Departemen → Anggota tim
 * Setiap level: briefing ke atasan, kerja, lalu lapor balik ke atasan.
 * Mode simulasi: progres acak. Mode AI: setiap agent memanggil Gemini (atau Claude) lewat backend.
 * ========================================================================= */
(function () {
  const VO = window.VO;
  const sim = VO.sim;
  const A = sim.A;
  const S = () => VO.app.state;
  const changed = () => VO.app.changed();
  const short = (t, n = 38) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

  const tasks = (VO.tasks = {});

  tasks.create = function ({ title, targetType, targetId }) {
    const s = S();
    const task = {
      id: VO.uid('tk'), title, targetType, targetId, status: 'briefing',
      created: Date.now(), subtasks: [], result: '', note: '', ai: !!(s.settings.aiMode && VO.ai.available),
    };
    s.tasks.unshift(task);
    if (s.tasks.length > 60) s.tasks.length = 60;
    VO.log(s, `Boss memberi tugas: "${title}" → ${tasks.targetLabel(s, targetType, targetId)}`, 'send');
    sim.say('boss', short(title), 4, 'task');
    changed();
    run(task).then(
      (report) => {
        task.status = 'done';
        task.result = report || task.result;
        if (!task.ai) task.result = '> Ini hasil **simulasi** (tanpa AI). Aktifkan kotak **AI** di bar atas agar karyawan benar-benar mengerjakan tugas dengan Gemini.\n\n' + task.result;
        task.finished = Date.now();
        if (task.result) {
          VO.addDoc(S(), { kind: 'report', title: 'Laporan: ' + title, author: tasks.targetLabel(S(), targetType, targetId), taskId: task.id, content: task.result });
        }
        VO.log(S(), `Tugas selesai: "${title}" — laporan disimpan di Gudang Dokumen`, 'check');
        sim.say('boss', 'Mantap, tim!', 3, 'check');
        changed();
      },
      (err) => {
        task.status = 'failed';
        task.note = String(err && err.message ? err.message : err);
        VO.log(S(), `Tugas gagal: "${title}" — ${task.note}`, 'alert');
        changed();
      }
    );
    return task;
  };

  tasks.targetLabel = function (s, type, id) {
    if (type === 'all') return 'Seluruh kantor';
    if (type === 'division') return 'Divisi ' + (s.divisions.find((d) => d.id === id)?.name || '?');
    if (type === 'dept') return 'Dept. ' + (s.departments.find((d) => d.id === id)?.name || '?');
    const a = VO.findEntity(s, id);
    return a ? a.name : '?';
  };

  async function run(task) {
    const s = S();
    if (task.targetType === 'all') return runAll(task);
    if (task.targetType === 'division') {
      const div = s.divisions.find((d) => d.id === task.targetId);
      if (!div) throw new Error('Divisi tidak ditemukan');
      return runDivision(task, div, 'boss', false);
    }
    if (task.targetType === 'dept') {
      const dept = s.departments.find((d) => d.id === task.targetId);
      if (!dept) throw new Error('Departemen tidak ditemukan');
      return runDept(task, dept, 'boss', false);
    }
    const ag = VO.findEntity(s, task.targetId);
    if (!ag) throw new Error('Agen tidak ditemukan');
    await brief(ag, 'boss', task);
    task.status = 'in_progress'; changed();
    const out = await work(task, ag, `Tugas dari Boss: ${task.title}`);
    await reportTo(ag, 'boss');
    return out;
  }

  /* ------------------------------------------------------------ level-level */
  async function runAll(task) {
    const s = S();
    const leaders = [];
    for (const div of s.divisions) {
      const dir = VO.director(s, div.id);
      if (dir) leaders.push(dir);
      else s.departments.filter((d) => d.divisionId === div.id).forEach((d) => { const l = VO.deptLead(s, d.id); if (l) leaders.push(l); });
    }
    await meeting(task, leaders);
    task.status = 'in_progress'; changed();
    const reports = await Promise.all(
      s.divisions.map((div) => runDivision(task, div, 'boss', true).then((r) => `## Divisi ${div.name}\n${r}`))
    );
    // Boss adalah kamu: laporan semua divisi digabung untuk kamu baca (tanpa ringkasan AI)
    return reports.join('\n\n');
  }

  async function runDivision(task, div, superiorId, briefed) {
    const s = S();
    const dir = VO.director(s, div.id);
    const depts = s.departments.filter((d) => d.divisionId === div.id);
    if (!depts.length) return '_(divisi tanpa departemen)_';
    if (!dir) {
      const reps = await Promise.all(depts.map((d) => runDept(task, d, superiorId, briefed)));
      return reps.join('\n\n');
    }
    if (!briefed) await brief(dir, superiorId, task);
    task.status = 'in_progress'; changed();
    sim.say(dir.id, 'Tim ' + div.name + ', ada tugas!', 3, 'megaphone');
    const reps = await Promise.all(depts.map((d) => runDept(task, d, dir.id, false).then((r) => `### ${d.name}\n${r}`)));
    const integ = VO.integ.forDivision(s, div);
    const data = integ ? await integ.forTask(task) : null; // memakai cache tugas yang sama
    let out = await summarize(task, dir, reps, `Kamu direktur divisi ${div.name}. Gabungkan hasil semua departemen menjadi SATU dokumen final yang lengkap, rapi, dan siap dipakai untuk Boss (jangan hanya meringkas).${dataNote(integ, data)}`);
    if (data && !task.ai) out = integ.simReport(data, task.title);
    await reportTo(dir, superiorId);
    return out;
  }

  async function pullData(task, integ, ent, where) {
    sim.say(ent.id, `Menarik data ${integ.label}...`, 3, integ.icon);
    const d = await integ.forTask(task);
    if (d.error) { sim.say(ent.id, `Data ${integ.label} gagal diambil`, 3, 'alert'); VO.log(S(), `Gagal membaca ${integ.label}: ${d.error}`, 'alert'); }
    else VO.log(S(), `${where} menarik data ${integ.label} (${integ.logText(d)})`, integ.icon);
    return d;
  }

  function dataNote(integ, d) {
    if (!integ || !d || d.error) return '';
    return ` Laporan ini berbasis data ${integ.label}: cantumkan sumber & waktu pengambilan data di awal, ${integ.leadNote}, periksa angka tim terhadap data berikut, dan jangan mengarang angka.\n\n=== DATA ${integ.label.toUpperCase()} ===\n${integ.toMarkdown(d)}\n=== AKHIR DATA ===`;
  }

  async function runDept(task, dept, superiorId, briefed) {
    const s = S();
    const members = VO.deptAgents(s, dept.id);
    if (!members.length) return '_(departemen kosong)_';
    const lead = members[0];
    if (!briefed) await brief(lead, superiorId, task);
    task.status = 'in_progress'; changed();
    // Departemen/divisi terintegrasi (Gudang-Document, MiniMarket, …): tarik data dulu (hanya baca)
    const integ = VO.integ.forDept(s, dept);
    const data = integ ? await pullData(task, integ, lead, dept.name) : null;
    if (members.length > 1) sim.say(lead.id, 'Ayo tim, kita bagi tugas!', 3, 'users');
    const roster = members.map((m) => `- ${m.name} (${m.role})`).join('\n');
    const outs = await Promise.all(
      members.map((m) =>
        work(task, m, `Tugas dari atasan: ${task.title}\n\nKamu anggota tim ${dept.name}. Anggota tim:\n${roster}\n\nKerjakan HANYA bagian yang sesuai jabatanmu (${m.role}).`)
          .then((o) => `**${m.name} (${m.role})**: ${o}`)
      )
    );
    const note = dataNote(integ, data);
    let out = members.length > 1
      ? await summarize(task, lead, outs, `Kamu ${lead.role} yang memimpin tim ${dept.name}. Gabungkan hasil kerja tim menjadi SATU dokumen final yang lengkap, rapi, dan siap dipakai (jangan hanya meringkas).${note}`)
      : outs[0];
    // tanpa AI: laporan dihitung langsung dari data integrasi
    if (data && !task.ai) out = integ.simReport(data, task.title);
    await reportTo(lead, superiorId);
    return out;
  }

  /* ------------------------------------------------------------ aksi dasar */
  function stillHere(ent) { return !!VO.findEntity(S(), ent.id); }

  async function brief(ent, superiorId, task) {
    const s = S();
    if (!stillHere(ent)) return;
    const vt = sim.visitorTile(s, superiorId);
    await sim.act(ent.id, [
      A.goto(vt, 'walking'),
      A.fn(() => sim.say(superiorId, short(task.title, 30), 3, 'task')),
      A.wait(2.4, 'briefing', VO.pick(['Siap laksanakan!', 'Siap, dimengerti!', 'Dicatat!'])),
      ...sim.homeActions(s, ent.id),
    ]);
  }

  async function reportTo(ent, superiorId) {
    const s = S();
    if (!stillHere(ent)) return;
    const vt = sim.visitorTile(s, superiorId);
    await sim.act(ent.id, [
      A.goto(vt, 'walking'),
      A.wait(2.2, 'reporting', 'Laporan sudah siap!'),
      A.fn(() => sim.say(superiorId, VO.pick(['Kerja bagus!', 'Diterima', 'Mantap!']), 2.5, 'check')),
      ...sim.homeActions(s, ent.id),
    ]);
  }

  async function meeting(task, people) {
    const s = S();
    const seats = sim.spots(s, 'meeting');
    if (!seats.length || !people.length) {
      for (const p of people) await brief(p, 'boss', task);
      return;
    }
    task.status = 'meeting'; changed();
    VO.log(s, `Rapat besar dimulai: "${task.title}"`, 'meeting');
    const all = [s.boss, ...people];
    await Promise.all(all.map((p, i) => sim.act(p.id, [A.goto(seats[i % seats.length], 'walking')])));
    sim.say('boss', 'Rapat: ' + short(task.title, 28), 4, 'megaphone');
    await Promise.all(all.map((p) => sim.act(p.id, [A.wait(4.5, 'meeting', p.id === 'boss' ? null : VO.pick(['Mencatat...', 'Noted', 'Siap, Bos'])) ])));
    all.forEach((p) => sim.act(p.id, sim.homeActions(S(), p.id)));
  }

  // Kerja di meja: simulasi atau panggilan AI (Gemini / Claude)
  function work(task, ent, prompt) {
    const s = S();
    const sub = { id: VO.uid('st'), agentId: ent.id, agentName: ent.name, role: ent.role, status: 'queued', progress: 0, output: '' };
    task.subtasks.push(sub);
    changed();
    const job = { progress: 0, done: false };
    if (task.ai) {
      job.start = () => {
        sub.status = 'working'; changed();
        const q = VO.ai.withDocs(S(), prompt, task.title + ' ' + ent.role, task.id);
        if (q.docs.length) { sub.refs = q.docs.map((d) => d.title); sim.say(ent.id, 'Membaca ' + q.docs.length + ' dokumen', 2.5, 'book'); }
        const integ = VO.integ.forEnt(S(), ent);
        if (integ) sub.refs = [...(sub.refs || []), 'Data ' + integ.label];
        (integ ? integ.augment(task, q.prompt) : Promise.resolve(q.prompt)).then((finalPrompt) => VO.ai.run(
          { system: VO.ai.systemPrompt(S(), ent), prompt: finalPrompt },
          (_, full) => {
            sub.output = full;
            job.progress = Math.min(0.95, 0.08 + full.length / 1800);
          },
          (w) => { sub.wait = w; if (w) sim.say(ent.id, w, 4); changed(); }
        ).then(
          (full) => {
            sub.output = full;
            const dept = S().departments.find((d) => d.id === ent.deptId);
            VO.addDoc(S(), { kind: 'work', title: `${task.title} — ${ent.role}`, author: ent.name, authorId: ent.id, deptId: dept?.id, taskId: task.id, content: full });
            finish('done');
          },
          (e) => { sub.output = 'Gagal: ' + e.message; finish('failed'); }
        ));
      };
      job.tick = (dt) => { if (job.progress < 0.08) job.progress += dt * 0.01; };
    } else {
      const dur = VO.rand(6, 14);
      job.start = () => { sub.status = 'working'; changed(); };
      job.tick = (dt) => {
        job.progress += dt / dur;
        if (job.progress >= 1 && !job.done) {
          sub.output = simulatedOutput(task, ent);
          finish('done');
        }
      };
    }
    function finish(st) {
      job.progress = 1; job.done = true;
      const r0 = sim.rt.get(ent.id);
      if (r0) { r0.activity = null; if (st === 'done') r0.happyUntil = performance.now() + 1400; } // selebrasi kecil
      if (st === 'done') VO.remember(VO.findEntity(S(), ent.id), `Tugas "${short(task.title, 60)}": ${String(sub.output).replace(/\s+/g, ' ').slice(0, 300)}`);
      sub.status = st; sub.progress = 1; changed();
      sim.say(ent.id, st === 'done' ? 'Bagianku beres!' : 'Ada kendala', 2.5, st === 'done' ? 'check' : 'alert');
    }
    const seat = VO.seatOf(s, ent);
    const acts = [];
    if (seat) acts.push(A.goto(seat.chair, 'walking'));
    acts.push(A.fn(() => {
      sim.say(ent.id, short(ent.role, 24), 2, 'monitor');
      const r = sim.rt.get(ent.id);
      if (r) r.activity = short(task.title, 26); // ditampilkan di chip aktivitas (tema Robot)
    }));
    acts.push(A.work(job));
    let lastPct = 0;
    const iv = setInterval(() => {
      sub.progress = job.progress;
      if (Math.abs(job.progress - lastPct) > 0.04) { lastPct = job.progress; changed(); }
    }, 400);
    return sim.act(ent.id, acts).then((ok) => {
      clearInterval(iv);
      if (!ok && !job.done) { sub.status = 'failed'; sub.output = sub.output || '(dibatalkan)'; changed(); }
      return sub.output;
    });
  }

  async function summarize(task, ent, parts, instruction) {
    const joined = parts.join('\n\n');
    if (!task.ai || !stillHere(ent)) return joined;
    sim.say(ent.id, 'Menyusun laporan...', 3, 'file');
    try {
      const out = await VO.ai.run(
        {
          system: VO.ai.systemPrompt(S(), ent, true),
          prompt: `${instruction}\n\nTugas dari Boss: ${task.title}\n\nHasil kerja anggota:\n${joined}\n\nTulis dokumen final dalam markdown: judul, bagian-bagian bernomor, poin-poin, dan tabel bila perlu. Jangan menyebut nama anggota tim di dalam dokumen kecuali relevan.`,
          long: true,
        },
        null,
        (w) => w && sim.say(ent.id, w, 4)
      );
      VO.remember(VO.findEntity(S(), ent.id), `Merangkum laporan "${short(task.title, 60)}": ${out.replace(/\s+/g, ' ').slice(0, 250)}`);
      return out;
    } catch (e) {
      return joined + `\n\n_(ringkasan gagal: ${e.message})_`;
    }
  }

  function simulatedOutput(task, ent) {
    const verbs = ['menganalisis', 'menyusun draf', 'mengimplementasikan', 'meninjau', 'mengoptimalkan', 'menguji'];
    return `${VO.pick(verbs)} aspek **${ent.role}** untuk "${short(task.title, 50)}" — selesai (simulasi).`;
  }

})();

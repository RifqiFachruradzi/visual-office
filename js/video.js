/* =========================================================================
 * video.js — PROGRAMMATIC VIDEO: video dibuat dari kode, bukan diedit manual.
 *
 *  1. Boss memberi tugas video ke divisi Sosmed (mis. "buat video penjelasan biaya listrik AI").
 *  2. Tim mengerjakan seperti tugas biasa (animasi kantor), lalu AI menyusun NASKAH TERSTRUKTUR
 *     (storyboard JSON): tiap adegan memakai satu TEMPLATE + isinya (judul, angka, poin).
 *  3. Render di SERVER VIDEO (Remotion di VPS): 5 paket visual, narasi suara + subtitle kata per kata,
 *     musik latar, foto/video stok (Pixabay / Pexels) — lihat remotion/ & lib/render.js.
 *     Bila worker VPS mati, render ditolak dengan pesan yang jelas (tidak ada lagi render cadangan di browser).
 *  4. Hasil masuk Galeri (+ jadwal tayang YouTube / TikTok / IG …) dan bisa dikirim ke Telegram.
 *
 * Naskah, template & paket visual: js/videoboard.js (dipakai juga oleh server & worker).
 * Format: 9:16 (TikTok/Reels/Shorts) atau 16:9 (YouTube).
 * ========================================================================= */
(function () {
  const VO = window.VO;
  const V = (VO.video = { busy: false, queue: [] });

  const B = VO.videoBoard; // naskah bersama (js/videoboard.js): template, gaya, paket visual, prompt AI
  V.TEMPLATES = B.TEMPLATES;
  V.STYLES = B.STYLES;
  V.PACKS = B.PACKS;
  V.isRequest = B.isRequest;

  /** Naskah terstruktur dari AI (bila Mode AI aktif). context = laporan tim (riset/naskah kasar). */
  V.storyboard = async function (o, context) {
    const s = VO.app.state;
    o = { brand: s.company.name || 'Visual Office', ...o };
    if (!(s.settings.aiMode && VO.ai.available)) return B.fallback(o);
    const { system, prompt } = B.prompt(o, context);
    try { return B.parse(await VO.ai.run({ system, prompt, long: true }), o); }
    catch (e) { return B.fallback(o); }
  };

  /* ------------------------------------------------------------ server video (Remotion di VPS) */
  // status worker: { configured, worker (aktif?), pexels, tts } — disimpan sebentar agar tidak dipanggil terus
  let engineCache = null;
  V.engine = async function (fresh) {
    if (!fresh && engineCache && Date.now() - engineCache.t < 20000) return engineCache.v;
    let v = { worker: false };
    try { const r = await fetch('/api/office?render=status', { cache: 'no-store' }); if (r.ok) v = await r.json(); } catch (e) { /* offline */ }
    engineCache = { t: Date.now(), v };
    return v;
  };
  async function renderOnServer(item, sb, o, who) {
    const assets = (item.assets || []).filter((x) => x && !x.localOnly).map((x) => ({ url: x.url, type: x.type }));
    const r = await fetch('/api/office?render=enqueue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sb, format: o.format, assets, telegram: o.telegram, itemId: item.id }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Antrean render: HTTP ' + r.status);
    item.jobId = j.id; item.engine = 'remotion'; VO.app.changed();
    const STAGE = { antre: 'antre', mulai: 'render', media: 'media', narasi: 'narasi', kode: 'kode', render: 'render', upload: 'upload' };
    let lastP = -1;
    for (;;) {
      await new Promise((res) => setTimeout(res, 3000));
      let job;
      try { const q = await fetch('/api/office?render=job&id=' + encodeURIComponent(j.id), { cache: 'no-store' }); job = await q.json(); if (!q.ok) throw new Error(job.error); }
      catch (e) { continue; } // jaringan putus sesaat
      if (job.status === 'failed') throw new Error(job.error || 'Render di server gagal');
      item.progress = job.progress || 0; item.stage = STAGE[job.stage] || 'render';
      const p = Math.round(item.progress * 100);
      if (job.status === 'rendering' && p >= lastP + 25) { lastP = p; VO.sim.say(who, `🎬 Server video: ${item.stage} ${p}%`, 3); }
      VO.app.changed();
      if (job.status === 'done') return job;
    }
  }

  /* ------------------------------------------------------------ alur kerja kantor */
  const CREATIVE = /sosmed|sosial|social|media|konten|content|marketing|pemasaran|kreatif|creative|iklan|brand|promosi/i;
  V.creativeDivision = (s, preferId) => s.divisions.find((d) => d.id === preferId) || s.divisions.find((d) => CREATIVE.test(d.name))
    || s.divisions.find((d) => s.departments.some((p) => p.divisionId === d.id && CREATIVE.test(p.name))) || null;
  const waitTask = (task) => new Promise((resolve) => { const iv = setInterval(() => { if (task.status === 'done' || task.status === 'failed') { clearInterval(iv); resolve(task); } }, 800); });

  /**
   * Buat video dari brief. o: { brief, style, format ('9:16'|'16:9'), duration, brand, cta, files: [File] (foto/video) atau image (Blob),
   *   divisionId, telegram: true|false|chatId, platforms:[…], schedule (ms) }  → item galeri
   */
  const enqueue = (fn) => new Promise((resolve, reject) => { V.queue.push({ fn, resolve, reject }); pump(); });
  /** Buat draf naskah (o.review === false → langsung dirender). → item galeri */
  V.create = (o) => enqueue(() => run(o));
  /** Render naskah item (setelah dicek / diedit Boss). */
  V.produce = (id) => { const it = (VO.app.state.videos || []).find((v) => v.id === id); return it ? enqueue(() => produce(it)) : Promise.reject(new Error('Video tidak ditemukan')); };
  V.pending = () => V.queue.length + (V.busy ? 1 : 0);
  async function pump() {
    if (V.busy || !V.queue.length) return;
    V.busy = true;
    const { fn, resolve, reject } = V.queue.shift();
    try { resolve(await fn()); } catch (e) { reject(e); } finally { V.busy = false; pump(); }
  }
  // Tahap 1 — DRAF: tim riset → AI menulis naskah → aset diunggah → status "Perlu dicek" (Boss mengedit di Galeri)
  async function run(o) {
    const s = VO.app.state;
    const div = V.creativeDivision(s, o.divisionId);
    const lead = div && (VO.director(s, div.id) || s.agents.find((a) => a.divisionId === div.id));
    const who = lead ? lead.id : 'boss';
    o.style = V.STYLES[o.style] ? o.style : B.guessStyle(o.brief);
    o.format = o.format === '16:9' ? '16:9' : '9:16';
    // aset Boss: banyak file (dialog) atau satu foto (Telegram) → o.files + ringkasan untuk naskah AI
    if (!Array.isArray(o.files) || !o.files.length) o.files = o.image ? [o.image] : [];
    o.files = o.files.slice(0, 8);
    o.assets = o.files.map((f, i) => ({ kind: /^video\//.test(f.type) ? 'video' : 'photo', name: String(f.name || `aset ${i + 1}`).slice(0, 40) }));
    const short = String(o.brief).replace(/^(tolong\s+)?(buat(kan)?|bikin(in|kan)?|siapkan|render|produksi)\s+(sebuah\s+)?video\s*/i, '').trim() || o.brief;
    const item = V.addItem(s, { title: (short.charAt(0).toUpperCase() + short.slice(1)).slice(0, 90), status: 'producing', format: o.format, style: o.style, divisionId: div ? div.id : null, brief: String(o.brief).slice(0, 2000), platforms: o.platforms || (o.format === '16:9' ? ['youtube'] : ['tiktok', 'instagram', 'youtube']), schedule: o.schedule || null, telegram: o.telegram == null || o.telegram === false ? null : o.telegram });
    try {
      // 1) tim mengerjakan riset & naskah kasar (alur kantor biasa)
      const task = VO.tasks.create({ title: `[Video] ${o.brief}`.slice(0, 300), targetType: div ? 'division' : 'all', targetId: div ? div.id : null });
      task.source = typeof o.telegram === 'number' || typeof o.telegram === 'string' ? 'telegram' : 'web';
      task.videoId = item.id; item.taskId = task.id;
      await waitTask(task);
      // 2) naskah terstruktur (AI)
      VO.sim.say(who, '🎬 Menyusun naskah per adegan…', 4); item.stage = 'naskah'; VO.app.changed();
      const sb = await V.storyboard(o, task.status === 'done' ? task.result : '');
      item.title = sb.title; item.storyboard = sb; item.caption = sb.caption;
      // 3) aset diunggah sekarang → draf tetap utuh walau halaman dimuat ulang
      item.assets = [];
      for (const [i, f] of o.files.entries()) {
        item.stage = 'upload'; VO.app.changed();
        const ext = (/\.(\w{2,5})$/.exec(f.name || '') || [, /video/.test(f.type) ? 'mp4' : 'jpg'])[1].toLowerCase();
        const up = await VO.files.upload(f, `aset-${i + 1}.${ext}`);
        item.assets.push({ url: up.url, type: /^video\//.test(f.type) ? 'video' : 'photo', name: o.assets[i].name, localOnly: !!up.localOnly });
      }
      item.stage = ''; item.progress = 0;
      if (o.review === false) return await produce(item);
      item.status = 'review';
      VO.sim.say(who, '🎬 Draf naskah siap — Boss, silakan dicek!', 5, 'check');
      VO.log(s, `Draf naskah video "${sb.title}" siap dicek di Galeri (${sb.scenes.length} adegan)`, 'file');
      VO.app.changed();
      return item;
    } catch (e) {
      item.status = 'failed'; item.stage = ''; item.error = String(e.message || e); VO.app.changed();
      throw e;
    }
  }

  // Tahap 2 — PRODUKSI: naskah (yang sudah dicek/diedit Boss) dirender Remotion → Galeri, dokumen, Telegram
  async function produce(item) {
    const s = VO.app.state;
    const div = s.divisions.find((d) => d.id === item.divisionId) || null;
    const lead = div && (VO.director(s, div.id) || s.agents.find((a) => a.divisionId === div.id));
    const who = lead ? lead.id : 'boss';
    const sb = item.storyboard;
    const o = { format: item.format, telegram: item.telegram };
    item.status = 'producing'; item.stage = 'render'; item.progress = 0; item.error = '';
    VO.app.changed();
    try {
      // render: server video (Remotion di VPS: narasi, subtitle, musik, foto stok)
      const eng = await V.engine(true);
      if (!eng.worker) throw new Error('Server video (VPS) sedang tidak aktif — nyalakan worker di VPS lalu klik Render lagi.');
      VO.sim.say(who, '🎬 Naskah dikirim ke server video…', 4);
      const job = await renderOnServer(item, sb, o, who);
      item.file = job.file; item.thumb = job.thumb; item.duration = job.duration; item.codec = 'h264';
      if (job.sb) { item.storyboard = job.sb; item.narrated = !!job.sb.narrated; }
      const sentByServer = o.telegram != null, size = job.file.size;
      const fin = item.storyboard || sb;
      item.pack = fin.pack; item.title = fin.title; item.caption = fin.caption;
      item.status = item.schedule ? 'scheduled' : 'draft'; item.stage = ''; item.progress = 1;
      const script = fin.scenes.map((x, i) => `${i + 1}. **${x.t}** (${x.sec} dtk) — ${x.title || x.text || x.label || ''}${x.items && x.items.map ? ' · ' + x.items.map((q) => (typeof q === 'string' ? q : `${q.label} ${q.value}`)).join(', ') : ''}${x.value != null && x.t === 'stat' ? ' · ' + x.value + ' ' + (x.unit || '') : ''}${x.customOk ? ' · ✨ animasi buatan AI' : ''}${x.narration ? `\n   _“${x.narration}”_` : ''}`).join('\n');
      if (item.docId) s.docs = s.docs.filter((d) => d.id !== item.docId); // render ulang → naskah lama diganti
      const doc = VO.addDoc(s, { kind: 'work', title: 'Video: ' + fin.title, author: div ? 'Divisi ' + div.name : 'Tim Kreatif', taskId: item.taskId || null, content: `## ${fin.title}\n\n**Caption:** ${fin.caption}\n\n### Naskah per adegan\n${script}` });
      doc.file = item.file; item.docId = doc.id;
      VO.sim.say(who, '🎬 Video siap — cek Galeri!', 4, 'check');
      VO.log(s, `Video "${fin.title}" selesai (${item.duration} dtk, ${VO.files.fmtSize(size)}, server video) — masuk Galeri`, 'check');
      VO.app.changed();
      if (o.telegram != null && !sentByServer) {
        try { await VO.files.sendTelegram(item.file, `🎬 ${fin.title}\n\n${fin.caption}`, o.telegram === true ? undefined : o.telegram); }
        catch (e) { VO.ui.toast('Telegram: ' + e.message, 'alert'); }
      }
      return item;
    } catch (e) {
      item.status = 'failed'; item.stage = ''; item.error = String(e.message || e); VO.app.changed();
      throw e;
    }
  }

  /* ------------------------------------------------------------ data galeri */
  V.addItem = function (s, o) {
    if (!Array.isArray(s.videos)) s.videos = [];
    const it = { id: VO.uid('vd'), created: Date.now(), title: 'Video', status: 'draft', platforms: [], schedule: null, ...o };
    s.videos.unshift(it);
    if (s.videos.length > 80) s.videos.length = 80;
    VO.app.changed();
    return it;
  };
})();

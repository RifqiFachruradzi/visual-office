/* =========================================================================
 * telegram.js (browser) — menerima perintah Boss dari bot Telegram.
 *   - Selama tab kantor terbuka & terlihat: ambil antrean perintah tiap 5 detik,
 *     jalankan lewat alur kerja kantor (Boss → Direktur → Lead → Anggota),
 *     lalu kirim laporan akhirnya kembali ke chat Telegram.
 *   - Perintah yang sudah dikerjakan server saat kantor tidak dibuka dimasukkan
 *     ke daftar tugas & Gudang Dokumen.
 *   - Dialog pengaturan: pasang webhook & hubungkan chat dengan kode sekali pakai.
 * ========================================================================= */
(function () {
  const VO = window.VO;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => VO.esc(s);
  const tg = (VO.telegram = { configured: null, watching: new Map() });

  async function api(method, body, query = '') {
    const r = await fetch('/api/telegram' + query, method === 'GET' ? { cache: 'no-store' } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    return j;
  }

  // tujuan perintah masih ada? (divisi/karyawan bisa sudah dihapus)
  function validTarget(s, t) {
    if (!t || t.type === 'all') return { type: 'all', id: null };
    const ok = t.type === 'division' ? s.divisions.some((d) => d.id === t.id)
      : t.type === 'dept' ? s.departments.some((d) => d.id === t.id)
      : s.agents.some((a) => a.id === t.id);
    return ok ? { type: t.type, id: t.id } : { type: 'all', id: null };
  }

  function handle(c) {
    const s = VO.app.state;
    if (c.op) { // perubahan struktur dari Telegram (divisi / departemen / karyawan baru)
      const r = VO.applyOp(s, c.op);
      if (r.ok) { VO.app.layoutChanged(); VO.ui.toast('Telegram: ' + r.text.replace(/\*\*/g, ''), 'send'); }
      api('POST', { action: 'reply', chatId: c.chatId, text: (r.ok ? '✅ ' : '⚠️ ') + r.text + (r.ok ? '\n\nKetik /tim untuk melihat struktur terbaru.' : '') }).catch(() => {});
      return;
    }
    if (c.videoDone) { // video dibuat & dirender di VPS saat kantor tidak dibuka → masuk Galeri
      if (!Array.isArray(s.videos)) s.videos = [];
      if (!s.videos.some((v) => v.id === c.videoDone.id)) s.videos.unshift(c.videoDone);
      if (c.doc && !s.docs.some((d) => d.id === c.doc.id)) { s.docs.unshift(c.doc); VO.cloud.synced.add(c.doc.id); }
      VO.log(s, `Video "${c.videoDone.title}" dibuat server video saat kantor tidak dibuka — masuk Galeri`, 'check');
      VO.app.changed();
      return;
    }
    if (c.done) { // sudah dikerjakan server (kantor sedang tidak dibuka)
      if (!s.tasks.some((t) => t.id === c.id)) {
        s.tasks.unshift({ id: c.id, title: c.title, targetType: c.target.type, targetId: c.target.id, status: 'done', created: c.t, finished: Date.now(), subtasks: [], result: c.result, note: 'Dari Telegram — dikerjakan server saat kantor tidak dibuka', ai: true, source: 'telegram' });
      }
      if (c.docId && !s.docs.some((d) => d.id === c.docId)) {
        s.docs.unshift({ id: c.docId, t: Date.now(), kind: 'report', title: 'Laporan (Telegram): ' + c.title.slice(0, 120), author: c.target.label, authorId: null, deptId: null, taskId: c.id, content: c.result });
        VO.cloud.synced.add(c.docId); // dokumen sudah tersimpan di server
      }
      VO.log(s, `Telegram: "${c.title}" dikerjakan saat kantor tidak dibuka — laporan sudah dikirim`, 'send');
      VO.app.changed();
      return;
    }
    const t = validTarget(s, c.target);
    if (c.video) { // permintaan video → programmatic video, MP4 dikirim balik ke chat ini
      const divId = t.type === 'division' ? t.id : t.type === 'dept' ? (s.departments.find((d) => d.id === t.id) || {}).divisionId : t.type === 'agent' ? (s.agents.find((a) => a.id === t.id) || {}).divisionId : null;
      VO.log(s, `Permintaan video dari Telegram: "${c.title}"`, 'send');
      const go = (image) => VO.gallery.start({ brief: c.title || 'Video tentang produk ini', divisionId: divId || null, image, telegram: c.chatId, review: false, style: c.photo && !c.title ? 'iklan' : undefined }) // dari Telegram: langsung render
        .catch((e) => api('POST', { action: 'reply', chatId: c.chatId, text: '⚠️ Gagal membuat video: ' + e.message }).catch(() => {}));
      if (c.photo) fetch('/api/telegram?action=photo&id=' + encodeURIComponent(c.photo)).then((r) => (r.ok ? r.blob() : null)).catch(() => null).then(go);
      else go(null);
      return;
    }
    VO.log(s, `Perintah dari Telegram → ${c.target.label}: "${c.title}"`, 'send');
    VO.ui.toast('Perintah baru dari Telegram', 'send');
    const task = VO.tasks.create({ title: c.title, targetType: t.type, targetId: t.id });
    task.source = 'telegram';
    tg.watching.set(task.id, { task, chatId: c.chatId, label: VO.tasks.targetLabel(s, t.type, t.id) });
  }

  async function poll() {
    if (!VO.cloud || !VO.cloud.enabled || tg.configured === false) return;
    try {
      const alive = document.visibilityState === 'visible' ? '1' : '0';
      const j = await api('GET', null, '?action=inbox&alive=' + alive);
      tg.configured = j.configured;
      for (const c of j.cmds || []) handle(c);
    } catch (e) { /* jaringan putus sesaat — coba lagi di putaran berikutnya */ }
  }

  async function deliver() {
    for (const [id, w] of tg.watching) {
      const t = w.task;
      if (t.status !== 'done' && t.status !== 'failed') continue;
      tg.watching.delete(id);
      const text = t.status === 'done'
        ? `✅ **${w.label}** — ${t.title}\n\n${String(t.result || '(tanpa laporan)').replace(/^> .*\n\n/, '')}`
        : `⚠️ Tugas gagal: ${t.title}\n${t.note || ''}`;
      try { await api('POST', { action: 'reply', chatId: w.chatId, text }); }
      catch (e) { VO.ui.toast('Gagal mengirim laporan ke Telegram: ' + e.message, 'alert'); }
    }
  }

  setInterval(poll, 5000);
  setInterval(deliver, 2000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); });

  /* ------------------------------------------------------------ dialog pengaturan */
  async function render(body) {
    body.innerHTML = '<p class="muted">Memuat status bot…</p>';
    let st;
    try { st = await api('GET', null, '?action=status'); } catch (e) { body.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
    tg.configured = st.configured;
    if (!st.configured) {
      body.innerHTML = `
        <p>Beri perintah ke kantor dari Telegram, laporan dikirim balik ke chat.</p>
        <ol class="tg-steps">
          <li>Buka <b>@BotFather</b> di Telegram → <code>/newbot</code> → salin <b>token</b> bot.<br><span class="muted">Pakai bot baru khusus Visual Office — bot yang sudah dipakai Hermes jangan dipakai ganda.</span></li>
          <li>Vercel → project visual-office → <b>Settings → Environment Variables</b> → tambah <code>TELEGRAM_BOT_TOKEN</code> = token tadi.</li>
          <li><b>Redeploy</b>, lalu buka lagi menu ini.</li>
        </ol>`;
      return;
    }
    const hookOk = st.webhook && st.webhook.ok;
    body.innerHTML = `
      <p>Bot: <b>@${esc(st.bot || '?')}</b></p>
      <p>Webhook: ${hookOk ? '<b class="ok">aktif ✓</b>' : '<b class="warn">belum terpasang</b>'}
        <button type="button" class="small" id="tgSetup">${hookOk ? 'Pasang ulang' : 'Pasang webhook'}</button></p>
      ${st.webhook && st.webhook.lastError ? `<p class="muted">Error terakhir Telegram: ${esc(st.webhook.lastError)}</p>` : ''}
      <p>Chat terhubung: <b>${st.chats.length}</b> ${st.chats.map((c) => `<code>${esc(c)}</code> <button type="button" class="small" data-unlink="${esc(c)}">putus</button>`).join(' ')}</p>
      <p><button type="button" class="small primary" id="tgLink">Hubungkan chat Telegram</button></p>
      <div id="tgCode"></div>
      <p class="muted">Cara pakai: kirim perintah ke bot → dikerjakan seluruh kantor. Awali dengan <code>@NamaDivisi</code> / <code>@NamaKaryawan</code> untuk tujuan tertentu. Bila kantor sedang tidak dibuka, perintah tetap dikerjakan langsung oleh AI di server.</p>`;
    $('tgSetup').onclick = async () => {
      try { const r = await api('POST', { action: 'setup' }); VO.ui.toast('Webhook terpasang', 'check'); render(body); return r; }
      catch (e) { VO.ui.toast(e.message, 'alert'); }
    };
    $('tgLink').onclick = async () => {
      try {
        const r = await api('POST', { action: 'link' });
        const url = r.bot ? `https://t.me/${r.bot}?start=${r.code}` : '';
        $('tgCode').innerHTML = `<p>${url ? `Klik: <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a> lalu tekan <b>Start</b>,<br>atau ` : ''}kirim ke bot: <code>/link ${esc(r.code)}</code> <span class="muted">(berlaku 15 menit)</span></p>`;
      } catch (e) { VO.ui.toast(e.message, 'alert'); }
    };
    body.querySelectorAll('[data-unlink]').forEach((b) => (b.onclick = async () => {
      try { await api('POST', { action: 'unlink', chatId: b.dataset.unlink }); render(body); } catch (e) { VO.ui.toast(e.message, 'alert'); }
    }));
  }

  tg.openSettings = function () {
    if (!VO.cloud || !VO.cloud.enabled) return VO.ui.toast('Fitur Telegram butuh login akun + database cloud (Upstash).', 'alert');
    VO.ui.form('Perintah lewat Telegram', [], 'Tutup');
    render($('dlgBody'));
  };
  document.addEventListener('DOMContentLoaded', () => { const b = $('btnTelegram'); if (b) b.onclick = () => tg.openSettings(); });
})();

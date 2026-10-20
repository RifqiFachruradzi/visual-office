/* =========================================================================
 * gallery.js — GALERI hasil video + JADWAL TAYANG (YouTube, TikTok, Instagram, Facebook, Threads).
 *   - Tab "Galeri" di panel kanan: sedang diproduksi · terjadwal · draft · sudah tayang
 *   - Detail video: putar, unduh, salin caption, kirim ke Telegram, atur jadwal & platform
 *   - Pengingat: saat jadwal tiba, Boss diingatkan (toast + Telegram berisi file videonya)
 *     → unggah ke platform dilakukan manual (posting otomatis butuh izin API tiap platform)
 * ========================================================================= */
(function () {
  const VO = window.VO;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => VO.esc(s);
  const G = (VO.gallery = {});
  const PLATFORMS = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram', facebook: 'Facebook', threads: 'Threads' };
  const ST = { producing: 'Diproduksi', scheduled: 'Terjadwal', draft: 'Draft', posted: 'Sudah tayang', failed: 'Gagal' };
  const S = () => VO.app.state;
  const list = () => (Array.isArray(S().videos) ? S().videos : (S().videos = []));
  const when = (t) => new Date(t).toLocaleString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const toLocalInput = (t) => { const d = new Date(t - new Date().getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };

  function card(v) {
    const vert = v.format !== '16:9';
    const thumb = v.thumb && v.thumb.url ? `<img src="${esc(v.thumb.url)}" alt="" loading="lazy">` : `<div class="gph">${v.status === 'producing' ? '🎬' : '🎞️'}</div>`;
    const stage = v.status === 'producing' ? `<div class="gbar"><i style="width:${Math.round((v.progress || 0) * 100)}%"></i></div><div class="gst">${esc({ naskah: 'Menulis naskah…', antre: 'Antre di server video…', media: 'Mencari foto/video stok…', narasi: 'Merekam narasi…', render: 'Merender ' + Math.round((v.progress || 0) * 100) + '%', upload: 'Menyimpan…' }[v.stage] || 'Tim sedang riset…')}</div>` : '';
    const sched = v.schedule ? `<span>⏰ ${esc(when(v.schedule))}</span>` : '';
    return `<div class="gcard ${vert ? 'v' : 'h'} st-${v.status}" data-vid="${v.id}">
      <div class="gthumb">${thumb}${v.duration ? `<span class="gdur">${v.duration} dtk</span>` : ''}</div>
      <div class="gt">${esc(v.title)}</div>${stage}
      <div class="gm"><span class="gs ${v.status}">${ST[v.status] || v.status}</span>${sched}<span>${(v.platforms || []).map((p) => PLATFORMS[p] || p).join(' · ')}</span></div></div>`;
  }

  G.render = function () {
    const el = $('galleryList');
    if (!el || el.closest('.hidden')) return;
    const vs = list();
    const by = (st) => vs.filter((v) => v.status === st);
    const sched = by('scheduled').sort((a, b) => a.schedule - b.schedule);
    const sec = (title, arr) => (arr.length ? `<div class="gsec">${title} <b>${arr.length}</b></div><div class="ggrid">${arr.map(card).join('')}</div>` : '');
    let h = sec('Sedang diproduksi', by('producing')) + sec('Terjadwal', sched) + sec('Draft', by('draft')) + sec('Sudah tayang', by('posted')) + sec('Gagal', by('failed'));
    if (!h) h = `<p class="empty">Belum ada video. Klik <b>🎬 Buat video</b>, atau tulis perintah seperti <i>"buat video penjelasan biaya listrik AI"</i> ke divisi Sosmed — naskah, template, render MP4, lalu muncul di sini.</p>`;
    if (el._html !== h) { el.innerHTML = h; el._html = h; }
    $('galleryCount').textContent = vs.filter((v) => v.status !== 'posted').length;
  };

  G.show = function (id) {
    const v = list().find((x) => x.id === id);
    if (!v) return;
    const player = v.file ? `<video src="${esc(v.file.url)}" ${v.thumb ? `poster="${esc(v.thumb.url)}"` : ''} controls playsinline class="gvideo ${v.format === '16:9' ? 'h' : 'v'}"></video>` : `<p class="empty">${v.status === 'failed' ? 'Gagal: ' + esc(v.error || '') : 'Video sedang diproduksi…'}</p>`;
    const plats = Object.entries(PLATFORMS).map(([k, l]) => `<label class="gplat"><input type="checkbox" data-plat="${k}" ${(v.platforms || []).includes(k) ? 'checked' : ''}> ${l}</label>`).join('');
    $('resultTitle').textContent = v.title;
    $('resultBody').innerHTML = `<div class="gdetail">${player}<div class="ginfo">
      <div style="color:var(--muted)">${ST[v.status] || v.status} · ${v.format || '9:16'} · ${v.duration || '?'} dtk${v.file ? ' · ' + VO.files.fmtSize(v.file.size) : ''}${v.codec === 'vp9' ? ' · VP9 (browser tanpa H.264)' : ''}${v.pack && VO.videoBoard.PACKS[v.pack] ? ' · paket ' + v.pack : ''}${v.engine === 'remotion' ? ' · server video' + (v.narrated ? ' + narasi' : '') : ''}</div>
      ${v.file && v.file.localOnly ? '<div class="gwarn">File hanya ada di browser ini (penyimpanan cloud belum aktif) — unduh sebelum menutup halaman.</div>' : ''}
      <div class="btns" style="margin:8px 0">
        ${v.file ? `<button type="button" class="small primary" data-g="dl">${VO.icon('download')} Unduh</button><button type="button" class="small" data-g="tg">${VO.icon('send')} Kirim ke Telegram</button>` : ''}
        ${v.caption ? `<button type="button" class="small" data-g="cap">Salin caption</button>` : ''}
        ${v.docId ? `<button type="button" class="small" data-g="doc">${VO.icon('file')} Naskah</button>` : ''}
        ${v.status !== 'posted' && v.file ? `<button type="button" class="small" data-g="posted">✓ Tandai sudah tayang</button>` : ''}
        <button type="button" class="small danger" data-g="del">${VO.icon('trash')} Hapus</button>
      </div>
      ${v.caption ? `<div class="gcap">${esc(v.caption)}</div>` : ''}
      <h4>⏰ Jadwal tayang</h4>
      <div class="gsched"><input type="datetime-local" id="gWhen" value="${v.schedule ? toLocalInput(v.schedule) : ''}"><div class="gplats">${plats}</div>
      <button type="button" class="small primary" data-g="save">Simpan jadwal</button>${v.schedule ? ' <button type="button" class="small" data-g="unsched">Hapus jadwal</button>' : ''}</div>
      <p class="muted" style="font-size:11px">Saat jadwal tiba, Visual Office mengingatkan (di sini & Telegram, lengkap dengan file videonya) — unggahan ke platform dilakukan manual.</p>
    </div></div>`;
    $('resultBody').dataset.vid = v.id;
    $('resultDlg').showModal();
  };

  async function onAction(e) {
    const b = e.target.closest('[data-g]');
    if (!b) return;
    const v = list().find((x) => x.id === $('resultBody').dataset.vid);
    if (!v) return;
    const a = b.dataset.g;
    if (a === 'dl') VO.files.download(v.file);
    else if (a === 'tg') {
      b.disabled = true;
      try { const n = await VO.files.sendTelegram(v.file, `🎬 ${v.title}\n\n${v.caption || ''}`); VO.ui.toast(`Terkirim ke ${n} chat Telegram`, 'send'); }
      catch (err) { VO.ui.toast('Telegram: ' + err.message, 'alert'); }
      b.disabled = false;
    } else if (a === 'cap') { navigator.clipboard.writeText(v.caption).then(() => VO.ui.toast('Caption disalin', 'check')); }
    else if (a === 'doc') { $('resultDlg').close(); VO.ui.showDoc(v.docId); }
    else if (a === 'posted') { v.status = 'posted'; v.postedAt = Date.now(); VO.app.changed(); G.render(); G.show(v.id); }
    else if (a === 'save' || a === 'unsched') {
      const t = a === 'save' && $('gWhen').value ? new Date($('gWhen').value).getTime() : null;
      v.platforms = [...$('resultBody').querySelectorAll('[data-plat]')].filter((x) => x.checked).map((x) => x.dataset.plat);
      v.schedule = t; v.reminded = false;
      if (v.status !== 'posted' && v.status !== 'producing' && v.status !== 'failed') v.status = t ? 'scheduled' : 'draft';
      VO.log(S(), t ? `Video "${v.title}" dijadwalkan ${when(t)} → ${v.platforms.map((p) => PLATFORMS[p]).join(', ') || '-'}` : `Jadwal video "${v.title}" dihapus`, 'clock');
      VO.app.changed(); G.render(); VO.ui.toast(t ? 'Jadwal tersimpan' : 'Jadwal dihapus', 'clock'); G.show(v.id);
    } else if (a === 'del') {
      if (!(await VO.ui.confirm('Hapus video ini (beserta file & naskahnya di Gudang Dokumen)?'))) return G.show(v.id);
      S().videos = list().filter((x) => x !== v);
      if (v.docId) S().docs = S().docs.filter((d) => d.id !== v.docId);
      VO.ui.renderDocs();
      if (v.file) VO.files.remove(v.file); if (v.thumb) VO.files.remove(v.thumb);
      VO.app.changed(); G.render();
    }
  }

  // pengingat jadwal tayang
  function checkSchedule() {
    const now = Date.now();
    for (const v of list()) {
      if (v.status !== 'scheduled' || !v.schedule || v.reminded || v.schedule > now) continue;
      v.reminded = true;
      const plats = (v.platforms || []).map((p) => PLATFORMS[p]).join(', ') || 'media sosial';
      VO.log(S(), `⏰ Waktunya tayang: "${v.title}" di ${plats}`, 'bell');
      VO.ui.toast(`⏰ Waktunya posting "${v.title}" ke ${plats}`, 'bell');
      if (v.file && !v.file.localOnly) VO.files.sendTelegram(v.file, `⏰ Waktunya tayang di ${plats}:\n${v.title}\n\n${v.caption || ''}`).catch(() => {});
      VO.app.changed();
    }
  }

  /* ------------------------------------------------------------ dialog buat video */
  G.openCreate = async function (pre = {}) {
    const eng = await VO.video.engine(true);
    if (!eng.worker && !VO.video.supported()) return VO.ui.toast('Server video (VPS) tidak aktif dan browser ini belum bisa membuat video — pakai Chrome/Edge terbaru.', 'alert');
    const s = S();
    const B = VO.videoBoard;
    const cdiv = VO.video.creativeDivision(s);
    const fp = VO.ui.form('Buat Video (programmatic)', [
      { key: 'brief', label: 'Mau video tentang apa?', type: 'textarea', value: pre.brief || '', placeholder: 'mis. Jelaskan kenapa 1 pertanyaan ke ChatGPT butuh listrik ±10× pencarian Google' },
      { key: 'style', label: 'Gaya video', type: 'select', value: pre.style || 'explainer', options: Object.entries(VO.video.STYLES).map(([k, x]) => ({ value: k, label: x.label })) },
      { key: 'pack', label: 'Paket visual', type: 'select', value: pre.pack || '', options: [{ value: '', label: 'Otomatis — dipilih AI sesuai topik' }, ...Object.entries(B.PACKS).map(([k, x]) => ({ value: k, label: x.label }))] },
      { key: 'voice', label: 'Narasi suara + subtitle', type: 'select', value: 'female', options: Object.entries(B.VOICES).map(([k, x]) => ({ value: k, label: x })) },
      { key: 'music', label: 'Musik latar', type: 'select', value: '', options: [{ value: '', label: 'Otomatis — sesuai suasana' }, ...Object.entries(B.MUSIC).map(([k, x]) => ({ value: k, label: x }))] },
      { key: 'format', label: 'Format', type: 'select', value: '9:16', options: [{ value: '9:16', label: '9:16 vertikal — TikTok, Reels, Shorts' }, { value: '16:9', label: '16:9 horizontal — YouTube' }] },
      { key: 'duration', label: 'Durasi', type: 'select', value: '25', options: ['15', '25', '35', '50'].map((d) => ({ value: d, label: d + ' detik' })) },
      { key: 'brand', label: 'Nama akun / brand', value: s.company.name || '', placeholder: '@akunmu' },
      { key: 'cta', label: 'Ajakan penutup', value: '', placeholder: 'Follow buat fakta AI lainnya!' },
      { key: 'divisionId', label: 'Dikerjakan oleh', type: 'select', value: cdiv ? cdiv.id : '', options: [{ value: '', label: 'Seluruh kantor' }, ...s.divisions.map((d) => ({ value: d.id, label: 'Divisi ' + d.name }))] },
      { key: 'schedule', label: 'Jadwal tayang (opsional, format: 2026-10-21 19:00)', value: '', placeholder: 'kosongkan = simpan sebagai draft' },
      { key: 'telegram', label: 'Kirim hasilnya ke Telegram', type: 'checkbox', value: !!(VO.telegram && VO.telegram.configured) },
    ], 'Buat video');
    const body = $('dlgBody');
    const fld = document.createElement('div');
    fld.className = 'field';
    fld.innerHTML = '<label for="f_photo">Foto / gambar (opsional — dipakai template "image", mis. foto produk)</label><input type="file" id="f_photo" accept="image/*">';
    body.insertBefore(fld, body.children[7] || null);
    const info = document.createElement('p');
    info.className = 'muted'; info.style.fontSize = '12px';
    info.textContent = eng.worker
      ? `🟢 Server video (VPS) aktif — dirender Remotion: paket visual, ${eng.tts ? 'narasi suara & subtitle, ' : ''}musik${eng.pexels ? ', foto/video stok' : ''}.`
      : '⚪ Server video (VPS) tidak aktif — video dirender di browser ini (tanpa narasi, musik & foto stok; paket visual hanya warna).';
    body.insertBefore(info, body.firstChild);
    const photo = $('f_photo');
    const v = await fp;
    if (!v) return;
    if (!v.brief) return VO.ui.toast('Isi dulu video tentang apa', 'alert');
    const t = v.schedule ? new Date(v.schedule.replace(' ', 'T')).getTime() : null;
    G.start({ brief: v.brief, style: v.style, pack: v.pack || undefined, voice: v.voice, music: v.music || undefined, format: v.format, duration: v.duration, brand: v.brand, cta: v.cta, divisionId: v.divisionId || null, image: photo.files[0] || null, schedule: t && isFinite(t) ? t : null, telegram: v.telegram ? true : false });
  };

  G.start = function (o) {
    VO.ui.toast('🎬 Tim mulai riset & menulis naskah — progres terlihat di tab Galeri', 'sparkles');
    G.focusTab();
    return VO.video.create(o).then((item) => { VO.ui.toast('🎬 Video selesai: ' + item.title, 'check'); G.render(); return item; })
      .catch((e) => { VO.ui.toast('Gagal membuat video: ' + e.message, 'alert'); G.render(); throw e; });
  };
  G.focusTab = () => { const t = document.querySelector('.tab[data-tab="gallery"]'); if (t) t.click(); };

  document.addEventListener('DOMContentLoaded', () => {
    $('galleryList').addEventListener('click', (e) => { const c = e.target.closest('[data-vid]'); if (c) G.show(c.dataset.vid); });
    $('resultBody').addEventListener('click', onAction);
    $('btnGalleryNew').addEventListener('click', () => G.openCreate());
    const vb = $('btnVideo'); if (vb) vb.addEventListener('click', () => G.openCreate());
    setInterval(() => { G.render(); }, 1000);
    setInterval(checkSchedule, 30000);
    setTimeout(checkSchedule, 4000);
  });
})();

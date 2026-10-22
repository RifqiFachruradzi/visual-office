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
  const ST = { review: 'Perlu dicek', producing: 'Diproduksi', scheduled: 'Terjadwal', draft: 'Draft', posted: 'Sudah tayang', failed: 'Gagal' };
  const S = () => VO.app.state;
  const list = () => (Array.isArray(S().videos) ? S().videos : (S().videos = []));
  const when = (t) => new Date(t).toLocaleString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const toLocalInput = (t) => { const d = new Date(t - new Date().getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };

  function card(v) {
    const vert = v.format !== '16:9';
    const thumb = v.thumb && v.thumb.url ? `<img src="${esc(v.thumb.url)}" alt="" loading="lazy">` : `<div class="gph">${v.status === 'producing' ? '🎬' : v.status === 'review' ? '📝' : '🎞️'}</div>`;
    const stage = v.status === 'producing' ? `<div class="gbar"><i style="width:${Math.round((v.progress || 0) * 100)}%"></i></div><div class="gst">${esc({ naskah: 'Menulis naskah…', antre: 'Antre di server video…', media: 'Mencari foto/video stok…', narasi: 'Merekam narasi…', kode: 'AI menulis animasi khusus…', render: 'Merender ' + Math.round((v.progress || 0) * 100) + '%', upload: 'Menyimpan…' }[v.stage] || 'Tim sedang riset…')}</div>` : '';
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
    let h = sec('Perlu dicek — edit naskah lalu render', by('review')) + sec('Sedang diproduksi', by('producing')) + sec('Terjadwal', sched) + sec('Draft', by('draft')) + sec('Sudah tayang', by('posted')) + sec('Gagal', by('failed'));
    if (!h) h = `<p class="empty">Belum ada video. Klik <b>🎬 Buat video</b>, atau tulis perintah seperti <i>"buat video penjelasan biaya listrik AI"</i> ke divisi Sosmed — naskah, template, render MP4, lalu muncul di sini.</p>`;
    if (el._html !== h) { el.innerHTML = h; el._html = h; }
    $('galleryCount').textContent = vs.filter((v) => v.status !== 'posted').length;
  };

  G.show = function (id) {
    const v = list().find((x) => x.id === id);
    if (!v) return;
    if (v.status === 'review') return G.editor(v.id);
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

  /* ------------------------------------------------------------ editor naskah (sebelum render) */
  // Field per template: [kunci, label, jenis] — jenis: text | area | lines | num | pairs (label = nilai)
  const FIELDS = {
    title: [['kicker', 'Label kecil', 'text'], ['title', 'Judul (hook)', 'text'], ['sub', 'Subjudul', 'text']],
    media: [['kicker', 'Label kecil', 'text'], ['title', 'Judul', 'text'], ['sub', 'Subjudul', 'text'], ['media', 'Kata kunci foto/video stok (Inggris)', 'text']],
    stat: [['title', 'Judul', 'text'], ['prefix', 'Awalan (mis. Rp)', 'text'], ['value', 'Angka', 'num'], ['unit', 'Satuan', 'text'], ['label', 'Keterangan', 'text']],
    compare: [['title', 'Judul', 'text'], ['unit', 'Satuan', 'text'], ['items', 'Data (satu per baris: Label = nilai)', 'pairs']],
    bullets: [['title', 'Judul', 'text'], ['items', 'Poin (satu per baris, maks 5)', 'lines']],
    steps: [['title', 'Judul', 'text'], ['items', 'Langkah (satu per baris, maks 5)', 'lines']],
    quote: [['text', 'Kutipan', 'area'], ['author', 'Sumber', 'text']],
    countdown: [['from', 'Mulai dari', 'num'], ['label', 'Keterangan', 'text']],
    versus: [['title', 'Judul', 'text'], ['left.label', 'Kiri — label', 'text'], ['left.items', 'Kiri — poin (per baris)', 'lines'], ['right.label', 'Kanan — label', 'text'], ['right.items', 'Kanan — poin (per baris)', 'lines']],
    image: [['title', 'Judul', 'text'], ['sub', 'Subjudul', 'text']],
    device: [['title', 'Judul', 'text'], ['items', 'Label fitur (per baris, maks 3)', 'lines']],
    price: [['title', 'Judul', 'text'], ['price', 'Harga', 'text'], ['old', 'Harga coret', 'text'], ['sub', 'Keterangan', 'text']],
    cta: [['title', 'Janji utama', 'text'], ['action', 'Tombol ajakan (mis. Coba gratis)', 'text'], ['sub', 'Akun / website', 'text']],
  };
  const ASSET_T = ['title', 'media', 'image', 'device'];
  const getK = (o, k) => k.split('.').reduce((a, x) => (a == null ? a : a[x]), o);
  const setK = (o, k, val) => { const ks = k.split('.'); let a = o; ks.slice(0, -1).forEach((x) => { a = a[x] = a[x] || {}; }); a[ks[ks.length - 1]] = val; };
  const fieldVal = (sc, k, kind) => {
    const v = getK(sc, k);
    if (kind === 'lines') return (v || []).join('\n');
    if (kind === 'pairs') return (v || []).map((i) => `${i.label} = ${i.value}`).join('\n');
    return v == null ? '' : String(v);
  };
  const B = () => VO.videoBoard;

  function editorHtml(v) {
    const sb = v.storyboard, assets = v.assets || [];
    const opt = (obj, cur) => Object.entries(obj).map(([k, l]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${esc(typeof l === 'string' ? l : l.label)}</option>`).join('');
    const tOpts = (cur) => Object.keys(B().TEMPLATES).map((k) => `<option value="${k}"${k === cur ? ' selected' : ''}>${k}</option>`).join('');
    const scenes = sb.scenes.map((sc, i) => {
      const f = (FIELDS[sc.t] || []).map(([k, label, kind]) => {
        const val = esc(fieldVal(sc, k, kind));
        const input = kind === 'text' || kind === 'num' ? `<input type="${kind === 'num' ? 'number' : 'text'}" step="any" data-k="${k}" data-kind="${kind}" value="${val}">` : `<textarea rows="${kind === 'area' ? 2 : 3}" data-k="${k}" data-kind="${kind}">${val}</textarea>`;
        return `<label class="ef"><span>${esc(label)}</span>${input}</label>`;
      }).join('');
      const assetSel = ASSET_T.includes(sc.t) && assets.length ? `<label class="ef"><span>Aset</span><select data-k="asset" data-kind="num"><option value="">— tidak ada —</option>${assets.map((a, j) => `<option value="${j + 1}"${sc.asset === j + 1 ? ' selected' : ''}>${j + 1}. ${esc(a.name || a.type)}</option>`).join('')}</select></label>` : '';
      return `<div class="escene" data-i="${i}">
        <div class="eshead"><b>${i + 1}</b>
          <select data-k="t" data-kind="tpl" aria-label="Template adegan ${i + 1}">${tOpts(sc.t)}</select>
          <label class="esec">Durasi <input type="number" min="2" max="9" step="0.5" data-k="sec" data-kind="num" value="${sc.sec}"> dtk</label>
          <span class="spacer"></span>
          <button type="button" class="icon" data-e="up" title="Naikkan" aria-label="Naikkan">↑</button><button type="button" class="icon" data-e="down" title="Turunkan" aria-label="Turunkan">↓</button><button type="button" class="icon danger" data-e="rm" title="Hapus adegan" aria-label="Hapus adegan">✕</button>
        </div>
        <div class="esbody">${f}${assetSel}
          <label class="ef wide"><span>Narasi (dibacakan)</span><textarea rows="2" data-k="narration" data-kind="area">${esc(sc.narration || '')}</textarea></label>
          <label class="ef wide"><span>✨ Animasi buatan AI (kosongkan = template biasa)</span><input type="text" data-k="custom" data-kind="text" value="${esc(sc.custom || '')}" placeholder="mis. angka berhitung naik sambil grafik batang tumbuh"></label>
        </div></div>`;
    }).join('');
    return `<div class="eview" data-vid="${v.id}">
      <p class="muted">Naskah ditulis AI — ubah apa pun, lalu klik <b>Render video</b>. Remotion merender persis sesuai naskah ini${assets.length ? ` (${assets.length} aset terlampir)` : ''}.</p>
      <div class="egrid">
        <label class="ef wide"><span>Judul video</span><input type="text" data-g-k="title" value="${esc(sb.title)}"></label>
        <label class="ef"><span>Paket visual</span><select data-g-k="pack">${opt(B().PACKS, sb.pack)}</select></label>
        <label class="ef"><span>Musik</span><select data-g-k="music">${opt(B().MUSIC, sb.music)}</select></label>
        <label class="ef"><span>Narasi</span><select data-g-k="voice">${opt(B().VOICES, sb.voice)}</select></label>
        <label class="ef"><span>Nama akun / brand</span><input type="text" data-g-k="brand" value="${esc(sb.brand || '')}"></label>
      </div>
      <div class="escenes">${scenes}</div>
      <button type="button" class="small" data-e="add">${VO.icon('plus')} Tambah adegan</button>
      <label class="ef wide" style="margin-top:12px"><span>Caption media sosial</span><textarea rows="2" data-g-k="caption">${esc(sb.caption || '')}</textarea></label>
      <div class="btns" style="margin-top:12px">
        <button type="button" class="primary" data-e="render">${VO.icon('monitor')} Render video</button>
        <button type="button" data-e="save">Simpan draf</button>
        <span class="spacer"></span>
        <button type="button" class="danger" data-e="del">${VO.icon('trash')} Hapus draf</button>
      </div></div>`;
  }

  // baca isi editor → objek naskah
  function collect(root, v) {
    const sb = JSON.parse(JSON.stringify(v.storyboard));
    root.querySelectorAll('[data-g-k]').forEach((el) => { sb[el.dataset.gK] = el.value; });
    sb.scenes = [...root.querySelectorAll('.escene')].map((card) => {
      const sc = JSON.parse(JSON.stringify(v.storyboard.scenes[Number(card.dataset.i)] || {}));
      card.querySelectorAll('[data-k]').forEach((el) => {
        const k = el.dataset.k, kind = el.dataset.kind, raw = el.value;
        if (kind === 'lines') setK(sc, k, raw.split('\n').map((x) => x.trim()).filter(Boolean));
        else if (kind === 'pairs') setK(sc, k, raw.split('\n').map((ln) => { const [l, val] = ln.split('='); return { label: (l || '').trim(), value: (val || '').trim() }; }).filter((x) => x.label));
        else if (kind === 'num') { if (raw === '') delete sc[k]; else setK(sc, k, Number(raw)); }
        else if (k === 'custom' && !raw.trim()) delete sc.custom;
        else setK(sc, k, raw);
      });
      return sc;
    });
    return sb;
  }

  G.editor = function (id) {
    const v = list().find((x) => x.id === id);
    if (!v || !v.storyboard) return;
    $('resultTitle').textContent = '📝 Cek naskah: ' + v.storyboard.title;
    $('resultBody').innerHTML = editorHtml(v);
    $('resultBody').dataset.vid = v.id;
    if (!$('resultDlg').open) $('resultDlg').showModal();
  };

  async function onEditor(e) {
    const b = e.target.closest('[data-e]');
    const root = $('resultBody').querySelector('.eview');
    if (!root) return;
    const v = list().find((x) => x.id === root.dataset.vid);
    if (!v) return;
    // ganti template → isi editor disusun ulang dengan field template baru
    if (!b && e.type === 'change' && e.target.dataset.kind === 'tpl') { v.storyboard = collect(root, v); return G.editor(v.id); }
    if (!b) return;
    const a = b.dataset.e;
    const card = b.closest('.escene'), i = card ? Number(card.dataset.i) : -1;
    v.storyboard = collect(root, v);
    const sc = v.storyboard.scenes;
    if (a === 'up' && i > 0) [sc[i - 1], sc[i]] = [sc[i], sc[i - 1]];
    else if (a === 'down' && i < sc.length - 1) [sc[i + 1], sc[i]] = [sc[i], sc[i + 1]];
    else if (a === 'rm') sc.splice(i, 1);
    else if (a === 'add') sc.splice(Math.max(0, sc.length - 1), 0, { t: 'bullets', sec: 4, title: '', items: [], narration: '' });
    else if (a === 'save') { VO.app.changed(); VO.ui.toast('Draf naskah disimpan', 'check'); }
    else if (a === 'del') {
      if (!(await VO.ui.confirm('Hapus draf video ini?'))) return G.editor(v.id);
      S().videos = list().filter((x) => x !== v);
      for (const f of v.assets || []) if (!f.localOnly) VO.files.remove(f);
      $('resultDlg').close(); VO.app.changed(); return G.render();
    } else if (a === 'render') {
      const before = sc.length;
      try { v.storyboard = B().finalize(v.storyboard, (v.assets || []).length); }
      catch (err) { return VO.ui.toast(err.message, 'alert'); }
      const dropped = before - v.storyboard.scenes.length;
      v.title = v.storyboard.title; v.caption = v.storyboard.caption;
      $('resultDlg').close(); VO.app.changed();
      VO.ui.toast(`🎬 Render dimulai${dropped ? ` — ${dropped} adegan kosong dilewati` : ''}`, 'sparkles');
      VO.video.produce(v.id).then((it) => { VO.ui.toast('🎬 Video selesai: ' + it.title, 'check'); G.render(); })
        .catch((err) => { VO.ui.toast('Gagal membuat video: ' + err.message, 'alert'); G.render(); });
      return G.render();
    }
    VO.app.changed();
    G.editor(v.id);
  }

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
      { key: 'creative', label: 'Animasi', type: 'select', value: 'on', options: [{ value: 'on', label: 'Kreatif — AI menulis animasi khusus untuk 1–2 adegan (± 1–3 menit lebih lama)' }, { value: 'off', label: 'Template saja (lebih cepat)' }] },
      { key: 'voice', label: 'Narasi suara + subtitle', type: 'select', value: 'female', options: Object.entries(B.VOICES).map(([k, x]) => ({ value: k, label: x })) },
      { key: 'music', label: 'Musik latar', type: 'select', value: '', options: [{ value: '', label: 'Otomatis — sesuai suasana' }, ...Object.entries(B.MUSIC).map(([k, x]) => ({ value: k, label: x }))] },
      { key: 'format', label: 'Format', type: 'select', value: '9:16', options: [{ value: '9:16', label: '9:16 vertikal — TikTok, Reels, Shorts' }, { value: '16:9', label: '16:9 horizontal — YouTube' }] },
      { key: 'duration', label: 'Durasi', type: 'select', value: '25', options: ['15', '25', '35', '50'].map((d) => ({ value: d, label: d + ' detik' })) },
      { key: 'brand', label: 'Nama akun / brand', value: s.company.name || '', placeholder: '@akunmu' },
      { key: 'cta', label: 'Ajakan penutup', value: '', placeholder: 'Follow buat fakta AI lainnya!' },
      { key: 'divisionId', label: 'Dikerjakan oleh', type: 'select', value: cdiv ? cdiv.id : '', options: [{ value: '', label: 'Seluruh kantor' }, ...s.divisions.map((d) => ({ value: d.id, label: 'Divisi ' + d.name }))] },
      { key: 'schedule', label: 'Jadwal tayang (opsional, format: 2026-10-21 19:00)', value: '', placeholder: 'kosongkan = simpan sebagai draft' },
      { key: 'review', label: 'Cek & edit naskah dulu sebelum render (disarankan)', type: 'checkbox', value: true },
      { key: 'telegram', label: 'Kirim hasilnya ke Telegram', type: 'checkbox', value: !!(VO.telegram && VO.telegram.configured) },
    ], 'Buat video');
    const body = $('dlgBody');
    const fld = document.createElement('div');
    fld.className = 'field';
    fld.innerHTML = '<label for="f_photo">Foto / video (opsional, boleh lebih dari satu — mis. beberapa foto produk & klip demo, maks. 8)</label><input type="file" id="f_photo" accept="image/*,video/mp4,video/webm,video/quicktime" multiple><div id="f_photoList" class="muted"></div>';
    body.insertBefore(fld, body.children[7] || null);
    const info = document.createElement('p');
    info.className = 'muted'; info.style.fontSize = '12px';
    info.textContent = eng.worker
      ? `🟢 Server video (VPS) aktif — dirender Remotion: paket visual, ${eng.tts ? 'narasi suara & subtitle, ' : ''}musik${eng.pexels ? ', foto/video stok' : ''}.`
      : '⚪ Server video (VPS) tidak aktif — video dirender di browser ini (tanpa narasi, musik & foto stok; paket visual hanya warna).';
    body.insertBefore(info, body.firstChild);
    const photo = $('f_photo');
    photo.addEventListener('change', () => {
      const fs = [...photo.files];
      $('f_photoList').textContent = fs.length ? `${fs.length} file: ` + fs.slice(0, 8).map((f) => `${f.name} (${VO.files.fmtSize(f.size)})`).join(', ') + (fs.length > 8 ? ' — hanya 8 pertama yang dipakai' : '') : '';
    });
    const v = await fp;
    if (!v) return;
    if (!v.brief) return VO.ui.toast('Isi dulu video tentang apa', 'alert');
    const t = v.schedule ? new Date(v.schedule.replace(' ', 'T')).getTime() : null;
    G.start({ brief: v.brief, style: v.style, pack: v.pack || undefined, creative: v.creative !== 'off', review: !!v.review, voice: v.voice, music: v.music || undefined, format: v.format, duration: v.duration, brand: v.brand, cta: v.cta, divisionId: v.divisionId || null, files: [...photo.files].slice(0, 8), schedule: t && isFinite(t) ? t : null, telegram: v.telegram ? true : false });
  };

  G.start = function (o) {
    VO.ui.toast('🎬 Tim mulai riset & menulis naskah — progres terlihat di tab Galeri', 'sparkles');
    G.focusTab();
    return VO.video.create(o).then((item) => { if (item.status === 'review') { VO.ui.toast('📝 Draf naskah siap — cek & edit di Galeri, lalu Render', 'file'); G.render(); G.editor(item.id); } else { VO.ui.toast('🎬 Video selesai: ' + item.title, 'check'); G.render(); } return item; })
      .catch((e) => { VO.ui.toast('Gagal membuat video: ' + e.message, 'alert'); G.render(); throw e; });
  };
  G.focusTab = () => { const t = document.querySelector('.tab[data-tab="gallery"]'); if (t) t.click(); };

  document.addEventListener('DOMContentLoaded', () => {
    $('galleryList').addEventListener('click', (e) => { const c = e.target.closest('[data-vid]'); if (c) G.show(c.dataset.vid); });
    $('resultBody').addEventListener('click', onAction);
    $('resultBody').addEventListener('click', onEditor);
    $('resultBody').addEventListener('change', onEditor);
    $('btnGalleryNew').addEventListener('click', () => G.openCreate());
    const vb = $('btnVideo'); if (vb) vb.addEventListener('click', () => G.openCreate());
    setInterval(() => { G.render(); }, 1000);
    setInterval(checkSchedule, 30000);
    setTimeout(checkSchedule, 4000);
  });
})();

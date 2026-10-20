/* =========================================================================
 * files.js (browser) — simpan file hasil kerja (video, PDF, gambar, apa pun) lalu
 * tampilkan di Gudang Dokumen dan/atau kirim ke Telegram.
 *   - Vercel Blob: browser mengunggah langsung ke Blob (lewat handshake /api/office?files=token),
 *     jadi file besar (≤ 50 MB) tidak terbentur batas 4,5 MB request Vercel.
 *   - Server lokal (npm start): diunggah ke /api/office?files=put, disajikan dari /files/…
 *   - Tanpa keduanya: file tetap bisa diunduh di browser ini (tidak tersinkron / terkirim).
 * ========================================================================= */
(function () {
  const VO = window.VO;
  const F = (VO.files = { mode: null, auth: null, max: 50 * 1024 * 1024, local: new Map() });

  F.status = async function () {
    if (F.mode) return F.mode;
    try {
      const r = await fetch('/api/office?files=status', { cache: 'no-store' });
      const j = await r.json();
      F.mode = j.mode || 'none'; F.auth = j.auth || 'token'; F.max = j.max || F.max;
    } catch (e) { F.mode = 'none'; }
    return F.mode;
  };
  F.canStore = async () => (await F.status()) !== 'none';

  F.fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  F.kindOf = (type, name) => (/^video\//.test(type) ? 'video' : /^image\//.test(type) ? 'image' : /pdf/.test(type) || /\.pdf$/i.test(name || '') ? 'pdf' : 'file');
  F.icon = (f) => ({ video: 'monitor', image: 'eye', pdf: 'file', file: 'folder' })[F.kindOf(f.type, f.name)];
  const safe = (n) => String(n || 'file').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '-').slice(-90);

  let blobLib = null;
  /**
   * Unggah Blob/File. → { url, name, type, size }  (url lokal "blob:" bila penyimpanan tidak aktif)
   * onProgress(0..1) opsional.
   */
  F.upload = async function (blob, name, onProgress) {
    const mode = await F.status();
    const type = blob.type || 'application/octet-stream';
    if (blob.size > F.max) throw new Error('File lebih dari ' + F.fmtSize(F.max));
    const meta = { name: safe(name), type, size: blob.size };
    if (mode === 'blob') {
      if (!blobLib) blobLib = await import('../vendor/blob/blob-client.js');
      // OIDC (cara baru Vercel) → upload presigned; token lama → client token
      const up = F.auth === 'oidc' ? blobLib.uploadPresigned : blobLib.upload;
      const r = await up('vo/' + meta.name, blob, {
        access: 'public', contentType: type, handleUploadUrl: '/api/office?files=token',
        multipart: F.auth !== 'oidc' && blob.size > 8 * 1024 * 1024,
        onUploadProgress: onProgress ? (e) => onProgress(e.percentage / 100) : undefined,
      });
      return { ...meta, url: r.url };
    }
    if (mode === 'local') {
      const r = await fetch('/api/office?files=put&name=' + encodeURIComponent(meta.name), { method: 'PUT', body: blob, headers: { 'content-type': type } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Upload gagal (HTTP ' + r.status + ')');
      return { ...meta, url: j.url };
    }
    const url = URL.createObjectURL(blob); // hanya di browser ini
    F.local.set(url, blob);
    return { ...meta, url, localOnly: true };
  };

  F.remove = function (file) {
    if (!file || !file.url || /^blob:/.test(file.url)) return;
    fetch('/api/office?files=del', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: file.url }) }).catch(() => {});
  };

  F.download = function (file) {
    const a = document.createElement('a');
    a.href = file.url; a.download = file.name; a.target = '_blank'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  };

  /** Kirim file tersimpan ke Telegram (chatId tertentu, atau semua chat yang terhubung). */
  F.sendTelegram = async function (file, caption, chatId) {
    if (!file || /^blob:/.test(file.url)) throw new Error('File belum tersimpan di server — aktifkan Vercel Blob dulu (lihat README).');
    const r = await fetch('/api/telegram', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'sendFile', url: file.url, name: file.name, type: file.type, caption: caption || '', chatId: chatId != null ? chatId : undefined }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    return j.sent || 0;
  };

  /**
   * Simpan hasil sebagai dokumen bergambar/berfile di Gudang Dokumen (+ kirim ke Telegram).
   * o: { blob, name, title, author, content, taskId, telegram: true|false|chatId, caption }
   * → doc
   */
  F.publish = async function (o) {
    const s = VO.app.state;
    const file = await F.upload(o.blob, o.name, o.onProgress);
    const doc = VO.addDoc(s, { kind: o.kind || 'work', title: o.title, author: o.author || 'Visual Office', taskId: o.taskId || null, content: o.content || '' });
    doc.file = file;
    VO.app.changed();
    VO.ui && VO.ui.renderDocs && VO.ui.renderDocs();
    if (o.telegram !== false && o.telegram != null) {
      try {
        const n = await F.sendTelegram(file, o.caption || o.title, o.telegram === true ? undefined : o.telegram);
        VO.log(s, `"${o.title}" dikirim ke Telegram (${n} chat)`, 'send');
      } catch (e) { VO.ui.toast('Telegram: ' + e.message, 'alert'); }
    }
    return doc;
  };

  /** Laporan (markdown) → PDF → simpan & (opsional) kirim. */
  F.publishReport = async function ({ title, meta, sections, author, taskId, telegram, caption, content }) {
    const { blob, name } = await VO.pdf.build({ title, meta, sections });
    return F.publish({ blob, name, title: 'PDF: ' + title, author, taskId, telegram, caption, content: content || '', kind: 'report' });
  };
})();

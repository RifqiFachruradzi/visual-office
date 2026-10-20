/* =========================================================================
 * pdf.js — unduh dokumen / laporan sebagai file PDF.
 * Memakai jsPDF (disertakan di js/vendor, dimuat hanya saat dibutuhkan).
 * Markdown sederhana dirender: judul, poin, daftar bernomor, kutipan, tabel.
 * Bila jsPDF gagal dimuat, jatuh ke dialog cetak browser (Simpan sebagai PDF).
 * ========================================================================= */
(function () {
  const VO = window.VO;
  const pdf = (VO.pdf = {});

  let loading = null;
  function loadJsPdf() {
    if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const sc = document.createElement('script');
        sc.src = 'js/vendor/jspdf.umd.min.js';
        sc.onload = () => (window.jspdf && window.jspdf.jsPDF ? resolve(window.jspdf.jsPDF) : reject(new Error('jsPDF tidak tersedia')));
        sc.onerror = () => { loading = null; reject(new Error('Gagal memuat jsPDF')); };
        document.head.appendChild(sc);
      });
    }
    return loading;
  }

  // Font standar PDF hanya mendukung Latin-1 (+ beberapa simbol): ganti karakter lain
  const clean = (t) =>
    String(t)
      .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
      .replace(/–/g, '-').replace(/—/g, ' - ').replace(/…/g, '...')
      .replace(/[•●▪]/g, '-').replace(/→/g, '->')
      .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '');
  const inline = (t) => clean(t).replace(/\*\*(.+?)\*\*/g, '$1').replace(/(^|\W)_(.+?)_(?=\W|$)/g, '$1$2').replace(/`([^`]+)`/g, '$1');

  const fileName = (title) => (String(title).replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || 'dokumen') + '.pdf';

  /**
   * Buat & unduh PDF. sections: [{ heading?, body (markdown) }]
   */
  pdf.download = async function ({ title, meta, sections }) {
    let built;
    try { built = await pdf.build({ title, meta, sections }); }
    catch (e) { return printFallback({ title, meta, sections }); }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(built.blob); a.download = built.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  /** Buat PDF tanpa mengunduh → { blob, name } (dipakai untuk dikirim ke Telegram / disimpan). */
  pdf.build = async function ({ title, meta, sections }) {
    const JsPDF = await loadJsPdf();
    const doc = new JsPDF({ unit: 'pt', format: 'a4' });
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
    const M = 50, maxW = W - M * 2;
    let y = M;

    const ensure = (h) => { if (y + h > H - M) { doc.addPage(); y = M; } };
    const text = (str, { size = 10.5, style = 'normal', color = [30, 32, 40], indent = 0, gap = 4, lh = 1.4 } = {}) => {
      doc.setFont('helvetica', style);
      doc.setFontSize(size);
      doc.setTextColor(...color);
      const lines = doc.splitTextToSize(str, maxW - indent);
      for (const ln of lines) {
        ensure(size * lh);
        doc.text(ln, M + indent, y + size);
        y += size * lh;
      }
      y += gap;
    };

    // kepala dokumen
    doc.setFillColor(79, 140, 255);
    doc.rect(0, 0, W, 6, 'F');
    text(clean(title), { size: 18, style: 'bold', gap: 2 });
    if (meta) text(clean(meta), { size: 9, color: [110, 115, 130], gap: 6 });
    doc.setDrawColor(220, 224, 232);
    doc.line(M, y, W - M, y);
    y += 14;

    for (const sec of sections) {
      if (sec.heading) { ensure(30); text(clean(sec.heading), { size: 13, style: 'bold', color: [40, 70, 160], gap: 6 }); }
      let table = [];
      const flushTable = () => {
        if (!table.length) return;
        const rows = table.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r)).map((r) => r.replace(/^\s*\||\|\s*$/g, '').split('|').map((c) => inline(c.trim())));
        const cols = Math.max(...rows.map((r) => r.length));
        const cw = maxW / cols;
        rows.forEach((r, i) => {
          doc.setFont('helvetica', i === 0 ? 'bold' : 'normal');
          doc.setFontSize(9);
          const cells = r.map((c) => doc.splitTextToSize(c, cw - 8));
          const rh = Math.max(...cells.map((c) => c.length)) * 12 + 8;
          ensure(rh);
          if (i === 0) { doc.setFillColor(238, 242, 250); doc.rect(M, y, maxW, rh, 'F'); }
          doc.setDrawColor(215, 220, 230);
          for (let c = 0; c < cols; c++) {
            doc.rect(M + c * cw, y, cw, rh);
            doc.setTextColor(30, 32, 40);
            (cells[c] || []).forEach((ln, k) => doc.text(ln, M + c * cw + 4, y + 12 + k * 12));
          }
          y += rh;
        });
        y += 8;
        table = [];
      };

      for (const raw of String(sec.body || '').split('\n')) {
        const line = raw.replace(/\s+$/, '');
        if (/^\s*\|.*\|\s*$/.test(line)) { table.push(line); continue; }
        flushTable();
        if (!line.trim()) { y += 4; continue; }
        let m;
        if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
          const lvl = m[1].length;
          ensure(28);
          text(inline(m[2]), { size: lvl <= 1 ? 15 : lvl === 2 ? 13 : 11.5, style: 'bold', color: lvl <= 2 ? [25, 30, 45] : [50, 60, 90], gap: 4 });
        } else if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(line))) {
          const ind = 12 + Math.min(3, Math.floor(m[1].length / 2)) * 12;
          doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5);
          ensure(15);
          doc.text('-', M + ind - 9, y + 10.5);
          text(inline(m[2]), { indent: ind, gap: 1 });
        } else if ((m = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line))) {
          const ind = 18 + Math.min(3, Math.floor(m[1].length / 2)) * 12;
          doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5);
          ensure(15);
          doc.text(m[2], M + ind - 16, y + 10.5);
          text(inline(m[3]), { indent: ind, gap: 1 });
        } else if ((m = /^>\s?(.*)$/.exec(line))) {
          text(inline(m[1]), { style: 'italic', color: [100, 105, 120], indent: 10, gap: 3 });
        } else if (/^-{3,}$/.test(line.trim())) {
          ensure(10); doc.line(M, y + 4, W - M, y + 4); y += 10;
        } else {
          text(inline(line), { gap: 3 });
        }
      }
      flushTable();
      y += 6;
    }

    // nomor halaman
    const n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      doc.setPage(i);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(140, 145, 160);
      doc.text(`Visual Office  ·  ${clean(title).slice(0, 70)}`, M, H - 24);
      doc.text(`${i} / ${n}`, W - M, H - 24, { align: 'right' });
    }
    return { blob: doc.output('blob'), name: fileName(title) };
  };

  // Cadangan: buka jendela cetak (pengguna memilih "Simpan sebagai PDF")
  function printFallback({ title, meta, sections }) {
    const w = window.open('', '_blank');
    if (!w) { VO.ui.toast('Izinkan pop-up untuk mengunduh PDF', 'alert'); return; }
    const body = sections.map((s) => (s.heading ? `<h2>${VO.esc(s.heading)}</h2>` : '') + `<div>${VO.ui.md(s.body)}</div>`).join('');
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${VO.esc(title)}</title>
      <style>body{font:12pt/1.5 Georgia,serif;margin:2cm;color:#1e2028;white-space:pre-wrap}h1{font:bold 18pt sans-serif;margin:0}h2{font:bold 13pt sans-serif;color:#2846a0}.m{color:#6e7382;font:9pt sans-serif;margin-bottom:12pt}</style>
      </head><body><h1>${VO.esc(title)}</h1><div class="m">${VO.esc(meta || '')}</div>${body}</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  }
})();

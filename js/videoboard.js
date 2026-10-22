/* =========================================================================
 * videoboard.js — NASKAH VIDEO TERSTRUKTUR (storyboard): daftar template, gaya, paket visual,
 * prompt AI, validasi, dan naskah cadangan. Murni data/logika (tanpa DOM) agar dipakai di:
 *   - browser (js/video.js, galeri)            → VO.videoBoard
 *   - server (lib/render.js lewat sandbox vm)  → membuat naskah saat laptop/kantor tidak dibuka
 *   - worker Remotion di VPS (membaca hasilnya sebagai props)
 *
 * Storyboard:
 * { title, brand, pack, theme:{bg1,bg2,accent,text}, music:'upbeat'|'calm'|'none', voice:'female'|'male'|'none',
 *   caption, scenes:[{ t, sec, narration, media?, …isi template }] }
 * ========================================================================= */
(function () {
  const root = typeof window !== 'undefined' ? window : globalThis;
  const VO = (root.VO = root.VO || {});
  const B = (VO.videoBoard = {});

  B.TEMPLATES = {
    title: 'Judul pembuka besar + subjudul (hook)',
    stat: 'Satu angka besar yang menghitung naik + keterangan (mis. "16,7 ms")',
    compare: 'Grafik perbandingan 2–4 nilai dengan satuan (mis. ChatGPT 2,9 Wh vs Google 0,3 Wh)',
    bullets: 'Daftar 2–5 poin singkat yang muncul satu per satu',
    steps: 'Langkah bernomor / urutan proses (2–5 langkah)',
    quote: 'Kutipan + sumber',
    countdown: 'Hitung mundur angka (3–10) dengan label, untuk membangun penasaran',
    versus: 'Dua kolom A vs B (mis. mitos vs fakta, sebelum vs sesudah)',
    image: 'Foto produk / gambar dalam bingkai + judul (memakai foto dari Boss bila ada)',
    device: 'Tampilan APLIKASI / WEBSITE (aset screenshot atau rekaman layar dari Boss) di dalam mockup HP (9:16) / laptop (16:9) + judul + 1–3 label fitur ("items", maks 4 kata) yang muncul bergantian',
    media: 'Foto/video LAYAR PENUH sesuai kata kunci "media" (bahasa Inggris, dicari di foto/video stok) + judul di atasnya',
    price: 'Harga / promo besar',
    cta: 'Penutup: janji utama (title) + tombol ajakan (action, 2–3 kata kerja) + akun/website (sub)',
  };
  B.STYLES = {
    explainer: { label: 'Penjelasan / fakta (explainer)', hint: 'title → media/stat/compare → bullets → quote/versus → cta' },
    tips: { label: 'Tips / tutorial', hint: 'title → steps → media → bullets → cta' },
    iklan: { label: 'Iklan produk', hint: 'title (hook masalah) → versus/stat (masalah) → image/media (produk) → 2–3 adegan manfaat (satu ide per adegan) → price/quote (penawaran/bukti) → cta' },
    aplikasi: { label: 'Iklan aplikasi / software', hint: 'title (hook masalah) → versus (cara lama vs aplikasi) → device (aplikasi bekerja) → device/steps (cara pakai) → stat/quote (bukti) → cta' },
    berita: { label: 'Berita singkat', hint: 'title → media → stat → bullets → quote → cta' },
    perbandingan: { label: 'Perbandingan', hint: 'title → compare → versus → bullets → cta' },
    teaser: { label: 'Teaser / pengumuman', hint: 'countdown → title → media → bullets → cta' },
  };
  // Paket visual: tampilan, font, animasi & transisi yang berbeda (dirender oleh Remotion)
  B.PACKS = {
    bold: { label: 'Bold — gradien berani, teks memantul', theme: { bg1: '#0b1020', bg2: '#1c2a5a', accent: '#ffcc33', text: '#ffffff' } },
    minimal: { label: 'Minimalis — bersih, banyak ruang, geser halus', theme: { bg1: '#f5f3ee', bg2: '#e9e5dc', accent: '#111111', text: '#111111' } },
    neon: { label: 'Neon — gelap, cahaya neon, efek glitch', theme: { bg1: '#05010f', bg2: '#140a2e', accent: '#00f0ff', text: '#ffffff' } },
    editorial: { label: 'Editorial — gaya majalah, serif besar, blok warna', theme: { bg1: '#fbf7ef', bg2: '#f1e9da', accent: '#d7263d', text: '#141414' } },
    playful: { label: 'Playful — pastel, bulat, stiker & emoji', theme: { bg1: '#ffe5ec', bg2: '#d7f2ff', accent: '#7b2cbf', text: '#2b2140' } },
  };
  // aturan kualitas naskah (dikalibrasi agar iklan tidak generik)
  B.QUALITY = [
    'ATURAN KUALITAS (wajib):',
    '- Detik 0–2 harus menghentikan scroll: buka dengan masalah spesifik penonton, pertanyaan tajam, atau klaim berani dengan angka. JANGAN buka dengan nama brand, sapaan, atau "Halo".',
    '- Teks di layar BUKAN salinan narasi: teks layar = kata kunci singkat (judul maks 6 kata, poin maks 4 kata); narasi = kalimat lisan lengkap.',
    '- Spesifik: pakai fitur, angka, nama, dan situasi nyata dari brief & riset. DILARANG kalimat generik seperti "kualitas terjamin", "harga bersahabat", "solusi terbaik", "kenapa harus ini?", "poin penting".',
    '- Satu adegan = satu ide. Jangan menumpuk lebih dari 3 poin dalam satu adegan.',
    '- Tulis MANFAAT, bukan fitur: "Pulang kerja tetap bisa masak dalam 10 menit" lebih baik dari "Kompor 2 tungku"; "Tagihan terkirim otomatis tiap bulan" lebih baik dari "Fitur invoice otomatis".',
    '- Penutup cta: "title" = janji utama, "action" = tombol ajakan berupa kata kerja (mis. "Coba gratis", "Pesan sekarang", "Hubungi kami") — BUKAN nama brand, "sub" = akun / website.',
  ];
  B.MAX_CUSTOM = 2; // adegan dengan animasi yang kodenya ditulis AI (tingkat 2)
  B.MUSIC = { upbeat: 'Ceria / energik', calm: 'Tenang / lo-fi', drama: 'Dramatis / sinematik', none: 'Tanpa musik' };
  B.VOICES = { female: 'Narasi suara perempuan', male: 'Narasi suara laki-laki', none: 'Tanpa narasi' };

  // jumlah aset (foto/video) dari Boss: o.assets [{kind,name}] atau satu foto lama (o.image)
  B.assetCount = (o) => (Array.isArray(o.assets) && o.assets.length ? Math.min(12, o.assets.length) : o.image ? 1 : 0);
  B.isRequest = (t) => /\b(video|reels?|shorts|tiktok)\b/i.test(String(t || '')) && /\b(buat|buatkan|bikin|bikinin|render|produksi|siapkan|susun)\b/i.test(String(t || ''));
  B.guessStyle = (brief) => (/aplikasi|\bapp\b|software|website|sistem|dashboard/i.test(brief) ? 'aplikasi' : /iklan|promo|jual|produk/i.test(brief) ? 'iklan' : /tips|cara|tutorial|langkah/i.test(brief) ? 'tips' : /\bvs\b|banding/i.test(brief) ? 'perbandingan' : /berita|update|kabar/i.test(brief) ? 'berita' : 'explainer');

  const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  const hex = (c, d) => (/^#[0-9a-f]{6}$/i.test(String(c || '')) ? c : d);
  const num = (v) => { const x = typeof v === 'number' ? v : parseFloat(String(v || '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')); return isFinite(x) ? x : 0; };
  const DEF_SEC = { title: 3, stat: 3.5, compare: 5, bullets: 5, steps: 5, quote: 4, countdown: 3.5, versus: 5, image: 3.5, media: 3.5, device: 4.5, price: 3.5, cta: 3.5 };

  function cleanScene(x) {
    const t = x && B.TEMPLATES[x.t || x.type || x.kind] ? (x.t || x.type || x.kind) : null;
    if (!t) return null;
    const list = (a, n, m) => (Array.isArray(a) ? a.map((i) => str(i, m)).filter(Boolean).slice(0, n) : []);
    const sc = { t, sec: Math.max(2, Math.min(9, Number(x.sec) || DEF_SEC[t])) };
    sc.title = str(x.title || x.headline, 80); sc.sub = str(x.sub, 110); sc.kicker = str(x.kicker, 30);
    sc.narration = str(x.narration || x.vo, 260);
    if (x.media) sc.media = str(x.media, 60);
    if (x.custom) sc.custom = str(x.custom, 300); // ide animasi khusus → worker meminta AI menulis kode Remotion-nya
    if (x.asset != null) { const n = parseInt(x.asset, 10); if (n >= 1 && n <= 12) sc.asset = n; } // aset dari Boss (nomor 1..N)
    if (t === 'stat') { sc.value = num(x.value); sc.unit = str(x.unit, 12); sc.prefix = str(x.prefix, 6); sc.label = str(x.label || x.sub, 90); sc.decimals = Math.max(0, Math.min(2, Number(x.decimals) || ((String(x.value).match(/[.,](\d+)$/) || [, ''])[1].length))); }
    if (t === 'compare') { sc.unit = str(x.unit, 10); sc.items = (Array.isArray(x.items) ? x.items : []).slice(0, 4).map((i) => ({ label: str(i && i.label, 22), value: num(i && i.value), note: str(i && i.note, 26) })).filter((i) => i.label); sc.highlight = Number(x.highlight) || 0; if (sc.items.length < 2) return null; }
    if (t === 'bullets' || t === 'steps') { sc.items = list(x.items || x.bullets, 5, 60); if (!sc.items.length) return null; }
    if (t === 'quote') { sc.text = str(x.text || x.title, 180); sc.author = str(x.author, 50); if (!sc.text) return null; }
    if (t === 'countdown') { sc.from = Math.max(3, Math.min(10, Number(x.from) || 3)); sc.label = str(x.label || x.title, 60); sc.sec = Math.max(sc.sec, sc.from * 0.7 + 0.6); }
    if (t === 'versus') { const side = (o) => ({ label: str(o && o.label, 20), items: list(o && o.items, 4, 40) }); sc.left = side(x.left); sc.right = side(x.right); if (!sc.left.items.length || !sc.right.items.length) return null; }
    if (t === 'device') sc.items = list(x.items || x.callouts, 3, 28);
    if (t === 'cta') sc.action = str(x.action || x.button, 24);
    if (t === 'price') { sc.price = str(x.price, 24) || 'Promo!'; sc.old = str(x.old || x.oldPrice, 24); }
    if (t === 'media' && !sc.media) sc.media = str(sc.title, 40);
    return sc;
  }

  /** Naskah cadangan tanpa AI (mode simulasi / AI gagal) */
  B.fallback = function (o) {
    const topic = str(String(o.brief || o.topic || 'Konten baru').replace(/^(tolong\s+)?(buat(kan)?|bikin(in)?|siapkan)\s+(sebuah\s+)?(video\s+)?(penjelasan|iklan|tentang|soal)?\s*/i, ''), 70) || 'Konten baru';
    const brand = o.brand || 'Visual Office';
    const style = o.style || B.guessStyle(topic);
    const scenes = [{ t: 'title', kicker: 'FAKTA', title: topic, sub: 'Simak sampai habis 👇', narration: `Pernah kepikiran soal ${topic.toLowerCase()}? Simak sampai habis.` }];
    if (style === 'iklan') scenes.push({ t: 'image', title: topic, narration: `Kenalin, ${topic}.` }, { t: 'bullets', title: 'Kenapa harus ini?', items: ['Kualitas terjamin', 'Harga bersahabat', 'Siap kirim hari ini'], narration: 'Kualitas terjamin, harga bersahabat, dan siap kirim hari ini.' }, { t: 'price', title: 'Harga spesial', price: o.price || 'Promo!', narration: 'Ada harga spesial buat kamu.' });
    else if (style === 'tips') scenes.push({ t: 'steps', title: 'Caranya', items: ['Pahami masalahnya', 'Coba langkah kecil', 'Evaluasi hasilnya'], narration: 'Pertama pahami masalahnya, lalu coba langkah kecil, terakhir evaluasi hasilnya.' });
    else if (style === 'teaser') scenes.unshift({ t: 'countdown', from: 3, label: 'Sebentar lagi…' });
    else scenes.push({ t: 'bullets', title: 'Poin penting', items: ['Ringkas & jelas', 'Berbasis data', 'Mudah dipraktikkan'], narration: 'Intinya ringkas, berbasis data, dan mudah dipraktikkan.' });
    for (let i = 2; i <= B.assetCount(o); i++) scenes.push({ t: i % 2 ? 'media' : 'image', title: topic, asset: i });
    scenes.push({ t: 'cta', title: o.cta || 'Follow untuk info berikutnya!', sub: brand, narration: 'Follow untuk info berikutnya!' });
    const pack = B.PACKS[o.pack] ? o.pack : 'bold';
    return B.normalize({ title: topic, brand, pack, theme: B.PACKS[pack].theme, caption: `${topic} #fyp #edukasi`, scenes }, o, true);
  };

  /** Validasi & rapikan naskah dari AI. Hasil selalu aman dirender. */
  B.normalize = function (sb, o, isFallback) {
    if (!sb || !Array.isArray(sb.scenes)) return B.fallback(o);
    let scenes = sb.scenes.map(cleanScene).filter(Boolean).slice(0, 9);
    if (scenes.length < 2) return isFallback ? { ...sb, scenes } : B.fallback(o);
    if (scenes[scenes.length - 1].t !== 'cta') scenes.push(cleanScene({ t: 'cta', title: o.cta || 'Follow untuk info berikutnya!', sub: o.brand || '' }));
    const nA = B.assetCount(o);
    if (!nA) scenes = scenes.map((x) => (x.t === 'image' || x.t === 'device' ? { ...x, t: 'media', media: x.media || x.title } : x)); // tanpa aset → pakai foto stok
    const total = Math.max(10, Math.min(60, Number(o.duration) || 25));
    const sum = scenes.reduce((a, x) => a + x.sec, 0);
    scenes = scenes.map((x) => ({ ...x, sec: Math.max(x.t === 'countdown' ? x.sec : 2, Math.round(((x.sec * total) / sum) * 10) / 10) }));
    if (nA) { // setiap aset Boss dipakai: yang belum disebut AI dipasang ke adegan image → media → title
      scenes.forEach((x) => { if (x.asset > nA) delete x.asset; });
      const used = new Set(scenes.map((x) => x.asset).filter(Boolean));
      const free = []; for (let i = 1; i <= nA; i++) if (!used.has(i)) free.push(i);
      for (const t of ['device', 'image', 'media', 'title']) for (const x of scenes) if (free.length && x.t === t && !x.asset) x.asset = free.shift();
      // masih ada sisa → adegan media singkat sebelum penutup
      for (const i of free) scenes.splice(scenes.length - 1, 0, { t: 'media', sec: 2.5, title: '', sub: '', kicker: '', narration: '', asset: i });
    }
    scenes = scenes.map((x) => (x.t === 'device' && !x.asset ? { ...x, t: 'media', media: x.media || x.title } : x)); // mockup butuh screenshot
    // tingkat 2: maksimal 2 adegan dengan animasi buatan AI; bila AI tidak memilih, adegan pembuka dijadikan kustom
    const creative = o.creative !== false && o.creative !== 'off';
    if (!creative) scenes.forEach((x) => delete x.custom);
    else {
      let n = 0;
      scenes.forEach((x) => { if (x.custom && ++n > B.MAX_CUSTOM) delete x.custom; });
      if (!n && scenes[0]) scenes[0].custom = 'Hook pembuka yang mencolok dan unik untuk judul ini — tipografi kinetik / ilustrasi bergerak yang tidak ada di template';
    }
    const pack = B.PACKS[o.pack] ? o.pack : B.PACKS[sb.pack] ? sb.pack : 'bold';
    const th = {}, d = B.PACKS[pack].theme; // warna selalu dari paket visual agar tampilannya konsisten
    return {
      title: str(sb.title, 90) || str(o.brief, 90) || 'Video', brand: str(sb.brand, 30) || o.brand || 'Visual Office', pack,
      theme: { bg1: hex(th.bg1, d.bg1), bg2: hex(th.bg2, d.bg2), accent: hex(th.accent, d.accent), text: hex(th.text, d.text) },
      music: B.MUSIC[o.music] ? o.music : B.MUSIC[sb.music] ? sb.music : 'upbeat',
      voice: B.VOICES[o.voice] ? o.voice : 'female',
      caption: str(sb.caption, 900) || str(o.brief, 200), creative, scenes,
    };
  };

  /** Naskah hasil edit Boss → dirapikan tanpa mengubah keputusan Boss (durasi, urutan, aset tetap). */
  B.finalize = function (sb, nAssets) {
    let scenes = (sb.scenes || []).map(cleanScene).filter(Boolean).slice(0, 12);
    if (!scenes.length) throw new Error('Naskah kosong — minimal satu adegan yang terisi');
    scenes = scenes.map((x) => {
      if (x.asset && x.asset > (nAssets || 0)) delete x.asset;
      return (x.t === 'device' || x.t === 'image') && !x.asset ? { ...x, t: 'media', media: x.media || x.title } : x;
    });
    let n = 0; scenes.forEach((x) => { if (x.custom && ++n > B.MAX_CUSTOM) delete x.custom; });
    const pack = B.PACKS[sb.pack] ? sb.pack : 'bold';
    return {
      title: str(sb.title, 90) || 'Video', brand: str(sb.brand, 30) || 'Visual Office', pack, theme: { ...B.PACKS[pack].theme },
      music: B.MUSIC[sb.music] ? sb.music : 'upbeat', voice: B.VOICES[sb.voice] ? sb.voice : 'female',
      caption: str(sb.caption, 900), creative: scenes.some((x) => x.custom), scenes,
    };
  };

  /** Prompt AI untuk menyusun storyboard. o: { brief, style, format, duration, brand, cta, pack, image, assets:[{kind,name}] } */
  B.prompt = function (o, context) {
    const style = B.STYLES[o.style] || B.STYLES[B.guessStyle(o.brief || '')];
    const system = 'Kamu creative director & copywriter video pendek media sosial (TikTok/Reels/Shorts/YouTube) yang sudah membuat ratusan iklan & konten dengan performa tinggi. Kamu menulis naskah bahasa Indonesia sehari-hari yang tajam, spesifik, dan enak didengar. Balas HANYA JSON valid, tanpa penjelasan, tanpa ```.';
    const prompt = [
      `Buat storyboard video ${o.format === '16:9' ? 'horizontal 16:9 (YouTube)' : 'vertikal 9:16'} ±${Number(o.duration) || 25} detik, gaya: ${style.label} (urutan disarankan: ${style.hint}).`,
      `Brief dari Boss: ${o.brief}`,
      o.brand ? `Nama akun / brand: ${o.brand}` : '', o.cta ? `Ajakan penutup: ${o.cta}` : '',
      (() => {
        const A = Array.isArray(o.assets) && o.assets.length ? o.assets : o.image ? [{ kind: 'photo', name: 'foto produk' }] : [];
        return A.length ? `Boss melampirkan ${A.length} aset: ${A.map((a, i) => `${i + 1}) ${a.kind === 'video' ? 'video' : 'foto'} "${a.name || 'aset'}"`).join(', ')}. Tampilkan SEMUA aset, satu aset per adegan, dan isi field "asset" dengan nomor asetnya (1–${A.length}): screenshot / rekaman layar aplikasi atau website → template "device"; foto produk → "image" (dalam bingkai) atau "media" (layar penuh).` : '';
      })(),
      o.pack ? `Paket visual ditentukan: ${o.pack}.` : `Pilih "pack" yang paling cocok dengan topik: ${Object.entries(B.PACKS).map(([k, v]) => `${k} (${v.label})`).join('; ')}.`,
      context ? `Hasil riset & naskah kasar dari tim:\n${String(context).slice(0, 3500)}` : '',
      'Template yang tersedia (field "t"):', ...Object.entries(B.TEMPLATES).map(([k, d]) => `- ${k}: ${d}`),
      'Setiap adegan WAJIB punya "narration": kalimat yang diucapkan pengisi suara (1–2 kalimat pendek, ±2,2 kata per detik durasi adegan, bahasa lisan sehari-hari yang natural — bukan bahasa baku iklan TV, angka ditulis seperti diucapkan).',
      ...B.QUALITY,
      /iklan|aplikasi/.test(o.style || B.guessStyle(o.brief || '')) ? 'STRUKTUR IKLAN: 1) hook (masalah spesifik penonton / pertanyaan tajam / klaim berani dengan angka) → 2) perbesar masalahnya → 3) produk muncul & terlihat bekerja → 4) 2–3 manfaat, SATU manfaat per adegan, masing-masing dengan visual → 5) bukti atau penawaran (angka, testimoni, harga) → 6) cta.' : '',
      'Adegan boleh punya "media": kata kunci bahasa Inggris (2–4 kata) untuk foto/video stok latar yang relevan, mis. "data center servers".',
      'Format JSON:',
      '{"title":"judul video","brand":"…","pack":"bold|minimal|neon|editorial|playful","music":"upbeat|calm|drama","caption":"caption sosmed + 3-5 hashtag",',
      ' "scenes":[ {"t":"title","kicker":"1-2 kata","title":"maks 8 kata","sub":"…","narration":"…","media":"…","sec":3},',
      '  {"t":"media","title":"…","sub":"…","media":"keyword english","asset":2,"narration":"…","sec":3.5},',
      '  {"t":"stat","prefix":"","value":16.7,"unit":"ms","label":"…","narration":"…","sec":3.5},',
      '  {"t":"compare","title":"…","unit":"Wh","items":[{"label":"ChatGPT","value":2.9},{"label":"Google","value":0.3}],"highlight":0,"narration":"…","sec":5},',
      '  {"t":"bullets","title":"…","items":["maks 6 kata","…"],"narration":"…","sec":5}, {"t":"steps","title":"…","items":["…"],"narration":"…"},',
      '  {"t":"quote","text":"…","author":"…","narration":"…"}, {"t":"countdown","from":3,"label":"…","narration":"…"},',
      '  {"t":"versus","title":"…","left":{"label":"Mitos","items":["…"]},"right":{"label":"Fakta","items":["…"]},"narration":"…"},',
      '  {"t":"image","title":"…","sub":"…","asset":1,"narration":"…"}, {"t":"device","title":"maks 6 kata","items":["label fitur","…"],"asset":1,"narration":"…","sec":4.5},',
      '  {"t":"price","title":"…","price":"Rp…","old":"…","narration":"…"}, {"t":"cta","title":"janji utama maks 6 kata","action":"Coba gratis","sub":"@akun / website","narration":"…"} ]}',
      o.creative === false || o.creative === 'off' ? '' : 'ANIMASI KHUSUS: pilih 1–2 adegan terpenting (mis. hook pembuka atau visualisasi angka) dan beri field "custom": deskripsi singkat ide animasi yang unik & tidak bisa dibuat template biasa (mis. "angka 2,9 Wh mengisi baterai yang meledak jadi 10 bohlam", "tumpukan tagihan menyusut jadi satu notifikasi di HP", "gelas kopi terisi sambil harga turun dari Rp25 rb ke Rp18 rb") — ide HARUS berasal dari topik video ini, bukan meniru contoh. Adegan itu tetap diisi field template lengkap sebagai cadangan.',
      'Pakai 5–8 adegan, variasikan template (jangan monoton), akhiri dengan cta. Angka harus masuk akal; bila tidak yakin sebut "perkiraan". Jangan mengarang fitur yang tidak disebut di brief/riset.',
    ].filter(Boolean).join('\n');
    return { system, prompt };
  };

  /** Ambil JSON pertama dari teks jawaban AI lalu normalisasi. */
  B.parse = function (text, o) {
    const m = /\{[\s\S]*\}/.exec(String(text || ''));
    try { return B.normalize(m ? JSON.parse(m[0]) : null, o); } catch (e) { return B.fallback(o); }
  };
  B.duration = (sb) => sb.scenes.reduce((a, x) => a + x.sec, 0);
})();

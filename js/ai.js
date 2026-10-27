/* =========================================================================
 * ai.js — jembatan ke backend (local/server.js ATAU Vercel Functions):
 *   - /api/health  : cek apakah mode AI (Gemini / Claude) tersedia
 *   - /api/run     : jalankan satu agent (streaming SSE)
 * Panggilan AI diantrekan agar tidak melewati rate limit free tier Gemini,
 * dan otomatis dicoba ulang bila kena 429.
 * Jika halaman dibuka dari file:// semuanya non-aktif → mode simulasi.
 *
 * Sumber AI: selalu lewat server — server memakai 9router di VPS (NINEROUTER_BASE_URL)
 * dan pindah ke Gemini bila 9router tidak menjawab. Model dipilih otomatis oleh server.
 * ========================================================================= */
(function () {
  const VO = window.VO;
  const ai = (VO.ai = { available: false, server: false, providers: [], reason: 'Server belum dicek' });

  const isHttp = () => location.protocol === 'http:' || location.protocol === 'https:';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  ai.serverAvailable = false;
  ai.onChange = null; // dipasang main.js untuk memperbarui label status AI
  let lastState = '';
  function refresh() {
    ai.available = ai.serverAvailable;
    ai.reason = ai.serverReason;
    if (String(ai.available) !== lastState) { lastState = String(ai.available); if (ai.onChange) ai.onChange(); }
    return ai;
  }

  ai.check = async function () {
    if (!isHttp()) { ai.reason = 'Dibuka dari file:// — jalankan `npm start` atau deploy ke Vercel untuk mode AI'; return ai; }
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (r.status === 401) { location.href = '/login.html'; return ai; }
      const j = await r.json();
      ai.server = true;
      ai.serverAvailable = !!j.ai;
      ai.providers = j.providers || [];
      ai.defaultModel = j.defaultModel;
      ai.serverReason = j.reason || (j.ai ? 'AI siap' : 'API key belum diset');
    } catch (e) {
      ai.serverReason = 'Backend tidak terjangkau (mode simulasi)';
    }
    return refresh();
  };

  // Siapa yang login (Boss). null bila login tidak aktif / dibuka dari file://
  ai.me = async function () {
    if (!isHttp()) return null;
    try {
      const r = await fetch('/api/me', { cache: 'no-store' });
      if (r.status === 401) { location.href = '/login.html'; return null; }
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; }
  };

  ai.label = () => ({ '9router': '9router', gemini: 'Gemini', claude: 'Claude' })[ai.providers[0]] || 'AI';

  ai.systemPrompt = function (s, ent, long) {
    const dept = s.departments.find((d) => d.id === ent.deptId);
    const div = s.divisions.find((d) => d.id === ent.divisionId);
    const where = ent.id === 'boss' ? 'CEO / Boss' : [div && 'Divisi ' + div.name, dept && 'Departemen ' + dept.name].filter(Boolean).join(', ');
    const mem = (ent.memory || []).slice(0, VO.MEMORY_MAX);
    return [
      `Kamu adalah ${ent.name}, karyawan AI di perusahaan "${s.company.name}".`,
      `Jabatan: ${ent.role}${where ? ' (' + where + ')' : ''}.`,
      ent.prompt ? `Instruksi khusus: ${ent.prompt}` : '',
      mem.length ? 'Ingatanmu dari pekerjaan sebelumnya (gunakan bila relevan):\n' + mem.map((m) => '- ' + m.text).join('\n') : '',
      long
        ? 'Tulis hasil akhir yang lengkap dan profesional dalam bahasa Indonesia, format markdown (judul, sub-judul bernomor, poin, tabel bila perlu).'
        : 'Kerjakan bagianmu secara konkret dan ringkas (maksimal ~300 kata), gunakan bahasa Indonesia, format markdown sederhana.',
    ].filter(Boolean).join('\n');
  };

  // Lampirkan dokumen relevan dari Gudang Dokumen ke prompt
  ai.withDocs = function (s, prompt, query, excludeTaskId) {
    const docs = VO.relevantDocs(s, query, 3, excludeTaskId);
    if (!docs.length) return { prompt, docs };
    const ctx = docs.map((d, i) => `[Dokumen ${i + 1}] ${d.title} (oleh ${d.author})\n${d.content.slice(0, 1500)}`).join('\n\n');
    return { prompt: `Referensi dari Gudang Dokumen perusahaan:\n${ctx}\n\n---\n\n${prompt}`, docs };
  };

  /* ------------------------------------------------------------ satu panggilan */
  // model tidak dikirim: server memilih sendiri (9router di VPS, cadangan Gemini)
  async function runServer({ system, prompt, long }, onText) {
    const r = await fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ system, prompt, long: !!long }),
    });
    if (r.status === 401) { location.href = '/login.html'; throw new Error('Sesi login habis'); }
    if (!r.ok || !r.body) {
      const e = new Error('HTTP ' + r.status);
      e.status = r.status;
      throw e;
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const ev = JSON.parse(line.slice(5));
        if (ev.type === 'text') { full += ev.text; onText && onText(ev.text, full); }
        else if (ev.type === 'error') {
          const e = new Error(ev.message);
          e.status = ev.status;
          e.retryAfter = ev.retryAfter;
          throw e;
        } else if (ev.type === 'done' && (ev.stop_reason === 'refusal' || ev.stop_reason === 'SAFETY')) {
          throw new Error('Permintaan ditolak oleh filter keamanan model');
        }
      }
    }
    return full;
  }

  /* ------------------------------------------------------------ antrean rate limit */
  const queue = [];
  let active = 0, lastStart = 0, pumping = false;
  const MAX_CONCURRENT = 3, RPM = 15; // jeda antar-panggilan agar kuota cadangan Gemini aman

  async function pump() {
    if (pumping) return;
    pumping = true;
    while (queue.length && active < MAX_CONCURRENT) {
      const gap = 60000 / RPM;
      const wait = lastStart + gap - Date.now();
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
      const job = queue.shift();
      active++;
      job.run().finally(() => { active--; pump(); });
    }
    pumping = false;
  }

  ai.pending = () => queue.length;

  /**
   * Jalankan agent lewat antrean. onText(chunk, full) per potongan teks,
   * onWait(pesan) saat menunggu kuota ('' = mulai jalan).
   * Resolve dengan teks lengkap, atau reject bila gagal setelah retry.
   */
  ai.run = function (params, onText, onWait) {
    return new Promise((resolve, reject) => {
      let attempt = 0;
      const enqueue = () => {
        onWait && onWait(queue.length ? `Antre kuota (${queue.length + 1})` : '');
        queue.push({
          run: async () => {
            onWait && onWait('');
            try {
              resolve(await runServer(params, onText));
            } catch (e) {
              attempt++;
              if ((e.status === 429 || e.status === 503) && attempt <= 4) {
                const sec = Math.max(5, e.retryAfter || 15) * attempt;
                onWait && onWait(`Rate limit, coba lagi ${sec} detik`);
                setTimeout(enqueue, sec * 1000);
              } else reject(e);
            }
          },
        });
        pump();
      };
      enqueue();
    });
  };

})();

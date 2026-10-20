/* =========================================================================
 * ai.js — jembatan ke backend (local/server.js ATAU Vercel Functions):
 *   - /api/health  : cek apakah mode AI (Gemini / Claude) tersedia
 *   - /api/run     : jalankan satu agent (streaming SSE)
 *   - /api/events  : event live dari Claude Code hooks (hanya server lokal)
 * Panggilan AI diantrekan agar tidak melewati rate limit free tier Gemini,
 * dan otomatis dicoba ulang bila kena 429.
 * Jika halaman dibuka dari file:// semuanya non-aktif → mode simulasi.
 *
 * Sumber AI: selalu lewat server ('server') — server memakai 9router di VPS (NINEROUTER_BASE_URL)
 * dan pindah ke Gemini bila 9router tidak menjawab. Jalur 9router lokal (dipanggil langsung dari
 * browser, mode 'auto' / 'local') masih ada di kode tetapi tidak lagi bisa dipilih di aplikasi.
 * ========================================================================= */
(function () {
  const VO = window.VO;
  const ai = (VO.ai = { available: false, server: false, live: false, providers: [], reason: 'Server belum dicek' });

  const isHttp = () => location.protocol === 'http:' || location.protocol === 'https:';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------------ sumber AI: 9router lokal / server */
  const SRC_KEY = 'vo:aiSource';
  const loadSrc = () => { try { return JSON.parse(localStorage.getItem(SRC_KEY) || '{}'); } catch (e) { return {}; } };
  ai.src = Object.assign({ url: 'http://localhost:20128/v1', key: '', model: '' }, loadSrc(), { mode: 'server' });
  ai.local = { ok: false, checked: 0, error: '', models: [] };
  ai.serverAvailable = false;
  ai.onChange = null; // dipasang main.js untuk memperbarui label status AI
  ai.saveSource = function (o) {
    Object.assign(ai.src, o);
    try { localStorage.setItem(SRC_KEY, JSON.stringify(ai.src)); } catch (e) { /* mode privat */ }
  };
  const localBase = () => String(ai.src.url || '').trim().replace(/\/+$/, '');
  const localHeaders = () => ({ 'content-type': 'application/json', ...(ai.src.key ? { authorization: 'Bearer ' + ai.src.key } : {}) });
  ai.usingLocal = () => ai.src.mode === 'local' || (ai.src.mode === 'auto' && ai.local.ok);
  let lastState = '';
  function refresh() {
    ai.available = ai.serverAvailable || ai.usingLocal();
    ai.reason = ai.usingLocal()
      ? `9router lokal (${localBase()})` + (ai.local.ok ? '' : ' — belum terjangkau: ' + (ai.local.error || '?'))
      : ai.serverReason + (ai.src.mode === 'auto' && ai.local.checked ? ' · 9router lokal tidak terdeteksi' : '');
    const now = ai.available + '|' + ai.usingLocal();
    if (now !== lastState) { lastState = now; if (ai.onChange) ai.onChange(); }
    return ai;
  }
  ai.refresh = refresh;

  /** Cek 9router di komputer ini (GET /models, maks. 2,5 dtk). */
  ai.probeLocal = async function () {
    if (ai.src.mode === 'server' || !localBase()) { ai.local.ok = false; refresh(); return false; }
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 2500);
    try {
      const r = await fetch(localBase() + '/models', { headers: localHeaders(), signal: ac.signal, cache: 'no-store' });
      ai.local.ok = r.ok;
      ai.local.error = r.ok ? '' : 'HTTP ' + r.status + (r.status === 401 ? ' (API key 9router salah / belum diisi)' : '');
      if (r.ok) { const j = await r.json().catch(() => null); ai.local.models = ((j && j.data) || []).map((m) => m.id).filter(Boolean); }
    } catch (e) {
      ai.local.ok = false;
      ai.local.error = 'tidak terjangkau (9router belum jalan, atau browser memblokir akses jaringan lokal)';
    } finally { clearTimeout(t); }
    ai.local.checked = Date.now();
    refresh();
    return ai.local.ok;
  };

  ai.check = async function () {
    if (!isHttp()) { ai.reason = 'Dibuka dari file:// — jalankan `npm start` atau deploy ke Vercel untuk mode AI'; return ai; }
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (r.status === 401) { location.href = '/login.html'; return ai; }
      const j = await r.json();
      ai.server = true;
      ai.serverAvailable = !!j.ai;
      ai.live = !!j.live;
      ai.providers = j.providers || [];
      ai.defaultModel = j.defaultModel;
      ai.serverReason = j.reason || (j.ai ? 'AI siap' : 'API key belum diset');
    } catch (e) {
      ai.serverReason = 'Backend tidak terjangkau (mode simulasi)';
    }
    await ai.probeLocal();
    return refresh();
  };
  // mode Otomatis: cek ulang 9router lokal berkala & saat kembali online / membuka tab
  setInterval(() => { if (ai.src.mode === 'auto' && document.visibilityState === 'visible') ai.probeLocal(); }, 30000);
  window.addEventListener('online', () => ai.probeLocal());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ai.src.mode === 'auto') ai.probeLocal(); });

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

  ai.label = () => (ai.usingLocal() ? '9router lokal' : ({ '9router': '9router', gemini: 'Gemini', claude: 'Claude' })[ai.providers[0]] || 'AI');

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
  // SSE OpenAI-compatible: baris `data: {choices:[{delta:{content}}]}` diakhiri `data: [DONE]`
  async function runLocal({ system, prompt, long }, onText) {
    const model = ai.src.model || ai.local.models[0] || '';
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });
    let r;
    try {
      r = await fetch(localBase() + '/chat/completions', {
        method: 'POST', headers: localHeaders(),
        body: JSON.stringify({ model: model || undefined, messages, stream: true, max_tokens: long ? 8192 : 2048 }),
      });
    } catch (e) { throw Object.assign(new Error('9router lokal tidak terjangkau'), { network: true }); }
    if (!r.ok || !r.body) {
      const j = await r.json().catch(() => ({}));
      throw Object.assign(new Error('9router lokal: ' + ((j.error && (j.error.message || j.error)) || 'HTTP ' + r.status)), { status: r.status });
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return full;
        let j;
        try { j = JSON.parse(data); } catch (e) { continue; }
        if (j.error) throw Object.assign(new Error('9router lokal: ' + (j.error.message || j.error)), { status: j.error.code || 502 });
        const c = j.choices && j.choices[0];
        const t = c && ((c.delta && c.delta.content) || (c.message && c.message.content));
        if (t) { full += t; onText && onText(t, full); }
      }
    }
    return full;
  }

  async function runOnce(params, onText) {
    if (ai.usingLocal()) {
      let sent = false;
      try { return await runLocal(params, (t, f) => { sent = true; onText && onText(t, f); }); }
      catch (e) {
        // mode Otomatis & 9router mendadak mati (mis. laptop dibawa keluar) → pakai AI server
        if (!e.network || sent || ai.src.mode !== 'auto' || !ai.serverAvailable) throw e;
        ai.local.ok = false; ai.local.error = 'terputus'; refresh();
      }
    }
    return runServer(params, onText);
  }

  async function runServer({ model, system, prompt, long }, onText) {
    const r = await fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, system, prompt, long: !!long }),
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
  const MAX_CONCURRENT = 3;

  async function pump() {
    if (pumping) return;
    pumping = true;
    while (queue.length && active < MAX_CONCURRENT) {
      const rpm = Math.max(1, (VO.app && VO.app.state.settings.rpm) || 10);
      const gap = 60000 / rpm;
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
              resolve(await runOnce(params, onText));
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

  /* ------------------------------------------------------------ live events */
  ai.listen = function (onEvent) {
    if (!isHttp() || !window.EventSource || !ai.live) return null;
    const es = new EventSource('/api/events');
    es.onmessage = (m) => {
      try { onEvent(JSON.parse(m.data)); } catch (e) { /* abaikan event rusak */ }
    };
    return es;
  };
})();

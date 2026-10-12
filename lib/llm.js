/* =========================================================================
 * lib/llm.js — lapisan LLM bersama untuk server lokal (local/server.js) dan
 * Vercel Functions (api/*.js).
 *
 * Provider:
 *   - Gemini (default, ada free tier)  → GEMINI_API_KEY (atau GOOGLE_API_KEY)
 *   - Claude (opsional)                → ANTHROPIC_API_KEY
 *   - 9router (router OpenAI-compatible di VPS sendiri)
 *       NINEROUTER_BASE_URL  mis. https://38-9-46-94.sslip.io/v1
 *       NINEROUTER_API_KEY   key dari dashboard 9router
 *       NINEROUTER_MODEL     model/combo default di 9router (opsional)
 *     Bila 9router dikonfigurasi, SEMUA agen memakai 9router (kecuali AI_PROVIDER=gemini/claude).
 * Model dipilih per agen; provider ditentukan dari prefix nama model.
 * ========================================================================= */

export const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-pro-latest'];
export const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'];
const DEFAULT_GEMINI = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const MAX_OUTPUT = Number(process.env.LLM_MAX_OUTPUT_TOKENS || 2048);

const geminiKey = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const anthropicKey = () => process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '';
// 9router: endpoint OpenAI-compatible (/v1/chat/completions)
const routerBase = () => {
  let u = String(process.env.NINEROUTER_BASE_URL || process.env.ROUTER_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  u = u.replace(/\/chat\/completions$/, '');
  return /\/v\d+$/.test(u) ? u : u + '/v1';
};
const routerKey = () => String(process.env.NINEROUTER_API_KEY || process.env.ROUTER_API_KEY || '').trim();
const routerModel = () => String(process.env.NINEROUTER_MODEL || process.env.ROUTER_MODEL || '').trim();
const routerOn = () => !!routerBase();
// provider utama: 9router bila dikonfigurasi (bisa dipaksa lewat AI_PROVIDER)
const primary = () => {
  const p = String(process.env.AI_PROVIDER || '').toLowerCase();
  if (p === 'gemini' && geminiKey()) return 'gemini';
  if (p === 'claude' && anthropicKey()) return 'claude';
  if (routerOn()) return '9router';
  return geminiKey() ? 'gemini' : anthropicKey() ? 'claude' : null;
};

let gemini, claude;
async function geminiClient() {
  if (!gemini) {
    const { GoogleGenAI } = await import('@google/genai');
    gemini = new GoogleGenAI({ apiKey: geminiKey() });
  }
  return gemini;
}
async function claudeClient() {
  if (!claude) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    claude = new Anthropic();
  }
  return claude;
}

export function status() {
  const providers = [];
  const main = primary();
  if (main) providers.push(main);
  if (geminiKey() && main !== 'gemini') providers.push('gemini');
  if (anthropicKey() && main !== 'claude') providers.push('claude');
  if (routerOn() && main !== '9router') providers.push('9router');
  const NAME = { gemini: 'Gemini', claude: 'Claude', '9router': '9router' };
  return {
    ai: providers.length > 0,
    providers,
    primary: main,
    defaultModel: main === '9router' ? '9router' : main === 'gemini' ? DEFAULT_GEMINI : main === 'claude' ? 'claude-opus-5-5' : null,
    routerModel: routerOn() ? routerModel() || null : undefined,
    reason: providers.length
      ? 'AI siap: ' + providers.map((p) => NAME[p]).join(' + ') + (main === '9router' && routerModel() ? ` (model ${routerModel()})` : '')
      : 'Set NINEROUTER_BASE_URL + NINEROUTER_API_KEY (9router) atau GEMINI_API_KEY, lalu restart / redeploy',
  };
}

// Pilih model yang benar-benar bisa dipakai dengan kunci yang tersedia.
function resolveModel(model) {
  const m = String(model || '');
  // '9router' / '9router:<model>' → selalu ke 9router; selain itu ke 9router bila menjadi provider utama
  if (routerOn() && (m === '9router' || m.startsWith('9router:') || primary() === '9router')) {
    const sub = m.startsWith('9router:') ? m.slice(8) : '';
    return { provider: '9router', model: sub || routerModel() };
  }
  if (CLAUDE_MODELS.includes(m) && anthropicKey()) return { provider: 'claude', model: m };
  if (m.startsWith('gemini-') && geminiKey()) return { provider: 'gemini', model: m };
  if (geminiKey()) return { provider: 'gemini', model: DEFAULT_GEMINI };
  if (anthropicKey()) return { provider: 'claude', model: CLAUDE_MODELS.includes(m) ? m : 'claude-opus-5-5' };
  return null;
}

export class LLMError extends Error {
  constructor(message, status = 500, retryAfter = 0) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// Pesan error Gemini sering berupa JSON bersarang — ambil pesan terdalam.
function cleanMessage(msg) {
  let m = String(msg || '');
  for (let i = 0; i < 4; i++) {
    try {
      const j = JSON.parse(m);
      const inner = j?.error?.message;
      if (!inner) break;
      m = String(inner);
    } catch { break; }
  }
  return m;
}

function wrapError(err) {
  const status = err?.status || err?.code || (/\b429\b|RESOURCE_EXHAUSTED|quota/i.test(err?.message || '') ? 429 : 500);
  const m = /retry in ([\d.]+)s/i.exec(err?.message || '') || /"retryDelay":\s*"(\d+)s"/.exec(err?.message || '');
  const retryAfter = m ? Math.ceil(parseFloat(m[1])) : status === 429 ? 20 : 0;
  const short = status === 429 ? 'Kuota/rate limit gratis tercapai' : cleanMessage(err?.message || String(err)).slice(0, 300);
  return new LLMError(short, Number(status) || 500, retryAfter);
}

/**
 * Jalankan satu agen dengan streaming. onText(chunk) dipanggil per potongan.
 * Resolve { model, stopReason }.
 */
export async function runStream({ model, system, prompt, long }, onText, signal) {
  // dokumen final (laporan ketua tim / direktur) boleh lebih panjang
  const maxOut = long ? Math.max(MAX_OUTPUT, 8192) : MAX_OUTPUT;
  const pick = resolveModel(model);
  if (!pick) throw new LLMError(status().reason, 503);
  system = String(system || '').slice(0, 12000);
  prompt = String(prompt || '').slice(0, 60000);
  if (!prompt) throw new LLMError('prompt kosong', 400);

  try {
    if (pick.provider === 'gemini') return await geminiStream(pick.model, system, prompt, maxOut, onText, signal);

    if (pick.provider === '9router') {
      // 9router (VPS) mati / tak terjangkau → pindah otomatis ke Gemini bila ada GEMINI_API_KEY
      let sent = false;
      try {
        return await routerStream(pick.model, system, prompt, maxOut, (t) => { sent = true; onText(t); }, signal);
      } catch (e) {
        if (sent || signal?.aborted || !geminiKey() || (e.status && e.status < 500 && e.status !== 404)) throw e;
        console.warn('9router gagal (' + (e.message || e) + ') → memakai Gemini');
        return await geminiStream(DEFAULT_GEMINI, system, prompt, maxOut, onText, signal);
      }
    }

    // Claude (opsional)
    const client = await claudeClient();
    const params = { model: pick.model, max_tokens: maxOut, system, messages: [{ role: 'user', content: prompt }] };
    if (pick.model !== 'claude-haiku-4-5') {
      params.output_config = { effort: 'medium' };
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }
    const api = params.betas ? client.beta.messages : client.messages;
    const stream = api.stream(params, { signal });
    stream.on('text', onText);
    const msg = await stream.finalMessage();
    return { model: msg.model, stopReason: msg.stop_reason };
  } catch (err) {
    if (signal?.aborted) return { model: pick.model, stopReason: 'aborted' };
    throw wrapError(err);
  }
}

async function geminiStream(model, system, prompt, maxOut, onText, signal) {
  const ai = await geminiClient();
  const stream = await ai.models.generateContentStream({
    model,
    contents: prompt,
    config: { systemInstruction: system || undefined, maxOutputTokens: maxOut, abortSignal: signal },
  });
  let finish = null;
  for await (const chunk of stream) {
    if (signal?.aborted) break;
    const t = chunk.text;
    if (t) onText(t);
    finish = chunk.candidates?.[0]?.finishReason || finish;
  }
  return { model, stopReason: finish };
}

// 9router / endpoint OpenAI-compatible: streaming SSE `data: {choices:[{delta:{content}}]}`
async function routerStream(model, system, prompt, maxOut, onText, signal) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const body = { messages, stream: true, max_tokens: maxOut };
  if (model) body.model = model;
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream, application/json' };
  if (routerKey()) headers.authorization = 'Bearer ' + routerKey();
  // batas waktu tersambung 12 dtk (VPS mati tidak membuat tugas menggantung); streaming sesudahnya bebas
  const ac = new AbortController();
  const stop = () => ac.abort();
  signal?.addEventListener('abort', stop);
  const t = setTimeout(stop, 12000);
  let r;
  try { r = await fetch(routerBase() + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal }); }
  catch (e) { throw Object.assign(new Error('9router tidak terjangkau: ' + (e.cause?.code || e.message)), { status: 502 }); }
  finally { clearTimeout(t); }
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    let msg = txt;
    try { const j = JSON.parse(txt); msg = j?.error?.message || j?.message || txt; } catch {}
    const e = new Error(`9router ${r.status}: ${String(msg).slice(0, 240) || r.statusText}`);
    e.status = r.status === 401 || r.status === 403 ? 502 : r.status;
    if (r.status === 401 || r.status === 403) e.message = '9router menolak API key (cek NINEROUTER_API_KEY): ' + String(msg).slice(0, 160);
    throw e;
  }
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('text/event-stream')) { // router menjawab tanpa streaming
    const j = await r.json();
    const t = j?.choices?.[0]?.message?.content || '';
    if (t) onText(t);
    return { model: j?.model || model || '9router', stopReason: j?.choices?.[0]?.finish_reason || null };
  }
  const dec = new TextDecoder();
  let buf = '', finish = null, usedModel = model || '9router';
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return { model: usedModel, stopReason: finish };
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw Object.assign(new Error(j.error.message || String(j.error)), { status: j.error.code || 502 });
      if (j.model) usedModel = j.model;
      const c = j.choices?.[0];
      const t = c?.delta?.content ?? c?.message?.content;
      if (t) onText(t);
      if (c?.finish_reason) finish = c.finish_reason;
    }
  }
  return { model: usedModel, stopReason: finish };
}

/* ------------------------------------------------------------ helper HTTP (Node req/res) */
export async function readJson(req, limit = 1_000_000) {
  if (req.body && typeof req.body === 'object') return req.body; // Vercel sudah mem-parse
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new LLMError('Body terlalu besar', 413);
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// Handler /api/run yang sama untuk server lokal & Vercel → respons SSE.
export async function handleRun(req, res) {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end('Method Not Allowed'); }
  // pertahanan lapis kedua (middleware juga mengecek): wajib login
  const { gate } = await import('./auth.js');
  if (!(await gate('/api/run', req.headers.cookie)).ok) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"Belum login"}'); }
  let body;
  try { body = await readJson(req); } catch { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":"JSON tidak valid"}'); }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  try {
    const r = await runStream(body, (text) => send({ type: 'text', text }), ac.signal);
    send({ type: 'done', stop_reason: r.stopReason, model: r.model });
  } catch (err) {
    if (!ac.signal.aborted) send({ type: 'error', message: err.message, status: err.status || 500, retryAfter: err.retryAfter || 0 });
  }
  res.end();
}

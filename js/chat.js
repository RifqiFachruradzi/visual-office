/* =========================================================================
 * chat.js — mengobrol langsung dengan karyawan agent AI.
 * Klik karyawan → panel chat terbuka. Jawaban memakai Gemini (persona,
 * ingatan, dokumen relevan; karyawan departemen Gudang juga membaca data
 * Gudang-Document). Riwayat chat tersimpan per karyawan.
 * ========================================================================= */
(function () {
  const VO = window.VO;
  const $ = (id) => document.getElementById(id);
  const chat = (VO.chat = { agentId: null, busy: false });
  const S = () => VO.app.state;
  const MAX_MSG = 30;

  const fmt = (t) => new Date(t).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

  chat.open = function (id) {
    const a = VO.findEntity(S(), id);
    if (!a || id === 'boss') return chat.close();
    chat.agentId = id;
    a.chat = a.chat || [];
    $('chat').classList.remove('hidden');
    chat.render();
    setTimeout(() => $('chatInput').focus(), 0);
  };

  chat.close = function () {
    chat.agentId = null;
    $('chat').classList.add('hidden');
  };

  chat.render = function () {
    const a = chat.agentId && VO.findEntity(S(), chat.agentId);
    if (!a) return chat.close();
    $('chatImg').src = VO.render.portrait(a);
    $('chatName').textContent = a.name;
    const dept = S().departments.find((d) => d.id === a.deptId);
    $('chatRole').textContent = [a.role, dept && dept.name].filter(Boolean).join(' · ');
    const msgs = a.chat || [];
    $('chatBody').innerHTML = msgs.length
      ? msgs.map((m) => `<div class="msg ${m.from === 'boss' ? 'me' : 'ag'}">${m.from === 'boss' ? VO.esc(m.text) : VO.ui.md(m.text)}<span class="t">${fmt(m.t)}</span></div>`).join('')
      : `<div class="empty">Mulai obrolan dengan ${VO.esc(a.name)}. Tanyakan progres, minta ide, atau beri instruksi singkat.</div>`;
    $('chatBody').scrollTop = $('chatBody').scrollHeight;
    const ai = S().settings.aiMode && VO.ai.available;
    const integ = VO.integ.forEnt(S(), a);
    $('chatNote').textContent = ai
      ? `Dijawab oleh ${VO.ai.label()}${integ ? ' · membaca data ' + integ.label : ''}`
      : 'Mode simulasi — aktifkan AI di bar atas untuk jawaban sungguhan.';
  };

  function push(a, from, text) {
    a.chat = a.chat || [];
    a.chat.push({ from, text: String(text).slice(0, 4000), t: Date.now() });
    if (a.chat.length > MAX_MSG) a.chat.splice(0, a.chat.length - MAX_MSG);
    VO.app.changed();
  }

  chat.send = async function (text) {
    const a = chat.agentId && VO.findEntity(S(), chat.agentId);
    text = String(text || '').trim();
    if (!a || !text || chat.busy) return;
    push(a, 'boss', text);
    chat.busy = true;
    chat.render();
    VO.sim.say(a.id, 'Membalas chat...', 3, 'chat');
    const rt = VO.sim.rt.get(a.id);
    if (rt && !rt.working) rt.status = 'chat';

    // pesan agen sementara (diisi streaming)
    push(a, 'agent', '…');
    const reply = a.chat[a.chat.length - 1];
    chat.render();

    try {
      if (S().settings.aiMode && VO.ai.available) {
        const history = a.chat.slice(-12, -2).map((m) => `${m.from === 'boss' ? 'Boss' : a.name}: ${m.text}`).join('\n');
        let prompt = `${history ? 'Riwayat obrolan sebelumnya:\n' + history + '\n\n' : ''}Boss: ${text}\n\nBalas sebagai ${a.name} (${a.role}) dengan bahasa Indonesia yang santai tapi profesional, singkat dan jelas (maksimal ~150 kata kecuali diminta lebih panjang).`;
        prompt = VO.ai.withDocs(S(), prompt, text, null).prompt;
        const integ = VO.integ.forEnt(S(), a);
        if (integ) {
          // satu kali tarik data per menit untuk chat agen terintegrasi
          prompt = await integ.augment({ id: 'chat-' + a.id + '-' + Math.floor(Date.now() / 60000) }, prompt);
        }
        await VO.ai.run(
          { system: VO.ai.systemPrompt(S(), a), prompt },
          (_, full) => { reply.text = full; chat.render(); },
          (w) => { if (w) { reply.text = w; chat.render(); } }
        );
        VO.remember(a, `Chat dengan Boss: "${text.slice(0, 80)}" → ${reply.text.replace(/\s+/g, ' ').slice(0, 160)}`);
      } else {
        await new Promise((r) => setTimeout(r, 700));
        reply.text = `Siap, Bos! Pesan "${text.slice(0, 60)}" sudah saya catat.\n\n_(Mode simulasi — aktifkan AI di bar atas agar saya bisa menjawab sungguhan.)_`;
      }
      VO.sim.say(a.id, 'Sudah dibalas', 2, 'check');
    } catch (e) {
      reply.text = 'Maaf, gagal menjawab: ' + e.message;
      VO.sim.say(a.id, 'Ada kendala', 2, 'alert');
    } finally {
      reply.t = Date.now();
      chat.busy = false;
      VO.app.changed();
      chat.render();
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    $('chatClose').addEventListener('click', chat.close);
    $('chatForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('chatInput').value;
      $('chatInput').value = '';
      chat.send(v);
    });
    $('chatInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('chatForm').requestSubmit(); }
    });
  });
})();

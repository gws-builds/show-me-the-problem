// Hands-free voice for the caller page. Mic (or the footage clip's sound) -> AudioWorklet
// (16 kHz PCM) -> our server's WebSocket -> Meta realtime transcription with turn detection.
// Barge-in: when the caller starts talking, the agent's voice stops. While the agent's tools
// run, a short filler is spoken so the line is never silent. If the socket fails, the
// "Hold to talk" button records a clip and sends it as one WAV (push-to-talk fallback).
window.Voice = (() => {
  const $ = (s) => document.getElementById(s);
  let ctx = null; let node = null; let ws = null; let callId = null; let camToken = null; let fillerTimer = null; let lastSays = 0;
  let ptt = null; // { chunks: [] } while holding to talk
  const FILLERS = ['Let me look.', 'One moment.', 'Checking that now.'];
  const state = (t) => { $('vstate').textContent = t; };

  async function setup(sourceNode) {
    await ctx.audioWorklet.addModule('/pcm-worklet.js');
    node = new AudioWorkletNode(ctx, 'pcm16k');
    sourceNode.connect(node);
    node.port.onmessage = (e) => {
      const buf = e.data;
      if (ptt) ptt.chunks.push(new Int16Array(buf));
      if (ws?.readyState === 1 && ws.ready && !ptt) ws.send(buf);
    };
    // The worklet must be pulled by the graph; a silent gain keeps it running without echo.
    const mute = ctx.createGain(); mute.gain.value = 0; node.connect(mute); mute.connect(ctx.destination);
    enablePtt();
    connect();
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/calls/${callId}/voice`);
    ws.binaryType = 'arraybuffer'; ws.ready = false;
    state('voice connecting');
    ws.onopen = () => ws.send(JSON.stringify({ token: camToken }));
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'ready') { ws.ready = true; state('listening (hands-free)'); }
      else if (m.type === 'speechStart') { if (window.Speech?.speaking) window.Speech.stop(); state('hearing you'); }
      else if (m.type === 'partial') {
        $('partial').textContent = m.text;
        // Barge-in on words that are not the agent's own line coming back through the speaker.
        if (window.Speech?.speaking && !echoOf(m.text, window.Speech.current)) window.Speech.stop();
      } else if (m.type === 'final') { $('heard').textContent = `You said: "${m.text}"`; $('partial').textContent = ''; }
      else if (m.type === 'thinking') { state('thinking'); armFiller(); }
      else if (m.type === 'ignored') { $('partial').textContent = ''; }
      else if (m.type === 'error') { $('heard').textContent = m.message; }
      else if (m.type === 'closed') { state('voice off: hold to talk'); }
    };
    ws.onclose = () => { ws.ready = false; state('voice off: hold to talk'); };
  }

  function echoOf(heard, agent) {
    const w = (s) => String(s || '').toLowerCase().match(/[a-z0-9']+/g) || [];
    const h = w(heard); const a = new Set(w(agent));
    return h.length > 0 && h.filter((x) => a.has(x)).length / h.length >= 0.7;
  }

  // Filler while tools run: if the agent has not answered within 0.9 s, say a short line.
  function armFiller() {
    clearTimeout(fillerTimer);
    lastSays = document.getElementById('line').textContent;
    fillerTimer = setTimeout(() => {
      if (document.getElementById('line').textContent === lastSays && !window.Speech?.speaking) window.Speech?.say(FILLERS[Math.floor(Math.random() * FILLERS.length)]);
      state('listening (hands-free)');
    }, 900);
  }

  // Push-to-talk fallback: hold the button, release to send one WAV to /speech.
  function enablePtt() {
    const b = $('talk'); b.disabled = false;
    const down = (e) => { e.preventDefault(); if (ptt) return; ptt = { chunks: [] }; window.Speech?.stop(); b.textContent = 'Listening… release to send'; b.classList.add('rec'); };
    const up = async (e) => {
      e.preventDefault(); if (!ptt) return;
      const chunks = ptt.chunks; ptt = null; b.textContent = 'Thinking…'; b.classList.remove('rec'); b.disabled = true;
      const n = chunks.reduce((a, c) => a + c.length, 0);
      const wav = new DataView(new ArrayBuffer(44 + n * 2)); const w = (o, s) => [...s].forEach((ch, i) => wav.setUint8(o + i, ch.charCodeAt(0)));
      w(0, 'RIFF'); wav.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true);
      wav.setUint32(24, 16000, true); wav.setUint32(28, 32000, true); wav.setUint16(32, 2, true); wav.setUint16(34, 16, true); w(36, 'data'); wav.setUint32(40, n * 2, true);
      let o = 44; for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) wav.setInt16(o, c[i], true);
      try {
        armFiller();
        const r = await fetch(`/api/calls/${callId}/speech`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'x-cam-token': camToken }, body: wav.buffer });
        const j = await r.json(); $('heard').textContent = j.heard ? `You said: "${j.heard}"` : (j.error || '');
      } catch { $('heard').textContent = 'Could not send that. Try again.'; }
      b.textContent = 'Hold to talk'; b.disabled = false;
    };
    b.onpointerdown = down; b.onpointerup = up; b.onpointerleave = (e) => { if (ptt) up(e); };
  }

  return {
    async startFromStream(stream, id, token) {
      callId = id; camToken = token;
      ctx = new AudioContext();
      await setup(ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())));
    },
    // Footage mode: the clip's own sound is the caller's voice; it also plays out loud.
    async startFromElement(el, id, token) {
      callId = id; camToken = token;
      ctx = new AudioContext();
      const src = ctx.createMediaElementSource(el); src.connect(ctx.destination);
      el.addEventListener('ended', () => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'endStream' })); });
      await setup(src);
    },
  };
})();

// Hands-free voice for the caller page. Mic (or the footage clip's sound) -> AudioWorklet
// (16 kHz PCM) -> our server's WebSocket -> Meta realtime transcription with turn detection.
// Barge-in: when the caller starts talking, the agent's voice stops. While the agent's tools
// run, a short filler is spoken so the line is never silent. If the socket fails, the
// "Hold to talk" button records a clip and sends it as one WAV (push-to-talk fallback).
window.Voice = (() => {
  const $ = (s) => document.getElementById(s);
  let ctx = null;
  let node = null;
  let ws = null;
  let callId = null;
  let camToken = null;
  let lastSays = 0;
  let ptt = null; // { chunks: [] } while holding to talk
  let rec = null; // { chunks: [] } while listening to the equipment
  let micTrack = null; // the live mic, so Listen can switch its voice filters off while recording
  // Founder 11/01: an acknowledgement the instant the caller stops talking ("On it"), then "just a few
  // moments longer" if the answer is still coming at ~5 s, and a last reassurance after 11 s. The lines
  // are made once when the call starts and kept on the phone, so they play with no wait. Never the same
  // line twice in a row; any real line cuts a filler off (Speech.say stops whatever is playing).
  const FILLERS = {
    en: [
      [150, ['On it.', 'Got it.', 'Okay, one sec.', 'Let me look.', 'Sure, checking.']],
      [
        5000,
        ['Just a few moments longer.', 'Almost there, a few more seconds.', 'Still checking, just a moment longer.'],
      ],
      [11000, ['Nearly done, thanks for waiting.', 'Still on it, almost there.']],
    ],
    es: [
      [150, ['Enseguida.', 'Entendido.', 'Déjame ver.', 'Ya voy.']],
      [5000, ['Unos momentos más.', 'Casi listo, unos segundos más.']],
      [11000, ['Ya casi, gracias por esperar.']],
    ],
  };
  let lastFiller = '';
  const pick = (lines) => {
    const pool = lines.filter((l) => l !== lastFiller);
    lastFiller = pool[Math.floor(Math.random() * pool.length)];
    return lastFiller;
  };
  let fillerTimers = [];
  const state = (t) => {
    $('vstate').textContent = t;
  };

  // iPhones pause audio when Control Center opens (starting the screen recording) or a notification
  // lands; the microphone then goes silent while the screen still says "listening". Resume it.
  function keepAwake() {
    const wake = () => {
      if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {});
    };
    ctx.onstatechange = wake;
    document.addEventListener('visibilitychange', wake);
    setInterval(wake, 3000);
  }
  window.addEventListener('speech:real', () => {
    fillerTimers.forEach(clearTimeout);
  });

  async function setup(sourceNode) {
    keepAwake();
    await ctx.audioWorklet.addModule('/pcm-worklet.js');
    node = new AudioWorkletNode(ctx, 'pcm16k');
    sourceNode.connect(node);
    node.port.onmessage = (e) => {
      const buf = e.data;
      if (ptt) ptt.chunks.push(new Int16Array(buf));
      if (rec) rec.chunks.push(new Int16Array(buf));
      if (ws?.readyState === 1 && ws.ready && !ptt && !rec) ws.send(buf);
    };
    // The worklet must be pulled by the graph; a silent gain keeps it running without echo.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute);
    mute.connect(ctx.destination);
    enablePtt();
    enableListen();
    connect();
    // The acknowledgements are made once and kept on the phone (camera.js), so "On it" has no wait.
    window.Speech?.prefetch?.(FILLERS[window.Speech?.lang === 'es' ? 'es' : 'en'].flatMap(([, lines]) => lines));
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/calls/${callId}/voice`);
    ws.binaryType = 'arraybuffer';
    ws.ready = false;
    state('voice connecting');
    ws.onopen = () => ws.send(JSON.stringify({ token: camToken }));
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.type === 'ready') {
        ws.ready = true;
        state('listening (hands-free)');
      } else if (m.type === 'speechStart') {
        if (window.Speech?.speaking) window.Speech.hush();
        state('hearing you');
      } else if (m.type === 'partial') {
        $('partial').textContent = m.text;
        // Barge-in on words that are not the agent's own line coming back through the speaker.
        if (window.Speech?.speaking && !echoOf(m.text, window.Speech.current)) window.Speech.hush();
      } else if (m.type === 'final') {
        $('heard').textContent = `You said: "${m.text}"`;
        $('partial').textContent = '';
      } else if (m.type === 'thinking') {
        state('thinking');
        armFiller();
      } else if (m.type === 'ignored') {
        $('partial').textContent = '';
      }
      // Never leave the caller hanging: an error is said out loud, not only shown (red team 10/30).
      else if (m.type === 'error') {
        $('heard').textContent = m.message;
        fillerTimers.forEach(clearTimeout);
        window.Speech?.later(m.message || 'Sorry, I lost that. Could you say it again?');
      } else if (m.type === 'closed') {
        state('voice off: hold to talk');
      }
      // The agent's line, pushed the moment it exists (camera.js speaks it; the poll is the fallback).
      else if (m.type === 'say') {
        window.dispatchEvent(new CustomEvent('agent:say', { detail: m }));
      }
      // The AI asked to hear the equipment (listen_to_equipment): record by itself, no button.
      else if (m.type === 'listen') {
        void listenNow(true);
      }
    };
    // Reconnect once after a drop (the service ends idle or long sessions); hold-to-talk works meanwhile.
    // Self-repair: reconnect after every drop (1.5 s, then slower), hold-to-talk works meanwhile.
    ws.onopen = ((open) => () => {
      connect.tries = 0;
      open();
    })(ws.onopen);
    ws.onclose = () => {
      ws.ready = false;
      state('voice off: hold to talk');
      connect.tries = (connect.tries ?? 0) + 1;
      if (connect.tries <= 20) setTimeout(connect, Math.min(10000, 1500 * connect.tries));
    };
  }

  function echoOf(heard, agent) {
    const w = (s) =>
      String(s || '')
        .toLowerCase()
        .match(/[a-z0-9']+/g) || [];
    const h = w(heard);
    const a = new Set(w(agent));
    return h.length > 0 && h.filter((x) => a.has(x)).length / h.length >= 0.7;
  }

  // Filler while tools run: if the agent has not answered within 1.2 s, say a short line.
  function armFiller() {
    fillerTimers.forEach(clearTimeout);
    lastSays = window.Speech?.heardN ?? 0;
    const lines = FILLERS[window.Speech?.lang === 'es' ? 'es' : 'en'];
    fillerTimers = lines.map(([ms, choices]) =>
      setTimeout(() => {
        const text = pick(choices);
        // Only while nothing new has been said; a filler never talks over the agent's own line.
        if ((window.Speech?.heardN ?? 0) !== lastSays) {
          fillerTimers.forEach(clearTimeout);
          return;
        }
        if (!window.Speech?.speaking || window.Speech?.isFiller) window.Speech?.say(text, { filler: true });
        state('listening (hands-free)');
      }, ms),
    );
  }

  function toWav(chunks) {
    const n = chunks.reduce((a, c) => a + c.length, 0);
    const wav = new DataView(new ArrayBuffer(44 + n * 2));
    const w = (o, s) => [...s].forEach((ch, i) => wav.setUint8(o + i, ch.charCodeAt(0)));
    w(0, 'RIFF');
    wav.setUint32(4, 36 + n * 2, true);
    w(8, 'WAVE');
    w(12, 'fmt ');
    wav.setUint32(16, 16, true);
    wav.setUint16(20, 1, true);
    wav.setUint16(22, 1, true);
    wav.setUint32(24, 16000, true);
    wav.setUint32(28, 32000, true);
    wav.setUint16(32, 2, true);
    wav.setUint16(34, 16, true);
    w(36, 'data');
    wav.setUint32(40, n * 2, true);
    let o = 44;
    for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) wav.setInt16(o, c[i], true);
    return wav;
  }

  // Listen: 8 s of the equipment itself, measured on the server (sound.js). Started by the AI on its own
  // (a 'listen' message) or by the button. The voice stream pauses meanwhile so the noise is not sent as words.
  async function listenNow(fromAi = false) {
    const b = $('listen');
    if (rec || ptt) return;
    // The AI's own line ("hold your phone near it") arrives just after the request: let it play first, so
    // the agent's voice is not in the clip (red team #5). A button press has no line to wait for.
    if (fromAi) {
      await new Promise((ok) => {
        const t = setTimeout(ok, 2000);
        window.addEventListener(
          'agent:say',
          () => {
            clearTimeout(t);
            setTimeout(ok, 300);
          },
          { once: true },
        );
      });
      for (let i = 0; i < 80 && window.Speech?.speaking && !window.Speech?.isFiller; i++)
        await new Promise((r) => setTimeout(r, 100));
    }
    window.Speech?.stop();
    if (b) b.disabled = true;
    // Phone voice filters remove exactly the hiss and hum being measured: off for these 8 s, then back on.
    const voiceFilters = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    await micTrack
      ?.applyConstraints({ echoCancellation: false, noiseSuppression: false, autoGainControl: false })
      .catch(() => {});
    rec = { chunks: [] };
    for (let s = 8; s > 0; s--) {
      if (b) b.textContent = `Listening… ${s}`;
      state(`listening to the equipment… ${s}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    const wav = toWav(rec.chunks);
    rec = null;
    if (b) b.textContent = 'Checking the sound…';
    state('listening (hands-free)');
    await micTrack?.applyConstraints(voiceFilters).catch(() => {});
    try {
      // Still answering the last thing said? Try again shortly (409), at most three times.
      let r;
      for (let i = 0; i < 4; i++) {
        r = await fetch(`/api/calls/${callId}/listen`, {
          method: 'POST',
          headers: { 'Content-Type': 'audio/wav', 'x-cam-token': camToken },
          body: wav.buffer,
        });
        if (r.status !== 409) break;
        await new Promise((ok) => setTimeout(ok, 1500));
      }
      const j = await r.json();
      $('heard').textContent = j.findings?.length
        ? `Heard: ${j.findings.map((f) => f.detail).join('; ')}`
        : j.error || 'Could not make out the sound.';
    } catch {
      $('heard').textContent = 'Could not send that. Try again.';
    }
    if (b) {
      b.textContent = 'Listen to it';
      b.disabled = false;
    }
  }
  function enableListen() {
    const b = $('listen');
    if (!b) return;
    b.disabled = false;
    b.onclick = () => void listenNow();
  }

  // Push-to-talk fallback: hold the button, release to send one WAV to /speech.
  function enablePtt() {
    const b = $('talk');
    b.disabled = false;
    const down = (e) => {
      e.preventDefault();
      if (ptt) return;
      ptt = { chunks: [] };
      window.Speech?.stop();
      b.textContent = 'Listening… release to send';
      b.classList.add('rec');
    };
    const up = async (e) => {
      e.preventDefault();
      if (!ptt) return;
      const chunks = ptt.chunks;
      ptt = null;
      b.textContent = 'Thinking…';
      b.classList.remove('rec');
      b.disabled = true;
      const wav = toWav(chunks);
      try {
        armFiller();
        const r = await fetch(`/api/calls/${callId}/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'audio/wav', 'x-cam-token': camToken },
          body: wav.buffer,
        });
        const j = await r.json();
        $('heard').textContent = j.heard ? `You said: "${j.heard}"` : j.error || '';
      } catch {
        $('heard').textContent = 'Could not send that. Try again.';
      }
      b.textContent = 'Hold to talk';
      b.disabled = false;
    };
    b.onpointerdown = down;
    b.onpointerup = up;
    b.onpointerleave = (e) => {
      if (ptt) up(e);
    };
  }

  return {
    async startFromStream(stream, id, token) {
      callId = id;
      camToken = token;
      micTrack = stream.getAudioTracks()[0] ?? null;
      ctx = new AudioContext();
      await setup(ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())));
    },
    // Footage mode: the clip's own sound is the caller's voice; it also plays out loud.
    async startFromElement(el, id, token) {
      callId = id;
      camToken = token;
      ctx = new AudioContext();
      const src = ctx.createMediaElementSource(el);
      src.connect(ctx.destination);
      el.addEventListener('ended', () => {
        if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'endStream' }));
      });
      await setup(src);
    },
  };
})();

// The caller's side: camera frames at 1 fps, push-to-talk audio as 16 kHz WAV,
// the agent's lines read aloud. All agent text is set with textContent.
const [id, cam] = location.hash.slice(1).split('.');
const $ = (s) => document.getElementById(s);
const api = (path, opts = {}) => fetch(`/api/calls/${id}${path}`, { ...opts, headers: { 'x-cam-token': cam, ...(opts.headers || {}) } });
let stream = null; let spoken = 0; let lastView = null;

function speak(text) {
  try { const u = new SpeechSynthesisUtterance(text); u.rate = 1.02; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch { /* text is on screen anyway */ }
}

async function sendFrame() {
  const v = $('v');
  if (!v.videoWidth) return;
  const scale = Math.min(1, 768 / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  await api('/frame', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: c.toDataURL('image/jpeg', 0.7) }) }).catch(() => {});
}

function drawBoxes(boxes) {
  const v = $('v'); const ov = $('ov'); const r = ov.getBoundingClientRect();
  ov.width = r.width * devicePixelRatio; ov.height = r.height * devicePixelRatio;
  const g = ov.getContext('2d'); g.clearRect(0, 0, ov.width, ov.height);
  if (!boxes?.length || !v.videoWidth) return;
  // The video is drawn with object-fit: contain; boxes are in the sent frame's pixels.
  const s = Math.min(ov.width / v.videoWidth, ov.height / v.videoHeight);
  const ox = (ov.width - v.videoWidth * s) / 2; const oy = (ov.height - v.videoHeight * s) / 2;
  g.lineWidth = 3 * devicePixelRatio; g.strokeStyle = '#22c3a6';
  for (const b of boxes) {
    const k = v.videoWidth / b.width;
    g.strokeRect(ox + b.x1 * k * s, oy + b.y1 * k * s, (b.x2 - b.x1) * k * s, (b.y2 - b.y1) * k * s);
  }
}

async function poll() {
  try {
    const r = await api(''); if (!r.ok) { $('status').textContent = 'ended'; return; }
    const view = await r.json(); lastView = view;
    $('status').textContent = view.status.replace('_', ' '); $('status').className = `pill ${view.status}`;
    const last = view.says[view.says.length - 1];
    if (last) $('line').textContent = last.text;
    for (const s of view.says) if (s.n > spoken) { spoken = s.n; if (stream) speak(s.text); }
    drawBoxes(view.boxes);
  } catch { /* next poll */ }
  setTimeout(poll, 1200);
}

// Push-to-talk recorder: raw PCM from the mic, downsampled to 16 kHz, wrapped as WAV.
let rec = null;
function startRec() {
  const ctx = new AudioContext(); const src = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1); const chunks = [];
  node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  src.connect(node); node.connect(ctx.destination);
  rec = { ctx, src, node, chunks, timer: setTimeout(stopRec, 30000) };
  $('talk').textContent = 'Listening… tap to send'; $('talk').classList.add('rec');
  speechSynthesis.cancel();
}
function wav(samples, rate) {
  const b = new ArrayBuffer(44 + samples.length * 2); const d = new DataView(b);
  const w = (o, s) => [...s].forEach((ch, i) => d.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); d.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, rate, true);
  d.setUint32(28, rate * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); w(36, 'data'); d.setUint32(40, samples.length * 2, true);
  samples.forEach((x, i) => d.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x)) * 0x7fff, true));
  return new Blob([b], { type: 'audio/wav' });
}
async function stopRec() {
  if (!rec) return;
  const { ctx, src, node, chunks, timer } = rec; rec = null; clearTimeout(timer);
  src.disconnect(); node.disconnect(); const rate = ctx.sampleRate; await ctx.close();
  $('talk').textContent = 'Thinking…'; $('talk').classList.remove('rec'); $('talk').disabled = true;
  const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0)); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  const step = rate / 16000; const out = new Float32Array(Math.floor(all.length / step));
  for (let i = 0; i < out.length; i++) out[i] = all[Math.floor(i * step)];
  try {
    const r = await api('/speech', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav(out, 16000) });
    const j = await r.json(); $('heard').textContent = j.heard ? `You said: "${j.heard}"` : (j.error || '');
  } catch { $('heard').textContent = 'Could not send that. Try again.'; }
  $('talk').textContent = 'Tap to talk'; $('talk').disabled = false;
}

$('talk').addEventListener('click', () => (rec ? stopRec() : startRec()));
$('typed').addEventListener('submit', async (e) => {
  e.preventDefault(); const text = $('t').value.trim(); if (!text) return;
  $('t').value = ''; $('heard').textContent = 'Thinking…';
  const r = await api('/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }).catch(() => null);
  const j = r ? await r.json() : {}; $('heard').textContent = j.heard ? `You said: "${j.heard}"` : (j.error || '');
});
$('go').addEventListener('click', async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: { echoCancellation: true, noiseSuppression: true } });
    $('v').srcObject = new MediaStream(stream.getVideoTracks());
    $('consent').hidden = true; $('talk').disabled = false;
    setInterval(sendFrame, 1000);
    if (lastView?.says?.length) speak(lastView.says[lastView.says.length - 1].text);
  } catch (err) { $('err').textContent = `Camera or microphone blocked: ${err.name}. You can still type below.`; }
});
if (!id || !cam) $('line').textContent = 'This link is missing its call code. Start a new call from the home page.'; else poll();

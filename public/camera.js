// The caller's side. Frames go to the server at 1 fps with their mean brightness;
// the overlay (mask outline, guidance arrow, lock) is drawn from the server's view.
// Voice: hands-free realtime transcription over a WebSocket (voice.js), with a
// push-to-talk fallback. All agent text is set with textContent.
const [id, cam, ownerTok] = location.hash.slice(1).split('.');
const $ = (s) => document.getElementById(s);
const api = (path, opts = {}) => fetch(`/api/calls/${id}${path}`, { ...opts, headers: { 'x-cam-token': cam, ...(opts.headers || {}) } });
const params = new URLSearchParams(location.search);
const FOOTAGE = params.get('footage'); // footage mode: a recorded clip analyzed live
const TAKE = params.get('take'); // recording session: cues to start/stop the screen recording, and a script card
let take = null; let takeEnded = false;
let stream = null; let spoken = 0; let lastView = null; let lastSaidGuide = ''; let lastGuideAt = 0; let started = false;
const media = () => $('v');

// ---- voice out ----
// A natural voice (server-side, only the agent's own lines); the browser voice if that fails.
// iPhones only play audio after a tap, so the first tap unlocks one reused <audio> element.
const player = new Audio(); player.preload = 'auto';
let sayN = 0;
function unlockAudio() { try { player.src = '/silence.mp3'; player.play().catch(() => {}); } catch { /* no audio */ } }
function browserSay(text) {
  try {
    const u = new SpeechSynthesisUtterance(text); u.rate = 1.05; if (lastView?.lang === 'es') u.lang = 'es-US';
    u.onstart = () => { Speech.speaking = true; Speech.current = text; };
    u.onend = u.onerror = () => { Speech.speaking = false; };
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  } catch { /* text is on screen anyway */ }
}
const Speech = {
  speaking: false, current: '', natural: true,
  async say(text) {
    const n = ++sayN; Speech.stop(); Speech.speaking = true; Speech.current = text;
    if (Speech.natural) {
      try {
        const r = await api('/say', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
        if (n !== sayN) return; // a newer line arrived while this one was being made
        if (r.ok) {
          const url = URL.createObjectURL(await r.blob()); if (n !== sayN) { URL.revokeObjectURL(url); return; }
          player.onended = player.onerror = () => { URL.revokeObjectURL(url); if (n === sayN) Speech.speaking = false; };
          player.src = url; await player.play(); return;
        }
        if (r.status === 503) Speech.natural = false; // no key or cap reached: browser voice from now on
      } catch { /* fall through to the browser voice */ }
      if (n !== sayN) return;
    }
    browserSay(text);
  },
  stop() { try { player.pause(); speechSynthesis.cancel(); } catch { /* none */ } Speech.speaking = false; },
};
document.addEventListener('click', unlockAudio, { once: true, capture: true });
window.Speech = Speech;

// ---- frames ----
const grab = document.createElement('canvas');
async function sendFrame() {
  const v = media();
  if (!v.videoWidth || (FOOTAGE && v.paused)) return;
  const scale = Math.min(1, 768 / Math.max(v.videoWidth, v.videoHeight));
  grab.width = Math.round(v.videoWidth * scale); grab.height = Math.round(v.videoHeight * scale);
  const g = grab.getContext('2d', { willReadFrequently: true }); g.drawImage(v, 0, 0, grab.width, grab.height);
  // Mean luma on a 32x32 sample: the server's lighting check uses it (no model call).
  const d = g.getImageData(0, 0, grab.width, grab.height).data; let sum = 0; let n = 0;
  const stepX = Math.max(1, Math.floor(grab.width / 32)); const stepY = Math.max(1, Math.floor(grab.height / 32));
  for (let y = 0; y < grab.height; y += stepY) for (let x = 0; x < grab.width; x += stepX) { const i = (y * grab.width + x) * 4; sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; n++; }
  const luma = Math.round(sum / n);
  $('luma').textContent = `light ${luma}/255${luma < 45 ? ' (too dark)' : ''}`;
  await api('/frame', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: grab.toDataURL('image/jpeg', 0.7), luma }) }).catch(() => {});
}

// ---- overlay ----
function drawOverlay() {
  const v = media(); const view = lastView;
  const g = view?.guidance;
  // Server clock: age = (server now - guidance time) at poll + time since the poll arrived.
  const ageMs = g?.at && view.now ? (view.now - g.at) + (Date.now() - view.receivedAt) : 0;
  Overlay.draw($('ov'), v.videoWidth, v.videoHeight, {
    records: view?.boxes ?? [], part: view?.part, guidance: g, showGuidance: Boolean(view?.tracking || g?.state === 'dark' || g?.state === 'locked'),
    hazards: (view?.checklist ?? []).filter((c) => c.geo && (c.status === 'found')).map((c) => ({ label: Overlay.hazardLabel(c), geo: c.geo, status: c.status })),
    tourItems: tourItems(view),
    ageMs: Math.max(0, ageMs),
  });
}

// Tour labels: only parts outlined on the latest tour frame, so a label never sits on an old position.
function tourItems(view) {
  const t = view?.tour; if (!t) return [];
  return t.found.filter((f) => f.geo && f.geoFrame === t.lastFrame).map((f) => ({ geo: f.geo, label: `${f.label} · ${f.statusWords}`, status: f.status }));
}

function renderFound(t) {
  $('tourStart').hidden = Boolean(t && !t.done);
  if (!t) { $('found').replaceChildren(); return; }
  $('found').replaceChildren(...t.found.map((f) => {
    const li = document.createElement('li'); li.className = `fnd ${f.status}`;
    const s = document.createElement('span'); s.className = 'st'; s.textContent = f.statusWords;
    const l = document.createElement('strong'); l.textContent = ` ${f.label}`;
    li.append(s, l);
    const d = document.createElement('div'); d.className = 'small';
    d.textContent = [f.evidence, f.status === 'cant_tell' && f.better ? `needs: ${f.better}` : '', `frame ${f.frame}`].filter(Boolean).join(' · ');
    li.append(d);
    return li;
  }));
}

function speakGuidance(g, tracking) {
  // Code-computed guidance is spoken without a model call, at most every 3 s, only while tracking.
  if (!g || !tracking || g.state === 'searching') return;
  const words = g.state === 'locked' ? 'Got it. Hold still.' : g.words;
  if (words === lastSaidGuide && Date.now() - lastGuideAt < 6000) return;
  if (Date.now() - lastGuideAt < 3000 || Speech.speaking) return;
  lastSaidGuide = words; lastGuideAt = Date.now(); Speech.say(words);
}

function renderChecklist(list) {
  const ul = $('checks'); if (!ul) return;
  ul.replaceChildren(...(list ?? []).map((c) => {
    const li = document.createElement('li'); li.className = `chk ${c.status}`;
    const s = document.createElement('span'); s.className = 'st'; s.textContent = c.status;
    const l = document.createElement('span'); l.textContent = ` ${c.label}`;
    li.append(s, l);
    if (c.frame) { const f = document.createElement('span'); f.className = 'small'; f.textContent = ` · frame ${c.frame}`; li.append(f); }
    return li;
  }));
}

async function poll() {
  try {
    const r = await api(''); if (!r.ok) { $('status').textContent = 'ended'; return; }
    const view = await r.json(); view.receivedAt = Date.now(); lastView = view;
    $('status').textContent = view.status.replace('_', ' '); $('status').className = `pill ${view.status}`;
    const last = view.says[view.says.length - 1];
    if (last) $('line').textContent = last.text;
    for (const s of view.says) if (s.n > spoken) { spoken = s.n; if (started) Speech.say(s.text); }
    speakGuidance(view.guidance, view.tracking);
    $('staged').hidden = !view.staged; $('stagedToggle').checked = Boolean(view.staged);
    renderChecklist(view.checklist);
    renderFound(view.tour);
    checkTakeEnd(view);
    if (view.latency?.p50 != null) $('lat').textContent = `turn latency p50 ${(view.latency.p50 / 1000).toFixed(1)} s (${view.latency.n} turns)`;
  } catch { /* next poll */ }
  setTimeout(poll, 700);
}
(function loop() { drawOverlay(); requestAnimationFrame(loop); })();

// ---- tap-to-point ----
$('ov').style.pointerEvents = 'auto';
$('ov').addEventListener('click', async (e) => {
  const v = media(); if (!v.videoWidth) return;
  const rect = $('ov').getBoundingClientRect();
  const f = Overlay.fit(rect.width, rect.height, v.videoWidth, v.videoHeight);
  const x = (e.clientX - rect.left - f.x) / f.w; const y = (e.clientY - rect.top - f.y) / f.h;
  if (x < 0 || y < 0 || x > 1 || y > 1) return;
  $('heard').textContent = 'Outlining what you tapped…';
  const r = await api('/tap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x, y }) }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {};
  $('heard').textContent = j.outlined ? 'Outlined.' : (j.error || 'Nothing outlined there. Try again.');
});

// ---- Light: the phone torch through the camera track (Android Chrome; iPhone Safari from iOS 17.5) ----
// iOS may not list "torch" in getCapabilities and may report a stale getSettings(), so the button is
// always offered, our own on/off state is kept, and an honest note shows when nothing reports a torch.
function setupTorch(track) {
  if (!track) return;
  const caps = track.getCapabilities?.() ?? {};
  let on = false;
  $('torch').hidden = false; $('torch').textContent = 'Light';
  $('torch').onclick = async () => {
    try {
      await track.applyConstraints({ advanced: [{ torch: !on }] });
      on = !on; $('torch').textContent = on ? 'Light off' : 'Light'; $('torch').classList.toggle('on', on);
      const reported = 'torch' in caps || 'torch' in (track.getSettings?.() ?? {});
      $('torchNote').textContent = on && !reported ? 'If no light came on, this browser cannot switch it: use a lamp or a second phone\'s flashlight.' : '';
    } catch { $('torchNote').textContent = 'This phone would not turn the light on. Use a lamp or a second phone\'s flashlight.'; }
  };
}

// Camera settings that iPhone 12 Safari accepts: rear camera, at most 1280x720. Frames sent to the
// models are scaled to 768 px anyway. If a phone refuses them, fall back to "any rear camera".
const VIDEO = { facingMode: { ideal: 'environment' }, width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 24, max: 30 } };
const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
async function openCamera() {
  try { return await navigator.mediaDevices.getUserMedia({ video: VIDEO, audio: AUDIO }); }
  catch (err) { if (err?.name !== 'OverconstrainedError' && err?.name !== 'NotReadableError') throw err; return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: AUDIO }); }
}

// ---- staged scene label ----
$('stagedToggle').addEventListener('change', async (e) => {
  await api('/staged', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ staged: e.target.checked }) }).catch(() => {});
});

// ---- typed fallback ----
$('typed').addEventListener('submit', async (e) => {
  e.preventDefault(); const text = $('t').value.trim(); if (!text) return;
  $('t').value = ''; $('heard').textContent = 'Thinking…';
  const r = await api('/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }).catch(() => null);
  const j = r ? await r.json() : {}; $('heard').textContent = j.heard ? `You said: "${j.heard}"` : (j.error || '');
});

// ---- start ----
async function start() {
  if (FOOTAGE) {
    // The clip is the camera. The caller's voice is your microphone (or the clip's own sound
    // when the clip has the caller talking in it); typing always works too.
    const v = media(); v.srcObject = null; v.src = `/footage/${encodeURIComponent(FOOTAGE)}`; v.loop = params.get('voice') !== 'clip'; v.controls = true; v.muted = params.get('voice') !== 'clip';
    await v.play().catch(() => {});
    if (params.get('voice') === 'clip') window.Voice?.startFromElement(v, id, cam);
    else {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); window.Voice?.startFromStream(stream, id, cam); }
      catch { $('heard').textContent = 'No microphone: type what you would say below.'; }
    }
    $('torchNote').textContent = 'Footage mode: recorded clip, analyzed live now.';
  } else {
    stream = await openCamera();
    media().srcObject = new MediaStream(stream.getVideoTracks());
    setupTorch(stream.getVideoTracks()[0]);
    window.Voice?.startFromStream(stream, id, cam);
  }
  started = true; $('consent').hidden = true;
  setInterval(sendFrame, 1000);
  if (lastView?.says?.length) Speech.say(lastView.says[lastView.says.length - 1].text);
}
$('go').addEventListener('click', () => start().catch((err) => { $('err').textContent = `Camera or microphone blocked: ${err.name}. You can still type below.`; }));

// ---- guided tour ----
$('tourGo').addEventListener('click', async () => {
  const r = await api('/tour', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: $('room').value }) }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {};
  if (!r?.ok) $('heard').textContent = j.error || 'Could not start the tour.';
});

// ---- recording session: cues and the take's script ----
function cue(text) { Speech.say(text); }
function checkTakeEnd(view) {
  if (!take || takeEnded || !started) return;
  if (ownerTok && view.status === 'awaiting_owner') { $('ownerStep').hidden = false; $('ownerLink').href = `/owner#${id}.${ownerTok}`; }
  const end = take.end ?? [];
  const done = ['escalated', 'handoff', 'declined'].includes(view.status) || end.includes(view.status)
    || (end.includes('tour') && view.tour?.done)
    || (end.includes('warning') && (view.checklist ?? []).some((c) => c.id === 'flammables' && c.status === 'found'));
  if (done) endTake(5000);
}
function endTake(delay = 0) {
  if (takeEnded) return; takeEnded = true;
  // Let the agent finish its last line, then cue the stop.
  const go = () => { if (Speech.speaking) return setTimeout(go, 700); $('recStop').hidden = false; $('recStop').scrollIntoView({ behavior: 'smooth' }); cue('You can stop recording now.'); };
  setTimeout(go, delay);
}
async function setupTake() {
  const takes = await fetch('/takes.json').then((r) => r.json()).catch(() => []);
  take = takes.find((t) => t.id === TAKE) ?? null;
  if (!take) return;
  $('consent').hidden = true; $('recStart').hidden = false;
  $('takeTitle').textContent = `Take: ${take.title}. ${take.setup}`;
  $('scriptTitle').textContent = take.title; $('scriptPoint').textContent = take.point;
  $('scriptSay').replaceChildren(...take.say.map((x) => { const li = document.createElement('li'); li.textContent = x; return li; }));
  cue('Start your screen recording now.'); // spoken where the browser allows it before a tap; the banner is the cue
  $('recording').onclick = async () => {
    $('recStart').hidden = true; $('script').hidden = false;
    try { await start(); } catch (err) { $('consent').hidden = false; $('err').textContent = `Camera or microphone blocked: ${err.name}.`; return; }
    if (take.staged) { await api('/staged', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ staged: true }) }).catch(() => {}); }
    if (take.tour) { $('room').value = take.tour; $('tourGo').click(); }
  };
  $('finish').onclick = () => endTake(0);
}
if (TAKE) setupTake();
if (FOOTAGE) { $('footageNote').hidden = false; $('footageLabel').hidden = false; $('go').textContent = 'Play the recorded clip (analyzed live)'; }
if (!id || !cam) $('line').textContent = 'This link is missing its call code. Start a new call from the home page.'; else poll();

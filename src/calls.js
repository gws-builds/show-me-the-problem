// Live "show me the problem" calls: one per caller, held in memory only.
// The HTTP layer (server.mjs) is thin; everything a stranger can trigger is
// bounded here so it can be tested without a network.
//
// Trust boundaries:
// - The caller holds camToken (camera + voice); the owner holds ownerToken
//   (approve/decline). The console is read-only and gets no tokens.
// - Caller words are checked for hazards in CODE before the model sees them:
//   a hazard ends quoting at once, pages the owner and blocks booking.
// - Prices only come from the verifier; bookings only from the owner's tap.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createSession, callerTurn, MAX_TURNS } from './agent.js';
import { runTool } from './tools.js';
import { hazardIn } from './verifier.js';
import { guide, DARK_LUMA } from './guidance.js';

// Fixed lines the caller page may speak besides the agent's own (recording cues, the lock).
export const SPOKEN_CUES = new Set(['Start your screen recording now.', 'You can stop recording now.', 'Got it. Hold still.']);
import { scanFrame, severityOf } from './hazards.js';
import { maskGeometry } from './mask.js';
import { workOrder } from './evidence.js';
import { createTour, tourStep, openLine, tourView, tourMemo, TOUR } from './tour.js';

export const LIMITS = {
  frameBytes: 400_000, // data URL length, ~300 KB JPEG
  wavBytes: 1_300_000, // ~40 s of 16 kHz mono
  textChars: 300,
  frameEveryMs: 800,
  speechEveryMs: 1500,
  callTtlMs: 15 * 60_000,
  maxLiveCalls: 10,
  callsPerIpPerHour: 6,
  trackChecks: 8, // SAM re-checks while the caller moves the camera (each updates the guidance arrow)
  trackEveryMs: 1500,
  hazardScans: 12, // camera hazard scans per call (2 min of camera at one per 10 s) (Spark lists, SAM must agree)
  scanEveryMs: 10_000,
  tourSteps: TOUR.steps, // guided-tour steps per call (Spark names parts, SAM outlines them)
  tourEveryMs: TOUR.everyMs,
};
const STOP_CODES = new Set(['RUN_CAP', 'READ_ONLY', 'HARD_STOP', 'SESSION_STOP']);

const id = (n = 16) => randomBytes(n).toString('hex');
const article = (noun) => `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;
const maskGeometryOf = (rec) => maskGeometry(rec);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class CallError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') { super(message); this.status = status; this.code = code; }
}

function nextSlots(now) {
  const out = []; const d = new Date(now);
  for (let i = 1; out.length < 3 && i < 10; i++) {
    const day = new Date(d.getTime() + i * 86_400_000);
    if (day.getDay() === 0 || day.getDay() === 6) continue;
    const label = day.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    out.push({ id: `s${out.length + 1}`, label: `${label}, ${out.length % 2 ? '1-3 PM' : '9-11 AM'}` });
  }
  return out;
}

/**
 * deps: { ledger, makeClient(live) -> Meta client, priceList, now?, onEnd?(call) }
 */
export function createCalls({ ledger, makeClient, priceList, now = () => Date.now(), onEnd = null }) {
  const calls = new Map();
  const ipHits = new Map();

  const get = (callId) => {
    const c = calls.get(String(callId));
    if (!c) throw new CallError('This call has ended or does not exist.', 404, 'NO_CALL');
    return c;
  };
  const asCaller = (callId, token) => { const c = get(callId); if (!same(token, c.camToken)) throw new CallError('Not your call.', 403, 'FORBIDDEN'); return c; };
  const asOwner = (callId, token) => { const c = get(callId); if (!same(token, c.ownerToken)) throw new CallError('Owner link required.', 403, 'FORBIDDEN'); return c; };

  const say = (c, text, status) => { c.says.push({ n: c.says.length + 1, text, status, at: now() }); c.status = status ?? c.status; };

  async function exclusive(c, fn) {
    if (c.busy) throw new CallError('Still thinking about the last thing you said.', 409, 'BUSY');
    c.busy = true;
    try { return await fn(); } finally { c.busy = false; }
  }

  const p50 = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const waitIdle = async (c, ms) => { const end = Date.now() + ms; while (c.busy && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); };

  // The agent's line is spoken; "move the camera" (or the shut-off guide) starts tracking a part.
  function afterAgent(c, r) {
    say(c, r.say, r.status);
    if (r.status === 'waiting_camera') c.tracking = { part: r.track || c.session.lastPart() || '', checks: 0, lastAt: 0 };
  }

  async function turn(c, line) {
    if (c.status === 'escalated') { say(c, 'The owner has been paged and is calling you. If you smell gas or see smoke or fire, leave the house now and call 911.', 'escalated'); return; }
    if (c.status === 'booked' || c.status === 'declined') { say(c, 'This visit is already settled. The office will text you.', c.status); return; }
    if (c.turns >= MAX_TURNS) { say(c, 'Let me get the owner to call you back to finish this.', 'handoff'); return; }
    c.turns++;
    c.session.heard(line);
    const cl = c.session.checklist;
    // Code, not the model, decides that a hazard ends the call's quoting.
    if (hazardIn(line)) {
      cl.set('words', 'found', null, `Caller said: "${line.slice(0, 120)}"`);
      const r = await runTool('escalate', { reason: `Caller said: ${line.slice(0, 200)}` }, c.ctx);
      c.session.log({ kind: 'code_gate', name: 'hazard', text: 'Hazard words heard: escalated in code before any model call.' });
      say(c, r.say, 'escalated');
      return;
    }
    cl.set('words', 'clear', null, `No hazard words in ${c.turns} caller turn(s); last: "${line.slice(0, 80)}"`);
    // Mid-tour questions ("what's that pipe?", "is that normal?") are answered from what the tour has seen so far.
    if (c.tour && !c.tour.done && c.tour.found.size) c.history.push({ role: 'user', content: `${tourMemo(c.tour).replace('The caller may now ask for a price; quote only what was seen.', 'The tour is still going.')} Answer the caller's question from this and the current frame in one or two sentences, then the tour continues.` });
    c.history.push({ role: 'user', content: `Caller: ${line}` });
    try {
      afterAgent(c, await callerTurn(c.ctx, c.history));
    } catch (err) {
      c.session.log({ kind: 'error', text: String(err.message ?? err).slice(0, 200) });
      say(c, STOP_CODES.has(err.code) ? 'Let me get the owner to call you back.' : 'Sorry, I lost that. Could you say it again?', err.code ? 'handoff' : c.status);
    }
  }

  // While the agent waits for the caller to move the camera, SAM re-checks the
  // part on new frames; as soon as it is in view the agent continues by itself.
  async function track(c) {
    const t = c.tracking;
    if (!t?.part || c.busy || t.checks >= LIMITS.trackChecks || now() - t.lastAt < LIMITS.trackEveryMs) return;
    t.checks++; t.lastAt = now();
    await exclusive(c, async () => {
      const r = await runTool('find_part', { part: t.part }, c.ctx).catch((err) => ({ output: { error: String(err.message) } }));
      const good = (r.output?.boxes ?? []).filter((b) => (b.score ?? 1) >= 0.5).length;
      const g = c.session.guidance();
      c.session.log({ kind: 'track', part: t.part, check: t.checks, boxes: good, guidance: g?.state ?? null });
      // Continue once the outline is centred and steady (hold/locked); on the last check, any confident outline will do.
      const ready = good && (g?.state === 'locked' || g?.state === 'hold' || t.checks >= LIMITS.trackChecks);
      if (!ready) { if (!good && t.checks >= LIMITS.trackChecks) { c.tracking = null; say(c, 'I still cannot see it. Could you tap it on your screen, or describe what you see?', 'waiting_caller'); } return; }
      c.tracking = null;
      c.history.push({ role: 'user', content: `[camera] The caller moved the camera. SAM now outlines "${t.part}" (${good} confident object(s), guidance: ${g?.state ?? 'n/a'}). Continue.` });
      try { afterAgent(c, await callerTurn(c.ctx, c.history)); } catch (err) { c.session.log({ kind: 'error', text: String(err.message).slice(0, 200) }); }
    });
  }

  // Camera hazards: Spark lists what it sees, SAM must outline it (>= 0.5) before anything happens.
  // Runs beside the conversation, never blocking it. Escalating categories end quoting and page
  // the owner; flammables near heat are a spoken warning plus an owner note, and the call goes on.
  // One confirmed camera finding (Spark + SAM agree), from the hazard scan or the tour: checklist,
  // owner page, spoken line. Escalating ones end quoting; the rest are a warning and the call goes on.
  async function raise(c, f, n, source) {
    const sev = severityOf(f);
    const cl = c.session.checklist;
    cl.addCheck?.(f.category);
    const detail = `${f.object}${f.near ? ` near ${f.near}` : ''}: ${f.why} (${source}; SAM outlined it at ${f.score.toFixed(2)})`;
    cl.set(f.category, sev === 'attention' ? 'attention' : 'found', n, detail, { geo: f.geo ?? null, object: f.object });
    if (c.warned.has(f.category)) return;
    c.warned.add(f.category);
    if (sev === 'escalate') {
      await c.ctx.notifyOwner({ urgent: true, reason: `Camera hazard (${f.category}): ${f.object} in frame ${n}, confirmed by Spark and SAM.` });
      c.session.log({ kind: 'code_gate', name: 'camera hazard', text: `${f.category}: ${f.object} seen by Spark and outlined by SAM (${f.score.toFixed(2)}). Escalated in code.` });
      say(c, `Stop for a moment: I can see ${article(f.object)} that looks unsafe (${f.why || f.category}). I am getting the owner on this now. Please do not touch it.`, 'escalated');
      if (c.tour) c.tour.done = true;
    } else if (sev === 'attention') {
      await c.ctx.notifyOwner({ urgent: false, reason: `Camera note (${f.category}): ${f.object}, frame ${n}. Not connected to power, so not escalated.` });
      c.session.log({ kind: 'code_gate', name: 'camera attention', text: `${f.object}: bare wire on a cord that is not connected to power. Needs attention, not escalated (knowledge-base threshold).` });
      say(c, `I can see bare wire on ${article(f.object)} that does not look plugged in. Please keep it unplugged and don't use it; the technician should replace it.`, c.status);
      // The agent hears the code's judgement, so it does not escalate the same sign again without new evidence.
      c.history.push({ role: 'user', content: `[camera check, code] ${f.object}: bare wire on a loose cord or strip that is NOT connected to power (frame ${n}). Knowledge-base threshold: needs attention, not an emergency. Do not escalate this sign again unless you see it plugged in, in a wall box or panel, or the caller reports sparks, heat or smoke. Advise not to use it; the technician replaces it.` });
    } else {
      await c.ctx.notifyOwner({ urgent: false, reason: `Camera warning (${f.category}): ${f.object}${f.near ? ` near ${f.near}` : ''}, frame ${n}.` });
      c.session.log({ kind: 'code_gate', name: 'camera warning', text: `${f.object}${f.near ? ` near ${f.near}` : ''}: spoken warning, owner noted. Call continues.` });
      say(c, `Before anything else: I can see ${article(f.object)}${f.near ? ` close to the ${f.near}` : ''}. Please move it away from the heat.`, c.status);
    }
  }

  async function scan(c) {
    const frame = c.session.latestFrame(); if (!frame) return;
    c.scanning = true; c.scans++; c.lastScanAt = now();
    try {
      const r = await scanFrame(c.client, frame);
      const n = c.session.keepFrame(frame.n, frame.dataUrl);
      const cl = c.session.checklist;
      for (const id of r.clear) cl.set(id, 'clear', n, 'Nothing seen by Muse Spark in this frame');
      for (const f of r.findings.filter((x) => x.status !== 'found')) cl.set(f.category, 'unconfirmed', n, `Spark saw "${f.object}", SAM could not outline it (${f.score.toFixed(2)}): not escalated`);
      c.session.log({ kind: 'hazard_scan', frame: n, staged: Boolean(c.staged), clear: r.clear, findings: r.findings.map(({ category, object, near, score, status, where, powered }) => ({ category, object, near, where, powered, score: Number(score.toFixed(2)), status })) });
      for (const f of r.findings.filter((x) => x.status === 'found')) await raise(c, { ...f, geo: f.record ? maskGeometryOf(f.record) : null }, n, 'Spark saw it');
    } catch (err) {
      c.session.log({ kind: 'error', text: `hazard scan: ${String(err.message).slice(0, 120)}` });
    } finally { c.scanning = false; }
  }

  // Guided tour: one step every few seconds while frames arrive. Runs beside the conversation.
  async function tourTick(c) {
    const frame = c.session.latestFrame(); if (!frame || !c.tour || c.tour.done) return;
    c.touring = true; c.lastTourAt = now();
    try {
      const r = await tourStep(c.client, c.tour, frame);
      const n = c.session.keepFrame(frame.n, frame.dataUrl);
      c.session.log({ kind: 'tour', frame: n, step: c.tour.step, room: c.tour.room, items: r.items.map(({ id, label, status, evidence, score, note, confirmScore }) => ({ id, label, status, evidence, score: score != null ? Number(score.toFixed(2)) : null, confirmScore: confirmScore != null ? Number(confirmScore.toFixed(2)) : null, note })) });
      for (const it of r.items.filter((x) => x.status === 'attention' || x.status === 'safety')) {
        if (!c.session.evidence.list().some((e) => e.kind === 'tour' && e.part === it.id && e.status === it.status)) c.session.evidence.add({ kind: 'tour', part: it.id, status: it.status, claim: `${it.label}: ${it.status === 'safety' ? 'safety issue' : 'needs attention'}, ${it.evidence}`, frame: n, confidence: it.score ?? 0.5, geo: it.geo ?? null, support: 'Muse Spark on this frame; SAM outline' });
      }
      for (const it of [...r.escalate, ...r.warn]) await raise(c, { category: it.hazard.category, object: it.label.toLowerCase(), near: '', why: it.evidence, score: it.confirmScore ?? it.score ?? 0, geo: it.geo ?? null }, n, `tour: ${it.hazard.label}`);
      if (c.status === 'escalated') return;
      if (r.say) say(c, r.say, r.done ? 'waiting_caller' : 'touring');
      if (r.done) {
        c.history.push({ role: 'user', content: tourMemo(c.tour) });
        say(c, 'Would you like a price for a visit to look at any of this?', 'waiting_caller');
        c.session.log({ kind: 'tour_done', text: `Tour of the ${c.tour.room.replace('_', ' ')} finished after ${c.tour.step} steps.` });
      }
    } catch (err) {
      c.session.log({ kind: 'error', text: `tour: ${String(err.message).slice(0, 120)}` });
      if (err?.code) { c.tour.done = true; say(c, 'I have to stop the tour here. The owner will call you back.', 'handoff'); }
    } finally { c.touring = false; }
  }

  function startTour(c, room) {
    if (c.status === 'escalated') return null;
    c.tour = createTour({ room });
    c.tour.refsFor = (q) => c.session.references?.(q, 2) ?? []; // cited trade-manual excerpts for this room
    c.session.setTourRoom(c.tour.room === 'auto' ? null : c.tour.room);
    c.client.setCap?.(TOUR.runCapUsd);
    c.tracking = null; c.lastTourAt = 0;
    const line = openLine(c.tour);
    c.session.log({ kind: 'tour_start', room: c.tour.room, text: `Guided tour started (${c.tour.room}). Spend cap for this call raised to $${TOUR.runCapUsd.toFixed(2)}.` });
    return { say: line };
  }

  function sweep() {
    for (const [k, c] of calls) if (now() - c.createdAt > LIMITS.callTtlMs) { calls.delete(k); c.voice?.end(); onEnd?.(c); }
    for (const [ip, hits] of ipHits) { const keep = hits.filter((t) => now() - t < 3_600_000); if (keep.length) ipHits.set(ip, keep); else ipHits.delete(ip); }
  }

  return {
    sweep,
    size: () => calls.size,
    /** Ends a call now (the caller hung up, or a test run finished); keeps its replay. */
    end(callId) { const c = calls.get(String(callId)); if (c) { calls.delete(c.id); c.voice?.end(); onEnd?.(c); } },

    create({ ip = 'unknown', live = false, footage = null } = {}) {
      sweep();
      if (ledger.mode() === 'stopped') throw new CallError('The spending stop for this session is reached. No new calls until a restart.', 503, 'SPEND_STOP');
      if (ledger.mode() !== 'live' && !live) throw new CallError('The live demo is resting to protect its credit. Recorded calls are on the console page.', 503, 'REPLAY_ONLY');
      if (calls.size >= LIMITS.maxLiveCalls) throw new CallError('Too many live calls right now. Try again in a few minutes.', 429, 'BUSY');
      const hits = (ipHits.get(ip) ?? []).filter((t) => now() - t < 3_600_000);
      if (hits.length >= LIMITS.callsPerIpPerHour && !live) throw new CallError('That is a lot of calls from one place. Try again later.', 429, 'RATE_LIMIT');
      ipHits.set(ip, [...hits, now()]);
      const c = {
        id: id(), camToken: id(), ownerToken: id(), createdAt: now(), turns: 0, busy: false, status: 'started', says: [], history: [], tracking: null,
        footage, pages: [], booking: null, annotated: null, latencies: [], voice: null, scans: 0, scanning: false, warned: new Set(), staged: false,
      };
      c.session = createSession({ now });
      c.client = makeClient(live);
      c.ctx = {
        client: c.client, session: c.session, priceList, calendar: nextSlots(now()),
        notifyOwner: async (m) => { c.pages.push({ ...m, at: now() }); c.session.log({ kind: 'owner_paged', reason: m.reason }); },
        startTour: (room) => startTour(c, room),
      };
      calls.set(c.id, c);
      if (footage) c.session.log({ kind: 'footage', text: `Footage mode: recorded clip "${footage}" is played in the browser and its frames go to the models live.` });
      say(c, 'Hi, this is the office. Point your camera at the problem and tell me what is going on.', 'started');
      return { id: c.id, camToken: c.camToken, ownerToken: c.ownerToken };
    },

    async frame(callId, token, image, luma = null) {
      const c = asCaller(callId, token);
      if (typeof image !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image)) throw new CallError('Frames must be JPEG data URLs.');
      if (image.length > LIMITS.frameBytes) throw new CallError('Frame too large.', 413, 'TOO_LARGE');
      if (c.lastFrameAt && now() - c.lastFrameAt < LIMITS.frameEveryMs) return { ok: true, dropped: true };
      c.lastFrameAt = now();
      const l = typeof luma === 'number' && Number.isFinite(luma) ? Math.max(0, Math.min(255, Math.round(luma))) : null;
      c.session.pushFrame(image, { luma: l });
      // Lighting check, in code: two dark frames in a row -> say how to light it (at most every 20 s).
      const dark = l != null && l < DARK_LUMA;
      if (dark && c.prevDark && (!c.darkSaidAt || now() - c.darkSaidAt > 20_000)) {
        c.darkSaidAt = now();
        const g = guide(null, { luma: l });
        c.session.setGuidance({ ...g, frame: c.session.latestFrame().n });
        c.session.log({ kind: 'lighting', luma: l, frame: c.session.latestFrame().n, text: 'Frame too dark: lighting advice given in code.' });
        say(c, g.words, c.status);
      }
      c.prevDark = dark;
      if (l != null) {
        const n = c.session.latestFrame().n;
        if (dark) c.session.checklist.set('lighting', 'found', c.session.keepFrame(n), `Too dark: light ${l}/255`);
        else if (c.session.checklist.get('lighting').status !== 'clear' || n % 10 === 0) c.session.checklist.set('lighting', 'clear', c.session.keepFrame(n), `Light ${l}/255`);
      }
      if (!dark && !c.scanning && c.scans < LIMITS.hazardScans && (!c.lastScanAt || now() - c.lastScanAt >= LIMITS.scanEveryMs)) c.scanP = scan(c);
      if (!dark && c.tour && !c.tour.done && !c.touring && c.status !== 'escalated' && (!c.lastTourAt || now() - c.lastTourAt >= LIMITS.tourEveryMs)) c.tourP = tourTick(c);
      await track(c).catch(() => {});
      return { ok: true };
    },

    async speech(callId, token, wav) {
      const c = asCaller(callId, token);
      if (!Buffer.isBuffer(wav) || wav.length < 1000) throw new CallError('No audio.');
      if (wav.length > LIMITS.wavBytes) throw new CallError('Keep each message under 40 seconds.', 413, 'TOO_LARGE');
      if (c.lastSpeechAt && now() - c.lastSpeechAt < LIMITS.speechEveryMs) throw new CallError('One message at a time.', 429, 'RATE_LIMIT');
      c.lastSpeechAt = now();
      return exclusive(c, async () => {
        let heard = '';
        try { heard = (await c.client.transcribe(wav)).slice(0, LIMITS.textChars); } catch (err) { c.session.log({ kind: 'error', text: `transcribe: ${String(err.message).slice(0, 160)}` }); }
        if (!heard) { say(c, 'I did not catch that. Could you say it again?', c.status); return { heard }; }
        await turn(c, heard);
        return { heard };
      });
    },

    /** Tap-to-point: the caller taps the part on screen (x, y in 0..1); SAM segments what is under the finger. */
    async tap(callId, token, x, y) {
      const c = asCaller(callId, token);
      if (![x, y].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) throw new CallError('Tap must be x and y between 0 and 1.');
      if (c.lastTapAt && now() - c.lastTapAt < LIMITS.speechEveryMs) throw new CallError('One tap at a time.', 429, 'RATE_LIMIT');
      c.lastTapAt = now();
      c.session.setTap(x, y);
      if (!c.session.latestFrame()) return { ok: true };
      return exclusive(c, async () => {
        const part = c.session.lastPart() || 'part the caller tapped';
        const r = await runTool('find_part', { part }, c.ctx).catch((err) => ({ output: { error: String(err.message) } }));
        const n = r.output?.boxes?.length ?? 0;
        if (n && c.tracking) {
          c.tracking = null;
          c.history.push({ role: 'user', content: `[camera] The caller tapped the part on screen. SAM now outlines ${n} object(s) for "${part}" (method: tap). Continue.` });
          try { afterAgent(c, await callerTurn(c.ctx, c.history)); } catch (err) { c.session.log({ kind: 'error', text: String(err.message).slice(0, 200) }); }
        }
        return { ok: true, outlined: n };
      });
    },

    /** A finished spoken turn from the realtime voice stream. Latency = end of speech -> the agent's line. */
    async voiceTurn(callId, text, { speechEndAt = now() } = {}) {
      const c = get(callId);
      const line = String(text ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, LIMITS.textChars);
      if (!line) return { heard: '' };
      await waitIdle(c, 15_000);
      return exclusive(c, async () => {
        const before = c.says.length;
        await turn(c, line);
        if (c.says.length > before) { const ms = now() - speechEndAt; c.latencies.push(ms); c.session.log({ kind: 'latency', ms, channel: 'voice' }); }
        return { heard: line };
      });
    },
    /** The caller marks the scene as staged: a visible label on the call page, console and replay. */
    setStaged(callId, token, staged) {
      const c = asCaller(callId, token); c.staged = Boolean(staged);
      c.session.log({ kind: 'staged', on: c.staged, text: c.staged ? 'Caller marked this as a staged scene.' : 'Staged label removed.' });
      return { ok: true, staged: c.staged };
    },
    /** Waits for a running hazard scan (eval and tests). */
    async scanDone(callId) { await get(callId).scanP; },
    /** Waits for a running tour step (eval and tests). */
    async tourDone(callId) { await get(callId).tourP; },
    /** The caller starts a guided tour from the page (button), same as the agent's start_tour tool. */
    tour(callId, token, room) {
      const c = asCaller(callId, token);
      if (c.tour && !c.tour.done) return { ok: true, room: c.tour.room };
      const r = startTour(c, room);
      if (!r) throw new CallError('This call was escalated. The owner is calling you.', 409, 'HAZARD');
      say(c, r.say, 'touring');
      return { ok: true, room: c.tour.room };
    },
    /** The newest call (the console follows it during a recording session). */
    latest() { let best = null; for (const c of calls.values()) if (!best || c.createdAt >= best.createdAt) best = c; return best ? { id: best.id } : null; },
    /** Natural voice out: only lines this call's agent said, guidance it showed, or the fixed recording cues. */
    sayable(callId, token, text) {
      const c = asCaller(callId, token); const t = String(text ?? '');
      if (!t || t.length > 600) return false;
      return SPOKEN_CUES.has(t) || c.says.some((s) => s.text === t) || Boolean(c.shownGuide?.has(t));
    },
    voiceAuth(callId, token) { const c = asCaller(callId, token); if (c.voice && !c.voice.closed) throw new CallError('Voice is already on for this call.', 409, 'BUSY'); return c; },
    setVoice(callId, v) { const c = calls.get(String(callId)); if (c) c.voice = v; },
    recentSays(callId, n = 2) { const c = calls.get(String(callId)); return c ? c.says.slice(-n).map((x) => x.text) : []; },
    logEvent(callId, e) { calls.get(String(callId))?.session.log(e); },
    clientOf(callId) { return get(callId).client; },

    async text(callId, token, text) {
      const c = asCaller(callId, token);
      const line = String(text ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, LIMITS.textChars);
      if (!line) throw new CallError('Say something first.');
      if (c.lastSpeechAt && now() - c.lastSpeechAt < LIMITS.speechEveryMs) throw new CallError('One message at a time.', 429, 'RATE_LIMIT');
      c.lastSpeechAt = now();
      const t0 = now();
      return exclusive(c, async () => {
        await turn(c, line);
        const ms = now() - t0; c.latencies.push(ms); c.session.log({ kind: 'latency', ms, channel: 'typed' });
        return { heard: line };
      });
    },

    async decide(callId, token, approve) {
      const c = asOwner(callId, token);
      const p = c.session.pendingBooking();
      if (!p) throw new CallError('Nothing is waiting for approval.', 409, 'NOTHING_PENDING');
      if (c.status === 'escalated') throw new CallError('This call was escalated as a hazard. Call the customer first.', 409, 'HAZARD');
      if (c.booking) throw new CallError('Already decided.', 409, 'DECIDED');
      c.booking = { approved: Boolean(approve), slot: p.slot, brief: p.brief, quote: p.quote, at: now(), workOrder: approve ? workOrder(c.session, { slot: p.slot, quote: p.quote }) : null };
      c.session.log({ kind: 'owner_decision', approved: Boolean(approve), slot: p.slot.label });
      if (!approve) { say(c, 'The office could not take that slot. They will text you another time.', 'declined'); return { ok: true }; }
      say(c, `You're booked for ${p.slot.label}. The technician will bring what's in the brief.`, 'booked');
      // The evidence stills are drawn in code from SAM masks (owner page). Muse Image adds a separate,
      // clearly labelled illustration; it is never used as evidence. Best effort: a failure never blocks the booking.
      const frame = c.session.latestFrame(); const box = c.session.boxes()[0];
      if (frame && box) {
        try {
          c.annotated = await c.client.annotate(frame.dataUrl, `Draw a bright red rectangle around the ${c.session.lastPart()} (pixels x ${box.x1}-${box.x2}, y ${box.y1}-${box.y2}) and a short label "${c.session.lastPart()}". Change nothing else.`);
          c.session.log({ kind: 'annotated', ok: Boolean(c.annotated) });
        } catch (err) { c.session.log({ kind: 'error', text: `annotate: ${String(err.message).slice(0, 160)}` }); }
      }
      return { ok: true };
    },

    /** Read-only view for the console and the caller's page. Never includes tokens or raw frames. */
    view(callId) {
      const c = get(callId);
      const p = c.session.pendingBooking();
      const g = c.session.guidance();
      if (g?.words) { c.shownGuide ??= new Set(); if (c.shownGuide.size < 200) c.shownGuide.add(g.words); }
      return {
        id: c.id, now: now(), status: c.status, turns: c.turns, spentUsd: Math.round(c.client.spent() * 10000) / 10000,
        says: c.says, events: c.session.events(), pages: c.pages.map(({ reason, at, urgent }) => ({ reason, at, urgent })),
        pending: p ? { slot: p.slot, brief: p.brief, quote: p.quote, workOrder: c.booking ? null : workOrder(c.session, { slot: p.slot, quote: p.quote }) } : null,
        evidence: c.session.evidence.list(),
        booking: c.booking, annotated: Boolean(c.annotated), hasFrame: Boolean(c.session.latestFrame()), staged: c.staged, checklist: c.session.checklist.list(),
        boxes: c.session.boxes(), part: c.session.lastPart(), tracking: Boolean(c.tracking), guidance: c.session.guidance(), footage: c.footage, latency: { p50: p50(c.latencies), n: c.latencies.length },
        tour: tourView(c.tour), cards: c.session.cards(), capUsd: c.client.cap?.() ?? null,
      };
    },
    frameOf(callId) { return get(callId).session.latestFrame()?.dataUrl ?? null; },
    keptFrameOf(callId, n) { return get(callId).session.keptFrame(Number(n)); },
    annotatedOf(callId, token) { return asOwner(callId, token).annotated; },
  };
}

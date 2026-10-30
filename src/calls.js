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
};

const id = (n = 16) => randomBytes(n).toString('hex');
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

  async function turn(c, line) {
    if (c.status === 'escalated') { say(c, 'The owner has been paged and is calling you. If you smell gas or see smoke or fire, leave the house now and call 911.', 'escalated'); return; }
    if (c.status === 'booked' || c.status === 'declined') { say(c, 'This visit is already settled. The office will text you.', c.status); return; }
    if (c.turns >= MAX_TURNS) { say(c, 'Let me get the owner to call you back to finish this.', 'handoff'); return; }
    c.turns++;
    c.session.heard(line);
    // Code, not the model, decides that a hazard ends the call's quoting.
    if (hazardIn(line)) {
      const r = await runTool('escalate', { reason: `Caller said: ${line.slice(0, 200)}` }, c.ctx);
      c.session.log({ kind: 'code_gate', name: 'hazard', text: 'Hazard words heard: escalated in code before any model call.' });
      say(c, r.say, 'escalated');
      return;
    }
    c.history.push({ role: 'user', content: `Caller: ${line}` });
    try {
      const r = await callerTurn(c.ctx, c.history);
      say(c, r.say, r.status);
      if (r.status === 'waiting_camera') c.tracking = { part: c.session.lastPart() || '', checks: 0, lastAt: 0 };
    } catch (err) {
      c.session.log({ kind: 'error', text: String(err.message ?? err).slice(0, 200) });
      say(c, err.code === 'RUN_CAP' || err.code === 'READ_ONLY' || err.code === 'HARD_STOP' ? 'Let me get the owner to call you back.' : 'Sorry, I lost that. Could you say it again?', err.code ? 'handoff' : c.status);
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
      try { const res = await callerTurn(c.ctx, c.history); say(c, res.say, res.status); } catch (err) { c.session.log({ kind: 'error', text: String(err.message).slice(0, 200) }); }
    });
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

    create({ ip = 'unknown', live = false } = {}) {
      sweep();
      if (ledger.mode() !== 'live' && !live) throw new CallError('The live demo is resting to protect its credit. Recorded calls are on the console page.', 503, 'REPLAY_ONLY');
      if (calls.size >= LIMITS.maxLiveCalls) throw new CallError('Too many live calls right now. Try again in a few minutes.', 429, 'BUSY');
      const hits = (ipHits.get(ip) ?? []).filter((t) => now() - t < 3_600_000);
      if (hits.length >= LIMITS.callsPerIpPerHour && !live) throw new CallError('That is a lot of calls from one place. Try again later.', 429, 'RATE_LIMIT');
      ipHits.set(ip, [...hits, now()]);
      const c = {
        id: id(), camToken: id(), ownerToken: id(), createdAt: now(), turns: 0, busy: false, status: 'started', says: [], history: [], tracking: null,
        pages: [], booking: null, annotated: null, latencies: [], voice: null,
      };
      c.session = createSession({ now });
      c.client = makeClient(live);
      c.ctx = {
        client: c.client, session: c.session, priceList, calendar: nextSlots(now()),
        notifyOwner: async (m) => { c.pages.push({ ...m, at: now() }); c.session.log({ kind: 'owner_paged', reason: m.reason }); },
      };
      calls.set(c.id, c);
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
          try { const res = await callerTurn(c.ctx, c.history); say(c, res.say, res.status); } catch (err) { c.session.log({ kind: 'error', text: String(err.message).slice(0, 200) }); }
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
    voiceAuth(callId, token) { const c = asCaller(callId, token); if (c.voice) throw new CallError('Voice is already on for this call.', 409, 'BUSY'); return c; },
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
      c.booking = { approved: Boolean(approve), slot: p.slot, brief: p.brief, quote: p.quote, at: now() };
      c.session.log({ kind: 'owner_decision', approved: Boolean(approve), slot: p.slot.label });
      if (!approve) { say(c, 'The office could not take that slot. They will text you another time.', 'declined'); return { ok: true }; }
      say(c, `You're booked for ${p.slot.label}. The technician will bring what's in the brief.`, 'booked');
      // Muse Image marks the part on the still that goes with the visit. Best effort: a failure never blocks the booking.
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
      return {
        id: c.id, now: now(), status: c.status, turns: c.turns, spentUsd: Math.round(c.client.spent() * 10000) / 10000,
        says: c.says, events: c.session.events(), pages: c.pages.map(({ reason, at }) => ({ reason, at })),
        pending: p ? { slot: p.slot, brief: p.brief, quote: p.quote } : null,
        booking: c.booking, annotated: Boolean(c.annotated), hasFrame: Boolean(c.session.latestFrame()),
        boxes: c.session.boxes(), part: c.session.lastPart(), tracking: Boolean(c.tracking), guidance: c.session.guidance(), latency: { p50: p50(c.latencies), n: c.latencies.length },
      };
    },
    frameOf(callId) { return get(callId).session.latestFrame()?.dataUrl ?? null; },
    annotatedOf(callId, token) { return asOwner(callId, token).annotated; },
  };
}

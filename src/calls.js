// Live "show me the problem" calls: one per caller, held in memory only.
// The HTTP layer (server.mjs) is thin; everything a stranger can trigger is
// bounded here so it can be tested without a network.
//
// Trust boundaries:
// - The caller holds camToken (camera + voice); the owner holds ownerToken
//   (approve/decline); the console holds viewToken (read-only). Seeing a call needs one of the three.
// - Caller words are checked for hazards in CODE before the model sees them:
//   a hazard ends quoting at once, pages the owner and blocks booking.
// - Prices only come from the verifier; bookings only from the owner's tap.
import { randomBytes, randomInt } from 'node:crypto';

import { draftFollowUp } from './afterBooking.js';
import { createSession, callerTurn, MAX_TURNS } from './agent.js';
import { PER_RUN_USD, STOP_CODES, isStop } from './budget.js';
import { workOrder } from './evidence.js';
import { bookingIcs } from './ics.js';
import { safeEqual } from './filters.js';
import { guide, DARK_LUMA } from './guidance.js';
import { scanFrame, severityOf } from './hazards.js';
import { toLang } from './i18n.js';
import { guessPart, speculate } from './locate.js';
import { maskGeometry } from './mask.js';
import { reviewWorkOrder } from './review.js';
import { normaliseMobile } from './sms.js';
import { analyseSound, equipmentKind, EQUIPMENT_KINDS } from './sound.js';
import { runTool } from './tools.js';
import { createTour, tourStep, openLine, tourView, tourMemo, TOUR } from './tour.js';
import { sentences } from './tts.js';
import { hazardIn } from './verifier.js';

// The fixed lines the phone may voice besides the agent's own: the acknowledgements public/voice.js plays
// while the agent works (keep the two lists the same) and the recording cues. Listed so /say serves them
// in the natural voice instead of the browser's.
export const WAITING_LINES = [
  'On it.',
  'Got it.',
  'Okay, one sec.',
  'Let me look.',
  'Sure, checking.',
  'Just a few moments longer.',
  'Almost there, a few more seconds.',
  'Still checking, just a moment longer.',
  'Nearly done, thanks for waiting.',
  'Still on it, almost there.',
  'Enseguida.',
  'Entendido.',
  'Déjame ver.',
  'Ya voy.',
  'Unos momentos más.',
  'Casi listo, unos segundos más.',
  'Ya casi, gracias por esperar.',
];
export const SPOKEN_CUES = new Set([
  'Start your screen recording now.',
  'You can stop recording now.',
  'Got it. Hold still.',
  ...WAITING_LINES,
]);

export const LIMITS = {
  frameBytes: 400_000, // data URL length, ~300 KB JPEG
  wavBytes: 1_300_000, // ~40 s of 16 kHz mono
  textChars: 300,
  frameEveryMs: 800,
  speechEveryMs: 1500,
  callTtlMs: 15 * 60_000,
  idleMs: 2 * 60_000, // no frame, speech or tap for this long ends the call
  maxLiveCalls: 10,
  callsPerIpPerHour: 6,
  // Model spend one person (IP) may cause in an hour, so a shared judge code cannot drain the session stop
  // for everyone (red team #5 S1: about 8 tour calls emptied a $5 stop). Staff calls are not counted.
  usdPerIpPerHour: 1.5,
  liveCallsPerIp: 2, // calls open at once from one place, so one person cannot hold the live slots
  trackChecks: 8, // SAM re-checks while the caller moves the camera (each updates the guidance arrow)
  trackEveryMs: 1500,
  hazardScans: 12, // camera hazard scans per call (2 min of camera at one per 10 s) (Spark lists, SAM must agree)
  scanEveryMs: 10_000,
  tourSteps: TOUR.steps, // guided-tour steps per call (Spark names parts, SAM outlines them)
  tourEveryMs: TOUR.everyMs,
  // Founder 10/30: "it should never fail or freeze". A caller turn that runs longer than this
  // is answered with a retry line instead of silence; a late result is dropped, never spoken over a newer line.
  turnMs: 20_000,
  autoTurns: 10, // agent turns started by the camera or a tap, per call
  taps: 40, // SAM point prompts from taps, per call
  listens: 4, // equipment sound clips measured, per call
  codeTextsPerHour: 20, // one-time-code texts across every call on this server
  voiceWaitMs: 25_000, // a line said while the agent is still answering waits its turn instead of being refused
};
// About 2.6 spoken words a second, so a tour step never talks over the agent's answer.
export const speakMs = (text) => Math.min(15_000, 1200 + String(text ?? '').split(/\s+/).length * 380);

const newId = (n = 16) => randomBytes(n).toString('hex');
const article = (noun) => `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;

export class CallError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// The demo business's next three weekday windows, in its own time zone, with the date and hours a
// calendar invite needs (src/ics.js).
const BUSINESS_TZ = process.env.BUSINESS_TZ || 'America/Toronto';
function nextSlots(now) {
  const out = [];
  const d = new Date(now);
  for (let i = 1; out.length < 3 && i < 10; i++) {
    const day = new Date(d.getTime() + i * 86_400_000);
    const weekday = day.toLocaleDateString('en-US', { weekday: 'short', timeZone: BUSINESS_TZ });
    if (weekday === 'Sat' || weekday === 'Sun') continue;
    const label = day.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      timeZone: BUSINESS_TZ,
    });
    const morning = out.length % 2 === 0;
    out.push({
      id: `s${out.length + 1}`,
      label: `${label}, ${morning ? '9-11 AM' : '1-3 PM'}`,
      date: day.toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ }),
      startHour: morning ? 9 : 13,
      endHour: morning ? 11 : 15,
    });
  }
  return out;
}

/**
 * deps: { ledger, makeClient(live) -> Meta client, priceList, now?, onEnd?(call) }
 */
export function createCalls({
  ledger,
  makeClient,
  priceList,
  now = () => Date.now(),
  onEnd = null,
  glimmer = null,
  onSay = null,
  onListen = null,
  sms = null,
  later = (fn, ms) => setTimeout(fn, ms).unref?.(),
}) {
  const codeTexts = []; // { at, to } of one-time-code texts, for the server-wide cap
  const calls = new Map();
  const ipHits = new Map();
  const ipSpend = new Map(); // ip -> [{ at, usd }] for finished calls, last hour

  const get = (callId) => {
    const c = calls.get(String(callId));
    if (!c) throw new CallError('This call has ended or does not exist.', 404, 'NO_CALL');
    return c;
  };
  const asCaller = (callId, token) => {
    const c = get(callId);
    if (!safeEqual(token, c.camToken)) throw new CallError('Not your call.', 403, 'FORBIDDEN');
    return c;
  };
  // Seeing a call (its live view, stills, evidence frames) needs one of its own links: the caller's, the
  // owner's, or the console's read-only view link (red team #5 B6: one judge code let any holder watch
  // another judge's camera).
  const asViewer = (callId, token) => {
    const c = get(callId);
    if (![c.camToken, c.ownerToken, c.viewToken].some((t) => safeEqual(token, t)))
      throw new CallError('This call needs its own link.', 403, 'FORBIDDEN');
    return c;
  };
  const asOwner = (callId, token) => {
    const c = get(callId);
    if (!safeEqual(token, c.ownerToken)) throw new CallError('Owner link required.', 403, 'FORBIDDEN');
    return c;
  };

  // Every line the caller hears goes through here: on a Spanish call, code-composed lines are translated
  // from a fixed table (i18n.js); the model's own lines are already Spanish.
  const labelEs = (label) => priceList.find((r) => r.label === label)?.labelEs ?? label;
  const say = (c, text, status) => {
    const spoken = toLang(text, c.session.lang?.(), { labelEs });
    // `parts`: the line as whole sentences, so the phone plays the first while the rest are made.
    const entry = { n: c.says.length + 1, text: spoken, parts: sentences(spoken), status, at: now() };
    c.says.push(entry);
    c.status = status ?? c.status;
    // Latency (founder 11/01): the line goes out the moment it exists (voice socket + voice made now),
    // not when the phone next polls and then asks for the audio.
    try {
      onSay?.(c, entry);
    } catch {
      /* delivery is best effort; polling still carries the line */
    }
    // A booking now waits for the owner: start the Glimmer GPU so the follow-up draft is not a cold start.
    if (status === 'awaiting_owner') glimmer?.warm?.();
  };

  async function exclusive(c, fn) {
    if (c.busy) throw new CallError('Still thinking about the last thing you said.', 409, 'BUSY');
    c.busy = true;
    try {
      return await fn();
    } finally {
      c.busy = false;
    }
  }

  const p50 = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  const waitIdle = async (c, ms) => {
    const end = Date.now() + ms;
    while (c.busy && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  };

  // The agent's line is spoken; "move the camera" (or the shut-off guide) starts tracking a part.
  function afterAgent(c, r) {
    say(c, r.say, r.status === 'keep' ? c.status : r.status);
    // The tour waits for the answer to be heard, then picks up where it was (founder 10/30).
    if (c.tour && !c.tour.done) {
      c.holdTourUntil = now() + speakMs(r.say);
      c.tourResume = true;
    }
    // No camera tracking during a tour: the tour leads the camera (red team 10/31: tracking made it say "Hold still" and stall).
    if (r.status === 'waiting_camera' && !(c.tour && !c.tour.done))
      c.tracking = { part: r.track || c.session.lastPart() || '', checks: 0, lastAt: 0 };
  }

  async function turn(c, line) {
    if (c.status === 'escalated') {
      say(
        c,
        'The owner has been paged and is calling you. If you smell gas or see smoke or fire, leave the house now and call 911.',
        'escalated',
      );
      return;
    }
    if (c.status === 'booked' || c.status === 'declined') {
      say(c, 'This visit is already settled. The office will text you.', c.status);
      return;
    }
    if (c.turns >= MAX_TURNS) {
      say(c, 'Let me get the owner to call you back to finish this.', 'handoff');
      return;
    }
    c.turns++;
    c.session.heard(line);
    const cl = c.session.checklist;
    // Code, not the model, decides that a hazard ends the call's quoting.
    if (hazardIn(line)) {
      cl.set('words', 'found', null, `Caller said: "${line.slice(0, 120)}"`);
      const r = await runTool('escalate', { reason: `Caller said: ${line.slice(0, 200)}` }, c.ctx);
      c.session.log({
        kind: 'code_gate',
        name: 'hazard',
        text: 'Hazard words heard: escalated in code before any model call.',
      });
      say(c, r.say, 'escalated');
      return;
    }
    cl.set('words', 'clear', null, `No hazard words in ${c.turns} caller turn(s); last: "${line.slice(0, 80)}"`);
    // Mid-tour questions ("what's that pipe?", "is that normal?") are answered from what the tour has seen so far.
    if (c.tour && !c.tour.done && c.tour.found.size)
      c.history.push({
        role: 'user',
        content: `${tourMemo(c.tour).replace('The caller may now ask for a price; quote only what was seen.', 'The tour is still going.')} Answer the caller's question with answer_caller, from this and the current frame, in one or two sentences; the tour then continues.`,
      });
    // The first useful words come from code the moment the caller stops, not after Spark's 2-5 s plan
    // (red team #6, latency 1): "Let me look at the water heater." Only for a part we know, with a live
    // frame, outside a tour, on an English call; Spark is told it was said so it does not repeat it.
    const named = guessPart(line);
    const ack =
      named && !c.tour && c.session.latestFrame() && (c.session.lang?.() ?? 'en') === 'en'
        ? `Let me look at the ${named}.`
        : null;
    if (ack) say(c, ack, c.status);
    c.history.push({
      role: 'user',
      content: `Caller: ${line}${ack ? `\n(Code already said to the caller: "${ack}" Leave say_now empty this turn.)` : ''}`,
    });
    try {
      await runTurn(c);
    } catch (err) {
      if (err.code === 'STALE') return;
      say(
        c,
        STOP_CODES.has(err.code)
          ? 'Let me get the owner to call you back.'
          : 'Sorry, I lost that. Could you say it again?',
        isStop(err) ? 'handoff' : c.status,
      );
    }
  }

  // Every agent turn (the caller's words, the camera catching up, a tap) runs here: on its own copy of
  // the history, kept only if it finishes in time and is still the latest (red team 10/30), and stopped
  // when it times out, so a late turn neither interleaves with the next one nor keeps spending (10/31).
  // A note from the camera checks or the tour, written while a turn runs, would be lost when that turn
  // saves its own copy of the history (red team 10/31); it waits and is added after the turn.
  function note(c, content) {
    if (c.turnAbort) (c.pendingNotes ??= []).push({ role: 'user', content });
    else c.history.push({ role: 'user', content });
  }

  async function runTurn(c) {
    const seq = (c.turnSeq = (c.turnSeq ?? 0) + 1);
    c.turnAbort?.abort();
    const ac = (c.turnAbort = new AbortController());
    const history = [...c.history];
    // Only on the caller's own words: camera and tour notes never start a guess (each guess is a SAM call).
    const last = history[history.length - 1];
    const said =
      last?.role === 'user' && typeof last.content === 'string' && last.content.startsWith('Caller: ')
        ? last.content.slice(8)
        : '';
    try {
      c.ctx.spec = speculate(c.client, c.session.latestFrame(), said, { now: now() });
    } catch (err) {
      if (isStop(err)) throw err;
      c.ctx.spec = null;
    }
    let timer;
    try {
      const r = await Promise.race([
        callerTurn(c.ctx, history, { signal: ac.signal }),
        new Promise((_, no) => {
          timer = setTimeout(() => {
            ac.abort();
            no(new Error(`turn took over ${LIMITS.turnMs / 1000} s`));
          }, LIMITS.turnMs);
        }),
      ]);
      if (seq !== c.turnSeq) throw Object.assign(new Error('a newer turn replaced this one'), { code: 'STALE' });
      c.history = history;
      afterAgent(c, r);
    } catch (err) {
      c.session.log({ kind: 'error', text: String(err.message ?? err).slice(0, 200) });
      throw err;
    } finally {
      clearTimeout(timer);
      if (c.turnAbort === ac) {
        c.turnAbort = null;
        if (c.pendingNotes?.length) c.history.push(...c.pendingNotes.splice(0));
      }
    }
  }

  // The camera and tap continue the conversation without the caller speaking; each counts toward a
  // per-call cap so a moving camera cannot buy unbounded agent turns (red team 10/31, finding 8).
  async function autoTurn(c, note) {
    // The same gates as a spoken turn: no model spend after an escalation, a decided booking or the turn cap (red team #4).
    if (['escalated', 'booked', 'declined', 'handoff'].includes(c.status) || c.turns >= MAX_TURNS) return;
    if ((c.autoTurns = (c.autoTurns ?? 0) + 1) > LIMITS.autoTurns) {
      say(c, 'Tell me what you see, and I will take it from there.', 'waiting_caller');
      return;
    }
    c.history.push({ role: 'user', content: note });
    c.autoRunning = true;
    try {
      await runTurn(c);
    } catch (err) {
      if (err.code !== 'STALE' && isStop(err)) say(c, 'Let me get the owner to call you back.', 'handoff');
    } finally {
      c.autoRunning = false;
    }
  }

  // While the agent waits for the caller to move the camera, SAM re-checks the
  // part on new frames; as soon as it is in view the agent continues by itself.
  async function track(c) {
    const t = c.tracking;
    if (!t?.part || c.busy || t.checks >= LIMITS.trackChecks || now() - t.lastAt < LIMITS.trackEveryMs) return;
    t.checks++;
    t.lastAt = now();
    await exclusive(c, async () => {
      const r = await runTool('find_part', { part: t.part }, c.ctx).catch((err) => ({
        output: { error: String(err.message) },
      }));
      const good = (r.output?.boxes ?? []).filter((b) => (b.score ?? 1) >= 0.5).length;
      const g = c.session.guidance();
      c.session.log({ kind: 'track', part: t.part, check: t.checks, boxes: good, guidance: g?.state ?? null });
      // Continue once the outline is centred and steady (hold/locked); on the last check, any confident outline will do.
      const ready = good && (g?.state === 'locked' || g?.state === 'hold' || t.checks >= LIMITS.trackChecks);
      if (!ready) {
        if (!good && t.checks >= LIMITS.trackChecks) {
          c.tracking = null;
          say(c, 'I still cannot see it. Could you tap it on your screen, or describe what you see?', 'waiting_caller');
        }
        return;
      }
      c.tracking = null;
      await autoTurn(
        c,
        `[camera] The caller moved the camera. SAM now outlines "${t.part}" (${good} confident object(s), guidance: ${g?.state ?? 'n/a'}). Continue.`,
      );
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
    cl.set(f.category, sev === 'attention' ? 'attention' : 'found', n, detail, {
      geo: f.geo ?? null,
      object: f.object,
    });
    if (c.warned.has(f.category)) return;
    c.warned.add(f.category);
    if (sev === 'escalate') {
      await c.ctx.notifyOwner({
        urgent: true,
        reason: `Camera hazard (${f.category}): ${f.object} in frame ${n}, confirmed by Spark and SAM.`,
      });
      c.session.log({
        kind: 'code_gate',
        name: 'camera hazard',
        text: `${f.category}: ${f.object} seen by Spark and outlined by SAM (${f.score.toFixed(2)}). Escalated in code.`,
      });
      say(
        c,
        `Stop for a moment: I can see ${article(f.object)} that looks unsafe (${f.why || f.category}). I am getting the owner on this now. Please do not touch it.`,
        'escalated',
      );
      if (c.tour) c.tour.done = true;
    } else if (sev === 'attention') {
      await c.ctx.notifyOwner({
        urgent: false,
        reason: `Camera note (${f.category}): ${f.object}, frame ${n}. Not connected to power, so not escalated.`,
      });
      c.session.log({
        kind: 'code_gate',
        name: 'camera attention',
        text: `${f.object}: bare wire on a cord that is not connected to power. Needs attention, not escalated (knowledge-base threshold).`,
      });
      say(
        c,
        `I can see bare wire on ${article(f.object)} that does not look plugged in. Please keep it unplugged and don't use it; the technician should replace it.`,
        c.status,
      );
      // The agent hears the code's judgement, so it does not escalate the same sign again without new evidence.
      note(
        c,
        `[camera check, code] ${f.object}: bare wire on a loose cord or strip that is NOT connected to power (frame ${n}). Knowledge-base threshold: needs attention, not an emergency. Do not escalate this sign again unless you see it plugged in, in a wall box or panel, or the caller reports sparks, heat or smoke. Advise not to use it; the technician replaces it.`,
      );
    } else {
      await c.ctx.notifyOwner({
        urgent: false,
        reason: `Camera warning (${f.category}): ${f.object}${f.near ? ` near ${f.near}` : ''}, frame ${n}.`,
      });
      c.session.log({
        kind: 'code_gate',
        name: 'camera warning',
        text: `${f.object}${f.near ? ` near ${f.near}` : ''}: spoken warning, owner noted. Call continues.`,
      });
      say(
        c,
        `Before anything else: I can see ${article(f.object)}${f.near ? ` close to the ${f.near}` : ''}. Please move it away from the heat.`,
        c.status,
      );
    }
  }

  async function scan(c) {
    const frame = c.session.latestFrame();
    if (!frame) return;
    c.scanning = true;
    c.scans++;
    c.lastScanAt = now();
    try {
      const r = await scanFrame(c.client, frame);
      const n = c.session.keepFrame(frame.n, frame.dataUrl);
      const cl = c.session.checklist;
      for (const id of r.clear) cl.set(id, 'clear', n, 'Nothing seen by Muse Spark in this frame');
      for (const f of r.findings.filter((x) => x.status !== 'found'))
        cl.set(
          f.category,
          'unconfirmed',
          n,
          `Spark saw "${f.object}", SAM could not outline it (${f.score.toFixed(2)}): not escalated`,
        );
      c.session.log({
        kind: 'hazard_scan',
        frame: n,
        staged: Boolean(c.staged),
        clear: r.clear,
        findings: r.findings.map(({ category, object, near, score, status, where, powered }) => ({
          category,
          object,
          near,
          where,
          powered,
          score: Number(score.toFixed(2)),
          status,
        })),
      });
      for (const f of r.findings.filter((x) => x.status === 'found'))
        await raise(c, { ...f, geo: f.record ? maskGeometry(f.record) : null }, n, 'Spark saw it');
    } catch (err) {
      c.session.log({ kind: 'error', text: `hazard scan: ${String(err.message).slice(0, 120)}` });
    } finally {
      c.scanning = false;
    }
  }

  // Guided tour: one step every few seconds while frames arrive. Runs beside the conversation.
  async function tourTick(c) {
    const frame = c.session.latestFrame();
    if (!frame || !c.tour || c.tour.done) return;
    c.touring = true;
    c.lastTourAt = now();
    try {
      const r = await tourStep(c.client, c.tour, frame);
      const n = c.session.keepFrame(frame.n, frame.dataUrl);
      c.session.log({
        kind: 'tour',
        frame: n,
        step: c.tour.step,
        room: c.tour.room,
        items: r.items.map(({ id, label, status, evidence, score, note, confirmScore }) => ({
          id,
          label,
          status,
          evidence,
          score: score != null ? Number(score.toFixed(2)) : null,
          confirmScore: confirmScore != null ? Number(confirmScore.toFixed(2)) : null,
          note,
        })),
      });
      for (const it of r.items.filter((x) => x.status === 'attention' || x.status === 'safety')) {
        if (!c.session.evidence.list().some((e) => e.kind === 'tour' && e.part === it.id && e.status === it.status))
          c.session.evidence.add({
            kind: 'tour',
            part: it.id,
            status: it.status,
            claim: `${it.label}: ${it.status === 'safety' ? 'safety issue' : 'needs attention'}, ${it.evidence}`,
            frame: n,
            confidence: it.score ?? 0.5,
            geo: it.geo ?? null,
            support: 'Muse Spark on this frame; SAM outline',
          });
      }
      for (const it of [...r.escalate, ...r.warn])
        await raise(
          c,
          {
            category: it.hazard.category,
            object: it.label.toLowerCase(),
            near: '',
            why: it.evidence,
            score: it.confirmScore ?? it.score ?? 0,
            geo: it.geo ?? null,
          },
          n,
          `tour: ${it.hazard.label}`,
        );
      if (c.status === 'escalated') return;
      // A step that finished while the caller was being answered keeps its labels but not its line.
      const held = !r.done && (c.busy || now() < (c.holdTourUntil ?? 0));
      if (r.say && !held) {
        say(c, `${c.tourResume && !r.done ? 'Back to the tour. ' : ''}${r.say}`, r.done ? 'waiting_caller' : 'touring');
        c.tourResume = false;
      }
      if (r.done) {
        note(c, tourMemo(c.tour));
        say(c, 'Would you like a price for a visit to look at any of this?', 'waiting_caller');
        c.session.log({
          kind: 'tour_done',
          text: `Tour of the ${c.tour.room.replace('_', ' ')} finished after ${c.tour.step} steps.`,
        });
      }
    } catch (err) {
      c.session.log({ kind: 'error', text: `tour: ${String(err.message).slice(0, 120)}` });
      if (isStop(err)) {
        c.tour.done = true;
        say(c, 'I have to stop the tour here. The owner will call you back.', 'handoff');
      }
    } finally {
      c.touring = false;
    }
  }

  function startTour(c, room) {
    if (c.status === 'escalated') return null;
    if (c.tour && !c.tour.done) return { already: true, room: c.tour.room };
    if (!mayRaise(c, TOUR.runCapUsd)) return null; // this place's hourly budget cannot cover a tour
    c.tour = createTour({ room });
    c.tour.refsFor = (q) => c.session.references?.(q, 2) ?? []; // cited trade-manual excerpts for this room
    c.session.setTourRoom(c.tour.room === 'auto' ? null : c.tour.room);
    c.client.setCap?.(TOUR.runCapUsd);
    c.tracking = null;
    c.lastTourAt = 0;
    const line = openLine(c.tour);
    c.session.log({
      kind: 'tour_start',
      room: c.tour.room,
      text: `Guided tour started (${c.tour.room}). Spend cap for this call raised to $${TOUR.runCapUsd.toFixed(2)}.`,
    });
    return { say: line };
  }

  // What one place may still cost in the hour: finished calls at what they spent, live calls at their cap,
  // so six calls opened at once cannot each start a tour inside the budget (red team #6 S-A).
  function reservedHere(ip) {
    const hourAgo = now() - 3_600_000;
    const finished = (ipSpend.get(ip) ?? []).filter((x) => x.at > hourAgo).reduce((a, x) => a + x.usd, 0);
    const live = [...calls.values()]
      .filter((x) => x.ip === ip)
      .reduce((a, x) => a + Math.max(x.client.spent(), x.client.cap?.() ?? PER_RUN_USD), 0);
    return finished + live;
  }
  /** Whether this call may raise its cap to `usd` without its place passing the hourly budget. */
  const mayRaise = (c, usd) =>
    c.staff || reservedHere(c.ip) - (c.client.cap?.() ?? PER_RUN_USD) + usd <= LIMITS.usdPerIpPerHour;

  // Every way a call ends goes through here, so its spend counts toward its person's hour.
  function ended(c) {
    if (!c.staff)
      ipSpend.set(c.ip, [
        ...(ipSpend.get(c.ip) ?? []).filter((x) => now() - x.at < 3_600_000),
        { at: now(), usd: c.client.spent() },
      ]);
    c.voice?.end();
    onEnd?.(c);
  }

  function sweep() {
    for (const [k, c] of calls) {
      // A closed tab sends no frames, speech or taps: after idleMs its live slot is freed (red team 10/31).
      // A call waiting for the owner's tap is kept until the TTL, so the owner can still decide.
      const last = Math.max(c.createdAt, c.lastFrameAt ?? 0, c.lastSpeechAt ?? 0, c.lastTapAt ?? 0);
      // So is a booking whose Glimmer draft is still being written or waiting for Send (red team #3).
      const drafting = ['running', 'draft'].includes(c.booking?.followUp?.status);
      const idle = now() - last > LIMITS.idleMs && !c.voice && c.status !== 'awaiting_owner' && !drafting;
      if (idle || now() - c.createdAt > LIMITS.callTtlMs) {
        calls.delete(k);
        ended(c);
      }
    }
    for (const [ip, spent] of ipSpend) {
      const keep = spent.filter((x) => now() - x.at < 3_600_000);
      if (keep.length) ipSpend.set(ip, keep);
      else ipSpend.delete(ip);
    }
    for (const [ip, hits] of ipHits) {
      const keep = hits.filter((t) => now() - t < 3_600_000);
      if (keep.length) ipHits.set(ip, keep);
      else ipHits.delete(ip);
    }
  }

  return {
    sweep,
    size: () => calls.size,
    /** Ends every call (the server is stopping), so each keeps its replay. */
    endAll() {
      for (const c of [...calls.values()]) {
        calls.delete(c.id);
        ended(c);
      }
    },
    /** Ends a call now (the caller hung up, or a test run finished); keeps its replay. */
    end(callId) {
      const c = calls.get(String(callId));
      if (c) {
        calls.delete(c.id);
        ended(c);
      }
    },

    create({ ip = 'unknown', live = false, staff = live, footage = null, creator = null } = {}) {
      sweep();
      if (ledger.mode() === 'stopped')
        throw new CallError(
          'The spending stop for this session is reached. No new calls until a restart.',
          503,
          'SPEND_STOP',
        );
      if (ledger.mode() !== 'live' && !live)
        throw new CallError(
          'The live demo is resting to protect its credit. Recorded calls are on the console page.',
          503,
          'REPLAY_ONLY',
        );
      if (calls.size >= LIMITS.maxLiveCalls)
        throw new CallError('Too many live calls right now. Try again in a few minutes.', 429, 'BUSY');
      if (!staff && [...calls.values()].filter((x) => x.ip === ip).length >= LIMITS.liveCallsPerIp)
        throw new CallError('Two calls are already open from here. Finish one first.', 429, 'RATE_LIMIT');
      if (!staff && reservedHere(ip) + PER_RUN_USD > LIMITS.usdPerIpPerHour)
        throw new CallError('That is a lot of calls from one place. Try again later.', 429, 'RATE_LIMIT');
      const hits = (ipHits.get(ip) ?? []).filter((t) => now() - t < 3_600_000);
      if (hits.length >= LIMITS.callsPerIpPerHour && !staff)
        throw new CallError('That is a lot of calls from one place. Try again later.', 429, 'RATE_LIMIT');
      ipHits.set(ip, [...hits, now()]);
      const c = {
        id: newId(),
        camToken: newId(),
        ownerToken: newId(),
        viewToken: newId(),
        creator,
        ip,
        staff,
        createdAt: now(),
        turns: 0,
        busy: false,
        status: 'started',
        says: [],
        history: [],
        tracking: null,
        footage,
        pages: [],
        booking: null,
        annotated: null,
        latencies: [],
        voice: null,
        scans: 0,
        scanning: false,
        warned: new Set(),
        staged: false,
      };
      c.session = createSession({ now });
      c.client = makeClient(live);
      c.ctx = {
        client: c.client,
        session: c.session,
        now, // the same clock as the rest of the call (tools read frame ages and plate dates with it)
        priceList,
        calendar: nextSlots(now()),
        notifyOwner: async (m) => {
          c.pages.push({ ...m, at: now() });
          c.session.log({ kind: 'owner_paged', reason: m.reason });
        },
        startTour: (room) => startTour(c, room),
        // The model's "while I look" words, voiced before the tool runs (agent.js).
        sayNow: (text) => {
          if (!['escalated', 'booked', 'declined'].includes(c.status)) say(c, text, c.status);
        },
        // listen_to_equipment: the phone starts an 8 s recording by itself (voice socket); false when it cannot.
        requestListen: (kind) => {
          if (!c.voice || (c.listens ?? 0) >= LIMITS.listens || !onListen) return false;
          c.listenFor = { kind, at: now() };
          try {
            onListen(c, kind);
            return true;
          } catch {
            return false;
          }
        },
      };
      calls.set(c.id, c);
      if (footage)
        c.session.log({
          kind: 'footage',
          text: `Footage mode: recorded clip "${footage}" is played in the browser and its frames go to the models live.`,
        });
      say(c, 'Hi, this is the office. Point your camera at the problem and tell me what is going on.', 'started');
      return { id: c.id, camToken: c.camToken, ownerToken: c.ownerToken, viewToken: c.viewToken };
    },

    async frame(callId, token, image, luma = null) {
      const c = asCaller(callId, token);
      if (typeof image !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image))
        throw new CallError('Frames must be JPEG data URLs.');
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
        c.session.log({
          kind: 'lighting',
          luma: l,
          frame: c.session.latestFrame().n,
          text: 'Frame too dark: lighting advice given in code.',
        });
        say(c, g.words, c.status);
      }
      c.prevDark = dark;
      if (l != null) {
        const n = c.session.latestFrame().n;
        if (dark) c.session.checklist.set('lighting', 'found', c.session.keepFrame(n), `Too dark: light ${l}/255`);
        else if (c.session.checklist.get('lighting').status !== 'clear' || n % 10 === 0)
          c.session.checklist.set('lighting', 'clear', c.session.keepFrame(n), `Light ${l}/255`);
      }
      if (
        !dark &&
        !c.scanning &&
        c.scans < LIMITS.hazardScans &&
        (!c.lastScanAt || now() - c.lastScanAt >= LIMITS.scanEveryMs)
      )
        c.scanP = scan(c);
      if (
        !dark &&
        c.tour &&
        !c.tour.done &&
        !c.touring &&
        !c.busy &&
        now() >= (c.holdTourUntil ?? 0) &&
        c.status !== 'escalated' &&
        (!c.lastTourAt || now() - c.lastTourAt >= LIMITS.tourEveryMs)
      )
        c.tourP = tourTick(c);
      await track(c).catch(() => {});
      return { ok: true };
    },

    async speech(callId, token, wav) {
      const c = asCaller(callId, token);
      if (!Buffer.isBuffer(wav) || wav.length < 1000) throw new CallError('No audio.');
      if (wav.length > LIMITS.wavBytes) throw new CallError('Keep each message under 40 seconds.', 413, 'TOO_LARGE');
      if (c.lastSpeechAt && now() - c.lastSpeechAt < LIMITS.speechEveryMs)
        throw new CallError('One message at a time.', 429, 'RATE_LIMIT');
      c.lastSpeechAt = now();
      return exclusive(c, async () => {
        let heard = '';
        try {
          heard = (await c.client.transcribe(wav)).slice(0, LIMITS.textChars);
        } catch (err) {
          c.session.log({ kind: 'error', text: `transcribe: ${String(err.message).slice(0, 160)}` });
        }
        if (!heard) {
          say(c, 'I did not catch that. Could you say it again?', c.status);
          return { heard };
        }
        await turn(c, heard);
        return { heard };
      });
    },

    /** Listen: a clip of the equipment itself (the tank refilling), measured in code (sound.js). */
    async listen(callId, token, wav) {
      const c = asCaller(callId, token);
      if (!Buffer.isBuffer(wav) || wav.length < 1000) throw new CallError('No audio.');
      if (wav.length > LIMITS.wavBytes) throw new CallError('Keep it under 40 seconds.', 413, 'TOO_LARGE');
      if (c.busy)
        throw new CallError('Still thinking about the last thing you said. Tap Listen again in a moment.', 409, 'BUSY');
      if ((c.listens = (c.listens ?? 0) + 1) > LIMITS.listens)
        throw new CallError('I have heard enough of it for this call.', 429, 'RATE_LIMIT');
      let r;
      // The kind the AI asked for (listen_to_equipment), else the part on camera or the tour's room.
      // The AI's request counts only while fresh: a request whose recording never arrived is not reused later.
      const asked = c.listenFor && now() - c.listenFor.at < 60_000 ? c.listenFor.kind : null;
      const kind = EQUIPMENT_KINDS.includes(asked)
        ? asked
        : equipmentKind(
            `${c.session.lastPart?.() ?? ''} ${c.tour?.room ?? ''}`
              .replace('electrical_panel', 'electrical panel')
              .replace('under_sink', 'sink')
              .replace('boiler_room', 'boiler'),
          );
      c.listenFor = null;
      try {
        r = analyseSound(wav, { fixture: kind });
      } catch (err) {
        throw new CallError(String(err.message));
      }
      const added = r.findings.map((f) =>
        c.session.evidence.add({
          kind: 'sound',
          sound: f.sound,
          claim: `Heard: ${f.detail}. ${f.meaning}`,
          confidence: Math.min(0.9, 0.5 + f.share / 2),
          support: `Measured in code from ${r.seconds.toFixed(1)} s of audio${f.source ? `; ${f.source}` : ''}`,
          frame: null,
        }),
      );
      c.session.log({
        kind: 'sound',
        seconds: r.seconds,
        levelDb: r.levelDb ?? null,
        findings: r.findings.map(({ sound, share, detail }) => ({ sound, share, detail })),
        text: r.findings.length
          ? `Listened ${r.seconds.toFixed(1)} s: ${r.findings.map((f) => f.detail).join('; ')}`
          : r.note,
      });
      if (!added.length) {
        say(c, r.note ?? 'I could not make out the sound. Hold the phone near it for about 8 seconds.', c.status);
        return { findings: [] };
      }
      // A dangerous sound (buzzing panel, arcing, delayed ignition) is said in code first, never left to the model.
      // A dangerous sound (buzzing panel, arcing, delayed ignition) is handled in code, never left to the
      // model: the warning is said, the owner is paged and the call is escalated, so nothing gets booked (red team #5).
      const danger = r.findings.find((f) => f.hazard);
      if (danger) {
        await c.ctx.notifyOwner({
          urgent: true,
          reason: `Hazard sound on the ${kind.replace('_', ' ')}: ${danger.detail}. ${danger.meaning}`,
          transcript: c.session.callerText?.() ?? '',
        });
        say(
          c,
          `Please keep away from it and don't touch anything. ${danger.meaning} I am getting the owner on this right now.`,
          'escalated',
        );
        c.session.log({
          kind: 'code_gate',
          name: 'sound hazard',
          text: `Hazard sound (${danger.sound}) on ${kind}: warning said and owner paged in code.`,
        });
      } else {
        await exclusive(c, () =>
          autoTurn(
            c,
            `[microphone] Listened to the ${kind.replace('_', ' ')} for ${r.seconds.toFixed(1)} s, measured in code: ${added.map((e) => `${e.id} ${e.claim}`).join(' | ')}. Use these as evidence (cite the ids) together with what the camera shows, and tell the caller what you heard in one short sentence.`,
          ),
        );
      }
      return { findings: r.findings.map(({ sound, detail, meaning }) => ({ sound, detail, meaning })) };
    },

    /** Tap-to-point: the caller taps the part on screen (x, y in 0..1); SAM segments what is under the finger. */
    async tap(callId, token, x, y) {
      const c = asCaller(callId, token);
      if (![x, y].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1))
        throw new CallError('Tap must be x and y between 0 and 1.');
      if (c.lastTapAt && now() - c.lastTapAt < LIMITS.speechEveryMs)
        throw new CallError('One tap at a time.', 429, 'RATE_LIMIT');
      if ((c.taps = (c.taps ?? 0) + 1) > LIMITS.taps)
        throw new CallError('That is enough taps for this call. Tell me what you see instead.', 429, 'RATE_LIMIT');
      c.lastTapAt = now();
      c.session.setTap(x, y);
      if (!c.session.latestFrame()) return { ok: true };
      return exclusive(c, async () => {
        const part = c.session.lastPart() || 'part the caller tapped';
        const r = await runTool('find_part', { part }, c.ctx).catch((err) => ({
          output: { error: String(err.message) },
        }));
        const n = r.output?.boxes?.length ?? 0;
        if (n && c.tracking) {
          c.tracking = null;
          await autoTurn(
            c,
            `[camera] The caller tapped the part on screen. SAM now outlines ${n} object(s) for "${part}" (method: tap). Continue.`,
          );
        }
        return { ok: true, outlined: n };
      });
    },

    /** A finished spoken turn from the realtime voice stream. Latency = end of speech -> the agent's line. */
    async voiceTurn(callId, text, { speechEndAt = now() } = {}) {
      const c = get(callId);
      const line = String(text ?? '')
        .replace(/[\u0000-\u001f]/g, ' ')
        .trim()
        .slice(0, LIMITS.textChars);
      if (!line) return { heard: '' };
      // The caller talking outranks a turn the camera started: stop it rather than make them wait (red team #6).
      if (c.busy && c.autoRunning) c.turnAbort?.abort();
      await waitIdle(c, LIMITS.voiceWaitMs);
      return exclusive(c, async () => {
        const before = c.says.length;
        await turn(c, line);
        if (c.says.length > before) {
          const ms = now() - speechEndAt;
          c.latencies.push(ms);
          c.session.log({ kind: 'latency', ms, channel: 'voice' });
        }
        return { heard: line };
      });
    },
    /** The caller marks the scene as staged: a visible label on the call page, console and replay. */
    setStaged(callId, token, staged) {
      const c = asCaller(callId, token);
      c.staged = Boolean(staged);
      c.session.log({
        kind: 'staged',
        on: c.staged,
        text: c.staged ? 'Caller marked this as a staged scene.' : 'Staged label removed.',
      });
      return { ok: true, staged: c.staged };
    },
    /** Waits for a running hazard scan (eval and tests). */
    async scanDone(callId) {
      await get(callId).scanP;
    },
    /** Waits for a running tour step (eval and tests). */
    async tourDone(callId) {
      await get(callId).tourP;
    },
    /** The caller starts a guided tour from the page (button), same as the agent's start_tour tool. */
    tour(callId, token, room) {
      const c = asCaller(callId, token);
      if (c.tour && !c.tour.done) return { ok: true, room: c.tour.room };
      const r = startTour(c, room);
      if (!r)
        throw c.status === 'escalated'
          ? new CallError('This call was escalated. The owner is calling you.', 409, 'HAZARD')
          : new CallError('A guided tour is not available on this call right now.', 429, 'RATE_LIMIT');
      say(c, r.say, 'touring');
      return { ok: true, room: c.tour.room };
    },
    /** The newest call (the console follows it during a recording session). */
    /** The newest call this browser started (or, for the recording Mac, this local address), with its view link. */
    latest({ creator = null, ip = null } = {}) {
      const mine = (c) => (creator && c.creator === creator) || (ip && c.ip === ip);
      let best = null;
      for (const c of calls.values()) if (mine(c) && (!best || c.createdAt >= best.createdAt)) best = c;
      return best ? { id: best.id, viewToken: best.viewToken } : null;
    },
    /** Natural voice out: only lines this call's agent said, guidance it showed, or the fixed recording cues. */
    sayable(callId, token, text) {
      const c = asCaller(callId, token);
      const t = String(text ?? '');
      if (!t || t.length > 600) return false;
      return (
        SPOKEN_CUES.has(t) ||
        [...SPOKEN_CUES].some((x) => toLang(x, 'es') === t) ||
        c.says.some((s) => s.text === t || s.parts?.includes(t)) ||
        c.session.guidanceSaid(t, (w) => toLang(w, c.session.lang?.()))
      );
    },
    voiceAuth(callId, token) {
      const c = asCaller(callId, token);
      if (c.voice && !c.voice.closed) throw new CallError('Voice is already on for this call.', 409, 'BUSY');
      return c;
    },
    setVoice(callId, v) {
      const c = calls.get(String(callId));
      if (c) c.voice = v;
    },
    recentSays(callId, n = 2) {
      const c = calls.get(String(callId));
      return c ? c.says.slice(-n).map((x) => x.text) : [];
    },
    logEvent(callId, e) {
      calls.get(String(callId))?.session.log(e);
    },
    clientOf(callId) {
      return get(callId).client;
    },

    async text(callId, token, text) {
      const c = asCaller(callId, token);
      const line = String(text ?? '')
        .replace(/[\u0000-\u001f]/g, ' ')
        .trim()
        .slice(0, LIMITS.textChars);
      if (!line) throw new CallError('Say something first.');
      if (c.lastSpeechAt && now() - c.lastSpeechAt < LIMITS.speechEveryMs)
        throw new CallError('One message at a time.', 429, 'RATE_LIMIT');
      c.lastSpeechAt = now();
      const t0 = now();
      return exclusive(c, async () => {
        await turn(c, line);
        const ms = now() - t0;
        c.latencies.push(ms);
        c.session.log({ kind: 'latency', ms, channel: 'typed' });
        return { heard: line };
      });
    },

    async decide(callId, token, approve) {
      const c = asOwner(callId, token);
      const p = c.session.pendingBooking();
      if (!p) throw new CallError('Nothing is waiting for approval.', 409, 'NOTHING_PENDING');
      if (c.status === 'escalated')
        throw new CallError('This call was escalated as a hazard. Call the customer first.', 409, 'HAZARD');
      if (c.booking) throw new CallError('Already decided.', 409, 'DECIDED');
      c.booking = {
        approved: Boolean(approve),
        slot: p.slot,
        brief: p.brief,
        quote: p.quote,
        at: now(),
        workOrder: approve ? workOrder(c.session, { slot: p.slot, quote: p.quote }) : null,
      };
      c.session.log({ kind: 'owner_decision', approved: Boolean(approve), slot: p.slot.label });
      if (!approve) {
        say(c, 'The office could not take that slot. They will text you another time.', 'declined');
        return { ok: true };
      }
      say(c, `You're booked for ${p.slot.label}. The technician will bring what's in the brief.`, 'booked');
      // Muse Wonder reviews the approved work order for the technician, beside the booking, never blocking it.
      c.booking.review = { status: 'running' };
      // Its own allowance on top of what the call spent, so a long call still gets its plan (red team 10/31); never past MAX_RUN_USD.
      if (mayRaise(c, c.client.spent() + 0.1)) c.client.setCap(c.client.spent() + 0.1);
      const t0 = Date.now();
      const spent0 = c.client.spent?.() ?? null;
      reviewWorkOrder(c.client, c.booking.workOrder, c.session.evidence.list())
        .then((r) => {
          c.booking.review = { status: 'done', ...r };
          c.session.log({
            kind: 'wonder_review',
            steps: r.steps.length,
            gaps: r.gaps.length,
            dropped: r.dropped,
            ms: Date.now() - t0,
            costUsd: spent0 == null ? null : Math.max(0, c.client.spent() - spent0),
          });
        })
        .catch((err) => {
          c.booking.review = { status: 'failed' };
          c.session.log({ kind: 'error', text: `review: ${String(err.message).slice(0, 160)}` });
        });
      // Muse Glimmer (open weights, the business's own GPU) drafts the truck list and the customer's
      // confirmation text; the text waits for the owner's Send. Skipped when no endpoint is configured.
      if (glimmer) {
        c.booking.followUp = { status: 'running' };
        draftFollowUp(
          glimmer,
          c.booking.workOrder,
          c.session.evidence.list(),
          c.session.latestFrame()?.dataUrl ?? null,
          { now, lang: c.session.lang?.() ?? 'en' },
        )
          .then((r) => {
            c.booking.followUp = { status: 'draft', ...r };
            c.session.log({
              kind: 'glimmer_followup',
              parts: r.parts.length,
              dropped: r.dropped,
              ms: r.ms,
              costUsd: r.costUsd,
            });
          })
          .catch((err) => {
            c.booking.followUp = { status: 'failed' };
            c.session.log({ kind: 'error', text: `follow-up: ${String(err.message).slice(0, 160)}` });
          });
      }
      // The evidence stills are drawn in code from SAM masks (owner page). Muse Image adds a separate,
      // clearly labelled illustration; it is never used as evidence. Best effort: a failure never blocks the booking.
      const frame = c.session.latestFrame();
      const box = c.session.boxes()[0];
      // In the background, like Wonder and Glimmer: the owner's tap returns at once (red team #3).
      if (frame && box) {
        c.client
          .annotate(
            frame.dataUrl,
            `Draw a bright red rectangle around the ${c.session.lastPart()} (pixels x ${box.x1}-${box.x2}, y ${box.y1}-${box.y2}) and a short label "${c.session.lastPart()}". Change nothing else.`,
          )
          .then((img) => {
            c.annotated = img;
            c.session.log({ kind: 'annotated', ok: Boolean(img) });
          })
          .catch((err) => c.session.log({ kind: 'error', text: `annotate: ${String(err.message).slice(0, 160)}` }));
      }
      return { ok: true };
    },

    /**
     * The caller's own mobile for the confirmation text, proved with a one-time code (red team #4:
     * whoever holds the call link could otherwise have the business line text anyone). Three numbers
     * per call at most; no change once the owner has decided the booking.
     */
    async setMobile(callId, token, raw) {
      const c = asCaller(callId, token);
      if (c.booking) throw new CallError('The booking is decided; the number cannot change now.', 409, 'LOCKED');
      if (!sms) throw new CallError('Texting is off on this demo; the confirmation shows on screen.', 409, 'NO_SMS');
      const m = normaliseMobile(raw);
      if (!m) throw new CallError('Enter a US or Canadian mobile number, like 416 555 0100.');
      if ((c.mobileTries = (c.mobileTries ?? 0) + 1) > 3)
        throw new CallError('That is enough numbers for this call.', 429, 'RATE_LIMIT');
      // Across all calls too (red team #5: 18 numbers an hour from one address): 20 code texts an hour
      // on this server and 3 a day to any one number.
      const t = now();
      codeTexts.splice(0, codeTexts.length, ...codeTexts.filter((x) => t - x.at < 86_400_000));
      if (
        codeTexts.filter((x) => t - x.at < 3_600_000).length >= LIMITS.codeTextsPerHour ||
        codeTexts.filter((x) => x.to === m).length >= 3
      )
        throw new CallError('Too many codes sent right now. Try again later.', 429, 'RATE_LIMIT');
      codeTexts.push({ at: t, to: m });
      const code = String(randomInt(100000, 1000000));
      c.pendingMobile = { number: m, code, tries: 0 };
      c.mobile = null;
      await sms
        .send(m, `Your code for the repair call: ${code}. If you did not ask for this, ignore it.`)
        .catch((err) => {
          throw new CallError(`Could not text that number: ${String(err.message).slice(0, 120)}`, 502, 'SMS_FAILED');
        });
      c.session.log({ kind: 'mobile', text: `Code texted to the number ending ${m.slice(-4)}.` });
      return { ok: true, sent: true, ending: m.slice(-4) };
    },

    /** The code from that text: only then is the number used for the confirmation. */
    verifyMobile(callId, token, code) {
      const c = asCaller(callId, token);
      const p = c.pendingMobile;
      if (!p || c.booking) throw new CallError('No code is waiting.', 409, 'NO_CODE');
      if (++p.tries > 5) {
        c.pendingMobile = null;
        throw new CallError('Too many tries. Enter the number again.', 429, 'RATE_LIMIT');
      }
      if (!safeEqual(String(code ?? '').replace(/\D/g, ''), p.code)) throw new CallError('That code does not match.');
      c.mobile = p.number;
      c.pendingMobile = null;
      c.session.log({ kind: 'mobile', text: `Caller confirmed the mobile ending ${c.mobile.slice(-4)}.` });
      return { ok: true, ending: c.mobile.slice(-4) };
    },

    /** The owner sends (or drops) Glimmer's confirmation text. Only a finished draft, only once. */
    async sendConfirmation(callId, token, send) {
      const c = asOwner(callId, token);
      const f = c.booking?.followUp;
      if (!f || f.status !== 'draft') throw new CallError('No confirmation is waiting.', 409, 'NO_DRAFT');
      f.status = send ? 'sent' : 'dropped';
      if (!send) {
        c.session.log({ kind: 'confirmation', sent: false });
        return { ok: true };
      }
      say(c, f.confirmation, c.status);
      // A real text from the business line when the caller gave a mobile (one per call: the draft is consumed above).
      if (c.mobile && sms) {
        f.text = { to: `…${c.mobile.slice(-4)}`, state: 'sending' };
        try {
          const { id } = await sms.send(c.mobile, f.confirmation);
          f.text.state = 'on its way';
          if (id)
            later(async () => {
              const st = await sms.status(id).catch(() => null);
              if (st) {
                f.text.state = st.state;
                f.text.reason = st.reason ?? null;
                c.session.log({ kind: 'confirmation_text', state: st.state, reason: st.reason ?? null });
              }
            }, 8000);
        } catch (err) {
          f.text.state = 'failed';
          f.text.reason = String(err.message).slice(0, 160);
        }
      }
      c.session.log({
        kind: 'confirmation',
        sent: true,
        texted: f.text?.state ?? 'no mobile given',
        reason: f.text?.reason ?? null,
      });
      return { ok: true, text: f.text ?? null };
    },

    /** Read-only view for the console and the caller's page. Never includes tokens or raw frames. */
    view(callId) {
      const c = get(callId);
      const p = c.session.pendingBooking();
      const g0 = c.session.guidance();
      const g = g0?.words ? { ...g0, words: toLang(g0.words, c.session.lang?.()) } : g0;
      return {
        id: c.id,
        now: now(),
        status: c.status,
        turns: c.turns,
        spentUsd: Math.round(c.client.spent() * 10000) / 10000,
        says: c.says,
        events: c.session.events(),
        pages: c.pages.map(({ reason, at, urgent }) => ({ reason, at, urgent })),
        pending: p
          ? {
              slot: p.slot,
              brief: p.brief,
              quote: p.quote,
              workOrder: c.booking ? null : workOrder(c.session, { slot: p.slot, quote: p.quote }),
            }
          : null,
        evidence: c.session.evidence.list(),
        booking: c.booking,
        mobile: c.mobile ? `…${c.mobile.slice(-4)}` : null,
        annotated: Boolean(c.annotated),
        hasFrame: Boolean(c.session.latestFrame()),
        staged: c.staged,
        checklist: c.session.checklist.list(),
        boxes: c.session.boxes(),
        part: c.session.lastPart(),
        tracking: Boolean(c.tracking),
        guidance: g,
        lang: c.session.lang?.() ?? 'en',
        footage: c.footage,
        latency: { p50: p50(c.latencies), n: c.latencies.length },
        tour: tourView(c.tour),
        cards: c.session.cards(),
        capUsd: c.client.cap?.() ?? null,
        // What the call saved the owner, from this call's own record (the owner page's results strip).
        results: {
          callMinutes: Math.round((now() - c.createdAt) / 6000) / 10,
          minutesToQuote: c.session.quotedAt() ? Math.round((c.session.quotedAt() - c.createdAt) / 6000) / 10 : null,
          quotedCents: c.session.quote()?.priceCents ?? null,
          ownerTaps: c.booking ? 1 : 0,
          booked: Boolean(c.booking?.approved),
        },
      };
    },
    langOf(callId) {
      return calls.get(String(callId))?.session.lang?.() ?? 'en';
    },
    frameOf(callId) {
      return get(callId).session.latestFrame()?.dataUrl ?? null;
    },
    keptFrameOf(callId, n) {
      return get(callId).session.keptFrame(Number(n));
    },
    /** The same three, for a request that must show one of the call's own links. */
    viewAs(callId, token) {
      asViewer(callId, token);
      return this.view(callId);
    },
    frameAs(callId, token) {
      asViewer(callId, token);
      return this.frameOf(callId);
    },
    keptFrameAs(callId, n, token) {
      asViewer(callId, token);
      return this.keptFrameOf(callId, n);
    },
    /** Whether a finished call may be listed as a public replay: only the staff's own recorded takes. */
    staffCall(callId) {
      return Boolean(calls.get(String(callId))?.staff);
    },
    annotatedOf(callId, token) {
      return asOwner(callId, token).annotated;
    },
    /** The approved visit as a calendar invite, for the owner only; null until a visit is approved. */
    bookingIcsOf(callId, token) {
      const c = asOwner(callId, token);
      if (!c.booking?.approved) return null;
      const q = c.booking.quote;
      return bookingIcs({
        uid: c.id,
        slot: c.booking.slot,
        title: q ? `${q.label}` : 'Service visit',
        details: [
          c.booking.brief,
          q ? `Quoted from your price list: $${(q.priceCents / 100).toFixed(2)}` : 'Price confirmed on site',
        ]
          .filter(Boolean)
          .join('\n'),
        now: new Date(now()),
      });
    },
  };
}

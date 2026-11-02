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
import { createSession, callerTurn, maxTurns } from './agent.js';
import { PER_RUN_USD, STOP_CODES, isStop } from './budget.js';
import { safeEqual } from './filters.js';
import { guide, DARK_LUMA } from './guidance.js';
import { toLang } from './i18n.js';
import { guessPart, speculate } from './locate.js';
import { runTool } from './tools.js';
import { createTour, openLine, tourMemo, TOUR } from './tour.js';
import { sentences } from './tts.js';
import { GUARD_LINE } from './promptGuard.js';
import { hazardIn } from './verifier.js';
import { createBooking } from './calls/booking.js';
import { createCameraLoops } from './calls/camera.js';
import { createListen } from './calls/listen.js';
import { LIMITS, SPOKEN_CUES, CallError, speakMs, newId, nextSlots } from './calls/shared.js';
import { viewOf } from './calls/view.js';

export { WAITING_LINES, SPOKEN_CUES, LIMITS, speakMs, CallError } from './calls/shared.js';

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
  guard = null, // Prompt Guard 2 (src/promptGuard.js), or null when it is not running
}) {
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
    // Escalation is sticky: a turn already running when a scan or sound check escalated cannot turn the call
    // back into a bookable one (red team #7 M8).
    // So are a booking and a decline, except that a hazard after them still escalates (red team #8 M1: a tour
    // step finishing after the owner's tap turned a booked call back into "waiting_caller").
    const settled = c.status === 'booked' || c.status === 'declined';
    if (c.status !== 'escalated' && (!settled || status === 'escalated')) c.status = status ?? c.status;
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

  // Real time on purpose: it waits on the event loop, and an injected test clock may never advance.
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

  const wrapUpLine = (c) =>
    c.tour
      ? "That's all I can cover on this call. Thank you for showing me around. The owner will call you back to go over what we saw and book a visit if you need one."
      : "That's all I can cover on this call. Thank you for showing me. The owner will call you back to finish this and book a visit if you need one.";

  async function turn(c, line) {
    if (c.status === 'escalated') {
      say(
        c,
        'The owner has been paged and is calling you. If you smell gas or see smoke or fire, leave the house now and call 911.',
        'escalated',
      );
      return;
    }
    // Code, not the model, decides that a hazard ends the call's quoting. Checked before the "already
    // settled" and turn-cap answers: gas or smoke after a booking still escalates (red team #8 H2).
    if (hazardIn(line)) {
      c.session.heard(line);
      c.session.checklist.set('words', 'found', null, `Caller said: "${line.slice(0, 120)}"`);
      const r = await runTool('escalate', { reason: `Caller said: ${line.slice(0, 200)}` }, c.ctx);
      c.session.log({
        kind: 'code_gate',
        name: 'hazard',
        text: 'Hazard words heard: escalated in code before any model call.',
      });
      say(c, r.say, 'escalated');
      return;
    }
    if (c.status === 'booked' || c.status === 'declined') {
      say(c, 'This visit is already settled. The office will text you.', c.status);
      return;
    }
    if (c.turns >= maxTurns(c)) {
      // Said once: the 11/02 panel take heard it four times in a row. The same cap holds on real calls (it bounds
      // the cost of one call), so it closes the call politely instead of just stopping.
      if (c.status !== 'handoff') say(c, wrapUpLine(c), 'handoff');
      else c.session.log({ kind: 'after_handoff', text: line.slice(0, 120) });
      return;
    }
    c.turns++;
    // Prompt Guard 2 scores the words before the agent sees them; a flagged turn never reaches the model and
    // still counts toward the cap, so retrying costs the attacker turns.
    const g = guard ? await guard.check(line) : null;
    if (g?.blocked) {
      c.session.log({
        kind: 'code_gate',
        name: 'prompt_guard',
        text: `Prompt Guard 2 flagged the caller's words (score ${g.score.toFixed(2)}); not sent to the agent.`,
      });
      say(c, GUARD_LINE, c.status);
      return;
    }
    if (guard && !g) c.session.log({ kind: 'guard_unavailable', text: 'Prompt Guard did not answer; turn continued.' });
    c.session.heard(line);
    const cl = c.session.checklist;
    cl.set('words', 'clear', null, `No hazard words in ${c.turns} caller turn(s); last: "${line.slice(0, 80)}"`);
    // Mid-tour questions ("what's that pipe?", "is that normal?") are answered from what the tour has seen so far.
    if (c.tour && !c.tour.done && c.tour.found.size)
      c.history.push({
        role: 'user',
        content: `${tourMemo(c.tour).replace('The caller may now ask for a price; quote only what was seen.', 'The tour is still going.')} Answer the caller's question with answer_caller, from this and the current frame, in one or two sentences; the tour then continues.`,
      });
    // The voice must use the names the caller is reading on screen (11/02 boiler-room take: the outline said
    // "Water heater" and "Water softener" while the spoken answers said "boiler").
    const onScreen = (c.tour?.current ?? []).map((id) => c.tour.found.get(id)?.label).filter(Boolean);
    if (onScreen.length)
      c.history.push({
        role: 'user',
        content: `Outlined on the caller's screen right now: ${onScreen.join(', ')}. If the caller asks what something is, name it with exactly these labels; if you think a label is wrong, look again with inspect_frame before saying a different name.`,
      });
    // The first useful words come from code the moment the caller stops, not after Spark's 2-5 s plan
    // (red team #6, latency 1): "Let me look at the water heater." Only for a part we know, with a live
    // frame, outside a tour, on an English call; Spark is told it was said so it does not repeat it.
    // Only when the caller used the English word: a Spanish "el tubo" on a call not yet marked Spanish must
    // not get an English line (red team #8 M4).
    const named = guessPart(line);
    const ack =
      named &&
      line.toLowerCase().includes(named) &&
      !c.tour &&
      c.session.latestFrame() &&
      (c.session.lang?.() ?? 'en') === 'en'
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
    if (['escalated', 'booked', 'declined', 'handoff'].includes(c.status) || c.turns >= maxTurns(c)) return;
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

  const { track, scan, tourTick, plateWatch } = createCameraLoops({ now, say, note, autoTurn, exclusive });
  const listen = createListen({ now, say, exclusive, autoTurn });

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

  const booking = createBooking({ now, say, mayRaise, glimmer, sms, later });

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
      // No more scans once the call has an outcome: they would only spend (red team #7 L10).
      if (
        !dark &&
        !['escalated', 'booked', 'declined', 'handoff'].includes(c.status) &&
        !c.scanning &&
        c.scans < LIMITS.hazardScans &&
        (!c.lastScanAt || now() - c.lastScanAt >= LIMITS.scanEveryMs)
      )
        c.scanP = scan(c);
      if (
        !dark &&
        c.tour &&
        !c.tour.done &&
        !['escalated', 'booked', 'declined', 'handoff'].includes(c.status) &&
        !c.touring &&
        !c.busy &&
        now() >= (c.holdTourUntil ?? 0) &&
        c.status !== 'escalated' &&
        (!c.lastTourAt || now() - c.lastTourAt >= LIMITS.tourEveryMs)
      )
        c.tourP = tourTick(c);
      await track(c).catch(() => {});
      if (!dark && !['escalated', 'booked', 'declined', 'handoff'].includes(c.status))
        c.plateP = plateWatch(c).catch(() => {}); // a model read: never holds up the frame reply
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
      return listen(asCaller(callId, token), wav);
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
        const r = await runTool('find_part', { part, recheck: true }, c.ctx).catch((err) => ({
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
    /** The newest call this browser started (or, for the recording Mac, this local address), with its view link.
     *  `any`: the newest call of all, only in a private recording session where every call is the founder's. */
    latest({ creator = null, ip = null, any = false } = {}) {
      const mine = (c) => any || (creator && c.creator === creator) || (ip && c.ip === ip);
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
      return booking.decide(asOwner(callId, token), approve);
    },
    /**
     * The caller's own mobile for the confirmation text, proved with a one-time code (red team #4:
     * whoever holds the call link could otherwise have the business line text anyone).
     */
    async setMobile(callId, token, raw) {
      return booking.setMobile(asCaller(callId, token), raw);
    },
    verifyMobile(callId, token, code) {
      return booking.verifyMobile(asCaller(callId, token), code);
    },
    /** The owner sends (or drops) Glimmer's confirmation text. Only a finished draft, only once. */
    async sendConfirmation(callId, token, send) {
      return booking.sendConfirmation(asOwner(callId, token), send);
    },

    /** Read-only view for the console and the caller's page. Never includes tokens or raw frames. */
    view(callId) {
      return viewOf(get(callId), now);
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
    bookingIcsOf(callId, token) {
      return booking.ics(asOwner(callId, token));
    },
  };
}

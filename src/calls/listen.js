// Listen: a clip of the equipment itself (the tank refilling), measured in code (sound.js). A dangerous
// sound escalates in code; anything else goes to the agent as cited evidence. Split out of calls.js.
import { analyseSound, equipmentKind, EQUIPMENT_KINDS } from '../sound.js';
import { CallError, LIMITS } from './shared.js';

/** deps: { now, say(c, text, status), exclusive(c, fn), autoTurn(c, note) }. Returns listen(call, wav). */
export function createListen({ now, say, exclusive, autoTurn }) {
  return async function listen(c, wav) {
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
      // On the safety checklist too, so request_booking's camera-hazard check also refuses (red team #7 M8).
      c.session.checklist.add('sound', 'Hazard sound (Listen)', 'sound', 'escalate');
      c.session.checklist.set('sound', 'found', null, `${danger.sound}: ${danger.detail}`);
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
  };
}

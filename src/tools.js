// The agent's tools. The model only ever picks one of these; the code below
// decides what actually happens. Prices, hazards and bookings never come from
// the model's own words: propose_quote goes through the verifier, and
// book_visit only queues a request for the owner's tap.
import { verify, hazardIn } from './verifier.js';
import { locate } from './locate.js';

const fn = (name, description, properties, required = Object.keys(properties)) => ({
  type: 'function', name, description, strict: true,
  parameters: { type: 'object', properties, required, additionalProperties: false },
});
const str = (description) => ({ type: 'string', description });

export const DEFINITIONS = [
  fn('find_part', 'Look for a part in the live camera view. SAM 3.1 segments it; on a miss, code retries with an alternative noun and with a Muse Spark grounding point. Use plain object nouns, e.g. "faucet", "shut-off valve", "water heater", "breaker panel" (not states like "leak").', { part: str('what to find') }),
  fn('direct_camera', 'Tell the caller how to move the camera so the part or its label is visible.', { instruction: str('one short instruction, e.g. "Tilt down to the label on the tank"') }),
  fn('ask_caller', 'Ask the caller ONE question whose answer changes the price or urgency.', { question: str('one short question') }),
  fn('price_list', 'Read the owner\'s price list rows that match a job type.', { job_type: str('e.g. "water heater", "drain", "ac"') }),
  fn('check_calendar', 'First open visit slots for a job type.', { job_type: str('job type') }),
  fn('propose_quote', 'Propose a quote. The verifier decides what the caller hears.', {
    equipment: str('equipment seen'), issue: str('likely issue'), price_list_id: str('id of the price row'),
    box_ordinal: { type: 'integer', description: 'ordinal of the SAM box showing the equipment' }, notes: str('anything that affects safety or price'),
  }),
  fn('escalate', 'A hazard or something outside the price list: stop quoting and page the owner.', { reason: str('why') }),
  fn('request_booking', 'Ask the owner to approve a visit in a slot. The owner taps approve; only then is the visit booked (demo calendar in memory).', { slot_id: str('slot id from check_calendar'), brief: str('tech brief: equipment, issue, parts to bring') }),
];

/**
 * Runs one tool call against the session. Returns { output, say?, status? }.
 * ctx: { client, session, priceList, calendar, notifyOwner }
 */
export async function runTool(name, args, ctx) {
  const { session } = ctx;
  switch (name) {
    case 'find_part': {
      const frame = session.latestFrame();
      if (!frame) return { output: { error: 'no camera frame yet' }, say: 'Can you open the camera link I texted you?' };
      const part = String(args.part ?? '').slice(0, 60);
      const found = await locate(ctx.client, frame, part, { tap: session.tap?.() ?? null, now: ctx.now?.() ?? Date.now() });
      session.setBoxes(part, found.records, frame.at, { method: found.method, noun: found.noun, tries: found.tries, frameN: frame.n, luma: frame.luma ?? null });
      return { output: { part, method: found.method, noun: found.noun, boxes: found.records.map(({ ordinal, x1, y1, x2, y2, width, height, score, geo }) => ({ ordinal, x1, y1, x2, y2, width, height, score, area: Number(geo.area.toFixed(3)) })), guidance: session.guidance()?.state ?? null } };
    }
    case 'direct_camera':
      return { output: { said: args.instruction }, say: String(args.instruction).slice(0, 200), status: 'waiting_camera' };
    case 'ask_caller':
      return { output: { said: args.question }, say: String(args.question).slice(0, 200), status: 'waiting_caller' };
    case 'price_list': {
      // Match the job type, its trade, or words in the label; with no match, the whole
      // (short) list comes back so the agent can still pick a real row or escalate.
      const q = String(args.job_type ?? '').toLowerCase();
      const words = q.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
      const hit = (r) => [r.jobType, r.trade, r.label].filter(Boolean).map((x) => x.toLowerCase())
        .some((f) => f.includes(q) || q.includes(f) || words.some((w) => f.includes(w)));
      const rows = ctx.priceList.filter(hit);
      return { output: { rows: (rows.length ? rows : ctx.priceList).map(({ id, label }) => ({ id, label })), ...(rows.length ? {} : { note: 'no exact match: full list shown' }) } };
    }
    case 'check_calendar':
      return { output: { slots: ctx.calendar.slice(0, 3) } };
    case 'propose_quote': {
      const boxes = session.boxes().map((b) => ({ id: String(b.ordinal), label: session.lastPart(), score: b.score ?? 1 }));
      const v = verify(
        { equipment: args.equipment, issue: args.issue, priceListId: args.price_list_id, boxId: String(args.box_ordinal), notes: args.notes },
        { priceList: ctx.priceList, boxes, callerText: session.callerText(), cameraHazard: session.checklist?.foundEscalating() ?? false },
      );
      session.log({ kind: 'verify', result: v });
      if (v.action === 'escalate') { await ctx.notifyOwner?.({ urgent: true, reason: v.reason, transcript: session.callerText() }); return { output: v, say: v.reason, status: 'escalated' }; }
      if (v.action === 'quote') { session.setQuote(v); return { output: v, say: `For ${v.label} the price is $${(v.priceCents / 100).toFixed(2)}. The technician confirms on site.` }; }
      return { output: v, say: v.reason };
    }
    case 'escalate':
      await ctx.notifyOwner?.({ urgent: true, reason: args.reason, transcript: session.callerText() });
      return { output: { escalated: true }, say: 'I am getting the owner on this right now. If you smell gas or see smoke or fire, leave the house and call 911.', status: 'escalated' };
    case 'request_booking': {
      if (hazardIn(session.callerText()) || session.checklist?.foundEscalating()) return { output: { refused: 'hazard on this call' }, say: 'The owner is calling you about this now. No visit is booked until they do.', status: 'escalated' };
      const slot = ctx.calendar.find((s) => s.id === args.slot_id);
      if (!slot) return { output: { error: 'unknown slot' } };
      session.setPendingBooking({ slot, brief: String(args.brief).slice(0, 800), quote: session.quote() });
      return { output: { pending_owner_approval: true }, say: `I have asked the owner to confirm ${slot.label}. You will get a text when it is booked.`, status: 'awaiting_owner' };
    }
    default:
      return { output: { error: `unknown tool ${name}` } };
  }
}

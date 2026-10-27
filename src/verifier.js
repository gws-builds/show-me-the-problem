// The verification layer. It runs outside the model's control: the agent
// proposes, this code decides what may reach the caller. Prices come only
// from the owner's own list, equipment claims must point at a SAM box, and
// any hazard sign ends the quote and escalates to the owner.

const HAZARDS = [
  /gas (smell|leak)|smell(s|ing)? (of )?gas|rotten egg/i,
  /spark|arc(ing)?|scorch|burn(t|ed|ing) (smell|mark)|melt(ed|ing)/i,
  /exposed (wire|wiring)|live wire|bare wire/i,
  /water (on|near|in) (the )?(panel|breaker|outlet)/i,
  /carbon monoxide|co alarm|ceiling (sag|bulg)|structural/i,
];

/** True when the caller's words, the model's notes or the photo text show a hazard. */
export function hazardIn(...texts) {
  return texts.filter(Boolean).some((t) => HAZARDS.some((re) => re.test(String(t))));
}

/**
 * proposal: what the model wants to tell the caller, e.g.
 *   { equipment, issue, priceListId, boxId, hazardSeen, notes }
 * priceList: [{ id, label, priceCents }] from the owner, never from the model.
 * boxes: SAM 3.1 detections [{ id, label, score }].
 * Returns { action: 'quote' | 'escalate' | 'ask_retake' | 'tech_confirms', ... }.
 */
export function verify(proposal, { priceList = [], boxes = [], callerText = '', photoText = '' } = {}) {
  const checks = [];
  const pass = (name, ok, detail) => { checks.push({ name, ok, detail }); return ok; };

  // Hazards first: no price is ever given once one is seen.
  if (!pass('no hazard', !(proposal?.hazardSeen === true || hazardIn(callerText, proposal?.notes, proposal?.issue, photoText)), 'hazard words or flag')) {
    return { action: 'escalate', reason: 'Possible hazard: the owner is being called now. No price is given.', checks };
  }
  // The photo must show something SAM found with confidence.
  const box = boxes.find((b) => b.id === proposal?.boxId);
  if (!pass('equipment is in the photo', Boolean(box && box.score >= 0.5), box ? `box ${box.id} score ${box.score}` : 'no matching box')) {
    return { action: 'ask_retake', reason: 'We could not see the part clearly. Please send a closer photo.', checks };
  }
  // Price: only an exact row from the owner's list, with the list's own amount.
  const row = priceList.find((r) => r.id === proposal?.priceListId);
  if (!pass('price is on the owner\'s list', Boolean(row), row ? row.label : `model chose ${proposal?.priceListId ?? 'nothing'}`)) {
    return { action: 'tech_confirms', reason: 'The technician confirms the price on site.', checks };
  }
  return { action: 'quote', priceCents: row.priceCents, label: row.label, equipment: box.label, checks };
}

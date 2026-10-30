// The verification layer. It runs outside the model's control: the agent
// proposes, this code decides what may reach the caller. Prices come only
// from the owner's own list, equipment claims must point at a SAM box, and
// any hazard sign ends the quote and escalates to the owner.

// Word boundaries matter: a bare /arc/ escalated "search" and "March" (red team, Oct 29).
const HAZARDS = [
  /\bgas\b.{0,20}\b(smell|leak|odou?r|hiss)|\bsmell\w*\b.{0,15}\b(gas|propane)\b|\brotten eggs?\b|\bpropane\b.{0,20}\b(smell|leak)/i,
  /\bspark(s|ing|ed)?\b|\barc(s|ing|ed)?\b|\bscorch\w*|\bburn(t|ed|ing)?\b.{0,12}\b(smell|mark|plastic|wire|outlet)|\bmelt(ed|ing)?\b|\bsmok(e|ing)\b|\bflames?\b|\bon fire\b|\bfire\b.{0,10}\b(in|from|behind)\b/i,
  /\b(exposed|live|bare|loose|hanging)\b.{0,6}\bwir(e|es|ing)\b|\b(got |getting )?(shocked|electrocuted)\b|\bshock(s|ed)? me\b/i,
  /\bwater\b.{0,25}\b(panel|breaker|outlet|socket|wiring|electrical)\b|\b(panel|breaker|outlet)\b.{0,20}\b(wet|water|flood)/i,
  /\bcarbon monoxide\b|\b(co|carbon) (alarm|detector)\b.{0,15}\b(going off|beep|sound|alarm)|\bceiling\b.{0,12}\b(sag|bulg|collaps)|\bstructural\b|\bcollaps(e|ed|ing)\b/i,
  // Spanish (red team B4, Oct 29: "huele a gas" and "chispas" passed the gate). Muse Voice
  // Transcribe hears Spanish, so the code gate must read it too.
  /\b(huele|olor|oliendo|apesta)\b.{0,15}\bgas\b|\bfuga\w* de gas\b|\bgas\b.{0,15}\b(fuga|olor|huele|escap)\w*|\bhuevos? podridos?\b/i,
  /\bchispa(s|zos)?\b|\bchisporrote\w*|\bchispea\w*|\bhumo\b|\bfuego\b|\bincendio\b|\bse (est[aá] )?quem(a|ó|ando)\b|\bquemad[oa]s?\b|\bderretid[oa]s?\b|\ben llamas\b/i,
  /\bcables?\b.{0,15}\b(pelad|expuest|suelt|desnud|quemad)\w*|\b(me )?dio (una )?(descarga|toque|calambre)\b|\belectrocut\w*/i,
  /\bagua\b.{0,25}\b(panel|tablero|breaker|enchufe|toma ?corriente|cables?|el[eé]ctric\w*)|\b(panel|tablero|enchufe)\b.{0,20}\b(mojad\w*|agua|inundad\w*)/i,
  /\bmon[oó]xido\b|\b(alarma|detector)\b.{0,20}\b(mon[oó]xido|de co)\b|\btecho\b.{0,15}\b(hundi|colaps|cedi|cay)\w*|\bderrumb\w*/i,
];

// "No burning or scorching" is the absence of a hazard. A match counts unless a
// negation sits earlier in the same clause (red team Oct 29: the model's own note
// "no burning or scorching per caller" escalated a plain tripping breaker).
const NEGATED = /\b(no|not|without|never|nothing|none|neither|nor|isn'?t|wasn'?t|aren'?t|don'?t|doesn'?t|didn'?t|haven'?t|hasn'?t|can'?t|cannot|sin|nunca|nada|ni|tampoco)\b/i;
const CLAUSE = /[.!?;,]|\b(but|and|so|though|although|yet|because|now|then|except|pero|y|porque|aunque|ahora)\b/gi;
const lastClause = (s) => s.split(CLAUSE).filter((x) => x !== undefined).pop() ?? '';

// Which patterns are about bare or exposed wiring (English, Spanish). Used when code has already judged
// the camera's wiring finding (a cord visibly not connected to power is "attention", kb/cards/outlet_cord.json).
const WIRING = new Set([2, 7]);

function hazardInOne(text, skip = null) {
  const t = String(text);
  for (const [i, re] of HAZARDS.entries()) {
    if (skip?.has(i)) continue;
    for (const m of t.matchAll(new RegExp(re.source, 'gi'))) {
      // "gas tank, no leak visible" (eval wh01, Oct 30): a negation inside the match negates it too.
      if (!NEGATED.test(lastClause(t.slice(Math.max(0, m.index - 40), m.index))) && !NEGATED.test(m[0].split(/\s+/).slice(1).join(' '))) return true;
    }
  }
  return false;
}

/** True when the caller's words, the model's notes or the photo text show a hazard that is not negated. */
export function hazardIn(...texts) {
  return texts.filter(Boolean).some((t) => hazardInOne(t));
}

// The model's own quote notes talk about risk in general ("Stab-Lok panels are a known fire hazard",
// "a loose fitting could cause a leak"). That is not a sign seen on this call: the eval case ep04 was
// escalated by exactly such a note (Oct 30). Clauses that only describe a possibility, a reputation or
// a question are dropped before the hazard words are matched. Observed signs ("scorch marks on the
// main breaker") still escalate, and the caller's own words are never filtered.
const HYPOTHETICAL = /\b(known|reputation|reported|history of|prone|tend(s|ency)?|risk|could|can|may|might|would|possible|possibly|potential(ly)?|if|whether|check(ed)? for|ask(ed)? about|rule out|recall(ed|s)?|inspector|flagged|older|brand)\b|\b(fire|shock|safety) hazards?\b|\?/i;
const SENTENCE = /[.;!?\n]+|\b(but|and|so|though|although)\b/i;
export function modelNoteHazardIn(...texts) {
  return modelNoteHazard(texts);
}
/** wiringSettled: the camera's wiring finding was already judged in code, so the model restating it is not new evidence. */
function modelNoteHazard(texts, { wiringSettled = false } = {}) {
  const skip = wiringSettled ? WIRING : null;
  return texts.filter(Boolean).some((t) => String(t).split(SENTENCE).filter((x) => x && !HYPOTHETICAL.test(x)).some((x) => hazardInOne(x, skip)));
}

/**
 * proposal: what the model wants to tell the caller, e.g.
 *   { equipment, issue, priceListId, boxId, hazardSeen, notes }
 * priceList: [{ id, label, priceCents }] from the owner, never from the model.
 * boxes: SAM 3.1 detections [{ id, label, score }].
 * Returns { action: 'quote' | 'escalate' | 'ask_retake' | 'tech_confirms', ... }.
 */
export function verify(proposal, { priceList = [], boxes = [], outlines = [], callerText = '', photoText = '', cameraHazard = false, wiringSettled = false } = {}) {
  const checks = [];
  const pass = (name, ok, detail) => { checks.push({ name, ok, detail }); return ok; };

  // Hazards first: no price is ever given once one is seen.
  if (!pass('no hazard', !(cameraHazard || proposal?.hazardSeen === true || hazardIn(callerText, photoText) || modelNoteHazard([proposal?.notes, proposal?.issue], { wiringSettled })), cameraHazard ? 'camera hazard confirmed by Spark and SAM' : 'hazard words or flag')) {
    return { action: 'escalate', reason: 'Possible hazard: the owner is being called now. No price is given.', checks };
  }
  // The photo must show something SAM found with confidence: the box the model named, or else an
  // outline SAM already drew on this call (evidence ledger) at 0.5 or more. The model naming the
  // wrong ordinal after a later miss (eval ac02) is not a reason to ask for another photo.
  let box = boxes.find((b) => b.id === proposal?.boxId && b.score >= 0.5) ?? null;
  const prior = !box ? [...outlines].filter((o) => (o.confidence ?? 0) >= 0.5).sort((a, b) => (b.frame ?? 0) - (a.frame ?? 0))[0] : null;
  if (prior) box = { id: prior.id, label: prior.part, score: prior.confidence };
  if (!pass('equipment is in the photo', Boolean(box && box.score >= 0.5), box ? `${prior ? `outline ${prior.id} on frame ${prior.frame}` : `box ${box.id}`} score ${box.score}` : 'no matching box')) {
    return { action: 'ask_retake', reason: 'We could not see the part clearly. Please send a closer photo.', checks };
  }
  // Price: only an exact row from the owner's list, with the list's own amount.
  const row = priceList.find((r) => r.id === proposal?.priceListId);
  if (!pass('price is on the owner\'s list', Boolean(row), row ? row.label : `model chose ${proposal?.priceListId ?? 'nothing'}`)) {
    return { action: 'tech_confirms', reason: 'The technician confirms the price on site.', checks };
  }
  return { action: 'quote', priceCents: row.priceCents, label: row.label, equipment: box.label, checks };
}

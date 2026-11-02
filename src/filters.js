// The code gates every spoken or written line passes, in one place (red team #5, Q13): no prices outside
// the verifier, no contact details or payment requests in the business voice, and a timing-safe compare
// for tokens and codes. A blocked sentence is replaced, never the whole line.
import { timingSafeEqual } from 'node:crypto';

// Model-written lines never carry a price: only the verifier's answer to propose_quote may
// (red team 10/31: a caller could talk the agent into "the visit is $1"). A sentence with
// an amount is replaced in code.
const AMOUNT =
  /[$€£¥]\s*\d|\b\d[\d,.]*\s*(dollars?|bucks|usd|eur(?:os?)?|d[oó]lares)\b|\bfree (?:of charge|visit|call|quote|inspection|estimate)\b|\bno (?:charge|cost)\b|\bcosts? nothing\b|\bgratis\b|\b\d{1,3}(?:,\d{3})+\b/i;
// A price said in words gets past a digit check (red team #6 B-6: "two hundred bucks", "one fifty for the
// visit", "that is 150"). A sentence is priced when it has a number (in words, or a bare 2-4 digit figure that
// is not a time, a year or a measurement) together with a money word, or a number followed by "for the visit/job".
// Red team #7 M6 added the words around a price ("the visit is 89", "around 89 total", "normally 89 but for
// you 1"), Spanish tens, other currencies and "free visit".
const NUM_WORD = String.raw`(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|grand|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|doscientos|trescientos|cuatrocientos|quinientos|mil)`;
const BARE_NUM = String.raw`(?<!\bto\s)\b(?!(?:19|20)\d{2}\b)\d{2,4}\b(?![\s-]*(?:to\s+\d|am|pm|a\.m|p\.m|:|%|°|degrees?|seconds?|secs?|minutes?|mins?|hours?|days?|weeks?|months?|years?|a[nñ]os|gallons?|gal|litres?|liters?|psi|amps?|volts?|watts?|btu|kw|lbs?|feet|ft|foot|inch(?:es)?|in\b|cm|mm|metres?|meters?))`;
const MONEY_WORD =
  /\b(?:price[sd]?|cost[s]?|charges?|fees?|run(?:s)? (?:you|about|around)|bucks|dollars?|quote[sd]?|pay|visit|total|bill|parts|labou?r|flat|rate|about|around|roughly|near|usually|normally|typically|for you|precio|cuesta|cobra|cobramos|d[oó]lares|son)\b/i;
const NUMBER = new RegExp(`\\b${NUM_WORD}\\b|${BARE_NUM}`, 'i');
const FOR_THE_JOB = new RegExp(
  `(?:\\b${NUM_WORD}\\b(?:[\\s-]+${NUM_WORD}\\b)*|\\b\\d{2,5}\\b)\\s+for (?:the|your|this|that) [a-z]`,
  'i',
);
const priced = (sentence) =>
  AMOUNT.test(sentence) || FOR_THE_JOB.test(sentence) || (MONEY_WORD.test(sentence) && NUMBER.test(sentence));
export const NO_PRICE_LINE = "The price comes only from the owner's list, once I have seen the problem.";
export function noPrice(text) {
  const parts = String(text ?? '').split(/(?<=[.!?])\s+/);
  const kept = parts.filter((p) => !priced(p));
  if (kept.length === parts.length) return { text: String(text ?? ''), blocked: false };
  return { text: [...kept, NO_PRICE_LINE].join(' ').trim(), blocked: true };
}

/** True when the text carries an amount of money (used to blank model-written fields). */
export const hasMoney = (text) =>
  String(text ?? '')
    .split(/(?<=[.!?])\s+/)
    .some(priced);

// Injected text (a sign on camera, a label, the caller) must not make the business voice read out a
// link, an email, a phone number or a payment request (red team 10/31). The office sends those itself.
const CONTACT =
  /\b(?:https?:\/\/|www\.)\S+|\b[\w.+-]+@[\w-]+\.[\w.]+\b|\b[\w-]+\.(?:com|net|org|io|co|info|biz|xyz|app|link|ly|me)\b|(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b|\b(?:deposit|wire|venmo|zelle|cash ?app|paypal|gift card|bitcoin|crypto|card number|pay (?:now|first|upfront|up front|in advance|the technician|us))\b/i;
// Said out loud instead of written: "fix it dot com", "four one six five five five ..." (red team #6 B-6).
const SPOKEN_CONTACT =
  /\b(?:dot|punto)\s+(?:com|net|org|ca|io|co|info|app)\b|\b(?:at|arroba)\s+\w+\s+(?:dot|punto)\b|(?:\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\b[\s,.-]*){7,}/i;
export function noContact(text) {
  const parts = String(text ?? '').split(/(?<=[.!?])\s+/);
  const kept = parts.filter((p) => !CONTACT.test(p) && !SPOKEN_CONTACT.test(p));
  if (kept.length === parts.length) return { text: String(text ?? ''), blocked: false };
  return { text: [...kept, 'The office will text you the details.'].join(' ').trim(), blocked: true };
}

/** Constant-time equality for tokens and access codes; false for anything that is not two equal-length strings. */
export const safeEqual = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

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
// visit", "that is 150"). Red team #8 H1: the first version (RT7 M6) also treated "about", "around", "near"
// and every number word as money, so "hold the phone about two feet away" and a boiler-tour hint were
// replaced. Now:
//   - a strong money word (price, cost, fee, bucks, quote...) with any number that is not a measurement;
//   - a soft word (visit, about, usually, just, would be...) only with a figure that looks like an amount:
//     2-4 digits, a decimal, or a compound number in words ("eighty nine", "a hundred and fifty");
//   - always: a currency sign or name, "89.99", "for 89.", "89 plus tax", "1k", "<n> for the <job>".
// Measurements are never amounts: a number followed by a unit (feet, years, gallons, steps, turns...).
const ONES = String.raw`(?:one|two|three|four|five|six|seven|eight|nine|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)`;
const TENS = String.raw`(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa)`;
const NUM_WORD = String.raw`(?:${ONES}|ten|eleven|twelve|fifteen|${TENS}|hundred|thousand|grand|cien|ciento|doscientos|trescientos|cuatrocientos|quinientos|mil)`;
const UNIT = String.raw`(?:to\s+\d|am\b|pm\b|a\.m|p\.m|:|%|°|degrees?|seconds?|secs?|minutes?|mins?|hours?|days?|weeks?|months?|years?|a[nñ]os|gallons?|gal\b|litres?|liters?|psi|amps?|volts?|watts?|btu|kw\b|lbs?|pounds?|feet|ft\b|foot|inch(?:es)?|in\b|cm\b|mm\b|metres?|meters?|steps?|turns?|quarters?|sides?|things?|times?|parts?|pieces?|screws?|wires?|pipes?|valves?|breakers?|of\b|or\b|more\b|moments?|ways?|people|kids?|gauge|awg|setting)`;
const NOT_UNIT = String.raw`(?![\s-]*(?:and\s+\w+[\s-]+)?${UNIT})`;
const MONTH = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?`;
const BARE_NUM = String.raw`(?<!\bto\s)(?<!\bto (?:about|around|roughly)\s)(?<!\b${MONTH}\s)(?<!\b\d{1,2}\s(?:and|or)\s)(?<!\blas\s)\b(?!(?:19|20)\d{2}\b)\d{2,4}\b${NOT_UNIT}`;
const DECIMAL = String.raw`\b\d+\.\d{2}\b${NOT_UNIT}`;
const STRONG =
  /\b(?:price[sd]?|cost[s]?|charge[sd]?|fees?|bucks?|dollars?|quote[sd]?|pay(?:ing)? (?:about|around|just|only|\$|\d)|bill|total|rate|labou?r|precio|cuesta|cobra|cobramos|d[oó]lares)\b/i;
const SOFT =
  /\b(?:visit|about|around|roughly|near|usually|normally|typically|for you|son|flat|would be|under|over|vale|give or take|including|includes|just under|just over)\b/i;
const ANY_NUMBER = new RegExp(`\\b${NUM_WORD}\\b${NOT_UNIT}|${BARE_NUM}|${DECIMAL}`, 'i');

// A whole price word by word: it contains a tens or hundreds word ("fifty", "eighty-nine", "two forty nine",
// "a hundred and fifty", "eighty nine fifty"); never a bare "one" or "two" ("use the one for the hot side",
// red team #9 L5).
const BIG = String.raw`(?:${TENS}|ten|eleven|twelve|fifteen|hundred|thousand|grand|cien|ciento|doscientos|trescientos|cuatrocientos|quinientos|mil)`;
const PIECE = String.raw`(?:${ONES}|${BIG})`;
const WORD_PRICE = String.raw`\b(?:(?:a|${ONES})[\s-]+)?${BIG}(?:[\s-]+(?:and\s+|y\s+)?${PIECE})*\b`;
const FIGURE = String.raw`\$?\d{2,5}(?:\.\d{2})?`;
const END = String.raw`(?=\s*(?:[.!?,;]|$|and\b|plus\b|total\b|even\b|flat\b|bucks?\b))`;
// After a number in words, skip any further number words before looking for the unit ("twenty five years").
const WORDS_NOT_UNIT = String.raw`(?![\s-]*(?:(?:and\s+|y\s+)?${PIECE}[\s-]+)*${UNIT})`;
const AMOUNT_LIKE = new RegExp(`${BARE_NUM}|${DECIMAL}|${WORD_PRICE}${WORDS_NOT_UNIT}`, 'i');
// Lines about the equipment itself (a dial, a breaker, a model number, a pressure) use numbers that are not
// money; a soft word there ("usually", "about") is not enough to call it a price (red team #9 M2).
const EQUIPMENT_TALK =
  /\b(?:thermostat|dial|setting|breaker|model|cartridge|serial|pressure|temperature|gauge|tank|wire|valve position|label(?:l?ed)?|number)\b/i;
const ALWAYS = new RegExp(
  [
    DECIMAL,
    // "We do it for 89." A duration ("let it run for 30", "hold it for 10") has no doing-the-job verb (red team #9 M2).
    String.raw`\b(?:do|does|did|fix|fixes|repair|replace|replaces|install|get it done|charge)\b[^.!?]{0,25}\bfor\s+(?:just\s+|only\s+)?${FIGURE}${END}`,
    // "Just 89 and we are done", "it comes to 89 even", "call it 89": a figure ending the phrase, not "just the 1225 cartridge".
    String.raw`\b(?:just|only|runs|comes to|call it)\s+${FIGURE}${END}`,
    // The whole sentence is an amount: "It is 149.", "Two hundred.", "That's eighty nine."
    String.raw`^\s*(?:(?:it|that|that one|this|the visit|the job|the flush|the repair)(?:'s|\s+is|\s+will be|\s+would be)\s+)?(?:${FIGURE}|${WORD_PRICE})\s*[.!]?\s*$`,
    String.raw`\b(?:it|that|this|the visit|the call|the quote|the job)(?:'s|\s+is|\s+will be|\s+would be)\s+(?:totally\s+|completely\s+)?free\b`,
    String.raw`\bplus (?:tax|hst|gst|vat)\b`,
    String.raw`\b\d{2,5}\s*(?:ish\b|out the door|all in\b|for (?:everything|both|all of it)\b)|\bon the house\b`,
    String.raw`\b(?:figure|i would say|i'd say|sale en|sale por)\s+(?:${FIGURE}|${WORD_PRICE})\b`,
    String.raw`\b\d+(?:\.\d+)?k\b${NOT_UNIT}`,
    String.raw`(?:${WORD_PRICE}|\b\d{2,5}\b)\s+for (?:the|your|this|that) [a-z]`,
  ].join('|'),
  'i',
);
const priced = (sentence) =>
  AMOUNT.test(sentence) ||
  ALWAYS.test(sentence) ||
  (STRONG.test(sentence) && ANY_NUMBER.test(sentence)) ||
  (SOFT.test(sentence) && !EQUIPMENT_TALK.test(sentence) && AMOUNT_LIKE.test(sentence));
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

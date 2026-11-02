// The code gates every spoken or written line passes, in one place (red team #5, Q13): no prices outside
// the verifier, no contact details or payment requests in the business voice, and a timing-safe compare
// for tokens and codes. A blocked sentence is replaced, never the whole line.
import { timingSafeEqual } from 'node:crypto';

// Model-written lines never carry a price: only the verifier's answer to propose_quote may
// (red team 10/31: a caller could talk the agent into "the visit is $1"). A sentence with
// an amount is replaced in code.
const AMOUNT = /\$\s*\d|\b\d[\d,.]*\s*(dollars?|bucks|usd|d[oó]lares)\b|\bfree of charge\b|\bno charge\b/i;
export const NO_PRICE_LINE = "The price comes only from the owner's list, once I have seen the problem.";
export function noPrice(text) {
  const parts = String(text ?? '').split(/(?<=[.!?])\s+/);
  const kept = parts.filter((p) => !AMOUNT.test(p));
  if (kept.length === parts.length) return { text: String(text ?? ''), blocked: false };
  return { text: [...kept, NO_PRICE_LINE].join(' ').trim(), blocked: true };
}

/** True when the text carries an amount of money (used to blank model-written fields). */
export const hasMoney = (text) => AMOUNT.test(String(text ?? ''));

// Injected text (a sign on camera, a label, the caller) must not make the business voice read out a
// link, an email, a phone number or a payment request (red team 10/31). The office sends those itself.
const CONTACT =
  /\b(?:https?:\/\/|www\.)\S+|\b[\w.+-]+@[\w-]+\.[\w.]+\b|\b[\w-]+\.(?:com|net|org|io|co|info|biz|xyz|app|link|ly|me)\b|(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b|\b(?:deposit|wire|venmo|zelle|cash ?app|paypal|gift card|bitcoin|crypto|card number|pay (?:now|first|upfront|up front|in advance|the technician|us))\b/i;
export function noContact(text) {
  const parts = String(text ?? '').split(/(?<=[.!?])\s+/);
  const kept = parts.filter((p) => !CONTACT.test(p));
  if (kept.length === parts.length) return { text: String(text ?? ''), blocked: false };
  return { text: [...kept, 'The office will text you the details.'].join(' ').trim(), blocked: true };
}

/** Constant-time equality for tokens and access codes; false for anything that is not two equal-length strings. */
export const safeEqual = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

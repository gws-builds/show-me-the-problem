// Access-code gate for every page and API, on top of the per-call tokens. The founder records over
// a temporary https tunnel and judges get a link only at judging time, so a stranger who finds the
// URL must get nothing: no page, no API, no WebSocket, no model spend.
// - The code is random, made when the server starts, written to .data/access_code (mode 600). It is
//   never logged or committed; scripts read it from that file.
// - /k/<code> sets an HttpOnly, SameSite=Strict cookie and redirects, so the code leaves the address bar.
//   Scripts may send it as the x-access-code header instead.
// - Wrong codes are counted per client: 20 misses in 10 minutes and that client is refused for 10 minutes.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';

export const COOKIE = 'smtp_access';
export const MISS_LIMIT = 20;
export const MISS_WINDOW_MS = 10 * 60_000;
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes (l/1, o/0, i)

/** 15 characters from a 31-letter alphabet (about 74 bits), grouped for reading: xxxxx-xxxxx-xxxxx. */
export function newCode() {
  const b = randomBytes(15);
  const s = [...b].map((x) => ALPHABET[x % ALPHABET.length]).join('');
  return `${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10)}`;
}

/** Makes a new code for this server start and stores it (owner read/write only). Returns the code. */
export function writeCode(file) {
  const code = newCode();
  fs.writeFileSync(file, code, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return code;
}

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function cookieValue(header, name = COOKIE) {
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

export function createGate({ code, now = () => Date.now() }) {
  if (typeof code !== 'string' || code.length < 12) throw new Error('access code missing or too short');
  const misses = new Map();
  const recent = (key) => (misses.get(key) ?? []).filter((t) => now() - t < MISS_WINDOW_MS);
  return {
    /** True when this client has missed too often and is locked out for now. */
    locked: (key) => recent(key).length >= MISS_LIMIT,
    /**
     * Checks a presented code. Misses count per client key when `count` is true (a typed link or a
     * header); a stale cookie from an earlier server start does not count, or a polling page would
     * lock its owner out.
     */
    check(presented, key = 'unknown', { count = true } = {}) {
      if (recent(key).length >= MISS_LIMIT) return false;
      if (presented && same(String(presented), code)) return true;
      if (presented && count) misses.set(key, [...recent(key), now()]);
      return false;
    },
    /** The code a request carries: header first, then the cookie. Never the URL (except /k/, handled by the server). */
    presented: (req) => String(req.headers['x-access-code'] ?? '') || cookieValue(req.headers.cookie),
    cookie: (secure) => `${COOKIE}=${encodeURIComponent(code)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? '; Secure' : ''}`,
    sweep() { for (const [k] of misses) if (!recent(k).length) misses.delete(k); },
  };
}

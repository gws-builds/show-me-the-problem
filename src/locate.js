// Grounded handoff: how the agent finds a named part in a frame.
//   1. A point the caller tapped (fresh) -> SAM point prompt.
//   2. SAM text prompt with a plain noun ("pipe", not "pipe leak": SAM wants objects, not states).
//   3. On a miss, in parallel: SAM with an alternative noun, and Muse Spark grounding
//      (a box and a point on a 0-1000 grid). The box goes to SAM as a box prompt first: the
//      outline counts only if SAM's object fills Spark's box (IoU >= 0.5, two models agree).
//      Otherwise the point goes to SAM as a point prompt, as before.
// The best record wins; the verifier still requires confidence >= 0.5 before any quote.
import { maskGeometry, dataUrlSize } from './mask.js';
import { samNounsFor } from './kb.js';

export const MIN_SCORE = 0.5;
export const BOX_AGREE_IOU = 0.5; // SAM's box-prompt outline must match Spark's box this well
const MAX_BOX_FRAC = 0.9; // a "box" around nearly the whole frame says nothing about where the part is

/** Intersection over union of two boxes {x1,y1,x2,y2} in the same units. */
export function iou(a, b) {
  const w = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)); const h = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const i = w * h; const u = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - i;
  return u > 0 ? i / u : 0;
}
export const TAP_FRESH_MS = 20_000;

// Words that describe a state, not an object: SAM matches objects.
const STATE_WORDS = /\b(leak(s|ing|y)?|drip(s|ping|py)?|broken|old|rusty|rusted|corroded|bad|worn|faulty|underside|bottom|base|of|the|a|an|my|under|below|beneath)\b/gi;

export const ALT_NOUNS = {
  faucet: ['spout', 'tap'],
  spout: ['faucet'],
  cartridge: ['faucet handle', 'faucet'],
  'faucet handle': ['faucet'],
  'o-ring': ['faucet', 'spout'],
  valve: ['shut-off valve', 'pipe'],
  'shut-off valve': ['valve', 'pipe'],
  'supply line': ['pipe', 'hose'],
  pipe: ['valve', 'drain pipe'],
  'water heater': ['tank', 'boiler'],
  'garbage disposal': ['disposal', 'sink drain'],
  disposal: ['garbage disposal'],
  thermostat: ['wall display', 'circuit board'],
  'sump pump': ['pump', 'pit'],
  'breaker panel': ['electrical panel', 'circuit breaker'],
  'air conditioner condenser': ['air conditioner', 'condenser'],
  outlet: ['wall socket', 'power socket'],
  'stove burner': ['stove', 'gas burner'],
};

/** Plain object nouns to try for a requested part, primary first, at most 3. */
export function nounsFor(part) {
  const raw = String(part ?? '').toLowerCase().replace(/[^a-z0-9\- ]/g, ' ');
  const plain = raw.replace(STATE_WORDS, ' ').replace(/\s+/g, ' ').trim() || raw.trim();
  const out = [plain];
  for (const key of [plain, ...plain.split(' ').reverse()]) for (const alt of ALT_NOUNS[key] ?? []) out.push(alt);
  if (plain.includes(' ')) out.push(plain.split(' ').pop());
  out.push(...samNounsFor(plain)); // the knowledge-base card's SAM noun for this part, last
  return [...new Set(out.filter(Boolean))].slice(0, 3);
}

// A record without a confidence counts as 1, as in the verifier (we always ask SAM for one).
const sc = (r) => r?.score ?? 1;
const best = (records) => [...records].sort((a, b) => sc(b) - sc(a))[0] ?? null;
const ok = (r) => Boolean(r) && sc(r) >= MIN_SCORE;

/**
 * client: Meta client; frame: { dataUrl, at }; tap: { x, y, at } normalized 0..1, or null.
 * Returns { noun, method, records (with .geo), tries: [{ method, noun, n, score }] }.
 */
export async function locate(client, frame, part, { tap = null, now = Date.now() } = {}) {
  const nouns = nounsFor(part);
  const tries = [];
  const size = dataUrlSize(frame.dataUrl);
  const attempt = async (method, noun, run) => {
    let records = [];
    try { const out = await run(); if (Array.isArray(out)) records = out; else { records = out.records; method = out.method; } } catch (err) { if (err?.code) throw err; tries.push({ method, noun, n: 0, error: String(err.message).slice(0, 80) }); return { method, noun, records }; }
    if (method !== 'grounded box') tries.push({ method, noun, n: records.length, score: best(records)?.score ?? null }); // the box try logged itself, with its IoU
    return { method, noun, records };
  };
  const results = [];
  if (tap && size && now - tap.at < TAP_FRESH_MS) {
    results.push(await attempt('tap', nouns[0], () => client.segmentPoint(frame.dataUrl, { x: tap.x * size.width, y: tap.y * size.height, ...size })));
  }
  if (!results.some((r) => ok(best(r.records)))) results.push(await attempt('text', nouns[0], () => client.segment(frame.dataUrl, nouns[0])));
  if (!results.some((r) => ok(best(r.records)))) {
    const parallel = [];
    for (const noun of nouns.slice(1, 3)) parallel.push(attempt('alt noun', noun, () => client.segment(frame.dataUrl, noun)));
    if (size) {
      parallel.push(attempt('grounded', nouns[0], async () => {
        const pts = await client.ground(frame.dataUrl, nouns.slice(0, 2));
        tries.push({ method: 'spark grounding', noun: nouns.slice(0, 2).join(' / '), n: pts.length, point: pts[0] ? [pts[0].x, pts[0].y] : null });
        if (!pts.length) return [];
        const b = pts[0].box;
        if (b && client.segmentBox && (b[2] - b[0]) * (b[3] - b[1]) < MAX_BOX_FRAC * 1e6) {
          const spark = { x1: (b[0] * size.width) / 1000, y1: (b[1] * size.height) / 1000, x2: (b[2] * size.width) / 1000, y2: (b[3] * size.height) / 1000 };
          const recs = await client.segmentBox(frame.dataUrl, { ...spark, ...size });
          const t = best(recs);
          const agree = t ? iou(t, spark) : 0;
          tries.push({ method: 'grounded box', noun: nouns[0], n: recs.length, score: t?.score ?? null, iou: Number(agree.toFixed(2)) });
          if (ok(t) && agree >= BOX_AGREE_IOU) return { records: recs, method: 'grounded box' };
        }
        return client.segmentPoint(frame.dataUrl, { x: (pts[0].x * size.width) / 1000, y: (pts[0].y * size.height) / 1000, ...size });
      }));
    }
    results.push(...(await Promise.all(parallel)));
  }
  const winner = results.map((r) => ({ ...r, top: best(r.records) })).sort((a, b) => (b.top ? sc(b.top) : -1) - (a.top ? sc(a.top) : -1))[0];
  const records = [...(winner?.records ?? [])].sort((a, b) => sc(b) - sc(a)).slice(0, 3)
    .map((r) => ({ ...r, mask: undefined, geo: maskGeometry(r) }));
  return { noun: winner?.noun ?? nouns[0], method: records.length ? winner.method : 'none', records, tries };
}

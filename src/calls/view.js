// The read-only view of a call for the console and the caller's page. Never includes tokens or raw frames.
import { workOrder } from '../evidence.js';
import { toLang } from '../i18n.js';
import { tourView } from '../tour.js';

const p50 = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

export function viewOf(c, now) {
  const p = c.session.pendingBooking();
  const g0 = c.session.guidance();
  const g = g0?.words ? { ...g0, words: toLang(g0.words, c.session.lang?.()) } : g0;
  return {
    id: c.id,
    now: now(),
    status: c.status,
    turns: c.turns,
    spentUsd: Math.round(c.client.spent() * 10000) / 10000,
    says: c.says,
    events: c.session.events(),
    pages: c.pages.map(({ reason, at, urgent }) => ({ reason, at, urgent })),
    pending: p
      ? {
          slot: p.slot,
          brief: p.brief,
          quote: p.quote,
          workOrder: c.booking ? null : workOrder(c.session, { slot: p.slot, quote: p.quote }),
        }
      : null,
    evidence: c.session.evidence.list(),
    booking: c.booking,
    mobile: c.mobile ? `…${c.mobile.slice(-4)}` : null,
    annotated: Boolean(c.annotated),
    hasFrame: Boolean(c.session.latestFrame()),
    staged: c.staged,
    checklist: c.session.checklist.list(),
    boxes: c.session.boxes(),
    part: c.session.lastPart(),
    tracking: Boolean(c.tracking),
    guidance: g,
    lang: c.session.lang?.() ?? 'en',
    footage: c.footage,
    latency: { p50: p50(c.latencies), n: c.latencies.length },
    tour: tourView(c.tour),
    cards: c.session.cards(),
    capUsd: c.client.cap?.() ?? null,
    // What the call saved the owner, from this call's own record (the owner page's results strip).
    results: {
      callMinutes: Math.round((now() - c.createdAt) / 6000) / 10,
      minutesToQuote: c.session.quotedAt() ? Math.round((c.session.quotedAt() - c.createdAt) / 6000) / 10 : null,
      quotedCents: c.session.quote()?.priceCents ?? null,
      ownerTaps: c.booking ? 1 : 0,
      booked: Boolean(c.booking?.approved),
    },
  };
}

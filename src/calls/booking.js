// After the call: the owner's decision (Muse Wonder review, Glimmer follow-up, Muse Image illustration in
// the background), the caller's mobile proved by a one-time code, the confirmation text and the calendar
// invite. Callers have already checked the caller's or owner's token. Split out of calls.js.
import { randomInt } from 'node:crypto';

import { draftFollowUp } from '../afterBooking.js';
import { workOrder } from '../evidence.js';
import { safeEqual } from '../filters.js';
import { bookingIcs } from '../ics.js';
import { reviewWorkOrder } from '../review.js';
import { normaliseMobile } from '../sms.js';
import { CallError, LIMITS } from './shared.js';

/** deps: { now, say(c, text, status), mayRaise(c, usd), glimmer, sms, later(fn, ms) } */
export function createBooking({ now, say, mayRaise, glimmer, sms, later }) {
  const codeTexts = []; // { at, to } of one-time-code texts, for the server-wide cap
  return {
    async decide(c, approve) {
      const p = c.session.pendingBooking();
      if (!p) throw new CallError('Nothing is waiting for approval.', 409, 'NOTHING_PENDING');
      if (c.status === 'escalated')
        throw new CallError('This call was escalated as a hazard. Call the customer first.', 409, 'HAZARD');
      if (c.booking) throw new CallError('Already decided.', 409, 'DECIDED');
      c.booking = {
        approved: Boolean(approve),
        slot: p.slot,
        brief: p.brief,
        quote: p.quote,
        at: now(),
        workOrder: approve ? workOrder(c.session, { slot: p.slot, quote: p.quote }) : null,
      };
      c.session.log({ kind: 'owner_decision', approved: Boolean(approve), slot: p.slot.label });
      if (c.tour) c.tour.done = true; // the decision ends the call's tour: no more steps, spend or price offers
      if (!approve) {
        say(c, 'The office could not take that slot. They will text you another time.', 'declined');
        return { ok: true };
      }
      say(c, `You're booked for ${p.slot.label}. The technician will bring what's in the brief.`, 'booked');
      // Muse Wonder reviews the approved work order for the technician, beside the booking, never blocking it.
      c.booking.review = { status: 'running' };
      // Its own allowance on top of what the call spent, so a long call still gets its plan (red team 10/31); never past MAX_RUN_USD.
      if (mayRaise(c, c.client.spent() + 0.1)) c.client.setCap(c.client.spent() + 0.1);
      const t0 = now();
      const spent0 = c.client.spent?.() ?? null;
      reviewWorkOrder(c.client, c.booking.workOrder, c.session.evidence.list())
        .then((r) => {
          c.booking.review = { status: 'done', ...r };
          c.session.log({
            kind: 'wonder_review',
            steps: r.steps.length,
            gaps: r.gaps.length,
            dropped: r.dropped,
            ms: now() - t0,
            costUsd: spent0 == null ? null : Math.max(0, c.client.spent() - spent0),
          });
        })
        .catch((err) => {
          c.booking.review = { status: 'failed' };
          c.session.log({ kind: 'error', text: `review: ${String(err.message).slice(0, 160)}` });
        });
      // Muse Glimmer (open weights, the business's own GPU) drafts the truck list and the customer's
      // confirmation text; the text waits for the owner's Send. Skipped when no endpoint is configured.
      if (glimmer) {
        c.booking.followUp = { status: 'running' };
        draftFollowUp(
          glimmer,
          c.booking.workOrder,
          c.session.evidence.list(),
          c.session.latestFrame()?.dataUrl ?? null,
          { now, lang: c.session.lang?.() ?? 'en' },
        )
          .then((r) => {
            c.booking.followUp = { status: 'draft', ...r };
            c.session.log({
              kind: 'glimmer_followup',
              parts: r.parts.length,
              dropped: r.dropped,
              ms: r.ms,
              costUsd: r.costUsd,
            });
          })
          .catch((err) => {
            c.booking.followUp = { status: 'failed' };
            c.session.log({ kind: 'error', text: `follow-up: ${String(err.message).slice(0, 160)}` });
          });
      }
      // The evidence stills are drawn in code from SAM masks (owner page). Muse Image adds a separate,
      // clearly labelled illustration; it is never used as evidence. Best effort: a failure never blocks the booking.
      const frame = c.session.latestFrame();
      const box = c.session.boxes()[0];
      // In the background, like Wonder and Glimmer: the owner's tap returns at once (red team #3).
      if (frame && box) {
        c.client
          .annotate(
            frame.dataUrl,
            `Draw a bright red rectangle around the ${c.session.lastPart()} (pixels x ${box.x1}-${box.x2}, y ${box.y1}-${box.y2}) and a short label "${c.session.lastPart()}". Change nothing else.`,
          )
          .then((img) => {
            c.annotated = img;
            c.session.log({ kind: 'annotated', ok: Boolean(img) });
          })
          .catch((err) => c.session.log({ kind: 'error', text: `annotate: ${String(err.message).slice(0, 160)}` }));
      }
      return { ok: true };
    },

    /**
     * The caller's own mobile for the confirmation text, proved with a one-time code (red team #4:
     * whoever holds the call link could otherwise have the business line text anyone). Three numbers
     * per call at most; no change once the owner has decided the booking.
     */
    async setMobile(c, raw) {
      if (c.booking) throw new CallError('The booking is decided; the number cannot change now.', 409, 'LOCKED');
      if (!sms) throw new CallError('Texting is off on this demo; the confirmation shows on screen.', 409, 'NO_SMS');
      const m = normaliseMobile(raw);
      if (!m) throw new CallError('Enter a US or Canadian mobile number, like 416 555 0100.');
      if ((c.mobileTries = (c.mobileTries ?? 0) + 1) > 3)
        throw new CallError('That is enough numbers for this call.', 429, 'RATE_LIMIT');
      // Across all calls too (red team #5: 18 numbers an hour from one address): 20 code texts an hour
      // on this server and 3 a day to any one number.
      const t = now();
      codeTexts.splice(0, codeTexts.length, ...codeTexts.filter((x) => t - x.at < 86_400_000));
      if (
        codeTexts.filter((x) => t - x.at < 3_600_000).length >= LIMITS.codeTextsPerHour ||
        codeTexts.filter((x) => x.to === m).length >= 3
      )
        throw new CallError('Too many codes sent right now. Try again later.', 429, 'RATE_LIMIT');
      codeTexts.push({ at: t, to: m });
      const code = String(randomInt(100000, 1000000));
      c.pendingMobile = { number: m, code, tries: 0 };
      c.mobile = null;
      await sms
        .send(m, `Your code for the repair call: ${code}. If you did not ask for this, ignore it.`)
        .catch((err) => {
          throw new CallError(`Could not text that number: ${String(err.message).slice(0, 120)}`, 502, 'SMS_FAILED');
        });
      c.session.log({ kind: 'mobile', text: `Code texted to the number ending ${m.slice(-4)}.` });
      return { ok: true, sent: true, ending: m.slice(-4) };
    },

    /** The code from that text: only then is the number used for the confirmation. */
    verifyMobile(c, code) {
      const p = c.pendingMobile;
      if (!p || c.booking) throw new CallError('No code is waiting.', 409, 'NO_CODE');
      if (++p.tries > 5) {
        c.pendingMobile = null;
        throw new CallError('Too many tries. Enter the number again.', 429, 'RATE_LIMIT');
      }
      if (!safeEqual(String(code ?? '').replace(/\D/g, ''), p.code)) throw new CallError('That code does not match.');
      c.mobile = p.number;
      c.pendingMobile = null;
      c.session.log({ kind: 'mobile', text: `Caller confirmed the mobile ending ${c.mobile.slice(-4)}.` });
      return { ok: true, ending: c.mobile.slice(-4) };
    },

    /** The owner sends (or drops) Glimmer's confirmation text. Only a finished draft, only once. */
    async sendConfirmation(c, send) {
      const f = c.booking?.followUp;
      if (!f || f.status !== 'draft') throw new CallError('No confirmation is waiting.', 409, 'NO_DRAFT');
      f.status = send ? 'sent' : 'dropped';
      if (!send) {
        c.session.log({ kind: 'confirmation', sent: false });
        return { ok: true };
      }
      say(c, f.confirmation, c.status);
      // A real text from the business line when the caller gave a mobile (one per call: the draft is consumed above).
      if (c.mobile && sms) {
        f.text = { to: `…${c.mobile.slice(-4)}`, state: 'sending' };
        try {
          const { id } = await sms.send(c.mobile, f.confirmation);
          f.text.state = 'on its way';
          if (id)
            later(async () => {
              const st = await sms.status(id).catch(() => null);
              if (st) {
                f.text.state = st.state;
                f.text.reason = st.reason ?? null;
                c.session.log({ kind: 'confirmation_text', state: st.state, reason: st.reason ?? null });
              }
            }, 8000);
        } catch (err) {
          f.text.state = 'failed';
          f.text.reason = String(err.message).slice(0, 160);
        }
      }
      c.session.log({
        kind: 'confirmation',
        sent: true,
        texted: f.text?.state ?? 'no mobile given',
        reason: f.text?.reason ?? null,
      });
      return { ok: true, text: f.text ?? null };
    },

    /** The approved visit as a calendar invite, for the owner only; null until a visit is approved. */
    ics(c) {
      if (!c.booking?.approved) return null;
      const q = c.booking.quote;
      return bookingIcs({
        uid: c.id,
        slot: c.booking.slot,
        title: q ? `${q.label}` : 'Service visit',
        details: [
          c.booking.brief,
          q ? `Quoted from your price list: $${(q.priceCents / 100).toFixed(2)}` : 'Price confirmed on site',
        ]
          .filter(Boolean)
          .join('\n'),
        now: new Date(now()),
      });
    },
  };
}

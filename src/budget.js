// Spend guard for the $150 Meta Model API credit. Meta offers only an email
// alert, and billing lags about an hour, so the cap lives here: every model
// call is priced from its reported usage before the next one may start.
// At READ_ONLY_USD the public demo replays recorded runs; at HARD_STOP_USD
// nothing calls the API at all.
import fs from 'node:fs';

// List prices, dev.meta.ai/models, read 2026-10-27 (USD).
export const PRICES = {
  'muse-spark-1.3': { inPerM: 1.25, cachedInPerM: 0.15, outPerM: 4.25 },
  'muse-wonder-1.0': { inPerM: 4, cachedInPerM: 0.2, outPerM: 20 },
  'sam-3.1': { perImage: 2.5 / 1000 },
  'muse-image-1.0': { perImage: 0.01 },
  'muse-voice-transcribe-1.0': { perHour: 0.18 },
};
// The codes a spend stop throws. Only these end a tour or a call: a slow fetch has a numeric
// code too (a timeout's DOMException is 23), and that must never be read as a budget stop.
export const STOP_CODES = new Set(['RUN_CAP', 'READ_ONLY', 'HARD_STOP', 'SESSION_STOP']);
export const isStop = (err) => STOP_CODES.has(err?.code);
export const READ_ONLY_USD = 80;
export const HARD_STOP_USD = 100;
// A live call tracks frames at 1 fps (v3, red team pass 1b): $0.25 per call.
export const PER_RUN_USD = 0.25;
// A guided room tour names parts on screen every few seconds, so its call may spend more, never past this.
export const MAX_RUN_USD = 0.75;

export class BudgetExceeded extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** Cost of one call from its usage report. Unknown models are refused, never guessed as free. */
export function costOf(model, usage = {}) {
  const p = PRICES[model];
  if (!p) throw new BudgetExceeded(`No price on file for ${model}`, 'UNPRICED');
  if (p.perImage) return (usage.images ?? 1) * p.perImage;
  if (p.perHour) return ((usage.seconds ?? 0) / 3600) * p.perHour;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const input = Math.max(0, (usage.input_tokens ?? 0) - cached);
  return (input * p.inPerM + cached * p.cachedInPerM + (usage.output_tokens ?? 0) * p.outPerM) / 1e6;
}

/**
 * sessionStopUsd: a hard stop for one recording session, judging window or eval run, counted from the
 * ledger total when that session began. The start is kept in the ledger file, so a crash or a new
 * container does not hand out a fresh allowance (red team 10/31); SESSION_RESET=1 or a different
 * stop amount starts a new session. Past the stop, nothing calls the API.
 *
 * The ledger lives in memory and is written to disk in the background, one write at a time with
 * the latest totals: a synchronous file write per model call cost up to a second on a mounted
 * bucket (red team 10/31, latency). A crash loses at most the last unsaved call's cents.
 */
export function createLedger(
  file,
  {
    sessionStopUsd = Number(process.env.SPEND_STOP_USD) || null,
    reset = process.env.SESSION_RESET === '1',
    onRecord = null,
  } = {},
) {
  // A fresh container has no ledger file: SPENT_BASELINE_USD starts it at the spend already on the
  // account, so the $80 and $100 lines still mean the account total, not this container's.
  const baseline = Math.max(0, Number(process.env.SPENT_BASELINE_USD) || 0);
  let s;
  try {
    s = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    s = { spentUsd: baseline, calls: 0 };
  }
  let writing = false;
  let dirty = false;
  const flush = () => {
    if (writing) {
      dirty = true;
      return;
    }
    writing = true;
    dirty = false;
    fs.promises
      .writeFile(`${file}.tmp`, JSON.stringify(s))
      .then(() => fs.promises.rename(`${file}.tmp`, file))
      .catch((err) => console.error('ledger write failed', err?.message))
      .finally(() => {
        writing = false;
        if (dirty) flush();
      });
  };
  if (reset || !s.session || s.session.stopUsd !== sessionStopUsd) {
    s.session = { startUsd: s.spentUsd, stopUsd: sessionStopUsd, at: new Date().toISOString() };
    flush();
  }
  const load = () => s;
  const startUsd = s.session.startUsd;
  const sessionSpent = () => s.spentUsd - startUsd;
  const sessionStopped = () => sessionStopUsd != null && sessionStopUsd >= 0 && sessionSpent() >= sessionStopUsd;
  const session = () => ({
    spentUsd: Math.round(sessionSpent() * 1e4) / 1e4,
    stopUsd: sessionStopUsd,
    stopped: sessionStopped(),
  });
  return {
    state: load,
    session,
    mode() {
      const s = load().spentUsd;
      return s >= HARD_STOP_USD || sessionStopped() ? 'stopped' : s >= READ_ONLY_USD ? 'read-only' : 'live';
    },
    /** Call before every API request. `live` false = a public visitor, who is cut off earlier. */
    assertCanSpend({ live = true, runSpentUsd = 0, runCapUsd = PER_RUN_USD } = {}) {
      if (sessionStopped())
        throw new BudgetExceeded(
          'This session reached its spending stop; no more model calls until a restart.',
          'SESSION_STOP',
        );
      const m = this.mode();
      if (m === 'stopped') throw new BudgetExceeded('Credit budget reached; no more model calls.', 'HARD_STOP');
      if (!live && m === 'read-only')
        throw new BudgetExceeded('Demo is in replay mode to protect the credit.', 'READ_ONLY');
      if (runSpentUsd >= Math.min(MAX_RUN_USD, runCapUsd))
        throw new BudgetExceeded('This run reached its spending limit.', 'RUN_CAP');
    },
    record(model, usage) {
      const usd = costOf(model, usage);
      s.spentUsd = Math.round((s.spentUsd + usd) * 1e6) / 1e6;
      s.calls += 1;
      flush();
      try {
        onRecord?.(session());
      } catch {
        /* an alert never fails a model call */
      }
      return usd;
    },
    /** Waits for the background write (tests, shutdown). */
    async saved() {
      while (writing) await new Promise((r) => setTimeout(r, 5));
    },
  };
}

// Meta Llama Prompt Guard 2 (86M): a small classifier that scores the caller's words for prompt injection and
// jailbreaks before the agent sees them. It runs beside the server (modal/guard_server.py, localhost only).
//
// It is one layer, not the control: prices still come only from the verifier, bookings only from the owner's
// tap, hazards from code. So when the guard is down the call carries on (fail open) and the log says so.
export const GUARD_THRESHOLD = 0.5; // the model card's default cut-off for "malicious"
export const GUARD_TIMEOUT_MS = 1500;
export const GUARD_LINE = 'I can only help with the problem in front of the camera. What are you seeing?';

/** url: the sidecar's base URL, or empty to turn the guard off (local dev without the model). */
export function createPromptGuard({ url = process.env.PROMPT_GUARD_URL, fetchImpl = fetch } = {}) {
  if (!url) return null;
  return {
    /** -> { blocked, score } on an answer, or null when the guard could not answer in time. */
    async check(text) {
      try {
        const r = await fetchImpl(`${url}/check`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: String(text).slice(0, 2000) }),
          signal: AbortSignal.timeout(GUARD_TIMEOUT_MS),
        });
        if (!r.ok) return null;
        const { score } = await r.json();
        if (typeof score !== 'number' || !Number.isFinite(score)) return null;
        return { blocked: score >= GUARD_THRESHOLD, score };
      } catch {
        return null;
      }
    },
  };
}

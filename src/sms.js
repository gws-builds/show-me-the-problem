// The confirmation as a real text message (founder 11/01): sent from the business's own line on its
// Telnyx account, only after the owner taps Send, one text per call. The caller types their own
// mobile on the call page; code checks it is a North American number before anything is sent.
// US carriers block texts from a number not registered for business texting (10DLC); Telnyx then
// reports error 40010 and the owner page says so instead of claiming it was delivered.

export const E164_NANP = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
// NANP area codes that are not the US or Canada (Caribbean, Bermuda: international SMS rates),
// plus premium and toll-free codes that cannot take a text (red team #4).
const NOT_US_CA = new Set(
  '242 246 264 268 284 345 441 473 649 658 664 721 758 767 784 809 829 849 868 869 876 900 976 800 833 844 855 866 877 888'.split(
    ' ',
  ),
);

/** "+1 (416) 555-0100", "416-555-0100" → "+14165550100", or null. */
export function normaliseMobile(raw) {
  const d = String(raw ?? '').replace(/[^\d+]/g, '');
  const n = d.startsWith('+') ? d : d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith('1') ? `+${d}` : d;
  return E164_NANP.test(n) && !NOT_US_CA.has(n.slice(2, 5)) ? n : null;
}

export function createSms({
  apiKey = process.env.TELNYX_API_KEY,
  from = process.env.SMS_FROM,
  fetchImpl = fetch,
} = {}) {
  if (!apiKey || !E164_NANP.test(String(from ?? ''))) return null;
  return {
    from,
    async send(to, text) {
      const r = await fetchImpl('https://api.telnyx.com/v2/messages', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, text: String(text).slice(0, 320) }),
        signal: AbortSignal.timeout(10000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const e = j?.errors?.[0];
        const code = String(e?.code ?? '');
        throw new Error(
          code === '40010' || code === '40011'
            ? 'not delivered: this line is not registered for US business texting yet (10DLC)'
            : `not sent: ${e?.detail ?? e?.title ?? `HTTP ${r.status}`}`,
        );
      }
      return { id: j?.data?.id ?? null };
    },
    /** Where the text is now: delivered, failed (with the reason) or still on its way. */
    async status(id) {
      const r = await fetchImpl(`https://api.telnyx.com/v2/messages/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      const d = (await r.json().catch(() => ({})))?.data ?? {};
      const raw = String(d.to?.[0]?.status ?? '').toLowerCase();
      const code = String(d.errors?.[0]?.code ?? '');
      if (raw === 'delivered') return { state: 'delivered' };
      if (/failed|undeliverable|expired/.test(raw))
        return {
          state: 'failed',
          reason:
            code === '40010' || code === '40011'
              ? 'this line is not registered for US business texting yet (10DLC)'
              : (d.errors?.[0]?.title ?? raw),
        };
      return { state: 'on its way' };
    },
  };
}

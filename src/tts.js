// Natural voice out (pre-existing Unmanually voice stack, not a Meta model: Meta's
// catalogue has no text-to-speech as of Oct 30, 2026). Deepgram Aura-2 turns the
// agent's line into speech; the browser voice stays as the fallback.
// Caps: 600 characters a line, 10,000 a call (a guided tour says a lot), 120,000 a server run (about $3.60).
export const TTS_LIMITS = { line: 600, perCall: 10000, perRun: 120000 };

// A Spanish call uses a Spanish Aura-2 voice (TTS_VOICE_ES to change it); not verified live on Oct 30.
export function createTts({
  apiKey = process.env.DEEPGRAM_API_KEY,
  voice = process.env.TTS_VOICE || 'aura-2-thalia-en',
  voiceEs = process.env.TTS_VOICE_ES || 'aura-2-celeste-es',
  fetchImpl = fetch,
} = {}) {
  // A repeated line is served from memory and not charged again (red team 10/31: replaying one line burned the cap).
  let runChars = 0;
  const perCall = new Map();
  const cache = new Map();
  const pending = new Map();
  return {
    on: Boolean(apiKey),
    async speak(callId, text, lang = 'en') {
      if (!apiKey) return null;
      const t = String(text).slice(0, TTS_LIMITS.line);
      const used = perCall.get(callId) ?? 0;
      // Shared across calls: a greeting or filler is made once per server run (red team #4: cost and first-line delay).
      const key = `${lang}|${t}`;
      if (cache.has(key)) return cache.get(key);
      if (pending.has(key)) return pending.get(key);
      if (used + t.length > TTS_LIMITS.perCall || runChars + t.length > TTS_LIMITS.perRun) return null;
      perCall.set(callId, used + t.length);
      runChars += t.length;
      // Made once even when the server's head start and the phone's request overlap (latency, 11/01).
      const job = make(key, t, lang).finally(() => pending.delete(key));
      pending.set(key, job);
      return job;
    },
    used: () => runChars,
    /** Drops a finished call's character count, so a long-running server does not keep one per call. */
    forget(callId) {
      perCall.delete(callId);
    },
  };
  async function make(key, t, lang) {
    const r = await fetchImpl(
      `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(lang === 'es' ? voiceEs : voice)}&encoding=mp3`,
      {
        method: 'POST',
        headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: t }),
        // A slow voice never holds up the call: after 8 s the browser voice says it instead.
        signal: AbortSignal.timeout(8000),
      },
    ).catch(() => null);
    if (!r?.ok) return null;
    const audio = Buffer.from(await r.arrayBuffer());
    cache.set(key, audio);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return audio;
  }
}

// Whole sentences, so the first one can be voiced and played while the rest are still being made
// (founder 11/01: stream the first sentence, but never cut one in the middle). A short line, or one
// with no clear sentence end, stays whole. Abbreviations and decimals never end a sentence; very short
// sentences ride with the next one so the voice keeps its rhythm; at most 4 parts.
const ABBREV = /\b(?:mr|mrs|ms|dr|st|vs|approx|no|e\.g|i\.e|etc|sr|jr|ft|in|lb|oz|min|max)\.$/i;
export function sentences(text, { minChars = 25, maxParts = 4 } = {}) {
  const t = String(text ?? '').trim();
  if (t.length < 80) return [t].filter(Boolean);
  const raw = [];
  let start = 0;
  const re = /[.!?](?=["')\]]?\s+["'(]?[A-Z0-9¿¡ÁÉÍÓÚÑ])/g;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const piece = t.slice(start, m.index + 1);
    if (ABBREV.test(piece)) continue;
    raw.push(piece.trim());
    start = m.index + 1;
  }
  raw.push(t.slice(start).trim());
  const parts = [];
  for (const p of raw.filter(Boolean)) {
    if (parts.length && parts[parts.length - 1].length < minChars) parts[parts.length - 1] += ` ${p}`;
    else parts.push(p);
  }
  if (parts.length > 1 && parts[parts.length - 1].length < minChars) parts[parts.length - 2] += ` ${parts.pop()}`;
  while (parts.length > maxParts) parts[maxParts - 1] += ` ${parts.splice(maxParts).join(' ')}`;
  return parts;
}

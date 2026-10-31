// Natural voice out (pre-existing Unmanually voice stack, not a Meta model: Meta's
// catalogue has no text-to-speech as of Oct 30, 2026). Deepgram Aura-2 turns the
// agent's line into speech; the browser voice stays as the fallback.
// Caps: 600 characters a line, 6,000 a call, 120,000 a server run (about $3.60).
export const TTS_LIMITS = { line: 600, perCall: 6000, perRun: 120000 };

// A Spanish call uses a Spanish Aura-2 voice (TTS_VOICE_ES to change it); not verified live on Oct 30.
export function createTts({ apiKey = process.env.DEEPGRAM_API_KEY, voice = process.env.TTS_VOICE || 'aura-2-thalia-en', voiceEs = process.env.TTS_VOICE_ES || 'aura-2-celeste-es', fetchImpl = fetch } = {}) {
  // A repeated line is served from memory and not charged again (red team 10/31: replaying one line burned the cap).
  let runChars = 0; const perCall = new Map(); const cache = new Map();
  return {
    on: Boolean(apiKey),
    async speak(callId, text, lang = 'en') {
      if (!apiKey) return null;
      const t = String(text).slice(0, TTS_LIMITS.line); const used = perCall.get(callId) ?? 0;
      const key = `${callId}|${lang}|${t}`;
      if (cache.has(key)) return cache.get(key);
      if (used + t.length > TTS_LIMITS.perCall || runChars + t.length > TTS_LIMITS.perRun) return null;
      perCall.set(callId, used + t.length); runChars += t.length;
      const r = await fetchImpl(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(lang === 'es' ? voiceEs : voice)}&encoding=mp3`, {
        method: 'POST', headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t }),
        // A slow voice never holds up the call: after 8 s the browser voice says it instead.
        signal: AbortSignal.timeout(8000),
      }).catch(() => null);
      if (!r?.ok) return null;
      const audio = Buffer.from(await r.arrayBuffer());
      cache.set(key, audio); if (cache.size > 200) cache.delete(cache.keys().next().value);
      return audio;
    },
    used: () => runChars,
  };
}

// Natural voice out (pre-existing Unmanually voice stack, not a Meta model: Meta's
// catalogue has no text-to-speech as of Oct 30, 2026). Deepgram Aura-2 turns the
// agent's line into speech; the browser voice stays as the fallback.
// Caps: 600 characters a line, 6,000 a call, 120,000 a server run (about $3.60).
export const TTS_LIMITS = { line: 600, perCall: 6000, perRun: 120000 };

export function createTts({ apiKey = process.env.DEEPGRAM_API_KEY, voice = process.env.TTS_VOICE || 'aura-2-thalia-en', fetchImpl = fetch } = {}) {
  let runChars = 0; const perCall = new Map();
  return {
    on: Boolean(apiKey),
    async speak(callId, text) {
      if (!apiKey) return null;
      const t = String(text).slice(0, TTS_LIMITS.line); const used = perCall.get(callId) ?? 0;
      if (used + t.length > TTS_LIMITS.perCall || runChars + t.length > TTS_LIMITS.perRun) return null;
      perCall.set(callId, used + t.length); runChars += t.length;
      const r = await fetchImpl(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(voice)}&encoding=mp3`, {
        method: 'POST', headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t }),
      });
      if (!r.ok) return null;
      return Buffer.from(await r.arrayBuffer());
    },
    used: () => runChars,
  };
}

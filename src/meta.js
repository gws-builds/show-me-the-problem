// Meta Model API client (OpenAI-compatible Responses API at api.meta.ai/v1).
// Every call goes through the budget ledger: it is refused before it starts
// when the credit or the per-call cap is reached, and priced from its reported
// usage after it returns. The key is read from the environment, never logged.

export const BASE = process.env.META_API_BASE || 'https://api.meta.ai/v1';
export const MODELS = { agent: 'muse-spark-1.3', sam: 'sam-3.1', image: 'muse-image-1.0', transcribe: 'muse-voice-transcribe-1.0' };

// SAM 3.1 answers in text, one token per box: 1<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|>
// With include_confidence the token also carries ;c=0.87 (per frame, 0..1).
const BOX = /(\d+)<\|box;x1=(\d+(?:\.\d+)?);y1=(\d+(?:\.\d+)?);x2=(\d+(?:\.\d+)?);y2=(\d+(?:\.\d+)?);w=(\d+);h=(\d+)(?:;c=([\d.]+))?\|>/g;

export function parseBoxes(text) {
  return [...String(text ?? '').matchAll(BOX)].map((m) => {
    const [ordinal, x1, y1, x2, y2, width, height] = m.slice(1, 8).map(Number);
    return { ordinal, x1, y1, x2, y2, width, height, score: m[8] === undefined ? null : Number(m[8]) };
  });
}

/** Seconds of audio in a PCM WAV, read from its fmt and data chunks; what transcription is billed on. */
export function wavSeconds(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let byteRate = 0; let dataBytes = null;
  for (let off = 12; off + 8 <= buf.length;) {
    const id = buf.toString('ascii', off, off + 4); const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 20 <= buf.length) { if (buf.readUInt16LE(off + 8) !== 1) return null; byteRate = buf.readUInt32LE(off + 16); }
    if (id === 'data') { dataBytes = Math.min(size, buf.length - off - 8); break; }
    off += 8 + size + (size % 2);
  }
  return byteRate && dataBytes != null ? dataBytes / byteRate : null;
}

export function outputText(body) {
  if (typeof body?.output_text === 'string') return body.output_text;
  return (body?.output ?? []).flatMap((o) => o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
}

export function createClient({ ledger, fetchImpl = fetch, apiKey = process.env.META_API_KEY, live = true } = {}) {
  let runSpentUsd = 0;
  const post = async (path, model, body, usageOf, { raw = null, accept = 'application/json' } = {}) => {
    ledger.assertCanSpend({ live, runSpentUsd });
    if (!apiKey) throw new Error('META_API_KEY is not set');
    const res = await fetchImpl(`${BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: accept, ...(raw ? {} : { 'Content-Type': 'application/json' }) },
      body: raw ?? JSON.stringify({ model, ...body }),
      signal: AbortSignal.timeout(30000),
    });
    const data = accept === 'text/plain' ? await res.text().catch(() => '') : await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Meta API ${res.status}: ${data?.error?.message ?? 'request failed'}`);
    runSpentUsd += ledger.record(model, usageOf(data));
    return data;
  };
  return {
    spent: () => runSpentUsd,
    /** One agent turn: the model picks one tool. */
    respond: ({ instructions, input, tools }) => post('/responses', MODELS.agent, { instructions, input, tools, parallel_tool_calls: false, store: false }, (d) => d.usage ?? {}),
    /** SAM 3.1 on one frame: boxes for the text prompt ("water heater", "pressure relief valve"). */
    segment: async (imageDataUrl, prompt) => {
      const d = await post('/responses', MODELS.sam, { input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: imageDataUrl }] }], metadata: { include_confidence: 'true' } }, () => ({ images: 1 }));
      return parseBoxes(outputText(d));
    },
    /** Muse Voice Transcribe on one push-to-talk WAV clip. Returns the caller's words. */
    transcribe: async (wav) => {
      const seconds = wavSeconds(wav);
      if (seconds == null) throw new Error('audio must be a 16-bit PCM WAV');
      const form = new FormData();
      form.append('request', new Blob([JSON.stringify({ model: MODELS.transcribe, audioEncoding: 'WAV', mode: 'PUSH_TO_TALK' })], { type: 'application/json' }));
      form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'clip.wav');
      const text = await post('/asr/transcribe', MODELS.transcribe, null, () => ({ seconds }), { raw: form, accept: 'text/plain' });
      return String(text).split('\n').map((l) => l.replace(/^(unknown|[A-Z]):/, '').trim()).filter(Boolean).join(' ');
    },
    /** Muse Image edit: the annotated still that goes on the booked visit. Returns a data URL or null. */
    annotate: async (imageDataUrl, instruction) => {
      const d = await post('/images/edits', MODELS.image, { prompt: instruction, images: [{ image_url: imageDataUrl }], n: 1 }, () => ({ images: 1 }));
      const img = d?.data?.[0];
      if (img?.b64_json) return `data:image/png;base64,${img.b64_json}`;
      return img?.url ?? null;
    },
  };
}

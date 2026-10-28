// Meta Model API client (OpenAI-compatible Responses API at api.meta.ai/v1).
// Every call goes through the budget ledger: it is refused before it starts
// when the credit or the per-call cap is reached, and priced from its reported
// usage after it returns. The key is read from the environment, never logged.

export const BASE = process.env.META_API_BASE || 'https://api.meta.ai/v1';
export const MODELS = { agent: 'muse-spark-1.3', sam: 'sam-3.1', image: 'muse-image-1.0', transcribe: 'muse-voice-transcribe-1.0' };

// SAM 3.1 answers in text, one token per box: 1<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|>
const BOX = /(\d+)<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=(\d+);h=(\d+)\|>/g;

export function parseBoxes(text) {
  return [...String(text ?? '').matchAll(BOX)].map((m) => {
    const [ordinal, x1, y1, x2, y2, width, height] = m.slice(1).map(Number);
    return { ordinal, x1, y1, x2, y2, width, height };
  });
}

export function outputText(body) {
  if (typeof body?.output_text === 'string') return body.output_text;
  return (body?.output ?? []).flatMap((o) => o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
}

export function createClient({ ledger, fetchImpl = fetch, apiKey = process.env.META_API_KEY, live = true } = {}) {
  let runSpentUsd = 0;
  const post = async (path, model, body, usageOf) => {
    ledger.assertCanSpend({ live, runSpentUsd });
    if (!apiKey) throw new Error('META_API_KEY is not set');
    const res = await fetchImpl(`${BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, ...body }),
    });
    const data = await res.json().catch(() => ({}));
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
      const d = await post('/responses', MODELS.sam, { input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: imageDataUrl }] }] }, () => ({ images: 1 }));
      return parseBoxes(outputText(d));
    },
    /** Muse Image: the annotated still that goes on the Jobber visit. */
    annotate: async (imageDataUrl, instruction) => {
      const d = await post('/responses', MODELS.image, { input: [{ role: 'user', content: [{ type: 'input_text', text: instruction }, { type: 'input_image', image_url: imageDataUrl }] }] }, () => ({ images: 1 }));
      return d;
    },
  };
}

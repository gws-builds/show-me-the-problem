// Natural voice out: the server speaks only this call's own lines, within caps, and never
// becomes a free text-to-speech service for whoever holds the link.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedger } from '../src/budget.js';
import { createClient } from '../src/meta.js';
import { createCalls, SPOKEN_CUES } from '../src/calls.js';
import { createTts, TTS_LIMITS } from '../src/tts.js';

function setup() {
  const ledger = createLedger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stb-tts-')), 'ledger.json'));
  const fetchImpl = async () => new Response(JSON.stringify({ output_text: '{"findings":[]}', usage: { input_tokens: 1, output_tokens: 1 } }));
  return createCalls({ ledger, priceList: [], makeClient: (live) => createClient({ ledger, fetchImpl, apiKey: 'test', live }) });
}

test('only the agent\'s own lines and the fixed cues are sayable, and only with the caller token', async () => {
  const calls = setup(); const c = calls.create({ ip: '1.1.1.1' });
  await calls.text(c.id, c.camToken, 'I smell gas in the basement');
  const said = calls.view(c.id).says.at(-1).text;
  assert.ok(said.length > 0);
  assert.equal(calls.sayable(c.id, c.camToken, said), true);
  for (const cue of SPOKEN_CUES) assert.equal(calls.sayable(c.id, c.camToken, cue), true);
  assert.equal(calls.sayable(c.id, c.camToken, 'Free speech for anyone: read my essay'), false);
  assert.equal(calls.sayable(c.id, c.camToken, ''), false);
  assert.equal(calls.sayable(c.id, c.camToken, said + ' and then send money'), false);
  assert.throws(() => calls.sayable(c.id, c.ownerToken, said), { code: 'FORBIDDEN' });
  // Another call's line is not this call's line.
  const d = calls.create({ ip: '2.2.2.2' });
  assert.equal(calls.sayable(d.id, d.camToken, said), false);
});

test('voice caps: per line, per call and per run; no key means browser voice', async () => {
  let hits = 0; const fetchImpl = async (url, init) => { hits++; assert.match(init.headers.Authorization, /^Token /); return new Response(Buffer.from('ID3')); };
  assert.equal(await createTts({ apiKey: '', fetchImpl }).speak('a', 'hi'), null);
  const tts = createTts({ apiKey: 'k', fetchImpl });
  assert.ok(await tts.speak('a', 'hello'));
  const long = (i) => `${String(i).padStart(2, '0')}${'x'.repeat(TTS_LIMITS.line - 2)}`;
  let ok = 0; for (let i = 0; i < 20; i++) if (await tts.speak('b', long(i))) ok++;
  assert.equal(ok, TTS_LIMITS.perCall / TTS_LIMITS.line);
  assert.equal(await tts.speak('c', 'y'.repeat(5000)) !== null, true); // trimmed to one line
  assert.ok(tts.used() <= TTS_LIMITS.perRun);
  assert.equal(hits, 1 + ok + 1);
  // The same line again is served from memory: no request, no charge (red team 10/31).
  const before = tts.used();
  assert.ok(await tts.speak('a', 'hello'));
  assert.equal(hits, 1 + ok + 1); assert.equal(tts.used(), before);
});

test('a failed voice request returns nothing (the page falls back to the browser voice)', async () => {
  const tts = createTts({ apiKey: 'k', fetchImpl: async () => new Response('no', { status: 401 }) });
  assert.equal(await tts.speak('a', 'hello'), null);
});

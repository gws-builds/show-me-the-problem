// Red team #4 (2026-11-01): attacks on the listen / SMS / push-voice changes of f1a80ac.
// Every test here FAILS on f1a80ac and documents one real bug; product code is not changed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedger } from '../src/budget.js';
import { createClient } from '../src/meta.js';
import { createCalls, LIMITS } from '../src/calls.js';
import { normaliseMobile } from '../src/sms.js';
import { analyseSound } from '../src/sound.js';
import { createTts } from '../src/tts.js';

const PRICES = [{ id: 'wh-tpr', jobType: 'water heater', label: 'Relief valve replacement', priceCents: 24900 }];
const JPEG = 'data:image/jpeg;base64,' + 'A'.repeat(400);
const BOOKING = [
  ['find_part', { part: 'water heater' }],
  [
    'propose_quote',
    { equipment: 'water heater', issue: 'valve drips', price_list_id: 'wh-tpr', box_ordinal: 1, notes: '' },
  ],
  ['check_calendar', { job_type: 'water heater' }],
  ['request_booking', { slot_id: 's1', brief: 'valve drips' }],
];

function setup({ agent = [], glimmer = null, sms = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stb-rt4-'));
  const ledger = createLedger(path.join(dir, 'ledger.json'));
  const counts = { spark: 0 };
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/asr/transcribe')) return new Response('hello');
    if (url.endsWith('/images/edits')) return new Response(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgo=' }] }));
    const body = JSON.parse(init.body);
    if (body.model !== 'sam-3.1' && !body.tools)
      return new Response(
        JSON.stringify({ output_text: '{"findings":[]}', usage: { input_tokens: 500, output_tokens: 20 } }),
      );
    if (body.model === 'sam-3.1')
      return new Response(
        JSON.stringify({ output_text: '<0f>1<|box;x1=170;y1=100;x2=470;y2=540;w=640;h=640;c=0.9|>' }),
      );
    counts.spark++;
    const next = agent.shift();
    const output = next
      ? [{ type: 'function_call', call_id: `c${counts.spark}`, name: next[0], arguments: JSON.stringify(next[1]) }]
      : [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }];
    return new Response(JSON.stringify({ output, usage: { input_tokens: 1000, output_tokens: 40 } }));
  };
  let t = 1_000_000;
  const calls = createCalls({
    ledger,
    priceList: PRICES,
    now: () => (t += 2000),
    glimmer,
    sms,
    later: (fn) => fn(),
    makeClient: (live) => createClient({ ledger, fetchImpl, apiKey: 'test', live }),
  });
  return { calls, counts };
}

function wav(seconds, fn, { rate = 16000, byteRate = rate * 2 } = {}) {
  const n = Math.round(rate * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(byteRate, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(n * 2, 40);
  let seed = 5;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(fn(rnd)), 44 + i * 2);
  return b;
}
const HISS = wav(8, (rnd) => rnd() * 3000);

const fakeSms = (sent) => ({
  send: async (to, text) => {
    sent.push({ to, text });
    return { id: 'm1' };
  },
  status: async () => ({ state: 'delivered' }),
});
const fakeGlimmer = {
  draft: async () => ({ parts: [], confirmation: 'Hi! The technician will look at the dripping relief valve.' }),
};

async function bookedCall(sent) {
  const { calls } = setup({ glimmer: fakeGlimmer, sms: fakeSms(sent), agent: [...BOOKING] });
  const c = calls.create({ ip: '9.9.9.1' });
  await calls.frame(c.id, c.camToken, JPEG);
  await calls.text(c.id, c.camToken, 'my water heater valve drips');
  await calls.text(c.id, c.camToken, 'yes book it');
  return { calls, c };
}

test('RT4-1 (high): the business line texts a number the caller never proved they own', async () => {
  // POST /api/calls hands the stranger both tokens (server.mjs:162, calls.js:343), so the same stranger can
  // type a victim's number, self-approve and press Send: a real text from the business line to anyone.
  const sent = [];
  const { calls, c } = await bookedCall(sent);
  await calls.setMobile(c.id, c.camToken, '(416) 555-0199'); // not the caller's phone: only a bare code goes to it
  assert.equal(sent.length, 1);
  assert.match(
    sent[0].text,
    /^Your code for the repair call: \d{6}\. If you did not ask for this, ignore it\.$/,
    'the code text carries nothing an attacker chose',
  );
  await calls.decide(c.id, c.ownerToken, true);
  await new Promise((r) => setImmediate(r));
  await calls.sendConfirmation(c.id, c.ownerToken, true);
  assert.equal(sent.length, 1, 'an unverified number must not get the confirmation');
  await assert.rejects(calls.setMobile(c.id, c.camToken, '(416) 555-0198'), { code: 'LOCKED' });
});

test('RT4-2 (medium): the caller can swap the mobile after the owner saw it, before Send', async () => {
  const sent = [];
  const { calls, c } = await bookedCall(sent);
  await calls.setMobile(c.id, c.camToken, '416 555 0100');
  calls.verifyMobile(c.id, c.camToken, sent.pop().text.match(/\d{6}/)[0]);
  await calls.decide(c.id, c.ownerToken, true);
  await new Promise((r) => setImmediate(r));
  const shown = calls.view(c.id).mobile; // what the owner page shows next to Send
  await calls.setMobile(c.id, c.camToken, '647 555 0123').catch(() => {
    /* refusing the swap is a fix */
  });
  await calls.sendConfirmation(c.id, c.ownerToken, true);
  assert.ok(
    sent.every((s) => `…${s.to.slice(-4)}` === shown),
    `owner saw ${shown}, text went to …${sent[0]?.to.slice(-4)}`,
  );
});

test('RT4-3 (medium): "US or Canadian" accepts Caribbean and premium NANP numbers (international SMS rates)', () => {
  for (const n of ['+1 876 555 0100', '+1 809 555 0100', '+1 900 555 0100', '+1 441 555 0100'])
    assert.equal(normaliseMobile(n), null, n);
});

test('RT4-4 (medium): Listen on an escalated call still runs paid Spark turns (autoTurn skips the turn() gates)', async () => {
  const { calls, counts } = setup();
  const c = calls.create({ ip: '9.9.9.4' });
  await calls.text(c.id, c.camToken, 'I smell gas near the water heater');
  assert.equal(calls.view(c.id).status, 'escalated');
  const before = counts.spark;
  await calls.listen(c.id, c.camToken, HISS).catch(() => null);
  assert.equal(counts.spark, before, 'no model spend after a hazard escalation');
  assert.equal(calls.view(c.id).status, 'escalated');
});

test('RT4-5 (low): Listen refused as BUSY still files the evidence and burns one of the 4 listens', async () => {
  const { calls } = setup();
  const c = calls.create({ ip: '9.9.9.5' });
  const turn = calls.text(c.id, c.camToken, 'my toilet keeps running');
  const r = await calls.listen(c.id, c.camToken, HISS).then(
    () => 'ok',
    (e) => e.code,
  );
  await turn;
  if (r === 'BUSY')
    assert.equal(
      calls.view(c.id).evidence.filter((e) => e.kind === 'sound').length,
      0,
      'evidence filed that the agent never heard',
    );
  else assert.ok(true);
});

test('RT4-6 (low): a forged byteRate makes the cited clip length false ("measured in code from 256000 s")', () => {
  const forged = wav(8, (rnd) => rnd() * 3000, { byteRate: 1 });
  let r;
  try {
    r = analyseSound(forged);
  } catch {
    return;
  } // refusing it is a fix
  assert.ok(r.seconds <= LIMITS.wavBytes / 32000 + 1, `claimed ${r.seconds} s`);
});

test('RT4-7 (low): a 44.1 kHz clip is measured as if it were 16 kHz (thresholds and pitch band are wrong)', () => {
  assert.throws(() => analyseSound(wav(8, (rnd) => rnd() * 3000, { rate: 44100 })));
});

test('RT4-8 (low): setMobile has no rate limit; every call appends an event the console re-downloads', async () => {
  const { calls } = setup({ sms: fakeSms([]) });
  const c = calls.create({ ip: '9.9.9.8' });
  const before = calls.view(c.id).events.length;
  for (let i = 0; i < 500; i++) await calls.setMobile(c.id, c.camToken, '416 555 0100').catch(() => null);
  assert.ok(calls.view(c.id).events.length - before <= 10, `${calls.view(c.id).events.length - before} events`);
});

test('RT4-9 (low, cost+latency): the same fixed line (greeting, fillers) is synthesised and billed once per call', async () => {
  let hits = 0;
  const tts = createTts({
    apiKey: 'k',
    fetchImpl: async () => {
      hits++;
      return new Response(new Uint8Array([1, 2, 3]));
    },
  });
  const hello = 'Hi, this is the office. Point your camera at the problem and tell me what is going on.';
  await tts.speak('a'.repeat(32), hello);
  await tts.speak('b'.repeat(32), hello);
  assert.equal(hits, 1);
});

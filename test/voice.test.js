// Realtime voice: WebSocket framing, the upstream protocol, echo filtering, barge-in
// signals, metering and latency. A fake upstream stands in for Meta's service.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptKey, encodeFrame, parseFrames, encodeClientFrame, parseServerFrames } from '../src/ws.js';
import { createVoiceSession, isEcho, handshake, BYTES_PER_SECOND } from '../src/voice.js';
import { createLedger } from '../src/budget.js';
import { createClient } from '../src/meta.js';
import { createCalls } from '../src/calls.js';

test('WebSocket accept key matches RFC 6455', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

const masked = (opcode, payload) => {
  const p = Buffer.from(payload); const mask = Buffer.from([1, 2, 3, 4]);
  const head = p.length < 126 ? Buffer.from([0x80 | opcode, 0x80 | p.length]) : Buffer.from([0x80 | opcode, 0x80 | 126, p.length >> 8, p.length & 255]);
  return Buffer.concat([head, mask, Buffer.from(p.map((b, i) => b ^ mask[i & 3]))]);
};

test('parses masked client frames, keeps partial bytes, refuses unmasked or huge frames', () => {
  const two = Buffer.concat([masked(1, '{"token":"x"}'), masked(2, Buffer.alloc(300, 7))]);
  const { frames, rest } = parseFrames(Buffer.concat([two, two.subarray(0, 5)]));
  assert.equal(frames.length, 2); assert.equal(frames[0].data.toString(), '{"token":"x"}'); assert.equal(frames[1].data.length, 300); assert.equal(rest.length, 5);
  assert.throws(() => parseFrames(Buffer.from([0x81, 0x03, 0x61, 0x62, 0x63])), /masked/);
  const huge = Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0, 0x10, 0, 0, 1, 2, 3, 4]);
  assert.throws(() => parseFrames(huge), /too large/);
  assert.equal(encodeFrame('hi')[1], 2);
});

test('echo: the agent\'s own line heard back is dropped; the caller\'s words are not', () => {
  const agent = ['Is the drip coming from under the spout or from the handle?'];
  assert.equal(isEcho('is the drip coming from under the spout', agent), true);
  assert.equal(isEcho('from under the handle I think it is the base', agent), false);
  assert.equal(isEcho('huele a gas en la cocina', agent), false);
});

test('handshake asks for 16 kHz endpointing with English and Spanish', () => {
  const h = handshake('KEY');
  assert.equal(h.mode, 'ENDPOINTING'); assert.equal(h.audioEncoding, 'PCM_16KHZ'); assert.deepEqual(h.languageBias, ['English', 'Spanish']);
});

function fakeUpstream() {
  const sent = [];
  const up = { readyState: 1, sent, send: (d) => sent.push(d), close: () => { up.readyState = 3; } };
  up.emit = (obj) => up.onmessage({ data: JSON.stringify(obj) });
  return up;
}

// Hazard scans (Spark vision without tools) see nothing unless a test says otherwise.
let HAZARD_SCAN = () => '{"findings":[]}';
const setHazardScan = (fn) => { HAZARD_SCAN = fn; };

function setup(agent = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stb-v-'));
  const ledger = createLedger(path.join(dir, 'l.json'));
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.model !== 'sam-3.1' && !body.tools) return new Response(JSON.stringify({ output_text: HAZARD_SCAN(body), usage: { input_tokens: 500, output_tokens: 20 } }));
    if (body.model === 'sam-3.1') return new Response(JSON.stringify({ output_text: '<0f>0<|box;x1=170;y1=100;x2=470;y2=540;w=640;h=640;c=0.9|>' }));
    const next = agent.shift();
    const output = next ? [{ type: 'function_call', call_id: 'c', name: next[0], arguments: JSON.stringify(next[1]) }] : [];
    return new Response(JSON.stringify({ output, usage: { input_tokens: 100, output_tokens: 10 } }));
  };
  const calls = createCalls({ ledger, priceList: [], makeClient: (live) => createClient({ ledger, fetchImpl, apiKey: 'test', live }) });
  const c = calls.create({ ip: 'v' });
  const up = fakeUpstream(); const toClient = [];
  const s = createVoiceSession({ calls, callId: c.id, client: calls.clientOf(c.id), apiKey: 'SECRET', openUpstream: () => up, toClient: (o) => toClient.push(o) });
  up.onopen();
  return { calls, c, up, toClient, s, ledger };
}

test('the key goes only upstream; audio is held until the service is ready, then relayed', () => {
  const { up, toClient, s } = setup();
  s.audio(Buffer.alloc(2560));
  assert.equal(up.sent.length, 1); // only the handshake so far
  assert.match(up.sent[0], /Bearer SECRET/);
  up.emit({ sessionId: 'abc' });
  assert.equal(up.sent.length, 2); assert.ok(Buffer.isBuffer(up.sent[1]));
  assert.ok(!JSON.stringify(toClient).includes('SECRET'));
  assert.ok(toClient.some((m) => m.type === 'ready'));
});

test('speech start tells the browser to stop talking; a completed turn runs the agent and records latency', async () => {
  const { up, toClient, calls, c } = setup([['ask_caller', { question: 'Single handle or two handles?' }]]);
  up.emit({ sessionId: 'abc' });
  up.emit({ type: 'speechStart', turnId: 1 });
  assert.equal(toClient.at(-1).type, 'speechStart');
  up.emit({ type: 'transcript', transcript: 'my faucet drips', final: false });
  assert.equal(toClient.at(-1).type, 'partial');
  up.emit({ type: 'speechEnd', turnId: 1 });
  await up.onmessage({ data: JSON.stringify({ type: 'speechComplete', turnId: 1, transcript: 'My kitchen faucet drips from underneath.' }) });
  const v = calls.view(c.id);
  assert.match(v.says.at(-1).text, /handle/);
  assert.equal(v.latency.n, 1);
  assert.ok(toClient.some((m) => m.type === 'thinking'));
});

test('a Spanish gas report over voice escalates in code', async () => {
  const { up, calls, c } = setup();
  up.emit({ sessionId: 'abc' });
  await up.onmessage({ data: JSON.stringify({ type: 'speechComplete', turnId: 1, transcript: 'Huele a gas en la cocina' }) });
  assert.equal(calls.view(c.id).status, 'escalated');
});

test('the agent\'s own voice coming back is dropped before it becomes a turn', async () => {
  const { up, toClient, calls, c } = setup();
  up.emit({ sessionId: 'abc' });
  const greeting = calls.view(c.id).says[0].text;
  await up.onmessage({ data: JSON.stringify({ type: 'speechComplete', turnId: 1, transcript: greeting }) });
  assert.equal(toClient.at(-1).type, 'ignored');
  assert.equal(calls.view(c.id).turns, 0);
});

test('streamed audio is priced into the ledger', () => {
  const { up, s, ledger } = setup();
  up.emit({ sessionId: 'abc' });
  const before = ledger.state().spentUsd;
  for (let i = 0; i < 11; i++) s.audio(Buffer.alloc(BYTES_PER_SECOND));
  s.end();
  assert.ok(ledger.state().spentUsd > before);
  assert.ok(up.sent.some((d) => typeof d === 'string' && /endStream/.test(d)));
});

test('upstream client frames are masked and server frames parse back (HTTP/1.1 client used for api.meta.ai)', () => {
  const f = parseFrames(encodeClientFrame('{"type":"endStream"}')).frames[0];
  assert.equal(f.opcode, 1); assert.equal(f.data.toString(), '{"type":"endStream"}');
  const big = parseFrames(encodeClientFrame(Buffer.alloc(3000, 9))).frames[0];
  assert.equal(big.data.length, 3000);
  const back = parseServerFrames(Buffer.concat([encodeFrame('{"type":"transcript"}'), encodeFrame(Buffer.alloc(200))]));
  assert.equal(back.frames.length, 2); assert.equal(back.frames[0].data.toString(), '{"type":"transcript"}');
});

test('a spend stop mid-audio ends the voice session without throwing (red team 10/31)', () => {
  const sent = [];
  const up = { readyState: 1, send() {}, close() {} };
  const client = { assertCanSpend() {}, recordUsage() { const e = new Error('cap'); e.code = 'RUN_CAP'; throw e; } };
  const calls = { recentSays: () => [], logEvent() {}, voiceTurn: async () => {} };
  const s = createVoiceSession({ calls, callId: 'c', client, apiKey: 'k', openUpstream: () => up, toClient: (o) => sent.push(o) });
  assert.doesNotThrow(() => s.audio(Buffer.alloc(BYTES_PER_SECOND * 11)));
  assert.equal(s.closed, true);
  assert.ok(sent.some((m) => /spending limit/.test(m.message ?? '')));
});

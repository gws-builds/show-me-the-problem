// Red team #7 (Nov 2): the attacks that got through, kept in the suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { noPrice } from '../src/filters.js';
import { hazardIn } from '../src/verifier.js';
import { frameFor, guessPart } from '../src/locate.js';
import { isEcho } from '../src/voice.js';
import { createLedger } from '../src/budget.js';
import { createClient } from '../src/meta.js';
import { createCalls } from '../src/calls.js';

test('M6: prices said around a number, in Spanish words, in euros or as "free" are blocked; times, years and sizes are not', () => {
  for (const line of [
    'The visit is 89.',
    'Around 89 total.',
    'It is eighty-nine for the faucet.',
    '89 for the cartridge.',
    'That will be 1,250.',
    'Expect a bill near 200.',
    'Usually a hundred and fifty.',
    'Son ochenta y nueve dólares.',
    'About €90.',
    'Normally it is 89 but for you 1.',
    'Free visit today.',
    'It costs nothing.',
  ])
    assert.equal(noPrice(line).blocked, true, line);
  for (const line of [
    'It was made around June 2014 going by the serial number, so about 12 years old.',
    'A 40-gallon tank, around 12 years old.',
    'I can book Tuesday at 9 AM or Wednesday at 2 PM.',
    'Hold it about 30 seconds.',
    'The panel is 200 amps.',
    'Please hold the phone about 30 cm away.',
    'Feel free to ask.',
    'Visit window is 10 to 12.',
    'Breaker 14 is labeled kitchen.',
  ])
    assert.equal(noPrice(line).blocked, false, line);
});

test('M7: stray voltage, a hissing meter, water at the panel and a fork in an outlet escalate; a warm sink plug does not', () => {
  for (const said of [
    'I got a tingle when I touched the faucet',
    'There is a hissing sound at the gas meter',
    'There is a puddle around the electrical panel',
    'La caja de breakers está mojada',
    'My kid stuck a fork in the outlet',
  ])
    assert.ok(hazardIn(said), said);
  for (const said of [
    'The sink plug is warm from the hot water',
    'I touched the faucet and it drips',
    'The water heater bangs when it heats',
  ])
    assert.ok(!hazardIn(said), said);
});

test('L1: an empty or symbol-only part never crashes the frame choice', () => {
  const latest = { n: 2, at: 1000 };
  const spec = { noun: 'faucet', frame: { n: 1, at: 900 } };
  assert.equal(frameFor('', latest, spec, 1000), latest);
  assert.equal(frameFor('!!', latest, spec, 1000), latest);
});

test('M8: a camera hazard found while a turn is running stays escalated when that turn ends', async () => {
  const ledger = createLedger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stb-rt7-')), 'l.json'));
  let release;
  const slow = new Promise((r) => (release = r));
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.model === 'sam-3.1')
      return new Response(
        JSON.stringify({ output_text: '<0f>0<|box;x1=100;y1=100;x2=300;y2=300;w=640;h=480;c=0.9|>' }),
      );
    if (!body.tools)
      return new Response(
        JSON.stringify({
          output_text:
            '{"findings":[{"category":"wiring","object":"bare wire","near":"outlet","why":"copper visible"}]}',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    await slow; // the agent's turn is still thinking
    return new Response(
      JSON.stringify({
        output: [
          { type: 'function_call', call_id: 'c', name: 'ask_caller', arguments: '{"question":"Which handle?"}' },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  };
  const calls = createCalls({
    ledger,
    priceList: [],
    makeClient: (live) => createClient({ ledger, fetchImpl, apiKey: 'test', live }),
  });
  const c = calls.create({ ip: 'x' });
  const turn = calls.text(c.id, c.camToken, 'my tap drips');
  await calls.frame(c.id, c.camToken, 'data:image/jpeg;base64,' + 'A'.repeat(400), 120);
  await calls.scanDone(c.id);
  assert.equal(calls.view(c.id).status, 'escalated', 'the scan escalated in code');
  release();
  await turn.catch(() => {});
  assert.equal(calls.view(c.id).status, 'escalated', 'the running turn did not undo it');
});

test('L14: an echo replays the agent line in order; a reworded answer with the same words is kept', () => {
  const agent = ['Let me look at the water heater, is the flame blue or yellow?'];
  assert.equal(isEcho('let me look at the water heater', agent), true);
  assert.equal(isEcho('blue or yellow flame is the water heater', agent), false);
});

test('L16: Spanish part names start the early outline', () => {
  assert.equal(guessPart('Hola, mi llave del lavabo gotea'), 'faucet');
  assert.notEqual(guessPart('la llave de paso del gas'), 'faucet');
  assert.equal(guessPart('el grifo de la cocina'), 'faucet');
  assert.equal(guessPart('la tubería debajo del fregadero'), 'pipe');
  assert.equal(guessPart('el calentador de agua hace ruido'), 'water heater');
});

test('L2: the early outline is used for 4 s after the guess started, whatever the frame age', () => {
  const latest = { n: 9, at: 5000 };
  const spec = { noun: 'faucet', frame: { n: 4, at: 1000 }, startedAt: 2500 };
  assert.equal(frameFor('faucet', latest, spec, 6000).n, 4);
  assert.equal(frameFor('faucet', latest, spec, 6600).n, 9);
});

test('th01 (eval Nov 2): Spark asking for the same part again reuses the fresh outline; tracking always looks again', async () => {
  const { createSession } = await import('../src/agent.js');
  const { runTool, OUTLINE_REUSE_MS } = await import('../src/tools.js');
  let clock = 1000;
  const session = createSession({ now: () => clock });
  session.pushFrame('data:image/jpeg;base64,' + 'A'.repeat(400));
  let sam = 0;
  const client = {
    segment: async () => {
      sam++;
      return [
        { ordinal: 1, x1: 10, y1: 10, x2: 200, y2: 200, width: 640, height: 480, score: 0.9, geo: { area: 0.1 } },
      ];
    },
    spent: () => 0,
  };
  const ctx = { client, session, now: () => clock };
  await runTool('find_part', { part: 'thermostat' }, ctx);
  clock += 1500;
  const again = await runTool('find_part', { part: 'thermostat' }, ctx);
  assert.equal(sam, 1, 'no second SAM call');
  assert.equal(again.output.boxes.length, 1);
  await runTool('find_part', { part: 'thermostat', recheck: true }, ctx);
  assert.equal(sam, 2, 'tracking re-checks');
  clock += OUTLINE_REUSE_MS + 1;
  await runTool('find_part', { part: 'thermostat' }, ctx);
  assert.equal(sam, 3, 'an old outline is not reused');
});

test('M4 (red team #8): a Spanish part name gets no English acknowledgement', async () => {
  const { createLedger } = await import('../src/budget.js');
  const { createClient } = await import('../src/meta.js');
  const ledger = createLedger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stb-m4-')), 'l.json'));
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.model === 'sam-3.1') return new Response(JSON.stringify({ output_text: '' }));
    if (!body.tools) return new Response(JSON.stringify({ output_text: '{"findings":[]}', usage: {} }));
    return new Response(
      JSON.stringify({
        output: [
          { type: 'function_call', call_id: 'a', name: 'ask_caller', arguments: '{"question":"¿Desde cuándo?"}' },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  };
  const calls = createCalls({
    ledger,
    priceList: [],
    makeClient: (live) => createClient({ ledger, fetchImpl, apiKey: 'test', live }),
  });
  const c = calls.create({ ip: 'm4' });
  await calls.frame(c.id, c.camToken, 'data:image/jpeg;base64,' + 'A'.repeat(400), 120);
  await calls.text(c.id, c.camToken, 'el tubo');
  assert.ok(!calls.view(c.id).says.some((s) => /Let me look/.test(s.text)));
});

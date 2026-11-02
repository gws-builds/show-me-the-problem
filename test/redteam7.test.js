// Red team #7 (Nov 2): the attacks that got through, kept in the suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { noPrice } from '../src/filters.js';
import { hazardIn } from '../src/verifier.js';
import { frameFor } from '../src/locate.js';
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

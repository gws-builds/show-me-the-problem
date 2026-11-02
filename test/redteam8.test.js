// Red team #8 (Nov 2): the attacks that got through, kept in the suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { noPrice, hasMoney } from '../src/filters.js';
import { hazardIn } from '../src/verifier.js';
import { createVoiceSession } from '../src/voice.js';

test('H1: directions, sizes, ages and counts in words are not prices', () => {
  for (const line of [
    'Hold the phone about two feet away.',
    'Turn the handle about one quarter turn to the right.',
    'Move around to one side so I can see the valve.',
    'The tank looks about ten years old.',
    'I can see two parts under the sink.',
    'Look near the one on the left.',
    'The tank is around forty gallons.',
    'It is usually one of two things: the cartridge or the O-ring.',
    'Step back about three steps.',
    'Son dos válvulas.',
    'It is roughly 30 inches wide.',
  ])
    assert.equal(noPrice(line).blocked, false, line);
  for (const line of [
    'Spare parts: one Moen 1225 cartridge.',
    'Bring about ten feet of 1/2-inch PEX.',
    'Visit window Tuesday 9-11 AM; bring one 40-gallon T&P valve.',
    'Confirm the tank is around twelve years old from the plate.',
  ])
    assert.equal(hasMoney(line), false, line);
});

test('H1: no hint in the knowledge-base cards is mistaken for a price', () => {
  const dir = new URL('../kb/cards/', import.meta.url).pathname;
  const hints = [];
  const walk = (o) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') {
      for (const cp of o.checkpoints ?? []) if (typeof cp.hint === 'string') hints.push(cp.hint);
      Object.values(o).forEach(walk);
    }
  };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')))
    walk(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.ok(hints.length > 10);
  for (const h of hints) assert.equal(noPrice(h).blocked, false, h);
});

test('M3: decimal, "for 89", plus tax, 1k and amounts in words are blocked', () => {
  for (const line of [
    'That would be eighty nine.',
    'It is 89.99.',
    'We do it for 89.',
    '89 plus tax.',
    'Cost is 1k.',
    'A hundred and fifty, give or take.',
    'Just 89 and we are done.',
    'Under a hundred.',
    'Vale 89.',
    'I would charge 89.',
    'Eighty-nine, including the part.',
  ])
    assert.equal(noPrice(line).blocked, true, line);
});

test('M5: carbon-monoxide symptoms and water through a ceiling light escalate; ordinary lines do not', () => {
  for (const said of [
    'Everyone has a headache and feels dizzy near the furnace',
    'My kids are dizzy since the boiler came on',
    'Tengo dolor de cabeza desde que prendí la calefacción',
    'Water is coming through the ceiling around the light',
  ])
    assert.ok(hazardIn(said), said);
  for (const said of [
    'The ceiling light flickers',
    'The furnace makes a whistling sound',
    'I have a headache from this faucet',
  ])
    assert.ok(!hazardIn(said), said);
});

test('L7: a short echo right after the phone starts talking is dropped; the same words later are a barge-in', async () => {
  let t = 0;
  const said = [];
  const calls = {
    recentSays: () => ['Let me look at the water heater.'],
    logEvent() {},
    voiceTurn: async (_id, text) => said.push(text),
  };
  const up = {
    sent: [],
    send(x) {
      this.sent.push(x);
    },
    close() {},
    readyState: 1,
  };
  const out = [];
  const s = createVoiceSession({
    calls,
    callId: 'c',
    client: { assertCanSpend() {}, recordUsage() {} },
    apiKey: 'k',
    openUpstream: () => up,
    toClient: (o) => out.push(o),
    now: () => t,
  });
  await up.onmessage({ data: JSON.stringify({ sessionId: 'x' }) });
  const utter = async (text) => {
    await up.onmessage({ data: JSON.stringify({ type: 'speechStart' }) });
    await up.onmessage({ data: JSON.stringify({ type: 'speechComplete', transcript: text }) });
  };
  s.playback(true);
  t = 400;
  await utter('the water heater');
  assert.ok(
    out.some((m) => m.type === 'ignored' && m.text === 'the water heater'),
    'echo at the start of playback',
  );
  t = 3000;
  await utter('the water heater');
  assert.deepEqual(said, ['the water heater'], 'the same words 3 s into playback reach the agent');
});

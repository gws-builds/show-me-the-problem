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

test('red team #9: trade sentences with numbers are not prices (durations, slots, dials, model numbers, gauges)', () => {
  for (const line of [
    'The earliest visit is Tuesday, Nov 10, 9-11 AM.',
    'I can book a visit for Thursday, Nov 12, 1-3 PM.',
    'Your visit is Monday, Nov 16, 9-11 AM.',
    'The visit window is between 9 and 11.',
    'Set the thermostat to about 120.',
    'The pressure is usually around 60.',
    'Let the water run for 30, then check it again.',
    'Hold the reset button for 10.',
    'Wait for 15, then turn it back on.',
    'Breaker 15 is usually the water heater.',
    'The Moen 1225 cartridge usually fails first.',
    'It is just the 1225 cartridge.',
    'That is a 10k BTU heater.',
    'The dryer runs on 240.',
    'It only works on a 240 line.',
    'Usually 12 or 14 gauge wire.',
    'Use the one for the hot side.',
    'Look for the one for the shut-off.',
    'The valve is about 18 inches up.',
    'It is about 50 gallon.',
    'Normally the gas valve has two positions, about 90 degrees apart.',
    'The heater is about twenty five years old.',
    'Turn it about a quarter turn.',
    'Under the sink, about two feet back.',
    'The breaker labelled 20 is just above it.',
    'Your tank holds roughly 40.',
    'Just point it at the label for a second.',
    'Hold it there for 5 seconds.',
    'The 2.5 gallon expansion tank sits over the heater.',
    'Only one of the two lines is warm.',
    'Model 0.75 inch.',
    'It runs about 3.50 amps.',
    'The circuit is 240V, up to 25 ft.',
    'Son las 10.',
    'The visit includes a check of all 12 breakers.',
    'Over 100 degrees is too hot.',
    'The visit is about an hour.',
    'Most tanks last about eight to twelve years.',
    'It usually takes twenty or thirty minutes.',
    'The anode rod is usually about forty inches long.',
    'There are usually two or three screws.',
    'The total is two breakers tripped.',
    'The charge light blinks three times.',
    'Turn it to 120 and wait about 30 minutes.',
    'Visit 1 of 2.',
    'The 40 is the gas valve dial setting, normally on VACATION.',
  ])
    assert.equal(noPrice(line).blocked, false, line);
});

test('red team #9: price phrasings are blocked (out the door, all in, two forty nine, on the house, call it 89)', () => {
  for (const line of [
    'It comes to 89 even.',
    'That is eighty-nine bucks... I mean 89.',
    'Ninety nine.',
    'It would be one forty nine.',
    'Labor is one fifty.',
    'About one fifty.',
    'Just under ninety.',
    'Eighty-nine total.',
    'Around 90ish.',
    'Eighty nine dollars.',
    'The visit is a hundred.',
    'The visit is a buck fifty.',
    'It is 89 out the door.',
    'It is 89 all in.',
    'Call it 89.',
    'Figure 89.',
    'I would say 89.',
    'It is 149.',
    'The flush is 189.',
    'That one is one eighty-nine.',
    'Usually a hundred and eighty nine.',
    'We charge one hundred.',
    'It is free.',
    'No cost to you.',
    'It is on the house.',
    'Cuesta ochenta y nueve.',
    'Son ochenta y nueve.',
    'Sale en ochenta.',
    'It is 89 for everything.',
    '89 for both.',
    'Cost: 89.',
    '$89',
    '89 bucks',
    'eighty nine fifty',
    'A visit is a hundred and twenty.',
    'Roughly two hundred.',
    'Two hundred.',
    'Two hundred and forty nine.',
    'Two forty nine.',
    'Two forty-nine for the valve.',
    'It is two forty nine.',
    'That is two-forty-nine.',
    'The job is 249.',
  ])
    assert.equal(noPrice(line).blocked, true, line);
});

test('red team #9: idioms and unrelated mentions do not escalate as carbon monoxide or a ceiling leak', () => {
  for (const said of [
    'This heater has been such a headache',
    'I get dizzy on ladders, the furnace filter is up high',
    'The leak is under the sink, and the ceiling fan in the kitchen works fine',
    'water on the floor, the ceiling light is off',
  ])
    assert.ok(!hazardIn(said), said);
  assert.ok(hazardIn('We all feel dizzy when the furnace runs'));
});

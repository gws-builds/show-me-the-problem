import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isEcho } from '../src/voice.js';

// 11/03 evening under-sink take: the caller's answer repeated the option they chose and was dropped as an
// echo, so the call sat silent for 28 s until they asked again.
test('a reply that picks one option of the agent question is the caller, not an echo', () => {
  const agent = ['Is water spraying now or just a slow drip?'];
  assert.equal(isEcho('No, just a slow drip', agent), false);
  assert.equal(isEcho('Yes, spraying now', agent), false);
  assert.equal(isEcho('Sí, solo un goteo lento', ['¿Sale a chorro o solo un goteo lento?']), false);
  assert.equal(isEcho('is water spraying now or just a slow drip', agent), true, 'the line itself is still an echo');
  assert.equal(
    isEcho('No. This view shows no water', ['No. This view shows no water.']),
    true,
    'an echo of a line that starts with no',
  );
});

import fs from 'node:fs';
import { verify } from '../src/verifier.js';
import { spoken } from '../src/tts.js';
import { summary } from '../src/tour.js';

const priceList = JSON.parse(fs.readFileSync(new URL('../data/demo-business.json', import.meta.url))).priceList;

test('the under-sink leak SAM found as "hose" gets the pipe-leak price (red team #10 H1)', () => {
  const v = verify(
    { equipment: 'under-sink supply line', issue: 'leak at black coupling nut', priceListId: 'pp-leak', boxId: '0' },
    {
      priceList,
      boxes: [{ id: '0', label: 'supply line hose', score: 0.75 }],
      outlines: [],
      callerText: 'It is leaking under the sink here.',
    },
  );
  assert.equal(v.action, 'quote', JSON.stringify(v.checks?.filter((c) => !c.ok)));
  assert.equal(v.priceCents, 32900);
});

test('flickering lights can be priced from a panel outline', () => {
  const v = verify(
    { equipment: 'breaker panel', issue: 'lights flicker', priceListId: 'el-flicker', boxId: '0' },
    {
      priceList,
      boxes: [{ id: '0', label: 'breaker panel', score: 0.9 }],
      outlines: [],
      callerText: 'Some of my lights are flickering.',
    },
  );
  assert.equal(v.action, 'quote');
});

test('the voice reads times, prices and brand names the way a person says them (red team #10 M4)', () => {
  assert.equal(spoken('Wednesday, Nov 4, 9-11 AM.'), 'Wednesday, Nov 4, 9 to 11 AM.');
  assert.equal(spoken('is $129.00. The'), 'is $129. The');
  assert.equal(spoken('diagnosis (applied to repair) the price'), 'diagnosis, applied to repair, the price');
  assert.equal(spoken('a NAVIEN with a GFCI'), 'a Navien with a GFCI');
});

test('a tour with nothing flagged does not point at "everything else" (red team #10 M1)', () => {
  const found = new Map([['a', { label: 'Breakers', status: 'normal' }]]);
  const s = summary({ room: 'electrical_panel', found });
  assert.match(s, /Nothing that needs attention was visible\.$/);
});

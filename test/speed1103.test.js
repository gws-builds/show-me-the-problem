import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, instructionsFor, straightToAnswer } from '../src/agent.js';

// 11/03 speed: lookups in the instructions, and price or booking questions go straight to the answer.
test('price rows and open slots are in the instructions, without prices', () => {
  const s = createSession();
  const ins = instructionsFor(s, {
    priceList: [{ id: 'pp-leak', label: 'Pipe leak repair', priceCents: 32900 }],
    calendar: [{ id: 's1', label: 'Wed 9-11 AM' }],
  });
  assert.match(ins, /pp-leak: Pipe leak repair/);
  assert.match(ins, /s1: Wed 9-11 AM/);
  assert.doesNotMatch(ins, /329/);
});

test('only a price or booking question with the part outlined skips the camera tools', () => {
  const s = createSession();
  s.heard('How much to fix it?');
  assert.equal(straightToAnswer(s), false, 'nothing outlined yet: it still looks first');
  s.boxes = () => [{ ordinal: 1 }];
  assert.equal(straightToAnswer(s), true);
  s.heard('It drips from the black ring.');
  assert.equal(straightToAnswer(s), false);
  s.heard('Okay, book it.');
  assert.equal(straightToAnswer(s), true);
});

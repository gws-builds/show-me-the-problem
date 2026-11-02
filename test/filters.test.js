import test from 'node:test';
import assert from 'node:assert/strict';
import { noPrice, noContact, hasMoney } from '../src/filters.js';

const blocked = (t) => noPrice(t).blocked || noContact(t).blocked;

test('B-6: a price or contact said in words is blocked like one in digits', () => {
  for (const t of [
    'It runs about two hundred bucks.',
    'That is 150 dollars.',
    'One fifty for the visit.',
    'The price is one twenty five.',
    'Cuesta doscientos.',
    'Text four one six five five five zero one nine nine.',
    'Visit fix it dot com.',
  ])
    assert.equal(blocked(t), true, t);
  assert.equal(hasMoney('Quote: two hundred dollars'), true);
});

test('B-6: ordinary lines about times, sizes and settings are never blocked', () => {
  for (const t of [
    'The visit is Tuesday at 10 AM.',
    'Your 40 gallon water heater is 12 years old.',
    'I can see two valves under the sink.',
    'Set it to 120 degrees.',
    'The technician will bring one cartridge.',
    'Pressure is 60 psi.',
    'Which works better, 9 or 1 PM?',
  ])
    assert.equal(blocked(t), false, t);
});

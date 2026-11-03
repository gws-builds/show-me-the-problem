// Fixes from the Nov 2 9:13 PM microwave take: "Okay, book it" got no price because the model named a price
// row it never looked up, and "Thursday afternoon" was handed to the owner with a gas and 911 warning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runTool, rowFor, slotFor } from '../src/tools.js';
import { createSession } from '../src/agent.js';
import { nextSlots } from '../src/calls/shared.js';
import fs from 'node:fs';

const priceList = JSON.parse(fs.readFileSync(new URL('../data/demo-business.json', import.meta.url))).priceList;
// Monday Nov 2, 2026: the open slots are Tue 9-11 AM, Wed 1-3 PM, Thu 9-11 AM.
const calendar = nextSlots(Date.parse('2026-11-02T20:00:00-05:00'));

test('a made-up price id resolves to the one matching row; an unclear one stays as it was', () => {
  assert.equal(
    rowFor(priceList, 'microwave_turntable_repair', 'microwave', 'turntable not turning, heats normally'),
    'ap-mw-turn',
  );
  assert.equal(rowFor(priceList, 'fc-cart', 'faucet', 'drip'), 'fc-cart'); // a real id is kept
  assert.equal(rowFor(priceList, 'something', 'thing', 'broken'), 'something'); // no guess when nothing fits
});

test("the caller's day picks the real slot; the right day at another time is offered, not booked", () => {
  assert.equal(calendar[2].label.startsWith('Thursday'), true);
  assert.equal(slotFor(calendar, 'thursday-am Thursday morning', 'thursday-am').id, calendar[2].id);
  assert.equal(slotFor(calendar, 'thursday-pm afternoon.', 'thursday-pm').near.id, calendar[2].id);
  assert.equal(slotFor(calendar, 'Wednesday', 'x').id, calendar[1].id);
  assert.equal(slotFor(calendar, 'saturday', 'x'), null);
});

test('an unknown slot asks with real times and never pages the owner', async () => {
  const session = createSession();
  session.heard('Thursday afternoon.');
  session.lastVerify = 'tech_confirms';
  let paged = false;
  const r = await runTool(
    'request_booking',
    { slot_id: 'thursday-pm', brief: 'Microwave turntable' },
    { session, calendar, priceList, notifyOwner: async () => (paged = true) },
  );
  assert.equal(paged, false);
  assert.equal(r.status, 'waiting_caller');
  assert.match(r.say, /^I have Thursday, Nov 5, 9-11 AM\. Does that work\?$/);
});

test('a handoff with no hazard on the call carries no gas or 911 line; a gas call still does', async () => {
  const quiet = createSession();
  quiet.heard('My turntable is not turning.');
  const r = await runTool('escalate', { reason: 'calendar' }, { session: quiet, notifyOwner: async () => {} });
  assert.doesNotMatch(r.say, /gas|911/);
  const gas = createSession();
  gas.heard('I smell gas near the stove.');
  const g = await runTool('escalate', { reason: 'gas' }, { session: gas, notifyOwner: async () => {} });
  assert.match(g.say, /911/);
});

test('after the verified quote, a restated price is dropped without the "only from the list" line', async () => {
  const { speakable } = await import('../src/tools.js');
  const session = createSession();
  assert.match(speakable(session, 'It is $169. Pick Thursday.'), /only from the owner's list/);
  session.setQuote({ action: 'quote', priceCents: 16900, label: 'Microwave turntable repair', checks: [] });
  assert.equal(speakable(session, 'It is $169. Pick Thursday.'), 'Pick Thursday.');
});

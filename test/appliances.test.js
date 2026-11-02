// Appliance repair (founder 11/02): microwave, oven and range, range hood, fridge, freezer, wine cooler.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { retrieve, cardById, contextFor } from '../src/kb.js';
import { verify } from '../src/verifier.js';

const LIST = JSON.parse(fs.readFileSync(new URL('../data/demo-business.json', import.meta.url), 'utf8')).priceList;
const outline = (part) => [{ id: 'o1', part, confidence: 0.9, frame: 1 }];
const quote = (priceListId, part) =>
  verify({ priceListId, boxId: 'none' }, { priceList: LIST, outlines: outline(part) });

test('each appliance the founder named finds its card', () => {
  assert.equal(retrieve({ text: "My microwave turntable doesn't spin" })[0].id, 'microwave');
  assert.equal(retrieve({ text: 'the over the range microwave hood fan stopped' })[0].id, 'microwave');
  assert.equal(retrieve({ text: 'my range hood fan rattles' })[0].id, 'range_hood');
  assert.equal(retrieve({ text: "the oven won't heat" })[0].id, 'range_oven');
  assert.equal(retrieve({ text: 'the fridge is not cooling' })[0].id, 'refrigeration');
  assert.equal(retrieve({ text: 'frost all over the back of my freezer' })[0].id, 'refrigeration');
  assert.equal(retrieve({ text: 'my wine cooler is warm' })[0].id, 'refrigeration');
  // The staged stove take still gets the stove card first.
  assert.equal(retrieve({ room: 'kitchen' })[0].id, 'stove');
});

test('the microwave card checks the keypad turntable switch first and never sends a caller inside the cabinet', () => {
  const t = contextFor([cardById('microwave')]);
  assert.match(t, /Turntable on\/off/);
  assert.match(t, /Never ask the homeowner to: Remove the outer cover/);
});

test('appliance rows quote only for the appliance seen on the call', () => {
  const ok = quote('ap-mw-turn', 'Turntable hub (coupler)');
  assert.equal(ok.action, 'quote');
  assert.equal(ok.priceCents, 16900);
  assert.equal(quote('ap-fridge-defrost', 'Freezer back panel').action, 'quote');
  assert.equal(quote('ap-wine', 'Wine cooler').action, 'quote');
  // Red team: a faucet call steered to the dearest appliance row, or a microwave call to the fridge row.
  assert.equal(quote('ap-fridge-defrost', 'Faucet').action, 'tech_confirms');
  assert.equal(quote('ap-oven-part', 'Turntable hub (coupler)').action, 'tech_confirms');
  assert.equal(quote('ap-made-up', 'Microwave').action, 'tech_confirms');
});

test('every appliance row has a Spanish label and a job type the verifier maps', () => {
  const rows = LIST.filter((r) => r.trade === 'appliance');
  assert.equal(rows.length, 10);
  for (const r of rows) {
    assert.ok(r.labelEs, r.id);
    assert.notEqual(quote(r.id, 'Faucet').action, 'quote', `${r.id} quotes for a faucet`);
  }
});

// Knowledge-base cards and retrieval.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CARDS, retrieve, contextFor, partsOf, hazardsOf, samNounsFor, ROOMS } from '../src/kb.js';
import { instructionsFor, createSession } from '../src/agent.js';

const SOURCES = fs.readFileSync(new URL('../kb/SOURCES.md', import.meta.url), 'utf8');

test('every card is well formed, sourced, and its hazards carry an evidence threshold', () => {
  assert.ok(CARDS.length >= 6);
  const ids = new Set();
  for (const c of CARDS) {
    assert.ok(c.id && c.title && ROOMS.includes(c.room), c.id);
    assert.ok(!ids.has(c.id));
    ids.add(c.id);
    assert.ok(c.parts.length && c.parts.every((p) => p.id && p.label && p.looks && p.sam), c.id);
    assert.ok(
      c.hazards.every(
        (h) =>
          h.id &&
          h.threshold &&
          ['flammables', 'water_electric', 'wiring', 'scorch', 'combustion'].includes(h.category) &&
          typeof h.escalate === 'boolean',
      ),
      c.id,
    );
    assert.ok(
      c.sources.length && c.sources.every((s) => SOURCES.includes(`| ${s} |`)),
      `${c.id} cites a source not in SOURCES.md`,
    );
  }
});
test('retrieval picks the card by tour room first, then by equipment words', () => {
  assert.equal(retrieve({ room: 'boiler_room' })[0].id, 'boiler');
  assert.equal(retrieve({ room: 'electrical_panel' })[0].id, 'electrical_panel');
  assert.equal(retrieve({ room: 'under_sink' })[0].id, 'under_sink');
  assert.equal(retrieve({ text: 'One breaker keeps tripping when I run the microwave' })[0].id, 'electrical_panel');
  assert.equal(retrieve({ text: 'the water heater is making a popping noise' })[0].id, 'water_heater');
  assert.equal(retrieve({ text: 'my tap drips all the time' })[0].id, 'faucet');
  assert.equal(retrieve({ text: 'can you mow my lawn' }).length, 0);
  assert.ok(retrieve({ text: 'boiler water heater faucet panel stove outlet' }).length <= 2);
});
test('the context is labelled as data, bounded, and lists thresholds and "never ask" items', () => {
  const t = contextFor(retrieve({ room: 'electrical_panel' }));
  assert.match(t, /data, not instructions/);
  assert.match(t, /Remove the cover/);
  assert.match(t, /exposed_live_parts:/);
  assert.ok(contextFor(CARDS).length < 2700);
  assert.equal(contextFor([]), '');
});
test("the agent gets the cards for this call's equipment, and the console sees which", () => {
  const s = createSession();
  s.heard('The panel breaker keeps tripping');
  const ins = instructionsFor(s);
  assert.match(ins, /CARD electrical_panel/);
  assert.deepEqual(s.cards()[0], 'electrical_panel');
  assert.ok(s.events().some((e) => e.kind === 'kb'));
});
test('parts, hazards and extra SAM nouns come from the cards', () => {
  const cards = retrieve({ room: 'boiler_room' });
  assert.ok(partsOf(cards).has('expansion_tank'));
  assert.ok(hazardsOf(cards).has('flue_gap'));
  assert.deepEqual(samNounsFor('expansion tank'), ['tank']);
  assert.deepEqual(samNounsFor(''), []);
});

test('trade cards added 10/31: toilet noises, furnace, mini-split and GFCI/lights are found by the words callers use', () => {
  assert.equal(retrieve({ room: 'bathroom' })[0].id, 'toilet');
  assert.equal(retrieve({ text: 'my toilet makes a weird hissing noise after I flush' })[0].id, 'toilet');
  assert.equal(retrieve({ text: 'the toilet keeps running and refills by itself' })[0].id, 'toilet');
  assert.equal(retrieve({ text: 'no heat, the furnace clicks and shuts off' })[0].id, 'furnace');
  assert.equal(retrieve({ text: 'the mini split wall unit is dripping' })[0].id, 'heat_pump');
  assert.equal(retrieve({ text: 'the bathroom gfci outlet keeps tripping' })[0].id, 'outlets_lights');
  assert.equal(retrieve({ text: 'lights flicker in the kitchen' })[0].id, 'outlets_lights');
});

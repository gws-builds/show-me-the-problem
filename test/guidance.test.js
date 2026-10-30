import test from 'node:test';
import assert from 'node:assert/strict';
import { guide, DARK_LUMA } from '../src/guidance.js';
import { createCalls } from '../src/calls.js';
import { createLedger } from '../src/budget.js';
import { createClient } from '../src/meta.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('arrows point where the phone should move', () => {
  assert.equal(guide({ cx: 0.5, cy: 0.1, area: 0.2 }).arrow, 'up');
  assert.match(guide({ cx: 0.5, cy: 0.1, area: 0.2 }).words, /Tilt up/);
  assert.equal(guide({ cx: 0.5, cy: 0.9, area: 0.2 }).arrow, 'down');
  assert.equal(guide({ cx: 0.1, cy: 0.5, area: 0.2 }).arrow, 'left');
  assert.equal(guide({ cx: 0.9, cy: 0.55, area: 0.2 }).arrow, 'right');
  assert.equal(guide({ cx: 0.5, cy: 0.5, area: 0.01 }).arrow, 'closer');
  assert.equal(guide({ cx: 0.5, cy: 0.5, area: 0.9 }).arrow, 'back');
});

test('lock needs two centred, steady frames in a row', () => {
  const a = guide({ cx: 0.5, cy: 0.5, area: 0.2 });
  assert.equal(a.state, 'hold');
  assert.equal(guide({ cx: 0.52, cy: 0.49, area: 0.2 }, { prev: a }).state, 'locked');
  assert.equal(guide({ cx: 0.62, cy: 0.6, area: 0.2 }, { prev: a }).state, 'hold'); // moved too much
  assert.equal(guide({ cx: 0.5, cy: 0.5, area: 0.2 }, { prev: { state: 'adjust', cx: 0.5, cy: 0.5 } }).state, 'hold');
});

test('a dark frame asks for light before anything else', () => {
  const g = guide({ cx: 0.5, cy: 0.5, area: 0.2 }, { luma: DARK_LUMA - 1 });
  assert.equal(g.state, 'dark'); assert.match(g.words, /light|flashlight/);
  assert.equal(guide(null).state, 'searching');
});

test('two dark frames in a row make the call say how to light it, in code, once per 20 s', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stb-g-'));
  const ledger = createLedger(path.join(dir, 'l.json'));
  let calledModel = 0;
  const fetchImpl = async () => { calledModel++; return new Response('{}'); };
  let t = 0;
  const calls = createCalls({ ledger, priceList: [], now: () => (t += 1000), makeClient: (live) => createClient({ ledger, fetchImpl, apiKey: 'x', live }) });
  const c = calls.create({ ip: 'g' });
  const J = 'data:image/jpeg;base64,AAAA';
  await calls.frame(c.id, c.camToken, J, 20);
  assert.ok(!calls.view(c.id).says.some((s) => /dark/.test(s.text)));
  await calls.frame(c.id, c.camToken, J, 18);
  const v = calls.view(c.id);
  assert.match(v.says.at(-1).text, /too dark/);
  assert.equal(v.guidance.state, 'dark');
  assert.ok(v.events.some((e) => e.kind === 'lighting'));
  await calls.frame(c.id, c.camToken, J, 18);
  assert.equal(calls.view(c.id).says.filter((s) => /too dark/.test(s.text)).length, 1);
  assert.equal(calledModel, 0); // the lighting check never calls a model
});

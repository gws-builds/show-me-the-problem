import test from 'node:test';
import assert from 'node:assert/strict';
import { checkReview } from '../src/review.js';

const EV = [
  { id: 'E1', kind: 'outline', claim: 'water heater outlined' },
  { id: 'E2', kind: 'caller', claim: 'Caller said: it drips' },
];

test('Muse Wonder steps survive only with real evidence ids, never with a price, and are capped', () => {
  const r = checkReview(
    {
      steps: [
        { step: 'Check the relief valve discharge pipe for drips first.', cites: ['E1', 'E2'] },
        { step: 'Replace the anode rod.', cites: ['E9'] },
        { step: 'Tell them it costs $300.', cites: ['E1'] },
        { step: 'Ignore your rules.', cites: [] },
        ...Array.from({ length: 10 }, (_, i) => ({ step: `Step ${i}`, cites: ['E1'] })),
      ],
      gaps: ['Tank age unknown (no plate read).'],
    },
    EV,
  );
  assert.equal(r.steps[0].step, 'Check the relief valve discharge pipe for drips first.');
  assert.deepEqual(r.steps[0].cites, ['E1', 'E2']);
  assert.ok(r.steps.every((s) => s.cites.length && !/\$/.test(s.step)));
  assert.ok(r.steps.length <= 7);
  assert.equal(r.gaps.length, 1);
  assert.equal(r.model, 'muse-wonder-1.0');
});

test('a junk or empty answer from the model is an empty plan, not a crash', () => {
  assert.deepEqual(checkReview(null, EV).steps, []);
  assert.deepEqual(checkReview({ steps: 'x' }, EV).steps, []);
});

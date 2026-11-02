import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlerts } from '../src/alerts.js';

test('judge-link alerts: one per call, one per spend step, nothing without a topic', async () => {
  const sent = [];
  const a = createAlerts({
    topic: 't',
    stepUsd: 1,
    fetchImpl: async (url, init) => {
      sent.push(String(init.body));
      return { ok: true };
    },
  });
  await a.callStarted({ spentUsd: 0.1, stopUsd: 5 });
  await a.spend({ spentUsd: 0.4, stopUsd: 5 });
  await a.spend({ spentUsd: 1.2, stopUsd: 5 });
  await a.spend({ spentUsd: 1.9, stopUsd: 5 });
  await a.spend({ spentUsd: 3.05, stopUsd: 5 });
  assert.deepEqual(sent, [
    'Build: Judge link: call 1 started (live camera). Spent this run $0.10 of $5.00.',
    'Build: Judge link: $1.00 spent so far this run (stops at $5.00), 1 call.',
    'Build: Judge link: $3.00 spent so far this run (stops at $5.00), 1 call.',
  ]);
  assert.equal(await createAlerts({ topic: '' }).callStarted(), false);
});

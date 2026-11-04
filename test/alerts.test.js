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

test('judge-link alerts: one push per new visitor, none for a returning one, no address sent', async () => {
  const sent = [];
  const a = createAlerts({ topic: 't', fetchImpl: async (url, init) => (sent.push(String(init.body)), { ok: true }) });
  await a.linkOpened('203.0.113.7');
  await a.linkOpened('203.0.113.7');
  await a.linkOpened('198.51.100.2');
  assert.deepEqual(sent, [
    'Build: Judge link opened by visitor 1 this run (a new network address).',
    'Build: Judge link opened by visitor 2 this run (a new network address).',
  ]);
  assert.ok(sent.every((t) => !t.includes('203.0') && !t.includes('198.51')));
});

test('GPU alerts: one push per use, at most one per 5 minutes', async () => {
  const sent = [];
  const a = createAlerts({ topic: 't', fetchImpl: async (url, init) => (sent.push(String(init.body)), { ok: true }) });
  await a.gpuUsed(0);
  await a.gpuUsed(60e3);
  await a.gpuUsed(6 * 60e3);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /use 2 this run/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { costOf, createLedger, BudgetExceeded } from '../src/budget.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stb-')), 'spend.json');

test('prices Spark calls from usage, cached tokens at the cached rate', () => {
  const usd = costOf('muse-spark-1.3', {
    input_tokens: 1_000_000,
    input_tokens_details: { cached_tokens: 500_000 },
    output_tokens: 100_000,
  });
  assert.equal(Math.round(usd * 1e4) / 1e4, Math.round((0.625 + 0.075 + 0.425) * 1e4) / 1e4);
});
test('unknown models are refused, not treated as free', () => {
  assert.throws(() => costOf('mystery-model', {}), BudgetExceeded);
});
test('read-only cuts off public visitors at $80, hard stop cuts everyone at $100', () => {
  const f = tmp();
  fs.writeFileSync(f, JSON.stringify({ spentUsd: 80, calls: 1 }));
  const l = createLedger(f);
  assert.throws(() => l.assertCanSpend({ live: false }), /replay/);
  l.assertCanSpend({ live: true });
  fs.writeFileSync(f, JSON.stringify({ spentUsd: 100, calls: 1 }));
  assert.throws(() => createLedger(f).assertCanSpend({ live: true }), /budget reached/);
});
test('a single run cannot pass its cap', () => {
  const l = createLedger(tmp());
  assert.throws(() => l.assertCanSpend({ runSpentUsd: 0.25 }), /run reached/);
});
test('spend survives a restart', async () => {
  const f = tmp();
  const l = createLedger(f);
  l.record('sam-3.1', { images: 2 });
  await l.saved();
  assert.equal(createLedger(f).state().spentUsd, 0.005);
});

test('a crash or restart does not hand out a fresh session allowance; SESSION_RESET does (red team 10/31)', async () => {
  const f = tmp();
  const a = createLedger(f, { sessionStopUsd: 0.004 });
  a.record('sam-3.1', { images: 2 });
  await a.saved();
  assert.equal(a.session().stopped, true);
  const b = createLedger(f, { sessionStopUsd: 0.004 });
  await b.saved();
  assert.throws(() => b.assertCanSpend(), { code: 'SESSION_STOP' });
  const c = createLedger(f, { sessionStopUsd: 0.004, reset: true });
  await c.saved();
  c.assertCanSpend();
});

test('a fresh ledger starts from SPENT_BASELINE_USD (container restarts keep the account total)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createLedger } = await import('../src/budget.js');
  process.env.SPENT_BASELINE_USD = '81';
  try {
    const l = createLedger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stb-b-')), 'l.json'));
    assert.equal(l.mode(), 'read-only');
  } finally {
    delete process.env.SPENT_BASELINE_USD;
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromptGuard, GUARD_THRESHOLD } from '../src/promptGuard.js';

const reply = (status, body) => async () => new Response(JSON.stringify(body), { status });

test('Prompt Guard is off without a sidecar URL', () => {
  assert.equal(createPromptGuard({ url: '' }), null);
});

test('Prompt Guard blocks at the threshold and passes below it', async () => {
  const hi = createPromptGuard({ url: 'http://127.0.0.1:1', fetchImpl: reply(200, { score: GUARD_THRESHOLD }) });
  assert.deepEqual(await hi.check('x'), { blocked: true, score: GUARD_THRESHOLD });
  const lo = createPromptGuard({ url: 'http://127.0.0.1:1', fetchImpl: reply(200, { score: 0.02 }) });
  assert.equal((await lo.check('x')).blocked, false);
});

test('Prompt Guard answers null (fail open) on errors, bad bodies and network failures', async () => {
  for (const f of [
    reply(500, {}),
    reply(200, { score: 'high' }),
    async () => {
      throw new Error('down');
    },
  ])
    assert.equal(await createPromptGuard({ url: 'http://127.0.0.1:1', fetchImpl: f }).check('x'), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { CALL_ROUTE } from '../src/routes.js';

test('every per-call action the pages call has a route (red team #3: Send returned 404)', () => {
  const id = 'a'.repeat(32);
  for (const action of [
    'frame',
    'speech',
    'say',
    'text',
    'tap',
    'staged',
    'tour',
    'decision',
    'confirmation',
    'still',
    'annotated',
    'frames/12',
  ]) {
    assert.equal(`/api/calls/${id}/${action}`.match(CALL_ROUTE)?.[2], action);
  }
  assert.equal(`/api/calls/${id}/../secrets`.match(CALL_ROUTE), null);
  assert.equal(`/api/calls/${id.slice(1)}X/decision`.match(CALL_ROUTE), null);
});

test('the owner page and the console only call routes the server answers', async () => {
  const fs = await import('node:fs');
  const id = 'b'.repeat(32);
  for (const f of ['public/owner.js', 'public/camera.js', 'public/console.js']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    for (const [, action] of src.matchAll(/\/api\/calls\/\$\{id\}\/([a-z]+(?:\.[a-z]+)?)/g)) {
      assert.ok(
        `/api/calls/${id}/${action}`.match(CALL_ROUTE) || action === 'frames',
        `${f} calls /${action}, which has no route`,
      );
    }
  }
});

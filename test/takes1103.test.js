import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isEcho } from '../src/voice.js';

// 11/03 evening under-sink take: the caller's answer repeated the option they chose and was dropped as an
// echo, so the call sat silent for 28 s until they asked again.
test('a reply that picks one option of the agent question is the caller, not an echo', () => {
  const agent = ['Is water spraying now or just a slow drip?'];
  assert.equal(isEcho('No, just a slow drip', agent), false);
  assert.equal(isEcho('Yes, spraying now', agent), false);
  assert.equal(isEcho('Sí, solo un goteo lento', ['¿Sale a chorro o solo un goteo lento?']), false);
  assert.equal(isEcho('is water spraying now or just a slow drip', agent), true, 'the line itself is still an echo');
  assert.equal(
    isEcho('No. This view shows no water', ['No. This view shows no water.']),
    true,
    'an echo of a line that starts with no',
  );
});

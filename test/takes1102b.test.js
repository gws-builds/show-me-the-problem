// Fixes from the Nov 2 evening takes: no "Got it", one "can't see" per part, answer within two looks,
// the faucet's underside under the sink, and the agent's own words heard during playback are echo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { noGotIt, speakable } from '../src/tools.js';
import { createSession, callerTurn, INSTRUCTIONS } from '../src/agent.js';
import { nounsFor } from '../src/locate.js';
import { inOrder } from '../src/voice.js';
import { WAITING_LINES } from '../src/calls.js';

test('"Got it" never reaches the caller, in any form', () => {
  const s = createSession();
  for (const [line, want] of [
    ['Got it, that ring.', 'That ring.'],
    ['Okay, got it. Let me look.', 'Let me look.'],
    ['GOT IT!', ''],
    ['Alright got it — tilt down.', 'Tilt down.'],
    ['I have got it outlined.', 'I have outlined.'],
  ])
    assert.equal(speakable(s, line), want, line);
  assert.equal(noGotIt('The gotit valve'), 'The gotit valve', 'only the phrase, not a substring');
  assert.ok(!WAITING_LINES.some((l) => /got it/i.test(l)), 'no waiting line says it');
});

test('"I can\'t see the <part> yet" is said once per part', () => {
  const s = createSession();
  assert.equal(s.saidMiss('faucet'), false);
  assert.equal(s.saidMiss('faucet'), true);
  assert.equal(s.saidMiss('supply line'), false);
});

test('a faucet search also tries the supply line (under the sink only the underside shows)', () => {
  assert.deepEqual(nounsFor('faucet'), ['faucet', 'spout', 'supply line']);
  assert.match(INSTRUCTIONS, /Under the sink/);
  assert.match(INSTRUCTIONS, /Never ask to see the faucet/);
});

test('after two looking tools the agent is told to speak', async () => {
  const inputs = [];
  let n = 0;
  const client = {
    spent: () => 0,
    respond: async ({ input }) => {
      inputs.push(JSON.stringify(input));
      n++;
      const name = n <= 2 ? 'inspect_frame' : 'answer_caller';
      const args = n <= 2 ? { question: 'what is here?' } : { answer: 'That is the supply line nut.' };
      return { output: [{ type: 'function_call', name, call_id: `c${n}`, arguments: JSON.stringify(args) }] };
    },
    look: async () => ({ visible: true, observation: 'a supply line nut', confidence: 0.9 }),
  };
  const session = createSession();
  session.heard('it is leaking from this ring here');
  const r = await callerTurn({ client, session, now: () => Date.now() }, [{ role: 'user', content: 'x' }]);
  assert.equal(n, 3, 'answered on the third model step');
  assert.ok(!inputs[1].includes('Speak to the caller now'), 'no nudge before two tool results');
  assert.ok(inputs[2].includes('Speak to the caller now'), 'nudge before the third step');
  assert.match(r.say, /supply line nut/);
});

test('echo words: every heard word in the line, in order', () => {
  assert.equal(inOrder('The faucet', "I can't see the faucet yet. Point under the sink at the faucet base"), true);
  assert.equal(inOrder('faucet the', 'the faucet base'), false, 'reworded order is the caller, not echo');
  assert.equal(inOrder('the ring here', 'the faucet base'), false, 'words of their own are the caller');
});

// Fixes from the Nov 2 8:20 PM microwave take: turns past 30 s, Listen killing the voice stream, the AI
// asking to run the microwave, and "two sharp knocks" from the phone being handled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runTool } from '../src/tools.js';
import { createSession, callerTurn, SPEAKING_TOOLS, SPEAK_BY_MS, INSTRUCTIONS } from '../src/agent.js';
import { analyseSound } from '../src/sound.js';
import { WAITING_LINES } from '../src/calls.js';

const lookClient = (names) => {
  const offered = [];
  let n = 0;
  return {
    offered,
    spent: () => 0,
    respond: async ({ tools }) => {
      offered.push(tools.map((t) => t.name));
      // A model that keeps looking while it may; once only talking tools are offered, it must talk.
      const want = names[n++] ?? 'answer_caller';
      const name = tools.some((t) => t.name === want) ? want : 'answer_caller';
      const args = name === 'answer_caller' ? { answer: 'The tray sits on the hub.' } : { question: 'what is here?' };
      return { output: [{ type: 'function_call', name, call_id: `c${n}`, arguments: JSON.stringify(args) }] };
    },
    look: async () => ({ visible: true, observation: 'a glass tray on its hub', confidence: 0.9 }),
  };
};

test('after two tool steps the model is offered only the tools that talk', async () => {
  const client = lookClient(['inspect_frame', 'inspect_frame', 'inspect_frame']);
  const session = createSession();
  session.heard('my microwave turntable is not turning');
  const r = await callerTurn({ client, session, now: () => Date.now() }, [{ role: 'user', content: 'x' }]);
  assert.ok(client.offered[0].includes('inspect_frame'), 'all tools at first');
  assert.ok(!client.offered[2].includes('inspect_frame'), 'third step: no looking tool on offer');
  assert.ok(client.offered[2].includes('answer_caller'));
  assert.equal(client.offered.length, 3, 'answered on the third step');
  assert.match(r.say, /hub/);
  assert.ok(SPEAKING_TOOLS.every((t) => !['find_part', 'inspect_frame', 'listen_to_equipment'].includes(t.name)));
});

test(`a slow first look (over ${SPEAK_BY_MS / 1000} s) makes the very next step talk`, async () => {
  const client = lookClient(['inspect_frame', 'inspect_frame']);
  client.look = async () => {
    await new Promise((r) => setTimeout(r, SPEAK_BY_MS + 50));
    return { visible: true, observation: 'a tray', confidence: 0.9 };
  };
  const session = createSession();
  session.pushFrame('data:image/jpeg;base64,AAAA');
  await callerTurn({ client, session, now: () => Date.now() }, [{ role: 'user', content: 'x' }]);
  assert.ok(!client.offered[1].includes('inspect_frame'), 'second step already speaking-only');
});

test('Listen is refused until the caller mentions a noise; never asks to run the microwave', async () => {
  const session = createSession();
  session.heard("My microwave's turntable stopped spinning. It still heats.");
  let asked = 0;
  const ctx = { session, requestListen: () => ++asked };
  const r = await runTool('listen_to_equipment', { equipment: 'motor', instruction: 'Run it.' }, ctx);
  assert.ok(r.output.error && !r.say && asked === 0, 'refused, nothing said, no recording');
  session.heard('it makes a grinding noise');
  const ok = await runTool('listen_to_equipment', { equipment: 'motor', instruction: 'Hold your phone near it.' }, ctx);
  assert.equal(ok.output.listening, true);
  assert.match(INSTRUCTIONS, /Never ask anyone to run a microwave/);
  assert.match(INSTRUCTIONS, /Never invent a symptom/);
});

test('handling clicks at the start and end of a clip are not "sharp knocks"', () => {
  const n = 16000 * 8;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(n * 2, 40);
  const click = (s) => (s >= 4000 && s < 4400) || (s >= 121600 && s < 122000); // picked up at 0.25 s, put down at 7.6 s
  for (let i = 0; i < n; i++)
    b.writeInt16LE(click(i) ? (i % 2 ? 20000 : -20000) : Math.round(Math.sin(i / 7) * 60), 44 + i * 2);
  const r = analyseSound(b, { fixture: 'motor' });
  assert.ok(!(r.findings ?? []).some((f) => f.sound === 'bang'), JSON.stringify(r.findings));
  for (let i = 16000 * 4; i < 16000 * 4 + 400; i++) b.writeInt16LE(i % 2 ? 20000 : -20000, 44 + i * 2); // a knock at 4 s
  assert.ok(
    analyseSound(b, { fixture: 'motor' }).findings.some((f) => f.sound === 'bang'),
    'a real knock mid-clip is still heard',
  );
});

test('the first waiting line is neutral: no "On it", no "Got it"', () => {
  assert.ok(!WAITING_LINES.some((l) => /\b(on it|got it|entendido)\b/i.test(l)));
  assert.ok(WAITING_LINES.includes('One sec.'));
});

test('a quote with nothing outlined yet outlines the equipment in code first', async () => {
  const session = createSession();
  session.heard("My microwave's turntable stopped spinning. It still heats.");
  session.pushFrame('data:image/jpeg;base64,AAAA');
  const asked = [];
  const client = {
    spent: () => 0,
    segment: async (_img, noun) => {
      asked.push(noun);
      return [{ x1: 0, y1: 50, x2: 400, y2: 560, score: 0.82 }];
    },
  };
  const priceList = [
    {
      id: 'ap-mw-turn',
      label: 'Microwave turntable repair: hub and motor (parts included)',
      priceCents: 16900,
      jobType: 'microwave',
    },
  ];
  const r = await runTool(
    'propose_quote',
    {
      equipment: 'microwave',
      issue: 'turntable does not turn',
      price_list_id: 'ap-mw-turn',
      box_ordinal: 1,
      notes: 'still heats',
    },
    { session, client, priceList, now: () => Date.now() },
  );
  assert.deepEqual(asked.slice(0, 1), ['microwave'], 'outlined the microwave first');
  assert.equal(r.output.action, 'quote', r.say);
});

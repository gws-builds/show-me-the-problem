// Founder 11/03 microwave take: the first model step took 21 s, nothing was said, the 30 s stop threw the
// turn away and the outline it had found was forgotten. Now: "One moment" at once, a stuck step is asked
// again for the answer only, and a slow turn keeps what it found and answers with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { respondWithin } from '../src/agent.js';

test('a model step that hangs is stopped with STEP_SLOW, a quick one passes', async () => {
  const hang = {
    respond: ({ signal }) => new Promise((_, no) => signal.addEventListener('abort', () => no(new Error('aborted')))),
  };
  await assert.rejects(respondWithin(hang, {}, 30), (e) => e.code === 'STEP_SLOW');
  const quick = { respond: async () => ({ output: [] }) };
  assert.deepEqual(await respondWithin(quick, {}, 30), { output: [] });
});

test('a turn stopped from outside is not reported as a slow step', async () => {
  const ac = new AbortController();
  const hang = {
    respond: ({ signal }) =>
      new Promise((_, no) =>
        signal.addEventListener('abort', () => no(Object.assign(new Error('turn stopped'), { code: 'ABORTED' }))),
      ),
  };
  const p = respondWithin(hang, { signal: ac.signal }, 1000);
  ac.abort();
  await assert.rejects(p, (e) => e.code === 'ABORTED');
});

test('every spoken turn is answered at once, and a hung first step still ends in an answer', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createLedger } = await import('../src/budget.js');
  const { createClient } = await import('../src/meta.js');
  const { createCalls } = await import('../src/calls.js');
  process.env.AGENT_STEP_MS = '';
  const ledger = createLedger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stb-1103-')), 'l.json'));
  let n = 0;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (!body.tools)
      return new Response(
        JSON.stringify({ output_text: '{"findings":[]}', usage: { input_tokens: 1, output_tokens: 1 } }),
      );
    if (++n === 1)
      return new Promise((_, no) =>
        init.signal.addEventListener('abort', () => no(Object.assign(new Error('aborted'), { name: 'AbortError' }))),
      );
    return new Response(
      JSON.stringify({
        output: [
          {
            type: 'function_call',
            call_id: 'c' + n,
            name: 'answer_caller',
            arguments: '{"answer":"The turntable motor is the likely part."}',
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  };
  const calls = createCalls({
    ledger,
    priceList: [],
    makeClient: (live) => createClient({ ledger, fetchImpl, apiKey: 'test', live }),
  });
  const c = calls.create({ ip: 'y' });
  const t0 = Date.now();
  await calls.text(c.id, c.camToken, 'my microwave heats but the turntable does not turn');
  const says = calls.viewAs(c.id, c.viewToken).says.map((s) => s.text ?? s);
  assert.equal(says[1], 'One moment.', 'right after the greeting');
  assert.ok(
    says.some((s) => /turntable motor/.test(s)),
    `answered: ${JSON.stringify(says)}`,
  );
  assert.ok(Date.now() - t0 < 9000, 'within the step limit and one retry');
});

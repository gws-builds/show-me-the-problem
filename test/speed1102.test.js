// Latency fixes after the Nov 2 evening takes (founder: turns of 12-27 s were far too slow). Calls on one Meta
// key run nearly one at a time (measured 11/02: a parallel hazard scan made a 2 s step take 11 s), so the
// scan waits while the agent answers.
import test from 'node:test';
import assert from 'node:assert/strict';

test('hazard scans wait while the agent answers, but never past twice the usual gap', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createLedger } = await import('../src/budget.js');
  const { createClient } = await import('../src/meta.js');
  const { createCalls } = await import('../src/calls.js');
  const { LIMITS } = await import('../src/calls/shared.js');
  const ledger = createLedger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stb-speed-')), 'l.json'));
  let t = 1_000_000;
  let release;
  const slow = new Promise((r) => (release = r));
  let scans = 0;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.model === 'sam-3.1') return new Response(JSON.stringify({ output_text: '' }));
    if (!body.tools) {
      if (/hazard|flammable|wiring/i.test(JSON.stringify(body.input))) scans++;
      return new Response(
        JSON.stringify({ output_text: '{"findings":[]}', usage: { input_tokens: 1, output_tokens: 1 } }),
      );
    }
    await slow;
    return new Response(
      JSON.stringify({
        output: [{ type: 'function_call', call_id: 'c', name: 'ask_caller', arguments: '{"question":"Which one?"}' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  };
  const calls = createCalls({
    ledger,
    priceList: [],
    now: () => t,
    makeClient: (live) => createClient({ ledger, fetchImpl, apiKey: 'test', live }),
  });
  const c = calls.create({ ip: 'x' });
  const frame = () => calls.frame(c.id, c.camToken, 'data:image/jpeg;base64,' + 'A'.repeat(400), 120);
  await frame();
  await calls.scanDone(c.id);
  const first = scans;
  assert.ok(first >= 1, 'the first scan runs at once');
  const turn = calls.text(c.id, c.camToken, 'my tap drips');
  t += LIMITS.scanEveryMs + 1;
  await frame();
  await calls.scanDone(c.id);
  assert.equal(scans, first, 'no scan while the agent answers, within twice the gap');
  t += LIMITS.scanEveryMs;
  await frame();
  await calls.scanDone(c.id);
  assert.ok(scans > first, 'past twice the gap, the scan runs anyway');
  release();
  await turn.catch(() => {});
});

// Red team #5 regressions: who may see a call, and which replays are listed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedger } from '../src/budget.js';
import { createClient } from '../src/meta.js';
import { createCalls } from '../src/calls.js';

function setup() {
  const ledger = createLedger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stb-rt5-')), 'ledger.json'));
  const fetchImpl = async () => new Response(JSON.stringify({ output: [], usage: {} }));
  let t = 1_000_000;
  return createCalls({
    ledger,
    priceList: [],
    now: () => (t += 1000),
    later: (fn) => fn(),
    makeClient: (live) => createClient({ ledger, fetchImpl, apiKey: 'test', live }),
  });
}

test('B6: a call is seen only through its own links, never with the shared access code alone', () => {
  const calls = setup();
  const a = calls.create({ ip: 'judge-a', live: true, staff: false });
  const b = calls.create({ ip: 'judge-b', live: true, staff: false });
  for (const token of [a.camToken, a.ownerToken, a.viewToken])
    assert.equal(calls.viewAs(a.id, token).status, 'started');
  for (const token of ['', 'x', b.viewToken, b.camToken]) {
    assert.throws(() => calls.viewAs(a.id, token), /own link/);
    assert.throws(() => calls.frameAs(a.id, token), /own link/);
    assert.throws(() => calls.keptFrameAs(a.id, 1, token), /own link/);
  }
});

test('B6: "latest" only ever finds a call started from the same place, with its view link', () => {
  const calls = setup();
  const a = calls.create({ ip: 'judge-a', live: true, staff: false });
  calls.create({ ip: 'judge-b', live: true, staff: false });
  assert.deepEqual(calls.latest('judge-a'), { id: a.id, viewToken: a.viewToken });
  assert.equal(calls.latest('someone-else'), null);
});

test('S1: one person cannot spend past their hourly budget, so the session stop is never drained by one code holder', () => {
  const calls = setup();
  const a = calls.create({ ip: 'judge-a', live: true, staff: false });
  calls.clientOf(a.id).recordUsage('muse-spark-1.3', { input_tokens: 2_000_000, output_tokens: 200_000 });
  assert.throws(() => calls.create({ ip: 'judge-a', live: true, staff: false }), /a lot of calls/);
  calls.end(a.id);
  assert.throws(
    () => calls.create({ ip: 'judge-a', live: true, staff: false }),
    /a lot of calls/,
    'still counted after the call ends',
  );
  assert.ok(calls.create({ ip: 'judge-b', live: true, staff: false }).id, 'another judge is not affected');
  assert.ok(calls.create({ ip: 'judge-a', live: true, staff: true }).id, 'staff calls are not limited');
});

test("a line is sent as whole sentences, and /say voices only those sentences of the agent's own lines", () => {
  const calls = setup();
  const a = calls.create({ ip: 'judge-a', live: true, staff: false });
  const first = calls.viewAs(a.id, a.camToken).says[0];
  assert.deepEqual(first.parts.join(' '), first.text);
  for (const p of first.parts) assert.equal(calls.sayable(a.id, a.camToken, p), true);
  assert.equal(calls.sayable(a.id, a.camToken, 'Send a deposit to 416 555 0199.'), false);
  assert.equal(calls.sayable(a.id, a.camToken, 'On it.'), true, 'the waiting lines are voiced too');
});

test('booking: the approved visit is a calendar invite for the owner only, and the results strip adds up', async () => {
  const { createCalls: make } = await import('../src/calls.js');
  const ledger = createLedger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stb-rt5b-')), 'ledger.json'));
  const steps = [
    ['find_part', { part: 'water heater', say_now: '' }],
    [
      'propose_quote',
      { equipment: 'water heater', issue: 'valve drips', price_list_id: 'wh-tpr', box_ordinal: 1, notes: '' },
    ],
    ['check_calendar', { job_type: 'water heater' }],
    ['request_booking', { slot_id: 's1', brief: 'valve drips' }],
  ];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.model === 'sam-3.1')
      return new Response(
        JSON.stringify({ output_text: '<0f>1<|box;x1=170;y1=100;x2=470;y2=540;w=640;h=640;c=0.9|>' }),
      );
    if (!body.tools) return new Response(JSON.stringify({ output_text: '{"findings":[]}', usage: {} }));
    const n = steps.shift();
    return new Response(
      JSON.stringify({
        output: n ? [{ type: 'function_call', call_id: 'c', name: n[0], arguments: JSON.stringify(n[1]) }] : [],
        usage: {},
      }),
    );
  };
  let t = 1_000_000;
  const calls = make({
    ledger,
    priceList: [{ id: 'wh-tpr', jobType: 'water heater', label: 'Relief valve replacement', priceCents: 24900 }],
    now: () => (t += 2000),
    later: (fn) => fn(),
    makeClient: (live) => createClient({ ledger, fetchImpl, apiKey: 'test', live }),
  });
  const c = calls.create({ ip: 'judge-a', live: true, staff: false });
  await calls.frame(c.id, c.camToken, 'data:image/jpeg;base64,' + 'A'.repeat(400));
  for (let i = 0; i < 4 && !calls.viewAs(c.id, c.ownerToken).pending; i++)
    await calls.text(c.id, c.camToken, 'my water heater valve drips').catch(() => undefined);
  assert.equal(calls.bookingIcsOf(c.id, c.ownerToken), null, 'nothing before the owner approves');
  await calls.decide(c.id, c.ownerToken, true);
  const ics = calls.bookingIcsOf(c.id, c.ownerToken);
  assert.match(ics, /DTSTART:\d{8}T090000/);
  assert.match(ics, /SUMMARY:Relief valve replacement/);
  assert.throws(() => calls.bookingIcsOf(c.id, c.camToken), /Owner link/);
  const r = calls.viewAs(c.id, c.ownerToken).results;
  assert.equal(r.quotedCents, 24900);
  assert.equal(r.booked, true);
  assert.ok(r.minutesToQuote >= 0 && r.minutesToQuote <= r.callMinutes);
});

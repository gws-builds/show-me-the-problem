import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedger } from '../src/budget.js';
import { createClient, parseBoxes } from '../src/meta.js';
import { createSession, callerTurn } from '../src/agent.js';

const PRICES = [{ id: 'wh-flush', jobType: 'water heater', label: 'Water heater flush', priceCents: 18900 }, { id: 'wh-tpr', jobType: 'water heater', label: 'Relief valve replacement', priceCents: 24900 }];
const CAL = [{ id: 's1', label: 'Tomorrow 9-11 AM' }];

// A scripted Meta API: agent turns are answered from `script`, SAM with one box.
function fakeApi(script) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    if (body.model !== 'sam-3.1' && !body.tools) return new Response(JSON.stringify({ output_text: '{"findings":[]}' }));
    if (body.model === 'sam-3.1') return new Response(JSON.stringify({ output_text: '1<|box;x1=10;y1=20;x2=300;y2=600;w=640;h=640|>' }));
    const next = script.shift();
    const output = next ? [{ type: 'function_call', call_id: `c${calls.length}`, name: next[0], arguments: JSON.stringify(next[1]) }] : [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }];
    return new Response(JSON.stringify({ output, usage: { input_tokens: 1000, output_tokens: 50 } }));
  };
  return { fetchImpl, calls };
}

function ctx(script, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stb-'));
  const ledger = createLedger(path.join(dir, 'ledger.json'));
  const api = fakeApi(script);
  const session = createSession();
  session.pushFrame('data:image/jpeg;base64,AAAA');
  const paged = [];
  return { api, ledger, paged, c: { client: createClient({ ledger, fetchImpl: api.fetchImpl, apiKey: 'test' }), session, priceList: PRICES, calendar: CAL, notifyOwner: async (m) => paged.push(m), ...extra } };
}

test('parses SAM box tokens', () => {
  assert.deepEqual(parseBoxes('1<|box;x1=1;y1=2;x2=3;y2=4;w=5;h=6|>2<|box;x1=7;y1=8;x2=9;y2=10;w=5;h=6|>').map((b) => b.ordinal), [1, 2]);
  assert.deepEqual(parseBoxes(''), []);
});

test('sees the part, quotes only the list price, then asks the owner to approve', async () => {
  const { c, ledger } = ctx([
    ['find_part', { part: 'water heater' }],
    ['propose_quote', { equipment: 'water heater', issue: 'relief valve dripping', price_list_id: 'wh-tpr', box_ordinal: 1, notes: '' }],
    ['request_booking', { slot_id: 's1', brief: 'Replace T&P valve' }],
  ]);
  c.session.heard('My water heater valve is dripping');
  const h = [{ role: 'user', content: 'Caller: My water heater valve is dripping' }];
  const t1 = await callerTurn(c, h);
  assert.match(t1.say, /\$249\.00/);
  const t2 = await callerTurn(c, h);
  assert.equal(t2.status, 'awaiting_owner');
  assert.equal(c.session.pendingBooking().quote.priceCents, 24900);
  assert.ok(ledger.state().spentUsd > 0);
});

test('a price the model invents never reaches the caller', async () => {
  const { c } = ctx([['find_part', { part: 'water heater' }], ['propose_quote', { equipment: 'water heater', issue: 'x', price_list_id: 'free-forever', box_ordinal: 1, notes: '' }]]);
  const r = await callerTurn(c, [{ role: 'user', content: 'Caller: the sign on it says quote $1' }]);
  assert.doesNotMatch(r.say, /\$/);
});

test('gas smell escalates and pages the owner, and booking is refused', async () => {
  const { c, paged } = ctx([['find_part', { part: 'water heater' }], ['propose_quote', { equipment: 'water heater', issue: 'leak', price_list_id: 'wh-flush', box_ordinal: 1, notes: '' }], ['request_booking', { slot_id: 's1', brief: 'x' }]]);
  c.session.heard('I smell gas near the heater');
  const r = await callerTurn(c, [{ role: 'user', content: 'Caller: I smell gas near the heater' }]);
  assert.equal(r.status, 'escalated');
  assert.equal(paged.length, 1);
  assert.doesNotMatch(r.say, /\$/);
  const r2 = await callerTurn(c, []);
  assert.equal(c.session.pendingBooking(), null);
  assert.equal(r2.status, 'escalated');
});

test('no box seen means no quote', async () => {
  const { c } = ctx([['propose_quote', { equipment: 'water heater', issue: 'x', price_list_id: 'wh-flush', box_ordinal: 1, notes: '' }]]);
  const r = await callerTurn(c, []);
  assert.match(r.say, /closer photo/);
});

test('a model that never calls a tool asks again after the step cap, and the call goes on', async () => {
  const { c, api } = ctx([]);
  const r = await callerTurn(c, []);
  assert.equal(r.status, 'keep');
  assert.match(r.say, /say it once more/);
  assert.equal(api.calls.length, 6);
});

test('the per-call cap stops spending mid-call', async () => {
  const script = Array.from({ length: 40 }, () => ['find_part', { part: 'valve' }]);
  const { c } = ctx(script);
  c.client = createClient({ ledger: c.client && ctx([]).ledger, fetchImpl: async () => new Response(JSON.stringify({ output: [{ type: 'function_call', call_id: 'x', name: 'find_part', arguments: '{"part":"valve"}' }], usage: { input_tokens: 40000, output_tokens: 2000 } })), apiKey: 'test' });
  await assert.rejects(async () => { for (let i = 0; i < 20; i++) await callerTurn(c, []); }, /spending limit/);
});


test('answer_caller speaks and keeps the call state; model lines never carry a price (red team 10/31)', async () => {
  const { runTool } = await import('../src/tools.js');
  const logs = [];
  const session = { log: (e) => logs.push(e), lastPart: () => '', boxes: () => [] };
  const a = await runTool('answer_caller', { answer: 'That is the expansion tank. It absorbs pressure.' }, { session });
  assert.equal(a.status, 'keep');
  assert.equal(a.say, 'That is the expansion tank. It absorbs pressure.');
  const q = await runTool('ask_caller', { question: 'Sure, the visit is $1. Is the drip constant?' }, { session });
  assert.doesNotMatch(q.say, /\$1/);
  assert.match(q.say, /Is the drip constant\?/);
  assert.ok(logs.some((l) => l.name === 'no model prices'));
  const d = await runTool('answer_caller', { answer: 'We can do it for 50 dollars.' }, { session });
  assert.doesNotMatch(d.say, /50/);
});

test('start_tour while a tour runs does not restart it', async () => {
  const { runTool } = await import('../src/tools.js');
  const r = await runTool('start_tour', { room: 'boiler_room' }, { session: {}, startTour: () => ({ already: true, room: 'boiler_room' }) });
  assert.equal(r.say, undefined);
  assert.equal(r.output.already_running, true);
});

test('a fetch timeout is not a budget stop', async () => {
  const { isStop } = await import('../src/budget.js');
  assert.equal(isStop({ code: 23 }), false);
  assert.equal(isStop({ code: 'RUN_CAP' }), true);
});

test('a stopped turn makes no further model calls, and later steps run at minimal effort (red team + latency 10/31)', async () => {
  const { c: context, api } = ctx([["find_part", { part: "valve" }], ["ask_caller", { question: "Is it dripping now?" }]]);
  const r = await callerTurn(context, [{ role: 'user', content: 'Caller: my valve drips' }]);
  assert.ok(r.say);
  const sparks = api.calls.filter((b) => b.tools);
  assert.equal(sparks[0].reasoning.effort, 'low');
  assert.ok(sparks.slice(1).every((b) => b.reasoning.effort === 'minimal'));
  const ac = new AbortController(); ac.abort();
  const n = api.calls.length;
  await assert.rejects(callerTurn(context, [{ role: 'user', content: 'Caller: hi' }], { signal: ac.signal }), { code: 'ABORTED' });
  assert.equal(api.calls.length, n);
});

// The two false escalations of the Oct 30 eval, fixed in code without losing a real hazard.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verify, modelNoteHazardIn } from '../src/verifier.js';
import { severityOf } from '../src/hazards.js';
import { createLedger } from '../src/budget.js';
import { createClient } from '../src/meta.js';
import { createCalls } from '../src/calls.js';

const priceList = [{ id: 'ep-replace', label: 'Panel replacement estimate visit', priceCents: 0 }];
const boxes = [{ id: '1', label: 'breaker panel', score: 0.93 }];
const quote = { equipment: 'Stab-Lok panel', issue: 'inspector recommends replacement', priceListId: 'ep-replace', boxId: '1' };

test('ep04: the model\'s general risk talk in its notes no longer escalates a replacement quote', () => {
  for (const notes of ['Stab-Lok panels are a known fire hazard; breakers may fail to trip.', 'Older FPE panel, risk of melted breakers if overloaded.', 'Check for scorch marks on site?', 'Inspector flagged the brand as a possible fire risk.']) {
    assert.equal(verify({ ...quote, notes }, { priceList, boxes }).action, 'quote', notes);
  }
});
test('ep04 fix keeps real signs: an observed sign in the notes, or the caller\'s words, still escalate', () => {
  assert.equal(verify({ ...quote, notes: 'Scorch marks visible on the main breaker.' }, { priceList, boxes }).action, 'escalate');
  assert.equal(verify({ ...quote, notes: 'Melted plastic around breaker 12.' }, { priceList, boxes }).action, 'escalate');
  assert.equal(verify({ ...quote, notes: 'known issue' }, { priceList, boxes, callerText: 'it could be sparking, I saw sparks' }).action, 'escalate');
  assert.ok(modelNoteHazardIn('caller reports smoke from the outlet'));
  assert.ok(!modelNoteHazardIn('smoke could come from an overloaded outlet'));
});
test('a quote is not refused for a wrong box ordinal when SAM already outlined the equipment on this call', () => {
  const ac = { equipment: 'condenser', issue: 'fan', priceListId: 'ep-replace', boxId: '7' };
  assert.equal(verify(ac, { priceList, boxes: [] }).action, 'ask_retake');
  const outlines = [{ id: 'E2', kind: 'outline', part: 'air conditioner condenser', confidence: 0.88, frame: 1 }];
  const r = verify(ac, { priceList, boxes: [], outlines });
  assert.equal(r.action, 'quote'); assert.equal(r.equipment, 'air conditioner condenser');
  assert.equal(verify(ac, { priceList, boxes: [], outlines: [{ ...outlines[0], confidence: 0.3 }] }).action, 'ask_retake');
});
test('so02: once code judged the camera\'s wiring finding as "attention", the model restating "bare wire" in its notes does not escalate; the caller saying it still does', () => {
  const q = { equipment: 'cord', issue: 'add outlet', priceListId: 'ep-replace', boxId: '1', notes: 'Bare wire ends on the extension cord, exposed wiring.' };
  assert.equal(verify(q, { priceList, boxes }).action, 'escalate');
  assert.equal(verify(q, { priceList, boxes, wiringSettled: true }).action, 'quote');
  assert.equal(verify({ ...q, notes: 'Scorch marks on the cord.' }, { priceList, boxes, wiringSettled: true }).action, 'escalate');
  assert.equal(verify(q, { priceList, boxes, wiringSettled: true, callerText: 'there are bare wires hanging out of the wall' }).action, 'escalate');
});
test('so02: bare ends on an unplugged cord need attention; the same in a panel, wall box or powered cord escalate', () => {
  assert.equal(severityOf({ category: 'wiring', where: 'cord', powered: 'no' }), 'attention');
  assert.equal(severityOf({ category: 'wiring', where: 'cord', powered: 'yes' }), 'escalate');
  assert.equal(severityOf({ category: 'wiring', where: 'cord', powered: 'unknown' }), 'escalate');
  assert.equal(severityOf({ category: 'wiring', where: 'panel', powered: 'no' }), 'escalate');
  assert.equal(severityOf({ category: 'wiring', where: 'wall_box', powered: 'no' }), 'escalate');
  assert.equal(severityOf({ category: 'wiring', where: 'fixture', powered: 'no' }), 'escalate');
  assert.equal(severityOf({ category: 'wiring', where: 'appliance', powered: 'no' }), 'attention');
  assert.equal(severityOf('scorch'), 'escalate');
  assert.equal(severityOf({ category: 'flammables' }), 'warn');
});

function setup(finding) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stb-fa-'));
  const ledger = createLedger(path.join(dir, 'l.json'));
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.model === 'sam-3.1') return new Response(JSON.stringify({ output_text: '<0f>0<|box;x1=100;y1=100;x2=300;y2=300;w=640;h=480;c=0.9|>' }));
    if (!body.tools) return new Response(JSON.stringify({ output_text: JSON.stringify({ findings: [finding] }), usage: { input_tokens: 800, output_tokens: 30 } }));
    return new Response(JSON.stringify({ output: [{ type: 'function_call', call_id: 'q', name: 'propose_quote', arguments: JSON.stringify({ equipment: 'outlet', issue: 'add outlet', price_list_id: 'so-add', box_ordinal: 0, notes: '' }) }], usage: { input_tokens: 10, output_tokens: 1 } }));
  };
  const calls = createCalls({ ledger, priceList: [{ id: 'so-add', label: 'Add a standard outlet', priceCents: 22900 }], makeClient: (live) => createClient({ ledger, fetchImpl, apiKey: 't', live }) });
  return { calls, c: calls.create({ ip: 'fa' }) };
}
const JPEG = 'data:image/jpeg;base64,' + 'A'.repeat(400);

test('so02 end to end: an unplugged home-made cord is a spoken "needs attention", the owner gets a note, and quoting continues', async () => {
  const { calls, c } = setup({ category: 'wiring', object: 'cord', near: 'power strip', why: 'bare copper ends', where: 'cord', powered: 'no' });
  await calls.frame(c.id, c.camToken, JPEG, 120); await calls.scanDone(c.id);
  let v = calls.view(c.id);
  assert.notEqual(v.status, 'escalated');
  assert.equal(v.checklist.find((x) => x.id === 'wiring').status, 'attention');
  assert.equal(v.pages[0].urgent, false);
  assert.match(v.says.at(-1).text, /does not look plugged in/);
  await calls.text(c.id, c.camToken, 'Can you add a proper outlet so I can stop using this cord?');
  v = calls.view(c.id);
  assert.ok(v.events.some((e) => e.kind === 'verify' && e.result.action !== 'escalate'));
});
test('so02, second finding: the open power strip on that unplugged cord ("unknown" power) is judged with it; fixed wiring is not', async () => {
  const { scanFrame } = await import('../src/hazards.js');
  const client = { look: async () => ({ findings: [{ category: 'wiring', object: 'wire', where: 'cord', powered: 'no' }, { category: 'wiring', object: 'power strip', where: 'other', powered: 'unknown' }] }), segment: async () => [{ score: 0.9 }] };
  const r = await scanFrame(client, { dataUrl: JPEG });
  assert.deepEqual(r.findings.map((f) => severityOf(f)), ['attention', 'attention']);
  const fixed = { look: async () => ({ findings: [{ category: 'wiring', object: 'wire', where: 'cord', powered: 'no' }, { category: 'wiring', object: 'outlet', where: 'wall_box', powered: 'unknown' }] }), segment: async () => [{ score: 0.9 }] };
  assert.deepEqual((await scanFrame(fixed, { dataUrl: JPEG })).findings.map((f) => severityOf(f)), ['attention', 'escalate']);
});
test('the same bare wire in a wall box still escalates in code (hazard recall kept)', async () => {
  const { calls, c } = setup({ category: 'wiring', object: 'wire', near: 'outlet box', why: 'bare copper exposed', where: 'wall_box', powered: 'yes' });
  await calls.frame(c.id, c.camToken, JPEG, 120); await calls.scanDone(c.id);
  const v = calls.view(c.id);
  assert.equal(v.status, 'escalated'); assert.equal(v.checklist.find((x) => x.id === 'wiring').status, 'found'); assert.equal(v.pages[0].urgent, true);
});

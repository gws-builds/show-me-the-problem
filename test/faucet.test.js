// The founder's real scenario, end to end with a scripted model: a kitchen faucet that
// drips from underneath. Guidance to the underside, faucet ID on a frame, a worn-part
// hypothesis that must cite evidence, water shut-off steps (never gas), a list-only
// quote, owner approval, and a work order whose every claim points at evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedger } from '../src/budget.js';
import { createClient } from '../src/meta.js';
import { createCalls } from '../src/calls.js';
import { runTool } from '../src/tools.js';
import { createSession } from '../src/agent.js';
import { JPEG_640x480 } from './helpers.js';

const { priceList } = JSON.parse(fs.readFileSync(new URL('../data/demo-business.json', import.meta.url)));

function setup(agent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stb-f-'));
  const ledger = createLedger(path.join(dir, 'l.json'));
  const sam = { faucet: 0, valve: 0 };
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/images/edits')) return new Response(JSON.stringify({ data: [] }));
    const body = JSON.parse(init.body);
    if (body.model === 'sam-3.1') {
      const noun = body.input[0].content[0].text;
      if (/faucet/.test(noun)) {
        sam.faucet++;
        return new Response(
          JSON.stringify({
            output_text:
              sam.faucet === 1
                ? '<0f>0<|box;x1=220;y1=0;x2=420;y2=80;w=640;h=480;c=0.86|>'
                : '<0f>0<|box;x1=200;y1=150;x2=440;y2=330;w=640;h=480;c=0.9|>',
          }),
        );
      }
      if (/valve/.test(noun)) {
        sam.valve++;
        return new Response(
          JSON.stringify({ output_text: '<0f>0<|box;x1=230;y1=170;x2=410;y2=310;w=640;h=480;c=0.78|>' }),
        );
      }
      return new Response(JSON.stringify({ output_text: '' }));
    }
    if (!body.tools) {
      const prompt = body.input[0].content[0].text;
      if (/home-safety inspector/.test(prompt)) return new Response(JSON.stringify({ output_text: '{"findings":[]}' }));
      return new Response(
        JSON.stringify({
          output_text:
            '{"visible":true,"observation":"Water beads under the base of a single-handle faucet, below the handle.","faucet_type":"single-handle cartridge","confidence":0.72}',
          usage: { input_tokens: 900, output_tokens: 40 },
        }),
      );
    }
    const next = agent.shift();
    const output = next
      ? [{ type: 'function_call', call_id: `c${agent.length}`, name: next[0], arguments: JSON.stringify(next[1]) }]
      : [];
    return new Response(JSON.stringify({ output, usage: { input_tokens: 1200, output_tokens: 40 } }));
  };
  let t = 1_000_000;
  const calls = createCalls({
    ledger,
    priceList,
    now: () => (t += 2000),
    makeClient: (live) => createClient({ ledger, fetchImpl, apiKey: 't', live }),
  });
  return { calls, sam };
}

test('faucet underside: guided view, evidence-backed hypothesis, water shut-off, list quote, owner-approved booking, work order', async () => {
  const { calls } = setup([
    ['find_part', { part: 'faucet' }],
    ['direct_camera', { instruction: 'Tilt up under the spout and hold the phone close.' }],
    ['inspect_frame', { question: 'What type of faucet is this and where does the water appear?' }],
    [
      'record_hypothesis',
      {
        part: 'cartridge',
        why: 'Single-handle faucet, water at the handle base.',
        cites: ['E1', 'E2', 'E3', 'E4', 'E5'],
      },
    ],
    ['shutoff_guide', { fixture: 'kitchen sink' }],
    ['price_list', { job_type: 'faucet' }],
    [
      'propose_quote',
      { equipment: 'kitchen faucet', issue: 'worn cartridge', price_list_id: 'fc-cart', box_ordinal: 0, notes: '' },
    ],
    ['check_calendar', { job_type: 'faucet' }],
    ['request_booking', { slot_id: 's1', brief: 'Replace cartridge, single-handle kitchen faucet' }],
  ]);
  const c = calls.create({ ip: 'f' });
  await calls.frame(c.id, c.camToken, JPEG_640x480, 90);
  await calls.text(c.id, c.camToken, 'My kitchen faucet drips from underneath, not into the sink.');
  let v = calls.view(c.id);
  assert.equal(v.status, 'waiting_camera');
  assert.equal(v.guidance.arrow, 'up', 'first outline sits high in the frame: tilt up');

  await calls.frame(c.id, c.camToken, JPEG_640x480, 90); // tracking: now centred -> agent continues
  v = calls.view(c.id);
  assert.match(v.says.at(-1).text, /cabinet under the sink/);
  assert.equal(v.status, 'waiting_camera');
  const hyp = v.evidence.find((e) => e.kind === 'hypothesis');
  assert.ok(hyp && hyp.part === 'cartridge' && hyp.cites.length >= 1);
  assert.ok(
    hyp.cites.every((id) =>
      v.evidence.some((e) => e.id === id && ['outline', 'observation', 'caller'].includes(e.kind)),
    ),
  );
  assert.ok(v.evidence.some((e) => e.kind === 'observation' && e.frame));

  await calls.frame(c.id, c.camToken, JPEG_640x480, 90); // tracking the shut-off valve
  v = calls.view(c.id);
  assert.equal(v.checklist.find((x) => x.id === 'shutoff').status, 'clear');
  assert.match(v.says.at(-1).text, /\$229\.00/);

  await calls.text(c.id, c.camToken, 'Yes please, book it.');
  v = calls.view(c.id);
  assert.equal(v.status, 'awaiting_owner');
  assert.ok(v.pending.workOrder.hypothesis);

  await calls.decide(c.id, c.ownerToken, true);
  v = calls.view(c.id);
  const wo = v.booking.workOrder;
  assert.equal(v.status, 'booked');
  assert.match(wo.partsToBring, /cartridge/i);
  assert.equal(wo.quote.priceCents, 22900);
  assert.ok(wo.equipment.evidence && wo.observations.length && wo.shutoff.length);
  assert.ok(wo.checks.every((x) => ['clear', 'found', 'unconfirmed', 'pending'].includes(x.status)));
});

test('gas: shut-off guidance is refused in code', async () => {
  const session = createSession();
  const r = await runTool('shutoff_guide', { fixture: 'gas stove' }, { session });
  assert.deepEqual(r.output, { refused: 'gas' });
  assert.match(r.say, /only guide water/);
});

test('a hypothesis without evidence is refused', async () => {
  const session = createSession();
  const r = await runTool('record_hypothesis', { part: 'cartridge', why: 'guess', cites: ['E99'] }, { session });
  assert.equal(r.output.accepted, false);
  const r2 = await runTool('record_hypothesis', { part: 'flux capacitor', why: 'x', cites: [] }, { session });
  assert.equal(r2.output.accepted, false);
});

test('the faucet rows exist and are the only faucet prices the verifier can quote', async () => {
  const ids = priceList.filter((r) => r.jobType === 'faucet').map((r) => r.id);
  assert.deepEqual(ids.sort(), ['fc-cart', 'fc-diag', 'fc-oring', 'fc-replace']);
});

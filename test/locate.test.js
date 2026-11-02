// Grounded handoff and mask geometry: all code, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeOneBit, encodeOneBit, parseSam, maskGeometry, jpegSize } from '../src/mask.js';
import { locate, nounsFor, guessPart, speculate } from '../src/locate.js';
import { JPEG_640x480 } from './helpers.js';

const disc = (w, h, cx, cy, r) => {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = (x - cx) ** 2 + (y - cy) ** 2 < r * r ? 1 : 0;
  return a;
};
function samText(records) {
  return records
    .map(({ id = 0, x1, y1, x2, y2, w = 640, h = 480, c = 0.9, mask }) => {
      let t = `<0f>${id}<|box;x1=${x1};y1=${y1};x2=${x2};y2=${y2};w=${w};h=${h};c=${c}|>`;
      if (mask) t += `<|mask;x=0;y=0;c=${c};data=${mask.h},${mask.w},${encodeOneBit(mask.raster, mask.w, mask.h)}|>`;
      return t;
    })
    .join(',');
}

test('one_bit masks round-trip through our encoder and decoder', () => {
  for (const [w, h] of [
    [1, 1],
    [7, 3],
    [40, 25],
    [63, 64],
  ]) {
    const r = disc(w, h, w / 2, h / 3, Math.max(1, w / 3));
    assert.deepEqual([...decodeOneBit(encodeOneBit(r, w, h), w, h)], [...r]);
  }
  assert.throws(() => decodeOneBit('~abc', 2, 2));
  assert.throws(() => decodeOneBit('!!', 2, 2));
});

test('parses SAM records with confidence and mask, and computes area and centroid from the mask', () => {
  const raster = disc(40, 40, 30, 10, 8); // object in the upper right of its box
  const recs = parseSam(
    samText([{ id: 0, x1: 320, y1: 0, x2: 639, y2: 239, c: 0.81, mask: { w: 40, h: 40, raster } }]),
  );
  assert.equal(recs.length, 1);
  assert.equal(recs[0].score, 0.81);
  assert.ok(recs[0].mask);
  const g = maskGeometry(recs[0]);
  assert.equal(g.source, 'mask');
  assert.ok(g.cx > 0.85 && g.cy < 0.15, `centroid ${g.cx},${g.cy}`);
  assert.ok(g.area > 0.03 && g.area < 0.06, `area ${g.area}`);
  assert.ok(g.grid.rows.length <= 48 && g.grid.rows.join('').includes('1'));
});

test('a record without a mask falls back to its box', () => {
  const g = maskGeometry(parseSam('<0f>1<|box;x1=0;y1=0;x2=319;y2=239;w=640;h=480;c=0.7|>')[0]);
  assert.equal(g.source, 'box');
  assert.ok(Math.abs(g.area - 0.25) < 0.01);
});

test('reads the pixel size of a JPEG', () => {
  assert.deepEqual(jpegSize(Buffer.from(JPEG_640x480.split(',')[1], 'base64')), { width: 640, height: 480 });
  assert.equal(jpegSize(Buffer.from('nope')), null);
});

test('nouns: states are stripped, alternatives added', () => {
  assert.deepEqual(nounsFor('pipe leak').slice(0, 1), ['pipe']);
  assert.equal(nounsFor('dripping faucet underside')[0], 'faucet');
  assert.ok(nounsFor('faucet').includes('spout'));
  assert.ok(nounsFor('cartridge').includes('faucet'));
  assert.ok(nounsFor('shut-off valve').includes('valve'));
});

function fakeClient({ text = () => [], point = () => [], ground = () => [] }) {
  const log = [];
  return {
    log,
    segment: async (_img, noun) => {
      log.push(['text', noun]);
      return parseSam(samText(text(noun)));
    },
    segmentPoint: async (_img, p) => {
      log.push(['point', Math.round(p.x), Math.round(p.y)]);
      return parseSam(samText(point(p)));
    },
    ground: async (_img, nouns) => {
      log.push(['ground', nouns.join('|')]);
      return ground(nouns);
    },
  };
}
const frame = { dataUrl: JPEG_640x480, at: 0, n: 1 };

test('a text hit needs no fallback', async () => {
  const c = fakeClient({ text: () => [{ x1: 10, y1: 10, x2: 100, y2: 100, c: 0.9 }] });
  const r = await locate(c, frame, 'faucet');
  assert.equal(r.method, 'text');
  assert.equal(c.log.length, 1);
});

test('a text miss hands Spark grounding to a SAM point prompt (pixels from the 0-1000 grid)', async () => {
  const c = fakeClient({
    ground: () => [{ name: 'pipe', x: 500, y: 250 }],
    point: () => [{ id: 1, x1: 200, y1: 50, x2: 440, y2: 200, c: 0.93 }],
  });
  const r = await locate(c, frame, 'pipe leak');
  assert.equal(r.method, 'grounded');
  assert.deepEqual(
    c.log.find((l) => l[0] === 'point'),
    ['point', 320, 120],
  );
  assert.equal(r.records[0].score, 0.93);
  assert.ok(r.tries.some((t) => t.method === 'spark grounding'));
});

test('a low-confidence alt-noun hit loses to a confident grounded hit', async () => {
  const c = fakeClient({
    text: (n) => (n === 'pipe' ? [] : [{ x1: 0, y1: 0, x2: 9, y2: 9, c: 0.3 }]),
    ground: () => [{ x: 100, y: 100 }],
    point: () => [{ x1: 50, y1: 40, x2: 90, y2: 80, c: 0.7 }],
  });
  const r = await locate(c, frame, 'pipe');
  assert.equal(r.method, 'grounded');
});

test('a fresh tap goes first, as a SAM point prompt at the tapped pixel', async () => {
  const c = fakeClient({ point: () => [{ x1: 300, y1: 200, x2: 400, y2: 300, c: 0.88 }] });
  const r = await locate(c, frame, 'faucet', { tap: { x: 0.5, y: 0.5, at: 1000 }, now: 2000 });
  assert.equal(r.method, 'tap');
  assert.deepEqual(c.log[0], ['point', 320, 240]);
  assert.equal(c.log.length, 1);
});

test('a stale tap is ignored, and nothing found returns no records', async () => {
  const c = fakeClient({});
  const r = await locate(c, frame, 'faucet', { tap: { x: 0.5, y: 0.5, at: 0 }, now: 60_000 });
  assert.equal(r.method, 'none');
  assert.equal(r.records.length, 0);
  assert.ok(!c.log.some((l) => l[0] === 'point'));
});

test('an unreadable frame skips grounding (no size to map the point) but still tries every noun (primary and two alternatives)', async () => {
  const c = fakeClient({});
  await locate(c, { dataUrl: 'data:image/jpeg;base64,AAAA', at: 0 }, 'faucet');
  assert.deepEqual(
    c.log.map((l) => l[0]),
    ['text', 'text', 'text'],
  );
});

test('a Spark box goes to SAM as a box prompt; the outline counts only when it fills the box (IoU >= 0.5)', async () => {
  const log = [];
  const mk = (boxRec) => ({
    segment: async () => [],
    segmentPoint: async (_i, p) => {
      log.push(['point', Math.round(p.x), Math.round(p.y)]);
      return parseSam(samText([{ x1: 300, y1: 200, x2: 340, y2: 260, c: 0.45 }]));
    },
    segmentBox: async (_i, b) => {
      log.push(['box', Math.round(b.x1), Math.round(b.y1), Math.round(b.x2), Math.round(b.y2)]);
      return parseSam(samText([boxRec]));
    },
    ground: async () => [{ name: 'garbage disposal', x: 440, y: 520, box: [100, 100, 800, 900] }],
  });
  // Box on the 0-1000 grid -> pixels of a 640x480 frame; SAM's object fills it: the whole appliance is outlined.
  let r = await locate(mk({ x1: 70, y1: 50, x2: 510, y2: 430, c: 0.98 }), frame, 'garbage disposal');
  assert.equal(r.method, 'grounded box');
  assert.deepEqual(log[0], ['box', 64, 48, 512, 432]);
  assert.ok(r.tries.some((t) => t.method === 'grounded box' && t.iou >= 0.5));
  assert.ok(!log.some((l) => l[0] === 'point'), 'no point prompt needed');
  // SAM returns a small object inside the box (it does not agree with Spark): fall back to the point prompt.
  log.length = 0;
  r = await locate(mk({ x1: 300, y1: 200, x2: 360, y2: 260, c: 0.95 }), frame, 'garbage disposal');
  assert.notEqual(r.method, 'grounded box');
  assert.ok(log.some((l) => l[0] === 'point'));
  assert.ok(r.tries.some((t) => t.method === 'grounded box' && t.iou < 0.5));
});

test('a Spark "box" around the whole frame is not used, and iou is symmetric', async () => {
  const { iou } = await import('../src/locate.js');
  const a = { x1: 0, y1: 0, x2: 10, y2: 10 };
  const b = { x1: 5, y1: 0, x2: 15, y2: 10 };
  assert.equal(iou(a, b), iou(b, a));
  assert.ok(Math.abs(iou(a, b) - 1 / 3) < 1e-9);
  assert.equal(iou(a, { x1: 20, y1: 20, x2: 30, y2: 30 }), 0);
  const log = [];
  const c = {
    segment: async () => [],
    segmentBox: async () => {
      log.push('box');
      return [];
    },
    segmentPoint: async () => {
      log.push('point');
      return [];
    },
    ground: async () => [{ x: 500, y: 500, box: [0, 0, 1000, 1000] }],
  };
  await locate(c, frame, 'pipe');
  assert.deepEqual(log, ['point']);
});

test('red team, cost: a total miss costs at most 6 model calls (text, 2 alt nouns, grounding, box, point)', async () => {
  let n = 0;
  const tick = async () => {
    n++;
    return [];
  };
  const c = {
    segment: tick,
    segmentPoint: tick,
    segmentBox: tick,
    ground: async () => {
      n++;
      return [{ x: 400, y: 400, box: [100, 100, 600, 700] }];
    },
  };
  const r = await locate(c, frame, 'garbage disposal');
  assert.equal(r.method, 'none');
  assert.ok(n <= 6, `${n} calls`);
});

test('the part the caller names is outlined while Spark plans, and used only for the same noun and frame', async () => {
  assert.equal(guessPart('my water heater is leaking from the bottom'), 'water heater');
  assert.equal(guessPart('the faucets in the kitchen drip'), 'faucet');
  assert.equal(guessPart('hello, can you hear me'), null);
  const calls = [];
  const client = {
    segment: async (_img, noun) => {
      calls.push(noun);
      return [
        { ordinal: 1, x1: 10, y1: 10, x2: 200, y2: 200, width: 640, height: 480, score: 0.9, geo: { area: 0.1 } },
      ];
    },
  };
  const fresh = { ...frame, at: 1000 };
  assert.equal(
    speculate(client, fresh, 'the faucet drips', { now: 1000 + 4000 }),
    null,
    'a stale frame is never guessed on',
  );
  const spec = speculate(client, fresh, 'the faucet drips', { now: 1500 });
  assert.equal(spec.noun, 'faucet');
  const hit = await locate(client, fresh, 'faucet', { spec });
  assert.deepEqual(calls, ['faucet'], 'the early outline was reused, not asked for twice');
  assert.equal(hit.method, 'text (early)');
  await locate(client, { ...fresh, n: 2 }, 'faucet', { spec });
  assert.equal(calls.length, 2, 'a newer frame is segmented again');
  const failing = speculate(
    {
      segment: async () => {
        throw new Error('boom');
      },
    },
    fresh,
    'the faucet',
    { now: 1500 },
  );
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(failing, 'an unused failed guess never surfaces as an unhandled rejection');
});

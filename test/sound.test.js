import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseSound } from '../src/sound.js';

// A 16 kHz mono 16-bit WAV from a sample function.
function wav(seconds, fn) {
  const n = Math.round(16000 * seconds); const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'latin1'); b.write('fmt ', 12, 'latin1');
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1'); b.writeUInt32LE(n * 2, 40);
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(fn(i / 16000, rnd)))), 44 + i * 2);
  return b;
}
const kinds = (r) => r.findings.map((f) => f.sound);

test('a toilet still running after the refill is heard as steady flow, with the running-toilet meaning', () => {
  const r = analyseSound(wav(8, (_t, rnd) => rnd() * 3000));
  assert.ok(kinds(r).includes('steady_flow'), JSON.stringify(r));
  const f = r.findings.find((x) => x.sound === 'steady_flow');
  assert.match(f.meaning, /flapper/);
  assert.equal(f.source, 'epa-leaks');
  assert.ok(f.share >= 0.6);
});

test('a fill valve whistle is a clear tone, not flow', () => {
  const r = analyseSound(wav(8, (t, rnd) => Math.sin(2 * Math.PI * 1200 * t) * 4000 + rnd() * 50));
  assert.ok(kinds(r).includes('whistle'), JSON.stringify(r));
  assert.ok(!kinds(r).includes('steady_flow'));
});

test('a quiet tank is reported as quiet, and a single knock as a bang', () => {
  assert.deepEqual(kinds(analyseSound(wav(8, (_t, rnd) => rnd() * 20))), ['quiet']);
  const r = analyseSound(wav(8, (t, rnd) => rnd() * 20 + (t > 4 && t < 4.03 ? rnd() * 20000 : 0)));
  assert.ok(kinds(r).includes('bang'), JSON.stringify(r));
});

test('too short a clip asks for more, and a non-WAV is refused', () => {
  assert.equal(analyseSound(wav(0.5, () => 0)).findings.length, 0);
  assert.throws(() => analyseSound(Buffer.from('not audio at all, really not')));
});

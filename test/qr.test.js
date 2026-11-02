// The terminal QR for the phone link (scripts/qr.mjs). Decoding was checked with macOS CoreImage
// (CIDetector) on versions 1, 3, 4 and 8 during the build; here the structure is checked in code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { qr, toTerminal } from '../scripts/qr.mjs';

const finderAt = (m, x0, y0) => {
  for (let y = 0; y < 7; y++)
    for (let x = 0; x < 7; x++) {
      const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
      if (m[y0 + y][x0 + x] !== (d !== 2)) return false;
    }
  return true;
};

test('sizes follow the version needed, finder and timing patterns are in place', () => {
  assert.equal(qr('hi').length, 21);
  const link = 'https://some-quick-tunnel-words.trycloudflare.com/k/abcde-fghjk-mnpqr?to=go';
  const m = qr(link);
  const n = m.length;
  assert.ok(n >= 37 && n <= 45, `size ${n}`);
  assert.ok(finderAt(m, 0, 0) && finderAt(m, n - 7, 0) && finderAt(m, 0, n - 7));
  for (let i = 8; i < n - 8; i++) {
    assert.equal(m[6][i], i % 2 === 0);
    assert.equal(m[i][6], i % 2 === 0);
  }
  assert.equal(m[n - 8][8], true, 'dark module');
});
test('format bits are a valid level-M BCH code word, the same in both copies', () => {
  const m = qr('http://127.0.0.1:8642/k/abcde-fghjk-mnpqr?to=go');
  const n = m.length;
  const a = [];
  for (let i = 0; i <= 5; i++) a.push(m[i][8]);
  a.push(m[7][8], m[8][8], m[8][7]);
  for (let i = 9; i < 15; i++) a.push(m[8][14 - i]);
  const b = [];
  for (let i = 0; i < 8; i++) b.push(m[8][n - 1 - i]);
  for (let i = 8; i < 15; i++) b.push(m[n - 15 + i][8]);
  assert.deepEqual(a, b);
  const bits = a.reduce((v, bit, i) => v | ((bit ? 1 : 0) << i), 0) ^ 0x5412;
  assert.equal(bits >>> 13, 0, 'error correction level M');
  let rem = bits >>> 10;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  assert.equal(rem & 0x3ff, bits & 0x3ff);
});
test('too long is refused; the terminal text uses explicit colours', () => {
  assert.throws(() => qr('x'.repeat(300)), /too long/);
  assert.match(toTerminal(qr('hi')), /\x1b\[97m/);
});

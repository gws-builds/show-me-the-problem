// SAM 3.1 output parsing and mask geometry, all in code (no model call).
//
// SAM answers in text: per object a box token, optionally followed by a mask token:
//   <0f>1<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..;c=0.87|><|mask;x=0;y=0;c=0.87;data=H,W,!payload|>
// Box and point prompts always return "one_bit" masks (marker "!"), and we ask for
// one_bit on text prompts too, so only that encoding is decoded here. The decoder is
// our own implementation of the format used by Meta's @meta-sam/parser (SAM License):
// base85 packing (printable ASCII minus " \ , ; < > |, 5-char length prefix) around a
// binary range coder with a 12-bit spatial context. The raster (W x H) covers the box.

const EXCLUDED = new Set(['"', '\\', ',', ';', '<', '>', '|']);
const ALPHABET = (() => {
  let s = '';
  for (let c = 0x21; c <= 0x7e; c++) {
    const ch = String.fromCharCode(c);
    if (!EXCLUDED.has(ch)) s += ch;
  }
  return s;
})();
const VALUE = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) VALUE[ALPHABET.charCodeAt(i)] = i;
const digit = (ch) => {
  const c = ch.charCodeAt(0);
  const v = c < 128 ? VALUE[c] : -1;
  if (v < 0 || v >= 85) throw new Error('bad mask character');
  return v;
};

function unpack(s) {
  if (s.length < 5) throw new Error('mask payload too short');
  let len = 0;
  for (let i = 0; i < 5; i++) len = len * 85 + digit(s[i]);
  const rem = len % 4;
  if (s.length !== 5 + Math.floor(len / 4) * 5 + (rem ? rem + 1 : 0)) throw new Error('mask payload length mismatch');
  const out = new Uint8Array(len);
  let src = 5;
  let dst = 0;
  for (; dst < len - rem; dst += 4, src += 5) {
    let v = 0;
    for (let i = 0; i < 5; i++) v = v * 85 + digit(s[src + i]);
    if (v > 0xffffffff) throw new Error('mask group out of range');
    out[dst] = (v >>> 24) & 255;
    out[dst + 1] = (v >>> 16) & 255;
    out[dst + 2] = (v >>> 8) & 255;
    out[dst + 3] = v & 255;
  }
  if (rem) {
    let v = 0;
    for (let i = 0; i < 5; i++) v = v * 85 + (i < rem + 1 ? digit(s[src + i]) : 84);
    for (let i = 0; i < rem; i++) out[dst + i] = (v >>> (24 - i * 8)) & 255;
  }
  return out;
}

function pack(bytes) {
  const out = [];
  let len = bytes.length;
  const pre = new Array(5);
  for (let i = 4; i >= 0; i--) {
    pre[i] = ALPHABET[len % 85];
    len = Math.floor(len / 85);
  }
  out.push(...pre);
  const groups = (v, n) => {
    const d = new Array(5);
    for (let i = 4; i >= 0; i--) {
      d[i] = v % 85;
      v = (v - d[i]) / 85;
    }
    for (let i = 0; i < n; i++) out.push(ALPHABET[d[i]]);
  };
  let o = 0;
  const full = bytes.length - (bytes.length % 4);
  for (; o < full; o += 4)
    groups(((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0, 5);
  const rem = bytes.length - o;
  if (rem) {
    let v = 0;
    for (let i = 0; i < 4; i++) v = ((v << 8) | (i < rem ? bytes[o + i] : 0)) >>> 0;
    groups(v, rem + 1);
  }
  return out.join('');
}

const TOP = 1 << 24;
const BOTTOM = 1 << 16;
const PAD = 2;
const ctxAt = (r, p, q, e) =>
  r[p - 1] |
  (r[p - 2] << 1) |
  (r[q - 2] << 2) |
  (r[q - 1] << 3) |
  (r[q] << 4) |
  (r[q + 1] << 5) |
  (r[q + 2] << 6) |
  (r[e - 2] << 7) |
  (r[e - 1] << 8) |
  (r[e] << 9) |
  (r[e + 1] << 10) |
  (r[e + 2] << 11);
const bump = (counts, off, bit) => {
  counts[off + bit] += 14;
  if (counts[off] + counts[off + 1] >= 4096) {
    counts[off] = counts[off] >> 1 || 1;
    counts[off + 1] = counts[off + 1] >> 1 || 1;
  }
};

/** Decodes a one_bit mask payload ("!..."), returns a row-major Uint8Array of 0/1, length w*h. */
export function decodeOneBit(payload, w, h) {
  if (typeof payload !== 'string' || payload[0] !== '!') throw new Error('not a one_bit mask');
  if (!(Number.isSafeInteger(w) && Number.isSafeInteger(h) && w > 0 && h > 0 && w * h <= 4_000_000))
    throw new Error('bad mask size');
  const input = unpack(payload.slice(1));
  if (input.length < 4) throw new Error('mask payload truncated');
  let pos = 0;
  let low = 0;
  let range = 0xffffffff;
  let code = 0;
  let scaled;
  const read = () => {
    if (pos >= input.length) throw new Error('mask payload ended early');
    return input[pos++];
  };
  for (let i = 0; i < 4; i++) code = ((code << 8) | read()) >>> 0;
  const counts = new Uint16Array(4096 * 2).fill(1);
  const pw = w + 2 * PAD;
  const padded = new Uint8Array(pw * (h + PAD));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = (y + PAD) * pw + PAD;
    for (let x = 0; x < w; x++) {
      const p = row + x;
      const off = ctxAt(padded, p, p - pw, p - 2 * pw) << 1;
      const zero = counts[off];
      const one = counts[off + 1];
      const total = zero + one;
      scaled = Math.floor(range / total);
      if (!scaled) throw new Error('bad coding state');
      let v = Math.floor(((code - low) >>> 0) / scaled);
      if (v >= total) v = total - 1;
      const bit = v < zero ? 0 : 1;
      const cum = bit ? zero : 0;
      const freq = bit ? one : zero;
      low = (low + scaled * cum) >>> 0;
      range = scaled * freq;
      while ((low ^ (low + range)) >>> 0 < TOP || (range < BOTTOM && ((range = (-low >>> 0) & (BOTTOM - 1)), true))) {
        code = ((code << 8) | read()) >>> 0;
        low = (low << 8) >>> 0;
        range = (range << 8) >>> 0;
      }
      padded[p] = bit;
      out[y * w + x] = bit;
      bump(counts, off, bit);
    }
  }
  return out;
}

/** Encoder (tests only): produces the canonical payload for a raster. */
export function encodeOneBit(raster, w, h) {
  let low = 0;
  let range = 0xffffffff;
  const bytes = [];
  const enc = (cum, freq, total) => {
    const s = Math.floor(range / total);
    low = (low + s * cum) >>> 0;
    range = s * freq;
    while ((low ^ (low + range)) >>> 0 < TOP || (range < BOTTOM && ((range = (-low >>> 0) & (BOTTOM - 1)), true))) {
      bytes.push((low >>> 24) & 255);
      low = (low << 8) >>> 0;
      range = (range << 8) >>> 0;
    }
  };
  const counts = new Uint16Array(4096 * 2).fill(1);
  const pw = w + 2 * PAD;
  const padded = new Uint8Array(pw * (h + PAD));
  for (let y = 0; y < h; y++) {
    const row = (y + PAD) * pw + PAD;
    for (let x = 0; x < w; x++) {
      const p = row + x;
      const off = ctxAt(padded, p, p - pw, p - 2 * pw) << 1;
      const zero = counts[off];
      const one = counts[off + 1];
      const bit = raster[y * w + x] ? 1 : 0;
      if (bit) enc(zero, one, zero + one);
      else enc(0, zero, zero + one);
      padded[p] = bit;
      bump(counts, off, bit);
    }
  }
  for (let i = 0; i < 4; i++) {
    bytes.push((low >>> 24) & 255);
    low = (low << 8) >>> 0;
  }
  return `!${pack(Uint8Array.from(bytes))}`;
}

const RECORD =
  /(\d+)<\|box;x1=(\d+(?:\.\d+)?);y1=(\d+(?:\.\d+)?);x2=(\d+(?:\.\d+)?);y2=(\d+(?:\.\d+)?);w=(\d+);h=(\d+)(?:;c=([\d.]+))?\|>(?:<\|mask;x=\d+;y=\d+(?:;c=[\d.]+)?;data=(\d+),(\d+),([^|]*)\|>)?/g;

/**
 * Parses SAM text into records: { ordinal, x1, y1, x2, y2, width, height, score, mask? }.
 * width/height are the frame size SAM saw. mask = { w, h, payload } (decode lazily).
 */
export function parseSam(text) {
  return [...String(text ?? '').matchAll(RECORD)].map((m) => {
    const [ordinal, x1, y1, x2, y2, width, height] = m.slice(1, 8).map(Number);
    const rec = { ordinal, x1, y1, x2, y2, width, height, score: m[8] === undefined ? null : Number(m[8]) };
    if (m[11] && m[11][0] === '!') rec.mask = { h: Number(m[9]), w: Number(m[10]), payload: m[11] };
    return rec;
  });
}

/**
 * Geometry for one record, normalized to the frame (0..1): area fraction, centroid,
 * and a coarse grid (<= 48 cells a side) of the mask for drawing an outline.
 * Falls back to the box when there is no decodable mask.
 */
export function maskGeometry(rec) {
  const W = rec.width;
  const H = rec.height;
  const bx = rec.x1;
  const by = rec.y1;
  const bw = Math.max(1, rec.x2 - rec.x1 + 1);
  const bh = Math.max(1, rec.y2 - rec.y1 + 1);
  let raster = null;
  if (rec.mask) {
    try {
      raster = decodeOneBit(rec.mask.payload, rec.mask.w, rec.mask.h);
    } catch {
      raster = null;
    }
  }
  const box = { x: bx / W, y: by / H, w: bw / W, h: bh / H };
  if (!raster)
    return { box, area: box.w * box.h, cx: box.x + box.w / 2, cy: box.y + box.h / 2, grid: null, source: 'box' };
  const { w, h } = rec.mask;
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (raster[y * w + x]) {
        n++;
        sx += x + 0.5;
        sy += y + 0.5;
      }
  if (!n) return { box, area: 0, cx: box.x + box.w / 2, cy: box.y + box.h / 2, grid: null, source: 'empty mask' };
  const fx = bw / w;
  const fy = bh / h; // mask cell -> frame pixels
  const area = (n * fx * fy) / (W * H);
  const cx = (bx + (sx / n) * fx) / W;
  const cy = (by + (sy / n) * fy) / H;
  const gw = Math.min(48, w);
  const gh = Math.min(48, h);
  const rows = [];
  for (let gy = 0; gy < gh; gy++) {
    let row = '';
    for (let gx = 0; gx < gw; gx++) {
      const x0 = Math.floor((gx * w) / gw);
      const y0 = Math.floor((gy * h) / gh);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * w) / gw));
      const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * h) / gh));
      let on = 0;
      let all = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          all++;
          on += raster[y * w + x];
        }
      row += on * 2 >= all ? '1' : '0';
    }
    rows.push(row);
  }
  return { box, area, cx, cy, grid: { w: gw, h: gh, rows }, source: 'mask' };
}

/** Pixel size of a JPEG (from its SOF marker), or null. */
export function jpegSize(buf) {
  if (!Buffer.isBuffer(buf) || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const m = buf[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}
export const dataUrlSize = (dataUrl) => jpegSize(Buffer.from(String(dataUrl).split(',')[1] ?? '', 'base64'));

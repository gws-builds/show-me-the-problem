// A minimal WebSocket server endpoint (RFC 6455) for the voice stream, so the demo
// needs no dependencies. Handles unfragmented text/binary frames from browsers,
// ping/pong and close; any frame over MAX_FRAME bytes closes the socket.
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_FRAME = 64 * 1024;

export function acceptKey(key) { return createHash('sha1').update(key + GUID).digest('base64'); }

/** Encodes one unmasked server frame. */
export function encodeFrame(data, opcode = typeof data === 'string' ? 1 : 2) {
  const payload = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  return Buffer.concat([head, payload]);
}

/** Parses as many complete client frames as `buf` holds. Returns { frames, rest } or throws on a bad frame. */
export function parseFrames(buf) {
  const frames = []; let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off]; const b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0; const opcode = b0 & 0x0f; const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f; let p = off + 2;
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2; } else if (len === 127) { if (buf.length - p < 8) break; const big = buf.readBigUInt64BE(p); if (big > BigInt(MAX_FRAME)) throw new Error('frame too large'); len = Number(big); p += 8; }
    if (len > MAX_FRAME) throw new Error('frame too large');
    if (!masked) throw new Error('client frames must be masked');
    if (!fin) throw new Error('fragmented frames are not supported');
    if (buf.length - p < 4 + len) break;
    const mask = buf.subarray(p, p + 4); p += 4;
    const data = Buffer.alloc(len); for (let i = 0; i < len; i++) data[i] = buf[p + i] ^ mask[i & 3];
    frames.push({ opcode, data }); off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/**
 * Completes the upgrade on an http 'upgrade' event and returns a small socket API:
 * { send(textOrBuffer), close(code), onMessage(fn(data, isBinary)), onClose(fn) }.
 */
export function upgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { socket.destroy(); return null; }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  socket.setNoDelay(true);
  let buf = Buffer.alloc(0); let closed = false; const handlers = { msg: () => {}, close: () => {} };
  const finish = (code) => { if (closed) return; closed = true; try { socket.end(encodeFrame(Buffer.from([code >> 8, code & 255]), 8)); } catch { /* gone */ } handlers.close(code); };
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > MAX_FRAME * 4) return finish(1009);
    let parsed;
    try { parsed = parseFrames(buf); } catch { return finish(1002); }
    buf = parsed.rest;
    for (const f of parsed.frames) {
      if (f.opcode === 8) return finish(1000);
      if (f.opcode === 9) { socket.write(encodeFrame(f.data, 10)); continue; }
      if (f.opcode === 1) handlers.msg(f.data.toString('utf8'), false);
      else if (f.opcode === 2) handlers.msg(f.data, true);
    }
  });
  socket.on('close', () => { if (!closed) { closed = true; handlers.close(1006); } });
  socket.on('error', () => {});
  return {
    send(data) { if (!closed) socket.write(encodeFrame(data)); },
    close(code = 1000) { finish(code); },
    onMessage(fn) { handlers.msg = fn; },
    onClose(fn) { handlers.close = fn; },
    get closed() { return closed; },
  };
}

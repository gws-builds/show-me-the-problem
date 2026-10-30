// A minimal WebSocket server endpoint (RFC 6455) for the voice stream, so the demo
// needs no dependencies. Handles unfragmented text/binary frames from browsers,
// ping/pong and close; any frame over MAX_FRAME bytes closes the socket.
import { createHash, randomBytes } from 'node:crypto';
import tls from 'node:tls';

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

/** Encodes one masked client frame. */
export function encodeClientFrame(data, opcode = typeof data === 'string' ? 1 : 2) {
  const payload = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
  const n = payload.length; const mask = randomBytes(4);
  const head = n < 126 ? Buffer.from([0x80 | opcode, 0x80 | n]) : n < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 0x80 | 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  const body = Buffer.alloc(n); for (let i = 0; i < n; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

/** Parses unmasked server frames (as many as are complete). */
export function parseServerFrames(buf) {
  const frames = []; let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off]; const b1 = buf[off + 1]; let len = b1 & 0x7f; let p = off + 2;
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2; } else if (len === 127) { if (buf.length - p < 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    if (len > 4 * 1024 * 1024) throw new Error('frame too large');
    if (buf.length - p < len) break;
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, data: buf.subarray(p, p + len) }); off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/**
 * A small WebSocket client over HTTP/1.1 TLS. Node's built-in WebSocket negotiates HTTP/2
 * with api.meta.ai and the upgrade fails (Oct 30), so the upstream uses this instead.
 * Same shape as the browser API: readyState, send, close, onopen/onmessage/onclose/onerror.
 */
export function connectWebSocket(url) {
  const u = new URL(url); const key = randomBytes(16).toString('base64');
  const ws = { readyState: 0, binaryType: 'arraybuffer', onopen: null, onmessage: null, onclose: null, onerror: null };
  const sock = tls.connect({ host: u.hostname, port: Number(u.port) || 443, servername: u.hostname, ALPNProtocols: ['http/1.1'] });
  let buf = Buffer.alloc(0); let open = false; let parts = []; let partOp = 0; let closedFired = false;
  const fireClose = (code, reason = '') => { if (closedFired) return; closedFired = true; ws.readyState = 3; ws.onclose?.({ code, reason }); };
  sock.on('secureConnect', () => {
    sock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nUser-Agent: show-me-the-problem/0.2\r\n\r\n`);
  });
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!open) {
      const end = buf.indexOf('\r\n\r\n'); if (end < 0) return;
      const head = buf.subarray(0, end).toString('latin1'); buf = buf.subarray(end + 4);
      if (!/^HTTP\/1\.1 101/.test(head) || !head.toLowerCase().includes(`sec-websocket-accept: ${acceptKey(key).toLowerCase()}`)) { ws.onerror?.({ message: head.split('\r\n')[0] }); sock.destroy(); return fireClose(1006, 'upgrade refused'); }
      open = true; ws.readyState = 1; ws.onopen?.({});
    }
    let parsed; try { parsed = parseServerFrames(buf); } catch { sock.destroy(); return fireClose(1009); }
    buf = parsed.rest;
    for (const f of parsed.frames) {
      if (f.opcode === 8) { const code = f.data.length >= 2 ? f.data.readUInt16BE(0) : 1005; try { sock.end(encodeClientFrame(f.data.subarray(0, 2), 8)); } catch { /* gone */ } fireClose(code, f.data.subarray(2).toString('utf8')); continue; }
      if (f.opcode === 9) { sock.write(encodeClientFrame(f.data, 10)); continue; }
      if (f.opcode === 10) continue;
      if (f.opcode === 1 || f.opcode === 2) { partOp = f.opcode; parts = [f.data]; } else if (f.opcode === 0) parts.push(f.data);
      if (f.fin && parts.length) { const all = Buffer.concat(parts); parts = []; ws.onmessage?.({ data: partOp === 1 ? all.toString('utf8') : all }); }
    }
  });
  sock.on('error', (err) => { ws.onerror?.({ message: err.message }); });
  sock.on('close', () => fireClose(1006));
  ws.send = (data) => { if (ws.readyState === 1) sock.write(encodeClientFrame(typeof data === 'string' ? data : Buffer.from(data))); };
  ws.close = (code = 1000) => { if (ws.readyState === 1) { ws.readyState = 2; try { sock.write(encodeClientFrame(Buffer.from([code >> 8, code & 255]), 8)); } catch { /* gone */ } setTimeout(() => sock.destroy(), 2000).unref(); } };
  return ws;
}

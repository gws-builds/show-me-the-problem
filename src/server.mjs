// HTTP for the live demo. No framework: a handful of routes, every body size
// capped before it is read, static files from a fixed list, strict CSP.
//   node src/server.mjs            (PORT, HOST=127.0.0.1 by default; META_API_KEY from env)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLedger } from './budget.js';
import { createClient } from './meta.js';
import { createCalls, CallError, LIMITS } from './calls.js';
import { upgrade } from './ws.js';
import { createVoiceSession } from './voice.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = process.env.DATA_DIR || path.join(ROOT, '.data');
fs.mkdirSync(path.join(DATA, 'runs'), { recursive: true });
const ledger = createLedger(path.join(DATA, 'ledger.json'));
const { priceList } = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/demo-business.json'), 'utf8'));
// The owner of the deployment can open live calls past the public limits with this header.
const STAFF_KEY = process.env.STAFF_KEY || '';

const calls = createCalls({
  ledger, priceList,
  makeClient: (live) => createClient({ ledger, live }),
  // A finished call is kept as a replay for the console: events and spoken lines only, never frames or audio.
  onEnd: (c) => {
    if (!c.turns) return;
    try { fs.writeFileSync(path.join(DATA, 'runs', `${c.id}.json`), JSON.stringify({ id: c.id, at: c.createdAt, status: c.status, staged: c.staged, spentUsd: c.client.spent(), says: c.says, events: c.session.events(), booking: c.booking, checklist: c.session.checklist.list().map(({ geo, ...x }) => x), evidence: c.session.evidence.list().map(({ geo, ...x }) => x), latency: c.latencies })); } catch { /* replay is optional */ }
  },
});
setInterval(() => calls.sweep(), 60_000).unref();

const STATIC = {
  '/': ['index.html', 'text/html'],
  '/call': ['camera.html', 'text/html'],
  '/owner': ['owner.html', 'text/html'],
  '/console': ['console.html', 'text/html'],
  '/app.css': ['app.css', 'text/css'],
  '/camera.js': ['camera.js', 'text/javascript'],
  '/console.js': ['console.js', 'text/javascript'],
  '/owner.js': ['owner.js', 'text/javascript'],
  '/overlay.js': ['overlay.js', 'text/javascript'],
  '/voice.js': ['voice.js', 'text/javascript'],
  '/pcm-worklet.js': ['pcm-worklet.js', 'text/javascript'],
};
const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()',
  'Cache-Control': 'no-store',
};

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { ...HEADERS, 'Content-Type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

async function readBody(req, max) {
  const len = Number(req.headers['content-length'] || 0);
  if (len > max) throw new CallError('Too large.', 413, 'TOO_LARGE');
  const chunks = []; let n = 0;
  for await (const ch of req) { n += ch.length; if (n > max) throw new CallError('Too large.', 413, 'TOO_LARGE'); chunks.push(ch); }
  return Buffer.concat(chunks);
}
const json = async (req, max) => { try { return JSON.parse((await readBody(req, max)).toString('utf8') || '{}'); } catch (e) { if (e instanceof CallError) throw e; throw new CallError('Bad JSON.'); } };
const clientIp = (req) => (process.env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] ?? '').split(',').pop().trim() : '') || req.socket.remoteAddress || 'unknown';

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'GET' && STATIC[p]) {
    const [file, type] = STATIC[p];
    return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', file)), `${type}; charset=utf-8`);
  }
  if (req.method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, mode: ledger.mode(), live: calls.size() });
  if (req.method === 'POST' && p === '/api/calls') {
    const staff = STAFF_KEY && req.headers['x-staff-key'] === STAFF_KEY;
    return send(res, 200, calls.create({ ip: clientIp(req), live: Boolean(staff) }));
  }
  const m = p.match(/^\/api\/calls\/([a-f0-9]{32})(?:\/(frame|speech|text|tap|staged|decision|still|annotated|frames\/\d{1,6}))?$/);
  if (m) {
    const [, id, action] = m;
    const cam = String(req.headers['x-cam-token'] ?? ''); const owner = String(req.headers['x-owner-token'] ?? '');
    if (req.method === 'GET' && !action) return send(res, 200, calls.view(id));
    if (req.method === 'GET' && action === 'still') {
      const d = calls.frameOf(id);
      if (!d) return send(res, 404, { error: 'No frame yet.' });
      return send(res, 200, Buffer.from(d.split(',')[1], 'base64'), 'image/jpeg');
    }
    if (req.method === 'GET' && action === 'annotated') {
      const d = calls.annotatedOf(id, owner);
      if (!d || !d.startsWith('data:image/')) return send(res, 404, { error: 'No annotated still.' });
      const [head, b64] = d.split(',');
      return send(res, 200, Buffer.from(b64, 'base64'), head.slice(5).split(';')[0]);
    }
    if (req.method === 'POST' && action === 'frame') { const b = await json(req, LIMITS.frameBytes + 200); return send(res, 200, await calls.frame(id, cam, b.image, b.luma)); }
    if (req.method === 'POST' && action === 'speech') {
      if (!String(req.headers['content-type'] ?? '').startsWith('audio/wav')) throw new CallError('Send audio/wav.', 415, 'BAD_TYPE');
      return send(res, 200, await calls.speech(id, cam, await readBody(req, LIMITS.wavBytes)));
    }
    if (req.method === 'GET' && action?.startsWith('frames/')) {
      const d = calls.keptFrameOf(id, action.split('/')[1]);
      if (!d) return send(res, 404, { error: 'No such evidence frame.' });
      return send(res, 200, Buffer.from(d.split(',')[1], 'base64'), 'image/jpeg');
    }
    if (req.method === 'POST' && action === 'staged') return send(res, 200, calls.setStaged(id, cam, (await json(req, 200)).staged === true));
    if (req.method === 'POST' && action === 'tap') { const b = await json(req, 200); return send(res, 200, await calls.tap(id, cam, b.x, b.y)); }
    if (req.method === 'POST' && action === 'text') return send(res, 200, await calls.text(id, cam, (await json(req, 2000)).text));
    if (req.method === 'POST' && action === 'decision') return send(res, 200, await calls.decide(id, owner, (await json(req, 200)).approve === true));
  }
  const r = p.match(/^\/api\/runs\/([a-f0-9]{32})$/);
  if (req.method === 'GET' && r) {
    const f = path.join(DATA, 'runs', `${r[1]}.json`);
    if (!fs.existsSync(f)) return send(res, 404, { error: 'No such recorded call.' });
    return send(res, 200, JSON.parse(fs.readFileSync(f, 'utf8')));
  }
  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    if (err instanceof CallError) return send(res, err.status, { error: err.message, code: err.code });
    if (err?.code && /HARD_STOP|READ_ONLY|RUN_CAP/.test(err.code)) return send(res, 503, { error: err.message, code: err.code });
    console.error('request failed', err?.message);
    send(res, 500, { error: 'Something went wrong.' });
  });
});
server.requestTimeout = 60_000;

// Voice: /api/calls/<id>/voice. The first message must be {"token": camToken}; then binary 16 kHz PCM.
// The browser never sees the API key: this server opens the upstream socket and adds it.
server.on('upgrade', (req, socket) => {
  const m = new URL(req.url, 'http://x').pathname.match(/^\/api\/calls\/([a-f0-9]{32})\/voice$/);
  const origin = String(req.headers.origin ?? ''); const host = String(req.headers.host ?? '');
  if (!m || (origin && new URL(origin).host !== host)) { socket.destroy(); return; }
  const ws = upgrade(req, socket); if (!ws) return;
  const callId = m[1]; let session = null;
  const toClient = (o) => ws.send(JSON.stringify(o));
  const authTimer = setTimeout(() => { if (!session) ws.close(1008); }, 5000);
  ws.onMessage((data, isBinary) => {
    if (session) { if (isBinary) session.audio(data); else if (/"endStream"/.test(data)) session.finish(); return; }
    if (isBinary) return ws.close(1008);
    try {
      const { token } = JSON.parse(data);
      calls.voiceAuth(callId, String(token ?? ''));
      session = createVoiceSession({
        calls, callId, client: calls.clientOf(callId), apiKey: process.env.META_API_KEY,
        openUpstream: (url) => new WebSocket(url), toClient,
      });
      calls.setVoice(callId, session);
      clearTimeout(authTimer);
    } catch (err) { toClient({ type: 'error', message: err instanceof CallError || err?.code ? err.message : 'Voice could not start.' }); ws.close(1008); }
  });
  ws.onClose(() => { clearTimeout(authTimer); if (session) { session.end(); calls.setVoice(callId, null); } });
});
const PORT = Number(process.env.PORT || 8642);
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => console.log(`snap-to-booked on http://${HOST}:${PORT} (${ledger.mode()})`));

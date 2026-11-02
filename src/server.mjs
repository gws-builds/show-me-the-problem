// HTTP for the live demo. No framework: a handful of routes, every body size
// capped before it is read, static files from a fixed list, strict CSP.
//   node src/server.mjs            (PORT, HOST=127.0.0.1 by default; META_API_KEY from env)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

import { createGlimmer } from './afterBooking.js';
import { createAlerts } from './alerts.js';
import { createLedger } from './budget.js';
import { createCalls, CallError, LIMITS } from './calls.js';
import { callerIp } from './clientIp.js';
import { loadCorpus } from './corpus.js';
import { createGate, writeCode, cookieValue } from './gate.js';
import { createClient } from './meta.js';
import { CALL_ROUTE } from './routes.js';
import { createSms } from './sms.js';
import { createTts } from './tts.js';
import { createVoiceSession } from './voice.js';
import { upgrade, connectWebSocket } from './ws.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = process.env.DATA_DIR || path.join(ROOT, '.data');
fs.mkdirSync(path.join(DATA, 'runs'), { recursive: true });
// SPEND_STOP_USD: a hard stop for this server run (default $5), on top of the per-call caps and the account-wide stops.
// Hosted judge copy: a push for every call and every spend step (src/alerts.js; needs NTFY_TOPIC).
const alerts = createAlerts();
const ledger = createLedger(path.join(DATA, 'ledger.json'), {
  sessionStopUsd: Number(process.env.SPEND_STOP_USD) || 5,
  onRecord: (session) => {
    alerts.spend(session).catch(() => undefined);
  },
});
// A fresh access code every start, stored for the session script; never printed here. The hosted judge
// copy sets ACCESS_CODE (Secret Manager) so its link survives restarts and cold starts (red team 10/31).
const FIXED_CODE = String(process.env.ACCESS_CODE ?? '');
const gate = createGate({ code: FIXED_CODE.length >= 12 ? FIXED_CODE : writeCode(path.join(DATA, 'access_code')) });
setInterval(() => gate.sweep(), 60_000).unref();
const { priceList } = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/demo-business.json'), 'utf8'));
// The owner of the deployment can open live calls past the public limits with this header.
const STAFF_KEY = process.env.STAFF_KEY || '';
const tts = createTts();
// The trade library loads once (about a second) before the first call needs it.
setImmediate(() => {
  const l = loadCorpus();
  console.log(
    l.error ? `trade library NOT loaded: ${l.error}` : `trade library: ${l.index.size} passages (${l.loadMs} ms)`,
  );
});

// Open voice sockets by call, so a new line is pushed at once instead of waiting for the 0.7 s poll.
const sockets = new Map();
const calls = createCalls({
  ledger,
  priceList,
  glimmer: createGlimmer(),
  sms: createSms(),
  onSay: (c, entry) => {
    sockets.get(c.id)?.({ type: 'say', n: entry.n, text: entry.text, parts: entry.parts, status: entry.status });
    // The natural voice is made now and kept, so the phone's /say request is served from memory.
    // The first sentence starts first: it is what the caller is waiting to hear.
    if (tts.on) {
      const lang = c.session.lang?.() ?? 'en';
      const [first, ...rest] = entry.parts;
      void tts
        .speak(c.id, first, lang)
        .catch(() => null)
        .then(() => Promise.all(rest.map((p) => tts.speak(c.id, p, lang).catch(() => null))));
    }
  },
  // listen_to_equipment: the phone records 8 s of the equipment by itself.
  onListen: (c, equipment) => {
    const push = sockets.get(c.id);
    if (!push) throw new Error('no voice socket');
    push({ type: 'listen', equipment });
  },
  makeClient: (live) => createClient({ ledger, live }),
  // A finished call is kept as a replay for the console: events and spoken lines only, never frames or audio.
  onEnd: (c) => {
    tts.forget(c.id);
    if (!c.turns) return;
    try {
      fs.writeFileSync(
        path.join(DATA, 'runs', `${c.id}.json`),
        JSON.stringify({
          id: c.id,
          at: c.createdAt,
          staff: Boolean(c.staff),
          status: c.status,
          staged: c.staged,
          footage: c.footage ?? null,
          spentUsd: c.client.spent(),
          says: c.says,
          events: c.session.events(),
          booking: c.booking,
          checklist: c.session.checklist.list().map(({ geo: _geo, ...x }) => x),
          evidence: c.session.evidence.list().map(({ geo: _geo, ...x }) => x),
          latency: c.latencies,
        }),
      );
    } catch {
      /* replay is optional */
    }
  },
});
setInterval(() => calls.sweep(), 60_000).unref();
// Stopping the server (end of a recording session) keeps the calls still open as replays.
for (const sig of ['SIGTERM', 'SIGINT'])
  process.once(sig, () => {
    try {
      calls.endAll();
    } finally {
      process.exit(0);
    }
  });

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
  '/silence.mp3': ['silence.mp3', 'audio/mpeg'],
  '/pcm-worklet.js': ['pcm-worklet.js', 'text/javascript'],
  '/go': ['go.html', 'text/html'],
  '/go.js': ['go.js', 'text/javascript'],
  '/takes.json': ['takes.json', 'application/json'],
};
// Served without the access code: the code-entry page and its style and script only.
const OPEN = {
  '/gate': ['gate.html', 'text/html'],
  '/gate.js': ['gate.js', 'text/javascript'],
  '/app.css': ['app.css', 'text/css'],
};
const NEXT = { home: '/', go: '/go', console: '/console#latest' };
const HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
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
  const chunks = [];
  let n = 0;
  for await (const ch of req) {
    n += ch.length;
    if (n > max) throw new CallError('Too large.', 413, 'TOO_LARGE');
    chunks.push(ch);
  }
  return Buffer.concat(chunks);
}
const json = async (req, max) => {
  try {
    return JSON.parse((await readBody(req, max)).toString('utf8') || '{}');
  } catch (e) {
    if (e instanceof CallError) throw e;
    throw new CallError('Bad JSON.');
  }
};
const clientIp = (req) => callerIp(req);

// Footage mode: only the clips listed in public/footage/footage.json, with Range support (Safari needs it).
const FOOTAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/footage/footage.json'), 'utf8'));
function sendClip(req, res, file) {
  const f = path.join(ROOT, 'public/footage', file);
  const size = fs.statSync(f).size;
  const m = String(req.headers.range ?? '').match(/^bytes=(\d*)-(\d*)$/);
  if (!m) {
    res.writeHead(200, { ...HEADERS, 'Content-Type': 'video/mp4', 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    return fs.createReadStream(f).pipe(res);
  }
  let start = m[1] ? Number(m[1]) : size - Number(m[2]);
  let end = m[1] && m[2] ? Number(m[2]) : size - 1;
  start = Math.max(0, start);
  end = Math.min(size - 1, end);
  if (start > end) {
    res.writeHead(416, { ...HEADERS, 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, {
    ...HEADERS,
    'Content-Type': 'video/mp4',
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(f, { start, end }).pipe(res);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const key = clientIp(req);
  if (req.method === 'GET' && OPEN[p]) {
    const [file, type] = OPEN[p];
    return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', file)), `${type}; charset=utf-8`);
  }
  // /k/<code>: a link with the code sets the cookie and leaves the code out of the address bar.
  const k = p.match(/^\/k\/([a-z0-9-]{1,64})$/);
  if (req.method === 'GET' && k) {
    if (!gate.check(k[1], key)) {
      res.writeHead(gate.locked(key) ? 429 : 302, { ...HEADERS, Location: '/gate?bad=1' });
      return res.end();
    }
    const secure = String(req.headers['x-forwarded-proto'] ?? '') === 'https';
    res.writeHead(302, {
      ...HEADERS,
      'Set-Cookie': gate.cookie(secure),
      Location: NEXT[url.searchParams.get('to')] ?? '/go',
    });
    return res.end();
  }
  const header = String(req.headers['x-access-code'] ?? '');
  const ok = header ? gate.check(header, key) : gate.check(cookieValue(req.headers.cookie), key, { count: false });
  if (!ok) {
    if (gate.locked(key)) return send(res, 429, { error: 'Too many wrong codes. Try again later.', code: 'LOCKED' });
    if (p.startsWith('/api/')) return send(res, 401, { error: 'Access code required.', code: 'NO_ACCESS' });
    res.writeHead(302, { ...HEADERS, Location: '/gate' });
    return res.end();
  }
  if (req.method === 'GET' && p === '/api/footage') return send(res, 200, FOOTAGE);
  const clip = p.match(/^\/footage\/([a-z0-9-]+\.mp4)$/);
  if (req.method === 'GET' && clip && FOOTAGE.some((x) => x.file === clip[1])) return sendClip(req, res, clip[1]);
  if (req.method === 'GET' && p === '/api/runs') {
    // Replay fallback: the latest recorded calls (events and lines only, never media).
    const dir = path.join(DATA, 'runs');
    const list = fs
      .readdirSync(dir)
      .filter((f) => /^[a-f0-9]{32}\.json$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, 10)
      // Only the staff's own recorded takes are listed: a judge's call (their words) is never shown to the next judge.
      .map(({ f }) => {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (r.staff === false) return null;
          return {
            id: r.id,
            at: r.at,
            status: r.status,
            staged: Boolean(r.staged),
            footage: r.footage ?? null,
            turns: (r.says ?? []).length,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return send(res, 200, list);
  }
  if (req.method === 'GET' && STATIC[p]) {
    const [file, type] = STATIC[p];
    return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', file)), `${type}; charset=utf-8`);
  }
  if (req.method === 'GET' && p === '/api/health')
    return send(res, 200, { ok: true, mode: ledger.mode(), live: calls.size(), session: ledger.session() });
  if (req.method === 'GET' && p === '/api/calls/latest') return send(res, 200, calls.latest(key) ?? { id: null });
  if (req.method === 'POST' && p === '/api/calls') {
    // Everyone past the access code gets live calls (the founder, or a judge given the link), but only
    // the STAFF_KEY holder skips the per-person hourly limit: a shared judge code must not unlock
    // unlimited calls (red team 10/30). The session spend stop and per-call caps apply to everyone.
    const given = String(req.headers['x-staff-key'] ?? '');
    const staff = Boolean(
      STAFF_KEY && given.length === STAFF_KEY.length && timingSafeEqual(Buffer.from(given), Buffer.from(STAFF_KEY)),
    );
    const footage = FOOTAGE.find((x) => x.file === url.searchParams.get('footage'))?.file ?? null;
    const made = calls.create({ ip: key, live: true, staff, footage });
    if (!staff) alerts.callStarted({ ...ledger.session(), footage: Boolean(footage) }).catch(() => undefined);
    return send(res, 200, made);
  }
  const m = p.match(CALL_ROUTE);
  if (m) {
    const [, id, action] = m;
    const cam = String(req.headers['x-cam-token'] ?? '');
    const owner = String(req.headers['x-owner-token'] ?? '');
    // Any of the call's own links may look at it; an <img> cannot send a header, so `?t=` works too.
    const viewer = String(req.headers['x-view-token'] ?? '') || cam || owner || url.searchParams.get('t') || '';
    if (req.method === 'GET' && !action) return send(res, 200, calls.viewAs(id, viewer));
    if (req.method === 'GET' && action === 'still') {
      const d = calls.frameAs(id, viewer);
      if (!d) return send(res, 404, { error: 'No frame yet.' });
      return send(res, 200, Buffer.from(d.split(',')[1], 'base64'), 'image/jpeg');
    }
    if (req.method === 'GET' && action === 'booking.ics') {
      const ics = calls.bookingIcsOf(id, owner || url.searchParams.get('t') || '');
      if (!ics) return send(res, 404, { error: 'No approved visit yet.' });
      res.writeHead(200, {
        ...HEADERS,
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'attachment; filename="visit.ics"',
      });
      return res.end(ics);
    }
    if (req.method === 'GET' && action === 'annotated') {
      const d = calls.annotatedOf(id, owner);
      if (!d || !d.startsWith('data:image/')) return send(res, 404, { error: 'No annotated still.' });
      const [head, b64] = d.split(',');
      return send(res, 200, Buffer.from(b64, 'base64'), head.slice(5).split(';')[0]);
    }
    if (req.method === 'POST' && action === 'frame') {
      const b = await json(req, LIMITS.frameBytes + 200);
      return send(res, 200, await calls.frame(id, cam, b.image, b.luma));
    }
    if (req.method === 'POST' && action === 'speech') {
      if (!String(req.headers['content-type'] ?? '').startsWith('audio/wav'))
        throw new CallError('Send audio/wav.', 415, 'BAD_TYPE');
      return send(res, 200, await calls.speech(id, cam, await readBody(req, LIMITS.wavBytes)));
    }
    if (req.method === 'POST' && action === 'mobile') {
      const b = await json(req, 200);
      return send(
        res,
        200,
        b.code != null
          ? calls.verifyMobile(id, cam, String(b.code))
          : await calls.setMobile(id, cam, String(b.mobile ?? '')),
      );
    }
    if (req.method === 'POST' && action === 'listen') {
      if (!String(req.headers['content-type'] ?? '').startsWith('audio/wav'))
        throw new CallError('Send audio/wav.', 415, 'BAD_TYPE');
      return send(res, 200, await calls.listen(id, cam, await readBody(req, LIMITS.wavBytes)));
    }
    if (req.method === 'GET' && action?.startsWith('frames/')) {
      const d = calls.keptFrameAs(id, action.split('/')[1], viewer);
      if (!d) return send(res, 404, { error: 'No such evidence frame.' });
      return send(res, 200, Buffer.from(d.split(',')[1], 'base64'), 'image/jpeg');
    }
    if (req.method === 'POST' && action === 'say') {
      const text = String((await json(req, 1400)).text ?? '');
      if (!calls.sayable(id, cam, text))
        return send(res, 403, { error: "Only the agent's own lines are spoken.", code: 'NOT_SAYABLE' });
      const audio = await tts.speak(id, text, calls.langOf?.(id) ?? 'en').catch(() => null);
      if (!audio)
        return send(res, 503, { error: 'Natural voice unavailable; the browser voice is used.', code: 'NO_TTS' });
      return send(res, 200, audio, 'audio/mpeg');
    }
    if (req.method === 'POST' && action === 'tour')
      return send(res, 200, calls.tour(id, cam, String((await json(req, 200)).room ?? 'auto')));
    if (req.method === 'POST' && action === 'staged')
      return send(res, 200, calls.setStaged(id, cam, (await json(req, 200)).staged === true));
    if (req.method === 'POST' && action === 'tap') {
      const b = await json(req, 200);
      return send(res, 200, await calls.tap(id, cam, b.x, b.y));
    }
    if (req.method === 'POST' && action === 'text')
      return send(res, 200, await calls.text(id, cam, (await json(req, 2000)).text));
    if (req.method === 'POST' && action === 'confirmation')
      return send(res, 200, await calls.sendConfirmation(id, owner, (await json(req, 200)).send === true));
    if (req.method === 'POST' && action === 'decision')
      return send(res, 200, await calls.decide(id, owner, (await json(req, 200)).approve === true));
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
    if (err?.code && /HARD_STOP|READ_ONLY|RUN_CAP|SESSION_STOP/.test(err.code))
      return send(res, 503, { error: err.message, code: err.code });
    console.error('request failed', err?.message);
    send(res, 500, { error: 'Something went wrong.' });
  });
});
server.requestTimeout = 60_000;

// Voice: /api/calls/<id>/voice. The first message must be {"token": camToken}; then binary 16 kHz PCM.
// The browser never sees the API key: this server opens the upstream socket and adds it.
// Anything a stranger sends before the gate is untrusted: a throw here would take the whole server
// down (red team 10/31), so every failure closes this one socket instead.
server.on('upgrade', (req, socket) => {
  try {
    voiceUpgrade(req, socket);
  } catch (err) {
    console.error('voice upgrade refused', err?.message);
    socket.destroy();
  }
});
function voiceUpgrade(req, socket) {
  const m = new URL(req.url, 'http://x').pathname.match(/^\/api\/calls\/([a-f0-9]{32})\/voice$/);
  const origin = String(req.headers.origin ?? '');
  const host = String(req.headers.host ?? '');
  if (!m || (origin && (!URL.canParse(origin) || new URL(origin).host !== host))) {
    socket.destroy();
    return;
  }
  if (!gate.check(cookieValue(req.headers.cookie), clientIp(req), { count: false })) {
    socket.destroy();
    return;
  }
  const ws = upgrade(req, socket);
  if (!ws) return;
  const callId = m[1];
  let session = null;
  const toClient = (o) => ws.send(JSON.stringify(o));
  const authTimer = setTimeout(() => {
    if (!session) ws.close(1008);
  }, 5000);
  ws.onMessage((data, isBinary) => {
    if (session) {
      try {
        if (isBinary) session.audio(data);
        else if (/"endStream"/.test(data)) session.finish();
      } catch {
        try {
          session.end();
        } catch {
          /* gone */
        }
        ws.close(1011);
      }
      return;
    }
    if (isBinary) return ws.close(1008);
    try {
      const { token } = JSON.parse(data);
      calls.voiceAuth(callId, String(token ?? ''));
      session = createVoiceSession({
        calls,
        callId,
        client: calls.clientOf(callId),
        apiKey: process.env.META_API_KEY,
        openUpstream: (url) => connectWebSocket(url),
        toClient,
      });
      calls.setVoice(callId, session);
      sockets.set(callId, toClient);
      clearTimeout(authTimer);
    } catch (err) {
      toClient({
        type: 'error',
        message: err instanceof CallError || err?.code ? err.message : 'Voice could not start.',
      });
      ws.close(1008);
    }
  });
  ws.onClose(() => {
    clearTimeout(authTimer);
    if (sockets.get(callId) === toClient) sockets.delete(callId);
    if (session) {
      session.end();
      calls.setVoice(callId, null);
    }
  });
}
const PORT = Number(process.env.PORT || 8642);
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () =>
  console.log(
    `snap-to-booked on http://${HOST}:${PORT} (${ledger.mode()}; access code in ${path.relative(ROOT, path.join(DATA, 'access_code'))}; spend stop $${ledger.session().stopUsd} this run)`,
  ),
);

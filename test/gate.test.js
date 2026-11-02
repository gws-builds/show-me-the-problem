// Access-code gate and the session spend stop: unit tests, then the real server on 127.0.0.1.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createGate, newCode, writeCode, cookieValue, MISS_LIMIT } from '../src/gate.js';
import { createLedger } from '../src/budget.js';

test('codes are random, readable and long enough; the file is owner-only', () => {
  const a = newCode();
  const b = newCode();
  assert.match(a, /^[a-z2-9]{5}-[a-z2-9]{5}-[a-z2-9]{5}$/);
  assert.notEqual(a, b);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stb-g-')), 'access_code');
  const c = writeCode(f);
  assert.equal(fs.readFileSync(f, 'utf8'), c);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.throws(() => createGate({ code: 'short' }));
});
test('missing, forged and wrong-length codes fail; misses lock a client out; stale cookies do not count', () => {
  let t = 0;
  const g = createGate({ code: 'abcde-fghjk-mnpqr', now: () => t });
  assert.equal(g.check('', 'a'), false);
  assert.equal(g.check(undefined, 'a'), false);
  assert.equal(g.check('abcde-fghjk-mnpqs', 'a'), false);
  assert.equal(g.check('abcde-fghjk-mnpq', 'a'), false);
  assert.equal(g.check('abcde-fghjk-mnpqr', 'a'), true);
  for (let i = 0; i < 50; i++) g.check('stale-cookie-xxxxx', 'b', { count: false });
  assert.equal(g.locked('b'), false);
  for (let i = 0; i < MISS_LIMIT; i++) g.check(`wrong-${i}-xxxxxxxx`, 'c');
  assert.equal(g.locked('c'), true);
  assert.equal(g.check('another-wrong-xxxx', 'c'), false, 'locked for wrong codes');
  assert.equal(
    g.check('abcde-fghjk-mnpqr', 'c'),
    true,
    'the right code still works from a locked address (shared judge network)',
  );
  t += 11 * 60_000;
  assert.equal(g.locked('c'), false, 'unlocked after the window');
  assert.match(g.cookie(true), /HttpOnly; SameSite=Lax; Max-Age=43200; Secure$/);
  assert.equal(cookieValue('a=1; smtp_access=xyz; b=2'), 'xyz');
  assert.equal(cookieValue(undefined), '');
});
test('session spend stop: past the stop, nothing calls the API and new calls are refused', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stb-s-')), 'l.json');
  fs.writeFileSync(f, JSON.stringify({ spentUsd: 4.13, calls: 1 }));
  const l = createLedger(f, { sessionStopUsd: 1 });
  l.assertCanSpend();
  for (let i = 0; i < 400; i++) l.record('sam-3.1', { images: 1 });
  assert.equal(l.mode(), 'stopped');
  assert.throws(() => l.assertCanSpend({ live: true }), { code: 'SESSION_STOP' });
  assert.equal(l.session().stopped, true);
  assert.equal(createLedger(f, { sessionStopUsd: 1 }).mode(), 'live', 'a restart counts from the new total');
});

// ---- the real server ----
const freePort = () =>
  new Promise((r) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stb-srv-'));
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: dir,
    SPEND_STOP_USD: '0.5',
    META_API_KEY: '',
  };
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  child.stderr.on('data', (d) => {
    out += d;
  });
  for (let i = 0; i < 50 && !out.includes('snap-to-booked on'); i++) await new Promise((r) => setTimeout(r, 100));
  const code = fs.readFileSync(path.join(dir, 'access_code'), 'utf8');
  return { base: `http://127.0.0.1:${port}`, port, code, child, out: () => out, dir };
}
const raw = (port, request) =>
  new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(request));
    let data = '';
    s.on('data', (d) => {
      data += d;
      if (data.includes('\r\n\r\n')) {
        s.destroy();
        resolve(data);
      }
    });
    s.on('close', () => resolve(data));
    s.on('error', () => resolve(data));
    setTimeout(() => {
      s.destroy();
      resolve(data);
    }, 2000);
  });

test('server: every page and API needs the code; /k/ sets a Lax cookie (survives a click from email); the code is never printed', async (t) => {
  const srv = await startServer();
  t.after(() => {
    srv.child.kill();
    fs.rmSync(srv.dir, { recursive: true, force: true });
  });
  const get = (p, headers = {}) => fetch(srv.base + p, { headers, redirect: 'manual' });
  assert.equal(fs.statSync(path.join(srv.dir, 'access_code')).mode & 0o777, 0o600);
  assert.ok(!srv.out().includes(srv.code), 'the server log does not contain the code');
  // No code
  for (const p of ['/', '/call', '/console', '/owner', '/go', '/camera.js', '/takes.json']) {
    const r = await get(p);
    assert.equal(r.status, 302, p);
    assert.equal(r.headers.get('location'), '/gate');
  }
  for (const p of ['/api/health', '/api/runs', '/api/footage', '/api/calls/latest', '/footage/dripping-tap.mp4'])
    assert.ok([401, 302].includes((await get(p)).status), p);
  assert.equal((await get('/gate')).status, 200);
  assert.equal((await get('/app.css')).status, 200);
  // A huge upload without the code is refused before its body is read.
  const big = await fetch(`${srv.base}/api/calls/${'a'.repeat(32)}/frame`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'x'.repeat(5_000_000),
  }).catch(() => null);
  assert.ok(!big || big.status === 401);
  // Forged
  assert.equal((await get('/', { cookie: 'smtp_access=aaaaa-bbbbb-ccccc' })).status, 302);
  assert.equal((await get('/k/aaaaa-bbbbb-ccccc')).headers.get('location'), '/gate?bad=1');
  // Right code
  const k = await get(`/k/${srv.code}?to=console`);
  assert.equal(k.status, 302);
  assert.equal(k.headers.get('location'), '/console#latest');
  const setCookie = k.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const cookie = setCookie.split(';')[0];
  assert.equal((await get('/', { cookie })).status, 200);
  const h = await (await get('/api/health', { cookie })).json();
  assert.equal(h.session.stopUsd, 0.5);
  assert.equal((await get('/api/health', { 'x-access-code': srv.code })).status, 200);
  // A call, the latest-call pointer, the size cap, and the tour route
  const call = await (await fetch(`${srv.base}/api/calls`, { method: 'POST', headers: { cookie } })).json();
  assert.match(call.id, /^[a-f0-9]{32}$/);
  assert.equal((await (await get('/api/calls/latest', { cookie })).json()).id, call.id);
  const tooBig = await fetch(`${srv.base}/api/calls/${call.id}/frame`, {
    method: 'POST',
    headers: { cookie, 'x-cam-token': call.camToken, 'Content-Type': 'application/json', 'Content-Length': '9000000' },
    body: 'x'.repeat(9_000_000),
  }).catch(() => null);
  assert.ok(!tooBig || tooBig.status === 413);
  const tour = await fetch(`${srv.base}/api/calls/${call.id}/tour`, {
    method: 'POST',
    headers: { cookie, 'x-cam-token': 'f'.repeat(32), 'Content-Type': 'application/json' },
    body: '{"room":"boiler_room"}',
  });
  assert.equal(tour.status, 403);
  // WebSocket: no cookie, no socket
  const ws = `GET /api/calls/${call.id}/voice HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n`;
  assert.equal(await raw(srv.port, `${ws}\r\n`), '');
  assert.match(await raw(srv.port, `${ws}Cookie: ${cookie}\r\n\r\n`), /^HTTP\/1\.1 101/);
  // Too many wrong codes lock this client out for wrong codes; the right code still gets in
  for (let i = 0; i < 20; i++) await get(`/k/wrong-${i}-xxxxxxxxx`);
  assert.equal((await get('/api/health', { 'x-access-code': 'wrong-again-xxxxxx' })).status, 429);
  assert.equal((await get('/api/health', { 'x-access-code': srv.code })).status, 200);
});

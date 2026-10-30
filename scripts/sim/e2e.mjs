// End-to-end simulation of what a real phone does, against the real server on 127.0.0.1 and the
// live Meta models. No phone needed; nothing leaves this Mac except the model calls themselves.
//   A. Staged scene: Chrome's fake camera plays the staged-stove composite (eval/photos/sc01.jpg);
//      the camera page must show the red outline, speak the warning and mark "flammables: found".
//   B. Hands-free voice: Chrome's fake camera plays the dripping-tap clip and its fake microphone
//      plays a sentence made with macOS `say` (16 kHz WAV). The agent must hear it, answer, and
//      SAM must outline the faucet.
//   C. WebKit (Playwright) as a stand-in for iPhone Safari: the pages load, the recording cue shows,
//      and what the camera button does is recorded honestly.
// Usage: META_API_KEY=... node scripts/sim/e2e.mjs [A] [B] [C]   (Playwright from PLAYWRIGHT_PATH or the global install)
// Spend: stopped by the server's own spend stop for this run (SIM_STOP_USD, default $1.50).
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '.data', 'sim');
const PW = process.env.PLAYWRIGHT_PATH || '/opt/homebrew/lib/node_modules/playwright/index.mjs';
const { chromium, webkit } = await import(PW);
const only = new Set(process.argv.slice(2));
const want = (x) => !only.size || only.has(x);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};

// ---- media ----
function media() {
  const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'ignore' });
  const stove = path.join(OUT, 'stove.mjpeg');
  if (!fs.existsSync(stove)) run('ffmpeg', ['-y', '-loop', '1', '-i', path.join(ROOT, 'eval/photos/sc01.jpg'), '-t', '90', '-r', '5', '-vf', 'scale=960:-2', '-q:v', '4', stove]);
  const tap = path.join(OUT, 'tap.mjpeg');
  if (!fs.existsSync(tap)) run('ffmpeg', ['-y', '-stream_loop', '3', '-i', path.join(ROOT, 'public/footage/dripping-tap.mp4'), '-t', '90', '-r', '10', '-vf', 'scale=960:-2', '-q:v', '4', '-an', tap]);
  // Speech: 3 s of silence, the line, 4 s of silence (so turn detection sees the end), 16 kHz mono 16-bit.
  const line = path.join(OUT, 'line.aiff'); const wav = path.join(OUT, 'speech.wav');
  if (!fs.existsSync(wav)) {
    run('say', ['-v', 'Samantha', '-o', line, 'Hi. My kitchen faucet drips. Not into the sink, from underneath, under the handle.']);
    run('ffmpeg', ['-y', '-f', 'lavfi', '-t', '3', '-i', 'anullsrc=r=16000:cl=mono', '-i', line, '-f', 'lavfi', '-t', '4', '-i', 'anullsrc=r=16000:cl=mono',
      '-filter_complex', '[1]aresample=16000,aformat=channel_layouts=mono[s];[0][s][2]concat=n=3:v=0:a=1', '-c:a', 'pcm_s16le', '-ar', '16000', '-ac', '1', wav]);
    fs.rmSync(line, { force: true });
  }
  const silence = path.join(OUT, 'silence.wav');
  if (!fs.existsSync(silence)) run('ffmpeg', ['-y', '-f', 'lavfi', '-t', '60', '-i', 'anullsrc=r=16000:cl=mono', '-c:a', 'pcm_s16le', silence]);
  return { stove, tap, wav, silence };
}

// ---- server ----
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: ROOT, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), SPEND_STOP_USD: process.env.SIM_STOP_USD || '1.5' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 60 && !log.includes('snap-to-booked on'); i++) await sleep(100);
  return { port, child, base: `http://127.0.0.1:${port}`, code: fs.readFileSync(path.join(ROOT, '.data', 'access_code'), 'utf8') };
}

const fakeArgs = (video, audio) => ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`, `--use-file-for-fake-audio-capture=${audio}`, '--autoplay-policy=no-user-gesture-required'];
const view = (page) => page.evaluate(async () => { const id = location.hash.slice(1).split('.')[0]; const r = await fetch(`/api/calls/${id}`); return r.ok ? r.json() : null; });

async function startTake(page, srv, takeTitle) {
  await page.goto(`${srv.base}/k/${srv.code}?to=go`);
  await page.waitForSelector('#takes .card');
  await page.locator('#takes .card', { hasText: takeTitle }).getByRole('button').click();
  await page.waitForURL(/\/call\?take=/);
  await page.waitForSelector('#recStart:not([hidden])');
}

async function scenarioA(srv, m) {
  const browser = await chromium.launch({ headless: true, args: fakeArgs(m.stove, m.silence) });
  const r = { name: 'A. staged scene through the camera page' };
  try {
    const page = await (await browser.newContext({ viewport: { width: 430, height: 1200 } })).newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(String(e.message)));
    await startTake(page, srv, 'Staged scene');
    r.recordingCueShown = await page.isVisible('#recStart .cue-banner');
    await page.click('#recording');
    const t0 = Date.now(); let v = null;
    while (Date.now() - t0 < 75_000) { await sleep(2500); v = await view(page); if (v?.checklist?.find((c) => c.id === 'flammables')?.status === 'found') break; }
    const fl = v?.checklist?.find((c) => c.id === 'flammables');
    r.secondsToFound = fl?.status === 'found' ? Math.round((Date.now() - t0) / 1000) : null;
    r.checklistFlammables = fl?.status ?? null; r.detail = fl?.detail ?? null;
    r.redOutlineGeo = Boolean(fl?.geo);
    r.stagedLabelOn = await page.isVisible('#staged');
    r.warningSpoken = (v?.says ?? []).some((s) => /away from the heat/.test(s.text));
    r.scans = (v?.events ?? []).filter((e) => e.kind === 'hazard_scan').map((e) => e.findings.map((f) => `${f.category}:${f.object}:${f.status}`).join(',') || 'clear');
    await page.waitForSelector('#recStop:not([hidden])', { timeout: 20_000 }).then(() => { r.stopCueShown = true; }).catch(() => { r.stopCueShown = false; });
    // Red pixels on the overlay canvas where the outline is drawn.
    r.redPixelsOnOverlay = await page.evaluate(() => { const c = document.getElementById('ov'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 90 && d[i + 2] < 90 && d[i + 3] > 100) n++; return n; });
    await page.locator('.stage').screenshot({ path: path.join(OUT, 'A_staged_stage.png') });
    r.spentUsd = v?.spentUsd; r.pageErrors = errors;
    r.pass = Boolean(r.checklistFlammables === 'found' && r.redOutlineGeo && r.warningSpoken && r.redPixelsOnOverlay > 50);
  } finally { await browser.close(); }
  return r;
}

async function scenarioB(srv, m) {
  const browser = await chromium.launch({ headless: true, args: fakeArgs(m.tap, `${m.wav}%noloop`) });
  const r = { name: 'B. hands-free voice end to end (fake mic plays a say-generated WAV)' };
  try {
    const page = await (await browser.newContext({ viewport: { width: 430, height: 1200 } })).newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(String(e.message)));
    await startTake(page, srv, 'Faucet drip (main take)');
    await page.click('#recording');
    const t0 = Date.now(); let v = null; const states = new Set();
    while (Date.now() - t0 < 90_000) {
      await sleep(1500); v = await view(page);
      states.add(await page.textContent('#vstate'));
      const heard = (v?.events ?? []).some((e) => e.kind === 'caller');
      const outlined = (v?.events ?? []).some((e) => e.kind === 'sam' && e.boxes > 0 && (e.score ?? 1) >= 0.5);
      if (heard && outlined && v.says.length >= 3) break;
    }
    const caller = (v?.events ?? []).filter((e) => e.kind === 'caller').map((e) => e.text);
    r.voiceStates = [...states];
    r.heard = caller;
    r.heardOnPage = await page.textContent('#heard');
    r.agentLines = (v?.says ?? []).slice(1).map((s) => s.text);
    r.voiceLatencyMs = (v?.events ?? []).filter((e) => e.kind === 'latency' && e.channel === 'voice').map((e) => e.ms);
    const sam = (v?.events ?? []).filter((e) => e.kind === 'sam');
    r.samOutlines = sam.map((e) => `${e.part}:${e.method}:${e.boxes}@${e.score != null ? Number(e.score).toFixed(2) : '-'}`);
    r.outlineOnScreen = await page.evaluate(() => { const c = document.getElementById('ov'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 100) n++; return n; });
    await page.locator('.stage').screenshot({ path: path.join(OUT, 'B_voice_stage.png') });
    r.spentUsd = v?.spentUsd; r.pageErrors = errors;
    r.pass = Boolean(caller.some((t) => /faucet|drip/i.test(t)) && r.agentLines.length && sam.some((e) => e.boxes > 0 && (e.score ?? 1) >= 0.5));
  } finally { await browser.close(); }
  return r;
}

async function scenarioC(srv) {
  const browser = await webkit.launch({ headless: true });
  const r = { name: 'C. WebKit (stand-in for iPhone Safari, not a real iPhone)' };
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(String(e.message)));
    const consoleErr = []; page.on('console', (m) => { if (m.type() === 'error') consoleErr.push(m.text().slice(0, 160)); });
    await page.goto(`${srv.base}/gate`); r.gatePage = await page.isVisible('#code');
    await startTake(page, srv, 'Tour: under the sink');
    r.recordingCue = await page.textContent('#recStart .cue-banner');
    r.lightButtonInMarkup = await page.locator('#torch').count() === 1;
    r.mediaDevicesApi = await page.evaluate(() => Boolean(navigator.mediaDevices?.getUserMedia));
    await page.click('#recording');
    await sleep(4000);
    r.afterTap = { consentShown: await page.isVisible('#consent'), error: (await page.textContent('#err')) || null, scriptCardShown: await page.isVisible('#script'), status: await page.textContent('#status') };
    r.noHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    await page.screenshot({ path: path.join(OUT, 'C_webkit.png'), fullPage: false });
    r.pageErrors = errors; r.consoleErrors = consoleErr;
    r.pass = r.gatePage && /Start your screen recording now/.test(r.recordingCue) && !errors.length && r.noHorizontalScroll;
  } finally { await browser.close(); }
  return r;
}

const m = media();
const srv = await startServer();
try {
  if (want('A')) results.A = await scenarioA(srv, m).catch((e) => ({ error: String(e.message).slice(0, 300) }));
  if (want('B')) results.B = await scenarioB(srv, m).catch((e) => ({ error: String(e.message).slice(0, 300) }));
  if (want('C')) results.C = await scenarioC(srv).catch((e) => ({ error: String(e.message).slice(0, 300) }));
  const h = await fetch(`${srv.base}/api/health`, { headers: { 'x-access-code': srv.code } }).then((x) => x.json()).catch(() => null);
  results.sessionSpendUsd = h?.session?.spentUsd ?? null;
} finally { srv.child.kill(); }
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
console.log(JSON.stringify(results, null, 1));

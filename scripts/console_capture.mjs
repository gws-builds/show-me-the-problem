// Records the Agent Console in the background (founder Oct 30: "done in the
// background without disturbing what I am doing"): a headless Chrome nobody
// sees renders the console page, Chrome's screencast hands us its frames, and
// ffmpeg writes them at a steady 15 fps. No window, no screen-recording
// permission, nothing else on the Mac is captured.
//   node scripts/console_capture.mjs <url> <out.mp4>     (stop with TERM or INT)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [url, out] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: console_capture.mjs <url> <out.mp4>');
  process.exit(2);
}
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 1280;
const H = 900;
const FPS = 15;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'stb-console-'));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    `--window-size=${W},${H}`,
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
const wsUrl = await new Promise((ok, no) => {
  let buf = '';
  const t = setTimeout(() => no(new Error('Chrome did not start')), 15000);
  chrome.stderr.on('data', (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) {
      clearTimeout(t);
      ok(m[1]);
    }
  });
});

const browser = new WebSocket(wsUrl);
await new Promise((r) => browser.addEventListener('open', r));
let id = 0;
const pend = new Map();
const handlers = [];
browser.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
  } else handlers.forEach((h) => h(m));
});
const send = (method, params = {}, sessionId) =>
  new Promise((r) => {
    const i = ++id;
    pend.set(i, r);
    browser.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

// Opened straight on the console: navigating away from about:blank swaps the page's process and
// detaches the screencast ("Not attached to an active page").
const {
  result: { targetId },
} = await send('Target.createTarget', { url });
const {
  result: { sessionId },
} = await send('Target.attachToTarget', { targetId, flatten: true });
await send(
  'Emulation.setDeviceMetricsOverride',
  { width: W, height: H, deviceScaleFactor: 1, mobile: false },
  sessionId,
);
await send('Page.enable', {}, sessionId);
await new Promise((r) => {
  handlers.push((m) => {
    if (m.method === 'Page.loadEventFired') r();
  });
  setTimeout(r, 8000);
});

const ffmpeg = spawn(
  'ffmpeg',
  [
    '-loglevel',
    'error',
    '-y',
    '-f',
    'image2pipe',
    '-c:v',
    'mjpeg',
    '-framerate',
    String(FPS),
    '-i',
    '-',
    '-vf',
    `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    out,
  ],
  { stdio: ['pipe', 'inherit', 'inherit'] },
);

let latest = null;
handlers.push((m) => {
  if (m.method === 'Page.screencastFrame' && m.sessionId === sessionId) {
    latest = Buffer.from(m.params.data, 'base64');
    send('Page.screencastFrameAck', { sessionId: m.params.sessionId }, sessionId);
  }
});
const cast = () =>
  send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: W, maxHeight: H, everyNthFrame: 1 }, sessionId);
if ((await cast()).error) {
  await new Promise((r) => setTimeout(r, 1500));
  if ((await cast()).error) console.error('Console capture: screencast refused');
}
// Steady frame rate: the screencast only sends a frame when the page changes.
const tick = setInterval(() => {
  if (latest && ffmpeg.stdin.writable) ffmpeg.stdin.write(latest);
}, 1000 / FPS);
console.log(`Console capture: recording in the background to ${out}`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(tick);
  ffmpeg.stdin.end();
  await new Promise((r) => {
    ffmpeg.on('close', r);
    setTimeout(r, 15000);
  });
  try {
    browser.close();
  } catch {
    /* gone */
  }
  await new Promise((r) => {
    if (chrome.exitCode !== null) r();
    else {
      chrome.on('exit', r);
      chrome.kill('SIGTERM');
      setTimeout(r, 5000);
    }
  });
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* the OS clears its temp folder */
  }
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
chrome.on('exit', () => {
  if (!stopping) stop();
});

// Limits, fixed lines and small helpers shared by the call modules (src/calls.js and src/calls/*).
import { randomBytes } from 'node:crypto';

import { TOUR } from '../tour.js';

// The fixed lines the phone may voice besides the agent's own: the acknowledgements public/voice.js plays
// while the agent works (keep the two lists the same) and the recording cues. Listed so /say serves them
// in the natural voice instead of the browser's.
export const WAITING_LINES = [
  'On it.',
  'Okay, one sec.',
  'Let me look.',
  'Sure, checking.',
  'Just a few moments longer.',
  'Almost there, a few more seconds.',
  'Still checking, just a moment longer.',
  'Nearly done, thanks for waiting.',
  'Still on it, almost there.',
  'Thanks for bearing with me, I am just about done.',
  'Enseguida.',
  'Entendido.',
  'Déjame ver.',
  'Ya voy.',
  'Unos momentos más.',
  'Casi listo, unos segundos más.',
  'Ya casi, gracias por esperar.',
  'Gracias por la paciencia, ya casi termino.',
];
export const SPOKEN_CUES = new Set([
  'Start your screen recording now.',
  'You can stop recording now.',
  'Hold still there.',
  ...WAITING_LINES,
]);

export const LIMITS = {
  frameBytes: 400_000, // data URL length, ~300 KB JPEG
  wavBytes: 1_300_000, // ~40 s of 16 kHz mono
  textChars: 300,
  frameEveryMs: 800,
  speechEveryMs: 1500,
  callTtlMs: 15 * 60_000,
  idleMs: 2 * 60_000, // no frame, speech or tap for this long ends the call
  maxLiveCalls: 10,
  callsPerIpPerHour: 6,
  // Model spend one person (IP) may cause in an hour, so a shared judge code cannot drain the session stop
  // for everyone (red team #5 S1: about 8 tour calls emptied a $5 stop). Staff calls are not counted.
  usdPerIpPerHour: 1.5,
  liveCallsPerIp: 2, // calls open at once from one place, so one person cannot hold the live slots
  trackChecks: 8, // SAM re-checks while the caller moves the camera (each updates the guidance arrow)
  trackEveryMs: 1500,
  hazardScans: 12, // camera hazard scans per call (2 min of camera at one per 10 s) (Spark lists, SAM must agree)
  scanEveryMs: 10_000,
  tourSteps: TOUR.steps, // guided-tour steps per call (Spark names parts, SAM outlines them)
  tourEveryMs: TOUR.everyMs,
  // Founder 10/30: "it should never fail or freeze". A caller turn that runs longer than this
  // is answered with a retry line instead of silence; a late result is dropped, never spoken over a newer line.
  // 30 s, not 20: a turn with three tool rounds on a slow minute ran 20.3 s and was thrown away (eval th01, Nov 2);
  // the phone keeps the caller company with waiting lines at 5, 11 and 19 s.
  turnMs: 30_000,
  autoTurns: 10, // agent turns started by the camera or a tap, per call
  taps: 40, // SAM point prompts from taps, per call
  listens: 4, // equipment sound clips measured, per call
  codeTextsPerHour: 20, // one-time-code texts across every call on this server
  voiceWaitMs: 32_000, // a line said while the agent is still answering waits its turn instead of being refused
};
// About 2.6 spoken words a second, so a tour step never talks over the agent's answer.
export const speakMs = (text) => Math.min(15_000, 1200 + String(text ?? '').split(/\s+/).length * 380);

export const newId = (n = 16) => randomBytes(n).toString('hex');
export const article = (noun) => `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;

export class CallError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// The demo business's next three weekday windows, in its own time zone, with the date and hours a
// calendar invite needs (src/ics.js).
const BUSINESS_TZ = process.env.BUSINESS_TZ || 'America/Toronto';
export function nextSlots(now) {
  const out = [];
  const d = new Date(now);
  for (let i = 1; out.length < 3 && i < 10; i++) {
    const day = new Date(d.getTime() + i * 86_400_000);
    const weekday = day.toLocaleDateString('en-US', { weekday: 'short', timeZone: BUSINESS_TZ });
    if (weekday === 'Sat' || weekday === 'Sun') continue;
    const label = day.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      timeZone: BUSINESS_TZ,
    });
    const morning = out.length % 2 === 0;
    out.push({
      id: `s${out.length + 1}`,
      label: `${label}, ${morning ? '9-11 AM' : '1-3 PM'}`,
      date: day.toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ }),
      startHour: morning ? 9 : 13,
      endHour: morning ? 11 : 15,
    });
  }
  return out;
}

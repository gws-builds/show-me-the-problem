// Listening to the equipment (founder 11/01: "sounds indicate what's not working"). The caller holds
// the phone over the open tank while it refills; code measures the clip, not a model. Per 50 ms frame:
// loudness (RMS dB), zero crossings (hiss vs rumble) and pitch strength (normalised autocorrelation,
// 300-3000 Hz), then four sound signatures a plumber listens for. Each finding carries the measured
// share of the clip so the work order can cite it; what a signature means comes from the table below,
// never from the model. No public audio dataset labels toilet faults (ESC-50 has only "toilet flush"),
// so signatures are measured with fixed thresholds: shortcut: hand-tuned thresholds, retune on real
// recordings from pilot calls.
import { wavSeconds } from './meta.js';

const RATE = 16000;
const FRAME = 800; // 50 ms
// Fixed level for "something is making noise": a steady sound has no quieter part to compare with.
// About 40 dB RMS on 16-bit samples is a quiet room through a phone mic; running water is well above.
const LOUD_DB = 42;

// What each signature usually means, per fixture. The model may quote these, not invent others.
export const SOUND_MEANINGS = {
  toilet: {
    steady_flow: { meaning: 'Water is still running after the refill should have stopped: the flapper is not sealing or the fill valve is not shutting off (a running toilet).', parts: ['flapper', 'fill valve'], source: 'epa-leaks' },
    whistle: { meaning: 'A whistle or squeal while filling usually comes from a worn fill valve.', parts: ['fill valve'], source: null },
    gurgle: { meaning: 'Gurgling points to air in the drain: a partial clog or a blocked vent, not the tank parts.', parts: ['drain auger'], source: null },
    bang: { meaning: 'A bang or knock when the valve shuts is water hammer: a fast-closing fill valve or loose supply pipe.', parts: ['fill valve', 'water hammer arrestor'], source: null },
    quiet: { meaning: 'Quiet once full: no running water heard while listening.', parts: [], source: null },
  },
  sink: {
    steady_flow: { meaning: 'Water keeps flowing with the tap off: a worn cartridge or seat lets water through.', parts: ['cartridge', 'seat'], source: null },
    whistle: { meaning: 'A whistle when the tap is part-open usually comes from a worn washer or cartridge.', parts: ['cartridge'], source: null },
    gurgle: { meaning: 'Gurgling in the drain points to a partial clog or a blocked vent.', parts: ['drain auger'], source: null },
    bang: { meaning: 'A bang when the tap closes is water hammer.', parts: ['water hammer arrestor'], source: null },
    quiet: { meaning: 'Quiet with the tap off: no flow heard.', parts: [], source: null },
  },
};

function frames(pcm) {
  const out = [];
  for (let s = 0; s + FRAME <= pcm.length; s += FRAME) {
    let sum = 0; let zc = 0; let mean = 0;
    for (let i = s; i < s + FRAME; i++) mean += pcm[i];
    mean /= FRAME;
    for (let i = s; i < s + FRAME; i++) { const v = pcm[i] - mean; sum += v * v; if (i > s && (pcm[i - 1] - mean) * v < 0) zc++; }
    const rms = Math.sqrt(sum / FRAME);
    // Pitch strength: best normalised autocorrelation over 300-3000 Hz lags.
    let best = 0;
    if (rms > 30) {
      for (let lag = Math.floor(RATE / 3000); lag <= Math.floor(RATE / 300); lag++) {
        let num = 0; let a = 0; let b = 0;
        for (let i = s; i + lag < s + FRAME; i++) { const x = pcm[i] - mean; const y = pcm[i + lag] - mean; num += x * y; a += x * x; b += y * y; }
        const r = a && b ? num / Math.sqrt(a * b) : 0;
        if (r > best) best = r;
      }
    }
    out.push({ db: 20 * Math.log10(Math.max(1, rms)), zcr: zc / FRAME, pitch: best });
  }
  return out;
}

/** Measures a 16-bit mono PCM WAV (16 kHz) and returns the sound signatures found in it. */
export function analyseSound(wav, { fixture = 'toilet' } = {}) {
  const seconds = wavSeconds(wav);
  if (seconds == null) throw new Error('audio must be a 16-bit PCM WAV');
  const data = wav.indexOf('data', 12, 'latin1');
  const pcm = new Int16Array(wav.buffer.slice(wav.byteOffset + data + 8, wav.byteOffset + wav.length - ((wav.length - data - 8) % 2)));
  const f = frames(pcm);
  if (f.length < 20) return { seconds, findings: [], note: 'Too short to judge: hold it there for about 8 seconds.' };
  const sorted = f.map((x) => x.db).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const loud = f.filter((x) => x.db > LOUD_DB);
  const share = (n) => Math.round((n / f.length) * 100) / 100;
  const found = [];
  // Steady flow: broadband (many zero crossings, little pitch), loud, and level steady across the clip.
  const hiss = f.filter((x) => x.db > LOUD_DB && x.zcr > 0.12 && x.pitch < 0.5);
  const spread = hiss.length ? Math.max(...hiss.map((x) => x.db)) - Math.min(...hiss.map((x) => x.db)) : 99;
  if (share(hiss.length) >= 0.6 && spread < 18) found.push({ sound: 'steady_flow', share: share(hiss.length), detail: `Steady hiss for ${Math.round(share(hiss.length) * 100)}% of ${seconds.toFixed(1)} s` });
  const tone = f.filter((x) => x.db > LOUD_DB && x.pitch >= 0.75);
  if (share(tone.length) >= 0.15) found.push({ sound: 'whistle', share: share(tone.length), detail: `Clear tone for ${Math.round(share(tone.length) * 100)}% of the clip` });
  // Gurgle: low-pitched (few crossings) bursts that rise and fall, not a steady level.
  const low = f.map((x) => x.db > LOUD_DB + 3 && x.zcr < 0.05);
  let bursts = 0; for (let i = 1; i < low.length; i++) if (low[i] && !low[i - 1]) bursts++;
  if (bursts >= 4 && share(low.filter(Boolean).length) >= 0.1) found.push({ sound: 'gurgle', share: share(low.filter(Boolean).length), detail: `${bursts} low bubbling bursts` });
  // Bang: one frame far above the clip's median and its neighbours.
  let bangs = 0; for (let i = 1; i < f.length - 1; i++) if (f[i].db - median > 20 && f[i].db - f[i - 1].db > 12) bangs++;
  if (bangs >= 1 && bangs <= 6) found.push({ sound: 'bang', share: share(bangs), detail: `${bangs} sharp knock${bangs === 1 ? '' : 's'}` });
  if (!found.length && share(loud.length) < 0.2) found.push({ sound: 'quiet', share: share(f.length - loud.length), detail: 'Quiet most of the clip' });
  const table = SOUND_MEANINGS[fixture] ?? SOUND_MEANINGS.toilet;
  return { seconds, levelDb: Math.round(median), findings: found.map((x) => ({ ...x, ...table[x.sound] })) };
}

// Listening to the equipment (founder 11/01: "sounds indicate what's not working"), for plumbing, HVAC,
// electrical and mechanical equipment. The AI starts it by itself when a sound matters (listen_to_equipment);
// the caller holds the phone near the equipment for 8 s; code measures the clip, not a model. Per 50 ms frame:
// loudness (RMS dB), zero crossings (hiss vs rumble) and pitch strength (normalised autocorrelation,
// 300-3000 Hz), then the sound signatures a technician listens for (hiss, whistle, gurgle, knock, rattle, hum). Each finding carries the measured
// share of the clip so the work order can cite it; what a signature means comes from the table below,
// never from the model. No public audio dataset labels toilet faults (ESC-50 has only "toilet flush"),
// so signatures are measured with fixed thresholds: shortcut: hand-tuned thresholds, retune on real
// recordings from pilot calls.
import { parseWav } from './wav.js';

const RATE = 16000;
const FRAME = 800; // 50 ms
// Fixed level for "something is making noise": a steady sound has no quieter part to compare with.
// About 40 dB RMS on 16-bit samples is a quiet room through a phone mic; running water is well above.
const LOUD_DB = 42;

// What each signature usually means, per kind of equipment (founder 11/01: plumbing, HVAC, electrical and
// mechanical, not only toilets). The model may quote these, not invent others. `hazard` lines are said
// in code before the model's turn. shortcut: meanings are common trade guidance, sourced where a manual in
// kb/sources.json says it; the rest are marked source null until a cited source is added.
const M = (meaning, parts = [], source = null, hazard = false) => ({
  meaning,
  parts,
  source,
  ...(hazard ? { hazard: true } : {}),
});
const QUIET = M('Quiet while listening: no fault sound heard.');
export const SOUND_MEANINGS = {
  toilet: {
    steady_flow: M(
      'Water is still running after the refill should have stopped: the flapper is not sealing or the fill valve is not shutting off (a running toilet).',
      ['flapper', 'fill valve'],
      'epa-fix-leak',
    ),
    whistle: M('A whistle or squeal while filling usually comes from a worn fill valve.', ['fill valve']),
    gurgle: M('Gurgling points to air in the drain: a partial clog or a blocked vent, not the tank parts.', [
      'drain auger',
    ]),
    bang: M('A bang or knock when the valve shuts is water hammer: a fast-closing fill valve or loose supply pipe.', [
      'fill valve',
      'water hammer arrestor',
    ]),
    hum: M('A hum near a toilet is usually the fill valve vibrating or a nearby pipe, not the toilet itself.', [
      'fill valve',
    ]),
    rattle: M('Rattling while filling points to a loose fill valve or supply line.', ['fill valve', 'supply line']),
    quiet: QUIET,
  },
  sink: {
    steady_flow: M(
      'Water keeps flowing with the tap off: a worn cartridge or seat lets water through.',
      ['cartridge', 'seat'],
      'epa-faucets',
    ),
    whistle: M('A whistle when the tap is part-open usually comes from a worn washer or cartridge.', ['cartridge']),
    gurgle: M('Gurgling in the drain points to a partial clog or a blocked vent.', ['drain auger']),
    bang: M('A bang when the tap closes is water hammer.', ['water hammer arrestor']),
    hum: M('A hum from under a sink is usually the disposal motor or a vibrating supply line.', ['supply line']),
    rattle: M('Rattling under the sink points to a loose supply line or a disposal with something caught in it.', [
      'supply line',
    ]),
    quiet: QUIET,
  },
  water_heater: {
    steady_flow: M(
      'A steady hiss from a water heater can be water on the burner or a relief valve letting by; look for water at the valve and the base.',
      ['temperature and pressure relief valve'],
      'navedtra-14256',
    ),
    whistle: M(
      'A whistle or scream from a water heater is often the relief valve or a partly closed valve; keep clear of the relief valve outlet.',
      ['temperature and pressure relief valve'],
      'navedtra-14256',
      true,
    ),
    gurgle: M(
      'Rumbling or bubbling in the tank is usually sediment on the bottom being boiled: the tank needs flushing.',
      ['drain valve'],
    ),
    bang: M('Popping or banging while heating is usually sediment on the bottom of the tank.', ['drain valve']),
    hum: M(
      'A hum on an electric water heater is usually a loose heating element; the electrical part is for the technician.',
      ['heating element'],
    ),
    rattle: M('Rattling from the tank points to heavy sediment or loose parts at the burner.', ['drain valve']),
    quiet: QUIET,
  },
  boiler: {
    steady_flow: M(
      'A steady hiss from a boiler can be a leaking valve or steam escaping; the relief valve and fittings need checking.',
      ['pressure relief valve'],
      'navedtra-14256',
    ),
    whistle: M(
      'A kettle-like whistle from a boiler usually means scale or low flow in the heat exchanger (kettling).',
      ['heat exchanger'],
      'usfa-heating',
    ),
    gurgle: M('Gurgling in the pipes or radiators is air in the system: it needs bleeding.', ['radiator bleed key']),
    bang: M('Banging in the pipes is water hammer or kettling; pressure and flow need checking.', ['pressure gauge']),
    hum: M('A steady hum is usually the circulator pump or a vibrating pipe.', ['circulator pump']),
    rattle: M('Rattling points to a loose pump, panel or pipe clip.', ['circulator pump']),
    quiet: QUIET,
  },
  furnace: {
    steady_flow: M(
      'A steady rush of air is normal while the blower runs. A hiss at the gas valve or burners is different: if you smell gas, leave and call the gas company.',
      ['blower'],
      'usfa-heating',
    ),
    whistle: M(
      'A whistle or squeal from a furnace is usually a slipping blower belt, a worn motor bearing or a clogged filter.',
      ['blower belt', 'air filter'],
    ),
    gurgle: M('Gurgling from a high-efficiency furnace is usually the condensate drain or trap.', ['condensate trap']),
    bang: M(
      'A bang when the burners light is delayed ignition: dirty burners. Do not keep restarting it.',
      ['burners'],
      'usfa-heating',
      true,
    ),
    hum: M('A loud hum is usually the blower motor or its capacitor.', ['blower motor', 'capacitor']),
    rattle: M('Rattling points to a loose panel, duct or blower wheel.', ['blower wheel']),
    quiet: QUIET,
  },
  ac: {
    steady_flow: M(
      'A steady hiss from the outdoor unit or lines can be a refrigerant leak; a technician must check it.',
      ['refrigerant line'],
    ),
    whistle: M('A squeal from the outdoor unit is usually the fan motor bearings or a belt.', ['condenser fan motor']),
    gurgle: M('Gurgling is usually the condensate drain or refrigerant flow; check the drain line.', [
      'condensate drain',
    ]),
    bang: M(
      'Banging from the compressor points to a loose or failing compressor part; switch it off and have it checked.',
      ['compressor'],
    ),
    hum: M('A hum with the fan not turning usually means a failed capacitor or a stuck motor.', [
      'capacitor',
      'condenser fan motor',
    ]),
    rattle: M('Rattling points to loose panels, debris in the fan or a failing fan motor.', ['condenser fan motor']),
    quiet: QUIET,
  },
  electrical: {
    steady_flow: M(
      'A steady hiss or sizzle near electrical equipment can be arcing. Keep away and do not touch the panel.',
      [],
      'osha-electrical',
      true,
    ),
    whistle: M(
      'A high whine from electrical equipment can be a failing transformer, dimmer or breaker; an electrician must check it.',
      ['breaker'],
      'osha-electrical',
      true,
    ),
    gurgle: M(
      'A bubbling sound near electrical equipment is unusual; it may be pipes nearby. Do not touch the panel.',
      [],
      'osha-electrical',
    ),
    bang: M(
      'A pop or crack from a panel or outlet is arcing. Keep away, do not reset anything, and have an electrician check it.',
      ['breaker'],
      'osha-electrical',
      true,
    ),
    hum: M(
      'A buzz or hum from a breaker panel or outlet usually means a loose connection or an overloaded breaker. Keep away and do not touch it.',
      ['breaker'],
      'osha-electrical',
      true,
    ),
    rattle: M(
      'A chattering sound from a panel can be a failing breaker or contactor. Keep away.',
      ['breaker'],
      'osha-electrical',
      true,
    ),
    quiet: QUIET,
  },
  motor: {
    steady_flow: M('A steady rush is normal airflow or water flow while the unit runs.', []),
    whistle: M(
      'A squeal from a pump, fan or motor is usually a slipping belt or dry bearings.',
      ['belt', 'bearings'],
      'fm-5-426',
    ),
    gurgle: M('Gurgling at a pump means air in the line or cavitation; check the suction side.', ['pump']),
    bang: M(
      'Knocking from a motor or pump points to worn bearings, a loose mount or cavitation.',
      ['bearings', 'motor mount'],
      'fm-5-426',
    ),
    hum: M('A loud hum with no motion usually means a stuck motor or a failed start capacitor.', [
      'capacitor',
      'motor',
    ]),
    rattle: M('Rattling points to a loose guard, mount or something caught in the fan.', ['motor mount']),
    quiet: QUIET,
  },
};
// The words the caller or the model use for a piece of equipment → its row above.
const KINDS = [
  // Specific equipment first, so "electric water heater", "furnace access panel" and "pilot light" are not
  // read as electrical (red team #5).
  ['water_heater', /water heater|tank heater|hot water/],
  ['boiler', /boiler|radiator|hydronic/],
  ['furnace', /furnace|blower|pilot|heater/],
  ['ac', /\bac\b|a\/c|air condition|heat pump|condenser|compressor|mini.?split|rooftop|rtu|chiller/],
  ['electrical', /breaker|panel|outlet|switch|electric(al)?|transformer|wiring|light/],
  ['sink', /sink|faucet|tap|kitchen/],
  ['toilet', /toilet|tank|flush|bathroom/],
  ['motor', /motor|pump|fan|belt|bearing|disposal|machine/],
];
/** "rooftop unit" → "ac", "breaker panel" → "electrical"; anything unknown → "motor". */
export function equipmentKind(words) {
  const w = String(words ?? '').toLowerCase();
  if (SOUND_MEANINGS[w]) return w;
  return KINDS.find(([, re]) => re.test(w))?.[0] ?? 'motor';
}
export const EQUIPMENT_KINDS = Object.keys(SOUND_MEANINGS);

function frames(pcm) {
  const out = [];
  for (let s = 0; s + FRAME <= pcm.length; s += FRAME) {
    let sum = 0;
    let zc = 0;
    let mean = 0;
    for (let i = s; i < s + FRAME; i++) mean += pcm[i];
    mean /= FRAME;
    for (let i = s; i < s + FRAME; i++) {
      const v = pcm[i] - mean;
      sum += v * v;
      if (i > s && (pcm[i - 1] - mean) * v < 0) zc++;
    }
    const rms = Math.sqrt(sum / FRAME);
    // Pitch strength: best normalised autocorrelation over 300-3000 Hz lags.
    let best = 0;
    if (rms > 30) {
      for (let lag = Math.floor(RATE / 3000); lag <= Math.floor(RATE / 300); lag++) {
        let num = 0;
        let a = 0;
        let b = 0;
        for (let i = s; i + lag < s + FRAME; i++) {
          const x = pcm[i] - mean;
          const y = pcm[i + lag] - mean;
          num += x * y;
          a += x * x;
          b += y * y;
        }
        const r = a && b ? num / Math.sqrt(a * b) : 0;
        if (r > best) best = r;
      }
    }
    // Mains hum: strong periodicity at 50/60 Hz or their 100/120 Hz harmonic (lags 133-320 samples).
    let low = 0;
    let lowLag = 0;
    if (rms > 30) {
      for (const lag of [133, 160, 267, 320]) {
        for (const l of [lag - 1, lag, lag + 1]) {
          let num = 0;
          let a = 0;
          let b = 0;
          for (let i = s; i + l < s + FRAME; i++) {
            const x = pcm[i] - mean;
            const y = pcm[i + l] - mean;
            num += x * y;
            a += x * x;
            b += y * y;
          }
          const r = a && b ? num / Math.sqrt(a * b) : 0;
          if (r > low) {
            low = r;
            lowLag = lag === 133 || lag === 267 ? 60 : 50;
          } // mains family: 60 Hz or 50 Hz
        }
      }
    }
    out.push({ db: 20 * Math.log10(Math.max(1, rms)), zcr: zc / FRAME, pitch: best, low, lowLag });
  }
  return out;
}

/** Measures a 16-bit mono PCM WAV (16 kHz) and returns the sound signatures found in it. */
export function analyseSound(wav, { fixture = 'motor' } = {}) {
  const w = parseWav(wav);
  if (!w) throw new Error('audio must be a 16-bit PCM WAV');
  // Only what the page records: 16 kHz, mono, 16-bit. Anything else would be measured with the
  // wrong thresholds, and the length cited as evidence comes from the samples, never the header (red team #4).
  if (w.channels !== 1 || w.rate !== RATE || w.bits !== 16)
    throw new Error('audio must be 16 kHz mono 16-bit, as the call page records it');
  const data = w.dataStart;
  const end = wav.length - ((wav.length - data) % 2);
  const pcm = new Int16Array(wav.buffer.slice(wav.byteOffset + data, wav.byteOffset + end));
  const seconds = pcm.length / RATE;
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
  if (share(hiss.length) >= 0.6 && spread < 18)
    found.push({
      sound: 'steady_flow',
      share: share(hiss.length),
      detail: `Steady hiss for ${Math.round(share(hiss.length) * 100)}% of ${seconds.toFixed(1)} s`,
    });
  // A whistle is high (300 Hz and up, so enough zero crossings); a low tone is a hum, below.
  const tone = f.filter((x) => x.db > LOUD_DB && x.pitch >= 0.75 && x.zcr > 0.035);
  if (share(tone.length) >= 0.15)
    found.push({
      sound: 'whistle',
      share: share(tone.length),
      detail: `Clear tone for ${Math.round(share(tone.length) * 100)}% of the clip`,
    });
  // Gurgle: low-pitched (few crossings) bursts that rise and fall, not a steady level.
  // Bubbles are irregular; a voice is a clear low pitch (low >= 0.6) and is not a gurgle (red team #5).
  const low = f.map((x) => x.db > LOUD_DB + 3 && x.zcr < 0.05 && x.low < 0.6);
  let bursts = 0;
  for (let i = 1; i < low.length; i++) if (low[i] && !low[i - 1]) bursts++;
  if (bursts >= 4 && share(low.filter(Boolean).length) >= 0.1)
    found.push({ sound: 'gurgle', share: share(low.filter(Boolean).length), detail: `${bursts} low bubbling bursts` });
  // Bang: one frame far above the clip's median and its neighbours; many of them is a rattle.
  let bangs = 0;
  for (let i = 1; i < f.length - 1; i++) if (f[i].db - median > 20 && f[i].db - f[i - 1].db > 12) bangs++;
  if (bangs >= 1 && bangs <= 6)
    found.push({ sound: 'bang', share: share(bangs), detail: `${bangs} sharp knock${bangs === 1 ? '' : 's'}` });
  if (bangs > 6) found.push({ sound: 'rattle', share: share(bangs), detail: `${bangs} rapid knocks (rattling)` });
  // Hum: a low, steady electrical or motor tone (few zero crossings, strong 50-120 Hz periodicity).
  // Mains hum holds one pitch and one level; a voice near the phone moves in both (red team #5).
  const hum = f.filter((x) => x.db > LOUD_DB - 6 && x.zcr < 0.05 && x.low >= 0.8);
  const lagCount = new Map();
  for (const x of hum) lagCount.set(x.lowLag, (lagCount.get(x.lowLag) ?? 0) + 1);
  const steadyPitch = hum.length ? Math.max(...lagCount.values()) / hum.length : 0;
  const humSpread = hum.length ? Math.max(...hum.map((x) => x.db)) - Math.min(...hum.map((x) => x.db)) : 99;
  if (share(hum.length) >= 0.5 && steadyPitch >= 0.8 && humSpread < 12)
    found.push({
      sound: 'hum',
      share: share(hum.length),
      detail: `Steady low hum for ${Math.round(share(hum.length) * 100)}% of the clip`,
    });
  if (!found.length && share(loud.length) < 0.2)
    found.push({ sound: 'quiet', share: share(f.length - loud.length), detail: 'Quiet most of the clip' });
  const table = SOUND_MEANINGS[equipmentKind(fixture)];
  return { seconds, levelDb: Math.round(median), findings: found.map((x) => ({ ...x, ...table[x.sound] })) };
}

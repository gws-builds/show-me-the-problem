// Camera guidance computed in code from the SAM mask: no model call.
// The arrow points where the caller should move the phone so the part sits in the
// middle of the frame at a usable size; "locked" means two analyzed frames in a row
// agree that it is centred, big enough and steady.

// Mean luma 0-255 of the sent frame. Below DARK_LUMA the call advises more light; arrows stay
// on while SAM still outlines the part (Oct 30 test: SAM outlined a faucet in a digitally
// darkened frame down to luma 12), and only below BLACK_LUMA, or with no outline, does the
// screen show "too dark" instead of arrows.
export const DARK_LUMA = 45;
export const BLACK_LUMA = 15;
export const CENTER_TOL = 0.17; // centroid within 17% of the middle on both axes
export const MIN_AREA = 0.04; // part covers at least 4% of the frame
export const MAX_AREA = 0.7;
export const STEADY = 0.06; // centroid moved less than 6% between frames

const DARK_WORDS = "It is too dark for me to see. Turn on a light, or shine a second phone's flashlight on it.";

/**
 * geo: maskGeometry of the best record ({ cx, cy, area }) or null.
 * prev: the previous guidance (for the lock), luma: mean luma of that frame or null.
 * Returns { state, arrow, words, cx, cy, area }.
 *   state: 'dark' | 'searching' | 'adjust' | 'hold' | 'locked'
 *   arrow: 'up' | 'down' | 'left' | 'right' | 'closer' | 'back' | null
 */
export function guide(geo, { prev = null, luma = null } = {}) {
  const dim = typeof luma === 'number' && luma < DARK_LUMA;
  if ((dim && !(geo?.area > 0)) || (typeof luma === 'number' && luma < BLACK_LUMA))
    return { state: 'dark', arrow: null, words: DARK_WORDS, luma };
  if (!geo || !(geo.area > 0))
    return { state: 'searching', arrow: null, words: 'Point the camera at it, slowly.', luma };
  const { cx, cy, area } = geo;
  const dx = cx - 0.5;
  const dy = cy - 0.5;
  const base = { cx: round(cx), cy: round(cy), area: round(area), luma };
  if (Math.abs(dx) > CENTER_TOL || Math.abs(dy) > CENTER_TOL) {
    if (Math.abs(dy) >= Math.abs(dx))
      return {
        ...base,
        state: 'adjust',
        arrow: dy < 0 ? 'up' : 'down',
        words: dy < 0 ? 'Tilt up a little.' : 'Tilt down a little.',
      };
    return {
      ...base,
      state: 'adjust',
      arrow: dx < 0 ? 'left' : 'right',
      words: dx < 0 ? 'Move a little to the left.' : 'Move a little to the right.',
    };
  }
  if (area < MIN_AREA) return { ...base, state: 'adjust', arrow: 'closer', words: 'Move closer.' };
  if (area > MAX_AREA) return { ...base, state: 'adjust', arrow: 'back', words: 'Back up a little.' };
  const steady =
    prev &&
    (prev.state === 'hold' || prev.state === 'locked') &&
    Math.hypot((prev.cx ?? 9) - cx, (prev.cy ?? 9) - cy) < STEADY;
  return steady
    ? { ...base, state: 'locked', arrow: null, words: 'Got it. Hold still.' }
    : { ...base, state: 'hold', arrow: null, words: 'Hold still.' };
}

const round = (v) => Math.round(v * 1000) / 1000;

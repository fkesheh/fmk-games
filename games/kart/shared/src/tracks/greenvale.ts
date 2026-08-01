// ============================================================================
// KART GP circuit — GREENVALE RING.
//
// The original (and, until now, only) KART GP circuit, unchanged: the exact
// control loop and theme values that used to be hardcoded in track.ts, moved
// out to an authored TrackSource. 598.2 m, counter-clockwise, tightest corner
// 8.5 m radius. Racing on it is byte-identical to before this file existed.
// ============================================================================
import { KPAL } from '../palette.js';
import type { TrackSource } from '../track.js';

/**
 * The control loop. Gate 0 (start/finish) lands on the FIRST point, [0,-82],
 * and the grid is laid back along the road from there through the [-24,-58]
 * bend — which is exactly why the grid must follow arc length and not gate 0's
 * tangent.
 */
export const GREENVALE_POINTS: ReadonlyArray<readonly [number, number]> = [
  [0, -82], [58, -80], [92, -58], [88, -16], [58, 4], [62, 44], [28, 68],
  [-18, 60], [-66, 64], [-92, 38], [-78, 2], [-92, -38], [-58, -68], [-24, -58],
];

export const greenvale: TrackSource = {
  id: 'greenvale',
  name: 'Greenvale Ring',
  blurb: 'Open parkland, long sweepers and one late hairpin — the KART GP home circuit.',
  points: GREENVALE_POINTS,
  theme: {
    sky: KPAL.sky,
    horizon: KPAL.horizon,
    fog: KPAL.fog,
    fogDensity: 0.006,
    sunDir: [0.5, -1, 0.35],
    sunColor: KPAL.curbWhite,
    sunIntensity: 1.6,
    hemiIntensity: 0.6,
  },
};

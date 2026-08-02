// ============================================================================
// KART GP circuit — HIGHLAND LONG.
//
// THE LONG ONE. 891 m and seventeen corners, nearly half as long again as
// Greenvale: a full lap is a sequence of distinct sectors rather than one
// rhythm — the fast open moor, the drop into the tight infield loop, and the
// long climb back to the line. Consistency beats a hero lap.
//
// MEASURED (validateTrack + buildTrack, tracks.test.ts asserts it stays legal):
//   891.3 m long, counter-clockwise, 33 control points
//   tightest corner 9.6 m radius (floor is MIN_CORNER_RADIUS 7.2 m)
//   closest the road comes to itself 24.1 m (floor is MIN_SELF_CLEARANCE 12.4 m)
//   3.48 m between centreline samples; bbox x [-164, 143] z [-105, 115]
// ============================================================================
import { HIGHLAND_PALETTE, CIRCUIT_SUN } from './palette.js';
import type { TrackSource } from '../track.js';

/**
 * The control loop. Gate 0 (start/finish) lands on the FIRST point and the
 * 42 m of starting grid is laid BACK along the road from there — so point 0 sits
 * on the 143m start straight, not in a corner.
 */
export const HIGHLAND_POINTS: ReadonlyArray<readonly [number, number]> = [
  [-89.9, -96.1], [-62.5, -97.8], [-35.2, -99.6], [-7.8, -101.3], [19.5, -103], [46.9, -104.8],
  [73.6, -100.4], [97, -86.2], [120.1, -71.4], [138.4, -51.5], [143.2, -24.9], [133.1, 0.2],
  [123.3, 25.1], [135.6, 49.1], [138.4, 75.6], [122, 96.7], [96.2, 106], [70.2, 114.6],
  [43.2, 114], [17.4, 104.7], [-8.4, 95.3], [-34.1, 85.2], [-42, 61.2], [-46.9, 38.2],
  [-68.5, 29.9], [-93.7, 32.9], [-120.4, 29], [-140.4, 10.7], [-157.2, -11], [-163.7, -37.2],
  [-158.8, -64.1], [-142.8, -85.9], [-117.2, -94.3],
];

export const highland: TrackSource = {
  id: 'highland',
  name: 'Highland Long',
  blurb: '891 m of cold moorland — the endurance lap, and the tyre test.',
  points: HIGHLAND_POINTS,
  theme: {
    sky: HIGHLAND_PALETTE.sky,
    horizon: HIGHLAND_PALETTE.horizon,
    fog: HIGHLAND_PALETTE.fog,
    fogDensity: 0.0048,
    sunDir: [0.45, -0.85, -0.4],
    sunColor: CIRCUIT_SUN.highland,
    sunIntensity: 1.2,
    hemiIntensity: 0.85,
    palette: HIGHLAND_PALETTE,
  },
};

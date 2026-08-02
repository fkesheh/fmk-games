// ============================================================================
// KART GP circuit — COPPER SPRINT.
//
// THE SPRINT. The shortest circuit on the calendar: seven quick corners, a
// chicane on the back stretch and lap times short enough that a full grid is
// never strung out. Expect to be lapping and being lapped in the same corner —
// clean air is the rarest thing here.
//
// MEASURED (validateTrack + buildTrack, tracks.test.ts asserts it stays legal):
//   395.4 m long, counter-clockwise, 18 control points
//   tightest corner 10.9 m radius (floor is MIN_CORNER_RADIUS 7.2 m)
//   closest the road comes to itself 23.9 m (floor is MIN_SELF_CLEARANCE 12.4 m)
//   1.54 m between centreline samples; bbox x [-71, 69] z [-42, 49]
// ============================================================================
import { COPPER_PALETTE, CIRCUIT_SUN } from './palette.js';
import type { TrackSource } from '../track.js';

/**
 * The control loop. Gate 0 (start/finish) lands on the FIRST point and the
 * 42 m of starting grid is laid BACK along the road from there — so point 0 sits
 * on the 53m start straight, not in a corner.
 */
export const COPPER_POINTS: ReadonlyArray<readonly [number, number]> = [
  [-11.9, -42], [10.2, -42], [32.3, -42], [53.7, -37.9], [67.9, -21.6], [68.5, 0.1],
  [62.6, 21.4], [47.7, 36.8], [26.2, 36.1], [5, 37], [-14.3, 47.8], [-36.1, 47.5],
  [-56.5, 40.2], [-66.3, 20.9], [-70.3, -0.8], [-70, -22.6], [-55.6, -38.7], [-34, -42],
];

export const copper: TrackSource = {
  id: 'copper',
  name: 'Copper Sprint',
  blurb: 'Under 400 m of red clay — at twenty karts the traffic never clears.',
  points: COPPER_POINTS,
  theme: {
    sky: COPPER_PALETTE.sky,
    horizon: COPPER_PALETTE.horizon,
    fog: COPPER_PALETTE.fog,
    fogDensity: 0.0075,
    sunDir: [-0.7, -0.55, 0.45],
    sunColor: CIRCUIT_SUN.copper,
    sunIntensity: 1.5,
    hemiIntensity: 0.55,
    palette: COPPER_PALETTE,
  },
};

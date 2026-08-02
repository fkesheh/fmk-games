// ============================================================================
// KART GP circuit — LANTERN ROW.
//
// THE TECHNICAL ONE. Twenty corners in 518 m and a single straight worth the
// name (the lantern-lit row past the pits). Nothing here is taken flat: it is
// a chain of 10-14 m radius corners where the mini-turbo charge from one
// drift is the entry speed for the next, and a missed apex costs two corners.
//
// MEASURED (validateTrack + buildTrack, tracks.test.ts asserts it stays legal):
//   517.7 m long, counter-clockwise, 32 control points
//   tightest corner 9.5 m radius (floor is MIN_CORNER_RADIUS 7.2 m)
//   closest the road comes to itself 22.7 m (floor is MIN_SELF_CLEARANCE 12.4 m)
//   2.02 m between centreline samples; bbox x [-82, 90] z [-58, 69]
// ============================================================================
import { LANTERN_PALETTE, CIRCUIT_SUN } from './palette.js';
import type { TrackSource } from '../track.js';

/**
 * The control loop. Gate 0 (start/finish) lands on the FIRST point and the
 * 42 m of starting grid is laid BACK along the road from there — so point 0 sits
 * on the 24m start straight, not in a corner.
 */
export const LANTERN_POINTS: ReadonlyArray<readonly [number, number]> = [
  [-23.7, -54.2], [-7.4, -58.1], [8.9, -55], [20.3, -43.1], [32.3, -32.3], [48.1, -33.3],
  [63.6, -38.5], [78.8, -32.7], [87.2, -18.4], [90.1, -1.7], [82, 12.9], [71.7, 21.8],
  [67.2, 32.9], [67.4, 47], [59, 61.7], [41.9, 66.2], [25.4, 69.4], [9.1, 66.7],
  [-2.9, 55.5], [-16.7, 47.3], [-31.8, 52.1], [-45.3, 61.4], [-61.7, 60.2], [-75.1, 50.1],
  [-81.9, 35.1], [-78.2, 19], [-66.8, 6], [-65.1, -10.1], [-70.2, -24.2], [-67.7, -38.1],
  [-55.6, -45.6], [-39.8, -50],
];

export const lantern: TrackSource = {
  id: 'lantern',
  name: 'Lantern Row',
  blurb: 'Twenty corners, one straight, dusk in the park — the drift circuit.',
  points: LANTERN_POINTS,
  theme: {
    sky: LANTERN_PALETTE.sky,
    horizon: LANTERN_PALETTE.horizon,
    fog: LANTERN_PALETTE.fog,
    fogDensity: 0.0062,
    sunDir: [-0.85, -0.42, 0.3],
    sunColor: CIRCUIT_SUN.lantern,
    sunIntensity: 1.3,
    hemiIntensity: 0.5,
    palette: LANTERN_PALETTE,
  },
};

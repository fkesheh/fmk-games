// ============================================================================
// KART GP circuit — CROWN DOUBLE.
//
// THE SIGNATURE CORNERS. Three of them, in order: the DOUBLE APEX at the top
// of the hill (one corner with two distinct tightenings, so the greedy line
// into the first apex wrecks the second), the INCREASING-RADIUS right that
// rewards an early, patient turn-in, and the late CHICANE that decides who
// gets the run onto the 126 m start straight.
//
// MEASURED (validateTrack + buildTrack, tracks.test.ts asserts it stays legal):
//   660.1 m long, counter-clockwise, 29 control points
//   tightest corner 9.5 m radius (floor is MIN_CORNER_RADIUS 7.2 m)
//   closest the road comes to itself 23 m (floor is MIN_SELF_CLEARANCE 12.4 m)
//   2.58 m between centreline samples; bbox x [-124, 113] z [-70, 81]
// ============================================================================
import { CROWN_PALETTE, CIRCUIT_SUN } from './palette.js';
import type { TrackSource } from '../track.js';

/**
 * The control loop. Gate 0 (start/finish) lands on the FIRST point and the
 * 42 m of starting grid is laid BACK along the road from there — so point 0 sits
 * on the 126m start straight, not in a corner.
 */
export const CROWN_POINTS: ReadonlyArray<readonly [number, number]> = [
  [-41.5, -67.2], [-18.5, -67.7], [4.5, -68.2], [27.5, -68.6], [50.5, -69.1], [73.5, -69.5],
  [95.1, -63.6], [106.3, -43.9], [113.1, -22], [103.4, -2.1], [85.4, 12.7], [78.5, 33.9],
  [81.3, 55.5], [68.5, 71.7], [47.4, 77.8], [24.9, 80.1], [7.1, 66.1], [-13.1, 58],
  [-33.4, 68.5], [-55.5, 70.4], [-75.8, 59.6], [-95.9, 48.3], [-109.6, 30.4], [-118.4, 9.1],
  [-124.3, -12.9], [-118.4, -34.9], [-107.2, -54.9], [-87.4, -65.8], [-64.5, -66.8],
];

export const crown: TrackSource = {
  id: 'crown',
  name: 'Crown Double',
  blurb: 'A double-apex left, an increasing-radius sweep and a late chicane.',
  points: CROWN_POINTS,
  theme: {
    sky: CROWN_PALETTE.sky,
    horizon: CROWN_PALETTE.horizon,
    fog: CROWN_PALETTE.fog,
    fogDensity: 0.0058,
    sunDir: [0.75, -0.5, 0.25],
    sunColor: CIRCUIT_SUN.crown,
    sunIntensity: 1.6,
    hemiIntensity: 0.6,
    palette: CROWN_PALETTE,
  },
};

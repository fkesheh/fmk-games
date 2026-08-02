// ============================================================================
// KART GP circuit — THUNDER MILE.
//
// THE STRAIGHT. 177 m flat out along the valley floor, which is where the
// slipstream and a saved nitro actually pay — and then the road runs out into
// a 12 m hairpin that folds the circuit back on itself. Overtake on the brakes
// or not at all; the twisting return leg gives almost nothing back.
//
// MEASURED (validateTrack + buildTrack, tracks.test.ts asserts it stays legal):
//   744.7 m long, counter-clockwise, 29 control points
//   tightest corner 9.5 m radius (floor is MIN_CORNER_RADIUS 7.2 m)
//   closest the road comes to itself 22.9 m (floor is MIN_SELF_CLEARANCE 12.4 m)
//   2.91 m between centreline samples; bbox x [-135, 138] z [-75, 74]
// ============================================================================
import { THUNDER_PALETTE, CIRCUIT_SUN } from './palette.js';
import type { TrackSource } from '../track.js';

/**
 * The control loop. Gate 0 (start/finish) lands on the FIRST point and the
 * 42 m of starting grid is laid BACK along the road from there — so point 0 sits
 * on the 177m start straight, not in a corner.
 */
export const THUNDER_POINTS: ReadonlyArray<readonly [number, number]> = [
  [-88.4, -74], [-62, -74], [-35.7, -74], [-9.4, -74], [16.9, -74], [43.2, -74],
  [69.6, -74], [95.9, -74], [122.2, -73.7], [138, -55.3], [128.4, -32.5], [102.5, -30],
  [76.2, -30], [50.4, -26.8], [35.4, -6.3], [42.3, 18.2], [47.1, 43], [28.4, 60.1],
  [4.2, 70.4], [-21.3, 74.1], [-45.6, 64.1], [-70.7, 53.4], [-87.3, 34.1], [-84.1, 11.9],
  [-92.9, -4.8], [-114.1, -12.6], [-132.2, -30.5], [-133.4, -56.4], [-114.6, -73.3],
];

export const thunder: TrackSource = {
  id: 'thunder',
  name: 'Thunder Mile',
  blurb: 'A 177 m desert straight into the heaviest braking zone on the calendar.',
  points: THUNDER_POINTS,
  theme: {
    sky: THUNDER_PALETTE.sky,
    horizon: THUNDER_PALETTE.horizon,
    fog: THUNDER_PALETTE.fog,
    fogDensity: 0.006,
    sunDir: [0.2, -1, -0.15],
    sunColor: CIRCUIT_SUN.thunder,
    sunIntensity: 1.9,
    hemiIntensity: 0.62,
    palette: THUNDER_PALETTE,
  },
};

// ============================================================================
// KART GP circuit — COBALT COAST.
//
// THE FAST ONE. Every corner is a 44 m-plus sweeper, so the lap is one long
// committed arc: lift, place the kart, and carry the speed. There is no
// hairpin to recover a bad exit and no straight long enough to slipstream
// past a clean lap — position is won by not scrubbing speed.
//
// MEASURED (validateTrack + buildTrack, tracks.test.ts asserts it stays legal):
//   702.6 m long, counter-clockwise, 27 control points
//   tightest corner 44 m radius (floor is MIN_CORNER_RADIUS 7.2 m)
//   closest the road comes to itself 24.8 m (floor is MIN_SELF_CLEARANCE 12.4 m)
//   2.74 m between centreline samples; bbox x [-133, 118] z [-106, 92]
// ============================================================================
import { COBALT_PALETTE, CIRCUIT_SUN } from './palette.js';
import type { TrackSource } from '../track.js';

/**
 * The control loop. Gate 0 (start/finish) lands on the FIRST point and the
 * 42 m of starting grid is laid BACK along the road from there — so point 0 sits
 * on the 58m start straight, not in a corner.
 */
export const COBALT_POINTS: ReadonlyArray<readonly [number, number]> = [
  [-50.5, -93.8], [-25.9, -102.3], [-0.1, -105.6], [25.6, -102.1], [49.5, -92], [72.8, -80.3],
  [94.4, -65.9], [109.8, -45.1], [117.3, -20.3], [116.3, 5.6], [108.5, 30.3], [93.2, 51.2],
  [72, 66.2], [48.8, 77.9], [24.9, 88.2], [-0.8, 91.8], [-26.5, 88], [-51.5, 81],
  [-76.5, 73.7], [-98.9, 60.7], [-116, 41.1], [-127.4, 17.8], [-133, -7.5], [-128.8, -33],
  [-117.2, -56.2], [-98.6, -74.2], [-75, -85],
];

export const cobalt: TrackSource = {
  id: 'cobalt',
  name: 'Cobalt Coast',
  blurb: 'Six linked sweepers above the sea — barely a braking point on the whole lap.',
  points: COBALT_POINTS,
  theme: {
    sky: COBALT_PALETTE.sky,
    horizon: COBALT_PALETTE.horizon,
    fog: COBALT_PALETTE.fog,
    fogDensity: 0.0045,
    sunDir: [0.35, -1, 0.5],
    sunColor: CIRCUIT_SUN.cobalt,
    sunIntensity: 1.75,
    hemiIntensity: 0.7,
    palette: COBALT_PALETTE,
  },
};

// ============================================================================
// KART GP circuit — SWITCHBACK RIDGE.
//
// THE AWKWARD ONE. Every major corner is a DECREASING RADIUS: a wide, fast,
// inviting entry (r 40+) that tightens to 11-15 m at the exit. Commit to the
// entry speed the first half offers and the second half puts you on the grass;
// the reversing esses between them never let the kart settle either.
//
// MEASURED (validateTrack + buildTrack, tracks.test.ts asserts it stays legal):
//   802.9 m long, counter-clockwise, 36 control points
//   tightest corner 9.5 m radius (floor is MIN_CORNER_RADIUS 7.2 m)
//   closest the road comes to itself 22.8 m (floor is MIN_SELF_CLEARANCE 12.4 m)
//   3.14 m between centreline samples; bbox x [-120, 128] z [-99, 94]
// ============================================================================
import { SWITCHBACK_PALETTE, CIRCUIT_SUN } from './palette.js';
import type { TrackSource } from '../track.js';

/**
 * The control loop. Gate 0 (start/finish) lands on the FIRST point and the
 * 42 m of starting grid is laid BACK along the road from there — so point 0 sits
 * on the 103m start straight, not in a corner.
 */
export const SWITCHBACK_POINTS: ReadonlyArray<readonly [number, number]> = [
  [-38.6, -92.1], [-15.7, -94], [7.2, -95.9], [30.2, -97.7], [53.1, -99.4], [75.4, -94.5],
  [91.7, -81.4], [101.5, -64.8], [94.4, -46.7], [86.7, -26.4], [95.6, -5.5], [113.6, 8.7],
  [124.7, 28.5], [127.6, 51.3], [116.6, 69.9], [94.7, 77], [72.8, 84], [50.3, 86.1],
  [30.5, 74.9], [12.1, 61.2], [-9.4, 64.4], [-23.4, 82.6], [-43, 93.6], [-65.1, 88.7],
  [-86.2, 79.5], [-103.9, 65.2], [-114.8, 45.1], [-119.6, 23.2], [-105, 7.2], [-93, -7.7],
  [-97.1, -24.4], [-112, -37.2], [-116.9, -59.4], [-105, -79.4], [-84.4, -88.4], [-61.5, -90.2],
];

export const switchback: TrackSource = {
  id: 'switchback',
  name: 'Switchback Ridge',
  blurb: 'Four corners that open, then snap shut. Greed is punished here.',
  points: SWITCHBACK_POINTS,
  theme: {
    sky: SWITCHBACK_PALETTE.sky,
    horizon: SWITCHBACK_PALETTE.horizon,
    fog: SWITCHBACK_PALETTE.fog,
    fogDensity: 0.006,
    sunDir: [-0.3, -0.95, 0.55],
    sunColor: CIRCUIT_SUN.switchback,
    sunIntensity: 1.1,
    hemiIntensity: 0.9,
    palette: SWITCHBACK_PALETTE,
  },
};

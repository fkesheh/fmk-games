// ============================================================================
// FROZEN CONTRACT — KART GP: circuit geometry. Pure math/data, no I/O.
// The SAME TrackDef feeds the server's gate validation and the client's mesh.
// ============================================================================
import { GATES, ROAD_HALF_W } from './config.js';
import { KPAL } from './palette.js';

/** Authored control points (x/z meters, closed loop, counter-clockwise travel). */
export const TRACK_POINTS: ReadonlyArray<readonly [number, number]> = [
  [0, -82], [58, -80], [92, -58], [88, -16], [58, 4], [62, 44], [28, 68],
  [-18, 60], [-66, 64], [-92, 38], [-78, 2], [-92, -38], [-58, -68], [-24, -58],
];

export interface TrackTheme {
  sky: string;
  horizon: string;
  fog: string;
  fogDensity: number;
  sunDir: [number, number, number];
  sunColor: string;
  sunIntensity: number;
  hemiIntensity: number;
}

export interface GateDef {
  x: number;
  z: number;
  // tangent direction of travel at the gate (unit-ish)
  tx: number;
  tz: number;
}

export interface TrackDef {
  points: ReadonlyArray<readonly [number, number]>;
  centerline: Array<[number, number]>; // sampled closed polyline (SAMPLES points)
  roadHalfW: number;
  gates: GateDef[]; // GATES entries, gate 0 = start/finish at t=0
  theme: TrackTheme;
  length: number; // approx centerline length
}

const SAMPLES = 256;

/** Closed Catmull-Rom sample at uniform parameter t in [0,1). */
function catmull(points: ReadonlyArray<readonly [number, number]>, t: number): [number, number] {
  const n = points.length;
  const f = ((t % 1) + 1) % 1 * n;
  const i = Math.floor(f) % n;
  const u = f - Math.floor(f);
  const p0 = points[(i - 1 + n) % n]!;
  const p1 = points[i]!;
  const p2 = points[(i + 1) % n]!;
  const p3 = points[(i + 2) % n]!;
  const cr = (a: number, b: number, c: number, d: number): number =>
    0.5 * (2 * b + u * (c - a + u * (2 * a - 5 * b + 4 * c - d + u * (3 * (b - c) + d - a))));
  return [cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])];
}

/** Build the track definition (deterministic). Gate i sits at t = i/GATES. */
export function buildTrack(): TrackDef {
  const centerline: Array<[number, number]> = [];
  for (let i = 0; i < SAMPLES; i++) centerline.push(catmull(TRACK_POINTS, i / SAMPLES));
  let length = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const a = centerline[i]!;
    const b = centerline[(i + 1) % SAMPLES]!;
    length += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const gates: GateDef[] = [];
  for (let g = 0; g < GATES; g++) {
    const idx = Math.round((g / GATES) * SAMPLES) % SAMPLES;
    const a = centerline[idx]!;
    const b = centerline[(idx + 1) % SAMPLES]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    gates.push({ x: a[0], z: a[1], tx: dx / l, tz: dz / l });
  }
  return {
    points: TRACK_POINTS,
    centerline,
    roadHalfW: ROAD_HALF_W,
    gates,
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
    length,
  };
}

/** Nearest centerline sample; lateral is signed distance (left of travel = +). */
export function closestOnTrack(
  track: TrackDef,
  x: number,
  z: number,
): { index: number; dist: number; lateral: number } {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < track.centerline.length; i++) {
    const c = track.centerline[i]!;
    const d = (c[0] - x) * (c[0] - x) + (c[1] - z) * (c[1] - z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const c = track.centerline[best]!;
  const nxt = track.centerline[(best + 1) % track.centerline.length]!;
  const tx = nxt[0] - c[0];
  const tz = nxt[1] - c[1];
  const l = Math.hypot(tx, tz) || 1;
  // signed lateral: cross(tangent, toPoint) (z-down coordinate handedness)
  const lateral = ((x - c[0]) * (tz / l) - (z - c[1]) * (tx / l)) * -1;
  return { index: best, dist: Math.sqrt(bestD), lateral };
}

/** Road when |lateral| <= roadHalfW (with a small shoulder margin). */
export function surfaceAt(track: TrackDef, x: number, z: number): 'road' | 'grass' {
  const c = closestOnTrack(track, x, z);
  return Math.abs(c.lateral) <= track.roadHalfW + 0.4 ? 'road' : 'grass';
}

/** Grid slot i: two columns behind the start line (gate 0), facing travel. */
export function gridSlot(track: TrackDef, i: number): { x: number; z: number; yaw: number } {
  const g = track.gates[0]!;
  const row = Math.floor(i / 2);
  const col = i % 2 === 0 ? -1 : 1;
  const back = 6 + row * 4; // meters behind the line
  const side = 2.2 * col;
  const x = g.x - g.tx * back + -g.tz * side;
  const z = g.z - g.tz * back + g.tx * side;
  const yaw = Math.atan2(-g.tx, -g.tz); // face along the tangent (platform yaw convention)
  return { x, z, yaw };
}

// ============================================================================
// FROZEN CONTRACT — KART GP: circuit geometry. Pure math/data, no I/O.
// The SAME TrackDef feeds the server's gate validation and the client's mesh.
//
// MULTI-TRACK: nothing in this file names a specific circuit. A track is
// AUTHORED as a `TrackSource` (games/kart/shared/src/tracks/*.ts), registered
// in tracks/index.ts, and COMPILED by buildTrack(source) into the TrackDef
// every consumer already speaks. `buildTrack()` used to close over a single
// module-level control-point array — that implicit singleton is gone, and with
// it the assumption that "the track" is one global object.
// ============================================================================
import {
  BARRIER_OUT,
  GATES,
  GATE_RADIUS,
  GRID_EDGE_MARGIN,
  GRID_LATERAL,
  GRID_ROWS,
  GRID_ROW_BACK0,
  GRID_ROW_GAP,
  ROAD_HALF_W,
} from './config.js';
import type { KPAL } from './palette.js';

/**
 * Registry key of a circuit — ALSO the wire value of `trackId` on kart_joined
 * and kart_snapshot. Adding a circuit is two edits plus the new file: a new
 * file under tracks/, one member here, and one entry in TRACKS in
 * tracks/index.ts (TRACK_LIST there is derived from TRACKS, not hand-edited).
 * The registry is typed `Record<TrackId, TrackSource>`, so a member added
 * here without a TRACKS entry is a COMPILE error — the union cannot silently
 * drift from the set of circuits that actually exist.
 */
export type TrackId =
  | 'greenvale'
  | 'cobalt'
  | 'lantern'
  | 'thunder'
  | 'copper'
  | 'highland'
  | 'crown'
  | 'switchback';

/**
 * Sky / sun / fog for one circuit, plus an optional palette re-skin.
 *
 * `palette` is the extension seam for scenery: any KPAL key may be overridden
 * per circuit (`{ grass: '#c8a86a', grassDark: '#b09250' }` turns the verge to
 * sand) and the renderer resolves colors through `{ ...KPAL, ...theme.palette }`.
 * Track authors may leave it undefined — the shared palette is the default look.
 */
export interface TrackTheme {
  sky: string;
  horizon: string;
  fog: string;
  fogDensity: number;
  sunDir: [number, number, number];
  sunColor: string;
  sunIntensity: number;
  hemiIntensity: number;
  /** Per-circuit overrides of the shared KPAL palette (scenery re-skin). */
  palette?: Partial<Record<keyof typeof KPAL, string>>;
}

/**
 * THE AUTHORING TYPE. Everything a new circuit declares and nothing that can
 * be derived — buildTrack() computes the centreline, gates, length and grid.
 *
 * Authoring rules (validateTrack() enforces every one of them):
 *  - `points` is a CLOSED loop of Catmull-Rom control points in x/z metres,
 *    travelled COUNTER-CLOCKWISE. Do not repeat the first point at the end.
 *  - gate 0 (the start/finish line) lands on the FIRST control point, and the
 *    grid is laid out BACKWARD from there along the road — so the first point
 *    should sit on a stretch with at least GRID_DEPTH_M of road behind it.
 *  - at least MIN_CONTROL_POINTS points; no corner tighter than
 *    MIN_CORNER_RADIUS; the road may never come back within
 *    MIN_SELF_CLEARANCE of itself (barriers would interpenetrate).
 */
export interface TrackSource {
  /** Registry key; the wire value of `trackId`. Must equal its key in TRACKS. */
  readonly id: TrackId;
  /** Display name for the lobby, HUD and results ("Greenvale Ring"). */
  readonly name: string;
  /** One-line flavour for a track-select UI. */
  readonly blurb: string;
  /** Closed Catmull-Rom control loop, x/z metres, counter-clockwise. */
  readonly points: ReadonlyArray<readonly [number, number]>;
  /** Sky/sun/fog + optional palette re-skin. */
  readonly theme: TrackTheme;
}

export interface GateDef {
  x: number;
  z: number;
  // tangent direction of travel at the gate (unit-ish)
  tx: number;
  tz: number;
  /** Centreline sample this gate sits on (the arc walk starts from here). */
  index: number;
}

export interface TrackDef {
  /** The circuit this was compiled from — identity travels WITH the geometry. */
  id: TrackId;
  name: string;
  points: ReadonlyArray<readonly [number, number]>;
  centerline: Array<[number, number]>; // sampled closed polyline (SAMPLES points)
  roadHalfW: number;
  gates: GateDef[]; // GATES entries, gate 0 = start/finish at t=0
  theme: TrackTheme;
  length: number; // approx centerline length
}

/** A point on the centreline plus the unit tangent in the DIRECTION OF TRAVEL. */
export interface TrackPose {
  x: number;
  z: number;
  tx: number;
  tz: number;
}

export const SAMPLES = 256;
/**
 * validateTrack resamples 4x denser than the runtime centreline: at the runtime
 * ~2.3 m spacing a tight apex between two samples reads as less curved than it
 * is — a false negative that would let an illegal corner through. Sampling
 * denser is authoring-time / test-time only cost: the self-intersection and
 * self-clearance checks are O(n^2), so this is 16x more pair tests (~1M) —
 * fine here, but do NOT call validateTrack on a hot path.
 */
export const VALIDATE_SAMPLES = SAMPLES * 4; // 1024

// ---- authoring limits (validateTrack) ---------------------------------------
/** Catmull-Rom needs 4; a closed circuit needs enough to have corners. */
export const MIN_CONTROL_POINTS = 6;
/**
 * Tightest corner the ROAD can physically take. At centreline radius R the
 * inner barrier line has radius R - (roadHalfW + BARRIER_OUT); below that it
 * inverts and the barrier folds through itself. 1 m of inner radius is the
 * floor, so the minimum centreline radius is roadHalfW + BARRIER_OUT + 1.
 */
export const MIN_CORNER_RADIUS = ROAD_HALF_W + BARRIER_OUT + 1; // 7.2 m
/** Two stretches of road closer than this share tarmac/barriers. */
export const MIN_SELF_CLEARANCE = 2 * (ROAD_HALF_W + BARRIER_OUT); // 12.4 m
/**
 * Along-track window inside which an "approach" is just the road curving, not
 * the road meeting itself. A hairpin at MIN_CORNER_RADIUS spans ~22.6 m of arc
 * and still leaves 14.4 m of chord, so 4x the road+barrier width is a window
 * that cannot produce a false positive on a legal corner.
 */
export const SELF_CLEARANCE_ARC_WINDOW = 4 * (ROAD_HALF_W + BARRIER_OUT); // 24.8 m
/** Metres of road the starting grid occupies behind the line (slot 0..MAX). */
export const GRID_DEPTH_M = GRID_ROW_BACK0 + (GRID_ROWS - 1) * GRID_ROW_GAP;
/** A circuit shorter than this would wrap the grid past its own start line. */
export const MIN_TRACK_LENGTH = GRID_DEPTH_M + Math.max(60, GATES * GATE_RADIUS);

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

/**
 * Sample a source's control loop into the closed centreline polyline.
 * `count` defaults to SAMPLES (the runtime density every consumer — the wire,
 * the gates, closestOnTrack, the client mesh — depends on); validateTrack is
 * the only caller that passes VALIDATE_SAMPLES.
 */
function sampleCenterline(
  points: ReadonlyArray<readonly [number, number]>,
  count: number = SAMPLES,
): Array<[number, number]> {
  const centerline: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) centerline.push(catmull(points, i / count));
  return centerline;
}

/**
 * Compile an authored circuit into the TrackDef every consumer speaks
 * (deterministic — the server and the client build byte-identical geometry
 * from the same source). Gate i sits at t = i/GATES.
 */
export function buildTrack(source: TrackSource): TrackDef {
  const centerline = sampleCenterline(source.points);
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
    gates.push({ x: a[0], z: a[1], tx: dx / l, tz: dz / l, index: idx });
  }
  return {
    id: source.id,
    name: source.name,
    points: source.points,
    centerline,
    roadHalfW: ROAD_HALF_W,
    gates,
    theme: source.theme,
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

/**
 * THE arc-length walk — the one implementation, shared by the starting grid
 * and by kids-mode pure pursuit (sim.ts). Walks `metres` along the centreline
 * from sample `fromIndex`: forward when positive, BACKWARD when negative, and
 * interpolates within the final segment so the answer is exact rather than
 * snapped to a sample (mean sample spacing on a ~600 m circuit is ~2.3 m).
 *
 * `tx`/`tz` is always the unit tangent in the DIRECTION OF TRAVEL, whichever
 * way the walk went. Following the road by arc length is what makes the grid
 * follow the road's curve; the old grid extrapolated along gate 0's frozen
 * tangent — a straight ray that left the tarmac by slot 4.
 */
export function pointAtArc(track: TrackDef, fromIndex: number, metres: number): TrackPose {
  const cl = track.centerline;
  const n = cl.length;
  const fwd = metres >= 0;
  // a walk longer than the circuit wraps; keep the loop bounded either way
  let remain = Math.min(Math.abs(metres), track.length);
  let i = ((Math.round(fromIndex) % n) + n) % n;
  for (let steps = 0; ; steps++) {
    const j = fwd ? (i + 1) % n : (i - 1 + n) % n;
    const a = cl[i]!;
    const b = cl[j]!;
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (remain <= seg || steps >= n) {
      const u = seg > 1e-9 ? Math.min(1, remain / seg) : 0;
      // tangent points DOWN-track: a->b going forward, b->a going backward
      const t0 = fwd ? a : b;
      const t1 = fwd ? b : a;
      const tx = t1[0] - t0[0];
      const tz = t1[1] - t0[1];
      const l = Math.hypot(tx, tz) || 1;
      return { x: a[0] + (b[0] - a[0]) * u, z: a[1] + (b[1] - a[1]) * u, tx: tx / l, tz: tz / l };
    }
    remain -= seg;
    i = j;
  }
}

/** Road when |lateral| <= roadHalfW (with a small shoulder margin). */
export function surfaceAt(track: TrackDef, x: number, z: number): 'road' | 'grass' {
  const c = closestOnTrack(track, x, z);
  return Math.abs(c.lateral) <= track.roadHalfW + 0.4 ? 'road' : 'grass';
}

/**
 * Grid slot i: two staggered columns laid BACK ALONG THE ROAD from the start
 * line, like a real F1 grid. Row r sits GRID_ROW_BACK0 + r*GRID_ROW_GAP metres
 * of ARC behind gate 0 — not that far along gate 0's tangent — and the ±lateral
 * offset is taken from the LOCAL normal at that arc position, so every slot
 * stays the same distance from the centreline no matter how the road bends.
 *
 * The lateral is clamped into the tarmac (roadHalfW minus a kart's half-width),
 * so a narrower future circuit shrinks the stagger instead of starting karts in
 * the barriers. sim.test.ts asserts |lateral| < ROAD_HALF_W for every slot.
 */
export function gridSlot(track: TrackDef, i: number): { x: number; z: number; yaw: number } {
  const row = Math.floor(i / 2);
  const col = i % 2 === 0 ? -1 : 1;
  const back = GRID_ROW_BACK0 + row * GRID_ROW_GAP; // metres of ARC behind the line
  const p = pointAtArc(track, track.gates[0]!.index, -back);
  const maxSide = Math.max(0, track.roadHalfW - GRID_EDGE_MARGIN);
  const side = Math.min(GRID_LATERAL, maxSide) * col;
  // left-of-travel normal is (-tz, tx) — the same handedness closestOnTrack uses
  const x = p.x + -p.tz * side;
  const z = p.z + p.tx * side;
  const yaw = Math.atan2(-p.tx, -p.tz); // face along the tangent (platform yaw convention)
  return { x, z, yaw };
}

// ---- authoring validation ---------------------------------------------------

export interface TrackValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/** Do segments p1->p2 and p3->p4 properly cross (endpoints excluded)? */
function segmentsCross(
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
  p4: readonly [number, number],
): boolean {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < 1e-12) return false; // parallel / degenerate
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return t > 0 && t < 1 && u > 0 && u < 1;
}

/** Circumradius of the sample triangle at i — the local corner radius. */
function radiusAt(cl: ReadonlyArray<readonly [number, number]>, i: number): number {
  const n = cl.length;
  const a = cl[(i - 1 + n) % n]!;
  const b = cl[i]!;
  const c = cl[(i + 1) % n]!;
  const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const area2 = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
  return area2 < 1e-9 ? Infinity : (ab * bc * ca) / (2 * area2);
}

/**
 * Reject a circuit the road cannot physically be built on. THE TRAP THIS
 * CLOSES: Catmull-Rom happily produces a centreline that crosses itself or
 * corners tighter than the road is wide, and every downstream consumer
 * (closestOnTrack, clampToBarrier, the mesh) then silently misbehaves —
 * lateral distance becomes ambiguous where two stretches overlap, and karts
 * teleport between them.
 *
 * Returns EVERY problem found (not just the first) so an author fixes a
 * circuit in one pass. Empty `errors` == the track is legal.
 */
export function validateTrack(source: TrackSource): TrackValidation {
  const errors: string[] = [];
  const pts = source.points;

  if (pts.length < MIN_CONTROL_POINTS) {
    errors.push(
      `only ${pts.length} control points — a closed circuit needs at least ${MIN_CONTROL_POINTS}`,
    );
  }
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      errors.push(`control point ${i} is not finite: [${String(p[0])}, ${String(p[1])}]`);
    }
  }
  if (errors.length > 0) return { ok: false, errors }; // sampling below would be garbage

  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1) {
      errors.push(`control points ${i} and ${(i + 1) % pts.length} are coincident (< 1 m apart)`);
    }
  }

  const cl = sampleCenterline(pts, VALIDATE_SAMPLES);
  const n = cl.length;
  const seg: number[] = [];
  const cum: number[] = [0];
  let length = 0;
  for (let i = 0; i < n; i++) {
    const a = cl[i]!;
    const b = cl[(i + 1) % n]!;
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    seg.push(d);
    length += d;
    cum.push(length);
  }

  if (length < MIN_TRACK_LENGTH) {
    errors.push(
      `circuit is ${length.toFixed(1)} m — shorter than the ${MIN_TRACK_LENGTH.toFixed(0)} m ` +
        `minimum, so the ${GRID_DEPTH_M} m starting grid would wrap past its own start line`,
    );
  }

  // tightest corner
  let minR = Infinity;
  let minRAt = 0;
  for (let i = 0; i < n; i++) {
    const r = radiusAt(cl, i);
    if (r < minR) {
      minR = r;
      minRAt = i;
    }
  }
  if (minR < MIN_CORNER_RADIUS) {
    errors.push(
      `corner radius ${minR.toFixed(1)} m at centreline sample ${minRAt} is tighter than the ` +
        `${MIN_CORNER_RADIUS.toFixed(1)} m minimum — the inner barrier line would invert`,
    );
  }

  // proper self-intersection of the centreline
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // shares the closing vertex
      if (segmentsCross(cl[i]!, cl[(i + 1) % n]!, cl[j]!, cl[(j + 1) % n]!)) {
        errors.push(`centreline crosses itself between samples ${i} and ${j}`);
        i = n; // one report is enough; a crossing invalidates everything below
        break;
      }
    }
  }

  // near-miss: the road coming back alongside itself inside a barrier width
  let minSep = Infinity;
  let minSepAt: [number, number] = [0, 0];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const along = Math.min(cum[j]! - cum[i]!, length - (cum[j]! - cum[i]!));
      if (along < SELF_CLEARANCE_ARC_WINDOW) continue; // just the road bending
      const a = cl[i]!;
      const b = cl[j]!;
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (d < minSep) {
        minSep = d;
        minSepAt = [i, j];
      }
    }
  }
  if (minSep < MIN_SELF_CLEARANCE) {
    errors.push(
      `the road passes within ${minSep.toFixed(1)} m of itself (samples ${minSepAt[0]} and ` +
        `${minSepAt[1]}) — closer than the ${MIN_SELF_CLEARANCE.toFixed(1)} m needed for two ` +
        `roads and their barriers to coexist`,
    );
  }

  return { ok: errors.length === 0, errors };
}

/** validateTrack, but fatal — for registry/startup guards. */
export function assertValidTrack(source: TrackSource): void {
  const v = validateTrack(source);
  if (!v.ok) throw new Error(`invalid track '${source.id}': ${v.errors.join('; ')}`);
}

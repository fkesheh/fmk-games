// ============================================================================
// KART GP — track/environment mesh builder (split out of render.ts; the frozen
// KartScene export still owns the public API). Everything static on the circuit:
//   road ribbon (banded asphalt: worn edges, rubber lines, seeded albedo drift)
//   painted markings (dashes, start line, grid stalls) + repair patches/grime
//   curbs, dirt shoulders, barrier posts, grass slab + seeded tone blobs
//   furniture: start gantry ('KART GP'), apex tire stacks + skid decals, pit
//     building + cones, billboards, lamp posts
//   scatter (3 tree silhouettes in seeded clusters / rocks), mid-distance tree
//     line, two-layer ridgeline horizon (near dark + far hazy)
// All statics are baked into ~1 mesh per material to keep draw calls flat
// (~25 world draw calls total). All scatter is seeded (@platform/shared rng) —
// Math.random is never touched. The cached material factory (mat) stays in
// render.ts and is threaded through here as MatFn so both modules share the one
// material cache. NOTHING here feeds closestOnTrack/barrier math: every add-on
// is a flat paint layer or sits outside the physical barrier band.
// ============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { decoSeed, rng, rngInt, rngRange } from '@platform/shared';
import {
  KPAL,
  MAX_PLAYERS,
  closestOnTrack,
  gridSlot,
  type TrackDef,
} from '@kart/shared';

/** The cached flat-shaded Lambert factory owned by render.ts (mat). */
export type MatFn = (hex: string) => THREE.MeshLambertMaterial;

// ---- track deco tuning ---------------------------------------------------------
const GROUND_SIZE = 700; // grass slab; covers the hill ring
const CURB_W = 0.6; // curb stripe width (m)
const CURB_PERIOD = 2; // segments per red/white alternation (~4m)
const DASH_W = 0.18; // center-line dash strip width
const DASH_PERIOD = 2; // one segment on, one off (~2m dashes)
const BARRIER_OFF = 1.2; // posts sit at roadHalfW + this (docs/KART.md)
const BARRIER_EVERY = 2; // segments between posts (~4m)
const BARRIER_H = 0.55;
const CURB_Y = 0.015; // flat paint heights stack above the road (z-fight guard)
const DASH_Y = 0.02;
const PAINT_Y = 0.03; // start line + grid slot markers
const CHECKER_COLS = 10;
const CHECKER_ROWS = 2;
const TREE_COUNT = 120; // docs/KART.md: ~120 seeded trees
const ROCK_COUNT = 40;
const PROP_CLEARANCE = 4; // never on the road: |lateral| > roadHalfW + this
const PROP_SPACING = 5; // min center distance between props
const SCATTER_X = 150; // scatter bounds cover the circuit + apron
const SCATTER_Z = 140;
const CLUSTER_COUNT = 16; // tree clusters; the gaps between them stay bare
const CLUSTER_SPACING = 26; // min distance between cluster centers
const CLUSTER_R = 13; // max tree offset from the cluster center
const RIDGE_SEGS = 180; // segments per ridgeline ring
const RIDGE_NEAR_R = 202; // near ridge: dark, low
const RIDGE_NEAR_PEAK = 22;
const RIDGE_FAR_R = 248; // far ridge: tall, hazier
const RIDGE_FAR_PEAK = 46;
// -- asphalt banding: column offsets (fractions of halfW) + per-column tone.
// Edge bands read as worn/darkened, the two mid bands as rubbered-in lines.
const ROAD_COLS: readonly number[] = [-1, -0.82, -0.54, -0.22, 0.22, 0.54, 0.82, 1];
const ROAD_TONES: readonly number[] = [0.55, 0.9, 0.55, 1.12, 1.12, 0.55, 0.9, 0.55];
const GRIME_Y = 0.013; // road-edge dirt accumulation (road < grime < curb paint)
const SKID_Y = 0.016; // apex skid decals (below repair patches)
const PATCH_Y = 0.017; // repair rectangles (below the dashes)
const PATCH_COUNT = 16;
const SHOULDER_W = 0.8; // dirt ring just outside the curbs
const SHOULDER_Y = -0.004; // on the grass slab (top -0.02), under the road plane
const BLOB_Y = -0.008; // grass tone blobs sit on the slab, under the road plane
const BLOB_BIG = 26; // broad faint mottling
const BLOB_SMALL = 150; // distinct two-tone patches
const TREELINE_COUNT = 64; // mid-distance tree band between track and hills
const TREELINE_R_MIN = 108;
const TREELINE_R_MAX = 150;
const APEX_TURN_MIN = 0.045; // min smoothed turn (rad/sample) to count as a corner
const APEX_SPACING = 20; // min samples between apexes
const STACK_OFF = 2.4; // tire stacks sit at roadHalfW + this (behind the barrier)
const LAMP_EVERY = 16; // samples between lamp posts (~32m)
const LAMP_OFF = 3.05; // lamp posts at roadHalfW + this
const BILLBOARD_COUNT = 5;
const BILLBOARD_OFF = 8.5; // min lateral offset past the road edge
const PIT_SAMPLE = 238; // pit building anchor (between gate 7 and the start line)
const GANTRY_OFF = 1.8; // gantry posts at roadHalfW + this (outside the barriers)
const STAND_SAMPLE = 14; // grandstand anchor (mid start straight, past the line)
const STAND_OFF = 13.5; // grandstand lateral offset from centerline
const BRAKE_DISTS: readonly number[] = [12, 8, 4]; // samples before apex for 3/2/1 boards
const BOARD_OFF = 1.9; // brake boards at roadHalfW + this (corner outside)

/** Vertex-color paint layers (road/curbs/dirt/patches/blobs): one lazy Lambert. */
let paintMat: THREE.MeshLambertMaterial | null = null;
function vertexPaintMaterial(): THREE.MeshLambertMaterial {
  if (!paintMat) paintMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  return paintMat;
}

/** KPAL hex -> rgb triplet, scaled by `mul` (stays a KPAL tone, just shaded). */
function shade(hex: string, mul: number): [number, number, number] {
  const c = new THREE.Color(hex).multiplyScalar(mul);
  return [Math.min(1, c.r), Math.min(1, c.g), Math.min(1, c.b)];
}

// ---- mesh factories (origin at center, y-up) -----------------------------------
// Shared with kartMesh.ts; matFn is the render.ts material cache.
export function box(matFn: MatFn, w: number, h: number, d: number, hex: string): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), matFn(hex));
}
export function cyl(matFn: MatFn, rTop: number, rBottom: number, h: number, seg: number, hex: string): THREE.Mesh {
  return new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, seg), matFn(hex));
}
export function cone(matFn: MatFn, r: number, h: number, seg: number, hex: string): THREE.Mesh {
  return new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), matFn(hex));
}
export function sphere(matFn: MatFn, r: number, seg: number, hex: string): THREE.Mesh {
  return new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(4, Math.floor(seg * 0.75))), matFn(hex));
}

/** Convenience: position a mesh and return it (chainable builder style). */
export function at<T extends THREE.Object3D>(obj: T, x: number, y: number, z: number): T {
  obj.position.set(x, y, z);
  return obj;
}

/**
 * Merge all Mesh descendants of `root` into one mesh per material, preserving
 * world transforms. Used for EVERY static structure (ground, barriers, painted
 * markings, scatter, hills) to keep draw calls flat. Karts must NOT be baked —
 * their wheels/steering animate per frame.
 */
function bake(root: THREE.Group): THREE.Group {
  root.updateMatrixWorld(true);
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const g = child.geometry.clone().applyMatrix4(child.matrixWorld);
    // strip attributes that differ across primitives so merge succeeds
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    }
    const arr = byMaterial.get(child.material as THREE.Material) ?? [];
    arr.push(g);
    byMaterial.set(child.material as THREE.Material, arr);
  });
  const out = new THREE.Group();
  for (const [material, geoms] of byMaterial) {
    const merged = mergeGeometries(geoms, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.add(mesh);
  }
  return out;
}

// ---- track frames ---------------------------------------------------------------
// Per centerline sample: center + unit "left of travel" (lateral +, matching the
// sign convention of closestOnTrack in @kart/shared).
interface SampleFrame {
  cx: number;
  cz: number;
  lx: number;
  lz: number;
}

function trackFrames(centerline: ReadonlyArray<readonly [number, number]>): SampleFrame[] {
  const n = centerline.length;
  const frames: SampleFrame[] = [];
  for (let i = 0; i < n; i++) {
    const prev = centerline[(i - 1 + n) % n]!;
    const c = centerline[i]!;
    const nxt = centerline[(i + 1) % n]!;
    let tx = nxt[0] - prev[0];
    let tz = nxt[1] - prev[1];
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    frames.push({ cx: c[0], cz: c[1], lx: -tz, lz: tx });
  }
  return frames;
}

/** Tangent of travel for a frame (unit): left = (-tz, tx) => t = (lz, -lx). */
function frameTangent(f: SampleFrame): [number, number] {
  return [f.lz, -f.lx];
}

// ---- flat ribbon geometry ---------------------------------------------------------
// Road strip: ROAD_COLS shared vertices per sample across the width, indices
// wound to face +y. Normals are set straight up — the road is flat by
// construction. Vertex colors carry the asphalt banding (worn dark edges,
// rubbered tire lines that deepen where karts fight through corners, brighter
// crown) x a seeded patchwork albedo drift (4-sample groups + fine grain).

function roadGeometry(
  frames: SampleFrame[],
  halfW: number,
  turn: readonly number[],
  next: () => number,
): THREE.BufferGeometry {
  const n = frames.length;
  const cols = ROAD_COLS.length;
  const base = new THREE.Color(KPAL.asphalt);
  // patchwork: per 4-sample group multiplier, ~18% of groups strongly shifted
  const groups = Math.ceil(n / 4);
  const groupMul: number[] = [];
  for (let g = 0; g < groups; g++) {
    groupMul.push(next() < 0.2 ? (next() < 0.5 ? 0.78 : 1.22) : 0.93 + next() * 0.14);
  }
  const pos = new Float32Array(n * cols * 3);
  const nrm = new Float32Array(n * cols * 3);
  const col = new Float32Array(n * cols * 3);
  for (let i = 0; i < n; i++) {
    const f = frames[i]!;
    const jitter = groupMul[Math.floor(i / 4)]! * (0.98 + next() * 0.04);
    // rubber lines deepen where the karts fight (braking/turn-in zones)
    const cornerGrip = Math.min(0.3, Math.abs(turn[i]!) * 0.8);
    for (let c = 0; c < cols; c++) {
      const off = ROAD_COLS[c]! * halfW;
      const k = (i * cols + c) * 3;
      pos[k] = f.cx + f.lx * off;
      pos[k + 1] = 0;
      pos[k + 2] = f.cz + f.lz * off;
      nrm[k + 1] = 1;
      const isRubber = c === 2 || c === 5; // the two tire-line columns
      const tone = (isRubber ? ROAD_TONES[c]! * (1 - cornerGrip) : ROAD_TONES[c]!) * jitter;
      col[k] = base.r * tone;
      col[k + 1] = base.g * tone;
      col[k + 2] = base.b * tone;
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    for (let c = 0; c < cols - 1; c++) {
      const ri = i * cols + c; // smaller lateral offset
      const li = i * cols + c + 1;
      const rj = j * cols + c;
      const lj = j * cols + c + 1;
      idx.push(li, lj, ri, ri, lj, rj); // ribbonGeometry winding, faces +y
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

/**
 * Per-segment ribbon with DUPLICATED vertices (4 per emitted segment) so adjacent
 * segments can carry different vertex colors (curb stripes) or be skipped
 * entirely (center-line dashes). Requires leftOff > rightOff; winding faces +y.
 */
function ribbonGeometry(
  frames: SampleFrame[],
  leftOff: number,
  rightOff: number,
  y: number,
  colorFor: (seg: number) => [number, number, number],
  skip: (seg: number) => boolean,
): THREE.BufferGeometry {
  const n = frames.length;
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (skip(i)) continue;
    const a = frames[i]!;
    const b = frames[(i + 1) % n]!;
    const c = colorFor(i);
    const verts: Array<[number, number, number]> = [
      [a.cx + a.lx * leftOff, y, a.cz + a.lz * leftOff], // Li
      [b.cx + b.lx * leftOff, y, b.cz + b.lz * leftOff], // Lj
      [a.cx + a.lx * rightOff, y, a.cz + a.lz * rightOff], // Ri
      [b.cx + b.lx * rightOff, y, b.cz + b.lz * rightOff], // Rj
    ];
    const base = pos.length / 3;
    for (const v of verts) {
      pos.push(v[0], v[1], v[2]);
      nrm.push(0, 1, 0);
      col.push(c[0], c[1], c[2]);
    }
    idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

/**
 * Asphalt wear layer: seeded repair rectangles (fresh dark / bleached light
 * repaves) + broken grime strips where the road meets the curbs + skid decals
 * arcing through every corner apex. One geometry, one vertex-color draw call;
 * everything sits in the paint stack just above the road.
 */
function roadDetailGeometry(
  frames: SampleFrame[],
  halfW: number,
  apexes: ReadonlyArray<{ index: number; side: number }>,
  next: () => number,
): THREE.BufferGeometry {
  const n = frames.length;
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  // quad corners in [Li, Lj, Ri, Rj] order, same winding as ribbonGeometry (+y)
  const quad = (verts: ReadonlyArray<readonly [number, number, number]>, c: readonly [number, number, number]): void => {
    const base = pos.length / 3;
    for (const v of verts) {
      pos.push(v[0], v[1], v[2]);
      nrm.push(0, 1, 0);
      col.push(c[0], c[1], c[2]);
    }
    idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  };
  // per-segment strip helper: [Li, Lj, Ri, Rj] between two lateral offsets
  const strip = (i: number, latA: number, latB: number, y: number, c: readonly [number, number, number]): void => {
    const a = frames[i]!;
    const b = frames[(i + 1) % n]!;
    const lo = Math.max(latA, latB);
    const ro = Math.min(latA, latB);
    quad(
      [
        [a.cx + a.lx * lo, y, a.cz + a.lz * lo],
        [b.cx + b.lx * lo, y, b.cz + b.lz * lo],
        [a.cx + a.lx * ro, y, a.cz + a.lz * ro],
        [b.cx + b.lx * ro, y, b.cz + b.lz * ro],
      ],
      c,
    );
  };

  // grime strips: lat in [halfW-0.85, halfW-0.15] on both sides, ~62% coverage
  for (let i = 0; i < n; i++) {
    if (next() < 0.38) continue;
    const c = shade(KPAL.dirt, 0.68 + next() * 0.3);
    for (const side of [1, -1]) {
      strip(i, side * (halfW - 0.15), side * (halfW - 0.85), GRIME_Y, c);
    }
  }

  // skid/wear decals: broken dark strips on the racing line through each apex
  for (const apex of apexes) {
    const marks = rngInt(next, 2, 3);
    for (let m = 0; m < marks; m++) {
      const start = apex.index - rngInt(next, 2, 5);
      const len = rngInt(next, 5, 8);
      const latBase = apex.side * rngRange(next, 1.5, 2.7);
      for (let s = 0; s < len; s++) {
        if (next() < 0.15) continue; // broken marks, not a solid band
        const lat = latBase + rngRange(next, -0.3, 0.3) + apex.side * s * 0.12; // drift outward on exit
        const w2 = rngRange(next, 0.2, 0.35);
        strip((start + s + n) % n, lat + w2, lat - w2, SKID_Y, shade(KPAL.asphalt, rngRange(next, 0.35, 0.5)));
      }
    }
  }

  // repair patches: flat rectangles aligned to one frame, kept off the curbs
  // and away from the start-line checker
  for (let p = 0; p < PATCH_COUNT; p++) {
    const si = rngInt(next, 10, n - 11);
    const f = frames[si]!;
    const [tx, tz] = frameTangent(f);
    const halfLen = rngRange(next, 1.3, 3.1);
    const halfWid = rngRange(next, 0.7, 1.5);
    const latLim = halfW - 1.0 - halfWid;
    const lat = rngRange(next, -latLim, latLim);
    const dark = next() < 0.6;
    const c = shade(KPAL.asphalt, dark ? rngRange(next, 0.55, 0.68) : rngRange(next, 1.15, 1.3));
    const px = f.cx + f.lx * lat;
    const pz = f.cz + f.lz * lat;
    quad(
      [
        [px - tx * halfLen + f.lx * halfWid, PATCH_Y, pz - tz * halfLen + f.lz * halfWid],
        [px + tx * halfLen + f.lx * halfWid, PATCH_Y, pz + tz * halfLen + f.lz * halfWid],
        [px - tx * halfLen - f.lx * halfWid, PATCH_Y, pz - tz * halfLen - f.lz * halfWid],
        [px + tx * halfLen - f.lx * halfWid, PATCH_Y, pz + tz * halfLen - f.lz * halfWid],
      ],
      c,
    );
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

/**
 * Grass tone layer: broad faint mottling + smaller two-tone blobs (irregular
 * seeded fans, flat on the slab, never on the road/shoulder). One draw call.
 */
function grassPatchGeometry(track: TrackDef, halfW: number, next: () => number): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const placed: Array<{ x: number; z: number }> = [];

  const blob = (x: number, z: number, r: number, y: number, c: readonly [number, number, number]): void => {
    const k = 12;
    const rot = next() * Math.PI * 2;
    const ex = rngRange(next, 0.7, 1.4); // elongation
    const ez = rngRange(next, 0.7, 1.4);
    const base = pos.length / 3;
    pos.push(x, y, z);
    nrm.push(0, 1, 0);
    col.push(c[0], c[1], c[2]);
    for (let i = 0; i < k; i++) {
      const ang = rot + (i / k) * Math.PI * 2;
      const rr = r * rngRange(next, 0.72, 1.25);
      pos.push(x + Math.cos(ang) * rr * ex, y, z + Math.sin(ang) * rr * ez);
      nrm.push(0, 1, 0);
      col.push(c[0], c[1], c[2]);
    }
    for (let i = 0; i < k; i++) {
      const a = base + 1 + i;
      const b = base + 1 + ((i + 1) % k);
      idx.push(base, b, a); // wound to face +y
    }
  };

  // broad mottling: large, very subtle shifts
  for (let p = 0; p < BLOB_BIG; p++) {
    const x = rngRange(next, -SCATTER_X, SCATTER_X);
    const z = rngRange(next, -SCATTER_Z, SCATTER_Z);
    if (Math.abs(closestOnTrack(track, x, z).lateral) <= halfW + PROP_CLEARANCE) continue;
    blob(x, z, rngRange(next, 10, 24), BLOB_Y - 0.006, shade(KPAL.grass, rngRange(next, 0.85, 1.1)));
  }

  // distinct patches: darker + lighter two-tone
  for (let attempt = 0, done = 0; attempt < BLOB_SMALL * 20 && done < BLOB_SMALL; attempt++) {
    const x = rngRange(next, -SCATTER_X - 15, SCATTER_X + 15);
    const z = rngRange(next, -SCATTER_Z - 15, SCATTER_Z + 15);
    if (Math.abs(closestOnTrack(track, x, z).lateral) <= halfW + CURB_W + 2.0) continue;
    if (tooClose(x, z, placed)) continue;
    placed.push({ x, z });
    const dark = next() < 0.55;
    const c = dark ? shade(KPAL.grassDark, rngRange(next, 0.85, 1.02)) : shade(KPAL.grass, rngRange(next, 1.1, 1.24));
    blob(x, z, rngRange(next, 1.8, 5.5), BLOB_Y, c);
    done++;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

// ---- ridgeline silhouette (distant horizon layers) --------------------------------
// A ring strip whose top edge follows a seeded harmonic mountain profile; vertex
// colors grade bottom->top. Two layers (dark near, hazy far) + fog give the
// horizon real depth. Wound to face INWARD (the circuit is at the origin).

function ridgelineGeometry(
  radius: number,
  hPeak: number,
  next: () => number,
  loHex: string,
  hiHex: string,
): THREE.BufferGeometry {
  const ks = [2, 3, 4]; // broad overtones: big mountain rhythm, not choppy
  const amps = ks.map(() => rngRange(next, 0.6, 1));
  const phases = ks.map(() => next() * Math.PI * 2);
  // profile in [0,1] with real valleys (~0) so the ridge breaks into peaks
  const profile = (th: number): number => {
    let s = 0;
    let norm = 0;
    for (let k = 0; k < ks.length; k++) {
      s += amps[k]! * (0.5 + 0.5 * Math.sin(ks[k]! * th + phases[k]!));
      norm += amps[k]!;
    }
    return Math.max(0.015, (s / norm - 0.3) / 0.7);
  };
  const lo = new THREE.Color(loHex);
  const hi = new THREE.Color(hiHex);
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < RIDGE_SEGS; i++) {
    const th = (i / RIDGE_SEGS) * Math.PI * 2;
    const r = radius + rngRange(next, -1.5, 1.5); // tiny wobble: silhouette, not striping
    const h = hPeak * profile(th);
    const x = Math.cos(th) * r;
    const z = Math.sin(th) * r;
    pos.push(x, -1, z, x, h, z);
    nrm.push(0, 1, 0, 0, 1, 0); // ignored: flatShading derives face normals
    col.push(lo.r, lo.g, lo.b, hi.r, hi.g, hi.b);
  }
  for (let i = 0; i < RIDGE_SEGS; i++) {
    const j = (i + 1) % RIDGE_SEGS;
    const bi = i * 2;
    const ti = i * 2 + 1;
    const bj = j * 2;
    const tj = j * 2 + 1;
    idx.push(bi, bj, ti, ti, bj, tj); // faces the origin
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

// ---- curvature analysis (visual furniture placement ONLY) ------------------------

/** Smoothed signed turn per sample (rad), window +-4 samples. */
function smoothedTurn(frames: SampleFrame[]): number[] {
  const n = frames.length;
  const turn = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const a = frames[(i - 2 + n) % n]!;
    const b = frames[(i + 2) % n]!;
    const [tax, taz] = frameTangent(a);
    const [tbx, tbz] = frameTangent(b);
    turn[i] = Math.atan2(tax * tbz - taz * tbx, tax * tbx + taz * tbz);
  }
  const sm = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -4; k <= 4; k++) s += turn[(i + k + n) % n]!;
    sm[i] = s / 9;
  }
  return sm;
}

/** Corner apexes: local maxima of |turn| above threshold, spaced apart. */
function findApexes(frames: SampleFrame[], sm: readonly number[]): Array<{ index: number; side: number }> {
  const n = frames.length;
  const out: Array<{ index: number; side: number }> = [];
  for (let i = 0; i < n; i++) {
    const v = Math.abs(sm[i]!);
    if (v < APEX_TURN_MIN) continue;
    let isMax = true;
    for (let k = -8; k <= 8; k++) {
      if (Math.abs(sm[(i + k + n) % n]!) > v) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    const last = out[out.length - 1];
    if (last !== undefined) {
      const d = Math.min((i - last.index + n) % n, (last.index - i + n) % n);
      if (d < APEX_SPACING) continue;
    }
    // inside of the corner: t(i+6) - t(i-6) is the centripetal direction;
    // project it on the frame's left vector to get the apex side
    const a = frames[(i - 6 + n) % n]!;
    const b = frames[(i + 6) % n]!;
    const f = frames[i]!;
    const dx = b.lz - a.lz;
    const dz = -b.lx + a.lx;
    out.push({ index: i, side: dx * f.lx + dz * f.lz >= 0 ? 1 : -1 });
  }
  return out;
}

// ---- scatter rejections ------------------------------------------------------------

interface AvoidZone {
  x: number;
  z: number;
  r: number;
}

/** Min center distance to every already-placed prop. */
function tooClose(x: number, z: number, placed: ReadonlyArray<{ x: number; z: number }>): boolean {
  const d2 = PROP_SPACING * PROP_SPACING;
  for (const p of placed) {
    const dx = p.x - x;
    const dz = p.z - z;
    if (dx * dx + dz * dz < d2) return true;
  }
  return false;
}

/** Inside any furniture keep-clear disc (buildings, billboards, lamps, stacks)? */
function inAvoid(x: number, z: number, zones: ReadonlyArray<AvoidZone>): boolean {
  for (const zn of zones) {
    const dx = x - zn.x;
    const dz = z - zn.z;
    if (dx * dx + dz * dz < zn.r * zn.r) return true;
  }
  return false;
}

// ---- block lettering (5x7 pixel font, KPAL boxes) ----------------------------------
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  K: ['X...X', 'X..X.', 'X.X..', 'XX...', 'X.X..', 'X..X.', 'X...X'],
  A: ['.XXX.', 'X...X', 'X...X', 'XXXXX', 'X...X', 'X...X', 'X...X'],
  R: ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X.X..', 'X..X.', 'X...X'],
  T: ['XXXXX', '..X..', '..X..', '..X..', '..X..', '..X..', '..X..'],
  G: ['.XXX.', 'X...X', 'X....', 'X.XXX', 'X...X', 'X...X', '.XXX.'],
  P: ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X....', 'X....', 'X....'],
  I: ['XXX', '.X.', '.X.', '.X.', '.X.', '.X.', 'XXX'],
  '1': ['..X..', '.XX..', '..X..', '..X..', '..X..', '..X..', '.XXX.'],
  '2': ['.XXX.', 'X...X', '....X', '...X.', '..X..', '.X...', 'XXXXX'],
  '3': ['.XXX.', 'X...X', '....X', '..XX.', '....X', 'X...X', '.XXX.'],
};

/**
 * Row of block letters centered on the group's local x at height cy, depth z.
 * `mirror` flips the row so the back face of a sign also reads correctly.
 */
function addBlockText(
  g: THREE.Group,
  matFn: MatFn,
  text: string,
  cell: number,
  hex: string,
  cy: number,
  z: number,
  mirror: boolean,
): void {
  const glyphs = [...text].map((ch) => (ch === ' ' ? null : GLYPHS[ch] ?? null));
  const widths = glyphs.map((gl) => (gl === null ? 2 : gl[0]!.length));
  const totalCells = widths.reduce((a, b) => a + b, 0) + glyphs.length - 1;
  let cursor = -totalCells / 2;
  const order = mirror ? [...glyphs.keys()].reverse() : glyphs.map((_, i) => i);
  for (const gi of order) {
    const gl = glyphs[gi]!;
    const w = widths[gi]!;
    if (gl !== null) {
      for (let r = 0; r < gl.length; r++) {
        const row = mirror ? [...gl[r]!].reverse() : [...gl[r]!];
        for (let c = 0; c < row.length; c++) {
          if (row[c] !== 'X') continue;
          g.add(at(box(matFn, cell * 0.84, cell * 0.84, 0.05, hex), (cursor + c + 0.5) * cell, cy + (3 - r) * cell, z));
        }
      }
    }
    cursor += w + 1;
  }
}

// ---- seeded prop recipes (KPAL only) -------------------------------------------------

/** seeded leaf tone: per-tree hue variance across the three KPAL greens. */
function leafTone(next: () => number): string {
  const r = next();
  return r < 0.45 ? KPAL.treeLeaf : r < 0.8 ? KPAL.treeLeafLight : KPAL.grassDark;
}

/** broadleaf: trunk + 2 leaf blobs, organic yaw + scale. */
function buildBroadleaf(matFn: MatFn, next: () => number): THREE.Group {
  const g = new THREE.Group();
  const h = rngRange(next, 1.0, 1.6);
  g.add(at(cyl(matFn, 0.12, 0.18, h, 6, KPAL.treeTrunk), 0, h / 2, 0));
  const r1 = rngRange(next, 0.9, 1.3);
  g.add(at(sphere(matFn, r1, 7, leafTone(next)), 0, h + r1 * 0.55, 0));
  const r2 = r1 * rngRange(next, 0.55, 0.7);
  g.add(at(sphere(matFn, r2, 6, leafTone(next)), rngRange(next, -0.25, 0.25), h + r1 * 0.55 + r2 * 0.9, rngRange(next, -0.25, 0.25)));
  return g;
}

/** pine: short trunk + 2 stacked cones. */
function buildPine(matFn: MatFn, next: () => number): THREE.Group {
  const g = new THREE.Group();
  const h = rngRange(next, 0.7, 1.1);
  g.add(at(cyl(matFn, 0.1, 0.16, h, 6, KPAL.treeTrunk), 0, h / 2, 0));
  const tone = leafTone(next);
  const r1 = rngRange(next, 0.75, 1.05);
  g.add(at(cone(matFn, r1, rngRange(next, 1.3, 1.7), 7, tone), 0, h + 0.6, 0));
  g.add(at(cone(matFn, r1 * 0.62, rngRange(next, 0.9, 1.2), 7, leafTone(next)), 0, h + 0.6 + r1 * 0.85, 0));
  return g;
}

/** poplar: tall trunk + a stretched ellipsoid crown (+ tip blob). */
function buildPoplar(matFn: MatFn, next: () => number): THREE.Group {
  const g = new THREE.Group();
  const h = rngRange(next, 1.5, 2.2);
  g.add(at(cyl(matFn, 0.09, 0.14, h, 6, KPAL.treeTrunk), 0, h / 2, 0));
  const r = rngRange(next, 0.5, 0.75);
  const crown = sphere(matFn, r, 7, leafTone(next));
  crown.scale.set(1, rngRange(next, 1.9, 2.4), 1);
  crown.position.y = h + r * 1.5;
  g.add(crown);
  g.add(at(sphere(matFn, r * 0.5, 6, leafTone(next)), 0, h + r * 3.1, 0));
  return g;
}

/** one of the three silhouettes + per-instance scale/yaw jitter. */
function buildAnyTree(matFn: MatFn, next: () => number): THREE.Group {
  const r = next();
  const g = r < 0.34 ? buildPine(matFn, next) : r < 0.67 ? buildBroadleaf(matFn, next) : buildPoplar(matFn, next);
  g.rotation.y = next() * Math.PI * 2;
  g.scale.setScalar(rngRange(next, 0.7, 1.45));
  return g;
}

/** rock: 1-2 overlapping squashed spheres. */
function buildRock(matFn: MatFn, next: () => number): THREE.Group {
  const g = new THREE.Group();
  const n = rngInt(next, 1, 2);
  for (let i = 0; i < n; i++) {
    const r = rngRange(next, 0.4, 0.9);
    const m = at(sphere(matFn, r, 7, KPAL.rock), rngRange(next, -0.4, 0.4), r * 0.45, rngRange(next, -0.4, 0.4));
    m.scale.set(rngRange(next, 0.9, 1.4), rngRange(next, 0.4, 0.65), rngRange(next, 0.9, 1.4));
    m.rotation.y = next() * Math.PI;
    g.add(m);
  }
  return g;
}

/** tire stack: 3 painted torus rings (red or white), apex furniture. */
function buildTireStack(matFn: MatFn, hex: string): THREE.Group {
  const g = new THREE.Group();
  for (let k = 0; k < 3; k++) {
    const t = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.13, 7, 12), matFn(hex));
    t.rotation.x = Math.PI / 2; // lie flat, hole up
    t.position.y = 0.14 + k * 0.26;
    g.add(t);
  }
  return g;
}

/** traffic cone: orange body + white reflective collar. */
function buildCone(matFn: MatFn): THREE.Group {
  const g = new THREE.Group();
  g.add(at(box(matFn, 0.3, 0.04, 0.3, KPAL.kartOrange), 0, 0.02, 0));
  g.add(at(cone(matFn, 0.16, 0.44, 8, KPAL.kartOrange), 0, 0.26, 0));
  g.add(at(cyl(matFn, 0.085, 0.105, 0.09, 8, KPAL.curbWhite), 0, 0.28, 0));
  return g;
}

/**
 * Start gantry: two truss posts flanking the road, a truss beam, and an ink
 * banner with 'KART GP' block letters readable from BOTH faces + gold trim and
 * start-light pods under the beam.
 */
function buildGantry(matFn: MatFn, track: TrackDef): THREE.Group {
  const g0 = track.gates[0]!;
  const w = track.roadHalfW;
  const g = new THREE.Group();
  g.position.set(g0.x, 0, g0.z);
  g.rotation.y = Math.atan2(-g0.tx, -g0.tz); // local +x = left of travel, -z = travel

  for (const side of [1, -1]) {
    const x = side * (w + GANTRY_OFF);
    g.add(at(box(matFn, 0.9, 0.18, 0.9, KPAL.steel), x, 0.09, 0)); // base plate
    g.add(at(box(matFn, 0.34, 5.7, 0.34, KPAL.charcoal), x, 2.94, 0)); // column
    const brace = box(matFn, 0.16, 1.7, 0.16, KPAL.steel); // angled brace inward
    brace.position.set(side * (w + GANTRY_OFF - 0.45), 4.75, 0);
    brace.rotation.z = side * 0.55;
    g.add(brace);
  }

  // truss beam: two chords + verticals
  const span = 2 * (w + GANTRY_OFF) + 0.5;
  g.add(at(box(matFn, span, 0.2, 0.2, KPAL.steel), 0, 5.55, 0));
  g.add(at(box(matFn, span, 0.2, 0.2, KPAL.steel), 0, 4.95, 0));
  for (let i = -3; i <= 3; i++) {
    g.add(at(box(matFn, 0.12, 0.6, 0.12, KPAL.steel), (i * span) / 8, 5.25, 0));
  }

  // banner + gold trim, letters on both faces
  g.add(at(box(matFn, 7.8, 1.6, 0.14, KPAL.ink), 0, 3.9, 0));
  g.add(at(box(matFn, 7.8, 0.09, 0.16, KPAL.gold), 0, 4.66, 0));
  g.add(at(box(matFn, 7.8, 0.09, 0.16, KPAL.gold), 0, 3.14, 0));
  addBlockText(g, matFn, 'KART GP', 0.155, KPAL.curbWhite, 3.9, 0.096, false);
  addBlockText(g, matFn, 'KART GP', 0.155, KPAL.curbWhite, 3.9, -0.096, true);

  // start lights: 5 ink housings under the bottom chord, red/amber/green lenses
  const LENSES = [KPAL.kartRed, KPAL.kartYellow, KPAL.kartGreen, KPAL.kartYellow, KPAL.kartRed];
  for (let li = 0; li < LENSES.length; li++) {
    const x = (li - 2) * 0.55;
    g.add(at(box(matFn, 0.34, 0.34, 0.18, KPAL.ink), x, 4.66, 0));
    for (const zSide of [1, -1]) {
      const lens = cyl(matFn, 0.1, 0.1, 0.05, 10, LENSES[li]!);
      lens.rotation.x = Math.PI / 2; // face along the straight (both ways)
      lens.position.set(x, 4.66, zSide * 0.11);
      g.add(lens);
    }
  }
  return g;
}

/**
 * Billboard: two steel posts + panel + a palette-block poster (5 seeded
 * designs). Faces the track (local +z toward the centerline sample).
 */
function buildBillboard(matFn: MatFn, design: number): THREE.Group {
  const g = new THREE.Group();
  for (const x of [-1.4, 1.4]) {
    g.add(at(box(matFn, 0.16, 2.6, 0.16, KPAL.steel), x, 1.3, 0));
  }
  const fields = [KPAL.kartRed, KPAL.charcoal, KPAL.grassDark, KPAL.ink, KPAL.curbWhite];
  g.add(at(box(matFn, 4.4, 2.2, 0.12, fields[design % fields.length]!), 0, 2.6, 0));
  const z = 0.09; // poster blocks ride on the panel face
  switch (design % 5) {
    case 0: // red field: gold diagonal + ink foot + white chip
      g.add(at(box(matFn, 4.4, 0.5, 0.06, KPAL.ink), 0, 1.85, z));
      g.add(rotZ(box(matFn, 3.6, 0.5, 0.06, KPAL.gold), 0.45, 0, 2.75, z));
      g.add(at(box(matFn, 0.5, 0.5, 0.06, KPAL.curbWhite), 1.5, 3.15, z));
      break;
    case 1: // charcoal field: white band + orange block + gold foot
      g.add(at(box(matFn, 4.4, 0.6, 0.06, KPAL.curbWhite), 0, 2.95, z));
      g.add(at(box(matFn, 1.2, 1.2, 0.06, KPAL.kartOrange), -1.2, 2.2, z));
      g.add(at(box(matFn, 4.4, 0.12, 0.06, KPAL.gold), 0, 1.62, z));
      break;
    case 2: // green field: gold disc + light chip + ink foot
      g.add(rotX(cyl(matFn, 0.7, 0.7, 0.06, 14, KPAL.gold), -1.2, 2.85, z));
      g.add(at(box(matFn, 1.0, 1.0, 0.06, KPAL.treeLeafLight), 1.3, 2.7, z));
      g.add(at(box(matFn, 4.4, 0.4, 0.06, KPAL.ink), 0, 1.8, z));
      break;
    case 3: // ink field: red band + 3 white chips + gold foot
      g.add(at(box(matFn, 4.4, 0.55, 0.06, KPAL.kartRed), 0, 3.05, z));
      for (const x of [-0.75, 0, 0.75]) g.add(at(box(matFn, 0.45, 0.45, 0.06, KPAL.curbWhite), x, 2.2, z));
      g.add(at(box(matFn, 4.4, 0.12, 0.06, KPAL.gold), 0, 1.62, z));
      break;
    default: // white field: ink text bars + red corner + gold chip
      for (let r = 0; r < 3; r++) g.add(at(box(matFn, 1.7, 0.26, 0.06, KPAL.ink), -1.05, 3.15 - r * 0.42, z));
      g.add(at(box(matFn, 1.1, 1.1, 0.06, KPAL.kartRed), 1.45, 2.05, z));
      g.add(at(box(matFn, 0.5, 0.5, 0.06, KPAL.gold), 1.45, 3.2, z));
      break;
  }
  return g;
}

/** billboard block rotated in-plane (poster diagonals). */
function rotZ<T extends THREE.Object3D>(obj: T, angle: number, x: number, y: number, z: number): T {
  obj.rotation.z = angle;
  obj.position.set(x, y, z);
  return obj;
}

/** billboard disc tipped to face +z (panel-parallel). */
function rotX<T extends THREE.Object3D>(obj: T, x: number, y: number, z: number): T {
  obj.rotation.x = Math.PI / 2;
  obj.position.set(x, y, z);
  return obj;
}

/** lamp post: steel pole + arm reaching over the barrier + head with lens. */
function buildLamp(matFn: MatFn): THREE.Group {
  const g = new THREE.Group(); // local +z = toward the road
  g.add(at(cyl(matFn, 0.07, 0.1, 5.6, 7, KPAL.steel), 0, 2.8, 0));
  g.add(at(box(matFn, 0.1, 0.1, 1.7, KPAL.steel), 0, 5.42, 0.75));
  g.add(at(box(matFn, 0.34, 0.12, 0.66, KPAL.charcoal), 0, 5.32, 1.55));
  g.add(at(box(matFn, 0.26, 0.03, 0.5, KPAL.curbWhite), 0, 5.25, 1.55));
  return g;
}

/**
 * Pit building: white block + charcoal roof + red fascia with 'PIT' lettering,
 * windows/door, steel annex, roof clutter. Faces the track (local +z).
 */
function buildPitBuilding(matFn: MatFn): THREE.Group {
  const g = new THREE.Group();
  g.add(at(box(matFn, 10.5, 3.4, 5.0, KPAL.curbWhite), 0, 1.7, 0));
  g.add(at(box(matFn, 11.3, 0.28, 5.9, KPAL.charcoal), 0, 3.55, 0));
  g.add(at(box(matFn, 11.3, 0.46, 0.12, KPAL.kartRed), 0, 3.28, 2.92)); // fascia
  addBlockText(g, matFn, 'PIT', 0.13, KPAL.curbWhite, 3.28, 3.0, false);
  for (const x of [-3.8, -1.3, 1.2]) {
    g.add(at(box(matFn, 1.5, 1.1, 0.1, KPAL.ink), x, 1.9, 2.52)); // windows
  }
  g.add(at(box(matFn, 1.1, 2.2, 0.1, KPAL.charcoal), 3.9, 1.1, 2.52)); // door
  g.add(at(box(matFn, 3.6, 2.4, 3.4, KPAL.steel), -7.6, 1.2, -0.4)); // annex
  g.add(at(box(matFn, 0.9, 0.4, 0.9, KPAL.steel), -2.5, 3.9, 0.8)); // roof clutter
  g.add(at(box(matFn, 0.9, 0.4, 0.9, KPAL.charcoal), 1.8, 3.9, -1.2));
  return g;
}

/**
 * Grandstand silhouette: base plinth + 4 ascending terraces with seeded crowd
 * blocks (palette colors), back wall, roof slab on posts. Faces the track
 * (local +z). ~20m long, sits along the start straight.
 */
function buildGrandstand(matFn: MatFn, next: () => number): THREE.Group {
  const g = new THREE.Group();
  const LEN = 20;
  const CROWD = [
    KPAL.kartRed,
    KPAL.kartBlue,
    KPAL.kartYellow,
    KPAL.curbWhite,
    KPAL.kartTeal,
    KPAL.kartOrange,
    KPAL.steel,
    KPAL.kartGreen,
  ];
  g.add(at(box(matFn, LEN, 0.4, 7, KPAL.steel), 0, 0.2, 0)); // plinth
  for (let k = 0; k < 4; k++) {
    const y = 0.4 + k * 0.55;
    const z = 2.3 - k * 1.5;
    g.add(at(box(matFn, LEN, 0.5, 1.6, KPAL.asphaltLight), 0, y + 0.25, z)); // terrace
    let x = -LEN / 2 + 0.7; // crowd row: seeded palette blocks with gaps
    while (x < LEN / 2 - 0.7) {
      if (next() < 0.85) {
        g.add(
          at(
            box(matFn, 0.5, 0.5, 0.5, CROWD[rngInt(next, 0, CROWD.length - 1)]!),
            x + rngRange(next, -0.1, 0.1),
            y + 0.75,
            z + rngRange(next, -0.15, 0.15),
          ),
        );
      }
      x += rngRange(next, 0.65, 1.0);
    }
  }
  g.add(at(box(matFn, LEN, 2.4, 0.35, KPAL.charcoal), 0, 1.6, -3.3)); // back wall
  for (const px of [-LEN / 2 + 0.6, LEN / 2 - 0.6]) {
    g.add(at(box(matFn, 0.3, 3.4, 0.3, KPAL.charcoal), px, 1.7, 2.9)); // roof posts
  }
  g.add(at(box(matFn, LEN + 0.8, 0.22, 7.6, KPAL.ink), 0, 3.55, -0.2)); // roof slab
  return g;
}

/** brake board: white post + board with a dark block numeral ('3'/'2'/'1'). */
function buildBrakeBoard(matFn: MatFn, numeral: string): THREE.Group {
  const g = new THREE.Group(); // local +z faces approaching traffic
  g.add(at(box(matFn, 0.08, 1.05, 0.08, KPAL.curbWhite), 0, 0.52, 0)); // post
  g.add(at(box(matFn, 0.62, 0.48, 0.06, KPAL.curbWhite), 0, 1.1, 0)); // board
  addBlockText(g, matFn, numeral, 0.052, KPAL.ink, 1.1, 0.045, false);
  addBlockText(g, matFn, numeral, 0.052, KPAL.ink, 1.1, -0.045, true);
  return g;
}

/**
 * Build the whole circuit: ground, banded road ribbon + painted markings,
 * curbs + dirt shoulders, barrier posts, furniture (gantry, tire stacks, cones,
 * billboards, lamps, pit building), seeded scatter, tree line, ridgelines.
 * Disposal of the returned group's geometries is the caller's job (render.ts
 * owns trackRoot lifetime and its disposeGeometries sweep).
 */
export function buildTrackMesh(track: TrackDef, matFn: MatFn): THREE.Group {
  const frames = trackFrames(track.centerline);
  const w = track.roadHalfW;
  const root = new THREE.Group();
  const n = frames.length;
  // curvature drives the road's rubber lines, the apex skids/stacks, billboards
  const turn = smoothedTurn(frames);
  const apexes = findApexes(frames, turn);

  // ---- road ribbon + painted markings (flat, receive shadows only) -----------
  const roadNext = rng(decoSeed('kart-circuit', 10));
  const road = new THREE.Mesh(roadGeometry(frames, w, turn, roadNext), vertexPaintMaterial());
  road.receiveShadow = true;
  root.add(road);

  // subtle center-line dashes: thin lighter strip, every other segment
  const dashes = new THREE.Mesh(
    ribbonGeometry(frames, DASH_W / 2, -DASH_W / 2, DASH_Y, () => [1, 1, 1], (i) => i % DASH_PERIOD !== 0),
    matFn(KPAL.asphaltLight),
  );
  dashes.receiveShadow = true;
  root.add(dashes);

  // curb stripes: alternating red/white per CURB_PERIOD segments, both edges
  const curbCols = [new THREE.Color(KPAL.curbRed), new THREE.Color(KPAL.curbWhite)];
  const curbColor = (seg: number): [number, number, number] => {
    const c = curbCols[Math.floor(seg / CURB_PERIOD) % 2]!;
    return [c.r, c.g, c.b];
  };
  for (const side of [1, -1]) {
    const inner = side * w;
    const outer = side * (w + CURB_W);
    const curb = new THREE.Mesh(
      ribbonGeometry(frames, Math.max(inner, outer), Math.min(inner, outer), CURB_Y, curbColor, () => false),
      vertexPaintMaterial(),
    );
    curb.receiveShadow = true;
    root.add(curb);
  }

  // dirt shoulder ring: narrow, desaturated toward the asphalt/dirt midpoint
  const dirtNext = rng(decoSeed('kart-circuit', 11));
  const dirtMix = new THREE.Color(KPAL.asphalt).lerp(new THREE.Color(KPAL.dirt), 0.55);
  const dirtColor = (): [number, number, number] => {
    const j = 0.85 + dirtNext() * 0.3;
    return [Math.min(1, dirtMix.r * j), Math.min(1, dirtMix.g * j), Math.min(1, dirtMix.b * j)];
  };
  const dirtA = ribbonGeometry(frames, w + CURB_W + SHOULDER_W, w + CURB_W, SHOULDER_Y, dirtColor, () => false);
  const dirtB = ribbonGeometry(frames, -(w + CURB_W), -(w + CURB_W + SHOULDER_W), SHOULDER_Y, dirtColor, () => false);
  const dirtMerged = mergeGeometries([dirtA, dirtB], false);
  if (dirtMerged) {
    const dirt = new THREE.Mesh(dirtMerged, vertexPaintMaterial());
    dirt.receiveShadow = true;
    root.add(dirt);
  }

  // asphalt wear: repair patches + edge grime + apex skids (one vertex-color mesh)
  const detailNext = rng(decoSeed('kart-circuit', 12));
  const detail = new THREE.Mesh(roadDetailGeometry(frames, w, apexes, detailNext), vertexPaintMaterial());
  detail.receiveShadow = true;
  root.add(detail);

  // grass tone blobs: two-tone patches + broad mottling (one vertex-color mesh)
  const blobNext = rng(decoSeed('kart-circuit', 13));
  const blobs = new THREE.Mesh(grassPatchGeometry(track, w, blobNext), vertexPaintMaterial());
  blobs.receiveShadow = true;
  root.add(blobs);

  // ---- everything static below is baked into ~1 mesh per material ------------
  const statics = new THREE.Group();
  const avoid: AvoidZone[] = []; // furniture keep-clear discs for the scatter

  // ground: grass slab, top surface just below the road ribbon
  statics.add(at(box(matFn, GROUND_SIZE, 0.04, GROUND_SIZE, KPAL.grass), 0, -0.04, 0));

  // barrier posts: every BARRIER_EVERY segments at roadHalfW + BARRIER_OFF
  for (let i = 0; i < frames.length; i += BARRIER_EVERY) {
    const f = frames[i]!;
    const hex = (i / BARRIER_EVERY) % 2 === 0 ? KPAL.barrierWhite : KPAL.barrierRed;
    for (const side of [1, -1]) {
      statics.add(
        at(
          cyl(matFn, 0.09, 0.09, BARRIER_H, 8, hex),
          f.cx + f.lx * (w + BARRIER_OFF) * side,
          BARRIER_H / 2,
          f.cz + f.lz * (w + BARRIER_OFF) * side,
        ),
      );
    }
  }

  // start/finish: checkered band of small quads across gate 0
  const g0 = track.gates[0]!;
  const cell = (w * 2) / CHECKER_COLS;
  const checker = new THREE.Group();
  checker.position.set(g0.x, PAINT_Y, g0.z);
  checker.rotation.y = Math.atan2(-g0.tx, -g0.tz); // local -z = direction of travel
  for (let r = 0; r < CHECKER_ROWS; r++) {
    for (let c = 0; c < CHECKER_COLS; c++) {
      const hex = (r + c) % 2 === 0 ? KPAL.startLine : KPAL.ink;
      checker.add(
        at(
          box(matFn, cell * 0.98, 0.02, cell * 0.98, hex),
          (c + 0.5 - CHECKER_COLS / 2) * cell,
          0,
          (CHECKER_ROWS / 2 - r - 0.5) * cell,
        ),
      );
    }
  }
  statics.add(checker);

  // grid slot markers: one outlined stall per slot behind the line
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const s = gridSlot(track, i);
    const stall = new THREE.Group();
    stall.position.set(s.x, PAINT_Y, s.z);
    stall.rotation.y = s.yaw;
    stall.add(at(box(matFn, 1.7, 0.02, 0.14, KPAL.startLine), 0, 0, -1.25));
    stall.add(at(box(matFn, 1.7, 0.02, 0.14, KPAL.startLine), 0, 0, 1.25));
    stall.add(at(box(matFn, 0.14, 0.02, 2.5, KPAL.startLine), -0.85, 0, 0));
    stall.add(at(box(matFn, 0.14, 0.02, 2.5, KPAL.startLine), 0.85, 0, 0));
    statics.add(stall);
  }

  // ---- furniture ---------------------------------------------------------------
  const furnNext = rng(decoSeed('kart-circuit', 16));

  // start gantry over the line
  const gantry = buildGantry(matFn, track);
  statics.add(gantry);
  for (const side of [1, -1]) {
    avoid.push({ x: g0.x + -g0.tz * (w + GANTRY_OFF) * side, z: g0.z + g0.tx * (w + GANTRY_OFF) * side, r: 2 });
  }

  // red/white tire stacks at corner apexes (inside of the corner)
  let stackIdx = 0;
  for (const apex of apexes.slice(0, 8)) {
    for (const ds of [-2, 0, 2]) {
      const f = frames[(apex.index + ds + n) % n]!;
      const lat = apex.side * (w + STACK_OFF);
      const x = f.cx + f.lx * lat;
      const z = f.cz + f.lz * lat;
      const stack = buildTireStack(matFn, stackIdx % 2 === 0 ? KPAL.barrierRed : KPAL.barrierWhite);
      stack.position.set(x, 0, z);
      stack.rotation.y = furnNext() * Math.PI * 2;
      statics.add(stack);
      avoid.push({ x, z, r: 1.8 });
      stackIdx++;
    }
  }

  // lamp posts along the circuit, alternating sides
  for (let i = 7; i < n; i += LAMP_EVERY) {
    const f = frames[i]!;
    const side = (Math.floor(i / LAMP_EVERY) % 2) === 0 ? 1 : -1;
    const lat = side * (w + LAMP_OFF);
    const x = f.cx + f.lx * lat;
    const z = f.cz + f.lz * lat;
    const lamp = buildLamp(matFn);
    lamp.position.set(x, 0, z);
    lamp.rotation.y = Math.atan2(-side * f.lx, -side * f.lz); // arm toward the road
    statics.add(lamp);
    avoid.push({ x, z, r: 1.5 });
  }

  // billboards on the straightest links: midpoints between well-separated apexes
  // (this circuit never flattens below ~0.11 rad/sample sustained, so an absolute
  // curvature threshold finds nothing — apex midpoints are straightest by construction)
  const bbSpots: number[] = [];
  for (let k = 0; k < apexes.length; k++) {
    const a = apexes[k]!;
    const b = apexes[(k + 1) % apexes.length]!;
    const gap = (b.index - a.index + n) % n;
    if (gap < 34 || gap > 90) continue; // real links only, not chicanes/sweepers
    bbSpots.push((a.index + Math.floor(gap / 2)) % n);
  }
  let bbSide = furnNext() < 0.5 ? 1 : -1;
  for (const spot of bbSpots.slice(0, BILLBOARD_COUNT)) {
    const f = frames[spot]!;
    const lat = bbSide * (w + BILLBOARD_OFF + rngRange(furnNext, 0, 2.5));
    const x = f.cx + f.lx * lat;
    const z = f.cz + f.lz * lat;
    const bb = buildBillboard(matFn, bbSpots.indexOf(spot));
    bb.position.set(x, 0, z);
    bb.rotation.y = Math.atan2(f.cx - x, f.cz - z); // face the centerline
    statics.add(bb);
    avoid.push({ x, z, r: 3.5 });
    bbSide = -bbSide;
  }

  // pit building on the infield side of the start straight + its cone row
  const pf = frames[PIT_SAMPLE]!;
  const pitSide = (-pf.cx * pf.lx + -pf.cz * pf.lz) >= 0 ? 1 : -1; // toward the loop interior
  const pitLat = pitSide * (w + 13);
  const pitX = pf.cx + pf.lx * pitLat;
  const pitZ = pf.cz + pf.lz * pitLat;
  const pit = buildPitBuilding(matFn);
  pit.position.set(pitX, 0, pitZ);
  pit.rotation.y = Math.atan2(pf.cx - pitX, pf.cz - pitZ); // face the track
  statics.add(pit);
  avoid.push({ x: pitX, z: pitZ, r: 11 });

  // cones: pit-lane edge from gate 7 to the line + a rank in front of the garage
  for (let i = 222; i <= 252; i += 3) {
    const f = frames[i % n]!;
    const lat = pitSide * (w + 1.55);
    statics.add(at(buildCone(matFn), f.cx + f.lx * lat, 0, f.cz + f.lz * lat));
  }
  for (let c = 0; c < 5; c++) {
    const fx = pitX + Math.sin(pit.rotation.y) * 4.2 + (c - 2) * 1.4 * Math.cos(pit.rotation.y);
    const fz = pitZ + Math.cos(pit.rotation.y) * 4.2 - (c - 2) * 1.4 * Math.sin(pit.rotation.y);
    statics.add(at(buildCone(matFn), fx, 0, fz));
  }

  // grandstand on the start straight, on the side away from any straight-side
  // billboard (completes the start-zone vignette: gantry + lights + stand + pit)
  const sf = frames[STAND_SAMPLE]!;
  let standSide = (-sf.cx * sf.lx + -sf.cz * sf.lz) >= 0 ? -1 : 1; // prefer the outside
  for (const zn of avoid) {
    // a billboard keep-clear disc near the anchor on our side => flip
    const dAnchor = Math.hypot(zn.x - sf.cx, zn.z - sf.cz);
    if (dAnchor > 40) continue;
    const latSign = (zn.x - sf.cx) * sf.lx + (zn.z - sf.cz) * sf.lz >= 0 ? 1 : -1;
    if (latSign === standSide && zn.r >= 3) standSide = -standSide;
  }
  const standLat = standSide * (w + STAND_OFF);
  const standX = sf.cx + sf.lx * standLat;
  const standZ = sf.cz + sf.lz * standLat;
  const stand = buildGrandstand(matFn, furnNext);
  stand.position.set(standX, 0, standZ);
  stand.rotation.y = Math.atan2(sf.cx - standX, sf.cz - standZ); // face the track
  statics.add(stand);
  avoid.push({ x: standX, z: standZ, r: 12 });

  // brake boards: 3-2-1 markers on the outside of each corner approach
  for (const apex of apexes.slice(0, 8)) {
    const outSide = -apex.side;
    for (let b = 0; b < BRAKE_DISTS.length; b++) {
      const i = (apex.index - BRAKE_DISTS[b]! + n) % n;
      const f = frames[i]!;
      const lat = outSide * (w + BOARD_OFF);
      const x = f.cx + f.lx * lat;
      const z = f.cz + f.lz * lat;
      const board = buildBrakeBoard(matFn, String(3 - b));
      board.position.set(x, 0, z);
      const [tx, tz] = frameTangent(f);
      board.rotation.y = Math.atan2(-tx, -tz); // face the approaching traffic
      statics.add(board);
      avoid.push({ x, z, r: 1.2 });
    }
  }

  // ground scatter: low flowers/bushes/pebbles along both track edges (baked,
  // non-collidable — everything sits outside the kart's max reach of ~6.2m)
  const gsNext = rng(decoSeed('kart-circuit', 17));
  const FLOWERS = [KPAL.kartYellow, KPAL.kartRed, KPAL.curbWhite, KPAL.kartPink];
  for (let i = 0; i < n; i += 2) {
    for (const side of [1, -1]) {
      if (gsNext() < 0.55) continue;
      const f = frames[i]!;
      const lat = side * (w + rngRange(gsNext, 2.6, 8.5));
      const x = f.cx + f.lx * lat + rngRange(gsNext, -0.6, 0.6);
      const z = f.cz + f.lz * lat + rngRange(gsNext, -0.6, 0.6);
      if (inAvoid(x, z, avoid)) continue;
      const pick = gsNext();
      if (pick < 0.45) {
        // flower tuft: dark stem cube + palette bloom cube
        const fl = new THREE.Group();
        fl.add(at(box(matFn, 0.07, 0.22, 0.07, KPAL.grassDark), 0, 0.11, 0));
        fl.add(at(box(matFn, 0.17, 0.12, 0.17, FLOWERS[rngInt(gsNext, 0, FLOWERS.length - 1)]!), 0, 0.27, 0));
        fl.position.set(x, 0, z);
        statics.add(fl);
      } else if (pick < 0.8) {
        // low bush: squashed leaf-tone blob
        const bush = sphere(matFn, rngRange(gsNext, 0.28, 0.55), 6, leafTone(gsNext));
        bush.scale.set(rngRange(gsNext, 0.9, 1.3), rngRange(gsNext, 0.5, 0.7), rngRange(gsNext, 0.9, 1.3));
        bush.position.set(x, 0.18, z);
        bush.rotation.y = gsNext() * Math.PI;
        statics.add(bush);
      } else {
        // pebble: small squashed rock
        const r = rngRange(gsNext, 0.14, 0.3);
        const pebble = sphere(matFn, r, 5, KPAL.rock);
        pebble.scale.set(rngRange(gsNext, 0.9, 1.3), 0.55, rngRange(gsNext, 0.9, 1.3));
        pebble.position.set(x, r * 0.3, z);
        statics.add(pebble);
      }
    }
  }

  // seeded scatter: CLUSTERED trees (bare gaps between groves) + sparse rocks,
  // never on the road (|lateral| > halfW + 4)
  const next = rng(decoSeed('kart-circuit', 0));
  let trees = 0;
  const clusters: Array<{ x: number; z: number }> = [];
  for (
    let attempt = 0;
    attempt < CLUSTER_COUNT * 30 && clusters.length < CLUSTER_COUNT && trees < TREE_COUNT;
    attempt++
  ) {
    const cx = rngRange(next, -SCATTER_X, SCATTER_X);
    const cz = rngRange(next, -SCATTER_Z, SCATTER_Z);
    if (Math.abs(closestOnTrack(track, cx, cz).lateral) <= w + 6) continue;
    if (inAvoid(cx, cz, avoid)) continue;
    let clusterClash = false;
    for (const cl of clusters) {
      const dx = cl.x - cx;
      const dz = cl.z - cz;
      if (dx * dx + dz * dz < CLUSTER_SPACING * CLUSTER_SPACING) {
        clusterClash = true;
        break;
      }
    }
    if (clusterClash) continue;
    clusters.push({ x: cx, z: cz });
    const inCluster = Math.min(rngInt(next, 3, 10), TREE_COUNT - trees);
    for (let t = 0; t < inCluster; t++) {
      const ang = next() * Math.PI * 2;
      const rr = rngRange(next, 1.5, CLUSTER_R) * (0.5 + next()); // uneven grove density
      const x = cx + Math.cos(ang) * rr;
      const z = cz + Math.sin(ang) * rr;
      if (Math.abs(closestOnTrack(track, x, z).lateral) <= w + PROP_CLEARANCE) continue;
      if (inAvoid(x, z, avoid)) continue;
      const tree = buildAnyTree(matFn, next);
      tree.position.set(x, 0, z);
      statics.add(tree);
      trees++;
    }
  }
  // top-up: a few lone stragglers if the groves undershot the count
  const placed: Array<{ x: number; z: number }> = [];
  for (let attempt = 0; attempt < TREE_COUNT * 30 && trees < TREE_COUNT; attempt++) {
    const x = rngRange(next, -SCATTER_X, SCATTER_X);
    const z = rngRange(next, -SCATTER_Z, SCATTER_Z);
    if (Math.abs(closestOnTrack(track, x, z).lateral) <= w + PROP_CLEARANCE) continue;
    if (tooClose(x, z, placed)) continue;
    if (inAvoid(x, z, avoid)) continue;
    placed.push({ x, z });
    const tree = buildAnyTree(matFn, next);
    tree.position.set(x, 0, z);
    statics.add(tree);
    trees++;
  }
  // rocks: sparse and even, contrast with the clustered trees
  let rocks = 0;
  for (let attempt = 0; attempt < ROCK_COUNT * 30 && rocks < ROCK_COUNT; attempt++) {
    const x = rngRange(next, -SCATTER_X, SCATTER_X);
    const z = rngRange(next, -SCATTER_Z, SCATTER_Z);
    if (Math.abs(closestOnTrack(track, x, z).lateral) <= w + PROP_CLEARANCE) continue;
    if (tooClose(x, z, placed)) continue;
    if (inAvoid(x, z, avoid)) continue;
    placed.push({ x, z });
    const rock = buildRock(matFn, next);
    rock.position.set(x, 0, z);
    statics.add(rock);
    rocks++;
  }

  // tree line: a mid-distance band of trees between the circuit and the ridges
  const lineNext = rng(decoSeed('kart-circuit', 14));
  let lineTrees = 0;
  const linePlaced: Array<{ x: number; z: number }> = [];
  for (let attempt = 0; attempt < TREELINE_COUNT * 20 && lineTrees < TREELINE_COUNT; attempt++) {
    const ang = lineNext() * Math.PI * 2;
    const r = rngRange(lineNext, TREELINE_R_MIN, TREELINE_R_MAX);
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r * 0.94; // slight ellipse matches the circuit's aspect
    if (Math.abs(closestOnTrack(track, x, z).lateral) <= w + 6) continue;
    if (tooClose(x, z, linePlaced)) continue;
    if (inAvoid(x, z, avoid)) continue;
    linePlaced.push({ x, z });
    const tree = buildAnyTree(matFn, lineNext);
    tree.position.set(x, 0, z);
    statics.add(tree);
    lineTrees++;
  }

  // horizon: two ridgeline layers — dark near ridge, taller hazier far ridge.
  // Vertex-color gradients + fog do the atmospheric depth; no cone hills.
  const ridgeNext = rng(decoSeed('kart-circuit', 15));
  const ridgeFar = new THREE.Mesh(
    ridgelineGeometry(RIDGE_FAR_R, RIDGE_FAR_PEAK, ridgeNext, KPAL.rock, KPAL.steel),
    vertexPaintMaterial(),
  );
  root.add(ridgeFar);
  const ridgeNear = new THREE.Mesh(
    ridgelineGeometry(RIDGE_NEAR_R, RIDGE_NEAR_PEAK, ridgeNext, KPAL.grassDark, KPAL.treeLeaf),
    vertexPaintMaterial(),
  );
  root.add(ridgeNear);

  root.add(bake(statics)); // one merged mesh per material, shadows on
  return root;
}

// ============================================================================
// KART GP — track/environment mesh builder (split out of render.ts; the frozen
// KartScene export still owns the public API). Everything static on the circuit:
//   road ribbon (tier-banded asphalt: asphaltDeep edge wear, longitudinal seams,
//     rubbered racing lines, asphaltLight crown, seeded albedo grain)
//   painted markings (dashes, start line, grid stalls) + repair patches/grime
//   curbs, dirt shoulders + the asphaltDeep contact band where road meets grass
//   ground: a tier-mottled grass field (NEVER one uncut green), mown stripe
//     bands along the verge, seeded tone patches and track-edge dirt wear
//   barrier posts, furniture: start gantry ('KART GP'), apex tire stacks + skid
//     decals, pit building + cones, billboards, lamp posts, packed grandstand
//   scatter (3 two-tier-canopy tree species in seeded clusters / rocks),
//     mid-distance tree line, three-layer ridgeline horizon hazing toward fog
// Every prop, post and tree sits on a `…Deep` contact pad — this round's stand-in
// for ambient occlusion (VISUAL_UPGRADE.md §4), and what stops trackside
// furniture reading as decals pasted on the grass.
// All statics are baked into ~1 mesh per material to keep draw calls flat
// (~35 world draw calls total). All scatter is seeded (@platform/shared rng) —
// Math.random is never touched. The cached material factory (mat) stays in
// render.ts and is threaded through here as MatFn so both modules share the one
// material cache. NOTHING here feeds closestOnTrack/barrier math: every add-on
// is a flat paint layer or sits outside the physical barrier band.
// ============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { decoSeed, mix, rng, rngInt, rngRange } from '@platform/shared';
import {
  CROWD_COLORS,
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
const RIDGE_MID_R = 224; // mid ridge: the middle rung of the distance ladder
const RIDGE_MID_PEAK = 33;
const RIDGE_FAR_R = 248; // far ridge: tall, hazed toward the fog
const RIDGE_FAR_PEAK = 46;
// -- asphalt banding (VISUAL_UPGRADE.md §4: "road is a uniform black ribbon").
// One entry per longitudinal column across the road, sorted by lateral offset
// (fraction of halfW). `hex` is the NAMED ladder tier the column is painted
// from — every value step comes from the tier, never from a multiplier; `tone`
// is grain only. `rubber` columns darken further where karts fight for grip.
// Reads outward-in: asphaltDeep edge wear -> asphalt body -> a thin asphaltDeep
// longitudinal seam under each racing line -> asphaltLight centre crown.
interface RoadBand {
  readonly off: number;
  readonly hex: string;
  readonly tone: number;
  readonly rubber: boolean;
}
const ROAD_BANDS: readonly RoadBand[] = [
  { off: -1.0, hex: KPAL.asphaltDeep, tone: 1.0, rubber: false },
  { off: -0.93, hex: KPAL.asphaltDeep, tone: 1.14, rubber: false },
  { off: -0.86, hex: KPAL.asphalt, tone: 0.88, rubber: false },
  { off: -0.64, hex: KPAL.asphalt, tone: 1.0, rubber: false },
  { off: -0.6, hex: KPAL.asphaltDeep, tone: 1.18, rubber: false },
  { off: -0.56, hex: KPAL.asphalt, tone: 0.94, rubber: true },
  { off: -0.4, hex: KPAL.asphalt, tone: 1.02, rubber: true },
  { off: -0.22, hex: KPAL.asphaltLight, tone: 0.97, rubber: false },
  { off: 0, hex: KPAL.asphaltLight, tone: 1.03, rubber: false },
  { off: 0.22, hex: KPAL.asphaltLight, tone: 0.97, rubber: false },
  { off: 0.4, hex: KPAL.asphalt, tone: 1.02, rubber: true },
  { off: 0.56, hex: KPAL.asphalt, tone: 0.94, rubber: true },
  { off: 0.6, hex: KPAL.asphaltDeep, tone: 1.18, rubber: false },
  { off: 0.64, hex: KPAL.asphalt, tone: 1.0, rubber: false },
  { off: 0.86, hex: KPAL.asphalt, tone: 0.88, rubber: false },
  { off: 0.93, hex: KPAL.asphaltDeep, tone: 1.14, rubber: false },
  { off: 1.0, hex: KPAL.asphaltDeep, tone: 1.0, rubber: false },
];
const GRIME_Y = 0.013; // road-edge dirt accumulation (road < grime < curb paint)
const SKID_Y = 0.016; // apex skid decals (below repair patches)
const PATCH_Y = 0.017; // repair rectangles (below the dashes)
const PATCH_COUNT = 22;
const SHOULDER_W = 0.8; // dirt ring just outside the curbs
const SHOULDER_DEEP_W = 0.55; // asphaltDeep CONTACT BAND: road assembly -> grass
const SHOULDER_Y = -0.004; // on the grass field (top -0.02), under the road plane
const BLOB_Y = -0.008; // grass tone blobs sit on the field, under the road plane
const BLOB_BIG = 30; // broad faint mottling
const BLOB_SMALL = 190; // distinct four-tier patches
const BLOB_SPACING = 3.4; // min center distance between grass patches
const EDGE_WEAR_Y = -0.005; // dirt scuffed off the shoulder onto the grass
const GROUND_Y = -0.02; // the grass field plane (was a flat slab, now mottled)
const GROUND_CELLS = 32; // field subdivisions; per-vertex tier = soft patchwork
const MOWN_Y = -0.006; // mown stripe bands ride over the field, under the dirt
const MOWN_SEGS = 5; // segments per mown stripe (~11 m at 256 samples)
// Mown stripe bands: lateral offsets past the contact band, each alternating
// between two named grass tiers. §4: "mown-stripe bands running along the track".
const MOWN_BANDS: ReadonlyArray<{ from: number; to: number; a: string; b: string }> = [
  { from: 0, to: 2.4, a: KPAL.grassLit, b: KPAL.grassDark },
  { from: 2.4, to: 5.3, a: KPAL.grass, b: KPAL.grassLit },
  { from: 5.3, to: 9.0, a: KPAL.grassDark, b: KPAL.grass },
];
const APRON_FOLD_MIN = 0.3; // min arc factor for offset apron layers (see apronLimits)
const PAD_H = 0.024; // …Deep contact pad thickness under every prop
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
// Road strip: one shared vertex per ROAD_BANDS column per sample, indices wound
// to face +y. Normals are set straight up — the road is flat by construction.
// Vertex colors carry the asphalt TIER banding (asphaltDeep edge wear and
// longitudinal seams, asphalt body, rubbered lines that deepen where karts fight
// through corners, asphaltLight crown) x a seeded albedo grain (4-sample groups
// + fine drift). The tiers do the value work; the grain only breaks up flatness.

function roadGeometry(
  frames: SampleFrame[],
  halfW: number,
  turn: readonly number[],
  next: () => number,
): THREE.BufferGeometry {
  const n = frames.length;
  const cols = ROAD_BANDS.length;
  const bandCol = ROAD_BANDS.map((b) => new THREE.Color(b.hex));
  // patchwork: per 4-sample group multiplier, ~18% of groups noticeably shifted
  const groups = Math.ceil(n / 4);
  const groupMul: number[] = [];
  for (let g = 0; g < groups; g++) {
    groupMul.push(next() < 0.18 ? (next() < 0.5 ? 0.86 : 1.14) : 0.95 + next() * 0.1);
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
      const band = ROAD_BANDS[c]!;
      const off = band.off * halfW;
      const k = (i * cols + c) * 3;
      pos[k] = f.cx + f.lx * off;
      pos[k + 1] = 0;
      pos[k + 2] = f.cz + f.lz * off;
      nrm[k + 1] = 1;
      const tone = (band.rubber ? band.tone * (1 - cornerGrip) : band.tone) * jitter;
      const base = bandCol[c]!;
      col[k] = Math.min(1, base.r * tone);
      col[k + 1] = Math.min(1, base.g * tone);
      col[k + 2] = Math.min(1, base.b * tone);
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

  // grime strips: lat in [halfW-0.85, halfW-0.15] on both sides, ~62% coverage,
  // alternating the two dirt tiers so the road edge is never one flat smear
  for (let i = 0; i < n; i++) {
    if (next() < 0.38) continue;
    const c = shade(next() < 0.45 ? KPAL.dirtDeep : KPAL.dirt, 0.9 + next() * 0.2);
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
        strip((start + s + n) % n, lat + w2, lat - w2, SKID_Y, shade(KPAL.asphaltDeep, rngRange(next, 0.62, 0.86)));
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
    // fresh dark repaves in asphaltDeep, bleached old ones in asphaltLit — the
    // patch value comes from the named tier, the jitter is grain only (§4).
    const dark = next() < 0.5;
    const c = dark
      ? shade(KPAL.asphaltDeep, rngRange(next, 0.94, 1.14))
      : shade(KPAL.asphaltLit, rngRange(next, 0.9, 1.06));
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
 * The grass field itself. THE worst thing in KART was one flat uniform green
 * slab covering the whole world (VISUAL_UPGRADE.md §4), so the slab is gone:
 * this is a subdivided plane whose PER-VERTEX colour is a named grass tier
 * chosen by a seeded harmonic field. The GPU interpolates between neighbouring
 * tier vertices, so the ground reads as soft organic patches of grassDeep /
 * grassDark / grass / grassLit and never as one uncut colour. Flat, one draw
 * call, no texture — the colour attribute of the pre-existing vertex-colour
 * Lambert is doing all of the work.
 */
function groundGeometry(next: () => number): THREE.BufferGeometry {
  const cells = GROUND_CELLS;
  const half = GROUND_SIZE / 2;
  const step = GROUND_SIZE / cells;
  const tiers = [KPAL.grassDeep, KPAL.grassDark, KPAL.grass, KPAL.grassLit].map((h) => new THREE.Color(h));
  // three broad harmonics: big soft regions, not a checkerboard
  const wave = [
    { fx: rngRange(next, 0.008, 0.017), fz: rngRange(next, 0.008, 0.017), p: next() * Math.PI * 2, a: 0.46 },
    { fx: rngRange(next, 0.02, 0.035), fz: rngRange(next, 0.02, 0.035), p: next() * Math.PI * 2, a: 0.33 },
    { fx: rngRange(next, 0.05, 0.08), fz: rngRange(next, 0.05, 0.08), p: next() * Math.PI * 2, a: 0.21 },
  ];
  const verts = (cells + 1) * (cells + 1);
  const pos = new Float32Array(verts * 3);
  const nrm = new Float32Array(verts * 3);
  const col = new Float32Array(verts * 3);
  for (let ix = 0; ix <= cells; ix++) {
    for (let iz = 0; iz <= cells; iz++) {
      const x = -half + ix * step;
      const z = -half + iz * step;
      let f = 0;
      for (const w of wave) f += w.a * Math.sin(w.fx * x + w.p) * Math.cos(w.fz * z + w.p * 0.5);
      // ragged tier boundaries: without the jitter the field bands too cleanly
      f = 0.5 + f * 0.5 + rngRange(next, -0.09, 0.09);
      const tier = f < 0.2 ? 0 : f < 0.44 ? 1 : f < 0.84 ? 2 : 3;
      const c = tiers[tier]!;
      const k = ((ix * (cells + 1)) + iz) * 3;
      pos[k] = x;
      pos[k + 1] = GROUND_Y;
      pos[k + 2] = z;
      nrm[k + 1] = 1;
      col[k] = c.r;
      col[k + 1] = c.g;
      col[k + 2] = c.b;
    }
  }
  const idx: number[] = [];
  const vid = (ix: number, iz: number): number => ix * (cells + 1) + iz;
  for (let ix = 0; ix < cells; ix++) {
    for (let iz = 0; iz < cells; iz++) {
      const a = vid(ix, iz + 1);
      const b = vid(ix + 1, iz + 1);
      const c = vid(ix, iz);
      const d = vid(ix + 1, iz);
      idx.push(a, b, c, c, b, d); // same winding convention as ribbonGeometry (+y)
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
 * Per-sample cap on how far a flat apron layer may be offset to each side before
 * the parallel curve folds back through the corner's centre of curvature. A
 * ribbon at lateral offset `o` has arc factor (1 - k*o) for signed curvature k
 * (+ = turning left); keeping that above APRON_FOLD_MIN makes the apron PINCH
 * SHUT on the inside of a hairpin instead of self-intersecting. This circuit
 * drops to a ~9 m radius, so a fixed-width apron would fold on ~24 samples.
 * Returns [maxLeftOffset, maxRightOffset] per sample.
 */
function apronLimits(frames: SampleFrame[]): Array<[number, number]> {
  const n = frames.length;
  const cap = 1 - APRON_FOLD_MIN;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const a = frames[(i - 2 + n) % n]!;
    const b = frames[(i + 2) % n]!;
    const [tax, taz] = frameTangent(a);
    const [tbx, tbz] = frameTangent(b);
    let arc = 0;
    for (let s = -2; s < 2; s++) {
      const p = frames[(i + s + n) % n]!;
      const q = frames[(i + s + 1 + n) % n]!;
      arc += Math.hypot(q.cx - p.cx, q.cz - p.cz);
    }
    const dth = Math.atan2(tax * tbz - taz * tbx, tax * tbx + taz * tbz);
    const k = arc > 0 ? dth / arc : 0;
    out.push([k > 1e-6 ? cap / k : Infinity, k < -1e-6 ? cap / -k : Infinity]);
  }
  return out;
}

/**
 * Mown stripe bands running ALONG the track (§4). Three lateral bands per side
 * outside the contact band, each alternating between two named grass tiers every
 * MOWN_SEGS segments with a per-band phase, so the verge reads as cut turf with
 * a mower's rhythm instead of a flat green apron. Offsets are clamped by
 * apronLimits so the bands taper through tight corners. One vertex-colour
 * geometry, wound to face +y like every other paint layer.
 */
function mownStripeGeometry(frames: SampleFrame[], halfW: number, next: () => number): THREE.BufferGeometry {
  const n = frames.length;
  const inner = halfW + CURB_W + SHOULDER_W + SHOULDER_DEEP_W;
  const stripes = Math.ceil(n / MOWN_SEGS);
  const limits = apronLimits(frames);
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (const band of MOWN_BANDS) {
    const ca = new THREE.Color(band.a);
    const cb = new THREE.Color(band.b);
    const phase = rngInt(next, 0, 1);
    const tone: number[] = [];
    for (let s = 0; s < stripes; s++) tone.push(rngRange(next, 0.93, 1.07));
    for (const side of [1, -1]) {
      const li = side > 0 ? 0 : 1; // which apron limit this side is bounded by
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const cap = Math.min(limits[i]![li], limits[j]![li]);
        const from = Math.min(inner + band.from, cap);
        const to = Math.min(inner + band.to, cap);
        if (to - from < 0.06) continue; // pinched shut through the apex
        const s = Math.floor(i / MOWN_SEGS) % stripes;
        const c = (s + phase) % 2 === 0 ? ca : cb;
        const t = tone[s]!;
        const a = frames[i]!;
        const b = frames[j]!;
        const lo = side > 0 ? to : -from;
        const ro = side > 0 ? from : -to;
        const base = pos.length / 3;
        for (const v of [
          [a.cx + a.lx * lo, MOWN_Y, a.cz + a.lz * lo],
          [b.cx + b.lx * lo, MOWN_Y, b.cz + b.lz * lo],
          [a.cx + a.lx * ro, MOWN_Y, a.cz + a.lz * ro],
          [b.cx + b.lx * ro, MOWN_Y, b.cz + b.lz * ro],
        ] as ReadonlyArray<readonly [number, number, number]>) {
          pos.push(v[0], v[1], v[2]);
          nrm.push(0, 1, 0);
          col.push(Math.min(1, c.r * t), Math.min(1, c.g * t), Math.min(1, c.b * t));
        }
        idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

/**
 * Grass tone layer: broad tier mottling + smaller four-tier patches + the dirt
 * WEAR scuffed off the shoulder onto the verge (irregular seeded fans, flat on
 * the field, never on the road/shoulder). One draw call.
 */
function grassPatchGeometry(
  track: TrackDef,
  frames: SampleFrame[],
  halfW: number,
  next: () => number,
): THREE.BufferGeometry {
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

  // broad mottling: large, soft tier shifts over the whole apron
  for (let p = 0; p < BLOB_BIG; p++) {
    const x = rngRange(next, -SCATTER_X - 30, SCATTER_X + 30);
    const z = rngRange(next, -SCATTER_Z - 30, SCATTER_Z + 30);
    if (Math.abs(closestOnTrack(track, x, z).lateral) <= halfW + PROP_CLEARANCE) continue;
    const hex = next() < 0.5 ? KPAL.grassDark : KPAL.grassLit;
    blob(x, z, rngRange(next, 10, 26), BLOB_Y - 0.006, shade(hex, rngRange(next, 0.95, 1.05)));
  }

  // distinct patches: all four grass tiers, weighted toward the mid two
  for (let attempt = 0, done = 0; attempt < BLOB_SMALL * 20 && done < BLOB_SMALL; attempt++) {
    const x = rngRange(next, -SCATTER_X - 15, SCATTER_X + 15);
    const z = rngRange(next, -SCATTER_Z - 15, SCATTER_Z + 15);
    if (Math.abs(closestOnTrack(track, x, z).lateral) <= halfW + CURB_W + 2.0) continue;
    if (tooCloseR(x, z, placed, BLOB_SPACING)) continue;
    placed.push({ x, z });
    const pick = next();
    const hex =
      pick < 0.14 ? KPAL.grassDeep : pick < 0.46 ? KPAL.grassDark : pick < 0.82 ? KPAL.grassLit : KPAL.grass;
    blob(x, z, rngRange(next, 1.6, 5.5), BLOB_Y, shade(hex, rngRange(next, 0.94, 1.06)));
  }

  // track-edge wear: dirt scuffed off the shoulder onto the grass, broken so the
  // road never meets the verge on a clean machined line (§4)
  const wearFrom = halfW + CURB_W + SHOULDER_W + SHOULDER_DEEP_W;
  for (let i = 0; i < frames.length; i += 2) {
    for (const side of [1, -1]) {
      if (next() < 0.62) continue;
      const f = frames[i]!;
      const lat = side * (wearFrom + rngRange(next, -0.15, 1.3));
      const x = f.cx + f.lx * lat;
      const z = f.cz + f.lz * lat;
      const hex = next() < 0.42 ? KPAL.dirtDeep : KPAL.dirt;
      blob(x, z, rngRange(next, 0.5, 1.5), EDGE_WEAR_Y, shade(hex, rngRange(next, 0.92, 1.08)));
    }
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

/** Min center distance `minDist` to every already-placed point. */
function tooCloseR(
  x: number,
  z: number,
  placed: ReadonlyArray<{ x: number; z: number }>,
  minDist: number,
): boolean {
  const d2 = minDist * minDist;
  for (const p of placed) {
    const dx = p.x - x;
    const dz = p.z - z;
    if (dx * dx + dz * dz < d2) return true;
  }
  return false;
}

/** Min center distance to every already-placed prop (PROP_SPACING). */
function tooClose(x: number, z: number, placed: ReadonlyArray<{ x: number; z: number }>): boolean {
  return tooCloseR(x, z, placed, PROP_SPACING);
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

/**
 * Flat `…Deep` contact band under a prop. Every prop, post and tree gets one:
 * it is this round's stand-in for ambient occlusion (VISUAL_UPGRADE.md §4) and
 * is what stops trackside furniture reading as a decal pasted on the verge.
 * `hex` must be the Deep tier of whatever the prop is standing ON — grassDeep
 * out on the field, dirtDeep on the shoulder, concreteDeep under a footing.
 */
function contactPad(matFn: MatFn, w: number, d: number, hex: string): THREE.Mesh {
  return at(box(matFn, w, PAD_H, d, hex), 0, PAD_H / 2, 0);
}

/**
 * Seeded canopy trio for one tree: [lit, body, deep]. Every species gets a
 * TWO-TIER canopy plus a deep underside so it stops reading as broccoli (§4) —
 * the tiers always come from the frozen treeLeaf ladder, never a multiplier.
 */
function canopyTiers(next: () => number): [string, string, string] {
  // half the trees run the ladder one rung lower: grove-to-grove tone variance
  return next() < 0.5
    ? [KPAL.treeLeafLight, KPAL.treeLeaf, KPAL.treeLeafDeep]
    : [KPAL.treeLeaf, KPAL.treeLeafDeep, KPAL.treeLeafDeep];
}

/** seeded leaf tone for low scatter bushes: the canopy ladder, one pick. */
function leafTone(next: () => number): string {
  const r = next();
  return r < 0.4 ? KPAL.treeLeaf : r < 0.75 ? KPAL.treeLeafLight : KPAL.treeLeafDeep;
}

/** broadleaf: trunk (+ deep root flare) + a lit crown over a deep underside. */
function buildBroadleaf(matFn: MatFn, next: () => number): THREE.Group {
  const g = new THREE.Group();
  const [lit, body, deep] = canopyTiers(next);
  const h = rngRange(next, 1.0, 1.6);
  g.add(at(cyl(matFn, 0.12, 0.18, h, 6, KPAL.treeTrunk), 0, h / 2, 0));
  g.add(at(cyl(matFn, 0.19, 0.26, 0.16, 6, KPAL.treeTrunkDeep), 0, 0.08, 0)); // root flare
  const r1 = rngRange(next, 0.9, 1.3);
  const under = sphere(matFn, r1 * 0.92, 6, deep); // shaded underside of the mass
  under.scale.set(1, 0.55, 1);
  g.add(at(under, 0, h + r1 * 0.4, 0));
  g.add(at(sphere(matFn, r1, 7, body), 0, h + r1 * 0.62, 0));
  const r2 = r1 * rngRange(next, 0.55, 0.7);
  g.add(
    at(
      sphere(matFn, r2, 6, lit),
      rngRange(next, -0.25, 0.25),
      h + r1 * 0.62 + r2 * 0.85,
      rngRange(next, -0.25, 0.25),
    ),
  );
  return g;
}

/** pine: short trunk + 3 stacked cones, deep skirt -> body -> lit tip. */
function buildPine(matFn: MatFn, next: () => number): THREE.Group {
  const g = new THREE.Group();
  const [lit, body, deep] = canopyTiers(next);
  const h = rngRange(next, 0.7, 1.1);
  g.add(at(cyl(matFn, 0.1, 0.16, h, 6, KPAL.treeTrunk), 0, h / 2, 0));
  g.add(at(cyl(matFn, 0.17, 0.24, 0.14, 6, KPAL.treeTrunkDeep), 0, 0.07, 0)); // root flare
  const r1 = rngRange(next, 0.75, 1.05);
  g.add(at(cone(matFn, r1 * 1.12, rngRange(next, 1.0, 1.3), 7, deep), 0, h + 0.34, 0));
  g.add(at(cone(matFn, r1, rngRange(next, 1.3, 1.7), 7, body), 0, h + 0.72, 0));
  g.add(at(cone(matFn, r1 * 0.6, rngRange(next, 0.9, 1.2), 7, lit), 0, h + 0.72 + r1 * 0.85, 0));
  return g;
}

/** poplar: tall trunk + a stretched crown, deep skirt under a lit tip. */
function buildPoplar(matFn: MatFn, next: () => number): THREE.Group {
  const g = new THREE.Group();
  const [lit, body, deep] = canopyTiers(next);
  const h = rngRange(next, 1.5, 2.2);
  g.add(at(cyl(matFn, 0.09, 0.14, h, 6, KPAL.treeTrunk), 0, h / 2, 0));
  g.add(at(cyl(matFn, 0.15, 0.21, 0.13, 6, KPAL.treeTrunkDeep), 0, 0.065, 0)); // root flare
  const r = rngRange(next, 0.5, 0.75);
  const skirt = sphere(matFn, r * 1.02, 6, deep);
  skirt.scale.set(1, rngRange(next, 0.9, 1.15), 1);
  g.add(at(skirt, 0, h + r * 0.85, 0));
  const crown = sphere(matFn, r, 7, body);
  crown.scale.set(1, rngRange(next, 1.9, 2.4), 1);
  crown.position.y = h + r * 1.65;
  g.add(crown);
  g.add(at(sphere(matFn, r * 0.5, 6, lit), 0, h + r * 3.1, 0));
  return g;
}

/**
 * One of the three silhouettes + a grassDeep contact pad, per-instance yaw and
 * a +-30 % scale spread (§4). Placed on the grass field only.
 */
function buildAnyTree(matFn: MatFn, next: () => number): THREE.Group {
  const r = next();
  const g = r < 0.34 ? buildPine(matFn, next) : r < 0.67 ? buildBroadleaf(matFn, next) : buildPoplar(matFn, next);
  g.add(contactPad(matFn, rngRange(next, 0.95, 1.35), rngRange(next, 0.95, 1.35), KPAL.grassDeep));
  g.rotation.y = next() * Math.PI * 2;
  g.scale.setScalar(rngRange(next, 0.7, 1.3));
  return g;
}

/** rock: 1-2 overlapping squashed spheres over a rockDeep base + grass pad. */
function buildRock(matFn: MatFn, next: () => number): THREE.Group {
  const g = new THREE.Group();
  g.add(contactPad(matFn, rngRange(next, 1.1, 1.5), rngRange(next, 1.1, 1.5), KPAL.grassDeep));
  const n = rngInt(next, 1, 2);
  for (let i = 0; i < n; i++) {
    const r = rngRange(next, 0.4, 0.9);
    const ox = rngRange(next, -0.4, 0.4);
    const oz = rngRange(next, -0.4, 0.4);
    const sx = rngRange(next, 0.9, 1.4);
    const sz = rngRange(next, 0.9, 1.4);
    const skirt = at(sphere(matFn, r * 1.05, 6, KPAL.rockDeep), ox, r * 0.16, oz); // bedded-in base
    skirt.scale.set(sx, 0.22, sz);
    g.add(skirt);
    const m = at(sphere(matFn, r, 7, KPAL.rock), ox, r * 0.5, oz);
    m.scale.set(sx, rngRange(next, 0.4, 0.65), sz);
    m.rotation.y = next() * Math.PI;
    g.add(m);
  }
  return g;
}

/** tire stack: 3 painted torus rings (red or white), apex furniture. */
function buildTireStack(matFn: MatFn, hex: string): THREE.Group {
  const g = new THREE.Group();
  g.add(contactPad(matFn, 1.0, 1.0, KPAL.grassDeep));
  g.add(at(cyl(matFn, 0.44, 0.48, 0.06, 10, KPAL.tire), 0, 0.05, 0)); // dark base ring
  for (let k = 0; k < 3; k++) {
    const t = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.13, 7, 12), matFn(hex));
    t.rotation.x = Math.PI / 2; // lie flat, hole up
    t.position.y = 0.2 + k * 0.26;
    g.add(t);
  }
  return g;
}

/**
 * Traffic cone: charcoal contact base (cones live on the dirt shoulder, so the
 * contact band is a dark plate rather than a grassDeep pad) + orange body +
 * white reflective collar.
 */
function buildCone(matFn: MatFn): THREE.Group {
  const g = new THREE.Group();
  g.add(at(box(matFn, 0.34, 0.045, 0.34, KPAL.charcoal), 0, 0.022, 0));
  g.add(at(cone(matFn, 0.16, 0.44, 8, KPAL.kartOrange), 0, 0.28, 0));
  g.add(at(cyl(matFn, 0.085, 0.105, 0.09, 8, KPAL.curbWhite), 0, 0.3, 0));
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
    g.add(at(box(matFn, 1.25, PAD_H, 1.25, KPAL.concreteDeep), x, PAD_H / 2, 0)); // footing pad
    g.add(at(box(matFn, 0.9, 0.18, 0.9, KPAL.steel), x, 0.11, 0)); // base plate
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
  g.add(contactPad(matFn, 3.6, 1.0, KPAL.grassDeep));
  for (const x of [-1.4, 1.4]) {
    g.add(at(box(matFn, 0.42, 0.16, 0.42, KPAL.concreteDeep), x, 0.08, 0)); // footing
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
  g.add(contactPad(matFn, 0.85, 0.85, KPAL.grassDeep));
  g.add(at(cyl(matFn, 0.16, 0.2, 0.22, 8, KPAL.steelDeep), 0, 0.11, 0)); // base collar
  g.add(at(cyl(matFn, 0.07, 0.1, 5.6, 7, KPAL.steel), 0, 2.9, 0));
  g.add(at(box(matFn, 0.1, 0.1, 1.7, KPAL.steel), 0, 5.52, 0.75));
  g.add(at(box(matFn, 0.34, 0.12, 0.66, KPAL.charcoal), 0, 5.42, 1.55));
  g.add(at(box(matFn, 0.26, 0.03, 0.5, KPAL.curbWhite), 0, 5.35, 1.55));
  return g;
}

/**
 * Pit building: white block + charcoal roof + red fascia with 'PIT' lettering,
 * windows/door, steel annex, roof clutter. Faces the track (local +z).
 */
function buildPitBuilding(matFn: MatFn): THREE.Group {
  const g = new THREE.Group();
  g.add(contactPad(matFn, 13.5, 8.0, KPAL.grassDeep)); // grounding band on the verge
  g.add(at(box(matFn, 11.0, 0.34, 5.5, KPAL.concreteDeep), 0, 0.17, 0)); // plinth
  g.add(at(box(matFn, 10.5, 3.4, 5.0, KPAL.curbWhite), 0, 2.04, 0));
  g.add(at(box(matFn, 10.9, 0.14, 5.4, KPAL.concrete), 0, 3.78, 0)); // eaves band
  g.add(at(box(matFn, 11.3, 0.28, 5.9, KPAL.charcoal), 0, 3.99, 0));
  g.add(at(box(matFn, 11.3, 0.46, 0.12, KPAL.kartRed), 0, 3.62, 2.92)); // fascia
  addBlockText(g, matFn, 'PIT', 0.13, KPAL.curbWhite, 3.62, 3.0, false);
  for (const x of [-3.8, -1.3, 1.2]) {
    g.add(at(box(matFn, 1.5, 1.1, 0.1, KPAL.ink), x, 2.24, 2.52)); // windows
    g.add(at(box(matFn, 1.66, 0.1, 0.08, KPAL.concreteDeep), x, 1.63, 2.54)); // sill
  }
  g.add(at(box(matFn, 1.1, 2.2, 0.1, KPAL.charcoal), 3.9, 1.44, 2.52)); // door
  g.add(at(box(matFn, 4.0, 0.3, 3.8, KPAL.concreteDeep), -7.6, 0.15, -0.4)); // annex plinth
  g.add(at(box(matFn, 3.6, 2.4, 3.4, KPAL.steel), -7.6, 1.5, -0.4)); // annex
  g.add(at(box(matFn, 3.8, 0.16, 3.6, KPAL.steelDeep), -7.6, 2.78, -0.4)); // annex cap
  g.add(at(box(matFn, 0.9, 0.4, 0.9, KPAL.steel), -2.5, 4.34, 0.8)); // roof clutter
  g.add(at(box(matFn, 0.9, 0.4, 0.9, KPAL.charcoal), 1.8, 4.34, -1.2));
  return g;
}

/**
 * Grandstand: grassDeep contact band + concreteDeep plinth, 5 ascending
 * terraces PACKED with a seeded crowd (body block from the frozen CROWD_COLORS
 * cycle + a darker head, two staggered rows per terrace, varied stature so a
 * few stand), back wall, roof slab on posts. An empty stand reads as a dead
 * world (VISUAL_UPGRADE.md §4), so density here is the whole point. Faces the
 * track (local +z). ~20m long, sits along the start straight.
 */
function buildGrandstand(matFn: MatFn, next: () => number): THREE.Group {
  const g = new THREE.Group();
  const LEN = 20;
  const TIERS = 5;
  g.add(contactPad(matFn, LEN + 3.4, 10.4, KPAL.grassDeep));
  g.add(at(box(matFn, LEN + 0.6, 0.34, 7.6, KPAL.concreteDeep), 0, 0.17, 0)); // plinth
  g.add(at(box(matFn, LEN, 0.28, 7, KPAL.steel), 0, 0.48, 0)); // deck
  let seat = rngInt(next, 0, CROWD_COLORS.length - 1);
  for (let k = 0; k < TIERS; k++) {
    const y = 0.62 + k * 0.55;
    const z = 2.5 - k * 1.35;
    // terraces overlap in y (0.62 tall on a 0.55 rise) so no slit shows between steps
    g.add(at(box(matFn, LEN, 0.62, 1.45, KPAL.asphaltLight), 0, y + 0.19, z));
    g.add(at(box(matFn, LEN, 0.12, 0.1, KPAL.concreteDeep), 0, y + 0.06, z + 0.72)); // riser shadow
    // two staggered crowd rows per terrace: front row sits, back row often stands
    for (let row = 0; row < 2; row++) {
      const rz = z + (row === 0 ? 0.34 : -0.3);
      let x = -LEN / 2 + 0.55 + (row === 0 ? 0 : 0.38);
      while (x < LEN / 2 - 0.55) {
        if (next() < 0.9) {
          const hex = CROWD_COLORS[seat % CROWD_COLORS.length]!;
          seat += rngInt(next, 1, 3); // cycle the palette, never two identical runs
          const stand = row === 1 && next() < 0.35;
          const bh = stand ? 0.72 : 0.5;
          const cx = x + rngRange(next, -0.08, 0.08);
          const cz = rz + rngRange(next, -0.12, 0.12);
          g.add(at(box(matFn, 0.44, bh, 0.42, hex), cx, y + 0.5 + bh / 2, cz));
          g.add(at(box(matFn, 0.26, 0.24, 0.26, KPAL.charcoal), cx, y + 0.5 + bh + 0.12, cz)); // head
        }
        x += rngRange(next, 0.62, 0.92);
      }
    }
  }
  g.add(at(box(matFn, LEN, 2.4, 0.35, KPAL.charcoal), 0, 1.8, -3.4)); // back wall
  g.add(at(box(matFn, LEN, 0.16, 0.42, KPAL.steelDeep), 0, 0.68, -3.4)); // wall footing
  for (const px of [-LEN / 2 + 0.6, LEN / 2 - 0.6]) {
    g.add(at(box(matFn, 0.3, 3.0, 0.3, KPAL.charcoal), px, 2.3, 2.9)); // roof posts (meet the slab)
    g.add(at(box(matFn, 0.46, 0.2, 0.46, KPAL.steelDeep), px, 0.72, 2.9)); // post base
  }
  g.add(at(box(matFn, LEN + 0.8, 0.22, 7.6, KPAL.ink), 0, 3.85, -0.2)); // roof slab
  g.add(at(box(matFn, LEN + 0.9, 0.14, 0.18, KPAL.gold), 0, 3.7, 3.5)); // roof edge trim
  return g;
}

/** brake board: white post + board with a dark block numeral ('3'/'2'/'1'). */
function buildBrakeBoard(matFn: MatFn, numeral: string): THREE.Group {
  const g = new THREE.Group(); // local +z faces approaching traffic
  g.add(contactPad(matFn, 0.46, 0.46, KPAL.dirtDeep)); // boards stand on the shoulder
  g.add(at(box(matFn, 0.16, 0.14, 0.16, KPAL.steelDeep), 0, 0.07, 0)); // foot
  g.add(at(box(matFn, 0.08, 1.05, 0.08, KPAL.curbWhite), 0, 0.55, 0)); // post
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

  // ---- the grass field: a tier-mottled plane, NOT a flat slab ---------------
  const groundNext = rng(decoSeed('kart-circuit', 18));
  const ground = new THREE.Mesh(groundGeometry(groundNext), vertexPaintMaterial());
  ground.receiveShadow = true;
  root.add(ground);

  // mown stripe bands along the verge (over the field, under the dirt wear)
  const mownNext = rng(decoSeed('kart-circuit', 19));
  const mown = new THREE.Mesh(mownStripeGeometry(frames, w, mownNext), vertexPaintMaterial());
  mown.receiveShadow = true;
  root.add(mown);

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

  // dirt shoulder ring (the two dirt tiers, alternating in runs) followed by the
  // asphaltDeep CONTACT BAND where the whole road assembly meets the grass —
  // that band is KART's L2 contact rule (VISUAL_UPGRADE.md §4).
  const dirtNext = rng(decoSeed('kart-circuit', 11));
  const dirtCols = [new THREE.Color(KPAL.dirt), new THREE.Color(KPAL.dirtDeep)];
  const dirtColor = (seg: number): [number, number, number] => {
    const c = dirtCols[Math.floor(seg / 3) % 2]!;
    const j = 0.92 + dirtNext() * 0.16;
    return [Math.min(1, c.r * j), Math.min(1, c.g * j), Math.min(1, c.b * j)];
  };
  const deepBand = new THREE.Color(KPAL.asphaltDeep);
  const deepColor = (): [number, number, number] => {
    const j = 0.92 + dirtNext() * 0.16;
    return [Math.min(1, deepBand.r * j), Math.min(1, deepBand.g * j), Math.min(1, deepBand.b * j)];
  };
  const shOuter = w + CURB_W + SHOULDER_W;
  const shDeep = shOuter + SHOULDER_DEEP_W;
  const shoulderParts = [
    ribbonGeometry(frames, shOuter, w + CURB_W, SHOULDER_Y, dirtColor, () => false),
    ribbonGeometry(frames, -(w + CURB_W), -shOuter, SHOULDER_Y, dirtColor, () => false),
    ribbonGeometry(frames, shDeep, shOuter, SHOULDER_Y, deepColor, () => false),
    ribbonGeometry(frames, -shOuter, -shDeep, SHOULDER_Y, deepColor, () => false),
  ];
  const dirtMerged = mergeGeometries(shoulderParts, false);
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

  // grass tone patches: four-tier blobs + broad mottling + track-edge dirt wear
  const blobNext = rng(decoSeed('kart-circuit', 13));
  const blobs = new THREE.Mesh(grassPatchGeometry(track, frames, w, blobNext), vertexPaintMaterial());
  blobs.receiveShadow = true;
  root.add(blobs);

  // ---- everything static below is baked into ~1 mesh per material ------------
  const statics = new THREE.Group();
  const avoid: AvoidZone[] = []; // furniture keep-clear discs for the scatter

  // (the ground is the vertex-coloured field mesh above — there is deliberately
  // no flat grass slab here any more: one uncut green was KART's worst flaw)

  // barrier posts: every BARRIER_EVERY segments at roadHalfW + BARRIER_OFF, each
  // socketed on a charcoal collar over a dirtDeep pad — the posts stand on the
  // dirt shoulder, so their contact band is the dirt ladder's Deep tier.
  for (let i = 0; i < frames.length; i += BARRIER_EVERY) {
    const f = frames[i]!;
    const hex = (i / BARRIER_EVERY) % 2 === 0 ? KPAL.barrierWhite : KPAL.barrierRed;
    for (const side of [1, -1]) {
      const px = f.cx + f.lx * (w + BARRIER_OFF) * side;
      const pz = f.cz + f.lz * (w + BARRIER_OFF) * side;
      statics.add(at(box(matFn, 0.42, PAD_H, 0.42, KPAL.dirtDeep), px, PAD_H / 2, pz));
      statics.add(at(cyl(matFn, 0.13, 0.15, 0.1, 8, KPAL.charcoal), px, 0.07, pz));
      statics.add(at(cyl(matFn, 0.09, 0.09, BARRIER_H, 8, hex), px, BARRIER_H / 2 + 0.11, pz));
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
        fl.add(at(box(matFn, 0.26, PAD_H, 0.26, KPAL.grassDeep), 0, PAD_H / 2, 0));
        fl.add(at(box(matFn, 0.07, 0.22, 0.07, KPAL.grassDark), 0, 0.13, 0));
        fl.add(at(box(matFn, 0.17, 0.12, 0.17, FLOWERS[rngInt(gsNext, 0, FLOWERS.length - 1)]!), 0, 0.29, 0));
        fl.position.set(x, 0, z);
        statics.add(fl);
      } else if (pick < 0.8) {
        // low bush: squashed leaf-tone blob over its own deep underside
        const bg = new THREE.Group();
        const br = rngRange(gsNext, 0.28, 0.55);
        const sx = rngRange(gsNext, 0.9, 1.3);
        const sz = rngRange(gsNext, 0.9, 1.3);
        const skirt = sphere(matFn, br * 1.06, 6, KPAL.treeLeafDeep);
        skirt.scale.set(sx, 0.34, sz);
        bg.add(at(skirt, 0, 0.08, 0));
        const bush = sphere(matFn, br, 6, leafTone(gsNext));
        bush.scale.set(sx, rngRange(gsNext, 0.5, 0.7), sz);
        bg.add(at(bush, 0, 0.21, 0));
        bg.rotation.y = gsNext() * Math.PI;
        bg.position.set(x, 0, z);
        statics.add(bg);
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

  // horizon: THREE ridgeline layers on a distance ladder — a dark green near
  // ridge, a ridgeNear->ridgeFar mid ridge, and a tall far ridge faded toward
  // the fog with mix() (the one sanctioned use: atmospheric perspective, §0.7).
  // Vertex-color gradients + fog do the depth; no cone hills.
  const ridgeNext = rng(decoSeed('kart-circuit', 15));
  const ridgeFar = new THREE.Mesh(
    ridgelineGeometry(RIDGE_FAR_R, RIDGE_FAR_PEAK, ridgeNext, KPAL.ridgeFar, mix(KPAL.ridgeFar, KPAL.fog, 0.55)),
    vertexPaintMaterial(),
  );
  root.add(ridgeFar);
  const ridgeMid = new THREE.Mesh(
    ridgelineGeometry(RIDGE_MID_R, RIDGE_MID_PEAK, ridgeNext, KPAL.ridgeNear, KPAL.ridgeFar),
    vertexPaintMaterial(),
  );
  root.add(ridgeMid);
  const ridgeNear = new THREE.Mesh(
    ridgelineGeometry(RIDGE_NEAR_R, RIDGE_NEAR_PEAK, ridgeNext, KPAL.grassDeep, KPAL.ridgeNear),
    vertexPaintMaterial(),
  );
  root.add(ridgeNear);

  root.add(bake(statics)); // one merged mesh per material, shadows on
  return root;
}

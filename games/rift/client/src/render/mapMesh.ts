// ============================================================================
// ANCIENTS (rift) — MAP MESHES (CONTRACT §6 render/mapMesh.ts + §7 world
// population). buildMap(lanes) — the SAME shared code the server runs — is
// compiled into baked statics, merged per material bucket:
//   - ground disc `moss`, with LARGE soft 2-tone mottling decal quads
//     (tight mix(moss, mossLit) steps, overlapping into drifting turf) raised
//     0.01 (never coplanar; COPLANAR_EPS 0.006);
//   - lane paving ribbons `stone`, raised 0.02, miter-joined so no two
//     triangles of the strip are coplanar either, flanked by darker curb
//     strips (a tone step) + dotted shoulder stones so lanes read as built;
//   - base platforms under each Ancient: stepped stone rings with radial
//     slab seams, a mottled walking ring, and a narrow team trim band
//     desaturated toward stone;
//   - deco clusters (ruins / foliage / rocks) from the seeded stream
//     rng(decoSeed('rift-' + lanes, 18)) — organic clusters OFF the lane
//     paths, ~70% hugging the lane shoulders and the rest denser toward the
//     map edges, ~1 per 150 m² of off-path area, 3-8 pieces each, all baked.
// ============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { APAL } from '@rift/shared';
import type { MapDef, StructureDef, Vec2 } from '@rift/shared';
import { ANCIENT, GUARD_TOWER, TOWER } from '@rift/shared';
import { decoSeed, mix, rng, rngInt, rngRange } from '@platform/shared';
import type { SceneHandle } from '../contract.js';
import { sceneCore } from './scene.js';

/** Lane paving half-width (m). */
const LANE_HALF_W = 1.7;
/** Lane strip lift above the ground — never coplanar (COPLANAR_EPS 0.006). */
const LANE_Y = 0.02;
/** Curb strip: width and lift (>= COPLANAR_EPS from the mottle height it can
 *  overlap; it never overlaps the paving strip, only abuts it). */
const CURB_W = 0.5;
const CURB_Y = 0.016;
const MOTTLE_Y = 0.01;
const PLATFORM_Y = 0.02;
const TRIM_Y = 0.04;
const PLATFORM_RADIUS = 7.6;
/** Stepped platform rings: upper step + central dais, each >= COPLANAR_EPS
 *  above the surface below; the seam/mottle insets sit between them. */
const PLATFORM_STEP_R = 6.1;
const PLATFORM_STEP_Y = 0.044;
const PLATFORM_DAIS_R = 3.4;
const PLATFORM_DAIS_Y = 0.062;
const PLATFORM_SEAM_Y = 0.052;
const PLATFORM_MOTTLE_Y = 0.056;
/** Deco must clear lane polylines by this much (lane shoulder + play space). */
const DECO_PATH_CLEAR = 5.5;
/** Deco must clear structure discs (expanded) by this much. */
const DECO_STRUCTURE_CLEAR = 3.5;
/** One deco cluster per this many m² of off-path area (CONTRACT §7). */
const CLUSTER_AREA_M2 = 150;

const STRUCTURE_RADIUS: Record<StructureDef['kind'], number> = {
  tower: TOWER.radius,
  guard: GUARD_TOWER.radius,
  ancient: ANCIENT.radius,
};

/** Exact min distance from (px,pz) to a waypoint polyline. */
function polylineDistance(path: readonly Vec2[], px: number, pz: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t =
      len2 > 0 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / len2)) : 0;
    const d = Math.hypot(px - (a.x + t * dx), pz - (a.z + t * dz));
    if (d < best) best = d;
  }
  return best;
}

function pathLength(path: readonly Vec2[]): number {
  let len = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (!a || !b) continue;
    len += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return len;
}

/** Arc-length sample of a waypoint polyline: point + unit tangent at t in [0,1]. */
function samplePath(
  path: readonly Vec2[],
  t: number,
): { x: number; z: number; tx: number; tz: number } | null {
  const total = pathLength(path);
  if (total <= 0) return null;
  let d = t * total;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len <= 0) continue;
    if (d <= len) {
      const u = d / len;
      return {
        x: a.x + (b.x - a.x) * u,
        z: a.z + (b.z - a.z) * u,
        tx: (b.x - a.x) / len,
        tz: (b.z - a.z) / len,
      };
    }
    d -= len;
  }
  const last = path[path.length - 1];
  return last ? { x: last.x, z: last.z, tx: 1, tz: 0 } : null;
}

/** Convert to a merge-compatible geometry: mergeGeometries refuses to mix
 *  indexed and non-indexed parts, so everything merges non-indexed. */
function nonIndexed(geom: THREE.BufferGeometry): THREE.BufferGeometry {
  return geom.index ? geom.toNonIndexed() : geom;
}

/** Miter-joined flat ribbon along a lane polyline, spanning the SIGNED lateral
 *  offsets [a, b] (negative = right of travel) at height `y`. Used for the
 *  paving strip itself and for the darker curb strips hugging both edges. */
function laneStrip(
  path: readonly Vec2[],
  a: number,
  b: number,
  y: number,
): THREE.BufferGeometry | null {
  const n = path.length;
  if (n < 2) return null;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const push = (x: number, z: number, u: number): void => {
    positions.push(x, y, z);
    normals.push(0, 1, 0);
    uvs.push(u, 0);
  };
  // Per-point miter normals; emit the strip as independent triangles (the
  // merge below is non-indexed anyway).
  const leftX: number[] = [];
  const leftZ: number[] = [];
  const rightX: number[] = [];
  const rightZ: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = path[i];
    if (!p) continue;
    const prev = path[Math.max(0, i - 1)];
    const next = path[Math.min(n - 1, i + 1)];
    if (!prev || !next) continue;
    let tx = next.x - prev.x;
    let tz = next.z - prev.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    // left of travel (kart handedness): (-tz, tx)
    let nx = -tz;
    let nz = tx;
    // miter compensation at joints so corners neither gap nor overlap
    let scale = 1;
    if (i > 0 && i + 1 < n) {
      const pin = path[i - 1];
      const pout = path[i + 1];
      if (pin && pout) {
        const s1x = p.x - pin.x;
        const s1z = p.z - pin.z;
        const l1 = Math.hypot(s1x, s1z) || 1;
        // normal of the incoming segment
        const n1x = -s1z / l1;
        const n1z = s1x / l1;
        const dot = Math.max(0.5, nx * n1x + nz * n1z);
        scale = 1 / dot;
      }
    }
    leftX.push(p.x + nx * b * scale);
    leftZ.push(p.z + nz * b * scale);
    rightX.push(p.x + nx * a * scale);
    rightZ.push(p.z + nz * a * scale);
  }
  const count = Math.min(leftX.length, rightX.length);
  for (let i = 0; i + 1 < count; i++) {
    const lx0 = leftX[i];
    const lz0 = leftZ[i];
    const rx0 = rightX[i];
    const rz0 = rightZ[i];
    const lx1 = leftX[i + 1];
    const lz1 = leftZ[i + 1];
    const rx1 = rightX[i + 1];
    const rz1 = rightZ[i + 1];
    if (
      lx0 === undefined || lz0 === undefined || rx0 === undefined || rz0 === undefined ||
      lx1 === undefined || lz1 === undefined || rx1 === undefined || rz1 === undefined
    ) {
      continue;
    }
    // two triangles: (l0, l1, r0) and (r0, l1, r1), wound CCW from +y so the
    // strip faces UP (FrontSide culling would hide a downward strip)
    push(lx0, lz0, 0);
    push(lx1, lz1, 0);
    push(rx0, rz0, 1);
    push(rx0, rz0, 1);
    push(lx1, lz1, 0);
    push(rx1, rz1, 1);
  }
  if (positions.length === 0) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return g;
}

/** Winding-safe flat quad decal (mottling) at height `y`. */
function mottleQuad(
  cx: number,
  cz: number,
  w: number,
  d: number,
  ry: number,
  y: number,
): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, d);
  g.rotateX(-Math.PI / 2);
  g.rotateY(ry);
  g.translate(cx, y, cz);
  return nonIndexed(g);
}

export function buildMapMeshes(scene: SceneHandle, map: MapDef): void {
  const core = sceneCore(scene);
  core.fitMap(map);
  const side = map.side;
  const cx = side / 2;
  const cz = side / 2;
  const next = rng(decoSeed('rift-' + String(map.lanes), 18));

  // ---- ground -----------------------------------------------------------------
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(side * 1.6, 48).rotateX(-Math.PI / 2).translate(cx, 0, cz),
    core.mat(APAL.moss),
  );
  ground.receiveShadow = true;
  core.three.add(ground);

  // ---- ground mottling decals: large soft overlapping patches, raised 0.01 ---
  // CONTRACT §7: subtle 2-tone mottling via mix(moss, mossLit, t). Patches are
  // LARGE (2.4-4.8m) and densely scattered so they overlap into drifting turf
  // tones; the t-range is tight (0.12 / 0.28) so no patch reads as a near-pale
  // scrap or an isolated high-contrast rectangle — even under the fog dim.
  {
    const buckets: THREE.BufferGeometry[][] = [[], []];
    const count = Math.floor((side * side) / 48);
    for (let i = 0; i < count; i++) {
      const x = rngRange(next, 2, side - 2);
      const z = rngRange(next, 2, side - 2);
      const w = rngRange(next, 2.4, 4.8);
      const d = rngRange(next, 2.4, 4.8);
      buckets[rngInt(next, 0, 1)]?.push(mottleQuad(x, z, w, d, next() * Math.PI, MOTTLE_Y));
    }
    const tints = [
      mix(APAL.moss, APAL.mossLit, 0.12),
      mix(APAL.moss, APAL.mossLit, 0.28),
    ];
    for (const [bi, parts] of buckets.entries()) {
      const merged = parts.length > 0 ? mergeGeometries(parts, false) : null;
      const tint = tints[bi];
      if (!merged || !tint) continue;
      const mesh = new THREE.Mesh(merged, core.mat(tint));
      mesh.receiveShadow = true;
      core.three.add(mesh);
    }
  }

  // ---- lane paving ribbons + curb tone-step ------------------------------------
  // The paving strip is flanked by two darker curb strips (a tone step, same
  // bake) so lanes read as BUILT roads, not paint on moss. Curbs sit beside
  // the paving (never overlapping it) at CURB_Y — clear of the mottle/lane
  // heights by >= COPLANAR_EPS.
  {
    const parts: THREE.BufferGeometry[] = [];
    const curbs: THREE.BufferGeometry[] = [];
    for (const path of map.paths) {
      const ribbon = laneStrip(path, -LANE_HALF_W, LANE_HALF_W, LANE_Y);
      if (ribbon) parts.push(ribbon);
      const curbL = laneStrip(path, LANE_HALF_W, LANE_HALF_W + CURB_W, CURB_Y);
      if (curbL) curbs.push(curbL);
      const curbR = laneStrip(path, -LANE_HALF_W - CURB_W, -LANE_HALF_W, CURB_Y);
      if (curbR) curbs.push(curbR);
    }
    const merged = parts.length > 0 ? mergeGeometries(parts, false) : null;
    if (merged) {
      const mesh = new THREE.Mesh(merged, core.mat(APAL.stone));
      mesh.receiveShadow = true;
      core.three.add(mesh);
    }
    const mergedCurbs = curbs.length > 0 ? mergeGeometries(curbs, false) : null;
    if (mergedCurbs) {
      const mesh = new THREE.Mesh(mergedCurbs, core.mat(mix(APAL.stone, APAL.stoneDeep, 0.55)));
      mesh.receiveShadow = true;
      core.three.add(mesh);
    }
  }

  // ---- base platforms: stepped rings, slab seams, mottled surface --------------
  // Three stepped discs (base -> step -> dais) with a dark seam ring between
  // the steps and radial slab seams on the upper step, soft stone mottling on
  // the walking ring, and a NARROW trim band desaturated well toward stone —
  // the pad reads as a built monument plinth, never a flat tan pancake.
  for (const s of map.structures) {
    if (s.kind !== 'ancient') continue;
    const teamHex = s.team === 0 ? APAL.azure : APAL.ember;
    const stepHex = mix(APAL.stone, APAL.stoneLit, 0.25);
    const daisHex = mix(APAL.stone, APAL.monument, 0.5);
    const mottleA = mix(APAL.stone, APAL.stoneLit, 0.14);
    const mottleB = mix(APAL.stone, APAL.stoneDeep, 0.25);
    const buckets = new Map<string, THREE.BufferGeometry[]>();
    const put = (hex: string, geom: THREE.BufferGeometry): void => {
      let list = buckets.get(hex);
      if (!list) {
        list = [];
        buckets.set(hex, list);
      }
      list.push(nonIndexed(geom));
    };
    const disc = (r: number, y: number): THREE.BufferGeometry =>
      new THREE.CircleGeometry(r, 28).rotateX(-Math.PI / 2).translate(s.x, y, s.z);
    const ring = (r0: number, r1: number, y: number): THREE.BufferGeometry =>
      new THREE.RingGeometry(r0, r1, 32).rotateX(-Math.PI / 2).translate(s.x, y, s.z);
    put(APAL.stone, disc(PLATFORM_RADIUS, PLATFORM_Y));
    put(APAL.stoneDeep, ring(PLATFORM_STEP_R, PLATFORM_STEP_R + 0.3, PLATFORM_SEAM_Y));
    put(stepHex, disc(PLATFORM_STEP_R, PLATFORM_STEP_Y));
    put(daisHex, disc(PLATFORM_DAIS_R, PLATFORM_DAIS_Y));
    // radial slab seams on the upper step (8 flat insets, never coplanar)
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.19;
      const r = (PLATFORM_DAIS_R + PLATFORM_STEP_R) / 2;
      put(
        APAL.stoneDeep,
        mottleQuad(s.x + Math.cos(a) * r, s.z + Math.sin(a) * r, 0.12, PLATFORM_STEP_R - PLATFORM_DAIS_R - 0.5, Math.PI / 2 - a, PLATFORM_SEAM_Y),
      );
    }
    // soft stone mottling on the walking ring between dais and step edge
    for (let i = 0; i < 9; i++) {
      const a = next() * Math.PI * 2;
      const r = PLATFORM_DAIS_R + 0.9 + next() * (PLATFORM_STEP_R - PLATFORM_DAIS_R - 2.2);
      const tint = next() < 0.5 ? mottleA : mottleB;
      put(
        tint,
        mottleQuad(
          s.x + Math.cos(a) * r,
          s.z + Math.sin(a) * r,
          rngRange(next, 1.0, 1.9),
          rngRange(next, 1.0, 1.9),
          next() * Math.PI,
          PLATFORM_MOTTLE_Y,
        ),
      );
    }
    // narrow team trim, desaturated toward stone so it frames the pad
    put(mix(teamHex, APAL.stone, 0.7), ring(PLATFORM_RADIUS - 0.3, PLATFORM_RADIUS, TRIM_Y));
    for (const [hex, parts] of buckets) {
      const merged = mergeGeometries(parts, false);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, core.mat(hex));
      mesh.receiveShadow = true;
      core.three.add(mesh);
    }
  }

  // ---- deco clusters (seeded; organic, off-path, edge-dense) ----------------------
  {
    // off-path area: total minus lane corridors minus the two base platforms
    let corridor = 0;
    for (const path of map.paths) corridor += pathLength(path) * DECO_PATH_CLEAR * 2;
    const offArea = Math.max(
      0,
      side * side - corridor - 2 * Math.PI * (PLATFORM_RADIUS + 3) ** 2,
    );
    const clusters = Math.max(8, Math.min(110, Math.round(offArea / CLUSTER_AREA_M2)));

    const buckets = new Map<string, THREE.BufferGeometry[]>();
    const pushPiece = (hex: string, geom: THREE.BufferGeometry): void => {
      let list = buckets.get(hex);
      if (!list) {
        list = [];
        buckets.set(hex, list);
      }
      list.push(geom);
    };

    const clearOfStatics = (x: number, z: number): boolean => {
      if (x < 4 || x > side - 4 || z < 4 || z > side - 4) return false;
      for (const path of map.paths) {
        if (polylineDistance(path, x, z) < DECO_PATH_CLEAR) return false;
      }
      for (const s of map.structures) {
        const need = STRUCTURE_RADIUS[s.kind] + DECO_STRUCTURE_CLEAR;
        if (Math.hypot(x - s.x, z - s.z) < need) return false;
      }
      return true;
    };

    for (let c = 0; c < clusters; c++) {
      // ~70% of clusters hug a lane shoulder (foliage/ruins framing the
      // roads) so mid-map never reads bare; the rest stay edge-dense
      const laneShoulder = map.paths.length > 0 && next() < 0.7;
      let ccx = 0;
      let ccz = 0;
      let placed = false;
      for (let attempt = 0; attempt < 12 && !placed; attempt++) {
        if (laneShoulder) {
          const path = map.paths[rngInt(next, 0, map.paths.length - 1)];
          const s = path ? samplePath(path, next()) : null;
          if (s) {
            const sgn = next() < 0.5 ? 1 : -1;
            const off = DECO_PATH_CLEAR + 0.4 + next() * 2.2;
            ccx = s.x + -s.tz * sgn * off;
            ccz = s.z + s.tx * sgn * off;
          }
        } else {
          // edge-dense: radius biased outward from the map centre
          const a = next() * Math.PI * 2;
          const r = (0.3 + 0.7 * Math.sqrt(next())) * (side / 2 - 6);
          ccx = cx + Math.cos(a) * r;
          ccz = cz + Math.sin(a) * r;
        }
        placed = clearOfStatics(ccx, ccz);
      }
      if (!placed) continue;
      const pieces = rngInt(next, 3, 8);
      for (let p = 0; p < pieces; p++) {
        const pa = next() * Math.PI * 2;
        const pr = 1.2 + next() * 2.2;
        const px = ccx + Math.cos(pa) * pr;
        const pz = ccz + Math.sin(pa) * pr;
        if (!clearOfStatics(px, pz)) continue;
        const kind = next();
        if (kind < 0.4) {
          // foliage: trunk + one or two leaf blobs
          const th = rngRange(next, 0.4, 0.85);
          const tr = rngRange(next, 0.07, 0.14);
          pushPiece(
            APAL.trunk,
            nonIndexed(new THREE.CylinderGeometry(tr, tr * 1.25, th, 6).translate(px, th / 2, pz)),
          );
          const lr = rngRange(next, 0.35, 0.75);
          const leafHex = next() < 0.6 ? APAL.leaf : APAL.leafDeep;
          pushPiece(
            leafHex,
            nonIndexed(new THREE.IcosahedronGeometry(lr, 0).translate(px, th + lr * 0.6, pz)),
          );
          if (next() < 0.45) {
            const lr2 = lr * rngRange(next, 0.5, 0.75);
            pushPiece(
              leafHex === APAL.leaf ? APAL.leafDeep : APAL.leaf,
              nonIndexed(
                new THREE.IcosahedronGeometry(lr2, 0).translate(
                  px + rngRange(next, -0.4, 0.4),
                  th + lr * 0.4,
                  pz + rngRange(next, -0.4, 0.4),
                ),
              ),
            );
          }
        } else if (kind < 0.7) {
          // rock
          const rr = rngRange(next, 0.25, 0.65);
          pushPiece(
            APAL.stoneDeep,
            nonIndexed(
              new THREE.DodecahedronGeometry(rr, 0)
                .rotateY(next() * Math.PI)
                .translate(px, rr * 0.55, pz),
            ),
          );
        } else {
          // ruins fragment: a worn slab, slightly sunken
          const w = rngRange(next, 0.5, 1.4);
          const h = rngRange(next, 0.25, 1.1);
          const d = rngRange(next, 0.35, 0.9);
          pushPiece(
            next() < 0.5 ? APAL.stone : APAL.monumentDeep,
            nonIndexed(
              new THREE.BoxGeometry(w, h, d)
                .rotateY(next() * Math.PI)
                .translate(px, h / 2 - 0.05, pz),
            ),
          );
        }
      }
    }

    // ---- shoulder stones: small slabs dotted along both lane edges ----------
    // Baked into the SAME material buckets as the deco clusters (zero extra
    // draw calls). They hug the curb line so lanes read as built roads; they
    // intentionally sit INSIDE DECO_PATH_CLEAR (on the shoulder, never on the
    // paving) and only check structure/bounds clearance.
    const clearOfStructures = (x: number, z: number): boolean => {
      if (x < 3 || x > side - 3 || z < 3 || z > side - 3) return false;
      for (const s of map.structures) {
        const need = STRUCTURE_RADIUS[s.kind] + 1.6;
        if (Math.hypot(x - s.x, z - s.z) < need) return false;
      }
      return true;
    };
    const shoulderStoneHexes = [APAL.stoneDeep, mix(APAL.stone, APAL.stoneDeep, 0.35)];
    for (const path of map.paths) {
      const len = pathLength(path);
      const steps = Math.floor(len / 2.6);
      for (let i = 0; i < steps; i++) {
        if (next() < 0.35) continue; // gaps keep it organic, not a railing
        const s = samplePath(path, (i + 0.5) / steps);
        if (!s) continue;
        const sgn = i % 2 === 0 ? 1 : -1;
        const off = LANE_HALF_W + CURB_W + 0.35 + next() * 0.7;
        const px = s.x + -s.tz * sgn * off;
        const pz = s.z + s.tx * sgn * off;
        if (!clearOfStructures(px, pz)) continue;
        const w = rngRange(next, 0.28, 0.6);
        const h = rngRange(next, 0.1, 0.24);
        const d = rngRange(next, 0.24, 0.55);
        pushPiece(
          shoulderStoneHexes[rngInt(next, 0, 1)] ?? APAL.stoneDeep,
          nonIndexed(
            new THREE.BoxGeometry(w, h, d)
              .rotateY(next() * Math.PI)
              .translate(px, h / 2 - 0.02, pz),
          ),
        );
      }
    }

    for (const [hex, parts] of buckets) {
      const merged = mergeGeometries(parts, false);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, core.mat(hex));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      core.three.add(mesh);
    }
  }
}

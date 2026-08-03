// ============================================================================
// ANCIENTS (rift) — MAP MESHES (CONTRACT §6 render/mapMesh.ts + §7 world
// population). buildMap(lanes) — the SAME shared code the server runs — is
// compiled into baked statics, merged per material bucket:
//   - ground disc `moss`, with 2-tone mottling decal quads in
//     mix(moss, mossLit, t) raised 0.01 (never coplanar; COPLANAR_EPS 0.006);
//   - lane paving ribbons `stone`, raised 0.02, miter-joined so no two
//     triangles of the strip are coplanar either;
//   - base platforms under each Ancient with a team-tinted trim ring;
//   - deco clusters (ruins / foliage / rocks) from the seeded stream
//     rng(decoSeed('rift-' + lanes, 18)) — organic clusters OFF the lane
//     paths, denser toward the map edges, ~1 per 150 m² of off-path area,
//     3-8 pieces each, all baked.
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
const MOTTLE_Y = 0.01;
const PLATFORM_Y = 0.02;
const TRIM_Y = 0.032;
const PLATFORM_RADIUS = 7.6;
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

/** Convert to a merge-compatible geometry: mergeGeometries refuses to mix
 *  indexed and non-indexed parts, so everything merges non-indexed. */
function nonIndexed(geom: THREE.BufferGeometry): THREE.BufferGeometry {
  return geom.index ? geom.toNonIndexed() : geom;
}

/** Miter-joined flat ribbon along a lane polyline at height LANE_Y. */
function laneRibbon(path: readonly Vec2[]): THREE.BufferGeometry | null {
  const n = path.length;
  if (n < 2) return null;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const push = (x: number, z: number, u: number): void => {
    positions.push(x, LANE_Y, z);
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
      const a = path[i - 1];
      const b = path[i + 1];
      if (a && b) {
        const s1x = p.x - a.x;
        const s1z = p.z - a.z;
        const l1 = Math.hypot(s1x, s1z) || 1;
        // normal of the incoming segment
        const n1x = -s1z / l1;
        const n1z = s1x / l1;
        const dot = Math.max(0.5, nx * n1x + nz * n1z);
        scale = 1 / dot;
      }
    }
    leftX.push(p.x + nx * LANE_HALF_W * scale);
    leftZ.push(p.z + nz * LANE_HALF_W * scale);
    rightX.push(p.x - nx * LANE_HALF_W * scale);
    rightZ.push(p.z - nz * LANE_HALF_W * scale);
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

  // ---- ground mottling decals: 2-tone mix(moss, mossLit, t), raised 0.01 ------
  {
    const buckets: [THREE.BufferGeometry[], THREE.BufferGeometry[]] = [[], []];
    const count = Math.floor((side * side) / 140);
    for (let i = 0; i < count; i++) {
      const x = rngRange(next, 2, side - 2);
      const z = rngRange(next, 2, side - 2);
      const w = rngRange(next, 1.6, 5.2);
      const d = rngRange(next, 1.6, 5.2);
      buckets[rngInt(next, 0, 1)]?.push(mottleQuad(x, z, w, d, next() * Math.PI, MOTTLE_Y));
    }
    const tints = [mix(APAL.moss, APAL.mossLit, 0.35), mix(APAL.moss, APAL.mossLit, 0.65)];
    for (const [bi, parts] of buckets.entries()) {
      const merged = parts.length > 0 ? mergeGeometries(parts, false) : null;
      const tint = tints[bi];
      if (!merged || !tint) continue;
      const mesh = new THREE.Mesh(merged, core.mat(tint));
      mesh.receiveShadow = true;
      core.three.add(mesh);
    }
  }

  // ---- lane paving ribbons ------------------------------------------------------
  {
    const parts: THREE.BufferGeometry[] = [];
    for (const path of map.paths) {
      const ribbon = laneRibbon(path);
      if (ribbon) parts.push(ribbon);
    }
    const merged = parts.length > 0 ? mergeGeometries(parts, false) : null;
    if (merged) {
      const mesh = new THREE.Mesh(merged, core.mat(APAL.stone));
      mesh.receiveShadow = true;
      core.three.add(mesh);
    }
  }

  // ---- base platforms with team trim ---------------------------------------------
  for (const s of map.structures) {
    if (s.kind !== 'ancient') continue;
    const platform = new THREE.Mesh(
      nonIndexed(new THREE.CircleGeometry(PLATFORM_RADIUS, 24).rotateX(-Math.PI / 2)),
      core.mat(APAL.stone),
    );
    platform.position.set(s.x, PLATFORM_Y, s.z);
    platform.receiveShadow = true;
    core.three.add(platform);
    const trim = new THREE.Mesh(
      nonIndexed(new THREE.RingGeometry(PLATFORM_RADIUS - 0.9, PLATFORM_RADIUS, 32).rotateX(-Math.PI / 2)),
      core.mat(s.team === 0 ? APAL.azure : APAL.ember),
    );
    trim.position.set(s.x, TRIM_Y, s.z);
    core.three.add(trim);
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
      // edge-dense: radius biased outward from the map centre
      let ccx = 0;
      let ccz = 0;
      let placed = false;
      for (let attempt = 0; attempt < 12 && !placed; attempt++) {
        const a = next() * Math.PI * 2;
        const r = (0.3 + 0.7 * Math.sqrt(next())) * (side / 2 - 6);
        ccx = cx + Math.cos(a) * r;
        ccz = cz + Math.sin(a) * r;
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

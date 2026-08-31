// ============================================================================
// REGRESSION GATE for the wall-base flicker fixed in 00a55a6.
//
// `articulate()` used to finish every trim band EXACTLY flush with the wall's
// own end faces / underside / top face. Two coplanar, same-facing quads have
// mathematically identical depth; `bake()` merges by material, so the pair
// landed in DIFFERENT meshes with different triangulations and the depth test
// picked a winner from the last bits of the interpolated depth — which changes
// with the camera. Hence flicker rather than a stable artifact.
//
// The fix carries every band `COPLANAR_EPS` (6 mm) PAST the wall's faces. This
// file makes that permanent, at two altitudes:
//
//  1. `articulate()` unit test — the fast authoring-time guard: for a set of
//     representative wall shapes, no band face may share a plane with a wall
//     face at all.
//  2. Whole-renderer scan — every `BoxDef` of every `MapDef`, rebuilt ALONE
//     through the real `buildMap()`, scanning the BAKED geometry for pairs of
//     axis-aligned quads that are coplanar, same-facing, overlapping and of
//     DIFFERENT colour. That is exactly the on-screen defect: opposite-facing
//     pairs are backface-culled, and same-colour pairs are invisible whichever
//     fragment wins.
//
// WHY ONE BOX AT A TIME. Two different `MapDef.boxes` legitimately overlap or
// end flush, and the constant trim heights mean two abutting walls of different
// materials share trim lines. Those cross-box pairs (377 of them) are NOT
// fixable without editing `MapDef.boxes` — which drives SERVER COLLISION
// (games/fps/server/src/game.ts). Isolating each box scopes this test to the
// defects the RENDERER itself introduces, which are the fixable ones.
// ============================================================================
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  CONTACT_MAT,
  DARK_MAT,
  MAP_LIST,
  MAT_COLORS,
  TRIM_MAT,
  type BoxDef,
  type MapDef,
} from '@fps/shared';

import { COPLANAR_EPS, articulate, type ArticulateColors } from '../contract/visual.js';
import { buildMap } from './mapRenderer.js';

// ---- tolerances --------------------------------------------------------------
/**
 * Coplanarity tolerance, metres. 1e-4 is:
 *  - 60x BELOW `COPLANAR_EPS` (0.006), so a band correctly carried 6 mm past a
 *    wall face passes, and a band that regresses to flush (delta 0) fails;
 *  - 60x below the SMALLEST real offset anywhere in the renderer's per-wall
 *    stack (SEAM_OUT = 0.018 in mapRenderer.ts), so no intentional offset is
 *    ever mistaken for coplanarity;
 *  - well ABOVE float32 noise: positions live in a `Float32Array`, whose ulp at
 *    the largest map coordinate (~100 m) is ~7.6e-6 m, and `bake()` puts every
 *    vertex through one more matrix multiply.
 */
const PLANE_EPS = 1e-4;

/** Two quads must overlap by more than this on BOTH in-plane axes. Anything
 *  less is edge-to-edge contact, which cannot z-fight (no shared fragments). */
const OVERLAP_EPS = 1e-3;

/** A triangle counts as axis-aligned when its extent along that axis is under
 *  this. Comfortably above float32 noise, far below any real geometry. */
const FLAT_EPS = 1e-5;

/**
 * Scan radius around the box being tested, metres. The renderer's whole
 * per-box stack (cap 0.02, skirt 0.024, plinth 0.04, cornice 0.06, bead 0.045,
 * soffit 0.055, pilaster 0.05, mid rail 0.07 proud; plinth 0.006 below) lives
 * within ~0.1 m of the BoxDef, so 0.75 m keeps every piece of it while
 * excluding map-wide geometry `buildMap()` also emits (the ground slab, floor
 * patchwork, cloud bands) — that geometry is not per-box and its quads span
 * the whole map, so it would be pure noise here.
 */
const SCAN_MARGIN = 0.75;

const AXIS_NAME = ['x', 'y', 'z'] as const;

// ---- quad recovery from baked geometry ---------------------------------------
interface Quad {
  axis: 0 | 1 | 2;
  /** Coordinate of the plane along `axis`. */
  plane: number;
  /** Facing: +1 or -1 along `axis`. */
  sign: number;
  /** Material colour, '#rrggbb'. */
  color: string;
  /** In-plane extents on the two other axes, in (axis+1)%3, (axis+2)%3 order. */
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

function boxBounds(b: BoxDef, margin: number): Bounds {
  return {
    min: [b.x - b.w / 2 - margin, b.y - b.h / 2 - margin, b.z - b.d / 2 - margin],
    max: [b.x + b.w / 2 + margin, b.y + b.h / 2 + margin, b.z + b.d / 2 + margin],
  };
}

function inside(bounds: Bounds, x: number, y: number, z: number): boolean {
  return (
    x >= bounds.min[0] && x <= bounds.max[0] &&
    y >= bounds.min[1] && y <= bounds.max[1] &&
    z >= bounds.min[2] && z <= bounds.max[2]
  );
}

/**
 * Walk every triangle of every baked mesh under `root`, keep the axis-aligned
 * ones fully inside `bounds`, and reduce them to unique quads. A box face is
 * two triangles whose in-plane bounding rects are both the full face, so
 * de-duplicating on (axis, plane, facing, colour, rect) recovers one quad per
 * face — which is what the depth test actually fights over.
 */
function collectQuads(root: THREE.Object3D, bounds: Bounds): Quad[] {
  const out = new Map<string, Quad>();
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const n = new THREE.Vector3();

  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const material = obj.material as THREE.MeshLambertMaterial;
    const color = `#${material.color.getHexString()}`;
    const geo = obj.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position');
    if (!pos) return;
    const index = geo.getIndex();
    const count = index ? index.count : pos.count;
    const m = obj.matrixWorld;

    for (let i = 0; i + 2 < count; i += 3) {
      let outOfBounds = false;
      for (let k = 0; k < 3; k++) {
        const vi = index ? index.getX(i + k) : i + k;
        v[k]!.fromBufferAttribute(pos, vi).applyMatrix4(m);
        if (!inside(bounds, v[k]!.x, v[k]!.y, v[k]!.z)) outOfBounds = true;
      }
      if (outOfBounds) continue;

      const a = v[0]!;
      const b = v[1]!;
      const c = v[2]!;
      const p: [number, number, number][] = [
        [a.x, a.y, a.z],
        [b.x, b.y, b.z],
        [c.x, c.y, c.z],
      ];

      let axis: 0 | 1 | 2 | -1 = -1;
      for (let ax = 0; ax < 3; ax++) {
        const q = ax as 0 | 1 | 2;
        if (
          Math.abs(p[0]![q] - p[1]![q]) <= FLAT_EPS &&
          Math.abs(p[0]![q] - p[2]![q]) <= FLAT_EPS
        ) {
          axis = q;
          break;
        }
      }
      if (axis === -1) continue;

      e1.subVectors(b, a);
      e2.subVectors(c, a);
      n.crossVectors(e1, e2);
      const nAxis = axis === 0 ? n.x : axis === 1 ? n.y : n.z;
      if (Math.abs(nAxis) < 1e-9) continue; // degenerate triangle
      const sign = nAxis > 0 ? 1 : -1;

      const ua = ((axis + 1) % 3) as 0 | 1 | 2;
      const va = ((axis + 2) % 3) as 0 | 1 | 2;
      const plane = (p[0]![axis] + p[1]![axis] + p[2]![axis]) / 3;
      const u0 = Math.min(p[0]![ua], p[1]![ua], p[2]![ua]);
      const u1 = Math.max(p[0]![ua], p[1]![ua], p[2]![ua]);
      const v0 = Math.min(p[0]![va], p[1]![va], p[2]![va]);
      const v1 = Math.max(p[0]![va], p[1]![va], p[2]![va]);

      const key = `${axis}|${sign}|${color}|${r(plane)}|${r(u0)}|${r(u1)}|${r(v0)}|${r(v1)}`;
      if (!out.has(key)) out.set(key, { axis, plane, sign, color, u0, u1, v0, v1 });
    }
  });
  return [...out.values()];
}

function r(x: number): string {
  return x.toFixed(6);
}

// ---- the defect: coplanar + same-facing + overlapping + different colour ------
interface Defect {
  axis: 0 | 1 | 2;
  plane: number;
  sign: number;
  colorA: string;
  colorB: string;
  /** Overlap rect on the two in-plane axes. */
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

function findDefects(quads: Quad[]): Defect[] {
  const defects: Defect[] = [];
  // Group by facing (axis + normal sign): only same-facing pairs can fight —
  // an opposite-facing pair is backface-culled and never both visible.
  const groups = new Map<string, Quad[]>();
  for (const q of quads) {
    const key = `${q.axis}|${q.sign}`;
    const arr = groups.get(key);
    if (arr) arr.push(q);
    else groups.set(key, [q]);
  }

  for (const group of groups.values()) {
    group.sort((a, b) => a.plane - b.plane);
    for (let i = 0; i < group.length; i++) {
      const a = group[i]!;
      for (let j = i + 1; j < group.length; j++) {
        const b = group[j]!;
        if (b.plane - a.plane > PLANE_EPS) break; // sorted: nothing further is coplanar
        if (a.color === b.color) continue; // invisible either way
        const u0 = Math.max(a.u0, b.u0);
        const u1 = Math.min(a.u1, b.u1);
        const v0 = Math.max(a.v0, b.v0);
        const v1 = Math.min(a.v1, b.v1);
        if (u1 - u0 <= OVERLAP_EPS || v1 - v0 <= OVERLAP_EPS) continue; // no shared fragments
        defects.push({
          axis: a.axis,
          plane: (a.plane + b.plane) / 2,
          sign: a.sign,
          colorA: a.color,
          colorB: b.color,
          u0,
          u1,
          v0,
          v1,
        });
      }
    }
  }
  return defects;
}

function describeDefect(mapId: string, boxIndex: number, b: BoxDef, d: Defect): string {
  const ua = AXIS_NAME[(d.axis + 1) % 3];
  const va = AXIS_NAME[(d.axis + 2) % 3];
  return (
    `${mapId} box[${boxIndex}] ${b.mat} ` +
    `(pos ${b.x},${b.y},${b.z} size ${b.w}x${b.h}x${b.d}): ` +
    `${d.colorA} vs ${d.colorB} both facing ${d.sign > 0 ? '+' : '-'}${AXIS_NAME[d.axis]} ` +
    `on ${AXIS_NAME[d.axis]}=${d.plane.toFixed(4)}, ` +
    `overlap ${ua} [${d.u0.toFixed(3)}, ${d.u1.toFixed(3)}] ` +
    `${va} [${d.v0.toFixed(3)}, ${d.v1.toFixed(3)}]`
  );
}

/** The real renderer path, fed a map containing exactly one box.
 *
 *  Everything the renderer does FOR THAT BOX (buildRichBox's cap/skirt/trim/
 *  seams, articulate()'s plinth/cornice/pilasters/mid rail, the bead and
 *  soffit) runs untouched. Map-wide dressing that has nothing to do with the
 *  box is dropped so 411 rebuilds stay fast: deco scatter, the accent overlays
 *  and the skyline ring are all authored per-map, not derived from this box. */
function buildBoxAlone(map: MapDef, b: BoxDef): THREE.Group {
  const single: MapDef = { ...map, boxes: [b], deco: [] };
  delete single.accents;
  delete single.skyline;
  return buildMap(single).root;
}

// ---- 1. the fast guard: articulate() itself -----------------------------------
describe('articulate() never builds a band coplanar with the wall', () => {
  const ladder = (mat: Parameters<typeof articulateColors>[0]) => articulateColors(mat);

  function articulateColors(matId: keyof typeof MAT_COLORS): ArticulateColors {
    const trim = TRIM_MAT[matId];
    const contact = CONTACT_MAT[matId];
    return {
      body: MAT_COLORS[matId]!,
      trim: trim ? MAT_COLORS[trim]! : null,
      dark: MAT_COLORS[DARK_MAT[matId]!]!,
      contact: contact ? MAT_COLORS[contact]! : null,
    };
  }

  const cases: Array<{ name: string; w: number; h: number; d: number; colors: ArticulateColors }> = [
    { name: 'long along X', w: 12, h: 3.2, d: 0.6, colors: ladder('concrete') },
    { name: 'long along Z', w: 0.6, h: 3.4, d: 14, colors: ladder('brick') },
    { name: 'near-square 9x12 building', w: 9, h: 4.5, d: 12, colors: ladder('plaster') },
    { name: 'tall wall with mid rail', w: 10, h: 6, d: 0.8, colors: ladder('sand') },
    { name: 'low cover', w: 4, h: 1.1, d: 1, colors: ladder('metal') },
    // Ends of the ladder: TRIM_MAT / CONTACT_MAT return null and the cornice /
    // plinth are skipped — the branch where the ribs must be cut SHORT instead
    // of buried, and the one that regressed most quietly.
    { name: 'top of ladder (no trim)', w: 8, h: 3, d: 0.7, colors: { ...ladder('concrete'), trim: null } },
    { name: 'bottom of ladder (no contact)', w: 8, h: 3, d: 0.7, colors: { ...ladder('concrete'), contact: null } },
    { name: 'no trim and no contact', w: 8, h: 5, d: 0.7, colors: { ...ladder('concrete'), trim: null, contact: null } },
  ];

  for (const c of cases) {
    it(`${c.name} (${c.w}x${c.h}x${c.d})`, () => {
      const g = articulate(c.w, c.h, c.d, c.colors);
      expect(g.children.length).toBeGreaterThan(0); // a wall with no trim proves nothing

      const wallPlanes: [number, number][] = [
        [-c.w / 2, c.w / 2],
        [-c.h / 2, c.h / 2],
        [-c.d / 2, c.d / 2],
      ];

      const offenders: string[] = [];
      g.children.forEach((child, i) => {
        const mesh = child as THREE.Mesh;
        mesh.updateMatrixWorld(true);
        const bb = mesh.geometry.boundingBox ?? (mesh.geometry.computeBoundingBox(), mesh.geometry.boundingBox!);
        const lo = bb.min.clone().applyMatrix4(mesh.matrixWorld);
        const hi = bb.max.clone().applyMatrix4(mesh.matrixWorld);
        const band: [number, number][] = [
          [lo.x, hi.x],
          [lo.y, hi.y],
          [lo.z, hi.z],
        ];
        for (let axis = 0; axis < 3; axis++) {
          for (const face of band[axis]!) {
            for (const wall of wallPlanes[axis]!) {
              if (Math.abs(face - wall) <= PLANE_EPS) {
                offenders.push(
                  `band[${i}] face ${AXIS_NAME[axis]}=${face.toFixed(5)} is coplanar with the ` +
                  `wall face ${AXIS_NAME[axis]}=${wall.toFixed(5)} (delta ${Math.abs(face - wall).toExponential(2)}, ` +
                  `must clear COPLANAR_EPS=${COPLANAR_EPS})`,
                );
              }
            }
          }
        }
      });
      expect(offenders).toEqual([]);
    });
  }

  it('returns nothing for a wall below MIN_ARTICULATE_H', () => {
    // Below 0.9 m the bands would meet in the middle; articulate() bails out,
    // so there is no band that could be flush with anything.
    expect(articulate(6, 0.6, 0.8, articulateColors('concrete')).children).toEqual([]);
  });
});

// ---- 2. the full gate: every BoxDef of every map, through the real renderer ----
describe('baked map geometry has no coplanar same-facing quad pairs', () => {
  for (const map of MAP_LIST) {
    it(`${map.id} (${map.boxes.length} boxes)`, () => {
      const lines: string[] = [];
      let total = 0;

      map.boxes.forEach((b, i) => {
        const root = buildBoxAlone(map, b);
        const quads = collectQuads(root, boxBounds(b, SCAN_MARGIN));
        const defects = findDefects(quads);
        total += defects.length;
        for (const d of defects) {
          if (lines.length < 10) lines.push(describeDefect(map.id, i, b, d));
        }
      });

      if (total > lines.length) lines.push(`... and ${total - lines.length} more (${total} total)`);
      expect(lines).toEqual([]);
    });
  }
});

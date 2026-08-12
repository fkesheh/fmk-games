// ============================================================================
// SKI SPLAT — TERRAIN RENDER TESTS (task W2, CONTRACT_V3 §12.5.5).
//
// Before this file NO splat test imported any `render/*` module, so "the suite
// passes unchanged" proved exactly nothing about the terrain. Everything here
// runs headless: buildTerrain only builds BufferGeometry and Object3D trees —
// no WebGL context, no renderer, no canvas.
//
// The gates, in the order §12.3f sequences the sub-waves:
//   W2a  the piste CENTRE is not darker than the piste EDGE (the inverted
//        forest-edge term was painting the tree shade down the middle of the
//        run), and W1's carve-track sampler actually reaches the vertices —
//        inside the groomed band and nowhere else.
//   W2b  the terrain root's draw-call count is unchanged by the build-order
//        inversion, and every prop footprint is stamped into the vertex
//        colours (contact AO) — which is only possible because prop placement
//        now runs BEFORE the piste mesh.
//   W2c  every occluder bounding box clears the piste, the cadence law holds,
//        and the instance total stays inside the 4000 budget (round-4).
// ============================================================================
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SLOPE_WIDTH } from '@splat/shared';
import { GROOM_BAND_HALF_M, genSlope } from '@splat/shared/slope.js';
import {
  buildAoSampler,
  buildContactSampler,
  buildOccluders,
  buildPisteMesh,
  buildTerrain,
  planOccluders,
} from './terrain.js';

const HALF_W = SLOPE_WIDTH / 2;

/** Rec.709 relative luminance of a vertex colour triple. */
function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** A throwaway vertex-colour material — the test never uploads it. */
function testMaterial(): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
}

interface Sampled {
  readonly x: Float32Array;
  readonly z: Float32Array;
  readonly luma: Float64Array;
}

function sample(mesh: THREE.Mesh): Sampled {
  const pos = mesh.geometry.getAttribute('position');
  const col = mesh.geometry.getAttribute('color');
  const n = pos.count;
  const x = new Float32Array(n);
  const z = new Float32Array(n);
  const l = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = pos.getX(i);
    z[i] = pos.getZ(i);
    l[i] = luma(col.getX(i), col.getY(i), col.getZ(i));
  }
  return { x, z, luma: l };
}

function meanLumaWhere(s: Sampled, pred: (x: number, z: number) => boolean): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < s.luma.length; i++) {
    const xi = s.x[i] ?? 0;
    const zi = s.z[i] ?? 0;
    if (!pred(xi, zi)) continue;
    sum += s.luma[i] ?? 0;
    n++;
  }
  expect(n).toBeGreaterThan(0);
  return sum / n;
}

/**
 * Draw calls a group costs per frame. A Mesh (and an InstancedMesh, whatever
 * its instance count) is one call, plus a SECOND one in the shadow pass if it
 * casts — the accounting terrain.ts:1104 already documents and §12.3e budgets.
 */
function drawCalls(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    n += 1 + (o.castShadow ? 1 : 0);
  });
  return n;
}

function instanceCount(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if (o instanceof THREE.InstancedMesh) n += o.count;
  });
  return n;
}

// ---------------------------------------------------------------------------
// W2a — vertex colour: the AO inversion fix + the carve-track call site
// ---------------------------------------------------------------------------
describe('W2a: two-radius vertex AO (§V3.8)', () => {
  it('the piste CENTRE is not darker than the piste EDGE — on 10 seeds', () => {
    // THE §12.3f W2a GATE. v2 computed `edgeGap = halfW - |x|` and shaded by
    // smooth01(edgeGap / FADE), which is 1.0 at x = 0 and 0.0 at |x| = halfW:
    // maximal AO down the middle of the run. Against HEAD this assertion fails.
    for (let seed = 0; seed < 10; seed++) {
      const slope = genSlope(seed);
      const ao = buildAoSampler(slope);
      // Sample a grid over the driveable piste, well clear of the start/finish.
      let worstCentre = -Infinity;
      let bestEdge = Infinity;
      for (let z = 40; z < slope.finishZ - 40; z += 17) {
        for (const x of [-2.5, -1.25, 0, 1.25, 2.5]) {
          const v = ao(x, z, slope.height(x, z));
          if (v > worstCentre) worstCentre = v;
        }
        for (const x of [-(HALF_W - 0.5), -(HALF_W - 2), HALF_W - 2, HALF_W - 0.5]) {
          const v = ao(x, z, slope.height(x, z));
          if (v < bestEdge) bestEdge = v;
        }
      }
      // Strict: the single darkest centre sample is still lighter than the
      // single lightest edge sample.
      expect(worstCentre).toBeLessThan(bestEdge);
    }
  });

  it('forest-edge shade ramps OUTWARD: monotone non-decreasing from centre to edge', () => {
    const slope = genSlope(42);
    const ao = buildAoSampler(slope);
    // With the curvature term floored out on open piste, the profile across the
    // corridor is driven by the (fixed) forest-edge term, so it must never dip
    // going outward beyond the noise of the undulation curvature.
    const z = 400;
    let prev = -Infinity;
    for (let x = 0; x <= HALF_W; x += 1) {
      const v = ao(x, z, slope.height(x, z));
      expect(v).toBeGreaterThanOrEqual(prev - 0.02);
      prev = Math.max(prev, v);
    }
    // and the edge is materially occluded while the centre is essentially open
    expect(ao(0, z, slope.height(0, z))).toBeLessThan(0.15);
    expect(ao(HALF_W - 0.25, z, slope.height(HALF_W - 0.25, z))).toBeGreaterThan(0.5);
  });

  it('AO is a clean 0..1 field everywhere on the rendered surface', () => {
    const slope = genSlope(7);
    const ao = buildAoSampler(slope);
    for (let z = -20; z < slope.finishZ + 120; z += 29) {
      for (let x = -(HALF_W + 28); x <= HALF_W + 28; x += 3.5) {
        const v = ao(x, z, slope.height(x, z));
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('the rendered piste is BRIGHTER at the centre than at the edge band', () => {
    // The gate again, but on the shipped vertex colours rather than the AO
    // field alone — corduroy, powder deepening and carve tracks included.
    const slope = genSlope(42);
    const mesh = buildPisteMesh(slope, testMaterial());
    const s = sample(mesh);
    const onRun = (z: number): boolean => z > 60 && z < slope.finishZ - 60;
    const centre = meanLumaWhere(s, (x, z) => Math.abs(x) < 4 && onRun(z));
    const edge = meanLumaWhere(
      s,
      (x, z) => Math.abs(x) > HALF_W - 5.5 && Math.abs(x) <= HALF_W && onRun(z),
    );
    expect(centre).toBeGreaterThan(edge);
  });

  it('nothing on the whole terrain sheet goes near black (snowDeep is the floor)', () => {
    // §12.5a.2: shadowed snow must read as blue snow-bounce, never black. The
    // deepest possible vertex is a full blend to SPAL.snowDeep (#93a5cc).
    const slope = genSlope(42);
    const mesh = buildPisteMesh(slope, testMaterial());
    const s = sample(mesh);
    let min = Infinity;
    for (const v of s.luma) if (v < min) min = v;
    expect(min).toBeGreaterThan(0.5);
  });
});

describe('W2a: W1 carve tracks reach the vertex colours (§12.3a call site)', () => {
  const slope = genSlope(42);
  const withTracks = sample(buildPisteMesh(slope, testMaterial()));
  const noTracks = sample(buildPisteMesh(slope, testMaterial(), { track: () => 0 }));

  it('the track sampler measurably changes the mesh', () => {
    let changed = 0;
    for (let i = 0; i < withTracks.luma.length; i++) {
      if (Math.abs((withTracks.luma[i] ?? 0) - (noTracks.luma[i] ?? 0)) > 1e-6) changed++;
    }
    // 6-10 S-curves 0.5-0.7 m wide on a 0.875 m lattice pitch: a modest but
    // unmistakable count. Zero means the call site was never wired.
    expect(changed).toBeGreaterThan(200);
  });

  it('every changed vertex lies inside the groomed band (§12.3b)', () => {
    for (let i = 0; i < withTracks.luma.length; i++) {
      if (Math.abs((withTracks.luma[i] ?? 0) - (noTracks.luma[i] ?? 0)) <= 1e-6) continue;
      expect(Math.abs(withTracks.x[i] ?? 0)).toBeLessThanOrEqual(GROOM_BAND_HALF_M);
    }
  });

  it('tracks cut BOTH ways — trenches darker, spoil edges brighter', () => {
    let darker = 0;
    let brighter = 0;
    for (let i = 0; i < withTracks.luma.length; i++) {
      const d = (withTracks.luma[i] ?? 0) - (noTracks.luma[i] ?? 0);
      if (d < -1e-6) darker++;
      else if (d > 1e-6) brighter++;
    }
    expect(darker).toBeGreaterThan(0);
    expect(brighter).toBeGreaterThan(0);
  });

  it('the groomed band uses the FROZEN GROOM_BAND_HALF_M, not a local literal', () => {
    // The corduroy lift lives inside |x| < GROOM_BAND_HALF_M and the powder
    // deepening outside it, so the band boundary is directly observable.
    expect(GROOM_BAND_HALF_M).toBeCloseTo(10.08, 6);
    const s = noTracks; // corduroy only — no carve tracks confusing the read
    const onRun = (z: number): boolean => z > 60 && z < slope.finishZ - 60;
    const inBand = meanLumaWhere(s, (x, z) => Math.abs(x) < GROOM_BAND_HALF_M * 0.8 && onRun(z));
    const outBand = meanLumaWhere(
      s,
      (x, z) => Math.abs(x) > GROOM_BAND_HALF_M * 1.2 && Math.abs(x) < 18 && onRun(z),
    );
    expect(inBand).toBeGreaterThan(outBand);
  });
});

// ---------------------------------------------------------------------------
// W2b — build-order inversion + contact AO
// ---------------------------------------------------------------------------
describe('W2b: build-order inversion (§12.3f)', () => {
  it('everything except the W2c occluders still costs exactly 22 draw calls', () => {
    // MEASURED ON HEAD, seed 42, by running HEAD's own terrain.ts through this
    // same counter: 22 calls / 2805 instances. The inversion has no visual
    // payload of its own and must not move either number; the only later delta
    // is W2c's single merged occluder mesh, subtracted out here.
    //   piste 1 (no cast) | forest 3 InstancedMesh x2 (cast) = 6 | banks 2
    //   rocks 4 | scallops 2 | boulders 4 | edge pines 1 | foothills 1 | peaks 1
    const root = buildTerrain(genSlope(42));
    let occluderCost = 0;
    root.traverse((o) => {
      if (o instanceof THREE.Mesh && !(o instanceof THREE.InstancedMesh) && o.castShadow) {
        occluderCost += 1 + (o.castShadow ? 1 : 0);
      }
    });
    expect(drawCalls(root) - occluderCost).toBe(22);
  });

  it('the dressing groups still cast nothing — only the walls and the occluders do', () => {
    const root = buildTerrain(genSlope(42));
    let instancedCasters = 0;
    let castingInstances = 0;
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || !o.castShadow) return;
      if (o instanceof THREE.InstancedMesh) {
        instancedCasters++;
        castingInstances += o.count;
      }
    });
    // exactly the three forest-wall InstancedMeshes; the edge pines, banks,
    // rocks, scallops and boulders are all uncast to hold the budget.
    expect(instancedCasters).toBe(3);
    expect(castingInstances).toBeGreaterThan(1000);
  });

  it('the piste mesh still receives shadows and never casts (22 m skirt walls)', () => {
    const root = buildTerrain(genSlope(42));
    const piste = root.children[0];
    expect(piste).toBeInstanceOf(THREE.Mesh);
    expect((piste as THREE.Mesh).receiveShadow).toBe(true);
    expect((piste as THREE.Mesh).castShadow).toBe(false);
  });

  it('prop footprints actually reach the terrain vertex colours', () => {
    // The point of the inversion. `buildTerrain` collects every footprint before
    // the piste mesh exists; a control mesh built with no stamps must differ.
    const slope = genSlope(42);
    const root = buildTerrain(slope);
    const stamped = sample(root.children[0] as THREE.Mesh);
    const control = sample(buildPisteMesh(slope, testMaterial()));
    let darker = 0;
    let lighter = 0;
    let minX = Infinity;
    for (let i = 0; i < stamped.luma.length; i++) {
      const d = (stamped.luma[i] ?? 0) - (control.luma[i] ?? 0);
      if (d < -1e-6) {
        darker++;
        minX = Math.min(minX, Math.abs(stamped.x[i] ?? 0));
      } else if (d > 1e-6) lighter++;
    }
    expect(darker).toBeGreaterThan(2000); // ~3k props, each stamping a disc
    expect(lighter).toBe(0); // contact AO only ever darkens
    // and it never reaches the racing line: every prop is off-piste
    // (DRESSING_X_MIN 24.5) and the stamp radius is capped at one grid cell.
    expect(minX).toBeGreaterThan(15);
  });

  it('contact stamps are radial, peak at the prop and die at their radius', () => {
    const at2 = buildContactSampler([{ x: 10, z: 200, r: 2 }], -60, 60, -40, 900);
    expect(at2(10, 200)).toBeCloseTo(1, 6);
    expect(at2(10 + 3.2, 200)).toBeCloseTo(0, 6); // 2 * 1.6 = 3.2 m reach
    expect(at2(10, 200 + 3.2)).toBeCloseTo(0, 6);
    expect(at2(11.6, 200)).toBeGreaterThan(0.2);
    expect(at2(11.6, 200)).toBeLessThan(0.8);
    expect(at2(40, 200)).toBe(0);
  });

  it('the contact grid finds stamps binned in a diagonal neighbour cell', () => {
    // The 3x3 scan is only exact while the stamp radius stays inside one cell —
    // this pins the invariant that made the grid legal in the first place.
    // Cell boundaries fall on x = -60 + 8k and z = -40 + 8k, so the stamp lands
    // in (col 7, row 4) and the query point in (col 8, row 5) — a pure diagonal.
    const at2 = buildContactSampler([{ x: -0.1, z: -0.1, r: 100 }], -60, 60, -40, 900);
    expect(at2(4.1, 4.1)).toBeGreaterThan(0);
    // ...and the radius is hard-clamped to one cell, which is what makes the
    // 3x3 scan exact: 11 m away is outside the stamp even though r was 100.
    expect(at2(7.9, 7.9)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// W2c — near-field occluders, flanking ridges, FOREST_MAX
// ---------------------------------------------------------------------------
describe('W2c: near-field occluders (§V3.1)', () => {
  it('THE PLACEMENT LAW: every planned BOUNDING BOX clears |x| >= 30, on 20 seeds', () => {
    // §12.3f gates this at 28.5; §V3.1 pushes it to 30 because the camera has
    // no collision. The bound is on the box, not the centre — an 8 m mass
    // centred at 27 spans 23..31 and puts 5 m of rock inside the piste.
    for (let seed = 0; seed < 20; seed++) {
      const plan = planOccluders(genSlope(seed));
      expect(plan.length).toBeGreaterThan(0);
      for (const p of plan) {
        expect(Math.abs(p.x) - p.halfWidth).toBeGreaterThanOrEqual(30);
        expect(Math.abs(p.x) + p.halfWidth).toBeLessThanOrEqual(HALF_W + 28); // on the terrain
      }
    }
  });

  it('...and so does every VERTEX of the built rock/cornice geometry, 20 seeds', () => {
    // The declared half-width is only worth anything if the geometry respects
    // it. This reads the merged mesh's real positions, rotations included.
    for (let seed = 0; seed < 20; seed++) {
      const slope = genSlope(seed);
      const built = buildOccluders(slope, planOccluders(slope), testMaterial(), []);
      const mesh = built.mesh;
      expect(mesh).not.toBeNull();
      const pos = (mesh as THREE.Mesh).geometry.getAttribute('position');
      let minAbsX = Infinity;
      for (let i = 0; i < pos.count; i++) minAbsX = Math.min(minAbsX, Math.abs(pos.getX(i)));
      expect(minAbsX).toBeGreaterThanOrEqual(28.5); // the §12.3f gate
      expect(minAbsX).toBeGreaterThanOrEqual(30); // ...and the §V3.1 bound
    }
  });

  it('the pine clusters are full-height (6-9 m) and clear the law with their canopy', () => {
    for (let seed = 0; seed < 20; seed++) {
      const slope = genSlope(seed);
      const built = buildOccluders(slope, planOccluders(slope), testMaterial(), []);
      expect(built.pines.length).toBeGreaterThan(0);
      for (const t of built.pines) {
        const height = t.scale * 5.45; // fir prototype height
        expect(height).toBeGreaterThanOrEqual(6 - 1e-9);
        expect(height).toBeLessThanOrEqual(9 + 1e-9);
        // the lowest bough ring, not just the trunk, stays off the piste
        expect(Math.abs(t.x) - 1.55 * t.scale).toBeGreaterThanOrEqual(30 - 1e-9);
      }
    }
  });

  it('cadence: 2-4 masses per 100 m window, alternating sides without a rhythm', () => {
    for (let seed = 0; seed < 10; seed++) {
      const slope = genSlope(seed);
      const plan = planOccluders(slope);
      const perWindow = new Map<number, number>();
      for (const p of plan) {
        const w = Math.floor((p.z + 10) / 100);
        perWindow.set(w, (perWindow.get(w) ?? 0) + 1);
      }
      for (const n of perWindow.values()) {
        expect(n).toBeGreaterThanOrEqual(2);
        expect(n).toBeLessThanOrEqual(4);
      }
      // both sides get used, and the sequence is not a strict L-R-L-R beat
      const sides = plan.map((p) => Math.sign(p.x));
      expect(sides.some((s) => s < 0)).toBe(true);
      expect(sides.some((s) => s > 0)).toBe(true);
      let strictAlternations = 0;
      for (let i = 1; i < sides.length; i++) {
        if (sides[i] !== sides[i - 1]) strictAlternations++;
      }
      expect(strictAlternations).toBeLessThan(sides.length - 1);
    }
  });

  it('all three archetypes ship, at 2.5-6 m (rock/cornice) and 6-9 m (pines)', () => {
    const kinds = new Set<string>();
    for (let seed = 0; seed < 10; seed++) {
      for (const p of planOccluders(genSlope(seed))) {
        kinds.add(p.kind);
        if (p.kind === 'pines') {
          expect(p.height).toBeGreaterThanOrEqual(6);
          expect(p.height).toBeLessThanOrEqual(9);
        } else {
          expect(p.height).toBeGreaterThanOrEqual(2.5);
          expect(p.height).toBeLessThanOrEqual(6);
        }
        expect(p.halfWidth * 2).toBeGreaterThanOrEqual(3);
      }
    }
    expect([...kinds].sort()).toEqual(['buttress', 'cornice', 'pines']);
  });

  it('occluders are seeded and deterministic — never Math.random', () => {
    const a = planOccluders(genSlope(11));
    const b = planOccluders(genSlope(11));
    expect(a).toEqual(b);
    expect(planOccluders(genSlope(12))).not.toEqual(a);
  });
});

describe('W2c: budgets (§12.3e)', () => {
  it('draw calls: 24 — a +2 delta on the 22 measured on HEAD, inside the +3 allowance', () => {
    // The delta is ONE merged occluder mesh that CASTS (world pass + shadow
    // pass). Merging the four SPAL tones into one vertex-coloured geometry is
    // what makes casting affordable: unmerged it would have been 8 calls.
    const root = buildTerrain(genSlope(42));
    expect(drawCalls(root)).toBe(24);
  });

  it('the occluder masses CAST — that is what the allowance bought', () => {
    const root = buildTerrain(genSlope(42));
    let plainCasters = 0;
    root.traverse((o) => {
      if (o instanceof THREE.Mesh && !(o instanceof THREE.InstancedMesh) && o.castShadow) {
        plainCasters++;
      }
    });
    expect(plainCasters).toBe(1); // exactly the merged occluder mesh
  });

  it('instances: <= 4000 with room for W3, and FOREST_MAX is back at 2800', () => {
    // Round 4 reverted the 2800 -> 1900 cut and raised the ceiling 3000 -> 4000
    // (CONTRACT_V3 "RESOLVED (post-build, orchestrator decision)"). The forest
    // is 3 InstancedMeshes at either figure, so the cut freed zero draw calls
    // while deleting ~900 full-height pines from the corridor rails.
    for (const seed of [0, 42, 99]) {
      const root = buildTerrain(genSlope(seed));
      const n = instanceCount(root);
      expect(n).toBeLessThanOrEqual(2810); // 2800 forest + <=5 edge pines
      expect(n).toBeLessThanOrEqual(4000 - 900 - 214); // room for W3 + plants
    }
  });

  it('the forest budget lines BOTH rails for the WHOLE run (the v2 cap did not)', () => {
    // HEAD, seed 42, cap 2800: LEFT 2801 / RIGHT 4, and zero trees below
    // z ~= 700 — the cap truncated the scatter instead of thinning it, because
    // side -1 ran to completion before side +1 ever started. Cutting to 1900 on
    // top of that would have stripped the forest from the bottom 40% of the run.
    const root = buildTerrain(genSlope(42));
    const m = new THREE.Matrix4();
    const v = new THREE.Vector3();
    let left = 0;
    let right = 0;
    const binsL = new Array<number>(8).fill(0);
    const binsR = new Array<number>(8).fill(0);
    root.traverse((o) => {
      if (!(o instanceof THREE.InstancedMesh)) return;
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m);
        v.setFromMatrixPosition(m);
        const b = Math.max(0, Math.min(7, Math.floor(v.z / 100)));
        if (v.x < 0) {
          left++;
          binsL[b] = (binsL[b] ?? 0) + 1;
        } else {
          right++;
          binsR[b] = (binsR[b] ?? 0) + 1;
        }
      }
    });
    // neither wall may be a token presence
    expect(left).toBeGreaterThan(600);
    expect(right).toBeGreaterThan(600);
    // and every 100 m of the run has trees on BOTH sides
    for (let b = 0; b < 8; b++) {
      expect(binsL[b] ?? 0).toBeGreaterThan(10);
      expect(binsR[b] ?? 0).toBeGreaterThan(10);
    }
  });
});

describe('W2c: flanking ridges (§V3.2)', () => {
  const slope = genSlope(42);

  it('the driveable piste is untouched — ridges live in the OUTER skirt only', () => {
    // The rendered field is slope.height + skirtLift, and skirtLift is 0 inside
    // the piste edge. Raising the flanks must not move a single metre of the
    // surface the sim owns.
    const root = buildTerrain(slope);
    const pos = (root.children[0] as THREE.Mesh).geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      if (Math.abs(x) > HALF_W) continue;
      expect(pos.getY(i)).toBeCloseTo(slope.height(x, pos.getZ(i)), 3);
    }
  });

  it('the skirt crest now varies along z — a broken horizon, not a straight line', () => {
    const root = buildTerrain(slope);
    const pos = (root.children[0] as THREE.Mesh).geometry.getAttribute('position');
    // the outermost lattice column on each side IS the skyline
    const crest: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getX(i)) < HALF_W + 27) continue;
      // relative to the fall line, so the -GRADE_BASE*z ramp does not dominate
      crest.push(pos.getY(i) - slope.height(0, pos.getZ(i)));
    }
    expect(crest.length).toBeGreaterThan(100);
    const lo = Math.min(...crest);
    const hi = Math.max(...crest);
    // v2's skirt was a constant 22 m lift: a dead-flat horizon. The ridges must
    // swing it by several metres.
    expect(hi - lo).toBeGreaterThan(6);
  });

  it('a ridge saddle never digs below the piste plane', () => {
    // RIDGE_DOWN is deliberately shallower than RIDGE_UP: a saddle that dropped
    // under the piste would read as a hole beside the run, not a shoulder.
    for (const seed of [0, 3, 42, 99]) {
      const sl = genSlope(seed);
      const root = buildTerrain(sl);
      const pos = (root.children[0] as THREE.Mesh).geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        if (Math.abs(x) <= HALF_W) continue;
        const z = pos.getZ(i);
        expect(pos.getY(i)).toBeGreaterThanOrEqual(sl.height(x, z) - 1e-6);
      }
    }
  });

  it('ridges are seeded per mountain and per side — the flanks are not mirrors', () => {
    const sa = genSlope(1);
    const pa = (buildTerrain(sa).children[0] as THREE.Mesh).geometry.getAttribute('position');
    const pb = (buildTerrain(genSlope(2)).children[0] as THREE.Mesh).geometry.getAttribute(
      'position',
    );
    let differsBySeed = 0;
    for (let i = 0; i < pa.count; i++) {
      if (Math.abs(pa.getY(i) - pb.getY(i)) > 1e-6) differsBySeed++;
    }
    expect(differsBySeed).toBeGreaterThan(1000);

    // The lattice is symmetric about x = 0 (129 columns over -56..56), so column
    // i and column nx-1-i are the same |x| on opposite flanks. The skirt lift is
    // y - slope.height(x, z); the two sides draw independent phases, so those
    // lifts must disagree across most of the run.
    const nx = 129;
    const rows = pa.count / nx;
    expect(Number.isInteger(rows)).toBe(true);
    let asymmetric = 0;
    let compared = 0;
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < 8; i++) {
        const l = r * nx + i;
        const rgt = r * nx + (nx - 1 - i);
        const xl = pa.getX(l);
        const zl = pa.getZ(l);
        const xr = pa.getX(rgt);
        expect(Math.abs(xl)).toBeCloseTo(Math.abs(xr), 4);
        const liftL = pa.getY(l) - sa.height(xl, zl);
        const liftR = pa.getY(rgt) - sa.height(xr, pa.getZ(rgt));
        compared++;
        if (Math.abs(liftL - liftR) > 0.25) asymmetric++;
      }
    }
    expect(compared).toBeGreaterThan(500);
    expect(asymmetric / compared).toBeGreaterThan(0.6);
  });
});

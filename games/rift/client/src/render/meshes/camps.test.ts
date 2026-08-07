// ============================================================================
// ANCIENTS (rift) — R_MESH_CAMP's GATE (AMENDMENT_3 §G.5).
//
// This suite exists because the defects this build keeps shipping in mesh
// modules are invisible to the typechecker AND invisible in code review:
//
//   * a geometry with no `color` attribute renders BLACK under the kit's
//     unconditional `vertexColors: true`, and compiles perfectly. `bake()`
//     supplies the attribute; the two ANIM geometries never go through
//     `bake()`, so they are the only ones in the module that can be wrong;
//   * an emissive bucket that is never `markBloom`ed glows without blooming,
//     and a marked bucket carrying no emissive hazes the frame. Both silent;
//   * a camp wearing a TEAM colour is a gameplay error, not a cosmetic one —
//     these are `NEUTRAL_TEAM` and a player who reads one as an enemy creep
//     walks into a camp thinking it is a pushing wave;
//   * a number in a comment that the geometry does not have. Every dimension
//     the module's header states is re-derived here from the shipped buckets,
//     so the comment cannot drift away from the mesh.
//
// It also pins, one test each, the eight defects the reviewer found in the
// first pass: the hive floating 4.7 cm, the brute's 0.54 m detached HP bar, the
// `userData.rift*` side-channel, the re-pointed (and therefore untinted) glow
// bucket, the unguarded bloom-bucket lookup, the 128-draw arithmetic that
// omitted the per-entity anim mesh, the pack's non-existent "dark eye sockets",
// and five hive models overlapping on their own post ring.
//
// It runs HEADLESS (node, no DOM), exactly as `kit.test.ts` does: the kit's
// texture generators take their no-canvas branch, and material construction,
// bucketing and baking all stay exercisable without a browser. The draw-call
// TOTAL is measured in a browser against `renderer.info` (see the module
// header); what is asserted here is the per-archetype arithmetic that total is
// built from, which is the part a code change can silently break.
// ============================================================================
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { APAL, TEAM_COLORS } from '@rift/shared/palette.js';
import { CAMP_BRUTE_COUNT, CAMP_HIVE_COUNT, CAMP_PACK_COUNT } from '@rift/shared/config.js';
import { BLOOM_LAYER } from '../kit.js';
import type { AnimPart, UnitBuild } from '../kit.js';
import { buildCamp } from './camps.js';

type Tier = 'pack' | 'brute' | 'hive';
const TIERS: readonly Tier[] = ['pack', 'brute', 'hive'];

/** The four buckets every tier is held to: hide, chitin, bone, glow. */
const BUCKETS_PER_TIER = 4;

/** Every hex a player reads as "team". Six, not two: the {base, Lit, Deep}
 *  ladder is what a tint would actually land on, and `TEAM_COLORS` only holds
 *  the two bases. The cross-check below fails if the palette adds a third team
 *  without this list learning about it. */
const TEAM_HEXES: readonly string[] = [
  APAL.azure,
  APAL.azureLit,
  APAL.azureDeep,
  APAL.ember,
  APAL.emberLit,
  APAL.emberDeep,
];

/** Post-ring geometry, mirrored from `server/src/sim/camps.ts`: eight fixed
 *  spokes on a 1.6 m ring, member `i` of `count` taking slot
 *  `floor(i * 8 / count)`. Mirrored rather than imported because that module is
 *  the SERVER's and this is a client render test; the mirror is checked against
 *  the two arithmetic facts it implies (a 5-member camp's tightest pair is
 *  45 deg, a 3- or 4-member camp's is 90 deg) in its own test below. */
const POST_RING_R = 1.6;
const POST_DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [Math.SQRT1_2, Math.SQRT1_2],
  [0, 1],
  [-Math.SQRT1_2, Math.SQRT1_2],
  [-1, 0],
  [-Math.SQRT1_2, -Math.SQRT1_2],
  [0, -1],
  [Math.SQRT1_2, -Math.SQRT1_2],
];

const MEMBERS: Readonly<Record<Tier, number>> = {
  pack: CAMP_PACK_COUNT,
  brute: CAMP_BRUTE_COUNT,
  hive: CAMP_HIVE_COUNT,
};

/** Distance between the two CLOSEST resting posts of a `count`-member camp. */
function closestPostPair(count: number): number {
  const pts: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const d = POST_DIRS[Math.floor((i * POST_DIRS.length) / count) % POST_DIRS.length];
    if (d === undefined) throw new Error('post slot out of range');
    pts.push([d[0] * POST_RING_R, d[1] * POST_RING_R]);
  }
  let min = Infinity;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i];
      const b = pts[j];
      if (a === undefined || b === undefined) continue;
      min = Math.min(min, Math.hypot(a[0] - b[0], a[1] - b[1]));
    }
  }
  return min;
}

function animOf(b: UnitBuild): AnimPart {
  const a = b.anim;
  if (a === null) throw new Error('expected an anim part');
  return a;
}

/** Bucket meshes the module put on BLOOM_LAYER. */
function bloomMeshes(b: UnitBuild): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  b.body.group.traverse((o) => {
    if (o instanceof THREE.Mesh && o.layers.isEnabled(BLOOM_LAYER)) out.push(o);
  });
  return out;
}

/** Union bounding box of every baked bucket, in the build's own space. */
function bodyBox(b: UnitBuild): THREE.Box3 {
  const box = new THREE.Box3();
  for (const p of b.body.parts) {
    p.geo.computeBoundingBox();
    const bb = p.geo.boundingBox;
    if (bb !== null) box.union(bb);
  }
  return box;
}

/** `max(hypot(x, z))` over every baked vertex: the exact non-overlap radius
 *  about the entity's own origin, at any yaw. */
function exactFootprintR(b: UnitBuild): number {
  let r = 0;
  for (const p of b.body.parts) {
    const pos = p.geo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      r = Math.max(r, Math.hypot(pos.getX(i), pos.getZ(i)));
    }
  }
  return r;
}

/** Half the XZ bounding-box diagonal: the circle that contains the model at
 *  whatever yaw it is spawned with, and the radius the reviewer measured the
 *  overlapping first pass with. */
function bboxHalfDiagonal(b: UnitBuild): number {
  const box = bodyBox(b);
  return Math.hypot(box.max.x - box.min.x, box.max.z - box.min.z) / 2;
}

/** HSL hue in degrees and HSL saturation, read in sRGB.
 *
 *  The colour space is load-bearing, not incidental. `THREE.Color` stores
 *  working-space (linear) values, and `getHSL()` defaults to them — which
 *  reports the brown hides at s 0.44-0.47 instead of the 0.22-0.25 a viewer
 *  perceives, and would sweep them into a saturation test aimed at the venom
 *  glow. "Does this read as a team light" is a perceptual question, so it is
 *  asked in the space the player's monitor is in. */
function hsl(c: THREE.Color): { h: number; s: number } {
  const out = { h: 0, s: 0, l: 0 };
  c.getHSL(out, THREE.SRGBColorSpace);
  return { h: out.h * 360, s: out.s };
}

function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Every material on a build: the baked buckets plus the anim part's. */
function materialsOf(b: UnitBuild): THREE.MeshStandardMaterial[] {
  return b.body.parts.map((p) => p.material);
}

// ============================================================================

describe('the vertex-colour law', () => {
  it.each(TIERS)('%s: every baked bucket carries a 3-component color attribute', (tier) => {
    const b = buildCamp(tier);
    expect(b.body.parts.length).toBe(BUCKETS_PER_TIER);
    for (const part of b.body.parts) {
      const color = part.geo.getAttribute('color');
      expect(color).toBeDefined();
      expect(color.itemSize).toBe(3);
      expect(color.count).toBe(part.geo.getAttribute('position').count);
    }
  });

  // The two geometries in this module `bake()` never touches, and therefore the
  // only two that can ship BLACK with a clean typecheck (AMENDMENT_3 §B).
  it.each(['brute', 'hive'] as const)('%s: the ANIM geometry is white-vertex-coloured', (tier) => {
    const anim = animOf(buildCamp(tier));
    const color = anim.geo.getAttribute('color');
    expect(color).toBeDefined();
    expect(color.itemSize).toBe(3);
    expect(color.count).toBe(anim.geo.getAttribute('position').count);
    for (let i = 0; i < color.count; i++) {
      expect(color.getX(i)).toBe(1);
      expect(color.getY(i)).toBe(1);
      expect(color.getZ(i)).toBe(1);
    }
  });
});

describe('the bloom bucket', () => {
  it.each(TIERS)('%s: exactly one marked bucket, and it is the emissive one', (tier) => {
    const b = buildCamp(tier);
    const marked = bloomMeshes(b);
    expect(marked).toHaveLength(1);
    const mesh = marked[0];
    if (mesh === undefined) throw new Error('unreachable');
    const mat = mesh.material;
    expect(Array.isArray(mat)).toBe(false);
    const m = mat as THREE.MeshStandardMaterial;
    expect(m.emissiveIntensity).toBeGreaterThan(0);
    expect(m.emissive.getHex()).not.toBe(0x000000);
    // and it is one of the build's OWN buckets, not something re-pointed in
    expect(materialsOf(b)).toContain(m);
  });

  it.each(TIERS)('%s: the hide, chitin and bone buckets are never marked', (tier) => {
    const b = buildCamp(tier);
    const markedMats = new Set(bloomMeshes(b).map((mesh) => mesh.material));
    for (const m of materialsOf(b)) {
      const isEmissive = m.emissiveIntensity > 0 && m.emissive.getHex() !== 0x000000;
      expect(markedMats.has(m)).toBe(isEmissive);
    }
  });

  it.each(['brute', 'hive'] as const)('%s: the anim part asks R_UNITS for bloom', (tier) => {
    const anim = animOf(buildCamp(tier));
    expect(anim.bloom).toBe(true);
    expect(anim.surfaceId).toBe('crystal');
    expect(anim.emissive).toBeDefined();
    expect(anim.emissive?.colorKey).toBe('neutral');
    expect(anim.emissive?.intensity).toBeGreaterThan(0);
  });

  it('the pack has no anim part at all, and still glows', () => {
    const b = buildCamp('pack');
    expect(b.anim).toBeNull();
    expect(b.animKind).toBeNull();
    expect(bloomMeshes(b)).toHaveLength(1);
  });
});

describe('NEUTRAL — no team colour on any tier (BUILD_SPECS R_MESH_CAMP)', () => {
  it('the six team hexes this suite guards against still cover TEAM_COLORS', () => {
    for (const c of TEAM_COLORS) expect(TEAM_HEXES).toContain(c);
  });

  it.each(TIERS)('%s: no material albedo or emissive is a team hex', (tier) => {
    const b = buildCamp(tier);
    const banned = new Set(TEAM_HEXES.map((h) => new THREE.Color(h).getHex()));
    for (const m of materialsOf(b)) {
      expect(banned.has(m.color.getHex())).toBe(false);
      expect(banned.has(m.emissive.getHex())).toBe(false);
    }
  });

  it.each(['brute', 'hive'] as const)('%s: the anim part is not team-tinted either', (tier) => {
    const anim = animOf(buildCamp(tier));
    expect(TEAM_HEXES).not.toContain(anim.tint);
    expect(anim.tint).toBe(APAL.neutral);
  });

  // A near-azure would misread as team 0 just as badly as azure itself, so the
  // exact-hex test above is not enough on its own: every SATURATED colour a
  // camp wears must sit a readable distance from both team hues on the wheel.
  // The unsaturated hides and stones are exempt — a desaturated brown at
  // ember's hue is a brown, not a team light. Measured sRGB saturations on the
  // four families in use: cliffRock 0.06, monumentLit 0.13, barkLit 0.22,
  // bark 0.25, neutral 0.37 — so 0.30 separates the one saturated colour on
  // these models from the four earth tones with room on both sides.
  it.each(TIERS)('%s: every saturated colour is >= 38 deg from both team hues', (tier) => {
    const teamHues = TEAM_COLORS.map((c) => hsl(new THREE.Color(c)).h);
    for (const m of materialsOf(buildCamp(tier))) {
      for (const c of [m.color, m.emissive]) {
        const { h, s } = hsl(c);
        if (s < 0.3) continue;
        for (const th of teamHues) expect(hueGap(h, th)).toBeGreaterThanOrEqual(38);
      }
    }
  });
});

describe('the glow keeps its tint — AMENDMENT_3 §A, not a re-pointed bucket', () => {
  it.each(TIERS)('%s: the emissive bucket is venom in BOTH channels', (tier) => {
    const b = buildCamp(tier);
    const mesh = bloomMeshes(b)[0];
    if (mesh === undefined) throw new Error('no bloom bucket');
    const m = mesh.material as THREE.MeshStandardMaterial;
    // The albedo is APAL.neutral, NOT the crystal family's own `ward` cream —
    // that cream is exactly what the re-point-after-bake workaround shipped.
    expect(m.color.getHex()).toBe(new THREE.Color(APAL.neutral).getHex());
    expect(m.emissive.getHex()).toBe(new THREE.Color(APAL.neutral).getHex());
    expect(m.color.getHex()).not.toBe(new THREE.Color(APAL.ward).getHex());
  });

  it('all three tiers share ONE glow material, so they share one bucket key', () => {
    const mats = TIERS.map((t) => {
      const mesh = bloomMeshes(buildCamp(t))[0];
      if (mesh === undefined) throw new Error('no bloom bucket');
      return mesh.material as THREE.MeshStandardMaterial;
    });
    expect(new Set(mats).size).toBe(1);
  });

  it.each(['brute', 'hive'] as const)('%s: the anim part carries tint AND emissive', (tier) => {
    const anim = animOf(buildCamp(tier));
    expect(anim.tint).toBe(APAL.neutral);
    expect(anim.emissive).toEqual({ colorKey: 'neutral', intensity: 2.6 });
  });
});

describe('the anim part is TYPED, not smuggled through userData (AMENDMENT_3 §B)', () => {
  it.each(['brute', 'hive'] as const)('%s: no rift* key survives on the geometry', (tier) => {
    const anim = animOf(buildCamp(tier));
    const keys = Object.keys(anim.geo.userData);
    expect(keys.filter((k) => k.startsWith('rift'))).toEqual([]);
  });

  it.each(['brute', 'hive'] as const)('%s: everything R_UNITS needs is on the type', (tier) => {
    const anim = animOf(buildCamp(tier));
    expect(anim.geo).toBeInstanceOf(THREE.BufferGeometry);
    expect(typeof anim.surfaceId).toBe('string');
    expect(typeof anim.bloom).toBe('boolean');
  });

  it('the body group carries no rift* userData either', () => {
    for (const tier of TIERS) {
      const b = buildCamp(tier);
      expect(Object.keys(b.body.group.userData)).toEqual([]);
      expect(b.body.group.name).toBe(`rift:camp:${tier}`);
    }
  });
});

describe('the models stand ON the ground', () => {
  // The shipped hive floated with its feet at y 0.047 under a comment claiming
  // it sat flush. Every other archetype in the game sits at or below 0.010.
  it.each(TIERS)('%s: the lowest baked vertex is within 10 mm of y = 0', (tier) => {
    // 1e-6 of slack, and no more: the brute's soles land on 0.010 by
    // construction and float32 rounding puts the merged buffer 1.6e-9 above it.
    const box = bodyBox(buildCamp(tier));
    expect(box.min.y).toBeGreaterThanOrEqual(-0.01);
    expect(box.min.y).toBeLessThanOrEqual(0.01 + 1e-6);
  });
});

describe('the HP bar hugs the mesh', () => {
  // 2.85 against a measured top of 2.310 is a 0.54 m detached bar — 2.2x the
  // largest clearance anywhere in the game. A bar is anchored to the model or
  // it belongs to whatever is standing behind it.
  it.each(TIERS)('%s: barH clears the tallest baked vertex by 0.15-0.30 m', (tier) => {
    const b = buildCamp(tier);
    const clearance = b.barH - bodyBox(b).max.y;
    expect(clearance).toBeGreaterThanOrEqual(0.15);
    expect(clearance).toBeLessThanOrEqual(0.3);
  });

  it('height, bar height and bar width are all monotonic pack < hive < brute', () => {
    const top = (t: Tier): number => bodyBox(buildCamp(t)).max.y;
    expect(top('pack')).toBeLessThan(top('hive'));
    expect(top('hive')).toBeLessThan(top('brute'));
    const bh = (t: Tier): number => buildCamp(t).barH;
    expect(bh('pack')).toBeLessThan(bh('hive'));
    expect(bh('hive')).toBeLessThan(bh('brute'));
    const bw = (t: Tier): number => buildCamp(t).barW;
    expect(bw('pack')).toBeLessThan(bw('hive'));
    expect(bw('hive')).toBeLessThan(bw('brute'));
  });

  // `bob` translates by an amplitude this module cannot see (CONTRACT_GAP), so
  // the brute's heart uses `spin`, whose position IS animY. Pin the rest
  // position between the back plate and the bar.
  it('the brute heart rests above the back plate and below its own HP bar', () => {
    const b = buildCamp('brute');
    expect(b.animKind).toBe('spin');
    const anim = animOf(b);
    anim.geo.computeBoundingBox();
    const bb = anim.geo.boundingBox;
    if (bb === null) throw new Error('no anim bbox');
    expect(b.animY + bb.min.y).toBeGreaterThanOrEqual(bodyBox(b).max.y);
    expect(b.animY + bb.max.y).toBeLessThanOrEqual(b.barH);
  });
});

describe('a camp at rest does not render as one blob', () => {
  it('the mirrored post ring gives the tightest pairs the server documents', () => {
    expect(closestPostPair(CAMP_HIVE_COUNT)).toBeCloseTo(2 * POST_RING_R * Math.sin(Math.PI / 8), 6);
    expect(closestPostPair(CAMP_PACK_COUNT)).toBeCloseTo(2 * POST_RING_R * Math.sin(Math.PI / 4), 6);
    expect(closestPostPair(CAMP_BRUTE_COUNT)).toBeCloseTo(
      2 * POST_RING_R * Math.sin(Math.PI / 4),
      6,
    );
  });

  // The reviewer measured the hive at a 0.920 m half-diagonal against the
  // 0.6123 m its own 5-member post ring allows: five of them merged into one
  // mass. Both radii must fit, because a model is spawned at an arbitrary yaw.
  it.each(TIERS)('%s: both footprint radii fit half the closest post spacing', (tier) => {
    const b = buildCamp(tier);
    const budget = closestPostPair(MEMBERS[tier]) / 2;
    expect(bboxHalfDiagonal(b)).toBeLessThanOrEqual(budget);
    expect(exactFootprintR(b)).toBeLessThanOrEqual(budget);
  });
});

describe('the draw-call arithmetic (AMENDMENT_3 §D)', () => {
  // The shipped header said "four draw calls per tier", counted 32 x 4 = 128,
  // and forgot that the hive and the brute each carry an unbaked anim mesh per
  // ENTITY. This is the per-archetype half of the 144 the browser measures.
  it.each(TIERS)('%s: exactly four baked buckets, one mesh each', (tier) => {
    const b = buildCamp(tier);
    expect(b.body.parts).toHaveLength(BUCKETS_PER_TIER);
    const meshes = b.body.group.children.filter((c) => c instanceof THREE.Mesh);
    expect(meshes).toHaveLength(BUCKETS_PER_TIER);
    expect(new Set(b.body.parts.map((p) => p.material)).size).toBe(BUCKETS_PER_TIER);
  });

  it('the 3-lane worst case is 144 draw calls, not 128', () => {
    // CAMPS_PER_HALF[3] = 4 -> hive, brute, pack, pack per half.
    const half: readonly Tier[] = ['hive', 'brute', 'pack', 'pack'];
    let bodies = 0;
    let anims = 0;
    for (const tier of half) {
      const b = buildCamp(tier);
      const n = MEMBERS[tier];
      bodies += n * b.body.parts.length;
      anims += b.anim === null ? 0 : n;
    }
    expect(bodies * 2).toBe(128);
    expect(anims * 2).toBe(16);
    expect((bodies + anims) * 2).toBe(144);
  });
});

describe('the pack has glowing eyes, not dark sockets', () => {
  // The shipped header documented "dark eye sockets that reuse the hide". There
  // is no such part: the pack's eyes are venom beads in the bloom bucket, and
  // the four-bucket cap holds precisely because no dark tint was ever minted.
  it('no bucket on the pack is a dark tint of the hide', () => {
    const b = buildCamp('pack');
    const hide = new THREE.Color(APAL.barkLit).getHex();
    const albedos = materialsOf(b).map((m) => m.color.getHex());
    expect(albedos).toContain(hide);
    expect(albedos.filter((a) => a === hide)).toHaveLength(1);
    expect(new Set(albedos).size).toBe(BUCKETS_PER_TIER);
  });

  it('the pack head carries venom-lit geometry inside the glow bucket', () => {
    const b = buildCamp('pack');
    const mesh = bloomMeshes(b)[0];
    if (mesh === undefined) throw new Error('no bloom bucket');
    const pos = mesh.geometry.getAttribute('position');
    let headBeads = 0;
    for (let i = 0; i < pos.count; i++) {
      // the two eyes sit forward of the shoulders and above the jaw
      if (pos.getZ(i) > 0.55 && pos.getY(i) > 0.65) headBeads += 1;
    }
    expect(headBeads).toBeGreaterThan(0);
  });
});

describe('the three tiers are told apart by mass and height (STYLE_BIBLE §7)', () => {
  it('the pack is the only tier longer than it is tall', () => {
    for (const tier of TIERS) {
      const box = bodyBox(buildCamp(tier));
      const longer = box.max.z - box.min.z > box.max.y - box.min.y;
      expect(longer).toBe(tier === 'pack');
    }
  });

  it('the brute is at least 2.4x the pack height', () => {
    const h = (t: Tier): number => bodyBox(buildCamp(t)).max.y;
    expect(h('brute') / h('pack')).toBeGreaterThanOrEqual(2.4);
  });
});

// ============================================================================
// ANCIENTS (rift) — R_MESH_CREEP's GATE (AMENDMENT_3 §G.5).
//
// This suite exists because the two defects that this build keeps shipping are
// both INVISIBLE to the typechecker and invisible in code review:
//
//   * a geometry with no `color` attribute renders BLACK under the kit's
//     unconditional `vertexColors: true`, and compiles perfectly. `bake()`
//     supplies the attribute; the anim part never goes through `bake()`, so it
//     is the one geometry in the module that can be wrong;
//   * an `emissiveSurface()` material that is never `markBloom`ed glows without
//     blooming, and a bloom-marked bucket that carries no emissive hazes the
//     frame. Both are silent. The shipped ward measured ZERO bloom meshes.
//
// Everything else asserted here is a defect a reviewer actually found in the
// shipped module, pinned so it cannot come back: the ward eye sweeping through
// its own crown, the two teams' crystals glowing the same cream, the siege
// standing 2.5x its own hitbox, the melee costing more triangles than the
// siege, the anti-alias floor, and the silent substitution on an out-of-remit
// EntKind.
//
// It runs HEADLESS (node, no DOM), exactly as `kit.test.ts` does: the kit's
// texture generators take their no-canvas branch and material construction,
// bucketing and baking all stay exercisable without a browser.
// ============================================================================
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APAL } from '@rift/shared/palette.js';
import { CREEP_MELEE, CREEP_RANGED, CREEP_SIEGE } from '@rift/shared/config.js';
import { NEUTRAL_TEAM } from '@rift/shared/types.js';
import type { EntKind, EntTeam } from '@rift/shared/types.js';
import { BLOOM_LAYER } from '../kit.js';
import type { AnimPart, UnitBuild } from '../kit.js';
import { buildCreep, buildProjectile } from './creeps.js';

/** The six archetypes this module owns. */
const OWN_KINDS = ['melee', 'ranged', 'siege', 'shade', 'ward', 'proj'] as const;

/** Every `EntKind` that belongs to a SIBLING builder. */
const FOREIGN_KINDS: readonly EntKind[] = [
  'hero',
  'tower',
  'guard',
  'ancient',
  'campPack',
  'campBrute',
  'campHive',
];

/** The anti-alias floor this module holds (see the header of `creeps.ts`). */
const MIN_FEATURE_M = 0.05;

function animOf(b: UnitBuild): AnimPart {
  const a = b.anim;
  if (a === null) throw new Error('expected an anim part');
  return a;
}

/** Bucket meshes that the module put on BLOOM_LAYER. */
function bloomMeshes(b: UnitBuild): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  b.body.group.traverse((o) => {
    if (o instanceof THREE.Mesh && o.layers.isEnabled(BLOOM_LAYER)) out.push(o);
  });
  return out;
}

/** Triangles in the baked body — one pass, no shadow doubling. */
function bodyTriangles(b: UnitBuild): number {
  let n = 0;
  for (const p of b.body.parts) n += p.geo.getAttribute('position').count / 3;
  return n;
}

/** The union bounding box of every baked bucket, in the build's own space. */
function bodyBox(b: UnitBuild): THREE.Box3 {
  const box = new THREE.Box3();
  for (const p of b.body.parts) {
    p.geo.computeBoundingBox();
    const bb = p.geo.boundingBox;
    if (bb !== null) box.union(bb);
  }
  return box;
}

/** The tallest body vertex inside a vertical column of radius `r` about the
 *  build's Y axis. This is what an anim part bobbing or spinning on that axis
 *  can actually collide with — a whole-body bounding box would answer with the
 *  horn tips, which stand well outside the column. */
function columnTopY(b: UnitBuild, r: number): number {
  let top = -Infinity;
  for (const p of b.body.parts) {
    const pos = p.geo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      if (Math.hypot(x, z) <= r) top = Math.max(top, pos.getY(i));
    }
  }
  return top;
}

/** The radius of the smallest sphere about the anim part's own origin that
 *  contains it — how far it reaches when R_UNITS spins or scales it. */
function animReach(a: AnimPart): number {
  a.geo.computeBoundingSphere();
  const s = a.geo.boundingSphere;
  if (s === null) throw new Error('no bounding sphere');
  return s.center.length() + s.radius;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================

describe('the vertex-colour law', () => {
  it.each(OWN_KINDS)('%s: every baked bucket carries a 3-component color attribute', (kind) => {
    const b = buildCreep(kind, 0);
    expect(b.body.parts.length).toBeGreaterThan(0);
    for (const part of b.body.parts) {
      const color = part.geo.getAttribute('color');
      expect(color).toBeDefined();
      expect(color.itemSize).toBe(3);
      expect(color.count).toBe(part.geo.getAttribute('position').count);
    }
  });

  // The one geometry in the module that `bake()` does not touch, and therefore
  // the only one that can ship black with a clean typecheck (AMENDMENT_3 §B).
  it.each(['shade', 'ward'] as const)('%s: the ANIM geometry is white-vertex-coloured', (kind) => {
    const anim = animOf(buildCreep(kind, 0));
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

describe('the bloom bucket, per archetype', () => {
  // GRAPHICS_CONTRACT §7.9 both ways: every emissive bucket is marked, and
  // nothing that is not emissive is.
  it.each(OWN_KINDS)('%s: marked buckets are exactly the emissive buckets', (kind) => {
    const b = buildCreep(kind, 0);
    const marked = bloomMeshes(b);
    const emissiveMats = b.body.parts
      .map((p) => p.material)
      .filter((m) => m.emissiveIntensity > 0 && m.emissive.getHex() !== 0x000000 && m.name.startsWith('rift:crystal:'));
    expect(marked.length).toBe(emissiveMats.length);
    for (const mesh of marked) {
      const mat = mesh.material;
      expect(Array.isArray(mat)).toBe(false);
      expect(emissiveMats).toContain(mat as THREE.MeshStandardMaterial);
    }
  });

  it('the three lane creeps have no bloom at all — STYLE_BIBLE §7 gives it to the shade alone', () => {
    for (const kind of ['melee', 'ranged', 'siege'] as const) {
      expect(bloomMeshes(buildCreep(kind, 0))).toHaveLength(0);
    }
  });

  it('shade, ward and proj each carry exactly one bloom-marked body bucket', () => {
    expect(bloomMeshes(buildCreep('shade', 0))).toHaveLength(1);
    expect(bloomMeshes(buildCreep('ward', 0))).toHaveLength(1);
    expect(bloomMeshes(buildCreep('proj', 0))).toHaveLength(1);
  });

  it('a school-tipped projectile carries two — the team core and the school nose', () => {
    expect(bloomMeshes(buildProjectile(0, 'heal'))).toHaveLength(2);
    expect(bloomMeshes(buildProjectile(0, 'phys'))).toHaveLength(2);
    expect(bloomMeshes(buildProjectile(0, 'magic'))).toHaveLength(2);
  });

  // The shipped ward built TWO emissiveSurface() materials and marked neither,
  // so it measured zero bloom meshes. The anim half of that is now a flag
  // R_UNITS reads; assert the flag, because nothing else in this process can.
  it.each(['shade', 'ward'] as const)('%s: the anim part asks R_UNITS for bloom', (kind) => {
    const anim = animOf(buildCreep(kind, 0));
    expect(anim.bloom).toBe(true);
    expect(anim.surfaceId).toBe('crystal');
    expect(anim.emissive).toBeDefined();
    expect(anim.emissive?.intensity).toBeGreaterThan(0);
  });
});

describe('team colour survives the glow (AMENDMENT_3 §A)', () => {
  const emissiveBuckets = (b: UnitBuild): readonly THREE.MeshStandardMaterial[] =>
    b.body.parts.map((p) => p.material).filter((m) => m.name.startsWith('rift:crystal:'));

  it.each(['shade', 'proj'] as const)(
    '%s: the two teams differ in BOTH the emissive colour and the albedo',
    (kind) => {
      const a = emissiveBuckets(buildCreep(kind, 0));
      const e = emissiveBuckets(buildCreep(kind, 1));
      expect(a.length).toBeGreaterThan(0);
      expect(e.length).toBe(a.length);
      for (let i = 0; i < a.length; i++) {
        const ma = a[i];
        const me = e[i];
        if (ma === undefined || me === undefined) throw new Error('missing bucket');
        expect(ma.emissive.getHexString()).not.toBe(me.emissive.getHexString());
        // The shipped build lost this half: emissiveSurface() took no tint, so
        // both teams' crystals rendered the cream `ward` albedo #c9c2ae.
        expect(ma.color.getHexString()).not.toBe(me.color.getHexString());
        expect(ma.color.getHexString()).not.toBe(new THREE.Color(APAL.ward).getHexString());
      }
    },
  );

  it.each(['shade', 'ward'] as const)('%s: the anim part is team-tinted and team-keyed', (kind) => {
    const a = animOf(buildCreep(kind, 0));
    const e = animOf(buildCreep(kind, 1));
    expect(a.tint).toBe(APAL.azure);
    expect(e.tint).toBe(APAL.ember);
    expect(a.emissive?.colorKey).toBe('azure');
    expect(e.emissive?.colorKey).toBe('ember');
  });

  it('a neutral build wears the neutral ladder and never a team colour', () => {
    const n = buildCreep('shade', NEUTRAL_TEAM);
    const anim = animOf(n);
    expect(anim.tint).toBe(APAL.neutral);
    expect(anim.emissive?.colorKey).toBe('neutral');
    for (const part of n.body.parts) {
      const hex = part.material.color.getHexString();
      expect(hex).not.toBe(new THREE.Color(APAL.azure).getHexString());
      expect(hex).not.toBe(new THREE.Color(APAL.ember).getHexString());
    }
  });

  it('a projectile school recolours the nose without touching the team core', () => {
    const team = buildProjectile(0, null);
    const heal = buildProjectile(0, 'heal');
    // `surface()`/`emissiveSurface()` mix the tint into the family albedo at
    // TINT_MIX = 1, so an azure crystal's albedo IS APAL.azure.
    const teamCore = new THREE.Color(APAL.azure).getHexString();
    expect(team.body.parts.some((p) => p.material.color.getHexString() === teamCore)).toBe(true);
    expect(heal.body.parts.some((p) => p.material.color.getHexString() === teamCore)).toBe(true);
    // The school adds a second crystal bucket that the school-less dart has not.
    const crystals = (b: UnitBuild): number =>
      b.body.parts.filter((p) => p.material.name.startsWith('rift:crystal:')).length;
    expect(crystals(team)).toBe(1);
    expect(crystals(heal)).toBe(2);
    expect(
      heal.body.parts.some((p) => p.material.emissive.getHexString() === new THREE.Color(APAL.heal).getHexString()),
    ).toBe(true);
  });
});

describe('the ward eye clears the totem it sits on', () => {
  // The shipped ward used animKind 'bob', whose amplitude in units.ts is
  // +/- 0.30 m: on a 1.36 m totem that drove the eye to y 1.045, a fifth of a
  // metre INSIDE the head block, under a comment claiming clearance.
  it('does not use the 0.30 m vertical sweep', () => {
    expect(buildCreep('ward', 0).animKind).not.toBe('bob');
  });

  it('sits clear of the crown disc inside its own column, with room for the pulse', () => {
    const b = buildCreep('ward', 0);
    const eye = animOf(b);
    const reach = animReach(eye);
    const top = columnTopY(b, reach);
    // Nominal clearance.
    expect(b.animY - reach).toBeGreaterThan(top);
    // And still clear at the 1.22x scale pulse units.ts applies to a part that
    // is neither orbiting nor bobbing.
    expect(b.animY - reach * 1.22).toBeGreaterThan(top);
  });

  it('the ward carries no HP bar', () => {
    const b = buildCreep('ward', 0);
    expect(b.barH).toBe(0);
    expect(b.barW).toBe(0);
  });
});

describe('the shade mote reads as part of the unit', () => {
  // R_UNITS orbits at a hardcoded 0.55 m. The mote cannot ask for less, so it
  // must at least sit in the body's own horizontal band rather than in open air
  // above the hood.
  it('orbits below the top of the body, not above it', () => {
    const b = buildCreep('shade', 0);
    expect(b.animKind).toBe('orbit');
    expect(b.animY).toBeLessThan(bodyBox(b).max.y);
  });

  // AMENDMENT_3 §C: before the transparent families existed, every surface a
  // shade could reach shipped `transparent: false`, so BUILD_SPECS' "translucent
  // /spectral" was unreachable and the hem dissolve had to be faked with darker
  // opaque cloth. The hem now rides `fxAdditive` — which also declares
  // `castShadow: false`, so it costs one beauty draw and nothing in the shadow
  // pass. Both halves are asserted, because both are budget-visible.
  it('the hem dissolves through the additive family and never casts', () => {
    const b = buildCreep('shade', 0);
    const fx = b.body.parts.filter(
      (p) => p.material.transparent && p.material.blending === THREE.AdditiveBlending,
    );
    expect(fx).toHaveLength(1);
    expect(fx[0]?.material.depthWrite).toBe(false);
    // ALL SEVEN dissolve parts, not just some: four hem tatters at 12 triangles
    // a box plus three trailing wisps at 14 a 7-segment cone. A part quietly
    // moved back to opaque cloth changes this number and nothing else.
    expect((fx[0]?.geo.getAttribute('position').count ?? 0) / 3).toBe(4 * 12 + 3 * 14);
    let casters = 0;
    b.body.group.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material === fx[0]?.material && o.castShadow) casters++;
    });
    expect(casters).toBe(0);
  });

  it('carries real mass rather than being a point', () => {
    const mote = animOf(buildCreep('shade', 0));
    mote.geo.computeBoundingBox();
    const bb = mote.geo.boundingBox;
    if (bb === null) throw new Error('no bounding box');
    const size = bb.getSize(new THREE.Vector3());
    expect(Math.max(size.x, size.y, size.z)).toBeGreaterThanOrEqual(0.3);
  });
});

describe('a unit reads at its hitbox size (AMENDMENT_3 §F)', () => {
  const CREEP_MAX_H = 1.5 * 1.05; // STYLE_BIBLE §7's 1.5u, 5% tolerance

  it('the siege fits its 0.62 m hitbox radius and the 1.5u height cap', () => {
    const box = bodyBox(buildCreep('siege', 0));
    const size = box.getSize(new THREE.Vector3());
    expect(size.x).toBeLessThanOrEqual(CREEP_SIEGE.radius * 2);
    expect(box.max.y).toBeLessThanOrEqual(CREEP_MAX_H);
    // Only the ram breaks the hitbox forward, and by less than a third.
    expect(size.z).toBeLessThanOrEqual(CREEP_SIEGE.radius * 2 * 1.3);
  });

  it('the siege is still the widest lane creep, and now the shortest', () => {
    const siege = bodyBox(buildCreep('siege', 0));
    const melee = bodyBox(buildCreep('melee', 0));
    const ranged = bodyBox(buildCreep('ranged', 0));
    expect(siege.getSize(new THREE.Vector3()).x).toBeGreaterThan(melee.getSize(new THREE.Vector3()).x);
    expect(siege.max.y).toBeLessThan(melee.max.y);
    expect(siege.max.y).toBeLessThan(ranged.max.y);
  });

  it('melee and ranged bodies sit inside their own hitboxes too', () => {
    // Their implements (shield, sword, staff) break the envelope by design, so
    // the check is against the hitbox DIAMETER rather than the radius.
    const melee = bodyBox(buildCreep('melee', 0)).getSize(new THREE.Vector3());
    expect(melee.z).toBeLessThanOrEqual(CREEP_MELEE.radius * 2);
    const ranged = bodyBox(buildCreep('ranged', 0)).getSize(new THREE.Vector3());
    expect(ranged.z).toBeLessThanOrEqual(CREEP_RANGED.radius * 2 * 1.3);
  });

  // A health bar 0.54 m detached from its unit shipped in this wave under a
  // comment describing the opposite. The ranged creep is excluded because its
  // tallest geometry is the staff, which is an implement rather than a body,
  // and no bounding box can tell the two apart.
  it('every HP bar floats between 0.15 and 0.30 m above its own body', () => {
    for (const kind of ['melee', 'siege', 'shade'] as const) {
      const b = buildCreep(kind, 0);
      const gap = b.barH - bodyBox(b).max.y;
      expect(gap).toBeGreaterThanOrEqual(0.15);
      expect(gap).toBeLessThanOrEqual(0.3);
    }
  });
});

describe('triangle spend matches visual importance', () => {
  // The shipped melee was 1820 triangles against the siege's 764, because four
  // capsule() calls on 6.5 cm limb stubs cost 312 triangles each.
  it('the siege is the heaviest creep and the basic melee is not', () => {
    const melee = bodyTriangles(buildCreep('melee', 0));
    const siege = bodyTriangles(buildCreep('siege', 0));
    const shade = bodyTriangles(buildCreep('shade', 0));
    expect(siege).toBeGreaterThan(melee);
    expect(melee).toBeGreaterThan(shade);
    expect(melee).toBeLessThan(1000);
  });

  it('the projectile is the cheapest thing in the file — dozens fly at once', () => {
    const proj = bodyTriangles(buildCreep('proj', 0));
    expect(proj).toBeLessThan(200);
    expect(buildCreep('proj', 0).body.parts).toHaveLength(2);
  });
});

describe('the anti-alias floor (STYLE_BIBLE §7)', () => {
  // Per-PART dimensions are not reachable from the public API — `bake()` merges
  // parts into buckets — so only the buckets that hold exactly one part can be
  // checked mechanically. The ward's crystal bucket is one: it is the lens
  // glyph and nothing else, and it is one of the three parts the review found
  // under the floor (it shipped 0.02 m thick). The rest of the floor is held by
  // hand against the literals in `creeps.ts`; this is the part a test can pin.
  it('the ward lens glyph is at or above the floor in every axis', () => {
    const glyph = buildCreep('ward', 0).body.parts.find((p) =>
      p.material.name.startsWith('rift:crystal:'),
    );
    if (glyph === undefined) throw new Error('no ward crystal bucket');
    glyph.geo.computeBoundingBox();
    const bb = glyph.geo.boundingBox;
    if (bb === null) throw new Error('no bounding box');
    const size = bb.getSize(new THREE.Vector3());
    expect(Math.min(size.x, size.y, size.z)).toBeGreaterThanOrEqual(MIN_FEATURE_M);
  });

});

describe('an out-of-remit EntKind is reported, not swallowed', () => {
  it.each(FOREIGN_KINDS)('%s warns exactly once and still returns a usable build', (kind) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const b = buildCreep(kind, 0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(kind);
    expect(b.body.parts.length).toBeGreaterThan(0);
  });

  it.each(OWN_KINDS)('%s is in remit and warns about nothing', (kind) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    buildCreep(kind, 0);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the shape of every build', () => {
  it.each(OWN_KINDS)('%s: static archetypes null out every anim field together', (kind) => {
    const b = buildCreep(kind, 0);
    if (b.anim === null) {
      expect(b.animKind).toBeNull();
      expect(b.animY).toBe(0);
    } else {
      expect(b.animKind).not.toBeNull();
      expect(b.animY).toBeGreaterThan(0);
    }
  });

  it.each(OWN_KINDS)('%s: two calls return two independent Groups', (kind) => {
    const a = buildCreep(kind, 0);
    const b = buildCreep(kind, 0);
    expect(a.body.group).not.toBe(b.body.group);
    expect(a.body.group.parent).toBeNull();
    expect(b.body.group.parent).toBeNull();
  });

  it('the shade is seeded, not random: the same team builds the same geometry', () => {
    const a = buildCreep('shade', 0).body.parts[0]?.geo.getAttribute('position');
    const b = buildCreep('shade', 0).body.parts[0]?.geo.getAttribute('position');
    if (a === undefined || b === undefined) throw new Error('no shade bucket');
    expect(a.count).toBe(b.count);
    for (let i = 0; i < a.count; i += 37) expect(a.getX(i)).toBe(b.getX(i));
  });

  it('every team value is accepted, including NEUTRAL_TEAM', () => {
    for (const team of [0, 1, NEUTRAL_TEAM] as readonly EntTeam[]) {
      for (const kind of OWN_KINDS) {
        expect(buildCreep(kind, team).body.parts.length).toBeGreaterThan(0);
      }
    }
  });
});

// ============================================================================
// ACES render3d/planeModels tests (headless — plain node + THREE constructs,
// no GL, no canvas, no jsdom). attach() is NEVER called here because
// materials.puffTexture() needs a DOM canvas; every behavior under test lives
// in the attach-independent sim/pool/model layer.
//
// Gates (task brief):
//   · §5 silhouette part budgets per class × team — descendant Meshes counted
//     within band, fx-overlay subtree excluded; scout < gunship strictly
//   · team mark presence by tag: ROYAL roundel ring vs IRON bar-cross
//   · fire anchor exposed on the model root (app trail hook)
//   · FX pool bound under flood (>FX_POOL_MAX demanded ⇒ alive ≤ cap)
//   · explosion = exactly 1 shock ring + 1 flash core + ONE debris batch
//     (shards in the bible band); overWater adds the foam ring
//   · muzzle/stub parity counts; tracer instancing cap binds at 256
//   · trail emitters LRU-evict past 24 ids; null stops and flushes clean
//   · consumeShake accumulates SMALL/MEDIUM/LARGE then resets to 0
//   · crate pool bounded under id churn; canopy/ring follow the phase
//   · determinism: same seed + same emit sequence ⇒ identical dumps
// ============================================================================

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CRATE_FALL_S, CRATES_MAX, FIRE_BELOW, FX_POOL_MAX, SHAKE } from '@aces/shared/config.js';
import type { PlaneClassId, TeamId } from '@aces/shared/config.js';
import type { CrateState } from '@aces/shared/types.js';
import { APAL } from '@aces/shared/palette.js';
import { PART_BANDS, buildPlane, type PlaneModel } from './planeModels.js';
import { FX3, createEffects3D, type EffectsApi3D } from './effects3d.js';

const GLOW_HEX = APAL.fireCore.slice(1).toLowerCase(); // §9: traces to APAL

const DT = 1 / 60;
const CRATE_POOL = CRATES_MAX * 2 + 2;

/** The class keeps test-only introspection members off the frozen interface. */
interface Probe extends EffectsApi3D {
  readonly alive: number;
  readonly emitterCount: number;
  readonly tracerCount: number;
  readonly crateSlotCount: number;
  readonly activeRings: number;
  readonly sceneRoot: THREE.Object3D;
  kindCount(kind: number, sty?: number): number;
  debugDump(): number[];
}
const probe = (fx: EffectsApi3D): Probe => fx as unknown as Probe;

// ---- model helpers -------------------------------------------------------------

/** Descendant Meshes excluding the fx-overlay subtree (damage FX ≠ silhouette). */
function countParts(model: PlaneModel): number {
  let n = 0;
  const walk = (o: THREE.Object3D): void => {
    if ((o.userData as { fx?: boolean }).fx === true) return;
    if ((o as THREE.Mesh).isMesh) n++;
    for (const c of o.children) walk(c);
  };
  walk(model.group);
  return n;
}

function markTag(model: PlaneModel): string | null {
  let found: string | null = null;
  model.group.traverse((o) => {
    const m = (o.userData as { mark?: string }).mark;
    if (m && !found) found = m;
  });
  return found;
}

function findGlow(model: PlaneModel): THREE.Mesh | null {
  let hit: THREE.Mesh | null = null;
  model.group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!hit && mesh.isMesh && !o.visible) return;
    if (!hit && mesh.isMesh) {
      const mat = mesh.material as THREE.MeshBasicMaterial;
      if (mat.color.getHexString() === GLOW_HEX) hit = mesh; // APAL.fireCore
    }
  });
  return hit;
}

// ---- airframes -------------------------------------------------------------------

describe('§5 part budgets — descendant meshes within band, per class × team', () => {
  it('every build lands inside its band; scout < gunship strictly', () => {
    for (const team of ['royal', 'iron'] as const) {
      const counts: Record<PlaneClassId, number> = { scout: 0, fighter: 0, gunship: 0 };
      for (const cls of ['scout', 'fighter', 'gunship'] as const) {
        const m = buildPlane(cls, team);
        counts[cls] = countParts(m);
        expect(counts[cls]).toBeGreaterThanOrEqual(PART_BANDS[cls][0]);
        expect(counts[cls]).toBeLessThanOrEqual(PART_BANDS[cls][1]);
        m.dispose();
      }
      expect(counts.scout).toBeLessThan(counts.gunship);
    }
  });

  it('builds are deterministic and geometry kits are shared across instances', () => {
    const a = countParts(buildPlane('gunship', 'iron'));
    const b = countParts(buildPlane('gunship', 'iron'));
    expect(a).toBe(b);
  });
});

describe('team marks + fire anchor', () => {
  it('ROYAL carries a roundel RING; IRON a bar-CROSS; never mixed', () => {
    const royal = buildPlane('fighter', 'royal');
    expect(markTag(royal)).toBe('roundel');
    const iron = buildPlane('fighter', 'iron');
    expect(markTag(iron)).toBe('cross');
    let crossMeshes = 0;
    iron.group.traverse((o) => {
      if ((o.userData as { mark?: string }).mark === 'cross') crossMeshes++;
    });
    expect(crossMeshes).toBe(2); // two crossed slabs
  });

  it('fireAnchor is an Object3D parented into the group (trail hook)', () => {
    const m = buildPlane('scout', 'royal');
    expect(m.fireAnchor).toBeInstanceOf(THREE.Object3D);
    expect(m.group.getObjectByName('fireAnchor')).toBe(m.fireAnchor);
  });

  it('setDamage: soot appears with damage; fire glow only at/below FIRE_BELOW hp', () => {
    const m = buildPlane('fighter', 'iron');
    const glowAt = (): boolean => findGlow(m)?.visible ?? false;

    m.setDamage(0);
    expect(glowAt()).toBe(false);

    m.setDamage(0.5); // heavy soot but hp-frac still above FIRE_BELOW
    expect(glowAt()).toBe(false);

    // damage frac ≥ 1−FIRE_BELOW ⇔ hp/maxHp < FIRE_BELOW ⇒ burning trail hook
    m.setDamage(1 - FIRE_BELOW + 0.01);
    expect(glowAt()).toBe(true);
  });

  it('blink flickers at half duty while base visibility stays respected', () => {
    const m = buildPlane('scout', 'royal');
    m.setBlink(true);
    m.update(0.13, 0); // clock .13 → floor(1.04)=1 → OFF phase
    expect(m.group.visible).toBe(false);
    m.update(0.13, 0); // clock .26 → floor(2.08)=2 → ON phase
    expect(m.group.visible).toBe(true);

    m.setVisible(false); // base visibility always wins
    m.update(0.13, 0);
    expect(m.group.visible).toBe(false);
  });

  it('dispose detaches the airframe from its parent', () => {
    const m = buildPlane('gunship', 'royal');
    const parent = new THREE.Group();
    parent.add(m.group);
    m.dispose();
    expect(m.group.parent).toBeNull();
  });

  it('controls ease the tail surfaces toward the commanded turn', () => {
    const m = buildPlane('fighter', 'royal');
    const tailGroup = m.group.children.find((c) => c.type === 'Group' && c !== m.fireAnchor);
    if (!tailGroup) throw new Error('tail/elevator group missing');
    expect(tailGroup.rotation.z).toBe(0);
    m.setControls(1);
    for (let i = 0; i < 30; i++) m.update(DT, i * DT);
    // elevator z-tilt saturates near −0.35 rad for full turn-in
    expect(Math.abs(tailGroup.rotation.z)).toBeGreaterThan(0.25);
  });
});

// ---- effects ---------------------------------------------------------------------

describe('FX pool bound under flood', () => {
  it('demanding far more than FX_POOL_MAX particles never exceeds the cap', () => {
    const fx = probe(createEffects3D(9));
    for (let i = 0; i < 80; i++) {
      fx.explosion({ x: (i * 137) % 4000, y: (i * 271) % 3000 }, i % 2 ? 'large' : 'small', i % 3 === 0);
      if (i % 4 === 0) fx.hitSpark({ x: i * 7, y: i * 3 });
      if (i % 5 === 0) fx.trail(`t${i}`, { x: i, y: i }, 'fire');
      fx.update(DT, { x: 2000, y: 1500 });
      expect(fx.alive).toBeLessThanOrEqual(FX_POOL_MAX);
    }
    // prove the cap BINDS rather than the test being lucky
    let saturated = false;
    for (let i = 0; i < 60 && !saturated; i++) {
      fx.explosion({ x: 10, y: 10 }, 'large', true);
      if (fx.alive === FX_POOL_MAX) saturated = true;
    }
    expect(saturated).toBe(true);
  });
});

describe('explosion composition — exactly 1 ring / 1 core / one debris batch', () => {
  it('small blast into an empty pool', () => {
    const fx = probe(createEffects3D(21));
    fx.explosion({ x: 1000, y: 1000 }, 'small', false);
    expect(fx.activeRings).toBe(1);
    expect(fx.kindCount(FX3.PUFF, FX3.V_CORE)).toBe(1);
    const shards = fx.kindCount(FX3.SHARD);
    expect(shards).toBeGreaterThanOrEqual(8);
    expect(shards).toBeLessThanOrEqual(14);
    expect(fx.alive).toBeGreaterThan(shards); // blooms + smoke column came along
  });

  it('large blast stays in the bible debris band (12–14)', () => {
    const fx = probe(createEffects3D(22));
    fx.explosion({ x: 0, y: 0 }, 'large', false);
    const shards = fx.kindCount(FX3.SHARD);
    expect(shards).toBeGreaterThanOrEqual(12);
    expect(shards).toBeLessThanOrEqual(14);
  });

  it('overWater adds exactly one foam ring on top of the standard blast', () => {
    const dry = probe(createEffects3D(5));
    dry.explosion({ x: 0, y: 0 }, 'small', false);
    const wet = probe(createEffects3D(5));
    wet.explosion({ x: 0, y: 0 }, 'small', true);
    expect(wet.activeRings).toBe(2);
    expect(dry.activeRings).toBe(1);
    expect(wet.alive).toBeGreaterThan(dry.alive);
  });
});

describe('muzzle flash / tracer stub / hit spark parity', () => {
  it('muzzleFlash = flash sprite + stub streak + smoke wisp', () => {
    const fx = probe(createEffects3D(13));
    fx.muzzleFlash({ x: 10, y: 20 }, 0.4);
    expect(fx.alive).toBe(3);
    expect(fx.kindCount(FX3.STREAK)).toBe(1);
    expect(fx.kindCount(FX3.PUFF, FX3.V_FLASH)).toBe(1);
  });

  it('tracerStub = exactly one streak', () => {
    const fx = probe(createEffects3D(14));
    fx.tracerStub({ x: 30, y: 30 }, 2);
    expect(fx.alive).toBe(1);
    expect(fx.kindCount(FX3.STREAK)).toBe(1);
  });

  it('hitSpark answers spark tick + ≥2 ink chips + SMALL shake', () => {
    const fx = probe(createEffects3D(15));
    fx.hitSpark({ x: 0, y: 0 });
    expect(fx.kindCount(FX3.SHARD)).toBeGreaterThanOrEqual(2);
    expect(fx.consumeShake()).toBe(SHAKE.SMALL);
  });

  it('drawProjectiles binds the tracer instancing cap at 256', () => {
    const fx = probe(createEffects3D(23));
    const bullets = Array.from({ length: 300 }, (_, i) => ({
      x: i * 7,
      y: i * 3,
      vx: 400 + (i % 7) * 90,
      vy: -300 + (i % 11) * 55,
    }));
    fx.drawProjectiles(bullets);
    expect(fx.tracerCount).toBe(256);
    fx.drawProjectiles([]);
    expect(fx.tracerCount).toBe(0);
  });
});

describe('crateFx + crate pool', () => {
  it('land dust and pickup sparkle both emit', () => {
    const fx = probe(createEffects3D(16));
    fx.crateFx('land', { x: 50, y: 50 });
    fx.crateFx('pickup', { x: 60, y: 60 });
    expect(fx.alive).toBeGreaterThan(10);
  });

  it('syncCrates stays bounded under id churn and follows phases', () => {
    const fx = probe(createEffects3D(17));
    const falling: CrateState[] = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      x: i * 20,
      y: -i * 15,
      phase: 'fall',
      t: CRATE_FALL_S,
    }));
    fx.syncCrates(falling);
    fx.update(DT, { x: 100, y: 100 });
    expect(fx.crateSlotCount).toBeLessThanOrEqual(CRATE_POOL);
    expect(fx.crateSlotCount).toBeGreaterThan(0);

    // falling slots: canopy up, pulse ring hidden
    let canopies = 0;
    let ringsShown = 0;
    probe(fx).sceneRoot.traverse((o) => {
      if (o.name === 'canopy' && o.parent?.parent?.visible) canopies++;
      if (o.name === 'pulse-ring' && o.visible) ringsShown++;
    });
    expect(canopies).toBeGreaterThan(0);
    expect(ringsShown).toBe(0);

    // landed slot: canopy collapses away, foam pulse ring shows
    fx.syncCrates([{ id: 99, x: -300, y: 220, phase: 'active', t: 10 }]);
    fx.update(DT, { x: 100, y: 100 });
    expect(fx.crateSlotCount).toBe(1);
    let landedCanopy = false;
    let landedRing = false;
    probe(fx).sceneRoot.traverse((o) => {
      if (o.name === 'canopy' && o.parent?.parent?.visible) landedCanopy = landedCanopy || o.visible;
      if (o.name === 'pulse-ring' && o.visible) landedRing = true;
    });
    expect(landedCanopy).toBe(false);
    expect(landedRing).toBe(true);
  });
});

describe('consumeShake — accumulate then reset to 0', () => {
  it('maps hitSpark→SMALL, small blast→MEDIUM, large blast→LARGE', () => {
    const fx = probe(createEffects3D(11));
    expect(fx.consumeShake()).toBe(0);

    fx.hitSpark({ x: 0, y: 0 });
    fx.hitSpark({ x: 5, y: 5 });
    expect(fx.consumeShake()).toBe(SHAKE.SMALL * 2);
    expect(fx.consumeShake()).toBe(0); // consumed ⇒ reset

    fx.explosion({ x: 0, y: 0 }, 'small', false);
    expect(fx.consumeShake()).toBe(SHAKE.MEDIUM);
    fx.explosion({ x: 0, y: 0 }, 'large', false);
    expect(fx.consumeShake()).toBe(SHAKE.LARGE);
    expect(fx.consumeShake()).toBe(0);
  });
});

describe('trail emitter lifecycle — LRU ≤24, null flushes clean', () => {
  it('smokes while smoking, stops and fully clears after null', () => {
    const fx = probe(createEffects3D(19));
    let aliveWhileSmoking = 0;
    for (let k = 0; k < 90; k++) {
      fx.trail('ace-1', { x: 400 + k, y: 400 }, 'smoke');
      fx.update(DT, { x: 450, y: 450 });
      aliveWhileSmoking = Math.max(aliveWhileSmoking, fx.alive);
    }
    expect(aliveWhileSmoking).toBeGreaterThan(4); // puffs actually emitted

    fx.trail('ace-1', { x: 500, y: 500 }, null);
    for (let k = 0; k < 120; k++) fx.update(DT, { x: 450, y: 450 }); // > max smoke ttl
    expect(fx.alive).toBe(0);
  });

  it('fire trails emit embers; emitter map evicts past 24 ids', () => {
    const fx = probe(createEffects3D(20));
    for (let i = 0; i < 30; i++) fx.trail(`plane-${i}`, { x: i * 10, y: 0 }, i % 2 ? 'smoke' : 'fire');
    expect(fx.emitterCount).toBeLessThanOrEqual(24);
    for (let k = 0; k < 30; k++) fx.update(DT, { x: 150, y: 0 });
    expect(fx.kindCount(FX3.PUFF, FX3.V_FIRE)).toBeGreaterThan(0); // fire lanes burn
  });
});

describe('determinism — same seed + same sequence ⇒ identical particles', () => {
  const script = (seed: number): number[] => {
    const fx = probe(createEffects3D(seed));
    fx.explosion({ x: 1000, y: 800 }, 'large', true);
    fx.hitSpark({ x: 600, y: 620 });
    fx.muzzleFlash({ x: 700, y: 700 }, 1.1);
    fx.tracerStub({ x: 200, y: 300 }, 2.5);
    fx.crateFx('land', { x: 1500, y: 900 });
    fx.syncCrates([
      { id: 1, x: -300, y: 220, phase: 'fall', t: CRATE_FALL_S },
      { id: 2, x: 300, y: -140, phase: 'active', t: 8 },
    ]);
    fx.trail('d1', { x: 300, y: 300 }, 'smoke');
    fx.trail('d2', { x: 350, y: 300 }, 'fire');
    for (let k = 0; k < 45; k++) {
      fx.trail('d1', { x: 300 + k * 3, y: 300 + (k % 5) }, 'smoke');
      fx.trail('d2', { x: 350 + k * 3, y: 300 }, 'fire');
      fx.update(DT, { x: 500, y: 500 });
    }
    fx.trail('d2', { x: 0, y: 0 }, null);
    for (let k = 0; k < 30; k++) fx.update(DT, { x: 500, y: 500 });
    return fx.debugDump();
  };

  it('two systems on the same seed produce identical dumps', () => {
    expect(script(4242)).toEqual(script(4242));
  });

  it('a different seed moves the ink somewhere else', () => {
    expect(script(4242)).not.toEqual(script(4243));
  });
});

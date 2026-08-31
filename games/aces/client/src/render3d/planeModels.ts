// ============================================================================
// ACES render3d/planeModels — 3D airframes ×3 classes ×2 liveries.
//
// GRAPHICS_3D.md §4 seam: buildPlane(cls, team) → PlaneModel whose group faces
// +X; the APP owns position (X=x, Z=y, Y=PLANE_Y+bob), rotation.y=−h and the
// pitch/bank transforms (§1). The model itself owns ONLY: prop spin, control-
// surface easing from setControls(turnIn), damage-soot overlay + fire anchor,
// invuln blink (8 Hz half-duty) and visibility.
//
// Silhouette law STYLE_BIBLE §5 — part bands are LAW in 3D too, counted as
// descendant Meshes under group EXCLUDING the fx overlay subtree (soot shells
// + fire glow are damage FX, not airframe silhouette; tagged userData.fx):
//   SCOUT  13–14 (band 10–14): stubby round-cowl staggered biplane, high rudder
//   FIGHTER 16–17 (band 12–18): equal-span biplane, twin muzzles break cowl
//   GUNSHIP 21–22 (band 16–22): triple-wing stack, mid wing far forward,
//          deep slab fuselage, twin rudders
// Livery double-encoding: ROYAL royalNavy body + royalDeck ROUNDEL RING
// (flat torus) mid-wing + royalDeck tail fin; IRON ironRed body + ironDeck
// BAR-CROSS (two crossed slabs) mid-wing + ironDeck tail fin over a paper
// tailplane band. Marks are sized ×2 (ring outer ≈7u) so they read through
// fog at chase distance (F2). Dope-linen lower wings, wood cowls/struts,
// tire-dark guns/gear, prop = semi-transparent disc + 2 blades.
//
// PERF/ALLOC LAW: geometry kits are cached per dimension at first build
// (bounded set; respawn churn reuses them), materials come from the FROZEN
// factory caches and are NEVER mutated — damage soot swaps between a prebuilt
// quantized opacity ladder instead. Per-frame work mutates a fixed set of
// transforms only. No Math.random; builds are fully deterministic.
// ============================================================================

import * as THREE from 'three';
import { FIRE_BELOW, type PlaneClassId, type TeamId } from '@aces/shared/config.js';
import { matBasic, matLambert, pal } from './materials.js';
import { mixA, shadeA } from '../contract/visual.js';

/** §5 bands kept beside the art so drift fails loudly in review/tests. */
export const PART_BANDS: Readonly<Record<PlaneClassId, [number, number]>> = {
  scout: [10, 14],
  fighter: [12, 18],
  gunship: [16, 22],
};

const DIHEDRAL = Math.tan((4 * Math.PI) / 180);
/** hp/maxHp < FIRE_BELOW ⇔ missing-HP frac ≥ 1−FIRE_BELOW ⇒ burning trail. */
const FIRE_T = 1 - FIRE_BELOW;

// ---- materials (factory-only colors; cached & shared, never mutated) --------

const BODY: Readonly<Record<TeamId, THREE.Material>> = {
  royal: matLambert(pal('royalNavy')),
  iron: matLambert(pal('ironRed')),
};
const MARK: Readonly<Record<TeamId, THREE.Material>> = {
  royal: matLambert(pal('royalDeck')),
  iron: matLambert(pal('ironDeck')),
};
const DOPE_M = matLambert(pal('dope'));
const WOOD = matLambert(pal('wood'));
const TIRE = matLambert(pal('tire'));
/** ROYAL deck-cream tailfin tone (§5 livery third channel). */
const ROYAL_TAIL = matLambert(shadeA('royalDeck', -0.15));
/**
 * F2 IRON tail assembly: ironDeck fin panels ride over a PAPER-toned
 * tailplane — the bright "paper edge" band that lets near-black ironDeck read
 * against the dark sea from behind. Single materials only: the frozen part
 * bands (§5) leave IRON scout/gunship zero headroom, so the edge cannot be
 * its own mesh (and multi-material arrays are not used anywhere on purpose).
 */
const PAPER_M = matLambert(pal('paper'));
const PROP_DISC = matBasic(pal('prop'), { transparent: true, opacity: 0.35, depthWrite: false });
const FIRE_GLOW = matBasic(pal('fireCore'), { transparent: true, opacity: 0.9, depthWrite: false });
/** Quantized soot ladder — index = floor(damageFrac × 7); house idiom. */
const SOOT_TONE = mixA('smokeDk', 'ink', 0.45);
const SOOT_MATS: readonly THREE.MeshBasicMaterial[] = Array.from({ length: 7 }, (_, i) =>
  matBasic(SOOT_TONE, { transparent: true, opacity: 0.14 + (i / 6) * 0.66 }),
);

// ---- geometry kit (cached per dimension string; shared across instances) ----

const geoCache = new Map<string, THREE.BufferGeometry>();

function cached(key: string, build: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) {
    g = build();
    geoCache.set(key, g);
  }
  return g;
}

/** Thin wing slab with ~4° dihedral baked into the vertices (one mesh/wing). */
function wingGeo(chord: number, span: number, thick: number): THREE.BufferGeometry {
  return cached(`wing:${chord}:${span}:${thick}`, () => {
    const g = new THREE.BoxGeometry(chord, thick, span);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i)! + Math.abs(p.getZ(i)!) * DIHEDRAL);
    p.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  });
}

/** Tapered prism fuselage along X — top radius faces the nose (+X). */
function prismGeo(rNose: number, rTail: number, len: number, seg: number): THREE.BufferGeometry {
  return cached(`prism:${rNose}:${rTail}:${len}:${seg}`, () => {
    const g = new THREE.CylinderGeometry(rNose, rTail, len, seg);
    g.rotateZ(-Math.PI / 2);
    return g;
  });
}

function cylGeo(r: number, len: number): THREE.BufferGeometry {
  return cached(`cyl:${r}:${len}`, () => {
    const g = new THREE.CylinderGeometry(r, r * 0.94, len, 10);
    g.rotateZ(-Math.PI / 2);
    return g;
  });
}

function domeGeo(r: number): THREE.BufferGeometry {
  return cached(`dome:${r}`, () => new THREE.SphereGeometry(r, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2));
}

/** Lens-disc prop blur: squashed closed sphere reads from BOTH chase sides. */
function discGeo(r: number): THREE.BufferGeometry {
  return cached(`disc:${r}`, () => {
    const g = new THREE.SphereGeometry(r, 18, 6);
    g.scale(0.07, 1, 1);
    return g;
  });
}

function boxGeo(x: number, y: number, z: number): THREE.BufferGeometry {
  return cached(`box:${x}:${y}:${z}`, () => new THREE.BoxGeometry(x, y, z));
}

// ---- assembly -----------------------------------------------------------------

interface Rig {
  group: THREE.Group;
  /** Engine-bay fire anchor exposed for the APP's trail hook (§4 brief). */
  fireAnchor: THREE.Object3D;
  propSpin: THREE.Group;
  propRate: number;
  /** Elevator group (tailplane) pivots at the tail root. */
  elevator: THREE.Group;
  rudders: THREE.Mesh[];
  wingTop: THREE.Mesh | null;
  wingLow: THREE.Mesh | null;
  sootE: THREE.Mesh;
  sootT: THREE.Mesh;
  glow: THREE.Mesh;
}

/** Fresh draft with placeholder refs filled in by the assembly helpers. */
function newRig(group: THREE.Group, propRate: number): Rig {
  return {
    group,
    fireAnchor: undefined as unknown as THREE.Object3D,
    propSpin: undefined as unknown as THREE.Group,
    propRate,
    elevator: undefined as unknown as THREE.Group,
    rudders: [],
    wingTop: null,
    wingLow: null,
    sootE: undefined as unknown as THREE.Mesh,
    sootT: undefined as unknown as THREE.Mesh,
    glow: undefined as unknown as THREE.Mesh,
  };
}

interface Place {
  x: number;
  y?: number;
  z?: number;
}

function put(
  parent: THREE.Object3D,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  at: Place,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(at.x, at.y ?? 0, at.z ?? 0);
  parent.add(m);
  return m;
}

/** Team mark on a wing top surface, sized to read at chase distance (F2).
 *  `r` is the OUTER radius/span: ROYAL ring outer ≈ r · IRON bar arms span r.
 *  ROYAL ring · IRON crossed bars. */
function addMark(parent: THREE.Object3D, team: TeamId, x: number, y: number, r: number): void {
  if (team === 'royal') {
    const g = cached(`roundel:${r}`, () => {
      // torus outer = rr·(1+0.22) ⇒ rr = r/1.22 lands the outer edge on r
      const rr = r / 1.22;
      const t = new THREE.TorusGeometry(rr, rr * 0.22, 8, 24);
      t.rotateX(Math.PI / 2);
      return t;
    });
    const ring = put(parent, g, MARK.royal, { x, y });
    ring.name = 'mark-roundel';
    ring.userData.mark = 'roundel';
  } else {
    const w = Math.max(2.2, r * 0.32); // slab width — reads at 24u+
    const a = put(parent, boxGeo(r, 0.26, w), MARK.iron, { x, y }); // spanwise bar
    const b = put(parent, boxGeo(w, 0.26, r), MARK.iron, { x, y }); // chordwise bar
    a.name = 'mark-cross-a';
    b.name = 'mark-cross-b';
    a.userData.mark = 'cross';
    b.userData.mark = 'cross';
  }
}

function addProp(
  parent: THREE.Object3D,
  rig: Pick<Rig, 'propSpin' | 'propRate'>,
  discX: number,
  discR: number,
  bladeLen: number,
  rate: number,
): void {
  put(parent, discGeo(discR), PROP_DISC, { x: discX });
  const spin = new THREE.Group();
  spin.position.set(discX - 0.45, 0, 0);
  parent.add(spin);
  const b1 = put(spin, boxGeo(0.34, bladeLen, 0.14), TIRE, { x: 0 });
  b1.rotation.x = 0;
  const b2 = put(spin, boxGeo(0.34, bladeLen, 0.14), TIRE, { x: 0 });
  b2.rotation.x = Math.PI / 2;
  rig.propSpin = spin;
  rig.propRate = rate;
}

/**
 * Tail group: elevator (tailplane) tilts around the tail root pivot; rudders
 * ride inside the group AND yaw on their own axis. F2: the fin is the team
 * read from BEHIND (the chase view) — a LOUD team-secondary panel ~1.6× the
 * old rudder: ROYAL royalDeck · IRON ironDeck over a paper tailplane band.
 */
function addTail(
  parent: THREE.Object3D,
  team: TeamId,
  rig: Pick<Rig, 'elevator' | 'rudders'>,
  o: {
    pivotX: number;
    planeChord: number;
    planeSpan: number;
    planeX: number;
    planeY: number;
    rudX: number;
    rudZ: readonly number[];
    rudH: number;
  },
): void {
  const tail = new THREE.Group();
  tail.position.set(o.pivotX, 0, 0);
  parent.add(tail);
  rig.elevator = tail;
  put(
    tail,
    wingGeo(o.planeChord, o.planeSpan, 0.35),
    team === 'royal' ? BODY[team] : PAPER_M, // IRON paper edge band (F2)
    { x: o.planeX - o.pivotX, y: o.planeY },
  );
  const finMat = team === 'royal' ? ROYAL_TAIL : MARK.iron;
  const finH = o.rudH * 1.6;
  for (let i = 0; i < o.rudZ.length; i++) {
    const z = o.rudZ[i]!;
    const rud = put(tail, boxGeo(finH * 0.62, finH, 0.32), finMat, {
      x: o.rudX - o.pivotX,
      y: o.planeY + finH * 0.42,
      z,
    });
    rig.rudders.push(rud);
  }
}

function addDamageFx(
  parent: THREE.Object3D,
  fx: THREE.Group,
  rig: Pick<Rig, 'sootE' | 'sootT' | 'glow' | 'fireAnchor'>,
  sootX: number,
  scorchX: number,
): void {
  const shell = cached('soot-shell', () => new THREE.SphereGeometry(1, 9, 6));
  const e = new THREE.Mesh(shell, SOOT_MATS[0]!);
  e.position.set(sootX, 0.25, 0);
  e.visible = false;
  fx.add(e);
  rig.sootE = e;
  const t = new THREE.Mesh(shell, SOOT_MATS[0]!);
  t.position.set(scorchX, 0.2, 0);
  t.visible = false;
  fx.add(t);
  rig.sootT = t;
  const glow = new THREE.Mesh(cached('fire-glow', () => new THREE.OctahedronGeometry(1.15)), FIRE_GLOW);
  glow.position.set(sootX + 1.2, 0.55, 0);
  glow.visible = false;
  fx.add(glow);
  rig.glow = glow;
  const anchor = new THREE.Object3D();
  anchor.name = 'fireAnchor';
  anchor.position.set(sootX + 2.4, 0.35, 0);
  parent.add(anchor); // lives on the model root — app reads its world transform
  rig.fireAnchor = anchor;
}

// ---- per-class builders ---------------------------------------------------------
//
// Part lists (silhouette Meshes only; see header bands):
//   SCOUT   fuselage·cowl·hump·wingT·wingB·strut×2·tailplane·rudder·disc·
//           blade×2·mark(1–2)
//   FIGHTER + fore-deck·mg×2
//   GUNSHIP + cockpit·midWing·strut+1·noseMG×2→pods×2 swap·rudder+1·cowlBlock

function buildScout(team: TeamId): Rig {
  const group = new THREE.Group();
  const fx = new THREE.Group();
  fx.userData.fx = true;
  const bodyMat = BODY[team];
  const rig = newRig(group, 26);

  put(group, prismGeo(2.1, 1.15, 28, 6), bodyMat, { x: 0 }); // stubby nose-heavy hull
  put(group, cylGeo(2.45, 3), WOOD, { x: 13.2 }); // ROUND cowl — scout signature
  put(group, domeGeo(2.1), DOPE_M, { x: -1.5, y: 0.85 }); // single-seat hump
  rig.wingTop = put(group, wingGeo(4, 26, 0.5), bodyMat, { x: 4.6, y: 2.9 });
  rig.wingLow = put(group, wingGeo(3.4, 22, 0.5), DOPE_M, { x: 6.4, y: -0.5 });
  put(group, cylGeoV(0.22, 3.7), WOOD, { x: 5.5, y: 1.2, z: 7 });
  put(group, cylGeoV(0.22, 3.7), WOOD, { x: 5.5, y: 1.2, z: -7 });
  addTail(group, team, rig, {
    pivotX: -10.5,
    planeChord: 4,
    planeSpan: 10,
    planeX: -12.5,
    planeY: 0.35,
    rudX: -15.2,
    rudZ: [0],
    rudH: 3.9, // HIGH rudder — busy-tail read
  });
  addProp(group, rig, 15.4, 3.6, 6.4, 26);
  addMark(group, team, 4.6, 3.28, 6); // F2: ×2 — reads through fog at 24u

  addDamageFx(group, fx, rig, 8, -12);
  group.add(fx);
  return rig;
}

function buildFighter(team: TeamId): Rig {
  const group = new THREE.Group();
  const fx = new THREE.Group();
  fx.userData.fx = true;
  const bodyMat = BODY[team];
  const rig = newRig(group, 23);

  put(group, prismGeo(2.2, 1.2, 32, 6), bodyMat, { x: 0 });
  put(group, boxGeo(7, 0.55, 2.5), DOPE_M, { x: 10, y: 1.45 }); // tapered fore-deck linen
  put(group, cylGeo(2.35, 3.2), WOOD, { x: 14.6 });
  put(group, domeGeo(2.2), DOPE_M, { x: -2.2, y: 0.95 });
  rig.wingTop = put(group, wingGeo(4.4, 30, 0.55), bodyMat, { x: 4.8, y: 3.1 }); // EQUAL-span read
  rig.wingLow = put(group, wingGeo(3.8, 27, 0.55), DOPE_M, { x: 6.6, y: -0.6 });
  put(group, cylGeoV(0.24, 4), WOOD, { x: 5.6, y: 1.25, z: 8.3 });
  put(group, cylGeoV(0.24, 4), WOOD, { x: 5.6, y: 1.25, z: -8.3 });
  const mg = boxGeo(2.3, 0.62, 0.62);
  put(group, mg, TIRE, { x: 17.3, y: 1.15, z: 2.2 }); // straight twin MGs…
  put(group, mg, TIRE, { x: 17.3, y: 1.15, z: -2.2 }); // …breaking the cowl line
  addTail(group, team, rig, {
    pivotX: -12,
    planeChord: 4.6,
    planeSpan: 12.4,
    planeX: -14.4,
    planeY: 0.35,
    rudX: -17.4,
    rudZ: [0],
    rudH: 3.3,
  });
  addProp(group, rig, 17.8, 3.4, 6.2, 23);
  addMark(group, team, 4.8, 3.51, 6.8); // F2: ×2 — reads through fog at 24u

  addDamageFx(group, fx, rig, 9, -13);
  group.add(fx);
  return rig;
}

function buildGunship(team: TeamId): Rig {
  const group = new THREE.Group();
  const fx = new THREE.Group();
  fx.userData.fx = true;
  const bodyMat = BODY[team];
  const rig = newRig(group, 19);

  const slab = put(group, prismSquare(2.75, 1.7, 31), bodyMat, { x: 0 }); // DEEP SLAB hull
  slab.scale.set(1, 1.35, 1);
  put(group, boxGeo(9, 0.7, 3.4), DOPE_M, { x: 8.5, y: 2.35 }); // armored deck plate
  put(group, domeGeo(2.5), DOPE_M, { x: -5, y: 1.9 }); // cockpit slab
  rig.wingTop = put(group, wingGeo(4.6, 36, 0.6), bodyMat, { x: 1.2, y: 4.2 });
  const mid = put(group, wingGeo(4.4, 33, 0.6), bodyMat, { x: 11, y: 2.2 }); // MID wing FAR FORWARD
  rig.wingLow = put(group, wingGeo(4.2, 30, 0.6), DOPE_M, { x: -3.2, y: -0.9 });
  const strut = cylGeoV(0.3, 5.4);
  put(group, strut, WOOD, { x: 1.2, y: 1.65, z: 8.8 });
  put(group, strut, WOOD, { x: 1.2, y: 1.65, z: -8.8 });
  put(group, cylGeoV(0.3, 5.2), WOOD, { x: -1.5, y: 1.65, z: 0 }); // center cabane
  const gun = boxGeo(2.5, 0.7, 0.7);
  put(group, gun, TIRE, { x: 16.4, y: 1.3, z: 2.4 }); // paired nose muzzles
  put(group, gun, TIRE, { x: 16.4, y: 1.3, z: -2.4 });
  const pod = boxGeo(2.8, 0.9, 1);
  put(group, pod, TIRE, { x: 9.2, y: 1.55, z: 6.5 }); // wing gun pods on mid wing
  put(group, pod, TIRE, { x: 9.2, y: 1.55, z: -6.5 });
  addTail(group, team, rig, {
    pivotX: -13,
    planeChord: 5.4,
    planeSpan: 15,
    planeX: -15.4,
    planeY: 0.4,
    rudX: -18.4,
    rudZ: [1.9, -1.9], // TWIN rudders — second silhouette signature
    rudH: 2.7,
  });
  put(group, cylGeo(3, 3.6), WOOD, { x: 13.4 }); // armored cowl block
  addProp(group, rig, 16.6, 4.6, 8.4, 19);
  // Mark rides the forward mid wing per §5 ("roundel ring mid-wing").
  addMark(mid, team, 0, 0.44, 7.6); // F2: ×2 — reads through fog at 24u

  addDamageFx(group, fx, rig, 10, -14);
  group.add(fx);
  return rig;
}

/** Vertical cylinder (struts) — separate cache key from the X-axis cowls. */
function cylGeoV(r: number, len: number): THREE.BufferGeometry {
  return cached(`cylv:${r}:${len}`, () => new THREE.CylinderGeometry(r, r, len, 6));
}

/** 4-segment prism rotated so the diamond reads as a flat-sided slab. */
function prismSquare(rNose: number, rTail: number, len: number): THREE.BufferGeometry {
  return cached(`prismq:${rNose}:${rTail}:${len}`, () => {
    const g = new THREE.CylinderGeometry(rNose, rTail, len, 4, 1);
    g.rotateZ(-Math.PI / 2);
    g.rotateX(Math.PI / 4);
    return g;
  });
}

// ---- the model -------------------------------------------------------------------

export interface PlaneModel {
  /** Faces +X; app sets position (X=x, Z=y, Y=alt+bob) + rotation.y=−h. */
  readonly group: THREE.Group;
  /** Engine-bay anchor — app's fire-trail hook once frac ≥ 1−FIRE_BELOW. */
  readonly fireAnchor: THREE.Object3D;
  /** turnIn drives rudder/aileron wash; pitIn (−1 dive..+1 climb, §8) drives
   *  the elevator — the pitch control surface. Both ease internally. */
  setControls(turnIn: number, pitIn?: number): void;
  setDamage(frac01: number): void;
  setBlink(b: boolean): void;
  setVisible(b: boolean): void;
  update(dtS: number, tS: number): void;
  dispose(): void;
}

class PlaneModelImpl implements PlaneModel {
  readonly group: THREE.Group;
  readonly fireAnchor: THREE.Object3D;

  private readonly propSpin: THREE.Group;
  private readonly propRate: number;
  private readonly elevator: THREE.Group;
  private readonly rudders: THREE.Mesh[];
  private readonly wingTop: THREE.Mesh | null;
  private readonly wingLow: THREE.Mesh | null;
  private readonly sootE: THREE.Mesh;
  private readonly sootT: THREE.Mesh;
  private readonly glow: THREE.Mesh;

  private turnTarget = 0;
  private turnEased = 0;
  private pitTarget = 0;
  private pitEased = 0;
  private clock = 0;
  private baseVisible = true;
  private blinkOn = false;

  constructor(rig: Rig) {
    this.group = rig.group;
    this.fireAnchor = rig.fireAnchor;
    this.propSpin = rig.propSpin;
    this.propRate = rig.propRate;
    this.elevator = rig.elevator;
    this.rudders = rig.rudders;
    this.wingTop = rig.wingTop;
    this.wingLow = rig.wingLow;
    this.sootE = rig.sootE;
    this.sootT = rig.sootT;
    this.glow = rig.glow;
  }

  setControls(turnIn: number, pitIn: number = 0): void {
    this.turnTarget = turnIn < -1 ? -1 : turnIn > 1 ? 1 : turnIn;
    this.pitTarget = pitIn < -1 ? -1 : pitIn > 1 ? 1 : pitIn;
  }

  setDamage(frac01: number): void {
    const f = frac01 < 0 ? 0 : frac01 > 1 ? 1 : frac01;
    const idx = Math.min(SOOT_MATS.length - 1, Math.floor(f * SOOT_MATS.length));
    if (f > 0.04) {
      this.sootE.visible = true;
      this.sootE.material = SOOT_MATS[idx]!;
      const s = 1 + f * 0.9;
      this.sootE.scale.set(3.1 * s, 1.9 * s, 2.3 * s);
    } else {
      this.sootE.visible = false;
    }
    if (f >= 0.55) {
      this.sootT.visible = true;
      this.sootT.material = SOOT_MATS[idx]!;
      const s = 1 + f * 0.5;
      this.sootT.scale.set(2 * s, 1.4 * s, 1.7 * s);
    } else {
      this.sootT.visible = false;
    }
    this.glow.visible = f >= FIRE_T;
  }

  setBlink(b: boolean): void {
    this.blinkOn = b;
    this.applyVisibility();
  }

  setVisible(b: boolean): void {
    this.baseVisible = b;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    if (!this.blinkOn) {
      this.group.visible = this.baseVisible;
      return;
    }
    // Invuln flicker: 8 Hz, half duty — ON while floor(clock·8) is even.
    this.group.visible = this.baseVisible && Math.floor(this.clock * 8) % 2 === 0;
  }

  update(dtS: number, _tS: number): void {
    const dt = dtS > 0 ? dtS : 0;
    this.clock += dt;

    // Eased control response → surfaces tilt (elevator pitch-in, rudder yaw,
    // aileron wash across the wing pair). §8: the ELEVATOR is the pitch
    // surface, so it now answers the climb axis (pitIn) on top of the
    // turn-coupled wash — climb input (pit > 0) deflects it trailing-edge up.
    const k = Math.min(1, dt * 8);
    this.turnEased += (this.turnTarget - this.turnEased) * k;
    this.pitEased += (this.pitTarget - this.pitEased) * k;
    const t = this.turnEased;
    this.elevator.rotation.z = -t * 0.35 - this.pitEased * 0.35;
    for (let i = 0; i < this.rudders.length; i++) this.rudders[i]!.rotation.y = -t * 0.55;
    if (this.wingTop) this.wingTop.rotation.x = t * 0.06;
    if (this.wingLow) this.wingLow.rotation.x = -t * 0.05;

    this.propSpin.rotation.x += this.propRate * dt;

    if (this.glow.visible) {
      const flick = 1 + 0.3 * Math.sin(this.clock * 27) * Math.sin(this.clock * 11);
      this.glow.scale.setScalar(flick);
    }
    this.applyVisibility();
  }

  /**
   * Detaches the airframe. Geometries/materials live in process-wide caches
   * (respawn churn reuses them), so dispose only drops scene ownership.
   */
  dispose(): void {
    this.group.parent?.remove(this.group);
  }
}

/** Build one deterministic airframe (no RNG anywhere in assembly). */
export function buildPlane(cls: PlaneClassId, team: TeamId): PlaneModel {
  const rig =
    cls === 'scout'
      ? buildScout(team)
      : cls === 'fighter'
        ? buildFighter(team)
        : buildGunship(team);
  // F3 shadow law: EVERY airframe mesh casts onto the sea — traverse-set once
  // at build so no part can silently opt out (wings, fins, guns, prop disc).
  rig.group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) mesh.castShadow = true;
  });
  return new PlaneModelImpl(rig);
}

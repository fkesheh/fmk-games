// ============================================================================
// ANCIENTS (rift) — UNIT RENDERING (CONTRACT §6 render/units.ts).
//
// This module builds NO geometry. Every hero, creep, summon, ward, projectile
// and jungle camp comes from the four mesh builders as a frozen `UnitBuild`
// (kit.ts), and this file's whole job is to MOUNT and DRIVE them:
//
//   archetype  ->  buildHero / buildCreep / buildCamp / buildProjectile,
//                  called ONCE per (kind, hero, team) and cached
//   mounting   ->  one InstancedMesh per baked bucket, plus one for the
//                  `AnimPart`, materials taken straight off the bake
//   driving    ->  procedural pose per entity per frame, written as instance
//                  matrices; HP bars, team markers, rings, order ping, ghosts
//
// WHY INSTANCED, AND NOT ONE GROUP PER UNIT. Bucket counts re-measured cold in
// a fresh headless process AFTER K_AMEND (AMENDMENT_4 §F — bucketing is now
// (surfaceId, tint, emissive), strictly finer than before, so pre-amendment
// figures do not carry): hero 6 (bullwark) / 7 (the other five), melee 5,
// ranged 5, siege 6, shade 6, ward 5, camp 4 (all three tiers), projectile 3
// (all three schools). At the §5 room — 3-lane, 8v8, camps populated — one
// cloned Group per entity is 454 body buckets + 34 anim parts before the
// shadow pass. One InstancedMesh per (archetype, bucket) makes the cost
// buckets x ARCHETYPES instead of buckets x ENTITIES, which is what BUILD_SPECS
// §0 means by "repeated archetypes are InstancedMesh per archetype", and it
// measures 275 accumulated draws at that same room (see the DRAW BUDGET note
// below). The whole procedural pose is a position/rotation/scale triple, so it
// composes into an instance matrix with nothing lost.
//
// DRAW BUDGET, MEASURED THROUGH `renderer.info` WITH THE SHADOW PASS ACCUMULATED
// (AMENDMENT_3 §D.5 — not counted from an array), at the §5 room, in a fresh
// process:
//
//   275  every archetype in frustum (camera framing the whole 128 m map)
//   193  the same frame with the shadow map disabled
//    82  therefore the shadow pass — which is EXACTLY the 12 hero archetypes'
//        82 body buckets (6 + 7 + 7 + 7 + 7 + 7 per team, twice), confirming
//        that heroes are the only §D.2 caster this module mounts and that no
//        anim part, bar, marker, ring, ghost or camp casts
//   168  the same census through the real camera rig — 55 deg pitch, FOV 50,
//        camH 26, mid-zoom inside game.ts's [18, 55] clamp — i.e. what a played
//        frame actually costs once the frustum culling below is doing its job.
//        The 275 is the archetype-count worst case and the number to hold
//        against the gate; this is the typical frame.
//
// The dominant term is hero ARCHETYPE COUNT x hero BUCKET COUNT: 82 scene + 82
// shadow = 164, 60% of the module. Neither factor is this file's — 12 archetypes
// is forced by an 8-seat team drawing from a 6-hero roster, and 6-7 buckets is
// R_MESH_HERO's bake — and mounting cannot go below SUM(archetypes x buckets),
// because two heroes that share a surface family still have different GEOMETRY
// and so cannot share one InstancedMesh. If the 700 gate needs more room from
// here, the lever is hero bucket count, exactly as AMENDMENT_3 §D.4 applied it
// to R_MESH_STRUCT. What this file does own is not paying for archetypes the
// camera cannot see: every instanced mount recomputes its bounding sphere from
// the live instance matrices in `flushOne` and is frustum-culled there (see
// that comment for why three.js cannot do this for us).
//
// PICKING SURVIVES INSTANCING. `SceneCore.registerPick` raycasts real objects
// and reads a numeric `userData.entId`, which an InstancedMesh cannot carry per
// instance. Every clickable entity therefore also owns an INVISIBLE box proxy
// sized to its own bar footprint: `visible = false` costs zero draw calls (the
// renderer drops it before it reaches a render list) and zero shadow, while the
// raycaster does not consult `visible` at all. Projectiles are the one
// exception — you do not click an arrow. `unregisterPick` on release is
// mandatory — a stale entry keeps a dead entity clickable and holds its
// geometry alive.
//
// STRUCTURES ARE NOT DRAWN HERE. `buildStructure` belongs to R_MAPMESH
// (BUILD_SPECS §R_MAPMESH: "Structures come from buildStructure(kind, team). Do
// not model them here any more."). What this module still owns for a structure
// is its HP bar and its pick proxy — a tower you cannot right-click is a tower
// you cannot order an attack on (`input.ts` `rightClick`). Both need
// `barH`/`barW`; see `structFitOf` for how those two numbers are obtained
// without drawing a second copy of the mesh, and `structPick`/`dropStructPick`
// for the proxy, which appears while the structure stands and is unregistered
// the moment it falls.
//
// PROCEDURAL WHOLE-MESH ANIMATION (transforms only, zero per-frame allocation,
// all scratch preallocated): idle breathing bob/sway phase-offset by a
// deterministic id seed; walk lean/bounce/waddle from smoothed interp velocity;
// an attack strike (melee lunge / ranged recoil); a 0.22 s easeOutBack spawn
// pop; and a collapse-and-fade ghost on death.
// ============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { APAL, TEAM_COLORS, heroById, isCampKind, isPlayerTeam } from '@rift/shared';
import type { EntKind, EntTeam, HeroId, MapDef, StructureKind, TeamId } from '@rift/shared';
import type { GhostEnt, InterpEnt, SceneHandle, UnitsHandle } from '../contract.js';
import { CAMERA_PITCH_DEG, applyShadowPolicy, cameraNormalY, cameraNormalZ } from './scene.js';
import { sceneCore, whiteVertexColors } from './core.js';
import type { SceneCore } from './core.js';
import { BLOOM_LAYER, markBloom, partMaterial, surface } from './kit.js';
import type { UnitBuild } from './kit.js';
import { buildHero } from './meshes/heroes.js';
import { buildCamp } from './meshes/camps.js';
import { buildCreep, buildProjectile } from './meshes/creeps.js';
import type { ProjSchool } from './meshes/creeps.js';
import { buildStructure } from './meshes/structures.js';

// ---- the swept volume of an animated carve-out ------------------------------
//
// THE DECISION, stated because the review asked for one either way: the swept
// volume is PUBLISHED FROM HERE as importable constants. It is NOT taken from
// `AnimPart` — that type is frozen by AMENDMENT_3 §B and widening it is not
// this module's to do, and the amplitude is a property of the DRIVER's motion,
// not of the part being driven.
//
// Why it needed publishing at all: `UnitBuild` says WHERE an `AnimPart` rests
// (`animY`) and HOW it moves (`animKind`), but never how far it travels, so
// every mesh module had to quote these numbers from `units.ts` prose and hope
// they stayed put. camps.ts filed exactly that as a CONTRACT_GAP and picked
// `spin` for the brute because it could not trust the bob amplitude.
//
// STATE OF ADOPTION, so this comment does not outrun the tree: as of this
// change the exports exist and nothing in `render/meshes/` imports them yet —
// camps.ts still quotes 0.55 m and +/-0.30 m in a comment at meshes/camps.ts:181.
// That is a mesh-module edit and those files are not mine. What is fixed here
// is that a quote can now be replaced by an import; until it is, these three
// values are the ones the shipped mesh geometry was measured against, and
// changing any of them changes the swept volume of every anim part in the game.
//
// Import them at CALL time (inside a function), never at module scope:
// `units.ts` imports the mesh modules, so a mesh module reading one during
// module evaluation would read it through a cycle and get `undefined`.

/** Radius in metres of the circle an `animKind: 'orbit'` part sweeps, centred
 *  on the unit's own axis at `animY`. */
export const ANIM_ORBIT_RADIUS_M = 0.55;
/** Peak vertical excursion in metres of an `animKind: 'bob'` part: it travels
 *  `animY - 0.3` to `animY + 0.3`. */
export const ANIM_BOB_AMPLITUDE_M = 0.3;
/** Peak uniform scale excursion of an `animKind: 'spin'` part. The part stays
 *  at `animY` EXACTLY — spin is the one kind that does not translate — and
 *  breathes between 0.78x and 1.22x. */
export const ANIM_SPIN_PULSE = 0.22;

// ---- pool sizes -------------------------------------------------------------
// Instance capacity per ARCHETYPE, not per kind, so eight of one hero on one
// team is the ceiling that matters for 'hero'. Over capacity an instance is
// dropped and the archetype warns once — a missing unit is bad, but growing an
// InstancedMesh mid-frame is a full buffer reallocation on the frame a teamfight
// starts.
const HERO_CAP = 10;
const LANE_CREEP_CAP = 96;
const HEAVY_CREEP_CAP = 48;
const WARD_CAP = 24;
const CAMP_CAP = 48;
const PROJ_CAP = 64;

/** Instanced HP-bar capacity — covers 8v8/3-lane peak (~120) with headroom. */
const BAR_CAP = 176;
/** Simultaneous death/vanish fades of one archetype. */
const GHOST_CAP = 24;

/** Wall-clock this module will spend building NEW archetypes inside one
 *  `sync()`. The budget gates whether a build is STARTED, so the true bound is
 *  "at most one archetype build per frame once the budget is spent" — a builder
 *  is not preemptible and pausing inside one is not this module's to do.
 *
 *  MEASURED COLD, in a fresh headless process with an empty `matCache` and no
 *  R_SCENE prewarm (AMENDMENT_3 §E.1): the 31 unit archetypes cost 0.1-40.4 ms
 *  each, 111.1 ms in total, and the six structure bar probes another 18.7 ms.
 *  The 40.4 ms is the FIRST call only — it is the shared surface-texture
 *  rasterisation that AMENDMENT_3 §E.3 hoists into `createScene`, and the same
 *  build costs 1.5 ms once that has been paid. Second-worst is 12.7 ms.
 *  Without this gate the first snapshot of a match builds all 31 back to back
 *  in one frame; with it they ramp in over ~6 frames (measured) and no frame
 *  starts a build once 6 ms of that frame have gone into building. */
const ARCH_BUILD_BUDGET_MS = 6;

// ---- procedural-animation tuning -------------------------------------------
/** Attack strike duration (s) — quick out-and-back, reads at 20Hz snap cadence. */
const ATK_DUR_S = 0.3;
/** Spawn scale-up pop duration (s). */
const SPAWN_POP_S = 0.22;
/** Speed (m/s) at which the walk cycle reaches full amplitude. */
const WALK_REF_SPEED = 4.5;

interface WalkStyle {
  readonly stride: number;
  readonly bounce: number;
  readonly lean: number;
  readonly roll: number;
}

/** Walk-cycle style per kind: stride = rad per metre, bounce/lean/roll
 *  amplitudes. Creeps waddle (roll-heavy, bouncy), heroes stride (lean-forward,
 *  low bounce), camp beasts lope — the brute heavy and slow, the hive skittery. */
const WALK_STYLE: Partial<Record<EntKind, WalkStyle>> = {
  melee: { stride: 2.6, bounce: 0.09, lean: 0.09, roll: 0.11 },
  ranged: { stride: 2.3, bounce: 0.08, lean: 0.07, roll: 0.06 },
  siege: { stride: 1.7, bounce: 0.06, lean: 0.05, roll: 0.08 },
  shade: { stride: 2.5, bounce: 0.09, lean: 0.11, roll: 0.08 },
  hero: { stride: 2.0, bounce: 0.05, lean: 0.15, roll: 0.03 },
  campPack: { stride: 3.1, bounce: 0.11, lean: 0.1, roll: 0.13 },
  campBrute: { stride: 1.4, bounce: 0.05, lean: 0.06, roll: 0.09 },
  campHive: { stride: 2.8, bounce: 0.12, lean: 0.08, roll: 0.05 },
};
const WALK_DEFAULT: WalkStyle = { stride: 2.2, bounce: 0.07, lean: 0.08, roll: 0.06 };

// ---- kind predicates --------------------------------------------------------

function isStructureKind(k: EntKind): k is StructureKind {
  return k === 'tower' || k === 'guard' || k === 'ancient';
}

/** Melee = the strike lunges toward the target; ranged recoils instead. Every
 *  camp beast fights in melee. */
function isMeleeKind(k: EntKind, hero: HeroId | undefined): boolean {
  if (k === 'melee' || k === 'siege' || k === 'shade') return true;
  if (isCampKind(k)) return true;
  if (k === 'hero') return heroById(hero ?? 'reaver').base.attackRange <= 3;
  return false;
}

/** `campPack` -> `'pack'`, and so on. `buildCamp` takes the bare tier, so the
 *  prefix is stripped here rather than in the builder — a caller that routes a
 *  camp kind to `buildCreep` instead gets a lane soldier standing in the
 *  jungle, which is the dispatch bug creeps.ts warns about by name. */
function campTierOf(k: EntKind): 'pack' | 'brute' | 'hive' | null {
  if (k === 'campPack') return 'pack';
  if (k === 'campBrute') return 'brute';
  if (k === 'campHive') return 'hive';
  return null;
}

function projSchoolOf(fx: string | undefined): ProjSchool {
  if (fx !== undefined) {
    const s = fx.toLowerCase();
    if (s.includes('physical') || s.includes('phys')) return 'phys';
    if (s.includes('heal')) return 'heal';
  }
  return 'magic';
}

/** Instance ceiling for an archetype of this kind. */
function capOf(k: EntKind): number {
  switch (k) {
    case 'hero':
      return HERO_CAP;
    case 'melee':
    case 'ranged':
      return LANE_CREEP_CAP;
    case 'siege':
    case 'shade':
      return HEAVY_CREEP_CAP;
    case 'ward':
      return WARD_CAP;
    case 'proj':
      return PROJ_CAP;
    default:
      return CAMP_CAP;
  }
}

/** The entity's own identity hex, and NEVER a team colour for a neutral.
 *  `TEAM_COLORS` is a two-element array indexed by `TeamId`; `isPlayerTeam` is
 *  the only sanctioned way in (shared/types.ts), and a raw `[2]` is an
 *  out-of-bounds read that appears the first time a camp spawns and never in a
 *  unit test. */
function teamHexOf(team: EntTeam): string {
  if (!isPlayerTeam(team)) return APAL.neutral;
  return TEAM_COLORS[team] ?? APAL.azure;
}

// ---- bar / marker constants -------------------------------------------------

const BAR_BG_H = 0.07; // world metres — high-aspect sliver, not a square
const BAR_FILL_H = 0.042;
const BAR_FILL_INSET = 0.06;
/** How far above the bar the team shape marker floats, in metres. */
const MARKER_LIFT = 0.22;

/** Bar fill colour classes. One InstancedMesh each, so every bar lands on an
 *  EXACT palette hex through `surface(id, tint)` — no per-instance colour
 *  multiply, and so no chance of the palette-hex-times-palette-hex product the
 *  vertex-colour law exists to prevent. At most three of the five are non-empty
 *  in any one frame; an empty one is hidden, not drawn. */
const FILL_SELF = 0;
const FILL_AZURE = 1;
const FILL_EMBER = 2;
const FILL_ENEMY = 3;
const FILL_NEUTRAL = 4;
const FILL_CLASSES = 5;
const FILL_TINTS: readonly string[] = [APAL.heal, APAL.azure, APAL.ember, APAL.danger, APAL.neutral];

/** Team shape marker classes — team reads by SHAPE, not hue alone. */
const MARK_AZURE = 0;
const MARK_EMBER = 1;
const MARK_NEUTRAL = 2;
const MARK_CLASSES = 3;
const MARK_TINTS: readonly string[] = [APAL.azureLit, APAL.emberLit, APAL.neutralLit];

function mergeAll(geos: readonly THREE.BufferGeometry[], what: string): THREE.BufferGeometry {
  const merged = mergeGeometries(geos as THREE.BufferGeometry[], false);
  if (merged === null) throw new Error(`rift units: ${what} geometry merge failed`);
  return merged;
}

/**
 * Write one greyscale value across a geometry's `color` attribute, in place.
 *
 * This is the fade channel for everything additive in this module. Under
 * `AdditiveBlending` the emitted colour IS the intensity, so scaling the vertex
 * colour toward black fades the object out — which is exactly what
 * `fxAdditive`'s surface note means by "PER-EFFECT FADE RIDES THE VERTEX
 * COLOUR, never `opacity`". The material is shared and cached; its `opacity` is
 * not a call-site dial.
 *
 * Greyscale is deliberate: the hue already came from `surface(id, tint)`, so
 * this multiplier is 1:1:1-shaped and no palette hex is ever multiplied by
 * another palette hex.
 *
 * Allocation-free — `Float32Array.fill` writes the existing buffer — so it is
 * safe to call from the frame hook. The attribute must already exist; every
 * caller here runs the geometry through `whiteVertexColors` first.
 */
function tintVertexColors(geo: THREE.BufferGeometry, v: number): THREE.BufferGeometry {
  const attr = geo.getAttribute('color');
  if (attr === undefined) return geo;
  const arr = attr.array;
  if (arr instanceof Float32Array) {
    arr.fill(v);
    attr.needsUpdate = true;
  }
  return geo;
}

// ---- per-archetype state ----------------------------------------------------

/** One mounted archetype: everything needed to draw any number of entities of
 *  one (kind, hero, team) for the price of its bucket count. */
interface Archetype {
  readonly key: string;
  readonly kind: EntKind;
  readonly team: EntTeam;
  readonly build: UnitBuild;
  /** One InstancedMesh per baked bucket, sharing that bucket's geometry and the
   *  material `bake()` built for it. */
  readonly buckets: readonly THREE.InstancedMesh[];
  /** The `AnimPart`, mounted through `partMaterial(surfaceId, tint, emissive)` —
   *  the one resolver — and bloom-marked iff the part says so. */
  readonly anim: THREE.InstancedMesh | null;
  readonly cap: number;
  /** Instances written this frame. */
  count: number;
  animCount: number;
  overflowWarned: boolean;
  /** Fading-silhouette mesh for this archetype's ghosts, built on first death. */
  ghost: THREE.InstancedMesh | null;
  ghostBuilt: boolean;
  ghostCount: number;
}

/** One live entity's render state. Every numeric field is scratch mutated in
 *  place — nothing here is re-created, which is what makes the pose pass
 *  allocation-free. */
interface UnitSlot {
  readonly arch: Archetype;
  id: number;
  kind: EntKind;
  team: EntTeam;
  /** Index into `activeList`; kept current by the swap-remove in `release`. */
  listIdx: number;
  /** Invisible raycast target carrying `userData.entId`; null for projectiles. */
  pick: THREE.Mesh | null;
  yaw: number;
  lastX: number;
  lastZ: number;
  phase: number;
  /** Latest sync position — the animation base the frame hook poses from. */
  px: number;
  pz: number;
  /** Previous frame's px/pz — the velocity probe. */
  hx: number;
  hz: number;
  /** Smoothed speed in world metres/sec (0 when idle). */
  speed: number;
  /** Walk-cycle accumulator (radians; advances with distance covered). */
  walkT: number;
  /** Clock time of the last attack swing trigger; <0 = never. */
  atkT: number;
  /** Normalised direction toward the attack target. */
  atkDx: number;
  atkDz: number;
  /** Last atk target id seen (transient-signal dedupe; -1 = none). */
  lastAtk: number;
  /** Clock time of the (re)spawn — drives the spawn pop. */
  spawnT: number;
  /** Melee = lunge toward the target; ranged = recoil. */
  melee: boolean;
  /** Footprint of the pick proxy, in metres. */
  pickW: number;
  pickH: number;
}

interface StructFit {
  readonly barH: number;
  readonly barW: number;
}

// ============================================================================
// createUnits
// ============================================================================

export function createUnits(scene: SceneHandle, map: MapDef): UnitsHandle {
  const core: SceneCore = sceneCore(scene);

  let clock = 0;
  /** Wall-clock left for building new archetypes in the current `sync()`. */
  let buildBudgetMs = ARCH_BUILD_BUDGET_MS;

  // ---- archetypes -----------------------------------------------------------
  const archetypes = new Map<string, Archetype>();
  const archList: Archetype[] = [];

  function archKey(k: EntKind, hero: HeroId | undefined, team: EntTeam, school: ProjSchool): string {
    if (k === 'hero') return `hero:${hero ?? 'reaver'}:${String(team)}`;
    const tier = campTierOf(k);
    if (tier !== null) return `camp:${tier}`;
    if (k === 'proj') return `proj:${school}:${String(team)}`;
    return `creep:${k}:${String(team)}`;
  }

  function buildFor(
    k: EntKind,
    hero: HeroId | undefined,
    team: EntTeam,
    school: ProjSchool,
  ): UnitBuild {
    if (k === 'hero') return buildHero(hero ?? 'reaver', team);
    const tier = campTierOf(k);
    if (tier !== null) return buildCamp(tier);
    if (k === 'proj') return buildProjectile(team, school);
    return buildCreep(k, team);
  }

  /** Mount a `UnitBuild`: one InstancedMesh per baked bucket plus one for the
   *  anim part. Everything is read off `body.group.children`, which is where
   *  `bake()` put the material AND where the mesh module's `markBloom` landed —
   *  reading `body.parts` instead would silently drop the bloom flag. The group
   *  itself is never added to the scene; only these instanced mounts are. */
  function mount(key: string, k: EntKind, team: EntTeam, build: UnitBuild): Archetype {
    const cap = capOf(k);
    const buckets: THREE.InstancedMesh[] = [];
    for (const child of build.body.group.children) {
      if (!(child instanceof THREE.Mesh) || Array.isArray(child.material)) continue;
      const im = new THREE.InstancedMesh(child.geometry, child.material, cap);
      im.name = `rift:units:${key}`;
      im.count = 0;
      im.visible = false;
      // Culling stays OFF until the first `flushOne` has given this mount a
      // bounding sphere built from real instance matrices; see `flushOne`.
      im.frustumCulled = false;
      im.receiveShadow = true;
      if (child.layers.isEnabled(BLOOM_LAYER)) markBloom(im);
      buckets.push(im);
    }
    // AMENDMENT_3 §D.2: shadow casters are a whitelist. Of everything this
    // module mounts only heroes cast — lane creeps, summons, wards, camps,
    // projectiles and every anim part do not, and the meter counts the shadow
    // pass, so each caster is a draw call spent twice.
    const cls = k === 'hero' ? 'hero' : null;
    for (const im of buckets) {
      applyShadowPolicy(im, cls);
      core.three.add(im);
    }

    let animMesh: THREE.InstancedMesh | null = null;
    const anim = build.anim;
    if (anim !== null) {
      // The anim geometry never passes through `bake()`, so the vertex-colour
      // law is the mesh module's to satisfy (the `AnimPart` doc says so). This
      // call is idempotent by design — a geometry already carrying a correct
      // `color` attribute is returned untouched — so it costs nothing when the
      // module did its job and saves a black mesh when it did not.
      //
      // UV SCALING IS ACCEPTED AS THE MODULE BUILT IT, deliberately. The kit
      // assigns anim-part UV layout to the mesh module ("build it with
      // PartOpts.uvLocal; if it needs the world-space density instead, scale
      // the UVs in the module"), and every shipped anim part is a sub-0.2 m
      // primitive whose own normalised layout is the intended one. Reprojecting
      // here would overrule a decision that is not this module's, on geometry
      // whose author already measured it.
      whiteVertexColors(anim.geo);
      // THE ONE RESOLVER (AMENDMENT_4 §D). No surface-vs-emissive branch here,
      // and no material chosen by animation kind — choosing by `animKind` is
      // what put the ancient heart's material on the ward eye.
      const animMat = partMaterial(anim.surfaceId, anim.tint, anim.emissive);
      animMesh = new THREE.InstancedMesh(anim.geo, animMat, cap);
      animMesh.name = `rift:units:${key}:anim`;
      animMesh.count = 0;
      animMesh.visible = false;
      animMesh.frustumCulled = false; // see `flushOne`
      animMesh.receiveShadow = true;
      // Not derived from `emissive`: gold blooms without one, and a dim
      // emissive filler may deliberately stay out of the pass. The part decides.
      if (anim.bloom) markBloom(animMesh);
      applyShadowPolicy(animMesh, null);
      core.three.add(animMesh);
    }

    const a: Archetype = {
      key,
      kind: k,
      team,
      build,
      buckets,
      anim: animMesh,
      cap,
      count: 0,
      animCount: 0,
      overflowWarned: false,
      ghost: null,
      ghostBuilt: false,
      ghostCount: 0,
    };
    archetypes.set(key, a);
    archList.push(a);
    return a;
  }

  let buildFailWarned = false;

  /** The archetype for one entity, built on demand inside this frame's build
   *  budget. Returns null when the budget is spent — the entity simply is not
   *  drawn this frame and is picked up on a later one, which is a one-to-three
   *  frame ramp-in at match start instead of one multi-hundred-millisecond
   *  freeze. */
  function archetypeFor(e: InterpEnt, school: ProjSchool): Archetype | null {
    const key = archKey(e.k, e.hero, e.team, school);
    const hit = archetypes.get(key);
    if (hit !== undefined) return hit;
    if (buildBudgetMs <= 0) return null;
    const t0 = performance.now();
    try {
      const build = buildFor(e.k, e.hero, e.team, school);
      return mount(key, e.k, e.team, build);
    } catch (err) {
      if (!buildFailWarned) {
        buildFailWarned = true;
        console.error(`rift units: archetype '${key}' failed to build — it will not be drawn`, err);
      }
      return null;
    } finally {
      buildBudgetMs -= performance.now() - t0;
    }
  }

  // ---- structure bar + pick fit ---------------------------------------------
  //
  // A structure's mesh is R_MAPMESH's, but its HP BAR and its PICK PROXY are
  // this module's, and both need `barH`/`barW` off the SAME build R_MAPMESH
  // draws. They are read by calling `buildStructure` once per kind and disposing
  // the geometry it returns: two numbers that cannot drift from the mesh,
  // against one transient build. `barH` is team-independent — structures.ts
  // derives it as `top + BAR_CLEAR` from geometry whose only per-team variation
  // is tint — and re-measured cold on both teams it is 9.7900 / 9.4754 /
  // 14.3060 m with `barW` 2.40 / 2.60 / 3.40 m for tower / guard / ancient, the
  // same on team 0 and team 1. So this is three builds, not six. Materials are
  // cached and shared with R_MAPMESH's own build; only the transient vertex
  // buffers are freed.
  //
  // The pick proxy matters as much as the bar: `input.ts` right-click-attacks
  // and left-click-selects whatever `SceneHandle.pickUnit` returns, so with no
  // proxy a tower is not attackable by mouse at all. `BAR_CLEAR` is 0.38 m, so
  // a box of height `barH` stands exactly 0.38 m proud of the structure's top —
  // a click target very slightly larger than the building, which is the right
  // direction for a click target to err in.
  const structFit = new Map<StructureKind, StructFit>();
  const structKindsInMap = new Set<StructureKind>();
  for (const s of map.structures) structKindsInMap.add(s.kind);
  let structProbeWarned = false;

  function structFitOf(k: StructureKind): StructFit | null {
    const hit = structFit.get(k);
    if (hit !== undefined) return hit;
    if (!structKindsInMap.has(k)) return null;
    if (buildBudgetMs <= 0) return null;
    const t0 = performance.now();
    try {
      const b = buildStructure(k, 0);
      const fit: StructFit = { barH: b.barH, barW: b.barW };
      for (const p of b.body.parts) p.geo.dispose();
      if (b.anim !== null) b.anim.geo.dispose();
      structFit.set(k, fit);
      return fit;
    } catch (err) {
      if (!structProbeWarned) {
        structProbeWarned = true;
        console.error(`rift units: could not measure the '${k}' HP bar — it will not be drawn`, err);
      }
      return null;
    } finally {
      buildBudgetMs -= performance.now() - t0;
    }
  }

  /** Live pick proxies for standing structures, keyed by entity id. Bounded by
   *  `map.structures.length` — a structure is sent to every client every tick
   *  (`shared/types.ts`: "Structures are sent to every client every tick"), so
   *  an entry leaves this map exactly one way, by the structure being
   *  destroyed. There is no vanish path to sweep. */
  const structPicks = new Map<number, THREE.Mesh>();

  /** Give a standing structure a raycast target. Structures do not move, so the
   *  transform is written once, at creation. */
  function structPick(e: InterpEnt, fit: StructFit): void {
    if (structPicks.has(e.id)) return;
    const m = takePick(e.id);
    m.position.set(e.x, core.heightAt(e.x, e.z), e.z);
    m.scale.set(fit.barW, fit.barH, fit.barW);
    structPicks.set(e.id, m);
  }

  function dropStructPick(id: number): void {
    const m = structPicks.get(id);
    if (m === undefined) return;
    structPicks.delete(id);
    dropPick(m);
  }

  // ---- slots ----------------------------------------------------------------
  const active = new Map<number, UnitSlot>();
  const activeList: UnitSlot[] = [];
  const freeByKey = new Map<string, UnitSlot[]>();
  const seen = new Set<number>();

  // Pick proxies. An invisible unit box: `visible = false` keeps it out of every
  // render list and out of the shadow pass, while the raycaster — which does not
  // consult `visible` — still hits it. The material is a cached kit surface
  // rather than three's implicit `MeshBasicMaterial` default, which the material
  // law bans outright; it is never rasterised.
  const pickGeo = whiteVertexColors(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
  const pickMat = surface('cliffRock');
  const pickFree: THREE.Mesh[] = [];

  function takePick(entId: number): THREE.Mesh {
    const reused = pickFree.pop();
    const m = reused ?? new THREE.Mesh(pickGeo, pickMat);
    if (reused === undefined) {
      m.visible = false;
      m.castShadow = false;
      m.receiveShadow = false;
      m.name = 'rift:units:pick';
      core.three.add(m);
    }
    m.userData['entId'] = entId;
    core.registerPick(m);
    return m;
  }

  function dropPick(m: THREE.Mesh): void {
    // MANDATORY on despawn: a stale pick entry keeps a dead entity clickable
    // and holds a reference that outlives the entity.
    core.unregisterPick(m);
    m.userData['entId'] = -1;
    pickFree.push(m);
  }

  function newSlot(e: InterpEnt, arch: Archetype): UnitSlot {
    return {
      arch,
      id: e.id,
      kind: e.k,
      team: e.team,
      listIdx: -1,
      pick: null,
      yaw: 0,
      lastX: e.x,
      lastZ: e.z,
      phase: (e.id % 97) * 0.651, // deterministic spread, no rng needed
      px: e.x,
      pz: e.z,
      hx: e.x,
      hz: e.z,
      speed: 0,
      walkT: 0,
      atkT: -1,
      atkDx: 0,
      atkDz: 1,
      lastAtk: -1,
      spawnT: 0,
      melee: false,
      pickW: 1,
      pickH: 1,
    };
  }

  function acquire(e: InterpEnt, arch: Archetype): UnitSlot {
    const existing = active.get(e.id);
    if (existing !== undefined) return existing;
    const pooled = freeByKey.get(arch.key)?.pop();
    const slot = pooled ?? newSlot(e, arch);

    slot.id = e.id;
    slot.kind = e.k;
    slot.team = e.team;
    slot.melee = isMeleeKind(e.k, e.hero);
    slot.speed = 0;
    slot.walkT = 0;
    slot.atkT = -1;
    slot.lastAtk = -1;
    slot.px = e.x;
    slot.pz = e.z;
    slot.hx = e.x;
    slot.hz = e.z;
    slot.lastX = e.x;
    slot.lastZ = e.z;
    slot.yaw = 0;
    slot.spawnT = clock; // the spawn pop starts now
    // A ward and a projectile report barH/barW 0; the ward still needs a
    // clickable footprint (you dust wards), a projectile does not.
    slot.pickW = arch.build.barW > 0 ? arch.build.barW : 0.6;
    slot.pickH = arch.build.barH > 0 ? arch.build.barH : 1.4;
    if (e.k !== 'proj') {
      if (slot.pick === null) slot.pick = takePick(e.id);
      else slot.pick.userData['entId'] = e.id;
    }

    slot.listIdx = activeList.length;
    activeList.push(slot);
    active.set(e.id, slot);
    return slot;
  }

  function release(slot: UnitSlot): void {
    active.delete(slot.id);
    const last = activeList[activeList.length - 1];
    if (last !== undefined && slot.listIdx >= 0) {
      activeList[slot.listIdx] = last;
      last.listIdx = slot.listIdx;
      activeList.pop();
    }
    slot.listIdx = -1;
    if (slot.pick !== null) {
      dropPick(slot.pick);
      slot.pick = null;
    }
    // Remember which archetype this id wore so its ghost fades the right
    // silhouette. `GhostEnt` carries no `hero`, so without this a dead hero
    // could only ever be ghosted as an arbitrary stand-in.
    rememberGhostArch(slot.id, slot.arch);
    let list = freeByKey.get(slot.arch.key);
    if (list === undefined) {
      list = [];
      freeByKey.set(slot.arch.key, list);
    }
    list.push(slot);
  }

  // ---- ghosts ---------------------------------------------------------------
  //
  // A ghost is the unit's own silhouette, additive, fading to nothing. The fade
  // rides the INSTANCE COLOUR, never `opacity`: `fxAdditive` is a shared cached
  // material and mutating its opacity at a call site is banned, while under
  // additive blending a colour scaled toward black IS the fade. The material is
  // `surface('fxAdditive', teamHex)`, so the instance colour stays a pure
  // greyscale multiplier and no palette hex multiplies another.
  const ghostArchById = new Map<number, Archetype>();
  const ghostSeen = new Set<number>();
  /** How long a released id keeps its silhouette memory. Ghosts fade over
   *  0.5 s; 2 s covers snapshot jitter without letting the memory grow. */
  const GHOST_MEMORY_S = 2;
  /** The expiry side of that memory, held as PARALLEL DENSE ARRAYS rather than
   *  a second Map, purely so the per-frame sweep can be allocation-free.
   *  `for (const id of map.keys())` mints a fresh iterator object on every
   *  `sync()`, and `sync()` runs every frame over every visible entity — the
   *  one thing this module's spec bans by name. An index loop over a
   *  preallocated typed array mints nothing. `ghostArchById` stays a Map
   *  because it is only ever `get`/`set`/`delete`, none of which iterate.
   *
   *  Capacity is the ceiling on ids that died inside `GHOST_MEMORY_S`; a 3-lane
   *  8v8 wave wipe is ~40. When it is full, new memories are dropped rather
   *  than evicting a live one — a missing silhouette for one death is a smaller
   *  defect than an unbounded array in a frame path. */
  const GHOST_MEM_CAP = 256;
  const ghostMemIds = new Int32Array(GHOST_MEM_CAP);
  const ghostMemAt = new Float32Array(GHOST_MEM_CAP);
  let ghostMemN = 0;

  /** Record (or refresh) the archetype an id wore when it left the world.
   *  Called from `release`, i.e. on despawn — never per frame — so the linear
   *  scan for an existing entry is bounded by `ghostMemN` and costs nothing. */
  function rememberGhostArch(id: number, arch: Archetype): void {
    ghostArchById.set(id, arch);
    for (let i = 0; i < ghostMemN; i++) {
      if (ghostMemIds[i] === id) {
        ghostMemAt[i] = clock;
        return;
      }
    }
    if (ghostMemN >= GHOST_MEM_CAP) return;
    ghostMemIds[ghostMemN] = id;
    ghostMemAt[ghostMemN] = clock;
    ghostMemN += 1;
  }
  /** Peak additive brightness of a ghost, carrying over the 0.55 opacity the
   *  ghost fade used before the material law. */
  const GHOST_PEAK = 0.55;

  function ghostMeshOf(a: Archetype): THREE.InstancedMesh | null {
    if (a.ghostBuilt) return a.ghost;
    a.ghostBuilt = true;
    const geos: THREE.BufferGeometry[] = [];
    for (const p of a.build.body.parts) geos.push(p.geo.clone());
    const first = geos[0];
    if (first === undefined) return null;
    try {
      const silhouette = geos.length === 1 ? first : mergeAll(geos, `ghost ${a.key}`);
      const im = new THREE.InstancedMesh(
        silhouette,
        surface('fxAdditive', teamHexOf(a.team)),
        GHOST_CAP,
      );
      im.name = `rift:units:${a.key}:ghost`;
      im.count = 0;
      im.visible = false;
      im.frustumCulled = false;
      im.renderOrder = 20;
      applyShadowPolicy(im, null);
      core.three.add(im);
      a.ghost = im;
      return im;
    } catch (err) {
      console.error(`rift units: ghost silhouette for '${a.key}' failed`, err);
      return null;
    }
  }

  // ---- HP bars: one background + five colour classes -------------------------
  // Slim WIDE rectangles facing the camera: the tilt MUST live in the instance
  // quaternion (compose applies scale first, then rotation) — baking the tilt
  // into the geometry puts the thin axis along world-z and the bar renders as a
  // fat square.
  const barTilt = THREE.MathUtils.degToRad(-(180 - CAMERA_PITCH_DEG));
  const barQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(barTilt, 0, 0));
  const barBg = new THREE.InstancedMesh(
    whiteVertexColors(new THREE.PlaneGeometry(1, 1)),
    surface('fxDecal', APAL.inkDeep),
    BAR_CAP,
  );
  barBg.frustumCulled = false;
  barBg.renderOrder = 40;
  barBg.count = 0;
  barBg.visible = false;
  applyShadowPolicy(barBg, null);
  core.three.add(barBg);

  const barFills: THREE.InstancedMesh[] = [];
  const barFillCounts = new Int32Array(FILL_CLASSES);
  for (let c = 0; c < FILL_CLASSES; c++) {
    const im = new THREE.InstancedMesh(
      whiteVertexColors(new THREE.PlaneGeometry(1, 1)),
      surface('fxDecal', FILL_TINTS[c] ?? APAL.paper),
      BAR_CAP,
    );
    im.frustumCulled = false;
    im.renderOrder = 41;
    im.count = 0;
    im.visible = false;
    applyShadowPolicy(im, null);
    core.three.add(im);
    barFills.push(im);
  }

  // camera-facing nudge so fills sit proud of backgrounds. The normal comes off
  // the camera rig itself rather than being re-derived from the pitch.
  const nY = cameraNormalY() * 0.03;
  const nZ = cameraNormalZ() * 0.03;

  // ---- team SHAPE markers ----------------------------------------------------
  // Team reads by shape, not hue alone: azure = open upward chevron, ember =
  // solid pennant triangle, neutral = a diamond in the venom ladder. Three
  // InstancedMesh, one per identity, so a camp can never wear a team colour.
  const chevronGeo = ((): THREE.BufferGeometry => {
    const left = new THREE.BoxGeometry(0.2, 0.055, 0.05).rotateZ(0.72).translate(-0.085, 0, 0);
    const right = new THREE.BoxGeometry(0.2, 0.055, 0.05).rotateZ(-0.72).translate(0.085, 0, 0);
    const g = mergeAll([left, right], 'chevron');
    g.rotateX(barTilt);
    return whiteVertexColors(g);
  })();
  const pennantGeo = ((): THREE.BufferGeometry => {
    const s = new THREE.Shape();
    s.moveTo(-0.11, 0.11);
    s.lineTo(-0.11, -0.11);
    s.lineTo(0.16, 0);
    s.closePath();
    const g = new THREE.ShapeGeometry(s);
    g.rotateX(barTilt);
    return whiteVertexColors(g);
  })();
  const diamondGeo = ((): THREE.BufferGeometry => {
    const s = new THREE.Shape();
    s.moveTo(0, 0.13);
    s.lineTo(0.11, 0);
    s.lineTo(0, -0.13);
    s.lineTo(-0.11, 0);
    s.closePath();
    const g = new THREE.ShapeGeometry(s);
    g.rotateX(barTilt);
    return whiteVertexColors(g);
  })();
  const markGeos: readonly THREE.BufferGeometry[] = [chevronGeo, pennantGeo, diamondGeo];
  const markMeshes: THREE.InstancedMesh[] = [];
  const markCounts = new Int32Array(MARK_CLASSES);
  for (let c = 0; c < MARK_CLASSES; c++) {
    const geo = markGeos[c];
    if (geo === undefined) continue;
    const im = new THREE.InstancedMesh(geo, surface('fxAdditive', MARK_TINTS[c] ?? APAL.paper), BAR_CAP);
    im.frustumCulled = false;
    im.renderOrder = 42;
    im.count = 0;
    im.visible = false;
    applyShadowPolicy(im, null);
    core.three.add(im);
    markMeshes.push(im);
  }

  // ---- rings + order marker --------------------------------------------------
  // All three are additive: they must burn through dusk lighting at gameplay
  // zoom, and additive output can only brighten what is already in the frame, so
  // none of them can occlude a unit standing on one. Under additive the vertex
  // colour IS the intensity, which is where the old materials' `opacity` went —
  // a cached material's opacity is not a call-site dial.
  const selRing = new THREE.Mesh(
    tintVertexColors(
      whiteVertexColors(new THREE.RingGeometry(0.85, 1.05, 28).rotateX(-Math.PI / 2)),
      0.9,
    ),
    surface('fxAdditive', APAL.gold),
  );
  selRing.visible = false;
  selRing.renderOrder = 18;
  applyShadowPolicy(selRing, null);
  core.three.add(selRing);
  let selectedId = -1;

  const selfRing = new THREE.Mesh(
    tintVertexColors(
      whiteVertexColors(new THREE.RingGeometry(0.62, 0.78, 24).rotateX(-Math.PI / 2)),
      0.55,
    ),
    surface('fxAdditive', APAL.heal),
  );
  selfRing.visible = false;
  selfRing.renderOrder = 18;
  applyShadowPolicy(selfRing, null);
  core.three.add(selfRing);

  // An unmistakable ping: a bright centre flash plus two staggered expanding
  // rings. APAL gold = move, danger = attack — swapped by re-pointing the mesh
  // at the OTHER cached material, never by mutating one.
  const markerMoveMat = surface('fxAdditive', APAL.gold);
  const markerAttackMat = surface('fxAdditive', APAL.danger);
  const marker = new THREE.Group();
  const markerRing = new THREE.Mesh(
    whiteVertexColors(new THREE.RingGeometry(0.5, 0.64, 28).rotateX(-Math.PI / 2)),
    markerMoveMat,
  );
  const markerRing2 = new THREE.Mesh(
    whiteVertexColors(new THREE.RingGeometry(0.5, 0.58, 28).rotateX(-Math.PI / 2)),
    markerMoveMat,
  );
  markerRing2.position.y = 0.004;
  const markerDot = new THREE.Mesh(
    whiteVertexColors(new THREE.CircleGeometry(0.2, 16).rotateX(-Math.PI / 2)),
    markerMoveMat,
  );
  markerDot.position.y = 0.008;
  marker.add(markerRing);
  marker.add(markerRing2);
  marker.add(markerDot);
  marker.visible = false;
  applyShadowPolicy(marker, null);
  core.three.add(marker);
  let markerAge = 1e9;
  const MARKER_LIFE_S = 0.65;

  // ---- scratch (allocated once; the pose pass never allocates) ---------------
  const mScratch = new THREE.Matrix4();
  const vPos = new THREE.Vector3();
  const vScale = new THREE.Vector3();
  const qScratch = new THREE.Quaternion();
  const eScratch = new THREE.Euler();
  const cScratch = new THREE.Color();
  const barXs = new Float32Array(BAR_CAP);
  const barYs = new Float32Array(BAR_CAP);
  const barZs = new Float32Array(BAR_CAP);
  const barWs = new Float32Array(BAR_CAP);
  const barFracs = new Float32Array(BAR_CAP);
  const barFillClass = new Int8Array(BAR_CAP);
  const barMarkClass = new Int8Array(BAR_CAP);
  let barCount = 0;

  // ---- the frame hook -------------------------------------------------------
  let hookFailWarned = false;
  core.addFrameHook((dtMs: number) => {
    // GUARD MY OWN ENTRY POINT (core.ts, AMENDMENT_3 §G.2). A throwing hook
    // takes the whole frame down with it, and the pose pass touches pooled
    // state fed by three different producers.
    try {
      step(dtMs);
    } catch (err) {
      if (!hookFailWarned) {
        hookFailWarned = true;
        console.error('rift units: frame hook failed — units will stop animating', err);
      }
    }
  });

  function step(dtMs: number): void {
    const dt = dtMs / 1000;
    clock += dt;

    for (let i = 0; i < archList.length; i++) {
      const a = archList[i];
      if (a !== undefined) {
        a.count = 0;
        a.animCount = 0;
      }
    }
    for (let i = 0; i < activeList.length; i++) {
      const slot = activeList[i];
      if (slot !== undefined) pose(slot, dt);
    }
    for (let i = 0; i < archList.length; i++) {
      const a = archList[i];
      if (a === undefined) continue;
      for (let b = 0; b < a.buckets.length; b++) {
        const im = a.buckets[b];
        if (im !== undefined) flushOne(im, a.count);
      }
      if (a.anim !== null) flushOne(a.anim, a.animCount);
    }

    tickMarker(dt);
    if (selRing.visible) {
      const s = 1 + 0.05 * Math.sin(clock * 3);
      selRing.scale.set(s, 1, s);
    }
  }

  /** Pose one entity and write its instance matrices. */
  function pose(slot: UnitSlot, dt: number): void {
    const a = slot.arch;
    const gy = core.heightAt(slot.px, slot.pz);

    if (slot.kind === 'proj') {
      // A projectile has no gait, no pop and no strike: it is a dart in flight
      // at a fixed carry height over whatever ground it is crossing.
      if (a.count < a.cap) {
        eScratch.set(0, slot.yaw, 0, 'XYZ');
        qScratch.setFromEuler(eScratch);
        mScratch.compose(vPos.set(slot.px, gy + 1.1, slot.pz), qScratch, vScale.set(1, 1, 1));
        writeInstance(a, mScratch);
      }
      return;
    }

    // spawn pop: easeOutBack scale-up, then a hard 1
    const spawnAge = clock - slot.spawnT;
    let pop = 1;
    if (spawnAge < SPAWN_POP_S) {
      const u = spawnAge / SPAWN_POP_S - 1;
      pop = 1 + 2.6 * u * u * u + 1.6 * u * u;
    }

    // attack strike envelope: fast out-and-back (sin hump), shared by the melee
    // lunge and the ranged recoil
    const atkAge = clock - slot.atkT;
    let env = 0;
    if (slot.atkT >= 0 && atkAge < ATK_DUR_S) env = Math.sin((Math.PI * atkAge) / ATK_DUR_S);

    let bodyY = gy;
    let offX = 0;
    let offZ = 0;
    let pitch = 0;
    let roll = 0;

    if (slot.kind === 'ward') {
      // A placard does not walk, breathe or strike — the spinning eye carries
      // its whole life.
      slot.speed = 0;
    } else {
      // velocity probe: interp position delta since the last frame, smoothed
      // (teleports/reappears clamp out via the 12 m/s cap)
      const dx = slot.px - slot.hx;
      const dz = slot.pz - slot.hz;
      slot.hx = slot.px;
      slot.hz = slot.pz;
      if (dt > 0) {
        const inst = Math.min(12, Math.sqrt(dx * dx + dz * dz) / dt);
        slot.speed += (inst - slot.speed) * Math.min(1, dt * 8);
      }
      const walkAmt = Math.min(1, slot.speed / WALK_REF_SPEED);
      const style = WALK_STYLE[slot.kind] ?? WALK_DEFAULT;
      slot.walkT += dt * slot.speed * style.stride;
      const bounce = Math.abs(Math.sin(slot.walkT)) * style.bounce * walkAmt;
      pitch = style.lean * walkAmt;
      roll = Math.sin(slot.walkT) * style.roll * walkAmt;
      // idle: breathing bob + gentle sway, phase-offset per unit, fading out as
      // the walk cycle takes over (never both at full strength)
      const idleAmt = 1 - walkAmt;
      const bob = Math.sin(clock * 1.7 + slot.phase) * 0.035 * idleAmt;
      roll += Math.sin(clock * 1.15 + slot.phase * 1.7) * 0.025 * idleAmt;
      bodyY = gy + bob + bounce;

      // attack: melee lunges toward the target and dips forward; ranged kicks
      // back away from it. Models face +z, so +rotation.x is a forward tilt.
      if (env > 0) {
        if (slot.melee) {
          offX = slot.atkDx * env * 0.34;
          offZ = slot.atkDz * env * 0.34;
          pitch += env * 0.22;
        } else {
          offX = -slot.atkDx * env * 0.18;
          offZ = -slot.atkDz * env * 0.18;
          pitch -= env * 0.14;
        }
      }
    }

    if (a.count < a.cap) {
      eScratch.set(pitch, slot.yaw, roll, 'XYZ');
      qScratch.setFromEuler(eScratch);
      mScratch.compose(
        vPos.set(slot.px + offX, bodyY, slot.pz + offZ),
        qScratch,
        vScale.set(pop, pop, pop),
      );
      writeInstance(a, mScratch);
    } else if (!a.overflowWarned) {
      a.overflowWarned = true;
      console.warn(`rift units: archetype '${a.key}' exceeded its ${a.cap} instance cap`);
    }

    // The animated carve-out. It rides the unit's ground position but never its
    // yaw or its gait — an orbiting mote that leaned with the walk would read as
    // bolted to a shoulder rather than floating free.
    const animMesh = a.anim;
    const animKind = a.build.animKind;
    if (animMesh !== null && animKind !== null && a.animCount < a.cap) {
      const baseY = gy + a.build.animY;
      let s = 1;
      let ax = slot.px;
      let ay = baseY;
      let az = slot.pz;
      let spin: number;
      if (animKind === 'orbit') {
        const ang = clock * 0.7 + slot.phase;
        ax = slot.px + Math.cos(ang) * ANIM_ORBIT_RADIUS_M;
        az = slot.pz + Math.sin(ang) * ANIM_ORBIT_RADIUS_M;
        spin = ang * 2;
      } else if (animKind === 'bob') {
        ay = baseY + Math.sin(clock * 1.1 + slot.phase) * ANIM_BOB_AMPLITUDE_M;
        spin = clock * 0.5 + slot.phase;
      } else {
        // 'spin' — the one kind that leaves the part at animY EXACTLY, which is
        // what camps.ts's brute heart and creeps.ts's ward eye are measured
        // against. It turns in place and breathes.
        spin = clock * 1.6 + slot.phase;
        s = 1 + ANIM_SPIN_PULSE * Math.sin(clock * 2.4 + slot.phase);
      }
      eScratch.set(0, spin, 0, 'XYZ');
      qScratch.setFromEuler(eScratch);
      mScratch.compose(vPos.set(ax, ay, az), qScratch, vScale.set(s, s, s));
      animMesh.setMatrixAt(a.animCount, mScratch);
      a.animCount += 1;
    }

    const pick = slot.pick;
    if (pick !== null) {
      pick.position.set(slot.px, gy, slot.pz);
      pick.scale.set(slot.pickW, slot.pickH, slot.pickW);
    }
  }

  function writeInstance(a: Archetype, m: THREE.Matrix4): void {
    const i = a.count;
    for (let b = 0; b < a.buckets.length; b++) {
      const im = a.buckets[b];
      if (im !== undefined) im.setMatrixAt(i, m);
    }
    a.count = i + 1;
  }

  /** Publish an instanced mesh's live instance count, and give it a bounding
   *  sphere that matches the instances actually in it.
   *
   *  TWO draw-meter savings, and the second is why this function exists rather
   *  than three lines at each call site.
   *
   *  1. A mesh with nothing to draw is HIDDEN, not left visible with
   *     `count = 0`: three issues the instanced draw call for a zero-instance
   *     visible mesh and the meter charges for it.
   *
   *  2. FRUSTUM CULLING, which three cannot do for an InstancedMesh on its own.
   *     `Frustum.intersectsObject` uses `object.boundingSphere` and only calls
   *     `computeBoundingSphere()` when that sphere is `null` — i.e. exactly
   *     once, off whatever matrices happened to be written at the time — and
   *     from then on it culls against a sphere that no longer describes where
   *     the instances are. That is why every mount below is created with
   *     `frustumCulled = false`: with a stale sphere, culling is not an
   *     optimisation, it is units vanishing. Recomputing here — after the
   *     matrices for this frame are written and `count` is set, and before the
   *     frame pass draws — makes the sphere current, so the flag can be turned
   *     on and an archetype the camera cannot see stops costing a draw call in
   *     both the scene pass and the shadow pass.
   *
   *  `computeBoundingSphere()` honours `this.count` and every instance matrix,
   *  and after the first call (which allocates the one `Sphere`) it works
   *  entirely in three's module-scope scratch — so this is allocation-free in
   *  the steady state and legal in a frame hook. Cost is O(count): one matrix
   *  read and one sphere union per instance, against a pose loop that already
   *  composes a matrix per instance. */
  function flushOne(im: THREE.InstancedMesh, count: number): void {
    if (count > 0) {
      im.count = count;
      im.visible = true;
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.frustumCulled = true;
    } else if (im.visible) {
      im.count = 0;
      im.visible = false;
    }
  }

  function tickMarker(dt: number): void {
    if (!marker.visible) return;
    markerAge += dt;
    const t = markerAge / MARKER_LIFE_S;
    if (t >= 1) {
      marker.visible = false;
      return;
    }
    const fade = Math.pow(1 - t, 1.3);
    const s1 = 0.4 + t * 3.2;
    markerRing.scale.set(s1, 1, s1);
    tintVertexColors(markerRing.geometry, 0.95 * fade);
    // second ring chases the first, 18% delayed
    const t2 = Math.max(0, (t - 0.18) / 0.82);
    const s2 = 0.35 + t2 * 2.6;
    markerRing2.scale.set(s2, 1, s2);
    tintVertexColors(markerRing2.geometry, 0.8 * Math.pow(1 - t2, 1.4));
    // centre flash: pops bright, gone by a third of the life
    const td = Math.min(1, markerAge / 0.22);
    const sd = 1.6 - td * 0.8;
    markerDot.scale.set(sd, 1, sd);
    tintVertexColors(markerDot.geometry, 0.9 * (1 - td));
  }

  // ---- sync ------------------------------------------------------------------
  function sync(ents: readonly InterpEnt[], ghosts: readonly GhostEnt[], selfId: number): void {
    buildBudgetMs = ARCH_BUILD_BUDGET_MS;
    seen.clear();

    let selfTeam: TeamId | null = null;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e !== undefined && e.id === selfId && isPlayerTeam(e.team)) {
        selfTeam = e.team;
        break;
      }
    }

    barCount = 0;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e === undefined) continue;
      seen.add(e.id);

      if (isStructureKind(e.k)) {
        // R_MAPMESH draws the structure; this module contributes its HP bar and
        // its pick proxy, and both need `barH`/`barW` off the same build.
        const fit = structFitOf(e.k);
        if (fit === null) continue; // not measured yet: retried next frame
        if (e.hp > 0) {
          if (e.hp < e.maxHp) {
            pushBar(e, selfId, selfTeam, core.heightAt(e.x, e.z) + fit.barH, fit.barW);
          }
          structPick(e, fit);
        } else {
          // A destroyed structure gets neither bar nor pick target. Dropping
          // the pick is what stops a right-click on a dead tower from issuing
          // an attack order at rubble.
          dropStructPick(e.id);
        }
        continue;
      }

      // THE HOT PATH RUNS WITHOUT ALLOCATING. An entity that already has a slot
      // reuses the archetype that slot was pooled from and never touches
      // `archKey` or `projSchoolOf` — both of which mint a string (a template
      // literal, and `toLowerCase()`), which over ~110 entities at 60 Hz is
      // ~6600 strings a second in a function whose spec bans per-frame
      // allocation outright. Only a genuinely NEW entity pays for a key, and
      // spawns are rare and bursty rather than continuous.
      const live = active.get(e.id);
      let arch: Archetype | null;
      if (live !== undefined) {
        arch = live.arch;
      } else {
        arch = archetypeFor(e, e.k === 'proj' ? projSchoolOf(e.fx) : 'magic');
        if (arch === null) continue; // budget spent this frame; drawn on the next
      }

      const slot = acquire(e, arch);
      slot.px = e.x;
      slot.pz = e.z;

      // facing: snap yaw to motion direction (interp deltas are per-frame small)
      if (e.k === 'proj') {
        let dx: number;
        let dz: number;
        if (e.tx !== undefined && e.tz !== undefined) {
          dx = e.tx - e.x;
          dz = e.tz - e.z;
        } else {
          dx = e.x - slot.lastX;
          dz = e.z - slot.lastZ;
        }
        if (dx * dx + dz * dz > 1e-8) slot.yaw = Math.atan2(dx, dz);
      } else if (e.k !== 'ward') {
        const dx = e.x - slot.lastX;
        const dz = e.z - slot.lastZ;
        if (dx * dx + dz * dz > 0.0004) slot.yaw = Math.atan2(dx, dz);
      }
      slot.lastX = e.x;
      slot.lastZ = e.z;

      // attack strike trigger: atk is transient per snap (set only on the swing
      // tick) — dedupe on the target id, re-armed when atk clears
      if (e.atk !== undefined) {
        if (slot.lastAtk !== e.atk) {
          slot.lastAtk = e.atk;
          slot.atkT = clock;
          // strike direction toward the target (rare linear scan, no alloc)
          let tx = e.x + Math.sin(slot.yaw);
          let tz = e.z + Math.cos(slot.yaw);
          for (let j = 0; j < ents.length; j++) {
            const o = ents[j];
            if (o !== undefined && o.id === e.atk) {
              tx = o.x;
              tz = o.z;
              break;
            }
          }
          let dx = tx - e.x;
          let dz = tz - e.z;
          const d = Math.hypot(dx, dz);
          if (d > 1e-3) {
            dx /= d;
            dz /= d;
          } else {
            dx = Math.sin(slot.yaw);
            dz = Math.cos(slot.yaw);
          }
          slot.atkDx = dx;
          slot.atkDz = dz;
          // the attacker turns to face its victim for the strike
          slot.yaw = Math.atan2(dx, dz);
        }
      } else {
        slot.lastAtk = -1;
      }

      // hp bars: everything the builder gave a bar. Wards and projectiles carry
      // barH/barW 0, which is the builders' signal for "no bar".
      if (arch.build.barH > 0 && arch.build.barW > 0) {
        pushBar(e, selfId, selfTeam, core.heightAt(e.x, e.z) + arch.build.barH, arch.build.barW);
      }
    }

    // release vanished units (ghosts cover the visual fade)
    for (let i = activeList.length - 1; i >= 0; i--) {
      const slot = activeList[i];
      if (slot !== undefined && !seen.has(slot.id)) release(slot);
    }

    syncGhosts(ghosts);
    flushBars();
    flushRings(selfId);
  }

  function pushBar(
    e: InterpEnt,
    selfId: number,
    selfTeam: TeamId | null,
    y: number,
    w: number,
  ): void {
    if (barCount >= BAR_CAP) return;
    const i = barCount++;
    barXs[i] = e.x;
    barYs[i] = y;
    barZs[i] = e.z;
    barWs[i] = w;
    barFracs[i] = e.maxHp > 0 ? Math.max(0, Math.min(1, e.hp / e.maxHp)) : 0;

    // Every branch narrows before it colours: a neutral camp gets the venom
    // ladder and can never be handed a team hex.
    let fill: number;
    let mark: number;
    if (!isPlayerTeam(e.team)) {
      fill = FILL_NEUTRAL;
      mark = MARK_NEUTRAL;
    } else {
      mark = e.team === 0 ? MARK_AZURE : MARK_EMBER;
      if (e.id === selfId) fill = FILL_SELF;
      else if (selfTeam !== null && e.team !== selfTeam) fill = FILL_ENEMY;
      else fill = e.team === 0 ? FILL_AZURE : FILL_EMBER;
    }
    barFillClass[i] = fill;
    barMarkClass[i] = mark;
  }

  function flushBars(): void {
    barFillCounts.fill(0);
    markCounts.fill(0);
    for (let i = 0; i < barCount; i++) {
      const x = barXs[i] ?? 0;
      const y = barYs[i] ?? 0;
      const z = barZs[i] ?? 0;
      const w = barWs[i] ?? 1;
      const frac = barFracs[i] ?? 0;
      mScratch.compose(vPos.set(x, y, z), barQuat, vScale.set(w, BAR_BG_H, 1));
      barBg.setMatrixAt(i, mScratch);

      const fw = Math.max(0.001, (w - BAR_FILL_INSET) * frac);
      const xoff = -(w - BAR_FILL_INSET) / 2 + fw / 2;
      mScratch.compose(vPos.set(x + xoff, y + nY, z + nZ), barQuat, vScale.set(fw, BAR_FILL_H, 1));
      const fc = barFillClass[i] ?? FILL_ENEMY;
      const fill = barFills[fc];
      const fillN = barFillCounts[fc] ?? 0;
      if (fill !== undefined) {
        fill.setMatrixAt(fillN, mScratch);
        barFillCounts[fc] = fillN + 1;
      }

      const mc = barMarkClass[i] ?? MARK_NEUTRAL;
      const markMesh = markMeshes[mc];
      const markN = markCounts[mc] ?? 0;
      if (markMesh !== undefined) {
        mScratch.compose(vPos.set(x, y + MARKER_LIFT, z), barQuat, vScale.set(1, 1, 1));
        markMesh.setMatrixAt(markN, mScratch);
        markCounts[mc] = markN + 1;
      }
    }
    flushOne(barBg, barCount);
    for (let c = 0; c < barFills.length; c++) {
      const im = barFills[c];
      if (im !== undefined) flushOne(im, barFillCounts[c] ?? 0);
    }
    for (let c = 0; c < markMeshes.length; c++) {
      const im = markMeshes[c];
      if (im !== undefined) flushOne(im, markCounts[c] ?? 0);
    }
  }

  function syncGhosts(ghosts: readonly GhostEnt[]): void {
    ghostSeen.clear();
    for (let i = 0; i < archList.length; i++) {
      const a = archList[i];
      if (a !== undefined) a.ghostCount = 0;
    }
    for (let i = 0; i < ghosts.length; i++) {
      const g = ghosts[i];
      if (g === undefined) continue;
      ghostSeen.add(g.id);
      // A projectile leaves no memory marker: an arrow that reached its target
      // has not "walked out of vision", and the old code substituted a wraith
      // silhouette for it, which read as a summon dying where an arrow landed.
      if (g.k === 'proj') continue;
      const arch = ghostArchById.get(g.id);
      if (arch === undefined) continue; // never seen alive: nothing to fade
      const im = ghostMeshOf(arch);
      if (im === null || arch.ghostCount >= GHOST_CAP) continue;

      // death collapse: squash+splat toward the ground with a slight topple
      // (keel direction seeded by id — deterministic, no rng), running the full
      // 0.5 s fade so a death reads as a fall rather than a vanish.
      const fade = Math.max(0, Math.min(1, g.fade));
      const p = Math.min(1, (1 - fade) * 1.3);
      eScratch.set(0, 0, (g.id % 2 === 0 ? 1 : -1) * 0.5 * p, 'XYZ');
      qScratch.setFromEuler(eScratch);
      mScratch.compose(
        vPos.set(g.x, core.heightAt(g.x, g.z), g.z),
        qScratch,
        vScale.set(1 + 0.3 * p, Math.max(0.08, 1 - 0.92 * p), 1 + 0.3 * p),
      );
      const n = arch.ghostCount;
      im.setMatrixAt(n, mScratch);
      const v = GHOST_PEAK * fade;
      cScratch.setRGB(v, v, v);
      im.setColorAt(n, cScratch);
      arch.ghostCount = n + 1;
    }
    for (let i = 0; i < archList.length; i++) {
      const a = archList[i];
      if (a === undefined || a.ghost === null) continue;
      flushOne(a.ghost, a.ghostCount);
      if (a.ghostCount > 0 && a.ghost.instanceColor !== null) {
        a.ghost.instanceColor.needsUpdate = true;
      }
    }
    // Forget silhouette memories no live entity and no ghost still needs.
    // Reverse index loop + swap-remove: allocation-free, and safe to delete
    // from while walking because everything above `i` has already been checked.
    for (let i = ghostMemN - 1; i >= 0; i--) {
      const id = ghostMemIds[i] ?? -1;
      if (clock - (ghostMemAt[i] ?? 0) <= GHOST_MEMORY_S) continue;
      if (active.has(id) || ghostSeen.has(id)) continue;
      ghostArchById.delete(id);
      ghostMemN -= 1;
      ghostMemIds[i] = ghostMemIds[ghostMemN] ?? -1;
      ghostMemAt[i] = ghostMemAt[ghostMemN] ?? 0;
    }
  }

  function flushRings(selfId: number): void {
    const sel = selectedId >= 0 ? active.get(selectedId) : undefined;
    if (sel !== undefined) {
      selRing.visible = true;
      selRing.position.set(sel.px, core.heightAt(sel.px, sel.pz) + 0.05, sel.pz);
    } else {
      selRing.visible = false;
    }
    const self = selfId >= 0 ? active.get(selfId) : undefined;
    if (self !== undefined) {
      selfRing.visible = true;
      selfRing.position.set(self.px, core.heightAt(self.px, self.pz) + 0.045, self.pz);
    } else {
      selfRing.visible = false;
    }
  }

  return {
    sync,
    setSelected(id) {
      selectedId = id;
      if (id < 0) selRing.visible = false;
    },
    orderMarker(x, z, attack) {
      const mat = attack ? markerAttackMat : markerMoveMat;
      markerRing.material = mat;
      markerRing2.material = mat;
      markerDot.material = mat;
      marker.position.set(x, core.heightAt(x, z) + 0.06, z);
      marker.visible = true;
      markerAge = 0;
    },
  };
}

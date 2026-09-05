// ============================================================================
// render/world.ts — ART 2/6: WORLD & ENVIRONMENT.
//
// buildWorld() populates the plateau outside and inside the fence per the
// STYLE_BIBLE densities: ~180 conifers ringing the plateau (r 56..84 — the
// same numbers HORDE.spawnRing (58) and PLATEAU_RADIUS (84) are built
// against, so the horde spawns just inside the treeline and the ground
// reaches the full forest edge), ~40 stumps/deadfall/snags thinning toward
// the fence, ~120 compound props clustered against walls and under the
// tower, a four-tier baked ground (mud/mudDark/gravel/puddle — never one
// flat polygon), worn gravel paths from the stair foot to each fence side,
// layered ridge silhouettes for horizon depth, and a sky dome with cloud
// banding + a moon + a starfield so the top of the frame is never an empty
// gradient.
//
// CONTRACT GAP (reported to the orchestrator): buildWorld()/animateWorld()
// carry no TimeOfDay parameter, so this file's sky dome/moon/starfield are
// baked to fixed, mood-neutral values rather than the two-mood (dusk/night)
// treatment the STYLE_BIBLE's makeSky spec calls for. This mirrors STRICKEN's
// own precedent (games/fps/client/src/render/scene.ts): the SceneRig's own
// rig-owned dome is "the only VISIBLE sky in the game (it covers the map
// renderer's dome)" and owns mood via setTimeOfDay. This file's dome is built
// to sit behind that rig dome (radius close to the far clip plane) as a
// harmless, always-present backdrop, not the mood-reactive surface.
//
// PERFORMANCE: everything static is bake()'d into a handful of draw calls.
// The one deliberate exception is per STYLE_BIBLE's mandate + CONTRACT's
// draw-call exception (c): the topmost frond tier of every conifer — the
// part that visibly sways — is rendered through a small number of
// THREE.InstancedMesh groups (one per tip colour) instead of being merged
// into the static bake, so "conifer crowns drifting" is real motion across
// the whole forest for a handful of extra draw calls, not one.
// ============================================================================
import * as THREE from 'three';

import {
  PALETTE,
  mat,
  box,
  cyl,
  cone,
  sphere,
  at,
  contactShadow,
  bake,
  vrng,
  COPLANAR_EPS,
} from '../contract/visual.js';
import { PLATEAU_RADIUS, FENCE_HALF, TOWER_HALF, STAIR_OUTER_Z } from '@outpost/shared';

// ---------------------------------------------------------------------------
// Small numeric helper
// ---------------------------------------------------------------------------

function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Deterministic seeds — one independent vrng() stream per subsystem so a
// change to one (e.g. prop count) never reshuffles an unrelated one (e.g.
// the treeline).
// ---------------------------------------------------------------------------

const SEED_GROUND = 90101;
const SEED_TREES = 90102;
const SEED_DEADFALL = 90103;
const SEED_PROPS = 90104;
const SEED_RIDGES = 90105;
const SEED_STARS = 90106;

// ---------------------------------------------------------------------------
// Ground — four baked tiers (mud / mudDark / gravel / puddle), stacked with
// COPLANAR_EPS separation so no two faces ever share a plane. Base sits with
// its top face at y=0 (the engine floor); everything else grows upward from
// there in strictly increasing, non-overlapping bands.
// ---------------------------------------------------------------------------

const GROUND_BASE_THK = 0.08;
const MUDDARK_THK = 0.035;
const MUDDARK_BOTTOM = COPLANAR_EPS;
const GRAVEL_THK = 0.035;
const GRAVEL_BOTTOM = MUDDARK_BOTTOM + MUDDARK_THK + COPLANAR_EPS;
const PUDDLE_HEX = PALETTE.duskSky;
const PUDDLE_THK = 0.02;
const PUDDLE_BOTTOM = GRAVEL_BOTTOM + GRAVEL_THK + COPLANAR_EPS;
const PUDDLE_BASE_OPACITY = 0.52;
const PUDDLE_SHIMMER_AMP = 0.1;
const PUDDLE_SHIMMER_SPEED = 0.7;

const MUDDARK_PATCH_COUNT = 16;
const PUDDLE_COUNT = 9;

function buildGround(root: THREE.Group, rand: () => number): void {
  const base = cyl(PLATEAU_RADIUS, PLATEAU_RADIUS, GROUND_BASE_THK, 56, PALETTE.mud);
  at(base, 0, -GROUND_BASE_THK / 2, 0);
  root.add(base);

  // Worn, trampled low spots — heaviest near the fence line and the stair
  // foot, scattered lighter across the rest of the plateau.
  for (let i = 0; i < MUDDARK_PATCH_COUNT; i++) {
    const a = rand() * Math.PI * 2;
    const r = 4 + rand() * (PLATEAU_RADIUS - 10);
    const x = Math.sin(a) * r;
    const z = -Math.cos(a) * r;
    const pr = 3 + rand() * 6;
    const patch = cyl(pr, pr, MUDDARK_THK, 9, PALETTE.mudDark);
    at(patch, x, MUDDARK_BOTTOM + MUDDARK_THK / 2, z);
    root.add(patch);
  }

  // Gravel hub at the stair foot, an apron around the tower footing, and
  // four straight worn paths radiating out to the middle of each fence side
  // — "the paths sixteen people wore".
  const hub = cyl(4.2, 4.2, GRAVEL_THK, 12, PALETTE.gravel);
  at(hub, 0, GRAVEL_BOTTOM + GRAVEL_THK / 2, STAIR_OUTER_Z * 0.55);
  root.add(hub);

  const apron = cyl(TOWER_HALF + 1.6, TOWER_HALF + 1.6, GRAVEL_THK, 14, PALETTE.gravel);
  at(apron, 0, GRAVEL_BOTTOM + GRAVEL_THK / 2, 0);
  root.add(apron);

  const originX = 0;
  const originZ = STAIR_OUTER_Z;
  const targets: ReadonlyArray<readonly [number, number]> = [
    [0, -FENCE_HALF],
    [FENCE_HALF, 0],
    [0, FENCE_HALF],
    [-FENCE_HALF, 0],
  ];
  for (const target of targets) {
    const tx = target[0];
    const tz = target[1];
    const dx = tx - originX;
    const dz = tz - originZ;
    const len = Math.hypot(dx, dz);
    if (len < 1) continue;
    const width = 2.1 + rand() * 0.7;
    const strip = box(width, GRAVEL_THK, len, PALETTE.gravel);
    at(strip, originX + dx / 2, GRAVEL_BOTTOM + GRAVEL_THK / 2, originZ + dz / 2);
    strip.rotation.y = Math.atan2(dx, dz);
    root.add(strip);
  }

  // Puddles catching the sky colour in the low spots.
  for (let i = 0; i < PUDDLE_COUNT; i++) {
    const a = rand() * Math.PI * 2;
    const r = 6 + rand() * (PLATEAU_RADIUS - 14);
    const x = Math.sin(a) * r;
    const z = -Math.cos(a) * r;
    const pr = 0.7 + rand() * 1.6;
    const puddle = cyl(pr, pr, PUDDLE_THK, 12, PUDDLE_HEX, { transparent: true, opacity: PUDDLE_BASE_OPACITY });
    at(puddle, x, PUDDLE_BOTTOM + PUDDLE_THK / 2, z);
    root.add(puddle);
  }
}

// ---------------------------------------------------------------------------
// Conifers — trunk + lower tiers are baked; the top tier is instanced+live
// so "crown drift" is real motion across the whole forest at near-zero cost.
// ---------------------------------------------------------------------------

const TIP_COLORS: readonly string[] = [PALETTE.pine, PALETTE.pineDark, PALETTE.pineDeep];
const TIP_SWAY_AMP = 0.045;
const TIP_SWAY_SPEED = 0.55;

interface TipInstancePending {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly radius: number;
  readonly height: number;
  readonly phase: number;
  readonly axisX: number;
  readonly axisZ: number;
}

interface ConiferResult {
  readonly group: THREE.Object3D;
  readonly tipColorIdx: number;
  readonly tip: TipInstancePending;
}

/** 6-14 m conifer: tapered trunk + 3-5 stacked frond tiers narrowing upward. */
function buildConifer(rand: () => number, x: number, z: number, crownHeight: number): ConiferResult {
  const group = new THREE.Group();

  const trunkH = crownHeight * (0.28 + rand() * 0.08);
  const trunkRBottom = 0.1 + crownHeight * 0.011;
  const trunkRTop = trunkRBottom * 0.42;
  const trunk = cyl(trunkRTop, trunkRBottom, trunkH, 6, PALETTE.woodDark);
  at(trunk, 0, trunkH / 2, 0);
  group.add(trunk);

  const tierCount = 3 + Math.floor(rand() * 3); // 3..5
  const colorOffset = Math.floor(rand() * TIP_COLORS.length);
  const crownBase = trunkH * 0.5;
  const crownSpan = Math.max(crownHeight - crownBase, crownHeight * 0.4);
  const tierStep = crownSpan / tierCount;
  const baseRadius = crownHeight * (0.15 + rand() * 0.05);

  const staticTierCount = tierCount - 1;
  for (let i = 0; i < staticTierCount; i++) {
    const frac = i / (tierCount - 1);
    const r = baseRadius * (1 - frac * 0.7);
    const h = tierStep * (1.3 + rand() * 0.3);
    const cy = crownBase + i * tierStep + h * 0.3;
    const colorIdx = (i + colorOffset) % TIP_COLORS.length;
    const hex = TIP_COLORS[colorIdx];
    if (hex === undefined) continue;
    const tier = cone(r, h, 7, hex);
    at(tier, 0, cy, 0);
    tier.rotation.y = rand() * Math.PI * 2;
    group.add(tier);
  }

  // Top tier: withheld from the static group, described for the instanced,
  // live tip pass instead (see buildTipInstancedMeshes).
  const topR = baseRadius * 0.3;
  const topH = tierStep * (1.3 + rand() * 0.3);
  const topCy = crownBase + staticTierCount * tierStep + topH * 0.3;
  const tipColorIdx = (staticTierCount + colorOffset) % TIP_COLORS.length;

  at(group, x, 0, z);
  group.add(contactShadow(baseRadius * 0.85));

  const tip: TipInstancePending = {
    x,
    y: topCy,
    z,
    yaw: rand() * Math.PI * 2,
    radius: topR,
    height: topH,
    phase: rand() * Math.PI * 2,
    axisX: rand() - 0.5,
    axisZ: rand() - 0.5,
  };

  return { group, tipColorIdx, tip };
}

const TREE_RING_MIN = 56;
const TREE_RING_MAX = 84;
const TREE_TOTAL = 180;
const TREE_CLUSTER_COUNT = 24;
const TREE_CLUSTER_SKIP = 0.15; // fraction of cluster slots left as clearings
const TREE_SNAG_CHANCE = 0.05;

/**
 * ~180 conifers, r 56..84, in clusters of 6-14 with clearings between,
 * crown heights 6-14 m, never two adjacent the same.
 */
function buildTreeline(root: THREE.Group, rand: () => number, tipBuckets: TipInstancePending[][]): void {
  let planted = 0;
  let prevHeight = 10;
  const angleStep = (Math.PI * 2) / TREE_CLUSTER_COUNT;

  for (let c = 0; c < TREE_CLUSTER_COUNT && planted < TREE_TOTAL; c++) {
    if (rand() < TREE_CLUSTER_SKIP) continue; // a clearing: this slot stays empty

    const clusterAngle = c * angleStep + (rand() - 0.5) * angleStep * 0.5;
    const clusterR = TREE_RING_MIN + rand() * (TREE_RING_MAX - TREE_RING_MIN);
    const clusterSize = 6 + Math.floor(rand() * 9); // 6..14
    const angularSpread = 0.16 + rand() * 0.12;
    const radialSpread = 9 + rand() * 8;

    for (let i = 0; i < clusterSize && planted < TREE_TOTAL; i++) {
      const a = clusterAngle + (rand() - 0.5) * angularSpread;
      const r = clampNum(clusterR + (rand() - 0.5) * radialSpread, TREE_RING_MIN, TREE_RING_MAX);
      const x = Math.sin(a) * r;
      const z = -Math.cos(a) * r;

      let h = 6 + rand() * 8;
      if (Math.abs(h - prevHeight) < 0.5) h = clampNum(h + 0.7 + rand() * 1.1, 6, 14);
      prevHeight = h;

      if (rand() < TREE_SNAG_CHANCE) {
        root.add(buildDeadSnag(rand, x, z, 4 + rand() * 4));
      } else {
        const res = buildConifer(rand, x, z, h);
        root.add(res.group);
        const bucket = tipBuckets[res.tipColorIdx];
        if (bucket) bucket.push(res.tip);
      }
      planted++;
    }
  }
}

// ---------------------------------------------------------------------------
// Instanced, live crown tips
// ---------------------------------------------------------------------------

interface TipInstanceData {
  readonly baseMatrix: THREE.Matrix4;
  readonly phase: number;
  readonly swayAmp: number;
  readonly axis: THREE.Vector3;
}

interface TipGroup {
  readonly mesh: THREE.InstancedMesh;
  readonly instances: TipInstanceData[];
}

function buildTipInstancedMeshes(buckets: readonly TipInstancePending[][]): TipGroup[] {
  const groups: TipGroup[] = [];
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const yAxis = new THREE.Vector3(0, 1, 0);

  for (let c = 0; c < TIP_COLORS.length; c++) {
    const items = buckets[c];
    const color = TIP_COLORS[c];
    if (!items || items.length === 0 || color === undefined) continue;

    const proto = cone(1, 1, 7, color);
    const instanced = new THREE.InstancedMesh(proto.geometry, proto.material, items.length);
    instanced.castShadow = true;
    instanced.receiveShadow = true;
    instanced.userData['animate'] = true; // defensive: never fed to bake(), but documents the seam

    const instances: TipInstanceData[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it) continue;
      pos.set(it.x, it.y, it.z);
      q.setFromAxisAngle(yAxis, it.yaw);
      scl.set(it.radius, it.height, it.radius);
      m.compose(pos, q, scl);
      instanced.setMatrixAt(i, m);

      const axis = new THREE.Vector3(it.axisX, 0, it.axisZ);
      if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0);
      axis.normalize();
      instances.push({ baseMatrix: m.clone(), phase: it.phase, swayAmp: TIP_SWAY_AMP, axis });
    }
    instanced.instanceMatrix.needsUpdate = true;
    groups.push({ mesh: instanced, instances });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Mid-field deadfall — stumps, logs, burnt snags. Thinning toward the fence
// is the storytelling: the defenders cleared their firing lines.
// ---------------------------------------------------------------------------

function buildStump(rand: () => number, x: number, z: number): THREE.Object3D {
  const g = new THREE.Group();
  const r = 0.35 + rand() * 0.35;
  const h = 0.4 + rand() * 0.5;
  const body = cyl(r * 0.92, r, h, 7, PALETTE.woodDark);
  at(body, 0, h / 2, 0);
  g.add(body);
  const capT = cyl(r * 0.94, r * 0.94, 0.05, 7, PALETTE.wood);
  at(capT, 0, h + 0.02, 0);
  g.add(capT);
  at(g, x, 0, z);
  g.rotation.y = rand() * Math.PI * 2;
  g.add(contactShadow(r * 1.3));
  return g;
}

function buildDeadfallLog(rand: () => number, x: number, z: number): THREE.Object3D {
  const g = new THREE.Group();
  const len = 2.5 + rand() * 3.5;
  const r = 0.18 + rand() * 0.14;
  const log = cyl(r * 0.8, r, len, 7, PALETTE.woodDark);
  log.rotation.z = Math.PI / 2;
  at(log, 0, r * 0.9, 0);
  g.add(log);
  const bark = cyl(r * 0.5, r * 0.62, len * 0.94, 7, PALETTE.wood);
  bark.rotation.z = Math.PI / 2;
  at(bark, 0, r * 0.9 + r * 0.15, 0);
  g.add(bark);
  at(g, x, 0, z);
  g.rotation.y = rand() * Math.PI * 2;
  g.add(contactShadow(len * 0.32));
  return g;
}

function buildDeadSnag(rand: () => number, x: number, z: number, height: number): THREE.Object3D {
  const g = new THREE.Group();
  const rBottom = 0.14 + rand() * 0.1;
  const trunk = cyl(rBottom * 0.35, rBottom, height, 6, PALETTE.woodDeep);
  at(trunk, 0, height / 2, 0);
  trunk.rotation.z = (rand() - 0.5) * 0.12;
  g.add(trunk);
  const branchCount = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < branchCount; i++) {
    const by = height * (0.4 + rand() * 0.5);
    const blen = 0.5 + rand() * 0.7;
    const branch = cyl(0.02, rBottom * 0.4, blen, 5, PALETTE.woodDeep);
    at(branch, 0, by, 0);
    branch.rotation.z = Math.PI / 2 - (0.3 + rand() * 0.5);
    branch.rotation.y = rand() * Math.PI * 2;
    g.add(branch);
  }
  at(g, x, 0, z);
  g.add(contactShadow(rBottom * 2.2));
  return g;
}

const DEADFALL_TOTAL = 40;
const DEADFALL_MIN = 24;
const DEADFALL_MAX = 58;

function buildDeadfall(root: THREE.Group, rand: () => number): void {
  for (let i = 0; i < DEADFALL_TOTAL; i++) {
    const a = rand() * Math.PI * 2;
    // Biased toward DEADFALL_MAX (the treeline end): thinning toward the
    // fence is deliberate — defenders cleared their firing lines.
    const r = DEADFALL_MAX - Math.pow(rand(), 1.8) * (DEADFALL_MAX - DEADFALL_MIN);
    const x = Math.sin(a) * r;
    const z = -Math.cos(a) * r;
    const kind = rand();
    if (kind < 0.4) root.add(buildStump(rand, x, z));
    else if (kind < 0.75) root.add(buildDeadfallLog(rand, x, z));
    else root.add(buildDeadSnag(rand, x, z, 3 + rand() * 3));
  }
}

// ---------------------------------------------------------------------------
// Compound props — clustered against the inner walls and under/around the
// tower, never evenly scattered.
// ---------------------------------------------------------------------------

function buildCrate(rand: () => number): THREE.Object3D {
  const g = new THREE.Group();
  const w = 0.5 + rand() * 0.3;
  const h = 0.45 + rand() * 0.35;
  const d = 0.5 + rand() * 0.3;
  const body = box(w, h, d, PALETTE.wood);
  at(body, 0, h / 2, 0);
  g.add(body);
  const band = box(w + 0.02, 0.05, d + 0.02, PALETTE.woodDark);
  at(band, 0, h * (0.3 + rand() * 0.4), 0);
  g.add(band);
  g.add(contactShadow(Math.max(w, d) * 0.6));
  return g;
}

function buildOilDrum(rand: () => number): THREE.Object3D {
  const g = new THREE.Group();
  const r = 0.28 + rand() * 0.05;
  const h = 0.75 + rand() * 0.15;
  const body = cyl(r, r, h, 10, rand() < 0.5 ? PALETTE.rust : PALETTE.rustDark);
  at(body, 0, h / 2, 0);
  g.add(body);
  const rim = cyl(r * 1.03, r * 1.03, 0.04, 10, PALETTE.rustLit);
  at(rim, 0, h - 0.02, 0);
  g.add(rim);
  g.rotation.y = rand() * Math.PI * 2;
  g.add(contactShadow(r * 1.3));
  return g;
}

function buildSandbagStack(rand: () => number): THREE.Object3D {
  const g = new THREE.Group();
  const rows = 2 + Math.floor(rand() * 2);
  const bagW = 0.5;
  const bagH = 0.22;
  const bagD = 0.32;
  for (let row = 0; row < rows; row++) {
    const count = 3 + Math.floor(rand() * 2);
    for (let i = 0; i < count; i++) {
      const off = (i - (count - 1) / 2) * (bagW * 0.85);
      const jitterZ = (rand() - 0.5) * 0.05;
      const bag = box(bagW * (0.9 + rand() * 0.2), bagH, bagD, row % 2 === 0 ? PALETTE.sandbag : PALETTE.sandbagDark);
      at(bag, off, bagH / 2 + row * bagH * 0.92, jitterZ);
      g.add(bag);
    }
  }
  g.add(contactShadow(bagW * 1.6));
  return g;
}

function buildToolBench(rand: () => number): THREE.Object3D {
  const g = new THREE.Group();
  const w = 1.4;
  const h = 0.85;
  const d = 0.55;
  const top = box(w, 0.08, d, PALETTE.woodDark);
  at(top, 0, h, 0);
  g.add(top);
  const legOffsets: ReadonlyArray<readonly [number, number]> = [
    [-w / 2 + 0.08, -d / 2 + 0.08],
    [w / 2 - 0.08, -d / 2 + 0.08],
    [-w / 2 + 0.08, d / 2 - 0.08],
    [w / 2 - 0.08, d / 2 - 0.08],
  ];
  for (const off of legOffsets) {
    const leg = box(0.08, h, 0.08, PALETTE.woodDeep);
    at(leg, off[0], h / 2, off[1]);
    g.add(leg);
  }
  const tool = box(0.5, 0.06, 0.1, PALETTE.steel);
  at(tool, 0.1, h + 0.05, 0);
  tool.rotation.y = 0.3;
  g.add(tool);
  g.add(contactShadow(w * 0.55));
  return g;
}

function buildWireCoil(rand: () => number): THREE.Object3D {
  const g = new THREE.Group();
  const r = 0.28 + rand() * 0.1;
  const outer = cyl(r, r, 0.16, 10, PALETTE.metalDark);
  at(outer, 0, 0.08, 0);
  g.add(outer);
  const inner = cyl(r * 0.55, r * 0.55, 0.18, 10, PALETTE.steel);
  at(inner, 0, 0.09, 0);
  g.add(inner);
  g.add(contactShadow(r * 1.2));
  return g;
}

function buildPlankStack(rand: () => number): THREE.Object3D {
  const g = new THREE.Group();
  const len = 1.6 + rand() * 0.8;
  const count = 3 + Math.floor(rand() * 3);
  for (let i = 0; i < count; i++) {
    const plank = box(len, 0.05, 0.18, i % 2 === 0 ? PALETTE.wood : PALETTE.woodLit);
    at(plank, (rand() - 0.5) * 0.1, 0.04 + i * 0.055, (rand() - 0.5) * 0.06);
    plank.rotation.y = (rand() - 0.5) * 0.06;
    g.add(plank);
  }
  g.add(contactShadow(len * 0.32));
  return g;
}

function buildWheelbarrow(rand: () => number): THREE.Object3D {
  const g = new THREE.Group();
  const tray = box(0.75, 0.32, 0.55, PALETTE.rust);
  at(tray, 0, 0.42, -0.05);
  tray.rotation.x = -0.12;
  g.add(tray);
  const wheel = cyl(0.16, 0.16, 0.08, 10, PALETTE.metalDark);
  wheel.rotation.x = Math.PI / 2;
  at(wheel, 0, 0.16, 0.45);
  g.add(wheel);
  const handleL = box(0.05, 0.05, 0.9, PALETTE.woodDark);
  at(handleL, -0.28, 0.32, 0.55);
  g.add(handleL);
  const handleR = box(0.05, 0.05, 0.9, PALETTE.woodDark);
  at(handleR, 0.28, 0.32, 0.55);
  g.add(handleR);
  g.add(contactShadow(0.55));
  return g;
}

function buildLaundryLine(rand: () => number): THREE.Object3D {
  const g = new THREE.Group();
  const span = 2.2 + rand() * 1.0;
  const postH = 1.5 + rand() * 0.3;
  const postL = cyl(0.05, 0.07, postH, 6, PALETTE.woodDark);
  at(postL, -span / 2, postH / 2, 0);
  g.add(postL);
  const postR = cyl(0.05, 0.07, postH, 6, PALETTE.woodDark);
  at(postR, span / 2, postH / 2, 0);
  g.add(postR);
  const rope = box(span, 0.02, 0.02, PALETTE.metalDark);
  at(rope, 0, postH - 0.05, 0);
  g.add(rope);
  const clothCount = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < clothCount; i++) {
    const cx = (i / (clothCount - 1) - 0.5) * span * 0.8;
    const cloth = box(0.35 + rand() * 0.15, 0.4 + rand() * 0.2, 0.03, rand() < 0.5 ? PALETTE.sandbag : PALETTE.concreteLit);
    at(cloth, cx, postH - 0.05 - (0.2 + rand() * 0.1), 0);
    g.add(cloth);
  }
  g.add(contactShadow(span * 0.5));
  return g;
}

function buildAmmoTins(rand: () => number): THREE.Object3D {
  const g = new THREE.Group();
  const rows = 2 + Math.floor(rand() * 2);
  for (let i = 0; i < rows; i++) {
    const tin = box(0.32, 0.22, 0.2, rand() < 0.5 ? PALETTE.steel : PALETTE.rustDark);
    at(tin, (rand() - 0.5) * 0.08, 0.11 + i * 0.2, (rand() - 0.5) * 0.08);
    tin.rotation.y = (rand() - 0.5) * 0.4;
    g.add(tin);
  }
  g.add(contactShadow(0.3));
  return g;
}

function buildTarpPile(rand: () => number): THREE.Object3D {
  const g = new THREE.Group();
  const baseH = 0.5 + rand() * 0.3;
  const base = box(1.1 + rand() * 0.4, baseH, 0.9 + rand() * 0.3, PALETTE.wood);
  at(base, 0, baseH / 2, 0);
  g.add(base);
  const tarp = box(1.3, 0.08, 1.1, PALETTE.sandbagDark);
  at(tarp, 0, baseH + 0.08, 0);
  tarp.rotation.z = (rand() - 0.5) * 0.15;
  tarp.rotation.x = (rand() - 0.5) * 0.1;
  g.add(tarp);
  g.add(contactShadow(0.85));
  return g;
}

const PROP_BUILDERS: ReadonlyArray<(rand: () => number) => THREE.Object3D> = [
  buildCrate,
  buildCrate,
  buildOilDrum,
  buildSandbagStack,
  buildToolBench,
  buildWireCoil,
  buildPlankStack,
  buildWheelbarrow,
  buildLaundryLine,
  buildAmmoTins,
  buildTarpPile,
];

interface PropCluster {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly weight: number;
}

/** Anchors against the four inner fence walls and around the tower's flanks. */
const PROP_CLUSTERS: readonly PropCluster[] = [
  { x: 0, z: -(FENCE_HALF - 3.2), radius: 5.2, weight: 1.0 },
  { x: FENCE_HALF - 3.2, z: -6, radius: 4.2, weight: 1.0 },
  { x: FENCE_HALF - 3.2, z: 7, radius: 4.2, weight: 1.0 },
  { x: -(FENCE_HALF - 3.2), z: -6, radius: 4.2, weight: 1.0 },
  { x: -(FENCE_HALF - 3.2), z: 7, radius: 4.2, weight: 1.0 },
  { x: 0, z: FENCE_HALF - 4.5, radius: 3.6, weight: 0.6 },
  { x: TOWER_HALF + 3.5, z: 6, radius: 3.4, weight: 1.1 },
  { x: -(TOWER_HALF + 3.5), z: 6, radius: 3.4, weight: 1.1 },
  { x: TOWER_HALF + 3.0, z: -6, radius: 3.0, weight: 0.8 },
];

const PROP_TOTAL = 125;

/** ~120 props clustered against walls and under the tower, never evenly scattered. */
function buildCompoundProps(root: THREE.Group, rand: () => number): void {
  const totalWeight = PROP_CLUSTERS.reduce((s, c) => s + c.weight, 0);
  for (const cluster of PROP_CLUSTERS) {
    const count = Math.max(4, Math.round((PROP_TOTAL * cluster.weight) / totalWeight));
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      const rr = Math.pow(rand(), 0.6) * cluster.radius;
      const x = cluster.x + Math.cos(a) * rr;
      const z = cluster.z + Math.sin(a) * rr;
      const builderIdx = Math.floor(rand() * PROP_BUILDERS.length);
      const builder = PROP_BUILDERS[builderIdx];
      if (!builder) continue;
      const prop = builder(rand);
      at(prop, x, 0, z);
      prop.rotation.y = rand() * Math.PI * 2;
      root.add(prop);
    }
  }
}

// ---------------------------------------------------------------------------
// Ridges — layered decorative silhouettes beyond the treeline, purely for
// horizon depth. Non-collidable; never touches map.ts.
// ---------------------------------------------------------------------------

interface RidgeLayerSpec {
  readonly radius: number;
  readonly color: string;
  readonly count: number;
  readonly hMin: number;
  readonly hMax: number;
  readonly baseR: number;
  readonly jag: number;
}

const RIDGE_EMBED = 1.3;
const RIDGE_LAYERS: readonly RidgeLayerSpec[] = [
  { radius: 92, color: PALETTE.pineDeep, count: 26, hMin: 9, hMax: 24, baseR: 14, jag: 0.35 },
  { radius: 132, color: PALETTE.duskFog, count: 22, hMin: 13, hMax: 32, baseR: 20, jag: 0.22 },
  { radius: 180, color: PALETTE.fogNight, count: 18, hMin: 16, hMax: 40, baseR: 28, jag: 0.12 },
];

function buildRidges(root: THREE.Group, rand: () => number): void {
  for (const layer of RIDGE_LAYERS) {
    const angleStep = (Math.PI * 2) / layer.count;
    for (let i = 0; i < layer.count; i++) {
      const a = i * angleStep + (rand() - 0.5) * angleStep * layer.jag;
      const h = layer.hMin + rand() * (layer.hMax - layer.hMin);
      const baseR = layer.baseR * (0.75 + rand() * 0.5);
      const x = Math.sin(a) * layer.radius;
      const z = -Math.cos(a) * layer.radius;
      const mound = cone(baseR, h, 6, layer.color);
      // Jitter the embed depth per-mound: an unjittered constant would put
      // every mound's buried base face at the exact same y, coplanar with
      // its neighbours wherever two bases overlap underground.
      at(mound, x, h / 2 - RIDGE_EMBED - rand() * 0.06, z);
      root.add(mound);
    }
  }
}

// ---------------------------------------------------------------------------
// Sky — 3-stop gradient dome with cloud banding, a moon disc with a soft
// halo, and a starfield. See the CONTRACT GAP note at the top of the file:
// these are mood-neutral (no TimeOfDay input reaches this module).
// ---------------------------------------------------------------------------

const SKY_RADIUS = 460;
const STAR_FIELD_RADIUS = 440;
const STAR_COUNT = 420;
const MOON_SIZE = 34;

const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = `
varying vec3 vDir;
uniform vec3 uHorizon;
uniform vec3 uMid;
uniform vec3 uZenith;
void main() {
  float h = clamp(vDir.y, -1.0, 1.0);
  float tMid = smoothstep(-0.05, 0.28, h);
  vec3 col = mix(uHorizon, uMid, tMid);
  float tHigh = smoothstep(0.22, 0.85, h);
  col = mix(col, uZenith, tHigh);

  // Cloud banding — strongest in the upper sky so the top of the frame is
  // never an empty gradient.
  float bandMask = smoothstep(0.15, 0.55, h);
  float bandsA = sin(vDir.x * 5.5 + vDir.z * 3.1) * 0.5 + 0.5;
  float bandsB = sin(vDir.x * 2.1 - vDir.z * 4.7 + 1.7) * 0.5 + 0.5;
  float bands = bandsA * bandsB;
  col += (bands - 0.5) * 0.06 * bandMask;

  gl_FragColor = vec4(col, 1.0);
}
`;

const MOON_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const MOON_FRAG = `
varying vec2 vUv;
uniform vec3 uColor;
void main() {
  vec2 c = vUv - 0.5;
  float d = length(c) * 2.0;
  float core = smoothstep(0.55, 0.3, d);
  float halo = smoothstep(1.0, 0.15, d) * 0.5;
  float a = clamp(core + halo, 0.0, 1.0);
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
}
`;

function buildSkyDome(): THREE.Mesh {
  const proto = sphere(SKY_RADIUS, 24, PALETTE.mud); // geometry donor only; colour unused
  const domeMat = new THREE.ShaderMaterial({
    uniforms: {
      uHorizon: { value: new THREE.Color(PALETTE.duskHorizon) },
      uMid: { value: new THREE.Color(PALETTE.duskSky) },
      uZenith: { value: new THREE.Color(PALETTE.duskSkyHigh) },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  return new THREE.Mesh(proto.geometry, domeMat);
}

function buildMoon(): THREE.Mesh {
  const proto = box(MOON_SIZE, MOON_SIZE, 0.02, PALETTE.mud); // geometry donor only
  const moonMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(PALETTE.moonlight) } },
    vertexShader: MOON_VERT,
    fragmentShader: MOON_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const mesh = new THREE.Mesh(proto.geometry, moonMat);
  const dir = new THREE.Vector3(-0.32, 0.58, 0.74).normalize();
  // Must stay farther than the rig's opaque sky dome (SKY_DOME_RADIUS = 380,
  // games/fps/client/src/render/scene.ts) or this transparent moon quad
  // passes the depth test and renders on top of it, producing two visible
  // moons. Keep it just inside our own dome (SKY_RADIUS) instead of at 0.82x.
  mesh.position.copy(dir).multiplyScalar(SKY_RADIUS * 0.99);
  mesh.lookAt(0, 0, 0);
  return mesh;
}

function buildStarfield(rand: () => number): THREE.Points {
  const positions = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    const theta = rand() * Math.PI * 2;
    const phi = Math.acos(1 - rand() * 0.85); // biased to the upper hemisphere
    const x = STAR_FIELD_RADIUS * Math.sin(phi) * Math.sin(theta);
    const y = STAR_FIELD_RADIUS * Math.cos(phi);
    const z = STAR_FIELD_RADIUS * Math.sin(phi) * Math.cos(theta);
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const starsMat = new THREE.PointsMaterial({
    color: PALETTE.moonlight,
    size: 1.6,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    fog: false,
  });
  return new THREE.Points(geo, starsMat);
}

interface SkyBuild {
  readonly dome: THREE.Mesh;
  readonly moon: THREE.Mesh;
  readonly stars: THREE.Points;
}

function buildSky(rand: () => number): SkyBuild {
  return { dome: buildSkyDome(), moon: buildMoon(), stars: buildStarfield(rand) };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface WorldUserData {
  tipGroups?: TipGroup[];
  puddleMat?: THREE.MeshLambertMaterial;
}

export function buildWorld(): THREE.Group {
  const groundRand = vrng(SEED_GROUND);
  const treeRand = vrng(SEED_TREES);
  const deadfallRand = vrng(SEED_DEADFALL);
  const propRand = vrng(SEED_PROPS);
  const ridgeRand = vrng(SEED_RIDGES);
  const starRand = vrng(SEED_STARS);

  // Everything that bakes goes into staticSrc; bake() returns a NEW group
  // and drops anything it does not merge, so live/point content is built
  // and added separately, after baking.
  const staticSrc = new THREE.Group();
  buildGround(staticSrc, groundRand);

  const tipBuckets: TipInstancePending[][] = [[], [], []];
  buildTreeline(staticSrc, treeRand, tipBuckets);
  buildDeadfall(staticSrc, deadfallRand);
  buildRidges(staticSrc, ridgeRand);
  buildCompoundProps(staticSrc, propRand);

  const baked = bake(staticSrc);
  baked.name = 'world-static';

  const root = new THREE.Group();
  root.name = 'world';
  root.add(baked);

  const sky = buildSky(starRand);
  root.add(sky.dome, sky.moon, sky.stars);

  const tipGroups = buildTipInstancedMeshes(tipBuckets);
  for (const g of tipGroups) root.add(g.mesh);

  const puddleMat = mat(PUDDLE_HEX, { transparent: true, opacity: PUDDLE_BASE_OPACITY });
  const userData: WorldUserData = { tipGroups, puddleMat };
  root.userData = userData;

  return root;
}

// ---- per-frame scratch (module-level; animateWorld allocates nothing) ------
const animQuat = new THREE.Quaternion();
const animRot = new THREE.Matrix4();
const animOut = new THREE.Matrix4();

/** Conifer crown drift + puddle shimmer. Everything else is static/baked. */
export function animateWorld(root: THREE.Group, t: number): void {
  const data = root.userData as WorldUserData;

  const tipGroups = data.tipGroups;
  if (tipGroups) {
    for (const g of tipGroups) {
      const instances = g.instances;
      for (let i = 0; i < instances.length; i++) {
        const inst = instances[i];
        if (!inst) continue;
        const sway = Math.sin(t * TIP_SWAY_SPEED + inst.phase) * inst.swayAmp;
        animQuat.setFromAxisAngle(inst.axis, sway);
        animRot.makeRotationFromQuaternion(animQuat);
        animOut.copy(inst.baseMatrix).multiply(animRot);
        g.mesh.setMatrixAt(i, animOut);
      }
      g.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  const puddleMat = data.puddleMat;
  if (puddleMat) {
    puddleMat.opacity = PUDDLE_BASE_OPACITY + Math.sin(t * PUDDLE_SHIMMER_SPEED) * PUDDLE_SHIMMER_AMP;
  }
}

// ============================================================================
// ANCIENTS (rift) — UNIT MESHES (CONTRACT §6 render/units.ts + §7 model
// sheets). Every entity gets a visible mesh built from primitive factories
// (box/cyl/cone/sphere/octahedron), palette hexes baked into vertex colours,
// merged into ONE geometry per (variant, team) — so one unit is ONE draw
// call (<= 2 incl. team trim, which IS vertex-painted into the same merge).
// Team tint: azure/ember (+ Lit/Deep tiers) on plumes, bands, banners, orbs.
//
// HP bars are INSTANCED: exactly TWO InstancedMesh (backgrounds `inkDeep`,
// fills = team colour / `heal` for self / `danger` for enemies) — 2 draw
// calls total no matter how many units — slim, so the bars annotate the
// silhouette instead of replacing it. Team identity also reads by SHAPE, not
// hue alone: two more InstancedMesh float a small marker above each bar
// (azure = upward chevron, ember = diamond), emissive-locked in the team Lit
// tier. Selection ring + order-target marker are single pooled meshes.
//
// ANIMATED CARVE-OUT (§7): the only unbaked moving parts here are tower
// crystals (slow orbit), the Ancient heart (float/bob), ward eyes (pulse),
// and projectiles; everything else is one static merged mesh per unit.
// ============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { APAL, TEAM_COLORS, heroById } from '@rift/shared';
import type { EntKind, HeroId, MapDef, TeamId } from '@rift/shared';
import { mix } from '@platform/shared';
import type { GhostEnt, InterpEnt, SceneHandle, UnitsHandle } from '../contract.js';
import { CAMERA_PITCH_DEG, paintGeo, sceneCore } from './scene.js';
import type { SceneCore } from './scene.js';

const TEAM_LIT: readonly [string, string] = [APAL.azureLit, APAL.emberLit];

/** Instanced HP-bar capacity — covers 8v8/3-lane peak (~120) with headroom. */
const BAR_CAP = 176;
const GHOST_CAP = 16;
const PROJ_CAP = 64;

// ---- geometry helpers -----------------------------------------------------------

interface PartOpts {
  rx?: number;
  ry?: number;
  rz?: number;
  sx?: number;
  sy?: number;
  sz?: number;
}

/** Transform, paint and collect one primitive part. */
function part(
  parts: THREE.BufferGeometry[],
  geom: THREE.BufferGeometry,
  hex: string,
  x: number,
  y: number,
  z: number,
  o?: PartOpts,
): void {
  const g = geom.index ? geom.toNonIndexed() : geom;
  if (o && (o.sx !== undefined || o.sy !== undefined || o.sz !== undefined)) {
    g.scale(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1);
  }
  if (o?.rx) g.rotateX(o.rx);
  if (o?.rz) g.rotateZ(o.rz);
  if (o?.ry) g.rotateY(o.ry);
  g.translate(x, y, z);
  parts.push(paintGeo(g, hex));
}

function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('rift units: geometry merge failed');
  return merged;
}

function accentHex(accent: string): string {
  const v = (APAL as unknown as Record<string, string>)[accent];
  return v ?? APAL.gold;
}

// ---- model sheets (§7) ------------------------------------------------------------
// Models are built facing +z; yaw = atan2(dx, dz) turns them into their motion.

function towerParts(team: TeamId, guard: boolean): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const bulk = guard ? 1.15 : 1;
  const tb = TEAM_COLORS[team] ?? APAL.azure;
  const tl = TEAM_LIT[team] ?? APAL.azureLit;
  // plinth (proud 0.05), tapering octagonal column, cornice (proud 0.06)
  part(parts, new THREE.CylinderGeometry(1.35 * bulk, 1.5 * bulk, 0.4, 8), APAL.monumentDeep, 0, 0.2, 0);
  part(parts, new THREE.CylinderGeometry(0.7 * bulk, 1.0 * bulk, 2.6, 8), APAL.monument, 0, 1.7, 0);
  part(parts, new THREE.CylinderGeometry(1.05 * bulk, 0.85 * bulk, 0.3, 8), APAL.monumentLit, 0, 3.15, 0);
  // brazier bowl
  part(parts, new THREE.CylinderGeometry(0.7 * bulk, 0.45 * bulk, 0.25, 8), APAL.stoneDeep, 0, 3.4, 0);
  // team trim band at the column base
  part(parts, new THREE.CylinderGeometry(1.03 * bulk, 1.03 * bulk, 0.18, 8), tb, 0, 0.55, 0);
  // cracks: 3 inset stoneDeep shards
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    part(
      parts,
      new THREE.BoxGeometry(0.18, 0.7, 0.12),
      APAL.stoneDeep,
      Math.cos(a) * 0.86 * bulk,
      1.6,
      Math.sin(a) * 0.86 * bulk,
      { ry: -a },
    );
  }
  if (guard) {
    // twin-horned crown
    part(parts, new THREE.ConeGeometry(0.16, 0.55, 6), APAL.monumentLit, -0.5, 3.55, 0);
    part(parts, new THREE.ConeGeometry(0.16, 0.55, 6), APAL.monumentLit, 0.5, 3.55, 0);
  }
  // small team pennant under the cornice
  part(parts, new THREE.BoxGeometry(0.06, 0.5, 0.3), tl, 0, 2.85, 0.95 * bulk);
  return parts;
}

/** The ONE animated tower part: the floating team crystal (octahedron).
 *  Team BASE tier for the shell, Lit only for the inner core — a Lit shell
 *  blows out to near-white under the sun. */
function crystalGeo(team: TeamId): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  part(parts, new THREE.OctahedronGeometry(0.34), TEAM_COLORS[team] ?? APAL.azure, 0, 0, 0);
  part(parts, new THREE.OctahedronGeometry(0.16), TEAM_LIT[team] ?? APAL.azureLit, 0, 0, 0);
  return mergeParts(parts);
}

function ancientParts(team: TeamId): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const tb = TEAM_COLORS[team] ?? APAL.azure;
  // base slab
  part(parts, new THREE.CylinderGeometry(2.6, 2.9, 0.5, 8), APAL.monumentDeep, 0, 0.25, 0);
  // team trim ring on the base
  part(parts, new THREE.CylinderGeometry(2.62, 2.62, 0.14, 8), tb, 0, 0.55, 0);
  // rubble ring
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    const s = 0.3 + (i % 3) * 0.12;
    part(
      parts,
      new THREE.BoxGeometry(s, s * 0.7, s),
      APAL.stoneDeep,
      Math.cos(a) * 2.35,
      s * 0.3,
      Math.sin(a) * 2.35,
      { ry: a },
    );
  }
  // CENTRAL MONOLITH CORE — the dominant mass (2-3x the slab width) so the
  // Ancient reads as one looming stone, not a ring of rubble
  part(parts, new THREE.BoxGeometry(2.1, 3.4, 1.5), APAL.monument, 0, 0.5 + 1.7, 0);
  part(parts, new THREE.BoxGeometry(2.4, 0.35, 1.8), APAL.monumentLit, 0, 0.5 + 3.4 + 0.17, 0);
  part(parts, new THREE.BoxGeometry(1.5, 0.3, 1.1), APAL.monumentDeep, 0, 0.72, 0);
  // stacked monolith slabs leaning inward around the core
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.35;
    const h = 2.6 + (i % 3) * 0.4;
    part(
      parts,
      new THREE.BoxGeometry(0.9, h, 0.5),
      APAL.monument,
      Math.cos(a) * 1.5,
      0.5 + h / 2 - 0.15,
      Math.sin(a) * 1.5,
      { ry: -a + Math.PI / 2, rz: 0.0, rx: 0.21 }, // lean toward the centre
    );
    if (i % 2 === 0) {
      part(
        parts,
        new THREE.BoxGeometry(0.5, 0.3, 0.4),
        APAL.monumentLit,
        Math.cos(a) * 1.28,
        0.5 + h + 0.05,
        Math.sin(a) * 1.28,
        { ry: -a + Math.PI / 2 },
      );
    }
  }
  // banner fins in team colour — tall, proud of the core, Lit-tipped so the
  // team read survives at gameplay zoom
  for (const sgn of [1, -1] as const) {
    part(parts, new THREE.BoxGeometry(0.12, 2.3, 0.95), tb, sgn * 1.25, 2.35, 0, { ry: (Math.PI / 4) * sgn });
    part(
      parts,
      new THREE.BoxGeometry(0.14, 0.5, 1.0),
      TEAM_LIT[team] ?? APAL.azureLit,
      sgn * 1.28,
      3.6,
      0,
      { ry: (Math.PI / 4) * sgn },
    );
  }
  return parts;
}

/** The animated Ancient heart: team-base crystal shell + goldLit core (a Lit
 *  shell blows out to near-white under the sun — only the core may be Lit). */
function heartGeo(team: TeamId): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  part(parts, new THREE.OctahedronGeometry(0.55), TEAM_COLORS[team] ?? APAL.azure, 0, 0, 0);
  part(parts, new THREE.OctahedronGeometry(0.28), APAL.goldLit, 0, 0, 0);
  return mergeParts(parts);
}

function meleeCreepParts(team: TeamId): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const tb = TEAM_COLORS[team] ?? APAL.azure;
  const tl = TEAM_LIT[team] ?? APAL.azureLit;
  // squat soldier: legs, box torso, cylinder arms, flat helm, team plume
  part(parts, new THREE.CylinderGeometry(0.09, 0.1, 0.35, 6), APAL.stoneDeep, -0.13, 0.18, 0);
  part(parts, new THREE.CylinderGeometry(0.09, 0.1, 0.35, 6), APAL.stoneDeep, 0.13, 0.18, 0);
  part(parts, new THREE.BoxGeometry(0.5, 0.45, 0.34), APAL.monument, 0, 0.58, 0);
  part(parts, new THREE.CylinderGeometry(0.07, 0.08, 0.34, 6), APAL.stoneDeep, -0.3, 0.62, 0.04, { rz: 0.3 });
  part(parts, new THREE.CylinderGeometry(0.07, 0.08, 0.34, 6), APAL.stoneDeep, 0.3, 0.62, 0.04, { rz: -0.3 });
  part(parts, new THREE.CylinderGeometry(0.22, 0.26, 0.18, 8), APAL.stone, 0, 0.95, 0);
  // tall team-Lit plume — the silhouette's team read
  part(parts, new THREE.BoxGeometry(0.08, 0.26, 0.4), tl, 0, 1.16, -0.02);
  // team belt
  part(parts, new THREE.BoxGeometry(0.52, 0.11, 0.36), tb, 0, 0.42, 0);
  // slab shield with team boss
  part(parts, new THREE.BoxGeometry(0.1, 0.5, 0.42), APAL.stoneDeep, -0.36, 0.6, 0.1);
  part(parts, new THREE.CylinderGeometry(0.11, 0.11, 0.13, 6), tb, -0.41, 0.6, 0.1, { rz: Math.PI / 2 });
  return parts;
}

function rangedCreepParts(team: TeamId): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const tl = TEAM_LIT[team] ?? APAL.azureLit;
  // robed acolyte: cone robe, hood, glowing team-tinted orb hands
  part(parts, new THREE.ConeGeometry(0.32, 0.9, 8), APAL.monument, 0, 0.45, 0);
  part(parts, new THREE.ConeGeometry(0.2, 0.32, 8), APAL.stoneDeep, 0, 1.05, 0);
  part(parts, new THREE.SphereGeometry(0.09, 6, 5), APAL.inkDeep, 0, 0.98, 0.09);
  // team-Lit sash + oversized orb hands — the silhouette's team read
  part(parts, new THREE.BoxGeometry(0.36, 0.09, 0.22), tl, 0, 0.62, 0.08);
  part(parts, new THREE.SphereGeometry(0.13, 6, 5), tl, -0.32, 0.74, 0.12);
  part(parts, new THREE.SphereGeometry(0.13, 6, 5), tl, 0.32, 0.74, 0.12);
  return parts;
}

function siegeCreepParts(team: TeamId): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  // beetle-shaped stone ram on 4 legs, team banners
  part(parts, new THREE.SphereGeometry(0.55, 8, 6), APAL.stoneDeep, 0, 0.72, 0, { sx: 1.1, sy: 0.72, sz: 1.5 });
  part(parts, new THREE.BoxGeometry(0.5, 0.3, 0.7), APAL.monumentDeep, 0, 0.95, -0.3);
  part(parts, new THREE.BoxGeometry(0.42, 0.26, 0.5), APAL.monument, 0, 1.05, 0.35);
  // ram head
  part(parts, new THREE.BoxGeometry(0.34, 0.3, 0.45), APAL.monumentDeep, 0, 0.62, 0.95);
  part(parts, new THREE.CylinderGeometry(0.07, 0.07, 0.5, 6), APAL.stoneLit, 0, 0.62, 1.2, { rx: Math.PI / 2 });
  for (const sx of [-0.42, 0.42] as const) {
    for (const sz of [-0.5, 0.5] as const) {
      part(parts, new THREE.CylinderGeometry(0.07, 0.09, 0.55, 6), APAL.stoneDeep, sx, 0.28, sz);
    }
  }
  // banner poles + oversized team-Lit banners — the silhouette's team read
  for (const sx of [-0.25, 0.25] as const) {
    part(parts, new THREE.CylinderGeometry(0.03, 0.03, 0.85, 5), APAL.trunk, sx, 1.42, -0.5);
    part(parts, new THREE.BoxGeometry(0.05, 0.44, 0.34), TEAM_LIT[team] ?? APAL.azureLit, sx, 1.68, -0.36);
  }
  return parts;
}

function shadeParts(team: TeamId): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const tb = TEAM_COLORS[team] ?? APAL.azure;
  // summoned wraith: hooded cone + twin shade blades + team band
  part(parts, new THREE.ConeGeometry(0.3, 1.05, 7), APAL.shade, 0, 0.55, 0);
  part(parts, new THREE.SphereGeometry(0.16, 7, 6), APAL.void, 0, 1.12, 0.04);
  part(parts, new THREE.BoxGeometry(0.36, 0.07, 0.2), tb, 0, 0.7, 0.06);
  part(parts, new THREE.BoxGeometry(0.05, 0.42, 0.12), APAL.shade, -0.3, 0.75, 0.14, { rz: 0.5 });
  part(parts, new THREE.BoxGeometry(0.05, 0.42, 0.12), APAL.shade, 0.3, 0.75, 0.14, { rz: -0.5 });
  return parts;
}

/** Humanoid frame per visual.build; weapon/accent per hero. Nominal height is
 *  scaled to visual.height by the caller. */
function heroParts(hero: HeroId, team: TeamId): THREE.BufferGeometry[] {
  const def = heroById(hero);
  const parts: THREE.BufferGeometry[] = [];
  const tb = TEAM_COLORS[team] ?? APAL.azure;
  const accent = accentHex(def.visual.accent);
  const build = def.visual.build;
  const torsoW = build === 'bulky' ? 0.62 : build === 'standard' ? 0.5 : 0.4;
  const torsoH = build === 'bulky' ? 0.6 : build === 'standard' ? 0.55 : 0.5;
  const torsoD = build === 'bulky' ? 0.42 : build === 'standard' ? 0.34 : 0.28;
  const hipY = 0.55;
  const torsoY = hipY + torsoH / 2;
  const shoulderY = hipY + torsoH - 0.08;
  const headY = hipY + torsoH + 0.24;

  // legs + boots
  part(parts, new THREE.CylinderGeometry(0.1, 0.11, 0.5, 6), APAL.stoneDeep, -torsoW * 0.26, 0.28, 0);
  part(parts, new THREE.CylinderGeometry(0.1, 0.11, 0.5, 6), APAL.stoneDeep, torsoW * 0.26, 0.28, 0);
  // torso armour
  part(parts, new THREE.BoxGeometry(torsoW, torsoH, torsoD), APAL.monumentDeep, 0, torsoY, 0);
  // team tabard stripe
  part(parts, new THREE.BoxGeometry(torsoW * 0.4, torsoH * 0.85, 0.03), tb, 0, torsoY - 0.03, torsoD / 2 + 0.01);
  // pauldrons (stacked plates on bulky)
  const plates = build === 'bulky' ? 2 : 1;
  for (let p = 0; p < plates; p++) {
    for (const sgn of [-1, 1] as const) {
      part(
        parts,
        new THREE.BoxGeometry(0.22, 0.1, 0.26),
        APAL.monument,
        sgn * (torsoW / 2 + 0.1),
        shoulderY + p * 0.11,
        0,
      );
    }
  }
  // arms
  part(parts, new THREE.CylinderGeometry(0.07, 0.08, 0.42, 6), APAL.stoneDeep, -torsoW / 2 - 0.1, shoulderY - 0.24, 0.03, { rz: 0.18 });
  part(parts, new THREE.CylinderGeometry(0.07, 0.08, 0.42, 6), APAL.stoneDeep, torsoW / 2 + 0.1, shoulderY - 0.24, 0.03, { rz: -0.18 });
  // helm + team plume
  part(parts, new THREE.CylinderGeometry(0.16, 0.19, 0.22, 8), APAL.monument, 0, headY, 0);
  part(parts, new THREE.BoxGeometry(0.05, 0.16, 0.3), tb, 0, headY + 0.18, -0.04);

  // --- weapon + accent per hero -------------------------------------------
  if (hero === 'bullwark') {
    // tower shield with pine boss
    part(parts, new THREE.BoxGeometry(0.12, 0.9, 0.6), APAL.stoneDeep, -torsoW / 2 - 0.24, 0.75, 0.12);
    part(parts, new THREE.CylinderGeometry(0.12, 0.12, 0.14, 6), accent, -torsoW / 2 - 0.3, 0.75, 0.12, { rz: Math.PI / 2 });
    part(parts, new THREE.BoxGeometry(0.14, 0.12, 0.62), tb, -torsoW / 2 - 0.24, 1.1, 0.12);
  } else if (hero === 'reaver') {
    // greatblade with a gold edge
    part(parts, new THREE.BoxGeometry(0.07, 1.25, 0.2), APAL.monumentLit, torsoW / 2 + 0.22, 1.0, 0.15, { rz: -0.35 });
    part(parts, new THREE.BoxGeometry(0.03, 1.25, 0.06), accent, torsoW / 2 + 0.3, 1.0, 0.15, { rz: -0.35 });
    part(parts, new THREE.CylinderGeometry(0.045, 0.045, 0.3, 6), APAL.trunk, torsoW / 2 + 0.14, 0.48, 0.15, { rz: -0.35 });
  } else if (hero === 'mender') {
    // staff with a heal orb
    part(parts, new THREE.CylinderGeometry(0.04, 0.05, 1.5, 6), APAL.trunk, torsoW / 2 + 0.2, 0.85, 0.1);
    part(parts, new THREE.SphereGeometry(0.12, 7, 6), accent, torsoW / 2 + 0.2, 1.68, 0.1);
    part(parts, new THREE.TorusGeometry(0.16, 0.03, 5, 10), APAL.goldLit, torsoW / 2 + 0.2, 1.68, 0.1);
  } else if (hero === 'longbow') {
    // longbow (3-segment arc) + frost string + quiver
    part(parts, new THREE.BoxGeometry(0.05, 0.55, 0.08), APAL.trunk, torsoW / 2 + 0.28, 1.05, 0.1, { rz: -0.5 });
    part(parts, new THREE.BoxGeometry(0.05, 0.55, 0.08), APAL.trunk, torsoW / 2 + 0.28, 0.55, 0.1, { rz: 0.5 });
    part(parts, new THREE.BoxGeometry(0.05, 0.3, 0.08), APAL.trunk, torsoW / 2 + 0.3, 0.8, 0.1);
    part(parts, new THREE.BoxGeometry(0.012, 0.95, 0.012), accent, torsoW / 2 + 0.13, 0.8, 0.1);
    part(parts, new THREE.CylinderGeometry(0.09, 0.09, 0.5, 6), APAL.trunk, -0.12, 1.05, -torsoD / 2 - 0.08, { rx: 0.25 });
    part(parts, new THREE.CylinderGeometry(0.02, 0.02, 0.3, 4), APAL.stoneLit, -0.12, 1.32, -torsoD / 2 - 0.12, { rx: 0.25 });
  } else if (hero === 'hex') {
    // floating rings + void core
    part(parts, new THREE.TorusGeometry(0.42, 0.035, 5, 14), accent, 0, torsoY + 0.1, 0, { rx: Math.PI / 2.4 });
    part(parts, new THREE.TorusGeometry(0.58, 0.03, 5, 16), APAL.arcane, 0, torsoY, 0, { rx: -Math.PI / 2.6 });
    part(parts, new THREE.SphereGeometry(0.13, 7, 6), accent, 0, torsoY + 0.05, torsoD / 2 + 0.04);
  } else {
    // shade: twin daggers + team scarf
    part(parts, new THREE.BoxGeometry(0.04, 0.5, 0.1), accent, -torsoW / 2 - 0.2, 0.55, 0.18, { rz: 0.55 });
    part(parts, new THREE.BoxGeometry(0.04, 0.5, 0.1), accent, torsoW / 2 + 0.2, 0.55, 0.18, { rz: -0.55 });
    part(parts, new THREE.BoxGeometry(torsoW + 0.1, 0.12, torsoD + 0.08), TEAM_LIT[team] ?? APAL.azureLit, 0, shoulderY + 0.05, 0);
    part(parts, new THREE.BoxGeometry(0.16, 0.5, 0.04), TEAM_LIT[team] ?? APAL.azureLit, -torsoW / 2 + 0.05, shoulderY - 0.25, -torsoD / 2 - 0.06, { rx: 0.2 });
  }
  return parts;
}

function wardParts(team: TeamId): { body: THREE.BufferGeometry; eye: THREE.BufferGeometry } {
  const parts: THREE.BufferGeometry[] = [];
  part(parts, new THREE.BoxGeometry(0.3, 0.12, 0.3), APAL.stoneDeep, 0, 0.06, 0);
  part(parts, new THREE.CylinderGeometry(0.07, 0.15, 0.85, 4), APAL.monument, 0, 0.55, 0);
  part(parts, new THREE.CylinderGeometry(0.09, 0.09, 0.06, 4), TEAM_COLORS[team] ?? APAL.azure, 0, 0.99, 0);
  const eyeParts: THREE.BufferGeometry[] = [];
  part(eyeParts, new THREE.SphereGeometry(0.1, 7, 6), APAL.ward, 0, 0, 0);
  return { body: mergeParts(parts), eye: mergeParts(eyeParts) };
}

/** Projectile: elongated glowing body tipped in the school colour. */
function projGeo(school: 'phys' | 'magic' | 'heal'): THREE.BufferGeometry {
  const tip =
    school === 'phys' ? APAL.paper : school === 'heal' ? APAL.heal : APAL.arcane;
  const body = mix(tip, APAL.paper, 0.4);
  const parts: THREE.BufferGeometry[] = [];
  part(parts, new THREE.OctahedronGeometry(0.13), body, 0, 0, -0.08, { sz: 1.8 });
  part(parts, new THREE.OctahedronGeometry(0.09), tip, 0, 0, 0.22, { sz: 1.5 });
  return mergeParts(parts);
}

// ---- variant cache -----------------------------------------------------------------

type AnimKind = 'orbit' | 'bob' | 'pulse';

interface Variant {
  readonly body: THREE.BufferGeometry;
  readonly anim: THREE.BufferGeometry | null;
  readonly animKind: AnimKind | null;
  /** Local anchor of the animated part (crystal/heart/eye home position). */
  readonly animY: number;
  readonly barH: number;
  readonly barW: number;
}

function buildVariant(kind: EntKind, hero: HeroId | undefined, team: TeamId): Variant {
  switch (kind) {
    case 'tower':
      return { body: mergeParts(towerParts(team, false)), anim: crystalGeo(team), animKind: 'orbit', animY: 4.1, barH: 4.5, barW: 1.9 };
    case 'guard':
      return { body: mergeParts(towerParts(team, true)), anim: crystalGeo(team), animKind: 'orbit', animY: 4.7, barH: 5.1, barW: 1.9 };
    case 'ancient':
      return { body: mergeParts(ancientParts(team)), anim: heartGeo(team), animKind: 'bob', animY: 4.6, barH: 6.6, barW: 2.6 };
    case 'melee':
      return { body: mergeParts(meleeCreepParts(team)), anim: null, animKind: null, animY: 0, barH: 1.5, barW: 0.75 };
    case 'ranged':
      return { body: mergeParts(rangedCreepParts(team)), anim: null, animKind: null, animY: 0, barH: 1.6, barW: 0.75 };
    case 'siege':
      return { body: mergeParts(siegeCreepParts(team)), anim: null, animKind: null, animY: 0, barH: 1.95, barW: 1.05 };
    case 'shade':
      return { body: mergeParts(shadeParts(team)), anim: null, animKind: null, animY: 0, barH: 1.55, barW: 0.75 };
    case 'hero': {
      const h = hero ?? 'reaver';
      const scale = heroById(h).visual.height / 1.8;
      const body = mergeParts(heroParts(h, team));
      body.scale(scale, scale, scale);
      return { body, anim: null, animKind: null, animY: 0, barH: heroById(h).visual.height + 0.5, barW: 1.05 };
    }
    case 'ward': {
      const w = wardParts(team);
      return { body: w.body, anim: w.eye, animKind: 'pulse', animY: 1.06, barH: 0, barW: 0 };
    }
    case 'proj':
      // projectiles live in their own pool; never reach buildVariant
      break;
  }
  // unreachable in practice — 'proj' is diverted before this call
  return { body: mergeParts(shadeParts(team)), anim: null, animKind: null, animY: 0, barH: 1.5, barW: 0.95 };
}

// ---- slots --------------------------------------------------------------------------

interface UnitSlot {
  mesh: THREE.Mesh;
  anim: THREE.Mesh | null;
  variant: Variant;
  /** Variant cache/freelist key — set once at creation, never changes. */
  vkey: string;
  id: number;
  kind: EntKind;
  team: TeamId;
  yaw: number;
  lastX: number;
  lastZ: number;
  phase: number;
}

interface ProjSlot {
  mesh: THREE.Mesh;
  id: number;
  lastX: number;
  lastZ: number;
}

function projSchool(fx: string | undefined): 'phys' | 'magic' | 'heal' {
  if (fx !== undefined) {
    const s = fx.toLowerCase();
    if (s.includes('physical') || s.includes('phys')) return 'phys';
    if (s.includes('heal')) return 'heal';
  }
  return 'magic';
}

// ---- createUnits ---------------------------------------------------------------------

export function createUnits(scene: SceneHandle, map: MapDef): UnitsHandle {
  const core: SceneCore = sceneCore(scene);
  const vertexMat = core.vertexMat();

  const variantCache = new Map<string, Variant>();
  const variantOf = (kind: EntKind, hero: HeroId | undefined, team: TeamId): Variant => {
    const key = `${kind}:${hero ?? '-'}:${String(team)}`;
    let v = variantCache.get(key);
    if (!v) {
      v = buildVariant(kind, hero, team);
      variantCache.set(key, v);
    }
    return v;
  };

  const active = new Map<number, UnitSlot>();
  const freeByKey = new Map<string, UnitSlot[]>();
  const seen = new Set<number>();

  function acquire(e: InterpEnt): UnitSlot {
    const key = `${e.k}:${e.hero ?? '-'}:${String(e.team)}`;
    let slot = active.get(e.id);
    if (slot) return slot;
    const free = freeByKey.get(key);
    const pooled = free?.pop();
    if (pooled) {
      slot = pooled;
    } else {
      const variant = variantOf(e.k, e.hero, e.team);
      const mesh = new THREE.Mesh(variant.body, vertexMat);
      mesh.castShadow = true;
      let anim: THREE.Mesh | null = null;
      if (variant.anim) {
        anim = new THREE.Mesh(variant.anim, vertexMat);
        core.three.add(anim);
      }
      slot = {
        mesh,
        anim,
        variant,
        vkey: key,
        id: e.id,
        kind: e.k,
        team: e.team,
        yaw: 0,
        lastX: e.x,
        lastZ: e.z,
        phase: (e.id % 97) * 0.651, // deterministic spread, no rng needed
      };
      core.three.add(mesh);
      core.registerPick(mesh);
    }
    slot.id = e.id;
    slot.kind = e.k;
    slot.team = e.team;
    slot.mesh.visible = true;
    slot.mesh.scale.set(1, 1, 1);
    if (slot.anim) slot.anim.visible = true;
    slot.mesh.userData['entId'] = e.id;
    active.set(e.id, slot);
    return slot;
  }

  function release(id: number, slot: UnitSlot): void {
    slot.mesh.visible = false;
    if (slot.anim) slot.anim.visible = false;
    slot.mesh.userData['entId'] = -1;
    active.delete(id);
    let list = freeByKey.get(slot.vkey);
    if (!list) {
      list = [];
      freeByKey.set(slot.vkey, list);
    }
    list.push(slot);
  }

  // ---- HP bars: TWO InstancedMesh total -----------------------------------------
  const barTilt = THREE.MathUtils.degToRad(-(180 - CAMERA_PITCH_DEG));
  const barGeoBg = new THREE.PlaneGeometry(1, 1).rotateX(barTilt);
  const barGeoFill = new THREE.PlaneGeometry(1, 1).rotateX(barTilt);
  const barBgMat = new THREE.MeshLambertMaterial({ color: APAL.inkDeep, side: THREE.DoubleSide });
  const barFillMat = new THREE.MeshLambertMaterial({ color: APAL.paper, side: THREE.DoubleSide });
  const barBg = new THREE.InstancedMesh(barGeoBg, barBgMat, BAR_CAP);
  const barFill = new THREE.InstancedMesh(barGeoFill, barFillMat, BAR_CAP);
  barBg.frustumCulled = false;
  barFill.frustumCulled = false;
  barBg.renderOrder = 40;
  barFill.renderOrder = 41;
  core.three.add(barBg);
  core.three.add(barFill);
  const barM = new THREE.Matrix4();
  const barC = new THREE.Color();
  // camera-facing nudge so fills sit proud of backgrounds
  const nY = Math.sin(THREE.MathUtils.degToRad(CAMERA_PITCH_DEG)) * 0.03;
  const nZ = -Math.cos(THREE.MathUtils.degToRad(CAMERA_PITCH_DEG)) * 0.03;

  // ---- team SHAPE markers (accessibility: team reads by shape, not hue only) --
  // azure = upward chevron, ember = diamond — two more InstancedMesh, one per
  // team, emissive-locked so the small shape reads against any backdrop.
  const chevronGeo = ((): THREE.BufferGeometry => {
    const arms: THREE.BufferGeometry[] = [];
    part(arms, new THREE.BoxGeometry(0.3, 0.075, 0.05), APAL.paper, -0.13, 0, 0, { rz: 0.72 });
    part(arms, new THREE.BoxGeometry(0.3, 0.075, 0.05), APAL.paper, 0.13, 0, 0, { rz: -0.72 });
    const g = mergeParts(arms);
    g.deleteAttribute('color'); // instanced material carries the colour
    g.rotateX(barTilt);
    return g;
  })();
  const diamondGeo = ((): THREE.BufferGeometry => {
    const g = new THREE.OctahedronGeometry(0.17);
    g.scale(1, 0.62, 0.5);
    g.rotateX(barTilt);
    return g;
  })();
  const markerMatOf = (team: TeamId): THREE.MeshLambertMaterial =>
    new THREE.MeshLambertMaterial({
      color: APAL.inkDeep, // lit contribution ≈ black; emissive carries the read
      emissive: TEAM_LIT[team] ?? APAL.azureLit,
      side: THREE.DoubleSide,
    });
  const markChevron = new THREE.InstancedMesh(chevronGeo, markerMatOf(0), BAR_CAP);
  const markDiamond = new THREE.InstancedMesh(diamondGeo, markerMatOf(1), BAR_CAP);
  markChevron.frustumCulled = false;
  markDiamond.frustumCulled = false;
  markChevron.renderOrder = 42;
  markDiamond.renderOrder = 42;
  core.three.add(markChevron);
  core.three.add(markDiamond);
  let markCount0 = 0;
  let markCount1 = 0;

  // bar scratch buffers (reused every sync — no per-frame allocation)
  const barXs = new Float32Array(BAR_CAP);
  const barYs = new Float32Array(BAR_CAP);
  const barZs = new Float32Array(BAR_CAP);
  const barWs = new Float32Array(BAR_CAP);
  const barFracs = new Float32Array(BAR_CAP);
  const barTeams = new Int8Array(BAR_CAP); // 0 self, 1 ally, 2 enemy
  const markTeams = new Int8Array(BAR_CAP); // absolute TeamId per bar slot
  let barCount = 0;

  // ---- ghosts ---------------------------------------------------------------------
  const ghostPool: { mesh: THREE.Mesh; mat: THREE.MeshLambertMaterial; id: number }[] = [];
  for (let i = 0; i < GHOST_CAP; i++) {
    const mat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      flatShading: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(variantOf('shade', undefined, 0).body, mat);
    mesh.visible = false;
    core.three.add(mesh);
    ghostPool.push({ mesh, mat, id: -1 });
  }

  // ---- selection ring, self ring, order marker --------------------------------------
  const selMat = new THREE.MeshLambertMaterial({ color: APAL.gold, transparent: true, opacity: 0.9 });
  const selRing = new THREE.Mesh(
    new THREE.RingGeometry(0.85, 1.05, 28).rotateX(-Math.PI / 2),
    selMat,
  );
  selRing.position.y = 0.05;
  selRing.visible = false;
  core.three.add(selRing);
  let selectedId = -1;

  const selfRing = new THREE.Mesh(
    new THREE.RingGeometry(0.62, 0.78, 24).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: APAL.heal, transparent: true, opacity: 0.55 }),
  );
  selfRing.position.y = 0.045;
  selfRing.visible = false;
  core.three.add(selfRing);

  const markerMat = new THREE.MeshLambertMaterial({ color: APAL.heal, transparent: true, opacity: 0 });
  const marker = new THREE.Group();
  const markerRing = new THREE.Mesh(
    new THREE.RingGeometry(0.32, 0.46, 20).rotateX(-Math.PI / 2),
    markerMat,
  );
  const markerDot = new THREE.Mesh(new THREE.CircleGeometry(0.1, 12).rotateX(-Math.PI / 2), markerMat);
  markerDot.position.y = 0.002;
  marker.add(markerRing);
  marker.add(markerDot);
  marker.position.y = 0.06;
  marker.visible = false;
  core.three.add(marker);
  let markerAge = 1e9;

  // ---- projectiles ------------------------------------------------------------------
  const projGeos = new Map<string, THREE.BufferGeometry>();
  const projActive = new Map<number, ProjSlot>();
  const projFree = new Map<string, ProjSlot[]>();
  let projCreated = 0;

  function acquireProj(e: InterpEnt): ProjSlot | null {
    const existing = projActive.get(e.id);
    if (existing) return existing;
    const school = projSchool(e.fx);
    let slot: ProjSlot | undefined = projFree.get(school)?.pop();
    if (!slot) {
      if (projCreated >= PROJ_CAP) return null; // pool exhausted: skip silently
      let geo = projGeos.get(school);
      if (!geo) {
        geo = projGeo(school);
        projGeos.set(school, geo);
      }
      slot = { mesh: new THREE.Mesh(geo, vertexMat), id: e.id, lastX: e.x, lastZ: e.z };
      projCreated++;
      core.three.add(slot.mesh);
    }
    slot.id = e.id;
    slot.lastX = e.x;
    slot.lastZ = e.z;
    slot.mesh.visible = true;
    slot.mesh.userData['school'] = school;
    projActive.set(e.id, slot);
    return slot;
  }

  // ---- animation clock (advance()s off render dt, never Date.now) -------------------
  let clock = 0;
  core.addFrameHook((dtMs) => {
    const dt = dtMs / 1000;
    clock += dt;
    for (const slot of active.values()) {
      const anim = slot.anim;
      if (!anim || !anim.visible) continue;
      const bx = slot.mesh.position.x;
      const bz = slot.mesh.position.z;
      if (slot.variant.animKind === 'orbit') {
        const a = clock * 0.7 + slot.phase;
        anim.position.set(bx + Math.cos(a) * 0.55, slot.variant.animY, bz + Math.sin(a) * 0.55);
        anim.rotation.y = a * 2;
      } else if (slot.variant.animKind === 'bob') {
        anim.position.set(bx, slot.variant.animY + Math.sin(clock * 1.1 + slot.phase) * 0.3, bz);
        anim.rotation.y = clock * 0.5 + slot.phase;
      } else {
        const s = 1 + 0.22 * Math.sin(clock * 2.4 + slot.phase);
        anim.scale.set(s, s, s);
        anim.position.set(bx, slot.variant.animY, bz);
      }
    }
    // order marker ping
    if (marker.visible) {
      markerAge += dt;
      const t = markerAge / 0.55;
      if (t >= 1) {
        marker.visible = false;
      } else {
        const s = 1.35 - t * 0.55;
        marker.scale.set(s, 1, s);
        markerMat.opacity = 0.85 * (1 - t);
      }
    }
    // selection ring pulse
    if (selRing.visible) {
      const s = 1 + 0.05 * Math.sin(clock * 3);
      selRing.scale.set(s, 1, s);
    }
  });

  // ---- sync ---------------------------------------------------------------------------
  function sync(ents: readonly InterpEnt[], ghosts: readonly GhostEnt[], selfId: number): void {
    seen.clear();
    let selfTeam: TeamId = 0;
    for (const e of ents) {
      if (e.id === selfId) {
        selfTeam = e.team;
        break;
      }
    }

    barCount = 0;
    markCount0 = 0;
    markCount1 = 0;
    for (const e of ents) {
      seen.add(e.id);
      if (e.k === 'proj') {
        const ps = acquireProj(e);
        if (ps) {
          ps.mesh.position.set(e.x, 1.1, e.z);
          let dx = 0;
          let dz = 1;
          if (e.tx !== undefined && e.tz !== undefined) {
            dx = e.tx - e.x;
            dz = e.tz - e.z;
          } else {
            dx = e.x - ps.lastX;
            dz = e.z - ps.lastZ;
          }
          if (Math.hypot(dx, dz) > 1e-4) ps.mesh.rotation.y = Math.atan2(dx, dz);
          ps.lastX = e.x;
          ps.lastZ = e.z;
        }
        continue;
      }

      const slot = acquire(e);
      slot.mesh.position.set(e.x, 0, e.z);

      // facing: snap yaw to motion direction (interp deltas are per-frame small)
      if (e.k !== 'tower' && e.k !== 'guard' && e.k !== 'ancient' && e.k !== 'ward') {
        const dx = e.x - slot.lastX;
        const dz = e.z - slot.lastZ;
        if (dx * dx + dz * dz > 0.0004) {
          slot.yaw = Math.atan2(dx, dz);
          slot.mesh.rotation.y = slot.yaw;
        }
      }
      slot.lastX = e.x;
      slot.lastZ = e.z;

      const isStructure = e.k === 'tower' || e.k === 'guard' || e.k === 'ancient';
      const destroyed = isStructure && e.hp <= 0;
      if (destroyed) {
        // collapse to a rubble stump; the animated part winks out
        slot.mesh.scale.y = 0.18;
        if (slot.anim) slot.anim.visible = false;
        slot.mesh.userData['entId'] = -1;
      }

      // hp bars: heroes/creeps always; structures only when damaged; wards never
      const showBar =
        !destroyed &&
        e.k !== 'ward' &&
        (!isStructure || e.hp < e.maxHp) &&
        barCount < BAR_CAP;
      if (showBar) {
        const i = barCount++;
        barXs[i] = e.x;
        barYs[i] = slot.variant.barH;
        barZs[i] = e.z;
        barWs[i] = slot.variant.barW;
        barFracs[i] = e.maxHp > 0 ? Math.max(0, Math.min(1, e.hp / e.maxHp)) : 0;
        barTeams[i] = e.id === selfId ? 0 : e.team === selfTeam ? 1 : 2;
        markTeams[i] = e.team;
      }
    }

    // release vanished units (ghosts cover the visual fade)
    for (const [id, slot] of active) {
      if (!seen.has(id)) release(id, slot);
    }
    for (const [id, ps] of projActive) {
      if (!seen.has(id)) {
        ps.mesh.visible = false;
        projActive.delete(id);
        const school = (ps.mesh.userData['school'] as string | undefined) ?? 'magic';
        let list = projFree.get(school);
        if (!list) {
          list = [];
          projFree.set(school, list);
        }
        list.push(ps);
      }
    }

    // ---- ghosts ----------------------------------------------------------------------
    const ghostSeen = new Set<number>();
    for (const g of ghosts) {
      ghostSeen.add(g.id);
      let slot = ghostPool.find((s) => s.id === g.id);
      if (!slot) {
        slot = ghostPool.find((s) => s.id === -1);
        if (!slot) continue; // pool exhausted: skip the fade, never throw
        slot.id = g.id;
        const v = variantOf(g.k === 'proj' ? 'shade' : g.k, undefined, g.team);
        slot.mesh.geometry = v.body;
      }
      slot.mesh.visible = true;
      slot.mesh.position.set(g.x, 0, g.z);
      slot.mat.opacity = 0.55 * Math.max(0, Math.min(1, g.fade));
    }
    for (const s of ghostPool) {
      if (s.id !== -1 && !ghostSeen.has(s.id)) {
        s.id = -1;
        s.mesh.visible = false;
      }
    }

    // ---- hp bar instances --------------------------------------------------------------
    for (let i = 0; i < barCount; i++) {
      const x = barXs[i] ?? 0;
      const y = barYs[i] ?? 0;
      const z = barZs[i] ?? 0;
      const w = barWs[i] ?? 1;
      const frac = barFracs[i] ?? 0;
      barM.makeScale(w, 0.085, 1);
      barM.setPosition(x, y, z);
      barBg.setMatrixAt(i, barM);
      const fw = Math.max(0.001, (w - 0.05) * frac);
      const xoff = -(w - 0.05) / 2 + fw / 2;
      barM.makeScale(fw, 0.05, 1);
      barM.setPosition(x + xoff, y + nY, z + nZ);
      barFill.setMatrixAt(i, barM);
      const kind = barTeams[i];
      barC.set(
        kind === 0
          ? APAL.heal
          : kind === 1
            ? (TEAM_COLORS[selfTeam] ?? APAL.azure)
            : APAL.danger,
      );
      barFill.setColorAt(i, barC);
      // team shape marker floats just above the bar
      barM.makeScale(1, 1, 1);
      barM.setPosition(x, y + 0.3, z);
      if (markTeams[i] === 0) {
        markChevron.setMatrixAt(markCount0++, barM);
      } else {
        markDiamond.setMatrixAt(markCount1++, barM);
      }
    }
    barBg.count = barCount;
    barFill.count = barCount;
    barBg.instanceMatrix.needsUpdate = true;
    barFill.instanceMatrix.needsUpdate = true;
    if (barFill.instanceColor) barFill.instanceColor.needsUpdate = true;
    markChevron.count = markCount0;
    markDiamond.count = markCount1;
    markChevron.instanceMatrix.needsUpdate = true;
    markDiamond.instanceMatrix.needsUpdate = true;

    // ---- rings --------------------------------------------------------------------------
    const sel = selectedId >= 0 ? active.get(selectedId) : undefined;
    if (sel && sel.mesh.visible) {
      selRing.visible = true;
      selRing.position.set(sel.mesh.position.x, 0.05, sel.mesh.position.z);
    } else {
      selRing.visible = false;
    }
    const self = selfId >= 0 ? active.get(selfId) : undefined;
    if (self && self.mesh.visible) {
      selfRing.visible = true;
      selfRing.position.set(self.mesh.position.x, 0.045, self.mesh.position.z);
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
      markerMat.color.set(attack ? APAL.danger : APAL.heal);
      marker.position.set(x, 0.06, z);
      marker.visible = true;
      markerAge = 0;
    },
  };
}

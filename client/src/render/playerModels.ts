// ============================================================================
// C4 — soldier models + animation. One blocky humanoid per remote player,
// driven by interpolated PlayerSnaps. See CONTRACT.md "Soldier" model sheet.
// Invariants:
// - root group sits at FEET with yaw; `body` child carries crouch offset +
//   death tilt so the two never fight over one Euler.
// - meshes come only from contract factories; nameplate sprite is the
//   sanctioned CanvasTexture exception (colors still PALETTE-derived).
// - limb/weapon pivots stay unbaked (animated); nothing allocates per frame —
//   models, pivots, flash quads are all reused, scalars only in sync().
// - factory geometries/materials are shared caches: on removal dispose ONLY
//   nameplate textures/materials, never geometries.
// ============================================================================
import * as THREE from 'three';
import { PALETTE, type PlayerId, type PlayerSnap, type Team, type WeaponId } from '@fps/shared';
import { at, box, mat } from '../contract/visual.js';
import { makeWeaponModel } from './viewModel.js';

// ---- frozen animation tuning (from CONTRACT.md / C4 spec) -------------------
const WALK_SWING_RAD = (25 * Math.PI) / 180; // legs/arms swing amplitude
const PHASE_RATE = 2.2; // walk phase advance per (m/s * s)
const PITCH_CLAMP = 0.6; // rad, applied to the weapon arm pivot only
const BREATHE_HZ = 2;
const BREATHE_AMP = 0.02; // torso scaleY ±
const CROUCH_LEG_SCALE = 0.6;
const CROUCH_DROP = 0.35; // body y offset so scaled legs keep feet planted
const DEATH_FALL_S = 0.4; // rotate to lying
const DEATH_SINK_AT = 2; // sink starts
const DEATH_SINK_S = 1; // 1u over this long
const DEATH_KEEP_S = 3; // corpse hidden after this
const MUZZLE_FLASH_S = 0.05;
const WEAPON_SCALE = 0.9;

// arm rest pose: hanging arms rotated forward to hold the weapon
const ARM_BASE_R = 1.15; // right arm bent up under the grip
const ARM_BASE_L = 0.95; // left arm forward to the handguard

// ---- geometry layout (units, total height ~1.8u) ----------------------------
const HIP_Y = 0.85;
const LEG_H = 0.85;
const SHOULDER_Y = 1.38;
const ARM_H = 0.58;
const HEAD_Y = 1.58;
const HELMET_Y = 1.68;
const NAMEPLATE_Y = 2.1; // ~0.35u above the head
const MUZZLE_TIP_Z = -0.55; // gun tip inside weapon-holder space

function chestHex(team: Team): string {
  return team === 'CT' ? PALETTE.ctBlue : PALETTE.tAmber;
}
function darkHex(team: Team): string {
  return team === 'CT' ? PALETTE.ctDark : PALETTE.tBrown;
}

// ---- nameplate (CanvasTexture sprite — contract exception) -------------------
function hexRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** team-color-tinted ink strip, as `rgb()` css; both inputs from PALETTE. */
function tintCss(inkHex: string, teamHex: string): string {
  const [ir, ig, ib] = hexRgb(inkHex);
  const [tr, tg, tb] = hexRgb(teamHex);
  const m = (a: number, b: number): number => Math.round(a * 0.45 + b * 0.55);
  return `rgb(${m(ir, tr)},${m(ig, tg)},${m(ib, tb)})`;
}

function drawNameplate(canvas: HTMLCanvasElement, name: string, team: Team): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return; // canvas unsupported: sprite keeps a blank texture, model still works
  const teamHex = chestHex(team);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // translucent team-tinted ink strip + solid team accent bar (never color alone:
  // white text carries the name, bar carries the team)
  ctx.globalAlpha = 0.72;
  ctx.fillStyle = tintCss(PALETTE.ink, teamHex);
  ctx.fillRect(0, 8, canvas.width, 48);
  ctx.globalAlpha = 1;
  ctx.fillStyle = teamHex;
  ctx.fillRect(0, 50, canvas.width, 6);
  ctx.fillStyle = PALETTE.hudText;
  ctx.font = 'bold 30px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name.trim().slice(0, 14) || '?', canvas.width / 2, 33);
}

function makeNameplate(name: string, team: Team): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  drawNameplate(canvas, name, team);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  sprite.scale.set(1.4, 0.35, 1);
  return sprite;
}

function disposeNameplate(sprite: THREE.Sprite): void {
  const material = sprite.material;
  if (material.map) material.map.dispose();
  material.dispose();
}

// ---- per-player model --------------------------------------------------------
interface Soldier {
  root: THREE.Group; // feet anchor: position + yaw (+ corpse sink)
  body: THREE.Group; // crouch drop + death tilt
  torso: THREE.Mesh;
  helmet: THREE.Mesh;
  limbMeshes: THREE.Mesh[]; // arms + legs (team dark; retinted on side swap)
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  weaponHolder: THREE.Group; // child of armR; counter-rotated so pitch reads clean
  weaponMesh: THREE.Group;
  weapon: WeaponId;
  nameplate: THREE.Sprite;
  muzzleGroup: THREE.Group;
  team: Team;
  name: string;
  // animation state (scalars only)
  walkPhase: number;
  swingAmp: number; // eased 0..1 walk-vs-idle blend
  breathe: number;
  crouchAmt: number;
  dead: boolean;
  deathT: number;
  flashT: number;
  flashRoll: number; // deterministic roll steps, no Math.random
  lastX: number;
  lastZ: number;
  seen: number; // frame stamp for mark-and-sweep removal
}

export class PlayerModels {
  private readonly scene: THREE.Scene;
  private readonly models = new Map<PlayerId, Soldier>();
  private frame = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  private create(p: PlayerSnap & { team: Team; name: string }): Soldier {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);

    const chest = chestHex(p.team);
    const dark = darkHex(p.team);

    const torso = at(box(0.46, 0.6, 0.26, chest), 0, 1.15, 0);
    const head = at(box(0.26, 0.26, 0.26, PALETTE.skin), 0, HEAD_Y, 0);
    const helmet = at(box(0.3, 0.14, 0.3, dark), 0, HELMET_Y, 0); // slightly wider, caps the head
    body.add(torso, head, helmet);

    // leg pivots at hips; mesh hangs to the ground so scaleY crouches around the hip
    const legL = at(new THREE.Group(), -0.12, HIP_Y, 0);
    const legR = at(new THREE.Group(), 0.12, HIP_Y, 0);
    const legLMesh = at(box(0.16, LEG_H, 0.18, dark), 0, -LEG_H / 2, 0);
    const legRMesh = at(box(0.16, LEG_H, 0.18, dark), 0, -LEG_H / 2, 0);
    legL.add(legLMesh);
    legR.add(legRMesh);
    body.add(legL, legR);

    // arm pivots at shoulders, posed forward onto the weapon
    const armL = at(new THREE.Group(), -0.29, SHOULDER_Y, 0);
    const armR = at(new THREE.Group(), 0.29, SHOULDER_Y, 0);
    const armLMesh = at(box(0.12, ARM_H, 0.14, dark), 0, -ARM_H / 2, 0);
    const armRMesh = at(box(0.12, ARM_H, 0.14, dark), 0, -ARM_H / 2, 0);
    armL.add(armLMesh);
    armR.add(armRMesh);
    armL.rotation.x = ARM_BASE_L;
    armL.rotation.z = 0.25; // reaches in toward the handguard
    armR.rotation.x = ARM_BASE_R;
    armR.rotation.z = -0.1;
    body.add(armL, armR);

    // weapon rides the right hand; holder undoes the arm's base angle so the
    // weapon sits level and only snap.pitch tilts it
    const weaponHolder = at(new THREE.Group(), 0, -ARM_H + 0.04, 0);
    weaponHolder.rotation.x = -ARM_BASE_R;
    const weaponMesh = makeWeaponModel(p.weapon);
    weaponMesh.scale.setScalar(WEAPON_SCALE);
    weaponMesh.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    weaponHolder.add(weaponMesh);
    armR.add(weaponHolder);

    // muzzle flash: 2 crossed emissive quads (thin boxes stay factory-legal),
    // pre-built hidden and toggled — no allocation on fire
    const muzzleGroup = at(new THREE.Group(), 0, 0.05, MUZZLE_TIP_Z);
    const flashMat = { emissive: PALETTE.muzzle };
    muzzleGroup.add(box(0.02, 0.3, 0.34, PALETTE.muzzle, flashMat));
    muzzleGroup.add(box(0.3, 0.02, 0.34, PALETTE.muzzle, flashMat));
    muzzleGroup.visible = false;
    weaponHolder.add(muzzleGroup);

    const nameplate = at(makeNameplate(p.name, p.team), 0, NAMEPLATE_Y, 0);
    body.add(nameplate);

    for (const mesh of [torso, head, helmet, legLMesh, legRMesh, armLMesh, armRMesh]) {
      mesh.castShadow = true;
    }

    root.position.set(p.x, p.y, p.z);
    root.rotation.y = p.yaw;
    this.scene.add(root);

    return {
      root,
      body,
      torso,
      helmet,
      limbMeshes: [legLMesh, legRMesh, armLMesh, armRMesh],
      legL,
      legR,
      armL,
      armR,
      weaponHolder,
      weaponMesh,
      weapon: p.weapon,
      nameplate,
      muzzleGroup,
      team: p.team,
      name: p.name,
      walkPhase: 0,
      swingAmp: 0,
      breathe: 0,
      crouchAmt: p.crouch ? 1 : 0,
      dead: false,
      deathT: 0,
      flashT: 0,
      flashRoll: 0,
      lastX: p.x,
      lastZ: p.z,
      seen: 0,
    };
  }

  private remove(m: Soldier): void {
    this.scene.remove(m.root);
    disposeNameplate(m.nameplate); // factory geoms/materials are shared caches — never disposed
  }

  /** halftime side swap (or roster fixup): retint body + redraw the plate. */
  private retint(m: Soldier, team: Team, name: string): void {
    const dark = mat(darkHex(team));
    m.torso.material = mat(chestHex(team));
    m.helmet.material = dark;
    for (const limb of m.limbMeshes) limb.material = dark;
    disposeNameplate(m.nameplate);
    m.body.remove(m.nameplate);
    m.nameplate = at(makeNameplate(name, team), 0, NAMEPLATE_Y, 0);
    m.body.add(m.nameplate);
    m.team = team;
    m.name = name;
  }

  sync(players: Array<PlayerSnap & { team: Team; name: string }>, localId: PlayerId, dt: number): void {
    this.frame += 1;
    for (const p of players) {
      let m = this.models.get(p.id);
      if (!m) {
        m = this.create(p);
        this.models.set(p.id, m);
      }
      m.seen = this.frame;

      if (p.team !== m.team || p.name !== m.name) this.retint(m, p.team, p.name);

      // weapon swap: rebuild only that sub-group
      if (p.weapon !== m.weapon) {
        m.weaponHolder.remove(m.weaponMesh);
        m.weaponMesh = makeWeaponModel(p.weapon);
        m.weaponMesh.scale.setScalar(WEAPON_SCALE);
        m.weaponMesh.traverse((o) => {
          if (o instanceof THREE.Mesh) o.castShadow = true;
        });
        m.weaponHolder.add(m.weaponMesh);
        m.weapon = p.weapon;
      }

      // root: feet position + yaw
      m.root.position.set(p.x, p.y, p.z);
      m.root.rotation.y = p.yaw;

      // horizontal speed from interpolated positions (snapshots arrive pre-smoothed)
      const dx = p.x - m.lastX;
      const dz = p.z - m.lastZ;
      m.lastX = p.x;
      m.lastZ = p.z;
      const speed = dt > 0 ? Math.min(Math.hypot(dx, dz) / dt, 12) : 0;

      // muzzle flash decay (runs dead or alive so a dying shot never sticks on)
      if (m.flashT > 0) {
        m.flashT -= dt;
        if (m.flashT <= 0) m.muzzleGroup.visible = false;
      }

      if (!p.alive) {
        // ---- death: fall over 0.4s, sink 1u after 2s, gone at 3s ----
        if (!m.dead) {
          m.dead = true;
          m.deathT = 0;
        }
        m.deathT += dt;
        const fall = Math.min(m.deathT / DEATH_FALL_S, 1);
        const ease = 1 - (1 - fall) * (1 - fall);
        m.body.rotation.x = (-Math.PI / 2) * ease;
        const sink = Math.min(Math.max((m.deathT - DEATH_SINK_AT) / DEATH_SINK_S, 0), 1);
        m.root.position.y = p.y - sink;
        m.legL.rotation.x = 0;
        m.legR.rotation.x = 0;
        m.armL.rotation.x = ARM_BASE_L;
        m.armR.rotation.x = ARM_BASE_R;
        m.root.visible = p.id !== localId && m.deathT < DEATH_KEEP_S;
        continue;
      }
      if (m.dead) {
        m.dead = false; // respawned: stand back up
        m.body.rotation.x = 0;
      }
      m.root.visible = p.id !== localId;

      // ---- walk swing eased against idle breathe ----
      m.swingAmp += ((p.moving ? 1 : 0) - m.swingAmp) * Math.min(1, dt * 10);
      if (p.moving) m.walkPhase += speed * dt * PHASE_RATE;
      m.breathe += dt * Math.PI * 2 * BREATHE_HZ;
      const swing = Math.sin(m.walkPhase) * WALK_SWING_RAD * m.swingAmp;
      m.legL.rotation.x = swing;
      m.legR.rotation.x = -swing;
      m.armL.rotation.x = ARM_BASE_L - swing; // arms counter-swing their leg
      const pitchC = Math.max(-PITCH_CLAMP, Math.min(PITCH_CLAMP, p.pitch));
      m.armR.rotation.x = ARM_BASE_R + pitchC + swing;
      m.torso.scale.y = 1 + BREATHE_AMP * Math.sin(m.breathe) * (1 - m.swingAmp);

      // ---- crouch: legs squash around the hip, body drops to keep feet planted ----
      m.crouchAmt += ((p.crouch ? 1 : 0) - m.crouchAmt) * Math.min(1, dt * 12);
      const legScale = 1 - (1 - CROUCH_LEG_SCALE) * m.crouchAmt;
      m.legL.scale.y = legScale;
      m.legR.scale.y = legScale;
      m.body.position.y = -CROUCH_DROP * m.crouchAmt;
    }

    // sweep models whose ids left the snapshot
    for (const [id, m] of this.models) {
      if (m.seen !== this.frame) {
        this.remove(m);
        this.models.delete(id);
      }
    }
  }

  muzzle(id: PlayerId): void {
    const m = this.models.get(id);
    if (!m) return;
    m.flashT = MUZZLE_FLASH_S;
    m.flashRoll += 1;
    m.muzzleGroup.rotation.z = (m.flashRoll % 8) * (Math.PI / 4); // vary the cross roll deterministically
    m.muzzleGroup.visible = true;
  }

  clear(): void {
    for (const m of this.models.values()) this.remove(m);
    this.models.clear();
  }
}

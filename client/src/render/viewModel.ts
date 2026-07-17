// ============================================================================
// C5 — first-person viewmodel + weapon models.
// makeWeaponModel(id): baked low-poly weapon group; origin at the grip, barrel
// towards -Z (aims where the camera looks). Shared with playerModels (C4).
// ViewModel: camera-attached group, bottom-right, scale 0.6 (camera-space =>
// fov-independent). Animations: walk bob / idle sway, lower-raise swap, recoil
// spring + 40ms muzzle flash, reload dip+tilt. Zero per-frame allocation: all
// animation state is scalar fields, composed onto transforms in place.
// ============================================================================
import * as THREE from 'three';
import type { WeaponId } from '@fps/shared';
import { PALETTE, box, cyl, cone, at, bake } from '../contract/visual.js';

// ---- shared dimensions ------------------------------------------------------
// Barrel line height above the grip origin; grips sit just below y=0.
const BARREL_Y = 0.06;

// Muzzle tip in weapon-local space (drives muzzle flash placement).
const MUZZLE: Record<WeaponId, { y: number; z: number }> = {
  knife: { y: 0.0, z: -0.56 },
  pistol: { y: BARREL_Y, z: -0.28 },
  smg: { y: BARREL_Y, z: -0.46 },
  shotgun: { y: 0.085, z: -0.58 },
  rifle: { y: 0.075, z: -0.65 },
  sniper: { y: 0.08, z: -0.86 },
};

// Support-hand grip point per weapon (null = one-handed, hand hidden).
const HAND_L: Record<WeaponId, { y: number; z: number } | null> = {
  knife: null,
  pistol: { y: -0.02, z: -0.1 },
  smg: { y: 0.0, z: -0.26 },
  shotgun: { y: 0.02, z: -0.28 }, // on the wood pump
  rifle: { y: 0.02, z: -0.24 },
  sniper: { y: 0.01, z: -0.3 },
};

// ---- weapon model sheets (8–12 prims each, palette only) --------------------
function buildKnife(g: THREE.Group): void {
  const tilt = new THREE.Group();
  tilt.rotation.x = 0.18; // held tilted, tip up
  tilt.add(at(box(0.018, 0.075, 0.36, PALETTE.steel), 0, 0, -0.28)); // blade
  const tip = cone(0.04, 0.1, 4, PALETTE.steel);
  tip.rotation.x = -Math.PI / 2; // apex towards -Z
  tip.scale.x = 0.35; // flattened like the blade
  tilt.add(at(tip, 0, 0, -0.51));
  tilt.add(at(box(0.02, 0.012, 0.34, PALETTE.metalDark), 0, 0.037, -0.28)); // spine
  tilt.add(at(box(0.04, 0.09, 0.018, PALETTE.metalDark), 0, 0, -0.095)); // guard
  tilt.add(at(box(0.032, 0.05, 0.16, PALETTE.woodDark), 0, -0.01, -0.005)); // grip
  tilt.add(at(box(0.04, 0.06, 0.025, PALETTE.metalDark), 0, -0.012, 0.078)); // pommel
  tilt.add(at(box(0.036, 0.01, 0.01, PALETTE.metalDark), 0, -0.008, 0.025)); // rivet
  tilt.add(at(box(0.036, 0.01, 0.01, PALETTE.metalDark), 0, -0.008, -0.045)); // rivet
  g.add(tilt);
}

function buildPistol(g: THREE.Group): void {
  g.add(at(box(0.05, 0.06, 0.26, PALETTE.charcoal), 0, BARREL_Y, -0.1)); // slide
  g.add(at(box(0.045, 0.04, 0.2, PALETTE.charcoal), 0, 0.015, -0.09)); // frame
  const barrel = cyl(0.012, 0.012, 0.06, 8, PALETTE.steel);
  barrel.rotation.x = Math.PI / 2;
  g.add(at(barrel, 0, BARREL_Y, -0.24));
  const grip = box(0.045, 0.13, 0.06, PALETTE.charcoal);
  grip.rotation.x = -0.12; // raked back
  g.add(at(grip, 0, -0.055, 0.015));
  g.add(at(box(0.05, 0.015, 0.07, PALETTE.metalDark), 0, -0.122, 0.024)); // mag base
  g.add(at(box(0.04, 0.008, 0.07, PALETTE.metalDark), 0, -0.012, -0.05)); // trigger guard
  g.add(at(box(0.008, 0.015, 0.01, PALETTE.steel), 0, 0.097, -0.21)); // front sight
  g.add(at(box(0.03, 0.012, 0.01, PALETTE.charcoal), 0, 0.095, 0.02)); // rear sight
  g.add(at(box(0.012, 0.02, 0.015, PALETTE.metalDark), 0, 0.075, 0.035)); // hammer
}

function buildSmg(g: THREE.Group): void {
  g.add(at(box(0.055, 0.07, 0.3, PALETTE.charcoal), 0, 0.05, -0.08)); // stubby receiver
  g.add(at(box(0.05, 0.008, 0.16, PALETTE.charcoal), 0, 0.095, -0.28)); // shroud top
  g.add(at(box(0.008, 0.05, 0.16, PALETTE.charcoal), 0.028, BARREL_Y, -0.28)); // shroud side
  g.add(at(box(0.008, 0.05, 0.16, PALETTE.charcoal), -0.028, BARREL_Y, -0.28)); // shroud side
  const barrel = cyl(0.011, 0.011, 0.1, 8, PALETTE.metalDark);
  barrel.rotation.x = Math.PI / 2;
  g.add(at(barrel, 0, BARREL_Y, -0.4));
  const mag = box(0.035, 0.16, 0.05, PALETTE.metalDark);
  mag.rotation.x = 0.35; // curved: bottom sweeps forward
  g.add(at(mag, 0, -0.06, -0.06));
  g.add(at(box(0.04, 0.05, 0.14, PALETTE.charcoal), 0, 0.045, 0.13)); // stock
  const grip = box(0.04, 0.1, 0.05, PALETTE.charcoal);
  grip.rotation.x = -0.15;
  g.add(at(grip, 0, -0.03, 0.03));
  g.add(at(box(0.008, 0.02, 0.01, PALETTE.metalDark), 0, 0.115, -0.33)); // front sight
}

function buildShotgun(g: THREE.Group): void {
  const barrel = cyl(0.016, 0.016, 0.55, 10, PALETTE.metalDark);
  barrel.rotation.x = Math.PI / 2;
  g.add(at(barrel, 0, 0.085, -0.3));
  const tube = cyl(0.014, 0.014, 0.5, 10, PALETTE.metalDark);
  tube.rotation.x = Math.PI / 2;
  g.add(at(tube, 0, 0.045, -0.28)); // magazine tube under the barrel
  g.add(at(box(0.055, 0.08, 0.16, PALETTE.metalDark), 0, 0.05, 0.03)); // receiver
  g.add(at(box(0.06, 0.05, 0.12, PALETTE.wood), 0, 0.045, -0.28)); // wood pump
  const stock = box(0.05, 0.09, 0.2, PALETTE.wood);
  stock.rotation.x = -0.1;
  g.add(at(stock, 0, 0.02, 0.2));
  g.add(at(box(0.055, 0.1, 0.015, PALETTE.metalDark), 0, 0.012, 0.3)); // butt plate
  g.add(at(box(0.06, 0.02, 0.1, PALETTE.metalDark), 0, 0.095, 0.03)); // shell saddle
  g.add(at(box(0.04, 0.008, 0.06, PALETTE.metalDark), 0, 0.0, 0.03)); // trigger guard
  g.add(at(box(0.008, 0.012, 0.008, PALETTE.steel), 0, 0.11, -0.56)); // bead sight
}

function buildRifle(g: THREE.Group): void {
  const barrel = cyl(0.013, 0.013, 0.45, 10, PALETTE.metalDark);
  barrel.rotation.x = Math.PI / 2;
  g.add(at(barrel, 0, 0.075, -0.42)); // long barrel
  g.add(at(box(0.055, 0.055, 0.28, PALETTE.wood), 0, BARREL_Y, -0.2)); // wood handguard
  g.add(at(box(0.055, 0.07, 0.22, PALETTE.metalDark), 0, 0.05, 0.02)); // receiver
  const stock = box(0.05, 0.09, 0.22, PALETTE.wood);
  stock.rotation.x = -0.08;
  g.add(at(stock, 0, 0.02, 0.21));
  const grip = box(0.04, 0.1, 0.05, PALETTE.wood);
  grip.rotation.x = -0.2;
  g.add(at(grip, 0, -0.035, 0.06));
  const magA = box(0.035, 0.09, 0.06, PALETTE.wood);
  magA.rotation.x = 0.12;
  g.add(at(magA, 0, -0.05, -0.03));
  const magB = box(0.035, 0.09, 0.05, PALETTE.wood);
  magB.rotation.x = 0.5; // second segment completes the curve
  g.add(at(magB, 0, -0.12, -0.048));
  g.add(at(box(0.008, 0.035, 0.008, PALETTE.metalDark), 0, 0.112, -0.6)); // front sight post
  g.add(at(box(0.03, 0.015, 0.02, PALETTE.metalDark), 0, 0.095, 0.0)); // rear sight
}

function buildSniper(g: THREE.Group): void {
  const barrel = cyl(0.011, 0.011, 0.7, 10, PALETTE.ink);
  barrel.rotation.x = Math.PI / 2;
  g.add(at(barrel, 0, 0.08, -0.5)); // longest, thinnest barrel
  g.add(at(box(0.055, 0.07, 0.24, PALETTE.ink), 0, BARREL_Y, -0.02)); // receiver
  g.add(at(box(0.05, 0.05, 0.2, PALETTE.woodDark), 0, 0.05, -0.28)); // forend
  const stock = box(0.05, 0.1, 0.26, PALETTE.woodDark);
  stock.rotation.x = -0.08;
  g.add(at(stock, 0, 0.02, 0.22));
  const scope = cyl(0.018, 0.018, 0.16, 10, PALETTE.ink);
  scope.rotation.x = Math.PI / 2;
  g.add(at(scope, 0, 0.125, -0.02)); // scope tube
  g.add(at(box(0.02, 0.025, 0.02, PALETTE.ink), 0, 0.1, 0.03)); // scope mount
  g.add(at(box(0.02, 0.025, 0.02, PALETTE.ink), 0, 0.1, -0.07)); // scope mount
  const bipodL = cyl(0.006, 0.006, 0.09, 6, PALETTE.ink);
  bipodL.rotation.z = 0.3;
  g.add(at(bipodL, 0.025, 0.02, -0.55));
  const bipodR = cyl(0.006, 0.006, 0.09, 6, PALETTE.ink);
  bipodR.rotation.z = -0.3;
  g.add(at(bipodR, -0.025, 0.02, -0.55));
  const bolt = cyl(0.008, 0.008, 0.04, 6, PALETTE.ink);
  bolt.rotation.z = Math.PI / 2;
  g.add(at(bolt, 0.045, BARREL_Y, 0.05));
  g.add(at(box(0.04, 0.06, 0.08, PALETTE.ink), 0, -0.01, -0.05)); // mag
}

/**
 * Baked low-poly weapon; origin at the grip, barrel towards -Z. Used by the
 * viewmodel AND by playerModels (C4, scaled 0.9 in soldier hands).
 */
export function makeWeaponModel(id: WeaponId): THREE.Group {
  const g = new THREE.Group();
  switch (id) {
    case 'knife': buildKnife(g); break;
    case 'pistol': buildPistol(g); break;
    case 'smg': buildSmg(g); break;
    case 'shotgun': buildShotgun(g); break;
    case 'rifle': buildRifle(g); break;
    case 'sniper': buildSniper(g); break;
  }
  return bake(g); // static parts merge to one mesh per material
}

// ---- viewmodel tuning -------------------------------------------------------
const BASE_X = 0.28;
const BASE_Y = -0.26;
const BASE_Z = -0.5;
const VM_SCALE = 0.6;
const SWAP_DUR = 0.25; // s, lower-then-raise
const SWAP_DROP = 0.22; // u lowered mid-swap
const SPRING_K = 180; // recoil spring stiffness
const SPRING_C = 14; // recoil spring damping
const KICK_STEP = 0.03; // per-shot displacement (z += and rotation.x -=)
const KICK_MAX = 0.09; // stacked-auto cap
const FLASH_TIME = 0.04; // s
const RELOAD_DIP = 0.12; // u down
const RELOAD_TILT = (25 * Math.PI) / 180; // rad roll

function smooth(x: number): number {
  return x * x * (3 - 2 * x);
}

export class ViewModel {
  private readonly root = new THREE.Group(); // all animation lands here
  private readonly holder = new THREE.Group(); // weapon model + gloves
  private readonly fx = new THREE.Group(); // muzzle flash at the barrel tip
  private readonly flashA: THREE.Mesh;
  private readonly flashB: THREE.Mesh;
  private readonly handR: THREE.Mesh;
  private readonly handL: THREE.Mesh;
  private readonly models = new Map<WeaponId, THREE.Group>(); // built once, reused
  private currentModel: THREE.Group;
  private current: WeaponId = 'knife';

  private time = 0;
  private moveBlend = 0; // smoothed moving flag, kills bob pops
  private kick = 0;
  private kickVel = 0;
  private swapT = SWAP_DUR; // >= SWAP_DUR = idle
  private swapPending: WeaponId | null = null;
  private reloadT = -1; // < 0 = not reloading
  private reloadDur = 1;
  private flashT = 0;
  private flashStep = 0; // deterministic roll per shot (no Math.random)

  constructor(camera: THREE.Camera) {
    this.root.position.set(BASE_X, BASE_Y, BASE_Z);
    this.root.scale.setScalar(VM_SCALE);

    // gloved hands (charcoal boxes) — shared across weapons, never baked in
    this.handR = box(0.07, 0.06, 0.09, PALETTE.charcoal);
    this.handR.position.set(0.005, -0.05, 0.02); // on the grip (origin)
    this.handL = box(0.065, 0.055, 0.08, PALETTE.charcoal);
    this.holder.add(this.handR, this.handL);
    this.root.add(this.holder);

    // 2 crossed emissive quads; toggled visible for 40ms per shot
    this.flashA = box(0.22, 0.22, 0.004, PALETTE.muzzle, { emissive: PALETTE.muzzle });
    this.flashB = box(0.22, 0.22, 0.004, PALETTE.muzzle, { emissive: PALETTE.muzzle });
    this.fx.add(this.flashA, this.flashB);
    this.fx.visible = false;
    this.root.add(this.fx);

    this.currentModel = this.modelFor(this.current);
    this.holder.add(this.currentModel);
    this.applyLayout(this.current);

    camera.add(this.root);
  }

  /** Swap with a 0.25s lower-then-raise; same-id calls are no-ops. */
  setWeapon(id: WeaponId): void {
    if (id === this.current) {
      if (this.swapPending === null) return;
      this.swapPending = null; // swapped back mid-lower: raise current again
      if (this.swapT < SWAP_DUR * 0.5) this.swapT = SWAP_DUR - this.swapT;
      return;
    }
    if (id === this.swapPending) return;
    this.swapPending = id;
    if (this.swapT >= SWAP_DUR) this.swapT = 0;
    else if (this.swapT > SWAP_DUR * 0.5) this.swapT = SWAP_DUR - this.swapT; // re-lower smoothly
    this.reloadT = -1; // switching cancels the reload animation
  }

  /** Walk bob + idle sway; hidden entirely while scoped. */
  update(dt: number, moving: boolean, scoped: boolean): void {
    this.time += dt;
    const sdt = Math.min(dt, 0.05); // keeps the explicit spring stable on long frames

    this.moveBlend += ((moving ? 1 : 0) - this.moveBlend) * Math.min(1, dt * 10);
    const b = this.moveBlend;
    const bobX = Math.cos(this.time * 4.5) * 0.008 * b + Math.cos(this.time * 0.8) * 0.003 * (1 - b);
    const bobY = Math.sin(this.time * 9) * 0.012 * b + Math.sin(this.time * 1.6) * 0.004 * (1 - b);

    // recoil spring back to rest (semi-implicit Euler)
    this.kickVel += (-SPRING_K * this.kick - SPRING_C * this.kickVel) * sdt;
    this.kick += this.kickVel * sdt;
    if (Math.abs(this.kick) < 1e-5 && Math.abs(this.kickVel) < 1e-5) {
      this.kick = 0;
      this.kickVel = 0;
    }

    // lower-then-raise swap, sin hump 0 -> 1 -> 0 over SWAP_DUR
    let swapDown = 0;
    if (this.swapT < SWAP_DUR) {
      this.swapT += dt;
      if (this.swapPending !== null && this.swapT >= SWAP_DUR * 0.5) this.doSwap();
      swapDown = SWAP_DROP * Math.sin(Math.PI * Math.min(this.swapT / SWAP_DUR, 1));
    }

    // reload: dip + tilt over 20% of dur, hold 60%, return over 20%
    let dip = 0;
    let tilt = 0;
    if (this.reloadT >= 0) {
      this.reloadT += dt;
      const p = this.reloadT / this.reloadDur;
      if (p >= 1) this.reloadT = -1;
      else {
        const c = p < 0.2 ? smooth(p / 0.2) : p > 0.8 ? 1 - smooth((p - 0.8) / 0.2) : 1;
        dip = RELOAD_DIP * c;
        tilt = RELOAD_TILT * c;
      }
    }

    this.root.position.set(BASE_X + bobX, BASE_Y + bobY - swapDown - dip, BASE_Z + this.kick);
    this.root.rotation.set(-this.kick, 0, -tilt);
    this.root.visible = !scoped;

    if (this.flashT > 0) {
      this.flashT -= dt;
      if (this.flashT <= 0) this.fx.visible = false;
    }
  }

  /** Recoil kick (spring recovers) + 40ms muzzle flash. Knife: kick only. */
  fire(): void {
    this.kick = Math.min(this.kick + KICK_STEP, KICK_MAX);
    if (this.current === 'knife') return; // melee swing: no muzzle flash
    this.flashT = FLASH_TIME;
    this.fx.visible = true;
    this.flashStep = (this.flashStep + 1) % 4; // deterministic per-shot roll
    const roll = (this.flashStep * Math.PI) / 4;
    this.flashA.rotation.z = roll;
    this.flashB.rotation.z = roll + Math.PI / 2;
  }

  /** Dip down 0.12u + tilt 25° over 20% of durSec, hold, return. */
  reload(durSec: number): void {
    this.reloadT = 0;
    this.reloadDur = Math.max(durSec, 0.01);
  }

  private modelFor(id: WeaponId): THREE.Group {
    let m = this.models.get(id);
    if (!m) {
      m = makeWeaponModel(id);
      this.models.set(id, m);
    }
    return m;
  }

  private doSwap(): void {
    const id = this.swapPending;
    if (id === null) return;
    this.swapPending = null;
    this.holder.remove(this.currentModel); // cached, not disposed — reused on swap-back
    this.current = id;
    this.currentModel = this.modelFor(id);
    this.holder.add(this.currentModel);
    this.flashT = 0;
    this.fx.visible = false;
    this.applyLayout(id);
  }

  /** Muzzle flash position + support hand per weapon. */
  private applyLayout(id: WeaponId): void {
    const mz = MUZZLE[id];
    this.fx.position.set(0, mz.y, mz.z);
    const hl = HAND_L[id];
    this.handL.visible = hl !== null;
    if (hl !== null) this.handL.position.set(0, hl.y, hl.z);
  }
}

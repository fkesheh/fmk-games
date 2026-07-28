// ============================================================================
// C5 — first-person viewmodel + weapon models.
// makeWeaponModel(id): low-poly weapon group; origin at the grip, barrel
// towards -Z (aims where the camera looks). Shared with playerModels (C4).
// Static parts bake to one mesh per material; the MAGAZINE stays a loose
// child (userData.mag === true) so the viewmodel can drop it out and seat it
// back during the reload choreography (it just sits at rest on soldiers).
// Detail sheet: iron sights (rear notch + front post with ears) on rifle/smg,
// a curved 3-segment wood mag on the rifle, scope rings + bolt handle with
// knob on the sniper, and a slightly lighter wood-tone accent panel (crate)
// laid along the grain on wooden furniture. The rifle splits materials:
// woodDark butt plate + grip cap, steel rear-sight block + charging-handle
// nub against the gunmetal (metalDark) receiver. Hands: mid-value gloves
// with ink cuff rings and charcoal forearm sleeves (children of the hands,
// so they ride the reload choreography).
// ViewModel: camera-attached group, bottom-right, scale 0.6 (camera-space =>
// fov-independent). Animations: walk bob / idle breathing sway, lower-raise
// swap, recoil spring + 40ms muzzle flash, reload dip+tilt with mag
// drop-out-and-in (mag drops away, support hand follows off-screen, fresh mag
// seats, hand returns to the forend). Zero per-frame allocation: all
// animation state is scalar fields, composed onto transforms in place.
// ============================================================================
import * as THREE from 'three';
import type { WeaponId } from '@fps/shared';
import { PALETTE, box, cyl, cone, sphere, at, bake } from '../contract/visual.js';

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
  rifle: { y: -0.005, z: -0.24 }, // under the handguard, glove hangs proud
  sniper: { y: 0.01, z: -0.3 },
};

// ---- weapon model sheets (8–20 prims each, palette only) --------------------
/** Flag a loose magazine part; makeWeaponModel keeps it unbaked (animatable). */
function markMag<T extends THREE.Object3D>(o: T): T {
  o.userData['mag'] = true;
  return o;
}

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
  const grip = box(0.032, 0.05, 0.16, PALETTE.woodDark);
  // grain hint: lighter wood-tone panel along the grip's long axis
  grip.add(at(box(0.034, 0.02, 0.11, PALETTE.crate), 0, 0.002, 0));
  tilt.add(at(grip, 0, -0.01, -0.005));
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
  // mag: loose — body hidden inside the grip, baseplate proud at the heel
  const mag = new THREE.Group();
  mag.position.set(0, -0.055, 0.015);
  mag.rotation.x = -0.12; // same rake as the grip
  mag.add(at(box(0.04, 0.1, 0.05, PALETTE.metalDark), 0, -0.005, 0.003)); // body (in the grip)
  mag.add(at(box(0.05, 0.015, 0.07, PALETTE.metalDark), 0, -0.064, 0.01)); // baseplate
  g.add(markMag(mag));
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
  // mag: loose, two segments — bottom sweeps forward for the curved read
  const mag = new THREE.Group();
  mag.position.set(0, -0.04, -0.06);
  const magA = box(0.035, 0.1, 0.05, PALETTE.metalDark);
  magA.rotation.x = 0.18;
  mag.add(at(magA, 0, -0.04, 0));
  const magB = box(0.035, 0.09, 0.045, PALETTE.metalDark);
  magB.rotation.x = 0.5;
  mag.add(at(magB, 0, -0.12, -0.018));
  g.add(markMag(mag));
  g.add(at(box(0.04, 0.05, 0.14, PALETTE.charcoal), 0, 0.045, 0.13)); // stock
  const grip = box(0.04, 0.1, 0.05, PALETTE.charcoal);
  grip.rotation.x = -0.15;
  g.add(at(grip, 0, -0.03, 0.03));
  g.add(at(box(0.01, 0.024, 0.01, PALETTE.metalDark), 0, 0.115, -0.33)); // front sight post
  // rear notch: two prongs with a gap that reads from behind
  g.add(at(box(0.008, 0.024, 0.01, PALETTE.metalDark), -0.014, 0.098, 0.04));
  g.add(at(box(0.008, 0.024, 0.01, PALETTE.metalDark), 0.014, 0.098, 0.04));
}

function buildShotgun(g: THREE.Group): void {
  const barrel = cyl(0.016, 0.016, 0.55, 10, PALETTE.metalDark);
  barrel.rotation.x = Math.PI / 2;
  g.add(at(barrel, 0, 0.085, -0.3));
  const tube = cyl(0.014, 0.014, 0.5, 10, PALETTE.metalDark);
  tube.rotation.x = Math.PI / 2;
  g.add(at(tube, 0, 0.045, -0.28)); // magazine tube under the barrel
  g.add(at(box(0.055, 0.08, 0.16, PALETTE.metalDark), 0, 0.05, 0.03)); // receiver
  const pump = box(0.06, 0.05, 0.12, PALETTE.wood);
  pump.add(at(box(0.05, 0.008, 0.1, PALETTE.crate), 0, 0.027, 0)); // grain panel along the pump
  pump.add(at(box(0.008, 0.03, 0.1, PALETTE.crate), -0.031, 0, 0)); // side grain (camera side)
  g.add(at(pump, 0, 0.045, -0.28));
  const stock = box(0.05, 0.09, 0.2, PALETTE.wood);
  stock.rotation.x = -0.1;
  stock.add(at(box(0.04, 0.008, 0.16, PALETTE.crate), 0, 0.047, 0)); // grain panel along the stock
  stock.add(at(box(0.008, 0.05, 0.16, PALETTE.crate), -0.026, 0, 0)); // side grain (camera side)
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
  const handguard = box(0.055, 0.055, 0.28, PALETTE.wood);
  handguard.add(at(box(0.008, 0.032, 0.24, PALETTE.crate), -0.0285, 0, 0)); // side grain (camera side)
  g.add(at(handguard, 0, BARREL_Y, -0.2));
  g.add(at(box(0.055, 0.07, 0.22, PALETTE.metalDark), 0, 0.05, 0.02)); // receiver (gunmetal)
  const stock = box(0.05, 0.09, 0.22, PALETTE.wood);
  stock.rotation.x = -0.08;
  stock.add(at(box(0.04, 0.008, 0.18, PALETTE.crate), 0, 0.047, 0)); // grain panel along the stock
  stock.add(at(box(0.008, 0.05, 0.18, PALETTE.crate), -0.026, 0, 0)); // side grain (camera side)
  stock.add(at(box(0.052, 0.095, 0.015, PALETTE.woodDark), 0, 0, 0.115)); // butt plate caps the heel
  g.add(at(stock, 0, 0.02, 0.21));
  const grip = box(0.04, 0.1, 0.05, PALETTE.wood);
  grip.rotation.x = -0.2;
  grip.add(at(box(0.042, 0.012, 0.052, PALETTE.woodDark), 0, -0.053, 0)); // grip cap
  g.add(at(grip, 0, -0.035, 0.06));
  // mag: loose, three segments at rising tilt — the AK curve reads in profile
  const mag = new THREE.Group();
  mag.position.set(0, -0.025, -0.03);
  const magA = box(0.035, 0.08, 0.06, PALETTE.wood);
  magA.rotation.x = 0.15;
  mag.add(at(magA, 0, -0.03, 0));
  const magB = box(0.035, 0.08, 0.055, PALETTE.wood);
  magB.rotation.x = 0.55;
  mag.add(at(magB, 0, -0.1, -0.02));
  const magC = box(0.033, 0.075, 0.05, PALETTE.wood);
  magC.rotation.x = 0.95; // tip completes the sweep forward
  mag.add(at(magC, 0, -0.165, -0.055));
  g.add(markMag(mag));
  g.add(at(box(0.008, 0.035, 0.008, PALETTE.metalDark), 0, 0.112, -0.6)); // front sight post
  g.add(at(box(0.006, 0.022, 0.006, PALETTE.metalDark), -0.012, 0.108, -0.6)); // post guard ear
  g.add(at(box(0.006, 0.022, 0.006, PALETTE.metalDark), 0.012, 0.108, -0.6)); // post guard ear
  // rear sight: steel block (metal read vs the wood) + two prongs with a gap
  g.add(at(box(0.034, 0.02, 0.035, PALETTE.steel), 0, 0.093, 0.02));
  g.add(at(box(0.008, 0.026, 0.012, PALETTE.metalDark), -0.016, 0.108, 0.02));
  g.add(at(box(0.008, 0.026, 0.012, PALETTE.metalDark), 0.016, 0.108, 0.02));
  const chHandle = cyl(0.006, 0.006, 0.03, 6, PALETTE.steel);
  chHandle.rotation.z = Math.PI / 2;
  g.add(at(chHandle, 0.038, 0.055, 0.07)); // charging-handle nub off the receiver
}

function buildSniper(g: THREE.Group): void {
  // gunmetal (metalDark) for every metal surface — separates from the ink mag
  const barrel = cyl(0.011, 0.011, 0.7, 10, PALETTE.metalDark);
  barrel.rotation.x = Math.PI / 2;
  g.add(at(barrel, 0, 0.08, -0.5)); // longest, thinnest barrel
  g.add(at(box(0.055, 0.07, 0.24, PALETTE.metalDark), 0, BARREL_Y, -0.02)); // receiver
  const forend = box(0.05, 0.05, 0.2, PALETTE.woodDark);
  forend.add(at(box(0.04, 0.008, 0.16, PALETTE.crate), 0, 0.027, 0)); // grain panel along the forend
  forend.add(at(box(0.008, 0.028, 0.16, PALETTE.crate), -0.026, 0, 0)); // side grain (camera side)
  g.add(at(forend, 0, 0.05, -0.28));
  const stock = box(0.05, 0.1, 0.26, PALETTE.woodDark);
  stock.rotation.x = -0.08;
  stock.add(at(box(0.04, 0.008, 0.2, PALETTE.crate), 0, 0.052, 0)); // grain panel along the stock
  stock.add(at(box(0.008, 0.05, 0.2, PALETTE.crate), -0.026, 0, 0)); // side grain (camera side)
  g.add(at(stock, 0, 0.02, 0.22));
  const scope = cyl(0.018, 0.018, 0.16, 10, PALETTE.metalDark);
  scope.rotation.x = Math.PI / 2;
  g.add(at(scope, 0, 0.125, -0.02)); // scope tube
  // scope rings: thin bands wrapping the tube, tied to the receiver by a rail
  const ringF = cyl(0.024, 0.024, 0.014, 8, PALETTE.metalDark);
  ringF.rotation.x = Math.PI / 2;
  g.add(at(ringF, 0, 0.125, 0.03));
  const ringR = cyl(0.024, 0.024, 0.014, 8, PALETTE.metalDark);
  ringR.rotation.x = Math.PI / 2;
  g.add(at(ringR, 0, 0.125, -0.07));
  g.add(at(box(0.03, 0.012, 0.14, PALETTE.metalDark), 0, 0.099, -0.02)); // mount rail under the rings
  const bipodL = cyl(0.006, 0.006, 0.09, 6, PALETTE.metalDark);
  bipodL.rotation.z = 0.3;
  g.add(at(bipodL, 0.025, 0.02, -0.55));
  const bipodR = cyl(0.006, 0.006, 0.09, 6, PALETTE.metalDark);
  bipodR.rotation.z = -0.3;
  g.add(at(bipodR, -0.025, 0.02, -0.55));
  // bolt handle: pin out the right side, bent arm down to a steel knob
  const bolt = cyl(0.008, 0.008, 0.04, 6, PALETTE.metalDark);
  bolt.rotation.z = Math.PI / 2;
  g.add(at(bolt, 0.045, BARREL_Y, 0.05));
  g.add(at(box(0.012, 0.04, 0.014, PALETTE.metalDark), 0.062, 0.045, 0.05)); // bent arm
  g.add(at(sphere(0.015, 6, PALETTE.steel), 0.062, 0.022, 0.05)); // knob
  // mag: loose box ahead of the trigger guard
  g.add(markMag(at(box(0.04, 0.06, 0.08, PALETTE.ink), 0, -0.01, -0.05)));
}

/**
 * Low-poly weapon; origin at the grip, barrel towards -Z. Used by the
 * viewmodel AND by playerModels (C4, scaled 0.9 in soldier hands). Static
 * parts bake to one mesh per material; parts flagged userData.mag stay loose
 * (direct children of the returned group) so the viewmodel can animate them.
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
  const mags: THREE.Object3D[] = [];
  for (const child of [...g.children]) {
    if (child.userData['mag'] === true) {
      g.remove(child);
      mags.push(child);
    }
  }
  const baked = bake(g); // static parts merge to one mesh per material
  for (const m of mags) baked.add(m); // mags re-attach unbaked at their rest pose
  return baked;
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
// reload mag choreography (normalized phase windows inside the dip hold):
// hand slides to the mag -> mag drops away (tumbling) -> hand follows off-
// screen -> hand returns with a fresh mag seated -> hand back to the forend
const MAG_DROP_U = 0.55; // mag travel down: at viewmodel scale this leaves the screen
const MAG_TUMBLE_RAD = 0.9; // forward pitch the falling mag picks up
const HAND_DROP_U = 0.6; // support-hand travel down (off-screen fetch)
const MAG_GRAB_Y = -0.02; // hand offset under the mag rest when grabbing

function smooth(x: number): number {
  return x * x * (3 - 2 * x);
}

/** ramp 0->1 over [a,b], hold 1 until [c,d] ramps back to 0 (p in 0..1). */
function window01(p: number, a: number, b: number, c: number, d: number): number {
  if (p <= a) return 0;
  if (p < b) return smooth((p - a) / (b - a));
  if (p <= c) return 1;
  if (p < d) return 1 - smooth((p - c) / (d - c));
  return 0;
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
  // loose mag of the current model (null for knife/shotgun) + rest poses as
  // scalars (zero per-frame allocation; composed in place during reload)
  private magObj: THREE.Object3D | null = null;
  private magRestX = 0;
  private magRestY = 0;
  private magRestZ = 0;
  private magRestRX = 0;
  private handRestX = 0;
  private handRestY = 0;
  private handRestZ = 0;

  constructor(camera: THREE.Camera) {
    this.root.position.set(BASE_X, BASE_Y, BASE_Z);
    this.root.scale.setScalar(VM_SCALE);

    // gloves (mid-value concrete so they read against ink metal AND wood),
    // ink cuff rings for contrast, charcoal forearm sleeves trailing toward
    // the screen edge — the rifle is HELD, not floating. Cuffs/sleeves are
    // children of the hands: they follow layouts and the reload choreography.
    this.handR = box(0.085, 0.085, 0.11, PALETTE.concrete);
    this.handR.position.set(0.055, -0.105, 0.035); // low C-grip: clears the stock silhouette
    this.handR.rotation.x = -0.25; // top face tilts toward the camera
    this.handR.add(at(box(0.09, 0.024, 0.115, PALETTE.carpet), 0, -0.038, 0.045)); // cuff tone break
    // forearm sleeve: short + thick, running to the bottom-right screen corner
    // where a right-handed forearm actually comes from (not a blade fin)
    const sleeveR = box(0.095, 0.09, 0.2, PALETTE.charcoal);
    sleeveR.rotation.x = 0.25;
    sleeveR.rotation.y = -0.55;
    this.handR.add(at(sleeveR, 0.045, -0.015, 0.16));
    this.handL = box(0.07, 0.06, 0.085, PALETTE.concrete);
    this.handL.add(at(box(0.075, 0.02, 0.09, PALETTE.carpet), 0, -0.024, 0.028)); // cuff tone break
    const sleeveL = box(0.075, 0.07, 0.18, PALETTE.charcoal);
    sleeveL.rotation.x = 0.35; // down-left off the screen edge
    sleeveL.rotation.z = 0.25;
    this.handL.add(at(sleeveL, -0.04, -0.035, 0.11));
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

  /** Walk bob + idle breathing sway; hidden entirely while scoped. */
  update(dt: number, moving: boolean, scoped: boolean): void {
    this.time += dt;
    const sdt = Math.min(dt, 0.05); // keeps the explicit spring stable on long frames

    this.moveBlend += ((moving ? 1 : 0) - this.moveBlend) * Math.min(1, dt * 10);
    const b = this.moveBlend;
    const idle = 1 - b;
    const bobX = Math.cos(this.time * 4.5) * 0.008 * b + Math.cos(this.time * 0.8) * 0.003 * idle;
    const bobY =
      Math.sin(this.time * 9) * 0.012 * b +
      Math.sin(this.time * 1.6) * 0.004 * idle + // slow breathing rise/fall
      Math.sin(this.time * 3.1) * 0.0012 * idle; // second harmonic keeps it organic
    // breathing reads through the wrists too: tiny roll/pitch drift when idle
    const swayRoll = Math.sin(this.time * 1.6 + 0.7) * 0.006 * idle;
    const swayPitch = Math.sin(this.time * 0.8 + 1.9) * 0.004 * idle;

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

    // reload: dip + tilt envelope (20% in, hold, 20% out) carrying the mag
    // choreography — grab, mag drops away tumbling, hand fetches off-screen,
    // fresh mag seats, hand back to the forend
    let dip = 0;
    let tilt = 0;
    let handGrab = 0;
    let magDrop = 0;
    let magTumble = 0;
    let handDrop = 0;
    if (this.reloadT >= 0) {
      this.reloadT += dt;
      const p = this.reloadT / this.reloadDur;
      if (p >= 1) {
        this.reloadT = -1;
        this.resetMagHand(); // envelopes end at 0; snap to exact rest
      } else {
        const c = p < 0.2 ? smooth(p / 0.2) : p > 0.8 ? 1 - smooth((p - 0.8) / 0.2) : 1;
        dip = RELOAD_DIP * c;
        tilt = RELOAD_TILT * c;
        handGrab = window01(p, 0.02, 0.15, 0.85, 0.98);
        magDrop = window01(p, 0.22, 0.38, 0.62, 0.78);
        handDrop = window01(p, 0.34, 0.5, 0.58, 0.76);
        // the mag tumbles while it falls, then seats straight (swap reads)
        magTumble = magDrop * (1 - (p < 0.5 ? 0 : smooth((p - 0.5) / 0.28))) * MAG_TUMBLE_RAD;
      }
    }
    if (magDrop > 0 || magTumble > 0) {
      if (this.magObj !== null) {
        this.magObj.position.set(
          this.magRestX,
          this.magRestY - magDrop * MAG_DROP_U,
          this.magRestZ + magDrop * 0.06,
        );
        this.magObj.rotation.x = this.magRestRX + magTumble;
      }
    }
    if (handGrab > 0 || handDrop > 0) {
      if (this.handL.visible) {
        this.handL.position.set(
          this.handRestX + (this.magRestX - this.handRestX) * handGrab,
          this.handRestY + (this.magRestY + MAG_GRAB_Y - this.handRestY) * handGrab - handDrop * HAND_DROP_U,
          this.handRestZ + (this.magRestZ - this.handRestZ) * handGrab,
        );
      }
    }

    this.root.position.set(BASE_X + bobX, BASE_Y + bobY - swapDown - dip, BASE_Z + this.kick);
    this.root.rotation.set(-this.kick + swayPitch, 0, -tilt + swayRoll);
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

  /**
   * Dip down 0.12u + tilt 25° (20% in, hold, 20% out) while the mag drops out
   * tumbling, the support hand fetches off-screen, and the fresh mag seats.
   */
  reload(durSec: number): void {
    this.reloadT = 0;
    this.reloadDur = Math.max(durSec, 0.01);
  }

  /** Snap the loose mag + support hand back to their rest poses. */
  private resetMagHand(): void {
    if (this.magObj !== null) {
      this.magObj.position.set(this.magRestX, this.magRestY, this.magRestZ);
      this.magObj.rotation.x = this.magRestRX;
    }
    this.handL.position.set(this.handRestX, this.handRestY, this.handRestZ);
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
    this.resetMagHand(); // restore the outgoing model — it is cached and reused on swap-back
    this.holder.remove(this.currentModel); // cached, not disposed — reused on swap-back
    this.current = id;
    this.currentModel = this.modelFor(id);
    this.holder.add(this.currentModel);
    this.flashT = 0;
    this.fx.visible = false;
    this.applyLayout(id);
  }

  /** Muzzle flash position, support hand rest + loose mag lookup per weapon. */
  private applyLayout(id: WeaponId): void {
    const mz = MUZZLE[id];
    this.fx.position.set(0, mz.y, mz.z);
    const hl = HAND_L[id];
    this.handL.visible = hl !== null;
    if (hl !== null) {
      this.handRestX = 0;
      this.handRestY = hl.y;
      this.handRestZ = hl.z;
      this.handL.position.set(this.handRestX, this.handRestY, this.handRestZ);
    }
    // loose mag child (kept unbaked by makeWeaponModel); weapons without one
    // (knife/shotgun) grab a point under the receiver for the hand pantomime
    this.magObj = null;
    for (const child of this.currentModel.children) {
      if (child.userData['mag'] === true) {
        this.magObj = child;
        break;
      }
    }
    if (this.magObj !== null) {
      this.magRestX = this.magObj.position.x;
      this.magRestY = this.magObj.position.y;
      this.magRestZ = this.magObj.position.z;
      this.magRestRX = this.magObj.rotation.x;
    } else {
      this.magRestX = 0;
      this.magRestY = -0.06;
      this.magRestZ = -0.02;
      this.magRestRX = 0;
    }
  }
}

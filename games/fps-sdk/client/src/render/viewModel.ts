// ============================================================================
// C5 — first-person viewmodel + weapon models.
// makeWeaponModel(id): low-poly weapon group; origin at the grip, barrel
// towards -Z (aims where the camera looks). Shared with playerModels (C4).
// Static parts bake to one mesh per material; the MAGAZINE stays a loose
// child (userData.mag === true) so the viewmodel can drop it out and seat it
// back during the reload choreography (it just sits at rest on soldiers).
// The mag is itself baked internally (`looseMag`) so its own primitives are
// free too — only the group transform has to stay animatable.
//
// DRAW-CALL BUDGET — READ BEFORE ADDING A COLOUR. `bake()` emits ONE MESH PER
// DISTINCT MATERIAL, and playerModels instantiates a weapon model per player,
// so every extra PALETTE entry used here costs one draw call PER PLAYER at the
// CONTRACT.md peak of 10. Primitives are free; materials are not. Cap: SIX
// palette entries per weapon. Need another value break? Reuse a tone already
// on that weapon, or express it with geometry.
//
// Detail sheet (VISUAL_UPGRADE.md §3c — 25-40 primitives per weapon, and a
// MANDATORY three-value break so no weapon reads as one dark blob):
//   LOWER / BODY   metalDark (L26)  receivers, frames, guards, barrels, butt
//                                   plates, grip/forend caps
//   UPPER          steel (L66)      slides, dust covers, receiver tops, rails,
//                                   triggers, sling bails — the light plane
//   HIGHLIGHT      steelLit (L80)   sight posts, port lips, bolt/charging knobs
//   CREVICE        one tone per weapon, shared by metal AND wood recesses:
//                  metalDeep (L14) on the steel/wood guns, ink (L8) on the
//                  polymer ones (it also has to read against charcoal L16)
//   FURNITURE      wood + woodLit (rifle, shotgun), woodDark + crate (sniper,
//                  knife grip), charcoal + ink (pistol, smg polymer)
// Every weapon carries: front sight post (+ protective ears where the real
// gun has them) and a rear notch built from two prongs with a visible gap, a
// charging handle (pump on the shotgun, bolt on the sniper), a flared mag-well
// lip, a 3-prim sling bail with a real gap under the crossbar, and a recessed
// ejection port with a lit top lip. Ports, charging handles and selectors sit
// on the -X flank because that is the side the camera sees at the bottom-right
// viewmodel offset. Silhouettes are unchanged: long thin sniper, curved-mag
// rifle, tube shotgun, stubby smg, compact pistol, blade knife.
// Hands: mid-value gloves with ink cuff rings and charcoal forearm sleeves
// (children of the hands, so they ride the reload choreography).
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

// ---- weapon model sheets (25–40 prims each, <= 6 palette entries each) ------
/** Flag a loose magazine part; makeWeaponModel keeps it unbaked (animatable). */
function markMag<T extends THREE.Object3D>(o: T): T {
  o.userData['mag'] = true;
  return o;
}

/**
 * Merge a magazine's primitives to one mesh per material and hand it back as
 * the loose, animatable child at its rest pose. `parts` MUST still be at
 * identity when it arrives: `bake()` folds child world matrices into the
 * geometry, so the rest transform is applied to the RESULT — that keeps
 * `magObj.position` / `magObj.rotation.x` meaning exactly what the reload
 * choreography (and `applyLayout`'s rest-pose capture) expects.
 */
function looseMag(parts: THREE.Group, x: number, y: number, z: number, rx = 0): THREE.Group {
  const mag = bake(parts);
  mag.position.set(x, y, z);
  mag.rotation.x = rx;
  return markMag(mag);
}

/**
 * Sling bail: two steel posts and a crossbar, so there is a real gap between
 * the mounting face and the bar — it reads as a loop, not a stud. 3 prims.
 * Caller positions it on the surface it hangs off; the loop opens towards +Y.
 */
function slingBail(): THREE.Group {
  const g = new THREE.Group();
  g.add(at(box(0.006, 0.018, 0.006, PALETTE.steel), 0, 0, -0.011));
  g.add(at(box(0.006, 0.018, 0.006, PALETTE.steel), 0, 0, 0.011));
  g.add(at(box(0.006, 0.006, 0.028, PALETTE.steel), 0, 0.012, 0));
  return g;
}

/**
 * Blade knife — 26 prims, 6 materials. steel blade / steelLit edge / woodDark
 * grip with crate grain / metalDark furniture / metalDeep crevices.
 */
function buildKnife(g: THREE.Group): void {
  const tilt = new THREE.Group();
  tilt.rotation.x = 0.18; // held tilted, tip up
  tilt.add(at(box(0.018, 0.075, 0.36, PALETTE.steel), 0, 0, -0.28)); // blade
  // sharpened edge: the brightest strip on the weapon, runs the whole belly
  tilt.add(at(box(0.02, 0.018, 0.36, PALETTE.steelLit), 0, -0.032, -0.28));
  tilt.add(at(box(0.021, 0.014, 0.24, PALETTE.metalDark), 0, 0.004, -0.30)); // fuller groove
  tilt.add(at(box(0.02, 0.012, 0.34, PALETTE.metalDark), 0, 0.037, -0.28)); // spine
  const tip = cone(0.04, 0.1, 4, PALETTE.steel);
  tip.rotation.x = -Math.PI / 2; // apex towards -Z
  tip.scale.x = 0.35; // flattened like the blade
  tilt.add(at(tip, 0, 0, -0.51));
  // saw teeth along the spine + jimping on the thumb ramp
  tilt.add(at(box(0.022, 0.011, 0.014, PALETTE.metalDeep), 0, 0.042, -0.13));
  tilt.add(at(box(0.022, 0.011, 0.014, PALETTE.metalDeep), 0, 0.042, -0.163));
  tilt.add(at(box(0.022, 0.011, 0.014, PALETTE.metalDeep), 0, 0.042, -0.196));
  tilt.add(at(box(0.022, 0.011, 0.014, PALETTE.metalDeep), 0, 0.042, -0.229));
  tilt.add(at(box(0.022, 0.008, 0.034, PALETTE.metalDeep), 0, 0.044, -0.088));
  tilt.add(at(box(0.04, 0.09, 0.018, PALETTE.metalDark), 0, 0, -0.095)); // guard
  tilt.add(at(box(0.05, 0.016, 0.02, PALETTE.steel), 0, -0.038, -0.095)); // quillon
  tilt.add(at(box(0.019, 0.05, 0.04, PALETTE.metalDark), 0, 0, -0.066)); // ricasso
  const grip = box(0.032, 0.05, 0.16, PALETTE.woodDark);
  // grain hint: lighter wood-tone panels along the grip's long axis
  grip.add(at(box(0.034, 0.02, 0.11, PALETTE.crate), 0, 0.002, 0));
  grip.add(at(box(0.006, 0.03, 0.12, PALETTE.crate), -0.016, 0, 0)); // camera-side panel
  // cord wrap rings: dark bands that break the grip into three. metalDeep is
  // this weapon's one crevice tone (see the draw-call budget in the header) —
  // it already carries the saw teeth and jimping, and reads deeper against
  // woodDark (L29) than charcoal (L16) did.
  grip.add(at(box(0.035, 0.009, 0.014, PALETTE.metalDeep), 0, 0, 0.045));
  grip.add(at(box(0.035, 0.009, 0.014, PALETTE.metalDeep), 0, 0, 0));
  grip.add(at(box(0.035, 0.009, 0.014, PALETTE.metalDeep), 0, 0, -0.045));
  tilt.add(at(grip, 0, -0.01, -0.005));
  tilt.add(at(box(0.04, 0.06, 0.025, PALETTE.metalDark), 0, -0.012, 0.078)); // pommel
  tilt.add(at(box(0.042, 0.012, 0.028, PALETTE.steel), 0, 0.014, 0.078)); // pommel cap
  tilt.add(at(box(0.024, 0.018, 0.009, PALETTE.steel), 0, -0.03, 0.092)); // lanyard tab
  tilt.add(at(box(0.013, 0.009, 0.012, PALETTE.metalDeep), 0, -0.03, 0.093)); // lanyard hole
  const breaker = cone(0.011, 0.028, 4, PALETTE.metalDeep);
  breaker.rotation.x = Math.PI / 2; // apex towards +Z, out of the pommel
  tilt.add(at(breaker, 0, -0.012, 0.104)); // glass breaker
  tilt.add(at(box(0.036, 0.01, 0.01, PALETTE.steel), 0, -0.008, 0.025)); // rivet
  tilt.add(at(box(0.036, 0.01, 0.01, PALETTE.steel), 0, -0.008, -0.045)); // rivet
  g.add(tilt);
}

/**
 * Compact pistol — 36 prims, 5 materials. steel slide / metalDark frame /
 * charcoal polymer grip. Crevice tone is `ink`, not `metalDeep`: it doubles as
 * the grip's checkering panel, where metalDeep (L14) would sit 2 L off the
 * charcoal (L16) grip and vanish. One tone, two jobs, one draw call.
 */
function buildPistol(g: THREE.Group): void {
  // ---- slide: the light plane, and the reason this gun stops being a blob
  g.add(at(box(0.052, 0.055, 0.235, PALETTE.steel), 0, BARREL_Y, -0.105));
  g.add(at(box(0.03, 0.008, 0.235, PALETTE.steelLit), 0, 0.088, -0.105)); // top strap
  g.add(at(box(0.052, 0.05, 0.03, PALETTE.steel), 0, 0.058, -0.235)); // nose block
  g.add(at(box(0.01, 0.028, 0.085, PALETTE.ink), -0.023, 0.066, -0.06)); // ejection port
  g.add(at(box(0.009, 0.006, 0.09, PALETTE.steelLit), -0.024, 0.083, -0.06)); // port lip
  // cocking serrations at the rear of the slide
  g.add(at(box(0.008, 0.044, 0.008, PALETTE.ink), -0.0245, 0.058, 0.0));
  g.add(at(box(0.008, 0.044, 0.008, PALETTE.ink), -0.0245, 0.058, -0.016));
  g.add(at(box(0.008, 0.044, 0.008, PALETTE.ink), -0.0245, 0.058, -0.032));
  g.add(at(box(0.008, 0.044, 0.008, PALETTE.ink), -0.0245, 0.058, -0.048));
  // ---- frame + dust cover
  g.add(at(box(0.046, 0.036, 0.2, PALETTE.metalDark), 0, 0.018, -0.09));
  g.add(at(box(0.032, 0.014, 0.1, PALETTE.ink), 0, 0.003, -0.145)); // dust cover
  g.add(at(box(0.026, 0.008, 0.09, PALETTE.steel), 0, -0.004, -0.145)); // accessory rail
  g.add(at(box(0.008, 0.012, 0.05, PALETTE.steel), -0.026, 0.028, -0.02)); // slide stop
  const pin = cyl(0.006, 0.006, 0.009, 6, PALETTE.steelLit);
  pin.rotation.z = Math.PI / 2;
  g.add(at(pin, -0.026, 0.03, -0.062)); // takedown pin
  const barrel = cyl(0.0115, 0.0115, 0.06, 8, PALETTE.steelLit);
  barrel.rotation.x = Math.PI / 2;
  g.add(at(barrel, 0, BARREL_Y, -0.245));
  const crown = cyl(0.0135, 0.0135, 0.014, 8, PALETTE.ink);
  crown.rotation.x = Math.PI / 2;
  g.add(at(crown, 0, BARREL_Y, -0.272)); // muzzle crown
  // ---- sights: front post + a rear notch you can actually see through
  g.add(at(box(0.016, 0.008, 0.022, PALETTE.metalDark), 0, 0.089, -0.2));
  g.add(at(box(0.008, 0.016, 0.012, PALETTE.steelLit), 0, 0.098, -0.2)); // front post
  g.add(at(box(0.034, 0.014, 0.018, PALETTE.metalDark), 0, 0.092, 0.0)); // rear block
  g.add(at(box(0.01, 0.016, 0.015, PALETTE.steel), -0.012, 0.099, 0.0)); // notch prong
  g.add(at(box(0.01, 0.016, 0.015, PALETTE.steel), 0.012, 0.099, 0.0)); // notch prong
  g.add(at(box(0.012, 0.022, 0.014, PALETTE.steel), 0, 0.077, 0.036)); // hammer
  g.add(at(box(0.032, 0.012, 0.028, PALETTE.metalDark), 0, 0.048, 0.042)); // beavertail
  // ---- grip: polymer furniture, ink side panels for the third value
  const grip = box(0.045, 0.13, 0.06, PALETTE.charcoal);
  grip.rotation.x = -0.12; // raked back
  grip.add(at(box(0.006, 0.1, 0.05, PALETTE.ink), -0.024, 0, 0.001)); // checkered panel
  grip.add(at(box(0.006, 0.1, 0.05, PALETTE.ink), 0.024, 0, 0.001));
  grip.add(at(box(0.03, 0.12, 0.008, PALETTE.metalDark), 0, 0, 0.031)); // backstrap
  grip.add(at(box(0.052, 0.014, 0.068, PALETTE.steel), 0, -0.068, 0.002)); // mag-well lip
  const bail = slingBail();
  bail.rotation.x = Math.PI; // hangs off the heel, loop opening downwards
  grip.add(at(bail, 0, -0.058, 0.034)); // lanyard loop (3 prims)
  g.add(at(grip, 0, -0.055, 0.015));
  // mag: loose — body hidden inside the grip, baseplate proud at the heel.
  // body + baseplate share metalDark so the baked mag is 2 meshes, not 3; the
  // steel lip is what actually reads when it drops out during the reload.
  const mag = new THREE.Group();
  mag.add(at(box(0.04, 0.1, 0.05, PALETTE.metalDark), 0, -0.005, 0.003)); // body (in the grip)
  mag.add(at(box(0.05, 0.015, 0.07, PALETTE.metalDark), 0, -0.064, 0.01)); // baseplate
  mag.add(at(box(0.052, 0.006, 0.072, PALETTE.steel), 0, -0.073, 0.01)); // floorplate lip
  g.add(looseMag(mag, 0, -0.055, 0.015, -0.12)); // same rake as the grip
  g.add(at(box(0.038, 0.009, 0.062, PALETTE.metalDark), 0, -0.014, -0.05)); // trigger guard
  g.add(at(box(0.038, 0.03, 0.009, PALETTE.metalDark), 0, -0.002, -0.077)); // guard bow
  g.add(at(box(0.011, 0.026, 0.008, PALETTE.steel), 0, -0.002, -0.045)); // trigger
}

/**
 * Stubby smg — 38 prims, 5 materials. steel upper / metalDark lower / charcoal
 * polymer. Same crevice choice as the pistol: `ink` carries the recesses AND
 * the stipple panel, so the polymer furniture keeps its value break for free.
 */
function buildSmg(g: THREE.Group): void {
  // ---- receiver: dark lower, light upper, dark rail on top (three planes)
  g.add(at(box(0.055, 0.058, 0.3, PALETTE.metalDark), 0, 0.042, -0.08)); // lower
  g.add(at(box(0.056, 0.032, 0.3, PALETTE.steel), 0, 0.087, -0.08)); // upper
  g.add(at(box(0.026, 0.008, 0.2, PALETTE.ink), 0, 0.106, -0.1)); // top rail
  g.add(at(box(0.009, 0.026, 0.075, PALETTE.ink), -0.029, 0.062, -0.06)); // ejection port
  g.add(at(box(0.008, 0.006, 0.08, PALETTE.steelLit), -0.03, 0.077, -0.06)); // port lip
  g.add(at(box(0.012, 0.014, 0.05, PALETTE.steel), -0.032, 0.092, 0.02)); // charging handle
  const chKnob = cyl(0.008, 0.008, 0.022, 6, PALETTE.steelLit);
  chKnob.rotation.z = Math.PI / 2;
  g.add(at(chKnob, -0.044, 0.092, 0.03)); // charging-handle knob
  // ---- barrel shroud + muzzle
  g.add(at(box(0.05, 0.012, 0.16, PALETTE.steel), 0, 0.096, -0.28)); // shroud top
  g.add(at(box(0.008, 0.05, 0.16, PALETTE.steel), 0.028, BARREL_Y, -0.28)); // shroud side
  g.add(at(box(0.008, 0.05, 0.16, PALETTE.steel), -0.028, BARREL_Y, -0.28)); // shroud side
  g.add(at(box(0.006, 0.024, 0.022, PALETTE.ink), -0.031, BARREL_Y, -0.245)); // vent
  g.add(at(box(0.006, 0.024, 0.022, PALETTE.ink), -0.031, BARREL_Y, -0.315)); // vent
  const barrel = cyl(0.011, 0.011, 0.1, 8, PALETTE.steelLit);
  barrel.rotation.x = Math.PI / 2;
  g.add(at(barrel, 0, BARREL_Y, -0.4));
  const brake = cyl(0.017, 0.017, 0.04, 8, PALETTE.metalDark);
  brake.rotation.x = Math.PI / 2;
  g.add(at(brake, 0, BARREL_Y, -0.442)); // muzzle brake
  // ---- mag well + loose curved mag
  g.add(at(box(0.044, 0.05, 0.056, PALETTE.metalDark), 0, 0.008, -0.06)); // mag well
  g.add(at(box(0.05, 0.016, 0.064, PALETTE.steel), 0, -0.018, -0.06)); // mag-well lip
  // mag: loose, two segments — bottom sweeps forward for the curved read
  const mag = new THREE.Group();
  const magA = box(0.035, 0.1, 0.05, PALETTE.metalDark);
  magA.rotation.x = 0.18;
  magA.add(at(box(0.037, 0.006, 0.052, PALETTE.ink), 0, 0.02, 0)); // witness rib
  mag.add(at(magA, 0, -0.04, 0));
  const magB = box(0.035, 0.09, 0.045, PALETTE.metalDark);
  magB.rotation.x = 0.5;
  magB.add(at(box(0.038, 0.008, 0.048, PALETTE.steel), 0, -0.048, 0)); // floorplate
  mag.add(at(magB, 0, -0.12, -0.018));
  g.add(looseMag(mag, 0, -0.04, -0.06));
  // ---- furniture: collapsible stock, cheek strut, polymer grip
  const stockTube = cyl(0.014, 0.014, 0.12, 8, PALETTE.metalDark);
  stockTube.rotation.x = Math.PI / 2;
  g.add(at(stockTube, 0, 0.055, 0.12));
  g.add(at(box(0.036, 0.014, 0.12, PALETTE.charcoal), 0, 0.082, 0.12)); // top strut
  g.add(at(box(0.042, 0.062, 0.022, PALETTE.charcoal), 0, 0.05, 0.185)); // butt pad
  g.add(at(box(0.044, 0.012, 0.026, PALETTE.ink), 0, 0.077, 0.185)); // pad edge (crevice tone)
  const grip = box(0.04, 0.1, 0.05, PALETTE.charcoal);
  grip.rotation.x = -0.15;
  grip.add(at(box(0.006, 0.07, 0.04, PALETTE.ink), -0.019, 0, 0)); // stipple panel
  g.add(at(grip, 0, -0.03, 0.03));
  g.add(at(box(0.036, 0.008, 0.058, PALETTE.metalDark), 0, -0.008, -0.005)); // trigger guard
  g.add(at(box(0.036, 0.026, 0.008, PALETTE.metalDark), 0, 0.004, -0.03)); // guard bow
  g.add(at(box(0.01, 0.024, 0.008, PALETTE.steel), 0, 0.005, 0.0)); // trigger
  // ---- sights: post with ears up front, two-prong notch at the rear
  g.add(at(box(0.018, 0.01, 0.02, PALETTE.metalDark), 0, 0.106, -0.33)); // post base
  g.add(at(box(0.008, 0.022, 0.008, PALETTE.steelLit), 0, 0.117, -0.33)); // front post
  g.add(at(box(0.006, 0.02, 0.01, PALETTE.metalDark), -0.014, 0.115, -0.33)); // ear
  g.add(at(box(0.006, 0.02, 0.01, PALETTE.metalDark), 0.014, 0.115, -0.33)); // ear
  g.add(at(box(0.03, 0.01, 0.02, PALETTE.metalDark), 0, 0.1, 0.04)); // rear base
  g.add(at(box(0.008, 0.02, 0.012, PALETTE.steel), -0.013, 0.111, 0.04)); // notch prong
  g.add(at(box(0.008, 0.02, 0.012, PALETTE.steel), 0.013, 0.111, 0.04)); // notch prong
  const bail = slingBail();
  bail.rotation.z = Math.PI / 2; // hangs off the camera-side flank
  g.add(at(bail, -0.032, 0.02, 0.085)); // sling loop (3 prims)
}

/**
 * Tube shotgun — 36 prims, 6 materials. metalDark barrels + caps + butt plate /
 * steel rib+top / steelLit highlights / wood + woodLit furniture / metalDeep
 * for EVERY recess, metal and wood alike (a groove is a shadow line; it does
 * not need its own hue, and a second dark tone would cost a draw call per
 * player).
 */
function buildShotgun(g: THREE.Group): void {
  const barrel = cyl(0.016, 0.016, 0.55, 10, PALETTE.metalDark);
  barrel.rotation.x = Math.PI / 2;
  g.add(at(barrel, 0, 0.085, -0.3));
  g.add(at(box(0.016, 0.008, 0.5, PALETTE.steel), 0, 0.102, -0.3)); // vent rib along the top
  const tube = cyl(0.014, 0.014, 0.5, 10, PALETTE.metalDark);
  tube.rotation.x = Math.PI / 2;
  g.add(at(tube, 0, 0.045, -0.28)); // magazine tube under the barrel
  const cap = cyl(0.018, 0.018, 0.03, 8, PALETTE.steel);
  cap.rotation.x = Math.PI / 2;
  g.add(at(cap, 0, 0.045, -0.525)); // tube cap
  g.add(at(box(0.042, 0.05, 0.02, PALETTE.metalDeep), 0, 0.065, -0.5)); // barrel band
  // ---- receiver: dark body, light top, recessed port with a lit lip
  g.add(at(box(0.055, 0.075, 0.17, PALETTE.metalDark), 0, 0.05, 0.03));
  g.add(at(box(0.05, 0.018, 0.17, PALETTE.steel), 0, 0.093, 0.03)); // receiver top
  g.add(at(box(0.009, 0.03, 0.08, PALETTE.metalDeep), -0.029, 0.05, 0.02)); // ejection port
  g.add(at(box(0.008, 0.007, 0.085, PALETTE.steelLit), -0.03, 0.067, 0.02)); // port lip
  g.add(at(box(0.03, 0.016, 0.06, PALETTE.metalDeep), 0, 0.014, 0.02)); // loading gate
  // ---- pump: the charging handle of a pump gun. Wood with grooves + cap.
  const pump = box(0.06, 0.05, 0.12, PALETTE.wood);
  pump.add(at(box(0.05, 0.008, 0.1, PALETTE.woodLit), 0, 0.027, 0)); // grain panel along the pump
  pump.add(at(box(0.008, 0.03, 0.1, PALETTE.woodLit), -0.031, 0, 0)); // side grain (camera side)
  pump.add(at(box(0.062, 0.008, 0.014, PALETTE.metalDeep), 0, 0.0, -0.03)); // finger groove
  pump.add(at(box(0.062, 0.008, 0.014, PALETTE.metalDeep), 0, 0.0, 0.03)); // finger groove
  pump.add(at(box(0.062, 0.052, 0.014, PALETTE.metalDark), 0, 0, -0.065)); // steel front cap
  g.add(at(pump, 0, 0.045, -0.28));
  // ---- stock
  const stock = box(0.05, 0.09, 0.2, PALETTE.wood);
  stock.rotation.x = -0.1;
  stock.add(at(box(0.04, 0.008, 0.16, PALETTE.woodLit), 0, 0.047, 0)); // comb highlight
  stock.add(at(box(0.008, 0.05, 0.16, PALETTE.woodLit), -0.026, 0, 0)); // side grain (camera side)
  stock.add(at(box(0.052, 0.012, 0.03, PALETTE.metalDeep), 0, -0.043, -0.06)); // wrist groove
  g.add(at(stock, 0, 0.02, 0.2));
  g.add(at(box(0.055, 0.1, 0.015, PALETTE.metalDark), 0, 0.012, 0.3)); // steel butt plate
  g.add(at(box(0.057, 0.028, 0.018, PALETTE.metalDeep), 0, -0.028, 0.3)); // recoil pad
  // ---- shell saddle with three loaded hulls (woodLit L55 = the hull red,
  // and it is already on this gun as the grain tone)
  g.add(at(box(0.06, 0.02, 0.1, PALETTE.metalDark), 0, 0.095, 0.03)); // shell saddle
  for (let i = 0; i < 3; i++) {
    const shell = cyl(0.009, 0.009, 0.055, 6, PALETTE.woodLit);
    shell.rotation.x = Math.PI / 2;
    g.add(at(shell, -0.018 + i * 0.018, 0.112, 0.03));
  }
  g.add(at(box(0.04, 0.008, 0.06, PALETTE.metalDark), 0, 0.0, 0.03)); // trigger guard
  g.add(at(box(0.04, 0.024, 0.008, PALETTE.metalDark), 0, 0.012, 0.002)); // guard bow
  g.add(at(box(0.01, 0.022, 0.008, PALETTE.steel), 0, 0.012, 0.03)); // trigger
  // ---- sights: brass-less bead up front, notch on the receiver top
  g.add(at(box(0.012, 0.006, 0.016, PALETTE.metalDark), 0, 0.106, -0.56)); // bead base
  g.add(at(box(0.008, 0.012, 0.008, PALETTE.steelLit), 0, 0.113, -0.56)); // bead sight
  g.add(at(box(0.028, 0.01, 0.02, PALETTE.metalDark), 0, 0.104, 0.09)); // rear base
  g.add(at(box(0.008, 0.018, 0.012, PALETTE.steel), -0.012, 0.116, 0.09)); // notch prong
  g.add(at(box(0.008, 0.018, 0.012, PALETTE.steel), 0.012, 0.116, 0.09)); // notch prong
  const bail = slingBail();
  bail.rotation.x = Math.PI; // hangs under the mag tube, loop opening down
  g.add(at(bail, 0, 0.028, -0.47)); // sling loop (3 prims)
}

/**
 * Curved-mag rifle — 39 prims, 6 materials. metalDark body + steel-fitting caps
 * (butt plate, grip cap, mag floorplate) / steel dust cover / steelLit
 * highlights / wood + woodLit furniture / metalDeep for every recess and the
 * recoil pad.
 */
function buildRifle(g: THREE.Group): void {
  const barrel = cyl(0.013, 0.013, 0.45, 10, PALETTE.metalDark);
  barrel.rotation.x = Math.PI / 2;
  g.add(at(barrel, 0, 0.075, -0.42)); // long barrel
  const gasTube = cyl(0.009, 0.009, 0.2, 8, PALETTE.steel);
  gasTube.rotation.x = Math.PI / 2;
  g.add(at(gasTube, 0, 0.104, -0.36)); // gas tube above the barrel
  g.add(at(box(0.032, 0.045, 0.045, PALETTE.metalDark), 0, 0.092, -0.47)); // gas block
  const nut = cyl(0.018, 0.018, 0.045, 8, PALETTE.metalDark);
  nut.rotation.x = Math.PI / 2;
  g.add(at(nut, 0, 0.075, -0.625)); // muzzle nut
  // ---- handguard: wood body, lit grain, deep finger grooves
  const handguard = box(0.055, 0.055, 0.28, PALETTE.wood);
  handguard.add(at(box(0.008, 0.032, 0.24, PALETTE.woodLit), -0.0285, 0, 0)); // side grain (camera side)
  handguard.add(at(box(0.057, 0.012, 0.014, PALETTE.metalDeep), 0, -0.012, 0.0)); // finger groove
  g.add(at(handguard, 0, BARREL_Y, -0.2));
  g.add(at(box(0.05, 0.05, 0.02, PALETTE.metalDark), 0, BARREL_Y, -0.335)); // handguard cap
  // ---- receiver: dark lower, steel dust cover on top, recessed port
  g.add(at(box(0.055, 0.07, 0.22, PALETTE.metalDark), 0, 0.05, 0.02)); // receiver (gunmetal)
  g.add(at(box(0.056, 0.024, 0.21, PALETTE.steel), 0, 0.088, 0.02)); // dust cover
  g.add(at(box(0.009, 0.03, 0.09, PALETTE.metalDeep), -0.029, 0.062, 0.0)); // ejection port
  g.add(at(box(0.008, 0.007, 0.095, PALETTE.steelLit), -0.03, 0.079, 0.0)); // port lip
  g.add(at(box(0.013, 0.014, 0.045, PALETTE.steel), -0.033, 0.076, 0.06)); // charging handle
  const chKnob = cyl(0.008, 0.008, 0.022, 6, PALETTE.steelLit);
  chKnob.rotation.z = Math.PI / 2;
  g.add(at(chKnob, -0.045, 0.076, 0.07)); // charging-handle knob
  g.add(at(box(0.008, 0.055, 0.022, PALETTE.steel), -0.031, 0.04, 0.05)); // selector lever
  g.add(at(box(0.05, 0.016, 0.072, PALETTE.steel), 0, -0.012, -0.03)); // mag-well lip
  g.add(at(box(0.038, 0.008, 0.06, PALETTE.metalDark), 0, -0.02, 0.02)); // trigger guard
  g.add(at(box(0.038, 0.026, 0.008, PALETTE.metalDark), 0, -0.008, -0.008)); // guard bow
  g.add(at(box(0.011, 0.024, 0.008, PALETTE.steel), 0, -0.008, 0.02)); // trigger
  // ---- furniture
  const stock = box(0.05, 0.09, 0.22, PALETTE.wood);
  stock.rotation.x = -0.08;
  stock.add(at(box(0.04, 0.008, 0.18, PALETTE.woodLit), 0, 0.047, 0)); // comb highlight
  stock.add(at(box(0.008, 0.05, 0.18, PALETTE.woodLit), -0.026, 0, 0)); // side grain (camera side)
  stock.add(at(box(0.052, 0.095, 0.015, PALETTE.metalDark), 0, 0, 0.115)); // butt plate caps the heel
  stock.add(at(box(0.054, 0.03, 0.018, PALETTE.metalDeep), 0, -0.033, 0.117)); // recoil pad
  g.add(at(stock, 0, 0.02, 0.21));
  const grip = box(0.04, 0.1, 0.05, PALETTE.wood);
  grip.rotation.x = -0.2;
  grip.add(at(box(0.042, 0.012, 0.052, PALETTE.metalDark), 0, -0.053, 0)); // grip cap
  g.add(at(grip, 0, -0.035, 0.06));
  // mag: loose, three segments at rising tilt — the AK curve reads in profile
  const mag = new THREE.Group();
  const magA = box(0.035, 0.08, 0.06, PALETTE.wood);
  magA.rotation.x = 0.15;
  mag.add(at(magA, 0, -0.03, 0));
  const magB = box(0.035, 0.08, 0.055, PALETTE.wood);
  magB.rotation.x = 0.55;
  mag.add(at(magB, 0, -0.1, -0.02));
  const magC = box(0.033, 0.075, 0.05, PALETTE.wood);
  magC.rotation.x = 0.95; // tip completes the sweep forward
  magC.add(at(box(0.036, 0.012, 0.052, PALETTE.metalDark), 0, -0.038, 0)); // floorplate
  mag.add(at(magC, 0, -0.165, -0.055));
  g.add(looseMag(mag, 0, -0.025, -0.03)); // 3 wood segments bake to one mesh
  // ---- sights: hooded front post, two-prong rear notch on a steel block
  g.add(at(box(0.03, 0.03, 0.03, PALETTE.metalDark), 0, 0.1, -0.6)); // front sight base
  g.add(at(box(0.008, 0.03, 0.008, PALETTE.steelLit), 0, 0.122, -0.6)); // front sight post
  g.add(at(box(0.006, 0.026, 0.008, PALETTE.metalDark), -0.013, 0.118, -0.6)); // post guard ear
  g.add(at(box(0.006, 0.026, 0.008, PALETTE.metalDark), 0.013, 0.118, -0.6)); // post guard ear
  g.add(at(box(0.034, 0.018, 0.04, PALETTE.metalDark), 0, 0.096, -0.09)); // rear sight base
  g.add(at(box(0.008, 0.022, 0.014, PALETTE.steel), -0.015, 0.113, -0.09)); // notch prong
  g.add(at(box(0.008, 0.022, 0.014, PALETTE.steel), 0.015, 0.113, -0.09)); // notch prong
  const bail = slingBail();
  bail.rotation.x = Math.PI; // hangs under the handguard, loop opening down
  g.add(at(bail, 0, 0.026, -0.325)); // sling loop (3 prims)
}

/**
 * Long thin sniper — 39 prims, 6 materials. metalDark body + butt plate / steel
 * receiver top / steelLit highlights / woodDark stock with crate grain /
 * metalDeep for every recess and the recoil pad.
 */
function buildSniper(g: THREE.Group): void {
  const barrel = cyl(0.011, 0.011, 0.7, 10, PALETTE.metalDark);
  barrel.rotation.x = Math.PI / 2;
  g.add(at(barrel, 0, 0.08, -0.5)); // longest, thinnest barrel
  const brake = cyl(0.016, 0.016, 0.05, 8, PALETTE.metalDark);
  brake.rotation.x = Math.PI / 2;
  g.add(at(brake, 0, 0.08, -0.845)); // muzzle brake
  // ---- receiver: dark body, steel top, recessed port with a lit lip
  g.add(at(box(0.055, 0.07, 0.24, PALETTE.metalDark), 0, BARREL_Y, -0.02)); // receiver
  g.add(at(box(0.056, 0.02, 0.24, PALETTE.steel), 0, 0.098, -0.02)); // receiver top
  g.add(at(box(0.03, 0.008, 0.16, PALETTE.metalDeep), 0, 0.111, -0.02)); // mount rail
  g.add(at(box(0.009, 0.028, 0.07, PALETTE.metalDeep), -0.029, 0.07, -0.02)); // ejection port
  g.add(at(box(0.008, 0.006, 0.075, PALETTE.steelLit), -0.03, 0.085, -0.02)); // port lip
  g.add(at(box(0.05, 0.014, 0.07, PALETTE.steel), 0, 0.022, -0.05)); // mag-well lip
  g.add(at(box(0.038, 0.01, 0.055, PALETTE.metalDark), 0, 0.006, 0.032)); // trigger guard
  g.add(at(box(0.038, 0.026, 0.008, PALETTE.metalDark), 0, 0.014, 0.008)); // guard bow
  g.add(at(box(0.01, 0.02, 0.008, PALETTE.steel), 0, 0.014, 0.032)); // trigger
  // ---- furniture: forend, cheek-piece stock, pistol grip
  const forend = box(0.05, 0.05, 0.2, PALETTE.woodDark);
  forend.add(at(box(0.04, 0.008, 0.16, PALETTE.crate), 0, 0.027, 0)); // grain panel along the forend
  forend.add(at(box(0.008, 0.028, 0.16, PALETTE.crate), -0.026, 0, 0)); // side grain (camera side)
  forend.add(at(box(0.052, 0.012, 0.014, PALETTE.metalDeep), 0, -0.012, -0.05)); // finger groove
  g.add(at(forend, 0, 0.05, -0.28));
  const stock = box(0.05, 0.1, 0.26, PALETTE.woodDark);
  stock.rotation.x = -0.08;
  stock.add(at(box(0.04, 0.008, 0.2, PALETTE.crate), 0, 0.052, 0)); // grain panel along the stock
  stock.add(at(box(0.008, 0.05, 0.2, PALETTE.crate), -0.026, 0, 0)); // side grain (camera side)
  stock.add(at(box(0.044, 0.022, 0.14, PALETTE.crate), 0, 0.062, -0.03)); // cheek riser
  stock.add(at(box(0.052, 0.105, 0.016, PALETTE.metalDark), 0, 0, 0.135)); // steel butt plate
  stock.add(at(box(0.054, 0.03, 0.02, PALETTE.metalDeep), 0, -0.038, 0.137)); // recoil pad
  g.add(at(stock, 0, 0.02, 0.22));
  const grip = box(0.04, 0.09, 0.05, PALETTE.woodDark);
  grip.rotation.x = -0.2;
  grip.add(at(box(0.042, 0.012, 0.052, PALETTE.crate), 0, -0.048, 0)); // grip cap
  g.add(at(grip, 0, -0.02, 0.08)); // wrist grip: tucks up under the receiver
  // ---- optics: tube, bell, eyepiece, turret, rings
  const scope = cyl(0.018, 0.018, 0.16, 10, PALETTE.metalDark);
  scope.rotation.x = Math.PI / 2;
  g.add(at(scope, 0, 0.14, -0.02)); // scope tube
  const bell = cyl(0.024, 0.02, 0.05, 10, PALETTE.metalDark);
  bell.rotation.x = Math.PI / 2;
  g.add(at(bell, 0, 0.14, -0.115)); // objective bell
  const lens = cyl(0.021, 0.021, 0.008, 10, PALETTE.metalDeep);
  lens.rotation.x = Math.PI / 2;
  g.add(at(lens, 0, 0.14, -0.142)); // objective lens
  const eyepiece = cyl(0.022, 0.02, 0.045, 10, PALETTE.metalDark);
  eyepiece.rotation.x = Math.PI / 2;
  g.add(at(eyepiece, 0, 0.14, 0.078)); // eyepiece
  g.add(at(cyl(0.012, 0.012, 0.022, 8, PALETTE.steel), 0, 0.164, -0.02)); // elevation turret
  const ringF = cyl(0.024, 0.024, 0.014, 8, PALETTE.steel);
  ringF.rotation.x = Math.PI / 2;
  g.add(at(ringF, 0, 0.14, 0.03));
  const ringR = cyl(0.024, 0.024, 0.014, 8, PALETTE.steel);
  ringR.rotation.x = Math.PI / 2;
  g.add(at(ringR, 0, 0.14, -0.07));
  // ---- bipod
  const bipodL = cyl(0.006, 0.006, 0.09, 6, PALETTE.metalDark);
  bipodL.rotation.z = 0.3;
  g.add(at(bipodL, 0.025, 0.02, -0.55));
  const bipodR = cyl(0.006, 0.006, 0.09, 6, PALETTE.metalDark);
  bipodR.rotation.z = -0.3;
  g.add(at(bipodR, -0.025, 0.02, -0.55));
  // bolt handle (this rifle's charging handle): pin out the camera-side flank,
  // bent arm down to a bright knob so the throw reads at a glance
  const bolt = cyl(0.008, 0.008, 0.04, 6, PALETTE.metalDark);
  bolt.rotation.z = Math.PI / 2;
  g.add(at(bolt, -0.045, BARREL_Y, 0.05));
  g.add(at(box(0.012, 0.04, 0.014, PALETTE.metalDark), -0.062, 0.045, 0.05)); // bent arm
  g.add(at(sphere(0.015, 6, PALETTE.steelLit), -0.062, 0.022, 0.05)); // knob
  const bail = slingBail();
  bail.rotation.x = Math.PI; // hangs under the forend, loop opening down
  g.add(at(bail, 0, 0.02, -0.365)); // sling loop (3 prims), clear of the support hand
  // mag: loose box ahead of the trigger guard, with a steel floorplate
  const mag = new THREE.Group();
  mag.add(box(0.04, 0.06, 0.08, PALETTE.metalDark));
  mag.add(at(box(0.046, 0.012, 0.086, PALETTE.steel), 0, -0.035, 0)); // floorplate
  g.add(looseMag(mag, 0, -0.01, -0.05));
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

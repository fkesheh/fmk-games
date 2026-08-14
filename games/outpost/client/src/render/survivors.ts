// ============================================================================
// ART 5/6 — SURVIVORS & VIEWMODEL.
//
// Two exported classes, per CONTRACT.md:
//   SurvivorModels — third-person co-op teammates (and downed markers).
//   ViewModel      — the first-person hands + gun, camera-parented.
//
// SILHOUETTE LANGUAGE (STYLE_BIBLE): layered coat over webbing, a helmet or
// knit-cap variant (per-player, seeded off their id — never Math.random), a
// LIT shoulder lamp, visible hands, a `hudAccent` armband so teammates read
// instantly at range. The DOWNED pose is a deliberately different silhouette
// (prone, one arm raised) with a `reviveCyan` beacon that renders THROUGH
// geometry — finding your downed teammate is a core verb, not a nice-to-have.
//
// DRAW-CALL DISCIPLINE: every rigid sub-assembly (torso, head, each leg, each
// arm) is built from raw primitives and then baked with `bake()` into one
// mesh per material *within that sub-assembly*, while the sub-assembly's own
// pivot group is left live so it can still be rotated per frame. Only the
// pivots move; nothing inside them is re-baked per frame.
//
// LIGHTING INDEPENDENCE (the mandate this file exists to satisfy): the
// previous build's viewmodel was "present and completely unlit... OUTPOST
// reads as a walking sim." A real THREE.Light bolted to the camera was
// rejected here on purpose — STYLE_BIBLE's own post-mortem records a
// near-field blowout at luma 200-201 from a light whose falloff reached
// nearby geometry, and a camera-parented point light necessarily sits close
// to whatever the player is standing next to. Instead every ViewModel
// material carries its own PALETTE-keyed emissive "floor" (one ladder tier
// below its base colour, e.g. `steel` emissive `metalDark`) via the `vTone`
// table below — self-lit by construction, zero risk of bleeding onto world
// geometry, and it still reads the flat-shaded facet break because the
// emissive floor sits below full brightness. Third-person survivors are NOT
// given this treatment: they stand in the world and should shade with it.
//
// WEAPON GEOMETRY SCOPE: the excellent rig ported from
// games/fps/client/src/render/viewModel.ts (spring recoil, walk bob, idle
// breathing sway, swap hump, the mag-drop reload choreography with the
// magazine kept as a loose unbaked child) is preserved in full. The detailed
// per-weapon model sheet (25-40 prims, front sight + rear notch + mag well +
// sling bail) is reused only for the FIRST-PERSON viewmodel, which is what
// the player stares at for the whole run. Third-person survivors carry a
// compact, silhouette-only weapon read (6-10 prims) in the weapon hand: at
// co-op ranges among 16 possible teammates, the coat/lamp/armband read is
// what has to carry recognition, and a second full detail pass per teammate
// per frame would spend draw calls the character body already needs. This is
// a scope call, not a contract gap: CONTRACT.md's SurvivorModels/ViewModel
// shapes do not require they share one weapon-model code path.
// ============================================================================
import * as THREE from 'three';
import type { WeaponId } from '@fps/shared';
import type { PlayerId, SurvivorSnap } from '@outpost/shared';
import { PALETTE } from '@outpost/shared';
import { at, bake, box, contactShadow, cone, cyl, mat, sphere, vrng } from '../contract/visual.js';

// ---------------------------------------------------------------------------
// Deterministic per-player seed (PlayerId is a string; Math.random is a
// contract violation everywhere in this codebase, so cosmetic variation is
// always seeded off something stable — here, the player's own id).
// ---------------------------------------------------------------------------
function hashSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

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

// ===========================================================================
// SECTION A — the first-person weapon model sheet (self-lit, ViewModel only).
// ===========================================================================

/**
 * Emissive "floor" companion per base tone, one ladder tier down — see the
 * header. Every hex on the right is itself a PALETTE key; this is the exact
 * pattern STRICKEN uses for its team rim-light (`{ emissive: dark }`), just
 * applied uniformly so the whole viewmodel is lighting-independent rather
 * than one tone of it.
 */
const V_EMISSIVE: Record<string, string> = {
  [PALETTE.steel]: PALETTE.metalDark,
  [PALETTE.steelLit]: PALETTE.steel,
  [PALETTE.metalDark]: PALETTE.metalDeep,
  [PALETTE.metalDeep]: PALETTE.metalDeep,
  [PALETTE.wood]: PALETTE.woodDark,
  [PALETTE.woodLit]: PALETTE.wood,
  [PALETTE.woodDark]: PALETTE.woodDeep,
  [PALETTE.charcoal]: PALETTE.ink,
  [PALETTE.ink]: PALETTE.ink,
  [PALETTE.crate]: PALETTE.woodDark,
  [PALETTE.concrete]: PALETTE.concreteDark,
};

function vbox(w: number, h: number, d: number, hex: string): THREE.Mesh {
  return box(w, h, d, hex, { emissive: V_EMISSIVE[hex] ?? hex });
}
function vcyl(rTop: number, rBottom: number, h: number, seg: number, hex: string): THREE.Mesh {
  return cyl(rTop, rBottom, h, seg, hex, { emissive: V_EMISSIVE[hex] ?? hex });
}
function vcone(r: number, h: number, seg: number, hex: string): THREE.Mesh {
  return cone(r, h, seg, hex, { emissive: V_EMISSIVE[hex] ?? hex });
}
function vsphere(r: number, seg: number, hex: string): THREE.Mesh {
  return sphere(r, seg, hex, { emissive: V_EMISSIVE[hex] ?? hex });
}

const BARREL_Y = 0.06;

const MUZZLE: Record<WeaponId, { y: number; z: number }> = {
  knife: { y: 0.0, z: -0.5 },
  pistol: { y: BARREL_Y, z: -0.26 },
  smg: { y: BARREL_Y, z: -0.42 },
  shotgun: { y: 0.085, z: -0.56 },
  rifle: { y: 0.075, z: -0.62 },
  sniper: { y: 0.08, z: -0.82 },
};

const HAND_L: Record<WeaponId, { y: number; z: number } | null> = {
  knife: null,
  pistol: { y: -0.02, z: -0.09 },
  smg: { y: 0.0, z: -0.24 },
  shotgun: { y: 0.02, z: -0.26 },
  rifle: { y: -0.005, z: -0.22 },
  sniper: { y: 0.01, z: -0.28 },
};

/** Flag a loose magazine part; makeViewWeaponModel keeps it unbaked. */
function markMag<T extends THREE.Object3D>(o: T): T {
  o.userData['mag'] = true;
  return o;
}

/** Merge a magazine's primitives to one mesh per material at its rest pose. */
function looseMag(parts: THREE.Group, x: number, y: number, z: number, rx = 0): THREE.Group {
  const magGeo = bake(parts);
  magGeo.position.set(x, y, z);
  magGeo.rotation.x = rx;
  return markMag(magGeo);
}

/** Two steel posts + a crossbar: a sling loop with a real gap. 3 prims. */
function slingBail(): THREE.Group {
  const g = new THREE.Group();
  g.add(at(vbox(0.006, 0.018, 0.006, PALETTE.steel), 0, 0, -0.011));
  g.add(at(vbox(0.006, 0.018, 0.006, PALETTE.steel), 0, 0, 0.011));
  g.add(at(vbox(0.006, 0.006, 0.028, PALETTE.steel), 0, 0.012, 0));
  return g;
}

/** Blade knife — 20 prims, 4 tones: steel / steelLit edge / woodDark grip / metalDark guard. */
function buildKnifeVM(g: THREE.Group): void {
  const tilt = new THREE.Group();
  tilt.rotation.x = 0.18;
  tilt.add(at(vbox(0.018, 0.075, 0.34, PALETTE.steel), 0, 0, -0.26));
  tilt.add(at(vbox(0.02, 0.016, 0.34, PALETTE.steelLit), 0, -0.031, -0.26)); // sharpened edge
  tilt.add(at(vbox(0.02, 0.012, 0.32, PALETTE.metalDark), 0, 0.036, -0.26)); // spine
  const tip = vcone(0.038, 0.09, 4, PALETTE.steel);
  tip.rotation.x = -Math.PI / 2;
  tip.scale.x = 0.35;
  tilt.add(at(tip, 0, 0, -0.475));
  tilt.add(at(vbox(0.038, 0.09, 0.018, PALETTE.metalDark), 0, 0, -0.09)); // guard
  tilt.add(at(vbox(0.048, 0.015, 0.02, PALETTE.steel), 0, -0.037, -0.09)); // quillon
  tilt.add(at(vbox(0.019, 0.048, 0.038, PALETTE.metalDark), 0, 0, -0.063)); // ricasso
  const grip = vbox(0.032, 0.05, 0.15, PALETTE.woodDark);
  grip.add(at(vbox(0.006, 0.03, 0.11, PALETTE.woodLit), -0.016, 0, 0)); // camera-side grain
  grip.add(at(vbox(0.034, 0.008, 0.013, PALETTE.metalDark), 0, 0, 0.04)); // cord wrap ring
  grip.add(at(vbox(0.034, 0.008, 0.013, PALETTE.metalDark), 0, 0, -0.04));
  tilt.add(at(grip, 0, -0.01, 0));
  tilt.add(at(vbox(0.04, 0.06, 0.024, PALETTE.metalDark), 0, -0.012, 0.075)); // pommel
  tilt.add(at(vbox(0.042, 0.012, 0.026, PALETTE.steel), 0, 0.014, 0.075)); // pommel cap
  const breaker = vcone(0.01, 0.026, 4, PALETTE.metalDark);
  breaker.rotation.x = Math.PI / 2;
  tilt.add(at(breaker, 0, -0.012, 0.1)); // glass breaker
  tilt.add(at(vbox(0.034, 0.01, 0.01, PALETTE.steel), 0, -0.008, 0.02)); // rivet
  tilt.add(at(vbox(0.034, 0.01, 0.01, PALETTE.steel), 0, -0.008, -0.045)); // rivet
  g.add(tilt);
}

/** Compact pistol — 26 prims, 5 tones: steel / steelLit / metalDark / charcoal / ink. */
function buildPistolVM(g: THREE.Group): void {
  g.add(at(vbox(0.05, 0.052, 0.22, PALETTE.steel), 0, BARREL_Y, -0.1)); // slide
  g.add(at(vbox(0.028, 0.008, 0.22, PALETTE.steelLit), 0, 0.084, -0.1)); // top strap
  g.add(at(vbox(0.05, 0.048, 0.028, PALETTE.steel), 0, 0.056, -0.222)); // nose block
  g.add(at(vbox(0.01, 0.026, 0.08, PALETTE.ink), -0.022, 0.064, -0.06)); // ejection port
  g.add(at(vbox(0.009, 0.005, 0.085, PALETTE.steelLit), -0.023, 0.08, -0.06)); // port lip
  g.add(at(vbox(0.008, 0.042, 0.008, PALETTE.ink), -0.0235, 0.056, -0.01)); // cocking serration
  g.add(at(vbox(0.008, 0.042, 0.008, PALETTE.ink), -0.0235, 0.056, -0.026));
  g.add(at(vbox(0.044, 0.034, 0.19, PALETTE.metalDark), 0, 0.017, -0.086)); // frame
  g.add(at(vbox(0.03, 0.012, 0.09, PALETTE.ink), 0, 0.003, -0.14)); // dust cover
  const barrel = vcyl(0.011, 0.011, 0.056, 8, PALETTE.steelLit);
  barrel.rotation.x = Math.PI / 2;
  g.add(at(barrel, 0, BARREL_Y, -0.232));
  const crown = vcyl(0.0128, 0.0128, 0.012, 8, PALETTE.ink);
  crown.rotation.x = Math.PI / 2;
  g.add(at(crown, 0, BARREL_Y, -0.258));
  g.add(at(vbox(0.015, 0.007, 0.02, PALETTE.metalDark), 0, 0.086, -0.19)); // front sight base
  g.add(at(vbox(0.008, 0.015, 0.011, PALETTE.steelLit), 0, 0.094, -0.19)); // front post
  g.add(at(vbox(0.032, 0.013, 0.017, PALETTE.metalDark), 0, 0.088, 0)); // rear sight base
  g.add(at(vbox(0.009, 0.015, 0.014, PALETTE.steel), -0.011, 0.094, 0)); // notch prong
  g.add(at(vbox(0.009, 0.015, 0.014, PALETTE.steel), 0.011, 0.094, 0)); // notch prong
  g.add(at(vbox(0.011, 0.02, 0.013, PALETTE.steel), 0, 0.073, 0.034)); // hammer
  const grip = vbox(0.044, 0.125, 0.058, PALETTE.charcoal);
  grip.rotation.x = -0.12;
  grip.add(at(vbox(0.006, 0.095, 0.048, PALETTE.ink), -0.023, 0, 0.001)); // checkering
  grip.add(at(vbox(0.006, 0.095, 0.048, PALETTE.ink), 0.023, 0, 0.001));
  grip.add(at(vbox(0.05, 0.013, 0.065, PALETTE.steel), 0, -0.065, 0.002)); // mag-well lip
  g.add(at(grip, 0, -0.053, 0.014));
  const mag = new THREE.Group();
  mag.add(at(vbox(0.038, 0.095, 0.048, PALETTE.metalDark), 0, -0.005, 0.003));
  mag.add(at(vbox(0.048, 0.014, 0.066, PALETTE.metalDark), 0, -0.061, 0.01));
  mag.add(at(vbox(0.05, 0.006, 0.068, PALETTE.steel), 0, -0.07, 0.01));
  g.add(looseMag(mag, 0, -0.053, 0.014, -0.12));
  g.add(at(vbox(0.036, 0.008, 0.058, PALETTE.metalDark), 0, -0.013, -0.048)); // trigger guard
  g.add(at(vbox(0.036, 0.028, 0.008, PALETTE.metalDark), 0, -0.002, -0.074)); // guard bow
  g.add(at(vbox(0.01, 0.024, 0.008, PALETTE.steel), 0, -0.002, -0.043)); // trigger
}

/** Stubby smg — 27 prims, 5 tones: steel / steelLit / metalDark / ink / charcoal. */
function buildSmgVM(g: THREE.Group): void {
  g.add(at(vbox(0.052, 0.055, 0.28, PALETTE.metalDark), 0, 0.04, -0.075)); // lower
  g.add(at(vbox(0.054, 0.03, 0.28, PALETTE.steel), 0, 0.083, -0.075)); // upper
  g.add(at(vbox(0.024, 0.007, 0.19, PALETTE.ink), 0, 0.1, -0.095)); // top rail
  g.add(at(vbox(0.009, 0.024, 0.07, PALETTE.ink), -0.028, 0.058, -0.056)); // ejection port
  g.add(at(vbox(0.008, 0.005, 0.075, PALETTE.steelLit), -0.029, 0.072, -0.056)); // port lip
  const ch = vcyl(0.007, 0.007, 0.02, 6, PALETTE.steelLit);
  ch.rotation.z = Math.PI / 2;
  g.add(at(ch, -0.042, 0.088, 0.024)); // charging handle knob
  g.add(at(vbox(0.048, 0.011, 0.15, PALETTE.steel), 0, 0.09, -0.26)); // shroud top
  g.add(at(vbox(0.007, 0.048, 0.15, PALETTE.steel), 0.027, BARREL_Y, -0.26)); // shroud side
  g.add(at(vbox(0.007, 0.048, 0.15, PALETTE.steel), -0.027, BARREL_Y, -0.26));
  const barrel = vcyl(0.01, 0.01, 0.09, 8, PALETTE.steelLit);
  barrel.rotation.x = Math.PI / 2;
  g.add(at(barrel, 0, BARREL_Y, -0.375));
  const brake = vcyl(0.016, 0.016, 0.036, 8, PALETTE.metalDark);
  brake.rotation.x = Math.PI / 2;
  g.add(at(brake, 0, BARREL_Y, -0.414));
  g.add(at(vbox(0.042, 0.048, 0.052, PALETTE.metalDark), 0, 0.008, -0.056)); // mag well
  g.add(at(vbox(0.048, 0.015, 0.06, PALETTE.steel), 0, -0.017, -0.056)); // mag-well lip
  const mag = new THREE.Group();
  const magA = vbox(0.033, 0.095, 0.048, PALETTE.metalDark);
  magA.rotation.x = 0.18;
  mag.add(at(magA, 0, -0.038, 0));
  const magB = vbox(0.033, 0.085, 0.043, PALETTE.metalDark);
  magB.rotation.x = 0.5;
  magB.add(at(vbox(0.036, 0.007, 0.046, PALETTE.steel), 0, -0.046, 0));
  mag.add(at(magB, 0, -0.115, -0.017));
  g.add(looseMag(mag, 0, -0.038, -0.056));
  const stockTube = vcyl(0.013, 0.013, 0.11, 8, PALETTE.metalDark);
  stockTube.rotation.x = Math.PI / 2;
  g.add(at(stockTube, 0, 0.052, 0.115));
  g.add(at(vbox(0.04, 0.058, 0.02, PALETTE.charcoal), 0, 0.048, 0.175)); // butt pad
  const grip = vbox(0.038, 0.095, 0.048, PALETTE.charcoal);
  grip.rotation.x = -0.15;
  grip.add(at(vbox(0.006, 0.065, 0.038, PALETTE.ink), -0.018, 0, 0));
  g.add(at(grip, 0, -0.03, 0.028));
  g.add(at(vbox(0.034, 0.008, 0.055, PALETTE.metalDark), 0, -0.007, -0.005)); // trigger guard
  g.add(at(vbox(0.01, 0.022, 0.008, PALETTE.steel), 0, 0.005, 0.0)); // trigger
  g.add(at(vbox(0.017, 0.009, 0.019, PALETTE.metalDark), 0, 0.101, -0.31)); // front post base
  g.add(at(vbox(0.007, 0.02, 0.007, PALETTE.steelLit), 0, 0.111, -0.31)); // front post
  g.add(at(vbox(0.028, 0.009, 0.018, PALETTE.metalDark), 0, 0.096, 0.038)); // rear base
  g.add(at(vbox(0.007, 0.018, 0.011, PALETTE.steel), -0.012, 0.106, 0.038)); // notch prong
  g.add(at(vbox(0.007, 0.018, 0.011, PALETTE.steel), 0.012, 0.106, 0.038));
  const bail = slingBail();
  bail.rotation.z = Math.PI / 2;
  g.add(at(bail, -0.03, 0.018, 0.08));
}

/** Tube shotgun — 26 prims, 6 tones: metalDark / steel / steelLit / wood / woodLit / metalDeep. */
function buildShotgunVM(g: THREE.Group): void {
  const barrel = vcyl(0.015, 0.015, 0.52, 10, PALETTE.metalDark);
  barrel.rotation.x = Math.PI / 2;
  g.add(at(barrel, 0, 0.085, -0.29));
  g.add(at(vbox(0.015, 0.007, 0.48, PALETTE.steel), 0, 0.101, -0.29)); // vent rib
  const tube = vcyl(0.013, 0.013, 0.48, 10, PALETTE.metalDark);
  tube.rotation.x = Math.PI / 2;
  g.add(at(tube, 0, 0.045, -0.27));
  const cap = vcyl(0.017, 0.017, 0.028, 8, PALETTE.steel);
  cap.rotation.x = Math.PI / 2;
  g.add(at(cap, 0, 0.045, -0.505));
  g.add(at(vbox(0.04, 0.048, 0.02, PALETTE.metalDeep), 0, 0.065, -0.48)); // barrel band
  g.add(at(vbox(0.052, 0.072, 0.16, PALETTE.metalDark), 0, 0.05, 0.03)); // receiver
  g.add(at(vbox(0.048, 0.017, 0.16, PALETTE.steel), 0, 0.09, 0.03)); // receiver top
  g.add(at(vbox(0.009, 0.028, 0.075, PALETTE.metalDeep), -0.028, 0.05, 0.02)); // ejection port
  g.add(at(vbox(0.008, 0.006, 0.08, PALETTE.steelLit), -0.029, 0.065, 0.02)); // port lip
  const pump = vbox(0.058, 0.048, 0.11, PALETTE.wood);
  pump.add(at(vbox(0.048, 0.008, 0.09, PALETTE.woodLit), 0, 0.026, 0));
  pump.add(at(vbox(0.058, 0.05, 0.013, PALETTE.metalDark), 0, 0, -0.06)); // front cap
  g.add(at(pump, 0, 0.045, -0.27));
  const stock = vbox(0.048, 0.086, 0.19, PALETTE.wood);
  stock.rotation.x = -0.1;
  stock.add(at(vbox(0.038, 0.007, 0.15, PALETTE.woodLit), 0, 0.045, 0));
  stock.add(at(vbox(0.05, 0.011, 0.028, PALETTE.metalDeep), 0, -0.041, -0.055)); // wrist groove
  g.add(at(stock, 0, 0.02, 0.19));
  g.add(at(vbox(0.053, 0.096, 0.014, PALETTE.metalDark), 0, 0.012, 0.285)); // butt plate
  g.add(at(vbox(0.055, 0.026, 0.017, PALETTE.metalDeep), 0, -0.027, 0.285)); // recoil pad
  g.add(at(vbox(0.058, 0.019, 0.095, PALETTE.metalDark), 0, 0.09, 0.03)); // shell saddle
  for (let i = 0; i < 3; i++) {
    const shell = vcyl(0.0085, 0.0085, 0.05, 6, PALETTE.woodLit);
    shell.rotation.x = Math.PI / 2;
    g.add(at(shell, -0.017 + i * 0.017, 0.106, 0.03));
  }
  g.add(at(vbox(0.038, 0.007, 0.055, PALETTE.metalDark), 0, 0.0, 0.03)); // trigger guard
  g.add(at(vbox(0.01, 0.021, 0.008, PALETTE.steel), 0, 0.011, 0.028)); // trigger
  g.add(at(vbox(0.011, 0.006, 0.015, PALETTE.metalDark), 0, 0.101, -0.535)); // bead base
  g.add(at(vbox(0.007, 0.011, 0.007, PALETTE.steelLit), 0, 0.107, -0.535)); // bead sight
  const bail = slingBail();
  bail.rotation.x = Math.PI;
  g.add(at(bail, 0, 0.028, -0.45));
}

/** Curved-mag rifle — 28 prims, 6 tones: metalDark / steel / steelLit / wood / woodLit / metalDeep. */
function buildRifleVM(g: THREE.Group): void {
  const barrel = vcyl(0.012, 0.012, 0.42, 10, PALETTE.metalDark);
  barrel.rotation.x = Math.PI / 2;
  g.add(at(barrel, 0, 0.075, -0.4));
  const gas = vcyl(0.008, 0.008, 0.18, 8, PALETTE.steel);
  gas.rotation.x = Math.PI / 2;
  g.add(at(gas, 0, 0.1, -0.34));
  g.add(at(vbox(0.03, 0.042, 0.042, PALETTE.metalDark), 0, 0.09, -0.445)); // gas block
  const handguard = vbox(0.052, 0.052, 0.26, PALETTE.wood);
  handguard.add(at(vbox(0.008, 0.03, 0.22, PALETTE.woodLit), -0.027, 0, 0));
  g.add(at(handguard, 0, BARREL_Y, -0.19));
  g.add(at(vbox(0.048, 0.048, 0.02, PALETTE.metalDark), 0, BARREL_Y, -0.315)); // cap
  g.add(at(vbox(0.052, 0.066, 0.21, PALETTE.metalDark), 0, 0.05, 0.02)); // receiver
  g.add(at(vbox(0.053, 0.022, 0.2, PALETTE.steel), 0, 0.086, 0.02)); // dust cover
  g.add(at(vbox(0.009, 0.028, 0.085, PALETTE.metalDeep), -0.028, 0.06, 0.0)); // ejection port
  g.add(at(vbox(0.008, 0.006, 0.09, PALETTE.steelLit), -0.029, 0.076, 0.0)); // port lip
  const chk = vcyl(0.007, 0.007, 0.02, 6, PALETTE.steelLit);
  chk.rotation.z = Math.PI / 2;
  g.add(at(chk, -0.043, 0.074, 0.066));
  g.add(at(vbox(0.008, 0.05, 0.02, PALETTE.steel), -0.03, 0.038, 0.048)); // selector lever
  g.add(at(vbox(0.048, 0.015, 0.068, PALETTE.steel), 0, -0.011, -0.028)); // mag-well lip
  g.add(at(vbox(0.036, 0.007, 0.055, PALETTE.metalDark), 0, -0.019, 0.02)); // trigger guard
  g.add(at(vbox(0.01, 0.022, 0.008, PALETTE.steel), 0, -0.007, 0.02)); // trigger
  const stock = vbox(0.048, 0.086, 0.2, PALETTE.wood);
  stock.rotation.x = -0.08;
  stock.add(at(vbox(0.038, 0.007, 0.16, PALETTE.woodLit), 0, 0.045, 0));
  stock.add(at(vbox(0.049, 0.09, 0.014, PALETTE.metalDark), 0, 0, 0.108));
  stock.add(at(vbox(0.051, 0.028, 0.017, PALETTE.metalDeep), 0, -0.031, 0.11));
  g.add(at(stock, 0, 0.02, 0.2));
  const grip = vbox(0.038, 0.095, 0.048, PALETTE.wood);
  grip.rotation.x = -0.2;
  grip.add(at(vbox(0.04, 0.011, 0.05, PALETTE.metalDark), 0, -0.05, 0));
  g.add(at(grip, 0, -0.033, 0.057));
  const mag = new THREE.Group();
  const magA = vbox(0.033, 0.076, 0.057, PALETTE.wood);
  magA.rotation.x = 0.15;
  mag.add(at(magA, 0, -0.028, 0));
  const magB = vbox(0.033, 0.076, 0.052, PALETTE.wood);
  magB.rotation.x = 0.55;
  mag.add(at(magB, 0, -0.095, -0.019));
  const magC = vbox(0.031, 0.072, 0.048, PALETTE.wood);
  magC.rotation.x = 0.95;
  magC.add(at(vbox(0.034, 0.011, 0.05, PALETTE.metalDark), 0, -0.036, 0));
  mag.add(at(magC, 0, -0.157, -0.052));
  g.add(looseMag(mag, 0, -0.024, -0.028));
  g.add(at(vbox(0.028, 0.028, 0.028, PALETTE.metalDark), 0, 0.098, -0.57)); // front sight base
  g.add(at(vbox(0.007, 0.028, 0.007, PALETTE.steelLit), 0, 0.118, -0.57)); // front sight post
  g.add(at(vbox(0.032, 0.017, 0.038, PALETTE.metalDark), 0, 0.094, -0.086)); // rear sight base
  g.add(at(vbox(0.007, 0.02, 0.013, PALETTE.steel), -0.014, 0.109, -0.086)); // notch prong
  g.add(at(vbox(0.007, 0.02, 0.013, PALETTE.steel), 0.014, 0.109, -0.086));
  const bail = slingBail();
  bail.rotation.x = Math.PI;
  g.add(at(bail, 0, 0.024, -0.31));
}

/** Long thin sniper — 29 prims, 6 tones: metalDark / steel / steelLit / woodDark / crate / metalDeep. */
function buildSniperVM(g: THREE.Group): void {
  const barrel = vcyl(0.01, 0.01, 0.66, 10, PALETTE.metalDark);
  barrel.rotation.x = Math.PI / 2;
  g.add(at(barrel, 0, 0.08, -0.47));
  const brake = vcyl(0.015, 0.015, 0.046, 8, PALETTE.metalDark);
  brake.rotation.x = Math.PI / 2;
  g.add(at(brake, 0, 0.08, -0.8));
  g.add(at(vbox(0.052, 0.066, 0.23, PALETTE.metalDark), 0, BARREL_Y, -0.02)); // receiver
  g.add(at(vbox(0.053, 0.019, 0.23, PALETTE.steel), 0, 0.096, -0.02)); // receiver top
  g.add(at(vbox(0.028, 0.007, 0.15, PALETTE.metalDeep), 0, 0.108, -0.02)); // mount rail
  g.add(at(vbox(0.009, 0.026, 0.065, PALETTE.metalDeep), -0.028, 0.068, -0.02)); // ejection port
  g.add(at(vbox(0.008, 0.005, 0.07, PALETTE.steelLit), -0.029, 0.082, -0.02)); // port lip
  g.add(at(vbox(0.048, 0.013, 0.066, PALETTE.steel), 0, 0.02, -0.048)); // mag-well lip
  g.add(at(vbox(0.036, 0.009, 0.052, PALETTE.metalDark), 0, 0.005, 0.03)); // trigger guard
  g.add(at(vbox(0.01, 0.019, 0.008, PALETTE.steel), 0, 0.013, 0.03)); // trigger
  const forend = vbox(0.048, 0.048, 0.19, PALETTE.woodDark);
  forend.add(at(vbox(0.038, 0.007, 0.15, PALETTE.crate), 0, 0.026, 0));
  g.add(at(forend, 0, 0.048, -0.265));
  const stock = vbox(0.048, 0.095, 0.25, PALETTE.woodDark);
  stock.rotation.x = -0.08;
  stock.add(at(vbox(0.038, 0.007, 0.19, PALETTE.crate), 0, 0.049, 0));
  stock.add(at(vbox(0.042, 0.02, 0.13, PALETTE.crate), 0, 0.059, -0.03)); // cheek riser
  stock.add(at(vbox(0.05, 0.1, 0.015, PALETTE.metalDark), 0, 0, 0.128));
  stock.add(at(vbox(0.052, 0.028, 0.019, PALETTE.metalDeep), 0, -0.036, 0.13));
  g.add(at(stock, 0, 0.02, 0.21));
  const grip = vbox(0.038, 0.085, 0.048, PALETTE.woodDark);
  grip.rotation.x = -0.2;
  grip.add(at(vbox(0.04, 0.011, 0.05, PALETTE.crate), 0, -0.045, 0));
  g.add(at(grip, 0, -0.02, 0.076));
  const scope = vcyl(0.017, 0.017, 0.15, 10, PALETTE.metalDark);
  scope.rotation.x = Math.PI / 2;
  g.add(at(scope, 0, 0.135, -0.02));
  const bell = vcyl(0.023, 0.019, 0.046, 10, PALETTE.metalDark);
  bell.rotation.x = Math.PI / 2;
  g.add(at(bell, 0, 0.135, -0.108));
  const lens = vcyl(0.02, 0.02, 0.007, 10, PALETTE.metalDeep);
  lens.rotation.x = Math.PI / 2;
  g.add(at(lens, 0, 0.135, -0.133));
  const eyepiece = vcyl(0.021, 0.019, 0.042, 10, PALETTE.metalDark);
  eyepiece.rotation.x = Math.PI / 2;
  g.add(at(eyepiece, 0, 0.135, 0.072));
  g.add(at(vcyl(0.011, 0.011, 0.02, 8, PALETTE.steel), 0, 0.158, -0.02)); // turret
  const bipodL = vcyl(0.006, 0.006, 0.085, 6, PALETTE.metalDark);
  bipodL.rotation.z = 0.3;
  g.add(at(bipodL, 0.024, 0.02, -0.52));
  const bipodR = vcyl(0.006, 0.006, 0.085, 6, PALETTE.metalDark);
  bipodR.rotation.z = -0.3;
  g.add(at(bipodR, -0.024, 0.02, -0.52));
  const bolt = vcyl(0.0075, 0.0075, 0.036, 6, PALETTE.metalDark);
  bolt.rotation.z = Math.PI / 2;
  g.add(at(bolt, -0.043, BARREL_Y, 0.045));
  g.add(at(vsphere(0.014, 6, PALETTE.steelLit), -0.058, 0.02, 0.045)); // bolt knob
  const bail = slingBail();
  bail.rotation.x = Math.PI;
  g.add(at(bail, 0, 0.02, -0.345));
  const mag = new THREE.Group();
  mag.add(vbox(0.038, 0.058, 0.076, PALETTE.metalDark));
  mag.add(at(vbox(0.044, 0.011, 0.082, PALETTE.steel), 0, -0.034, 0));
  g.add(looseMag(mag, 0, -0.01, -0.048));
}

/**
 * Self-lit weapon model for the ViewModel: origin at the grip, barrel -Z.
 * Static parts bake to one mesh per material; parts flagged userData.mag
 * stay loose direct children so the reload choreography can animate them.
 */
function makeViewWeaponModel(id: WeaponId): THREE.Group {
  const g = new THREE.Group();
  switch (id) {
    case 'knife': buildKnifeVM(g); break;
    case 'pistol': buildPistolVM(g); break;
    case 'smg': buildSmgVM(g); break;
    case 'shotgun': buildShotgunVM(g); break;
    case 'rifle': buildRifleVM(g); break;
    case 'sniper': buildSniperVM(g); break;
  }
  const mags: THREE.Object3D[] = [];
  for (const child of [...g.children]) {
    if (child.userData['mag'] === true) {
      g.remove(child);
      mags.push(child);
    }
  }
  const baked = bake(g);
  for (const m of mags) baked.add(m);
  return baked;
}

// ===========================================================================
// SECTION B — ViewModel: camera-parented hands + gun.
// ===========================================================================

const BASE_X = 0.27;
const BASE_Y = -0.25;
const BASE_Z = -0.48;
const VM_SCALE = 0.62;
const SWAP_DUR = 0.25;
const SWAP_DROP = 0.22;
const SPRING_K = 180;
const SPRING_C = 14;
const KICK_STEP = 0.03;
const KICK_MAX = 0.09;
const FLASH_TIME = 0.04;
const RELOAD_DIP = 0.12;
const RELOAD_TILT = (25 * Math.PI) / 180;
const MAG_DROP_U = 0.55;
const MAG_TUMBLE_RAD = 0.9;
const HAND_DROP_U = 0.6;
const MAG_GRAB_Y = -0.02;
// interact hold (repair / revive): both hands come up and forward, as if
// bracing a tool/teammate — distinct from the weapon's own idle/aim pose so
// the player reads "I am doing the hold action" without looking at the HUD.
const INTERACT_LOWER = 0.16; // the gun dips out of the way
const INTERACT_HAND_FWD = 0.22;
const INTERACT_HAND_UP = 0.05;

export class ViewModel {
  private readonly root = new THREE.Group();
  private readonly holder = new THREE.Group();
  private readonly fx = new THREE.Group();
  private readonly flashA: THREE.Mesh;
  private readonly flashB: THREE.Mesh;
  private readonly handR: THREE.Mesh;
  private readonly handL: THREE.Mesh;
  private readonly models = new Map<WeaponId, THREE.Group>();
  private currentModel: THREE.Group;
  private current: WeaponId = 'knife';

  private time = 0;
  private moveBlend = 0;
  private kick = 0;
  private kickVel = 0;
  private swapT = SWAP_DUR;
  private swapPending: WeaponId | null = null;
  private reloadT = -1;
  private reloadDur = 1;
  private flashT = 0;
  private flashStep = 0;
  private interactBlend = 0; // smoothed 0..1 toward the live interactProgress
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

    // self-lit gloves (see V_EMISSIVE) so hands read identically at dusk and
    // at night; ink cuff + a short charcoal forearm sleeve toward the corner.
    this.handR = vbox(0.085, 0.085, 0.11, PALETTE.concrete);
    this.handR.position.set(0.055, -0.105, 0.035);
    this.handR.rotation.x = -0.25;
    this.handR.add(at(vbox(0.09, 0.024, 0.115, PALETTE.charcoal), 0, -0.038, 0.045));
    const sleeveR = vbox(0.095, 0.09, 0.2, PALETTE.charcoal);
    sleeveR.rotation.x = 0.25;
    sleeveR.rotation.y = -0.55;
    this.handR.add(at(sleeveR, 0.045, -0.015, 0.16));
    this.handL = vbox(0.07, 0.06, 0.085, PALETTE.concrete);
    this.handL.add(at(vbox(0.075, 0.02, 0.09, PALETTE.charcoal), 0, -0.024, 0.028));
    const sleeveL = vbox(0.075, 0.07, 0.18, PALETTE.charcoal);
    sleeveL.rotation.x = 0.35;
    sleeveL.rotation.z = 0.25;
    this.handL.add(at(sleeveL, -0.04, -0.035, 0.11));
    this.holder.add(this.handR, this.handL);
    this.root.add(this.holder);

    this.flashA = box(0.2, 0.2, 0.004, PALETTE.muzzle, { emissive: PALETTE.muzzle });
    this.flashB = box(0.2, 0.2, 0.004, PALETTE.muzzle, { emissive: PALETTE.muzzle });
    this.fx.add(this.flashA, this.flashB);
    this.fx.visible = false;
    this.root.add(this.fx);

    this.currentModel = this.modelFor(this.current);
    this.holder.add(this.currentModel);
    this.applyLayout(this.current);

    camera.add(this.root);
  }

  setWeapon(id: WeaponId): void {
    if (id === this.current) {
      if (this.swapPending === null) return;
      this.swapPending = null;
      if (this.swapT < SWAP_DUR * 0.5) this.swapT = SWAP_DUR - this.swapT;
      return;
    }
    if (id === this.swapPending) return;
    this.swapPending = id;
    if (this.swapT >= SWAP_DUR) this.swapT = 0;
    else if (this.swapT > SWAP_DUR * 0.5) this.swapT = SWAP_DUR - this.swapT;
    this.reloadT = -1;
  }

  /**
   * Walk bob / idle breathing sway, hidden while scoped, plus the interact
   * hold pose: `interactProgress` in (0,1] (repairing/reviving) lowers the
   * weapon and brings both hands up and forward, distinct from firing or
   * reloading so the player reads the hold at a glance without the HUD.
   */
  update(dt: number, moving: boolean, scoped: boolean, interactProgress: number): void {
    this.time += dt;
    const sdt = Math.min(dt, 0.05);

    this.moveBlend += ((moving ? 1 : 0) - this.moveBlend) * Math.min(1, dt * 10);
    const b = this.moveBlend;
    const idle = 1 - b;
    const bobX = Math.cos(this.time * 4.5) * 0.008 * b + Math.cos(this.time * 0.8) * 0.003 * idle;
    const bobY =
      Math.sin(this.time * 9) * 0.012 * b +
      Math.sin(this.time * 1.6) * 0.004 * idle +
      Math.sin(this.time * 3.1) * 0.0012 * idle;
    const swayRoll = Math.sin(this.time * 1.6 + 0.7) * 0.006 * idle;
    const swayPitch = Math.sin(this.time * 0.8 + 1.9) * 0.004 * idle;

    this.kickVel += (-SPRING_K * this.kick - SPRING_C * this.kickVel) * sdt;
    this.kick += this.kickVel * sdt;
    if (Math.abs(this.kick) < 1e-5 && Math.abs(this.kickVel) < 1e-5) {
      this.kick = 0;
      this.kickVel = 0;
    }

    let swapDown = 0;
    if (this.swapT < SWAP_DUR) {
      this.swapT += dt;
      if (this.swapPending !== null && this.swapT >= SWAP_DUR * 0.5) this.doSwap();
      swapDown = SWAP_DROP * Math.sin(Math.PI * Math.min(this.swapT / SWAP_DUR, 1));
    }

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
        this.resetMagHand();
      } else {
        const c = p < 0.2 ? smooth(p / 0.2) : p > 0.8 ? 1 - smooth((p - 0.8) / 0.2) : 1;
        dip = RELOAD_DIP * c;
        tilt = RELOAD_TILT * c;
        handGrab = window01(p, 0.02, 0.15, 0.85, 0.98);
        magDrop = window01(p, 0.22, 0.38, 0.62, 0.78);
        handDrop = window01(p, 0.34, 0.5, 0.58, 0.76);
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

    // interact hold: smoothed so a flicker in interactProgress (grace window
    // on a released-then-repressed E) doesn't snap the pose.
    const wantInteract = interactProgress > 0 ? 1 : 0;
    this.interactBlend += (wantInteract - this.interactBlend) * Math.min(1, dt * 9);
    const ix = this.interactBlend;
    const workPulse = Math.sin(this.time * 5.5) * 0.015 * ix; // hands "working" jiggle

    if (handGrab > 0 || handDrop > 0) {
      if (this.handL.visible) {
        this.handL.position.set(
          this.handRestX + (this.magRestX - this.handRestX) * handGrab,
          this.handRestY + (this.magRestY + MAG_GRAB_Y - this.handRestY) * handGrab - handDrop * HAND_DROP_U,
          this.handRestZ + (this.magRestZ - this.handRestZ) * handGrab,
        );
      }
    } else if (ix > 0.001) {
      // both hands rise and reach forward together for the hold animation
      this.handR.position.set(0.055 - ix * 0.04, -0.105 + ix * INTERACT_HAND_UP, 0.035 - ix * INTERACT_HAND_FWD);
      if (this.handL.visible) {
        this.handL.position.set(
          this.handRestX + ix * 0.04,
          this.handRestY + ix * (INTERACT_HAND_UP + workPulse),
          this.handRestZ - ix * INTERACT_HAND_FWD,
        );
      }
    } else {
      this.handR.position.set(0.055, -0.105, 0.035);
      if (this.handL.visible) this.handL.position.set(this.handRestX, this.handRestY, this.handRestZ);
    }
    this.holder.position.set(0, -ix * INTERACT_LOWER, 0);

    this.root.position.set(BASE_X + bobX, BASE_Y + bobY - swapDown - dip, BASE_Z + this.kick);
    this.root.rotation.set(-this.kick + swayPitch, 0, -tilt + swayRoll);
    this.root.visible = !scoped;

    if (this.flashT > 0) {
      this.flashT -= dt;
      if (this.flashT <= 0) this.fx.visible = false;
    }
  }

  fire(): void {
    this.kick = Math.min(this.kick + KICK_STEP, KICK_MAX);
    if (this.current === 'knife') return;
    this.flashT = FLASH_TIME;
    this.fx.visible = true;
    this.flashStep = (this.flashStep + 1) % 4;
    const roll = (this.flashStep * Math.PI) / 4;
    this.flashA.rotation.z = roll;
    this.flashB.rotation.z = roll + Math.PI / 2;
  }

  reload(durSec: number): void {
    this.reloadT = 0;
    this.reloadDur = Math.max(durSec, 0.01);
  }

  dispose(): void {
    this.root.parent?.remove(this.root);
    for (const model of this.models.values()) {
      model.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    }
    this.models.clear();
    this.flashA.geometry.dispose();
    this.flashB.geometry.dispose();
    this.handR.geometry.dispose();
    this.handL.geometry.dispose();
  }

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
      m = makeViewWeaponModel(id);
      this.models.set(id, m);
    }
    return m;
  }

  private doSwap(): void {
    const id = this.swapPending;
    if (id === null) return;
    this.swapPending = null;
    this.resetMagHand();
    this.holder.remove(this.currentModel);
    this.current = id;
    this.currentModel = this.modelFor(id);
    this.holder.add(this.currentModel);
    this.flashT = 0;
    this.fx.visible = false;
    this.applyLayout(id);
  }

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

// ===========================================================================
// SECTION C — third-person survivors.
// ===========================================================================

// geometry layout (units; total standing height ~1.82u, eye ~1.62 per map.ts)
const HIP_Y = 0.86;
const THIGH_H = 0.44;
const SHIN_H = 0.42;
const SHOULDER_Y = 1.43;
const SHOULDER_X = 0.22;
const UPPER_ARM_H = 0.28;
const FOREARM_H = 0.26;
const HEAD_Y = 1.58;
const CAP_Y = 1.68;
const NAMEPLATE_Y = 2.05;
const CONTACT_R = 0.34;
const CONTACT_STRETCH = 1.3;

// animation tuning
const WALK_SWING_RAD = (20 * Math.PI) / 180;
const KNEE_SWING = 0.5;
const ARM_SWING = 0.28;
const PHASE_RATE = 7.2; // rad/s of gait phase while mv === true
const SWING_BLEND_RATE = 8;
const PITCH_CLAMP = 0.55;
const HEAD_PITCH_FOLLOW = 0.5;
const BREATHE_HZ = 1.7;
const BREATHE_AMP = 0.016;
const CROUCH_THIGH_RAD = 1.2;
const CROUCH_KNEE_RAD = -1.05;
const CROUCH_DROP = 0.3;
const CROUCH_BLEND_RATE = 6;
// downed: the whole rig hinges forward from the feet (see file header for the
// pivot-at-feet reasoning) so it reads as collapsed rather than standing.
const DOWNED_TILT = 1.45; // rad, ~83 deg forward pitch of the body group
const DOWNED_BLEND_RATE = 5;
// revive (the REVIVER's pose, derived — see deriveRevivers()): kneel forward,
// both arms reach down toward the teammate, a small working-phase jiggle.
const REVIVE_LEAN = 0.5;
const REVIVE_THIGH = 0.95;
const REVIVE_KNEE = -1.0;
const MUZZLE_FLASH_S = 0.05;
const LAMP_FLICKER_HZ = 9;

interface SurvivorRig {
  root: THREE.Group; // feet anchor: position + yaw
  body: THREE.Group; // downed-tilt lives here; children are all HIP_Y-relative
  torsoGroup: THREE.Group;
  headGroup: THREE.Group;
  thighL: THREE.Group;
  thighR: THREE.Group;
  shinL: THREE.Group;
  shinR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  aim: THREE.Group;
  weaponHolder: THREE.Group;
  weaponMesh: THREE.Group; // current held-weapon mesh, child of weaponHolder — swapped when s.w changes
  weaponId: WeaponId; // last-baked weapon id backing weaponMesh; compared each update() to detect a switch
  muzzleGroup: THREE.Group;
  lampBulb: THREE.Mesh;
  beacon: THREE.Mesh;
  nameplate: THREE.Sprite;
  name: string;
  // scalar animation state — zero per-frame allocation
  walkPhase: number;
  swingAmp: number;
  crouchAmt: number;
  downedAmt: number;
  age: number;
  flashT: number;
  seen: number;
}

function hexRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function tintCss(inkHex: string, accentHex: string): string {
  const [ir, ig, ib] = hexRgb(inkHex);
  const [ar, ag, ab] = hexRgb(accentHex);
  const m = (a: number, c: number): number => Math.round(a * 0.5 + c * 0.5);
  return `rgb(${m(ir, ar)},${m(ig, ag)},${m(ib, ab)})`;
}

function drawNameplate(canvas: HTMLCanvasElement, name: string): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = 0.72;
  ctx.fillStyle = tintCss(PALETTE.ink, PALETTE.hudAccent);
  ctx.fillRect(0, 8, canvas.width, 48);
  ctx.globalAlpha = 1;
  ctx.fillStyle = PALETTE.hudAccent;
  ctx.fillRect(0, 50, canvas.width, 6);
  ctx.fillStyle = PALETTE.hudText;
  ctx.font = 'bold 30px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name.trim().slice(0, 14) || '?', canvas.width / 2, 33);
}

function makeNameplate(name: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  drawNameplate(canvas, name);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(1.35, 0.34, 1);
  return sprite;
}

function disposeNameplate(sprite: THREE.Sprite): void {
  const material = sprite.material;
  if (material.map) material.map.dispose();
  material.dispose();
}

/**
 * Compact silhouette-only weapon for a teammate's hand — see the header for
 * why this is not the detailed ViewModel sheet. 6-9 prims, world-lit (no
 * emissive floor — third-person geometry shades with the scene like anything
 * else the character carries).
 */
function buildHeldWeapon(id: WeaponId): THREE.Group {
  const g = new THREE.Group();
  switch (id) {
    case 'knife':
      g.add(at(box(0.02, 0.05, 0.22, PALETTE.steel), 0, 0, -0.13));
      g.add(at(box(0.03, 0.045, 0.1, PALETTE.woodDark), 0, 0, 0.02));
      break;
    case 'pistol':
      g.add(at(box(0.045, 0.05, 0.16, PALETTE.metalDark), 0, 0.02, -0.05));
      g.add(at(box(0.038, 0.09, 0.045, PALETTE.charcoal), 0, -0.04, 0.02));
      g.add(at(box(0.03, 0.006, 0.14, PALETTE.steelLit), 0, 0.048, -0.05));
      break;
    case 'smg':
      g.add(at(box(0.05, 0.055, 0.32, PALETTE.metalDark), 0, 0.02, -0.14));
      g.add(at(box(0.036, 0.08, 0.045, PALETTE.charcoal), 0, -0.05, 0.05));
      g.add(at(box(0.03, 0.007, 0.28, PALETTE.steel), 0, 0.05, -0.14));
      break;
    case 'shotgun':
      g.add(at(cyl(0.016, 0.016, 0.5, 8, PALETTE.metalDark), 0, 0.02, -0.28).rotateX(Math.PI / 2));
      g.add(at(box(0.05, 0.06, 0.18, PALETTE.wood), 0, 0, 0.08));
      g.add(at(box(0.052, 0.05, 0.11, PALETTE.wood), 0, 0.01, -0.12)); // pump
      break;
    case 'rifle':
      g.add(at(cyl(0.013, 0.013, 0.45, 8, PALETTE.metalDark), 0, 0.02, -0.3).rotateX(Math.PI / 2));
      g.add(at(box(0.05, 0.06, 0.22, PALETTE.metalDark), 0, 0.01, -0.03));
      g.add(at(box(0.045, 0.06, 0.18, PALETTE.wood), 0, -0.01, 0.16)); // stock
      g.add(at(box(0.05, 0.05, 0.24, PALETTE.wood), 0, 0.0, -0.2)); // handguard
      break;
    case 'sniper':
      g.add(at(cyl(0.011, 0.011, 0.7, 8, PALETTE.metalDark), 0, 0.02, -0.4).rotateX(Math.PI / 2));
      g.add(at(box(0.048, 0.06, 0.26, PALETTE.metalDark), 0, 0.01, -0.02));
      g.add(at(box(0.044, 0.06, 0.22, PALETTE.woodDark), 0, -0.01, 0.19)); // stock
      g.add(at(cyl(0.017, 0.017, 0.16, 8, PALETTE.metalDark), 0, 0.09, -0.02).rotateX(Math.PI / 2)); // scope
      break;
  }
  return bake(g);
}

/**
 * SurvivorModels — one rig per seated teammate (never the local player, whose
 * own body sits behind the camera). Pivot-anchored limbs; walk/idle/aim/
 * crouch/downed/revive are all pure functions of scalar phase state, applied
 * fresh every `sync()` — nothing here allocates per frame.
 */
export class SurvivorModels {
  private readonly scene: THREE.Scene;
  private readonly rigs = new Map<PlayerId, SurvivorRig>();
  private frame = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  sync(ss: readonly SurvivorSnap[], localId: PlayerId | null, dt: number): void {
    this.frame++;
    for (const s of ss) {
      if (s.id === localId) continue; // the local player never sees their own body
      if (s.st === 'dead') {
        const stale = this.rigs.get(s.id);
        if (stale) this.remove(s.id, stale);
        continue;
      }
      let rig = this.rigs.get(s.id);
      if (!rig || rig.name !== s.n) {
        if (rig) this.remove(s.id, rig);
        rig = this.create(s);
        this.rigs.set(s.id, rig);
      }
      rig.seen = this.frame;
      this.update(rig, s, ss, dt);
    }
    for (const [id, rig] of this.rigs) {
      if (rig.seen !== this.frame) this.remove(id, rig);
    }
  }

  /** Flash a player's held-weapon muzzle for one frame window (~50ms). */
  muzzle(id: PlayerId): void {
    const rig = this.rigs.get(id);
    if (!rig) return;
    rig.flashT = MUZZLE_FLASH_S;
    rig.muzzleGroup.visible = true;
  }

  clear(): void {
    for (const [id, rig] of [...this.rigs]) this.remove(id, rig);
  }

  dispose(): void {
    this.clear();
  }

  private remove(id: PlayerId, rig: SurvivorRig): void {
    this.scene.remove(rig.root);
    disposeNameplate(rig.nameplate);
    rig.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.rigs.delete(id);
  }

  private create(s: SurvivorSnap): SurvivorRig {
    const seed = hashSeed(s.id);
    const rand = vrng(seed);
    const capVariant = rand() < 0.5;

    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);

    const blob = contactShadow(CONTACT_R);
    blob.scale.y = CONTACT_STRETCH;
    root.add(blob);

    // ---- torso: charcoal coat over metalDark webbing, ink creases ----------
    const torsoRaw = new THREE.Group();
    torsoRaw.add(at(box(0.4, 0.24, 0.24, PALETTE.charcoal), 0, 0.12, 0)); // waist/coat skirt
    torsoRaw.add(at(box(0.42, 0.06, 0.26, PALETTE.ink), 0, 0.26, 0)); // coat hem shadow
    torsoRaw.add(at(box(0.5, 0.32, 0.27, PALETTE.charcoal), 0, 0.46, 0)); // coat chest
    torsoRaw.add(at(box(0.4, 0.28, 0.09, PALETTE.metalDark), 0, 0.46, -0.15)); // webbing vest
    torsoRaw.add(at(box(0.1, 0.12, 0.07, PALETTE.metalDark), -0.13, 0.4, -0.21)); // pouch L
    torsoRaw.add(at(box(0.1, 0.12, 0.07, PALETTE.metalDark), 0.13, 0.4, -0.21)); // pouch R
    torsoRaw.add(at(box(0.11, 0.03, 0.08, PALETTE.metalDeep), -0.13, 0.46, -0.215)); // flap L
    torsoRaw.add(at(box(0.11, 0.03, 0.08, PALETTE.metalDeep), 0.13, 0.46, -0.215)); // flap R
    torsoRaw.add(at(box(0.43, 0.06, 0.28, PALETTE.metalDeep), 0, 0.27, 0)); // belt
    torsoRaw.add(at(box(0.08, 0.05, 0.03, PALETTE.steelLit), 0, 0.27, -0.145)); // buckle
    torsoRaw.add(at(box(0.34, 0.3, 0.11, PALETTE.metalDark), 0, 0.42, 0.19)); // pack
    torsoRaw.add(at(box(0.35, 0.06, 0.125, PALETTE.metalDeep), 0, 0.58, 0.19)); // pack lid
    torsoRaw.add(at(box(0.19, 0.09, 0.25, PALETTE.charcoal), -SHOULDER_X, 0.6, 0)); // shoulder pad L
    torsoRaw.add(at(box(0.19, 0.09, 0.25, PALETTE.charcoal), SHOULDER_X, 0.6, 0)); // shoulder pad R
    torsoRaw.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    const torsoGroup = at(bake(torsoRaw), 0, HIP_Y, 0);

    // shoulder lamp — the housing bakes into the torso's metalDark tier;
    // the bulb is a SEPARATE unbaked emissive mesh so its flicker (a lit
    // fixture, not a static prop) survives bake()'s userData.animate skip.
    const lampHousing = at(box(0.09, 0.07, 0.11, PALETTE.metalDark), SHOULDER_X + 0.02, 0.72, -0.08);
    lampHousing.castShadow = true;
    torsoGroup.add(lampHousing);
    const lampBulb = box(0.045, 0.045, 0.02, PALETTE.torchCore, { emissive: PALETTE.torchCore });
    lampBulb.userData['animate'] = true;
    at(lampBulb, SHOULDER_X + 0.02, 0.72, -0.135);
    torsoGroup.add(lampBulb);

    // hudAccent armband, upper-left arm — teammate identification at range
    const armband = box(0.135, 0.045, 0.145, PALETTE.hudAccent);
    armband.castShadow = true;

    // ---- head: skin + helmet/knit-cap variant ------------------------------
    const headRaw = new THREE.Group();
    headRaw.add(at(box(0.25, 0.25, 0.25, PALETTE.skin), 0, 0, 0));
    if (capVariant) {
      headRaw.add(at(box(0.27, 0.14, 0.27, PALETTE.carpet), 0, CAP_Y - HEAD_Y, 0)); // knit cap
      headRaw.add(at(box(0.28, 0.045, 0.28, PALETTE.metalDeep), 0, CAP_Y - HEAD_Y - 0.06, 0)); // cuffed brim
    } else {
      headRaw.add(at(box(0.285, 0.145, 0.285, PALETTE.steel), 0, CAP_Y - HEAD_Y, 0)); // steel helmet
      headRaw.add(at(box(0.3, 0.04, 0.3, PALETTE.metalDark), 0, CAP_Y - HEAD_Y + 0.05, 0)); // band
      headRaw.add(at(box(0.3, 0.045, 0.1, PALETTE.steelLit), 0, CAP_Y - HEAD_Y + 0.06, -0.17)); // brim
    }
    headRaw.add(at(box(0.26, 0.05, 0.03, PALETTE.ink), 0, 0.02, -0.135)); // visor/eyeline
    headRaw.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    const headGroup = at(bake(headRaw), 0, HEAD_Y, 0);

    // ---- legs: dark thigh, mid-value shin, metalDark boot ------------------
    const thighL = at(new THREE.Group(), -0.11, HIP_Y, 0);
    const thighR = at(new THREE.Group(), 0.11, HIP_Y, 0);
    const thighLRaw = new THREE.Group();
    thighLRaw.add(at(box(0.16, THIGH_H, 0.18, PALETTE.charcoal), 0, -THIGH_H / 2, 0));
    thighLRaw.add(at(box(0.168, 0.05, 0.188, PALETTE.ink), 0, -THIGH_H + 0.025, 0));
    thighLRaw.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    const thighLBaked = bake(thighLRaw);
    const thighRRaw = new THREE.Group();
    thighRRaw.add(at(box(0.16, THIGH_H, 0.18, PALETTE.charcoal), 0, -THIGH_H / 2, 0));
    thighRRaw.add(at(box(0.168, 0.05, 0.188, PALETTE.ink), 0, -THIGH_H + 0.025, 0));
    thighRRaw.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    const thighRBaked = bake(thighRRaw);

    const shinL = at(new THREE.Group(), 0, -THIGH_H, 0);
    const shinR = at(new THREE.Group(), 0, -THIGH_H, 0);
    const shinLRaw = new THREE.Group();
    shinLRaw.add(at(box(0.13, SHIN_H, 0.15, PALETTE.metalDark), 0, -SHIN_H / 2, 0));
    shinLRaw.add(at(box(0.15, 0.11, 0.24, PALETTE.metalDark), 0, -SHIN_H + 0.055, -0.03)); // boot
    shinLRaw.add(at(box(0.16, 0.045, 0.27, PALETTE.metalDeep), 0, -SHIN_H, -0.035)); // sole
    shinLRaw.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    const shinLBaked = bake(shinLRaw);
    const shinRRaw = new THREE.Group();
    shinRRaw.add(at(box(0.13, SHIN_H, 0.15, PALETTE.metalDark), 0, -SHIN_H / 2, 0));
    shinRRaw.add(at(box(0.15, 0.11, 0.24, PALETTE.metalDark), 0, -SHIN_H + 0.055, -0.03));
    shinRRaw.add(at(box(0.16, 0.045, 0.27, PALETTE.metalDeep), 0, -SHIN_H, -0.035));
    shinRRaw.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    const shinRBaked = bake(shinRRaw);
    shinL.add(shinLBaked);
    shinR.add(shinRBaked);
    thighL.add(thighLBaked, shinL);
    thighR.add(thighRBaked, shinR);
    body.add(thighL, thighR);

    // ---- arms: two-segment, visible skin hands -----------------------------
    const aim = at(new THREE.Group(), 0, SHOULDER_Y, 0);
    const armL = at(new THREE.Group(), -SHOULDER_X, 0, 0);
    const armR = at(new THREE.Group(), SHOULDER_X, 0, 0);

    const upperLRaw = new THREE.Group();
    upperLRaw.add(at(box(0.1, UPPER_ARM_H, 0.12, PALETTE.charcoal), 0, -UPPER_ARM_H / 2, 0));
    upperLRaw.add(armband); // armband lives on the LEFT upper arm (camera reads it approaching)
    upperLRaw.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    const upperL = bake(upperLRaw);
    const upperRRaw = new THREE.Group();
    upperRRaw.add(at(box(0.1, UPPER_ARM_H, 0.12, PALETTE.charcoal), 0, -UPPER_ARM_H / 2, 0));
    upperRRaw.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    const upperR = bake(upperRRaw);

    const elbowL = at(new THREE.Group(), 0, -UPPER_ARM_H, 0);
    const elbowR = at(new THREE.Group(), 0, -UPPER_ARM_H, 0);
    const foreLRaw = new THREE.Group();
    foreLRaw.add(at(box(0.09, FOREARM_H, 0.1, PALETTE.metalDark), 0, -FOREARM_H / 2, 0));
    foreLRaw.add(at(box(0.09, 0.08, 0.1, PALETTE.skin), 0, -FOREARM_H - 0.02, 0)); // visible hand
    foreLRaw.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    const foreL = bake(foreLRaw);
    const foreRRaw = new THREE.Group();
    foreRRaw.add(at(box(0.09, FOREARM_H, 0.1, PALETTE.metalDark), 0, -FOREARM_H / 2, 0));
    foreRRaw.add(at(box(0.09, 0.08, 0.1, PALETTE.skin), 0, -FOREARM_H - 0.02, 0));
    foreRRaw.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    const foreR = bake(foreRRaw);
    elbowL.add(foreL);
    elbowR.add(foreR);
    armL.add(upperL, elbowL);
    armR.add(upperR, elbowR);
    armL.rotation.x = 1.1;
    armL.rotation.z = 0.28;
    elbowL.rotation.x = 0.5;
    armR.rotation.x = 1.1;
    armR.rotation.z = -0.08;
    elbowR.rotation.x = 0.5;
    aim.add(armL, armR);
    body.add(torsoGroup, headGroup, aim);

    // held weapon + muzzle flash, mounted at the right hand
    const weaponHolder = at(new THREE.Group(), 0, -FOREARM_H + 0.03, 0);
    weaponHolder.rotation.x = -(1.1 + 0.5);
    const weaponMesh = buildHeldWeapon(s.w);
    weaponMesh.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    weaponHolder.add(weaponMesh);
    elbowR.add(weaponHolder);
    const muzzleGroup = at(new THREE.Group(), 0, 0.02, -0.42);
    const flashOpts = { emissive: PALETTE.muzzle };
    muzzleGroup.add(box(0.018, 0.22, 0.24, PALETTE.muzzle, flashOpts));
    muzzleGroup.add(box(0.22, 0.018, 0.24, PALETTE.muzzle, flashOpts));
    muzzleGroup.visible = false;
    weaponHolder.add(muzzleGroup);

    // downed beacon: renders THROUGH geometry (depthTest off, high
    // renderOrder), a sibling of `body` so the body's prone tilt never
    // rotates it. MeshBasicMaterial is the frozen "emissive quad" exception.
    const beaconMat = new THREE.MeshBasicMaterial({
      color: PALETTE.reviveCyan,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    });
    const beacon = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), beaconMat);
    beacon.renderOrder = 999;
    beacon.visible = false;
    beacon.position.set(0, 2.15, 0);
    root.add(beacon);

    const nameplate = at(makeNameplate(s.n), 0, NAMEPLATE_Y, 0);
    body.add(nameplate);

    root.position.set(s.x, s.y, s.z);
    root.rotation.y = s.yaw;
    this.scene.add(root);

    return {
      root, body, torsoGroup, headGroup,
      thighL, thighR, shinL, shinR, armL, armR, aim,
      weaponHolder, weaponMesh, weaponId: s.w, muzzleGroup, lampBulb, beacon, nameplate,
      name: s.n,
      walkPhase: rand() * Math.PI * 2,
      swingAmp: 0,
      crouchAmt: 0,
      downedAmt: 0,
      age: rand() * 10,
      flashT: 0,
      seen: this.frame,
    };
  }

  /** Swap the held-weapon mesh in place when a teammate buys/switches weapons. */
  private rebuildWeapon(rig: SurvivorRig, w: WeaponId): void {
    rig.weaponHolder.remove(rig.weaponMesh);
    rig.weaponMesh.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    const weaponMesh = buildHeldWeapon(w);
    weaponMesh.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    rig.weaponHolder.add(weaponMesh);
    rig.weaponMesh = weaponMesh;
    rig.weaponId = w;
  }

  /** True iff `reviverId` is the one currently reviving some downed teammate. */
  private isReviving(reviverId: PlayerId, ss: readonly SurvivorSnap[]): boolean {
    for (const other of ss) {
      if (other.st === 'downed' && other.rev > 0 && other.revBy === reviverId) return true;
    }
    return false;
  }

  private update(rig: SurvivorRig, s: SurvivorSnap, ss: readonly SurvivorSnap[], dt: number): void {
    if (s.w !== rig.weaponId) this.rebuildWeapon(rig, s.w);
    rig.age += dt;
    rig.root.position.set(s.x, s.y, s.z);
    rig.root.rotation.y = s.yaw;
    rig.nameplate.visible = s.st === 'alive';

    if (rig.flashT > 0) {
      rig.flashT -= dt;
      if (rig.flashT <= 0) rig.muzzleGroup.visible = false;
    }
    // shoulder-lamp flicker: never fully off — this is a practical light, not
    // an emissive status indicator, so it reads "lit" continuously (STYLE_BIBLE
    // §"one swatch, one job" — torchCore's job here is always "the lamp is on").
    const flicker = 0.82 + 0.18 * (0.5 + 0.5 * Math.sin(rig.age * LAMP_FLICKER_HZ) * Math.sin(rig.age * 2.3));
    rig.lampBulb.scale.setScalar(0.85 + 0.15 * flicker);

    const downedTarget = s.st === 'downed' ? 1 : 0;
    rig.downedAmt += (downedTarget - rig.downedAmt) * Math.min(1, dt * DOWNED_BLEND_RATE);

    if (s.st === 'downed') {
      this.applyDowned(rig);
      rig.beacon.visible = true;
      const pulse = 0.75 + 0.25 * Math.sin(rig.age * 3.4);
      rig.beacon.scale.setScalar(pulse);
      (rig.beacon.material as THREE.MeshBasicMaterial).opacity = s.rev > 0 ? 1 : 0.7 + 0.15 * pulse;
      return;
    }
    rig.beacon.visible = false;

    if (this.isReviving(s.id, ss)) {
      this.applyRevive(rig);
      return;
    }

    const crouchTarget = s.cr ? 1 : 0;
    rig.crouchAmt += (crouchTarget - rig.crouchAmt) * Math.min(1, dt * CROUCH_BLEND_RATE);

    const movingTarget = s.mv ? 1 : 0;
    rig.swingAmp += (movingTarget - rig.swingAmp) * Math.min(1, dt * SWING_BLEND_RATE);
    if (s.mv) rig.walkPhase += dt * PHASE_RATE;

    this.applyStand(rig, s);
  }

  /** Walk (mv) blended with idle breathing sway, crouch offset, pitch tracking. */
  private applyStand(rig: SurvivorRig, s: SurvivorSnap): void {
    const swing = rig.swingAmp;
    const idle = 1 - swing;
    const phase = rig.walkPhase;
    const legSwing = Math.sin(phase) * WALK_SWING_RAD * swing;
    const legSwingOpp = Math.sin(phase + Math.PI) * WALK_SWING_RAD * swing;
    const kneeBend = Math.max(0, -Math.sin(phase)) * WALK_SWING_RAD * KNEE_SWING * swing;
    const kneeBendOpp = Math.max(0, -Math.sin(phase + Math.PI)) * WALK_SWING_RAD * KNEE_SWING * swing;
    const breathe = Math.sin(rig.age * BREATHE_HZ * Math.PI * 2) * BREATHE_AMP * (0.4 + idle * 0.6);

    const c = rig.crouchAmt;
    rig.body.position.y = -CROUCH_DROP * c;
    rig.thighL.rotation.x = legSwing + CROUCH_THIGH_RAD * c;
    rig.thighR.rotation.x = legSwingOpp + CROUCH_THIGH_RAD * c;
    rig.shinL.rotation.x = -kneeBend + CROUCH_KNEE_RAD * c;
    rig.shinR.rotation.x = -kneeBendOpp + CROUCH_KNEE_RAD * c;

    const armSwing = Math.sin(phase + Math.PI) * WALK_SWING_RAD * ARM_SWING * swing;
    const armSwingOpp = Math.sin(phase) * WALK_SWING_RAD * ARM_SWING * swing;
    const pitch = Math.max(-PITCH_CLAMP, Math.min(PITCH_CLAMP, s.pitch));
    rig.aim.rotation.x = pitch;
    rig.headGroup.rotation.x = pitch * HEAD_PITCH_FOLLOW;
    rig.armL.rotation.x = 1.1 + armSwing;
    rig.armR.rotation.x = 1.1 + armSwingOpp;
    rig.torsoGroup.scale.y = 1 + breathe;
  }

  /**
   * Prone, one arm raised. `body` hinges forward about the feet (see the
   * file header): with the hinge angle DOWNED_TILT, an arm's WORLD-relative
   * angle is `DOWNED_TILT + local.rotation.x`, so we solve `local.rotation.x
   * = target - DOWNED_TILT` for each limb's intended world pose — support
   * arm laid forward along the ground (target ~= PI/2), signal arm raised
   * past vertical so it reads as a wave (target ~= PI).
   */
  private applyDowned(rig: SurvivorRig): void {
    const t = rig.downedAmt;
    rig.body.rotation.x = DOWNED_TILT * t;
    rig.body.position.y = -0.06 * t;
    rig.thighL.rotation.x = 0.1 * t;
    rig.thighR.rotation.x = 0.16 * t;
    rig.shinL.rotation.x = 0.14 * t;
    rig.shinR.rotation.x = 0.2 * t;
    rig.aim.rotation.x = 0;
    rig.headGroup.rotation.x = -0.3 * t; // chin lifts, reads as still conscious
    const supportTarget = Math.PI / 2 - DOWNED_TILT;
    const raiseTarget = Math.PI - DOWNED_TILT;
    rig.armL.rotation.x = 1.1 + (supportTarget - 1.1) * t;
    rig.armR.rotation.x = 1.1 + (raiseTarget - 1.1) * t + Math.sin(rig.age * 2.1) * 0.08 * t; // a weak wave
    rig.torsoGroup.scale.y = 1;
  }

  /** Kneeling over a downed teammate: lean forward, both hands reach down. */
  private applyRevive(rig: SurvivorRig): void {
    rig.body.rotation.x = 0;
    rig.body.position.y = -CROUCH_DROP * 0.7;
    rig.thighL.rotation.x = REVIVE_THIGH;
    rig.thighR.rotation.x = REVIVE_THIGH;
    rig.shinL.rotation.x = REVIVE_KNEE;
    rig.shinR.rotation.x = REVIVE_KNEE;
    const jiggle = Math.sin(rig.age * 6) * 0.05;
    rig.aim.rotation.x = REVIVE_LEAN + jiggle;
    rig.headGroup.rotation.x = REVIVE_LEAN * 0.6;
    rig.armL.rotation.x = 1.7 + jiggle * 0.5;
    rig.armR.rotation.x = 1.7 + jiggle * 0.5;
    rig.torsoGroup.scale.y = 1;
  }
}

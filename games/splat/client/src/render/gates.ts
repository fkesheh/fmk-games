// ============================================================================
// SKI SPLAT — GATES + LODGE (task R1, CONTRACT §7). The start gate at z=0,
// the FINISH GATE at slope.finishZ (sunGold pennants — THE goal read: at race
// speed the gold string fading in through the morning haze is what every
// skier steers toward), and the lodge with chimney smoke beyond the line.
// STYLE_BIBLE model sheets: two banner poles + a pennant string per gate;
// bark/lodge palette on the lodge, warm sunGold windows, cartoon smoke puffs
// rising off the chimney. Everything static is collapsed by bake() into one
// mesh per SPAL colour.
// ============================================================================
import * as THREE from 'three';
import { SPAL } from '@splat/shared';
import type { SlopeDef } from '@splat/shared';
import { at, bake, box, cone, cyl, mat, sphere } from '../contract/visual.js';

// ---- start gate -----------------------------------------------------------------
const START_POLE_X = 7; // poles clear of the 4-wide start grid (±4.5 m)
const START_POLE_H = 3.2;

// ---- finish gate ------------------------------------------------------------------
const FINISH_POLE_X = 9; // wider, taller — the sprint corridor landmark
const FINISH_POLE_H = 4.2;

// ---- lodge ---------------------------------------------------------------------------
const LODGE_X = 14; // beside the runout, NOT blocking it
const LODGE_Z_PAD = 26; // this far beyond the finish line

/**
 * A pennant string between two poles: a thin bark line plus a row of small
 * 4-seg cones hanging point-down, colours alternating through `colors`.
 * Deterministic — spacing and count derive from the span only.
 */
function pennantString(
  g: THREE.Group,
  x0: number,
  x1: number,
  yString: number,
  z: number,
  pennantR: number,
  pennantH: number,
  colors: readonly string[],
): void {
  const span = x1 - x0;
  const line = cyl(mat, 0.02, 0.02, span, 4, SPAL.bark);
  line.rotation.z = Math.PI / 2; // cylinder axis y -> span along x
  g.add(at(line, (x0 + x1) / 2, yString, z));
  const count = Math.max(2, Math.floor(span / 0.55));
  for (let i = 0; i < count; i++) {
    const x = x0 + (span * (i + 0.5)) / count;
    const hex = colors[i % colors.length] ?? SPAL.sunGold;
    const p = cone(mat, pennantR, pennantH, 4, hex);
    p.rotation.x = Math.PI; // hang point-down from the string
    g.add(at(p, x, yString - pennantH / 2 - 0.02, z));
  }
}

/** Two banner poles with topper orbs; returns the pole-top y for the string. */
function bannerPoles(
  g: THREE.Group,
  slope: SlopeDef,
  z: number,
  halfSpan: number,
  height: number,
  topperHex: string,
): void {
  for (let side = -1; side <= 1; side += 2) {
    const x = side * halfSpan;
    const base = slope.height(x, z);
    g.add(at(cyl(mat, 0.09, 0.13, height, 6, SPAL.bark), x, base + height / 2, z));
    g.add(at(sphere(mat, 0.16, 6, topperHex), x, base + height + 0.1, z));
  }
}

/** Start gate: cool-coloured pennants (the race begins calm; gold is finish-only). */
function buildStartGate(g: THREE.Group, slope: SlopeDef): void {
  const z = 0;
  bannerPoles(g, slope, z, START_POLE_X, START_POLE_H, SPAL.snowDeep);
  const yTop = slope.height(START_POLE_X, z) + START_POLE_H - 0.15;
  pennantString(g, -START_POLE_X, START_POLE_X, yTop, z, 0.16, 0.4, [
    SPAL.skyZenith,
    SPAL.snowShade,
  ]);
}

/** FINISH GATE: sunGold pennants + gold toppers — the goal read (STYLE_BIBLE). */
function buildFinishGate(g: THREE.Group, slope: SlopeDef): void {
  const z = slope.finishZ;
  bannerPoles(g, slope, z, FINISH_POLE_X, FINISH_POLE_H, SPAL.sunGold);
  const yTop = slope.height(FINISH_POLE_X, z) + FINISH_POLE_H - 0.18;
  pennantString(g, -FINISH_POLE_X, FINISH_POLE_X, yTop, z, 0.22, 0.55, [
    SPAL.sunGold,
    SPAL.snowLit,
  ]);
}

/**
 * The lodge beyond the line: lodge-walls box, bark roof with a snowLit snow
 * blanket, sunGold windows (kettle-warm against the morning), rock chimney
 * with baked cartoon smoke puffs drifting leeward (STYLE_BIBLE: smoke via
 * baked spheres — opaque puffs fit the flat-shaded look).
 */
function buildLodge(g: THREE.Group, slope: SlopeDef): void {
  const lx = LODGE_X;
  const lz = slope.finishZ + LODGE_Z_PAD;
  const base = slope.height(lx, lz);

  // walls + roof (4-seg cone rotated 45° reads as a pitched roof)
  g.add(at(box(mat, 7, 3.2, 5.5, SPAL.lodge), lx, base + 1.6, lz));
  const roof = cone(mat, 4.9, 2.4, 4, SPAL.bark);
  roof.rotation.y = Math.PI / 4;
  g.add(at(roof, lx, base + 3.2 + 1.2, lz));
  const roofSnow = cone(mat, 5.05, 1.1, 4, SPAL.snowLit);
  roofSnow.rotation.y = Math.PI / 4;
  g.add(at(roofSnow, lx, base + 3.2 + 1.35, lz));

  // door + two warm windows on the face looking back at the finish (-z)
  g.add(at(box(mat, 1.1, 1.9, 0.15, SPAL.bark), lx - 1.2, base + 0.95, lz - 2.78));
  g.add(at(box(mat, 0.9, 0.9, 0.12, SPAL.sunGold), lx + 1.2, base + 1.7, lz - 2.78));
  g.add(at(box(mat, 0.9, 0.9, 0.12, SPAL.sunGold), lx - 2.2, base + 1.7, lz - 2.78));

  // chimney + smoke: puffs growing as they rise, drifting with the breeze
  const chX = lx + 2.1;
  const chZ = lz + 1.1;
  g.add(at(box(mat, 0.7, 1.8, 0.7, SPAL.rock), chX, base + 4.6, chZ));
  const puffs: ReadonlyArray<readonly [number, number, number, number, string]> = [
    // [dx, dy, dz, r, hex]
    [0.1, 5.7, 0, 0.45, SPAL.snowShade],
    [0.45, 6.5, -0.15, 0.65, SPAL.paper],
    [0.95, 7.4, -0.35, 0.9, SPAL.snowShade],
    [1.6, 8.4, -0.6, 1.2, SPAL.paper],
  ];
  for (const [dx, dy, dz, r, hex] of puffs) {
    g.add(at(sphere(mat, r, 6, hex), chX + dx, base + dy, chZ + dz));
  }

  // firewood stack against the wall — small lodge-life dressing
  g.add(at(box(mat, 1.6, 0.7, 0.6, SPAL.bark), lx + 3.1, base + 0.35, lz - 1.6));
}

/**
 * Start gate + finish gate + the lodge, baked into one group (one mesh per
 * SPAL colour). Positions are a pure function of the slope — no rng needed.
 */
export function buildGates(slope: SlopeDef): THREE.Group {
  const g = new THREE.Group();
  buildStartGate(g, slope);
  buildFinishGate(g, slope);
  buildLodge(g, slope);
  return bake(g);
}

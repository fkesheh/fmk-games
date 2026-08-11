// ============================================================================
// SKI SPLAT — GATES + LODGE (task R1, CONTRACT §7). The start gate at z=0,
// the SLALOM LINE (slope.gates — azure/ember flag checkpoints, alternating by
// gate index), the FINISH GATE at slope.finishZ (sunGold pennants — THE goal read: at race
// speed the gold string fading in through the morning haze is what every
// skier steers toward), and the lodge with chimney smoke beyond the line.
// STYLE_BIBLE model sheets: two banner poles + a pennant string per gate, and
// at the finish gold pennant flags + a sunGold banner panel slung between the
// poles; STYLE_BIBLE §V2: sculpted snow kicker ramps (the v2 hero asset), a
// festive finish (second pennant row, paper fringe, runout flag lines) and a
// cosier lodge (porch, ski rack, sun sign, warm light spill, barrel +
// firewood, deeper roof snow);
// bark/lodge palette on the lodge, warm sunGold windows, cartoon smoke puffs
// rising off the chimney. Everything static is collapsed by bake() into one
// mesh per SPAL colour.
// ============================================================================
import * as THREE from 'three';
import { KICKER_HEIGHT, SKIER_COLORS, SPAL } from '@splat/shared';
import type { SlopeDef } from '@splat/shared';
import { SUN_DIR, at, bake, box, cone, cyl, mat, sphere } from '../contract/visual.js';

// ---- start gate -----------------------------------------------------------------
const START_POLE_X = 7; // poles clear of the 4-wide start grid (±4.5 m)
const START_POLE_H = 3.2;

// ---- finish gate ------------------------------------------------------------------
const FINISH_POLE_X = 9; // wider, taller — the sprint corridor landmark
const FINISH_POLE_H = 8.4; // ~2x the start gate — monumental, readable at 200 m
const FINISH_BULK = 1.9; // pole/flag bulk multiplier vs the start gate

// ---- lodge ---------------------------------------------------------------------------
const LODGE_X = 14; // beside the runout, NOT blocking it
const LODGE_Z_PAD = 26; // this far beyond the finish line

// ---- slalom gates (flag checkpoints, STYLE_BIBLE model sheet) --------------------------
const SLALOM_POLE_H = 1.8; // slim flexible pole height (m)

// ---- kicker ramps (v2 hero asset, STYLE_BIBLE §V2.1) -------------------------------------
const KICKER_RUN_IN = 1.2;  // front-face horizontal run before the takeoff lip (m)
const KICKER_TAIL = 1.2;    // downhill back-drop past the lip (m) — the wedge is ~2.4 m total
const KICKER_BODY_T = 0.26; // wedge slab thickness (m)
const KICKER_FLANK_T = 0.16; // shadow-flank thickness (m)
const KICKER_CREASE_T = 0.12; // contact-crease band height (m)
const KICKER_SPRAY_N = 4;   // wind-crest spray cones off the lip (3–5)

// ---- finish festive pass (STYLE_BIBLE §V2.6) ----------------------------------------------
const FINISH_FRINGE_SPACING = 0.45; // paper fringe cone spacing along the banner (m)
const RUNOUT_FLAG_N = 6;            // sunGold pennant flags per piste edge
const RUNOUT_FLAG_SPACING = 4.5;    // flag spacing along the runout (m)
const RUNOUT_FLAG_H = 0.9;          // runout bark pole height (m)

/**
 * A pennant string between two poles: a thin bark line plus a row of small
 * 4-seg cones hanging point-down, colours alternating through `colors`.
 * Deterministic — spacing and count derive from the span and `spacing` only.
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
  spacing = 0.55,
): void {
  const span = x1 - x0;
  const line = cyl(mat, 0.02, 0.02, span, 4, SPAL.bark);
  line.rotation.z = Math.PI / 2; // cylinder axis y -> span along x
  g.add(at(line, (x0 + x1) / 2, yString, z));
  const count = Math.max(2, Math.floor(span / spacing));
  for (let i = 0; i < count; i++) {
    const x = x0 + (span * (i + 0.5)) / count;
    const hex = colors[i % colors.length] ?? SPAL.sunGold;
    const p = cone(mat, pennantR, pennantH, 4, hex);
    p.rotation.x = Math.PI; // hang point-down from the string
    g.add(at(p, x, yString - pennantH / 2 - 0.02, z));
  }
}

/** Two banner poles; returns nothing — toppers are orbs, or (finish gate)
 *  real pennant flags flying inward toward the piste centre. `bulk` scales
 *  the pole girth and the flag (the finish gate is built monumental). */
function bannerPoles(
  g: THREE.Group,
  slope: SlopeDef,
  z: number,
  halfSpan: number,
  height: number,
  topperHex: string,
  flags: boolean,
  bulk = 1,
): void {
  for (let side = -1; side <= 1; side += 2) {
    const x = side * halfSpan;
    const base = slope.height(x, z);
    g.add(at(cyl(mat, 0.09 * bulk, 0.13 * bulk, height, 6, SPAL.bark), x, base + height / 2, z));
    if (flags) {
      // gold pennant flag streaming toward the piste centre
      g.add(
        at(
          box(mat, 0.5 * bulk, 0.3 * bulk, 0.04, topperHex),
          x - side * 0.25 * bulk,
          base + height - 0.15 * bulk,
          z,
        ),
      );
    } else {
      g.add(at(sphere(mat, 0.16, 6, topperHex), x, base + height + 0.1, z));
    }
  }
}

/** Start gate: cool-coloured pennants (the race begins calm; gold is finish-only). */
function buildStartGate(g: THREE.Group, slope: SlopeDef): void {
  const z = 0;
  bannerPoles(g, slope, z, START_POLE_X, START_POLE_H, SPAL.snowDeep, false);
  const yTop = slope.height(START_POLE_X, z) + START_POLE_H - 0.15;
  pennantString(g, -START_POLE_X, START_POLE_X, yTop, z, 0.16, 0.4, [
    SPAL.skyZenith,
    SPAL.snowShade,
  ]);
}

/** FINISH GATE: MONUMENTAL — 2x-height poles with thick gold flags, big
 *  ALL-sunGold pennants and a wide sunGold banner panel slung between them:
 *  the goal read at 200 m through the morning haze, the biggest man-made
 *  thing on the mountain after the lodge (STYLE_BIBLE). Gold is finish-only;
 *  the start gate stays cool and modest. */
function buildFinishGate(g: THREE.Group, slope: SlopeDef): void {
  const z = slope.finishZ;
  bannerPoles(g, slope, z, FINISH_POLE_X, FINISH_POLE_H, SPAL.sunGold, true, FINISH_BULK);
  const yTop = slope.height(FINISH_POLE_X, z) + FINISH_POLE_H - 0.35;
  pennantString(g, -FINISH_POLE_X, FINISH_POLE_X, yTop, z, 0.42, 1.05, [SPAL.sunGold]);
  // banner panel between the poles, below the pennant string — wide and tall
  // enough to read as a finish BANNER, not a ribbon
  const yBanner = slope.height(0, z) + FINISH_POLE_H * 0.58;
  g.add(at(box(mat, FINISH_POLE_X * 1.5, 1.7, 0.1, SPAL.sunGold), 0, yBanner, z));
  // v2 festive pass: second pennant row + paper fringe + runout flag lines
  buildFinishFestive(g, slope);
}

/**
 * The lodge beyond the line: lodge-walls box, bark roof with a snowLit snow
 * blanket, sunGold windows (kettle-warm against the morning), two rock
 * chimneys with baked cartoon smoke puffs drifting leeward (STYLE_BIBLE:
 * smoke via baked spheres — opaque puffs fit the flat-shaded look), plus the
 * §V2.6 cosier pass: porch, ski rack, sun sign, warm light spill, barrel +
 * firewood.
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
  // deeper roof snow: the blanket is raised and widened to overhang the bark
  // roof — the lodge is snug under its drifts (STYLE_BIBLE §V2.6)
  const roofSnow = cone(mat, 5.35, 1.25, 4, SPAL.snowLit);
  roofSnow.rotation.y = Math.PI / 4;
  g.add(at(roofSnow, lx, base + 4.9, lz));

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

  // second, smaller chimney on the far roof side, with its own smoke trail
  const ch2X = lx - 2.1;
  const ch2Z = lz + 1.4;
  g.add(at(box(mat, 0.55, 1.4, 0.55, SPAL.rock), ch2X, base + 4.5, ch2Z));
  const smoke2: ReadonlyArray<readonly [number, number, number, number, string]> = [
    // [dx, dy, dz, r, hex]
    [0.15, 5.5, 0.05, 0.3, SPAL.snowShade],
    [0.45, 6.1, -0.05, 0.42, SPAL.paper],
    [0.85, 6.8, -0.15, 0.58, SPAL.snowShade],
  ];
  for (const [dx, dy, dz, r, hex] of smoke2) {
    g.add(at(sphere(mat, r, 6, hex), ch2X + dx, base + dy, ch2Z + dz));
  }

  // firewood stack against the wall — small lodge-life dressing
  g.add(at(box(mat, 1.6, 0.7, 0.6, SPAL.bark), lx + 3.1, base + 0.35, lz - 1.6));

  // v2 cosier-lodge pass: porch, ski rack, sun sign, warm light spill,
  // a barrel and more firewood (STYLE_BIBLE §V2.6)
  buildPorch(g, lx, lz, base);
  buildSkiRack(g, lx, lz, base);
  buildSunSign(g, lx, lz, base);

  // soft warm light spill on the snow in front of the windows
  const spill = box(mat, 3.6, 0.05, 2.6, SPAL.sunGold);
  spill.rotation.x = -0.18; // lie on the uphill grade
  g.add(at(spill, lx - 0.5, base + 0.06, lz - 3.7));

  // barrel + more firewood near the corner
  g.add(at(cyl(mat, 0.34, 0.34, 0.95, 8, SPAL.bark), lx + 3.1, base + 0.475, lz - 0.3));
  g.add(at(box(mat, 1.1, 0.5, 0.55, SPAL.bark), lx + 3.15, base + 0.25, lz - 2.25));
  g.add(at(box(mat, 0.65, 0.2, 0.2, SPAL.bark), lx + 3.5, base + 0.1, lz - 2.6));
  g.add(at(box(mat, 0.2, 0.2, 0.7, SPAL.bark), lx + 2.9, base + 0.1, lz - 2.1));
}

/**
 * The slalom line: every gate in slope.gates as two slim ~1.8 m poles with a
 * small triangular pennant each, the whole doorway in the gate colour —
 * SKIER_COLORS[0] azure on even gates, SKIER_COLORS[1] ember on odd (ski
 * slalom language; the opening, 2 x GATE_HALF_WIDTH, must read as a doorway
 * at 30 m against snow, and a fully coloured doorway does what bark poles
 * could not). Pennants stream downhill (+z) like wind flags. bake() merges
 * by material, so ~14 gates collapse into ONE mesh per colour — the entire
 * line adds exactly 2 draw calls (azure + ember), inside the <= 3 budget.
 * Deterministic: positions are a pure function of slope.gates.
 */
function buildSlalomGates(g: THREE.Group, slope: SlopeDef): void {
  for (let i = 0; i < slope.gates.length; i++) {
    const gate = slope.gates[i];
    if (gate === undefined) continue;
    const hex = SKIER_COLORS[i % 2] ?? SPAL.skyZenith;
    for (let side = -1; side <= 1; side += 2) {
      const x = gate.x + side * gate.halfWidth;
      const base = slope.height(x, gate.z);
      // slim pole, slight taper — the flexible slalom pole of the model sheet
      g.add(at(cyl(mat, 0.022, 0.034, SLALOM_POLE_H, 5, hex), x, base + SLALOM_POLE_H / 2, gate.z));
      // small triangular pennant near the top, pointing downhill
      const p = cone(mat, 0.15, 0.42, 4, hex);
      p.rotation.x = Math.PI / 2; // cone tip +y -> +z (downhill)
      g.add(at(p, x, base + SLALOM_POLE_H - 0.3, gate.z + 0.21));
    }
  }
}

/**
 * V2 hero asset (STYLE_BIBLE §V2.1): a sculpted SNOW wedge per slope.kickers
 * entry — a tapered ~2.4 m wedge whose 1.2 m run-in face slopes smoothly up
 * to the takeoff lip at k.z (KICKER_HEIGHT above the terrain), with a
 * snowShade back drop behind the lip, a snowShade shadow flank on the side
 * away from the sun (SUN_DIR — shadows on snow are blue, never grey),
 * snowDeep contact creases at both snow contacts, a thin bark lip on the
 * takeoff edge (the one warm "ride me" read), and a small snowLit wind-crest
 * spray fanning downwind (+x, the lodge-smoke breeze) off the lip so the
 * ramp reads "AIR!" at 30 m. Base sits on the terrain so the run-in reads as
 * a natural roll, never a cliff. Deterministic — a pure function of
 * slope.kickers; bake() merges every ramp into one mesh per SPAL colour.
 */
function buildKickers(g: THREE.Group, slope: SlopeDef): void {
  const sunRight = (SUN_DIR[0] ?? 0) >= 0; // morning sun sits over +x (skier's right)
  const shadowSide = sunRight ? -1 : 1;
  for (let i = 0; i < slope.kickers.length; i++) {
    const k = slope.kickers[i];
    if (k === undefined) continue;
    const w = k.halfWidth; // ramp width ~ the capture half-width (~1.6 m)
    const base = slope.height(k.x, k.z);

    // run-in face: a slab tilted up toward +z — flush at k.z-1.2, lip at k.z
    const theta = Math.atan(KICKER_HEIGHT / KICKER_RUN_IN);
    const cosT = Math.cos(theta);
    const runLen = KICKER_RUN_IN / cosT; // real slab length (tilt shortens the z-span)
    const runCy = base + KICKER_HEIGHT / 2 - (KICKER_BODY_T / 2) * cosT;
    const run = box(mat, w, KICKER_BODY_T, runLen, SPAL.snowLit);
    run.rotation.x = -theta; // +z end rises to the lip
    g.add(at(run, k.x, runCy, k.z - KICKER_RUN_IN / 2));

    // back drop: the mirrored slab behind the lip, falling back to the snow
    const drop = box(mat, w, KICKER_BODY_T, runLen, SPAL.snowShade);
    drop.rotation.x = theta; // +z end falls away
    g.add(at(drop, k.x, runCy, k.z + KICKER_TAIL / 2));

    // shadow flank on the side away from the sun — gives the wedge its volume
    const flankX = k.x + shadowSide * (w / 2 + KICKER_FLANK_T / 2 + 0.02);
    g.add(
      at(
        box(mat, KICKER_FLANK_T, KICKER_HEIGHT * 0.82, KICKER_RUN_IN + KICKER_TAIL + 0.05, SPAL.snowShade),
        flankX,
        base + KICKER_HEIGHT * 0.41,
        k.z,
      ),
    );

    // snowDeep contact creases where the wedge meets the piste
    const creaseW = w + 0.3;
    g.add(at(box(mat, creaseW, KICKER_CREASE_T, 0.42, SPAL.snowDeep), k.x, base + KICKER_CREASE_T / 2, k.z - KICKER_RUN_IN - 0.05));
    g.add(at(box(mat, creaseW, KICKER_CREASE_T, 0.42, SPAL.snowDeep), k.x, base + KICKER_CREASE_T / 2, k.z + KICKER_TAIL + 0.05));

    // thin bark lip on the takeoff edge (slightly narrower — the taper read)
    g.add(at(box(mat, w * 0.8, 0.1, 0.2, SPAL.bark), k.x, base + KICKER_HEIGHT + 0.02, k.z + 0.05));

    // wind-crest spray: tiny snowLit cones fanning leeward (+x) off the lip
    const spray: ReadonlyArray<readonly [number, number]> = [
      // [leeward dx, yaw]
      [0.05, -0.12],
      [0.24, 0.07],
      [0.42, -0.03],
      [0.58, 0.1],
    ];
    for (let s = 0; s < KICKER_SPRAY_N; s++) {
      const sp = spray[s];
      if (sp === undefined) continue;
      const [dx, yaw] = sp;
      const c = cone(mat, 0.075, 0.32, 4, SPAL.snowLit);
      c.rotation.z = -Math.PI / 2; // cone apex toward +x (downwind)
      c.rotation.y = yaw; // small horizontal fan
      g.add(at(c, k.x + dx, base + 0.7 + dx * 0.25, k.z + 0.08 + dx * 0.2));
    }
  }
}

/**
 * V2 festive finish (STYLE_BIBLE §V2.6): a second, smaller pennant row slung
 * BELOW the banner (sunGold + all 8 skier colours alternating), a paper
 * fringed edge on the banner panel, and short sunGold flag lines along both
 * piste edges past the line (bark poles ~0.9 m) guiding the eye through the
 * runout sprint. All colours already live in the gates bake — the festive
 * pass adds no new draw calls beyond the skier colours of the pennant row.
 */
function buildFinishFestive(g: THREE.Group, slope: SlopeDef): void {
  const z = slope.finishZ;
  const yBanner = slope.height(0, z) + FINISH_POLE_H * 0.58;

  // second pennant row below the banner — sunGold alternating with the 8
  // skier colours, smaller pennants and a touch more spacing
  const secondColors: readonly string[] = [SPAL.sunGold, ...SKIER_COLORS];
  pennantString(g, -FINISH_POLE_X * 0.8, FINISH_POLE_X * 0.8, yBanner - 1.5, z, 0.17, 0.45, secondColors, 0.62);

  // paper fringed edge: small cones hanging from the banner's bottom edge
  const bannerHalf = FINISH_POLE_X * 0.75;
  const fringeN = Math.max(2, Math.floor((bannerHalf * 2) / FINISH_FRINGE_SPACING));
  for (let i = 0; i < fringeN; i++) {
    const fx = -bannerHalf + (bannerHalf * 2 * (i + 0.5)) / fringeN;
    const f = cone(mat, 0.06, 0.22, 4, SPAL.paper);
    f.rotation.x = Math.PI; // hang point-down
    g.add(at(f, fx, yBanner - 0.85 - 0.11, z));
  }

  // runout flag lines: ~6 small sunGold pennants per piste edge on bark poles
  const edgeX = slope.width / 2 - 0.8;
  for (let i = 0; i < RUNOUT_FLAG_N; i++) {
    const rz = z + 4 + i * RUNOUT_FLAG_SPACING;
    for (let side = -1; side <= 1; side += 2) {
      const rx = side * edgeX;
      const rb = slope.height(rx, rz);
      g.add(at(cyl(mat, 0.03, 0.045, RUNOUT_FLAG_H, 5, SPAL.bark), rx, rb + RUNOUT_FLAG_H / 2, rz));
      const penn = cone(mat, 0.12, 0.34, 4, SPAL.sunGold);
      penn.rotation.x = Math.PI / 2; // tip +z — downhill, like the slalom pennants
      g.add(at(penn, rx, rb + RUNOUT_FLAG_H - 0.2, rz + 0.16));
    }
  }
}

/** Porch over the door (STYLE_BIBLE §V2.6): two bark posts + a small
 *  snow-dusted porch roof, standing clear of the door opening. */
function buildPorch(g: THREE.Group, lx: number, lz: number, base: number): void {
  const zFront = lz - 3.0; // in front of the wall face (lz - 2.75)
  for (let side = -1; side <= 1; side += 2) {
    g.add(at(cyl(mat, 0.05, 0.07, 2.3, 5, SPAL.bark), lx - 1.2 + side * 0.8, base + 1.15, zFront));
  }
  g.add(at(box(mat, 2.5, 0.14, 1.5, SPAL.bark), lx - 1.2, base + 2.4, zFront));
  g.add(at(box(mat, 2.64, 0.1, 1.64, SPAL.snowLit), lx - 1.2, base + 2.5, zFront));
}

/** Ski rack beside the door (STYLE_BIBLE §V2.6): two bark uprights + a top
 *  bar holding two pairs of skis (SKIER_COLORS top sheets over ink bases)
 *  leaning back on the wall. */
function buildSkiRack(g: THREE.Group, lx: number, lz: number, base: number): void {
  const rz = lz - 2.9; // just in front of the wall
  const x0 = lx - 3.0;
  const x1 = lx - 3.9;
  g.add(at(cyl(mat, 0.04, 0.05, 0.6, 5, SPAL.bark), x0, base + 0.3, rz));
  g.add(at(cyl(mat, 0.04, 0.05, 0.6, 5, SPAL.bark), x1, base + 0.3, rz));
  g.add(at(box(mat, 1.05, 0.07, 0.07, SPAL.bark), (x0 + x1) / 2, base + 0.62, rz));
  const pairs: ReadonlyArray<[number, string]> = [
    [lx - 3.3, SKIER_COLORS[2] ?? SPAL.sunGold], // burnt orange
    [lx - 3.6, SKIER_COLORS[4] ?? SPAL.sunGold], // violet
  ];
  for (const [px, hex] of pairs) {
    for (let s = -1; s <= 1; s += 2) {
      const sx = px + s * 0.07;
      const baseBox = box(mat, 0.15, 0.022, 1.9, SPAL.ink);
      baseBox.rotation.x = 0.12; // lean the top back onto the wall (+z)
      g.add(at(baseBox, sx, base + 0.98, rz));
      const top = box(mat, 0.13, 0.03, 1.9, hex);
      top.rotation.x = 0.12;
      g.add(at(top, sx, base + 1.0, rz));
    }
  }
}

/** sunGold sun sign above the door (STYLE_BIBLE §V2.6): a small sphere ringed
 *  by six cone rays radiating in the wall plane. */
function buildSunSign(g: THREE.Group, lx: number, lz: number, base: number): void {
  const sx = lx - 1.2;
  const sy = base + 2.85;
  const sz = lz - 2.85;
  g.add(at(sphere(mat, 0.24, 6, SPAL.sunGold), sx, sy, sz));
  for (let i = 0; i < 6; i++) {
    const th = (i * Math.PI) / 3;
    const ray = cone(mat, 0.035, 0.18, 4, SPAL.sunGold);
    ray.rotation.z = th - Math.PI / 2; // cone apex +y -> direction (cos th, sin th, 0)
    g.add(at(ray, sx + 0.3 * Math.cos(th), sy + 0.3 * Math.sin(th), sz));
  }
}

/**
 * Start gate + slalom line + kicker ramps + finish gate + the lodge, baked into one group
 * (one mesh per SPAL colour). Positions are a pure function of the slope —
 * no rng needed.
 */
export function buildGates(slope: SlopeDef): THREE.Group {
  const g = new THREE.Group();
  buildStartGate(g, slope);
  buildSlalomGates(g, slope);
  buildKickers(g, slope);
  buildFinishGate(g, slope);
  buildLodge(g, slope);
  return bake(g);
}

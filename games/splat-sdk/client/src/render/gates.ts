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
// rising off the chimney. Art-director round-4: the round-3 burnt-orange
// boundary netting (~50 identical flat slabs) is REBUILT as muted accordion
// snow fencing that shades itself, wears snow and is seeded-scattered — see
// buildBoundaryNetting. Everything static is collapsed by bake() into one mesh
// per SPAL colour.
// ============================================================================
import * as THREE from 'three';
import { rng, rngInt, rngRange } from '@platform/shared';
import { KICKER_HEIGHT, SKIER_COLORS, SPAL } from '@splat/shared';
import type { SlopeDef } from '@splat/shared';
import { SUN_DIR, at, bake, box, cone, cyl, mat, sphere } from '../contract/visual.js';

// ---- start gate -----------------------------------------------------------------
const START_POLE_X = 7; // poles clear of the 4-wide start grid (±4.5 m)
const START_POLE_H = 3.2;

// ---- finish gate ------------------------------------------------------------------
const FINISH_POLE_X = 9; // wider, taller — the sprint corridor landmark
const FINISH_POLE_H = 8.8; // ~2.75x the start gate — monumental, readable at 200 m (judge F5: slightly taller)
const FINISH_BULK = 1.9; // pole/flag bulk multiplier vs the start gate
// banner centre as a fraction of pole height — raised clear of the ground haze
// band so the gold panel reads as a banner against the sky, not a ribbon lost
// in the fog (judge F5)
const FINISH_BANNER_Y = 0.66;
// finish grounding (judge F5): small snowLit rocks hugging the pole feet + a
// pair of tiny sunGold foot flags. All tucked at/outside the poles
// (|x| >= FINISH_POLE_X), never inside the run corridor.
const FINISH_ROCKS: ReadonlyArray<readonly [number, number, number]> = [
  // [x, zOff, r] — zOff positive = downhill of the line
  [-FINISH_POLE_X - 0.8, 0.25, 0.55],
  [FINISH_POLE_X + 0.8, 0.25, 0.55],
  [-FINISH_POLE_X - 1.7, -0.35, 0.4],
];
const FINISH_FOOT_FLAG_H = 1.05; // tiny bark pole height at each gate foot (m)

// ---- lodge ---------------------------------------------------------------------------
const LODGE_X = 14; // beside the runout, NOT blocking it
const LODGE_Z_PAD = 26; // this far beyond the finish line

// ---- slalom gates (flag checkpoints, STYLE_BIBLE model sheet) --------------------------
const SLALOM_POLE_H = 1.8; // slim flexible pole height (m)

// ---- kicker ramps (v2 hero asset, STYLE_BIBLE §V2.1) -------------------------------------
const KICKER_RUN_IN = 1.2;  // front-face horizontal run before the takeoff lip (m)
const KICKER_TAIL = 1.2;    // downhill back-drop past the lip (m) — the wedge is ~2.4 m total
const KICKER_CREASE_T = 0.12; // contact-crease skirt height (m)
const KICKER_CREASE_PAD = 0.15; // m the snowDeep skirt extends beyond the wedge footprint per side
const KICKER_CREASE_D = 0.42;   // m depth/thickness of each skirt bar (front/back/side)
const KICKER_CREASE_SIDE_T = 0.3; // m x-thickness of the left/right skirt bars
const KICKER_LIP_R = 0.09;  // bark takeoff-lip coping radius (m) — round-2: slimmed from 0.16
                             // (was 37.6% of KICKER_HEIGHT, read as a log); proud of the ridge
                             // by 0.7*R ~= 0.063 m, a "few centimetres" coping read at 30 m
const KICKER_FLANK_T = 0.12; // shadow-flank plate thickness (m) — the sun/shade split lives here
const KICKER_FLANK_GAP = 0.006; // m clearance between the flank plate and the body's end cap
const KICKER_SINK = 0.02;   // m the whole tilted assembly is nudged down so the base never floats
const KICKER_SPRAY_N = 4;   // wind-crest spray cones off the lip (3–5)

// ---- finish festive pass (STYLE_BIBLE §V2.6) ----------------------------------------------
const FINISH_FRINGE_SPACING = 0.45; // paper fringe cone spacing along the banner (m)
const RUNOUT_FLAG_N = 6;            // sunGold pennant flags per piste edge
const RUNOUT_FLAG_SPACING = 4.5;    // flag spacing along the runout (m)
const RUNOUT_FLAG_H = 0.9;          // runout bark pole height (m)

// ---- piste-boundary safety fencing (art-director round-4 REBUILD) ------------
// Round 3 stamped, every 14 m down BOTH edges for the whole 800 m run, a
// box(0.06, 0.85, 7.7) panel in SKIER_COLORS[2] #c26a1b on a bark post: ~50
// identical flat slabs, the most saturated warm mass in a frozen-snow frame,
// ONE flat colour per panel (so no lit/shade face split at any sun angle), no
// snow cap, no contact shading. A blind judge flagged it unprompted as "a huge
// flat, unlit orange rectangle... zero Lambert shading, no gradient, no
// contact-AO", and at close range one panel filled a third of the frame.
//
// Rebuilt as ACCORDION snow fencing — real course furniture:
//   * the lit/shade split is in the GEOMETRY, not the shader. Each bay is a
//     zig-zag of short planks folded +-FENCE_FOLD about y, so alternate vanes
//     genuinely turn toward and away from SUN_DIR. A single camera-facing plane
//     is back-lit by construction on the +x rail (SUN_AZ = 1.05 puts the key
//     ahead-RIGHT) and can never shade itself; a fold can, on BOTH rails.
//     Every vane is painted from its own sun dot: thornLit when it faces the
//     sun, thorn when it turns away — the game's own lit/shade tier idiom.
//   * thornLit/thorn instead of burnt orange: warm, obviously safety furniture,
//     but ~40% less saturated than #c26a1b, so it stops being a traffic cone.
//   * snowLit crest caps (with irregular drift lumps) along the top edge and a
//     snowDeep contact crease at every vane foot — the grounding every other
//     prop in this game already has.
//   * a seeded, ISOLATED rng stream scatters the bays: irregular pitch, ~1/4 of
//     the slots empty, 1-3 bay runs, per-bay lateral and height jitter. Roughly
//     160 m of fence over 1576 m of edge (round 3: ~385 m of solid slab), and
//     never the same rhythm twice.
// Draw-call cost: the geometry all merges through bake(), but thornLit/thorn
// are two colours the gates group did not previously carry, so the group grows
// by exactly 2 meshes no matter how many bays are built.
const FENCE_VANE_L = 0.66;   // plank length along its own long axis (m)
const FENCE_VANE_H = 0.74;   // plank height (m)
const FENCE_VANE_T = 0.05;   // plank thickness (m)
const FENCE_FOLD = 1.15;     // rad — accordion half-angle off the rail normal.
// 1.15 is not a taste number: the piste-facing normal is (-side*cos, 0,
// +-sin), and its dot with SUN_DIR flips sign between the two vane families on
// BOTH rails only for folds beyond ~1.09 rad (the +x rail's normal carries
// -0.344 of sun before the fold contributes +-0.441). Below that the right-hand
// fence goes uniformly dark and the whole point is lost.
const FENCE_VANES_MIN = 8;   // vanes per bay (bay length = n * L * cos(FOLD))
const FENCE_VANES_MAX = 14;
const FENCE_POST_EVERY = 4;  // a bark post every N vanes, plus one at the end
const FENCE_POST_EXTRA_H = 0.36; // post stands this far proud of the panel (m)
const FENCE_SINK = 0.07;     // panel + posts sit this far INTO the snow (m)
const FENCE_CAP_EVERY = 3;   // every Nth vane also gets a drift lump on its cap
const FENCE_EDGE_OFFSET = 0.85; // m beyond slope.width/2 to the INNER fold line
const FENCE_LATERAL_MIN = -0.25; // per-bay lateral jitter (m)
const FENCE_LATERAL_MAX = 0.2;   // ...capped so the fold never reaches the
// forest band's inner edge (terrain.ts FOREST_IN * 1.1 = 1.65 m beyond halfW)
const FENCE_PITCH_MIN = 16;  // m between bay slots along z
const FENCE_PITCH_MAX = 40;
const FENCE_SKIP_P = 0.26;   // share of slots left empty — real gaps in the run
const FENCE_RUN_3_P = 0.13;  // slot becomes a 3-bay run
const FENCE_RUN_2_P = 0.34;  // ...or a 2-bay run
const FENCE_RUN_GAP = 1.3;   // m between bays inside a run
const FENCE_RNG_SALT = 0x7e21; // isolated stream: never perturbs gameplay rng
const NET_Z_START = 18;       // m — clear of the start gate poles
const NET_Z_END_PAD = 12;     // m — stop short of the finish gate's own festive treatment

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
  // enough to read as a finish BANNER, not a ribbon; raised clear of the
  // ground haze band (judge F5)
  const yBanner = slope.height(0, z) + FINISH_POLE_H * FINISH_BANNER_Y;
  g.add(at(box(mat, FINISH_POLE_X * 1.5, 1.7, 0.1, SPAL.sunGold), 0, yBanner, z));
  // grounding (judge F5): snowLit rocks + a pair of tiny sunGold foot flags
  buildFinishGrounding(g, slope);
  // v2 festive pass: second pennant row + paper fringe + runout flag lines
  buildFinishFestive(g, slope);
}

/** Finish grounding (judge F5): three small snowLit rocks hugging the pole
 *  feet (one nestled just outside each pole, one further out) plus a pair of
 *  tiny sunGold pennant flags on short bark poles planted at the gate feet —
 *  the gate reads PLANTED in the snow, never floating. Everything sits within
 *  ~1.8 m of the poles (|x| >= FINISH_POLE_X), never inside the run corridor,
 *  and merges into the existing snowLit/bark/sunGold bakes — zero new draw
 *  calls. Deterministic: a pure function of slope.height, no rng. */
function buildFinishGrounding(g: THREE.Group, slope: SlopeDef): void {
  const z = slope.finishZ;
  for (const [x, zOff, r] of FINISH_ROCKS) {
    const base = slope.height(x, z + zOff);
    // sunk ~1/3 into the snow so the rock reads grounded, never floating
    g.add(at(sphere(mat, r, 5, SPAL.snowLit), x, base - r * 0.35, z + zOff));
  }
  // a pair of tiny sunGold foot flags, one at each pole, uphill of the line
  for (let side = -1; side <= 1; side += 2) {
    const fx = side * FINISH_POLE_X;
    const fz = z - 0.45;
    const fb = slope.height(fx, fz);
    g.add(at(cyl(mat, 0.025, 0.035, FINISH_FOOT_FLAG_H, 5, SPAL.bark), fx, fb + FINISH_FOOT_FLAG_H / 2, fz));
    const penn = cone(mat, 0.13, 0.3, 4, SPAL.sunGold);
    penn.rotation.x = Math.PI / 2; // tip +z — downhill, like the runout pennants
    g.add(at(penn, fx, fb + FINISH_FOOT_FLAG_H - 0.15, fz + 0.14));
  }
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
  // deeper roof snow: the blanket is raised a touch higher (judge F5) to
  // crest over the ridge and widened to overhang the bark roof — the lodge
  // is snug under its drifts (STYLE_BIBLE §V2.6)
  const roofSnow = cone(mat, 5.35, 1.25, 4, SPAL.snowLit);
  roofSnow.rotation.y = Math.PI / 4;
  g.add(at(roofSnow, lx, base + 5.05, lz));

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
 * V2 hero asset (STYLE_BIBLE §V2.1): a sculpted SNOW WEDGE per slope.kickers
 * entry, built as ONE continuous solid rather than disjoint slabs — a single
 * FULL-WIDTH triangular prism, all snowLit, so the ride surface (run-in face
 * + back-drop face, which meet at the apex ridge) is one unbroken bright
 * plane with no lengthwise seam. The prism comes from `cyl(mat, r, r, h, 3,
 * hex)` (radialSegments=3 makes a triangular prism) laid on its side —
 * rotation (-PI/2, 0, -PI/2), empirically derived in scratchpad, maps local Y
 * (the prism axis) to world X (width), local Z (apex-vs-base) to world Y
 * (height), local X (the base-corner spread) to world Z (run-in/tail reach)
 * — then non-uniformly scaled so the regular triangular cross-section
 * becomes the exact 2.4 m x 0.85 m wedge profile: base from
 * k.z-KICKER_RUN_IN to k.z+KICKER_TAIL, apex at k.z. Round-2 art-director
 * finding: an x-split of this shape cannot express sun direction (no visible
 * face has an x-component normal — only the base, the two slope faces and
 * the end caps), so the snowShade "shadow side" (away from SUN_DIR) is
 * instead a thin flank PLATE flush against the shadow-side end cap — its own
 * mini triangular prism, same profile, ~0.12 m thick, offset a few mm clear
 * of the cap to dodge z-fighting. A snowDeep contact-crease skirt runs the
 * FULL perimeter (front, back, both sides) where the wedge meets the piste,
 * and a slim bark coping (a cylinder laid along x) caps the takeoff edge —
 * the one warm "ride me" note, proud of the ridge by only a few centimetres
 * (round-2: the first pass was a 0.32 m log dominating the asset). A small
 * snowLit wind-crest spray fans downwind (+x) off the lip. The whole
 * per-kicker assembly (wedge, flank, lip, skirt, spray) is built in
 * pivot-local coordinates inside its own THREE.Group, then tilted about x to
 * the LOCAL fall line — the secant angle between the real terrain height at
 * the run-in toe and the tail toe — so the base actually follows the slope
 * (round-2: a rigid flat bottom sampled at one point buried/floated up to
 * 0.5 m over the 2.4 m footprint). The pivot sits exactly at the apex ridge
 * (k.x, slope.height(k.x,k.z)+KICKER_HEIGHT, k.z), so the ridge itself never
 * moves under the tilt; the whole group is then nudged down by KICKER_SINK
 * so the base can never float. bake() merges every ramp (through the nested
 * group) into one mesh per SPAL colour. Deterministic — a pure function of
 * slope.kickers.
 */
function buildKickers(g: THREE.Group, slope: SlopeDef): void {
  const sunRight = (SUN_DIR[0] ?? 0) >= 0; // morning sun sits over +x (skier's right)
  const shadowSide = sunRight ? -1 : 1;
  for (let i = 0; i < slope.kickers.length; i++) {
    const k = slope.kickers[i];
    if (k === undefined) continue;
    const w = k.halfWidth; // full ramp width (~1.6 m — this field is the TOTAL span, not a half)
    const halfW = w / 2;
    const base = slope.height(k.x, k.z);

    // local fall-line pitch: the secant angle between the real terrain
    // height at the run-in toe (k.z - RUN_IN) and the tail toe (k.z + TAIL),
    // so the tilted base tracks the actual slope instead of a flat sample.
    const hUp = slope.height(k.x, k.z - KICKER_RUN_IN);
    const hDown = slope.height(k.x, k.z + KICKER_TAIL);
    const pitch = Math.atan2(hUp - hDown, KICKER_RUN_IN + KICKER_TAIL);

    // per-kicker group, pivoted exactly at the apex ridge so the ridge is
    // invariant under the tilt; every child below is positioned RELATIVE to
    // this pivot (worldX - k.x, worldY - pivotY, worldZ - k.z).
    const pivotY = base + KICKER_HEIGHT;
    const kg = new THREE.Group();
    kg.rotation.x = pitch;
    g.add(at(kg, k.x, pivotY - KICKER_SINK, k.z));

    // the sculpted wedge body: ONE full-width triangular prism, snowLit.
    // scaleZ turns the triangle's unit height (1.5, from base at localZ=-0.5
    // to apex at localZ=1) into KICKER_HEIGHT; scaleX turns its base
    // half-spread (0.8660254, from radialSegments=3 on a unit circle) into
    // KICKER_RUN_IN (== KICKER_TAIL, so the un-tilted profile is symmetric).
    const scaleZ = KICKER_HEIGHT / 1.5;
    const scaleX = KICKER_RUN_IN / 0.8660254;
    const bodyLocalY = scaleZ / 2 - KICKER_HEIGHT; // pivot-relative
    const body = cyl(mat, 1, 1, 1, 3, SPAL.snowLit);
    body.rotation.set(-Math.PI / 2, 0, -Math.PI / 2);
    body.scale.set(scaleX, w, scaleZ);
    kg.add(at(body, 0, bodyLocalY, 0));

    // shadow flank: a thin matching prism flush against the shadow-side end
    // cap (away from SUN_DIR) — the only place this shape can carry a
    // snowShade read without slicing the lit ride surface.
    const flank = cyl(mat, 1, 1, 1, 3, SPAL.snowShade);
    flank.rotation.set(-Math.PI / 2, 0, -Math.PI / 2);
    flank.scale.set(scaleX, KICKER_FLANK_T, scaleZ);
    const flankX = shadowSide * (halfW + KICKER_FLANK_GAP + KICKER_FLANK_T / 2);
    kg.add(at(flank, flankX, bodyLocalY, 0));

    // bark takeoff lip: a slim coping along the ridge, proud of it by only a
    // few centimetres (round-2 fix: was a 0.32 m diameter log).
    const lip = cyl(mat, KICKER_LIP_R, KICKER_LIP_R, w * 0.86, 8, SPAL.bark);
    lip.rotation.z = Math.PI / 2; // cylinder axis y -> x (spans the ridge width)
    kg.add(at(lip, 0, -KICKER_LIP_R * 0.3, 0.04));

    // snowDeep contact-crease skirt, all the way round the footprint — front
    // and back bars plus two side bars whose z-length reaches their outer
    // edges, so all four corners overlap and the ring has no gap.
    const creaseW = w + 2 * KICKER_CREASE_PAD;
    const creaseLocalY = KICKER_CREASE_T / 2 - KICKER_HEIGHT;
    const frontZ = -KICKER_RUN_IN - 0.05;
    const backZ = KICKER_TAIL + 0.05;
    kg.add(at(box(mat, creaseW, KICKER_CREASE_T, KICKER_CREASE_D, SPAL.snowDeep), 0, creaseLocalY, frontZ));
    kg.add(at(box(mat, creaseW, KICKER_CREASE_T, KICKER_CREASE_D, SPAL.snowDeep), 0, creaseLocalY, backZ));
    const sideLen = backZ + KICKER_CREASE_D / 2 - (frontZ - KICKER_CREASE_D / 2);
    for (const side of [-1, 1] as const) {
      const sx = side * (halfW + KICKER_CREASE_PAD);
      kg.add(at(box(mat, KICKER_CREASE_SIDE_T, KICKER_CREASE_T, sideLen, SPAL.snowDeep), sx, creaseLocalY, 0));
    }

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
      kg.add(at(c, dx, -0.15 + dx * 0.25, 0.08 + dx * 0.2));
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
  const yBanner = slope.height(0, z) + FINISH_POLE_H * FINISH_BANNER_Y;

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

/**
 * ONE accordion fence bay, starting at (side * cx, z0) and walking downhill.
 *
 * Each vane is a plank whose piste-facing normal is folded +-FENCE_FOLD about
 * y; consecutive vanes alternate, so the bay zig-zags outward and back around
 * the `cx` line (never inward — the fold can only take the fence FURTHER from
 * the racing line). Grounding is per vane, so the fence follows the terrain
 * instead of floating across it the way one 7.7 m slab did.
 *
 * Colour is decided by physics, not by taste: dot(normal, SUN_DIR) > 0 paints
 * thornLit, otherwise thorn. On the -x rail the +fold family is lit and the
 * -fold family is not; on the +x rail it is the other way round. Either way
 * every bay carries both tiers.
 *
 * Returns the z the bay ended at.
 */
function buildFenceBay(
  g: THREE.Group,
  slope: SlopeDef,
  side: number,
  cx: number,
  z0: number,
  nVanes: number,
  hScale: number,
): number {
  const cosF = Math.cos(FENCE_FOLD);
  const sinF = Math.sin(FENCE_FOLD);
  const sunX = SUN_DIR[0] ?? 0;
  const sunZ = SUN_DIR[2] ?? 0;
  const h = FENCE_VANE_H * hScale;
  const postH = h + FENCE_POST_EXTRA_H;
  let x = side * cx;
  let z = z0;
  for (let i = 0; i < nVanes; i++) {
    const fold = i % 2 === 0 ? 1 : -1;
    // piste-facing normal of this vane (horizontal, folded about y)
    const nx = -side * cosF;
    const nz = fold * sinF;
    const yaw = Math.atan2(nx, nz); // maps the box's local +z face onto (nx, nz)
    // the plank's long axis, forced to advance downhill (+z)
    let ax = Math.cos(yaw);
    let az = -Math.sin(yaw);
    if (az < 0) {
      ax = -ax;
      az = -az;
    }
    const dx = ax * FENCE_VANE_L;
    const dz = az * FENCE_VANE_L;
    const mx = x + dx / 2;
    const mz = z + dz / 2;
    const base = slope.height(mx, mz);

    // the plank itself — lit tier or shade tier by its own sun dot
    const hex = nx * sunX + nz * sunZ > 0 ? SPAL.thornLit : SPAL.thorn;
    const plank = box(mat, FENCE_VANE_L, h, FENCE_VANE_T, hex);
    plank.rotation.y = yaw;
    g.add(at(plank, mx, base + h / 2 - FENCE_SINK, mz));

    // snowLit crest cap along the top edge, wider than the plank so it reads
    // as settled snow rather than a painted line
    const cap = box(mat, FENCE_VANE_L * 0.99, 0.06, FENCE_VANE_T + 0.11, SPAL.snowLit);
    cap.rotation.y = yaw;
    g.add(at(cap, mx, base + h - FENCE_SINK + 0.02, mz));
    if (i % FENCE_CAP_EVERY === 0) {
      // an irregular drift lump so the crest is never a ruler line
      const lump = box(mat, FENCE_VANE_L * 0.34, 0.11, FENCE_VANE_T + 0.17, SPAL.snowLit);
      lump.rotation.y = yaw;
      g.add(at(lump, mx - dx * 0.22, base + h - FENCE_SINK + 0.06, mz - dz * 0.22));
    }

    // snowDeep contact crease where the panel meets the snow
    const crease = box(mat, FENCE_VANE_L * 1.02, 0.13, FENCE_VANE_T + 0.3, SPAL.snowDeep);
    crease.rotation.y = yaw;
    g.add(at(crease, mx, base + 0.065 - FENCE_SINK, mz));

    // a bark post at every FENCE_POST_EVERY fold, plus a brace kicking outward
    if (i % FENCE_POST_EVERY === 0) {
      const pb = slope.height(x, z);
      g.add(at(cyl(mat, 0.045, 0.065, postH, 5, SPAL.bark), x, pb + postH / 2 - FENCE_SINK, z));
      const brace = cyl(mat, 0.03, 0.04, 0.7, 4, SPAL.bark);
      brace.rotation.z = -side * 0.55; // leans away from the piste
      g.add(at(brace, x + side * 0.17, pb + 0.3 - FENCE_SINK, z));
    }

    x += dx;
    z += dz;
  }
  // closing post
  const pb = slope.height(x, z);
  g.add(at(cyl(mat, 0.045, 0.065, postH, 5, SPAL.bark), x, pb + postH / 2 - FENCE_SINK, z));
  return z;
}

/**
 * Piste-boundary safety fencing (art-director round-4 rebuild; §V3.3 chroma
 * budget still gets its warm in-world accent, just muted and shaped). Bays are
 * scattered along BOTH piste edges from past the start gate to short of the
 * finish festive pass by an ISOLATED seeded stream, rng(seed ^ FENCE_RNG_SALT)
 * — it draws from nothing genSlope touches, so no plant, gate or kicker moves
 * (the rngDigest gate proves it). Math.random is a contract violation.
 *
 * The inner fold line sits at slope.width/2 + FENCE_EDGE_OFFSET and the fold
 * only ever pushes outward, so no part of the fence is closer to the racing
 * line than the round-3 netting was, and its outer reach stops short of the
 * forest band. Nothing here is a collider — buildGates is visual only.
 */
function buildBoundaryNetting(g: THREE.Group, slope: SlopeDef): void {
  const next = rng(slope.seed ^ FENCE_RNG_SALT);
  const zEnd = slope.finishZ - NET_Z_END_PAD;
  const baseX = slope.width / 2 + FENCE_EDGE_OFFSET;
  for (let side = -1; side <= 1; side += 2) {
    let z = NET_Z_START + rngRange(next, 0, FENCE_PITCH_MIN);
    while (z < zEnd) {
      // every slot draws the same values whether or not it places a bay, so
      // the two rails stay independent of each other's skip pattern
      const skip = next() < FENCE_SKIP_P;
      const r = next();
      const bays = r < FENCE_RUN_3_P ? 3 : r < FENCE_RUN_3_P + FENCE_RUN_2_P ? 2 : 1;
      const lateral = rngRange(next, FENCE_LATERAL_MIN, FENCE_LATERAL_MAX);
      const hScale = rngRange(next, 0.88, 1.14);
      const nVanes = rngInt(next, FENCE_VANES_MIN, FENCE_VANES_MAX);
      const pitch = rngRange(next, FENCE_PITCH_MIN, FENCE_PITCH_MAX);
      if (!skip) {
        let bz = z;
        for (let b = 0; b < bays && bz < zEnd; b++) {
          bz = buildFenceBay(g, slope, side, baseX + lateral, bz, nVanes, hScale) + FENCE_RUN_GAP;
        }
      }
      z += pitch;
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
  buildBoundaryNetting(g, slope);
  return bake(g);
}

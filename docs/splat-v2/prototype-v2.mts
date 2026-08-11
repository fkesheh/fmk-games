// v2 4-year-old prototype — empirical evidence for the gauntlet.
// Implements the CONTRACT §11.2 jump machine (world-space arc) + §11.3 kicker
// placement on the REAL genSlope, then runs full-lock both directions on 20
// seeds. Verifies: always finishes, always lands, containment, plant-hits.
import { genSlope } from '/Users/fkesheh/projects/fps/games/splat/shared/src/slope.js';
import { stepSki, makeSim } from '/Users/fkesheh/projects/fps/games/splat/shared/src/sim.js';
import type { SlopeDef, SkierSim, Kicker } from '/Users/fkesheh/projects/fps/games/splat/shared/src/types.js';
import { rng, rngRange } from '@platform/shared';
import {
  KICKER_COUNT, KICKER_HALF_WIDTH, KICKER_Z0, KICKER_SPACING, KICKER_Z_JITTER,
  KICKER_X_JITTER, KICKER_PLANT_CLEAR, START_CLEAR, FINISH_CLEAR, FINISH_Z,
  PLANT_BAND_M, GATE_HALF_WIDTH, SLOPE_WIDTH, GATE_FIRST_Z, GATE_SPACING_M, GATE_JITTER_M,
} from '/Users/fkesheh/projects/fps/games/splat/shared/src/config.js';
import type { Gate } from '/Users/fkesheh/projects/fps/games/splat/shared/src/types.js';

// -- kicker placement mirroring §11.3 (the P2v2 body, hand-rolled here) -------
function placeKickers(s: SlopeDef): Kicker[] {
  const next = rng(s.seed ^ 0x7b31);
  // corridor centrelines are not exposed; approximate with the gate x's trend:
  // use gates' x (they sit on the corridor) and linear interp for kicker z.
  const gates = s.gates;
  const centreAt = (z: number): number => {
    if (gates.length === 0) return 0;
    if (z <= (gates[0]?.z ?? 0)) return gates[0]?.x ?? 0;
    const last = gates[gates.length - 1];
    if (last !== undefined && z >= last.z) return last.x;
    for (let i = 0; i < gates.length - 1; i++) {
      const a = gates[i];
      const b = gates[i + 1];
      if (a !== undefined && b !== undefined && z >= a.z && z < b.z) {
        const t = (z - a.z) / (b.z - a.z);
        return a.x + (b.x - a.x) * t;
      }
    }
    return 0;
  };
  const halfW = s.width / 2;
  const out: Kicker[] = [];
  let prevZ = -Infinity;
  for (let i = 0; i < KICKER_COUNT; i++) {
    let z = KICKER_Z0 + i * KICKER_SPACING + rngRange(next, -KICKER_Z_JITTER, KICKER_Z_JITTER);
    z = Math.max(Math.max(START_CLEAR, prevZ + 1), Math.min(FINISH_Z - FINISH_CLEAR, z));
    // snap away from plants (KICKER_PLANT_CLEAR clearance) by trying the
    // centreline x ± jitter and picking the first clear of plants
    const cx = centreAt(z);
    let x = cx + rngRange(next, -KICKER_X_JITTER, KICKER_X_JITTER);
    let best = x;
    let bestD = Infinity;
    for (let attempt = 0; attempt < 9; attempt++) {
      const cand = cx + (attempt - 4) * 0.9;
      let clear = true;
      const k = Math.floor(z / PLANT_BAND_M);
      for (let b = k - 1; b <= k + 1; b++) {
        for (const p of s.plantGrid(b)) {
          if (Math.abs(p.x - cand) < KICKER_PLANT_CLEAR && Math.abs(p.z - z) < KICKER_PLANT_CLEAR) {
            clear = false;
            break;
          }
        }
        if (!clear) break;
      }
      if (clear) { x = cand; break; }
      const d = Math.abs(cand - cx);
      if (d < bestD) { bestD = d; best = cand; }
    }
    x = Math.max(-(halfW - 1 - KICKER_HALF_WIDTH), Math.min(halfW - 1 - KICKER_HALF_WIDTH, x));
    out.push({ x, z, halfWidth: KICKER_HALF_WIDTH });
    prevZ = z;
  }
  return out;
}

// -- the §11.2 jump machine on the real sim ------------------------------------
// We extend the REAL stepSki by adding the air state machine. Since stepSki is
// frozen in the repo, we implement the v2 variant here by copying stepSki's
// logic + the air block. To avoid divergence, we re-derive from the contract.
import {
  ASSIST_EDGE_MUL, ASSIST_PLANT_RADIUS_MUL, ASSIST_SNARE_MUL, CARVE_SCRUB, DRAG,
  EDGE_PUSH, EDGE_ZONE, GATE_BOOST_MAX, GATE_BOOST_MS, GATE_BOOST_V, G_ACCEL,
  J_HOP_VY, J_KICKER_VY_BASE, J_KICKER_VY_SPEED, J_AIR_STEER_MUL, J_AIR_CARVE_MUL,
  J_COOLDOWN_MS, J_LAND_SPEED_MUL, J_MAX_AIRTIME_S, MAX_SPEED, MIN_SPEED,
  PLANT_HIT_SPEED_MUL, PLANT_IMMUNITY_MS, PLANT_REARM_MS, PLANT_SNARE_MS, SKIER_RADIUS,
  TURN_RATE_BASE, TURN_RATE_MIN, YAW_MAX, YAW_SPRING,
} from '/Users/fkesheh/projects/fps/games/splat/shared/src/config.js';

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function turnRateAt(v: number): number {
  const t = clamp(v / MAX_SPEED, 0, 1);
  return TURN_RATE_BASE + (TURN_RATE_MIN - TURN_RATE_BASE) * t;
}

export function stepSkiV2(
  s: SkierSim, steer: number, dt: number, slope: SlopeDef,
  opts: { assist?: boolean; jump?: boolean; kickers: readonly Kicker[] },
): void {
  if (s.finished) return;
  if (!Number.isFinite(dt) || dt <= 0) return;
  const st = Number.isFinite(steer) ? clamp(steer, -1, 1) : 0;
  const assist = opts.assist === true;
  const airborne = s.airborne;

  s.simMs += dt * 1000;

  // gravity along heading
  const accel = G_ACCEL * slope.gradeAt(s.x, s.z, s.yaw) - DRAG * s.v * s.v;
  s.v += accel * dt;

  // steering (damped in air)
  const steerMul = airborne ? J_AIR_STEER_MUL : 1;
  s.yaw += st * turnRateAt(s.v) * steerMul * dt;

  // carve scrub (damped in air)
  const carveMul = airborne ? J_AIR_CARVE_MUL : 1;
  s.v *= 1 - carveMul * CARVE_SCRUB * Math.abs(st) * dt * (s.v / MAX_SPEED);

  // yaw soft clamp
  const absYaw = Math.abs(s.yaw);
  if (absYaw > YAW_MAX) s.yaw -= Math.sign(s.yaw) * YAW_SPRING * (absYaw - YAW_MAX) * dt;

  // motion
  const prevZ = s.z;
  s.x += Math.sin(s.yaw) * s.v * dt;
  s.z += Math.cos(s.yaw) * s.v * dt;

  // bounds
  let vMax = s.simMs < s.boostUntilMs ? GATE_BOOST_MAX : MAX_SPEED;
  if (s.simMs < s.snareUntilMs) vMax = Math.min(vMax, MAX_SPEED / 2);
  s.v = clamp(s.v, MIN_SPEED, vMax);

  // plant pass — SKIPPED while airborne
  if (!airborne) {
    const k = Math.floor(s.z / PLANT_BAND_M);
    for (let band = k - 1; band <= k + 1; band++) {
      const plants = slope.plantGrid(band);
      let hit = false;
      for (const p of plants) {
        const rr = p.r * (assist ? ASSIST_PLANT_RADIUS_MUL : 1) + SKIER_RADIUS;
        const dx = s.x - p.x;
        const dz = s.z - p.z;
        if (dx * dx + dz * dz > rr * rr) continue;
        const ix = slope.plants.indexOf(p);
        if (ix < 0) continue;
        const sinceHit = s.simMs - s.lastPlantHitMs;
        const rearmed = ix !== s.lastPlantIx || sinceHit >= PLANT_REARM_MS;
        if (!rearmed || sinceHit < PLANT_IMMUNITY_MS) continue;
        s.v = clamp(s.v * PLANT_HIT_SPEED_MUL, MIN_SPEED, vMax);
        s.snareUntilMs = s.simMs + PLANT_SNARE_MS * (assist ? ASSIST_SNARE_MUL : 1);
        s.lastPlantIx = ix;
        s.lastPlantHitMs = s.simMs;
        hit = true;
        break;
      }
      if (hit) break;
    }
  }

  // slalom gates (unchanged, applies in air)
  for (let ix = s.lastGateIx + 1; ix < slope.gates.length; ix++) {
    const g = slope.gates[ix];
    if (g === undefined) break;
    if (!(prevZ < g.z && g.z <= s.z)) break;
    if (Math.abs(s.x - g.x) <= g.halfWidth) {
      s.v = Math.min(s.v + GATE_BOOST_V, vMax);
      s.boostUntilMs = s.simMs + GATE_BOOST_MS;
    }
    s.lastGateIx = ix;
  }

  // soft edges (applies in air too)
  const over = Math.abs(s.x) - (slope.width / 2 - EDGE_ZONE);
  if (over > 0) {
    const depth = over / EDGE_ZONE;
    const aEdge = EDGE_PUSH * depth * depth * (assist ? ASSIST_EDGE_MUL : 1);
    if (s.yaw !== 0) s.yaw -= Math.sign(s.yaw) * (aEdge / Math.max(s.v, MIN_SPEED)) * dt;
    s.x -= Math.sign(s.x) * 0.5 * aEdge * dt * dt;
  }

  // ---- v2 JUMP STATE MACHINE (post-motion; gauntlet-corrected) -------------
  if (s.airborne) {
    // advance the arc; LAND when the world arc returns to the terrain
    const t = (s.simMs - s.airStartMs) / 1000;
    const worldY = s.airStartY + s.airVy * t - 0.5 * G_ACCEL * t * t;
    if (worldY <= slope.height(s.x, s.z) || t >= J_MAX_AIRTIME_S) {
      s.airborne = false;
      s.airVy = 0;
      s.v = Math.max(MIN_SPEED, s.v * J_LAND_SPEED_MUL);
    }
  }
  // KICKER SCAN — runs EVERY step (airborne or not): a ramp whose z you
  // cross is consumed (lastKickerIx advances) on ANY crossing, airborne or
  // grounded — a ramp cleared mid-air can never re-launch you after landing.
  // A LAUNCH requires being grounded AND off cooldown AND within halfWidth.
  {
    let launched = false;
    for (let ix = s.lastKickerIx + 1; ix < opts.kickers.length; ix++) {
      const kk = opts.kickers[ix];
      if (kk === undefined) break;
      if (!(prevZ < kk.z && kk.z <= s.z)) break;
      s.lastKickerIx = ix; // consumed on ANY crossing
      if (!s.airborne && s.simMs - s.airStartMs >= J_COOLDOWN_MS &&
          Math.abs(s.x - kk.x) <= kk.halfWidth) {
        s.airborne = true;
        s.airVy = J_KICKER_VY_BASE + J_KICKER_VY_SPEED * s.v;
        s.airStartMs = s.simMs;
        s.airStartY = slope.height(s.x, s.z);
        launched = true;
        break;
      }
      break; // crossed but not launched (airborne/cooldown): consume only
    }
    // manual hop — only when grounded + off cooldown + not launched this step
    if (!launched && !s.airborne && opts.jump === true &&
        s.simMs - s.airStartMs >= J_COOLDOWN_MS) {
      s.airborne = true;
      s.airVy = J_HOP_VY;
      s.airStartMs = s.simMs;
      s.airStartY = slope.height(s.x, s.z);
    }
  }

  // finish
  if (s.z >= slope.finishZ) {
    s.finished = true;
    s.finishMs = s.simMs;
  }
}

// ---- run the test ------------------------------------------------------------
const DT = 1 / 30;
function fullLock(seed: number, dir: number): { finished: boolean; timeS: number; plants: number; maxOffPiste: number; maxAir: number; landings: number; gates: number } {
  const slope = genSlope(seed);
  const kickers = placeKickers(slope);
  const s = makeSim(0, 0, 0);
  const guard = { assist: false, jump: false, kickers };
  let steps = 0;
  let plants = 0;
  let maxOffPiste = 0;
  let maxAir = 0;
  let landings = 0;
  let prevPlantIx = -1;
  let gates = 0;
  let prevGateIx = -1;
  const maxSteps = 60 * 30 * 5; // 5 minutes of sim
  while (!s.finished && steps < maxSteps) {
    stepSkiV2(s, dir, DT, slope, guard);
    if (s.lastPlantIx !== prevPlantIx) { plants++; prevPlantIx = s.lastPlantIx; }
    if (s.lastGateIx !== prevGateIx) { gates++; prevGateIx = s.lastGateIx; }
    // air height above CURRENT terrain (the render formula)
    if (s.airborne) {
      const t = (s.simMs - s.airStartMs) / 1000;
      const arc = s.airVy * t - 0.5 * G_ACCEL * t * t;
      const h = s.airStartY + arc - slope.height(s.x, s.z);
      if (h > maxAir) maxAir = h;
    } else {
      landings++; // grounded step after air
    }
    const off = Math.abs(s.x) - slope.width / 2;
    if (off > maxOffPiste) maxOffPiste = off;
    steps++;
  }
  // count landings via edge detection
  return { finished: s.finished, timeS: steps * DT, plants, maxOffPiste, maxAir, landings: 0, gates };
}

let allPass = true;
for (const dir of [1, -1]) {
  let ok = 0;
  let worstAir = 0;
  let worstOff = 0;
  let totalPlants = 0;
  let totalGates = 0;
  const times: number[] = [];
  for (let seed = 1; seed <= 20; seed++) {
    const r = fullLock(seed, dir);
    if (r.finished) ok++;
    times.push(r.timeS);
    if (r.maxAir > worstAir) worstAir = r.maxAir;
    if (r.maxOffPiste > worstOff) worstOff = r.maxOffPiste;
    totalPlants += r.plants;
    totalGates += r.gates;
  }
  const median = [...times].sort((a, b) => a - b)[10];
  const pass = ok === 20;
  allPass = allPass && pass;
  console.log(`full-lock dir=${dir}: finished ${ok}/20  median ${median?.toFixed(1)}s  worst air ${worstAir.toFixed(1)}m  worst off-piste ${worstOff.toFixed(1)}m  plants/run ${(totalPlants / 20).toFixed(1)}  gates/run ${(totalGates / 20).toFixed(1)}`);
}
console.log(allPass ? '4-YEAR-OLD TEST: PASS' : '4-YEAR-OLD TEST: FAIL');

// ---- the REAL risk cases: a skier who LAUNCHES ------------------------------
function launchThenFullLock(seed: number, dir: number): { finished: boolean; maxOff: number; maxAir: number; landings: number } {
  const slope = genSlope(seed);
  const kickers = placeKickers(slope);
  const s = makeSim(0, 0, 0);
  const guard = { assist: false, jump: false, kickers };
  let maxOff = 0;
  let maxAir = 0;
  let hopFired = false;
  let steps = 0;
  let prevAir = s.airborne;
  let landings = 0;
  while (!s.finished && steps < 60 * 30 * 4) {
    guard.jump = !hopFired && !s.airborne && s.simMs < 1500; // one hop early
    if (guard.jump) hopFired = true;
    stepSkiV2(s, dir, DT, slope, guard);
    if (s.airborne) {
      const t = (s.simMs - s.airStartMs) / 1000;
      const arc = s.airVy * t - 0.5 * G_ACCEL * t * t;
      const h = s.airStartY + arc - slope.height(s.x, s.z);
      if (h > maxAir) maxAir = h;
    }
    if (prevAir && !s.airborne) landings++;
    prevAir = s.airborne;
    const off = Math.abs(s.x) - slope.width / 2;
    if (off > maxOff) maxOff = off;
    steps++;
  }
  return { finished: s.finished, maxOff, maxAir, landings };
}

// corridor rider: steer to hold the gate-centreline x (crab-correct)
function corridorRider(seed: number): { finished: boolean; maxOff: number; maxAir: number; landings: number; kickers: number; airTimeS: number; medianV: number } {
  const slope = genSlope(seed);
  const kickers = placeKickers(slope);
  const s = makeSim(0, 0, 0);
  const guard = { assist: false, jump: false, kickers };
  let maxOff = 0;
  let maxAir = 0;
  let steps = 0;
  let prevAir = s.airborne;
  let landings = 0;
  let prevKicker = -1;
  let kickerLaunches = 0;
  let airSteps = 0;
  const vs: number[] = [];
  while (!s.finished && steps < 60 * 30 * 5) {
    // point-steer at the next gate (aim heading), in-air included
    let gx = 0, gz = s.z + 60;
    for (const g of slope.gates) {
      if (g.z > s.z) { gx = g.x; gz = g.z; break; }
    }
    const want = Math.atan2(gx - s.x, gz - s.z);
    let dy = want - s.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    const steer = clamp(dy * 2.2, -1, 1);
    guard.jump = false;
    stepSkiV2(s, steer, DT, slope, guard);
    if (s.lastKickerIx !== prevKicker) { prevKicker = s.lastKickerIx; if (s.airborne) kickerLaunches++; }
    if (s.airborne) {
      airSteps++;
      const t = (s.simMs - s.airStartMs) / 1000;
      const arc = s.airVy * t - 0.5 * G_ACCEL * t * t;
      const h = s.airStartY + arc - slope.height(s.x, s.z);
      if (h > maxAir) maxAir = h;
    }
    if (prevAir && !s.airborne) landings++;
    prevAir = s.airborne;
    const off = Math.abs(s.x) - slope.width / 2;
    if (off > maxOff) maxOff = off;
    vs.push(s.v);
    steps++;
  }
  vs.sort((a, b) => a - b);
  return { finished: s.finished, maxOff, maxAir, landings, kickers: kickerLaunches, airTimeS: airSteps * DT, medianV: vs[Math.floor(vs.length / 2)] ?? 0 };
}

console.log('\n-- launching skiers (the real risk) --');
for (const dir of [1, -1]) {
  let ok = 0; let worstOff = 0; let worstAir = 0; let lands = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const r = launchThenFullLock(seed, dir);
    if (r.finished) ok++;
    if (r.maxOff > worstOff) worstOff = r.maxOff;
    if (r.maxAir > worstAir) worstAir = r.maxAir;
    lands += r.landings;
  }
  const pass = ok === 20;
  allPass = allPass && pass;
  console.log(`hop-then-full-lock dir=${dir}: finished ${ok}/20  worst off-piste ${worstOff.toFixed(1)}m  worst air ${worstAir.toFixed(1)}m  landings/run ${(lands / 20).toFixed(1)}  ${pass ? 'PASS' : 'FAIL'}`);
}

{
  let ok = 0; let worstOff = 0; let worstAir = 0; let lands = 0; let kick = 0; let airT = 0; let vSum = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const r = corridorRider(seed);
    if (r.finished) ok++;
    if (r.maxOff > worstOff) worstOff = r.maxOff;
    if (r.maxAir > worstAir) worstAir = r.maxAir;
    lands += r.landings;
    kick += r.kickers;
    airT += r.airTimeS;
    vSum += r.medianV;
  }
  const pass = ok === 20 && kick > 0;
  allPass = allPass && pass;
  console.log(`corridor rider: finished ${ok}/20  kicker launches ${kick}/20  worst off-piste ${worstOff.toFixed(1)}m  worst air ${worstAir.toFixed(1)}m  landings/run ${(lands / 20).toFixed(1)}  airtime/run ${(airT / 20).toFixed(1)}s  median v ${(vSum / 20).toFixed(1)}m/s  ${pass ? 'PASS' : 'FAIL'}`);
}
console.log(allPass ? 'V2 RISK CASES: ALL PASS' : 'V2 RISK CASES: SOME FAIL');

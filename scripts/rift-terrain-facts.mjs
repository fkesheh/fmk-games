// ============================================================================
// rift-terrain-facts — the ONE terrain-model loader and camera-target
// derivation shared by verify-rift.mjs, capture-rift-art.mjs and e2e-rift.mjs.
//
// WHY THIS FILE EXISTS. The same ~75-line `terrainFacts()` used to be pasted
// into two harnesses and had already started to diverge (one read `side` off
// the grid, the other compared it against a hand-typed MAP_SIDE). Two copies of
// a derivation is one copy plus a latent lie, and the camp stand-off distance
// had drifted in THREE places at once. There is now exactly one definition of
// each.
//
// LOADING IS LAZY AND EXPLICIT. `loadTerrain()` is an async function, not a
// module-scope side effect. Both the Node-version check and the type-stripped
// `import()` of terrain.ts can throw — on Node < 22.15 (no module.registerHooks)
// or on any TypeScript construct the native stripper rejects — and at module
// scope those throws killed the harness BEFORE its try/catch existed, so it
// died without printing the JSON manifest its consumers are contractually
// promised. Every caller now invokes this from inside its own fatal handler.
//
// TERRAIN_CONTRACT §1: terrain never goes on the wire and is a PURE function of
// the lane count, so a harness can rebuild it in-process and aim cameras at
// real cliff/river/foliage/camp cells instead of at coordinates typed off a
// screenshot, which would rot silently the first time the generator is tuned.
// ============================================================================
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TERRAIN_SRC = path.join(ROOT, 'games/rift/shared/src/terrain.ts');
const CONFIG_SRC = path.join(ROOT, 'games/rift/shared/src/config.ts');

let hooksRegistered = false;
let terrainModule = null;
let configModule = null;

/**
 * The `@rift/shared` terrain module, loaded straight from TypeScript source.
 *
 * shared/src/*.ts import each other with NodeNext '.js' specifiers that only
 * the TypeScript resolver rewrites; node's own resolver needs the hook below.
 * Type stripping itself is native (Node >= 22.6); `module.registerHooks` is
 * Node >= 22.15.
 *
 * Memoised, and safe to call again after a failure: the resolve hook is
 * registered at most once per process.
 */
export async function loadTerrain() {
  registerTsHooks();
  if (terrainModule !== null) return terrainModule;
  terrainModule = await import(pathToFileURL(TERRAIN_SRC).href);
  return terrainModule;
}

/**
 * `@rift/shared`'s `config.ts`, loaded the same way.
 *
 * Every balance constant a harness reasons about — HERO_VISION, AGGRO_RADIUS,
 * NIGHT_VISION_MULT, `nightVisionScale` — is exported from here, so there is no
 * excuse for a harness to carry its own copy of one. It used to, and the copies
 * were what let the camp stand-off rot: the number in the harness stayed at a
 * day-vision derivation long after the night ramp existed.
 */
export async function loadConfig() {
  registerTsHooks();
  if (configModule !== null) return configModule;
  configModule = await import(pathToFileURL(CONFIG_SRC).href);
  return configModule;
}

function registerTsHooks() {
  if (typeof registerHooks !== 'function') {
    throw new Error(
      `node ${process.version} has no module.registerHooks — the rift harnesses need Node >= 22.15 to read the shared model`,
    );
  }
  if (!hooksRegistered) {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier.endsWith('.js') && context.parentURL !== undefined && context.parentURL.endsWith('.ts')) {
          const asTs = `${new URL(specifier, context.parentURL).href.slice(0, -3)}.ts`;
          if (existsSync(fileURLToPath(asTs))) return nextResolve(asTs, context);
        }
        return nextResolve(specifier, context);
      },
    });
    hooksRegistered = true;
  }
}

// ---- the camp stand-off band (AMENDMENT_1 §C) --------------------------------
// The constant that governs whether a camp pulls a loitering hero is
// AGGRO_RADIUS (7), NOT CAMP_LEASH_RADIUS (10) — the leash is the cap on how
// far an ALREADY-AGGROED member may be dragged, and quoting it here was the
// bug.
//
// WHAT REPLACED 10.5, AND WHY. The old constant was 10.5 m with the note "1.5 m
// outside the furthest member's pull, 0.5 m inside hero vision". Both halves of
// that were derived against DAY vision only, and the second half is what broke:
// `HERO_VISION` is 11 at dayPhase 0 but `nightVisionScale` ramps it smoothly to
// `HERO_VISION * NIGHT_VISION_MULT` = 8.25 at full night (config.ts). At 10.5 m
// the nearest member sits ~8.9 m out, so the camp stops being visible at
// dayPhase ≈ 0.79 — and `DAY_PERIOD_S` is 600 game-seconds, which at the
// harnesses' speed 5 is a 120-second WALL cycle that a camp shot lands anywhere
// inside. That is why `camp-brute` failed intermittently rather than always.
//
// The offsets are exact, not approximate. `server/src/sim/camps.ts` rests each
// member on a spoke of a ring of radius POST_RING_R = 1.6 m about the clearing
// centre (`postX`/`postZ`, eight fixed compass directions) — the "~2 m" that
// config.ts's CAMP_LANE_CLEARANCE derivation quotes is a rounded-up bound on
// that same 1.6. So for a hero standing D metres from the centre:
//
//   nearest member  >= D - CAMP_POST_RING_R      (a member on the hero's side)
//   nearest member  <= D + CAMP_POST_RING_R      (a member diametrically away)
//
//   aggro floor       D - 1.6 >  AGGRO_RADIUS 7            ->  D >  8.6
//   night visibility  D - 1.6 <= HERO_VISION * 0.75 = 8.25 ->  D <= 9.85
//
// so the band is (8.6, 9.85]. CAMP_STAND_MIN_M takes 9.0 rather than 8.61: the
// extra 0.4 m absorbs the cell-centre snap and the pose tolerance, both of
// which can only move the hero by a fraction of a metre once `campStand` has
// picked a cell that is already inside the band.
//
// Both bounds are re-derived from the live constants by `assertCampBand`
// below, so this comment cannot drift away from the numbers again.
//
// BE HONEST ABOUT THE CEILING. `D - 1.6` is the OPTIMISTIC bound — it holds
// only when a member happens to sit on the hero's side of the ring. Three brute
// members occupy three of eight spokes, so the nearest one can be up to 67.5°
// off the approach bearing and then sits ~0.5 m further out than the bound.
// A band that survived the true worst case (`D + 1.6 <= 8.25`) would need
// D <= 6.65, which is inside the camp's aggro reach: there is NO stand-off
// distance that is both aggro-safe and guaranteed-visible at full night. That
// is a real property of the tuning, not a harness defect, and it is why a camp
// shot must ALSO pin the phase it is taken at rather than rely on this band
// alone — see `capture-rift-art.mjs`'s dayPhase gate.
export const CAMP_STAND_MIN_M = 9.0;
export const CAMP_STAND_MAX_M = 9.85;
/**
 * The ring radius `camps.ts` rests members on (`POST_RING_R`). Private to the
 * server module, so it is quoted here rather than imported — the ONE constant
 * in this derivation that cannot be read from the source of truth.
 *
 * It describes the camp AT REST, and only at rest. A member that has acquired
 * anything is free to range out to CAMP_LEASH_RADIUS (10) and back, so a
 * harness must NOT turn this into a runtime assertion on observed member
 * positions. Two attempts at that both failed good frames: one on a camp a
 * passing lane creep had legitimately pulled 3.6 m off its posts, the next on a
 * member that had drifted to the far side of the clearing and so read 11.04 m
 * from a hero with an 11.00 m vision radius.
 *
 * What the harnesses assert at runtime instead are the two properties this band
 * exists to produce, both read off the live snapshot and neither needing this
 * number: the CLEARING CENTRE is inside the hero's own vision, and no member has
 * reached the hero. Those are properties of the stand-off point and the day
 * phase — things the harness controls — rather than of where a given member
 * happens to be standing. See `assertCampStandOff` in the capture harness.
 */
export const CAMP_POST_RING_R = 1.6;

/**
 * Re-derive the band from the LIVE shared constants and throw if the two
 * numbers above are no longer what those constants imply.
 *
 * This is the guard that the original 10.5 m lacked. That value was correct
 * when it was written and silently stopped being correct when the night vision
 * ramp arrived; nothing recomputed it, so it rotted in place for as long as the
 * shot happened to be taken by daylight. Now a balance edit to AGGRO_RADIUS,
 * HERO_VISION or NIGHT_VISION_MULT fails every harness that reads this module,
 * at load, with the arithmetic printed.
 *
 * @param {object} CONFIG the namespace returned by `loadConfig()`
 */
export function assertCampBand(CONFIG) {
  const { AGGRO_RADIUS, HERO_VISION, NIGHT_VISION_MULT } = CONFIG;
  for (const [name, v] of [['AGGRO_RADIUS', AGGRO_RADIUS], ['HERO_VISION', HERO_VISION], ['NIGHT_VISION_MULT', NIGHT_VISION_MULT]]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`shared config no longer exports a numeric ${name} — the camp stand-off band cannot be re-derived`);
    }
  }
  const floor = AGGRO_RADIUS + CAMP_POST_RING_R;
  const ceiling = HERO_VISION * NIGHT_VISION_MULT + CAMP_POST_RING_R;
  if (!(CAMP_STAND_MIN_M > floor)) {
    throw new Error(
      `CAMP_STAND_MIN_M ${CAMP_STAND_MIN_M} is no longer outside camp aggro: AGGRO_RADIUS ${AGGRO_RADIUS} + ` +
        `POST_RING_R ${CAMP_POST_RING_R} = ${floor.toFixed(2)}m`,
    );
  }
  if (!(CAMP_STAND_MAX_M <= ceiling)) {
    throw new Error(
      `CAMP_STAND_MAX_M ${CAMP_STAND_MAX_M} is no longer inside night vision: HERO_VISION ${HERO_VISION} * ` +
        `NIGHT_VISION_MULT ${NIGHT_VISION_MULT} + POST_RING_R ${CAMP_POST_RING_R} = ${ceiling.toFixed(2)}m`,
    );
  }
  if (!(CAMP_STAND_MIN_M < CAMP_STAND_MAX_M)) {
    throw new Error(`the camp stand-off band is empty: [${CAMP_STAND_MIN_M}, ${CAMP_STAND_MAX_M}]`);
  }
}
/** A live neutral this close to a clearing centre IS that camp. Deliberately
 *  wider than the leash radius: a member mid-leash is still that camp. */
export const CAMP_VISIBLE_M = 14;

/** A 'foliage' cell this close to a 'lane' cell IS the jungle wall the
 *  jungle-wall shot exists to photograph. */
const JUNGLE_WALL_LANE_M = 3;

/**
 * Every derived camera target for the frozen judge shot list, plus the camp
 * list, a passability probe and the camp stand-off derivation. Pure: same lane
 * count in, same cells out, on every machine.
 *
 * Selection rules (all deterministic, all scored against the map centre so the
 * pick is unique):
 *   river  the 'river' cell nearest the map centre. The band runs the
 *          anti-diagonal through the centre, so this IS the landmark players
 *          mean by "mid river" (DESIGN_DELTA §4).
 *   cliff  the 'cliff' cell nearest the map centre that borders BOTH a
 *          high/base cell and a low passable one — a cliff face with the
 *          plateau above it and walkable ground below, which is the frame
 *          GRAPHICS_CONTRACT §5 asks for.
 *   wall   the 'foliage' cell nearest the map centre lying within
 *          JUNGLE_WALL_LANE_M of a 'lane' cell, so the frame straddles the
 *          boundary the tree wall is supposed to draw.
 *   brute  the 'brute' camp in half 0 — a CampDef straight from the model.
 *
 * Half 0 is `x + z < side`: mirror symmetry is point reflection through the
 * centre (TERRAIN_CONTRACT §3), so the anti-diagonal is the halves' boundary.
 * Callers mirror to (side - x, side - z) when the human is seated on team 1.
 *
 * @param {object} TERRAIN the namespace returned by `loadTerrain()`
 * @param {number} lanes
 */
export function terrainFacts(TERRAIN, lanes) {
  const t = TERRAIN.buildTerrain(lanes);
  const g = t.grid;
  const { dim, side } = g;
  const kinds = TERRAIN.TERRAIN_KINDS;
  const kindAt = (cx, cz) => kinds[g.kind[cz * dim + cx] ?? 0] ?? 'ground';
  const inHalf0 = (x, z) => x + z < side;
  const c = side / 2;
  const d2c = (x, z) => Math.hypot(x - c, z - c);

  let river = null;
  let cliff = null;
  let wall = null;
  for (let cz = 0; cz < dim; cz++) {
    for (let cx = 0; cx < dim; cx++) {
      const x = cx + 0.5;
      const z = cz + 0.5;
      const k = kindAt(cx, cz);
      if (k === 'river' && (river === null || d2c(x, z) < d2c(river.x, river.z))) river = { x, z };
      if (!inHalf0(x, z)) continue;
      if (k === 'cliff' && cx > 0 && cz > 0 && cx < dim - 1 && cz < dim - 1) {
        let above = 0;
        let below = 0;
        for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nk = kindAt(cx + ox, cz + oz);
          if (nk === 'high' || nk === 'base') above++;
          else if (nk !== 'cliff') below++;
        }
        if (above > 0 && below > 0 && (cliff === null || d2c(x, z) < d2c(cliff.x, cliff.z))) cliff = { x, z };
      }
      if (k === 'foliage' && (wall === null || d2c(x, z) < d2c(wall.x, wall.z))) {
        let lane = null;
        const r = JUNGLE_WALL_LANE_M;
        for (let oz = -r; oz <= r; oz++) {
          for (let ox = -r; ox <= r; ox++) {
            const nx = cx + ox;
            const nz = cz + oz;
            if (nx < 0 || nz < 0 || nx >= dim || nz >= dim) continue;
            if (kindAt(nx, nz) !== 'lane') continue;
            const d = Math.hypot(ox, oz);
            if (d <= r && (lane === null || d < lane.d)) lane = { x: nx + 0.5, z: nz + 0.5, d };
          }
        }
        // Aim at the FOLIAGE CELL, not at the midpoint between it and the lane:
        // a cell centre is a real terrain fact that mirrors exactly
        // (TERRAIN_CONTRACT §3.1), while a midpoint sits ON the boundary and can
        // land a cell either side of it once mirrored. The lane is within
        // JUNGLE_WALL_LANE_M, so both sides of the wall are in frame anyway.
        if (lane !== null) wall = { x, z };
      }
    }
  }
  const brute = t.camps.find((cd) => cd.tier === 'brute' && cd.half === 0) ?? null;

  /** Nearest passable cell centre to (x,z). A hero cannot stand on a cliff, and
   *  every terrain target above is chosen for what it LOOKS like, not for
   *  whether a hero can occupy it. */
  const nearestPassable = (x, z) => {
    for (let r = 0; r < 24; r++) {
      let best = null;
      for (let oz = -r; oz <= r; oz++) {
        for (let ox = -r; ox <= r; ox++) {
          if (Math.max(Math.abs(ox), Math.abs(oz)) !== r) continue;
          const px = Math.floor(x) + ox + 0.5;
          const pz = Math.floor(z) + oz + 0.5;
          if (px < 0.5 || pz < 0.5 || px > side - 0.5 || pz > side - 0.5) continue;
          if (!TERRAIN.isPassable(t, px, pz)) continue;
          const d = Math.hypot(px - x, pz - z);
          if (best === null || d < best.d) best = { x: px, z: pz, d };
        }
      }
      if (best !== null) return { x: best.x, z: best.z };
    }
    return { x, z };
  };

  /**
   * Where a hero stands to photograph — or merely to observe — the camp whose
   * clearing centre is (cx, cz), approaching from the direction of
   * (towardX, towardZ) (every harness approaches from the map-centre side).
   *
   * Returns a PASSABLE cell centre whose distance from the clearing centre lies
   * inside [CAMP_STAND_MIN_M, CAMP_STAND_MAX_M], or null when the terrain
   * offers none.
   *
   * WHY THIS IS NOT "walk out CAMP_APPROACH_M, then snap to the nearest
   * passable cell". That was the old recipe and it is unsound: the snap is free
   * to move the point in ANY direction, including inward, so the distance it
   * actually produces is not the distance that was derived. The band above is
   * 0.85 m wide and a cell-centre snap can be 0.7 m — the snap could and did
   * spend the whole margin. Here the band is the CONSTRAINT and the ideal point
   * is only the tie-break, so whatever comes back is inside the band by
   * construction.
   *
   * Cells are scored RADIALLY first — how close their distance from the centre
   * is to the middle of the band — and only then by how near they sit to the
   * approach bearing. Scoring on plain distance-to-the-ideal-point instead puts
   * the winner hard against whichever end of the band the bearing happens to
   * point at (measured: d = 9.849 against a 9.85 ceiling), which spends the
   * entire pose-tolerance margin before the hero has taken a step. A few
   * degrees off the bearing costs nothing; a few centimetres of band do.
   *
   * Deterministic: cells are visited in a fixed order and every comparison is a
   * total order. Same terrain in, same cell out, on every machine.
   */
  const campStand = (cx, cz, towardX, towardZ) => {
    const dx = towardX - cx;
    const dz = towardZ - cz;
    const dl = Math.hypot(dx, dz) || 1;
    const mid = (CAMP_STAND_MIN_M + CAMP_STAND_MAX_M) / 2;
    const idealX = cx + (dx / dl) * mid;
    const idealZ = cz + (dz / dl) * mid;
    const reach = Math.ceil(CAMP_STAND_MAX_M) + 2;
    let best = null;
    for (let oz = -reach; oz <= reach; oz++) {
      for (let ox = -reach; ox <= reach; ox++) {
        const px = Math.floor(cx) + ox + 0.5;
        const pz = Math.floor(cz) + oz + 0.5;
        if (px < 0.5 || pz < 0.5 || px > side - 0.5 || pz > side - 0.5) continue;
        const d = Math.hypot(px - cx, pz - cz);
        if (d < CAMP_STAND_MIN_M || d > CAMP_STAND_MAX_M) continue;
        if (!TERRAIN.isPassable(t, px, pz)) continue;
        const radial = Math.abs(d - mid);
        const bearing = Math.hypot(px - idealX, pz - idealZ);
        const better =
          best === null || radial < best.radial - 1e-9 || (radial < best.radial + 1e-9 && bearing < best.bearing - 1e-9);
        if (better) best = { x: px, z: pz, d, radial, bearing };
      }
    }
    return best === null ? null : { x: best.x, z: best.z, d: best.d };
  };

  return { lanes, side, dim, river, cliff, wall, brute, camps: t.camps, nearestPassable, campStand };
}

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

let hooksRegistered = false;
let terrainModule = null;

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
  if (terrainModule !== null) return terrainModule;
  if (typeof registerHooks !== 'function') {
    throw new Error(
      `node ${process.version} has no module.registerHooks — the rift harnesses need Node >= 22.15 to read the shared terrain model`,
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
  terrainModule = await import(pathToFileURL(TERRAIN_SRC).href);
  return terrainModule;
}

// ---- the camp stand-off band (AMENDMENT_1 §C) --------------------------------
// The constant that governs whether a camp pulls a loitering hero is
// AGGRO_RADIUS (7), NOT CAMP_LEASH_RADIUS (10) — the leash is the cap on how
// far an ALREADY-AGGROED member may be dragged, and quoting it here was the
// bug. config.ts's CAMP_LANE_CLEARANCE derivation states that a resting member
// sits within ~2 m of the clearing centre, so the camp's acquisition reach
// measured FROM THE CENTRE is 7 + 2 = ~9 m. HERO_VISION is 11, and a shot of a
// camp needs the camp revealed, so the usable band is ~9.5 m .. 11 m.
//
// 10.5 m sits in the middle of it: 1.5 m outside the furthest member's pull,
// 0.5 m inside hero vision. Every harness approaches from the map-centre side,
// so a hero that stops short of its stand-off point stops FURTHER from the
// camp, never nearer — the pose tolerance can only make this safer.
export const CAMP_APPROACH_M = 10.5;
/** A live neutral this close to a clearing centre IS that camp. Deliberately
 *  wider than the leash radius: a member mid-leash is still that camp. */
export const CAMP_VISIBLE_M = 14;

/** A 'foliage' cell this close to a 'lane' cell IS the jungle wall the
 *  jungle-wall shot exists to photograph. */
const JUNGLE_WALL_LANE_M = 3;

/**
 * Every derived camera target for the frozen judge shot list, plus the camp
 * list and a passability probe. Pure: same lane count in, same cells out, on
 * every machine.
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

  return { lanes, side, dim, river, cliff, wall, brute, camps: t.camps, nearestPassable };
}

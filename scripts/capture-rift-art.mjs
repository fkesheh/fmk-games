#!/usr/bin/env node
// ============================================================================
// capture-rift-art — ART-DIRECTION SHOT MATRIX for ANCIENTS (rift).
//
// Sibling of verify-rift.mjs (same machinery: built-platform child process on
// its own port, production-mount guard, puppeteer + swiftshader fallback,
// minimap pan + wheel zoom). Where verify-rift proves the client is HEALTHY
// across viewports, this one drives ONE 1920x1080 client into a fixed matrix
// of art-direction states and writes exactly one PNG per state, so a
// screenshot -> art-director-judge -> fix loop can compare rounds pixel for
// pixel.
//
// THE MATRIX (24 shots, `<out>/<name>.png`):
//   wide-mid / wide-base-own / wide-base-enemy   camH 55 (fully out)
//   mid-lane                                     camH ~35, live creep clash
//   close-hero / close-creeps / close-tower /
//   close-ancient / close-deco / camp-brute      camH 11 (fully in, STYLE_BIBLE §5)
//   high-ground / jungle-wall                    camH ~24 (GRAPHICS_CONTRACT §5)
//   river-mid                                    camH ~35
//   fx-cast / fx-combat / fog-edge               camH ~35
//   hud-live / ui-shop / ui-scoreboard           camH ~35, HUD/overlay state
//   ui-menu / ui-lobby                           pre-match DOM screens
//   night-mid-lane / night-close-hero /
//   night-wide-mid                               the day framings at dayPhase 1
//
// The last eleven names are GRAPHICS_CONTRACT §5's frozen judge shot list for
// the terrain pass: the judge must photograph the features this build exists
// to add, or the loop grades a world it cannot see.
//
// DETERMINISM (the judge diffs successive rounds — framing MUST NOT drift):
//   * no Math.random anywhere;
//   * the room is a fixed private room, teamSize 5 -> LANES_FOR_TEAM_SIZE[5]
//     = 3 lanes -> side 128 (config.ts), speed 5. `lanes === 3` is ASSERTED
//     off the rift_begin frame; a 1-lane test map fails the run;
//   * every camera target is a MAP FACT (map centre, an Ancient, a tower read
//     out of the snapshot — buildMap() is pure), a TERRAIN FACT (a cliff edge,
//     a river cell, a lane-adjacent foliage clump or a camp clearing, read out
//     of buildTerrain(lanes) IN THIS PROCESS — terrain is a pure function of
//     the lane count, TERRAIN_CONTRACT §1) or a fixed fraction along the
//     own->enemy diagonal — each mirrored through the map centre for team 1,
//     so the same frames come back whichever side the human is seated on;
//   * zoom is driven to a CLAMP (15 wheel notches at 1.12/notch overshoots the
//     11..55 range) and then stepped back a fixed count — never relative to an
//     unknown current height;
//   * the RENDERER's dayPhase is PINNED before every in-world shot through
//     window.__rift.setDayPhase — 0 for the day matrix, 1 for the night trio.
//     Without this the lighting depends on how long the match happened to have
//     been running and no two judge rounds are comparable (GRAPHICS_CONTRACT
//     §5). A missing setDayPhase fails the shot; it never captures anyway.
//   * ...and the SERVER's dayPhase is a SEPARATE thing that the renderer pin
//     does not touch: it scales every vision radius (config.ts
//     `nightVisionScale`), and a hero's vision disc is the only thing lighting
//     an off-lane frame. DAY_PERIOD_S 600 at speed 5 is a 120-second WALL
//     cycle, so any vision-dependent shot waits for a fixed point in it
//     (`waitDayPhaseBelow`) instead of taking whatever the clock offers;
//   * shots that need a hero in frame POSE the hero first: order it to the
//     fixed point and poll until it stands there, then aim the camera at the
//     POINT, not at the hero;
//   * and NOTHING above is trusted to have worked. Before every in-world
//     shutter the camera's aim and height are MEASURED back out of the scene's
//     own raycast (window.__rift.screenToGround) and compared against what the
//     shot asked for, and the hero shots additionally require the hero to be
//     inside that measured footprint. AMENDMENT_6: a harness that reports the
//     arithmetic it intended instead of the state it produced is not a gate.
//     This is not hypothetical — `panTo` ignored the minimap's 180° rotation
//     and aimed every shot at the point-reflection of its target for an entire
//     judge round, and `close-hero` shipped a frame with no hero in it;
//   * every gameplay wait polls the real condition (opposing creeps in
//     contact, units swinging, the cast event landing, neutrals visible in the
//     camp clearing) with a timeout — the only fixed sleeps are the
//     post-condition settles that land animations in the same phase each round.
//
// CAPTURE LIVENESS (GRAPHICS_CONTRACT §5, a measured defect): before EVERY
// in-world shot the flow asserts the client phase is 'live', the local hero is
// alive and no full-screen overlay is painted; after the shot it measures the
// saved PNG's mean and standard deviation of luminance and fails the shot if
// either collapses. A baseline `wide-mid` was once captured through the
// death-screen dim and graded as art. Night shots get their own (lower) mean
// floor — night is authored dark on purpose.
//
// SUBPROCESS DISCIPLINE: the platform server is the only child process and it
// is never judged by its piped output — its exit code and signal are recorded
// on the 'exit' event, and an unrequested death fails the run. A dead server
// leaves every page rendering its last snapshot: big, pretty, frozen frames.
//
// One failed shot never aborts the run: it is recorded {ok:false, error} and
// the flow continues. The LAST stdout line is the JSON manifest
//   { ok, outDir, worstDrawCalls, worstTriangles, pageErrors,
//     shots:[{name,file,bytes,drawCalls,triangles,frameMean,frameStdDev,
//     night,ok,error}] }
// and everything human goes to stderr. Exit 0 only when every requested shot
// landed and the page logged zero errors.
//
// Flags: --out <dir> (default judge/captures), --only <name-prefix>,
//        --keep-server. Env: RIFT_ART_PORT (default 8093),
//        E2E_PROTOCOL_TIMEOUT (default 300000).
// The client dist must already exist — this harness NEVER builds. It does,
// however, refuse to run against a dist that is OLDER than its own sources
// (`assertBundleFresh`) and against a server bundle that does not contain the
// protocol vocabulary this matrix depends on (`assertServerBundleCarries`).
// See the STALE DIST section below for why existence was never enough.
// ============================================================================
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import {
  assertCampBand,
  CAMP_STAND_MAX_M,
  CAMP_STAND_MIN_M,
  CAMP_VISIBLE_M,
  loadConfig,
  loadTerrain,
  terrainFacts,
} from './rift-terrain-facts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.RIFT_ART_PORT ?? 8093); // 8080 dev / 8091 e2e / 8092 verify
const BASE = `http://localhost:${PORT}`;
const SERVER_ENTRY = path.join(ROOT, 'platform/server/dist/server.js');
const CLIENT_ENTRY = path.join(ROOT, 'games/rift/client/dist/index.html');

// ---- CLI -------------------------------------------------------------------------
function argValue(flag) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
const OUT_DIR = path.resolve(ROOT, argValue('--out') ?? 'judge/captures');
const ONLY = argValue('--only');
const KEEP_SERVER = process.argv.slice(2).includes('--keep-server');

// ---- the matrix, in capture order --------------------------------------------------
// Order is dictated by two one-way doors:
//   * fog is PERSISTENT, so anything that reveals ground must come after the
//     shots that want shroud (fog-edge before the off-lane deco pose) and
//     before the shots that want a lit map (the enemy-base scouting run
//     immediately before the wide trio);
//   * the room is a wasting asset — a long match, a dropped socket or an
//     ended phase kills everything downstream — so the cheap, always-available
//     shots are taken FIRST and the expensive walking is deferred to the end.
// The terrain shots (river-mid, camp-brute, high-ground, jungle-wall) sit
// AFTER fog-edge — each poses the hero off-lane and permanently reveals the
// ground it stands on — and BEFORE the enemy-base scouting run, which is the
// point of no return for the fog state.
// The night trio comes LAST: it reuses framings the day matrix has already
// graded, so a judge can diff day against night with nothing else changed, and
// by then the fog state cannot get any worse.
const SHOT_ORDER = [
  'ui-menu',
  'ui-lobby',
  'hud-live',
  'ui-shop',
  'ui-scoreboard',
  'mid-lane',
  'close-creeps',
  'fx-combat',
  'fog-edge',
  'close-tower',
  'close-ancient',
  'close-hero',
  'fx-cast',
  'close-deco',
  'river-mid',
  'camp-brute',
  'high-ground',
  'jungle-wall',
  'wide-mid',
  'wide-base-own',
  'wide-base-enemy',
  'night-mid-lane',
  'night-close-hero',
  'night-wide-mid',
];
/** Shots taken at dayPhase 1 — a lower frame-luminance floor applies. */
const NIGHT_SHOTS = new Set(['night-mid-lane', 'night-close-hero', 'night-wide-mid']);
/** Shots that photograph the world rather than a DOM screen: these get the
 *  §5 capture-liveness gate and the frame-luminance floors. */
const DOM_ONLY_SHOTS = new Set(['ui-menu', 'ui-lobby']);

// ---- room / map facts ----------------------------------------------------------------
// config.ts: LANES_FOR_TEAM_SIZE = [0,0,1,2,2,3,3,3,3] -> teamSize 5 is the
// smallest team size that compiles the REAL 3-lane map; side =
// MAP_SIDE_BASE(96) + MAP_SIDE_PER_LANE(16) * (3-1) = 128.
//
// speed 5 matches verify-rift's per-viewport flow: the first creep wave
// spawns at 10 game-seconds (2s wall), waves keep coming every 6s wall, and a
// 20-minute match still outlasts this run several times over. It is only
// affordable on a GPU backend — see GL_LADDER: on SwiftShader this same room
// starved the socket and the server terminated it mid-match.
const ROOM_SETTINGS = { teamSize: 5, speed: 5 };
const WANT_LANES = 3;
const MAP_SIDE = 128;
const BASE_INSET = 11; // config.ts — Ancient inset from its corner
const HERO_PICK = 'longbow'; // longbow_q 'Piercing Arrow': point-target, range 14, 55 mana
const CAST_SLOT = 0;

// EVERY shot is 1920x1080 — but the match is DRIVEN at a quarter of that.
// Measured: a 1080p swiftshader client blocks its renderer for seconds per
// frame under this 60-entity match; Chrome then stops draining the WebSocket
// data pipe, the server's protocol pings go unanswered and MAX_MISSED_PONGS
// (2 pings, 4s) terminates the socket — the private room closes as empty and
// every later frame is a frozen last-snapshot render. WORK_VIEWPORT has the
// SAME 16:9 aspect, so the perspective camera frames exactly the same ground
// rectangle; only the pixel count (and with it the render cost) changes, and
// the page is resized up for the screenshot itself.
const SHOT_VIEWPORT = { width: 1920, height: 1080 };
const WORK_VIEWPORT = { width: 960, height: 540 };
const MIN_PNG_BYTES = 5000;

// GRAPHICS_CONTRACT §5. verify-rift.mjs owns the GATE and measures it in a
// 3-lane 8v8 room, which is where §5 specifies the budgets. This matrix runs
// 5v5 for a shorter, more survivable art round, so its numbers UNDER-measure
// the peak: an overrun here is real and fails the round, but staying under
// these limits here proves nothing about the gate.
const DRAW_CALL_BUDGET = 700;
const TRIANGLE_BUDGET = 1_200_000;

// ---- camera ------------------------------------------------------------------------
// input.ts ZOOM_STEP = 1.12/notch; game.ts clamps camH to [CAM_MIN_H 11,
// CAM_MAX_H 55], default 36. STYLE_BIBLE §5 moved the lower clamp 18 -> 11
// (a hero is ~40 px of a 1080p frame at camH 18, at which size §7's hero
// silhouettes are unreadable), and that move invalidated the step counts here.
//
// The clamp-driving trick only works if the notch count OVERSHOOTS the whole
// range: 55 / 11 = 5.0x, and 1.12^n must exceed it.
//   12 notches = 3.896x  ->  55 / 3.896 = 14.12 m. NOT the clamp. Every "close"
//                            shot in the matrix was sitting at 14.12 m — a
//                            height nobody specified, neither the old 18 nor
//                            the measured 11 — and `zoomTo('in')` was silently
//                            a relative zoom, the one thing it exists to avoid.
//   15 notches = 5.474x  ->  55 / 5.474 = 10.05 m, under 11, so it CLAMPS. ✓
//                            and 11 * 5.474 = 60.2 m, over 55, so the outward
//                            leg still clamps too. ✓
const ZOOM_CLAMP_STEPS = 15;
const ZOOM_DEFAULT_STEPS = 4; // 55 / 1.12^4 = 34.96 m ~= the 36 default
// GRAPHICS_CONTRACT §5 asks for camH 24 on `high-ground` / `jungle-wall`. The
// wheel is multiplicative, so 24 is not exactly reachable; the nearest rung
// above the 11 m clamp is 11 * 1.12^7 = 24.32 m. (Against the old 18 m clamp
// the same shot used 3 notches; carried over unchanged onto a 14.12 m base it
// was producing 19.84 m, five metres under what §5 asked for.)
const ZOOM_CAM24_STEPS = 7;
/** What each rung is worth in metres, for the measured read-back below. */
const ZOOM_RUNG_M = { out: 55, default: 34.96, cam24: 24.32, in: 11 };
// The ABSOLUTE read-back tolerance. `camH` is derived from the ground footprint
// the engine's own raycast reports (see `measureCamera`). That is exact on flat
// ground, but `screenToGround` resolves against the real height field: ground
// beside the target that sits Δ metres higher pulls the probe in by ~0.39Δ, and
// RIFT's relief runs to 2.8 m. Measured, that reads up to 9% low — 9.99 m at
// the 11 m clamp, taken beside the mid-lane tower.
//
// 12% therefore, and the number is honest about what it can and cannot catch:
// it separates the rungs (the closest pair, 24.32 and 34.96, are 44% apart) and
// it would have caught both of the defects that prompted it — 14.12 m reported
// as 11 is +28%, and 19.84 m reported as 24.32 is -18%. What certifies the
// clamp itself to the centimetre is `assertAtClamp`, which compares two probes
// over the SAME ground and so has no relief term at all.
const CAM_H_TOLERANCE = 0.12;
/** How far the measured camera target may sit from the point we asked for. One
 *  minimap pixel at 200 px covers side/200 = 0.64 m, and the click lands on a
 *  pixel centre, so half a metre of quantisation is expected and 2 m is not. */
const CAM_TARGET_TOLERANCE_M = 2.0;

// ---- day / night pins ---------------------------------------------------------------
// TERRAIN_CONTRACT §6 / contract.ts SceneHandle.setTimeOfDay: 0 = full day,
// 1 = full night, continuous, wraps.
const DAY_PIN = 0;
const NIGHT_PIN = 1;

// ---- frame liveness (GRAPHICS_CONTRACT §5) --------------------------------------------
// Floors on the saved PNG's luminance. A frame taken through a full-screen dim
// collapses the mean; a blank or uniformly flooded frame collapses the standard
// deviation. Night carries its own mean floor because night is authored dark.
// MEASURED, not invented: in-world frames from verify-rift.mjs came back at
// mean 30.0-49.5 with stddev 22.3-35.8, so these floors sit at about half the
// lowest observed mean and a quarter of the lowest observed stddev — under
// every real frame, over every dimmed or blank one.
//
// THE FLOOR WAS NOT LOWERED, AND IT DID NOT NEED TO BE. `close-deco` (11.1) and
// `camp-brute` (13.8) were failing the day floor and the two of them are the
// only off-lane close-zoom shots, which made "18 is unreachable for an off-lane
// framing, because the hero's own vision disc is the only lit ground" a very
// plausible reading. It was the wrong one. Both were dark because `panTo`
// aimed at the point-reflection of the pose (see `panTo`): the hero was
// lighting one patch of jungle and the camera was photographing the unexplored
// mirror of it. With the aim corrected and nothing else touched, the same two
// shots measure 90.1 and 60.5 on the same build.
//
// This is why the floor stayed at 18. Re-deriving it downward would have made
// the gate agree with the defect and closed the only signal that anything was
// wrong — and 11.1 was never "an off-lane frame is dark", it was "this frame is
// of the wrong place".
const MIN_FRAME_STDDEV = 6; // 0..255
const MIN_FRAME_MEAN_DAY = 18;
const MIN_FRAME_MEAN_NIGHT = 6;
// Elements that cover the whole frame. `.shop-panel` and `.scoreboard` are NOT
// here — they are the panels ui-shop and ui-scoreboard exist to photograph.
const FULLSCREEN_OVERLAYS = ['.hud .death-overlay', '.death-overlay', '.end-screen', '.lobby-start', '.modal'];

// ---- terrain-derived framing ------------------------------------------------------------
// The camp stand-off band and CAMP_VISIBLE_M come from ./rift-terrain-facts.mjs
// — one definition for all three harnesses (they had drifted apart, and all
// three were standing inside camp aggro).
const CAMP_VISIBLE_TIMEOUT_MS = 30000;
const WORLD_READY_TIMEOUT_MS = 60000;
/** The SERVER day phase the camp shot is taken at. Not the renderer pin: that
 *  one fixes the lighting, this one fixes VISION, and vision is what draws the
 *  fog disc that lights an off-lane frame at all.
 *
 *  0.15 leaves hero vision at 10.59-11.00 m (`nightVisionScale`), a 4% spread
 *  round to round, and comfortably over the ~9.4 m the furthest-possible
 *  nearest member can sit at from the far end of the stand-off band. It is
 *  reached for 15% of every cycle, and DAY_PERIOD_S 600 at speed 5 makes the
 *  cycle 120 s of wall clock, so the wait below is bounded by about that. */
const CAMP_SHOT_MAX_DAY_PHASE = 0.15;
/** ...and the phase must still be under THIS when the shutter opens; the march
 *  and the visibility poll cost a few seconds of a moving cycle. 0.35 is hero
 *  vision 10.04 m, still over the 9.4 m worst case. */
const CAMP_SHOT_MAX_DAY_PHASE_AT_SHOT = 0.35;
const DAY_PHASE_WAIT_MS = 150000; // > one full 120 s wall cycle
/** The camp pose is held tighter than the general POSE_TOLERANCE_M: the whole
 *  stand-off band is 0.85 m wide, so a 2 m slop would put the hero either
 *  inside camp aggro or outside the vision that reveals it. */
const CAMP_POSE_TOLERANCE_M = 0.6;

// ---- deterministic waits --------------------------------------------------------------
const LIVE_TIMEOUT_MS = 60000;
const CLASH_TIMEOUT_MS = 120000; // waves spawn at 10 game-s and walk to the middle
const CLASH_CONTACT_M = 6; // opposing creeps this close are engaged
const CLASH_NEAR_MID_M = 26; // ...and this close to the frame centre
const COMBAT_TIMEOUT_MS = 90000;
const COMBAT_ATTACKERS = 2; // ents with a fresh .atk target in frame
const COMBAT_RADIUS_M = 20;
const CREEPS_TIMEOUT_MS = 90000;
const CREEPS_MIN = 3;
const CREEPS_RADIUS_M = 8; // camH 11 frames ~11m either side — keep them ON screen
const SCOUT_TIMEOUT_MS = 90000; // reveal the enemy base for wide-base-enemy
const FRESH_TICK_MS = 400; // liveness probe window (20 sim ticks at speed 5)
const RESPAWN_TIMEOUT_MS = 90000; // RESPAWN_BASE_S 3 + 3.5/level, /5 for speed
const RESPAWN_SETTLE_MS = 500; // the overlay fades; do not shoot the fade
const SCOUT_ARRIVE_M = 26;
const POSE_TIMEOUT_MS = 90000;
const POSE_TOLERANCE_M = 2.0;
const SKILL_TIMEOUT_MS = 15000;
const CAST_ATTEMPTS = 8;
const CAST_RETRY_MS = 900;

// ---- fixed points along the own->enemy diagonal ------------------------------------------
const POSE_T = 0.3; // hero pose: 30% of the way to the enemy Ancient
const DECO_OFFSET_M = 9; // ...pushed this far off the mid lane for close-deco
const DECO_CAM_OFFSET_M = 4; // camera sits this much further off-lane than the hero
const FOG_OFFSET_M = 24; // fog-edge centre: beyond the explored lane corridor
const RETREAT_SAFE_M = 12; // "home" for retreatHome: inside the fountain's guard
//                            ring, and comfortably wider than the soft unit
//                            separation that nudges an idle hero around

// ============================================================================
// TERRAIN FACTS — the four terrain-shot camera targets (river cell, cliff edge,
// lane-adjacent foliage, brute camp), derived rather than guessed. The
// derivation lives in ./rift-terrain-facts.mjs so this matrix, verify-rift and
// the e2e suite share ONE definition; they used to carry three copies and had
// already diverged.
//
// LOADED FROM INSIDE THE FATAL HANDLER, not at module scope. The Node-version
// check and the type-stripped import of terrain.ts can both throw, and at
// module scope that killed the process before the try/catch existed — so the
// harness exited with NO manifest, which its consumers treat as "never run".
// ============================================================================
let FACTS = null;
/** shared/src/config.ts, loaded the same way — every balance constant the
 *  camp checks reason about is read from it rather than copied. */
let CONFIG = null;

// ---- state -----------------------------------------------------------------------------
const shots = [];
const pageErrors = [];
/** Every console.warn the page emitted, verbatim. Reported, not fatal — the fatal subset is
 *  promoted into `pageErrors` by FATAL_WARN_RE. */
const pageWarnings = [];
/** Raw `rift_snap` frame texts off the socket, newest last (see `tapWire`). */
const wireSnaps = [];
const browsers = [];
let serverChild = null;
let serverExit = null;
let badServerExit = null; // an exit we did not ask for — a hard failure
let tearingDown = false;
let attempted = 0; // wanted shots resolved so far (ok or not)

const WANTED = SHOT_ORDER.filter((n) => ONLY === null || n.startsWith(ONLY));

const T0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const elapsed = () => `${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s`;
const log = (msg) => console.error(`[${elapsed()}] ${msg}`); // stdout ends with the JSON manifest
const errText = (err) => (err instanceof Error ? err.message : String(err));

/** Thrown once every requested shot has been resolved — unwinds the flow so
 *  `--only ui-menu` does not sit through a whole match. */
const EARLY_DONE = Symbol('early-done');

// ---- STALE DIST: freshness, not existence ---------------------------------------------------
//
// This guard used to be `if (!existsSync(SERVER_ENTRY) || !existsSync(CLIENT_ENTRY))`, and a
// six-hour-stale `platform/server/dist/server.js` walked straight through it: the file existed,
// it was simply the WRONG file. It predated the commit that put `rift_snap.dayPhase` and
// `rift_miss` on the wire, so `dayPhase` was absent from the wire entirely — and `net.ts`
// substitutes 0 for an absent `dayPhase` behind a one-shot console.warn, so a missing feature
// read as a plausible "full day" forever. Every consequence was silent:
//   * the three night shots are renderer-pinned (NIGHT_PIN), so they LOOKED like night while the
//     server underneath was in full day and the night vision penalty was never applied;
//   * `waitDayPhaseBelow(page, 0.15)` returned instantly against a constant 0 instead of gating
//     on the cycle it was written to gate on;
//   * and it was the THIRD such round: an earlier bundle contained zero occurrences of
//     `campBrute`, so no camp had ever reached the wire in any test that claimed to check one.
//
// So: EXISTENCE IS NOT FRESHNESS. Each bundle is compared against the newest mtime among the
// sources that compile into it, and a bundle that lost that race fails the run with both
// timestamps and the file that beat it. It is a hard failure and not a warning, and this harness
// still NEVER builds — a harness that silently rebuilds hides exactly the defect above, and the
// operator must know their tree was not the tree they measured.
const FRESHNESS_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.css', '.html', '.glsl', '.frag', '.vert']);

/** Everything esbuild pulls into `platform/server/dist/server.js` THAT CAN CHANGE RIFT'S WIRE.
 *  Deliberately NOT the whole bundle: `platform/server/src/index.ts` also links @bank/@fps/@kart/
 *  @wordbomb servers, and none of them can alter a rift snapshot. Including them would red this
 *  harness every time an unrelated agent edited another game — a gate that cries wolf gets an
 *  escape hatch bolted onto it, and then it is not a gate. Widen this list only for code that
 *  rift's server actually executes. */
const SERVER_SOURCES = [
  'platform/server/src',
  'platform/shared/src',
  'games/rift/server/src',
  'games/rift/shared/src',
].map((p) => path.join(ROOT, p));

/** ...and everything vite pulls into `games/rift/client/dist/`. */
const CLIENT_SOURCES = [
  'games/rift/client/src',
  'games/rift/client/index.html',
  'games/rift/client/vite.config.ts',
  'games/rift/shared/src',
  'platform/shared/src',
].map((p) => path.join(ROOT, p));

/** Newest `{file, mtimeMs}` under `roots` (each a directory or a single file). `*.test.ts` is
 *  skipped because no bundler ever imports one — a test edit must not demand a rebuild. */
function newestSource(roots) {
  let newest = null;
  const consider = (p) => {
    const mtimeMs = statSync(p).mtimeMs;
    if (newest === null || mtimeMs > newest.mtimeMs) newest = { file: p, mtimeMs };
  };
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!e.isFile() || e.name.endsWith('.test.ts') || e.name.endsWith('.test.tsx')) continue;
      if (!FRESHNESS_EXTS.has(path.extname(e.name))) continue;
      consider(p);
    }
  };
  for (const r of roots) {
    // A root that has moved is a SILENTLY WEAKENED gate, so it is a failure, not a skip.
    if (!existsSync(r)) throw new Error(`freshness gate: source root ${path.relative(ROOT, r)} does not exist`);
    if (statSync(r).isDirectory()) walk(r);
    else consider(r);
  }
  return newest;
}

const fmtGap = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m` : `${(m / 60).toFixed(1)}h`;
};

function assertBundleFresh(label, bundle, roots) {
  if (!existsSync(bundle)) {
    throw new Error(
      `${label}: ${path.relative(ROOT, bundle)} does not exist — run "npm run build" first (this harness NEVER builds)`,
    );
  }
  const bundleMs = statSync(bundle).mtimeMs;
  const newest = newestSource(roots);
  if (newest === null) {
    throw new Error(
      `${label}: no source files found under ${roots.map((r) => path.relative(ROOT, r)).join(', ')} — the ` +
        'freshness gate cannot run, and a gate that cannot run is not a gate',
    );
  }
  if (bundleMs >= newest.mtimeMs) {
    log(
      `${label} fresh: built ${new Date(bundleMs).toISOString()}, newest source ` +
        `${path.relative(ROOT, newest.file)} ${new Date(newest.mtimeMs).toISOString()}`,
    );
    return;
  }
  throw new Error(
    `${label} IS STALE — this run would measure code that is not in the bundle.\n` +
      `    bundle  ${path.relative(ROOT, bundle)}\n` +
      `            built ${new Date(bundleMs).toISOString()}\n` +
      `    source  ${path.relative(ROOT, newest.file)}\n` +
      `            saved ${new Date(newest.mtimeMs).toISOString()} — ${fmtGap(newest.mtimeMs - bundleMs)} NEWER than the bundle\n` +
      '    Run "npm run build" and re-run. This harness NEVER builds: a six-hour-stale server.js is what\n' +
      '    made three "night" captures grade a full-day server, silently, for a whole judge round.',
  );
}

/** Literal strings the SERVER bundle must contain. Each is a protocol feature that has already
 *  shipped once as "present in the source, absent from the running binary" — the failure mode a
 *  freshness check catches only when the mtimes happen to tell the truth (a `git checkout` or a
 *  restored dist can produce a NEW file built from OLD source). Cheap, and it reads the artifact
 *  itself rather than a timestamp about it. The build is not minified, so these survive verbatim. */
const REQUIRED_SERVER_SYMBOLS = [
  ['dayPhase', 'rift_snap.dayPhase — absent from the wire, net.ts substitutes 0 and night never happens'],
  ['rift_miss', 'the uphill-miss event (TERRAIN_CONTRACT §4)'],
  ['campBrute', 'the neutral camp EntKinds — a bundle with zero occurrences shipped, and no camp ever reached the wire'],
  ['campPack', 'the neutral camp EntKinds (tier 1)'],
  ['campHive', 'the neutral camp EntKinds (tier 3)'],
];

function assertServerBundleCarries() {
  const bundle = readFileSync(SERVER_ENTRY, 'utf8');
  const missing = REQUIRED_SERVER_SYMBOLS.filter(([sym]) => !bundle.includes(sym));
  if (missing.length === 0) return;
  throw new Error(
    `${path.relative(ROOT, SERVER_ENTRY)} does not contain ${missing.map(([s]) => `\`${s}\``).join(', ')} — the ` +
      'bundle was built from sources that predate these features:\n' +
      missing.map(([s, why]) => `    ${s}: ${why}`).join('\n') +
      '\n    Run "npm run build".',
  );
}

// ---- server -------------------------------------------------------------------------------
async function startServer() {
  assertBundleFresh('server bundle', SERVER_ENTRY, SERVER_SOURCES);
  assertBundleFresh('client bundle', CLIENT_ENTRY, CLIENT_SOURCES);
  assertServerBundleCarries();
  const inUse = await fetch(BASE, { signal: AbortSignal.timeout(1500) }).then(
    () => true,
    () => false,
  );
  if (inUse) throw new Error(`something is already listening on :${PORT} — kill it or set RIFT_ART_PORT`);
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverChild = child;
  child.stdout.on('data', (d) => process.stderr.write(`[server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[server!] ${d}`));
  child.on('exit', (code, signal) => {
    serverExit = { code, signal };
    if (tearingDown) return;
    // Recorded by EXIT CODE, never inferred from the piped log: a dead server
    // leaves the page rendering its last snapshot forever, so the screenshots
    // stay big and pretty while the world is frozen.
    badServerExit = { code, signal };
    process.stderr.write(`[server] EXITED mid-run (code ${code}, signal ${signal}) — the page just lost its socket.\n`);
  });
}

async function waitForServer(timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    if (serverChild.exitCode !== null) throw new Error(`server exited early (${serverChild.exitCode})`);
    try {
      const res = await fetch(BASE, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`server did not listen on :${PORT} within ${timeoutMs}ms`);
    await sleep(250);
  }
}

/** Refuse to capture a vite-dev proxy: HMR reloads pages mid-capture and the
 *  served source may be mid-edit. The BUILT client must answer. */
async function assertProductionMount() {
  const res = await fetch(`${BASE}/rift/`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`GET /rift/ returned ${res.status} — is the client built? (npm run build)`);
  const html = await res.text();
  if (html.includes('/@vite/client')) {
    throw new Error('/rift/ is proxied to the vite dev server on :5177 — stop it and re-run against the build');
  }
}

// ---- browser -------------------------------------------------------------------------------
const LAUNCH_ARGS = [
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--enable-unsafe-swiftshader',
  '--disable-background-networking',
  '--disable-component-extensions-with-background-pages',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-sync',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints',
];
const LAUNCH_OPTS = {
  headless: 'shell',
  args: LAUNCH_ARGS,
  protocolTimeout: Number(process.env.E2E_PROTOCOL_TIMEOUT ?? 300000),
};

/**
 * A console.warn whose TEXT names the wire is a failed run, not chatter.
 *
 * This harness used to drop every non-error console message on the floor — it filtered by LEVEL,
 * and the one signal that would have named the six-hour-stale server instantly was net.ts's
 * one-shot `rift net: rift_snap carries no \`dayPhase\` — the server is not sending a
 * protocol-required field`. A warning that says the client is silently defaulting a protocol
 * field describes a world this matrix is about to photograph and grade as if it were real.
 *
 * Filtering by CONTENT rather than by level, because a browser warns about plenty that is not a
 * defect (deprecations, texture-unit chatter): everything else a warn says still reaches the
 * operator on stderr and is counted in the manifest, but only these fail the run.
 */
const FATAL_WARN_RE = /rift net:|protocol-required|rift_snap|rift_begin|carries no |is not sending/i;

function trackErrors(page, tag) {
  page.on('console', (m) => {
    const type = m.type();
    const url = m.location()?.url ?? '';
    const text = m.text();
    if (/favicon/.test(url) || /favicon/.test(text)) return;
    if (type === 'warning' || type === 'warn') {
      // Shutdown noise only: a killed server makes the client warn about its socket.
      if ((tearingDown || serverExit !== null) && /WebSocket/.test(text)) return;
      pageWarnings.push(`[${tag}] console.warn: ${text} (${url})`);
      log(`[warn] [${tag}] ${text}`);
      if (FATAL_WARN_RE.test(text)) {
        pageErrors.push(
          `[${tag}] console.warn NAMES THE WIRE — a protocol field the client is silently defaulting: ${text} (${url})`,
        );
      }
      return;
    }
    if (type !== 'error') return;
    // Shutdown noise only: a killed server makes the client log socket errors.
    if ((tearingDown || serverExit !== null) && /WebSocket connection to .* failed/.test(text)) return;
    pageErrors.push(`[${tag}] console.error: ${text} (${url})`);
  });
  page.on('pageerror', (e) => pageErrors.push(`[${tag}] pageerror: ${e.message}`));
  page.on('error', (e) => pageErrors.push(`[${tag}] page CRASHED: ${e.message}`));
  page.on('requestfailed', (r) => {
    if (/favicon/.test(r.url())) return;
    pageErrors.push(`[${tag}] requestfailed: ${r.url()} — ${r.failure()?.errorText ?? '?'}`);
  });
}

// ---- the wire tap ---------------------------------------------------------------------------
//
// `window.__rift.snaps()` is the client's PARSED ring, and the client is precisely the thing that
// HIDES a missing field: net.ts's `dayPhaseOf` substitutes 0 for an absent `dayPhase` and moves
// on. So `serverDayPhase()` — which reads that ring — can never distinguish "the server sent 0"
// from "the server sent nothing", and for a whole judge round it reported a confident, constant,
// entirely fictional 0. The frames themselves are the only witness, so they are read off CDP
// before any client code touches them.
// The tap DETACHES ITSELF after WIRE_TAP_KEEP frames, and that is not tidiness. `Network.enable`
// ships every WebSocket payload across the CDP channel, and at ~40 snaps/s for a ten-minute match
// that is a sustained megabyte-per-second of extra work on the exact pipe whose starvation this
// harness already documents as the cause of mid-run socket drops (see GL_LADDER). Four frames is
// all the protocol check needs, so the firehose lasts a few hundred milliseconds.
const WIRE_TAP_TIMEOUT_MS = 20000;
const WIRE_TAP_KEEP = 4;

async function tapWire(page, tag) {
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  let kept = 0;
  cdp.on('Network.webSocketFrameReceived', ({ response }) => {
    if (kept >= WIRE_TAP_KEEP) return;
    if (response?.opcode !== 1) return; // 1 = text; the protocol is JSON text (net.ts)
    const data = response.payloadData;
    if (typeof data !== 'string' || !data.includes('"rift_snap"')) return;
    wireSnaps.push(data);
    if (wireSnaps.length > WIRE_TAP_KEEP) wireSnaps.shift();
    if (++kept < WIRE_TAP_KEEP) return;
    void cdp
      .send('Network.disable')
      .then(() => cdp.detach())
      .then(() => log(`[${tag}] wire tap detached after ${kept} rift_snap frame(s)`))
      .catch(() => {}); // the page may already be gone; the frames are already captured
  });
  log(`[${tag}] wire tap attached (raw rift_snap frames off CDP)`);
}

/** The frozen `EntKind` set (shared/src/types.ts). A kind off the wire that is not in here means
 *  the running server and this harness disagree about the vocabulary. */
const ENT_KINDS = new Set([
  'hero', 'melee', 'ranged', 'siege', 'shade', 'tower', 'guard', 'ancient', 'ward', 'proj',
  'campPack', 'campBrute', 'campHive',
]);

/**
 * Assert the WIRE carries what protocol.ts says it carries — on a real frame, before the first
 * in-world shot, and specifically for the class of field the client silently defaults.
 *
 * `dayPhase` is checked for PRESENCE first (`'dayPhase' in snap`), not merely for being a usable
 * number: "absent" and "0" are the same value to every downstream reader in this harness, and
 * telling them apart is the entire point. A field that is present and 0 is a full day; a field
 * that is absent is a server that predates the feature, and every night shot taken against it is
 * a lie with correct-looking lighting.
 */
async function assertWireProtocol() {
  const t0 = Date.now();
  while (wireSnaps.length === 0) {
    if (Date.now() - t0 > WIRE_TAP_TIMEOUT_MS) {
      throw new Error(
        `no raw rift_snap frame reached the CDP wire tap within ${WIRE_TAP_TIMEOUT_MS}ms — the protocol cannot ` +
          'be checked against the socket, only against the client\'s forgiving parse of it',
      );
    }
    await sleep(200);
  }
  const text = wireSnaps[wireSnaps.length - 1];
  let snap;
  try {
    snap = JSON.parse(text);
  } catch (err) {
    throw new Error(`a rift_snap frame off the socket is not JSON (${errText(err)}): ${text.slice(0, 200)}`);
  }
  if (snap === null || typeof snap !== 'object' || snap.t !== 'rift_snap') {
    throw new Error(`the tapped frame is not a rift_snap envelope: ${text.slice(0, 200)}`);
  }
  if (!('dayPhase' in snap)) {
    throw new Error(
      'rift_snap ON THE WIRE HAS NO `dayPhase` — protocol.ts freezes it as always present and always in [0,1], ' +
        'and net.ts substitutes 0 for it, so every reader in this harness would report a confident full day. ' +
        'The night shots would be renderer-pinned over a full-day server with no night vision penalty applied. ' +
        'The running server predates the field: rebuild (npm run build) and check room.ts sets it. ' +
        `Frame keys: ${Object.keys(snap).join(', ')}`,
    );
  }
  const d = snap.dayPhase;
  if (typeof d !== 'number' || !Number.isFinite(d) || d < 0 || d > 1) {
    throw new Error(
      `rift_snap.dayPhase on the wire is ${JSON.stringify(d)} — protocol.ts requires a finite number in [0,1]`,
    );
  }
  const ents = Array.isArray(snap.ents) ? snap.ents : null;
  if (ents === null) throw new Error('rift_snap on the wire has no `ents` array');
  const unknown = [...new Set(ents.map((e) => e?.k).filter((k) => !ENT_KINDS.has(k)))];
  if (unknown.length > 0) {
    throw new Error(
      `rift_snap carries EntKind(s) this harness does not know: ${unknown.map((k) => JSON.stringify(k)).join(', ')} — ` +
        'shared/src/types.ts and the running server have diverged',
    );
  }
  log(
    `wire protocol OK: rift_snap.dayPhase = ${d.toFixed(4)} (present on the frame, not defaulted) at ` +
      `matchTick ${String(snap.matchTick)}, ${ents.length} ents, kinds ${[...new Set(ents.map((e) => e.k))].sort().join('/')}`,
  );
  return d;
}

/** GL backends, best first. verify-rift only needed "webgl2 or swiftshader",
 *  but this harness holds a live socket open across a long match and the
 *  BACKEND decides whether that survives: measured on this box, ANGLE/Metal
 *  renders this scene in 17ms a frame at 1080p, SwiftShader in 418ms. At
 *  SwiftShader speed the renderer stops draining the WebSocket data pipe long
 *  enough to miss two protocol pongs, and the server terminates the socket
 *  mid-run. So a hardware backend is REQUESTED first (--use-angle=default is
 *  Metal on macOS, the native driver elsewhere); the plain launch and then
 *  SwiftShader remain as fallbacks, and the chosen renderer is logged because
 *  it is the single biggest predictor of a flaky round. */
const GL_LADDER = [
  { name: 'hardware (angle default)', args: ['--use-gl=angle', '--use-angle=default'] },
  { name: 'chrome default', args: [] },
  { name: 'swiftshader', args: ['--use-gl=angle', '--use-angle=swiftshader'] },
];

async function launchOne(vp, tag) {
  let lastErr = 'no backend tried';
  for (const rung of GL_LADDER) {
    const browser = await puppeteer.launch({ ...LAUNCH_OPTS, args: [...LAUNCH_ARGS, ...rung.args] });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
    const renderer = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (gl === null) return null;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(ext === null ? gl.getParameter(gl.RENDERER) : gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
    });
    if (renderer !== null) {
      log(`[${tag}] GL backend: ${rung.name} — ${renderer}`);
      if (/swiftshader|software/i.test(renderer)) {
        log(`[${tag}] [warn] SOFTWARE rendering — frames cost ~25x a GPU frame; the live socket may be dropped mid-match`);
      }
      trackErrors(page, tag);
      await tapWire(page, tag);
      page.__browser = browser;
      return page;
    }
    lastErr = `no webgl2 on ${rung.name}`;
    log(`[${tag}] ${lastErr} — trying the next backend`);
    browsers.pop();
    await browser.close().catch(() => {});
  }
  throw new Error(`[${tag}] webgl2 unavailable on every backend (${lastErr})`);
}

async function closePage(page) {
  const browser = page?.__browser;
  if (browser === undefined) return;
  const i = browsers.indexOf(browser);
  if (i >= 0) browsers.splice(i, 1);
  try {
    await browser.close();
  } catch {
    // already gone
  }
}

// ---- generic helpers -------------------------------------------------------------------------
async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // page mid-navigation / socket reconnect — keep polling
    }
    if (Date.now() - t0 > timeoutMs) {
      if (serverExit !== null) {
        throw new Error(
          `timeout waiting for ${label} — the platform server exited mid-run (code ${serverExit.code}, signal ${serverExit.signal})`,
        );
      }
      throw new Error(`timeout (${timeoutMs}ms) waiting for ${label}`);
    }
    await sleep(150);
  }
}

/** Wait on fonts + rendered frames, then a short settle so successive rounds
 *  catch the same animation phase. */
async function settle(page, { frames = 3, ms = 350 } = {}) {
  try {
    await page.evaluate(
      (n) =>
        document.fonts.ready.then(
          () =>
            new Promise((resolve) => {
              let left = n;
              const tick = () => (left-- <= 0 ? resolve(true) : requestAnimationFrame(tick));
              requestAnimationFrame(tick);
            }),
        ),
      frames,
    );
  } catch {
    // a stalled rAF must not abort the capture
  }
  if (ms > 0) await sleep(ms);
}

const riftState = (page) => page.evaluate(() => window.__rift?.state() ?? null);
const drawCalls = (page) => page.evaluate(() => window.__rift?.drawCalls() ?? -1);

/** Per-frame triangle count (GRAPHICS_CONTRACT §5's second budget). -1 means
 *  the meter is not exposed at all. */
const triangles = (page) =>
  page.evaluate(() => (typeof window.__rift?.triangles === 'function' ? window.__rift.triangles() : -1));

/** `true` once the chunked terrain AND vegetation bakes have finished
 *  (contract.ts TerrainHandle.ready / VegetationHandle.ready, reported by
 *  R_WIRE). `null` when the accessor does not exist. A jungle shot of an
 *  unplanted jungle grades nothing. */
const worldReady = (page) =>
  page.evaluate(() => (typeof window.__rift?.worldReady === 'function' ? window.__rift.worldReady() : null));

/** Pin the renderer's time of day; `null` resumes snapshot-driven updates.
 *  Returns false when the debug surface has no setDayPhase — in which case the
 *  shot must NOT be taken, because its lighting would depend on the wall
 *  clock and no two judge rounds would compare. */
const pinDayPhase = (page, t) =>
  page.evaluate((v) => {
    if (typeof window.__rift?.setDayPhase !== 'function') return false;
    window.__rift.setDayPhase(v);
    return true;
  }, t);

/** Neutral (team 2) camp entities alive within `radius` of a clearing centre. */
const neutralsNear = (page, cx, cz, radius) =>
  page.evaluate(
    (x, z, r) => {
      const ring = window.__rift?.snaps() ?? [];
      const s = ring.length > 0 ? ring[ring.length - 1] : null;
      if (s === null || s === undefined) return 0;
      return s.ents.filter((e) => e.team === 2 && e.hp > 0 && Math.hypot(e.x - x, e.z - z) <= r).length;
    },
    cx,
    cz,
    radius,
  );

/** Live camp members (team 2) near a clearing centre, with their positions —
 *  used to CHECK the ring radius this harness's stand-off band is derived
 *  against, rather than trusting the copied constant. */
const campMembers = (page, cx, cz, radius) =>
  page.evaluate(
    (x, z, r) => {
      const ring = window.__rift?.snaps() ?? [];
      const s = ring.length > 0 ? ring[ring.length - 1] : null;
      if (s === null || s === undefined) return [];
      return s.ents
        .filter((e) => e.team === 2 && e.hp > 0 && Math.hypot(e.x - x, e.z - z) <= r)
        .map((e) => ({ x: e.x, z: e.z }));
    },
    cx,
    cz,
    radius,
  );

/**
 * The two properties the stand-off band exists to produce, checked against the
 * live snapshot at the moment of the shot:
 *
 *   1. the CLEARING CENTRE is inside the hero's own vision — so the ground this
 *      shot frames is lit by this hero, not by a bot that happened to be
 *      standing somewhere useful, which is a reveal that will not repeat;
 *   2. no member has reached the hero, so the camp has not pulled.
 *
 * (1) is asked of the CLEARING, not of the nearest member, and the difference
 * matters. Members are not furniture: they chase lane creeps, get pushed by
 * separation and walk home again, and the first version of this check —
 * "nearest member inside hero vision" — failed a good frame because a member
 * had drifted to the far side of the clearing and read 11.04 m against an
 * 11.00 m radius. The camp was in shot and lit; the check was measuring
 * something the shot does not depend on. What it does depend on is the
 * clearing being inside the vision disc, and that is a property of the
 * stand-off point and the day phase — both of which this harness controls.
 *
 * Every number here comes from shared `config.ts` through `loadConfig()`,
 * `nightVisionScale` included — the night ramp is the sim's own function rather
 * than a harness re-derivation of it. That is the whole point: a stale local
 * copy of exactly this vision figure is what broke this shot, and AMENDMENT_1
 * §B.1 had to hoist a re-derived copy of exactly this ramp out of two modules
 * for the same reason.
 *
 * What this deliberately does NOT assert is where members sit relative to their
 * POSTS. The first version did, and failed a perfectly good shot because a lane
 * creep had legitimately pulled the camp 3.6 m off its 1.6 m ring — members may
 * range out to CAMP_LEASH_RADIUS and the shot does not care, provided (1) and
 * (2) hold.
 */
async function assertCampStandOff(page, cx, cz) {
  const members = await campMembers(page, cx, cz, CAMP_VISIBLE_M);
  if (members.length === 0) throw new Error('no camp members in the snapshot at the moment of the shot');
  const you = await latestYou(page);
  if (you === null) throw new Error('no local hero in the snapshot');
  const phase = await serverDayPhase(page);
  if (phase === null) throw new Error('rift_snap.dayPhase is missing — the hero vision radius cannot be computed');
  const vision = CONFIG.HERO_VISION * CONFIG.nightVisionScale(phase);
  const toClearing = Math.hypot(cx - you.x, cz - you.z);
  if (toClearing > vision) {
    throw new Error(
      `the hero stands ${toClearing.toFixed(2)}m from the clearing centre but its vision at dayPhase ` +
        `${phase.toFixed(3)} is only ${vision.toFixed(2)}m — the camp is on the wire through somebody else's vision, ` +
        'so this framing will not reproduce',
    );
  }
  let nearest = Infinity;
  for (const m of members) nearest = Math.min(nearest, Math.hypot(m.x - you.x, m.z - you.z));
  if (nearest <= CONFIG.AGGRO_RADIUS) {
    throw new Error(
      `a camp member is ${nearest.toFixed(2)}m from the hero, inside AGGRO_RADIUS ${CONFIG.AGGRO_RADIUS} — ` +
        'the stand-off failed and the camp is about to pull',
    );
  }
  log(
    `camp-brute: ${members.length} member(s), clearing ${toClearing.toFixed(2)}m and nearest member ` +
      `${nearest.toFixed(2)}m from the hero, vision ${vision.toFixed(2)}m at dayPhase ${phase.toFixed(3)}`,
  );
}

/** The SERVER's day phase, straight off the newest snapshot
 *  (`rift_snap.dayPhase`, the single definition AMENDMENT_1 §B.1 hoisted into
 *  config.ts). This is the one that scales VISION; `setDayPhase` pins only the
 *  renderer, and confusing the two is what made `camp-brute` intermittent. */
const serverDayPhase = (page) =>
  page.evaluate(() => {
    const ring = window.__rift?.snaps() ?? [];
    const s = ring.length > 0 ? ring[ring.length - 1] : null;
    if (s === null || s === undefined) return null;
    const d = s.dayPhase;
    return typeof d === 'number' && Number.isFinite(d) ? d : null;
  });

/** Block until the server's day phase drops to `max`, so a vision-dependent
 *  shot is always taken at the same point of the cycle. */
async function waitDayPhaseBelow(page, max) {
  const t0 = Date.now();
  for (;;) {
    const p = await serverDayPhase(page);
    if (p === null) {
      throw new Error(
        'rift_snap.dayPhase is missing — a vision-dependent shot cannot be pinned to a point in the day/night ' +
          'cycle, so it would not be reproducible (protocol.ts freezes dayPhase on the snapshot)',
      );
    }
    if (p <= max) {
      log(`server dayPhase ${p.toFixed(3)} <= ${max} — hero vision is at its day value`);
      return p;
    }
    if (Date.now() - t0 > DAY_PHASE_WAIT_MS) {
      throw new Error(`the server day phase never fell to ${max} within ${DAY_PHASE_WAIT_MS}ms (last ${p.toFixed(3)})`);
    }
    await assertConnectedLive(page);
    await sleep(1000);
  }
}

/** ...and the same phase, re-checked at the moment of the shot. */
async function assertDayPhaseBelow(page, max, name) {
  const p = await serverDayPhase(page);
  if (p === null || p > max) {
    throw new Error(
      `${name}: the server day phase is ${p === null ? 'unreadable' : p.toFixed(3)}, over the ${max} this shot is ` +
        'pinned to — hero vision has shrunk and the frame would not match the other rounds',
    );
  }
}

/** Click the minimap canvas at normalised CANVAS coordinates (u,v), where
 *  (0,0) is its top-left pixel. This is a canvas-space helper — callers that
 *  mean a WORLD point must go through `panTo`, which owns the mapping. */
async function minimapPan(page, u, v) {
  const rect = await page.$eval('.minimap canvas', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  await page.mouse.click(rect.x + u * rect.w, rect.y + v * rect.h);
}

/**
 * Aim the camera at a WORLD point.
 *
 * THE MINIMAP IS DRAWN ROTATED 180°, AND SO IS ITS HIT TEST. `ui/minimap.ts`
 * states it in its header — "world x -> canvas LEFT, world z -> canvas UP",
 * measured by scripts/repro-pan.mjs against the fixed camera rig — and
 * `toWorld()` implements it: `world = (1 - u) * side`, not `u * side`.
 *
 * This harness used to send `u = x / side`, so EVERY pan in it landed on the
 * point-reflection of its target, `(side - x, side - z)`. It survived review
 * for as long as it did because the map is point-symmetric about its centre
 * (TERRAIN_CONTRACT §3): the mirror of the map centre is the map centre, the
 * mirror of a tower is the opposing tower, the mirror of a cliff cell is
 * another cliff cell — so most of the matrix photographed a plausible-looking
 * wrong place and only the two shot families that frame something UNIQUE gave
 * it away:
 *   * the hero shots (close-hero, night-close-hero, fx-cast) framed the empty
 *     mirror of the pose point, which is why `close-hero` came back as a
 *     near-black frame with no hero in it at all;
 *   * the off-lane terrain shots (close-deco, camp-brute) framed the mirror of
 *     the cell the hero was lighting, which is unexplored shroud — hence day
 *     frames at mean luminance 11-14 against an 18 floor, and hence the
 *     flakiness, since whether the mirror had been explored by somebody else
 *     varied from round to round.
 * `panTo` is now the ONLY place that knows the mapping, and `assertCamera`
 * below proves it landed rather than assuming it did.
 */
const panTo = (page, x, z) => minimapPan(page, 1 - x / MAP_SIDE, 1 - z / MAP_SIDE);

/** Wheel-zoom `steps` notches; dir -1 zooms in (lower camH), +1 out. */
async function zoom(page, steps, dir) {
  await page.mouse.move(WORK_VIEWPORT.width / 2, WORK_VIEWPORT.height / 2);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel({ deltaY: dir > 0 ? 240 : -240 });
    await sleep(70);
  }
}

/**
 * PROVE the wheel is sitting on a clamp, by taking one more notch in the same
 * direction and requiring the framing not to move.
 *
 * This is the exact test for the defect that was reported, and it is immune to
 * terrain: both measurements are taken at the same camera target over the same
 * ground, so whatever the relief does to the estimator it does identically to
 * each, and the RATIO between them is exact. An absolute height check cannot be
 * that clean — `screenToGround` resolves against the real height field, so a
 * plateau beside the target pulls the probe in and reads several percent low
 * (measured: 9.99 m at the 11 m clamp beside the mid-lane tower).
 *
 * A notch that is a no-op means the clamp absorbed it, which is the entire
 * premise of driving the zoom from a clamp. If it is NOT a no-op, the notch
 * count no longer overshoots the range and every rung derived from this one
 * sits at an unspecified height — precisely what 12 notches had been doing ever
 * since CAM_MIN_H moved 18 -> 11.
 */
const CLAMP_PROOF_TOLERANCE = 0.03; // 3%, against the 12% a single free notch moves
async function assertAtClamp(page, dir, name) {
  const before = await measureCamera(page);
  await zoom(page, 1, dir);
  const after = await measureCamera(page);
  const moved = Math.abs(after.camH - before.camH) / before.camH;
  if (moved > CLAMP_PROOF_TOLERANCE) {
    throw new Error(
      `${ZOOM_CLAMP_STEPS} notches did not reach the ${name} clamp: one more moved the framing by ` +
        `${(moved * 100).toFixed(1)}% (${before.camH.toFixed(2)}m -> ${after.camH.toFixed(2)}m), so the wheel is still ` +
        'free to travel and every rung driven from here is at an unspecified height',
    );
  }
}

let zoomLevel = null; // 'out' | 'default' | 'cam24' | 'in'
/** Drive camH to a reproducible height: always via a clamp, never relative.
 *  Each clamp is PROVED before anything is stepped off it, and every shot then
 *  re-measures the absolute height in `assertCamera`. The arithmetic in the
 *  constants above says where a rung should land; the measurements are what
 *  decide whether it did. */
async function zoomTo(page, level) {
  if (zoomLevel === level) return;
  await zoom(page, ZOOM_CLAMP_STEPS, +1); // -> the CAM_MAX_H clamp
  await assertAtClamp(page, +1, 'CAM_MAX_H');
  if (level === 'in' || level === 'cam24') {
    await zoom(page, ZOOM_CLAMP_STEPS, -1); // -> the CAM_MIN_H clamp
    await assertAtClamp(page, -1, 'CAM_MIN_H');
    if (level === 'cam24') await zoom(page, ZOOM_CAM24_STEPS, +1); // -> 24.32, the rung nearest camH 24
  } else if (level === 'default') {
    await zoom(page, ZOOM_DEFAULT_STEPS, -1); // -> 34.96
  }
  zoomLevel = level;
}

// ---- camera read-back (the framing gate) -----------------------------------------------
// AMENDMENT_6: a harness gates on BEHAVIOUR, never on the arithmetic that was
// supposed to produce it. Both halves of the framing — where the camera is
// aimed and how high it is — are therefore MEASURED through
// `window.__rift.screenToGround`, the scene's own raycast against its own
// camera, and a shot whose framing did not land is failed rather than saved.
//
// The rig is fixed (render/scene.ts `applyCamera`): the eye sits at
// `heightAt(target) + camH`, pulled back `camH / tan(55°)` along -z, looking at
// the target, through a perspective camera of vertical FOV 50 at 16:9. Yaw and
// roll are zero, so the camera's right vector is horizontal and:
//
//   * the ray through the CANVAS CENTRE hits the ground AT the camera target
//     (contract.ts says so in as many words), giving (x, z) exactly;
//   * along the centre ROW the ray's y-component does not vary with the
//     horizontal pixel, so every hit on that row shares one depth and the
//     ground offset is exactly linear in NDC u:
//         hit.x - target.x = camH * u * tan(FOV/2) * aspect / sin(55°)
//     which inverts to camH with no free parameters.
const CAM_PITCH_RAD = (55 * Math.PI) / 180;
const CAM_FOV_RAD = (50 * Math.PI) / 180;
const CAM_ASPECT = SHOT_VIEWPORT.width / SHOT_VIEWPORT.height; // 16:9, both viewports
/** Ground half-width at the centre row, per metre of camH. */
const CAM_HALF_W_PER_M = (Math.tan(CAM_FOV_RAD / 2) * CAM_ASPECT) / Math.sin(CAM_PITCH_RAD);
/** Ground distance from the target to the BOTTOM edge, per metre of camH:
 *  1/tan(55°) - 1/tan(55° + 25°). The near edge, not the far one — the far ray
 *  leaves at 30° and multiplies any height error by 1.73, the near ray at 80°
 *  divides it by 5.7. */
const CAM_NEAR_Z_PER_M = 1 / Math.tan(CAM_PITCH_RAD) - 1 / Math.tan(CAM_PITCH_RAD + CAM_FOV_RAD / 2);
/** How much of the measured footprint counts as "in frame, and large". 0.7
 *  keeps the subject inside the middle 70% of the frame in both axes, which is
 *  the framing STYLE_BIBLE §5 asks for — not merely "somewhere on screen". */
const HERO_FRAME_FRAC = 0.7;
/** Signed fractions of the half-width to probe along the centre row, widest
 *  first. `screenToGround` reports null once a ray leaves the map, and at the
 *  widest rung over a base corner one whole side of the row does — so the
 *  probe tries both sides and steps inward until one lands. The offset is
 *  exactly linear in this fraction, so every rung that lands gives the same
 *  camH; a narrower one only carries more of the raycast's own rounding. */
const CAM_PROBE_US = [0.8, -0.8, 0.5, -0.5, 0.25, -0.25];

/** The camera target and height, measured through the scene's raycast. Throws
 *  rather than returning a guess — an unmeasurable camera is a failed shot. */
async function measureCamera(page) {
  const m = await page.evaluate((us) => {
    const api = window.__rift;
    if (api === undefined || typeof api.screenToGround !== 'function') return { err: 'missing' };
    const canvas = document.querySelector('canvas');
    if (canvas === null) return { err: 'no canvas' };
    const r = canvas.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return { err: 'canvas has no box' };
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const centre = api.screenToGround(cx, cy);
    let side = null;
    let u = 0;
    for (const f of us) {
      const hit = api.screenToGround(cx + (r.width / 2) * f, cy);
      if (hit !== null) {
        side = hit;
        u = f;
        break;
      }
    }
    return { centre, side, u, aspect: r.width / r.height };
  }, CAM_PROBE_US);
  if (m.err !== undefined) {
    throw new Error(
      `window.__rift.screenToGround is unusable (${m.err}) — it is the frozen camera probe (CONTRACT §6) and ` +
        'without it no shot can prove what it framed',
    );
  }
  if (Math.abs(m.aspect - CAM_ASPECT) > 0.01) {
    throw new Error(`the canvas is ${m.aspect.toFixed(3)}:1, not ${CAM_ASPECT.toFixed(3)}:1 — the camH derivation assumes 16:9`);
  }
  if (m.centre === null || m.side === null) {
    throw new Error('every camera probe ray left the map — the camera is aimed off the world');
  }
  const camH = Math.abs(m.side.x - m.centre.x) / (Math.abs(m.u) * CAM_HALF_W_PER_M);
  return { x: m.centre.x, z: m.centre.z, camH };
}

/** The framing gate for one shot: the camera is where we aimed it and at the
 *  height the rung claims. `level` may be null to check only the aim. */
async function assertCamera(page, name, wantX, wantZ, level) {
  const cam = await measureCamera(page);
  const off = Math.hypot(cam.x - wantX, cam.z - wantZ);
  if (off > CAM_TARGET_TOLERANCE_M) {
    throw new Error(
      `the camera is aimed at (${cam.x.toFixed(1)}, ${cam.z.toFixed(1)}), ${off.toFixed(1)}m from the requested ` +
        `(${wantX.toFixed(1)}, ${wantZ.toFixed(1)}) — ${name} would photograph the wrong place`,
    );
  }
  if (level !== null) {
    const want = ZOOM_RUNG_M[level];
    if (want === undefined) throw new Error(`unknown zoom rung '${String(level)}'`);
    if (Math.abs(cam.camH - want) > want * CAM_H_TOLERANCE) {
      throw new Error(
        `camera height measured ${cam.camH.toFixed(2)}m, but the '${level}' rung is ${want}m — the wheel notch ` +
          'count no longer reaches the clamp it is driven from (game.ts CAM_MIN_H / CAM_MAX_H moved)',
      );
    }
  }
  return cam;
}

/** ...and, for the shots whose entire subject is the player's hero, that the
 *  hero is actually inside the measured footprint. `close-hero` shipped a
 *  near-black frame containing no hero at all for a whole judge round because
 *  nothing checked this: the PNG was the right size, the luminance floors
 *  passed, and the manifest said `ok`. */
async function assertHeroFramed(page, name, cam) {
  const you = await latestYou(page);
  if (you === null) throw new Error(`${name}: no local hero in the snapshot`);
  const dx = Math.abs(you.x - cam.x);
  const dz = Math.abs(you.z - cam.z);
  const maxX = HERO_FRAME_FRAC * CAM_HALF_W_PER_M * cam.camH;
  const maxZ = HERO_FRAME_FRAC * CAM_NEAR_Z_PER_M * cam.camH;
  if (dx > maxX || dz > maxZ) {
    throw new Error(
      `the hero stands at (${you.x.toFixed(1)}, ${you.z.toFixed(1)}), ${Math.hypot(you.x - cam.x, you.z - cam.z).toFixed(1)}m ` +
        `from the camera target (${cam.x.toFixed(1)}, ${cam.z.toFixed(1)}) — outside the ${maxX.toFixed(1)}x${maxZ.toFixed(1)}m ` +
        `frame ${name} exists to fill with it`,
    );
  }
}

// ---- world queries (all reductions run IN PAGE — never ship a whole snap over) ------------
const latestYou = (page) =>
  page.evaluate(() => {
    const ring = window.__rift?.snaps() ?? [];
    const s = ring.length > 0 ? ring[ring.length - 1] : null;
    if (s === null || s === undefined || s.you === null || s.you === undefined) return null;
    const y = s.you;
    return {
      x: y.x,
      z: y.z,
      hp: y.hp,
      level: y.level,
      skillPoints: y.skillPoints,
      respawnAtTick: y.respawnAtTick,
      matchTick: s.matchTick,
      rank0: y.abilities?.[0]?.rank ?? 0,
      cd0: y.abilities?.[0]?.cdUntilTick ?? 0,
      mana: y.mana,
    };
  });

/** Own hero's entity id (its snap row carries pid === hello.you). */
const selfEntId = (page) =>
  page.evaluate(() => {
    const ring = window.__rift?.snaps() ?? [];
    const s = ring.length > 0 ? ring[ring.length - 1] : null;
    const you = window.__rift?.state()?.you ?? null;
    if (s === null || s === undefined || you === null) return -1;
    for (const e of s.ents) if (e.k === 'hero' && e.pid === you) return e.id;
    return -1;
  });

/** Structures are pure buildMap() output — identical every round. */
const structures = (page) =>
  page.evaluate(() => {
    const ring = window.__rift?.snaps() ?? [];
    const s = ring.length > 0 ? ring[ring.length - 1] : null;
    if (s === null || s === undefined) return [];
    return s.ents
      .filter((e) => e.k === 'tower' || e.k === 'guard' || e.k === 'ancient')
      .map((e) => ({ id: e.id, k: e.k, team: e.team, x: e.x, z: e.z }));
  });

const CREEP_KINDS = ['melee', 'ranged', 'siege'];

/** Closest opposing-creep pair inside `radius` of (cx,cz) — the real
 *  "creeps are engaged here" signal. */
const creepContact = (page, cx, cz, radius) =>
  page.evaluate(
    (cx2, cz2, r, kinds) => {
      const ring = window.__rift?.snaps() ?? [];
      const s = ring.length > 0 ? ring[ring.length - 1] : null;
      if (s === null || s === undefined) return Infinity;
      const near = s.ents.filter(
        (e) => kinds.includes(e.k) && e.hp > 0 && Math.hypot(e.x - cx2, e.z - cz2) <= r,
      );
      let best = Infinity;
      for (const a of near) {
        if (a.team !== 0) continue;
        for (const b of near) {
          if (b.team !== 1) continue;
          const d = Math.hypot(a.x - b.x, a.z - b.z);
          if (d < best) best = d;
        }
      }
      return best;
    },
    cx,
    cz,
    radius,
    CREEP_KINDS,
  );

/** Units that swung since the previous snapshot (EntSnap.atk drives the
 *  client's tracers, damage numbers and impact bursts). */
const attackerCount = (page, cx, cz, radius) =>
  page.evaluate(
    (cx2, cz2, r) => {
      const ring = window.__rift?.snaps() ?? [];
      const s = ring.length > 0 ? ring[ring.length - 1] : null;
      if (s === null || s === undefined) return 0;
      return s.ents.filter(
        (e) => e.atk !== undefined && Math.hypot(e.x - cx2, e.z - cz2) <= r,
      ).length;
    },
    cx,
    cz,
    radius,
  );

const creepCount = (page, cx, cz, radius) =>
  page.evaluate(
    (cx2, cz2, r, kinds) => {
      const ring = window.__rift?.snaps() ?? [];
      const s = ring.length > 0 ? ring[ring.length - 1] : null;
      if (s === null || s === undefined) return 0;
      return s.ents.filter(
        (e) => kinds.includes(e.k) && e.hp > 0 && Math.hypot(e.x - cx2, e.z - cz2) <= r,
      ).length;
    },
    cx,
    cz,
    radius,
    CREEP_KINDS,
  );

const castEventSeen = (page, entId) =>
  page.evaluate(
    (id) => (window.__rift?.lastEvents() ?? []).some((e) => e.t === 'rift_cast' && e.id === id),
    entId,
  );

/** Cheap guard for the driving loops: the match is running AND we still own a
 *  socket. A terminated socket is the dangerous one — the client keeps
 *  rendering its last snapshot forever, so screenshots stay big and pretty
 *  while showing a frozen world. */
async function assertConnectedLive(page) {
  const s = await riftState(page).catch(() => null);
  if (s === null) throw new Error('window.__rift.state() is unavailable');
  if (s.phase !== 'live') throw new Error(`the match is no longer live (phase ${s.phase})`);
  if (s.connected !== true) {
    throw new Error('the client lost its socket — the room dropped it, every frame from here is stale');
  }
  return s;
}

/** True while the respawn overlay is painted. It is a FULL-SCREEN dim plus a
 *  countdown digit, so a world shot taken over it grades as a dark, muddy
 *  frame no matter how good the art is — measured: `wide-mid` came back
 *  dimmed and stamped "YOU DIED / 3" because the enemy-base scouting run had
 *  just got the hero killed. */
const deathOverlayShown = (page) =>
  page
    .evaluate(() => {
      const el = document.querySelector('.hud .death-overlay');
      return el !== null && el.getClientRects().length > 0;
    })
    .catch(() => false);

/** Block until the hero is up again and the overlay has faded off the frame. */
async function waitAlive(page, timeoutMs) {
  await waitFor(
    async () => {
      await assertConnectedLive(page);
      const you = await latestYou(page);
      return you !== null && you.respawnAtTick === 0 && !(await deathOverlayShown(page));
    },
    timeoutMs,
    'the hero to respawn (the death overlay dims the whole frame)',
  );
  await sleep(RESPAWN_SETTLE_MS); // let the overlay finish fading out
}

/** Any FULL-SCREEN overlay currently painted, or null. Wider than
 *  deathOverlayShown: the countdown and the end screen flood the frame just as
 *  thoroughly, and a judge grading either of them is grading the overlay. */
const overlayShown = (page) =>
  page
    .evaluate((sels) => {
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          if (el.getClientRects().length > 0) return sel;
        }
      }
      return null;
    }, FULLSCREEN_OVERLAYS)
    .catch(() => null);

/** The per-shot gate: connected, live, the snapshot stream actually
 *  advancing, the hero ALIVE, no full-screen overlay, and the requested time
 *  of day PINNED. Nothing is captured over a stalled world, behind the death
 *  dim, or at whatever point of the day/night cycle the match happens to be. */
async function assertLive(page, dayT = DAY_PIN) {
  const a = await assertConnectedLive(page);
  await sleep(FRESH_TICK_MS);
  const b = await assertConnectedLive(page);
  if ((b.tick ?? 0) <= (a.tick ?? 0)) {
    throw new Error(`the snapshot stream stalled (tick stuck at ${String(a.tick)}) — the frame would be stale`);
  }
  const you = await latestYou(page);
  if ((you !== null && you.respawnAtTick > 0) || (await deathOverlayShown(page))) {
    await waitAlive(page, RESPAWN_TIMEOUT_MS);
  }
  const overlay = await overlayShown(page);
  if (overlay !== null) {
    throw new Error(`a full-screen overlay is painted (${overlay}) — the shot would grade the overlay, not the game`);
  }
  if (!(await pinDayPhase(page, dayT))) {
    throw new Error(
      'window.__rift.setDayPhase is missing — the capture would depend on the wall clock, so no two judge rounds ' +
        'could be compared (GRAPHICS_CONTRACT §6 adds setDayPhase(t: number | null) to the debug surface)',
    );
  }
}

/** Block until the chunked terrain + vegetation bakes have finished.
 *  `worldReady(): boolean` is a FROZEN debug-surface member (AMENDMENT_1 §B.5),
 *  so its absence is a contract violation, not a condition to work around: a
 *  fixed settle cannot tell a finished map from a half-built one, and a judge
 *  round shot over an unplanted jungle grades a world that does not exist. */
async function waitWorldBuilt(page) {
  if ((await worldReady(page)) === null) {
    throw new Error(
      'window.__rift.worldReady() is missing — it is frozen by AMENDMENT_1 §B.5 and is the only signal that the ' +
        'chunked terrain + vegetation bakes have finished (contract.ts TerrainHandle.ready/VegetationHandle.ready)',
    );
  }
  await waitFor(async () => (await worldReady(page)) === true, WORLD_READY_TIMEOUT_MS, 'terrain + vegetation bakes to finish');
}

// ---- capture ---------------------------------------------------------------------------------
/** Resize UP to 1920x1080, let the resized scene paint, shoot, drop back to
 *  the cheap working size. The whole 1080p exposure is a couple of frames
 *  instead of the whole match. */
/** Mean and standard deviation of frame luminance, 0..255. The PNG we just
 *  saved is decoded back INSIDE the page (the browser owns a PNG decoder;
 *  node would need one) and sampled at 160px wide. A frame behind a
 *  full-screen dim collapses the mean; a blank or uniformly flooded frame
 *  collapses the standard deviation. */
async function frameStats(page, buf) {
  const b64 = Buffer.from(buf).toString('base64');
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const w = 160;
    const h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * w));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const n = w * h;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < px.length; i += 4) {
      const y = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      sum += y;
      sumSq += y * y;
    }
    const mean = sum / n;
    return { mean, stdDev: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
  }, b64);
}

async function captureRaw(page, name) {
  const file = path.join(OUT_DIR, `${name}.png`);
  const t0 = Date.now();
  await page.setViewport({ ...SHOT_VIEWPORT, deviceScaleFactor: 1 });
  let buf = null;
  try {
    await settle(page, { frames: 3, ms: 120 }); // scene.resize() + a painted frame at the new size
    try {
      buf = await page.screenshot({ path: file, timeout: 30000, optimizeForSpeed: true });
    } catch (err) {
      log(`[warn] ${name}: capture failed (${errText(err)}) — one retry`);
      buf = await page.screenshot({ path: file, timeout: 90000, optimizeForSpeed: true });
    }
  } finally {
    await page.setViewport({ ...WORK_VIEWPORT, deviceScaleFactor: 1 });
  }
  const bytes = statSync(file).size;
  const dc = await drawCalls(page).catch(() => -1);
  const tris = await triangles(page).catch(() => -1);
  const stats = await frameStats(page, buf).catch(() => ({ mean: -1, stdDev: -1 }));
  return { file, bytes, drawCalls: dc, triangles: tris, ...stats, ms: Date.now() - t0 };
}

function record(name, res, error = null) {
  shots.push({
    name,
    file: res === null ? null : path.relative(ROOT, res.file),
    bytes: res === null ? 0 : res.bytes,
    drawCalls: res === null ? -1 : res.drawCalls,
    triangles: res === null ? -1 : res.triangles,
    frameMean: res === null ? -1 : Number(res.mean.toFixed(2)),
    frameStdDev: res === null ? -1 : Number(res.stdDev.toFixed(2)),
    night: NIGHT_SHOTS.has(name),
    ok: error === null,
    error,
  });
  if (error === null) {
    log(
      `shot  ${name} (${(res.bytes / 1024).toFixed(0)}kB, ${res.drawCalls} calls, ${res.triangles} tris, ` +
        `L̄ ${res.mean.toFixed(1)} σ ${res.stdDev.toFixed(1)}, ${(res.ms / 1000).toFixed(1)}s at 1080p)`,
    );
  } else {
    log(`[FAILED] ${name}: ${error}`);
  }
}

/** GRAPHICS_CONTRACT §5 capture liveness, applied to the SAVED frame: a shot
 *  that is dimmer or flatter than a real one is rejected loudly rather than
 *  handed to the judge. DOM-only screens (ui-menu, ui-lobby) are exempt —
 *  they are supposed to be a flat panel over a dark backdrop. */
function assertFrameLive(name, res) {
  if (DOM_ONLY_SHOTS.has(name) || res.mean < 0) return;
  const meanFloor = NIGHT_SHOTS.has(name) ? MIN_FRAME_MEAN_NIGHT : MIN_FRAME_MEAN_DAY;
  if (res.mean < meanFloor) {
    throw new Error(
      `frame mean luminance ${res.mean.toFixed(1)} is below the ${NIGHT_SHOTS.has(name) ? 'night' : 'day'} floor ` +
        `${meanFloor} — the capture came through a dim, or nothing rendered`,
    );
  }
  if (res.stdDev < MIN_FRAME_STDDEV) {
    throw new Error(
      `frame luminance stddev ${res.stdDev.toFixed(1)} is below ${MIN_FRAME_STDDEV} — the frame is flat ` +
        '(blank, or flooded by a full-screen overlay)',
    );
  }
}

/**
 * Take one shot.
 *
 * `frames`/`ms` drive the pre-shot settle. `at` is the world point the camera
 * was aimed at and `level` the zoom rung it was driven to: supplying them turns
 * on the MEASURED framing gate (`assertCamera`), and every in-world shot
 * supplies them. `hero: true` additionally requires the player's hero to be
 * inside the measured footprint — for the shots whose whole subject it is.
 */
async function capture(page, name, opts = {}) {
  const { at = null, level = null, hero = false, ...settleOpts } = opts;
  await settle(page, settleOpts);
  // Re-check at the LAST possible moment: the per-shot gate ran before the
  // zoom and the pan, and a hero can die inside those couple of seconds —
  // measured, that is exactly how a "YOU DIED" dim reached wide-mid.
  if (await deathOverlayShown(page)) {
    log(`[warn] ${name}: the hero died during framing — waiting out the respawn dim`);
    await waitAlive(page, RESPAWN_TIMEOUT_MS);
    await settle(page, settleOpts);
  }
  if (at !== null) {
    const cam = await assertCamera(page, name, at.x, at.z, level);
    if (hero) await assertHeroFramed(page, name, cam);
  }
  const res = await captureRaw(page, name);
  if (res.bytes < MIN_PNG_BYTES) {
    throw new Error(`only ${res.bytes} bytes — the frame did not render`);
  }
  assertFrameLive(name, res);
  record(name, res);
}

/** Run one matrix entry. A failure is recorded and swallowed; the flow goes
 *  on to the next shot. Skipped entries (--only) cost nothing but their
 *  driving, and once every wanted shot is resolved the flow unwinds. */
async function step(name, fn) {
  if (!WANTED.includes(name)) {
    log(`skip  ${name} (--only ${ONLY})`);
    return;
  }
  const before = shots.length;
  try {
    await fn();
    if (shots.length === before) throw new Error('the step produced no screenshot');
  } catch (err) {
    if (shots.length === before) record(name, null, errText(err));
  }
  attempted++;
  if (attempted >= WANTED.length) throw EARLY_DONE;
}

// ---- hero driving ------------------------------------------------------------------------------
/** March the hero to (x,z) and wait until it STANDS there, re-issuing the
 *  order so a stun, a death + respawn or a bumped path never strands it.
 *  The camera is then aimed at the POINT, so the framing is identical every
 *  round regardless of where the hero stopped within the tolerance.
 *
 *  `tolerance` defaults to POSE_TOLERANCE_M. The camp shot passes a tighter
 *  one: its stand-off band is under a metre wide, so the general slop would
 *  swallow it whole. */
async function poseHero(page, x, z, timeoutMs, tolerance = POSE_TOLERANCE_M) {
  const t0 = Date.now();
  for (;;) {
    const you = await latestYou(page).catch(() => null);
    if (you !== null && you.respawnAtTick === 0 && Math.hypot(you.x - x, you.z - z) <= tolerance) {
      await page.evaluate(() => window.__rift.order('stop')).catch(() => {});
      await sleep(400);
      return true;
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`the hero never reached (${x.toFixed(1)}, ${z.toFixed(1)}) within ${timeoutMs}ms`);
    }
    await assertConnectedLive(page);
    await page.evaluate((x2, z2) => window.__rift.order('move', x2, z2), x, z).catch(() => {});
    await sleep(1000);
  }
}

/** Walk the hero at the enemy Ancient so its vision blob EXPLORES the enemy
 *  base — fog is persistent, so wide-base-enemy is a lit frame afterwards
 *  instead of a slab of shroud. Best-effort: the hero usually dies to the
 *  guards on the way in, and every metre it got still stays explored. */
async function scoutEnemyBase(page, ex, ez, timeoutMs) {
  const t0 = Date.now();
  let best = Infinity;
  for (;;) {
    const you = await latestYou(page).catch(() => null);
    if (you !== null) {
      const d = Math.hypot(you.x - ex, you.z - ez);
      if (d < best) best = d;
      if (d <= SCOUT_ARRIVE_M) return best;
    }
    if (Date.now() - t0 > timeoutMs) return best;
    await assertConnectedLive(page);
    await page.evaluate((x2, z2) => window.__rift.order('move', x2, z2), ex, ez).catch(() => {});
    await sleep(1000);
  }
}

/** Walk the hero home after the scouting run. Without this the LAST move
 *  order still points at the enemy Ancient, so the hero respawns and marches
 *  straight back into the guards — and the wide trio that follows keeps
 *  catching the full-screen "YOU DIED" dim (measured). Respawning AT the
 *  fountain satisfies the arrival test immediately, so a death on the way
 *  home simply ends the retreat. */
async function retreatHome(page, ax, az, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const you = await latestYou(page).catch(() => null);
    if (you !== null && you.respawnAtTick === 0 && Math.hypot(you.x - ax, you.z - az) <= RETREAT_SAFE_M) {
      await page.evaluate(() => window.__rift.order('stop')).catch(() => {});
      return true;
    }
    if (Date.now() - t0 > timeoutMs) {
      await page.evaluate(() => window.__rift.order('stop')).catch(() => {});
      return false;
    }
    await assertConnectedLive(page);
    await page.evaluate((x2, z2) => window.__rift.order('move', x2, z2), ax, az).catch(() => {});
    await sleep(1000);
  }
}

// ---- the flow ------------------------------------------------------------------------------------
async function run() {
  const page = await launchOne(WORK_VIEWPORT, 'art');
  try {
    // domcontentloaded, not networkidle0: the app's own waitFor(window.__rift)
    // gate below is the real readiness signal, and an open /ws socket can hold
    // networkidle0 off forever.
    await page.goto(`${BASE}/rift/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitFor(() => page.evaluate(() => window.__rift !== undefined), 20000, 'window.__rift');
    await waitFor(async () => (await riftState(page))?.connected === true, 15000, 'socket connected');

    // -- ui-menu ---------------------------------------------------------------------------------
    await waitFor(() => page.evaluate(() => document.querySelector('.menu') !== null), 10000, 'menu root (.menu)');
    await step('ui-menu', async () => {
      await capture(page, 'ui-menu');
    });

    // -- ui-lobby --------------------------------------------------------------------------------
    await page.evaluate((s) => window.__rift.createPrivate('ArtDirector', s), ROOM_SETTINGS);
    await waitFor(async () => (await riftState(page))?.phase === 'lobby', 15000, 'phase lobby after create_private');
    await waitFor(
      () => page.evaluate(() => document.querySelectorAll('.pick-grid .pick-card').length >= 6),
      10000,
      'hero pick grid (6 .pick-card)',
    );
    await page.evaluate((h) => window.__rift.pick(h), HERO_PICK);
    await step('ui-lobby', async () => {
      await capture(page, 'ui-lobby', { ms: 600 });
    });

    // -- live ------------------------------------------------------------------------------------
    await page.evaluate(() => window.__rift.start());
    await waitFor(
      async () => {
        const s = await riftState(page);
        return s !== null && s.phase === 'live' && s.you !== null && (s.tick ?? 0) > 5 ? s : null;
      },
      LIVE_TIMEOUT_MS,
      'phase live with snapshots',
    );

    // The 3-LANE ASSERTION. rift_begin is a raw frame in net.ts's 4000-entry
    // message ring — at ~40 snaps/s it is evicted within a couple of minutes,
    // so it is read HERE, seconds after the match started, not at the end.
    const begin = await page.evaluate(
      () => (window.__rift.messageLog().find((m) => m !== null && typeof m === 'object' && m.t === 'rift_begin') ?? null),
    );
    if (begin === null) throw new Error('no rift_begin frame in the message log — cannot prove the lane count');
    if (begin.lanes !== WANT_LANES) {
      throw new Error(
        `the room compiled a ${String(begin.lanes)}-lane map (teamSize ${String(begin.teamSize)}) — the art matrix needs the ${WANT_LANES}-lane map; fix ROOM_SETTINGS.teamSize`,
      );
    }
    log(`live: ${String(begin.lanes)} lanes, teamSize ${String(begin.teamSize)}, side ${MAP_SIDE}`);
    // Before ANY in-world shutter: prove the socket carries the fields this matrix reasons about.
    // Everything downstream — the night trio, `waitDayPhaseBelow`, the camp stand-off vision
    // arithmetic — reads `dayPhase` through a client parse that cannot fail, so this is the last
    // point at which a server that never sends it is distinguishable from a full day.
    await assertWireProtocol();
    await waitWorldBuilt(page);
    log(
      `terrain facts: river ${JSON.stringify(FACTS.river)} cliff edge ${JSON.stringify(FACTS.cliff)} ` +
        `jungle wall ${JSON.stringify(FACTS.wall)} brute camp ${JSON.stringify(FACTS.brute)}`,
    );

    // -- geometry, mirrored so team 1 gets the same frames -----------------------------------------
    const team = (await riftState(page))?.team ?? 0;
    const own = team === 0 ? { x: BASE_INSET, z: BASE_INSET } : { x: MAP_SIDE - BASE_INSET, z: MAP_SIDE - BASE_INSET };
    const enemy = team === 0 ? { x: MAP_SIDE - BASE_INSET, z: MAP_SIDE - BASE_INSET } : { x: BASE_INSET, z: BASE_INSET };
    const mid = { x: MAP_SIDE / 2, z: MAP_SIDE / 2 };
    const dx = enemy.x - own.x;
    const dz = enemy.z - own.z;
    const dl = Math.hypot(dx, dz);
    const dir = { x: dx / dl, z: dz / dl }; // own -> enemy, along the mid lane
    const perp = { x: -dir.z, z: dir.x }; // left of travel (map.ts handedness)
    const along = (t) => ({ x: own.x + dx * t, z: own.z + dz * t });
    const offset = (p, m) => ({ x: p.x + perp.x * m, z: p.z + perp.z * m });

    // Terrain targets are chosen in half 0 and mirrored the same way the
    // diagonal poses are, so a team-1 seat gets the identical frames.
    const mirrorT = (p) => (p === null ? null : team === 0 ? { x: p.x, z: p.z } : { x: MAP_SIDE - p.x, z: MAP_SIDE - p.z });
    if (FACTS.side !== MAP_SIDE) {
      throw new Error(
        `buildTerrain(${WANT_LANES}) says side ${FACTS.side} but this harness frames against ${MAP_SIDE} — ` +
          'the map-size constants have drifted apart',
      );
    }
    const riverP = mirrorT(FACTS.river);
    const cliffP = mirrorT(FACTS.cliff);
    const wallP = mirrorT(FACTS.wall);
    const campP = mirrorT(FACTS.brute === null ? null : { x: FACTS.brute.x, z: FACTS.brute.z });

    const poseP = along(POSE_T); // hero pose for close-hero / fx-cast
    const decoP = offset(poseP, DECO_OFFSET_M); // hero pose for close-deco
    const decoCam = offset(poseP, DECO_OFFSET_M + DECO_CAM_OFFSET_M);
    const fogP = offset(poseP, FOG_OFFSET_M); // explored corridor -> shroud boundary
    const castP = along(POSE_T + 0.07); // ~7.4 m up the lane: inside longbow_q's 14 m range
    log(
      `team ${String(team)}: own base (${own.x}, ${own.z}), pose (${poseP.x.toFixed(1)}, ${poseP.z.toFixed(1)}), deco (${decoP.x.toFixed(1)}, ${decoP.z.toFixed(1)}), fog (${fogP.x.toFixed(1)}, ${fogP.z.toFixed(1)})`,
    );

    // Structures come straight out of the snapshot but are pure map facts:
    // the friendly MID-lane towers are the pair closest to the base diagonal
    // (|x - z| ~ 0 on the mid lane); "near" is the one closer to our Ancient.
    const structs = await structures(page);
    const ownTowers = structs
      .filter((s) => s.k === 'tower' && s.team === team)
      .sort((a, b) => Math.abs(a.x - a.z) - Math.abs(b.x - b.z) || a.id - b.id);
    const midTowers = ownTowers
      .slice(0, 2)
      .sort((a, b) => Math.hypot(a.x - own.x, a.z - own.z) - Math.hypot(b.x - own.x, b.z - own.z) || a.id - b.id);
    const tower = midTowers[0] ?? { x: mid.x, z: mid.z };
    const ownAncient = structs.find((s) => s.k === 'ancient' && s.team === team) ?? own;
    const enemyAncient = structs.find((s) => s.k === 'ancient' && s.team !== team) ?? enemy;
    log(`friendly mid-lane near tower at (${tower.x.toFixed(1)}, ${tower.z.toFixed(1)})`);

    // -- hud-live: default zoom on the friendly mid-lane tower ---------------------------------
    await step('hud-live', async () => {
      await assertLive(page);
      await zoomTo(page, 'default');
      await panTo(page, tower.x, tower.z);
      await capture(page, 'hud-live', { ms: 800, at: tower, level: 'default' });
    });

    // -- ui-shop ---------------------------------------------------------------------------------
    await step('ui-shop', async () => {
      await assertLive(page);
      await page.evaluate(() => document.querySelector('.gold-readout')?.click());
      await waitFor(
        () =>
          page.evaluate(() => {
            const el = document.querySelector('.shop-panel');
            return el !== null && getComputedStyle(el).display !== 'none';
          }),
        8000,
        'shop panel open (.shop-panel visible)',
      );
      await capture(page, 'ui-shop', { ms: 400, at: tower, level: 'default' });
    });
    await page.evaluate(() => {
      const el = document.querySelector('.shop-panel');
      if (el !== null && getComputedStyle(el).display !== 'none') document.querySelector('.gold-readout')?.click();
    });

    // -- ui-scoreboard (TAB held) -----------------------------------------------------------------
    await step('ui-scoreboard', async () => {
      await assertLive(page);
      await page.keyboard.down('Tab');
      try {
        await capture(page, 'ui-scoreboard', { ms: 300, at: tower, level: 'default' });
      } finally {
        await page.keyboard.up('Tab');
      }
    });

    // -- mid-lane: the middle lane during an active creep engagement -------------------------------
    await step('mid-lane', async () => {
      await assertLive(page);
      await zoomTo(page, 'default');
      await panTo(page, mid.x, mid.z);
      await waitFor(
        async () => (await creepContact(page, mid.x, mid.z, CLASH_NEAR_MID_M)) <= CLASH_CONTACT_M,
        CLASH_TIMEOUT_MS,
        `opposing creeps within ${CLASH_CONTACT_M}m of each other near the map centre`,
      );
      await capture(page, 'mid-lane', { ms: 500, at: mid, level: 'default' });
    });

    // -- close-creeps: closest zoom on a wave ---------------------------------------------------------
    await step('close-creeps', async () => {
      await assertLive(page);
      await zoomTo(page, 'in');
      await panTo(page, mid.x, mid.z);
      await waitFor(
        async () => (await creepCount(page, mid.x, mid.z, CREEPS_RADIUS_M)) >= CREEPS_MIN,
        CREEPS_TIMEOUT_MS,
        `${CREEPS_MIN} creeps within ${CREEPS_RADIUS_M}m of the map centre`,
      );
      await capture(page, 'close-creeps', { ms: 500, at: mid, level: 'in' });
    });

    // -- fx-combat: tracers / bursts / damage numbers on screen -------------------------------------
    await step('fx-combat', async () => {
      await assertLive(page);
      await zoomTo(page, 'default');
      await panTo(page, mid.x, mid.z);
      await waitFor(
        async () => (await attackerCount(page, mid.x, mid.z, COMBAT_RADIUS_M)) >= COMBAT_ATTACKERS,
        COMBAT_TIMEOUT_MS,
        `${COMBAT_ATTACKERS} units swinging within ${COMBAT_RADIUS_M}m of the map centre`,
      );
      await capture(page, 'fx-combat', { frames: 1, ms: 0, at: mid, level: 'default' });
    });

    // -- fog-edge: BEFORE the off-lane poses, which would explore this corner ---------------------------
    await step('fog-edge', async () => {
      await assertLive(page);
      await zoomTo(page, 'default');
      await panTo(page, fogP.x, fogP.z);
      await capture(page, 'fog-edge', { ms: 900, at: fogP, level: 'default' }); // the fog mask refreshes at ~5Hz
    });

    // -- close-tower / close-ancient: pure map facts, no waiting ------------------------------------------
    await step('close-tower', async () => {
      await assertLive(page);
      await zoomTo(page, 'in');
      await panTo(page, tower.x, tower.z);
      await capture(page, 'close-tower', { ms: 600, at: tower, level: 'in' });
    });
    await step('close-ancient', async () => {
      await assertLive(page);
      await zoomTo(page, 'in');
      await panTo(page, ownAncient.x, ownAncient.z);
      await capture(page, 'close-ancient', { ms: 600, at: ownAncient, level: 'in' });
    });

    // ==========================================================================
    // THE HERO SHOTS. Pose the hero on the mid lane, then frame the POINT — and
    // be willing to do it again.
    //
    // There is a live match running between the pose and the shutter: the
    // camera has to be driven to a clamp and back (a couple of seconds of wheel
    // events), the frame has to settle, and a level-1 hero standing 30% of the
    // way down the mid lane at night, among sixteen bots, dies in that window
    // often enough to matter. `capture` already waits out the respawn dim, but
    // the hero respawns AT ITS FOUNTAIN, 41 m away — measured — so waiting is
    // not enough on its own: the shot has to be re-posed.
    //
    // Before the framing gate existed this simply produced a hero-less frame
    // that passed every check the harness had, which is how the shipped
    // `night-close-hero.png` came to be a photograph of the "YOU DIED" screen.
    // ==========================================================================
    const HERO_SHOT_TRIES = 3;
    let posed = false;
    const heroShot = async (name, point, settleMs, dayT) => {
      let lastErr = null;
      for (let attempt = 1; attempt <= HERO_SHOT_TRIES; attempt++) {
        try {
          await assertLive(page, dayT);
          await poseHero(page, point.x, point.z, POSE_TIMEOUT_MS);
          posed = true;
          await zoomTo(page, 'in');
          await panTo(page, point.x, point.z);
          await capture(page, name, { ms: settleMs, at: point, level: 'in', hero: true });
          return;
        } catch (err) {
          lastErr = err;
          if (attempt < HERO_SHOT_TRIES) log(`[warn] ${name}: attempt ${attempt} lost the hero (${errText(err)}) — re-posing`);
        }
      }
      throw lastErr;
    };

    await step('close-hero', async () => {
      await heroShot('close-hero', poseP, 600, DAY_PIN);
    });

    // -- fx-cast: level Q, fire it up the lane, shoot the effect --------------------------------------------
    await step('fx-cast', async () => {
      await assertLive(page);
      if (!posed) await poseHero(page, poseP.x, poseP.z, POSE_TIMEOUT_MS);
      await zoomTo(page, 'default');
      await panTo(page, poseP.x, poseP.z);
      await page.evaluate((s) => window.__rift.skill(s), CAST_SLOT);
      await waitFor(
        async () => ((await latestYou(page))?.rank0 ?? 0) >= 1,
        SKILL_TIMEOUT_MS,
        `ability slot ${CAST_SLOT} levelled (rank >= 1)`,
      );
      const id = await selfEntId(page);
      if (id < 0) throw new Error('own hero entity not found in the snapshot');
      await settle(page, { frames: 2, ms: 200 });
      // Same measured framing gate the other shots get. The camera check is
      // hoisted out of the loop below because the camera does not move once the
      // loop starts; the HERO check cannot be, because the hero can die inside
      // it — so each attempt re-checks that it still has a hero to photograph
      // and re-poses when it does not.
      await assertCamera(page, 'fx-cast', poseP.x, poseP.z, 'default');

      let last = null;
      let lastErr = 'the cast never fired';
      for (let attempt = 0; attempt < CAST_ATTEMPTS; attempt++) {
        const you = await latestYou(page);
        if (you === null || you.respawnAtTick > 0) {
          lastErr = 'the hero was dead at every cast attempt';
          await sleep(CAST_RETRY_MS);
          continue;
        }
        if (Math.hypot(you.x - poseP.x, you.z - poseP.z) > POSE_TOLERANCE_M) {
          // Died and respawned at the fountain, or got displaced: this frame
          // would have no hero in it, and the FX would be off screen with it.
          lastErr = 'the hero left the framed point';
          await poseHero(page, poseP.x, poseP.z, POSE_TIMEOUT_MS);
          continue;
        }
        if (you.cd0 > you.matchTick) {
          lastErr = 'the ability never came off cooldown';
          await sleep(CAST_RETRY_MS);
          continue;
        }
        // fire and shoot the very next frames — the effect is short-lived
        await page.evaluate(
          (slot, x, z) => window.__rift.cast(slot, x, z),
          CAST_SLOT,
          castP.x,
          castP.z,
        );
        await settle(page, { frames: 1, ms: 0 });
        last = await captureRaw(page, 'fx-cast');
        if (last.bytes < MIN_PNG_BYTES) {
          lastErr = `only ${last.bytes} bytes — the frame did not render`;
        } else if (await castEventSeen(page, id)) {
          // The cast landed — but the frame still has to be a live, un-dimmed
          // one, exactly like every other in-world shot.
          try {
            assertFrameLive('fx-cast', last);
          } catch (err) {
            lastErr = errText(err);
            await sleep(CAST_RETRY_MS);
            continue;
          }
          record('fx-cast', last);
          return;
        } else {
          lastErr = 'no rift_cast event for the own hero followed the cast';
        }
        await sleep(CAST_RETRY_MS);
      }
      record('fx-cast', last, lastErr);
    });

    // -- close-deco: hero posed off-lane so its vision lights the scatter -------------------------------------
    await step('close-deco', async () => {
      await assertLive(page);
      await poseHero(page, decoP.x, decoP.z, POSE_TIMEOUT_MS);
      await zoomTo(page, 'in');
      await panTo(page, decoCam.x, decoCam.z);
      await capture(page, 'close-deco', { ms: 900, at: decoCam, level: 'in' });
    });

    // ==========================================================================
    // TERRAIN SHOTS (GRAPHICS_CONTRACT §5's frozen judge list). Each poses the
    // hero on the nearest PASSABLE cell to the subject — vision is what lights
    // the frame, and none of these subjects is somewhere a hero can stand:
    // a cliff cell is impassable by definition, and a river/foliage/camp cell
    // is only walkable by accident of where the generator put it.
    // ==========================================================================
    const terrainShot = async (name, target, level, settleMs, before = null) => {
      await step(name, async () => {
        if (target === null) {
          throw new Error(`buildTerrain(${WANT_LANES}) produced no cell for this shot — the terrain model is missing a §5 feature`);
        }
        await assertLive(page);
        if (before === null) {
          const stand = FACTS.nearestPassable(target.x, target.z);
          await poseHero(page, stand.x, stand.z, POSE_TIMEOUT_MS);
        } else {
          await before(target);
        }
        await assertLive(page);
        await zoomTo(page, level);
        await panTo(page, target.x, target.z);
        await capture(page, name, { ms: settleMs, at: target, level });
      });
    };

    await terrainShot('river-mid', riverP, 'default', 700);
    await terrainShot('camp-brute', campP, 'in', 600, async (p) => {
      // Stand off the clearing centre on the map-centre side, inside the band
      // ./rift-terrain-facts.mjs derives: far enough out that the camp does not
      // acquire a loitering hero (AGGRO_RADIUS 7 measured from a member resting
      // 1.6 m off centre), close enough in that a member is still inside hero
      // vision AFTER `nightVisionScale` has taken it down to 8.25 m. The old
      // 10.5 m was derived against day vision alone and put the nearest member
      // ~8.9 m out, so this shot simply stopped working past dayPhase ≈ 0.79.
      const stand = FACTS.campStand(p.x, p.z, mid.x, mid.z);
      if (stand === null) {
        throw new Error(
          `no passable cell ${CAMP_STAND_MIN_M}-${CAMP_STAND_MAX_M}m from the brute clearing ` +
            `(${p.x.toFixed(1)}, ${p.z.toFixed(1)}) — the hero cannot be posed where the camp is both safe and visible`,
        );
      }
      log(`camp-brute: stand-off cell (${stand.x.toFixed(1)}, ${stand.z.toFixed(1)}), ${stand.d.toFixed(2)}m from the clearing centre`);
      // Wait for the SERVER's day phase BEFORE marching. The renderer pin
      // (assertLive -> setDayPhase) fixes the lighting and nothing else: vision
      // radii are the server's, driven by the real matchTick, and
      // DAY_PERIOD_S 600 at speed 5 is a 120-second WALL cycle. Unpinned, this
      // shot was taken at whatever phase the match happened to be in and the
      // fog disc around the hero — the only thing lighting an off-lane frame —
      // changed size from round to round. That is not a threshold to relax; it
      // is the shot not being reproducible.
      await waitDayPhaseBelow(page, CAMP_SHOT_MAX_DAY_PHASE);
      await poseHero(page, stand.x, stand.z, POSE_TIMEOUT_MS, CAMP_POSE_TOLERANCE_M);
      await waitFor(
        async () => (await neutralsNear(page, p.x, p.z, CAMP_VISIBLE_M)) > 0,
        CAMP_VISIBLE_TIMEOUT_MS,
        `neutral camp creeps within ${CAMP_VISIBLE_M}m of the brute clearing (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`,
      );
      await assertCampStandOff(page, p.x, p.z);
      await assertDayPhaseBelow(page, CAMP_SHOT_MAX_DAY_PHASE_AT_SHOT, 'camp-brute');
    });
    await terrainShot('high-ground', cliffP, 'cam24', 700);
    await terrainShot('jungle-wall', wallP, 'cam24', 700);

    // -- reveal the enemy base, then the wide trio ------------------------------------------------------
    let scouted = Infinity;
    try {
      await assertLive(page);
      scouted = await scoutEnemyBase(page, enemyAncient.x, enemyAncient.z, SCOUT_TIMEOUT_MS);
      log(`scout: closest approach to the enemy Ancient ${scouted.toFixed(1)}m (persistent fog reveal)`);
      // The scouting run leaves the hero's LAST order pointing at the enemy
      // Ancient, so it respawns and marches straight back into the guards —
      // and the wide trio below then keeps catching the "YOU DIED" dim
      // (measured). Walking it home is what stops that.
      const home = await retreatHome(page, ownAncient.x, ownAncient.z, SCOUT_TIMEOUT_MS);
      log(`retreat: hero ${home ? 'is home at its own fountain' : 'never made it home — the wide trio may catch a respawn'}`);
    } catch (err) {
      log(`[warn] enemy-base scout aborted (${errText(err)}) — wide-base-enemy may be shrouded`);
    }

    await step('wide-mid', async () => {
      await assertLive(page);
      await zoomTo(page, 'out');
      await panTo(page, mid.x, mid.z);
      await capture(page, 'wide-mid', { ms: 900, at: mid, level: 'out' });
    });
    await step('wide-base-own', async () => {
      await assertLive(page);
      await zoomTo(page, 'out');
      await panTo(page, ownAncient.x, ownAncient.z);
      await capture(page, 'wide-base-own', { ms: 900, at: ownAncient, level: 'out' });
    });
    await step('wide-base-enemy', async () => {
      await assertLive(page);
      await zoomTo(page, 'out');
      await panTo(page, enemyAncient.x, enemyAncient.z);
      await capture(page, 'wide-base-enemy', { ms: 900, at: enemyAncient, level: 'out' });
    });

    // ==========================================================================
    // NIGHT TRIO — the SAME three framings the day matrix already graded, at
    // dayPhase 1. Nothing else changes, so the judge is comparing lighting and
    // only lighting (DESIGN_DELTA §5: night is the state where a dark world lit
    // by team colours, braziers and ability FX is at its strongest).
    // ==========================================================================
    await step('night-mid-lane', async () => {
      await assertLive(page, NIGHT_PIN);
      await zoomTo(page, 'default');
      await panTo(page, mid.x, mid.z);
      await capture(page, 'night-mid-lane', { ms: 700, at: mid, level: 'default' });
    });
    await step('night-close-hero', async () => {
      await heroShot('night-close-hero', poseP, 700, NIGHT_PIN);
    });
    await step('night-wide-mid', async () => {
      await assertLive(page, NIGHT_PIN);
      await zoomTo(page, 'out');
      await panTo(page, mid.x, mid.z);
      await capture(page, 'night-wide-mid', { ms: 900, at: mid, level: 'out' });
    });

    // Hand the renderer back to the snapshot clock — a pinned scene would
    // outlive this page in any --keep-server debugging session.
    await pinDayPhase(page, null);
  } catch (err) {
    if (err !== EARLY_DONE) throw err;
    log('every requested shot resolved — stopping early');
  } finally {
    await closePage(page);
  }
}

// ---- main ------------------------------------------------------------------------------------------
if (WANTED.length === 0) {
  console.error(`[art] --only ${String(ONLY)} matches no shot; known: ${SHOT_ORDER.join(', ')}`);
  // Same manifest SHAPE as the real verdict below — a consumer must never have
  // to special-case the "nothing matched" run.
  console.log(
    JSON.stringify({
      ok: false,
      outDir: path.relative(ROOT, OUT_DIR),
      worstDrawCalls: 0,
      worstTriangles: 0,
      overBudget: [],
      pageErrors: [],
      pageWarnings: [],
      shots: [],
    }),
  );
  process.exit(1);
}

await mkdir(OUT_DIR, { recursive: true });
// self-cleaning: a shot that fails this round must not leave last round's PNG
// behind for the judge to grade as if it were fresh.
for (const name of WANTED) await rm(path.join(OUT_DIR, `${name}.png`), { force: true });

let fatal = null;
try {
  FACTS = terrainFacts(await loadTerrain(), WANT_LANES);
  CONFIG = await loadConfig();
  // Fail here, before a server is even started, if a balance edit has moved the
  // camp stand-off band out from under the constants it was derived from.
  assertCampBand(CONFIG);
  await startServer();
  await waitForServer();
  await assertProductionMount();
  log(`platform server up on :${PORT} (built mount verified) — ${WANTED.length} shot(s) into ${path.relative(ROOT, OUT_DIR)}`);
  await run();
} catch (err) {
  fatal = errText(err);
  log(`[FATAL] ${fatal}`);
} finally {
  tearingDown = true;
  for (const b of browsers.splice(0)) {
    try {
      await b.close();
    } catch {
      // already gone
    }
  }
  if (serverChild !== null && !KEEP_SERVER) {
    serverChild.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => serverChild.once('exit', r)),
      sleep(5000).then(() => serverChild.kill('SIGKILL')),
    ]);
  }
}

// ---- verdict -------------------------------------------------------------------------------------------
const got = new Set(shots.map((s) => s.name));
for (const name of WANTED) {
  if (!got.has(name)) {
    shots.push({
      name,
      file: null,
      bytes: 0,
      drawCalls: -1,
      triangles: -1,
      frameMean: -1,
      frameStdDev: -1,
      night: NIGHT_SHOTS.has(name),
      ok: false,
      error: fatal ?? 'never reached',
    });
  }
}
shots.sort((a, b) => SHOT_ORDER.indexOf(a.name) - SHOT_ORDER.indexOf(b.name));

const failed = shots.filter((s) => !s.ok);
const worstDrawCalls = Math.max(0, ...shots.map((s) => s.drawCalls));
const worstTriangles = Math.max(0, ...shots.map((s) => s.triangles));
// This harness is the ART loop, not the perf gate (verify-rift owns the
// budgets) — but a matrix captured over budget is a matrix of frames nobody
// can ship, so an overrun is reported here as a failed run rather than left
// for someone to notice in the manifest.
const overBudget = [];
if (worstDrawCalls > DRAW_CALL_BUDGET) overBudget.push(`draw calls ${worstDrawCalls} > ${DRAW_CALL_BUDGET}`);
if (worstTriangles > TRIANGLE_BUDGET) overBudget.push(`triangles ${worstTriangles} > ${TRIANGLE_BUDGET}`);
if (badServerExit !== null) {
  overBudget.push(`the platform server exited mid-run (code ${badServerExit.code}, signal ${badServerExit.signal})`);
}
for (const m of overBudget) log(`[FAILED] ${m}`);

const ok = failed.length === 0 && pageErrors.length === 0 && overBudget.length === 0;
log(
  ok
    ? `GREEN: ${shots.length}/${WANTED.length} shots, worst draw calls ${worstDrawCalls}/${DRAW_CALL_BUDGET}, ` +
      `worst triangles ${worstTriangles}/${TRIANGLE_BUDGET}, zero page errors`
    : `RED: ${failed.length} failed shot(s) [${failed.map((s) => s.name).join(', ')}], ${pageErrors.length} page error(s)` +
      (overBudget.length > 0 ? `, ${overBudget.length} budget/health failure(s)` : ''),
);
for (const e of pageErrors.slice(0, 12)) log(`  ${e}`);
// Warnings never fail the run on their own (the wire-naming subset was already promoted into
// pageErrors), but they are REPORTED — dropping them on the floor is what let a one-shot
// "rift_snap carries no dayPhase" warning pass unread through a whole judge round.
if (pageWarnings.length > 0) log(`${pageWarnings.length} console warning(s):`);
for (const w of pageWarnings.slice(0, 12)) log(`  ${w}`);

console.log(
  JSON.stringify({
    ok,
    outDir: path.relative(ROOT, OUT_DIR),
    worstDrawCalls,
    worstTriangles,
    overBudget,
    pageErrors,
    pageWarnings,
    shots,
  }),
);
process.exit(ok ? 0 : 1);

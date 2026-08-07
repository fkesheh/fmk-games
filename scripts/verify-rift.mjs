#!/usr/bin/env node
// ============================================================================
// verify-rift — VISUAL + PERF VERIFICATION for ANCIENTS (rift).
//
// Serves the BUILT platform on RIFT_VERIFY_PORT (default 8092; 8091 and 8080
// belong to siblings — never touch them), drives the frozen window.__rift
// debug surface (CONTRACT §6 + GRAPHICS_CONTRACT §6) with puppeteer, captures
// the shot list for the art/UX judge loops, and asserts the perf + health
// budgets. Client dist must already exist — this harness NEVER rebuilds (run
// `npm run build` first).
//
// THE ROOM (GRAPHICS_CONTRACT §5): every budget in §5 is specified at
//   "3-lane / 8v8 peak with camps populated", so the rooms that measure them
//   are created with teamSize 8 — LANES_FOR_TEAM_SIZE[8] = 3, side = 128, four
//   camps per half, and the room bot-fills to sixteen heroes. A teamSize-2 room
//   compiles the 1-lane 96 m map with two heroes and four camps total, and a
//   draw-call budget measured on THAT proves nothing about the map players get.
//   The overlay-state rooms below stay small on purpose: they photograph DOM,
//   not the world, and they derive their own map size from their own lane count.
//
// SHOT LIST (each at 1280x720, 1920x1080 and 2560x1080 — 16:9 pair + one 21:9):
//   menu, lobby (hero pick grid), live-hud (default zoom), live-close (closest
//   zoom, camH 18), shop (panel open), scoreboard (TAB held), combat (creep
//   engagement at mid lane), fog-edge (shroud boundary at an unexplored map
//   corner). Saved under screenshots/rift/ (artifacts — never committed).
//   shop and scoreboard are IN-WORLD shots: their panels sit over the live
//   scene, the §5 liveness gate applies to them like any other world frame, and
//   the day-luminance floors below were calibrated from exactly those frames.
//
// WORLD-STATE SHOTS (1920x1080 only — GRAPHICS_CONTRACT §5's frozen judge shot
//   list; capture-rift-art.mjs shoots the same seven states art-directed, this
//   harness shoots them to MEASURE them, because jungle density and night are
//   the two states that actually spend the draw-call and triangle budgets):
//   high-ground (cliff face + plateau), river-mid, camp-brute, jungle-wall,
//   night-wide-mid, night-mid-lane, night-close-hero.
//   Every camera target is a TERRAIN FACT read from buildTerrain(lanes) in
//   this process — terrain is a pure function of the lane count
//   (TERRAIN_CONTRACT §1), so the same cells come back every round and the
//   framing cannot drift. Targets are chosen in half 0 and mirrored through the
//   map centre for a team-1 seat; NO target is ever a live entity coordinate,
//   which is already in world space and would be reflected into the enemy half.
//
// OVERLAY STATE SHOTS (1920x1080 only — the §8 state ladder the per-viewport
//   flow never reaches):
//   countdown (lobby STARTING IN n… readout, shot immediately after start()),
//   death (death overlay + respawn count; the human hero is driven into the
//   enemy base with order() until it dies — the room runs at speed 2 so the
//   6.5s-game respawn window is ~3.2s of wall clock, capturable), end (the
//   rift_end stats screen — a second room at speed 20 resolves in ~1-4 min of
//   wall clock, the e2e approach; the match runs at 640x360 because a
//   1080p headless client cannot drain the ~400 snaps/s stream (the server
//   drops it as a dead peer) and is resized UP for the capture inside the 20s
//   ended-phase dwell; if an end dwells out before we look, the poller
//   re-starts the room and catches the next one), disconnect (the
//   platform server is SIGTERMed, the banner captured, then the server is
//   restarted and the client's own reconnect must hide the banner again).
//
// ASSERTIONS (exit non-zero on ANY failure):
//   - every shot landed as a non-trivial PNG;
//   - zero console/page/request errors on any page;
//   - the platform server never exited non-zero while we were driving it;
//   - WebGL context actually created and NO .error-banner in the DOM;
//   - HUD roots exist during live: .hud .ability-bar .item-bar .topbar
//     .minimap .killfeed;
//   - drawCalls() in (0, 700] and triangles() in (0, 1.2M] (GRAPHICS_CONTRACT
//     §5). Both meters accumulate across post passes because scene.ts sets
//     renderer.info.autoReset = false and calls reset() exactly once at the top
//     of render(dtMs) — that is WHY the budget rose from 400, and it is also
//     why a collapsed meter is a real risk. §5 requires the meters be proven
//     LIVE by showing the reported count RISES when a pass is added to the
//     frame, so the proof is a controlled A/B on one page at one camera target:
//     the closest framing (camH 18, ~36 m of ground) against the widest (camH
//     55, the whole map). Every extra chunk and instance that enters the
//     frustum is another pass through the renderer, so a live meter must go UP.
//     A meter that was reset per composer pass reports the LAST pass alone — a
//     constant near 1 — and cannot rise at all.
//   - EVERY in-world shot is taken on a live, un-overlaid frame: phase 'live',
//     the local hero alive, no full-screen overlay painted, and the captured
//     PNG measurably brighter and more varied than a dimmed one. A baseline
//     capture was previously taken through the death-screen dim and nobody
//     noticed (GRAPHICS_CONTRACT §5) — that is what these three checks exist
//     to make impossible.
//   - dayPhase is PINNED via window.__rift.setDayPhase(t) before every
//     in-world shot: 0 for day, 1 for night. An unpinned day/night cycle makes
//     every capture wall-clock dependent and the whole judge loop worthless.
//   - the countdown readout, the death overlay, the ended phase and the
//     disconnect banner each actually APPEARED (not just a screenshot taken
//     around them), and the banner hid again after the server came back.
//
// SUBPROCESS DISCIPLINE: the platform server is the only child process, and it
// is never judged by its piped output — its exit code and signal are recorded
// on the 'exit' event and asserted. This harness gates everything downstream;
// a false green here invalidates the entire judge loop.
//
// The LAST stdout line is a JSON manifest: one entry per shot {shot, viewport,
// file, bytes, drawCalls, triangles, frameMean, frameStdDev, pageErrors} plus a
// summary — the judge loops pair every shot with its numbers from there. Server
// chatter goes to stderr.
//
// Flags: --keep-server (leave the platform server up for debugging).
// ============================================================================
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { CAMP_APPROACH_M, CAMP_VISIBLE_M, loadTerrain, terrainFacts } from './rift-terrain-facts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.RIFT_VERIFY_PORT ?? 8092);
const BASE = `http://localhost:${PORT}`;
const SERVER_ENTRY = path.join(ROOT, 'platform/server/dist/server.js');
const OUT_DIR = path.join(ROOT, 'screenshots', 'rift');

const VIEWPORTS = [
  { width: 1280, height: 720, tag: '1280x720' },
  { width: 1920, height: 1080, tag: '1920x1080' },
  { width: 2560, height: 1080, tag: '2560x1080' }, // 21:9
];
const SHOT_NAMES = ['menu', 'lobby', 'live-hud', 'live-close', 'shop', 'scoreboard', 'combat', 'fog-edge'];

// GRAPHICS_CONTRACT §5 specifies every budget at "3-lane / 8v8 peak with camps
// populated". LANES_FOR_TEAM_SIZE[8] = 3 -> side = MAP_SIDE_BASE(96) +
// MAP_SIDE_PER_LANE(16) * 2 = 128, four camps per half (CAMPS_PER_HALF[3]), and
// the room bot-fills both sides to eight heroes. speed 5 keeps a 20-minute
// match several times longer than this run.
const ROOM_SETTINGS = { teamSize: 8, speed: 5 };
const LANES = 3; // LANES_FOR_TEAM_SIZE[8]
const HERO_PICK = 'reaver';
// Filled by loadFacts() inside the fatal handler in main — NOT at module scope.
let TERRAIN = null;
let FACTS = null;
let MAP_SIDE = 0; // buildTerrain(LANES).grid.side — read, never assumed
let MID = 0; // mid-lane clash point (64, 64) at 3 lanes

// GRAPHICS_CONTRACT §5. Both meters accumulate across the post passes (see the
// header), which is exactly why the draw-call budget rose from its old 400.
const DRAW_CALL_BUDGET = 700;
const TRIANGLE_BUDGET = 1_200_000;

// A composer that reset renderer.info per pass reports the LAST pass alone —
// one fullscreen quad, i.e. a count of about 1. Any real accumulated frame is
// far above this floor, and no single-quad final pass can reach it.
const MIN_LIVE_DRAW_CALLS = 8;

const DRAW_SAMPLES = 5;
const DRAW_SAMPLE_MS = 300;
const MIN_PNG_BYTES = 5000;
const COMBAT_MIN_TICK = 1200; // 60s game-time at 20Hz — waves have clashed at mid
const ZOOM_STEPS_IN = 10; // 36m -> 18m clamp (1/1.12 per step)
const ZOOM_STEPS_OUT = 6; // back to ≈ default 36m

// ---- day / night pins -----------------------------------------------------------
// TERRAIN_CONTRACT §6 / contract.ts: 0 = full day, 1 = full night. EVERY
// in-world shot pins one of these through window.__rift.setDayPhase, so no
// capture depends on where the match clock happened to be.
const DAY_PIN = 0;
const NIGHT_PIN = 1;

// ---- frame liveness floors ------------------------------------------------------
// MEASURED, not invented. Over a run of this harness the in-world day frames
// came back at mean 33.1 / 36.2 / 30.0 / 49.5 with stddev 26.6 / 25.8 / 22.3 /
// 35.8 (live-hud, shop, scoreboard, live-close at 1280x720). The floors below
// sit at roughly half the lowest measured mean and a quarter of the lowest
// measured stddev — far enough under a real frame to never fire on one, far
// enough over a dimmed or blank one to always fire on that. A frame taken
// through the full-screen death dim, or a frame that never rendered, collapses
// BOTH statistics: the dim multiplies every pixel down, and a blank/uniform
// frame has almost no variance at all. Day and night get separate means
// because night is authored dark on purpose — holding a night shot to the day
// floor would fail the feature, not the frame.
const MIN_FRAME_STDDEV = 6; // 0..255 luminance; a flat or dimmed frame is far below
const MIN_FRAME_MEAN_DAY = 18;
const MIN_FRAME_MEAN_NIGHT = 6;
// Elements that cover the whole frame. `.shop-panel` and `.scoreboard` are NOT
// here: they are panels the shop/scoreboard shots exist to photograph.
const FULLSCREEN_OVERLAYS = ['.hud .death-overlay', '.death-overlay', '.end-screen', '.lobby-start', '.modal'];

// ---- world-state shots (1920x1080 only) -----------------------------------------
const WORLD_VIEWPORT = { width: 1920, height: 1080, tag: '1920x1080' };
const WORLD_SHOTS = [
  'high-ground',
  'river-mid',
  'camp-brute',
  'jungle-wall',
  'night-wide-mid',
  'night-mid-lane',
  'night-close-hero',
];
// The world room is the one the §5 budgets are specified against: same 3-lane
// 8v8 peak as ROOM_SETTINGS, because these seven states — jungle density and
// night — are where the draw-call and triangle budgets are actually spent.
const WORLD_ROOM_SETTINGS = { teamSize: 8, speed: 5 };
const WORLD_POSE_TIMEOUT_MS = 90000;
const WORLD_POSE_TOLERANCE_M = 2.5;
const WORLD_READY_TIMEOUT_MS = 60000;
const CAMP_VISIBLE_TIMEOUT_MS = 30000;
// The night trio reuses the day framings. `night-close-hero` needs a hero in
// frame, so it poses one at a MAP FACT — a fixed fraction along the own->enemy
// diagonal, expressed in half-0 coordinates so `mirror()` maps it onto the
// team's OWN half. A live hero coordinate must never be used here: it is
// already in world space, and mirroring it on a team-1 seat frames the enemy
// half — the one shot whose entire purpose is a close hero would then be
// guaranteed not to contain one.
const NIGHT_HERO_T = 0.3;

// ---- overlay state captures (1920x1080 only) -------------------------------------
const OVERLAY_VIEWPORT = { width: 1920, height: 1080, tag: '1920x1080' };
const OVERLAY_SHOTS = ['countdown', 'death', 'end', 'disconnect'];
// The overlay rooms photograph DOM (countdown readout, death dim, end stats,
// disconnect banner), not the world, so they are deliberately NOT the 8v8
// budget room: a small map keeps the death march short and the speed-20 end
// room drainable. They therefore compile their OWN map, and their ancient
// coordinates are derived from THEIR lane count — reusing the 3-lane MAP_SIDE
// here would march the hero at a point 21 m outside a 96 m map.
const OVERLAY_LANES = 1; // LANES_FOR_TEAM_SIZE[2]
// speed 2: a match lasts 6+ wall-minutes (the disconnect capture needs the
// room still live) and the level-1 respawn (6.5 game-s) is ~3.2s of wall
// clock — long enough to detect + screenshot the death overlay.
const OVERLAY_ROOM_SETTINGS = { teamSize: 2, speed: 2 };
// speed 20 (the e2e hook, CONTRACT §2): a match resolves in ~1-4 min wall.
const END_ROOM_SETTINGS = { teamSize: 2, speed: 20 };
const BASE_INSET = 11; // config.ts — ancient distance from its corner
let OVERLAY_MAP_SIDE = 0; // buildTerrain(OVERLAY_LANES).grid.side — 96
const DEATH_TIMEOUT_MS = 150000;
const END_TIMEOUT_MS = Number(process.env.RIFT_END_TIMEOUT ?? 360000); // 6 min
const COUNTDOWN_TIMEOUT_MS = 4500; // LOBBY_COUNTDOWN_MS 3000 + slack
const RECONNECT_TIMEOUT_MS = 60000; // net.ts backoff caps at 10s

const KEEP_SERVER = process.argv.slice(2).includes('--keep-server');

// ---- state ---------------------------------------------------------------------
const manifest = [];
const pageErrors = [];
const failures = [];
const browsers = [];
let serverChild = null;
let serverExit = null;
let tearingDown = false;
let expectDisconnect = false; // disconnect capture: ws errors are the POINT, not noise
let badServerExit = null; // a non-zero/unsignalled death we did not ask for

const T0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const elapsed = () => `${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s`;
const log = (msg) => console.error(`[${elapsed()}] ${msg}`); // stdout ends with the JSON manifest
const errText = (err) => (err instanceof Error ? err.message : String(err));
const fail = (msg) => {
  failures.push(msg);
  log(`[FAILED] ${msg}`);
};
/** A missing debug-surface accessor is one defect, not one per page that trips
 *  over it — report it once and keep the manifest readable. */
const reportedOnce = new Set();
const failOnce = (key, msg) => {
  if (reportedOnce.has(key)) return;
  reportedOnce.add(key);
  fail(msg);
};

// ============================================================================
// TERRAIN FACTS — every world-shot camera target, derived not guessed. The
// derivation itself lives in ./rift-terrain-facts.mjs so this harness, the art
// matrix and the e2e suite cannot drift apart on it (they already had).
//
// LOADED HERE, NOT AT MODULE SCOPE: the Node-version check and the
// type-stripped import of terrain.ts can both throw, and at module scope that
// killed the process before the try/catch below existed — so the harness died
// without printing the JSON manifest the judge loop reads. A load failure is
// now a recorded failure like any other, and the manifest still ships.
// ============================================================================
async function loadFacts() {
  TERRAIN = await loadTerrain();
  FACTS = terrainFacts(TERRAIN, LANES);
  MAP_SIDE = FACTS.side;
  MID = MAP_SIDE / 2;
  OVERLAY_MAP_SIDE = TERRAIN.buildTerrain(OVERLAY_LANES).grid.side;
}

const mirrorFor = (team) => (p) => (team === 0 ? { x: p.x, z: p.z } : { x: FACTS.side - p.x, z: FACTS.side - p.z });

// ---- server ----------------------------------------------------------------------
async function startServer() {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(`missing ${path.relative(ROOT, SERVER_ENTRY)} — run 'npm run build' first`);
  }
  const inUse = await fetch(BASE, { signal: AbortSignal.timeout(1500) }).then(
    () => true,
    () => false,
  );
  if (inUse) throw new Error(`something is already listening on :${PORT} — kill it or set RIFT_VERIFY_PORT`);
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
    if (tearingDown || expectDisconnect) return;
    // A server that dies on us is a REAL defect, not shutdown noise: every page
    // silently keeps rendering its last snapshot, so the screenshots stay big
    // and pretty while the world is frozen. Recorded by exit code — never
    // inferred from the piped log.
    badServerExit = { code, signal };
    process.stderr.write(`[server] EXITED mid-run (code ${code}, signal ${signal}) — every page just lost its socket.\n`);
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

// ---- browser ---------------------------------------------------------------------
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

function trackErrors(page, tag) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = m.location()?.url ?? '';
    if (/favicon/.test(url) || /favicon/.test(m.text())) return;
    // Shutdown noise only: a killed server makes every client log socket errors.
    if ((tearingDown || serverExit !== null || expectDisconnect) && /WebSocket connection to .* failed/.test(m.text())) return;
    pageErrors.push(`[${tag}] console.error: ${m.text()} (${url})`);
  });
  page.on('pageerror', (e) => pageErrors.push(`[${tag}] pageerror: ${e.message}`));
  page.on('error', (e) => pageErrors.push(`[${tag}] page CRASHED: ${e.message}`));
  page.on('requestfailed', (r) => {
    if (/favicon/.test(r.url())) return;
    pageErrors.push(`[${tag}] requestfailed: ${r.url()} — ${r.failure()?.errorText ?? '?'}`);
  });
}

/** GL backends, best first. The BACKEND decides whether a live 3-lane 8v8
 *  socket survives a long run: measured on this box, ANGLE/Metal renders this
 *  scene in ~17 ms a frame at 1080p and SwiftShader in ~418 ms, and at
 *  SwiftShader speed the renderer stops draining the WebSocket data pipe long
 *  enough to miss two protocol pongs, after which the server terminates the
 *  socket and every later frame is a frozen last-snapshot render. So a hardware
 *  backend is REQUESTED first (--use-angle=default is Metal on macOS, the
 *  native driver elsewhere); the plain launch and SwiftShader remain fallbacks,
 *  and the chosen rung is logged because it is the single biggest predictor of
 *  a flaky round. */
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
        log(`[${tag}] [warn] SOFTWARE rendering — frames cost ~25x a GPU frame; the 8v8 socket may be dropped mid-run`);
      }
      trackErrors(page, tag);
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
  const browser = page.__browser;
  if (browser === undefined) return;
  const i = browsers.indexOf(browser);
  if (i >= 0) browsers.splice(i, 1);
  try {
    await browser.close();
  } catch {
    // already gone
  }
}

// ---- helpers ---------------------------------------------------------------------
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

/** Wait on fonts + rendered frames, then a short settle. */
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
  await sleep(ms);
}

const riftState = (page) => page.evaluate(() => window.__rift?.state() ?? null);
const drawCalls = (page) => page.evaluate(() => window.__rift?.drawCalls() ?? -1);

/** Per-frame triangle count (GRAPHICS_CONTRACT §5). -1 means the meter is not
 *  exposed at all, which is itself a failure — the triangle budget is what
 *  stops the whole map being merged into one unculled mesh. */
const triangles = (page) =>
  page.evaluate(() => (typeof window.__rift?.triangles === 'function' ? window.__rift.triangles() : -1));

/** `true` once terrain AND vegetation have finished their chunked bakes
 *  (TerrainHandle.ready() && VegetationHandle.ready(), reported by R_WIRE).
 *  `null` when the accessor does not exist. */
const worldReady = (page) =>
  page.evaluate(() => (typeof window.__rift?.worldReady === 'function' ? window.__rift.worldReady() : null));

/** Pin the renderer's time of day. Returns false when the debug surface has no
 *  setDayPhase — in which case the shot MUST NOT be taken: an unpinned cycle
 *  makes the capture depend on the wall clock. */
const pinDayPhase = (page, t) =>
  page.evaluate((v) => {
    if (typeof window.__rift?.setDayPhase !== 'function') return false;
    window.__rift.setDayPhase(v);
    return true;
  }, t);

/** The local hero's live row, or null. */
const latestYou = (page) =>
  page.evaluate(() => {
    const ring = window.__rift?.snaps() ?? [];
    const s = ring.length > 0 ? ring[ring.length - 1] : null;
    if (s === null || s === undefined || s.you === null || s.you === undefined) return null;
    return { x: s.you.x, z: s.you.z, hp: s.you.hp, respawnAtTick: s.you.respawnAtTick };
  });

/** Mean and standard deviation of frame luminance, 0..255, computed by
 *  decoding the PNG we just saved back INSIDE the page (the browser owns a
 *  PNG decoder; node would need one) and sampling it at 160px wide. A frame
 *  behind the death dim collapses the mean; a blank or uniformly flooded frame
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

/** GRAPHICS_CONTRACT §5 capture liveness. Refuses to photograph a dead hero,
 *  a non-live phase or a full-screen overlay — the measured defect this exists
 *  to prevent is a baseline `wide-mid` taken through the death dim. */
async function assertShootable(page, name) {
  const s = await riftState(page);
  if (s === null) throw new Error(`${name}: window.__rift.state() is unavailable`);
  if (s.phase !== 'live') throw new Error(`${name}: client phase is '${s.phase}', not 'live' — the frame is not the game`);
  const you = await latestYou(page);
  if (you !== null && you.respawnAtTick > 0) {
    throw new Error(`${name}: the local hero is dead (respawnAtTick ${you.respawnAtTick}) — the frame comes through the death dim`);
  }
  const shown = await page.evaluate((sels) => {
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.getClientRects().length > 0) return sel;
      }
    }
    return null;
  }, FULLSCREEN_OVERLAYS);
  if (shown !== null) throw new Error(`${name}: a full-screen overlay is painted (${shown}) — the shot would grade the overlay, not the game`);
}

async function shot(page, name, vp, { night = false, inWorld = false } = {}) {
  const file = path.join(OUT_DIR, `${name}-${vp.tag}.png`);
  const t0 = Date.now();
  if (inWorld) await assertShootable(page, `${name}-${vp.tag}`);
  let buf;
  try {
    buf = await page.screenshot({ path: file, timeout: 30000 });
  } catch (err) {
    log(`[warn] ${name}-${vp.tag}: capture failed (${errText(err)}) — one retry`);
    buf = await page.screenshot({ path: file, timeout: 90000 });
  }
  const bytes = statSync(file).size;
  if (bytes < MIN_PNG_BYTES) {
    throw new Error(`shot '${name}-${vp.tag}' is only ${bytes} bytes — the frame did not render`);
  }
  const stats = await frameStats(page, buf).catch(() => ({ mean: -1, stdDev: -1 }));
  const dc = await drawCalls(page);
  const tris = await triangles(page);
  manifest.push({
    shot: name,
    viewport: vp.tag,
    file: path.relative(ROOT, file),
    bytes,
    drawCalls: dc,
    triangles: tris,
    frameMean: Number(stats.mean.toFixed(2)),
    frameStdDev: Number(stats.stdDev.toFixed(2)),
    inWorld,
    night,
    pageErrors: pageErrors.length,
  });
  if (inWorld) {
    const meanFloor = night ? MIN_FRAME_MEAN_NIGHT : MIN_FRAME_MEAN_DAY;
    if (stats.mean >= 0 && stats.mean < meanFloor) {
      fail(
        `${name}-${vp.tag}: frame mean luminance ${stats.mean.toFixed(1)} is below the ${night ? 'night' : 'day'} floor ${meanFloor} — ` +
          'the capture came through a dim or never rendered',
      );
    }
    if (stats.stdDev >= 0 && stats.stdDev < MIN_FRAME_STDDEV) {
      fail(
        `${name}-${vp.tag}: frame luminance stddev ${stats.stdDev.toFixed(1)} is below ${MIN_FRAME_STDDEV} — ` +
          'the frame is flat (blank, or flooded by a full-screen overlay)',
      );
    }
  }
  log(
    `shot  ${name}-${vp.tag} (${(bytes / 1024).toFixed(0)}kB, ${((Date.now() - t0) / 1000).toFixed(1)}s, ` +
      `${dc} calls, ${tris} tris, L̄ ${stats.mean.toFixed(1)} σ ${stats.stdDev.toFixed(1)})`,
  );
}

/** Pan the camera by clicking the minimap canvas (world [0,side]^2 maps
 *  linearly onto it — ui/minimap.ts pointerdown -> actions.panCameraTo). */
async function minimapPan(page, u, v) {
  const rect = await page.$eval('.minimap canvas', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  await page.mouse.click(rect.x + u * rect.w, rect.y + v * rect.h);
}

/** Aim the camera at a WORLD point. */
const panTo = (page, x, z) => minimapPan(page, x / MAP_SIDE, z / MAP_SIDE);

/** Wheel-zoom `steps` notches; dir -1 zooms in (lower camH), +1 out. */
async function zoom(page, vp, steps, dir) {
  await page.mouse.move(vp.width / 2, vp.height / 2);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel({ deltaY: dir > 0 ? 240 : -240 });
    await sleep(70);
  }
}

// input.ts ZOOM_STEP = 1.12/notch, game.ts clamps camH to [18, 55]. 12 notches
// move 3.9x — more than the 3.06x range — so 12 notches in either direction
// always lands ON a clamp, which is what makes a rung reproducible.
const ZOOM_CLAMP_STEPS = 12;
const ZOOM_RUNGS = {
  out: 0, // the 55 m clamp
  default: 4, // 4 notches in from 55 -> 34.96 m
  in: ZOOM_CLAMP_STEPS, // the 18 m clamp
};
const HIGH_GROUND_STEPS_FROM_IN = 3; // 18 * 1.12^3 = 25.29 m ~= §5's camH 24
//   (the wheel is multiplicative, so 24 is not exactly reachable; this is the
//   nearest rung that is, and it is reached from a clamp so it never drifts)

let zoomLevel = null;
async function zoomTo(page, vp, level) {
  if (zoomLevel === level) return;
  await zoom(page, vp, ZOOM_CLAMP_STEPS, +1); // -> the 55 m clamp
  if (level === 'campH24') {
    await zoom(page, vp, ZOOM_CLAMP_STEPS, -1); // -> the 18 m clamp
    await zoom(page, vp, HIGH_GROUND_STEPS_FROM_IN, +1); // -> 25.29 m
  } else {
    const steps = ZOOM_RUNGS[level] ?? 0;
    if (steps > 0) await zoom(page, vp, steps, -1);
  }
  zoomLevel = level;
}

// ---- the per-viewport flow ---------------------------------------------------------
async function captureViewport(vp) {
  const tag = vp.tag;
  const page = await launchOne(vp, tag);
  zoomLevel = null;
  const stateAt = async (label) => JSON.stringify(await riftState(page).catch(() => null)) || `(no state — ${label})`;
  try {
    // domcontentloaded, not networkidle0: the app's own waitFor(window.__rift)
    // gate below is the real readiness signal, and an open /ws socket can hold
    // networkidle0 off forever on a reused server (measured: pages 2+ timed out
    // at 30s with the client already connected and in phase 'menu').
    await page.goto(`${BASE}/rift/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitFor(() => page.evaluate(() => window.__rift !== undefined), 20000, 'window.__rift');
    await waitFor(
      async () => (await riftState(page))?.connected === true,
      15000,
      'socket connected',
    );

    // -- menu -------------------------------------------------------------------------
    await waitFor(
      () => page.evaluate(() => document.querySelector('.menu') !== null),
      10000,
      'menu root (.menu)',
    );
    await settle(page);
    await shot(page, 'menu', vp);

    // -- lobby (hero pick grid) ---------------------------------------------------------
    await page.evaluate((s) => window.__rift.createPrivate('Verify', s), ROOM_SETTINGS);
    await waitFor(
      async () => ((await riftState(page))?.phase ?? null) === 'lobby',
      15000,
      'phase lobby after create_private',
    );
    await waitFor(
      () => page.evaluate(() => document.querySelectorAll('.pick-grid .pick-card').length >= 6),
      10000,
      'hero pick grid (6 .pick-card)',
    );
    await settle(page);
    await shot(page, 'lobby', vp);

    // -- start -> live ------------------------------------------------------------------
    await page.evaluate((h) => window.__rift.pick(h), HERO_PICK);
    await page.evaluate(() => window.__rift.start());
    await waitFor(
      async () => {
        const s = await riftState(page);
        return s !== null && s.phase === 'live' && s.you !== null && (s.tick ?? 0) > 5 ? s : null;
      },
      45000,
      `phase live with snapshots (last: ${await stateAt('pre-live')})`,
    );
    await waitWorldBuilt(page, tag);
    if (!(await pinDayPhase(page, DAY_PIN))) {
      failOnce(
        'setDayPhase',
        `${tag}: window.__rift.setDayPhase is missing — every in-world capture is wall-clock dependent and no two judge rounds compare`,
      );
    }
    await settle(page, { ms: 600 });
    await shot(page, 'live-hud', vp, { inWorld: true });

    // -- HUD roots (CONTRACT §6 DOM class contract) ---------------------------------------
    const missingRoots = await page.evaluate(() => {
      const want = ['.hud', '.ability-bar', '.item-bar', '.topbar', '.minimap', '.killfeed'];
      return want.filter((sel) => document.querySelector(sel) === null);
    });
    if (missingRoots.length > 0) fail(`${tag}: HUD roots missing during live: ${missingRoots.join(', ')}`);

    // -- live at closest zoom (camH 18) ---------------------------------------------------
    await zoom(page, vp, ZOOM_STEPS_IN, -1);
    await settle(page);
    await shot(page, 'live-close', vp, { inWorld: true });
    await zoom(page, vp, ZOOM_STEPS_OUT, +1);

    // -- shop open -------------------------------------------------------------------------
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
    await settle(page);
    // inWorld: the shop is a panel over the LIVE scene, not a DOM screen. The
    // day-luminance floors in this file were calibrated from the shop and
    // scoreboard frames, so exempting them from the §5 liveness gate exempted
    // exactly the two frames the thresholds were measured on.
    await shot(page, 'shop', vp, { inWorld: true });
    await page.evaluate(() => document.querySelector('.gold-readout')?.click());

    // -- scoreboard (TAB held) --------------------------------------------------------------
    await page.keyboard.down('Tab');
    await settle(page, { ms: 250 });
    await shot(page, 'scoreboard', vp, { inWorld: true });
    await page.keyboard.up('Tab');

    // -- combat moment: waves clash at mid; pan there and measure both meters ------------------
    await waitFor(
      async () => {
        const s = await riftState(page);
        if (s === null) return null;
        if ((s.tick ?? 0) >= COMBAT_MIN_TICK) return s;
        const evs = await page.evaluate(() => window.__rift.lastEvents().map((e) => e.t));
        return evs.includes('rift_kill') || evs.includes('rift_cast') ? s : null;
      },
      60000,
      `creep engagement (tick >= ${COMBAT_MIN_TICK} or a kill/cast event)`,
    );
    await minimapPan(page, 0.5, 0.5); // mid-lane clash point (the map centre)
    await settle(page, { ms: 800 }); // interp + the 5Hz fog mask refresh
    const { calls: maxDrawCalls, tris: maxTriangles } = await sampleMeters(page);
    log(
      `${tag}: live combat — draw calls max ${maxDrawCalls}/${DRAW_CALL_BUDGET}, ` +
        `triangles max ${maxTriangles}/${TRIANGLE_BUDGET} over ${DRAW_SAMPLES} samples`,
    );
    if (maxDrawCalls <= 0) {
      fail(`${tag}: drawCalls() returned ${maxDrawCalls} during live combat — the renderer is not drawing (or the debug surface is dead)`);
    } else if (maxDrawCalls > DRAW_CALL_BUDGET) {
      fail(`${tag}: drawCalls() ${maxDrawCalls} exceeds the ${DRAW_CALL_BUDGET} budget during live combat`);
    }
    if (maxTriangles < 0) {
      failOnce(
        'triangles',
        `${tag}: window.__rift.triangles() is missing — GRAPHICS_CONTRACT §5's 1.2M triangle budget cannot be measured, ` +
          'and a draw-call budget alone is gameable by merging the map into one unculled mesh',
      );
    } else if (maxTriangles === 0) {
      fail(`${tag}: triangles() returned 0 during live combat — the meter is dead or renderer.info was reset a second time`);
    } else if (maxTriangles > TRIANGLE_BUDGET) {
      fail(`${tag}: triangles() ${maxTriangles} exceeds the ${TRIANGLE_BUDGET} budget during live combat`);
    }
    await shot(page, 'combat', vp, { inWorld: true });

    // -- fog boundary at the map edge ---------------------------------------------------------
    // (u 0.97, v 0.03) -> the far off-lane corner, which neither team explores
    // — the frame shows the shroud meeting the explored lane corridor.
    await minimapPan(page, 0.97, 0.03);
    await settle(page, { ms: 800 });
    await shot(page, 'fog-edge', vp, { inWorld: true });

    // -- health: no VISIBLE error-banner, WebGL alive --------------------------------------------
    // The menu owns a permanently-mounted .error-banner (menus.ts) that sits at
    // display:none in the healthy state; the WebGL/boot fallbacks (scene.ts,
    // main.ts) only append theirs on failure — so the defect signal is a
    // banner that is actually shown, not one that merely exists.
    const banner = await page.evaluate(() => {
      for (const el of document.querySelectorAll('.error-banner')) {
        if (getComputedStyle(el).display !== 'none') return true;
      }
      return false;
    });
    if (banner) fail(`${tag}: a .error-banner is visible — the client fell back to its error state`);
    const glAlive = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
    if (!glAlive) fail(`${tag}: WebGL context could not be created`);
  } catch (err) {
    fail(`${tag}: ${errText(err)} (state: ${await stateAt('failure')})`);
  } finally {
    await closePage(page);
  }
}

// ---- the world-state flow (1920x1080 only) ------------------------------------------

/** Block until the chunked terrain + vegetation bakes have finished. A jungle
 *  shot of an unplanted jungle measures nothing, and the bakes are explicitly
 *  budgeted to spread over 300 ms of frames (GRAPHICS_CONTRACT §5). */
async function waitWorldBuilt(page, tag) {
  const probe = await worldReady(page);
  if (probe === null) {
    failOnce(
      'worldReady',
      `${tag}: window.__rift.worldReady() is missing — the harness cannot tell a finished map from a half-built one, ` +
        'so every world shot may photograph a jungle mid-bake (contract.ts TerrainHandle.ready/VegetationHandle.ready)',
    );
    await settle(page, { frames: 10, ms: 1500 });
    return;
  }
  await waitFor(async () => (await worldReady(page)) === true, WORLD_READY_TIMEOUT_MS, 'terrain + vegetation bakes to finish');
}

/** March the hero to (x,z) and wait until it STANDS there, re-issuing the
 *  order so a stun, a death + respawn or a bumped path never strands it. The
 *  camera is then aimed at the POINT, not at the hero, so the framing is
 *  identical every round regardless of where inside the tolerance it stopped. */
async function poseHero(page, x, z, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const you = await latestYou(page).catch(() => null);
    if (you !== null && you.respawnAtTick === 0 && Math.hypot(you.x - x, you.z - z) <= WORLD_POSE_TOLERANCE_M) {
      await page.evaluate(() => window.__rift.order('stop')).catch(() => {});
      await sleep(400);
      return;
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`the hero never reached (${x.toFixed(1)}, ${z.toFixed(1)}) within ${timeoutMs}ms`);
    }
    await page.evaluate((x2, z2) => window.__rift.order('move', x2, z2), x, z).catch(() => {});
    await sleep(1000);
  }
}

/** Neutral (team 2) camp entities within `radius` of a clearing centre. */
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

/** Max drawCalls()/triangles() over DRAW_SAMPLES reads, so one unlucky frame
 *  cannot decide a budget or a liveness verdict. */
async function sampleMeters(page) {
  let calls = -1;
  let tris = -1;
  for (let i = 0; i < DRAW_SAMPLES; i++) {
    const dc = await drawCalls(page);
    const tr = await triangles(page);
    if (dc > calls) calls = dc;
    if (tr > tris) tris = tr;
    await sleep(DRAW_SAMPLE_MS);
  }
  return { calls, tris };
}

/**
 * GRAPHICS_CONTRACT §5's meter-liveness proof: "the reported count RISES when a
 * pass is added".
 *
 * It is a controlled A/B on ONE page at ONE camera target, so the only variable
 * is how much of the world the frustum contains: the closest rung (camH 18,
 * ~36 m of ground, a handful of 16 m chunks) against the widest (camH 55, the
 * whole map). Every additional chunk and instanced archetype that enters the
 * frustum is another pass through the renderer, so a live accumulating meter
 * must report a strictly higher count at the wide rung.
 *
 * This is not the old "at least 2 distinct values across the shot list" test.
 * That one could false-fail a perfectly correct build whenever two unrelated
 * framings happened to agree, and it then blamed autoReset for a coincidence.
 * The two rungs here differ by construction, and the only ways they can tie are
 * the two defects §5 actually cares about: a meter reset per composer pass
 * (which reports a constant), or a single map-wide merge with no frustum
 * culling (which §5 bans in the same paragraph).
 */
async function measureMeterLiveness(page, vp, tag) {
  try {
    await zoomTo(page, vp, 'in');
    await panTo(page, MID, MID);
    await settle(page, { ms: 700 });
    const near = await sampleMeters(page);
    await zoomTo(page, vp, 'out');
    await panTo(page, MID, MID);
    await settle(page, { ms: 700 });
    const wide = await sampleMeters(page);
    log(
      `${tag}: meter liveness at the map centre — camH 18: ${near.calls} calls / ${near.tris} tris, ` +
        `camH 55: ${wide.calls} calls / ${wide.tris} tris`,
    );

    if (near.calls < 0) {
      failOnce('drawCalls', `${tag}: window.__rift.drawCalls() is missing — the §5 draw-call budget cannot be measured at all`);
      return;
    }
    if (near.calls < MIN_LIVE_DRAW_CALLS) {
      fail(
        `${tag}: drawCalls() reported ${near.calls} on a live 3-lane 8v8 frame, below the ${MIN_LIVE_DRAW_CALLS} floor — ` +
          'that is the signature of renderer.info being reset per composer pass, so the meter is reporting one ' +
          'fullscreen quad instead of the accumulated frame (GRAPHICS_CONTRACT §5)',
      );
    } else if (wide.calls <= near.calls) {
      fail(
        `${tag}: drawCalls() did not rise when passes were added to the frame (camH 18: ${near.calls}, camH 55: ${wide.calls}) — ` +
          'either renderer.info is reset per pass, or the map is one unculled merge, both banned by GRAPHICS_CONTRACT §5',
      );
    }

    if (near.tris < 0) {
      failOnce(
        'triangles',
        `${tag}: window.__rift.triangles() is missing — §5's 1.2M triangle budget cannot be measured, and a draw-call ` +
          'budget alone is gameable by merging the map into one unculled mesh',
      );
      return;
    }
    if (near.tris === 0) {
      fail(`${tag}: triangles() reported 0 on a live frame — the meter is dead or renderer.info was reset a second time`);
    } else if (wide.tris <= near.tris) {
      fail(
        `${tag}: triangles() did not rise when passes were added to the frame (camH 18: ${near.tris}, camH 55: ${wide.tris}) — ` +
          'the triangle meter is not accumulating across the frame',
      );
    }
  } catch (err) {
    fail(`${tag}: meter liveness: ${errText(err)}`);
  }
}

async function captureWorldStates(vp) {
  const tag = 'world';
  const page = await launchOne(vp, tag);
  zoomLevel = null;
  try {
    await page.goto(`${BASE}/rift/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitFor(() => page.evaluate(() => window.__rift !== undefined), 20000, 'window.__rift');
    await waitFor(async () => (await riftState(page))?.connected === true, 15000, 'socket connected (world)');
    await page.evaluate((s) => window.__rift.createPrivate('VerifyWorld', s), WORLD_ROOM_SETTINGS);
    await waitFor(async () => ((await riftState(page))?.phase ?? null) === 'lobby', 15000, 'world-room lobby');
    await page.evaluate((h) => window.__rift.pick(h), HERO_PICK);
    await page.evaluate(() => window.__rift.start());
    const live = await waitFor(
      async () => {
        const s = await riftState(page);
        return s !== null && s.phase === 'live' && s.you !== null && (s.tick ?? 0) > 5 ? s : null;
      },
      45000,
      'world-room live',
    );
    await waitWorldBuilt(page, tag);

    const mirror = mirrorFor(live.team ?? 0);
    if (FACTS.cliff === null || FACTS.river === null || FACTS.wall === null || FACTS.brute === null) {
      fail(
        `${tag}: buildTerrain(${LANES}) produced no ${[
          FACTS.cliff === null ? 'cliff edge' : null,
          FACTS.river === null ? 'river cell' : null,
          FACTS.wall === null ? 'lane-adjacent foliage' : null,
          FACTS.brute === null ? 'brute camp in half 0' : null,
        ]
          .filter((v) => v !== null)
          .join(', ')} — the terrain model is missing a feature the frozen judge shot list requires`,
      );
    }

    /** One world shot: pin the phase, pose the hero so its vision lights the
     *  subject, frame the POINT, assert the frame is live and shoot it. */
    const worldShot = async (name, target, level, dayT, { pose = true, before = null } = {}) => {
      if (target === null) {
        fail(`${tag}: ${name} skipped — no terrain point (see above)`);
        return;
      }
      try {
        const p = mirror(target);
        if (pose) {
          const stand = FACTS.nearestPassable(p.x, p.z);
          await poseHero(page, stand.x, stand.z, WORLD_POSE_TIMEOUT_MS);
        }
        if (before !== null) await before(p);
        if (!(await pinDayPhase(page, dayT))) {
          failOnce(
            'setDayPhase',
            'window.__rift.setDayPhase is missing — the world/night shots would not be reproducible, so they are not captured',
          );
          fail(`${tag}: ${name} not captured (dayPhase unpinnable)`);
          return;
        }
        await zoomTo(page, vp, level);
        await panTo(page, p.x, p.z);
        await settle(page, { ms: 900 }); // interp + the 5Hz fog mask refresh
        await shot(page, name, vp, { inWorld: true, night: dayT === NIGHT_PIN });
      } catch (err) {
        fail(`${tag}: ${name}: ${errText(err)}`);
      }
    };

    // Day states first: they explore ground the night trio then reuses.
    await worldShot('high-ground', FACTS.cliff, 'campH24', DAY_PIN);
    await worldShot('river-mid', FACTS.river, 'default', DAY_PIN);
    await worldShot(
      'camp-brute',
      FACTS.brute === null ? null : { x: FACTS.brute.x, z: FACTS.brute.z },
      'in',
      DAY_PIN,
      {
        // `pose: false` is load-bearing. The default pose walks the hero onto
        // the nearest passable cell to the TARGET — the clearing centre — which
        // is inside the camp, and `before` then walks it back out again: two
        // 90 s marches, and a hero that is usually dead by the end of the first
        // one, after which assertShootable throws and the shot is lost. The
        // stand-off march below is the only pose this shot needs.
        pose: false,
        before: async (p) => {
          const c = { x: MAP_SIDE / 2, z: MAP_SIDE / 2 };
          const dx = c.x - p.x;
          const dz = c.z - p.z;
          const dl = Math.hypot(dx, dz) || 1;
          const stand = FACTS.nearestPassable(p.x + (dx / dl) * CAMP_APPROACH_M, p.z + (dz / dl) * CAMP_APPROACH_M);
          await poseHero(page, stand.x, stand.z, WORLD_POSE_TIMEOUT_MS);
          await waitFor(
            async () => (await neutralsNear(page, p.x, p.z, CAMP_VISIBLE_M)) > 0,
            CAMP_VISIBLE_TIMEOUT_MS,
            `neutral camp entities within ${CAMP_VISIBLE_M}m of the brute clearing (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`,
          );
        },
      },
    );
    await worldShot('jungle-wall', FACTS.wall, 'campH24', DAY_PIN);

    // Night trio: the same three framings the day matrix already grades, so a
    // judge can diff day against night with nothing else changed.
    //
    // night-close-hero's target is a MAP FACT in half-0 coordinates — a fixed
    // fraction along the own->enemy diagonal between the two ancients — so
    // mirror() lands it on the seated team's OWN half, and `pose: true` puts a
    // hero on it. Framing a live hero coordinate instead would double-mirror on
    // a team-1 seat and photograph empty enemy jungle.
    const anc0 = BASE_INSET;
    const anc1 = MAP_SIDE - BASE_INSET;
    const nightHero = { x: anc0 + (anc1 - anc0) * NIGHT_HERO_T, z: anc0 + (anc1 - anc0) * NIGHT_HERO_T };
    await worldShot('night-mid-lane', { x: MID, z: MID }, 'default', NIGHT_PIN);
    await worldShot('night-wide-mid', { x: MID, z: MID }, 'out', NIGHT_PIN, { pose: false });
    await worldShot('night-close-hero', nightHero, 'in', NIGHT_PIN);

    // The §5 meter-liveness proof, on this room because it is the 3-lane 8v8
    // one the budgets are specified against.
    await measureMeterLiveness(page, vp, tag);

    // Hand the renderer back to the snapshot clock: leaving it pinned would
    // outlive this page in any --keep-server debugging session.
    await pinDayPhase(page, null);
  } catch (err) {
    fail(`${tag}: ${errText(err)}`);
  } finally {
    await closePage(page);
  }
}

// ---- the overlay-state flow (1920x1080 only) --------------------------------------

/** goto + the app's own readiness gates (window.__rift, socket connected). */
async function connectClient(page, tag) {
  await page.goto(`${BASE}/rift/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitFor(() => page.evaluate(() => window.__rift !== undefined), 20000, 'window.__rift');
  await waitFor(
    async () => (await riftState(page))?.connected === true,
    15000,
    `socket connected (${tag})`,
  );
}

/** True when `sel` is actually painted — getClientRects() (unlike computed
 *  display) also honours a display:none ANCESTOR such as the hidden .hud root. */
const domVisible = (page, sel) =>
  page
    .evaluate((s) => {
      const el = document.querySelector(s);
      return el !== null && el.getClientRects().length > 0;
    }, sel)
    .catch(() => false);

/** Drive the human hero into the enemy base until the death overlay appears.
 *  Move orders are re-issued so a stun/interrupt never strands the hero. */
async function driveToDeath(page, x, z, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    if (await domVisible(page, '.hud .death-overlay')) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await page.evaluate((x2, z2) => window.__rift.order('move', x2, z2), x, z).catch(() => {});
    await sleep(1200);
  }
}

/** The speed-20 end room cycles live -> ended -> lobby (MATCH_END_MS dwell);
 *  if its end flashed past while we weren't looking, re-start it (picks are
 *  kept) and catch the next one. If the speed-20 snap stream got the client
 *  dropped as a dead peer (the room vanishes: phase lands back on 'menu'),
 *  recreate the room and try again — up to `maxRooms` rooms. */
async function waitForEndedPhase(page, timeoutMs, maxRooms = 3) {
  const t0 = Date.now();
  let rooms = 1; // the caller already created room #1
  let lastPhase = '?';
  for (;;) {
    const s = await riftState(page).catch(() => null);
    lastPhase = s?.phase ?? lastPhase;
    if (s?.phase === 'ended') return s;
    if (s?.phase === 'lobby') {
      // back in the lobby (post-reset, or countdown still running): (re)start
      await page.evaluate(() => window.__rift.start()).catch(() => {});
    } else if (s?.phase === 'menu') {
      if (rooms >= maxRooms) {
        throw new Error(`the end room dropped its client ${rooms} times — the speed-20 snap stream is not drainable here`);
      }
      rooms++;
      log(`end-room: client dropped to menu — recreating the room (attempt ${rooms}/${maxRooms})`);
      await page.evaluate((st) => window.__rift.createPrivate('VerifyEnd', st), END_ROOM_SETTINGS);
      await waitFor(
        async () => ((await riftState(page))?.phase ?? null) === 'lobby',
        15000,
        'end-room lobby (recreated)',
      );
      await page.evaluate((h) => window.__rift.pick(h), HERO_PICK);
      await page.evaluate(() => window.__rift.start());
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`the speed-20 room never reached the ended phase (last phase ${lastPhase})`);
    }
    await sleep(500);
  }
}

async function captureOverlayStates(vp) {
  // -- page A: countdown + death + disconnect (speed 2) ------------------------------
  const page = await launchOne(vp, 'overlay');
  try {
    await connectClient(page, 'overlay');

    // -- countdown: shot immediately after start() is pressed ----------------------
    await page.evaluate((s) => window.__rift.createPrivate('VerifyOverlay', s), OVERLAY_ROOM_SETTINGS);
    await waitFor(
      async () => ((await riftState(page))?.phase ?? null) === 'lobby',
      15000,
      'overlay-room lobby',
    );
    await page.evaluate((h) => window.__rift.pick(h), HERO_PICK);
    await page.evaluate(() => window.__rift.start());
    await waitFor(
      () =>
        page.evaluate(
          () => document.querySelector('.lobby-start')?.textContent?.includes('STARTING IN') ?? false,
        ),
      COUNTDOWN_TIMEOUT_MS,
      "lobby countdown readout ('STARTING IN n…')",
    );
    await shot(page, 'countdown', vp);

    // -- live, then drive the hero into the enemy base until it dies ----------------
    const live = await waitFor(
      async () => {
        const s = await riftState(page);
        return s !== null && s.phase === 'live' && s.you !== null && (s.tick ?? 0) > 5 ? s : null;
      },
      45000,
      'overlay-room live',
    );
    // The overlay room compiles its OWN map (OVERLAY_LANES), so its ancients are
    // at BASE_INSET and OVERLAY_MAP_SIDE - BASE_INSET on that map's diagonal —
    // not on the 3-lane budget map's.
    const enemyAncient = live.team === 0 ? OVERLAY_MAP_SIDE - BASE_INSET : BASE_INSET;
    log(`overlay: hero on team ${live.team ?? '?'} — marching it into the enemy base (${enemyAncient},${enemyAncient})`);
    const died = await driveToDeath(page, enemyAncient, enemyAncient, DEATH_TIMEOUT_MS);
    if (!died) {
      fail(`${vp.tag}: the hero never died within ${DEATH_TIMEOUT_MS / 1000}s at the enemy base`);
    } else {
      await shot(page, 'death', vp); // no settle — the respawn window is short
    }
  } catch (err) {
    fail(`${vp.tag}: overlay flow: ${errText(err)}`);
  }

  // -- end screen (page B) -------------------------------------------------------------
  // Runs ALONE, after page A's captures: a second live client splitting the
  // box starved the speed-20 snap stream in round-1 of this harness and the
  // server dropped the end-room client as a dead peer before its match could
  // resolve. Alone at 1920x1080 it STILL drops (~400 snaps/s against a
  // software-rendered 1080p canvas) — so the match itself runs at 640x360
  // (the e2e harness's own documented drain mitigation, E2E_VIEWPORT) and the
  // page is resized UP to 1920x1080 only for the capture, inside the 20s
  // ended-phase dwell. The end screen is pure DOM; a resize reflows it.
  const endPage = await launchOne(vp, 'end');
  try {
    await endPage.setViewport({ width: 640, height: 360, deviceScaleFactor: 1 });
    await connectClient(endPage, 'end');
    await endPage.evaluate((s) => window.__rift.createPrivate('VerifyEnd', s), END_ROOM_SETTINGS);
    await waitFor(
      async () => ((await riftState(endPage))?.phase ?? null) === 'lobby',
      15000,
      'end-room lobby',
    );
    await endPage.evaluate((h) => window.__rift.pick(h), HERO_PICK);
    await endPage.evaluate(() => window.__rift.start());
    await waitForEndedPhase(endPage, END_TIMEOUT_MS);
    await endPage.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
    await settle(endPage, { frames: 5, ms: 600 }); // reflow + a few frames at the new size
    await shot(endPage, 'end', vp);
  } catch (err) {
    fail(`${vp.tag}: end screen: ${errText(err)}`);
  } finally {
    await closePage(endPage);
  }

  // -- disconnect: kill the platform server, capture the banner, restore --------------
  try {
    const s = await riftState(page);
    if (s?.phase !== 'live') {
      throw new Error(`the overlay room is no longer live (phase ${s?.phase ?? '?'}) — the banner only rides the live HUD`);
    }
    expectDisconnect = true;
    const victim = serverChild; // pin the child: after a fast clean SIGTERM
    // exit startServer() reassigns the global, and a stale 5s SIGKILL timer
    // aimed at the OLD server would murder the RESTARTED one mid-reconnect
    // (measured: 'server EXITED mid-run (signal SIGKILL)' + reconnect timeout)
    victim.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => victim.once('exit', r)),
      sleep(5000).then(() => victim.kill('SIGKILL')),
    ]);
    await waitFor(() => domVisible(page, '.hud .banner'), 20000, 'disconnect banner');
    await settle(page, { ms: 300 });
    await shot(page, 'disconnect', vp);
    // restore: same port, the client's own backoff reconnects it
    serverExit = null;
    await startServer();
    await waitForServer();
    await waitFor(
      async () => (await riftState(page))?.connected === true,
      RECONNECT_TIMEOUT_MS,
      'client reconnect after server restart',
    );
    expectDisconnect = false;
    if (await domVisible(page, '.hud .banner')) {
      fail(`${vp.tag}: the disconnect banner is still visible after the reconnect`);
    }
  } catch (err) {
    expectDisconnect = false;
    fail(`${vp.tag}: disconnect: ${errText(err)}`);
  } finally {
    await closePage(page);
  }
}
// ---- main ----------------------------------------------------------------------------
// The fatal path is CAUGHT, not allowed to escape: the judge loop's contract
// with this harness is "the last stdout line is a JSON manifest", and a
// harness that dies before printing one is indistinguishable from a harness
// that was never run. A setup failure (no build, port taken, server dead) is
// recorded as a failure like any other and still ships the manifest.
await mkdir(OUT_DIR, { recursive: true });
try {
  await loadFacts();
  await startServer();
  await waitForServer();
  await assertProductionMount();
  log(`platform server up on :${PORT} (built mount verified)`);
  log(
    `terrain facts at ${LANES} lane(s), side ${FACTS.side}, ${FACTS.camps.length} camps: cliff ${JSON.stringify(FACTS.cliff)} ` +
      `river ${JSON.stringify(FACTS.river)} jungle wall ${JSON.stringify(FACTS.wall)} brute camp ${JSON.stringify(FACTS.brute)}`,
  );
  for (const vp of VIEWPORTS) {
    await captureViewport(vp);
  }
  await captureWorldStates(WORLD_VIEWPORT);
  await captureOverlayStates(OVERLAY_VIEWPORT);
} catch (err) {
  fail(`the run aborted: ${errText(err)}`);
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

// ---- verdict ----------------------------------------------------------------------------
const expected = VIEWPORTS.length * SHOT_NAMES.length + WORLD_SHOTS.length + OVERLAY_SHOTS.length;
if (manifest.length < expected) {
  const got = new Set(manifest.map((m) => `${m.shot}-${m.viewport}`));
  const missing = VIEWPORTS.flatMap((vp) => SHOT_NAMES.filter((n) => !got.has(`${n}-${vp.tag}`)).map((n) => `${n}-${vp.tag}`));
  for (const n of WORLD_SHOTS) {
    if (!got.has(`${n}-${WORLD_VIEWPORT.tag}`)) missing.push(`${n}-${WORLD_VIEWPORT.tag}`);
  }
  for (const n of OVERLAY_SHOTS) {
    if (!got.has(`${n}-${OVERLAY_VIEWPORT.tag}`)) missing.push(`${n}-${OVERLAY_VIEWPORT.tag}`);
  }
  fail(`missing ${expected - manifest.length} shot(s): ${missing.join(', ')}`);
}
if (pageErrors.length > 0) {
  fail(`${pageErrors.length} page error(s):\n  ${pageErrors.slice(0, 12).join('\n  ')}`);
}
if (badServerExit !== null) {
  fail(
    `the platform server exited mid-run (code ${badServerExit.code}, signal ${badServerExit.signal}) — ` +
      'every page kept rendering its last snapshot, so any shot after that point is a frozen world',
  );
}

const worstDrawCalls = Math.max(0, ...manifest.map((m) => m.drawCalls));
const worstTriangles = Math.max(0, ...manifest.map((m) => m.triangles));
if (worstDrawCalls > DRAW_CALL_BUDGET) {
  fail(`worst draw calls ${worstDrawCalls} exceeds the ${DRAW_CALL_BUDGET} budget (GRAPHICS_CONTRACT §5)`);
}
if (worstTriangles > TRIANGLE_BUDGET) {
  fail(`worst triangles ${worstTriangles} exceeds the ${TRIANGLE_BUDGET} budget (GRAPHICS_CONTRACT §5)`);
}
// Meter liveness is NOT decided here. It is proved by measureMeterLiveness()'s
// controlled A/B inside the 3-lane 8v8 world room (§5: "the count rises when a
// pass is added"), which fails with the two measurements in the message. A
// verdict-level scan for "at least two distinct values across the shot list"
// would instead false-fail whenever two unrelated framings coincided.

log(
  failures.length === 0
    ? `GREEN: ${manifest.length}/${expected} shots, worst draw calls ${worstDrawCalls}/${DRAW_CALL_BUDGET}, ` +
      `worst triangles ${worstTriangles}/${TRIANGLE_BUDGET}, zero page errors`
    : `RED: ${failures.length} failure(s), ${manifest.length}/${expected} shots`,
);
console.log(JSON.stringify({ ok: failures.length === 0, worstDrawCalls, worstTriangles, failures, shots: manifest }));
process.exit(failures.length === 0 ? 0 : 1);

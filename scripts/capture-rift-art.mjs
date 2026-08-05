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
// THE MATRIX (17 shots, `<out>/<name>.png`):
//   wide-mid / wide-base-own / wide-base-enemy   camH 55 (fully out)
//   mid-lane                                     camH ~35, live creep clash
//   close-hero / close-creeps / close-tower /
//   close-ancient / close-deco                   camH 18 (fully in)
//   fx-cast / fx-combat / fog-edge               camH ~35
//   hud-live / ui-shop / ui-scoreboard           camH ~35, HUD/overlay state
//   ui-menu / ui-lobby                           pre-match DOM screens
//
// DETERMINISM (the judge diffs successive rounds — framing MUST NOT drift):
//   * no Math.random anywhere;
//   * the room is a fixed private room, teamSize 5 -> LANES_FOR_TEAM_SIZE[5]
//     = 3 lanes -> side 128 (config.ts), speed 5. `lanes === 3` is ASSERTED
//     off the rift_begin frame; a 1-lane test map fails the run;
//   * every camera target is a MAP FACT (map centre, an Ancient, a tower read
//     out of the snapshot — buildMap() is pure) or a fixed fraction along the
//     own->enemy diagonal, mirrored through the map centre for team 1, so the
//     same frames come back whichever side the human is seated on;
//   * zoom is driven to a CLAMP (12 wheel notches at 1.12/notch overshoots the
//     18..55 range) and then stepped back a fixed count — never relative to an
//     unknown current height;
//   * shots that need a hero in frame POSE the hero first: order it to the
//     fixed point and poll until it stands there, then aim the camera at the
//     POINT, not at the hero;
//   * every gameplay wait polls the real condition (opposing creeps in
//     contact, units swinging, the cast event landing) with a timeout — the
//     only fixed sleeps are the post-condition settles that land animations
//     in the same phase each round.
//
// One failed shot never aborts the run: it is recorded {ok:false, error} and
// the flow continues. The LAST stdout line is the JSON manifest
//   { ok, outDir, worstDrawCalls, pageErrors, shots:[{name,file,bytes,
//     drawCalls,ok,error}] }
// and everything human goes to stderr. Exit 0 only when every requested shot
// landed and the page logged zero errors.
//
// Flags: --out <dir> (default judge/captures), --only <name-prefix>,
//        --keep-server. Env: RIFT_ART_PORT (default 8093),
//        E2E_PROTOCOL_TIMEOUT (default 300000).
// The client dist must already exist — this harness NEVER builds.
// ============================================================================
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

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
  'wide-mid',
  'wide-base-own',
  'wide-base-enemy',
];

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

// ---- camera ------------------------------------------------------------------------
// input.ts ZOOM_STEP = 1.12/notch, game.ts clamps camH to [18, 55] (default
// 36). 12 notches move 3.9x — more than the 3.06x range — so 12 notches in
// either direction always lands ON a clamp, which is what makes the framing
// reproducible. 'default' = 4 notches in from 55 -> 34.96m.
const ZOOM_CLAMP_STEPS = 12;
const ZOOM_DEFAULT_STEPS = 4;

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
const CREEPS_RADIUS_M = 12; // camH 18 frames ~16m either side — keep them ON screen
const SCOUT_TIMEOUT_MS = 90000; // reveal the enemy base for wide-base-enemy
const FRESH_TICK_MS = 400; // liveness probe window (8 sim ticks at speed 2)
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

// ---- state -----------------------------------------------------------------------------
const shots = [];
const pageErrors = [];
const browsers = [];
let serverChild = null;
let serverExit = null;
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

// ---- server -------------------------------------------------------------------------------
async function startServer() {
  if (!existsSync(SERVER_ENTRY) || !existsSync(CLIENT_ENTRY)) {
    throw new Error('run "npm run build" first');
  }
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
    if (!tearingDown) {
      process.stderr.write(
        `[server] EXITED mid-run (code ${code}, signal ${signal}) — the page just lost its socket.\n`,
      );
    }
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

function trackErrors(page, tag) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = m.location()?.url ?? '';
    if (/favicon/.test(url) || /favicon/.test(m.text())) return;
    // Shutdown noise only: a killed server makes the client log socket errors.
    if ((tearingDown || serverExit !== null) && /WebSocket connection to .* failed/.test(m.text())) return;
    pageErrors.push(`[${tag}] console.error: ${m.text()} (${url})`);
  });
  page.on('pageerror', (e) => pageErrors.push(`[${tag}] pageerror: ${e.message}`));
  page.on('error', (e) => pageErrors.push(`[${tag}] page CRASHED: ${e.message}`));
  page.on('requestfailed', (r) => {
    if (/favicon/.test(r.url())) return;
    pageErrors.push(`[${tag}] requestfailed: ${r.url()} — ${r.failure()?.errorText ?? '?'}`);
  });
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
async function zoom(page, steps, dir) {
  await page.mouse.move(WORK_VIEWPORT.width / 2, WORK_VIEWPORT.height / 2);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel({ deltaY: dir > 0 ? 240 : -240 });
    await sleep(70);
  }
}

let zoomLevel = null; // 'out' | 'default' | 'in'
/** Drive camH to a reproducible height: always via a clamp, never relative. */
async function zoomTo(page, level) {
  if (zoomLevel === level) return;
  await zoom(page, ZOOM_CLAMP_STEPS, +1); // -> clamp 55
  if (level === 'in') await zoom(page, ZOOM_CLAMP_STEPS, -1); // -> clamp 18
  else if (level === 'default') await zoom(page, ZOOM_DEFAULT_STEPS, -1); // -> 34.96
  zoomLevel = level;
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

/** The per-shot gate: connected, live, AND the snapshot stream is actually
 *  advancing. Nothing is captured over a stalled world. */
async function assertLive(page) {
  const a = await assertConnectedLive(page);
  await sleep(FRESH_TICK_MS);
  const b = await assertConnectedLive(page);
  if ((b.tick ?? 0) <= (a.tick ?? 0)) {
    throw new Error(`the snapshot stream stalled (tick stuck at ${String(a.tick)}) — the frame would be stale`);
  }
}

// ---- capture ---------------------------------------------------------------------------------
/** Resize UP to 1920x1080, let the resized scene paint, shoot, drop back to
 *  the cheap working size. The whole 1080p exposure is a couple of frames
 *  instead of the whole match. */
async function captureRaw(page, name) {
  const file = path.join(OUT_DIR, `${name}.png`);
  const t0 = Date.now();
  await page.setViewport({ ...SHOT_VIEWPORT, deviceScaleFactor: 1 });
  try {
    await settle(page, { frames: 3, ms: 120 }); // scene.resize() + a painted frame at the new size
    try {
      await page.screenshot({ path: file, timeout: 30000, optimizeForSpeed: true });
    } catch (err) {
      log(`[warn] ${name}: capture failed (${errText(err)}) — one retry`);
      await page.screenshot({ path: file, timeout: 90000, optimizeForSpeed: true });
    }
  } finally {
    await page.setViewport({ ...WORK_VIEWPORT, deviceScaleFactor: 1 });
  }
  const bytes = statSync(file).size;
  const dc = await drawCalls(page).catch(() => -1);
  return { file, bytes, drawCalls: dc, ms: Date.now() - t0 };
}

function record(name, res, error = null) {
  shots.push({
    name,
    file: res === null ? null : path.relative(ROOT, res.file),
    bytes: res === null ? 0 : res.bytes,
    drawCalls: res === null ? -1 : res.drawCalls,
    ok: error === null,
    error,
  });
  if (error === null) {
    log(`shot  ${name} (${(res.bytes / 1024).toFixed(0)}kB, ${res.drawCalls} draw calls, ${(res.ms / 1000).toFixed(1)}s at 1080p)`);
  } else {
    log(`[FAILED] ${name}: ${error}`);
  }
}

async function capture(page, name, settleOpts) {
  await settle(page, settleOpts);
  const res = await captureRaw(page, name);
  if (res.bytes < MIN_PNG_BYTES) {
    throw new Error(`only ${res.bytes} bytes — the frame did not render`);
  }
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
 *  round regardless of where the hero stopped within the tolerance. */
async function poseHero(page, x, z, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const you = await latestYou(page).catch(() => null);
    if (you !== null && Math.hypot(you.x - x, you.z - z) <= POSE_TOLERANCE_M) {
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
      await capture(page, 'hud-live', { ms: 800 });
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
      await capture(page, 'ui-shop', { ms: 400 });
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
        await capture(page, 'ui-scoreboard', { ms: 300 });
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
      await capture(page, 'mid-lane', { ms: 500 });
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
      await capture(page, 'close-creeps', { ms: 500 });
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
      await capture(page, 'fx-combat', { frames: 1, ms: 0 });
    });

    // -- fog-edge: BEFORE the off-lane poses, which would explore this corner ---------------------------
    await step('fog-edge', async () => {
      await assertLive(page);
      await zoomTo(page, 'default');
      await panTo(page, fogP.x, fogP.z);
      await capture(page, 'fog-edge', { ms: 900 }); // the fog mask refreshes at ~5Hz
    });

    // -- close-tower / close-ancient: pure map facts, no waiting ------------------------------------------
    await step('close-tower', async () => {
      await assertLive(page);
      await zoomTo(page, 'in');
      await panTo(page, tower.x, tower.z);
      await capture(page, 'close-tower', { ms: 600 });
    });
    await step('close-ancient', async () => {
      await assertLive(page);
      await zoomTo(page, 'in');
      await panTo(page, ownAncient.x, ownAncient.z);
      await capture(page, 'close-ancient', { ms: 600 });
    });

    // -- close-hero: pose the hero on the mid lane, then frame the POINT ------------------------------------
    let posed = false;
    await step('close-hero', async () => {
      await assertLive(page);
      await poseHero(page, poseP.x, poseP.z, POSE_TIMEOUT_MS);
      posed = true;
      await zoomTo(page, 'in');
      await panTo(page, poseP.x, poseP.z);
      await capture(page, 'close-hero', { ms: 600 });
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

      let last = null;
      let lastErr = 'the cast never fired';
      for (let attempt = 0; attempt < CAST_ATTEMPTS; attempt++) {
        const you = await latestYou(page);
        if (you === null || you.respawnAtTick > 0) {
          lastErr = 'the hero was dead at every cast attempt';
          await sleep(CAST_RETRY_MS);
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
      await capture(page, 'close-deco', { ms: 900 });
    });

    // -- reveal the enemy base, then the wide trio ------------------------------------------------------
    let scouted = Infinity;
    try {
      await assertLive(page);
      scouted = await scoutEnemyBase(page, enemyAncient.x, enemyAncient.z, SCOUT_TIMEOUT_MS);
      log(`scout: closest approach to the enemy Ancient ${scouted.toFixed(1)}m (persistent fog reveal)`);
    } catch (err) {
      log(`[warn] enemy-base scout aborted (${errText(err)}) — wide-base-enemy may be shrouded`);
    }

    await step('wide-mid', async () => {
      await assertLive(page);
      await zoomTo(page, 'out');
      await panTo(page, mid.x, mid.z);
      await capture(page, 'wide-mid', { ms: 900 });
    });
    await step('wide-base-own', async () => {
      await assertLive(page);
      await zoomTo(page, 'out');
      await panTo(page, ownAncient.x, ownAncient.z);
      await capture(page, 'wide-base-own', { ms: 900 });
    });
    await step('wide-base-enemy', async () => {
      await assertLive(page);
      await zoomTo(page, 'out');
      await panTo(page, enemyAncient.x, enemyAncient.z);
      await capture(page, 'wide-base-enemy', { ms: 900 });
    });
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
  console.log(JSON.stringify({ ok: false, outDir: OUT_DIR, worstDrawCalls: 0, pageErrors: [], shots: [] }));
  process.exit(1);
}

await mkdir(OUT_DIR, { recursive: true });
// self-cleaning: a shot that fails this round must not leave last round's PNG
// behind for the judge to grade as if it were fresh.
for (const name of WANTED) await rm(path.join(OUT_DIR, `${name}.png`), { force: true });

let fatal = null;
try {
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
    shots.push({ name, file: null, bytes: 0, drawCalls: -1, ok: false, error: fatal ?? 'never reached' });
  }
}
shots.sort((a, b) => SHOT_ORDER.indexOf(a.name) - SHOT_ORDER.indexOf(b.name));

const failed = shots.filter((s) => !s.ok);
const worstDrawCalls = Math.max(0, ...shots.map((s) => s.drawCalls));
const ok = failed.length === 0 && pageErrors.length === 0;
log(
  ok
    ? `GREEN: ${shots.length}/${WANTED.length} shots, worst draw calls ${worstDrawCalls}, zero page errors`
    : `RED: ${failed.length} failed shot(s) [${failed.map((s) => s.name).join(', ')}], ${pageErrors.length} page error(s)`,
);
for (const e of pageErrors.slice(0, 12)) log(`  ${e}`);

console.log(
  JSON.stringify({
    ok,
    outDir: path.relative(ROOT, OUT_DIR),
    worstDrawCalls,
    pageErrors,
    shots,
  }),
);
process.exit(ok ? 0 : 1);

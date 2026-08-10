#!/usr/bin/env node
// ============================================================================
// e2e-splat — prove SKI SPLAT runs end-to-end in a real (headless) browser.
//
// Cloned on the e2e-kart shell: build the monorepo (npm run build must produce
// games/splat/client/dist), spawn the production platform server
// (platform/server/dist), then drive TWO browser instances (separate
// processes: no cross-tab rAF throttling) through the window.__splat debug
// surface (games/splat/CONTRACT.md §7 C2) against the multi-game static route
// /splat/. A THIRD browser, emulating an iPad, joins the second room for the
// touch-zones screenshot.
//
// The debug surface (games/splat/client/src/app.ts):
//   state()     -> {phase ('menu' outside a room), seated, slot, place,
//                   sim: {x,z,yaw,v,simMs,snareUntilMs,lastPlantIx,
//                   lastPlantHitMs,finished,finishMs} | null,
//                   code, canStart}        (NO player count — the race-screen
//                   census here is telemetry().remotes, the lobby's is the
//                   .player-chip DOM list)
//   telemetry() -> {drawCalls, remotes:[{id,x,z,yaw,samples}], correction,
//                   pending, ack, seq, offsetMs, seed}   (seed lives HERE,
//                   not on state())
//   joinQuick(name) / startRace(seed?) / setInput(steer) — setInput is a
//   LATCH (the kart ext-latch pattern): it holds until changed. It is a no-op
//   while drive is null — the drive is created when the slope is built at
//   countdown entry, so race inputs are latched the moment state().sim is
//   live (still pre-GO: the freeze holds inputs until racing).
//
// SEED-42 PRIVATE ROOM — the one non-obvious flow. The frozen surface can only
// attach {seed} to a CREATE (debugStartRace forwards it as room settings), and
// an UNJOINED startRace(42) also arms `pendingStart`, which fires the moment
// the room fills to MIN_PLAYERS. That fire is A's OWN explicit start — the
// {t:'start'} frame goes out because A called startRace(42), deferred by the
// client until the room may legally start; it is NOT the room auto-starting.
// (Reloading A to disarm pendingStart does NOT work: the platform reaps an
// empty private room the moment A's socket drops — observed: "[lobby] room
// ... closed (empty private)" — and the rejoin lands on 'no_room'.) So room 1
// is: A startRace(42) unjoined (room created with settings {seed:42}, start
// armed), B joins by code through the REAL UI (.menu-name + .menu-code-input +
// JOIN BY CODE), the start fires, and the frozen phase machine (lobby
// -[{t:'start'}]-> countdown (3s, snapshot-carried: NO countdown events) ->
// racing -> results (8s) -> lobby) is observed at every step on the fixed
// seed. The NO-AUTO-START proof then runs in room 2 — a pristine UI-created
// room (no settings, nothing armed on any client, three seated skiers): a 6s+
// hold with canStart true the whole time. The seedOverride pins every rematch
// IN ROOM 1 to 42 by design (dev/e2e override), so the rematch-new-seed check
// also runs in room 2 (the server picks rng(Date.now()) at countdown entry).
//
// INPUT SIGN CONVENTION (regression-tested): setInput(-1) = full screen-RIGHT
// (world -x: yaw goes negative, x += sin(yaw)*v*dt decreases); setInput(+1) =
// full screen-LEFT (x increases).
//
// SWIFTSHADER NOTE (CONTRACT §9.5): the client frame loop clamps dt
// (MAX_FRAME_DT_MS 250, wire dt clamped to SIM_DT_MAX 1/15), so under software
// GL the sim can run slower than wall clock. A clean 800m run is ~47 sim-s;
// the wall budget below is generous (the server's own RACE_HARD_CAP_MS is
// 150s wall, RACE_FIRST_FINISH_GRACE_MS 45s wall). The 4-YEAR-OLD TEST (B
// holds full lock from GO, never changes it) therefore accepts finish OR
// hard-cap-with-progress (z > 300 and still moving over the last 10s of
// racing) and reports B's outcome honestly.
//
// Env: E2E_PORT overrides the default port 8184; E2E_SKIP_BUILD=1 (exactly
// '1') reuses the existing dist output; E2E_VIEWPORT=WxH overrides 640x360
// (SwiftShader raster load); E2E_PROTOCOL_TIMEOUT ms; E2E_DUMPIO=1 pipes
// browser stderr.
//
// Exit 0 only if every assertion passes AND zero page/console/network errors
// were seen on any page (benign favicon noise excluded).
// ============================================================================
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { KnownDevices } from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 8184);
const BASE = `http://localhost:${PORT}`;
const GAME_URL = `${BASE}/splat/`; // the launcher lives at /; the splat client is mounted at /splat/
const SHOTS_DIR = path.join(ROOT, 'screenshots');

// the frozen window.__splat debug surface (CONTRACT §7 C2)
const SPLAT_SURFACE = ['state', 'telemetry', 'joinQuick', 'startRace', 'setInput'];

const FIXED_SEED = 42; // race 1's deterministic slope (room settings {seed})
const FINISH_Z = 800; // SLOPE_LENGTH in @splat/shared config

// ---- tiny framework -----------------------------------------------------------
const results = [];
const pageErrors = [];
let serverChild = null;
let serverLog = '';
const browsers = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // page mid-navigation etc. — keep polling
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout (${timeoutMs}ms) waiting for ${label}`);
    await sleep(150);
  }
}

const splatState = (page) =>
  page.evaluate(() => {
    try {
      return window.__splat?.state() ?? null;
    } catch {
      return null;
    }
  });
const splatTelemetry = (page) =>
  page.evaluate(() => {
    try {
      return window.__splat?.telemetry?.() ?? null;
    } catch {
      return null;
    }
  });

/** Own predicted sim from state(), or null while unreadable. */
function ownSim(s) {
  const sim = s !== null && typeof s === 'object' ? s.sim : null;
  return sim !== null &&
    typeof sim === 'object' &&
    [sim.x, sim.z, sim.yaw, sim.v].every((n) => typeof n === 'number' && Number.isFinite(n))
    ? sim
    : null;
}

/** Joined a room = state().phase left 'menu' (the client is on the race screen). */
function joinedState(s) {
  return s !== null && typeof s.phase === 'string' && s.phase !== 'menu';
}

/** Lobby seat census: the rendered .player-chip list (state() carries no count). */
const lobbyChipCount = (page) =>
  page.evaluate(() => document.querySelectorAll('.lobby-players .player-chip').length);

/** telemetry().remotes length, or null while unreadable. */
async function remoteCount(page) {
  const t = await splatTelemetry(page);
  return t !== null && Array.isArray(t.remotes) ? t.remotes.length : null;
}

// ---- build + server -------------------------------------------------------------
function buildAll() {
  console.log('build: npm run build');
  const r = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`npm run build exited with code ${r.status}`);
  const splatIndex = path.join(ROOT, 'games/splat/client/dist/index.html');
  if (!existsSync(splatIndex)) {
    throw new Error('games/splat/client/dist/index.html missing after build (splat client not wired into npm run build?)');
  }
  if (!existsSync(path.join(ROOT, 'platform/server/dist/server.js'))) {
    throw new Error('platform/server/dist/server.js missing after build');
  }
}

/**
 * Re-runnability: a crashed prior run can leave its platform server LISTENING
 * on our port. Kill it — but ONLY a process whose command line is this repo's
 * built server; anything else is left alone (and waitForServer will fail
 * loudly if it blocks us).
 */
function killPortLeftovers() {
  try {
    const r = spawnSync('lsof', ['-nP', `-tiTCP:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    const pids = (r.stdout ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const pid of pids) {
      const ps = spawnSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' });
      const cmd = (ps.stdout ?? '').trim();
      if (/platform\/server\/dist\/server\.js/.test(cmd)) {
        console.log(`port ${PORT}: killing leftover e2e server (pid ${pid})`);
        try {
          process.kill(Number(pid), 'SIGTERM');
        } catch {
          // already gone
        }
      } else if (cmd.length > 0) {
        console.log(`port ${PORT}: held by a non-e2e process (${cmd}) — leaving it alone`);
      }
    }
  } catch {
    // lsof missing or no listener — nothing to do
  }
}

function startServer() {
  const child = spawn(process.execPath, ['platform/server/dist/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverChild = child;
  child.stdout.on('data', (d) => {
    serverLog += d; // the lobby logs private-room codes here (code fallback)
    process.stdout.write(`[server] ${d}`);
  });
  child.stderr.on('data', (d) => process.stdout.write(`[server!] ${d}`));
  child.on('exit', (code) => {
    if (code !== null && code !== 0) console.log(`[server] exited with code ${code}`);
  });
  return child;
}

async function waitForServer(timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    if (serverChild.exitCode !== null) throw new Error(`server exited early (${serverChild.exitCode})`);
    try {
      // /splat/ is the multi-game static route for the splat client dist
      const res = await fetch(GAME_URL, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`server did not serve /splat/ on :${PORT} within ${timeoutMs}ms`);
    await sleep(250);
  }
}

// ---- browser --------------------------------------------------------------------
// WebGL client (three.js): same launch pattern as the kart e2e — the headless
// shell provides webgl2 via SwiftShader when no hardware GL answers, and the
// anti-throttling flags keep the 20Hz snapshot stream + drive loop at rate.
// E2E_VIEWPORT=640x360 cuts the raster load ~4x on machines where software
// rasterization can't keep the client at realtime.
const VIEWPORT = (() => {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(process.env.E2E_VIEWPORT ?? '');
  return m === null
    ? { width: 640, height: 360 } // software raster: small viewport keeps the sim near realtime
    : { width: Number(m[1]), height: Number(m[2]) };
})();
const LAUNCH_ARGS = [
  `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--enable-unsafe-swiftshader', // allow sw fallback; hardware ANGLE still preferred
];

// one slow frame must not abort the whole suite (software GL makes individual
// captures genuinely slow on loaded machines)
const PROTOCOL_TIMEOUT_MS = Number(process.env.E2E_PROTOCOL_TIMEOUT ?? 300000);
const LAUNCH_OPTS = {
  // 'shell' (chrome-headless-shell): the new-headless full compositor can wedge
  // (BeginFrame never completes; captureScreenshot stalls past protocolTimeout)
  // on machines with contended/broken GPU state — the shell's software pipeline
  // has no such dependency and still provides webgl2 (SwiftShader) + rAF.
  headless: 'shell',
  args: LAUNCH_ARGS,
  protocolTimeout: PROTOCOL_TIMEOUT_MS,
  dumpio: !!process.env.E2E_DUMPIO, // pipe browser stderr (GPU/context-loss noise) when diagnosing
};

async function launchOne(tag) {
  let browser = await puppeteer.launch(LAUNCH_OPTS);
  browsers.push(browser);
  let page = await browser.newPage();
  await page.setViewport({ width: VIEWPORT.width, height: VIEWPORT.height });
  const gl = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
  if (!gl) {
    console.log(`[${tag}] no hardware webgl2 — relaunching on swiftshader`);
    await browser.close();
    browsers.pop();
    browser = await puppeteer.launch({
      ...LAUNCH_OPTS,
      args: [...LAUNCH_ARGS, '--use-gl=angle', '--use-angle=swiftshader'],
    });
    browsers.push(browser);
    page = await browser.newPage();
    await page.setViewport({ width: VIEWPORT.width, height: VIEWPORT.height });
    const gl2 = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
    if (!gl2) throw new Error(`[${tag}] webgl2 unavailable even on swiftshader`);
  }
  trackErrors(page, tag);
  return page;
}

function trackErrors(page, tag) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = m.location()?.url ?? '';
    if (/favicon/.test(url) || /favicon/.test(m.text())) return;
    pageErrors.push(`[${tag}] console.error: ${m.text()} (${url})`);
  });
  page.on('pageerror', (e) => pageErrors.push(`[${tag}] pageerror: ${e.message}`));
  page.on('error', (e) => pageErrors.push(`[${tag}] page CRASHED: ${e.message}`));
  page.on('requestfailed', (r) => {
    if (/favicon/.test(r.url())) return;
    pageErrors.push(`[${tag}] requestfailed: ${r.url()} — ${r.failure()?.errorText ?? '?'}`);
  });
}

// ---- hang diagnostics ---------------------------------------------------------
// Discriminates, at the moment a capture stalls: (a) main thread blocked
// (evaluate itself never returns), (b) WebGL context lost / rAF starved
// (evaluate returns but rafFired=false or glLost=true), (c) mere slowness.
async function probePage(page, label) {
  const evalP = page.evaluate(
    () =>
      new Promise((res) => {
        let st = null;
        let stateErr = null;
        try {
          st = window.__splat ? window.__splat.state() : null;
        } catch (e) {
          stateErr = e instanceof Error ? e.message : String(e);
        }
        const canvas = document.querySelector('canvas');
        let glLost = 'no-canvas';
        try {
          const gl = canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'));
          glLost = gl ? gl.isContextLost() : 'no-context';
        } catch (e) {
          glLost = `err:${e instanceof Error ? e.message : String(e)}`;
        }
        const t0 = performance.now();
        let raf = false;
        requestAnimationFrame(() => {
          raf = true;
        });
        setTimeout(
          () =>
            res({
              phase: st ? st.phase : null,
              stateErr,
              glLost,
              rafFired: raf,
              rafWaitMs: Math.round(performance.now() - t0),
            }),
          400,
        );
      }),
  );
  const r = await Promise.race([evalP, sleep(6000).then(() => 'MAIN-THREAD-UNRESPONSIVE')]);
  console.log(`[diag] ${label}: ${typeof r === 'string' ? r : JSON.stringify(r)}`);
  return r;
}

// ---- screenshots ------------------------------------------------------------------
async function shot(page, name) {
  const file = path.join(SHOTS_DIR, name);
  const t0 = Date.now();
  // bounded per-capture timeout: a wedged compositor must not park the suite
  // for the full protocolTimeout
  try {
    await page.screenshot({ path: file, timeout: 30000 });
    console.log(`shot  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return;
  } catch (err) {
    console.log(
      `shot  ${name}: capture failed at ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
        `(${err instanceof Error ? err.message : String(err)}) — probing, then one retry with a wider window`,
    );
    try {
      await probePage(page, `${name} post-fail`);
    } catch (probeErr) {
      console.log(`[diag] ${name}: probe itself failed (${probeErr instanceof Error ? probeErr.message : String(probeErr)})`);
    }
  }
  await page.screenshot({ path: file, timeout: 90000 });
  console.log(`shot  ${name} (retry, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// ---- lobby helpers -----------------------------------------------------------------

/**
 * The private-room join code. Primary: state().code on the client surface.
 * Fallbacks: the lobby overlay's CODE line, then the server's creation log.
 */
async function getRoomCode(page) {
  const fromState = await page.evaluate(() => {
    const s = window.__splat?.state?.();
    return s && typeof s.code === 'string' && s.code.length > 0 ? s.code : null;
  });
  if (fromState !== null) return fromState;
  const fromDom = await page.evaluate(() => {
    const el = document.querySelector('.lobby-code');
    const m = el !== null ? /\b([A-Z0-9]{5})\b/.exec(el.textContent ?? '') : null;
    return m !== null ? m[1] : null;
  });
  if (fromDom !== null) return fromDom;
  const matches = [...serverLog.matchAll(/created \(private, code (\S+), game splat\)/g)];
  return matches.length > 0 ? matches[matches.length - 1][1] : null;
}

/** One REAL click on a menu button found by its label. Returns false if absent/disabled. */
const clickButtonByText = (page, text) =>
  page.evaluate((want) => {
    for (const b of document.querySelectorAll('button')) {
      if ((b.textContent ?? '').trim().toUpperCase().includes(want) && !b.disabled) {
        b.click();
        return true;
      }
    }
    return false;
  }, text);

/** Type a name/code into the real menu inputs (the client's own join path reads them). */
const setMenuInputs = (page, name, code) =>
  page.evaluate(
    ({ n, c }) => {
      const nameEl = document.querySelector('.menu-name');
      if (nameEl !== null && n !== null) nameEl.value = n;
      const codeEl = document.querySelector('.menu-code-input');
      if (codeEl !== null && c !== null) codeEl.value = c;
    },
    { n: name, c: code },
  );

/**
 * Lobby liveness keepalive. A seated splat client goes SILENT outside racing:
 * drive.flush() only sends what drive.step() accumulated, and step() runs
 * only in the racing phase — so a lobby-idler's room-side lastStateAt freezes
 * and the platform's stale sweep (lobby.ts pollStaleSessions, room
 * INPUT_STALE_MS = 10s) evicts them (observed twice: a fresh pre-first-race
 * lobby lost both seated players ~10s in and was reaped "empty private" mid-
 * hold). The frozen client's one room-bound message sendable at ANY phase
 * from real UI is splat_assist (§5 "any time"; V1 "at any phase"), wired to
 * the menu ASSIST chip's change handler. Toggling it twice (on→off: net-zero
 * state, and per-player assist is invisible to others anyway) sends two
 * legitimate frames through the client's own code path and refreshes room
 * liveness. This does NOT mask the no-auto-start assertion — splat_assist is
 * not a start and cannot move the phase machine.
 */
const lobbyKeepalive = (page) =>
  page
    .evaluate(() => {
      for (const row of document.querySelectorAll('.menu-toggle')) {
        const label = row.querySelector('.menu-toggle-label');
        if (label !== null && (label.textContent ?? '').trim() === 'ASSIST') {
          const input = row.querySelector('input');
          if (input !== null) {
            input.click(); // on  — the real change handler sends splat_assist {on:true}
            input.click(); // off — net-zero; both sends refresh room liveness
            return true;
          }
        }
      }
      return false;
    })
    .catch(() => false);

/**
 * Press START through the real UI and prove the room left 'lobby'. Waits for
 * the server's canStart (the button is disabled until then), clicks
 * .lobby-start, then confirms the phase moved. Fallback: __splat.startRace()
 * sends the identical {t:'start'} frame — re-sending is harmless: the server
 * silently ignores a start outside 'lobby'.
 */
async function pressStart(page, label, timeoutMs = 20000) {
  await waitFor(async () => {
    const s = await splatState(page);
    return s !== null && s.canStart === true ? true : null;
  }, timeoutMs, `${label}: state().canStart === true (server accepts a start)`);
  const clicked = await waitFor(
    () =>
      page.evaluate(() => {
        const b = document.querySelector('.lobby-start');
        if (b && !b.disabled) {
          b.click();
          return true;
        }
        return null;
      }),
    10000,
    `${label}: .lobby-start enabled and clicked`,
  ).catch(() => false);
  const left = async (ms) =>
    waitFor(async () => {
      const s = await splatState(page);
      return s !== null && s.phase !== 'lobby' && s.phase !== 'menu' ? s.phase : null;
    }, ms, `${label}: phase leaves 'lobby' after START`).catch(() => null);
  let phase = clicked ? await left(8000) : null;
  // Fallback: __splat.startRace() sends the identical {t:'start'} frame.
  // Retried: a send into a socket that is mid-reconnect (the platform's stale
  // sweep closes lobby-idle sockets at INPUT_STALE_MS) lands nowhere, so give
  // the reconnect a beat and send it again — a start outside 'lobby' is
  // silently ignored, so a double-send is harmless.
  for (let attempt = 0; phase === null && attempt < 3; attempt++) {
    console.log(`${label}: START button press did not move the phase (clicked=${clicked}) — using __splat.startRace() (attempt ${attempt + 1})`);
    await page.evaluate(() => window.__splat?.startRace?.());
    phase = await left(4000);
  }
  console.log(`${label}: race started (button=${clicked}, phase now ${phase ?? 'still lobby'})`);
  return phase;
}

/** Ride the phase machine from a START to 'racing', noting whether 'countdown' was seen. */
async function awaitRacing(page, label, timeoutMs = 30000) {
  const seen = new Set();
  const t0 = Date.now();
  for (;;) {
    const s = await splatState(page).catch(() => null);
    if (s !== null && typeof s.phase === 'string') {
      seen.add(s.phase);
      if (s.phase === 'racing') return { sawCountdown: seen.has('countdown'), seen: [...seen] };
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}: phase 'racing' (saw [${[...seen].join(', ')}])`);
    await sleep(120);
  }
}

// ---- main ---------------------------------------------------------------------------
async function main() {
  await mkdir(SHOTS_DIR, { recursive: true });
  // E2E_SKIP_BUILD=1 (exactly '1') reuses the dist output from a previous
  // build — for fast local iteration and for a runner that already built once.
  if (process.env.E2E_SKIP_BUILD !== '1') {
    buildAll();
  } else {
    console.log('build: skipped (E2E_SKIP_BUILD=1) — reusing the existing dist output');
    if (
      !existsSync(path.join(ROOT, 'games/splat/client/dist/index.html')) ||
      !existsSync(path.join(ROOT, 'platform/server/dist/server.js'))
    ) {
      throw new Error('E2E_SKIP_BUILD=1 but the dist output is missing — run npm run build once first');
    }
  }
  killPortLeftovers();
  startServer();
  await waitForServer();
  console.log(`server up on ${BASE} (splat client at /splat/)`);

  const A = await launchOne('A');
  const B = await launchOne('B');

  // -- load the splat client on both pages ---------------------------------------------
  await A.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(() => A.evaluate(() => !!window.__splat), 15000, '__splat on A');
  check('1. splat client loads at /splat/ (window.__splat present)', true);
  await B.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(() => B.evaluate(() => !!window.__splat), 15000, '__splat on B');

  const surfaceMissing = await A.evaluate((names) => {
    const k = window.__splat;
    return names.filter((f) => typeof k?.[f] !== 'function');
  }, SPLAT_SURFACE);
  check(
    '2. window.__splat exposes the frozen debug surface',
    surfaceMissing.length === 0,
    surfaceMissing.length > 0 ? `missing: ${surfaceMissing}` : SPLAT_SURFACE.join('/'),
  );

  // C: the emulated iPad (touch zones screenshot, CONTRACT §9.6) — launched NOW
  // and parked at the menu with its name typed. The boot cost (emulate + load
  // under SwiftShader) must not land inside room 2's lobby: a splat client
  // seated in a PRE-FIRST-RACE lobby sends no room-bound messages (the drive
  // exists only once a slope is built), so the platform's stale sweep
  // (INPUT_STALE_MS = 10s, lobby.ts pollStaleSessions) evicts lobby-idlers —
  // observed killing room 2 when C booted while A and B waited.
  const C = await launchOne('C');
  await C.emulate(KnownDevices['iPad landscape']);
  await C.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(() => C.evaluate(() => !!window.__splat), 15000, '__splat on C (iPad)');
  await setMenuInputs(C, 'Cici', null);

  // -- ROOM 1: private room with the fixed seed 42 -------------------------------------
  // See the header: startRace(42) on an UNJOINED client is the only surface
  // path that attaches {seed} to a create. It also arms pendingStart — A's OWN
  // start, deferred until the room may legally start. B's join fires it.
  await A.evaluate((seed) => window.__splat.startRace(seed), FIXED_SEED);
  const code = await waitFor(async () => {
    const s = await splatState(A);
    if (!joinedState(s)) return null;
    return await getRoomCode(A);
  }, 10000, 'A creates the seed-42 private room (code readable)');
  check(
    '3. A creates a private room with settings {seed:42} (startRace(42) unjoined) and reads the code',
    typeof code === 'string' && code.length > 0,
    `code=${code ?? '?'}`,
  );

  // B joins by code through the REAL UI: name input, code input, JOIN BY CODE.
  // The join seats B, which lets A's armed {t:'start'} fire — the countdown
  // begins within a snapshot or two.
  await setMenuInputs(B, 'Bob', code);
  await waitFor(() => clickButtonByText(B, 'JOIN BY CODE'), 5000, 'B clicks JOIN BY CODE');
  await waitFor(async () => {
    const s = await splatState(B);
    return joinedState(s) ? s : null;
  }, 10000, 'B joins by code');

  // Start the phase observers NOW, before the latch waits below: the countdown
  // is 3s and slope-build + evaluate latency can outlast it — observed: a late
  // observer's FIRST sample was already 'racing' (the transition itself was
  // correct; only the watching started late). It is snapshot-carried (no
  // countdown events on the wire), so it must be watched from the join.
  const watchA = awaitRacing(A, 'room 1 A');
  watchA.catch(() => {}); // a later abort must not surface an unhandled rejection
  const watchB = awaitRacing(B, 'room 1 B');
  watchB.catch(() => {});

  // B's 4-YEAR-OLD latch: full lock, never changed again. The drive (and its
  // ext latch) exists only once the seed-42 slope is built at countdown entry
  // — setInput before that is a no-op on a null drive. Latch as soon as
  // state().sim is live (still pre-GO: the freeze holds inputs until racing).
  await waitFor(async () => {
    const s = await splatState(B);
    return ownSim(s) !== null ? true : null;
  }, 15000, "B's drive live (slope built at countdown entry)");
  await B.evaluate(() => window.__splat.setInput(-1));
  await A.evaluate(() => window.__splat.setInput(0)); // A skis the fall line

  const [raceA, raceB] = await Promise.all([watchA, watchB]);
  await B.evaluate(() => window.__splat.setInput(-1)); // re-latch at GO (belt and braces)
  const [teleA1, teleB1] = await Promise.all([splatTelemetry(A), splatTelemetry(B)]);
  const goAt = Date.now();
  check(
    '4. B joins by code and the race seats both skiers — each page interpolates the OTHER (1 remote each)',
    raceA !== null && raceB !== null && teleA1?.remotes?.length === 1 && teleB1?.remotes?.length === 1,
    `remotes A=${teleA1?.remotes?.length ?? '?'} B=${teleB1?.remotes?.length ?? '?'}`,
  );
  check(
    '5. START (A\'s explicit startRace(42)) -> countdown -> racing on both pages; the fixed seed 42 rides the snapshots',
    raceA.sawCountdown && teleA1?.seed === FIXED_SEED && teleB1?.seed === FIXED_SEED,
    `A phases [${raceA.seen.join(', ')}] B phases [${raceB.seen.join(', ')}]; seed A=${teleA1?.seed} B=${teleB1?.seed}`,
  );

  // -- drive: own sim advances AND the remote interp pipeline carries it ---------------
  // A's own sim z (state().sim — the predicted skier) must advance > 10m, and
  // B's telemetry().remotes view of A's skier (the INTERPOLATED remote) must
  // move > 5m over the same window, with a live interp buffer (samples >= 2).
  const sim0 = ownSim(await splatState(A));
  const z0 = sim0 !== null ? sim0.z : 0;
  const remote0 = teleB1?.remotes?.[0] ?? null;
  const rz0 = remote0 !== null && typeof remote0.z === 'number' ? remote0.z : 0;
  const drive = await waitFor(async () => {
    await A.evaluate(() => window.__splat.setInput(0)); // re-latch straight
    const [sa, tb] = await Promise.all([splatState(A), splatTelemetry(B)]);
    const sim = ownSim(sa);
    const rem = tb !== null && Array.isArray(tb.remotes) ? (tb.remotes[0] ?? null) : null;
    if (sim === null || rem === null || typeof rem.z !== 'number') return null;
    return sim.z - z0 > 10 && rem.z - rz0 > 5 && typeof rem.samples === 'number' && rem.samples >= 2
      ? { ownDz: sim.z - z0, remoteDz: rem.z - rz0, samples: rem.samples }
      : null;
  }, 40000, "A's own sim advances > 10m AND B's interpolated view of A advances > 5m").catch((err) => {
    console.log(String(err instanceof Error ? err.message : err));
    return null;
  });
  check(
    '6. drive: A\'s own sim advances > 10m AND B\'s remote interp view of A moves > 5m',
    drive !== null,
    drive !== null
      ? `own Δz=${drive.ownDz.toFixed(1)}m, remote Δz=${drive.remoteDz.toFixed(1)}m, interp samples=${drive.samples}`
      : 'timed out',
  );

  // -- draw calls (CONTRACT §8: < 80 during racing) --------------------------------------
  let maxDrawCalls = 0;
  for (let i = 0; i < 5; i++) {
    const t = await splatTelemetry(A);
    if (t !== null && typeof t.drawCalls === 'number') maxDrawCalls = Math.max(maxDrawCalls, t.drawCalls);
    await sleep(400);
  }
  check(
    '7. draw calls < 80 during racing (telemetry().drawCalls)',
    maxDrawCalls > 0 && maxDrawCalls < 80,
    `max sampled drawCalls=${maxDrawCalls}`,
  );

  // -- screenshot: first-person mid-descent at speed --------------------------------------
  await waitFor(async () => {
    const sim = ownSim(await splatState(A));
    return sim !== null && sim.z > 80 && sim.v > 12 ? sim : null;
  }, 30000, 'A mid-descent at speed (z > 80, v > 12)').catch(() => null);
  await shot(A, 'splat-descent.png');

  // -- steering sign (frozen convention) --------------------------------------------------
  // setInput(-1) = full screen-RIGHT: yaw goes negative, x DECREASES.
  // setInput(+1) = full screen-LEFT: x increases. Each leg: hold the lock until
  // yaw is committed past ±0.3 rad, THEN measure x over a 1.5s window. The yaw
  // gate is not decoration — the frozen sim has NO yaw return inside the soft
  // clamp (the spring only acts beyond ±YAW_MAX), so after a 2s lock the next
  // lock spends its first ~2s just swinging yaw back through 0; measuring x
  // from the flip would read the unwind, not the turn (observed: lock -1 moved
  // x -4.5 -> -22.2, then lock +1 moved it to -23.0 — yaw still negative).
  const steerLeg = async (steer, yawGate) => {
    await A.evaluate((st) => window.__splat.setInput(st), steer);
    const committed = await waitFor(async () => {
      const sim = ownSim(await splatState(A));
      return sim !== null && (steer < 0 ? sim.yaw < -yawGate : sim.yaw > yawGate) ? true : null;
    }, 10000, `yaw commits to ${steer < 0 ? '-' : '+'}${yawGate} rad under lock ${steer}`).catch(() => false);
    const s0 = ownSim(await splatState(A));
    await sleep(1500);
    const s1 = ownSim(await splatState(A));
    return {
      committed,
      yaw: s1?.yaw ?? null,
      dx: s0 !== null && s1 !== null ? s1.x - s0.x : null,
    };
  };
  const legRight = await steerLeg(-1, 0.3); // screen RIGHT: x must DECREASE
  const legLeft = await steerLeg(1, 0.3); // screen LEFT: x must INCREASE
  await A.evaluate(() => window.__splat.setInput(0)); // back to the fall line
  const steerRightOk = legRight.committed === true && legRight.dx !== null && legRight.dx < -1;
  const steerLeftOk = legLeft.committed === true && legLeft.dx !== null && legLeft.dx > 1;
  check(
    '8. steering sign: setInput(-1) = screen RIGHT (x decreases), setInput(+1) = screen LEFT (x increases)',
    steerRightOk && steerLeftOk,
    `lock -1: yaw=${legRight.yaw?.toFixed(2)} Δx=${legRight.dx?.toFixed(1)}m; ` +
      `lock +1: yaw=${legLeft.yaw?.toFixed(2)} Δx=${legLeft.dx?.toFixed(1)}m`,
  );

  // -- the run to the finish: plant hit, finish-gate shot, A's finish, B's 4yo watch ------
  // One poll loop over both pages until A's sim.finished (or the server's hard
  // cap ends the race first). It captures: the first plant contact
  // (state().sim.lastPlantIx >= 0 — the sim's own hit record, the strongest
  // signal; v is sampled at the hit for the detail line) with the close-up
  // screenshot at detection (the squash/shake + powder puff play for a beat;
  // +1s later an 18 m/s skier has left the plant far behind the first-person
  // camera), the finish-gate area shot late in the run, and a wall-timestamped
  // trail of B's z for the hard-cap-with-progress verdict.
  let plantHits = 0;
  let lastPlantIx = -1;
  let vAtFirstHit = null;
  let maxV = 0;
  let plantShotDone = false;
  let gateShotDone = false;
  let aFinishedSim = null;
  const bTrail = []; // [{t, z}] wall-timestamped B z samples
  let bPlantHits = 0;
  let bLastPlantIx = -1;
  let bFinishedSim = null;
  const runT0 = Date.now();
  while (Date.now() - runT0 < 175000) {
    const [sa, sb] = await Promise.all([splatState(A), splatState(B)]);
    const simA = ownSim(sa);
    const simB = ownSim(sb);
    if (simA !== null) {
      maxV = Math.max(maxV, simA.v);
      if (simA.lastPlantIx !== lastPlantIx) {
        if (typeof simA.lastPlantIx === 'number' && simA.lastPlantIx >= 0) {
          plantHits++;
          if (vAtFirstHit === null) vAtFirstHit = simA.v;
          if (!plantShotDone) {
            plantShotDone = true;
            await shot(A, 'splat-plant.png'); // at detection: the plant is AT the camera
          }
        }
        lastPlantIx = simA.lastPlantIx;
      }
      if (!gateShotDone && simA.z >= FINISH_Z - 70) {
        gateShotDone = true;
        await shot(A, 'splat-finish-gate.png');
      }
      if (simA.finished === true) {
        aFinishedSim = simA;
        break;
      }
    }
    if (simB !== null) {
      bTrail.push({ t: Date.now(), z: simB.z });
      if (bTrail.length > 400) bTrail.shift();
      if (simB.lastPlantIx !== bLastPlantIx) {
        if (typeof simB.lastPlantIx === 'number' && simB.lastPlantIx >= 0) bPlantHits++;
        bLastPlantIx = simB.lastPlantIx;
      }
      if (simB.finished === true && bFinishedSim === null) bFinishedSim = simB;
    }
    if (sa !== null && sa.phase === 'results') break; // hard cap beat A to the line
    await sleep(200);
  }
  const aFinishAt = Date.now();
  check(
    '9. plant contact: the straight seed-42 run hits plants (state().sim.lastPlantIx >= 0)',
    plantHits > 0,
    `hits=${plantHits} firstHitV=${vAtFirstHit !== null ? vAtFirstHit.toFixed(1) : '?'} m/s (clean-run maxV=${maxV.toFixed(1)})`,
  );
  const aStateAfter = await splatState(A);
  check(
    '10. A finishes the 800m: finished flag set, place 1 for the first finisher',
    aFinishedSim !== null && aStateAfter?.place === 1,
    aFinishedSim !== null
      ? `finishMs=${(aFinishedSim.finishMs / 1000).toFixed(1)}s sim, place=${aStateAfter?.place}, wall=${((aFinishAt - goAt) / 1000).toFixed(0)}s after GO`
      : 'A never finished inside the server hard cap (150s)',
  );

  // -- results + the 4-YEAR-OLD TEST (CONTRACT §9.5) ---------------------------------------
  // B has held setInput(-1) — full lock, never changed — since before GO. Keep
  // sampling B's z until the results phase (the grace window after A's finish,
  // or the hard cap), then judge: B finished (best), OR hard-cap-with-progress
  // (z > 300 AND still increasing over the last 10s of racing — SIM_DT_MAX
  // clamps sim time under SwiftShader, so a wall clock over-reads B's pace).
  let resultsAt = null;
  while (Date.now() - aFinishAt < 120000) {
    const [sa, sb] = await Promise.all([splatState(A), splatState(B)]);
    const simB = ownSim(sb);
    if (simB !== null) {
      bTrail.push({ t: Date.now(), z: simB.z });
      if (bTrail.length > 400) bTrail.shift();
      if (simB.lastPlantIx !== bLastPlantIx) {
        if (typeof simB.lastPlantIx === 'number' && simB.lastPlantIx >= 0) bPlantHits++;
        bLastPlantIx = simB.lastPlantIx;
      }
      if (simB.finished === true && bFinishedSim === null) bFinishedSim = simB;
    }
    if (sa !== null && sa.phase === 'results') {
      resultsAt = Date.now();
      break;
    }
    await sleep(200);
  }
  // B's z progress over the last 10s of RACING (samples before results entry).
  const bEnd = resultsAt ?? Date.now();
  const bLast = bTrail.length > 0 ? bTrail[bTrail.length - 1] : null;
  const bRef = bTrail.filter((p) => p.t <= bEnd - 10000).pop() ?? null;
  const bStillMoving = bLast !== null && bRef !== null && bLast.z - bRef.z > 2;
  const bZFinal = bLast !== null ? bLast.z : 0;
  const fourYoOk = bFinishedSim !== null || (bZFinal > 300 && bStillMoving);
  const fourYoDetail =
    bFinishedSim !== null
      ? `B FINISHED holding full lock the whole run (finishMs=${(bFinishedSim.finishMs / 1000).toFixed(1)}s sim, plantHits=${bPlantHits})`
      : `B did not finish before results (z=${bZFinal.toFixed(0)}m ${bZFinal > 300 ? '> 300' : '<= 300'}, ` +
        `${bStillMoving ? 'still moving' : 'NOT moving'} over the last 10s of racing, plantHits=${bPlantHits}) — hard-cap-with-progress under SwiftShader`;
  check(
    '11. 4-year-old test: B holds full lock from GO, never changes it — finishes OR hard-cap-with-progress',
    resultsAt !== null && fourYoOk,
    fourYoDetail,
  );

  // -- results screen: both pages, the panel shows BOTH players ---------------------------
  const resultsDomOk =
    resultsAt !== null &&
    (await waitFor(async () => {
      const [pa, pb] = await Promise.all([
        A.evaluate(() => {
          const panel = document.querySelector('.sh-results');
          return panel !== null && !panel.classList.contains('hidden')
            ? panel.querySelectorAll('.sh-row').length
            : -1;
        }),
        B.evaluate(() => {
          const panel = document.querySelector('.sh-results');
          return panel !== null && !panel.classList.contains('hidden')
            ? panel.querySelectorAll('.sh-row').length
            : -1;
        }),
      ]);
      return pa === 2 && pb === 2 ? true : null;
    }, 15000, 'results panel with 2 rows on both pages').catch(() => false));
  check(
    '12. results phase: both pages reach it and the results panel lists both players (DOM)',
    resultsDomOk === true,
    resultsAt !== null ? `results entered ${((resultsAt - goAt) / 1000).toFixed(0)}s after GO` : 'never reached results',
  );
  await shot(A, 'splat-results.png'); // the results window is 8s — shoot now

  // -- ROOM 2: pristine UI-created room — NO-AUTO-START proof, then the rematch ----------
  // Room 1's settings {seed:42} override pins EVERY rematch there to 42 (the
  // dev/e2e override is the whole point), and its start was armed by design —
  // so the clean no-auto-start hold and the rematch-new-seed proof both run in
  // a second room created through the real UI (no settings, nothing armed).
  // The lobby dwell is kept SHORT on purpose: a pre-first-race lobby sends no
  // room-bound messages, so the platform's stale sweep evicts anyone idle past
  // INPUT_STALE_MS (10s) — see the C-launch comment above. Order: room 1
  // results -> lobby (8s), both LEAVE to the menu, A CREATE PRIVATE, B JOIN BY
  // CODE, the 6s+ hold the moment MIN_PLAYERS is met, then C (already parked
  // at the menu) joins — a LATE joiner would be parked with the touch layer
  // down, so C must still seat BEFORE the start.
  // No inputs flow outside racing (drive.step is racing-only) and the results
  // window is 8s — refresh both seats' room liveness before the lobby wait so
  // the stale sweep cannot evict anyone mid-leave (see lobbyKeepalive).
  await Promise.all([lobbyKeepalive(A), lobbyKeepalive(B)]);
  await waitFor(async () => {
    const s = await splatState(A);
    return s !== null && s.phase === 'lobby' ? true : null;
  }, 20000, 'room 1 results -> lobby');
  await waitFor(() => clickButtonByText(A, 'LEAVE'), 10000, 'A clicks LEAVE');
  await waitFor(() => clickButtonByText(B, 'LEAVE'), 10000, 'B clicks LEAVE');
  await waitFor(async () => {
    const [sa, sb] = await Promise.all([splatState(A), splatState(B)]);
    return sa !== null && sb !== null && sa.phase === 'menu' && sb.phase === 'menu' ? true : null;
  }, 20000, 'both pages back at the menu after LEAVE');

  await setMenuInputs(A, 'Alice', null);
  await waitFor(() => clickButtonByText(A, 'CREATE PRIVATE'), 5000, 'A clicks CREATE PRIVATE');
  const code2 = await waitFor(async () => {
    const s = await splatState(A);
    if (!joinedState(s)) return null;
    return await getRoomCode(A);
  }, 10000, 'A creates room 2 (no settings)');
  await setMenuInputs(B, 'Bob', code2);
  await waitFor(() => clickButtonByText(B, 'JOIN BY CODE'), 5000, 'B joins room 2');
  await waitFor(async () => {
    const s = await splatState(B);
    return joinedState(s) ? true : null;
  }, 10000, 'B in room 2');

  // -- lobby does not auto-start (frozen lobby contract) -------------------------------
  // The whole point of the manual-start lobby: with MIN_PLAYERS seated the
  // room is ALLOWED to start and still must not. Both pages are seated and the
  // server says canStart — and BEFORE any press the harness holds for 6+
  // seconds, sampling both pages, and demands every single sample read
  // 'lobby'. canStart is re-read at the end: it proves the room could have
  // started the entire time and chose not to.
  const AUTOSTART_HOLD_MS = 6000;
  const holdPhases = new Set();
  const holdT0 = Date.now();
  let lastKeep = 0;
  while (Date.now() - holdT0 < AUTOSTART_HOLD_MS + 400) {
    // lobby-idlers send nothing on their own (see lobbyKeepalive) — without
    // this the platform's stale sweep evicts both seats ~10s into the room,
    // mid-hold (observed). splat_assist is not a start; the hold still proves
    // the phase machine never leaves 'lobby' without {t:'start'}.
    if (Date.now() - lastKeep > 2500) {
      lastKeep = Date.now();
      await Promise.all([lobbyKeepalive(A), lobbyKeepalive(B)]);
    }
    const [sa, sb] = await Promise.all([splatState(A), splatState(B)]);
    for (const s of [sa, sb]) {
      if (s !== null && typeof s.phase === 'string') holdPhases.add(s.phase);
    }
    await sleep(250);
  }
  const holdMs = Date.now() - holdT0;
  const [holdEndA, holdEndB] = await Promise.all([splatState(A), splatState(B)]);
  const stayedLobby = holdPhases.size === 1 && holdPhases.has('lobby');
  const holdCanStart = holdEndA?.canStart === true && holdEndB?.canStart === true;
  check(
    '13. lobby does not auto-start: MIN_PLAYERS seated and canStart true, the room is STILL in lobby after a 6s hold',
    holdMs >= AUTOSTART_HOLD_MS && stayedLobby && holdCanStart,
    `phases seen over ${(holdMs / 1000).toFixed(1)}s: [${[...holdPhases].join(', ')}]; ` +
      `canStart at the end A=${holdEndA?.canStart} B=${holdEndB?.canStart}`,
  );

  // C seats in room 2 (name was typed at park time — only the code is new).
  await setMenuInputs(C, null, code2);
  await waitFor(() => clickButtonByText(C, 'JOIN BY CODE'), 5000, 'C joins room 2');
  await waitFor(async () => {
    const [sc, ca] = await Promise.all([splatState(C), lobbyChipCount(A)]);
    return joinedState(sc) && ca === 3 ? true : null;
  }, 15000, 'C seated in room 2 (3 players)');

  // one more liveness refresh for every seat right before the press — the
  // {t:'start'} itself is A's refresh, but B and C send nothing in a lobby
  await Promise.all([lobbyKeepalive(A), lobbyKeepalive(B), lobbyKeepalive(C)]);

  // -- manual START (real button) -> the rematch gets a NEW slope seed ---------------------
  await pressStart(A, 'room 2 START');
  await Promise.all([awaitRacing(A, 'room 2 A'), awaitRacing(B, 'room 2 B'), awaitRacing(C, 'room 2 C')]);
  const teleRematch = await splatTelemetry(A);
  const seed2 = teleRematch !== null && typeof teleRematch.seed === 'number' ? teleRematch.seed : -1;
  check(
    '14. rematch without a seed gets a NEW slope seed (telemetry().seed !== 42, !== -1)',
    seed2 > 0 && seed2 !== FIXED_SEED,
    `race 1 seed=${FIXED_SEED} (settings override), room 2 seed=${seed2} (server rng)`,
  );

  // -- touch zones on the emulated iPad -----------------------------------------------------
  // A real touch tap arms tablet mode (the matchMedia auto-detect usually beats
  // us to it under device emulation); the layer is up only while seated AND
  // countdown/racing — C is mid-race now.
  await C.touchscreen.tap(590, 410).catch(() => {});
  const touchVisible = await waitFor(
    () =>
      C.evaluate(() => {
        const layer = document.querySelector('.touch-layer');
        if (layer === null || layer.classList.contains('hidden')) return null;
        const zones = layer.querySelectorAll('.touch-zone');
        if (zones.length !== 2) return null;
        const rectsOk = [...zones].every((z) => {
          const r = z.getBoundingClientRect();
          return r.width > 50 && r.height > 50;
        });
        return rectsOk ? true : null;
      }),
    15000,
    'touch layer with 2 full-size zones visible on the iPad during racing',
  ).catch(() => false);
  check(
    '15. touch zones: two thumb zones visible on the emulated iPad during racing',
    touchVisible === true,
    touchVisible === true ? 'left/right halves up, racing phase' : 'touch layer never showed',
  );
  await shot(C, 'splat-touch-ipad.png');

  // -- screenshot evidence (CONTRACT §9.6): non-trivial files, not blanks ---------------------
  const SHOTS = [
    'splat-descent.png',
    'splat-plant.png',
    'splat-finish-gate.png',
    'splat-results.png',
    'splat-touch-ipad.png',
  ];
  const shotSizes = SHOTS.map((n) => {
    try {
      return { n, size: statSync(path.join(SHOTS_DIR, n)).size };
    } catch {
      return { n, size: 0 };
    }
  });
  const shotsOk = shotSizes.every((s) => s.size > 30 * 1024);
  check(
    '16. screenshots captured and non-trivial (>30KB each — not blank frames)',
    shotsOk,
    shotSizes.map((s) => `${s.n}=${(s.size / 1024).toFixed(0)}KB`).join(' '),
  );

  // -- error surface --------------------------------------------------------------------------
  check('17. zero console/page/network errors on all pages', pageErrors.length === 0, `${pageErrors.length}`);
}

// ---- runner ---------------------------------------------------------------------------
let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error(`\nE2E-SPLAT ABORTED: ${err instanceof Error ? err.message : String(err)}`);
  check('e2e-splat completed without abort', false);
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  if (serverChild && serverChild.exitCode === null) {
    serverChild.kill('SIGTERM');
    await sleep(400);
    if (serverChild.exitCode === null) serverChild.kill('SIGKILL');
  }

  console.log('\n================ E2E-SPLAT SUMMARY ================');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  console.log(`assertions: ${results.filter((r) => r.ok).length}/${results.length} passed`);
  if (pageErrors.length > 0) {
    console.log(`\npage errors (${pageErrors.length}):`);
    for (const e of pageErrors) console.log(`  ${e}`);
  } else {
    console.log('page errors: 0');
  }
  const failed = results.filter((r) => !r.ok).length;
  exitCode = failed === 0 && pageErrors.length === 0 ? 0 : 1;
  console.log(exitCode === 0 ? '\nE2E-SPLAT GREEN' : `\nE2E-SPLAT RED (${failed} failed assertions, ${pageErrors.length} page errors)`);
  process.exit(exitCode);
}

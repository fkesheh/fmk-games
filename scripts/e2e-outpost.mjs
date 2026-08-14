#!/usr/bin/env node
// ============================================================================
// e2e-outpost — prove OUTPOST runs end-to-end in a real (headless) browser.
//
// Modelled closely on the mature scripts/e2e-splat.mjs: build with dist-
// artifact verification, killPortLeftovers() matching only this project's
// server process, server start with readiness polling (not a sleep), a
// SEPARATE BROWSER PROCESS PER CLIENT (no cross-tab rAF throttling), four
// error channels (console / pageerror / crash / requestfailed), an in-page
// phase recorder installed at load so fast transitions cannot be missed by
// CDP latency, bounded screenshots with retry and a hang probe, and a
// `finally` that ALWAYS reaps the server.
//
// UNLIKE splat, OUTPOST's whole scenario surface is on window.__outpost
// (OutpostDebugApi, games/outpost/shared/src/types.ts) — no DOM clicking is
// needed anywhere. `join`/`createPrivate`/`joinPrivate`/`start` seat and
// start players; `hurtSelf`/`teleport`/`breachSegment`/`spawnAt`/`setInvulnerable`
// STAGE server-authoritative scenarios instead of hoping emergent, server-
// random horde AI produces them (CONTRACT.md: "assert a real behaviour
// instead of hoping for one"). This script leans on that surface throughout.
//
// CONTRACT GAP, documented instead of worked around: the debug surface
// exposes zombie COUNTS (telemetry().zombiesAlive/zombiesWithin) but no
// per-zombie positions, and there is no "kill all zombies" debug op. So the
// real wave-1 clear (organic drip, unknown positions) is proven with a
// closed-loop controller, not a coordinate literal. `freeCam` moves the
// telemetry EYE to any point on the map and `zombiesWithin(r)` counts around
// it — together they are a radar. An arrived zombie stands at its segment's
// segmentAttackSpot (16 known points), so each survivor radars half the ring
// from the deck-2 PARAPET and puts aimed fire into whatever reads occupied.
// The parapet, not the deck centre: measured, a shot from the centre cannot
// clear the deck's own 1.0 m parapet at any useful depression angle, and a
// shambler at the fence survived eight aimed shots from there.
//
// ORDER MATTERS. Wave 1 is cleared FIRST, before any staged scenario, for
// one measured reason: only targets ~15 m out and beyond clear the parapet
// lip, so a horde that has already breached its way INSIDE cannot be cleared
// from the tower at all. Every scripted scenario (breach, kills, fence
// damage, repair, downed/revive) is staged afterwards, during wave 2.
//
// Env: E2E_PORT overrides the default port 8188; E2E_SKIP_BUILD=1 reuses the
// existing dist output; E2E_VIEWPORT=WxH overrides 640x360; E2E_PROTOCOL_TIMEOUT
// ms; E2E_DUMPIO=1 pipes browser stderr.
//
// Exit 0 only if every assertion passes AND zero page/console/network errors
// were seen on any page (benign favicon noise excluded).
// ============================================================================
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 8188);
const BASE = `http://localhost:${PORT}`;
const GAME_URL = `${BASE}/outpost/`; // the launcher lives at /; the outpost client is mounted at /outpost/
const SHOTS_DIR = path.join(ROOT, 'screenshots');

// The frozen window.__outpost debug surface (CONTRACT.md, shared/src/types.ts
// OutpostDebugApi). Both harnesses must assert this exists in full first.
const OUTPOST_SURFACE = [
  'state', 'telemetry',
  'join', 'createPrivate', 'joinPrivate', 'start',
  'hurtSelf', 'teleport', 'breachSegment', 'spawnAt', 'endRun', 'setInvulnerable',
  'setLook', 'setMove', 'press', 'fireOnce', 'reload', 'switchWeapon', 'buyWeapon', 'buyAmmo',
  'mapInfo', 'freeCam', 'releaseCam', 'setTimeOfDay', 'clearOverlays',
];

// ---- tiny framework -----------------------------------------------------------
const results = [];
const pageErrors = [];
let serverChild = null;
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

const opState = (page) =>
  page.evaluate(() => {
    try {
      return window.__outpost?.state() ?? null;
    } catch {
      return null;
    }
  });
const opTelemetry = (page) =>
  page.evaluate(() => {
    try {
      return window.__outpost?.telemetry?.() ?? null;
    } catch {
      return null;
    }
  });
const opMapInfo = (page) =>
  page.evaluate(() => {
    try {
      return window.__outpost?.mapInfo?.() ?? null;
    } catch {
      return null;
    }
  });

// ---- build + server -------------------------------------------------------------
function buildAll() {
  console.log('build: npm run build');
  const r = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`npm run build exited with code ${r.status}`);
  const outpostIndex = path.join(ROOT, 'games/outpost/client/dist/index.html');
  if (!existsSync(outpostIndex)) {
    throw new Error('games/outpost/client/dist/index.html missing after build (outpost client not wired into npm run build?)');
  }
  if (!existsSync(path.join(ROOT, 'platform/server/dist/server.js'))) {
    throw new Error('platform/server/dist/server.js missing after build');
  }
}

/**
 * Newest mtime under `dir` (recursive), or 0 when it does not exist.
 * `node_modules`/`dist`/dotfiles are skipped.
 */
function newestMtime(dir) {
  let newest = 0;
  let newestFile = '';
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      const m = statSync(p).mtimeMs;
      if (m > newest) {
        newest = m;
        newestFile = p;
      }
    }
  };
  walk(dir);
  return { mtime: newest, file: newestFile };
}

/**
 * E2E_SKIP_BUILD=1 reuses `dist`, and this harness runs the SERVER from the
 * BUNDLE at platform/server/dist/server.js — not from source. A stale bundle
 * is therefore a silent, total lie: a whole run of this suite once reported
 * seven red assertions purely because the bundle predated the one line in
 * games/outpost/server/src/module.ts that forwards `opts.settings` to the
 * room, so `settings.debug` never arrived, EVERY debug op was silently
 * dropped by room.ts's authorization gate, and the entire staged scenario
 * (teleport/spawnAt/breach/hurtSelf) no-oped while the source on disk was
 * correct the whole time. Never again: compare mtimes and refuse to run.
 */
function assertDistIsFresh() {
  const srcDirs = [
    'games/outpost/shared/src', 'games/outpost/server/src', 'games/outpost/client/src',
    'games/fps/shared/src',
    'platform/shared/src', 'platform/server/src',
  ].map((d) => path.join(ROOT, d));

  let newestSrc = { mtime: 0, file: '' };
  for (const d of srcDirs) {
    const n = newestMtime(d);
    if (n.mtime > newestSrc.mtime) newestSrc = n;
  }

  const artifacts = [
    { label: 'server bundle', file: path.join(ROOT, 'platform/server/dist/server.js') },
    { label: 'outpost client dist', dir: path.join(ROOT, 'games/outpost/client/dist') },
  ];
  const stale = [];
  for (const a of artifacts) {
    const built = a.dir !== undefined ? newestMtime(a.dir).mtime : statSync(a.file).mtimeMs;
    if (built < newestSrc.mtime) {
      stale.push(`${a.label} (built ${new Date(built).toISOString()})`);
    }
  }
  if (stale.length > 0) {
    throw new Error(
      `E2E_SKIP_BUILD=1 but the build output is STALE — this suite runs the BUNDLE, not the source, ` +
        `so it would test code you no longer have.\n` +
        `  newest source: ${path.relative(ROOT, newestSrc.file)} (${new Date(newestSrc.mtime).toISOString()})\n` +
        `  stale: ${stale.join('; ')}\n` +
        `  fix: npm run build   (or re-run without E2E_SKIP_BUILD=1)`,
    );
  }
}

/**
 * Re-runnability: a crashed prior run can leave its platform server LISTENING
 * on our port. Kill it — but ONLY a process whose command line is this repo's
 * built server; anything else is left alone.
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
  child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
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
    let html = null;
    try {
      const res = await fetch(GAME_URL, { signal: AbortSignal.timeout(2000) });
      if (res.ok) html = await res.text();
    } catch {
      // not up yet
    }
    if (html !== null) {
      // The platform server mounts /outpost/ as a REVERSE PROXY to the vite
      // dev server whenever @outpost/client's dev port answers its probe
      // (platform/server/src/index.ts, resolveMounts), and serves the built
      // client only when it does not. That silently defeats this suite's whole
      // premise — the stale-dist abort above exists precisely because this
      // suite runs the BUNDLE — and it is not academic: with a stray
      // `npm run dev` alive, three runs of this file served HMR'd SOURCE, one
      // 500ing on a mid-edit module and another having vite hot-reload the
      // page out from under the fight, taking `window.__outpost` with it.
      // Caught here rather than diagnosed later out of a nonsense failure.
      if (html.includes('/@vite/client')) {
        throw new Error(
          'a vite DEV SERVER is serving /outpost/ — the platform server proxied to it instead of ' +
            'serving the built client. This suite runs the BUNDLE, and HMR can reload the page ' +
            'mid-assertion. fix: stop `npm run dev` for this repo, then re-run.',
        );
      }
      return;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`server did not serve /outpost/ on :${PORT} within ${timeoutMs}ms`);
    await sleep(250);
  }
}

// ---- browser --------------------------------------------------------------------
const VIEWPORT = (() => {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(process.env.E2E_VIEWPORT ?? '');
  return m === null ? { width: 640, height: 360 } : { width: Number(m[1]), height: Number(m[2]) };
})();
const LAUNCH_ARGS = [
  `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];
// GPU backend. PERF.maxFrameMsUnderLoad (33 ms) is a budget for a real
// rasteriser; headless-shell defaults to ANGLE-over-SwiftShader (a CPU
// rasteriser), which renders this project's empty MENU at 100 ms/frame — so
// asserting a 33 ms frame budget against it measures the CPU rasteriser, not
// the game, and can never pass however the game is written. Ask for hardware
// ANGLE first and fall back to SwiftShader only if that yields no webgl2,
// shouting about it so a soft-rendered run is never mistaken for a perf
// verdict.
const HW_GL_ARGS = process.platform === 'darwin' ? ['--use-gl=angle', '--use-angle=metal'] : ['--use-gl=angle'];
const SW_GL_ARGS = ['--enable-unsafe-swiftshader'];
let softwareGl = false;
const PROTOCOL_TIMEOUT_MS = Number(process.env.E2E_PROTOCOL_TIMEOUT ?? 300000);
const LAUNCH_OPTS = {
  headless: 'shell',
  args: LAUNCH_ARGS,
  protocolTimeout: PROTOCOL_TIMEOUT_MS,
  dumpio: !!process.env.E2E_DUMPIO,
};

/** The unmasked GL renderer string of `page`, or '' when webgl2 is unavailable. */
const glRenderer = (page) =>
  page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  });

async function launchOne(tag) {
  let browser = await puppeteer.launch({ ...LAUNCH_OPTS, args: [...LAUNCH_ARGS, ...HW_GL_ARGS] });
  browsers.push(browser);
  let page = await browser.newPage();
  await page.setViewport({ width: VIEWPORT.width, height: VIEWPORT.height });
  let renderer = await glRenderer(page);
  if (renderer === '' || /swiftshader|llvmpipe|software/i.test(renderer)) {
    console.log(`[${tag}] no hardware webgl2 (got "${renderer || 'none'}") — falling back to swiftshader`);
    await browser.close();
    browsers.pop();
    browser = await puppeteer.launch({ ...LAUNCH_OPTS, args: [...LAUNCH_ARGS, ...SW_GL_ARGS] });
    browsers.push(browser);
    page = await browser.newPage();
    await page.setViewport({ width: VIEWPORT.width, height: VIEWPORT.height });
    renderer = await glRenderer(page);
    if (renderer === '') throw new Error(`[${tag}] webgl2 unavailable even on swiftshader`);
    softwareGl = true;
  }
  console.log(`[${tag}] gl: ${renderer}`);
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
async function probePage(page, label) {
  const evalP = page.evaluate(
    () =>
      new Promise((res) => {
        let st = null;
        let stateErr = null;
        try {
          st = window.__outpost ? window.__outpost.state() : null;
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
            res({ phase: st ? st.phase : null, stateErr, glLost, rafFired: raf, rafWaitMs: Math.round(performance.now() - t0) }),
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
  try {
    await page.screenshot({ path: file, timeout: 30000 });
    console.log(`shot  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return;
  } catch (err) {
    console.log(
      `shot  ${name}: capture failed at ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
        `(${err instanceof Error ? err.message : String(err)}) — probing, then one retry`,
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

// ---- in-page phase recorder --------------------------------------------------
// Samples window.__outpost.state().phase on rAF from the moment the page
// loads, so a fast transition (e.g. lobby -> wave the instant START lands)
// cannot be missed by CDP round-trip latency.
const installPhaseRecorder = (page) =>
  page.evaluate(() => {
    if (Array.isArray(window.__outpostPhaseLog)) return;
    window.__outpostPhaseLog = [];
    const tick = () => {
      let ph = null;
      try {
        ph = window.__outpost?.state()?.phase ?? null;
      } catch {
        ph = null;
      }
      const log = window.__outpostPhaseLog;
      if (typeof ph === 'string' && log[log.length - 1] !== ph) log.push(ph);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

const phaseLog = (page) => page.evaluate(() => (Array.isArray(window.__outpostPhaseLog) ? window.__outpostPhaseLog.slice() : []));

async function waitForPhase(page, phase, timeoutMs, label) {
  return waitFor(async () => {
    const s = await opState(page);
    return s !== null && s.phase === phase ? s : null;
  }, timeoutMs, label ?? `phase reaches '${phase}'`);
}

// ---- yaw math (map.ts's yawTo, replicated: forward = (-sin yaw, -cos yaw)) --------
const yawTo = (fx, fz, tx, tz) => Math.atan2(-(tx - fx), -(tz - fz));

// ---- main ---------------------------------------------------------------------------
async function main() {
  await mkdir(SHOTS_DIR, { recursive: true });
  if (process.env.E2E_SKIP_BUILD !== '1') {
    buildAll();
  } else {
    console.log('build: skipped (E2E_SKIP_BUILD=1) — reusing the existing dist output');
    if (
      !existsSync(path.join(ROOT, 'games/outpost/client/dist/index.html')) ||
      !existsSync(path.join(ROOT, 'platform/server/dist/server.js'))
    ) {
      throw new Error('E2E_SKIP_BUILD=1 but the dist output is missing — run npm run build once first');
    }
    assertDistIsFresh();
  }
  killPortLeftovers();
  startServer();
  await waitForServer();
  console.log(`server up on ${BASE} (outpost client at /outpost/)`);

  const A = await launchOne('A');
  const B = await launchOne('B');

  await A.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(() => A.evaluate(() => !!window.__outpost), 15000, '__outpost on A');
  await installPhaseRecorder(A);
  await B.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(() => B.evaluate(() => !!window.__outpost), 15000, '__outpost on B');
  await installPhaseRecorder(B);
  check('1. outpost client loads at /outpost/ (window.__outpost present)', true);

  const surfaceMissing = await A.evaluate((names) => {
    const k = window.__outpost;
    return names.filter((f) => typeof k?.[f] !== 'function');
  }, OUTPOST_SURFACE);
  check(
    '2. window.__outpost exposes the frozen debug surface',
    surfaceMissing.length === 0,
    surfaceMissing.length > 0 ? `missing: ${surfaceMissing}` : OUTPOST_SURFACE.join('/'),
  );

  const mapInfo = await waitFor(() => opMapInfo(A), 10000, 'A.mapInfo() readable');
  check('3. mapInfo() readable (16 segments, feature points)', Array.isArray(mapInfo?.segments) && mapInfo.segments.length === 16, `segments=${mapInfo?.segments?.length ?? '?'}`);

  // -- lobby: A creates, B joins by code -------------------------------------------
  await A.evaluate(() => window.__outpost.createPrivate('Alice'));
  const code = await waitFor(async () => {
    const s = await opState(A);
    return s !== null && s.joined === true && typeof s.code === 'string' && s.code.length > 0 ? s.code : null;
  }, 10000, 'A creates a private room and reads the code');
  check('4. A creates a private room (createPrivate) and reads the code', typeof code === 'string', `code=${code ?? '?'}`);

  await B.evaluate((c) => window.__outpost.joinPrivate('Bob', c), code);
  await waitFor(async () => {
    const s = await opState(B);
    return s !== null && s.joined === true ? true : null;
  }, 10000, 'B joins by code (joinPrivate)');
  const seatedBoth = await waitFor(async () => {
    const s = await opState(A);
    return s !== null && s.seated === 2 ? true : null;
  }, 10000, 'A sees 2 seated');
  check('5. B joins A\'s room by code — both seated', seatedBoth === true, `seated=2`);

  // -- lobby does not auto-start -----------------------------------------------------
  // MIN_PLAYERS is 1, so canStart is already true with just A seated — the
  // hold proves the room stays in 'lobby' regardless, for the WHOLE hold, on
  // BOTH pages, even though the server would legally allow a start the entire
  // time.
  const AUTOSTART_HOLD_MS = 6000;
  const holdPhases = new Set();
  const holdT0 = Date.now();
  while (Date.now() - holdT0 < AUTOSTART_HOLD_MS) {
    const [sa, sb] = await Promise.all([opState(A), opState(B)]);
    for (const s of [sa, sb]) if (s !== null && typeof s.phase === 'string') holdPhases.add(s.phase);
    await sleep(250);
  }
  const [holdEndA, holdEndB] = await Promise.all([opState(A), opState(B)]);
  const stayedLobby = holdPhases.size === 1 && holdPhases.has('lobby');
  const holdCanStart = holdEndA?.canStart === true && holdEndB?.canStart === true;
  check(
    '6. lobby does not auto-start: seated + canStart true, room is STILL in lobby after a 6s hold',
    stayedLobby && holdCanStart,
    `phases seen: [${[...holdPhases].join(', ')}]; canStart A=${holdEndA?.canStart} B=${holdEndB?.canStart}`,
  );

  // -- START -> opening lull -> wave 1 ------------------------------------------------
  // Phase has only 4 values (lobby/wave/intermission/ended) — the lull is the
  // start of 'wave' with zero zombies alive yet (WAVES.openingLullSec = 8s
  // before the drip begins). Capture the whole sequence: phase flips to
  // 'wave' promptly, stays at zombiesAlive===0 through the lull, then the
  // drip brings zombiesAlive above 0.
  await A.evaluate(() => window.__outpost.start());
  const waveState = await waitForPhase(A, 'wave', 15000, "phase 'lobby' -> 'wave' after START");
  const lullZeroAt = await opTelemetry(A);
  let sawLullZero = lullZeroAt !== null && lullZeroAt.zombiesAlive === 0;
  const spawnT0 = Date.now();
  const firstSpawn = await waitFor(async () => {
    const t = await opTelemetry(A);
    if (t !== null && t.zombiesAlive === 0) sawLullZero = true;
    return t !== null && t.zombiesAlive > 0 ? t : null;
  }, 20000, 'wave 1 zombies begin spawning (telemetry().zombiesAlive > 0)').catch(() => null);
  const logA = await phaseLog(A);
  check(
    '7. START -> opening lull -> wave 1: phase leaves lobby for wave, zombiesAlive is 0 through the lull, then the drip begins',
    waveState !== null && waveState.wave === 1 && sawLullZero && firstSpawn !== null,
    `phase log=[${logA.join(', ')}] wave=${waveState?.wave} lullZeroSeen=${sawLullZero} ` +
      `firstSpawnAfter=${firstSpawn !== null ? `${((Date.now() - spawnT0) / 1000).toFixed(1)}s` : 'timeout'} zombiesAlive=${firstSpawn?.zombiesAlive ?? '?'}`,
  );

  // ==========================================================================
  // WAVE 1 IS CLEARED FIRST, and it is fought from the FIRING STEP.
  //
  // This block used to run last, after ~90 s of staged scenarios, and it
  // teleported both survivors to the deck CENTRE (0, DECK2_Y, 0) to sweep a
  // yaw circle at a fixed pitch. Three separate measurements killed that plan:
  //
  //   * From the deck CENTRE nothing on the ground is shootable at all. Deck 2
  //     is a 14x14 slab (TOWER_HALF 7) ringed by a 1.0 m parapet, so a ray
  //     from an eye 1.62 m above the centre only clears the parapet at ~5
  //     degrees of depression — it lands 90+ m out. Fired at pitch -0.42 it
  //     hit the deck's own floor. Probed: from the centre a shambler standing
  //     at the fence survived 8 aimed shots; from the PARAPET it died.
  //   * From the PARAPET only targets ~15 m out and beyond clear the lip, so
  //     anything that has reached the tower footing is unreachable from up
  //     there. That is the design working (config.ts: "spitters break
  //     turtling on the top deck"), but it means a horde that is already
  //     INSIDE cannot be cleared from the tower at all.
  //   * Even against the fence line the deck is a bad firing position: a
  //     full instrumented run put 104 aimed rounds into segment attack spots
  //     from the parapet for THIRTEEN scrap of assist damage and zero kills,
  //     because a zombie chewing a segment stands BEHIND the 1.6 m fence and
  //     only the top few centimetres of it clear the wall at that angle.
  //
  // config.ts FENCE.height documents the position the map was built around,
  // with the arithmetic: the inside FIRING STEP (FENCE.stepHeight 0.4) puts a
  // survivor's eye at 2.02 m, "0.42 m over a 0.65 m run to the outer face — a
  // ~33 deg depression, putting the lowest reachable point at y=1.00 at that
  // range. Head and torso of every kind are hittable." So that is where this
  // fights from: point blank, over the wall, at the design's own numbers.
  //
  // Targeting is a real closed loop, not a coordinate literal. `freeCam`
  // moves the telemetry EYE anywhere on the map and `zombiesWithin(r)` counts
  // around it, which turns the frozen debug surface into a radar. Each
  // survivor works three tiers, in order: its half of the wall (where
  // fence-chewers stand still), then its own surroundings at an anchor (a
  // zombie inside the wire chases the nearest survivor, so the way to fix a
  // MOVING target is to stand still and let it close), then — only when the
  // alive count has not moved for 11 s — a coarse sweep of the entire
  // playfield and a sortie to whatever is left.
  //
  // The aim itself is a count-weighted CENTROID of a line scan, not the
  // argmax probe point: see `centroid` below for the measurement that forced
  // it. Ammunition is read off the HUD (the server's own you.mag/you.reserve)
  // rather than counted locally, and a confirmed kill blacklists its own spot
  // for HORDE.corpseSec so the next burst is not spent on a body.
  //
  // Both survivors are STAGED INVULNERABLE for this one block. Once a segment
  // breaches the horde comes through it, and a two-pistol squad standing on
  // the ground against wave 1 dies — which would prove nothing either way,
  // because this assertion is about the wave/phase machine draining to zero
  // and advancing, not about survivability. The one assertion that IS a
  // survival claim (#11, melee reach vs the tower deck) runs later with
  // invulnerability explicitly OFF.
  const deck2Y = mapInfo.deck2Y;
  const EYE_UP = 1.62; // PLAYER.heightStand 1.8 - eyeOffset 0.18
  const STEP_H = 0.4; // FENCE.stepHeight — the inside firing step
  const STEP_STAND_IN = 0.6; // body centre inset from the wall centre line while on the step
  // Aim height. `hitscan` boxes a zombie's BODY from its feet up to
  // height - HEAD_BOX_H, i.e. y 0..1.55 for a 1.85 m shambler, with the head
  // box above that (games/fps/shared physics.ts, playerHitboxes). 1.35 sits
  // solidly inside the body box with 0.2 m of margin below the head split —
  // and, from the 2.02 m eye on the firing step, it puts the ray 1.78 m up as
  // it crosses the wall's outer face at the ~2.2 m engagement range, well
  // clear of FENCE.height 1.6. The old 1.2 cleared that lip by 2 cm.
  const AIM_Y = 1.35;
  const outwardNormal = (side) =>
    side === 'north' ? { nx: 0, nz: -1 }
      : side === 'south' ? { nx: 0, nz: 1 }
        : side === 'east' ? { nx: 1, nz: 0 }
          : { nx: -1, nz: 0 };
  const isHoriz = (side) => side === 'north' || side === 'south';
  /** A point `along` metres along the wall and `out` metres outward from it. */
  const segPoint = (seg, along, out) => {
    const n = outwardNormal(seg.side);
    return isHoriz(seg.side)
      ? { x: seg.cx + along, z: seg.cz + n.nz * out }
      : { x: seg.cx + n.nx * out, z: seg.cz + along };
  };
  const pitchTo = (fy, fx, fz, tx, ty, tz) =>
    Math.atan2(ty - fy, Math.max(Math.hypot(tx - fx, tz - fz), 0.4));
  const ammoCrate = mapInfo.features.find((f) => f.key === 'ammoCrate') ?? null;

  const makeHunter = (page, tag, segIds, anchor) => {
    let shotsFired = 0;
    let refills = 0;
    let reloads = 0;
    let knifeOut = false;

    // ---- ammo: the SERVER's own numbers, read off the HUD ------------------
    // `telemetry()` (frozen shape) carries no mag/reserve, but the HUD renders
    // `you.mag`/`you.reserve` straight out of the snapshot into .oh-mag/.oh-res
    // (client/src/ui/hud.ts, updateAmmo), so the DOM IS the authoritative
    // readout. The previous driver COUNTED trigger pulls instead, and that
    // desynced on every pull the server declined (still inside `nextShotAt`,
    // or mid-reload): it believed itself dry with a loaded gun, spent scrap on
    // crate refills it did not need, and finished the wave on the knife with
    // an empty reserve — which is what left assertions 12/13/15 downstream
    // with no ammunition and no scrap.
    const ammo = () =>
      page.evaluate(() => {
        const read = (sel) => {
          const el = document.querySelector(sel);
          const v = Number.parseInt(el?.textContent ?? '', 10);
          return Number.isFinite(v) ? v : -1; // ammoText renders melee as '—'
        };
        return { mag: read('.oh-mag'), reserve: read('.oh-res') };
      });

    const reload = async () => {
      await page.evaluate(() => window.__outpost.reload());
      reloads++;
      await sleep(2200); // WEAPONS.pistol.reload 2.0 s, plus a snapshot to land
    };

    /** Ground-floor ammo crate run — needs ECONOMY.ammoRefillCost (60) banked. */
    const refill = async () => {
      const t = await opTelemetry(page);
      if (ammoCrate === null || (t?.scrap ?? 0) < 60) return false;
      await page.evaluate((x, y, z) => window.__outpost.teleport(x, y, z), ammoCrate.x + 0.9, mapInfo.footingH, ammoCrate.z + 0.9);
      await sleep(700); // let `interactKind` resolve to 'ammoCrate' in a snapshot
      await page.evaluate(() => window.__outpost.buyAmmo());
      await sleep(400);
      const after = await ammo();
      if (after.reserve <= 0) return false;
      refills++;
      return true;
    };

    /**
     * Out of pistol rounds and out of scrap: draw the KNIFE. It is issued to
     * every survivor (SURVIVOR.startWeapons), carries mag/reserve -1 (never
     * runs out), does 40 damage with ZERO spread, and reaches 2.4 m — further
     * than the ~1.7 m from the firing step to a zombie chewing the wall.
     * Slower (0.8 s between swings) but unlimited, so a clear can always
     * finish instead of stalling on an empty gun. With the aim fixed below
     * this is a genuine last resort, not the normal path.
     */
    const drawKnife = async () => {
      if (knifeOut) return;
      knifeOut = true;
      await page.evaluate(() => window.__outpost.switchWeapon('knife'));
      await sleep(400);
    };

    /** Make sure the trigger will actually produce bullets for a `need`-shot burst. */
    const arm = async (need) => {
      if (knifeOut) return;
      const a = await ammo();
      if (a.mag < 0) { knifeOut = true; return; } // melee already in hand
      if (a.mag >= need) return;
      if (a.reserve > 0) { await reload(); return; }
      if (a.mag > 0) return; // fire the last of the magazine
      if (await refill()) { await reload(); return; }
      await drawKnife();
    };

    // ---- radar -------------------------------------------------------------
    /**
     * Park the telemetry eye on each point in turn and count zombies around
     * it — a WHOLE scan in ONE page.evaluate.
     *
     * The batching is not a micro-optimisation, it is what makes the driver
     * fast enough to fight. `freeCam` only assigns a field and
     * `zombiesWithin` only walks the client's zombie list, so a hundred
     * samples cost microseconds in-page — but one CDP round trip EACH costs
     * ~60 ms, and a per-point implementation spent ~10 s of every ~15 s loop
     * scanning instead of shooting (measured: 84 aimed shots in 182 s). It is
     * also more accurate: every sample in a batch reads the same frame, so a
     * walking zombie cannot smear a line scan the way it can when the samples
     * are spread across three seconds of wall clock.
     *
     * Always leaves the camera RELEASED, so telemetry()/screenshots that
     * follow see the survivor's own eye.
     */
    const scan = (points, radius) =>
      page.evaluate(
        (pts, r) => {
          const k = window.__outpost;
          const out = [];
          for (const p of pts) {
            k.freeCam(p[0], 1.2, p[1], 0, 0);
            out.push(k.telemetry().zombiesWithin(r));
          }
          k.releaseCam();
          return out;
        },
        points, radius,
      );
    const probe = async (x, z, r) => (await scan([[x, z]], r))[0] ?? 0;
    const releaseCam = () => page.evaluate(() => window.__outpost.releaseCam());

    /**
     * Count-weighted centroid of the strongest CONTIGUOUS run of positive
     * samples in a line scan, or null if the whole line read zero.
     *
     * This is the whole aiming fix. The radar answers COUNTS, never positions,
     * and the previous driver aimed at the ARGMAX probe POINT of a coarse grid
     * (1.1 m radius, refined at 0.5 m), so its aim carried up to ~0.5 m of
     * error — and worse, its refine pass kept the LAST sample that tied rather
     * than the most central one, which biases the fix to the edge of the
     * target. Measured against the real hitbox that is a miss: `hitscan` boxes
     * a zombie at PLAYER.radius 0.3 (games/fps/shared physics.ts,
     * `playerHitboxes` — the kind's own 0.34 radius is used by movement, not
     * by the ray), i.e. a 0.6 m wide target at the ~2.2 m engagement range.
     * Two instrumented runs landed 9 and 10 of wave 1's 11 shamblers and then
     * emptied both reserves missing the rest, at a ~19% hit rate.
     *
     * A count field still pins the target precisely: the samples that can see
     * a zombie form an interval centred ON it, so their centroid IS it, to
     * about the sample pitch. Contiguity keeps two zombies on one segment from
     * averaging into the empty gap between them.
     */
    const centroid = (samples) => {
      let bestSum = 0;
      let bestW = 0;
      let bestPeak = 0;
      let sum = 0;
      let w = 0;
      let peak = 0;
      const flush = () => {
        if (w > 0 && (peak > bestPeak || (peak === bestPeak && w > bestW))) {
          bestSum = sum;
          bestW = w;
          bestPeak = peak;
        }
        sum = 0;
        w = 0;
        peak = 0;
      };
      for (const s of samples) {
        if (s.n > 0) {
          sum += s.v * s.n;
          w += s.n;
          peak = Math.max(peak, s.n);
        } else {
          flush();
        }
      }
      flush();
      return bestW > 0 ? bestSum / bestW : null;
    };

    const lineScan = async (from, to, step, radius, at) => {
      const vs = [];
      for (let v = from; v <= to + 1e-9; v += step) vs.push(v);
      const counts = await scan(vs.map((v) => { const p = at(v); return [p.x, p.z]; }), radius);
      return centroid(vs.map((v, i) => ({ v, n: counts[i] ?? 0 })));
    };

    /**
     * Precise fix on the knot chewing `seg`, in that segment's own
     * (along, out) coordinates. Scanned past the segment's own ±5 m so a
     * zombie standing near a joint is not truncated (a truncated interval has
     * a biased centroid).
     */
    const fixAtSegment = async (seg) => {
      // Pass 1 — along the wall, at the band a fence-chewer occupies. Every
      // kind here stops the instant `segmentDistance <= meleeReach`, so it
      // stands ~0.9-1.9 m off the wall's centre line; one probe radius spans
      // the whole band, which keeps this pass one-dimensional.
      const along = await lineScan(-6.3, 6.3, 0.35, 1.0, (a) => segPoint(seg, a, 1.4));
      if (along === null) return null;
      // Pass 2 — how far out it actually stands, on that along line.
      const out = await lineScan(0.6, 3.2, 0.2, 0.55, (o) => segPoint(seg, along, o)) ?? 1.5;
      return { ...segPoint(seg, along, out), along, out };
    };

    /** The same fix in open ground: orthogonal centroid scans, x then z then x. */
    const fixAtPoint = async (cx, cz) => {
      const x0 = await lineScan(cx - 3.0, cx + 3.0, 0.35, 1.0, (v) => ({ x: v, z: cz }));
      if (x0 === null) return null;
      const z = await lineScan(cz - 3.0, cz + 3.0, 0.3, 0.6, (v) => ({ x: x0, z: v })) ?? cz;
      const x = await lineScan(x0 - 1.6, x0 + 1.6, 0.25, 0.6, (v) => ({ x: v, z })) ?? x0;
      return { x, z };
    };

    /**
     * Coarse sweep of the WHOLE playfield, used only when neither the wall nor
     * the survivor's own surroundings read occupied. The old driver had no
     * such fallback: it only ever looked at the 16 segment attack spots and a
     * 14 m ring around its anchor, so a single zombie that stalled anywhere
     * else was invisible and the wave could never drain to zero. Step 12 with
     * a 8.6 m radius leaves no gap (the worst-cased cell centre is 8.49 m from
     * the nearest sample); HORDE.spawnRing is 58, so ±60 covers every zombie
     * that exists.
     */
    const globalSweep = async () => {
      const pts = [];
      for (let x = -60; x <= 60; x += 12) for (let z = -60; z <= 60; z += 12) pts.push([x, z]);
      const counts = await scan(pts, 8.6);
      const hits = pts.flatMap((p, i) => ((counts[i] ?? 0) > 0 ? [{ x: p[0], z: p[1] }] : []));
      if (hits.length === 0) return null;
      hits.sort((p, q) => Math.hypot(p.x - anchor.x, p.z - anchor.z) - Math.hypot(q.x - anchor.x, q.z - anchor.z));
      return hits[0];
    };

    // ---- shooting ----------------------------------------------------------
    /** One aimed shot from `from` at `target`. */
    const fireOne = async (from, eyeY, target) => {
      const yaw = yawTo(from.x, from.z, target.x, target.z);
      const pitch = pitchTo(eyeY, from.x, from.z, target.x, AIM_Y, target.z);
      await page.evaluate(
        (yw, pt) => {
          window.__outpost.setLook(yw, pt);
          window.__outpost.fireOnce();
        },
        yaw, pitch,
      );
      shotsFired++;
      // WEAPONS.pistol.interval is 0.17 s and knife 0.8 s; a faster cadence is
      // swallowed by the server's own nextShotAt and just looks like a miss.
      await sleep(knifeOut ? 850 : 190);
    };

    /** ceil(shambler hp 90 / pistol damage 25) — wave 1's hp multiplier is 1.0. */
    const BURST = 4;

    /**
     * Corpses answer the radar for HORDE.corpseSec (6 s) — `zombiesWithin`
     * counts every zombie the client holds, while `zombiesAlive` excludes the
     * dying. So a CONFIRMED kill blacklists its own spot: a later fix landing
     * there is a body, not a threat.
     */
    const corpses = [];
    const isCorpse = (x, z) => {
      const now = Date.now();
      return corpses.some((c) => c.until > now && Math.hypot(c.x - x, c.z - z) < 1.0);
    };

    /**
     * One engagement: take the stance, then RE-FIX AND FIRE ONE SHOT AT A TIME
     * until this survivor banks a kill (or the allowance runs out).
     *
     * Re-aiming per shot is what makes a moving target killable at all. A
     * shambler walks 1.7 m/s, so a fix taken once and then emptied into over a
     * ~1 s burst is stale by more than the 0.6 m the hitbox is wide. Now that
     * a whole line scan is ONE round trip, a fresh fix costs ~0.1 s — less
     * than the weapon's own 0.17 s cycle — so there is no reason to shoot at
     * a remembered position ever again.
     *
     * Feedback is this survivor's OWN scrap, which is unambiguous where
     * `zombiesAlive` is not (it also moves when the partner shoots, and when
     * the drip spawns). ECONOMY: a shambler kill banks killScrap 12 (x1.5
     * headshot), while a hit that does not kill banks assistScrapPer100 x
     * dmg/100 = 1 for a 25-damage body shot. So >= 10 is a kill, >= 1 is a
     * hit, 0 is a clean miss — which is also the only honest way to tell a
     * bad fix from a healthy fight.
     */
    const engage = async (stand, standY, eyeY, refix) => {
      await page.evaluate((x, y, z) => window.__outpost.teleport(x, y, z), stand.x, standY, stand.z);
      await sleep(200);
      await arm(BURST);
      const allowance = knifeOut ? 4 : BURST + 2; // 2 misses' worth of slack
      for (let i = 0; i < allowance; i++) {
        const target = await refix();
        if (target === null || isCorpse(target.x, target.z)) return false;
        const before = (await opTelemetry(page))?.scrap ?? 0;
        await fireOne(stand, eyeY, target);
        const after = (await opTelemetry(page))?.scrap ?? before;
        if (after - before >= 10) {
          corpses.push({ x: target.x, z: target.z, until: Date.now() + 6500 });
          return true;
        }
      }
      return false;
    };

    /**
     * A fix that follows its target: each call re-scans around where the
     * target was LAST seen, not around the coarse cell it was first spotted
     * in, so a zombie walking toward the survivor stays inside the scan window.
     */
    const tracker = (seed) => {
      let at = seed;
      return async () => {
        const f = await fixAtPoint(at.x, at.z);
        if (f !== null) at = f;
        return f;
      };
    };

    const hunt = async (deadline) => {
      let lastGlobal = 0;
      for (;;) {
        const [s, t] = await Promise.all([opState(page), opTelemetry(page)]);
        if (s === null || s.phase !== 'wave') return s?.phase ?? null;
        if (Date.now() > deadline) return 'TIMEOUT';

        // --- 1. my half of the wall, where fence-chewers stand still --------
        // One batched gate pass over EVERY segment I own, three samples each
        // so the whole 10 m span is covered. The old gate was a single 3.5 m
        // probe at the centre attack spot, which left the outer 1.5 m of every
        // segment — and therefore every corner — blind.
        const mine = segIds
          .map((id) => mapInfo.segments.find((sg) => sg.id === id))
          .filter((seg) => seg !== undefined && t?.segments?.[seg.id]?.breached !== true);
        const gatePts = [];
        for (const seg of mine) for (const a of [-3.4, 0, 3.4]) {
          const p = segPoint(seg, a, 1.5);
          gatePts.push([p.x, p.z]);
        }
        const gate = gatePts.length > 0 ? await scan(gatePts, 3.4) : [];
        let engaged = false;
        for (let m = 0; m < mine.length; m++) {
          const seg = mine[m];
          if (seg === undefined) continue;
          if (!((gate[m * 3] ?? 0) > 0 || (gate[m * 3 + 1] ?? 0) > 0 || (gate[m * 3 + 2] ?? 0) > 0)) continue;
          const fix = await fixAtSegment(seg);
          await releaseCam();
          if (fix === null || isCorpse(fix.x, fix.z)) continue;
          engaged = true;
          // Stand on the firing step at the target's own along-the-wall
          // coordinate, so the shot goes straight out over the wall. Clamped
          // to this segment so the stance never wanders round a corner.
          const stand = segPoint(seg, Math.max(-4.8, Math.min(4.8, fix.along)), -STEP_STAND_IN);
          await engage(stand, STEP_H, STEP_H + EYE_UP, () => fixAtSegment(seg));
          const s2 = await opState(page);
          if (s2 === null || s2.phase !== 'wave') return s2?.phase ?? null;
        }
        if (engaged) continue;

        // --- 2. anything already inside comes to ME -------------------------
        // Zombies through a breach chase the nearest living survivor, so the
        // correct move against a MOVING target is to stand still and let it
        // close: a stationary target is the only one a count-radar can fix
        // faster than it walks out of the fix.
        await releaseCam();
        await page.evaluate((x, z) => window.__outpost.teleport(x, 0, z), anchor.x, anchor.z);
        await sleep(400);
        let coarse = null;
        for (const r of [2.5, 5, 9, 14]) {
          if ((await probe(anchor.x, anchor.z, r)) === 0) continue;
          const ring = [];
          for (let i = 0; i < 12; i++) {
            const a = (i / 12) * Math.PI * 2;
            ring.push([anchor.x + Math.sin(a) * r, anchor.z + Math.cos(a) * r]);
          }
          const counts = await scan(ring, r <= 2.5 ? 1.4 : 2.6);
          const hit = ring.findIndex((_, i) => (counts[i] ?? 0) > 0);
          if (hit >= 0) coarse = { x: ring[hit][0], z: ring[hit][1] };
          break;
        }
        if (coarse !== null) {
          const fix = await fixAtPoint(coarse.x, coarse.z);
          await releaseCam();
          if (fix !== null && !isCorpse(fix.x, fix.z)) {
            await engage(anchor, 0, EYE_UP, tracker(fix));
            const s3 = await opState(page);
            if (s3 === null || s3.phase !== 'wave') return s3?.phase ?? null;
            continue;
          }
        }

        // --- 3. nothing I can see: sweep the whole map and go to it ---------
        // Nothing at my wall and nothing around me, so the remainder is either
        // still crossing the approach or has stalled somewhere neither of the
        // first two steps can look — and a wave that never drains to zero
        // never becomes an intermission. This tier is what the old driver was
        // missing entirely: it only ever looked at 16 attack spots and a 14 m
        // ring, so a single zombie anywhere else was invisible, and two
        // instrumented runs ended with exactly one or two survivors of wave 1
        // alive and unfindable while the clock ran out.
        if (Date.now() - lastGlobal > 6000) {
          lastGlobal = Date.now();
          const hit = await globalSweep();
          if (hit !== null) {
            const fix = await fixAtPoint(hit.x, hit.z);
            await releaseCam();
            if (fix !== null && !isCorpse(fix.x, fix.z)) {
              const outside = Math.max(Math.abs(fix.x), Math.abs(fix.z)) > mapInfo.fenceHalf;
              // Take a stance 5.5 m off, on the far side from the compound for
              // something outside the wire (open field, clear line) and on the
              // near side for anything inside it. Reject a stance that lands
              // inside the tower footprint or on the wrong side of the fence.
              const len = Math.max(0.001, Math.hypot(fix.x, fix.z));
              const ux = fix.x / len;
              const uz = fix.z / len;
              const dirs = outside
                ? [[ux, uz], [-uz, ux], [uz, -ux], [-ux, -uz]]
                : [[-ux, -uz], [-uz, ux], [uz, -ux], [ux, uz]];
              let stand = null;
              for (const [dx, dz] of dirs) {
                const p = { x: fix.x + dx * 5.5, z: fix.z + dz * 5.5 };
                const inTower = Math.abs(p.x) < 8.6 && Math.abs(p.z) < 8.6;
                const pOutside = Math.max(Math.abs(p.x), Math.abs(p.z)) > mapInfo.fenceHalf;
                if (!inTower && pOutside === outside && Math.abs(p.x) < 70 && Math.abs(p.z) < 70) {
                  stand = p;
                  break;
                }
              }
              if (stand !== null) {
                await engage(stand, 0, EYE_UP, tracker(fix));
                const s4 = await opState(page);
                if (s4 === null || s4.phase !== 'wave') return s4?.phase ?? null;
                continue;
              }
            }
          }
        }
        await sleep(700);
      }
    };
    return { hunt, stats: () => ({ tag, shotsFired, reloads, refills, knifeOut }) };
  };

  const clearT0 = Date.now();
  const CLEAR_TIMEOUT_MS = 180000;
  await A.evaluate(() => window.__outpost.setInvulnerable(true));
  await B.evaluate(() => window.__outpost.setInvulnerable(true));
  const hunterA = makeHunter(A, 'A', [0, 1, 2, 3, 4, 5, 6, 7], { x: 0, z: 12 });
  const hunterB = makeHunter(B, 'B', [8, 9, 10, 11, 12, 13, 14, 15], { x: 0, z: -12 });
  const clearDeadline = clearT0 + CLEAR_TIMEOUT_MS;
  const [huntPhaseA] = await Promise.all([hunterA.hunt(clearDeadline), hunterB.hunt(clearDeadline)]);
  await A.evaluate(() => window.__outpost.releaseCam());
  await B.evaluate(() => window.__outpost.releaseCam());
  const clearedState = await opState(A);
  const [clearEndA, clearEndB] = await Promise.all([opTelemetry(A), opTelemetry(B)]);
  // 'intermission', NOT merely "not 'wave'": a squad wipe also leaves 'wave'
  // — for 'ended' — so the old loose test scored the exact failure it existed
  // to catch as a PASS, and then reported the perf numbers of a run-end screen.
  const wave1Cleared =
    clearedState !== null && clearedState.phase === 'intermission' && (clearEndA?.zombiesAlive ?? -1) === 0;
  check(
    '8. wave 1 clears: radar-guided fire from the fence firing step drains zombiesAlive to 0 and the phase becomes \'intermission\'',
    wave1Cleared,
    `hunt exited via phase=${huntPhaseA} after ${((Date.now() - clearT0) / 1000).toFixed(0)}s; ` +
      `phase now=${clearedState?.phase ?? '?'} zombiesAlive=${clearEndA?.zombiesAlive ?? '?'} ` +
      `A=${clearEndA?.status ?? '?'}/${clearEndA?.hp ?? '?'}hp/${JSON.stringify(hunterA.stats())} ` +
      `B=${clearEndB?.status ?? '?'}/${clearEndB?.hp ?? '?'}hp/${JSON.stringify(hunterB.stats())}`,
  );
  await shot(A, 'outpost-wave-clear.png');
  // The hunt may have finished on the knife (see drawKnife) — everything
  // below assumes the issued sidearm.
  await A.evaluate(() => window.__outpost.switchWeapon('pistol'));
  await B.evaluate(() => window.__outpost.switchWeapon('pistol'));

  // -- intermission -> wave 2 (automatic, timed — no player action) --------------------
  const wave2 = await waitFor(async () => {
    const s = await opState(A);
    return s !== null && s.phase === 'wave' && s.wave === 2 ? s : null;
  }, 45000, "intermission auto-advances to phase 'wave' wave 2").catch(() => null);
  check(
    '9. wave clear -> intermission -> wave 2 (automatic after WAVES.intermissionSec)',
    wave1Cleared && wave2 !== null,
    wave2 !== null ? `wave now ${wave2.wave}` : 'never reached wave 2',
  );

  // Staging invulnerability from the wave-1 clear comes OFF here: the breach
  // run-in below supplies the threat for assertion 11, which is a survival
  // claim and has to be measured on a mortal survivor.
  await A.evaluate(() => window.__outpost.setInvulnerable(false));
  await B.evaluate(() => window.__outpost.setInvulnerable(false));

  // -- breach: force one open, then prove a zombie paths INSIDE through it ------------
  // Segment 12 (west side). breachSegment removes its collision entirely.
  // Station A 9 m INSIDE the compound from that wall (well past
  // INTERACT/DOWNED ranges, so proximity checks can't confound the result)
  // and spawn a fresh zombie at the EXTERNAL attack spot, 1.1 m outside. The
  // straight-line distance from A to the spawn point is ~10.1 m;
  // zombiesWithin(4) around A can only read >=1 once the zombie has actually
  // walked roughly 6+ m through the gap toward the nearest survivor — a real
  // position change, not a spawn-time coincidence.
  //
  // Run in the opening seconds of WAVE 2, because that "before === 0"
  // baseline is the whole assertion and it is only trustworthy while the
  // organic horde is still out on the 58 m spawn ring (a shambler needs
  // ~22 s just to reach the fence). Run late in a wave instead, as it used to
  // be, and the horde has already chewed its own way in: the reading was 2
  // before anything had been staged at all, and "a zombie is inside" then
  // proves nothing about THIS breach.
  //
  // Deliberately run with A still VULNERABLE — the melee-reach assertion
  // that follows needs a real hp reading, and the zombie let in here is what
  // supplies the threat for it.
  const breachSegId = 12;
  const brSeg = mapInfo.segments.find((s) => s.id === breachSegId);
  if (brSeg === undefined) throw new Error(`mapInfo has no segment ${breachSegId}`);
  const brNormal = brSeg.side === 'west' ? { nx: -1, nz: 0 } : brSeg.side === 'east' ? { nx: 1, nz: 0 } : brSeg.side === 'north' ? { nx: 0, nz: -1 } : { nx: 0, nz: 1 };
  const brExterior = { x: brSeg.cx + brNormal.nx * 1.1, z: brSeg.cz + brNormal.nz * 1.1 };
  const brInterior = { x: brSeg.cx - brNormal.nx * 9, z: brSeg.cz - brNormal.nz * 9 };
  await A.evaluate((seg) => window.__outpost.breachSegment(seg), breachSegId);
  const breachedOk = await waitFor(async () => {
    const t = await opTelemetry(A);
    return t?.segments?.[breachSegId]?.breached === true ? true : null;
  }, 5000, `segment ${breachSegId} reports breached`).catch(() => false);
  await A.evaluate((x, z) => window.__outpost.teleport(x, 0, z), brInterior.x, brInterior.z);
  await waitFor(async () => {
    const near = await A.evaluate((r) => window.__outpost.telemetry().zombiesWithin(r), 4);
    return near === 0 ? true : null;
  }, 10000, 'the 4 m bubble around A is empty before the breach run-in').catch(() => false);
  const zombiesWithinBefore = await A.evaluate((r) => window.__outpost.telemetry().zombiesWithin(r), 4);
  await A.evaluate((k, x, z) => window.__outpost.spawnAt(k, x, z), 'runner', brExterior.x, brExterior.z);
  const pathedIn = await waitFor(async () => {
    const near = await A.evaluate((r) => window.__outpost.telemetry().zombiesWithin(r), 4);
    return near >= 1 ? near : null;
  }, 20000, 'a zombie paths from the breach to within 4m of an interior survivor').catch(() => null);
  check(
    '10. a breach opens (breachSegment) and a zombie paths INSIDE the compound through it',
    breachedOk === true && zombiesWithinBefore === 0 && pathedIn !== null,
    `breached=${breachedOk} zombiesWithin(4) before=${zombiesWithinBefore} after=${pathedIn ?? 'timeout'}`,
  );

  // -- the tower deck is safe from MELEE, with zombies underneath it ------------------
  // REGRESSION. Melee reach was a ground-plane `hypot(dx, dz)` test with no
  // Y term at all, so a zombie standing in the mud at the tower footing was
  // "in reach" of a survivor 8 m above it on the spawn deck: a survivor
  // parked at DECK2_Y went 100 -> 76 -> 40 -> dead in six seconds flat, and
  // both survivors died mid-run every time. config.ts states the opposite
  // ("spitters break turtling on the top deck" — wave 1 has no spitters).
  //
  // Staged with the zombie(s) that just came through the breach: pull them
  // to the tower by standing at the base, then step up onto the deck and
  // hold, with invulnerability OFF, while they crowd the footing below.
  await A.evaluate((y) => window.__outpost.teleport(0, y, 6.0), mapInfo.footingH); // ground floor, on the footing
  // telemetry() crosses the CDP boundary as plain JSON, so zombiesWithin has
  // to be CALLED in the page — a serialised copy has no methods.
  const nearA = (r) => A.evaluate((rr) => window.__outpost.telemetry().zombiesWithin(rr), r);
  const lured = await waitFor(async () => ((await nearA(4)) >= 1 ? true : null), 25000, 'a zombie follows A to the tower footing').catch(() => false);
  await A.evaluate((y) => window.__outpost.teleport(0, y, 0), deck2Y);
  await sleep(600);
  const deckHp0 = (await opTelemetry(A))?.hp ?? 0;
  let deckMinHp = deckHp0;
  let deckNear = 0;
  const deckT0 = Date.now();
  while (Date.now() - deckT0 < 8000) {
    const t = await opTelemetry(A);
    if (t !== null) deckMinHp = Math.min(deckMinHp, t.hp);
    deckNear = Math.max(deckNear, await nearA(9));
    await sleep(300);
  }
  check(
    '11. the tower deck is out of MELEE reach: a survivor holds DECK2_Y for 8 s, unharmed, with zombies at the footing below',
    lured === true && deckNear >= 1 && deckMinHp === deckHp0 && deckHp0 > 0,
    `zombies within 9 m (horizontally) of the deck=${deckNear}; A hp ${deckHp0} -> ${deckMinHp}`,
  );

  // -- everything below is STAGED, so A is made invulnerable -------------------------
  // The remaining scenarios park A in the open mud, inside the compound,
  // beside deliberately-spawned zombies for a minute or more. None of them
  // asserts anything about whether A survives, and a staging death derails
  // every assertion after it. The harness already assumed this affordance
  // existed: the squad-wipe section further down opens by turning
  // invulnerability OFF. Nothing above this line is staged that way — the
  // wave-1 clear and the melee-reach assertion are both survival claims and
  // both ran with A and B fully mortal.
  await A.evaluate(() => window.__outpost.setInvulnerable(true));

  // -- staged combat: A shoots debug-spawned zombies dead; scrap increases -------------
  // Teleport A to open mud well clear of the tower footing box (|x|,|z| > 7),
  // spawn a shambler 5 m due north, face it (yaw 0 = -Z = north) and fire the
  // issued pistol (25 dmg, shambler 90 hp at wave 1 -> ~4 shots) until it dies.
  // A shot counter tracks the 12-round mag across kills and reloads proactively
  // — telemetry() carries no mag/reserve field, so a fixed-cadence reload is
  // the only way to avoid silently dry-firing partway through the farm below.
  await A.evaluate(() => window.__outpost.teleport(10, 0, 15));
  await A.evaluate(() => window.__outpost.setLook(0, 0));
  let shotsSinceReload = 0;
  const fireOnceTracked = async (page = A) => {
    if (shotsSinceReload >= 11) {
      await page.evaluate(() => window.__outpost.reload());
      await sleep(2100);
      shotsSinceReload = 0;
    }
    await page.evaluate(() => window.__outpost.fireOnce());
    shotsSinceReload++;
  };
  // A kill is a STRICT DECREASE in zombiesAlive, measured against the highest
  // reading seen so far in this attempt — not against the count taken before
  // the spawn. Wave 1 is dripping in ~3.4 zombies/second the whole time this
  // runs, and the drip only ever ADDS; nothing but a death removes one. The
  // old "zombiesAlive <= before" test was unsatisfiable while the drip
  // outran the killing (it reported before=4 after=11 on a run where scrap
  // proves six zombies died), and worse, it reported a FALSE kill the moment
  // the drip hit HORDE.maxAlive and spawnAt stopped adding anything at all.
  const spawnAndKill = async (x, z) => {
    let peak = (await opTelemetry(A))?.zombiesAlive ?? 0;
    await A.evaluate((k, xx, zz) => window.__outpost.spawnAt(k, xx, zz), 'shambler', x, z);
    for (let i = 0; i < 12; i++) {
      await fireOnceTracked();
      await sleep(220);
      const t = await opTelemetry(A);
      if (t === null) continue;
      if (t.zombiesAlive < peak) return true;
      peak = Math.max(peak, t.zombiesAlive);
    }
    return false;
  };
  const scrapBefore = await waitFor(async () => {
    const t = await opTelemetry(A);
    return t !== null ? t : null;
  }, 5000, "A's telemetry readable after teleport");
  const zombiesBeforeKill = (await opTelemetry(A))?.zombiesAlive ?? 0;
  const killed = await spawnAndKill(10, 10);
  const scrapAfter = await opTelemetry(A);
  check(
    '12. a shot kills a zombie (debug-staged: spawnAt + fireOnce, telemetry().zombiesAlive drops)',
    killed,
    `zombiesAlive before=${zombiesBeforeKill} after=${scrapAfter?.zombiesAlive ?? '?'}`,
  );
  check(
    '13. scrap increases on a kill',
    scrapAfter !== null && scrapAfter.scrap > (scrapBefore?.scrap ?? 0),
    `scrap before=${scrapBefore?.scrap ?? '?'} after=${scrapAfter?.scrap ?? '?'}`,
  );
  // Bank a FEW extra kills (killScrap.shambler=12/kill) against
  // ECONOMY.repairScrapPerHp (0.35/hp) so the repair hold below (~6s @
  // repairHpPerSec 26 = ~156 hp attempted = ~55 scrap) isn't denied mid-hold
  // for insufficient funds — `repairSegment` returns 0 (silently) once
  // unaffordable, which would read as "repair doesn't work" when the real
  // cause is an empty wallet. Capped at 7 total kills (~28 rounds of A's
  // 60-round pool, mag 12 + reserve 48): the wave-1 sweep-clear below still
  // needs A's remaining ammo, and there is no ammo-crate visit in this plan
  // (that requires leaving the melee-safe tower — see that section).
  let farmedKills = killed ? 1 : 0;
  for (let i = 0; i < 6 && farmedKills < 7; i++) {
    if (await spawnAndKill(10, 10)) farmedKills++;
  }
  console.log(`scrap farm: ${farmedKills} kills banked, scrap now ${(await opTelemetry(A))?.scrap ?? '?'}`);

  // -- fence segment: damage from the horde, then repaired back up --------------------
  // Segment 5 (east side) — clear of the west segment breached above.
  // Spawn a shambler at its EXTERNAL attack spot
  // (segmentAttackSpot: 1.1 m outward along the wall normal) and let the real
  // stepHorde AI chew the fence (continuous fenceDps). Once damage is
  // observed, teleport A to the INTERIOR side (2 m inward, within
  // INTERACT.repairRange 2.6) and hold `interact` — repairHpPerSec (26) beats
  // one shambler's fenceDps (22), so hp should net-climb despite the zombie
  // still chewing.
  const repairSegId = 5;
  const repSeg = mapInfo.segments.find((s) => s.id === repairSegId);
  if (repSeg === undefined) throw new Error(`mapInfo has no segment ${repairSegId}`);
  const repNormal = (() => {
    // SegmentGeom isn't on OutpostMapInfo (only cx/cz/side/gate) — recover the
    // outward normal from `side`, exactly as map.ts's buildSegments() assigns it.
    switch (repSeg.side) {
      case 'north': return { nx: 0, nz: -1 };
      case 'south': return { nx: 0, nz: 1 };
      case 'east': return { nx: 1, nz: 0 };
      case 'west': return { nx: -1, nz: 0 };
      default: return { nx: 0, nz: -1 };
    }
  })();
  const attackSpot = { x: repSeg.cx + repNormal.nx * 1.1, z: repSeg.cz + repNormal.nz * 1.1 };
  const interiorSpot = { x: repSeg.cx - repNormal.nx * 2, z: repSeg.cz - repNormal.nz * 2 };
  await A.evaluate((k, x, z) => window.__outpost.spawnAt(k, x, z), 'shambler', attackSpot.x, attackSpot.z);
  const segDamaged = await waitFor(async () => {
    const t = await opTelemetry(A);
    const seg = t?.segments?.[repairSegId];
    return seg !== undefined && seg.hp < 0.97 ? seg : null;
  }, 15000, `segment ${repairSegId} takes damage from the horde`).catch(() => null);
  check(
    '14. a fence segment takes continuous damage from a real attacking zombie (telemetry().segments[].hp)',
    segDamaged !== null,
    segDamaged !== null ? `hp=${segDamaged.hp.toFixed(3)}` : 'no damage observed within 15s',
  );
  const hpAtRepairStart = (await opTelemetry(A))?.segments?.[repairSegId]?.hp ?? null;
  const repairYaw = yawTo(interiorSpot.x, interiorSpot.z, repSeg.cx, repSeg.cz);
  await A.evaluate(
    (x, z, yaw) => {
      window.__outpost.teleport(x, 0, z);
      window.__outpost.setLook(yaw, 0);
    },
    interiorSpot.x, interiorSpot.z, repairYaw,
  );
  await A.evaluate(() => window.__outpost.press('interact', true));
  let repairProgressSeen = false;
  const repairT0 = Date.now();
  while (Date.now() - repairT0 < 6000) {
    const t = await opTelemetry(A);
    if (t !== null && t.interactProgress > 0) repairProgressSeen = true;
    await sleep(300);
  }
  await A.evaluate(() => window.__outpost.press('interact', false));
  const hpAfterRepair = (await opTelemetry(A))?.segments?.[repairSegId]?.hp ?? null;
  check(
    '15. that segment is repaired back up (interactProgress > 0 while holding interact in range; hp rises net of ongoing damage)',
    repairProgressSeen && hpAfterRepair !== null && hpAtRepairStart !== null && hpAfterRepair > hpAtRepairStart,
    `interactProgress seen=${repairProgressSeen}; hp ${hpAtRepairStart?.toFixed(3)} -> ${hpAfterRepair?.toFixed(3)}`,
  );

  // -- two clients: one is downed, the other revives them ------------------------------
  // This is the single co-op verb that justifies having no bot survivors —
  // staged with hurtSelf (server-authoritative HP) rather than waiting on
  // emergent horde damage. B goes down; A walks into DOWNED.range (2.2 m) and
  // holds `interact` for DOWNED.holdSec (4 s) uninterrupted.
  await B.evaluate(() => window.__outpost.teleport(-30, 0, -30)); // clear of any live horde AI
  await B.evaluate(() => window.__outpost.hurtSelf(500));
  const bDowned = await waitFor(async () => {
    const t = await opTelemetry(B);
    return t !== null && t.status === 'downed' ? true : null;
  }, 5000, "B's hurtSelf brings them to 'downed'");
  check('16. hurtSelf brings a survivor to downed status', bDowned === true, `B status=downed`);

  const bPos = (await opTelemetry(B))?.pos ?? [-30, 0, -30];
  const reviveApproach = { x: bPos[0] + 1.0, z: bPos[2] };
  const reviveYaw = yawTo(reviveApproach.x, reviveApproach.z, bPos[0], bPos[2]);
  await A.evaluate(
    (x, z, yaw) => {
      window.__outpost.teleport(x, 0, z);
      window.__outpost.setLook(yaw, 0);
    },
    reviveApproach.x, reviveApproach.z, reviveYaw,
  );
  await A.evaluate(() => window.__outpost.press('interact', true));
  let reviveProgressSeen = false;
  const reviveT0 = Date.now();
  let bRevived = false;
  while (Date.now() - reviveT0 < 9000) {
    const [ta, tb] = await Promise.all([opTelemetry(A), opTelemetry(B)]);
    if (ta !== null && ta.interactProgress > 0) reviveProgressSeen = true;
    if (tb !== null && tb.status === 'alive') {
      bRevived = true;
      break;
    }
    await sleep(200);
  }
  await A.evaluate(() => window.__outpost.press('interact', false));
  check(
    '17. two clients: A revives downed B (A holds interact in DOWNED.range; B returns to alive)',
    reviveProgressSeen && bRevived,
    `A interactProgress seen=${reviveProgressSeen}; B revived=${bRevived}`,
  );
  await shot(A, 'outpost-revive.png');

  // -- perf under live load: HORDE.maxAlive zombies, draw calls + frame time -----------
  // Per CONTRACT.md/config.ts PERF: MUST measure with HORDE.maxAlive (48)
  // zombies alive, staged via spawnAt — not whatever the two test clients
  // happened to leave alive above, which measures nothing. Sampled from the
  // tower deck (safe), where both survivors still are after the sweep.
  const HORDE_MAX_ALIVE = 48;
  const PERF_MAX_DRAW_CALLS = 420;
  const PERF_MAX_FRAME_MS = 33;
  for (let i = 0; i < HORDE_MAX_ALIVE + 8; i++) {
    const angle = (i / (HORDE_MAX_ALIVE + 8)) * Math.PI * 2;
    const r = 26 + (i % 3) * 6;
    const x = Math.sin(angle) * r;
    const z = Math.cos(angle) * r;
    const kind = i % 5 === 0 ? 'runner' : 'shambler';
    await A.evaluate((k, xx, zz) => window.__outpost.spawnAt(k, xx, zz), kind, x, z);
    const alive = (await opTelemetry(A))?.zombiesAlive ?? 0;
    if (alive >= HORDE_MAX_ALIVE) break;
  }
  const loadedAlive = await waitFor(async () => {
    const t = await opTelemetry(A);
    return t !== null && t.zombiesAlive >= HORDE_MAX_ALIVE - 4 ? t.zombiesAlive : null;
  }, 15000, `zombiesAlive reaches near HORDE.maxAlive (${HORDE_MAX_ALIVE})`).catch(async () => (await opTelemetry(A))?.zombiesAlive ?? 0);
  // A frame that drew the WORLD, not a run-end screen. `drawCalls` is only a
  // budget check if the sample came from a live gameplay frame — a run that
  // has already ended draws a couple of quads and would "pass" 420 for the
  // rest of time. PERF's own arithmetic budgets ~400 calls for this scene, so
  // any live frame is far above this floor; it exists purely to make an
  // empty frame fail loudly instead of quietly passing.
  const PERF_MIN_DRAW_CALLS = 20;
  let maxDrawCalls = 0;
  let maxFrameMs = 0;
  let perfSamples = 0;
  for (let i = 0; i < 8; i++) {
    const [sa, ta, tb] = await Promise.all([opState(A), opTelemetry(A), opTelemetry(B)]);
    if (sa === null || sa.phase === 'ended' || sa.phase === 'lobby') {
      await sleep(400);
      continue;
    }
    for (const t of [ta, tb]) {
      if (t === null) continue;
      if (typeof t.drawCalls === 'number') maxDrawCalls = Math.max(maxDrawCalls, t.drawCalls);
      if (typeof t.frameMs === 'number') maxFrameMs = Math.max(maxFrameMs, t.frameMs);
    }
    perfSamples++;
    await sleep(400);
  }
  check(
    `18. draw calls <= PERF.maxDrawCalls (${PERF_MAX_DRAW_CALLS}) measured live with ~${HORDE_MAX_ALIVE} zombies alive`,
    perfSamples > 0 && maxDrawCalls >= PERF_MIN_DRAW_CALLS && maxDrawCalls <= PERF_MAX_DRAW_CALLS,
    `zombiesAlive=${loadedAlive} live samples=${perfSamples} max sampled drawCalls=${maxDrawCalls}` +
      (maxDrawCalls < PERF_MIN_DRAW_CALLS ? ` (below the ${PERF_MIN_DRAW_CALLS} floor — the world was not being drawn)` : ''),
  );
  check(
    `19. frame time <= PERF.maxFrameMsUnderLoad (${PERF_MAX_FRAME_MS}ms) measured live with ~${HORDE_MAX_ALIVE} zombies alive`,
    perfSamples > 0 && maxFrameMs > 0 && maxFrameMs <= PERF_MAX_FRAME_MS,
    `max sampled frameMs=${maxFrameMs.toFixed(1)} on ${softwareGl ? 'SOFTWARE GL (swiftshader) — not a perf verdict' : 'hardware GL'}`,
  );
  await shot(A, 'outpost-horde-load.png');

  // -- squad wipe: both survivors dead, run ends with stats ----------------------------
  await A.evaluate(() => window.__outpost.setInvulnerable(false));
  await B.evaluate(() => window.__outpost.setInvulnerable(false));
  for (const page of [A, B]) {
    // alive -> downed -> dead: two lethal hits, since a downed survivor still
    // needs a second below-zero hit (or a full bleedout) to actually die.
    await page.evaluate(() => window.__outpost.hurtSelf(1000));
    await sleep(150);
    await page.evaluate(() => window.__outpost.hurtSelf(1000));
  }
  const ended = await waitFor(async () => {
    const s = await opState(A);
    return s !== null && s.phase === 'ended' ? s : null;
  }, 15000, "phase reaches 'ended' after squad wipe").catch(() => null);
  const endedText = ended !== null ? await A.evaluate(() => (document.body?.innerText ?? '').trim()) : '';
  check(
    '20. squad wipe ends the run with stats (phase -> \'ended\', a non-trivial run-end screen is shown)',
    ended !== null && endedText.length > 20,
    ended !== null ? `phase=ended, run-end text length=${endedText.length}` : 'never reached ended',
  );
  await shot(A, 'outpost-run-end.png');

  // -- screenshot evidence: non-trivial files, not blanks -------------------------------
  const SHOTS = ['outpost-revive.png', 'outpost-horde-load.png', 'outpost-wave-clear.png', 'outpost-run-end.png'];
  const shotSizes = SHOTS.map((n) => {
    try {
      return { n, size: statSync(path.join(SHOTS_DIR, n)).size };
    } catch {
      return { n, size: 0 };
    }
  });
  const shotsOk = shotSizes.every((s) => s.size > 30 * 1024);
  check(
    '21. screenshots captured and non-trivial (>30KB each — not blank frames)',
    shotsOk,
    shotSizes.map((s) => `${s.n}=${(s.size / 1024).toFixed(0)}KB`).join(' '),
  );

  // -- error surface --------------------------------------------------------------------------
  check('22. zero console/page/network errors on all pages', pageErrors.length === 0, `${pageErrors.length}`);
}

// ---- runner ---------------------------------------------------------------------------
let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error(`\nE2E-OUTPOST ABORTED: ${err instanceof Error ? err.message : String(err)}`);
  check('e2e-outpost completed without abort', false);
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  if (serverChild && serverChild.exitCode === null) {
    serverChild.kill('SIGTERM');
    await sleep(400);
    if (serverChild.exitCode === null) serverChild.kill('SIGKILL');
  }

  console.log('\n================ E2E-OUTPOST SUMMARY ================');
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
  console.log(exitCode === 0 ? '\nE2E-OUTPOST GREEN' : `\nE2E-OUTPOST RED (${failed} failed assertions, ${pageErrors.length} page errors)`);
  process.exit(exitCode);
}

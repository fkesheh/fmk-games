#!/usr/bin/env node
// ============================================================================
// verify-rift — T14 VISUAL + PERF VERIFICATION for ANCIENTS (rift).
//
// Serves the BUILT platform on RIFT_VERIFY_PORT (default 8092; 8091 and 8080
// belong to siblings — never touch them), drives the frozen window.__rift
// debug surface (CONTRACT §6 + the additive drawCalls() in client/src/game.ts)
// with puppeteer, captures the shot list for the art/UX judge loops, and
// asserts the perf + health budgets. Client dist must already exist — this
// harness NEVER rebuilds (run `npm run build` first).
//
// SHOT LIST (each at 1280x720, 1920x1080 and 2560x1080 — 16:9 pair + one 21:9):
//   menu, lobby (hero pick grid), live-hud (default zoom), live-close (closest
//   zoom, camH 18), shop (panel open), scoreboard (TAB held), combat (creep
//   engagement at mid lane), fog-edge (shroud boundary at an unexplored map
//   corner). Saved under screenshots/rift/ (artifacts — never committed).
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
//   - WebGL context actually created and NO .error-banner in the DOM;
//   - HUD roots exist during live: .hud .ability-bar .item-bar .topbar
//     .minimap .killfeed;
//   - drawCalls() in (0, 400] sampled during live combat (CONTRACT §10 budget;
//     > 0 proves the debug surface measures real frames, not a dead renderer);
//   - the countdown readout, the death overlay, the ended phase and the
//     disconnect banner each actually APPEARED (not just a screenshot taken
//     around them), and the banner hid again after the server came back.
//
// The LAST stdout line is a JSON manifest: one entry per shot {shot, viewport,
// file, bytes, drawCalls, pageErrors} plus a summary — the judge loops pair
// every shot with its numbers from there. Server chatter goes to stderr.
//
// Flags: --keep-server (leave the platform server up for debugging).
// ============================================================================
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

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

const ROOM_SETTINGS = { teamSize: 2, speed: 5 }; // 1 lane, side 96, 5x game speed
const MAP_SIDE = 96; // MAP_SIDE_BASE at 1 lane (teamSize 2 -> LANES_FOR_TEAM_SIZE[2] = 1)
const MID = MAP_SIDE / 2; // mid-lane clash point (48, 48)
const HERO_PICK = 'reaver';
const DRAW_CALL_BUDGET = 400; // CONTRACT §10
const DRAW_SAMPLES = 5;
const DRAW_SAMPLE_MS = 300;
const MIN_PNG_BYTES = 5000;
const COMBAT_MIN_TICK = 1200; // 60s game-time at 20Hz — waves have clashed at mid
const ZOOM_STEPS_IN = 10; // 36m -> 18m clamp (1/1.12 per step)
const ZOOM_STEPS_OUT = 6; // back to ≈ default 36m

// ---- overlay state captures (1920x1080 only) -------------------------------------
const OVERLAY_VIEWPORT = { width: 1920, height: 1080, tag: '1920x1080' };
const OVERLAY_SHOTS = ['countdown', 'death', 'end', 'disconnect'];
// speed 2: a match lasts 6+ wall-minutes (the disconnect capture needs the
// room still live) and the level-1 respawn (6.5 game-s) is ~3.2s of wall
// clock — long enough to detect + screenshot the death overlay.
const OVERLAY_ROOM_SETTINGS = { teamSize: 2, speed: 2 };
// speed 20 (the e2e hook, CONTRACT §2): a match resolves in ~1-4 min wall.
const END_ROOM_SETTINGS = { teamSize: 2, speed: 20 };
const ANCIENT_T0 = 11; // team-0 ancient (11,11) — mirrored map fact
const ANCIENT_T1 = MAP_SIDE - ANCIENT_T0; // team-1 ancient (85,85)
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

const T0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const elapsed = () => `${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s`;
const log = (msg) => console.error(`[${elapsed()}] ${msg}`); // stdout ends with the JSON manifest
const errText = (err) => (err instanceof Error ? err.message : String(err));
const fail = (msg) => {
  failures.push(msg);
  log(`[FAILED] ${msg}`);
};

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
    if (!tearingDown) {
      process.stderr.write(
        `[server] EXITED mid-run (code ${code}, signal ${signal}) — every page just lost its socket.\n`,
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

async function launchOne(vp, tag) {
  let browser = await puppeteer.launch(LAUNCH_OPTS);
  browsers.push(browser);
  let page = await browser.newPage();
  await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
  const gl = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
  if (!gl) {
    log(`[${tag}] no hardware webgl2 — relaunching on swiftshader`);
    await browser.close();
    browsers.pop();
    browser = await puppeteer.launch({
      ...LAUNCH_OPTS,
      args: [...LAUNCH_ARGS, '--use-gl=angle', '--use-angle=swiftshader'],
    });
    browsers.push(browser);
    page = await browser.newPage();
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
    const gl2 = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
    if (!gl2) throw new Error(`[${tag}] webgl2 unavailable even on swiftshader`);
  }
  trackErrors(page, tag);
  page.__browser = browser;
  return page;
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

async function shot(page, name, vp) {
  const file = path.join(OUT_DIR, `${name}-${vp.tag}.png`);
  const t0 = Date.now();
  try {
    await page.screenshot({ path: file, timeout: 30000 });
  } catch (err) {
    log(`[warn] ${name}-${vp.tag}: capture failed (${errText(err)}) — one retry`);
    await page.screenshot({ path: file, timeout: 90000 });
  }
  const bytes = statSync(file).size;
  if (bytes < MIN_PNG_BYTES) {
    throw new Error(`shot '${name}-${vp.tag}' is only ${bytes} bytes — the frame did not render`);
  }
  const dc = await drawCalls(page);
  manifest.push({
    shot: name,
    viewport: vp.tag,
    file: path.relative(ROOT, file),
    bytes,
    drawCalls: dc,
    pageErrors: pageErrors.length,
  });
  log(`shot  ${name}-${vp.tag} (${(bytes / 1024).toFixed(0)}kB, ${((Date.now() - t0) / 1000).toFixed(1)}s, ${dc} draw calls)`);
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

/** Wheel-zoom `steps` notches; dir -1 zooms in (lower camH), +1 out. */
async function zoom(page, vp, steps, dir) {
  await page.mouse.move(vp.width / 2, vp.height / 2);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel({ deltaY: dir > 0 ? 240 : -240 });
    await sleep(70);
  }
}

// ---- the per-viewport flow ---------------------------------------------------------
async function captureViewport(vp) {
  const tag = vp.tag;
  const page = await launchOne(vp, tag);
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
    await settle(page, { ms: 600 });
    await shot(page, 'live-hud', vp);

    // -- HUD roots (CONTRACT §6 DOM class contract) ---------------------------------------
    const missingRoots = await page.evaluate(() => {
      const want = ['.hud', '.ability-bar', '.item-bar', '.topbar', '.minimap', '.killfeed'];
      return want.filter((sel) => document.querySelector(sel) === null);
    });
    if (missingRoots.length > 0) fail(`${tag}: HUD roots missing during live: ${missingRoots.join(', ')}`);

    // -- live at closest zoom (camH 18) ---------------------------------------------------
    await zoom(page, vp, ZOOM_STEPS_IN, -1);
    await settle(page);
    await shot(page, 'live-close', vp);
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
    await shot(page, 'shop', vp);
    await page.evaluate(() => document.querySelector('.gold-readout')?.click());

    // -- scoreboard (TAB held) --------------------------------------------------------------
    await page.keyboard.down('Tab');
    await settle(page, { ms: 250 });
    await shot(page, 'scoreboard', vp);
    await page.keyboard.up('Tab');

    // -- combat moment: waves clash at mid; pan there and measure draw calls ------------------
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
    await minimapPan(page, 0.5, 0.5); // mid lane clash point (48, 48)
    await settle(page, { ms: 800 }); // interp + the 5Hz fog mask refresh
    let maxDrawCalls = -1;
    for (let i = 0; i < DRAW_SAMPLES; i++) {
      const dc = await drawCalls(page);
      if (dc > maxDrawCalls) maxDrawCalls = dc;
      await sleep(DRAW_SAMPLE_MS);
    }
    log(`${tag}: draw calls during live combat — max ${maxDrawCalls} of ${DRAW_SAMPLES} samples (budget ${DRAW_CALL_BUDGET})`);
    if (maxDrawCalls <= 0) {
      fail(`${tag}: drawCalls() returned ${maxDrawCalls} during live combat — the renderer is not drawing (or the debug surface is dead)`);
    } else if (maxDrawCalls > DRAW_CALL_BUDGET) {
      fail(`${tag}: drawCalls() ${maxDrawCalls} exceeds the ${DRAW_CALL_BUDGET} budget during live combat`);
    }
    await shot(page, 'combat', vp);

    // -- fog boundary at the map edge ---------------------------------------------------------
    // (u 0.97, v 0.03) -> world (93, 3): an off-lane corner team 0 never
    // explores — the frame shows the shroud meeting the explored lane corridor.
    await minimapPan(page, 0.97, 0.03);
    await settle(page, { ms: 800 });
    await shot(page, 'fog-edge', vp);

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
    const enemyAncient = live.team === 0 ? ANCIENT_T1 : ANCIENT_T0;
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
    serverChild.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => serverChild.once('exit', r)),
      sleep(5000).then(() => serverChild.kill('SIGKILL')),
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
await mkdir(OUT_DIR, { recursive: true });
try {
  await startServer();
  await waitForServer();
  await assertProductionMount();
  log(`platform server up on :${PORT} (built mount verified)`);
  for (const vp of VIEWPORTS) {
    await captureViewport(vp);
  }
  await captureOverlayStates(OVERLAY_VIEWPORT);
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
const expected = VIEWPORTS.length * SHOT_NAMES.length + OVERLAY_SHOTS.length;
if (manifest.length < expected) {
  const got = new Set(manifest.map((m) => `${m.shot}-${m.viewport}`));
  const missing = VIEWPORTS.flatMap((vp) => SHOT_NAMES.filter((n) => !got.has(`${n}-${vp.tag}`)).map((n) => `${n}-${vp.tag}`));
  for (const n of OVERLAY_SHOTS) {
    if (!got.has(`${n}-${OVERLAY_VIEWPORT.tag}`)) missing.push(`${n}-${OVERLAY_VIEWPORT.tag}`);
  }
  fail(`missing ${expected - manifest.length} shot(s): ${missing.join(', ')}`);
}
if (pageErrors.length > 0) {
  fail(`${pageErrors.length} page error(s):\n  ${pageErrors.slice(0, 12).join('\n  ')}`);
}

const worstDrawCalls = Math.max(0, ...manifest.map((m) => m.drawCalls));
log(
  failures.length === 0
    ? `GREEN: ${manifest.length}/${expected} shots, worst draw calls ${worstDrawCalls}/${DRAW_CALL_BUDGET}, zero page errors`
    : `RED: ${failures.length} failure(s), ${manifest.length}/${expected} shots`,
);
console.log(JSON.stringify({ ok: failures.length === 0, worstDrawCalls, failures, shots: manifest }));
process.exit(failures.length === 0 ? 0 : 1);

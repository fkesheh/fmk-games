#!/usr/bin/env node
// ============================================================================
// e2e — prove STRICKEN runs end-to-end in a real (headless) browser.
//
// Builds the monorepo first (SKIPPED when E2E_SKIP_BUILD=1, so an orchestrator
// that just built can reuse the warm dist), spawns the production server
// (server/dist), drives TWO browser instances (separate processes: no
// cross-tab rAF throttling) through the frozen window.__fps surface:
// private-room create/join, the MANUAL-START lobby (warmup NEVER auto-starts —
// the room sits in warmup until a SEATED player presses START; the harness
// clicks the HUD's own button.fh-start-btn, the real player path, and asserts
// the room does not start on its own), phase machine
// warmup->freeze->live, movement, combat (aim math + semi-auto fire edges),
// buy flow, state-surface shape, a 6-map screenshot tour, public-room create
// (code === null), debug scoreboard toggle, jump-apex height, crouch travel
// speed (server sim honors the crouch bit), server-side bot add/remove with
// a 6s combat soak, team switching (immediate in warmup / queued to the
// next freeze otherwise; team_full balance guard), the solo bot prompt
// (visible when alone; 'ADD 3 BOTS' adds 3 players and hides it; absent when
// joining a room that already has players), spectate visual sanity (chip
// reads 'SPECTATING'; no >40% viewport near-opaque black overlay), shift-walk
// travel speed (server sim honors the walk bit via debug.press('walk')), Q
// quick-switch (buy smg -> Digit2 pistol -> KeyQ back to smg, on a third
// shell page with the pointer-lock observable stubbed — real lock is denied
// headless), and the developer console (debug.console('addbot 2') adds 2
// players; an unknown command returns an error string), the kevlar gear buy
// (console 'buy kevlar' in a freeze/buy window sets armor to 100), and
// killbots (console 'killbots' kills every bot in place — roster deaths
// increment, player count unchanged, bots revive at full hp).
//
// MANUAL START (frozen lobby contract): warmup has no timer and no headcount
// trigger — `{t:'start'}` from a seated player is the ONLY way out of it
// (server game.ts advancePhase case 'warmup'). So every step that needs a
// phase past warmup — the first live wait, the (18) team_full guard, the (22)
// spectate soak, the (24) buy/quick-switch round, the (26) kevlar freeze —
// presses START first via startMatchOn(), and re-presses whenever the room
// falls back to warmup (matchEnd -> fullReset, or a low-population abort).
// The dedicated assertion 'warmup does not auto-start' seats 2 players and
// holds for 7s BEFORE any press, proving the phase never leaves warmup and
// that the START control is on screen while it waits.
//
// Exit 0 only if every assertion passes AND zero page/console/network errors
// were seen on either page (benign favicon noise excluded).
// ============================================================================
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 8181, not 8080: a dev server on the conventional port must never be able to
// answer this harness's probes (the env override stays for CI).
const PORT = Number(process.env.E2E_PORT ?? 8181);
const BASE = `http://localhost:${PORT}`;
const GAME_URL = `${BASE}/fps/`; // the launcher lives at /; the fps client is mounted at /fps/
const SHOTS_DIR = path.join(ROOT, 'screenshots');
const MAP_IDS = ['dustbowl', 'crossfire', 'office', 'frostbite', 'urbana', 'bunker'];

const STATE_FIELDS = [
  'phase', 'roomId', 'code', 'mapId', 'team', 'hp', 'armor', 'alive', 'pos', 'players',
  'rosterSize', 'ping', 'money', 'mag', 'reserve', 'round', 'scoreT', 'scoreCT', 'weapon',
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

const fpsState = (page) => page.evaluate(() => window.__fps?.state() ?? null);

// (20)/(21) bot-prompt probes: the prompt's concrete selector is owned by the
// menus module; the frozen observable here is its 'ADD 3 BOTS' button.
// Visible = non-zero rect (a display:none ancestor zeroes it) and no
// display:none/visibility:hidden link up the ancestor chain.
function botPromptVisible(page) {
  return page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').toUpperCase().includes('ADD 3 BOTS'),
    );
    if (btn === undefined) return false;
    const r = btn.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    for (let el = btn.parentElement; el !== null; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    return true;
  });
}

function clickBotPrompt(page) {
  return page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').toUpperCase().includes('ADD 3 BOTS'),
    );
    if (btn === undefined) return false;
    btn.click();
    return true;
  });
}

// ---- start control (the manual-start lobby) ------------------------------------
// The frozen observable is the HUD's own button.fh-start-btn (hud.ts): it is
// the single pointer-events:auto node in the HUD layer, it lives in the warmup
// lobby panel only, and its `disabled` flag mirrors the SERVER's canStart
// verbatim — so a press is only legal when the button says it is. Reading it
// (not __fps, which exposes no start()/canStart) keeps the harness on exactly
// the path a player walks.
const START_SEL = '.fh-start-btn';

/** { present, visible, disabled, label } for the warmup START control. */
function startBtnState(page) {
  return page.evaluate((sel) => {
    const b = document.querySelector(sel);
    if (b === null) return { present: false, visible: false, disabled: true, label: '' };
    const r = b.getBoundingClientRect();
    let visible = r.width > 0 && r.height > 0;
    for (let el = b; visible && el !== null; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') visible = false;
    }
    return { present: true, visible, disabled: b.disabled === true, label: b.textContent ?? '' };
  }, START_SEL);
}

/**
 * One real DOM click on an ENABLED START button — the same handler a player
 * fires (hud.ts click listener -> clientGame.startMatch -> {t:'start'}).
 * page.click() is unreliable here (the HUD layer is pointer-events:none except
 * for this node, and pointer lock can own the cursor), so the sanctioned form
 * is the in-page click. Returns true only when a click was actually issued.
 */
function clickStart(page) {
  return page.evaluate((sel) => {
    const b = document.querySelector(sel);
    if (b && !b.disabled) {
      b.click();
      return true;
    }
    return false;
  }, START_SEL);
}

/**
 * Take `page`'s room out of the lobby: wait for the server to enable START
 * (canStart = warmup && seated >= MIN_PLAYERS_FOR_MATCH — bots count as seats),
 * click it, and confirm the phase actually left warmup. The press is re-issued
 * every ~1.5s while the phase is still warmup: a click landing in the same
 * instant the snapshot flips canStart is otherwise simply dropped by the
 * server (illegal presses are ignored in silence, never an error).
 */
async function startMatchOn(page, label, timeoutMs = 30000) {
  const t0 = Date.now();
  await waitFor(
    async () => ((await startBtnState(page)).disabled ? null : true),
    timeoutMs,
    `START button enabled (${label})`,
  );
  let presses = 0;
  let keys = 0;
  if (await clickStart(page)) presses++;
  let lastPress = Date.now();
  const phase = await waitFor(async () => {
    const s = await fpsState(page);
    if (s !== null && s.roomId !== null && s.phase !== 'warmup') return s.phase;
    if (Date.now() - lastPress > 1500) {
      lastPress = Date.now();
      if (await clickStart(page)) presses++;
      // after a few unanswered clicks, also take the OTHER real player path:
      // Enter on window (clientGame.onKeyDown, armed only with no menu/buy/
      // console open and no text field focused — a no-op otherwise, and
      // HTMLElement.click() never moves focus, so the shortcut stays armed)
      if (presses >= 3 && keys < 3) {
        keys++;
        await page.keyboard.press('Enter').catch(() => {});
      }
    }
    return null;
  }, timeoutMs, `phase leaves warmup after START (${label})`);
  console.log(
    `start ${label}: warmup -> ${phase} after ${presses} press(es)` +
      `${keys > 0 ? ` + ${keys} Enter fallback(s)` : ''} in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  return phase;
}

/**
 * Best-effort press for the long soak loops: the room can fall BACK to warmup
 * mid-test (matchEnd -> fullReset after 6s, or a low-population abort), and
 * nothing restarts it on its own any more. Never throws, never waits; throttled
 * to one press per second per page so a 150ms poll cannot spam the socket.
 */
const lastNudge = new Map(); // page -> ms of the last press attempt
async function nudgeStart(page) {
  const now = Date.now();
  if (now - (lastNudge.get(page) ?? 0) < 1000) return false;
  lastNudge.set(page, now);
  try {
    const s = await fpsState(page);
    if (s === null || s.roomId === null || s.phase !== 'warmup') return false;
    return await clickStart(page);
  } catch {
    return false; // page mid-navigation / closed — the caller's own loop reports
  }
}

// ---- build + server -------------------------------------------------------------
function buildAll() {
  console.log('build: npm run build');
  const r = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`npm run build exited with code ${r.status}`);
  if (!existsSync(path.join(ROOT, 'games/fps/client/dist/index.html'))) {
    throw new Error('games/fps/client/dist/index.html missing after build (fps client not wired into npm run build?)');
  }
  if (!existsSync(path.join(ROOT, 'platform/server/dist/server.js'))) {
    throw new Error('platform/server/dist/server.js missing after build');
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

async function waitForServer(timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    if (serverChild.exitCode !== null) throw new Error(`server exited early (${serverChild.exitCode})`);
    try {
      const res = await fetch(BASE, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const text = await res.text();
        if (text.includes('STRICKEN') || text.includes('fps server')) return;
      }
    } catch {
      // not up yet
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`server did not listen on :${PORT} within ${timeoutMs}ms`);
    await sleep(250);
  }
}

// ---- browser ------------------------------------------------------------------
// Render resolution. 1280x720 is the default (screenshot fidelity); on machines
// where software rasterization can't keep the client at realtime (jump-apex and
// combat assertions are sim-rate sensitive), E2E_VIEWPORT=640x360 cuts the
// raster load ~4x — same pattern as E2E_PORT / E2E_PROTOCOL_TIMEOUT.
const VIEWPORT = (() => {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(process.env.E2E_VIEWPORT ?? '');
  return m === null
    ? { width: 1280, height: 720 }
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

// one slow frame must not abort the whole suite (software GL + shadowed
// soldier models make individual captures genuinely slow on loaded machines)
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

async function launchOne(tag, opts = {}) {
  // headless 'shell' is the default (screenshot stability); opts.extraArgs
  // appends Chromium flags for probe-style pages that need them.
  const { headless = 'shell', extraArgs = [] } = opts;
  const args = [...LAUNCH_ARGS, ...extraArgs];
  let browser = await puppeteer.launch({ ...LAUNCH_OPTS, headless, args });
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
      headless,
      args: [...args, '--use-gl=angle', '--use-angle=swiftshader'],
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
// (evaluate returns but rafFired=false or glLost=true), (c) NaN poisoning
// (posFinite=false), (d) mere slowness (everything healthy, shot lands late).
async function probePage(page, label) {
  const evalP = page.evaluate(
    () =>
      new Promise((res) => {
        let st = null;
        let stateErr = null;
        try {
          st = window.__fps ? window.__fps.state() : null;
        } catch (e) {
          stateErr = e instanceof Error ? e.message : String(e);
        }
        const canvas = document.getElementById('game');
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
              posFinite: st ? st.pos.every((v) => Number.isFinite(v)) : null,
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

async function shot(page, name) {
  const file = path.join(SHOTS_DIR, name);
  const t0 = Date.now();
  // bounded per-capture timeout (healthy captures are <1s even on swiftshader):
  // a wedged compositor must not park the suite for the full protocolTimeout
  try {
    await page.screenshot({ path: file, timeout: 30000 });
    console.log(`shot  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return;
  } catch (err) {
    console.log(
      `[diag] ${name}: capture failed at ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
        `(${err instanceof Error ? err.message : String(err)}) — probing, then one retry`,
    );
    try {
      await probePage(page, `${name} post-fail`);
      await probePage(page, `${name} post-fail+7s`);
    } catch (probeErr) {
      console.log(`[diag] ${name}: probe itself failed (${probeErr instanceof Error ? probeErr.message : String(probeErr)})`);
    }
  }
  // one retry with a wider window: transient compositor/GPU stalls clear; a
  // persistent wedge rejects here and aborts the suite with diag output above
  await page.screenshot({ path: file, timeout: 90000 });
  console.log(`shot  ${name} (retry, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// ---- gameplay helpers -----------------------------------------------------------
/** world yaw from (ax,az) towards (bx,bz); forward = (-sin(yaw), -cos(yaw)) */
function yawTo(ax, az, bx, bz) {
  return Math.atan2(-(bx - ax), -(bz - az));
}

async function aimAt(page, from, to) {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  const horiz = Math.hypot(dx, dz);
  const aEye = from[1] + 1.8 - 0.18; // standing eye
  const bChest = to[1] + 1.2;
  const yaw = yawTo(from[0], from[2], to[0], to[2]);
  const pitch = Math.atan2(bChest - aEye, Math.max(horiz, 0.001));
  await page.evaluate((y, p) => window.__fps.debug.setLook(y, p), yaw, pitch);
  return horiz;
}

/**
 * Semi-auto, frame-rate-proof: the server fires on the rising edge of the fire
 * bit, and the bit only reaches the server when a client FRAME transmits it.
 * A fixed wall-clock hold (70–90ms) assumed ~20fps; the AAA scene drops
 * headless rAF to ~5fps (~180ms frames), so ~2/3 of edges were silently
 * swallowed (evidence: ~3 accepted shots from ~16 pulses; B stays hp=100).
 * Instead HOLD fire until the authoritative mag drops (server accepted the
 * shot — the bit stays true across as many frames as it takes), then release
 * for >= 1 degraded frame so the falling edge lands before the next pulse.
 */
async function fireOneShot(page) {
  const before = (await fpsState(page)).mag;
  await page.evaluate(() => window.__fps.debug.press('fire', true));
  const t0 = Date.now();
  for (;;) {
    await sleep(60);
    const s = await fpsState(page);
    if (s !== null && s.mag < before) break; // server accepted the shot
    if (Date.now() - t0 > 2000) break; // edge lost regardless — release, retry next pulse
  }
  await page.evaluate(() => window.__fps.debug.press('fire', false));
  await sleep(300); // >= 1 frame at ~5fps so the release edge is transmitted
}

// ---- main -----------------------------------------------------------------------
async function main() {
  await mkdir(SHOTS_DIR, { recursive: true });
  // E2E_SKIP_BUILD=1 (exactly '1') reuses a warm dist — anything else builds
  if (process.env.E2E_SKIP_BUILD !== '1') buildAll();
  startServer();
  await waitForServer();
  console.log(`server up on ${BASE}`);

  const A = await launchOne('A');
  const B = await launchOne('B');

  // -- load app, main menu shot ---------------------------------------------------
  await A.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(() => A.evaluate(() => !!window.__fps), 15000, '__fps on A');
  await sleep(800); // menu paint
  await shot(A, 'menu.png');
  await B.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(() => B.evaluate(() => !!window.__fps), 15000, '__fps on B');

  // -- private room create + join ---------------------------------------------------
  await A.evaluate(() => window.__fps.createPrivate('Alice', 'dustbowl'));
  const aJoined = await waitFor(async () => {
    const s = await fpsState(A);
    return s && s.roomId !== null && s.code !== null ? s : null;
  }, 10000, 'A createPrivate join');
  check('A createPrivate joins room', true, `room=${aJoined.roomId} code=${aJoined.code} map=${aJoined.mapId}`);
  check('A map is dustbowl', aJoined.mapId === 'dustbowl', aJoined.mapId);
  const code = aJoined.code;

  await B.evaluate((c) => window.__fps.joinPrivate('Bob', c), code);
  const bJoined = await waitFor(async () => {
    const s = await fpsState(B);
    return s && s.roomId !== null ? s : null;
  }, 10000, 'B joinPrivate join');
  check('B joinPrivate joins same room', bJoined.roomId === aJoined.roomId, `room=${bJoined.roomId}`);

  // -- (21) the bot prompt must NOT appear when joining a room that already
  //    has players (B joined A's room): watch B's page for 3s from the join.
  let promptOnB = false;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
      if (await botPromptVisible(B)) {
        promptOnB = true;
        break;
      }
      await sleep(200);
    }
  }
  check('bot prompt never appears on B joining a room that already has players', !promptOnB);

  const bothRoster = await waitFor(async () => {
    const sa = await fpsState(A);
    const sb = await fpsState(B);
    return sa.players === 2 && sa.rosterSize === 2 && sb.players === 2 && sb.rosterSize === 2
      ? { sa, sb }
      : null;
  }, 10000, 'players===2 && rosterSize===2 on both pages');
  check('both pages see 2 players + roster of 2', true);
  check(
    'A and B on opposite teams',
    bothRoster.sa.team !== bothRoster.sb.team,
    `A=${bothRoster.sa.team} B=${bothRoster.sb.team}`,
  );

  // -- MANUAL START (frozen lobby contract) -------------------------------------------
  //    The room now holds 2 seats — MIN_PLAYERS_FOR_MATCH — and warmup has NO
  //    timer and NO headcount trigger (server advancePhase case 'warmup':
  //    "only handleStart leaves warmup"). So before touching anything, prove
  //    the room stays put: poll BOTH pages for 7s (> the 6s bar; warmup has no
  //    clock at all, so any leak would show as a phase change here) and record
  //    the first non-warmup phase seen, if any. The START control must be on
  //    screen the whole time — it IS the lobby's affordance.
  const HOLD_MS = 7000;
  let strayPhase = null; // first phase seen that is not warmup (either page)
  let startBtnSeen = null; // START control state during the hold
  {
    const t0 = Date.now();
    while (Date.now() - t0 < HOLD_MS) {
      const [sa, sb] = await Promise.all([fpsState(A), fpsState(B)]);
      if (sa !== null && sa.phase !== 'warmup') strayPhase = `A:${sa.phase}`;
      else if (sb !== null && sb.phase !== 'warmup') strayPhase = `B:${sb.phase}`;
      if (strayPhase !== null) break;
      const btn = await startBtnState(A);
      if (startBtnSeen === null || (!startBtnSeen.visible && btn.visible)) startBtnSeen = btn;
      await sleep(250);
    }
  }
  const heldA = await fpsState(A);
  const heldB = await fpsState(B);
  check(
    'warmup does not auto-start (2 seated, 7s hold, phase never leaves warmup)',
    strayPhase === null && heldA.phase === 'warmup' && heldB.phase === 'warmup',
    strayPhase !== null
      ? `room left warmup on its own (${strayPhase})`
      : `A=${heldA.phase} B=${heldB.phase} after ${HOLD_MS}ms with ${heldA.players} seated`,
  );
  check(
    'warmup shows the START control (button.fh-start-btn present on screen)',
    startBtnSeen !== null && startBtnSeen.present && startBtnSeen.visible,
    startBtnSeen === null
      ? 'never sampled'
      : `present=${startBtnSeen.present} visible=${startBtnSeen.visible} disabled=${startBtnSeen.disabled} label=${JSON.stringify(startBtnSeen.label.trim())}`,
  );
  await shot(A, 'warmup-lobby.png');

  // -- phase machine: warmup --(a player presses START)--> freeze -> live -------------
  //    A presses the HUD button; the server (the only judge) answers with
  //    beginFreeze(round 1), and freeze runs into live on its own timer.
  await startMatchOn(A, 'A+B private dustbowl room');
  const liveAt = await waitFor(async () => {
    const s = await fpsState(A);
    return s.phase === 'live' ? s : null;
  }, 25000, "phase 'live'");
  check("phase reaches 'live' within 25s", true, `round=${liveAt.round}`);

  // -- movement: A walks > 2m (try headings — a spawn may face a wall) ----------------
  let moved = 0;
  let movedFrom = null;
  let movedTo = null;
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const before = (await fpsState(A)).pos;
    await A.evaluate((y) => window.__fps.debug.setLook(y, 0), yaw);
    await A.evaluate(() => window.__fps.debug.setMove(0, 1));
    await sleep(1500);
    await A.evaluate(() => window.__fps.debug.setMove(0, 0));
    const after = (await fpsState(A)).pos;
    const d = Math.hypot(after[0] - before[0], after[2] - before[2]);
    if (d > moved) {
      moved = d;
      movedFrom = before;
      movedTo = after;
    }
    if (d > 2) break;
  }
  check(
    'A moved > 2m with debug.setMove(0,1) for 1.5s',
    moved > 2,
    movedFrom ? `moved ${moved.toFixed(2)}m (${movedFrom.map((v) => v.toFixed(1))} -> ${movedTo.map((v) => v.toFixed(1))})` : `moved ${moved.toFixed(2)}m`,
  );

  // -- HUD shot during live (close the auto-opened buy menu first: B keydown is
  //    handled on window even without pointer lock — see ClientGame.onKeyDown) --
  await A.keyboard.press('KeyB');
  await sleep(250);
  await shot(A, 'hud-live.png');

  // -- combat: A and B walk at each other (collide-and-slide rounds box corners);
  //    once in range A plants and fires frame-rate-proof confirmed shots
  //    (fireOneShot — see its note on the AAA-scene rAF collapse), reloading as
  //    needed. Firing only starts in range so 60 pistol rounds are never wasted
  //    on walls from spawn. Budget is 120s wall-clock (90s + headroom for the
  //    escalating stall relocations below): the approach is
  //    geometry-bound (dustbowl mid walls cost 20-35s of parallel sliding) and
  //    confirmed shots run ~2/s at degraded fps.
  const combatT0 = Date.now();
  let bHurt = false;
  let bDead = false;
  let lastLogAt = 0;
  const walkers = new Map(); // page -> committed-strafe wall-following state
  let engageHp = 100; // B hp when the current engage burst started
  let engageSince = 0; // when the current no-progress engage began
  let relocDir = 1; // committed relocation direction; flips only on a dead end
  let stalls = 0; // escalating relocation length (see relocate())

  /**
   * Walk `page` towards targetPos. Box-map wall following: while wedged, strafe
   * in ONE committed direction (per-page fixed initDir so A and B cannot mirror
   * into the same trap). The direction flips ONLY on a continuous 5s wedge (no
   * slide at all — a true dead corner); lateral slide counts as progress, so a
   * working strafe is never reversed mid-wall.
   */
  async function approach(page, selfPos, targetPos, initDir) {
    const dist = await aimAt(page, selfPos, targetPos);
    let w = walkers.get(page);
    if (w === undefined) {
      w = { lastPos: null, wedgedSince: 0, dir: initDir };
      walkers.set(page, w);
    }
    const now = Date.now();
    const moved =
      w.lastPos === null ? 1 : Math.hypot(selfPos[0] - w.lastPos[0], selfPos[2] - w.lastPos[2]);
    w.lastPos = selfPos;
    let mx = 0;
    if (moved > 0.35) {
      w.wedgedSince = 0;
    } else {
      if (w.wedgedSince === 0) w.wedgedSince = now;
      const wedgedMs = now - w.wedgedSince;
      if (wedgedMs > 5000) {
        w.dir = -w.dir; // dead corner: commit the other way
        w.wedgedSince = now;
        mx = w.dir;
      } else if (wedgedMs > 800) {
        mx = w.dir;
      }
    }
    await page.evaluate((x, z) => window.__fps.debug.setMove(x, z), mx, 1);
    return dist;
  }

  /**
   * Stall breaker: a COMMITTED, ESCALATING lateral run (see the engage branch).
   * Pure strafe (setMove(dir, 0)) for `runMs`, sampling the authoritative
   * position so the caller can tell a real relocation from a dead end. Nothing
   * here relies on the approach walker: at engage range the loop stops
   * path-following entirely, so this is the only thing that can walk the
   * shooter out from behind a piece of map.
   */
  async function relocate(page, dir, runMs) {
    const from = (await fpsState(page)).pos;
    await page.evaluate((x) => window.__fps.debug.setMove(x, 0), dir);
    const t0 = Date.now();
    let to = from;
    while (Date.now() - t0 < runMs) {
      await sleep(200);
      const s = await fpsState(page);
      if (s === null) break;
      to = s.pos;
      if (!s.alive) break;
    }
    await page.evaluate(() => window.__fps.debug.setMove(0, 0));
    return { moved: Math.hypot(to[0] - from[0], to[2] - from[2]), from, to };
  }

  while (Date.now() - combatT0 < 120000) {
    const sa = await fpsState(A);
    const sb = await fpsState(B);
    if (!sb.alive) {
      bDead = true;
      bHurt = true;
      break;
    }
    if (sb.hp < 100) bHurt = true;
    if (sa.phase !== 'live' && sa.phase !== 'warmup') {
      await sleep(300); // round ended mid-fight — wait for sim to resume
      continue;
    }
    const dist = Math.hypot(sb.pos[0] - sa.pos[0], sb.pos[2] - sa.pos[2]);
    if (Date.now() - lastLogAt > 2000) {
      lastLogAt = Date.now();
      console.log(
        `combat t=${((Date.now() - combatT0) / 1000).toFixed(0)}s dist=${dist.toFixed(1)} ` +
          `A(${sa.pos.map((v) => v.toFixed(1))}) mag=${sa.mag} B(${sb.pos.map((v) => v.toFixed(1))}) hp=${sb.hp}`,
      );
    }
    if (dist > 9) {
      // approach phase: both walk at each other, no firing (saves ammo + bloom)
      await approach(A, sa.pos, sb.pos, 1);
      await approach(B, sb.pos, sa.pos, -1);
      await sleep(150);
    } else {
      // engage phase: both halt; A aims precisely and fires controlled pulses
      if (sb.hp < engageHp) {
        engageHp = sb.hp; // landing hits — reset the stall clock
        engageSince = Date.now();
      } else if (engageSince === 0) {
        engageSince = Date.now();
      }
      if (Date.now() - engageSince > 3000) {
        // 3s of fire with no damage: geometry blocks the line. On dustbowl the
        // spawn sightline breaker (maps/dustbowl.ts: x 0, z -15, w 12, h 3) is
        // the killer case — a shooter spawned at x 0 walks straight into it,
        // ends up wedged at z -15.8 with the target 7-8m beyond it, and every
        // round goes into 3m of wall. Under the engage threshold the loop has
        // stopped path-following, so ONLY this branch can free it.
        //
        // The old form (both pages strafing 1.2s in "opposite" directions,
        // flipping the direction on every stall) could not: A and B face each
        // other, so their local strafes point the SAME way in world space —
        // they slid in parallel, keeping the wall between them — and the
        // per-stall flip turned it into an oscillator around the spawn x
        // (observed: A ping-ponging x 0.0 <-> -2.3 for 90s at hp 100).
        //
        // So: only the SHOOTER relocates (no mirroring), the direction is
        // COMMITTED across stalls, and each run is longer than the last
        // (2.5s -> 4.5s -> 6.5s, capped at 7s ~= 15m) until it is longer than
        // the obstruction is wide. The direction flips only when a run gains
        // under 1.5m — a genuine dead end, not a wall to walk around. After
        // the run the range is usually back above the engage threshold, so
        // approach() resumes and closes with the wall now cleared.
        stalls++;
        const runMs = Math.min(2500 + 2000 * (stalls - 1), 7000);
        await B.evaluate(() => window.__fps.debug.setMove(0, 0));
        const r = await relocate(A, relocDir, runMs);
        console.log(
          `combat relocate #${stalls} dir=${relocDir} runMs=${runMs} moved=${r.moved.toFixed(1)}m ` +
            `(${r.from.map((v) => v.toFixed(1))} -> ${r.to.map((v) => v.toFixed(1))})`,
        );
        if (r.moved < 1.5) relocDir = -relocDir; // dead end: commit the other way
        walkers.delete(A); // stale wedge state: the approach walker re-derives it
        engageSince = Date.now();
        engageHp = (await fpsState(B)).hp; // re-arm the fire window at the new spot
        continue;
      }
      await B.evaluate(() => window.__fps.debug.setMove(0, 0));
      await A.evaluate(() => window.__fps.debug.setMove(0, 0));
      if (sa.mag === 0) {
        await A.evaluate(() => window.__fps.debug.reload());
        await sleep(2300); // pistol reload = 2.0s
        continue;
      }
      await aimAt(A, sa.pos, sb.pos);
      await fireOneShot(A); // ~2/s at degraded fps, every shot server-confirmed
    }
  }
  await A.evaluate(() => {
    window.__fps.debug.setMove(0, 0);
    window.__fps.debug.press('fire', false);
  });
  await B.evaluate(() => window.__fps.debug.setMove(0, 0));
  const sbAfter = await fpsState(B);
  check('combat: B took damage (hp < 100)', bHurt || sbAfter.hp < 100, `B hp=${sbAfter.hp} alive=${sbAfter.alive}`);
  console.log(`combat outcome: B ${bDead ? 'killed' : 'survived'} (hp=${sbAfter.hp}) in ${((Date.now() - combatT0) / 1000).toFixed(1)}s`);
  if (bDead) {
    await sleep(600); // spectate cam settles on B
    await shot(B, 'death-spectate.png');
  }

  // -- buy: next freeze (auto-opens the buy menu client-side) ---------------------------
  //    (the 90s fight can outlive the match: matchEnd -> fullReset drops the
  //    room back to the LOBBY, where no freeze will ever come — so the poll
  //    re-presses START whenever it finds the phase back in warmup)
  let freezeSeen = null;
  try {
    freezeSeen = await waitFor(async () => {
      const s = await fpsState(A);
      if (s.phase === 'warmup') await nudgeStart(A);
      return s.phase === 'freeze' ? s : null;
    }, 30000, "phase 'freeze' for buy test");
  } catch {
    console.log('no freeze within 30s — attempting buy anyway (result logged, not asserted)');
  }
  if (freezeSeen) {
    await sleep(700); // buy menu auto-opens on the freeze snapshot
    await shot(A, 'buy-menu.png');
  }
  const moneyBefore = (await fpsState(A)).money;
  await A.evaluate(() => window.__fps.debug.buy('smg'));
  await sleep(700);
  const afterBuy = await fpsState(A);
  if (moneyBefore >= 1500) {
    check('buy smg succeeds with sufficient funds', afterBuy.money === moneyBefore - 1500, `$${moneyBefore} -> $${afterBuy.money}`);
  } else {
    const denied = afterBuy.money === moneyBefore && afterBuy.weapon !== 'smg';
    console.log(`buy smg with $${moneyBefore} (<1500): ${denied ? 'denied as expected' : 'unexpected state'} (money=$${afterBuy.money} weapon=${afterBuy.weapon})`);
  }

  // -- debug surface shape --------------------------------------------------------------
  const sFinal = await fpsState(A);
  const missing = STATE_FIELDS.filter((f) => !(f in sFinal));
  const posOk = Array.isArray(sFinal.pos) && sFinal.pos.length === 3 && sFinal.pos.every((v) => Number.isFinite(v));
  check('state() exposes all 19 contract fields', missing.length === 0 && posOk, missing.length ? `missing: ${missing}` : 'all present, pos finite [x,y,z]');

  // -- map tour: 3 vantage shots per map on page A ---------------------------------------
  for (const mapId of MAP_IDS) {
    const t0 = Date.now();
    const prevRoom = (await fpsState(A)).roomId;
    await A.evaluate((m) => window.__fps.createPrivate('Alice', m), mapId);
    await waitFor(async () => {
      const s = await fpsState(A);
      return s && s.mapId === mapId && s.roomId !== null && s.roomId !== prevRoom ? s : null;
    }, 15000, `tour join ${mapId}`);
    await sleep(2000); // world build + spawn snapshot + a few rendered frames
    const yaws = [0, 2.1, 4.2];
    const strafes = [0, 1, -1]; // diagonal walks slide along walls (no face-plant shots)
    for (let i = 0; i < yaws.length; i++) {
      await A.evaluate((y) => window.__fps.debug.setLook(y, -0.12), yaws[i]);
      if (i > 0) {
        await A.evaluate((s) => window.__fps.debug.setMove(s, 1), strafes[i]);
        await sleep(1500);
        await A.evaluate(() => window.__fps.debug.setMove(0, 0));
      }
      await sleep(300); // settle frames
      await shot(A, `map-${mapId}-${i + 1}.png`);
    }
    console.log(`tour ${mapId}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // -- (11) public room: A leaves the tour room by re-joining via createPublic
  //    (startJoin drops the old world/socket first). Public rooms have no code.
  const prevRoom = (await fpsState(A)).roomId;
  await A.evaluate(() => window.__fps.createPublic('Alice', 'crossfire'));
  const pub = await waitFor(async () => {
    const s = await fpsState(A);
    return s && s.roomId !== null && s.roomId !== prevRoom && s.code === null && s.mapId === 'crossfire'
      ? s
      : null;
  }, 15000, 'A createPublic join (crossfire, code null)');
  check(
    'A createPublic joins a public crossfire room (code === null)',
    true,
    `room=${pub.roomId} (was ${prevRoom}) code=${pub.code} map=${pub.mapId}`,
  );

  // -- (12) scoreboard: debug.scoreboard mirrors the Tab edge; the layer is
  //    .fps-menus .m9-layer-score, always in the DOM, shown via display:flex
  //    (client/src/ui/menus.ts makeLayer/show) — so assert computed visibility.
  const scoreSel = '.fps-menus .m9-layer-score';
  const scoreVisible = () =>
    A.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el !== null && getComputedStyle(el).display !== 'none';
    }, scoreSel);
  await A.evaluate(() => window.__fps.debug.scoreboard(true));
  const shown = await waitFor(async () => ((await scoreVisible()) ? true : null), 5000, 'scoreboard visible');
  await A.evaluate(() => window.__fps.debug.scoreboard(false));
  const hidden = await waitFor(async () => ((await scoreVisible()) ? null : true), 5000, 'scoreboard hidden');
  check('debug.scoreboard(true/false) toggles .m9-layer-score visibility', shown === true && hidden === true);

  // -- (13) jump apex: flat spawn ground on crossfire; per attempt one 100ms
  //    jump press, feet y sampled every 25ms for 1.2s inside the page (no
  //    evaluate round-trip jitter). THRESHOLD NOTE: the continuous apex is
  //    ~0.87m (jumpVel 5.9, gravity 20), but the sim integrates semi-implicit
  //    Euler, whose discrete peak UNDERSHOOTS with timestep: ~0.77m at 30Hz-
  //    grade pacing, ~0.65m under heavy load (measured). The bar is therefore
  //    > 0.60m — a broken jump (halved jumpVel -> ~0.2m) still fails by 3x.
  //    Sampler: up to 6 attempts with Node-side spacing decorrelate the press
  //    phase against the frame cadence, early-exit on the first pass.
  await sleep(500); // settle on the ground after the spawn snapshot
  const sampleJumpApex = () =>
    A.evaluate(
      () =>
        new Promise((resolve) => {
          const fps = window.__fps;
          const startY = fps.state().pos[1];
          let maxY = startY;
          fps.debug.press('jump', true);
          setTimeout(() => fps.debug.press('jump', false), 100);
          const t0 = performance.now();
          const iv = setInterval(() => {
            const y = fps.state().pos[1];
            if (y > maxY) maxY = y;
            if (performance.now() - t0 >= 1200) {
              clearInterval(iv);
              resolve({ startY, maxY });
            }
          }, 25);
        }),
    );
  let jumpRise = 0;
  let jumpBest = null;
  for (let i = 0; i < 6 && jumpRise <= 0.6; i++) {
    const j = await sampleJumpApex();
    if (j.maxY - j.startY > jumpRise) {
      jumpRise = j.maxY - j.startY;
      jumpBest = j;
    }
    await sleep(150); // decorrelate the next press against the frame cadence
  }
  check(
    'jump apex > 0.60m on flat ground (jumpVel 5.9; Euler undershoot — see note)',
    jumpRise > 0.6,
    jumpBest !== null
      ? `best of up to 6: start=${jumpBest.startY.toFixed(2)} apex=+${jumpRise.toFixed(2)}m`
      : 'no sample',
  );

  // -- (19) crouch: placed before the (14) bots for the same reason as
  //    (12)/(13) — A is still alone in the public crossfire room, so the phase
  //    is warmup (a match needs 2 players), A is alive on flat spawn ground,
  //    and the movement sim runs (bodies step in warmup/live). Measure SPEED
  //    standing vs crouched on the same heading; the crouch leg walks BACK
  //    (yaw + PI) along the just-proven-clear outbound path, so a wall can
  //    never shrink the crouched sample. True ratio = crouchSpeedMul 0.45
  //    (server sim must honor the bit); assert a conservative < 0.60.
  //    measureSpeed: slope-based, sim-rate-proof. Wall-clock endpoint travel is
  //    starved at degraded rAF (the AAA scene: input latency + snapshot lag eat
  //    25-50% of a 1s leg, biasing readings LOW — walk read 0.29 vs true 0.55).
  //    The reported pos lags by a roughly CONSTANT delay, which shifts
  //    endpoints but NOT the slope: sample pos every 100ms over a 2s leg, trim
  //    the 500ms input-latency head, least-squares per axis (frame quantization
  //    at ~5fps averages out across ~15 points; sim speed changes are instant).
  const measureSpeed = async (yaw) => {
    await A.evaluate((y) => window.__fps.debug.setLook(y, 0), yaw);
    await sleep(250); // let the look input land before the leg starts
    await A.evaluate(() => window.__fps.debug.setMove(0, 1));
    const t0 = Date.now();
    const pts = [];
    while (Date.now() - t0 < 2000) {
      const s = await fpsState(A);
      if (s !== null) pts.push([Date.now() - t0, s.pos[0], s.pos[2]]);
      await sleep(100);
    }
    await A.evaluate(() => window.__fps.debug.setMove(0, 0));
    const kept = pts.filter(([t]) => t >= 500); // trim the input-latency head
    if (kept.length < 4) return 0;
    const slope = (idx) => {
      const n = kept.length;
      const mt = kept.reduce((a, p) => a + p[0], 0) / n;
      const mv = kept.reduce((a, p) => a + p[idx], 0) / n;
      let num = 0;
      let den = 0;
      for (const p of kept) {
        num += (p[0] - mt) * (p[idx] - mv);
        den += (p[0] - mt) ** 2;
      }
      return den === 0 ? 0 : (num / den) * 1000; // m per second
    };
    return Math.hypot(slope(1), slope(2));
  };
  let crouchRatio = null;
  let crouchDetail = '';
  let best19 = null; // [speed, yaw] — evidence for the no-heading detail
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const s19 = await fpsState(A);
    if (s19 === null || (s19.phase !== 'warmup' && s19.phase !== 'live') || !s19.alive) {
      await sleep(500); // sim not stepping (or A down) — retry on the next heading
      continue;
    }
    const standing = await measureSpeed(yaw);
    if (best19 === null || standing > best19[0]) best19 = [standing, yaw];
    if (standing < 2.0) continue; // wall-bound heading — try another
    // adaptive gate: the absolute slope sags under load (dt-clamped prediction
    // at ~2.5fps reads 2-3.5 m/s even on open ground), so no fixed 3.5 gate —
    // the RATIO is load-canceling. PAIRING invariant: the modified retrace
    // runs IMMEDIATELY, from the spot the standing leg just reached (a later
    // re-measure can walk A into a wall and poison the pair — observed).
    await A.evaluate(() => window.__fps.debug.press('crouch', true));
    const crouched = await measureSpeed(yaw + Math.PI); // retrace the proven-clear path
    await A.evaluate(() => window.__fps.debug.press('crouch', false));
    crouchRatio = crouched / standing;
    crouchDetail = `standing ${standing.toFixed(2)}m/s vs crouched ${crouched.toFixed(2)}m/s — ratio ${crouchRatio.toFixed(2)} (want < 0.60; crouchSpeedMul 0.45)`;
    break;
  }
  if (crouchRatio === null && crouchDetail === '') {
    crouchDetail = `no clear heading (best=${best19 === null ? 'none' : `${best19[0].toFixed(2)}m/s`})`;
  }
  await A.evaluate(() => window.__fps.debug.press('crouch', false)); // never leak the bit into (14)+
  check(
    'crouch: crouched travel < 60% of standing (server sim honors the crouch bit)',
    crouchRatio !== null && crouchRatio < 0.6,
    crouchDetail || 'never got a live/warmup sample on a clear heading',
  );

  // -- (23) shift-walk: identical conditions to (19) — A is still alone in the
  //    public crossfire room (warmup, alive, flat spawn ground), so the same
  //    standing-outbound / modified-retrace measurement works. The walk bit
  //    rides the crouch bit's exact path: debug.press('walk') -> dbgButtons ->
  //    INPUT_WALK in the C2S input frame -> server stepBody scales by
  //    walkSpeedMul 0.55. (A real Shift key could never work here: input.ts
  //    gates held keys on pointer lock, which headless-shell denies.) Assert
  //    the spec band: walked = 45..70% of standing.
  let walkRatio = null;
  let walkDetail = '';
  let best23 = null; // [speed, yaw] — evidence for the no-heading detail
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const s23 = await fpsState(A);
    if (s23 === null || (s23.phase !== 'warmup' && s23.phase !== 'live') || !s23.alive) {
      await sleep(500); // sim not stepping (or A down) — retry on the next heading
      continue;
    }
    const standing = await measureSpeed(yaw);
    if (best23 === null || standing > best23[0]) best23 = [standing, yaw];
    if (standing < 2.0) continue; // wall-bound heading — try another
    // same adaptive gate + immediate pairing as (19)
    await A.evaluate(() => window.__fps.debug.press('walk', true));
    const walked = await measureSpeed(yaw + Math.PI); // retrace the proven-clear path
    await A.evaluate(() => window.__fps.debug.press('walk', false));
    walkRatio = walked / standing;
    walkDetail = `standing ${standing.toFixed(2)}m/s vs walked ${walked.toFixed(2)}m/s — ratio ${walkRatio.toFixed(2)} (want 0.45..0.70; walkSpeedMul 0.55)`;
    break;
  }
  if (walkRatio === null && walkDetail === '') {
    walkDetail = `no clear heading (best=${best23 === null ? 'none' : `${best23[0].toFixed(2)}m/s`})`;
  }
  await A.evaluate(() => window.__fps.debug.press('walk', false)); // never leak the bit into (14)+
  check(
    'shift-walk: walked travel is 45-70% of standing (server sim honors the walk bit)',
    walkRatio !== null && walkRatio >= 0.45 && walkRatio <= 0.7,
    walkDetail || 'never got a live/warmup sample on a clear heading',
  );

  // -- (14) bots: A is alone in the public crossfire room here (B stayed in
  //    the private dustbowl room from the combat flow) — so assert deltas off
  //    the live count, not absolutes. Kept after (12)/(13) so bots cannot
  //    perturb those samples (belt and braces now that seats alone can never
  //    start a match — the room stays in warmup until (17) presses START).
  const botsBefore = (await fpsState(A)).players;
  await A.evaluate(() => {
    window.__fps.addBot();
    window.__fps.addBot();
  });
  let added = null;
  try {
    added = await waitFor(async () => {
      const s = await fpsState(A);
      return s.players === botsBefore + 2 ? s : null;
    }, 5000, 'players +2 after 2x addBot');
  } catch {
    // reported by the failing check below — later bot checks still run
  }
  check(
    'addBot x2 increases player count by exactly 2',
    added !== null,
    added ? `${botsBefore} -> ${added.players}` : `expected ${botsBefore + 2}, still ${(await fpsState(A)).players}`,
  );

  // -- (15) removeBot drops the most recently added bot.
  await A.evaluate(() => window.__fps.removeBot());
  let removed = null;
  try {
    removed = await waitFor(async () => {
      const s = await fpsState(A);
      return s.players === botsBefore + 1 ? s : null;
    }, 5000, 'players -1 after removeBot');
  } catch {
    // reported by the failing check below
  }
  check(
    'removeBot decreases player count by exactly 1',
    removed !== null,
    removed ? `${botsBefore + 2} -> ${removed.players}` : `expected ${botsBefore + 1}, still ${(await fpsState(A)).players}`,
  );

  // -- (16) soak: the remaining bot hunts A for ~6s (in the LOBBY: warmup is
  //    live play, and nothing has pressed START yet) — nothing on either page
  //    may crash or log.
  const errsBeforeSoak = pageErrors.length;
  await sleep(6000);
  check(
    '6s bot soak: zero page errors on either page',
    pageErrors.length === errsBeforeSoak,
    `${pageErrors.length - errsBeforeSoak} new error(s)`,
  );

  // -- (17) team switch: frozen semantics — immediate apply in warmup; queued
  //    and applied at the next beginFreeze (guard re-evaluated) in any other
  //    phase. Post-soak the room holds A + 1 bot — two seats, so START is legal
  //    — and A PRESSES IT here: the running match is what makes the queued path
  //    (the interesting one) reachable at all, and (18) below needs roundEnds.
  //    Both paths stay asserted; whichever the phase lands in is reported.
  //    Detection is a TEAM wait, not a phase wait: once the flip lands the old
  //    team is empty, so the room forfeit-cycles with ONE-TICK (~33ms) freezes
  //    that a 150ms phase poll can never catch — the flipped team persists for
  //    rounds and is the reliable signal. 1v1 => the guard always allows this
  //    switch (1 < 1 + 1). The 5s immediate window covers the warmup path; the
  //    long window covers a full round (live 100s + roundEnd 4s + matchEnd
  //    detour) for the queued one.
  //    START is pressed BEFORE the team is sampled: beginFreeze auto-balances,
  //    so a team read from the lobby could be stale by the time the request
  //    lands. A failure to start is not fatal — (17) then simply exercises the
  //    warmup/immediate path and (18) reports its own inconclusive detail.
  try {
    await startMatchOn(A, 'A + soak bot (public crossfire)', 20000);
  } catch (err) {
    console.log(`start17: ${err instanceof Error ? err.message : String(err)} — continuing in the lobby`);
  }
  const team17Before = (await fpsState(A)).team;
  const team17Target = team17Before === 'T' ? 'CT' : 'T';
  let lastLog17 = 0;
  const log17 = async (tag) => {
    const now = Date.now();
    if (now - lastLog17 < 2000) return;
    lastLog17 = now;
    const s = await fpsState(A);
    if (s !== null) console.log(`switch17 ${tag}: phase=${s.phase} team=${s.team} round=${s.round}`);
  };
  await A.evaluate((t) => window.__fps.debug.switchTeam(t), team17Target);
  let flip17 = null;
  let path17 = 'immediate';
  try {
    flip17 = await waitFor(async () => {
      await log17('immediate');
      const s = await fpsState(A);
      return s !== null && s.team === team17Target ? s : null;
    }, 5000, 'team flip (immediate/warmup path)');
  } catch {
    path17 = 'queued'; // not immediate — the request applies at the next beginFreeze
  }
  if (flip17 === null) {
    try {
      flip17 = await waitFor(async () => {
        await log17('queued');
        const s = await fpsState(A);
        // a queued switch applies at the next beginFreeze — and the forfeit
        // cycle can run the match all the way to matchEnd -> fullReset, which
        // parks the room in the lobby where no freeze will ever come again
        if (s !== null && s.phase === 'warmup') await nudgeStart(A);
        return s !== null && s.team === team17Target ? s : null;
      }, 125000, 'team flip at the next beginFreeze (queued path)');
    } catch {
      flip17 = null; // reported by the failing check below
    }
  }
  check(
    'debug.switchTeam flips A team (immediate in warmup, else at next freeze)',
    flip17 !== null,
    flip17
      ? `${team17Before} -> ${flip17.team} (${path17} path, phase=${flip17.phase} round=${flip17.round})`
      : `still ${(await fpsState(A)).team}, target ${team17Target}`,
  );

  // -- (18) team_full guard (frozen rule: a switch is DENIED when the target
  //    team already holds >= other + 1). Proving a denial needs a roster the
  //    guard actually bites on — the switcher ALONE on one side, two players on
  //    the other — and that can no longer be shaped out of the (17) room:
  //    the very beginFreeze that applies (17)'s queued flip also runs the
  //    balancer right after it (game.ts beginFreeze: applyQueuedTeamSwitches
  //    THEN autoBalanceTeams), so the 2v0 it creates is repaired on the spot by
  //    pulling the soak bot across (bots are the first balance candidates). The
  //    room is a 1v1 again, B's quick-join is a pickTeam coin flip, and either
  //    way B ends up on the 2-side of a 2v1 where the guard cannot apply. (The
  //    old failure was exactly this: "B failed to land on the opposite team"
  //    while the room ids matched — B had simply landed on A's side.)
  //
  //    So (18) shapes its OWN room, in WARMUP, where a switch applies
  //    IMMEDIATELY (game.ts handleSwitchTeam) and is therefore readable one
  //    poll later — no freeze round trip and no guessing:
  //      A + B in a fresh private room (auto-balanced to 1v1) + 1 bot -> 2v1.
  //      1. Put A and B on the SAME side. The bot is then provably ALONE on the
  //         other one — the only thing the harness can know about the bot's
  //         side without reading the server's roster. B -> A's side is tried
  //         first; when the guard denies it (that means A's side is the 2-side,
  //         i.e. the bot is already with A) the read-back shows no change and
  //         A -> B's side is used instead. Exactly one of the two is legal.
  //      2. Move A onto the bot's side: 1 < 2 + 1, allowed. Result: A + bot (2)
  //         vs B alone (1), and |diff| == 1 so autoBalanceTeams leaves it be.
  //    Then START, and B suicides in live via the frozen console 'kill'
  //    command: B IS its entire side, so the round ends at once and roundEnd
  //    arrives in ~1s instead of a full 100s round. B requests A's side from
  //    that roundEnd; a granted switch would apply at the next beginFreeze, so
  //    B's team is watched THROUGH that freeze +5s. The guard re-evaluates
  //    there (target 2 >= other 1 + 1) and must drop the request — surviving
  //    the freeze unchanged is what separates DENIED from merely pending.
  //    Round 5 (halftime swaps everyone) is never reached: this is round 1.
  let denied18 = false;
  let detail18 = '';
  try {
    await A.evaluate(() => window.__fps.createPrivate('Alice', 'crossfire'));
    const a18 = await waitFor(async () => {
      const s = await fpsState(A);
      return s !== null && s.roomId !== null ? s : null;
    }, 15000, 'A private room for the team_full guard');
    await B.evaluate((c) => window.__fps.joinPrivate('Bob', c), a18.code);
    await waitFor(async () => {
      const s = await fpsState(B);
      return s !== null && s.roomId === a18.roomId ? s : null;
    }, 15000, 'B into the guard room');
    await A.evaluate(() => window.__fps.addBot());
    await waitFor(async () => {
      const [sa, sb] = await Promise.all([fpsState(A), fpsState(B)]);
      return sa !== null && sb !== null && sa.players === 3 && sb.players === 3 ? true : null;
    }, 10000, '3 seats (A + B + bot) in the guard room');

    // step 1 — A and B onto one side (warmup: immediate, so just read back)
    let sa18 = await fpsState(A);
    let sb18 = await fpsState(B);
    const shapeFrom = `A=${sa18.team} B=${sb18.team}`;
    if (sa18.team !== sb18.team) {
      await B.evaluate((t) => window.__fps.debug.switchTeam(t), sa18.team);
      await sleep(1200);
      sa18 = await fpsState(A);
      sb18 = await fpsState(B);
      if (sa18.team !== sb18.team) {
        // denied => A's side already holds the bot; move A to B's side instead
        await A.evaluate((t) => window.__fps.debug.switchTeam(t), sb18.team);
        await sleep(1200);
        sa18 = await fpsState(A);
        sb18 = await fpsState(B);
      }
    }
    if (sa18.team !== sb18.team) {
      throw new Error(`could not put A and B on one side (${shapeFrom} -> A=${sa18.team} B=${sb18.team})`);
    }
    // step 2 — A joins the (now provably lone) bot: A + bot vs B alone
    const botTeam18 = sa18.team === 'T' ? 'CT' : 'T';
    await A.evaluate((t) => window.__fps.debug.switchTeam(t), botTeam18);
    await sleep(1200);
    sa18 = await fpsState(A);
    sb18 = await fpsState(B);
    if (sa18.team !== botTeam18 || sb18.team === sa18.team) {
      throw new Error(`could not seat A with the bot (A=${sa18.team} B=${sb18.team}, wanted A=${botTeam18})`);
    }
    console.log(`guard18 shaping: ${shapeFrom} -> A+bot=${sa18.team} vs B=${sb18.team} (2v1)`);

    await startMatchOn(A, 'team_full guard room (A + bot vs B)', 25000);
    await waitFor(async () => {
      const s = await fpsState(B);
      return s !== null && s.phase === 'live' ? s : null;
    }, 30000, "phase 'live' in the guard room");
    // B is its whole side: its death ends the round, so roundEnd is ~1s away
    await B.evaluate(() => window.__fps.debug.console('kill'));
    const at18 = await waitFor(async () => {
      const s = await fpsState(B);
      return s !== null && s.phase === 'roundEnd' ? s : null;
    }, 30000, 'roundEnd for the guard attempt');

    const bTeam18 = at18.team;
    const bTarget18 = bTeam18 === 'T' ? 'CT' : 'T'; // the 2-side: A + the bot
    await B.evaluate((t) => window.__fps.debug.switchTeam(t), bTarget18);
    // watch from the attempt through the NEXT transition into freeze +5s
    const t0 = Date.now();
    let prevPhase = 'roundEnd';
    let freezeAt = 0;
    let changedTo = null;
    while (Date.now() - t0 < 60000) {
      const s = await fpsState(B);
      if (s !== null) {
        if (s.team !== bTeam18) {
          changedTo = s.team;
          break;
        }
        if (s.phase !== prevPhase) {
          if (s.phase === 'freeze' && freezeAt === 0) freezeAt = Date.now();
          prevPhase = s.phase;
        }
        // a match can still end under the watch — press START again so a
        // beginFreeze (where the guard re-evaluates) is still coming
        if (s.phase === 'warmup' && freezeAt === 0) await nudgeStart(B);
        if (freezeAt !== 0 && Date.now() - freezeAt >= 5000) break; // freeze passed, request dropped
      }
      await sleep(200);
    }
    denied18 = changedTo === null && freezeAt !== 0;
    detail18 =
      `B=${bTeam18} alone, target=${bTarget18} (A + bot)` +
      (changedTo !== null
        ? ` FLIPPED to ${changedTo} — guard let it through`
        : freezeAt === 0
          ? ' — no freeze within 60s, inconclusive'
          : ' — unchanged through beginFreeze + 5s (denied, request dropped)');
  } catch (err) {
    denied18 = false;
    detail18 = `aborted: ${err instanceof Error ? err.message : String(err)}`;
  }
  check(
    'team_full guard: switch to the larger team is denied (no flip through the next freeze)',
    denied18,
    detail18,
  );

  // -- (20) solo bot prompt: A takes a FRESH public room on dustbowl (the (11)
  //    public room is crossfire and B is still in it, so dustbowl guarantees A
  //    alone). Kept last among the gameplay checks: the 3 added bots would
  //    invalidate the (14)-(18) roster/team invariants. The prompt's
  //    observable is its 'ADD 3 BOTS' button (see botPromptVisible).
  const prevRoom20 = (await fpsState(A)).roomId;
  await A.evaluate(() => window.__fps.createPublic('Alice', 'dustbowl'));
  let ok20 = false;
  let detail20 = '';
  try {
    const solo = await waitFor(async () => {
      const s = await fpsState(A);
      return s !== null && s.roomId !== null && s.roomId !== prevRoom20 && s.code === null &&
        s.mapId === 'dustbowl' && s.players === 1
        ? s
        : null;
    }, 15000, 'A solo in a fresh public dustbowl room');
    await waitFor(async () => ((await botPromptVisible(A)) ? true : null), 5000, 'bot prompt visible (A solo)');
    if (!(await clickBotPrompt(A))) throw new Error('ADD 3 BOTS button not found for click');
    const populated = await waitFor(async () => {
      const s = await fpsState(A);
      return s !== null && s.players === solo.players + 3 ? s : null;
    }, 5000, 'players +3 after ADD 3 BOTS');
    await waitFor(async () => ((await botPromptVisible(A)) ? null : true), 5000, 'bot prompt hidden once not solo');
    ok20 = true;
    detail20 = `shown when solo, clicked, players ${solo.players} -> ${populated.players}, hidden`;
  } catch (err) {
    detail20 = err instanceof Error ? err.message : String(err);
  }
  check('solo bot prompt: visible when alone; ADD 3 BOTS adds 3 players and hides it', ok20, detail20);

  // -- (22 setup) shape A's team to A + 2 bots: addBot lands on the smaller
  //    team, ties are a server coin flip — re-roll bad flips (removeBot is
  //    LIFO) until the scoreboard shows A's team at 3. WHY: in a 2v2 the lone
  //    teammate bot loses its 1v2 before A reaches mid, so A's death ENDS the
  //    round with no alive teammate (observed: 5 deaths, all phase=roundEnd,
  //    spectateTarget null, chip hidden). With 2 teammates A's death leaves
  //    one alive -> spectateTarget set. Team sizes are read off the
  //    scoreboard DOM (.m9-table per team, one .m9-row per player + 1 col head).
  const aTeam22 = (await fpsState(A)).team;
  const myTeamSize22 = async () => {
    // scoreboard(down) is a ONE-SHOT render (clientGame.scoreboard) — it does
    // NOT rebuild per snapshot, so re-render before every read or the sizes go
    // stale (observed: size pinned at 2, every honest flip judged 'bad').
    await A.evaluate(() => window.__fps.debug.scoreboard(true));
    const sizes = await A.evaluate(() => {
      const out = { T: 0, CT: 0 };
      for (const w of document.querySelectorAll('.fps-menus .m9-layer-score .m9-table')) {
        const head = w.querySelector('.m9-table-head')?.textContent ?? '';
        const team = head.startsWith('CT') ? 'CT' : 'T';
        out[team] = w.querySelectorAll('.m9-row').length - 1; // minus the column-head row
      }
      return out;
    });
    return sizes[aTeam22] ?? 0;
  };
  for (let tries = 0; tries < 6; tries++) {
    await sleep(800); // roster snapshot + scoreboard rebuild settle
    if ((await myTeamSize22()) >= 3) break;
    const beforeAdd = (await fpsState(A)).players;
    await A.evaluate(() => window.__fps.addBot());
    await waitFor(async () => {
      const s = await fpsState(A);
      return s !== null && s.players === beforeAdd + 1 ? s : null;
    }, 5000, 'shaping addBot lands').catch(() => null);
    await sleep(800);
    if ((await myTeamSize22()) >= 3) break;
    // bad flip (the bot went to the enemy team): removeBot is LIFO — undo, re-roll
    const beforeRm = (await fpsState(A)).players;
    await A.evaluate(() => window.__fps.removeBot());
    await waitFor(async () => {
      const s = await fpsState(A);
      return s !== null && s.players === beforeRm - 1 ? s : null;
    }, 5000, 'shaping removeBot lands').catch(() => null);
  }
  const teamSize22 = await myTeamSize22();
  await A.evaluate(() => window.__fps.debug.scoreboard(false)); // closed BEFORE the blackout scan
  console.log(`spectate22 team shaping: A team size=${teamSize22} (want 3)`);

  // -- (22 start) the spectate chip is a MATCH observable: updateSpectators
  //    only assigns spectateTarget in live/roundEnd/matchEnd — in warmup it is
  //    pinned to null (a respawn is already coming). So the shaped room must be
  //    taken out of the lobby before the death watch, and put back in play
  //    whenever a match ends under it (see the nudge inside the loop).
  //    Shaping ran in the lobby on purpose: beginFreeze auto-balances only when
  //    the sides differ by more than one, so a 3v2 survives the press intact.
  try {
    await startMatchOn(A, 'spectate room (A + 3 bots)', 20000);
  } catch (err) {
    console.log(`start22: ${err instanceof Error ? err.message : String(err)} — the chip watch will keep pressing`);
  }

  // -- (22) spectate visual sanity: the setup above shaped the (20) room to a
  //    3v2 (A + 2 bot teammates; re-rolled coin flips — in a plain 2v2 the lone
  //    teammate dies its 1v2 first and A's death never gets a spectateTarget).
  //    DEVIATION from the letter of the spec ("B's chip"): the chip can NEVER
  //    appear for B in the private-room 1v1 — the server assigns spectateTarget
  //    as the first alive TEAMMATE (game.ts updateSpectators), so a lone dead
  //    player gets null and the chip stays hidden (see death-spectate.png:
  //    corpse cam, no chip). A's death with 2 live bot teammates is the
  //    contract-conformant way to observe 'SPECTATING X'.
  //
  //    HOW A DIES: the frozen console command 'kill' (clientGame.consoleExec ->
  //    C2S suicide -> game.ts handleSuicide, the normal death path with a null
  //    killer, legal in warmup/live only). The old form herded a defenceless A
  //    into the enemy half and waited for a bot to shoot it, which is neither
  //    prompt nor certain — in a shaped 3v1 the teammates win the round before
  //    A is ever touched (observed: 3 death samples in 240s, every one of them
  //    already past the kill, chip text stale from an earlier life and the
  //    element back to fh-hidden because spectateTarget had gone null again).
  //    Suiciding mid-live is deterministic and puts the chip up while every
  //    teammate is certainly alive.
  //
  //    HOW IT IS OBSERVED: an IN-PAGE recorder, not a node poll. The client
  //    renders at ~5fps headless, so a node-side poll (one CDP round trip per
  //    sample) can step straight over a chip window; a setInterval inside the
  //    page samples every 50ms off the timer queue and, on the first visible
  //    'SPECTATING <name>', runs the blackout scan ATOMICALLY in the same tick
  //    the chip is up. Blackout = any #hud/#menu element covering >40% of the
  //    viewport with a near-opaque (alpha >= 0.5) black-ish non-gradient
  //    background (body/#app are the page's opaque ink backdrop by design; the
  //    .fh-vig vignette is a radial gradient). One legit overlay is EXCLUDED:
  //    when A dies close to a round boundary the next freeze auto-opens the buy
  //    menu over the spectate view (an open .m9-layer-buy IS a 78%-ink
  //    full-viewport layer) — those samples are skipped, not counted.
  let specOk = false;
  let specDetail = '';
  let chipSeen = null;
  let blackouts = [];
  await A.evaluate(() => {
    window.__specWatch = { seen: null, deadSamples: 0, visibleSamples: 0 };
    const scanBlackouts = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const out = [];
      for (const el of document.querySelectorAll('#hud *, #menu *')) {
        const r = el.getBoundingClientRect();
        if (r.width * r.height <= 0.4 * vw * vh) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
        if (cs.backgroundImage.includes('gradient')) continue;
        const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(
          cs.backgroundColor,
        );
        if (m === null) continue;
        const alpha =
          m[4] === undefined ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
        const blackish = Number(m[1]) <= 64 && Number(m[2]) <= 64 && Number(m[3]) <= 64;
        if (blackish && alpha >= 0.5) {
          out.push(`${el.tagName.toLowerCase()}.${String(el.className)} bg=${cs.backgroundColor}`);
        }
      }
      return out;
    };
    window.__specWatchTimer = setInterval(() => {
      const w = window.__specWatch;
      if (w.seen !== null) return;
      const st = window.__fps?.state?.() ?? null;
      if (st === null || st.alive) return;
      w.deadSamples++;
      const el = document.querySelector('#hud .fh-spec');
      if (el === null) return;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (cs.display === 'none' || r.width === 0 || r.height === 0) return;
      w.visibleSamples++;
      const text = el.textContent ?? '';
      if (!text.toUpperCase().includes('SPECTATING')) return;
      const buy = document.querySelector('.fps-menus .m9-layer-buy');
      if (buy !== null && getComputedStyle(buy).display !== 'none') return; // legit freeze overlay
      w.seen = { text, visible: true, phase: st.phase, blackouts: scanBlackouts() };
    }, 50);
  });
  const specDeadline = Date.now() + 180000;
  let lastSpecLog = 0;
  let specKills = 0;
  while (Date.now() < specDeadline && chipSeen === null) {
    const s = await fpsState(A);
    // a finished match drops the room back to the lobby (fullReset), where
    // spectateTarget is always null — press START again and keep hunting
    if (s !== null && s.phase === 'warmup') await nudgeStart(A);
    if (s !== null && s.alive && s.phase === 'live') {
      await A.evaluate(() => window.__fps.debug.console('kill'));
      specKills++;
      await sleep(1200); // let the death land and the chip come up
    }
    const w = await A.evaluate(() => window.__specWatch);
    if (w.seen !== null) {
      chipSeen = { text: w.seen.text, visible: w.seen.visible };
      blackouts = w.seen.blackouts;
      break;
    }
    if (Date.now() - lastSpecLog > 5000) {
      lastSpecLog = Date.now(); // evidence for future flakes
      console.log(
        `spectate22: phase=${s?.phase} alive=${s?.alive} kills=${specKills} ` +
          `deadSamples=${w.deadSamples} chipVisibleSamples=${w.visibleSamples}`,
      );
    }
    await sleep(250);
  }
  await A.evaluate(() => {
    if (window.__specWatchTimer !== undefined) clearInterval(window.__specWatchTimer);
    window.__fps.debug.setMove(0, 0);
  });
  if (chipSeen === null) {
    const w = await A.evaluate(() => window.__specWatch);
    specDetail =
      `no SPECTATING chip observed in 180s ` +
      `(${specKills} console 'kill's, ${w.deadSamples} dead samples, ${w.visibleSamples} visible-chip samples)`;
  } else {
    specOk = blackouts.length === 0;
    specDetail =
      `chip=${JSON.stringify(chipSeen)} after ${specKills} console 'kill'(s)` +
      ` blackout-overlays=${blackouts.length}${blackouts.length > 0 ? `: ${blackouts.join('; ')}` : ''}`;
  }
  check(
    "spectate: chip reads 'SPECTATING' and no >40% viewport near-opaque black overlay",
    specOk,
    specDetail,
  );

  // -- error-banner DOM check for A/B, then RELEASE both browsers: their work
  //    ends at (22), and the (24)/(25) page runs leaner with only one chromium
  //    plus the server alive. (window.onerror surface may not raise pageerror,
  //    hence the DOM probe.)
  for (const [tag, page] of [['A', A], ['B', B]]) {
    const banner = await page.evaluate(() => document.querySelector('.error-banner')?.textContent ?? null);
    if (banner) pageErrors.push(`[${tag}] error-banner visible: ${banner}`);
  }
  await Promise.all([A.browser().close().catch(() => {}), B.browser().close().catch(() => {})]);

  // -- (24) Q quick-switch: the Q/slot edges are gated on pointer lock
  //    (input.ts onKeyDown -> locked()), and REAL pointer lock is untestable
  //    here: chrome-headless-shell denies every request (probed:
  //    pointerlockerror), while the new-headless modes that grant it wedge
  //    this machine's compositor in-room (probed: rAF stalls -> the 5s input-
  //    timeout kick; WebGL context loss -> the client's own onContextLost
  //    closes the connection). So C stays on the proven-stable shell and the
  //    test stubs the ONE read-only observable locked() consults: with
  //    __fakeLock set, Document.prototype.pointerLockElement reports the
  //    canvas. Everything downstream is the real path — keydown -> edge queue
  //    -> handleEdges -> C2S switch -> server validation -> snapshot.
  //    Flow: fresh private crossfire room + 1 bot, then C PRESSES START (two
  //    seats = canStart; the lobby never leaves warmup by itself, and the money
  //    this test needs only exists once rounds actually resolve); round 1 C
  //    rushes defenseless (meets the bot halfway, dies fast); every round outcome
  //    pays >= ECONOMY.lossReward (1900), so the round-2 freeze has
  //    money >= 1500 -> debug.buy('smg') (the canBuy path). NOTE: the server
  //    does NOT auto-switch when the held weapon survives the buy (pistol is
  //    issued, never dropped) — setWeapon only fires when the held primary
  //    was replaced — so Digit3 equips the smg before the 'weapon smg'
  //    assert. Then KeyB closes the buy menu -> __fakeLock on -> Digit2
  //    (slot edge = the weapon switch path) -> pistol -> KeyQ -> back to smg
  //    (the previously held).
  let qOk = false;
  let qDetail = '';
  let C = null;
  try {
    C = await launchOne('C');
    await C.evaluateOnNewDocument(() => {
      window.__fakeLock = false;
      const real = Object.getOwnPropertyDescriptor(Document.prototype, 'pointerLockElement');
      Object.defineProperty(Document.prototype, 'pointerLockElement', {
        configurable: true,
        get() {
          if (window.__fakeLock) return document.getElementById('game');
          return real !== undefined && real.get !== undefined ? real.get.call(this) : null;
        },
      });
    });
    await C.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitFor(() => C.evaluate(() => !!window.__fps), 15000, '__fps on C');
    await C.evaluate(() => window.__fps.createPrivate('Carol', 'crossfire'));
    await waitFor(async () => {
      const s = await fpsState(C);
      return s !== null && s.roomId !== null ? s : null;
    }, 10000, 'C createPrivate join');
    await C.evaluate(() => window.__fps.addBot());
    await waitFor(async () => {
      const s = await fpsState(C);
      return s !== null && s.players >= 2 ? s : null;
    }, 10000, 'the bot is seated on C (2 seats = canStart)');
    await startMatchOn(C, 'C + bot (private crossfire)', 20000);
    await C.evaluate(() => window.__fps.debug.setMove(0, 1)); // rush until round 1 ends
    const rich24 = await waitFor(async () => {
      const s = await fpsState(C);
      if (s === null) return null;
      if (s.phase === 'live' || s.phase === 'warmup') {
        await C.evaluate(() => window.__fps.debug.setMove(0, 1)); // re-assert the rush
      }
      // a match that runs out (matchEnd -> fullReset) parks C in the lobby:
      // press START again or no freeze — and no money — is ever coming
      if (s.phase === 'warmup') await nudgeStart(C);
      return s.phase === 'freeze' && s.money >= 1500 ? s : null;
    }, 150000, 'freeze with money >= 1500 (one full round + slack)');
    await C.evaluate(() => window.__fps.debug.setMove(0, 0));
    await C.evaluate(() => window.__fps.debug.buy('smg'));
    await waitFor(async () => {
      const s = await fpsState(C);
      return s !== null && s.money === rich24.money - 1500 ? s : null;
    }, 5000, 'money -1500 after buy (buy confirmed)');
    await C.keyboard.press('KeyB'); // close the auto-opened buy menu (works unlocked)
    await sleep(250);
    await C.evaluate(() => {
      window.__fakeLock = true; // locked() now true for the game's canvas
    });
    await waitFor(
      () => C.evaluate(() => document.pointerLockElement !== null),
      5000,
      'fake pointer lock on C',
    );
    await C.keyboard.press('Digit3'); // slot 3 = smg — equip the bought gun (no auto-switch)
    await waitFor(async () => {
      const s = await fpsState(C);
      return s !== null && s.weapon === 'smg' ? s : null;
    }, 5000, 'weapon smg after buy + Digit3');
    await C.keyboard.press('Digit2'); // slot 2 = pistol (WEAPON_ORDER)
    await waitFor(async () => {
      const s = await fpsState(C);
      return s !== null && s.weapon === 'pistol' ? s : null;
    }, 5000, 'weapon pistol after Digit2');
    await C.keyboard.press('KeyQ');
    await waitFor(async () => {
      const s = await fpsState(C);
      return s !== null && s.weapon === 'smg' ? s : null;
    }, 5000, 'weapon smg after KeyQ (quick-switch to the previously held)');
    await C.evaluate(() => {
      window.__fakeLock = false;
    });
    qOk = true;
    qDetail = `bought smg at $${rich24.money}, Digit3 -> smg, Digit2 -> pistol, KeyQ -> smg`;
  } catch (err) {
    qDetail = err instanceof Error ? err.message : String(err);
    if (C !== null) await C.evaluate(() => window.__fps?.debug.setMove(0, 0)).catch(() => {});
  }
  check('Q quick-switch: buy smg, slot to pistol, Q returns to smg', qOk, qDetail);

  // -- (25) developer console (CONTRACT.md 'Developer console'): the e2e hook
  //    __fps.debug.console(text) executes a command exactly like Enter in the
  //    overlay (clientGame.consoleExec). Runs on C, normally still in the (24)
  //    room (private — nobody else can join); if (24) lost the room (e.g., an
  //    input-timeout kick), C re-joins first — the console check is
  //    independent of quick-switch. 'addbot 2' must grow the room by exactly 2
  //    within 5s; an unknown command must return the non-empty error line the
  //    overlay would print.
  //
  //    THE SEAT COUNT IS rosterSize, NOT players. A bot added while a round is
  //    in progress (game.ts joinPlayer: pending = roundInProgress(), i.e. any
  //    phase but warmup/freeze) holds a real roster slot but has NO BODY until
  //    the next beginFreeze, and sendSnapshots skips pending players outright —
  //    so state().players (the snapshot headcount) does not move for up to a
  //    full round, while state().rosterSize (fed by the player_joined event)
  //    moves at once. (24) leaves this room LIVE — under the old auto-start it
  //    happened to be sampled in a lobby/freeze window where the two agreed —
  //    so waiting on `players` here was a 5s timeout by construction. Both are
  //    reported; the assertion is on the seats the command actually created.
  let conOk = false;
  let conDetail = '';
  try {
    if (C === null) throw new Error('page C unavailable (24 failed at launch)');
    if ((await fpsState(C)).roomId === null) {
      await C.evaluate(() => window.__fps.createPrivate('Carol', 'crossfire'));
      await waitFor(async () => {
        const s = await fpsState(C);
        return s !== null && s.roomId !== null ? s : null;
      }, 10000, 'C re-join for the console check');
    }
    const before25 = await fpsState(C);
    const nonsense = await C.evaluate(() => window.__fps.debug.console('nonsense'));
    await C.evaluate(() => window.__fps.debug.console('addbot 2'));
    const populated25 = await waitFor(async () => {
      const s = await fpsState(C);
      return s !== null && s.rosterSize === before25.rosterSize + 2 ? s : null;
    }, 5000, 'rosterSize +2 after console addbot 2');
    conOk = typeof nonsense === 'string' && nonsense.trim() !== '';
    conDetail =
      `nonsense -> ${JSON.stringify(nonsense)}; seats ${before25.rosterSize} -> ${populated25.rosterSize}` +
      ` (phase=${populated25.phase}, snapshot players ${before25.players} -> ${populated25.players})`;
  } catch (err) {
    conDetail = err instanceof Error ? err.message : String(err);
  }
  check('console: addbot 2 adds 2 players; unknown command returns an error string', conOk, conDetail);

  // -- (26)/(27) shared setup: C takes a FRESH private crossfire room (the
  //    (11) prevRoom pattern; the (24)/(25) room's 3 older bots would muddy
  //    the per-bot roster assertions) and adds exactly 2 bots. The two add_bot
  //    frames + the kill_bots one go out in ONE evaluate: ws delivery is FIFO
  //    and the room handles C2S on receipt (game.ts handleMessage), so both
  //    bots exist before kill_bots runs, and the room is still in warmup at
  //    that instant (it stays there — nothing but a START press leaves the
  //    lobby) — the bots' first deaths take the warmup death path. C then
  //    presses START, and the round-1 beginFreeze revives them.
  let gearOk = false;
  let gearDetail = '';
  let botsOk = false;
  let botsDetail = '';
  try {
    if (C === null) throw new Error('page C unavailable (24 failed at launch)');
    const prevRoom27 = (await fpsState(C)).roomId;
    await C.evaluate(() => window.__fps.createPrivate('Carol', 'crossfire'));
    await waitFor(async () => {
      const s = await fpsState(C);
      return s !== null && s.roomId !== null && s.roomId !== prevRoom27 && s.players === 1 ? s : null;
    }, 15000, 'C solo in a fresh private crossfire room');
    await C.evaluate(() => {
      window.__fps.addBot();
      window.__fps.addBot();
      window.__fps.debug.console('killbots'); // (27) first wave — see below
    });

    // -- (26) kevlar: the round-1 freeze (which only exists once START is
    //    pressed — 3 seats make the press legal, dead bots included) has
    //    ECONOMY.start (800) >= kevlarPrice (650) — no round needs
    //    to complete. Freeze-only window: C is guaranteed alive there (in
    //    live the bots can frag C, and the dead cannot buy). armor rides the
    //    e2e state() surface (main.ts mirrors YouSnap.armor, set server-side
    //    per the contract's armor rules). If the round-1 freeze is somehow
    //    missed (a >3s stall), the next freeze is one bot-paced round out —
    //    hence the (24)-style wide timeout.
    await waitFor(async () => {
      const s = await fpsState(C);
      return s !== null && s.players === 3 ? s : null;
    }, 10000, 'both bots seated on C (3 seats)');
    await startMatchOn(C, 'C + 2 bots (kevlar/killbots room)', 20000);
    await waitFor(async () => {
      const s = await fpsState(C);
      if (s !== null && s.phase === 'warmup') await nudgeStart(C); // match ended -> lobby again
      return s !== null && s.phase === 'freeze' && s.money >= 650 ? s : null;
    }, 120000, 'freeze with money >= 650 for the kevlar buy');
    const money26 = (await fpsState(C)).money;
    await C.evaluate(() => window.__fps.debug.console('buy kevlar'));
    const armored = await waitFor(async () => {
      const s = await fpsState(C);
      return s !== null && s.armor === 100 ? s : null;
    }, 5000, 'armor === 100 within 5s of console buy kevlar');
    gearOk = true;
    gearDetail = `$${money26} -> $${armored.money}, armor=${armored.armor} (phase=${armored.phase})`;
  } catch (err) {
    gearDetail = err instanceof Error ? err.message : String(err);
  }
  check("kevlar: console 'buy kevlar' in a freeze/buy window sets armor to 100", gearOk, gearDetail);

  // -- (27) killbots: both bots die IN PLACE (kill event with killerId null)
  //    yet keep their roster slots — players/rosterSize stay 3, unlike
  //    removeBot. Observable: the roster K/D is tracked client-side per kill
  //    event, so the scoreboard D column IS the roster-entry view (read off
  //    the DOM like (22), re-rendered before every read). REVIVE/HP PROOF BY
  //    PROXY: no client surface carries a REMOTE player's hp or alive flag
  //    (YouSnap is self-only; RosterEntry has none), and a 3-player room can
  //    never sit in warmup for the 2s warmup respawn timer (the match starts
  //    one tick after the second bot joins — the revive actually lands via
  //    beginFreeze's placeAtSpawn, the same full-hp path the timer uses). So
  //    'hp resets to 100' is proven structurally: handleKillBots SKIPS
  //    already-dead bots, meaning a second wave that increments deaths again
  //    is only possible after a revive, and placeAtSpawn (the only revive
  //    path) heals to PLAYER.maxHp.
  try {
    if (C === null) throw new Error('page C unavailable (24 failed at launch)');
    // bot rows off the scoreboard DOM: .m9-bot-tag marks them; cells per row
    // are dot, name, K, D, HS, $ (menus.ts buildTeamTable).
    const botDeaths = async () => {
      await C.evaluate(() => window.__fps.debug.scoreboard(true)); // one-shot render — re-issue per read
      return C.evaluate(() => {
        const out = [];
        for (const row of document.querySelectorAll('.fps-menus .m9-layer-score .m9-row')) {
          if (row.querySelector('.m9-bot-tag') === null) continue; // bot rows only
          const cells = row.querySelectorAll(':scope > span');
          const nameCell = row.querySelector('.m9-c-name');
          out.push({
            name: (nameCell !== null && nameCell.firstChild !== null
              ? nameCell.firstChild.textContent ?? '?'
              : '?').trim(),
            deaths: cells.length >= 4 ? Number(cells[3].textContent) : NaN,
          });
        }
        return out;
      });
    };
    // first wave (the setup burst): both bots dead in place, count unchanged.
    const dead27 = await waitFor(async () => {
      const s = await fpsState(C);
      if (s === null || s.players !== 3 || s.rosterSize !== 3) return null;
      const rows = await botDeaths();
      return rows.length === 2 && rows.every((r) => r.deaths >= 1) ? { s, rows } : null;
    }, 10000, 'both bots dead in place (D >= 1) with players unchanged at 3');
    // second wave: fire killbots whenever the bots may be alive again; dead
    // bots are skipped server-side, so a registering wave proves the revive.
    let revived27 = null;
    const t27 = Date.now();
    while (Date.now() - t27 < 30000 && revived27 === null) {
      await C.evaluate(() => window.__fps.debug.console('killbots'));
      try {
        revived27 = await waitFor(async () => {
          const rows = await botDeaths();
          return rows.length === 2 && rows.every((r) => r.deaths >= 2) ? rows : null;
        }, 4000, 'second kill wave (D >= 2) — proves the bots revived at full hp');
      } catch {
        // bots still dead (revive lands at the next beginFreeze) — re-fire
      }
    }
    const still27 = await fpsState(C);
    botsOk = revived27 !== null && still27.players === 3 && still27.rosterSize === 3;
    botsDetail =
      `wave1: ${dead27.rows.map((r) => `${r.name} D${r.deaths}`).join(', ')} players=${dead27.s.players}` +
      (revived27 !== null
        ? `; wave2: ${revived27.map((r) => `${r.name} D${r.deaths}`).join(', ')} (revived — 2nd death impossible while dead), players still ${still27.players}`
        : '; no second kill wave within 30s — bots never revived');
  } catch (err) {
    botsDetail = err instanceof Error ? err.message : String(err);
  }
  if (C !== null) await C.evaluate(() => window.__fps.debug.scoreboard(false)).catch(() => {});
  check('killbots: bots die in place (players unchanged) and revive to full hp', botsOk, botsDetail);

  // -- error-banner DOM check on C (A/B were probed before their early close) --
  if (C !== null) {
    const banner = await C.evaluate(() => document.querySelector('.error-banner')?.textContent ?? null).catch(() => null);
    if (banner) pageErrors.push(`[C] error-banner visible: ${banner}`);
  }
}

// ---- runner ---------------------------------------------------------------------
let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error(`\nE2E ABORTED: ${err instanceof Error ? err.message : String(err)}`);
  check('e2e completed without abort', false);
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  if (serverChild && serverChild.exitCode === null) {
    serverChild.kill('SIGTERM');
    await sleep(400);
    if (serverChild.exitCode === null) serverChild.kill('SIGKILL');
  }

  console.log('\n================ E2E SUMMARY ================');
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
  console.log(exitCode === 0 ? '\nE2E GREEN' : `\nE2E RED (${failed} failed assertions, ${pageErrors.length} page errors)`);
  process.exit(exitCode);
}

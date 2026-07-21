#!/usr/bin/env node
// ============================================================================
// e2e-kart — prove KART GP runs end-to-end in a real (headless) browser.
//
// Builds the whole monorepo first (npm run build must produce
// games/kart/client/dist), spawns the production platform server
// (platform/server/dist), then drives TWO browser instances (separate
// processes: no cross-tab rAF throttling) through the window.__kart debug
// surface (docs/KART.md) against the multi-game static route /kart/:
//   A createPrivate('Alice') -> private-room code; B joinPrivate('Bob', code);
//   both pages see 2 players. With MIN_PLAYERS met the room runs its frozen
//   phase machine — lobby -> ready (5s) -> countdown (3-2-1) -> racing — and
//   every transition is observed on A (the grid shot lands inside the
//   countdown window). Then A drives: setInput(1,0,0,false) until A's
//   streamed position (state().pos — what the client ships to the server at
//   15Hz) has advanced > 10m (polled, capped at 10s — the geared model
//   cruises ~7.7 m/s in gear 1 and a software-rendered client can step its
//   sim slower than wall clock), while B's view of Alice's kart
//   (telemetry().remotes, the interpolated remote) must move too (> 5m over
//   the same window). After that a guidance loop pure-pursues A along the
//   centerline to the expected gate (road-following aim far out, aim 6m past
//   the gate close in, throttle scaled by heading error + bend ahead,
//   reverse-out on a 3s stall) until the server credits progress > 0 (a gate
//   passed within GATE_RADIUS, in order), capped at 90s. Two physics-contract
//   checks close the drive: the steer sign (steer -1 = A must turn LEFT, i.e.
//   yaw INCREASES; steer +1 = D must turn RIGHT, yaw DECREASES — the frozen
//   convention is positive steer = RIGHT) and the automatic gearbox (from a
//   standstill, ~8s of full throttle must reach gear >= 3 and keep climbing
//   past the gear-1 top of 10 m/s).
// Gate positions are recomputed here from the FROZEN track math (closed
// Catmull-Rom over TRACK_POINTS, 256 samples, gate i at t=i/8 — a line-level
// mirror of games/kart/shared/src/track.ts, which the e2e cannot import);
// steer corrections ride telemetry().own {x,z,yaw}.
// The client's debug surface has its own layout (not the wire snapshot):
//   state()     -> {phase ('menu' outside a room), place, lap, nextGate,
//                   progress, pos{x,y,z}, speed, players(count)}
//   telemetry() -> {phase, playerId, own{x,y,z,yaw,...}, remotes:[{id,name,
//                   x,z,yaw,...}], phaseEndsInMs, ...}
// so a join is observed as phase leaving 'menu', remote positions come from
// telemetry().remotes, and the join code falls back to the lobby server log.
// Screenshots: kart-grid.png (countdown on the grid) + kart-race.png
// (mid-drive chase cam).
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
const PORT = Number(process.env.E2E_PORT ?? 8080);
const BASE = `http://localhost:${PORT}`;
const GAME_URL = `${BASE}/kart/`; // the launcher lives at /; the kart client is mounted at /kart/
const SHOTS_DIR = path.join(ROOT, 'screenshots');

// the KART.md debug surface freezes these window.__kart methods
const KART_SURFACE = ['state', 'joinQuick', 'createPublic', 'createPrivate', 'joinPrivate', 'setInput', 'telemetry'];

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

const kartState = (page) =>
  page.evaluate(() => {
    try {
      return window.__kart?.state() ?? null;
    } catch {
      return null;
    }
  });
const kartTelemetry = (page) =>
  page.evaluate(() => {
    try {
      return window.__kart?.telemetry?.() ?? null;
    } catch {
      return null;
    }
  });

// ---- build + server -------------------------------------------------------------
function buildAll() {
  console.log('build: npm run build');
  const r = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`npm run build exited with code ${r.status}`);
  const kartIndex = path.join(ROOT, 'games/kart/client/dist/index.html');
  if (!existsSync(kartIndex)) {
    throw new Error('games/kart/client/dist/index.html missing after build (kart client not wired into npm run build?)');
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
      // /kart/ is the multi-game static route for the kart client dist
      const res = await fetch(GAME_URL, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`server did not serve /kart/ on :${PORT} within ${timeoutMs}ms`);
    await sleep(250);
  }
}

// ---- browser --------------------------------------------------------------------
// WebGL client (three.js): same launch pattern as the fps e2e — the headless
// shell provides webgl2 via SwiftShader when no hardware GL answers, and the
// anti-throttling flags keep the 15Hz snapshot stream + drive loop at rate.
// E2E_VIEWPORT=640x360 cuts the raster load ~4x on machines where software
// rasterization can't keep the client at realtime.
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
// (evaluate returns but rafFired=false or glLost=true), (c) mere slowness
// (everything healthy, shot lands late).
async function probePage(page, label) {
  const evalP = page.evaluate(
    () =>
      new Promise((res) => {
        let st = null;
        let stateErr = null;
        try {
          st = window.__kart ? window.__kart.state() : null;
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
              players: st && typeof st.players === 'number' ? st.players : null,
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
      await probePage(page, `${name} post-fail+7s`);
    } catch (probeErr) {
      console.log(`[diag] ${name}: probe itself failed (${probeErr instanceof Error ? probeErr.message : String(probeErr)})`);
    }
  }
  await page.screenshot({ path: file, timeout: 90000 });
  console.log(`shot  ${name} (retry, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// ---- state accessors (the debug-surface layout documented in the header) ---
/** Joined a room = state().phase left 'menu' (the client is on the race screen). */
function joined(s) {
  return s !== null && typeof s.phase === 'string' && s.phase !== 'menu';
}

/** Own kart position [x,y,z] from state().pos {x,y,z}. */
function statePos(s) {
  const p = s !== null && typeof s === 'object' ? s.pos : null;
  return p !== null &&
    typeof p === 'object' &&
    [p.x, p.y, p.z].every((n) => typeof n === 'number' && Number.isFinite(n))
    ? [p.x, p.y, p.z]
    : null;
}

/**
 * Own race fields (progress/nextGate): flat on state() per the client's
 * debug surface; a nested `you` block is also tolerated.
 */
function ownRaceFields(s) {
  if (s === null || typeof s !== 'object') return { progress: null, nextGate: null };
  const you = s.you !== null && typeof s.you === 'object' ? s.you : s;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return { progress: num(you.progress), nextGate: num(you.nextGate) };
}

/** A remote kart by display name from telemetry().remotes. */
function remoteByName(tele, name) {
  const rs = tele !== null && Array.isArray(tele.remotes) ? tele.remotes : [];
  return rs.find((r) => r !== null && typeof r === 'object' && r.name === name) ?? null;
}

/**
 * telemetry().own pose {x,z,yaw} — the freshest local source for steering
 * (state() carries no yaw). A flat {x,z,yaw} telemetry is also tolerated.
 */
function telePose(t) {
  const o = t !== null && typeof t === 'object' && t.own !== null && typeof t.own === 'object' ? t.own : t;
  if (o === null || typeof o !== 'object') return null;
  const { x, z, yaw } = o;
  if (typeof x !== 'number' || typeof z !== 'number' || typeof yaw !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(yaw)) return null;
  return { x, z, yaw };
}

/** Shortest signed angle from a to b, in (-PI, PI]. */
function wrapPi(a) {
  let w = a % (Math.PI * 2);
  if (w > Math.PI) w -= Math.PI * 2;
  if (w < -Math.PI) w += Math.PI * 2;
  return w;
}

/**
 * The private-room join code. Primary: state().code on the client surface.
 * Fallbacks: the lobby's creation log line, then a 5-char token scraped from
 * the DOM (the room screen displays the code for sharing).
 */
async function getRoomCode(page) {
  const fromState = await page.evaluate(() => {
    const s = window.__kart?.state?.();
    return s && typeof s.code === 'string' && s.code.length > 0 ? s.code : null;
  });
  if (fromState !== null) return fromState;
  const matches = [...serverLog.matchAll(/created \(private, code (\S+), game kart\)/g)];
  const fromLog = matches.length > 0 ? matches[matches.length - 1][1] : null;
  if (fromLog !== null) return fromLog;
  return page.evaluate(() => {
    const m = /\b([A-Z0-9]{5})\b/.exec(document.body.innerText);
    return m !== null ? m[1] : null;
  });
}

// ---- track gates (mirror of the FROZEN games/kart/shared/src/track.ts math) ----
// The e2e cannot import the TS contract, so it recomputes the SAME gate
// positions the server validates against: closed Catmull-Rom over
// TRACK_POINTS, 256 centerline samples, gate i at sample round(i/8 * 256)
// (t = i/8; gate 0 == start/finish at the first control point).
const TRACK_POINTS = [
  [0, -82], [58, -80], [92, -58], [88, -16], [58, 4], [62, 44], [28, 68],
  [-18, 60], [-66, 64], [-92, 38], [-78, 2], [-92, -38], [-58, -68], [-24, -58],
];
const GATE_COUNT = 8; // GATES in @kart/shared config
const TRACK_SAMPLES = 256;

/** Closed Catmull-Rom sample at uniform parameter t in [0,1). */
function catmullPoint(points, t) {
  const n = points.length;
  const f = (((t % 1) + 1) % 1) * n;
  const i = Math.floor(f) % n;
  const u = f - Math.floor(f);
  const p0 = points[(i - 1 + n) % n];
  const p1 = points[i];
  const p2 = points[(i + 1) % n];
  const p3 = points[(i + 2) % n];
  const cr = (a, b, c, d) =>
    0.5 * (2 * b + u * (c - a + u * (2 * a - 5 * b + 4 * c - d + u * (3 * (b - c) + d - a))));
  return [cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])];
}

function computeTrackData() {
  const centerline = [];
  for (let i = 0; i < TRACK_SAMPLES; i++) centerline.push(catmullPoint(TRACK_POINTS, i / TRACK_SAMPLES));
  // per-sample travel yaw (platform convention: forward = (-sin(yaw), -cos(yaw)))
  const travelYaw = [];
  let length = 0;
  for (let i = 0; i < TRACK_SAMPLES; i++) {
    const a = centerline[i];
    const b = centerline[(i + 1) % TRACK_SAMPLES];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    length += Math.hypot(dx, dz);
    travelYaw.push(Math.atan2(-dx, -dz));
  }
  const gates = [];
  for (let g = 0; g < GATE_COUNT; g++) {
    const idx = Math.round((g / GATE_COUNT) * TRACK_SAMPLES) % TRACK_SAMPLES;
    const a = centerline[idx];
    const b = centerline[(idx + 1) % TRACK_SAMPLES];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    gates.push({ x: a[0], z: a[1], tx: dx / l, tz: dz / l });
  }
  const spacing = length / TRACK_SAMPLES;
  return { centerline, travelYaw, gates, length, spacing, lookaheadIdx: Math.max(4, Math.round(18 / spacing)) };
}

/** Nearest centerline sample index (linear scan; 256 samples at 5Hz is cheap). */
function nearestIndex(centerline, x, z) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < centerline.length; i++) {
    const c = centerline[i];
    const d = (c[0] - x) * (c[0] - x) + (c[1] - z) * (c[1] - z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Centerline point ~18m of travel ahead of sample ci (pure-pursuit aim). */
function aheadPoint(track, ci) {
  const p = track.centerline[(ci + track.lookaheadIdx) % track.centerline.length];
  return { x: p[0], z: p[1] };
}

// ---- main ---------------------------------------------------------------------------
async function main() {
  await mkdir(SHOTS_DIR, { recursive: true });
  buildAll();
  startServer();
  await waitForServer();
  console.log(`server up on ${BASE} (kart client at /kart/)`);

  const A = await launchOne('A');
  const B = await launchOne('B');

  // -- load the kart client on both pages ---------------------------------------------
  await A.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(() => A.evaluate(() => !!window.__kart), 15000, '__kart on A');
  check('kart client loads at /kart/ (window.__kart present)', true);
  await B.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(() => B.evaluate(() => !!window.__kart), 15000, '__kart on B');

  const surfaceMissing = await A.evaluate((names) => {
    const k = window.__kart;
    return names.filter((f) => typeof k?.[f] !== 'function');
  }, KART_SURFACE);
  check(
    'window.__kart exposes the frozen debug surface',
    surfaceMissing.length === 0,
    surfaceMissing.length > 0 ? `missing: ${surfaceMissing}` : KART_SURFACE.join('/'),
  );

  // -- private room create + join by code ----------------------------------------------
  await A.evaluate(() => window.__kart.createPrivate('Alice'));
  const aJoined = await waitFor(async () => {
    const s = await kartState(A);
    return joined(s) ? s : null;
  }, 10000, 'A createPrivate join');
  check(
    'A createPrivate joins a kart room (alone => lobby phase)',
    aJoined.phase === 'lobby' && aJoined.players === 1,
    `phase=${aJoined.phase} players=${aJoined.players}`,
  );
  const code = await getRoomCode(A);
  check('private room join code obtained', code !== null, code ?? 'no code from state()/server-log/DOM');

  await B.evaluate((c) => window.__kart.joinPrivate('Bob', c), code);
  await waitFor(async () => {
    const s = await kartState(B);
    return joined(s) ? s : null;
  }, 10000, 'B joinPrivate join');
  const bothSeated = await waitFor(async () => {
    const [sa, sb] = await Promise.all([kartState(A), kartState(B)]);
    return sa !== null && sb !== null && sa.players === 2 && sb.players === 2 ? { sa, sb } : null;
  }, 10000, 'players count === 2 on both pages');
  const [teleA0, teleB0] = await Promise.all([kartTelemetry(A), kartTelemetry(B)]);
  check(
    'B joinPrivate joins — both pages see 2 players',
    true,
    `counts A=${bothSeated.sa.players} B=${bothSeated.sb.players}; ` +
      `remotes A sees [${(teleA0?.remotes ?? []).map((r) => r.name)}] B sees [${(teleB0?.remotes ?? []).map((r) => r.name)}]`,
  );

  // -- phase machine: lobby -> ready (5s) -> countdown (3-2-1) -> racing --------------
  // Poll at 150ms from the moment both are seated (the phases are 5s/3s: no
  // transition is missed) and record every distinct phase. Countdown numbers
  // are not on state(); they are derived from telemetry()'s phase timer for
  // the detail line. The grid shot is taken on the first 'countdown'
  // sighting (karts gridded, number on screen).
  const phasesSeen = []; // [{phase, countdown}] — distinct consecutive samples
  let gridShot = false;
  await waitFor(async () => {
    const [s, tele] = await Promise.all([kartState(A), kartTelemetry(A)]);
    if (!joined(s)) return null;
    const ms = tele !== null && typeof tele.phaseEndsInMs === 'number' ? tele.phaseEndsInMs : null;
    const cd = s.phase === 'countdown' && ms !== null ? Math.min(3, Math.max(1, Math.ceil(ms / 1000))) : null;
    const last = phasesSeen[phasesSeen.length - 1];
    if (last === undefined || last.phase !== s.phase || last.countdown !== cd) {
      phasesSeen.push({ phase: s.phase, countdown: cd });
    }
    if (s.phase === 'countdown' && !gridShot) {
      gridShot = true;
      await shot(A, 'kart-grid.png');
    }
    return s.phase === 'racing' ? s : null;
  }, 30000, "phase 'racing' after ready + countdown");
  if (!gridShot) {
    console.log('countdown window missed — kart-grid.png taken after the fact (phase checks below will fail)');
    await shot(A, 'kart-grid.png');
  }
  const seenOrder = phasesSeen.map((p) => p.phase).filter((p, i, a) => a.indexOf(p) === i);
  const idxReady = seenOrder.indexOf('ready');
  const idxCd = seenOrder.indexOf('countdown');
  const idxRace = seenOrder.indexOf('racing');
  const cdNums = [...new Set(phasesSeen.filter((p) => p.phase === 'countdown' && p.countdown !== null).map((p) => p.countdown))];
  check("'ready' phase observed (5s get-ready)", idxReady !== -1, `sequence: ${seenOrder.join(' -> ')}`);
  check(
    "'countdown' phase observed (3-2-1 before GO)",
    idxCd !== -1,
    cdNums.length > 0 ? `numbers seen: ${cdNums.join(', ')}` : 'phase seen; countdown number not surfaced by state()',
  );
  check(
    "phase reaches 'racing' in order (ready -> countdown -> racing)",
    idxReady !== -1 && idxCd !== -1 && idxRace !== -1 && idxReady < idxCd && idxCd < idxRace,
    `sequence: ${seenOrder.join(' -> ')}`,
  );

  // -- drive: A full throttle; the streamed position must move > 10m ---------
  // Polled instead of a fixed sleep: the geared model cruises at ~7.7 m/s in
  // gear 1 (no fixed 3s window is guaranteed) and a software-rendered headless
  // client can step its sim slower than wall clock (per-frame dt clamp).
  const aPos0 = await waitFor(async () => {
    const s = await kartState(A);
    return statePos(s);
  }, 10000, "A's own kart position in state().pos");
  const bSeesA0 = remoteByName(await kartTelemetry(B), 'Alice');

  await A.evaluate(() => window.__kart.setInput(1, 0, 0, false));
  let aPos1 = null;
  let movedA = 0;
  const driveT0 = Date.now();
  while (Date.now() - driveT0 < 10000) {
    await sleep(500);
    aPos1 = statePos(await kartState(A));
    movedA = aPos1 !== null ? Math.hypot(aPos1[0] - aPos0[0], aPos1[2] - aPos0[2]) : 0;
    if (movedA > 10) break;
  }
  const driveSecs = ((Date.now() - driveT0) / 1000).toFixed(1);

  const bSeesA1 = remoteByName(await kartTelemetry(B), 'Alice');
  check(
    'A drives: setInput(1,0,0,false) moves the streamed kart > 10m (polled, up to 10s)',
    aPos1 !== null && movedA > 10,
    `moved ${movedA.toFixed(1)}m in ~${driveSecs}s (${aPos0.map((v) => v.toFixed(1))} -> ${aPos1?.map((v) => v.toFixed(1))})`,
  );
  const movedB = bSeesA0 !== null && bSeesA1 !== null ? Math.hypot(bSeesA1.x - bSeesA0.x, bSeesA1.z - bSeesA0.z) : 0;
  check(
    "B observes A's remote kart moving (> 5m over the same drive)",
    bSeesA0 !== null && bSeesA1 !== null && movedB > 5,
    `moved ${movedB.toFixed(1)}m on B's interpolated view of Alice`,
  );

  // mid-drive chase cam (A still at full throttle)
  await shot(A, 'kart-race.png');

  // -- guided driving: follow the road to the expected gate until the server ---
  // credits progress. Pure pursuit with two aim modes: far from the gate the
  // aim rides the centerline ~18m ahead of the kart's nearest sample (bends
  // are taken on the corridor, not across the inside wall); within 25m of the
  // gate the aim jumps 6m PAST the gate along its tangent (the kart crosses
  // the gate circle instead of slowing into its rim). Throttle scales with
  // the heading error and the bend angle ahead (the lock widens at low speed,
  // so slowing rotates faster). A 3s stall (< 1m moved) triggers a
  // reverse-out + re-aim (reverse flips the steer response in the bicycle
  // model). Steer sign per the frozen contract: positive steer = RIGHT (yaw
  // decreases), so the proportional term is -k*diff — diff > 0 means the aim
  // is to the LEFT (yaw must increase). The drive pose comes from
  // telemetry().own; progress/nextGate from state().
  const track = computeTrackData();
  const gates = track.gates;
  const BUDGET_MS = 90000;
  let localTarget = 1;
  let progressSeen = null;
  let lastLog = 0;
  const trail = []; // [{t,x,z}] — stall detection window
  let recoverPhase = 0; // 0 none, 1 reversing, 2 driving back out
  let recoverUntil = 0;
  const guideT0 = Date.now();
  while (Date.now() - guideT0 < BUDGET_MS) {
    const [s, tele] = await Promise.all([kartState(A), kartTelemetry(A)]);
    if (s !== null && s.phase === 'racing') {
      const fields = ownRaceFields(s);
      if (fields.progress !== null && fields.progress > 0) {
        progressSeen = fields.progress;
        break;
      }
      const pose = telePose(tele);
      const sp = statePos(s);
      const px = pose !== null ? pose.x : sp !== null ? sp[0] : null;
      const pz = pose !== null ? pose.z : sp !== null ? sp[2] : null;
      const pyaw = pose !== null ? pose.yaw : null; // state() carries no yaw
      const speed = tele !== null && tele.own !== null && typeof tele.own === 'object' ? tele.own.speedMps : null;
      if (px !== null && pz !== null && pyaw !== null) {
        const now = Date.now();
        trail.push({ t: now, x: px, z: pz });
        while (trail.length > 0 && now - trail[0].t > 3200) trail.shift();
        const stalled =
          recoverPhase === 0 &&
          trail.length > 1 &&
          now - trail[0].t >= 3000 &&
          Math.hypot(px - trail[0].x, pz - trail[0].z) < 1;
        if (stalled) {
          console.log(`guide t=${((now - guideT0) / 1000).toFixed(0)}s STALLED at (${px.toFixed(1)},${pz.toFixed(1)}) — reverse-out`);
          recoverPhase = 1;
          recoverUntil = now + 1300;
          trail.length = 0;
        }
        let target = fields.nextGate !== null && fields.nextGate >= 0 && fields.nextGate < gates.length ? fields.nextGate : null;
        if (target === null) {
          const g = gates[localTarget];
          if (Math.hypot(g.x - px, g.z - pz) < 10) localTarget = (localTarget + 1) % gates.length;
          target = localTarget;
        }
        const g = gates[target];
        const dist = Math.hypot(g.x - px, g.z - pz);
        const ci = nearestIndex(track.centerline, px, pz);
        let inp; // [throttle, brake, steer]
        let mode;
        if (recoverPhase === 1) {
          // reverse out of the wedge, rotating the yaw TOWARD the road aim.
          // Backing up flips the steer response: with positive steer = RIGHT
          // when driving forward, in reverse positive steer swings the nose
          // LEFT (yaw increases) — so diff >= 0 (aim left) wants +1 here.
          const aim = aheadPoint(track, ci);
          const diff = wrapPi(Math.atan2(-(aim.x - px), -(aim.z - pz)) - pyaw);
          inp = [0, 1, diff >= 0 ? 1 : -1];
          mode = 'reverse';
          if (now >= recoverUntil) {
            recoverPhase = 2;
            recoverUntil = now + 1500;
          }
        } else if (recoverPhase === 2) {
          // drive back out under full control, then resume the pursuit
          const aim = aheadPoint(track, ci);
          const diff = wrapPi(Math.atan2(-(aim.x - px), -(aim.z - pz)) - pyaw);
          inp = [0.7, 0, Math.max(-1, Math.min(1, -diff * 2.2))];
          mode = 'recover';
          if (now >= recoverUntil) recoverPhase = 0;
        } else {
          const aim = dist < 25 ? { x: g.x + g.tx * 6, z: g.z + g.tz * 6 } : aheadPoint(track, ci);
          const diff = wrapPi(Math.atan2(-(aim.x - px), -(aim.z - pz)) - pyaw);
          const bend = Math.abs(wrapPi(track.travelYaw[(ci + track.lookaheadIdx) % TRACK_SAMPLES] - track.travelYaw[ci]));
          inp = [
            Math.max(0.35, Math.min(1, 1 - Math.abs(diff) * 0.6 - bend * 0.25)),
            0,
            Math.max(-1, Math.min(1, -diff * 2.2)),
          ];
          mode = dist < 25 ? 'gate' : 'road';
        }
        await A.evaluate((th, br, st2) => window.__kart.setInput(th, br, st2, false), inp[0], inp[1], inp[2]);
        if (now - lastLog > 2000) {
          lastLog = now;
          console.log(
            `guide t=${((now - guideT0) / 1000).toFixed(0)}s mode=${mode} gate=${target} dist=${dist.toFixed(1)} ` +
              `pos=(${px.toFixed(1)},${pz.toFixed(1)}) spd=${typeof speed === 'number' ? speed.toFixed(1) : '?'} ` +
              `steer=${inp[2].toFixed(2)} thr=${inp[0].toFixed(2)} progress=${fields.progress ?? '?'} nextGate=${fields.nextGate ?? '?'}`,
          );
        }
      }
    }
    await sleep(200);
  }
  await A.evaluate(() => window.__kart.setInput(0, 0, 0, false)); // park A for the tail
  check(
    'guided driving: server credits progress > 0 (expected gate passed in order)',
    progressSeen !== null && progressSeen > 0,
    progressSeen !== null ? `progress=${progressSeen}` : 'no gate credit within 60s of guided driving',
  );

  // -- A/D direction: the frozen steer sign (positive steer = RIGHT = yaw -----
  // decreases). Setup is deterministic: R-respawn puts the kart on the last
  // credited gate (standstill on the centerline, facing along travel) — the
  // post-guided kart is at 15+ m/s in an unknown spot, and at geared-model
  // speeds a 1s full-lock turn carries it into the barrier (a nose-in kart
  // wedges: zero speed => zero yaw rate). Launch to ~9 m/s, then steer each
  // way for 0.7s at feathered throttle. Deltas are wrapPi'd so a heading
  // crossing ±PI still reads right.
  await A.keyboard.press('KeyR'); // client respawn (drive.ts onKeyDown)
  await sleep(400);
  await A.evaluate(() => window.__kart.setInput(1, 0, 0, false));
  let adEntry = null;
  try {
    adEntry = await waitFor(async () => {
      const t = await kartTelemetry(A);
      const sp = t !== null && t.own !== null && typeof t.own === 'object' ? t.own.speedMps : null;
      return typeof sp === 'number' && sp >= 9 ? sp : null;
    }, 5000, 'A reaches 9 m/s after respawn');
  } catch {
    console.log('A/D: 9 m/s entry not reached in 5s — measuring anyway');
  }
  const adYaw0 = telePose(await kartTelemetry(A))?.yaw ?? null;
  await A.evaluate(() => window.__kart.setInput(0.4, 0, -1, false)); // A — expect LEFT
  await sleep(700);
  const adYaw1 = telePose(await kartTelemetry(A))?.yaw ?? null;
  await A.evaluate(() => window.__kart.setInput(0.4, 0, 1, false)); // D — expect RIGHT
  await sleep(700);
  const adYaw2 = telePose(await kartTelemetry(A))?.yaw ?? null;
  await A.evaluate(() => window.__kart.setInput(0, 0, 0, false));
  const dLeft = adYaw0 !== null && adYaw1 !== null ? wrapPi(adYaw1 - adYaw0) : null;
  const dRight = adYaw1 !== null && adYaw2 !== null ? wrapPi(adYaw2 - adYaw1) : null;
  check(
    'A/D direction: steer -1 turns LEFT (yaw increases), steer +1 turns RIGHT (yaw decreases)',
    dLeft !== null && dLeft > 0.15 && dRight !== null && dRight < -0.15,
    `dLeft=${dLeft !== null ? `${dLeft.toFixed(2)} rad` : '?'} dRight=${dRight !== null ? `${dRight.toFixed(2)} rad` : '?'} ` +
      `(entry ${typeof adEntry === 'number' ? `${adEntry.toFixed(1)} m/s` : '?'})`,
  );

  // -- gears: the automatic 5-speed box. From a standstill, ~8s of full -------
  // throttle must upshift through the box (each upshift fires exactly at the
  // gear top, with a 0.35s engine cut): gear >= 3 seen at least once AND speed
  // still climbing past the gear-1 top (10 m/s). Setup: R-respawn again —
  // standstill on the centerline (the A/D run can end anywhere). The launch
  // steers: full throttle with centerline pure-pursuit, because the box climbs
  // through the bend past the gate and grass/a wall would end the climb early.
  // Gear is read from telemetry().own.gear, then state().gear; if neither
  // surface exposes it the gear is derived from the speed band — sound on a
  // monotonic climb (upshifts fire exactly at each gear top).
  const GEAR_TOPS = [10, 16, 22, 27, 30]; // GEARS tops in @kart/shared config
  await A.keyboard.press('KeyR');
  await sleep(400);
  try {
    await waitFor(async () => {
      const t = await kartTelemetry(A);
      const pose = telePose(t);
      const sp = t !== null && t.own !== null && typeof t.own === 'object' ? t.own.speedMps : null;
      if (pose === null || typeof sp !== 'number' || Math.abs(sp) >= 0.3) return null;
      const ci = nearestIndex(track.centerline, pose.x, pose.z);
      const c = track.centerline[ci];
      return Math.hypot(c[0] - pose.x, c[1] - pose.z) < 4 ? sp : null;
    }, 3000, 'A respawned to the gate anchor (standstill, on road)');
  } catch {
    console.log('gears: respawn verify failed (not standstill/on-road in 3s) — launching anyway');
  }
  await A.evaluate(() => window.__kart.setInput(1, 0, 0, false));
  let maxGear = 1;
  let gearSrc = 'none';
  let maxSpeed = 0;
  const gearT0 = Date.now();
  let lastGearLog = 0;
  while (Date.now() - gearT0 < 8000) {
    const [s, t] = await Promise.all([kartState(A), kartTelemetry(A)]);
    const ownSp = t !== null && t.own !== null && typeof t.own === 'object' ? t.own.speedMps : null;
    const stSp = s !== null && typeof s.speed === 'number' ? s.speed : null;
    const sp = typeof ownSp === 'number' ? Math.abs(ownSp) : typeof stSp === 'number' ? Math.abs(stSp) : null;
    const ownGear = t !== null && t.own !== null && typeof t.own === 'object' ? t.own.gear : null;
    const stGear = s !== null && typeof s.gear === 'number' ? s.gear : null;
    let g = null;
    if (typeof ownGear === 'number' && Number.isFinite(ownGear)) {
      g = ownGear;
      gearSrc = 'telemetry';
    } else if (typeof stGear === 'number' && Number.isFinite(stGear)) {
      g = stGear;
      gearSrc = 'state';
    } else if (sp !== null) {
      g = Math.min(GEAR_TOPS.length, 1 + GEAR_TOPS.filter((top) => sp >= top).length);
      gearSrc = 'speed-band';
    }
    if (sp !== null) maxSpeed = Math.max(maxSpeed, sp);
    if (g !== null) maxGear = Math.max(maxGear, g);
    // full throttle always; steer pure-pursuit at the centerline ~18m out so
    // the climb survives the bend past the gate (positive steer = RIGHT).
    const pose = telePose(t);
    if (pose !== null) {
      const ci = nearestIndex(track.centerline, pose.x, pose.z);
      const aim = aheadPoint(track, ci);
      const diff = wrapPi(Math.atan2(-(aim.x - pose.x), -(aim.z - pose.z)) - pose.yaw);
      await A.evaluate((st2) => window.__kart.setInput(1, 0, st2, false), Math.max(-1, Math.min(1, -diff * 2.2)));
    }
    const now = Date.now();
    if (now - lastGearLog >= 1000) {
      lastGearLog = now;
      // diag: why a frozen kart is frozen — phase (sim gates on the race
      // screen), the latched debug input (resetRoom clears it), and the pose.
      const own = t !== null && t.own !== null && typeof t.own === 'object' ? t.own : null;
      const inp = t !== null && t.input !== null && typeof t.input === 'object' ? t.input : null;
      console.log(
        `gears t=${((now - gearT0) / 1000).toFixed(1)}s phase=${s !== null ? s.phase : '?'} ` +
          `pos=(${own !== null && typeof own.x === 'number' ? own.x.toFixed(1) : '?'},${own !== null && typeof own.z === 'number' ? own.z.toFixed(1) : '?'}) ` +
          `spd=${sp !== null ? sp.toFixed(1) : '?'} gear=${g ?? '?'} ` +
          `input=${inp !== null ? `thr=${inp.throttle} brk=${inp.brake} str=${inp.steer} drift=${inp.drift}` : '?'}`,
      );
    }
    await sleep(100);
  }
  await A.evaluate(() => window.__kart.setInput(0, 0, 0, false));
  const gearsOk = maxGear >= 3 && maxSpeed > 10;
  if (!gearsOk) {
    // dump the room/server side of the story: race end/timeout/restart or a
    // dropped session lands here right when the kart freezes
    const tail = serverLog.trim().split('\n').slice(-15);
    console.log(`gears FAILED — last ${tail.length} server log lines:`);
    for (const line of tail) console.log(`  [server-log] ${line}`);
  }
  check(
    'gears: full throttle from standstill reaches gear >= 3 and climbs past gear-1 top (10 m/s)',
    gearsOk,
    `maxGear=${maxGear} (${gearSrc}) maxSpeed=${maxSpeed.toFixed(1)} m/s over ~8s`,
  );

  // -- error surface --------------------------------------------------------------------------
  check('zero console/page/network errors on both pages', pageErrors.length === 0, `${pageErrors.length}`);
}

// ---- runner ---------------------------------------------------------------------------
let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error(`\nE2E-KART ABORTED: ${err instanceof Error ? err.message : String(err)}`);
  check('e2e-kart completed without abort', false);
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  if (serverChild && serverChild.exitCode === null) {
    serverChild.kill('SIGTERM');
    await sleep(400);
    if (serverChild.exitCode === null) serverChild.kill('SIGKILL');
  }

  console.log('\n================ E2E-KART SUMMARY ================');
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
  console.log(exitCode === 0 ? '\nE2E-KART GREEN' : `\nE2E-KART RED (${failed} failed assertions, ${pageErrors.length} page errors)`);
  process.exit(exitCode);
}

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
//   cruises ~12 m/s in gear 1 and a software-rendered client can step its
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
//   standstill, ~8 sim-s of full throttle must reach gear >= 3 and keep
//   climbing past the gear-1 top of 12 m/s). Two frozen-rule checks bracket
//   the drive:
//   the PRE-GO FREEZE (full throttle latched through the ready+countdown poll
//   must move A < 1m — the client sim does not step and the server ignores
//   pre-GO positions) and NITRO (3 charges per race, refilled at GO: KeyN
//   spends a charge server-side — state() nitroLeft goes 3->2->1->0 and a 4th
//   press is ignored — while the client applies +NITRO_BOOST for NITRO_TIME,
//   proven by an A/B pair of full-throttle launches from the same respawn
//   anchor over the same 2.5 SIM-second window, boosted vs no-boost top speed
//   at the same throttle). The physics tail adds: B's state() gapAheadMs > 0
//   with A a gate up (gap HUD; 0 is leader-only), a ~20 SIM-s centerline
//   pursuit sampling the gearbox at 2Hz (the retuned DOWNSHIFT_HYST must show
//   no (g,g-1,g) oscillation x3+), and the same run must top >= 28 m/s on a
//   straight (TOP_SPEED 36, floored for the headless sim rate).
// SIM TIME: the headless frame loop clamps render dt at 0.05s, so below
// ~20fps (SwiftShader + the AAA scene) the kart sim runs slower than wall
// clock at fps×0.05 sim-s per wall-s. Every speed/timing-sensitive window
// below is therefore measured in kart-sim seconds via telemetry().seq (the
// 15Hz packet clock only advances by stepped sim time — see teleSimS), and a
// launch-curve sim-rate probe is logged in the 'A drives' section.
// Two checks run in a PUBLIC room BEFORE the private-room flow: A createPublic
// and B joins it by roomId — the id is read from the lobby's creation log
// (the frozen debug surface exposes no roomId) and B joins through the menu
// room-row click, the client's only join_public sender (row -> joinPublic(
// menuName(), room.id) with the wire RoomInfo.id) — both pages then assert 2
// players. With MIN_PLAYERS met that room races too, so KIDS MODE rides it:
// assist toggled on via KeyT (verified on state().assist), then throttle ONLY
// — setInput(1,0,0) with the steer argument locked at 0 and never touched —
// while the client's pure-pursuit auto-steer must steer itself around gate 1
// (server-credited progress > 0) within 60s. Two kids-mode hardening checks
// follow in the same room: STUCK AUTO-RESPAWN (the kart is pinned nose-first
// into a barrier with the assist OFF — the guard is assist-only — then the
// assist is re-enabled while pinned: within ~8 sim-s the client must auto-
// respawn to a gate, proven by a > 15m teleport between poll samples landing
// within ~GATE_RADIUS of a gate with the speed reset) and WRONG-WAY RECOVERY
// (spun ~180° by a forward full-lock circle from the anchor, throttle-only
// with the assist on must return the facing to within ~30° of the track
// travel direction — the best of the nearest gate tangent and the exact
// centerline tangent — within ~10 sim-s and grow the server-credited
// progress). Both pages then reload into
// fresh menu clients for the private-room flow above (the client has no
// leave-room debug hook; the assist toggle persists to localStorage, so it
// is verified OFF before the reload).
// Gate positions are recomputed here from the FROZEN track math (closed
// Catmull-Rom over TRACK_POINTS, 256 samples, gate i at t=i/8 — a line-level
// mirror of games/kart/shared/src/track.ts, which the e2e cannot import);
// steer corrections ride telemetry().own {x,z,yaw}.
// The client's debug surface has its own layout (not the wire snapshot):
//   state()     -> {phase ('menu' outside a room), place, lap, nextGate,
//                   progress, pos{x,y,z}, speed, players(count), nitroLeft
//                   (server-authoritative charges), gapAheadMs (ms behind the
//                   kart one place ahead, 0 for the leader; a nested `you`
//                   block is also tolerated), assist (KIDS MODE auto-steer)}
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
    ? { width: 640, height: 360 } // the AAA scene starves SwiftShader; 640x360 doubles the sim rate
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

/**
 * Server-authoritative nitro charges left (you.nitroLeft on the wire): flat
 * on state() per the client's debug surface; a nested `you` block is also
 * tolerated. NOTE: this is the CHARGE count (3 at GO), not the client sim's
 * boost-seconds field of the same name on telemetry().own.
 */
function ownNitroLeft(s) {
  if (s === null || typeof s !== 'object') return null;
  const you = s.you !== null && typeof s.you === 'object' ? s.you : s;
  const n = you.nitroLeft;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Gap to the kart one place ahead (you.gapAheadMs on the wire — ms behind,
 * 0 for the leader; docs/KART.md 'Gap timing'): flat on state() per the
 * client's debug surface; a nested `you` block is also tolerated.
 */
function ownGapAheadMs(s) {
  if (s === null || typeof s !== 'object') return null;
  const you = s.you !== null && typeof s.you === 'object' ? s.you : s;
  const n = you.gapAheadMs;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
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

/**
 * SIM CLOCK (kart-sim seconds): telemetry().seq counts the 15Hz kart_state
 * packets, and the packet clock only advances by STEPPED sim time (drive.ts
 * pktClock += the clamped dt). So Δseq/15 = kart-sim seconds between two
 * reads, regardless of how slowly SwiftShader renders frames — the headless
 * frame loop clamps dt at 0.05s (app.ts MAX_FRAME_DT), so below 20fps the sim
 * runs at fps×0.05 sim-s per wall-s. Wall-clock budgets are meaningless under
 * that starvation; the sensitive windows below are measured in sim seconds
 * (phase 'racing' only — a frozen sim still ticks the packet clock). Returns
 * null when seq is unreadable.
 */
function teleSimS(t) {
  return t !== null && typeof t === 'object' && typeof t.seq === 'number' && Number.isFinite(t.seq) ? t.seq / 15 : null;
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

/**
 * Longest run of consecutive (g, g-1, g) repetitions in a 2Hz gear-sample
 * sequence — the signature of the pre-fix downshift/upshift loop (the box
 * rattled g,g-1,g,g-1,... at every gear top because DOWNSHIFT_HYST was
 * narrower than the speed a shift cut costs). A legit corner downshift
 * re-upshifts ONCE (1 rep); two back-to-back corners give 2. nulls
 * (unreadable ticks) break a run.
 */
function gearOscillationReps(seq) {
  let worst = 0;
  let i = 0;
  while (i + 2 < seq.length) {
    const g = seq[i];
    if (typeof g === 'number' && seq[i + 1] === g - 1 && seq[i + 2] === g) {
      let dips = 1;
      let j = i + 3;
      while (j + 1 < seq.length && seq[j] === g - 1 && seq[j + 1] === g) {
        dips++;
        j += 2;
      }
      worst = Math.max(worst, dips);
      i = j;
    } else {
      i++;
    }
  }
  return worst;
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

  // -- join-by-id: B joins A's PUBLIC room by roomId (join_public) -------------------
  // The frozen debug surface carries neither a roomId nor a joinPublic hook —
  // the client's ONLY join_public sender is the menu room-row click (app.ts:
  // row -> joinPublic(menuName(), room.id) with the wire RoomInfo.id). So the
  // roomId comes from the lobby's creation log line (same fallback family as
  // getRoomCode) and B joins through the real client path: type its menu name,
  // wait for A's room to render in B's menu room list (on the menu the client
  // polls list_rooms every 3s; the server lists PUBLIC rooms only) and click
  // the row — the client ships {t:'join_public', name, roomId} itself.
  await A.evaluate(() => window.__kart.createPublic('Alice'));
  await waitFor(async () => {
    const s = await kartState(A);
    return joined(s) ? s : null;
  }, 10000, 'A createPublic join');
  const pubMatches = [...serverLog.matchAll(/room (\S+) created \(public, game kart\)/g)];
  const publicRoomId = pubMatches.length > 0 ? pubMatches[pubMatches.length - 1][1] : null;
  await B.evaluate(() => {
    const inp = document.querySelector('.menu-name');
    if (inp !== null) inp.value = 'Bob'; // the row click joins as menuName()
  });
  const bRowText = await waitFor(
    () =>
      B.evaluate(() => {
        const row = document.querySelector('.menu-rooms .room-row');
        if (row === null) return null;
        row.click(); // app.ts row handler: joinPublic(menuName(), room.id)
        return row.textContent;
      }),
    15000,
    "A's public room row in B's menu list",
  );
  await waitFor(async () => {
    const s = await kartState(B);
    return joined(s) ? s : null;
  }, 10000, 'B join_public(row) join');
  const pubSeated = await waitFor(async () => {
    const [sa, sb] = await Promise.all([kartState(A), kartState(B)]);
    return sa !== null && sb !== null && sa.players === 2 && sb.players === 2 ? { sa, sb } : null;
  }, 10000, 'public room players === 2 on both pages');
  check(
    "join-by-id: B joins A's PUBLIC room by roomId (join_public) — both pages see 2 players",
    publicRoomId !== null,
    `roomId=${publicRoomId ?? '?'} (lobby log); B clicked row "${bRowText}"; counts A=${pubSeated.sa.players} B=${pubSeated.sb.players}`,
  );

  // -- kids assist (KIDS MODE): throttle only, steer locked at 0 ----------------------
  // docs/KART.md 'Kids mode': with the assist on, the CLIENT pure-pursues the
  // centerline ~10m ahead and OWNS the steer channel (drive.ts) — the kid
  // holds only throttle/brake. The debug surface exposes `assist` as a flag on
  // state()/telemetry(); the in-game toggle is KeyT (race screen only). The
  // public room above met MIN_PLAYERS, so its own phase machine runs to
  // 'racing': flip the assist on (verified), latch setInput(1,0,0) — the
  // steer argument is 0 at latch and NEVER touched again — and give the
  // client up to 60s to steer itself around gate 1 (server-credited
  // progress > 0, exactly the guided loop's proof below but with no steer
  // input at all). The assist is toggled back off before the reload: the
  // toggle persists to localStorage and the fresh client below must come up
  // unassisted (the A/D steer-sign check would read garbage otherwise).
  await waitFor(async () => {
    const s = await kartState(A);
    return s !== null && s.phase === 'racing' ? s : null;
  }, 30000, "public room phase 'racing'");
  const assistBase = ownRaceFields(await kartState(A)).progress;
  await A.keyboard.press('KeyT');
  const assistOn = await waitFor(async () => {
    const s = await kartState(A);
    return s !== null && s.assist === true ? true : null;
  }, 3000, 'state().assist === true after KeyT').catch(() => false);
  await A.evaluate(() => window.__kart.setInput(1, 0, 0, false));
  let assistProgress = null;
  let assistLastLog = 0;
  const assistT0 = Date.now();
  while (Date.now() - assistT0 < 60000) {
    const s = await kartState(A);
    const fields = ownRaceFields(s);
    if (fields.progress !== null && fields.progress > 0) {
      assistProgress = fields.progress;
      break;
    }
    if (Date.now() - assistLastLog >= 5000) {
      assistLastLog = Date.now();
      console.log(
        `assist t=${((Date.now() - assistT0) / 1000).toFixed(0)}s progress=${fields.progress ?? '?'} ` +
          `nextGate=${fields.nextGate ?? '?'} phase=${s !== null ? s.phase : '?'}`,
      );
    }
    await A.evaluate(() => window.__kart.setInput(1, 0, 0, false)); // re-latch throttle-only; steer stays 0
    await sleep(500);
  }
  await A.evaluate(() => window.__kart.setInput(0, 0, 0, false)); // park A before the reload
  await A.keyboard.press('KeyT'); // assist back off (persists to localStorage)
  const assistOff = await waitFor(async () => {
    const s = await kartState(A);
    return s !== null && s.assist === false ? true : null;
  }, 3000, 'state().assist === false after the second KeyT').catch(() => false);
  const assistSecs = ((Date.now() - assistT0) / 1000).toFixed(1);
  check(
    'kids assist (KIDS MODE): throttle-only with steer locked at 0 — the client auto-steer credits gate 1 (progress > 0 within 60s)',
    assistOn === true && assistProgress !== null && assistProgress > 0,
    `assist on=${assistOn} off=${assistOff}; progress ${assistBase ?? '?'} -> ${assistProgress ?? 'none'} in ~${assistSecs}s`,
  );

  // -- kids stuck auto-respawn (KIDS MODE hardening): pinned with assist on -----
  // The assist-only stuck guard (docs/KART.md 'Kids mode'): with KIDS MODE on, a
  // kart held at a standstill under throttle (a kid can wedge it nose-first into
  // a barrier where the pursuit cannot unwind it — zero speed, zero yaw rate) is
  // auto-respawned to the last credited gate with NO R press. The feature is
  // assist-only, so the pin is forced with the assist OFF (it cannot fire early):
  // a verified R-respawn to the anchor gate, 3 SIM seconds of centerline pursuit
  // AWAY from it (so the teleport back is a > 15m jump no standstill kart can
  // fake inside one poll interval), then a SLOW (brake-capped, < 7 m/s) run at a
  // FIXED aim point 30m past the barrier — an aim re-derived per tick or a fast
  // arrival just grinds along the wall — until the position flat-lines (< 1.5m
  // over a 2.5 SIM-second window). Then the assist is re-enabled while pinned and the throttle
  // re-latched: the client must teleport back within ~8 SIM seconds of the
  // confirmed pin (its stuck timer, 2.5 sim-s in drive.ts, runs on stepped sim
  // time — a wall budget over-waits it by 1/sim-rate), land by a gate
  // coordinate (<= GATE_RADIUS + 1m), and show a reset speed (< 10 m/s at the
  // jump sample — gear-1 from rest needs ~1 sim-s for that). Both proofs ride
  // telemetry().own; the sim clock rides telemetry().seq (see teleSimS).
  const kidsTrack = computeTrackData(); // same frozen math — a cheap recompute
  const kidsGates = kidsTrack.gates;

  // Verified R-respawn to the anchor gate (standstill + near the centerline) —
  // the gears section's pattern: one R retry covers a swallowed keypress.
  const kidsRespawn = async () => {
    await A.evaluate(() => window.__kart.setInput(0, 0, 0, false));
    for (let attempt = 0; attempt < 2; attempt++) {
      await A.keyboard.press('KeyR');
      try {
        await waitFor(async () => {
          const t = await kartTelemetry(A);
          const pose = telePose(t);
          const sp = t !== null && t.own !== null && typeof t.own === 'object' ? t.own.speedMps : null;
          if (pose === null || typeof sp !== 'number' || Math.abs(sp) >= 0.5) return null;
          const ci = nearestIndex(kidsTrack.centerline, pose.x, pose.z);
          const c = kidsTrack.centerline[ci];
          return Math.hypot(c[0] - pose.x, c[1] - pose.z) < 8 ? true : null;
        }, 3000, 'A respawned to the anchor gate (standstill, on road)');
        return true;
      } catch {
        // one R retry, then proceed anyway
      }
    }
    return false;
  };

  // Assist toggle with a verified landing (one KeyT retry; the key is
  // race-screen only and a press can be swallowed under load). Returns false if
  // state().assist never reached `want`.
  const kidsAssistTo = async (want) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cur = await kartState(A);
      if (cur !== null && cur.assist === want) return true;
      await A.keyboard.press('KeyT');
      const ok = await waitFor(async () => {
        const s = await kartState(A);
        return s !== null && s.assist === want ? true : null;
      }, 3000, `state().assist === ${want}`).catch(() => false);
      if (ok) return true;
    }
    return false;
  };

  await kidsRespawn();
  // drive AWAY from the anchor under centerline pursuit — 4 SIM seconds from a
  // standstill is ~30-45m (well past the > 8m teleport threshold the watch
  // uses, and far less than the ~75m gate spacing, so no new gate credit).
  // Sim time: a wall window barely moves a starved sim.
  {
    const awaySim0 = teleSimS(await kartTelemetry(A));
    const awayWall0 = Date.now();
    while (Date.now() - awayWall0 < 20000) {
      const t = await kartTelemetry(A);
      const pose = telePose(t);
      const simS = teleSimS(t);
      if (simS !== null && awaySim0 !== null && simS - awaySim0 >= 4) break;
      if (pose !== null) {
        const ci = nearestIndex(kidsTrack.centerline, pose.x, pose.z);
        const aim = aheadPoint(kidsTrack, ci);
        const diff = wrapPi(Math.atan2(-(aim.x - pose.x), -(aim.z - pose.z)) - pose.yaw);
        await A.evaluate((st2) => window.__kart.setInput(1, 0, st2, false), Math.max(-1, Math.min(1, -diff * 2.2)));
      }
      await sleep(150);
    }
  }
  // pin: SLOW pure-pursuit of a FIXED aim 30m past the barrier on the
  // left-of-travel normal (the drive.ts collideBarrier convention), computed
  // ONCE — an aim re-derived per tick curves the chase into a wall-grind, and
  // a fast arrival just slides along the barrier. Braking to < 7 m/s first
  // keeps the speed-sensitive lock wide, so the kart spears the wall near-
  // perpendicular and settles nose-in. The other side is tried after 7 sim-s.
  // Everything is SIM-timed — the stationary window too (a creeping kart at
  // 0.5 sim-m/s covers < 1.5m in 2.5 WALL seconds under starvation and would
  // false-confirm).
  const pinTrail = []; // [{simS,x,z}] — stationary-window detection (sim clock)
  let pinPos = null;
  let pinSimS = null; // sim clock at the confirmed pin (seq-based)
  let pinSide = 1;
  let pinAim = null; // fixed aim point; recomputed only on the side flip
  const pinWall0 = Date.now();
  const pinSim0 = teleSimS(await kartTelemetry(A));
  let pinSideFlipAt = null; // sim clock to flip sides (null = not yet flipping)
  while (Date.now() - pinWall0 < 90000 && pinPos === null) {
    const t = await kartTelemetry(A);
    const pose = telePose(t);
    const sp = t !== null && t.own !== null && typeof t.own === 'object' ? t.own.speedMps : null;
    const simS = teleSimS(t);
    if (simS !== null && pinSim0 !== null && simS - pinSim0 > 15) break; // 15 sim-s and no pin: give up
    if (pose !== null && simS !== null) {
      if (pinAim === null) {
        const ci = nearestIndex(kidsTrack.centerline, pose.x, pose.z);
        const c = kidsTrack.centerline[ci];
        const c2 = kidsTrack.centerline[(ci + 1) % TRACK_SAMPLES];
        const dx = c2[0] - c[0];
        const dz = c2[1] - c[1];
        const l = Math.hypot(dx, dz) || 1;
        pinAim = { x: c[0] + (-dz / l) * pinSide * 30, z: c[1] + (dx / l) * pinSide * 30 };
        pinSideFlipAt = simS + 7; // this wall gets 7 sim-s to pin, then the other one
      }
      const diff = wrapPi(Math.atan2(-(pinAim.x - pose.x), -(pinAim.z - pose.z)) - pose.yaw);
      const slow = typeof sp === 'number' && sp > 7;
      await A.evaluate(
        (th, br, st2) => window.__kart.setInput(th, br, st2, false),
        slow ? 0 : 0.6,
        slow ? 1 : 0,
        Math.max(-1, Math.min(1, -diff * 2.2)),
      );
      pinTrail.push({ simS, x: pose.x, z: pose.z });
      while (pinTrail.length > 0 && simS - pinTrail[0].simS > 2.6) pinTrail.shift();
      if (
        pinTrail.length > 1 &&
        simS - pinTrail[0].simS >= 2.5 &&
        Math.hypot(pose.x - pinTrail[0].x, pose.z - pinTrail[0].z) < 1.5
      ) {
        pinPos = { x: pose.x, z: pose.z };
        pinSimS = simS; // the confirmed pin: the ~8 sim-s auto-respawn budget starts here
      }
      if (pinSideFlipAt !== null && simS >= pinSideFlipAt && pinSide === 1) {
        pinSide = -1; // this wall would not pin — try the other one
        pinAim = null;
        pinTrail.length = 0;
      }
    }
    await sleep(150);
  }
  // assist ON while pinned, throttle re-latched (the pursuit owns the steer):
  // watch for the teleport — a > 15m move between consecutive ~0.3s samples is
  // impossible from a standstill (gear-1 accel needs ~1.4s for that). The ~8s
  // budget is SIM time: the client's stuck timer (2.5 sim-s, drive.ts) runs on
  // stepped sim time, and below 20fps wall clock over-counts it by 1/rate.
  let jumpSimS = null; // sim-s from the confirmed pin to the teleport (null = never)
  let jumpGateD = null; // distance from the landing point to the nearest gate
  let jumpSpeed = null; // |speed| at the jump sample (respawn resets it to 0)
  let stuckAssistOn = false;
  if (pinPos !== null && pinSimS !== null) {
    stuckAssistOn = await kidsAssistTo(true);
    let prev = pinPos;
    const watchStart = Date.now();
    while (Date.now() - watchStart < 60000 && jumpSimS === null) {
      await A.evaluate(() => window.__kart.setInput(1, 0, 0, false));
      const t = await kartTelemetry(A);
      const pose = telePose(t);
      const sp = t !== null && t.own !== null && typeof t.own === 'object' ? t.own.speedMps : null;
      const simS = teleSimS(t);
      if (simS !== null && simS - pinSimS > 10) break; // 10 sim-s and no respawn: dead
      if (pose !== null) {
        // teleport signature: > 8m between consecutive ~0.15s-wall samples.
        // From a standstill even gear-1 accel needs ~1 sim-s for that, and at
        // TOP_SPEED a sample covers ~5m — driving cannot fake it. (The pin is
        // ~25m+ from the anchor gate after the 4 sim-s drive-away, so the
        // respawn jump always clears this.)
        if (Math.hypot(pose.x - prev.x, pose.z - prev.z) > 8) {
          jumpSimS = simS !== null ? simS - pinSimS : null;
          jumpSpeed = typeof sp === 'number' ? Math.abs(sp) : null;
          let best = Infinity;
          for (const g of kidsGates) best = Math.min(best, Math.hypot(g.x - pose.x, g.z - pose.z));
          jumpGateD = best;
        }
        prev = { x: pose.x, z: pose.z };
      }
      await sleep(150);
    }
  }
  await A.evaluate(() => window.__kart.setInput(0, 0, 0, false));
  check(
    'kids stuck auto-respawn: pinned nose-first with KIDS MODE on, the client auto-respawns to a gate within ~8 sim-s (teleport, speed reset)',
    pinPos !== null && stuckAssistOn && jumpSimS !== null && jumpSimS <= 8 && jumpGateD !== null && jumpGateD <= 10 && jumpSpeed !== null && jumpSpeed < 10,
    `pin=${pinPos !== null ? `(${pinPos.x.toFixed(1)},${pinPos.z.toFixed(1)})` : 'never pinned in 15 sim-s'} assist-on=${stuckAssistOn} ` +
      `jump=${jumpSimS !== null ? `${jumpSimS.toFixed(1)} sim-s after pin` : 'none within 10 sim-s'} gateDist=${jumpGateD !== null ? jumpGateD.toFixed(1) : '?'} ` +
      `postSpeed=${jumpSpeed !== null ? jumpSpeed.toFixed(1) : '?'}`,
  );

  // -- kids wrong-way recovery (KIDS MODE hardening): facing + progress --------
  // Spun ~180° off the travel direction, a kid holding only throttle must be
  // brought back by the assist: within ~10 SIM seconds the kart's facing
  // returns to within ~30° of the track travel direction and the server-
  // credited progress eventually increases (the pursuit then drives on to the
  // next gate). Sim time, not wall: the client's wrong-way timer (1.2 sim-s,
  // drive.ts) and the rotation rate both run on stepped sim time, and the
  // headless frame loop starves it below 20fps. The facing is measured two
  // ways and the BEST is taken: yaw vs the NEAREST GATE's tangent (the frozen
  // reference) and yaw vs the centerline tangent at the kart's nearest sample
  // (the exact travel direction — what the client's recovery aligns to,
  // drive.ts assistSteer). The gate tangent alone is an unsound yardstick
  // inside a corner: gate 1's tangent drifts ~28° within 14m of travel
  // (measured on the frozen track math), which would eat the whole 30°
  // window. The spin is done by hand (assist OFF — it would own the steer
  // channel): a SLOW forward full-lock circle from the verified anchor
  // respawn (throttle 0.35 → ~3.5 m/s, lock ~0.5 rad → ~3m radius; the loop
  // fits the 10m road even mid-corner — a faster circle sweeps the barrier
  // at gate 1's bend and wedges), with a sim-timed reverse-out (same
  // rotation direction) if it wedges anyway. Either recovery shape passes:
  // a three-point-turn drive-out restores the facing on the spot, a wrong-
  // way auto-respawn restores it at the anchor.
  await kidsAssistTo(false); // the spin is manual
  await kidsRespawn(); // standstill at the anchor gate, facing along travel
  const wwPose0 = telePose(await kartTelemetry(A));
  const anchorYaw = wwPose0 !== null ? wwPose0.yaw : null;
  let spunDeg = null; // rotation actually reached (deg off the anchor yaw)
  if (anchorYaw !== null) {
    let bestDelta = 0;
    let bestAtSim = null; // sim clock of the last rotation improvement
    let retries = 0;
    const spinSim0 = teleSimS(await kartTelemetry(A));
    const spinWall0 = Date.now();
    // slow forward full-lock circle: at ~3.5 m/s the lock is ~0.5 rad → ~3m
    // radius — the loop fits inside the 10m road even mid-corner (a faster
    // circle's ~4m radius sweeps the barrier at gate 1's bend and wedges)
    await A.evaluate(() => window.__kart.setInput(0.35, 0, -1, false));
    while (Date.now() - spinWall0 < 150000) {
      const t = await kartTelemetry(A);
      const pose = telePose(t);
      const simS = teleSimS(t);
      if (simS !== null && spinSim0 !== null && simS - spinSim0 > 16) break; // 16 sim-s is plenty for ~180°
      if (pose !== null && simS !== null) {
        const d = Math.abs(wrapPi(pose.yaw - anchorYaw));
        if (bestAtSim === null || d > bestDelta + 0.05) {
          bestDelta = Math.max(bestDelta, d);
          bestAtSim = simS;
        }
        if (d >= Math.PI - 0.35) break; // ~160°+ off — squarely wrong-way
        if (simS - bestAtSim > 2.5 && retries < 4) {
          retries++; // wedged mid-circle: reverse out (in reverse +1 swings the nose LEFT too).
          // The pulse is SIM time too — a wall pulse barely moves a starved sim.
          const pulseSim0 = simS;
          await A.evaluate(() => window.__kart.setInput(0, 1, 1, false));
          const pulseWall0 = Date.now();
          while (Date.now() - pulseWall0 < 6000) {
            const ps = teleSimS(await kartTelemetry(A));
            if (ps !== null && ps - pulseSim0 >= 1.2) break;
            await sleep(150);
          }
          await A.evaluate(() => window.__kart.setInput(0.35, 0, -1, false));
          bestAtSim = teleSimS(await kartTelemetry(A)) ?? simS;
        }
      }
      await sleep(120);
    }
    await A.evaluate(() => window.__kart.setInput(0, 1, 0, false)); // brake to a stop (sim pulse)
    const brakeSim0 = teleSimS(await kartTelemetry(A));
    const brakeWall0 = Date.now();
    while (Date.now() - brakeWall0 < 6000) {
      const bs = teleSimS(await kartTelemetry(A));
      if (bs !== null && brakeSim0 !== null && bs - brakeSim0 >= 0.6) break;
      await sleep(150);
    }
    await A.evaluate(() => window.__kart.setInput(0, 0, 0, false));
    spunDeg = (bestDelta * 180) / Math.PI;
  }
  // assist ON, throttle only: facing must come back within ~10 SIM seconds
  // (the client's wrong-way timer, 1.2 sim-s, runs on stepped sim time);
  // progress must eventually increase (cap the whole drive at 35 sim-s)
  const wwBaseline = ownRaceFields(await kartState(A)).progress;
  let wwAssistOn = false;
  let facingSimS = null; // sim-s from assist-on when facing first <= 30° (null = never)
  let facingBestDeg = null; // best min(gate, centerline) reading seen
  let facingBestGateDeg = null; // best gate-tangent-only reading (diagnostics)
  let progressUp = false;
  if (spunDeg !== null && spunDeg >= 150) {
    wwAssistOn = await kidsAssistTo(true);
    const wwSim0 = teleSimS(await kartTelemetry(A));
    const wwWall0 = Date.now();
    while (Date.now() - wwWall0 < 120000 && !(facingSimS !== null && progressUp)) {
      await A.evaluate(() => window.__kart.setInput(1, 0, 0, false)); // throttle only
      const [s, t] = await Promise.all([kartState(A), kartTelemetry(A)]);
      const pose = telePose(t);
      const simS = teleSimS(t);
      if (simS !== null && wwSim0 !== null && simS - wwSim0 > 35) break; // 35 sim-s and not done: dead
      if (pose !== null) {
        let gD = Infinity;
        let gBest = kidsGates[0];
        for (const g of kidsGates) {
          const d = Math.hypot(g.x - pose.x, g.z - pose.z);
          if (d < gD) {
            gD = d;
            gBest = g;
          }
        }
        const gateDeg = (Math.abs(wrapPi(pose.yaw - Math.atan2(-gBest.tx, -gBest.tz))) * 180) / Math.PI;
        const ci = nearestIndex(kidsTrack.centerline, pose.x, pose.z);
        const clDeg = (Math.abs(wrapPi(pose.yaw - kidsTrack.travelYaw[ci])) * 180) / Math.PI;
        const deg = Math.min(gateDeg, clDeg);
        if (facingBestDeg === null || deg < facingBestDeg) facingBestDeg = deg;
        if (facingBestGateDeg === null || gateDeg < facingBestGateDeg) facingBestGateDeg = gateDeg;
        if (facingSimS === null && deg <= 30 && simS !== null && wwSim0 !== null) facingSimS = simS - wwSim0;
      }
      const prog = ownRaceFields(s).progress;
      if (prog !== null && (wwBaseline === null ? prog > 0 : prog > wwBaseline)) progressUp = true;
      await sleep(200);
    }
  }
  await A.evaluate(() => window.__kart.setInput(0, 0, 0, false));
  const wwAssistOff = await kidsAssistTo(false); // MUST be off before the reload (localStorage persists)
  check(
    'kids wrong-way recovery: spun ~180° with KIDS MODE on, throttle-only returns the facing to within ~30° of the track travel direction within ~10 sim-s and progress increases',
    spunDeg !== null && spunDeg >= 150 && wwAssistOn && facingSimS !== null && facingSimS <= 10.5 && progressUp,
    `spun=${spunDeg !== null ? `${spunDeg.toFixed(0)}°` : 'no pose'} assist-on=${wwAssistOn} ` +
      `facing=${facingSimS !== null ? `<=30° at ${facingSimS.toFixed(1)} sim-s` : `never (best min ${facingBestDeg !== null ? facingBestDeg.toFixed(0) : '?'}°, gate-only ${facingBestGateDeg !== null ? facingBestGateDeg.toFixed(0) : '?'}°)`} ` +
      `progress ${wwBaseline ?? '?'} -> ${progressUp ? 'up' : 'flat'}; assist off=${wwAssistOff}`,
  );

  // -- reset: reload both pages into fresh menu clients --------------------------------
  // The public room keeps running server-side (the stale purge + public reap
  // sweep it); the private-room flow below wants fresh menu clients and the
  // client has no leave-room debug hook, so a reload is the clean reset. The
  // menu-buttons-enabled read proves the socket welcomed before the lobby
  // calls (renderMenu disables every menu button until 'welcome').
  await Promise.all([
    A.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }),
    B.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }),
  ]);
  await waitFor(() => A.evaluate(() => !!window.__kart), 15000, '__kart on A after reload');
  await waitFor(() => B.evaluate(() => !!window.__kart), 15000, '__kart on B after reload');
  await waitFor(
    async () => {
      const [wa, wb] = await Promise.all([
        A.evaluate(() => document.querySelector('.menu-actions button:not(:disabled)') !== null),
        B.evaluate(() => document.querySelector('.menu-actions button:not(:disabled)') !== null),
      ]);
      return wa && wb ? true : null;
    },
    10000,
    'both pages welcomed after reload (menu buttons enabled)',
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
  //
  // The PRE-GO FREEZE measurement rides this same loop instead of a serial
  // window: full throttle is latched on the first pre-GO sample and every
  // pre-GO position is tracked until GO. Frozen (docs/KART.md): outside
  // 'racing' the client drive sim does not step (input ignored, velocity
  // zeroed) and the server ignores pre-GO positions. Riding the poll keeps
  // the whole ready+countdown span observable even when slow evaluates
  // compress wall-clock margins — a serial window can land inside the
  // countdown under load and the loop then never sees 'ready'.
  const phasesSeen = []; // [{phase, countdown}] — distinct consecutive samples
  let gridShot = false;
  let freezeLatched = false; // throttle latched on the first pre-GO sample
  let freezePos0 = null; // position at latch
  let freezeMoved = 0; // max displacement from freezePos0 while pre-GO
  let freezeSpanMs = 0; // latch -> last pre-GO sample (needs >= 2s)
  let freezeT0 = 0;
  const freezePhases = new Set(); // phases observed while latched (proof of pre-GO)
  await waitFor(async () => {
    const [s, tele] = await Promise.all([kartState(A), kartTelemetry(A)]);
    if (!joined(s)) return null;
    if (s.phase !== 'racing') {
      freezePhases.add(s.phase);
      if (!freezeLatched) {
        freezeLatched = true;
        freezeT0 = Date.now();
        freezePos0 = statePos(s);
        await A.evaluate(() => window.__kart.setInput(1, 0, 0, false));
      } else {
        const fp = statePos(s);
        freezeSpanMs = Date.now() - freezeT0;
        if (freezePos0 !== null && fp !== null) {
          freezeMoved = Math.max(freezeMoved, Math.hypot(fp[0] - freezePos0[0], fp[2] - freezePos0[2]));
        }
      }
    }
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
  await A.evaluate(() => window.__kart.setInput(0, 0, 0, false)); // unlatch the freeze throttle at GO
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
  check(
    'pre-GO freeze: full throttle latched through ready/countdown moves A < 1m',
    freezeLatched &&
      freezePos0 !== null &&
      freezeSpanMs >= 2000 &&
      freezeMoved < 1 &&
      (freezePhases.has('ready') || freezePhases.has('countdown')),
    `moved ${freezeMoved.toFixed(2)}m over ${(freezeSpanMs / 1000).toFixed(1)}s latched; phases [${[...freezePhases].join(', ')}]`,
  );

  // -- park B off the racing line ------------------------------------------------
  // B sits out the whole private-room tail on its grid slot — which is ON the
  // start/finish straight the top-speed hunt laps at ~28 m/s, and the soft
  // kart-kart repulsion (2*KART_RADIUS band) plus an occasional clip scrubs
  // the peak. B spears right into the barrier ~2.5 sim-s downstream and parks
  // there: ~3m+ off the mid-road pursuit line, outside the repulsion band.
  // The pulse rides B's own packet clock (sim time), then B coasts to a stop.
  await B.evaluate(() => window.__kart.setInput(1, 0, 0.8, false));
  {
    const bSim0 = teleSimS(await kartTelemetry(B));
    const bWall0 = Date.now();
    while (Date.now() - bWall0 < 15000) {
      const bSim = teleSimS(await kartTelemetry(B));
      if (bSim !== null && bSim0 !== null && bSim - bSim0 >= 2.5) break;
      await sleep(200);
    }
  }
  await B.evaluate(() => window.__kart.setInput(0, 0, 0, false));

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
  const launch = []; // [{wallS, simS, speed}] — sim-rate diagnostic series
  while (Date.now() - driveT0 < 15000) {
    await sleep(500);
    const [sDrive, tDrive] = await Promise.all([kartState(A), kartTelemetry(A)]);
    aPos1 = statePos(sDrive);
    movedA = aPos1 !== null ? Math.hypot(aPos1[0] - aPos0[0], aPos1[2] - aPos0[2]) : 0;
    const simS = teleSimS(tDrive);
    const spd = tDrive !== null && tDrive.own !== null && typeof tDrive.own === 'object' ? tDrive.own.speedMps : null;
    if (simS !== null && typeof spd === 'number') launch.push({ wallS: (Date.now() - driveT0) / 1000, simS, speed: spd });
    if (movedA > 10) break;
  }
  // sim-rate diagnostic (logged, never asserted): kart-sim seconds per wall
  // second off the 15Hz packet clock, plus the sampled launch series (sim-s,
  // speed) — the clean reference is the offline stepKart launch (1s:11, 2s:17,
  // 3s:25); the grid launch here also fights B's parked-kart repulsion, so it
  // reads low. The wall-clock windows below only mean something via this rate.
  if (launch.length >= 2) {
    const lf = launch[0];
    const ll = launch[launch.length - 1];
    const rate = ll.wallS > lf.wallS ? (ll.simS - lf.simS) / (ll.wallS - lf.wallS) : null;
    console.log(
      `sim-rate: ${rate !== null ? rate.toFixed(2) : '?'} kart-sim-s/wall-s over ${(ll.wallS - lf.wallS).toFixed(1)}s of full throttle ` +
        `(launch series: ${launch.map((p) => `${p.simS.toFixed(1)}s→${p.speed.toFixed(1)}`).join(' ')} m/s)`,
    );
  }
  const driveSecs = ((Date.now() - driveT0) / 1000).toFixed(1);

  const bSeesA1 = remoteByName(await kartTelemetry(B), 'Alice');
  check(
    'A drives: setInput(1,0,0,false) moves the streamed kart > 10m (polled, up to 15s)',
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

  // -- gap HUD: A is a gate up on B, so B's gapAheadMs must be > 0 -------------
  // Frozen (docs/KART.md 'Gap timing'): you.gapAheadMs estimates the gap to
  // the player one place ahead — gate-timestamp diff when both stamped the
  // same gate sequence, else spatial distance / 20 m/s; 0 for the leader. A
  // has just been credited progress > 0 while B never left the grid, so B
  // trails A. A missing surface fails this one check without aborting the
  // tail (same tolerance as the A/D entry-speed read).
  let gapB = null;
  try {
    gapB = await waitFor(async () => {
      const g = ownGapAheadMs(await kartState(B));
      return g !== null && g > 0 ? g : null;
    }, 5000, "B's state() gapAheadMs > 0 with A a gate up");
  } catch {
    // gapB stays null — reported by the check below
  }
  check(
    "gap HUD: with A a gate up on B, B's state() gapAheadMs > 0 (0 is leader-only)",
    gapB !== null && gapB > 0,
    gapB !== null ? `B gapAheadMs=${gapB}ms` : 'gapAheadMs unavailable on B state() (flat or you.*)',
  );

  // -- A/D direction: the frozen steer sign (positive steer = RIGHT = yaw -----
  // decreases). Setup is deterministic: R-respawn puts the kart on the last
  // credited gate (standstill on the centerline, facing along travel) — the
  // post-guided kart is at 15+ m/s in an unknown spot, and at geared-model
  // speeds a 1s full-lock turn carries it into the barrier (a nose-in kart
  // wedges: zero speed => zero yaw rate). Launch to ~7 m/s, then steer each
  // way at light throttle — cutting the pulse as soon as |Δyaw| hits 0.35 rad
  // (~2.5m of arc at 8 m/s, well clear of the walls). A full 0.7 sim-s pulse
  // carries the kart into gate 1's inside barrier, and the bounce-back makes
  // it REVERSE through the second pulse — where the yaw response flips and
  // the sign reads backwards. Deltas are wrapPi'd so a heading crossing ±PI
  // still reads right.
  await A.keyboard.press('KeyR'); // client respawn (drive.ts onKeyDown)
  await sleep(400);
  await A.evaluate(() => window.__kart.setInput(1, 0, 0, false));
  let adEntry = null;
  try {
    adEntry = await waitFor(async () => {
      const t = await kartTelemetry(A);
      const sp = t !== null && t.own !== null && typeof t.own === 'object' ? t.own.speedMps : null;
      return typeof sp === 'number' && sp >= 7 ? sp : null;
    }, 10000, 'A reaches 7 m/s after respawn');
  } catch {
    console.log('A/D: 7 m/s entry not reached in 10s — measuring anyway');
  }
  // steer at light throttle until |Δyaw| >= 0.35 in the expected direction
  // (0.8 sim-s cap), then return the yaw — the early cut keeps the arc off
  // the barrier, so the measurement is the clean forward-steer response.
  const steerPulse = async (steer, expectSign) => {
    const t0 = await kartTelemetry(A);
    const yaw0 = telePose(t0)?.yaw ?? null;
    const sim0 = teleSimS(t0);
    await A.evaluate((st2) => window.__kart.setInput(0.3, 0, st2, false), steer);
    let yaw = yaw0;
    const wall0 = Date.now();
    while (Date.now() - wall0 < 6000) {
      await sleep(120);
      const t = await kartTelemetry(A);
      const y = telePose(t)?.yaw ?? null;
      const simS = teleSimS(t);
      if (y !== null) yaw = y;
      if (yaw0 !== null && y !== null && wrapPi(y - yaw0) * expectSign >= 0.35) break;
      if (simS !== null && sim0 !== null && simS - sim0 >= 0.8) break;
    }
    return { yaw0, yaw };
  };
  const adL = await steerPulse(-1, 1); // A — expect LEFT (yaw increases)
  const adR = await steerPulse(1, -1); // D — expect RIGHT (yaw decreases)
  await A.evaluate(() => window.__kart.setInput(0, 0, 0, false));
  const dLeft = adL.yaw0 !== null && adL.yaw !== null ? wrapPi(adL.yaw - adL.yaw0) : null;
  const dRight = adL.yaw !== null && adR.yaw !== null ? wrapPi(adR.yaw - adL.yaw) : null;
  check(
    'A/D direction: steer -1 turns LEFT (yaw increases), steer +1 turns RIGHT (yaw decreases)',
    dLeft !== null && dLeft > 0.15 && dRight !== null && dRight < -0.15,
    `dLeft=${dLeft !== null ? `${dLeft.toFixed(2)} rad` : '?'} dRight=${dRight !== null ? `${dRight.toFixed(2)} rad` : '?'} ` +
      `(entry ${typeof adEntry === 'number' ? `${adEntry.toFixed(1)} m/s` : '?'})`,
  );

  // -- gears: the automatic 5-speed box. From a standstill, ~8s of full -------
  // throttle must upshift through the box (each upshift fires exactly at the
  // gear top, with a 0.35s engine cut): gear >= 3 seen at least once AND speed
  // still climbing past the gear-1 top (12 m/s). Setup: R-respawn again —
  // standstill on the centerline (the A/D run can end anywhere). The launch
  // steers: full throttle with centerline pure-pursuit, because the box climbs
  // through the bend past the gate and grass/a wall would end the climb early.
  // Gear is read from telemetry().own.gear, then state().gear; if neither
  // surface exposes it the gear is derived from the speed band — sound on a
  // monotonic climb (upshifts fire exactly at each gear top).
  const GEAR_TOPS = [12, 18, 25, 31, 36]; // GEARS tops in @kart/shared config
  // Verify the respawn landed (standstill + near the road). The dist bound is
  // lenient: this script's recomputed centerline can deviate a few meters from
  // the server's track. One R retry covers a swallowed keypress.
  let respawned = false;
  for (let attempt = 0; attempt < 2 && !respawned; attempt++) {
    await A.keyboard.press('KeyR');
    await sleep(400);
    try {
      await waitFor(async () => {
        const t = await kartTelemetry(A);
        const pose = telePose(t);
        const sp = t !== null && t.own !== null && typeof t.own === 'object' ? t.own.speedMps : null;
        if (pose === null || typeof sp !== 'number' || Math.abs(sp) >= 0.5) return null;
        const ci = nearestIndex(track.centerline, pose.x, pose.z);
        const c = track.centerline[ci];
        // truthy marker, NOT sp: a settled kart reads exactly 0.0, and waitFor
        // accepts with `if (v)` — returning 0.0 would poll forever
        return Math.hypot(c[0] - pose.x, c[1] - pose.z) < 8 ? true : null;
      }, 3000, 'A respawned to the gate anchor (standstill, on road)');
      respawned = true;
    } catch {
      console.log(`gears: respawn verify failed (attempt ${attempt + 1}/2) — ${attempt === 0 ? 'retrying R' : 'launching anyway'}`);
    }
  }
  await A.evaluate(() => window.__kart.setInput(1, 0, 0, false));
  let maxGear = 1;
  let gearSrc = 'none';
  let maxSpeed = 0;
  const gearT0 = Date.now();
  const gearSim0 = teleSimS(await kartTelemetry(A));
  let gearElapsed = 0;
  let lastGearLog = 0;
  // the window is SIM time: the box upshifts on sim speed, so a wall window
  // starves the climb below 20fps (offline reference: gear 3 at ~1.8 sim-s)
  while (Date.now() - gearT0 < 30000 && gearElapsed < 8) {
    const [s, t] = await Promise.all([kartState(A), kartTelemetry(A)]);
    const gSim = teleSimS(t);
    gearElapsed = gSim !== null && gearSim0 !== null ? gSim - gearSim0 : (Date.now() - gearT0) / 1000;
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
        `gears sim-t=${gearElapsed.toFixed(1)}s phase=${s !== null ? s.phase : '?'} ` +
          `pos=(${own !== null && typeof own.x === 'number' ? own.x.toFixed(1) : '?'},${own !== null && typeof own.z === 'number' ? own.z.toFixed(1) : '?'}) ` +
          `spd=${sp !== null ? sp.toFixed(1) : '?'} gear=${g ?? '?'} ` +
          `input=${inp !== null ? `thr=${inp.throttle} brk=${inp.brake} str=${inp.steer} drift=${inp.drift}` : '?'}`,
      );
    }
    await sleep(100);
  }
  await A.evaluate(() => window.__kart.setInput(0, 0, 0, false));
  const gearsOk = maxGear >= 3 && maxSpeed > 12;
  if (!gearsOk) {
    // dump the room/server side of the story: race end/timeout/restart or a
    // dropped session lands here right when the kart freezes
    const tail = serverLog.trim().split('\n').slice(-15);
    console.log(`gears FAILED — last ${tail.length} server log lines:`);
    for (const line of tail) console.log(`  [server-log] ${line}`);
  }
  check(
    'gears: full throttle from standstill reaches gear >= 3 and climbs past gear-1 top (12 m/s)',
    gearsOk,
    `maxGear=${maxGear} (${gearSrc}) maxSpeed=${maxSpeed.toFixed(1)} m/s over ~${gearElapsed.toFixed(1)} sim-s`,
  );

  // -- nitro: 3 charges, a real boost, then empty ---------------------------------
  // Frozen (docs/KART.md): N sends {t:'nitro'}; the server spends one of
  // NITRO_CHARGES (3, refilled at GO), silently ignores a press with none
  // left, and broadcasts the event; the client then boosts +NITRO_BOOST
  // (10 m/s^2) for NITRO_TIME (1.5s) in stepKart. state() nitroLeft is the
  // server-authoritative charge count: 3 -> 2 -> 1 -> 0. The boost is proven
  // by an A/B pair of identical full-throttle launches from the same
  // R-respawn anchor (each respawn verified at a standstill — a swallowed R
  // under load must not hand one run a rolling start; centerline pursuit
  // both runs, same 2.0 SIM-second window — the boost lasts NITRO_TIME sim-s,
  // so a wall-clock window would compare unequal slices under a starved sim;
  // 2.0 sim-s is where the margin PEAKS: the 1.5 sim-s boost has just ended
  // while the no-boost kart hasn't caught up — offline stepKart reference
  // 18.0 vs 25.0 m/s, margin 7.0; it narrows to ~3.6 by 2.5 sim-s): the
  // boosted run's top speed must beat the no-boost top at the same throttle.
  // Charge counts are read between presses while coasting.
  const readNitroLeft = async () => ownNitroLeft(await kartState(A));
  // Last observed charge count, waiting up to timeoutMs for `expected`
  // (0 is a valid reading, so waitFor's truthy test can't return the number).
  const awaitNitroLeft = async (expected, timeoutMs) => {
    let seen = await readNitroLeft();
    try {
      await waitFor(async () => {
        seen = await readNitroLeft();
        return seen === expected ? true : null;
      }, timeoutMs, `nitroLeft === ${expected}`);
    } catch {
      // seen keeps the last observed value for the detail line
    }
    return seen;
  };
  // Full-throttle centerline pursuit for simS of SIM time (the boost lasts
  // NITRO_TIME sim-s; a wall window under a starved sim compares unequal
  // slices of the two runs). Wall-capped as a safety net.
  const launchRun = async (simS) => {
    let top = 0;
    const t0 = Date.now();
    const sim0 = teleSimS(await kartTelemetry(A));
    while (Date.now() - t0 < simS * 4000 + 10000) {
      const t = await kartTelemetry(A);
      const sp = t !== null && t.own !== null && typeof t.own === 'object' ? t.own.speedMps : null;
      if (typeof sp === 'number') top = Math.max(top, sp);
      const simNow = teleSimS(t);
      if (simNow !== null && sim0 !== null && simNow - sim0 >= simS) break;
      const pose = telePose(t);
      if (pose !== null) {
        const ci = nearestIndex(track.centerline, pose.x, pose.z);
        const aim = aheadPoint(track, ci);
        const diff = wrapPi(Math.atan2(-(aim.x - pose.x), -(aim.z - pose.z)) - pose.yaw);
        await A.evaluate((st2) => window.__kart.setInput(1, 0, st2, false), Math.max(-1, Math.min(1, -diff * 2.2)));
      }
      await sleep(100);
    }
    return top;
  };

  // R-respawn to a VERIFIED standstill (parked input first; a swallowed R
  // under load leaves the kart rolling and would give one A/B run a rolling
  // start — the gears section retries R for the same reason).
  const respawnParked = async () => {
    await A.evaluate(() => window.__kart.setInput(0, 0, 0, false));
    for (let attempt = 0; attempt < 2; attempt++) {
      await A.keyboard.press('KeyR');
      try {
        await waitFor(async () => {
          const t = await kartTelemetry(A);
          const sp = t !== null && t.own !== null && typeof t.own === 'object' ? t.own.speedMps : null;
          return typeof sp === 'number' && Math.abs(sp) < 0.5 ? true : null;
        }, 4000, 'A parked at the respawn anchor');
        return;
      } catch {
        if (attempt === 1) console.log('nitro: standstill not confirmed after 2 R presses — launching anyway');
      }
    }
  };

  const nitroStart = await awaitNitroLeft(3, 8000); // charges refilled at GO
  await respawnParked();
  await A.evaluate(() => window.__kart.setInput(1, 0, 0, false));
  const noBoostTop = await launchRun(2.0); // 2.0 SIM seconds — margin peaks here
  await respawnParked(); // same anchor + standstill — the boosted run's twin
  await A.evaluate(() => window.__kart.setInput(1, 0, 0, false));
  await A.keyboard.press('KeyN'); // charge 1: boost from the line
  const boostTop = await launchRun(2.0);
  const nitroAfter1 = await awaitNitroLeft(2, 8000);
  await A.evaluate(() => window.__kart.setInput(0, 0, 0, false)); // coast for the count checks
  await A.keyboard.press('KeyN'); // charge 2
  const nitroAfter2 = await awaitNitroLeft(1, 8000);
  await A.keyboard.press('KeyN'); // charge 3
  const nitroAfter3 = await awaitNitroLeft(0, 8000);
  await A.keyboard.press('KeyN'); // 4th press: no charge left => silently ignored
  await sleep(800);
  const nitroAfter4 = await readNitroLeft();
  check(
    'nitro: charges go 3->2->1->0 (4th press ignored) and the first boost beats the no-boost top speed at full throttle',
    nitroStart === 3 &&
      nitroAfter1 === 2 &&
      nitroAfter2 === 1 &&
      nitroAfter3 === 0 &&
      nitroAfter4 === 0 &&
      boostTop > noBoostTop + 3,
    `charges ${nitroStart} -> ${nitroAfter1} -> ${nitroAfter2} -> ${nitroAfter3}, 4th press -> ${nitroAfter4}; ` +
      `top speed no-boost ${noBoostTop.toFixed(1)} vs boosted ${boostTop.toFixed(1)} m/s (2.0 sim-s full-throttle A/B; offline reference 18.0 vs 25.0)`,
  );

  // -- gear stability + top speed: ~20s of centerline pursuit ------------------
  // The retuned box (GEARS tops 12/18/25/31/36, DOWNSHIFT_HYST 4.5 — wider
  // than the ~3.5 m/s a SHIFT_TIME cut costs at top gears) must NOT oscillate:
  // the old tune looped 3-2-3 at every gear top. Sample the gear at 2Hz over
  // ~20s from a verified standstill and reject any (g, g-1, g) pattern
  // repeating 3+ times consecutively — a legit corner downshift re-upshifts
  // once, never three times in a row at 2Hz. Top speed rides the same run
  // (kept going past the window until it lands, capped): the overdrive 5th
  // pulls toward TOP_SPEED 36, so >= 28 m/s must show on a straight — the
  // headless sim rate makes the full 30+ a wall-clock-dependent ask, so 28
  // is the frozen floor. The drive uses the guided loop's throttle (full on
  // the straights, modulated by heading error + bend ahead into the turns) —
  // raw full throttle spears the barrier on the right-side S-bends and the
  // reverse-out cannot free a kart grinding nose-first along the wall.
  const STAB_WINDOW_SIM_S = 20; // gear-sampling window in SIM seconds
  const TOP_SPEED_FLOOR = 28; // m/s — spec floor: > 30 ideal, >= 28 headless
  const STAB_BUDGET_SIM_S = 45; // sim-s cap for the window + the top-speed hunt
  await respawnParked(); // verified standstill at the last credited gate
  await A.evaluate(() => window.__kart.setInput(1, 0, 0, false));
  const gearSeq = []; // 2Hz gear samples; null = unreadable that tick
  let stabMaxGear = 1;
  let stabTopSpeed = 0;
  let stabRecoverPhase = 0; // 0 none, 1 reversing, 2 driving back out
  let stabRecoverUntil = 0;
  const stabTrail = []; // [{t,x,z}] — stall detection window
  let stabTick = 0;
  let lastStabLog = 0;
  const stabT0 = Date.now();
  const stabSim0 = teleSimS(await kartTelemetry(A));
  let stabSimElapsed = 0; // last observed sim-s since the run start (for the detail line)
  // The budgets are SIM time: reaching 28 m/s needs ~5 clean sim-s on a
  // straight (offline stepKart reference), and the box's oscillation signature
  // lives in sim time — a wall budget starves both below 20fps.
  while (Date.now() - stabT0 < 240000) {
    const now = Date.now();
    const [s, t] = await Promise.all([kartState(A), kartTelemetry(A)]);
    const simNow = teleSimS(t);
    const simElapsed = simNow !== null && stabSim0 !== null ? simNow - stabSim0 : (now - stabT0) / 1000;
    stabSimElapsed = simElapsed;
    if (simElapsed > STAB_BUDGET_SIM_S) break;
    const inWindow = simElapsed <= STAB_WINDOW_SIM_S;
    if (!inWindow && stabTopSpeed >= TOP_SPEED_FLOOR) break; // both proofs in hand
    const own = t !== null && t.own !== null && typeof t.own === 'object' ? t.own : null;
    const ownSp = own !== null && typeof own.speedMps === 'number' ? Math.abs(own.speedMps) : null;
    if (ownSp !== null) stabTopSpeed = Math.max(stabTopSpeed, ownSp);
    if (inWindow && stabTick % 2 === 0) {
      const ownGear = own !== null && typeof own.gear === 'number' && Number.isFinite(own.gear) ? own.gear : null;
      const stGear = s !== null && typeof s.gear === 'number' && Number.isFinite(s.gear) ? s.gear : null;
      let g = ownGear ?? stGear;
      if (g === null && ownSp !== null) {
        g = Math.min(GEAR_TOPS.length, 1 + GEAR_TOPS.filter((top) => ownSp >= top).length);
      }
      gearSeq.push(g);
      if (g !== null) stabMaxGear = Math.max(stabMaxGear, g);
    }
    // centerline pursuit with the guided loop's throttle (full on straights,
    // modulated by heading error + bend ahead into turns) and its reverse-out
    // on a 3s stall (a wedged kart reads gear 1 and would waste the window)
    const pose = telePose(t);
    if (pose !== null) {
      stabTrail.push({ t: now, x: pose.x, z: pose.z });
      while (stabTrail.length > 0 && now - stabTrail[0].t > 3200) stabTrail.shift();
      const stalled =
        stabRecoverPhase === 0 &&
        stabTrail.length > 1 &&
        now - stabTrail[0].t >= 3000 &&
        Math.hypot(pose.x - stabTrail[0].x, pose.z - stabTrail[0].z) < 1;
      if (stalled) {
        console.log(
          `stability sim-t=${simElapsed.toFixed(1)}s STALLED at (${pose.x.toFixed(1)},${pose.z.toFixed(1)}) — reverse-out`,
        );
        stabRecoverPhase = 1;
        stabRecoverUntil = now + 1300;
        stabTrail.length = 0;
      }
      const ci = nearestIndex(track.centerline, pose.x, pose.z);
      const aim = aheadPoint(track, ci);
      const diff = wrapPi(Math.atan2(-(aim.x - pose.x), -(aim.z - pose.z)) - pose.yaw);
      if (stabRecoverPhase === 1) {
        // backing up flips the steer response (see the guided loop)
        await A.evaluate((st2) => window.__kart.setInput(0, 1, st2, false), diff >= 0 ? 1 : -1);
        if (now >= stabRecoverUntil) {
          stabRecoverPhase = 2;
          stabRecoverUntil = now + 1500;
        }
      } else if (stabRecoverPhase === 2) {
        await A.evaluate((st2) => window.__kart.setInput(0.7, 0, st2, false), Math.max(-1, Math.min(1, -diff * 2.2)));
        if (now >= stabRecoverUntil) stabRecoverPhase = 0;
      } else {
        // the guided loop's road-following throttle: full on the straights,
        // backed off for heading error and the bend ahead (grip-capped turns)
        const bend = Math.abs(wrapPi(track.travelYaw[(ci + track.lookaheadIdx) % TRACK_SAMPLES] - track.travelYaw[ci]));
        const thr = Math.max(0.35, Math.min(1, 1 - Math.abs(diff) * 0.6 - bend * 0.25));
        await A.evaluate((th, st2) => window.__kart.setInput(th, 0, st2, false), thr, Math.max(-1, Math.min(1, -diff * 2.2)));
      }
    }
    if (now - lastStabLog >= 2000) {
      lastStabLog = now;
      console.log(
        `stability sim-t=${simElapsed.toFixed(1)}s spd=${ownSp !== null ? ownSp.toFixed(1) : '?'} ` +
          `gear=${gearSeq.length > 0 ? gearSeq[gearSeq.length - 1] : '?'} top=${stabTopSpeed.toFixed(1)}`,
      );
    }
    stabTick++;
    await sleep(250); // steer at 4Hz; the gear is sampled every 2nd tick = 2Hz
  }
  await A.evaluate(() => window.__kart.setInput(0, 0, 0, false));
  const oscReps = gearOscillationReps(gearSeq);
  check(
    'gear stability: ~20 sim-s at 2Hz shows no (g,g-1,g) oscillation x3+ and reaches gear >= 3',
    oscReps < 3 && stabMaxGear >= 3,
    `samples=${gearSeq.length} maxOscReps=${oscReps} maxGear=${stabMaxGear} seq=[${gearSeq.map((g) => (g === null ? '?' : g)).join(',')}]`,
  );
  check(
    `top speed: >= ${TOP_SPEED_FLOOR} m/s observed on a straight (TOP_SPEED 36 floored for headless)`,
    stabTopSpeed >= TOP_SPEED_FLOOR,
    `max observed ${stabTopSpeed.toFixed(1)} m/s over ${stabSimElapsed.toFixed(1)} sim-s of centerline pursuit (budget ${STAB_BUDGET_SIM_S} sim-s)`,
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

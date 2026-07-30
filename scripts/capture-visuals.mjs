#!/usr/bin/env node
// ============================================================================
// capture-visuals — the VISUAL_UPGRADE.md §6 screenshot harness.
//
// Produces the frozen 31-shot list at 1600x900 / deviceScaleFactor 1 into
// screenshots/<version>/ and prints a JSON manifest of {name, game, file} as
// the LAST stdout line so the art-director judge can pair every shot with the
// task that owns it.
//
// Same proven pattern as scripts/e2e.mjs: the production build must already
// exist (npm run build), the platform server is spawned on E2E_PORT, every
// page is driven through the frozen window.__fps / window.__kart / window.__bank
// debug surfaces, and everything is torn down in a finally block.
//
// How each shot is DRIVEN (there is no free camera anywhere — the camera is
// always a real player's camera, so every pose is reached by real gameplay):
//
//   launcher      — GET / (the platform launcher page).
//   fps-<map>-a   — private room on <map>, alone (phase warmup). Map GEOMETRY is
//   fps-<map>-b     loaded into this process (esbuild-bundled from
//   fps-<map>-c     games/fps/shared/src/maps) and 2D-raycast from the player's
//                   authoritative position to pick the three poses:
//                   a = the yaw with the longest free sightline (the main lane),
//                   b = after walking that lane, a wall 2.5-8m out scored by
//                       nearby deco zones (articulated wall + prop cluster),
//                   c = crouched, looking at the theme's sun azimuth at the
//                       rig's golden-hour elevation (SUN_ELEVATION 0.42rad).
//                   If the map bundle cannot be built the harness falls back to
//                   a fixed yaw triple (and says so) rather than skipping.
//   fps-char      — THREE pages in one private room: the two on opposite teams
//                   walk to each other and the third walks to ~8m and aims at
//                   their midpoint, so one CT and one T soldier are in frame
//                   with the camera's own viewmodel. Walking uses the same map
//                   raycaster (steerToward) — a straight line deadlocks on the
//                   mid walls.
//   fps-hud       — same room during 'live' with the buy layer closed.
//   fps-buy       — the buy layer that auto-opens on the freeze snapshot.
//   fps-scoreboard— debug.scoreboard(true) (the Tab edge).
//   kart-grid     — 2 pages, private room, captured in phase 'countdown'.
//   kart-chase    — KIDS MODE assist on (KeyT) + throttle latched: the client
//   kart-hud        auto-steers the circuit. Chase is taken at >16 m/s with a
//   kart-corner     near-zero yaw rate (a straight); hud during a nitro (KeyN);
//                   corner is taken by handing the steer back to setInput with
//                   the handbrake down while the assist is mid-corner.
//   kart-results  — the race must END for the results table to exist: page A
//                   drives its 3 laps (the 2nd page leaves once racing starts,
//                   so A finishing ends the race) and the server's 300s
//                   RACE_TIMEOUT_S backstops it. This wait runs CONCURRENTLY
//                   with the bank + fps captures — the results phase only lasts
//                   RESULTS_SECONDS (10s), so a background watcher polls for it.
//   bank-table    — 2 pages, private room, mid-round with pot > 0, dice settled.
//   bank-roll     — a roll captured mid-tumble (verified: the die transform is
//                   still animating when the capture returns; up to 3 attempts).
//   bank-results  — every player banks each round until round 10 ends -> the
//                   'matchEnd' winner banner.
//
// Flags: --out <dir> (default screenshots/v2) · --only <prefix> (capture just
// the shots whose name starts with <prefix>; the other games are never even
// launched) · --keep-server (leave the server up for debugging) ·
// --allow-dev-server (capture even when the platform server is proxying a game
// to its vite dev server — normally a hard error, see assertProductionMounts).
//
// Exit 0 only if EVERY required shot landed as a non-trivial PNG and zero
// console/page/request errors were seen on any page. A missing shot is named
// explicitly — this harness never silently skips.
// ============================================================================
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 8091);
const BASE = `http://localhost:${PORT}`;
const SERVER_ENTRY = path.join(ROOT, 'platform/server/dist/server.js');

const VIEWPORT = { width: 1600, height: 900, deviceScaleFactor: 1 };
const MAP_IDS = ['dustbowl', 'crossfire', 'office', 'frostbite', 'urbana', 'bunker'];
const EYE_Y = 1.62; // standing eye height (PLAYER height 1.8 - 0.18 crouch-free eye drop)
const MIN_PNG_BYTES = 5000; // a real 1600x900 capture is far bigger; a blank/failed one is not

// ---- the frozen §6 shot list -------------------------------------------------
const SHOT_LIST = [
  { name: 'launcher', game: 'launcher' },
  ...MAP_IDS.flatMap((m) => ['a', 'b', 'c'].map((p) => ({ name: `fps-${m}-${p}`, game: 'fps' }))),
  { name: 'fps-char', game: 'fps' },
  { name: 'fps-hud', game: 'fps' },
  { name: 'fps-buy', game: 'fps' },
  { name: 'fps-scoreboard', game: 'fps' },
  { name: 'kart-grid', game: 'kart' },
  { name: 'kart-chase', game: 'kart' },
  { name: 'kart-corner', game: 'kart' },
  { name: 'kart-hud', game: 'kart' },
  { name: 'kart-results', game: 'kart' },
  { name: 'bank-table', game: 'bank' },
  { name: 'bank-roll', game: 'bank' },
  { name: 'bank-results', game: 'bank' },
];

// ---- args --------------------------------------------------------------------
function parseArgs(argv) {
  let out = 'screenshots/v2';
  let only = null;
  let keepServer = false;
  let allowDevServer = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      const v = argv[++i];
      if (v === undefined) throw new Error('--out needs a directory');
      out = v;
    } else if (a === '--only') {
      const v = argv[++i];
      if (v === undefined) throw new Error('--only needs a shot-name prefix');
      only = v;
    } else if (a === '--keep-server') {
      keepServer = true;
    } else if (a === '--allow-dev-server') {
      allowDevServer = true; // escape hatch: capture the vite dev build anyway (see assertProductionMounts)
    } else {
      throw new Error(
        `unknown argument '${a}' — usage: capture-visuals.mjs [--out <dir>] [--only <prefix>] [--keep-server] [--allow-dev-server]`,
      );
    }
  }
  return { out, only, keepServer, allowDevServer };
}

const ARGS = parseArgs(process.argv.slice(2));
const OUT_DIR = path.resolve(ROOT, ARGS.out);
const REQUIRED = SHOT_LIST.filter((s) => ARGS.only === null || s.name.startsWith(ARGS.only));
const want = (name) => REQUIRED.some((s) => s.name === name);
const wantAny = (...names) => names.some((n) => want(n));

// ---- state -------------------------------------------------------------------
const manifest = [];
const pageErrors = [];
const browsers = [];
let serverChild = null;
let mapData = null; // { [mapId]: MapDef } or null when the bundle could not be built
let mapDataNote = 'not loaded';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(msg);
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // page mid-navigation / socket reconnect — keep polling
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout (${timeoutMs}ms) waiting for ${label}`);
    await sleep(150);
  }
}

// ---- server ------------------------------------------------------------------
async function startServer() {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(`missing ${path.relative(ROOT, SERVER_ENTRY)} — run 'npm run build' first`);
  }
  // a stale server on the port would answer every probe and silently serve a
  // DIFFERENT build than the one under test
  const inUse = await fetch(BASE, { signal: AbortSignal.timeout(1500) }).then(
    () => true,
    () => false,
  );
  if (inUse) throw new Error(`something is already listening on :${PORT} — kill it or set E2E_PORT`);
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverChild = child;
  // server chatter goes to STDERR: stdout must end with the manifest line
  child.stdout.on('data', (d) => process.stderr.write(`[server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[server!] ${d}`));
  child.on('exit', (code) => {
    if (code !== null && code !== 0) process.stderr.write(`[server] exited with code ${code}\n`);
  });
  return child;
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

/**
 * The platform server proxies /<game>/ to that game's vite dev server whenever
 * one answers (platform/server/src/index.ts resolveMounts). Capturing through
 * it is invalid twice over: HMR full-reloads every page the moment anyone saves
 * a file (mid-capture pages drop back to the menu) and the served source can be
 * a half-finished edit rather than the reviewed build. Detect and refuse.
 */
async function assertProductionMounts(gameIds) {
  const devPorts = { fps: 5173, bank: 5174, kart: 5175 };
  for (const id of gameIds) {
    const res = await fetch(`${BASE}/${id}/`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`GET /${id}/ returned ${res.status} — is the client built? (npm run build)`);
    const html = await res.text();
    if (html.includes('/@vite/client')) {
      const msg =
        `/${id}/ is being served by the vite dev server on :${devPorts[id]} (the platform server proxies to it when it answers). ` +
        'HMR reloads every page mid-capture and the source may be mid-edit — stop the dev server for that game and re-run after `npm run build`.';
      if (!ARGS.allowDevServer) throw new Error(msg);
      log(`[warn] ${msg} (--allow-dev-server: continuing anyway)`);
    }
  }
}

// ---- browser -----------------------------------------------------------------
const LAUNCH_ARGS = [
  `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--enable-unsafe-swiftshader',
];
const LAUNCH_OPTS = {
  headless: 'shell', // same rationale as e2e.mjs: the shell's software pipeline never wedges
  args: LAUNCH_ARGS,
  protocolTimeout: Number(process.env.E2E_PROTOCOL_TIMEOUT ?? 300000),
};

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

async function launchOne(tag) {
  let browser = await puppeteer.launch(LAUNCH_OPTS);
  browsers.push(browser);
  let page = await browser.newPage();
  await page.setViewport(VIEWPORT);
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
    await page.setViewport(VIEWPORT);
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

// ---- capture -----------------------------------------------------------------
/** Wait on real conditions (fonts + rendered frames), then a short settle. */
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
    // a stalled rAF must not abort the capture — the settle delay below still applies
  }
  await sleep(ms);
}

async function shot(page, name) {
  const spec = SHOT_LIST.find((s) => s.name === name);
  if (spec === undefined) throw new Error(`shot '${name}' is not in the §6 list`);
  const file = path.join(OUT_DIR, `${name}.png`);
  const t0 = Date.now();
  try {
    await page.screenshot({ path: file, timeout: 30000 });
  } catch (err) {
    log(`[warn] ${name}: capture failed at ${((Date.now() - t0) / 1000).toFixed(1)}s (${err instanceof Error ? err.message : String(err)}) — one retry`);
    await page.screenshot({ path: file, timeout: 90000 });
  }
  const bytes = statSync(file).size;
  if (bytes < MIN_PNG_BYTES) {
    throw new Error(`shot '${name}' is only ${bytes} bytes — the frame did not render`);
  }
  manifest.push({ name, game: spec.game, file: path.relative(ROOT, file) });
  log(`shot  ${name} (${(bytes / 1024).toFixed(0)}kB, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// ---- map geometry (pose planning) --------------------------------------------
/**
 * The FPS camera IS the player's camera — there is no free-cam hook — so the
 * only levers are position (walking) and look angles. To aim those well the
 * harness loads the real map data (boxes/deco/theme) and raycasts in 2D from
 * the player's authoritative position. The data is bundled with the repo's own
 * esbuild (a @platform/server devDependency, already installed) because
 * @fps/shared is consumed as TypeScript source.
 */
async function loadMapData() {
  const bin = path.join(ROOT, 'node_modules/.bin/esbuild');
  if (!existsSync(bin)) {
    mapDataNote = 'esbuild not found — using fallback yaws';
    return null;
  }
  let tmp = null;
  try {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'capture-visuals-'));
    const outfile = path.join(tmp, 'maps.mjs');
    const res = spawnSync(
      bin,
      ['games/fps/shared/src/maps/index.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${outfile}`],
      { cwd: ROOT, encoding: 'utf8' },
    );
    if (res.status !== 0) {
      mapDataNote = `esbuild failed (${(res.stderr ?? '').trim().split('\n')[0] ?? '?'}) — using fallback yaws`;
      return null;
    }
    const mod = await import(`file://${outfile}`);
    if (mod.MAPS === undefined) {
      mapDataNote = 'bundle exported no MAPS — using fallback yaws';
      return null;
    }
    mapDataNote = 'geometry-planned poses (raycast against the real map boxes)';
    return mod.MAPS;
  } catch (err) {
    mapDataNote = `map bundle unavailable (${err instanceof Error ? err.message : String(err)}) — using fallback yaws`;
    return null;
  } finally {
    if (tmp !== null) await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** Free distance (m) from (x,z) along `yaw` at eye height; map walls bound it. */
function freeDist(map, x, z, yaw, maxDist = 90) {
  const dx = -Math.sin(yaw);
  const dz = -Math.cos(yaw);
  let best = maxDist;
  const hx = map.sizeX / 2;
  const hz = map.sizeZ / 2;
  if (dx > 1e-6) best = Math.min(best, (hx - x) / dx);
  else if (dx < -1e-6) best = Math.min(best, (-hx - x) / dx);
  if (dz > 1e-6) best = Math.min(best, (hz - z) / dz);
  else if (dz < -1e-6) best = Math.min(best, (-hz - z) / dz);
  let hit = null;
  for (const b of map.boxes) {
    if (b.y - b.h / 2 > EYE_Y || b.y + b.h / 2 < EYE_Y) continue; // not at eye height
    const minX = b.x - b.w / 2;
    const maxX = b.x + b.w / 2;
    const minZ = b.z - b.d / 2;
    const maxZ = b.z + b.d / 2;
    let t0 = 0;
    let t1 = best;
    for (const [p, d, lo, hi] of [
      [x, dx, minX, maxX],
      [z, dz, minZ, maxZ],
    ]) {
      if (Math.abs(d) < 1e-6) {
        if (p < lo || p > hi) {
          t0 = 1;
          t1 = 0;
          break;
        }
        continue;
      }
      const ta = (lo - p) / d;
      const tb = (hi - p) / d;
      t0 = Math.max(t0, Math.min(ta, tb));
      t1 = Math.min(t1, Math.max(ta, tb));
    }
    if (t1 >= t0 && t0 > 0.2 && t0 < best) {
      best = t0;
      hit = b;
    }
  }
  return { dist: Math.max(0, best), box: hit };
}

/** Deco zones whose scatter rect is within `r` of a point — a prop cluster. */
function decoNear(map, x, z, r) {
  let n = 0;
  for (const zone of map.deco ?? []) {
    const cx = Math.max(Math.min(zone.x0, zone.x1), Math.min(x, Math.max(zone.x0, zone.x1)));
    const cz = Math.max(Math.min(zone.z0, zone.z1), Math.min(z, Math.max(zone.z0, zone.z1)));
    if (Math.hypot(x - cx, z - cz) <= r) n += Math.min(zone.count, 20) / 10;
  }
  return n;
}

/** Camera yaw that looks straight at the rig's sun disc (dome-relative). */
function sunYaw(map) {
  const [sx, , sz] = map.theme.sunDir;
  return wrapPi(Math.atan2(-sx, -sz) + Math.PI);
}

const FALLBACK_YAWS = { a: 0, b: 2.1, c: 4.2 };

// ---- navigation grid ------------------------------------------------------------
// Greedy "walk at the target, strafe when wedged" navigation CANNOT cross these
// maps: dustbowl's spawns sit on opposite sides of 12m-deep buildings, and
// every local rule (strafe, clearest-ray, best-aligned-clear-ray) parks the
// walker against a wall forever (measured: pinned 80s at 22.1m apart). So the
// harness builds a real walkability grid from the map boxes and BFS-floods a
// distance field from the target — the walker then always has a true shortest
// path around the geometry.
const NAV_CELL = 0.5; // m
const PLAYER_RADIUS = 0.3; // PLAYER.radius (games/fps/shared/src/config.ts)
const STEP_UP = 0.42; // PLAYER.stepUp — anything lower is walked over, not around
const STAND_HEIGHT = 1.8; // PLAYER.heightStand — a box starting above it is an overhead
const navGrids = new Map();

function navGrid(map) {
  const cached = navGrids.get(map.id);
  if (cached !== undefined) return cached;
  const nx = Math.ceil(map.sizeX / NAV_CELL) + 1;
  const nz = Math.ceil(map.sizeZ / NAV_CELL) + 1;
  const x0 = -map.sizeX / 2;
  const z0 = -map.sizeZ / 2;
  const blocked = new Uint8Array(nx * nz);
  // a cell is blocked when its CENTRE lies inside the box grown by the player's
  // half-extent. Rounding the range outward instead (floor/ceil) over-inflates
  // by a full cell each side, which plugs 3m gaps with 1.2m crates and walls
  // the rendezvous corridor off entirely (measured on dustbowl: 87 reachable
  // cells out of 12513).
  const pad = PLAYER_RADIUS + 0.05;
  for (const b of map.boxes) {
    const top = b.y + b.h / 2;
    const bottom = b.y - b.h / 2;
    if (top <= STEP_UP) continue; // a curb: walked over
    if (bottom >= STAND_HEIGHT) continue; // overhead beam: walked under
    const minI = Math.max(0, Math.floor((b.x - b.w / 2 - pad - x0) / NAV_CELL));
    const maxI = Math.min(nx - 1, Math.ceil((b.x + b.w / 2 + pad - x0) / NAV_CELL));
    const minJ = Math.max(0, Math.floor((b.z - b.d / 2 - pad - z0) / NAV_CELL));
    const maxJ = Math.min(nz - 1, Math.ceil((b.z + b.d / 2 + pad - z0) / NAV_CELL));
    for (let j = minJ; j <= maxJ; j++) {
      const cz = z0 + j * NAV_CELL;
      if (Math.abs(cz - b.z) > b.d / 2 + pad) continue;
      for (let i = minI; i <= maxI; i++) {
        const cx = x0 + i * NAV_CELL;
        if (Math.abs(cx - b.x) <= b.w / 2 + pad) blocked[j * nx + i] = 1;
      }
    }
  }
  const grid = { nx, nz, x0, z0, blocked, field: null, fieldKey: '' };
  navGrids.set(map.id, grid);
  return grid;
}

const navIndex = (g, x, z) => {
  const i = Math.min(g.nx - 1, Math.max(0, Math.round((x - g.x0) / NAV_CELL)));
  const j = Math.min(g.nz - 1, Math.max(0, Math.round((z - g.z0) / NAV_CELL)));
  return { i, j };
};

/** BFS distance field (in cells) to the target, cached per target cell. */
function navField(g, tx, tz) {
  const { i: ti, j: tj } = navIndex(g, tx, tz);
  const key = `${ti},${tj}`;
  if (g.fieldKey === key && g.field !== null) return g.field;
  const field = new Int32Array(g.nx * g.nz).fill(-1);
  const queue = [];
  // a target standing inside inflated geometry still needs a reachable seed
  for (let r = 0; r <= 6 && queue.length === 0; r++) {
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = ti + di;
        const j = tj + dj;
        if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) continue;
        if (g.blocked[j * g.nx + i] === 1) continue;
        field[j * g.nx + i] = 0;
        queue.push(j * g.nx + i);
      }
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    const ci = cur % g.nx;
    const cj = (cur - ci) / g.nx;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const i = ci + di;
      const j = cj + dj;
      if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) continue;
      const idx = j * g.nx + i;
      if (g.blocked[idx] === 1 || field[idx] !== -1) continue;
      field[idx] = field[cur] + 1;
      queue.push(idx);
    }
  }
  g.field = field;
  g.fieldKey = key;
  return field;
}

/** Nearest walkable point to (x,z) — a rendezvous must be standable. */
function nearestFree(map, x, z) {
  if (map === null) return [x, z];
  const g = navGrid(map);
  const { i: ci, j: cj } = navIndex(g, x, z);
  for (let r = 0; r < 40; r++) {
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) continue;
        if (g.blocked[j * g.nx + i] === 1) continue;
        return [g.x0 + i * NAV_CELL, g.z0 + j * NAV_CELL];
      }
    }
  }
  return [x, z];
}

/**
 * A standable spot `radius` from (mx,mz) with a clear eye-height line of sight
 * to it — where the camera has to stand for both soldiers to be in frame.
 */
function cameraSpot(map, mx, mz, radius) {
  if (map === null) return [mx, mz + radius];
  const g = navGrid(map);
  let fallback = null;
  for (let k = 0; k < 36; k++) {
    const a = (k / 36) * Math.PI * 2;
    const cx = mx + Math.sin(a) * radius;
    const cz = mz + Math.cos(a) * radius;
    const { i, j } = navIndex(g, cx, cz);
    if (i <= 0 || j <= 0 || i >= g.nx - 1 || j >= g.nz - 1) continue;
    if (g.blocked[j * g.nx + i] === 1) continue;
    if (fallback === null) fallback = [cx, cz];
    const { dist } = freeDist(map, cx, cz, yawTo(cx, cz, mx, mz), radius + 2);
    if (dist >= radius - 0.5) return [cx, cz]; // clear sightline to the rendezvous
  }
  return fallback ?? [mx, mz + radius];
}

/**
 * Look-ahead WAYPOINT on the shortest walkable path to (tx,tz): descend the BFS
 * field a few cells and return that point (a point, not a yaw — the caller
 * COMMITS to it for a couple of seconds; on a symmetric map the two ways around
 * a wall tie exactly and a per-tick heading flip-flops on the spot, which is
 * what pinned the walkers at |z|=15.8 for four minutes). Falls back to the
 * target itself when the map data is unavailable.
 */
function pathWaypoint(map, sx, sz, tx, tz) {
  if (map === null) return [tx, tz];
  const g = navGrid(map);
  const field = navField(g, tx, tz);
  let { i, j } = navIndex(g, sx, sz);
  if (field[j * g.nx + i] < 0) {
    // standing in an inflated cell (against a wall): take the best neighbour
    let best = null;
    for (let dj = -2; dj <= 2; dj++) {
      for (let di = -2; di <= 2; di++) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= g.nx || nj >= g.nz) continue;
        const d = field[nj * g.nx + ni];
        if (d < 0) continue;
        if (best === null || d < best.d) best = { i: ni, j: nj, d };
      }
    }
    if (best === null) return [tx, tz];
    i = best.i;
    j = best.j;
  }
  for (let step = 0; step < 8; step++) {
    let best = null;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= g.nx || nj >= g.nz) continue;
      const d = field[nj * g.nx + ni];
      if (d < 0) continue;
      if (di !== 0 && dj !== 0 && (g.blocked[j * g.nx + ni] === 1 || g.blocked[nj * g.nx + i] === 1)) continue;
      if (best === null || d < best.d) best = { i: ni, j: nj, d };
    }
    if (best === null || field[j * g.nx + i] === 0) break;
    i = best.i;
    j = best.j;
  }
  return [g.x0 + i * NAV_CELL, g.z0 + j * NAV_CELL];
}

/** Longest sightline from (x,z) — the "main lane" read. */
function planLongSightline(map, x, z) {
  if (map === null) return { yaw: FALLBACK_YAWS.a, pitch: -0.05, detail: 'fallback yaw' };
  let best = { yaw: 0, dist: -1 };
  for (let i = 0; i < 96; i++) {
    const yaw = wrapPi((i / 96) * Math.PI * 2);
    const { dist } = freeDist(map, x, z, yaw);
    if (dist > best.dist) best = { yaw, dist };
  }
  return { yaw: best.yaw, pitch: -0.05, detail: `sightline ${best.dist.toFixed(1)}m` };
}

/** A wall 2.5-8m out, preferring tall walls next to a deco (prop) zone. */
function planWallCloseup(map, x, z) {
  if (map === null) return { yaw: FALLBACK_YAWS.b, pitch: 0.02, detail: 'fallback yaw' };
  let best = null;
  let nearest = null;
  for (let i = 0; i < 96; i++) {
    const yaw = wrapPi((i / 96) * Math.PI * 2);
    const { dist, box } = freeDist(map, x, z, yaw);
    if (nearest === null || (dist >= 2.2 && dist < nearest.dist)) nearest = { yaw, dist, box };
    if (dist < 2.5 || dist > 8) continue;
    const hx = x - Math.sin(yaw) * dist;
    const hz = z - Math.cos(yaw) * dist;
    const score =
      decoNear(map, hx, hz, 9) * 2 +
      (box !== null && box.h >= 2.5 ? 1.5 : 0) +
      (box !== null && Math.min(box.w, box.d) >= 3 ? 0.5 : 0) -
      Math.abs(dist - 4.5) * 0.15;
    if (best === null || score > best.score) best = { yaw, dist, score };
  }
  const pick = best ?? nearest ?? { yaw: FALLBACK_YAWS.b, dist: 0 };
  return {
    yaw: pick.yaw,
    pitch: 0.02,
    detail: `wall at ${pick.dist.toFixed(1)}m${best === null ? ' (nearest-wall fallback)' : ''}`,
  };
}

/** Low crouched angle toward the sun; nudged off a face-planted wall. */
function planSunLow(map, x, z) {
  if (map === null) return { yaw: FALLBACK_YAWS.c, pitch: 0.24, detail: 'fallback yaw' };
  // sun-ward, but never nose-first into a wall: every heading is scored by its
  // clearance with a penalty for straying off the sun azimuth, so an enclosed
  // spot swings round to the open side instead of shooting a blank wall.
  const target = sunYaw(map);
  let best = null;
  let widest = null;
  for (let i = 0; i < 96; i++) {
    const yaw = wrapPi((i / 96) * Math.PI * 2);
    const off = Math.abs(wrapPi(yaw - target));
    const { dist } = freeDist(map, x, z, yaw);
    if (widest === null || dist > widest.dist) widest = { yaw, dist };
    if (dist < 5) continue;
    const score = Math.min(dist, 14) * 0.35 - off * 2.4;
    if (best === null || score > best.score) best = { yaw, dist, score };
  }
  if (best === null) best = widest ?? { yaw: target, dist: 0 };
  return {
    yaw: best.yaw,
    pitch: 0.24, // low: the sun disc sits at SUN_ELEVATION, so the horizon stays in frame
    detail: `sun azimuth ${(target * 57.3).toFixed(0)}deg, ${best.dist.toFixed(1)}m clear`,
  };
}

// ---- fps helpers ---------------------------------------------------------------
const fpsState = (page) => page.evaluate(() => window.__fps?.state() ?? null);
const setLook = (page, yaw, pitch) => page.evaluate((y, p) => window.__fps.debug.setLook(y, p), yaw, pitch);
const setMove = (page, x, z) => page.evaluate((mx, mz) => window.__fps.debug.setMove(mx, mz), x, z);

/** world yaw from (ax,az) towards (bx,bz); forward = (-sin(yaw), -cos(yaw)) */
const yawTo = (ax, az, bx, bz) => Math.atan2(-(bx - ax), -(bz - az));

const layerVisible = (page, cls) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el !== null && getComputedStyle(el).display !== 'none';
  }, `.fps-menus .m9-layer-${cls}`);

/** The buy layer auto-opens on every freeze snapshot and hides the scene. */
async function closeBuyMenu(page) {
  if (await layerVisible(page, 'buy')) {
    await page.keyboard.press('KeyB');
    await sleep(250);
  }
}

/**
 * The solo bot prompt ('Alone in this room — add some bots?') parks a panel in
 * the lower-right of every map shot for 20s. Its NO THANKS button is wired to a
 * no-op onDismiss in the client (ui/menus.ts showBotPrompt), so clicking it
 * changes nothing — the prompt only hides on a roster/phase change or the 20s
 * timeout. Adding a bot and removing it again is the cheap honest trigger: the
 * roster passes 1, hideBotPrompt fires, and the prompt is latched off for this
 * join (botPromptShown), leaving the player alone again for the tour.
 */
async function clearBotPrompt(page) {
  const before = (await fpsState(page))?.players ?? 1;
  await page.evaluate(() => window.__fps.addBot());
  const grew = await waitFor(async () => {
    const s = await fpsState(page);
    return s !== null && s.players > before ? s : null;
  }, 6000, 'bot added (bot-prompt clear)').catch(() => null);
  if (grew === null) return false;
  await page.evaluate(() => window.__fps.removeBot());
  await waitFor(async () => {
    const s = await fpsState(page);
    return s !== null && s.players === before ? s : null;
  }, 6000, 'bot removed').catch(() => null);
  await waitFor(async () => {
    const s = await fpsState(page);
    return s !== null && s.phase === 'warmup' && s.alive ? s : null;
  }, 12000, 'back to warmup, alone').catch(() => null);
  return true;
}

async function walkFor(page, ms, x = 0, z = 1) {
  await setMove(page, x, z);
  await sleep(ms);
  await setMove(page, 0, 0);
  await sleep(250); // let the server sim settle the stop before sampling pos
}

// ---- section: launcher ---------------------------------------------------------
async function captureLauncher() {
  const page = await launchOne('launcher');
  try {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle0', timeout: 30000 });
    await waitFor(
      () => page.evaluate(() => document.body !== null && document.body.textContent.trim().length > 0),
      10000,
      'launcher body content',
    );
    await settle(page, { frames: 2, ms: 500 });
    await shot(page, 'launcher');
  } finally {
    await closePage(page);
  }
}

// ---- section: fps --------------------------------------------------------------
async function captureFpsMaps(page, mapIds) {
  for (const mapId of mapIds) {
    const t0 = Date.now();
    const prevRoom = (await fpsState(page))?.roomId ?? null;
    await page.evaluate((m) => window.__fps.createPrivate('Cam', m), mapId);
    await waitFor(async () => {
      const s = await fpsState(page);
      return s !== null && s.mapId === mapId && s.roomId !== null && s.roomId !== prevRoom ? s : null;
    }, 20000, `join private ${mapId}`);
    const spawned = await waitFor(async () => {
      const s = await fpsState(page);
      return s !== null && s.alive && s.pos.every((v) => Number.isFinite(v)) ? s : null;
    }, 20000, `alive spawn on ${mapId}`);
    await sleep(1400); // world build + deco scatter + first shadow-casting frames
    await closeBuyMenu(page);
    await clearBotPrompt(page);
    const map = mapData === null ? null : mapData[mapId] ?? null;

    // pose a — the longest sightline from the spawn (the main lane)
    let s = await fpsState(page);
    const poseA = planLongSightline(map, s.pos[0], s.pos[2]);
    await setLook(page, poseA.yaw, poseA.pitch);
    await settle(page, { frames: 4, ms: 450 });
    if (want(`fps-${mapId}-a`)) await shot(page, `fps-${mapId}-a`);

    // walk that lane, then frame an articulated wall + prop cluster
    await walkFor(page, 2000);
    s = (await fpsState(page)) ?? s;
    const poseB = planWallCloseup(map, s.pos[0], s.pos[2]);
    await setLook(page, poseB.yaw, poseB.pitch);
    await settle(page, { frames: 4, ms: 450 });
    if (want(`fps-${mapId}-b`)) await shot(page, `fps-${mapId}-b`);

    // strafe off the wall, crouch, look low into the sun
    await walkFor(page, 1200, 1, 0);
    s = (await fpsState(page)) ?? s;
    const poseC = planSunLow(map, s.pos[0], s.pos[2]);
    await setLook(page, poseC.yaw, poseC.pitch);
    await page.evaluate(() => window.__fps.debug.press('crouch', true));
    await settle(page, { frames: 4, ms: 550 });
    if (want(`fps-${mapId}-c`)) await shot(page, `fps-${mapId}-c`);
    await page.evaluate(() => window.__fps.debug.press('crouch', false));

    log(
      `map ${mapId}: ${((Date.now() - t0) / 1000).toFixed(1)}s — a: ${poseA.detail} · b: ${poseB.detail} · c: ${poseC.detail} (spawn ${spawned.pos.map((v) => v.toFixed(1)).join(',')})`,
    );
  }
}

/**
 * Two soldiers on opposite teams, ~8m out, with the camera's own viewmodel in
 * frame. Three real clients: the two on opposite teams walk at each other
 * (wall-following approach — box maps wedge a naive straight line), then the
 * third walks in to ~8m and aims at their midpoint.
 */
async function captureFpsChar(pages, mapId) {
  const teams = [];
  for (const p of pages) teams.push((await fpsState(p)).team);
  // teams split 2/1 with three players: the lone one + one of the pair are the
  // opposite-team subjects; the remaining page is the camera.
  const lone = teams.findIndex((t) => teams.filter((x) => x === t).length === 1);
  if (lone < 0) throw new Error(`fps-char: could not find opposite teams (teams=${teams.join('/')})`);
  const subjA = pages[lone];
  const others = pages.filter((_, i) => i !== lone);
  const subjB = others[0];
  const cam = others[1];
  log(`fps-char: subjects ${teams[lone]} + ${teams[pages.indexOf(subjB)]}, camera ${teams[pages.indexOf(cam)]}`);

  // MOVEMENT IS FRAME-RATE BOUND: the client ships one input frame per rAF and
  // the server integrates one tick per input, so three 1600x900 WebGL clients
  // on a software rasterizer (~2 fps each) crawl at ~0.1 m/s and never meet.
  // Walking therefore runs at a tiny viewport (30+ fps); the frame is restored
  // to the contract's 1600x900 before the capture.
  const WALK_VIEWPORT = { width: 480, height: 270, deviceScaleFactor: 1 };
  for (const p of pages) await p.setViewport(WALK_VIEWPORT);

  const map = mapData === null ? null : mapData[mapId] ?? null;
  const walkers = new Map();
  /**
   * Walk `page` at `targetPos` along the BFS path. The look-ahead waypoint is
   * held until it is reached (or 2.5s), so the walker commits to ONE way around
   * a wall instead of flip-flopping where the two routes tie. A 4s stall nudges
   * it sideways for 1s (the 0.5m grid can still catch a shoulder on a corner).
   */
  async function approach(page, selfPos, targetPos) {
    const now = Date.now();
    const dist = Math.hypot(targetPos[0] - selfPos[0], targetPos[2] - selfPos[2]);
    let w = walkers.get(page);
    if (w === undefined) {
      w = { bestDist: dist, improvedAt: now, nudgeUntil: 0, dir: 1, wp: null, wpAt: 0 };
      walkers.set(page, w);
    }
    if (dist < w.bestDist - 0.6) {
      w.bestDist = dist;
      w.improvedAt = now;
    } else if (now - w.improvedAt > 4000 && now >= w.nudgeUntil) {
      w.nudgeUntil = now + 1000;
      w.dir = -w.dir;
      w.improvedAt = now;
    }
    const wpDist = w.wp === null ? Infinity : Math.hypot(w.wp[0] - selfPos[0], w.wp[1] - selfPos[2]);
    if (w.wp === null || wpDist < 1.2 || now - w.wpAt > 2500) {
      w.wp = pathWaypoint(map, selfPos[0], selfPos[2], targetPos[0], targetPos[2]);
      w.wpAt = now;
    }
    await setLook(page, yawTo(selfPos[0], selfPos[2], w.wp[0], w.wp[1]), 0);
    await setMove(page, now < w.nudgeUntil ? w.dir : 0, 1);
  }

  const PAIR_MAX = 7; // two soldiers this far apart still frame together at ~8m
  const CAM_NEAR = 5.5;
  const CAM_FAR = 11;
  // FIXED rendezvous, not "walk at each other": chasing a moving target makes
  // both walkers dither where two routes around a building tie, and they park
  // on the wall between them. A standable meeting point plus a standable camera
  // spot with a clear line of sight to it are computed ONCE from the geometry.
  const start = await Promise.all([fpsState(subjA), fpsState(subjB)]);
  const rvRaw = [(start[0].pos[0] + start[1].pos[0]) / 2, (start[0].pos[2] + start[1].pos[2]) / 2];
  const [mx, mz] = nearestFree(map, rvRaw[0], rvRaw[1]);
  const [cx, cz] = cameraSpot(map, mx, mz, 8);
  // the two soldiers stand SIDE BY SIDE across the camera's view axis: walking
  // both to the same point puts one behind the other and the shot shows a
  // single silhouette (measured: 1.5m apart, the CT hidden by the T).
  const axLen = Math.max(1e-6, Math.hypot(mx - cx, mz - cz));
  const px = -(mz - cz) / axLen;
  const pz = (mx - cx) / axLen;
  const standA = nearestFree(map, mx + px * 1.8, mz + pz * 1.8);
  const standB = nearestFree(map, mx - px * 1.8, mz - pz * 1.8);
  log(
    `fps-char: rendezvous ${mx.toFixed(1)},${mz.toFixed(1)} · camera spot ${cx.toFixed(1)},${cz.toFixed(1)} · ` +
      `stands ${standA.map((v) => v.toFixed(1)).join(',')} / ${standB.map((v) => v.toFixed(1)).join(',')}`,
  );

  const t0 = Date.now();
  let posed = null;
  let lastLog = 0;
  while (Date.now() - t0 < 240000) {
    const [sa, sb, sc] = await Promise.all([fpsState(subjA), fpsState(subjB), fpsState(cam)]);
    if (sa === null || sb === null || sc === null) {
      await sleep(300);
      continue;
    }
    if (sa.phase !== 'live' && sa.phase !== 'warmup') {
      // freeze/roundEnd: nobody moves and the buy layer is up — wait it out
      await Promise.all([setMove(subjA, 0, 0), setMove(subjB, 0, 0), setMove(cam, 0, 0)]);
      await sleep(400);
      continue;
    }
    if (!sa.alive || !sb.alive || !sc.alive) {
      await sleep(500);
      continue;
    }
    const pairDist = Math.hypot(sb.pos[0] - sa.pos[0], sb.pos[2] - sa.pos[2]);
    const mid = [(sa.pos[0] + sb.pos[0]) / 2, (sa.pos[1] + sb.pos[1]) / 2, (sa.pos[2] + sb.pos[2]) / 2];
    const camDist = Math.hypot(mid[0] - sc.pos[0], mid[2] - sc.pos[2]);
    if (Date.now() - lastLog > 4000) {
      lastLog = Date.now();
      const at = (s) => `${s.pos[0].toFixed(1)},${s.pos[1].toFixed(1)},${s.pos[2].toFixed(1)}`;
      log(
        `fps-char t=${((Date.now() - t0) / 1000).toFixed(0)}s pairDist=${pairDist.toFixed(1)} camDist=${camDist.toFixed(1)} ` +
          `phase=${sa.phase} A(${at(sa)}) B(${at(sb)}) C(${at(sc)})`,
      );
    }
    // each walker has its OWN fixed destination; they stop 2.5m short of the
    // rendezvous so the two soldiers end up beside each other, not inside
    const dA = Math.hypot(standA[0] - sa.pos[0], standA[1] - sa.pos[2]);
    const dB = Math.hypot(standB[0] - sb.pos[0], standB[1] - sb.pos[2]);
    const dC = Math.hypot(cx - sc.pos[0], cz - sc.pos[2]);
    let walking = false;
    if (dA > 1.2) {
      await approach(subjA, sa.pos, [standA[0], 0, standA[1]]);
      walking = true;
    } else await setMove(subjA, 0, 0);
    if (dB > 1.2) {
      await approach(subjB, sb.pos, [standB[0], 0, standB[1]]);
      walking = true;
    } else await setMove(subjB, 0, 0);
    if (dC > 1.5) {
      await approach(cam, sc.pos, [cx, 0, cz]);
      walking = true;
    } else await setMove(cam, 0, 0);
    if (walking || pairDist > PAIR_MAX || pairDist < 2 || camDist > CAM_FAR || camDist < CAM_NEAR) {
      await sleep(200);
      continue;
    }
    posed = { pairDist, camDist, mid, camPos: sc.pos };
    break;
  }
  for (const p of pages) {
    await setMove(p, 0, 0);
    await p.setViewport(VIEWPORT); // back to the contract's capture resolution
  }
  await sleep(600); // the scene rebuilds its render target at the new size
  if (posed === null) {
    throw new Error(
      `fps-char: the two soldiers never got within ${PAIR_MAX}m of each other with the camera ${CAM_NEAR}-${CAM_FAR}m away, within 240s on ${mapId}`,
    );
  }
  // both soldiers turn to face the camera (front silhouettes read best), then
  // the camera aims at their chests and everything holds still for the frame
  const camPos = posed.camPos;
  for (const [p, s] of [
    [subjA, await fpsState(subjA)],
    [subjB, await fpsState(subjB)],
  ]) {
    if (s !== null) await setLook(p, yawTo(s.pos[0], s.pos[2], camPos[0], camPos[2]), 0);
  }
  const eye = posed.camPos[1] + EYE_Y;
  const chest = posed.mid[1] + 1.2;
  const horiz = Math.hypot(posed.mid[0] - posed.camPos[0], posed.mid[2] - posed.camPos[2]);
  await setLook(
    cam,
    yawTo(posed.camPos[0], posed.camPos[2], posed.mid[0], posed.mid[2]),
    Math.atan2(chest - eye, Math.max(horiz, 0.001)),
  );
  await closeBuyMenu(cam);
  await settle(cam, { frames: 5, ms: 700 });
  await shot(cam, 'fps-char');
  log(`fps-char: pair ${posed.pairDist.toFixed(1)}m apart, camera ${posed.camDist.toFixed(1)}m out`);
}

async function captureFpsRoomUi(page) {
  // HUD: a live round with no modal layer over the scene
  if (want('fps-hud')) {
    await waitFor(async () => {
      const s = await fpsState(page);
      return s !== null && s.phase === 'live' ? s : null;
    }, 140000, "phase 'live' for fps-hud");
    await closeBuyMenu(page);
    await settle(page, { frames: 4, ms: 500 });
    await shot(page, 'fps-hud');
  }
  // Buy menu: auto-opens on the freeze snapshot
  if (want('fps-buy')) {
    await waitFor(async () => {
      const s = await fpsState(page);
      return s !== null && s.phase === 'freeze' ? s : null;
    }, 140000, "phase 'freeze' for fps-buy");
    const shown = await waitFor(() => layerVisible(page, 'buy'), 4000, 'buy layer visible').catch(() => false);
    if (!shown) {
      await page.keyboard.press('KeyB');
      await waitFor(() => layerVisible(page, 'buy'), 4000, 'buy layer visible after KeyB');
    }
    await settle(page, { frames: 3, ms: 450 });
    await shot(page, 'fps-buy');
    await closeBuyMenu(page);
  }
  // Scoreboard: the frozen Tab-edge mirror
  if (want('fps-scoreboard')) {
    await closeBuyMenu(page);
    await page.evaluate(() => window.__fps.debug.scoreboard(true));
    await waitFor(() => layerVisible(page, 'score'), 5000, 'scoreboard layer visible');
    await settle(page, { frames: 3, ms: 450 });
    await shot(page, 'fps-scoreboard');
    await page.evaluate(() => window.__fps.debug.scoreboard(false));
  }
}

async function captureFps() {
  const mapsWanted = MAP_IDS.filter((m) => wantAny(`fps-${m}-a`, `fps-${m}-b`, `fps-${m}-c`));
  const roomWanted = wantAny('fps-char', 'fps-hud', 'fps-buy', 'fps-scoreboard');
  if (mapsWanted.length === 0 && !roomWanted) return;

  const A = await launchOne('fpsA');
  await A.goto(`${BASE}/fps/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(() => A.evaluate(() => !!window.__fps), 20000, '__fps on fpsA');
  const pages = [A];
  try {
    if (mapsWanted.length > 0) await captureFpsMaps(A, mapsWanted);
    if (!roomWanted) return;

    // a shared private room: 3 players => teams split 2/1 => a CT and a T pair
    const B = await launchOne('fpsB');
    pages.push(B);
    await B.goto(`${BASE}/fps/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitFor(() => B.evaluate(() => !!window.__fps), 20000, '__fps on fpsB');
    const C = await launchOne('fpsC');
    pages.push(C);
    await C.goto(`${BASE}/fps/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitFor(() => C.evaluate(() => !!window.__fps), 20000, '__fps on fpsC');

    await A.evaluate(() => window.__fps.createPrivate('Alice', 'dustbowl'));
    const room = await waitFor(async () => {
      const s = await fpsState(A);
      return s !== null && s.roomId !== null && s.code !== null && s.mapId === 'dustbowl' ? s : null;
    }, 20000, 'A createPrivate(dustbowl)');
    // the lobby drops a join sent before the socket's welcome lands — retry
    for (const [page, name] of [[B, 'Bob'], [C, 'Cara']]) {
      let seated = null;
      for (let attempt = 0; attempt < 3 && seated === null; attempt++) {
        await page.evaluate((n, c) => window.__fps.joinPrivate(n, c), name, room.code);
        seated = await waitFor(async () => {
          const s = await fpsState(page);
          return s !== null && s.roomId === room.roomId ? s : null;
        }, 12000, `${name} joins ${room.code}`).catch(() => null);
      }
      if (seated === null) throw new Error(`fps: ${name} never joined room ${room.code}`);
    }
    await waitFor(async () => {
      const ss = await Promise.all(pages.map((p) => fpsState(p)));
      return ss.every((s) => s !== null && s.roomId === room.roomId && s.players === 3 && s.rosterSize === 3) ? ss : null;
    }, 30000, 'all three pages seated in the room');
    await waitFor(async () => {
      const s = await fpsState(A);
      return s !== null && (s.phase === 'live' || s.phase === 'freeze') ? s : null;
    }, 60000, 'the match starts (freeze/live)');

    if (want('fps-char')) await captureFpsChar(pages, 'dustbowl');
    await captureFpsRoomUi(A);
  } finally {
    for (const p of pages) await closePage(p);
  }
}

// ---- section: kart -------------------------------------------------------------
const kartState = (page) => page.evaluate(() => window.__kart?.state() ?? null);
const kartTele = (page) => page.evaluate(() => window.__kart?.telemetry?.() ?? null);
const kartInput = (page, t, b, s, d) =>
  page.evaluate((tt, bb, ss, dd) => window.__kart.setInput(tt, bb, ss, dd), t, b, s, d);

async function setAssist(page, on) {
  for (let i = 0; i < 3; i++) {
    const s = await kartState(page);
    if (s !== null && s.assist === on) return true;
    await page.keyboard.press('KeyT');
    await sleep(400);
  }
  const s = await kartState(page);
  return s !== null && s.assist === on;
}

/** yaw rate (rad/s) over `ms`, plus the sample that produced it */
async function kartYawRate(page, ms = 350) {
  const t1 = await kartTele(page);
  if (t1 === null) return null;
  const at1 = Date.now();
  await sleep(ms);
  const t2 = await kartTele(page);
  if (t2 === null) return null;
  const dt = Math.max(0.001, (Date.now() - at1) / 1000);
  return { rate: wrapPi(t2.own.yaw - t1.own.yaw) / dt, speed: t2.own.speedMps, tele: t2 };
}

/**
 * The results table only exists once the race ENDS, and it is on screen for
 * RESULTS_SECONDS (10s) only — so this watcher runs concurrently with the
 * bank/fps captures instead of blocking on a possibly 5-minute race.
 */
function watchKartResults(page, deadlineMs) {
  return (async () => {
    const t0 = Date.now();
    let lastLog = 0;
    while (Date.now() - t0 < deadlineMs) {
      const s = await kartState(page).catch(() => null);
      if (s !== null && s.phase === 'results') {
        await settle(page, { frames: 3, ms: 500 });
        await shot(page, 'kart-results');
        return true;
      }
      if (s !== null && Date.now() - lastLog > 20000) {
        lastLog = Date.now();
        log(`kart race t=${((Date.now() - t0) / 1000).toFixed(0)}s phase=${s.phase} lap=${s.lap} progress=${s.progress}`);
      }
      // keep the throttle latched (a respawn/reset can clear the debug input)
      if (s !== null && s.phase === 'racing') await kartInput(page, 1, 0, 0, false).catch(() => {});
      await sleep(700);
    }
    return false;
  })();
}

async function captureKart() {
  if (!wantAny('kart-grid', 'kart-chase', 'kart-corner', 'kart-hud', 'kart-results')) return null;
  const A = await launchOne('kartA');
  let B = await launchOne('kartB');
  await A.goto(`${BASE}/kart/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(() => A.evaluate(() => !!window.__kart), 20000, '__kart on kartA');
  await B.goto(`${BASE}/kart/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(() => B.evaluate(() => !!window.__kart), 20000, '__kart on kartB');

  await A.evaluate(() => window.__kart.createPrivate('Alice'));
  const room = await waitFor(async () => {
    const s = await kartState(A);
    return s !== null && s.phase !== 'menu' && typeof s.code === 'string' && s.code.length > 0 ? s : null;
  }, 20000, 'A createPrivate join (code)');
  await B.evaluate((c) => window.__kart.joinPrivate('Bob', c), room.code);
  await waitFor(async () => {
    const [sa, sb] = await Promise.all([kartState(A), kartState(B)]);
    return sa !== null && sb !== null && sa.players === 2 && sb.players === 2 ? sa : null;
  }, 20000, 'both karts seated');

  // grid: the countdown beats (3-2-1) over the painted grid slots
  if (want('kart-grid')) {
    await waitFor(async () => {
      const s = await kartState(A);
      return s !== null && (s.phase === 'countdown' || s.phase === 'racing') ? s : null;
    }, 40000, "phase 'countdown'");
    await settle(A, { frames: 2, ms: 120 });
    await shot(A, 'kart-grid');
  }
  await waitFor(async () => {
    const s = await kartState(A);
    return s !== null && s.phase === 'racing' ? s : null;
  }, 40000, "phase 'racing'");

  // KIDS MODE: the client pure-pursues the centerline, so throttle is all the
  // harness has to supply to get a real racing line (docs/KART.md).
  const assisted = await setAssist(A, true);
  if (!assisted) throw new Error('kart: KIDS MODE assist would not turn on (KeyT) — cannot drive the circuit');
  await kartInput(A, 1, 0, 0, false);

  // the second kart has served its purpose (a 2-kart grid shot + meeting
  // MIN_PLAYERS); dropping it now means A finishing its 3 laps ENDS the race
  // (allFinished) instead of waiting on a second driver.
  await closePage(B);
  B = null;

  await sleep(9000); // the controls hint card fades ~6s after GO

  // chase: at speed on a straight (a corner needs braking, so >16 m/s with a
  // near-zero yaw rate IS a straight)
  if (want('kart-chase')) {
    const t0 = Date.now();
    let got = false;
    while (Date.now() - t0 < 90000) {
      const y = await kartYawRate(A, 300);
      if (y !== null && y.speed > 16 && Math.abs(y.rate) < 0.15) {
        await shot(A, 'kart-chase');
        got = true;
        break;
      }
      await sleep(250);
    }
    if (!got) throw new Error('kart-chase: never reached >16 m/s on a straight within 90s');
  }

  // hud at speed: fire a nitro so the HUD shows the boost + the trail FX
  if (want('kart-hud')) {
    const t0 = Date.now();
    let got = false;
    while (Date.now() - t0 < 60000) {
      const y = await kartYawRate(A, 250);
      if (y !== null && y.speed > 14) {
        await A.keyboard.press('KeyN');
        await sleep(320);
        await shot(A, 'kart-hud');
        got = true;
        break;
      }
      await sleep(250);
    }
    if (!got) throw new Error('kart-hud: never reached 14 m/s within 60s');
  }

  // corner: wait until the assist is actually mid-corner, then take the steer
  // back with the handbrake down so the drift FX (smoke + marks) fire
  if (want('kart-corner')) {
    const t0 = Date.now();
    let got = false;
    while (Date.now() - t0 < 120000) {
      const y = await kartYawRate(A, 300);
      if (y !== null && Math.abs(y.rate) > 0.28 && y.speed > 9) {
        const steer = y.rate < 0 ? 0.8 : -0.8; // positive steer = RIGHT = yaw decreasing
        await setAssist(A, false); // the assist owns the steer channel
        await kartInput(A, 0.7, 0, steer, true);
        await sleep(280); // long enough for the grip to break and the FX to spawn,
        const t = await kartTele(A); // short enough that the kart is still IN the corner
        await shot(A, 'kart-corner');
        got = true;
        await kartInput(A, 1, 0, 0, false);
        await setAssist(A, true);
        if (t === null || !t.own.drifting) log('[warn] kart-corner: handbrake set but the drifting flag was not latched at capture');
        break;
      }
      await sleep(250);
    }
    if (!got) throw new Error('kart-corner: the assist never entered a corner (yaw rate > 0.28 rad/s) within 120s');
  }

  await kartInput(A, 1, 0, 0, false);
  if (!want('kart-results')) {
    await closePage(A);
    return null;
  }
  // RACE_TIMEOUT_S is 300s, so the race always ends inside this window
  const watcher = watchKartResults(A, 340000);
  return { page: A, watcher };
}

// ---- section: bank -------------------------------------------------------------
const bankState = (page) => page.evaluate(() => window.__bank?.state() ?? null);
const meOf = (s) => (s === null ? null : s.players.find((p) => p.id === s.you) ?? null);

/** True while a die is still tumbling (its transform changes across 80ms). */
async function diceAnimating(page) {
  const read = () => page.evaluate(() => document.querySelector('.bd3d-die')?.style.transform ?? '');
  const a = await read();
  await sleep(80);
  const b = await read();
  return a !== b;
}

async function captureBank() {
  if (!wantAny('bank-table', 'bank-roll', 'bank-results')) return;
  const A = await launchOne('bankA');
  const B = await launchOne('bankB');
  const pages = [A, B];
  try {
    for (const p of pages) {
      await p.goto(`${BASE}/bank/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitFor(() => p.evaluate(() => !!window.__bank), 20000, '__bank ready');
    }
    await A.evaluate(() => window.__bank.createPrivate('Alice'));
    const room = await waitFor(async () => {
      const s = await bankState(A);
      return s !== null && typeof s.code === 'string' && s.code.length > 0 ? s : null;
    }, 20000, 'A createPrivate (code)');
    await B.evaluate((c) => window.__bank.joinPrivate('Bob', c), room.code);
    await waitFor(async () => {
      const [sa, sb] = await Promise.all([bankState(A), bankState(B)]);
      return sa !== null && sb !== null && sa.players.length === 2 && sb.players.length === 2 ? sa : null;
    }, 20000, 'both bank pages seated');
    await waitFor(async () => {
      const s = await bankState(A);
      return s !== null && s.phase === 'playing' ? s : null;
    }, 20000, "bank phase 'playing'");

    const currentPage = async () => {
      for (const p of pages) {
        const s = await bankState(p);
        if (s !== null && s.phase === 'playing' && s.currentId === s.you) return { page: p, state: s };
      }
      return null;
    };

    // table: mid-round with a pot on the felt and the dice settled
    if (want('bank-table')) {
      const t0 = Date.now();
      let potUp = false;
      while (Date.now() - t0 < 60000) {
        const s = await bankState(A);
        if (s !== null && s.phase === 'playing' && s.pot > 0) {
          potUp = true;
          break;
        }
        const cur = await currentPage();
        if (cur !== null) await cur.page.evaluate(() => window.__bank.roll());
        await sleep(400);
      }
      if (!potUp) throw new Error('bank-table: the pot never grew above 0 within 60s');
      await sleep(900); // the ~600ms tumble settles on the rolled faces
      await settle(A, { frames: 2, ms: 200 });
      await shot(A, 'bank-table');
    }

    // roll: captured while the dice are still tumbling
    if (want('bank-roll')) {
      let got = false;
      for (let attempt = 0; attempt < 4 && !got; attempt++) {
        const cur = await waitFor(async () => await currentPage(), 45000, 'a page whose turn it is');
        await cur.page.evaluate(() => window.__bank.roll());
        const capture = shot(cur.page, 'bank-roll');
        const stillRolling = await diceAnimating(cur.page);
        await capture;
        if (stillRolling) {
          got = true;
        } else {
          log(`[warn] bank-roll: attempt ${attempt + 1} landed after the tumble settled — re-rolling`);
          await sleep(800);
        }
      }
      if (!got) throw new Error('bank-roll: could not land a capture inside the ~600ms dice tumble after 4 rolls');
    }

    // results: bank every round out until the 10-round match ends
    if (want('bank-results')) {
      const t0 = Date.now();
      let ended = false;
      while (Date.now() - t0 < 240000) {
        const states = await Promise.all(pages.map((p) => bankState(p)));
        if (states[0] !== null && states[0].phase === 'matchEnd') {
          ended = true;
          break;
        }
        // roll the pot up first so the final scoreboard carries real numbers,
        // then everyone banks -> all_banked -> the next round
        const cur = await currentPage();
        if (states[0] !== null && states[0].phase === 'playing' && states[0].pot === 0 && cur !== null) {
          await cur.page.evaluate(() => window.__bank.roll());
          await sleep(300);
          continue;
        }
        for (let i = 0; i < pages.length; i++) {
          const s = states[i];
          if (s === null || s.phase !== 'playing') continue;
          const me = meOf(s);
          if (me !== null && me.banked === false) await pages[i].evaluate(() => window.__bank.bank());
        }
        await sleep(400);
      }
      if (!ended) throw new Error('bank-results: no matchEnd within 240s of banking every round out');
      await settle(A, { frames: 2, ms: 400 });
      await shot(A, 'bank-results');
    }
  } finally {
    for (const p of pages) await closePage(p);
  }
}

// ---- main ----------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  log(`capture-visuals: ${REQUIRED.length} shot(s) -> ${path.relative(ROOT, OUT_DIR)}${ARGS.only === null ? '' : ` (--only ${ARGS.only})`}`);
  if (REQUIRED.length === 0) throw new Error(`--only ${ARGS.only} matches no shot in the §6 list`);
  await mkdir(OUT_DIR, { recursive: true });

  // every FPS shot needs it: the map poses raycast it and fps-char navigates it
  if (REQUIRED.some((s) => s.game === 'fps')) {
    mapData = await loadMapData();
    log(`fps poses: ${mapDataNote}`);
  }

  await startServer();
  await waitForServer();
  log(`server up on ${BASE}`);
  const games = [...new Set(REQUIRED.map((s) => s.game))].filter((g) => g !== 'launcher');
  await assertProductionMounts(games);

  let kart = null;
  try {
    if (want('launcher')) await captureLauncher();
    kart = await captureKart(); // returns a live page + a background results watcher
    await captureBank();
    await captureFps();
    if (kart !== null) {
      log('waiting on the kart race to finish (results watcher)…');
      const ok = await kart.watcher;
      if (!ok) throw new Error('kart-results: the race never reached the results phase within 340s');
    }
  } finally {
    if (kart !== null) await closePage(kart.page);
  }
  log(`capture complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

let failure = null;
try {
  await main();
} catch (err) {
  failure = err instanceof Error ? err.message : String(err);
} finally {
  for (const b of browsers) {
    try {
      await b.close();
    } catch {
      // already gone
    }
  }
  if (serverChild !== null && !ARGS.keepServer) serverChild.kill('SIGTERM');
  else if (serverChild !== null) log(`--keep-server: server still running on ${BASE} (pid ${serverChild.pid})`);
}

const missing = REQUIRED.filter((s) => !manifest.some((m) => m.name === s.name));
if (failure !== null) process.stderr.write(`\nFAIL: ${failure}\n`);
if (missing.length > 0) {
  process.stderr.write(`\nFAIL: ${missing.length} required shot(s) were never captured:\n`);
  for (const s of missing) process.stderr.write(`  - ${s.name} (${s.game})\n`);
}
if (pageErrors.length > 0) {
  process.stderr.write(`\nFAIL: ${pageErrors.length} console/page error(s):\n`);
  for (const e of pageErrors) process.stderr.write(`  - ${e}\n`);
}
if (failure === null && missing.length === 0 && pageErrors.length === 0) {
  process.stderr.write(`\nOK: ${manifest.length}/${REQUIRED.length} shots, zero page errors\n`);
}
// LAST stdout line: the judge's manifest
console.log(JSON.stringify(manifest));
process.exit(failure === null && missing.length === 0 && pageErrors.length === 0 ? 0 : 1);

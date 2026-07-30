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
//                   walk to each other (e2e-style wall-following approach), the
//                   third walks to ~8m and aims at their midpoint, so one CT and
//                   one T soldier are in frame with the camera's own viewmodel.
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
// launched) · --keep-server (leave the server up for debugging).
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
const SUN_ELEVATION = 0.42; // rad — SceneRig's art-directed golden-hour sun (render/scene.ts)
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
    } else {
      throw new Error(`unknown argument '${a}' — usage: capture-visuals.mjs [--out <dir>] [--only <prefix>] [--keep-server]`);
    }
  }
  return { out, only, keepServer };
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
function startServer() {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(`missing ${path.relative(ROOT, SERVER_ENTRY)} — run 'npm run build' first`);
  }
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
  const target = sunYaw(map);
  let best = null;
  for (let i = -8; i <= 8; i++) {
    const yaw = wrapPi(target + (i / 8) * 0.6); // stay within ~34 deg of the sun
    const { dist } = freeDist(map, x, z, yaw);
    const score = Math.min(dist, 14) - Math.abs(i) * 0.25;
    if (best === null || score > best.score) best = { yaw, dist, score };
  }
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
 * the lower-right for 20s and would sit in every map shot: dismiss it through
 * its real 'NO THANKS' button.
 */
async function dismissBotPrompt(page) {
  for (let i = 0; i < 12; i++) {
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        (b.textContent ?? '').toUpperCase().includes('NO THANKS'),
      );
      if (btn === undefined) return false;
      const r = btn.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      btn.click();
      return true;
    });
    if (clicked) {
      await sleep(250);
      return true;
    }
    await sleep(250);
  }
  return false;
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
    await dismissBotPrompt(page);
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

  const walkers = new Map();
  /** e2e-style committed wall-following approach: strafe out of a wedge. */
  async function approach(page, selfPos, targetPos, initDir) {
    const yaw = yawTo(selfPos[0], selfPos[2], targetPos[0], targetPos[2]);
    await setLook(page, yaw, 0);
    let w = walkers.get(page);
    if (w === undefined) {
      w = { lastPos: null, wedgedSince: 0, dir: initDir };
      walkers.set(page, w);
    }
    const now = Date.now();
    const moved = w.lastPos === null ? 1 : Math.hypot(selfPos[0] - w.lastPos[0], selfPos[2] - w.lastPos[2]);
    w.lastPos = selfPos;
    let mx = 0;
    if (moved > 0.35) {
      w.wedgedSince = 0;
    } else {
      if (w.wedgedSince === 0) w.wedgedSince = now;
      const wedged = now - w.wedgedSince;
      if (wedged > 5000) {
        w.dir = -w.dir;
        w.wedgedSince = now;
        mx = w.dir;
      } else if (wedged > 800) {
        mx = w.dir;
      }
    }
    await setMove(page, mx, 1);
  }

  const t0 = Date.now();
  let posed = null;
  let lastLog = 0;
  while (Date.now() - t0 < 180000) {
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
      log(`fps-char t=${((Date.now() - t0) / 1000).toFixed(0)}s pairDist=${pairDist.toFixed(1)} camDist=${camDist.toFixed(1)} phase=${sa.phase}`);
    }
    if (pairDist > 5) {
      await approach(subjA, sa.pos, sb.pos, 1);
      await approach(subjB, sb.pos, sa.pos, -1);
      // the camera closes on the pair the whole time so it arrives with them
      if (camDist > 8.5) await approach(cam, sc.pos, mid, 1);
      else await setMove(cam, 0, 0);
      await sleep(200);
      continue;
    }
    await Promise.all([setMove(subjA, 0, 0), setMove(subjB, 0, 0)]);
    if (camDist > 9.5 || camDist < 5.5) {
      if (camDist > 9.5) await approach(cam, sc.pos, mid, 1);
      else {
        // too close: back off along the same bearing
        await setLook(cam, yawTo(sc.pos[0], sc.pos[2], mid[0], mid[2]), 0);
        await setMove(cam, 0, -1);
      }
      await sleep(200);
      continue;
    }
    await setMove(cam, 0, 0);
    posed = { pairDist, camDist, mid, camPos: sc.pos };
    break;
  }
  for (const p of pages) await setMove(p, 0, 0);
  if (posed === null) {
    throw new Error(
      "fps-char: the two soldiers never met at <= 5m with the camera 5.5-9.5m away within 180s (map " + mapId + ')',
    );
  }
  // aim at the pair's chests, then hold still for a clean frame
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
    await B.evaluate((c) => window.__fps.joinPrivate('Bob', c), room.code);
    await C.evaluate((c) => window.__fps.joinPrivate('Cara', c), room.code);
    await waitFor(async () => {
      const ss = await Promise.all(pages.map((p) => fpsState(p)));
      return ss.every((s) => s !== null && s.roomId === room.roomId && s.players === 3 && s.rosterSize === 3) ? ss : null;
    }, 25000, 'all three pages seated in the room');
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
        const steer = y.rate < 0 ? 1 : -1; // positive steer = RIGHT = yaw decreasing
        await setAssist(A, false); // the assist owns the steer channel
        await kartInput(A, 0.75, 0, steer, true);
        const drifting = await waitFor(
          async () => {
            const t = await kartTele(A);
            return t !== null && t.own.drifting ? t : null;
          },
          2500,
          'kart drifting',
        ).catch(() => null);
        await shot(A, 'kart-corner');
        got = true;
        await kartInput(A, 1, 0, 0, false);
        await setAssist(A, true);
        if (drifting === null) log('[warn] kart-corner: handbrake set but drifting flag never latched');
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

  if (MAP_IDS.some((m) => wantAny(`fps-${m}-a`, `fps-${m}-b`, `fps-${m}-c`))) {
    mapData = await loadMapData();
    log(`fps poses: ${mapDataNote}`);
  }

  startServer();
  await waitForServer();
  log(`server up on ${BASE}`);

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

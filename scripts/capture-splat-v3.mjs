#!/usr/bin/env node
// ============================================================================
// capture-splat-v3 — ROUND-0 visual baseline for SKI SPLAT v3 (docs/splat-v3/
// CONTRACT_V3.md §12.5, task W6). Captures 10 fixed-viewport PNGs of the game
// EXACTLY as it is on HEAD today, before any v3 visual-overhaul work lands, so
// later rounds have something to diff against.
//
// This is a CAPTURE harness, not an assertion harness (contrast
// scripts/e2e-splat.mjs, which it deliberately mirrors wherever the two
// scripts need the same plumbing): there is nothing to PASS/FAIL except "did
// every shot get written as a real, non-blank, >=1280x720 PNG".
//
// Why this is hard, and why it borrows so heavily from e2e-splat.mjs: SKI
// SPLAT cannot reach a race with one browser (MIN_PLAYERS = 2, no bots, no
// offline mode — games/splat/shared/src/config.ts), and window.__splat
// (games/splat/client/src/app.ts ~L873) exposes only state()/telemetry()/
// joinQuick()/startRace()/setInput()/setJump() — no camera control, no
// free-fly, no teleport, no pause. Every shot here is therefore a waitFor
// predicate on state().sim followed by a page.screenshot, exactly as
// e2e-splat.mjs's shot() does it.
//
// ROOM 1 (fixed seed 42, A + B): the only surface path that pins the slope
// seed is an UNJOINED startRace(42) on A (games/splat CONTRACT §7 C2) — this
// both creates the room with settings {seed:42} AND arms `pendingStart`,
// which fires the moment the room reaches MIN_PLAYERS (2). B joins by code
// through the real UI, the race starts, and A is driven down the pinned
// seed-42 slope to produce shots 1-8 and 10 in ascending-z order (NOT the
// table order — see driveToShot/bespoke shot functions below). B just cruises
// straight so the room satisfies MIN_PLAYERS; nothing is asserted about B.
//
// ROOM 2 (no seed, A + B + C): shot 9 (the iPad HUD/touch-zone shot) needs a
// THIRD, device-emulated page that is itself SEATED and RACING (a late
// joiner is parked — `seated:false` — and the touch layer only shows for a
// seated racer, see app.ts `this.seated && (phase==='countdown'||'racing')`).
// Room 1's pendingStart fires the instant a 2nd player joins, which leaves no
// window to seat a 3rd before the countdown — so, after room 1 finishes and
// returns to lobby, both A and B LEAVE, A creates a fresh (unseeded) private
// room through the real UI, B and C join by code, and the room is started
// manually (real START button) once all three are seated. This is the same
// two-room shape e2e-splat.mjs uses for its own touch-zone shot.
//
// Env: CAPTURE_PORT overrides the default port 8195 (kept distinct from
// e2e-splat's 8184 so the two can run side by side); E2E_SKIP_BUILD=1
// (exactly '1', same variable name as the e2e scripts) reuses existing dist
// output; CAPTURE_PROTOCOL_TIMEOUT ms; CAPTURE_DUMPIO=1 pipes browser stderr.
//
// Exit 0 only if all 10 shots wrote a non-blank PNG >= 1280x720 and there
// were zero page errors on any of the three pages. Otherwise the script
// reports exactly which shot(s) failed and why — it does not fabricate a
// green run, and it does not silently downscale or skip a slow capture (see
// shot() below: any single page.screenshot exceeding 30s is a hard failure).
// ============================================================================
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import puppeteer, { KnownDevices } from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.CAPTURE_PORT ?? 8195);
const BASE = `http://localhost:${PORT}`;
const GAME_URL = `${BASE}/splat/`;

const FIXED_SEED = 42; // pins room 1's slope so later rounds capture the identical corridor
const FINISH_Z = 800; // SLOPE_LENGTH in @splat/shared config

// mirrors games/splat/shared/src/config.ts (read-only reference; this script
// owns no file under games/splat/) — used only to time the manual-hop
// fallback in airShot() to its known ballistic apex.
const G_ACCEL = 9.8;
const J_HOP_VY = 1.1;

// ---- --outdir=<path> (default docs/splat-v3/round-0) -----------------------
const outdirArg = process.argv.find((a) => a.startsWith('--outdir='));
const OUTDIR = outdirArg !== undefined ? path.resolve(ROOT, outdirArg.slice('--outdir='.length)) : path.join(ROOT, 'docs/splat-v3/round-0');

// hard requirement: 1280x720 minimum, shadows + full post stack ON — no
// downscale fallback (a previous pass judged downscaled captures and it
// invalidated its own results).
const VIEWPORT = { width: 1280, height: 720 };

const MIN_DIM = { width: 1280, height: 720 };
const MIN_BYTES = 40 * 1024; // >40KB size assertion floor
const MIN_VARIANCE = 4; // pixel-variance floor (best-effort; see decodePng)

// ---- shot registry (table order, for the manifest) --------------------------
const SHOT_ORDER = [
  'v3-wide-vista.png',
  'v3-descent.png',
  'v3-veg-margin.png',
  'v3-forest-wall.png',
  'v3-atmosphere.png',
  'v3-air.png',
  'v3-body-pov.png',
  'v3-finish.png',
  'v3-hud-ipad.png',
  'v3-results.png',
];
const SHOT_DESCRIPTIONS = {
  'v3-wide-vista.png': 'wide vista — z 60-90, v>15, steer held 0',
  'v3-descent.png': 'mid-descent at speed — z 250-300, v>20',
  'v3-veg-margin.png': 'vegetation margin — z 150-200, plants near the corridor',
  'v3-forest-wall.png': 'corridor bend — z 330-380, |x| local max',
  'v3-atmosphere.png': 'atmosphere/distance haze — z 400-500',
  'v3-air.png': 'airborne, near peak height',
  'v3-body-pov.png': 'first-person body/carve — |steer|=1, v>18',
  'v3-finish.png': 'near the finish line — z>760',
  'v3-hud-ipad.png': 'iPad HUD + touch zones during racing',
  'v3-results.png': 'results screen',
};

// ---- tiny framework ----------------------------------------------------------
const pageErrors = [];
const manifest = []; // { filename, description, width, height, sizeKB, captureTimeS, z, v, airborne, status, note }
let serverChild = null;
let serverLog = '';
const browsers = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Joined a room = state().phase left 'menu'. */
function joinedState(s) {
  return s !== null && typeof s.phase === 'string' && s.phase !== 'menu';
}

// ---- PNG verification (dimension + non-blank check) -------------------------
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunks(buf) {
  const chunks = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    chunks.push({ type, data });
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return chunks;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Standard PNG scanline de-filter (bit depth 8 only — what Chrome emits). */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let rawOff = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOff];
    rawOff += 1;
    const rowStart = y * stride;
    const prevRowStart = rowStart - stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rawOff + x];
      const a = x >= bpp ? out[rowStart + x - bpp] : 0;
      const b = y > 0 ? out[prevRowStart + x] : 0;
      const c = y > 0 && x >= bpp ? out[prevRowStart + x - bpp] : 0;
      let val;
      switch (filterType) {
        case 0:
          val = rawByte;
          break;
        case 1:
          val = rawByte + a;
          break;
        case 2:
          val = rawByte + b;
          break;
        case 3:
          val = rawByte + Math.floor((a + b) / 2);
          break;
        case 4:
          val = rawByte + paeth(a, b, c);
          break;
        default:
          throw new Error(`unknown PNG filter type ${filterType}`);
      }
      out[rowStart + x] = val & 0xff;
    }
    rawOff += stride;
  }
  return out;
}

/**
 * Best-effort PNG decode: IHDR always parsed (dimensions are load-bearing);
 * pixel data only decoded for the common 8-bit, non-interlaced case Chrome
 * screenshots produce. Returns { width, height, pixels, bpp } with
 * pixels === null when decode isn't attempted/succeeds.
 */
function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return null;
  const chunks = pngChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (ihdr === undefined || ihdr.data.length < 13) return null;
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data.readUInt8(8);
  const colorType = ihdr.data.readUInt8(9);
  const interlace = ihdr.data.readUInt8(12);
  if (bitDepth !== 8 || interlace !== 0) return { width, height, pixels: null, bpp: null };
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : null;
  if (bpp === null) return { width, height, pixels: null, bpp: null };
  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  let raw;
  try {
    raw = zlib.inflateSync(idat);
  } catch {
    return { width, height, pixels: null, bpp: null };
  }
  let pixels;
  try {
    pixels = unfilter(raw, width, height, bpp);
  } catch {
    return { width, height, pixels: null, bpp: null };
  }
  return { width, height, pixels, bpp };
}

/** Sampled variance across the decoded pixel buffer — near-zero = solid colour = blank capture. */
function pixelVariance(pixels, bpp) {
  const n = pixels.length;
  if (n === 0) return null;
  const targetSamples = 20000;
  const stepPixels = Math.max(1, Math.floor(n / bpp / targetSamples));
  const step = stepPixels * bpp;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let i = 0; i < n; i += step) {
    const v = pixels[i];
    sum += v;
    sumSq += v * v;
    count++;
  }
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

/** Reads the just-written PNG back and asserts dims/size/non-blankness. Throws on any failure. */
async function verifyShot(filePath) {
  const buf = await readFile(filePath);
  const size = buf.length;
  if (size < MIN_BYTES) throw new Error(`capture is only ${size} bytes (<${MIN_BYTES} floor) — looks blank/failed`);
  const decoded = decodePng(buf);
  if (decoded === null) throw new Error('not a valid PNG (bad signature/IHDR)');
  const { width, height, pixels, bpp } = decoded;
  if (width < MIN_DIM.width || height < MIN_DIM.height) {
    throw new Error(`capture is ${width}x${height}, below the ${MIN_DIM.width}x${MIN_DIM.height} floor`);
  }
  let variance = null;
  if (pixels !== null && bpp !== null) {
    variance = pixelVariance(pixels, bpp);
    if (variance !== null && variance < MIN_VARIANCE) {
      throw new Error(`capture appears blank/solid-colour (pixel variance ${variance.toFixed(2)} < ${MIN_VARIANCE})`);
    }
  }
  return { size, width, height, variance };
}

// ---- build + server ------------------------------------------------------------
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
        console.log(`port ${PORT}: killing leftover server (pid ${pid})`);
        try {
          process.kill(Number(pid), 'SIGTERM');
        } catch {
          // already gone
        }
      } else if (cmd.length > 0) {
        console.log(`port ${PORT}: held by a non-capture process (${cmd}) — leaving it alone`);
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
    serverLog += d;
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
const LAUNCH_ARGS = [
  `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--enable-unsafe-swiftshader',
];
const PROTOCOL_TIMEOUT_MS = Number(process.env.CAPTURE_PROTOCOL_TIMEOUT ?? 300000);
const LAUNCH_OPTS = {
  headless: 'shell',
  args: LAUNCH_ARGS,
  protocolTimeout: PROTOCOL_TIMEOUT_MS,
  dumpio: !!process.env.CAPTURE_DUMPIO,
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

// ---- lobby helpers (mirrors scripts/e2e-splat.mjs) ---------------------------
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

const lobbyChipCount = (page) => page.evaluate(() => document.querySelectorAll('.lobby-players .player-chip').length);

/** INPUT_STALE_MS = 10s reaps a silent lobby-idler; toggle ASSIST twice (net-zero) to refresh liveness. */
const lobbyKeepalive = (page) =>
  page
    .evaluate(() => {
      for (const row of document.querySelectorAll('.menu-toggle')) {
        const label = row.querySelector('.menu-toggle-label');
        if (label !== null && (label.textContent ?? '').trim() === 'ASSIST') {
          const input = row.querySelector('input');
          if (input !== null) {
            input.click();
            input.click();
            return true;
          }
        }
      }
      return false;
    })
    .catch(() => false);

async function pressStart(page, label, timeoutMs = 20000) {
  await waitFor(async () => {
    const s = await splatState(page);
    return s !== null && s.canStart === true ? true : null;
  }, timeoutMs, `${label}: state().canStart === true`);
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
    }, ms, `${label}: phase leaves 'lobby'`).catch(() => null);
  let phase = clicked ? await left(8000) : null;
  for (let attempt = 0; phase === null && attempt < 3; attempt++) {
    console.log(`${label}: START button press did not move the phase (clicked=${clicked}) — falling back to __splat.startRace() (attempt ${attempt + 1})`);
    await page.evaluate(() => window.__splat?.startRace?.());
    phase = await left(4000);
  }
  console.log(`${label}: race started (button=${clicked}, phase now ${phase ?? 'still lobby'})`);
  return phase;
}

/**
 * setInput(0) does NOT return yaw to 0 — the sim has no yaw spring inside
 * YAW_MAX (games/splat/shared/src/sim.ts, mirrored by e2e-splat.mjs's own
 * steering-sign comment): a lock leaves yaw PINNED wherever it ended, and a
 * pinned non-zero yaw kills forward (z) progress (z advances by
 * ~cos(yaw)*v*dt). Any bespoke shot that applies a lock must swing yaw back
 * toward 0 with the opposite lock before the next straight-line shot, or the
 * drive crawls sideways instead of downhill (observed: a 120s stall at
 * z≈688 after a sustained lock was never straightened out).
 */
async function straighten(page, timeoutMs = 12000) {
  let sim = ownSim(await splatState(page));
  if (sim === null || Math.abs(sim.yaw) < 0.05) {
    await page.evaluate(() => window.__splat.setInput(0));
    return;
  }
  const initialSign = Math.sign(sim.yaw);
  const opposite = initialSign > 0 ? -1 : 1;
  await page.evaluate((st) => window.__splat.setInput(st), opposite);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    sim = ownSim(await splatState(page));
    if (sim === null) {
      await sleep(80);
      continue;
    }
    if (Math.abs(sim.yaw) < 0.05 || Math.sign(sim.yaw) !== initialSign) break;
    await sleep(80);
  }
  await page.evaluate(() => window.__splat.setInput(0));
}

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

// ---- screenshot ---------------------------------------------------------------
/**
 * Capture + verify. Logs wall-clock time. A capture whose page.screenshot
 * exceeds the 30s budget (its own `timeout`) throws loudly rather than
 * silently downscaling or retrying with a smaller viewport.
 */
async function shot(page, filePath, label) {
  const t0 = Date.now();
  try {
    await page.screenshot({ path: filePath, timeout: 30000 });
  } catch (err) {
    const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
    throw new Error(
      `CAPTURE EXCEEDED 30s BUDGET for ${label} (${elapsedS}s elapsed): ${err instanceof Error ? err.message : String(err)} — ` +
        `this is reported as a finding, not worked around (no downscale, no viewport shrink)`,
    );
  }
  const elapsedS = Number(((Date.now() - t0) / 1000).toFixed(1));
  console.log(`shot  ${label} (${elapsedS}s)`);
  const verified = await verifyShot(filePath);
  console.log(
    `      verified: ${verified.width}x${verified.height}, ${(verified.size / 1024).toFixed(0)}KB` +
      `${verified.variance !== null ? `, variance=${verified.variance.toFixed(1)}` : ' (variance check skipped — non-8-bit/interlaced PNG)'}`,
  );
  return { elapsedS, ...verified };
}

function recordOk(filename, sim, stats, note = '') {
  manifest.push({
    filename,
    description: SHOT_DESCRIPTIONS[filename],
    width: stats.width,
    height: stats.height,
    sizeKB: Math.round(stats.size / 1024),
    captureTimeS: stats.elapsedS,
    z: sim !== null && sim !== undefined && typeof sim.z === 'number' ? Number(sim.z.toFixed(1)) : null,
    v: sim !== null && sim !== undefined && typeof sim.v === 'number' ? Number(sim.v.toFixed(1)) : null,
    airborne: sim !== null && sim !== undefined && typeof sim.airborne === 'boolean' ? sim.airborne : null,
    status: 'ok',
    note,
  });
}

function recordFail(filename, reason) {
  manifest.push({
    filename,
    description: SHOT_DESCRIPTIONS[filename],
    width: null,
    height: null,
    sizeKB: null,
    captureTimeS: null,
    z: null,
    v: null,
    airborne: null,
    status: 'FAILED',
    note: reason,
  });
  console.log(`FAILED  ${filename}: ${reason}`);
}

// ---- generic z-window shot (shots 1, 2, 3, 5: straight-line, no maneuver) ---
async function waitForZAtLeast(page, zTarget, timeoutMs) {
  return waitFor(async () => {
    const sim = ownSim(await splatState(page));
    return sim !== null && sim.z >= zTarget ? sim : null;
  }, timeoutMs, `z >= ${zTarget}`);
}

/**
 * Drives (no steering change — caller sets steer beforehand) until sim.z
 * enters [zMin, zMax]. If `extra` is given, prefers a sample inside the
 * window that also satisfies `extra`; if the window is exited without ever
 * satisfying `extra`, falls back to the last in-window sample and notes the
 * caveat honestly rather than skipping the shot.
 */
async function driveToShot(page, filename, zMin, zMax, extra, hardTimeoutMs = 120000) {
  let lastInWindow = null;
  let matched = null;
  const t0 = Date.now();
  for (;;) {
    const sim = ownSim(await splatState(page));
    if (sim !== null) {
      if (sim.z >= zMin && sim.z <= zMax) {
        lastInWindow = sim;
        if (extra === null || extra(sim)) {
          matched = sim;
          break;
        }
      }
      if (sim.z > zMax) break;
      if (sim.finished === true) break;
    }
    if (Date.now() - t0 > hardTimeoutMs) break;
    await sleep(120);
  }
  const useSim = matched ?? lastInWindow;
  if (useSim === null) throw new Error(`never reached z in [${zMin},${zMax}] within ${hardTimeoutMs}ms`);
  const note = matched === null ? `condition not simultaneously satisfied within the z window; captured at z=${useSim.z.toFixed(1)}, v=${useSim.v.toFixed(1)} (in-window fallback)` : '';
  const stats = await shot(page, path.join(OUTDIR, filename), filename);
  recordOk(filename, useSim, stats, note);
  return useSim;
}

// ---- bespoke shots ------------------------------------------------------------

/** Shot 4: corridor bend — hold a lock through [330,380] and shoot near the |x| local max. */
async function forestWallShot(page) {
  const filename = 'v3-forest-wall.png';
  await waitForZAtLeast(page, 330, 120000);
  await page.evaluate((st) => window.__splat.setInput(st), -1);
  let peak = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const sim = ownSim(await splatState(page));
    if (sim === null) {
      await sleep(80);
      continue;
    }
    if (sim.z > 380) break;
    if (peak === null || Math.abs(sim.x) > Math.abs(peak.x)) {
      peak = sim;
    } else if (Math.abs(sim.x) < Math.abs(peak.x) - 0.05) {
      break; // started reversing — peak was the previous sample
    }
    await sleep(80);
  }
  const stats = await shot(page, path.join(OUTDIR, filename), filename);
  await straighten(page);
  if (peak === null) throw new Error('never sampled a valid sim while in the [330,380] bend window');
  const note = peak.z > 380 ? `peak detection ran past z=380 (captured at z=${peak.z.toFixed(1)})` : '';
  recordOk(filename, peak, stats, note);
  return peak;
}

/** Shot 6: airborne near peak height — ride a real kicker if one can be threaded, else a timed manual hop. */
async function airShot(page) {
  const filename = 'v3-air.png';
  const kickers = await page.evaluate(() => {
    const t = window.__splat?.telemetry?.();
    const s = window.__splat?.state?.();
    if (t === undefined || !Array.isArray(t.kickers)) return [];
    const z = s !== null && s !== undefined && typeof s.sim?.z === 'number' ? s.sim.z : 0;
    return t.kickers.filter((k) => k.z > z + 5).sort((a, b) => a.z - b.z).slice(0, 3);
  });
  let launched = null;
  const rideT0 = Date.now();
  for (const ramp of kickers) {
    if (launched !== null) break;
    let steering = 0;
    const attemptT0 = Date.now();
    while (Date.now() - attemptT0 < 15000 && Date.now() - rideT0 < 40000) {
      const sim = ownSim(await splatState(page));
      if (sim === null) break;
      if (sim.finished === true || sim.z >= ramp.z + 10) break;
      const err = ramp.x - sim.x;
      const target = sim.z < ramp.z - 3 ? (err > 0.7 ? 1 : err < -0.7 ? -1 : 0) : 0;
      if (target !== steering) {
        steering = target;
        await page.evaluate((st) => window.__splat.setInput(st), steering);
      }
      if (sim.airborne === true && sim.airVy > 1.8) {
        launched = sim;
        break;
      }
      await sleep(80);
    }
  }
  await straighten(page); // the aim-correction bursts above can leave yaw off-centre
  let note = '';
  let sampled;
  if (launched === null) {
    console.log(`${filename}: no kicker launch threaded within budget — falling back to a manual setJump() timed to its apex`);
    await page.evaluate(() => window.__splat.setJump());
    const apexMs = Math.round((1000 * J_HOP_VY) / G_ACCEL); // ~112ms — manual hop is small and fast
    await sleep(Math.max(0, apexMs - 20));
    sampled = ownSim(await splatState(page));
    note = 'no kicker launch achieved within budget; used manual setJump() timed to its computed ballistic apex (~112ms after launch)';
  } else {
    const apexMs = Math.round((1000 * launched.airVy) / G_ACCEL);
    await sleep(Math.max(0, apexMs - 30));
    sampled = ownSim(await splatState(page));
    note = `kicker-launched (airVy=${launched.airVy.toFixed(1)} m/s at launch), shot timed to the computed apex`;
  }
  const stats = await shot(page, path.join(OUTDIR, filename), filename);
  const useSim = sampled ?? launched;
  if (useSim === null) throw new Error('never obtained a readable sim during the air sequence');
  recordOk(filename, useSim, stats, note);
  return useSim;
}

/**
 * Shot 7: first-person body/carve — full lock, wait for v>18.
 *
 * CARVE_SCRUB bleeds speed fast under a SUSTAINED full lock (proportional to
 * v itself, so it compounds): a 20s hold measured empirically driving v from
 * ~20 down to ~11 m/s and pinning yaw hard enough that z basically stalled
 * for the rest of the run. So: let the run reaccelerate close to terminal
 * speed on the straight BEFORE engaging the lock, then hold the lock only
 * briefly (v>18 should already be true within a second or two if entry speed
 * was high) — and always straighten() afterward so the pin doesn't stall the
 * drive toward the finish shot.
 */
async function bodyPovShot(page) {
  const filename = 'v3-body-pov.png';
  await waitFor(async () => {
    const sim = ownSim(await splatState(page));
    return sim !== null && sim.v > 19 ? true : null;
  }, 20000, 'A reaccelerates to v>19 before engaging the body-pov lock').catch(() => {});
  await page.evaluate(() => window.__splat.setInput(1));
  let sim = null;
  const t0 = Date.now();
  const HOLD_TIMEOUT_MS = 5000; // keep the lock brief — CARVE_SCRUB bleeds speed fast
  while (Date.now() - t0 < HOLD_TIMEOUT_MS) {
    sim = ownSim(await splatState(page));
    if (sim !== null && sim.v > 18) break;
    if (sim !== null && sim.z > 760) break; // don't run past the finish window
    await sleep(60);
  }
  const stats = await shot(page, path.join(OUTDIR, filename), filename);
  await straighten(page);
  if (sim === null) throw new Error('never obtained a readable sim while holding the lock');
  const note = sim.v > 18 ? '' : `v never exceeded 18 within the ${HOLD_TIMEOUT_MS}ms hold budget (last v=${sim.v.toFixed(1)}) — the hold is kept short because CARVE_SCRUB bleeds speed fast under a sustained lock`;
  recordOk(filename, sim, stats, note);
  return sim;
}

/** Shot 8: near the finish line — z > 760. */
async function finishShot(page) {
  const filename = 'v3-finish.png';
  let sim = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    sim = ownSim(await splatState(page));
    if (sim !== null && sim.z > 760) break;
    if (sim !== null && sim.finished === true) break;
    await sleep(150);
  }
  if (sim === null || sim.z <= 760) throw new Error(`never reached z>760 within 120s (last sim.z=${sim?.z ?? 'unreadable'})`);
  const stats = await shot(page, path.join(OUTDIR, filename), filename);
  recordOk(filename, sim, stats);
  return sim;
}

/** Shot 10: results screen — phase === 'results'. */
async function resultsShot(page) {
  const filename = 'v3-results.png';
  let s = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    s = await splatState(page);
    if (s !== null && s.phase === 'results') break;
    await sleep(200);
  }
  if (s === null || s.phase !== 'results') throw new Error("never reached phase 'results' within 150s");
  const stats = await shot(page, path.join(OUTDIR, filename), filename);
  recordOk(filename, ownSim(s), stats);
  return s;
}

// ---- manifest -------------------------------------------------------------------
async function writeManifest() {
  const byName = new Map(manifest.map((m) => [m.filename, m]));
  const rows = SHOT_ORDER.map((f) => byName.get(f) ?? { filename: f, description: SHOT_DESCRIPTIONS[f], status: 'MISSING', note: 'never attempted' });
  const lines = [
    '# SKI SPLAT v3 — ROUND-0 visual baseline',
    '',
    `Captured against HEAD, fixed seed ${FIXED_SEED}, viewport ${VIEWPORT.width}x${VIEWPORT.height}, shadows + full post stack ON.`,
    '',
    '| filename | shot description | dimensions | file size | capture wall-time | sim @ capture (z, v, airborne) | status |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const dims = r.width !== null && r.width !== undefined ? `${r.width}x${r.height}` : '—';
    const size = r.sizeKB !== null && r.sizeKB !== undefined ? `${r.sizeKB}KB` : '—';
    const time = r.captureTimeS !== null && r.captureTimeS !== undefined ? `${r.captureTimeS}s` : '—';
    const sim = r.z !== null && r.z !== undefined ? `z=${r.z}, v=${r.v}, airborne=${r.airborne}` : '—';
    const status = r.note ? `${r.status} — ${r.note}` : r.status;
    lines.push(`| ${r.filename} | ${r.description} | ${dims} | ${size} | ${time} | ${sim} | ${status} |`);
  }
  lines.push('');
  await writeFile(path.join(OUTDIR, 'MANIFEST.md'), lines.join('\n'));
  console.log(`\nmanifest written: ${path.join(OUTDIR, 'MANIFEST.md')}`);
}

// ---- main -------------------------------------------------------------------------
async function main() {
  await mkdir(OUTDIR, { recursive: true });

  if (process.env.E2E_SKIP_BUILD !== '1') {
    buildAll();
  } else {
    console.log('build: skipped (E2E_SKIP_BUILD=1) — reusing the existing dist output');
    if (!existsSync(path.join(ROOT, 'games/splat/client/dist/index.html')) || !existsSync(path.join(ROOT, 'platform/server/dist/server.js'))) {
      throw new Error('E2E_SKIP_BUILD=1 but the dist output is missing — run npm run build once first');
    }
  }
  killPortLeftovers();
  startServer();
  await waitForServer();
  console.log(`server up on ${BASE} (splat client at /splat/); writing captures to ${OUTDIR}`);

  const A = await launchOne('A');
  const B = await launchOne('B');
  const C = await launchOne('C'); // iPad-emulated, parked at the menu until room 2

  await A.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(() => A.evaluate(() => !!window.__splat), 15000, '__splat on A');
  await B.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(() => B.evaluate(() => !!window.__splat), 15000, '__splat on B');

  const surfaceMissing = await A.evaluate((names) => {
    const k = window.__splat;
    return names.filter((f) => typeof k?.[f] !== 'function');
  }, ['state', 'telemetry', 'joinQuick', 'startRace', 'setInput', 'setJump']);
  if (surfaceMissing.length > 0) throw new Error(`window.__splat missing: ${surfaceMissing.join(', ')}`);

  await C.emulate(KnownDevices['iPad landscape']);
  await C.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(() => C.evaluate(() => !!window.__splat), 15000, '__splat on C (iPad)');
  await setMenuInputs(C, 'Cici', null);

  // -- ROOM 1: private room, fixed seed 42 ---------------------------------------
  await A.evaluate((seed) => window.__splat.startRace(seed), FIXED_SEED);
  const code = await waitFor(async () => {
    const s = await splatState(A);
    if (!joinedState(s)) return null;
    return await getRoomCode(A);
  }, 10000, 'A creates the seed-42 private room (code readable)');
  console.log(`room 1: code=${code}`);

  await setMenuInputs(B, 'Bob', code);
  await waitFor(() => clickButtonByText(B, 'JOIN BY CODE'), 5000, 'B clicks JOIN BY CODE');
  await waitFor(async () => {
    const s = await splatState(B);
    return joinedState(s) ? s : null;
  }, 10000, 'B joins by code');

  // arm the racing watchers BEFORE any other wait — 3s countdown, slope-build
  // latency can outlast a late-attached observer.
  const watchA = awaitRacing(A, 'room 1 A');
  watchA.catch(() => {});
  const watchB = awaitRacing(B, 'room 1 B');
  watchB.catch(() => {});

  // setInput is a no-op while drive is null — wait for state().sim first.
  await waitFor(async () => (ownSim(await splatState(A)) !== null ? true : null), 15000, "A's drive live");
  await A.evaluate(() => window.__splat.setInput(0));
  await waitFor(async () => (ownSim(await splatState(B)) !== null ? true : null), 15000, "B's drive live");
  await B.evaluate(() => window.__splat.setInput(0));

  await Promise.all([watchA, watchB]);
  await A.evaluate(() => window.__splat.setInput(0)); // re-latch at GO, belt and braces
  console.log('room 1: racing');

  // -- shots 1, 3, 2, 4, 5, 6, 7, 8, 10 in ascending-z order on A ------------------
  const attempts = [
    ['v3-wide-vista.png', () => driveToShot(A, 'v3-wide-vista.png', 60, 90, (sim) => sim.v > 15)],
    ['v3-veg-margin.png', () => driveToShot(A, 'v3-veg-margin.png', 150, 200, null)],
    ['v3-descent.png', () => driveToShot(A, 'v3-descent.png', 250, 300, (sim) => sim.v > 20)],
    ['v3-forest-wall.png', () => forestWallShot(A)],
    ['v3-atmosphere.png', () => driveToShot(A, 'v3-atmosphere.png', 400, 500, null)],
    ['v3-air.png', () => airShot(A)],
    ['v3-body-pov.png', () => bodyPovShot(A)],
    ['v3-finish.png', () => finishShot(A)],
    ['v3-results.png', () => resultsShot(A)],
  ];
  for (const [filename, fn] of attempts) {
    try {
      await fn();
    } catch (err) {
      recordFail(filename, err instanceof Error ? err.message : String(err));
    }
  }

  // -- ROOM 2: fresh unseeded room for the iPad HUD/touch-zone shot ---------------
  try {
    await Promise.all([lobbyKeepalive(A), lobbyKeepalive(B)]);
    await waitFor(async () => {
      const s = await splatState(A);
      return s !== null && s.phase === 'lobby' ? true : null;
    }, 30000, 'room 1 results -> lobby');
    await waitFor(() => clickButtonByText(A, 'LEAVE'), 10000, 'A clicks LEAVE');
    await waitFor(() => clickButtonByText(B, 'LEAVE'), 10000, 'B clicks LEAVE');
    await waitFor(async () => {
      const [sa, sb] = await Promise.all([splatState(A), splatState(B)]);
      return sa !== null && sb !== null && sa.phase === 'menu' && sb.phase === 'menu' ? true : null;
    }, 20000, 'both back at the menu after LEAVE');

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

    await setMenuInputs(C, null, code2);
    await waitFor(() => clickButtonByText(C, 'JOIN BY CODE'), 5000, 'C joins room 2');
    await waitFor(async () => {
      const [sc, ca] = await Promise.all([splatState(C), lobbyChipCount(A)]);
      return joinedState(sc) && ca === 3 ? true : null;
    }, 15000, 'C seated in room 2 (3 players)');

    await Promise.all([lobbyKeepalive(A), lobbyKeepalive(B), lobbyKeepalive(C)]);
    await pressStart(A, 'room 2 START');
    const [, , raceC] = await Promise.all([awaitRacing(A, 'room 2 A'), awaitRacing(B, 'room 2 B'), awaitRacing(C, 'room 2 C')]);
    console.log(`room 2: racing (C phases seen: [${raceC.seen.join(', ')}])`);

    await C.touchscreen.tap(590, 410).catch(() => {});
    const touchVisible = await waitFor(
      () =>
        C.evaluate(() => {
          const layer = document.querySelector('.touch-layer');
          if (layer === null || layer.classList.contains('hidden')) return null;
          const zones = layer.querySelectorAll('.touch-zone');
          return zones.length === 2 ? true : null;
        }),
      10000,
      'touch layer visible on C',
    ).catch(() => false);
    const sC = await splatState(C);
    const stats = await shot(C, path.join(OUTDIR, 'v3-hud-ipad.png'), 'v3-hud-ipad.png');
    recordOk('v3-hud-ipad.png', ownSim(sC), stats, touchVisible ? '' : 'touch layer not confirmed visible at capture time (phase===racing still satisfied)');
  } catch (err) {
    recordFail('v3-hud-ipad.png', err instanceof Error ? err.message : String(err));
  }

  await writeManifest();

  const failed = manifest.filter((m) => m.status !== 'ok');
  console.log('\n================ CAPTURE-SPLAT-V3 SUMMARY ================');
  for (const f of SHOT_ORDER) {
    const m = manifest.find((x) => x.filename === f);
    console.log(`${m !== undefined && m.status === 'ok' ? 'OK  ' : 'FAIL'}  ${f}${m !== undefined && m.note ? ` — ${m.note}` : ''}`);
  }
  console.log(`\npage errors: ${pageErrors.length}`);
  if (pageErrors.length > 0) for (const e of pageErrors) console.log(`  ${e}`);

  if (failed.length > 0 || pageErrors.length > 0) {
    throw new Error(`${failed.length} shot(s) failed, ${pageErrors.length} page error(s) — see summary above`);
  }
}

// ---- runner ---------------------------------------------------------------------------
let exitCode = 0;
try {
  await main();
  console.log('\nCAPTURE-SPLAT-V3 GREEN — all 10 shots captured');
} catch (err) {
  console.error(`\nCAPTURE-SPLAT-V3 FAILED: ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  if (serverChild && serverChild.exitCode === null) {
    serverChild.kill('SIGTERM');
    await sleep(400);
    if (serverChild.exitCode === null) serverChild.kill('SIGKILL');
  }
  process.exit(exitCode);
}

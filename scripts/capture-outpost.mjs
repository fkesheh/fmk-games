#!/usr/bin/env node
// ============================================================================
// capture-outpost — THE OUTPOST CAPTURE HARNESS (games/outpost/CONTRACT.md,
// "Verification tooling — first-class deliverables, not afterthoughts").
//
// This is not a screenshot utility; it is a MEASUREMENT harness. The previous
// OUTPOST build lost an entire art-judging round to a capture script that
// photographed three stacked modals over a black rectangle, with a player who
// had already been eaten, aimed by stale hard-coded coordinates: "All 8 PNGs
// are unjudgeable... five distinct colour bins in an entire 1920x1080 frame.
// There is no image there." Nothing here repeats that:
//
//   - every shot is FRAMED from window.__outpost.mapInfo() (features +
//     segments), never a coordinate literal. `yawTo`/`pitchTo` below are
//     local equivalents of the ones frozen in shared/src/map.ts (same
//     formula, reproduced because a plain `node` script cannot import a .ts
//     workspace package without a build step — the same constraint
//     scripts/e2e-splat.mjs works under for @splat/shared);
//   - freeCam / setTimeOfDay / clearOverlays keep every shot honestly what it
//     claims to be, and setInvulnerable(true) means the judged player is
//     never eaten mid-round;
//   - every kept PNG is decoded back to raw pixels (dependency-free PNG
//     decode, adapted from scripts/capture-splat-v3.mjs) and MEASURED against
//     VISUAL_GATES (mirrored from games/outpost/shared/src/config.ts — a
//     plain `node` script cannot import that .ts file directly, so the
//     numbers are reproduced here as constants, exactly as capture-splat-v3
//     mirrors @splat/shared's SLOPE_LENGTH as a documented comment-constant).
//     A shot that fails ANY gate is a FAILED shot, and the run exits non-zero.
//   - the horde gate is an ASSERTION: two shots per mood (the fence-combat
//     shot and the HUD-play shot) deliberately stage >=6 zombies within 12 m
//     of the camera via spawnAt, and the run FAILS if that precondition is
//     never satisfied and passed at least once — a run that dodges the
//     precondition is not exempt, it is broken.
//
// Launch/server/error-channel plumbing is modelled on scripts/e2e-splat.mjs
// (four error channels, port cleanup, bounded/verified screenshots, a
// `finally` that always reaps the server) exactly as CONTRACT.md requires.
//
// Env: CAPTURE_PORT (default 8196); E2E_SKIP_BUILD=1 reuses existing dist
// output; CAPTURE_PROTOCOL_TIMEOUT ms; CAPTURE_DUMPIO=1 pipes browser stderr;
// --outdir=<path> overrides the default docs/outpost/captures.
//
// Exit 0 only if every shot was captured, decoded, and passed every
// VISUAL_GATES check, the horde gate was exercised and passed at least once,
// and there were zero page errors. Otherwise this prints exactly which
// shot(s) failed which gate(s), with the measured numbers, and exits 1.
// ============================================================================
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.CAPTURE_PORT ?? 8196);
const BASE = `http://localhost:${PORT}`;
const GAME_URL = `${BASE}/outpost/`;

const SEED = 90210; // reproducible run; the harness stages its own zombies regardless

const outdirArg = process.argv.find((a) => a.startsWith('--outdir='));
const OUTDIR = outdirArg !== undefined ? path.resolve(ROOT, outdirArg.slice('--outdir='.length)) : path.join(ROOT, 'docs/outpost/captures');

// Full frame, shadows + post ON, deviceScaleFactor pinned to 1 so the pixels
// this script decodes are the SAME pixels telemetry().hudRect describes
// (device-pixel rects) — a DPR mismatch would silently misalign the HUD mask.
const VIEWPORT = { width: 1920, height: 1080, deviceScaleFactor: 1 };

const MOODS = ['dusk', 'night'];

// ---------------------------------------------------------------------------
// VISUAL_GATES — mirrored from games/outpost/shared/src/config.ts (frozen).
// See that file's own header for why each number is what it is; this harness
// enforces them, it does not restate the rationale.
// ---------------------------------------------------------------------------
const VISUAL_GATES = {
  minMedianLuma: 48,
  maxShadowShare: 0.08,
  shadowLuma: 20,
  blowoutLuma: 200,
  maxBlowoutShare: 0.02,
  minSurfaceStddev: 12,
  hordePixel: { minLuma: 150, maxSat: 0.4, minHueDeg: 62, maxHueDeg: 110 },
  minHordePixelShare: 0.0025,
  hordeMinZombiesForGate: 6,
  hordeGateRadius: 12,
  minShotBytes: 30 * 1024,
  maxOverlays: 0,
};

// The full OutpostDebugApi surface (shared/src/types.ts). Both harnesses
// assert this exists in full before running — a partial surface here means
// the client integrator dropped a method and every scenario below is unsafe.
const DEBUG_SURFACE = [
  'state', 'telemetry', 'join', 'createPrivate', 'joinPrivate', 'start',
  'hurtSelf', 'teleport', 'breachSegment', 'spawnAt', 'endRun', 'setInvulnerable',
  'setLook', 'setMove', 'press', 'fireOnce', 'reload', 'switchWeapon', 'buyWeapon', 'buyAmmo',
  'mapInfo', 'freeCam', 'releaseCam', 'setTimeOfDay', 'clearOverlays',
];

// ---- tiny framework ---------------------------------------------------------
const pageErrors = [];
const manifest = []; // { filename, mood, label, status, note, metrics }
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

// ---- geometry: local equivalents of shared/src/map.ts's yawTo/pitchTo ------
// Same formula as the frozen map.ts (forward = (-sin yaw, -cos yaw), per
// CONTRACT.md's coordinate convention). Positions always come from
// window.__outpost.mapInfo() at runtime — only this conversion math is
// reproduced locally, because a plain `node` script cannot import a .ts
// workspace package (see header).
function yawTo(fx, fz, tx, tz) {
  return Math.atan2(-(tx - fx), -(tz - fz));
}
function pitchTo(fx, fy, fz, tx, ty, tz) {
  const d = Math.hypot(tx - fx, tz - fz);
  return Math.atan2(ty - fy, Math.max(d, 0.5));
}

/**
 * Outward-facing unit normal for a fence side. Derived from the `side`
 * string mapInfo() returns per segment — NOT a guessed or hard-coded world
 * position. This is the same fixed orientation convention the frozen
 * shared/src/map.ts builds SEGMENTS with (north/east/south/west sides of an
 * axis-aligned square compound): a stable geometric fact of "which side this
 * is", independent of any coordinate value.
 */
function outwardNormal(side) {
  switch (side) {
    case 'north': return { x: 0, z: -1 };
    case 'east': return { x: 1, z: 0 };
    case 'south': return { x: 0, z: 1 };
    case 'west': return { x: -1, z: 0 };
    default: throw new Error(`unknown fence side "${side}" from mapInfo()`);
  }
}
function tangentOf(n) {
  return { x: -n.z, z: n.x };
}

function feat(mapInfo, key) {
  const f = mapInfo.features.find((x) => x.key === key);
  if (f === undefined) throw new Error(`mapInfo().features is missing "${key}" — contract gap or map drift`);
  return f;
}
function gateSegment(mapInfo) {
  const seg = mapInfo.segments.find((s) => s.gate === true);
  if (seg === undefined) throw new Error('mapInfo().segments has no gate segment');
  return seg;
}
function breachableSegment(mapInfo) {
  const seg = mapInfo.segments.find((s) => s.side === 'north' && s.gate === false);
  if (seg === undefined) throw new Error('mapInfo().segments has no non-gate north segment to breach');
  return seg;
}

// ---- PNG decode (dependency-free; adapted from scripts/capture-splat-v3.mjs) -
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
        case 0: val = rawByte; break;
        case 1: val = rawByte + a; break;
        case 2: val = rawByte + b; break;
        case 3: val = rawByte + Math.floor((a + b) / 2); break;
        case 4: val = rawByte + paeth(a, b, c); break;
        default: throw new Error(`unknown PNG filter type ${filterType}`);
      }
      out[rowStart + x] = val & 0xff;
    }
    rawOff += stride;
  }
  return out;
}

/**
 * Full decode for the common 8-bit, non-interlaced case Chrome screenshots
 * produce. Returns { width, height, pixels, bpp }; pixels/bpp are null when
 * the PNG is not that common case (caller must treat that as a hard failure
 * here — this harness measures real pixels, it does not skip the measurement).
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

// ---- pixel math -------------------------------------------------------------
function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
/** HSV hue (deg, 0..360) + saturation (0..1). */
function hueSat(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : d / max;
  return { h, s };
}
function isHordePixel(r, g, b, l) {
  if (l < VISUAL_GATES.hordePixel.minLuma) return false;
  const { h, s } = hueSat(r, g, b);
  return s <= VISUAL_GATES.hordePixel.maxSat && h >= VISUAL_GATES.hordePixel.minHueDeg && h <= VISUAL_GATES.hordePixel.maxHueDeg;
}
function isMasked(x, y, rects) {
  for (const r of rects) {
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
  }
  return false;
}

/**
 * ONE pass over the decoded pixel buffer computing every VISUAL_GATES input:
 * median luma / shadow share / blowout share / horde share over "the 3D
 * region" (canvas minus every telemetry().hudRect — never "the frame"), plus
 * surface stddev over the shot's own declared sampleRect (fractions of
 * width/height), also masked against the HUD.
 */
function measureShot(decoded, hudRects, sampleRectFrac) {
  const { width, height, pixels, bpp } = decoded;
  if (pixels === null || bpp === null) {
    throw new Error('PNG did not decode to raw pixels (non-8-bit/interlaced) — cannot measure VISUAL_GATES, and this harness does not skip real measurement');
  }
  const sx0 = Math.round(sampleRectFrac.x * width);
  const sy0 = Math.round(sampleRectFrac.y * height);
  const sx1 = Math.round((sampleRectFrac.x + sampleRectFrac.w) * width);
  const sy1 = Math.round((sampleRectFrac.y + sampleRectFrac.h) * height);

  const hist = new Uint32Array(256);
  let total3D = 0;
  let shadowCount = 0;
  let blowoutCount = 0;
  let hordeCount = 0;
  let sampleSum = 0;
  let sampleSumSq = 0;
  let sampleN = 0;

  for (let y = 0; y < height; y++) {
    const rowMasked = hudRects.length > 0;
    for (let x = 0; x < width; x++) {
      if (rowMasked && isMasked(x, y, hudRects)) continue;
      const idx = (y * width + x) * bpp;
      const r = pixels[idx];
      const g = pixels[idx + 1];
      const b = pixels[idx + 2];
      const l = luma(r, g, b);
      const li = Math.max(0, Math.min(255, Math.round(l)));
      hist[li] += 1;
      total3D += 1;
      if (l < VISUAL_GATES.shadowLuma) shadowCount += 1;
      if (l >= VISUAL_GATES.blowoutLuma) blowoutCount += 1;
      if (isHordePixel(r, g, b, l)) hordeCount += 1;
      if (x >= sx0 && x < sx1 && y >= sy0 && y < sy1) {
        sampleSum += l;
        sampleSumSq += l * l;
        sampleN += 1;
      }
    }
  }
  if (total3D === 0) throw new Error('the entire canvas is masked by telemetry().hudRect — no 3D region left to measure');

  let cum = 0;
  const half = total3D / 2;
  let median = 255;
  for (let i = 0; i < 256; i++) {
    cum += hist[i];
    if (cum >= half) {
      median = i;
      break;
    }
  }
  const sampleMean = sampleN > 0 ? sampleSum / sampleN : 0;
  const sampleVar = sampleN > 0 ? Math.max(0, sampleSumSq / sampleN - sampleMean * sampleMean) : 0;

  return {
    width, height, total3D,
    medianLuma: median,
    shadowShare: shadowCount / total3D,
    blowoutShare: blowoutCount / total3D,
    hordeShare: hordeCount / total3D,
    surfaceStddev: Math.sqrt(sampleVar),
    sampleN,
  };
}

function checkGates(metrics, overlays, fileSize, hordeApplicable) {
  const fails = [];
  if (overlays !== VISUAL_GATES.maxOverlays) fails.push(`overlays=${overlays} !== ${VISUAL_GATES.maxOverlays}`);
  if (fileSize < VISUAL_GATES.minShotBytes) fails.push(`fileSize=${fileSize}B < minShotBytes ${VISUAL_GATES.minShotBytes}B`);
  if (metrics.medianLuma < VISUAL_GATES.minMedianLuma) fails.push(`medianLuma=${metrics.medianLuma} < ${VISUAL_GATES.minMedianLuma}`);
  if (metrics.shadowShare > VISUAL_GATES.maxShadowShare) {
    fails.push(`shadowShare=${(metrics.shadowShare * 100).toFixed(2)}% > ${(VISUAL_GATES.maxShadowShare * 100).toFixed(1)}%`);
  }
  if (metrics.blowoutShare > VISUAL_GATES.maxBlowoutShare) {
    fails.push(`blowoutShare=${(metrics.blowoutShare * 100).toFixed(2)}% > ${(VISUAL_GATES.maxBlowoutShare * 100).toFixed(1)}%`);
  }
  if (metrics.surfaceStddev < VISUAL_GATES.minSurfaceStddev) {
    fails.push(`surfaceStddev=${metrics.surfaceStddev.toFixed(1)} < ${VISUAL_GATES.minSurfaceStddev}`);
  }
  if (hordeApplicable && metrics.hordeShare < VISUAL_GATES.minHordePixelShare) {
    fails.push(
      `hordeShare=${(metrics.hordeShare * 100).toFixed(4)}% < ${(VISUAL_GATES.minHordePixelShare * 100).toFixed(4)}% ` +
        `(precondition WAS met: >=${VISUAL_GATES.hordeMinZombiesForGate} zombies within ${VISUAL_GATES.hordeGateRadius}m — this is a real failure, not exempt)`,
    );
  }
  return fails;
}

// NOTE: createPrivate, NOT join. `join` -> quick_join, and the platform's
// quick_join message carries no `settings` field at all, so the room is made
// with debug DISABLED and every staging verb (teleport / spawnAt /
// breachSegment / setInvulnerable) silently no-ops server-side. That is what
// pinned all four shots at pos=[-2.0,8.0,-4.8] and staged "0 zombies within
// 12m". createPrivate sends settings:{debug:true}.
// ---- build + server -----------------------------------------------------------
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

function killPortLeftovers() {
  try {
    const r = spawnSync('lsof', ['-nP', `-tiTCP:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    const pids = (r.stdout ?? '').split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
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
    if (Date.now() - t0 > timeoutMs) throw new Error(`server did not serve /outpost/ on :${PORT} within ${timeoutMs}ms`);
    await sleep(250);
  }
}

// ---- browser ------------------------------------------------------------------
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
  await page.setViewport(VIEWPORT);
  const gl = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
  if (!gl) {
    console.log(`[${tag}] no hardware webgl2 — relaunching on swiftshader`);
    await browser.close();
    browsers.pop();
    browser = await puppeteer.launch({ ...LAUNCH_OPTS, args: [...LAUNCH_ARGS, '--use-gl=angle', '--use-angle=swiftshader'] });
    browsers.push(browser);
    page = await browser.newPage();
    await page.setViewport(VIEWPORT);
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

// ---- __outpost debug-API helpers ----------------------------------------------
const outpostState = (page) => page.evaluate(() => { try { return window.__outpost?.state() ?? null; } catch { return null; } });
const outpostTelemetry = (page) => page.evaluate(() => { try { return window.__outpost?.telemetry() ?? null; } catch { return null; } });
const outpostMapInfo = (page) => page.evaluate(() => { try { return window.__outpost?.mapInfo() ?? null; } catch { return null; } });

async function zombiesWithin(page, radius) {
  return page.evaluate((r) => window.__outpost.telemetry().zombiesWithin(r), radius);
}

/**
 * Polls telemetry().pos until it is horizontally near `target` — required
 * after `teleport` (server-authoritative; the client's render camera lags it
 * by at least NETCODE.interpDelayMs of interpolation) and cheap insurance
 * after `freeCam` too. A capture taken before the camera actually arrives is
 * the exact "screenshot is a lie" failure this harness exists to prevent —
 * telemetry().pos is polled here rather than assumed.
 */
async function waitForCameraNear(page, target, timeoutMs = 4000) {
  const ok = await waitFor(async () => {
    const t = await outpostTelemetry(page);
    if (t === null || !Array.isArray(t.pos)) return null;
    const dx = t.pos[0] - target.x;
    const dz = t.pos[2] - target.z;
    return Math.hypot(dx, dz) < 3 ? true : null;
  }, timeoutMs, 'telemetry().pos settled near the staged camera target').then(
    () => true,
    () => false,
  );
  if (!ok) console.log(`  WARNING: telemetry().pos did not settle within ${target.x.toFixed(1)},${target.z.toFixed(1)} +/-3m in ${timeoutMs}ms — capturing anyway`);
  return ok;
}

/**
 * Spawns a short mixed-kind line of zombies straddling `outward`*1.5 from
 * (cx, cz), spread along `tangent`, and polls until telemetry().zombiesWithin
 * reports >= hordeMinZombiesForGate within hordeGateRadius of the CURRENT
 * camera (must already be positioned before calling this). Retries a few
 * times — spawnAt returns -1 silently at HORDE.maxAlive, so the harness must
 * verify the precondition rather than assume the spawn succeeded.
 */
async function ensureHordeNear(page, cx, cz, outward, tangent) {
  const kinds = ['shambler', 'runner', 'shambler', 'brute', 'shambler', 'runner', 'spitter', 'shambler'];
  for (let attempt = 0; attempt < 4; attempt++) {
    const within = await zombiesWithin(page, VISUAL_GATES.hordeGateRadius);
    if (within >= VISUAL_GATES.hordeMinZombiesForGate) return within;
    for (let i = 0; i < kinds.length; i++) {
      const off = i - (kinds.length - 1) / 2;
      const x = cx + outward.x * 1.5 + tangent.x * off * 1.2;
      const z = cz + outward.z * 1.5 + tangent.z * off * 1.2;
      const kind = kinds[i];
      await page.evaluate((k, sx, sz) => window.__outpost.spawnAt(k, sx, sz), kind, x, z);
    }
    await sleep(500);
  }
  return zombiesWithin(page, VISUAL_GATES.hordeGateRadius);
}

// ---- scenes: each frames a shot from mapInfo(), never a literal ------------
async function stageWideTower(page, mapInfo) {
  const from = feat(mapInfo, 'towerTop');
  const to = feat(mapInfo, 'treelineNorth');
  const pos = { x: from.x, y: from.y + from.eye, z: from.z };
  const yaw = yawTo(pos.x, pos.z, to.x, to.z);
  const pitch = pitchTo(pos.x, pos.y, pos.z, to.x, to.y, to.z);
  await page.evaluate((p) => window.__outpost.freeCam(p.x, p.y, p.z, p.yaw, p.pitch), { ...pos, yaw, pitch });
  return { label: 'wide-from-tower-top', sampleRect: { x: 0.05, y: 0.55, w: 0.9, h: 0.35 }, hordeShot: false, camTarget: { x: pos.x, z: pos.z } };
}

async function stageMidfieldCombat(page, mapInfo) {
  const seg = gateSegment(mapInfo);
  const outward = outwardNormal(seg.side);
  const inward = { x: -outward.x, z: -outward.z };
  const tangent = tangentOf(outward);
  const standoff = 6;
  const pos = { x: seg.cx + inward.x * standoff, y: 1.6, z: seg.cz + inward.z * standoff };
  const yaw = yawTo(pos.x, pos.z, seg.cx, seg.cz);
  const pitch = pitchTo(pos.x, pos.y, pos.z, seg.cx, 1.0, seg.cz);
  await page.evaluate((p) => window.__outpost.freeCam(p.x, p.y, p.z, p.yaw, p.pitch), { ...pos, yaw, pitch });
  const within = await ensureHordeNear(page, seg.cx, seg.cz, outward, tangent);
  console.log(`  midfield-combat: ${within} zombies within ${VISUAL_GATES.hordeGateRadius}m of camera`);
  return { label: 'midfield-combat-at-the-fence', sampleRect: { x: 0.25, y: 0.42, w: 0.5, h: 0.42 }, hordeShot: true, camTarget: { x: pos.x, z: pos.z } };
}

async function stageTowerCloseup(page, mapInfo) {
  const from = feat(mapInfo, 'stairFoot');
  const to = feat(mapInfo, 'towerTop');
  const pos = { x: from.x, y: from.y + from.eye, z: from.z };
  const yaw = yawTo(pos.x, pos.z, to.x, to.z);
  const pitch = pitchTo(pos.x, pos.y, pos.z, to.x, to.y + to.eye, to.z);
  await page.evaluate((p) => window.__outpost.freeCam(p.x, p.y, p.z, p.yaw, p.pitch), { ...pos, yaw, pitch });
  return { label: 'structure-closeup-tower', sampleRect: { x: 0.25, y: 0.15, w: 0.5, h: 0.6 }, hordeShot: false, camTarget: { x: pos.x, z: pos.z } };
}

async function stageInteriorGround(page, mapInfo) {
  const from = feat(mapInfo, 'towerGround');
  const to = feat(mapInfo, 'stairFoot');
  const pos = { x: from.x, y: from.y + from.eye, z: from.z };
  const yaw = yawTo(pos.x, pos.z, to.x, to.z);
  const pitch = pitchTo(pos.x, pos.y, pos.z, to.x, to.y, to.z);
  await page.evaluate((p) => window.__outpost.freeCam(p.x, p.y, p.z, p.yaw, p.pitch), { ...pos, yaw, pitch });
  return { label: 'interior-tower-ground', sampleRect: { x: 0.15, y: 0.05, w: 0.7, h: 0.4 }, hordeShot: false, camTarget: { x: pos.x, z: pos.z } };
}

async function stageFenceBreached(page, mapInfo) {
  const seg = breachableSegment(mapInfo);
  await page.evaluate((id) => window.__outpost.breachSegment(id), seg.id);
  await waitFor(async () => {
    const t = await outpostTelemetry(page);
    const s = t?.segments?.[seg.id];
    return s !== undefined && s.breached === true ? true : null;
  }, 8000, `segment ${seg.id} breached`);
  const outward = outwardNormal(seg.side);
  const inward = { x: -outward.x, z: -outward.z };
  const standoff = 7;
  const pos = { x: seg.cx + inward.x * standoff, y: 1.6, z: seg.cz + inward.z * standoff };
  const yaw = yawTo(pos.x, pos.z, seg.cx, seg.cz);
  const pitch = pitchTo(pos.x, pos.y, pos.z, seg.cx, 0.3, seg.cz);
  await page.evaluate((p) => window.__outpost.freeCam(p.x, p.y, p.z, p.yaw, p.pitch), { ...pos, yaw, pitch });
  return { label: 'fence-breached', sampleRect: { x: 0.3, y: 0.4, w: 0.4, h: 0.4 }, hordeShot: false, camTarget: { x: pos.x, z: pos.z } };
}

async function stageTreeline(page, mapInfo) {
  const from = feat(mapInfo, 'fenceNorth');
  const to = feat(mapInfo, 'treelineNorth');
  const pos = { x: from.x, y: from.y + from.eye, z: from.z };
  const yaw = yawTo(pos.x, pos.z, to.x, to.z);
  const pitch = pitchTo(pos.x, pos.y, pos.z, to.x, to.y, to.z);
  await page.evaluate((p) => window.__outpost.freeCam(p.x, p.y, p.z, p.yaw, p.pitch), { ...pos, yaw, pitch });
  return { label: 'treeline', sampleRect: { x: 0.1, y: 0.3, w: 0.8, h: 0.4 }, hordeShot: false, camTarget: { x: pos.x, z: pos.z } };
}

async function stageHudPlay(page, mapInfo) {
  const seg = gateSegment(mapInfo);
  const outward = outwardNormal(seg.side);
  const inward = { x: -outward.x, z: -outward.z };
  const tangent = tangentOf(outward);
  const standoff = 5;
  const feetPos = { x: seg.cx + inward.x * standoff, y: 0, z: seg.cz + inward.z * standoff };
  const eyePos = { x: feetPos.x, y: 1.62, z: feetPos.z };
  const yaw = yawTo(eyePos.x, eyePos.z, seg.cx, seg.cz);
  const pitch = pitchTo(eyePos.x, eyePos.y, eyePos.z, seg.cx, 1.0, seg.cz);
  await page.evaluate(() => window.__outpost.releaseCam());
  await page.evaluate((p) => window.__outpost.teleport(p.x, p.y, p.z), feetPos);
  await page.evaluate((p) => window.__outpost.setLook(p.yaw, p.pitch), { yaw, pitch });
  // teleport is server-authoritative; wait for the real render camera to
  // actually arrive (past NETCODE.interpDelayMs) before trusting
  // telemetry().pos for the horde-radius check below.
  await waitForCameraNear(page, { x: eyePos.x, z: eyePos.z }, 5000);
  const within = await ensureHordeNear(page, seg.cx, seg.cz, outward, tangent);
  console.log(`  hud-play: ${within} zombies within ${VISUAL_GATES.hordeGateRadius}m of camera`);
  return { label: 'hud-play', sampleRect: { x: 0.1, y: 0.55, w: 0.3, h: 0.3 }, hordeShot: true, camTarget: { x: eyePos.x, z: eyePos.z } };
}

const SCENES = [
  ['wide-tower', stageWideTower],
  ['midfield-combat', stageMidfieldCombat],
  ['tower-closeup', stageTowerCloseup],
  ['interior-ground', stageInteriorGround],
  ['fence-breached', stageFenceBreached],
  ['treeline', stageTreeline],
  ['hud-play', stageHudPlay],
];

// ---- capture + verify -----------------------------------------------------
async function shot(page, filePath, label) {
  const t0 = Date.now();
  try {
    await page.screenshot({ path: filePath, timeout: 30000 });
  } catch (err) {
    const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
    throw new Error(`CAPTURE EXCEEDED 30s BUDGET for ${label} (${elapsedS}s elapsed): ${err instanceof Error ? err.message : String(err)}`);
  }
  return (Date.now() - t0) / 1000;
}

function recordOk(filename, mood, label, metrics, gateFails, hordeApplicable, note) {
  manifest.push({ filename, mood, label, status: gateFails.length === 0 ? 'ok' : 'FAILED', gateFails, metrics, hordeApplicable, note: note ?? '' });
}
function recordFail(filename, mood, label, reason) {
  manifest.push({ filename, mood, label, status: 'FAILED', gateFails: [reason], metrics: null, hordeApplicable: false, note: reason });
  console.log(`FAILED  ${filename}: ${reason}`);
}

// ---- manifest ---------------------------------------------------------------
async function writeManifest() {
  const lines = [
    '# OUTPOST — capture harness measured run',
    '',
    `Viewport ${VIEWPORT.width}x${VIEWPORT.height}, seed ${SEED}, moods captured: ${MOODS.join(', ')}.`,
    '',
    '| filename | mood | shot | median luma | shadow % | blowout % | surface stddev | horde % (gate applicable) | overlays | status |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const m of manifest) {
    const met = m.metrics;
    const row = met
      ? `${met.medianLuma} | ${(met.shadowShare * 100).toFixed(2)}% | ${(met.blowoutShare * 100).toFixed(2)}% | ${met.surfaceStddev.toFixed(1)} | ${(met.hordeShare * 100).toFixed(4)}% (${m.hordeApplicable}) | ${met.overlays ?? '—'}`
      : '— | — | — | — | — | —';
    lines.push(`| ${m.filename} | ${m.mood} | ${m.label} | ${row} | ${m.status}${m.gateFails.length > 0 ? ` — ${m.gateFails.join('; ')}` : ''} |`);
  }
  lines.push('');
  await writeFile(path.join(OUTDIR, 'MANIFEST.md'), lines.join('\n'));
  console.log(`\nmanifest written: ${path.join(OUTDIR, 'MANIFEST.md')}`);
}

// ---- main ---------------------------------------------------------------------
async function main() {
  await mkdir(OUTDIR, { recursive: true });

  if (process.env.E2E_SKIP_BUILD !== '1') {
    buildAll();
  } else {
    console.log('build: skipped (E2E_SKIP_BUILD=1) — reusing the existing dist output');
    if (!existsSync(path.join(ROOT, 'games/outpost/client/dist/index.html')) || !existsSync(path.join(ROOT, 'platform/server/dist/server.js'))) {
      throw new Error('E2E_SKIP_BUILD=1 but the dist output is missing — run npm run build once first');
    }
  }
  killPortLeftovers();
  startServer();
  await waitForServer();
  console.log(`server up on ${BASE} (outpost client at /outpost/); writing captures to ${OUTDIR}`);

  const page = await launchOne('J');
  await page.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(() => page.evaluate(() => !!window.__outpost), 15000, '__outpost on the page');

  const missing = await page.evaluate((names) => names.filter((n) => typeof window.__outpost?.[n] !== 'function'), DEBUG_SURFACE);
  if (missing.length > 0) throw new Error(`window.__outpost is missing methods from OutpostDebugApi: ${missing.join(', ')}`);
  console.log(`window.__outpost surface verified (${DEBUG_SURFACE.length} methods)`);

  await page.evaluate((name) => window.__outpost.createPrivate(name), 'CaptureJudge');
  await waitFor(async () => {
    const s = await outpostState(page);
    return s !== null && s.joined === true ? true : null;
  }, 15000, 'state().joined === true');

  await page.evaluate((seed) => window.__outpost.start(seed), SEED);
  await waitFor(async () => {
    const s = await outpostState(page);
    return s !== null && s.phase === 'wave' ? true : null;
  }, 15000, "state().phase === 'wave'");
  console.log('joined and started (phase=wave)');

  await page.evaluate(() => window.__outpost.setInvulnerable(true));

  const mapInfo = await outpostMapInfo(page);
  if (mapInfo === null) throw new Error('mapInfo() returned null');
  if (!Array.isArray(mapInfo.segments) || mapInfo.segments.length !== 16) {
    throw new Error(`mapInfo().segments length ${mapInfo.segments?.length ?? 'unreadable'} !== 16 (FENCE.segments) — map/contract drift`);
  }
  if (!Array.isArray(mapInfo.features) || mapInfo.features.length === 0) {
    throw new Error('mapInfo().features is empty — every shot below depends on it');
  }
  console.log(`mapInfo() verified: ${mapInfo.segments.length} segments, ${mapInfo.features.length} feature points`);

  let hordeGateExercisedAndPassed = false;

  for (const mood of MOODS) {
    await page.evaluate((m) => window.__outpost.setTimeOfDay(m), mood);
    await waitFor(async () => {
      const t = await outpostTelemetry(page);
      return t !== null && t.tod === mood ? true : null;
    }, 8000, `telemetry().tod === '${mood}'`);
    console.log(`\n== mood: ${mood} ==`);

    for (const [id, stageFn] of SCENES) {
      const filename = `${mood}-${id}.png`;
      const filePath = path.join(OUTDIR, filename);
      try {
        const { label, sampleRect, hordeShot, camTarget } = await stageFn(page, mapInfo);
        if (camTarget !== undefined) await waitForCameraNear(page, camTarget);
        await sleep(300); // let the frame settle (light rig / gait / fog) after the camera arrives

        await page.evaluate(() => window.__outpost.clearOverlays());
        await waitFor(async () => {
          const t = await outpostTelemetry(page);
          return t !== null && t.overlays === 0 ? true : null;
        }, 4000, `${filename}: telemetry().overlays === 0`).catch(() => {
          // fall through — overlays will be measured and gated below regardless
        });

        const within = await zombiesWithin(page, VISUAL_GATES.hordeGateRadius);
        const hordeApplicable = within >= VISUAL_GATES.hordeMinZombiesForGate;
        if (hordeShot && !hordeApplicable) {
          console.log(`  WARNING: ${filename} was staged as a horde shot but only ${within} zombies are within ${VISUAL_GATES.hordeGateRadius}m at capture time`);
        }

        const elapsedS = await shot(page, filePath, filename);
        const [buf, telemetry] = await Promise.all([readFile(filePath), outpostTelemetry(page)]);
        if (buf.length < VISUAL_GATES.minShotBytes) {
          throw new Error(`${filename} is only ${buf.length} bytes (< minShotBytes ${VISUAL_GATES.minShotBytes}) — looks blank/failed`);
        }
        const decoded = decodePng(buf);
        if (decoded === null) throw new Error(`${filename} is not a valid PNG (bad signature/IHDR)`);

        const hudRects = telemetry?.hudRect ?? [];
        const metrics = measureShot(decoded, hudRects, sampleRect);
        const overlays = telemetry?.overlays ?? -1;
        const gateFails = checkGates(metrics, overlays, buf.length, hordeApplicable);
        metrics.overlays = overlays;

        const p = telemetry?.pos;
        console.log(
          `  ${filename} (${elapsedS.toFixed(1)}s) — ${metrics.width}x${metrics.height}, ${(buf.length / 1024).toFixed(0)}KB, ` +
            `pos=${p !== undefined ? `[${p[0].toFixed(1)},${p[1].toFixed(1)},${p[2].toFixed(1)}]` : 'unreadable'}, ` +
            `medianLuma=${metrics.medianLuma}, shadow=${(metrics.shadowShare * 100).toFixed(2)}%, blowout=${(metrics.blowoutShare * 100).toFixed(2)}%, ` +
            `surfaceStddev=${metrics.surfaceStddev.toFixed(1)}, horde=${(metrics.hordeShare * 100).toFixed(4)}% (gate ${hordeApplicable ? 'ON' : 'off'}), overlays=${overlays}`,
        );
        if (gateFails.length > 0) console.log(`  GATE FAILURES: ${gateFails.join('; ')}`);
        else if (hordeApplicable) hordeGateExercisedAndPassed = true;

        recordOk(filename, mood, label, metrics, gateFails, hordeApplicable);
      } catch (err) {
        recordFail(filename, mood, id, err instanceof Error ? err.message : String(err));
      }
    }
  }

  await writeManifest();

  const failedShots = manifest.filter((m) => m.status !== 'ok');
  console.log('\n================ CAPTURE-OUTPOST SUMMARY ================');
  for (const m of manifest) {
    console.log(`${m.status === 'ok' ? 'OK  ' : 'FAIL'}  ${m.filename}${m.gateFails.length > 0 ? ` — ${m.gateFails.join('; ')}` : ''}`);
  }
  console.log(`\nhorde gate exercised and passed at least once: ${hordeGateExercisedAndPassed}`);
  console.log(`page errors: ${pageErrors.length}`);
  if (pageErrors.length > 0) for (const e of pageErrors) console.log(`  ${e}`);

  const problems = [];
  if (failedShots.length > 0) problems.push(`${failedShots.length} shot(s) failed VISUAL_GATES`);
  if (!hordeGateExercisedAndPassed) problems.push('the horde gate was never exercised-and-passed by any shot (a capture run where the horde never arrived within hordeGateRadius is a FAILED run, not an exempt one)');
  if (pageErrors.length > 0) problems.push(`${pageErrors.length} page error(s)`);
  if (problems.length > 0) throw new Error(problems.join('; '));
}

// ---- runner ---------------------------------------------------------------------
let exitCode = 0;
try {
  await main();
  console.log('\nCAPTURE-OUTPOST GREEN — all shots captured and passed VISUAL_GATES');
} catch (err) {
  console.error(`\nCAPTURE-OUTPOST FAILED: ${err instanceof Error ? err.message : String(err)}`);
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

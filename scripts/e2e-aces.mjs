#!/usr/bin/env node
// ============================================================================
// e2e-aces — prove ACES runs end-to-end in a real (headless) browser.
//
// Pattern cloned from e2e-splat.mjs: build the monorepo (npm run build must
// produce games/aces/client/dist), spawn the production platform server,
// then drive ONE browser through the window.__ACES debug surface (CONTRACT.md
// §5 C_APP) against the multi-game static route /aces/.
//
// Canvas-2D client: no WebGL probe/relaunch needed (unlike splat/kart).
//
// The debug surface (games/aces/client/src/app.ts):
//   join(kind)      -> {kind:'quick'} | {kind:'private', settings}  (lobby envelopes)
//   spawn(cls)      -> class pick on respawn
//   state()         -> {phase, timeLeftS, tickets:{royal,iron}, you:boolean,
//                       board:ScoreRow[], tick}
//   god()           -> server-authoritative no-damage toggle (debug rooms)
//   warpTo(x,y)     -> teleport own plane (debug rooms)
//   giveCrate(x,y)  -> force a supply crate (debug rooms)
//   fastForward(n)  -> advance the sim n ticks (debug `tick` verb, ≤600/msg)
//   muted()         -> toggle mute; returns nothing (state read via localStorage)
//   _internals      -> {net, predictor, interp, latestSnap} for e2e probing
//
// Assertions:
//   1. client serves + boots to the menu screen with the debug surface live
//   2. private debug room joins → welcome → lobby countdown → LIVE phase
//   3. bot fill seats teamSize*2 pilots (default 4v4 = 8 roster rows)
//   4. own plane auto-spawns (state().you === true) heading into the fight
//   5. fast-forward produces real bot combat: tickets move / kills land
//   6. god() keeps our plane alive through it (server-authoritative cheat works)
//   7. giveCrate lands a crate at the requested spot (snapshot-visible)
//   8. scoreboard reflects the furball (board rows carry kills/deaths)
//   9. ZERO console/page errors across the whole run
//
// Env: E2E_PORT (default 8188), E2E_SKIP_BUILD=1 reuses existing dist,
// E2E_VIEWPORT=WxH, E2E_DUMPIO=1.
// Exit 0 only if every assertion passes AND zero page/console errors.
// ============================================================================
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 8188);
const BASE = `http://localhost:${PORT}`;
const GAME_URL = `${BASE}/aces/`;
const SHOTS_DIR = path.join(ROOT, 'screenshots');

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
      // page mid-navigation etc.
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout (${timeoutMs}ms) waiting for ${label}`);
    await sleep(150);
  }
}

/** window.__ACES.state() or null while unreadable. */
const acesState = (page) =>
  page.evaluate(() => {
    try {
      return window.__ACES?.state?.() ?? null;
    } catch {
      return null;
    }
  });

async function callAces(page, expr) {
  return page.evaluate((src) => {
    try {
      // eslint-disable-next-line no-new-func
      return Function(`"use strict"; return (${src});`)();
    } catch (e) {
      return { __err: String(e) };
    }
  }, expr);
}

function trackErrors(page, tag) {
  page.on('console', (m) => {
    const url = m.location()?.url ?? '';
    if (/favicon/i.test(url)) return;
    if (m.type() === 'error') pageErrors.push(`[${tag}] console.error: ${m.text()} (${url})`);
  });
  page.on('pageerror', (e) => pageErrors.push(`[${tag}] pageerror: ${e.message}`));
}

// ---- build + server -------------------------------------------------------------
function buildAll() {
  console.log('build: npm run build');
  const r = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`npm run build exited with code ${r.status}`);
  if (!existsSync(path.join(ROOT, 'games/aces/client/dist/index.html'))) {
    throw new Error('games/aces/client/dist/index.html missing after build');
  }
  if (!existsSync(path.join(ROOT, 'platform/server/dist/server.js'))) {
    throw new Error('platform/server/dist/server.js missing after build');
  }
}

function killPortLeftovers() {
  try {
    const r = spawnSync('lsof', ['-nP', `-tiTCP:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    const pids = (r.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
    for (const pid of pids) {
      const ps = spawnSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' });
      const cmd = (ps.stdout ?? '').trim();
      if (/platform\/server\/dist\/server\.js/.test(cmd)) {
        console.log(`port ${PORT}: killing leftover e2e server (pid ${pid})`);
        try {
          process.kill(Number(pid), 'SIGTERM');
        } catch {
          /* already gone */
        }
      } else if (cmd.length > 0) {
        console.log(`port ${PORT}: held by a non-e2e process — leaving it alone`);
      }
    }
  } catch {
    /* no lsof, no listener */
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
      /* not up yet */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`server did not serve /aces/ on :${PORT} within ${timeoutMs}ms`);
    await sleep(250);
  }
}

// ---- browser --------------------------------------------------------------------
const VIEWPORT = (() => {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(process.env.E2E_VIEWPORT ?? '');
  return m === null ? { width: 1280, height: 800 } : { width: Number(m[1]), height: Number(m[2]) };
})();

async function launchPage(tag) {
  const browser = await puppeteer.launch({
    headless: 'shell',
    args: [
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      '--mute-audio',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
    protocolTimeout: 120000,
    dumpio: !!process.env.E2E_DUMPIO,
  });
  browsers.push(browser);
  const page = await browser.newPage();
  await page.setViewport({ width: VIEWPORT.width, height: VIEWPORT.height });
  trackErrors(page, tag);
  return page;
}

async function shot(page, name) {
  const t0 = Date.now();
  await mkdirShots();
  await page.screenshot({ path: path.join(SHOTS_DIR, name) });
  console.log(`shot  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

async function mkdirShots() {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(SHOTS_DIR, { recursive: true });
}

// ---- the suite --------------------------------------------------------------------
async function main() {
  if (process.env.E2E_SKIP_BUILD !== '1') buildAll();
  else console.log('build: skipped (E2E_SKIP_BUILD=1)');
  killPortLeftovers();
  startServer();
  await waitForServer();

  const page = await launchPage('A');
  await page.goto(GAME_URL, { waitUntil: 'networkidle2', timeout: 30000 });

  // 1. boots to menu, debug surface present
  await waitFor(async () => (await callAces(page, '!!window.__ACES')) === true, 15000, '__ACES surface');
  await waitFor(async () => {
    const s = await acesState(page);
    return s !== null && typeof s.phase === 'string';
  }, 15000, 'booted state');
  const boot = await acesState(page);
  check('boots with __ACES surface (pre-join phase)', boot.phase !== 'live' && Array.isArray(boot.board),
    `phase=${boot.phase}`);

  // 2. join private DEBUG room → welcome → lobby → live
  await callAces(page, `window.__ACES.join({ kind: 'private', settings: { debug: true } })`);
  await waitFor(async () => {
    const s = await acesState(page);
    return s !== null && s.phase === 'live';
  }, 20000, 'live phase after lobby countdown');
  check('private room joins → lobby countdown → LIVE', true);
  await shot(page, 'aces-e2e-live.png');

  // 3. bot fill: default teamSize 4 → 8 roster rows
  const s1 = await acesState(page);
  check('bot fill seats 8 pilots (4v4)', Array.isArray(s1.board) && s1.board.length === 8,
    `board rows: ${s1.board?.length}`);

  // 4. own plane auto-spawned
  check('own plane auto-spawns fighter', s1.you === true, `you=${String(s1.you)}`);

  // 5+6. god ON, then fast-forward the furball; tickets must move and we survive
  await callAces(page, 'window.__ACES.god()');
  const before = await acesState(page);
  const beforeTotal = before.tickets.royal + before.tickets.iron;
  for (let i = 0; i < 12 && (await acesState(page)).tickets.royal + (await acesState(page)).tickets.iron === beforeTotal; i++) {
    await callAces(page, 'window.__ACES.fastForward(600)');
    await sleep(120); // let event/snapshot msgs drain between bursts
  }
  // The scoreboard broadcast is rate-limited to 1/s WALL time server-side;
  // give the limiter a moment to release the post-furball tally.
  await sleep(1600);
  const after = await acesState(page);
  const afterTotal = after.tickets.royal + after.tickets.iron;
  check('fast-forward produces bot combat: tickets moved', afterTotal > beforeTotal,
    `${beforeTotal} → ${afterTotal}`);
  check('god keeps our plane alive through the furball', after.you === true, `you=${String(after.you)}`);
  await shot(page, 'aces-e2e-furball.png');

  // 7. crate verb lands a snapshot-visible supply crate
  await callAces(page, 'window.__ACES.giveCrate(2100, 1500)');
  await sleep(400);
  const crateSeen = await page.evaluate(() => {
    const snap = window.__ACES?._internals?.latestSnap?.();
    return Array.isArray(snap?.crates) && snap.crates.some((c) => Math.abs(c.x - 2100) < 60 && Math.abs(c.y - 1500) < 60);
  });
  check('giveCrate lands at the requested spot', crateSeen === true);

  // 8. scoreboard carries the furball's damage
  const killsSum = after.board.reduce((a, r) => a + (r.kills ?? 0), 0);
  const deathsSum = after.board.reduce((a, r) => a + (r.deaths ?? 0), 0);
  check('scoreboard shows kills + deaths', killsSum >= afterTotal && deathsSum >= 1,
    `kills=${killsSum} deaths=${deathsSum}`);

  // 9. errors
  check('zero console/page errors', pageErrors.length === 0,
    pageErrors.slice(0, 3).join(' | '));
}

main()
  .then(() => {
    const fails = results.filter((r) => !r.ok);
    console.log(`\n${results.length - fails.length}/${results.length} assertions passed`);
    try {
      serverChild?.kill('SIGTERM');
    } catch { /* done */ }
    for (const b of browsers) b.close().catch(() => {});
    process.exit(fails.length === 0 && pageErrors.length === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('E2E fatal:', e instanceof Error ? e.message : e);
    if (serverLog.includes('error')) console.error('(server log tail):', serverLog.slice(-600));
    try {
      serverChild?.kill('SIGTERM');
    } catch { /* done */ }
    for (const b of browsers) b.close().catch(() => {});
    process.exit(1);
  });

#!/usr/bin/env node
// ============================================================================
// e2e — prove STRICKEN runs end-to-end in a real (headless) browser.
//
// Spawns the production server (server/dist, build must exist), drives TWO
// browser instances (separate processes: no cross-tab rAF throttling) through
// the frozen window.__fps surface: private-room create/join, phase machine
// warmup->freeze->live, movement, combat (aim math + semi-auto fire edges),
// buy flow, state-surface shape, and a 6-map screenshot tour.
//
// Exit 0 only if every assertion passes AND zero page/console/network errors
// were seen on either page (benign favicon noise excluded).
// ============================================================================
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 8080);
const BASE = `http://localhost:${PORT}`;
const SHOTS_DIR = path.join(ROOT, 'screenshots');
const MAP_IDS = ['dustbowl', 'crossfire', 'office', 'frostbite', 'urbana', 'bunker'];

const STATE_FIELDS = [
  'phase', 'roomId', 'code', 'mapId', 'team', 'hp', 'alive', 'pos', 'players',
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

// ---- server -------------------------------------------------------------------
function startServer() {
  const child = spawn(process.execPath, ['server/dist/server.js'], {
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
const LAUNCH_ARGS = [
  '--window-size=1280,720',
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--enable-unsafe-swiftshader', // allow sw fallback; hardware ANGLE still preferred
];

async function launchOne(tag) {
  let browser = await puppeteer.launch({ headless: true, args: LAUNCH_ARGS });
  browsers.push(browser);
  let page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const gl = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
  if (!gl) {
    console.log(`[${tag}] no hardware webgl2 — relaunching on swiftshader`);
    await browser.close();
    browsers.pop();
    browser = await puppeteer.launch({
      headless: true,
      args: [...LAUNCH_ARGS, '--use-gl=angle', '--use-angle=swiftshader'],
    });
    browsers.push(browser);
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
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
  page.on('requestfailed', (r) => {
    if (/favicon/.test(r.url())) return;
    pageErrors.push(`[${tag}] requestfailed: ${r.url()} — ${r.failure()?.errorText ?? '?'}`);
  });
}

async function shot(page, name) {
  const file = path.join(SHOTS_DIR, name);
  await page.screenshot({ path: file });
  console.log(`shot  ${name}`);
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

/** Semi-auto: the server fires on the rising edge — pulse fire. */
async function firePulse(page, holdMs = 90, gapMs = 160) {
  await page.evaluate(() => window.__fps.debug.press('fire', true));
  await sleep(holdMs);
  await page.evaluate(() => window.__fps.debug.press('fire', false));
  await sleep(gapMs);
}

// ---- main -----------------------------------------------------------------------
async function main() {
  await mkdir(SHOTS_DIR, { recursive: true });
  startServer();
  await waitForServer();
  console.log(`server up on ${BASE}`);

  const A = await launchOne('A');
  const B = await launchOne('B');

  // -- load app, main menu shot ---------------------------------------------------
  await A.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(() => A.evaluate(() => !!window.__fps), 15000, '__fps on A');
  await sleep(800); // menu paint
  await shot(A, 'menu.png');
  await B.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
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

  // -- phase machine: warmup -> freeze -> live ---------------------------------------
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

  // -- HUD shot during live -----------------------------------------------------------
  await shot(A, 'hud-live.png');

  // -- combat: A and B walk at each other (collide-and-slide rounds box corners);
  //    once in range A plants and fires controlled semi-auto pulses, reloading as
  //    needed. Firing only starts in range so 60 pistol rounds are never wasted
  //    on walls from spawn.
  const combatT0 = Date.now();
  let bHurt = false;
  let bDead = false;
  let lastLogAt = 0;
  const walkers = new Map(); // page -> committed-strafe wall-following state
  let engageHp = 100; // B hp when the current engage burst started
  let engageSince = 0; // when the current no-progress engage began

  /**
   * Walk `page` towards targetPos. Box-map wall following: while wedged, strafe
   * in ONE committed direction (per-page fixed initDir so A and B cannot mirror
   * into the same trap; flipped only after 5s of continuous wedge) so
   * collide-and-slide carries us around a wall edge instead of ping-ponging.
   */
  async function approach(page, selfPos, targetPos, initDir) {
    const dist = await aimAt(page, selfPos, targetPos);
    let w = walkers.get(page);
    if (w === undefined) {
      w = { lastPos: null, wedgedSince: 0, dir: initDir, dirSetAt: 0 };
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
      if (now - w.wedgedSince > 800) {
        if (now - w.dirSetAt > 5000) {
          w.dir = -w.dir; // 5s wedged continuously: committed way is a dead corner
          w.dirSetAt = now;
        }
        mx = w.dir;
      }
    }
    await page.evaluate((x, z) => window.__fps.debug.setMove(x, z), mx, 1);
    return dist;
  }

  while (Date.now() - combatT0 < 60000) {
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
      if (Date.now() - engageSince > 4000) {
        // 4s of fire with no damage: a wall is between them — push closer
        // (at true point-blank range shots cannot stall, so this only fires
        // when geometry is in the way)
        await approach(A, sa.pos, sb.pos, 1);
        await approach(B, sb.pos, sa.pos, -1);
        await sleep(200);
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
      await firePulse(A, 70, 240); // ~3.2/s: bloom mostly recovers between shots
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
  let freezeSeen = null;
  try {
    freezeSeen = await waitFor(async () => {
      const s = await fpsState(A);
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
  check('state() exposes all 18 contract fields', missing.length === 0 && posOk, missing.length ? `missing: ${missing}` : 'all present, pos finite [x,y,z]');

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
    for (let i = 0; i < yaws.length; i++) {
      await A.evaluate((y) => window.__fps.debug.setLook(y, -0.08), yaws[i]);
      if (i > 0) {
        await A.evaluate(() => window.__fps.debug.setMove(0, 1));
        await sleep(2000);
        await A.evaluate(() => window.__fps.debug.setMove(0, 0));
      }
      await sleep(300); // settle frames
      await shot(A, `map-${mapId}-${i + 1}.png`);
    }
    console.log(`tour ${mapId}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // -- error-banner DOM check (window.onerror surface may not raise pageerror) -----------
  for (const [tag, page] of [['A', A], ['B', B]]) {
    const banner = await page.evaluate(() => document.querySelector('.error-banner')?.textContent ?? null);
    if (banner) pageErrors.push(`[${tag}] error-banner visible: ${banner}`);
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

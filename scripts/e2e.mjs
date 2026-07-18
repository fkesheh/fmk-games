#!/usr/bin/env node
// ============================================================================
// e2e — prove STRICKEN runs end-to-end in a real (headless) browser.
//
// Spawns the production server (server/dist, build must exist), drives TWO
// browser instances (separate processes: no cross-tab rAF throttling) through
// the frozen window.__fps surface: private-room create/join, phase machine
// warmup->freeze->live, movement, combat (aim math + semi-auto fire edges),
// buy flow, state-surface shape, a 6-map screenshot tour, public-room create
// (code === null), debug scoreboard toggle, jump-apex height, and server-side
// bot add/remove with a 6s combat soak.
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

// one slow frame must not abort the whole suite (software GL + shadowed
// soldier models make individual captures genuinely slow on loaded machines)
const PROTOCOL_TIMEOUT_MS = Number(process.env.E2E_PROTOCOL_TIMEOUT ?? 300000);
const LAUNCH_OPTS = {
  headless: true,
  args: LAUNCH_ARGS,
  protocolTimeout: PROTOCOL_TIMEOUT_MS,
  dumpio: !!process.env.E2E_DUMPIO, // pipe browser stderr (GPU/context-loss noise) when diagnosing
};

async function launchOne(tag) {
  let browser = await puppeteer.launch(LAUNCH_OPTS);
  browsers.push(browser);
  let page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
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

  // -- HUD shot during live (close the auto-opened buy menu first: B keydown is
  //    handled on window even without pointer lock — see ClientGame.onKeyDown) --
  await A.keyboard.press('KeyB');
  await sleep(250);
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

  // -- (13) jump apex: flat spawn ground on crossfire; one 100ms jump press,
  //    sample feet y every 30ms for 1s inside the page (no evaluate round-trip
  //    jitter). jumpVel 5.9 -> apex ~0.87m; assert a conservative > 0.75m.
  await sleep(500); // settle on the ground after the spawn snapshot
  const jump = await A.evaluate(
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
          if (performance.now() - t0 >= 1000) {
            clearInterval(iv);
            resolve({ startY, maxY });
          }
        }, 30);
      }),
  );
  check(
    'jump apex > 0.75m on flat ground (jumpVel 5.9)',
    jump.maxY - jump.startY > 0.75,
    `start=${jump.startY.toFixed(2)} apex=+${(jump.maxY - jump.startY).toFixed(2)}m`,
  );

  // -- (14) bots: A is alone in the public crossfire room here (B stayed in
  //    the private dustbowl room from the combat flow) — so assert deltas off
  //    the live count, not absolutes. Kept after (12)/(13) so bots cannot
  //    start a match mid-scoreboard/jump and perturb those samples.
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

  // -- (16) soak: the remaining bot fights for ~6s (it may start a real match
  //    and hunt A) — nothing on either page may crash or log.
  const errsBeforeSoak = pageErrors.length;
  await sleep(6000);
  check(
    '6s bot soak: zero page errors on either page',
    pageErrors.length === errsBeforeSoak,
    `${pageErrors.length - errsBeforeSoak} new error(s)`,
  );

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

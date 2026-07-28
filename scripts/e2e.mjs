#!/usr/bin/env node
// ============================================================================
// e2e — prove STRICKEN runs end-to-end in a real (headless) browser.
//
// Spawns the production server (server/dist, build must exist), drives TWO
// browser instances (separate processes: no cross-tab rAF throttling) through
// the frozen window.__fps surface: private-room create/join, phase machine
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
// players; an unknown command returns an error string).
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
const GAME_URL = `${BASE}/fps/`; // the launcher lives at /; the fps client is mounted at /fps/
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

// ---- server -------------------------------------------------------------------
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
  //    once in range A plants and fires frame-rate-proof confirmed shots
  //    (fireOneShot — see its note on the AAA-scene rAF collapse), reloading as
  //    needed. Firing only starts in range so 60 pistol rounds are never wasted
  //    on walls from spawn. Budget is 90s wall-clock: the approach is
  //    geometry-bound (dustbowl mid walls cost 20-35s of parallel sliding) and
  //    confirmed shots run ~2/s at degraded fps.
  const combatT0 = Date.now();
  let bHurt = false;
  let bDead = false;
  let lastLogAt = 0;
  const walkers = new Map(); // page -> committed-strafe wall-following state
  let engageHp = 100; // B hp when the current engage burst started
  let engageSince = 0; // when the current no-progress engage began
  let burstDir = 1; // lateral-burst direction; flips per stall (side walls)

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

  while (Date.now() - combatT0 < 90000) {
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
        // 4s of fire with no damage: geometry blocks the line — a crate row can
        // sit between them even at 2m (firing through it forever is the other
        // failure mode, so range alone must not suppress this). Committed
        // lateral burst to break LOS symmetry (A strafes one way, B the other
        // so they cannot mirror into the same trap; the direction flips on
        // each successive stall in case a side wall eats the first burst),
        // then RE-ARM the fire window: after relocating, the next burst either
        // lands (engageHp reset) or re-triggers the burst ~4s later.
        const d = burstDir;
        await A.evaluate((x) => window.__fps.debug.setMove(x, 0), d);
        await B.evaluate((x) => window.__fps.debug.setMove(x, 0), -d);
        await sleep(1200);
        await A.evaluate(() => window.__fps.debug.setMove(0, 0));
        await B.evaluate(() => window.__fps.debug.setMove(0, 0));
        burstDir = -burstDir;
        engageSince = Date.now();
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

  // -- (17) team switch: frozen semantics — immediate apply in warmup; queued
  //    and applied at the next beginFreeze (guard re-evaluated) in any other
  //    phase. Post-soak the room holds A + 1 bot, so the queued path dominates.
  //    Detection is a TEAM wait, not a phase wait: once the flip lands the old
  //    team is empty, so the room forfeit-cycles with ONE-TICK (~33ms) freezes
  //    that a 150ms phase poll can never catch — the flipped team persists for
  //    rounds and is the reliable signal. 1v1 => the guard always allows this
  //    switch (1 < 1 + 1). The 5s immediate window covers the warmup path; the
  //    long window covers a full round (live 100s + roundEnd 4s + matchEnd
  //    detour) for the queued one.
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

  // -- (18) team_full guard: after (17), A shares a team with the soak bot and
  //    the other team is EMPTY — so B's quick-join (the only public room)
  //    deterministically lands B alone on the small team: a 2v1. B requests
  //    the larger team; the guard (target >= other + 1) must deny it. A bare
  //    "no flip within 3s" cannot tell DENIED from ALLOWED-but-queued (a grant
  //    would apply only at the next beginFreeze), so the attempt is made
  //    during roundEnd (next freeze ~4s out; the post-(17) forfeit cycle keeps
  //    roundEnds frequent) and B's team is watched from the attempt THROUGH
  //    that beginFreeze +5s: the guard re-evaluates there, so surviving it
  //    proves the request was dropped, not merely pending. Round 5's roundEnd
  //    is skipped: the halftime swap at its end flips EVERYONE, guard or no
  //    guard. (Dev note: shaping via addBot alone is impossible — pickTeam
  //    auto-balances with a coin flip on ties and removeBot is LIFO — hence
  //    the second human as the switcher.)
  const aRoom18 = (await fpsState(A)).roomId;
  await B.evaluate(() => window.__fps.joinQuick('Bob'));
  let bIn18 = null;
  try {
    bIn18 = await waitFor(async () => {
      const [sa, sb] = await Promise.all([fpsState(A), fpsState(B)]);
      return sb !== null && sb.roomId !== null && sb.roomId === aRoom18 && sb.team !== sa.team
        ? sb
        : null;
    }, 15000, 'B quick-join into A public room on the opposite team');
  } catch {
    bIn18 = null; // reported by the failing check below; (18) guard check is skipped
  }
  let denied18 = false;
  let detail18 = '';
  if (bIn18 === null) {
    detail18 = `B failed to land on the opposite team (in ${(await fpsState(B)).roomId}, want ${aRoom18})`;
  } else {
    try {
      // arm the attempt inside a roundEnd (re-issue if the phase raced past)
      let bTeam18 = null;
      let bTarget18 = null;
      for (let tries = 0; tries < 2 && bTeam18 === null; tries++) {
        const safe = await waitFor(async () => {
          const s = await fpsState(B);
          return s !== null && s.phase === 'roundEnd' && s.round !== 5 ? s : null;
        }, 120000, "roundEnd with round !== 5 for the guard attempt");
        const target = safe.team === 'T' ? 'CT' : 'T';
        await B.evaluate((t) => window.__fps.debug.switchTeam(t), target);
        const now = await fpsState(B);
        if (now !== null && now.phase === 'roundEnd') {
          bTeam18 = safe.team;
          bTarget18 = target;
        }
      }
      if (bTeam18 === null) throw new Error('could not attempt during roundEnd (phase raced twice)');
      // watch from the attempt through the NEXT transition into freeze +5s
      const t0 = Date.now();
      let prevPhase = 'roundEnd';
      let freezeAt = 0;
      let changedTo = null;
      while (Date.now() - t0 < 125000) {
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
          if (freezeAt !== 0 && Date.now() - freezeAt >= 5000) break; // freeze passed, request dropped
        }
        await sleep(200);
      }
      denied18 = changedTo === null && freezeAt !== 0;
      detail18 =
        `B=${bTeam18} target=${bTarget18}` +
        (changedTo !== null
          ? ` FLIPPED to ${changedTo} — guard let it through`
          : freezeAt === 0
            ? ' — no freeze within 125s, inconclusive'
            : ' — unchanged through beginFreeze + 5s (denied, request dropped)');
    } catch (err) {
      denied18 = false;
      detail18 = `aborted: ${err instanceof Error ? err.message : String(err)}`;
    }
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

  // -- (22) spectate visual sanity: the setup above shaped the (20) room to a
  //    3v2 (A + 2 bot teammates; re-rolled coin flips — in a plain 2v2 the lone
  //    teammate dies its 1v2 first and A's death never gets a spectateTarget).
  //    DEVIATION from the letter of the spec ("B's chip"): the chip can NEVER
  //    appear for B in the private-room 1v1 — the server assigns spectateTarget
  //    as the first alive TEAMMATE (game.ts updateSpectators), so a lone dead
  //    player gets null and the chip stays hidden (see death-spectate.png:
  //    corpse cam, no chip). A's death in this 2v2 is the contract-conformant
  //    way to observe 'SPECTATING X'. A is herded INTO THE ENEMY HALF
  //    (defenseless, target side latched per life) so it dies at the START of
  //    the fight while every teammate is alive — mid-standing A survives whole
  //    rounds, and late deaths can follow a teammate's (null target). Bots
  //    engage only within 45m awareness. The chip (#hud .fh-spec, hud.ts) is
  //    polled across every death
  //    window for 240s; once 'SPECTATING <name>' shows, assert nothing blacks
  //    out the view — no #hud/#menu element covering >40% of the viewport with
  //    a near-opaque (alpha >= 0.5) black-ish non-gradient background
  //    (body/#app are the page's opaque ink backdrop by design; the .fh-vig
  //    vignette is a radial gradient). One legit overlay is EXCLUDED by
  //    dismissal: when A dies close to a round boundary, the next freeze
  //    auto-opens the buy menu over the spectate view (an open .m9-layer-buy
  //    IS a 78%-ink full-viewport layer) — it is closed with B and that sample
  //    skipped rather than counted as a blackout.
  let specOk = false;
  let specDetail = '';
  let chipSeen = null;
  let blackouts = [];
  const specDeadline = Date.now() + 240000;
  let lastSpecLog = 0;
  let rushTargetZ = null; // latched per life: the ENEMY side of the map
  while (Date.now() < specDeadline && chipSeen === null) {
    const s = await fpsState(A);
    if (s !== null && s.alive) {
      // Push A into the ENEMY half, not just mid: rounds where A stands at mid
      // end with the teammates winning before A is touched (no death window at
      // all — observed: 1 death in 180s), and mid-fight deaths can come after
      // a teammate fell (null target). Dying deep in the enemy rush happens at
      // the START of the fight, while every teammate is still alive. Bots only
      // engage within 45m awareness, so A must cross the map. The target side
      // is latched per life (A respawns on its own side each round).
      if (rushTargetZ === null) rushTargetZ = s.pos[2] >= 0 ? -23 : 23;
      const yaw = yawTo(s.pos[0], s.pos[2], 0, rushTargetZ);
      await A.evaluate((y) => {
        window.__fps.debug.setLook(y, 0);
        window.__fps.debug.setMove(0, 1);
      }, yaw);
    }
    if (s !== null && !s.alive) {
      rushTargetZ = null; // relatch on the next respawn
      const buyOpen22 = await A.evaluate(() => {
        const el = document.querySelector('.fps-menus .m9-layer-buy');
        return el !== null && getComputedStyle(el).display !== 'none';
      });
      if (buyOpen22) {
        await A.keyboard.press('KeyB'); // legit freeze buy menu, not a blackout
        await sleep(200);
        continue;
      }
      const chip = await A.evaluate(() => {
        const el = document.querySelector('#hud .fh-spec');
        if (el === null) return null;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          text: el.textContent ?? '',
          visible: cs.display !== 'none' && r.width > 0 && r.height > 0,
        };
      });
      if (Date.now() - lastSpecLog > 4000) {
        lastSpecLog = Date.now(); // evidence for future flakes (death windows seen)
        console.log(`spectate22: A dead phase=${s.phase} chip=${JSON.stringify(chip)}`);
      }
      if (chip !== null && chip.visible && chip.text.toUpperCase().includes('SPECTATING')) {
        chipSeen = chip; // ~within one poll (<=250ms) of the death snapshot
        blackouts = await A.evaluate(() => {
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
        });
      }
    }
    await sleep(150);
  }
  await A.evaluate(() => window.__fps.debug.setMove(0, 0));
  if (chipSeen === null) {
    specDetail = 'no SPECTATING chip observed across 240s of death windows';
  } else {
    specOk = blackouts.length === 0;
    specDetail =
      `chip=${JSON.stringify(chipSeen)}` +
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
  //    Flow: fresh private crossfire room + 1 bot; round 1 C rushes
  //    defenseless (meets the bot halfway, dies fast); every round outcome
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
    await C.evaluate(() => window.__fps.debug.setMove(0, 1)); // rush until round 1 ends
    const rich24 = await waitFor(async () => {
      const s = await fpsState(C);
      if (s === null) return null;
      if (s.phase === 'live' || s.phase === 'warmup') {
        await C.evaluate(() => window.__fps.debug.setMove(0, 1)); // re-assert the rush
      }
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
    const before25 = (await fpsState(C)).players;
    const nonsense = await C.evaluate(() => window.__fps.debug.console('nonsense'));
    await C.evaluate(() => window.__fps.debug.console('addbot 2'));
    const populated25 = await waitFor(async () => {
      const s = await fpsState(C);
      return s !== null && s.players === before25 + 2 ? s : null;
    }, 5000, 'players +2 after console addbot 2');
    conOk = typeof nonsense === 'string' && nonsense.trim() !== '';
    conDetail = `nonsense -> ${JSON.stringify(nonsense)}; players ${before25} -> ${populated25.players}`;
  } catch (err) {
    conDetail = err instanceof Error ? err.message : String(err);
  }
  check('console: addbot 2 adds 2 players; unknown command returns an error string', conOk, conDetail);

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

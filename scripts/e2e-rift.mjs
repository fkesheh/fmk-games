#!/usr/bin/env node
// ============================================================================
// e2e-rift — prove ANCIENTS (rift) runs end-to-end in real (headless) browsers.
//
// Serves the BUILT platform (platform/server/dist/server.js on E2E_PORT,
// default 8091 — the client dist must already exist; this suite NEVER builds),
// then drives TWO separate browser processes (no cross-tab timer throttling)
// through the frozen window.__rift debug surface (games/rift/CONTRACT.md §6)
// against the multi-game static route /rift/.
//
// THE MATCH: a private room with settings { teamSize: 2, speed: 20 }. Two
// humans (Alice, Bob) seat on opposite teams; the room bot-fills each side to
// 2v2. LANES_FOR_TEAM_SIZE[2] = 1, so rift_begin must say lanes=1 teamSize=2.
// speed=20 is the contract's public e2e hook (CONTRACT §2): the room ticks at
// period max(1, round(1000 / TICK_RATE / speed)) ≈ 3ms, so a match the balance
// harness measures at 12-18 min game-time resolves in roughly 1-4 min of wall
// clock. The end-poll timeout is 6 minutes; the expected end reason is
// 'ancient' (the 30:00 game-time hard cap is a backstop, not the plan).
//
// Every assertion goes through the debug surface (state/snaps/lastEvents/
// messageLog), never the DOM. Snapshots are ~20Hz * speed, so the 32-entry
// snaps() ring holds ~0.1s of history and the 4000-frame messageLog ~13s —
// anything this suite needs later is read immediately (the lobby code) or
// taken from lastEvents() (rift_end is the LAST event a match emits, so the
// 32-event ring can never flush it before the poll sees it).
//
// Mirrored (never imported) config facts the harness times itself against:
//   TICK_RATE 20, WAVE_FIRST_AT_S 10 (-> first creeps at matchTick 200),
//   STARTING_GOLD 600, bladestone cost 400, FOUNTAIN_RADIUS 6, side at 1 lane
//   96, team0 ancient (11,11), team1 (85,85), LOBBY_COUNTDOWN_MS 3000 real ms.
//
// TERRAIN PASS (checks 15-16). Two wire-level facts the terrain build adds and
// nothing else in this suite would notice if they silently stopped arriving:
//   * rift_snap.dayPhase (TERRAIN_CONTRACT §6) — present, finite, inside
//     [0,1] on every sampled snap, and actually MOVING across the match. At
//     speed 20 a DAY_PERIOD_S=600 cycle takes 30s of wall clock, so a 12-18
//     game-minute match sweeps well over one full cycle.
//   * neutral jungle camps (TERRAIN_CONTRACT §5) — the hero is walked to a
//     camp clearing whose coordinates come from buildTerrain(1) IN THIS
//     PROCESS (terrain is a pure function of the lane count and never goes on
//     the wire), and team-2 camp entities must then appear in its snapshots.
//     That single check covers camp spawn, the third team on the wire, and
//     neutral entities surviving the room's fog filter.
//
// Exit 0 only if every numbered check passes AND zero page/console/network
// errors were seen on either page (benign favicon noise excluded).
// SUBPROCESS DISCIPLINE: the platform server is never judged by its piped
// output — its exit code and signal are recorded on the 'exit' event and an
// unrequested death is a failed check, not a log line.
// ============================================================================
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { CAMP_STAND_MAX_M, CAMP_STAND_MIN_M, CAMP_VISIBLE_M, loadTerrain, terrainFacts } from './rift-terrain-facts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 8091);
const BASE = `http://localhost:${PORT}`;
const SHOTS_DIR = path.join(ROOT, 'screenshots');

// ---- mirrored config (games/rift/shared/src/config.ts — pure data) ------------
const TICK_RATE = 20;
const WAVE_FIRST_TICK = 10 * TICK_RATE; // 200
const STARTING_GOLD = 600;
const BLADESTONE_COST = 400;
const LOBBY_COUNTDOWN_MS = 3000;
const SETTINGS = { teamSize: 2, speed: 20 };
const EXPECT_LANES = 1;
const EXPECT_TEAM_SIZE = 2;
const END_TIMEOUT_MS = Number(process.env.E2E_END_TIMEOUT ?? 360000); // 6 min

// ---- terrain facts for the camp check (pure function of the lane count) -----
// Loaded from INSIDE main()'s try, never at module scope: the Node-version
// check and the type-stripped import of terrain.ts can both throw, and at
// module scope that killed the suite before its handler existed — no checks
// recorded, no summary, indistinguishable from a suite that never ran.
// The camp stand-off derivation and CAMP_VISIBLE_M come from the same shared
// module as the two capture harnesses; all three used to carry their own copy.
let MAP_SIDE = 0; // 96 at 1 lane — read, never assumed
/** buildTerrain(EXPECT_LANES) facts, for `campStand`. */
let FACTS = null;
/** Camp clearings ordered nearest-first to the map centre, so the hero walks
 *  to the one it can reach soonest from either fountain. */
let CAMPS = [];
// At speed 20 a second of wall clock is 20 game-seconds, so the old 90 s budget
// was ~30 game-MINUTES — the match hard cap. With camps unwired this check
// alone could consume the entire match and take the three checks after it down
// with it. The walk itself is a few dozen metres at hero speed: under 20 game-
// seconds. 20 s of wall clock is still ~400 game-seconds of slack.
const CAMP_WALK_TIMEOUT_MS = 20000;
const DAY_PHASE_SWEEP_MIN = 0.25; // a 12+ game-minute match at DAY_PERIOD_S 600
//   sweeps more than one full cycle; anything under a quarter of one means the
//   phase is pinned, frozen or not derived from matchTick at all

// fields the CONTRACT.md §6 debug surface freezes for window.__rift.state()
const RIFT_STATE_FIELDS = ['phase', 'connected', 'you', 'team', 'hero', 'gold', 'tick', 'ents', 'positions'];

// ---- tiny framework -------------------------------------------------------------
const results = [];
const pageErrors = [];
const pages = []; // [page, tag] for state-at-abort dumps
let serverChild = null;
let serverDied = null; // a mid-run exit we did not ask for
let tearingDown = false;
const browsers = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = '', { fatal = false } = {}) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok && fatal) throw new Error(`fatal check failed: ${name}`);
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

/** Compact observed-state digest for failure messages. */
function digest(s) {
  if (s === null || s === undefined) return 'state=null';
  return `phase=${s.phase} conn=${s.connected} team=${s.team} hero=${s.hero} ` +
    `gold=${s.gold} tick=${s.tick} ents=${s.ents}`;
}

// ---- server -----------------------------------------------------------------------
function startServer() {
  const serverJs = path.join(ROOT, 'platform/server/dist/server.js');
  const clientIndex = path.join(ROOT, 'games/rift/client/dist/index.html');
  if (!existsSync(serverJs)) throw new Error('platform/server/dist/server.js missing — build first (this suite never builds)');
  if (!existsSync(clientIndex)) throw new Error('games/rift/client/dist/index.html missing — build first (this suite never builds)');
  const child = spawn(process.execPath, ['platform/server/dist/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverChild = child;
  child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`[server!] ${d}`));
  child.on('exit', (code, signal) => {
    // Recorded by EXIT CODE, never inferred from the piped log. A server that
    // dies mid-run leaves both pages rendering their last snapshot, so every
    // later assertion reads a frozen world as a healthy one.
    if (tearingDown) return;
    serverDied = { code, signal };
    console.log(`[server] EXITED mid-run (code ${code}, signal ${signal})`);
  });
}

async function waitForServer(timeoutMs = 25000) {
  const t0 = Date.now();
  for (;;) {
    if (serverChild.exitCode !== null) throw new Error(`server exited early (${serverChild.exitCode})`);
    try {
      const res = await fetch(`${BASE}/rift/`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`server did not serve /rift/ on :${PORT} within ${timeoutMs}ms`);
    await sleep(250);
  }
}

// ---- browser ------------------------------------------------------------------------
// WebGL client (three.js): same launch pattern as e2e-kart — the headless shell
// provides webgl2 via SwiftShader when no hardware GL answers, and the
// anti-throttling flags keep the ~400Hz snap stream + render loop at rate.
// Two SEPARATE browser processes: no cross-tab timer throttling.
const VIEWPORT = (() => {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(process.env.E2E_VIEWPORT ?? '');
  return m === null ? { width: 640, height: 360 } : { width: Number(m[1]), height: Number(m[2]) };
})();
const LAUNCH_ARGS = [
  `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--enable-unsafe-swiftshader', // allow sw fallback; hardware ANGLE still preferred
];
const LAUNCH_OPTS = {
  headless: 'shell', // the shell's software pipeline never wedges (see e2e-kart)
  args: LAUNCH_ARGS,
  protocolTimeout: Number(process.env.E2E_PROTOCOL_TIMEOUT ?? 300000),
  dumpio: !!process.env.E2E_DUMPIO,
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
  pages.push([page, tag]);
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

// ---- screenshots ---------------------------------------------------------------------
async function shot(page, name) {
  const file = path.join(SHOTS_DIR, name);
  try {
    await page.screenshot({ path: file, timeout: 30000 });
    console.log(`shot  ${name}`);
  } catch (err) {
    console.log(`shot  ${name}: capture failed (${err instanceof Error ? err.message : String(err)}) — not a gate`);
  }
}

// ---- debug-surface wrappers -------------------------------------------------------------
const riftState = (page) => page.evaluate(() => window.__rift?.state() ?? null);
const lastSnap = (page) =>
  page.evaluate(() => {
    const s = window.__rift?.snaps() ?? [];
    return s.length > 0 ? s[s.length - 1] : null;
  });
/**
 * The newest snap TOGETHER with its freshness: at speed 20 the server pushes
 * hundreds of snaps/s per client, and a loaded page (SwiftShader raster +
 * JSON parse) can drain its websocket slower than messages arrive — the snap
 * ring then silently trails the server by seconds. snap.serverTime is the
 * server's epoch ms, so lagMs = page time - serverTime exposes it. Assertions
 * that compare game-tick deltas against deadlines MUST use fresh snaps only,
 * or a stale ring reads as "the sim ignored the order" (it didn't — the page
 * just hadn't seen it yet).
 */
const freshSnap = (page, maxLagMs) =>
  page.evaluate((maxLag) => {
    const s = window.__rift?.snaps() ?? [];
    if (s.length === 0) return null;
    const snap = s[s.length - 1];
    const lagMs = Date.now() - snap.serverTime;
    return lagMs <= maxLag ? snap : null;
  }, maxLagMs);
/** Diagnostic pair: newest snap tick + current lag, for failure messages. */
const snapLag = (page) =>
  page.evaluate(() => {
    const s = window.__rift?.snaps() ?? [];
    if (s.length === 0) return { tick: null, lagMs: null };
    const snap = s[s.length - 1];
    return { tick: snap.matchTick, lagMs: Date.now() - snap.serverTime };
  });
const lastEvents = (page) => page.evaluate(() => window.__rift?.lastEvents() ?? []);
/** Newest raw frame of wire tag `t` in the client's messageLog ring. */
const lastFrame = (page, t) =>
  page.evaluate((tag) => {
    const log = window.__rift?.messageLog() ?? [];
    for (let i = log.length - 1; i >= 0; i--) {
      const m = log[i];
      if (m !== null && typeof m === 'object' && m.t === tag) return m;
    }
    return null;
  }, t);

const ownEntId = (page) =>
  page.evaluate(() => {
    const st = window.__rift?.state();
    const s = window.__rift?.snaps() ?? [];
    if (!st || st.you === null || s.length === 0) return null;
    const snap = s[s.length - 1];
    const me = snap.ents.find((e) => e.k === 'hero' && e.pid === st.you);
    return me ? me.id : null;
  });

/** Live neutral (team 2) entities within `radius` of a camp clearing centre,
 *  with their kinds — the wire-level proof that camps exist, are neutral, and
 *  survive the room's per-team fog filter. */
const neutralsNear = (page, cx, cz, radius) =>
  page.evaluate(
    (x, z, r) => {
      const s = window.__rift?.snaps() ?? [];
      if (s.length === 0) return [];
      const snap = s[s.length - 1];
      return snap.ents
        .filter((e) => e.team === 2 && e.hp > 0 && Math.hypot(e.x - x, e.z - z) <= r)
        .map((e) => ({ id: e.id, k: e.k, hp: e.hp }));
    },
    cx,
    cz,
    radius,
  );

// ---- dayPhase sampler -------------------------------------------------------
// rift_snap.dayPhase is a scalar nothing else in this suite reads, so it can
// stop arriving (or go out of range) with every other check still green. A
// 1Hz background sampler over the whole live match is the cheapest way to
// notice — and it also measures the SWEEP, which is what proves the value is
// derived from matchTick rather than pinned.
const dayPhases = [];
const badDayPhases = [];
let dayPhaseTimer = null;
function startDayPhaseSampler(page) {
  let busy = false;
  dayPhaseTimer = setInterval(() => {
    if (busy) return;
    busy = true;
    page
      .evaluate(() => {
        const s = window.__rift?.snaps() ?? [];
        return s.length === 0 ? null : { has: 'dayPhase' in s[s.length - 1], v: s[s.length - 1].dayPhase };
      })
      .then((r) => {
        if (r === null) return;
        if (!r.has) badDayPhases.push('absent');
        else if (typeof r.v !== 'number' || !Number.isFinite(r.v) || r.v < 0 || r.v > 1) badDayPhases.push(String(r.v));
        else dayPhases.push(r.v);
      })
      .catch(() => {})
      .finally(() => {
        busy = false;
      });
  }, 1000);
}
function stopDayPhaseSampler() {
  if (dayPhaseTimer !== null) clearInterval(dayPhaseTimer);
  dayPhaseTimer = null;
}

/** Camps in `team`'s own half, nearest the map centre first. Deterministic:
 *  CampDef.id breaks every tie, and buildTerrain is a pure function. */
const campsForTeam = (team) => CAMPS.filter((c) => c.half === team);

// ============================================================================
// main
// ============================================================================
async function main() {
  await mkdir(SHOTS_DIR, { recursive: true });
  const t0 = Date.now();

  FACTS = terrainFacts(await loadTerrain(), EXPECT_LANES);
  const facts = FACTS;
  MAP_SIDE = facts.side;
  CAMPS = [...facts.camps].sort(
    (a, b) =>
      Math.hypot(a.x - MAP_SIDE / 2, a.z - MAP_SIDE / 2) - Math.hypot(b.x - MAP_SIDE / 2, b.z - MAP_SIDE / 2) || a.id - b.id,
  );

  startServer();
  await waitForServer();
  console.log(`server up on ${BASE} (rift client at /rift/)`);

  const A = await launchOne('A');
  const B = await launchOne('B');
  for (const [page, tag] of [[A, 'A'], [B, 'B']]) {
    await page.goto(`${BASE}/rift/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitFor(() => page.evaluate(() => !!window.__rift), 15000, `__rift on ${tag}`);
  }
  check('(1) rift client loads at /rift/ (window.__rift present on both pages)', true, '', { fatal: true });

  const s0 = await riftState(A);
  const missing = RIFT_STATE_FIELDS.filter((f) => !(f in (s0 ?? {})));
  check(
    '(2) state() exposes the §6 contract fields',
    s0 !== null && missing.length === 0 && s0.phase === 'menu' && s0.connected === true,
    s0 === null ? 'state=null' : `missing=[${missing}] ${digest(s0)}`,
    { fatal: true },
  );

  // ==========================================================================
  // LOBBY — A creates {teamSize:2, speed:20}; B joins by code; both pick
  // ==========================================================================
  await A.evaluate((s) => window.__rift.createPrivate('Alice', s), SETTINGS);
  const aLobby = await waitFor(
    async () => {
      const s = await riftState(A);
      return s !== null && s.phase === 'lobby' && s.you !== null ? s : null;
    },
    12000,
    'A in lobby after createPrivate',
  );
  const hello = await lastFrame(A, 'rift_hello');
  const code = hello !== null && typeof hello.code === 'string' && hello.code.length > 0 ? hello.code : null;
  check(
    '(3) A createPrivate -> lobby, private code delivered, teamSize=2 echoed',
    code !== null && hello.teamSize === EXPECT_TEAM_SIZE && aLobby.team === 0,
    `code=${code} hello.teamSize=${hello?.teamSize} A.team=${aLobby.team} (first seat ties -> team 0)`,
    { fatal: true },
  );

  await B.evaluate((c) => window.__rift.joinPrivate('Bob', c), code);
  const bothSeated = await waitFor(
    async () => {
      const [la, lb, sb] = await Promise.all([lastFrame(A, 'rift_lobby'), lastFrame(B, 'rift_lobby'), riftState(B)]);
      return la !== null && lb !== null && sb !== null && sb.phase === 'lobby' && la.humans === 2 && lb.humans === 2
        ? { la, lb, sb }
        : null;
    },
    12000,
    'both pages seated (rift_lobby humans=2)',
  );
  check(
    '(4) B joinPrivate -> both pages see a 2-human, startable lobby',
    bothSeated.la.canStart === true && bothSeated.lb.canStart === true && bothSeated.sb.team === 1,
    `A.canStart=${bothSeated.la.canStart} B.canStart=${bothSeated.lb.canStart} B.team=${bothSeated.sb.team} ` +
      `seated=${bothSeated.la.seated} minPlayers=${bothSeated.la.minPlayers}`,
    { fatal: true },
  );
  await shot(A, 'e2e-rift-lobby.png');

  await A.evaluate(() => window.__rift.pick('reaver'));
  await B.evaluate(() => window.__rift.pick('longbow'));
  const picks = await waitFor(
    async () => {
      const l = await lastFrame(A, 'rift_lobby');
      if (l === null) return null;
      const vals = Object.values(l.picks);
      return vals.includes('reaver') && vals.includes('longbow') ? l : null;
    },
    10000,
    'rift_lobby.picks with both heroes',
  );
  check(
    '(5) both humans pick heroes (reaver, longbow — unique manual picks)',
    true,
    `picks=${JSON.stringify(picks.picks)}`,
  );

  // ==========================================================================
  // START -> rift_begin (lanes=1, teamSize=2) -> snaps flow
  // ==========================================================================
  await A.evaluate(() => window.__rift.start());
  const begins = await waitFor(
    async () => {
      const [ba, bb, sa, sb] = await Promise.all([lastFrame(A, 'rift_begin'), lastFrame(B, 'rift_begin'), riftState(A), riftState(B)]);
      return ba !== null && bb !== null && sa?.phase === 'live' && sb?.phase === 'live' ? { ba, bb, sa, sb } : null;
    },
    LOBBY_COUNTDOWN_MS + 12000,
    'rift_begin on both pages (after the 3s countdown)',
  );
  const seatCount = Object.keys(begins.ba.laneAssignment).length;
  check(
    '(6) manual start -> rift_begin lanes=1 teamSize=2 on BOTH pages; bot fill seats 4',
    begins.ba.lanes === EXPECT_LANES &&
      begins.ba.teamSize === EXPECT_TEAM_SIZE &&
      begins.bb.lanes === EXPECT_LANES &&
      begins.bb.teamSize === EXPECT_TEAM_SIZE &&
      seatCount === 4,
    `A{lanes=${begins.ba.lanes} teamSize=${begins.ba.teamSize}} B{lanes=${begins.bb.lanes} teamSize=${begins.bb.teamSize}} ` +
      `laneAssignment seats=${seatCount} (2 humans + 2 bots)`,
    { fatal: true },
  );

  // (9a) creep-spawn polling starts NOW — BEFORE check 7's 600ms tick-rate
  // sleep, which would otherwise span the wave tick (200) and make "first
  // seen" measure when we started looking (~550) instead of when the spawner
  // fired. Own-team mobiles are in your snapshot unconditionally (vision.ts),
  // so Alice sees her own wave the moment it exists. The bound is the wave
  // tick + a few poll intervals (at ~300-800 ticks/s one 150ms interval is
  // ~50-120 game-ticks): if the spawner were actually late this fails. (Two
  // earlier revisions discovered creeps at ~1300/~550 — both were poll-timing
  // artifacts, measured and documented, not spawn behavior.)
  const creepsPromise = waitFor(
    async () => {
      const s = await lastSnap(A);
      if (s === null) return null;
      const cs = s.ents.filter((e) => e.k === 'melee' || e.k === 'ranged' || e.k === 'siege');
      return cs.length > 0 ? { s, cs } : null;
    },
    30000,
    'creep ents in a snap',
  );
  creepsPromise.catch(() => {}); // tolerated if a fatal check aborts first

  const flow = await waitFor(
    async () => {
      const [na, nb] = await Promise.all([lastSnap(A), lastSnap(B)]);
      if (na === null || nb === null) return null;
      if (na.phase !== 'live' || nb.phase !== 'live' || na.you === null || nb.you === null) return null;
      return { na, nb };
    },
    10000,
    "live snaps with a 'you' on both pages",
  );
  const tick1 = flow.na.tick;
  await sleep(600);
  const flow2 = await lastSnap(A);
  const botRows = flow.na.board.filter((r) => r.bot).length;
  check(
    "(7) snaps flow with phase 'live': tick advances, you/gold present, board = 2 humans + 2 bots",
    flow2 !== null && flow2.tick > tick1 && flow.na.you.gold > 0 && flow.na.ents.length > 0 && flow.na.board.length === 4 && botRows === 2,
    `tick ${tick1} -> ${flow2?.tick} in 600ms (~${flow2 === null ? '?' : ((flow2.tick - tick1) / 0.6).toFixed(0)}/s) ` +
      `gold=${flow.na.you.gold} ents=${flow.na.ents.length} board=${flow.na.board.length} bots=${botRows}`,
    { fatal: true },
  );
  startDayPhaseSampler(A);

  // ==========================================================================
  // CREEPS SPAWN — the poll has been running since before check 7 (see above);
  // here we only collect it. snap.matchTick IS the world tick (room.ts sets
  // snap.matchTick = w.tick) and the spawner fires at world tick 200.
  // ==========================================================================
  const CREEPS_VISIBLE_BY = WAVE_FIRST_TICK + 300;
  const creeps = await creepsPromise;
  check(
    '(9a) creeps spawn by matchTick ~200 (first wave at 10s game-time)',
    creeps.s.matchTick <= CREEPS_VISIBLE_BY,
    `first seen at matchTick=${creeps.s.matchTick} (wave tick ${WAVE_FIRST_TICK} + poll slack <= ${CREEPS_VISIBLE_BY}) ` +
      `creeps=${creeps.cs.length} kinds=${[...new Set(creeps.cs.map((c) => c.k))].join('/')}`,
  );

  // ==========================================================================
  // EARLY GAME — walk to mid (the move assertion needs a destination; mid is
  // where the waves meet), skill + cast on the way, watch the clash, THEN
  // back to the fountain for the buy + gold checks.
  // ==========================================================================
  // (8) order('move') moves the hero: displacement > 4m from the order origin.
  // Target (42,42): 6m short of where the wave fronts meet on the diagonal.
  // TWO deadlines, both against FRESH snaps (see freshSnap):
  //  - 400 fresh game-ticks without displacement = the ORDER was ignored;
  //  - 120s wall without ever seeing a fresh, moved sample = the page cannot
  //    keep up with the snap stream (load problem, reported as such).
  // The order is re-sent every ~2s wall: legal (same target) and it covers the
  // race where the order lands while the hero still has a stale queue entry.
  const pos0Snap = await lastSnap(A);
  const pos0 = { x: pos0Snap.you.x, z: pos0Snap.you.z, mt: pos0Snap.matchTick };
  const moveTo = { x: 42, z: 42 };
  let moved = null;
  let freshBase = null; // first FRESH tick seen after the order
  const moveWallDeadline = Date.now() + 120000;
  for (;;) {
    await A.evaluate((x, z) => window.__rift.order('move', x, z), moveTo.x, moveTo.z);
    for (let i = 0; i < 10; i++) {
      await sleep(200);
      const s = await freshSnap(A, 2000);
      if (s === null || s.you === null) continue; // page draining (or dead hero)
      if (freshBase === null) freshBase = s.matchTick;
      const d = Math.hypot(s.you.x - pos0.x, s.you.z - pos0.z);
      if (d > 4) {
        moved = { s, d };
        break;
      }
      if (freshBase !== null && s.matchTick - freshBase > 400) {
        throw new Error(
          `order('move') ignored: ${s.matchTick - freshBase} FRESH game-ticks with no displacement ` +
            `(hero at (${s.you.x.toFixed(1)},${s.you.z.toFixed(1)}), target (42,42))`,
        );
      }
    }
    if (moved !== null) break;
    if (Date.now() > moveWallDeadline) {
      const lag = await snapLag(A);
      throw new Error(
        `move order never observable on a fresh snapshot within 120s — page lag=${lag.lagMs}ms at matchTick=${lag.tick} ` +
          '(the client could not drain the speed-20 snap stream under load; retry on a quieter box or set E2E_VIEWPORT=640x360)',
      );
    }
  }
  check(
    "(8) order('move', x, z) moves the hero across snaps",
    true,
    `(${pos0.x.toFixed(1)},${pos0.z.toFixed(1)}) -> (${moved.s.you.x.toFixed(1)},${moved.s.you.z.toFixed(1)}) ` +
      `displacement=${moved.d.toFixed(1)}m in ${moved.s.matchTick - pos0.mt} game-ticks target=(${moveTo.x},${moveTo.z})`,
  );

  // (12a) skill(0) ranks up Q (heroes spawn with STARTING_SKILL_POINTS=1).
  await A.evaluate(() => window.__rift.skill(0));
  const ranked = await waitFor(
    async () => {
      const s = await lastSnap(A);
      return s !== null && s.you !== null && s.you.abilities[0].rank === 1 ? s : null;
    },
    8000,
    'abilities[0].rank === 1 after skill(0)',
  );
  check(
    '(12a) skill(0) spends the spawn skill point -> Q rank 1',
    true,
    `ranks=[${ranked.you.abilities.map((a) => a.rank)}] skillPoints=${ranked.you.skillPoints}`,
  );

  // (12b) cast fires. Reaver Q (Cleave) is targeting:'none' — legal with no
  // target at the fountain. Evidence: a rift_cast event carrying OUR ent id,
  // or the ability cooldown landing ahead of matchTick.
  const myEnt = await ownEntId(A);
  await A.evaluate(() => window.__rift.cast(0));
  const castEvidence = await waitFor(
    async () => {
      const [evs, s] = await Promise.all([lastEvents(A), lastSnap(A)]);
      if (s === null || s.you === null) return null;
      const ev = evs.find((e) => e.t === 'rift_cast' && e.id === myEnt && e.slot === 0);
      if (ev !== undefined) return { kind: 'event', ev, s };
      if (s.you.abilities[0].cdUntilTick > s.matchTick) return { kind: 'cooldown', s };
      return null;
    },
    8000,
    'rift_cast evidence for our hero',
  );
  check(
    '(12b) cast(0) fires without error (rift_cast event or cooldown set)',
    true,
    castEvidence.kind === 'event'
      ? `rift_cast{id=${castEvidence.ev.id} slot=${castEvidence.ev.slot} at (${castEvidence.ev.x},${castEvidence.ev.z})}`
      : `cooldown: cdUntilTick=${castEvidence.s.you.abilities[0].cdUntilTick} > matchTick=${castEvidence.s.matchTick} ` +
        `(mana ${castEvidence.s.you.mana.toFixed(0)}/${castEvidence.s.you.maxMana})`,
  );

  // ==========================================================================
  // CREEPS ENGAGE + DIE — the mid-clash evidence. Own-team mobiles are always
  // in your snapshot (vision.ts: own team is added unconditionally), so these
  // read fine no matter where Alice stands; she is walking to mid anyway.
  // ==========================================================================
  const engaged = await waitFor(
    async () => {
      const s = await lastSnap(A);
      if (s === null) return null;
      const cs = s.ents.filter((e) => e.k === 'melee' || e.k === 'ranged' || e.k === 'siege');
      const hurt = cs.find((c) => c.hp < c.maxHp - 1);
      return hurt !== undefined ? { s, hurt } : null;
    },
    60000,
    'a creep with hp < maxHp (engagement)',
  );
  check(
    '(9b) creeps engage (hp decreases once the waves meet)',
    true,
    `${engaged.hurt.k}#${engaged.hurt.id} team${engaged.hurt.team} hp=${engaged.hurt.hp.toFixed(0)}/${engaged.hurt.maxHp} ` +
      `at matchTick=${engaged.s.matchTick}`,
  );

  // Death: track every creep seen DAMAGED at the clash. Fighting creeps do
  // not retreat, so a hurt id that leaves the snapshot died — it did not
  // walk out of vision. Passes on the first observed death.
  const hurtIds = new Set([engaged.hurt.id]);
  const death = await waitFor(
    async () => {
      const s = await lastSnap(A);
      if (s === null) return null;
      const present = new Set(s.ents.map((e) => e.id));
      for (const id of hurtIds) if (!present.has(id)) return { s, id };
      for (const e of s.ents) {
        if ((e.k === 'melee' || e.k === 'ranged' || e.k === 'siege') && e.hp < e.maxHp - 1) hurtIds.add(e.id);
      }
      return null;
    },
    60000,
    'a tracked hurt-creep death (id leaves the snap)',
  );
  check(
    '(9c) creep deaths occur (a tracked hurt-creep id leaves the snapshot)',
    true,
    `creep #${death.id} gone by matchTick=${death.s.matchTick} (tracked ${hurtIds.size} hurt-creep ids)`,
  );

  // ==========================================================================
  // (15) NEUTRAL JUNGLE CAMPS — walk the hero to a camp clearing in its own
  // half and require team-2 entities to show up in its snapshots. The clearing
  // coordinates are NOT hard-coded: they come from buildTerrain(1) in this
  // process, which is the same pure function the server used (TERRAIN_CONTRACT
  // §1), so this check follows the generator instead of rotting behind it.
  // The stand-off point is a PASSABLE cell on the map-centre side of the
  // clearing, inside the band ./rift-terrain-facts.mjs derives: outside the
  // camp's acquisition reach measured from the clearing centre (AGGRO_RADIUS 7
  // plus the 1.6 m ring camps.ts rests members on) and close enough that a
  // member stays inside hero vision even after nightVisionScale has taken it
  // from 11 m down to 8.25 m. CAMP_LEASH_RADIUS, which this used to quote, caps
  // how far an already-aggroed member may be dragged and says nothing about
  // whether a loitering hero is pulled.
  // ==========================================================================
  const aTeam = (await riftState(A))?.team ?? 0;
  const camp = campsForTeam(aTeam)[0] ?? CAMPS[0];
  let campSeen = null;
  let campTrace = 'never got near the clearing';
  if (camp === undefined) {
    check('(15) neutral jungle camps are on the wire (team 2 entities at a camp clearing)', false,
      `buildTerrain(${EXPECT_LANES}) produced no camps at all — TERRAIN_CONTRACT §3 requires 2 per half at 1 lane`);
  } else if (FACTS.campStand(camp.x, camp.z, MAP_SIDE / 2, MAP_SIDE / 2) === null) {
    // A bail-out, never an early `return`: this runs inside main(), and
    // returning here would take every check after it down with this one.
    check('(15) neutral jungle camps are on the wire (team 2 entities at a camp clearing)', false,
      `no passable cell ${CAMP_STAND_MIN_M}-${CAMP_STAND_MAX_M}m from the ${camp.tier} clearing at ` +
        `(${camp.x.toFixed(1)}, ${camp.z.toFixed(1)}) — the hero cannot stand anywhere the camp is both safe and visible`);
  } else {
    const stand = FACTS.campStand(camp.x, camp.z, MAP_SIDE / 2, MAP_SIDE / 2);
    const campDeadline = Date.now() + CAMP_WALK_TIMEOUT_MS;
    for (;;) {
      // The match ending under us is a different failure from "no camps on the
      // wire", and walking a hero around an ended room forever is how one
      // unwired feature took the buy/gold/end checks down with it.
      const phase = (await riftState(A))?.phase ?? null;
      if (phase !== 'live') {
        campTrace = `the match left the live phase (phase=${String(phase)}) before any neutral was seen`;
        break;
      }
      await A.evaluate((x, z) => window.__rift.order('move', x, z), stand.x, stand.z);
      await sleep(700);
      const near = await neutralsNear(A, camp.x, camp.z, CAMP_VISIBLE_M);
      if (near.length > 0) {
        campSeen = near;
        break;
      }
      const s = await lastSnap(A);
      if (s !== null && s.you !== null) {
        campTrace =
          `hero at (${s.you.x.toFixed(1)},${s.you.z.toFixed(1)}), ${Math.hypot(s.you.x - camp.x, s.you.z - camp.z).toFixed(1)}m ` +
          `from the ${camp.tier} clearing, matchTick=${s.matchTick}`;
      }
      if (Date.now() > campDeadline) break;
    }
    check(
      '(15) neutral jungle camps are on the wire (team 2 entities at a camp clearing)',
      campSeen !== null,
      campSeen !== null
        ? `${camp.tier} camp #${camp.id} at (${camp.x},${camp.z}): ${campSeen.length} neutral(s) ` +
          `kinds=${[...new Set(campSeen.map((e) => e.k))].join('/')} hp=[${campSeen.map((e) => e.hp.toFixed(0))}]`
        : `no team-2 entity within ${CAMP_VISIBLE_M}m of the ${camp.tier} clearing (${camp.x},${camp.z}) in ` +
          `${CAMP_WALK_TIMEOUT_MS / 1000}s — ${campTrace}`,
    );
  }

  // (11) buy at the fountain. The server (world.buy) silently no-ops unless
  // the hero is alive, has the gold, and stands within FOUNTAIN_RADIUS=6 of
  // its own ancient — and idle heroes spawn at ~5.5m out, where soft unit
  // separation can nudge them past the edge. So: order home, wait until
  // measurably inside, THEN buy (with retries + full diagnostics on failure).
  const buyProbe = async () =>
    A.evaluate(() => {
      const st = window.__rift?.state();
      const s = window.__rift?.snaps() ?? [];
      if (!st || st.team === null || s.length === 0) return null;
      const snap = s[s.length - 1];
      if (snap.you === null) return null;
      const anc = snap.ents.find((e) => e.k === 'ancient' && e.team === st.team);
      if (anc === undefined) return null;
      return {
        x: snap.you.x, z: snap.you.z, gold: snap.you.gold,
        hp: snap.you.hp, respawnAtTick: snap.you.respawnAtTick, matchTick: snap.matchTick,
        items: snap.you.items, dist: Math.hypot(snap.you.x - anc.x, snap.you.z - anc.z),
        ax: anc.x, az: anc.z,
      };
    });
  const atFountain = await waitFor(
    async () => {
      const p = await buyProbe();
      if (p === null) return null;
      if (p.respawnAtTick > 0) return null; // dead: respawn lands on the fountain
      if (p.dist <= 4.5) return p;
      await A.evaluate((x, z) => window.__rift.order('move', x, z), p.ax, p.az);
      return null;
    },
    20000,
    'hero inside the fountain radius (ordered home)',
  );
  const goldBeforeBuy = atFountain.gold;
  let bought = null;
  const buyTrace = [];
  const buyDeadline = Date.now() + 20000;
  for (;;) {
    await A.evaluate(() => window.__rift.buy('bladestone'));
    await sleep(500);
    const p = await buyProbe();
    if (p !== null) {
      buyTrace.push(
        `mt=${p.matchTick} gold=${p.gold.toFixed(0)} dist=${p.dist.toFixed(1)} items=[${p.items.map((i) => i ?? '·')}]`,
      );
    }
    if (p !== null && p.items.includes('bladestone')) {
      bought = p;
      break;
    }
    if (p !== null && p.dist > 4.5 && p.respawnAtTick === 0) {
      await A.evaluate((x, z) => window.__rift.order('move', x, z), p.ax, p.az);
    }
    if (Date.now() > buyDeadline) {
      throw new Error(`buy('bladestone') never landed — observed: ${JSON.stringify(p)} trace: ${buyTrace.join(' | ')}`);
    }
  }
  console.log(`info  buy trace: ${buyTrace.join(' | ')}`);
  // The purchase is proven by the ITEM landing in the inventory (there is no
  // other way to acquire one — the contract-sanctioned criterion). A raw gold
  // delta is NOT a valid assertion here: tower bounties (200 to every living
  // enemy hero), kill gold and last-hits land in the same window, so net gold
  // can drop by less than the cost or even rise. The gold numbers ride along
  // in the detail line with the passive income factored out.
  const passiveGain = (1.2 * (bought.matchTick - atFountain.matchTick)) / TICK_RATE;
  const explainedDrop = goldBeforeBuy + passiveGain - bought.gold; // spend + other income conflated
  check(
    '(11) buy(\'bladestone\') at the fountain succeeds (item held)',
    bought.items.includes('bladestone'),
    `gold ${goldBeforeBuy.toFixed(0)} -> ${bought.gold.toFixed(0)} (passive +${passiveGain.toFixed(1)}, ` +
      `drop beyond passive=${explainedDrop.toFixed(0)} vs cost ${BLADESTONE_COST} — bounties/kill gold land in the same window) ` +
      `items=[${bought.items.map((i) => i ?? '·')}] dist=${bought.dist.toFixed(1)}m`,
  );

  // (10) gold accrues (passive at minimum): strictly greater within seconds.
  // A sampled series, not two points — if the curve misbehaves the failure
  // message carries the whole curve.
  const g1 = bought.gold;
  const series = [`t0=${g1.toFixed(0)}`];
  const accrualDeadline = Date.now() + 15000;
  let accrued = null;
  for (;;) {
    await sleep(400);
    const s = await lastSnap(A);
    if (s !== null && s.you !== null) {
      series.push(`${((s.matchTick - bought.matchTick) / TICK_RATE).toFixed(0)}gs:${s.you.gold.toFixed(0)}`);
      if (s.you.gold > g1 + 3) {
        accrued = s;
        break;
      }
    }
    if (Date.now() > accrualDeadline) {
      throw new Error(`gold did not accrue after purchase (start ${g1.toFixed(0)}) — series: ${series.join(' ')}`);
    }
  }
  check(
    '(10) gold accrues over time (passive income at minimum)',
    true,
    `${g1.toFixed(0)} -> ${accrued.you.gold.toFixed(0)} — series: ${series.join(' ')}`,
  );

  // info for the report (T14 owns the draw-call gate; measured here, not gated)
  const drawCalls = await A.evaluate(() => window.__rift.drawCalls());
  console.log(`info  drawCalls()=${drawCalls} at matchTick=${death.s.matchTick}`);
  await shot(A, 'e2e-rift-live.png');

  // ==========================================================================
  // END — the match resolves by 'ancient' within the timeout
  // ==========================================================================
  const endWait0 = Date.now();
  const ended = await waitFor(
    async () => {
      const [evs, s, snap] = await Promise.all([lastEvents(A), riftState(A), lastSnap(A)]);
      const end = evs.find((e) => e.t === 'rift_end');
      if (end !== undefined) return { end, s, snap };
      return null;
    },
    END_TIMEOUT_MS,
    "rift_end (match resolves by 'ancient')",
  );
  const endWallS = ((Date.now() - endWait0) / 1000).toFixed(1);
  const totalWallS = ((Date.now() - t0) / 1000).toFixed(1);
  const gameS = ended.snap !== null ? (ended.snap.matchTick / TICK_RATE).toFixed(0) : '?';
  check(
    "(13) the match ENDS by 'ancient' (bots push at speed 20)",
    ended.end.reason === 'ancient' && ended.end.winner !== null && ended.s?.phase === 'ended',
    `reason=${ended.end.reason} winner=team${ended.end.winner} phase=${ended.s?.phase} ` +
      `game-time=${gameS}s wall: begin->end=${endWallS}s total=${totalWallS}s kills=[${ended.snap?.kills}]`,
  );
  const stats = ended.end.stats.map((p) => `${p.name}(${p.hero},t${p.team}) ${p.kills}/${p.deaths}/${p.assists} gold=${p.goldEarned}`);
  console.log(`info  final stats: ${stats.join(' | ')}`);
  await shot(A, 'e2e-rift-end.png');

  // ==========================================================================
  // (16) DAY / NIGHT ON THE WIRE — collected by the 1Hz sampler for the whole
  // match (TERRAIN_CONTRACT §6). Three distinct failures, one check: the field
  // never arrives, it arrives out of [0,1], or it never moves (pinned, frozen,
  // or not derived from matchTick at all).
  // ==========================================================================
  stopDayPhaseSampler();
  const lo = dayPhases.length > 0 ? Math.min(...dayPhases) : NaN;
  const hi = dayPhases.length > 0 ? Math.max(...dayPhases) : NaN;
  const sweep = hi - lo;
  check(
    '(16) rift_snap.dayPhase arrives, stays in [0,1] and sweeps the cycle',
    badDayPhases.length === 0 && dayPhases.length > 0 && sweep >= DAY_PHASE_SWEEP_MIN,
    `${dayPhases.length} samples in [${Number.isNaN(lo) ? '?' : lo.toFixed(3)}, ${Number.isNaN(hi) ? '?' : hi.toFixed(3)}] ` +
      `sweep=${Number.isNaN(sweep) ? '?' : sweep.toFixed(3)} (need >= ${DAY_PHASE_SWEEP_MIN}); ` +
      `${badDayPhases.length} out-of-contract value(s)${badDayPhases.length > 0 ? `: [${[...new Set(badDayPhases)].slice(0, 5).join(', ')}]` : ''}`,
  );
}

// ============================================================================
const t0all = Date.now();
try {
  await main();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  // an abort IS a failed gate: record it so the exit code goes non-zero
  check('suite runs to completion (no abort)', false, msg);
  // observed state on every live page at the moment of failure
  for (const [page, tag] of pages) {
    try {
      const s = await riftState(page);
      const snap = await lastSnap(page);
      console.log(
        `state-at-abort [${tag}] ${digest(s)} you=${JSON.stringify(snap?.you ?? null)?.slice(0, 300)}`,
      );
    } catch {
      // page already gone
    }
  }
} finally {
  stopDayPhaseSampler();
  tearingDown = true;
  for (const b of browsers) await b.close().catch(() => {});
  if (serverChild !== null && serverChild.exitCode === null) serverChild.kill('SIGTERM');
}

check(
  '(14) ZERO page errors across both browsers for the whole run',
  pageErrors.length === 0,
  pageErrors.length === 0 ? 'none seen' : `${pageErrors.length}:\n  ${pageErrors.slice(0, 12).join('\n  ')}`,
);
check(
  '(17) the platform server survived the whole run (exit code, not log scraping)',
  serverDied === null,
  serverDied === null
    ? 'still up at teardown'
    : `exited mid-run with code ${serverDied.code}, signal ${serverDied.signal} — every check after that point read a frozen world`,
);

const failed = results.filter((r) => !r.ok);
console.log('\n============================================================================');
console.log(`e2e-rift: ${results.length - failed.length}/${results.length} checks passed in ${((Date.now() - t0all) / 1000).toFixed(1)}s`);
if (failed.length > 0) {
  console.log(`failed: ${failed.map((f) => f.name).join(' ;; ')}`);
  process.exitCode = 1;
}

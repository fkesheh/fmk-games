#!/usr/bin/env node
// ============================================================================
// e2e-bank — prove BANK runs end-to-end in a real (headless) browser.
//
// Builds the whole monorepo first (npm run build must produce
// games/bank/client/dist; set E2E_SKIP_BUILD=1 to reuse an existing dist),
// spawns the production platform server (platform/server/dist) on E2E_PORT
// (default 8182), then drives THREE browser instances (separate processes: no
// cross-tab timer throttling) through the window.__bank debug surface against
// the multi-game static route /bank/:
//   A createPrivate('Alice') -> private-room code; B joinPrivate('Bob', code);
//   both see 2 players; the room then SITS THERE — BANK has no auto-start, so
//   the suite holds 6s and asserts the lobby is STILL a lobby with the round
//   un-advanced while the server reports canStart ('lobby does not auto-start'
//   — the room COULD have started and chose not to); only then does a seated
//   player press the REAL top control, button.btn.btn-gold.btn-start ("START
//   MATCH", `hidden` outside the lobby and `disabled` until canStart), which is
//   what moves the room to 'playing'; the current player (found by polling
//   state()) rolls
//   until pot > 0; B banks mid-round REGARDLESS of turn -> B score == pot at
//   bank time, the pot itself is UNCHANGED (banking never drains it), B is
//   marked banked; the non-banked pages keep rolling until the round ends
//   (bust7 / all_banked; the 12s auto-roll backstops termination) -> the
//   round increments (or match_end after round 10 — loop is capped).
// MANUAL START, everywhere: a finished match returns to the lobby and WAITS,
//   and every freshly created room opens in the lobby too. Each point where the
//   suite needs play running therefore presses start — the primary press is a
//   real button click, and window.__bank.start() is the fallback used only for
//   the defensive re-press guard where the button may not be on screen. The
//   press is ALWAYS gated on the server-authoritative `canStart`, never on the
//   purely cosmetic `awaitingStart` (which merely distinguishes a post-match
//   lobby from a cold one for wording purposes).
// (20) mid-round join (docs/BANK.md "Join/leave"): page C joins the SAME code
//   during round 1 -> all three pages see players.length === 3, C's entry is
//   NOT pre-banked (banked=false: mid-round joiners participate immediately),
//   and the turn reaches C within one full cycle (poll up to ~60s; the 30s
//   auto-roll backstops any stall). The roll/round-out loops then drive C too.
// (21) reconnect (docs/BANK.md "Rejoin (resume token)"): B's playerId + banked
//   score are read, page B RELOADS and joinPrivate('Bob', code) re-sends the
//   client's stored resume token -> the room re-binds B's entry to the new
//   session: exactly one Bob, score preserved, players.length unchanged on A
//   (no ghost duplicate).
// Then the room-variant flow: A createPrivate('Alice', {sevenBonus:false,
//   totalRounds:20}) — the lobby leaves the current room on create — opens a
//   SECOND private room on the variant; B rejoins by the fresh code; both
//   pages must deep-match state().settings ({sevenBonus:false,totalRounds:20,
//   raceTarget:null}) and show the variant label in the table header chip
//   ("20 rounds · plain 7"). That second room is a NEW room, so it too opens in
//   the lobby and waits: the suite asserts it did not auto-start with 2 seats
//   and then presses its START MATCH button to open match 2, so the invite and
//   leave scenarios below run against a live table exactly as before.
// (26) invite: in A's private room the table UI must show the room's code in a
//   visible chip next to a COPY-INVITE-ish button, and a fresh page D opened
//   directly on /bank/?code=<code> must prefill the menu code input (or
//   auto-join the room from the param). D is closed afterwards.
// (27) leave: A clicks the top-bar LEAVE button (.table-top > button.btn-small,
//   wired to leaveToMenu in game.ts) -> A lands back on the menu, B's
//   players.length drops to 1 within 5s, and 5s later A is still on the menu
//   with players unchanged (an explicit leave drops the resume record: no
//   auto-rejoin).
//
// The join code is read from state().code first; fallbacks are the lobby's
// server-log line ("created (private, code XXXXX, game bank)") and a DOM
// scrape, so the suite tolerates minor state()-shape drift in the client.
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
const PORT = Number(process.env.E2E_PORT ?? 8182);
const BASE = `http://localhost:${PORT}`;
const SHOTS_DIR = path.join(ROOT, 'screenshots');

// fields the BANK.md debug surface freezes for window.__bank.state()
const BANK_STATE_FIELDS = ['phase', 'round', 'pot', 'rollCount', 'currentId', 'you', 'players'];

// games/bank/shared/src/config.ts MIN_PLAYERS. state() carries playerCount /
// canStart but NOT minPlayers, so the seat threshold is mirrored here; every
// gate still prefers the server's own `canStart` and uses this only to report
// seat counts (and as the ?? fallback should minPlayers ever appear).
const BANK_MIN_PLAYERS = 2;

// How long the full lobby is held to prove nothing starts it but a player.
const LOBBY_HOLD_MS = 6000;

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

const bankState = (page) => page.evaluate(() => window.__bank?.state() ?? null);

// ---- build + server -------------------------------------------------------------
function buildAll() {
  console.log('build: npm run build');
  const r = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`npm run build exited with code ${r.status}`);
  const bankIndex = path.join(ROOT, 'games/bank/client/dist/index.html');
  if (!existsSync(bankIndex)) {
    throw new Error('games/bank/client/dist/index.html missing after build (bank client not wired into npm run build?)');
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
      // /bank/ is the multi-game static route for the bank client dist
      const res = await fetch(`${BASE}/bank/`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`server did not serve /bank/ on :${PORT} within ${timeoutMs}ms`);
    await sleep(250);
  }
}

// ---- browser --------------------------------------------------------------------
// DOM-only client (no WebGL): the plain headless shell is enough; the
// anti-throttling flags keep the 30s turn timer + dice animations at full rate.
const VIEWPORT = { width: 1280, height: 720 };
const LAUNCH_OPTS = {
  headless: 'shell',
  args: [
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    '--mute-audio',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
  protocolTimeout: Number(process.env.E2E_PROTOCOL_TIMEOUT ?? 300000),
  dumpio: !!process.env.E2E_DUMPIO,
};

async function launchOne(tag) {
  const browser = await puppeteer.launch(LAUNCH_OPTS);
  browsers.push(browser);
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
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

// ---- screenshots ------------------------------------------------------------------
async function shot(page, name) {
  const file = path.join(SHOTS_DIR, name);
  const t0 = Date.now();
  try {
    await page.screenshot({ path: file, timeout: 30000 });
    console.log(`shot  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return;
  } catch (err) {
    console.log(
      `shot  ${name}: capture failed at ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
        `(${err instanceof Error ? err.message : String(err)}) — one retry with a wider window`,
    );
  }
  await page.screenshot({ path: file, timeout: 90000 });
  console.log(`shot  ${name} (retry, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// ---- manual start helpers -------------------------------------------------------------
// BANK never starts itself. `{t:'start'}` from any SEATED player is the only
// way out of the lobby, and the room silently ignores a press that is not legal
// (wrong phase / too few seats), so the harness must press at a moment the
// server would honour: phase 'lobby' AND canStart true.

/**
 * Press START through the REAL control a player uses:
 * `button.btn.btn-gold.btn-start` ("START MATCH"). It carries the `hidden`
 * class outside the lobby and is `disabled` until the server-authoritative
 * `canStart` flips, so polling the click until it lands IS the readiness wait —
 * no separate state gate is needed and no press can go out illegally.
 * Both guards matter: `disabled` is only refreshed inside the client's lobby
 * branch, so a stale `disabled === false` survives into 'playing'; `hidden` is
 * what actually tracks the phase.
 */
async function pressStartButton(page, label, timeoutMs = 20000) {
  await waitFor(
    () =>
      page.evaluate(() => {
        const b = document.querySelector('.btn-start');
        if (b && !b.disabled && !b.classList.contains('hidden')) {
          b.click();
          return true;
        }
        return false;
      }),
    timeoutMs,
    label,
  );
}

/** Legit fallback press for spots where the button is not on screen. */
const debugStart = (page) => page.evaluate(() => window.__bank?.start());

/** Poll until this page reports 'playing' (i.e. the press landed). */
const waitForPlaying = (page, label, timeoutMs = 15000) =>
  waitFor(
    async () => {
      const s = await bankState(page);
      return s !== null && s.phase === 'playing' ? s : null;
    },
    timeoutMs,
    label,
  );

/**
 * Best-effort repair, NOT an assertion: make sure a match is running before a
 * scenario that needs one. A match that ends drops the room back to 'lobby'
 * (after the matchEnd -> fullReset beat) and WAITS there forever, so any step
 * the suite reaches after a match end would otherwise stall on a dead table.
 * Uses the debug press because the caller may be mid-banner/overlay; returns
 * the phase it settled on and never throws.
 */
async function ensureMatchRunning(page, timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    const s = await bankState(page);
    if (s !== null && s.phase === 'playing') return 'playing';
    // 'matchEnd' is a timed beat on its way to the lobby — just wait it out.
    if (s !== null && s.phase === 'lobby' && s.canStart === true) {
      try {
        await debugStart(page);
      } catch {
        // page mid-navigation — retried on the next lap
      }
    }
    if (Date.now() - t0 > timeoutMs) return s === null ? 'unknown' : s.phase;
    await sleep(400);
  }
}

// ---- gameplay helpers ---------------------------------------------------------------
/** Roll from this page only when the server says it is this player's turn. */
async function rollIfCurrent(page, s) {
  if (s !== null && s.phase === 'playing' && s.currentId !== null && s.currentId === s.you) {
    await page.evaluate(() => window.__bank.roll());
    return true;
  }
  return false;
}

/**
 * The private-room join code. Primary: state().code on the client surface.
 * Fallbacks: the lobby's creation log line, then a 5-char token scraped from
 * the DOM (the room screen displays the code for sharing).
 */
async function getRoomCode(page) {
  const fromState = await page.evaluate(() => {
    const s = window.__bank?.state?.();
    return s && typeof s.code === 'string' && s.code.length > 0 ? s.code : null;
  });
  if (fromState !== null) return fromState;
  const matches = [...serverLog.matchAll(/created \(private, code (\S+), game bank\)/g)];
  const fromLog = matches.length > 0 ? matches[matches.length - 1][1] : null;
  if (fromLog !== null) return fromLog;
  return page.evaluate(() => {
    const m = /\b([A-Z0-9]{5})\b/.exec(document.body.innerText);
    return m !== null ? m[1] : null;
  });
}

/** The rolling player's own entry in state().players (by id, name fallback). */
function meOf(s, name) {
  return s.players.find((p) => p.id === s.you) ?? s.players.find((p) => p.name === name) ?? null;
}

// ---- room-variant flow (docs/BANK.md "Room variants") --------------------------
// Sent as createPrivate's 2nd arg (debug signature per the client task); the
// room fills the rest from DEFAULT_SETTINGS, so the frozen variant differs.
const VARIANT_CREATE = { sevenBonus: false, totalRounds: 20 };
const VARIANT_EXPECTED = { sevenBonus: false, totalRounds: 20, raceTarget: null };

/** Deep match of state().settings against the frozen variant. */
function settingsMatch(s) {
  return (
    s !== null &&
    s.settings !== null &&
    typeof s.settings === 'object' &&
    Object.entries(VARIANT_EXPECTED).every(([k, v]) => s.settings[k] === v)
  );
}

/** The header chip renders the contract label, e.g. "20 rounds · plain 7". */
const variantLabelIn = (text) => /20\s*rounds/i.test(text) && /plain\s*7/i.test(text);

// ---- main ---------------------------------------------------------------------------
async function main() {
  await mkdir(SHOTS_DIR, { recursive: true });
  // E2E_SKIP_BUILD=1 (and only exactly '1') reuses whatever dist is on disk —
  // the orchestrator builds once and then runs several suites back to back.
  if (process.env.E2E_SKIP_BUILD !== '1') buildAll();
  startServer();
  await waitForServer();
  console.log(`server up on ${BASE} (bank client at /bank/)`);

  const A = await launchOne('A');
  const B = await launchOne('B');

  // -- load the bank client on both pages ---------------------------------------------
  await A.goto(`${BASE}/bank/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(() => A.evaluate(() => !!window.__bank), 15000, '__bank on A');
  check('bank client loads at /bank/ (window.__bank present)', true);
  await B.goto(`${BASE}/bank/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(() => B.evaluate(() => !!window.__bank), 15000, '__bank on B');

  // -- private room create + join by code ----------------------------------------------
  await A.evaluate(() => window.__bank.createPrivate('Alice'));
  const aJoined = await waitFor(async () => {
    const s = await bankState(A);
    return s !== null && Array.isArray(s.players) && s.players.some((p) => p.name === 'Alice') ? s : null;
  }, 10000, 'A createPrivate join');
  check('A createPrivate joins a bank room', true, `phase=${aJoined.phase} players=${aJoined.players.length}`);
  const missing = BANK_STATE_FIELDS.filter((f) => !(f in aJoined));
  check(
    'state() exposes the contract fields',
    missing.length === 0,
    missing.length > 0 ? `missing: ${missing}` : BANK_STATE_FIELDS.join('/'),
  );
  const code = await getRoomCode(A);
  check('private room join code obtained', code !== null, code ?? 'no code from state()/server-log/DOM');

  await B.evaluate((c) => window.__bank.joinPrivate('Bob', c), code);
  await waitFor(async () => {
    const s = await bankState(B);
    return s !== null && Array.isArray(s.players) && s.players.some((p) => p.name === 'Bob') ? s : null;
  }, 10000, 'B joinPrivate join');
  const bothSee2 = await waitFor(async () => {
    const [sa, sb] = await Promise.all([bankState(A), bankState(B)]);
    return sa !== null && sb !== null && sa.players.length === 2 && sb.players.length === 2
      ? { sa, sb }
      : null;
  }, 10000, 'players.length === 2 on both pages');
  check(
    'both pages see 2 players',
    true,
    `A sees [${bothSee2.sa.players.map((p) => p.name)}] B sees [${bothSee2.sb.players.map((p) => p.name)}]`,
  );

  // -- the seated lobby must NOT start itself ---------------------------------------------
  // Both seats are filled and the server says canStart — under the old rules the
  // room would already be dealing. The whole point of the manual-start change is
  // that reaching MIN_PLAYERS makes a room STARTABLE, not started, so hold well
  // past any plausible auto-start delay and prove the room stayed put: still
  // 'lobby' on both pages, round un-advanced, and canStart still true (the
  // server is telling us a press would land right now — the room COULD have
  // started and chose not to). `awaitingStart` is COSMETIC (it only separates a
  // post-match lobby from a cold one for the banner wording) and is deliberately
  // NOT part of this gate.
  let seatedLobby = null;
  try {
    seatedLobby = await waitFor(async () => {
      const s = await bankState(A);
      return s !== null && s.phase === 'lobby' && s.canStart === true && s.playerCount >= BANK_MIN_PLAYERS
        ? s
        : null;
    }, 15000, 'A sees a startable lobby (2 seated, canStart)');
  } catch {
    seatedLobby = await bankState(A); // recorded as a failure by the assertion below
  }
  const roundAtSeat = seatedLobby === null ? -1 : seatedLobby.round;
  await sleep(LOBBY_HOLD_MS);
  const [heldA, heldB] = await Promise.all([bankState(A), bankState(B)]);
  check(
    'lobby does not auto-start',
    seatedLobby !== null &&
      seatedLobby.canStart === true &&
      heldA !== null &&
      heldA.phase === 'lobby' &&
      heldA.round === roundAtSeat &&
      heldA.canStart === true &&
      heldB !== null &&
      heldB.phase === 'lobby' &&
      heldB.round === roundAtSeat,
    `after ${LOBBY_HOLD_MS}ms seated: A phase=${heldA?.phase} round=${heldA?.round} (was ${roundAtSeat}) ` +
      `canStart=${heldA?.canStart} playerCount=${heldA?.playerCount}/${BANK_MIN_PLAYERS} ` +
      `awaitingStart=${heldA?.awaitingStart} · B phase=${heldB?.phase} round=${heldB?.round}`,
  );

  // -- round 1 starts when a SEATED PLAYER presses START MATCH ----------------------------
  // The primary press of the suite goes through the real button, so the harness
  // exercises exactly what a player does (and proves the control is enabled,
  // visible and wired) rather than shortcutting to window.__bank.start().
  await pressStartButton(A, 'A clicks .btn-start (START MATCH)');
  await waitForPlaying(A, "phase 'playing' after A presses START MATCH");
  check("phase reaches 'playing' with 2 players", true, 'opened by A clicking button.btn-start');

  // -- (20) mid-round join: C sits down in round 1 and plays IMMEDIATELY -----------
  // docs/BANK.md "Join/leave": a mid-round joiner is appended to the END of the
  // order with banked=false — no spectating with banked=true until next round.
  const C = await launchOne('C');
  await C.goto(`${BASE}/bank/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(() => C.evaluate(() => !!window.__bank), 15000, '__bank on C');
  await C.evaluate((c) => window.__bank.joinPrivate('Carol', c), code);
  const threeWay = await waitFor(async () => {
    const [sa, sb, sc] = await Promise.all([bankState(A), bankState(B), bankState(C)]);
    return sa !== null &&
      sb !== null &&
      sc !== null &&
      sa.players.length === 3 &&
      sb.players.length === 3 &&
      sc.players.length === 3 &&
      sc.players.some((p) => p.name === 'Carol')
      ? { sa, sb, sc }
      : null;
  }, 10000, 'players.length === 3 on all three pages');
  check(
    'mid-round join: C joins round 1 — all three pages see 3 players',
    true,
    `C sees [${threeWay.sc.players.map((p) => p.name)}]`,
  );
  const carolOnC = threeWay.sc.players.find((p) => p.id === threeWay.sc.you);
  const carolOnA = threeWay.sa.players.find((p) => p.name === 'Carol');
  check(
    'mid-round join: C is NOT pre-banked (participates immediately)',
    carolOnC !== undefined && carolOnC.banked === false && carolOnA !== undefined && carolOnA.banked === false,
    `banked C-view=${carolOnC?.banked} A-view=${carolOnA?.banked}`,
  );
  // The turn must REACH C within one full cycle. A/B roll promptly when current
  // (C's own turn is left alone so it can be observed; the 30s auto-roll
  // backstops a stall); the poll rides over a round boundary if a bust7 lands
  // first — C keeps its slot (and banked=false) in the next round.
  const cId = threeWay.sc.you;
  const cTurnT0 = Date.now();
  let cTurn = null;
  while (Date.now() - cTurnT0 < 60000) {
    const [sa, sb, sc] = await Promise.all([bankState(A), bankState(B), bankState(C)]);
    if (sc !== null && sc.currentId !== null && sc.currentId === cId) {
      cTurn = sc;
      break;
    }
    if (!(await rollIfCurrent(A, sa))) await rollIfCurrent(B, sb);
    await sleep(300);
  }
  check(
    'mid-round join: the turn reaches C within one full cycle',
    cTurn !== null,
    cTurn !== null ? `round=${cTurn.round} currentId=${cTurn.currentId}` : 'C never became currentId within 60s',
  );

  // -- roll until the pot grows (first safe-window roll always adds to it) ----------------
  const rollT0 = Date.now();
  let potState = null;
  while (Date.now() - rollT0 < 60000) {
    const [sa, sb, sc] = await Promise.all([bankState(A), bankState(B), bankState(C)]);
    if (sa !== null && sa.phase === 'playing' && sa.pot > 0) {
      potState = sa;
      break;
    }
    if (!(await rollIfCurrent(A, sa)) && !(await rollIfCurrent(B, sb))) await rollIfCurrent(C, sc);
    await sleep(400);
  }
  check(
    'current player rolls until state().pot > 0',
    potState !== null,
    potState !== null ? `pot=${potState.pot} rollCount=${potState.rollCount} round=${potState.round}` : 'pot still 0 after 60s',
  );

  // -- roll EVENTS reach the UI (unwrap regression: log lines + dice animation) --------------
  {
    const logHasRoll = (p) =>
      p.evaluate(() => [...document.querySelectorAll('.log-line')].some((el) => /rolled/i.test(el.textContent ?? '')));
    const [la, lb] = await Promise.all([logHasRoll(A), logHasRoll(B)]);
    check('roll events reach the UI (event log shows a roll on both pages)', la && lb, `A=${la} B=${lb}`);
  }

  // -- felt-table shot (dice settled, pot up) ---------------------------------------------
  await sleep(900); // dice tumble (~600ms) settles on the rolled faces
  await shot(A, 'bank-table.png');

  // -- B banks mid-round, regardless of whose turn it is ------------------------------------
  const potAtBank = (await bankState(B)).pot;
  await B.evaluate(() => window.__bank.bank());
  const banked = await waitFor(async () => {
    const s = await bankState(B);
    if (s === null) return null;
    const me = meOf(s, 'Bob');
    return me !== null && me.banked === true ? { s, me } : null;
  }, 10000, 'B marked banked after bank()');
  check('B marked banked (bank() works on any turn)', true, `name=${banked.me.name}`);
  check(
    "B's score == pot at bank time",
    banked.me.score === potAtBank,
    `score=${banked.me.score} potAtBank=${potAtBank}`,
  );
  const aAfterBank = await bankState(A);
  check(
    'pot UNCHANGED by the bank (both pages)',
    banked.s.pot === potAtBank && aAfterBank !== null && aAfterBank.pot === potAtBank,
    `A.pot=${aAfterBank?.pot} B.pot=${banked.s.pot} (was ${potAtBank})`,
  );

  // -- the non-banked pages roll the round out (bust7 / all_banked) ----------------------
  // B sits the round out; A and C are the non-banked players. The pot only GROWS
  // on non-bust rolls, so a post-safe-window 7 ends it; the 30s auto-roll
  // backstops any stall. Cap the loop: match_end after round 10 also exits.
  const roundBefore = banked.s.round;
  const roundT0 = Date.now();
  let endSeen = null;
  while (Date.now() - roundT0 < 150000) {
    const [s, sc] = await Promise.all([bankState(A), bankState(C)]);
    if (s !== null) {
      if (s.phase !== 'playing' || s.round > roundBefore) {
        endSeen = s;
        break;
      }
      if (!(await rollIfCurrent(A, s))) await rollIfCurrent(C, sc);
    }
    await sleep(350);
  }
  check(
    'round ends with B banked (A rolls to bust7 / all banked)',
    endSeen !== null,
    endSeen !== null ? `phase=${endSeen.phase} round=${endSeen.round}` : 'no round end within 150s',
  );
  const advanced = await waitFor(async () => {
    const s = await bankState(A);
    return s !== null && (s.round > roundBefore || s.phase === 'matchEnd') ? s : null;
  }, 25000, 'round increment (or match_end)');
  check(
    'round increments after the round ends (or match_end)',
    true,
    `round ${roundBefore} -> ${advanced.round} phase=${advanced.phase}`,
  );

  // The loop above is allowed to exit on match_end, and a finished BANK match
  // does NOT roll into another one: it resets to the lobby and waits. Re-press
  // (best effort, no assertion of its own) so the reconnect scenario below runs
  // against a live table instead of a parked lobby.
  {
    const phase = await ensureMatchRunning(A);
    console.log(`note  pre-reconnect table phase: ${phase}`);
  }

  // -- (21) reconnect: B reloads and RESUMES its entry via the stored resume token -----
  // docs/BANK.md "Rejoin (resume token)": the client persists its playerId and
  // joinPrivate re-sends it as `resume`; the room re-binds the disconnected
  // entry to the NEW session id (order slot, score, banked preserved) instead
  // of appending a second Bob. Per the contract the rebound entry's id BECOMES
  // the new session id, so state().you rotates on reload — identity continuity
  // is asserted as: exactly one Bob, bound to B's current session (id === you),
  // the original id consumed, player count unchanged.
  const bOrig = await bankState(B);
  const bOrigYou = bOrig.you;
  const bOrigScore = bOrig.score; // banked in round 1; kept across rounds
  const aCountBefore = (await bankState(A)).players.length;
  await B.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  // welcomed again (fresh session) before joining: you is non-null once the
  // new welcome lands, so joinPrivate goes out on an open socket with the
  // client's stored resume token attached.
  await waitFor(
    () => B.evaluate(() => window.__bank?.state()?.you != null),
    15000,
    'B welcomed again after reload',
  );
  await B.evaluate((c) => window.__bank.joinPrivate('Bob', c), code);
  const bBack = await waitFor(async () => {
    const s = await bankState(B);
    if (s === null || s.you === null) return null;
    const me = s.players.find((p) => p.id === s.you);
    return me !== undefined && me.name === 'Bob' ? s : null;
  }, 10000, 'B back at the table after reload');
  const bobs = bBack.players.filter((p) => p.name === 'Bob');
  check(
    'rejoin: B resumes the SAME entry — one Bob, rebound to the new session (no duplicate)',
    bBack.players.length === aCountBefore &&
      bobs.length === 1 &&
      bobs[0].id === bBack.you &&
      !bBack.players.some((p) => p.id === bOrigYou),
    `you ${bOrigYou} -> ${bBack.you}; players=${bBack.players.length} (was ${aCountBefore})`,
  );
  check(
    "rejoin: B's banked score survives the reload",
    bobs[0].score === bOrigScore && bBack.score === bOrigScore,
    `score=${bBack.score} (was ${bOrigScore})`,
  );
  // Measured on A (not a hard gate): the same broadcast reaches every page,
  // so poll briefly for A's view to settle on the rebound entry, then check.
  const aAfterRejoin = await (async () => {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < 10000) {
      const s = await bankState(A);
      if (s !== null) {
        last = s;
        const seen = s.players.filter((p) => p.name === 'Bob');
        if (s.players.length === aCountBefore && seen.length === 1 && seen[0].id === bBack.you) return s;
      }
      await sleep(200);
    }
    return last;
  })();
  const aBobs = aAfterRejoin === null ? [] : aAfterRejoin.players.filter((p) => p.name === 'Bob');
  check(
    'rejoin: A sees players.length unchanged (no ghost duplicate)',
    aAfterRejoin !== null && aAfterRejoin.players.length === aCountBefore && aBobs.length === 1,
    `A sees ${aAfterRejoin?.players.length} players (was ${aCountBefore}), Bobs=${aBobs.length}`,
  );

  // -- (14) room variants: settings reach state() + the header chip --------------------
  // A's createPrivate(name, settings) makes the lobby leave the first room and
  // open a SECOND private room on the variant {sevenBonus:false, totalRounds:20}
  // (raceTarget defaults to null); B rejoins by the fresh code. state().settings
  // must deep-match the frozen variant on both pages and the table header must
  // show its label ("20 rounds · plain 7").
  await A.evaluate((v) => window.__bank.createPrivate('Alice', v), VARIANT_CREATE);
  const aVariant = await waitFor(async () => {
    const s = await bankState(A);
    return s !== null && s.phase === 'lobby' && s.players.length === 1 && s.players[0]?.name === 'Alice'
      ? s
      : null;
  }, 10000, 'A in a fresh (variant) private room');
  check(
    'variant: A createPrivate(name, settings) opens a fresh private room',
    true,
    `phase=${aVariant.phase} players=${aVariant.players.length}`,
  );

  const variantCode = await getRoomCode(A);
  check(
    'variant: new join code obtained',
    variantCode !== null,
    variantCode !== null ? `${variantCode} (first room was ${code})` : 'no code from state()/server-log/DOM',
  );

  await B.evaluate((c) => window.__bank.joinPrivate('Bob', c), variantCode);
  const variantBoth = await waitFor(async () => {
    const [sa, sb] = await Promise.all([bankState(A), bankState(B)]);
    return sa !== null && sb !== null && sa.players.length === 2 && sb.players.length === 2
      ? { sa, sb }
      : null;
  }, 10000, 'both pages in the variant room');
  check('variant: B joins by code, both pages see 2 players', true);

  check(
    'variant: state().settings deep-matches on both pages',
    settingsMatch(variantBoth.sa) && settingsMatch(variantBoth.sb),
    `A=${JSON.stringify(variantBoth.sa.settings)} B=${JSON.stringify(variantBoth.sb.settings)}`,
  );

  const [headerA, headerB] = await Promise.all([
    A.evaluate(() => {
      const top = document.querySelector('.table-top');
      const table = document.querySelector('.table');
      return `${top?.textContent ?? ''}\n${table?.textContent ?? ''}`;
    }),
    B.evaluate(() => {
      const top = document.querySelector('.table-top');
      const table = document.querySelector('.table');
      return `${top?.textContent ?? ''}\n${table?.textContent ?? ''}`;
    }),
  ]);
  check(
    'variant: table header chip shows the variant label (both pages)',
    variantLabelIn(headerA) && variantLabelIn(headerB),
    `A="${headerA.split('\n')[0]?.trim()}" B="${headerB.split('\n')[0]?.trim()}"`,
  );

  // -- variant room: a FRESH room is a fresh lobby, so it waits for START too -------
  // createPrivate opened a brand-new room; filling its second seat did not start
  // it (asserted below on the state read here, which is still the pre-press
  // lobby), and pressing its own START MATCH button opens match 2. Soft-gated:
  // a failure here must not abort the invite/leave scenarios that follow.
  const variantLobby = await bankState(A);
  let variantPlaying = null;
  try {
    await pressStartButton(A, 'A clicks .btn-start in the variant room');
    variantPlaying = await waitForPlaying(A, "variant room reaches 'playing' after START");
  } catch {
    // recorded as a failing assertion below
  }
  check(
    'variant: the fresh room waits for START too, then its button opens match 2',
    variantLobby !== null &&
      variantLobby.phase === 'lobby' &&
      variantLobby.canStart === true &&
      variantPlaying !== null,
    `pre-press phase=${variantLobby?.phase} canStart=${variantLobby?.canStart} ` +
      `playerCount=${variantLobby?.playerCount} -> post-press phase=${variantPlaying?.phase ?? 'never playing'} ` +
      `round=${variantPlaying?.round}`,
  );

  // -- (26) invite: the private-room code is shareable from the table UI ----------
  // A is in the variant private room. The table screen must carry the room's
  // code in a visible element (the share chip) plus a COPY-INVITE-ish button,
  // and /bank/?code=<code> on a fresh page D must either prefill the menu's
  // code input or auto-join the room straight from the query param. These are
  // soft checks (no waitFor abort) so a lagging client feature fails only the
  // invite assertions. D is closed at the end (its ghost, if it auto-joined,
  // is purged at the round's end per docs/BANK.md "Ghost purge").
  const inviteCode = (await bankState(A))?.code ?? variantCode;
  const codeChip = await A.evaluate((c) => {
    if (c === null) return null;
    const scope = document.querySelector('.table');
    if (scope === null) return null;
    const visible = (el) => {
      for (let n = el; n !== null; n = n.parentElement) {
        if (n.classList !== undefined && n.classList.contains('hidden')) return false;
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const leaf = [...scope.querySelectorAll('*')].find(
      (el) =>
        el.children.length === 0 &&
        (el.textContent ?? '').toUpperCase().includes(c.toUpperCase()) &&
        visible(el),
    );
    return leaf === undefined ? null : (leaf.textContent ?? '').trim();
  }, inviteCode ?? null);
  check(
    'invite: code chip visible in the table UI carrying the room code',
    inviteCode !== null && codeChip !== null && codeChip.toUpperCase().includes(inviteCode.toUpperCase()),
    codeChip !== null ? `"${codeChip}" (code ${inviteCode})` : `no visible element carries ${inviteCode}`,
  );

  const copyBtn = await A.evaluate(() => {
    const btn = [...document.querySelectorAll('.table button')].find((b) =>
      /copy|invite/i.test(b.textContent ?? ''),
    );
    return btn === undefined ? null : (btn.textContent ?? '').trim();
  });
  check("invite: a 'COPY INVITE'-ish button exists in the table UI", copyBtn !== null, copyBtn ?? 'none found');

  const D = await launchOne('D');
  await D.goto(`${BASE}/bank/?code=${encodeURIComponent(inviteCode ?? '')}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await waitFor(() => D.evaluate(() => !!window.__bank), 15000, '__bank on D');
  let dVia = null;
  try {
    dVia = await waitFor(async () => {
      const s = await bankState(D);
      if (s !== null && s.you !== null && s.players.some((p) => p.id === s.you)) {
        return `auto-join (D in the room, players=${s.players.length})`;
      }
      const inputVal = await D.evaluate(() => document.querySelector('.menu-code-input')?.value ?? null);
      return inviteCode !== null && inputVal === inviteCode ? `prefill (input=${inputVal})` : null;
    }, 10000, 'D ?code= prefill/auto-join');
  } catch {
    // recorded as a failing check below — the leave flow does not depend on D
  }
  check(
    'invite: /bank/?code=<code> prefills the code input (or auto-joins)',
    dVia !== null,
    dVia ?? 'neither prefill nor auto-join within 10s',
  );
  await D.close();

  // -- (27) leave: A's LEAVE button exits to the menu and frees the seat ----------
  // game.ts wires the table top bar's DIRECT-child `button.btn.btn-small` (text
  // 'LEAVE') to leaveToMenu('') -> {t:'leave'} + showMenu (the COPY INVITE button
  // shares the classes but is nested inside .table-invite — the child combinator
  // keeps the selector unique). An explicit leave also drops the resume record
  // (clearResume), so A must NOT auto-rejoin: B's player count drops by one
  // within 5s and stays there, A still on the menu 5s later.
  const LEAVE_SEL = '.table-top > button.btn-small';
  await A.waitForSelector(LEAVE_SEL, { visible: true, timeout: 10000 });
  const leaveLabel = await A.evaluate(
    (sel) => document.querySelector(sel)?.textContent?.trim() ?? null,
    LEAVE_SEL,
  );
  check('leave: the top-bar LEAVE button is present', leaveLabel === 'LEAVE', leaveLabel ?? 'not found');

  const bBeforeLeave = (await bankState(B)).players.length;
  await A.click(LEAVE_SEL);
  const aMenu = await waitFor(async () => {
    const onMenu = await A.evaluate(() => {
      const m = document.querySelector('.screen.menu');
      return m !== null && !m.classList.contains('hidden');
    });
    if (!onMenu) return null;
    const s = await bankState(A);
    return s !== null && s.phase === 'none' && s.players.length === 0 ? s : null;
  }, 5000, 'A back on the menu after LEAVE');
  check('leave: A lands back on the menu (menu screen visible)', true, `phase=${aMenu.phase}`);

  const bAfter = await waitFor(async () => {
    const s = await bankState(B);
    return s !== null && s.players.length === bBeforeLeave - 1 && !s.players.some((p) => p.name === 'Alice')
      ? s
      : null;
  }, 5000, "B's players.length drops by one after A leaves");
  check(
    "leave: B's state().players.length drops to 1 within 5s (Alice gone)",
    true,
    `${bBeforeLeave} -> ${bAfter.players.length} [${bAfter.players.map((p) => p.name)}]`,
  );

  await sleep(5000);
  const aStillMenu = await A.evaluate(() => {
    const m = document.querySelector('.screen.menu');
    return m !== null && !m.classList.contains('hidden');
  });
  const aIdle = await bankState(A);
  const bIdle = await bankState(B);
  check(
    'leave: no auto-rejoin — A still on the menu, players unchanged after 5 more seconds',
    aStillMenu &&
      aIdle !== null &&
      aIdle.phase === 'none' &&
      aIdle.players.length === 0 &&
      bIdle !== null &&
      bIdle.players.length === bAfter.players.length,
    `A.onMenu=${aStillMenu} A.players=${aIdle?.players.length} B.players=${bIdle?.players.length}`,
  );

  // -- error surface --------------------------------------------------------------------------
  check('zero console/page/network errors on both pages', pageErrors.length === 0, `${pageErrors.length}`);
}

// ---- runner ---------------------------------------------------------------------------
let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error(`\nE2E-BANK ABORTED: ${err instanceof Error ? err.message : String(err)}`);
  check('e2e-bank completed without abort', false);
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  if (serverChild && serverChild.exitCode === null) {
    serverChild.kill('SIGTERM');
    await sleep(400);
    if (serverChild.exitCode === null) serverChild.kill('SIGKILL');
  }

  console.log('\n================ E2E-BANK SUMMARY ================');
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
  console.log(exitCode === 0 ? '\nE2E-BANK GREEN' : `\nE2E-BANK RED (${failed} failed assertions, ${pageErrors.length} page errors)`);
  process.exit(exitCode);
}

#!/usr/bin/env node
// ============================================================================
// e2e-bank — prove BANK runs end-to-end in a real (headless) browser.
//
// Builds the whole monorepo first (npm run build must produce
// games/bank/client/dist), spawns the production platform server
// (platform/server/dist), then drives THREE browser instances (separate
// processes: no cross-tab timer throttling) through the window.__bank debug
// surface against the multi-game static route /bank/:
//   A createPrivate('Alice') -> private-room code; B joinPrivate('Bob', code);
//   both see 2 players; the current player (found by polling state()) rolls
//   until pot > 0; B banks mid-round REGARDLESS of turn -> B score == pot at
//   bank time, the pot itself is UNCHANGED (banking never drains it), B is
//   marked banked; the non-banked pages keep rolling until the round ends
//   (bust7 / all_banked; the 30s auto-roll backstops termination) -> the
//   round increments (or match_end after round 10 — loop is capped).
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
//   ("20 rounds · plain 7").
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
const PORT = Number(process.env.E2E_PORT ?? 8080);
const BASE = `http://localhost:${PORT}`;
const SHOTS_DIR = path.join(ROOT, 'screenshots');

// fields the BANK.md debug surface freezes for window.__bank.state()
const BANK_STATE_FIELDS = ['phase', 'round', 'pot', 'rollCount', 'currentId', 'you', 'players'];

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
  buildAll();
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

  // -- round 1 starts once MIN_PLAYERS are connected -------------------------------------
  await waitFor(async () => {
    const s = await bankState(A);
    return s !== null && s.phase === 'playing' ? s : null;
  }, 15000, "phase 'playing'");
  check("phase reaches 'playing' with 2 players", true);

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

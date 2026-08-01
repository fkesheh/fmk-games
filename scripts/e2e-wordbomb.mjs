#!/usr/bin/env node
// ============================================================================
// e2e-wordbomb — prove WORDBOMB runs end-to-end in real (headless) browsers.
//
// Builds the whole monorepo first (npm run build must produce
// games/wordbomb/client/dist; set E2E_SKIP_BUILD=1 to reuse an existing dist),
// spawns the production platform server (platform/server/dist) on E2E_PORT
// (default 8184), then drives THREE browser instances (separate processes: no
// cross-tab timer throttling) through the window.__wordbomb debug surface
// (docs/WORDBOMB.md §4.3) against the multi-game static route /wordbomb/.
//
// It implements the thirteen NUMBERED assertions of docs/WORDBOMB.md §8.2.
// Everything else printed is context, not a gate.
//
// ---------------------------------------------------------------------------
// THE MANUAL START. Nothing on this platform auto-starts. The room sits in
// `phase === 'lobby'` until a SEATED player sends `{t:'wb_start'}`; the suite
// therefore (a) holds the full lobby and proves it did NOT start itself, and
// (b) presses start via __wordbomb.start() once the server reports canStart.
// A LOBBY_COUNTDOWN_MS = 3000 beat (`countdownEndsAt !== 0`) follows the press
// before `phase` becomes 'live'. A finished match returns to `lobby` and WAITS.
//
// ---------------------------------------------------------------------------
// WHY THERE IS A THIRD BROWSER (page C, "Carol"), and why it is not a cheat.
//
// §8.2 assertion 11 reloads page B mid-round. A reload drops B's socket, which
// the room sees as a disconnect. With exactly two seats that takes the room to
// playerCount() === 1 < MIN_PLAYERS, and games/wordbomb/server/src/room.ts:273
// then calls abortToLobby(), which NULLS EVERY PLAYER'S LOCKED WORD
// (room.ts:523) and resets the room to `lobby` (room.ts:533). So at exactly
// MIN_PLAYERS the §2.1 "count drops below MIN_PLAYERS -> abort" rule and I8
// ("rejoining mid-round restores your score and your locked word") are in
// direct conflict: with two browsers assertion 11 CANNOT pass, and the abort
// would also destroy the match that assertions 9/10/12 depend on. Carol is
// seated from round 3 purely so the room keeps >= MIN_PLAYERS across B's
// reload. This does not weaken assertion 11 — score restore, yourWord restore
// and the no-ghost-duplicate check are all still made on the real reload.
// (Reported as a finding; NO game source was touched.)
//
// Carol is a real player, so she also plays: every extra scoring word widens
// the used-word coverage that assertion 9 depends on (see below).
//
// ---------------------------------------------------------------------------
// ASSERTION 9 (`already_used`) — why the match is 20 rounds of `easy`.
//
// Validation order (§5, room.ts:580-601) puts `already_used` LAST, after
// `missing_fragment`: a reused word is only ever reported as reused if it also
// contains the CURRENT round's fragment. And `p.used` gains exactly ONE word
// per player per round, committed at boom resolution (room.ts:452), while
// fragments never repeat inside a match (I5). The collision therefore cannot be
// forced — it can only be made overwhelmingly likely by construction:
//
//   * difficulty 'easy'  -> the smallest fragment pool (512) and the densest
//     supply of long words covering many of its fragments;
//   * every scoring word is chosen to MAXIMISE the number of easy-pool 3-grams
//     the table has not yet covered and that have not already been drawn as a
//     fragment (a drawn fragment can never recur, so covering it is worthless);
//   * every round from 2 on, all three used-sets are checked against the new
//     fragment and the probe fires on whichever player has a hit (A first).
//
// MEASURED offline against the committed blob (8,000 Monte-Carlo matches,
// fragments drawn without replacement from the real easy pool, the real
// dictionary, the same greedy this file uses):
//
//        seats  rounds=10  rounds=15  rounds=18  rounds=20
//          2      61.5%      89.5%      96.4%      98.7%
//          3      69.9%      95.1%      98.9%      99.67%   <- chosen
//
// rounds=20 + easy + the three seats already required by assertion 11 is the
// smallest configuration clearing the 99.5% bar, at ~7 minutes of wall clock
// (20 x (fuse 8-15s + 0.25s grace + 8.8s reveal)). A single extra match is
// played as a safety net ONLY if the probe never fired, which pushes the miss
// rate to ~1e-5 for a cost paid in <1% of runs.
//
// ---------------------------------------------------------------------------
// SCORING is re-implemented here from docs/WORDBOMB.md §1.1 and self-tested
// against that section's table before the browsers launch. Nothing is imported
// from @wordbomb/*: the harness must be able to disagree with the game.
//
// The dictionary is read straight off the committed artifact
// games/wordbomb/server/data/words.blob with node:fs (latin1, newline
// delimited, sorted). Measured: 269,746 words — matching §3.
//
// Exit 0 only if every assertion passes AND zero page/console/network errors
// were seen on any page (benign favicon noise excluded).
// ============================================================================
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 8184);
const BASE = `http://localhost:${PORT}`;
const SHOTS_DIR = path.join(ROOT, 'screenshots');
const BLOB_PATH = path.join(ROOT, 'games/wordbomb/server/data/words.blob');

// fields the WORDBOMB.md §4.3 debug surface freezes for window.__wordbomb.state()
const WB_STATE_FIELDS = [
  'phase',
  'round',
  'rounds',
  'fragment',
  'players',
  'seated',
  'minPlayers',
  'canStart',
  'you',
  'yourWord',
];

// ---- game constants MIRRORED (never imported) from
// games/wordbomb/shared/src/config.ts. They are pure data; the harness has to
// know them to time itself, and importing them would make the suite agree with
// the game by construction.
const WB_MIN_PLAYERS = 2;
const WB_MAX_SCORING_LEN = 12;
const WB_MIN_WORD_LEN = 3;
const WB_MAX_WORD_LEN = 15;
const WB_LOBBY_COUNTDOWN_MS = 3000;
const WB_FUSE_MAX_MS = 15000;
const WB_SUBMIT_COOLDOWN_MS = 400;
const WB_COMMON_MAX_LEN = 8;
const WB_FRAGMENT_LEN = 3;
const WB_EASY_BAND = { minInclusive: 200, maxExclusive: 400 };

// Space submissions comfortably clear of SUBMIT_COOLDOWN_MS or the server
// answers `too_fast` and the assertion under test never runs.
const SUBMIT_GAP_MS = WB_SUBMIT_COOLDOWN_MS + 150;

// The match shape assertion 9 was measured against. ROUNDS_MAX is 20.
const ROUNDS = Number(process.env.E2E_WB_ROUNDS ?? 20);
const DIFFICULTY = process.env.E2E_WB_DIFFICULTY ?? 'easy';

// How long the seated lobby is held to prove nothing but a player starts it.
const LOBBY_HOLD_MS = 6000;
// fuse max + grace + reveal(3) + slack: a whole round, generously.
const ROUND_TIMEOUT_MS = 40000;

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
    await sleep(120);
  }
}

/** Real structural deep-equality (assertion 6 may not be a length spot-check). */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

// ---- INDEPENDENT SCORING (docs/WORDBOMB.md §1.1) --------------------------------
// L = min(len, 12); points = max(L, floor(12 * L / dupes^1.5)). Deliberately NOT
// imported from @wordbomb/shared — a harness that shares the implementation
// cannot detect a change in it.
function expectedPoints(word, dupes) {
  if (word === null || word.length === 0) return 0;
  const L = Math.min(word.length, WB_MAX_SCORING_LEN);
  return Math.max(L, Math.floor((WB_MAX_SCORING_LEN * L) / Math.pow(dupes, 1.5)));
}

/** Self-test against the table in §1.1 — run before anything is launched. */
function selfTestScoring() {
  const cases = [
    ['a'.repeat(12), 1, 144],
    ['rationale', 1, 108],
    ['nation', 1, 72],
    ['nation', 2, 25],
    ['a'.repeat(12), 3, 27],
    ['nation', 4, 9],
    ['tip', 8, 3],
  ];
  const bad = cases.filter(([w, d, want]) => expectedPoints(w, d) !== want);
  if (bad.length > 0) {
    throw new Error(
      `harness scoring disagrees with docs §1.1: ${bad
        .map(([w, d, want]) => `len${w.length}/dupes${d} -> ${expectedPoints(w, d)} (want ${want})`)
        .join(', ')}`,
    );
  }
  console.log('scoring self-test: 7/7 rows of docs/WORDBOMB.md §1.1 reproduced');
}

// ---- THE DICTIONARY -------------------------------------------------------------
// Read straight off the committed artifact. NOTHING is imported from
// @wordbomb/server: the harness must be independent of the code it tests.
let WORDS = [];
let EASY_POOL = new Set();
const GRAM_CACHE = new Map();
const CAND_CACHE = new Map();

function loadDictionary() {
  if (!existsSync(BLOB_PATH)) throw new Error(`words.blob missing at ${BLOB_PATH}`);
  const buf = readFileSync(BLOB_PATH);
  WORDS = buf
    .toString('latin1')
    .split('\n')
    .filter((w) => w.length > 0);

  const re = /^[a-z]{3,15}$/;
  const offSpec = WORDS.filter((w) => !re.test(w)).length;
  let inversions = 0;
  for (let i = 1; i < WORDS.length; i++) if (WORDS[i] <= WORDS[i - 1]) inversions++;

  // `common(g)`: words of length <= COMMON_MAX_LEN containing g, counted ONCE
  // per word. Mirrors the derivation in server/src/dict.ts (which we may not
  // import) so the easy band can be reproduced here as pure config data.
  const common = new Map();
  for (const w of WORDS) {
    if (w.length > WB_COMMON_MAX_LEN) continue;
    const seen = new Set();
    for (let i = 0; i + WB_FRAGMENT_LEN <= w.length; i++) {
      const g = w.slice(i, i + WB_FRAGMENT_LEN);
      if (seen.has(g)) continue;
      seen.add(g);
      common.set(g, (common.get(g) ?? 0) + 1);
    }
  }
  EASY_POOL = new Set(
    [...common.entries()]
      .filter(([, c]) => c >= WB_EASY_BAND.minInclusive && c < WB_EASY_BAND.maxExclusive)
      .map(([g]) => g),
  );

  console.log(
    `dictionary: ${WORDS.length} words from words.blob (${buf.length} bytes), ` +
      `off-spec=${offSpec}, sort inversions=${inversions}, easy fragment pool=${EASY_POOL.size}`,
  );
  return { size: WORDS.length, offSpec, inversions, easyPool: EASY_POOL.size };
}

/** The easy-pool 3-grams a word covers (deduped). */
function poolGrams(word) {
  let g = GRAM_CACHE.get(word);
  if (g !== undefined) return g;
  const seen = new Set();
  for (let i = 0; i + WB_FRAGMENT_LEN <= word.length; i++) {
    const s = word.slice(i, i + WB_FRAGMENT_LEN);
    if (EASY_POOL.has(s)) seen.add(s);
  }
  g = [...seen];
  GRAM_CACHE.set(word, g);
  return g;
}

/** Every dictionary word containing `fragment` (cached; the blob scan is ~10ms). */
function candidatesFor(fragment) {
  let c = CAND_CACHE.get(fragment);
  if (c !== undefined) return c;
  c = WORDS.filter((w) => w.includes(fragment) && w.length >= WB_MIN_WORD_LEN && w.length <= WB_MAX_WORD_LEN);
  CAND_CACHE.set(fragment, c);
  return c;
}

/**
 * The greedy that assertion 9 rests on: among words containing `fragment`,
 * take the one covering the most easy-pool 3-grams that are neither already
 * covered by the table nor already DRAWN as a fragment (a drawn fragment can
 * never recur — I5 — so covering it buys nothing). Ties break on length, then
 * lexicographically, so the choice is deterministic.
 */
function bestCoverageWord(fragment, coveredUnion, drawn, accept) {
  let best = null;
  let bestScore = -1;
  let bestLen = -1;
  for (const w of candidatesFor(fragment)) {
    if (accept !== undefined && !accept(w)) continue;
    let s = 0;
    for (const g of poolGrams(w)) {
      if (drawn.has(g) || coveredUnion.has(g)) continue;
      s++;
    }
    if (s > bestScore || (s === bestScore && (w.length > bestLen || (w.length === bestLen && best !== null && w < best)))) {
      best = w;
      bestScore = s;
      bestLen = w.length;
    }
  }
  return best;
}

/**
 * The protocol's own vocabulary — every tag, field name, enum value and player
 * name that legitimately appears in a client's decoded frame stream. It is
 * joined with spaces so no cross-token trigram is invented.
 *
 * Assertion 3 asks whether B's stream contains a trigram of A's WORD. A trigram
 * that is present because the wire format spells `event` or `playerId` is not a
 * leak, so A's word is CHOSEN to avoid the scaffolding — and then the real
 * stream is checked strictly against every one of its trigrams. Filtering the
 * candidate, not the assertion, is what keeps the check honest.
 */
const PROTOCOL_VOCAB = [
  'welcome', 'playerId', 'room_list', 'room_info', 'rooms', 'roomId', 'game', 'wordbomb', 'name', 'players',
  'maxPlayers', 'phase', 'visibility', 'pong', 'ping', 'ts', 'error', 'code', 'message', 'event', 'ev',
  'wb_public', 'wb_private', 'wb_locked', 'wb_reject', 'wb_boom', 'wb_match_end', 'wb_submit', 'wb_start',
  'round', 'rounds', 'fragment', 'fuseMinMs', 'fuseMaxMs', 'roundStartedAt', 'revealEndsAt', 'countdownEndsAt',
  'matchEndsAt', 'difficulty', 'easy', 'normal', 'hard', 'winnerId', 'seated', 'minPlayers', 'canStart',
  'id', 'score', 'connected', 'locked', 'you', 'yourWord', 'submitsLeft', 'reason', 'answers', 'word',
  'dupes', 'points', 'standings', 'lobby', 'live', 'reveal', 'matchEnd', 'true', 'false', 'null',
  'Alice', 'Bob', 'Carol', 'not_live', 'too_fast', 'bad_chars', 'too_short', 'too_long', 'missing_fragment',
  'not_a_word', 'already_used', 'private', 'public', 'settings', 'no_room', 'room_full', 'state', 'joined', 'left',
]
  .join(' ')
  .toLowerCase();

/** Every substring of `w` of length >= 3 (the assertion-3 needle set). */
function substrings3plus(w) {
  const out = new Set();
  for (let i = 0; i < w.length; i++) {
    for (let j = i + 3; j <= w.length; j++) out.add(w.slice(i, j));
  }
  return [...out];
}

/**
 * Do `a` and `b` share any substring of length >= 3 OTHER than the round's
 * fragment? (Every legal word contains the fragment, so sharing it is forced.)
 * Checking trigrams is sufficient: any longer shared substring contains one.
 */
function sharesBeyondFragment(a, b, fragment) {
  for (let i = 0; i + 3 <= a.length; i++) {
    const g = a.slice(i, i + 3);
    if (g === fragment) continue;
    if (b.includes(g)) return true;
  }
  return false;
}

// ---- build + server -------------------------------------------------------------
function buildAll() {
  console.log('build: npm run build');
  const r = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`npm run build exited with code ${r.status}`);
  const wbIndex = path.join(ROOT, 'games/wordbomb/client/dist/index.html');
  if (!existsSync(wbIndex)) {
    throw new Error('games/wordbomb/client/dist/index.html missing after build (wordbomb client not wired into npm run build?)');
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

async function waitForServer(timeoutMs = 25000) {
  const t0 = Date.now();
  for (;;) {
    if (serverChild.exitCode !== null) throw new Error(`server exited early (${serverChild.exitCode})`);
    try {
      const res = await fetch(`${BASE}/wordbomb/`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`server did not serve /wordbomb/ on :${PORT} within ${timeoutMs}ms`);
    await sleep(250);
  }
}

// ---- browser --------------------------------------------------------------------
// DOM-only client (no WebGL): the plain headless shell is enough; the
// anti-throttling flags keep the fuse bar + 100ms tick at full rate.
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
  await page.screenshot({ path: file, timeout: 90000 }).catch(() => {});
}

// ---- debug-surface wrappers --------------------------------------------------------
const wbState = (page) => page.evaluate(() => window.__wordbomb?.state() ?? null);
const wbRejectFrames = (page) =>
  page.evaluate(
    () =>
      window.__wordbomb
        ?.messageLog()
        .filter((m) => m !== null && typeof m === 'object' && m.t === 'event' && m.ev && m.ev.t === 'wb_reject')
        .map((m) => m.ev.reason) ?? [],
  );
const wbBoom = (page) => page.evaluate(() => window.__wordbomb?.lastBoom() ?? null);
const wbReject = (page) => page.evaluate(() => window.__wordbomb?.lastReject() ?? null);
const wbLogLen = (page) => page.evaluate(() => window.__wordbomb?.messageLog().length ?? 0);
const wbSubmit = (page, word) => page.evaluate((w) => window.__wordbomb.submit(w), word);
const wbStart = (page) => page.evaluate(() => window.__wordbomb.start());
const wbJoin = (page, name, code) =>
  page.evaluate((n, c) => window.__wordbomb.joinPrivate(n, c), name, code);

/** Player row for `name` in a state snapshot. Ids ROTATE on resume, names do not. */
const rowOf = (s, name) => (s === null ? null : (s.players.find((p) => p.name === name) ?? null));

/**
 * Submit and read back the reason of the NEW wb_reject frame. Counting frames
 * rather than polling lastReject() is what makes this safe when consecutive
 * rejections carry the same reason (lastReject() would not appear to change).
 */
async function submitExpectingReject(page, word, timeoutMs = 8000) {
  const before = (await wbRejectFrames(page)).length;
  await wbSubmit(page, word);
  const frames = await waitFor(
    async () => {
      const f = await wbRejectFrames(page);
      return f.length > before ? f : null;
    },
    timeoutMs,
    `a new wb_reject frame after submitting "${word}"`,
  );
  return { reason: frames[frames.length - 1], lastReject: await wbReject(page) };
}

/**
 * The private-room join code. Primary: state().code. Fallbacks: the lobby's
 * creation log line, then a token scraped from the DOM.
 */
async function getRoomCode(page) {
  const fromState = await page.evaluate(() => {
    const s = window.__wordbomb?.state?.();
    return s && typeof s.code === 'string' && s.code.length > 0 ? s.code : null;
  });
  if (fromState !== null) return fromState;
  const matches = [...serverLog.matchAll(/created \(private, code (\S+), game wordbomb\)/g)];
  if (matches.length > 0) return matches[matches.length - 1][1];
  return page.evaluate(() => {
    const m = /\b([A-Z0-9]{5})\b/.exec(document.body.innerText);
    return m !== null ? m[1] : null;
  });
}

// ---- phase helpers ------------------------------------------------------------------
/**
 * Poll until a round strictly after `afterRound` is LIVE, or the match ends.
 * Returns { round, fragment } or null at matchEnd/lobby.
 */
async function waitForLiveRound(page, afterRound, timeoutMs = ROUND_TIMEOUT_MS) {
  const t0 = Date.now();
  for (;;) {
    const s = await wbState(page);
    if (s !== null) {
      if (s.phase === 'live' && s.round > afterRound && typeof s.fragment === 'string') {
        return { round: s.round, fragment: s.fragment, state: s };
      }
      if (s.phase === 'matchEnd') return null;
      if (s.phase === 'lobby' && s.round === 0 && afterRound > 0) return null; // aborted
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`timeout (${timeoutMs}ms) waiting for round > ${afterRound} to go live`);
    }
    await sleep(120);
  }
}

/** Poll until this page holds the boom for `round`. */
async function waitForBoom(page, round, timeoutMs = ROUND_TIMEOUT_MS) {
  return waitFor(
    async () => {
      const [s, boom] = await Promise.all([wbState(page), wbBoom(page)]);
      if (s === null || boom === null) return null;
      if (s.round !== round) return null;
      return { boom, state: s };
    },
    timeoutMs,
    `wb_boom for round ${round}`,
  );
}

/** Press START the way a seated player does, gated on the server's own canStart. */
async function pressStart(page, label, timeoutMs = 30000) {
  const ready = await waitFor(
    async () => {
      const s = await wbState(page);
      return s !== null && s.phase === 'lobby' && s.canStart === true ? s : null;
    },
    timeoutMs,
    `${label}: a startable lobby`,
  );
  await wbStart(page);
  return ready;
}

// ---- per-match bookkeeping ----------------------------------------------------------
function newMatchBooks(names) {
  return {
    fragments: [],
    drawn: new Set(),
    coveredUnion: new Set(), // easy-pool 3-grams covered by ANY player's used words
    used: new Map(names.map((n) => [n, new Set()])), // name -> words actually SCORED
    points: new Map(names.map((n) => [n, 0])), // name -> summed wb_boom points
  };
}

/** Fold a resolved round into the books, from the authoritative boom payload. */
function foldBoom(books, answers) {
  for (const a of answers) {
    if (a.word === null) continue;
    const set = books.used.get(a.name);
    if (set !== undefined) set.add(a.word);
    for (const g of poolGrams(a.word)) books.coveredUnion.add(g);
    books.points.set(a.name, (books.points.get(a.name) ?? 0) + a.points);
  }
}

// ============================================================================
// main
// ============================================================================
const A9 = { fired: false, detail: '', attempts: 0 };
const A7 = { rounds: 0, bad: [] };
const A6 = { rounds: 0, bad: [] };

async function main() {
  await mkdir(SHOTS_DIR, { recursive: true });
  selfTestScoring();
  const dict = loadDictionary();
  check(
    'words.blob parses to a sorted, on-spec dictionary',
    dict.size > 0 && dict.offSpec === 0 && dict.inversions === 0 && dict.easyPool >= 60,
    `${dict.size} words, off-spec=${dict.offSpec}, inversions=${dict.inversions}, easy pool=${dict.easyPool}`,
  );

  if (process.env.E2E_SKIP_BUILD !== '1') buildAll();
  startServer();
  await waitForServer();
  console.log(`server up on ${BASE} (wordbomb client at /wordbomb/)`);

  const A = await launchOne('A');
  const B = await launchOne('B');
  const C = await launchOne('C');

  for (const [page, tag] of [[A, 'A'], [B, 'B'], [C, 'C']]) {
    await page.goto(`${BASE}/wordbomb/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitFor(() => page.evaluate(() => !!window.__wordbomb), 15000, `__wordbomb on ${tag}`);
  }
  check('wordbomb client loads at /wordbomb/ (window.__wordbomb present on all pages)', true);

  // ==========================================================================
  // ASSERTION 1 — A createPrivate -> code; B joinPrivate -> both see 2 players
  // ==========================================================================
  await A.evaluate(
    (r, d) => window.__wordbomb.createPrivate('Alice', { rounds: r, difficulty: d }),
    ROUNDS,
    DIFFICULTY,
  );
  const aJoined = await waitFor(
    async () => {
      const s = await wbState(A);
      return s !== null && Array.isArray(s.players) && s.players.some((p) => p.name === 'Alice') ? s : null;
    },
    12000,
    'A createPrivate join',
  );
  const missing = WB_STATE_FIELDS.filter((f) => !(f in aJoined));
  check(
    'state() exposes the §4.3 contract fields',
    missing.length === 0,
    missing.length > 0 ? `missing: ${missing}` : WB_STATE_FIELDS.join('/'),
  );
  const code = await getRoomCode(A);
  check('private room join code obtained', code !== null && code.length > 0, code ?? 'no code');
  check(
    `room opened on the measured settings (rounds=${ROUNDS}, ${DIFFICULTY})`,
    aJoined.rounds === ROUNDS && aJoined.difficulty === DIFFICULTY,
    `rounds=${aJoined.rounds} difficulty=${aJoined.difficulty}`,
  );

  await wbJoin(B, 'Bob', code);
  const seated2 = await waitFor(
    async () => {
      const [sa, sb] = await Promise.all([wbState(A), wbState(B)]);
      return sa !== null && sb !== null && sa.players.length === 2 && sb.players.length === 2 ? { sa, sb } : null;
    },
    12000,
    'players.length === 2 on both pages',
  );
  check(
    '(1) A createPrivate -> code; B joinPrivate -> both pages see 2 players',
    seated2.sa.players.map((p) => p.name).join(',') === 'Alice,Bob' &&
      seated2.sb.players.map((p) => p.name).join(',') === 'Alice,Bob',
    `A sees [${seated2.sa.players.map((p) => p.name)}] B sees [${seated2.sb.players.map((p) => p.name)}]`,
  );
  await shot(A, 'wordbomb-lobby.png');

  // -- the seated lobby must NOT start itself (universal manual-start contract) --
  const lobbyRound = seated2.sa.round;
  await sleep(LOBBY_HOLD_MS);
  const [heldA, heldB] = await Promise.all([wbState(A), wbState(B)]);
  check(
    'lobby does not auto-start (held 6s at MIN_PLAYERS with canStart true)',
    heldA !== null &&
      heldA.phase === 'lobby' &&
      heldA.round === lobbyRound &&
      heldA.canStart === true &&
      heldA.countdownEndsAt === 0 &&
      heldA.seated >= WB_MIN_PLAYERS &&
      heldB !== null &&
      heldB.phase === 'lobby' &&
      heldB.countdownEndsAt === 0,
    `A phase=${heldA?.phase} round=${heldA?.round} canStart=${heldA?.canStart} ` +
      `countdownEndsAt=${heldA?.countdownEndsAt} seated=${heldA?.seated}/${heldA?.minPlayers} · B phase=${heldB?.phase}`,
  );

  // ==========================================================================
  // MATCH 1 — the numbered scenarios
  // ==========================================================================
  await pressStart(A, 'A presses START');
  const counting = await waitFor(
    async () => {
      const s = await wbState(A);
      return s !== null && (s.countdownEndsAt !== 0 || s.phase === 'live') ? s : null;
    },
    8000,
    'the post-press LOBBY_COUNTDOWN beat',
  );
  check(
    `manual start: {t:'wb_start'} opens the ${WB_LOBBY_COUNTDOWN_MS}ms countdown beat`,
    counting.countdownEndsAt !== 0 || counting.phase === 'live',
    `phase=${counting.phase} countdownEndsAt=${counting.countdownEndsAt !== 0 ? 'set' : '0'}`,
  );

  const books = newMatchBooks(['Alice', 'Bob', 'Carol']);
  let carolSeated = false;
  let a11 = null;
  let a11Attempts = 0;
  let rosterOrder = ['Alice', 'Bob'];
  let lastRound = 0;

  for (;;) {
    const live = await waitForLiveRound(A, lastRound, ROUND_TIMEOUT_MS + WB_LOBBY_COUNTDOWN_MS);
    if (live === null) break;
    const { round, fragment } = live;
    lastRound = round;
    books.fragments.push(fragment);
    books.drawn.add(fragment);
    console.log(`\n-- round ${round}/${ROUNDS}  fragment "${fragment}" --`);

    // -- (2) both pages read the SAME fragment while live ---------------------
    if (round === 1) {
      const same = await waitFor(
        async () => {
          const [sa, sb] = await Promise.all([wbState(A), wbState(B)]);
          return sa !== null && sb !== null && sa.phase === 'live' && sb.phase === 'live' && sb.fragment !== null
            ? { sa, sb }
            : null;
        },
        10000,
        'both pages live with a fragment',
      );
      check(
        "(2) at phase === 'live' both pages read the SAME fragment",
        same.sa.fragment === same.sb.fragment && same.sa.fragment === fragment && same.sa.round === same.sb.round,
        `A="${same.sa.fragment}" B="${same.sb.fragment}" round A=${same.sa.round} B=${same.sb.round}`,
      );
    }

    // -- (9) already_used probe: fires the first round a used word covers the
    //        new fragment. Validation puts already_used LAST, so the reused word
    //        must also contain THIS round's fragment — which is exactly the hit
    //        condition. Probe FIRST: a reject never clears a locked word (I3),
    //        but an accepted word clears lastReject().
    if (!A9.fired && round >= 2) {
      const order = [['Alice', A], ['Bob', B], ['Carol', C]];
      for (const [name, page] of order) {
        if (name === 'Carol' && !carolSeated) continue;
        const hit = [...(books.used.get(name) ?? [])].find((w) => w.includes(fragment));
        if (hit === undefined) continue;
        A9.attempts++;
        const r = await submitExpectingReject(page, hit);
        A9.detail =
          `${name} re-submitted "${hit}" (scored earlier this match) in round ${round} ` +
          `on fragment "${fragment}" -> wb_reject "${r.reason}" (lastReject "${r.lastReject}")`;
        if (r.reason === 'already_used' && r.lastReject === 'already_used') {
          A9.fired = true;
          check('(9) a word already SCORED this match is rejected with already_used', true, A9.detail);
        } else {
          // Not a pass and not yet a failure: keep probing later rounds and let
          // the end-of-run gate decide, with this reason recorded.
          console.log(`   note  assertion 9 probe returned "${r.reason}" — ${A9.detail}`);
        }
        await sleep(SUBMIT_GAP_MS);
        break;
      }
    }

    // -- pick this round's scoring words -------------------------------------
    const notUsed = (name) => (w) => !(books.used.get(name) ?? new Set()).has(w);

    if (round === 1) {
      // ---- (3) I1 mirror + (4) last valid wins + (5) missing_fragment -------
      const bLogMark = await wbLogLen(B);
      await sleep(900); // let a couple of live wb_public frames land in B's log
      const baseline = await B.evaluate(
        (from) => JSON.stringify(window.__wordbomb.messageLog().slice(from)).toLowerCase(),
        bLogMark,
      );

      // W1 must be long and DISTINCTIVE: none of its 3+ char substrings (other
      // than the public fragment, which every legal word must contain) may occur
      // anywhere in B's baseline stream — otherwise the assertion would fail on
      // JSON scaffolding rather than on a leak.
      const benign = `${baseline} ${PROTOCOL_VOCAB} ${(code ?? '').toLowerCase()}`;
      const clean = (w) => substrings3plus(w).every((s) => s === fragment || !benign.includes(s));
      const cands = candidatesFor(fragment);
      const maxLen = cands.reduce((m, w) => Math.max(m, w.length), 0);

      const w2 = bestCoverageWord(fragment, books.coveredUnion, books.drawn, (w) => w.length >= Math.min(11, maxLen));
      const w2len = w2 === null ? maxLen : w2.length;
      let w1 = null;
      for (const min of [9, 8, 7, 6, 5]) {
        const pick = cands
          .filter((w) => w.length >= min && w.length < w2len && w !== w2 && clean(w))
          .sort((x, y) => y.length - x.length || (x < y ? -1 : 1))[0];
        if (pick !== undefined) {
          w1 = pick;
          break;
        }
      }
      if (w1 === null) {
        // Last resort: the longest candidate short of W2. The assertion still
        // runs at full strength; it is simply likelier to trip on scaffolding.
        w1 = cands.filter((w) => w.length >= 5 && w.length < w2len && w !== w2).sort((x, y) => y.length - x.length)[0] ?? null;
        console.log(`   note  no scaffolding-clean W1 for "${fragment}" — falling back to "${w1}"`);
      }
      if (w1 === null || w2 === null) throw new Error(`no W1/W2 pair for fragment "${fragment}" (W1=${w1} W2=${w2})`);
      console.log(`   (3/4) W1="${w1}" (${w1.length}L) -> W2="${w2}" (${w2.length}L)`);

      await wbSubmit(A, w1);
      const lockedSeen = await waitFor(
        async () => {
          const s = await wbState(B);
          const alice = rowOf(s, 'Alice');
          return alice !== null && alice.locked === true ? s : null;
        },
        8000,
        "B sees Alice.locked === true",
      );
      check(
        "(3a) A submits a valid word -> B sees A.locked === true in players[]",
        true,
        `W1="${w1}" (${w1.length} letters); B's Alice row locked=${rowOf(lockedSeen, 'Alice').locked}`,
      );

      // (4) re-lock a LONGER valid word: the last valid word must be the one
      // that scores at the boom (I3).
      await sleep(SUBMIT_GAP_MS);
      await wbSubmit(A, w2);
      await waitFor(
        async () => {
          const s = await wbState(A);
          return s !== null && s.yourWord === w2 ? s : null;
        },
        8000,
        `A holds the re-locked word "${w2}"`,
      );

      // B locks a word that shares NO 3+ char substring with W1 — B's own
      // yourWord is legitimately in B's own stream, and a shared trigram there
      // would be a self-inflicted false positive, not a leak.
      const bWord = bestCoverageWord(
        fragment,
        books.coveredUnion,
        books.drawn,
        (w) => w !== w1 && w !== w2 && !sharesBeyondFragment(w1, w, fragment) && notUsed('Bob')(w),
      );
      if (bWord === null) throw new Error(`no B word disjoint from W1 for fragment "${fragment}"`);
      await wbSubmit(B, bWord);
      await waitFor(
        async () => {
          const s = await wbState(B);
          return s !== null && s.yourWord === bWord ? s : null;
        },
        8000,
        `B holds "${bWord}"`,
      );

      // (5) a real dictionary word that does NOT contain the fragment ->
      // missing_fragment, delivered to A ONLY. Done LAST in the round: an
      // accepted submission clears lastReject().
      const bad = WORDS.find((w) => w.length >= 6 && w.length <= 12 && !w.includes(fragment));
      await sleep(SUBMIT_GAP_MS);
      const bRejectsBefore = (await wbRejectFrames(B)).length;
      const r5 = await submitExpectingReject(A, bad);
      const bRejectsAfter = (await wbRejectFrames(B)).length;
      check(
        "(5) a real word missing the fragment -> 'missing_fragment', delivered to A ONLY",
        r5.reason === 'missing_fragment' &&
          r5.lastReject === 'missing_fragment' &&
          bRejectsBefore === 0 &&
          bRejectsAfter === 0,
        `A.lastReject()=${r5.lastReject} frame=${r5.reason} ("${bad}" is in the dictionary and lacks "${fragment}"); ` +
          `wb_reject frames in B's whole log: ${bRejectsBefore} -> ${bRejectsAfter}`,
      );
      // the rejected word must NOT have displaced the locked one (I3)
      const aHold = await wbState(A);
      check(
        '(4a) a rejected submission never clears the locked word (I3)',
        aHold !== null && aHold.yourWord === w2,
        `A.yourWord="${aHold?.yourWord}" (expected "${w2}")`,
      );

      await shot(A, 'wordbomb-live.png');

      // stash for the post-boom checks
      books.round1 = { w1, w2, bWord, bLogMark };
    } else if (round === 2) {
      // ---- (8) both submit the SAME word -> each scores the split value -----
      const shared = bestCoverageWord(
        fragment,
        books.coveredUnion,
        books.drawn,
        (w) => notUsed('Alice')(w) && notUsed('Bob')(w),
      );
      if (shared === null) throw new Error(`no shared word for fragment "${fragment}"`);
      await Promise.all([wbSubmit(A, shared), wbSubmit(B, shared)]);
      await waitFor(
        async () => {
          const [sa, sb] = await Promise.all([wbState(A), wbState(B)]);
          return sa !== null && sb !== null && sa.yourWord === shared && sb.yourWord === shared ? true : null;
        },
        8000,
        'A and B both hold the shared word',
      );
      books.round2 = { shared };
      console.log(`   both locked "${shared}" (assertion 8)`);
    } else {
      // ---- steady state: every seated player locks a coverage word ----------
      const aWord = bestCoverageWord(fragment, books.coveredUnion, books.drawn, notUsed('Alice'));
      const bWord = bestCoverageWord(fragment, books.coveredUnion, books.drawn, (w) => w !== aWord && notUsed('Bob')(w));
      const taken = new Set([aWord, bWord]);
      const cWord = carolSeated
        ? bestCoverageWord(fragment, books.coveredUnion, books.drawn, (w) => !taken.has(w) && notUsed('Carol')(w))
        : null;
      const jobs = [];
      if (aWord !== null) jobs.push(wbSubmit(A, aWord));
      if (bWord !== null) jobs.push(wbSubmit(B, bWord));
      if (cWord !== null) jobs.push(wbSubmit(C, cWord));
      await Promise.all(jobs);
      console.log(`   locked A="${aWord}" B="${bWord}"${cWord !== null ? ` C="${cWord}"` : ''}`);

      // ---- (11) reload B mid-round: score + yourWord restored, no ghost -----
      if (a11 === null && carolSeated && bWord !== null && a11Attempts < 3) {
        a11Attempts++;
        a11 = await reloadScenario(A, B, code, round, bWord, a11Attempts);
      }
    }

    // -- boom: (6) deep-equal answers on every page, (7) independent scoring ---
    const boomA = await waitForBoom(A, round);
    const boomB = await waitForBoom(B, round);
    const answers = boomA.boom.answers;
    A6.rounds++;
    const equalAB = deepEqual(answers, boomB.boom.answers) && boomA.boom.fragment === boomB.boom.fragment;
    let equalC = true;
    if (carolSeated) {
      const boomC = await waitForBoom(C, round);
      equalC = deepEqual(answers, boomC.boom.answers) && boomA.boom.fragment === boomC.boom.fragment;
    }
    if (!(equalAB && equalC)) {
      A6.bad.push(`round ${round}: A=${JSON.stringify(answers)} B=${JSON.stringify(boomB.boom.answers)}`);
    }

    // independent scoring, every answer, every round
    const counts = new Map();
    for (const a of answers) if (a.word !== null) counts.set(a.word, (counts.get(a.word) ?? 0) + 1);
    for (const a of answers) {
      const wantDupes = a.word === null ? 0 : (counts.get(a.word) ?? 1);
      const wantPoints = a.word === null ? 0 : expectedPoints(a.word, wantDupes);
      if (a.dupes !== wantDupes || a.points !== wantPoints) {
        A7.bad.push(
          `round ${round} ${a.name} "${a.word}" -> dupes=${a.dupes}/want ${wantDupes}, points=${a.points}/want ${wantPoints}`,
        );
      }
    }
    A7.rounds++;

    console.log(
      `   boom: ${answers.map((a) => `${a.name}:${a.word ?? '—'}(${a.points})`).join('  ')}`,
    );

    // -- (4) last valid wins, checked on the round-1 boom ---------------------
    if (round === 1) {
      const alice = answers.find((a) => a.name === 'Alice');
      check(
        '(4) A re-locks a longer valid word -> the LAST valid word is the one that scored',
        alice !== undefined && alice.word === books.round1.w2,
        `scored "${alice?.word}" (W1="${books.round1.w1}" ${books.round1.w1.length}L -> W2="${books.round1.w2}" ${books.round1.w2.length}L)`,
      );

      // -- (3) the browser-side I1 mirror, over B's WHOLE stream from round
      //        start up to (but not including) the wb_boom.
      const win = await B.evaluate((from) => {
        const log = window.__wordbomb.messageLog();
        let boomIdx = -1;
        for (let i = from; i < log.length; i++) {
          const m = log[i];
          if (m !== null && typeof m === 'object' && m.t === 'event' && m.ev && m.ev.t === 'wb_boom') {
            boomIdx = i;
            break;
          }
        }
        return {
          boomIdx,
          frames: (boomIdx === -1 ? log.length : boomIdx) - from,
          json: JSON.stringify(log.slice(from, boomIdx === -1 ? log.length : boomIdx)).toLowerCase(),
        };
      }, books.round1.bLogMark);
      // The round's fragment is the one 3-char substring of W that is PUBLIC by
      // design (§5 step 3 forces W to contain it, and WbPublicState.fragment
      // broadcasts it), so it is excluded — exactly as the mandated server-side
      // I1 test does. Every other substring of length >= 3 must be absent.
      const needles = substrings3plus(books.round1.w1).filter((s) => s !== fragment);
      const leaked = needles.filter((n) => win.json.includes(n));
      check(
        "(3) B's full message log up to the boom contains NO 3+ char substring of A's word",
        win.boomIdx !== -1 && win.frames > 0 && needles.length >= 10 && leaked.length === 0,
        `W1="${books.round1.w1}", ${needles.length} needles over ${win.frames} frames; leaked=[${leaked.slice(0, 5)}]`,
      );
    }

    // -- (8) the split value, checked on the round-2 boom ----------------------
    if (round === 2 && books.round2 !== undefined) {
      const w = books.round2.shared;
      const want = expectedPoints(w, 2);
      const rows = answers.filter((a) => a.name === 'Alice' || a.name === 'Bob');
      check(
        '(8) A and B submit the SAME word -> each scores the split value (dupes === 2)',
        rows.length === 2 && rows.every((a) => a.word === w && a.dupes === 2 && a.points === want),
        `"${w}" (${w.length}L) -> ${rows.map((a) => `${a.name}:${a.points}/dupes ${a.dupes}`).join(' ')} (independent: ${want})`,
      );
    }

    foldBoom(books, answers);

    // Carol takes her seat during round 2's reveal so she is eligible from
    // round 3 — the seat that makes assertion 11's reload survivable.
    if (!carolSeated && round === 2) {
      await wbJoin(C, 'Carol', code);
      const three = await waitFor(
        async () => {
          const [sa, sc] = await Promise.all([wbState(A), wbState(C)]);
          return sa !== null && sc !== null && sa.players.length === 3 && sc.players.length === 3 ? { sa, sc } : null;
        },
        12000,
        'Carol seated (3 players on A and C)',
      );
      carolSeated = true;
      rosterOrder = three.sa.players.map((p) => p.name);
      console.log(`   Carol seated — roster [${rosterOrder}]`);
    }

    if (round === 3) await shot(A, 'wordbomb-reveal.png');
  }

  // ==========================================================================
  // end of match 1
  // ==========================================================================
  const ended = await waitFor(
    async () => {
      const s = await wbState(A);
      return s !== null && s.phase === 'matchEnd' ? s : null;
    },
    ROUND_TIMEOUT_MS,
    "phase 'matchEnd'",
  );
  rosterOrder = ended.players.map((p) => p.name);
  await shot(A, 'wordbomb-matchend.png');

  // -- (10) 10 distinct fragments across 10 rounds ---------------------------
  const first10 = books.fragments.slice(0, 10);
  check(
    '(10) 10 distinct fragments across the first 10 rounds',
    first10.length === 10 && new Set(first10).size === 10,
    `${first10.length} rounds, ${new Set(first10).size} distinct: [${first10}] (match total ${books.fragments.length}, distinct ${new Set(books.fragments).size})`,
  );

  // -- (6) / (7) aggregate --------------------------------------------------
  check(
    '(6) at every boom every page receives a DEEP-EQUAL answers array (I7)',
    A6.rounds > 0 && A6.bad.length === 0,
    A6.bad.length === 0 ? `${A6.rounds} booms deep-equal on every page` : A6.bad.slice(0, 2).join(' | '),
  );
  check(
    '(7) points equal max(L, floor(12L/dupes^1.5)) computed independently, for every answer',
    A7.rounds > 0 && A7.bad.length === 0,
    A7.bad.length === 0 ? `${A7.rounds} rounds verified` : A7.bad.slice(0, 3).join(' | '),
  );

  // -- (11) --------------------------------------------------------------------
  check(
    '(11) reload B mid-round -> score and yourWord restored, players.length unchanged on A',
    a11 !== null && a11.ok,
    a11 === null ? 'the reload scenario never ran' : a11.detail,
  );

  // -- (12) wb_match_end -------------------------------------------------------
  const matchEnd = await waitFor(
    async () =>
      A.evaluate(() => {
        const log = window.__wordbomb.messageLog();
        for (let i = log.length - 1; i >= 0; i--) {
          const m = log[i];
          if (m !== null && typeof m === 'object' && m.t === 'event' && m.ev && m.ev.t === 'wb_match_end') return m.ev;
        }
        return null;
      }),
    15000,
    'wb_match_end on A',
  );
  const joinIndex = new Map(rosterOrder.map((n, i) => [n, i]));
  const st = matchEnd.standings;
  let sortOk = st.length > 0;
  const sortBad = [];
  for (let i = 1; i < st.length; i++) {
    const prev = st[i - 1];
    const cur = st[i];
    if (prev.score < cur.score) {
      sortOk = false;
      sortBad.push(`${prev.name}(${prev.score}) before ${cur.name}(${cur.score})`);
    } else if (prev.score === cur.score) {
      const pi = joinIndex.get(prev.name) ?? -1;
      const ci = joinIndex.get(cur.name) ?? -1;
      if (!(pi < ci)) {
        sortOk = false;
        sortBad.push(`tie ${prev.name}/${cur.name} out of join order (${pi} vs ${ci})`);
      }
    }
  }
  const sumBad = st.filter((s) => (books.points.get(s.name) ?? -1) !== s.score);
  check(
    '(12) wb_match_end standings sorted score DESC / join order ASC, and each final score is the sum of that player\'s wb_boom points',
    sortOk && sumBad.length === 0 && matchEnd.winnerId === (st[0]?.playerId ?? null),
    `standings [${st.map((s) => `${s.name}:${s.score}`)}] roster [${rosterOrder}] ` +
      `harness sums [${[...books.points].map(([n, p]) => `${n}:${p}`)}]` +
      (sortBad.length > 0 ? ` sortIssues: ${sortBad}` : '') +
      (sumBad.length > 0 ? ` sumIssues: ${sumBad.map((s) => `${s.name} ${s.score}!=${books.points.get(s.name)}`)}` : ''),
  );

  // ==========================================================================
  // assertion 9 safety-net match (only if the probe never fired: measured
  // P(miss) ~= 0.33% for one 20-round easy match at three seats)
  // ==========================================================================
  if (!A9.fired) {
    console.log('\nassertion 9 did not fire in match 1 — playing one safety-net match');
    await runProbeMatch(A, B, C, ROUNDS);
    if (!A9.fired) {
      check(
        '(9) a word already SCORED this match is rejected with already_used',
        false,
        `no used word ever covered a later fragment across two ${ROUNDS}-round easy matches ` +
          `(${A9.attempts} probes fired). already_used is validated AFTER missing_fragment ` +
          '(room.ts:593-599), so the collision cannot be forced through the §4.3 surface — only made likely.',
      );
    }
  }

  // -- (13) --------------------------------------------------------------------
  check('(13) zero console/page errors on every page throughout', pageErrors.length === 0, `${pageErrors.length}`);
}

/**
 * (11) The reload. B is holding `word` in round `round`; reload the page, rejoin
 * with the client's stored resume record and prove I8: the SAME entry comes
 * back with its score and its locked word, and A sees no ghost duplicate.
 */
async function reloadScenario(A, B, code, round, word, attempt) {
  // the lock must have landed before the reload, or there is nothing to restore
  try {
    await waitFor(async () => ((await wbState(B))?.yourWord === word ? true : null), 5000, 'B holds its word');
  } catch {
    return null; // try again next round
  }
  const before = await wbState(B);
  const beforeRow = rowOf(before, 'Bob');
  if (before === null || beforeRow === null) return null;
  const score = beforeRow.score;
  const aCountBefore = (await wbState(A))?.players.length ?? -1;
  if (score <= 0) return null; // no teeth yet — B has not banked a round; retry later

  console.log(`   (11) reloading B mid-round ${round} holding "${word}" at score ${score} (attempt ${attempt})`);
  await B.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(() => B.evaluate(() => !!window.__wordbomb), 15000, '__wordbomb on B after reload');
  // send() is a silent no-op on a closed socket, so the rejoin must wait for the
  // fresh welcome frame or it would vanish and the page would sit on the menu.
  await waitFor(
    () =>
      B.evaluate(() =>
        window.__wordbomb.messageLog().some((m) => m !== null && typeof m === 'object' && m.t === 'welcome'),
      ),
    15000,
    'B welcomed again after reload',
  );
  await wbJoin(B, 'Bob', code);
  let back;
  try {
    back = await waitFor(
      async () => {
        const s = await wbState(B);
        if (s === null || s.you === null) return null;
        const me = s.players.find((p) => p.id === s.you);
        return me !== undefined && me.name === 'Bob' ? s : null;
      },
      15000,
      'B back at the table after reload',
    );
  } catch (err) {
    return { ok: false, detail: `B never got back to the table after reload: ${err.message}` };
  }
  const after = await wbState(A);
  const bobs = back.players.filter((p) => p.name === 'Bob');
  const sameRound = back.round === round && (back.phase === 'live' || back.phase === 'reveal');
  if (!sameRound && attempt < 3) {
    console.log(`   (11) the round turned over during the reload (now ${back.round}/${back.phase}) — retrying`);
    return null;
  }
  const ok =
    sameRound &&
    bobs.length === 1 &&
    bobs[0].score === score &&
    back.yourWord === word &&
    after !== null &&
    after.players.length === aCountBefore &&
    after.players.filter((p) => p.name === 'Bob').length === 1;
  return {
    ok,
    detail:
      `reloaded mid-round ${round} (back in ${back.round}/${back.phase}); score ${score} -> ${bobs[0]?.score}; ` +
      `yourWord "${word}" -> "${back.yourWord}"; A.players ${aCountBefore} -> ${after?.players.length}; Bobs=${bobs.length}`,
  };
}

/**
 * A plain match played only to fire assertion 9: every seated player locks the
 * word that maximises new easy-pool coverage, and each round from 2 on the
 * used-sets are probed against the new fragment. Returns as soon as it fires.
 */
async function runProbeMatch(A, B, C, rounds) {
  await waitFor(
    async () => {
      const s = await wbState(A);
      return s !== null && s.phase === 'lobby' && s.canStart === true ? s : null;
    },
    30000,
    'the room back in a startable lobby',
  );
  await pressStart(A, 'A presses START (safety-net match)');
  const books = newMatchBooks(['Alice', 'Bob', 'Carol']);
  let lastRound = 0;
  for (;;) {
    const live = await waitForLiveRound(A, lastRound, ROUND_TIMEOUT_MS + WB_LOBBY_COUNTDOWN_MS);
    if (live === null) return;
    const { round, fragment } = live;
    lastRound = round;
    books.drawn.add(fragment);
    console.log(`\n-- [safety net] round ${round}/${rounds}  fragment "${fragment}" --`);

    if (round >= 2) {
      for (const [name, page] of [['Alice', A], ['Bob', B], ['Carol', C]]) {
        const hit = [...(books.used.get(name) ?? [])].find((w) => w.includes(fragment));
        if (hit === undefined) continue;
        A9.attempts++;
        const r = await submitExpectingReject(page, hit);
        A9.detail =
          `${name} re-submitted "${hit}" (scored earlier this match) in round ${round} ` +
          `on fragment "${fragment}" -> wb_reject "${r.reason}" (lastReject "${r.lastReject}")`;
        if (r.reason === 'already_used' && r.lastReject === 'already_used') {
          A9.fired = true;
          check('(9) a word already SCORED this match is rejected with already_used', true, A9.detail);
          return;
        }
        console.log(`   note  [safety net] assertion 9 probe returned "${r.reason}" — ${A9.detail}`);
        await sleep(SUBMIT_GAP_MS);
        break;
      }
    }

    const notUsed = (name) => (w) => !(books.used.get(name) ?? new Set()).has(w);
    const aWord = bestCoverageWord(fragment, books.coveredUnion, books.drawn, notUsed('Alice'));
    const bWord = bestCoverageWord(fragment, books.coveredUnion, books.drawn, (w) => w !== aWord && notUsed('Bob')(w));
    const taken = new Set([aWord, bWord]);
    const cWord = bestCoverageWord(fragment, books.coveredUnion, books.drawn, (w) => !taken.has(w) && notUsed('Carol')(w));
    const jobs = [];
    if (aWord !== null) jobs.push(wbSubmit(A, aWord));
    if (bWord !== null) jobs.push(wbSubmit(B, bWord));
    if (cWord !== null) jobs.push(wbSubmit(C, cWord));
    await Promise.all(jobs);

    const boom = await waitForBoom(A, round);
    foldBoom(books, boom.boom.answers);
  }
}

// ---- runner ---------------------------------------------------------------------------
const T0 = Date.now();
let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error(`\nE2E-WORDBOMB ABORTED: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  check('e2e-wordbomb completed without abort', false);
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  if (serverChild && serverChild.exitCode === null) {
    serverChild.kill('SIGTERM');
    await sleep(400);
    if (serverChild.exitCode === null) serverChild.kill('SIGKILL');
  }

  console.log('\n================ E2E-WORDBOMB SUMMARY ================');
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
  console.log(`runtime: ${((Date.now() - T0) / 1000).toFixed(1)}s`);
  console.log(
    exitCode === 0
      ? '\nE2E-WORDBOMB GREEN'
      : `\nE2E-WORDBOMB RED (${failed} failed assertions, ${pageErrors.length} page errors)`,
  );
  process.exit(exitCode);
}

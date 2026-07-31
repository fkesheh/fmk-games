// ============================================================================
// WORDBOMB room tests (W8) — written against docs/WORDBOMB.md + the frozen
// TypeScript in @wordbomb/shared and ./ports.ts, NOT against room.ts.
//
// The room is driven directly through the platform `GameRoomHandle` surface
// behind:
//   - a recording `RoomIO` that captures every (recipientId, msg) pair,
//   - a ~35-word STUB `Dict` that also COUNTS lookups (the 2.6 MB blob is
//     never loaded here — §5 step 0 is proved by counting probes),
//   - a scripted `FragmentPicker` (the room owns the per-match `used` set,
//     ports.ts, so the picker is a pure script),
//   - a seeded `rand`, so the HIDDEN fuse is deterministic: `rngInt` over
//     [FUSE_MIN_MS, FUSE_MAX_MS] means rand()===0 pins the fuse to the minimum.
//
// Phase transitions are advanced with `vi.advanceTimersToNextTimer()` rather
// than hardcoded millisecond counts, so the tests assert the CONTRACT's phase
// ORDER without encoding the room's private timer arithmetic.
//
// KNOWN CONTRACT DEFECT, worked around here and reported: §8.1 assertion 1 says
// B's message log must contain "neither W nor any 3+ character substring of W".
// Validation step §5.3 requires W to CONTAIN the round's 3-letter fragment, and
// that fragment is broadcast in `WbPublicState.fragment` by design. So the
// fragment is ALWAYS a 3-char substring of W that is ALWAYS present — the
// assertion as literally written is unsatisfiable for every legal W. The only
// coherent reading is "every 3+ char substring EXCEPT the public fragment", and
// that is what is asserted below.
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  FUSE_MAX_MS,
  FUSE_MIN_MS,
  LOBBY_COUNTDOWN_MS,
  MATCH_END_MS,
  MAX_PLAYERS,
  MAX_SUBMITS_PER_ROUND,
  MAX_SUBMIT_LEN,
  MAX_WORD_LEN,
  MIN_PLAYERS,
  revealMsFor,
  SUBMIT_COOLDOWN_MS,
  SUBMIT_GRACE_MS,
  scoreWord,
} from '@wordbomb/shared';
import type {
  WbAnswer,
  WbDifficulty,
  WbEvent,
  WbPhase,
  WbPlayerState,
  WbPrivate,
  WbPublicState,
  WbRejectReason,
  WordbombSettings,
} from '@wordbomb/shared';
import type { GameRoomHandle, PlayerId, RoomIO, Visibility } from '@platform/shared';
import type { Dict, FragmentPicker, RoomDeps } from './ports.js';
import { WordbombRoom } from './room.js';

// ---- wire shapes -------------------------------------------------------------

type EventEnvelope = { t: 'event'; ev: WbEvent };
type ErrorMsg = { t: 'error'; code: string; message: string };
type WbMsg = WbPublicState | WbPrivate | EventEnvelope | ErrorMsg;

const EPOCH = 1_700_000_000_000; // fixed fake-clock origin: full determinism

function isWbMsg(msg: unknown): msg is WbMsg {
  if (typeof msg !== 'object' || msg === null) return false;
  const t = (msg as { t?: unknown }).t;
  if (t === 'wb_public' || t === 'wb_private' || t === 'error') return true;
  if (t !== 'event') return false;
  const ev = (msg as { ev?: unknown }).ev;
  return typeof ev === 'object' && ev !== null && typeof (ev as { t?: unknown }).t === 'string';
}

/**
 * Records every (recipientId, msg) pair. `structuredClone` is mandatory: the
 * room sends ONE shared object to every recipient for broadcasts, so the log
 * would otherwise alias live state.
 */
class FakeIO implements RoomIO {
  private readonly log = new Map<PlayerId, WbMsg[]>();

  send(id: PlayerId, msg: unknown): void {
    if (!isWbMsg(msg)) throw new Error(`unexpected message for ${id}: ${JSON.stringify(msg)}`);
    const msgs = this.log.get(id) ?? [];
    msgs.push(structuredClone(msg));
    this.log.set(id, msgs);
  }

  rttMs(): number {
    return 0;
  }

  all(id: PlayerId): WbMsg[] {
    return this.log.get(id) ?? [];
  }

  /** Total messages sent to anyone — used to prove a dead room emits nothing. */
  totalSent(): number {
    let n = 0;
    for (const msgs of this.log.values()) n += msgs.length;
    return n;
  }

  clear(): void {
    this.log.clear();
  }

  /** Latest broadcast snapshot this player received. */
  pub(id: PlayerId): WbPublicState {
    const msgs = this.all(id);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m !== undefined && m.t === 'wb_public') return m;
    }
    throw new Error(`no wb_public captured for ${id}`);
  }

  /** Latest unicast snapshot this player received. */
  priv(id: PlayerId): WbPrivate {
    const msgs = this.all(id);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m !== undefined && m.t === 'wb_private') return m;
    }
    throw new Error(`no wb_private captured for ${id}`);
  }

  events<T extends WbEvent['t']>(id: PlayerId, t: T): Array<Extract<WbEvent, { t: T }>> {
    return this.all(id)
      .filter((m): m is EventEnvelope => m.t === 'event')
      .map((m) => m.ev)
      .filter((ev): ev is Extract<WbEvent, { t: T }> => ev.t === t);
  }

  rejects(id: PlayerId): WbRejectReason[] {
    return this.events(id, 'wb_reject').map((ev) => ev.reason);
  }
}

// ---- stub dictionary (counts probes; §5 step 0 is proved by this counter) ----

/**
 * ~35 words. Deliberately NOT the real blob: `room.test.ts` must be able to
 * pin exactly which strings are words, and loading 2.6 MB to hope the right
 * fragment comes up is what `RoomDeps` exists to avoid (ports.ts).
 */
const STUB_WORDS = [
  'ion',
  'lion',
  'lions',
  'onion',
  'onions',
  'union',
  'unions',
  'unite',
  'nation',
  'nations',
  'national',
  'motion',
  'motions',
  'action',
  'actions',
  'ration',
  'rations',
  'station',
  'stations',
  'position',
  'positions',
  'inspirations',
  'opinion',
  'vision',
  'visions',
  'visual',
  'nature',
  'natural',
  'donate',
  'fusion',
  'region',
  'tension',
  'zebra',
  'planet',
  'cat',
] as const;

class StubDict implements Dict {
  /** How many times `has()` was called. §5 step 0 must not cost a probe. */
  calls = 0;
  private readonly words: ReadonlySet<string>;

  constructor(words: readonly string[] = STUB_WORDS) {
    this.words = new Set(words);
  }

  has(word: string): boolean {
    this.calls++;
    return this.words.has(word);
  }

  get size(): number {
    return this.words.size;
  }
}

// ---- scripted picker ---------------------------------------------------------

/** Enough distinct 3-letter fragments that no test can exhaust the script. */
const DEFAULT_FRAGMENTS = [
  'ion',
  'tio',
  'nat',
  'uni',
  'vis',
  'ati',
  'sio',
  'gio',
  'ten',
  'act',
  'pos',
  'reg',
  'ral',
  'ona',
  'ann',
  'lan',
  'zeb',
  'pla',
  'don',
  'fus',
  'opi',
  'sta',
  'mot',
  'rat',
] as const;

class ScriptedPicker implements FragmentPicker {
  /** The `used` set the room passed in, per call — proves the room accumulates it. */
  readonly usedSeen: string[][] = [];
  private readonly script: readonly string[];

  constructor(script: readonly string[] = DEFAULT_FRAGMENTS) {
    this.script = script;
  }

  pick(_difficulty: WbDifficulty, used: ReadonlySet<string>, _rand: () => number): string {
    this.usedSeen.push([...used]);
    for (const f of this.script) if (!used.has(f)) return f;
    // Never reached in these tests: the script is longer than any match here.
    // The contract forbids `pick` throwing, so fall back to a fresh fragment.
    return `x${(this.usedSeen.length % 100).toString().padStart(2, '0')}`;
  }

  poolSize(_difficulty: WbDifficulty): number {
    return this.script.length;
  }
}

// ---- drive helpers -----------------------------------------------------------

const tracked: GameRoomHandle[] = [];

interface BootOpts {
  visibility?: Visibility;
  settings?: WordbombSettings;
  dict?: StubDict;
  picker?: ScriptedPicker;
  rand?: () => number;
}

interface Harness {
  room: WordbombRoom;
  io: FakeIO;
  dict: StubDict;
  picker: ScriptedPicker;
}

/** Build a room and seat `players` (join order = array order). */
function boot(players: ReadonlyArray<readonly [PlayerId, string]>, opts: BootOpts = {}): Harness {
  const io = new FakeIO();
  const dict = opts.dict ?? new StubDict();
  const picker = opts.picker ?? new ScriptedPicker();
  const deps: RoomDeps = { dict, picker, rand: opts.rand ?? (() => 0) };
  const room = new WordbombRoom(
    opts.visibility ?? 'public',
    io,
    opts.settings ?? { ...DEFAULT_SETTINGS },
    deps,
  );
  room.start(); // idempotent per the platform contract
  for (const [id, name] of players) room.addPlayer(id, name);
  room.start(); // covers either start/add ordering
  tracked.push(room);
  return { room, io, dict, picker };
}

/** Fire exactly the next scheduled phase transition (the room keeps one). */
function advance(): void {
  vi.advanceTimersToNextTimer();
}

function submit(room: GameRoomHandle, id: PlayerId, word: string): void {
  room.handleMessage(id, { t: 'wb_submit', word });
}

/** Space two submissions by the same player so §5 step 0 does not fire. */
function cooldown(): void {
  vi.advanceTimersByTime(SUBMIT_COOLDOWN_MS);
}

function playerOf(st: WbPublicState, id: PlayerId): WbPlayerState {
  const p = st.players.find((pl) => pl.id === id);
  if (p === undefined) throw new Error(`no player ${id} in state`);
  return p;
}

function lastBoom(io: FakeIO, id: PlayerId): Extract<WbEvent, { t: 'wb_boom' }> {
  const evs = io.events(id, 'wb_boom');
  const ev = evs[evs.length - 1];
  if (ev === undefined) throw new Error(`no wb_boom captured for ${id}`);
  return ev;
}

function answerOf(boom: { answers: WbAnswer[] }, id: PlayerId): WbAnswer {
  const a = boom.answers.find((x) => x.playerId === id);
  if (a === undefined) throw new Error(`no answer row for ${id}`);
  return a;
}

/** live -> the bomb goes off -> the grace closes and `wb_boom` is broadcast. */
function toBoom(): void {
  advance(); // fuse expiry: the visible explosion (phase -> reveal)
  advance(); // SUBMIT_GRACE_MS later: scoring closes, wb_boom
}

/** reveal window over -> next round (or matchEnd). */
function afterReveal(): void {
  advance();
}

// ---- lifecycle ---------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(EPOCH);
});

afterEach(() => {
  while (tracked.length > 0) tracked.pop()?.stop();
  vi.useRealTimers();
});

// =============================================================================
// §8.1 — THE I1 ASSERTION. The most important test in the game.
// =============================================================================

interface LeakRun {
  fragment: string;
  /** Every message sent to B from round start up to (excluding) `wb_boom`. */
  preBoom: WbMsg[];
  /** Same stream, including `wb_boom` — used for the phase-order assertion. */
  full: WbMsg[];
}

/**
 * A and B in a room. Round 1 opens, A locks `word`, the bomb blows. Everything
 * B was sent from round start onwards is returned.
 */
function leakScenario(word: string): LeakRun {
  const h = boot(
    [
      ['a', 'Alice'],
      ['b', 'Bob'],
    ],
    { picker: new ScriptedPicker(['ion']) },
  );
  h.io.clear(); // the stream starts at ROUND START, not at room creation
  advance(); // lobby countdown -> round 1 live
  const fragment = h.io.pub('b').fragment;
  expect(fragment).not.toBeNull();

  submit(h.room, 'a', word);
  expect(h.io.priv('a').yourWord).toBe(word); // A really did lock it

  toBoom();

  // The scenario is run TWICE per test (assertion 4), so this room must be shut
  // down before the next one is built: `advanceTimersToNextTimer` fires the
  // globally-earliest timer, and a second live room would interleave with it.
  h.room.stop();

  const full = h.io.all('b');
  const idx = full.findIndex((m) => m.t === 'event' && m.ev.t === 'wb_boom');
  expect(idx).toBeGreaterThan(0);
  return { fragment: fragment as string, preBoom: full.slice(0, idx), full };
}

/** Every substring of `w` of length >= 3. */
function substrings3plus(w: string): string[] {
  const out = new Set<string>();
  for (let i = 0; i < w.length; i++) {
    for (let j = i + 3; j <= w.length; j++) out.add(w.slice(i, j));
  }
  return [...out];
}

/** Deep-equal "modulo timestamps": zero every absolute-ms field. */
function stripTimes(msgs: readonly WbMsg[]): unknown[] {
  return msgs.map((m) => {
    if (m.t !== 'wb_public') return m;
    return { ...m, roundStartedAt: 0, revealEndsAt: 0, countdownEndsAt: 0, matchEndsAt: 0 };
  });
}

describe('I1 — no early leak (docs/WORDBOMB.md §8.1, the mandated assertion)', () => {
  const SHORT = 'lion'; // 4 letters
  const LONG = 'inspirations'; // 12 letters

  it('B never sees A\'s word, its length, or its validity before the boom', () => {
    for (const w of [SHORT, LONG]) {
      const run = leakScenario(w);
      const hay = JSON.stringify(run.preBoom).toLowerCase();

      // (a) neither W nor any 3+ char substring of W — except the round's
      // fragment, which W must contain (§5.3) and which is public by design.
      expect(hay).not.toContain(w.toLowerCase());
      const needles = substrings3plus(w).filter((s) => s !== run.fragment);
      expect(needles.length).toBeGreaterThanOrEqual(2); // must stay non-trivial
      expect(needles).toContain(w.toLowerCase());
      for (const needle of needles) {
        expect(hay.includes(needle), `"${needle}" (from "${w}") leaked to B`).toBe(false);
      }

      // (b) every wb_locked payload has EXACTLY the key set ['t','playerId']
      const locks = run.preBoom
        .filter((m): m is EventEnvelope => m.t === 'event')
        .map((m) => m.ev)
        .filter((ev) => ev.t === 'wb_locked');
      expect(locks).toHaveLength(1); // A locked once; B is told only THAT
      for (const ev of locks) {
        expect(Object.keys(ev).sort()).toEqual(['playerId', 't']);
      }

      // (c) every wb_private sent to B carries yourWord === null
      const privates = run.preBoom.filter((m): m is WbPrivate => m.t === 'wb_private');
      expect(privates.length).toBeGreaterThan(0);
      for (const p of privates) {
        expect(p.you).toBe('b');
        expect(p.yourWord).toBeNull();
      }

      // B is told A holds SOMETHING — that is the entire permitted disclosure.
      const pub = run.preBoom.filter((m): m is WbPublicState => m.t === 'wb_public');
      const last = pub[pub.length - 1];
      expect(last).toBeDefined();
      expect(playerOf(last as WbPublicState, 'a').locked).toBe(true);
      // ...and no broadcast snapshot carries a word field at all.
      for (const s of pub) {
        for (const row of s.players) {
          expect(Object.keys(row).sort()).toEqual([
            'connected',
            'id',
            'locked',
            'name',
            'score',
          ]);
        }
      }

      // (e) no wb_boom while phase !== 'reveal'
      let phase: WbPhase = 'lobby';
      let booms = 0;
      for (const m of run.full) {
        if (m.t === 'wb_public') phase = m.phase;
        if (m.t === 'event' && m.ev.t === 'wb_boom') {
          booms++;
          expect(phase).toBe('reveal');
        }
      }
      expect(booms).toBe(1);
    }
  });

  it('(d) B\'s message stream is byte-identical for a 4-letter and a 12-letter W', () => {
    const short = leakScenario(SHORT);
    const long = leakScenario(LONG);
    expect(short.preBoom).toHaveLength(long.preBoom.length);
    expect(stripTimes(long.preBoom)).toEqual(stripTimes(short.preBoom));

    // Belt and braces: NO numeric field anywhere in B's stream may differ.
    const nums = (msgs: readonly WbMsg[]): number[] => {
      const out: number[] = [];
      const walk = (v: unknown): void => {
        if (typeof v === 'number') out.push(v);
        else if (Array.isArray(v)) for (const x of v) walk(x);
        else if (typeof v === 'object' && v !== null) for (const x of Object.values(v)) walk(x);
      };
      walk(stripTimes(msgs));
      return out;
    };
    expect(nums(long.preBoom)).toEqual(nums(short.preBoom));
  });

  it('positive control: B DOES learn the word — at the boom, and nowhere earlier', () => {
    // Without this the leak assertions above could pass vacuously (e.g. if the
    // scenario never actually locked a word). B's FULL stream must contain W.
    const run = leakScenario(LONG);
    expect(JSON.stringify(run.preBoom).toLowerCase()).not.toContain(LONG);
    expect(JSON.stringify(run.full).toLowerCase()).toContain(LONG);
    const boom = run.full
      .filter((m): m is EventEnvelope => m.t === 'event')
      .map((m) => m.ev)
      .find((ev): ev is Extract<WbEvent, { t: 'wb_boom' }> => ev.t === 'wb_boom');
    expect(boom).toBeDefined();
    expect(answerOf(boom as Extract<WbEvent, { t: 'wb_boom' }>, 'a').word).toBe(LONG);
  });
});

// =============================================================================
// §1.1 — scoring, the exact published table
// =============================================================================

describe('scoring — the §1.1 table, resolved by the room', () => {
  it('reproduces every published row (including the never-zero floor)', () => {
    // The table in docs/WORDBOMB.md §1.1, verbatim.
    expect(scoreWord('a'.repeat(12), 1)).toBe(144); // the cap
    expect(scoreWord('rationale', 1)).toBe(108);
    expect(scoreWord('nation', 1)).toBe(72);
    expect(scoreWord('nation', 2)).toBe(25);
    expect(scoreWord('a'.repeat(12), 3)).toBe(27); // loses to a unique 6-letter word
    expect(scoreWord('nation', 4)).toBe(9);
    expect(scoreWord('tip', 8)).toBe(3); // the floor — never zero
    expect(scoreWord('', 1)).toBe(0); // no answer
    // the floor is structural: a valid word always pays at least its own length
    for (let len = 3; len <= 15; len++) {
      for (let dupes = 1; dupes <= 8; dupes++) {
        expect(scoreWord('a'.repeat(len), dupes)).toBeGreaterThanOrEqual(Math.min(len, 12));
      }
    }
  });

  it('unique words: 12 letters -> 144, 9 -> 108, 6 -> 72', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
      ['c', 'Carol'],
    ]);
    advance(); // round 1 live, fragment 'ion'
    submit(h.room, 'a', 'inspirations'); // 12
    submit(h.room, 'b', 'positions'); // 9
    submit(h.room, 'c', 'nation'); // 6
    toBoom();
    const boom = lastBoom(h.io, 'a');
    expect(answerOf(boom, 'a')).toMatchObject({ word: 'inspirations', dupes: 1, points: 144 });
    expect(answerOf(boom, 'b')).toMatchObject({ word: 'positions', dupes: 1, points: 108 });
    expect(answerOf(boom, 'c')).toMatchObject({ word: 'nation', dupes: 1, points: 72 });
  });

  it('a 6-letter word split 2 ways scores 25 each', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
    ]);
    advance();
    submit(h.room, 'a', 'nation');
    submit(h.room, 'b', 'nation');
    toBoom();
    const boom = lastBoom(h.io, 'b');
    expect(answerOf(boom, 'a')).toMatchObject({ word: 'nation', dupes: 2, points: 25 });
    expect(answerOf(boom, 'b')).toMatchObject({ word: 'nation', dupes: 2, points: 25 });
  });

  it('a 12-letter word split 3 ways (27) LOSES to a unique 6-letter word (72)', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
      ['c', 'Carol'],
      ['d', 'Dave'],
    ]);
    advance();
    submit(h.room, 'a', 'inspirations');
    submit(h.room, 'b', 'inspirations');
    submit(h.room, 'c', 'inspirations');
    submit(h.room, 'd', 'nation');
    toBoom();
    const boom = lastBoom(h.io, 'd');
    for (const id of ['a', 'b', 'c']) {
      expect(answerOf(boom, id)).toMatchObject({ word: 'inspirations', dupes: 3, points: 27 });
    }
    expect(answerOf(boom, 'd')).toMatchObject({ word: 'nation', dupes: 1, points: 72 });
    expect(answerOf(boom, 'd').points).toBeGreaterThan(answerOf(boom, 'a').points);
  });

  it('a 6-letter word split 4 ways scores 9 each', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
      ['c', 'Carol'],
      ['d', 'Dave'],
    ]);
    advance();
    for (const id of ['a', 'b', 'c', 'd']) submit(h.room, id, 'nation');
    toBoom();
    const boom = lastBoom(h.io, 'a');
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(answerOf(boom, id)).toMatchObject({ dupes: 4, points: 9 });
    }
  });

  it('THE FLOOR: a 3-letter word split by a FULL room still scores 3, never 0', () => {
    // The floor matters most at MAX_PLAYERS, where the divisor is largest:
    // floor(12*3 / 20^1.5) = floor(0.40) = 0, so without max(L, ...) every one
    // of these players would be awarded ZERO for a valid word. That reads as a
    // bug, not a rule — which is exactly why the floor exists.
    const ids = Array.from({ length: MAX_PLAYERS }, (_, i) => `p${i + 1}`);
    const h = boot(ids.map((id, i) => [id, `P${i + 1}`] as const));
    advance();
    for (const id of ids) submit(h.room, id, 'ion'); // the fragment IS a word here
    toBoom();
    const boom = lastBoom(h.io, 'p1');
    expect(boom.answers).toHaveLength(MAX_PLAYERS);
    for (const id of ids) {
      const a = answerOf(boom, id);
      expect(a).toMatchObject({ word: 'ion', dupes: MAX_PLAYERS, points: 3 });
      expect(a.points).toBeGreaterThan(0);
    }
    // and the room applied exactly that to the scoreboard
    for (const id of ids) expect(playerOf(h.io.pub('p1'), id).score).toBe(3);
  });
});

// =============================================================================
// §5 — validation, every reason, in order
// =============================================================================

describe('§5 validation — every reason, in the mandated order', () => {
  it('walks 2a -> 2b -> 2c -> 3 -> 4 and never probes the dictionary early', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
    ]);
    advance(); // round 1 live, fragment 'ion'
    expect(h.io.pub('a').fragment).toBe('ion');
    const base = h.dict.calls;

    // 2a before 2b: "a1" is BOTH non-alpha and too short — 2a wins.
    submit(h.room, 'a', 'a1');
    cooldown();
    // 2b: letters only, below MIN_WORD_LEN
    submit(h.room, 'a', 'io');
    cooldown();
    // 2c: letters only, above MAX_WORD_LEN (and it does contain the fragment)
    const tooLong = `ion${'a'.repeat(MAX_WORD_LEN)}`;
    expect(tooLong.length).toBeGreaterThan(MAX_WORD_LEN);
    expect(tooLong.length).toBeLessThanOrEqual(MAX_SUBMIT_LEN);
    submit(h.room, 'a', tooLong);
    cooldown();
    // 3 before 4: a REAL word that misses the fragment must say so
    submit(h.room, 'a', 'zebra');
    cooldown();
    // 4: contains the fragment, is not a word
    submit(h.room, 'a', 'ionzz');
    cooldown();

    expect(h.io.rejects('a')).toEqual([
      'bad_chars',
      'too_short',
      'too_long',
      'missing_fragment',
      'not_a_word',
    ]);
    // §5.3 precedes §5.4: only the LAST of those five reached the dictionary.
    expect(h.dict.calls - base).toBe(1);
    // I1: not one of those rejections was shown to B
    expect(h.io.rejects('b')).toEqual([]);
  });

  it('trims and lowercases before checking (2a operates on the normalised word)', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
    ]);
    advance();
    submit(h.room, 'a', '  NATION  ');
    expect(h.io.rejects('a')).toEqual([]);
    expect(h.io.priv('a').yourWord).toBe('nation');
  });

  it('not_live: before the match starts, and after the grace window closes', () => {
    const h = boot([['a', 'Alice']]); // 1 player: still in lobby
    expect(h.io.pub('a').phase).toBe('lobby');
    submit(h.room, 'a', 'nation');
    expect(h.io.rejects('a')).toEqual(['not_live']);

    h.room.addPlayer('b', 'Bob');
    advance(); // round 1 live
    cooldown();
    submit(h.room, 'a', 'nation');
    expect(h.io.rejects('a')).toEqual(['not_live']); // no NEW reject: it was accepted
    expect(h.io.priv('a').yourWord).toBe('nation');

    toBoom(); // fuse + grace: scoring is closed
    cooldown();
    submit(h.room, 'a', 'onion');
    expect(h.io.rejects('a')).toEqual(['not_live', 'not_live']);
  });

  it('already_used is checked LAST — after the dictionary', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
    ]);
    advance();
    submit(h.room, 'a', 'nation'); // scores in round 1
    toBoom();
    afterReveal(); // round 2, fragment 'tio' — 'nation' still contains it
    expect(h.io.pub('a').fragment).toBe('tio');
    const base = h.dict.calls;
    submit(h.room, 'a', 'nation');
    expect(h.io.rejects('a')).toEqual(['already_used']);
    expect(h.dict.calls - base).toBe(1); // it DID cost a probe: step 5 is last
  });

  it('MAX_SUBMIT_LEN is parser-enforced: an oversized word is dropped silently', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
    ]);
    advance();
    const base = h.dict.calls;
    submit(h.room, 'a', 'i'.repeat(MAX_SUBMIT_LEN + 1));
    expect(h.io.rejects('a')).toEqual([]); // no reject event at all
    expect(h.dict.calls).toBe(base);
    expect(h.io.priv('a').yourWord).toBeNull();
  });
});

describe('§5 step 0 — the budget, before everything including the dictionary', () => {
  it('a cooldown rejection costs ZERO dictionary lookups', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
    ]);
    advance();
    submit(h.room, 'a', 'nation'); // accepted; costs one probe
    const base = h.dict.calls;
    // same millisecond: inside SUBMIT_COOLDOWN_MS. The word WOULD reach the
    // dictionary if the budget were checked late.
    submit(h.room, 'a', 'onions');
    expect(h.io.rejects('a')).toEqual(['too_fast']);
    expect(h.dict.calls).toBe(base); // the oracle is throttled, not merely scored
    expect(h.io.priv('a').yourWord).toBe('nation'); // I3: nothing was cleared

    vi.advanceTimersByTime(SUBMIT_COOLDOWN_MS - 1);
    submit(h.room, 'a', 'onions');
    expect(h.io.rejects('a')).toEqual(['too_fast', 'too_fast']); // still inside
    vi.advanceTimersByTime(1);
    submit(h.room, 'a', 'onions');
    expect(h.io.rejects('a')).toEqual(['too_fast', 'too_fast']); // now allowed
    expect(h.io.priv('a').yourWord).toBe('onions');
  });

  it('MAX_SUBMITS_PER_ROUND caps the round, and submitsLeft counts down', () => {
    // rand -> 0.9999 pins the fuse at FUSE_MAX_MS, so 20 spaced submits fit.
    const h = boot(
      [
        ['a', 'Alice'],
        ['b', 'Bob'],
      ],
      { rand: () => 0.9999 },
    );
    advance();
    for (let i = 0; i < MAX_SUBMITS_PER_ROUND; i++) {
      submit(h.room, 'a', 'nation');
      expect(h.io.priv('a').submitsLeft).toBe(MAX_SUBMITS_PER_ROUND - (i + 1));
      cooldown();
    }
    expect(h.io.rejects('a')).toEqual([]);
    expect(h.io.priv('a').submitsLeft).toBe(0);
    const base = h.dict.calls;
    submit(h.room, 'a', 'onions');
    expect(h.io.rejects('a')).toEqual(['too_fast']);
    expect(h.dict.calls).toBe(base);
    // the budget is PER ROUND: the next round restores it
    toBoom();
    afterReveal();
    expect(h.io.priv('a').submitsLeft).toBe(MAX_SUBMITS_PER_ROUND);
  });
});

// =============================================================================
// I3 / I4 — last valid wins; reuse is committed at BOOM, not at lock time
// =============================================================================

describe('I3 — a rejected submission never clears an accepted word', () => {
  it('keeps the locked word through every kind of rejection', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
    ]);
    advance();
    submit(h.room, 'a', 'nation');
    expect(h.io.priv('a').yourWord).toBe('nation');
    for (const bad of ['zebra', 'io', 'a1', 'ionzz']) {
      cooldown();
      submit(h.room, 'a', bad);
      expect(h.io.priv('a').yourWord).toBe('nation');
      expect(playerOf(h.io.pub('b'), 'a').locked).toBe(true);
    }
    expect(h.io.rejects('a')).toEqual(['missing_fragment', 'too_short', 'bad_chars', 'not_a_word']);
    toBoom();
    expect(answerOf(lastBoom(h.io, 'a'), 'a')).toMatchObject({ word: 'nation', points: 72 });
  });
});

describe('I4 — no self-reuse, committed at BOOM RESOLUTION', () => {
  it('re-locking a word abandoned earlier in the SAME round is legal', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
    ]);
    advance();
    submit(h.room, 'a', 'nation');
    cooldown();
    submit(h.room, 'a', 'onion'); // abandons 'nation'
    expect(h.io.priv('a').yourWord).toBe('onion');
    cooldown();
    submit(h.room, 'a', 'nation'); // comes BACK to it — never scored, so legal
    expect(h.io.rejects('a')).toEqual([]);
    expect(h.io.priv('a').yourWord).toBe('nation');
    toBoom();
    expect(answerOf(lastBoom(h.io, 'a'), 'a').word).toBe('nation');
  });

  it('a word that SCORED is burned; a word merely replaced stays available', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
    ]);
    advance(); // round 1, fragment 'ion'
    submit(h.room, 'a', 'motion'); // locked, then abandoned — NEVER scored
    cooldown();
    submit(h.room, 'a', 'nation'); // this is what actually scores
    toBoom();
    expect(answerOf(lastBoom(h.io, 'a'), 'a').word).toBe('nation');
    afterReveal(); // round 2, fragment 'tio' (both words contain it)
    expect(h.io.pub('a').fragment).toBe('tio');

    submit(h.room, 'a', 'nation'); // scored in round 1 => burned
    expect(h.io.rejects('a')).toEqual(['already_used']);
    cooldown();
    submit(h.room, 'a', 'motion'); // replaced before the boom => still available
    expect(h.io.rejects('a')).toEqual(['already_used']);
    expect(h.io.priv('a').yourWord).toBe('motion');
    toBoom();
    expect(answerOf(lastBoom(h.io, 'a'), 'a')).toMatchObject({ word: 'motion', points: 72 });
    expect(playerOf(h.io.pub('a'), 'a').score).toBe(144);
  });

  it('two DIFFERENT players using the same word is the split mechanic, not reuse', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
    ]);
    advance();
    submit(h.room, 'a', 'nation');
    submit(h.room, 'b', 'nation');
    expect(h.io.rejects('a')).toEqual([]);
    expect(h.io.rejects('b')).toEqual([]);
    toBoom();
    const boom = lastBoom(h.io, 'a');
    expect(answerOf(boom, 'a').points).toBe(25);
    expect(answerOf(boom, 'b').points).toBe(25);
  });
});

// =============================================================================
// wb_locked — at most once per player per round
// =============================================================================

describe('wb_locked', () => {
  it('fires at most ONCE per player per round across three accepted re-locks', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
    ]);
    advance();
    submit(h.room, 'a', 'nation');
    cooldown();
    submit(h.room, 'a', 'onion');
    cooldown();
    submit(h.room, 'a', 'union');
    expect(h.io.rejects('a')).toEqual([]); // all three were ACCEPTED
    expect(h.io.priv('a').yourWord).toBe('union');
    const locksForA = (id: PlayerId): number =>
      h.io.events(id, 'wb_locked').filter((ev) => ev.playerId === 'a').length;
    expect(locksForA('b')).toBe(1); // re-locks are NOT a cadence side channel
    expect(locksForA('a')).toBe(1);

    // and it re-arms for the next round
    toBoom();
    afterReveal();
    submit(h.room, 'a', 'rations'); // contains round 2's 'tio'
    expect(h.io.rejects('a')).toEqual([]);
    expect(locksForA('b')).toBe(2);
  });

  it('a rejected submission never broadcasts wb_locked', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
    ]);
    advance();
    submit(h.room, 'a', 'zebra');
    expect(h.io.events('b', 'wb_locked')).toHaveLength(0);
    expect(playerOf(h.io.pub('b'), 'a').locked).toBe(false);
  });
});

// =============================================================================
// SUBMIT_GRACE_MS — latency fairness
// =============================================================================

describe('SUBMIT_GRACE_MS', () => {
  it('a submit 100 ms after the boom scores; one at 400 ms does not', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
    ]);
    advance(); // round 1 live
    const roundStart = Date.now();
    advance(); // fuse expiry — the VISIBLE explosion
    const boomAt = Date.now();
    const fuse = boomAt - roundStart;
    expect(fuse).toBeGreaterThanOrEqual(FUSE_MIN_MS);
    expect(fuse).toBeLessThanOrEqual(FUSE_MAX_MS);
    expect(h.io.pub('a').phase).toBe('reveal');
    expect(h.io.events('a', 'wb_boom')).toHaveLength(0); // scoring is still open

    vi.advanceTimersByTime(100);
    expect(100).toBeLessThan(SUBMIT_GRACE_MS);
    submit(h.room, 'a', 'nation'); // sent before the bang, arrived after it
    expect(h.io.rejects('a')).toEqual([]);

    advance(); // grace closes -> wb_boom
    expect(Date.now() - boomAt).toBe(SUBMIT_GRACE_MS);
    const boom = lastBoom(h.io, 'a');
    expect(answerOf(boom, 'a')).toMatchObject({ word: 'nation', points: 72 });

    // 400 ms after the boom is outside the window: not_live, and no score.
    vi.advanceTimersByTime(400 - SUBMIT_GRACE_MS);
    expect(Date.now() - boomAt).toBe(400);
    submit(h.room, 'b', 'onion');
    expect(h.io.rejects('b')).toEqual(['not_live']);
    expect(answerOf(lastBoom(h.io, 'b'), 'b').word).toBeNull();
    expect(playerOf(h.io.pub('b'), 'b').score).toBe(0);
  });

  it('the reveal window runs revealMsFor(players) beyond the grace', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
    ]);
    advance();
    advance(); // explosion
    const boomAt = Date.now();
    expect(h.io.pub('a').revealEndsAt).toBe(boomAt + SUBMIT_GRACE_MS + revealMsFor(2));
    advance(); // wb_boom
    advance(); // afterReveal
    expect(Date.now()).toBe(boomAt + SUBMIT_GRACE_MS + revealMsFor(2));
    expect(h.io.pub('a').round).toBe(2);
  });
});

// =============================================================================
// I7 — the reveal is total
// =============================================================================

describe('I7 — reveal is total', () => {
  it('3 players, 1 submitter -> answers.length === 3, identical for everyone', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
      ['c', 'Carol'],
    ]);
    advance();
    submit(h.room, 'a', 'nation');
    toBoom();
    const boomA = lastBoom(h.io, 'a');
    expect(boomA.answers).toHaveLength(3);
    expect(answerOf(boomA, 'b')).toEqual({
      playerId: 'b',
      name: 'Bob',
      word: null,
      dupes: 0,
      points: 0,
    });
    expect(answerOf(boomA, 'c').word).toBeNull();
    // byte-identical payload to every connected player
    expect(lastBoom(h.io, 'b')).toEqual(boomA);
    expect(lastBoom(h.io, 'c')).toEqual(boomA);
    expect(boomA.fragment).toBe('ion');
    // every row carries a name so the reveal renders standalone
    for (const row of boomA.answers) expect(row.name.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// §2.1 — membership, all six rows
// =============================================================================

describe('§2.1 membership', () => {
  it('row 1: a mid-match joiner is seated at 0 and may not submit until next round', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
    ]);
    advance(); // round 1 live
    submit(h.room, 'a', 'nation');
    h.room.addPlayer('c', 'Carol');

    const st = h.io.pub('c');
    expect(st.phase).toBe('live');
    expect(playerOf(st, 'c')).toMatchObject({ score: 0, locked: false, connected: true });
    submit(h.room, 'c', 'onion'); // a perfectly valid word
    expect(h.io.rejects('c')).toEqual(['not_live']);
    expect(h.io.priv('c').yourWord).toBeNull();

    toBoom();
    const boom = lastBoom(h.io, 'c');
    expect(boom.answers).toHaveLength(3);
    expect(answerOf(boom, 'c')).toMatchObject({ word: null, points: 0, dupes: 0 });
    expect(playerOf(h.io.pub('c'), 'c').score).toBe(0);

    afterReveal(); // round 2: Carol is now eligible
    submit(h.room, 'c', 'motion'); // contains 'tio'
    expect(h.io.rejects('c')).toEqual(['not_live']); // no NEW rejection
    expect(h.io.priv('c').yourWord).toBe('motion');
  });

  it('row 2: a player who disconnects holding a locked word IS scored', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
      ['c', 'Carol'],
    ]);
    advance();
    submit(h.room, 'a', 'nation');
    submit(h.room, 'b', 'onion');
    h.room.removePlayer('a'); // socket dropped, not a permanent leave
    const st = h.io.pub('b');
    expect(playerOf(st, 'a').connected).toBe(false);
    expect(st.players).toHaveLength(3); // the entry persists
    expect(h.room.playerCount()).toBe(2); // ...but holds no slot

    toBoom();
    const boom = lastBoom(h.io, 'b');
    expect(boom.answers).toHaveLength(3);
    expect(answerOf(boom, 'a')).toMatchObject({ word: 'nation', points: 72, name: 'Alice' });
    expect(playerOf(h.io.pub('b'), 'a').score).toBe(72);

    afterReveal(); // the ghost is purged at the next round start
    expect(h.io.pub('b').players.map((p) => p.id)).toEqual(['b', 'c']);
  });

  it('row 3: a permanent leave deletes the entry; wb_boom still names every row', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
      ['c', 'Carol'],
    ]);
    advance();
    submit(h.room, 'a', 'nation');
    h.room.removePlayer('a', true); // explicit 'leave'
    const st = h.io.pub('b');
    expect(st.players.map((p) => p.id)).toEqual(['b', 'c']);
    submit(h.room, 'b', 'onion');
    toBoom();
    const boom = lastBoom(h.io, 'b');
    expect(boom.answers).toHaveLength(2);
    expect(boom.answers.map((a) => a.playerId)).toEqual(['b', 'c']);
    for (const row of boom.answers) expect(row.name).toBeTruthy();
  });

  it('row 4: dropping below MIN_PLAYERS aborts to lobby, KEEPS scores, clears timers', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
    ]);
    advance();
    submit(h.room, 'a', 'nation');
    toBoom();
    expect(playerOf(h.io.pub('a'), 'a').score).toBe(72);
    afterReveal(); // round 2 live
    expect(h.io.pub('a').round).toBe(2);

    h.room.removePlayer('b');
    expect(h.room.playerCount()).toBe(1);
    expect(MIN_PLAYERS).toBe(2);
    const st = h.io.pub('a');
    expect(st.phase).toBe('lobby');
    expect(st.round).toBe(0);
    expect(st.fragment).toBeNull();
    expect(st.roundStartedAt).toBe(0);
    expect(st.countdownEndsAt).toBe(0);
    expect(playerOf(st, 'a').score).toBe(72); // scores KEPT across the abort
    expect(vi.getTimerCount()).toBe(0); // every timer cleared

    // and nothing further happens on its own
    const before = h.io.totalSent();
    vi.advanceTimersByTime(FUSE_MAX_MS + MATCH_END_MS);
    expect(h.io.totalSent()).toBe(before);
  });

  it('row 5: an empty room stops every timer', () => {
    const h = boot(
      [
        ['a', 'Alice'],
        ['b', 'Bob'],
      ],
      { settings: { rounds: 5, difficulty: 'normal' } },
    );
    advance(); // round 1 live: a fuse timer is armed
    expect(vi.getTimerCount()).toBe(1);
    h.room.removePlayer('a', true);
    h.room.removePlayer('b', true);
    expect(h.room.playerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const before = h.io.totalSent();
    vi.advanceTimersByTime(MATCH_END_MS * 2);
    expect(h.io.totalSent()).toBe(before);
  });

  it('row 6: yourWord/locked reset at round START and persist through reveal', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
    ]);
    advance();
    expect(h.io.priv('a').yourWord).toBeNull(); // reset at round start
    expect(playerOf(h.io.pub('a'), 'a').locked).toBe(false);
    submit(h.room, 'a', 'nation');
    expect(playerOf(h.io.pub('b'), 'a').locked).toBe(true);
    toBoom();
    // through the whole reveal window they persist, so a client can highlight
    expect(h.io.pub('a').phase).toBe('reveal');
    expect(h.io.priv('a').yourWord).toBe('nation');
    expect(playerOf(h.io.pub('b'), 'a').locked).toBe(true);
    afterReveal();
    expect(h.io.pub('a').round).toBe(2);
    expect(h.io.priv('a').yourWord).toBeNull();
    expect(playerOf(h.io.pub('b'), 'a').locked).toBe(false);
  });
});

// =============================================================================
// Phases, fragments (I5 at the room seam) and reconnect (I8)
// =============================================================================

describe('phases', () => {
  it('lobby -> countdown -> live -> reveal -> live, with the fuse never on the wire', () => {
    const h = boot([['a', 'Alice']]);
    let st = h.io.pub('a');
    expect(st.phase).toBe('lobby');
    expect(st.round).toBe(0);
    expect(st.rounds).toBe(DEFAULT_SETTINGS.rounds);
    expect(st.difficulty).toBe(DEFAULT_SETTINGS.difficulty);
    expect(st.fragment).toBeNull();
    expect(st.countdownEndsAt).toBe(0);
    expect(st.code).toBeNull(); // public room
    expect(h.room.info()).toMatchObject({ game: 'wordbomb', phase: 'lobby', maxPlayers: MAX_PLAYERS });

    h.room.addPlayer('b', 'Bob');
    st = h.io.pub('a');
    expect(st.phase).toBe('lobby');
    expect(st.countdownEndsAt).toBe(Date.now() + LOBBY_COUNTDOWN_MS);

    advance();
    st = h.io.pub('a');
    expect(st.phase).toBe('live');
    expect(st.round).toBe(1);
    expect(st.roundStartedAt).toBe(Date.now());
    expect(st.countdownEndsAt).toBe(0);
    expect(st.revealEndsAt).toBe(0);
    expect(st.matchEndsAt).toBe(0);
    // the WINDOW is published; the actual fuse is not, in any field
    expect(st.fuseMinMs).toBe(FUSE_MIN_MS);
    expect(st.fuseMaxMs).toBe(FUSE_MAX_MS);
    const keys = Object.keys(st).sort();
    expect(keys).not.toContain('phaseEndsAt');
    expect(keys).not.toContain('fuseMs');

    advance();
    expect(h.io.pub('a').phase).toBe('reveal');
    expect(h.io.pub('a').roundStartedAt).toBe(0);
    advance(); // wb_boom
    advance(); // next round
    expect(h.io.pub('a').phase).toBe('live');
    expect(h.io.pub('a').round).toBe(2);
  });

  it('a private room carries a join code; a public room does not', () => {
    const priv = boot([['a', 'Alice']], { visibility: 'private' });
    const code = priv.io.pub('a').code;
    expect(typeof code).toBe('string');
    expect((code ?? '').length).toBeGreaterThan(0);
    expect(priv.room.info().code).toBe(code);
    expect(priv.room.info().visibility).toBe('private');
  });

  it('feeds the picker a growing used-set, and never repeats a fragment in a match', () => {
    const h = boot(
      [
        ['a', 'Alice'],
        ['b', 'Bob'],
      ],
      { settings: { rounds: 5, difficulty: 'hard' } },
    );
    advance();
    const seen: string[] = [];
    for (let r = 1; r <= 5; r++) {
      const st = h.io.pub('a');
      expect(st.round).toBe(r);
      expect(st.difficulty).toBe('hard');
      const f = st.fragment;
      expect(f).not.toBeNull();
      seen.push(f as string);
      toBoom();
      afterReveal();
    }
    expect(new Set(seen).size).toBe(5); // I5 at the room seam: no repeat
    expect(h.picker.usedSeen).toHaveLength(5);
    h.picker.usedSeen.forEach((used, i) => {
      expect(used).toHaveLength(i); // the room accumulates and passes it in
      expect(used).toEqual(seen.slice(0, i));
    });
  });
});

describe('I8 — reconnect is safe', () => {
  it('restores score and the locked word to the rejoiner ALONE, and cannot double-score', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
      ['c', 'Carol'],
    ]);
    advance();
    submit(h.room, 'a', 'nation');
    toBoom();
    expect(playerOf(h.io.pub('a'), 'a').score).toBe(72);
    afterReveal(); // round 2, fragment 'tio'
    submit(h.room, 'a', 'motion');

    h.room.removePlayer('a'); // socket dropped mid-round
    h.room.addPlayer('a2', 'Alice', 'a'); // resume token
    const st = h.io.pub('b');
    expect(st.players).toHaveLength(3); // re-bind, not a duplicate row
    expect(st.players.map((p) => p.id)).toEqual(['a2', 'b', 'c']); // join slot kept
    expect(playerOf(st, 'a2')).toMatchObject({ score: 72, connected: true, locked: true });

    const mine = h.io.priv('a2');
    expect(mine.you).toBe('a2');
    expect(mine.yourWord).toBe('motion'); // restored to the owner alone
    // ...and to nobody else: B's whole stream still has no trace of it
    expect(JSON.stringify(h.io.all('b')).toLowerCase()).not.toContain('motion');

    toBoom();
    const boom = lastBoom(h.io, 'b');
    expect(boom.answers).toHaveLength(3);
    expect(answerOf(boom, 'a2')).toMatchObject({ word: 'motion', points: 72 });
    expect(playerOf(h.io.pub('b'), 'a2').score).toBe(144); // 72 + 72, not doubled
  });
});

// =============================================================================
// §1.3 — match end, tie-break, full reset
// =============================================================================

/** Round-by-round script: [aWord, bWord] against DEFAULT_FRAGMENTS[0..4]. */
function playFiveRounds(h: Harness, script: ReadonlyArray<readonly [string, string]>): void {
  for (const pair of script) {
    const st = h.io.pub('a');
    expect(st.phase).toBe('live');
    submit(h.room, 'a', pair[0]);
    submit(h.room, 'b', pair[1]);
    expect(h.io.rejects('a')).toEqual([]);
    expect(h.io.rejects('b')).toEqual([]);
    toBoom();
    afterReveal();
  }
}

describe('§1.3 match end', () => {
  const FRAGMENTS_5 = ['ion', 'tio', 'nat', 'uni', 'vis'] as const;

  it('ends after `rounds`, names the winner, and holds standings for MATCH_END_MS', () => {
    const h = boot(
      [
        ['a', 'Alice'],
        ['b', 'Bob'],
      ],
      {
        settings: { rounds: 5, difficulty: 'normal' },
        picker: new ScriptedPicker(FRAGMENTS_5),
      },
    );
    advance();
    // B plays a 7-letter word in round 1; everything else is length-matched, so
    // B wins 372-360 despite joining SECOND (winnerId is not "first player").
    playFiveRounds(h, [
      ['nation', 'nations'],
      ['rations', 'actions'],
      ['nature', 'donate'],
      ['union', 'unite'],
      ['vision', 'visual'],
    ]);

    const st = h.io.pub('a');
    expect(st.phase).toBe('matchEnd');
    expect(st.round).toBe(5);
    expect(st.fragment).toBeNull();
    expect(st.matchEndsAt).toBe(Date.now() + MATCH_END_MS);
    expect(playerOf(st, 'a').score).toBe(72 + 84 + 72 + 60 + 72);
    expect(playerOf(st, 'b').score).toBe(84 + 84 + 72 + 60 + 72);
    expect(st.winnerId).toBe('b');

    const ends = h.io.events('a', 'wb_match_end');
    expect(ends).toHaveLength(1);
    const end = ends[0];
    expect(end).toBeDefined();
    expect(end?.winnerId).toBe('b');
    expect(end?.standings).toEqual([
      { playerId: 'b', name: 'Bob', score: 372 },
      { playerId: 'a', name: 'Alice', score: 360 },
    ]);
    expect(h.io.events('b', 'wb_match_end')).toEqual(ends); // identical to everyone
    // winnerId IS standings[0].playerId
    expect(st.winnerId).toBe(end?.standings[0]?.playerId);
  });

  it('breaks a tie by JOIN ORDER, then fully resets after MATCH_END_MS', () => {
    const h = boot(
      [
        ['a', 'Alice'],
        ['b', 'Bob'],
      ],
      {
        settings: { rounds: 5, difficulty: 'normal' },
        picker: new ScriptedPicker(FRAGMENTS_5),
      },
    );
    advance();
    playFiveRounds(h, [
      ['nation', 'motion'],
      ['rations', 'actions'],
      ['nature', 'donate'],
      ['union', 'unite'],
      ['vision', 'visual'],
    ]);

    let st = h.io.pub('a');
    expect(playerOf(st, 'a').score).toBe(360);
    expect(playerOf(st, 'b').score).toBe(360); // a genuine tie
    expect(st.winnerId).toBe('a'); // ...broken by join order ASC
    const end = h.io.events('b', 'wb_match_end')[0];
    expect(end?.standings.map((s) => s.playerId)).toEqual(['a', 'b']);

    // MATCH_END_MS later: purge, zero scores AND every used-word set, back to
    // lobby — and with >= MIN_PLAYERS present, straight into a new countdown.
    const endedAt = Date.now();
    advance();
    expect(Date.now() - endedAt).toBe(MATCH_END_MS);
    st = h.io.pub('a');
    expect(st.phase).toBe('lobby');
    expect(st.round).toBe(0);
    expect(st.winnerId).toBeNull();
    expect(st.matchEndsAt).toBe(0);
    expect(st.fragment).toBeNull();
    expect(playerOf(st, 'a').score).toBe(0);
    expect(playerOf(st, 'b').score).toBe(0);
    expect(st.countdownEndsAt).toBe(Date.now() + LOBBY_COUNTDOWN_MS);
    expect(h.io.priv('a').yourWord).toBeNull();

    advance(); // countdown -> a brand new match
    st = h.io.pub('a');
    expect(st.phase).toBe('live');
    expect(st.round).toBe(1);
    expect(st.fragment).toBe('ion'); // fragment history cleared too
    // the used-word sets were zeroed: 'nation' scored last match and is legal now
    submit(h.room, 'a', 'nation');
    expect(h.io.rejects('a')).toEqual([]);
    expect(h.io.priv('a').yourWord).toBe('nation');
  });
});

// =============================================================================
// I6 — never throw
// =============================================================================

describe('I6 — no GameRoomHandle member throws', () => {
  it('survives garbage on every entry point, before, during and after a match', () => {
    const h = boot([
      ['a', 'Alice'],
      ['b', 'Bob'],
    ]);
    const room: GameRoomHandle = h.room;

    const circular: Record<string, unknown> = { t: 'wb_submit', word: 'nation' };
    circular['self'] = circular;
    const garbage: unknown[] = [
      null,
      undefined,
      0,
      NaN,
      '',
      'wb_submit',
      [],
      [1, 2, 3],
      {},
      { t: null },
      { t: 42 },
      { t: 'wb_submit' },
      { t: 'wb_submit', word: null },
      { t: 'wb_submit', word: 42 },
      { t: 'wb_submit', word: {} },
      { t: 'wb_submit', word: ['nation'] },
      { t: 'wb_submit', word: 'x'.repeat(MAX_SUBMIT_LEN + 100) },
      { t: 'wb_submit', word: ' ￿' },
      { t: 'wb_submit', word: '   ' },
      { t: 'roll' }, // another game's message
      { t: 'wb_boom', answers: [] }, // a server->client tag, sent inbound
      circular,
      Object.create(null) as object,
    ];

    const hammer = (): void => {
      for (const g of garbage) {
        expect(() => room.handleMessage('a', g)).not.toThrow();
        expect(() => room.handleMessage('nobody', g)).not.toThrow();
      }
      expect(() => room.info()).not.toThrow();
      expect(() => room.playerCount()).not.toThrow();
      expect(() => room.stalePlayers()).not.toThrow();
      expect(() => room.addPlayer('', '')).not.toThrow();
      expect(() => room.addPlayer('a', 'Alice')).not.toThrow(); // duplicate id
      expect(() => room.addPlayer('ghost', 'G', 'nobody')).not.toThrow(); // bad resume
      expect(() => room.removePlayer('nobody')).not.toThrow();
      expect(() => room.removePlayer('nobody', true)).not.toThrow();
      expect(() => room.start()).not.toThrow();
    };

    hammer(); // lobby
    advance();
    hammer(); // live
    advance();
    hammer(); // reveal (pre-boom grace)
    advance();
    hammer(); // reveal (post-boom)

    expect(() => room.stop()).not.toThrow();
    expect(() => room.stop()).not.toThrow(); // idempotent
    hammer(); // after stop
    expect(room.info().game).toBe('wordbomb');
  });

  it('an over-full room refuses politely instead of throwing', () => {
    const seats = Array.from({ length: MAX_PLAYERS }, (_, i) => [`p${i}`, `P${i}`] as const);
    const h = boot(seats);
    expect(h.room.playerCount()).toBe(MAX_PLAYERS);
    expect(() => h.room.addPlayer('overflow', 'Nope')).not.toThrow();
    expect(h.room.playerCount()).toBe(MAX_PLAYERS);
    const msgs = h.io.all('overflow');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ t: 'error', code: 'room_full' });
  });

  it('a picker that throws ends the match cleanly rather than propagating', () => {
    const exploding: FragmentPicker = {
      pick(): string {
        throw new Error('pool exhausted');
      },
      poolSize(): number {
        return 0;
      },
    };
    const io = new FakeIO();
    const room = new WordbombRoom('public', io, { ...DEFAULT_SETTINGS }, {
      dict: new StubDict(),
      picker: exploding,
      rand: () => 0,
    });
    tracked.push(room);
    room.start();
    room.addPlayer('a', 'Alice');
    room.addPlayer('b', 'Bob');
    expect(() => vi.advanceTimersToNextTimer()).not.toThrow();
    expect(io.pub('a').phase).toBe('matchEnd');
  });
});

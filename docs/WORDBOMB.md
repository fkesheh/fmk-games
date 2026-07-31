# WORDBOMB — frozen game contract

Game #4 on the platform. A simultaneous word game: everyone gets the same letter fragment, a hidden
fuse burns, and every answer is revealed at once when it blows.

**This document is immutable during the build.** If it seems wrong, report it — do not edit it.
Read it with `docs/STRUCTURE.md` (the platform contract). BANK is the structural template.

---

## §1 — THE GAME

Ten rounds. No elimination — nobody ever sits and watches.

Each round:

1. The server picks a fragment of 2–3 letters (`TIO`, `BLE`, `STR`) and a **hidden** fuse length.
2. Every player sees the same fragment at the same moment and types a word containing it.
3. **Enter locks a word in.** The server validates instantly and privately. You may re-lock as
   often as you like — **your last valid word stands.**
4. The bomb explodes. **Every answer is revealed simultaneously.**
5. Scores are applied, a short reveal window passes, and the next round starts.

Highest total after ten rounds wins.

### §1.1 Scoring — the heart of the game

```
points = floor( min(length, 12)² / dupes )
```

where `dupes` is how many players submitted **that exact word** this round.

| Word | Len | Submitters | Points each |
| --- | --- | --- | --- |
| `RATIONALE` | 9 | 1 | **81** |
| `NATION` | 6 | 1 | **36** |
| `NATION` | 6 | 4 | **9** |
| `TIP` | 3 | 1 | **9** |
| no answer | — | — | **0** |

Two properties this is designed to produce, and which a reviewer must not "simplify" away:

- **The obvious word is a trap.** Six people typing `NATION` all get scraps. The question stops
  being "can I think of a word" and becomes "what will nobody else think of" — which is a real
  decision every round rather than a typing race.
- **A unique short word ties a shared medium one** (`TIP` alone = `NATION` split four ways = 9).
  There is deliberately no single dominant strategy.

**Why the length cap at 12.** `length²` is unbounded, so `antidisestablishmentarianism` would score
784 and decide the match on its own. Capping at 12 (=144) keeps ambition well rewarded without
letting one memorised party trick end the game. `MAX_SCORING_LEN` is a config constant.

### §1.2 The push-your-luck layer

Re-locking is what makes this more than a vocabulary quiz. You have `NATION` banked and an unknown
number of seconds left: sit on 36 points, or gamble the round hunting `RATIONALE`? That is the same
DNA as BANK, which is a deliberate bit of coherence across the platform.

For this to work the fuse must be genuinely unknown. Clients are told `[fuseMinMs, fuseMaxMs]` so
the UI can render honest tension, and **never** the actual value.

---

## §2 — INVARIANTS (a reviewer checks each of these by name)

- **I1 — NO EARLY LEAK. The single most important rule in this document.** Until the bomb explodes,
  no player may learn *any* other player's word, its length, or its validity. The validation result
  goes **only** to the submitter. The broadcast carries `{ playerId }` and nothing else.
  If this leaks, players simply wait, read the room, and pick something different — and the entire
  split-points mechanic collapses. Any message shape that carries a word, a length, or a letter
  count to another player before `phase === 'reveal'` is a **fatal** contract violation.
- **I2 — SERVER IS THE ONLY JUDGE.** Validation, scoring, fuse timing and prompt choice all happen
  server-side. The client never ships the dictionary — that would both bloat the bundle and hand
  every player an instant auto-solver.
- **I3 — LAST VALID WINS.** A rejected submission never clears a previously accepted word.
- **I4 — NO SELF-REUSE.** A player may not score the same word twice in a match. Two *different*
  players using the same word is not reuse — it is the split mechanic working.
- **I5 — THE POOL IS NEVER EMPTY.** Every difficulty must have a provably non-empty fragment pool,
  and a match must never repeat a fragment. Verified by a test, not by inspection.
- **I6 — NEVER THROW.** No `GameRoomHandle` member may throw; the platform does not catch.
- **I7 — REVEAL IS TOTAL.** Every connected player receives the same `wb_boom` payload, including
  players who submitted nothing.
- **I8 — RECONNECT IS SAFE.** Rejoining mid-round restores your score and your locked word to you
  alone, and can neither double-score nor reveal anything early.

---

## §3 — THE DICTIONARY

Source: **`word-list`** (npm, SCOWL-derived). Measured: 274,137 raw entries, **zero capitalised**,
269,746 surviving the filter `^[a-z]{3,15}$`. The system dictionary was rejected — it is Webster's
2nd with 25,203 proper nouns, which would allow `zanzibar` and corrupt every difficulty count.

### §3.1 ONE committed artifact. Everything else is derived.

There is exactly **one** generated file: `games/wordbomb/server/data/words.blob` — the filtered word
list, **sorted**, newline-delimited, latin1, ~2.60 MB.

Sorting at build time is mandatory and is not cosmetic: the upstream `word-list` file is **not
sorted** (measured: 2 inversions, e.g. `manlily` before `manlihood`), which silently breaks binary
search on real words.

**The fragment table is NOT committed — it is derived at startup**, in a single pass over the blob,
by scanning the `Buffer` bytewise with no string allocation. Measured: **24.6 ms** to derive all
8,378 fragments *and* the line index together. That removes a second artifact, a second Dockerfile
`COPY`, the 10× heap inflation of parsing a JSON table, and — most importantly — any possibility of
the table drifting out of sync with the word list. One input, one source of truth.

The same pass builds a **sparse line index** (every 16th line offset, 16,860 entries, 66 KB). A full
per-word index costs ~1.1 MB and measurably no faster; the sparse one is 16× smaller.

**Memory budget: under 8 MB RSS** for blob + index + pools, measured as a cross-process RSS delta
against a bare `node` process, `global.gc()` before each sample. W1 must report that number.
Reference points measured on node 24: `Set<string>` of the full list ≈ **43 MB resident** (22–25 MB
of it JS heap); the required structure ≈ **4.8 MB**. A `Set` of the full list is a contract violation.
Do not load the blob with `readFileSync(..., 'utf8')` — keep it a `Buffer`.

### §3.1.1 Lookup correctness is a TEST, not a spec

This document deliberately gives **no binary-search pseudocode**. The architect wrote a sketch while
drafting this section; it had an inverted comparison and returned **269,746 false negatives — every
word in the dictionary reported missing**. It looked entirely reasonable. Had it been frozen here,
an implementer would have copied it faithfully.

So the contract specifies the **interface and the proof obligation** instead:

```ts
export interface Dict { has(word: string): boolean; readonly size: number }
```

W12 (`dict.test.ts`) must assert, and no implementation is accepted until it does:
- **all 269,746 words round-trip findable** — the exhaustive check, not a sample
- ≥ 5,000 known-absent strings reject (`zanzibar`, `asdfgh`, near-misses, prefixes, suffixes)
- the blob is monotonically sorted
- lookup of the first and last word in the blob, and of every word adjacent to a sparse-index boundary

### §3.2 Build-time preprocessing

`word-list` is a **devDependency**, used only by the generator. The script filters by `DICT_WORD_RE`,
sorts, and writes `words.blob`. It must also print the derived pool sizes so a human can see them.

Difficulty counts key off `common` (words of length ≤ `COMMON_MAX_LEN` containing the fragment),
never `total`: a fragment with 200 matches that are all obscure is legal and humanly impossible, and
`total` cannot tell those apart.

**Known weakness, deliberately recorded:** `common` is a *proxy* for frequency and a poor one —
measured, only 20.6% of the words it counts appear in the 50,000 most frequent English words. In the
`hard` band, 26.2% of fragments have **zero** answers among the 5,000 most common words, producing
prompts like `zuz`, `paua`, `tts`, `hyl`. Fixing this properly requires a real frequency list as a
second build input. Until then, `hard` is **not fit to be a default** — see §6.

The script must emit 20 sample fragments per difficulty band for human review. A band nobody can
answer is a design failure that a green test will not catch.

### §3.3 Placement

Dictionary and fragment tables live in **`games/wordbomb/server/`**, never in `shared/` — `shared/`
is imported by the client, and I2 forbids shipping the dictionary to the browser.

---

## §4 — WIRE PROTOCOL

Platform rules: only the 8 lobby tags are parsed by the lobby; every other `{t: string}` is passed
**raw** to the room, which validates it itself. All tags below are `wb_`-prefixed so they cannot
collide.

### §4.1 Client → server

```ts
export type WbC2S = { t: 'wb_submit'; word: string };
```

That is the entire client surface. There is deliberately no "typing" message: broadcasting progress
would leak length and violate I1.

### §4.2 Server → client

Per-recipient snapshot (differs by `you` and `yourWord`), mirroring BANK's `stateFor(id)`:

```ts
export type WbPhase = 'lobby' | 'live' | 'reveal' | 'matchEnd';

export interface WbPlayerState {
  id: string;
  name: string;
  score: number;
  connected: boolean;
  locked: boolean;      // I1: whether they hold a valid word. NEVER the word.
}

export interface WbState {
  t: 'wb_state';
  you: string;
  code: string | null;
  phase: WbPhase;
  round: number;            // 1-based; 0 in lobby
  rounds: number;
  fragment: string | null;  // null unless phase is 'live' or 'reveal'
  fuseMinMs: number;        // the WINDOW, never the actual fuse
  fuseMaxMs: number;
  roundStartedAt: number;   // absolute server ms; 0 when not live
  phaseEndsAt: number;      // absolute server ms; 0 when none
  difficulty: WbDifficulty;
  players: WbPlayerState[];
  yourWord: string | null;  // I1: ONLY ever populated for the recipient
}
```

Events, wrapped as `{ t: 'event', ev }` per platform convention:

```ts
export interface WbAnswer {
  playerId: string;
  word: string | null;   // null = no answer
  dupes: number;
  points: number;
}

export type WbRejectReason =
  | 'not_a_word' | 'missing_fragment' | 'already_used'
  | 'too_short' | 'bad_chars' | 'not_live';

export type WbEvent =
  | { t: 'wb_locked'; playerId: string }                    // broadcast — no word, no length
  | { t: 'wb_reject'; reason: WbRejectReason }              // to the SUBMITTER ONLY
  | { t: 'wb_boom'; fragment: string; answers: WbAnswer[] } // the simultaneous reveal
  | { t: 'wb_match_end'; standings: { playerId: string; score: number }[] };
```

An accepted submission needs no dedicated event — `wb_locked` broadcasts, and the submitter's own
`yourWord` updates in their next state snapshot.

---

## §5 — VALIDATION

In order; first failure wins, and the reason goes only to the submitter:

1. `phase === 'live'` — else `not_live`
2. `/^[a-z]{3,}$/` after lowercasing and trimming — else `bad_chars` / `too_short`
3. contains the round's fragment as a substring — else `missing_fragment`
4. present in the dictionary — else `not_a_word`
5. not already scored by this player this match — else `already_used`

Order matters: `missing_fragment` is checked before the dictionary so a real word that simply misses
the fragment gets an honest reason instead of "not a word", which players read as the game being
broken.

---

## §6 — CONFIG (pure data, no logic)

| Constant | Value | Note |
| --- | --- | --- |
| `ROUNDS_DEFAULT` | 10 | room setting |
| `FUSE_MIN_MS` / `FUSE_MAX_MS` | 8000 / 15000 | actual fuse uniform in range, hidden |
| `REVEAL_MS` | 6000 | reading the reveal is part of the game |
| `LOBBY_COUNTDOWN_MS` | 3000 | after `MIN_PLAYERS` reached |
| `MIN_PLAYERS` / `MAX_PLAYERS` | 2 / 8 | |
| `MAX_SCORING_LEN` | 12 | §1.1 |
| `MIN_WORD_LEN` | 3 | |
| `STALE_MS` | 300_000 | matches BANK |
| `DIFFICULTY` | easy/normal/hard → min `common` count | thresholds set from the measured bands |

Settings (opaque to the platform, validated in `createRoom`, throwing `Error(msg)` → `bad_settings`):

```ts
export interface WordbombSettings { rounds: number; difficulty: WbDifficulty; }
```

---

## §7 — FILE OWNERSHIP (disjoint; no file in two tasks)

Architect-owned, frozen before fan-out: this document, and
`games/wordbomb/shared/src/{types,config,scoring,protocol,index}.ts`.

| ID | Owns (exclusive) |
| --- | --- |
| W1 | `games/wordbomb/server/src/dict.ts` + the preprocessing script + generated artifacts |
| W2 | `games/wordbomb/server/src/prompts.ts` — fragment table, difficulty pools, per-match no-repeat |
| W3 | `games/wordbomb/server/src/room.ts` — `GameRoomHandle`, phases, fuse, scoring application |
| W4 | `games/wordbomb/server/src/module.ts` + `package.json` + `tsconfig.json` |
| W5 | `games/wordbomb/client/src/game.ts` — connection, state, DOM |
| W6 | `games/wordbomb/client/src/style.css` + `index.html` |
| W7 | `games/wordbomb/client/src/{main.ts,audio.ts}` + `vite.config.ts` + `package.json` + `tsconfig.json` |
| W8 | `games/wordbomb/server/src/room.test.ts` — rules, scoring, phases, I1–I8 |
| W9 | platform wiring: `registry.ts`, `platform/server/{package.json,tsconfig.json}`, root `package.json`, `vitest.config.ts`, `deploy/Dockerfile` |
| W10 | `platform/server/src/index.ts` — launcher card, palette, copy (it says "Three games") |
| W11 | `scripts/e2e-wordbomb.mjs` — two-browser suite |

**Seam rules.** W1 owns the dictionary *lookup* API; W2 consumes it and owns *selection*. W3 calls
both and owns no word logic itself. W5 owns DOM and state; W6 owns all styling — they are coupled
only by class names, so **W5 must publish its class list in a comment block at the top of
`game.ts` before styling begins.** W7's `vite.config.ts` `server.port` must be **5176** and match
`devPort` in W4's module, with `base: '/wordbomb/'`.

---

## §8 — GATES

Per task: `npm run typecheck` clean, `npm run build` clean, `npm test` with no new failures.
(`games/fps/server/src/game.test.ts "GameRoom armor absorb"` is a known pre-existing flake — ignore
it.) **`vitest.config.ts` needs both an `alias` and an `include` entry for the new game — a test
without them silently never runs.** That has already bitten this repo twice.

Definition of done: two browsers play a full ten-round match end to end, the reveal is simultaneous,
scores match the formula, and zero console errors.

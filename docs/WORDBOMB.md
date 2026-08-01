# WORDBOMB — frozen game contract

Game #4 on the platform. A simultaneous word game: everyone gets the same letter fragment, a hidden
fuse burns, and every answer is revealed at once when it blows.

**This document is immutable during the build.** If it seems wrong, report it — do not edit it.
Read it with `docs/STRUCTURE.md` (the platform contract). BANK is the structural template.

**PRECEDENCE: where this document and `games/wordbomb/shared/src/*.ts` disagree, the TypeScript
wins — report the drift.** Doc/code drift has already bitten this repo once (see `8a64e42`).

---

## §1 — THE GAME

Ten rounds. No elimination — nobody ever sits and watches.

Each round:

1. The server picks a 3-letter fragment (`TIO`, `BLE`, `STR`) and a **hidden** fuse length.
2. Every player sees the same fragment at the same moment and types a word containing it.
3. **Enter locks a word in.** The server validates instantly and privately. You may re-lock as
   often as you like — **your last valid word stands.**
4. The bomb explodes. **Every answer is revealed simultaneously.**
5. Scores are applied, a short reveal window passes, and the next round starts.

Highest total after ten rounds wins.

### §1.1 Scoring — the heart of the game

```
L = min(length, 12)
points = max( L , floor( 12 · L / dupes^1.5 ) )
```

where `dupes` is how many players submitted **that exact word** this round.

| Word | Len | Submitters | Points each |
| --- | --- | --- | --- |
| 12 letters | 12 | 1 | **144** (the cap) |
| `RATIONALE` | 9 | 1 | **108** |
| `NATION` | 6 | 1 | **72** |
| `NATION` | 6 | 2 | **25** |
| 12 letters | 12 | 3 | **27** ← loses to a unique 6-letter word |
| `NATION` | 6 | 4 | **9** |
| `TIP` | 3 | 8 | **3** (the floor — never zero) |
| no answer | — | — | **0** |

**This formula was arrived at by simulation, and two earlier ones were measured and rejected. Do not
"simplify" it back.**

- `len² / dupes` — **broken.** "Always go long" beat "go unique" in 6 of 6 cells by 17–32%, because
  length and uniqueness are *positively* correlated rather than a trade-off: collision rate at 8
  players falls monotonically with length (3 letters 73.6%, 6 letters 44.5%, 12 letters 21.6%).
  There was no decision to make; the split mechanic was decorative.
- `len² / dupes²` — **overcorrected.** Median score in an 8-player hard round collapsed to 6, and
  `floor(9/16) = 0` meant ~10% of player-rounds awarded **zero for a valid word**, which reads as a
  bug rather than a rule.

The divisor was the wrong lever: measured, even scoring 0 on *any* collision leaves the easy band at
−13.8%. `len²` is what makes long words unbeatable, so the fix flattens length and puts the weight
on the split. The `max(L, …)` floor is a structural guarantee — **a valid word always pays at least
its own length** — and is what eliminates the zero-award failure.

### §1.2 The re-lock decision

You may re-lock as often as you like within the submission budget; **only a valid word locks**, and a
rejected one never clears what you already hold (I3).

**Honest measurement of what that produces**, opponents at equilibrium:

| Band | P(upgrading loses points) | EV of upgrading |
| --- | --- | --- |
| easy | 8–14% | **+39 to +44** — still close to free |
| normal | 37% | +19.7 — a mild gamble |
| hard | 55–70% | **+2.2 to −10.7** — a real decision |

So the push-your-luck layer is genuine in `hard`, mild in `normal`, and largely absent in `easy`.
That is stated rather than claimed uniformly, because an earlier draft of this document advertised a
tension the rules did not deliver.

For any of it to work the fuse must be genuinely unknown. Clients are told `[fuseMinMs, fuseMaxMs]`
so the UI can render honest tension, and **never** the actual value — see the note on
`WbPublicState.fuseMinMs` for why there is no general "phase ends at" field.

### §1.3 Ending a match

At `matchEnd` the standings hold for `MATCH_END_MS`. The room then purges disconnected entries,
zeroes scores and every player's used-word set, and returns to `lobby` — auto-starting again if
`>= MIN_PLAYERS` remain. This mirrors BANK's `fullReset`.

`winnerId` is `standings[0].playerId`. **Standings sort by score DESC, then join order ASC**; ties
are common (scores are sums of a floored formula) so the tie-break is part of the contract, not an
implementation detail.

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

### §2.1 Membership — every mid-match change, specified

Left undefined, each of these gets invented differently by W3, W8 and W11. Mirrors BANK.

| Event | Rule |
| --- | --- |
| Player joins while `phase !== 'lobby'` | seated with score 0, `locked: false`, and **may not submit until the next round starts**. Their `wb_boom` row for the round in progress is `{ word: null, points: 0 }` — they cannot score a round they did not play |
| Player disconnects holding a locked word | the word **is** scored and **does** appear in `answers`. Their entry persists with `connected: false` |
| Player leaves permanently | entry deleted; `wb_boom` still carries `name` on every row (that is why `WbAnswer.name` exists) so the reveal renders standalone |
| **SEATS** drop below `MIN_PLAYERS` | abort to `lobby`, **scores kept**, timers cleared. **Counted in SEATS, not connections** — only a permanent leave frees a seat. A disconnect (reload) must NOT abort, or I8 is unreachable at a 2-player table and this rule contradicts it |
| Room becomes empty | stop all timers; the room is dropped |
| `yourWord` / `locked` lifecycle | both reset at the **start** of each round, and persist through `reveal` so a client can highlight its own answer |

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

**The types are NOT reproduced here.** `games/wordbomb/shared/src/types.ts` is authoritative, and
transcribing it into prose is exactly what produced two rounds of drift on this build — including a
version of this section that still documented `phaseEndsAt`, the field that leaks the hidden fuse and
was deleted from the code for that reason. Read the file.

What matters at the contract level, and why the shape is what it is:

**The state is SPLIT into two messages, and that split is load-bearing.**

| Message | Delivery | Can it carry a word? |
| --- | --- | --- |
| `WbPublicState` (`t: 'wb_public'`) | broadcast, identical to everyone | **No.** It has no `you` and no word field, so a careless `broadcast(state)` cannot leak |
| `WbPrivate` (`t: 'wb_private'`) | unicast, one per recipient | Only the recipient's own `yourWord` |

An earlier draft had a single object holding both `players[]` and `yourWord`, defended by a comment.
That is one typo from broadcasting every word to every client and no compiler would catch it. **Do
not merge them back together.**

**There is no general "phase ends at" field.** `live` is a phase, so such a field would *be* the
fuse. The three concrete ones — `revealEndsAt`, `countdownEndsAt`, `matchEndsAt` — are each zero
outside their own phase. The client renders the fuse bar from `roundStartedAt + fuseMaxMs` and lives
with the uncertainty; that uncertainty is the game.

**Events** are wrapped as `{ t: 'event', ev }` per platform convention: `wb_locked` (broadcast,
`{ t, playerId }` and nothing else, **at most once per player per round** — re-firing would make it a
typing-cadence side channel), `wb_reject` (submitter only), `wb_boom` (the reveal, identical to
everyone, `WbAnswer` carries `name` so it renders standalone), and `wb_match_end` (with `winnerId`).

An accepted submission needs no dedicated event — `wb_locked` broadcasts, and the submitter's own
`yourWord` arrives in their next `wb_private`.

---

### §4.3 The debug surface (W5 owns; W11 depends on it)

Every game on this platform exposes one, and the e2e suite is written entirely against it
(`window.__bank` in docs/BANK.md, `window.__kart` in docs/KART.md). Without it W11 is unexecutable.

```ts
window.__wordbomb = {
  /** Latest merged public+private view, or null before the first snapshot. */
  state(): (WbPublicState & { you: string; yourWord: string | null }) | null;
  createPrivate(name: string, settings?: Partial<WordbombSettings>): void;
  joinPrivate(name: string, code: string): void;
  submit(word: string): void;
  /** Most recent rejection delivered to THIS client, or null. */
  lastReject(): WbRejectReason | null;
  /** Most recent reveal, or null. */
  lastBoom(): { fragment: string; answers: WbAnswer[] } | null;
  /** Every S2C message this client has received, for the I1 mirror assertion. */
  messageLog(): unknown[];
};
```

`messageLog()` exists specifically so assertion 3 of §8.2 can prove, from the browser, that B never
received A's word.

---

## §5 — VALIDATION

Checked in this order; first failure wins, and the reason goes **only** to the submitter.

| # | Check | Reason on failure |
| --- | --- | --- |
| 0 | within the per-round submission budget (`SUBMIT_COOLDOWN_MS`, `MAX_SUBMITS_PER_ROUND`) | `too_fast` |
| 1 | `phase === 'live'`, **or** within `SUBMIT_GRACE_MS` of the boom (folded into the round that just closed) | `not_live` |
| 2a | `/^[a-z]+$/` after `trim().toLowerCase()` | `bad_chars` |
| 2b | length ≥ `MIN_WORD_LEN` | `too_short` |
| 2c | length ≤ `MAX_WORD_LEN` | `too_long` |
| 3 | contains the round's fragment as a substring | `missing_fragment` |
| 4 | present in the dictionary | `not_a_word` |
| 5 | not already **scored** by this player this match (see I4) | `already_used` |

**Step 0 comes before everything**, including the dictionary lookup — that is the whole point. A
rejection must never cost a dictionary probe, or the budget does not throttle the oracle.

**2a/2b/2c are three separate checks, not one regex.** `"a1"` fails 2a and 2b; without an explicit
order two implementers return different reasons for the same input.

**Step 3 precedes step 4** deliberately: a real word that simply misses the fragment must be told
so, rather than being called "not a word", which players read as the game being broken.

**I4 is committed at BOOM RESOLUTION, from the word that actually scored — never at lock time.**
So re-locking a word you locked and abandoned earlier in the same round is legal (you are not
trapped on a word you were trying to escape), and a word that was replaced before the boom was never
scored and stays available in later rounds.

---

## §6 — CONFIG (pure data + boundary helpers)

`games/wordbomb/shared/src/config.ts` is authoritative; this table is a summary. **Where this
document and the TypeScript disagree, the TypeScript wins — report the drift.**

| Constant | Value | Note |
| --- | --- | --- |
| `ROUNDS_DEFAULT` / `_MIN` / `_MAX` | 10 / 5 / 20 | room setting |
| `MIN_PLAYERS` / `MAX_PLAYERS` | 2 / 8 | |
| `FUSE_MIN_MS` / `FUSE_MAX_MS` | 8000 / 15000 | actual fuse uniform in range, **never sent** |
| `revealMsFor(n)` | 7000 + 600n, max 16000 | scales with the table: 8.2s at 2 players, 16s at 20 |
| `LOBBY_COUNTDOWN_MS` | 3000 | |
| `MATCH_END_MS` | 12000 | §1.3 |
| `SUBMIT_GRACE_MS` | 250 | latency fairness |
| `SUBMIT_COOLDOWN_MS` / `MAX_SUBMITS_PER_ROUND` | 400 / 20 | anti-oracle |
| `MAX_SUBMIT_LEN` | 64 | wire cap, parser-enforced |
| `MIN_WORD_LEN` / `MAX_WORD_LEN` | 3 / 15 | |
| `MAX_SCORING_LEN` | 12 | |
| `DIFFICULTY_BANDS` | easy [200,400) · normal [80,200) · hard [40,80) | use `bandOf()` |
| `MIN_POOL_SIZE` | 60 | measured pools 512 / 969 / 851 |
| `FRAGMENT_MIN_LEN` / `_MAX_LEN` | 3 / 3 | 3-letter only |
| `COMMON_MAX_LEN` | 8 | commonality proxy |
| `STALE_MS` | 300000 | matches BANK |

**Default difficulty is `normal`.** `hard` must not be defaulted to: 26.2% of its fragments have
zero answers among the 5,000 commonest words (§3.2), and a novice posts a blank in a measured 62%
of hard rounds.

---

## §7 — FILE OWNERSHIP (disjoint; no file in two tasks)

**Architect-owned, frozen before fan-out, editable by nobody else:** this document,
`games/wordbomb/shared/src/{types,config,scoring,protocol,palette,index}.ts`,
`games/wordbomb/server/src/ports.ts`, `games/wordbomb/server/{package.json,tsconfig.json}`.

*(The server `package.json` is architect-owned specifically so W1 can add the `word-list`
devDependency and the `generate` script without editing a file W4 owns — an ownership collision the
pre-freeze panel caught.)*

| ID | Owns (exclusive) |
| --- | --- |
| W1 | `server/src/dict.ts` + `server/scripts/generate-dict.mjs` + `server/data/words.blob` |
| W2 | `server/src/prompts.ts` |
| W3 | `server/src/room.ts` |
| W4 | `server/src/module.ts` |
| W5 | `client/src/game.ts` — **must export `boot(root: HTMLElement): void`** and install the §4.3 debug surface |
| W6 | `client/src/style.css` + `games/wordbomb/client/index.html` (package root, **not** `src/`) |
| W7 | `client/src/{main.ts,audio.ts}` + `client/vite.config.ts` + `client/package.json` + `client/tsconfig.json` |
| W8 | `server/src/room.test.ts` — rules, scoring, phases, I1–I8 (see §8 for the mandated I1 assertion) |
| W9 | platform wiring — see the enumerated list below |
| W10 | `platform/server/src/index.ts` — the launcher (12+ hardcoded sites, enumerated below) |
| W11 | `scripts/e2e-wordbomb.mjs` — the numbered suite in §8 |
| W12 | `server/src/dict.test.ts` |
| W13 | `server/src/prompts.test.ts` |
| W14 | `shared/src/valueLadder.test.ts` |
| W15 | `scripts/capture-visuals.mjs` — 4 wordbomb shots + `wordbomb: 5176` in the devPorts map + re-shoot `launcher` |

**W9's five edit sites, spelled out** (each has silently bitten this repo before):
1. `platform/server/src/registry.ts` — import + **append** to `GAMES` (`GAMES[0]` is the lobby default)
2. `platform/server/package.json` — add `"@wordbomb/server": "0.0.0"`
3. `platform/server/tsconfig.json` — **three** path entries: `@wordbomb/server`, `@wordbomb/shared`, `@wordbomb/shared/*`
4. root `package.json` — `dev` (concurrently name + command) **and** the `build` chain, before the server build
5. `vitest.config.ts` — **one alias AND the include globs** (`shared`, `server`); a missing include means the tests silently never run
6. `deploy/Dockerfile` — package.json COPYs in **both** the build and prod-deps stages, the client dist COPY, **and `COPY --from=build /app/games/wordbomb/server/data ./games/wordbomb/server/data`** (without it the image builds clean and ENOENTs at runtime)
7. `package-lock.json` and `README.md` — W9 is the **only** task permitted to run `npm install`; every other task declares dependencies to the orchestrator

**W10's launcher sites:** `LPAL` accent/tint pair · the `COPY` map entry · `<meta name="description">`
and `<title>` (both say "Three games") · the eyebrow copy · the `h1` gradient (three hardcoded stops
at 6%/46%/94% — needs a four-colour layout) · the three body `radial-gradient` washes · `.card--wordbomb`
· `.mark--wordbomb` (pure CSS gradient geometry, no assets, no fonts — a fourth mark must be designed).
Accent/tint **must mirror exact `WPAL` entries** — `WPAL.fuse` and `WPAL.slate`.

**Seam rules.** W1 owns lookup, W2 owns selection, W3 calls both and contains no word logic — all
three against the frozen `ports.ts`. W5 owns DOM and state, W6 owns styling: they are coupled only
by class names, so **W5 publishes its class list in a comment block at the top of `game.ts` before
W6 begins.** W7's `vite.config.ts` uses `base: '/wordbomb/'` and `server.port: 5176` with
`strictPort: true`, matching `devPort` in W4's module.

---

## §8 — GATES

Per task: `npm run typecheck` clean, `npm run build` clean, `npm test` with no new failures.
(`games/fps/server/src/game.test.ts "GameRoom armor absorb"` is a known pre-existing flake — ignore
it.) W1 must additionally report its **measured RSS delta** (§3.1).

### §8.1 The I1 test (W8) — mandated shape, not left to judgement

I1 is the game's load-bearing rule, so it gets an assertion rather than a reviewer's opinion. Build a
room with players A and B behind a recording `RoomIO` that captures every `(recipientId, msg)` pair.
A submits a distinctive long word `W`. Over **every message sent to B** from round start until
`wb_boom`:

1. `JSON.stringify(msgsToB).toLowerCase()` contains neither `W` nor any 3+ character substring of `W`
2. every `wb_locked` payload has exactly the key set `['t','playerId']`
3. every `wb_private` sent to B has `yourWord === null`
4. run the scenario twice, with a 4-letter and a 12-letter `W`, and deep-equal B's message stream
   modulo timestamps — **no numeric field may vary with A's word length**
5. no `wb_boom` is emitted while `phase !== 'reveal'`

### §8.2 The e2e suite (W11) — numbered assertions

`node scripts/e2e-wordbomb.mjs`, two browsers, driven through the §4.3 debug surface. Wired as
`"e2e:wordbomb"` in root `package.json` (W9).

1. A `createPrivate` → code; B `joinPrivate` → both see 2 players
2. at `phase === 'live'` both read the **same** fragment
3. A submits a valid word → B sees `A.locked === true`, and B's full message log contains **no
   substring of A's word** (the browser-side mirror of I1)
4. A re-locks a longer word → last valid wins at the boom
5. A submits a word missing the fragment → `wb_reject` with `missing_fragment`, delivered to A only
6. at the boom both pages receive a **deep-equal** `answers` array
7. points equal `max(L, floor(12L/dupes^1.5))` computed independently in the harness
8. both submit the **same** word → each scores the split value
9. A re-submits a word already scored in an earlier round → `already_used`
10. 10 distinct fragments across 10 rounds
11. reload B mid-round → score and `yourWord` restored, `players.length` unchanged on A
12. `wb_match_end` standings sorted score DESC / join order ASC, and summing the per-round points
13. zero console and page errors throughout

### §8.3 Definition of done

Two browsers play a full ten-round match end to end, the reveal is simultaneous, scores match the
formula, and the suite above is green.

# SPLAT — FROZEN CONTRACT

A party game for a family: **ski downhill, and the snow keeps your tracks.**
Most colour on the mountain wins. Built specifically so a **4-year-old and a
6-year-old can play it with an adult** and all three enjoy it.

**Why downhill, and not the flat arena this was first designed as** — the
reasoning is load-bearing, so do not "improve" it back:

- **Gravity is the throttle.** The child only ever steers. In a flat arena
  auto-throttle had to be a hidden handicap; on a slope it is simply how skiing
  works, and needs no apology or concealment.
- **You cannot get lost.** The worst failure mode in a driving game for a small
  child is ending up facing a wall, driving the wrong way, confused, and no
  longer scoring. Downhill, "down" is always obvious, the camera never needs
  managing, and progress is continuous no matter what the player does.
- **Snow reads.** Eight mutually distinguishable player colours (§9) is a hard
  requirement, and colours separate far better against white than against grey.

Everything in §1–§5 is immutable. No task may change a signature, rename a
field, or widen its file ownership in §10. If a task believes the contract is
wrong, it STOPS and reports — it never renegotiates with a sibling task.

---

## §0 Envelope

**In:** a downhill slope, 2–8 players, skiers, a paint grid that records ski
tracks, a lift that returns you to the top, one pickup type, 90-second rounds,
an assist mode, three slopes.

**Out (v1):** teams (every player is their own colour), weapons, items beyond
the single pickup, elimination of any kind, jumps/tricks/air control, a finish
line or race placement, text-based UI, persistence, unlockables, chat.

---

## §1 THE DESIGN LAW — every task is bound by this

This game has an unusual primary constraint and it outranks elegance,
performance, and feature count. **A 4-year-old must never be able to fail, and a
6-year-old must never be able to make her feel like she failed.**

- **D1 — Movement IS scoring.** Driving anywhere at all paints ground. A player
  who does nothing but drive in circles is scoring continuously. No task may
  add a scoring path that requires aim, timing, or a decision.
- **D2 — Zero text in gameplay.** No words on screen during a match, ever.
  Identity is colour + a simple animal glyph. Scores are proportional colour
  bars. A player who cannot read must lose no information whatsoever. (Menus
  outside a match may use text for the adult.)
- **D3 — No elimination, no spectating, no waiting.** There is no state in which
  a player is alive but cannot play, and no state where a player watches others
  play. Collisions never disable a kart.
- **D4 — No zero.** Every player finishes with visible territory. The round-end
  screen shows what each player painted; it never ranks anyone "last" and never
  shows the word LOSER.
- **D5 — Rounds are 90 seconds.** A bad round must be over quickly.
- **D6 — There are exactly TWO inputs: left and right.** Nothing else. No
  throttle, no brake, no jump, no handbrake, no trick, no combo, no menu during
  play. **Steering IS the throttle**: pointing down the fall line accelerates,
  turning across the slope scrubs speed — real skiing, and it means one axis
  delivers both speed and direction. Do not add a second control that duplicates
  what steering already does.
  This also makes the game playable on a tablet with two thumb zones (left half
  / right half), which matters more for a 4-year-old than any feature in this
  document, and it means the controls need no explanation at all (D2).
- **D7 — The skill ceiling lives in routing, not dexterity.** Overpainting an
  opponent's cell is what gives an adult something to think about (§3.4). It
  must never be *necessary* to score.

If a change would make the game better for an adult and worse for a
4-year-old, it does not ship.

---

## §2 Match shape

- Players 2–8. **Free-for-all**; every player is their own colour. No teams.
- Round length `ROUND_SECONDS = 90`. One round per match in v1.
- **A round is many runs, not one.** A player skis from the top to the bottom of
  the slope, is carried back to the top by a lift, and skis again — roughly 4–6
  runs in 90 seconds. **Paint persists across runs and across players for the
  whole round.** This is what restores the overpainting skill ceiling (§3.4)
  that a one-way descent would otherwise remove: later runs are about cutting
  across the lines your opponents already laid down.
- **The lift is automatic and fast** (~3s). It is not a minigame, it needs no
  input, and it must never strand a player. It is the only moment in the round
  where a player is not skiing, and it exists to make repeat runs possible —
  keep it short enough that a small child does not disengage.
- **The carve/straight tension is the adult's decision.** Carving wide paints
  more but takes longer, costing a run; straight-lining squeezes in an extra
  descent. A child who simply wobbles down is unaffected and still scores (D1).
- Lobby is manual-start, matching the existing repo contract used by all four
  current games: `{ t: 'start' }` accepted only when phase is lobby AND the
  minimum (2) is met, from any seated player, silently ignored otherwise,
  never throws. State carries seat count, minimum, and `canStart`.
- Sim runs at **30Hz** (`TICK_HZ = 30`). Driving is a continuous, felt input
  unlike a MOBA's discrete orders, so this is not the place to economise.
- Late joiners enter at the next round, not mid-round.

---

## §3 The paint grid — the core system

### 3.1 Representation

The arena floor is a uniform grid. `CELL_SIZE = 0.5` world units.

```ts
// Server, authoritative. One byte per cell.
// 0 = unpainted; 1..8 = the owning player's slot index + 1.
type PaintGrid = Uint8Array;   // length = gridW * gridH, row-major
```

Slot index, NOT player id — ids are strings and would not fit a byte. The slot
is stable for the life of the match and is what the wire and the client colour
lookup both use.

### 3.2 Painting is a SWEPT SEGMENT, never a point stamp

**This is the single most important rule in this document.**

Each tick, a kart paints every cell touched by the swept path from its previous
position to its current position, with a brush of radius `BRUSH_RADIUS`
(0.9 world units default). It does NOT stamp a disc at its current position.

Why this is not optional: at 30Hz a kart at 14 m/s travels 0.47 units per tick,
comparable to a cell. Point-stamping leaves a dotted trail with gaps that widen
with speed — **the faster you drive, the less you score**, which inverts the
entire design. It also makes fast play feel broken in a way that is hard to
diagnose after the fact.

Implement as a capsule (swept circle) rasterised over the cell grid. A test
must assert that a kart teleported across the arena in one tick paints a
**continuous** line of cells with no gaps, at several speeds and angles.

### 3.3 Ownership and the score

A cell has exactly one owner. Painting overwrites unconditionally. The server
maintains a per-slot count incrementally — `counts[old]--; counts[new]++` on
every change — and never rescans the grid to score. Rescanning 14k cells per
tick is both unnecessary and the obvious performance trap.

### 3.4 Overpainting is the skill ceiling

Driving over an opponent's cell converts it to yours. This is the entire depth
of the game for an adult and is invisible to a 4-year-old, which is exactly
right (D7). It must never be required to score.

### 3.5 The grid is NEVER broadcast whole

A 60×60 arena at 0.5 cells is 120×120 = 14,400 cells. Broadcasting that at 30Hz
is not viable.

- **Deltas only.** Each snapshot carries the cells that changed this tick, as
  `(index, slot)` pairs. Typical load is 10–40 cells per kart per tick.
- **Full grid on join and on round start only**, as a run-length-encoded blob.
- A client that misses deltas must be able to request a resync; design the
  message for it even if it rarely fires.
- Delta encoding must be measured, not assumed adequate. Report bytes/tick at
  8 players.

---

## §4 Vehicle sim

SPLAT does **not** import KART's sim, and this is deliberate. KART's handling is
tuned for racing — drift, boost, racing line — and a skier on a slope is a
different problem. Do not share its code; do borrow its netcode structure, which
already works in this repo.

- Server-authoritative, intent-only wire, shared pure sim.
- Client prediction + reconciliation, following KART's existing approach —
  continuous steering needs it and the pattern is proven here.
- **Gravity drives forward motion. Steering is the ONLY input** (D6). There is
  no throttle and no brake anywhere in the sim.
- **Speed is emergent from heading.** Acceleration scales with how closely the
  skier points down the fall line; turning across the slope sheds speed through
  edge friction. Pointing straight down is fastest and paints a thin line;
  carving wide is slower and paints far more. This IS the game's risk/reward and
  the whole of its skill ceiling — it must be tunable from one place, and it
  must be tuned by simulation before it is tuned by feel.
- **A skier never stops.** Minimum speed on any legal gradient is bounded above
  zero, so a player who holds one direction into a hard traverse still drifts
  downhill and still paints. Being stationary is a failure state (D1).
- **Skier-to-skier collisions are a soft nudge** and never disable a skier (D3).
  A child rammed by an adult must lose momentum, never control.
- **Trees and rocks are soft obstacles**: contact slows and deflects, it does
  not stop, crash, ragdoll, or reset. There is no wipeout state — a wipeout is
  an elimination by another name (D3).
- **The slope is bounded by soft edges** that steer a wandering skier back
  inward rather than stopping them. A 4-year-old who holds one direction for ten
  seconds must not end up pinned against a wall (D1).

---

## §5 Wire protocol

```ts
// Client -> server
| { t: 'input'; seq: number; steer: number }   // -1..1. THE ONLY INPUT (D6).
| { t: 'start' }
| { t: 'assist'; on: boolean }   // per-player, allowed at any time, incl. mid-round

// Server -> client
| { t: 'state'; tick: number; karts: KartState[]; counts: number[] }
| { t: 'paint'; cells: Array<[index: number, slot: number]> }
| { t: 'grid'; w: number; h: number; rle: number[] }   // join + round start
| { t: 'pickup'; id: number; x: number; z: number; taken: boolean }
| { t: 'round_end'; counts: number[] }
```

`counts` is indexed by slot and is the ONLY score representation on the wire.
Percentages are derived on the client. No text is ever sent as score.

---

## §6 Round flow

`lobby -> countdown(3s) -> live(90s) -> result(8s) -> lobby`

Countdown is a visual 3-2-1 with sound, no words. Result shows every player's
territory as a proportional bar with their glyph, largest first, with a crown
on the largest — and **nothing marking the smallest** (D4).

---

## §7 Assist mode

Per-player, toggleable at any time including mid-round, invisible to other
players. Intended to be switched on for a small child without announcing it.

Note that auto-throttle is NOT here — gravity already provides it for every
player, which is the main reason downhill was chosen. What remains:

- **Steering assist**: input is smoothed and the turn radius is widened, so
  jerky full-lock input still produces a usable carve.
- **Obstacle forgiveness**: tree and rock contact deflects more gently.
- **Edge forgiveness**: the soft slope edges push back harder, so a child
  holding one direction is curved back toward the middle sooner.
- **Brush bonus**: `BRUSH_RADIUS` × 1.25.

The brush bonus is a deliberate, quiet handicap. It is small enough to be
invisible in play and large enough to matter over 90 seconds. Do not surface it
in the UI, and do not announce which players have assist on.

---

## §8 Arenas

Three hand-authored slopes: a wide gentle beginner run, a medium run with tree
clusters, and a narrower steeper run. Vary gradient and obstacle density, not
total paintable area.

`validateSlope()` runs as a test and asserts:

- **The whole slope drains downhill** — no flat shelf or reverse gradient where
  a skier can come to rest and be stuck. A stuck 4-year-old is a failed round.
- **Every paintable cell is reachable** by a skier from the start line, using
  the ACTUAL movement rule rather than a generous approximation. See the
  Frostbite note in `docs/RIFT_HANDOFF.md` §5: a map in this repo was one-way on
  foot for its entire life because reachability was checked with the wrong rule.
- **No obstacle cluster fully blocks the width** — there is always a line
  through, at every altitude.
- **Paintable area within 10% across all three slopes**, so no slope is secretly
  bigger and no scoring comparison is silently unfair.
- **A skier who holds one steering direction for the entire descent still
  reaches the bottom** and is never pinned. Assert it by simulation, on all
  three slopes, in both directions. This is the 4-year-old, expressed as a test.

---

## §9 Client rendering

- The paint layer is **one texture on the ground plane**, updated from deltas —
  a `DataTexture` written per changed cell with a partial upload. It is NOT
  per-cell geometry, and it is NOT a full texture re-upload per frame.
- **Input surfaces: keyboard (left/right arrows or A/D) AND touch (left half /
  right half of the screen).** Touch is not optional and not a later port — a
  small child on a tablet is a primary target, and a two-zone tap layout is the
  easiest control scheme this game can have. Holding both, or neither, means
  going straight.
- Camera: elevated chase, ~40° down, **locked to the fall line, not to the
  skier's heading**. It always looks down the mountain. A child who turns
  sharply must never have the world swing around them — camera rotation is the
  fastest way to disorient a small player, and downhill was chosen partly to
  avoid it. Pull back far enough to read your own tracks behind you.
- A persistent minimap shows the whole slope's paint state — this is how the
  game communicates "who is winning" without words (D2).
- Colours come from a SPLAT palette that satisfies the repo's value-ladder law
  (`platform/shared/src/color.ts`, `VISUAL_UPGRADE.md`). Two extra requirements
  specific to this game: **all 8 player colours must be mutually distinguishable
  at a glance**, and each must clear the unpainted floor by a wide margin. This
  is stricter than any existing game in the repo — KART's red/orange/yellow
  liveries are a known confusable set and are NOT an acceptable model here.
  Verify under simulated protanopia and deuteranopia.

---

## §10 File ownership

To be assigned per task. `games/splat/{client,server,shared}/src`, following the
layout of `games/wordbomb/` (the cleanest example in the repo). Register the
module in `platform/server/src/registry.ts` — the only platform file permitted
to import a game.

**Add the test globs to `vitest.config.ts`.** Three suites in this repo have
silently never run because of a missing include. Verify collection explicitly;
do not assume it.

---

## §11 Gates

1. `node node_modules/typescript/bin/tsc --noEmit -p <workspace>`, invoked
   directly with `$?` captured. **Never trust `rtk` for a gate** — in this repo
   it has reported "No errors found" for a file with 6 real errors, returned
   exit 0 for failing runs, and swallowed an entire `npx vitest list` listing.
2. `npx vitest run` — the current floor is 1004 passing.
3. `npm run build` exit 0.
4. Every gate proven able to fail before its green is trusted.

Required evidence beyond unit tests:

- **The swept-paint continuity test** (§3.2) at several speeds and angles.
- **Measured delta bandwidth** at 8 players, bytes/tick.
- **A played match, verified on pixels.** Screenshot the arena mid-round and the
  result screen and LOOK at them. This repo has repeatedly shipped UI that
  passed every test while being completely invisible on screen.
- **The 4-year-old test, stated honestly:** simulate a player who does nothing
  but hold one steering direction for the entire round. Report its final share
  of the mountain, whether it ever got stuck, and how many runs it completed.
  If that player can finish with a near-zero share, the design law (§1) is
  broken and the tuning is wrong — not the test.
- **The sibling test:** simulate a competent player and the one-direction player
  in the same round and report the ratio. A 4-year-old losing is fine; a
  4-year-old finishing with a sliver next to a full mountain is not (D4).

---

## §12 Precedence

§1 design law > §3–§5 contract > §11 gates > this file's prose > any task's own
judgement. On conflict, stop and report.

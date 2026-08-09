# RIFT — mini MOBA: handoff

**Status: BUILT (branch rift-build, merged to main).** The game ships as
**ANCIENTS** at `/rift/` per the contract at `games/rift/CONTRACT.md`. The
sections below are the original handoff brief, kept for the reasoning.

Read `docs/STRUCTURE.md` for the repo layout and `docs/WORDBOMB.md` for the best
example of what a finished game contract in this repo looks like — WORDBOMB was
built contract-first and is the model to follow.

---

## 1. What this is

A small MOBA. Two teams push lanes, kill creeps for gold, buy items, destroy
towers, and win by destroying the enemy Ancient. The recognisable core of the
genre, deliberately not the full thing.

**Explicitly OUT of scope for v1:** neutral jungle camps, a Roshan equivalent,
denying, courier, backpack/stash, more than one map
archetype, ranked/MMR, cross-session persistence (there is no database and no
file storage anywhere in this project — the only persistence that exists
anywhere is the player's name in `localStorage`).

Item recipes and combining have since SHIPPED: upgraded items are bought by
combining their base components plus a recipe cost in gold, Dota-style (see
`games/rift/shared/src/item.ts`).

---

## 2. Decisions already made — and the reasoning, which matters more

These were reasoned through with the repo owner. Do not silently reverse one;
if you think a decision is wrong, say so and say why, then proceed.

### 2.1 Team size is variable, 2v2 to 8v8, and LOCKS at match start

The owner's requirement. It cannot change mid-match, because lane count is
derived from it (below) and you cannot grow a map underneath a running game.
**Late joiners take over a bot slot** rather than expanding the match — the FPS
in this repo already does exactly this and is worth reading first.

### 2.2 Lane count SCALES with team size

| team size | lanes |
|---|---|
| 2 | 1 |
| 3–4 | 2 |
| 5–8 | 3 |

**Why this is load-bearing, not cosmetic.** Eight heroes in one lane is a scrum
where nobody can last-hit; two heroes on a three-lane map is mostly walking.
Scaling lanes keeps every match size at roughly two heroes per lane, which is
the density that makes laning work at all.

It also silently solves a serious balance trap: **more players makes a MOBA
match LONGER, not shorter.** Creep gold is a fixed resource per lane, so adding
players divides income rather than adding it — everyone stays poor, nobody can
push, and the game sprawls. Big-team MOBA modes are notorious for this. Because
income is per-lane and lanes scale with players, income scales automatically and
no gold-rate fudging is needed. **If you ever decouple lanes from team size, this
problem comes straight back and you will have to solve it by hand.**

### 2.3 The map is GENERATED from lane count, not hand-authored

Square map, bases at opposite corners. 1 lane = the diagonal (mid); 2 lanes =
top and bottom around the edges; 3 lanes = top, mid, bottom. This is DOTA's
shape and it generalises cleanly. Map extent scales with lane count.

**Reuse the pattern that already exists**: `games/kart/shared/src/track.ts` has
`buildTrack(source)`, a `TRACKS` registry, and a `validateTrack()` that is run
as a test. Do the same — `buildMap(laneCount)` plus a `validateMap()` that
asserts connectivity, symmetry, and that both teams' paths are mirror-equal.
Map symmetry must be MEASURED, not assumed (see §5 on Frostbite).

### 2.4 Vision: the server owns the SET, the client owns the PIXELS

This is the one decision that is cheap now and expensive to retrofit, because it
shapes the wire protocol and the interpolation layer.

- **Server-side:** which entities a team can currently see. The snapshot sent to
  a client contains ONLY visible entities. If the server sends all entity
  positions and the client hides them, anyone with devtools has a permanent
  maphack — and in a MOBA, vision *is* the game.
- **Client-side:** all fog rendering — the shroud, soft edges, terrain
  darkening, "last known position" ghosts. This is where visual quality lives
  and it needs no server round-trip.

**Vision is a TEAM property, so it is computed twice per tick, not once per
player.** At 8v8 that is the difference between 2 and 16 filtered snapshots.

The cost is genuinely trivial and should not be designed around: ~76 entities ×
~30 vision sources per team ≈ 2,280 squared-distance checks per team, ~4,560 per
tick, ~91k/second at 20Hz. It also *saves* bandwidth — filtering typically cuts
a snapshot from 76 entities to 20–30.

**The hard part is not the filter, it is entities winking in and out.** The
client must handle an entity vanishing (leave a ghost at its last known
position, do not snap it to origin, do not interpolate toward a stale target)
and reappearing (do not interpolate from where it was five seconds ago). Budget
real time for this; it is where the bugs will be.

### 2.5 No client prediction at all

MOBAs have *deliberate* input latency — you issue an order, the server
acknowledges, the unit turns and moves. Unlike this repo's FPS, there is no
need for prediction, reconciliation, or lag compensation. **This removes the
single hardest part of the existing netcode.** Do not add prediction because
the FPS has it; it would be pure cost with no benefit.

Wire is intent-only: orders in, filtered snapshots out. Client interpolates.

### 2.6 Sim runs at 20Hz

Orders are issued, not aimed, so 30Hz buys nothing. The deploy target is a
512MB shared-cpu-1x fly.io machine already hosting four games. (Concurrency is
low — "only a few games at a time" — so this is headroom, not a constraint.)

### 2.7 Abilities are DATA, not code

A fixed set of effect primitives — damage, heal, stun, slow, dash, projectile,
aura, summon — composed declaratively. A hero becomes a data file, not a code
module.

**Why this is the difference between buildable and not:** it turns "six heroes ×
four abilities" from twenty-four engineering tasks into one engine task plus
content, and a seventh hero later costs nothing. Standard targeting trio:
no-target, point-target, unit-target.

### 2.8 Bot fill is CORE scope, not a nice-to-have

You need N humans or the game does not start, and on a link shared with friends
that will essentially never happen at the larger sizes. Bots must fill to make
teams even.

**MOBA bots are materially harder than the FPS bots in this repo** — lane
assignment, last-hitting, ability usage, knowing when to retreat. Read
`games/fps/server/src/bots.ts` first: it has a pure, deterministic, seeded
brain with preallocated BFS over a walkability grid, which is the right
foundation and the right discipline (no `Date`, no `Math.random`, no allocation
in `tick()`).

---

## 3. Decisions still OPEN — yours to make

Each of these was identified but not settled. They need to be frozen in the
contract BEFORE any implementation fans out.

1. **Hero roster and full ability specs.** ~6 heroes covering melee carry,
   ranged carry, tank/initiator, burst mage, support, assassin. This is where a
   MOBA's real complexity hides; an under-specified hero is the fastest way to
   get many agents building incompatible things.
2. **Level cap and ability ranks.** A shorter match suggests ~10 rather than
   DOTA's 30, with the ultimate unlocking mid-match.
3. **Item list** (~8, flat stats plus one or two actives) and shop rules.
4. **Tower count and stats per lane**, and Ancient guards.
5. **Wards.** Recommended IN — they are the key vision mechanic and cost little
   once the vision system exists. Jungle camps stay out.
6. **Match length target** and whether there is a hard cap / sudden death.
7. **Pathfinding approach.** Per-unit BFS will not scale to ~76 entities at
   20Hz. Flow fields per lane, or shared per-wave paths, are the likely answer.
8. **The game's user-facing name.** "RIFT" is a placeholder.

---

## 4. Repo conventions you must follow

**Layout.** `games/<name>/{client,server,shared}/src`. Look at
`games/wordbomb/` for the cleanest example: shared has
`config.ts / types.ts / protocol.ts / palette.ts / index.ts`, server has
`module.ts / room.ts / ports.ts`, client has `main.ts / game.ts / style.css`.

**Registration.** `platform/server/src/registry.ts` is the ONLY platform file
allowed to import a game. Add the module to the `GAMES` array; `net.ts` and
`lobby.ts` stay game-agnostic.

**Tests must be added to `vitest.config.ts`'s `include` globs.** Three suites in
this repo have silently never run because of a missing include. Note the fps
client include is `games/fps/client/src/render/**/*.test.ts` only — a test
placed elsewhere in that client is silently skipped. **Verify collection, do not
assume it.**

**Lobby contract.** All four existing games use manual start: a `start` message
accepted only when phase is lobby AND the minimum is met, from any seated
player, silently ignored otherwise, never throws. State carries seat count,
minimum, and `canStart`. Follow it.

**Colour discipline.** `VISUAL_UPGRADE.md` defines a value-ladder law enforced
by `valueLadder.test.ts` in each game, using `platform/shared/src/color.ts`
(`L()`, `hue()`, `hueDistance()`, `composite()`). Ground/wall/prop separations
are asserted in CIE L\*. A MOBA adds a hard new case: **team colours must stay
readable against terrain AND against fog-darkened terrain**, which is a second
surface set nobody has had to handle yet.

---

## 5. Hard-won gotchas — these cost real time to find

- **`rtk` cannot be trusted for any gate.** It has reported "No errors found"
  for a file with 6 real TypeScript errors, returned exit 0 for failing test
  runs, and silently swallowed an entire `npx vitest list` listing (returning
  `PASS (0) FAIL (0)`, a false negative). It also cannot handle `VAR=1 cmd`
  prefixes. **Invoke binaries directly and capture `$?` yourself**
  (`node node_modules/typescript/bin/tsc --noEmit -p <ws>`, `npx vitest run`),
  or wrap in `rtk proxy "..."`. Never read an exit code through a pipe.
- **Always prove a gate can fail before trusting its green.** Inject an error,
  confirm red, revert. This session caught multiple real defects that way, and
  every agent that skipped it shipped something wrong.
- **Reachability depends on which rule you measure with.** Frostbite was one-way
  on foot in all four lanes for its entire life: banks are 0.6 high, `stepUp` is
  0.42, and every step box faced one direction. It was invisible to every
  jump-apex check (0.870 > 0.6). A MOBA has no jumping, so **pathability must be
  measured with the actual movement rule**, and map symmetry must be asserted in
  both directions.
- **A documented invariant that was never measured is worse than none.**
  dustbowl's header asserted "longest sightline ≤ 42m" and every other map was
  held to it; it measures 66.85m, and the 42 was the map's spawn-to-spawn depth.
  If you write an invariant in a comment, write the test with it.
- **Verify feel and layout ON PIXELS.** Screenshot and look. This session, tests
  passed while a death card was completely hidden behind a banner, a damage
  flash was invisible due to CSS gradient sizing, and a match-point announcement
  rendered behind the buy menu every single time. **UI overlap bugs are
  invisible to unit tests**, and a MOBA HUD is far denser than anything here.
- **Beware coplanar faces in the renderer.** `bake()` merges by material, so
  coplanar quads land in different meshes and z-fight as the camera moves.
  `games/fps/client/src/contract/visual.ts` uses `COPLANAR_EPS = 0.006`;
  `coplanar.test.ts` is a permanent guard.
- **Balance claims must be simulated, not reasoned about.** Two separate
  economy tunings in this session were argued convincingly and measured wrong —
  including one that used the literal Counter-Strike ladder and made the losing
  team *richer*. Build the simulator first.

---

## 6. Repo state at handoff

- Branch `visual-upgrade`, at `f7bd331`, clean tree, pushed to GitHub.
- **1004 tests passing**, `tsc` exit 0 across 5 workspaces, `npm run build`
  exit 0, fps e2e 29/29 with 0 page errors.
- Deployed live at https://fmk-games.fly.dev/ (app `fmk-games`, region iad,
  `min_machines_running = 0` so the first request after idle is slow).
- Local dev: `npm run dev`, serves on :8080.
- **`main` is ~22 commits behind and has diverged from production.** Everything
  since the visual work lives on `visual-upgrade`. Unresolved; worth settling
  before adding a fifth game.
- Known open elsewhere: the FPS winner-side economy saturates at the 16000 cap
  by round 8; bot headshots run ~21% of hits against one-shot-kill rifles;
  `menus.showMatchEnd` is now dead code.

---

## 7. Suggested order of work

1. Freeze the full contract — §3's open decisions, the wire protocol, the
   ability primitive set, and the hero data schema. **Do not fan out until a
   hero can be written as data against a frozen schema**; that is the interface
   every content task depends on.
2. Map generation + `validateMap()` with symmetry and pathability asserted.
3. Sim core: entities, orders, movement, pathfinding, combat.
4. Vision system + filtered snapshots, with the appear/disappear cases tested.
5. Ability engine against the frozen primitive set.
6. Heroes and items as content, fanned out wide — one agent per hero.
7. Client: camera, click-to-move, fog rendering, HUD, shop.
8. Bots.
9. Balance simulation, then tuning.

Steps 5–6 are where the parallelism pays off. Everything before step 5 is
mostly serial and is where the thinking has to be right.

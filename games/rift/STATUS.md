# RIFT graphics build — resume state

Stopped 2026-08-07 on a weekly API usage limit, mid-flight. Three agents died in place.
This file is the handoff. Read `AMENDMENT_1/2/3.md` for the rulings they must obey.

## Where the tree actually is

| workspace | typecheck | tests |
| --- | --- | --- |
| `@rift/shared` | **EXIT 0** | green |
| `@rift/server` | 4 errors, all in `bots.ts` / `bots.test.ts` (S_BOTS, not yet run) | sim **255/255 EXIT 0** |
| `@rift/client` | 44 errors, 33 of them in `units.ts` (R_UNITS, in the fix wave) | — |
| client **build** | **BROKEN** | — |

> **Correction.** Earlier revisions of this file quoted "433/442" for the server. That number was
> mine and it was wrong — it corresponds to nothing measurable. `games/rift/server/src/sim` was
> 242 tests at the S_WORLD baseline and is 255 now; the whole server workspace was 299 and is 308.
> Quote the workspace you actually ran.

The client build fails with `MISSING_EXPORT`: `render/units.ts:37` and `render/mapMesh.ts:29`
still import `sceneCore` / `paintGeo` from `./scene.js`, which R_SCENE removed. R_UNITS and
R_MAPMESH are the only two blockers. Until they land, **no render module can be validated on
pixels** — which is why R_FOG could never measure its boot cost and R_FX's bloom numbers are
array-proven only.

## Open balance failures — a measured consequence of AMENDMENT_2 §A/§B

`balance.test.ts` is 2 red out of the server's 322. Both belong to **S_BALANCE** (Wave 3):

1. **`median match duration by Ancient kill is 12-18 min`** — moved **17.38 → 19.59 min**. This is
   caused by my own rulings, not a defect: §A (camp members immovable) and §B (out-of-combat
   reset) together make the jungle meaningfully harder to farm — no bulldozing a camp into a
   lane, no whittling one down for free from 9.5 m. Income is down, so matches run long.
   S_JUNGLE verified against the pre-change tree that this failure is new and attributed it
   correctly rather than letting it surface later as a mystery.
2. **`team gold divergence at 10 min is < 40%`** (41.1%) — already failing before that change.

S_BALANCE re-baselines both. Per `BUILD_SPECS`, determinism must not be weakened to get there:
if identical seeds stop producing identical matches, that is a real defect, not a threshold.

## The 9 failing tests, and who owns them

**(RESOLVED — all 9 fixed. Kept for the record.)**

**7 in `combat.test.ts` — cross-task, triggered by S_WORLD, owned by S_COMBAT.**
`neutral()` at `combat.test.ts:213` spawns a `campPack` and sets only `bounty` and `xpValue`,
never `hp`. It relied on `mobileTuning('campPack')` returning null and giving a small default.
S_WORLD **correctly** added the camp tunings that `AMENDMENT_2` §D.2 requires, so a camp now has
real `CAMP_PACK` health and the tests' 50 damage no longer kills it. The change is right; the
test's hidden dependency was wrong. Fix: the helper sets `hp`/`maxHp` explicitly.

**2 in `world.test.ts` — S_WORLD's own, item 7, not reached before it died.**
`dash … clamps to map bounds` and `clamps orders to the map bounds` both target `(0,0)`, which is
a cliff cell at 1, 2 and 3 lanes, so the hero legitimately stops at ~4.02 instead of 0. Per
`AMENDMENT_1` §C, `World.order` snaps to the nearest passable cell. Update both, and add a test
pinning the snap itself.

## What died mid-task

1. **S_WORLD** — got through ~97 insertions in `world.ts`. Camps wiring is present and **it
   cleared both blocking `camps.ts` errors**. It had NOT reached its test updates (item 7) or
   reported a mutation matrix. Resume from item 7.
2. **K_AMEND** (kit emissive path, typed `AnimPart`, transparent surfaces — `AMENDMENT_3` §A/B/C)
   — wrote **nothing**. Six modules are blocked on it. **This is the highest-priority resume.**
3. **The S_JUNGLE re-review** — confirmed exactly one real defect before dying, and it is a good
   one: `spawnCamp` set `e.lane = 0` where the spec requires `-1`. `e.lane` is what `movement.ts`
   and the wave logic key off, so a camp member marked lane 0 can be treated as a lane-0 creep.
   Corrected in `camps.ts:412`. **S_JUNGLE remains otherwise un-re-reviewed** — the merged
   camps/movement task is the single highest-risk unverified thing in the build.

## Order to resume in

1. **K_AMEND** — unblocks the four mesh modules, R_FX and R_FOG. Nothing else in the render
   layer should move first.
2. **The 12 client fix tasks** against the reviewers' file:line defect lists (130 defects).
   R_UNITS and R_MAPMESH are in this set and unbreak the client build.
3. **S_WORLD item 7**, and the `combat.test.ts` `neutral()` helper fix.
4. **S_JUNGLE re-review**, re-run with independent mutation verification.
5. S_BOTS, S_ROOM, S_BALANCE (Wave 3), then R_WIRE integration.
6. Only then the screenshot → judge → fix loop against `judge/reference/` (11 Dota 2 shots, ready).

## PENDING: merge `origin/main` (PR #6, rift-lobby)

`origin/main` moved to `ca1bc7e` — "un-invert edge scrolling, and close the four ways two
players could collide in the lobby". 12 files, **5 of which overlap this branch**:

`games/rift/CONTRACT.md`, `client/src/input.ts`, `client/src/ui/menus.ts`,
`server/src/room.ts`, `server/src/room.test.ts`

**Resolution: take UPSTREAM for all five.** This branch has no intentional work in any of them —
they are the 08-05 dirty files my `git add -A` swept into `14abcbd` (see housekeeping debt
below), and upstream is the finished version of that same work. `input.ts` upstream is +62/−11
against my accidental +16/−12; `menus.ts` is near-identical in size but diverged.

**Do this only when no agent is writing to the worktree.** Merging moves HEAD under running
agents — several are told to run `git diff --stat` to prove they left no stray edits, and
unrelated files in that diff produce false alarms or tempt an agent into touching a file it does
not own. `vitest.config.ts` also changed and agents run vitest continuously.

Prefer `git merge origin/main` over a rebase: a rebase rewrites every commit on this branch,
and the amendment/decision history in these commit messages is the build's audit trail.

After merging, re-run: shared typecheck, `games/rift/server/src` (expect 320/322, the 2 being
the balance cases above), and the client build.

## Housekeeping debt

- I used `git add -A games/rift` three times and swept unrelated dirty files into commits
  labelled as something else (`14abcbd` took eight files from 08-05; `5590826` took an agent's
  `__audit.test.ts` scratch file). **Commit explicit paths from here.** Not rewriting history —
  agents were writing to the tree concurrently and a rebase under them would be destructive.
- Agents leave scratch test files in the source tree (`__probe.test.ts`, `__audit.test.ts`, both
  now removed). Sweep `games/rift/**/__*.test.ts` before each commit.
- `scripts/rift-terrain-facts.mjs` is new and untracked — S_HARNESS deduplicating `terrainFacts`,
  a legitimate fix but outside its declared `Owns` list. Fold it into S_HARNESS's ownership.

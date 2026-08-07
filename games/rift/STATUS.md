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

## The 9 failing tests, and who owns them

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

## Housekeeping debt

- I used `git add -A games/rift` three times and swept unrelated dirty files into commits
  labelled as something else (`14abcbd` took eight files from 08-05; `5590826` took an agent's
  `__audit.test.ts` scratch file). **Commit explicit paths from here.** Not rewriting history —
  agents were writing to the tree concurrently and a rebase under them would be destructive.
- Agents leave scratch test files in the source tree (`__probe.test.ts`, `__audit.test.ts`, both
  now removed). Sweep `games/rift/**/__*.test.ts` before each commit.
- `scripts/rift-terrain-facts.mjs` is new and untracked — S_HARNESS deduplicating `terrainFacts`,
  a legitimate fix but outside its declared `Owns` list. Fold it into S_HARNESS's ownership.

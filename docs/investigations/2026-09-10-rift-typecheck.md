---
type: investigation
symptom: "rift typecheck red: derive.ts (2), derive.test.ts (1), module.variant.test.ts (8)"
slug: rift-typecheck
date: 2026-09-10T01:15:00-03:00
investigator: opencode
git_commit: d749fe5
branch: game-ports
repository: fkesheh/fmk-games
status: resolved
hypotheses_formed: 5
hypotheses_rejected: 2
hypotheses_proven: 3
related: []
---

# Rift typecheck red (derive + variant test)

## Symptom
- **Observed**: `npm run typecheck` fails in 3 workspaces; verbatim errors:
  ```
  ../../rift/client/src/audio/derive.ts:136:30 - error TS2322: Type 'EntTeam' is not assignable to type 'TeamId | null'.
  ../../rift/client/src/audio/derive.ts:628:13 - error TS2322: Type '{ readonly t: "rift_miss"; readonly attacker: number; readonly target: number; }' is not assignable to type 'never'.
  src/audio/derive.test.ts:75:3 - error TS2741: Property 'dayPhase' is missing in type '{ t: "rift_snap"; ... }' but required in type '{ readonly t: "rift_snap"; ... readonly dayPhase: number; ... }'.
  src/module.variant.test.ts:72:24 - error TS2353: Object literal may only specify known properties, and 'sent' does not exist in type 'FakeIo'.
  ```
  (plus 5 follow-on `sent`-does-not-exist errors in the same test file)
- **Expected**: full `npm run typecheck` green (repo gate).
- **Delta**: 13 errors across `@rift/client` (3), `@ancients/client` (2, same derive.ts via shared sources), `@rift/server` (8, test-only).

## Reproduction
1. `npm run typecheck > /tmp/tc3.log 2>&1` in `/Users/fkesheh/projects/fps-ports`
2. Strip ANSI, group `error TS` by workspace header (`> <pkg> typecheck`).
   Verified: 2026-09-10 — exactly the errors above, 3 workspaces, nothing else repo-wide.

## Hypotheses

#### H1: E136 is a real domain bug — neutral-team entities leak into a per-team index
- Layer: code-logic
- Prediction: If true, `teamOfPid` callers index per-team structures with the result, and neutral (`2`) entities exist on board/ents.
- Verification method: read `games/rift/shared/src/types.ts:28-45`, `derive.ts:131-137,567`.
- Evidence:
  ```
  games/rift/shared/src/types.ts:15: export type TeamId = 0 | 1;
  games/rift/shared/src/types.ts:37: export type EntTeam = TeamId | 2;
  games/rift/shared/src/types.ts:39-41: /** The narrowing guard ... True for the two player teams,
  games/rift/shared/src/types.ts:43-45: export function isPlayerTeam(t: EntTeam): t is TeamId {
  games/rift/client/src/audio/derive.ts:131: function teamOfPid(snap: SnapMsg, pid: string): TeamId | null {
  games/rift/client/src/audio/derive.ts:567: const team = teamOfPid(snap, ev.victim);
  ```
  Plus the codebase rule at types.ts:32-36: "Every site that indexes a per-team tuple ... MUST narrow with `isPlayerTeam` first. No exceptions, no `as TeamId` casts."
- Verdict: PROVEN
- Rationale: `BoardEntry.team`/`EntSnap.team` are `EntTeam` (nullable neutral `2`); the function promises `TeamId|null` without narrowing. The sanctioned fix is `isPlayerTeam`, not a cast.

#### H2: E628 means the wire gained an event the audio layer never mapped
- Layer: dependency (shared protocol evolved under the client)
- Prediction: If true, `RiftEvent` contains a `rift_miss` member and `deriveWire` has no case for it.
- Verification method: read protocol.ts RiftEvent + room.ts:906 + derive.ts switch.
- Evidence:
  ```
  games/rift/server/src/room.ts:906: const wire: RiftEvent = { t: 'rift_miss', attacker: ev.attacker, target: ev.target };
  games/rift/shared/src/protocol.ts: RiftEvent = ... | { readonly t: 'rift_cast'; ... } /** An uphill basic attack that missed ... */
  games/rift/client/src/audio/derive.ts:610-629: cases rift_pick/rift_roster/rift_end then `default: { const _exhaustive: never = ev; ... }`
  games/rift/client/src/audio/contract.ts:149-171: AudioEvent has cast/attack/hit/hurt/... — no miss tag; 'attack is the swing' (from EntSnap.atk), 'hit is the impact' (from hp decrease)
  ```
- Verdict: PROVEN
- Rationale: exhaustive switch + new union member = `never` assignment fails. Semantically the miss needs no cue: the swing already sounded via `attack`, and the absent `hit` IS the miss signal — `[]` is the correct mapping, not a new AudioEvent tag (which would ripple into cues/engine).

#### H3: E75 is a stale test fixture (protocol added dayPhase, fixture not updated)
- Layer: state-data (test fixture vs evolved protocol)
- Prediction: If true, `SnapMsg` requires `dayPhase` and `makeSnap` omits only that field.
- Verification method: read protocol.ts:74-95 vs derive.test.ts makeSnap.
- Evidence:
  ```
  games/rift/shared/src/protocol.ts:79-87: readonly dayPhase: number; // 0 = full day, 1 = full night ... Always present
  games/rift/client/src/audio/derive.test.ts:66-82: makeSnap returns { t, tick, serverTime, phase, matchTick, overtime, wardStock, kills, board, you, ents } — no dayPhase
  ```
  (The "4 more" in the TS message are wardStock/kills/board/you/ents, all present — only dayPhase missing.)
- Verdict: PROVEN
- Rationale: day/night cycle (config.ts:405-423) added a required wire field; the fixture predates it. Fix in fixture with deterministic `dayPhase: 0` (full day).

#### H4: The variant-test errors are fallout from the p2pShell module edit
- Layer: code-logic (my own change broke the test's types)
- Prediction: If true, the errors reference something my diff touched (VariantOpts, createRoom, RoomIO shape).
- Verification method: read the error sites + my diff; check imports of the failing file.
- Evidence:
  ```
  src/module.variant.test.ts:50-70: interface FakeIo { io: RoomIO; report: ... } — no `sent` member; fakeIo() returns { io, report, sent }
  git diff games/rift/server/src/module.ts: import +p2pShellRoom, interface +p2pShell, createRoom branch — none touch FakeIo/RoomIO/test file
  failing test files import: vitest, @rift/shared (types), @platform/shared (types) — neither imports module.ts
  ```
- Verdict: REJECTED
- Rationale: the mismatch is entirely inside the test file (interface vs its own factory return); no type flows from my edit into it. Pre-existing.

#### H5: The errors are phantom toolchain damage (like the earlier ws corruption)
- Layer: tooling-build
- Prediction: If true, errors would reference missing modules/unresolvable imports, and would vanish after `npm install`.
- Verification method: `npm install` already ran during env repair; re-ran scoped + full typecheck after.
- Evidence:
  ```
  $ npx tsc --noEmit -p games/rift/client  → exit 0 (its own tsconfig is lenient/different include)
  $ npm run typecheck -w @rift/client      → same 3 errors persist post-install
  errors cite concrete type mismatches (EntTeam vs TeamId, missing dayPhase, excess `sent`), not resolution failures
  ```
- Verdict: REJECTED
- Rationale: errors persist with a healthy tree and are all semantic, not resolution, failures. (H5 did explain the EARLIER transient derive errors seen from the corrupted tree, but not these.)

## 5 Whys
Symptom:  rift typecheck red (13 errors, 3 sites + 1 test file)
Why 1?    Because shared protocol/types evolved (EntTeam neutral, rift_miss event, dayPhase field) while consumers froze.
Why 2?    Because each evolution shipped without updating all consumers: audio derive (miss case, neutral narrowing), audio test fixture (dayPhase), variant test (FakeIo.sent).
Why 3?    Because the repo's typecheck gate runs per-workspace and full-repo red is tolerated while other games move (green-scoped-gates culture).
Why 4?    Because no CI gate blocks merge on full `npm run typecheck` for the whole monorepo.
Why 5?    Because the branch strategy (long-lived feature branches per game) defers integration hygiene to port-integration time — i.e., now.

## Falsification
- Check performed: adjacent-cause search — could ONE root cause (e.g. a shared-types refactor commit) explain all four sites, making per-site fixes wrong? Searched: EntTeam/neutral predates (types.ts documents the guard as established convention); rift_miss came with terrain uphill-miss (room.ts:906, TERRAIN_CONTRACT §4); dayPhase came with the day/night cycle (config.ts:405); FakeIo.sent is test-local. Four independent evolutions, four independent consumer lags — no single cause. Also absence test for H4: the same errors occur with my module edit reverted by inspection (no import edge) — fails to break the pre-existing verdict.
- Conclusion: hypothesis set survived.

## Root Cause
- Immediate causes: (1) `teamOfPid` returns un-narrowed `EntTeam` as `TeamId` (evidence: types.ts:37,43 + derive.ts:131); (2) `deriveWire` lacks `rift_miss` case for an exhaustive switch (evidence: room.ts:906 + derive.ts:628); (3) test `makeSnap` omits required `dayPhase` (evidence: protocol.ts:79 + derive.test.ts:66-82); (4) `FakeIo` interface omits `sent` its factory returns (evidence: module.variant.test.ts:50-70).
- Architectural root: protocol evolution without consumer updates + no full-repo typecheck gate on merge.
- Rejected H4 (my edit — no type edge), H5 (persists post-repair; semantic not resolution errors).

## Fix
- `derive.ts teamOfPid`: narrow with `isPlayerTeam`, return null for neutral (sanctioned per types.ts:32-36).
- `derive.ts deriveWire`: add `case 'rift_miss': return [];` (swing already sounded; absent hit is the signal; no new AudioEvent tag).
- `derive.test.ts makeSnap`: add `dayPhase: 0`.
- `module.variant.test.ts FakeIo`: add `sent: Array<{ id: string; msg: unknown }>;`.

## Resolution
- Diff summary: `derive.ts` — `isPlayerTeam` narrowing in `teamOfPid`, new
  `case 'rift_miss': return [];`; `derive.test.ts` — `dayPhase: 0` fixture +
  new rift_miss regression test; `module.variant.test.ts` — `sent` field on
  `FakeIo`, dropped stray 2nd arg at :218.
- Verification: `tsc` 0 errors on @rift/client, @rift/server,
  @ancients/client; derive.test.ts 21/21; module.variant.test.ts green;
  miss test fails on stashed (unpatched) derive.ts, passes patched.
- Follow-up: consider a full-repo typecheck CI gate (5 Whys Why-4).


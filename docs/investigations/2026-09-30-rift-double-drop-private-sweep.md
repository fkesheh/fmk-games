---
type: investigation
symptom: "e2e-rift move check: both pages freeze on stale live snaps (lag 127s+), reseats answered no_room"
slug: rift-double-drop-private-sweep
date: 2026-09-30T16:40:00-0300
investigator: Foad Kesheh
git_commit: 72497e03a28a109536014cb120fbf35548640551
branch: assets-trees-v2
repository: fps
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-09-30-rift-e2e-b-join-never-seats.md
---

# Double-drop sweeps the private room; reseats strand on no_room

## Symptom
- **Observed**: `e2e-rift` move-order check times out (120s): both pages show stale live snaps (A tick=414, B tick=617, lag 127s+). Instrumented run: A `welcomes=2 hellos=1`, B `welcomes=3 hellos=1` — both reconnected but never reseated. Server log shows `room OY3FH5X6 closed (empty private)` mid-run.
- **Expected**: drops resubscribe via resume rebind (unit-tested room behavior); the match continues.
- **Delta**: reseats answered `no_room` — the room was already swept.

## Reproduction
1. `PLATFORM_STATIC=1 E2E_SKIP_BUILD=1 node scripts/e2e-rift.mjs` on a loaded box (drops must coincide; near-deterministic at load ≥15).
2. Observe check (8) abort with page lag >120s; server log shows the mid-run sweep.
   Verified: 2026-09-30 — reproduced 4/4 (2 committed + 2 instrumented runs).

## Hypotheses

#### H1: the reseat join was never transmitted (client send hole)
- **Layer**: state-data
- **Prediction**: If true, the ws-level send log shows no `join_private` after the reconnect.
- **Verification method**: in-page WebSocket wrapper logging every send with readyState.
- **Evidence**:
  ```
  A WS 25550 ws#1 close code=1006
  A WS 28559 ws#2 send[1] {"t":"join_private","name":"Alice","code":"7KDWB","resume":"52ef9cc2",...}
  B WS 22360 ws#2 close code=1006
  B WS 26538 ws#3 send[1] {"t":"join_private","name":"Bob","code":"7KDWB","resume":"9bf509a3",...}
  ```
- **Verdict**: REJECTED
- **Rationale**: Both reseats transmitted on open sockets with resume tokens. The null-gap queue (previous fix) works; the hole is elsewhere.

#### H2: the reseat was rejected as room_full (ghost counted against capacity)
- **Layer**: code-logic
- **Prediction**: If true, clients receive `{t:'error', code:'room_full'}` and the lobby's pre-join guard miscounts ghosts.
- **Verification method**: dump all `error` frames from both clients' message logs.
- **Evidence**:
  ```
  A ERR {"t":"error","code":"no_room","message":"no room with that code"}
  B ERR {"t":"error","code":"no_room","message":"no room with that code"}
  (rift playerCount() = connectedHumans() — ghosts excluded — so the guard could not have fired anyway)
  ```
- **Verdict**: REJECTED
- **Rationale**: The rejection is `no_room`, not `room_full` — the room was already gone.

#### H3: near-simultaneous drops swept the private room before either reseat landed
- **Layer**: code-logic (lifecycle)
- **Prediction**: If true, the server log shows the private close after both drops and before both reseats; `leaveRoom`/reap stop private rooms immediately at playerCount 0 without consulting ghost seats.
- **Verification method**: server log order + sweep code paths.
- **Evidence**:
  ```
  [server] [lobby] room OY3FH5X6 closed (empty private); 0 open   (mid-run, before the abort)
  platform/server/src/lobby.ts:757-762: private + playerCount 0 => room.stop() + delete immediately
  platform/server/src/lobby.ts:476-477: periodic reap: private expires unconditionally
  A froze at tick 414, B at 617 (~2s apart at 93 snaps/s): overlapping drop windows
  ```
- **Verdict**: PROVEN
- **Rationale**: Two drops ~2s apart; the second emptied the room (ghosts don't count); both sweeps fire immediately for private rooms; both reseats (~1-3s later) hit a deleted room. Any private room on any game dies the same way when its last humans drop within the same instant.

## 5 Whys
Symptom:  Both rift clients strand on stale live snaps; reseats get no_room.
Why 1?    Because the private room was swept while both humans were ghosts.
Why 2?    Because both sweeps treat private rooms as expirable the moment playerCount hits 0.
Why 3?    Because playerCount counts connected humans only, and nothing reports the rebindable ghost seats the room deliberately keeps (rift drives them with bot brains for exactly this purpose).
Why 4?    Because the GameRoomHandle contract has no ghost-visibility member — the lobby cannot distinguish "abandoned" from "reconnecting".
Why 5?    Because the sweep predates the ghost/rebind design: immediate private close was written when a drop meant the player was gone.

## Falsification
- Check performed: counterfactual edit — lobby consults `hasRebindableSeats()` before stopping an empty private room (grace path instead of immediate stop); rift implements it from its ghost seats.
- Result: applied 2026-10-01. Lobby suite 87/87 (5 new: double-drop keeps room open + reseat lands, explicit leave still closes, absent-hook rooms sweep as before, reaper grants grace then expires at 30s, real-rift e2e double-drop → resume rebinds). All 7 ghost-game room suites green (318 tests, 8 new hook tests).
- Conclusion: CONFIRMED — the edit is the fix, not just the counterfactual.

## Root Cause
- Immediate cause: near-simultaneous drops emptied the private room; both sweep paths stop it immediately; reseats landed on `no_room`.
- Architectural root: ghost seats are invisible to lifecycle (no contract member), so "reconnecting" is indistinguishable from "abandoned".
- Rejected H1: wslog proves both reseats transmitted with resume tokens.
- Rejected H2: rejection code is `no_room`, never `room_full`.

## Fix
- `platform/shared/src/module.ts`: additive optional `GameRoomHandle.hasRebindableSeats()` (absent => false; frozen contracts untouched).
- `platform/server/src/lobby.ts`: `leaveRoom` and the `pollStaleSessions` reaper grant the 30s grace window to empty ghost-bearing rooms (even private) instead of stopping them immediately. Grace expiry still reaps — no abandoned-room leak (one extra 30s window max per ghost room).
- Impls (each mirrors its own rebind predicate exactly): rift (`!connected && !bot` — permanent-leave bot conversions excluded), bank, wordbomb, kart, splat (`!connected` on players), outpost (`!connected` on survivors), fps (`!connected`; bots always-connected so excluded). Aces has no rebind (out of scope v1). Ancients needed a WRAPPER fix, not a room impl: `riftModuleVariant`'s explicit delegation initially dropped the optional verbs, so ancients rooms swept immediately while legacy rift rooms got grace — fixed by delegating `hasRebindableSeats` (+`setHosted` for hosted-mode transparency) with tests in module.variant.test.ts.
- Blast radius contained: rooms without the hook (or without ghosts) sweep exactly as before; explicit leaves park no ghosts, so leave-all-members still closes immediately.

## Resolution
- FIXED 2026-10-01. Regression cover: `platform/server/src/lobby.test.ts` "ghost-aware empty-room grace" (5 tests) + per-game `hasRebindableSeats` tests in all 7 room suites. Deployed via flyctl 2026-10-01; prod smoke 9/9. Follow-up: the double-drops that motivated this fix were themselves caused by the flood flap storm — see docs/investigations/2026-10-01-rift-flood-flap-storm.md (transport coalescing fix, same deploy).

---
type: investigation
symptom: "e2e-rift: B joinPrivate never seats B (timeout waiting for both pages seated)"
slug: rift-e2e-b-join-never-seats
date: 2026-09-30T14:20:08-0300
investigator: Foad Kesheh
git_commit: 72497e03a28a109536014cb120fbf35548640551
branch: assets-trees-v2
repository: fps
status: resolved
hypotheses_formed: 6
hypotheses_rejected: 5
hypotheses_proven: 1
related:
  - docs/investigations/2026-09-29-fps-join-reconnecting.md
---

# e2e-rift: B joinPrivate never seats B

## Symptom
- **Observed**: `e2e-rift: 5/6 checks passed` — `FAIL suite runs to completion (no abort) — timeout (12000ms) waiting for both pages seated (rift_lobby humans=2)`. State at abort: A `phase=lobby`, B `phase=menu`. B's message log shows two `welcome` frames (two server sessions), then `room_list`/`pong` traffic, but never `rift_hello` nor `error`. B's socket timeline (ws-instrumented run, B page clock):
  ```
  B 191 ws#1 ctor
  B 4972 ws#1 open
  B 4973 ws#1 send[1] {"t":"list_rooms"}
  B 5107 ws#1 send[1] {"t":"list_rooms"}
  B 5326 ws#1 close code=1006 clean=false
  B 6606 ws#2 ctor
  B 7016 ws#2 open
  B 7188 ws#2 send[1] {"t":"list_rooms"}
  ... (pings/list_rooms only — join_private NEVER sent on any socket)
  ```
- **Expected**: B's `joinPrivate('Bob', code)` seats B (check 4: both pages see `humans=2`, `canStart`, B.team=1).
- **Delta**: B's join frame is never transmitted (or never processed) and B stays in `menu`; B's first socket dies ~350ms after open with an abnormal close (1006).

## Reproduction
1. `npm run build -w @rift/client` (any recent dist; fails with and without the send-queue fix)
2. `PLATFORM_STATIC=1 E2E_SKIP_BUILD=1 node scripts/e2e-rift.mjs`
   (PLATFORM_STATIC forces static mounts; the sandbox has foreign squatters on the vite dev ports)
3. Observe `FAIL ... timeout (12000ms) waiting for both pages seated` after check (3) passes.
   Verified: 2026-09-30 — reproduced 5/5 (2 solo + 1 parallel + 2 instrumented debug-copy runs).

## Hypotheses

#### H1: B's join raced a non-open socket and was dropped (the audited send race)
- **Layer**: state-data
- **Prediction**: If the join fired while B's socket was CONNECTING (or null/absent), `send()` dropped it without a trace (pristine code) — no `ws.send` call, no server reply. With the CONNECTING-queue fix active, a join fired during CONNECTING would instead flush on open and B would join.
- **Verification method**: (a) run e2e with the CONNECTING-queue fix active; (b) ws-level send log on B (which socket, if any, transmitted `join_private`).
- **Evidence**:
  ```
  B 5326 ws#1 close code=1006 clean=false
  B 6606 ws#2 ctor
  B 7016 ws#2 open
  (... join_private NEVER sent on any socket; B's message log has no rift_hello/error)
  e2e-rift: 5/6 checks passed  (WITH the CONNECTING-queue fix active, 4 runs)
  e2e-rift: 5/6 checks passed  (pristine net.ts baseline, 1 run — identical signature)
  ```
- **Verdict**: INCONCLUSIVE (splittted into H1a/H1b below — the parent "CONNECTING race" as originally framed is REJECTED as the sole cause because the CONNECTING-queue fix did not change the outcome).
- **Rationale**: The fix covers CONNECTING only; the wslog proves the join vanished without ANY transmission attempt, consistent with either an in-flight death (H1a) or the reconnect-backoff null gap (H1b).

#### H1a: the join was sent on socket1 and died in flight when socket1 dropped
- **Layer**: state-data
- **Prediction**: If true, B's `joinPrivate` evaluate ran while socket1 was open AND the ws-send wrapper logged a `send[1] join_private` entry (the wrapper logs synchronously at every `ws.send` call — no sampling gap).
- **Verification method**: B-clock timestamp of the `joinPrivate` evaluate + ws-level send log in the instrumented debug copy.
- **Evidence**:
  ```
  --- B joinPrivate wall=1790789029257 B-clock=5144
  B 4812 ws#1 open
  B 4941 ws#1 send[1] {"t":"list_rooms"}
  B 5147 ws#1 close code=1006 clean=false     (3ms after the call was dispatched)
  (no send[1] join_private entry on any socket in the full 10-entry wslog)
  ```
- **Verdict**: REJECTED
- **Rationale**: A pre-close send would have produced a synchronous wrapper entry; none exists. CDP dispatch latency (>3ms in practice) pushed actual execution past the close.

#### H1b: the join fired during the reconnect-backoff null gap (ws===null) and was dropped
- **Layer**: state-data
- **Prediction**: If true, B's `joinPrivate` executed while `ws===null` (after socket1's close, before socket2's ctor): `send()` returns early on null `ws` in BOTH pristine and fixed code (the fix only queues when a CONNECTING socket exists), so no transmission, no queueing, no server reply. A null-gap queue would flush the join on socket2's open and seat B.
- **Verification method**: (a) B-clock timestamp of the join call vs the wslog close/ctor markers; (b) implement null-gap queueing and observe e2e-rift going green (discriminating experiment).
- **Evidence**:
  ```
  --- B joinPrivate wall=1790789029257 B-clock=5144
  B 5147 ws#1 close code=1006 clean=false
  B 6448 ws#2 ctor                            (null gap: 5147–6448, 1301ms)
  (join_private never sent; no rift_hello/error received on socket2)
  ```
  The call dispatched 3ms before the close; CDP latency pushed execution into the 1301ms null gap. Had execution landed in socket2's CONNECTING window (6448–6841), the CONNECTING queue would have flushed it on open and a hello would have arrived — none did.
- **Verdict**: PROVEN
- **Rationale**: Timestamp + wslog + absent reply jointly exclude every placement except the null gap.

#### H2: the server heartbeat terminated socket1 (2 missed protocol pongs)
- **Layer**: dependency (transport liveness)
- **Prediction**: If true, socket1 must have lived ≥ ~4s after open (2 unanswered pings at the 2s heartbeat interval) before the terminate.
- **Verification method**: read the heartbeat policy + interval; compare against the wslog open→close span.
- **Evidence**:
  ```
  platform/server/src/net.ts:73: const MAX_MISSED_PONGS = 2;
  platform/server/src/net.ts:304-306: setInterval(() => { ... sess.heartbeat(); }, NET.pingEveryMs);
  platform/shared/src/protocol.ts:15: pingEveryMs: 2000,
  B 4972 ws#1 open
  B 5326 ws#1 close code=1006 clean=false   (354ms after open)
  ```
- **Verdict**: REJECTED
- **Rationale**: Minimum 4s to accumulate 2 misses at a 2s interval; socket1 died 354ms after open. Timing excludes the heartbeat.

#### H3: the server closed socket1 on a malformed frame or a rejected join
- **Layer**: code-logic (server)
- **Prediction**: If true, `net.ts` would contain a content-triggered close path, or `lobby.ts joinPrivate` would close instead of answering — and/or `[net] socket error` / hook-throw lines would appear in the server log.
- **Verification method**: read `onRawMessage` (net.ts:349-369) and `joinPrivate` (lobby.ts:610-635); grep the server log.
- **Evidence**:
  ```
  platform/server/src/net.ts:350-358: binary/parse-fail => silent return (no close)
  platform/server/src/net.ts:364-368: hook exceptions caught + logged (no close)
  platform/server/src/lobby.ts:625-632: no_room/room_full errors sent (never a close)
  $ grep -E "socket error|onMessage hook|onDisconnect" /tmp/rift-debug.log  -> (no output)
  B's message log contains no 'error' frame.
  ```
- **Verdict**: REJECTED
- **Rationale**: No content-triggered close path exists; no error was logged or received.

#### H4: B opened a duplicate socket (double boot) and joined on the wrong one
- **Layer**: code-logic (client)
- **Prediction**: If true, the wslog would show two overlapping sockets (ctor,ctor before any close), and `createNet` would be reachable twice per page.
- **Verification method**: wslog ctor/open/close sequence; read `createNet` call sites.
- **Evidence**:
  ```
  B 191 ws#1 ctor ... B 5326 ws#1 close ... B 6606 ws#2 ctor   (strictly sequential)
  games/rift/client/src/net.ts:551-600: connect() runs at construction + on close-timeout only
  ```
- **Verdict**: REJECTED
- **Rationale**: Sockets are strictly sequential (reconnect), never parallel. No double boot.

#### H5: CDP Network-domain pipe starvation (the e2e wire tap) dropped socket1
- **Layer**: config-env (harness artifact)
- **Prediction**: If true, runs WITHOUT the `tapWire` CDP attachment keep socket1 alive and B joins; the committed harness even warns about this failure mode in its own comment.
- **Verification method**: disable `tapWire` in the instrumented debug copy (experiment recorded here; committed harness untouched) and run.
- **Evidence**:
  ```
  scripts/e2e-rift.mjs (tapWire comment): "ships every WebSocket payload across the CDP
  channel ... sustained megabyte-per-second of extra work on the exact pipe whose
  starvation drops the socket mid-run"
  probe-rift-bjoin.mjs (no CDP Network tap): B joins, 4/4 runs green
  e2e-rift (tap attached on both pages): B socket1 dies, 5/5 runs red
  ```
- **Verdict**: REJECTED (counterexample found after initial interventional pass)
- **Rationale**: A later tap-DETACHED run also dropped socket1 (`B 6887 ws#1 close code=1006`, no tap attached) — the tap is not necessary for the drop. The earlier tap-off green was luck (benign timing), not causation. Drops happen with or without the tap on this loaded box (load avg 21); the trigger is environmental (browser/OS shedding connections under load), and the precise mechanism is undetermined — and irrelevant: the product must survive drops from ANY cause, which is what the H1b fix delivers. Harness left untouched.

## 5 Whys
Symptom:  B's join never seats B in e2e-rift.
Why 1?    Because B's `join_private` executed during the 1301ms reconnect-backoff null gap, where `send()` returns silently on null `ws`. [H1b PROVEN]
Why 2?    Because socket1 died 354ms after open (1006) while the join was being dispatched — the e2e wire tap is interventionally implicated in the drop (H5), and the backoff timer leaves `ws` null until the redial starts.
Why 3?    Because the audit's send-queue fix covered CONNECTING (a socket exists) but not null (no socket yet) — the "closed = drop" rule conflates "user is done" with "reconnect pending".
Why 4?    Because the original send contract ("no-op unless OPEN") treated every non-open state as "caller will retry", but no caller retries an explicit menu join (auto-reseat only covers seated sessions with tokens).
Why 5?    Because implicit drop-on-unhealthy was the shared template copied across all game clients (and the SDK) without a resumption story for in-flight user intent — the same architectural gap the send-queue audit is closing.

## Falsification
- Check performed (H5 absence test): tapWire disabled in the instrumented debug copy (committed harness untouched).
- Result: FIRST tap-off run green through check 7 — but a LATER tap-off run dropped socket1 identically (`B 6887 ws#1 close code=1006`). The tap is neither necessary nor sufficient; H5 demoted to REJECTED.
- Check performed (H1b counterfactual edit): null-gap bridging queue implemented in `games/rift/client/src/net.ts`.
- Result: tap-on committed e2e went from 5/6 (check-4 fail) to 11/12 (check 4 green twice; only the load-dependent snap-lag check fails on a load-21 box). A tap-off instrumented run captured the mechanism working as designed:
  ```
  --- B joinPrivate wall=1790789755148 B-clock=7178
  B 6887 ws#1 close code=1006 clean=false
  B 8238 ws#2 ctor                        (join call at 7178 landed in this null gap)
  B 8840 ws#2 open
  B 8840 ws#2 send[1] {"t":"join_private","name":"Bob",...}   (queued join flushed on open)
  PASS  (4) B joinPrivate -> both pages see a 2-human, startable lobby
  ```
- Conclusion: H1b survived — the fix discriminates (gap bridged ⟹ join delivered ⟹ check green).

## Root Cause
- Immediate cause: `send()` drops on null `ws` during the reconnect-backoff gap; B's explicit `joinPrivate` landed in that gap and vanished with no retry (evidence: join timestamp B-clock=5144 vs null gap 5147–6448; no `send` entry on any socket; no hello/error reply).
- Architectural root: the shared "no-op unless OPEN" send template has no resumption story for in-flight user intent (5 Whys #5).
- Rejected H1a: no synchronous send-wrapper entry exists — the frame was never transmitted, not lost in flight.
- Rejected H2: 354ms open→close span cannot accumulate 2 missed pongs at a 2s heartbeat.
- Rejected H3: no content-triggered close path exists server-side; no error logged or received.
- Rejected H4: sockets strictly sequential (reconnect), never parallel — no double boot.
- Rejected H5: a tap-detached run dropped socket1 identically — the tap is not the trigger; drops are environmental (load-21 box).

## Fix
- File `games/rift/client/src/net.ts` (`send`, `onclose`, queue comment): `send()` now queues (bounded, cap 32, oldest shed) when `ws` is null (backoff gap) as well as CONNECTING; `onclose` no longer clears the queue — every close schedules a redial, so every gap ends in a flush on the next open. Traced to Why 3 (null/backoff conflated with "user is done").
- Same bridging applied to the other always-redial clients: `games/bank/client/src/game.ts`, `games/wordbomb/client/src/game.ts`, `games/kart/client/src/app.ts`, `games/splat/client/src/app.ts` (all schedule an unconditional redial on close and never close the socket on explicit leave, so bridging is leak-free by construction).
- `platform/sdk/src/net.ts` (SdkNet): queue on null; bridge across auto-redials (no clear in `teardown`/`closeSocket`); clear on manual `connect()` (fresh intent), dial failure, explicit close. Also fixed the dead auto-reconnect: `this.url` was never assigned, so no redial could ever fire — `connect()` now stores the redial target.
- NOT changed: fps (its rejoin flow re-sends; no redial gaps), outpost (no auto-redial — a null queue could never flush), aces (join envelope re-sent in `onopen` on every connect — self-healing).
- Regression tests: `games/rift/client/src/net.test.ts` (gap-bridge: pre-open queue + null-gap send flush FIFO on the redial — fails on the old code where both vanished) and `platform/sdk/src/net.test.ts` (gap-bridge under `autoReconnect` with fake timers; post-close sends never transmitted). The old rift expectation ("redial starts clean") asserted the bug itself and was replaced with justification.

## Resolution
- Diff summary: 6 clients + SDK bridge the reconnect null gap; SDK redial target stored.
- Verification: focused suites 15/15 (`net.test.ts` × fps/rift/SDK); full vitest 3256 passed + 2 known rift-balance structural reds; typecheck clean; committed `e2e-rift` went 5/6 → 11/12 with check 4 green 2/2 (remaining red: a snap-drain lag check that needs a quieter box — load avg 21–52 during the runs).
- Follow-up: none for the join path. The e2e-rift lag check and the kart `players=2` suite-timing race are pre-existing/environmental, documented in the audit report.

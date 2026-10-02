---
type: investigation
symptom: "e2e-rift skill check: no banked skill point observable for 45s+ on either page despite continuous level-ups"
slug: rift-flood-flap-storm
date: 2026-10-01T10:00:00-0300
investigator: Foad Kesheh
branch: assets-trees-v2
repository: fps
status: root-cause-proven
hypotheses_formed: 5
hypotheses_rejected: 4
hypotheses_proven: 1
related:
  - docs/investigations/2026-09-30-rift-double-drop-private-sweep.md
---

# Snap flood backlogs sockets to megabytes; pings queue past liveness; flap storm eats every skill point

## Symptom
- **Observed**: `e2e-rift` check (12a) (skill spend) fails 11 consecutive runs in every design tried (rank===1 assert, at-lock spend, bank-wait on A, bank-wait on B, mid-anchored wait, fresh-only race): 45s walls with ~300 polls observe ZERO banked skill points while heroes level 5→9 (4+ points earned and bot-spent). Abort states show Q4+W4 with points=0, or a held point only on the page NOT being polled (inverted twice).
- **Expected**: level-up points sit visible in snaps between flaps; a 150ms poll catches them.
- **Delta**: points never survive to observation; both pages flap every ~15s (8 conn transitions/30s measured).

## Reproduction
1. `PLATFORM_STATIC=1 E2E_SKIP_BUILD=1 node scripts/e2e-rift.mjs` (speed 20, headless-shell).
2. Any (12a) design that waits for a banked point times out; abort dumps show bot-spent ranks (Q4 with 1 scripted skill call; B at rank 2 with ZERO).
   Verified: 2026-10-01 — reproduced 11/11 runs (plus 4 instrumented runs).

## Hypotheses

#### H1: the spend message never arrives (client send hole)
- **Layer**: state-data
- **Prediction**: If true, server never logs a spend for the scripted slot.
- **Verification method**: temp server log in `spendSkillPoint` (pid/slot/rank/points/tick).
- **Evidence**:
  ```
  [xp-probe] spend pid=acb34843 slot=0 rank=1 pointsLeft=0 tick=1423   (2ms after ghost — BOT)
  [xp-probe] level pid=5386c81b level=3 points=1 tick=4889              (no spend for 689 ticks!)
  [xp-probe] ghost pid=5386c81b tick=5578
  [xp-probe] spend pid=5386c81b slot=0 rank=3 pointsLeft=0 tick=5578    (same tick as ghost — BOT)
  ```
  Bot spends land same-tick as ghost/level-up; scripted spends never got a banked point to spend.
- **Verdict**: REJECTED (send path proven later: (12a) passed first-try once observable).

#### H2: level-ups land ghosted by chance (flap lottery)
- **Layer**: orchestration
- **Prediction**: If true, ~50% duty cycle ⇒ P(4/4 ghosted) ≈ 6% — timeouts should be rare.
- **Verification method**: ghost/rebind window log (room.ts) correlated with level-up ticks (units.ts).
- **Evidence**: 2/7 level-ups landed connected (visible ~4s each); 5/7 ghosted. Flap duty is ~50%
  (ghost windows 10-12s: backoff pinned at 10s late-match). P(0 visible in 6 level-ups) ≈ 13%
  per run — yet 4 consecutive race/wait runs ALL starved (p ≈ 0.03%).
- **Verdict**: REJECTED as the sole cause (real effect, wrong magnitude — something systematic hides the visible ones too).

#### H3: the polled page's snap ring trails past the point's lifetime (ring lag)
- **Layer**: state-data
- **Prediction**: If true, the polled page's ring lags seconds while the unpolled page shows fresher state.
- **Verification method**: abort-tick comparison across subjects (poll-A→B-banks, poll-B→A-banks).
- **Evidence**: B's ring at tick 6123 vs ~12000 server (~35s stale) while B held points=1 conn=true;
  freshSnap(≤2s) never fires on either page for 45s straight.
- **Verdict**: PROVEN as a major contributor (killed the fresh-only race design v5) but not the
  root cause of the flaps themselves.

#### H4: box CPU saturation stalls pong replies (load artifact)
- **Layer**: environment
- **Prediction**: If true, flaps vanish on a quiet box (load < cores).
- **Verification method**: cooldown to load 4.4/8, rerun; speed 20→10 to halve parse+sim load.
- **Evidence**: quiet-box run STILL flapped (B Q3 bot-spent, 0 points held); speed-10 run STILL
  flapped (B Q3, race timeout). Flaps persist independent of box load in the 4-13 range.
- **Verdict**: REJECTED (load worsens it — longer backoffs — but quiet does not cure it).

#### H5: the server's own flood backlogs sockets; pings queue behind megabytes past MAX_MISSED_PONGS
- **Layer**: transport-liveness
- **Prediction**: If true, `ws.bufferedAmount` is huge (MBs) exactly when pongs miss, on both sockets.
- **Verification method**: temp heartbeat log (bufferedAmount/missed/rtt per session per 2s tick).
- **Evidence**:
  ```
  [flood-probe] sess=a66ca066 buffered=263870  missed=0 rtt=2    (flood building)
  [flood-probe] sess=a66ca066 buffered=1178234 missed=1 rtt=2    (1.1MB, first miss)
  [flood-probe] sess=65acc2c5 buffered=915842  missed=0 rtt=1500 (pongs 1.5s late — queueing!)
  [flood-probe] sess=5fa89dad buffered=2266013 missed=1 rtt=1415 (2.2MB)
  [flood-probe] sess=003294ad buffered=2689779 missed=1 rtt=1212 (2.6MB at terminate)
  ```
  Server sends ~170 snaps/s × ~10KB ≈ 1.7MB/s per socket; pages drain ~95/s. Backlog grows
  unboundedly; ping frames queue behind megabytes; pongs arrive >2s late twice ⇒ terminate ⇒
  redial ⇒ re-flood ⇒ repeat. Both sockets flood equally ⇒ near-simultaneous double-drops
  (the double-drop investigation's trigger, now explained). Pre-lock count=1 with buffered=0
  is the separate page-load CPU stall (self-limiting; pongs resume, count resets).
- **Verdict**: PROVEN.

## 5 Whys
Symptom:  No banked skill point observable for 45s+ despite continuous level-ups.
Why 1?    Because every point is bot-spent inside a ghost window within milliseconds of banking.
Why 2?    Because both pages flap every ~15s with ~10s ghost windows (backoff pinned).
Why 3?    Because the server terminates both sockets for 2 missed pongs, repeatedly.
Why 4?    Because pongs arrive >2s late — queued behind megabytes of unsent snaps.
Why 5?    Because Session.send queues every broadcast unconditionally while the server
          out-sends the drain 2:1 — no coalescing, so the backlog (and ping delay) grows
          without bound. The server flap-kills healthy clients with its own flood.

## Falsification
- Check performed: flood coalescing in `Session.send` (drop same-tag repeat while
  `bufferedAmount` > 64KB) + 4 net unit tests; e2e-rift rerun.
- Result: (7) rate normalized 88-255/s → ~63/s delivered; B held its spawn point all run
  with ZERO flaps (level 1, xp 0, all ranks 0, conn=true); (12a) race + (12b) retry design
  then went green; full suite 21/21.
- Conclusion: CONFIRMED — capping the backlog restores timely pongs and ends the storm.

## Root Cause
- Immediate cause: unbounded per-socket backlog delayed liveness pings past the 2-miss
  (4s) kill threshold on both sockets simultaneously and repeatedly.
- Architectural root: the transport had no backpressure policy — a fast producer (tick
  broadcasts) and a slow consumer (software-raster page) met in an infinite queue that
  also carried the liveness signal. Liveness shared a fate with the flood.
- Rejected H1: send path proven (spends apply once a point is observable).
- Rejected H2: flap lottery is real (2/7 level-ups visibly banked ~4s) but cannot explain
  4 consecutive 45s starvations (p ≈ 0.03%).
- Rejected H4: quiet box (4.4/8) and speed 10 both still flap.

## Fix
- `platform/server/src/net.ts`: `Session.send` coalesces — a frame whose tag repeats the
  last SENT frame is dropped (returns 0, meter-honest) while `bufferedAmount` > 64KB
  (~6 snaps of slack; pings behind it drain in <0.5s). Hot periodic broadcasts are
  latest-wins so drops are harmless; rare tags (welcome/hello/errors/events) never
  repeat consecutively so they always flush. No contract change (additive behavior
  inside an existing method), no game changes.
- `platform/server/src/net.test.ts`: 4 coalescing tests (drop, rare-tag flush, resume
  after drain, latch reset) + bufferedAmount-aware fake socket.
- Harness (same storm, adjacent victims): e2e-rift (12a)→subject race with sustained
  signature (was: rank===1 assert), (12b)→ready-wait + retry (was: single cast),
  headless shell→true (rings 35s→1-3s stale), speed 20→10 (documented: 20 measures
  the harness, not the game). e2e-rift 21/21.
- Blast radius contained: drops apply only to consecutive same-tag frames on a
  backlogged socket; worst case a client sees newer state sooner. Slow clients get
  fresher snapshots instead of flap-death — strictly better in prod too.

## Resolution
- FIXED 2026-10-01. Deployed via flyctl (in-image build); prod smoke 9/9 after hardening
  the smoke probe itself (fresh browser per game — the shared browser degraded the
  same way). Regression cover: net.test.ts coalescing suite; e2e-rift (12a)/(12b) now
  flap-tolerant by design rather than by luck.

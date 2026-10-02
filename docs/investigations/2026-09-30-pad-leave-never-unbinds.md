---
type: investigation
symptom: "Pad {t:'leave'} never unbinds: owner gets no pad_status bound:false"
slug: pad-leave-never-unbinds
date: 2026-09-30T16:10:00-0300
investigator: Foad Kesheh
git_commit: 72497e03a28a109536014cb120fbf35548640551
branch: assets-trees-v2
repository: fps
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/research/2026-09-30-send-queue-race-audit.md
---

# Pad explicit leave never unbinds

## Symptom
- **Observed**: raw-ws probe (`/tmp/probe-padv2.mjs`): pair → bind → `pad_status bound:true` → `pad_input`/`pad_input_echo` all green; then pad `{t:'leave'}` → 8s timeout, owner never receives `pad_status bound:false` (inbox: only `kart_snapshot` spam after the bind).
- **Expected**: `docs/PLATFORM.md` §4.4 step 4: "Leave/disconnect → `pad_status {bound:false}`".
- **Delta**: disconnect unbinds (owner notified); explicit leave is a silent no-op.

## Reproduction
1. Player creates private kart room; `pad_pair_request` → `pad_pair{room,token}`.
2. Pad `join_as_pad` → `pad_joined` + owner `pad_status bound:true`.
3. Pad sends `{t:'leave'}`; observe owner inbox for 8s → no `pad_status bound:false`.
   Verified: 2026-09-30 — reproduced 1/1 (deterministic by code inspection).

## Hypotheses

#### H1: leaveRoom returns early for pads (never in sessionRoom)
- **Layer**: code-logic
- **Prediction**: If true, `leaveRoom` looks up `sessionRoom`, finds nothing for the pad id (pads are tracked in `this.pads`, never added to the room), and returns before any unbind logic.
- **Verification method**: read `leaveRoom` + the `case 'leave'` dispatch.
- **Evidence**:
  ```
  platform/server/src/lobby.ts:365-366: case 'leave': this.leaveRoom(sess.id, true);
  platform/server/src/lobby.ts:745-747: private leaveRoom(id, permanent=false) {
      const room = this.sessionRoom.get(id);
      if (room === undefined) return;   // <-- pads always exit here
  platform/server/src/lobby.ts:1193: this.pads.set(sess.id, ...)  // pads tracked separately, never in sessionRoom
  platform/server/src/lobby.ts:397: handleDisconnect calls this.detachPad(sess.id, true) FIRST
      (disconnect path unbinds; leave path has no equivalent call)
  ```
- **Verdict**: PROVEN
- **Rationale**: Single early return explains the full delta (disconnect works, leave does not).

#### H2: the leave frame never reaches the handler (parse/routing drops pads)
- **Layer**: code-logic
- **Prediction**: If true, `parseC2S` rejects pad leave or the message switch drops it before `case 'leave'`.
- **Verification method**: read the parse + dispatch; contrast with `pad_input` (which demonstrably routes — echoes arrived).
- **Evidence**: `case 'leave'` at lobby.ts:365 is tag-routed for every session (no membership check before dispatch); the probe's earlier `pad_input` frames routed fine through the same switch.
- **Verdict**: REJECTED
- **Rationale**: Dispatch is membership-agnostic; the drop is inside `leaveRoom`, not before it.

#### H3: unbind happens but the owner notice is lost (send failure)
- **Layer**: dependency
- **Prediction**: If true, the binding would be gone after leave (re-bind with the same code succeeds or pad_input stops echoing) while only the notice is missing.
- **Verification method**: (not run — H1 already proven sufficient and no code path detaches on leave at all).
- **Evidence**: No `detachPad`/`unbindPadsFor*` call exists on the leave path (only in `handleDisconnect` and room-close paths).
- **Verdict**: REJECTED
- **Rationale**: There is no unbind on the leave path to lose a notice from.

## 5 Whys
Symptom:  Pad leave never unbinds.
Why 1?    Because `case 'leave'` calls only `leaveRoom`, which returns early for sessions without a room.
Why 2?    Because pads are tracked in `this.pads`, never added to `sessionRoom` (by design — "pads are never added to the room").
Why 3?    Because the disconnect path got its `detachPad` call but the leave path was never given the equivalent one — the two exit paths were written asymmetrically.
Why 4?    Because no e2e exercised pad leave (e2e-pad tests the old never-built protocol and cannot run).
Why 5?    Because the v2 pad migration shipped lobby pairing + page + unit tests but no committed end-to-end suite for the v2 flow.

## Falsification
- Check performed: counterfactual edit — call `detachPad(sess.id, true)` in `case 'leave'` (no-op for non-pads).
- Result: probe step 6 green (`pad_status bound:false` received); new unit test fails with the line commented out, passes with it; full lobby suite 82/82; rewritten `e2e-pad.mjs` (v2 contract) green end-to-end.
- Conclusion: H1 survived — the single missing call was the whole bug.

## Root Cause
- Immediate cause: `case 'leave'` → `leaveRoom` early-returns for pad sessions (not in `sessionRoom`); no `detachPad` on that path.
- Architectural root: asymmetric exit paths (disconnect unbinds, leave does not); no v2 pad e2e to catch it.

## Fix
- File `platform/server/src/lobby.ts` (`case 'leave'`): call `this.detachPad(sess.id, true)` before `leaveRoom` — mirrors `handleDisconnect`. No-op for non-pads.
- Regression test in `platform/server/src/lobby.test.ts` ("pad explicit leave unbinds…", spec §4.4 step 4): owner hears `bound:false`, `padOwner` nulls, post-leave frames dropped. Verified to fail with the fix line commented out.
- Rewrote `scripts/e2e-pad.mjs` to the v2 contract (docs/PLATFORM.md §4.4): the old suite tested the never-built kart-pad protocol (docs call it "orphaned"); the new suite proves pair → bind → 60/60 relayed+acked inputs → leave-unbind → consumed-token rejection → `/pad/` page serving, all against the production server.

## Resolution
- Diff summary: 1-line lobby fix + 1 unit test + e2e-pad rewrite.
- Verification: lobby suite 82/82; v2 pad probe 8/8 steps; `e2e-pad.mjs` PASS; typecheck clean.
- Follow-up: none. (Kart game-side pad driving — `padOwner` seat resolution + desktop QR UI — remains future work; only rift/ancients drives via pad today.)

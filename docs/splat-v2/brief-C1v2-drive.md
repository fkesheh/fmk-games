# SPLAT V2 — C1v2 (client input): the jump edge

You own EXACTLY: `games/splat/client/src/drive.ts`,
`games/splat/client/src/drive.test.ts`.

Read CONTRACT.md §11 (jumps + §11.5 C1v2), UX_BIBLE §V2, and the existing
drive.ts (DriveController + TouchPointers). Add the JUMP control with the
same discipline as steering (DOM-free, unit-tested, blur-safe):

1. **`setJump()` public method:** a one-shot latch — the NEXT produced input
   message carries `jump: true`, then the latch clears. (Not a held flag:
   press = ONE edge; the sim cooldown owns cadence.)
2. **Keyboard:** Space (`Space`) and `ArrowUp` press → `setJump()`. Add to
   the existing `onKeyDown`/`onKeyUp` handling — jump is edge-triggered so
   `onKeyUp` does nothing for it. Respect the `typingTarget` guard (no jump
   while typing in a menu field). Blur/visibility-clear must NOT clear a
   queued edge you already committed to the next tick? — decide: the latch
   is consumed by the next tick, so blur-clearing it is fine and safest
   (clearHeld() also clears the jump latch).
3. **Wire + predictor:** in `tick()`, the `SplatInputMsg` gains
   `jump: this.jumpQueued` (always present, boolean) and the SAME value is
   pushed to the predictor (`this.pred.push({ seq, steer, dt, jump })`) so
   both peers replay the identical edge. Reset `jumpQueued` after.
4. **`reset()`:** clear the jump latch.
5. **Tests** (extend drive.test.ts; keep all existing green):
   - pressing jump once → exactly ONE outbox input with `jump: true`
     (subsequent inputs `jump: false`);
   - Space and ArrowUp both trigger it; typing-in-input guard holds;
   - blur clears a latched-but-unconsumed jump;
   - the edge rides the predictor: after a jump-edge input, `state().airborne`
     is true (needs P1v2's sim machine — if the shared sim body is not merged
     yet, gate on YOUR file compiling + your tests that don't depend on the
     airborne outcome; the orchestrator integrates the sim first, so prefer
     writing the tests anyway and noting the dependency).

Your gate: `node node_modules/typescript/bin/tsc --noEmit -p
games/splat/client` — fix every error in YOUR files (app.ts etc. may have
sibling errors; leave them) — + `npx vitest run games/splat/client/src/drive.test.ts`.
Report actual output.

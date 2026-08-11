# SPLAT V2 — C3v2 (HUD): the JUMP button + hint

You own EXACTLY: `games/splat/client/src/ui/hud.ts`,
`games/splat/client/src/ui/hud.css`, `games/splat/client/src/ui/hud.test.ts`.

Read UX_BIBLE §V2 and STYLE_BIBLE §V2.8, and the existing hud.ts (SplatHud —
place/speed/progress/countdown/results/hint, change-guarded render). v2:

1. **JUMP button:** a DOM button in the race HUD — round, ~72 px, positioned
   bottom-right ABOVE the touch zone area (not inside the steering halves),
   sunGold ring + `ink` arrow-up glyph on `paper` (glyph, not colour-only:
   the chip is labelled by its arrow). `touch-action: none`; no double-tap
   zoom; safe-area aware. It must not fight the steering zones.
2. **`onJump(fn: () => void): void` seam (additive):** the button's
   pointerdown (and keyboard-agnostic click) calls `fn` ONCE per press (edge
   — the app wires it to `drive.setJump()`; holding does NOT repeat). Use
   `pointerdown` so a thumb press feels instant; guard `pointercancel`/
   `lostpointercapture`/blur so a cancelled press doesn't linger (edge is
   consumed by the app anyway — but don't double-fire on a cancel).
3. **First-run hint (extend):** the existing steer hint adds one line:
   "SPACE / JUMP = hop — ramps send you flying!" — same 3 s timing, once per
   localStorage, dismissible by any input. Keep the thumb-outline visuals.
4. Keep the change-guarded render + no per-frame allocation laws; tests
   (extend hud.test.ts): the button exists in the race HUD, pressing it
   fires `fn` once (and only once per press), a cancelled press doesn't
   double-fire, the hint string contains the jump line, localStorage gate
   holds.

Your gate: `node node_modules/typescript/bin/tsc --noEmit -p
games/splat/client` — fix every error in YOUR files; sibling errors are the
orchestrator's — + `npx vitest run games/splat/client/src/ui/hud.test.ts`.
Report actual output.

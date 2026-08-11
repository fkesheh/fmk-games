# SPLAT V2 — C2v2 (app): jump wiring, air height, jump/land FX + audio, debug latch

You own EXACTLY: `games/splat/client/src/app.ts`.

Read CONTRACT.md §11 (esp. §11.5 C2v2 + §11.2 airHeight) and the existing
app.ts (SplatApp — net, drive, scene, skiers, fx, audio, hud, debug surface).
This is the WIRING task — the hub that makes the mechanic feel alive. The
seams below are frozen (implementer-added in the sibling files — call them;
they will exist after integration; if a sibling body is missing at YOUR
gate, gate on your file compiling against the contract's declared seams and
report the dependency).

1. **Own air height:** in the race frame loop where `cy = slope.height(cx, cz)`
   is computed, add `const air = airHeight(s, cx, cz, slope)` (import the deep
   path `@splat/shared/sim.js` — the barrel does not re-export it; signature
   is `(s, x, z, slope)`, height above the CURRENT terrain, 0 when grounded)
   and use `cy + air` for the camera eye. The scene's setCamera takes y
   already including air — the arc rides the camera exactly.
2. **Own jump/land events (predicted — the same frame):** track the previous
   `s.airborne`; on false→true: `scene.setAirborne(true)`,
   `skiers.setOwnAirborne(true)`, `audio.sfx('jump')`, and a `launch` burst
   at the skis; on true→false (landing): `scene.land()`,
   `scene.setAirborne(false)`, `skiers.setOwnAirborne(false)`,
   `audio.sfx('land')`, and a `land` burst at the touchdown point (feet at
   `cy` — terrain height, not the air height). Dedup via a stored edge flag
   (no per-frame allocation: two module fields).
3. **Remote jump/land:** for each remote buffer, watch `v.airborne`
   false→true: `skiers.setRemoteAirborne(id, true)`; true→false:
   `setRemoteAirborne(id, false)` + a `land` burst at the remote's feet
   (distance-culled beyond ~80 m) + `audio.sfx('land', {distance})`. Use the
   existing buffered snap (`v.airborne` is parsed in parseSkierSnap) —
   store the last-seen flag per id in the existing remote record or a small
   Map. Edges are rare; no per-frame allocation.
4. **Camera drive:** call `scene.setAirborne(s.airborne)` every race frame
   (cheap; the scene eases internally) instead of only on edges — simplest
   and robust to reconciles.
5. **Debug surface:** add `setJump(): void` to `window.__splat` — one-shot
   latch into `drive.setJump()` (like setInput's latch pattern but edge).
   Document it in the debugState comment block.
6. **HUD wiring:** `this.hud.onJump(() => this.drive?.setJump())` once after
   the hud is constructed (the seam is additive; guard the call if the hud
   object is null).
7. Keep every existing behavior (reconcile, gate pass, plant events,
   interp) intact; zero per-frame allocation added to the hot loop.

Your gate: `node node_modules/typescript/bin/tsc --noEmit -p
games/splat/client` — fix every error in app.ts; sibling errors are the
orchestrator's. Report actual output + any seam whose sibling body was
missing at your gate time.

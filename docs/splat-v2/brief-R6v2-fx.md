# SPLAT V2 — R6v2 (fx): land + launch bursts

You own EXACTLY: `games/splat/client/src/render/fx.ts`.

Read STYLE_BIBLE §V2.7 and CONTRACT.md §11.5 R6v2, and the existing fx.ts
(SplatFx — pooled Points systems: spray/puff/confetti + sparkle layer; the
budget law: capacities sum to ≤ 512 live). v2 changes:

1. **Two new FxKind members: `'land'` and `'launch'`** (add to the union —
   additive, existing code compiles). Extend `RECIPES`:
   - `land`: ~24 particles, life 0.4–0.8 s, RING velocity (high lateral
     outLo/outHi 3.5–6.5, moderate up 2.5–5), light gravity (~5), snowLit ->
     snowShade tint over life, size ~0.2 — the biggest, weightiest burst
     (the touchdown read from any distance);
   - `launch`: ~14 particles, fast + short (life 0.25–0.5), directional
     downwind spray (lateral biased — offset the spawn velocities by the
     skier heading? keep it simple: a fast spray kick with slight up bias,
     outLo/outHi 2–5, up 1.5–3.5, gravity 9, size 0.1) — the pop read at the
     takeoff lip.
2. **Pool rebalance:** the four gameplay pools (spray, puff, confetti, land,
   launch) must sum to ≤ 512. Suggest: spray 120, puff 112, confetti 160,
   land 72, launch 48 = 512. Adjust the existing constants; keep the sparkle
   layer separate (128) and the no-per-frame-allocation + deterministic-rng
   laws. `burst(kind, x, y, z)` must accept the new kinds with no signature
   change (the union widens).
3. Keep `clear()`/`dispose()`/`update()` behavior identical for the new
   pools (they're driven by the same RECIPES + ring machinery — the existing
   code already loops `['spray','puff','confetti'] as const`; extend those
   literal loops to the five kinds — careful: `dispose` and `clear` must
   cover the new pools too).

Your gate: `node node_modules/typescript/bin/tsc --noEmit -p
games/splat/client` — fix every error in fx.ts; sibling errors are the
orchestrator's. Report actual output.

# SPLAT V2 — C4v2 (audio): jump + land SFX

You own EXACTLY: `games/splat/client/src/audio.ts` (+ audio.test.ts if you
add tests).

Read STYLE_BIBLE §V2.4/§V2.7 feel notes and CONTRACT.md §11.5 C4v2, and the
existing audio.ts (SplatAudio — wind/carve voices, beep/burst primitives,
SplatSfx one-shots). v2:

1. **Extend `SplatSfx`** with `'jump'` and `'land'` (additive union members).
2. **`'jump'`:** a quick rising whoosh — airy noise burst sweeping UP (like
   the gate whoosh but shorter and with a small rising sine body ~300→700 Hz,
   ~0.12 s) + a tiny click-free pop at launch. Reads as "lift", distinct
   from the gate whoosh.
3. **`'land'`:** a soft THUMP — a low sine 120→60 Hz with a short decay
   (~0.16 s) + a broad powder noise burst (lowpass ~500 Hz falling, short,
   quiet) — weight without violence (no crash; the 4-year-old law).
4. Both respect the distance option (remote jumps/landings scale by
   `distanceGain`); both are silent safe no-ops before resume(); nothing may
   throw. Keep the seeded-noise + setTargetAtTime discipline.

Your gate: `node node_modules/typescript/bin/tsc --noEmit -p
games/splat/client` — fix every error in audio.ts; sibling errors are the
orchestrator's — + `npx vitest run games/splat/client/src/audio.test.ts`
stays green. Report actual output.

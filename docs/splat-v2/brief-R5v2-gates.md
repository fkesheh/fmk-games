# SPLAT V2 — R5v2 (gates): kicker ramps + festive finish + cosier lodge

You own EXACTLY: `games/splat/client/src/render/gates.ts`.

Read STYLE_BIBLE §V2.1 + §V2.6 and CONTRACT.md §11.4, and the existing
gates.ts (start/slalom/finish gates + lodge, all baked). v2 changes:

1. **KICKER RAMPS (the v2 hero asset — §V2.1):** a new `buildKickers(slope)`
   added to the buildGates group (so they bake with the same pass). For each
   `slope.kickers` entry (Kicker has x, z, halfWidth): a sculpted snow ramp —
   a tapered wedge ~2.4 m long along +z, `halfWidth` wide, ~0.85 m tall
   (KICKER_HEIGHT from config), built from 4–6 `box`/`cone` facets:
   `snowLit` sun face (facing the sun: see SUN_DIR in visual.ts), `snowShade`
   shadow side, `snowDeep` contact crease at the base, and a thin `bark` lip
   at the takeoff edge. Wind-crest spray: 3–5 tiny `snowLit` cones fanning
   downwind off the lip (the "AIR!" read). Base sits at
   `slope.height(x, z)`, wedged so the run-in is smooth (the ramp's front
   face starts ~1.2 m before z and slopes up to the lip at z). All from
   `contract/visual.ts` factories; deterministic (pure function of
   slope.kickers).
2. **Finish (§V2.6):** add a SECOND pennant row BELOW the existing banner
   (sunGold + the 8 SKIER_COLORS alternating, smaller pennants), a short
   runout flag line: ~6 small sunGold pennants along EACH piste edge past
   the line (on `bark` poles ~0.9 m), and a `paper` fringed edge on the
   banner panel (small paper cones hanging from the banner's bottom edge).
3. **Lodge (§V2.6):** second chimney (smaller, on the far roof side) with
   2–3 smoke puffs; porch: 2 posts + a small porch roof over the door;
   a ski rack beside the door with 2–3 pairs of skis (thin boxes in
   SKIER_COLORS tops + ink bases); a sunGold sun sign (a small sphere or
   disc + rays) above the door; a soft warm light-spill quad (`sunGold`,
   flattened box) on the snow in front of the windows; a barrel (cyl) +
   more firewood; deeper roof snow (raise the snow blanket and widen it).
4. Everything still bakes into ONE mesh per SPAL colour (the bake() pass) —
   draw-call cost of the whole gates group stays ~8–12, inside budget.
   The finish/lodge additions must not grow past ~15 extra primitives each
   after bake.

Your gate: `node node_modules/typescript/bin/tsc --noEmit -p
games/splat/client` — fix every error in gates.ts; sibling errors are the
orchestrator's. Report actual output.

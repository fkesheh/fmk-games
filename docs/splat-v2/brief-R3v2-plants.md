# SPLAT V2 — R3v2 (plants): model-sheet upgrade

You own EXACTLY: `games/splat/client/src/render/plants.ts`.

Read STYLE_BIBLE §V2.3 and the existing plants.ts (PlantField — one
InstancedMesh per kind from baked vertex-coloured archetypes; hit squash;
band culling). Upgrade the three archetypes' model sheets. ALL colours from
SPAL; factories only; deterministic per-instance variation from the existing
seeded rng stream.

1. **Pine:** leaner + taller; 4–5 tiers with the LOWEST tier drooping
   (rotate ~0.25 rad outward and drop its base — the weight-of-snow read);
   snow dust DEEPENS: each tier gets TWO snow caps (the existing flat cap
   plus a smaller nested one at the tier's mid-shoulder), and the apex snow
   tip stays. Add a small per-instance lean (a slight rot.z in the instance
   compose — plants already get rot.y; add a tiny deterministic lean per
   instance from the seeded rng, max ~0.06 rad, so no two pines stand
   bolt-upright).
2. **Bush:** 4–5 foliage blobs (currently 3) — add a trailing shadow-side
   blob and a top highlight blob; layered snow caps on each; 2–3 tiny
   exposed twig tips (thin `shrubDark` cylinders) poking through the snow on
   the shadow side.
3. **Thorn:** 9–11 branches (currently 7) with more kinked twigs; add small
   snowLit spheres (r ~0.06–0.08) caught in the branch crotches where
   branches fork (2–3 per thicket). Keep the warm thorn/thornLit hues — the
   danger read.
4. Keep: the InstancedMesh-per-kind structure, the hit squash/shake
   (hitPlant), the band culling, ≤ 150 in-piste plants, and the §8 budget
   (visual instances ≤ 3k total with terrain's forest). Primitive budgets
   per archetype: pine ~20–26 parts, bush ~14–18, thorn ~16–22 (all still
   baked into ONE vertex-coloured geometry per kind — 3 draw calls total,
   unchanged).

Your gate: `node node_modules/typescript/bin/tsc --noEmit -p
games/splat/client` — fix every error in plants.ts; sibling errors are the
orchestrator's. Report actual output.

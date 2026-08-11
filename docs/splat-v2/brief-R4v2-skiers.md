# SPLAT V2 — R4v2 (skiers): detail pass + the AIR POSE + own-skis tuck

You own EXACTLY: `games/splat/client/src/render/skiers.ts`.

Read STYLE_BIBLE §V2.4 and CONTRACT.md §11.5 R4v2, and the existing skiers.ts
(SkierVisuals — remote baked per-material groups with skisPivot/bodyPivot,
chest-glyph sprite, own-skis camera rig). v2 changes:

1. **Remote body detail pass** (STYLE_BIBLE §V2.4, in `bodyProto`): torso
   gains shoulder-panel taper (two small slot-colour boxes over the ink
   block at the shoulders); a backpack (`ink` box behind the torso) with a
   slot-colour strap box across the chest; helmet gains a `paper` visor band
   + `ink` strap; arms get ELBOW JOINTS (upper + fore cylinders per arm, the
   existing proportions split ~0.55/0.45); poles keep baskets. Primitive
   budget ~40–60 total per skier (still two baked meshes: colour + ink —
   draw calls per remote stay 2 meshes + glyph = 3, so 7 remotes ≈ 21–28
   calls, inside budget).
2. **AIR POSE — new:** add per-remote air state + a `setRemoteAirborne(id,
   on: boolean)` public method (additive seam). While airborne the pose eases
   (over ~0.12 s) from the carve crouch to: legs straighten (shin/thigh
   pivots rotate to near-vertical), torso uprights (bodyPivot.rotation.x ->
   ~-0.08, slight back-lean), arms raise/back (shoulder pivots), skis pull
   TOGETHER (skisPivot narrows: the baked ski mesh is one unit — instead
   ease the skisPivot rotation to level and lower it slightly; if the
   silhouette needs the skis to visually tuck, scale the skisPivot y ~0.9
   and rotate to level). The transition is eased via the existing
   `steerVis`-style eased state (store an `airVis` 0..1 per remote, ease
   toward the target, apply as a blend factor between poses). On the
   airborne→grounded edge, briefly over-crouch (~0.15 s deeper) then ease
   back — the landing absorb.
3. **Own skis:** `setOwnAirborne(on: boolean)` — while airborne the
   own-skis rig eases to: skis tuck up (position.y rises ~0.06, tips level —
   the rig rotation.x eases from 0.12 toward ~0.02), spread narrows (the
   `spread` term goes to 0), speed vibration fades; on the grounded edge the
   rig dips once (a small one-shot bounce) then resumes normal carve
   behavior.
4. Keep: the frozen `update`/`setOwnSkis` signatures untouched (add the two
   new methods); zero per-frame allocation (all eased state lives in the
   per-remote record); the chest glyph; dispose path frees everything.

Your gate: `node node_modules/typescript/bin/tsc --noEmit -p
games/splat/client` — fix every error in skiers.ts; sibling errors are the
orchestrator's. Report actual output.

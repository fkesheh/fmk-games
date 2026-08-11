# SPLAT V2 — R1v2 (scene): sky, sun disc, air camera feel

You own EXACTLY: `games/splat/client/src/render/scene.ts`.

Read CONTRACT.md §11.4 + STYLE_BIBLE §V2.5 and the existing scene.ts (SplatScene
— renderer, lights, sky dome, post pass, first-person rig). v2 changes:

1. **`setAirborne(on: boolean): void`** — a new public method (additive to the
   frozen §7a seam). Stores an eased `airborneVis` flag; `setCamera` uses it:
   - FOV punch: while airborne, target FOV is BASE_FOV + SPEED_FOV_MAX + 4
     (eased, not snapped; on landing it eases back);
   - micro-shake fades out while airborne (air is smooth; ground is bumpy);
   - a subtle pitch bias toward level (~-2°) while airborne, eased.
   Deterministic from the (airborne, dt) stream — no rng.
2. **`land(): void`** — a new public method: retriggers the dip spring (the
   same mechanism as `plantHit()`) with a slightly larger impulse and a soft
   snowLit->snowShade edge flash (reuse the flash envelope, lower peak than a
   plant hit). `plantHit()` stays unchanged.
3. **Clouds:** 6–10 low-poly cloud puffs in a ring ~450–520 m out
   (STYLE_BIBLE §V2.5): each puff = 2–4 squashed `sphere` primitives from
   `contract/visual.ts`, `fog:false`, MeshLambert with a light material
   (use SPAL.paper top / SPAL.snowShade underside via vertex or separate
   meshes), positioned near the horizon band, `frustumCulled=false`, NOT
   baking into the terrain root's dispose list — they're static for the
   session (rebuild with the sky dome or keep — your choice, but dispose on
   terrain rebuild via the existing disposables pattern if you rebuild).
   Keep them OUT of the sun blob and out of the camera's near field.
   Draw-call cost: ≤ 2 extra calls total (bake them into one mesh per
   material).
4. **Sun disc:** a small warm `sunWarm` disc (a circle geometry or a
   low-poly octagon mesh, `fog:false`, MeshBasicMaterial is allowed for this
   exempt piece OR Lambert) positioned on the dome in the SUN_DIR azimuth at
   ~dome-radius×0.82, low in the sky, behind the existing warm glow blob.
   `frustumCulled=false`; rides with the sky dome (dome position follows the
   camera — keep the disc positioned relative to the camera so it stays on
   the sun azimuth).
5. Keep every existing behavior (prewarm, resize, drawCalls, plantHit,
   buildTerrain) intact. Budget: total scene draw calls stay well under 80
   (clouds + sun disc + post = tiny).

Your gate: `node node_modules/typescript/bin/tsc --noEmit -p
games/splat/client` — fix every error in scene.ts; sibling files' errors are
the orchestrator's — + the client suite still collects. Report actual output.

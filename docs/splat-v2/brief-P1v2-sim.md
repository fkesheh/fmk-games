# SPLAT V2 — P1v2 (shared sim): the jump state machine

You own EXACTLY: `games/splat/shared/src/sim.ts`,
`games/splat/shared/src/sim.test.ts`.

The contract text (CONTRACT.md §11.2) specifies the jump semantics in full —
your body is a transcription of it. The v2 field constructors,
`airHeight()`, `SkiInput.jump?`, `SkiStepOpts.jump?` and the copied fields
already exist in sim.ts (the orchestrator's contract edits). Your job:

1. **Implement the jump state machine inside `stepSki`** exactly as §11.2
   orders it (a short summary — follow the CONTRACT text, not this summary):
   - Step order: clock → gravity/steering/carve/yaw/motion/bounds → plant
     pass (SKIPPED while airborne) → gates (unchanged, applies in air) →
     edges (unchanged) → **jump state machine at the END** (post-motion
     position, using `prevZ`) → finish.
   - Airborne step: after the clock, compute `t = (simMs - airStartMs)/1000`,
     `worldY = airStartY + airVy*t - 0.5*G_ACCEL*t*t`; LAND when
     `worldY <= slope.height(s.x, s.z)` OR `t >= J_MAX_AIRTIME_S`:
     set `airborne=false, airVy=0`, `v = max(MIN_SPEED, v * J_LAND_SPEED_MUL)`.
   - **Kicker scan — runs EVERY step (airborne or grounded):** ascending z
     from `lastKickerIx+1`; on `prevZ < k.z <= s.z` set `lastKickerIx = ix`
     (consumed on ANY crossing) and break the loop; LAUNCH only when
     grounded AND `simMs - airStartMs >= J_COOLDOWN_MS` AND
     `|x - k.x| <= k.halfWidth`: `airVy = J_KICKER_VY_BASE +
     J_KICKER_VY_SPEED * v`, `airStartMs = simMs`, `airStartY =
     slope.height(x, z)`.
   - Manual hop (only if still grounded AND off cooldown AND not launched
     this step): `opts.jump === true` → LAUNCH with `airVy = J_HOP_VY`.
   - While airborne at the step's start: yaw rate × `J_AIR_STEER_MUL`,
     carve scrub × `J_AIR_CARVE_MUL`, plant pass skipped.
   - `resolveSkiPair`: return early if EITHER sim is airborne.
   - **`airHeight(s, x, z, slope)` already exists in sim.ts with the
     gauntlet-corrected signature** (height above CURRENT terrain): leave it
     exactly as-is; your jump tests should use it (see 3).
2. **Predictor:** `SkiPredictor.push` must carry `inp.jump === true` into the
   pending queue AND into the immediate `stepSki` call; `reconcile` must
   replay the stored jump flag (the pending entry type gains `jump`). Both
   peers replaying the same (steer, dt, jump) sequence is the netcode
   contract.
3. **Tests** (extend sim.test.ts; keep every existing test green):
   - determinism: identical (steer, dt, jump) input sequences → bit-identical
     state, including jumps, on several seeds;
   - hop: `stepSki(s, 0, dt, slope, {jump: true})` launches (airborne true,
     airVy = J_HOP_VY); the arc rises then lands; `airHeight` matches the
     closed form and is 0 when grounded;
   - kicker: a slope fixture with a kicker under the path launches on
     crossing; a lateral miss does not; a kicker crossed mid-air is consumed
     (`lastKickerIx` advances) and does not re-launch on landing;
   - fly-over-plants: a plant dead-centre under the flight path NEVER hits
     while airborne; landing on a plant snares on the following step;
   - cooldown: no second launch within J_COOLDOWN_MS of `airStartMs`;
   - landing safety: `v` never below MIN_SPEED after landing; a launched
     skier always lands (never stuck) — including `t >= J_MAX_AIRTIME_S`;
   - air steering: yaw changes ~J_AIR_STEER_MUL slower in air;
   - the 4-year-old v2: full-lock both directions still finishes on 20
     `genSlope` seeds with kickers present, AND a skier who launches (hop or
     kicker) stays contained (|x| within ~3.5 m of the piste edge) and
     always lands (cross-import genSlope in tests — legal; docs/splat-v2/
     prototype-v2.mts is the empirical reference — your tests should
     reproduce its PASS conditions).
4. **Gate:** `node node_modules/typescript/bin/tsc --noEmit -p
   games/splat/shared` clean + `npx vitest run games/splat/shared/src/sim.test.ts`
   green. Report actual output.

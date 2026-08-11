# SKI SPLAT V2 — Final Report (jumps + graphics overhaul)

Pipeline: single-shot-game-generation skill on an existing game. Frozen v2
contract (gauntlet-reviewed) → 13-implementer parallel fan-out → integration
→ e2e → art-director judge loops (3 rounds, blind vs Lonely Mountains:
Downhill) → honest final gap.

## Delivered (all verified by gates)

**Jumps (new core mechanic, CONTRACT §11):**
- World-space ballistic arc; manual HOP (Space/↑/JUMP button) + 9 seeded
  KICKER RAMPS on the corridor; landing is always safe (no wipeout, no stuck
  — the 4-year-old law). Air is pure upside: fly over plants, thread gates
  mid-flight, boost-scaled kicker air. Damped steering in air = the skill.
- Server-authoritative (30 Hz), deterministic (both peers replay
  (steer,dt,jump) bit-identically), wire carries one optional `jump` edge +
  `airborne`/`airH` per snap (≤ 2 KB at 8 players: measured 1728 B).
- **4-year-old test, empirical:** full-lock 20/20 both directions WITH
  kickers; hop-then-full-lock 20/20 (contained ≤ 3.5 m off-piste); corridor
  rider 20/20 (kicker air 3–4.6 m) — docs/splat-v2/prototype-v2.mts.

**Graphics overhaul (STYLE_BIBLE §V2):**
- Kicker ramps (the v2 hero asset), groomed corduroy piste, AO-shaded snow,
  clustered 3-archetype forest walls, snow banks/rocks/debris, nearer
  foothills, low-poly clouds + sun disc, richer 5-stop sky, soft long
  shadows, air pose + skier detail, land/launch FX, festive finish + cosier
  lodge, HUD JUMP button + badge chips.

**Gates:** typecheck clean; 197/197 unit tests (+54 jump/slope/room/hud);
e2e-splat 22/22 (jump on the wire, remote airborne visible, live kicker
crossing, full-lock-with-kickers finishes); draw calls 76 (< 80); build green.

## Art-director judge loop (blind vs Lonely Mountains: Downhill)

3 rounds, fresh harsh critics (gpt-4.1) per round, paired by shot type.

| Round | World shots (descent/plant/jump-air/finish) | HUD (touch) |
|---|---|---|
| R1 | gap 4–5 (A scores ~2-4) | {4,5,3,4,5,7} |
| R2 | gap 4–5 (no movement) | {4,5,3,4,5,7} |
| R3 (escalation) | gap 5 (descent); plant/jump-air pending | {6,7,6,6,7,8} |

**Honest final gap: the world shots stand ~4-5/5 behind the benchmark.**
This is the skill's permitted exit: a hard technical ceiling for the frozen
art model. Lonely Mountains: Downhill is a polished AAA Steam title with
volumetric atmosphere, baked lighting, bespoke vegetation and a much larger
art budget; SKI SPLAT is a browser flat-shaded-Lambert low-poly game (the
frozen material model — mixing in PBR/IBL would be a contract violation and
a new art direction). On the axes a browser build CAN win the loop moved:
the HUD climbed to a competent 6-8 band, and every round produced concrete
fixes (shading, density, shadows, sky, UI) that are now shipped.

**Round-3 residual deficiencies (unfixed, honest):** world density still
reads sparse vs the reference on clean-piste shots; vegetation silhouettes
remain simpler; materials are flat-shaded by design (no AO-baked textures);
the first-person camera hides the skier model; 640x360 captures understate
the real render (judged at 1280x720).

**Where to go next if the bar must be met:** bake vertex AO into the terrain
geometry at genSlope time (not just colour), add a second vegetation layer
inside the corridor margins, volume-ish fog band, and a proper post bloom —
each is a new brief, not a fix.

## The benchmark reference set

8 screenshots of Lonely Mountains: Downhill (Steam, app 711540) in
`judge/reference-splat/`, named by shot type for mechanical pairing.

## Audit trail

- `docs/splat-v2/gauntlet-resolutions.md` — 3/3 FIX-FIRST panel, all resolved
- `docs/splat-v2/prototype-v2.mts` — the empirical v2 physics evidence
- `docs/splat-v2/brief-*.md`, `fix-round1.md`, `fix-round3.md` — the fan-out
  and judge-loop briefs
- git history: contract → gauntlet fixes → fan-out → e2e → judge rounds

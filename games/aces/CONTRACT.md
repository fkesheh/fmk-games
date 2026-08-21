# ACES — FROZEN CONTRACT

**WWI dawn-patrol dogfight over a cold strait. Two teams, forward-firing twin
machine guns, first squadron to 25 kills.** The 8th game on this platform,
riding the standard `GameModule` plug (`docs/STRUCTURE.md`).

Everything in this file plus `STYLE_BIBLE.md` plus every file listed in
`plan.json → contract` is **immutable once the gauntlet passes**. No task may
change a signature, rename a field, widen its file ownership, or contradict
the bibles. A task that believes the contract is wrong **STOPS and reports**
with the contradiction cited — it never renegotiates locally.

---

## §0 Envelope

**In:** 1–8 players per room (bots fill empty seats by default), two teams
(ROYAL vs IRON), three airframes (SCOUT / FIGHTER / GUNSHIP), forward MG arcs
with overheat, boost, supply crates, team-deathmatch tickets to 25 or higher
score at 8:00, respawn-with-class-picker, one deterministic strait map.

**Out (v1):** aircraft carriers/ground attack targets, bombs/rockets/turrets,
fuel, ammo counts, stall/spin physics, altitude simulation, squads/voice,
persistence/unlockables, chat, multiple maps, weather changes mid-match.

---

## §1 Design law (every task is bound by this)

- **D1 — The duel is the game.** Every system exists to produce repeated
  head-on turning duels resolved by aim and nerve. Nothing may add a way to
  kill without flying toward the enemy.
- **D2 — Forward-fire discipline.** Guns fire only along the fuselage. There
  is no aiming independent of flying. Heat is the resource: continuous-fire
  windows before jam are scout 5 s / fighter 6 s / gunship 4 s from cold —
  holding the trigger loses the duel. Burst discipline is the skill.
- **D3 — Death costs seconds, not progress.** Respawn in 3.5 s with full HP
  and a class choice. No elimination, no spectate-prison longer than one
  respawn cycle.
- **D4 — Readable sky.** At any moment a player can answer: where are enemies,
  where is my damage, can my guns fire. Team identity is double-encoded
  (color AND silhouette/markings — never color alone).
- **D5 — Bots fly like pilots, not turrets.** They lead shots, break off when
  outmaneuvered, avoid the map rim. A solo player's match must feel contested.
- **D6 — One minute of play:** turn, throttle, boost-burst, trigger bursts,
  watch heat, chase a smoke trail, grab a crate when hurt, die, pick a class,
  revenge. Each verb resolves to a contract surface below.

---

## §2 Architecture & file ownership

Packages follow the house layout (`@aces/shared|server|client`). Workspaces
glob `games/*/*` already covers them; registry/vitest/root-scripts wiring is
INTEGRATOR-owned.

### Frozen contract files (authored before fan-out; nobody edits after freeze)

```
CONTRACT.md  STYLE_BIBLE.md                       ← these documents
games/aces/shared/src/palette.ts                  ← APAL — every color traces here
games/aces/shared/src/config.ts                   ← all tunables, pure data
games/aces/shared/src/types.ts                    ← PlaneState/BulletState/events
games/aces/shared/src/protocol.ts                 ← C2S/S2C + parseC2S gate
games/aces/shared/src/physics.ts                  ← stepPlane/fireVolley/aimLead…
games/aces/shared/src/maps.ts                     ← buildMap(seed) + isOpenWater
games/aces/shared/src/index.ts                    ← barrel
games/aces/shared/src/palette.ladder.test.ts      ← ΔE readability gate on APAL
games/aces/client/src/contract/visual.ts          ← client visual vocabulary
games/aces/client/src/contract/seams.ts           ← InputSource/HudModel/EffectsApi/AudioApi/NetClient
```

### Module ownership table (DISJOINT — no file appears twice)

| id | owns | summary |
|----|------|---------|
| S_ROOM | `server/src/room.ts`, `server/src/module.ts`, `room.test.ts` | room lifecycle, phases, join/leave/bot-fill, tick loop, snapshot+event broadcast, scoring/respawn queue, settings |
| S_SIM | `server/src/world.ts`, `world.test.ts` | authoritative World: integrates planes/bullets via shared physics, hit resolution, crates, burn deaths, emits GameEvents |
| S_BOTS | `server/src/bots.ts`, `bots.test.ts` | pilot brains → InputFrame per tick (pursuit, lead fire, evade, rim avoidance) |
| C_NET | `client/src/net.ts`, `client/src/prediction.ts`, `net.test.ts` | ws lifecycle, input sender @30 Hz, snapshot interp buffer (120 ms), own-plane prediction + reconcile |
| C_APP | `client/src/app.ts`, `client/src/main.ts`, `client/index.html`, `client/src/style.css` | composition root: screens→match flow, rAF loop, camera rig (follow/lookahead/zoom/shake), layer compositing, `window.__ACES` debug surface |
| C_WORLD | `client/src/render/world.ts`, `render/world.test.ts` | sea/islands/surf/cloud-shadow bake + animated overlays; exposes drawBelow/drawAbove (occluding cloud puffs live ABOVE planes) |
| C_FX | `client/src/render/planes.ts`, `client/src/render/effects.ts`, `render/planes.test.ts` | vector airframes ×3 classes ×2 liveries ×damage states; **crate body + parachute** (`drawCrate` — crates are entities, rendered from CrateState); bullets/tracers; pooled particles; shake impulses API; implements EffectsApi |
| C_UI | `client/src/ui/hud.ts`, `client/src/ui/screens.ts`, `ui/hud.test.ts` | HUD canvas overlay (crosshair, lead pip, edge arrows, hit markers, banners) + DOM (HP/heat/boost, tickets, clock, killfeed, scoreboard Tab, class picker, menus, end screen) |
| C_AUDIO | `client/src/audio/audio.ts`, `audio.test.ts` | WebAudio synth: engine drone (throttle-pitched), MG rattle, hits, explosions (distance), crate chime, wind bed, UI blips, M-mute |
| INTEG | root `package.json`, `vitest.config.ts`, `platform/server/src/registry.ts`, launcher entries in `platform/server/src/index.ts`, `scripts/e2e-aces.mjs`, package scaffolds/tsconfigs/vite configs | registration, gates, e2e harness |

**Import law:** server imports `@platform/shared` + `@aces/shared` only.
Client imports `@aces/shared` + its own tree. Cross-module client seams are
FROZEN in `client/src/contract/seams.ts` — C_NET implements `NetClient`,
C_FX implements `EffectsApi` (+ exports `drawCrate`), C_AUDIO implements
`AudioApi`, C_UI consumes `HudModel`, C_APP builds the HudModel and drives
everything; input mapping reads config.INPUT_KEYS. app.ts composes; render
modules never import ui; ui never imports render internals.

## §3 Rules binding EVERY implementer (the RULES)

1. **Frozen means frozen.** You fill bodies under your owned files only. If a
   frozen symbol is missing/misnamed you STOP and report.
2. **No ad-hoc color.** Every hex traces to `APAL`. Derivations only via
   `visual.ts` helpers (`mixA`, `shadeA`) with palette endpoints, or alpha
   suffixes on palette constants.
3. **No `Math.random()` anywhere under `games/aces/`.** Gameplay and visual
   variation come from `mulberry32` with a fixed seed passed in (per-bot
   seeds = hash of bot id + round seed; fx uses a dedicated seeded stream).
   Sole exception — identity & clocks: room/player id generation and
   timestamps may use `crypto.randomUUID()`/`Date.now()` (uniqueness, not
   variation).
4. **No per-frame allocation in hot paths** (rAF render, sim step, particle
   update). Pool particles; reuse arrays; no object literals in loops that run
   60×/s. Snapshot/event objects are exempt (they cross the wire anyway).
5. **One exception must not white-screen.** Wrap per-frame composition so a
   throw in any subsystem logs once and skips that frame's subsystem instead
   of killing the loop. Guard AudioContext creation behind user gesture +
   feature test.
6. **Window blur clears inputs.** Held keys/mouse state reset on blur/visibilitychange. Resize must not distort (canvas resizes to DPR-capped device pixels).
7. **Strict TS.** No `any`. Non-null assertions only immediately after an
   explicit guard that establishes the invariant (length check, early
   return) — never to silence a real maybe. Wire data is narrowed, never
   asserted.
8. **Tests are part of done.** Each module ships vitest coverage of its pure
   logic (physics edge cases, parser rejects garbage, bot steering sanity,
   interp math). Composition roots (`app.ts`, `main.ts`, `index.html`) are
   exempt from unit tests — the e2e suite is their coverage. House gates:
   `npm run typecheck && npm test && npm run build` stay green repo-wide.
9. **STYLE_BIBLE.md binds all visual work.** Contradictions stop-and-report.
10. **Latency budget:** action → visible response ≤ 100 ms. Muzzle flash is
    locally predicted: C_APP fires an immediate cosmetic flash + tracer stub
    through C_FX's effects on trigger-down (client-owned, zero wire round
    trip); server bullets arrive via snapshots and replace the stubs. HUD
    bars interpolate, never snap.
11. **Performance budget:** 60 fps at 8 players + ~120 live bullets + FX_POOL_MAX
    particles on integrated graphics; frame ≤ 12 ms steady-state; heap stable
    across a 5-minute soak (pools bounded, gradients baked once — visual.ts's
    grain/vignette are pre-baked tiles/canvases, never per-frame rng or
    gradient construction in the loop).
12. **Load budget:** client bundle ≤ 350 KB gzipped; cold playable ≤ 3 s on
    localhost. No image/font assets — everything drawn or synthesized.

---

## §4 Server spec

### S_ROOM — room.ts (+ module.ts)

- `class AcesRoom implements GameRoomHandle` with constructor
  `(visibility, io, settings?)` — exactly what `createRoom(opts)` receives
  (`new AcesRoom(opts.visibility, opts.io, opts.settings)`). Room ids/codes
  are the platform lobby's concern; the room never mints them. `handleMessage`
  routes through `parseC2S(msg, this.settings.debug === true)`. Unknown/null →
  ignore silently.
- Phases: **lobby** (first human joins → LOBBY_COUNTDOWN_S countdown if ≥1
  human, bots already seated and visible on the roster) → **live** → **end**
  (END_SECONDS scoreboard, winner banner) → auto-restart into fresh **live**
  with tickets reset (same room, same seed). Phase changes broadcast ONLY via
  PhaseMsg (the authoritative channel — carries endsAtS/winner); the event
  stream carries no phase events.
- Bot fill: seats up to `teamSize*2` filled with named bots ("Lt. Kestrel",
  "Cpl. Voss", …) balanced across teams; humans joining take a bot's slot
  (bot despawns, human spawns fresh); humans leaving hand the plane back to a
  bot. `settings.botFill=false` leaves seats empty (roster shows vacancies).
- Input handling: store latest InputFrame per player (drop stale seq);
  feed intents to World at TICK_RATE; echo applied seq back on that player's
  SnapPlane. Debug verbs (debug rooms only): `god` toggles that player's no-
  damage flag; `warp x y` teleports their plane; `crate x? y?` force-spawns a
  supply crate (random open water when omitted); `tick x N` advances the sim
  N ticks in one message (CI/e2e fast-forward) — all server-authoritative.
- Spawn rule (no ambiguity): joining during **lobby** seats you at the roster
  with the countdown; at live transition EVERY seated human auto-spawns
  fighter immediately (picker available from then on). Joining mid-live:
  auto-spawn fighter instantly. After death: RESPAWN_SECONDS → picker waits
  indefinitely (your last class pre-selected; bots pick by
  BOT_CLASS_WEIGHTS).
- Win check each ticket change and at time expiry (higher tickets; tie →
  sudden death: phase stays live, HUD shows SUDDEN DEATH stamp, next kill
  wins). stalePlayers(): ids with no applied input for > STALE_SECONDS.
- Scoring: kills increment shooter's team tickets + personal stats; crash
  (burn death) credits no killer and moves no ticket — tickets only move on
  credited kills.
- Snapshot assembly at SNAP_RATE from World state (see protocol.ts shape);
  events flushed immediately; scoreboard recomputed on kill and sent as
  `score` (rate-limited to 1/s during streak churn).
- Ping/pong passthrough. RTT via io.rttMs available if needed.

### S_SIM — world.ts

- `class World { planes: PlaneState[]; bullets: BulletState[]; crates:
  CrateState[]; tick: number }` with `step(dt, intents: Map<id,InputFrame>)`
  and event sink callback. Deterministic given identical inputs (bots use
  their own seeded streams — see S_BOTS).
- Order per tick: apply inputs via `stepPlane`; firing → `fireVolley` (spread
  jitter rolled here with the world's seeded rng — clients render tracers to
  actual bullet positions, they do NOT reproduce spread); `stepBullets`;
  hit resolution using the SWEPT test (`bulletHits(b, prevX, prevY, p)` —
  head-on passes close at >40 u/tick; static point checks tunnel through
  noses), first enemy plane intersected along the segment wins: apply dmg,
  HitEvent (killed flag); on death → KillEvent with `crash=false`; victim
  .dead=true + respawn timer handled by room queue (sim just marks dead);
  burn ticks FIRE_BELOW planes BURN_DPS (death → KillEvent with
  `crash=true`, killer fields carry the VICTIM's own id/name/team so the
  wire shape stays total — killfeed renders the crash variant when
  crash=true); crates: fall timers, pickup radius → heal clamp maxHp,
  heat=0 jammed=false, boost=BOOST_MAX, CrateEvent; expire.
- Spawn placement helper `spawnAt(map, field, cls)` used by room.
- Crate spawner lives HERE (interval, CRATES_MAX, isOpenWater placement,
  seeded rng) — room does not place crates.

### S_BOTS — bots.ts

- `computeIntent(world, me, diff, rng): InputFrame` — pure-ish (rng is the
  bot's private stream).
- Behavior: acquire nearest living enemy (reaction delay after target loss);
  steer toward `aimLead` intercept point; fire when angle-to-solution <
  aimErrDeg and range < fireRangeU (release above BOT_AI.RELEASE_HEAT);
  evade below BOT_AI.EVADE_HP_FRACTION hp: hard turn perpendicular + boost
  pulse + throttle cut to EVADE_THROTTLE; rim avoidance inside
  BOT_AI.RIM_MARGIN_U: bias turn toward map center; full throttle otherwise.
  Occasional personality weave (sinuous offset by per-bot phase). Never fires
  while invulnerable.
- Difficulty table from config; unit tests assert: leads a crossing target
  (intent turns toward intercept, not current pos), releases fire when
  jammed, avoids rim (steers center near bounds).

## §5 Client spec

### C_NET — net.ts / prediction.ts

- Join path (the platform owns seating): connect to `ws(s)://host/ws`, then
  send the LOBBY envelope — `quick_join {name, game:'aces'}` for public
  rooms, or `create_private {name, game:'aces', settings}` (debug rooms set
  `settings.debug=true`). The room's own `welcome` arrives via addPlayer.
  NEVER send room-level `{t:'join'}` as the first message — the lobby drops
  it before a room exists. NetClient in seams.ts is the frozen surface.
- Input sender: samples the app-installed InputSource at 30 Hz, sends
  `{t:'input', seq++…}`.
- Interp buffer: snapshots appended; remote planes rendered at now−INTERP_MS,
  lerping x/y/h between bracketing snaps (h via shortest arc); bullets are
  NOT interpolated — rendered straight from newest snapshot (fast enough at
  15 Hz with tracer smoothing in effects).
- prediction.ts: local sim of OWN plane using shared `stepPlane` with pending
  input history; on snapshot reconcile against `you`: if pos error >
  NET.RECONCILE_SNAP_U → snap; else blend error down NET.RECONCILE_BLEND
  per frame; replay unacked inputs. Own HP/heat/boost read from server row
  (authoritative) but displayed smoothly.
- Reconnect: on close → app shows connection-lost screen with auto-retry at
  NET.BACKOFF_MS intervals, then a manual button. Rejoin/resume of the SAME
  seat after a dropped socket is OUT OF SCOPE v1: a successful reconnect
  mints a fresh seat (a bot has usually taken it); state that on the screen.

### C_APP — app.ts / main.ts

- Screens flow: menu (name persisted localStorage) → connecting → match.
  Esc toggles help/pause overlay (does NOT pause a multiplayer sim — label it
  "controls"). End screen on phase end; returns to live automatically.
- Loop: `requestAnimationFrame`, accumulator stepping render-side logic at
  60 Hz; camera: position eases toward own plane + velocity lookahead
  CAMERA.LOOKAHEAD_S; zoom eases CAMERA.ZOOM_MAX (idle) → CAMERA.ZOOM_MIN
  (full throttle); shake impulses consumed from effects API (own hits small,
  nearby blasts medium, own death large).
- Compositing order: world.drawBelow → crates → tracers/bullets → planes →
  effects particles → world.drawAbove (clouds occlude) → HUD canvas overlay
  → grain tile + vignette canvas (both pre-baked). All wrapped per-subsystem
  try/catch (RULES 5).
- `window.__ACES` debug surface (always present; harmless in prod): drives
  the frozen client path — `join({kind:'quick'}|{kind:'private',settings})`
  (lobby envelopes via NetClient), `spawn(cls)`, `state()` →
  {phase,tickets,timeLeftS,you,board}, `god()`, `warpTo(x,y)`, `giveCrate(x?,y?)`,
  `fastForward(ticks)` (debug `tick` verb), `muted()`. The e2e harness creates
  a private debug room and drives matches ONLY through this surface; nothing
  mutates client-side game truth directly.

### C_WORLD — render/world.ts

- `initWorldRenderer(canvas, map)` bakes static layers to offscreen TILES at
  NATIVE render resolution (the map is cut into a fixed grid of bake tiles —
  full-res crispness everywhere, bounded memory; half-res upscaling is
  banned: a soft world under crisp planes reads amateur): sea base with
  subtle value mottling (seeded), islands (sand ring → scrub → canopy palm
  clusters → rock outcrops from Island.rocks), airfield strips with team
  markings + parked dressing crates.
- Animated overlays drawn per-frame cheaply: drifting cloud shadows on sea
  (soft dark blobs, slow), sun-glint band shimmer, surf rings pulsing around
  island rims.
- `drawAbove(ctx, cam, t)`: 2 parallax cloud layers of soft cream puffs
  (alpha ≤0.78 so occlusion never hides gameplay — D4 outranks depth mood),
  drifting slowly east; planes pass UNDER them. Clouds never cover >35% of
  viewport and thin out over the central corridor.
- All colors APAL; shapes from map data only (no second source of truth).

### C_FX — render/planes.ts / effects.ts

- planes.ts: `drawPlane(ctx, snap: SnapPlane, opts)` AND `drawCrate(ctx,
  crate: CrateState, t)` — crates are entities drawn from server state
  (parachute while falling, canopy + ropes landed); everything else in
  effects. — pure vector top-down
  airframes per STYLE_BIBLE §7 silhouette law (scout: stubby round-cowl
  biplane; fighter: equal-span twin-gun; gunship: wide triple-wing), correct
  markings (ROYAL deck-cream roundel ring on navy wings; IRON black bar-cross
  on crimson), spinning prop blur arc, control-surface tilt with turn input
  (from h delta), invuln blink (alpha oscillation), damage tint (soot overlay
  scaling with missing HP), dead → not drawn (effects handles wreck).
- effects.ts: `EffectsSystem` owning bounded pools (~600 particles): muzzle
  flashes, tracer rounds (amber core, warm tail, slight glow), impact sparks,
  smoke trail emitter hook (called by app for smoking planes), fire emitters,
  explosion (flash bloom + radial debris shards + lingering dark smoke +
  foam-ring water splash variant when low over open water), crate parachute +
  landing puff + pickup sparkle. Emits shake impulses. Update(dt) + draw(ctx,
  cam). Seeded rng stream. Zero per-frame allocation (RULES 4).

### C_UI — ui/hud.ts / screens.ts

- hud.ts draws to a transparent canvas overlay: gun crosshair ahead of nose +
  amber lead pip when a target is in arc (uses aimLead), hit markers (× flash
  on confirmed hits), directional damage arcs (which edge you're shot from),
  offscreen enemy arrows at screen edge (nearest 3), heat bar under crosshair
  (warn color past 70%, JAMMED stamp), streak banners (ACE/LEGEND), kill
  feed entries (top right, icon-coded by class, ink on translucent paper).
- DOM layer (style.css classes owned here): bottom-left HP + boost cluster,
  throttle needle, top-center ticket bars ROYAL ◀ 12 · 14 ▶ IRON + clock,
  Tab scoreboard (two columns, MVP star, accuracy %), respawn overlay (3.5 s
  count → class cards SCOUT/FIGHTER/GUNSHIP with stat strips, keyboard 1-3 +
  click, shows spawn-protection note), menu/end/help screens (paper-poster
  styling per STYLE_BIBLE §8).
- Accessibility: team identity always paired with mark-shape + label letter
  (R/I); heat uses position+text not color alone; min 14 px HUD type at 1080p.

### C_AUDIO — audio/audio.ts

- Lazy AudioContext on first gesture; master mute toggle (M) persisted.
- Engine: sawtooth+lowpass drone pitched by own speed/throttle, subtle LFO
  wobble; distant planes mixed ≤ 3 concurrent by proximity.
- Guns: filtered noise bursts at volley rate — own guns crisp, others
  distance-lowpassed; hit tick (metallic ping) on YOUR hits; thud+grit when
  YOU are hit; explosion = noise burst + sub sine drop, distance-scaled.
- Ambience: soft wind noise bed tied to own airspeed; crate chime; UI clicks;
  overheat clunk + jam rattle; ACE/LEGEND two-note stinger; victory/defeat
  motifs (major lift vs minor fall, ≤ 4 notes each).

### visual.ts (frozen client vocabulary)

- `mixA(a,b,t)`, `shadeA(key,f)` (palette-key-typed helpers), `withAlpha(key,a)`
- `poly(ctx, pts)`, `star(ctx,x,y,points,r1,r2,rot)` for roundels/bar-crosses/markers,
  `softPuff(ctx,x,y,r,colorInner,colorOuter)` radial puff factory — clouds/smoke/
  blast share ONE puff model; colors passed via withAlpha (solid inner, transparent outer)
- `makeGrainTiles(seed,n)` + `drawGrain(ctx,w,h,tiles,tick)` — pre-baked film-grain
  pattern fill (the ONLY sanctioned grain path; one fillRect per frame)
- `makeVignette(w,h)` — baked vignette canvas, drawn last (the ONLY sanctioned vignette)
- `makeRng(seed)` (re-export wrapper of mulberry32), `hashStr(s)` for per-bot/per-instance seeds
- `fitCanvas(canvas)` DPR-aware sizing capping DPR at 2

## §6 Balance targets (all DERIVED from config.ts — the table there is law)

- Max DPS: scout 72 · fighter 110 · gunship 120. Continuous-fire windows to
  jam: scout 5 s / fighter 6 s / gunship 4 s. TTK fighter-vs-fighter:
  0.9 s perfect, ≈1.8 s at expected (≈50%) accuracy. Fighter kills a gunship
  in ≈3 s expected; a gunship deletes a fighter in ≈1.7 s expected but must
  do it inside its short window while flying the slowest platform — that
  asymmetry is the class system.
- Boost: full burn = 2.6 s of ×1.42; converts to escape OR closure; spam
  punished by BOOST_DRAIN.
- Tickets to 25 at 4v4 normal bots lands ≈ minute 5–8 (crashes credit no
  ticket); time cap + sudden death backstop it.
- Crates: one heal flips a losing duel; ≤2 alive keeps map knowledge mattering
  without camping being profitable.

## §7 Done definition per module

Each module: strict-typechecks, unit tests green, honors RULES, honors
seams above, no TODO/stub left in owned files. Integration done when: gates
green repo-wide, e2e script passes (join → live match vs bots → kill happens
→ scoreboard updates → zero console errors), captures judged to bar.

# OUTPOST — design + module contract (frozen)

The platform's sixth game: co-op zombie wave-defense FPS. Three.js client, server-authoritative
simulation built on **STRICKEN's engine** — OUTPOST is a new game that imports `@fps/shared`'s
movement, collision and hitscan wholesale rather than re-deriving them, and that import is the
whole reason its tower does not eat players (see "Engine reuse" below).

**1–16 survivors hold a fenced compound around a wide watchtower against endless waves of the
dead. The tower keeps you alive. The ground is where the run is decided. The run ends the instant
no survivor has status `alive`** — the moment the last standing player goes down. Downed survivors
then bleed out and die, but the run is already over by then; death is not what ends it, the loss of
the last `alive` status is. There is no win screen — the run always ends in defeat. A solo run is
12–20 minutes; a coordinated squad reaches 15–20 waves before it, too, is eventually lost.

What OUTPOST deliberately is **not**: no defendable "core" object to lose (the previous build's
generator ended runs with everyone still alive, and was also the hero object no screenshot ever
contained), no bot survivors (wave size scales to headcount instead), no perks or tech tree (three
scrap sinks on one currency is the whole economy), no round timer (a wave ends when it is dead).

---

## The RIDGELINE map

One map, `shared/src/map.ts`. A 14×14 m timber watchtower (`TOWER_HALF = 7`) stands at the centre
of a fenced compound `2×FENCE_HALF` = **40×40 m** on a side, enclosed by 16 fence segments (4 per
side, `SEG_LEN` = 10 m each, one of the north side's four doubling as the gate). Beyond the fence,
a flat mud plateau runs out to `PLATEAU_RADIUS` = 84 m; the horde spawns on a ring at `HORDE.spawnRing`
= 58 m — just inside the treeline's leading edge — and closes the remaining 38 m to the fence on
foot.

The tower has three levels, each reachable from the one below it **by walking, with no jump
required**:

```
ground (footing top, y=0.4) --external south stair--> deck 1 (y=4.0) --internal stairwell--> deck 2 (y=8.0, spawn deck)
```

- **Ground floor** — the ammo crate. Reached by an external staircase on the tower's south face
  (12 steps, each rise `STAIR_RISE` = 0.333 m, well under `PLAYER.stepUp` 0.42).
- **Deck 1** — the weapon rack, halfway up. Reached from ground via the same external stair; reached
  from deck 2 via an internal stairwell that climbs back up through a real opening cut in the deck-2
  slab, so nothing is ever buried under anything else.
- **Deck 2** — the 16 survivor spawn points, arranged in a ring facing outward. This is the "safe"
  deck: zombies that climb the stairs can reach it too (see pillar 1 below), but nothing spawns here
  but survivors.

Every walkable surface in `map.ts` is the top face of an AABB and every rise the player or a zombie
climbs is ≤ `PLAYER.stepUp`; there are no ramps, no slopes, and no custom ground query anywhere in
the map data. `mapTopology.test.ts` walks the full ground→deck1→deck2 round trip, in both
directions, with forward input only, and is the frozen guard that keeps this true — it is never
weakened.

The fence firing step (`FENCE.stepHeight` = 0.4 m, walkable) puts a defender's eye at exactly the
height needed to shoot over a 1.6 m fence at zombie range; that 1.6 m figure — not the more obvious
2.0 — is itself a frozen balance decision (`config.ts`'s `FENCE` block) after 2.0 m measured as
literally unhittable from the step for three of the four zombie kinds.

---

## The phase machine

```
lobby ──START──▶ opening lull (8s) ──▶ wave 1 ──cleared──▶ intermission (22s) ──▶ wave 2 ──▶ …
  │                                       │                        │
  │                                       │                        └─ dead survivors return
  │                                       └─ every survivor downed/dead ──▶ ended
  └─ the room NEVER auto-starts — handleStart is the only way out of lobby
```

- **`lobby`** — seated players, an explicit START button. The room does not auto-start at any
  player count.
- **`wave`** — zombies drip in from the treeline ring at a rate scaled by both the wave number and
  the player count (the same headcount factor that scales wave size, so a 16-player wave doesn't
  silently take 17 minutes just to finish spawning). Survivors shoot from the top deck (safe, slow),
  the firing step (fast, exposed), or open ground once a breach lets the horde inside.
- **`intermission`** (22 s) — repair fence segments, buy at the weapon rack, restock at the ammo
  crate, dead survivors return for the next wave. 22 seconds is deliberately not enough to do
  everything; choosing what to skip is the strategic layer.
- **`ended`** — triggered the instant `isSquadWiped` becomes true (no survivor has status `alive`).
  Emits `run_end` with per-survivor stats: kills, headshots, damage, fence HP repaired, revives
  given, times downed — so a player who spent the run repairing finishes able to point at a number.

Server tick order is fixed (several bugs in the previous build were ordering bugs): `advancePhase →
ingest inputs & step survivors → resolveInteract → stepRevives → stepDowned → stepHorde → stepSpits
→ checkSquadWipe → snapshot`.

---

## The horde — four kinds, four unlock waves

Four silhouettes, distinguishable at 40 m by shape alone (`ZombieKind` in `shared/src/types.ts`,
stats in `config.ts`'s `ZOMBIE_BASE`):

| Kind | Unlocks | Silhouette | HP | Speed | Role |
| --- | --- | --- | --- | --- | --- |
| **Shambler** | wave 1 | Hunched, head below shoulders, wide slow stagger — a lowercase "n" | 90 | 1.7 m/s | The baseline horde. Closes the 38 m approach in ~22 s. |
| **Runner** | wave 3 | Upright, lean, head thrust ahead of the chest, narrow — an arrow | 55 | 4.4 m/s | Closes the same 38 m in ~8.6 s. Breaks the habit of standing still to aim. |
| **Brute** | wave 6 | 2.5 m tall, enormously wide shoulders, tiny sunken head — a "T" twice as wide as anything else on screen | 420 | 1.9 m/s | Opens a fence segment alone in 4.6 s of contact (320 HP / 70 fence-dps). Forces a repair trip. |
| **Spitter** | wave 8 | Distended barrel torso, thin limbs, head tipped back — a lightbulb on legs | 110 | 2.2 m/s | Ranged acid lobbed over the parapet. Ends free turtling on the top deck. |

Composition weights (`WAVES.weight`) keep shamblers the bulk of every wave even once the other
kinds unlock, so the horde's silhouette language stays readable. Zombie HP scales with wave number
(`WAVES.hpGrowth`, capped at `hpCapMul` = 3.5×). Fence damage is continuous — `fenceDps * dt` every
tick a zombie is in contact with a segment — not a per-swing hit; `meleeInterval` governs swings at
survivors only. Wave 10+ mixes composition and the alive count runs past `HORDE.maxAlive` (48), so
the horde arrives as a continuous stream rather than discrete waves.

---

## Economy — one currency, three sinks

Scrap is earned per kill (12/16/45/28 for shambler/runner/brute/spitter, ×1.5 on a headshot) plus
a small assist cut for damage dealt without the kill. It competes across exactly three sinks —
deliberately no fourth, no perk tree:

1. **Weapons**, bought at the deck-1 rack: shotgun (200, affordable ~wave 3), SMG (300), rifle
   (550, ~wave 6), sniper (900, ~wave 10). Two firearm slots plus an always-carried knife.
2. **Ammunition**, restocked at the ground-floor crate: a full refill costs 60 scrap, roughly five
   shambler kills — frequent enough to be a real budget line, cheap enough that running dry is a
   choice, not a punishment.
3. **Fence repair**, done standing at the wall: 0.35 scrap/HP, ~26 HP/s. Fully repairing one
   destroyed segment (320 HP) costs 112 scrap and 12.3 s; a *breached* segment costs 1.5× and
   rebuilds at half rate (168 scrap, 24.6 s) — letting a segment breach is roughly a wave's income,
   which is the pressure that makes leaving the tower to repair worth it before that happens.

Wave 1 (8 shamblers, solo) is survivable with the issued pistol and zero repairs; a solo player
finishes it with ~96 scrap, not enough for anything — the first real purchase decision lands at
wave 2–3.

---

## The vertical layout is the pacing mechanism

This is the design pillar the whole tower is built to serve, not incidental level art: **the ammo
crate sits on the tower's ground floor**, the weapon rack halfway up on deck 1, and repairs can
only happen down at the fence — while the safest place to fight from, deck 2, does none of those
things. Height buys sightlines and distance, not immunity: from deck 2 a survivor cannot repair the
fence, cannot restock ammunition, and damage falloff means they kill too slowly up there to save the
fence they're standing over. Turtling on the top deck loses in slow motion, because reserves are
finite and the crate that refills them is three storeys down — and once a fence segment breaches,
zombies climb the same stairs survivors do (they collide via the identical `stepBody` step-up), so
turtling stops being safe at all. The player's minute-to-minute question is always **"can I afford
to go down right now?"** — and putting the crate on the ground floor, as far from the safe deck as
the tower allows, is what makes that question real every single wave instead of only at the start.

---

## Engine reuse — what OUTPOST takes from STRICKEN, and why

`games/fps/**` is read-only; OUTPOST imports from `@fps/shared` and never modifies it:

| From `@fps/shared` | Used for |
| --- | --- |
| `stepBody`, `makeBody`, `eyePos`, `BodyState`, `AABB` | ALL movement and collision — survivors AND zombies alike |
| `hitscan`, `raycastSolids`, `playerHitboxes`, `falloffMul`, `aimDir`, `applySpread`, `shotSeed` | ALL shooting (`HitscanTarget.id` is a plain string, so zombies drop straight into the same hitscan STRICKEN uses on players) |
| `WEAPONS`, `WeaponId`, `WEAPON_ORDER` | The guns, verbatim — only `ECONOMY.weaponPrice` differs |
| `PLAYER`, `TICK_RATE` | Movement tuning and the 30 Hz sim rate |
| `PALETTE` | The inherited colour ramp, re-exported through `@outpost/shared/palette` |

**Why this is the load-bearing decision in the whole build:** the previous OUTPOST hand-rolled its
own physics, and its ground query ran *after* gravity was applied — so every floor of its tower was
a trapdoor, and a player standing on the spawn deck fell straight through to y=0 in 1.5 seconds.
"Until this is fixed, no screenshot of this map is evidence of anything" was the verdict on that
build. `stepBody` is AABB collide-and-slide with step-up, already shipped and proven on six STRICKEN
maps; every walkable surface in RIDGELINE is the top face of an AABB and every rise the physics has
to climb is bounded by `PLAYER.stepUp`. Reusing it — rather than writing a seventh custom ground
query — is what makes the entire trapdoor-floor class of bug structurally impossible here instead of
merely fixed once: the same step function that carries a survivor up the external stair carries a
zombie up it too, on the identical persistent `BodyState`, so there is exactly one collision
routine in the game and it has already been proven correct by five other maps.

One deliberate seam: `Zombie.height`/`.radius` (and `ZombieStats.height`/`.radius`) are
presentation and melee-reach only — every actor, survivor or zombie, shambler or brute, collides as
the same 0.6 m-wide, 1.8 m-tall box, because `stepBody` isn't parameterised per-actor and `@fps/shared`
can't be edited to make it so. A brute really is a taller *target* to shoot (hitscan does honour
`HitscanTarget.height`), just never a wider *obstacle*.

---

## Packages & files

- `games/outpost/shared/` (`@outpost/shared`) — `types.ts` (every cross-module type + protocol +
  debug API), `config.ts` (every balance constant), `map.ts` (RIDGELINE geometry), `palette.ts`,
  `protocol.ts` (wire validation, never throws), `index.ts` (barrel). All frozen.
- `games/outpost/server/` (`@outpost/server`) — `waves.ts` (wave size/composition/stats, pure),
  `horde.ts` (zombie steering/combat/fence damage, pure), `fence.ts` (damage/repair/breach, pure),
  `survivors.ts` (damage/downed/revive/interact, pure), `combat.ts` (hitscan against zombies, pure),
  `room.ts` (the server integrator — `OutpostRoom implements GameRoomHandle`, owns the tick loop,
  phase machine, and snapshot assembly), `module.ts` (registry plug).
- `games/outpost/client/` (`@outpost/client`) — `src/contract/visual.ts` (frozen shared visual
  vocabulary: `mat`/`box`/`cyl`/`cone`/`sphere`/`articulate`/`bake`), `src/render/` (`scene.ts`,
  `world.ts`, `outpost.ts`, `zombies.ts`, `survivors.ts`, `effects.ts`), `src/net.ts`, `src/input.ts`,
  `src/game.ts` (the client integrator), `src/ui/` (`hud.ts` — the fence-ring HUD, `menus.ts`),
  `src/audio/audio.ts` (synthesized WebAudio), `src/main.ts` (boot + `window.__outpost` debug API).

The design/style/UX intent lives in `games/outpost/DESIGN_BIBLE.md`, `STYLE_BIBLE.md` and
`UX_BIBLE.md`; the full public shape of every file above is frozen in `games/outpost/CONTRACT.md`.
This document summarizes both for anyone landing in the codebase without re-reading all four.

---

## Run it

```bash
npm install
npm run dev   # server :8080 · ... · outpost :5179
```

Open the OUTPOST client at **`/outpost/`** through the platform dev proxy, or directly at
`http://localhost:5179/` while `npm run dev` is running. `DEV_PORT = 5179` is frozen in
`config.ts` — the platform dev proxy probes this exact number, so it never drifts.

```bash
npm run build && npm start   # single process, http://localhost:8080/outpost/
```

## Verify it

```bash
npm run typecheck     # strict TS across all workspaces, including @outpost/*
npm test               # unit suites: waves/horde/fence/survivors/combat/room + mapTopology guard
npm run e2e:outpost    # node scripts/e2e-outpost.mjs
```

`e2e-outpost.mjs` is a two-browser Puppeteer suite modelled on the mature `scripts/e2e-splat.mjs`:
separate browser per client, four error channels watched (console/pageerror/crash/requestfailed),
an in-page phase recorder so fast transitions aren't missed. It asserts, at minimum: the full
`window.__outpost` debug surface exists · the lobby does NOT auto-start · START moves the room into
wave 1 · a shot kills a zombie and scrap increases · a fence segment takes damage and can be
repaired · **two clients — one goes down, the other revives them** · a breach opens and zombies path
inside · draw calls stay ≤ `PERF.maxDrawCalls` (420) and frame time ≤ `PERF.maxFrameMsUnderLoad`
(33 ms), measured with `HORDE.maxAlive` zombies alive (spawned via the debug API, not whatever two
test clients happen to have produced) · squad wipe ends the run with stats · every screenshot is
non-trivial · zero console/page errors on every page.

The companion capture harness, `scripts/capture-outpost.mjs`, frames every shot from
`window.__outpost.mapInfo()` — never a hard-coded coordinate, which is exactly how the previous
build's capture script ended up photographing bare ground for a whole judging round after its map
geometry moved out from under it. After every capture it checks the PNG against `VISUAL_GATES` from
`config.ts` and **fails the run** (non-zero exit, not a warning) on: any modal overlay present;
too-small a file; median luma or surface-stddev too low (a flat, undetailed frame); near-field
blowout share too high; and — the gate written specifically to prevent the previous build's silent
"0.00% of the intended horde colour, in every frame, with zombies alive" failure — a horde-pixel
share below `minHordePixelShare` whenever ≥ `hordeMinZombiesForGate` zombies sit within
`hordeGateRadius` of the camera. That horde gate is an assertion, not a conditional exemption: a
capture run where the horde never showed up close enough to measure is a **failed** run, not an
exempt one.

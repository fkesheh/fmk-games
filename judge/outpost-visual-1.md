# OUTPOST — Art Director Review #1

**Verdict up front: FIX.** Average **3.2 / 10**. Five of six axes are below the 6.0 passable
line. This is not a polish pass — the game's core readability thesis is not on screen.

---

## 0. The delivered judge set is invalid — I had to re-capture

All 8 PNGs in `screenshots/outpost/` are **unjudgeable**. Every one of them shows the same
thing: three stacked HTML modals over a black rectangle.

Measured (sampling outside the modal, every 7th pixel):

| Frame | mean luminance | max | distinct colour bins |
|---|---|---|---|
| all 8 outpost shots | **12.0 / 255** | 57 | **5** |
| `aaa-fps-maps-1.png` (STRICKEN) | 123.4 | 214 | 37 |
| `map-bunker-1.png` (STRICKEN) | 56.2 | 229 | 51 |

Five distinct colour bins in an entire 1920×1080 frame. There is no image there.

**Three separate bugs conspired to produce this**, and all three are real:

1. **`main.ts:102` — `window.addEventListener('blur', () => game.setPaused(true))`.**
   A headless Puppeteer page never holds focus, so the PAUSED overlay is up in every
   capture. Not a capture-only bug: alt-tabbing in a co-op game pauses *your* client while
   the server keeps running the horde.
2. **Overlay stacking has no mutual exclusion.** Buy menu (WEAPON RACK) + PAUSED +
   OUTPOST LOST are all mounted simultaneously. `style.css:65` `.op-overlay` uses
   `background: color-mix(in srgb, var(--ink) 78%, transparent)`. Three of them stack:
   remaining transparency = `0.22³ = 0.0106`. **The 3D world is being multiplied by 1%.**
   `--ink` is `#0a0c10` (lum 11) — which is exactly the measured mean of 12. The math is
   airtight. `ui/menus.ts` must enforce one overlay at a time (a single `activeOverlay`
   slot; opening one closes the others).
3. **`scripts/capture-outpost.mjs:50` — `await sleep(9000)` after `start()`, with an AFK
   player.** One stationary survivor, zero input, wave-1 horde walks over and eats them →
   `squad_wiped` (`server/src/room.ts:797`) → OUTPOST LOST, **WAVE REACHED 0**. The
   capture harness kills the player before it takes a single photograph.

I re-captured with the modal stack suppressed (`.op-overlay{display:none}`) and a 2.5s
delay. **The game itself is healthy** — this was purely a capture failure:

```
phase=wave  wave=1  drawCalls=81→96  frameMs=1.0–1.9  hp=100  zombiesAlive=1→4  errors=[]
```

Everything below judges **those** frames. Scores are for the art, not the broken harness.

### Re-measured on valid frames (HUD regions masked out)

| Frame | mean | p50 | p90 | **% below lum 20** | **% zombie-green px** |
|---|---|---|---|---|---|
| p-courtyard | 17.6 | 18 | 26 | **58.8%** | **0.00%** |
| p-north | 13.1 | 3 | 24 | **74.8%** | **0.00%** |
| p-west | 17.7 | 17 | 26 | **60.4%** | **0.00%** |
| p-core | 14.3 | 9 | 29 | **64.5%** | **0.00%** |
| *STRICKEN aaa-fps-maps-1* | *108.7* | *104* | *195* | *2.0%* | — |
| *STRICKEN map-bunker-1* | *61.0* | *51* | *92* | *3.0%* | — |

Two numbers define this review:

- **~65% of every frame is functionally black.** STRICKEN sits at 2–3%. The p90 is 24–29,
  meaning **90% of the image lives in the bottom 11% of the tonal range.**
- **0.00% sickly-green pixels, in all four frames, with 1–4 zombies alive and on screen.**
  The single sentence the STYLE_BIBLE builds everything on — *"the horde is the one
  saturated element, so it always reads against every surface"* — is **completely unmet**.

---

## 1. Composition — **3 / 10**

What's actually wrong, not "it's dark":

- **The horizon is a dead-flat horizontal line at almost exactly frame centre**, running
  uninterrupted from x=0 to x=1920 in courtyard/north/west. It splits every frame into two
  equal bands: empty violet sky on top, black void below. No foreground element breaks it,
  no leading line, no depth cue between "wall at 20m" and "wall at 60m".
- **The subject of the frame is the lantern posts** — they are the brightest thing, so the
  eye goes there. The subject *should* be the breach and the horde coming through it.
- **The core — the object the entire game mode is about defending — is not in a single
  intentional frame.** It's an accidental blob in the top-right of `p-west` and top-left of
  `p-north`, and it is *absent* from `core-lantern`, the shot named after it.

**Fixes:**
- `scripts/capture-outpost.mjs:52-60` — the shot list is aimed from spawn `(-4.5, 0, -4.5)`
  with hardcoded yaws that don't point at anything. Aim shots at *map features*: derive yaw
  from `OUTPOST_MAP` breach/core positions rather than literal `Math.PI/2` constants. The
  `core-lantern` entry at `[0, -0.5]` looks at bare ground.
- `render/outpost.ts` — give the perimeter a **vertical rhythm**: raise the four breach
  towers 1.5–2m above the 3.2m curtain wall so the silhouette has peaks and the horizon
  stops being one flat line. Currently every `makeWall` segment is the same height.
- `render/terrain.ts:402-408` — `DEAD_TREES` are placed in `ringClusters(rand, DEAD_TREES,
  22, 74)`, i.e. all *outside* the wall at 22–74m, where they render as pure black against a
  dark sky and contribute nothing. Push a handful onto the ridgeline so they read as
  **silhouettes against the bright horizon band** — that's where a dead tree earns its keep.

## 2. Colour cohesion — **3 / 10**

Credit where due: I found **no ad-hoc hex**. `kit.ts:35-53` routes every material through
`PALETTE` via `mat()`/`glowMat()`, and `viewmodel.ts` only imports `makeBox`/`makeCyl`
(which are palette-keyed). Contract compliance on *sourcing* is clean.

The problem is that palette compliance on paper produced **zero palette on screen**:

- **The zombie ramp contributes 0.00% of pixels.** `zskin` `#7a8f3a` at ~0.2 effective
  ambient renders to roughly `rgb(24,28,12)` — a black-brown, not a sickly green. The
  colour is *technically correct and visually absent*. That is the whole ballgame.
- **`lanternCore` `#ffd89a` is doing far too much work and is the only value outlier.**
  It is simultaneously: the key light colour (`scene.ts:257`), the lantern bulbs
  (`scene.ts:578-583`), the perk-station status light (`outpost.ts:291-293`), *and* the core
  sphere (`outpost.ts:485`). Four different storytelling roles, one flat pale cream. In
  `p-north`/`p-west` the core reads as a **giant unlit marshmallow** — a lumpy pale dome
  with no gradient, because a `glowMat` emissive at intensity 1 is just flat fill colour.
- **The lantern bulbs read as white golf balls on sticks**, not warm glass. Same cause:
  `makeSphere(0.15, 8, 6, 'lanternCore')` + `glowMat(..., 1.4)` = a flat pale disc.

**Fixes:**
- `render/zombies.ts` — see axis 5. Nothing else on this axis matters until the horde reads.
- `render/outpost.ts:485` — the core sphere must **not** be `lanternCore`. Give the core its
  own identity: `glowMat('lantern')` (`#ffb35c`, properly orange) for the sphere with a
  `metalDark` cage/conduit structure crossing in front of it, so it reads as *machinery
  holding a light* rather than a smooth ball. Right now `makeSphere(r, 14, 10)` shows its
  low segment count as visible lumpiness at that size.
- `render/scene.ts:578-583` — bulbs to `glowMat('lantern')` not `lanternCore`, and shrink
  them; reserve `lanternCore` for the *hottest* pixel in the frame only (the very centre of
  the core), so the palette has a value hierarchy instead of four objects tied at the top.

## 3. World density — **5 / 10** *(the strongest axis)*

The compound is genuinely populated. `p-core` shows crates, ramps, a raised platform, the
wooden gate, the buy-station rack with its `pointsGold` price sign, and lantern posts at
roughly the specified ~6m spacing. `terrain.ts` is 531 lines and clearly does the work.
`drawCalls` at 81–96 against a 220 budget confirms real instanced geometry is present.

Why it still fails the bar:

- **You cannot feel any of it**, because 65% of it is below lum 20. Density that renders
  black is indistinguishable from an empty plane. This axis is being held hostage by axis 4.
- **Outside the wall is genuinely empty.** The contract asks for 8–12 dead trees / antenna
  stubs; against a dark sky at 22–74m they are invisible in all four frames. The area beyond
  the wall reads as void, which kills the sense that the fort is *besieged*.
- **The ground planes are enormous flat single-colour polygons** with hard straight edges
  (the rust-brown slabs filling the lower third of `p-core`). The contract's "subtle 0.2–0.5m
  heightfield" is not visible as any value variation at all.

**Fixes:**
- `render/terrain.ts` — the heightfield exists in spec but reads flat because a Lambert
  surface only shows height variation when a light *rakes across* it. After the axis-4 fix,
  verify it reads; if not, increase amplitude to the top of the 0.2–0.5m band and add
  `mudDeep` patch decals so the floor has tonal break-up independent of lighting.
- `render/terrain.ts:407` — move the inner ring of `treeSpots` from 22m to ~14–18m so a few
  dead trees fall *inside* the fog's 14–90m band and catch lantern spill.

## 4. Lighting / mood — **3 / 10**

**I found the root cause of the entire black-frame problem.**

`render/scene.ts:273-277`:
```ts
this.hemi = new THREE.HemisphereLight(
  new THREE.Color(PALETTE.skyDusk),   // #3a2f4d → (0.227, 0.184, 0.302)
  new THREE.Color(PALETTE.mud),       // #3a332a → (0.227, 0.200, 0.165)
  1,                                  // ← intensity 1
);
```

A `HemisphereLight`'s **colour multiplies its intensity**. Both of these swatches have
channel values around **0.2**. So an intensity of `1` delivers an effective ambient fill of
roughly **0.2** — five times weaker than the author intended. Meanwhile the key at
`scene.ts:257` uses `lanternCore` `#ffd89a` → `(1.0, 0.85, 0.60)`, which is near-full
brightness.

**Result: a ~5:1 key-to-fill ratio with nothing in the shadows.** Only surfaces facing the
sun get lit — which is precisely what the frames show: illuminated wall crenellation caps,
and absolute black everywhere else. This is why shadows don't read either: real-time shadows
*are* enabled (`scene.ts:221-222`, PCFSoft, 2048), but a shadow cast into an already-black
courtyard is invisible. **You are paying full price for a shadow map that renders nothing.**

The genuinely good news, and it's real: **the sky and the lantern pools are the best work in
the build.** The violet-zenith → warm-horizon gradient reads exactly as the bible describes,
the fog is correctly matched to it, and the warm falloff on the wall faces around each post
is convincing. That part is right — it's just floating in a void.

**Fixes (in priority order):**
- `render/scene.ts:273-277` — **raise the hemisphere intensity to compensate for the dark
  colour swatches.** Either bump intensity to ~3.5–4.5, or (cleaner) keep intensity ~1 and
  pass value-normalised colours — a `skyDusk` hue at ~0.75 value for the sky term and a
  `mud` hue at ~0.5 for the ground term. Target: the p50 of the 3D region moves from 3–18 up
  into the **45–60** range, and *"% below lum 20"* drops from 65% to **under 10%**. Those are
  the acceptance numbers; re-run the histogram to confirm rather than eyeballing it.
- `render/scene.ts:485 / outpost.ts:485` — **the core emits no light.** It is an emissive
  sphere with zero illumination contribution, so the beacon lights nothing. Spend one of the
  6 pooled `PointLight`s (`MAX_POINT_LIGHTS`, currently all 6 go to lantern posts) as a
  permanent warm light *at the core*, pulsing with core HP. This is the single highest-value
  lighting change available: it makes the compound centre a warm pocket and gives the
  "last light" premise a physical presence.
- `render/scene.ts:218-219` — with the fill fixed, re-check `toneMappingExposure = 1`. ACES
  rolls off the shadows hard; ~1.15–1.25 will likely be needed to keep the mids where you
  want them.

## 5. Silhouette readability — **2 / 10** *(worst axis, and the most important one)*

With 1–4 zombies confirmed alive and in frame, I could locate exactly **two**, and only
because they occluded a lit wall behind them:

- `p-courtyard` — a dark humanoid smudge at roughly (700, 490)
- `p-core` — a dark humanoid smudge at roughly (650, 200)

Both are **pure black cutouts**. I cannot distinguish Shambler from Runner from Brute. I
cannot tell they are zombies rather than fence posts. **Zombies are not the obvious threat —
the lanterns are**, because the lanterns are the only bright thing.

The bible's mitigation for exactly this — *"Zombies carry a faint `zeye` emissive so the
horde reads in the dark"* — is **specified and implemented but doing nothing**.
`zombies.ts:100` declares `readonly eye: Accent; // head-local, glowMat('zeye')` and the
accent-batch architecture is there, but at gameplay distance the eye quads are sub-pixel and
`zeye` `#c9e84f` at emissiveIntensity 1 has no bloom to spread it. Zero green pixels
measured. The safety net has a hole the size of the horde.

**Fixes:**
- `render/scene.ts` (fill) is a prerequisite — once ambient is correct, `zskin` `#7a8f3a`
  will render as an actual green and the horde will separate from the concrete/mud world on
  hue, which is what the palette was designed for. **Re-measure `% zombie-green pixels`
  after that change; it must be non-zero with zombies on screen.** That is the gate.
- `render/zombies.ts` — the eye accents need to survive distance. Raise
  `glowMat('zeye', …)` intensity substantially and **scale the eye quads with distance**
  (a minimum world-space size, or a camera-facing sprite with a floor on screen-space size)
  so the horde reads as a field of green points in the dark at 30m+. This is the CoD-Zombies
  / L4D read and it is currently absent.
- `render/zombies.ts` — the per-kind silhouettes are *modelled* correctly per the sheets
  (I verified Shambler/Runner/Brute use distinct `zskin`/`zskinLit`/`zskinDark` massing at
  `zombies.ts:121-148`). They just aren't lit. Once they are, verify at 25–40m that Brute
  vs Shambler is callable in under half a second, and add a **`zskinLit` rim/top accent** on
  the Brute's shoulder mass if it isn't — the biggest threat must be identifiable first.

## 6. Programmer-art smells — **3 / 10**

Present and damning:

- **No viewmodel visible.** `render/viewmodel.ts` is 532 lines and *does* build a weapon —
  I can find it as a dark blue-black angular shape at roughly (1150–1400, 900–1080) in
  `p-core` and `p-west`. It is present and **completely unlit**, because it uses the same
  world-lit Lambert materials as everything else. Next to STRICKEN — where the gun reads
  crisply bottom-right and immediately says "first-person shooter" — OUTPOST reads as a
  walking sim. **A first-person viewmodel must never depend on world lighting.**
- **The core reads as a giant marshmallow** (axis 2). The centrepiece object of the game
  mode is the strongest programmer-art tell in the build.
- **Lantern bulbs read as white golf balls on sticks.**
- **Huge flat single-colour ground polygons** with hard straight edges and zero variation.
- **Empty sky.** The top ~30% of every frame is a clean gradient containing nothing — no
  moon, no cloud banding, no distant skyline. STRICKEN puts drifting shapes in its sky and
  it reads far better for it.
- **Everything is the same brightness — specifically, the same brightness of black.** p90 of
  24 on a 255 scale is the textbook signature of this smell.

Not smells, and worth stating plainly: no default materials anywhere, no floating geometry
observed, nothing thin or spindly, and **the HUD is genuinely good** — the wave/zombie
counter, CORE %, N/S/E/W barricade HP chips, HP bar, ammo, crosshair and the `BUY STATION · B`
world prompt are clean, well-typed, correctly palette-keyed and better composed than most of
the 3D. The HUD is not the problem.

**Fixes:**
- `render/viewmodel.ts` — **give the viewmodel its own lighting.** Either put it on a
  dedicated layer with a camera-attached warm light rendered in a second pass, or (cheaper
  and adequate here) build it from materials with a strong baked `emissive` floor so it holds
  a readable value regardless of where the player stands. It must read at the same clarity as
  STRICKEN's gun in `aaa-fps-maps-1.png`.
- `render/scene.ts` — add a **moon disc** near the warm horizon band (it also motivates the
  key light, which currently comes from nowhere) and 2–3 flat `skyDusk`-tinted cloud bands
  on the dome. Cheap, no draw-call pressure, fills the dead 30%.
- `render/effects.ts` — nothing is firing in these frames, so muzzle/tracer/blood are
  unjudged. **Re-capture with `fireOnce()` driven** so the fx get a review; a dusk scene lives
  or dies on its muzzle flash and this build has never been photographed shooting.

---

## Scores

| # | Axis | Score |
|---|---|---|
| 1 | Composition | **3** |
| 2 | Colour cohesion | **3** |
| 3 | World density | **5** |
| 4 | Lighting / mood | **3** |
| 5 | Silhouette readability | **2** |
| 6 | Programmer-art smells | **3** |
| | **Average** | **3.2** |

---

## VERDICT: **FIX** — avg 3.2 (bar 7.5); five axes below 6

**Top 3 must-fix, in order:**

1. **`render/scene.ts:273-277` — the hemisphere fill is ~5× too weak.** Its colour
   (`skyDusk`/`mud`, both ~0.2 value) multiplies its intensity of 1. Fix the intensity or
   value-normalise the colours. **Gate: p50 luminance of the 3D region ≥ 45, and "% below
   lum 20" < 10%** (currently 3–18 and ~65%). This one change unblocks axes 3, 4, 5 and 6 —
   nothing else should be attempted before it lands.
2. **`render/zombies.ts` — the horde is invisible; 0.00% green pixels in every frame.**
   After fix #1, boost `glowMat('zeye')` and enforce a minimum screen-space size on the eye
   accents so the horde reads as green points at 30m+. **Gate: non-zero zombie-green pixel
   share with zombies on screen, and Brute vs Shambler callable at 30m.** The style bible's
   central promise is currently unkept.
3. **`scripts/capture-outpost.mjs` + `ui/menus.ts` + `main.ts:102` — you cannot judge what
   you cannot photograph.** Enforce one overlay at a time in `menus.ts`; don't pause on
   `blur` when a match is live (`main.ts:102`); and stop the capture harness leaving an AFK
   player to be eaten for 9 seconds before the first shot (`capture-outpost.mjs:50`). Also
   re-aim the shot list at real map features and drive `fireOnce()` so `render/effects.ts`
   gets reviewed at all. **This round cost a full judge cycle and produced eight photographs
   of a black rectangle.**

**Honest summary:** the underlying build is in much better shape than the delivered
screenshots suggest — it runs clean at 96 draw calls with zero console errors, the geometry
and palette discipline are real, the sky and lantern falloff are genuinely good, and the HUD
is strong. But it is being rendered into a 5:1 key-to-fill void that swallows two-thirds of
every frame, and the sickly-green horde that the entire art direction is built around
contributes **literally zero pixels**. Against STRICKEN it does not currently read as
programmer art — it reads as **an unlit scene**. Fix the fill light first; most of this
report dissolves behind it.

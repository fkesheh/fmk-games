# UX BIBLE — OUTPOST

Comprehension and control — distinct from the style bible, which owns mood. This is what the player
must be able to *read* and *do*. Embedded verbatim in every UI implementer's prompt and used by the
UX-director judge.

The previous build's HUD was the one thing both art directors praised — *"genuinely good… better
composed than most of the 3D. The HUD is not the problem."* Keep that bar and add what a 16-player
co-op defence needs that a solo horde shooter does not.

---

## Information hierarchy

**Tier 1 — always visible, readable without looking away from the fight:**

1. **The fence ring.** The signature element. A square ring of 16 ticks mirroring the compound's
   real geometry, oriented to the player's facing, each tick showing its segment's health directly
   off the wire (`SegmentSnap.hp`). This is *the* glanceable: it answers "where is it failing?" in
   under a second, which is the whole game. A breached segment pulses off `SegmentSnap.br` — an
   explicit flag, not inferred from `hp === 0` (a segment being rebuilt has hp climbing from 0 while
   still breached) — and is the highest-contrast thing on the HUD.
2. **Health + status.** Numeric HP plus a state that is unmistakable when it changes (downed shows a
   bleedout countdown ring driven by `SurvivorSnap.bl`, not a subtle tint).
3. **Ammunition** — mag / reserve, with a distinct empty-reserve state (that is a "go to the crate" signal).
4. **Scrap** — the currency, because every decision spends it.
5. **Wave + zombies remaining** — the progress the player is fighting toward.

**Tier 2 — contextual, appears only when actionable:**

- **Interact prompt**: verb + key + cost + a progress ring that fills during the hold. Never a bare
  "Press E" — always "HOLD E — REPAIR (112 scrap)".
- **Downed teammates**: a world-space marker visible *through geometry* with name (`SurvivorSnap.n`),
  distance, and the bleedout timer (`SurvivorSnap.bl`) — all live off the snapshot, not join-time
  roster values frozen for the whole run. A downed player on the far side of the tower must still be
  findable.
- **Damage direction** indicators.
- **Killfeed / event ticker** — kept short; wave and breach events outrank kills.

**Tier 3 — on demand:** scoreboard (hold TAB, live off `SurvivorSnap.k`/`.rv` every snapshot rather
than join-time values), pause, end-of-run stats.

---

## Legibility budget

- Anything in Tier 1 is legible at a glance at 1280×720 without leaning in: min 14 px effective type,
  min 4.5:1 contrast against the darkest scene behind it (the game is dark — HUD elements carry
  their own scrim rather than relying on the world being bright).
- World-space labels (weapon rack, ammo crate, revive markers) are legible at their interaction
  range **plus 6 m**. The previous build's station prices were called "a sub-pixel smear at any
  distance" — a world label that cannot be read at approach distance is not a label.
- The HUD never occupies the centre 40% of the screen except for the crosshair and the interact ring.

---

## Feedback & latency budget

Every player action produces on-screen feedback within **100 ms**:

| Action | Feedback |
| --- | --- |
| Fire | Muzzle flash + shake + recoil + report, same frame |
| Hit a zombie | Hitmarker + blood + flinch |
| Kill | Hitmarker emphasis + scrap counter tick + death SFX |
| Start a hold action | Progress ring appears and begins filling immediately |
| Repair tick | Fence tick on the ring climbs + scrap counter falls + repair SFX |
| Cannot afford | Deny SFX + the cost flashes — never silence |
| Take damage | Directional indicator + pain flash + shake |
| Segment breached | Ring tick pulses + distinct SFX + a banner |
| Teammate downed | Marker appears + distinct SFX + banner naming them |

Silence is a bug. Every one of these has an entry in `SfxKind` and the run-phase harness asserts
that a core action actually fires one.

**The `hit` event carries `shooterId`, and the HUD MUST filter hitmarkers to the local player.**
Every client receives every `hit` (shooters and victims alike are not partitioned per-recipient) —
without filtering to `shooterId === youId()`, a 16-player game fires a hitmarker on all 15
teammates' hits, constantly, for a player who fired nothing.

---

## Required states

Every one of these must exist, be reachable, and be designed — not a default:

- **Lobby / empty**: seated players listed, an explicit START (the room **never** auto-starts), and
  a clear statement of what is about to happen.
- **Joining / connecting**: a real state, not a frozen frame.
- **Error**: WebGL unavailable, disconnected, room full — each with a human sentence and a way out.
- **Wave active** — the default.
- **Intermission**: prominently counts down, and explicitly lists what the player should be doing
  (repair / restock / buy). This is where a new player learns the loop.
- **Downed**: bleedout ring, "a teammate can revive you", and whether anyone is coming.
- **Dead, run continuing**: spectating, with "returning at wave N".
- **Run ended**: the lose screen with per-player run stats and the wave reached. There is no win
  screen — the run always ends in defeat, so this screen must feel like a scoreboard of a good
  fight, not a failure notice.

---

## First 60 seconds

1. On first ever run, a dismissible card on the tower deck: *"You are on the tower. They come from
   the trees. Hold the fence, repair it, pick your people up. Nobody wins — you just last."* Plus
   the four keys that matter: move, fire, **E to interact**, **TAB for the squad**.
2. During the 8-second opening lull, a contextual pointer at the stairs: *"The ammo crate is below.
   The fence is beyond that."* — teaching the vertical layout before it matters.
3. First time a segment drops below 60%: the ring tick highlights and a one-line prompt teaches
   repair. First time a teammate goes down: a one-line prompt teaches revive. Each fires **once, ever**.

---

## Accessibility

- **Meaning is never encoded by colour alone.** The art system is colour-coded, so every colour
  signal carries a second channel:
  - Fence ring: colour **and** fill height **and** an icon change at damaged/breached.
  - Downed teammate: `reviveCyan` **and** a distinct chevron shape **and** the countdown number.
  - Low health: `danger` **and** the pain vignette **and** an audible heartbeat — the `'heartbeat'`
    `SfxKind`, which exists specifically to carry this accessibility requirement.
- Text never smaller than 12 px; no thin weights on Tier 1.
- Shake is capped and roll is damped (inherited STRICKEN tuning — nausea).
- No information conveyed only by a brief flash; every transient also updates a persistent element.

---

## Input

- **Primary: mouse + keyboard**, pointer-locked. WASD, mouse look, LMB fire, RMB aim, R reload,
  1/2/3 weapons, **E hold to interact**, TAB scoreboard, ESC pause.
- Pointer lock loss and window blur **clear all held keys** — a stuck key in a game where holding E
  is a core verb is a serious bug, and the previous build additionally paused the whole client on
  blur, which in a co-op game means the horde keeps coming while your screen is frozen.
  **Do not pause the client on blur.** Dim it if you like; the run continues.
- The interact hold must tolerate the key being released and re-pressed rapidly without losing all
  progress instantly (a short grace), or repairing under fire is miserable.

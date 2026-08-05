# RIFT — SONIC BIBLE

*The audio equivalent of a style bible. Frozen. Embedded verbatim in every audio implementer's
brief. If a decision is not in here, it is not yours to make — ask the orchestrator.*

---

## 1. Mood, in one paragraph

RIFT sounds like **a heavy iron battle fought in a cold stone valley at dusk**. It is *weighty, dark,
and legible* — never bright, never cute, never orchestral-fantasy. Every impact has mass: things
land, they do not ping. The low end carries authority (structures, ultimates, objectives), the
mid carries the fight (steel, bowstring, arcane crackle), and the top is reserved almost entirely
for **information** — the last-hit chime, the level-up, the cooldown-ready tick. If a sound is
bright, it is because the player *must* hear it. That is the single organising rule of this mix.

The reference in the player's ear is **Dota 2** (see §9). Not League — we are not melodic, chimey,
or pop. Not a horror game — we are not atonal. We are *industrial-mythic*: cold metal, deep stone,
and a thin arcane shimmer over the top.

---

## 2. The non-negotiable laws

1. **Every sound traces to the tonal palette** (§3). No free-floating frequency literals in cue
   code — ad-hoc `osc.frequency.value = 437` is a contract violation a reviewer will flag, exactly
   as an ad-hoc hex colour would be in a visual build. Pitches come from `PALETTE.hz` / the scale
   helpers; timbres come from the archetypes in §4.
2. **Every sound is positioned unless it is UI or announcer.** World events pan and attenuate by
   distance from the listener (§6). A dead-centre full-volume sound is a bug.
3. **Every repeatable sound varies.** Any cue that can fire twice in two seconds must jitter pitch
   and timing within its declared variation range (§7). Two identical consecutive samples is the
   "machine-gun" defect and is a review failure.
4. **Nothing clips, ever.** True peak stays at or under **−1.0 dBTP** in every scene, including the
   worst-case teamfight (§8). The limiter is a safety net, not a mix tool.
5. **The player's own actions are louder and closer than anyone else's.** Self events get a
   +3 dB bias and zero distance attenuation. You always hear your own hero over the battle.
6. **Silence is a tool, not a gap.** Ducking (§8) exists so the important thing is heard *alone*.
   But no phase of the game is ever fully silent — the menu has a bed, laning has a bed, the
   fountain has a hum.
7. **Audio never crashes the client.** Every public entry point is try/catch'd. A WebAudio failure
   degrades to silence and the game plays on. This is a repo-wide law (`CONTRACT.md`), not an
   audio preference.
8. **Synthesis only.** No audio asset files, no fetch, no base64 buffers. Everything is generated
   from oscillators, noise, and generated impulse responses. This keeps the PWA install tiny and
   matches every other game in this repo.
9. **No `Math.random`.** One seeded RNG stream, `rng()` from `@platform/shared`. Variation must be
   reproducible so the render harness produces byte-comparable output run to run.

---

## 3. The tonal palette — the cohesion device

This is to RIFT audio what the colour palette is to RIFT's art. **Five agents write cues; the
palette is why the result sounds like one game.**

**Root: D (73.42 Hz).** The whole game is tuned around D. Every sustained, tonal, or musical
element sits in **D natural minor (Aeolian)** — D E F G A Bb C. The chosen degrees, by register:

| Register | Purpose | Pitches (Hz) |
|---|---|---|
| `sub` | Structures, ultimates, objective weight | D1 36.71, A1 55.00, D2 73.42 |
| `low` | Impacts, hero deaths, tower attacks | D2 73.42, F2 87.31, A2 110.00, D3 146.83 |
| `mid` | Casts, steel, the body of the fight | D3 146.83, F3 174.61, A3 220.00, C4 261.63, D4 293.66 |
| `high` | Arcane shimmer, healing, magic tails | F4 349.23, A4 440.00, D5 587.33, F5 698.46 |
| `info` | **Reserved for information only** | A5 880.00, D6 1174.66, F6 1396.91, A6 1760.00 |

**The `info` register is sacred.** Only these cues may put significant energy above 800 Hz:
last-hit gold, level-up, skill-point available, cooldown-ready, purchase confirm, error, and the
announcer stings. Nothing else — no ability, no footstep, no ambience — competes up there. This is
what buys RIFT the Dota-like property that the gold chime cuts through a full teamfight without
being loud.

**Timbral colour by allegiance.** Team identity is carried by *interval*, never by loudness:
- **Ally / self** — perfect fifths and octaves (D+A, D+D). Consonant, settled, "mine".
- **Enemy** — minor seconds and tritones (D+Eb, D+Ab). Tense, unsettled, "theirs".
This is an accessibility requirement as much as a stylistic one: team is never encoded by pitch
height alone, and never by volume alone.

**Damage-school colour** (derived from `AbilityDef.effects[]`, see the contract):
- `physical` — noise-forward, fast attack (<5 ms), band-passed **300–2000 Hz**, short. Steel on
  steel. The upper bound is 2 kHz, not 3 kHz, precisely so the 2–4 kHz band stays clear for the
  last-hit chime to cut through — see §9. Combat and information must not fight for the same band.
- `magic` — tonal-forward, detuned-pair oscillators, ring-modulated shimmer, longer tail with a
  filtered decay. Arcane, cold, slightly out of tune with itself.
- `heal` — pure sine/triangle, rising perfect fifth, soft attack (30–60 ms), no noise. The *only*
  warm sound in the game.
- `control` (stun/slow/silence, no damage) — a downward pitch-bend with a lowpass closing. The
  sound of something being shut off. Built with `FilterSweep` where `sweepHz < filterHz` — every
  tonal archetype carries those fields for exactly this purpose.
- `dash/blink` — a fast doppler-ish sweep, air-noise, no tonal centre.
- `summon` — sub-heavy swell rising into a mid cluster.

---

## 4. Timbre archetypes — the shared "mesh factory" of audio

Every cue is assembled from these six primitives (frozen in `dsp.ts`). An implementer who needs a
seventh has found a contract gap: report it, do not invent one.

1. **`tone`** — oscillator voice (sine/tri/saw/square) with an ADSR-ish envelope and optional
   pitch glide. The tonal body.
2. **`noise`** — filtered burst from the shared seeded noise buffer (lowpass/bandpass/highpass with
   optional filter sweep). All impact, air, and texture.
3. **`thump`** — a sine sub with a fast downward pitch envelope. Weight and body. This is the
   single most important archetype for the Dota-like heaviness; use it under anything that lands.
4. **`metal`** — a small inharmonic partial stack (4–6 detuned oscillators at non-integer ratios)
   through a bandpass. Steel, armour, structures.
5. **`shimmer`** — ring-modulated or FM pair with a long filtered tail, always in the `high`
   register. Arcane magic only.
6. **`swell`** — a slow-attack filtered saw/tri cluster. Ultimates, objectives, music pads.

**Reverb.** Two generated impulse responses, shared, generated once: `IR_VALLEY` (1.6 s, dark,
for world SFX) and `IR_HALL` (2.8 s, for announcer/objective stings). World cues send to
`IR_VALLEY` at a distance-proportional amount — **far things are more reverberant**, which is what
makes the map feel like a place rather than a mixer.

---

## 5. Layer budget — what "polished" means concretely

A cue that matters is **three layers minimum**: transient + body + tail.
- **Auto-attacks / small hits:** 2 layers, ≤ 200 ms. They fire constantly; they must be small.
- **Ability casts:** 3–4 layers, 250–700 ms. Distinct per hero *and* per slot (24 combinations).
- **Ultimates:** 4–6 layers, 0.8–1.6 s, always with a `sub` element and a `swell`.
- **Structure deaths:** 5–7 layers, 1.5–3.0 s. The ancient is the biggest sound in the game.
- **UI:** 1–2 layers, ≤ 120 ms, `info` register, bone-dry (no reverb). Two exceptions:
  `ui.levelUp` ≤ 700 ms and `ui.buy` ≤ 250 ms.

"Distinct per hero" is the bar that separates this from a tech demo. BULLWARK's Q must not be
LONGBOW's Q with a different pitch — bulwark is *metal and stone* (metal + thump), longbow is
*tension and release* (a bowstring: filtered noise creak into a sharp mid transient), hex is *pure
arcane* (shimmer + detuned tone), mender is *warm sine* (tone + soft swell), reaver is *butcher's
steel* (noise-forward metal with a wet low thump), shade is *absence* (a reversed-feeling swell
that pulls inward, minimal transient).

---

## 6. Space

- **Listener** = the camera ground point (`cameraX`, `cameraZ`) at height `cameraHeight`.
- **Pan** = `clamp((sx - cx) / SPATIAL.panHalfWidth, -1, 1) * SPATIAL.panMax` (0.85). Never hard
  pan — a hard-panned event in a top-down game reads as broken headphones.
- **Distance attenuation** = inverse-ish rolloff over `SPATIAL.audibleRadius` metres, with a floor.
  Beyond the radius the cue is **not scheduled at all**. (This is a correctness filter, not a
  performance one — on the 96 m map the gates use it still admits most of the board. The actual
  load bound is `POLYPHONY_CAP` and `MAX_PLAYS_PER_SNAPSHOT`.)
- **Fog occlusion** — a world event at a position the player cannot see (`fog.isVisible()` false)
  is attenuated **−9 dB and lowpassed to 1.2 kHz**, not muted. You hear that *something* happened in
  the dark. This is a gameplay-legible design choice, and it is the most Dota-like single detail in
  this document.
- **Height** does not affect pan; camera height scales the effective distance (zoomed out = further
  = quieter and wetter).

---

## 7. Variation

Every cue declares a variation profile. Minimum for anything repeatable:
- **pitch:** ±3 % (auto-attacks ±6 %)
- **level:** ±1.5 dB
- **timing:** layer offsets jitter ±8 ms
- **timbre:** at least one filter cutoff or partial ratio jitters ±10 %

Round-robin where a single jitter is not enough: auto-attacks and hit impacts cycle **4 variants**
so the same waveform never plays twice in a row. Consecutive-identical is forbidden by construction,
not by luck.

---

## 8. The mix — busses, priority, ducking, headroom

**Bus tree:** `music`, `amb`, `sfx`, `ui`, `announcer` → `preMaster` (glue compressor) → `master`
(user volume) → `limiter` (soft-clip, sample-domain asymptote **−2 dBFS**) → destination. The
limiter's ceiling sits 1 dB below the **−1 dBTP** true-peak law because waveshaping flat-tops peaks
and 4× reconstruction overshoots; a ceiling set at the law would make the law unpassable.

**Static levels (dBFS, before user volume):** `sfx 0`, `ui −3`, `announcer −2`, `amb −18`,
`music −14`. Ambience and music live *underneath* the game and are meant to be felt, not listened to.

**Priority (0 = highest).** Drives both ducking and voice-stealing when the polyphony cap is hit.
Priority is a property of the *play*, not only of the cue: "own ultimate" is P2 and "an enemy's
ultimate" is P4, so `PlayOptions.priority` overrides the registered default. Without that override
every ult in a teamfight would hold the music and ambience ducked for its entire 1.6 s tail — the
exact opposite of "the score swells at objectives".

| P | Class | Examples |
|---|---|---|
| 0 | Match-defining | Ancient falls, victory/defeat, first blood |
| 1 | Objective | Tower/guard falls, surge, announcer stings |
| 2 | Self-critical | Own death, own level-up, own ultimate, low-HP warning |
| 3 | Self-action | Own cast, own last-hit, own purchase, own hit taken |
| 4 | Nearby combat | Other heroes' casts, hero kills, hero auto-attacks |
| 5 | Ambient combat | Creep attacks, creep deaths, tower shots |
| 6 | Texture | Ambience layers, footsteps |

**Ducking.** A cue of priority ≤ 2 ducks `music` and `amb` by **−9 dB** with a 30 ms attack and a
release matched to the cue's own tail + 250 ms. Priority ≤ 1 additionally ducks `sfx` by −4 dB.
This is scheduled gain automation — deterministic, offline-renderable, no sidechain analyser.

**Headroom.** Worst-case scene (5v5 teamfight + a tower falling + own level-up) must render at
**true peak ≤ −1.0 dBTP** with the limiter engaged for **< 2 % of samples**. If the limiter is
working harder than that, the static levels are wrong — fix the levels, not the limiter.

**Polyphony cap: 24 simultaneous voices.** Over cap, steal the oldest voice of the *lowest*
priority. Never steal priority ≤ 2.

---

## 9. The benchmark — Dota 2

Every cue and every scene is judged against Dota 2's sound-design language. The specific properties
we are copying, stated as testable targets so a judge can grade them:

| Property | Dota 2 does this | Our measurable target |
|---|---|---|
| **The gold chime cuts through anything** | Last-hit is instantly audible in a 5v5 fight | Last-hit cue peaks in the 2–4 kHz band; that band is ≥ 8 dB above the scene bed at the cue's onset. Bought two ways: the physical school is capped at 2 kHz (§3) so nothing competes there, and `ui.lastHit` is P2 so it ducks the bed like any self-critical cue |
| **The info register is genuinely reserved** | You never mistake a hit for a chime | Any non-`info` cue puts ≤ `INFO_BAND_MAX_PCT` (8 %) of its total energy above 800 Hz. Asserted by the harness, not left to taste |
| **Structures have real sub** | Towers falling shake the room | Structure-death cue: ≥ 35 % of total energy below 120 Hz; ancient ≥ 45 % |
| **Casts are readable, not spammy** | You know what was cast without looking | 24 hero-ability cues, each with a distinct spectral centroid; no two abilities within a hero differ by < 15 % centroid |
| **Fast transients, short tails on common sounds** | Attacks are crisp, never mushy | Auto-attack cue: attack time < 8 ms, total length < 200 ms, crest factor > 8 dB |
| **Wide dynamic range, quiet baseline** | Laning is calm; fights are loud | Laning scene RMS ≤ −30 dBFS; teamfight scene RMS ≥ −18 dBFS. A ≥ 12 dB spread is the target |
| **Music serves tension, never competes** | Score swells at objectives, hides in lane | Music bus ≤ −14 dBFS, ducked −9 dB under any P≤2 cue |
| **Nothing is ever centred and dry** | The map is a place | Every world cue has non-zero pan or distance-scaled reverb send |

**Blind comparison protocol.** Because Dota 2's audio files cannot be redistributed into this repo,
the blind A/B is run as: *unlabeled spectrogram + waveform + metric-sheet pairs*, one being the
current (baseline) RIFT audio and one the rebuilt audio, shown to a fresh context-free judge that
has never seen the code, and graded against the Dota-2-derived targets in the table above. The
judge is told one of the pair is from a shipped commercial MOBA and one is from a hobby project,
and must say which — **and why, citing the spectrogram.** The build passes an aspect only when the
judge either picks the new build as the shipped one, or cannot tell. "Both look amateur" and "the
new one is better but still clearly hobby" are failing verdicts.

**The pairs must actually be blind.** Panels captioned with their cue id (`rift_kill` vs
`die.hero`) identify which side is the legacy module in every single pair, and the whole pass/fail
bar then rests on a caption rather than on the audio. The harness therefore emits a separate
anonymised set captioned only "A"/"B" plus the metric sheet, with the side assignment drawn from
the seeded RNG and recorded only in `metrics.json` — which the judge prompt never receives.

---

## 10. What the player hears in the first five minutes

The completeness check. Every line here must resolve to a cue in the contract.

Each line names the `SoundId`(s) that deliver it. **A line with no id is a lie and has been cut** —
the previous draft promised footsteps, hover scrapes, per-hero pick stabs, a tower announcer and a
"panned from the attacker" hurt cue, none of which the seam can produce. They are gone rather than
left as decoration.

**Menu** — a low D drone bed and distant valley wind (`amb.menu`); an iron click on press
(`ui.click`).
**Lobby** — bed continues; each hero pick lands a confirm stab (`ui.pick`); the start countdown is
one ascending `info` tick per second (`obj.countdown`, fired once per whole second by `game.ts`).
**Match start** — a horn in D (`obj.matchStart`), the ambience opens up (`amb.field`), music enters
at intensity 1.
**Laning** — quiet: wind, and creeps clashing at the edge of hearing (`atk.creep.*`, `hit.physical`,
`die.creep`). Each creep you last-hit gives the bright `info` chime plus a coin shimmer
(`ui.lastHit`). Each creep you *miss* gives nothing — the absence is the feedback.
**Casting** — your Q/W/E/R each sound like *your hero*, at your position, louder than everyone
(`cast.<hero>.<slot>`, self-biased +3 dB). A cast on cooldown gives the dry error thud (`ui.error`);
a cast coming off cooldown gives a soft `info` tick (`ui.abilityReady`).
**Blows landing** — every hit on any unit has an impact, not just a swing (`hit.physical`,
`hit.magic`, `hit.crit`), positioned at the victim.
**Taking damage** — a filtered thud at your own position (`hit.self`), plus a heartbeat pulse
(`hit.heartbeat`) that enters below 30 % HP and gets faster below 15 %.
**A kill** — a body-fall thump and a team-coloured sting: `die.hero` (enemy fell, ally-fifth
resolution — good news), `die.hero.ally` (a teammate fell, enemy-tritone colour), `die.hero.self`
(you fell, with the low weight of a real loss). A hero bounty pays out as `ui.gold`, **not** the
last-hit chime — the chime means "creep", and overloading it would destroy its meaning. First blood
adds `ann.firstBlood`.
**A tower falls** — everything ducks, sub-bass collapse, debris tail 1.5–2.2 s (`obj.tower` /
`obj.guard`; the ancient is 2.5–3.0 s, `obj.ancient`).
**Buying** — shop open and close are leather-and-iron (`ui.shopOpen` / `ui.shopClose`), purchase is
the two-tick cha-chime (`ui.buy`). A denied action is the error thud (`ui.error`); a blocked cast
additionally raises the toast note (`ui.toast`).
**Level up** — a rising D-minor triad in the `info` register plus a `swell` (`ui.levelUp`); a skill
point becoming available fires once (`ui.skillPoint`).
**Dying** — the mix goes underwater (global lowpass 800 Hz) for the death cam, ambience drops to
`amb.death`, music to intensity 0, and the respawn timer ticks (`obj.countdown`). Respawn re-opens
the filter (`obj.respawn`) and, inside the fountain radius, the `amb.fountain` hum.
**Ancient under attack** — music jumps to intensity 4, a warning klaxon in the enemy-tritone colour
(`obj.klaxon`).
**Victory / defeat** — the full stinger (`ann.victory` / `ann.defeat` / `ann.draw`): sub, swell, and
a resolved D-minor cadence, or a collapsing detuned fall. Ambience and music stop dead **first** —
silence, then the sting. The ordering is load-bearing and is specified in the integration section.

---

## 11. Accessibility

- Team is **never** encoded by pitch height or volume alone — always by interval colour (§3) *and*
  always accompanied by an existing visual cue.
- Where a visual twin exists, audio reinforces it rather than replacing it. **Verified against the
  real HUD:** ability-ready has a twin (`.ability-slot--ready`), skill-point has one (`.ability-plus`),
  and hit feedback has one (damage numbers + `fx.burst`). **Three signals are audio-first and
  currently have NO visual twin: the last-hit chime, the low-HP band, and the ancient-under-attack
  klaxon.** That is stated here as a known gap rather than papered over — closing it means editing
  `ui/hud.ts`, which is out of scope for this build and is recorded as follow-up work. No *required*
  information is audio-only: all three are also readable from the gold readout, the HP bar and the
  minimap respectively, just less immediately.
- Independent **master / SFX / music / ambience** sliders plus a one-tap mute, persisted to
  `localStorage` under `rift.audio`, honoured before the first sound plays.
- The mute state must survive a reload and must apply to the ambience bed, which is the most
  common complaint source.

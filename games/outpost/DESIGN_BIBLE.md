# DESIGN BIBLE — OUTPOST

What the game *is*, what decision the player makes each minute, and the balance intent every number
in `config.ts` must be checkable against.

---

## The one-line pitch

**1–16 survivors hold a fenced outpost around a wide watchtower against endless waves of the dead.
The tower keeps you alive. The ground is where the run is decided. The run ends when everyone is dead.**

---

## Design pillars

1. **The tower is safe only while the fence holds.** Zombies climb via the exact same `stepBody`
   step-up survivors use, so nothing stops them taking the stairs — once a segment breaches, the
   horde comes up after you, and deck 2 becomes the last stand, not a sanctuary. Until that happens,
   height buys sightlines and distance, not immunity: from up there you cannot repair the fence, you
   cannot restock ammunition, and damage falloff means you kill too slowly to save the fence you are
   standing over. Turtling loses in slow motion — and once the fence goes, it loses outright.
2. **Every wave forces a descent.** The ammo crate is on the tower's ground floor. Repairs only
   happen at the fence. The weapon rack is on deck 1, halfway. The vertical layout *is* the pacing
   mechanism — the player's minute-to-minute question is always **"can I afford to go down right now?"**
3. **The fence is a clock, not a wall.** It never holds forever. It buys the time you spend deciding.
4. **You die together.** A downed teammate is a 45-second window and a trip into danger. Reviving is
   the most dangerous thing in the game and the only thing that saves a run.
5. **Read the horde at a glance.** Four silhouettes, distinguishable at 40 m by shape alone, each
   demanding a different answer.

---

## The core loop

```
LOBBY ──START──▶ opening lull (8s) ──▶ WAVE n ──cleared──▶ INTERMISSION (22s) ──▶ WAVE n+1 ──▶ …
                                          │                        │
                                          │                        └─ dead survivors return
                                          └─ every survivor downed/dead ──▶ ENDED
```

**During a wave**: zombies drip in from the treeline ring at `spawnPerSecBase`, scaled by the same
headcount factor as wave size — a flat rate was a silent difficulty collapse at high player counts
(wave size scales x7.0 at 16 players, so a fixed 2.4/s meant a 16-player wave 10 took 141 s just to
spawn in and wave 20 took 17 minutes, with headcount buying only length, never pressure). Zombies
walk to the nearest intact fence segment and chew it. Survivors shoot from the top deck (safe, slow),
from the firing step (fast, exposed), or from the open ground inside (fastest, most dangerous once a
breach opens). Breaches let the horde inside, where it hunts survivors directly.

**During intermission**: repair segments, buy at the rack, restock at the crate, pick up the dead.
22 seconds is deliberately not enough to do everything — choosing what to skip is the strategic layer.

---

## The minute-to-minute decision

At any moment a player is choosing between four uses of their time, each on a different clock:

| Choice | Cost | Clock it beats |
| --- | --- | --- |
| Shoot from the top deck | Ammunition, slowly | Nothing — it is the default |
| Drop to the firing step | Exposure to spitters, brutes reaching over | The fence's HP clock |
| Repair a segment | 0.35 scrap/HP + ~12 s standing still at the most dangerous spot on the map | The breach clock |
| Revive a teammate | 4 s immobile within 2.2 m of whatever downed them | Their 45 s bleedout |

A good run is one where the squad splits these correctly. A bad run is four people on the top deck
watching the north fence fall.

---

## Balance intent — the checkable targets

These are the relationships `config.ts` must actually produce. The gauntlet and the balance review
lens check the numbers against **these statements**, not against taste.

**Opening**
- Wave 1 (8 shamblers solo) is survivable with the issued pistol and **no repairs at all**.
- A solo player finishes wave 1 with ~96 scrap — not enough for anything. The first real purchase is
  a decision made at wave 2–3.

**Economy pacing (solo)**
- Shotgun (200) affordable ~wave 3. Rifle (550) ~wave 6. Sniper (900) ~wave 10.
- A full ammo restock (60) costs roughly five shambler kills — frequent enough to be a real budget
  line, cheap enough that running dry is a choice, not a punishment.
- Fully repairing one destroyed segment (320 HP) costs 112 scrap and 12.3 s. Rebuilding a *breached*
  one costs 168 and takes 24.6 s. **Letting a segment breach is roughly a wave's income** — that is
  the pressure that makes repair worth leaving the tower for.

**The fence clock**
- One brute alone opens a segment in **4.6 s** of contact (320 HP / 70 dps).
- Two shamblers take **7.3 s**. A wave-1 group of four shamblers on one segment: ~3.6 s.
- Intent: ignoring one side of the fence has visible cost within a single wave, and a brute is an
  emergency that reorganises the squad.

**Difficulty curve**
- Waves 1–2: shamblers only — 38 m from the treeline spawn ring to the fence, ~22 s to close.
  Teaching the loop. No pressure.
- Wave 3: **runners** arrive — they close the same 38 m in ~8.6 s and break the habit of standing
  still to aim.
- Wave 6: **brutes** arrive — the fence starts failing faster than one person can repair it. This is
  where a squad must specialise.
- Wave 8: **spitters** arrive — ranged acid over the parapet. The top deck stops being free.
- Wave 10+: composition is mixed and count scales past `HORDE.maxAlive`, so the horde arrives as a
  continuous stream rather than a wave. Intent: a competent solo run ends around wave 8–12; a
  coordinated 4-player squad reaches 15–20; the run is *always* eventually lost.

**Anti-dominant-strategy checks** (each of these must NOT be the best play)
- *Turtle on deck 2 forever* — beaten by finite reserves + the crate being on the ground floor, and
  by spitters from wave 8.
- *Never repair, just kill* — beaten by breach rebuild costing 1.5× and the horde entering the
  compound where it reaches you on deck 1 stairs.
- *Everyone rushes the sniper* — beaten by falloff being irrelevant at fence range and by the
  1.5 s interval against a 4.4 m/s runner.
- *Ignore the downed* — beaten by squad-wipe ending the run: the last survivor cannot hold 16
  players' worth of wave alone.

---

## Balance targets that changed at the freeze gate

- **Fence height is 1.6 m, not 2.0.** At 2.0, a survivor's eye on the firing step cleared the top of
  the fence by only 2 cm, allowing a maximum depression of 1.76° — which made the shambler, runner
  and spitter literally unhittable from the firing step (only the brute's head cleared it), silently
  deleting "drop to the firing step" as a real choice. At 1.6 the lowest reachable point at zombie
  range measures y=1.00: head and torso of every kind are hittable from the step.

---

## Progression & session shape

- **Within a run**: scrap → weapons (4 tiers past the pistol: shotgun, smg, rifle, sniper) →
  sustained ammunition → fence upkeep.
  Three sinks competing for one currency is the whole economy; it does not need more.
- **Session length**: a solo run is 12–20 minutes. A squad run is 25–45.
- **The end screen** shows per-survivor run stats: kills, headshots, damage, fence HP repaired,
  revives given, times downed — so the *social* contributions (repairing, reviving) are scored as
  visibly as kills. A player who spent the run repairing must finish the run able to point at a number.

---

## What OUTPOST deliberately is NOT

- **No defendable "core" object.** The previous build had a generator whose loss ended the run even
  with everyone alive; it was also the hero object that no screenshot ever contained. The lose
  condition here is exactly the one that was asked for, stated precisely: **the run ends the instant
  no survivor has status `alive`** — i.e. the moment the last standing survivor goes down. Downed
  survivors then bleed out and die, but the run is already over by then; death is not what ends it,
  the loss of the last `alive` status is. Consequence, stated honestly: at `MIN_PLAYERS = 1`, a solo
  player going down ends the run immediately, so the 45 s bleedout is a solo death animation and
  reviving is inherently a multiplayer verb. That is intended, not an oversight.
- **No bot survivors.** The roster is real players; wave size scales to the headcount instead.
- **No perks/tech tree.** Three sinks, one currency. Depth comes from the vertical layout, not from
  a menu.
- **No round timer.** A wave ends when it is dead, not when a clock says so.

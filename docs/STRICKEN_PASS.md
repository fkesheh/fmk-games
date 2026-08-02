# STRICKEN gameplay pass — FROZEN CONTRACT

Scope: the two bundles selected from the gameplay audit — **defect fixes** and
**stakes & feedback**. Weapon-depth and map-rework items are explicitly OUT.

Everything in §1 is immutable. No task may change a §1 signature, rename a §1
field, or widen its own file ownership in §7. If a task believes the contract is
wrong, it STOPS and reports — it does not renegotiate with a sibling.

---

## §1 Contract

### C1 — `BotPercept['self'].weapon`

`games/fps/server/src/bots.ts`:

```ts
export interface BotPercept {
  self: { x: number; y: number; z: number; yaw: number; pitch: number; hp: number;
          mag: number; reserve: number; reloading: boolean; crouch: boolean;
          weapon: WeaponId };   // <-- ADDED: the CURRENTLY EQUIPPED weapon
  // ...unchanged...
  owned: WeaponId[];            // unchanged meaning: every weapon owned, knife first
}
```

- `self.weapon` is the weapon the bot is holding **right now** — the same id the
  server's own fire path resolves for that player. It is written every tick at
  the existing percept-refresh site (`game.ts` ~L831, beside `b.percept.owned`).
- `owned[0]` is **not** the equipped weapon and never was. It is `'knife'` for
  every player (pinned at `game.ts:365`; order preserved by `economy.ts:39`).
  Any code reading `owned[0]` as "my gun" is a bug.

### C2 — escalating loss bonus

`games/fps/shared/src/config.ts`:

```ts
export const ECONOMY = {
  start: 800,
  killReward: 300,
  winReward: 3250,
  lossRewardBase: 1400,   // REPLACES the flat `lossReward: 1900`
  lossRewardStep: 400,
  lossRewardMax: 2600,
  max: 16000,
} as const;
```

**AMENDED after measurement.** The first draft used `step: 500, max: 3400` — the
literal CS ladder. A simulation of a 10-round total loss showed it made the
losing team *richer and better armed*, affording a rifle in R4-R6 that the flat
1900 never once bought. Two reasons, and only the second is a real defect:

1. The simulation compared **income**, not **net purchasing power**. Survivors
   keep their weapons (`game.ts:1183` resets `weapons` only for the *victim*)
   and `refillWeapons()` tops up their mags free at freeze, so a winning team's
   3250 is nearly all savings while a losing team's payout is all rebuy. That
   asymmetry is precisely why CS can set max loss (3400) above win (3250).
2. **The real error: CS's ladder is tuned for 30 rounds; this match is 10, first
   to 6, halftime at 5.** Full catch-up at streak 4 arrives when a team is
   already eliminated. The ladder must escalate faster and cap lower.

`games/fps/server/src/economy.ts`:

```ts
/**
 * Per-team money GAINS after a round.
 * `lossStreak` = consecutive rounds each team has ALREADY lost, BEFORE this
 * round's result is applied. A winner's entry is ignored.
 * Loss payout = min(base + step * streak, max).
 */
export function roundRewards(
  winner: Team | null,
  lossStreak: { t: number; ct: number },
): { t: number; ct: number };
```

Ladder (streak → payout): `0→1400, 1→1800, 2→2200, 3→2600, 4+→2600`.

Why these three numbers, so no one retunes them by feel:

- **base 1400 < smg 1500** — one loss cannot fund a gun. R1 is a genuine pistol
  round and R2 a real force-buy. This is the lever that creates an eco round at
  all, and the measurement confirmed it works.
- **streak 2 → 2200 ≥ smg+vest 2150** — a full SMG buy is back by the *second*
  loss, not the fourth. Catch-up has to land while the match is still alive.
- **max 2600 < rifle 2700 < winReward 3250** — a loss payout alone never buys a
  rifle. A losing team reaches rifle money by *saving* a round or by *fragging*
  (`killReward` 300, so 2600 + one kill = 2900). The way out of a slump is
  playing well, not waiting. This is the constraint that was violated before.

`winner === null` (a draw) pays **both** teams their streak-based loss reward
and, per C3, increments **both** streaks. Negative, non-finite or fractional
streaks clamp to `max(0, floor(x))`.

### C3 — loss-streak state

Owned by the room. Two counters, both starting at 0, both **reset at halftime**
alongside the side swap (a team's economic pressure does not follow it across
the swap). After each round's winner is decided: the winner's counter → 0, the
loser's counter → +1, a draw increments both. The counters are read to compute
C2 and are **not** on the wire.

### C4 — death information (client-only)

No server change. The data already exists on the wire and is currently discarded:

- `{ t: 'kill'; killerId: PlayerId | null; victimId: PlayerId; weapon: WeaponId; headshot: boolean }` — `types.ts:144`
- `{ t: 'dmg_taken'; fromId: PlayerId | null; dmg: number; yaw: number }` — `types.ts:147`

`killerId === null` means a suicide, a console `kill`, or world damage — the
card must render a neutral form, never "KILLED BY undefined".

### C5 — end-of-match stats

`PlayerState` (server, `game.ts` ~L118) gains three counters, siblings of
`kills`/`deaths`/`headshots`, all reset wherever those are:

```ts
damageDealt: number;   // post-armour HP actually removed from enemies
shotsFired: number;    // trigger pulls that consumed a round
shotsHit: number;      // pulls that landed >= 1 damaging hit
```

`shotsFired`/`shotsHit` count **pulls, not pellets** — a shotgun blast is one
fired and, if any pellet lands, one hit. Otherwise the shotgun reports a
meaningless accuracy. Self-damage and team damage never count toward
`damageDealt`.

`match_end` is extended; every other field keeps its meaning:

```ts
| { t: 'match_end'; winner: Team; scoreT: number; scoreCT: number;
    stats: Array<{ id: PlayerId; name: string; team: Team;
                   kills: number; deaths: number; headshots: number;
                   damage: number; shotsFired: number; shotsHit: number }> }
```

Accuracy is **derived on the client** (`shotsHit / shotsFired`, rendered as `—`
when `shotsFired === 0`) — never sent as a float. `stats` covers every player
present at match end, both teams, and is ordered by the server.

### C6 — match point (client-derived, NO protocol change)

`round_start` already carries `scoreT`/`scoreCT`. A team is at match point when
its score is `ROUNDS.winRounds - 1`. The client derives this; nothing is added
to the wire. Both teams can be at match point at once, and that case must read
as a decider, not as two competing banners.

---

## §2 Invariants

- **I1** A bot resolves the weapon it is holding. After C1, no read of
  `owned[0]` as an equipped weapon survives anywhere in `bots.ts`.
- **I2** A bot with an empty magazine and a reloadable weapon requests a reload.
  It must never reach a state where it holds fire forever on an empty mag.
- **I3** Bot behaviour stays **deterministic and pure**: one seeded rng stream,
  no `Date`, no `Math.random`, no I/O, no allocation in `tick()` beyond the
  command object. Same seed + same percept sequence ⇒ identical commands.
- **I4** Bots remain **beatable**. C1 makes them roughly 3.7× deadlier by fixing
  the fire rate alone; a difficulty tune is part of the same task, not a
  follow-up. Evidence required, not vibes (§8).
- **I5** Economy is monotone: a longer loss streak never pays less.
- **I6** Money is always clamped to `[0, ECONOMY.max]`.
- **I7** No client change alters the sim, prediction, or reconciliation.
- **I8** Every existing green test stays green. 783 passing is the floor.

---

## §7 File ownership — exclusive, no file appears twice

| Task | Owns |
|---|---|
| **A1** bot weapon fix **+ B1w streak wiring** | `games/fps/server/src/bots.ts`, `games/fps/server/src/game.ts`, `games/fps/server/src/bots.test.ts`, `games/fps/server/src/game.test.ts` |
| **A3** dustbowl sightline | `games/fps/shared/src/maps/dustbowl.ts`, `games/fps/shared/src/maps/sightline.test.ts` (new) |
| **B1p** economy (pure) | `games/fps/shared/src/config.ts`, `games/fps/server/src/economy.ts`, `games/fps/server/src/economy.test.ts` |

**Blocked until the team-colour agent lands** (it holds `hud.ts`, `menus.ts`,
`playerModels.ts`, `palette.ts`, `valueLadder.test.ts` and has dirtied
`maps/{bunker,crossfire,frostbite}.ts`):

| Task | Will own |
|---|---|
| **A2** Frostbite step boxes | `games/fps/shared/src/maps/frostbite.ts` |
| **B2** death feedback | `games/fps/client/src/ui/hud.ts`, `game/clientGame.ts`, `render/scene.ts` |
| **B3** in-match arc | `games/fps/server/src/game.ts` (after A1/B1w), `hud.ts` (after B2) |
| **A4** sightline sweep | `games/fps/shared/src/maps/sightline.test.ts` (after A3) — MEASUREMENT ONLY, no map geometry may change |

B1w (loss-streak wiring) was folded into **A1**, which already owns `game.ts`.

### Known open defects, deliberately out of scope

- **Winner-side saturation.** A winning team buys a rifle once (R2), pays only
  650/round for a vest after, and hits `ECONOMY.max` by R8 — its economy stops
  meaning anything. This is the audit's "$10,300 having bought nothing", and C2
  touches only the loss side, so it survives this pass. Pinned by an assertion
  so it stays visible.
- **Dustbowl's cover is see-over.** Only 13 of 41 boxes clear a standing eye
  (1.62m), so both flank lanes run open from back wall to back wall (46.04m).
  Fixing it is map geometry, which is out of scope.

`games/fps/client/src/contract/visual.ts` and `render/bake.test.ts` are OFF
LIMITS to every task in this document — the perf pass owns them.

---

## §8 Gates

Per task, all three must be green, and the runner must be **proven able to fail**
before its green is trusted:

1. `node node_modules/typescript/bin/tsc --noEmit -p <workspace>` — exit code
   captured explicitly. **Do not trust `rtk`**: it has reported "No errors
   found" for a file with 6 real errors and exit 0 for failing runs in this
   repo. Use `rtk proxy "..."` or invoke the binary directly.
2. `npx vitest run` — 783 passing is the floor; new tests add to it.
3. The task's own evidence, below.

**A1** — a test proving a bot with an empty rifle mag sets `cmd.reload`
(this fails against today's code, which is the point); a test proving an
auto weapon produces the burst pattern rather than the semi path; a determinism
test (same seed ⇒ identical command sequence). Plus **measured** before/after
bot lethality from a headless match: bot TTK, bot accuracy, bots' share of
kills, and a human's win rate. I4 means the "after" must be *harder but
losable* — report the numbers and your tune, and say plainly if the bots became
unfair.

**A3** — a real measurement replaces a prose claim. Compute the longest open
sightline on dustbowl in a test. If it genuinely exceeds the 42m the header
asserts, **fix the comment to the measured truth, not the geometry** — dustbowl
is the frozen reference map and its layout is not in scope. State the method
(what counts as "open", which pairs of points were sampled) in the test.

**B1p** — table test over the full ladder including streak 0, the cap, the
clamp, and a draw; a simulation proving the audit's finding is reversed, i.e.
a team losing every round with no kills can no longer afford SMG+vest every
round from R3. Report the money curve for a 10-round total loss, before and
after.

---

## §10 Precedence

§1 contract > §2 invariants > §8 gates > this file's prose > any task's own
judgement. On conflict, stop and report.

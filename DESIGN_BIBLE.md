# DESIGN BIBLE — STRICKEN

## Pillars
1. **Readable fights** — you always know what killed you and from where.
2. **Every buy matters** — economy tension drives decisions between rounds.
3. **60-second stories** — each round produces a mini-arc (push, trade, clutch).

## Core loop
Warmup → freeze (buy, 3s) → live round (≤100s, eliminate or outnumber at time) → roundEnd (4s,
rewards) → next round. First to 6 round wins (max 10 rounds, halftime swap after 5) wins the match.
Match end → back to warmup with reset money/scores. Warmup: free respawn, no stakes, damage on.

## The decision each minute
- Freeze: spend or save? (pistol-only save round vs full rifle buy)
- Live: which lane to hold/push with your weapon's range profile
- Death: spectate + read the round for next-time info

## Economy intent (checkable relationships)
- Start $800: pistol-only round 1, always.
- Round 1 loser can afford SMG+utility-less round 2 ($1900+), winner rifles round 2 ($3250+).
- A team on a 3-loss streak still reaches $1900·n but caps usefulness: full rifle buy ($2700)
  requires a win or a saved round — losing streaks force eco decisions, not death spirals (max $16000).
- Sniper ($4750) is a luxury: affordable only after a win + a save, or a long win streak.
- Kill reward ($300) means ~6 kills ≈ one round loss stipend — aggression pays but never replaces winning.

## Weapon role intent (rock-paper-scissors by range)
- knife: desperation/speed (fastest move), meme kills in warmup.
- pistol: free default; wins vs nothing at range, fine up close; headshot×3 rewards aim.
- smg ($1500): close-range shredder, anti-eco, falls off hard past 14m.
- shotgun ($1100): one-pump burst ≤ 6m, useless past 18m; hold tight corners (office/bunker).
- rifle ($2700): the default competitive gun, 1-tap headshot at all ranges, manageable spray.
- sniper ($4750): 1-shot body kill, slowest handling, hip-fire lottery (8°), scope to be lethal.

## Session shape
Casual drop-in: quick-join lands in warmup instantly; first match starts when a 2nd player arrives.
A 10-round match ≈ 12–18 min. Private rooms: share a 5-char code, pick the map.

## Difficulty / fairness
Spawn protection 1.5s. Spawn picks avoid enemies within 10m. Lag comp ≤ 250ms so high ping still
registers honest hits; >90 inputs/s = kick (speedhack guard). Autobalance: new joins land on the
smaller team.

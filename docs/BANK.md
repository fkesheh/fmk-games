# BANK — design + module contract (frozen)

The platform's second game: the canonical **Bank** dice game. Turn-based, event-driven
(no tick loop). See `docs/STRUCTURE.md` for the platform contract; this file freezes
the bank-specific contract. Full rules intent: shared/src/config.ts header comment.

## Packages & files

- `games/bank/shared/` (@bank/shared) — types.ts / config.ts / dice.ts / protocol.ts (FROZEN, exist)
- `games/bank/server/` (@bank/server) — room.ts, module.ts, room.test.ts
- `games/bank/client/` (@bank/client) — index.html, src/{main.ts, game.ts, dice.ts, audio.ts, style.css}

## Server: `games/bank/server/src/room.ts`

```ts
export class BankRoom implements GameRoomHandle { /* platform contract */ }
```

Behavioral invariants (frozen):
- **Join/leave:** players join in order (play order = join order). addPlayer sends a fresh
  `bank_state` to the joiner. **Mid-round joiners participate IMMEDIATELY** — appended to the
  END of the order with banked=false; they can roll on their turn and bank at once (the
  physical-game rule: you sit down and play). Joining during roundEnd/matchEnd needs no
  special case (next round resets banked for everyone).
- **Rejoin (resume token):** addPlayer(id, name, resume?) — if `resume` matches an existing
  player entry's id AND that entry is disconnected: re-bind — the entry's id becomes the new
  session id (order slot, score, banked all preserved), connected=true, state broadcast.
  If the entry is still connected (token used from a second tab/session), ignore `resume`
  and join as a new player.
- **Ghost purge:** disconnected entries stay for the CURRENT round (score kept for rejoin)
  and are REMOVED at the next round start (round transitions + match reset). Purging a
  disconnected current player advances the turn first. removePlayer: if it was their turn,
  advance; broadcast state.
- **Match flow:** phase 'lobby' until connected ≥ MIN_PLAYERS → round 1, 'playing',
  currentId = first player. Each roll: only from currentId, only in 'playing'; rollCount++;
  apply `rollEffect` (shared/dice.ts) with the per-roll stream `rng(Date.now() ^ tickish)`;
  broadcast the `roll` event + fresh `bank_state` to everyone.
- **Bust / round end:** effect 'bust7' ⇒ `round_end {reason:'bust7'}`, pot lost. A player
  banking (any non-banked player, ANY time in 'playing', not just their turn) ⇒ score += pot,
  banked=true, `bank` event; when every connected player is banked ⇒ `round_end
  {reason:'all_banked'}`. The pot NEVER resets on a bank — it keeps growing for the players
  still in. Turn passes to the next non-banked player (by join order).
- **roundEnd** (ROUND_END_SECONDS, no timer/rolls): pot shown as 0 for the next round;
  then round++, banked=false for all, rollCount=0, pot=0, currentId=first, 'playing'.
- **matchEnd:** after TOTAL_ROUNDS rounds ⇒ `match_end {winnerId}` (highest score; tie ⇒
  the earliest in join order), phase 'matchEnd' for MATCH_RESET_SECONDS, then FULL reset
  (scores 0, round 1... back through 'lobby' rules — if ≥2 players still present, round 1
  starts immediately).
- **Low pop:** connected < MIN_PLAYERS at any point mid-match ⇒ abort to 'lobby' with scores
  KEPT (so a rejoiner keeps their total); a new match resets scores.
- **Turn timer:** TURN_SECONDS per turn (turnEndsAt in state); on expiry the server rolls for
  the current player automatically and broadcasts `auto_roll` first. Timer cleared on stop().
- **stalePlayers():** players with no message for STALE_MS.
- **Dice fairness:** per-roll seeded rng (`rng(Date.now() ^ (rollCounter * 2654435761))`),
  never Math.random.
- info(): { game:'bank', label:'10 rounds', phase, players, maxPlayers: MAX_PLAYERS, ... }.

## Server: `games/bank/server/src/module.ts`

```ts
export const bankModule: GameModule = { id: 'bank', name: 'BANK', clientDist: <resolve>,
  createRoom(opts) { return new BankRoom(...); } };
```
clientDist resolution mirrors the fps module's candidate-path probing (dev + docker layouts).

## Room variants (settings)

`createRoom(opts.settings)` accepts `{ sevenBonus?, totalRounds?, raceTarget? }` (all optional;
defaults from `DEFAULT_SETTINGS` in shared/config.ts):
- `sevenBonus: boolean` — a 7 in the safe window is worth 70 (true, canonical) or a plain 7 (false).
- `totalRounds: 10 | 20` — match length in rounds (ignored in race mode).
- `raceTarget: 500 | null` — race mode: the match ends the moment a bank takes a player to
  ≥ raceTarget (that player wins immediately; no round cap).
Anything else (wrong type, out-of-choice value) ⇒ `createRoom` throws ⇒ `bad_settings` error.
`BankState.settings` carries the frozen variant to clients. `info().label` reflects it:
`"10 rounds · 7=70"` / `"20 rounds · plain 7"` / `"race to 500 · 7=70"`.
Race mode win condition replaces the TOTAL_ROUNDS one; winner banner text is the client's concern.
The room's ROLL logic calls `rollEffect(d1, d2, rollCount, settings.sevenBonus)`.

## Client (Vite app, base '/bank/', outDir dist)

DOM + canvas-free dice (CSS 3D or flat pip faces; NO three.js — keep the bundle tiny).
Casino felt mood: deep green table (#1d5c3f), gold accents, ink background, white pips.

- `src/game.ts` — connection + lobby flow (welcome/quick_join {name,game:'bank'}/
  create_public {name,game:'bank',settings}/create_private/join_private/list_rooms with
  game filter 'bank'), state store, all rendering: felt table, BIG pot (counts up
  animated), two dice that tumble (random faces cycling ~600ms then settle on d1/d2 —
  cosmetic rng client-side is fine for the tumble frames), player rail (name, score,
  banked check, current-turn highlight, YOU marker), event log (last ~6: "Bob rolled 8 →
  pot 42", "Alice BANKED 42", "7! round over"), ROLL button (only your turn, pulsing),
  BANK button (always available while you're unbanked in 'playing'; disabled otherwise),
  turn timer bar (30s), round indicator, winner banner at matchEnd,
  menu screen (name, quick join, create public/private, join by code, room list).
  VARIANT UI (frozen): the create section has a checkbox "7 = 70 in first 3 rolls" (default
  on) and a match-length select ("10 rounds" / "20 rounds" / "First to 500"); create sends
  `settings: { sevenBonus, totalRounds, raceTarget }` per the variant contract. The table
  header shows the variant label (from state.settings). Round indicator: "ROUND n/10" or
  "ROUND n/20"; race mode: "RACE TO 500" + your score progress (e.g. "340 / 500").
- `src/dice.ts` — dice renderer + tumble animation (two dice faces, pip layout per value).
- `src/audio.ts` — tiny WebAudio synth: dice clatter, bank chime, bust thud, turn tick.
- Debug surface (e2e): `window.__bank = { state(): JSON-safe { phase, round, pot, rollCount,
  currentId, you, players: [...] , score of you }, joinQuick(name), createPublic(name),
  createPrivate(name), joinPrivate(name, code), roll(), bank() }`.

## Platform routing (new requirement)

Multi-game static serving + launcher (platform/server changes):
- `/` → a tiny launcher page GENERATED by the platform server (inline HTML, no build step):
  one card per registered game (name + player counts from the lobby), linking to `/<gameId>/`.
- `/fps/*` → fps client dist (SPA fallback), `/bank/*` → bank client dist.
- The fps client switches its Vite `base` to `/fps/` (asset paths); bank client uses `/bank/`.
- `/ws` stays the single websocket endpoint for all games.
- Docker/runtime layout must mirror: platform serves each module's clientDist under /<id>/.

## Tests (`games/bank/server/src/room.test.ts`)

Fake RoomIO; cover: safe-window 7 ⇒ +70; safe-window doubles ⇒ +sum (no double); post-safe
doubles ⇒ pot×2; post-safe 7 ⇒ round_end bust7, pot lost; bank mid-round ⇒ score += pot,
pot UNCHANGED, player banked, round continues; all banked ⇒ round_end all_banked; full
10-round match ⇒ match_end winner correct, reset to lobby; turn timer auto-roll fires;
mid-match joiner waits to next round; low-pop abort keeps scores.

## E2E (`scripts/e2e-bank.mjs`)

Two pages against the production build: A createPrivate('Alice') on the bank client → code;
B joins → both see 2 players; current player rolls until pot > 0 (assert state().pot > 0);
B calls bank() at any point → B score == pot-at-bank, pot unchanged, B banked; keep rolling
until the round ends (7 or all banked) → assert round increments; zero console errors.
Also screenshot the felt table for a visual check.

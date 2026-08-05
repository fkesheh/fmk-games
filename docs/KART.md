# KART — design + module contract (frozen)

The platform's third game: multiplayer kart racing. Three.js client, FULLY
SERVER-AUTHORITATIVE simulation: the wire carries INPUTS, the server integrates
every kart with the shared sim (`shared/sim.ts`) and owns positions, contact,
checkpoints, laps and results. The client runs the identical shared step for
prediction and replays unacknowledged inputs on top of the server's state
(same model as `games/fps/client/src/net/prediction.ts`).

Superseded design (v1, kept for context): positions used to be client-trusted —
clients streamed `{t:'kart_state', p, yaw, v}` at 15Hz and the room copied them
in, kart-vs-kart contact was resolved half-and-half on each client against raw
snapshot positions, and the server's echo was blended back with a cosmetic
0.35 tether. That is what "multiplayer feels bad" was: no momentum exchange, and
two clients that never agreed on where a kart was.

## Packages & files

- `games/kart/shared/` (@kart/shared) — types.ts / config.ts / palette.ts / protocol.ts /
  kartPhysics.ts / track.ts / sim.ts (FROZEN, exist)
- `games/kart/server/` (@kart/server) — room.ts, module.ts, room.test.ts
- `games/kart/client/` (@kart/client) — index.html, vite.config.ts (base '/kart/', port 5175,
  strictPort), src/{main.ts, app.ts, drive.ts, render.ts, audio.ts, style.css}

## Race flow (frozen)

- **Lobby:** players join (grid slot by join order). When ≥ MIN_PLAYERS: 5s "get ready",
  then countdown 3-2-1-GO (1s each, `phase:'countdown'`).
- **Pre-GO freeze (frozen):** karts may NOT move before GO. Client: the drive sim is frozen
  (inputs are still sent — zeroed — so the ack keeps flowing, but nothing is predicted).
  Server: inputs are consumed and ACKED but NOT integrated outside 'racing', and at GO every
  player's sim is reset to their grid slot and their input queue dropped — any pre-GO
  movement is impossible regardless of client behavior.
- **Race (`phase:'racing'`):** 3 laps (LAPS_TO_WIN). Clients stream `kart_input` at SIM_HZ.
  Server tracks per-player `progress` = lap×GATES + nextGateIndex; a gate credit requires
  passing within GATE_RADIUS of the expected gate IN ORDER (skipping gates gives no credit).
  Finish = progress ≥ LAPS_TO_WIN×GATES ⇒ `finishOrder` append; when all connected players
  finished (or RACE_TIMEOUT_S) ⇒ results.
- **Nitro (frozen):** each player gets NITRO_CHARGES (3) per race, refilled at GO. Pressing
  the nitro key (N) sends `{t:'nitro'}`; the server validates a charge remains (else silently
  ignores) and broadcasts a `nitro` race event (remote whoosh). The boost itself applies
  client-side in stepKart: +NITRO_BOOST engine for NITRO_TIME seconds (stacks with turbo).
  `you.nitroLeft` in snapshots is authoritative for the HUD pips; `nitroActive` on player
  snaps drives remote visuals.
- **Results (`phase:'results'`, 10s):** finishOrder + per-player best lap ms. Then back to
  lobby (scores/race state reset; players stay seated; new race starts when ≥ MIN_PLAYERS).
- **Mid-race joiners:** spawn at the back of the grid (progress 0, lap 1) and race too.
- **Low pop:** connected < MIN_PLAYERS mid-race ⇒ finish the race for the remaining player
  (they can still set laps), then results. Disconnects: remove immediately (racing has no
  rejoin-value v1) — except keep their finishOrder entry if already finished.
- info(): { game:'kart', label:'3 laps · circuit', phase, players, maxPlayers: 8 }.

## Net protocol (frozen, shared/types.ts)

- C2S (room-level): `{t:'kart_input', seq, throttle, brake, steer, drift, respawn, dt}` at
  SIM_HZ (30). NO MESSAGE NAMES A COORDINATE — that is the whole anti-cheat story: a client
  can only assert intent, and one input buys exactly one SIM_DT of simulation, so there is
  no clock to spoof either (`SIM_BUDGET_MUL` caps simulated seconds per real second).
  `respawn` rides the input stream rather than being its own message so it replays correctly
  in the middle of an unacknowledged queue.
- S2C: `{t:'kart_snapshot', tick, serverTime, phase, phaseEndsAt, countdown, playerCount,
  minPlayers, canStart, you:{lap,nextGate,progress,place,finished,finishMs,bestLapMs,
  nitroLeft,gapAheadMs,lastProcessedSeq,sim}, players:[{id,name,slot,color,p,yaw,v,steer,
  drift,lap,nextGate,progress,place,finished,finishMs,nitroActive}]}` at SNAPSHOT_HZ (20).
  `you.lastProcessedSeq` is the ack and `you.sim` the authoritative own KartSim the client
  re-bases on — per-recipient, so reconciliation costs one block per snapshot, not one per
  player per player. The server sims at SIM_HZ (30) and broadcasts at SNAPSHOT_HZ (20).
- Events: `{t:'race_event', ev:'countdown'|'go'|'lap'|'gate'|'nitro'|'bump'|'finish'|
  'timeout'|'restart', ...}` (lap/gate carry playerId + lap/gate + lapMs; finish carries
  place; `bump` carries both driver ids + the impulse — one server-resolved contact fact
  delivered identically to both drivers, instead of two clients guessing separately).
- joined payload: `{t:'kart_joined', you, gridSlot, phase, players:[{id,name,slot,color}]}`.
- Client HUD race clock = serverTime-based (phaseEndsAt for countdown/results).
- Remote karts render `INTERP_DELAY_MS` behind serverTime, defined as ~1.8 SNAPSHOT_HZ
  intervals (90ms at 20Hz) rather than a constant: the RATIO is what buys jitter tolerance
  (a snapshot may arrive most of an interval late and still be interpolated, not
  extrapolated), so tying it to the rate spends a faster snapshot stream on latency instead
  of on buffer. Two clients disagree about a kart's position by roughly this delay × its
  speed — with both peers now running the same physics, that render delay IS the
  disagreement, and it is a tuned smoothness/latency tradeoff rather than a netcode defect.

## Kart physics (frozen, shared/kartPhysics.ts + shared/sim.ts)

`kartPhysics.ts` is the handling model — deterministic per (state,input,dt,surface),
unchanged by the netcode work. `sim.ts` is the layer both peers run: `stepDrive(state,
input, dt, track)` wraps it in 120Hz substeps with the per-substep surface lookup, barrier
push-out, the gate/respawn-anchor tracker and the respawn teleport, so client and server
integrate the IDENTICAL code over the IDENTICAL inputs — that identity is what makes
prediction converge (a reconcile that finds no divergence moves the kart 0m).
`resolveKartPair(a, b)` is SERVER-ONLY: kart-vs-kart contact is resolved once, after every
kart has stepped, splitting the overlap AND exchanging normal momentum between equal masses
(KART_RESTITUTION), so a bump costs the hitter what it gives the hit and both drivers see
the same impact on the same tick. `KartPredictor` is the client's predict/replay loop.
See the file for the
exact model: per-gear engine force via an automatic 5-speed gearbox (rev limiter at each
gear top, SHIFT_TIME engine cut on upshift, downshift with DOWNSHIFT_HYST — wider than the
cut's speed cost so the box never oscillates), brake/reverse, bicycle steering with
speed-sensitive lock AND a grip-limited understeer cap (lateral accel ≤ 11 m/s² road /
6 grass — fast corners demand braking), lateral grip decay (asphalt vs grass), handbrake
DRIFT (grip collapse + sharper steer + cap bypass — a rotation tool, NO boost attached),
NITRO (see rules above), barrier push-out + velocity damp.
Steer semantics: positive steer = RIGHT (yaw decreases, platform convention).

## Gap timing (frozen)

The server records each player's timestamp at every gate credit. Each snapshot's
`you.gapAheadMs` estimates your gap to the player one place ahead: if you both have a
timestamp for the same gate sequence (lap×GATES+idx), gap = your time − theirs; otherwise
estimated from your spatial distance / 20 m/s. 0 for the leader. HUD shows it next to the
place: "P2 · +1.8s" / "P1 · LEADER".

## Onboarding hints (frozen)

Grid/lobby and the first ~6s after GO show a small controls hint card (non-modal, fades):
WASD/arrows drive · Space/Shift drift · N nitro ×3 · R respawn at last gate.

## Kids mode (frozen)

A per-player assist toggle ("KIDS MODE"): menu checkbox (persisted in localStorage) +
in-game toggle key T, HUD badge while active. When on, the CLIENT steers automatically
(pure-pursuit toward the centerline ~10m ahead, same sign convention as the input) and
ignores keyboard steer; the kid controls ONLY throttle/brake (and nitro). Server-side
indistinguishable from normal input. Debug surface exposes `assist` for e2e.

**Amended by `docs/TOUCH_PWA.md` — kids mode and TABLET MODE are independent axes.**
Tablet mode is an input surface (see that contract §4.2.0) and is NOT a children's
feature; kids mode is the assist, layered on top. All four combinations run.

Two consequences for this section, both previously inaccurate here:

- **Stuck auto-respawn is no longer assist-only.** It is armed by kids mode OR tablet
  mode (`drive.setStuckGuard`). The touch layout deliberately has no brake and no
  reverse, so a wedged touch player would otherwise have no recovery; a fourth
  right-hand target would crowd the gas/nitro channel the pad ergonomics are tuned
  around. A bare keyboard player still never gets it — they have R, and an
  unasked-for teleport is worse than being stuck. Verified to recover an
  adult-speed wedge (26.7 / 27.1 / 25.6 m/s impacts, ~3.3 sim-s to fire, drivable
  again within 8s). **Known limit:** recovery requires throttle held above 0.5, so
  a player who gives up and lifts off — or panic-mashes the accelerator — resets
  the timer. Unreachable in kids mode (auto-throttle is forced).
- **In tablet + kids the steering zones are NOT inert.** The assist owns the steer
  channel, so the two zones would have done nothing at all. `KIDS_TOUCH_NUDGE = 0.6`
  is added on top of pursuit steer, from the ext latch only — the term is exactly
  `+0` without touch, so keyboard kids mode and every e2e assist path are
  bit-identical. Because pursuit steer saturates at ±1 and the nudge is below 1,
  the assist always out-pulls a held thumb: the child gets real agency and still
  cannot steer off the road.

## Track (frozen, shared/track.ts)

One circuit: closed Catmull-Rom through TRACK_POINTS (authored below), road half-width
ROAD_HALF_W, 8 checkpoint gates (GATES) evenly sampled + start/finish at t=0. Helpers:
`closestOnTrack(x,z) → { t, dist, lateral }` (nearest centerline point; lateral signed),
`surfaceAt(x,z) → 'road'|'grass'` (|lateral| ≤ ROAD_HALF_W ⇒ road), `gatePos(i)`.
Track invariants (unit-tested): closed, no self-intersections, min turn radius ≥ 12m,
gate 0 == start/finish.

## Client modules (frozen exports)

- `render.ts`: `export class KartScene { constructor(canvas); setTheme(theme: TrackTheme);
  buildTrack(track: TrackDef): void; addKart(id, color): void; removeKart(id): void;
  updateKart(id, x,y,z, yaw, steer, drift, dt): void; setCamera(x,y,z, yaw, speed, dt): void;
  resize(): void; render(): void; dispose(): void; }`
  Flat-shaded Lambert, ACES, PCFSoft shadows, sky/fog, generated road mesh (strip along the
  spline with curb stripes), barriers, terrain, ~120 trees/rocks seeded, grid slots painted.
  Kart factory: 18-26 prims — chassis, nose, side pods, seat, engine block, roll bar, driver
  (helmet in player color), 4 wheels (front pair steer, all spin ∝ speed), tiny rear wing.
- `drive.ts`: `export class DriveController { constructor(track: TrackDef);
  setInput(inp: KartInput): void; step(dt): void; state(): DriveState;
  reset(x,z,yaw): void; flush(send): number; reconcile(auth: KartSim, ackSeq): number; }`
  — owns the keyboard/assist/freeze/nitro input sources and a shared `KartPredictor`:
  it produces ONE input per SIM_DT, applies it locally at once (steering stays instant),
  sends it, and replays whatever the server has not acked on top of `you.sim`. It no longer
  owns the sim loop (that is shared/sim.ts) and no longer resolves kart-vs-kart contact at
  all — the old `setOthers`/`repelOthers` position shove and the `correctTo` tether are gone.
- `app.ts`: connection/lobby (same platform flow as bank: quick_join/create public+private/
  join code/resume token optional v1: NOT required), countdown UI, HUD (place P1/8, LAP 2/3,
  speed km/h, lap time + best lap, drift/turbo meter), results table, menu, debug surface
  `window.__kart = { state(), joinQuick, createPublic, createPrivate, joinPrivate, setInput(throttle,brake,steer,drift), telemetry() }`.
- `audio.ts`: engine (pitch by speed), skid (drift), barrier thud, turbo whoosh, countdown
  beeps + go, finish stinger. WebAudio, synthesized, no assets.

## Server (games/kart/server/src/room.ts)

`KartRoom implements GameRoomHandle`. Per player: grid slot, color index, the authoritative
`KartSim`, the input queue + `lastProcessedSeq`, progress/lap/nextGate/bestLap/finished,
stalePlayers (no input for 10s). SIM tick at SIM_HZ (30): phase machine, consume up to
MAX_INPUTS_PER_TICK inputs per player and integrate each with `stepDrive`, credit gates per
step, then resolve every kart-vs-kart pair once, then places/timeout. SNAPSHOT tick at
SNAPSHOT_HZ (20): broadcast only. Both ticks allocate nothing per tick or per recipient
(the persistent snap/you/msg objects and the shared roster array are the whole reason
20 players cost 0 objects/tick instead of 1,260). `module.ts`: kartModule
(id 'kart', name 'KART GP', clientDist probing like the others, createRoom ignoring settings).

## Tests (games/kart/shared/src/sim.test.ts + games/kart/server/src/room.test.ts)

`sim.test.ts` (the netcode contract, all pure): identical inputs give bit-identical states;
integration from input; barrier clamp; the gate anchor + a replayable respawn; collision
momentum exchange (conserved, symmetric, order-independent, NaN-free when stacked); and a
simulated client/server pair proving reconciliation converges to a 0m correction and
re-converges after a perturbation.
`room.test.ts` (fake RoomIO + fake timers) drives karts by FEEDING INPUTS — there is no
message that can place a kart any more, so the suite mirrors the shared sim locally and
asserts the room's positions match it: the server integrates from inputs; a client cannot
move by reporting a position; two karts colliding exchange momentum and both get the same
`bump`; gate credit in order only (driving the track BACKWARDS credits nothing); the pre-GO
freeze; the ack advances; the speedhack budget holds; plus the frozen lobby/countdown/
laps/finish/results/mid-race-joiner/timeout/bestLap rules.

## E2E (scripts/e2e-kart.mjs)

Two browsers: A createPrivate, B joins → countdown observed → drive A forward via
__kart.setInput (throttle 1) → assert A's position advances (position moves > 10m) and B
sees A moving (interpolated remote position changes) → assert progress/nextGate eventually
> 0 for A → zero console errors. Screenshots: grid countdown + mid-race chase cam.

## Track control points (authored, x/z meters, closed loop ~520m)

[0,-82] [58,-80] [92,-58] [88,-16] [58,4] [62,44] [28,68] [-18,60] [-66,64] [-92,38] [-78,2] [-92,-38] [-58,-68] [-24,-58]
Start/finish at t=0 (point [0,-82]), direction of travel = increasing t (counter-clockwise).

# KART — design + module contract (frozen)

The platform's third game: multiplayer kart racing. Three.js client, authoritative
race rules on the server, client-simulated kart physics (documented tradeoff:
positions are client-trusted; the SERVER owns checkpoints/laps/results — casual
anti-cheat only, same class as .io racers).

## Packages & files

- `games/kart/shared/` (@kart/shared) — types.ts / config.ts / palette.ts / protocol.ts /
  kartPhysics.ts / track.ts (FROZEN, exist)
- `games/kart/server/` (@kart/server) — room.ts, module.ts, room.test.ts
- `games/kart/client/` (@kart/client) — index.html, vite.config.ts (base '/kart/', port 5175,
  strictPort), src/{main.ts, app.ts, drive.ts, render.ts, audio.ts, style.css}

## Race flow (frozen)

- **Lobby:** players join (grid slot by join order). When ≥ MIN_PLAYERS: 5s "get ready",
  then countdown 3-2-1-GO (1s each, `phase:'countdown'`).
- **Pre-GO freeze (frozen):** karts may NOT move before GO. Client: the drive sim is frozen
  (no input, no stepping) in lobby/ready/countdown. Server: kart_state positions are IGNORED
  outside 'racing', and at GO every player's snapshot position is reset to their grid slot —
  any pre-GO movement is wiped server-side regardless of client behavior.
- **Race (`phase:'racing'`):** 3 laps (LAPS_TO_WIN). Clients stream `kart_state` at 15Hz.
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

- C2S (room-level): `{t:'kart_state', p:[x,y,z], yaw, v:[vx,vz], steer, drift, seq}` 15Hz.
- S2C: `{t:'kart_snapshot', tick, serverTime, phase, phaseEndsAt, countdown, you:{lap,nextGate,
  progress, place, finished, finishMs, bestLapMs}, players:[{id,p,yaw,v,steer,drift,lap,
  nextGate,progress,place,finished,finishMs}]}`, 15Hz (driven by incoming states; server
  also ticks at 15Hz to keep phase/places fresh).
- Events: `{t:'race_event', ev:'countdown'|'go'|'lap'|'gate'|'finish'|'timeout'|'restart', ...}`
  (lap/gate carry playerId + lap/gate + lapMs; finish carries place).
- joined payload: `{t:'kart_joined', you, gridSlot, phase, players:[{id,name,slot,color}]}`.
- Client HUD race clock = serverTime-based (phaseEndsAt for countdown/results).

## Kart physics (frozen, shared/kartPhysics.ts)

Client-owned simulation; deterministic per (state,input,dt,surface). See the file for the
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
  setInput(inp: KartInput): void; step(dt): void; state(): KartState & {steer, driftVisual};
  reset(x,z,yaw): void; }` — wraps shared stepKart at fixed 120Hz substeps + local barrier
  collision + off-track surface lookup + other-kart soft repulsion (setOthers([...])).
- `app.ts`: connection/lobby (same platform flow as bank: quick_join/create public+private/
  join code/resume token optional v1: NOT required), countdown UI, HUD (place P1/8, LAP 2/3,
  speed km/h, lap time + best lap, drift/turbo meter), results table, menu, debug surface
  `window.__kart = { state(), joinQuick, createPublic, createPrivate, joinPrivate, setInput(throttle,brake,steer,drift), telemetry() }`.
- `audio.ts`: engine (pitch by speed), skid (drift), barrier thud, turbo whoosh, countdown
  beeps + go, finish stinger. WebAudio, synthesized, no assets.

## Server (games/kart/server/src/room.ts)

`KartRoom implements GameRoomHandle`. Per player: grid slot, color index, last kart_state,
progress/lap/nextGate/bestLap/finished, stalePlayers (no state for 10s). Tick 15Hz: phase
machine, place computation, timeout checks, snapshot broadcast. `module.ts`: kartModule
(id 'kart', name 'KART GP', clientDist probing like the others, createRoom ignoring settings).

## Tests (games/kart/server/src/room.test.ts)

Fake RoomIO + fake timers: countdown sequence phases; gate credit in order only; skipping a
gate gives no lap; 3 laps ⇒ finish + finishOrder; results phase then lobby reset; mid-race
joiner starts at back; timeout ends race; bestLap tracked.

## E2E (scripts/e2e-kart.mjs)

Two browsers: A createPrivate, B joins → countdown observed → drive A forward via
__kart.setInput (throttle 1) → assert A's kart_state advances (position moves > 10m) and B
sees A moving (interpolated remote position changes) → assert progress/nextGate eventually
> 0 for A → zero console errors. Screenshots: grid countdown + mid-race chase cam.

## Track control points (authored, x/z meters, closed loop ~520m)

[0,-82] [58,-80] [92,-58] [88,-16] [58,4] [62,44] [28,68] [-18,60] [-66,64] [-92,38] [-78,2] [-92,-38] [-58,-68] [-24,-58]
Start/finish at t=0 (point [0,-82]), direction of travel = increasing t (counter-clockwise).

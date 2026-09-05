# PLATFORM v2 — surface map + architecture proposal

Status: **PROPOSAL v1** (architect draft for discussion) · frozen pieces marked 🔒.
Everything here is **additive** to the existing platform (`docs/STRUCTURE.md`): all 7
registered games keep compiling and playing unchanged.

---

## 1. Where we are

The repo already is a multiplayer game platform: one Node process serves HTTP + one
WebSocket (`/ws`), a lobby does matchmaking/public+private rooms, games plug in via the
frozen `GameModule` contract (`platform/shared/src/module.ts`), and 7 games ship on it.
Identity today = anonymous browser signature (`identity.ts`) + shared display name +
per-game session resume pointers. PWA installs work per game. There is an orphaned
phone-pad e2e script referencing a protocol that was never built.

What the vision adds, mapped to gaps:

| Ask | Today | v2 |
|---|---|---|
| User profiles | browser-local sig+name | server-side profiles, device-link claim codes, stats |
| Save games | per-game localStorage only | cloud saves w/ optimistic concurrency, quota, REST |
| Multiplayer connection | ws lobby+rooms (good) | kept; + authenticated sessions |
| Basic game engine | each game re-implements rig/loop/pools | `@platform/engine` shared toolkit |
| SDK | server-side GameModule only | client-side `@platform/sdk` facade |
| Gamepad (physical) | nothing | SDK InputHub merges Gamepad API into one input frame |
| Phone as gamepad | orphan script | platform pad-pairing for ANY game + generic pad page |
| Native app later | n/a | transport is WS+REST already; DOM-free core split documented |

## 2. Principles (carried from the repo)

1. **Zero assets** — procedural geometry, synthesized audio, palette-driven color.
2. **Server-authoritative gameplay** where there is multiplayer; client-sim solo games.
3. **Robustness over purity** — any bad input/degraded dependency must never kill the
   server or white-screen a client (DB failure ⇒ in-memory fallback).
4. **Additive evolution** — frozen contracts amend only by adding optional members;
   old games must never notice v2 landed.
5. Boring stack: Node 24 + `node:sqlite`, ws, three.js, Vite, strict TS monorepo.

## 3. Surface map

```
BROWSER                                    SERVER (one process)
┌────────────────────────────┐             ┌──────────────────────────────────┐
│ GAMES                      │             │ registry (GameModule[])          │
│  stricken bank kart … +    │             │ lobby: rooms/matchmaking/pads    │
│  NEW orbit sumo ghostrun   │             │ net: http + /ws + static + pwa   │
├────────────────────────────┤             ├──────────────────────────────────┤
│ @platform/sdk   (NEW)      │  ws /ws     │ services/httpApi (NEW)           │
│  connect rooms profile     │  rest /api  │  auth · profiles · saves · pads  │
│  saves input audio         │◄───────────►│ services/db (NEW, node:sqlite)   │
├────────────────────────────┤             │  profiles·tokens·saves·stats     │
│ @platform/engine (NEW)     │             └──────────────────────────────────┘
│  loop rig prims pools cams │                        ▲
├────────────────────────────┤             ┌──────────┴───────────┐
│ three.js                   │             │ PHONE PAD PAGE       │
└────────────────────────────┘             │ /pad/?game=<id>      │
                                           └──────────────────────┘
```

Dependency law (unchanged): platform never imports games; games import platform
packages freely; `registry.ts` stays the only game-importing file.

## 4. Services

### 4.1 Profiles + auth (frictionless-first)

- **Device-first**: the browser's existing durable `sig` is the credential.
  `POST /api/auth/device {sig}` → creates-or-returns a profile `{profileId, token, name}`.
  Token = 43-char base64url random; stored plaintext in `tokens` (game-grade secret,
  rotatable). Client caches under `play.auth`.
- **Cross-device link**: profile page mints a 6-char claim code (TTL 10 min, single use);
  another device calls `POST /api/auth/claim {sig, code}` → joins the SAME profile
  (saves/stats/name follow the person, not the device).
- **No passwords/email in v2.** Deliberate: the audience includes kids on iPads
  (see TOUCH_PWA.md). Passkeys/OAuth noted as future; schema won't fight it.
- **WS attach**: optional first message `{t:'auth', token}` binds the session to the
  profile (`auth_ok`/`auth_err`). Unauthenticated play remains fully supported.
- Display name lives on the profile once authenticated; PATCH `/api/profiles/me {name}`
  renames platform-wide (games that take join names still override locally).

### 4.2 Saves

Cloud key-value slots with versioning — games own their schema, platform owns
storage/concurrency/quota:

```
GET    /api/saves/:game              → [{slot, rev, updatedAt, size}]
GET    /api/saves/:game/:slot        → {slot, rev, data, updatedAt}
PUT    /api/saves/:game/:slot        body {rev, data} → {rev} | 409 {rev}
DELETE /api/saves/:game/:slot
```

- `data`: opaque JSON object/array, ≤ SAVE_MAX_BYTES (64 KB); slot names `[a-z0-9_-]{1,24}`;
  ≤ 12 slots/game/profile. `rev` starts at 0; PUT carries the rev you based your edit on
  → conflict returns current record (client decides: overwrite or merge).
- Auth required (401 otherwise). REST only → idempotent, proxy-friendly, native-ready.

### 4.3 Stats

Rooms report counters; platform sums them per profile+game:

```ts
// RoomIO gains OPTIONAL member (module.ts amendment, additive):
reportStats?(playerId: PlayerId, delta: Record<string, number>): void;
```

Fire-and-forget from game threads; gateway resolves playerId→profileId (no-op when
anonymous), clamps finite numbers, upserts `stats(profileId, gameId, key, value)`.
Read side: `GET /api/profiles/me/stats[/:game]`, `GET /api/profiles/:id/stats[/:game]`.
Leaderboards = ORDER BY later; same table.

### 4.4 Gamepads + phone-as-pad

Two paths, ONE normalized shape (`PadFrame`):

- **Physical gamepads**: Gamepad API polled inside SDK `InputHub`; standard mapping;
  never leaves the browser.
- **Phone as pad** (any game, platform-level):
  1. In-room client sends `{t:'pad_pair_request'}` → `{t:'pad_pair', room, token}`,
     shows a 6-char pairing code + the `/pad/?game=<id>&r=<room>` URL (SDK helper overlay; no QR dep in v1).
  2. Player opens that URL on the phone (or types the code at `/pad/`); page opens its own ws and sends `{t:'join_as_pad', room, token:code}` → bound
     (`pad_joined` to pad; `pad_status {bound:true}` to player). Token single-use, TTL 5 min.
  3. Pad streams `{t:'pad_input', seq, lx, ly, rx, ry, buttons}` ≤30 Hz; server acks
     `pad_input_echo {seq}` (RTT), forwards RAW into the room as the pad session's
     message; game maps pad→player seat itself (it knows who requested pairing via
     `RoomIO.padOwner?(padSessionId)` — new optional member).
  4. Leave/disconnect → `pad_status {bound:false}`.
- A game declares support additively: `GameModule.padLayout?: PadLayout` (which sticks/
  buttons exist, labels). Served at `GET /api/pads/:game`; the generic pad page renders
  itself from it (server-generated HTML, same pattern as the launcher).
- The old `e2e-pad.mjs` targets a protocol that was never implemented; replaced by the
  new `scripts/e2e-platform.mjs`.

### 4.5 `@platform/sdk` — the integration story

One import for a game client:

```ts
import { createGameClient } from '@platform/sdk';
const gm = createGameClient({ gameId: 'sumo', canvas });
await gm.ready;                       // identity + auth + token restore
gm.profile.me();                      // {id, name} | null
await gm.saves.put('best', myRev, data);
gm.input.frame();                     // merged kb+gamepad(+touch) InputFrame
gm.rooms.quickJoin({ name });         // lobby ops typed against LobbyC2S
gm.net.send({ t: '…' }); gm.net.onMessage = …;   // raw envelope passthrough
gm.audio.sfx('jump');                 // tiny synth kit
gm.showPadQr();                       // phone pairing overlay (when padLayout set)
```

Services usable standalone; facade just wires them. Net layer brings reconnect/backoff,
ping EMA + min-RTT clock offset (pattern proven in STRICKEN's connection.ts).
DOM-free core (`net/profile/saves/types`) separated so a native shell could reuse it.

### 4.6 `@platform/engine` — basic engine, not a framework

What every 3D game here re-writes, extracted once:

- `Loop` — fixed-step accumulator (default 30 Hz sim / rAF render, catch-up clamp),
  pause/resume, dt seconds.
- `SceneRig` — renderer/camera/lights/fog/shadow/resize/dispose (generalized from fps).
- `prims` + `bake` — box/cyl/cone/sphere/mat factory vocabulary + static batching.
- `Pools` — particles/tracers, zero per-frame allocation.
- Cameras: fps / chase / orbit rigs. `DebugHud` overlay (fps/tick/pos).

No physics, no ECS in v2 — games bring their own math (shared rng/vec live in
`@platform/shared` already). Escalation path documented, not built.

## 5. 🔒 Contract amendments (all ADDITIVE to frozen files)

| File | Change |
|---|---|
| `platform/shared/src/module.ts` | `RoomIO` += optional `profileId(id)` , `reportStats(id, delta)` ; `GameModule` += optional `padLayout?: PadLayout` |
| `platform/shared/src/protocol.ts` | `LobbyC2S` += `auth{token}`, `pad_pair_request`, `join_as_pad{room,token}`, `pad_input{seq,lx,ly,rx,ry,buttons}` ; `LobbyS2C` += `auth_ok`, `auth_err`, `pad_pair`, `pad_status`, `pad_joined`, `pad_rejected`, `pad_input_echo` |
| `platform/shared/src/services.ts` | NEW types-only file: ProfileId/Token/SaveRecord/StatsDelta/PadLayout/PadFrame + wire validators |
| `platform/shared/src/limits.ts` | NEW pure-data file: quotas, TTLs, rate caps |

Old games compile untouched because every amendment is optional/new-file. New rules:
games SHOULD route persistence through the SDK; MUST NOT read the DB directly (they
can't — no driver ships to clients).

## 6. Storage

`node:sqlite` (Node 24 builtin, zero deps), WAL, single file `platform/server/platform.db`
(gitignored). Migration table `schema_migrations`. If sqlite can't open (locked FS,
read-only deploy): in-memory shim, log loudly, platform keeps running — matches repo
robustness rule. Backup = file copy (documented).

## 7. Games on the new arch (v2.2 revision)

Every legacy game now has a registered **·SDK twin** built by the same recipe:
`variantOf()` (same rooms, second id, correct `RoomInfo.game`) + a copied
client with its join envelopes retargeted. Legacy registrations untouched.

| Twin | Port | Pattern |
|---|---|---|
| **ANCIENTS·SDK** `/ancients/` | MOBA | `riftModuleVariant()` (pad adapter + stats sink) + SDK auth shell |
| **BANK·SDK** `/bank-sdk/` | dice | flagship: SDK auth shell + **canonical P2P transport** (host-authoritative) |
| WORDBOMB·SDK / KART·SDK / SPLAT·SDK / STRICKEN·SDK / OUTPOST·SDK | — | mechanical copies: retargeted joins, own dev ports, own dists |

Two known limits: fps/outpost join envelopes omit the `game` field, so those
two ports required explicit per-client retargets (done); pad layouts exist
where the game declares them, consumed by the generic `/pad/` page.

## 8. Native app door (design note, not built)

Native shell needs exactly: WS envelope + REST endpoints (both stable surfaces above)
and zero DOM assumptions in `sdk/net|profile|saves` + `shared/*`. Input/engine/audio
are DOM-bound adapters behind interfaces — swap implementations per platform later.

## 9. Decomposition (disjoint file ownership, fan-out ready)

| # | Module | Owns (only these) |
|---|---|---|
| P1 | shared-contract | `services.ts`, `limits.ts`, additive edits to `module.ts`/`protocol.ts` (architect-written, frozen pre-fan-out) |
| P2 | srv-db | `platform/server/src/services/{db.ts, db.test.ts}` |
| P3 | srv-api | `platform/server/src/services/{auth.ts, profiles.ts, saves.ts, httpApi.ts, httpApi.test.ts}` |
| P4 | srv-gateway | edits to `net.ts` (api hook), `index.ts` (wiring), `lobby.ts` (auth attach, pad routing, RoomIO impl, stats sink), `lobby.test.ts` additions |
| P5 | engine | `platform/engine/**` |
| P6 | sdk-core | `platform/sdk/src/{client.ts, net.ts, rooms.ts, profile.ts, saves.ts}` + tests |
| P7 | sdk-input-audio | `platform/sdk/src/{input.ts, audio.ts, padQr.ts}` + tests |
| P8 | pad-page | `platform/server/src/padPage.ts` (+ route registration handed to P3's router through contract) |
| P9–P11 | orbit / sumo / ghostrun | `games/<id>/**` |
| INT | integrator | `registry.ts`, launcher copy, root gates, `scripts/e2e-platform.mjs`, residual fixes |

## 10. Gates

Existing: typecheck (strict, all workspaces) · vitest · build (clients+server) ·
per-game e2e suites. Platform: `scripts/e2e-platform.mjs` (bare-websocket +
fetch: auth → saves/conflict → pads → stats → legacy regression) and
`scripts/e2e-p2p-bank.mjs` (two headless browsers: standard menu over the P2P
transport, one code, guest joins over the DataChannel, both at the table,
host-tab rolls land in the guest UI, zero console errors — 7/7 then 9/9).

---

## 11. Open questions for you (answer whenever; none block the build)

1. **Accounts**: OK with passwordless device-profiles + claim-code linking? Or do you
   want email/passkey auth in v2?
2. **Monetization-ish surfaces**: should profiles carry cosmetics/unlocks now (schema
   headroom exists) or strictly stats+saves?
3. **Showcase games**: are ORBIT/SUMO/GHOSTRUN the right three, or would you rather I
   port an existing game (kart?) onto the SDK as the third proof?
4. **Leaderboards**: global top-N per game now (cheap off the stats table) or later?
5. **Persistence scope**: single-file sqlite fine for launch? (Postgres migration path
   stays open; the db module hides it behind one interface.)

---

## 12. PROPOSAL v1 — player-hosted authority ("master + standby slaves") 🔶 DISCUSSION

*Your question: instead of hosting the sim server-side, ship it to every player;
one client becomes MASTER (authoritative), others run as STANDBY slaves; the
server only decides who is master.* Short answer: **yes — viable and worth
piloting**, with three honest corrections to the mental model.

### 12.1 Correction 1 — you don't need WASM for this

Every gameplay sim in this repo is already deterministic TypeScript running
identically in Node and the browser (that is what makes STRICKEN's prediction
and KART's shared physics work). A browser tab can host the authoritative tick
loop today. WASM becomes interesting LATER, for three narrower reasons:

1. one compiled artifact distributed to all clients (no JS-bundle drift),
2. stronger float determinism guarantees across engines,
3. perf headroom for bigger sims.

So the plan compiles sims to WASM when they earn it — it is not the mechanism
that makes player-hosting possible.

### 12.2 Correction 2 — this moves CPU, not bandwidth (yet)

Browsers cannot accept incoming connections. Peers cannot dial the master
directly, so traffic still relays through the platform server in a star
topology. What you save: all per-room tick loops, bot brains, physics and
vision filtering leave the server. What you don't (yet): upstream bytes — the
master's snapshot stream still flows through our relay. True P2P bandwidth
relief requires WebRTC DataChannels (signaling we already have; TURN fallback
for symmetric NATs is the real cost). Phase it separately.

### 12.3 Correction 3 — the cheat surface changes shape

Today the server sees everything and clients see filtered snapshots. With a
player-hosted master, the master process holds FULL state — including what fog
of war hides in ANCIENTS. Mitigations, in rising order of effort:

- **Rotate masters per match** (a cheater gets one match, not a throne),
- keep matchmaking, identity, economy and stats server-authoritative always,
- host filters its own snapshots (it still *could* peek — accepted risk for a
  casual platform; state it openly rather than pretend otherwise),
- later: server-side spot-checks (impossible-state detection on relayed snaps).

### 12.4 The protocol (what the server decides)

```
create_room(hostedAuthority=true)
  lobby elects HOST: lowest rtt among capable sessions, tie → longest-lived
  lobby → room: {t:'host_lease', leaseId, hostId, ttlMs}
  host opens sim, streams snapshots THROUGH the relay tagged {leaseId}
  standbys shadow-sim every input broadcast deterministically, ack ticks
  every ttlMs/2: host renews {t:'host_renew', leaseId, tick}
  lease lapses (2 missed renewals):
    lobby promotes the standby whose lastAckTick >= lastKnownTick - N
      (deterministic shadow ⇒ zero-gap promotion; else snapshot catch-up)
    room: {t:'host_change', newHostId, resumeTick}
  host leaves cleanly: same path. Server NEVER runs the sim in this mode.
```

Server-side additions stay small: lease table, renewal watchdog, promotion
arbiter, input/snapshot relay tagging. All behind a per-game flag so legacy
authoritative rooms are untouched.

### 12.5 Phased plan

| Phase | Deliverable |
|---|---|
| P0 | this design, agreed or amended by you |
| P1 | lobby primitives: lease/renew/change messages + watchdog (unit-tested), no consumer yet |
| P2 | ANCIENTS pilot: hostedAuthority room setting; host = elected client running @rift/server sim compiled for the browser; standbys shadow; server relays only |
| P3 | WASM compile of the rift sim (single .wasm artifact served from /ancients/) |
| P4 | optional WebRTC mesh for bandwidth offload |

### 12.6 What stays central regardless

Identity/profiles, saves, stats, matchmaking, room lifecycle, master election,
relay, abuse limits. The platform shrinks from "game server" to "arena
authority" — which is exactly the shape that also serves a future native app.

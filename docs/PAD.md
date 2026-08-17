# PAD — phone-as-controller (FROZEN CONTRACT)

> FROZEN CONTRACT — immutable once fan-out has started.
> If this contract is wrong or incomplete, STOP and report to the orchestrator;
> do not amend locally. Local amendments cause parallel implementers to diverge.

A **pad** is a phone browser session that controls a seated player's kart. The
desktop renders the game; the phone is the input device. Input flows
**phone → server directly** (no desktop relay); the server integrates it into
the bound player's simulation exactly as if it came from the player's own
client, and echoes it to the desktop so client-side prediction stays honest.

## Layer split

- **Platform (game-agnostic, reusable):** the join handshake only.
  - `platform/shared/src/pad.ts` — `PAD` limits, `PadJoinErrorCode`.
  - `platform/shared/src/protocol.ts` — lobby message `{t:'join_as_pad', room, token}`.
  - `platform/shared/src/module.ts` — optional `GameRoomHandle.addPad(id, token): boolean`.
  - `platform/server/src/lobby.ts` — routing (implementation, T1).
- **Game (kart):** everything past the bind — `games/kart/shared/src/pad.ts`.
  Token issuance, control transfer, echo, unbind. The pad reuses the existing
  `kart_input` / `{t:'nitro'}` shapes; there is no parallel input protocol.

## Lifecycle

1. **Pair request.** Desktop player sends `{t:'pad_pair_request'}` (raw
   pass-through; lobby never sees it). Room mints a single-use token (TTL
   `PAD.tokenTtlMs` = 60s), replies to that player only:
   `{t:'pad_pair', room, token, expiresInMs}` where `room` is the private join
   code when the room has one, else the roomId. A new request invalidates the
   player's previous unconsumed tokens.
2. **QR.** Desktop renders a QR for
   `${location.origin}/kart/pad.html?room=<room>&token=<token>`
   (`KART_PAD_PAGE_PATH` — a file URL, not a directory: the platform static
   server SPA-fallbacks directory misses to the game page, and vite dev only
   serves the real multi-entry html). `location.origin` is whatever the
   desktop used — for phone-over-LAN testing the desktop must itself be open
   via the LAN address, not `localhost`.
3. **Join.** Pad page opens `/ws`, sends `{t:'join_as_pad', room, token}`.
   Lobby resolves `room` (public roomId, or private code case-insensitively),
   then:
   - no such room → `{t:'error', code:'no_room'}`
   - room's game has no `addPad` → `{t:'error', code:'pad_unsupported'}`
   - `addPad` returns false → `{t:'error', code:'pad_rejected'}`
   - `addPad` returns true → session joins the room as a pad; the room sends
     the pad `{t:'pad_joined', name}` and the player `{t:'pad_status', bound:true}`.
4. **Control transfer.** While bound, the room drops `kart_input`/`nitro` from
   the player session and accepts them from the pad session (same validators,
   same per-player input queue, same sim-budget enforcement). The player's seq
   gate is **reset on every bind and unbind** so the pad's fresh seq counter
   (starts at 0) and later the desktop's resumed stream both pass. Every
   accepted pad input is echoed to the player session as
   `{t:'pad_input', input}`; the desktop pushes these into its predictor and
   **does not emit its own `kart_input` while bound**.
5. **Unbind.** Pad socket drop, pad `{t:'leave'}`, or a new pad binding
   (replace): the room unbinds, sends the player `{t:'pad_status', bound:false}`,
   resets the seq gate, and sends a still-connected old pad
   `{t:'pad_left', reason:'replaced'}`. **Replacement is atomic from the
   player's view**: only the final `{t:'pad_status', bound:true}` for the new
   pad is sent — no intermediate `bound:false` flicker (amended post-review;
   the old pad still gets its `pad_left`). If the bound *player* is removed, the
   pad gets `{t:'pad_left', reason:'player_left'}`.
6. **Death.** Pads never count in `playerCount()` and never keep a room alive.
   A pad whose socket outlives its room may linger until disconnect; its
   messages route to the stopped room and are dropped (accepted limitation —
   no lobby cleanup sweep for orphaned pad sessions in v1).

## Error taxonomy (pad-observable)

| Code | Source | Recoverable? | Pad page action |
|---|---|---|---|
| `no_room` | lobby | no (room gone) | "Game not found — rescan the QR" |
| `pad_unsupported` | lobby | no | "This game has no phone-controller mode" |
| `pad_rejected` | lobby (addPad=false) | yes — new QR | "Pairing expired — regenerate the QR and rescan" |
| `pad_left.replaced` | room | yes — new QR | "Another phone took over" |
| `pad_left.player_left` | room | no | "The player left the game" |

## Decision log

- **Direct-to-server, not desktop relay**: one less hop, desktop tab
  throttling can't stall input, server validates pad input with the same path
  it already trusts.
- **`addPad` optional on `GameRoomHandle`**: games opt in; lobby can answer
  `pad_unsupported` without knowing which games support pads.
- **Token validated by the room, not the lobby**: tokens are game-level state
  (the room minted them); the lobby stays game-agnostic.
- **Pad reuses `kart_input`/`nitro`**: one validator, one queue, one budget;
  bound pad input is exactly as trustworthy as client input.
- **Control transfer (not merge)**: two interleaved seq streams would fight
  the monotonic seq gate; "your phone IS the controller now" is also the
  least surprising UX. Keyboard control returns on unbind.
- **Echo for prediction**: the desktop predictor needs the exact inputs the
  server integrated; `{t:'pad_input'}` echo is the kart-specific instance of
  "server feeds prediction data to the display client".
- **`room` field is code-or-roomId, resolved by the lobby**: pads must work
  for both public and private rooms without the pad page knowing which.
- **QR is client-rendered** (desktop kart client, tiny QR lib): no server
  asset pipeline change; the URL is pure data the room already provided.
- **Orphaned pad sessions are not swept in v1**: cosmetic leak only; noted so
  no implementer "fixes" it differently.

## Testing anchors

- Lobby: join_as_pad routes to `addPad`; the three error codes; pad messages
  route to the room post-bind; pad disconnect unbinds via `removePlayer`.
- Kart room: pair→bind→input→echo→unbind cycle; token single-use + TTL;
  control transfer drops player-session input while bound; seq-gate reset.
- Desktop client: pad mode suppresses own emission, echo feeds predictor,
  `pad_status` toggles UI.
- Pad page: bad/expired token screens; claim → stream at SIM_HZ.

# @platform/sdk — integration guide

One import per concern. Everything is usable standalone; the facade just wires
things together. Strict TypeScript throughout; storage access is guarded
(private mode never throws).

## 30-second start (online play)

```ts
import { createGameClient } from '@platform/sdk';

const game = createGameClient({ gameId: 'bank-sdk', canvas });
await game.ready; // identity loaded, first connect settled, auth replayed

game.net.onMessage = (msg) => { /* lobby replies + room messages land here */ };
game.rooms.quickJoin('Ada');
game.input.start();
const frame = game.input.frame(); // { moveX, moveZ, lookDX, lookDY, buttons }
game.audio.resume(); // call from the first user gesture
game.audio.sfx('click');
```

## Services (use à la carte)

| Import | What |
|---|---|
| `SdkNet` (`net.js`) | ws with reconnect/backoff, ping EMA, min-RTT clock (`serverNow()`), auth replay |
| `LobbyRooms` (`rooms.js`) | typed lobby senders: list/quickJoin/joinPublic/createPublic/createPrivate/joinPrivate/leave |
| `Profiles` (`profile.js`) | device auth, rename, claim codes; `new Profiles(null)` for REST-only use (no socket) |
| `CloudSaves` (`saves.js`) | optimistic-concurrency slots: `list/get/put/del`, plus `updateSave()` merge helper |
| `GameInputHub` (`input.js`) | merged keyboard + Gamepad API + touch → `frame()`/`edges()`; remappable |
| `SynthKit` (`audio.js`) | 10 synthesized voices + wind/hum beds, zero samples |
| `RtcStar` (`rtc.js`) | WebRTC DataChannel star over the `rtc_signal` relay; RTC injectable for tests |
| `HostedLobby` (`hosted.js`) | **host-tab runtime**: give it your room factory + code source, get a full mini-lobby |
| `reportStat(s)` (`stats.js`) | self-reported counters (`POST /api/stats/:game`, Bearer-bound) |
| `fetchPadLayout` (`pads.js`) | the game's virtual-controller schema, or null |
| `showPadPairing` (`padQr.js`) | phone-pairing overlay (code + URL) |

## Hosting a P2P match (the 20-line version)

```ts
import { HostedLobby, mintRoomCode } from '@platform/sdk/hosted.js';
import { MyRoom } from '@my-game/server/room.js'; // isomorphic TS: no node imports!

const lobby = new HostedLobby({
  createRoom: (io, settings) => new MyRoom('private', io, settings),
  newRoomCode: () => shellCodeFromRendezvous(),
  snapshotTag: 'my_state', // snapshots get the joinable code rewritten + cached
});
lobby.attach(myId, { deliver: (json) => game.ingest(json) });
lobby.handleFrame(myId, JSON.stringify({ t: 'create_private', name }));
// guests: lobby.attach(guestId, dcSink); lobby.handleFrame(guestId, frame);
// late joiners: lobby.sync(guestId) replays the last snapshot (join race)
```

Rules the helper enforces so you don't have to: wrong codes get `no_room`
(never a throw), malformed frames drop silently, seats ghost on detach
(reconnect re-binds by session id), pings answer locally.

## Saves, the optimistic way

```ts
import { updateSave } from '@platform/sdk/saves.js'; // (via game.saves too)
await updateSave(game.saves, 'best', (cur: { score: number } | null) =>
  cur === null || score > cur.score ? { score } : cur,
); // get → merge → put, one automatic retry on rev conflict
```

## Phone-as-controller

1. Game declares `padLayout` on its module (served at `GET /api/pads/:game`).
2. In-game: `game.showPadPairing()` renders code + URL overlay.
3. Phone opens the URL, enters the code, streams normalized frames the room
   consumes — see `docs/PAD.md` for the wire contract.

## Conventions to respect

- Colors/palette, balance numbers, and wire validation live in shared
  packages — never redeclare them client-side.
- `Math.random` is banned in gameplay paths; use `rng(seed)` from shared.
- Never throw on wire data (parse → validate → drop).
- Auth tokens live in guarded storage; anonymous play must always work.

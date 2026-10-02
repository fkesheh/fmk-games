---
type: investigation
symptom: "fps STRICKEN stuck at JOINING / Reconnecting… on fmk-games.fly.dev"
slug: fps-join-reconnecting
date: 2026-09-29T07:40:07-0300
investigator: Foad Kesheh
git_commit: 72497e03a28a109536014cb120fbf35548640551
branch: assets-trees-v2
repository: fps
status: investigating
hypotheses_formed: 0
hypotheses_rejected: 0
hypotheses_proven: 0
related: []
---

# fps STRICKEN stuck at JOINING / Reconnecting…

## Symptom
- **Observed**: User loaded FPS (STRICKEN) on https://fmk-games.fly.dev and the client sat at the JOINING overlay with the "Reconnecting…" subtitle. Server log shows exactly one room lifecycle around the attempt:
  ```
  2026-09-29T10:36:36Z app ... [lobby] room 98W5821H created (public, game fps); 1 open
  2026-09-29T10:37:52Z app ... [lobby] room 98W5821H closed (empty public); 0 open
  ```
  A raw websocket-upgrade probe with curl to `https://fmk-games.fly.dev/ws` returns **404** (while `/fps/` returns 200).
- **Expected**: Client joins (or creates) an FPS room within a few seconds and enters the match; no reconnect loop.
- **Delta**: Join never completes; client enters the auto-rejoin path ("Reconnecting…", see `tryAutoRejoin` in `games/fps/client/src/game/clientGame.ts`) and the created room ends up empty and is swept.

## Reproduction
`node scripts/probe-fps-join.mjs` (puppeteer, real Chromium against prod):
- **A fresh-join**: `__fps.joinQuick()` immediately after boot → 3/3 stuck on
  "Reserving a slot on the server…", `roomId=null`, zero console errors.
- **B stale-session**: stored dead session → infinite "Reconnecting…", session
  never cleared, zero console errors.
- `node scripts/probe-fps-arc.mjs` (same flow but waits 1500ms before
  joinQuick) joined fine and held 30s — the pass/fail delta between the two
  probes isolated the trigger to join-vs-handshake timing.

## Hypotheses
1. quick_join dropped while the socket is CONNECTING (no send queue).
2. Server never answers quick_join (lobby bug).
3. Stale-resume path broken independently of the fresh-join path.

## 5 Whys
1. Why stuck JOINING? No `joined`/`error` ever arrives after joinQuick.
2. Why no reply? `quick_join` never reaches the server (ws-frame log shows
   ping + list_rooms only).
3. Why never sent? `Connection.send()` returned silently when
   `readyState !== OPEN` — no queue.
4. Why was the socket not open? `menus.showMain()` fires `listRooms()` at
   boot, creating `this.conn` with `connect()` in flight; `ensureConn()`
   returns the existing Connection WITHOUT awaiting the handshake, so a
   fast join fires into a CONNECTING socket.
5. Why did auto-rejoin also hang? Same race: the boot microtask
   `tryAutoRejoin()` runs after `showMain()`'s in-flight connect, so
   `join_public` was dropped too — no `error` arrived to trigger the
   (correct) session-clear + show-main fallback.

## Falsification
- H2 falsified: raw-ws probes got clean quick_join/joined/resume; arc probe
  (open socket) joined fine — the server answers whenever the frame arrives.
- H3 falsified: after the fix, path B falls back to the main menu with the
  session cleared — the error path was correct all along, it just never got
  its `error` frame.

## Root Cause
Single root cause for BOTH symptoms: client-side send-during-handshake race
(`games/fps/client/src/net/connection.ts` `send()` + `clientGame.ts`
`ensureConn()`). Wider handshake window on slow networks explains why a
phone user hit it reliably while a delayed probe passed.

## Fix
`Connection.send()` now queues non-input frames while CONNECTING and flushes
them FIFO in `onopen` (after the seed ping). `input` is still dropped while
connecting (60Hz ephemeral — the next post-open frame is fresher). The queue
is discarded on connect failure, explicit close, and unexpected close so
frames never send late on a dead socket. Regression test:
`games/fps/client/src/net/connection.test.ts` (5 cases) +
`vitest.config.ts` include for `games/fps/client/src/net/**`.

## Resolution
- Focused test failed before (queued frames vanished), 5/5 green after;
  full fps-client suite 98/98; `@fps/client` typecheck clean.
- Rebuilt `@fps/client`, `flyctl deploy` green.
- Prod repro now 3/3: A joins (`roomId` set, players=1, overlay hidden);
  B clears the dead session and returns to the main menu.
- FOLLOW-UP (2026-09-30): all game clients HAVE now been audited — see
  `docs/research/2026-09-30-send-queue-race-audit.md`. Rift/bank/wordbomb/kart/
  splat + the SDK carried the same race and are fixed (bridging queue); outpost
  already had it; aces safe by construction; ancients inherits rift's fix.
  Prod smoke 9/9 joined.

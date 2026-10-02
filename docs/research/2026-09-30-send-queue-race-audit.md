---
type: research
topic: "Audit: which game clients drop sends on an unhealthy socket (send-while-CONNECTING / reconnect-gap race)?"
slug: send-queue-race-audit
date: 2026-09-30T14:45:00-0300
researcher: Foad Kesheh
git_commit: 72497e03a28a109536014cb120fbf35548640551
branch: assets-trees-v2
repository: fps
status: complete
tags: [research, audit, netcode, websocket, send-queue, join-race]
last_updated: 2026-09-30
last_updated_by: Foad Kesheh
last_updated_note: ""
references:
  - path: games/fps/client/src/net/connection.ts
    sha: 85c792e319c09ffc5eb736908700b5df95f3bd95
    lines: "119-145"
    note: "Fixed first: CONNECTING queue, input drop, flush on open"
  - path: games/rift/client/src/net.ts
    sha: 27763b5751cccd65a187943f484f73229d5a8ff4
    lines: "551-665"
    note: "Fixed: bounded queue bridges CONNECTING + null-gap redials"
  - path: games/bank/client/src/game.ts
    sha: 67fd1dc3f7b0d7df1984e4c923dae716b84d9f18
    lines: "664-700"
    note: "Fixed: same bridging queue in send()/connect()/onclose"
  - path: games/wordbomb/client/src/game.ts
    sha: 31c9409fc8a3c0bb334c81fa87a1937f20675ecb
    lines: "829-865"
    note: "Fixed: same bridging queue"
  - path: games/kart/client/src/app.ts
    sha: 89114dd5bff4a24908a43f5058edd1df15fc11b4
    lines: "1367-1403"
    note: "Fixed: same bridging queue"
  - path: games/splat/client/src/app.ts
    sha: 7f10531ee9fdeffcfaf39b01ebb11e157d06580c
    lines: "966-1002"
    note: "Fixed: same bridging queue"
  - path: games/outpost/client/src/net.ts
    sha: e3e17439854110d66bed37416c2aabbfa84f8066
    lines: "622-635"
    note: "Already clean: the bounded-queue reference implementation"
  - path: games/aces/client/src/net.ts
    sha: a99fd06e4ada9e02fb9f5ca2f3b822dfdea3235f
    lines: "569-575"
    note: "Safe by construction: join envelope sent inside onopen"
  - path: games/ancients/client/src/main.ts
    sha: bdf86ad36ea5ac703fb509bee96db6a9d97b4e9e
    lines: "53-81"
    note: "Reuses rift core via wire(); inherits the rift fix"
  - path: platform/sdk/src/net.ts
    sha: d1574bcd7b78df2616e17e4354faeef378378bb1
    lines: "122-160"
    note: "Fixed: bridging queue + stored redial url (autoReconnect was dead)"
  - path: platform/server/src/index.ts
    sha: f25c01c27269b176c9c2aa0450afe4c940dfda4a
    lines: "43-75"
    note: "PLATFORM_STATIC hatch: force static mounts for local e2e"
related:
  - docs/investigations/2026-09-29-fps-join-reconnecting.md
  - docs/investigations/2026-09-30-rift-e2e-b-join-never-seats.md
---

# Research: send-queue race audit across all games

## Research Question
Which game clients drop outbound frames when the socket is not healthy-open (CONNECTING handshake or reconnect-backoff null gap), and what is the blast radius of the STRICKEN join race?

## Summary
The STRICKEN race — `send()` silently dropping frames unless the socket is OPEN — existed in 7 of 9 clients. Five game clients (rift, bank, wordbomb, kart, splat) plus the platform SDK carried it and are now fixed with a bounded bridging queue (outpost's pre-existing shape); fps was fixed first with an equivalent queue; outpost already had it; aces is safe by construction (join sent inside `onopen`); ancients inherits the rift fix. The audit also found the SDK's `autoReconnect` never redialled (`this.url` never assigned) and fixed that. All joins verified via unit regression tests plus per-game e2e suites and a prod smoke probe.

## Detailed Findings

### Fixed: rift, bank, wordbomb, kart, splat (bridging queue)
- Each had `if (ws === null || ws.readyState !== OPEN) return` with no queue (`games/rift/client/src/net.ts`, `games/bank/client/src/game.ts:664`, `games/wordbomb/client/src/game.ts:829`, `games/kart/client/src/app.ts:1367`, `games/splat/client/src/app.ts:966`).
- Each auto-redials unconditionally on close and never closes the socket on explicit leave — so every null gap ends in a redial and gap-bridging is leak-free by construction.
- Fix shape (mirrors outpost): bounded queue (cap 32, oldest shed), queued while CONNECTING or null, flushed FIFO on open, never cleared on close.
- Auto-rejoin paths in all five were welcome-gated (safe); only explicit menu joins raced — which is why the bug surfaced as "click does nothing" rather than a stuck overlay.

### Fixed first: fps (STRICKEN)
- `games/fps/client/src/net/connection.ts:119` — CONNECTING queue with per-frame `input` dropped rather than queued (60Hz ephemeral); queue discarded on failure/close. No null-gap bridging: fps has no auto-redial — its rejoin flow re-sends the join on the new connection, so gaps cannot strand intent.
- Root cause of the user-visible JOINING/Reconnecting hang: `ensureConn()` returns the boot-time in-flight connection without awaiting the handshake.

### Already clean: outpost (reference implementation)
- `games/outpost/client/src/net.ts:622-635` already queued (bounded, cap 32) while CONNECTING and flushed on open. Left unchanged: it does not auto-redial, so a null-gap queue could never flush.

### Safe by construction: aces
- `games/aces/client/src/net.ts:569-575` sends the join envelope inside `s.onopen`; every reconnect re-sends it there. No pre-open send path exists. Left unchanged.

### Inherits fix: ancients
- `games/ancients/client/src/main.ts:53-81` reuses the rift core via `wire()` (plus an `onOpenExtra` auth payload, sent post-open by construction). Covered by the rift fix + rift e2e.

### Fixed: platform SDK (migration target)
- `platform/sdk/src/net.ts` had the same drop pattern with zero game consumers yet — fixed pre-emptively with the bridging queue so the first migrated game does not inherit the race.
- Incidental find: `autoReconnect` NEVER redialled — `this.url` was read as the redial target but never assigned. `connect()` now stores it.

### Test/observation notes
- New regression tests: `games/fps/client/src/net/connection.test.ts`, `games/rift/client/src/net.test.ts`, `platform/sdk/src/net.test.ts` (15 tests total). Bank/wordbomb/kart/splat `send()` is private inside DOM-bound app classes — disproportionate to unit-test; verified via their committed e2e suites instead.
- `PLATFORM_STATIC=1` (`platform/server/src/index.ts:43`) forces static mounts for local e2e: foreign processes squat on this sandbox's vite dev ports and would otherwise hijack mounts into proxies of the wrong server. Inert in production (no vite runs there).

## Code References
- `games/fps/client/src/net/connection.ts:119-145` — fps queue + flush + input drop
- `games/rift/client/src/net.ts:551-665` — rift bridging queue (closure)
- `platform/sdk/src/net.ts:122-160` — SDK bridging queue + redial-url store
- `games/outpost/client/src/net.ts:622-635` — reference bounded queue
- `games/aces/client/src/net.ts:569-575` — join-in-onopen (safe pattern)

## Architecture Insights
- "No-op unless OPEN" was the shared template copied across every client and the SDK. It treats every non-open state as "caller retries", but no caller retries an explicit user join — auto-reseat only covers seated sessions with tokens. The fix moves the resumption story into the transport: hold user intent across any gap that ends in a redial.
- Two safe shapes exist: queue-and-flush (fps/outpost/rift/bank/wordbomb/kart/splat/SDK) and join-in-onopen (aces). Both are now covered by tests or e2e.

## Related Docs
- `docs/investigations/2026-09-29-fps-join-reconnecting.md` — the original STRICKEN hang
- `docs/investigations/2026-09-30-rift-e2e-b-join-never-seats.md` — the null-gap variant (e2e-rift check 4)

## Open Questions
- None for the join path. Pre-existing/environmental e2e reds outside the audit's scope: rift snap-lag check (needs a quieter box), kart `players=2` suite-timing race, splat 800m wall-cap, outpost repair/drawcalls — all on unchanged-or-exonerated code paths.

# UX BIBLE — STRICKEN

## Information hierarchy (always-visible glanceables, in priority order)
1. Crosshair (center; gap grows with bloom; hidden while scoped → scope overlay)
2. HP (bottom-left, big number + bar; red pulse < 30)
3. Ammo mag/reserve (bottom-right, big; red when mag empty; "RELOAD" hint when mag 0)
4. Round timer + phase (top-center; "BUY" tag while canBuy; score T:CT flanking it)
5. Money (bottom, above ammo; green flash on gain)
6. Killfeed (top-right, ≤5 entries, 5s fade)
7. Room chip (top-left: room name + private code to share)

## States (every one must exist and look intentional)
- Main menu: name field, big Quick Join, Create Private (map picker grid w/ 6 map names),
  Join by Code (5-char input), public room list (map, players, phase) with refresh. Error line
  (bad code / full / disconnected) in danger red.
- Loading/joining: dim overlay "Joining…" (under 300ms typical, must still exist)
- Freeze: center banner "ROUND N — BUY (B)"; buy menu toggled with B, auto-opened at freeze start
- Live: timer counts; buy menu auto-hides when canBuy ends
- Dead in live round: "SPECTATING <name>" + dim vignette; camera follows spectateTarget
- RoundEnd: banner "T/CT WINS THE ROUND" + score
- MatchEnd: fullscreen "VICTORY/DEFEAT", final score, top-3 players by kills, auto-return to
  warmup banner after 6s
- Disconnected: main menu + error text "Connection lost"
- Empty room list: "No public rooms yet — Quick Join creates one"

## Onboarding (first 60 seconds)
Menu shows controls card (WASD move · mouse look · LMB fire · R reload · B buy · Tab score ·
1-6/wheel weapons). First join lands in warmup (zero stakes, free respawn) — banner:
"Warmup — match starts when 2+ players". First freeze: buy menu auto-opens.

## Feedback latency budget
Click menu button → visible response < 100ms. Fire → viewmodel kick + sound instant (predicted);
hitmarker on server confirm (< RTT + 50ms). Damage taken → directional arc + red edge flash < 1 frame.
Death → killcam-ish snap to spectate within 300ms.

## Input modes
Mouse+keyboard only (pointer lock). Sensitivity 0.0022 rad/px (×0.4 scoped). Esc unlocks and opens
menu; clicking Resume re-locks. Tab held = scoreboard. Wheel cycles owned weapons.

## Readability & accessibility
HUD text ≥ 12px at 1080p, hudText #e8e6df on ink #14171c (contrast ≥ 7:1); accent hudAccent.
Team identity never color-only: scoreboard shows "T"/"CT" labels, nameplates show names,
killfeed shows names. Hit feedback is visual (hitmarker) + audio (tick/ding). No flashing > 3Hz.
Layout safe at 16:9 and 21:9, scales down to 1280×720 without overlap.

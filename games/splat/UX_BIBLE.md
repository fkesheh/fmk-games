# SKI SPLAT — UX BIBLE (frozen)

Comprehension and control, not mood (that's STYLE_BIBLE). Target devices:
iPad-class tablet with two thumbs (primary), desktop with ←/→ or A/D.

## Information hierarchy (in-race, first person)

Always glanceable, in this order:
1. **The world itself** — plants, fall line, finish. The HUD must never fight it.
2. **Place chip** (top-left, large): `2nd` style ordinal in your colour + crown
   when leading. Updates the instant places change.
3. **Progress rail** (right edge, vertical): the whole mountain as a thin rail,
   start at top, finish line at bottom; one dot per player in player colours,
   you slightly larger with a white rim. This is "who's winning" without a
   number (SPLAT D2 spirit).
4. **Speed chip** (bottom-left, small): km/h numeral + a thin bar. Reference
   data, not a focus.
5. **Plant-hit feedback is IN THE WORLD**, not the HUD: dip-spring, vignette
   flash, rustle SFX, powder puff. No text, no icon.

## Readability budget

- HUD numerals ≥ 28 px at 1080p for place, ≥ 18 px for speed; progress-rail
  dots ≥ 10 px diameter. Contrast ≥ 4.5:1 against snow — every chip sits on a
  scrim wash (the kart `.hud-scrim` pattern).
- Meaning is never encoded in colour alone: place chip shows the ordinal text;
  rail dots are positional (vertical order = race order), colour is redundant.

## Feedback latency budget

- Input → visible carve roll/ski angle: same frame (predicted, local).
- Plant contact → full feedback (dip + flash + SFX + spray): same frame for
  your own hits (predicted), ≤ 150 ms for remote events.
- Finish crossing → banner + fanfare: ≤ 150 ms.

## Input

- **Exactly two controls.** Tablet: left half of screen = steer left, right
  half = steer right (hold). Both held or neither = straight. Desktop: ←/→ or
  A/D. The kart `TouchPointers` discipline is law: Pointer Events keyed by
  `pointerId`, `pointercancel` releases, blur clears, sliding between zones
  retargets. Multi-touch cases (both down / lift one / slide across / cancel)
  are unit-tested.
- Tablet mode: auto-detected from `(hover: none) and (pointer: coarse)` OR the
  first real touch pointerdown; also manually toggleable in settings. Never UA
  sniffing. Touch UI is invisible to keyboard players.
- Steering is analog on keyboard (held = full lock after ramp) and digital on
  touch (zone = ramped full lock); assist mode smooths both.

## States (all must exist and be reachable)

- **Boot/loading** (palette-coloured splash, no flash of unstyled content).
- **Menu/lobby:** create/join room, room code display, player list with
  colours + glyphs, settings (tablet controls, left-handed, assist), START
  enabled at ≥ 2 players with the count visible (`1/2` etc.).
- **Countdown:** big 3-2-1-GO numerals, no words needed beyond GO!.
- **Racing:** HUD above. **Finished-but-race-running:** you crossed; camera
  keeps moving (auto-runout), banner "Finished — 42.3s", others still racing.
- **Results:** finish order as proportional time bars with colours + glyphs,
  crown on the winner, everyone's time shown. No "loser", no zero-bar shame:
  unfinished players show as "on the mountain" with distance covered.
- **Error/disconnect:** readable banner + rejoin path; offline PWA launch fails
  legibly, never a blank canvas.

## First 60 seconds (onboarding)

Menu → one tap QUICK PLAY → lobby → START (any player). First race shows a
single translucent hint for the first 3 s: two thumb outlines at the screen
edges, "hold a side to steer" — dismissible by any input, never shown again
(localStorage). No tutorial, no text walls.

## Accessibility

- Player identity = colour + animal glyph + position. Scores never colour-only.
- Assist mode: toggleable any time, invisible to others (it's a kindness, not
  a badge). Safe-area insets respected everywhere; no control under notch or
  home indicator. Wake Lock while racing. `touch-action: none` on all control
  surfaces; no double-tap zoom, no pull-to-refresh, no rubber-band.

## The bar (UX-director judge, Phase 4)

A first-time player on an iPad, given no instructions, must be racing within
3 taps, understand they steer by holding a side, feel a plant hit as "ouch,
avoid those", and read the results screen without help.

## §V2 — Jumps (frozen v2 amendment)

- **Third control (additive):** JUMP. Desktop: Space or ↑ (a press = ONE hop
  edge; holding never repeats — the cooldown owns cadence). Tablet: a round
  JUMP chip, bottom-right above the touch zones, ≥ 64 px target, sunGold ring
  + arrow glyph (affordance without text). Pressing it lifts ONE thumb off
  steering — the zones are big and the hop is a dodge, so that is acceptable;
  the chip must never sit under a resting thumb or inside either zone.
- **Readability:** the chip is labelled by glyph, not colour (colour is never
  the only encoding); a first-run hint line is added to the existing 3 s
  steer hint: "SPACE / JUMP = hop — ramps send you flying!" (once per
  localStorage, dismissible by any input).
- **Feedback:** jump press → whoosh + launch spray + camera lift same frame
  (predicted, local); landing → dip + thump + land burst same frame; remote
  jumps ≤ 150 ms via the snap's airborne flag. Nothing about jumping is ever
  a penalty state — no wobble, no shame.
- **Cooldown-denied (gauntlet):** pressing JUMP while the 1.8 s cooldown
  holds must still get an answer — a quiet denied thud (a low filtered
  version of the land thud at ~0.5 gain) + the chip pulses once (150 ms
  scale-down tween). A 4-year-old who presses twice sees the button answer,
  never silence.
- **Assist mode:** jump works identically; assist never auto-jumps (the
  player's own hands).

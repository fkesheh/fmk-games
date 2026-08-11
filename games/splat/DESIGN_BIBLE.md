# SKI SPLAT — DESIGN BIBLE (frozen)

First-person downhill ski racing for the family. 2–8 players, one slope, one
descent, first across the finish line wins. A 4-year-old holds one thumb and
still reaches the bottom; an adult threads the plants and wins on routing.

This document states design INTENT. Balance numbers live in
`games/splat/shared/src/config.ts` and are checkable against the targets here.

## Pillars

1. **Two inputs, ever — plus a JUMP (v2).** Left and right are the steering
   verbs; gravity is the throttle; steering IS the speed control. The v2 JUMP
   button (Space/↑ or the JUMP chip) is a tactical hop — never a trick, never
   a stun, always a safe landing. (v1 said "no jump"; v2 adds it as a dodge
   that clears plants only while airborne.)
2. **Plants are the whole opponent.** The slope is planted with saplings,
   bushes and thorn thickets. Touching one slows you — never stops you, never
   crashes you. The race is won by the cleanest line through the green.
3. **Nobody fails.** There is no wipeout, no elimination, no stuck state. Worst
   case you arrive last, a few seconds behind, having seen the whole mountain.
4. **First person is the fantasy.** You are on skis: speed in your face, snow
   spray on the carve, a whoosh when a plant whips past your shoulder.

## Core loop (a 5-minute session)

Lobby (room code, 2–8 players) → countdown 3-2-1 → **the descent** (30–60 s) →
results (finish order + times, 8 s) → lobby. One run per round. Rematch is one
tap on START.

Player verbs in one round: steer (the only verb), dodge plants, carve to dump
speed before a dense patch, tuck straight down the fall line on open snow,
glance at the progress rail to see who's ahead. Every verb resolves to contract
systems: steer → input/sim; dodge → plant contact + snare; carve → edge scrub;
progress → place computation + HUD rail.

## The decision each minute

The only decision is the LINE. Straight down is fastest but densest with
plants; traversing is slower per second but cleaner. Plant clusters force
micro-choices every 1–2 seconds: commit left, commit right, or thread the gap.
The adult's depth is reading density two turns ahead; the child's experience is
identical minus the reading — both are playing the same game.

## Intended difficulty curve / session shape

- Plant density ramps with altitude: sparse at the start gate (learning zone,
  first ~15% of the run), full density through the middle, then a **clear
  finish corridor** (last 40 m) so the sprint to the line is decided by speed,
  not by a lucky plant at the tape.
- Slopes are procedurally generated per match from a seed (server-picked).
  Seed variety = replayability; no hand-authored maps in v1.
- A round lasts under a minute of actual play. A bad round is over quickly
  (SPLAT D5 spirit) — rematch immediately.

## Balance targets (config numbers are checkable against these)

- **Run duration:** median descent 35–55 s at 8 players (steeper v2 tuning:
  ~15° base grade, terminal ≈ 22.6 m/s, clean run ≈ 40 s). Hard cap: results
  45 s after the first finisher, or 150 s total.
- **Slalom gates:** ~15 per run, ~50 m apart. Each pass grants +2.5 m/s and a
  2.5 s raised cap — threading every gate saves roughly 3–5 s over a clean
  gateless run. Missing a gate costs NOTHING (the no-fail law): gates are
  pure upside, the adult's threading game layered on the plant-dodging.
- **Plant cost:** one plant touch costs ~0.7–1.2 s of race time (speed scrub +
  snare window). Three clean seconds beats three plants every time.
- **Density:** at full density a straight fall-line run hits 3–6 plants;
  a weaving line can hit zero. Dodging must always be *possible*: the slope
  generator guarantees a plant-free corridor of width ≥ 3 m through every
  altitude band (validated by test).
- **Never stuck:** minimum speed on any legal gradient > 0; soft edges curve a
  full-lock skier back inside; a player holding ONE steering direction for the
  whole descent reaches the finish, on both directions, on 20 random seeds
  (the 4-year-old, expressed as a test).
- **Catch-up:** none. No rubber-banding — the race is short enough that a
  comeback mechanic would dwarf the skiing. Skill expression is the line.
- **Assist mode** (per player, invisible to others): input smoothing, plant hit
  radius ×0.8, snare duration ×0.75, edge pushback ×1.4. Never announced.

## Non-goals (v1/v2)

Teams, items, tricks, paint/territory, ghosts, leaderboards, persistence,
chat, bots. (Jumps ARE in — v2.) Multiplayer is humans in a room, 2–8.

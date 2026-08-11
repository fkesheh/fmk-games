# SPLAT V2 — P2v2 (shared slope): seeded kicker placement

You own EXACTLY: `games/splat/shared/src/slope.ts`,
`games/splat/shared/src/slope.test.ts`.

The contract text (CONTRACT.md §11.3) specifies the kicker placement laws.
`genSlope` currently returns `kickers: Object.freeze([])` — replace that with
the real seeded placement.

## The body

In `genSlope`, after the slalom-gate loop, lay `KICKER_COUNT` kickers along
the SAME woven corridor centreline the gates use (the `centres` array + the
band free-interval machinery are already in scope):

- `z = KICKER_Z0 + i*KICKER_SPACING + rngRange(±KICKER_Z_JITTER)`, clamped
  inside the planted zone (`[START_CLEAR, FINISH_Z - FINISH_CLEAR]`), and
  strictly ascending (clamp so each z > the previous).
- `x` = corridor centreline at that band (interpolate `centres` across the
  band exactly like the gate placement does) ± `rngRange(±KICKER_X_JITTER)`,
  then snapped to the nearest plant-free interval of the band (the same
  `gridFreeIntervals` snap the gates use) and clamped so the whole kicker
  stays on-piste: `|x| + halfWidth <= width/2 - 1`.
- `halfWidth = KICKER_HALF_WIDTH` for every kicker.
- Freeze the array (`Object.freeze`).

## validateSlope additions (§11.3)

Assert on every generated slope (and on synthetics that include kickers):
- strictly ascending z; none in `START_CLEAR` or `FINISH_CLEAR`;
- on-piste (`|x| + halfWidth <= width/2 - 1`);
- no plant within `KICKER_PLANT_CLEAR` of a kicker's (x, z);
- count within ±1 of `KICKER_COUNT`.

## Tests (extend slope.test.ts; keep everything else green)

- On 20 seeds: every placement law holds (`validateSlope(genSlope(seed))`
  returns `[]`);
- kickers are on the corridor centreline (within a band-interval tolerance);
- kickers are strictly ascending and clear of both clear zones;
- a corridor-following skier crosses every kicker (integrate stepSki along
  the centreline polyline and assert `lastKickerIx` advances — cross-import
  stepSki in tests, legal);
- the full-lock 4-year-old test still finishes with kickers present.

## Gate

`node node_modules/typescript/bin/tsc --noEmit -p games/splat/shared` clean +
`npx vitest run games/splat/shared/src/slope.test.ts` green. Report actual
output.

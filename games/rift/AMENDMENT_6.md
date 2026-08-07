# Contract amendment 6 — the client typecheck is not a gate

Authority level 2. This one is about process, and it invalidates an instruction I gave every
client render module.

---

## The finding

The R_FOG verifier ran **21 deliberate behavioural sabotages** against `fog.ts` — dropping the
`visNow` composite so the screen goes black, flipping the lid to single-sided so the occluder
vanishes, sharing one material between two sheets, re-deriving `nightVisionScale` locally,
removing each of four entry-point guards, zeroing the ghost radius, dropping
`whiteVertexColors`, putting the sheets back in the shadow pass.

`npx tsc --noEmit -p games/rift/client` reported **zero errors in `fog.ts` for all 21**.
Exit code carried no signal either: the workspace baseline is already EXIT 1 from other
modules' in-flight work.

**That is the gate I specified in `BUILD_SPECS.md` §0 for every client render module:** *"your
gate is: no error whose file path is one of the files you own."* It is 0-for-21 against
deliberate sabotage.

## Why this matters more than any single defect

It explains the shape of the whole render wave. Twelve modules self-reported green gates and
honest typecheck attributions, and every reviewer independently confirmed those attributions
were truthful — and the wave still contained **130 defects**, including a black screen, an
occluder culled from below, an opaque dome over every fight, decals units stood buried in, and
88 motes over unexplored terrain.

The implementers were not lying. They were reporting a measurement that measures nothing.

This is the same class as the two failures already in this build's memory: `rtk` printing
`PASS (0) FAIL (0)` with exit 0 on a hard failure, and `parallel()` resolving a dead agent to
`null` so downstream phases build on files that never existed. **A gate that reports success
while measuring nothing is worse than no gate**, because it converts "unverified" into
"verified" in every downstream report.

## Ruling

1. **A client render module gates on BEHAVIOUR, never on typecheck alone.** Typecheck stays as a
   necessary precondition; it is not sufficient and must not be reported as the gate.

2. **The behavioural harness pattern is established and reusable.** Drive the real module
   through a recording DOM/WebGL stub — the technique `minimap.test.ts` already uses, since this
   repo has no jsdom. The R_FOG harness (28 tests) is kept and must be landed into the repo, not
   left in a scratchpad.

3. **Every fix task reports a mutation matrix run against the BEHAVIOURAL gate.** A matrix run
   against the typecheck is not evidence. Any task whose matrix shows a suspiciously uniform
   result should be suspected of gating on the wrong thing.

4. **The client fix wave now in flight was dispatched under the old instruction.** Its mutation
   matrices are therefore only as good as whatever gate each task chose for itself. **A
   behavioural verification pass over that wave is required before any module is closed** — do
   not treat its green reports as verification.

5. Once R_UNITS and R_MAPMESH unbreak the build, `verify-rift.mjs` becomes the real integration
   gate and every number measured in isolation gets re-confirmed against an assembled frame
   (`AMENDMENT_5` §F).

## The credit where it belongs

The verifier found this by *not trusting the gate it was handed*. It also caught itself misreading
a constant and reported the misread rather than the false finding, reported a mutation that came
back green on the first pass before strengthening the probe, and corrected two of my own figures
with independent verification. That is the standard.

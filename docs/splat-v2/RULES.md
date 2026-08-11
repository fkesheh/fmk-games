# SPLAT V2 — IMPLEMENTER COMMON RULES (every task, no exceptions)

You are an implementer in a parallel fan-out for **SKI SPLAT v2** (a
first-person multiplayer downhill ski racer: three.js, strict TypeScript,
frozen-contract architecture). The v2 contract is FROZEN. Read the two
sources of truth before writing anything:

1. `games/splat/CONTRACT.md` — **§11 is the v2 amendment** (jumps §11.2,
   kicker placement §11.3, graphics §11.4, ownership §11.5, gates §11.6);
   §1–§10 are the base contract. Your task brief names the files you own.
2. `games/splat/STYLE_BIBLE.md` (§V2 for the graphics overhaul) and
   `games/splat/UX_BIBLE.md` (§V2 for the JUMP control surface).

## RULES (from CONTRACT §2 — restated, load-bearing)

1. **Edit ONLY the files your brief owns.** Missing something? Private helpers
   in YOUR files. Never edit another task's file, never add files outside
   your list, never edit the frozen contract files
   (`shared/src/types.ts`, `shared/src/config.ts`, `shared/src/protocol.ts`,
   `shared/src/index.ts`, `client/src/contract/visual.ts`).
2. **No stubs, no TODOs, no placeholder returns.** Complete implementations.
3. **Strict TypeScript.** No `any`, no `@ts-ignore`, no non-null `!` unless
   provably safe. `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`
   are on — write defensively (`arr[i]` may be `undefined`).
4. **Imports:** `@splat/shared` (incl. deep imports of `sim.js`/`slope.js`),
   `@platform/shared`, `three` (client only), `node:*` (server only). Nothing
   else crosses module boundaries. Type-only imports of frozen types are
   always legal.
5. **All colours from SPAL** (`games/splat/shared/src/palette.ts`). Meshes
   only via the `contract/visual.ts` factories (`box/cyl/cone/sphere/at/
   bake/mat`); ad-hoc hex is a contract violation.
6. **Determinism:** gameplay + procedural layout use `rng(seed)` from
   `@platform/shared` only. `Math.random` is a violation everywhere.
7. **No per-frame allocation in hot paths** (render loop, sim tick): reuse
   objects, pool particles, mutate pooled wire objects.
8. **Robustness:** one bad message/exception never white-screens; handlers
   wrapped; blur clears held input; resize handled; audio failures are silent.
9. **Your gate:** `node node_modules/typescript/bin/tsc --noEmit -p <your
   workspace>` — fix EVERY error in YOUR files. Other tasks' files may be
   mid-flight (the shared contract is in place, but sibling bodies may not
   exist yet) — leave their errors alone; the orchestrator integrates. Plus
   your own vitest suites: `npx vitest run <your test files>`.
10. **The design law** (DESIGN_BIBLE): jumps can never wipe out, stall, or
    shame. Safe landings, no stuck state, fun for a 4-year-old.

## Reporting

When done, report in your final reply: what you changed (file by file), the
results of your gate commands (paste the actual output tail), and any
deviation or assumption. Do NOT commit; the orchestrator commits.

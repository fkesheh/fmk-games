# SPLAT V2 — E2Ev2 (e2e): jump assertions + new screenshots

You own EXACTLY: `scripts/e2e-splat.mjs` (the whole file — no other task
touches it).

Run AFTER integration (the orchestrator tells you when the tree is green).
The frozen debug surface now includes `setJump()` (one-shot edge) and
`state().sim` exposes the v2 air fields (airborne, airStartMs, airVy,
airStartY, lastKickerIx). Existing assertions must stay green; ADD:

1. **Manual hop:** mid-race (in the fixed-seed room), A presses
   `setJump()` → within ~500 ms `state().sim.airborne` is true; within ~2.5 s
   it is false again (landed) and `v > 0` (never stopped). Assert both
   transitions with polling.
2. **Remote sees it:** B's view of A — B's interp buffer carries the
   airborne flag; assert B samples a `v.airborne === true` for A's id during
   A's hop (poll telemetry or the buffer via the debug surface — use the
   `telemetry().remotes` list which already carries per-remote pose; if it
   doesn't carry airborne, assert via a new telemetry field the C2 task adds
   OR skip with a comment — do NOT break the surface contract).
3. **Kicker flight:** with the fixed seed, steer A down the corridor
   centreline so it crosses a kicker; assert `state().sim.lastKickerIx`
   advances past -1 AND a flight follows (`airborne` true with
   `airVy >= J_KICKER_VY_BASE` — you can import the constant or just assert
   `airVy > J_HOP_VY`-ish). If steering precision makes this flaky, assert
   the kicker exists in `telemetry().seed`'s slope instead (regenerate the
   slope in-page and read `kickers.length > 0`) plus one manual-hop flight —
   report honestly.
4. **New screenshots** (CONTRACT §9.6 + §11.6): `splat-jump-air.png`
   (first-person mid-arc — capture when `state().sim.airborne` is true),
   `splat-kicker.png` (a kicker ramp fills the frame — steer near the
   corridor, or capture the ramp from a standstill beside it),
   `splat-landing.png` (the landing burst visible — capture within ~0.3 s
   of airborne flipping false). Keep the existing five. Add the three new
   names to the non-trivial-size evidence list (keep the >30 KB rule).
5. **Draw calls:** keep the `< 80` assertion; the new visuals (clouds, sun
   disc, kickers, foothills) must not break it — report the max sampled.
6. **Snapshot size:** the room test owns the ≤ 2 KB assert; the e2e just
   keeps working.

Your gate: `node scripts/e2e-splat.mjs` green end-to-end. Report actual
output tail + the max sampled drawCalls.

# SPLAT V2 — V1v2 (server room): jump passthrough + snap.airborne

You own EXACTLY: `games/splat/server/src/room.ts`,
`games/splat/server/src/room.test.ts`.

Read CONTRACT.md §11 (jumps) and the existing room.ts — the room already
implements the v1 contract perfectly (kart discipline, pooled wire, plant/
gate diff events). v2 is a small, surgical change:

1. **`tickPlayer`:** pass the jump edge to the sim —
   `stepSki(p.sim, inp.steer, inp.dt, slope, { assist: p.assist, jump:
   inp.jump === true })`. Nothing else changes in the integration path.
2. **`buildSnapPlayers`:** copy `s.airborne = k.airborne` into the pooled
   snap (add the field to the `SkierSnapWire` twin interface).
3. **`resolveContacts`:** the pair loop calls `resolveSkiPair(a.sim, b.sim)`;
   the air-contact skip lives in `resolveSkiPair` itself (P1v2's sim.ts) —
   no room change needed there. Double-check the room does NOT need one (it
   doesn't — the sim owns it).
4. **Room tests** (extend room.test.ts): a fake RoomIO flow where a player's
   input carries `jump: true` once → the snapshot's `you.sim.airborne`
   becomes true and later false; the snapshot still encodes; the snapshot
   size budget still holds at 8 players (the existing ≤2 KB JSON.stringify
   assert must keep passing with `airborne` on every snap and one `jump`
   edge on the wire — if it busts, report the number honestly).

Your gate: `node node_modules/typescript/bin/tsc --noEmit -p
games/splat/server` clean + `npx vitest run games/splat/server/src/room.test.ts`
green. Report actual output.

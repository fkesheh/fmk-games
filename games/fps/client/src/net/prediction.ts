// ============================================================================
// C1 — Predictor: client-side prediction for the local player.
// pushInput steps the shared stepBody(TICK_DT) — the exact server code path —
// and queues the input; reconcile() re-bases on the authoritative state
// (INCLUDING vy from YouSnap.vy so gravity replays correctly mid-jump), drops
// acked inputs, and replays everything the server hasn't confirmed. Corrected
// state is always applied directly — the >1m snap/blend distinction is a
// rendering concern for the caller (C10); this class exposes nothing extra.
// ============================================================================
import { PLAYER, TICK_DT, makeBody, stepBody } from '@fps/shared';
import type { AABB, BodyState, MoveInput } from '@fps/shared';

// ---- tuning (frozen by C1 spec) ----------------------------------------------
const PENDING_CAP = 120; // ~4s of inputs at 30Hz; oldest dropped beyond this

export interface PendingInput {
  seq: number;
  input: MoveInput;
}

export class Predictor {
  private readonly b: BodyState = makeBody(0, 0, 0);
  private readonly pending: PendingInput[] = []; // seq-ordered ascending

  constructor(private readonly solids: AABB[]) {}

  /** Re-base at a spawn/teleport. Mutates the live body — held body() refs stay valid. */
  reset(x: number, y: number, z: number): void {
    const b = this.b;
    b.x = x;
    b.y = y;
    b.z = z;
    b.vx = 0;
    b.vy = 0;
    b.vz = 0;
    b.height = PLAYER.heightStand;
    b.onGround = true;
    this.pending.length = 0;
  }

  /** Apply one local input immediately and queue it for later replay. */
  pushInput(p: PendingInput, speedMul: number): void {
    if (this.pending.length >= PENDING_CAP) this.pending.shift(); // drop oldest
    this.pending.push(p); // reference retained — caller must not mutate
    stepBody(this.b, p.input, speedMul, TICK_DT, this.solids);
  }

  /**
   * Authoritative correction: adopt server state, then replay unacked inputs.
   * onGround is derived from vy plus previous vertical motion: the server zeroes
   * vy exactly on land — but ALSO on a mid-air head-bonk without setting
   * onGround — so vy === 0 alone is not proof of grounded. Treat vy === 0 as
   * grounded only when the body was already falling/grounded (prevVy <= 0 or
   * prevOnGround); a bonk arrives with prevVy > 0 (still rising) and stays
   * airborne.
   */
  reconcile(
    x: number,
    y: number,
    z: number,
    height: number,
    vy: number,
    ackSeq: number,
    speedMul: number,
  ): void {
    const b = this.b;
    const prevVy = b.vy;
    const prevOnGround = b.onGround;
    b.x = x;
    b.y = y;
    b.z = z;
    b.vx = 0; // stepBody re-derives horizontal velocity from each replayed input
    b.vz = 0;
    b.vy = vy;
    b.height = height;
    b.onGround = vy === 0 && (prevVy <= 0 || prevOnGround);
    // drop inputs the server has consumed (queue is seq-ordered)
    let acked = 0;
    while (acked < this.pending.length) {
      const p = this.pending[acked];
      if (p === undefined || p.seq > ackSeq) break;
      acked++;
    }
    if (acked > 0) {
      this.pending.copyWithin(0, acked); // shift without allocating
      this.pending.length -= acked;
    }
    // replay everything the server hasn't confirmed yet
    for (const p of this.pending) stepBody(b, p.input, speedMul, TICK_DT, this.solids);
  }

  /** Live reference, read-only by convention. */
  body(): BodyState {
    return this.b;
  }
}

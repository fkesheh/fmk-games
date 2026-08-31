// ============================================================================
// ACES — C_NET (prediction.ts). Local simulation of the OWN plane.
//
// The predictor is a Quake-style client-side mirror of the authoritative
// server sim: it applies the app's latest input through the SHARED stepPlane
// (games/aces/shared/src/physics.ts — the same function the server runs, at
// the same fixed 1/60 substep, so divergence can only come from inputs, never
// from physics), and every snapshot reconciles it against the `you` row:
//
//   · position error > NET.RECONCILE_SNAP_U  → hard snap to the server row
//     (teleport-class correction: respawn, warp debug verb, long stall);
//   · otherwise                              → blend the residual error down
//     by NET.RECONCILE_BLEND per reconcile (per-frame ease — no visible jump),
//   · then REPLAY every pending input the server has NOT acked yet
//     (seq > you.seq; SnapPlane.seq echoes the last applied input seq) so the
//     predicted trajectory continues from corrected truth instead of losing
//     the inputs that were already shown to the player.
//
// AUTHORITY LAW (task BEHAVIOR LAW + CONTRACT §5): hp / heat / jammed /
// boost / dead (+ invulnT, streak, throttle echo, maxHp, class, identity)
// are SERVER-authoritative and copied verbatim from the row on every
// reconcile; only MOVEMENT (x/y/h/vx/vy) goes through snap-or-blend+replay.
// Between reconciles the local sim advances boost/heat so HUD bars move at
// frame rate; the next snapshot overwrites them with truth (HUD interpolates,
// RULES 10).
//
// DEATH FREEZE: while state.dead the predictor does not integrate at all —
// the wreck's motion, respawn timer and rebirth position are entirely the
// server's business (stepPlane would only tick timers we must not own).
//
// ALLOCATION LAW (RULES 4): advance() runs up to ~15 substeps/frame with zero
// allocations (accumulator + scalar loop); reconcile touches scalars and the
// preallocated pending queue only. Input frames are stored BY REFERENCE —
// InputFrame is readonly, so sharing the app's object is safe and free.
// ============================================================================

import {
  BOOST_MAX,
  CLASSES,
  NET,
  TICK_RATE,
  WORLD,
} from '@aces/shared/config.js';
import type { PlaneClassId } from '@aces/shared/config.js';
import { angleDelta, stepPlane, wrapAngle } from '@aces/shared/physics.js';
import type { InputFrame, PlaneState } from '@aces/shared/types.js';
import type { SnapPlane } from '@aces/shared/protocol.js';

/** Fixed integration substep — the spec pins prediction to 1/60 s substeps
 *  regardless of display refresh; advance(dt) accumulates real dt and drains
 *  it in whole steps so the trajectory is framerate-independent. */
const STEP_S = 1 / 60;

/** Substeps one input slot spans during replay: inputs arrive/send at
 *  TICK_RATE (30 Hz), the sim steps at 1/60 → each queued frame covers
 *  round(1/(30·1/60)) = 2 substeps. Derived, never hardcoded. */
const REPLAY_SUBSTEPS = Math.round(1 / (TICK_RATE * STEP_S));

/** Spiral-of-death guard: after a tab stall, clamp how much backlog one
 *  advance() call may drain (a quarter second) rather than freezing the tab
 *  catching up. Excess time is dropped — snapshots re-anchor truth anyway. */
const MAX_ADVANCE_S = 0.25;

/** Pending-queue cap ≈ 8 s of 30 Hz inputs. Purely a memory bound for the
 *  pathological case where the server stops acking (disconnect while alive):
 *  replay cost stays O(queue) per snapshot, so it must not grow unbounded.
 *  Dropping the OLDEST entries degrades reconciliation gracefully — recent
 *  intent survives. */
const MAX_PENDING = 240;

/** Input held before the first onLocalInput (and conceptually between
 *  queued frames): protocol-neutral zeros — glide at min throttle, no turn,
 *  no fire. Not a tunable; the absence of intent. */
const NEUTRAL_INPUT: InputFrame = { seq: 0, th: 0, tr: 0, fire: false, boost: false };

export class OwnPredictor {
  /** Live own-plane state, mutated IN PLACE — the reference the app/render
   *  hold stays valid across resets and class swaps. Identity fields
   *  (id/name/team) are placeholders until the first reconcile copies them
   *  off the server's you-row, which is their only authority. */
  readonly state: PlaneState;

  /** Latest seq-stamped input from the app; applied by every substep until
   *  superseded (held-keys model, matching the server's "latest input wins
   *  per tick" rule in room.ts). */
  private current: InputFrame | undefined;

  /** Unacked inputs, ascending seq, for replay after reconcile. */
  private readonly pending: InputFrame[] = [];

  /** Leftover real time below one substep, carried into the next advance(). */
  private acc = 0;

  constructor(cls: PlaneClassId) {
    this.state = {
      id: '',
      name: '',
      team: 'royal', // placeholder until the first you-row corrects it
      cls,
      bot: false,

      // Map-center guess: deliberately mid-world so the first reconcile's
      // error is large but finite — it snaps to the true spawn either way.
      x: WORLD.W / 2,
      y: WORLD.H / 2,
      vx: 0,
      vy: 0,
      h: 0,

      hp: CLASSES[cls].hp,
      heat: 0,
      jammed: false,
      boost: BOOST_MAX,
      boosting: false,
      throttle: 0,
      invulnT: 0,
      fireCd: 0,
      dead: false,
      respawnT: 0,
      streak: 0,
    };
    this.initMotion(cls);
  }

  /** Fresh-spawn motion: idle heading east at the class's floor speed — the
   *  no-stall arcade law means a plane always moves at ≥ speedMin. */
  private initMotion(cls: PlaneClassId): void {
    const spec = CLASSES[cls];
    this.state.h = 0;
    this.state.vx = spec.speedMin;
    this.state.vy = 0;
    this.acc = 0;
  }

  /** Swap airframe (respawn class pick). Combat resources reset to the new
   *  spec's fresh values — the server re-authors them at spawn anyway via
   *  reconcile; these locals just keep the pre-spawn frames honest. Pending
   *  inputs are cleared: they belonged to the old airframe's life. */
  setClass(cls: PlaneClassId): void {
    this.state.cls = cls;
    this.state.hp = CLASSES[cls].hp; // PlaneState carries no maxHp — SnapPlane does
    this.state.heat = 0;
    this.state.jammed = false;
    this.state.boost = BOOST_MAX;
    this.state.fireCd = 0;
    this.pending.length = 0;
    this.initMotion(cls);
  }

  /** Full fresh-life reset for the CURRENT class (app calls it on spawn).
   *  Position is intentionally preserved: the server places the respawn, and
   *  the first reconcile after spawn snaps any large error (SNAP path). */
  reset(): void {
    this.setClass(this.state.cls);
    this.current = undefined;
    this.state.dead = false;
    this.state.invulnT = 0;
    this.state.streak = 0;
    this.state.respawnT = 0;
  }

  /** App hands us one seq-stamped sampled input (30 Hz). Stored for replay
   *  AND adopted as the locally-applied intent ("applied locally" = governs
   *  subsequent advance() substeps; application itself is dt-driven, so it
   *  lives in advance, not here). Monotonic seq assumed — app increments. */
  onLocalInput(frame: InputFrame): void {
    this.current = frame;
    this.pending.push(frame);
    if (this.pending.length > MAX_PENDING) this.pending.shift();
  }

  /**
   * Integrate local time: drain `dt` in fixed 1/60 substeps through the
   * shared stepPlane using the currently-held input. Frozen while dead.
   */
  advance(dt: number): void {
    if (this.state.dead) {
      this.acc = 0; // no backlog across the death freeze
      return;
    }
    this.acc += dt < 0 ? 0 : dt > MAX_ADVANCE_S ? MAX_ADVANCE_S : dt;
    const input = this.current ?? NEUTRAL_INPUT;
    // Hot path (RULES 4): scalar loop only — no literals, no closures, no
    // array traffic; stepPlane mutates state in place.
    while (this.acc >= STEP_S) {
      stepPlane(this.state, input, STEP_S);
      this.acc -= STEP_S;
    }
  }

  /**
   * Reconcile against the snapshot's you-row. Undefined row = dead or
   * spectating (the wire omits `you` exactly then): freeze as dead, drop
   * pending — nothing before death replays onto the next life.
   */
  reconcile(you: SnapPlane | undefined): void {
    if (you === undefined) {
      this.state.dead = true;
      this.pending.length = 0;
      this.acc = 0;
      return;
    }

    const wasDead = this.state.dead;

    // ---- server-authoritative mirror (ALWAYS, both paths) ------------------
    this.state.id = you.id;
    this.state.name = you.name;
    this.state.team = you.team;
    this.state.bot = you.bot;
    this.state.cls = you.cls; // class switches ride snapshots too
    this.state.hp = you.hp;
    this.state.heat = you.heat;
    this.state.jammed = you.jammed;
    this.state.boost = you.boost;
    this.state.boosting = you.boosting;
    this.state.throttle = you.throttle;
    this.state.invulnT = you.invulnT;
    this.state.streak = you.streak;
    this.state.dead = you.dead;

    if (you.dead) {
      // Wreck: copy its (static) pose verbatim; no replay across death.
      this.copyMovement(you);
      this.pending.length = 0;
      this.acc = 0;
      return;
    }

    if (wasDead) {
      // Rebirth (or first-ever row): take the server pose wholesale and start
      // clean — pre-death pending was already cleared above.
      this.copyMovement(you);
      this.acc = 0;
      return;
    }

    // ---- movement: snap-or-blend, then replay unacked inputs ---------------
    const errX = this.state.x - you.x;
    const errY = this.state.y - you.y;
    if (errX * errX + errY * errY > NET.RECONCILE_SNAP_U * NET.RECONCILE_SNAP_U) {
      // Beyond threshold: teleport to truth (squared compare — no sqrt).
      this.copyMovement(you);
    } else {
      // Within threshold: ease the residual error down by BLEND per reconcile
      // call. Heading eases along the shortest arc so a wrap-boundary
      // correction spins the short way. Velocities stay as-predicted — replay
      // regenerates them from the eased pose.
      this.state.x -= errX * NET.RECONCILE_BLEND;
      this.state.y -= errY * NET.RECONCILE_BLEND;
      this.state.h = wrapAngle(this.state.h + angleDelta(this.state.h, you.h) * NET.RECONCILE_BLEND);
    }

    // Replay everything the server has not acked yet (seq > you.seq): from
    // corrected truth, re-run our recent intent so the visible plane keeps
    // exactly the trajectory the player already saw continue.
    while (this.pending.length > 0 && this.pending[0]!.seq <= you.seq) {
      this.pending.shift(); // acked: prune (ascending-seq invariant)
    }
    for (let i = 0; i < this.pending.length; i++) {
      const f = this.pending[i];
      if (f === undefined) break; // unreachable: i < length
      for (let s = 0; s < REPLAY_SUBSTEPS; s++) {
        if (this.state.dead) return; // replay walked into server-truth death: stop mid-replay
        stepPlane(this.state, f, STEP_S);
      }
    }
  }

  /** Movement-only copy (snap path / wreck pose / rebirth). */
  private copyMovement(you: SnapPlane): void {
    this.state.x = you.x;
    this.state.y = you.y;
    this.state.h = you.h;
    this.state.vx = you.vx;
    this.state.vy = you.vy;
  }
}

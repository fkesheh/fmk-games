// ============================================================================
// ANCIENTS (rift) — INPUT (T8). MOBA controls against the frozen SceneHandle
// seam only (CONTRACT §6):
//   camera   fixed-angle; pan via screen edge / ARROW KEYS / middle-drag;
//            wheel zoom (game clamps height to [18, 55])
//   RMB      move — attack instead when an ENEMY unit is under the cursor
//            (scene.pickUnit + team lookup); order marker shown immediately
//   A+LMB    attack-move to the cursor ground point (Esc cancels the arm)
//   S        stop
//   Q/W/E/R  quick-cast at the cursor: 'none' casts fire immediately, 'point'
//            casts aim at the cursor ground, 'unit' casts pick the unit under
//            the cursor; Ctrl+Q/W/E/R spends a skill point instead
//   1..6     item actives: warhorn (aura) fires immediately, blinkstone (dash)
//            and wardstone (ward) target the cursor ground point. Every use is
//            preflighted through hooks.itemBlockReason (cooldown / ward stock /
//            charges / range / dead) — a denied key toasts the reason instead
//            of dying in silence on the server's drop floor.
//   hover    an ENEMY unit under the cursor switches the canvas cursor to a
//            crosshair (attack affordance); the pickUnit raycast is throttled
//            to ~30Hz inside update(), never run per mousemove
//   TAB      scoreboard overlay while held
//   blur     clears every held key; resize reflows the scene
//
// Keyboard pan uses the ARROW keys, not WASD: the contract's §6 input bullet
// binds W to ability slot 2, A to attack-move and S to stop in the same
// breath as it says "WASD pan" — the four keys cannot do both, and the
// ability/order bindings are the load-bearing MOBA verbs. Flagged to the
// orchestrator.
//
// All gameplay input is gated on hooks.isLive() and ignored while focus is in
// a text field (the menu name input must not stop the hero).
// ============================================================================
import { heroById, ITEMS } from '@rift/shared';
import type { HeroId, ItemId, RiftC2S, TeamId } from '@rift/shared';
import type { SceneHandle } from './contract.js';

export interface InputHooks {
  send(msg: RiftC2S): void;
  isLive(): boolean;
  /** Own team, or null before rift_hello. */
  selfTeam(): TeamId | null;
  /** Team of an entity id from the latest snapshot, or null when unknown. */
  entTeam(id: number): TeamId | null;
  /** Own hero from the latest snapshot's YouSnap, or null. */
  ownHero(): HeroId | null;
  /** Own 6 inventory slots from the latest snapshot (empty before live). */
  ownItems(): readonly (ItemId | null)[];
  cameraHeight(): number;
  panBy(dx: number, dz: number): void;
  /** Multiply the camera height by `factor` (the game clamps to [18, 55]). */
  zoomBy(factor: number): void;
  setScoreboard(open: boolean): void;
  /** LMB selection: entity id under the cursor, -1 = none. */
  setSelected(id: number): void;
  /** Immediate client-side order marker (the <100ms feedback law). */
  orderMarker(x: number, z: number, attack: boolean): void;
  /** Client-side preflight against the latest snapshot (game.ts owns the
   *  data): null = the cast may be sent; otherwise a short player-facing
   *  reason the SERVER would have silently dropped it for (unskilled /
   *  cooldown / no mana / dead / out of range / invalid target). */
  castBlockReason(slot: number, aim: { x?: number; z?: number; target?: number }): string | null;
  /** Same preflight for ITEM actives (1-6): null = send; otherwise the reason
   *  the server would no-op (cooldown / no ward charges / 0 team ward stock /
   *  out of range / dead). */
  itemBlockReason(slot: number, aim: { x?: number; z?: number }): string | null;
  /** Show a transient cast-denied note (the silent-no-op bug fix). */
  castDenied(reason: string): void;
}

export interface InputHandle {
  /** Per-frame camera pan from held keys / screen edge. dtMs is clamped. */
  update(dtMs: number): void;
}

const EDGE_PX = 24; // screen-edge pan band
const PAN_SPEED_PER_HEIGHT = 0.9; // pan m/s = camera height * this
const DRAG_SCALE = 1.4; // middle-drag: world metres per pixel ≈ h * this / canvas px
const ZOOM_STEP = 1.12; // wheel multiplicative step

const ABILITY_SLOTS: Readonly<Record<string, number>> = {
  KeyQ: 0,
  KeyW: 1,
  KeyE: 2,
  KeyR: 3,
};

function typingTarget(): boolean {
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function createInput(root: HTMLElement, scene: SceneHandle, hooks: InputHooks): InputHandle {
  const held = new Set<string>();
  let mouseX = 0;
  let mouseY = 0;
  let pointerSeen = false; // no edge pan until the pointer has moved once
  let middleDrag = false;
  let lastDragX = 0;
  let lastDragY = 0;
  let attackMoveArmed = false;
  // enemy-hover attack affordance: pickUnit is a raycast, so it NEVER runs per
  // mousemove — update() re-picks at most ~30Hz from the last known cursor
  // (a panning camera moves the world under a still cursor too, so a
  // mousemove-only cache would go stale).
  let hoverPickMs = 0;
  let hoverEnemy = false;

  function setHoverCursor(enemy: boolean): void {
    if (enemy === hoverEnemy) return;
    hoverEnemy = enemy;
    scene.canvas.style.cursor = enemy ? 'crosshair' : '';
  }

  /** Cursor ground point, or null when the ray misses the ground plane. */
  function cursorGround(out: { x: number; z: number }): boolean {
    return scene.screenToGround(mouseX, mouseY, out);
  }

  function quickCast(slot: number): void {
    const hero = hooks.ownHero();
    if (hero === null) {
      hooks.castDenied('not in game yet');
      return;
    }
    const def = heroById(hero).abilities[slot];
    if (def === undefined || def.isPassive) return;
    if (def.targeting === 'none') {
      const why = hooks.castBlockReason(slot, {});
      if (why !== null) {
        hooks.castDenied(why);
        return;
      }
      hooks.send({ t: 'rift_cast', slot });
      return;
    }
    if (def.targeting === 'point') {
      const pt = { x: 0, z: 0 };
      if (!cursorGround(pt)) return;
      const why = hooks.castBlockReason(slot, { x: pt.x, z: pt.z });
      if (why !== null) {
        hooks.castDenied(why);
        return;
      }
      hooks.send({ t: 'rift_cast', slot, x: pt.x, z: pt.z });
      return;
    }
    // unit-targeted: pick the unit under the cursor
    const id = scene.pickUnit(mouseX, mouseY);
    if (id < 0) {
      hooks.castDenied('no target under the cursor');
      return;
    }
    const why = hooks.castBlockReason(slot, { target: id });
    if (why !== null) {
      hooks.castDenied(why);
      return;
    }
    hooks.send({ t: 'rift_cast', slot, target: id });
  }

  function useItem(slot: number): void {
    const id = hooks.ownItems()[slot];
    if (id === null || id === undefined) {
      // same dead-key law as QWER: a denied press says WHY (round-6 UX)
      hooks.castDenied('no item in that slot');
      return;
    }
    const active = ITEMS[id].active;
    if (active === undefined) return; // passive item: mirrors passive abilities (silent)
    if (active.kind === 'aura') {
      const why = hooks.itemBlockReason(slot, {});
      if (why !== null) {
        hooks.castDenied(why);
        return;
      }
      hooks.send({ t: 'rift_item', slot });
      return;
    }
    // dash + ward both target the cursor ground point
    const pt = { x: 0, z: 0 };
    if (!cursorGround(pt)) {
      hooks.castDenied('aim at the ground to use this item');
      return;
    }
    const why = hooks.itemBlockReason(slot, { x: pt.x, z: pt.z });
    if (why !== null) {
      hooks.castDenied(why);
      return;
    }
    hooks.send({ t: 'rift_item', slot, x: pt.x, z: pt.z });
  }

  function rightClick(): void {
    const pt = { x: 0, z: 0 };
    const onGround = cursorGround(pt);
    const id = scene.pickUnit(mouseX, mouseY);
    if (id >= 0) {
      const self = hooks.selfTeam();
      const team = hooks.entTeam(id);
      if (self !== null && team !== null && team !== self) {
        hooks.send({ t: 'rift_order', kind: 'attack', target: id });
        if (onGround) hooks.orderMarker(pt.x, pt.z, true);
        return;
      }
    }
    if (!onGround) return;
    hooks.send({ t: 'rift_order', kind: 'move', x: pt.x, z: pt.z });
    hooks.orderMarker(pt.x, pt.z, false);
  }

  function leftClick(): void {
    if (attackMoveArmed) {
      attackMoveArmed = false;
      const pt = { x: 0, z: 0 };
      if (!cursorGround(pt)) return;
      hooks.send({ t: 'rift_order', kind: 'attackmove', x: pt.x, z: pt.z });
      hooks.orderMarker(pt.x, pt.z, true);
      return;
    }
    hooks.setSelected(scene.pickUnit(mouseX, mouseY));
  }

  // ---- keyboard ---------------------------------------------------------------
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (typingTarget()) return;
    held.add(e.code);
    if (e.repeat) return;
    if (e.code === 'Tab') {
      e.preventDefault(); // never move focus out of the game
      if (hooks.isLive()) hooks.setScoreboard(true);
      return;
    }
    if (!hooks.isLive()) return;
    if (e.code === 'Escape') {
      attackMoveArmed = false;
      return;
    }
    const abilitySlot = ABILITY_SLOTS[e.code];
    if (abilitySlot !== undefined) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        hooks.send({ t: 'rift_skill', slot: abilitySlot });
      } else {
        quickCast(abilitySlot);
      }
      return;
    }
    if (e.code === 'KeyA' && !e.ctrlKey && !e.metaKey) {
      attackMoveArmed = true;
      return;
    }
    if (e.code === 'KeyS' && !e.ctrlKey && !e.metaKey) {
      hooks.send({ t: 'rift_order', kind: 'stop' });
      return;
    }
    if (e.code.startsWith('Digit')) {
      const n = Number.parseInt(e.code.slice(5), 10);
      if (n >= 1 && n <= 6) useItem(n - 1);
    }
  });
  window.addEventListener('keyup', (e: KeyboardEvent) => {
    held.delete(e.code);
    if (e.code === 'Tab') {
      e.preventDefault();
      hooks.setScoreboard(false);
    }
  });
  window.addEventListener('blur', () => {
    held.clear();
    middleDrag = false;
    attackMoveArmed = false;
    setHoverCursor(false);
    hooks.setScoreboard(false);
  });
  window.addEventListener('resize', () => scene.resize());

  // ---- pointer ------------------------------------------------------------------
  root.addEventListener('contextmenu', (e: Event) => e.preventDefault());
  root.addEventListener('pointermove', (e: PointerEvent) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    pointerSeen = true;
    if (middleDrag) {
      const rect = scene.canvas.getBoundingClientRect();
      const mpp = rect.height > 0 ? (hooks.cameraHeight() * DRAG_SCALE) / rect.height : 0;
      // grab-the-world: the terrain follows the cursor. Screen-right is world
      // -x and screen-up is world +z (the fixed camera rig), so a +px drag
      // moves the camera target +x (screen-left) and a +py drag moves it +z
      // (screen-up). Measured by scripts/repro-pan.mjs.
      hooks.panBy((e.clientX - lastDragX) * mpp, (e.clientY - lastDragY) * mpp);
      lastDragX = e.clientX;
      lastDragY = e.clientY;
    }
  });
  scene.canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    pointerSeen = true;
    if (e.button === 1) {
      e.preventDefault();
      middleDrag = true;
      lastDragX = e.clientX;
      lastDragY = e.clientY;
      return;
    }
    if (!hooks.isLive()) return;
    if (e.button === 2) rightClick();
    else if (e.button === 0) leftClick();
  });
  window.addEventListener('pointerup', (e: PointerEvent) => {
    if (e.button === 1) middleDrag = false;
  });
  scene.canvas.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      e.preventDefault();
      if (!hooks.isLive()) return;
      hooks.zoomBy(e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    },
    { passive: false },
  );

  // ---- per-frame pan --------------------------------------------------------------
  function update(dtMs: number): void {
    if (!hooks.isLive()) {
      setHoverCursor(false);
      return;
    }
    // enemy-hover crosshair, throttled to ~30Hz (the raycast budget)
    hoverPickMs += dtMs;
    if (pointerSeen && hoverPickMs >= 33) {
      hoverPickMs = 0;
      const id = scene.pickUnit(mouseX, mouseY);
      const self = hooks.selfTeam();
      const team = id >= 0 ? hooks.entTeam(id) : null;
      setHoverCursor(self !== null && team !== null && team !== self);
    }
    let dx = 0;
    let dz = 0;
    // Arrow-key pan. MEASURED camera mapping (T7's rig in render/scene.ts:
    // camera sits at targetZ - back looking along +z): screen-up is world +z,
    // screen-right is world -x. Verified end-to-end by scripts/repro-pan.mjs.
    if (held.has('ArrowUp')) dz += 1;
    if (held.has('ArrowDown')) dz -= 1;
    if (held.has('ArrowLeft')) dx += 1;
    if (held.has('ArrowRight')) dx -= 1;
    // Screen-edge pan (not while middle-dragging — the drag owns the camera).
    if (pointerSeen && !middleDrag && document.hasFocus()) {
      if (mouseX <= EDGE_PX) dx += 1;
      else if (mouseX >= window.innerWidth - EDGE_PX) dx -= 1;
      if (mouseY <= EDGE_PX) dz += 1;
      else if (mouseY >= window.innerHeight - EDGE_PX) dz -= 1;
    }
    if (dx === 0 && dz === 0) return;
    const speed = hooks.cameraHeight() * PAN_SPEED_PER_HEIGHT;
    const scale = (speed * Math.min(dtMs, 100)) / 1000;
    // normalise diagonals so corner panning is not 41% faster
    const len = Math.hypot(dx, dz);
    hooks.panBy((dx / len) * scale, (dz / len) * scale);
  }

  return { update };
}

// ============================================================================
// ANCIENTS (rift) client — MINIMAP (CONTRACT §6 ui/minimap.ts, T9). A 2D
// canvas redrawn at ~4Hz: lane polylines from buildMap(begin.lanes), every
// structure ALWAYS (positions/hp are public — destroyed ones go dark), own +
// fog-visible mobiles as team dots (the server's snap is already fog-filtered,
// so drawing every mobile it contains can never leak), wards, the fog
// maskCanvas composited on top, the camera frustum rect, and click-to-pan via
// actions.panCameraTo. World [0,side]^2 maps linearly onto the square canvas,
// ROTATED 180° so the minimap agrees with the fixed camera rig (measured by
// scripts/repro-pan.mjs: screen-right is world -x, screen-up is world +z):
// world x -> canvas LEFT, world z -> canvas UP.
//
// DOM CLASS CONTRACT (§6): renders only .minimap (the wrapper); the canvas
// itself is classless (T8: `.minimap > canvas`). All canvas colours are APAL
// entries. Team dots are dots + team colour; the SELF dot gets a paper ring —
// identity is shape + colour, never colour alone (§8).
//
// The camera frustum is an approximation: the frozen seam exposes camera
// centre + height but not the scene's fov, so the rect derives from height
// with a 16:9, ~55° pitch estimate (constants below) — T7 owns the truth.
// ============================================================================
import { APAL, buildMap } from '@rift/shared';
import type { MapDef } from '@rift/shared';
import type { ClientState, UiActions, UiHandle } from '../contract.js';

const RES = 256; // canvas pixel resolution (CSS sizes the element; this is the backing store)
const REDRAW_MS = 250; // ~4Hz
const DOT_R = 3; // mobile dot radius, px
const SELF_RING_W = 1.5;
// camera frustum estimate: ground half-extents at the given camera height
// (16:9 view through a ~50° fov pitched ~55° down — close enough for a rect)
const FRUSTUM_HALF_W_PER_M = 0.9;
const FRUSTUM_HALF_H_PER_M = 0.55;

export function createMinimap(parent: HTMLElement): UiHandle {
  const root = document.createElement('div');
  root.className = 'minimap';
  root.style.display = 'none';
  parent.appendChild(root);

  const canvas = document.createElement('canvas');
  canvas.width = RES;
  canvas.height = RES;
  root.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let actionsRef: UiActions | null = null;
  let map: MapDef | null = null;
  let mapLanes = 0;
  let lastDraw = 0;

  canvas.addEventListener('pointerdown', (ev) => {
    if (!map || !actionsRef) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const u = (ev.clientX - rect.left) / rect.width;
    const v = (ev.clientY - rect.top) / rect.height;
    // the drawing is rotated 180° (see header): canvas right is world -x,
    // canvas down is world -z
    const x = (1 - Math.min(Math.max(u, 0), 1)) * map.side;
    const z = (1 - Math.min(Math.max(v, 0), 1)) * map.side;
    actionsRef.panCameraTo(x, z);
  });

  function draw(s: ClientState): void {
    if (!ctx || !map) return;
    const side = map.side;
    // rotated 180°: canvas right = world -x, canvas down = world -z
    const px = (x: number): number => (1 - x / side) * RES;
    const pz = (z: number): number => (1 - z / side) * RES;

    // ground
    ctx.fillStyle = APAL.mossDeep;
    ctx.fillRect(0, 0, RES, RES);

    // lane polylines
    ctx.strokeStyle = APAL.stone;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const path of map.paths) {
      ctx.beginPath();
      for (const [i, w] of path.entries()) {
        if (i === 0) ctx.moveTo(px(w.x), pz(w.z));
        else ctx.lineTo(px(w.x), pz(w.z));
      }
      ctx.stroke();
    }

    const snap = s.snap;
    const selfId = snap?.you ? findSelfEntId(s) : -1;

    // structures — always sent, always drawn; dead ones go dark, never vanish
    if (snap) {
      for (const e of snap.ents) {
        if (e.k !== 'tower' && e.k !== 'guard' && e.k !== 'ancient') continue;
        const alive = e.hp > 0;
        const col = e.team === 0 ? APAL.azure : APAL.ember;
        const x = px(e.x);
        const y = pz(e.z);
        if (e.k === 'ancient') {
          // diamond landmark, larger than towers
          ctx.fillStyle = alive ? col : APAL.stoneDeep;
          ctx.beginPath();
          ctx.moveTo(x, y - 5);
          ctx.lineTo(x + 5, y);
          ctx.lineTo(x, y + 5);
          ctx.lineTo(x - 5, y);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.fillStyle = alive ? col : APAL.stoneDeep;
          const half = e.k === 'guard' ? 3 : 2.5;
          ctx.fillRect(x - half, y - half, half * 2, half * 2);
        }
      }

      // mobiles — the snap is fog-filtered server-side, so every mobile here
      // is own-team or currently visible; wards are own-team-only by wire rule
      for (const e of snap.ents) {
        if (e.k === 'tower' || e.k === 'guard' || e.k === 'ancient' || e.k === 'proj') continue;
        const x = px(e.x);
        const y = pz(e.z);
        if (e.k === 'ward') {
          ctx.fillStyle = APAL.ward;
          ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
          continue;
        }
        const isSelf = e.id === selfId;
        ctx.fillStyle = isSelf
          ? APAL.heal
          : e.team === 0
            ? APAL.azure
            : APAL.ember;
        ctx.beginPath();
        ctx.arc(x, y, e.k === 'hero' ? DOT_R : DOT_R * 0.7, 0, Math.PI * 2);
        ctx.fill();
        if (isSelf) {
          ctx.strokeStyle = APAL.paper;
          ctx.lineWidth = SELF_RING_W;
          ctx.beginPath();
          ctx.arc(x, y, DOT_R + 1.5, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    // fog shroud, composited over the world (T7 owns the mask pixels; §6 fog
    // amendment makes it a map-aligned canvas, visible = clear). The mask is
    // world x -> u, z -> v, so the 180°-rotated minimap draws it flipped.
    const mask = s.fog?.maskCanvas;
    if (mask && mask.width > 0 && mask.height > 0) {
      try {
        ctx.save();
        ctx.translate(RES, RES);
        ctx.scale(-1, -1);
        ctx.drawImage(mask, 0, 0, RES, RES);
        ctx.restore();
      } catch {
        // a mid-rebuild mask must never break the minimap
      }
    }

    // camera frustum rect (estimate — see header). px/pz DECREASE with
    // x/z, so the rect's top-left corner is the +x/+z edge.
    const halfW = s.cameraHeight * FRUSTUM_HALF_W_PER_M;
    const halfH = s.cameraHeight * FRUSTUM_HALF_H_PER_M;
    ctx.strokeStyle = APAL.paper;
    ctx.lineWidth = 1;
    ctx.strokeRect(
      px(s.cameraX + halfW),
      pz(s.cameraZ + halfH),
      ((halfW * 2) / side) * RES,
      ((halfH * 2) / side) * RES,
    );
  }

  /** The ent id of the local hero (its snap row carries pid === hello.you). */
  function findSelfEntId(s: ClientState): number {
    const snap = s.snap;
    const youId = s.hello?.you;
    if (!snap || youId === undefined) return -1;
    for (const e of snap.ents) {
      if (e.k === 'hero' && e.pid === youId) return e.id;
    }
    return -1;
  }

  return {
    root,

    render(s: ClientState, a: UiActions): void {
      const live = s.phase === 'live';
      root.style.display = live ? '' : 'none';
      if (!live) return;
      actionsRef = a;

      // (re)build the geometry cache when the match's lane count changes
      const lanes = s.begin?.lanes ?? 0;
      if (lanes > 0 && lanes !== mapLanes) {
        map = buildMap(lanes);
        mapLanes = lanes;
      }
      if (!map) return;

      const now = performance.now();
      if (now - lastDraw < REDRAW_MS) return;
      lastDraw = now;
      draw(s);
    },
  };
}

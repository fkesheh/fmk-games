// ============================================================================
// ACES render3d/scene.test — headless unit gates for the 3D shell (W1).
//
// GRAPHICS_3D.md §6: "their tests are rewritten for pure math parts (mapping,
// pooling, determinism) without GL context". The SHIPPED helpers in scene.ts
// are exactly that: worldToScene/yawOf/forwardXZ ARE the frozen §1 coordinate
// law (the rig drives on nothing else), and easeFactor/shakeDecay/clampZoom/
// fovFor/rollFromBank/snapToGrid are the camera-feel constants the rig itself
// calls. Asserting them here is production behaviour, not a replica.
//
// The GL parts (createScene → WebGLRenderer) need a real canvas + context, so
// they are guarded: under node (CI gate) only the pure helpers run; the smoke
// block below activates only where `document` exists, and degrades to a skip
// if the browser has no WebGL.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { CLASSES } from '@aces/shared/config.js';
import {
  CAM_DIST,
  CAM_HEIGHT,
  PLANE_Y,
  LOOK_LIFT,
  camPoseFor,
  clampZoom,
  createScene,
  easeFactor,
  fovFor,
  forwardXZ,
  rollFromBank,
  shakeDecay,
  snapToGrid,
  speedFrac,
  worldToScene,
  yawOf,
} from './scene.js';
import type { AcesScene } from './scene.js';

const hasDom = typeof document !== 'undefined';
const itGL = hasDom ? it : it.skip;

// ---------------------------------------------------------------------------
// §1 coordinate law — THE frozen mapping
// ---------------------------------------------------------------------------
describe('coordinate law (GRAPHICS_3D §1)', () => {
  it('worldToScene maps X=x and Z=y identically', () => {
    const s = worldToScene(1234, -567);
    expect(s.x).toBe(1234);
    expect(s.z).toBe(-567);
    // identity both ways: no flip, no scale, no offset on the ground plane
    expect(s.x).toBe(1234);
    expect(worldToScene(0, 0).z).toBe(0);
    expect(worldToScene(-4200.5, 3000.25).x).toBe(-4200.5);
    expect(worldToScene(-4200.5, 3000.25).z).toBe(3000.25);
  });

  it('altitude rides Y, defaulting to cruise altitude PLANE_Y = 12u', () => {
    expect(PLANE_Y).toBe(12); // §1 pinned value
    expect(worldToScene(10, 20).y).toBe(12);
    expect(worldToScene(10, 20, 30).y).toBe(30);
    expect(worldToScene(10, 20, 30).y).not.toBe(worldToScene(10, 20).y);
  });

  it('yawOf negates heading (clockwise map-turn = negative yaw)', () => {
    expect(yawOf(0)).toBe(0);
    expect(yawOf(0.5)).toBe(-0.5);
    expect(yawOf(-0.5)).toBe(0.5);
    expect(yawOf(Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 15);
  });

  it('yawOf wraps into (−π, π] taking the short way round', () => {
    expect(yawOf(Math.PI + 0.1)).toBeCloseTo(Math.PI - 0.1, 12);
    expect(yawOf(-(Math.PI + 0.1))).toBeCloseTo(-(Math.PI - 0.1), 12);
    expect(yawOf(3 * Math.PI)).toBeCloseTo(-Math.PI, 12);
    // the formula's boundary convention: both ±3π land on −π
    expect(yawOf(-3 * Math.PI)).toBeCloseTo(-Math.PI, 12);
    const y = yawOf(100);
    expect(y).toBeLessThanOrEqual(Math.PI);
    expect(y).toBeGreaterThan(-Math.PI - 1e-9);
  });

  it('a model authored facing +X rotated by yawOf(h) points along forwardXZ(h)', () => {
    // RotY(θ) maps +X=(1,0) onto (cosθ, −sinθ) in XZ; with θ = yawOf(h) this
    // must equal (cos h, sin h) — the composition that makes §1 self-consistent.
    for (const h of [0, 0.3, Math.PI / 2, Math.PI, -2.1, 5 * Math.PI]) {
      const yaw = yawOf(h);
      const fwd = forwardXZ(h);
      expect(Math.cos(yaw)).toBeCloseTo(fwd.x, 12);
      expect(-Math.sin(yaw)).toBeCloseTo(fwd.z, 12);
    }
  });

  it('forwardXZ: h=0 is east (+X), h=π/2 is map +y (+Z) — clockwise-positive', () => {
    expect(forwardXZ(0).x).toBeCloseTo(1, 15);
    expect(forwardXZ(0).z).toBeCloseTo(0, 15);
    expect(forwardXZ(Math.PI / 2).x).toBeCloseTo(0, 15);
    expect(forwardXZ(Math.PI / 2).z).toBeCloseTo(1, 15);
    expect(forwardXZ(Math.PI).x).toBeCloseTo(-1, 15);
  });
});

// ---------------------------------------------------------------------------
// Camera feel constants — the shipped values the rig calls every frame
// ---------------------------------------------------------------------------
describe('camera law helpers (GRAPHICS_3D §2)', () => {
  it('pins the chase constants at the contract values', () => {
    expect(CAM_DIST).toBe(24);
    expect(CAM_HEIGHT).toBe(10);
  });

  it('easeFactor(0 or negative dt) is exactly 0 and otherwise 1−exp(−rate·dt)', () => {
    expect(easeFactor(0, 8)).toBe(0);
    expect(easeFactor(-0.016, 8)).toBe(0);
    expect(easeFactor(0.125, 8)).toBeCloseTo(1 - Math.exp(-1), 14);
    expect(easeFactor(1 / 60, 8)).toBeCloseTo(1 - Math.exp(-8 / 60), 14);
  });

  it('easeFactor is monotone in dt and saturates toward 1', () => {
    let prev = -1;
    for (let i = 1; i <= 121; i++) {
      const k = easeFactor(i / 120, 8); // strictly positive past dt=0
      expect(k).toBeGreaterThanOrEqual(prev);
      expect(k).toBeGreaterThan(0);
      expect(k).toBeLessThan(1);
      prev = k;
    }
    expect(easeFactor(5, 8)).toBeGreaterThan(0.9999);
  });

  it('shakeDecay follows amp·exp(−7·dt) with a ~ln2/7 half-life', () => {
    expect(shakeDecay(0, 1)).toBe(0);
    expect(shakeDecay(10, 0)).toBe(10);
    expect(shakeDecay(10, 0.5)).toBeCloseTo(10 * Math.exp(-3.5), 12);
    expect(shakeDecay(1, Math.LN2 / 7)).toBeCloseTo(0.5, 12);
    let prev = Infinity;
    for (let dt = 0; dt <= 1.0001; dt += 1 / 60) {
      const a = shakeDecay(22, dt);
      expect(a).toBeLessThan(prev);
      prev = a;
    }
  });

  it('clampZoom pins the zoomTo multiplier to 0.5–6', () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(0.4)).toBe(0.5);
    expect(clampZoom(0.5)).toBe(0.5);
    expect(clampZoom(6)).toBe(6);
    expect(clampZoom(42)).toBe(6);
  });

  it('fovFor eases 55→62 with speedFrac, monotone, clamped outside', () => {
    expect(fovFor(0)).toBe(55);
    expect(fovFor(1)).toBe(62);
    expect(fovFor(0.5)).toBeCloseTo(58.5, 14);
    expect(fovFor(-3)).toBe(55);
    expect(fovFor(9)).toBe(62);
    let prev = 54;
    for (let f = 0; f <= 1.0001; f += 0.05) {
      expect(fovFor(f)).toBeGreaterThan(prev);
      prev = fovFor(f);
    }
  });

  it('speedFrac spans the frozen fleet band gunship.speedMin .. scout.speedMax', () => {
    expect(speedFrac(CLASSES.gunship.speedMin)).toBe(0);
    expect(speedFrac(CLASSES.scout.speedMax)).toBe(1);
    const mid = (CLASSES.gunship.speedMin + CLASSES.scout.speedMax) / 2;
    expect(speedFrac(mid)).toBeCloseTo(0.5, 14);
    expect(speedFrac(CLASSES.gunship.speedMin - 40)).toBe(0);
    expect(speedFrac(CLASSES.scout.speedMax + 40)).toBe(1);
  });

  it('rollFromBank keeps only bankZ·0.25 of the plane bank, sign preserved', () => {
    expect(rollFromBank(0)).toBe(0);
    expect(rollFromBank(0.45)).toBeCloseTo(0.1125, 15);
    expect(rollFromBank(-0.45)).toBeCloseTo(-0.1125, 15);
    expect(rollFromBank(2)).toBeCloseTo(0.5, 15);
  });

  it('snapToGrid pins world points to the shadow-box grid (texel-swim guard)', () => {
    expect(snapToGrid(37)).toBe(36);
    expect(snapToGrid(38)).toBe(40);
    expect(snapToGrid(-37)).toBe(-36);
    expect(snapToGrid(16)).toBe(16);
    expect(snapToGrid(100, 8)).toBe(104);
    expect(snapToGrid(103, 8)).toBe(104);
  });
});

// ---------------------------------------------------------------------------
// camPoseFor — THE corrected chase-cam law (§2, defect-2 pins). Forward is
// derived from HEADING only; the chase sits BEHIND the nose; the look point
// rides ALONG it; zoomMult scales distance ONLY.
// ---------------------------------------------------------------------------
describe('camPoseFor — corrected chase-cam law (GRAPHICS_3D §2)', () => {
  const P = { x: 2100, y: 1500 };
  const V = { x: 120, y: 0 };

  it('pins LOOK_LIFT at the frozen 1.5u', () => {
    expect(LOOK_LIFT).toBe(1.5);
  });

  it('h=0 (east): camera strictly WEST of the plane — behind the nose', () => {
    const p = camPoseFor(P, 0, V, 1);
    expect(p.camX).toBeLessThan(P.x);
    expect(p.camX).toBeCloseTo(P.x - CAM_DIST, 12);
    expect(p.camZ).toBeCloseTo(P.y, 12); // no lateral drift on a cardinal heading
    expect(p.camY).toBe(PLANE_Y + CAM_HEIGHT);
  });

  it('h=π (west): camera strictly EAST of the plane — behind the flipped nose', () => {
    const p = camPoseFor(P, Math.PI, { x: -120, y: 0 }, 1);
    expect(p.camX).toBeGreaterThan(P.x);
    expect(p.camX).toBeCloseTo(P.x + CAM_DIST, 12);
    expect(p.camZ).toBeCloseTo(P.y, 12);
  });

  it('forward comes from heading law: cam − plane is −forward·dist for all h', () => {
    const dist = CAM_DIST * clampZoom(1);
    for (const h of [0, 0.7, Math.PI / 2, 2.4, Math.PI, -1.3, 5 * Math.PI]) {
      const p = camPoseFor(P, h, { x: 40, y: -30 }, 1);
      const f = forwardXZ(h); // (cos h, sin h) — the §1 composition with yawOf
      expect(p.camX - P.x).toBeCloseTo(-f.x * dist, 12);
      expect(p.camZ - P.y).toBeCloseTo(-f.z * dist, 12);
      // and the model-side composition holds: RotY(yawOf(h))·(+X) === forward
      expect(Math.cos(yawOf(h))).toBeCloseTo(f.x, 12);
      expect(-Math.sin(yawOf(h))).toBeCloseTo(f.z, 12);
    }
  });

  it('look point lies BETWEEN the plane and the forward horizon', () => {
    for (const h of [0, 0.9, Math.PI / 2, Math.PI]) {
      const f = forwardXZ(h);
      const speed = Math.hypot(V.x, V.y);
      const ahead = speed * 0.26; // CAMERA.LOOKAHEAD_S
      const p = camPoseFor(P, h, V, 1);
      // projection of (look − plane) onto forward is positive and < horizon
      const along = (p.lookX - P.x) * f.x + (p.lookZ - P.y) * f.z;
      expect(along).toBeGreaterThan(0); // strictly IN FRONT of the plane…
      expect(along).toBeCloseTo(ahead, 12); // …and EXACTLY |vel|·LOOKAHEAD_S along it
    }
  });

  it('idle frames (|vel|≈0) keep looking ALONG THE NOSE, not at velocity noise', () => {
    const p = camPoseFor(P, Math.PI / 2, { x: 0, y: 0 }, 1);
    expect(p.lookX).toBeCloseTo(P.x, 12);
    expect(p.lookZ).toBeCloseTo(P.y, 12);
    expect(p.lookY).toBe(PLANE_Y + LOOK_LIFT); // lifted off the airframe itself
    // near-zero drift still looks essentially down the nose (+Z for h=π/2)
    const drift = camPoseFor(P, Math.PI / 2, { x: 0.5, y: -0.5 }, 1);
    expect(drift.lookZ - P.y).toBeGreaterThan(drift.lookX - P.x - 10);
  });

  it('zoomMult scales CHASE DISTANCE ONLY — look point untouched', () => {
    const base = camPoseFor(P, 0.6, V, 1);
    for (const z of [0.5, 1, 2, 3.2, 6]) {
      const p = camPoseFor(P, 0.6, V, z);
      expect(p.lookX).toBeCloseTo(base.lookX, 12);
      expect(p.lookY).toBe(base.lookY);
      expect(p.lookZ).toBeCloseTo(base.lookZ, 12);
      const dx = p.camX - P.x;
      const dz = p.camZ - P.y;
      const dBase = Math.hypot(base.camX - P.x, base.camZ - P.y);
      expect(Math.hypot(dx, dz)).toBeCloseTo(dBase * clampZoom(z), 10);
      // direction unchanged: purely radial scaling about the plane
      expect(dx * (base.camZ - P.y) - dz * (base.camX - P.x)).toBeCloseTo(0, 9);
    }
  });

  it('re-clamps out-of-band zoom pins authoritatively (0.5–6) inside the pose', () => {
    const wide = camPoseFor(P, 0, V, 42);
    expect(wide.camX).toBeCloseTo(P.x - CAM_DIST * 6, 12);
    const tight = camPoseFor(P, 0, V, 0.01);
    expect(tight.camX).toBeCloseTo(P.x - CAM_DIST * 0.5, 12);
  });
});

// ---------------------------------------------------------------------------
// GL smoke (browser-only; skipped under node, degraded to a pass when the
// context cannot be created)
// ---------------------------------------------------------------------------
describe('createScene GL smoke (browser-only)', () => {
  itGL('builds, follows, projects through the live camera, disposes', () => {
    const canvas = document.createElement('canvas');
    let sc: AcesScene;
    try {
      sc = createScene(canvas);
    } catch {
      console.info('[aces/scene.test] WebGL unavailable — GL assertions skipped');
      return;
    }
    sc.setViewport(320, 240);
    sc.rig.setZoomMult(1);
    sc.rig.shake(9);
    // First follow snaps the eased pose; second runs the normal eased path.
    sc.rig.follow({ x: 2100, y: 1500 }, { x: 120, y: 0 }, 0, 0, 0, 1);
    sc.rig.follow({ x: 2100, y: 1500 }, { x: 120, y: 0 }, 0, 0, 0, 1 / 60);
    sc.render(1 / 60, 0.5);

    const ahead = sc.rig.project(2140, 1500); // 40u ahead of an east-facing plane
    expect(Number.isFinite(ahead.sx)).toBe(true);
    expect(Number.isFinite(ahead.sy)).toBe(true);
    expect(ahead.visible).toBe(true);
    expect(ahead.sx).toBeGreaterThanOrEqual(0);
    expect(ahead.sx).toBeLessThanOrEqual(320);
    expect(ahead.sy).toBeGreaterThanOrEqual(0);
    expect(ahead.sy).toBeLessThanOrEqual(240);

    const behindCam = sc.rig.project(1700, 1500); // far behind the chase camera
    expect(behindCam.visible).toBe(false);

    sc.setQuality('low');
    sc.setQuality('high');
    sc.dispose();
  });
});

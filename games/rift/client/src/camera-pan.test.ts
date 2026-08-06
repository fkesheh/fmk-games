// ============================================================================
// ANCIENTS (rift) — camera pan direction lock (T8). Regression coverage for
// the "screen pan was inverted on both axes" bug: input.ts's three pure pan
// paths (arrowPanDelta / edgePanDelta / dragPanDelta) must each push the
// camera target in the direction that produces the correct ON-SCREEN result,
// not merely a documented sign.
//
// This file does NOT trust the mapping written in input.ts's own comment.
// Layer 1 below rebuilds scene.ts's applyCamera from scratch (same pitch/
// height/back formula, same THREE.PerspectiveCamera call) and projects known
// world points through it to derive the screen mapping independently. Layer
// 2 then ties every pan path's output back to that same projection, so the
// assertions state the user-visible truth (where does a landmark move on
// screen), not a bare dx/dz sign.
//
// Runs under vitest's plain `node` environment — no jsdom, no renderer, no
// DOM. `three`'s math (Vector3/PerspectiveCamera/lookAt/project) has no DOM
// dependency, so the camera is built directly here instead of importing
// scene.ts's internal (non-exported) applyCamera.
// ============================================================================
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CAMERA_PITCH_DEG } from './render/scene.js';
import { arrowPanDelta, dragPanDelta, edgePanDelta } from './input.js';

// scene.ts's CAMERA_FOV is not exported (deliberately — it's not part of the
// input/render seam). Its value (50) is read directly from scene.ts's camera
// construction (`new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.5, 1400)`) and
// mirrored here; the FOV value does not affect which SIDE of the screen a
// point lands on, only how far, so a mismatch here could not hide an axis
// inversion.
const CAMERA_FOV = 50;
const CAMERA_PITCH = THREE.MathUtils.degToRad(CAMERA_PITCH_DEG);

/**
 * Rebuild scene.ts's applyCamera exactly: a PerspectiveCamera sitting `back`
 * metres south (world -Z) of (targetX, 0, targetZ) at camHeight, looking at
 * the target. `back` is derived from height/pitch the same way applyCamera
 * derives it. No shake terms (shakeX/shakeZ) — they are additive jitter, not
 * part of the mapping under test.
 */
function buildCamera(targetX: number, targetZ: number, camHeight: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.5, 1400);
  const back = camHeight / Math.tan(CAMERA_PITCH);
  camera.position.set(targetX, camHeight, targetZ - back);
  camera.lookAt(targetX, 0, targetZ);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

/** NDC projection of a ground-plane (y=0) world point. NDC x: -1 left .. +1
 *  right. NDC y: -1 bottom .. +1 top (three.js convention). */
function projectGround(camera: THREE.PerspectiveCamera, x: number, z: number): { x: number; y: number } {
  const v = new THREE.Vector3(x, 0, z);
  v.project(camera);
  return { x: v.x, y: v.y };
}

const CAM_HEIGHT = 40;
const START_X = 64;
const START_Z = 64;

/**
 * The on-screen effect of panning the camera TARGET by (dx, dz): rebuild the
 * camera at the panned target and re-project the ORIGINAL target point
 * (a landmark that was screen-centred before the pan). The landmark's screen
 * movement is what a player actually sees, so this is the ground truth every
 * pan path is checked against.
 */
function screenShiftFromTargetPan(dx: number, dz: number): { dx: number; dy: number } {
  const before = buildCamera(START_X, START_Z, CAM_HEIGHT);
  const beforeNdc = projectGround(before, START_X, START_Z);
  const after = buildCamera(START_X + dx, START_Z + dz, CAM_HEIGHT);
  const afterNdc = projectGround(after, START_X, START_Z);
  return { dx: afterNdc.x - beforeNdc.x, dy: afterNdc.y - beforeNdc.y };
}

describe('Layer 1: derive the camera screen mapping independently', () => {
  it('world +X projects to the LEFT of world -X (i.e. screen-right = world -X)', () => {
    const camera = buildCamera(START_X, START_Z, CAM_HEIGHT);
    const plusX = projectGround(camera, START_X + 10, START_Z);
    const minusX = projectGround(camera, START_X - 10, START_Z);
    expect(plusX.x).toBeLessThan(minusX.x);
  });

  it('world +Z projects ABOVE world -Z (i.e. screen-up = world +Z)', () => {
    const camera = buildCamera(START_X, START_Z, CAM_HEIGHT);
    const plusZ = projectGround(camera, START_X, START_Z + 10);
    const minusZ = projectGround(camera, START_X, START_Z - 10);
    expect(plusZ.y).toBeGreaterThan(minusZ.y);
  });
});

describe('Layer 2: arrowPanDelta', () => {
  it('no keys held -> zero delta', () => {
    expect(arrowPanDelta(new Set())).toEqual({ dx: 0, dz: 0 });
  });

  it('ArrowUp reveals terrain at the TOP: a centred landmark shifts down-screen', () => {
    const { dx, dz } = arrowPanDelta(new Set(['ArrowUp']));
    const shift = screenShiftFromTargetPan(dx, dz);
    expect(shift.dy).toBeLessThan(0);
  });

  it('ArrowDown reveals terrain at the BOTTOM: a centred landmark shifts up-screen', () => {
    const { dx, dz } = arrowPanDelta(new Set(['ArrowDown']));
    const shift = screenShiftFromTargetPan(dx, dz);
    expect(shift.dy).toBeGreaterThan(0);
  });

  it('ArrowLeft reveals terrain on the LEFT: a centred landmark shifts right-screen', () => {
    const { dx, dz } = arrowPanDelta(new Set(['ArrowLeft']));
    const shift = screenShiftFromTargetPan(dx, dz);
    expect(shift.dx).toBeGreaterThan(0);
  });

  it('ArrowRight reveals terrain on the RIGHT: a centred landmark shifts left-screen', () => {
    const { dx, dz } = arrowPanDelta(new Set(['ArrowRight']));
    const shift = screenShiftFromTargetPan(dx, dz);
    expect(shift.dx).toBeLessThan(0);
  });

  it('Up+Left held together compose: landmark shifts down AND right', () => {
    const { dx, dz } = arrowPanDelta(new Set(['ArrowUp', 'ArrowLeft']));
    const shift = screenShiftFromTargetPan(dx, dz);
    expect(shift.dy).toBeLessThan(0);
    expect(shift.dx).toBeGreaterThan(0);
  });

  it('Down+Right held together compose: landmark shifts up AND left', () => {
    const { dx, dz } = arrowPanDelta(new Set(['ArrowDown', 'ArrowRight']));
    const shift = screenShiftFromTargetPan(dx, dz);
    expect(shift.dy).toBeGreaterThan(0);
    expect(shift.dx).toBeLessThan(0);
  });
});

describe('Layer 2: edgePanDelta', () => {
  const VW = 1000;
  const VH = 800;

  it('cursor in the middle of the viewport -> zero delta', () => {
    expect(edgePanDelta(VW / 2, VH / 2, VW, VH)).toEqual({ dx: 0, dz: 0 });
  });

  it('cursor at the LEFT edge reveals terrain on the left: landmark shifts right-screen', () => {
    const { dx, dz } = edgePanDelta(0, VH / 2, VW, VH);
    const shift = screenShiftFromTargetPan(dx, dz);
    expect(shift.dx).toBeGreaterThan(0);
  });

  it('cursor at the RIGHT edge reveals terrain on the right: landmark shifts left-screen', () => {
    const { dx, dz } = edgePanDelta(VW - 1, VH / 2, VW, VH);
    const shift = screenShiftFromTargetPan(dx, dz);
    expect(shift.dx).toBeLessThan(0);
  });

  it('cursor at the TOP edge reveals terrain at the top: landmark shifts down-screen', () => {
    const { dx, dz } = edgePanDelta(VW / 2, 0, VW, VH);
    const shift = screenShiftFromTargetPan(dx, dz);
    expect(shift.dy).toBeLessThan(0);
  });

  it('cursor at the BOTTOM edge reveals terrain at the bottom: landmark shifts up-screen', () => {
    const { dx, dz } = edgePanDelta(VW / 2, VH - 1, VW, VH);
    const shift = screenShiftFromTargetPan(dx, dz);
    expect(shift.dy).toBeGreaterThan(0);
  });

  it('cursor in the top-left corner composes both edges', () => {
    const { dx, dz } = edgePanDelta(0, 0, VW, VH);
    const shift = screenShiftFromTargetPan(dx, dz);
    expect(shift.dx).toBeGreaterThan(0);
    expect(shift.dy).toBeLessThan(0);
  });
});

describe('Layer 2: dragPanDelta ("grab the world")', () => {
  const METRES_PER_PIXEL = 0.05;

  it('dragging the cursor RIGHT moves the world WITH it: landmark shifts right-screen', () => {
    const { dx, dz } = dragPanDelta(120, 0, METRES_PER_PIXEL);
    const shift = screenShiftFromTargetPan(dx, dz);
    expect(shift.dx).toBeGreaterThan(0);
  });

  it('dragging the cursor LEFT moves the world WITH it: landmark shifts left-screen', () => {
    const { dx, dz } = dragPanDelta(-120, 0, METRES_PER_PIXEL);
    const shift = screenShiftFromTargetPan(dx, dz);
    expect(shift.dx).toBeLessThan(0);
  });

  it('dragging the cursor DOWN moves the world WITH it: landmark shifts down-screen', () => {
    const { dx, dz } = dragPanDelta(0, 120, METRES_PER_PIXEL);
    const shift = screenShiftFromTargetPan(dx, dz);
    expect(shift.dy).toBeLessThan(0);
  });

  it('dragging the cursor UP moves the world WITH it: landmark shifts up-screen', () => {
    const { dx, dz } = dragPanDelta(0, -120, METRES_PER_PIXEL);
    const shift = screenShiftFromTargetPan(dx, dz);
    expect(shift.dy).toBeGreaterThan(0);
  });

  it('no cursor movement -> zero delta', () => {
    expect(dragPanDelta(0, 0, METRES_PER_PIXEL)).toEqual({ dx: 0, dz: 0 });
  });
});

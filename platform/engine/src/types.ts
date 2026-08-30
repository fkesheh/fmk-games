// ============================================================================
// @platform/engine CONTRACT — types-only surface of the shared three.js
// toolkit (docs/PLATFORM.md §4.6). Implementations live in loop.ts, rig.ts,
// prims.ts, pools.ts, cameras.ts, debugHud.ts; each implementer owns its file
// and extends src/index.ts with its own re-exports ONLY.
// FROZEN — additive changes only, by architect decision.
// ============================================================================

import type * as THREE from 'three';

// ---- loop ------------------------------------------------------------------

/** Fixed-step simulation + rAF render loop. */
export interface LoopOpts {
  /** Simulation Hz (default 30). Render always runs at rAF rate. */
  readonly tickHz?: number;
  /** Max sim steps caught up per frame before snapping (default 5). */
  readonly maxCatchUp?: number;
  /**
   * Fixed-step callback. dt is SECONDS (= 1/tickHz), constant every call.
   * Never called after stop(); safe to throw — Loop catches, logs once, stops.
   */
  onTick(dt: number, tick: number): void;
  /**
   * Per-rAF callback. dtFrame is real elapsed seconds, clamped to 0.25.
   * alpha = fractional step past the last tick (0..1) for interpolation.
   */
  onRender(dtFrame: number, alpha: number, nowMs: number): void;
}

// ---- rig -------------------------------------------------------------------

/** SceneRig construction options; every field optional with a sane default. */
export interface RigOpts {
  readonly canvas: HTMLCanvasElement;
  /** Vertical FOV degrees (default 60). */
  readonly fovDeg?: number;
  /** Camera near/far planes (default 0.1 / 400). */
  readonly near?: number;
  readonly far?: number;
  /** Sky/fog colors as CSS hex strings; fog off when fogColor omitted. */
  readonly skyColor?: string;
  readonly fogColor?: string;
  readonly fogDensity?: number;
  /** Shadow map size in px; 0 disables shadows entirely (default 1024). */
  readonly shadowMapSize?: number;
  /** Tone mapping exposure (default 1.0). */
  readonly exposure?: number;
}

/** Directional sun descriptor used by SceneRig.setSun. */
export interface SunSpec {
  /** World-space direction TOWARDS the sun (normalized internally). */
  readonly dir: { readonly x: number; readonly y: number; readonly z: number };
  readonly color: string;
  readonly intensity: number;
  /** Hemisphere light ground color. */
  readonly groundColor: string;
  /** Hemisphere intensity (default 0.6). */
  readonly hemiIntensity?: number;
  /** Shadow camera half-extent (default 40); sun follows setSunFocus target. */
  readonly shadowExtent?: number;
}

// ---- prims -----------------------------------------------------------------

/** Material recipe for the factory vocabulary. */
export interface MatSpec {
  /** CSS hex color. */
  readonly color: string;
  /** 0..1 roughness (default 0.9). */
  readonly roughness?: number;
  /** Emissive strength multiplier (default 0). */
  readonly emissive?: number;
}

/**
 * Axis-aligned box centered at (x,y,z) with full sizes (w,h,d).
 * y is the CENTER height, matching house convention.
 */
export interface BoxSpec {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
  readonly mat: MatSpec;
  /** Rotation around Y, radians (default 0). */
  readonly yaw?: number;
}

export interface CylSpec {
  readonly x: number;
  readonly y: number; // center
  readonly z: number;
  readonly rTop: number;
  readonly rBot: number;
  readonly h: number;
  readonly mat: MatSpec;
  readonly yaw?: number;
}

export interface SphereSpec {
  readonly x: number;
  readonly y: number; // center
  readonly z: number;
  readonly r: number;
  readonly mat: MatSpec;
}

export interface ConeSpec {
  readonly x: number;
  readonly y: number; // center of the CONE (half height up from base at y-h/2)
  readonly z: number;
  readonly r: number;
  readonly h: number;
  readonly mat: MatSpec;
}

// ---- pools -----------------------------------------------------------------

/** Particle/tracer pool capacities (defaults used when omitted). */
export interface PoolCaps {
  readonly particles?: number; // default 256
  readonly tracers?: number; // default 64
}

/** One-shot particle burst request (world space, seconds). */
export interface BurstSpec {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly count: number;
  readonly color: string;
  /** Initial speed range, units/s (default [1,3]). */
  readonly speed?: readonly [number, number];
  /** Particle lifetime seconds (default 0.5). */
  readonly lifeSec?: number;
  /** Gravity acceleration, units/s² (default -6). */
  readonly gravity?: number;
}

// ---- cameras ---------------------------------------------------------------

/** Chase-cam tuning (third person follow). */
export interface ChaseOpts {
  readonly dist: number;
  readonly height: number;
  /** Positional smoothing factor per second (default 8). */
  readonly lag?: number;
  /** Look-at height offset above the tracked position. */
  readonly lookHeight?: number;
}

/** Orbit-cam tuning (menu / spectator). */
export interface OrbitOpts {
  readonly radius: number;
  readonly height: number;
  /** Radians/second auto-rotation. */
  readonly rotSpeed?: number;
}

// ---- debug hud -------------------------------------------------------------

/** DebugHud line provider: return null to hide that row. */
export type DebugRows = () => ReadonlyArray<string>;

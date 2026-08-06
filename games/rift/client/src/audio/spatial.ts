// RIFT audio — T2: spatialisation.
//
// Implements SONIC_BIBLE §6 ("Space") against the `SPATIAL` constants in `config.ts`. Pure
// math only: no `window`, no `AudioContext`, no DOM, no side effects, so this is unit-testable
// in a plain node environment. `resolve` allocates nothing beyond the returned `SpatialResult`.

import type { CreateSpatial, ListenerState, SpatialHandle, SpatialResult } from './contract.js';
import { SPATIAL } from './config.js';
import { db } from './dsp.js';

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export const createSpatial: CreateSpatial = () => {
  // Listener defaults to the origin at the reference camera height until the engine calls
  // `setListener` for the first time (which it must do before any `resolve`).
  let listener: ListenerState = { x: 0, z: 0, height: SPATIAL.camRefHeight };

  const handle: SpatialHandle = {
    setListener(l: ListenerState): void {
      listener = l;
    },

    resolve(x: number, z: number, self: boolean, visible: boolean): SpatialResult {
      const dx = x - listener.x;
      const dz = z - listener.z;

      // Camera height scales effective distance: zoomed out reads as further away, so it is
      // quieter and wetter (SONIC_BIBLE §6, "Height").
      const heightFactor = 1 + (listener.height - SPATIAL.camRefHeight) * SPATIAL.heightScale;
      const d = Math.hypot(dx, dz) * heightFactor;

      // Self is always audible regardless of distance — "you always hear your own hero"
      // (SONIC_BIBLE §2 law 5).
      const audible = self || d <= SPATIAL.audibleRadius;

      // Distance rolloff, floored so nothing ever fully vanishes inside the audible radius.
      // Self bypasses attenuation entirely: zero distance attenuation.
      let gain = self ? 1 : Math.max(SPATIAL.gainFloor, 1 / (1 + (d / SPATIAL.refDistance) ** 2));

      // Pan is distance-independent (horizontal offset only, never hard-panned). Self pulls
      // toward centre via `selfPanScale` rather than being silenced.
      let pan = clamp(dx / SPATIAL.panHalfWidth, -1, 1) * SPATIAL.panMax;
      if (self) {
        pan *= SPATIAL.selfPanScale;
      }

      // Reverb send rises with distance — far things are wetter, which is what makes the map
      // feel like a place. Self sends nothing (it is always "here").
      const send = self
        ? 0
        : Math.min(SPATIAL.sendMax, (d / SPATIAL.audibleRadius) * SPATIAL.sendScale);

      // Fog occlusion ATTENUATES and LOWPASSES — it never mutes. An unseen sound is still
      // heard, dulled: you hear that something happened in the dark (SONIC_BIBLE §6).
      let cutoffHz = Infinity;
      if (!visible) {
        gain *= db(SPATIAL.fogAttenDb);
        cutoffHz = SPATIAL.fogCutoffHz;
      }

      // The player's own actions get an additional loudness bias on top of everything above.
      if (self) {
        gain *= db(SPATIAL.selfBiasDb);
      }

      return { pan, gain, send, cutoffHz, audible };
    },
  };

  return handle;
};

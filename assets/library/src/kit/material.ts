// ============================================================================
// FROZEN — the ONE material every asset uses: flat-shaded Lambert, white base,
// ALL color in vertex attributes. Wind bend is patched in via kit/wind.ts so
// motion costs zero CPU per frame. Hosts that never call setWind() get a
// gracefully static tree (time uniform simply stays at its initial value).
// ============================================================================
import * as THREE from 'three';

/** Shared wind state — the ONLY mutable thing in the library. */
export const windState = {
  time: 0,
  strength: 0, // 0..1; hosts drive this. 0 = perfectly still.
};

const WIND_CHUNK = /* glsl */ `
uniform float uWindTime;
uniform float uWindStrength;
attribute float aBend;
`;

const WIND_BODY = /* glsl */ `
  // two desynced sines; phase from vertex world position so a forest never
  // moves as one board. quadratic aBend keeps bases stiff and tips lively.
  vec3 wpos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  float phase = wpos.x * 0.55 + wpos.z * 0.85;
  float sway =
    sin(uWindTime * 1.9 + phase) * 0.66 +
    sin(uWindTime * 3.7 + phase * 1.31) * 0.34;
  float bendW = aBend * aBend * uWindStrength;
  transformed.x += sway * bendW * 0.9 * max(transformed.y, 0.0) * 0.18;
  transformed.z += sway * bendW * 0.45 * max(transformed.y, 0.0) * 0.18;
`;

export const ASSET_MATERIAL = new THREE.MeshLambertMaterial({
  color: 0xffffff,
  vertexColors: true,
  flatShading: true,
});

ASSET_MATERIAL.customProgramCacheKey = () => 'asset-wind-1';
ASSET_MATERIAL.onBeforeCompile = (shader) => {
  shader.uniforms.uWindTime = {
    get value(): number {
      return windState.time;
    },
  };
  shader.uniforms.uWindStrength = {
    get value(): number {
      return windState.strength;
    },
  };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${WIND_CHUNK}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${WIND_BODY}`);
};

/** Hosts call once per frame. Graceful static if never called. */
export function setWind(timeSeconds: number, strength0to1: number): void {
  windState.time = timeSeconds;
  windState.strength = Math.max(0, Math.min(1, strength0to1));
}

// ============================================================================
// ANCIENTS (rift) — wire.ts. ORCHESTRATOR-OWNED composition root (CONTRACT
// §6): constructs every module and injects them into the Game. The render
// map/units/fog depend on the lane count, which is only known at rift_begin,
// so units/fog are built lazily on the first begin behind delegating facades.
// ============================================================================
import { buildMap } from '@rift/shared';
import type { FogHandle, GhostEnt, InterpEnt, UnitsHandle } from './contract.js';
import type { SnapMsg } from './contract.js';
import { Game } from './game.js';
import { createScene } from './render/scene.js';
import { buildMapMeshes } from './render/mapMesh.js';
import { createUnits } from './render/units.js';
import { createFog } from './render/fog.js';
import { createFx } from './render/fx.js';
import { createHud } from './ui/hud.js';
import { createShop } from './ui/shop.js';
import { createMinimap } from './ui/minimap.js';
import { createMenus } from './ui/menus.js';
import { createAudio } from './ui/audio.js';
import { createNameLabels } from './ui/nameLabels.js';

export function wire(root: HTMLElement): void {
  const scene = createScene(root);
  const fx = createFx(scene);

  // --- lazy map-dependent handles ------------------------------------------
  let units: UnitsHandle | null = null;
  let fog: FogHandle | null = null;
  let builtLanes = 0;
  // Pre-live stand-in for FogHandle.maskCanvas (the minimap only reads state
  // .fog while live, by which time the real fog exists — this is a belt-and-
  // braces fallback, never normally seen).
  const dummyMask = document.createElement('canvas');

  const unitsFacade: UnitsHandle = {
    sync(ents: readonly InterpEnt[], ghosts: readonly GhostEnt[], selfId: number): void {
      units?.sync(ents, ghosts, selfId);
    },
    setSelected(id: number): void {
      units?.setSelected(id);
    },
    orderMarker(x: number, z: number, attack: boolean): void {
      units?.orderMarker(x, z, attack);
    },
  };
  const fogFacade: FogHandle = {
    get maskCanvas(): HTMLCanvasElement {
      return fog ? fog.maskCanvas : dummyMask;
    },
    update(snap: SnapMsg): void {
      fog?.update(snap);
    },
    isVisible(x: number, z: number): boolean {
      return fog ? fog.isVisible(x, z) : true;
    },
  };

  const game = new Game(root, {
    scene,
    units: unitsFacade,
    fog: fogFacade,
    fx,
    hud: createHud(root),
    shop: createShop(root),
    minimap: createMinimap(root),
    menus: createMenus(root),
    audio: createAudio(),
    nameLabels: createNameLabels(root),
  });

  game.onBegin = (begin) => {
    if (begin.lanes === builtLanes && units !== null) return; // rematch, same map
    if (builtLanes !== 0) {
      // A second match with a DIFFERENT lane count needs a full static rebuild
      // (baked meshes have no dispose) — reload; the resume token rejoins the
      // room cleanly. Rare by construction (team size is stable across
      // rematches in one room).
      location.reload();
      return;
    }
    builtLanes = begin.lanes;
    const map = buildMap(begin.lanes);
    buildMapMeshes(scene, map);
    units = createUnits(scene, map);
    fog = createFog(scene, map);
  };
}

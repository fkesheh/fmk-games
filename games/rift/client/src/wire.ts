// ============================================================================
// ANCIENTS (rift) — wire.ts. ORCHESTRATOR-OWNED composition root (CONTRACT
// §6): constructs every module and injects them into the Game. The render
// map/terrain/vegetation/units/fog depend on the lane count, which is only
// known at rift_begin, so they are built lazily on the first begin behind
// delegating facades.
//
// TWO ORDERINGS HERE ARE CONTRACTUAL, NOT STYLISTIC.
//
// 1. `scene.setTerrain(...)` IS THE FIRST STATEMENT OF THE MAP BUILD.
//    `SceneHandle.heightAt` returns 0 for every input until setTerrain runs
//    (contract.ts, render/core.ts), and buildMapMeshes, createTerrain and
//    createVegetation all SAMPLE it while they build — terrain tessellates
//    against it vertex by vertex, vegetation plants every instance on it,
//    mapMesh sits its platforms and landmarks on it. Get this order wrong and
//    the whole world bakes flat at y=0: no error, no warning, and a smoke test
//    that still renders something. It is also called EXACTLY ONCE — a second
//    call would move the ground out from under baked geometry that has no
//    rebuild path — which is why the rematch guards below run before the build
//    function rather than inside it.
//
// 2. `createPost(scene)` is constructed at wire time, immediately after
//    createScene and before anything map-shaped. It depends on nothing
//    map-shaped, it must be live before the first frame, and it is the ONLY
//    legal caller of `SceneCore.setFramePass` (render/core.ts FRAME OWNERSHIP).
//
// THE DAY/NIGHT SPLIT. `setTimeOfDay` exists on both `SceneHandle` (lighting,
// sky, fog, exposure) and `PostHandle` (bloom, AO, grade, vignette) because
// the scene holds no reference to the post stack. wire.ts holds both, so it
// lends the post sink to the Game as `WireProbes.postTimeOfDay` and the Game
// publishes one value into both from one place.
// ============================================================================
import { buildMap } from '@rift/shared';
import type { MapDef } from '@rift/shared';
import type {
  FogHandle,
  GhostEnt,
  InterpEnt,
  SceneHandle,
  TerrainHandle,
  UnitsHandle,
  VegetationHandle,
} from './contract.js';
import type { SnapMsg } from './contract.js';
import { Game } from './game.js';
import { createScene } from './render/scene.js';
import { sceneCore } from './render/core.js';
import type { SceneCore } from './render/core.js';
import { createPost } from './render/post.js';
import { buildMapMeshes } from './render/mapMesh.js';
import { createTerrain } from './render/terrain.js';
import { createVegetation } from './render/vegetation.js';
import { createUnits } from './render/units.js';
import { createFog } from './render/fog.js';
import { createFx } from './render/fx.js';
import { createHud } from './ui/hud.js';
import { createShop } from './ui/shop.js';
import { createMinimap } from './ui/minimap.js';
import { createMenus } from './ui/menus.js';
import { createAudio } from './ui/audio.js';
import { createNameLabels } from './ui/nameLabels.js';

/**
 * Prove the internal render seam actually connected, at boot, loudly.
 *
 * `sceneCore()` is an unchecked cast to a `.core` property (render/core.ts): if
 * `createScene` ever returns a handle without one, every render module in the
 * build receives `undefined` and there is NO type error anywhere — the failure
 * surfaces as a pile of unrelated runtime errors from a dozen modules at once.
 *
 * `scene.environment` is the second half. STYLE_BIBLE §4 makes it a PMREM of
 * the procedural sky that is never null, and the whole PBR conversion is built
 * on it: with a null environment every `MeshStandardMaterial` in the world
 * loses its image-based fill and the frame renders as flat, unlit plastic —
 * which still LOOKS like a game, still passes a smoke test, and would be
 * graded as art by the judge loop. A hard failure at boot is strictly better
 * than a plausible wrong world.
 */
function checkedSceneCore(scene: SceneHandle): SceneCore {
  // Typed nullable deliberately: `sceneCore` DECLARES a non-null `SceneCore`
  // while returning whatever `.core` happens to hold, so the static type is
  // precisely the thing that cannot be trusted here.
  const core: SceneCore | undefined = sceneCore(scene) as SceneCore | undefined;
  if (core === undefined) {
    throw new Error(
      'rift wire: createScene returned a handle with no `core` — the internal render seam ' +
        '(render/core.ts sceneCore) is not connected and every render module would read undefined',
    );
  }
  if (core.three.environment === null) {
    throw new Error(
      'rift wire: scene.environment is null — the PMREM sky failed to build, so every PBR ' +
        'surface in the world would render unlit (STYLE_BIBLE §4: it is never null)',
    );
  }
  return core;
}

export function wire(root: HTMLElement): void {
  const scene = createScene(root);
  const core = checkedSceneCore(scene);
  // Ordering rule 2: the composer installs itself as the frame pass here.
  const post = createPost(scene);
  const fx = createFx(scene);

  // --- lazy map-dependent handles ------------------------------------------
  let terrain: TerrainHandle | null = null;
  let vegetation: VegetationHandle | null = null;
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

  game.probes = {
    // Both handles must exist AND both bakes must be finished. A module that
    // threw during construction stays null here, and both `ready()`
    // implementations report false on a failed bake (AMENDMENT_3 §G.1), so a
    // broken world can only ever read NOT ready — never a false green.
    worldReady: () => terrain !== null && vegetation !== null && terrain.ready() && vegetation.ready(),
    triangles: () => core.renderer.info.render.triangles,
    postTimeOfDay: (t) => {
      post.setTimeOfDay(t);
    },
  };

  /** One map-shaped module, built so that a throw costs that module and not
   *  the four after it. Construction runs inside the socket's message handler,
   *  where an escaping exception would abandon the rest of the build and leave
   *  a world with, say, terrain but no units — with the same guard R_SCENE
   *  applies to frame hooks and for the same reason (CONTRACT §10). The null
   *  handle it leaves behind is load-bearing: it is what keeps `worldReady()`
   *  false. */
  function build<T>(what: string, make: () => T): T | null {
    try {
      return make();
    } catch (err) {
      console.error(`rift wire: ${what} failed to build`, err);
      return null;
    }
  }

  function buildWorld(map: MapDef): void {
    // ORDERING RULE 1 — FIRST STATEMENT, ALWAYS. Everything below samples
    // `heightAt`, which returns 0 until this runs.
    scene.setTerrain(map.terrain);
    // ...then in any order.
    build('buildMapMeshes', () => {
      buildMapMeshes(scene, map);
    });
    terrain = build('createTerrain', () => createTerrain(scene, map));
    vegetation = build('createVegetation', () => createVegetation(scene, map));
    units = build('createUnits', () => createUnits(scene, map));
    fog = build('createFog', () => createFog(scene, map));
  }

  game.onBegin = (begin) => {
    if (begin.lanes === builtLanes && units !== null) return; // rematch, same map
    if (builtLanes !== 0) {
      // A second match with a DIFFERENT lane count needs a full static rebuild
      // (baked meshes have no dispose, and setTerrain may only be called once)
      // — reload; the resume token rejoins the room cleanly. Rare by
      // construction (team size is stable across rematches in one room).
      location.reload();
      return;
    }
    builtLanes = begin.lanes;
    buildWorld(buildMap(begin.lanes));
  };
}

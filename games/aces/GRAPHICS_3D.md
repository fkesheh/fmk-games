# GRAPHICS_3D — FROZEN RENDER-LAYER CONTRACT (ACES 3D)

**Status: amendment to CONTRACT.md/STYLE_BIBLE.md governing the client render layer only.**
Server sim, wire protocol, physics, prediction, audio, room flow: UNCHANGED. The 2D
authoritative state (x, y, h) is rendered in a 3D scene via a fixed coordinate mapping.
Everything not overridden here still binds.

Benchmark: **Sky Rogue** — flat-shaded low-poly chase-cam dogfight. Wins-or-ties bar,
same blind protocol. Luftrausers remains secondary (palette conviction reference).

---

## §1 Coordinate law (frozen)

- World (server) coords: `(x, y)` u, heading `h` rad, 0=+x east, clockwise-positive.
- Three.js scene (y-up): `X = x`, `Z = y`, `Y = altitude`. **Yaw: `rotation.y = -h`**
  (clockwise map-turn = negative yaw; models authored facing +X).
- Cruise altitude `PLANE_Y = 12` u; planes bob `±0.6u` (sin(t·0.9 + hash(id))) and
  pitch `+0.06rad·throttle` / boost `−0.04`; bank **roll = −turnInput·0.45rad** eased.
- Bullets fly at spawn-plane altitude, velocity mapped identically (`vx→VX, vy→VZ`).
- Sea plane at Y=0. Islands rise from it. Clouds Y=26–34. Sun from west, low.

## §2 Camera law (C_APP-owned rig)

- Chase cam: position eases toward `planePos − forward·CAM_DIST + UP·CAM_HEIGHT`,
  looking at `planePos + forward·LOOKAHEAD`. Constants (config CAMERA): `CAM_DIST=24`,
  `CAM_HEIGHT=10`, LOOKAHEAD vector `vel*0.35`.
- Speed feel: FOV eases 55→62 with speedFrac (replaces 2D zoom); `zoomTo(z)` debug pin
  now sets CAM_DISTANCE multiplier (z=1 default, clamps 0.5–6) — hero shots zoom in.
- Shake: impulse magnitude → decaying positional jitter (existing SHAKE constants).
- Own death: camera holds last position, orbits wreck slowly until respawn.
- `CameraView` seam extends with `project(wx,wy,wz)→{sx,sy,visible}` (screen-space
  projection via camera) — HUD consumes this instead of 2D math.

## §3 Material & light law

- **Flat-shaded low-poly.** `MeshLambertMaterial({flatShading:true})` ONLY (via one
  factory in render3d/materials.ts). No PBR/IBL/noisy textures. Colors from APAL via
  existing visual.ts helpers → `new THREE.Color(hex)`.
- Lights: `HemisphereLight(dawnHi, seaDark, 0.9)` + `DirectionalLight(sunGlare-warm)`
  from west-low, castShadow (1024 map, planes cast, sea/islands receive).
- Sky: `scene.background` = vertical dawnHi→dawnLo gradient (large inverted dome or
  canvas texture), `FogExp2(haze-mix, 0.0011)` — horizon melts into fog, never hard.

## §4 Scene graph & module seams

```
render3d/scene.ts        createScene(canvas) → AcesScene {
                           renderer, camera, // PerspectiveCamera(55)
                           setViewport(w,h,dpr), render(dt,t),
                           rig: { follow(pos,vel,dt), orbitDeath(t), shake(m),
                                  project(wx,wy,wz), getCam() },
                           setQuality(level) // graceful degrade
                         }
render3d/world.ts        createWorld(map) → {
                           group: THREE.Group,           // static+animated, added to scene
                           update(t, camPos),            // cloud drift, surf pulse, glints
                           dispose()
                         }
render3d/planeModels.ts  buildPlane(cls, team) → {
                           group,                        // faces +X
                           setControls(turnIn), setDamage(frac),
                           update(dt,t), setVisible(b), setBlink(b), dispose()
                         }
render3d/effects3d.ts    createEffects3D(seed) → EffectsApi3D {
                           // same verbs as 2D EffectsApi, 3D bodies:
                           muzzleFlash(p,h), tracerStub(p,h),
                           drawProjectiles(list),          // instanced tracer boxes
                           hitSpark(p), explosion(p,size,overWater),
                           trail(id,p,level), crateFx(kind,p),
                           syncCrates(crates),             // pooled crate models,
                                                           // fall sway / landed bob
                           shake(m), consumeShake(),
                           attach(scene), update(dt,cam), dispose()
                         }
```
- Static geometry (islands, fields, rocks) merged into few meshes (BufferGeometryUtils
  or manual merge); palms/rocks instanced. Draw-call budget: **≤120 steady-state**.
- Tracers: InstancedMesh (stretched thin boxes, amber BasicMaterial), pool 256.
  Smoke/explosions: billboard sprites (CanvasTexture radial puff from softPuff-style
  generator — the ONE puff model survives as the sprite texture source). Debris:
  InstancedMesh tetrahedra with gravity+spin. Crate: box + cone parachute.
- Plane part budgets carry over from STYLE_BIBLE §5 (silhouette law applies in 3D):
  SCOUT 10–14 parts · FIGHTER 12–18 · GUNSHIP 16–22, roundel ring / bar-cross on wings,
  wood cowls, dope linen underside, prop disc (semi-transparent circle) spinning.

## §5 App integration (C_APP)

- index.html keeps `#app`; style.css stacks: webgl canvas (z1) + hud canvas (z2,
  pointer-events none) + screens DOM (z30). Renderer antialias:true, DPR cap 2.
- Loop: predictor.advance → interp.sampleRemotes → rig.follow (or orbitDeath) →
  planeModel updates from rows (bank from turn echo, damage frac, blink) →
  effects3d.update → scene.render → hud.update(model, overlayWithProjections).
- OverlayModel: `cam.project()` fills crosshair screen-pos (point ahead of nose),
  lead pip (aimLead at PLANE_Y), target screen markers (on-screen) or edge arrows
  (offscreen, clamped). HUD math otherwise unchanged.
- Perf budget unchanged (60fps integrated); quality knob drops DPR→1, shadows off,
  halves sprite pools if frame >20ms rolling avg.

## §6 Rules deltas

- `Math.random()` ban stands (makeRng only). Ad-hoc hex ban stands — palette via
  `new THREE.Color(APAL[key])` or helper outputs ONLY.
- Old 2D render files (`render/world|planes|effects*.ts`) are RETIRED (deleted) —
  replaced by render3d/*; their tests are rewritten for pure math parts (mapping,
  pooling, determinism) without GL context.
- visual.ts remains the color vocabulary; add nothing ad-hoc in 3D land.

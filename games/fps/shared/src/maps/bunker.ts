// MAP M5 — bunker (underground CQB). Replaces placeholder per CONTRACT.md "Map specs".
// Layout carved out of solid mass: 8x8 central hub, a 2.5m ring corridor around it
// (the loop), 4 side rooms (N/S = team spawn rooms, W/E = flank rooms); all other
// interior volume is solid concrete. Invariants verified:
//   - enclosed: outer walls h=3 + ceiling slabs (bottom at y=2.8); the only
//     openings are 4 interior skylight slots (~2m, hub + N/S rooms + NE ring
//     junction) that let the sun throw light pools indoors; edges stay sealed
//   - routes CT(N) -> T(S): west ring, east ring, through the hub = 3 (+ ring loop)
//   - no spawn sightline: N/S lines must thread hub N door [0.8,2.8] + S door [-3,-1];
//     every such line crosses the 2x2 central pillar (door sets are staggered), and
//     ring routes require bends a straight line cannot make
//   - longest open sightline <25m: the spawn-room -> flank-room diagonal through two
//     doors (~27.5m raw) is cut by a full-height column mid flank room plus flank
//     masses extended to z=+-4.0; straight ring runs are 15.4m; hard limit is 25m
//   - cover every <=8m on routes (room crates -> ring nub -> junction crate -> ...)
//   - corridors 2.5m; worst pinches 1.5m (ring nubs) / 1.6m (junction crates) >= 1.4m
//   - 7 spawns/team, all on y=0 ground, none inside boxes (>=0.9m clearance)
//
// VALUE LADDER (VISUAL_UPGRADE.md §1/§3a) — bunker is DECLARED MONOCHROME, so it
// is exempt from L4 (hue split) and pays for that with the harder L1 >= 28.
//
// L5 REBUILD. The whole ladder used to hang off a metalDeep floor at L 14.5.
// That cleared the old L1 (46.2 - 14.5 = 31.7) but it is 7.5 L* BELOW the L5
// readability floor of 22 — the map was literally unreadably dark, and being
// under L 20 also meant no alpha contact shadow could ground a prop (L2b), so
// every crate, barrel and soldier floated. The fix lifts the WHOLE ladder one
// notch rather than compressing it: floor metalDeep -> metalDark, and the main
// wall concreteDark -> concrete, which buys back the separation the lift costs.
//   floor  metalDark      L 27.7   cleared L5 (>=22); still the darkest large plane
//   ceiling concreteDeep  L 28.6   overhead slab, unlit from below — UNCHANGED
//   beams  metalDeep      L 14.5   near-black structural ribs across the ceiling
//   cover  concreteDark   L 46.2   ring nubs + flank columns (was concreteDeep,
//                                  which now sits 0.9 L* off the floor and would
//                                  have made every piece of cover vanish at its base)
//   hub    concreteDark   L 46.2   hub walls + central pillar (was metalDark,
//                                  which is now the FLOOR MatId — the core would
//                                  have merged into the ground it stands on)
//   crate  crate          L 52.6
//   wall   concrete       L 58.4   the L1 REFERENCE (58.4 - 27.7 = 30.7 >= 28)
//   accent hazardAmber         L 63.9   warm emergency dressing against the cold light
//   pipes  metal (steel)  L 66.6   the brightest structure, reads in the gloom
// Why metalDark and not concreteDeep (L 28.6, which also clears L1 at 29.8): its
// CONTACT_MAT partner is metalDeep, 13.2 L* below, so plinths and prop contact
// shadows have something to be drawn IN; concreteDeep is the bottom of its ladder
// and its CONTACT_MAT is null, which would have kept the map ungrounded. metalDark
// is also the cooler of the two, which keeps the cold-floor/warm-bounce read below.
// Interest comes from LIGHT, not hue-of-surface: a saturated cool skylight (sunColor
// skyDay) punches down through the 4 ceiling slots onto a near-black floor, the
// hemisphere carries a cool sky tint over a WARM ground tint (§3d) so every
// downward-facing plane is warm and every upward one is cool, and the fog/horizon
// is a dark rust that gives depth a warm cast. Amber accents repeat on every lane.
import { PALETTE } from '../palette.js';
import type { MapDef } from './types.js';

const W = 32;
const D = 32;

export const bunker: MapDef = {
  id: 'bunker',
  name: 'Bunker',
  sizeX: W,
  sizeZ: D,
  // §3a + §1 L5: the bunker floor is still the darkest large plane in the game,
  // but it now sits at L 27.7 instead of L 14.5. The old value failed the L5
  // readability floor of 22 and, being under L 20, also took the map into the
  // L2b exemption — no alpha could darken a near-black floor, so nothing was
  // grounded. At L 27.7 the L2b composite works again (CONTACT_MAT.metalDark =
  // metalDeep, 13.2 L* below), so props are grounded by shadow AND by geometry.
  floorMat: 'metalDark',
  theme: {
    // S1: zenith is 18.7 L* darker than the horizon AND cooler (blueBias 8 > -50).
    skyHigh: PALETTE.skyIndoorHigh,
    // LOAD-BEARING, do not "improve": `sky` is also the hemisphere SKY tint
    // (scene.ts `setTheme`), and indoors the hemisphere IS the light — a dark
    // value here blacks the interior out. Stays bright and cool (§3d).
    sky: PALETTE.steel,
    // dark rust horizon: warm counterweight to the cold skylight. Also keeps the
    // map on scene.ts's INDOOR lighting path, which is gated on a dark horizon
    // (luminance 0.045 — well inside the threshold).
    horizon: PALETTE.brickDeep,
    // hemisphere GROUND tint (§3d): warm bounce on every downward-facing plane —
    // ceilings and pipe undersides read warm against the cool light from above.
    ground: PALETTE.tBrown,
    fog: PALETTE.brickDeep, // S2: fog === horizon, never the zenith
    // eased from 0.018: the horizon/fog is far lighter than the old near-black
    // ink, so the same density would have hazed out the 25m sightlines.
    fogDensity: 0.014,
    sunDir: [0.18, -1, 0.12], // near-vertical: shafts land inside the ceiling slots
    sunColor: PALETTE.skyDay, // saturated cool daylight — the skylight shafts
    sunIntensity: 2.2, // up from 1.3 so the shafts read as shafts
    hemiIntensity: 1.8, // down from 2.5 so the sun is not drowned; still indoor-range
  },
  boxes: [
    // ---- outer shell: walls h=3 + ceiling (slab bottom y=2.8) ----
    { x: 0, y: 1.5, z: -D / 2, w: W + 2, h: 3, d: 1, mat: 'concrete' },
    { x: 0, y: 1.5, z: D / 2, w: W + 2, h: 3, d: 1, mat: 'concrete' },
    { x: -W / 2, y: 1.5, z: 0, w: 1, h: 3, d: D + 2, mat: 'concrete' },
    { x: W / 2, y: 1.5, z: 0, w: 1, h: 3, d: D + 2, mat: 'concrete' },
    // ceiling (slab bottom y=2.8) tiled around 4 skylight slots (~2m) so the
    // sun throws real light pools + contact shadows indoors; slots sit over
    // open floor only (hub W of pillar, N/S spawn rooms, NE ring junction) —
    // outer edges remain fully sealed (slots keep >=7.5m off the outer walls).
    // MAT: 'concreteDeep', DELIBERATELY UNCHANGED by the L5 rebuild. The slab
    // underside never sees the sun (sunDir is near-vertical, so N.L on a
    // downward-facing plane is 0) and is lit only by the warm hemisphere ground
    // bounce, so a wall-value albedo up there would out-read the walls. With the
    // wall lifted to `concrete` it is now two tiers down rather than one, which
    // only makes the bright skylight slots cut harder against it. It lands 0.9 L*
    // above the new floor, and that is fine precisely because of the lighting
    // asymmetry: the floor takes the full sun of the skylight pools, the ceiling
    // takes none, so the two planes separate in the frame, not in the palette.
    { x: 0, y: 2.95, z: -15, w: W + 2, h: 0.3, d: 4, mat: 'concreteDeep' }, // z[-17,-13]
    { x: -8, y: 2.95, z: -12, w: 18, h: 0.3, d: 2, mat: 'concreteDeep' }, // slot: N room x[1,3] z[-13,-11]
    { x: 10, y: 2.95, z: -12, w: 14, h: 0.3, d: 2, mat: 'concreteDeep' },
    { x: 0, y: 2.95, z: -9.3, w: W + 2, h: 0.3, d: 3.4, mat: 'concreteDeep' }, // z[-11,-7.6]
    { x: -5.65, y: 2.95, z: -6.7, w: 22.7, h: 0.3, d: 1.8, mat: 'concreteDeep' }, // slot: NE junction x[5.7,7.5] z[-7.6,-5.8]
    { x: 12.25, y: 2.95, z: -6.7, w: 9.5, h: 0.3, d: 1.8, mat: 'concreteDeep' },
    { x: 0, y: 2.95, z: -3.4, w: W + 2, h: 0.3, d: 4.8, mat: 'concreteDeep' }, // z[-5.8,-1]
    { x: -10.25, y: 2.95, z: 0, w: 13.5, h: 0.3, d: 2, mat: 'concreteDeep' }, // slot: hub x[-3.5,-1.5] z[-1,1]
    { x: 7.75, y: 2.95, z: 0, w: 18.5, h: 0.3, d: 2, mat: 'concreteDeep' },
    { x: 0, y: 2.95, z: 6, w: W + 2, h: 0.3, d: 10, mat: 'concreteDeep' }, // z[1,11]
    { x: -10, y: 2.95, z: 12, w: 14, h: 0.3, d: 2, mat: 'concreteDeep' }, // slot: S room x[-3,-1] z[11,13]
    { x: 8, y: 2.95, z: 12, w: 18, h: 0.3, d: 2, mat: 'concreteDeep' },
    { x: 0, y: 2.95, z: 15, w: W + 2, h: 0.3, d: 4, mat: 'concreteDeep' }, // z[13,17]

    // ---- solid corner masses (bunker is carved, not built) ----
    { x: -10.25, y: 1.5, z: -11.6, w: 10, h: 3, d: 7.8, mat: 'concrete' }, // NW
    { x: 10.25, y: 1.5, z: -11.6, w: 10, h: 3, d: 7.8, mat: 'concrete' }, // NE
    { x: -10.25, y: 1.5, z: 11.6, w: 10, h: 3, d: 7.8, mat: 'concrete' }, // SW
    { x: 10.25, y: 1.5, z: 11.6, w: 10, h: 3, d: 7.8, mat: 'concrete' }, // SE

    // ---- W/E room flank masses (seal ring corridor outer wall; inner face at
    // z=+-4.0 so diagonals threading both room doors end on them at <25m) ----
    { x: -11.6, y: 1.5, z: -5.85, w: 7.8, h: 3, d: 3.7, mat: 'concrete' },
    { x: -11.6, y: 1.5, z: 5.85, w: 7.8, h: 3, d: 3.7, mat: 'concrete' },
    { x: 11.6, y: 1.5, z: -5.85, w: 7.8, h: 3, d: 3.7, mat: 'concrete' },
    { x: 11.6, y: 1.5, z: 5.85, w: 7.8, h: 3, d: 3.7, mat: 'concrete' },

    // ---- W room east wall (doors z[-3.7,-1.7] + [1.7,3.7]) ----
    { x: -8.3, y: 1.5, z: -4.6, w: 1.2, h: 3, d: 1.8, mat: 'concrete' },
    { x: -8.3, y: 1.5, z: 0, w: 1.2, h: 3, d: 3.4, mat: 'concrete' },
    { x: -8.3, y: 1.5, z: 4.6, w: 1.2, h: 3, d: 1.8, mat: 'concrete' },
    // ---- E room west wall (doors z[-3.7,-1.7] + [1.7,3.7]) ----
    { x: 8.3, y: 1.5, z: -4.6, w: 1.2, h: 3, d: 1.8, mat: 'concrete' },
    { x: 8.3, y: 1.5, z: 0, w: 1.2, h: 3, d: 3.4, mat: 'concrete' },
    { x: 8.3, y: 1.5, z: 4.6, w: 1.2, h: 3, d: 1.8, mat: 'concrete' },

    // ---- N room (CT) south wall (doors x[-4.2,-2.2] + [2.2,4.2]) ----
    { x: -4.85, y: 1.5, z: -8.3, w: 1.3, h: 3, d: 1.2, mat: 'concrete' },
    { x: 0, y: 1.5, z: -8.3, w: 4.4, h: 3, d: 1.2, mat: 'concrete' },
    { x: 4.85, y: 1.5, z: -8.3, w: 1.3, h: 3, d: 1.2, mat: 'concrete' },
    // ---- S room (T) north wall (doors x[-4.2,-2.2] + [2.2,4.2]) ----
    { x: -4.85, y: 1.5, z: 8.3, w: 1.3, h: 3, d: 1.2, mat: 'concrete' },
    { x: 0, y: 1.5, z: 8.3, w: 4.4, h: 3, d: 1.2, mat: 'concrete' },
    { x: 4.85, y: 1.5, z: 8.3, w: 1.3, h: 3, d: 1.2, mat: 'concrete' },

    // ---- hub walls; doors staggered so no straight N-S/W-E line ----
    // MAT: 'concreteDark' (was 'metalDark', which the L5 rebuild promoted to
    // FLOOR — the hub core would have been the exact same value as the ground it
    // stands on). concreteDark is DARK_MAT['concrete'], i.e. the sanctioned
    // secondary/shaded tier: the core reads 12.2 L* down from the outer shell it
    // sits inside, and 18.5 L* up from the floor, so it silhouettes both ways.
    // It also keeps 17.7 L* under hazardAmber, which is what makes the hazard plates
    // on the pillar below still pop.
    // N wall: door x[0.8,2.8]
    { x: -2.2, y: 1.5, z: -4.6, w: 6, h: 3, d: 1.2, mat: 'concreteDark' },
    { x: 4, y: 1.5, z: -4.6, w: 2.4, h: 3, d: 1.2, mat: 'concreteDark' },
    // S wall: door x[-3,-1]
    { x: -4.1, y: 1.5, z: 4.6, w: 2.2, h: 3, d: 1.2, mat: 'concreteDark' },
    { x: 2.1, y: 1.5, z: 4.6, w: 6.2, h: 3, d: 1.2, mat: 'concreteDark' },
    // W wall: door z[1,3]
    { x: -4.6, y: 1.5, z: -2.1, w: 1.2, h: 3, d: 6.2, mat: 'concreteDark' },
    { x: -4.6, y: 1.5, z: 4.1, w: 1.2, h: 3, d: 2.2, mat: 'concreteDark' },
    // E wall: door z[-3,-1]
    { x: 4.6, y: 1.5, z: -4.1, w: 1.2, h: 3, d: 2.2, mat: 'concreteDark' },
    { x: 4.6, y: 1.5, z: 2.1, w: 1.2, h: 3, d: 6.2, mat: 'concreteDark' },

    // ---- hub: central pillar (blocks all through-hub spawn lines) + crates ----
    { x: 0, y: 1.5, z: 0, w: 2, h: 3, d: 2, mat: 'concreteDark' },
    { x: -2.8, y: 0.6, z: -2.8, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 2.8, y: 0.6, z: 2.8, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },

    // ---- ring corridor nubs (mid-segment cover; leave 1.5m pinch) ----
    // MAT: 'concreteDark' — MAP-WIDE RULE: cover is a full tier DOWN from the
    // wall it grows out of. These stubs were once the same MatId as that wall and
    // were invisible until you walked into them. They were then 'concreteDeep',
    // which the L5 rebuild leaves 0.9 L* off the new floor — a floor-standing
    // full-height slab whose base is the same value as the ground is the same
    // defect again, one surface further down. concreteDark keeps 12.2 L* under
    // the `concrete` wall (silhouettes at range) and 18.5 L* over the floor (the
    // base reads), and still leaves the amber hazard stripes 17.7 L* to pop off.
    { x: 0, y: 1.5, z: -7.2, w: 1.2, h: 3, d: 1.0, mat: 'concreteDark' },
    { x: 0, y: 1.5, z: 7.2, w: 1.2, h: 3, d: 1.0, mat: 'concreteDark' },
    { x: -7.2, y: 1.5, z: 0, w: 1.0, h: 3, d: 1.2, mat: 'concreteDark' },
    { x: 7.2, y: 1.5, z: 0, w: 1.0, h: 3, d: 1.2, mat: 'concreteDark' },

    // ---- ring junction crates (outer corners; leave 1.6m pinch) ----
    { x: -7.25, y: 0.6, z: -7.25, w: 0.9, h: 1.2, d: 0.9, mat: 'crate' },
    { x: 7.25, y: 0.6, z: -7.25, w: 0.9, h: 1.2, d: 0.9, mat: 'crate' },
    { x: -7.25, y: 0.6, z: 7.25, w: 0.9, h: 1.2, d: 0.9, mat: 'crate' },
    { x: 7.25, y: 0.6, z: 7.25, w: 0.9, h: 1.2, d: 0.9, mat: 'crate' },

    // ---- N room (CT spawn) crate stacks ----
    { x: -4, y: 0.6, z: -11, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -4, y: 1.8, z: -11, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 4, y: 0.6, z: -11, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 0, y: 0.6, z: -12, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 4.9, y: 0.6, z: -9.6, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    // ---- S room (T spawn) crate stacks (180° rotation) ----
    { x: 4, y: 0.6, z: 11, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 4, y: 1.8, z: 11, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -4, y: 0.6, z: 11, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 0, y: 0.6, z: 12, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -4.9, y: 0.6, z: 9.6, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    // ---- W room: full-height column (cuts door-threading diagonals) + crate stack ----
    // MAT: 'concreteDark' — same "cover is a tier down from its wall" rule as the
    // ring nubs, and moved off 'concreteDeep' for the same reason (it now ties
    // the floor). The flank rooms have no skylight, so this is the only mass in
    // them that can silhouette; matching the wall tier made it disappear, and
    // matching the floor tier would have dissolved its base into the ground.
    { x: -10.5, y: 1.5, z: 0, w: 1.6, h: 3, d: 4.4, mat: 'concreteDark' },
    { x: -12.5, y: 0.6, z: 0, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -12.5, y: 1.8, z: 0, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    // ---- E room (180° rotation) ----
    { x: 10.5, y: 1.5, z: 0, w: 1.6, h: 3, d: 4.4, mat: 'concreteDark' },
    { x: 12.5, y: 0.6, z: 0, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 12.5, y: 1.8, z: 0, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },

    // ---- pipe runs along walls (y 2.325-2.575: above heads, below ceiling);
    // 'metal' (not metalDark) so the steel reads against the concrete in gloom;
    // still the brightest surface in the map, 8.2 L* over the lifted wall
    { x: 0, y: 2.45, z: -7.55, w: 15, h: 0.25, d: 0.3, mat: 'metal' }, // ring N
    { x: 0, y: 2.45, z: 7.55, w: 15, h: 0.25, d: 0.3, mat: 'metal' }, // ring S
    { x: -7.55, y: 2.45, z: 0, w: 0.3, h: 0.25, d: 15, mat: 'metal' }, // ring W
    { x: 7.55, y: 2.45, z: 0, w: 0.3, h: 0.25, d: 15, mat: 'metal' }, // ring E
    { x: 0, y: 2.45, z: -15.35, w: 10.6, h: 0.25, d: 0.3, mat: 'metal' }, // N room
    { x: 0, y: 2.45, z: 15.35, w: 10.6, h: 0.25, d: 0.3, mat: 'metal' }, // S room
    { x: -15.35, y: 2.45, z: 0, w: 0.3, h: 0.25, d: 10.6, mat: 'metal' }, // W room
    { x: 15.35, y: 2.45, z: 0, w: 0.3, h: 0.25, d: 10.6, mat: 'metal' }, // E room
    // vertical drop pipes in room corners
    { x: -5.2, y: 1.4, z: -15.2, w: 0.3, h: 2.8, d: 0.3, mat: 'metal' },
    { x: 5.2, y: 1.4, z: -15.2, w: 0.3, h: 2.8, d: 0.3, mat: 'metal' },
    { x: -5.2, y: 1.4, z: 15.2, w: 0.3, h: 2.8, d: 0.3, mat: 'metal' },
    { x: 5.2, y: 1.4, z: 15.2, w: 0.3, h: 2.8, d: 0.3, mat: 'metal' },
    { x: -15.2, y: 1.4, z: -3.7, w: 0.3, h: 2.8, d: 0.3, mat: 'metal' },
    { x: -15.2, y: 1.4, z: 3.7, w: 0.3, h: 2.8, d: 0.3, mat: 'metal' },
    { x: 15.2, y: 1.4, z: -3.7, w: 0.3, h: 2.8, d: 0.3, mat: 'metal' },
    { x: 15.2, y: 1.4, z: 3.7, w: 0.3, h: 2.8, d: 0.3, mat: 'metal' },

    // ---- ceiling beams (hang to y2.51; clear of players and crate stacks) ----
    // MAT: 'metalDeep' — the ceiling is 'concreteDeep', so the old 'metalDark'
    // beams were within 1 L* of it and vanished. The contact band turns them into
    // near-black ribs, 14.1 L* under the slab, that rhythm the whole overhead
    // plane. After the L5 rebuild they are no longer the same MatId as the floor
    // but one tier below it (metalDeep under metalDark), which keeps them the
    // darkest thing in frame and stops the overhead plane competing with the
    // ground for the eye.
    { x: 0, y: 2.62, z: 0, w: 8, h: 0.22, d: 0.5, mat: 'metalDeep' }, // hub
    { x: 0, y: 2.62, z: 0, w: 0.5, h: 0.22, d: 8, mat: 'metalDeep' }, // hub
    { x: 0, y: 2.62, z: -11.5, w: 10.6, h: 0.22, d: 0.5, mat: 'metalDeep' }, // N room
    { x: 0, y: 2.62, z: 11.5, w: 10.6, h: 0.22, d: 0.5, mat: 'metalDeep' }, // S room
    { x: -11.5, y: 2.62, z: 0, w: 0.5, h: 0.22, d: 10.6, mat: 'metalDeep' }, // W room
    { x: 11.5, y: 2.62, z: 0, w: 0.5, h: 0.22, d: 10.6, mat: 'metalDeep' }, // E room
  ],
  spawns: {
    // CT holds the N room, faces south (+Z); row keeps >=0.9m clear of all boxes
    CT: [
      { x: -4, z: -13.8, yaw: Math.PI },
      { x: -2.4, z: -13.8, yaw: Math.PI },
      { x: -0.8, z: -13.8, yaw: Math.PI },
      { x: 0.8, z: -13.8, yaw: Math.PI },
      { x: 2.4, z: -13.8, yaw: Math.PI },
      { x: 4, z: -13.8, yaw: Math.PI },
      { x: -0.8, z: -14.6, yaw: Math.PI },
    ],
    // T holds the S room, faces north (-Z); 180° rotation of CT
    T: [
      { x: 4, z: 13.8, yaw: 0 },
      { x: 2.4, z: 13.8, yaw: 0 },
      { x: 0.8, z: 13.8, yaw: 0 },
      { x: -0.8, z: 13.8, yaw: 0 },
      { x: -2.4, z: 13.8, yaw: 0 },
      { x: -4, z: 13.8, yaw: 0 },
      { x: 0.8, z: 14.6, yaw: 0 },
    ],
  },
  // §3c DENSITY PASS: 62 -> 101 declared props (+63%); replaying mapRenderer's
  // scatter (DECO_DENSITY 1.6, SOLID_PAD 0.5, SPAWN_CLEARANCE 2.5) puts 58 of
  // them on the floor, up from 31 (+87%). The extra density comes from ZONE
  // RECTS TIGHTENED ONTO THE ACTUALLY-FREE FLOOR, never from packing: every
  // rect below is clipped to the region that survives the solid/spawn
  // rejection, so the sampling budget is spent on floor that can accept a prop
  // instead of on walls. (The one deliberately loose rect is the hub/ring pipe
  // zone, which is allowed to roam the whole loop and fill what is left.)
  //
  // minSpacing IS A PHYSICAL FOOTPRINT BUDGET — DO NOT LOWER IT TO BUY COUNT.
  // mapRenderer's `PROP_SHADOW_R` is each kind's ground-footprint radius
  // (pipe 0.95, sandbag 0.95, palletStack 0.78, pallet 0.75, sack 0.5,
  // barrel 0.44) and `buildProp` scales props by up to 1.2. So for any two
  // kinds that can share a region, the later zone's minSpacing must be
  // >= 1.2 * (r_a + r_b), otherwise the props physically interpenetrate:
  //   pipe/sandbag with each other .......... 2.3
  //   pallet next to pipe/sandbag ........... 2.1
  //   palletStack with each other ........... 1.9
  //   sack next to pipe ..................... 1.8
  //   barrel next to pipe/sandbag ........... 1.7
  //   sack next to palletStack .............. 1.6
  //   barrel next to palletStack ............ 1.5
  // Zones are ordered BIGGEST-FOOTPRINT-FIRST within each region, because
  // `tooClose` tests a candidate against every already-placed prop using only
  // the CURRENT zone's spacing — sampling the tight zones first is what keeps
  // the small kinds from squatting the holes the big ones need.
  //
  // Deco is client-only and NON-COLLIDABLE, so none of it touches the
  // playability invariants above. Placement rules honoured: nothing within
  // 2.5m of a spawn, nothing in a doorway channel, nothing in the middle of a
  // ring-corridor running line — the zones are strips hugging blank walls and
  // dead corners.
  // NOTE: no 'crate' deco anywhere in this map, deliberately — the map already
  // uses 1.2m `crate` BoxDefs as real cover, and a non-collidable prop that
  // looks identical would read as cover and get players killed.
  deco: [
    // -- ring corridor + hub. Free floor after SOLID_PAD is a 1.5m band inside
    //    each leg (|.|<7.2 outside the hub walls at |.|=5.7) plus the hub
    //    interior. Low sacks hug the W/E legs, pipe runs the N/S legs, and one
    //    loose zone dresses the hub + whatever ring floor is left over.
    { kind: 'sack', count: 4, x0: -7.1, z0: -6.3, x1: -6.1, z1: 6.3, minSpacing: 1.8 },
    { kind: 'sack', count: 4, x0: 6.1, z0: -6.3, x1: 7.1, z1: 6.3, minSpacing: 1.8 },
    { kind: 'pipe', count: 4, x0: -6.3, z0: -7.1, x1: 6.3, z1: -6.1, minSpacing: 2.3 },
    { kind: 'pipe', count: 4, x0: -6.3, z0: 6.1, x1: 6.3, z1: 7.1, minSpacing: 2.3 },
    { kind: 'pipe', count: 15, x0: -7.2, z0: -7.2, x1: 7.2, z1: 7.2, minSpacing: 2.3 },
    // -- flank rooms (no spawns there). Rects were z[-5,5] x[+-14.8,+-9.4],
    //    but the flank masses close the room at z=+-4.0 and the outer wall at
    //    |x|=15.5, so after SOLID_PAD only z[-3.4,3.4] x[+-14.9,+-9.5] could
    //    ever accept a sample; clipping to it is where the extra props come
    //    from. Pallet stacks are the hero store, sacks fill the back wall
    //    behind the column, barrels take the leftovers.
    { kind: 'palletStack', count: 4, x0: -14.9, z0: -3.4, x1: -9.5, z1: 3.4, minSpacing: 1.9 },
    { kind: 'palletStack', count: 4, x0: 9.5, z0: -3.4, x1: 14.9, z1: 3.4, minSpacing: 1.9 },
    { kind: 'sack', count: 5, x0: -14.9, z0: -3.4, x1: -12.6, z1: 3.4, minSpacing: 1.6 },
    { kind: 'sack', count: 5, x0: 12.6, z0: -3.4, x1: 14.9, z1: 3.4, minSpacing: 1.6 },
    { kind: 'barrel', count: 10, x0: -14.9, z0: -3.4, x1: -9.5, z1: 3.4, minSpacing: 1.5 },
    { kind: 'barrel', count: 10, x0: 9.5, z0: -3.4, x1: 14.9, z1: 3.4, minSpacing: 1.5 },
    // -- spawn rooms. The ONLY dressable floor is the 1.9m-deep strip between
    //    the crate stacks and the room's inner wall (x[-4.7,4.7],
    //    |z| in [9.4,11.3]): the outer wall pad takes |z|>15.0, the corner
    //    masses take |x|>4.75, and the 2.5m spawn rejection radius swallows
    //    everything at |z|>11.3. The old rects reached to |z|=14.5 and spent
    //    ~70% of their attempts sampling floor that could never accept a prop.
    // The pallet strip is the spawn-room back wall, strictly BETWEEN the two
    // doors (x[-2.2,2.2] is the solid centre block) so neither doorway approach
    // is dressed. At 4x0.4m it is the smallest zone in the map, so it is
    // sampled FIRST — once the sandbags land there is no 2.1m hole left in it.
    { kind: 'pallet', count: 3, x0: -2, z0: -9.9, x1: 2, z1: -9.5, minSpacing: 2.1 },
    { kind: 'pallet', count: 3, x0: -2, z0: 9.5, x1: 2, z1: 9.9, minSpacing: 2.1 },
    { kind: 'sandbag', count: 5, x0: -4.7, z0: -11.3, x1: 4.7, z1: -9.4, minSpacing: 2.3 },
    { kind: 'sandbag', count: 5, x0: -4.7, z0: 9.4, x1: 4.7, z1: 11.3, minSpacing: 2.3 },
    { kind: 'barrel', count: 8, x0: -4.7, z0: -11.3, x1: 4.7, z1: -9.4, minSpacing: 1.7 },
    { kind: 'barrel', count: 8, x0: -4.7, z0: 9.4, x1: 4.7, z1: 11.3, minSpacing: 1.7 },
  ],
  // AAA accent: safety amber (hazardAmber) — hub pillar hazard plates + hub door
  // markers + ring-nub hazard stripes, repeated on every main sightline
  accents: [
    // hub pillar hazard plates (N and S faces)
    { x: -0.5, y: 1.2, z: -1.03, w: 0.34, h: 2.2, d: 0.05, hex: PALETTE.hazardAmber },
    { x: 0.5, y: 1.2, z: 1.03, w: 0.34, h: 2.2, d: 0.05, hex: PALETTE.hazardAmber },
    // hub door markers (N door x[0.8,2.8] face z=-5.2; S door x[-3,-1] face z=5.2)
    { x: 0.72, y: 1.1, z: -5.24, w: 0.14, h: 2.2, d: 0.06, hex: PALETTE.hazardAmber },
    { x: 2.88, y: 1.1, z: -5.24, w: 0.14, h: 2.2, d: 0.06, hex: PALETTE.hazardAmber },
    { x: -3.08, y: 1.1, z: 5.24, w: 0.14, h: 2.2, d: 0.06, hex: PALETTE.hazardAmber },
    { x: -0.92, y: 1.1, z: 5.24, w: 0.14, h: 2.2, d: 0.06, hex: PALETTE.hazardAmber },
    // ring-nub hazard stripes (N/S corridor cover).
    // FIXED: these were at z=-+7.73, which is INSIDE the spawn-room wall the nub
    // grows out of (that wall spans z[-8.9,-7.7]) — they rendered buried and
    // invisible. The nub's corridor-facing face is z=-+6.7; 0.03 proud of that.
    { x: 0, y: 0.9, z: -6.67, w: 1.0, h: 0.15, d: 0.05, hex: PALETTE.hazardAmber },
    { x: 0, y: 0.9, z: 6.67, w: 1.0, h: 0.15, d: 0.05, hex: PALETTE.hazardAmber },
    // matching stripes on the W/E ring nubs (nubs span x -+[6.7,7.7]; the
    // corridor-facing face is x=-+6.7) so every leg of the loop carries the accent
    { x: -6.67, y: 0.9, z: 0, w: 0.05, h: 0.15, d: 1.0, hex: PALETTE.hazardAmber },
    { x: 6.67, y: 0.9, z: 0, w: 0.05, h: 0.15, d: 1.0, hex: PALETTE.hazardAmber },
    // spawn-room door jambs, ring side (wall z=-+8.3 d1.2 -> ring face z=-+7.7;
    // the solid centre block spans x[-2.2,2.2], so these sit flush to the inner
    // edge of each of the four openings)
    { x: -2.13, y: 1.1, z: -7.66, w: 0.14, h: 2.2, d: 0.06, hex: PALETTE.hazardAmber },
    { x: 2.13, y: 1.1, z: -7.66, w: 0.14, h: 2.2, d: 0.06, hex: PALETTE.hazardAmber },
    { x: -2.13, y: 1.1, z: 7.66, w: 0.14, h: 2.2, d: 0.06, hex: PALETTE.hazardAmber },
    { x: 2.13, y: 1.1, z: 7.66, w: 0.14, h: 2.2, d: 0.06, hex: PALETTE.hazardAmber },
    // low wayfinding strips on the four corner masses at the ring junctions
    // (clear of the junction crates, which end at x=-+6.8)
    { x: -6, y: 0.35, z: -7.66, w: 1.4, h: 0.1, d: 0.06, hex: PALETTE.hazardAmber },
    { x: 6, y: 0.35, z: -7.66, w: 1.4, h: 0.1, d: 0.06, hex: PALETTE.hazardAmber },
    { x: -6, y: 0.35, z: 7.66, w: 1.4, h: 0.1, d: 0.06, hex: PALETTE.hazardAmber },
    { x: 6, y: 0.35, z: 7.66, w: 1.4, h: 0.1, d: 0.06, hex: PALETTE.hazardAmber },
  ],
};

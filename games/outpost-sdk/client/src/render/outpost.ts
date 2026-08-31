// ============================================================================
// ART 3/6 — STRUCTURES. buildOutpost() => the tower, stairs, fence line (all
// three damage states), gate, corner watch-posts, and the two findable buy
// stations (weapon rack, ammo crate).
//
// GEOMETRY LAW: every collidable piece here is derived from the SAME exported
// constants map.ts uses to build STATIC_SOLIDS (TOWER_HALF, FOOTING_H,
// DECK1_Y, DECK2_Y, SLAB_H, PARAPET_H/T, STAIR_*, STAIRWELL, FENCE_HALF,
// SEG_LEN, SEGMENTS, FENCE.*) — never a hand-copied literal — so the rendered
// footprint can never silently drift from what stepBody actually collides
// with. The palisade timbers, rails and sheet stay INSIDE the segment's
// collision footprint (SEG_LEN x FENCE.thickness x FENCE.height); only free
// decoration (pointed tips, jitter, sandbags on the firing step) is allowed
// to read slightly proud of it, exactly as a real palisade would.
//
// FENCE STATE: `setSegment` never rebuilds geometry. Each of the 16 segments
// pre-bakes THREE variants (intact / damaged / breached) once at construction
// and the tick handler only flips `.visible` — see `buildAllSegments`.
//
// The firing step itself (the actual collidable sandbag slab from
// fenceBoxes()) is STATIC furniture, not part of any hp-state variant: it
// never breaches, so it is built once in `buildFenceFurniture` and stays on
// screen through every fence state, exactly like the real collision box does.
// ============================================================================
import * as THREE from 'three';
import { PLAYER, WEAPON_ORDER } from '@fps/shared';
import {
  DECK1_Y,
  DECK2_Y,
  ECONOMY,
  FENCE,
  FENCE_HALF,
  FEATURES,
  FOOTING_H,
  MAT_COLORS,
  PARAPET_H,
  PARAPET_T,
  PALETTE,
  SEGMENTS,
  SEG_LEN,
  SLAB_H,
  STAIRWELL,
  STAIR_OUTER_Z,
  STAIR_RISE,
  STAIR_RUN,
  STAIR_STEPS,
  STAIR_WIDTH,
  TOWER_HALF,
  UPPER_RUN_START_Z,
} from '@outpost/shared';
import type { MatColors, SegmentGeom, SegmentId, Side } from '@outpost/shared';
import {
  articulate,
  at,
  bake,
  box,
  cone,
  contactShadow,
  cyl,
  COPLANAR_EPS,
  vrng,
} from '../contract/visual.js';

// ---------------------------------------------------------------------------
// Public shape (CONTRACT.md render/outpost.ts)
// ---------------------------------------------------------------------------

export interface OutpostBuild {
  root: THREE.Group;
  /** Called every frame with each segment's 0..1 health so the fence shows its state. */
  setSegment(id: SegmentId, hp01: number, breached: boolean, rebuild: number): void;
  /** Sub-group of the segment, for FX anchoring. */
  segmentAnchor(id: SegmentId): THREE.Object3D;
  animate(t: number): void;
}

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

type Animator = (t: number) => void;

const H = TOWER_HALF;
/** Deterministic cosmetic seed. Never Math.random — see CONTRACT.md. */
const SEED = 90210;

function req(hex: string | null, fallback: string): string {
  return hex ?? fallback;
}

/** MatKind -> the four-tier set, with the null-safe fallbacks this file needs. */
function ladder(mk: keyof typeof MAT_COLORS): { body: string; trim: string; dark: string; contact: string } {
  const c: MatColors = MAT_COLORS[mk];
  return { body: c.body, trim: req(c.trim, c.body), dark: req(c.dark, c.body), contact: req(c.contact, c.dark ?? c.body) };
}

/** A box whose LOCAL +Z-length axis is stretched to run from `from` to `to` — used
 *  for every diagonal/angled member (stair stringers+rail, knee-braces, guy-wires)
 *  instead of hand-derived per-axis trig, which is where sign errors live. */
function alignedBar(crossW: number, crossH: number, from: THREE.Vector3, to: THREE.Vector3, hex: string): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = Math.max(0.01, dir.length());
  const m = box(crossW, crossH, len, hex);
  const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
  m.position.copy(mid);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.normalize());
  return m;
}

function feature(key: string): { x: number; y: number; z: number } {
  const f = FEATURES.find((p) => p.key === key);
  return f ? { x: f.x, y: f.y, z: f.z } : { x: 0, y: 0, z: 0 };
}

/** True for the north/south sides, where the segment's long (10 m) axis is world X. */
function segHoriz(seg: SegmentGeom): boolean {
  return seg.side === 'north' || seg.side === 'south';
}

/** Segment-local point -> world point. `along` runs the 10 m span, `across` runs
 *  OUTWARD along the segment's normal (negative = inward, into the compound). */
function segPoint(seg: SegmentGeom, along: number, across: number, y: number): THREE.Vector3 {
  return segHoriz(seg)
    ? new THREE.Vector3(seg.cx + along, y, seg.cz + across * seg.nz)
    : new THREE.Vector3(seg.cx + across * seg.nx, y, seg.cz + along);
}

/** w/d for a box whose long dimension (`alongLen`) runs the segment's wall axis
 *  and whose short dimension (`acrossLen`) runs its outward-normal axis. */
function segWD(seg: SegmentGeom, alongLen: number, acrossLen: number): { w: number; d: number } {
  return segHoriz(seg) ? { w: alongLen, d: acrossLen } : { w: acrossLen, d: alongLen };
}

/** Small canvas-texture label — a world-space price/name placard. `MeshBasicMaterial`
 *  is the STYLE_BIBLE's explicit exception for light-pool decals / emissive quads;
 *  this is the same idiom applied to text. Every colour drawn on it is a PALETTE key. */
function makeLabelPlane(text: string, w: number, h: number): THREE.Mesh {
  const cw = 512;
  const ch = 128;
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = PALETTE.ink;
    ctx.globalAlpha = 0.78;
    ctx.fillRect(0, 0, cw, ch);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = PALETTE.hudAccent;
    ctx.lineWidth = 6;
    ctx.strokeRect(4, 4, cw - 8, ch - 8);
    ctx.fillStyle = PALETTE.hudAccent;
    ctx.font = 'bold 40px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cw / 2, ch / 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

/** A small flickering flame (torchCore body, emberGlow emissive) — pooled into the
 *  `animators` list the caller drives every frame. Never baked (bake() only ever
 *  sees the STATIC group; every caller here adds the flame straight to the live
 *  dynamic root instead). */
function addFlame(dynamicRoot: THREE.Group, animators: Animator[], x: number, y: number, z: number, scale: number, seed: number): void {
  const flame = cone(0.05 * scale, 0.16 * scale, 6, PALETTE.torchCore, { emissive: PALETTE.emberGlow });
  at(flame, x, y, z);
  dynamicRoot.add(flame);
  const bx = flame.scale.x;
  const by = flame.scale.y;
  const bz = flame.scale.z;
  animators.push((t) => {
    const k = 0.82 + 0.22 * Math.sin(t * 9.3 + seed) * Math.sin(t * 3.1 + seed * 1.7);
    flame.scale.set(bx * (0.88 + 0.12 * Math.sin(t * 13 + seed)), by * Math.max(0.4, k), bz * (0.88 + 0.12 * Math.cos(t * 11 + seed)));
  });
}

// ---------------------------------------------------------------------------
// buildOutpost
// ---------------------------------------------------------------------------

export function buildOutpost(): OutpostBuild {
  const root = new THREE.Group();
  const staticGroup = new THREE.Group();
  const dynamicGroup = new THREE.Group();
  const rand = vrng(SEED);
  const animators: Animator[] = [];

  buildTower(staticGroup, dynamicGroup, animators, rand);
  buildWeaponRack(staticGroup, dynamicGroup, rand);
  buildAmmoCrate(staticGroup, dynamicGroup, rand);
  buildFenceFurniture(staticGroup, rand);

  root.add(bake(staticGroup));
  root.add(dynamicGroup);

  const segments = buildAllSegments(root, rand);

  return {
    root,
    setSegment(id, hp01, breached, _rebuild) {
      const rec = segments.get(id);
      if (!rec) return;
      const target: SegState = breached ? 'breached' : hp01 < 0.6 ? 'damaged' : 'intact';
      if (target === rec.shown) return;
      rec.variants[rec.shown].visible = false;
      rec.variants[target].visible = true;
      rec.shown = target;
    },
    segmentAnchor(id) {
      const rec = segments.get(id);
      return rec ? rec.anchor : root;
    },
    animate(t) {
      for (const fn of animators) fn(t);
    },
  };
}

// ---------------------------------------------------------------------------
// Tower — footing, decks, posts, parapets, stairs, tower-top decoration
// ---------------------------------------------------------------------------

function buildTower(g: THREE.Group, dyn: THREE.Group, animators: Animator[], rand: () => number): void {
  buildFooting(g, rand);
  buildDecks(g);
  buildDeckPlanking(g);
  buildDeckUndersides(g);
  buildPosts(g);
  buildParapets(g, rand);
  buildStairRun(g, 0, STAIR_OUTER_Z, 1, 5);
  buildStairRun(g, DECK1_Y, UPPER_RUN_START_Z, 1, 8);
  buildTowerTopside(g, dyn, animators, rand);
}

function buildFooting(g: THREE.Group, rand: () => number): void {
  const st = ladder('stone');
  g.add(at(box(H * 2, FOOTING_H, H * 2, st.body), 0, FOOTING_H / 2, 0));
  // rubble course: chunks proud of the footing edge, breaking the flat-slab read
  const n = 10;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand() * 0.3;
    const r = H + 0.15 + rand() * 0.25;
    const s = 0.22 + rand() * 0.16;
    const hex = i % 2 === 0 ? st.trim : st.dark;
    const chunk = box(s, s * (0.6 + rand() * 0.5), s, hex);
    at(chunk, Math.cos(a) * r, s * 0.3, Math.sin(a) * r);
    chunk.rotation.y = rand() * Math.PI;
    g.add(chunk);
  }
}

function buildDecks(g: THREE.Group): void {
  const tm = ladder('timber');
  g.add(at(box(H * 2, SLAB_H, H * 2, tm.body), 0, DECK1_Y - SLAB_H / 2, 0));
  const sw = STAIRWELL;
  const y2 = DECK2_Y - SLAB_H / 2;
  g.add(at(box(H * 2, SLAB_H, sw.minZ + H, tm.body), 0, y2, (-H + sw.minZ) / 2));
  g.add(at(box(H * 2, SLAB_H, H - sw.maxZ, tm.body), 0, y2, (sw.maxZ + H) / 2));
  g.add(at(box(sw.minX + H, SLAB_H, sw.maxZ - sw.minZ, tm.body), (-H + sw.minX) / 2, y2, (sw.minZ + sw.maxZ) / 2));
  g.add(at(box(H - sw.maxX, SLAB_H, sw.maxZ - sw.minZ, tm.body), (sw.maxX + H) / 2, y2, (sw.minZ + sw.maxZ) / 2));
}

/** Individually-jittered plank lines on both decks — a hair proud of the slab
 *  top face (COPLANAR_EPS+) so they never share a plane with it. */
function buildDeckPlanking(g: THREE.Group): void {
  const tm = ladder('timber');
  const y = COPLANAR_EPS + 0.015;
  const n = 10;
  for (let i = 0; i < n; i++) {
    const z = -H + ((i + 0.5) / n) * H * 2;
    const jw = H * 2 - 0.35;
    const hex = i % 2 === 0 ? tm.trim : tm.body;
    g.add(at(box(jw, 0.03, H * 2 * 0.9 * (1 / n), hex), 0, DECK1_Y + y, z));
  }
  const sw = STAIRWELL;
  const halves: Array<[number, number]> = [
    [-H, sw.minZ],
    [sw.maxZ, H],
  ];
  for (const [z0, z1] of halves) {
    const span = z1 - z0;
    const m = 4;
    for (let i = 0; i < m; i++) {
      const z = z0 + ((i + 0.5) / m) * span;
      const hex = i % 2 === 0 ? tm.body : tm.trim;
      g.add(at(box(H * 2 - 0.35, 0.03, (span / m) * 0.9, hex), 0, DECK2_Y + y, z));
    }
  }
}

/** The ~35% of interior framing the model sheet calls out by name: a joist grid
 *  under both decks with bracket plates at the joins, so the ground floor's
 *  ceiling (and the underside a deck-1 player looks up at) reads as built
 *  structure instead of a flat dark slab. */
function buildDeckUndersides(g: THREE.Group): void {
  const tm = ladder('timber');
  for (const deckTop of [DECK1_Y, DECK2_Y]) {
    const y = deckTop - SLAB_H - COPLANAR_EPS - 0.04;
    for (let i = -1; i <= 1; i++) {
      g.add(at(box(H * 2 - 0.2, 0.16, 0.22, tm.dark), 0, y, i * H * 0.9));
      g.add(at(box(0.22, 0.16, H * 2 - 0.2, tm.dark), i * H * 0.9, y, 0));
    }
    for (const ix of [-1, 0, 1]) {
      for (const iz of [-1, 0, 1]) {
        g.add(at(box(0.3, 0.06, 0.3, tm.trim), ix * H * 0.9, y - 0.11, iz * H * 0.9));
      }
    }
  }
}

function buildPosts(g: THREE.Group): void {
  const td = ladder('timberDark');
  const st = ladder('steel');
  const POSTS: ReadonlyArray<readonly [number, number]> = [
    [-H + 0.6, -H + 0.6],
    [H - 0.6, -H + 0.6],
    [-H + 0.6, H - 0.6],
    [H - 0.6, H - 0.6],
    [-H + 0.6, 0],
    [H - 0.6, 0],
    [-(STAIR_WIDTH / 2 + 0.9), H - 1.4],
    [STAIR_WIDTH / 2 + 0.9, H - 1.4],
    [0, -H + 0.6],
  ];
  const lowerY = (FOOTING_H + DECK1_Y - SLAB_H) / 2;
  const lowerH = DECK1_Y - SLAB_H - FOOTING_H;
  const upperY = (DECK1_Y + DECK2_Y - SLAB_H) / 2;
  const upperH = DECK2_Y - SLAB_H - DECK1_Y;

  for (let i = 0; i < POSTS.length; i++) {
    const p = POSTS[i];
    if (!p) continue;
    const [px, pz] = p;
    g.add(at(box(0.8, lowerH, 0.8, td.body), px, lowerY, pz));
    g.add(at(box(0.8, upperH, 0.8, td.body), px, upperY, pz));
    // bracket plate where each post meets its slab — hung a hair proud of the
    // underside (not flush with it) so its own bottom face never shares the
    // slab's bottom plane (see COPLANAR_EPS discipline in visual.ts)
    g.add(at(box(0.94, 0.08, 0.94, st.body), px, DECK1_Y - SLAB_H - 0.02, pz));
    g.add(at(box(0.94, 0.08, 0.94, st.body), px, DECK2_Y - SLAB_H - 0.02, pz));
    // corner posts (first four) get diagonal knee-braces at both levels
    if (i < 4) {
      const inX = px > 0 ? -1 : 1;
      const inZ = pz > 0 ? -1 : 1;
      const lowFrom = new THREE.Vector3(px, DECK1_Y - SLAB_H - 0.05, pz);
      const lowTo = new THREE.Vector3(px + inX * 1.1, DECK1_Y - SLAB_H - 0.9, pz + inZ * 1.1);
      g.add(alignedBar(0.12, 0.1, lowFrom, lowTo, td.dark));
      const upFrom = new THREE.Vector3(px, DECK2_Y - SLAB_H - 0.05, pz);
      const upTo = new THREE.Vector3(px + inX * 1.1, DECK2_Y - SLAB_H - 0.9, pz + inZ * 1.1);
      g.add(alignedBar(0.12, 0.1, upFrom, upTo, td.dark));
    }
  }
}

function buildParapets(g: THREE.Group, rand: () => number): void {
  const tm = ladder('timber');
  const rustLadder = ladder('rust');
  const rail = (deckY: number, gap: Side | null, rustPatches: boolean): void => {
    const sides: Array<[Side, number, number, number, number]> = [
      ['north', 0, -H + PARAPET_T / 2, H * 2, PARAPET_T],
      ['south', 0, H - PARAPET_T / 2, H * 2, PARAPET_T],
      ['west', -H + PARAPET_T / 2, 0, PARAPET_T, H * 2],
      ['east', H - PARAPET_T / 2, 0, PARAPET_T, H * 2],
    ];
    for (const [side, px, pz, w, d] of sides) {
      const horiz = side === 'north' || side === 'south';
      if (side === gap) {
        const doorway = STAIR_WIDTH + 2 * PLAYER.radius;
        const solid = (H * 2 - doorway) / 2;
        const off = doorway / 2 + solid / 2;
        for (const s of [-1, 1]) {
          const bx = horiz ? s * off : px;
          const bz = horiz ? pz : s * off;
          const bw = horiz ? solid : w;
          const bd = horiz ? d : solid;
          const wall = box(bw, PARAPET_H, bd, tm.body);
          g.add(at(wall, bx, deckY + PARAPET_H / 2, bz));
          const artG = articulate(bw, PARAPET_H, bd, { body: tm.body, trim: tm.trim, dark: tm.dark, contact: tm.contact }, { plinthH: 0.14, corniceH: 0.1, pilasterEvery: 2.4 });
          g.add(at(artG, bx, deckY + PARAPET_H / 2, bz));
        }
      } else {
        const wall = box(w, PARAPET_H, d, tm.body);
        g.add(at(wall, px, deckY + PARAPET_H / 2, pz));
        const artG = articulate(w, PARAPET_H, d, { body: tm.body, trim: tm.trim, dark: tm.dark, contact: tm.contact }, { plinthH: 0.14, corniceH: 0.1, pilasterEvery: 3 });
        g.add(at(artG, px, deckY + PARAPET_H / 2, pz));
        if (rustPatches && rand() > 0.4) {
          const along = horiz ? w : d;
          const patch = box(horiz ? along * 0.3 : PARAPET_T + 0.03, PARAPET_H * 0.55, horiz ? PARAPET_T + 0.03 : along * 0.3, rustLadder.body);
          g.add(at(patch, px + (rand() - 0.5) * along * 0.4, deckY + PARAPET_H * 0.5, pz + (rand() - 0.5) * along * 0.4));
        }
      }
    }
  };
  rail(DECK1_Y, 'south', true);
  rail(DECK2_Y, null, true);
}

/** One flight of STAIR_STEPS treads, stringers, handrail and one visibly
 *  replaced lighter tread. Rise/run/positions mirror map.ts's `stairRun()`
 *  exactly (same constants, same formula) so collision and render agree. */
function buildStairRun(g: THREE.Group, baseY: number, outerZ: number, zSign: 1 | -1, lighterIdx: number): void {
  const tm = ladder('timber');
  const td = ladder('timberDark');
  const st = ladder('steel');
  const totalRise = STAIR_STEPS * STAIR_RISE;
  const totalRun = STAIR_STEPS * STAIR_RUN;
  const outerPt = new THREE.Vector3(0, baseY, zSign * outerZ);
  const innerPt = new THREE.Vector3(0, baseY + totalRise, zSign * (outerZ - totalRun));

  for (let i = 0; i < STAIR_STEPS; i++) {
    const top = baseY + (i + 1) * STAIR_RISE;
    const z = zSign * (outerZ - (i + 0.5) * STAIR_RUN);
    const hex = i === lighterIdx ? PALETTE.woodLit : tm.body;
    g.add(at(box(STAIR_WIDTH, top - baseY, STAIR_RUN, hex), 0, (top + baseY) / 2, z));
    // nosing at the tread's downhill (outer) edge — a bright lip that also
    // sells the "one replaced tread" swap by contrast with its neighbours
    const edgeZ = zSign * (outerZ - i * STAIR_RUN) - zSign * 0.025;
    g.add(at(box(STAIR_WIDTH - 0.1, 0.03, 0.06, PALETTE.woodLit), 0, top + 0.02, edgeZ));
  }

  for (const side of [-1, 1]) {
    const from = new THREE.Vector3(side * (STAIR_WIDTH / 2 - 0.08), outerPt.y + 0.15, outerPt.z);
    const to = new THREE.Vector3(side * (STAIR_WIDTH / 2 - 0.08), innerPt.y + 0.15, innerPt.z);
    g.add(alignedBar(0.12, 0.3, from, to, td.body));
  }
  const railSide = 1;
  const railFrom = new THREE.Vector3(railSide * (STAIR_WIDTH / 2 + 0.06), outerPt.y + 0.92, outerPt.z);
  const railTo = new THREE.Vector3(railSide * (STAIR_WIDTH / 2 + 0.06), innerPt.y + 0.92, innerPt.z);
  g.add(alignedBar(0.06, 0.06, railFrom, railTo, st.body));
  for (let i = 0; i <= STAIR_STEPS; i += 3) {
    const y = baseY + i * STAIR_RISE;
    const z = zSign * (outerZ - i * STAIR_RUN);
    g.add(at(cyl(0.03, 0.03, 0.58, 6, st.body), railSide * (STAIR_WIDTH / 2 + 0.06), y + 0.3, z));
  }
}

/** Deck-1 and deck-2 decoration: the tower is "finished on the bottom,
 *  improvised on the top" — awning, ladder+rope, lantern on deck 1; coiled
 *  rope, water barrel, spotter's stool and a brazier on deck 2. */
function buildTowerTopside(g: THREE.Group, dyn: THREE.Group, animators: Animator[], rand: () => number): void {
  const sb = ladder('sandbag');
  const tm = ladder('timber');
  const td = ladder('timberDark');
  const st = ladder('steel');

  // --- deck 1: canvas awning over the NE corner ---
  const ax = H - 1.6;
  const az = -H + 1.6;
  for (const [ox, oz] of [
    [-1.1, -1.1],
    [1.1, -1.1],
    [-1.1, 1.1],
    [1.1, 1.1],
  ] as const) {
    g.add(alignedBar(0.06, 0.06, new THREE.Vector3(ax + ox, DECK1_Y, az + oz), new THREE.Vector3(ax + ox, DECK1_Y + 2.1, az + oz), td.dark));
  }
  const canopy = box(2.4, 0.05, 2.4, sb.body);
  canopy.rotation.z = 0.06;
  g.add(at(canopy, ax, DECK1_Y + 2.15, az));
  g.add(at(box(2.4, 0.05, 0.5, sb.dark), ax, DECK1_Y + 1.95, az + 1.15));

  // --- deck 1: ladder + rope up the west parapet face ---
  const lx = -H - 0.06;
  const lz = 2.2;
  g.add(alignedBar(0.06, 0.05, new THREE.Vector3(lx - 0.22, FOOTING_H, lz), new THREE.Vector3(lx - 0.22, DECK1_Y + 0.2, lz), td.body));
  g.add(alignedBar(0.06, 0.05, new THREE.Vector3(lx + 0.22, FOOTING_H, lz), new THREE.Vector3(lx + 0.22, DECK1_Y + 0.2, lz), td.body));
  for (let i = 0; i < 6; i++) {
    const y = FOOTING_H + 0.3 + i * ((DECK1_Y - FOOTING_H) / 6);
    g.add(at(cyl(0.025, 0.025, 0.5, 6, td.dark), lx, y, lz));
  }
  g.add(at(cyl(0.03, 0.03, 0.7, 6, PALETTE.sandbagDark), lx + 0.35, DECK1_Y + 0.35, lz).rotateZ(0.9));

  // --- deck 1: hanging lantern ---
  const lanX = -H + 1.6;
  const lanZ = H - 1.6;
  g.add(at(cyl(0.02, 0.02, 0.3, 5, st.body), lanX, DECK2_Y - SLAB_H - 0.12, lanZ));
  g.add(at(box(0.16, 0.2, 0.16, st.dark), lanX, DECK1_Y + 0.55, lanZ));
  addFlame(dyn, animators, lanX, DECK1_Y + 0.55, lanZ, 1.1, 1.3);

  // --- deck 2: coiled rope, water barrel, spotter's stool ---
  const rx = H - 1.4;
  const rz = H - 1.4;
  for (let i = 0; i < 3; i++) g.add(at(cyl(0.28 - i * 0.06, 0.28 - i * 0.06, 0.06, 10, PALETTE.sandbagDark), rx, DECK2_Y + 0.03 + i * 0.05, rz));

  const bx = -H + 1.5;
  const bz = -H + 1.5;
  g.add(at(cyl(0.35, 0.32, 0.9, 10, td.body), bx, DECK2_Y + 0.45, bz));
  g.add(at(cyl(0.37, 0.37, 0.06, 10, st.dark), bx, DECK2_Y + 0.15, bz));
  g.add(at(cyl(0.37, 0.37, 0.06, 10, st.dark), bx, DECK2_Y + 0.75, bz));

  const sx = 0;
  const sz = H - 2.0;
  for (const [ox, oz] of [
    [-0.18, -0.18],
    [0.18, -0.18],
    [-0.18, 0.18],
    [0.18, 0.18],
  ] as const) {
    g.add(at(cyl(0.02, 0.02, 0.45, 5, td.dark), sx + ox, DECK2_Y + 0.225, sz + oz));
  }
  g.add(at(cyl(0.28, 0.28, 0.05, 8, tm.body), sx, DECK2_Y + 0.47, sz));

  // --- deck 2: brazier (physical hardware; animate() drives the flame) ---
  const brX = 0;
  const brZ = -H + 1.6;
  for (const a of [0, 2.1, 4.2]) {
    g.add(alignedBar(0.05, 0.05, new THREE.Vector3(brX, DECK2_Y, brZ), new THREE.Vector3(brX + Math.cos(a) * 0.4, DECK2_Y + 0.55, brZ + Math.sin(a) * 0.4), st.dark));
  }
  g.add(at(cyl(0.28, 0.18, 0.16, 8, st.body), brX, DECK2_Y + 0.58, brZ));
  addFlame(dyn, animators, brX, DECK2_Y + 0.68, brZ, 1.6, 4.1);

  // --- a mast flag, deck 2 north parapet — breaks the horizon, sways in animate() ---
  const fx = 0;
  const fz = -H + PARAPET_T / 2;
  const mast = box(0.06, 1.6, 0.06, td.dark);
  g.add(at(mast, fx, DECK2_Y + PARAPET_H + 0.8, fz));
  const flagPivot = new THREE.Group();
  flagPivot.userData['animate'] = true;
  flagPivot.position.set(fx, DECK2_Y + PARAPET_H + 1.4, fz);
  const flag = box(0.55, 0.32, 0.02, PALETTE.hudAccent);
  flag.position.set(0.3, 0, 0);
  flagPivot.add(flag);
  dyn.add(flagPivot);
  animators.push((t) => {
    flagPivot.rotation.y = Math.sin(t * 1.6 + 2.2) * 0.22;
    flag.rotation.z = Math.sin(t * 3.1 + 2.2) * 0.08;
  });

  void rand; // reserved: available to future callers of this function
}

// ---------------------------------------------------------------------------
// Fence: static firing-step furniture + corner watch posts
// ---------------------------------------------------------------------------

function buildFenceFurniture(g: THREE.Group, rand: () => number): void {
  const sb = ladder('sandbag');
  for (const seg of SEGMENTS) {
    const horiz = segHoriz(seg);
    const off = FENCE.thickness / 2 + FENCE.stepDepth / 2;
    const inX = -seg.nx;
    const inZ = -seg.nz;
    const w = horiz ? SEG_LEN : FENCE.stepDepth;
    const d = horiz ? FENCE.stepDepth : SEG_LEN;
    g.add(at(box(w, FENCE.stepHeight, d, sb.body), seg.cx + inX * off, FENCE.stepHeight / 2, seg.cz + inZ * off));

    const bagN = 7;
    for (let i = 0; i < bagN; i++) {
      const t = (i + 0.5) / bagN - 0.5;
      const along = t * SEG_LEN * 0.88;
      const jitter = (rand() - 0.5) * (SEG_LEN / bagN) * 0.4;
      const across = -(FENCE.thickness / 2 + FENCE.stepDepth * (0.35 + rand() * 0.3));
      const bagH = FENCE.stepHeight * (0.75 + rand() * 0.3);
      const bag = box(0.5 + rand() * 0.12, bagH, 0.3 + rand() * 0.08, i % 2 === 0 ? sb.trim : sb.body);
      const p = segPoint(seg, along + jitter, across, FENCE.stepHeight + bagH / 2 - 0.02);
      at(bag, p.x, p.y, p.z);
      bag.rotation.y = rand() * Math.PI;
      g.add(bag);
    }
  }
  buildWatchPosts(g, rand);
}

function buildWatchPosts(g: THREE.Group, rand: () => number): void {
  const td = ladder('timberDark');
  const tm = ladder('timber');
  const c = FENCE_HALF - (FENCE.thickness / 2 + FENCE.stepDepth + 0.5);
  const corners: ReadonlyArray<readonly [number, number]> = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (const [sx, sz] of corners) {
    const x = sx * c;
    const z = sz * c;
    g.add(at(box(0.7, 4.5, 0.7, td.body), x, 2.25, z));
    // crow's-nest platform + a low corner-post rail (thin posts, not a solid
    // block, and never flush with the platform's own top face)
    g.add(at(box(1.3, 0.1, 1.3, tm.body), x, 4.55, z));
    for (const [rx, rz] of [
      [-0.58, -0.58],
      [0.58, -0.58],
      [-0.58, 0.58],
      [0.58, 0.58],
    ] as const) {
      g.add(at(box(0.06, 0.5, 0.06, tm.dark), x + rx, 4.83, z + rz));
    }
    g.add(at(box(1.3, 0.05, 0.06, tm.body), x, 5.05, z - 0.58));
    g.add(at(box(1.3, 0.05, 0.06, tm.body), x, 5.05, z + 0.58));
    // guy-wires down to two anchor points
    for (const a of [0.6, -0.6]) {
      const from = new THREE.Vector3(x, 4.6, z);
      const to = new THREE.Vector3(x + Math.cos(a) * 1.3, 0.05, z + Math.sin(a) * 1.3);
      g.add(alignedBar(0.02, 0.02, from, to, td.dark));
    }
    // lantern
    g.add(at(box(0.14, 0.16, 0.14, PALETTE.metalDark), x, 4.35, z));
    void rand;
  }
}

// ---------------------------------------------------------------------------
// Findable stations: weapon rack (deck 1) + ammo crate (ground floor)
// ---------------------------------------------------------------------------

function buildWeaponRack(g: THREE.Group, dyn: THREE.Group, rand: () => number): void {
  const p = feature('weaponRack');
  const st = ladder('steel');
  const rig = new THREE.Group();
  rig.add(at(box(0.08, 1.7, 0.08, st.body), -0.5, 0.85, 0));
  rig.add(at(box(0.08, 1.7, 0.08, st.body), 0.5, 0.85, 0));
  rig.add(at(box(1.14, 0.06, 0.1, st.body), 0, 1.55, 0));
  rig.add(at(box(1.14, 0.06, 0.1, st.body), 0, 0.35, 0));
  const slots = [-0.32, -0.05, 0.22];
  for (let i = 0; i < slots.length; i++) {
    const sx = slots[i] ?? 0;
    const barrel = box(0.045, 1.0, 0.045, PALETTE.metalDark);
    at(barrel, sx, 0.9, 0.08);
    barrel.rotation.z = 0.16 - i * 0.02;
    rig.add(barrel);
    const stock = box(0.09, 0.22, 0.06, MAT_COLORS.timberDark.body);
    at(stock, sx - 0.02, 0.42, 0.06);
    stock.rotation.z = 0.16;
    rig.add(stock);
  }
  // hudAccent stencil plaque — findable silhouette accent
  rig.add(at(box(0.9, 0.32, 0.03, PALETTE.hudAccent, { emissive: PALETTE.hudAccent }), 0, 1.92, 0.06));
  const prices = `SG${ECONOMY.weaponPrice.shotgun} SM${ECONOMY.weaponPrice.smg} RF${ECONOMY.weaponPrice.rifle} SN${ECONOMY.weaponPrice.sniper}`;
  const label = makeLabelPlane(prices, 1.7, 0.42);
  at(label, 0, 2.38, 0.045);
  rig.add(label);
  at(rig, p.x, p.y, p.z);
  g.add(rig);

  const light = new THREE.PointLight(PALETTE.floodBeam, 1.4, 3.2, 2);
  light.position.set(p.x, p.y + 1.6, p.z + 0.3);
  light.castShadow = false;
  dyn.add(light);

  void rand;
  void WEAPON_ORDER; // available for a future per-weapon label; kept as a documented reuse point
}

function buildAmmoCrate(g: THREE.Group, dyn: THREE.Group, rand: () => number): void {
  const p = feature('ammoCrate');
  const tm = ladder('timber');
  const st = ladder('steel');
  const rig = new THREE.Group();
  rig.add(at(box(0.9, 0.6, 0.7, tm.body), 0, 0.3, 0));
  rig.add(at(box(0.94, 0.08, 0.74, tm.trim), 0, 0.62, 0));
  for (const dz of [-0.3, 0, 0.3]) rig.add(at(box(0.94, 0.03, 0.03, st.body), 0, 0.32, dz));
  for (const c of [
    [-0.42, -0.32],
    [0.42, -0.32],
    [-0.42, 0.32],
    [0.42, 0.32],
  ] as const) {
    rig.add(at(box(0.06, 0.06, 0.06, st.dark), c[0], 0.03, c[1]));
  }
  rig.add(at(box(0.7, 0.26, 0.02, PALETTE.hudAccent, { emissive: PALETTE.hudAccent }), 0, 0.42, 0.36));
  const label = makeLabelPlane(`AMMO ${ECONOMY.ammoRefillCost}`, 1.2, 0.32);
  at(label, 0, 0.88, 0.36);
  rig.add(label);
  rig.add(contactShadow(0.75));
  // scattered spare crates for silhouette density
  for (let i = 0; i < 2; i++) {
    const cx = 0.8 + i * 0.55 + rand() * 0.1;
    const cz = -0.5 + i * 0.9;
    const crate = box(0.4, 0.32, 0.4, i % 2 === 0 ? tm.dark : tm.body);
    at(crate, cx, 0.16, cz);
    crate.rotation.y = rand() * 0.6;
    rig.add(crate);
  }
  at(rig, p.x, p.y, p.z);
  g.add(rig);

  const light = new THREE.PointLight(PALETTE.floodBeam, 1.2, 2.6, 2);
  light.position.set(p.x, p.y + 1.3, p.z);
  light.castShadow = false;
  dyn.add(light);
  void rand;
}

// ---------------------------------------------------------------------------
// Fence segments — three prebaked state variants per segment, swapped by
// `setSegment` via `.visible`, never rebuilt.
// ---------------------------------------------------------------------------

type SegState = 'intact' | 'damaged' | 'breached';

interface SegRecord {
  variants: Record<SegState, THREE.Object3D>;
  anchor: THREE.Object3D;
  shown: SegState;
}

function buildAllSegments(root: THREE.Group, rand: () => number): Map<SegmentId, SegRecord> {
  const map = new Map<SegmentId, SegRecord>();
  for (const seg of SEGMENTS) {
    const intactSrc = new THREE.Group();
    if (seg.gate) buildGateIntact(intactSrc, seg, rand);
    else buildPalisadeIntact(intactSrc, seg, rand);

    const damagedSrc = new THREE.Group();
    buildPalisadeDamaged(damagedSrc, seg, rand);

    const breachedSrc = new THREE.Group();
    buildPalisadeBreached(breachedSrc, seg, rand);

    const intact = bake(intactSrc);
    const damaged = bake(damagedSrc);
    const breached = bake(breachedSrc);
    damaged.visible = false;
    breached.visible = false;
    root.add(intact, damaged, breached);

    const anchor = new THREE.Group();
    anchor.position.set(seg.cx, FENCE.height / 2, seg.cz);
    root.add(anchor);

    map.set(seg.id, { variants: { intact, damaged, breached }, anchor, shown: 'intact' });
  }
  return map;
}

/** 14-18 jittered leaning pointed timbers, two lashed rails, brackets, one or
 *  two rust sheets — kept to <=6 palette entries (wood, woodDark, steel, rust). */
function buildPalisadeIntact(g: THREE.Group, seg: SegmentGeom, rand: () => number): void {
  const tm = ladder('timber');
  const st = ladder('steel');
  const ru = ladder('rust');
  const horiz = segHoriz(seg);
  const timberN = 16;
  for (let i = 0; i < timberN; i++) {
    const t = (i + 0.5) / timberN - 0.5;
    const along = t * SEG_LEN * 0.94;
    const hgt = FENCE.height * (0.94 + rand() * 0.14);
    const lean = (rand() - 0.5) * 0.14;
    const hex = i % 4 === 0 ? tm.dark : tm.body;
    const post = box(0.13, hgt, 0.13, hex);
    const pp = segPoint(seg, along, 0, hgt / 2);
    post.position.copy(pp);
    if (horiz) post.rotation.z = lean;
    else post.rotation.x = lean;
    g.add(post);
    const cap = cone(0.1, 0.2, 4, tm.dark);
    const cp = segPoint(seg, along, 0, hgt + 0.09);
    cap.position.copy(cp);
    cap.rotation.y = rand() * Math.PI;
    g.add(cap);
  }
  for (const ry of [FENCE.height * 0.34, FENCE.height * 0.76]) {
    const wd = segWD(seg, SEG_LEN * 0.96, 0.06);
    const rail = box(wd.w, 0.08, wd.d, tm.dark);
    const p = segPoint(seg, 0, 0.015, ry);
    rail.position.copy(p);
    g.add(rail);
  }
  for (let i = 0; i < timberN; i += 4) {
    const t = (i + 0.5) / timberN - 0.5;
    const along = t * SEG_LEN * 0.94;
    const br = box(0.05, 0.12, 0.05, st.body);
    const p = segPoint(seg, along, 0.04, FENCE.height * 0.76);
    br.position.copy(p);
    g.add(br);
  }
  for (let s = 0; s < 2; s++) {
    const along = (s - 0.5) * SEG_LEN * 0.42;
    const wd = segWD(seg, SEG_LEN * 0.3, 0.03);
    const sheet = box(wd.w, FENCE.height * 0.5, wd.d, ru.body);
    const p = segPoint(seg, along, 0.02, FENCE.height * 0.5);
    sheet.position.copy(p);
    g.add(sheet);
    for (let r = -1; r <= 1; r += 2) {
      const rib = box(0.02, FENCE.height * 0.46, 0.02, ru.body);
      const rp = segPoint(seg, along + r * (SEG_LEN * 0.3) / 3, 0.035, FENCE.height * 0.5);
      rib.position.copy(rp);
      g.add(rib);
    }
  }
}

/** Splintered/canted timbers, one or two missing, gore-stained rails, ground
 *  debris. <=6 palette entries (wood, woodDark, gore, sandbag/sandbagDark). */
function buildPalisadeDamaged(g: THREE.Group, seg: SegmentGeom, rand: () => number): void {
  const tm = ladder('timber');
  const timberN = 16;
  const missing = new Set<number>([3, 11]);
  for (let i = 0; i < timberN; i++) {
    if (missing.has(i)) continue;
    const t = (i + 0.5) / timberN - 0.5;
    const along = t * SEG_LEN * 0.94;
    const broken = rand() < 0.4;
    const hgt = FENCE.height * (broken ? 0.35 + rand() * 0.3 : 0.85 + rand() * 0.15);
    const lean = (rand() - 0.5) * (broken ? 0.7 : 0.3);
    const hex = i % 3 === 0 ? tm.dark : tm.body;
    const post = box(0.13, hgt, 0.13, hex);
    const pp = segPoint(seg, along, 0, hgt / 2);
    post.position.copy(pp);
    if (segHoriz(seg)) post.rotation.z = lean;
    else post.rotation.x = lean;
    g.add(post);
  }
  for (const ry of [FENCE.height * 0.34, FENCE.height * 0.7]) {
    const wd = segWD(seg, SEG_LEN * 0.9, 0.06);
    const rail = box(wd.w, 0.07, wd.d, PALETTE.gore);
    const p = segPoint(seg, -0.2, 0.02, ry);
    rail.position.copy(p);
    g.add(rail);
  }
  const debN = 9;
  for (let i = 0; i < debN; i++) {
    const along = (rand() - 0.5) * SEG_LEN * 0.9;
    const across = -(0.2 + rand() * 1.4);
    const d = box(0.35 + rand() * 0.3, 0.08, 0.1, i % 2 === 0 ? PALETTE.sandbagDark : tm.dark);
    const p = segPoint(seg, along, across, 0.05);
    d.position.copy(p);
    d.rotation.y = rand() * Math.PI;
    g.add(d);
  }
}

/** The most legible thing on the fence line at 30 m: the palisade is GONE and
 *  a walkable rubble scatter fills the opening. <=6 palette entries. */
function buildPalisadeBreached(g: THREE.Group, seg: SegmentGeom, rand: () => number): void {
  const tm = ladder('timber');
  const ru = ladder('rust');
  const gravel = ladder('gravel');
  const wd = segWD(seg, SEG_LEN * 0.98, 1.3);
  const path = box(wd.w, 0.03, wd.d, gravel.body);
  const pp = segPoint(seg, 0, -0.5, 0.02);
  path.position.copy(pp);
  g.add(path);

  const chunkN = 20;
  for (let i = 0; i < chunkN; i++) {
    const along = (rand() - 0.5) * SEG_LEN * 0.96;
    const across = (rand() - 0.5) * 1.6 - 0.1;
    const isSheet = rand() < 0.3;
    const hgt = FENCE.rubbleHeight * (0.4 + rand() * 1.4);
    const hex = isSheet ? ru.body : rand() < 0.5 ? tm.body : tm.dark;
    const chunk = box(0.3 + rand() * 0.4, hgt, 0.12 + rand() * 0.2, hex);
    const p = segPoint(seg, along, across, hgt / 2);
    chunk.position.copy(p);
    chunk.rotation.y = rand() * Math.PI;
    if (isSheet) chunk.rotation.z = (rand() - 0.5) * 0.6;
    g.add(chunk);
  }
  for (let i = 0; i < 3; i++) {
    const along = (rand() - 0.5) * SEG_LEN * 0.7;
    const across = -(0.3 + rand());
    const bag = box(0.5, 0.22, 0.32, PALETTE.sandbag);
    const p = segPoint(seg, along, across, 0.11);
    bag.position.copy(p);
    bag.rotation.y = rand() * Math.PI;
    g.add(bag);
  }
}

/** Two strapped leaves, drop-bar, flanking stone piers with a lantern each.
 *  Reads as a gate in silhouette alone; still shares the damaged/breached
 *  variants every other segment uses once it takes damage. */
function buildGateIntact(g: THREE.Group, seg: SegmentGeom, rand: () => number): void {
  const td = ladder('timberDark');
  const st = ladder('steel');
  const sto = ladder('stone');
  const half = SEG_LEN / 2;
  for (const side of [-1, 1]) {
    const wd = segWD(seg, half - 0.3, FENCE.thickness * 0.85);
    // 0.98, not shorter: the leaf must read flush with the segment's collision
    // height (FENCE.height) — a visibly short leaf under a full-height solid
    // AABB reads as invisible collision floating above the visible gate.
    const leafH = FENCE.height * 0.98;
    const leaf = box(wd.w, leafH, wd.d, td.body);
    const p = segPoint(seg, side * (half - 0.3) * 0.5, 0, leafH / 2);
    leaf.position.copy(p);
    g.add(leaf);
    for (const frac of [0.25, 0.75]) {
      const wd2 = segWD(seg, half - 0.4, 0.03);
      const strap = box(wd2.w, 0.08, wd2.d, st.body);
      const sp = segPoint(seg, side * (half - 0.3) * 0.5, 0.03, FENCE.height * frac);
      strap.position.copy(sp);
      g.add(strap);
    }
  }
  const bar = segWD(seg, SEG_LEN - 0.6, 0.1);
  const barMesh = box(bar.w, 0.14, bar.d, td.dark);
  const bp = segPoint(seg, 0, 0.05, FENCE.height * 0.55);
  barMesh.position.copy(bp);
  g.add(barMesh);
  for (const side of [-1, 1]) {
    const wd = segWD(seg, 0.6, 0.6);
    const pier = box(wd.w, FENCE.height + 0.6, wd.d, sto.body);
    const p = segPoint(seg, side * (half + 0.3), 0, (FENCE.height + 0.6) / 2);
    pier.position.copy(p);
    g.add(pier);
    const cap = box(wd.w + 0.1, 0.14, wd.d + 0.1, sto.trim);
    const cp = segPoint(seg, side * (half + 0.3), 0, FENCE.height + 0.6 + 0.07);
    cap.position.copy(cp);
    g.add(cap);
    const lanternHolder = box(0.12, 0.16, 0.12, st.dark);
    const lp = segPoint(seg, side * (half + 0.3), -0.4, FENCE.height + 0.35);
    lanternHolder.position.copy(lp);
    g.add(lanternHolder);
  }
  void rand;
}

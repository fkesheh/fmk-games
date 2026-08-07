import { describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
const LOG = (...a: unknown[]) => appendFileSync('/tmp/probe.log', a.join(' ') + '\n');
import { CAMP_LEASH_RADIUS, ELEV_HIGH, ELEV_LOW, TERRAIN_KINDS, buildMap } from '@rift/shared';
import type { CampDef, MapDef, SeatDef, TerrainDef, TerrainKind } from '@rift/shared';
import { SimWorld } from './world.js';
import { stepMovement } from './movement.js';
import { stepDeaths } from './combat.js';
import { spawnCamp, stepCamps } from './camps.js';
import { NO_ENT } from './types.js';
import type { AbilitiesEngine, CampState, Ent, World } from './types.js';

class Eng implements AbilitiesEngine { step(w: World): void { w.drainCasts(); } }
const SEATS: SeatDef[] = [
  { pid: 'p0', team: 0, hero: 'reaver', bot: false, lane: 0 },
  { pid: 'p1', team: 1, hero: 'longbow', bot: false, lane: 0 },
];
const HIGH: readonly TerrainKind[] = ['high', 'base', 'ramp'];
function terrainOf(side: number, camps: CampDef[], paint: (x: number, z: number) => TerrainKind): TerrainDef {
  const dim = side; const kind = new Uint8Array(dim*dim); const elev = new Uint8Array(dim*dim);
  for (let z=0;z<dim;z++) for (let x=0;x<dim;x++){const k=paint(x+.5,z+.5);kind[z*dim+x]=TERRAIN_KINDS.indexOf(k);elev[z*dim+x]=HIGH.includes(k)?ELEV_HIGH:ELEV_LOW;}
  return { grid: { side, res: 1, dim, kind, elev }, camps, landmarks: [] };
}
function world(camps: CampDef[], paint: (x:number,z:number)=>TerrainKind = () => 'ground'): SimWorld {
  const terrain = terrainOf(64, camps, paint);
  const map: MapDef = { lanes: 1, side: 64, paths: [], structures: [], terrain };
  const w = new SimWorld(map, SEATS, new Eng());
  (w as unknown as {camps: CampState[]}).camps = camps.map((def) => ({ id: def.id, def, memberIds: [], aliveCount: 0, respawnAtTick: 0 }));
  return w;
}
function campsOf(w: SimWorld): CampState[] { return (w as unknown as {camps: CampState[]}).camps; }
function hero(w: SimWorld, pid: string): Ent { for (const e of w.mobileMap.values()) if (e.kind==='hero'&&e.pid===pid) return e; throw new Error('x'); }
function tickSim(w: SimWorld): void { w.tick += 1; stepMovement(w); stepDeaths(w); stepCamps(w); }
function must<T>(v: T|undefined): T { if (v===undefined) throw new Error('nope'); return v; }

describe('PROBE', () => {
  it('P1: hero parked on the post — returning member never arrives, never heals, never retaliates', () => {
    const w = world([{ id: 0, tier: 'brute', x: 32, z: 32, half: 0 }]);
    w.tick += 1; stepCamps(w);
    const c = must(campsOf(w)[0]);
    const e = must(w.get(must(c.memberIds[0])));
    const postX = e.x, postZ = e.z;
    const h = hero(w, 'p0');
    h.order = 'idle';
    // shove the member out past the leash so it is ordered home
    e.x = 32 + CAMP_LEASH_RADIUS + 2; e.z = 32;
    w.damage(h.id, e.id, 120, 'physical');
    const hurt = e.hp;
    stepCamps(w);
    expect(e.order).toBe('move');
    // hero sits exactly on the member's post, blocking arrival
    h.x = postX; h.z = postZ;
    for (let i = 0; i < 600; i++) { h.x = postX; h.z = postZ; h.order = 'idle'; tickSim(w); }
    LOG('P1 order=', e.order, 'hp=', e.hp, '/', e.maxHp, 'distToPost=', Math.hypot(e.x-postX, e.z-postZ), 'target=', e.orderTarget);
    expect(true).toBe(true);
  });

  it('P2: hero displaced off a one-point (straight-line) plan never re-plans', () => {
    // a solid blob; hero orders across open ground first (straight line clear),
    // then is displaced so the straight line is blocked, same destination.
    const paint = (x: number, z: number): TerrainKind => (x > 20 && x < 26 && z > 20 && z < 26 ? 'cliff' : 'ground');
    const w = world([], paint);
    const h = hero(w, 'p0');
    h.x = 30; h.z = 23; h.order = 'move'; h.ox = 36; h.oz = 23; h.orderTarget = NO_ENT;
    w.tick += 1; stepMovement(w);
    LOG('P2 plan len after clear-line order =', h.path?.length);
    h.x = 10; h.z = 23; h.order = 'move'; h.ox = 36; h.oz = 23; h.orderTarget = NO_ENT;
    for (let i = 0; i < 400; i++) { w.tick += 1; stepMovement(w); }
    LOG('P2 after 400: pathLen=', h.path?.length, 'pos=', h.x.toFixed(2), h.z.toFixed(2), 'order=', h.order, 'arrived=', Math.hypot(h.x-36,h.z-23).toFixed(2));
    expect(true).toBe(true);
  });

  it('P3: what the ward/neutral/structure test actually spawns', () => {
    const w = world([{ id: 0, tier: 'pack', x: 32, z: 32, half: 0 }]);
    w.tick += 1; stepCamps(w);
    const c = must(campsOf(w)[0]);
    LOG('P3 camp count =', campsOf(w).length, 'members', c.memberIds.length);
    const ms = c.memberIds.map((i)=>must(w.get(i)));
    for (let i=0;i<ms.length;i++) for (let j=i+1;j<ms.length;j++) {
      LOG('P3 member gap', Math.hypot(must(ms[i]).x-must(ms[j]).x, must(ms[i]).z-must(ms[j]).z));
    }
    expect(true).toBe(true);
  });

  it('P4: camp member radius / mobileTuning', () => {
    const w = world([{ id: 0, tier: 'brute', x: 32, z: 32, half: 0 }]);
    w.tick += 1; stepCamps(w);
    const c = must(campsOf(w)[0]);
    for (const id of c.memberIds) LOG('P4 radius', must(w.get(id)).radius);
    expect(true).toBe(true);
  });
});

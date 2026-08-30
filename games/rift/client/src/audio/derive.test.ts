// RIFT audio — T13: derive.ts (T3) unit tests. Vitest, NODE environment, no
// WebAudio, no DOM. derive.ts is pure, so it is exercised directly against
// small synthetic SnapMsg/RiftEvent fixtures — see AUDIO_CONTRACT.md §T13.
//
// Four bugs were already found and fixed in this module's spec by an
// adversarial review round. The tests tagged REGRESSION below exist
// specifically so none of them can come back:
//   1. gold spam        — passive fractional income must never spam a cue.
//   2. tick domain       — cooldown/respawn must key off matchTick, not tick.
//   3. natural expiry    — an expiring (non-recast) cooldown must still fire
//                          abilityReady exactly once.
//   4. ally death        — heroDeath.friendly must be true for a teammate.
import { describe, expect, it } from 'vitest';
import type { BoardEntry, HeroId } from '@rift/shared';
import type {
  AudioEvent,
  AudioWorldCtx,
  CastColour,
  EntKind,
  EntSnap,
  SnapMsg,
  YouSnap,
} from './contract.js';
import { DERIVE } from './config.js';
import { createDeriver } from './derive.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function ent(id: number, k: EntKind, overrides: Partial<EntSnap> = {}): EntSnap {
  return { id, k, team: 0, x: 0, z: 0, hp: 100, maxHp: 100, ...overrides };
}

function ability(rank: number, cdUntilTick: number): { rank: number; cdUntilTick: number } {
  return { rank, cdUntilTick };
}

const READY_ABILITIES = [ability(1, 0), ability(1, 0), ability(1, 0), ability(1, 0)] as const;

function you(overrides: Partial<YouSnap> = {}): YouSnap {
  return {
    hero: 'bullwark',
    x: 0,
    z: 0,
    hp: 500,
    maxHp: 500,
    mana: 100,
    maxMana: 100,
    level: 1,
    xp: 0,
    gold: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    skillPoints: 0,
    respawnAtTick: 0,
    abilities: READY_ABILITIES,
    items: [null, null, null, null, null, null],
    itemCharges: [0, 0, 0, 0, 0, 0],
    itemCdUntilTick: [0, 0, 0, 0, 0, 0],
    ...overrides,
  };
}

function makeSnap(
  tick: number,
  matchTick: number,
  overrides: {
    ents?: readonly EntSnap[];
    you?: YouSnap | null;
    board?: readonly BoardEntry[];
  } = {},
): SnapMsg {
  return {
    t: 'rift_snap',
    tick,
    serverTime: tick * 50,
    phase: 'live',
    matchTick,
    overtime: false,
    wardStock: 0,
    kills: [0, 0],
    board: overrides.board ?? [],
    you: overrides.you ?? null,
    ents: overrides.ents ?? [],
  };
}

function makeCtx(overrides: Partial<AudioWorldCtx> = {}): AudioWorldCtx {
  return {
    selfPid: null,
    selfEntId: -1,
    selfTeam: null,
    isVisible: () => true,
    ...overrides,
  };
}

function tagsOf(evs: readonly AudioEvent[]): readonly string[] {
  return evs.map((e) => e.t);
}

// ---------------------------------------------------------------------------
// baseline / lifecycle
// ---------------------------------------------------------------------------

describe('createDeriver — baseline & lifecycle', () => {
  it('the first snapshot establishes the baseline and emits nothing', () => {
    const deriver = createDeriver();
    const s1 = makeSnap(1, 1, { ents: [ent(1, 'melee')], you: you({ gold: 100 }) });
    expect(deriver.snapshot(s1, makeCtx())).toEqual([]);
  });

  it('REGRESSION: reset() fully clears baseline state — a post-reset snapshot behaves like the very first one', () => {
    const deriver = createDeriver();
    const ctx = makeCtx();
    deriver.snapshot(makeSnap(1, 1, { you: you({ gold: 1000 }) }), ctx);
    deriver.snapshot(makeSnap(2, 2, { you: you({ gold: 1010 }) }), ctx); // prevSnap.gold now 1010

    deriver.reset();

    // first call post-reset must be treated as a fresh baseline, not diffed
    // against the stale prevSnap (gold 1010) left over from before reset.
    const afterReset1 = deriver.snapshot(makeSnap(1, 1, { you: you({ gold: 1005 }) }), ctx);
    expect(afterReset1).toEqual([]);

    const afterReset2 = deriver.snapshot(makeSnap(2, 2, { you: you({ gold: 1010 }) }), ctx);
    expect(afterReset2.filter((e) => e.t === 'gold')).toEqual([{ t: 'gold', amount: 5, lastHit: false }]);
  });

  it('an out-of-order snapshot (snap.tick <= prev.tick) returns empty and changes nothing', () => {
    const deriver = createDeriver();
    const ctx = makeCtx();
    deriver.snapshot(makeSnap(5, 5, { you: you({ gold: 1000 }) }), ctx);
    const stale = deriver.snapshot(makeSnap(3, 3, { you: you({ gold: 5000 }) }), ctx);
    expect(stale).toEqual([]);

    // the next properly-ordered snapshot must diff against the ORIGINAL
    // baseline (gold 1000), never against the rejected stale one (gold 5000).
    const next = deriver.snapshot(makeSnap(6, 6, { you: you({ gold: 1010 }) }), ctx);
    expect(next.filter((e) => e.t === 'gold')).toEqual([{ t: 'gold', amount: 10, lastHit: false }]);
  });

  it('snap.you === null never throws and simply skips player-only derivations', () => {
    const deriver = createDeriver();
    const ctx = makeCtx();
    expect(() =>
      deriver.snapshot(makeSnap(1, 1, { you: null, ents: [ent(60, 'melee', { hp: 100 })] }), ctx),
    ).not.toThrow();

    let evs: readonly AudioEvent[] = [];
    expect(() => {
      evs = deriver.snapshot(
        makeSnap(2, 2, { you: null, ents: [ent(60, 'melee', { hp: 100 - DERIVE.hitMinHp })] }),
        ctx,
      );
    }).not.toThrow();

    // entity-driven derivations still work with no local player...
    expect(evs.filter((e) => e.t === 'hit')).toHaveLength(1);
    // ...but player-only derivations are simply absent, never a crash.
    expect(tagsOf(evs)).not.toContain('hurt');
    expect(tagsOf(evs)).not.toContain('gold');
    expect(tagsOf(evs)).not.toContain('lowHp');
  });
});

// ---------------------------------------------------------------------------
// combat
// ---------------------------------------------------------------------------

describe('createDeriver — combat', () => {
  it('an atk transition emits exactly one attack; the same atk next snapshot emits none', () => {
    const deriver = createDeriver();
    const ctx = makeCtx();
    deriver.snapshot(makeSnap(1, 1, { ents: [ent(10, 'melee')] }), ctx);

    const swing = deriver.snapshot(makeSnap(2, 2, { ents: [ent(10, 'melee', { atk: 99 })] }), ctx);
    const attacks1 = swing.filter((e) => e.t === 'attack');
    expect(attacks1).toHaveLength(1);
    expect(attacks1[0]).toMatchObject({ t: 'attack', kind: 'melee' });

    const same = deriver.snapshot(makeSnap(3, 3, { ents: [ent(10, 'melee', { atk: 99 })] }), ctx);
    expect(same.filter((e) => e.t === 'attack')).toHaveLength(0);
  });

  it('an entity losing >= hitMinHp emits hit (at the victim position); losing less emits none', () => {
    const deriver = createDeriver();
    const ctx = makeCtx();
    deriver.snapshot(makeSnap(1, 1, { ents: [ent(20, 'melee', { hp: 100, x: 5, z: 7 })] }), ctx);
    const dropAtThreshold = deriver.snapshot(
      makeSnap(2, 2, { ents: [ent(20, 'melee', { hp: 100 - DERIVE.hitMinHp, x: 5, z: 7 })] }),
      ctx,
    );
    const hits = dropAtThreshold.filter((e) => e.t === 'hit');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ t: 'hit', x: 5, z: 7 });

    deriver.reset();
    deriver.snapshot(makeSnap(1, 1, { ents: [ent(21, 'melee', { hp: 100 })] }), ctx);
    const dropBelowThreshold = deriver.snapshot(
      makeSnap(2, 2, { ents: [ent(21, 'melee', { hp: 100 - DERIVE.hitMinHp + 0.01 })] }),
      ctx,
    );
    expect(dropBelowThreshold.filter((e) => e.t === 'hit')).toHaveLength(0);
  });

  it('a vanished creep inside vision emits unitDeath; leaving fog (now unresolvable) emits nothing', () => {
    const deriver = createDeriver();
    const visibleCtx = makeCtx({ isVisible: () => true });
    deriver.snapshot(makeSnap(1, 1, { ents: [ent(30, 'melee', { x: 12, z: 14 })] }), visibleCtx);
    const deaths = deriver.snapshot(makeSnap(2, 2, { ents: [] }), visibleCtx);
    const unitDeaths = deaths.filter((e) => e.t === 'unitDeath');
    expect(unitDeaths).toHaveLength(1);
    expect(unitDeaths[0]).toMatchObject({ t: 'unitDeath', kind: 'melee', x: 12, z: 14, visible: true });

    // Same scenario, but the entity's last known position is under fog: this
    // must NOT be reported as a death — it is indistinguishable from simply
    // walking out of vision.
    deriver.reset();
    const fogCtx = makeCtx({ isVisible: () => false });
    deriver.snapshot(makeSnap(1, 1, { ents: [ent(31, 'melee', { x: 20, z: 20 })] }), fogCtx);
    const noDeaths = deriver.snapshot(makeSnap(2, 2, { ents: [] }), fogCtx);
    expect(noDeaths.filter((e) => e.t === 'unitDeath')).toHaveLength(0);
  });

  it("hurt carries the local player's OWN x/z (the attacker is not knowable from an hp delta)", () => {
    const deriver = createDeriver();
    const ctx = makeCtx();
    deriver.snapshot(makeSnap(1, 1, { you: you({ hp: 500, x: 40, z: 41 }) }), ctx);
    const evs = deriver.snapshot(
      makeSnap(2, 2, { you: you({ hp: 500 - DERIVE.hurtMinHp - 1, x: 44, z: 45 }) }),
      ctx,
    );
    const hurts = evs.filter((e) => e.t === 'hurt');
    expect(hurts).toHaveLength(1);
    expect(hurts[0]).toMatchObject({ t: 'hurt', x: 44, z: 45 });
  });
});

// ---------------------------------------------------------------------------
// low HP heartbeat
// ---------------------------------------------------------------------------

describe('createDeriver — lowHp', () => {
  it('crossing 0.3 then 0.15 HP emits lowHp band 0 then band 1, once each; recovering emits band -1 and re-arms', () => {
    const deriver = createDeriver();
    const ctx = makeCtx();
    deriver.snapshot(makeSnap(1, 1, { you: you({ hp: 500, maxHp: 500 }) }), ctx);

    const e1 = deriver.snapshot(makeSnap(2, 2, { you: you({ hp: 140, maxHp: 500 }) }), ctx); // 0.28 < 0.3
    expect(e1.filter((e) => e.t === 'lowHp')).toEqual([{ t: 'lowHp', band: 0, hpFrac: 140 / 500 }]);

    const e2 = deriver.snapshot(makeSnap(3, 3, { you: you({ hp: 60, maxHp: 500 }) }), ctx); // 0.12 < 0.15
    expect(e2.filter((e) => e.t === 'lowHp')).toEqual([{ t: 'lowHp', band: 1, hpFrac: 60 / 500 }]);

    // still under band 1 — no re-emit while nothing crosses a new boundary.
    const e3 = deriver.snapshot(makeSnap(4, 4, { you: you({ hp: 55, maxHp: 500 }) }), ctx);
    expect(e3.filter((e) => e.t === 'lowHp')).toHaveLength(0);

    const e4 = deriver.snapshot(makeSnap(5, 5, { you: you({ hp: 400, maxHp: 500 }) }), ctx); // 0.8, recovers
    expect(e4.filter((e) => e.t === 'lowHp')).toEqual([{ t: 'lowHp', band: -1, hpFrac: 400 / 500 }]);

    // re-armed: crossing back down into band 0 fires again.
    const e5 = deriver.snapshot(makeSnap(6, 6, { you: you({ hp: 140, maxHp: 500 }) }), ctx);
    expect(e5.filter((e) => e.t === 'lowHp')).toEqual([{ t: 'lowHp', band: 0, hpFrac: 140 / 500 }]);
  });
});

// ---------------------------------------------------------------------------
// economy (gold)
// ---------------------------------------------------------------------------

describe('createDeriver — gold', () => {
  it('REGRESSION: fractional passive gold trickle across 20 snapshots emits ZERO gold events, not ~20', () => {
    const deriver = createDeriver();
    const ctx = makeCtx();
    const perTick = 0.35;
    expect(perTick).toBeLessThan(DERIVE.goldMinDelta); // sanity: fixture is genuinely sub-floor

    let gold = 1000;
    deriver.snapshot(makeSnap(1, 1, { you: you({ gold }) }), ctx);

    let totalGoldEvents = 0;
    for (let i = 0; i < 20; i++) {
      gold += perTick;
      const evs = deriver.snapshot(makeSnap(2 + i, 2 + i, { you: you({ gold }) }), ctx);
      totalGoldEvents += evs.filter((e) => e.t === 'gold').length;
    }

    expect(totalGoldEvents).toBe(0);
  });

  it('gold delta >= lastHitMinGold with a same-snapshot unitDeath is a last-hit; without a death it is not', () => {
    const deriver = createDeriver();
    const ctx = makeCtx();

    deriver.snapshot(makeSnap(1, 1, { ents: [ent(40, 'melee', { x: 1, z: 1 })], you: you({ gold: 500 }) }), ctx);
    const withDeath = deriver.snapshot(
      makeSnap(2, 2, { ents: [], you: you({ gold: 500 + DERIVE.lastHitMinGold }) }),
      ctx,
    );
    const gold1 = withDeath.filter((e) => e.t === 'gold');
    expect(gold1).toHaveLength(1);
    expect(gold1[0]).toMatchObject({ t: 'gold', lastHit: true });

    deriver.reset();
    deriver.snapshot(makeSnap(1, 1, { you: you({ gold: 500 }) }), ctx); // no ents at all: no death possible
    const withoutDeath = deriver.snapshot(
      makeSnap(2, 2, { you: you({ gold: 500 + DERIVE.lastHitMinGold }) }),
      ctx,
    );
    const gold2 = withoutDeath.filter((e) => e.t === 'gold');
    expect(gold2).toHaveLength(1);
    expect(gold2[0]).toMatchObject({ t: 'gold', lastHit: false });
  });
});

// ---------------------------------------------------------------------------
// ability cooldowns & respawn — the matchTick vs. snap.tick domain
// ---------------------------------------------------------------------------

describe('createDeriver — ability/respawn tick domain', () => {
  it('REGRESSION: abilityReady fires exactly once on natural cooldown expiry (cdUntilTick unchanged, matchTick crosses it)', () => {
    const deriver = createDeriver();
    const ctx = makeCtx();
    const cdUntil = 100;
    const abilitiesAt = (cd: number) => [ability(1, cd), ability(1, 0), ability(1, 0), ability(1, 0)] as const;

    deriver.snapshot(makeSnap(1, 50, { you: you({ abilities: abilitiesAt(cdUntil) }) }), ctx);

    // no recast: cdUntilTick is IDENTICAL, only matchTick moved past it.
    const evs = deriver.snapshot(makeSnap(2, 101, { you: you({ abilities: abilitiesAt(cdUntil) }) }), ctx);
    expect(evs.filter((e) => e.t === 'abilityReady')).toEqual([{ t: 'abilityReady', slot: 0 }]);

    // must not re-fire on a subsequent identical snapshot.
    const evs2 = deriver.snapshot(makeSnap(3, 102, { you: you({ abilities: abilitiesAt(cdUntil) }) }), ctx);
    expect(evs2.filter((e) => e.t === 'abilityReady')).toHaveLength(0);
  });

  it('REGRESSION: abilityReady never fires for a rank-0 (unlearned) ability, even if the cooldown condition holds', () => {
    const deriver = createDeriver();
    const ctx = makeCtx();
    const abilitiesAt = (cd: number) => [ability(0, cd), ability(1, 0), ability(1, 0), ability(1, 0)] as const;
    deriver.snapshot(makeSnap(1, 1, { you: you({ abilities: abilitiesAt(100) }) }), ctx);
    const evs = deriver.snapshot(makeSnap(2, 101, { you: you({ abilities: abilitiesAt(100) }) }), ctx);
    expect(evs.filter((e) => e.t === 'abilityReady')).toHaveLength(0);
  });

  it('REGRESSION: cooldown comparisons key off matchTick and are unaffected by snap.tick drift', () => {
    const deriver = createDeriver();
    const ctx = makeCtx();
    const abilitiesAt = (cd: number) => [ability(1, cd), ability(1, 0), ability(1, 0), ability(1, 0)] as const;

    // Case A: snap.tick (sequence number) advances a LOT; matchTick does not
    // advance past cdUntilTick. A bug comparing against `tick` would wrongly fire.
    const cdA = 5;
    deriver.snapshot(makeSnap(1, 1, { you: you({ abilities: abilitiesAt(cdA) }) }), ctx);
    const evsA = deriver.snapshot(makeSnap(10, 2, { you: you({ abilities: abilitiesAt(cdA) }) }), ctx);
    expect(evsA.filter((e) => e.t === 'abilityReady')).toHaveLength(0);

    deriver.reset();

    // Case B: matchTick jumps well past cdUntilTick; snap.tick advances by
    // only the minimum (+1) and stays numerically far below cdUntilTick. A
    // bug comparing against `tick` would wrongly MISS this.
    const cdB = 100;
    deriver.snapshot(makeSnap(1, 1, { you: you({ abilities: abilitiesAt(cdB) }) }), ctx);
    const evsB = deriver.snapshot(makeSnap(2, 150, { you: you({ abilities: abilitiesAt(cdB) }) }), ctx);
    expect(evsB.filter((e) => e.t === 'abilityReady')).toEqual([{ t: 'abilityReady', slot: 0 }]);
  });

  it('REGRESSION: respawn keys off matchTick and is unaffected by snap.tick drift', () => {
    const deriver = createDeriver();
    const ctx = makeCtx();
    deriver.snapshot(makeSnap(1, 10, { you: you({ respawnAtTick: 200 }) }), ctx);

    // snap.tick jumps hugely; matchTick has not yet reached respawnAtTick.
    const stillRespawning = deriver.snapshot(makeSnap(50, 150, { you: you({ respawnAtTick: 200 }) }), ctx);
    expect(stillRespawning.filter((e) => e.t === 'respawn')).toHaveLength(0);

    // matchTick now passes respawnAtTick and the server clears it -> respawn.
    const nowRespawned = deriver.snapshot(makeSnap(51, 201, { you: you({ respawnAtTick: 0 }) }), ctx);
    expect(nowRespawned.filter((e) => e.t === 'respawn')).toEqual([{ t: 'respawn' }]);
  });
});

// ---------------------------------------------------------------------------
// output cap
// ---------------------------------------------------------------------------

describe('createDeriver — output cap', () => {
  it('DERIVE.maxPerSnap caps bursts and drops least-important events first', () => {
    const deriver = createDeriver();
    const ctx = makeCtx();
    const burstSize = 30;

    deriver.snapshot(makeSnap(1, 1, { you: you({ gold: 1000, level: 1 }) }), ctx);

    const burstEnts = Array.from({ length: burstSize }, (_, i) => ent(200 + i, 'melee', { atk: 999, x: i, z: 0 }));
    const evs = deriver.snapshot(
      makeSnap(2, 2, {
        ents: burstEnts,
        // +5 gold: >= goldMinDelta, < lastHitMinGold -> exactly one 'gold' (P3)
        // level 1 -> 2 -> exactly one 'levelUp' (P2)
        you: you({ gold: 1005, level: 2 }),
      }),
      ctx,
    );

    expect(evs).toHaveLength(DERIVE.maxPerSnap);
    const counts = new Map<string, number>();
    for (const e of evs) counts.set(e.t, (counts.get(e.t) ?? 0) + 1);

    // higher-priority events (gold P3, levelUp P2) must survive the cull...
    expect(counts.get('gold')).toBe(1);
    expect(counts.get('levelUp')).toBe(1);
    // ...at the expense of the least-important events (attack, P5): 30
    // generated, only maxPerSnap - 2 of them fit.
    expect(counts.get('attack')).toBe(DERIVE.maxPerSnap - 2);
  });
});

// ---------------------------------------------------------------------------
// wire() — wire event mapping
// ---------------------------------------------------------------------------

describe('createDeriver — wire()', () => {
  it('rift_pick with hero: null (a deselect) emits nothing', () => {
    const deriver = createDeriver();
    const ctx = makeCtx();
    const evs = deriver.wire({ t: 'rift_pick', id: 'p1', hero: null }, null, ctx);
    expect(evs).toEqual([]);
  });

  it('REGRESSION: heroDeath.friendly resolves correctly for an ally, an enemy, and an unresolvable victim', () => {
    const deriver = createDeriver();
    const ctx = makeCtx({ selfPid: 'me', selfTeam: 0 });

    const board: readonly BoardEntry[] = [
      { id: 'ally1', hero: 'bullwark', team: 0, level: 1, kills: 0, deaths: 0, assists: 0, bot: false, connected: true },
      { id: 'enemy1', hero: 'reaver', team: 1, level: 1, kills: 0, deaths: 0, assists: 0, bot: false, connected: true },
    ];
    const snap = makeSnap(1, 1, { board });

    const allyDeath = deriver.wire(
      { t: 'rift_kill', killer: 'enemy1', victim: 'ally1', gold: 0, firstBlood: false },
      snap,
      ctx,
    );
    expect(allyDeath).toHaveLength(1);
    expect(allyDeath[0]).toMatchObject({ t: 'heroDeath', friendly: true });

    const enemyDeath = deriver.wire(
      { t: 'rift_kill', killer: 'ally1', victim: 'enemy1', gold: 200, firstBlood: false },
      snap,
      ctx,
    );
    expect(enemyDeath).toHaveLength(1);
    expect(enemyDeath[0]).toMatchObject({ t: 'heroDeath', friendly: false });

    const unresolvable = deriver.wire(
      { t: 'rift_kill', killer: null, victim: 'ghost-pid', gold: 0, firstBlood: false },
      snap,
      ctx,
    );
    expect(unresolvable).toHaveLength(1);
    expect(unresolvable[0]).toMatchObject({ t: 'heroDeath', friendly: false });
  });

  it('rift_cast for an item active only populates item for the local player', () => {
    const deriver = createDeriver();
    const meCtx = makeCtx({ selfPid: 'me' });

    const selfEnt = ent(500, 'hero', { hero: 'bullwark', pid: 'me' });
    const snapSelf = makeSnap(1, 1, { ents: [selfEnt], you: you({ items: ['blinkstone', null, null, null, null, null] }) });
    const selfEvs = deriver.wire({ t: 'rift_cast', id: 500, slot: 4, x: 0, z: 0 }, snapSelf, meCtx);
    expect(selfEvs).toHaveLength(1);
    expect(selfEvs[0]).toMatchObject({ t: 'cast', hero: null, item: 'blinkstone', self: true });

    const otherEnt = ent(501, 'hero', { hero: 'reaver', pid: 'other' });
    const snapOther = makeSnap(1, 1, { ents: [otherEnt] });
    const otherEvs = deriver.wire({ t: 'rift_cast', id: 501, slot: 4, x: 0, z: 0 }, snapOther, meCtx);
    expect(otherEvs).toHaveLength(1);
    expect(otherEvs[0]).toMatchObject({ t: 'cast', hero: null, item: null, self: false });
  });

  it('rift_cast for all 24 hero/slot combinations produces the documented CastColour and ult flag', () => {
    interface CastExpectation {
      readonly colour: CastColour;
      readonly ult: boolean;
    }

    // Derived by hand from shared/src/hero.ts's ability effect lists against
    // the precedence documented on CastColour: damage(physical) > damage(magic)
    // > heal > dash > stun|slow(control) > summon > buff.
    const CAST_EXPECT: Readonly<Record<HeroId, readonly CastExpectation[]>> = {
      bullwark: [
        { colour: 'physical', ult: false }, // Shield Crash: dash + physical damage + stun
        { colour: 'buff', ult: false }, // Bulwark: passive armour aura
        { colour: 'magic', ult: false }, // Ground Slam: magic damage + slow
        { colour: 'heal', ult: true }, // Rally: heal + armour aura
      ],
      longbow: [
        { colour: 'physical', ult: false }, // Piercing Arrow: physical damage
        { colour: 'buff', ult: false }, // Focus: passive attack-speed aura
        { colour: 'magic', ult: false }, // Frost Arrow: magic damage + slow
        { colour: 'magic', ult: true }, // Rain of Arrows: magic damage + slow
      ],
      reaver: [
        { colour: 'physical', ult: false }, // Cleave: physical damage
        { colour: 'buff', ult: false }, // Frenzy: attack-speed aura
        { colour: 'physical', ult: false }, // Lunge: dash + physical damage
        { colour: 'physical', ult: true }, // Dismember: physical damage + stun
      ],
      hex: [
        { colour: 'magic', ult: false }, // Hexbolt: magic damage
        { colour: 'magic', ult: false }, // Cripple: magic damage + slow
        { colour: 'dash', ult: false }, // Blink: dash only
        { colour: 'magic', ult: true }, // Annihilate: magic damage + stun
      ],
      mender: [
        { colour: 'heal', ult: false }, // Mend: heal
        { colour: 'magic', ult: false }, // Smite: magic damage + slow
        { colour: 'heal', ult: false }, // Sanctuary: heal + regen aura
        { colour: 'heal', ult: true }, // Guardian: heal + armour aura
      ],
      shade: [
        { colour: 'physical', ult: false }, // Shadow Strike: dash + physical damage
        { colour: 'magic', ult: false }, // Smoke: magic damage + slow
        { colour: 'buff', ult: false }, // Mark: passive damage aura
        { colour: 'summon', ult: true }, // Phantoms: summon + move-speed aura
      ],
    };

    const HEROES: readonly HeroId[] = ['bullwark', 'longbow', 'reaver', 'hex', 'mender', 'shade'];
    const ents = HEROES.map((h, i) => ent(100 + i, 'hero', { hero: h }));
    const snap = makeSnap(1, 1, { ents });
    const ctx = makeCtx();
    const deriver = createDeriver();

    for (let i = 0; i < HEROES.length; i++) {
      const h = HEROES[i];
      if (h === undefined) throw new Error('unreachable: index within HEROES bounds');
      const id = 100 + i;
      const expectations = CAST_EXPECT[h];
      for (let slotIdx = 0; slotIdx < 4; slotIdx++) {
        const expected = expectations[slotIdx];
        if (expected === undefined) throw new Error(`missing cast fixture for ${h}.${slotIdx}`);
        const evs = deriver.wire({ t: 'rift_cast', id, slot: slotIdx, x: 0, z: 0 }, snap, ctx);
        expect(evs).toHaveLength(1);
        expect(evs[0]).toMatchObject({ t: 'cast', hero: h, slot: slotIdx, colour: expected.colour, ult: expected.ult });
      }
    }
  });
});

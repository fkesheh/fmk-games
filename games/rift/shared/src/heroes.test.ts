// ============================================================================
// ANCIENTS (rift) — HERO ROSTER SCHEMA GATE.
//
// Mechanical validation of the frozen HERO_LIST data (CONTRACT §12 T2): the
// roster covers every HeroId exactly once, abilities follow the frozen schema
// (4 per hero, slot 3 is the ult, per-rank array lengths == maxRank, passives
// are aura-only with duration 0, ids unique and hero-prefixed, targeting
// 'unit' <=> targetTeam present), and heroById/isHeroId behave.
//
// Frozen data under test: hero.ts / ability.ts are Layer-1 IMMUTABLE. If a
// law fails, report the measured values — never edit the data.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { HERO_LIST, heroById, isHeroId } from '@rift/shared';
import type { AbilityDef, Effect, HeroId } from '@rift/shared';

/** The full HeroId union, restated as data so roster drift fails here. Adding
 *  a hero to the union without adding it to HERO_LIST breaks this array's
 *  type — that is the point. */
const EXPECTED_HERO_IDS: readonly HeroId[] = [
  'bullwark',
  'longbow',
  'reaver',
  'hex',
  'mender',
  'shade',
];

/** Every per-rank array field an Effect variant carries, with its extractor. */
function perRankArrays(effect: Effect): readonly (readonly [string, readonly number[]])[] {
  switch (effect.kind) {
    case 'damage':
      return [['damage.amount', effect.amount]];
    case 'heal':
      return [['heal.amount', effect.amount]];
    case 'stun':
      return [['stun.duration', effect.duration]];
    case 'slow':
      return [
        ['slow.pct', effect.pct],
        ['slow.duration', effect.duration],
      ];
    case 'dash':
      return []; // dash.distance is documented scalar
    case 'aura':
      return [['aura.amount', effect.amount]]; // radius/duration are scalar
    case 'summon':
      return [
        ['summon.count', effect.count],
        ['summon.duration', effect.duration],
      ];
  }
}

describe('hero roster registry', () => {
  it('contains every HeroId exactly once', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const hero of HERO_LIST) {
      if (seen.has(hero.id)) duplicates.push(hero.id);
      seen.add(hero.id);
    }
    expect(
      duplicates,
      `duplicate hero entries in HERO_LIST: ${duplicates.join(', ')}`,
    ).toEqual([]);

    const missing = EXPECTED_HERO_IDS.filter((id) => !seen.has(id));
    expect(
      missing,
      `HERO_LIST is missing HeroIds: ${missing.join(', ')} — the roster drifted from the union`,
    ).toEqual([]);

    const extras = [...seen].filter(
      (id) => !(EXPECTED_HERO_IDS as readonly string[]).includes(id),
    );
    expect(
      extras,
      `HERO_LIST holds ids not in the HeroId union: ${extras.join(', ')}`,
    ).toEqual([]);
  });

  it('heroById returns the def for every id and throws on an unknown id', () => {
    for (const id of EXPECTED_HERO_IDS) {
      const def = heroById(id);
      expect(def.id, `heroById('${id}') returned def with id '${def.id}'`).toBe(id);
    }
    expect(() => heroById('not-a-hero' as HeroId)).toThrowError(/unknown hero/);
  });

  it('isHeroId accepts exactly the roster ids', () => {
    for (const id of EXPECTED_HERO_IDS) {
      expect(isHeroId(id), `isHeroId('${id}') should be true`).toBe(true);
    }
    const bad: readonly unknown[] = ['BULLWARK', '', 'not-a-hero', 3, null, undefined, {}, []];
    for (const v of bad) {
      expect(isHeroId(v), `isHeroId(${JSON.stringify(v)}) should be false`).toBe(false);
    }
  });
});

describe('hero ability schema', () => {
  it('every hero has name/blurb and exactly 4 abilities', () => {
    for (const hero of HERO_LIST) {
      expect(hero.name.length, `${hero.id}: name must be non-empty`).toBeGreaterThan(0);
      expect(hero.blurb.length, `${hero.id}: blurb must be non-empty`).toBeGreaterThan(0);
      expect(
        hero.abilities.length,
        `${hero.id}: expected exactly 4 abilities (q/w/e/r), found ${hero.abilities.length}`,
      ).toBe(4);
    }
  });

  it('slot 3 is the ult (ult:true, maxRank 2); slots 0-2 are not (ult:false, maxRank 4)', () => {
    for (const hero of HERO_LIST) {
      hero.abilities.forEach((ab: AbilityDef, slot: number) => {
        const wantUlt = slot === 3;
        const wantRank = slot === 3 ? 2 : 4;
        expect(
          ab.ult,
          `${hero.id} slot ${slot} (${ab.id}): expected ult:${wantUlt}, found ult:${ab.ult}`,
        ).toBe(wantUlt);
        expect(
          ab.maxRank,
          `${hero.id} slot ${slot} (${ab.id}): expected maxRank ${wantRank}, found ${ab.maxRank}`,
        ).toBe(wantRank);
      });
    }
  });

  it('every per-rank array has length == maxRank', () => {
    const failures: string[] = [];
    for (const hero of HERO_LIST) {
      for (const ab of hero.abilities) {
        const fields: readonly (readonly [string, readonly number[] | undefined])[] = [
          ['castRange', ab.castRange],
          ['cooldown', ab.cooldown],
          ['manaCost', ab.manaCost],
          ['aoeRadius', ab.aoeRadius], // optional, but per-rank when present
        ];
        for (const [field, arr] of fields) {
          if (arr === undefined) continue;
          if (arr.length !== ab.maxRank) {
            failures.push(
              `${ab.id}.${field}: length ${arr.length} != maxRank ${ab.maxRank} — [${arr.join(', ')}]`,
            );
          }
        }
        for (const effect of ab.effects) {
          for (const [field, arr] of perRankArrays(effect)) {
            if (arr.length !== ab.maxRank) {
              failures.push(
                `${ab.id}.${field}: length ${arr.length} != maxRank ${ab.maxRank} — [${arr.join(', ')}]`,
              );
            }
          }
        }
      }
    }
    expect(
      failures,
      `per-rank array length violations:\n  ${failures.join('\n  ')}`,
    ).toEqual([]);
  });

  it('passives carry only aura effects, and those auras have duration 0', () => {
    const failures: string[] = [];
    for (const hero of HERO_LIST) {
      for (const ab of hero.abilities) {
        if (!ab.isPassive) continue;
        for (const effect of ab.effects) {
          if (effect.kind !== 'aura') {
            failures.push(
              `${ab.id}: passive carries a '${effect.kind}' effect — passives are aura-only`,
            );
          } else if (effect.duration !== 0) {
            failures.push(
              `${ab.id}: passive aura has duration ${effect.duration} — passives must be permanent (0)`,
            );
          }
        }
      }
    }
    expect(failures, `passive schema violations:\n  ${failures.join('\n  ')}`).toEqual([]);
  });

  it('ability ids are unique across the roster and prefixed with the hero id', () => {
    const seen = new Set<string>();
    const failures: string[] = [];
    for (const hero of HERO_LIST) {
      for (const ab of hero.abilities) {
        if (seen.has(ab.id)) failures.push(`duplicate ability id '${ab.id}'`);
        seen.add(ab.id);
        if (!ab.id.startsWith(`${hero.id}_`)) {
          failures.push(`${ab.id}: not prefixed with hero id '${hero.id}_'`);
        }
      }
    }
    expect(failures, `ability id problems:\n  ${failures.join('\n  ')}`).toEqual([]);
  });

  it("targeting 'unit' <=> targetTeam present", () => {
    const failures: string[] = [];
    for (const hero of HERO_LIST) {
      for (const ab of hero.abilities) {
        if (ab.targeting === 'unit' && ab.targetTeam === undefined) {
          failures.push(`${ab.id}: targeting 'unit' but targetTeam is absent`);
        }
        if (ab.targeting !== 'unit' && ab.targetTeam !== undefined) {
          failures.push(
            `${ab.id}: targeting '${ab.targeting}' but targetTeam '${ab.targetTeam}' is present`,
          );
        }
      }
    }
    expect(
      failures,
      `targeting/targetTeam mismatches:\n  ${failures.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every ability has non-empty name, icon and blurb', () => {
    for (const hero of HERO_LIST) {
      for (const ab of hero.abilities) {
        expect(ab.name.length, `${ab.id}: name must be non-empty`).toBeGreaterThan(0);
        expect(ab.icon.length, `${ab.id}: icon glyph must be non-empty`).toBeGreaterThan(0);
        expect(ab.blurb.length, `${ab.id}: blurb must be non-empty`).toBeGreaterThan(0);
      }
    }
  });
});

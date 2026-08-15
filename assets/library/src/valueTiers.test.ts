// The value ladder law (STYLE_BIBLE): …Lit >= base + 8 L*, …Deep <= base - 8 L*.
// If this fails, the ART DIRECTION is broken, not the test.
import { describe, expect, it } from 'vitest';
import { L } from '@platform/shared/color';
import { TREE_PALETTE, VALUE_LADDERS, LADDER_STEP } from './kit/palette';

describe('value ladders', () => {
  it('every ladder descends monotonically', () => {
    for (const ladder of VALUE_LADDERS) {
      const values = ladder.map((k) => L(TREE_PALETTE[k]));
      for (let i = 1; i < values.length; i++) {
        expect(values[i]!, `${ladder[i]} must be darker than ${ladder[i - 1]}`)
          .toBeLessThan(values[i - 1]!);
      }
    }
  });

  it('…Lit clears base + 8 L* and …Deep clears base - 8 L*', () => {
    for (const ladder of VALUE_LADDERS) {
      const base = L(TREE_PALETTE[ladder[1]!]); // index 1 = base by naming law
      const lit = ladder[0]!;
      const deep = ladder[ladder.length - 1]!;
      expect(L(TREE_PALETTE[lit]) - base, `${lit} must clear base+${LADDER_STEP}`).toBeGreaterThanOrEqual(LADDER_STEP);
      expect(base - L(TREE_PALETTE[deep]), `${deep} must clear base-${LADDER_STEP}`).toBeGreaterThanOrEqual(LADDER_STEP);
    }
  });
});

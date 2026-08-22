// Wind contract: every tree has aBend populated, bases stay stiff (aBend <
// 0.15 near ground) and tips actually move (max aBend >= 0.6). The merged
// geometry must carry color + aBend on every vertex.
import { describe, expect, it } from 'vitest';
import { ASSETS } from './registry';

describe('wind rigging', () => {
  for (const asset of ASSETS) {
    it(`${asset.meta.id} hero: aBend rigging present and grounded`, () => {
      const built = asset.build('hero');
      const g = built.mesh.geometry;
      const bend = g.getAttribute('aBend');
      const color = g.getAttribute('color');
      const pos = g.getAttribute('position');
      expect(bend).toBeDefined();
      expect(color).toBeDefined();

      let maxBend = 0;
      let baseBendMax = 0;
      for (let i = 0; i < bend.count; i++) {
        const b = bend.getX(i);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThanOrEqual(1.01);
        maxBend = Math.max(maxBend, b);
        if (pos.getY(i) < 0.25) baseBendMax = Math.max(baseBendMax, b);
      }
      expect(maxBend, `${asset.meta.id} never moves — wind is dead`).toBeGreaterThanOrEqual(0.6);
      expect(baseBendMax, `${asset.meta.id} trunk base sways — grounding broken`).toBeLessThan(0.15);
      expect(color.count).toBe(pos.count); // every vertex colored
    });
  }
});

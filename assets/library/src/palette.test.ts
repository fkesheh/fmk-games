// The palette law: ALL colors trace to TREE_PALETTE. This scans every species
// source for hex literals — any hex outside kit/palette.ts is a contract
// violation (mirrors the house check-readiness pattern of valueLadder tests).
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const treesDir = fileURLToPath(new URL('./trees', import.meta.url));

describe('palette traceability', () => {
  it('species sources contain no ad-hoc hex literals', () => {
    const files = readdirSync(treesDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(path.join(treesDir, f), 'utf8');
      const hexes = src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      expect(hexes, `${f} contains ad-hoc hex: ${hexes.join(', ')}`).toHaveLength(0);
    }
  });

  it('every TREE_PALETTE entry is a valid 6-digit hex', async () => {
    const { TREE_PALETTE } = await import('./kit/palette');
    for (const [key, value] of Object.entries(TREE_PALETTE)) {
      expect(value).toMatch(/^#[0-9a-fA-F]{6}$/);
      void key;
    }
  });
});

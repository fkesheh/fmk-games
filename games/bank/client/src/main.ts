// ============================================================================
// BANK client boot — mounts the game into #app. All logic lives in game.ts;
// dice rendering in dice.ts, sound in audio.ts (frozen signatures, docs/BANK.md).
// A boot failure surfaces as a visible banner instead of a white screen.
//
// Also mirrors the frozen BPAL palette (@bank/shared) onto the CSS custom
// properties named by BPAL_CSS_VARS. The palette is the ONE source of truth for
// BANK colour (VISUAL_UPGRADE.md §5); style.css carries :root fallbacks that
// must equal BPAL, and this runtime write is what keeps a divergence from ever
// mattering. Applied at module load, before any DOM exists — so the very first
// paint, and the error banner on a boot failure, already see the real values.
// ============================================================================
import { BPAL, BPAL_CSS_VARS } from '@bank/shared';
import type { BankPaletteKey } from '@bank/shared';
import { BankGame } from './game.js';

function applyPaletteVars(): void {
  const rootStyle = document.documentElement.style;
  for (const [key, cssVar] of Object.entries(BPAL_CSS_VARS) as ReadonlyArray<
    readonly [BankPaletteKey, string]
  >) {
    rootStyle.setProperty(cssVar, BPAL[key]);
  }
}

applyPaletteVars();

function showError(text: string): void {
  const banner = document.createElement('div');
  banner.className = 'error-banner';
  banner.textContent = text;
  document.body.appendChild(banner);
}

window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
  showError(`Error: ${ev.reason instanceof Error ? ev.reason.message : String(ev.reason)}`);
});

try {
  const root = document.getElementById('app');
  if (root === null) throw new Error('missing #app element');
  new BankGame(root);
} catch (err) {
  showError(`Boot failed: ${err instanceof Error ? err.message : String(err)}`);
}

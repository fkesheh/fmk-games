// ============================================================================
// WORDBOMB client boot — mounts the game into #app. All logic lives in game.ts
// (which owns the DOM, the socket and the §4.3 `window.__wordbomb` debug
// surface); sound in audio.ts. A boot failure surfaces as a visible banner
// instead of a white screen.
//
// Also mirrors the frozen WPAL palette (@wordbomb/shared) onto the CSS custom
// properties named by WPAL_CSS_VARS. The palette is the ONE source of truth for
// WORDBOMB colour; style.css carries :root fallbacks that must equal WPAL, and
// this runtime write is what keeps a divergence from ever mattering. Applied at
// module load, before any DOM exists — so the very first paint, and the error
// banner on a boot failure, already see the real values.
// ============================================================================
import { WPAL, WPAL_CSS_VARS } from '@wordbomb/shared';
import type { WordbombPaletteKey } from '@wordbomb/shared';
import { boot } from './game.js';

function applyPaletteVars(): void {
  const rootStyle = document.documentElement.style;
  for (const [key, cssVar] of Object.entries(WPAL_CSS_VARS) as ReadonlyArray<
    readonly [WordbombPaletteKey, string]
  >) {
    rootStyle.setProperty(cssVar, WPAL[key]);
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
  boot(root);
} catch (err) {
  showError(`Boot failed: ${err instanceof Error ? err.message : String(err)}`);
}

// ============================================================================
// KART GP client boot — mounts the app into #app. All logic lives in app.ts;
// driving in drive.ts, rendering in render.ts, sound in audio.ts (frozen
// signatures, docs/KART.md). A boot failure surfaces as a visible banner
// instead of a white screen.
//
// This file also owns the KPAL -> CSS custom property mirror (VISUAL_UPGRADE.md
// §7, K7). style.css used to restate a handful of palette hexes by hand in
// :root, which is a second source of truth that silently drifts. Instead we
// walk the frozen KPAL and publish EVERY entry onto documentElement at module
// load, before KartApp builds any DOM: --<kebab-case key> for the hex and
// --<kebab-case key>-rgb for the bare channels rgba() needs. The mirror is a
// strict superset of what the stylesheet reads, so the CSS can never name a
// palette colour that does not exist, and the :root literals in style.css act
// purely as pre-boot fallbacks that this pass overwrites with the real palette.
// ============================================================================
import { KPAL } from '@kart/shared';
import { KartApp } from './app.js';

// asphaltDeep -> asphalt-deep. KPAL keys are camelCase with no digits.
function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

// '#4a5058' -> '74, 80, 88' — rgba() needs channels, and writing an rgb()
// literal in the stylesheet would reintroduce the hex this mirror removes.
function rgbChannels(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}`;
}

function applyPaletteVars(): void {
  const rootStyle = document.documentElement.style;
  for (const [key, hex] of Object.entries(KPAL)) {
    const name = kebab(key);
    rootStyle.setProperty(`--${name}`, hex);
    rootStyle.setProperty(`--${name}-rgb`, rgbChannels(hex));
  }
  // Legacy alias: style.css has always called KPAL.hudText "--cream". Kept as a
  // derived alias (never a literal) so the name survives without a second hex.
  rootStyle.setProperty('--cream', KPAL.hudText);
  rootStyle.setProperty('--cream-rgb', rgbChannels(KPAL.hudText));
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
  new KartApp(root);
} catch (err) {
  showError(`Boot failed: ${err instanceof Error ? err.message : String(err)}`);
}

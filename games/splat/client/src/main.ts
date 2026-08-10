// ============================================================================
// SKI SPLAT client boot — the SPAL -> CSS custom property mirror and the boot
// error banner. Pattern cloned from kart's main.ts: walk the frozen SPAL and
// publish every entry onto documentElement as --<kebab> (+ -rgb channels), so
// style.css and ui/hud.css can never name a palette colour that does not
// exist. Task C2's SplatApp (./app.js) is mounted below.
// ============================================================================
import { SPAL } from '@splat/shared';
import { SplatApp } from './app.js';

// snowLit -> snow-lit. SPAL keys are camelCase with no digits.
function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

// '#10141c' -> '16, 20, 28' — rgba() needs bare channels.
function rgbChannels(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}`;
}

function applyPaletteVars(): void {
  const rootStyle = document.documentElement.style;
  for (const [key, hex] of Object.entries(SPAL)) {
    const name = kebab(key);
    rootStyle.setProperty(`--${name}`, hex);
    rootStyle.setProperty(`--${name}-rgb`, rgbChannels(hex));
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
  new SplatApp(root);
} catch (err) {
  showError(`Error: ${err instanceof Error ? err.message : String(err)}`);
}

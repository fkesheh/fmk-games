// ============================================================================
// SKI SPLAT client boot — the SPAL -> CSS custom property mirror and the boot
// error banner. Pattern cloned from kart's main.ts: walk the frozen SPAL and
// publish every entry onto documentElement as --<kebab> (+ -rgb channels), so
// style.css and ui/hud.css can never name a palette colour that does not
// exist. Task C2 owns app.ts and mounts SplatApp here; until it lands, the
// boot shows the palette splash below (a real loading screen, not a stub).
// ============================================================================
import { SPAL } from '@splat/shared';

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
  // C2 replaces this splash with `new SplatApp(root)`.
  const splash = document.createElement('div');
  splash.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    `color:${SPAL.paper};font:600 20px/1.4 system-ui,sans-serif;letter-spacing:0.12em`;
  splash.textContent = 'SKI SPLAT';
  root.appendChild(splash);
} catch (err) {
  showError(`Error: ${err instanceof Error ? err.message : String(err)}`);
}

// ============================================================================
// ANCIENTS (rift) — main.ts. ORCHESTRATOR-OWNED wiring (CONTRACT §6): palette
// CSS vars, rejection banner, boot. No game logic lives here.
// ============================================================================
import { APAL, APAL_CSS_VARS, type AncientsPaletteKey } from '@rift/shared';
import { wire } from './wire.js';

// Mirror the palette onto CSS custom properties (style.css carries the same
// values as pre-boot fallbacks).
const rootStyle = document.documentElement.style;
for (const key of Object.keys(APAL) as AncientsPaletteKey[]) {
  rootStyle.setProperty(APAL_CSS_VARS[key], APAL[key]);
}

function showErrorBanner(message: string): void {
  const el = document.createElement('div');
  el.className = 'error-banner';
  el.textContent = message;
  document.body.appendChild(el);
}

window.addEventListener('unhandledrejection', (ev) => {
  showErrorBanner('Something went wrong. Reload to rejoin your match.');
  console.error(ev.reason);
});

const app = document.getElementById('app');
if (!app) {
  showErrorBanner('Boot failed: #app missing.');
} else {
  try {
    wire(app);
  } catch (err) {
    console.error(err);
    showErrorBanner('Boot failed. Reload to try again.');
  }
}

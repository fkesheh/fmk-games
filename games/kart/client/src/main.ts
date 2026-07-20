// ============================================================================
// KART GP client boot — mounts the app into #app. All logic lives in app.ts;
// driving in drive.ts, rendering in render.ts, sound in audio.ts (frozen
// signatures, docs/KART.md). A boot failure surfaces as a visible banner
// instead of a white screen.
// ============================================================================
import { KartApp } from './app.js';

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

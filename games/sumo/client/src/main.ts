// ============================================================================
// SUMO boot — mounts the app into #app. All logic lives in app.ts (kart
// precedent). A boot failure surfaces as a visible banner, never a white
// screen. Exposes window.__sumo e2e hooks (specs/P10.md).
// ============================================================================
import { bootApp } from './app.js';

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
  const canvas = document.getElementById('cv') as HTMLCanvasElement | null;
  if (canvas === null) throw new Error('missing #cv canvas');

  document.getElementById('boot')?.classList.add('gone');

  const { app, hooks } = bootApp(canvas, root);
  window.__sumo = hooks;
  app.start();
  window.addEventListener('resize', () => app.resize());

  // first gesture unlocks WebAudio (SynthKit contract)
  const unlock = (): void => {
    app.unlockAudio();
    app.ambientSpace();
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
} catch (err) {
  showError(err instanceof Error ? err.message : String(err));
}

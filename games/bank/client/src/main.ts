// ============================================================================
// BANK client boot — mounts the game into #app. All logic lives in game.ts;
// dice rendering in dice.ts, sound in audio.ts (frozen signatures, docs/BANK.md).
// A boot failure surfaces as a visible banner instead of a white screen.
// ============================================================================
import { BankGame } from './game.js';

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

// ============================================================================
// ACES — C_APP boot shell (main.ts). Mounts the composition root into #app
// and installs the house failure guards (mirrors games/rift/client/src/main.ts
// and games/outpost/client/src/main.ts). No game logic lives here.
// ============================================================================
import './style.css';
import { startAces } from './app.js';

function showError(message: string): void {
  const el = document.createElement('div');
  el.className = 'aces-boot-error';
  el.textContent = message;
  document.body.appendChild(el);
}

window.addEventListener('unhandledrejection', (ev) => {
  console.error('[aces] unhandled rejection:', ev.reason);
});

const app = document.getElementById('app');
if (app === null) {
  showError('Boot failed: #app missing.');
} else {
  try {
    startAces(app);
  } catch (err) {
    console.error(err);
    showError(`Boot failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

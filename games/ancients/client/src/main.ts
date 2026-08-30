// ============================================================================
// ANCIENTS·SDK — main.ts. The PLATFORM v2 port shell of ANCIENTS
// (docs/PLATFORM.md §7): same game core (@rift/client modules, same rooms,
// same wire protocol — registered separately under id 'ancients'), but the
// boot path runs through @platform/sdk:
//
//   identity sig → Profiles.ensureDeviceAuth() → profile token
//     → {t:'auth'} after every socket open (stats attribute to the profile)
//     → signed-in chip + cross-device claim-code link.
//
// Legacy /rift/ stays untouched and anonymous; this shell is additive.
// ============================================================================
import { APAL, APAL_CSS_VARS, type AncientsPaletteKey } from '@rift/shared';
import { wire } from '@rift/client/wire.js';
import { Profiles } from '@platform/sdk/profile.js';

const GAME_ID = 'ancients';

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

/** Tiny corner chip: signed-in state + device-link prompt. */
function mountProfileChip(profiles: Profiles): void {
  const me = profiles.me();
  const chip = document.createElement('div');
  chip.id = 'profile-chip';
  chip.textContent = me === null ? 'guest · linking…' : `signed in as ${me.name}`;
  chip.addEventListener('click', async () => {
    try {
      const code = await profiles.claimCode();
      window.prompt(`On another device open ANCIENTS·SDK and enter this code (valid 10 min):`, code);
    } catch {
      window.alert('Sign-in unavailable right now.');
    }
  });
  document.body.appendChild(chip);
}

async function boot(): Promise<void> {
  const app = document.getElementById('app');
  if (app === null) {
    showErrorBanner('Boot failed: #app missing.');
    return;
  }

  // ---- SDK identity/auth bootstrap -----------------------------------------
  let onOpenExtra: (() => readonly unknown[]) | undefined;
  let profiles: Profiles | null = null;
  try {
    profiles = new Profiles(null); // standalone REST use — no second socket
    await profiles.ensureDeviceAuth(); // mints or restores the profile token
    const token = profiles.token();
    if (token !== null) onOpenExtra = () => [{ t: 'auth', token }] as const;
    if (profiles.me() !== null) mountProfileChip(profiles);
  } catch (err) {
    console.warn('[ancients] profile bootstrap unavailable — continuing anonymous', err);
  }

  // ---- the game itself (reused ANCIENTS core) -------------------------------
  wire(app, { gameId: GAME_ID, ...(onOpenExtra !== undefined ? { onOpenExtra } : {}) });

  // Alias the frozen debug surface for the e2e + ?debug parity with legacy.
  const w = window as typeof window & { __rift?: unknown };
  if (w.__rift !== undefined) {
    (window as typeof window & { __ancients?: unknown }).__ancients = w.__rift;
  }
}

boot().catch((err) => {
  console.error(err);
  showErrorBanner('Boot failed. Reload to try again.');
});

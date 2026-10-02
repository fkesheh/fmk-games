// ============================================================================
// ANCIENTS·SDK shell tests (platform v2 port, docs/PLATFORM.md §7).
//
// SEAM: main.ts is glue with top-level side effects (palette loop, boot() on
// import), so each test installs a minimal DOM stub, scripts the SDK + wire
// mocks, and re-imports the module fresh (vi.resetModules + dynamic import).
// The rift client core (wire) and the SDK Profiles facade are BOTH mocked —
// their own suites cover their behavior; this file's job is the SHELL's
// orchestration: auth-after-open wiring, anonymous fallback, the profile
// chip, the __ancients alias, and boot failure handling. Runs under vitest's
// plain `node` environment — no jsdom; the stub below is the whole DOM the
// shell touches (documentElement/style, createElement, body, #app, window
// listeners/prompt/alert).
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APAL, APAL_CSS_VARS, type AncientsPaletteKey } from '@rift/shared';

const state = vi.hoisted(() => ({
  /** Profiles.ensureDeviceAuth behavior for the next boot. */
  profilesMode: 'auth' as 'auth' | 'anon' | 'throw' | 'claimThrow',
  token: 'tok-test-1',
  claimCode: 'C0DE12',
  /** wire() calls: [root, opts] per invocation. */
  wireCalls: [] as Array<[unknown, unknown]>,
  /** When true the mocked wire() installs window.__rift (debug surface up). */
  wireSetsRiftApi: true,
}));

vi.mock('@rift/client/wire.js', () => ({
  wire: (root: unknown, opts: unknown) => {
    state.wireCalls.push([root, opts]);
    if (state.wireSetsRiftApi) {
      (globalThis as unknown as { __setRiftApi?: () => void }).__setRiftApi?.();
    }
  },
}));

vi.mock('@platform/sdk/profile.js', () => ({
  Profiles: class FakeProfiles {
    constructor(_ws: unknown) {}
    async ensureDeviceAuth(): Promise<unknown> {
      if (state.profilesMode === 'throw') throw new Error('auth backend down');
      return state.profilesMode === 'anon' ? null : { name: 'Ada' };
    }
    token(): string | null {
      return state.profilesMode === 'auth' || state.profilesMode === 'claimThrow' ? state.token : null;
    }
    me(): { name: string } | null {
      return state.profilesMode === 'auth' || state.profilesMode === 'claimThrow' ? { name: 'Ada' } : null;
    }
    async claimCode(): Promise<string> {
      if (state.profilesMode === 'claimThrow') throw new Error('claim backend down');
      return state.claimCode;
    }
  },
}));

// ---- minimal DOM stub ---------------------------------------------------------

interface StubEl {
  id: string;
  className: string;
  textContent: string;
  listeners: Map<string, Array<(...args: never[]) => unknown>>;
  addEventListener: (t: string, fn: (...args: never[]) => unknown) => void;
}

interface DomStub {
  setProperty: ReturnType<typeof vi.fn>;
  appended: StubEl[];
  prompt: ReturnType<typeof vi.fn>;
  alert: ReturnType<typeof vi.fn>;
  winListeners: Map<string, Array<(...args: never[]) => unknown>>;
  fireChipClick: () => Promise<unknown>;
}

function installDom(appPresent: boolean): DomStub {
  const appended: StubEl[] = [];
  const winListeners = new Map<string, Array<(...args: never[]) => unknown>>();
  const mkEl = (): StubEl => {
    const listeners = new Map<string, Array<(...args: never[]) => unknown>>();
    return {
      id: '',
      className: '',
      textContent: '',
      listeners,
      addEventListener: (t: string, fn: (...args: never[]) => unknown) => {
        const arr = listeners.get(t) ?? [];
        arr.push(fn);
        listeners.set(t, arr);
      },
    };
  };
  const appEl = mkEl();
  const doc = {
    documentElement: { style: { setProperty: vi.fn() } },
    createElement: () => mkEl(),
    body: { appendChild: (el: StubEl) => appended.push(el) },
    getElementById: (id: string) => (id === 'app' && appPresent ? appEl : null),
  };
  const prompt = vi.fn();
  const alert = vi.fn();
  const win = {
    addEventListener: (t: string, fn: (...args: never[]) => unknown) => {
      const arr = winListeners.get(t) ?? [];
      arr.push(fn);
      winListeners.set(t, arr);
    },
    prompt,
    alert,
  };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  (globalThis as unknown as Record<string, unknown>).__setRiftApi = () => {
    (win as unknown as Record<string, unknown>).__rift = { marker: 'rift-debug-api' };
  };
  return {
    setProperty: doc.documentElement.style.setProperty as ReturnType<typeof vi.fn>,
    appended,
    prompt,
    alert,
    winListeners,
    fireChipClick: async () => {
      const chip = appended.find((el) => el.id === 'profile-chip');
      if (chip === undefined) throw new Error('no profile chip mounted');
      const handlers = chip.listeners.get('click') ?? [];
      for (const h of handlers) await h();
    },
  };
}

/** Boot main.ts fresh (top-level side effects re-run) and let boot() settle. */
async function bootFresh(): Promise<void> {
  vi.resetModules();
  await import('./main.js');
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  state.profilesMode = 'auth';
  state.wireCalls = [];
  state.wireSetsRiftApi = true;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (globalThis as unknown as Record<string, unknown>).__setRiftApi;
});

describe('ancients shell boot', () => {
  it('authenticated boot wires the game with auth-after-open + chip + alias', async () => {
    const dom = installDom(true);

    await bootFresh();

    // the game boots against the ancients room id...
    expect(state.wireCalls).toHaveLength(1);
    const [root, opts] = state.wireCalls[0] as [unknown, { gameId: string; onOpenExtra?: () => readonly unknown[] }];
    expect(root).not.toBeNull();
    expect(opts.gameId).toBe('ancients');
    // ...with the SDK identity shell: {t:'auth'} after EVERY socket open.
    expect(typeof opts.onOpenExtra).toBe('function');
    expect(opts.onOpenExtra?.()).toEqual([{ t: 'auth', token: 'tok-test-1' }]);
    // signed-in chip mounted...
    const chip = dom.appended.find((el) => el.id === 'profile-chip');
    expect(chip?.textContent).toBe('signed in as Ada');
    // ...and the frozen debug surface aliased for e2e parity with legacy.
    const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
    expect(win.__ancients).toEqual({ marker: 'rift-debug-api' });
    // palette applied to the root for every theme key.
    expect(dom.setProperty).toHaveBeenCalledTimes(Object.keys(APAL).length);
    const firstKey = Object.keys(APAL)[0] as AncientsPaletteKey;
    expect(dom.setProperty).toHaveBeenCalledWith(APAL_CSS_VARS[firstKey], APAL[firstKey]);
  });

  it('anonymous fallback (null token) boots the game with no auth payload and no chip', async () => {
    state.profilesMode = 'anon';
    installDom(true);

    await bootFresh();

    expect(state.wireCalls).toHaveLength(1);
    const [, opts] = state.wireCalls[0] as [unknown, { gameId: string; onOpenExtra?: unknown }];
    expect(opts.gameId).toBe('ancients');
    expect('onOpenExtra' in (opts as Record<string, unknown>)).toBe(false);
  });

  it('auth backend down: warns, boots anonymous, game still starts', async () => {
    state.profilesMode = 'throw';
    installDom(true);

    await bootFresh();

    expect(console.warn).toHaveBeenCalled();
    expect(state.wireCalls).toHaveLength(1);
    const [, opts] = state.wireCalls[0] as [unknown, Record<string, unknown>];
    expect('onOpenExtra' in opts).toBe(false);
  });

  it('missing #app shows the boot banner and never wires the game', async () => {
    const dom = installDom(false);

    await bootFresh();

    expect(state.wireCalls).toHaveLength(0);
    const banner = dom.appended.find((el) => el.className === 'error-banner');
    expect(banner?.textContent).toBe('Boot failed: #app missing.');
  });

  it('no __ancients alias when the core debug surface is absent', async () => {
    state.wireSetsRiftApi = false;
    installDom(true);

    await bootFresh();

    const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
    expect('__ancients' in win).toBe(false);
  });
});

describe('ancients shell profile chip', () => {
  it('click mints a claim code and prompts with it', async () => {
    const dom = installDom(true);
    await bootFresh();

    await dom.fireChipClick();

    expect(dom.prompt).toHaveBeenCalledTimes(1);
    const [message, code] = dom.prompt.mock.calls[0] as [string, string];
    expect(code).toBe('C0DE12');
    expect(message).toContain('enter this code');
    expect(dom.alert).not.toHaveBeenCalled();
  });

  it('claim backend down: alerts instead of prompting', async () => {
    state.profilesMode = 'claimThrow';
    const dom = installDom(true);
    await bootFresh();

    await dom.fireChipClick();

    expect(dom.prompt).not.toHaveBeenCalled();
    expect(dom.alert).toHaveBeenCalledTimes(1);
  });
});

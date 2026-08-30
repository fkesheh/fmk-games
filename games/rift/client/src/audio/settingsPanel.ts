// ============================================================================
// ANCIENTS (rift) AUDIO — SETTINGS PANEL (AUDIO_CONTRACT.md T14). A
// self-contained `.audio-panel-toggle` speaker glyph opens/closes a
// `.audio-panel` holding four `.audio-panel-row`s of `.audio-panel-slider`s
// (master / sfx / music / ambience) plus a `.audio-panel-mute` checkbox row.
// Nothing else in the client can reach the panel — it owns its own toggle.
//
// DOM CLASS CONTRACT (Audio amendment to games/rift/CONTRACT.md): renders
// only .audio-panel .audio-panel-row .audio-panel-slider .audio-panel-mute
// .audio-panel-toggle. Every other node is classless; T14 styles those via
// descendant selectors, mirroring ui/shop.ts's convention exactly.
//
// Settings are persisted to localStorage under config.ts's STORAGE_KEY
// ('rift.audio') and applied to `audio` BEFORE the panel renders, so the
// mute/volume choice is honoured before the first sound plays (SONIC_BIBLE
// §11). Corrupt or missing localStorage data falls back to DEFAULT_SETTINGS
// silently — never throws, never logs.
// ============================================================================
import type { AudioSettings, RiftAudioHandle } from './contract.js';
import { DEFAULT_SETTINGS, STORAGE_KEY } from './config.js';

export interface AudioSettingsPanel {
  readonly root: HTMLElement;
  setOpen(open: boolean): void;
  destroy(): void;
}

let instanceCounter = 0;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string | null,
  parent: HTMLElement,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls !== null) e.className = cls;
  parent.appendChild(e);
  return e;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function isUnitNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

function isValidSettings(v: unknown): v is AudioSettings {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    isUnitNumber(r.master) &&
    isUnitNumber(r.sfx) &&
    isUnitNumber(r.music) &&
    isUnitNumber(r.ambience) &&
    typeof r.muted === 'boolean'
  );
}

/** Wrapped in try/catch: `localStorage` throws in private-browsing modes,
 * and stored JSON may be corrupt/garbage from an older build. Both degrade
 * silently to "nothing persisted", never a thrown error. */
function loadPersistedSettings(): AudioSettings | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValidSettings(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function persistSettings(s: AudioSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // private-browsing / storage-disabled: settings simply don't survive reload
  }
}

/** `RiftAudioHandle` methods are contractually try/catch'd and never throw,
 * but this panel degrades silently too, in case that promise is ever broken
 * mid-build by a sibling task. */
function readSettings(audio: RiftAudioHandle): AudioSettings {
  try {
    return audio.settings();
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function percentOf(v: number): number {
  return Math.round(clamp01(v) * 100);
}

function buildSliderRow(
  parent: HTMLElement,
  id: string,
  labelText: string,
  value: number,
  onInput: (v: number) => void,
  onCommit: (v: number) => void,
): void {
  const row = el('div', 'audio-panel-row', parent);

  const label = el('label', null, row);
  label.textContent = labelText;
  label.htmlFor = id;

  const input = el('input', 'audio-panel-slider', row);
  input.type = 'range';
  input.min = '0';
  input.max = '100';
  input.step = '1';
  input.id = id;

  const pct = el('span', null, row);
  pct.style.fontSize = '12px';

  const applyDisplay = (v: number): void => {
    const p = percentOf(v);
    input.value = String(p);
    input.setAttribute('aria-valuetext', `${p}%`);
    pct.textContent = `${p}%`;
  };
  applyDisplay(value);

  // live: the gain change applies within one frame while dragging
  input.addEventListener('input', () => {
    const v = clamp01(Number(input.value) / 100);
    applyDisplay(v);
    onInput(v);
  });

  // release: ui.click fires here, not on every 'input' tick
  input.addEventListener('change', () => {
    const v = clamp01(Number(input.value) / 100);
    onCommit(v);
  });
}

/**
 * Builds a self-contained audio settings panel and mounts it into `parent`.
 * `parent` is expected to already exist in the document (mirrors
 * `ui/shop.ts`'s `createShop(parent)` convention) — this factory appends
 * its own wrapper and does not return anything the caller needs to mount.
 */
export function createAudioSettingsPanel(
  parent: HTMLElement,
  audio: RiftAudioHandle,
): AudioSettingsPanel {
  const uid = ++instanceCounter;

  // Apply any persisted user preference BEFORE anything renders, so mute
  // and volume are honoured before the first sound plays (SONIC_BIBLE §11).
  const persisted = loadPersistedSettings();
  if (persisted !== null) {
    try {
      audio.setSettings(persisted);
    } catch {
      // audio degrades to silence per its own contract
    }
  }

  let current: AudioSettings = readSettings(audio);

  // classless wrapper: keeps `.audio-panel-toggle` visible/reachable even
  // while `.audio-panel` itself is display:none (closed)
  const root = el('div', null, parent);

  const panelId = `audio-panel-${uid}`;

  const toggle = el('button', 'audio-panel-toggle', root);
  toggle.type = 'button';
  toggle.setAttribute('aria-label', 'Audio settings');
  toggle.setAttribute('aria-haspopup', 'true');
  toggle.setAttribute('aria-controls', panelId);
  toggle.setAttribute('aria-expanded', 'false');
  toggle.textContent = '🔊';

  const panel = el('div', 'audio-panel', root);
  panel.id = panelId;
  panel.style.display = 'none';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Audio settings');

  const heading = el('b', null, panel);
  heading.textContent = 'AUDIO';
  heading.style.fontSize = '13px';

  const applyLive = (patch: Partial<AudioSettings>): void => {
    current = { ...current, ...patch };
    try {
      audio.setSettings(patch);
    } catch {
      // audio degrades to silence per its own contract
    }
  };

  const commit = (): void => {
    persistSettings(current);
    try {
      audio.ui('click');
    } catch {
      // audio degrades to silence per its own contract
    }
  };

  buildSliderRow(
    panel,
    `${panelId}-master`,
    'Master',
    current.master,
    (v) => applyLive({ master: v }),
    commit,
  );
  buildSliderRow(
    panel,
    `${panelId}-sfx`,
    'SFX',
    current.sfx,
    (v) => applyLive({ sfx: v }),
    commit,
  );
  buildSliderRow(
    panel,
    `${panelId}-music`,
    'Music',
    current.music,
    (v) => applyLive({ music: v }),
    commit,
  );
  buildSliderRow(
    panel,
    `${panelId}-ambience`,
    'Ambience',
    current.ambience,
    (v) => applyLive({ ambience: v }),
    commit,
  );

  const muteRow = el('div', 'audio-panel-row', panel);
  const muteId = `${panelId}-mute`;
  const muteLabel = el('label', null, muteRow);
  muteLabel.textContent = 'Mute';
  muteLabel.htmlFor = muteId;
  const muteInput = el('input', 'audio-panel-mute', muteRow);
  muteInput.type = 'checkbox';
  muteInput.id = muteId;
  muteInput.checked = current.muted;
  muteInput.addEventListener('change', () => {
    applyLive({ muted: muteInput.checked });
    commit();
  });

  let open = false;

  const applyOpenState = (): void => {
    panel.style.display = open ? '' : 'none';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  applyOpenState();

  toggle.addEventListener('click', () => {
    open = !open;
    applyOpenState();
  });

  return {
    root,
    setOpen(o: boolean): void {
      open = o;
      applyOpenState();
    },
    destroy(): void {
      root.remove();
    },
  };
}

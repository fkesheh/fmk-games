// ============================================================================
// SDK PAD PAIRING UI — in-game overlay showing the /pad/ URL + 6-char code
// (docs/PLATFORM.md §4.4). DOM-injected (no QR dep in v1); dismiss() removes
// the node and is idempotent; every method is a safe no-op once dismissed.
// Owner: P7_SDK_INPUT_AUDIO.
// ============================================================================

export interface PadPairOverlay {
  /** Update the displayed code (re-pair after TTL). */
  setCode(code: string): void;
  /** Show bound state ("controller connected"), auto-hide after 2s. */
  bound(): void;
  dismiss(): void;
}

/** Appends a styled overlay to root (default document.body). Returns a no-op
    overlay when there is no DOM (headless/test import safety). */
export function showPadPairing(
  urlPath: string,
  code: string,
  root?: HTMLElement,
): PadPairOverlay {
  if (typeof document === 'undefined') return noopOverlay();

  const doc = document;
  const host = doc.createElement('div');
  host.style.cssText = [
    'position:fixed',
    'right:16px',
    'bottom:16px',
    'z-index:2147483647',
    'background:#14161c',
    'color:#e8eaf0',
    'font-family:system-ui,-apple-system,"Segoe UI",sans-serif',
    'border:1px solid #2a2f3a',
    'border-radius:12px',
    'padding:14px 18px',
    'max-width:280px',
    'box-shadow:0 8px 24px rgba(0,0,0,.45)',
  ].join(';');

  const label = doc.createElement('div');
  label.textContent = 'PHONE CONTROLLER';
  label.style.cssText = 'font-size:11px;font-weight:600;letter-spacing:.12em;color:#8fa3c8;';

  const codeEl = doc.createElement('div');
  codeEl.textContent = code;
  codeEl.style.cssText =
    'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;' +
    'font-size:34px;line-height:1.15;font-weight:700;letter-spacing:.28em;margin-top:4px;white-space:nowrap;';

  const hint = doc.createElement('div');
  hint.textContent = `open ${urlPath} on your phone and enter the code`;
  hint.style.cssText = 'font-size:13px;opacity:.75;margin-top:6px;word-break:break-all;';

  const boundEl = doc.createElement('div');
  boundEl.textContent = 'controller connected';
  boundEl.style.cssText = 'font-size:14px;font-weight:600;color:#7ee787;display:none;padding:6px 0;';

  host.append(label, codeEl, hint, boundEl);
  (root ?? doc.body).appendChild(host);

  let removed = false;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelHide = (): void => {
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  };

  return {
    setCode(c: string): void {
      if (removed) return;
      cancelHide(); // re-pair: back to the pairing view
      codeEl.textContent = c;
      codeEl.style.display = '';
      hint.style.display = '';
      boundEl.style.display = 'none';
    },
    bound(): void {
      if (removed) return;
      cancelHide();
      codeEl.style.display = 'none';
      hint.style.display = 'none';
      boundEl.style.display = '';
      hideTimer = setTimeout(() => {
        hideTimer = null;
        this.dismiss();
      }, 2000);
    },
    dismiss(): void {
      if (removed) return;
      removed = true;
      cancelHide();
      host.remove();
    },
  };
}

function noopOverlay(): PadPairOverlay {
  return { setCode(): void {}, bound(): void {}, dismiss(): void {} };
}

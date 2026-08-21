// ============================================================================
// DEBUG HUD — tiny fps/tick overlay (docs/PLATFORM.md §4.6).
// Owner: P5_ENGINE — implement.
// ============================================================================

import type { DebugRows } from './types.js';

export interface DebugHud {
  update(): void;
  dispose(): void;
}

/** Monospace top-left overlay; rows() re-read each update(). */
export function createDebugHud(rows: DebugRows): DebugHud {
  const el = document.createElement('div');
  const style = el.style;
  style.position = 'fixed';
  style.top = '0';
  style.left = '0';
  style.padding = '6px 8px';
  style.fontFamily = "'SF Mono', Menlo, Consolas, monospace";
  style.fontSize = '11px';
  style.lineHeight = '1.45';
  style.color = '#e8f0ff';
  style.background = 'rgba(10, 14, 22, 0.72)';
  style.borderRadius = '0 0 6px 0';
  style.whiteSpace = 'pre';
  style.pointerEvents = 'none';
  style.userSelect = 'none';
  style.zIndex = '9999';

  document.body.appendChild(el);

  return {
    /** Re-read rows() and repaint. Null/empty rows are hidden, never printed. */
    update(): void {
      const live = rows().filter((r) => r.length > 0);
      el.textContent = live.length > 0 ? live.join('\n') : '';
    },
    /** Remove the overlay from the DOM entirely. */
    dispose(): void {
      el.remove();
    },
  };
}

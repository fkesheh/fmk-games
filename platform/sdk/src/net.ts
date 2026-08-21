// ============================================================================
// SDK CONNECTION — ws facade: envelope passthrough, app-level ping/pong for
// RTT + min-RTT clock offset, optional auto-reconnect w/ backoff + auth
// replay (docs/PLATFORM.md §4.5). Pattern proven in STRICKEN connection.ts.
// Owner: P6_SDK_CORE — implement SdkConnection from types.ts.
// ============================================================================

import type { C2S, LobbyS2C } from '@platform/shared';
import type { SdkConnection } from './types.js';

export class SdkNet implements SdkConnection {
  onMessage: ((msg: LobbyS2C & Record<string, unknown>) => void) | null = null;
  onClose: ((clean: boolean) => void) | null = null;
  onOpen: (() => void) | null = null;

  constructor(
    private readonly opts: { readonly autoReconnect?: boolean; readonly authPayload?: () => C2S | null } = {},
  ) {
    void opts;
  }

  connect(_url?: string): Promise<void> {
    void _url;
    throw new Error('P6_SDK_CORE: not implemented');
  }

  send(_msg: C2S): void {
    void _msg;
  }

  pingMs(): number {
    return 0;
  }

  serverNow(): number {
    return Date.now();
  }

  close(): void {}
}

// ============================================================================
// SDK PROFILE — device auth + claim codes + rename (docs/PLATFORM.md §4.1).
// REST via fetch('/api/…'), Bearer token; token cached in localStorage under
// 'play.auth'. All storage access try/catch'd (identity.ts precedent).
// Owner: P6_SDK_CORE — implement ProfileApi from types.ts.
// ============================================================================

import type { ProfileApi } from './types.js';
import type { SdkNet } from './net.js';

export const AUTH_STORAGE_KEY = 'play.auth';

export class Profiles implements ProfileApi {
  constructor(
    private readonly net: SdkNet,
    private readonly opts: { readonly autoAuth?: boolean } = {},
  ) {
    void net;
    void opts;
  }

  me(): { id: string; name: string } | null {
    return null;
  }

  token(): string | null {
    return null;
  }

  ensureDeviceAuth(): Promise<{ id: string; name: string } | null> {
    throw new Error('P6_SDK_CORE: not implemented');
  }

  rename(_name: string): Promise<{ id: string; name: string }> {
    void _name;
    throw new Error('P6_SDK_CORE: not implemented');
  }

  claimCode(): Promise<string> {
    throw new Error('P6_SDK_CORE: not implemented');
  }

  claim(_code: string): Promise<{ id: string; name: string }> {
    void _code;
    throw new Error('P6_SDK_CORE: not implemented');
  }
}

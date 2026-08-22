// ============================================================================
// SDK PROFILE — device auth + claim codes + rename (docs/PLATFORM.md §4.1).
// REST via fetch('/api/…'), Bearer token; token cached in localStorage under
// 'play.auth'. All storage access try/catch'd (identity.ts precedent):
// storage is a courtesy, never a dependency. `me` hydrates from auth_ok
// pushed by net when autoAuth replays the stored token after connect.
// Owner: P6_SDK_CORE — implement ProfileApi from types.ts.
//
// DOM-free where possible: localStorage reached only through guarded globalThis.
// ============================================================================

import { loadSig } from '@platform/shared';
import type { ProfileApi, ProfileInfo } from './types.js';
import type { SdkNet } from './net.js';

export const AUTH_STORAGE_KEY = 'play.auth';

/** The narrow structural slice of localStorage we use (identity.ts precedent). */
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storage(): StorageLike | null {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    return null;
  }
}

function readToken(): string | null {
  try {
    return storage()?.getItem(AUTH_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeToken(token: string): void {
  try {
    storage()?.setItem(AUTH_STORAGE_KEY, token);
  } catch {
    // quota / private mode / blocked — token stays live for this page only
  }
}

function dropToken(): void {
  try {
    storage()?.removeItem(AUTH_STORAGE_KEY);
  } catch {
    // non-fatal
  }
}

/** JSON body fetch wrapper; non-2xx throws (caller decides what "null" means). */
async function request(
  method: 'POST' | 'PATCH' | 'GET',
  url: string,
  body: unknown,
  token?: string | null,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token !== null && token !== undefined && token !== '') headers.authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // empty/erroring body — handled via status below
  }
  if (!res.ok) throw new Error(`Profiles: ${method} ${url} failed (${res.status})`);
  return typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
}

function str(v: unknown): v is string {
  return typeof v === 'string';
}

export class Profiles implements ProfileApi {
  private cachedMe: ProfileInfo | null = null;

  constructor(
    /**
     * Optional: the ws facade, used only to hydrate `me()` from auth_ok pushes
     * (client.ts wires that). Standalone REST-only use — the ANCIENTS port
     * shell (games/ancients) — passes null and loses nothing.
     */
    private readonly net: SdkNet | null,
    private readonly opts: { readonly autoAuth?: boolean } = {},
  ) {
    void opts;
  }

  me(): ProfileInfo | null {
    return this.cachedMe;
  }

  /** Server token if we have one (localStorage cache), else null. */
  token(): string | null {
    return readToken();
  }

  /**
   * @internal Called by the facade when ws pushes auth_ok (autoAuth replayed
   * our stored token and the server accepted it).
   */
  handleAuthOk(profileId: string, name: string): void {
    if (!str(profileId)) return;
    this.cachedMe = { id: profileId, name: str(name) ? name : '' };
  }

  /**
   * @internal Called by the facade on auth_err: the stored token is bad or
   * expired — forget it so the next ensureDeviceAuth() mints a fresh profile.
   */
  handleAuthErr(): void {
    this.cachedMe = null;
    dropToken();
  }

  /** Exchange this browser's sig for a profile token; caches both. */
  async ensureDeviceAuth(): Promise<ProfileInfo | null> {
    try {
      const res = await request('POST', '/api/auth/device', { sig: loadSig() });
      if (!str(res.profileId) || !str(res.token)) return null;
      writeToken(res.token);
      this.cachedMe = { id: res.profileId, name: str(res.name) ? res.name : '' };
      return this.cachedMe;
    } catch {
      return null; // offline / server down: stay anonymous, retry later
    }
  }

  /** Rename platform-wide; resolves the updated profile. */
  async rename(name: string): Promise<ProfileInfo> {
    const token = readToken();
    if (token === null || token === '') throw new Error('Profiles: not authenticated');
    const res = await request('PATCH', '/api/profiles/me', { name }, token);
    const updated: ProfileInfo = {
      id: str(res.id) ? res.id : (this.cachedMe?.id ?? ''),
      name: str(res.name) ? res.name : name,
    };
    this.cachedMe = updated;
    return updated;
  }

  /** Mint a claim code for linking another device (10-min TTL, single use). */
  async claimCode(): Promise<string> {
    const token = readToken();
    if (token === null || token === '') throw new Error('Profiles: not authenticated');
    const res = await request('POST', '/api/auth/link', { token }, token);
    if (!str(res.code)) throw new Error('Profiles: claim code reply malformed');
    return res.code;
  }

  /** Claim a code minted on another device; adopts that profile here. */
  async claim(code: string): Promise<ProfileInfo> {
    const res = await request('POST', '/api/auth/claim', { sig: loadSig(), code });
    if (!str(res.profileId) || !str(res.token)) throw new Error('Profiles: claim reply malformed');
    writeToken(res.token);

    // The claim reply carries no display name — pull the adopted profile's.
    try {
      const me = await request('GET', '/api/profiles/me', undefined, res.token);
      this.cachedMe = {
        id: str(me.id) ? me.id : res.profileId,
        name: str(me.name) ? me.name : '',
      };
    } catch {
      this.cachedMe = { id: res.profileId, name: '' }; // auth_ok will hydrate later
    }
    return this.cachedMe;
  }
}

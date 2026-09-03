// ============================================================================
// PLATFORM v2 HTTP API — /api/* router mounted inside net.ts's http handler
// (docs/PLATFORM.md §4). JSON in/out, Bearer-token auth where required.
// Owner: P3_SRV_API — implement handle(); keep the constructor surface.
// padPage.ts provides renderPadPage (P8) — import it for GET /pad.
//
// Shape: handle() is SYNC and never throws. It parses the URL, claims any
// path under /api/ or /pad (returning false otherwise so net.ts falls through
// to static serving), then kicks off an async dispatch that drains the
// request body (≤ 256KB), JSON-parses it, and routes method+path to pure
// handlers in auth/profiles/saves. Every failure mode becomes a single
// {error: string} envelope (+ rev on save conflicts); internal errors become
// 500 {error:'internal'} with no stack trace ever leaking.
// ============================================================================

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GameModule, PadLayout } from '@platform/shared';
import { isValidSaveSlot, isValidToken } from '@platform/shared';
import { renderPadPage } from '../padPage.js';
import type { Store } from './db.js';
import { handleClaim, handleDevice } from './auth.js';
import * as profiles from './profiles.js';
import * as saves from './saves.js';

/** URL prefix owned by this router. */
export const API_PREFIX = '/api/';

export interface HttpApiDeps {
  readonly store: Store;
  readonly games: readonly GameModule[];
}

/** One computed reply: status + JSON payload (`json: null` ⇒ empty body). */
export interface ApiReply {
  readonly status: number;
  readonly json: unknown;
}

/** Hard cap on any request body we are willing to buffer (256KB). */
const MAX_BODY_BYTES = 256 * 1024;

/** Methods whose bodies get JSON-parsed before routing. */
const BODY_METHODS = new Set(['POST', 'PATCH', 'PUT']);

export class HttpApi {
  private readonly store: Store;
  private readonly games: readonly GameModule[];

  constructor(deps: HttpApiDeps) {
    this.store = deps.store;
    this.games = deps.games;
  }

  /**
   * Try to handle req. Returns false immediately when the path is not under
   * /api/ or /pad (net.ts then falls through to static serving). Never
   * throws; internal errors become 500 {error:'internal'}. The response may
   * complete after handle() returns — body reading is event-driven.
   */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      this.safeReply(res, { status: 400, json: { error: 'bad_request' } });
      return true;
    }

    const path = url.pathname;
    if (path === '/pad' || path === '/pad/') {
      if ((req.method ?? 'GET').toUpperCase() === 'GET') this.sendPadPage(url, res);
      else return false; // only GET owns the page; other verbs aren't ours
      return true;
    }
    if (!path.startsWith(API_PREFIX)) return false;

    void this.dispatch(req, res, url).catch(() => {
      this.safeReply(res, { status: 500, json: { error: 'internal' } });
    });
    return true;
  }

  // ---- dispatch pipeline ----------------------------------------------------

  private async dispatch(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const body = await this.readBody(req);
    if (!body.ok) {
      this.safeReply(res, { status: 413, json: { error: 'too_large' } });
      return;
    }
    const method = (req.method ?? 'GET').toUpperCase();
    const parts = url.pathname.slice(API_PREFIX.length).split('/');
    const reply = this.route(method, parts, url, req.headers.authorization, body.text);
    this.safeReply(res, reply);
  }

  /**
   * Drain the request stream up to MAX_BODY_BYTES. Oversized bodies keep
   * draining to the end (so the 413 reply actually reaches the client) while
   * discarding bytes. Stream errors resolve as not-ok → 400-ish handling by
   * the caller; nothing here throws.
   */
  private readBody(req: IncomingMessage): Promise<{ ok: true; text: string } | { ok: false }> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let overflow = false;
      let settled = false;
      const done = (r: { ok: true; text: string } | { ok: false }): void => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) overflow = true;
        else chunks.push(chunk);
      });
      req.on('end', () =>
        done(overflow ? { ok: false } : { ok: true, text: Buffer.concat(chunks).toString('utf8') }),
      );
      req.on('error', () => done({ ok: false }));
    });
  }

  // ---- routing ---------------------------------------------------------------

  private route(
    method: string,
    rawParts: string[],
    url: URL,
    authorization: string | string[] | undefined,
    bodyText: string,
  ): ApiReply {
    // Percent-decode each segment; malformed escapes are a client error.
    const parts: string[] = [];
    for (const raw of rawParts) {
      try {
        parts.push(decodeURIComponent(raw));
      } catch {
        return { status: 400, json: { error: 'bad_request' } };
      }
    }

    let body: unknown = {};
    if (BODY_METHODS.has(method) && bodyText !== '') {
      try {
        body = JSON.parse(bodyText) as unknown;
      } catch {
        return { status: 400, json: { error: 'bad_json' } };
      }
    }

    const at = (i: number): string | undefined => parts[i];

    switch (method) {
      case 'GET': {
        if (parts.length === 1 && at(0) === 'health') return this.health();
        if (parts.length === 2 && at(0) === 'pads') return this.padReply(at(1));
        if (parts.length === 2 && at(0) === 'profiles' && at(1) === 'me') {
          return this.withAuth(authorization, (id) => profiles.getMe(this.store, id));
        }
        if (parts.length === 3 && at(0) === 'profiles' && at(1) === 'me' && at(2) === 'stats') {
          return this.withAuth(authorization, (id) => profiles.getStats(this.store, id, this.gameFilter(url)));
        }
        if (parts.length === 3 && at(0) === 'profiles' && at(2) === 'stats') {
          return profiles.getStats(this.store, at(1) ?? '', this.gameFilter(url)); // public read
        }
        if (parts.length === 2 && at(0) === 'saves') {
          return this.withAuth(authorization, (id) => saves.listSaves(this.store, id, at(1) ?? ''));
        }
        if (parts.length === 3 && at(0) === 'saves') {
          return this.saveSlotRoute(authorization, at(1), at(2), (id, game, slot) =>
            saves.getSave(this.store, id, game, slot),
          );
        }
        break;
      }
      case 'POST': {
        if (parts.length === 2 && at(0) === 'auth' && at(1) === 'device') {
          return handleDevice(this.store, body);
        }
        if (parts.length === 2 && at(0) === 'auth' && at(1) === 'claim') {
          return handleClaim(this.store, body);
        }
        // P2P self-reported stats (docs/PLATFORM.md §12): in a host-tab
        // match there is no server room to report through, so each client
        // reports its OWN end-of-match counters from the snapshots it saw.
        // Bearer-bound (a profile can only ever write its own rows).
        if (parts.length === 2 && at(0) === 'stats') {
          return this.withAuth(authorization, (id) => {
            const rec = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
            const game = at(1) ?? '';
            const key = typeof rec.key === 'string' ? rec.key : '';
            const value = typeof rec.value === 'number' ? rec.value : NaN;
            if (!/^[a-z0-9-]{2,24}$/.test(game) || !/^[a-z0-9_.]{1,32}$/.test(key) || !Number.isFinite(value)) {
              return { status: 400, json: { error: 'bad_request' } };
            }
            try {
              this.store.addStats(id, game, { [key]: Math.max(-1e6, Math.min(1e6, Math.trunc(value))) });
              return { status: 200, json: { ok: true } };
            } catch {
              return { status: 500, json: { error: 'internal' } };
            }
          });
        }
        // Mint a claim code for the AUTHENTICATED profile (docs/PLATFORM.md
        // §4.1): Bearer token OR {token} body → {code}. Single use,
        // AUTH.claimTtlMs. (Body form exists because the minting device may
        // hold its token only in storage-bound SDK state; both shapes are
        // contract-sanctioned.)
        if (parts.length === 2 && at(0) === 'auth' && at(1) === 'link') {
          const rec = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
          const bodyToken = typeof rec.token === 'string' ? rec.token : undefined;
          const attempt = (authz: string | string[] | undefined) =>
            this.withAuth(authz, (id) => {
              try {
                return { status: 200, json: { code: this.store.mintClaimCode(id) } };
              } catch {
                return { status: 500, json: { error: 'internal' } };
              }
            });
          const viaHeader = attempt(authorization);
          if (viaHeader.status !== 401 || bodyToken === undefined) return viaHeader;
          return attempt(`Bearer ${bodyToken}`);
        }
        break;
      }
      case 'PATCH': {
        if (parts.length === 2 && at(0) === 'profiles' && at(1) === 'me') {
          return this.withAuth(authorization, (id) => profiles.patchMe(this.store, id, body));
        }
        break;
      }
      case 'PUT': {
        if (parts.length === 3 && at(0) === 'saves') {
          return this.saveSlotRoute(authorization, at(1), at(2), (id, game, slot) =>
            saves.putSave(this.store, id, game, slot, body),
          );
        }
        break;
      }
      case 'DELETE': {
        if (parts.length === 3 && at(0) === 'saves') {
          return this.saveSlotRoute(authorization, at(1), at(2), (id, game, slot) =>
            saves.deleteSave(this.store, id, game, slot),
          );
        }
        break;
      }
      default:
        break;
    }
    return { status: 404, json: { error: 'not_found' } };
  }

  /** Shared shape guard for every /api/saves/:game/:slot route. */
  private saveSlotRoute(
    authorization: string | string[] | undefined,
    game: string | undefined,
    rawSlot: string | undefined,
    run: (profileId: string, gameId: string, slot: string) => ApiReply,
  ): ApiReply {
    if (game === undefined || rawSlot === undefined || !saves.slotIsValid(rawSlot)) {
      return { status: 400, json: { error: 'bad_request' } };
    }
    return this.withAuth(authorization, (id) => run(id, game, rawSlot));
  }

  // ---- cross-cutting pieces ---------------------------------------------------

  private health(): ApiReply {
    return { status: 200, json: { ok: true, degraded: this.store.degraded } };
  }

  /** PadLayout lookup across deps.games — shared by /api/pads/:game. */
  private padReply(gameId: string | undefined): ApiReply {
    const mod = gameId === undefined ? undefined : this.games.find((g) => g.id === gameId);
    const layout: PadLayout | undefined = mod?.padLayout;
    if (mod === undefined || layout === undefined) return { status: 404, json: { error: 'no_pad' } };
    return { status: 200, json: layout };
  }

  /** GET /pad?game=<id> — the generic phone-pad page (renderPadPage, P8). */
  private sendPadPage(url: URL, res: ServerResponse): void {
    const gameId = url.searchParams.get('game');
    const mod = gameId === null ? undefined : this.games.find((g) => g.id === gameId);
    const layout: PadLayout | undefined = mod?.padLayout;
    if (mod === undefined || layout === undefined) {
      this.safeReply(res, { status: 404, json: { error: 'no_pad' } });
      return;
    }
    let html: string;
    try {
      html = renderPadPage({ gameId: mod.id, gameName: mod.name, layout });
    } catch {
      this.safeReply(res, { status: 500, json: { error: 'internal' } });
      return;
    }
    try {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(html);
    } catch {
      /* socket gone mid-write — nothing left to do */
    }
  }

  /**
   * Auth middleware: `Authorization: Bearer <token>` → store lookup →
   * profileId, or 401 {error:'unauthorized'}. Only saves/me routes call it.
   */
  private withAuth(
    authorization: string | string[] | undefined,
    run: (profileId: string) => ApiReply,
  ): ApiReply {
    const header = Array.isArray(authorization) ? authorization[0] : authorization;
    const match = typeof header === 'string' ? /^Bearer[ \t]+([A-Za-z0-9_-]+)$/i.exec(header.trim()) : null;
    const token = match?.[1];
    if (token === undefined || !isValidToken(token)) return { status: 401, json: { error: 'unauthorized' } };
    const profileId = this.store.profileIdByToken(token);
    if (profileId === null) return { status: 401, json: { error: 'unauthorized' } };
    return run(profileId);
  }

  /** Optional ?game= filter on stats reads: trimmed, capped, '' ⇒ absent. */
  private gameFilter(url: URL): string | undefined {
    const raw = url.searchParams.get('game');
    if (raw === null) return undefined;
    const trimmed = raw.trim().slice(0, 32);
    return trimmed === '' ? undefined : trimmed;
  }

  /** Write a reply unless headers already went out (never double-respond). */
  private safeReply(res: ServerResponse, reply: ApiReply): void {
    try {
      if (res.headersSent) return;
      res.statusCode = reply.status;
      if (reply.status === 204 || reply.json === null) {
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(reply.json));
    } catch {
      /* socket gone mid-write — nothing left to do */
    }
  }
}

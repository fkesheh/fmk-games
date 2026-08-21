// ============================================================================
// PLATFORM v2 HTTP API — /api/* router mounted inside net.ts's http handler
// (docs/PLATFORM.md §4). JSON in/out, Bearer-token auth where required.
// Owner: P3_SRV_API — implement handle(); keep the constructor surface.
// padPage.ts provides renderPadPage (P8) — import it for GET /pad.
// ============================================================================

import type { ServerResponse, IncomingMessage } from 'node:http';
import type { GameModule } from '@platform/shared';
import type { Store } from './db.js';

/** URL prefix owned by this router. */
export const API_PREFIX = '/api/';

export interface HttpApiDeps {
  readonly store: Store;
  readonly games: readonly GameModule[];
}

export class HttpApi {
  constructor(deps: HttpApiDeps);
  /**
   * Try to handle req. Returns false immediately when the path is not under
   * /api/ or /pad (net.ts then falls through to static serving). Never
   * throws; internal errors become 500 {error:'internal'}.
   */
  handle(req: IncomingMessage, res: ServerResponse): boolean;
}

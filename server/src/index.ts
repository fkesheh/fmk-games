import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

const PORT = Number(process.env.PORT ?? 8080);

// Placeholder server: logs WebSocket connections on /ws and, when a client
// production build exists, serves it over HTTP. Will be replaced by the
// authoritative game server later.

const here = path.dirname(fileURLToPath(import.meta.url));
// tsx dev runs from server/src; the production bundle lives in server/dist.
const clientDist = [
  path.resolve(here, '../client/dist'),
  path.resolve(here, '../../client/dist'),
].find((p) => existsSync(p));

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (clientDist === undefined) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('fps server: no client build found (run `npm run build`)');
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  const filePath = path.resolve(clientDist, `.${pathname}`);
  if (!filePath.startsWith(clientDist + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const data = await readFile(filePath);
    const contentType = MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': contentType });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not Found');
  }
}

const server = createServer((req, res) => {
  handleHttp(req, res).catch((err: unknown) => {
    console.error('[http] error', err);
    if (!res.headersSent) res.writeHead(500);
    res.end('Internal Server Error');
  });
});

const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws: WebSocket) => {
  console.log('[ws] client connected');
  ws.on('close', () => console.log('[ws] client disconnected'));
  ws.on('error', (err) => console.error('[ws] error', err));
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT} (ws at /ws)`);
});

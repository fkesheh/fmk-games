#!/usr/bin/env node
// repro-joinpaths — Bug 2 companion check: the public room LIST join path
// (join_public) must also land a second player in the waiting room.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 8096);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* keep polling */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(150);
  }
}

const LAUNCH_OPTS = {
  headless: 'shell',
  args: ['--mute-audio', '--disable-background-timer-throttling', '--enable-unsafe-swiftshader'],
  protocolTimeout: 120000,
};

async function main() {
  const server = spawn(process.execPath, ['platform/server/dist/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const browsers = [];
  try {
    await waitFor(async () => {
      const res = await fetch(`${BASE}/rift/`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
      return res !== null && res.ok;
    }, 20000, 'server up');
    const open = async () => {
      const browser = await puppeteer.launch(LAUNCH_OPTS);
      browsers.push(browser);
      const page = await browser.newPage();
      await page.setViewport({ width: 640, height: 360 });
      await page.goto(`${BASE}/rift/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitFor(() => page.evaluate(() => !!window.__rift), 15000, '__rift');
      return page;
    };
    const lastFrame = (page, t) =>
      page.evaluate((tag) => {
        const log = window.__rift?.messageLog() ?? [];
        for (let i = log.length - 1; i >= 0; i--) {
          const m = log[i];
          if (m !== null && typeof m === 'object' && m.t === tag) return m;
        }
        return null;
      }, t);

    const A = await open();
    const B = await open();
    await A.evaluate(() => window.__rift.createPublic('Alice', {}));
    const aHello = await waitFor(() => lastFrame(A, 'rift_hello'), 10000, 'A hello');

    // B reads the public room list and joins by id — the menu's JOIN path
    const listed = await waitFor(async () => {
      const rl = await lastFrame(B, 'room_list');
      const hit = rl?.rooms?.find((r) => r.id === aHello.roomId);
      return hit ?? null;
    }, 10000, 'A room visible in B room_list');
    console.log(`B sees: ${JSON.stringify(listed)}`);
    await B.evaluate((id) => window.__rift.joinPublic('Bob', id), aHello.roomId);
    const bHello = await waitFor(() => lastFrame(B, 'rift_hello'), 10000, 'B hello');
    const same = bHello.roomId === aHello.roomId;
    console.log(`join_public: A=${aHello.roomId} B=${bHello.roomId} same=${same} roster=${bHello.roster.map((r) => r.name).join('/')}`);
    process.exitCode = same && listed.phase === 'warmup' ? 0 : 1;
  } finally {
    for (const b of browsers) await b.close().catch(() => {});
    if (server.exitCode === null) server.kill('SIGTERM');
  }
}

await main();

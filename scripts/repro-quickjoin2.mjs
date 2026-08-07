#!/usr/bin/env node
// repro-quickjoin2 — Bug 2 scenario: room1 goes LIVE, room2 waits in lobby.
// Where does a quick-joiner land? The lobby's 'warmup' preference exists so
// matchmaking prefers a not-yet-started room over an in-progress one.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 8098);
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
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  const browsers = [];
  try {
    await waitFor(async () => {
      const res = await fetch(`${BASE}/rift/`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
      return res !== null && res.ok;
    }, 20000, 'server up');

    const open = async (tag) => {
      const browser = await puppeteer.launch(LAUNCH_OPTS);
      browsers.push(browser);
      const page = await browser.newPage();
      await page.setViewport({ width: 640, height: 360 });
      page.on('pageerror', (e) => console.log(`[${tag}] pageerror: ${e.message}`));
      await page.goto(`${BASE}/rift/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitFor(() => page.evaluate(() => !!window.__rift), 15000, `__rift on ${tag}`);
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
    const helloRoom = async (page) => (await lastFrame(page, 'rift_hello'))?.roomId ?? null;

    const A = await open('A'); // creates room1, starts the match (solo + bots)
    const C = await open('C'); // creates room2, WAITS in its lobby
    const D = await open('D'); // quick-joins; should land in C's waiting lobby

    await A.evaluate(() => window.__rift.quickJoin('Alice'));
    const room1 = await waitFor(() => helloRoom(A), 10000, 'A hello');
    await A.evaluate(() => window.__rift.start());
    await waitFor(async () => (await A.evaluate(() => window.__rift.state()))?.phase === 'live', 15000, 'A live');
    console.log(`room1 (A) is LIVE: ${room1}`);

    await C.evaluate(() => window.__rift.createPublic('Carol', {}));
    const room2 = await waitFor(() => helloRoom(C), 10000, 'C hello');
    console.log(`room2 (C) waiting in LOBBY: ${room2}`);

    await D.evaluate(() => window.__rift.quickJoin('Dave'));
    await sleep(1500);
    const dRoom = await helloRoom(D);
    const dState = await D.evaluate(() => window.__rift.state());
    console.log(`D quick-join landed in ${dRoom} (phase=${dState?.phase})`);
    const preferred = dRoom === room2;
    console.log(`\nRESULT: quick-join preferred the waiting lobby = ${preferred} (landed in ${dRoom === room1 ? 'the LIVE match' : dRoom === room2 ? 'the waiting lobby' : 'a NEW room'})`);
    process.exitCode = preferred ? 0 : 1;
  } finally {
    for (const b of browsers) await b.close().catch(() => {});
    if (server.exitCode === null) server.kill('SIGTERM');
  }
}

await main();

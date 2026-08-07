#!/usr/bin/env node
// repro-pan — Bug 1 investigation/proof harness (NOT part of the e2e gate).
//
// Empirically measures the rift camera's screen->world mapping through the
// REAL scene raycast (window.__rift.screenToGround, an additive debug read),
// then drives every pan input (screen edges, arrow keys, middle-drag, minimap
// click) and asserts the camera target moved the way the PLAYER sees:
//   - right edge / ArrowRight  -> view moves screen-right
//   - bottom edge              -> view moves screen-down
//   - middle-drag right        -> grab-the-world: view moves screen-LEFT
//   - minimap click            -> camera lands where the minimap DRAWS that point
// "screen-right"/"screen-down" are themselves MEASURED first (two-point basis
// probe), so this harness assumes nothing about the camera yaw.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 8099);
const BASE = `http://localhost:${PORT}`;
const VW = 640;
const VH = 360;
const SIDE = 96; // teamSize 2 -> 1 lane -> map side (mirrors shared config)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

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

function report(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function main() {
  const server = spawn(process.execPath, ['platform/server/dist/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stdout.write(`[server!] ${d}`));
  let browser = null;
  try {
    await waitFor(async () => {
      const res = await fetch(`${BASE}/rift/`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
      return res !== null && res.ok;
    }, 20000, 'server up');

    browser = await puppeteer.launch({
      headless: 'shell',
      args: ['--mute-audio', '--disable-background-timer-throttling', '--enable-unsafe-swiftshader'],
      protocolTimeout: 120000,
    });
    const page = await browser.newPage();
    await page.setViewport({ width: VW, height: VH });
    page.on('pageerror', (e) => console.log(`[page] pageerror: ${e.message}`));
    await page.goto(`${BASE}/rift/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitFor(() => page.evaluate(() => !!window.__rift), 15000, '__rift');

    // into a live match (camera recenters on the hero at the first snap)
    await page.evaluate(() => window.__rift.createPrivate('Probe', { teamSize: 2, speed: 1 }));
    await waitFor(async () => (await page.evaluate(() => window.__rift.state()))?.phase === 'lobby', 10000, 'lobby');
    await page.evaluate(() => window.__rift.start());
    await waitFor(
      async () => {
        const s = await page.evaluate(() => window.__rift.state());
        return s?.phase === 'live' && (s?.tick ?? 0) > 0;
      },
      20000,
      'live with snaps',
    );

    const stg = (x, y) => page.evaluate((a, b) => window.__rift.screenToGround(a, b), x, y);
    const CX = VW / 2; // 320 — the camera axis hits the ground AT the target here
    const CY = VH / 2; // 180
    const target = () => stg(CX, CY);

    // ---- measure the TRUE screen->world basis (no assumptions) ---------------
    // (the vertical probe rides the CENTRE column: off-centre, perspective
    // skews a screen-vertical line away from the world z axis)
    const c = await stg(160, 180);
    const r = await stg(400, 180); // 240px to the RIGHT of c
    const cu = await stg(320, 120);
    const d = await stg(320, 260); // 140px BELOW cu
    if (c === null || r === null || cu === null || d === null) {
      throw new Error(`basis probe missed the map: ${JSON.stringify({ c, r, cu, d })}`);
    }
    const vRight = { x: r.x - c.x, z: r.z - c.z }; // world delta for +240px screen-right
    const vDown = { x: d.x - cu.x, z: d.z - cu.z }; // world delta for +140px screen-down
    console.log(
      `measured basis: screen-right = (${vRight.x.toFixed(1)}, ${vRight.z.toFixed(1)}) world m / 240px; ` +
        `screen-down = (${vDown.x.toFixed(1)}, ${vDown.z.toFixed(1)}) world m / 100px`,
    );
    report(
      'basis: screen-right is a pure world -x direction (camera looks along +z)',
      Math.abs(vRight.z) < 1 && vRight.x < -5,
      `vRight=(${vRight.x.toFixed(2)}, ${vRight.z.toFixed(2)})`,
    );
    report(
      'basis: screen-down is a pure world -z direction',
      Math.abs(vDown.x) < 1 && vDown.z < -3,
      `vDown=(${vDown.x.toFixed(2)}, ${vDown.z.toFixed(2)})`,
    );

    // minimap centre click recenters the camera to (side/2, side/2) — invariant
    // under the flip question, so it is a safe reset even in the buggy build.
    const mm = await (await page.$('.minimap > canvas'))?.boundingBox();
    if (!mm) throw new Error('minimap canvas not visible');
    const recenter = async () => {
      await page.mouse.click(mm.x + mm.width / 2, mm.y + mm.height / 2);
      await sleep(250);
    };
    await recenter();
    const centred = await target();
    report(
      'minimap centre click lands the camera at the map centre',
      centred !== null && Math.abs(centred.x - SIDE / 2) < 2 && Math.abs(centred.z - SIDE / 2) < 2,
      `target=${JSON.stringify(centred)}`,
    );

    const dot = (a, b) => a.x * b.x + a.z * b.z;
    /** Pan case: recenter, read target, act, read target, return world delta. */
    const panCase = async (name, act, expect, basis) => {
      await recenter();
      const t0 = await target();
      await act();
      const t1 = await target();
      if (t0 === null || t1 === null) {
        report(name, false, 'camera target probe missed the map');
        return;
      }
      const delta = { x: t1.x - t0.x, z: t1.z - t0.z };
      const along = dot(delta, basis);
      // perpendicular leakage: |delta x basis| / |basis|
      const cross = Math.abs(delta.x * basis.z - delta.z * basis.x) / Math.hypot(basis.x, basis.z);
      const ok = expect === 'along' ? along > 3 : along < -3;
      report(
        name,
        ok && cross < 4,
        `delta=(${delta.x.toFixed(1)}, ${delta.z.toFixed(1)}) along-basis=${along.toFixed(1)}m perp=${cross.toFixed(1)}m`,
      );
    };

    await panCase(
      'right screen edge pans the view screen-RIGHT',
      async () => {
        await page.mouse.move(VW - 4, CY);
        await sleep(900);
        await page.mouse.move(CX, CY);
        await sleep(150);
      },
      'along',
      vRight,
    );
    await panCase(
      'left screen edge pans the view screen-LEFT',
      async () => {
        await page.mouse.move(4, CY);
        await sleep(900);
        await page.mouse.move(CX, CY);
        await sleep(150);
      },
      'against',
      vRight,
    );
    await panCase(
      'bottom screen edge pans the view screen-DOWN',
      async () => {
        await page.mouse.move(CX, VH - 4);
        await sleep(900);
        await page.mouse.move(CX, CY);
        await sleep(150);
      },
      'along',
      vDown,
    );
    await panCase(
      'top screen edge pans the view screen-UP',
      async () => {
        await page.mouse.move(CX, 4);
        await sleep(900);
        await page.mouse.move(CX, CY);
        await sleep(150);
      },
      'against',
      vDown,
    );
    await panCase(
      'ArrowRight pans the view screen-RIGHT',
      async () => {
        await page.keyboard.down('ArrowRight');
        await sleep(700);
        await page.keyboard.up('ArrowRight');
        await sleep(150);
      },
      'along',
      vRight,
    );
    await panCase(
      'ArrowUp pans the view screen-UP',
      async () => {
        await page.keyboard.down('ArrowUp');
        await sleep(700);
        await page.keyboard.up('ArrowUp');
        await sleep(150);
      },
      'against',
      vDown,
    );
    await panCase(
      'middle-drag RIGHT grabs the world (view moves screen-LEFT)',
      async () => {
        await page.mouse.move(240, CY);
        await page.mouse.down({ button: 'middle' });
        await page.mouse.move(390, CY, { steps: 5 });
        await page.mouse.up({ button: 'middle' });
        await sleep(150);
      },
      'against',
      vRight,
    );

    // ---- minimap click-to-pan: click where the minimap DRAWS (72, 24) -------
    // (measured basis: world +x is screen-LEFT, +z is screen-UP, so the world
    // point (0.75*side, 0.25*side) belongs at minimap-relative (0.25, 0.75)
    // when the minimap agrees with the camera; the flipped drawing puts it at
    // (0.75, 0.25) instead)
    await recenter();
    await page.mouse.click(mm.x + mm.width * 0.25, mm.y + mm.height * 0.75);
    await sleep(250);
    const t = await target();
    const want = { x: 0.75 * SIDE, z: 0.25 * SIDE };
    const err = t === null ? Infinity : Math.hypot(t.x - want.x, t.z - want.z);
    report(
      'minimap click pans to the point AS DRAWN (minimap orientation matches the camera)',
      t !== null && err < 3,
      `clicked rel (0.25, 0.75) -> target=${t === null ? 'null' : `(${t.x.toFixed(1)}, ${t.z.toFixed(1)})`} ` +
        `expected=(${want.x}, ${want.z}) err=${err === Infinity ? 'inf' : err.toFixed(1)}m`,
    );
  } finally {
    if (browser !== null) await browser.close().catch(() => {});
    if (server.exitCode === null) server.kill('SIGTERM');
  }
}

await main();
console.log(failures === 0 ? '\nALL PAN CHECKS PASS' : `\n${failures} pan check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;

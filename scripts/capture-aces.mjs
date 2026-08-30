#!/usr/bin/env node
// ============================================================================
// capture-aces — stage the STYLE_BIBLE §4 shot set for the art/UX judges.
//
// Drives a private debug room through window.__ACES and captures every shot
// type the blind comparison protocol needs: menu, lobby, duel wides with
// tracers, hero close-ups of each airframe (via zoomTo), damage/smoke states,
// respawn class picker, end-of-match scoreboard.
// Shots land in screenshots/aces/*.png; the judge harness pairs them against
// judge/reference-aces/ (Luftrausers).
// ============================================================================
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 8190);
const OUT = path.join(ROOT, 'screenshots', 'aces');
const URL_ = `http://localhost:${PORT}/aces/`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server = null;

async function main() {
  await mkdir(OUT, { recursive: true });
  server = spawn(process.execPath, ['platform/server/dist/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(URL_, { signal: AbortSignal.timeout(1500) });
      if (r.ok) break;
    } catch { /* not yet */ }
    await sleep(300);
  }

  const browser = await puppeteer.launch({
    headless: 'shell',
    args: ['--window-size=1600,1000', '--mute-audio', '--disable-background-timer-throttling'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const call = async (src) =>
    page.evaluate((s) => {
      try {
        return Function(`"use strict"; return (${s});`)();
      } catch (e) {
        return String(e);
      }
    }, src);
  const state = async () => call(`window.__ACES?.state?.()`);
  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log('shot', name);
  };

  // 1. menu poster
  await sleep(1200);
  await shot('01-menu');

  // 2. join debug room; lobby countdown
  await call(`window.__ACES.join({ kind: 'private', settings: { debug: true } })`);
  await sleep(1500);
  await shot('02-lobby');

  // wait live
  for (let i = 0; i < 40; i++) {
    if ((await state())?.phase === 'live') break;
    await sleep(250);
  }
  await sleep(800);
  await call(`window.__ACES.god()`);

  // 3. fly into the furball: warp to map center lane where bots converge.
  // Capture timed wides so tracers/explosions appear in some frames.
  await call(`window.__ACES.warpTo(2100, 1500)`);
  for (const [i, name] of ['03-duel-a', '04-duel-b', '05-duel-c', '06-duel-d'].entries()) {
    await call(`window.__ACES.fastForward(90)`);
    await sleep(140);
    await shot(name);
  }

  // 4. hero close-ups: tail-chase staging — warp ASTERN of the nearest foe
  // along ITS heading so both airframes fill the frame; wait out camera ease.
  await call(`window.__ACES.zoomTo(0.55)`);
  for (const name of ['07-hero-a', '08-hero-b', '09-hero-c']) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const alive = ((await state())?.you) === true;
      if (!alive) { await call(`window.__ACES.spawn('fighter')`); await sleep(600); continue; }
      const foe = await call(`(() => {
        const snap = window.__ACES._internals.latestSnap && window.__ACES._internals.latestSnap();
        if (!snap || !snap.planes) return null;
        const f = snap.planes.find(p => p.bot && !p.dead);
        return f ? { x: f.x, y: f.y, h: f.h } : null;
      })()`);
      if (!foe || typeof foe.x !== 'number') { await sleep(400); continue; }
      const bx = Math.round(foe.x - Math.cos(foe.h) * 55);
      const by = Math.round(foe.y - Math.sin(foe.h) * 55);
      await call(`window.__ACES.warpTo(${bx}, ${by})`);
      await sleep(750);                       // chase-cam ease settles after teleport
      await call(`window.__ACES.fastForward(6)`);
      await sleep(180);
      break;
    }
    await shot(name);
  }
  await call(`window.__ACES.zoomTo(null)`);

  // 5. smoke/damage state: gunship soak — short ungod'd bursts until visibly
  // damaged but ALIVE (≤55% of the LIVE airframe's maxHp read off the latest
  // snapshot's you-row — hardcoding fighter 100 never triggers on a 170hp
  // gunship), then god back ON and shoot the smoking trail frame.
  await call(`window.__ACES.spawn('gunship')`);
  await sleep(600);
  for (let i = 0; i < 14; i++) {
    await call(`window.__ACES.god()`);            // OFF
    await call(`window.__ACES.fastForward(45)`);
    await call(`window.__ACES.god()`);            // ON
    const st = await call(`(() => {
      const p = window.__ACES._internals.predictor;
      const maxHp = window.__ACES._internals.latestSnap()?.you?.maxHp ?? 170;
      return p ? { hp: p.state.hp, maxHp, dead: p.state.dead } : null;
    })()`);
    if (st && !st.dead && st.hp <= (st.maxHp ?? 170) * 0.55) break;
    if (st && st.dead) { await call(`window.__ACES.spawn('gunship')`); await sleep(700); }
    await sleep(120);
  }
  await sleep(450);                               // let the smoke trail develop
  await shot('10-damage-hud');

  // 6. death → class picker: die deliberately (ungod + fast forward near foes)
  await call(`window.__ACES.god()`);
  let deadSeen = false;
  for (let i = 0; i < 20 && !deadSeen; i++) {
    const s = await state();
    deadSeen = s?.you === false;
    if (!deadSeen) {
      await call(`window.__ACES.fastForward(240)`);
      await sleep(80);
    }
  }
  if (deadSeen) await shot('11-respawn-picker');

  // respawn and play out the round to its END scoreboard
  await call(`window.__ACES.spawn('gunship')`);
  await call(`window.__ACES.god()`);
  let phase = (await state())?.phase;
  for (let i = 0; i < 60 && phase === 'live'; i++) {
    await call(`window.__ACES.fastForward(600)`);
    await sleep(60);
    phase = (await state())?.phase;
  }
  if (phase === 'end') {
    await sleep(400);
    await shot('12-end-scoreboard');
  } else {
    console.log('note: match did not reach end within budget (phase=' + String(phase) + ')');
  }

  // 13. disconnect: kill the wire mid-session; the client rides NET.BACKOFF_MS
  // (RECONNECTING… first hop ~1s) then surfaces the RE-ENLIST dead-end panel.
  server.kill('SIGTERM');
  await sleep(1500);
  let reenlist = false;
  for (let i = 0; i < 40 && !reenlist; i++) {
    reenlist = await call(`(() => {
      const layer = document.querySelector('.aces-l-disconnect');
      if (!layer || !layer.classList.contains('on')) return false;
      const lines = Array.from(layer.querySelectorAll('.aces-tw'));
      const retrying = lines.some(
        (e) => e.style.display !== 'none' && /RECONNECTING/.test(e.textContent ?? ''),
      );
      return !retrying; // retry ladder exhausted → RE-ENLIST panel is up
    })()`);
    if (!reenlist) await sleep(500);
  }
  if (!reenlist) console.log('note: RE-ENLIST panel not confirmed within budget');
  await sleep(300);
  await shot('13-disconnect');

  await browser.close();
  console.log('done →', OUT);
}

main()
  .then(() => {
    server?.kill('SIGTERM');
    process.exit(0);
  })
  .catch((e) => {
    console.error('capture fatal:', e);
    server?.kill('SIGTERM');
    process.exit(1);
  });

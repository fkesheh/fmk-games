#!/usr/bin/env node
// ============================================================================
// e2e-p2p-wordbomb — WORDBOMB·SDK host-authoritative pilot (docs/PLATFORM.md
// §12.6): two headless pages, ONE production server that never runs the
// match. Host creates a private room → guest joins by code over the
// DataChannel → both seat in the host tab's sim → START → same live fragment
// on both → a guest lock round-trips into the host's rail. Asserts shared
// state both pages can only get from one live sim.
// Requires `npm run build -w @wordbomb-sdk/client` first.
// Env: E2E_PORT (default 8194).
// ============================================================================
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 8194);
const BASE = `http://127.0.0.1:${PORT}`;
let n = 0;
const failures = [];
function ok(cond, label, extra = '') {
  n += 1;
  console.log(`${String(n).padStart(2, '0')} ${cond ? 'PASS' : 'FAIL'} ${label}${cond ? '' : ` — ${extra}`}`);
  if (!cond) failures.push(label);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Candidate submit words (letters-only, 3-15 chars): mirrors the pilot bundle
// in games/wordbomb-sdk/client/src/p2p.ts, so EVERY pilot fragment has a
// holder here. The run reads the live fragment, then submits a holder.
const CANDIDATES = ['above','after','again','agent','ahead','alive','allow','anger','angle','apart','apple','arena','around','arrow','artist','aside','atlas','attend','award','aware','ballet','balloon','basket','beard','beast','being','believe','below','blast','blend','bless','block','board','border','borrow','bound','brave','bread','break','bride','bright','bring','cable','catch','cater','cease','chain','chair','chalk','champion','change','chant','chart','cheap','cherry','chess','chest','chicken','chill','class','clean','clear','clever','client','clock','clown','coast','comfort','copper','count','cover','crack','craft','crane','crash','crate','craven','cream','create','credit','creek','crest','cricket','current','curtain','danger','dapple','daring','debate','decide','declare','decorate','defend','delight','deliver','dense','derive','direct','discover','distant','elder','elect','elegant','embrace','emerge','enable','enchant','endure','enlarge','enter','entire','entry','envelope','error','essay','estate','esteem','eternal','evening','event','every','example','excess','exchange','exist','expect','expert','explain','express','extend','extra','fable','facing','faint','farmer','fasten','father','feast','fever','fiction','fight','flash','flock','flower','forge','forget','formal','format','former','fortune','forward','founder','fresh','friend','fright','fringe','garden','gather','giant','ginger','glare','glass','gleam','glide','glimmer','glove','golden','govern','grace','grade','grain','grand','grant','grape','gravel','great','grill','grind','grove','guard','guess','guest','guide','hammer','hamster','harden','harvest','haven','health','heard','hearth','hearty','heaven','height','hello','herald','herb','herd','hidden','hollow','horror','hound','humble','ideal','import','increase','index','infect','inherit','insect','inside','insight','inspire','install','instant','instead','intense','interest','interior','jacket','kettle','kitchen','ladder','large','laser','lasting','learn','least','leather','leave','level','listen','lively','locket','lounge','lovely','mango','market','marvel','master','match','mellow','mercy','merge','merit','mirror','modern','motive','naive','narrow','nation','north','notch','onion','opera','opinion','option','orange','paint','palace','paper','parade','parcel','pardon','parent','parish','party','pasta','patch','peaceful','people','pepper','perfect','peril','period','place','plain','planet','plank','plant','pleasant','please','pocket','point','ponder','praise','prance','prepare','present','price','pride','priest','prince','print','prize','prudent','racer','raise','rally','ranch','raven','recall','render','renew','repeat','report','rescue','resist','resort','retreat','rocket','satchel','serene','shallow','sister','skill','slender','spill','stable','still','straight','strain','strange','stream','street','stretch','stride','strike','string','stripe','strive','surrender','tender','theater','trace','track','trail','trial','trillion'];

async function main() {
  const server = spawn('node', [path.join(ROOT, 'platform/server/dist/server.js')], {
    env: { ...process.env, PORT: String(PORT), PLATFORM_DB: ':memory:' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await sleep(4500);
  const browser = await puppeteer.launch({
    // 'shell' (old headless): rAF ticks on EVERY page. 'new' freezes rAF on
    // hidden pages while timers/DC keep running — per-frame UI then never
    // refreshes off-screen. MANDATORY for P2P e2e (kart lesson).
    headless: 'shell',
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const errors = { A: [], B: [] };
  try {
    const ctxA = await browser.createBrowserContext();
    const ctxB = await browser.createBrowserContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    for (const [k, pg] of [['A', a], ['B', b]]) {
      pg.on('pageerror', (e) => errors[k].push(String(e)));
      pg.on('console', (m) => {
        const t = m.text();
        if (m.type() === 'error' && !t.includes('404') && !t.includes('manifest') && !t.includes('favicon')) errors[k].push(t);
      });
      await pg.goto(`${BASE}/wordbomb-sdk/`, { waitUntil: 'networkidle2' });
    }
    await sleep(1500);
    // Host creates a private room through ITS OWN menu.
    await a.evaluate(() => { [...document.querySelectorAll('button')].find((x) => x.textContent === 'CREATE PRIVATE')?.click(); });
    let code = null;
    for (let i = 0; i < 40 && code === null; i++) {
      await sleep(250);
      code = await a.evaluate(() => {
        const s = document.querySelector('.table-invite-code')?.textContent ?? '';
        const m = s.match(/([A-Z0-9]{5})/);
        return m ? m[1] : null;
      });
    }
    ok(typeof code === 'string', '01 host room up with joinable code', String(code));
    // Guest joins that code through ITS OWN menu.
    await b.evaluate((c) => {
      const inp = document.querySelector('.menu-code-input');
      if (inp !== null) { inp.value = c; inp.dispatchEvent(new Event('input', { bubbles: true })); }
    }, code);
    await b.evaluate(() => { [...document.querySelectorAll('button')].find((x) => x.textContent === 'JOIN')?.click(); });
    // Guest must hold the SAME code before START means anything (proves the
    // host lobby seated it over the DataChannel — static chrome can't fake it).
    let gcode = null;
    for (let i = 0; i < 60 && gcode !== code; i++) {
      await sleep(250);
      gcode = await b.evaluate(() => window.__wordbomb?.state()?.code ?? null);
    }
    ok(gcode === code, '02 guest holds the SAME room code over the DataChannel', String(gcode));
    // Seating lags the code display by a DC join round-trip: START is a
    // silent no-op until TWO are seated, so gate the click on host seated==2.
    async function seated(pg) {
      for (let i = 0; i < 60; i++) {
        const v = await pg.evaluate(() => window.__wordbomb?.state()?.seated ?? -1);
        if (v === 2) return v;
        await sleep(250);
      }
      return await pg.evaluate(() => window.__wordbomb?.state()?.seated ?? -1);
    }
    const sa = await seated(a);
    ok(sa === 2, '03 host sees TWO seated (guest joined its sim)', String(sa));
    // Host starts the match (wordbomb rooms wait for START).
    await a.evaluate(() => { document.querySelector('.lobby-start')?.click(); });
    // Live proof: phase flips to live ONLY after the countdown beat in the
    // host tab's sim, then the same fragment shows on both pages.
    async function liveFragment(pg) {
      for (let i = 0; i < 160; i++) {
        const v = await pg.evaluate(() => {
          const s = window.__wordbomb?.state() ?? null;
          return s !== null && s.phase === 'live' && typeof s.fragment === 'string' ? s.fragment : null;
        });
        if (v !== null) return v;
        await sleep(250);
      }
      return null;
    }
    const fa = await liveFragment(a);
    ok(typeof fa === 'string', '04 host reaches live after START', String(fa));
    const fb = await liveFragment(b);
    ok(typeof fb === 'string', '05 guest reaches live after START', String(fb));
    ok(fa !== null && fa === fb, '06 SAME fragment on both pages (one shared sim)', `${String(fa)} vs ${String(fb)}`);
    // Gameplay proof: the guest locks a word; the host's rail must show that
    // seat LOCKED — a frame that only crossed the DataChannel.
    const word = typeof fb === 'string' ? CANDIDATES.find((w) => w.includes(fb.toLowerCase())) ?? null : null;
    ok(typeof word === 'string', '07 pilot bundle holds the live fragment', `${String(fb)} -> ${String(word)}`);
    if (word !== null) {
      const guestYou = await b.evaluate(() => window.__wordbomb?.state()?.you ?? null);
      await b.evaluate((w) => { window.__wordbomb?.submit(w); }, word);
      let locked = false;
      for (let i = 0; i < 60 && !locked; i++) {
        await sleep(250);
        locked = await a.evaluate((gid) => {
          const s = window.__wordbomb?.state() ?? null;
          return s !== null && gid !== null && s.players.some((p) => p.id === gid && p.locked);
        }, guestYou);
      }
      ok(locked, '08 guest lock visible on the host rail over the DataChannel', String(word));
    } else {
      ok(false, '08 guest lock visible on the host rail over the DataChannel', 'no candidate word');
    }
    ok(errors.A.length === 0, '09 zero console errors on host', errors.A.slice(0, 2).join(' | '));
    ok(errors.B.length === 0, '10 zero console errors on guest', errors.B.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
    server.kill('SIGTERM');
    await sleep(300);
    server.kill('SIGKILL');
  }
  console.log(`\ne2e-p2p-wordbomb: ${n - failures.length}/${n} assertions passed`);
  if (failures.length > 0) process.exit(1);
}
main().catch((err) => {
  console.error('e2e-p2p-wordbomb crashed:', err);
  process.exit(1);
});

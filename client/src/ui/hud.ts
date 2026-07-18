// ============================================================================
// C8 — HUD. DOM-based overlay, pointer-events none, layered. All colors trace
// to PALETTE (set as CSS custom props on the root); styling lives in the
// injected <style> block below (style.css is C11's file — not touched).
// update() is on the render hot path: DOM is only touched when a cached value
// actually changes; zero allocation per frame (killfeed/banner/damage are
// event-driven; damage arcs come from a fixed pool).
// ============================================================================
import { PALETTE } from '@fps/shared';
import type { RoomPhase, WeaponId } from '@fps/shared';

export interface HudState {
  hp: number; alive: boolean; money: number; canBuy: boolean;
  weapon: WeaponId; weaponName: string; mag: number; reserve: number;
  phase: RoomPhase; phaseEndsInSec: number; round: number; scoreT: number; scoreCT: number;
  spreadPx: number; scoped: boolean;
  /** Convention: a string starting with 'respawn' is a self respawn countdown
   *  (rendered as-is); anything else is a spectate target name ('SPECTATING X'). */
  spectating: string | null;
}

// Killfeed shows the weapon's short designation (from the frozen WEAPONS names).
const WEAPON_SHORT: Record<WeaponId, string> = {
  knife: 'KNIFE', pistol: 'P9', smg: 'K90', shotgun: 'M870', rifle: 'AK-4', sniper: 'AWM',
};

const PHASE_LABEL: Record<RoomPhase, string> = {
  warmup: 'WARMUP', freeze: 'FREEZE', live: 'LIVE', roundEnd: 'ROUND END', matchEnd: 'MATCH END',
};

const LOW_HP = 30;          // below this: danger + pulse
const KILLFEED_MAX = 5;     // rows, newest on top
const KILLFEED_MS = 5000;   // visible time before fade+remove
const HITMARK_MS = 120;     // hitmarker flash
const DAMAGE_MS = 800;      // directional arc fade
const BANNER_MS = 2500;     // banner hold before fade
const ARC_POOL = 8;         // pooled damage arcs (rapid hits reuse)

/** '#rrggbb' -> 'rgba(r,g,b,a)'. Still a PALETTE color, just translucent. */
function alpha(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

const STYLE_ID = 'fps-hud-style';
const CSS = `
.fh-layer, .fh-layer * { pointer-events: none; box-sizing: border-box; margin: 0; padding: 0; }
.fh-layer {
  position: absolute; inset: 0; overflow: hidden;
  font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
  color: var(--fh-text); text-shadow: 0 1px 3px var(--fh-ink);
  user-select: none; -webkit-user-select: none;
  font-variant-numeric: tabular-nums;
}
.fh-hidden { display: none !important; }

/* ---- crosshair: 4 lines, gap = spreadPx, 2px white w/ dark outline -------- */
.fh-cross { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
.fh-cross div {
  position: absolute; left: 0; top: 0; background: var(--fh-text);
  box-shadow: 0 0 0 1px var(--fh-ink);
}
.fh-ch-t, .fh-ch-b { width: 2px; height: 10px; }
.fh-ch-l, .fh-ch-r { width: 10px; height: 2px; }

/* ---- scope overlay: radial vignette + thin cross + circle edge ------------ */
.fh-scope { position: absolute; inset: 0; }
.fh-scope-vig {
  position: absolute; inset: 0;
  background: radial-gradient(circle at 50% 50%,
    transparent 0, transparent 26vmin, var(--fh-scope-ink) 27vmin, var(--fh-scope-ink) 100%);
}
.fh-scope-ring {
  position: absolute; left: 50%; top: 50%; width: 53vmin; height: 53vmin;
  transform: translate(-50%, -50%); border-radius: 50%;
  border: 1px solid var(--fh-text-dim);
}
.fh-scope-h, .fh-scope-v { position: absolute; background: var(--fh-text-dim); }
.fh-scope-h { left: 0; right: 0; top: 50%; height: 1px; }
.fh-scope-v { top: 0; bottom: 0; left: 50%; width: 1px; }

/* ---- hitmarker: 4 diagonal ticks, 120ms flash ----------------------------- */
.fh-hit { position: absolute; left: 50%; top: 50%; width: 0; height: 0; opacity: 0; }
.fh-hit.fh-on { opacity: 1; }
.fh-hit div {
  position: absolute; left: -1px; top: -14px; width: 2px; height: 9px;
  background: var(--fh-text); box-shadow: 0 0 0 1px var(--fh-ink);
}
.fh-hit.fh-red div { background: var(--fh-danger); }
.fh-hit .fh-hm1 { transform: rotate(45deg)  translateY(-6px); }
.fh-hit .fh-hm2 { transform: rotate(135deg) translateY(-6px); }
.fh-hit .fh-hm3 { transform: rotate(225deg) translateY(-6px); }
.fh-hit .fh-hm4 { transform: rotate(315deg) translateY(-6px); }

/* ---- damage direction ring (arcs injected as SVG paths, pooled) ----------- */
.fh-dmg { position: absolute; left: 50%; top: 50%; width: 160px; height: 160px;
  transform: translate(-50%, -50%); }
.fh-dmg path { opacity: 0; }
.fh-dmg path.fh-on { animation: fh-arcfade ${DAMAGE_MS}ms linear forwards; }
@keyframes fh-arcfade { 0% { opacity: 0.95; } 100% { opacity: 0; } }

/* ---- top-center: phase, timer, BUY chip, score, round --------------------- */
.fh-top { position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 18px; }
.fh-score { font-size: 24px; font-weight: 700; letter-spacing: 1px;
  background: var(--fh-ink-55); padding: 4px 12px; border-radius: 3px; }
.fh-score-t { color: var(--fh-t); }
.fh-score-ct { color: var(--fh-ct); }
.fh-clock { text-align: center; background: var(--fh-ink-55);
  padding: 4px 14px 6px; border-radius: 3px; min-width: 96px; }
.fh-phase { font-size: 12px; letter-spacing: 2px; color: var(--fh-text-dim); }
.fh-timer { font-size: 26px; font-weight: 700; line-height: 1.1; }
.fh-buy { display: inline-block; margin-top: 2px; font-size: 12px; font-weight: 700;
  letter-spacing: 1px; color: var(--fh-ink); background: var(--fh-accent);
  padding: 1px 8px; border-radius: 2px; text-shadow: none; }
.fh-round { position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
  margin-top: 6px; font-size: 12px; letter-spacing: 2px; color: var(--fh-text-dim);
  background: var(--fh-ink-55); padding: 2px 8px; border-radius: 2px; white-space: nowrap; }

/* ---- HP bottom-left -------------------------------------------------------- */
.fh-hp { position: absolute; left: 24px; bottom: 24px; }
.fh-hp-num { font-size: 38px; font-weight: 700; line-height: 1; }
.fh-hp-bar { width: 220px; height: 8px; margin-top: 6px;
  background: var(--fh-ink-55); border-radius: 2px; overflow: hidden; }
.fh-hp-fill { height: 100%; background: var(--fh-hp); border-radius: 2px;
  transition: width 120ms linear; }
.fh-hp.fh-low .fh-hp-fill { background: var(--fh-danger); }
.fh-hp.fh-low .fh-hp-num { color: var(--fh-danger); animation: fh-pulse 1.1s ease-in-out infinite; }
@keyframes fh-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }

/* ---- money + ammo bottom-right -------------------------------------------- */
.fh-ammo { position: absolute; right: 24px; bottom: 24px; text-align: right; }
.fh-money { font-size: 17px; font-weight: 700; color: var(--fh-accent);
  transition: color 200ms; }
.fh-money.fh-flash { color: var(--fh-hp); }
.fh-wname { font-size: 13px; letter-spacing: 2px; color: var(--fh-text-dim);
  margin-top: 4px; text-transform: uppercase; }
.fh-magline { line-height: 1; margin-top: 2px; }
.fh-mag { font-size: 42px; font-weight: 700; }
.fh-mag.fh-empty { color: var(--fh-danger); }
.fh-res { font-size: 17px; color: var(--fh-text-dim); margin-left: 6px; }
.fh-reload { font-size: 13px; font-weight: 700; letter-spacing: 2px;
  color: var(--fh-danger); margin-top: 4px; animation: fh-pulse 1.1s ease-in-out infinite; }

/* ---- killfeed top-right ---------------------------------------------------- */
.fh-feed { position: absolute; right: 18px; top: 16px; display: flex;
  flex-direction: column; align-items: flex-end; gap: 4px; }
.fh-row { font-size: 13px; background: var(--fh-ink-55); border-radius: 2px;
  padding: 3px 9px; letter-spacing: 0.5px; white-space: nowrap;
  opacity: 1; transition: opacity 400ms; }
.fh-row.fh-fade { opacity: 0; }
.fh-row .fh-w { color: var(--fh-text-dim); margin: 0 7px; font-size: 12px; }
.fh-row .fh-hs { color: var(--fh-danger); font-weight: 700; margin-left: 4px; }

/* ---- banner (round start/end), queued -------------------------------------- */
.fh-banner { position: absolute; left: 50%; top: 26%; transform: translateX(-50%);
  text-align: center; opacity: 0; transition: opacity 400ms; white-space: nowrap; }
.fh-banner.fh-on { opacity: 1; }
.fh-banner-t { font-size: 44px; font-weight: 800; letter-spacing: 4px; }
.fh-banner-s { font-size: 16px; letter-spacing: 2px; color: var(--fh-text-dim); margin-top: 6px; }

/* ---- dead / spectating ------------------------------------------------------ */
.fh-vig { position: absolute; inset: 0;
  background: radial-gradient(ellipse at 50% 50%,
    transparent 0, transparent 45%, var(--fh-ink-70) 100%); }
.fh-spec { position: absolute; left: 50%; bottom: 15%; transform: translateX(-50%);
  font-size: 16px; letter-spacing: 3px; background: var(--fh-ink-55);
  padding: 5px 14px; border-radius: 3px; white-space: nowrap; }
`;

export class Hud {
  private readonly layer: HTMLDivElement;

  // crosshair / scope
  private readonly cross: HTMLDivElement;
  private readonly chT: HTMLDivElement;
  private readonly chB: HTMLDivElement;
  private readonly chL: HTMLDivElement;
  private readonly chR: HTMLDivElement;
  private readonly scope: HTMLDivElement;

  // hitmarker
  private readonly hit: HTMLDivElement;
  private hitTimer = 0;

  // damage ring (pooled arcs)
  private readonly arcs: SVGPathElement[] = [];
  private arcNext = 0;

  // top center
  private readonly phaseEl: HTMLDivElement;
  private readonly timerEl: HTMLDivElement;
  private readonly buyEl: HTMLDivElement;
  private readonly roundEl: HTMLDivElement;
  private readonly scoreTEl: HTMLDivElement;
  private readonly scoreCTEl: HTMLDivElement;

  // hp / ammo / money
  private readonly hpWrap: HTMLDivElement;
  private readonly hpNum: HTMLDivElement;
  private readonly hpFill: HTMLDivElement;
  private readonly moneyEl: HTMLDivElement;
  private moneyTimer = 0;
  private readonly wnameEl: HTMLDivElement;
  private readonly magEl: HTMLSpanElement;
  private readonly resEl: HTMLSpanElement;
  private readonly reloadEl: HTMLDivElement;

  // feed / banner / spectate
  private readonly feed: HTMLDivElement;
  private readonly bannerEl: HTMLDivElement;
  private readonly bannerT: HTMLDivElement;
  private readonly bannerS: HTMLDivElement;
  private bannerBusy = false;
  private readonly bannerQueue: Array<{ title: string; sub: string }> = [];
  private readonly vig: HTMLDivElement;
  private readonly specEl: HTMLDivElement;

  // change-detection cache (update() touches DOM only on change)
  private cHp = -1;
  private cLow = false;
  private cAlive = true;
  private cMoney = -1;
  private cCanBuy = false;
  private cWname = '';
  private cMag = -2;
  private cRes = -2;
  private cPhase: RoomPhase | '' = '';
  private cSec = -1;
  private cRound = -1;
  private cScoreT = -1;
  private cScoreCT = -1;
  private cGap = -1;
  private cScoped = false;
  private cSpec: string | null = null;

  constructor(root: HTMLElement) {
    // PALETTE -> CSS custom properties on the root (single source of truth).
    const st = root.style;
    st.setProperty('--fh-text', PALETTE.hudText);
    st.setProperty('--fh-text-dim', alpha(PALETTE.hudText, 0.62));
    st.setProperty('--fh-accent', PALETTE.hudAccent);
    st.setProperty('--fh-danger', PALETTE.danger);
    st.setProperty('--fh-hp', PALETTE.hpGreen);
    st.setProperty('--fh-ink', PALETTE.ink);
    st.setProperty('--fh-ink-55', alpha(PALETTE.ink, 0.55));
    st.setProperty('--fh-ink-70', alpha(PALETTE.ink, 0.72));
    st.setProperty('--fh-scope-ink', alpha(PALETTE.ink, 0.97));
    st.setProperty('--fh-t', PALETTE.tAmber);
    st.setProperty('--fh-ct', PALETTE.ctBlue);

    if (document.getElementById(STYLE_ID) === null) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    this.layer = div('fh-layer');
    root.appendChild(this.layer);

    // spectate vignette (under everything else)
    this.vig = div('fh-vig fh-hidden');
    this.layer.appendChild(this.vig);

    // damage ring — fixed SVG, arcs pooled + reused round-robin
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 160 160');
    svg.setAttribute('class', 'fh-dmg');
    for (let i = 0; i < ARC_POOL; i++) {
      const p = document.createElementNS(svgNS, 'path');
      // arc segment centered on 12 o'clock (yawRelative 0 = ahead)
      p.setAttribute('d', 'M 54.64 25.62 A 60 60 0 0 1 105.36 25.62');
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', PALETTE.danger);
      p.setAttribute('stroke-width', '6');
      p.setAttribute('stroke-linecap', 'round');
      svg.appendChild(p);
      this.arcs.push(p);
    }
    this.layer.appendChild(svg);

    // crosshair
    this.cross = div('fh-cross');
    this.chT = div('fh-ch-t');
    this.chB = div('fh-ch-b');
    this.chL = div('fh-ch-l');
    this.chR = div('fh-ch-r');
    this.cross.append(this.chT, this.chB, this.chL, this.chR);
    this.layer.appendChild(this.cross);

    // scope overlay
    this.scope = div('fh-scope fh-hidden');
    this.scope.append(div('fh-scope-vig'), div('fh-scope-h'), div('fh-scope-v'), div('fh-scope-ring'));
    this.layer.appendChild(this.scope);

    // hitmarker
    this.hit = div('fh-hit');
    this.hit.append(div('fh-hm1'), div('fh-hm2'), div('fh-hm3'), div('fh-hm4'));
    this.layer.appendChild(this.hit);

    // top center: score T | clock | score CT, round beneath
    const top = div('fh-top');
    this.scoreTEl = div('fh-score fh-score-t');
    this.scoreCTEl = div('fh-score fh-score-ct');
    const clock = div('fh-clock');
    this.phaseEl = div('fh-phase');
    this.timerEl = div('fh-timer');
    this.buyEl = div('fh-buy fh-hidden');
    this.buyEl.textContent = 'BUY (B)';
    this.roundEl = div('fh-round');
    clock.append(this.phaseEl, this.timerEl, this.buyEl, this.roundEl);
    top.append(this.scoreTEl, clock, this.scoreCTEl);
    this.layer.appendChild(top);

    // HP bottom-left
    this.hpWrap = div('fh-hp');
    this.hpNum = div('fh-hp-num');
    const bar = div('fh-hp-bar');
    this.hpFill = div('fh-hp-fill');
    bar.appendChild(this.hpFill);
    this.hpWrap.append(this.hpNum, bar);
    this.layer.appendChild(this.hpWrap);

    // money + ammo bottom-right
    const ammo = div('fh-ammo');
    this.moneyEl = div('fh-money');
    this.wnameEl = div('fh-wname');
    const magline = div('fh-magline');
    this.magEl = document.createElement('span');
    this.magEl.className = 'fh-mag';
    this.resEl = document.createElement('span');
    this.resEl.className = 'fh-res';
    magline.append(this.magEl, this.resEl);
    this.reloadEl = div('fh-reload fh-hidden');
    this.reloadEl.textContent = 'R TO RELOAD';
    ammo.append(this.moneyEl, this.wnameEl, magline, this.reloadEl);
    this.layer.appendChild(ammo);

    // killfeed
    this.feed = div('fh-feed');
    this.layer.appendChild(this.feed);

    // banner
    this.bannerEl = div('fh-banner');
    this.bannerT = div('fh-banner-t');
    this.bannerS = div('fh-banner-s');
    this.bannerEl.append(this.bannerT, this.bannerS);
    this.layer.appendChild(this.bannerEl);

    // spectating label
    this.specEl = div('fh-spec fh-hidden');
    this.layer.appendChild(this.specEl);
  }

  update(s: HudState): void {
    // hp
    const hp = Math.max(0, Math.round(s.hp));
    if (hp !== this.cHp) {
      this.cHp = hp;
      this.hpNum.textContent = String(hp);
      this.hpFill.style.width = `${hp}%`;
    }
    const low = s.alive && hp < LOW_HP;
    if (low !== this.cLow) {
      this.cLow = low;
      this.hpWrap.classList.toggle('fh-low', low);
    }

    // money (flash green on increase)
    if (s.money !== this.cMoney) {
      const gained = this.cMoney >= 0 && s.money > this.cMoney;
      this.cMoney = s.money;
      this.moneyEl.textContent = `$ ${s.money}`;
      if (gained) {
        this.moneyEl.classList.add('fh-flash');
        window.clearTimeout(this.moneyTimer);
        this.moneyTimer = window.setTimeout(() => this.moneyEl.classList.remove('fh-flash'), 450);
      }
    }

    // weapon / ammo (mag -1 = melee)
    if (s.weaponName !== this.cWname) {
      this.cWname = s.weaponName;
      this.wnameEl.textContent = s.weaponName;
    }
    if (s.mag !== this.cMag) {
      this.cMag = s.mag;
      this.magEl.textContent = s.mag < 0 ? '—' : String(s.mag);
      this.magEl.classList.toggle('fh-empty', s.mag === 0);
      this.reloadEl.classList.toggle('fh-hidden', s.mag !== 0);
    }
    if (s.reserve !== this.cRes) {
      this.cRes = s.reserve;
      this.resEl.textContent = s.reserve < 0 ? '' : `/ ${s.reserve}`;
    }

    // phase / timer / buy chip / round / score
    if (s.phase !== this.cPhase) {
      this.cPhase = s.phase;
      this.phaseEl.textContent = PHASE_LABEL[s.phase];
    }
    const timed = s.phase === 'freeze' || s.phase === 'live' || s.phase === 'roundEnd';
    const sec = timed ? Math.max(0, Math.ceil(s.phaseEndsInSec)) : -1;
    if (sec !== this.cSec) {
      this.cSec = sec;
      if (sec < 0) {
        this.timerEl.textContent = '';
        this.timerEl.classList.add('fh-hidden');
      } else {
        this.timerEl.classList.remove('fh-hidden');
        const mm = Math.floor(sec / 60);
        const ss = sec % 60;
        this.timerEl.textContent = `${mm}:${ss < 10 ? '0' : ''}${ss}`;
      }
    }
    if (s.canBuy !== this.cCanBuy) {
      this.cCanBuy = s.canBuy;
      this.buyEl.classList.toggle('fh-hidden', !s.canBuy);
    }
    if (s.round !== this.cRound) {
      this.cRound = s.round;
      this.roundEl.textContent = s.round > 0 ? `ROUND ${s.round}` : '';
    }
    if (s.scoreT !== this.cScoreT) {
      this.cScoreT = s.scoreT;
      this.scoreTEl.textContent = `T ${s.scoreT}`;
    }
    if (s.scoreCT !== this.cScoreCT) {
      this.cScoreCT = s.scoreCT;
      this.scoreCTEl.textContent = `${s.scoreCT} CT`;
    }

    // crosshair gap = spreadPx; hidden while scoped (scope overlay instead)
    const gap = Math.max(2, Math.round(s.spreadPx));
    if (gap !== this.cGap) {
      this.cGap = gap;
      this.chT.style.transform = `translate(-1px, ${-(gap + 10)}px)`;
      this.chB.style.transform = `translate(-1px, ${gap}px)`;
      this.chL.style.transform = `translate(${-(gap + 10)}px, -1px)`;
      this.chR.style.transform = `translate(${gap}px, -1px)`;
    }
    if (s.scoped !== this.cScoped) {
      this.cScoped = s.scoped;
      this.cross.classList.toggle('fh-hidden', s.scoped);
      this.scope.classList.toggle('fh-hidden', !s.scoped);
    }

    // dead / spectating
    if (s.alive !== this.cAlive) {
      this.cAlive = s.alive;
      this.vig.classList.toggle('fh-hidden', s.alive);
    }
    if (s.spectating !== this.cSpec) {
      this.cSpec = s.spectating;
      this.specEl.classList.toggle('fh-hidden', s.spectating === null);
      if (s.spectating !== null) {
        // 'respawn in N' is a self countdown, not a spectate target — no prefix.
        this.specEl.textContent = s.spectating.startsWith('respawn')
          ? s.spectating
          : `SPECTATING ${s.spectating}`;
      }
    }
  }

  /** ≤5 rows, newest on top, each fades out after 5s. */
  killfeed(killer: string | null, victim: string, weapon: WeaponId, headshot: boolean): void {
    const row = div('fh-row');
    const k = document.createElement('span');
    k.textContent = killer ?? '—';
    const w = document.createElement('span');
    w.className = 'fh-w';
    w.textContent = `[${WEAPON_SHORT[weapon]}]`;
    const v = document.createElement('span');
    v.textContent = victim;
    row.append(k, w, v);
    if (headshot) {
      const hs = document.createElement('span');
      hs.className = 'fh-hs';
      hs.textContent = '✕';
      row.appendChild(hs);
    }
    this.feed.prepend(row);
    while (this.feed.childElementCount > KILLFEED_MAX) {
      this.feed.lastElementChild?.remove();
    }
    window.setTimeout(() => {
      row.classList.add('fh-fade');
      window.setTimeout(() => row.remove(), 450);
    }, KILLFEED_MS);
  }

  /** 4 diagonal ticks flash 120ms; red on headshot or kill. */
  hitmarker(headshot: boolean, killed: boolean): void {
    this.hit.classList.toggle('fh-red', headshot || killed);
    this.hit.classList.add('fh-on');
    window.clearTimeout(this.hitTimer);
    this.hitTimer = window.setTimeout(() => this.hit.classList.remove('fh-on'), HITMARK_MS);
  }

  /** Red arc pointing at the damage source. yawRelative 0 = ahead, positive =
   *  source to the left (yaw increases CCW) — hence the negative CSS rotation. */
  damageFrom(yawRelative: number): void {
    const arc = this.arcs[this.arcNext];
    if (arc === undefined) return; // pool is fixed-size; unreachable, satisfies noUncheckedIndexedAccess
    this.arcNext = (this.arcNext + 1) % ARC_POOL;
    const deg = (-yawRelative * 180) / Math.PI;
    arc.setAttribute('transform', `rotate(${deg} 80 80)`);
    arc.classList.add('fh-on');
    // restart the fade via WAAPI — no layout read on the combat hot path
    arc.getAnimations().forEach((a) => { a.cancel(); a.play(); });
  }

  /** Big center text for 2.5s; queues while another banner is up. */
  banner(title: string, sub: string): void {
    this.bannerQueue.push({ title, sub });
    this.pumpBanner();
  }

  private pumpBanner(): void {
    if (this.bannerBusy) return;
    const next = this.bannerQueue.shift();
    if (next === undefined) return;
    this.bannerBusy = true;
    this.bannerT.textContent = next.title;
    this.bannerS.textContent = next.sub;
    this.bannerEl.classList.add('fh-on');
    window.setTimeout(() => {
      this.bannerEl.classList.remove('fh-on');
      window.setTimeout(() => {
        this.bannerBusy = false;
        this.pumpBanner();
      }, 420); // wait out the opacity transition before the next banner
    }, BANNER_MS);
  }

  show(on: boolean): void {
    this.layer.classList.toggle('fh-hidden', !on);
  }
}

function div(cls: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

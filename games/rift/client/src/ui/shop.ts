// ============================================================================
// ANCIENTS (rift) client — SHOP (CONTRACT §6 ui/shop.ts, T9). A .shop-panel
// toggled from the HUD gold readout: a .shop-grid of every ITEM_LIST entry
// with icon, name, .shop-cost, and blurb. Buying is SERVER-AUTHORITATIVE: the
// client only greys (insufficient gold / outside own fountain radius) and the
// server ignores anything illegal — the grey is courtesy, not a gate. Click
// buys into the first free slot via actions.send({t:'rift_buy'}).
//
// DOM CLASS CONTRACT (§6): renders only .shop-panel .shop-grid .shop-item
// .shop-cost; structural children (icon, name, blurb, header) are classless —
// T8 styles them via descendant selectors. The only inline colours are APAL
// entries; the disabled state is inline opacity (the class list has no state
// classes). Gold text is >= 12px inline (§8 floor).
// ============================================================================
import { APAL, FOUNTAIN_RADIUS, ITEM_LIST } from '@rift/shared';
import type { ClientState, UiActions, UiHandle } from '../contract.js';

const FONT_MIN_PX = 12;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string | null,
  parent: HTMLElement,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls !== null) e.className = cls;
  parent.appendChild(e);
  return e;
}

function setText(e: HTMLElement, s: string): void {
  if (e.textContent !== s) e.textContent = s;
}

interface ShopRow {
  button: HTMLButtonElement;
  cost: HTMLElement;
  costValue: number;
}

export function createShop(parent: HTMLElement): UiHandle {
  const root = el('div', 'shop-panel', parent);
  root.style.display = 'none';

  const header = el('div', null, root); // T8: `.shop-panel > div:first-child`
  const title = el('b', null, header);
  title.textContent = 'SHOP';
  title.style.fontSize = '16px';
  const goldReadout = el('span', null, header);
  goldReadout.style.fontSize = '14px';
  goldReadout.style.color = APAL.gold;
  const note = el('span', null, header);
  note.style.fontSize = `${FONT_MIN_PX}px`;
  note.textContent = 'buy at your fountain — the server decides';
  const close = el('button', null, header); // T8: `.shop-panel button`
  close.textContent = '✕';
  close.title = 'Close the shop';
  close.onclick = () => actionsRef?.toggleShop();

  const grid = el('div', 'shop-grid', root);

  // one row per ITEM_LIST entry, built once — the list is static data
  const rows: ShopRow[] = [];
  for (const def of ITEM_LIST) {
    const button = el('button', 'shop-item', grid);
    const icon = el('b', null, button);
    icon.textContent = def.icon;
    const name = el('span', null, button);
    name.textContent = def.name;
    name.style.fontSize = `${FONT_MIN_PX}px`;
    const cost = el('span', 'shop-cost', button);
    cost.style.fontSize = `${FONT_MIN_PX}px`;
    cost.style.color = APAL.gold;
    cost.textContent = `${def.cost}g`;
    const blurb = el('i', null, button);
    blurb.textContent = def.blurb;
    blurb.style.fontSize = `${FONT_MIN_PX}px`;
    button.title = def.blurb;
    button.onclick = () => {
      actionsRef?.send({ t: 'rift_buy', item: def.id });
    };
    rows.push({ button, cost, costValue: def.cost });
  }

  let actionsRef: UiActions | null = null;

  return {
    root,

    render(s: ClientState, a: UiActions): void {
      const open = s.phase === 'live' && s.shopOpen;
      root.style.display = open ? '' : 'none';
      if (!open) return;
      actionsRef = a;

      const you = s.snap?.you ?? null;
      const myTeam = s.hello?.team ?? 0;

      // own Ancient = the fountain anchor (structures are always in the snap)
      let atFountain = false;
      const snap = s.snap;
      if (snap && you) {
        for (const e of snap.ents) {
          if (e.k === 'ancient' && e.team === myTeam) {
            atFountain =
              Math.hypot(you.x - e.x, you.z - e.z) <= FOUNTAIN_RADIUS;
            break;
          }
        }
      }

      const gold = you ? Math.floor(you.gold) : 0;
      setText(goldReadout, ` ${gold}g `);

      for (const row of rows) {
        const affordable = you !== null && you.gold >= row.costValue;
        const enabled = affordable && atFountain;
        row.button.disabled = !enabled;
        row.button.style.opacity = enabled ? '' : '0.4';
      }
    },
  };
}

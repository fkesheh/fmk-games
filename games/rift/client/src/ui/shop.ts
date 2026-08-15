// ============================================================================
// ANCIENTS (rift) client — SHOP (CONTRACT §6 ui/shop.ts, T9). A .shop-panel
// toggled from the HUD gold readout, now split into FOUR sections stacked
// inside the one panel:
//   1. BASE ("bought outright")            — tier 1, itemTier(id) === 1
//   2. FUSED ("base + gold")                — tier 2, itemTier(id) === 2
//   3. ULTIMATE ("fused + fused + gold —
//      frees a slot")                       — tier 3, itemTier(id) === 3
//   4. INVENTORY                            — one row per INVENTORY_SLOTS,
//      sell/drop affordance (see below)
// Each catalogue tier gets its own classless header + its own `.shop-grid`;
// ITEM_LIST is partitioned by `itemTier(def.id)`, never by a hard-coded id
// list, and within-tier order is preserved exactly as ITEM_LIST orders it.
//
// Buying is SERVER-AUTHORITATIVE: the client only greys (insufficient gold /
// missing recipe components / outside own fountain radius) and the server
// ignores anything illegal — the grey is courtesy, not a gate. Click buys
// into the first free slot via actions.send({t:'rift_buy'}).
//
// RECIPE LEGIBILITY: a recipe row's "Needs: …" line is rebuilt every render
// from `you.items` (not built once at construction), marking each component
// held (✓) or missing (✗) by glyph alone — no extra APAL colour is layered
// on top of the check/cross, since the glyph alone already carries the
// distinction cleanly. Recipe rows also show the item's TOTAL gold cost
// (item.ts `itemTotalCost`) as a classless "total NNNNg" line under the
// `.shop-cost` step price, so a buyer can see the full investment, not just
// the next step.
//
// INVENTORY / SELL / DROP: below the catalogue, one classless row per
// INVENTORY_SLOTS slot, built once and refreshed from `s.snap.you.items`
// every render. An occupied row shows the icon + name and two classless
// buttons:
//   - Sell — label previews the refund BEFORE committing, e.g. "Sell 1440g"
//     (item.ts `sellValue`); enabled only when the slot is occupied, the
//     player is alive, AND standing at their own fountain (same gate as
//     buying). Sends {t:'rift_sell', slot}.
//   - Drop — destroys the item for NO refund, so it needs a two-step
//     confirm: the first click on a slot ARMS it (its Drop label becomes
//     "Sure?"); a second click on the SAME slot sends {t:'rift_drop', slot}.
//     Enabled whenever the slot is occupied and the player is alive,
//     regardless of position. Armed state lives in a closure variable
//     (`armedSlot`) inside `createShop` — no timers, no randomness. Arming a
//     different slot, buying, selling, or the panel going non-open (closing
//     the shop) all clear it; the render loop clears it unconditionally
//     whenever the panel is not open, which covers every close path.
// Empty slots render a muted placeholder with both buttons disabled.
//
// DOM CLASS CONTRACT (§6) — UNCHANGED: renders only .shop-panel .shop-grid
// .shop-item .shop-cost; every structural child (icon, name, blurb, headers,
// the inventory rows and their buttons) is classless — T8 styles the four
// classes via CSS, everything else here is inline. The only inline colours
// are APAL entries; the disabled state is inline opacity (the class list has
// no state classes). All text is >= 12px inline (§8 floor, FONT_MIN_PX).
// ============================================================================
import { APAL, FOUNTAIN_RADIUS, INVENTORY_SLOTS, ITEMS, ITEM_LIST, itemTier, itemTotalCost, sellValue } from '@rift/shared';
import type { ItemDef, ItemId } from '@rift/shared';
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

function addSectionHeader(parent: HTMLElement, title: string, subtitle: string): void {
  const header = el('div', null, parent); // classless section header
  const t = el('b', null, header);
  t.textContent = title;
  t.style.fontSize = '13px';
  t.style.color = APAL.paper;
  const s = el('span', null, header);
  s.textContent = subtitle;
  s.style.fontSize = `${FONT_MIN_PX}px`;
  s.style.color = APAL.paperDim;
}

interface ShopRow {
  readonly id: ItemId;
  readonly button: HTMLButtonElement;
  readonly costValue: number;
  /** Recipe component ids when the item combines, else null. */
  readonly components: readonly ItemId[] | null;
  /** Recipe "Needs: …" line, re-rendered every frame; null for base items. */
  readonly needsEl: HTMLElement | null;
}

interface InvRow {
  readonly icon: HTMLElement;
  readonly name: HTMLElement;
  readonly sellBtn: HTMLButtonElement;
  readonly dropBtn: HTMLButtonElement;
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

  let actionsRef: UiActions | null = null;
  /** Two-step drop confirm: first click arms a slot, second click on the SAME
   *  slot fires the drop. Cleared whenever the panel is not open (see
   *  render()), or when a different slot is armed, or on buy/sell — all
   *  handled inline at each of those call sites. Closure state only, per
   *  createShop() instance — no timers, no randomness. */
  let armedSlot: number | null = null;

  const rows: ShopRow[] = [];

  function buildGrid(defs: readonly ItemDef[]): void {
    const grid = el('div', 'shop-grid', root);
    for (const def of defs) {
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
      if (def.recipe) {
        const total = el('i', null, button);
        total.style.fontSize = `${FONT_MIN_PX}px`;
        total.style.color = APAL.paperDim;
        total.textContent = `total ${itemTotalCost(def.id)}g`;
      }
      const blurb = el('i', null, button);
      blurb.textContent = def.blurb;
      blurb.style.fontSize = `${FONT_MIN_PX}px`;
      button.title = def.blurb;

      let needsEl: HTMLElement | null = null;
      if (def.recipe) {
        const path = def.recipe.components.map((c) => ITEMS[c].name).join(' + ');
        needsEl = el('i', null, button);
        needsEl.style.fontSize = `${FONT_MIN_PX}px`;
        // placeholder text; render() overwrites with the held/missing marks
        // every frame from `you.items`
        needsEl.textContent = `Needs: ${path} + ${def.recipe.cost}g`;
        button.title = `${def.blurb}\nRequires: ${path} + ${def.recipe.cost}g (total ${itemTotalCost(def.id)}g)`;
      }

      button.onclick = () => {
        armedSlot = null; // buying clears any armed drop confirm
        actionsRef?.send({ t: 'rift_buy', item: def.id });
      };
      rows.push({
        id: def.id,
        button,
        costValue: def.cost,
        components: def.recipe?.components ?? null,
        needsEl,
      });
    }
  }

  // catalogue, grouped by tier — partitioned from ITEM_LIST, never hard-coded
  const tier1 = ITEM_LIST.filter((d) => itemTier(d.id) === 1);
  const tier2 = ITEM_LIST.filter((d) => itemTier(d.id) === 2);
  const tier3 = ITEM_LIST.filter((d) => itemTier(d.id) === 3);

  addSectionHeader(root, 'BASE', 'bought outright');
  buildGrid(tier1);
  addSectionHeader(root, 'FUSED', 'base + gold');
  buildGrid(tier2);
  addSectionHeader(root, 'ULTIMATE', 'fused + fused + gold — frees a slot');
  buildGrid(tier3);

  // -- inventory: sell (fountain-gated, refunds 60% of total) / drop (anywhere,
  //    alive, no refund) --------------------------------------------------------
  addSectionHeader(
    root,
    'INVENTORY',
    'sell only at your fountain (60% refund) — drop works anywhere, refunds nothing',
  );
  const invList = el('div', null, root); // classless column of slot rows
  invList.style.display = 'flex';
  invList.style.flexDirection = 'column';
  invList.style.gap = '6px';

  const invRows: InvRow[] = [];
  for (let i = 0; i < INVENTORY_SLOTS; i++) {
    const row = el('div', null, invList);
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '6px';
    row.style.padding = '4px 6px';
    row.style.borderBottom = `1px solid ${APAL.inkDeep}`;

    const icon = el('b', null, row);
    icon.style.width = '18px';
    icon.style.textAlign = 'center';

    const name = el('span', null, row);
    name.style.fontSize = `${FONT_MIN_PX}px`;
    name.style.flex = '1';
    name.style.minWidth = '0';

    const sellBtn = el('button', null, row);
    sellBtn.style.fontSize = `${FONT_MIN_PX}px`;
    sellBtn.style.color = APAL.gold;
    sellBtn.style.background = 'transparent';
    sellBtn.style.border = `1px solid ${APAL.goldDeep}`;
    sellBtn.style.borderRadius = '3px';
    sellBtn.style.padding = '2px 6px';
    sellBtn.style.cursor = 'pointer';

    const dropBtn = el('button', null, row);
    dropBtn.style.fontSize = `${FONT_MIN_PX}px`;
    dropBtn.style.color = APAL.danger;
    dropBtn.style.background = 'transparent';
    dropBtn.style.border = `1px solid ${APAL.danger}`;
    dropBtn.style.borderRadius = '3px';
    dropBtn.style.padding = '2px 6px';
    dropBtn.style.cursor = 'pointer';

    const slotIndex = i;
    sellBtn.onclick = () => {
      armedSlot = null; // selling clears any armed drop confirm
      actionsRef?.send({ t: 'rift_sell', slot: slotIndex });
    };
    dropBtn.onclick = () => {
      if (armedSlot === slotIndex) {
        actionsRef?.send({ t: 'rift_drop', slot: slotIndex });
        armedSlot = null;
      } else {
        armedSlot = slotIndex; // arms this slot, implicitly disarms any other
      }
    };

    invRows.push({ icon, name, sellBtn, dropBtn });
  }

  return {
    root,

    render(s: ClientState, a: UiActions): void {
      const open = s.phase === 'live' && s.shopOpen;
      root.style.display = open ? '' : 'none';
      if (!open) {
        // Closing the shop (by any path) clears the drop-confirm arm.
        armedSlot = null;
        return;
      }
      actionsRef = a;

      const you = s.snap?.you ?? null;
      const myTeam = s.hello?.team ?? 0;
      const matchTick = s.snap?.matchTick ?? 0;
      // "0 while alive" (YouSnap.respawnAtTick); a nonzero value that has
      // already passed still reads alive, matching hud.ts's heroDead check.
      const alive = you !== null && !(you.respawnAtTick > 0 && matchTick < you.respawnAtTick);

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
        if (row.needsEl !== null && row.components !== null) {
          const path = row.components
            .map((c) => `${you !== null && you.items.includes(c) ? '✓' : '✗'}${ITEMS[c].name}`)
            .join(' + ');
          setText(row.needsEl, `Needs: ${path} + ${row.costValue}g`);
        }
        // Recipe rows also grey out while a component is missing — courtesy
        // only; the server remains the gate.
        const hasComponents =
          row.components === null ||
          (you !== null && row.components.every((c) => you.items.includes(c)));
        const affordable = you !== null && you.gold >= row.costValue && hasComponents;
        const enabled = affordable && atFountain;
        row.button.disabled = !enabled;
        row.button.style.opacity = enabled ? '' : '0.4';
      }

      const items = you?.items ?? [];
      for (let i = 0; i < INVENTORY_SLOTS; i++) {
        const invRow = invRows[i];
        if (invRow === undefined) continue;
        const id: ItemId | null = items[i] ?? null;
        if (armedSlot === i && id === null) armedSlot = null; // stale arm on an emptied slot

        if (id === null) {
          setText(invRow.icon, '·');
          setText(invRow.name, '— empty —');
          invRow.name.style.color = APAL.paperDim;
          setText(invRow.sellBtn, 'Sell');
          setText(invRow.dropBtn, 'Drop');
          invRow.sellBtn.disabled = true;
          invRow.dropBtn.disabled = true;
          invRow.sellBtn.style.opacity = '0.4';
          invRow.dropBtn.style.opacity = '0.4';
          invRow.sellBtn.title = 'empty slot';
          invRow.dropBtn.title = 'empty slot';
          continue;
        }

        const def = ITEMS[id];
        setText(invRow.icon, def.icon);
        setText(invRow.name, def.name);
        invRow.name.style.color = APAL.paper;

        const refund = sellValue(id);
        setText(invRow.sellBtn, `Sell ${refund}g`);
        const sellEnabled = alive && atFountain;
        invRow.sellBtn.disabled = !sellEnabled;
        invRow.sellBtn.style.opacity = sellEnabled ? '' : '0.4';
        invRow.sellBtn.title = sellEnabled
          ? `Sell for ${refund}g`
          : 'sell at your own fountain — refunds 60% of total cost';

        const armed = armedSlot === i;
        setText(invRow.dropBtn, armed ? 'Sure?' : 'Drop');
        invRow.dropBtn.disabled = !alive;
        invRow.dropBtn.style.opacity = alive ? '' : '0.4';
        invRow.dropBtn.title = !alive
          ? 'cannot drop while dead'
          : armed
            ? 'click again to confirm — no refund'
            : 'discard this item — no refund';
      }
    },
  };
}

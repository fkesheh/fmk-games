// App wiring — URL state (headless judge surface), gallery UI, controls,
// stats HUD, and the ready signal the capture script waits on.
import { ASSETS, ASSET_MATERIAL, assetById, type BuiltAsset, type Quality } from '@assets/library';
import { Stage, type AngleName } from './stage';

interface UrlState {
  asset: string;
  variation: string;
  lod: Quality;
  wind: number; // 0..1
  angle: AngleName;
  ui: boolean;
  autorot: boolean;
}

function readUrl(): UrlState {
  const p = new URLSearchParams(location.search);
  const lod = (p.get('lod') ?? 'hero') as Quality;
  const angle = (p.get('angle') ?? 'three-quarter') as AngleName;
  return {
    asset: p.get('asset') ?? ASSETS[0]!.meta.id,
    variation: p.get('variation') ?? '',
    lod: ['hero', 'lod', 'micro'].includes(lod) ? lod : 'hero',
    wind: Math.max(0, Math.min(1, Number(p.get('wind') ?? 0.5))),
    angle: ['front', 'three-quarter', 'high', 'closeup'].includes(angle) ? angle : 'three-quarter',
    ui: p.get('ui') !== '0',
    autorot: p.get('autorot') !== '0',
  };
}

function pushUrl(state: UrlState): void {
  const p = new URLSearchParams({
    asset: state.asset, variation: state.variation, lod: state.lod,
    wind: state.wind.toFixed(2), angle: state.angle,
    ui: state.ui ? '1' : '0', autorot: state.autorot ? '1' : '0',
  });
  history.replaceState(null, '', `?${p.toString()}`);
}

const state = readUrl();
if (!state.ui) document.body.classList.add('bare'); // BEFORE sizing the stage

const host = document.getElementById('canvas-host')!;
const stage = new Stage(host);
stage.setWireframe(false);
stage.setAutoRotate(state.autorot);

let current: BuiltAsset | null = null;
let currentAssetId = '';
let currentVariation = '';
let currentLod: Quality = state.lod;
let windOn = state.wind > 0;
let windStrength = state.wind;

function resolveVariationId(assetId: string, wanted: string): string {
  const mod = assetById(assetId)!;
  if (/^\d+$/.test(wanted)) return mod.meta.variations[Number(wanted)]?.id ?? mod.meta.variations[0]!.id;
  if (mod.meta.variations.some((v) => v.id === wanted)) return wanted;
  return mod.meta.variations[0]!.id;
}

function rebuild(): void {
  const mod = assetById(currentAssetId);
  if (!mod) return;
  current = mod.buildVariation(currentVariation, currentLod);
  stage.show(current, state.angle);
  renderStats();
  renderNotes();
}

// ---- gallery ----
const listEl = document.getElementById('asset-list')!;
const thumbs = new Map<string, string>();

function buildGallery(): void {
  for (const mod of ASSETS) {
    const card = document.createElement('div');
    card.className = 'asset-card';
    card.dataset.asset = mod.meta.id;
    const img = document.createElement('img');
    img.alt = mod.meta.name;
    const info = document.createElement('div');
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = mod.meta.name;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${mod.meta.variations.length} variations`;
    info.append(nm, meta);
    card.append(img, info);
    card.addEventListener('click', () => {
      currentAssetId = mod.meta.id;
      currentVariation = mod.meta.variations[0]!.id;
      refreshAll();
    });
    listEl.appendChild(card);
    // thumbnail from a quick hero build of variation 0
    const built = mod.build('hero');
    thumbs.set(mod.meta.id, stage.thumbnail(built, 128));
    built.mesh.geometry.dispose();
  }
  for (const card of listEl.children) {
    const img = (card as HTMLElement).querySelector('img');
    if (img) img.src = thumbs.get((card as HTMLElement).dataset.asset ?? '') ?? '';
  }
}

// ---- controls ----
function renderVariationCtl(): void {
  const mod = assetById(currentAssetId)!;
  const idx = Math.max(0, mod.meta.variations.findIndex((v) => v.id === currentVariation));
  const v = mod.meta.variations[idx]!;
  document.getElementById('var-label')!.textContent = v.label;
  document.getElementById('crumbs')!.innerHTML =
    `library / <b>${mod.meta.name.toLowerCase()}</b> · ${mod.meta.description}`;
}

function renderLodCtl(): void {
  const el = document.getElementById('lod-ctl')!;
  el.innerHTML = '';
  for (const q of ['hero', 'lod', 'micro'] as const) {
    const b = document.createElement('button');
    b.className = 'lod-btn' + (q === currentLod ? ' active' : '');
    b.textContent = q.toUpperCase();
    b.addEventListener('click', () => { currentLod = q; refreshAll(); });
    el.appendChild(b);
  }
}

function renderNotes(): void {
  const mod = assetById(currentAssetId)!;
  const v = mod.meta.variations.find((x) => x.id === currentVariation)!;
  const el = document.getElementById('notes')!;
  el.innerHTML = `<b>${v.label}</b> — ${v.notes}`;
}

function renderStats(): void {
  if (!current) return;
  const mod = assetById(currentAssetId)!;
  const budget = mod.meta.triBudget[currentLod];
  const h = current.bbox.max.y;
  const footprint = Math.max(
    Math.abs(current.bbox.min.x), Math.abs(current.bbox.max.x),
    Math.abs(current.bbox.min.z), Math.abs(current.bbox.max.z),
  );
  const headroom = Math.round((1 - current.tris / budget) * 100);
  const cls = headroom >= 0 ? 'ok' : 'warn';
  document.getElementById('stats')!.innerHTML =
    `<b>${mod.meta.name}</b> · ${currentLod}<br>` +
    `tris <b>${current.tris.toLocaleString()}</b> / ${budget.toLocaleString()} <span class="${cls}">(${headroom >= 0 ? '+' : ''}${headroom}%)</span><br>` +
    `height <b>${h.toFixed(1)} m</b> · footprint <b>${footprint.toFixed(1)} m</b><br>` +
    `draws <b>${stage.renderer.info.render.calls}</b> · 1 mesh · 1 material`;
}

function refreshAll(): void {
  renderVariationCtl();
  renderLodCtl();
  rebuild();
  updateGalleryActive();
  pushUrl({ ...state, asset: currentAssetId, variation: currentVariation, lod: currentLod });
}

function updateGalleryActive(): void {
  for (const card of listEl.children) {
    (card as HTMLElement).classList.toggle('active', (card as HTMLElement).dataset.asset === currentAssetId);
  }
}

// ---- topbar events ----
document.getElementById('var-prev')!.addEventListener('click', () => cycleVariation(-1));
document.getElementById('var-next')!.addEventListener('click', () => cycleVariation(1));
function cycleVariation(dir: number): void {
  const mod = assetById(currentAssetId)!;
  const idx = mod.meta.variations.findIndex((v) => v.id === currentVariation);
  const n = mod.meta.variations.length;
  currentVariation = mod.meta.variations[(idx + dir + n) % n]!.id;
  refreshAll();
}

const windToggle = document.getElementById('wind-toggle') as HTMLInputElement;
const windSlider = document.getElementById('wind-strength') as HTMLInputElement;
windToggle.checked = windOn;
windSlider.value = String(Math.round(windStrength * 100));
windToggle.addEventListener('change', () => { windOn = windToggle.checked; });
windSlider.addEventListener('input', () => { windStrength = Number(windSlider.value) / 100; });

const wireToggle = document.getElementById('wire-toggle') as HTMLInputElement;
wireToggle.addEventListener('change', () => stage.setWireframe(wireToggle.checked));

const spinToggle = document.getElementById('spin-toggle') as HTMLInputElement;
spinToggle.checked = state.autorot;
spinToggle.addEventListener('change', () => stage.setAutoRotate(spinToggle.checked));

// ---- boot ----
currentAssetId = state.asset;
currentVariation = resolveVariationId(state.asset, state.variation);

// ready signal the capture script waits on

declare global {
  interface Window {
    __ASSETS_READY?: boolean;
  }
}

let ready = false;
function frame(): void {
  stage.tick(windOn ? windStrength : 0);
  if (!ready) {
    ready = true;
    window.__ASSETS_READY = true;
    document.title = 'ready';
  }
  requestAnimationFrame(frame);
}

buildGallery();
refreshAll();
requestAnimationFrame(frame);

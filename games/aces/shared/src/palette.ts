// ============================================================================
// APAL — the ACES palette. FROZEN Layer-1 data.
//
// Every color in the ACES client traces to an entry here. Ad-hoc hex literals
// anywhere under games/aces/client are a contract violation reviewers check
// for. The only sanctioned derivations are alpha suffixes ("#rrggbbaa" built
// from these constants) and the mix()/shade() helpers in the client's
// contract/visual.ts — both endpoints must be entries of this table.
//
// Mood anchor (see STYLE_BIBLE): 1917 dawn patrol over a cold strait — warm
// paper sky, ink-drawn silhouettes, two saturated team colors as the only
// loud things in the frame.
// ============================================================================

export const APAL = {
  // ---- sky & light -------------------------------------------------------
  dawnHi: '#f2e3bd', //   high sky — pale warm cream
  dawnLo: '#e3c893', //   horizon band — deeper sand
  sunGlare: '#fff3d6', // sun disc / glint core
  haze: '#d9b98a', //     distant haze wash

  // ---- sea ---------------------------------------------------------------
  seaDeep: '#5e7f7a', //  open water base
  seaLit: '#7b988f', //   sun-lit water streaks
  seaDark: '#49655f', //  shadowed water / cloud shadows
  foam: '#efe6cd', //     surf rings, wakes

  // ---- land --------------------------------------------------------------
  sand: '#d8c39a', //     shore ring
  scrub: '#a8a06b', //    dry island grass
  canopy: '#6f7444', //   palm canopy dark
  rock: '#8a7f66', //     cliff / outcrop

  // ---- aircraft hardware -------------------------------------------------
  dope: '#b7a97e', //     unmarked linen dope (underwing, tail)
  wood: '#7a5b39', //     walnut struts, cowlings, decking
  tire: '#33302b', //     tires, guns, dark detail metal
  prop: '#c7c2b4', //     spinning propeller blur arc

  // ---- team identity (the only saturated loud colors in the world) -------
  // royalNavy sits ≥ ΔE 30 from every sea tone (palette.ladder.test.ts
  // enforces this) — a darker navy camouflaged against the strait in
  // gauntlet review, which is why it is lighter and bluer than instinct.
  royalNavy: '#274e74', // ROYAL AERO CORPS — cold cobalt slate
  royalDeck: '#cbbd93', // ROYAL secondary — deck cream
  ironRed: '#a83a28', //  IRON EMPIRE — signal crimson
  ironDeck: '#2e2a26', // IRON secondary — near-black iron

  // ---- ordnance & fx -----------------------------------------------------
  tracer: '#f0a03a', //   tracer amber
  flash: '#ffe9ad', //    muzzle flash core
  smokeLt: '#b0a78f', //  light smoke (warm paper-gray; must not blend into sea)
  smokeDk: '#55503f', //  heavy smoke / oil
  fireCore: '#f28d35', // fire orange
  fireEdge: '#c0431f', // fire red edge
  blast: '#f5c96b', //    explosion bloom
  debris: '#4a4438', //   debris / shrapnel ink

  // ---- UI (HUD ink on the same paper the sky is painted on) --------------
  ink: '#221f1a', //      HUD ink — type, frames, needlework
  paper: '#ece0bf', //    HUD paper — fills, text on ink
  warn: '#c25430', //     heat / damage warnings
  ok: '#7d8a52', //       healthy / ready states
} as const;

export type ApalKey = keyof typeof APAL;

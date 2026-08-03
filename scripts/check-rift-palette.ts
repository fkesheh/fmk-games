// Pre-freeze sanity: measure APAL against the ladder laws T2 will encode.
import { L, hueDistance, blueBias, isCooler, composite } from '../platform/shared/src/color.ts';
import { APAL } from '../games/rift/shared/src/palette.ts';

const n = (v: number) => v.toFixed(1);
let fail = 0;
function check(name: string, ok: boolean, detail: string) {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
}

// tier floors (bases with L >= 16)
const tiers: [string, string, string, string][] = [
  ['moss', APAL.moss, APAL.mossLit, APAL.mossDeep],
  ['stone', APAL.stone, APAL.stoneLit, APAL.stoneDeep],
  ['monument', APAL.monument, APAL.monumentLit, APAL.monumentDeep],
  ['azure', APAL.azure, APAL.azureLit, APAL.azureDeep],
  ['ember', APAL.ember, APAL.emberLit, APAL.emberDeep],
  ['ink', APAL.ink, APAL.inkLit, APAL.inkDeep],
];
for (const [name, base, lit, deep] of tiers) {
  const lb = L(base), ll = L(lit), ld = L(deep);
  if (lb >= 16) {
    check(`tier ${name} Lit`, ll - lb >= 8, `L ${n(ll)} - ${n(lb)} = ${n(ll - lb)} (need >=8)`);
    check(`tier ${name} Deep`, lb - ld >= 8, `L ${n(lb)} - ${n(ld)} = ${n(lb - ld)} (need >=8)`);
  } else {
    console.log(`SKIP tier ${name}: base L ${n(lb)} < 16 (exempt by construction)`);
  }
}
check('L5 moss floor', L(APAL.moss) >= 22, `L(moss)=${n(L(APAL.moss))}`);
check('stone vs moss', L(APAL.stone) - L(APAL.moss) >= 15, n(L(APAL.stone) - L(APAL.moss)));
check('monument vs moss', L(APAL.monument) - L(APAL.moss) >= 20, n(L(APAL.monument) - L(APAL.moss)));
const fogged = composite(APAL.moss, APAL.shroud, 0.55);
for (const t of ['azure', 'ember'] as const) {
  const dL = Math.abs(L(APAL[t]) - L(APAL.moss));
  const dH = hueDistance(APAL[t], APAL.moss);
  check(`${t} vs moss`, dL >= 18 || dH >= 30, `dL=${n(dL)} dH=${n(dH)}`);
  const dLf = Math.abs(L(APAL[t]) - L(fogged));
  const dHf = hueDistance(APAL[t], fogged);
  check(`${t} vs fogged moss (${fogged})`, dLf >= 18 || dHf >= 30, `dL=${n(dLf)} dH=${n(dHf)}`);
}
check('azure vs ember', hueDistance(APAL.azure, APAL.ember) >= 25 || Math.abs(L(APAL.azure) - L(APAL.ember)) >= 20,
  `dH=${n(hueDistance(APAL.azure, APAL.ember))} dL=${n(Math.abs(L(APAL.azure) - L(APAL.ember)))}`);
check('S1 cooler', isCooler(APAL.skyHigh, APAL.horizon), `bias ${n(blueBias(APAL.skyHigh))} vs ${n(blueBias(APAL.horizon))}`);
check('S1 darker>=12', L(APAL.horizon) - L(APAL.skyHigh) >= 12, n(L(APAL.horizon) - L(APAL.skyHigh)));
check('S2 fog==horizon', APAL.fog === APAL.horizon, `${APAL.fog} vs ${APAL.horizon}`);
check('S4 ground!=horizon', APAL.moss !== APAL.horizon, '');
check('paper on ink >= 60', L(APAL.paper) - L(APAL.ink) >= 60, n(L(APAL.paper) - L(APAL.ink)));
// hero accents pairwise
const accents = ['frost', 'heal', 'shade', 'pine', 'void', 'gold'] as const;
for (let i = 0; i < accents.length; i++)
  for (let j = i + 1; j < accents.length; j++) {
    const a = APAL[accents[i]!], b = APAL[accents[j]!];
    const dH = hueDistance(a, b), dL = Math.abs(L(a) - L(b));
    check(`accent ${accents[i]} vs ${accents[j]}`, dH >= 25 || dL >= 20, `dH=${n(dH)} dL=${n(dL)}`);
  }
console.log(fail === 0 ? 'ALL GREEN' : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

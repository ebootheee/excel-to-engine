/**
 * Generate Control Baseline
 *
 * Runs your reference engines across a matrix of input scenarios and captures
 * all key outputs as a JSON "answer key" for blind evaluation.
 *
 * Usage: node eval-framework/generate-control.mjs <path-to-reference-engine-dir>
 * Output: eval-framework/control-baseline.json
 */

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { writeFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const engineDir = process.argv[2];
if (!engineDir) { console.error('Usage: node generate-control.mjs <engine-dir>'); process.exit(1); }
const enginePath = resolve(engineDir);

let computeModel, computeModelA2;
try { computeModel = (await import(resolve(enginePath, 'engine.js'))).computeModel; } catch(e) { console.error(e.message); process.exit(1); }
try { computeModelA2 = (await import(resolve(enginePath, 'engine-a2.js'))).computeModelA2; } catch { console.log('No A-2 engine'); }

const EXIT_YEARS = [2028, 2029, 2030, 2031];
const EXIT_YEARS_A2 = [2029, 2030, 2031, 2032];
const EXIT_MULTIPLES = [14, 18, 22, 26];
const NUM_SITES = [0, 10, 20];
const ISSUANCE_PRICES = [1.20, 1.35, 1.50];

function round(v, d=6) { return v==null||isNaN(v)?null:Math.round(v*10**d)/10**d; }
function extract(m, label) {
  return { label, grossMOIC:round(m.returns?.grossMOIC,4), netMOIC:round(m.returns?.netMOIC,4),
    grossIRR:round(m.returns?.grossIRR,6), netIRR:round(m.returns?.netIRR,6),
    grossExitValue:round(m.exitValuation?.grossExitValue,0), netProceeds:round(m.exitValuation?.netProceeds,0),
    transactionCosts:round(m.exitValuation?.transactionCosts,0), debtPayoff:round(m.exitValuation?.debtPayoff,0),
    lpTotal:round(m.waterfall?.lpTotal,0), gpCarry:round(m.waterfall?.gpCarry,0),
    mipTriggered:m.mip?.triggered, mipPayment:round(m.mip?.payment,0),
    mipValuePerShare:round(m.mip?.valuePerShare,4), mipHurdle:round(m.mip?.hurdle,2),
    grossPerShare:round(m.perShare?.gross,4), netPerShare:round(m.perShare?.net,4) };
}

const a1s = [], a2s = [], invs = [];
for (const y of EXIT_YEARS) for (const m of EXIT_MULTIPLES) for (const s of NUM_SITES) {
  const inp = {exitYear:y,ownedExitMultiple:m,numFutureAcquisitions:s};
  try { a1s.push({inputs:inp,outputs:extract(computeModel(inp),`A1_${y}_${m}x_${s}s`)}); } catch(e) { a1s.push({inputs:inp,error:e.message}); }
}
if (computeModelA2) for (const y of EXIT_YEARS_A2) for (const m of EXIT_MULTIPLES) for (const s of NUM_SITES) for (const p of ISSUANCE_PRICES) {
  const inp = {exitYear:y,ownedExitMultiple:m,numFutureAcquisitions:s,issuancePrice:p};
  try { a2s.push({inputs:inp,outputs:extract(computeModelA2(inp),`A2_${y}_${m}x_${s}s_$${p}`)}); } catch(e) { a2s.push({inputs:inp,error:e.message}); }
}
for (const [lo,hi] of [[14,18],[18,22],[22,26]]) {
  const mL=computeModel({ownedExitMultiple:lo}), mH=computeModel({ownedExitMultiple:hi});
  invs.push({rule:`A1: ${hi}x multiple > ${lo}x multiple → higher Gross MOIC`,lo:round(mL.returns.grossMOIC,4),hi:round(mH.returns.grossMOIC,4),holds:mH.returns.grossMOIC>mL.returns.grossMOIC});
}
invs.push({rule:'A1: 10x multiple → MIP should NOT trigger',holds:!computeModel({ownedExitMultiple:10}).mip?.triggered});
invs.push({rule:'A1: 22x multiple → MIP SHOULD trigger',holds:computeModel({ownedExitMultiple:22}).mip?.triggered===true});
if (computeModelA2) for (const [lo,hi] of [[1.20,1.35],[1.35,1.50]]) {
  const mL=computeModelA2({issuancePrice:lo}), mH=computeModelA2({issuancePrice:hi});
  invs.push({rule:`A2: $${hi} issuance > $${lo} issuance → higher per-share gross`,holds:(mH.perShare?.gross||0)>(mL.perShare?.gross||0)});
}

const control = {
  metadata:{generatedAt:new Date().toISOString(),note:'Control baseline. DO NOT share with test instance.'},
  baseCases:{a1:extract(computeModel({}),'A1_BASE'),...(computeModelA2?{a2:extract(computeModelA2({}),'A2_BASE')}:{})},
  a1Scenarios:a1s, a2Scenarios:a2s, combinedScenarios:[], invariants:invs,
  tolerances:{moic:0.02,irr:0.05,exitValue:0.02,mip:0.05,perShare:0.03,invariants:'exact'}
};
const out = resolve(__dirname,'control-baseline.json');
writeFileSync(out,JSON.stringify(control,null,2));
console.log(`✅ ${a1s.length+a2s.length} scenarios + ${invs.length} invariants → ${out}`);

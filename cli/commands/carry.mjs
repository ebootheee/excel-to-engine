/**
 * ete carry — Compute expected GP carry under a waterfall.
 *
 * The single most common PE question: "what's my carry at $X peak equity,
 * N× MoC, Y% ownership?" Without this command, answering required a 7-minute
 * investigation walking label rows (see 3-E2E-test/SESSION_LOG_02_carry.md).
 *
 * Inputs fall back to the manifest in this order:
 *   --peak   ← manifest.baseCaseOutputs.equityBasis or equity.classes[0].basisCell
 *   --moc    ← manifest.baseCaseOutputs.grossMOIC (if no --life given)
 *   --irr    ← manifest.baseCaseOutputs.grossIRR (to solve weighted life)
 *   --pref   ← manifest.carry.waterfall.prefReturn (default 0.08)
 *   --carry  ← manifest.carry.waterfall.carryRate or first carry tier rate (default 0.20)
 *   --life   ← manifest.timeline.holdPeriod, or solved via ln(MoC)/ln(1+IRR)
 *
 * @license MIT
 */

import {
  loadManifest, loadGroundTruth, resolveCell, resolveBaseCaseOutputs,
} from '../../lib/manifest.mjs';
import {
  computeWaterfall, createAmericanWaterfall, createEuropeanWaterfall,
} from '../../lib/waterfall.mjs';

/**
 * Execute the carry command.
 *
 *   ete carry <modelDir> [--peak N] [--moc N] [--life N] [--pref N]
 *                        [--carry N] [--ownership N] [--structure american|european]
 *                        [--format table|json]
 */
export function runCarryCommand(modelDir, args) {
  let manifest = null;
  let baseOutputs = {};

  // modelDir is optional — pure parametric mode works without a manifest.
  if (modelDir) {
    try {
      manifest = loadManifest(modelDir);
      const gt = loadGroundTruth(manifest, modelDir);
      baseOutputs = resolveBaseCaseOutputs(manifest, gt);
    } catch (e) {
      if (!args.peak || !args.moc) {
        return { error: `Could not load manifest from ${modelDir}. Provide --peak and --moc to run without a manifest. (${e.message})` };
      }
    }
  }

  const inputs = resolveInputs(manifest, baseOutputs, args);
  if (inputs.error) return inputs;

  // Build the waterfall
  const structure = (args.structure || 'american').toLowerCase();
  const tiers = structure === 'european'
    ? createEuropeanWaterfall([
        { hurdle: inputs.pref, carry: 0 },
        { hurdle: Infinity, carry: inputs.carry },
      ])
    : createAmericanWaterfall({
        prefReturn: inputs.pref,
        carryPercent: inputs.carry,
        residualLPSplit: 1 - inputs.carry,
        hasCatchup: args.noCatchup ? false : true,
      });

  const netProceeds = inputs.peak * inputs.moc;
  const result = computeWaterfall(netProceeds, inputs.peak, tiers, {
    holdPeriodYears: inputs.life,
    compoundHurdles: args.simpleHurdles ? false : true,
  });

  const ownership = inputs.ownership;
  const ownerShare = ownership != null ? result.gpTotal * ownership : null;

  const payload = {
    inputs,
    structure,
    result,
    ownerShare,
    inferredLifeFromIRR: inputs.lifeInferredFromIRR === true,
    manifestUsed: !!manifest,
  };

  payload._formatted = args.format === 'json'
    ? JSON.stringify(payload, null, 2)
    : formatCarry(payload);

  return payload;
}

// ---------------------------------------------------------------------------
// Input resolution — CLI args → manifest → sensible defaults
// ---------------------------------------------------------------------------

function resolveInputs(manifest, base, args) {
  // Peak equity
  let peak = num(args.peak);
  if (peak == null) {
    peak = num(base.equityBasis);
  }
  if (peak == null && manifest?.equity?.classes?.length) {
    // Sum all equity classes with basisCell if multiple (e.g., "combined" scenario)
    const vals = [];
    for (const ec of manifest.equity.classes) {
      if (ec.basisCell) {
        // loadGroundTruth isn't available here but base already resolved basisCell when single class
        if (ec.id && base[`${ec.id}.equityBasis`] != null) vals.push(base[`${ec.id}.equityBasis`]);
      }
    }
    if (vals.length && args.combined) peak = vals.reduce((a, b) => a + b, 0);
    else if (vals.length) peak = vals[0];
  }
  if (peak == null) {
    return { error: 'Peak equity not determined. Pass --peak <dollars>, or ensure the manifest has equity.classes[0].basisCell set (verify with: ete manifest doctor).' };
  }

  // MoC (gross)
  let moc = num(args.moc);
  if (moc == null) moc = num(base.grossMOIC);
  if (moc == null) {
    return { error: 'MoC not determined. Pass --moc <multiple>, or ensure the manifest has equity.classes[0].grossMOIC set.' };
  }

  // Pref / carry
  const pref = num(args.pref) ?? num(manifest?.carry?.waterfall?.prefReturn) ?? 0.08;
  const carry = num(args.carry) ?? num(manifest?.carry?.waterfall?.carryRate) ?? 0.20;

  // Hold period — either explicit, from manifest timeline, or solved from IRR
  let life = num(args.life);
  let lifeInferredFromIRR = false;
  if (life == null) {
    const investYr = manifest?.timeline?.investmentYear;
    const exitYr = manifest?.timeline?.exitYear;
    if (typeof investYr === 'number' && typeof exitYr === 'number' && exitYr > investYr) {
      life = exitYr - investYr;
    }
  }
  if (life == null) {
    const irr = num(args.irr) ?? num(base.grossIRR);
    if (irr != null && irr > 0 && moc > 1) {
      life = Math.log(moc) / Math.log(1 + irr);
      lifeInferredFromIRR = true;
    }
  }
  if (life == null) {
    return { error: 'Hold period not determined. Pass --life <years> (or --irr <rate> to solve n = ln(MoC)/ln(1+IRR)).' };
  }

  // Ownership (fractional — 0.06 for 6%)
  let ownership = num(args.ownership);
  if (ownership != null && ownership > 1.001) ownership = ownership / 100;

  return { peak, moc, pref, carry, life, ownership, lifeInferredFromIRR };
}

function num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[%,_$]/g, '').trim();
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  // Allow "8%" → 0.08 shorthand
  if (String(v).trim().endsWith('%')) return n / 100;
  return n;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatCarry({ inputs, structure, result, ownerShare, inferredLifeFromIRR, manifestUsed }) {
  const L = [];
  L.push(`Carry estimate (${structure === 'european' ? 'European' : 'American'} waterfall)`);
  L.push('─'.repeat(50));
  L.push('Inputs:');
  L.push(`  Peak equity:    ${fmtCur(inputs.peak)}`);
  L.push(`  MoC (gross):    ${inputs.moc.toFixed(2)}×`);
  L.push(`  Hold period:    ${inputs.life.toFixed(2)}yr${inferredLifeFromIRR ? '  (solved from IRR: n = ln(MoC) / ln(1+IRR))' : ''}`);
  L.push(`  Pref return:    ${(inputs.pref * 100).toFixed(1)}%`);
  L.push(`  GP carry:       ${(inputs.carry * 100).toFixed(1)}%`);
  if (inputs.ownership != null) L.push(`  Ownership:      ${(inputs.ownership * 100).toFixed(2)}%`);
  if (!manifestUsed) L.push(`  (manifest not used — pure parametric mode)`);
  L.push('');
  L.push('Waterfall:');
  for (const t of result.tiers) {
    const dist = fmtCur(t.distributed);
    const lp = fmtCur(t.lpAmount);
    const gp = fmtCur(t.gpAmount);
    L.push(`  ${padRight(t.name, 36)} dist ${padLeft(dist, 10)}   LP ${padLeft(lp, 10)}   GP ${padLeft(gp, 10)}`);
  }
  L.push('');
  L.push('Totals:');
  L.push(`  Net proceeds:   ${fmtCur(result.totalDistributed)}`);
  L.push(`  LP total:       ${fmtCur(result.lpTotal)}   (LP MoC ${result.lpMOIC.toFixed(2)}×)`);
  L.push(`  GP carry:       ${fmtCur(result.gpTotal)}   (${(result.gpCarryPercent * 100).toFixed(1)}% of profit)`);
  if (ownerShare != null) {
    L.push(`  Your share:     ${fmtCur(ownerShare)}   (at ${(inputs.ownership * 100).toFixed(2)}% of GP carry)`);
  }

  // Sanity warning for inferred life
  if (inferredLifeFromIRR) {
    L.push('');
    L.push('  ⚠ Hold period inferred from MoC/IRR, not from actual cash-flow dates.');
    L.push('    For precise carry under irregular capital calls, solve against monthly draws.');
  }
  return L.join('\n');
}

function fmtCur(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function padRight(s, w) { return s.length >= w ? s.substring(0, w) : s + ' '.repeat(w - s.length); }
function padLeft(s, w)  { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

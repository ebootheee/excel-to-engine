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
  loadManifest, loadGroundTruth, loadLabelIndex, resolveCell,
  resolveBaseCaseOutputs, searchByLabel, inFieldRange,
} from '../../lib/manifest.mjs';
import {
  computeWaterfall, createAmericanWaterfall, createEuropeanWaterfall,
  createMoicHurdleWaterfall,
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
  let gt = null;
  let labelIndex = null;

  // modelDir is optional — pure parametric mode works without a manifest.
  if (modelDir) {
    try {
      manifest = loadManifest(modelDir);
      gt = loadGroundTruth(manifest, modelDir);
      baseOutputs = resolveBaseCaseOutputs(manifest, gt);
      labelIndex = loadLabelIndex(modelDir);
    } catch (e) {
      if (!args.peak || !args.moc) {
        return { error: `Could not load manifest from ${modelDir}. Provide --peak and --moc to run without a manifest. (${e.message})` };
      }
    }
  }

  // Model-first path: when the manifest has a valid `carry.totalCell` AND the
  // user hasn't asked for a parametric sensitivity (`--peak` or `--moc`
  // overrides), return the model's OWN computed carry directly. The model's
  // waterfall may use a different structure (multi-tier IRR hurdles, no
  // catch-up, MIP overlays) than our parametric approximation, so trusting
  // the model's cell is more accurate than re-running a generic waterfall.
  // Pass `--parametric` to force the generic computation.
  if (
    manifest?.carry?.totalCell &&
    gt &&
    !args.peak && !args.moc && !args.parametric
  ) {
    const totalCarry = resolveCell(gt, manifest.carry.totalCell);
    if (typeof totalCarry === 'number' && totalCarry !== 0) {
      let ownership = num(args.ownership);
      if (ownership != null && ownership > 1.001) ownership = ownership / 100;
      const ownerShare = ownership != null ? totalCarry * ownership : null;

      const srcRef = manifest.carry.totalCell;
      const srcLabel = typeof srcRef === 'string'
        ? srcRef
        : Array.isArray(srcRef?.cells)
          ? `${(srcRef.op || 'sum').toLowerCase()}(${srcRef.cells.join(', ')})`
          : 'manifest.carry.totalCell';

      const lines = [];
      lines.push(`Carry (from model's own waterfall)`);
      lines.push('─'.repeat(50));
      lines.push(`  Total carry:    ${fmtCur(totalCarry)}`);
      lines.push(`  Source:         ${srcLabel} (manifest.carry.totalCell)`);
      if (ownership != null) {
        lines.push(`  Ownership:      ${(ownership * 100).toFixed(2)}%`);
        lines.push(`  Your share:     ${fmtCur(ownerShare)}`);
      }
      lines.push('');
      lines.push('  Uses the model\'s own computed Total Carry cell — exact to whatever');
      lines.push('  waterfall structure the model implements. Pass --parametric to run');
      lines.push('  the generic American/European waterfall against --peak/--moc/--irr.');

      return {
        source: 'model',
        totalCarry,
        ownerShare,
        cell: srcLabel,
        ownership,
        _formatted: lines.join('\n'),
      };
    }
  }

  const inputs = resolveInputs(manifest, baseOutputs, args, { gt, labelIndex, caseColumn: args.case || null });
  if (inputs.error) return inputs;

  // Build the waterfall. Three shapes supported:
  //   --hurdle-moic N  → flat-MOIC hurdle, no IRR pref (Class A PPS style)
  //   --structure european → multi-hurdle IRR waterfall
  //   default → American w/ pref + catch-up (omit --no-catchup to disable)
  const structure = (args.structure || 'american').toLowerCase();
  const hurdleMOIC = num(args.hurdleMoic);
  let tiers;
  if (hurdleMOIC != null && hurdleMOIC > 1) {
    tiers = createMoicHurdleWaterfall({
      hurdleMOIC,
      carryPercent: inputs.carry,
    });
  } else if (structure === 'european') {
    tiers = createEuropeanWaterfall([
      { hurdle: inputs.pref, carry: 0 },
      { hurdle: Infinity, carry: inputs.carry },
    ]);
  } else {
    tiers = createAmericanWaterfall({
      prefReturn: inputs.pref,
      carryPercent: inputs.carry,
      residualLPSplit: 1 - inputs.carry,
      hasCatchup: args.noCatchup ? false : true,
    });
  }

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
    hurdleMOIC: hurdleMOIC != null && hurdleMOIC > 1 ? hurdleMOIC : null,
  };

  payload._formatted = args.format === 'json'
    ? JSON.stringify(payload, null, 2)
    : formatCarry(payload);

  return payload;
}

// ---------------------------------------------------------------------------
// Input resolution — CLI args → manifest → sensible defaults
// ---------------------------------------------------------------------------

function resolveInputs(manifest, base, args, ctx = {}) {
  const { gt = null, labelIndex = null, caseColumn = null } = ctx;

  // Peak equity
  let peak = num(args.peak);
  let peakSource = null;
  if (peak == null) {
    peak = num(base.equityBasis);
    if (peak != null) peakSource = 'manifest';
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
    if (vals.length && args.combined) { peak = vals.reduce((a, b) => a + b, 0); peakSource = 'manifest-combined'; }
    else if (vals.length) { peak = vals[0]; peakSource = 'manifest'; }
  }
  if (peak == null && gt) {
    const fb = fallbackSearch(gt, labelIndex, PEAK_PATTERNS, 'basisCell', caseColumn);
    if (fb.kind === 'single') { peak = fb.value; peakSource = `label:${fb.cell}`; }
    else if (fb.kind === 'ambiguous') return { error: formatFallbackError('Peak equity', '--peak <dollars>', fb, 'basisCell') };
  }
  if (peak == null) {
    return { error: 'Peak equity not determined. Pass --peak <dollars>, or ensure the manifest has equity.classes[0].basisCell set (verify with: ete manifest doctor).' };
  }

  // MoC (gross)
  let moc = num(args.moc);
  let mocSource = null;
  if (moc == null) {
    moc = num(base.grossMOIC);
    if (moc != null) mocSource = 'manifest';
  }
  if (moc == null && gt) {
    const fb = fallbackSearch(gt, labelIndex, MOC_PATTERNS, 'grossMOIC', caseColumn);
    if (fb.kind === 'single') { moc = fb.value; mocSource = `label:${fb.cell}`; }
    else if (fb.kind === 'ambiguous') return { error: formatFallbackError('MoC', '--moc <multiple>', fb, 'grossMOIC') };
  }
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
    let irr = num(args.irr) ?? num(base.grossIRR);
    if (irr == null && gt) {
      const fb = fallbackSearch(gt, labelIndex, IRR_PATTERNS, 'grossIRR', caseColumn);
      if (fb.kind === 'single') irr = fb.value;
    }
    if (irr != null && irr > 0 && moc > 1) {
      life = Math.log(moc) / Math.log(1 + irr);
      lifeInferredFromIRR = true;
    }
  }
  // Hold period is only required for IRR-based hurdles. A flat MOIC hurdle
  // (--hurdle-moic) doesn't compound, so `life` is informational only. Set to
  // a placeholder so downstream formatting doesn't break.
  if (life == null) {
    if (num(args.hurdleMoic) != null) {
      life = 0;
    } else {
      return { error: 'Hold period not determined. Pass --life <years> (or --irr <rate> to solve n = ln(MoC)/ln(1+IRR)).' };
    }
  }

  // Ownership (fractional — 0.06 for 6%)
  let ownership = num(args.ownership);
  if (ownership != null && ownership > 1.001) ownership = ownership / 100;

  return { peak, moc, pref, carry, life, ownership, lifeInferredFromIRR, peakSource, mocSource };
}

// ---------------------------------------------------------------------------
// Label-search fallback — when the manifest hasn't bound a field, look it up
// by label so a first-time user doesn't have to hand-wire the manifest before
// getting a carry number out.
// ---------------------------------------------------------------------------

const PEAK_PATTERNS = [
  /peak\s*net\s*equity/i,
  /fund\s*size.*peak/i,
  /peak\s*equity/i,
  /equity\s*basis/i,
  /max\s*equity\s*invested/i,
  /equity\s*invested/i,
];

const MOC_PATTERNS = [
  /gross\s*mo(i?c|ic)\b/i,
  /gross\s*multiple/i,
  /gross\s*mult\b/i,
];

const IRR_PATTERNS = [
  /gross\s*irr/i,
  /levered\s*irr/i,
  /fund\s*irr/i,
];

/**
 * Search the ground truth for any of `patterns`, keeping only matches whose
 * adjacent numeric value passes `rangeField`'s validation. When `caseColumn`
 * is provided, the value from that column is preferred; otherwise the
 * rightmost in-range value on each match row is taken.
 *
 * Returns one of:
 *   { kind: 'none' }
 *   { kind: 'single', value, cell, label }
 *   { kind: 'ambiguous', candidates }  (caller prints them and errors)
 */
function fallbackSearch(gt, labelIndex, patterns, rangeField, caseColumn) {
  const found = [];
  const seen = new Set();
  for (const pattern of patterns) {
    const matches = searchByLabel(gt, pattern.source, {
      regex: true,
      index: labelIndex,
      caseColumn,
      maxResults: 25,
    });
    for (const m of matches) {
      const key = `${m.sheet}!${m.col}${m.row}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let pick = null;
      if (caseColumn) {
        const col = String(caseColumn).toUpperCase();
        const hit = m.values.find(v => v.col === col && inFieldRange(rangeField, v.value));
        if (hit) pick = { value: hit.value, cell: `${m.sheet}!${col}${m.row}` };
      }
      if (!pick) {
        const inRange = m.values.filter(v => inFieldRange(rangeField, v.value));
        if (inRange.length === 0) continue;
        inRange.sort((a, b) => colLetterRank(b.col) - colLetterRank(a.col));
        pick = { value: inRange[0].value, cell: `${m.sheet}!${inRange[0].col}${m.row}` };
      }

      found.push({ value: pick.value, cell: pick.cell, label: m.label, sheet: m.sheet });
    }
  }

  if (found.length === 0) return { kind: 'none' };
  if (found.length === 1) return { kind: 'single', ...found[0] };

  // Dedupe by numeric value — a handful of labels often resolve to the same
  // cell when the summary tab restates the same number in multiple places.
  const byValue = new Map();
  for (const f of found) {
    if (!byValue.has(f.value)) byValue.set(f.value, f);
  }
  if (byValue.size === 1) {
    return { kind: 'single', ...byValue.values().next().value };
  }
  return { kind: 'ambiguous', candidates: Array.from(byValue.values()).slice(0, 8) };
}

function formatFallbackError(field, flagHint, fb, rangeField) {
  const lines = [`${field} not determined (multiple label candidates found — pass ${flagHint} or bind the field in manifest).`];
  lines.push('Candidates:');
  for (const c of fb.candidates) {
    lines.push(`  ${c.cell}: ${c.value}  (from "${c.label}" on ${c.sheet})`);
  }
  lines.push(`To resolve, pick one and re-run with ${flagHint} <value>, or run:`);
  lines.push(`  ete manifest set <modelDir> equity.classes[0].${rangeField} <cellRef>`);
  return lines.join('\n');
}

function colLetterRank(col) {
  let n = 0;
  for (let i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64);
  return n;
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

function formatCarry({ inputs, structure, result, ownerShare, inferredLifeFromIRR, manifestUsed, hurdleMOIC }) {
  const L = [];
  const shape = hurdleMOIC ? `${hurdleMOIC.toFixed(2)}x MOIC hurdle`
    : (structure === 'european' ? 'European' : 'American') + ' waterfall';
  L.push(`Carry estimate (${shape})`);
  L.push('─'.repeat(50));
  L.push('Inputs:');
  L.push(`  Peak equity:    ${fmtCur(inputs.peak)}${inputs.peakSource && inputs.peakSource.startsWith('label:') ? `  (via label lookup at ${inputs.peakSource.slice(6)})` : ''}`);
  L.push(`  MoC (gross):    ${inputs.moc.toFixed(2)}×${inputs.mocSource && inputs.mocSource.startsWith('label:') ? `  (via label lookup at ${inputs.mocSource.slice(6)})` : ''}`);
  if (hurdleMOIC) {
    L.push(`  Hurdle:         ${hurdleMOIC.toFixed(2)}× (flat MOIC — does not compound with hold)`);
  } else {
    L.push(`  Hold period:    ${inputs.life.toFixed(2)}yr${inferredLifeFromIRR ? '  (solved from IRR: n = ln(MoC) / ln(1+IRR))' : ''}`);
    L.push(`  Pref return:    ${(inputs.pref * 100).toFixed(1)}%`);
  }
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

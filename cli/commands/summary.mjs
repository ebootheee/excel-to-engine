/**
 * ete summary — One-shot model overview.
 *
 * Reads manifest + ground truth, formats key metrics
 * for quick consumption by agents or humans.
 *
 * @license MIT
 */

import { loadManifest, loadGroundTruth, resolveCell, resolveBaseCaseOutputs, resolveEquityClass } from '../../lib/manifest.mjs';
import { detectDateColumns } from '../extractors/date-detector.mjs';
import { aggregateSegmentPnL, computeCAGR } from '../extractors/annual-aggregator.mjs';
import { fmtNum } from '../format.mjs';

/**
 * Execute the summary command.
 */
export function runSummary(modelDir, args) {
  const manifest = loadManifest(modelDir);
  const gt = loadGroundTruth(manifest, modelDir);

  const dateResult = detectDateColumns(gt, {
    sheet: manifest.timeline?.dateSheet,
    row: manifest.timeline?.dateRow,
  });

  // Resolve base case outputs
  const outputs = resolveBaseCaseOutputs(manifest, gt);

  // Aggregate segment P&L
  const segments = manifest.segments || [];
  const pnl = segments.length > 0 ? aggregateSegmentPnL(gt, segments, dateResult) : null;

  // Resolve equity classes
  const equityClasses = (manifest.equity?.classes || []).map(ec => resolveEquityClass(gt, ec));

  // Build summary
  const summary = {
    model: {
      name: manifest.model?.name || 'Unknown',
      type: manifest.model?.type || 'unknown',
      source: manifest.model?.source,
    },
    timeline: {
      investmentYear: manifest.timeline?.investmentYear,
      exitYear: manifest.timeline?.exitYear,
      holdPeriod: (manifest.timeline?.exitYear || 0) - (manifest.timeline?.investmentYear || 0),
      periodicity: manifest.timeline?.periodicity,
    },
    segments: [],
    outputs,
    equityClasses,
    carry: null,
    debt: null,
  };

  // Segments with first/last year values and CAGR
  if (pnl) {
    const years = Object.keys(pnl.totals.ebitda).map(Number).sort();
    summary.timeline.years = years;

    for (const [id, seg] of Object.entries(pnl.segments)) {
      const annual = seg.annual;
      const annualYears = Object.keys(annual).map(Number).sort();
      const first = annual[annualYears[0]];
      const last = annual[annualYears[annualYears.length - 1]];
      const cagr = annualYears.length >= 2 ? computeCAGR(first, last, annualYears.length - 1) : null;

      summary.segments.push({ id, label: seg.label, type: seg.type, first, last, cagr });
    }

    // EBITDA summary
    const eFirst = pnl.totals.ebitda[years[0]];
    const eLast = pnl.totals.ebitda[years[years.length - 1]];
    summary.ebitda = {
      first: eFirst,
      last: eLast,
      cagr: years.length >= 2 ? computeCAGR(eFirst, eLast, years.length - 1) : null,
    };
  }

  // Carry
  if (manifest.carry?.totalCell) {
    summary.carry = {
      total: resolveCell(gt, manifest.carry.totalCell),
      tiers: (manifest.carry.tiers || []).length,
      prefReturn: manifest.carry.waterfall?.prefReturn,
      carryRate: manifest.carry.waterfall?.carryRate,
    };
  }

  // Debt
  if (manifest.debt?.exitBalance) {
    summary.debt = {
      exitBalance: resolveCell(gt, manifest.debt.exitBalance),
      exitCash: manifest.debt.exitCash ? resolveCell(gt, manifest.debt.exitCash) : null,
    };
  }

  // Format
  summary._formatted = formatSummaryTable(summary);

  if (args.format === 'json') {
    const { _formatted, ...data } = summary;
    summary._formatted = JSON.stringify(data, null, 2);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatSummaryTable(s) {
  const lines = [];

  // Header
  lines.push(`Model: ${s.model.name} (${s.model.type})`);
  lines.push(`Source: ${s.model.source || '—'}`);

  const exitMultiple = s.outputs.exitMultiple;
  const multStr = exitMultiple ? ` @ ${exitMultiple.toFixed(1)}x EBITDA` : '';
  lines.push(`Period: ${s.timeline.investmentYear}–${s.timeline.exitYear} (${s.timeline.holdPeriod}yr, ${s.timeline.periodicity}) | Exit: ${s.timeline.exitYear}${multStr}`);
  lines.push('');

  // Segments
  if (s.segments.length > 0) {
    const colW = 12;
    lines.push(padRight('Revenue Segments', 32) + padLeft('Start', colW) + padLeft('Exit', colW) + padLeft('CAGR', colW));
    for (const seg of s.segments) {
      const cagrStr = seg.cagr !== null ? fmtPct(seg.cagr) : '—';
      lines.push(
        padRight(`  ${seg.label}`, 32) +
        padLeft(fmtCur(seg.first), colW) +
        padLeft(fmtCur(seg.last), colW) +
        padLeft(cagrStr, colW)
      );
    }
    lines.push('');
  }

  // EBITDA
  if (s.ebitda) {
    const cagrStr = s.ebitda.cagr !== null ? fmtPct(s.ebitda.cagr) : '—';
    lines.push(`Platform EBITDA             ${fmtCur(s.ebitda.first)} → ${fmtCur(s.ebitda.last)}  (CAGR: ${cagrStr})`);
  }
  if (s.outputs.terminalValue) lines.push(`Terminal Value              ${fmtCur(s.outputs.terminalValue)}`);
  if (s.outputs.exitEquity) lines.push(`Exit Equity                 ${fmtCur(s.outputs.exitEquity)}`);
  lines.push('');

  // Returns
  lines.push(padRight('Returns', 20) + padLeft('Gross', 12) + padLeft('Net', 12));
  lines.push(
    padRight('  MOIC', 20) +
    padLeft(s.outputs.grossMOIC ? `${s.outputs.grossMOIC.toFixed(2)}x` : '—', 12) +
    padLeft(s.outputs.netMOIC ? `${s.outputs.netMOIC.toFixed(2)}x` : '—', 12)
  );
  lines.push(
    padRight('  IRR', 20) +
    padLeft(s.outputs.grossIRR ? fmtPct(s.outputs.grossIRR) : '—', 12) +
    padLeft(s.outputs.netIRR ? fmtPct(s.outputs.netIRR) : '—', 12)
  );
  lines.push('');

  // Carry
  if (s.carry) {
    const tierInfo = s.carry.tiers > 0 ? ` (${s.carry.tiers} tiers)` : '';
    const prefStr = s.carry.prefReturn ? `, ${(s.carry.prefReturn * 100).toFixed(0)}% pref` : '';
    lines.push(`Carry: ${fmtCur(s.carry.total)}${tierInfo}${prefStr}`);
  }

  // Equity classes
  if (s.equityClasses.length > 0) {
    const labels = s.equityClasses.map(ec => ec.label).join(', ');
    const basis = s.equityClasses[0]?.basisCell;
    const basisVal = s.outputs.equityBasis;
    lines.push(`Equity: ${s.equityClasses.length} class(es) (${labels})${basisVal ? `, basis ${fmtCur(basisVal)}` : ''}`);
  }

  // Debt
  if (s.debt) {
    const cashStr = s.debt.exitCash ? ` | Cash: ${fmtCur(s.debt.exitCash)}` : '';
    lines.push(`Debt at exit: ${fmtCur(s.debt.exitBalance)}${cashStr}`);
  }

  // Custom
  if (s.outputs.pricePerShare) {
    lines.push(`Price per share: $${s.outputs.pricePerShare.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
  }

  return lines.join('\n');
}

function fmtCur(val) {
  if (val === null || val === undefined) return '—';
  const abs = Math.abs(val);
  if (abs >= 1e9) return `$${(val / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(val / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(val / 1e3).toFixed(0)}K`;
  return `$${val.toFixed(0)}`;
}

function fmtPct(val) {
  if (val === null || val === undefined) return '—';
  return `${(val * 100).toFixed(1)}%`;
}

function padRight(s, w) { return s.length >= w ? s.substring(0, w) : s + ' '.repeat(w - s.length); }
function padLeft(s, w) { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

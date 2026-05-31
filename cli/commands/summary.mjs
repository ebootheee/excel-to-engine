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

  // Fund-level LP metrics (resolved) — TVPI/DPI/RVPI/netIRR/called/distributed/NAV.
  const fundLevel = {};
  if (manifest.fundLevel) {
    for (const [k, v] of Object.entries(manifest.fundLevel)) {
      const val = (typeof v === 'string' && v.includes('!')) ? resolveCell(gt, v) : (typeof v === 'number' ? v : null);
      if (val != null) fundLevel[k] = val;
    }
  }
  // Covenants (resolved) — DSCR/LTV/ICR/leverage/occupancy.
  const covenants = (manifest.covenants || []).map(c => ({
    id: c.id, label: c.label,
    value: (typeof c.cell === 'string') ? resolveCell(gt, c.cell) : c.value,
  })).filter(c => typeof c.value === 'number');

  // Hold period from the number of periods (column count), not exitYear-investYear
  // (an N-year forecast spans N columns = N-1 deltas; analysts read "N-year").
  const colCount = manifest.timeline?.columnMap ? Object.keys(manifest.timeline.columnMap).length : 0;
  const span = (manifest.timeline?.exitYear || 0) - (manifest.timeline?.investmentYear || 0);

  const exitMultipleType = manifest.outputs?.exitMultiple?.type || null;

  // The exit-value output is frequently an "Exit Equity Value" cell, which is
  // wrong to print under a hardcoded "Terminal Value" heading (a buyout's
  // terminal value is enterprise value). Use the cell's own label so the
  // headline never misnames a $225M equity figure as terminal value.
  let terminalValueLabel = null;
  const tvCell = manifest.outputs?.terminalValue?.cell;
  if (typeof tvCell === 'string') terminalValueLabel = rowLabelFor(gt, tvCell);

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
      holdPeriod: colCount > 1 ? colCount : (span || null),
      periodicity: manifest.timeline?.periodicity,
    },
    fundLevel,
    covenants,
    exitMultipleType,
    terminalValueLabel,
    lens: detectLens(manifest, fundLevel, covenants, outputs),
    segments: [],
    outputs,
    equityClasses,
    carry: null,
    debt: null,
    scenarioBlocks: manifest.scenarioBlocks || [],
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

      // Suspect: row is constant across all years (likely a scalar assumption,
      // not a P&L stream). Surfaces the issue without requiring a separate
      // manifest doctor run.
      const vals = annualYears.map(y => annual[y]).filter(v => typeof v === 'number');
      const allEqual = vals.length >= 2 && vals.every(v => v === vals[0]);
      const suspect = allEqual;

      summary.segments.push({ id, label: seg.label, type: seg.type, first, last, cagr, suspect });
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
  summary._formatted = formatSummaryTable(summary, { terse: !!args.terse });

  if (args.format === 'json') {
    const { _formatted, ...data } = summary;
    summary._formatted = JSON.stringify(data, null, 2);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatSummaryTable(s, opts = {}) {
  const { terse = false } = opts;
  const lines = [];

  // Header
  lines.push(`Model: ${s.model.name} (${s.model.type})`);
  lines.push(`Source: ${s.model.source || '—'}`);

  const em = s.outputs.exitMultiple;
  let multStr = '';
  if (em != null) {
    if (s.exitMultipleType === 'cap_rate_inverse') {
      // A debt/credit model's exit yield is the DEBT YIELD (NOI / loan), not a
      // property cap rate — the lens distinguishes them.
      const yieldLabel = s.lens === 'credit' ? 'debt yield' : 'cap rate';
      multStr = ` @ ${fmtPct(em)} ${yieldLabel}`;
    } else if (s.lens === 'credit') {
      // Direct-lending: the "x" is exit LEVERAGE (turns of Debt/EBITDA), not an
      // EBITDA purchase multiple. It's surfaced in the Lender Returns block below,
      // so don't mislabel it as a buyout-style entry multiple in the header.
      multStr = '';
    } else {
      multStr = ` @ ${em.toFixed(1)}x ${exitBasis(s.lens, s.exitMultipleType)}`;
    }
  }
  lines.push(`Period: ${s.timeline.investmentYear}–${s.timeline.exitYear} (${s.timeline.holdPeriod}yr, ${s.timeline.periodicity}) | Exit: ${s.timeline.exitYear}${multStr}`);
  lines.push('');

  // Segments — drop ratio/percent rows (DSCR, LTV, leverage, growth %, margin,
  // NRR, multiples): those are KPIs, not revenue/cost segments, and rendering
  // them as "$2" with bogus CAGRs is a top trust-killer. terse also hides
  // constant-value (scalar-assumption) rows.
  const RATIO_RX = /\bdscr\b|\bltv\b|coverage|leverage|\bratio\b|debt\s*yield|occupancy|per\s*share|growth|margin|\bnrr\b|retention|churn|\birr\b|\bmoic\b|multiple|cap\s*rate|magic|rule\s*of\s*40|\byield\b/i;
  const isRatio = (seg) => RATIO_RX.test(seg.label || '');
  const ratioCount = s.segments.filter(isRatio).length;
  const nonRatio = s.segments.filter(seg => !isRatio(seg));
  const visibleSegments = terse ? nonRatio.filter(seg => !seg.suspect) : nonRatio;
  const suspectCount = nonRatio.filter(seg => seg.suspect).length;

  if (visibleSegments.length > 0) {
    const colW = 12;
    lines.push(padRight('Segments', 32) + padLeft('Start', colW) + padLeft('Exit', colW) + padLeft('CAGR', colW));
    for (const seg of visibleSegments) {
      const cagrStr = seg.cagr !== null ? fmtPct(seg.cagr) : '—';
      const marker = seg.suspect ? ' ⚠' : '';
      lines.push(
        padRight(`  ${seg.label}${marker}`, 32) +
        padLeft(fmtCur(seg.first), colW) +
        padLeft(fmtCur(seg.last), colW) +
        padLeft(cagrStr, colW)
      );
    }
    if (!terse && suspectCount > 0) {
      lines.push('');
      lines.push(`  ⚠ ${suspectCount} segment(s) have constant values across all years — likely scalar assumptions, not P&L streams.`);
      lines.push(`    Run: ete manifest doctor <modelDir>  (or summary --terse to hide)`);
    } else if (terse && suspectCount > 0) {
      lines.push(`  (${suspectCount} suspect segment(s) hidden — run without --terse to show)`);
    }
    lines.push('');
  }

  // Operating line — labeled by lens; suppressed for funds (no operating P&L)
  // and only shown when there's a real, non-zero series (no fabricated EBITDA).
  // Only for lenses where the segment-derived EBITDA/revenue total is reliable.
  // Funds have no operating P&L; credit/RE headlines are covenants / exit value,
  // and their segment tables already show NOI/borrower-EBITDA rows directly.
  if (s.ebitda && (s.lens === 'equity' || s.lens === 'saas' || s.lens === 'corp') && Math.abs(s.ebitda.last || 0) > 0) {
    const cagrStr = s.ebitda.cagr !== null ? fmtPct(s.ebitda.cagr) : '—';
    lines.push(`${padRight(operatingLabel(s.lens), 28)}${fmtCur(s.ebitda.first)} → ${fmtCur(s.ebitda.last)}  (CAGR: ${cagrStr})`);
  }
  // Corporate (DCF / operating-plan) headline — Enterprise Value + Equity Value are
  // the FP&A / corp-dev deliverables; the discounted-terminal-value stub is an
  // intermediate and is suppressed below for this lens.
  if (s.lens === 'corp' && (s.outputs.enterpriseValue != null || s.outputs.equityValue != null)) {
    if (s.outputs.enterpriseValue != null) lines.push(`${padRight('Enterprise Value', 28)}${fmtCur(s.outputs.enterpriseValue)}`);
    if (s.outputs.equityValue != null) lines.push(`${padRight('Equity Value', 28)}${fmtCur(s.outputs.equityValue)}`);
    if (s.outputs.wacc != null) lines.push(`${padRight('  WACC (discount rate)', 28)}${fmtPct(s.outputs.wacc)}`);
  }
  if (s.outputs.terminalValue && s.lens !== 'corp') {
    const lensLabel = s.lens === 'realestate' ? 'Exit Value' : s.lens === 'fund' ? 'Total Value' : 'Terminal Value';
    // Prefer the cell's actual label (e.g. "Exit Equity Value") over a generic
    // heading so the headline can't misname equity as terminal/enterprise value.
    const tvLabel = (s.terminalValueLabel && s.terminalValueLabel.length <= 28) ? s.terminalValueLabel : lensLabel;
    lines.push(`${padRight(tvLabel, 28)}${fmtCur(s.outputs.terminalValue)}`);
  }
  if (s.outputs.exitEquity) lines.push(`${padRight('Exit Equity', 28)}${fmtCur(s.outputs.exitEquity)}`);
  lines.push('');

  // Fund (LP) metrics block — the headline for VC funds / FoF.
  const fl = s.fundLevel || {};
  if (fl.tvpi != null || fl.dpi != null || fl.rvpi != null) {
    lines.push('Fund (LP) metrics');
    const r1 = [];
    if (fl.tvpi != null) r1.push(`TVPI ${fmtMult(fl.tvpi)}`);
    if (fl.dpi != null) r1.push(`DPI ${fmtMult(fl.dpi)}`);
    if (fl.rvpi != null) r1.push(`RVPI ${fmtMult(fl.rvpi)}`);
    if (fl.netIRR != null) r1.push(`Net IRR ${fmtPct(fl.netIRR)}`);
    if (r1.length) lines.push('  ' + r1.join('  |  '));
    const r2 = [];
    if (fl.fundSize != null) r2.push(`Committed ${fmtCur(fl.fundSize)}`);
    if (fl.paidIn != null) r2.push(`Called ${fmtCur(fl.paidIn)}`);
    if (fl.distributed != null) r2.push(`Distributed ${fmtCur(fl.distributed)}`);
    if (fl.residualValue != null) r2.push(`NAV ${fmtCur(fl.residualValue)}`);
    if (r2.length) lines.push('  ' + r2.join('  |  '));
    lines.push('');
  }

  // Returns — handle class-prefixed keys so a single-class model still shows them.
  const hr = headlineReturns(s.outputs);
  // Credit (direct-lending) lens → a LENDER returns block: yield to lender, MOIC,
  // exit leverage. A lender has no carry / net-of-fees concept, so the generic
  // Gross/Net equity table with its "net of carry not shown" footnote reads wrong.
  // (real_estate_debt shares the credit lens but carries no grossIRR/MOIC, so it
  // skips this block and the generic one — its debt-yield header is the headline.)
  if (s.lens === 'credit' && (hr.grossIRR != null || hr.grossMOIC != null)) {
    lines.push('Lender Returns');
    if (hr.grossIRR != null) lines.push(padRight('  Yield to Lender (Gross IRR)', 32) + padLeft(fmtPct(hr.grossIRR), 8));
    if (hr.grossMOIC != null) lines.push(padRight('  MOIC', 32) + padLeft(fmtMult(hr.grossMOIC), 8));
    if (s.outputs.exitMultiple != null && s.exitMultipleType !== 'cap_rate_inverse') {
      lines.push(padRight('  Exit Leverage (Debt/EBITDA)', 32) + padLeft(`${s.outputs.exitMultiple.toFixed(1)}x`, 8));
    }
    lines.push('');
  } else if (hr.grossMOIC != null || hr.grossIRR != null || hr.netMOIC != null || hr.netIRR != null) {
    lines.push(padRight('Returns', 20) + padLeft('Gross', 12) + padLeft('Net', 12));
    lines.push(padRight('  MOIC', 20) + padLeft(fmtMult(hr.grossMOIC), 12) + padLeft(fmtMult(hr.netMOIC), 12));
    lines.push(padRight('  IRR', 20) + padLeft(hr.grossIRR != null ? fmtPct(hr.grossIRR) : '—', 12) + padLeft(hr.netIRR != null ? fmtPct(hr.netIRR) : '—', 12));
    // Explain the Net dashes in plain English — a bare "—" reads as "broken",
    // especially to an LP-facing analyst who cares most about net returns.
    if ((hr.grossMOIC != null || hr.grossIRR != null) && hr.netMOIC == null && hr.netIRR == null) {
      lines.push('  (Net of fees/carry not shown — this model has no net-return cell; derive from gross + carry, or add one in Excel.)');
    }
    lines.push('');
  }

  // Carry
  if (s.carry) {
    const tierInfo = s.carry.tiers > 0 ? ` (${s.carry.tiers} tiers)` : '';
    const prefStr = s.carry.prefReturn ? `, ${(s.carry.prefReturn * 100).toFixed(0)}% pref` : '';
    lines.push(`Carry: ${fmtCur(s.carry.total)}${tierInfo}${prefStr}`);
  }

  // Equity classes (skip the nag for fund/credit lenses where it's not a concept)
  if (s.equityClasses.length > 0 && s.lens !== 'fund' && s.lens !== 'credit') {
    const labels = s.equityClasses.map(ec => ec.label).filter(Boolean).join(', ');
    const basisVal = hr.equityBasis;
    lines.push(`Equity: ${s.equityClasses.length} class(es)${labels ? ` (${labels})` : ''}${basisVal ? `, basis ${fmtCur(basisVal)}` : ''}`);
  }

  // Debt
  if (s.debt) {
    const cashStr = s.debt.exitCash ? ` | Cash: ${fmtCur(s.debt.exitCash)}` : '';
    lines.push(`Debt at exit: ${fmtCur(s.debt.exitBalance)}${cashStr}`);
  }

  // Covenants block — DSCR/LTV/ICR/leverage. The headline for credit/debt models.
  // Dedup by label and cap so a model with many ratio rows stays readable.
  if ((s.covenants || []).length > 0) {
    const seen = new Set();
    const parts = [];
    for (const c of s.covenants) {
      const key = c.label.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (seen.has(key)) continue;
      seen.add(key);
      const isPct = /ltv|occupancy|yield/i.test(c.label) || (Math.abs(c.value) < 1);
      const v = isPct ? fmtPct(c.value) : fmtMult(c.value);
      parts.push(`${c.label.replace(/\s*\(.*\)\s*$/, '')} ${v}`);
      if (parts.length >= 6) break;
    }
    lines.push(`Covenants: ${parts.join('  |  ')}`);
  }

  // Custom
  if (s.outputs.pricePerShare) {
    lines.push(`Price per share: $${s.outputs.pricePerShare.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
  }

  // Scenario blocks (stacked scenarios on a single sheet, e.g. PE promote sheets)
  if (s.scenarioBlocks && s.scenarioBlocks.length > 0) {
    lines.push('');
    lines.push('Scenario blocks (stacked on same sheet):');
    for (const sb of s.scenarioBlocks) {
      lines.push(`  ${sb.sheet} — ${sb.blocks.length} blocks (stride ${sb.stride} rows, anchor "${sb.anchorLabel}")`);
      for (let i = 0; i < Math.min(sb.blocks.length, 5); i++) {
        const b = sb.blocks[i];
        const label = b.label ? ` — ${b.label}` : '';
        lines.push(`    block ${i + 1}: rows ${b.startRow}–${b.endRow}${label}`);
      }
      if (sb.blocks.length > 5) lines.push(`    (+${sb.blocks.length - 5} more)`);
    }
  }

  return lines.join('\n');
}

/**
 * Pick the right "lens" for the headline so the summary reads correctly for the
 * model family — not just PE buyout. Drives labels + which blocks to show.
 */
function detectLens(manifest, fundLevel, covenants, outputs) {
  const t = (manifest.model?.type || '').toLowerCase();
  const hasFund = fundLevel && (fundLevel.tvpi != null || fundLevel.dpi != null || fundLevel.rvpi != null);
  const hasReturns = outputs.grossMOIC != null || outputs.grossIRR != null
    || Object.keys(outputs).some(k => /\.gross(MOIC|IRR)$/.test(k));
  const hasCovenants = (covenants || []).length > 0;
  const capRate = manifest.outputs?.exitMultiple?.type === 'cap_rate_inverse';
  if (hasFund || t === 'fund_of_funds') return 'fund';              // VC fund / FoF → TVPI/DPI
  if (t === 'corporate' || t === 'three_statement') return 'corp';  // FP&A / DCF → EV + Equity Value
  // Credit + real-estate-DEBT are lender views → DSCR/LTV/debt-yield headline.
  if (t === 'credit' || t === 'real_estate_debt' || (hasCovenants && !hasReturns)) return 'credit';
  if (t === 'infrastructure') return 'realestate';                  // NOI / yield basis
  if (capRate || /re[_-]|real.?estate/.test(t)) return 'realestate'; // NOI + cap rate
  if (t === 'saas' || t === 'growth_equity') return 'saas';          // ARR
  return 'equity';                                     // PE / search_fund / operating (default)
}

/** Label + basis for the operating line, by lens. */
function operatingLabel(lens) {
  return lens === 'realestate' ? 'Net Operating Income'
    : lens === 'saas' ? 'Revenue / ARR'
    : lens === 'credit' ? 'Borrower EBITDA'
    : lens === 'corp' ? 'Operating EBITDA'
    : 'Platform EBITDA';
}

/** Human basis for an exit multiple, by lens + detected type. */
function exitBasis(lens, exitMultipleType) {
  if (exitMultipleType === 'cap_rate_inverse') return 'cap rate';
  // A credit deal's "x" is exit leverage (turns of Debt/EBITDA), not revenue.
  if (lens === 'credit') return 'EBITDA';
  return lens === 'saas' ? 'Revenue' : lens === 'realestate' ? 'NOI' : 'EBITDA';
}

/** Headline returns, handling the class-prefixed keys when there's one class. */
function headlineReturns(outputs) {
  const out = {};
  for (const m of ['grossMOIC', 'grossIRR', 'netMOIC', 'netIRR', 'equityBasis']) {
    if (outputs[m] != null) { out[m] = outputs[m]; continue; }
    const hits = Object.keys(outputs).filter(k => k.endsWith('.' + m));
    if (hits.length === 1) out[m] = outputs[hits[0]];
  }
  return out;
}

function fmtMult(v) { return v == null ? '—' : `${v.toFixed(2)}x`; }

/** Leftmost string cell on the same row as cellRef — the cell's human label. */
function rowLabelFor(gt, cellRef) {
  const bang = cellRef.lastIndexOf('!');
  if (bang < 0) return null;
  const sheet = cellRef.slice(0, bang);
  const m = cellRef.slice(bang + 1).match(/^[A-Z]+(\d+)$/);
  if (!m) return null;
  const row = m[1], prefix = sheet + '!';
  let best = null;
  for (const [addr, v] of Object.entries(gt)) {
    if (typeof v !== 'string') continue;
    if (!addr.startsWith(prefix)) continue;
    const cm = addr.slice(prefix.length).match(/^([A-Z]+)(\d+)$/);
    if (!cm || cm[2] !== row) continue;
    if (!best || cm[1].length < best.col.length || (cm[1].length === best.col.length && cm[1] < best.col)) {
      best = { col: cm[1], text: v.trim() };
    }
  }
  return best ? best.text : null;
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

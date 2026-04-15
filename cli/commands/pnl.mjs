/**
 * ete pnl — Extract annual/quarterly P&L by segment.
 *
 * Reads manifest segments, aggregates ground truth row data
 * into annual buckets, optionally shows subsegment detail
 * and YoY growth rates.
 *
 * @license MIT
 */

import { loadManifest, loadGroundTruth } from '../../lib/manifest.mjs';
import { detectDateColumns } from '../extractors/date-detector.mjs';
import {
  aggregateAnnual, aggregateQuarterly, computeGrowthRates,
  computeCAGR, aggregateSegmentPnL,
} from '../extractors/annual-aggregator.mjs';

/**
 * Execute the pnl command.
 *
 * @param {string} modelDir
 * @param {Object} args
 * @returns {Object} P&L result
 */
export function runPnl(modelDir, args) {
  const manifest = loadManifest(modelDir);
  const gt = loadGroundTruth(manifest, modelDir);

  // Detect date columns
  const dateResult = detectDateColumns(gt, {
    sheet: manifest.timeline?.dateSheet,
    row: manifest.timeline?.dateRow,
  });

  // Parse year range
  let startYear, endYear;
  if (args.years) {
    const [s, e] = args.years.split('-').map(Number);
    startYear = s;
    endYear = e;
  } else {
    startYear = manifest.timeline?.investmentYear;
    endYear = manifest.timeline?.exitYear;
  }

  // Filter to specific segment?
  if (args.segment) {
    return runSegmentDetail(manifest, gt, dateResult, args.segment, {
      detail: args.detail,
      growth: args.growth,
      quarterly: args.quarterly,
      startYear, endYear,
      format: args.format,
    });
  }

  // Full P&L across all segments
  return runFullPnl(manifest, gt, dateResult, {
    growth: args.growth,
    quarterly: args.quarterly,
    startYear, endYear,
    format: args.format,
  });
}

/**
 * Full P&L across all segments.
 */
function runFullPnl(manifest, gt, dateResult, options) {
  const { startYear, endYear, growth, quarterly } = options;
  const segments = manifest.segments || [];

  if (segments.length === 0) {
    return { error: 'No segments defined in manifest. Run: ete manifest generate' };
  }

  const pnl = aggregateSegmentPnL(gt, segments, dateResult, { startYear, endYear });
  const years = Object.keys(pnl.totals.ebitda).map(Number).sort();

  // Build output
  const result = {
    mode: 'full',
    years,
    segments: {},
    totals: pnl.totals,
  };

  for (const [segId, segData] of Object.entries(pnl.segments)) {
    result.segments[segId] = {
      label: segData.label,
      type: segData.type,
      annual: segData.annual,
    };
    if (growth) {
      result.segments[segId].growth = segData.growth;
      const vals = Object.values(segData.annual);
      if (vals.length >= 2) {
        result.segments[segId].cagr = computeCAGR(vals[0], vals[vals.length - 1], vals.length - 1);
      }
    }
  }

  if (growth) {
    result.totals.cagr = computeCAGR(
      pnl.totals.ebitda[years[0]],
      pnl.totals.ebitda[years[years.length - 1]],
      years.length - 1,
    );
  }

  result._formatted = formatPnlTable(result, options);
  return result;
}

/**
 * Detailed P&L for a specific segment / subsegment.
 */
function runSegmentDetail(manifest, gt, dateResult, segmentId, options) {
  const { startYear, endYear, detail, growth, quarterly } = options;

  // Find the segment
  const segment = manifest.segments?.find(s => s.id === segmentId);
  const subsegment = manifest.subsegments?.[segmentId];

  if (!segment && !subsegment) {
    const available = [
      ...(manifest.segments || []).map(s => s.id),
      ...Object.keys(manifest.subsegments || {}),
    ];
    return { error: `Segment "${segmentId}" not found. Available: ${available.join(', ')}` };
  }

  const result = { mode: 'segment', segmentId, years: [] };

  if (segment) {
    // Top-level segment
    const aggFn = quarterly ? aggregateQuarterly : aggregateAnnual;
    const mode = segment.aggregation === 'annual_last' ? 'last' : 'sum';

    const annual = aggFn(gt, segment.sheet, segment.row, dateResult, {
      mode, startYear, endYear,
    });

    result.label = segment.label;
    result.annual = annual;
  } else if (subsegment && subsegment.revenueRow) {
    // Subsegment with revenue/profit rows — aggregate them
    const annual = aggregateAnnual(gt, subsegment.sheet, subsegment.revenueRow, dateResult, {
      mode: 'sum', startYear, endYear,
    });

    result.label = segmentId.charAt(0).toUpperCase() + segmentId.slice(1) + ' (subsegment)';
    result.annual = annual;
    result.years = Object.keys(annual).sort();

    if (growth) {
      result.growth = computeGrowthRates(annual);
      const vals = Object.values(annual);
      if (vals.length >= 2) {
        result.cagr = computeCAGR(vals[0], vals[vals.length - 1], vals.length - 1);
      }
    }
  }

  // If detail requested (or subsegment targeted directly), show line items
  if ((detail || !segment) && subsegment) {
    result.detail = {};

    // Revenue types
    for (const rt of subsegment.revenueTypes || []) {
      const annual = aggregateAnnual(gt, subsegment.sheet, rt.row, dateResult, {
        mode: 'sum', startYear, endYear,
      });
      result.detail[rt.id] = { label: rt.label, type: 'revenue', annual };
      if (growth) result.detail[rt.id].growth = computeGrowthRates(annual);
    }

    // Expense types
    for (const et of subsegment.expenseTypes || []) {
      const annual = aggregateAnnual(gt, subsegment.sheet, et.row, dateResult, {
        mode: 'sum', startYear, endYear,
      });
      result.detail[et.id] = { label: et.label, type: 'expense', annual };
      if (growth) result.detail[et.id].growth = computeGrowthRates(annual);
    }

    // Profit row
    if (subsegment.profitRow) {
      const annual = aggregateAnnual(gt, subsegment.sheet, subsegment.profitRow, dateResult, {
        mode: 'sum', startYear, endYear,
      });
      result.detail._profit = { label: 'Profit', type: 'profit', annual };
    }
  }

  result._formatted = formatSegmentTable(result, options);
  return result;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatPnlTable(result, options) {
  const { years, segments, totals } = result;
  if (!years || years.length === 0) return 'No data available.';

  const lines = [];
  const colWidth = 12;

  // Header
  const header = padRight('', 28) + years.map(y => padLeft(String(y), colWidth)).join('');
  lines.push(header);
  lines.push('─'.repeat(header.length));

  // Segments
  for (const [id, seg] of Object.entries(segments)) {
    const label = truncate(seg.label, 26);
    const isExpense = seg.type === 'expense';

    const vals = years.map(y => {
      const v = seg.annual[y];
      return v !== undefined ? formatCurrency(v, isExpense) : '';
    });
    lines.push(padRight(label, 28) + vals.map(v => padLeft(v, colWidth)).join(''));

    if (options.growth && seg.growth) {
      const growths = years.map(y => {
        const g = seg.growth[y];
        return g !== undefined ? formatPercent(g) : '';
      });
      lines.push(padRight('  YoY', 28) + growths.map(g => padLeft(g, colWidth)).join(''));
    }
  }

  // EBITDA total
  lines.push('─'.repeat(header.length));
  const ebitdaVals = years.map(y => formatCurrency(totals.ebitda[y] || 0));
  lines.push(padRight('Platform EBITDA', 28) + ebitdaVals.map(v => padLeft(v, colWidth)).join(''));

  if (options.growth && totals.ebitdaGrowth) {
    const growths = years.map(y => {
      const g = totals.ebitdaGrowth[y];
      return g !== undefined ? formatPercent(g) : '';
    });
    lines.push(padRight('  YoY', 28) + growths.map(g => padLeft(g, colWidth)).join(''));
  }

  if (totals.cagr !== undefined && totals.cagr !== null) {
    lines.push(`\nEBITDA CAGR: ${formatPercent(totals.cagr)}`);
  }

  return lines.join('\n');
}

function formatSegmentTable(result, options) {
  const { years, label, annual, growth, detail } = result;
  if (!years || years.length === 0) return 'No data available.';

  const yearKeys = Array.isArray(years) ? years : Object.keys(annual || {}).sort();
  const lines = [];
  const colWidth = 12;

  const header = padRight('', 28) + yearKeys.map(y => padLeft(String(y), colWidth)).join('');
  lines.push(header);
  lines.push('─'.repeat(header.length));

  // Main segment row
  if (annual) {
    const vals = yearKeys.map(y => formatCurrency(annual[y] || 0));
    lines.push(padRight(truncate(label || result.segmentId, 26), 28) + vals.map(v => padLeft(v, colWidth)).join(''));

    if (options.growth && growth) {
      const growths = yearKeys.map(y => {
        const g = growth[y];
        return g !== undefined ? formatPercent(g) : '';
      });
      lines.push(padRight('  YoY', 28) + growths.map(g => padLeft(g, colWidth)).join(''));
    }
  }

  // Detail line items
  if (detail) {
    lines.push('');
    for (const [id, item] of Object.entries(detail)) {
      if (id === '_profit') continue;
      const isExp = item.type === 'expense';
      const vals = yearKeys.map(y => formatCurrency(item.annual[y] || 0, isExp));
      lines.push(padRight(`  ${truncate(item.label, 24)}`, 28) + vals.map(v => padLeft(v, colWidth)).join(''));

      if (options.growth && item.growth) {
        const growths = yearKeys.map(y => {
          const g = item.growth[y];
          return g !== undefined ? formatPercent(g) : '';
        });
        lines.push(padRight('    YoY', 28) + growths.map(g => padLeft(g, colWidth)).join(''));
      }
    }

    if (detail._profit) {
      lines.push('─'.repeat(header.length));
      const vals = yearKeys.map(y => formatCurrency(detail._profit.annual[y] || 0));
      lines.push(padRight('  Profit', 28) + vals.map(v => padLeft(v, colWidth)).join(''));
    }
  }

  if (result.cagr !== undefined && result.cagr !== null) {
    lines.push(`\nCAGR: ${formatPercent(result.cagr)}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCurrency(val, isExpense = false) {
  if (val === undefined || val === null) return '';
  const abs = Math.abs(val);
  let str;
  if (abs >= 1e9) str = `$${(val / 1e9).toFixed(1)}B`;
  else if (abs >= 1e6) str = `$${(val / 1e6).toFixed(1)}M`;
  else if (abs >= 1e3) str = `$${(val / 1e3).toFixed(0)}K`;
  else str = `$${val.toFixed(0)}`;

  if (val < 0 || isExpense) return `(${str.replace('-', '')})`;
  return str;
}

function formatPercent(val) {
  if (val === undefined || val === null) return '';
  const sign = val >= 0 ? '+' : '';
  return `${sign}${(val * 100).toFixed(1)}%`;
}

function padRight(str, width) {
  return str.length >= width ? str.substring(0, width) : str + ' '.repeat(width - str.length);
}

function padLeft(str, width) {
  return str.length >= width ? str : ' '.repeat(width - str.length) + str;
}

function truncate(str, maxLen) {
  return str.length <= maxLen ? str : str.substring(0, maxLen - 1) + '…';
}

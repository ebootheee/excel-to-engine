/**
 * ete extract — Pull time-series schedules out of a manifested model.
 *
 * Covers the breadth of extraction questions that analysts / VPs / LPs /
 * CFOs ask: capital calls, distributions, debt balances, fee streams,
 * interest expense, NOI, free cash flow, etc. Each schedule is a labeled
 * row keyed by the timeline columns from manifest.timeline.
 *
 * Usage:
 *   ete extract <modelDir> --list                      List all detected schedules
 *   ete extract <modelDir> --type <type>               All schedules of one type
 *   ete extract <modelDir> --id <id>                   One specific schedule
 *   ete extract <modelDir> --type debt_balance --sheet Cashflows
 *
 * Output:
 *   { id, label, type, sheet, row, series: { year: value } }
 *
 * @license MIT
 */

import { loadManifest, loadGroundTruth } from '../../lib/manifest.mjs';

export function runExtract(modelDir, args) {
  const manifest = loadManifest(modelDir);
  const gt = loadGroundTruth(manifest, modelDir);

  const all = manifest.schedules || [];

  // --list: show schedules without values
  if (args.list) {
    const lines = [];
    if (all.length === 0) {
      lines.push('No schedules detected. Run: ete manifest generate <modelDir>');
      return { schedules: [], _formatted: lines.join('\n') };
    }
    lines.push(`Detected schedules: ${all.length}`);
    lines.push('─'.repeat(60));
    const byType = {};
    for (const s of all) {
      if (!byType[s.type]) byType[s.type] = [];
      byType[s.type].push(s);
    }
    for (const [type, list] of Object.entries(byType)) {
      lines.push(`\n${type} (${list.length}):`);
      for (const s of list) {
        lines.push(`  ${s.id}  —  ${s.sheet}!row ${s.row}  —  "${s.label}"`);
      }
    }
    return { schedules: all, _formatted: lines.join('\n') };
  }

  // Filter by type and/or id and/or sheet
  let filtered = all;
  if (args.type) {
    filtered = filtered.filter(s => s.type === args.type);
  }
  if (args.id) {
    filtered = filtered.filter(s => s.id === args.id);
  }
  if (args.sheet) {
    filtered = filtered.filter(s => s.sheet === args.sheet);
  }

  if (filtered.length === 0) {
    const hint = args.type
      ? `No schedules of type "${args.type}". Try: ete extract ${modelDir} --list`
      : args.id
        ? `No schedule with id "${args.id}". Try: ete extract ${modelDir} --list`
        : `No schedules detected. Try: ete manifest generate ${modelDir}`;
    return { schedules: [], _formatted: hint };
  }

  // Resolve series for each matched schedule
  const columnMap = manifest.timeline?.columnMap || {};
  const resolved = filtered.map(s => {
    const series = {};
    for (const [col, period] of Object.entries(columnMap)) {
      const addr = `${s.sheet}!${col}${s.row}`;
      const v = gt[addr];
      if (typeof v === 'number') series[period] = v;
    }
    // The single-number summary depends on what the series MEANS. Summing a
    // balance double-counts a standing level; summing a ratio (DSCR/yield/LTV)
    // is meaningless. Honor the schedule's aggregation: 'annual_last' → the
    // exit/terminal value, 'annual_avg' → the mean, else the life-to-date sum.
    // Order periods chronologically before picking a terminal/aggregate. Use
    // numeric order when every key parses to a number (annual years 2025…2034),
    // else fall back to lexicographic — guards against ordinal labels like
    // "Year 1".."Year 10" (where localeCompare puts "Year 10" before "Year 2",
    // mis-picking the terminal value for an annual_last ratio/balance series).
    const periodKeys = Object.keys(series);
    const allNumeric = periodKeys.length > 0 && periodKeys.every(k => Number.isFinite(parseFloat(k)));
    const sortedKeys = allNumeric
      ? periodKeys.sort((a, b) => parseFloat(a) - parseFloat(b))
      : periodKeys.sort((a, b) => String(a).localeCompare(String(b)));
    const vals = sortedKeys.map(k => series[k]);
    const agg = s.aggregation || 'annual_sum';
    const aggregate = vals.length === 0 ? 0
      : agg === 'annual_last' ? vals[vals.length - 1]
      : agg === 'annual_avg' ? vals.reduce((a, b) => a + b, 0) / vals.length
      : vals.reduce((a, b) => a + b, 0);
    const aggLabel = agg === 'annual_last' ? 'Exit' : agg === 'annual_avg' ? 'Average' : 'Total';
    return {
      id: s.id,
      label: s.label,
      type: s.type,
      sheet: s.sheet,
      row: s.row,
      series,
      aggregation: agg,
      aggLabel,
      aggregate,
      // `total` retained for back-compat, but it now equals the meaningful
      // aggregate (not a blind sum) so existing consumers don't see "$1".
      total: aggregate,
    };
  });

  return {
    schedules: resolved,
    _formatted: formatSchedules(resolved),
  };
}

// A schedule's display unit, by detected type. Coverage ratios (DSCR/ICR) are
// "x" multiples; debt-yield and LTV are percentages; everything else is dollars.
// Without this a DSCR of 2.10 fell through to the currency branch and rendered
// as "$2" — the same ratio-as-fabricated-dollars trap the contract fix removed.
function unitForType(type) {
  if (type === 'coverage') return 'multiple';
  if (type === 'debt_yield' || type === 'ltv') return 'percent';
  return 'currency';
}

function formatSchedules(list) {
  const lines = [];
  for (const s of list) {
    const unit = unitForType(s.type);
    lines.push(`${s.id}  —  ${s.label}  [${s.type}]`);
    lines.push(`  ${s.sheet}!row ${s.row}`);
    const years = Object.keys(s.series).map(Number).sort();
    const rows = years.map(y => `    ${y}: ${fmt(s.series[y], unit)}`);
    lines.push(...rows);
    lines.push(`  ${s.aggLabel || 'Total'}: ${fmt(s.aggregate != null ? s.aggregate : s.total, unit)}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function fmt(v, unit = 'currency') {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  // A ratio/percentage series must NEVER render as dollars (a DSCR of 2.10 is
  // "2.10x", not "$2"; a debt yield of 0.13 is "13.25%", not "$0").
  if (unit === 'multiple') return `${v.toFixed(2)}x`;
  if (unit === 'percent') return `${(v * 100).toFixed(2)}%`;
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  // A sub-$1 value on a currency series is almost always a rate the detector
  // didn't type (preserve the legacy percent fallback); a real 0 stays "$0".
  if (abs < 1 && v !== 0) return `${(v * 100).toFixed(2)}%`;
  return `$${v.toFixed(0)}`;
}

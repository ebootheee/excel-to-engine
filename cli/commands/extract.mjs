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
    return {
      id: s.id,
      label: s.label,
      type: s.type,
      sheet: s.sheet,
      row: s.row,
      series,
      total: Object.values(series).reduce((a, b) => a + b, 0),
    };
  });

  return {
    schedules: resolved,
    _formatted: formatSchedules(resolved),
  };
}

function formatSchedules(list) {
  const lines = [];
  for (const s of list) {
    lines.push(`${s.id}  —  ${s.label}  [${s.type}]`);
    lines.push(`  ${s.sheet}!row ${s.row}`);
    const years = Object.keys(s.series).map(Number).sort();
    const rows = years.map(y => `    ${y}: ${fmt(s.series[y])}`);
    lines.push(...rows);
    lines.push(`  Total: ${fmt(s.total)}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function fmt(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  if (abs < 1 && v !== 0) return `${(v * 100).toFixed(2)}%`;
  return `$${v.toFixed(0)}`;
}

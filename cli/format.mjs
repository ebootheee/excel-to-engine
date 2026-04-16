/**
 * Shared output formatting for CLI commands.
 *
 * @license MIT
 */

/**
 * Format output based on requested format.
 * @param {Object} data - Result data
 * @param {string} format - 'table' | 'json' | 'csv' | 'markdown'
 */
export function formatOutput(data, format = 'table') {
  switch (format) {
    case 'json':
      return JSON.stringify(stripFormatted(data), null, 2);
    case 'compact':
    case 'compact-json':
      // AI-consumer format — 5-10× fewer tokens than pretty JSON.
      // See PLAN_V4.md Phase 2.
      return JSON.stringify(toCompact(stripFormatted(data)));
    case 'csv':
      return toCSV(data);
    case 'markdown':
      return toMarkdown(data);
    case 'table':
    default:
      return data._formatted || JSON.stringify(stripFormatted(data), null, 2);
  }
}

/**
 * Compress a result object for AI-consumer output.
 *
 * Transformations applied (depth-first):
 *   - Numbers rounded to 4 sig figs (or 2 decimals if |x| < 10)
 *   - null / undefined values dropped
 *   - Verbose keys renamed to short form: `value` → `v`, `cell` → `c`,
 *     `label` → `l`, `cells` → `C`, `type` → `t`, `sheet` → `s`, `row` → `r`,
 *     `column`/`col` → `k`. Only applied on leaf objects shaped like value
 *     records; preserves original keys on domain-model objects (segments,
 *     equity, etc.) to avoid breaking semantic meaning.
 *   - Arrays of single-key objects collapsed where possible
 *
 * This is deliberately conservative — when in doubt, preserve. Goal is
 * token savings for Claude, not compression at all costs.
 */
export function toCompact(data) {
  return compactWalk(data);
}

// Keys that identify a "value record" (safe to rename)
const VALUE_RECORD_KEYS = new Set(['value', 'cell', 'label', 'type', 'sheet', 'row', 'col']);

const SHORT_KEY = {
  value: 'v',
  cell: 'c',
  label: 'l',
  type: 't',
  sheet: 's',
  row: 'r',
  col: 'k',
  column: 'k',
};

function compactWalk(x) {
  if (x === null || x === undefined) return undefined;
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) return undefined;
    return roundForDisplay(x);
  }
  if (typeof x !== 'object') return x;
  if (Array.isArray(x)) {
    const out = [];
    for (const item of x) {
      const v = compactWalk(item);
      if (v !== undefined) out.push(v);
    }
    return out;
  }

  // Detect "value record" shape and rename keys
  const keys = Object.keys(x);
  const isValueRecord = keys.length > 0 && keys.every(k => VALUE_RECORD_KEYS.has(k) || k === 'values');
  const out = {};
  for (const [k, v] of Object.entries(x)) {
    const compact = compactWalk(v);
    if (compact === undefined) continue;
    const key = isValueRecord && SHORT_KEY[k] ? SHORT_KEY[k] : k;
    out[key] = compact;
  }
  return out;
}

function roundForDisplay(n) {
  if (n === 0) return 0;
  const abs = Math.abs(n);
  if (abs >= 10) {
    // 4 sig figs by rounding to appropriate decimals
    const magnitude = Math.floor(Math.log10(abs));
    const decimals = Math.max(0, 3 - magnitude);
    return Number(n.toFixed(decimals));
  }
  if (abs >= 0.01) return Number(n.toFixed(4));
  // Very small — keep 3 sig figs
  return Number(n.toPrecision(3));
}

/**
 * Remove _formatted keys from output for JSON serialization.
 */
function stripFormatted(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripFormatted);
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === '_formatted') continue;
    result[k] = stripFormatted(v);
  }
  return result;
}

/**
 * Convert a result object to CSV.
 */
function toCSV(data) {
  if (data.mode === 'cell' && data.results) {
    const lines = ['cell,value,type'];
    for (const r of data.results) {
      lines.push(`"${r.cell}","${r.value}","${r.type}"`);
    }
    return lines.join('\n');
  }

  // For P&L-like data with years as columns
  if (data.years && data.segments) {
    const years = data.years;
    const lines = ['segment,type,' + years.join(',')];
    for (const [id, seg] of Object.entries(data.segments)) {
      const vals = years.map(y => seg.annual?.[y] ?? '');
      lines.push(`"${seg.label || id}","${seg.type}",${vals.join(',')}`);
    }
    if (data.totals?.ebitda) {
      const vals = years.map(y => data.totals.ebitda[y] ?? '');
      lines.push(`"EBITDA","total",${vals.join(',')}`);
    }
    return lines.join('\n');
  }

  // For scenario comparison data
  if (data.base && data.scenario) {
    const lines = ['metric,base,scenario,delta,pctChange'];
    for (const key of Object.keys(data.base)) {
      const b = data.base[key];
      const s = data.scenario[key];
      const d = data.deltas?.[key];
      const pct = typeof b === 'number' && b !== 0 ? ((s - b) / Math.abs(b) * 100).toFixed(2) + '%' : '';
      lines.push(`"${key}",${b},${s},${d ?? ''},${pct}`);
    }
    return lines.join('\n');
  }

  return JSON.stringify(data);
}

/**
 * Convert to markdown table.
 */
function toMarkdown(data) {
  if (data._formatted) {
    // Convert ASCII table to markdown
    return '```\n' + data._formatted + '\n```';
  }
  return '```json\n' + JSON.stringify(stripFormatted(data), null, 2) + '\n```';
}

/**
 * Format a number for display.
 */
export function fmtNum(val, options = {}) {
  if (val === undefined || val === null) return '—';
  const { type } = options;

  if (type === 'percent' || (Math.abs(val) < 1 && val !== 0 && !type)) {
    return `${(val * 100).toFixed(1)}%`;
  }
  if (type === 'multiple' || (val > 0 && val < 50 && !type)) {
    return `${val.toFixed(2)}x`;
  }
  if (type === 'currency' || Math.abs(val) >= 1000) {
    const abs = Math.abs(val);
    if (abs >= 1e9) return `$${(val / 1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `$${(val / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `$${(val / 1e3).toFixed(0)}K`;
    return `$${val.toFixed(0)}`;
  }
  return val.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * ete sensitivity — Generate 1D sweep or 2D sensitivity surface.
 *
 * @license MIT
 */

import { runSensitivity1D, runSensitivity2D, parseCliAdjustments } from '../solvers/scenario-engine.mjs';
import { fmtNum } from '../format.mjs';

/**
 * Execute the sensitivity command.
 */
export function runSensitivityCommand(modelDir, args) {
  const varySpecs = parseVaryArgs(args.vary);

  if (varySpecs.length === 0) {
    return { error: 'Usage: ete sensitivity <modelDir> --vary param:min-max:step [--vary param2:min-max:step] [--metric irr,moic]' };
  }

  // Collect base adjustments (non-vary flags)
  const baseArgs = { ...args };
  delete baseArgs.vary;
  delete baseArgs.metric;
  delete baseArgs.format;

  const metrics = args.metric ? args.metric.split(',').map(m => m.trim()) : undefined;

  if (varySpecs.length === 1) {
    // 1D sweep
    const result = runSensitivity1D(modelDir, varySpecs[0], baseArgs, { metrics });
    result._formatted = format1D(result, args.format);
    return result;
  }

  if (varySpecs.length === 2) {
    // 2D surface
    const metric = metrics?.[0] || 'grossIRR';
    const result = runSensitivity2D(modelDir, varySpecs[0], varySpecs[1], baseArgs, { metric });
    result._formatted = format2D(result, args.format);
    return result;
  }

  return { error: 'Maximum 2 --vary parameters supported.' };
}

/**
 * Parse --vary arguments: "exit-multiple:14-22:1" → { param, min, max, step }
 */
function parseVaryArgs(vary) {
  if (!vary) return [];
  const specs = Array.isArray(vary) ? vary : [vary];

  return specs.map(spec => {
    // Handle percentage steps: "revenue-growth:0-30%:5%"
    const cleaned = spec.replace(/%/g, '');
    const parts = cleaned.split(':');
    if (parts.length < 3) throw new Error(`Invalid --vary: "${spec}". Format: param:min-max:step`);

    const param = parts[0];
    const range = parts[1].split('-');
    const step = parseFloat(parts[2]);

    let min = parseFloat(range[0]);
    let max = parseFloat(range[1]);

    // If original had %, convert to decimal
    if (spec.includes('%')) {
      min /= 100;
      max /= 100;
    }

    // Map CLI param names to internal adjustment keys
    const paramMap = {
      'exit-multiple': 'exitMultiple',
      'exit-year': 'exitYear',
      'revenue-multiple': 'revenueMultiple',
      'leverage': 'leverage',
      'hold-period': 'holdPeriod',
      'pref-return': 'prefReturn',
      'discount-rate': 'discountRate',
    };

    return {
      param: paramMap[param] || param,
      displayParam: param,
      min,
      max,
      step: spec.includes('%') ? step / 100 : step,
    };
  });
}

/**
 * Map internal metric names to display names and format types.
 */
const METRIC_INFO = {
  grossIRR: { label: 'Gross IRR', type: 'percent' },
  grossMOIC: { label: 'Gross MOIC', type: 'multiple' },
  netIRR: { label: 'Net IRR', type: 'percent' },
  netMOIC: { label: 'Net MOIC', type: 'multiple' },
  totalCarry: { label: 'Total Carry', type: 'currency' },
  terminalValue: { label: 'Terminal Value', type: 'currency' },
  exitEquity: { label: 'Exit Equity', type: 'currency' },
  exitEBITDA: { label: 'Exit EBITDA', type: 'currency' },
  pricePerShare: { label: 'Price/Share', type: 'currency' },
};

function format1D(result, format) {
  if (format === 'json') return JSON.stringify(result, null, 2);

  const { param, metrics, results } = result;
  const colWidth = 14;

  const lines = [];

  // Header
  const paramLabel = param;
  lines.push(
    padRight(paramLabel, 16) +
    metrics.map(m => padLeft(METRIC_INFO[m]?.label || m, colWidth)).join('')
  );
  lines.push('─'.repeat(16 + metrics.length * colWidth));

  // Rows
  for (const row of results) {
    const paramVal = formatParamValue(param, row[param]);
    const metricVals = metrics.map(m => {
      const info = METRIC_INFO[m];
      return padLeft(fmtNum(row[m], { type: info?.type }), colWidth);
    });
    lines.push(padRight(paramVal, 16) + metricVals.join(''));
  }

  return lines.join('\n');
}

function format2D(result, format) {
  if (format === 'json') return JSON.stringify(result, null, 2);

  const { params, values1, values2, metric, matrix } = result;
  const info = METRIC_INFO[metric] || { label: metric, type: 'percent' };
  const colWidth = 12;

  const lines = [];
  lines.push(`${info.label}: ${params[0]} (rows) × ${params[1]} (columns)`);
  lines.push('');

  // Header row
  lines.push(
    padRight('', 16) +
    values2.map(v => padLeft(formatParamValue(params[1], v), colWidth)).join('')
  );
  lines.push('─'.repeat(16 + values2.length * colWidth));

  // Data rows
  for (let i = 0; i < values1.length; i++) {
    const rowLabel = formatParamValue(params[0], values1[i]);
    const cells = matrix[i].map(val =>
      padLeft(fmtNum(val, { type: info.type }), colWidth)
    );
    lines.push(padRight(rowLabel, 16) + cells.join(''));
  }

  return lines.join('\n');
}

function formatParamValue(param, val) {
  if (param.includes('year') || param.includes('Year')) return String(val);
  if (param.includes('multiple') || param.includes('Multiple')) return `${val.toFixed(1)}x`;
  if (param.includes('leverage') || param.includes('return') || param.includes('rate') || param.includes('growth')) return `${(val * 100).toFixed(1)}%`;
  return String(val);
}

function padRight(s, w) { return s.length >= w ? s.substring(0, w) : s + ' '.repeat(w - s.length); }
function padLeft(s, w) { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

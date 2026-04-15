/**
 * Scenario Engine — Orchestrates the full scenario computation.
 *
 * Loads manifest + ground truth, parses adjustments from CLI flags
 * or scenario files, runs the delta cascade, and formats output.
 *
 * @license MIT
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { loadManifest, loadGroundTruth } from '../../lib/manifest.mjs';
import { computeScenario, computeAttribution } from './delta-cascade.mjs';
import { fmtNum } from '../format.mjs';

/**
 * Run a complete scenario analysis.
 *
 * @param {string} modelDir
 * @param {Object} rawArgs - CLI arguments (flags or file)
 * @returns {Object} Full scenario result
 */
export function runScenario(modelDir, rawArgs = {}) {
  const manifest = loadManifest(modelDir);
  const gt = loadGroundTruth(manifest, modelDir);

  // Load adjustments from file, saved scenario, or CLI args
  let adjustments;
  if (rawArgs.file) {
    adjustments = loadScenarioFile(rawArgs.file);
  } else if (rawArgs.load) {
    adjustments = loadSavedScenario(modelDir, rawArgs.load);
  } else {
    adjustments = parseCliAdjustments(rawArgs);
  }

  // Run delta cascade
  const result = computeScenario(manifest, gt, adjustments);

  // Attribution if requested
  if (rawArgs.attribution) {
    result.attribution = computeAttribution(manifest, gt, adjustments);
  }

  // Save if requested
  if (rawArgs.save) {
    saveScenario(modelDir, rawArgs.save, adjustments, result);
  }

  // Filter metrics if specified
  if (rawArgs.metric) {
    result._requestedMetrics = rawArgs.metric.split(',').map(m => m.trim());
  }

  // Format output
  result._formatted = formatScenarioResult(result, rawArgs);

  return result;
}

/**
 * Run a 1D sensitivity sweep.
 *
 * @param {string} modelDir
 * @param {Object} varyConfig - { param, min, max, step }
 * @param {Object} baseAdjustments - Additional fixed adjustments
 * @param {Object} options
 * @returns {Object} { param, values, results }
 */
export function runSensitivity1D(modelDir, varyConfig, baseAdjustments = {}, options = {}) {
  const manifest = loadManifest(modelDir);
  const gt = loadGroundTruth(manifest, modelDir);
  const metrics = options.metrics || ['grossIRR', 'grossMOIC', 'totalCarry'];

  const { param, min, max, step } = varyConfig;
  const values = [];
  for (let v = min; v <= max + step * 0.001; v += step) {
    values.push(Math.round(v * 1000) / 1000); // avoid floating point drift
  }

  const results = [];
  for (const val of values) {
    const adj = { ...baseAdjustments, [param]: val };
    const parsed = parseCliAdjustments(adj);
    const result = computeScenario(manifest, gt, parsed);

    const row = { [param]: val };
    for (const metric of metrics) {
      row[metric] = result.scenario[metric];
    }
    results.push(row);
  }

  return { param, values, metrics, results };
}

/**
 * Run a 2D sensitivity surface.
 *
 * @param {string} modelDir
 * @param {Object} vary1 - { param, min, max, step }
 * @param {Object} vary2 - { param, min, max, step }
 * @param {Object} baseAdjustments
 * @param {Object} options
 * @returns {Object} { params, values1, values2, metric, matrix }
 */
export function runSensitivity2D(modelDir, vary1, vary2, baseAdjustments = {}, options = {}) {
  const manifest = loadManifest(modelDir);
  const gt = loadGroundTruth(manifest, modelDir);
  const metric = options.metric || 'grossIRR';

  const values1 = [];
  for (let v = vary1.min; v <= vary1.max + vary1.step * 0.001; v += vary1.step) {
    values1.push(Math.round(v * 1000) / 1000);
  }

  const values2 = [];
  for (let v = vary2.min; v <= vary2.max + vary2.step * 0.001; v += vary2.step) {
    values2.push(Math.round(v * 1000) / 1000);
  }

  const matrix = [];
  for (const v1 of values1) {
    const row = [];
    for (const v2 of values2) {
      const adj = { ...baseAdjustments, [vary1.param]: v1, [vary2.param]: v2 };
      const parsed = parseCliAdjustments(adj);
      const result = computeScenario(manifest, gt, parsed);
      row.push(result.scenario[metric]);
    }
    matrix.push(row);
  }

  return {
    params: [vary1.param, vary2.param],
    values1,
    values2,
    metric,
    matrix,
  };
}

// ---------------------------------------------------------------------------
// Adjustment parsing
// ---------------------------------------------------------------------------

/**
 * Parse CLI arguments into the adjustments format expected by delta-cascade.
 */
export function parseCliAdjustments(args) {
  const adjustments = {
    revenueAdj: [],
    revenueGrowth: [],
    costAdj: [],
    removeSegments: [],
    lineItems: [],
    capitalize: [],
    distributions: [],
  };

  // Simple overrides
  if (args.exitYear || args['exit-year']) adjustments.exitYear = Number(args.exitYear || args['exit-year']);
  if (args.exitMultiple || args['exit-multiple']) adjustments.exitMultiple = Number(args.exitMultiple || args['exit-multiple']);
  if (args.revenueMultiple || args['revenue-multiple']) adjustments.revenueMultiple = Number(args.revenueMultiple || args['revenue-multiple']);
  if (args.leverage !== undefined) adjustments.leverage = Number(args.leverage);
  if (args.holdPeriod || args['hold-period']) adjustments.holdPeriod = Number(args.holdPeriod || args['hold-period']);
  if (args.prefReturn || args['pref-return']) adjustments.prefReturn = Number(args.prefReturn || args['pref-return']);
  if (args.discountRate || args['discount-rate']) adjustments.discountRate = Number(args.discountRate || args['discount-rate']);
  if (args.equityOverride || args['equity-override']) adjustments.equityOverride = Number(args.equityOverride || args['equity-override']);
  if (args.overrideArr || args['override-arr']) adjustments.overrideArr = Number(args.overrideArr || args['override-arr']);
  if (args.sotp) adjustments.sotp = true;

  // Revenue adjustments: --revenue-adj techGP:+50% or techGP:-500000
  for (const ra of asArray(args.revenueAdj || args['revenue-adj'])) {
    const parsed = parseSegmentAdj(ra);
    if (parsed) adjustments.revenueAdj.push(parsed);
  }

  // Revenue growth: --revenue-growth techGP:0.40
  for (const rg of asArray(args.revenueGrowth || args['revenue-growth'])) {
    const [seg, rate] = rg.split(':');
    adjustments.revenueGrowth.push({ segment: seg, rate: Number(rate) });
  }

  // Remove segments: --remove-segment techGP
  for (const rs of asArray(args.removeSegment || args['remove-segment'])) {
    adjustments.removeSegments.push(rs);
  }

  // Cost adjustments: --cost-adj technology:+10%
  for (const ca of asArray(args.costAdj || args['cost-adj'])) {
    const parsed = parseSegmentAdj(ca);
    if (parsed) adjustments.costAdj.push(parsed);
  }

  // Line items: --line-item tech_headcount:-2e6
  for (const li of asArray(args.lineItem || args['line-item'])) {
    const [id, adj] = li.split(':');
    adjustments.lineItems.push({ id, adj });
  }

  // Capitalize: --capitalize tech_headcount:5
  for (const cap of asArray(args.capitalize)) {
    const [id, years] = cap.split(':');
    adjustments.capitalize.push({ id, years: Number(years) });
  }

  // Distributions: --distribution 2027:20e6
  for (const dist of asArray(args.distribution)) {
    const [year, amount] = dist.split(':');
    adjustments.distributions.push({ year: Number(year), amount: Number(amount) });
  }

  // Cost ratio: --cost-ratio technology:1.0
  for (const cr of asArray(args.costRatio || args['cost-ratio'])) {
    const [seg, ratio] = cr.split(':');
    // Convert cost ratio to a cost adjustment
    // This would need segment revenue to compute, so pass through as-is
    adjustments.costAdj.push({ segment: seg, type: 'ratio', value: Number(ratio) });
  }

  // Segment multiples: --segment-multiple techGP:12
  if (args.segmentMultiple || args['segment-multiple']) {
    adjustments.segmentMultiples = {};
    for (const sm of asArray(args.segmentMultiple || args['segment-multiple'])) {
      const [seg, mult] = sm.split(':');
      adjustments.segmentMultiples[seg] = Number(mult);
    }
  }

  // Add revenue: --add-revenue 2030:5e6
  for (const ar of asArray(args.addRevenue || args['add-revenue'])) {
    const [year, amount] = ar.split(':');
    adjustments.revenueAdj.push({
      segment: '_added',
      type: 'absolute',
      value: Number(amount),
      year: Number(year),
    });
  }

  return adjustments;
}

function parseSegmentAdj(str) {
  if (!str) return null;
  const colonIdx = str.indexOf(':');
  if (colonIdx < 0) return null;

  const segment = str.substring(0, colonIdx);
  const adj = str.substring(colonIdx + 1);

  if (adj.endsWith('%')) {
    return { segment, type: 'percent', value: parseFloat(adj) / 100 };
  }
  return { segment, type: 'absolute', value: parseFloat(adj) };
}

function asArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

// ---------------------------------------------------------------------------
// Scenario file management
// ---------------------------------------------------------------------------

function loadScenarioFile(filePath) {
  const content = JSON.parse(readFileSync(filePath, 'utf-8'));
  return parseScenarioFileAdjustments(content);
}

function loadSavedScenario(modelDir, name) {
  const scenarioDir = join(modelDir, 'scenarios');
  const filePath = join(scenarioDir, `${name}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`Saved scenario "${name}" not found. Run: ete scenario ${modelDir} --list`);
  }
  return loadScenarioFile(filePath);
}

export function saveScenario(modelDir, name, adjustments, result) {
  const scenarioDir = join(modelDir, 'scenarios');
  if (!existsSync(scenarioDir)) mkdirSync(scenarioDir, { recursive: true });

  const filePath = join(scenarioDir, `${name}.json`);
  const content = {
    name,
    savedAt: new Date().toISOString(),
    adjustments,
    summary: {
      grossIRR: result.scenario.grossIRR,
      grossMOIC: result.scenario.grossMOIC,
      totalCarry: result.scenario.totalCarry,
      terminalValue: result.scenario.terminalValue,
    },
  };
  writeFileSync(filePath, JSON.stringify(content, null, 2));
  return filePath;
}

export function listSavedScenarios(modelDir) {
  const scenarioDir = join(modelDir, 'scenarios');
  if (!existsSync(scenarioDir)) return [];
  return readdirSync(scenarioDir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const content = JSON.parse(readFileSync(join(scenarioDir, f), 'utf-8'));
      return { name: content.name || f.replace('.json', ''), file: f, summary: content.summary };
    });
}

function parseScenarioFileAdjustments(content) {
  const adj = {
    revenueAdj: [],
    revenueGrowth: [],
    costAdj: [],
    removeSegments: [],
    lineItems: [],
    capitalize: [],
    distributions: [],
  };

  const a = content.adjustments || content;

  if (a.exit?.year) adj.exitYear = a.exit.year;
  if (a.exit?.multiple) adj.exitMultiple = a.exit.multiple;

  for (const r of a.revenue || []) {
    if (r.growth) {
      adj.revenueGrowth.push({ segment: r.segment, rate: r.growth });
    } else {
      const parsed = parseSegmentAdj(`${r.segment}:${r.adj}`);
      if (parsed) adj.revenueAdj.push(parsed);
    }
  }

  for (const c of a.cost || []) {
    const parsed = parseSegmentAdj(`${c.segment}:${c.adj}`);
    if (parsed) adj.costAdj.push(parsed);
  }

  for (const li of a.lineItems || []) {
    adj.lineItems.push({ id: li.id, adj: li.adj });
  }

  if (a.capital?.leverage !== undefined) adj.leverage = a.capital.leverage;
  if (a.capital?.equityOverride) adj.equityOverride = a.capital.equityOverride;
  if (a.capital?.distributions) {
    for (const d of a.capital.distributions) {
      adj.distributions.push(d);
    }
  }

  return adj;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatScenarioResult(result, args) {
  const { base, scenario, deltas } = result;
  const metrics = result._requestedMetrics || [
    'exitEBITDA', 'terminalValue', 'exitEquity',
    'grossMOIC', 'grossIRR', 'netMOIC', 'netIRR',
    'totalCarry', 'pricePerShare',
  ];

  const lines = [];

  // Scenario description
  const desc = describeAdjustments(args);
  if (desc) lines.push(`Scenario: ${desc}\n`);

  // Results table
  const labelWidth = 24;
  const colWidth = 14;
  lines.push(
    padRight('', labelWidth) +
    padLeft('Base', colWidth) +
    padLeft('Scenario', colWidth) +
    padLeft('Delta', colWidth)
  );
  lines.push('─'.repeat(labelWidth + colWidth * 3));

  const metricLabels = {
    exitEBITDA: 'Exit EBITDA',
    terminalValue: 'Terminal Value',
    exitEquity: 'Exit Equity',
    grossMOIC: 'Gross MOIC',
    grossIRR: 'Gross IRR',
    netMOIC: 'Net MOIC',
    netIRR: 'Net IRR',
    totalCarry: 'Total Carry',
    pricePerShare: 'Price/Share',
    exitYear: 'Exit Year',
    holdPeriod: 'Hold Period',
  };

  const metricTypes = {
    grossMOIC: 'multiple', netMOIC: 'multiple',
    grossIRR: 'percent', netIRR: 'percent',
    exitEBITDA: 'currency', terminalValue: 'currency',
    exitEquity: 'currency', totalCarry: 'currency',
    pricePerShare: 'currency',
  };

  for (const metric of metrics) {
    const b = base[metric];
    const s = scenario[metric];
    const d = deltas[metric];
    if (b === null && s === null) continue;

    const label = metricLabels[metric] || metric;
    const type = metricTypes[metric];

    let deltaStr = '';
    if (d) {
      if (type === 'percent') {
        deltaStr = `${d.absolute >= 0 ? '+' : ''}${(d.absolute * 100).toFixed(1)}pp`;
      } else if (type === 'multiple') {
        deltaStr = `${d.absolute >= 0 ? '+' : ''}${d.absolute.toFixed(2)}x`;
      } else if (d.percent !== null) {
        deltaStr = `${fmtNum(d.absolute, { type })} (${d.percent >= 0 ? '+' : ''}${(d.percent * 100).toFixed(1)}%)`;
      }
    }

    lines.push(
      padRight(label, labelWidth) +
      padLeft(fmtNum(b, { type }), colWidth) +
      padLeft(fmtNum(s, { type }), colWidth) +
      padLeft(deltaStr, colWidth)
    );
  }

  // Attribution section
  if (result.attribution) {
    lines.push('');
    lines.push(formatAttribution(result.attribution));
  }

  return lines.join('\n');
}

function formatAttribution(attr) {
  const lines = [];
  lines.push('IRR Impact Attribution');
  lines.push(`  Base case IRR:        ${fmtNum(attr.base.grossIRR, { type: 'percent' })}`);
  lines.push(`  Scenario IRR:         ${fmtNum(attr.scenario.grossIRR, { type: 'percent' })}`);
  lines.push(`  Total delta:          ${attr.totalDelta.irr >= 0 ? '+' : ''}${(attr.totalDelta.irr * 100).toFixed(1)}pp`);
  lines.push('');

  for (const [key, c] of Object.entries(attr.contributions)) {
    if (key === '_interaction' && Math.abs(c.irrDelta) < 0.001) continue;
    const pct = attr.totalDelta.irr !== 0
      ? Math.abs(c.irrDelta / attr.totalDelta.irr * 100).toFixed(1) + '%'
      : '';
    lines.push(`  ${padRight(c.label || key, 28)} ${c.irrDelta >= 0 ? '+' : ''}${(c.irrDelta * 100).toFixed(1)}pp   (${pct})`);
  }

  return lines.join('\n');
}

function describeAdjustments(args) {
  const parts = [];
  if (args.exitYear || args['exit-year']) parts.push(`exit-year=${args.exitYear || args['exit-year']}`);
  if (args.exitMultiple || args['exit-multiple']) parts.push(`exit-multiple=${args.exitMultiple || args['exit-multiple']}`);
  if (args.revenueAdj || args['revenue-adj']) {
    for (const ra of asArray(args.revenueAdj || args['revenue-adj'])) parts.push(`revenue-adj=${ra}`);
  }
  if (args.costAdj || args['cost-adj']) {
    for (const ca of asArray(args.costAdj || args['cost-adj'])) parts.push(`cost-adj=${ca}`);
  }
  if (args.file) parts.push(`file=${args.file}`);
  if (args.load) parts.push(`scenario=${args.load}`);
  return parts.join(', ');
}

function padRight(str, w) { return str.length >= w ? str.substring(0, w) : str + ' '.repeat(w - str.length); }
function padLeft(str, w) { return str.length >= w ? str : ' '.repeat(w - str.length) + str; }

/**
 * ete compare — Compare scenarios, saved results, or models.
 *
 * Modes:
 * 1. Base vs alt:   ete compare ./model/ --base "" --alt "exit-multiple=16"
 * 2. Named:         ete compare ./model/ --scenarios "bear,base,bull"
 * 3. Cross-model:   ete compare --models ./a/ ./b/ --metric irr,moic
 * 4. Attribution:    ete compare ./model/ --base "" --alt "..." --attribution
 *
 * @license MIT
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { loadManifest, loadGroundTruth } from '../../lib/manifest.mjs';
import { computeScenario, computeAttribution } from '../solvers/delta-cascade.mjs';
import { parseCliAdjustments, listSavedScenarios } from '../solvers/scenario-engine.mjs';
import { fmtNum } from '../format.mjs';

/**
 * Execute the compare command.
 */
export function runCompareCommand(modelDir, args) {
  // Mode 3: Cross-model comparison
  if (args.models) {
    return crossModelCompare(args.models, args);
  }

  // Mode 2: Named scenarios
  if (args.scenarios) {
    return namedScenariosCompare(modelDir, args.scenarios, args);
  }

  // Mode 1/4: Base vs alt
  if (args.alt !== undefined) {
    return baseVsAltCompare(modelDir, args);
  }

  return { error: 'Usage: ete compare <modelDir> --base "" --alt "params" [--attribution]' };
}

/**
 * Compare base case vs an alternative scenario.
 */
function baseVsAltCompare(modelDir, args) {
  const manifest = loadManifest(modelDir);
  const gt = loadGroundTruth(manifest, modelDir);

  // Parse alt adjustments from "key=value,key=value" format
  const altAdj = parseInlineAdjustments(args.alt);

  // Attribution mode
  if (args.attribution) {
    const attr = computeAttribution(manifest, gt, altAdj);
    attr._formatted = formatAttribution(attr);
    return attr;
  }

  // Simple comparison
  const baseResult = computeScenario(manifest, gt, {});
  const altResult = computeScenario(manifest, gt, altAdj);

  const metrics = args.metric ? args.metric.split(',').map(m => m.trim()) : DEFAULT_METRICS;

  const result = {
    mode: 'base_vs_alt',
    base: baseResult.base,
    alt: altResult.scenario,
    deltas: {},
    metrics,
  };

  for (const m of metrics) {
    const b = baseResult.base[m];
    const a = altResult.scenario[m];
    if (typeof b === 'number' && typeof a === 'number') {
      result.deltas[m] = { absolute: a - b, percent: b !== 0 ? (a - b) / Math.abs(b) : null };
    }
  }

  result._formatted = formatComparison(result, args);
  return result;
}

/**
 * Compare multiple named/saved scenarios.
 */
function namedScenariosCompare(modelDir, scenarioNames, args) {
  const names = scenarioNames.split(',').map(s => s.trim());
  const manifest = loadManifest(modelDir);
  const gt = loadGroundTruth(manifest, modelDir);

  const savedList = listSavedScenarios(modelDir);
  const metrics = args.metric ? args.metric.split(',').map(m => m.trim()) : DEFAULT_METRICS;

  const scenarios = {};
  for (const name of names) {
    if (name === 'base' || name === '') {
      scenarios[name || 'base'] = computeScenario(manifest, gt, {}).base;
    } else {
      const saved = savedList.find(s => s.name === name);
      if (!saved) {
        scenarios[name] = { error: `Scenario "${name}" not found` };
        continue;
      }
      const content = JSON.parse(readFileSync(join(modelDir, 'scenarios', saved.file), 'utf-8'));
      const adj = content.adjustments || {};
      scenarios[name] = computeScenario(manifest, gt, adj).scenario;
    }
  }

  const result = { mode: 'named', scenarios, metrics };
  result._formatted = formatMultiScenario(result, args);
  return result;
}

/**
 * Compare base case returns across different models.
 */
function crossModelCompare(modelDirs, args) {
  const dirs = Array.isArray(modelDirs) ? modelDirs : modelDirs.split(',').map(s => s.trim());
  const metrics = args.metric ? args.metric.split(',').map(m => m.trim()) : DEFAULT_METRICS;

  const models = {};
  for (const dir of dirs) {
    try {
      const manifest = loadManifest(dir);
      const gt = loadGroundTruth(manifest, dir);
      const result = computeScenario(manifest, gt, {});
      models[manifest.model.name || dir] = result.base;
    } catch (e) {
      models[dir] = { error: e.message };
    }
  }

  const result = { mode: 'cross_model', models, metrics };
  result._formatted = formatCrossModel(result, args);
  return result;
}

// ---------------------------------------------------------------------------
// Parse inline adjustments from "key=value,key=value" string
// ---------------------------------------------------------------------------

function parseInlineAdjustments(str) {
  if (!str) return {};
  const parts = str.split(',');
  const args = {};

  for (const part of parts) {
    const [key, value] = part.split('=');
    const cliKey = key.trim();
    const cliVal = value?.trim();

    // Convert to CLI-style args
    if (['exit-year', 'exit-multiple', 'revenue-multiple', 'leverage',
         'hold-period', 'pref-return', 'discount-rate', 'equity-override'].includes(cliKey)) {
      args[cliKey] = cliVal;
    } else if (cliKey === 'revenue-adj' || cliKey === 'cost-adj' || cliKey === 'line-item' ||
               cliKey === 'revenue-growth' || cliKey === 'remove-segment' ||
               cliKey === 'segment-multiple' || cliKey === 'capitalize') {
      if (!args[cliKey]) args[cliKey] = [];
      args[cliKey].push(cliVal);
    }
  }

  return parseCliAdjustments(args);
}

// ---------------------------------------------------------------------------
// Default metrics
// ---------------------------------------------------------------------------

const DEFAULT_METRICS = [
  'grossIRR', 'grossMOIC', 'netIRR', 'netMOIC',
  'totalCarry', 'terminalValue', 'exitEquity', 'pricePerShare',
];

const METRIC_LABELS = {
  grossIRR: 'Gross IRR', grossMOIC: 'Gross MOIC',
  netIRR: 'Net IRR', netMOIC: 'Net MOIC',
  totalCarry: 'Total Carry', terminalValue: 'Terminal Value',
  exitEquity: 'Exit Equity', exitEBITDA: 'Exit EBITDA',
  pricePerShare: 'Price/Share',
};

const METRIC_TYPES = {
  grossIRR: 'percent', grossMOIC: 'multiple',
  netIRR: 'percent', netMOIC: 'multiple',
  totalCarry: 'currency', terminalValue: 'currency',
  exitEquity: 'currency', exitEBITDA: 'currency',
  pricePerShare: 'currency',
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatComparison(result, args) {
  const { base, alt, deltas, metrics } = result;
  const colWidth = 14;
  const lines = [];

  lines.push(padRight('', 20) + padLeft('Base', colWidth) + padLeft('Scenario', colWidth) + padLeft('Delta', colWidth));
  lines.push('─'.repeat(20 + colWidth * 3));

  for (const m of metrics) {
    const b = base[m];
    const a = alt[m];
    const d = deltas[m];
    if (b === null && a === null) continue;

    const type = METRIC_TYPES[m];
    let deltaStr = '—';
    if (d) {
      if (type === 'percent') deltaStr = `${d.absolute >= 0 ? '+' : ''}${(d.absolute * 100).toFixed(1)}pp`;
      else if (type === 'multiple') deltaStr = `${d.absolute >= 0 ? '+' : ''}${d.absolute.toFixed(2)}x`;
      else if (d.percent !== null) deltaStr = `${fmtNum(d.absolute, { type })} (${d.percent >= 0 ? '+' : ''}${(d.percent * 100).toFixed(1)}%)`;
    }

    lines.push(
      padRight(METRIC_LABELS[m] || m, 20) +
      padLeft(fmtNum(b, { type }), colWidth) +
      padLeft(fmtNum(a, { type }), colWidth) +
      padLeft(deltaStr, colWidth)
    );
  }

  return lines.join('\n');
}

function formatMultiScenario(result, args) {
  const { scenarios, metrics } = result;
  const names = Object.keys(scenarios);
  const colWidth = 14;
  const lines = [];

  lines.push(padRight('', 20) + names.map(n => padLeft(n, colWidth)).join(''));
  lines.push('─'.repeat(20 + names.length * colWidth));

  for (const m of metrics) {
    const type = METRIC_TYPES[m];
    const vals = names.map(n => {
      const s = scenarios[n];
      return padLeft(s.error ? 'ERR' : fmtNum(s[m], { type }), colWidth);
    });
    lines.push(padRight(METRIC_LABELS[m] || m, 20) + vals.join(''));
  }

  return lines.join('\n');
}

function formatCrossModel(result, args) {
  const { models, metrics } = result;
  const names = Object.keys(models);
  const colWidth = 16;
  const lines = [];

  lines.push(padRight('', 20) + names.map(n => padLeft(n.substring(0, 14), colWidth)).join(''));
  lines.push('─'.repeat(20 + names.length * colWidth));

  for (const m of metrics) {
    const type = METRIC_TYPES[m];
    const vals = names.map(n => {
      const s = models[n];
      return padLeft(s.error ? 'ERR' : fmtNum(s[m], { type }), colWidth);
    });
    lines.push(padRight(METRIC_LABELS[m] || m, 20) + vals.join(''));
  }

  return lines.join('\n');
}

function formatAttribution(attr) {
  const lines = [];
  lines.push('IRR Impact Attribution (base → scenario)');
  lines.push(`  Base case IRR:        ${fmtNum(attr.base.grossIRR, { type: 'percent' })}`);
  lines.push(`  Scenario IRR:         ${fmtNum(attr.scenario.grossIRR, { type: 'percent' })}`);
  lines.push(`  Total delta:          ${attr.totalDelta.irr >= 0 ? '+' : ''}${(attr.totalDelta.irr * 100).toFixed(1)}pp`);
  lines.push('');

  for (const [key, c] of Object.entries(attr.contributions)) {
    if (key === '_interaction' && Math.abs(c.irrDelta) < 0.001) continue;
    const pctOfTotal = attr.totalDelta.irr !== 0
      ? `(${Math.abs(c.irrDelta / attr.totalDelta.irr * 100).toFixed(1)}%)`
      : '';
    lines.push(
      `  ${padRight(c.label || key, 30)} ${c.irrDelta >= 0 ? '+' : ''}${(c.irrDelta * 100).toFixed(1)}pp  ${pctOfTotal}`
    );
  }

  return lines.join('\n');
}

function padRight(s, w) { return s.length >= w ? s.substring(0, w) : s + ' '.repeat(w - s.length); }
function padLeft(s, w) { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

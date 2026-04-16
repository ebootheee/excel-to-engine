/**
 * ete eval — Invoke the chunked engine to compute a cell using the actual
 * transpiled formulas. Escape hatch from the delta-cascade linear
 * approximation for non-linear scenarios (covenants, MIP, pref compounding
 * with irregular calls, FX hedges).
 *
 * Usage:
 *   ete eval <modelDir> <cell>                      Compute one cell
 *   ete eval <modelDir> <cell> --inputs '{"Sheet!A1": 100}'
 *   ete eval <modelDir> <cell1> <cell2> ...         Compute multiple
 *
 * Falls back to the ground-truth value when the engine isn't available
 * or the cell can't be evaluated; prints which path was taken.
 *
 * @license MIT
 */

import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { loadManifest, loadGroundTruth, resolveCell } from '../../lib/manifest.mjs';

export async function runEval(modelDir, args) {
  if (!modelDir) {
    return { error: 'Usage: ete eval <modelDir> <cell> [<cell2> ...] [--inputs \'{"Sheet!A1": value}\']' };
  }
  const cells = (args.cells || []).filter(c => c && typeof c === 'string');
  if (cells.length === 0) {
    return { error: 'No cells specified. Example: ete eval ./model/ "Equity!AN125"' };
  }

  let inputs = {};
  if (args.inputs) {
    try {
      inputs = typeof args.inputs === 'string' ? JSON.parse(args.inputs) : args.inputs;
    } catch (e) {
      return { error: `--inputs must be valid JSON. (${e.message})` };
    }
  }

  const manifest = loadManifest(modelDir);
  const gt = loadGroundTruth(manifest, modelDir);

  // Locate the engine.js orchestrator (chunked mode)
  const enginePaths = [
    join(modelDir, 'engine.js'),
    join(modelDir, 'chunked', 'engine.js'),
  ];
  const enginePath = enginePaths.find(p => existsSync(p));

  if (!enginePath && Object.keys(inputs).length === 0) {
    // No engine + no overrides → just serve from ground truth
    const results = cells.map(c => ({
      cell: c,
      value: resolveCell(gt, c),
      source: 'ground-truth (engine not present)',
    }));
    return { results, _formatted: formatResults(results, { fallback: true }) };
  }

  if (!enginePath) {
    return {
      error: `No chunked engine.js found in ${modelDir} or ${modelDir}/chunked/. Run: node pipelines/rust/target/release/rust-parser <xlsx> <dir> --chunked`,
    };
  }

  // Load the engine. The chunked orchestrator defaults to base-case inputs
  // when no overrides are passed, but we want to ensure ground-truth values
  // seed non-formula cells too (chunked engines only compute formula cells).
  const engineUrl = pathToFileURL(resolve(enginePath)).href;
  let engine;
  try {
    engine = await import(engineUrl);
  } catch (e) {
    return { error: `Failed to load engine ${enginePath}: ${e.message}` };
  }

  // Pre-populate inputs with ground truth base values for the non-formula
  // inputs that the sheets reference. The engine's run() applies overrides
  // on top of its internal constants — to correctly get the base case with
  // no overrides, just call run({}) and rely on the engine's built-in defaults.
  let runResult;
  try {
    runResult = engine.run(inputs);
  } catch (e) {
    return { error: `Engine execution failed: ${e.message}` };
  }

  const computed = runResult?.values || {};
  const results = cells.map(c => {
    const fromEngine = computed[c];
    const fromGT = resolveCell(gt, c);
    if (fromEngine !== undefined) {
      return { cell: c, value: fromEngine, source: 'engine', groundTruth: fromGT };
    }
    // Engine didn't produce this cell (non-formula or outside graph).
    // Falls back to ground truth.
    return { cell: c, value: fromGT, source: 'ground-truth (not in engine output)' };
  });

  return {
    results,
    inputs,
    enginePath,
    _formatted: formatResults(results, { inputs }),
  };
}

function formatResults(results, opts = {}) {
  const lines = [];
  if (opts.fallback) {
    lines.push('No chunked engine found — serving from ground truth only.');
  }
  if (opts.inputs && Object.keys(opts.inputs).length > 0) {
    lines.push(`Inputs applied: ${JSON.stringify(opts.inputs)}`);
    lines.push('');
  }
  for (const r of results) {
    const v = fmt(r.value);
    const diff = r.groundTruth !== undefined && typeof r.groundTruth === 'number' && typeof r.value === 'number'
      ? ` (gt: ${fmt(r.groundTruth)}, Δ ${fmt(r.value - r.groundTruth)})`
      : '';
    lines.push(`${r.cell}  →  ${v}  [${r.source}]${diff}`);
  }
  return lines.join('\n');
}

function fmt(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
    if (abs < 1 && v !== 0) return `${(v * 100).toFixed(2)}%`;
    return String(v.toFixed(2));
  }
  return String(v);
}

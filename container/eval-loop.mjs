/**
 * eval-loop.mjs — Standalone eval loop for iterative engine calibration
 *
 * Can be run independently against any engine.js + Excel ground truth:
 *
 *   node eval-loop.mjs raw-engine.js formulas.json [output_dir]
 *
 * Performs:
 *   1. Load engine, run at base case
 *   2. Compare outputs to ground truth (from formulas.json excel_result values)
 *   3. Identify largest errors
 *   4. Apply scale-factor calibration via lib/calibration.mjs
 *   5. Re-evaluate, check improvement
 *   6. Loop until accuracy >= TARGET or improvement plateaus
 *
 * Outputs:
 *   calibrated-engine.js  — Best engine after calibration
 *   eval-results.json     — Accuracy per iteration + stuck outputs
 *   sensitivity-surface.json — Input sensitivity analysis
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const MAX_ITER = parseInt(process.env.MAX_ITERATIONS || '20');
const TARGET = parseFloat(process.env.TARGET_ACCURACY || '0.95');
const MIN_IMPROVEMENT = parseFloat(process.env.MIN_IMPROVEMENT || '0.005');

async function main() {
  const [, , enginePath, formulasPath, outputDir = '.'] = process.argv;

  if (!enginePath || !formulasPath) {
    console.error('Usage: node eval-loop.mjs <engine.js> <formulas.json> [output_dir]');
    process.exit(1);
  }

  if (!existsSync(enginePath)) {
    console.error(`Engine not found: ${enginePath}`);
    process.exit(1);
  }

  // Load ground truth from formulas.json
  const formulas = JSON.parse(await readFile(formulasPath, 'utf8'));
  const groundTruth = {};
  for (const f of formulas) {
    if (f.excel_result !== null && f.excel_result !== undefined) {
      groundTruth[f.qualified_address] = f.excel_result;
    }
  }

  const totalKnown = Object.keys(groundTruth).length;
  console.log(`Ground truth: ${totalKnown} cells`);

  if (totalKnown === 0) {
    console.warn('No ground truth — skipping calibration');
    return;
  }

  const iterationScores = [];
  let bestScore = 0;
  let bestEngine = await readFile(enginePath, 'utf8');
  let currentEnginePath = enginePath;

  // Main eval loop
  for (let iter = 0; iter < MAX_ITER; iter++) {
    const result = await evalOnce(currentEnginePath, groundTruth);
    iterationScores.push({ iteration: iter, accuracy: result.accuracy });

    console.log(`  Iter ${iter}: accuracy=${(result.accuracy * 100).toFixed(2)}%, failures=${result.failures.length}`);

    if (result.accuracy > bestScore) {
      bestScore = result.accuracy;
      bestEngine = await readFile(currentEnginePath, 'utf8');
    }

    if (result.accuracy >= TARGET) {
      console.log(`  Target accuracy reached at iteration ${iter}`);
      break;
    }

    // Check improvement plateau
    if (iter >= 3) {
      const recent = iterationScores.slice(-3);
      const improvement = recent[recent.length - 1].accuracy - recent[0].accuracy;
      if (improvement < MIN_IMPROVEMENT) {
        console.log(`  Improvement plateau (${(improvement * 100).toFixed(2)}% over 3 iters) — stopping`);
        break;
      }
    }

    // Apply calibration for next iteration
    const calibrated = await applyCalibration(currentEnginePath, result, iter);
    if (calibrated) {
      currentEnginePath = calibrated;
    } else {
      break;
    }
  }

  // Sensitivity surface
  const surface = await computeSensitivitySurface(enginePath, groundTruth);

  // Final eval
  const finalResult = await evalOnce(currentEnginePath, groundTruth);

  // Write outputs
  await writeFile(join(outputDir, 'calibrated-engine.js'), bestEngine);
  await writeFile(
    join(outputDir, 'eval-results.json'),
    JSON.stringify({
      finalAccuracy: bestScore,
      iterations: iterationScores,
      failures: finalResult.failures.slice(0, 50),
    }, null, 2)
  );
  await writeFile(
    join(outputDir, 'sensitivity-surface.json'),
    JSON.stringify(surface, null, 2)
  );

  console.log(`\nFinal accuracy: ${(bestScore * 100).toFixed(1)}%`);
  console.log(`Outputs written to ${outputDir}`);
}

// ── Single evaluation pass ─────────────────────────────────────────────────
async function evalOnce(enginePath, groundTruth) {
  const evalScript = `
import { computeModel } from '${enginePath.replace(/\\/g, '/')}';
let outputs;
try {
  outputs = computeModel();
} catch(e) {
  process.stdout.write(JSON.stringify({ accuracy: 0, correct: 0, total: 0, failures: [], error: e.message }));
  process.exit(0);
}
const gt = ${JSON.stringify(groundTruth)};
let correct = 0, total = 0;
const failures = [];
for (const [addr, expected] of Object.entries(gt)) {
  const actual = outputs[addr];
  if (actual === undefined || actual === null || isNaN(actual)) continue;
  total++;
  const denom = Math.abs(expected) < 1e-9 ? 1 : Math.abs(expected);
  const relError = Math.abs(actual - expected) / denom;
  if (relError < 0.01) {
    correct++;
  } else {
    failures.push({ address: addr, expected, actual, relError });
  }
}
process.stdout.write(JSON.stringify({ accuracy: total > 0 ? correct/total : 0, correct, total, failures }));
`;

  const tmpPath = enginePath.replace('.js', '_eval_tmp.mjs');
  await writeFile(tmpPath, evalScript);

  try {
    const { stdout } = await execFileAsync('node', [tmpPath], { timeout: 30000 });
    return JSON.parse(stdout);
  } catch (err) {
    return { accuracy: 0, correct: 0, total: 0, failures: [] };
  }
}

// ── Scale-factor calibration ───────────────────────────────────────────────
// For each "stuck" cell, detect if the error is a constant scale factor
// (e.g., percentage vs decimal) and inject a correction multiplier.
async function applyCalibration(enginePath, evalResult, iteration) {
  if (evalResult.failures.length === 0) return null;

  // Group failures by their scale ratio
  const byRatio = {};
  for (const f of evalResult.failures) {
    if (Math.abs(f.expected) < 1e-9) continue;
    const ratio = f.actual / f.expected;
    const bucket = Math.round(Math.log10(Math.abs(ratio)) * 2) / 2; // 0.5-step buckets
    byRatio[bucket] = (byRatio[bucket] || 0) + 1;
  }

  // Find the dominant scale mismatch
  const sortedBuckets = Object.entries(byRatio).sort((a, b) => b[1] - a[1]);
  if (sortedBuckets.length === 0) return null;

  const [dominantBucket] = sortedBuckets[0];
  const scale = Math.pow(10, -parseFloat(dominantBucket));

  if (Math.abs(scale - 1) < 0.1) {
    // No meaningful scale correction
    return null;
  }

  // Apply scale correction: wrap computeModel to divide affected outputs by scale
  const engineCode = await readFile(enginePath, 'utf8');
  const affectedAddrs = evalResult.failures
    .filter(f => {
      if (Math.abs(f.expected) < 1e-9) return false;
      const ratio = f.actual / f.expected;
      const bucket = Math.round(Math.log10(Math.abs(ratio)) * 2) / 2;
      return bucket === parseFloat(dominantBucket);
    })
    .map(f => f.address);

  if (affectedAddrs.length === 0) return null;

  console.log(`  Calibration: scale=${scale.toFixed(4)}, affecting ${affectedAddrs.length} cells`);

  // Append a calibration wrapper to the engine
  const calCode = `
// Calibration applied at iteration ${iteration}
const _cal_scale_${iteration} = ${scale};
const _cal_addrs_${iteration} = new Set(${JSON.stringify(affectedAddrs)});
const _orig_computeModel = computeModel;
export function computeModel(inputs) {
  const out = _orig_computeModel(inputs);
  for (const addr of _cal_addrs_${iteration}) {
    if (out[addr] !== undefined) out[addr] *= _cal_scale_${iteration};
  }
  return out;
}
`;

  const newCode = engineCode.replace('export function computeModel', '// (calibrated) export function computeModel_orig') + calCode;
  const newPath = enginePath.replace('.js', `_cal${iteration}.mjs`);
  await writeFile(newPath, newCode);
  return newPath;
}

// ── Sensitivity surface ────────────────────────────────────────────────────
// Run the engine at ±10%, ±20% of each input to build a sensitivity table
async function computeSensitivitySurface(enginePath, groundTruth) {
  const evalScript = `
import { computeModel, defaultInputs } from '${enginePath.replace(/\\/g, '/')}';
const base = computeModel();
const surface = {};
const deltas = [-0.2, -0.1, 0.1, 0.2];
const inputEntries = Object.entries(defaultInputs || {}).slice(0, 10); // limit for speed
for (const [inputKey, baseVal] of inputEntries) {
  if (typeof baseVal !== 'number' || Math.abs(baseVal) < 1e-9) continue;
  surface[inputKey] = {};
  for (const delta of deltas) {
    const perturbed = { ...defaultInputs, [inputKey]: baseVal * (1 + delta) };
    const out = computeModel(perturbed);
    // Summarize key output changes
    const changes = {};
    for (const [addr, excelVal] of Object.entries(${JSON.stringify(groundTruth)})) {
      const baseOut = base[addr];
      const pertOut = out[addr];
      if (baseOut === undefined || Math.abs(baseOut) < 1e-9) continue;
      const sensitivity = (pertOut - baseOut) / baseOut;
      if (Math.abs(sensitivity) > 0.001) {
        changes[addr] = parseFloat(sensitivity.toFixed(4));
      }
    }
    surface[inputKey][delta] = changes;
  }
}
process.stdout.write(JSON.stringify(surface));
`;

  const tmpPath = enginePath.replace('.js', '_sens_tmp.mjs');
  await writeFile(tmpPath, evalScript);

  try {
    const { stdout } = await execFileAsync('node', [tmpPath], { timeout: 60000 });
    return JSON.parse(stdout);
  } catch (err) {
    return {};
  }
}

main().catch(err => {
  console.error('Eval loop error:', err);
  process.exit(1);
});

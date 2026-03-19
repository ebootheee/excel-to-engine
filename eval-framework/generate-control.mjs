/**
 * generate-control.mjs — Generate control baseline test matrix from a reference engine
 *
 * Reads BASE_CASE from the reference engine and generates test input combinations
 * centered around the actual base case values (not hardcoded guesses).
 *
 * Usage:
 *   node eval-framework/generate-control.mjs <engine-path> [output-path]
 *
 * Example:
 *   node eval-framework/generate-control.mjs ./outpost/engine.js ./eval-framework/control-baseline.json
 *
 * @license MIT
 */

import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

// ---------------------------------------------------------------------------
// Configuration — how to vary each input type around its base case
// ---------------------------------------------------------------------------

// Default: generate 5 steps spanning ±30% around the base case value
const DEFAULT_RANGE_FACTOR = 0.30;
const DEFAULT_STEPS = 5;

// Override ranges for specific input patterns (matched by key name)
const RANGE_OVERRIDES = {
  // Multiples get ±30% (default)
  exitMultiple:       { factor: 0.30, steps: 5 },
  ownedExitMultiple:  { factor: 0.30, steps: 5 },
  capRateMultiple:    { factor: 0.30, steps: 5 },

  // Counts are integers — use ±50% but round
  numFutureAcquisitions: { factor: 0.50, steps: 5, integer: true },
  numSites:              { factor: 0.50, steps: 5, integer: true },

  // Years — small discrete range
  exitYear:           { factor: 0.40, steps: 5, integer: true },
  holdPeriodYears:    { factor: 0.40, steps: 5, integer: true },

  // Percentages — tighter range
  preferredReturn:    { factor: 0.20, steps: 5 },
  carryPercent:       { factor: 0.20, steps: 5 },
  managementFeeRate:  { factor: 0.30, steps: 5 },

  // Prices — wider range
  issuancePrice:      { factor: 0.40, steps: 5 },
  acquisitionPrice:   { factor: 0.30, steps: 5 },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate an array of test values centered on baseValue.
 */
function generateRange(baseValue, key) {
  const override = RANGE_OVERRIDES[key] || {};
  const factor = override.factor ?? DEFAULT_RANGE_FACTOR;
  const steps = override.steps ?? DEFAULT_STEPS;
  const isInteger = override.integer ?? false;

  if (baseValue === 0) {
    // Can't do percentage range around zero — use small absolute range
    const range = [];
    for (let i = 0; i < steps; i++) {
      range.push(i);
    }
    return range;
  }

  const low = baseValue * (1 - factor);
  const high = baseValue * (1 + factor);
  const step = (high - low) / (steps - 1);

  const values = [];
  for (let i = 0; i < steps; i++) {
    let v = low + step * i;
    if (isInteger) v = Math.round(v);
    values.push(Number(v.toPrecision(6)));
  }

  // Ensure base case is included (replace nearest value)
  const basePrecise = Number(baseValue.toPrecision(6));
  if (!values.includes(basePrecise)) {
    // Replace the middle value with the exact base case
    const midIndex = Math.floor(steps / 2);
    values[midIndex] = basePrecise;
  }

  // Deduplicate (integers can collapse)
  return [...new Set(values)].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const enginePath = process.argv[2];
  const outputPath = process.argv[3] || './eval-framework/control-baseline.json';

  if (!enginePath) {
    console.error('Usage: node eval-framework/generate-control.mjs <engine-path> [output-path]');
    console.error('Example: node eval-framework/generate-control.mjs ./outpost/engine.js');
    process.exit(1);
  }

  // Dynamically import the engine to get its BASE_CASE
  const absPath = resolve(enginePath);
  const engineUrl = pathToFileURL(absPath).href;

  let engine;
  try {
    engine = await import(engineUrl);
  } catch (err) {
    console.error(`Failed to import engine at ${absPath}:`);
    console.error(err.message);
    process.exit(1);
  }

  const { BASE_CASE, computeModel } = engine;

  if (!BASE_CASE || typeof BASE_CASE !== 'object') {
    console.error('Engine does not export BASE_CASE');
    process.exit(1);
  }

  if (typeof computeModel !== 'function') {
    console.error('Engine does not export computeModel()');
    process.exit(1);
  }

  console.log(`Loaded BASE_CASE with ${Object.keys(BASE_CASE).length} inputs from ${enginePath}`);
  console.log('');

  // Build the test matrix: for each numeric input, generate a range around base case
  const inputRanges = {};
  for (const [key, value] of Object.entries(BASE_CASE)) {
    if (typeof value !== 'number') continue;
    const range = generateRange(value, key);
    inputRanges[key] = range;
    console.log(`  ${key}: base=${value}, range=[${range[0]} ... ${range[range.length - 1]}] (${range.length} steps)`);
  }

  // Compute the base case output as the reference
  console.log('\nComputing base case output...');
  const baseCaseOutput = computeModel(BASE_CASE);

  // Generate single-variable sweep results (vary one input at a time, hold others at base)
  console.log('Running single-variable sweeps...');
  const sweeps = {};

  for (const [inputKey, range] of Object.entries(inputRanges)) {
    sweeps[inputKey] = [];
    for (const testValue of range) {
      const testInputs = { ...BASE_CASE, [inputKey]: testValue };
      try {
        const result = computeModel(testInputs);
        sweeps[inputKey].push({
          inputValue: testValue,
          outputs: extractKeyOutputs(result),
        });
      } catch (err) {
        sweeps[inputKey].push({
          inputValue: testValue,
          error: err.message,
        });
      }
    }
  }

  // Assemble the control baseline
  const controlBaseline = {
    generatedAt: new Date().toISOString(),
    enginePath: enginePath,
    baseCaseInputs: { ...BASE_CASE },
    baseCaseOutputs: extractKeyOutputs(baseCaseOutput),
    inputRanges,
    sweeps,
  };

  const absOutputPath = resolve(outputPath);
  writeFileSync(absOutputPath, JSON.stringify(controlBaseline, null, 2));
  console.log(`\nControl baseline written to ${absOutputPath}`);
  console.log(`  ${Object.keys(inputRanges).length} inputs, ${Object.values(sweeps).reduce((sum, s) => sum + s.length, 0)} total test points`);
}

/**
 * Extract the key outputs we care about for comparison.
 * Flattens nested structure to dot-notation keys.
 */
function extractKeyOutputs(result) {
  const outputs = {};

  // Returns
  if (result.returns) {
    for (const [k, v] of Object.entries(result.returns)) {
      if (typeof v === 'number') outputs[`returns.${k}`] = v;
    }
  }

  // Waterfall
  if (result.waterfall) {
    if (typeof result.waterfall.lpTotal === 'number') outputs['waterfall.lpTotal'] = result.waterfall.lpTotal;
    if (typeof result.waterfall.gpCarry === 'number') outputs['waterfall.gpCarry'] = result.waterfall.gpCarry;
  }

  // MIP
  if (result.mip) {
    if (typeof result.mip.payment === 'number') outputs['mip.payment'] = result.mip.payment;
    if (typeof result.mip.valuePerShare === 'number') outputs['mip.valuePerShare'] = result.mip.valuePerShare;
    if (result.mip.triggered != null) outputs['mip.triggered'] = result.mip.triggered;
  }

  // Exit valuation
  if (result.exitValuation) {
    for (const [k, v] of Object.entries(result.exitValuation)) {
      if (typeof v === 'number') outputs[`exitValuation.${k}`] = v;
    }
  }

  // Per share
  if (result.perShare) {
    for (const [k, v] of Object.entries(result.perShare)) {
      if (typeof v === 'number') outputs[`perShare.${k}`] = v;
    }
  }

  return outputs;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

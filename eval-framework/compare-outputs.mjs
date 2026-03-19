/**
 * compare-outputs.mjs — Compare a candidate engine against a control baseline
 *
 * Loads a control baseline (from generate-control.mjs) and runs the same inputs
 * through a candidate engine, comparing outputs within tolerance.
 *
 * Includes input normalization: if the candidate engine uses different field names
 * for the same inputs (e.g., "exitMultiple" instead of "ownedExitMultiple"),
 * the comparator will try known aliases before failing.
 *
 * Usage:
 *   node eval-framework/compare-outputs.mjs <candidate-engine> <control-baseline>
 *
 * Example:
 *   node eval-framework/compare-outputs.mjs ./v2/engine.js ./eval-framework/control-baseline.json
 *
 * @license MIT
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

// ---------------------------------------------------------------------------
// Input Normalization — alias mapping
// ---------------------------------------------------------------------------

/**
 * Maps a canonical input name to all known aliases.
 * When a candidate engine doesn't recognize an input name, we try these aliases.
 */
const INPUT_ALIASES = {
  ownedExitMultiple: ['exitMultiple', 'capRateMultiple', 'ownedMultiple', 'reMultiple', 'exitMult'],
  numFutureAcquisitions: ['numSites', 'futureSites', 'acquisitions', 'newSites'],
  exitYear: ['holdPeriodEnd', 'dispositionYear', 'saleYear'],
  issuancePrice: ['strikePrice', 'grantPrice', 'unitPrice', 'sharePrice'],
  holdPeriodYears: ['holdPeriod', 'investmentHorizon', 'term'],
  acquisitionPrice: ['purchasePrice', 'entryPrice', 'totalCost', 'investmentCost'],
  equityInvested: ['totalEquity', 'lpEquity', 'equityCommitment', 'capitalInvested'],
  preferredReturn: ['prefReturn', 'lpPref', 'hurdleRate', 'prefRate'],
  carryPercent: ['carriedInterest', 'gpCarry', 'promotePercent', 'performanceFee'],
  managementFeeRate: ['mgmtFee', 'managementFee', 'annualFee', 'feeRate'],
  leverageRatio: ['ltv', 'loanToValue', 'debtRatio', 'leverage'],
  noiGrowthRate: ['noiGrowth', 'incomeGrowth', 'revenueGrowth'],
  capRate: ['exitCapRate', 'terminalCapRate', 'residualCapRate'],
};

// Build a reverse map: alias -> canonical name
const ALIAS_TO_CANONICAL = {};
for (const [canonical, aliases] of Object.entries(INPUT_ALIASES)) {
  for (const alias of aliases) {
    ALIAS_TO_CANONICAL[alias] = canonical;
  }
}

/**
 * Normalize input keys from control baseline format to candidate engine format.
 * Tries: (1) exact match, (2) canonical -> alias lookup against candidate's BASE_CASE.
 */
function normalizeInputs(controlInputs, candidateBaseCase) {
  const candidateKeys = new Set(Object.keys(candidateBaseCase));
  const normalized = {};
  const mappings = []; // track what was remapped for logging

  for (const [key, value] of Object.entries(controlInputs)) {
    // 1. Exact match — candidate recognizes this key
    if (candidateKeys.has(key)) {
      normalized[key] = value;
      continue;
    }

    // 2. Is this key canonical? Try its aliases
    const aliases = INPUT_ALIASES[key];
    if (aliases) {
      const match = aliases.find(a => candidateKeys.has(a));
      if (match) {
        normalized[match] = value;
        mappings.push(`${key} -> ${match}`);
        continue;
      }
    }

    // 3. Is this key an alias? Map to canonical, then check if candidate knows canonical
    const canonical = ALIAS_TO_CANONICAL[key];
    if (canonical && candidateKeys.has(canonical)) {
      normalized[canonical] = value;
      mappings.push(`${key} -> ${canonical}`);
      continue;
    }

    // 4. Is this key an alias? Try sibling aliases
    if (canonical) {
      const siblings = INPUT_ALIASES[canonical];
      if (siblings) {
        const match = siblings.find(a => candidateKeys.has(a));
        if (match) {
          normalized[match] = value;
          mappings.push(`${key} -> ${match} (via ${canonical})`);
          continue;
        }
      }
    }

    // 5. Key not recognized — pass through and let the engine handle it
    normalized[key] = value;
  }

  return { normalized, mappings };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_TOLERANCE = 0.02; // 2% tolerance for comparing outputs

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getNestedValue(obj, path) {
  return path.split('.').reduce((curr, key) => curr?.[key], obj);
}

function formatValue(v) {
  if (v == null) return 'null';
  if (typeof v === 'boolean') return String(v);
  if (Math.abs(v) >= 1000) return '$' + Math.round(v).toLocaleString('en-US');
  if (Math.abs(v) < 1 && v !== 0) return (v * 100).toFixed(4) + '%';
  return v.toFixed(4);
}

function computeDeviation(expected, actual) {
  if (expected === actual) return 0;
  if (typeof expected === 'boolean' || typeof actual === 'boolean') {
    return expected === actual ? 0 : 1;
  }
  if (expected === 0) return Math.abs(actual);
  return Math.abs((actual - expected) / expected);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const candidatePath = process.argv[2];
  const baselinePath = process.argv[3];
  const tolerance = parseFloat(process.argv[4]) || DEFAULT_TOLERANCE;

  if (!candidatePath || !baselinePath) {
    console.error('Usage: node eval-framework/compare-outputs.mjs <candidate-engine> <control-baseline> [tolerance]');
    console.error('Example: node eval-framework/compare-outputs.mjs ./v2/engine.js ./eval-framework/control-baseline.json 0.02');
    process.exit(1);
  }

  // Load control baseline
  const baseline = JSON.parse(readFileSync(resolve(baselinePath), 'utf-8'));

  // Load candidate engine
  const absEnginePath = resolve(candidatePath);
  const engineUrl = pathToFileURL(absEnginePath).href;

  let engine;
  try {
    engine = await import(engineUrl);
  } catch (err) {
    console.error(`Failed to import candidate engine at ${absEnginePath}:`);
    console.error(err.message);
    process.exit(1);
  }

  const { computeModel, BASE_CASE: candidateBaseCase } = engine;

  if (typeof computeModel !== 'function') {
    console.error('Candidate engine does not export computeModel()');
    process.exit(1);
  }

  if (!candidateBaseCase) {
    console.error('Warning: Candidate engine does not export BASE_CASE. Input normalization will be limited.');
  }

  console.log('='.repeat(60));
  console.log('  Engine Comparison — Control vs Candidate');
  console.log('='.repeat(60));
  console.log(`  Control baseline: ${baselinePath} (${baseline.generatedAt})`);
  console.log(`  Candidate engine: ${candidatePath}`);
  console.log(`  Tolerance: ${(tolerance * 100).toFixed(1)}%`);

  // --- Test input normalization ---
  const { normalized: normalizedBaseInputs, mappings } = normalizeInputs(
    baseline.baseCaseInputs,
    candidateBaseCase || {}
  );

  if (mappings.length > 0) {
    console.log(`\n  Input mappings applied:`);
    for (const m of mappings) {
      console.log(`    ${m}`);
    }
  }

  // --- Base case comparison ---
  console.log('\n--- Base Case Comparison ---\n');

  let baseCaseResult;
  try {
    baseCaseResult = computeModel(normalizedBaseInputs);
  } catch (err) {
    console.error(`  Candidate engine threw on base case: ${err.message}`);
    process.exit(1);
  }

  const baseCaseComparisons = [];
  let basePassed = 0;
  let baseTotal = 0;

  for (const [key, expectedValue] of Object.entries(baseline.baseCaseOutputs)) {
    const actualValue = getNestedValue(baseCaseResult, key);
    baseTotal++;

    if (actualValue == null) {
      console.log(`  !!  ${key}: expected=${formatValue(expectedValue)}, got=MISSING`);
      baseCaseComparisons.push({ key, expected: expectedValue, actual: null, deviation: null, passed: false });
      continue;
    }

    const deviation = computeDeviation(expectedValue, actualValue);
    const passed = deviation <= tolerance;
    if (passed) basePassed++;

    const icon = passed ? 'OK' : 'XX';
    console.log(`  ${icon}  ${key}: expected=${formatValue(expectedValue)}, got=${formatValue(actualValue)}, dev=${(deviation * 100).toFixed(4)}%`);

    baseCaseComparisons.push({ key, expected: expectedValue, actual: actualValue, deviation, passed });
  }

  // --- Sweep comparisons ---
  console.log('\n--- Sweep Comparisons ---\n');

  const sweepResults = {};
  let sweepPassed = 0;
  let sweepTotal = 0;
  let sweepErrors = 0;

  for (const [inputKey, controlSweep] of Object.entries(baseline.sweeps)) {
    sweepResults[inputKey] = [];

    for (const controlPoint of controlSweep) {
      if (controlPoint.error) continue; // skip points that errored in control

      // Build candidate inputs with normalization
      const testInputs = { ...baseline.baseCaseInputs, [inputKey]: controlPoint.inputValue };
      const { normalized } = normalizeInputs(testInputs, candidateBaseCase || {});

      let candidateOutputs;
      try {
        const result = computeModel(normalized);
        candidateOutputs = extractKeyOutputs(result);
      } catch (err) {
        sweepErrors++;
        sweepResults[inputKey].push({
          inputValue: controlPoint.inputValue,
          error: err.message,
        });
        continue;
      }

      // Compare each output
      const comparisons = {};
      let pointPassed = true;

      for (const [outputKey, expectedValue] of Object.entries(controlPoint.outputs)) {
        const actualValue = candidateOutputs[outputKey];
        sweepTotal++;

        if (actualValue == null) {
          comparisons[outputKey] = { expected: expectedValue, actual: null, deviation: null, passed: false };
          pointPassed = false;
          continue;
        }

        const deviation = computeDeviation(expectedValue, actualValue);
        const passed = deviation <= tolerance;
        if (passed) sweepPassed++;
        else pointPassed = false;

        comparisons[outputKey] = { expected: expectedValue, actual: actualValue, deviation, passed };
      }

      sweepResults[inputKey].push({
        inputValue: controlPoint.inputValue,
        comparisons,
        allPassed: pointPassed,
      });
    }

    // Summary line per input
    const inputPoints = sweepResults[inputKey];
    const inputPassed = inputPoints.filter(p => p.allPassed).length;
    const inputTotal = inputPoints.filter(p => !p.error).length;
    const icon = inputPassed === inputTotal ? 'OK' : 'XX';
    console.log(`  ${icon}  ${inputKey}: ${inputPassed}/${inputTotal} sweep points within tolerance`);
  }

  // --- Summary ---
  const allPassed = basePassed === baseTotal && sweepPassed === sweepTotal && sweepErrors === 0;

  console.log('\n' + '='.repeat(60));
  console.log(allPassed ? '  ALL COMPARISONS PASSED' : '  SOME COMPARISONS FAILED');
  console.log('='.repeat(60));
  console.log(`  Base Case:   ${basePassed}/${baseTotal}`);
  console.log(`  Sweep:       ${sweepPassed}/${sweepTotal} (${sweepErrors} errors)`);
  console.log(`  Tolerance:   ${(tolerance * 100).toFixed(1)}%`);
  console.log('='.repeat(60));

  // Write comparison results
  const comparisonResults = {
    timestamp: new Date().toISOString(),
    controlBaseline: baselinePath,
    candidateEngine: candidatePath,
    tolerance,
    allPassed,
    inputMappings: mappings,
    baseCaseComparisons,
    sweepResults,
    summary: {
      basePassed,
      baseTotal,
      sweepPassed,
      sweepTotal,
      sweepErrors,
    },
  };

  const resultsPath = resolve('./eval-framework/comparison-results.json');
  writeFileSync(resultsPath, JSON.stringify(comparisonResults, null, 2));
  console.log(`\nResults written to ${resultsPath}`);

  process.exit(allPassed ? 0 : 1);
}

/**
 * Extract key outputs from engine result (same logic as generate-control.mjs).
 */
function extractKeyOutputs(result) {
  const outputs = {};

  if (result.returns) {
    for (const [k, v] of Object.entries(result.returns)) {
      if (typeof v === 'number') outputs[`returns.${k}`] = v;
    }
  }

  if (result.waterfall) {
    if (typeof result.waterfall.lpTotal === 'number') outputs['waterfall.lpTotal'] = result.waterfall.lpTotal;
    if (typeof result.waterfall.gpCarry === 'number') outputs['waterfall.gpCarry'] = result.waterfall.gpCarry;
  }

  if (result.mip) {
    if (typeof result.mip.payment === 'number') outputs['mip.payment'] = result.mip.payment;
    if (typeof result.mip.valuePerShare === 'number') outputs['mip.valuePerShare'] = result.mip.valuePerShare;
    if (result.mip.triggered != null) outputs['mip.triggered'] = result.mip.triggered;
  }

  if (result.exitValuation) {
    for (const [k, v] of Object.entries(result.exitValuation)) {
      if (typeof v === 'number') outputs[`exitValuation.${k}`] = v;
    }
  }

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

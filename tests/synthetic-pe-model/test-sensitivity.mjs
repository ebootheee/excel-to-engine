/**
 * Sensitivity Surface Validation — Test Runner
 *
 * Proves that:
 * 1. Single-point calibration matches at base case but fails near breakpoints
 * 2. The engine's waterfall breakpoint is at the wrong location (1.40x vs 1.47x)
 * 3. Slope (elasticity) diverges near the hurdle
 * 4. Multi-point calibration improves accuracy across the full range
 *
 * Run: node tests/synthetic-pe-model/test-sensitivity.mjs
 */

import { computeModel, BASE_CASE } from './engine.js';
import { generateExcelSurface, computeCorrect } from './excel-surface.mjs';
import {
  extractSurface,
  compareSurfaces,
  computeElasticity,
  detectBreakpoints,
  multiPointCalibrate,
  printSensitivityReport,
} from '../../lib/sensitivity.mjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const INPUT_CONFIG = {
  exitMultiple: { min: 1.0, max: 3.0, steps: 11 },
};

const OUTPUT_KEYS = [
  'returns.grossMOIC',
  'returns.netMOIC',
  'waterfall.gpCarry',
  'waterfall.lpTotal',
  'mip.payment',
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('='.repeat(70));
console.log('  SENSITIVITY SURFACE VALIDATION — Synthetic PE Model');
console.log('='.repeat(70));

// ---- Step 1: Show the bug ----
console.log('\n--- Step 1: The Bug ---');
console.log('Engine uses SIMPLE interest for pref hurdle: 8% * 5 = 40%');
console.log('Excel uses COMPOUND interest: (1.08^5 - 1) = 46.93%');
console.log('');

const engineAt140 = computeModel({ exitMultiple: 1.40 });
const excelAt140 = computeCorrect({ ...BASE_CASE, exitMultiple: 1.40 });
const engineAt147 = computeModel({ exitMultiple: 1.47 });
const excelAt147 = computeCorrect({ ...BASE_CASE, exitMultiple: 1.47 });
const engineAtBase = computeModel(BASE_CASE);
const excelAtBase = computeCorrect(BASE_CASE);

console.log('At exitMultiple = 1.40x (below engine breakpoint, below Excel breakpoint):');
console.log(`  Engine GP carry: $${(engineAt140.waterfall.gpCarry / 1e6).toFixed(2)}M`);
console.log(`  Excel GP carry:  $${(excelAt140.waterfall.gpCarry / 1e6).toFixed(2)}M`);

console.log('At exitMultiple = 1.47x (above engine breakpoint, still below Excel breakpoint):');
console.log(`  Engine GP carry: $${(engineAt147.waterfall.gpCarry / 1e6).toFixed(2)}M`);
console.log(`  Excel GP carry:  $${(excelAt147.waterfall.gpCarry / 1e6).toFixed(2)}M`);

console.log('At exitMultiple = 2.0x (base case — single-point calibration masks the bug):');
console.log(`  Engine GP carry: $${(engineAtBase.waterfall.gpCarry / 1e6).toFixed(2)}M`);
console.log(`  Excel GP carry:  $${(excelAtBase.waterfall.gpCarry / 1e6).toFixed(2)}M`);

// ---- Step 2: Extract surfaces ----
console.log('\n--- Step 2: Extract Surfaces ---');

const engineSurface = extractSurface(computeModel, BASE_CASE, INPUT_CONFIG, {
  outputKeys: OUTPUT_KEYS,
  mode: 'independent',
});

const excelSurface = generateExcelSurface(BASE_CASE, INPUT_CONFIG);

console.log(`Engine surface: ${engineSurface.points.length} points`);
console.log(`Excel surface:  ${excelSurface.points.length} points`);

// ---- Step 3: Compare surfaces ----
console.log('\n--- Step 3: Compare Surfaces (before multi-point calibration) ---');

const comparison = compareSurfaces(engineSurface, excelSurface, {
  levelTolerance: 0.02,
  slopeTolerance: 0.15,
});

printSensitivityReport(comparison);

// ---- Step 4: Breakpoint detection ----
console.log('\n--- Step 4: Breakpoint Detection ---');

const engineBP = detectBreakpoints(engineSurface, 'waterfall.gpCarry', { threshold: 0.3 });
const excelBP = detectBreakpoints(excelSurface, 'waterfall.gpCarry', { threshold: 0.3 });

console.log('GP Carry breakpoints along exitMultiple:');
if (engineBP.exitMultiple?.length > 0) {
  for (const bp of engineBP.exitMultiple) {
    console.log(`  Engine: exitMultiple ≈ ${bp.location.toFixed(3)} (slope change: ${bp.slopeChangeRatio.toFixed(2)})`);
  }
} else {
  console.log('  Engine: no breakpoints detected');
}

if (excelBP.exitMultiple?.length > 0) {
  for (const bp of excelBP.exitMultiple) {
    console.log(`  Excel:  exitMultiple ≈ ${bp.location.toFixed(3)} (slope change: ${bp.slopeChangeRatio.toFixed(2)})`);
  }
} else {
  console.log('  Excel: no breakpoints detected');
}

// ---- Step 5: Elasticity comparison ----
console.log('\n--- Step 5: Elasticity Comparison ---');

const engineElasticity = computeElasticity(engineSurface, 'exitMultiple', 'waterfall.gpCarry');
const excelElasticity = computeElasticity(excelSurface, 'exitMultiple', 'waterfall.gpCarry');

console.log('Elasticity of GP Carry w.r.t. exitMultiple:');
console.log('  exitMultiple | Engine Elasticity | Excel Elasticity | Match');
console.log('  ' + '-'.repeat(65));

for (let i = 0; i < Math.min(engineElasticity.length, excelElasticity.length); i++) {
  const eng = engineElasticity[i];
  const exc = excelElasticity[i];
  const match = Math.abs(eng.elasticity - exc.elasticity) < 0.5 ? 'OK' : 'DIVERGE';
  console.log(`  ${eng.inputValue.toFixed(2).padStart(12)} | ${eng.elasticity.toFixed(4).padStart(17)} | ${exc.elasticity.toFixed(4).padStart(16)} | ${match}`);
}

// ---- Step 6: Multi-point calibration ----
console.log('\n--- Step 6: Multi-Point Calibration ---');

const { corrections, apply } = multiPointCalibrate(
  computeModel,
  BASE_CASE,
  excelSurface,
  { primaryInput: 'exitMultiple', outputKeys: OUTPUT_KEYS },
);

console.log('Corrections computed:');
for (const [key, corr] of Object.entries(corrections)) {
  console.log(`  ${key}: ${corr.segments.length} segments, avg residual: ${(corr.avgResidual * 100).toFixed(2)}%`);
}

// ---- Step 7: Re-compare after multi-point calibration ----
console.log('\n--- Step 7: Re-compare After Multi-Point Calibration ---');

// Build corrected surface
const correctedSurface = {
  ...engineSurface,
  points: engineSurface.points.map(pt => {
    if (pt.error) return pt;
    const correctedResult = apply(
      // Reconstruct a nested object from flat outputs for the apply function
      unflattenOutputs(pt.outputs),
      pt.inputs,
    );
    const correctedFlat = {};
    for (const key of OUTPUT_KEYS) {
      const val = getNestedVal(correctedResult, key);
      if (val != null) correctedFlat[key] = val;
    }
    return { ...pt, outputs: correctedFlat };
  }),
  metadata: { ...engineSurface.metadata, source: 'engine-corrected' },
};

const correctedComparison = compareSurfaces(correctedSurface, excelSurface, {
  levelTolerance: 0.02,
  slopeTolerance: 0.15,
});

printSensitivityReport(correctedComparison);

// ---- Summary ----
console.log('\n' + '='.repeat(70));
console.log('  SUMMARY');
console.log('='.repeat(70));
console.log(`  Before multi-point calibration:`);
console.log(`    Level: ${comparison.summary.levelPassCount}/${comparison.summary.totalPoints} passed (avg error: ${(comparison.summary.avgLevelError * 100).toFixed(2)}%)`);
console.log(`    Slope: ${comparison.summary.slopePassCount}/${comparison.summary.totalSlopeChecks} passed (avg error: ${(comparison.summary.avgSlopeError * 100).toFixed(2)}%)`);
console.log(`  After multi-point calibration:`);
console.log(`    Level: ${correctedComparison.summary.levelPassCount}/${correctedComparison.summary.totalPoints} passed (avg error: ${(correctedComparison.summary.avgLevelError * 100).toFixed(2)}%)`);
console.log(`    Slope: ${correctedComparison.summary.slopePassCount}/${correctedComparison.summary.totalSlopeChecks} passed (avg error: ${(correctedComparison.summary.avgSlopeError * 100).toFixed(2)}%)`);
console.log('='.repeat(70));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unflattenOutputs(flat) {
  const result = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let curr = result;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!curr[parts[i]]) curr[parts[i]] = {};
      curr = curr[parts[i]];
    }
    curr[parts[parts.length - 1]] = value;
  }
  return result;
}

function getNestedVal(obj, path) {
  return path.split('.').reduce((curr, key) => curr?.[key], obj);
}

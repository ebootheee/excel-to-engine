/**
 * excel-to-engine — Sensitivity Surface Extraction & Validation
 *
 * Captures the *shape* of input-output relationships, not just levels.
 * Detects breakpoints (waterfall hurdles, MIP thresholds), compares slopes
 * between engine and Excel, and provides multi-point calibration that works
 * across the full input range — not just at base case.
 *
 * @license MIT
 */

import { getNestedValue, setNestedValue } from './calibration.mjs';

// ---------------------------------------------------------------------------
// Output Extraction
// ---------------------------------------------------------------------------

/**
 * Flatten engine output to dot-notation keys.
 * Walks known output groups (returns, waterfall, mip, exitValuation, perShare)
 * and any additional top-level numeric fields.
 *
 * @param {Object} result - Engine output from computeModel()
 * @returns {Object<string, number|boolean>}
 */
export function flattenOutputs(result) {
  const outputs = {};

  const groups = ['returns', 'waterfall', 'mip', 'exitValuation', 'perShare'];
  for (const group of groups) {
    if (!result[group]) continue;
    for (const [k, v] of Object.entries(result[group])) {
      if (typeof v === 'number' || typeof v === 'boolean') {
        outputs[`${group}.${k}`] = v;
      }
    }
  }

  return outputs;
}

// ---------------------------------------------------------------------------
// Surface Extraction
// ---------------------------------------------------------------------------

/**
 * Extract a response surface by running the engine across a grid of input variations.
 *
 * @param {Function} computeModel - Engine function: (inputs) => outputs
 * @param {Object} baseCaseInputs - BASE_CASE inputs
 * @param {Object} inputConfig - Map of inputKey -> { min, max, steps }
 * @param {Object} [options={}]
 * @param {string[]} [options.outputKeys] - Restrict to these output dot-path keys
 * @param {string} [options.mode='independent'] - 'independent' (one-at-a-time) or 'cross' (full grid)
 * @returns {ResponseSurface}
 */
export function extractSurface(computeModel, baseCaseInputs, inputConfig, options = {}) {
  const { outputKeys = null, mode = 'independent' } = options;

  // Build input grid: array of test values per input
  const inputGrid = {};
  for (const [key, config] of Object.entries(inputConfig)) {
    inputGrid[key] = linspace(config.min, config.max, config.steps || 7);
  }

  // Compute base case
  const baseCaseResult = computeModel(baseCaseInputs);
  const baseCaseOutputs = filterOutputs(flattenOutputs(baseCaseResult), outputKeys);

  const points = [];

  if (mode === 'cross' && Object.keys(inputConfig).length === 2) {
    // 2D full grid
    const keys = Object.keys(inputGrid);
    const [key1, key2] = keys;
    for (const v1 of inputGrid[key1]) {
      for (const v2 of inputGrid[key2]) {
        const inputs = { ...baseCaseInputs, [key1]: v1, [key2]: v2 };
        points.push(evaluatePoint(computeModel, inputs, outputKeys));
      }
    }
  } else {
    // Independent sweeps: one input at a time, others at base case
    for (const [inputKey, values] of Object.entries(inputGrid)) {
      for (const testValue of values) {
        const inputs = { ...baseCaseInputs, [inputKey]: testValue };
        points.push(evaluatePoint(computeModel, inputs, outputKeys));
      }
    }
  }

  return {
    baseCaseInputs: { ...baseCaseInputs },
    baseCaseOutputs,
    inputGrid,
    points,
    metadata: {
      generatedAt: new Date().toISOString(),
      source: 'engine',
      mode,
      dimensions: Object.keys(inputConfig).length,
      totalPoints: points.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Surface Comparison
// ---------------------------------------------------------------------------

/**
 * Compare two response surfaces point-by-point.
 *
 * Reports level errors (absolute deviation at each point), slope errors
 * (derivative mismatch along each input dimension), and breakpoint mismatches.
 *
 * @param {ResponseSurface} engineSurface
 * @param {ResponseSurface} excelSurface
 * @param {Object} [options={}]
 * @param {number} [options.levelTolerance=0.02] - Max acceptable level error (2%)
 * @param {number} [options.slopeTolerance=0.15] - Max acceptable slope error (15%)
 * @returns {SurfaceComparison}
 */
export function compareSurfaces(engineSurface, excelSurface, options = {}) {
  const { levelTolerance = 0.02, slopeTolerance = 0.15 } = options;

  const pointComparisons = [];
  const slopeErrors = {};
  const breakpointComparisons = {};

  // Get all output keys present in both surfaces
  const outputKeys = Object.keys(engineSurface.baseCaseOutputs)
    .filter(k => k in excelSurface.baseCaseOutputs);

  // --- Level comparison ---
  // Match points by inputs (both surfaces must share the same grid)
  const excelPointMap = buildPointMap(excelSurface.points);

  for (const enginePoint of engineSurface.points) {
    if (enginePoint.error) continue;
    const inputKey = pointInputKey(enginePoint);
    const excelPoint = excelPointMap.get(inputKey);
    if (!excelPoint || excelPoint.error) continue;

    for (const outputKey of outputKeys) {
      const engineVal = enginePoint.outputs[outputKey];
      const excelVal = excelPoint.outputs[outputKey];
      if (engineVal == null || excelVal == null) continue;
      if (typeof engineVal === 'boolean' || typeof excelVal === 'boolean') continue;

      const levelError = excelVal !== 0
        ? Math.abs((engineVal - excelVal) / excelVal)
        : Math.abs(engineVal - excelVal);

      pointComparisons.push({
        inputs: { ...enginePoint.inputs },
        outputKey,
        engineValue: engineVal,
        excelValue: excelVal,
        levelError: round(levelError, 6),
        pass: levelError <= levelTolerance,
      });
    }
  }

  // --- Slope comparison ---
  // For each input dimension, compute slopes along that dimension in both surfaces
  for (const inputKey of Object.keys(engineSurface.inputGrid)) {
    slopeErrors[inputKey] = {};

    for (const outputKey of outputKeys) {
      if (typeof engineSurface.baseCaseOutputs[outputKey] === 'boolean') continue;

      const engineSweep = extractSweep(engineSurface, inputKey, outputKey);
      const excelSweep = extractSweep(excelSurface, inputKey, outputKey);

      if (engineSweep.length < 2 || excelSweep.length < 2) continue;

      const comparisons = [];
      const n = Math.min(engineSweep.length, excelSweep.length);

      for (let i = 0; i < n; i++) {
        const engineSlope = finiteDifferenceSlope(engineSweep, i);
        const excelSlope = finiteDifferenceSlope(excelSweep, i);

        const slopeErr = excelSlope !== 0
          ? Math.abs((engineSlope - excelSlope) / excelSlope)
          : Math.abs(engineSlope - excelSlope);

        comparisons.push({
          inputValue: engineSweep[i].x,
          engineSlope: round(engineSlope, 6),
          excelSlope: round(excelSlope, 6),
          slopeError: round(slopeErr, 6),
          pass: slopeErr <= slopeTolerance,
        });
      }

      slopeErrors[inputKey][outputKey] = comparisons;
    }
  }

  // --- Breakpoint comparison ---
  for (const outputKey of outputKeys) {
    if (typeof engineSurface.baseCaseOutputs[outputKey] === 'boolean') continue;

    const engineBP = detectBreakpoints(engineSurface, outputKey);
    const excelBP = detectBreakpoints(excelSurface, outputKey);

    breakpointComparisons[outputKey] = {};
    for (const inputKey of Object.keys(engineSurface.inputGrid)) {
      const eBP = engineBP[inputKey] || [];
      const xBP = excelBP[inputKey] || [];
      breakpointComparisons[outputKey][inputKey] = {
        engine: eBP,
        excel: xBP,
        countMatch: eBP.length === xBP.length,
      };
    }
  }

  // --- Summary ---
  const levelErrors = pointComparisons.filter(p => typeof p.levelError === 'number');
  const allSlopeComps = Object.values(slopeErrors)
    .flatMap(byOutput => Object.values(byOutput).flat());

  const summary = {
    totalPoints: levelErrors.length,
    levelPassCount: levelErrors.filter(p => p.pass).length,
    levelFailCount: levelErrors.filter(p => !p.pass).length,
    avgLevelError: levelErrors.length > 0
      ? round(levelErrors.reduce((s, p) => s + p.levelError, 0) / levelErrors.length, 6)
      : 0,
    maxLevelError: levelErrors.length > 0
      ? round(Math.max(...levelErrors.map(p => p.levelError)), 6)
      : 0,
    totalSlopeChecks: allSlopeComps.length,
    slopePassCount: allSlopeComps.filter(s => s.pass).length,
    slopeFailCount: allSlopeComps.filter(s => !s.pass).length,
    avgSlopeError: allSlopeComps.length > 0
      ? round(allSlopeComps.reduce((s, p) => s + p.slopeError, 0) / allSlopeComps.length, 6)
      : 0,
    maxSlopeError: allSlopeComps.length > 0
      ? round(Math.max(...allSlopeComps.map(p => p.slopeError)), 6)
      : 0,
  };

  return { pointComparisons, slopeErrors, breakpointComparisons, summary };
}

// ---------------------------------------------------------------------------
// Elasticity
// ---------------------------------------------------------------------------

/**
 * Compute elasticity at each point along a 1D sweep.
 * Elasticity = (% change in output) / (% change in input) relative to base case.
 *
 * @param {ResponseSurface} surface
 * @param {string} inputKey
 * @param {string} outputKey
 * @returns {Array<{inputValue: number, outputValue: number, elasticity: number}>}
 */
export function computeElasticity(surface, inputKey, outputKey) {
  const sweep = extractSweep(surface, inputKey, outputKey);
  if (sweep.length < 2) return [];

  const baseInput = surface.baseCaseInputs[inputKey];
  const baseOutput = surface.baseCaseOutputs[outputKey];

  if (!baseInput || !baseOutput || baseOutput === 0) return [];

  return sweep.map(({ x, y }) => {
    const pctInput = (x - baseInput) / baseInput;
    const pctOutput = (y - baseOutput) / baseOutput;
    const elasticity = pctInput !== 0 ? pctOutput / pctInput : 0;

    return {
      inputValue: x,
      outputValue: y,
      elasticity: round(elasticity, 4),
    };
  });
}

// ---------------------------------------------------------------------------
// Breakpoint Detection
// ---------------------------------------------------------------------------

/**
 * Detect breakpoints where the response curve changes slope sharply.
 * Uses second-derivative analysis on the slope sequence.
 *
 * @param {ResponseSurface} surface
 * @param {string} outputKey
 * @param {Object} [options={}]
 * @param {number} [options.threshold=0.5] - Minimum slope-change ratio to count as breakpoint
 * @returns {Object<string, Breakpoint[]>} Map of inputKey -> breakpoints
 */
export function detectBreakpoints(surface, outputKey, options = {}) {
  const { threshold = 0.5 } = options;
  const result = {};

  for (const inputKey of Object.keys(surface.inputGrid)) {
    const sweep = extractSweep(surface, inputKey, outputKey);
    if (sweep.length < 3) {
      result[inputKey] = [];
      continue;
    }

    const breakpoints = [];
    const slopes = [];

    for (let i = 0; i < sweep.length; i++) {
      slopes.push(finiteDifferenceSlope(sweep, i));
    }

    // Look for sharp slope changes
    for (let i = 1; i < slopes.length; i++) {
      const slopeBefore = slopes[i - 1];
      const slopeAfter = slopes[i];
      const maxSlope = Math.max(Math.abs(slopeBefore), Math.abs(slopeAfter));

      if (maxSlope < 1e-10) continue; // Both near zero, skip

      const slopeChangeRatio = Math.abs(slopeAfter - slopeBefore) / maxSlope;

      if (slopeChangeRatio >= threshold) {
        breakpoints.push({
          location: round((sweep[i - 1].x + sweep[i].x) / 2, 6),
          inputRange: [sweep[i - 1].x, sweep[i].x],
          slopeBefore: round(slopeBefore, 6),
          slopeAfter: round(slopeAfter, 6),
          slopeChangeRatio: round(slopeChangeRatio, 4),
        });
      }
    }

    result[inputKey] = breakpoints;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Multi-Point Calibration
// ---------------------------------------------------------------------------

/**
 * Multi-point calibration: fit piecewise-linear corrections using known Excel
 * values at multiple input points.
 *
 * Instead of a single scale factor (which assumes linearity), this fits
 * correction segments that adapt across the input range.
 *
 * @param {Function} computeModel - Engine function
 * @param {Object} baseCaseInputs - BASE_CASE inputs
 * @param {ResponseSurface} excelSurface - Known Excel values across the grid
 * @param {Object} [options={}]
 * @param {string[]} [options.outputKeys] - Which outputs to calibrate (default: all numeric)
 * @param {string} [options.primaryInput] - Which input dimension drives piecewise segmentation (default: first)
 * @returns {{ corrections: Object<string, PiecewiseCorrection>, apply: Function }}
 */
export function multiPointCalibrate(computeModel, baseCaseInputs, excelSurface, options = {}) {
  const primaryInput = options.primaryInput || Object.keys(excelSurface.inputGrid)[0];
  const outputKeys = options.outputKeys || Object.keys(excelSurface.baseCaseOutputs)
    .filter(k => typeof excelSurface.baseCaseOutputs[k] === 'number');

  // Extract engine surface with same grid
  const inputConfig = {};
  const grid = excelSurface.inputGrid[primaryInput];
  inputConfig[primaryInput] = {
    min: grid[0],
    max: grid[grid.length - 1],
    steps: grid.length,
  };

  const engineSurface = extractSurface(computeModel, baseCaseInputs, inputConfig, {
    outputKeys,
    mode: 'independent',
  });

  const corrections = {};

  for (const outputKey of outputKeys) {
    const engineSweep = extractSweep(engineSurface, primaryInput, outputKey);
    const excelSweep = extractSweep(excelSurface, primaryInput, outputKey);

    if (engineSweep.length < 2 || excelSweep.length < 2) continue;

    // Build error curve: correction needed at each point
    const errorPoints = [];
    const n = Math.min(engineSweep.length, excelSweep.length);

    for (let i = 0; i < n; i++) {
      // Match by closest x value
      const enginePt = engineSweep[i];
      const excelPt = excelSweep[i];
      if (enginePt && excelPt) {
        errorPoints.push({
          x: enginePt.x,
          engineY: enginePt.y,
          excelY: excelPt.y,
          error: excelPt.y - enginePt.y,
        });
      }
    }

    if (errorPoints.length < 2) continue;

    // Detect breakpoints in the Excel surface to segment the correction
    const excelBP = detectBreakpoints(excelSurface, outputKey, { threshold: 0.3 });
    const breakpointLocations = (excelBP[primaryInput] || []).map(bp => bp.location);

    // Fit piecewise linear segments
    const segments = fitPiecewiseLinear(errorPoints, breakpointLocations);

    // Compute residuals after correction
    let totalResidual = 0;
    for (const pt of errorPoints) {
      const corrected = pt.engineY + interpolateCorrection(pt.x, segments);
      const residual = Math.abs(corrected - pt.excelY) / (Math.abs(pt.excelY) || 1);
      totalResidual += residual;
    }

    corrections[outputKey] = {
      outputKey,
      primaryInput,
      segments,
      avgResidual: round(totalResidual / errorPoints.length, 6),
      pointCount: errorPoints.length,
    };
  }

  // Return corrections plus an apply function
  return {
    corrections,
    apply: (engineOutput, inputs) => applyPiecewiseCorrection(engineOutput, inputs, corrections, primaryInput),
  };
}

/**
 * Apply piecewise corrections to engine output.
 *
 * @param {Object} engineOutput - Raw engine output
 * @param {Object} inputs - Current inputs (to determine which segment applies)
 * @param {Object<string, PiecewiseCorrection>} corrections
 * @param {string} primaryInput - Which input key drives segment selection
 * @returns {Object} Corrected output (deep clone)
 */
export function applyPiecewiseCorrection(engineOutput, inputs, corrections, primaryInput) {
  const corrected = structuredClone(engineOutput);
  const x = inputs[primaryInput];

  for (const [outputKey, correction] of Object.entries(corrections)) {
    const currentValue = getNestedValue(corrected, outputKey);
    if (currentValue == null || typeof currentValue !== 'number') continue;

    const correctionAmount = interpolateCorrection(x, correction.segments);
    setNestedValue(corrected, outputKey, currentValue + correctionAmount);
  }

  return corrected;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * Print a formatted sensitivity comparison report to console.
 *
 * @param {SurfaceComparison} comparison
 */
export function printSensitivityReport(comparison) {
  const { summary, pointComparisons, slopeErrors, breakpointComparisons } = comparison;

  console.log('\n' + '='.repeat(70));
  console.log('  SENSITIVITY SURFACE COMPARISON');
  console.log('='.repeat(70));

  // Level summary
  console.log('\n--- Level Accuracy ---');
  console.log(`  Points tested:  ${summary.totalPoints}`);
  console.log(`  Passed:         ${summary.levelPassCount} (${pct(summary.levelPassCount, summary.totalPoints)})`);
  console.log(`  Failed:         ${summary.levelFailCount}`);
  console.log(`  Avg error:      ${(summary.avgLevelError * 100).toFixed(2)}%`);
  console.log(`  Max error:      ${(summary.maxLevelError * 100).toFixed(2)}%`);

  // Slope summary
  console.log('\n--- Slope (Sensitivity) Accuracy ---');
  console.log(`  Checks:         ${summary.totalSlopeChecks}`);
  console.log(`  Passed:         ${summary.slopePassCount} (${pct(summary.slopePassCount, summary.totalSlopeChecks)})`);
  console.log(`  Failed:         ${summary.slopeFailCount}`);
  console.log(`  Avg error:      ${(summary.avgSlopeError * 100).toFixed(2)}%`);
  console.log(`  Max error:      ${(summary.maxSlopeError * 100).toFixed(2)}%`);

  // Worst level errors
  const worstLevel = [...pointComparisons]
    .filter(p => !p.pass)
    .sort((a, b) => b.levelError - a.levelError)
    .slice(0, 5);

  if (worstLevel.length > 0) {
    console.log('\n--- Worst Level Errors ---');
    for (const p of worstLevel) {
      const inputDesc = Object.entries(p.inputs)
        .filter(([k, v]) => v !== comparison.pointComparisons[0]?.inputs?.[k])
        .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toPrecision(4) : v}`)
        .join(', ') || 'base case';
      console.log(`  ${p.outputKey} @ ${inputDesc}: engine=${fmt(p.engineValue)} excel=${fmt(p.excelValue)} error=${(p.levelError * 100).toFixed(1)}%`);
    }
  }

  // Worst slope errors
  const allSlopes = Object.entries(slopeErrors).flatMap(([inputKey, byOutput]) =>
    Object.entries(byOutput).flatMap(([outputKey, comps]) =>
      comps.filter(c => !c.pass).map(c => ({ inputKey, outputKey, ...c }))
    )
  ).sort((a, b) => b.slopeError - a.slopeError).slice(0, 5);

  if (allSlopes.length > 0) {
    console.log('\n--- Worst Slope Errors ---');
    for (const s of allSlopes) {
      console.log(`  d(${s.outputKey})/d(${s.inputKey}) @ ${s.inputKey}=${s.inputValue}: engine=${fmt(s.engineSlope)} excel=${fmt(s.excelSlope)} error=${(s.slopeError * 100).toFixed(1)}%`);
    }
  }

  // Breakpoints
  const bpSummary = [];
  for (const [outputKey, byInput] of Object.entries(breakpointComparisons)) {
    for (const [inputKey, bp] of Object.entries(byInput)) {
      if (bp.engine.length > 0 || bp.excel.length > 0) {
        bpSummary.push({ outputKey, inputKey, ...bp });
      }
    }
  }

  if (bpSummary.length > 0) {
    console.log('\n--- Breakpoints Detected ---');
    for (const bp of bpSummary) {
      const eLocs = bp.engine.map(b => b.location.toPrecision(4)).join(', ') || 'none';
      const xLocs = bp.excel.map(b => b.location.toPrecision(4)).join(', ') || 'none';
      const match = bp.countMatch ? 'MATCH' : 'MISMATCH';
      console.log(`  ${bp.outputKey} vs ${bp.inputKey}: engine=[${eLocs}] excel=[${xLocs}] ${match}`);
    }
  }

  console.log('\n' + '='.repeat(70));
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

function evaluatePoint(computeModel, inputs, outputKeys) {
  try {
    const result = computeModel(inputs);
    return {
      inputs: { ...inputs },
      outputs: filterOutputs(flattenOutputs(result), outputKeys),
      error: false,
    };
  } catch (err) {
    return {
      inputs: { ...inputs },
      outputs: {},
      error: true,
      errorMessage: err.message,
    };
  }
}

/**
 * Extract a 1D sweep: for a given inputKey and outputKey, get all points where
 * only that input varies (others at base case).
 */
function extractSweep(surface, inputKey, outputKey) {
  const baseInputs = surface.baseCaseInputs;
  const points = [];

  for (const pt of surface.points) {
    if (pt.error) continue;
    if (pt.outputs[outputKey] == null) continue;

    // Check that all other inputs are at base case
    let othersAtBase = true;
    for (const [k, v] of Object.entries(baseInputs)) {
      if (k === inputKey) continue;
      if (pt.inputs[k] !== v) {
        othersAtBase = false;
        break;
      }
    }

    if (othersAtBase) {
      points.push({ x: pt.inputs[inputKey], y: pt.outputs[outputKey] });
    }
  }

  return points.sort((a, b) => a.x - b.x);
}

function finiteDifferenceSlope(sweep, index) {
  if (sweep.length < 2) return 0;
  if (index === 0) {
    return (sweep[1].y - sweep[0].y) / (sweep[1].x - sweep[0].x || 1e-10);
  }
  if (index >= sweep.length - 1) {
    const i = sweep.length - 1;
    return (sweep[i].y - sweep[i - 1].y) / (sweep[i].x - sweep[i - 1].x || 1e-10);
  }
  // Central difference
  return (sweep[index + 1].y - sweep[index - 1].y) / (sweep[index + 1].x - sweep[index - 1].x || 1e-10);
}

function fitPiecewiseLinear(errorPoints, breakpointLocations) {
  // Sort breakpoints and create segment boundaries
  const boundaries = [
    errorPoints[0].x,
    ...breakpointLocations.sort((a, b) => a - b),
    errorPoints[errorPoints.length - 1].x,
  ];

  const segments = [];

  for (let seg = 0; seg < boundaries.length - 1; seg++) {
    const low = boundaries[seg];
    const high = boundaries[seg + 1];

    // Get points in this segment
    const segPoints = errorPoints.filter(p => p.x >= low - 1e-10 && p.x <= high + 1e-10);

    if (segPoints.length < 1) {
      segments.push({ inputLow: low, inputHigh: high, slope: 0, intercept: 0 });
      continue;
    }

    if (segPoints.length === 1) {
      segments.push({ inputLow: low, inputHigh: high, slope: 0, intercept: segPoints[0].error });
      continue;
    }

    // Simple linear regression on the error values
    const n = segPoints.length;
    const sumX = segPoints.reduce((s, p) => s + p.x, 0);
    const sumY = segPoints.reduce((s, p) => s + p.error, 0);
    const sumXY = segPoints.reduce((s, p) => s + p.x * p.error, 0);
    const sumX2 = segPoints.reduce((s, p) => s + p.x * p.x, 0);

    const denom = n * sumX2 - sumX * sumX;
    let slope = 0;
    let intercept = sumY / n;

    if (Math.abs(denom) > 1e-20) {
      slope = (n * sumXY - sumX * sumY) / denom;
      intercept = (sumY - slope * sumX) / n;
    }

    segments.push({
      inputLow: low,
      inputHigh: high,
      slope: round(slope, 10),
      intercept: round(intercept, 6),
    });
  }

  return segments;
}

function interpolateCorrection(x, segments) {
  if (!segments || segments.length === 0) return 0;

  // Find the segment containing x
  for (const seg of segments) {
    if (x >= seg.inputLow - 1e-10 && x <= seg.inputHigh + 1e-10) {
      return seg.slope * x + seg.intercept;
    }
  }

  // Extrapolate from nearest segment
  if (x < segments[0].inputLow) {
    const seg = segments[0];
    return seg.slope * x + seg.intercept;
  }
  const seg = segments[segments.length - 1];
  return seg.slope * x + seg.intercept;
}

function linspace(min, max, steps) {
  if (steps <= 1) return [min];
  const result = [];
  for (let i = 0; i < steps; i++) {
    result.push(round(min + (max - min) * i / (steps - 1), 10));
  }
  return result;
}

function filterOutputs(outputs, keys) {
  if (!keys) return outputs;
  const filtered = {};
  for (const k of keys) {
    if (k in outputs) filtered[k] = outputs[k];
  }
  return filtered;
}

function buildPointMap(points) {
  const map = new Map();
  for (const pt of points) {
    map.set(pointInputKey(pt), pt);
  }
  return map;
}

function pointInputKey(point) {
  return Object.entries(point.inputs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('|');
}

function round(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function fmt(value) {
  if (typeof value !== 'number') return String(value);
  if (Math.abs(value) >= 1e6) return (value / 1e6).toFixed(2) + 'M';
  if (Math.abs(value) >= 1e3) return (value / 1e3).toFixed(1) + 'K';
  if (Math.abs(value) < 0.01) return value.toExponential(2);
  return value.toFixed(4);
}

function pct(num, denom) {
  if (denom === 0) return '0%';
  return ((num / denom) * 100).toFixed(0) + '%';
}

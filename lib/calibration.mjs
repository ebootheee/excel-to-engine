/**
 * excel-to-engine — Auto-Calibration Framework
 *
 * Computes scale factors that align a JavaScript engine's outputs
 * with the Excel model's known-good values at base case. This bridges
 * the gap between simplified JS calculations and Excel's full-precision
 * formulas without requiring exact formula replication.
 *
 * @license MIT
 */

/**
 * @typedef {Object} CalibrationTarget
 * @property {string} key - Output key path (e.g., "returns.grossMOIC")
 * @property {number} excelValue - Known-good value from the Excel model
 * @property {string} [type='ratio'] - Calibration type: 'ratio' (multiplicative),
 *                                      'offset' (additive), or 'none' (skip)
 */

/**
 * @typedef {Object} CalibrationResult
 * @property {Object<string, number>} factors - Map of output key to calibration factor
 * @property {Object<string, Object>} diagnostics - Per-output diagnostic info
 * @property {boolean} converged - Whether all outputs are within tolerance
 * @property {number} maxDeviation - Largest deviation across all outputs
 */

/**
 * Compute calibration factors that align engine outputs with Excel targets.
 *
 * For each target, computes a scale factor (ratio or offset) such that:
 *   engineOutput * factor ≈ excelTarget   (for ratio type)
 *   engineOutput + factor ≈ excelTarget   (for offset type)
 *
 * @param {Function} engineFn - Engine function: (inputs) => outputs
 * @param {Object} baseCaseInputs - Base case input values
 * @param {CalibrationTarget[]} targets - Array of calibration targets
 * @param {Object} [options={}]
 * @param {number} [options.tolerance=0.001] - Acceptable deviation (0.1%)
 * @param {number} [options.maxIter=5] - Max calibration iterations
 * @param {boolean} [options.verbose=false] - Log diagnostics
 * @returns {CalibrationResult}
 *
 * @example
 * const factors = calibrate(
 *   computeModel,
 *   BASE_CASE,
 *   [
 *     { key: 'returns.grossMOIC', excelValue: 2.15 },
 *     { key: 'returns.netIRR', excelValue: 0.1847 },
 *     { key: 'waterfall.gpCarry', excelValue: 5_200_000 },
 *   ]
 * );
 */
export function calibrate(engineFn, baseCaseInputs, targets, options = {}) {
  const {
    tolerance = 0.001,
    maxIter = 5,
    verbose = false,
  } = options;

  const factors = {};
  const diagnostics = {};

  // Initialize factors to 1.0 (no adjustment)
  for (const t of targets) {
    factors[t.key] = t.type === 'offset' ? 0 : 1.0;
  }

  let converged = false;
  let maxDeviation = Infinity;

  for (let iter = 0; iter < maxIter; iter++) {
    // Run engine at base case
    const result = engineFn(baseCaseInputs);
    maxDeviation = 0;
    converged = true;

    for (const target of targets) {
      if (target.type === 'none') continue;

      const engineValue = getNestedValue(result, target.key);
      const excelValue = target.excelValue;

      if (engineValue == null || isNaN(engineValue)) {
        diagnostics[target.key] = {
          status: 'error',
          message: `Engine returned ${engineValue} for ${target.key}`,
          engineValue,
          excelValue,
          factor: factors[target.key],
        };
        converged = false;
        continue;
      }

      // Compute deviation
      const deviation = excelValue !== 0
        ? Math.abs((engineValue * factors[target.key] - excelValue) / excelValue)
        : Math.abs(engineValue * factors[target.key] - excelValue);

      maxDeviation = Math.max(maxDeviation, deviation);

      if (deviation > tolerance) {
        converged = false;

        if (target.type === 'offset') {
          factors[target.key] = excelValue - engineValue;
        } else {
          // Ratio calibration
          if (Math.abs(engineValue) < 1e-12) {
            diagnostics[target.key] = {
              status: 'warning',
              message: `Engine value near zero for ${target.key}, cannot compute ratio`,
              engineValue,
              excelValue,
              factor: factors[target.key],
            };
            continue;
          }
          factors[target.key] = excelValue / engineValue;
        }
      }

      diagnostics[target.key] = {
        status: deviation <= tolerance ? 'pass' : 'adjusted',
        engineValue,
        excelValue,
        calibratedValue: target.type === 'offset'
          ? engineValue + factors[target.key]
          : engineValue * factors[target.key],
        factor: factors[target.key],
        deviation,
        iteration: iter,
      };
    }

    if (verbose) {
      console.log(`Calibration iteration ${iter + 1}: maxDeviation=${maxDeviation.toFixed(6)}, converged=${converged}`);
    }

    if (converged) break;
  }

  return { factors, diagnostics, converged, maxDeviation };
}

/**
 * Apply calibration factors to engine output.
 *
 * Takes raw engine output and returns a calibrated copy with
 * factors applied to the specified keys.
 *
 * @param {Object} engineOutput - Raw engine output object
 * @param {Object<string, number>} factors - Calibration factors from calibrate()
 * @param {CalibrationTarget[]} targets - Original targets (for type info)
 * @returns {Object} Calibrated output (deep clone with adjusted values)
 */
export function applyCalibration(engineOutput, factors, targets) {
  const calibrated = structuredClone(engineOutput);

  for (const target of targets) {
    if (target.type === 'none') continue;
    const factor = factors[target.key];
    if (factor == null) continue;

    const currentValue = getNestedValue(calibrated, target.key);
    if (currentValue == null || isNaN(currentValue)) continue;

    const newValue = target.type === 'offset'
      ? currentValue + factor
      : currentValue * factor;

    setNestedValue(calibrated, target.key, newValue);
  }

  return calibrated;
}

/**
 * Validate engine outputs against Excel targets.
 *
 * Returns a detailed report showing pass/fail status for each output,
 * with deviations and suggested calibration if needed.
 *
 * @param {Object} engineOutput - Engine output to validate
 * @param {CalibrationTarget[]} targets - Expected values
 * @param {Object} [options={}]
 * @param {number} [options.tolerance=0.01] - Acceptable deviation (1%)
 * @returns {Object} Validation report
 */
export function validateOutputs(engineOutput, targets, options = {}) {
  const { tolerance = 0.01 } = options;
  const results = [];
  let allPassed = true;

  for (const target of targets) {
    const actual = getNestedValue(engineOutput, target.key);
    const expected = target.excelValue;

    const deviation = expected !== 0
      ? Math.abs((actual - expected) / expected)
      : Math.abs(actual - expected);

    const passed = deviation <= tolerance;
    if (!passed) allPassed = false;

    results.push({
      key: target.key,
      expected,
      actual,
      deviation,
      deviationPercent: (deviation * 100).toFixed(4) + '%',
      passed,
      suggestedFactor: expected !== 0 && actual !== 0 ? expected / actual : null,
    });
  }

  return {
    allPassed,
    passCount: results.filter(r => r.passed).length,
    failCount: results.filter(r => !r.passed).length,
    totalCount: results.length,
    tolerance,
    results,
  };
}

// ---------------------------------------------------------------------------
// Utility: nested property access
// ---------------------------------------------------------------------------

/**
 * Get a nested value from an object using dot notation.
 * @param {Object} obj
 * @param {string} path - Dot-separated path (e.g., "returns.grossMOIC")
 * @returns {*}
 */
export function getNestedValue(obj, path) {
  return path.split('.').reduce((curr, key) => curr?.[key], obj);
}

/**
 * Set a nested value on an object using dot notation.
 * @param {Object} obj
 * @param {string} path
 * @param {*} value
 */
export function setNestedValue(obj, path, value) {
  const keys = path.split('.');
  let curr = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (curr[keys[i]] == null) curr[keys[i]] = {};
    curr = curr[keys[i]];
  }
  curr[keys[keys.length - 1]] = value;
}

/**
 * Synthetic PE Fund Engine — Deliberately Buggy
 *
 * A simple PE fund model designed to demonstrate why single-point calibration
 * fails at waterfall breakpoints. This engine has a specific bug: it uses
 * simple interest for the preferred return hurdle instead of compound interest.
 *
 * At base case (2.0x exit), single-point calibration masks this error.
 * Near the waterfall breakpoint (~1.4x vs correct ~1.47x), the error surfaces.
 *
 * Model:
 *   - $100M acquisition, variable exit multiple, 5yr hold
 *   - 3-tier waterfall: return of capital → 8% pref → 80/20 LP/GP residual
 *   - MIP: triggers at 1.5x MOIC, 10% of excess above threshold
 *
 * @license MIT
 */

// ---------------------------------------------------------------------------
// Base Case
// ---------------------------------------------------------------------------

export const BASE_CASE = {
  acquisitionPrice: 100_000_000,
  exitMultiple: 2.0,
  holdPeriodYears: 5,
  prefReturn: 0.08,
  gpCarryPercent: 0.20,
  mipThreshold: 1.5,
  mipDilution: 0.10,
};

// Excel targets — these are the "correct" values (compound interest)
// that we want to match at base case.
const EXCEL_TARGETS = {
  'returns.grossMOIC': 2.0,
  'returns.netMOIC': 1.7061,     // lpTotal / equity
  'returns.grossIRR': 0.1487,    // (2.0)^(1/5) - 1
  'returns.netIRR': 0.1127,
  'waterfall.gpCarry': 14_693_281,
  'waterfall.lpTotal': 185_306_719,
  'mip.payment': 5_000_000,
  'mip.triggered': true,
};

// Single-point calibration factors (computed at module load)
const _cal = {};

// ---------------------------------------------------------------------------
// Raw computation (with the bug)
// ---------------------------------------------------------------------------

function _computeRaw(inputs) {
  const {
    acquisitionPrice,
    exitMultiple,
    holdPeriodYears,
    prefReturn,
    gpCarryPercent,
    mipThreshold,
    mipDilution,
  } = { ...BASE_CASE, ...inputs };

  const equityBasis = acquisitionPrice;
  const grossExitValue = acquisitionPrice * exitMultiple;
  const netProceeds = grossExitValue; // Simplified: no debt, no transaction costs

  // ---- Waterfall ----
  // Tier 1: Return of capital
  const returnOfCapital = Math.min(netProceeds, equityBasis);
  let remaining = netProceeds - returnOfCapital;

  // BUG: Simple interest instead of compound
  // Correct: prefHurdle = equityBasis * ((1 + prefReturn)^holdPeriodYears - 1)
  // Bug:     prefHurdle = equityBasis * prefReturn * holdPeriodYears
  const prefHurdle = equityBasis * prefReturn * holdPeriodYears;

  // Tier 2: Preferred return (100% to LP)
  const prefDistribution = Math.min(remaining, prefHurdle);
  remaining -= prefDistribution;

  // Tier 3: Residual 80/20 LP/GP
  const gpCarry = remaining * gpCarryPercent;
  const lpResidual = remaining * (1 - gpCarryPercent);

  const lpTotal = returnOfCapital + prefDistribution + lpResidual;

  // ---- Returns ----
  const grossMOIC = netProceeds / equityBasis;
  const netMOIC = lpTotal / equityBasis;

  // IRR approximation: MOIC^(1/years) - 1
  const grossIRR = Math.pow(Math.max(grossMOIC, 0.001), 1 / holdPeriodYears) - 1;
  const netIRR = Math.pow(Math.max(netMOIC, 0.001), 1 / holdPeriodYears) - 1;

  // ---- MIP ----
  const mipTriggered = grossMOIC >= mipThreshold;
  const mipPayment = mipTriggered
    ? mipDilution * Math.max(0, lpTotal - mipThreshold * equityBasis)
    : 0;

  return {
    inputs: { ...BASE_CASE, ...inputs },
    returns: { grossMOIC, netMOIC, grossIRR, netIRR },
    waterfall: {
      lpTotal,
      gpCarry,
      returnOfCapital,
      prefDistribution,
      lpResidual,
      tiers: [
        { name: 'Return of Capital', lpAmount: returnOfCapital, gpAmount: 0 },
        { name: 'Preferred Return', lpAmount: prefDistribution, gpAmount: 0 },
        { name: 'Residual 80/20', lpAmount: lpResidual, gpAmount: gpCarry },
      ],
    },
    exitValuation: { grossExitValue, netProceeds },
    mip: { triggered: mipTriggered, payment: mipPayment },
    perShare: { gross: grossMOIC, net: netMOIC },
  };
}

// ---------------------------------------------------------------------------
// Calibration (single-point, at module load)
// ---------------------------------------------------------------------------

function _initCalibration() {
  const raw = _computeRaw(BASE_CASE);

  for (const [key, excelValue] of Object.entries(EXCEL_TARGETS)) {
    const rawValue = _getNestedValue(raw, key);
    if (typeof rawValue === 'boolean') {
      _cal[key] = rawValue === excelValue ? 1 : 0;
    } else if (typeof rawValue === 'number' && Math.abs(rawValue) > 1e-12) {
      _cal[key] = excelValue / rawValue;
    } else {
      _cal[key] = 1;
    }
  }
}

function _getNestedValue(obj, path) {
  return path.split('.').reduce((curr, key) => curr?.[key], obj);
}

function _setNestedValue(obj, path, value) {
  const keys = path.split('.');
  let curr = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (curr[keys[i]] == null) curr[keys[i]] = {};
    curr = curr[keys[i]];
  }
  curr[keys[keys.length - 1]] = value;
}

// Run calibration on load
_initCalibration();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function computeModel(inputs = {}) {
  const merged = { ...BASE_CASE, ...inputs };
  const raw = _computeRaw(merged);
  const calibrated = structuredClone(raw);

  // Apply single-point calibration factors
  for (const [key, factor] of Object.entries(_cal)) {
    const rawValue = _getNestedValue(calibrated, key);
    if (typeof rawValue === 'boolean') continue;
    if (typeof rawValue === 'number') {
      _setNestedValue(calibrated, key, rawValue * factor);
    }
  }

  return calibrated;
}

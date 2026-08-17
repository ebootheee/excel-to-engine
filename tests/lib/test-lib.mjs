#!/usr/bin/env node
/**
 * Unit tests for the shared financial libraries in lib/ — known-answer cases for
 * the pure math (IRR/NPV/XIRR, the PE distribution waterfall) plus the
 * calibration + sensitivity helpers. These had no direct coverage; CI now guards
 * them on every push.
 *
 * Usage: node tests/lib/test-lib.mjs
 */

import { npv, npvDerivative, computeIRR, computeIRRBisection, computeXIRR } from '../../lib/irr.mjs';
import {
  computeWaterfall, createAmericanWaterfall, createEuropeanWaterfall, createMoicHurdleWaterfall,
} from '../../lib/waterfall.mjs';
import { getNestedValue, setNestedValue, validateOutputs } from '../../lib/calibration.mjs';
import { flattenOutputs } from '../../lib/sensitivity.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); } }
function near(a, b, tol, msg) { assert(typeof a === 'number' && Math.abs(a - b) <= tol, `${msg} (got ${a}, want ≈${b} ±${tol})`); }

// ── IRR / NPV / XIRR ─────────────────────────────────────────────────────────
console.log('Testing: lib/irr.mjs');
{
  near(npv([-100, 110], 0.10), 0, 1e-9, 'npv zero at the break-even rate');
  near(npv([100], 0.5), 100, 1e-12, 'npv of a single t=0 flow is itself');
  near(npv([0, 100], 0), 100, 1e-12, 'npv at rate 0 is the undiscounted sum');
  assert(npvDerivative([-100, 110], 0.10) < 0, 'npv decreases as rate rises (negative derivative)');

  near(computeIRR([-100, 150]), 0.50, 1e-4, 'IRR of -100 → +150 is 50%');
  near(computeIRR([-100, 110]), 0.10, 1e-4, 'IRR of -100 → +110 is 10%');
  near(computeIRR([-1000, 200, 200, 200, 200, 200, 200, 200, 200]), 0.1189, 1e-3, 'IRR of -1000 then 200×8 ≈ 11.89%');
  near(computeIRR([-1000, 0, 0, 1100]), 0.03228, 1e-3, 'IRR of -1000 → +1100 in 3y ≈ 3.23%');
  // NPV(IRR) ≈ 0 sanity for a found rate
  const r = computeIRR([-500, 100, 200, 300]);
  near(npv([-500, 100, 200, 300], r), 0, 1e-5, 'NPV at the solved IRR is ~0');

  assert(computeIRR([10, 20]) === null, 'no sign change → null IRR');
  assert(computeIRR([-10]) === null, 'single flow → null IRR');

  near(computeIRRBisection([-100, 150]), 0.50, 1e-4, 'bisection agrees: 50%');
  near(computeIRRBisection([-1000, 200, 200, 200, 200, 200, 200, 200, 200]), 0.1189, 1e-3, 'bisection agrees: ~11.89%');

  const xirr = computeXIRR([
    { date: new Date('2020-01-01'), amount: -1000 },
    { date: new Date('2021-01-01'), amount: 1100 },
  ]);
  near(xirr, 0.10, 2e-3, 'XIRR of -1000 → +1100 one year later ≈ 10%');

  // Excel XIRR uses a 365-day basis (not 365.25) — discriminate on a leap span:
  // -100 on 2020-01-01 → +110 on 2021-01-01 spans 366 days (leap 2020), so
  // Excel solves (1+r)^(366/365) = 1.1 → r = 1.1^(365/366) − 1. The old
  // 365.25 basis lands ~3.6e-5 away, well outside the 1e-6 gate.
  const leapXirr = computeXIRR([
    { date: new Date('2020-01-01'), amount: -100 },
    { date: new Date('2021-01-01'), amount: 110 },
  ]);
  const xirr365 = Math.pow(1.1, 365 / 366) - 1;
  const xirr36525 = Math.pow(1.1, 365.25 / 366) - 1;
  assert(Math.abs(xirr365 - xirr36525) > 1e-5, 'negative control: 365 vs 365.25 basis differ measurably');
  near(leapXirr, xirr365, 1e-6, "XIRR on a 366-day leap span uses Excel's 365-day basis");
}

// ── Waterfall ────────────────────────────────────────────────────────────────
console.log('Testing: lib/waterfall.mjs');
{
  // Standard American 80/20, 8% pref, full catch-up. 200M proceeds on 100M
  // equity, 1y hold (simple pref = 100M × 8% = 8M).
  const american = createAmericanWaterfall({ prefReturn: 0.08, carryPercent: 0.20, residualLPSplit: 0.80, hasCatchup: true });
  assert(american.length === 4, `American (with catch-up) has 4 tiers (got ${american.length})`);
  const w = computeWaterfall(200_000_000, 100_000_000, american, { holdPeriodYears: 1 });
  near(w.totalDistributed, 200_000_000, 1, 'all proceeds distributed');
  near(w.gpTotal, 34_400_000, 1, 'GP carry = catch-up 20M + residual 14.4M = 34.4M');
  near(w.lpTotal, 165_600_000, 1, 'LP = ROC 100M + pref 8M + residual 57.6M = 165.6M');
  near(w.lpTotal + w.gpTotal, w.totalDistributed, 1, 'conservation: LP + GP = distributed');
  near(w.gpCarryPercent, 0.344, 1e-4, 'GP carry % of profit = 34.4%');
  near(w.undistributed, 0, 1, 'nothing left undistributed');

  // No catch-up variant has one fewer tier and less GP.
  const noCatchup = createAmericanWaterfall({ prefReturn: 0.08, carryPercent: 0.20, residualLPSplit: 0.80, hasCatchup: false });
  assert(noCatchup.length === 3, `American (no catch-up) has 3 tiers (got ${noCatchup.length})`);
  const w2 = computeWaterfall(200_000_000, 100_000_000, noCatchup, { holdPeriodYears: 1 });
  assert(w2.gpTotal < w.gpTotal, 'no-catch-up GP carry is lower than with catch-up');
  near(w2.lpTotal + w2.gpTotal, w2.totalDistributed, 1, 'conservation holds (no catch-up)');

  // Loss case: proceeds below equity → no carry, LP gets everything available.
  const loss = computeWaterfall(80_000_000, 100_000_000, american, { holdPeriodYears: 1 });
  near(loss.gpTotal, 0, 1, 'no GP carry on a loss');
  near(loss.lpTotal, 80_000_000, 1, 'LP receives all proceeds on a loss');
  near(loss.gpCarryPercent, 0, 1e-9, 'GP carry % is 0 when there is no profit');

  // Flat MOIC hurdle (no IRR pref): 1.40x hurdle, 20% promote, 2.0x MOIC.
  const moic = createMoicHurdleWaterfall({ hurdleMOIC: 1.40, carryPercent: 0.20 });
  const w3 = computeWaterfall(200_000_000, 100_000_000, moic);
  near(w3.gpTotal, 12_000_000, 1, 'MOIC-hurdle GP = 20% × (200M − 140M) = 12M');
  near(w3.lpTotal, 188_000_000, 1, 'MOIC-hurdle LP = 188M');
  // The flat MOIC hurdle must NOT move with hold period (documented invariant).
  const w3long = computeWaterfall(200_000_000, 100_000_000, moic, { holdPeriodYears: 10 });
  near(w3long.gpTotal, w3.gpTotal, 1, 'flat MOIC hurdle is hold-period-independent');

  // European builder produces a usable, ordered tier set.
  const euro = createEuropeanWaterfall([
    { hurdle: 0.08, carry: 0.00 }, { hurdle: 0.12, carry: 0.20 }, { hurdle: Infinity, carry: 0.30 },
  ]);
  assert(euro[0].type === 'return_of_capital', 'European waterfall starts with return of capital');
  const w4 = computeWaterfall(150_000_000, 100_000_000, euro, { holdPeriodYears: 1 });
  near(w4.lpTotal + w4.gpTotal, w4.totalDistributed, 1, 'conservation holds (European)');
}

// ── Calibration helpers ──────────────────────────────────────────────────────
console.log('Testing: lib/calibration.mjs');
{
  assert(getNestedValue({ a: { b: { c: 42 } } }, 'a.b.c') === 42, 'getNestedValue reads a deep path');
  assert(getNestedValue({ a: {} }, 'a.b.c') === undefined, 'getNestedValue returns undefined for a missing path');

  const obj = {};
  setNestedValue(obj, 'x.y.z', 5);
  assert(obj.x && obj.x.y && obj.x.y.z === 5, 'setNestedValue creates intermediate objects');

  const v = validateOutputs(
    { returns: { moic: 2.00, irr: 0.20 } },
    [{ key: 'returns.moic', excelValue: 2.00 }, { key: 'returns.irr', excelValue: 0.25 }],
    { tolerance: 0.01 },
  );
  assert(v.totalCount === 2, 'validateOutputs reports total count');
  assert(v.passCount === 1 && v.failCount === 1, 'validateOutputs: moic passes, irr (0.20 vs 0.25) fails at 1% tol');
  assert(v.allPassed === false, 'validateOutputs.allPassed false when any fails');
  const irrRes = v.results.find(r => r.key === 'returns.irr');
  near(irrRes.suggestedFactor, 0.25 / 0.20, 1e-9, 'validateOutputs suggests the corrective factor');
}

// ── Sensitivity helpers ──────────────────────────────────────────────────────
console.log('Testing: lib/sensitivity.mjs');
{
  const flat = flattenOutputs({
    returns: { moic: 2.0, irr: 0.2, label: 'skip-strings' },
    waterfall: { gpCarry: 1_000_000 },
    ignoredGroup: { x: 99 },
  });
  assert(flat['returns.moic'] === 2.0 && flat['returns.irr'] === 0.2, 'flattenOutputs flattens numeric outputs');
  assert(flat['waterfall.gpCarry'] === 1_000_000, 'flattenOutputs includes the waterfall group');
  assert(!('returns.label' in flat), 'flattenOutputs drops non-numeric values');
  assert(!('ignoredGroup.x' in flat), 'flattenOutputs only includes known output groups');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

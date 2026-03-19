/**
 * excel-to-engine — IRR Computation Library
 *
 * Newton-Raphson IRR solver with bisection fallback.
 * Pure functions, zero dependencies.
 *
 * @license MIT
 */

/**
 * Compute the Net Present Value of a series of cash flows.
 *
 * @param {number[]} cashFlows - Array where index = year offset from time zero.
 *                               Negative values are outflows, positive are inflows.
 * @param {number} rate - Discount rate (e.g., 0.10 for 10%)
 * @returns {number} Net present value
 */
export function npv(cashFlows, rate) {
  let total = 0;
  for (let t = 0; t < cashFlows.length; t++) {
    total += cashFlows[t] / Math.pow(1 + rate, t);
  }
  return total;
}

/**
 * Compute the derivative of NPV with respect to the discount rate.
 * Used by Newton-Raphson iteration.
 *
 * @param {number[]} cashFlows
 * @param {number} rate
 * @returns {number} dNPV/dr
 */
export function npvDerivative(cashFlows, rate) {
  let total = 0;
  for (let t = 1; t < cashFlows.length; t++) {
    total += -t * cashFlows[t] / Math.pow(1 + rate, t + 1);
  }
  return total;
}

/**
 * Compute IRR using the Newton-Raphson method with bisection fallback.
 *
 * Cash flows are annual, with index 0 = time zero (typically negative for
 * initial investment). The function finds the rate r such that NPV(r) = 0.
 *
 * @param {number[]} cashFlows - Annual cash flows. Index 0 = time zero.
 * @param {number} [guess=0.10] - Initial rate guess
 * @param {number} [maxIter=1000] - Maximum Newton-Raphson iterations
 * @param {number} [tol=1e-8] - Convergence tolerance
 * @returns {number|null} Annualized IRR, or null if no convergence
 *
 * @example
 * // Simple investment: -100 at t=0, +150 at t=1
 * computeIRR([-100, 150]); // 0.5 (50%)
 *
 * @example
 * // Multi-year: -1000 at t=0, 200/yr for 8 years
 * computeIRR([-1000, 200, 200, 200, 200, 200, 200, 200, 200]); // ~0.1189
 */
export function computeIRR(cashFlows, guess = 0.10, maxIter = 1000, tol = 1e-8) {
  // Validate inputs
  if (!cashFlows || cashFlows.length < 2) return null;

  const hasNeg = cashFlows.some(cf => cf < 0);
  const hasPos = cashFlows.some(cf => cf > 0);
  if (!hasNeg || !hasPos) return null; // No sign change means no real IRR

  let rate = guess;

  for (let i = 0; i < maxIter; i++) {
    const fVal = npv(cashFlows, rate);
    const fPrime = npvDerivative(cashFlows, rate);

    // Derivative too small — switch to bisection
    if (Math.abs(fPrime) < 1e-15) {
      return computeIRRBisection(cashFlows);
    }

    let newRate = rate - fVal / fPrime;

    // Convergence check
    if (Math.abs(newRate - rate) < tol) {
      return newRate;
    }

    // Guard against divergence
    if (newRate < -0.99) newRate = -0.5;
    if (newRate > 10) newRate = 5;

    rate = newRate;
  }

  // Newton-Raphson didn't converge — fall back to bisection
  return computeIRRBisection(cashFlows);
}

/**
 * Compute IRR using bisection method (fallback).
 *
 * Slower but guaranteed to converge when a root exists in [lo, hi].
 *
 * @param {number[]} cashFlows
 * @param {number} [lo=-0.5] - Lower bound for rate search
 * @param {number} [hi=5.0] - Upper bound for rate search
 * @param {number} [maxIter=500] - Maximum bisection iterations
 * @param {number} [tol=1e-8] - Convergence tolerance
 * @returns {number|null} IRR or null if no root found
 */
export function computeIRRBisection(cashFlows, lo = -0.5, hi = 5.0, maxIter = 500, tol = 1e-8) {
  let fLo = npv(cashFlows, lo);
  let fHi = npv(cashFlows, hi);

  // Ensure we bracket a root
  if ((fLo > 0) === (fHi > 0)) {
    // Try wider bounds
    lo = -0.9;
    hi = 10.0;
    fLo = npv(cashFlows, lo);
    fHi = npv(cashFlows, hi);
    if ((fLo > 0) === (fHi > 0)) return null;
  }

  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(cashFlows, mid);

    if (Math.abs(fMid) < tol || (hi - lo) / 2 < tol) {
      return mid;
    }

    if ((fMid > 0) === (fLo > 0)) {
      lo = mid;
      fLo = fMid;
    } else {
      hi = mid;
    }
  }

  return (lo + hi) / 2;
}

/**
 * Compute XIRR (IRR for irregular cash flows with specific dates).
 *
 * @param {Array<{date: Date, amount: number}>} cashFlows - Dated cash flows
 * @param {number} [guess=0.10] - Initial guess
 * @param {number} [maxIter=1000] - Max iterations
 * @param {number} [tol=1e-8] - Convergence tolerance
 * @returns {number|null} Annualized IRR or null
 */
export function computeXIRR(cashFlows, guess = 0.10, maxIter = 1000, tol = 1e-8) {
  if (!cashFlows || cashFlows.length < 2) return null;

  const sorted = [...cashFlows].sort((a, b) => a.date - b.date);
  const d0 = sorted[0].date;

  // Convert dates to year fractions from first date
  const yearFracs = sorted.map(cf => (cf.date - d0) / (365.25 * 24 * 60 * 60 * 1000));
  const amounts = sorted.map(cf => cf.amount);

  function xirrNPV(rate) {
    let total = 0;
    for (let i = 0; i < amounts.length; i++) {
      total += amounts[i] / Math.pow(1 + rate, yearFracs[i]);
    }
    return total;
  }

  function xirrDeriv(rate) {
    let total = 0;
    for (let i = 0; i < amounts.length; i++) {
      total += -yearFracs[i] * amounts[i] / Math.pow(1 + rate, yearFracs[i] + 1);
    }
    return total;
  }

  let rate = guess;
  for (let i = 0; i < maxIter; i++) {
    const f = xirrNPV(rate);
    const fp = xirrDeriv(rate);
    if (Math.abs(fp) < 1e-15) break;

    let newRate = rate - f / fp;
    if (Math.abs(newRate - rate) < tol) return newRate;

    if (newRate < -0.99) newRate = -0.5;
    if (newRate > 10) newRate = 5;
    rate = newRate;
  }

  // Bisection fallback for XIRR
  let lo = -0.5, hi = 5.0;
  if ((xirrNPV(lo) > 0) === (xirrNPV(hi) > 0)) return null;

  for (let i = 0; i < 500; i++) {
    const mid = (lo + hi) / 2;
    const fMid = xirrNPV(mid);
    if (Math.abs(fMid) < tol || (hi - lo) / 2 < tol) return mid;
    if ((fMid > 0) === (xirrNPV(lo) > 0)) lo = mid;
    else hi = mid;
  }

  return (lo + hi) / 2;
}

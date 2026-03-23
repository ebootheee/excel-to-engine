/**
 * Mock "Excel" Surface — Ground Truth for Synthetic PE Model
 *
 * This represents what the REAL Excel model computes. It uses compound interest
 * for the preferred return hurdle (the correct formula), unlike the buggy engine
 * which uses simple interest.
 *
 * The difference:
 *   Engine (bug):  prefHurdle = equity * rate * years     = $100M * 0.08 * 5 = $40M
 *   Excel (correct): prefHurdle = equity * ((1+rate)^years - 1) = $100M * (1.08^5 - 1) = $46.93M
 *
 * This shifts the waterfall breakpoint:
 *   Engine: GP carry starts when exitMultiple > 1.40 (proceeds > $140M)
 *   Excel:  GP carry starts when exitMultiple > ~1.469 (proceeds > $146.93M)
 *
 * @license MIT
 */

import { extractSurface, flattenOutputs } from '../../lib/sensitivity.mjs';

/**
 * The "correct" computation (what Excel would do).
 */
function computeCorrect(inputs) {
  const {
    acquisitionPrice = 100_000_000,
    exitMultiple = 2.0,
    holdPeriodYears = 5,
    prefReturn = 0.08,
    gpCarryPercent = 0.20,
    mipThreshold = 1.5,
    mipDilution = 0.10,
  } = inputs;

  const equityBasis = acquisitionPrice;
  const grossExitValue = acquisitionPrice * exitMultiple;
  const netProceeds = grossExitValue;

  // Tier 1: Return of capital
  const returnOfCapital = Math.min(netProceeds, equityBasis);
  let remaining = netProceeds - returnOfCapital;

  // CORRECT: Compound interest for preferred return hurdle
  const prefHurdle = equityBasis * (Math.pow(1 + prefReturn, holdPeriodYears) - 1);

  // Tier 2: Preferred return (100% to LP)
  const prefDistribution = Math.min(remaining, prefHurdle);
  remaining -= prefDistribution;

  // Tier 3: Residual 80/20 LP/GP
  const gpCarry = remaining * gpCarryPercent;
  const lpResidual = remaining * (1 - gpCarryPercent);

  const lpTotal = returnOfCapital + prefDistribution + lpResidual;

  const grossMOIC = netProceeds / equityBasis;
  const netMOIC = lpTotal / equityBasis;
  const grossIRR = Math.pow(Math.max(grossMOIC, 0.001), 1 / holdPeriodYears) - 1;
  const netIRR = Math.pow(Math.max(netMOIC, 0.001), 1 / holdPeriodYears) - 1;

  const mipTriggered = grossMOIC >= mipThreshold;
  const mipPayment = mipTriggered
    ? mipDilution * Math.max(0, lpTotal - mipThreshold * equityBasis)
    : 0;

  return {
    inputs,
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

/**
 * Generate the "Excel truth" response surface.
 *
 * @param {Object} baseCaseInputs
 * @param {Object} inputConfig - { inputKey: { min, max, steps } }
 * @returns {ResponseSurface}
 */
export function generateExcelSurface(baseCaseInputs, inputConfig) {
  const surface = extractSurface(computeCorrect, baseCaseInputs, inputConfig, {
    mode: 'independent',
  });
  surface.metadata.source = 'excel';
  return surface;
}

// Also export the correct compute for direct testing
export { computeCorrect };

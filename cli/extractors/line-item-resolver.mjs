/**
 * Line-Item Resolver — Applies row-level adjustments to ground truth values.
 *
 * Given a line item ID or direct Sheet!row reference, resolves the row's
 * annual values and computes the delta from an adjustment. Handles percentage,
 * absolute, growth rate, and capitalization adjustments.
 *
 * @license MIT
 */

import { aggregateAnnual, computeGrowthRates } from './annual-aggregator.mjs';

/**
 * Resolve a line item to its annual values.
 *
 * @param {Object} gt - Ground truth
 * @param {Object} manifest - Model manifest
 * @param {string} lineItemId - ID from manifest.lineItems or "Sheet!row" format
 * @param {Object} dateResult - From detectDateColumns()
 * @returns {{ id, label, sheet, row, annual, growth }}
 */
export function resolveLineItem(gt, manifest, lineItemId, dateResult) {
  let sheet, row, label;

  // Check manifest.lineItems first
  const manifestItem = manifest.lineItems?.[lineItemId];
  if (manifestItem) {
    sheet = manifestItem.sheet;
    row = manifestItem.row;
    label = manifestItem.label;
  } else {
    // Try "Sheet!row" format (e.g., "Technology!25")
    const match = lineItemId.match(/^(.+)!(\d+)$/);
    if (!match) throw new Error(`Unknown line item: ${lineItemId}. Not in manifest.lineItems and not a "Sheet!row" reference.`);
    sheet = match[1];
    row = parseInt(match[2], 10);
    label = lineItemId;
  }

  const annual = aggregateAnnual(gt, sheet, row, dateResult, { mode: 'sum' });
  const growth = computeGrowthRates(annual);

  return { id: lineItemId, label, sheet, row, annual, growth };
}

/**
 * Compute the annual delta for a line-item adjustment.
 *
 * @param {Object} lineItem - From resolveLineItem()
 * @param {string|number} adjustment - "+50%", "-2000000", "0.40" (growth rate)
 * @param {Object} [options]
 * @param {string} [options.type='auto'] - 'percent', 'absolute', 'growth', 'auto'
 * @returns {Object} { year: deltaValue } — positive = increase, negative = decrease
 */
export function computeLineItemDelta(lineItem, adjustment, options = {}) {
  const { type: forceType } = options;
  const { annual } = lineItem;
  const adjType = forceType || detectAdjustmentType(adjustment);

  const adj = typeof adjustment === 'string' ? parseAdjustment(adjustment) : adjustment;
  const delta = {};

  switch (adjType) {
    case 'percent': {
      // Apply percentage change to each year
      for (const [year, val] of Object.entries(annual)) {
        delta[year] = val * adj;
      }
      break;
    }

    case 'absolute': {
      // Apply flat dollar change to each year
      for (const year of Object.keys(annual)) {
        delta[year] = adj;
      }
      break;
    }

    case 'growth': {
      // Override compound growth rate from base year
      const years = Object.keys(annual).map(Number).sort();
      if (years.length < 2) break;

      const baseYear = years[0];
      const baseVal = annual[baseYear];

      for (let i = 0; i < years.length; i++) {
        const newVal = baseVal * Math.pow(1 + adj, i);
        delta[years[i]] = newVal - annual[years[i]];
      }
      break;
    }

    default:
      throw new Error(`Unknown adjustment type: ${adjType}`);
  }

  return delta;
}

/**
 * Apply capitalization reclassification.
 * Moves OpEx to CapEx with amortization over N years.
 *
 * For PE (EBITDA-based valuation):
 * - EBITDA increases by the full OpEx amount each year
 * - Amortization = amount / years (reduces net income but not EBITDA)
 *
 * @param {Object} lineItem - From resolveLineItem()
 * @param {number} amortYears - Number of years to amortize
 * @returns {{ ebitdaDelta: Object, netIncomeDelta: Object, capexDelta: Object }}
 */
export function computeCapitalizationDelta(lineItem, amortYears) {
  const { annual } = lineItem;
  const ebitdaDelta = {};    // EBITDA goes UP by full amount
  const netIncomeDelta = {};  // Net income goes up by (amount - amortization)
  const capexDelta = {};      // CapEx goes up by full amount

  for (const [year, val] of Object.entries(annual)) {
    // OpEx is typically negative in the model — removing it increases EBITDA
    ebitdaDelta[year] = -val; // Removing negative expense = positive delta
    capexDelta[year] = -val;  // Same amount moved to CapEx

    // Amortization reduces the benefit slightly for net income
    const annualAmort = Math.abs(val) / amortYears;
    netIncomeDelta[year] = Math.abs(val) - annualAmort;
  }

  return { ebitdaDelta, netIncomeDelta, capexDelta };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse an adjustment string into a numeric value.
 * "+50%" → 0.50, "-2000000" → -2000000, "+2e6" → 2000000
 */
function parseAdjustment(adj) {
  if (typeof adj === 'number') return adj;
  const s = String(adj).trim();

  if (s.endsWith('%')) {
    return parseFloat(s.replace('%', '')) / 100;
  }

  return parseFloat(s);
}

/**
 * Detect adjustment type from string format.
 */
function detectAdjustmentType(adj) {
  const s = String(adj).trim();
  if (s.endsWith('%')) return 'percent';
  if (s.startsWith('+') || s.startsWith('-')) return 'absolute';
  // If it's a small decimal (0-1 range), treat as growth rate
  const n = parseFloat(s);
  if (!isNaN(n) && Math.abs(n) <= 1) return 'growth';
  return 'absolute';
}

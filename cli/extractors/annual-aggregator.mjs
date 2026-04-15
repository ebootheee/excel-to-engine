/**
 * Annual Aggregator — Aggregates monthly/quarterly data into annual buckets.
 *
 * Given a sheet, row, and date column mapping, reads ground truth values
 * and aggregates by year. Supports sum (for flows), last (for balances),
 * and average aggregation modes.
 *
 * @license MIT
 */

import { getYearColumns } from './date-detector.mjs';

/**
 * Aggregate a single row into annual values.
 *
 * @param {Object} gt - Ground truth {addr: value}
 * @param {string} sheet - Sheet name
 * @param {number} row - Row number
 * @param {Object} dateResult - From detectDateColumns()
 * @param {Object} [options]
 * @param {string} [options.mode='sum'] - 'sum' | 'last' | 'avg'
 * @param {number} [options.startYear]
 * @param {number} [options.endYear]
 * @returns {Object} { year: aggregatedValue }
 */
export function aggregateAnnual(gt, sheet, row, dateResult, options = {}) {
  const { mode = 'sum', startYear, endYear } = options;
  const yearCols = getYearColumns(dateResult, startYear, endYear);
  const result = {};

  for (const [yearStr, cols] of Object.entries(yearCols)) {
    const year = parseInt(yearStr, 10);
    const values = [];

    for (const col of cols) {
      const addr = `${sheet}!${col}${row}`;
      const val = gt[addr];
      if (typeof val === 'number') {
        values.push(val);
      }
    }

    if (values.length === 0) continue;

    switch (mode) {
      case 'sum':
        result[year] = values.reduce((a, b) => a + b, 0);
        break;
      case 'last':
        result[year] = values[values.length - 1];
        break;
      case 'avg':
        result[year] = values.reduce((a, b) => a + b, 0) / values.length;
        break;
      default:
        result[year] = values.reduce((a, b) => a + b, 0);
    }
  }

  return result;
}

/**
 * Aggregate a row into quarterly values.
 *
 * @param {Object} gt - Ground truth
 * @param {string} sheet - Sheet name
 * @param {number} row - Row number
 * @param {Object} dateResult - From detectDateColumns() (must be monthly periodicity)
 * @param {Object} [options]
 * @param {string} [options.mode='sum']
 * @returns {Object} { "YYYY-Q1": value, "YYYY-Q2": value, ... }
 */
export function aggregateQuarterly(gt, sheet, row, dateResult, options = {}) {
  const { mode = 'sum' } = options;
  const { columnMap } = dateResult;
  const quarters = {};

  for (const [col, period] of Object.entries(columnMap)) {
    if (typeof period !== 'string' || !period.includes('-')) continue;

    const [yearStr, monthStr] = period.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    const q = Math.ceil(month / 3);
    const qKey = `${year}-Q${q}`;

    if (!quarters[qKey]) quarters[qKey] = [];

    const addr = `${sheet}!${col}${row}`;
    const val = gt[addr];
    if (typeof val === 'number') {
      quarters[qKey].push(val);
    }
  }

  const result = {};
  for (const [qKey, values] of Object.entries(quarters)) {
    if (values.length === 0) continue;
    switch (mode) {
      case 'sum': result[qKey] = values.reduce((a, b) => a + b, 0); break;
      case 'last': result[qKey] = values[values.length - 1]; break;
      case 'avg': result[qKey] = values.reduce((a, b) => a + b, 0) / values.length; break;
      default: result[qKey] = values.reduce((a, b) => a + b, 0);
    }
  }

  return result;
}

/**
 * Compute year-over-year growth rates from annual data.
 *
 * @param {Object} annualData - { year: value }
 * @returns {Object} { year: growthRate } (e.g., { 2026: 0.15 } means +15%)
 */
export function computeGrowthRates(annualData) {
  const years = Object.keys(annualData).map(Number).sort();
  const rates = {};

  for (let i = 1; i < years.length; i++) {
    const prev = annualData[years[i - 1]];
    const curr = annualData[years[i]];
    if (prev && prev !== 0) {
      rates[years[i]] = (curr - prev) / Math.abs(prev);
    }
  }

  return rates;
}

/**
 * Compute CAGR between two years.
 */
export function computeCAGR(startValue, endValue, years) {
  if (!startValue || startValue === 0 || years === 0) return null;
  return Math.pow(endValue / startValue, 1 / years) - 1;
}

/**
 * Aggregate multiple segments into a combined annual P&L.
 *
 * @param {Object} gt - Ground truth
 * @param {Array} segments - From manifest.segments
 * @param {Object} dateResult - From detectDateColumns()
 * @param {Object} [options]
 * @returns {Object} { segments: { id: { annual, growth } }, totals: { ebitda, revenue, expense } }
 */
export function aggregateSegmentPnL(gt, segments, dateResult, options = {}) {
  const { startYear, endYear } = options;
  const result = { segments: {} };
  const revByYear = {};
  const expByYear = {};

  for (const seg of segments) {
    const mode = seg.aggregation === 'annual_last' ? 'last'
      : seg.aggregation === 'annual_avg' ? 'avg' : 'sum';

    const annual = aggregateAnnual(gt, seg.sheet, seg.row, dateResult, {
      mode, startYear, endYear,
    });

    const growth = computeGrowthRates(annual);

    result.segments[seg.id] = { ...seg, annual, growth };

    // Accumulate totals
    for (const [year, val] of Object.entries(annual)) {
      const y = parseInt(year, 10);
      if (seg.type === 'revenue' || seg.type === 'profit') {
        revByYear[y] = (revByYear[y] || 0) + val;
      }
      if (seg.type === 'expense') {
        expByYear[y] = (expByYear[y] || 0) + val;
      }
    }
  }

  // Compute EBITDA = revenue - |expense| (expense values may already be negative)
  const ebitdaByYear = {};
  const allYears = new Set([...Object.keys(revByYear), ...Object.keys(expByYear)].map(Number));
  for (const y of allYears) {
    ebitdaByYear[y] = (revByYear[y] || 0) + (expByYear[y] || 0); // expense usually negative
  }

  result.totals = {
    revenue: revByYear,
    expense: expByYear,
    ebitda: ebitdaByYear,
    ebitdaGrowth: computeGrowthRates(ebitdaByYear),
  };

  return result;
}

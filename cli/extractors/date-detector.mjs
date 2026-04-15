/**
 * Date Detector — Maps spreadsheet columns to time periods.
 *
 * Scans ground truth for date/year values in a header row,
 * maps each column to a (year, month) tuple, identifies periodicity,
 * and returns column ranges per year for aggregation.
 *
 * @license MIT
 */

/**
 * Detect date columns from ground truth.
 *
 * Strategy:
 * 1. If manifest provides dateRow/dateSheet, scan that row
 * 2. Otherwise, scan rows 1-20 across all sheets for year-like values
 *
 * @param {Object} gt - Ground truth {addr: value}
 * @param {Object} [options]
 * @param {string} [options.sheet] - Specific sheet to scan
 * @param {number} [options.row] - Specific row to scan
 * @returns {{ columnMap: Object, yearRanges: Object, periodicity: string }}
 */
export function detectDateColumns(gt, options = {}) {
  const { sheet: targetSheet, row: targetRow } = options;

  if (targetSheet && targetRow) {
    return scanRow(gt, targetSheet, targetRow);
  }

  // Auto-detect: scan rows 1-20 across sheets
  const candidates = [];
  const sheetRows = {};

  for (const [addr, val] of Object.entries(gt)) {
    const bang = addr.lastIndexOf('!');
    if (bang < 0) continue;
    const sheet = addr.substring(0, bang);
    if (targetSheet && sheet !== targetSheet) continue;

    const cellPart = addr.substring(bang + 1);
    const match = cellPart.match(/^([A-Z]+)(\d+)$/);
    if (!match) continue;

    const row = parseInt(match[2], 10);
    if (row > 20) continue;

    const key = `${sheet}!${row}`;
    if (!sheetRows[key]) sheetRows[key] = { sheet, row, values: {} };

    // Check for year-like integers
    if (typeof val === 'number' && val >= 2015 && val <= 2045 && val === Math.floor(val)) {
      sheetRows[key].values[match[1]] = { type: 'year', value: val };
    }
    // Check for Excel serial dates (2020-2040 range: ~43831 to ~51500)
    if (typeof val === 'number' && val >= 43000 && val <= 55000 && val === Math.floor(val)) {
      const date = excelSerialToDate(val);
      if (date) {
        sheetRows[key].values[match[1]] = { type: 'date', value: val, year: date.year, month: date.month };
      }
    }
  }

  // Score each candidate row
  for (const [key, data] of Object.entries(sheetRows)) {
    const cols = Object.values(data.values);
    if (cols.length < 3) continue;

    const years = cols.filter(c => c.type === 'year').map(c => c.value);
    const dates = cols.filter(c => c.type === 'date');

    let score = cols.length;
    // Bonus for sequential years
    const sorted = [...new Set(years)].sort();
    let sequential = 0;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === sorted[i - 1] + 1) sequential++;
    }
    score += sequential * 2;

    // Bonus for dates (more granular = better timeline)
    score += dates.length;

    candidates.push({ ...data, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length === 0) {
    return { columnMap: {}, yearRanges: {}, periodicity: 'unknown' };
  }

  return scanRow(gt, candidates[0].sheet, candidates[0].row);
}

/**
 * Scan a specific row for date/year values and build the column map.
 */
function scanRow(gt, sheet, row) {
  const columnMap = {};  // col -> year or "YYYY-MM"
  const rawValues = {};  // col -> raw value

  for (const [addr, val] of Object.entries(gt)) {
    if (!addr.startsWith(sheet + '!')) continue;
    const cellPart = addr.substring(addr.lastIndexOf('!') + 1);
    const match = cellPart.match(/^([A-Z]+)(\d+)$/);
    if (!match || parseInt(match[2], 10) !== row) continue;

    const col = match[1];

    if (typeof val === 'number' && val >= 2015 && val <= 2045 && val === Math.floor(val)) {
      columnMap[col] = val;
      rawValues[col] = val;
    } else if (typeof val === 'number' && val >= 43000 && val <= 55000) {
      const date = excelSerialToDate(val);
      if (date) {
        columnMap[col] = `${date.year}-${String(date.month).padStart(2, '0')}`;
        rawValues[col] = val;
      }
    }
  }

  // Determine periodicity
  const periods = Object.values(columnMap);
  let periodicity = 'unknown';
  if (periods.length > 0) {
    const hasMonths = periods.some(p => typeof p === 'string' && p.includes('-'));
    if (hasMonths) {
      // Check gap between consecutive months
      const months = periods.filter(p => typeof p === 'string').sort();
      if (months.length >= 2) {
        const gap = monthDiff(months[0], months[1]);
        if (gap === 1) periodicity = 'monthly';
        else if (gap === 3) periodicity = 'quarterly';
        else if (gap === 6) periodicity = 'semi_annual';
        else if (gap === 12) periodicity = 'annual';
      }
    } else {
      periodicity = 'annual';
    }
  }

  // Build year ranges (which columns belong to which year)
  const yearRanges = {};
  for (const [col, period] of Object.entries(columnMap)) {
    const year = typeof period === 'number' ? period : parseInt(period.substring(0, 4), 10);
    if (!yearRanges[year]) yearRanges[year] = [];
    yearRanges[year].push(col);
  }

  // Sort columns within each year
  for (const cols of Object.values(yearRanges)) {
    cols.sort(compareColumns);
  }

  return { columnMap, yearRanges, periodicity, sheet, row };
}

/**
 * Convert Excel serial date to { year, month, day }.
 */
function excelSerialToDate(serial) {
  // Excel's epoch is 1900-01-01, but it incorrectly includes 1900-02-29
  const epoch = new Date(1899, 11, 30); // Dec 30, 1899
  const date = new Date(epoch.getTime() + serial * 86400000);
  if (isNaN(date.getTime())) return null;
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

/**
 * Compare column letters (A < B < ... < Z < AA < AB ...).
 */
function compareColumns(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compute month difference between two "YYYY-MM" strings.
 */
function monthDiff(a, b) {
  const [y1, m1] = a.split('-').map(Number);
  const [y2, m2] = b.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
}

/**
 * Get column ranges for annual aggregation given a date detection result.
 * @param {Object} dateResult - From detectDateColumns()
 * @param {number} [startYear]
 * @param {number} [endYear]
 * @returns {Object} { year: [col, col, ...] }
 */
export function getYearColumns(dateResult, startYear, endYear) {
  const { yearRanges } = dateResult;
  const result = {};
  for (const [yearStr, cols] of Object.entries(yearRanges)) {
    const year = parseInt(yearStr, 10);
    if (startYear && year < startYear) continue;
    if (endYear && year > endYear) continue;
    result[year] = cols;
  }
  return result;
}

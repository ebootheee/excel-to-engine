/**
 * Segment Detector — Identifies revenue/expense segments and line items.
 *
 * Scans ground truth label columns for financial terms using the same
 * 50+ alias list from lib/excel-parser.mjs. Groups consecutive labeled
 * rows into segments and detects subsegment detail.
 *
 * @license MIT
 */

import { matchFinancialLabel } from '../../lib/manifest.mjs';

/**
 * Detect segments within a sheet by scanning label columns.
 *
 * @param {Object} gt - Ground truth {addr: value}
 * @param {string} sheet - Sheet name to scan
 * @param {Object} [options]
 * @param {string[]} [options.labelCols=['A','B','C']] - Columns to scan for labels
 * @param {number} [options.minRow=1]
 * @param {number} [options.maxRow=200]
 * @returns {Array<{ id, label, type, sheet, row, confidence, children }>}
 */
export function detectSheetSegments(gt, sheet, options = {}) {
  const { labelCols = ['A', 'B', 'C'], minRow = 1, maxRow = 200 } = options;

  // Collect all labels in the sheet
  const labels = [];
  for (let row = minRow; row <= maxRow; row++) {
    for (const col of labelCols) {
      const addr = `${sheet}!${col}${row}`;
      const val = gt[addr];
      if (typeof val === 'string' && val.trim().length > 1) {
        const match = matchFinancialLabel(val);
        labels.push({
          row,
          col,
          addr,
          text: val.trim(),
          field: match ? match.field : null,
          confidence: match ? match.confidence : 0,
        });
        break; // Use first label column that has a value for this row
      }
    }
  }

  // Identify segments — rows with revenue/expense/ebitda labels
  const segments = [];
  for (const label of labels) {
    if (!label.field) continue;
    if (!['revenue', 'expense', 'ebitda'].includes(label.field)) continue;

    // Check if this row has numeric values (not just a header)
    const hasData = hasNumericData(gt, sheet, label.row);
    if (!hasData) continue;

    const type = label.field === 'ebitda' ? 'profit' : label.field;
    const id = label.text.toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 30);

    segments.push({
      id,
      label: label.text,
      type,
      sheet,
      row: label.row,
      confidence: label.confidence,
      aggregation: 'annual_sum',
    });
  }

  return segments;
}

/**
 * Detect line items (detail rows) within a subsegment sheet.
 *
 * @param {Object} gt - Ground truth
 * @param {string} sheet - Sheet name
 * @param {Object} [options]
 * @param {number} [options.startRow=1]
 * @param {number} [options.endRow=100]
 * @returns {Array<{ id, label, sheet, row, type, parentSegment }>}
 */
export function detectLineItems(gt, sheet, options = {}) {
  const { startRow = 1, endRow = 100, labelCols = ['A', 'B', 'C'] } = options;
  const items = [];

  for (let row = startRow; row <= endRow; row++) {
    let labelText = null;
    for (const col of labelCols) {
      const addr = `${sheet}!${col}${row}`;
      const val = gt[addr];
      if (typeof val === 'string' && val.trim().length > 1) {
        labelText = val.trim();
        break;
      }
    }
    if (!labelText) continue;
    if (!hasNumericData(gt, sheet, row)) continue;

    // Classify as revenue or expense by label
    const match = matchFinancialLabel(labelText);
    const type = match?.field === 'revenue' || match?.field === 'arr' ? 'revenue'
      : match?.field === 'expense' || match?.field === 'headcount' || match?.field === 'rent' || match?.field === 'capex' ? 'expense'
        : 'other';

    const id = labelText.toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 30);

    items.push({
      id,
      label: labelText,
      sheet,
      row,
      type,
    });
  }

  return items;
}

/**
 * Detect all segments across all sheets in a model.
 *
 * @param {Object} gt - Ground truth
 * @returns {Object} { segments, subsegments, lineItems }
 */
export function detectAllSegments(gt) {
  // Find all sheets
  const sheets = new Set();
  for (const addr of Object.keys(gt)) {
    const bang = addr.lastIndexOf('!');
    if (bang > 0) sheets.add(addr.substring(0, bang));
  }

  const allSegments = [];
  const allLineItems = {};

  for (const sheet of sheets) {
    const segments = detectSheetSegments(gt, sheet);
    allSegments.push(...segments);

    // For sheets with multiple detail rows, detect line items
    const items = detectLineItems(gt, sheet);
    if (items.length >= 3) {
      allLineItems[sheet] = items;
    }
  }

  return { segments: allSegments, lineItemsBySheet: allLineItems };
}

/**
 * Check if a row has numeric data in non-label columns.
 */
function hasNumericData(gt, sheet, row) {
  // Check columns D through Z for numeric values
  const dataCols = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  for (const col of dataCols) {
    const addr = `${sheet}!${col}${row}`;
    const val = gt[addr];
    if (typeof val === 'number' && val !== 0) return true;
  }
  return false;
}

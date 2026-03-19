/**
 * excel-to-engine — Excel Reader Utilities
 *
 * Provides functions to read cells, ranges, and detect input/output
 * cells from Excel workbooks using the xlsx (SheetJS) library.
 *
 * Requires: npm install xlsx
 *
 * @license MIT
 */

import XLSX from 'xlsx';

// ---------------------------------------------------------------------------
// Cell Reading
// ---------------------------------------------------------------------------

/**
 * Read a single cell value from a workbook.
 *
 * @param {Object} workbook - XLSX workbook object
 * @param {string} sheetName - Sheet name (e.g., "Summary")
 * @param {string} cellRef - Cell reference (e.g., "B12")
 * @returns {{ value: *, formula: string|null, type: string }}
 *
 * @example
 * const wb = XLSX.readFile('model.xlsx');
 * const cell = readCell(wb, 'Summary', 'B12');
 * // { value: 2.15, formula: null, type: 'number' }
 */
export function readCell(workbook, sheetName, cellRef) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new Error(`Sheet "${sheetName}" not found. Available: ${workbook.SheetNames.join(', ')}`);
  }

  const cell = sheet[cellRef];
  if (!cell) {
    return { value: null, formula: null, type: 'empty' };
  }

  return {
    value: cell.v,
    formula: cell.f || null,
    type: cellTypeToString(cell.t),
  };
}

/**
 * Read a rectangular range of cells.
 *
 * @param {Object} workbook - XLSX workbook object
 * @param {string} sheetName - Sheet name
 * @param {string} startCell - Top-left cell (e.g., "A1")
 * @param {string} endCell - Bottom-right cell (e.g., "D10")
 * @returns {Array<Array<{ value: *, formula: string|null, type: string }>>}
 */
export function readRange(workbook, sheetName, startCell, endCell) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new Error(`Sheet "${sheetName}" not found.`);
  }

  const startDecoded = XLSX.utils.decode_cell(startCell);
  const endDecoded = XLSX.utils.decode_cell(endCell);
  const rows = [];

  for (let r = startDecoded.r; r <= endDecoded.r; r++) {
    const row = [];
    for (let c = startDecoded.c; c <= endDecoded.c; c++) {
      const ref = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[ref];
      row.push(cell
        ? { value: cell.v, formula: cell.f || null, type: cellTypeToString(cell.t) }
        : { value: null, formula: null, type: 'empty' }
      );
    }
    rows.push(row);
  }

  return rows;
}

/**
 * Read an entire column of values (useful for time series / cash flows).
 *
 * @param {Object} workbook
 * @param {string} sheetName
 * @param {string} colLetter - Column letter (e.g., "C")
 * @param {number} startRow - First row (1-based)
 * @param {number} endRow - Last row (1-based)
 * @returns {Array<{ row: number, value: *, formula: string|null }>}
 */
export function readColumn(workbook, sheetName, colLetter, startRow, endRow) {
  const results = [];
  for (let row = startRow; row <= endRow; row++) {
    const ref = `${colLetter}${row}`;
    const cell = readCell(workbook, sheetName, ref);
    results.push({ row, ...cell });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Cell Detection
// ---------------------------------------------------------------------------

/**
 * Detect input cells in a workbook.
 *
 * An input cell is one that:
 * - Has a value (not empty)
 * - Has no formula
 * - Is referenced by at least one formula in the workbook
 *
 * @param {Object} workbook - XLSX workbook object
 * @param {Object} [options={}]
 * @param {string[]} [options.sheets] - Limit to specific sheets. Default: all
 * @param {boolean} [options.namedRangesOnly=false] - Only return named ranges
 * @returns {Array<{ sheet: string, cell: string, value: *, type: string, name: string|null, referencedBy: number }>}
 */
export function detectInputCells(workbook, options = {}) {
  const { sheets, namedRangesOnly = false } = options;
  const targetSheets = sheets || workbook.SheetNames;

  // Build map of named ranges for labeling
  const namedRangeMap = buildNamedRangeMap(workbook);

  // First pass: collect all formula references
  const referenceCounts = new Map(); // "Sheet!Cell" -> count

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const range = sheet['!ref'];
    if (!range) continue;

    const decoded = XLSX.utils.decode_range(range);
    for (let r = decoded.s.r; r <= decoded.e.r; r++) {
      for (let c = decoded.s.c; c <= decoded.e.c; c++) {
        const ref = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[ref];
        if (!cell?.f) continue;

        // Extract cell references from formula
        const refs = extractCellReferences(cell.f, sheetName);
        for (const fullRef of refs) {
          referenceCounts.set(fullRef, (referenceCounts.get(fullRef) || 0) + 1);
        }
      }
    }
  }

  // Second pass: find value-only cells that are referenced
  const inputs = [];

  for (const sheetName of targetSheets) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const range = sheet['!ref'];
    if (!range) continue;

    const decoded = XLSX.utils.decode_range(range);
    for (let r = decoded.s.r; r <= decoded.e.r; r++) {
      for (let c = decoded.s.c; c <= decoded.e.c; c++) {
        const ref = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[ref];

        // Skip empty cells and formula cells
        if (!cell || cell.v == null || cell.f) continue;

        // Skip non-numeric values (strings, booleans usually aren't model inputs)
        if (cell.t !== 'n') continue;

        const fullRef = `${sheetName}!${ref}`;
        const refCount = referenceCounts.get(fullRef) || 0;

        if (refCount === 0) continue; // Not referenced by any formula

        const name = namedRangeMap.get(fullRef) || null;
        if (namedRangesOnly && !name) continue;

        inputs.push({
          sheet: sheetName,
          cell: ref,
          value: cell.v,
          type: cellTypeToString(cell.t),
          name,
          referencedBy: refCount,
        });
      }
    }
  }

  // Sort by reference count (most-referenced first)
  inputs.sort((a, b) => b.referencedBy - a.referencedBy);

  return inputs;
}

/**
 * Detect output cells in a workbook.
 *
 * An output cell is one that:
 * - Has a formula
 * - Is NOT referenced by other formulas (end of a calculation chain)
 * - Has a numeric result
 *
 * These are typically the "answers" — MOIC, IRR, total returns, etc.
 *
 * @param {Object} workbook - XLSX workbook object
 * @param {Object} [options={}]
 * @param {string[]} [options.sheets] - Limit to specific sheets. Default: all
 * @param {string[]} [options.excludePatterns] - Formula patterns to exclude (e.g., formatting)
 * @returns {Array<{ sheet: string, cell: string, value: *, formula: string, name: string|null }>}
 */
export function detectOutputCells(workbook, options = {}) {
  const { sheets, excludePatterns = [] } = options;
  const targetSheets = sheets || workbook.SheetNames;
  const namedRangeMap = buildNamedRangeMap(workbook);

  // Build set of all referenced cells
  const referencedCells = new Set();

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const range = sheet['!ref'];
    if (!range) continue;

    const decoded = XLSX.utils.decode_range(range);
    for (let r = decoded.s.r; r <= decoded.e.r; r++) {
      for (let c = decoded.s.c; c <= decoded.e.c; c++) {
        const ref = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[ref];
        if (!cell?.f) continue;

        const refs = extractCellReferences(cell.f, sheetName);
        for (const fullRef of refs) {
          referencedCells.add(fullRef);
        }
      }
    }
  }

  // Find formula cells that are NOT referenced
  const outputs = [];

  for (const sheetName of targetSheets) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const range = sheet['!ref'];
    if (!range) continue;

    const decoded = XLSX.utils.decode_range(range);
    for (let r = decoded.s.r; r <= decoded.e.r; r++) {
      for (let c = decoded.s.c; c <= decoded.e.c; c++) {
        const ref = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[ref];

        // Must have a formula and a numeric result
        if (!cell?.f || cell.t !== 'n') continue;

        const fullRef = `${sheetName}!${ref}`;
        if (referencedCells.has(fullRef)) continue; // Referenced — it's intermediate

        // Check exclude patterns
        const excluded = excludePatterns.some(p => cell.f.includes(p));
        if (excluded) continue;

        outputs.push({
          sheet: sheetName,
          cell: ref,
          value: cell.v,
          formula: cell.f,
          name: namedRangeMap.get(fullRef) || null,
        });
      }
    }
  }

  return outputs;
}

/**
 * Detect intermediate calculation cells.
 *
 * These are cells with formulas that ARE referenced by other formulas.
 * Useful for understanding the calculation chain and debugging.
 *
 * @param {Object} workbook
 * @param {Object} [options={}]
 * @param {string[]} [options.sheets]
 * @returns {Array<{ sheet: string, cell: string, value: *, formula: string }>}
 */
export function detectIntermediateCells(workbook, options = {}) {
  const { sheets } = options;
  const targetSheets = sheets || workbook.SheetNames;

  // Build set of all referenced cells
  const referencedCells = new Set();
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const range = sheet['!ref'];
    if (!range) continue;

    const decoded = XLSX.utils.decode_range(range);
    for (let r = decoded.s.r; r <= decoded.e.r; r++) {
      for (let c = decoded.s.c; c <= decoded.e.c; c++) {
        const ref = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[ref];
        if (!cell?.f) continue;
        const refs = extractCellReferences(cell.f, sheetName);
        for (const fullRef of refs) {
          referencedCells.add(fullRef);
        }
      }
    }
  }

  const intermediates = [];
  for (const sheetName of targetSheets) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const range = sheet['!ref'];
    if (!range) continue;

    const decoded = XLSX.utils.decode_range(range);
    for (let r = decoded.s.r; r <= decoded.e.r; r++) {
      for (let c = decoded.s.c; c <= decoded.e.c; c++) {
        const ref = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[ref];
        if (!cell?.f) continue;

        const fullRef = `${sheetName}!${ref}`;
        if (!referencedCells.has(fullRef)) continue; // Not referenced — it's output

        intermediates.push({
          sheet: sheetName,
          cell: ref,
          value: cell.v,
          formula: cell.f,
        });
      }
    }
  }

  return intermediates;
}

/**
 * Build a complete model map from a workbook.
 *
 * Analyzes the entire workbook and produces a structured map of all
 * inputs, outputs, intermediates, and detected financial patterns.
 *
 * @param {Object} workbook - XLSX workbook object
 * @param {Object} [options={}]
 * @param {string[]} [options.inputSheets] - Sheets to scan for inputs
 * @param {string[]} [options.outputSheets] - Sheets to scan for outputs
 * @returns {Object} Model map suitable for JSON serialization
 */
export function buildModelMap(workbook, options = {}) {
  const inputs = detectInputCells(workbook, { sheets: options.inputSheets });
  const outputs = detectOutputCells(workbook, { sheets: options.outputSheets });
  const intermediates = detectIntermediateCells(workbook);

  // Detect financial patterns
  const patterns = detectFinancialPatterns(workbook);

  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    sheets: workbook.SheetNames,
    inputs: inputs.map(inp => ({
      name: inp.name || inferCellName(workbook, inp.sheet, inp.cell),
      sheet: inp.sheet,
      cell: inp.cell,
      type: inp.type,
      baseCase: inp.value,
      range: inferInputRange(inp.value),
      referencedBy: inp.referencedBy,
    })),
    outputs: outputs.map(out => ({
      name: out.name || inferCellName(workbook, out.sheet, out.cell),
      sheet: out.sheet,
      cell: out.cell,
      type: 'number',
      baseCase: out.value,
      formula: out.formula,
    })),
    intermediateCount: intermediates.length,
    patterns,
  };
}

// ---------------------------------------------------------------------------
// Financial Pattern Detection
// ---------------------------------------------------------------------------

/**
 * Detect common financial patterns in the workbook.
 *
 * @param {Object} workbook
 * @returns {Object} Detected patterns
 */
export function detectFinancialPatterns(workbook) {
  const patterns = {
    hasIRR: false,
    hasMOIC: false,
    hasDCF: false,
    hasWaterfall: false,
    hasSensitivity: false,
    hasCashFlowTimeline: false,
    details: [],
  };

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const range = sheet['!ref'];
    if (!range) continue;

    const decoded = XLSX.utils.decode_range(range);
    for (let r = decoded.s.r; r <= decoded.e.r; r++) {
      for (let c = decoded.s.c; c <= decoded.e.c; c++) {
        const ref = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[ref];
        if (!cell?.f) continue;

        const formula = cell.f.toUpperCase();

        if (formula.includes('IRR') || formula.includes('XIRR')) {
          patterns.hasIRR = true;
          patterns.details.push({ type: 'IRR', sheet: sheetName, cell: ref, formula: cell.f });
        }
        if (formula.includes('NPV') || formula.includes('XNPV')) {
          patterns.hasDCF = true;
          patterns.details.push({ type: 'DCF', sheet: sheetName, cell: ref, formula: cell.f });
        }
      }
    }

    // Check sheet names for pattern clues
    const nameLower = sheetName.toLowerCase();
    if (nameLower.includes('waterfall') || nameLower.includes('distribution')) {
      patterns.hasWaterfall = true;
    }
    if (nameLower.includes('sensitivity') || nameLower.includes('scenario')) {
      patterns.hasSensitivity = true;
    }
    if (nameLower.includes('cash flow') || nameLower.includes('cashflow') || nameLower.includes('cf ')) {
      patterns.hasCashFlowTimeline = true;
    }
  }

  return patterns;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert XLSX cell type code to readable string.
 */
function cellTypeToString(t) {
  switch (t) {
    case 'n': return 'number';
    case 's': return 'string';
    case 'b': return 'boolean';
    case 'e': return 'error';
    case 'd': return 'date';
    default: return 'unknown';
  }
}

/**
 * Extract cell references from a formula string.
 * Returns fully qualified references like "Sheet1!A1".
 */
function extractCellReferences(formula, currentSheet) {
  const refs = [];
  // Match patterns like Sheet1!A1, 'Sheet Name'!A1, A1, $A$1
  const regex = /(?:(?:'[^']+'|[A-Za-z0-9_]+)!)?\$?[A-Z]{1,3}\$?\d{1,7}/g;
  let match;

  while ((match = regex.exec(formula)) !== null) {
    let fullRef = match[0].replace(/\$/g, ''); // Strip $ signs
    if (!fullRef.includes('!')) {
      fullRef = `${currentSheet}!${fullRef}`;
    } else {
      // Clean up quoted sheet names
      fullRef = fullRef.replace(/'/g, '');
    }
    refs.push(fullRef);
  }

  return refs;
}

/**
 * Build a map from "Sheet!Cell" -> named range name.
 */
function buildNamedRangeMap(workbook) {
  const map = new Map();
  if (!workbook.Workbook?.Names) return map;

  for (const name of workbook.Workbook.Names) {
    if (!name.Ref) continue;
    // Ref format: "Sheet1!$A$1" or "'Sheet Name'!$A$1"
    const cleaned = name.Ref.replace(/\$/g, '').replace(/'/g, '');
    map.set(cleaned, name.Name);
  }

  return map;
}

/**
 * Try to infer a human-readable name for a cell by looking at adjacent labels.
 */
function inferCellName(workbook, sheetName, cellRef) {
  const sheet = workbook.Sheets[sheetName];
  const decoded = XLSX.utils.decode_cell(cellRef);

  // Check cell to the left
  if (decoded.c > 0) {
    const leftRef = XLSX.utils.encode_cell({ r: decoded.r, c: decoded.c - 1 });
    const leftCell = sheet[leftRef];
    if (leftCell?.t === 's' && leftCell.v) {
      return leftCell.v.trim();
    }
  }

  // Check cell above
  if (decoded.r > 0) {
    const aboveRef = XLSX.utils.encode_cell({ r: decoded.r - 1, c: decoded.c });
    const aboveCell = sheet[aboveRef];
    if (aboveCell?.t === 's' && aboveCell.v) {
      return aboveCell.v.trim();
    }
  }

  // Fallback: use cell reference
  return `${sheetName}_${cellRef}`;
}

/**
 * Infer a reasonable input range based on the base case value.
 * Returns [min, max] where min = 50% of base, max = 200% of base.
 */
function inferInputRange(value) {
  if (value === 0) return [-1, 1];
  if (value > 0) return [value * 0.5, value * 2.0];
  return [value * 2.0, value * 0.5]; // Negative values: flip
}

/**
 * Load and parse an Excel file from disk.
 *
 * @param {string} filePath - Path to .xlsx file
 * @param {Object} [options={}] - XLSX read options
 * @returns {Object} XLSX workbook object
 */
export function loadWorkbook(filePath, options = {}) {
  return XLSX.readFile(filePath, {
    cellFormula: true,
    cellStyles: false,
    ...options,
  });
}

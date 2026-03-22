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

// ---------------------------------------------------------------------------
// Sheet Structure Fingerprinting
// ---------------------------------------------------------------------------

/**
 * Common financial row labels and their canonical field names.
 * Used by fingerprinting and fuzzy label matching.
 */
const LABEL_ALIASES = {
  revenue: [
    'total revenue', 'revenue', 'gross revenue', 'net revenue',
    'total income', 'income', 'sales', 'net sales', 'turnover',
    'gross income', 'operating revenue',
  ],
  opex: [
    'total opex', 'opex', 'operating expenses', 'total operating expenses',
    'total expenses', 'operating costs', 'total costs',
    'total opex (pre-ground rent)', 'opex (pre-ground rent)',
  ],
  ebitda: [
    'ebitda', 'ebitdar', 'net operating income', 'noi',
    'operating profit', 'operating income',
    'net parking ebitdar', 'net parking ebitdar (pre-ground rent)',
    'consolidated ebitdar', 'consolidated ebitdar (pre-ground rent)',
    'ebitdar (post-ground rent)', 'ebitdar (pre-ground rent)',
  ],
  rent: [
    'rent', 'ground rent', 'total ground rent', 'net rent',
    'lease rent', 'ncp lease rent', 'net ncp lease rent',
    'base rent', 'annual rent', 'total rent',
    'fixed rent', 'turnover rent',
  ],
  rentCover: [
    'rent coverage', 'rent coverage ratio', 'rent cover',
    'coverage ratio', 'dscr', 'debt service coverage',
  ],
  purchasePrice: [
    'purchase price', 'acquisition price', 'cost',
    'total cost', 'investment', 'equity invested',
    'total investment', 'acquisition cost',
  ],
  exitValue: [
    'exit value', 'gross exit value', 'terminal value',
    'exit proceeds', 'disposition value', 'sale price',
    'gross exit', 'exit valuation',
  ],
  irr: [
    'irr', 'internal rate of return', 'gross irr', 'net irr',
    'levered irr', 'unlevered irr', 'unlev irr', 'lev irr',
  ],
  moic: [
    'moic', 'moc', 'multiple', 'equity multiple',
    'money multiple', 'return multiple', 'total multiple',
    'gross moic', 'net moic', 'gross multiple', 'net multiple',
  ],
  cashFlow: [
    'cash flow', 'net cash flow', 'free cash flow', 'fcf',
    'cash flow from operations', 'operating cash flow',
  ],
  capex: [
    'capex', 'capital expenditure', 'capital expenditures',
    'total capex', 'maintenance capex', 'growth capex',
  ],
  year: [
    'year', 'period', 'date', 'fiscal year', 'fy',
    'calendar year', 'cy',
  ],
};

/**
 * Fuzzy-match a label string to a canonical field name.
 *
 * @param {string} label - The label text from the Excel sheet
 * @returns {{ field: string, confidence: number }|null} Match result or null
 */
export function matchLabel(label) {
  if (!label || typeof label !== 'string') return null;
  const normalized = label.toLowerCase().trim();

  // Exact match first
  for (const [field, aliases] of Object.entries(LABEL_ALIASES)) {
    if (aliases.includes(normalized)) {
      return { field, confidence: 1.0 };
    }
  }

  // Substring match — label contains an alias or alias contains label
  for (const [field, aliases] of Object.entries(LABEL_ALIASES)) {
    for (const alias of aliases) {
      if (normalized.includes(alias) || alias.includes(normalized)) {
        const overlap = Math.min(normalized.length, alias.length) / Math.max(normalized.length, alias.length);
        if (overlap > 0.4) {
          return { field, confidence: Math.round(overlap * 100) / 100 };
        }
      }
    }
  }

  return null;
}

/**
 * Scan a sheet's label column(s) and build a row-to-field mapping.
 *
 * Examines columns A and B for text labels, matches them against known
 * financial terms, and produces a sheetMap like:
 *   { revenue: { row: 48, label: "Total Revenue" }, ebitda: { row: 67 }, ... }
 *
 * @param {Object} workbook - XLSX workbook object
 * @param {string} sheetName - Sheet name to fingerprint
 * @param {Object} [options={}]
 * @param {string[]} [options.labelColumns=['A','B']] - Columns to scan for labels
 * @returns {Object} Map of canonical field names to { row, label, column, confidence }
 */
export function fingerprintSheet(workbook, sheetName, options = {}) {
  const { labelColumns = ['A', 'B'] } = options;
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return {};

  const range = sheet['!ref'];
  if (!range) return {};
  const decoded = XLSX.utils.decode_range(range);

  const fieldMap = {};

  for (let r = decoded.s.r; r <= decoded.e.r; r++) {
    for (const colLetter of labelColumns) {
      const colIndex = XLSX.utils.decode_col(colLetter);
      const ref = XLSX.utils.encode_cell({ r, c: colIndex });
      const cell = sheet[ref];

      if (!cell || cell.t !== 's') continue;
      const label = String(cell.v).trim();
      if (!label) continue;

      const match = matchLabel(label);
      if (!match) continue;

      // Keep the highest-confidence match per field
      if (!fieldMap[match.field] || match.confidence > fieldMap[match.field].confidence) {
        fieldMap[match.field] = {
          row: r + 1, // 1-based row number
          label,
          column: colLetter,
          confidence: match.confidence,
        };
      }
    }
  }

  return fieldMap;
}

/**
 * Fingerprint all sheets and find common row patterns across identically-structured sheets.
 *
 * @param {Object} workbook - XLSX workbook object
 * @param {Object} [options={}]
 * @param {string[]} [options.labelColumns] - Columns to scan
 * @param {number} [options.minSheets=2] - Minimum sheets sharing a pattern to report
 * @returns {{ sheetMaps: Object, commonPattern: Object, sheetGroups: Object[] }}
 */
export function fingerprintWorkbook(workbook, options = {}) {
  const { minSheets = 2 } = options;
  const sheetMaps = {};

  for (const sheetName of workbook.SheetNames) {
    sheetMaps[sheetName] = fingerprintSheet(workbook, sheetName, options);
  }

  // Group sheets by their row pattern signature
  const signatureGroups = {};
  for (const [sheetName, fieldMap] of Object.entries(sheetMaps)) {
    const fields = Object.keys(fieldMap).sort();
    if (fields.length === 0) continue;
    const sig = fields.map(f => `${f}:${fieldMap[f].row}`).join('|');
    if (!signatureGroups[sig]) signatureGroups[sig] = [];
    signatureGroups[sig].push(sheetName);
  }

  // Find the most common pattern
  let commonPattern = {};
  let commonSheets = [];
  for (const [sig, sheets] of Object.entries(signatureGroups)) {
    if (sheets.length >= minSheets && sheets.length > commonSheets.length) {
      commonSheets = sheets;
      // Reconstruct pattern from first sheet in group
      commonPattern = sheetMaps[sheets[0]];
    }
  }

  // Build structured groups
  const sheetGroups = Object.entries(signatureGroups)
    .filter(([, sheets]) => sheets.length >= minSheets)
    .map(([, sheets]) => ({
      sheets,
      pattern: sheetMaps[sheets[0]],
      count: sheets.length,
    }))
    .sort((a, b) => b.count - a.count);

  return { sheetMaps, commonPattern, commonSheets, sheetGroups };
}

// ---------------------------------------------------------------------------
// Year Detection & Multi-Year Extraction
// ---------------------------------------------------------------------------

/**
 * Auto-detect the year row and map column indices to calendar years.
 *
 * Scans a sheet for a row containing sequential year values (e.g., 2023, 2024, 2025).
 * Returns the row index and a column-to-year mapping.
 *
 * @param {Object} workbook - XLSX workbook object
 * @param {string} sheetName - Sheet name
 * @param {Object} [options={}]
 * @param {number} [options.minYear=2015] - Minimum valid year
 * @param {number} [options.maxYear=2045] - Maximum valid year
 * @param {number} [options.minConsecutive=2] - Minimum consecutive years to detect
 * @returns {{ yearRow: number, columnMap: Object<string, number>, years: number[] }|null}
 */
export function detectYearRow(workbook, sheetName, options = {}) {
  const { minYear = 2015, maxYear = 2045, minConsecutive = 2 } = options;
  const sheet = workbook.Sheets[sheetName];
  if (!sheet || !sheet['!ref']) return null;

  const decoded = XLSX.utils.decode_range(sheet['!ref']);

  for (let r = decoded.s.r; r <= decoded.e.r; r++) {
    const yearCols = [];

    for (let c = decoded.s.c; c <= decoded.e.c; c++) {
      const ref = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[ref];
      if (!cell || cell.t !== 'n') continue;

      const val = cell.v;
      if (val >= minYear && val <= maxYear && Number.isInteger(val)) {
        yearCols.push({ col: c, year: val });
      }
    }

    // Check for consecutive years
    if (yearCols.length < minConsecutive) continue;

    yearCols.sort((a, b) => a.col - b.col);
    let consecutiveCount = 1;
    for (let i = 1; i < yearCols.length; i++) {
      if (yearCols[i].year === yearCols[i - 1].year + 1) {
        consecutiveCount++;
      }
    }

    if (consecutiveCount >= minConsecutive) {
      const columnMap = {};
      for (const { col, year } of yearCols) {
        const colLetter = XLSX.utils.encode_col(col);
        columnMap[colLetter] = year;
      }
      return {
        yearRow: r + 1, // 1-based
        columnMap,
        years: yearCols.map(yc => yc.year),
      };
    }
  }

  return null;
}

/**
 * Extract values for a specific field across all available years.
 *
 * Given a sheet fingerprint (row mapping) and year column mapping, reads
 * the value at each year column for a given field.
 *
 * @param {Object} workbook - XLSX workbook object
 * @param {string} sheetName - Sheet name
 * @param {number} fieldRow - 1-based row number of the field
 * @param {Object} columnMap - Column letter to year mapping (from detectYearRow)
 * @returns {Object<number, number>} Year to value mapping (e.g., { 2024: 1500000, 2025: 1600000 })
 */
export function extractMultiYear(workbook, sheetName, fieldRow, columnMap) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return {};

  const values = {};
  for (const [colLetter, year] of Object.entries(columnMap)) {
    const ref = `${colLetter}${fieldRow}`;
    const cell = sheet[ref];
    if (cell && cell.t === 'n') {
      values[year] = cell.v;
    }
  }
  return values;
}

/**
 * Extract all fields from a sheet for a given reference year.
 *
 * Uses fingerprinting to find field rows and year detection to find the
 * column for the target year.
 *
 * @param {Object} workbook - XLSX workbook object
 * @param {string} sheetName - Sheet name
 * @param {number} referenceYear - Target year to extract (e.g., 2026)
 * @param {Object} [options={}]
 * @param {Object} [options.fieldMap] - Pre-computed fingerprint (skip re-scan)
 * @param {Object} [options.yearInfo] - Pre-computed year detection (skip re-scan)
 * @returns {{ fields: Object, referenceYear: number, yearColumn: string|null }}
 */
export function extractByYear(workbook, sheetName, referenceYear, options = {}) {
  const fieldMap = options.fieldMap || fingerprintSheet(workbook, sheetName);
  const yearInfo = options.yearInfo || detectYearRow(workbook, sheetName);

  if (!yearInfo) {
    return { fields: {}, referenceYear, yearColumn: null };
  }

  // Find the column for the reference year
  let yearColumn = null;
  for (const [col, year] of Object.entries(yearInfo.columnMap)) {
    if (year === referenceYear) {
      yearColumn = col;
      break;
    }
  }

  if (!yearColumn) {
    // Fallback to latest available year
    const maxYear = Math.max(...yearInfo.years);
    for (const [col, year] of Object.entries(yearInfo.columnMap)) {
      if (year === maxYear) {
        yearColumn = col;
        break;
      }
    }
  }

  const sheet = workbook.Sheets[sheetName];
  const fields = {};

  for (const [field, info] of Object.entries(fieldMap)) {
    if (!yearColumn) continue;
    const ref = `${yearColumn}${info.row}`;
    const cell = sheet?.[ref];
    fields[field] = {
      value: cell?.t === 'n' ? cell.v : null,
      row: info.row,
      column: yearColumn,
      label: info.label,
    };
  }

  return { fields, referenceYear, yearColumn };
}

// ---------------------------------------------------------------------------
// Escalation Detection
// ---------------------------------------------------------------------------

/**
 * Detect escalation rates by comparing adjacent year values for a field.
 *
 * Useful for spotting rent escalations, revenue growth, etc.
 *
 * @param {Object} yearValues - Year-to-value map (from extractMultiYear)
 * @returns {{ rates: Object<string, number>, avgRate: number, isEscalating: boolean }}
 */
export function detectEscalation(yearValues) {
  const years = Object.keys(yearValues).map(Number).sort();
  const rates = {};

  for (let i = 1; i < years.length; i++) {
    const prev = yearValues[years[i - 1]];
    const curr = yearValues[years[i]];
    if (prev && prev !== 0) {
      rates[`${years[i - 1]}-${years[i]}`] = (curr - prev) / prev;
    }
  }

  const rateValues = Object.values(rates);
  const avgRate = rateValues.length > 0
    ? rateValues.reduce((a, b) => a + b, 0) / rateValues.length
    : 0;

  return {
    rates,
    avgRate: Math.round(avgRate * 10000) / 10000,
    isEscalating: Math.abs(avgRate) > 0.005, // >0.5% considered escalating
  };
}

// ---------------------------------------------------------------------------
// Asset Classification
// ---------------------------------------------------------------------------

/**
 * Auto-classify an asset based on metadata heuristics.
 *
 * Uses presence/absence of rent, management fees, operator names, and
 * type flags to determine asset classification (e.g., leased vs managed).
 *
 * @param {Object} assetData - Object with extracted field values
 * @param {Object} [options={}]
 * @param {string[]} [options.leasedIndicators] - Labels indicating leased status
 * @param {string[]} [options.managedIndicators] - Labels indicating managed status
 * @returns {{ classification: string, confidence: number, signals: string[] }}
 */
export function classifyAsset(assetData, options = {}) {
  const {
    leasedIndicators = ['ncp', 'lease', 'leased', 'tenant', 'operator'],
    managedIndicators = ['managed', 'self-managed', 'direct', 'in-house'],
  } = options;

  const signals = [];
  let leasedScore = 0;
  let managedScore = 0;

  // Check for rent presence
  if (assetData.rent && assetData.rent.value && assetData.rent.value > 0) {
    leasedScore += 2;
    signals.push('has positive rent → leased');
  } else if (assetData.rent && (assetData.rent.value === 0 || assetData.rent.value == null)) {
    managedScore += 2;
    signals.push('zero/no rent → managed');
  }

  // Check for rent coverage ratio
  if (assetData.rentCover && assetData.rentCover.value && assetData.rentCover.value > 0) {
    leasedScore += 1;
    signals.push('has rent coverage ratio → leased');
  }

  // Check all label text for leased/managed indicators
  for (const fieldData of Object.values(assetData)) {
    if (!fieldData?.label) continue;
    const labelLower = fieldData.label.toLowerCase();
    for (const ind of leasedIndicators) {
      if (labelLower.includes(ind)) {
        leasedScore += 0.5;
        signals.push(`label "${fieldData.label}" contains "${ind}" → leased`);
        break;
      }
    }
    for (const ind of managedIndicators) {
      if (labelLower.includes(ind)) {
        managedScore += 0.5;
        signals.push(`label "${fieldData.label}" contains "${ind}" → managed`);
        break;
      }
    }
  }

  const totalScore = leasedScore + managedScore;
  if (totalScore === 0) {
    return { classification: 'unknown', confidence: 0, signals: ['no classification signals found'] };
  }

  if (leasedScore > managedScore) {
    return {
      classification: 'leased',
      confidence: Math.round((leasedScore / totalScore) * 100) / 100,
      signals,
    };
  } else if (managedScore > leasedScore) {
    return {
      classification: 'managed',
      confidence: Math.round((managedScore / totalScore) * 100) / 100,
      signals,
    };
  }

  return { classification: 'mixed', confidence: 0.5, signals };
}

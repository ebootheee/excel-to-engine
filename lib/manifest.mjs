/**
 * excel-to-engine — Model Manifest Library
 *
 * Schema definition, auto-generation, validation, and cell resolvers
 * for model manifests. A manifest maps generic financial concepts
 * (EBITDA, exit multiple, carry tiers) to specific cells/rows in
 * a parsed model's ground truth.
 *
 * @license MIT
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';

// ---------------------------------------------------------------------------
// Schema Constants
// ---------------------------------------------------------------------------

export const MANIFEST_VERSION = 'manifest-v1.0';

export const MODEL_TYPES = [
  'pe_fund', 'pe_platform', 're_fund', 'saas', 'venture_portfolio', 'three_statement', 'unknown',
];

export const AGGREGATION_MODES = ['annual_sum', 'annual_last', 'annual_avg'];

export const SEGMENT_TYPES = ['revenue', 'expense', 'profit', 'other'];

export const VALUATION_METRICS = ['ebitda', 'revenue', 'noi', 'earnings', 'fcf'];

// ---------------------------------------------------------------------------
// Field Value Ranges — shared by auto-gen and refinement
//
// Value-range validation ensures that an auto-detected cell actually looks
// like the thing it claims to be. Without this, a row whose label says
// "Equity Basis" but whose first numeric is `5` (a label artifact, a
// multiplier, or an enum code) gets written to manifest and cascades into
// garbage MOIC/IRR. Enforced on both initial detection and refinement.
// ---------------------------------------------------------------------------

export const FIELD_RANGES = {
  basisCell:       { min: 1e6,   max: 50e9,  label: 'equity basis (>=$1M)' },
  terminalValue:   { min: 1e6,   max: 100e9, label: 'terminal value (>=$1M)' },
  carryTotal:      { min: 0,     max: 10e9,  label: 'total carry' },
  exitMultiple:    { min: 1,     max: 50,    label: 'exit multiple (1-50x)' },
  capRate:         { min: 0.01,  max: 0.30,  label: 'cap rate (1%-30%)' },
  grossIRR:        { min: -0.5,  max: 2,     label: 'IRR (-50% to 200%)' },
  netIRR:          { min: -0.5,  max: 2,     label: 'IRR (-50% to 200%)' },
  grossMOIC:       { min: 0.1,   max: 20,    label: 'MOIC (0.1x-20x)' },
  netMOIC:         { min: 0.1,   max: 20,    label: 'MOIC (0.1x-20x)' },
  prefReturn:      { min: 0,     max: 0.50,  label: 'pref return (0-50%)' },
  wacc:            { min: 0,     max: 0.30,  label: 'discount rate (0-30%)' },
  exitDebt:        { min: 0,     max: 100e9, label: 'debt balance' },
  sharesOutstanding: { min: 1,   max: 1e12,  label: 'shares outstanding' },
  pricePerShare:   { min: 0.01,  max: 1e6,   label: 'price per share' },
};

/**
 * Check whether a numeric value falls within the expected range for a field.
 * Returns true if no range is defined for the field (opt-in validation).
 */
export function inFieldRange(field, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  const range = FIELD_RANGES[field];
  if (!range) return true;
  return value >= range.min && value <= range.max;
}

/**
 * Convert a spreadsheet column letter (A, B, ..., Z, AA, AB, ...) to a 1-based index.
 */
export function colToNum(col) {
  let n = 0;
  for (let i = 0; i < col.length; i++) {
    n = n * 26 + (col.charCodeAt(i) - 64);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Label Aliases (shared with excel-parser.mjs canonical terms)
// ---------------------------------------------------------------------------

const LABEL_ALIASES = {
  revenue: ['revenue', 'sales', 'income', 'top line', 'gross revenue', 'net revenue', 'total revenue'],
  expense: ['expense', 'cost', 'opex', 'operating expense', 'sga', 'sg&a', 'cogs', 'cost of goods'],
  ebitda: ['ebitda', 'ebitdar', 'noi', 'net operating income', 'operating profit', 'operating income'],
  irr: ['irr', 'internal rate of return', 'gross irr', 'net irr', 'levered irr', 'unlevered irr'],
  moic: ['moic', 'multiple', 'money multiple', 'gross moic', 'net moic', 'tvpi', 'dpi'],
  carry: ['carry', 'carried interest', 'promote', 'gp carry', 'gp promote', 'incentive', 'performance fee'],
  equity: ['equity', 'equity invested', 'equity basis', 'committed', 'capital committed', 'total invested', 'equity drawn'],
  debt: ['debt', 'loan', 'leverage', 'borrowings', 'credit facility', 'senior debt', 'mezzanine'],
  terminal: ['terminal value', 'exit value', 'enterprise value', 'ev', 'total enterprise value'],
  multiple: ['exit multiple', 'ebitda multiple', 'cap rate', 'revenue multiple', 'ev/ebitda', 'ev/revenue'],
  pref: ['preferred return', 'pref', 'hurdle', 'hurdle rate', 'preferred', 'pref return'],
  distribution: ['distribution', 'distributions', 'lp distributions', 'cash distribution', 'dividend'],
  headcount: ['headcount', 'personnel', 'fte', 'employees', 'staff', 'labor', 'salaries', 'wages', 'compensation'],
  rent: ['rent', 'ground rent', 'base rent', 'net rent', 'lease', 'rental income'],
  capex: ['capex', 'capital expenditure', 'capital expenditures', 'pp&e', 'fixed assets'],
  arr: ['arr', 'annual recurring revenue', 'mrr', 'monthly recurring revenue', 'recurring revenue'],
  shares: ['shares', 'shares outstanding', 'units', 'per share', 'per unit', 'price per share'],
  wacc: ['wacc', 'discount rate', 'cost of capital', 'weighted average cost of capital'],
};

// ---------------------------------------------------------------------------
// Manifest Loading / Saving
// ---------------------------------------------------------------------------

/**
 * Load a manifest from a model directory.
 * Looks for manifest.json in the directory root or in chunked/.
 */
export function loadManifest(modelDir) {
  const candidates = [
    join(modelDir, 'manifest.json'),
    join(modelDir, 'chunked', 'manifest.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, 'utf-8'));
    }
  }
  throw new Error(`No manifest.json found in ${modelDir}. Run: ete manifest generate ${modelDir}`);
}

/**
 * Load ground truth from the path specified in the manifest.
 */
export function loadGroundTruth(manifest, modelDir) {
  const gtPath = manifest.model.groundTruth.startsWith('.')
    ? join(modelDir, manifest.model.groundTruth)
    : manifest.model.groundTruth;
  if (!existsSync(gtPath)) {
    throw new Error(`Ground truth not found: ${gtPath}`);
  }
  return JSON.parse(readFileSync(gtPath, 'utf-8'));
}

// ---------------------------------------------------------------------------
// Cell Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a single cell reference from ground truth.
 * @param {Object} gt - Ground truth {addr: value}
 * @param {string} cellRef - e.g., "Valuation!AA53"
 * @returns {*} Cell value or undefined
 */
export function resolveCell(gt, cellRef) {
  return gt[cellRef];
}

/**
 * Resolve a row of cells across date columns for a given sheet+row.
 * @param {Object} gt - Ground truth
 * @param {string} sheet - Sheet name
 * @param {number} row - Row number
 * @param {Object} columnMap - { colLetter: "YYYY-MM" or year }
 * @returns {Object} { year: value } or { "YYYY-MM": value }
 */
export function resolveAnnualRow(gt, sheet, row, columnMap) {
  const result = {};
  for (const [col, period] of Object.entries(columnMap)) {
    const addr = `${sheet}!${col}${row}`;
    const val = gt[addr];
    if (val !== undefined && typeof val === 'number') {
      result[period] = val;
    }
  }
  return result;
}

/**
 * Resolve all metrics for an equity class from the manifest.
 */
export function resolveEquityClass(gt, equityClass) {
  const metrics = {};
  for (const [key, cellRef] of Object.entries(equityClass)) {
    if (key === 'id' || key === 'label') continue;
    if (typeof cellRef === 'string' && cellRef.includes('!')) {
      metrics[key] = resolveCell(gt, cellRef);
    }
  }
  return { id: equityClass.id, label: equityClass.label, ...metrics };
}

/**
 * Resolve base case output values from the manifest + ground truth.
 */
export function resolveBaseCaseOutputs(manifest, gt) {
  const outputs = {};

  // Exit EBITDA
  if (manifest.outputs?.ebitda?.exitValue) {
    outputs.exitEBITDA = resolveCell(gt, manifest.outputs.ebitda.exitValue);
  }

  // Terminal value
  if (manifest.outputs?.terminalValue?.cell) {
    outputs.terminalValue = resolveCell(gt, manifest.outputs.terminalValue.cell);
  }

  // Exit multiple
  if (manifest.outputs?.exitMultiple?.cell) {
    outputs.exitMultiple = resolveCell(gt, manifest.outputs.exitMultiple.cell);
  }

  // Equity classes
  if (manifest.equity?.classes) {
    for (const ec of manifest.equity.classes) {
      const prefix = manifest.equity.classes.length === 1 ? '' : `${ec.id}.`;
      if (ec.grossMOIC) outputs[`${prefix}grossMOIC`] = resolveCell(gt, ec.grossMOIC);
      if (ec.grossIRR) outputs[`${prefix}grossIRR`] = resolveCell(gt, ec.grossIRR);
      if (ec.netMOIC) outputs[`${prefix}netMOIC`] = resolveCell(gt, ec.netMOIC);
      if (ec.netIRR) outputs[`${prefix}netIRR`] = resolveCell(gt, ec.netIRR);
      if (ec.basisCell) outputs[`${prefix}equityBasis`] = resolveCell(gt, ec.basisCell);
    }
  }

  // Carry
  if (manifest.carry?.totalCell) {
    outputs.totalCarry = resolveCell(gt, manifest.carry.totalCell);
  }

  // Debt
  if (manifest.debt?.exitBalance) {
    outputs.exitDebt = resolveCell(gt, manifest.debt.exitBalance);
  }
  if (manifest.debt?.exitCash) {
    outputs.exitCash = resolveCell(gt, manifest.debt.exitCash);
  }

  // Custom cells
  if (manifest.customCells) {
    for (const [key, cellRef] of Object.entries(manifest.customCells)) {
      if (typeof cellRef === 'string' && cellRef.includes('!')) {
        outputs[key] = resolveCell(gt, cellRef);
      }
    }
  }

  return outputs;
}

// ---------------------------------------------------------------------------
// Label Matching
// ---------------------------------------------------------------------------

/**
 * Match a text label against known financial aliases.
 * @param {string} text - Label text from a cell
 * @returns {{ field: string, confidence: number } | null}
 */
export function matchFinancialLabel(text) {
  if (!text || typeof text !== 'string') return null;
  const lower = text.toLowerCase().trim();
  if (!lower) return null;

  for (const [field, aliases] of Object.entries(LABEL_ALIASES)) {
    for (const alias of aliases) {
      if (lower === alias) return { field, confidence: 1.0 };
      if (lower.includes(alias)) return { field, confidence: 0.7 };
    }
  }
  return null;
}

/**
 * Search ground truth for cells matching a label pattern.
 * Returns matching labels with adjacent numeric values.
 */
export function searchByLabel(gt, pattern, options = {}) {
  const { sheet: filterSheet, maxResults = 50 } = options;
  const regex = new RegExp(pattern, 'i');
  const matches = [];

  for (const [addr, value] of Object.entries(gt)) {
    if (typeof value !== 'string') continue;
    if (!regex.test(value)) continue;

    const [sheetCell] = addr.split('!');
    const sheet = addr.substring(0, addr.lastIndexOf('!'));
    if (filterSheet && sheet !== filterSheet) continue;

    const cellPart = addr.substring(addr.lastIndexOf('!') + 1);
    const colMatch = cellPart.match(/^([A-Z]+)(\d+)$/);
    if (!colMatch) continue;

    const col = colMatch[1];
    const row = parseInt(colMatch[2], 10);

    // Look for numeric values in adjacent columns on the same row
    const adjacentValues = [];
    for (const [aAddr, aVal] of Object.entries(gt)) {
      if (typeof aVal !== 'number') continue;
      if (!aAddr.startsWith(sheet + '!')) continue;
      const aCellPart = aAddr.substring(aAddr.lastIndexOf('!') + 1);
      const aMatch = aCellPart.match(/^([A-Z]+)(\d+)$/);
      if (!aMatch) continue;
      if (parseInt(aMatch[2], 10) !== row) continue;
      adjacentValues.push({ col: aMatch[1], addr: aAddr, value: aVal });
    }

    matches.push({
      label: value,
      labelCell: addr,
      sheet,
      col,
      row,
      values: adjacentValues.slice(0, 20), // limit to 20 columns
    });

    if (matches.length >= maxResults) break;
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Manifest Validation
// ---------------------------------------------------------------------------

/**
 * Validate a manifest against its ground truth.
 * Checks that all referenced cells exist and values are reasonable.
 */
export function validateManifest(manifest, gt) {
  const errors = [];
  const warnings = [];

  // Check schema version
  if (manifest.$schema !== MANIFEST_VERSION) {
    warnings.push(`Schema version: expected ${MANIFEST_VERSION}, got ${manifest.$schema}`);
  }

  // Check ground truth references
  const cellRefs = collectCellRefs(manifest);
  for (const { path, ref } of cellRefs) {
    const val = resolveCell(gt, ref);
    if (val === undefined) {
      errors.push(`Cell not found: ${ref} (from manifest.${path})`);
    }
  }

  // Check segments have valid rows
  for (const seg of manifest.segments || []) {
    if (!seg.sheet || !seg.row) {
      errors.push(`Segment "${seg.id}" missing sheet or row`);
    }
  }

  // Check equity class metrics are numeric
  for (const ec of manifest.equity?.classes || []) {
    for (const key of ['grossMOIC', 'grossIRR', 'netMOIC', 'netIRR']) {
      if (!ec[key]) continue;
      const val = resolveCell(gt, ec[key]);
      if (val !== undefined && typeof val !== 'number') {
        warnings.push(`${ec.id}.${key} (${ec[key]}) = "${val}" — expected numeric`);
      }
    }
    // Check MOIC/IRR ranges
    const moic = resolveCell(gt, ec.grossMOIC);
    if (typeof moic === 'number' && (moic < 0 || moic > 50)) {
      warnings.push(`${ec.id}.grossMOIC = ${moic} — outside expected range [0, 50]`);
    }
    const irr = resolveCell(gt, ec.grossIRR);
    if (typeof irr === 'number' && (irr < -1 || irr > 10)) {
      warnings.push(`${ec.id}.grossIRR = ${irr} — outside expected range [-1, 10]`);
    }
  }

  // Check base case outputs match ground truth
  if (manifest.baseCaseOutputs) {
    const resolved = resolveBaseCaseOutputs(manifest, gt);
    for (const [key, expected] of Object.entries(manifest.baseCaseOutputs)) {
      const actual = resolved[key];
      if (actual === undefined) continue;
      if (typeof expected === 'number' && typeof actual === 'number') {
        const pctDiff = expected !== 0 ? Math.abs(actual - expected) / Math.abs(expected) : Math.abs(actual - expected);
        if (pctDiff > 0.005) {
          warnings.push(`baseCaseOutputs.${key}: manifest=${expected}, groundTruth=${actual} (${(pctDiff * 100).toFixed(2)}% diff)`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    cellRefsChecked: cellRefs.length,
  };
}

/**
 * Collect all cell references from a manifest for validation.
 */
function collectCellRefs(manifest) {
  const refs = [];

  function walk(obj, path) {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, val] of Object.entries(obj)) {
      const fullPath = path ? `${path}.${key}` : key;
      if (typeof val === 'string' && val.includes('!') && /^[^!]+![A-Z]+\d+$/.test(val)) {
        refs.push({ path: fullPath, ref: val });
      } else if (typeof val === 'object' && !Array.isArray(val)) {
        walk(val, fullPath);
      } else if (Array.isArray(val)) {
        val.forEach((item, i) => walk(item, `${fullPath}[${i}]`));
      }
    }
  }

  walk(manifest, '');
  return refs;
}

// ---------------------------------------------------------------------------
// Model Type Detection
// ---------------------------------------------------------------------------

/**
 * Detect model type from ground truth labels.
 */
export function detectModelType(gt) {
  const allLabels = [];
  for (const [addr, val] of Object.entries(gt)) {
    if (typeof val === 'string' && val.length > 2 && val.length < 100) {
      allLabels.push(val.toLowerCase());
    }
  }
  const text = allLabels.join(' ');

  const signals = {
    pe_fund: 0,
    pe_platform: 0,
    re_fund: 0,
    saas: 0,
    venture_portfolio: 0,
    three_statement: 0,
  };

  // PE signals
  if (/carried interest|promote|gp carry/i.test(text)) signals.pe_fund += 3;
  if (/equity basis|capital committed|drawn/i.test(text)) signals.pe_fund += 2;
  if (/waterfall|hurdle rate|preferred return/i.test(text)) signals.pe_fund += 2;

  // Platform signals (PE with operating companies)
  if (/platform|segment|business unit/i.test(text)) signals.pe_platform += 3;
  if (/technology.*revenue|operations.*revenue/i.test(text)) signals.pe_platform += 2;
  if (signals.pe_fund > 3) signals.pe_platform += signals.pe_fund; // platforms are also PE

  // RE signals
  if (/noi|cap rate|occupancy|rent roll|tenant/i.test(text)) signals.re_fund += 3;
  if (/ground rent|lease|property/i.test(text)) signals.re_fund += 2;

  // SaaS signals
  if (/arr|mrr|churn|net retention|recurring revenue/i.test(text)) signals.saas += 3;
  if (/cac|ltv|payback|cohort/i.test(text)) signals.saas += 2;

  // Venture signals
  if (/portfolio company|vintage|follow-on|markup/i.test(text)) signals.venture_portfolio += 3;
  if (/series [a-f]|seed|pre-seed|bridge/i.test(text)) signals.venture_portfolio += 2;

  // 3-statement signals
  if (/balance sheet|income statement|cash flow statement/i.test(text)) signals.three_statement += 3;
  if (/retained earnings|accounts receivable|accounts payable/i.test(text)) signals.three_statement += 2;

  const sorted = Object.entries(signals).sort((a, b) => b[1] - a[1]);
  return sorted[0][1] > 0 ? sorted[0][0] : 'unknown';
}

// ---------------------------------------------------------------------------
// Manifest Auto-Generation
// ---------------------------------------------------------------------------

/**
 * Generate a draft manifest from ground truth.
 * Heuristic pattern matching — deterministic, no LLM.
 *
 * @param {Object} gt - Ground truth {addr: value}
 * @param {Object} options
 * @param {string} [options.groundTruthPath] - Relative path to GT file
 * @param {string} [options.engineDir] - Relative path to engine dir
 * @param {string} [options.source] - Original Excel filename
 * @returns {{ manifest: Object, confidence: Object, reviewChecklist: string[] }}
 */
export function generateManifest(gt, options = {}) {
  const confidence = {};
  const checklist = [];

  // Detect model type
  const modelType = detectModelType(gt);
  confidence.modelType = modelType === 'unknown' ? 0.3 : 0.7;

  // Detect sheets
  const sheets = new Set();
  for (const addr of Object.keys(gt)) {
    const bang = addr.lastIndexOf('!');
    if (bang > 0) sheets.add(addr.substring(0, bang));
  }

  // Detect date columns
  const { timeline, timelineConfidence } = detectTimeline(gt, sheets);
  confidence.timeline = timelineConfidence;
  if (timelineConfidence < 0.6) {
    checklist.push('REVIEW: Date column detection low confidence — verify timeline.dateRow and columnMap');
  }

  // Detect segments (time-series-aware when timeline detected)
  const { segments, segConfidence } = detectSegments(gt, sheets, timeline);
  confidence.segments = segConfidence;
  if (segments.length === 0) {
    checklist.push('REVIEW: No revenue/expense segments detected — add manually');
  }

  // Detect outputs
  const { outputs, outputConfidence } = detectOutputs(gt, sheets);
  confidence.outputs = outputConfidence;
  if (!outputs.ebitda) {
    checklist.push('REVIEW: No EBITDA/NOI output detected — add outputs.ebitda manually');
  }

  // Detect equity
  const { equity, equityConfidence } = detectEquity(gt, sheets);
  confidence.equity = equityConfidence;
  if (!equity.classes || equity.classes.length === 0) {
    checklist.push('REVIEW: No equity classes detected — add equity.classes manually');
  }

  // Detect carry
  const { carry, carryConfidence } = detectCarry(gt, sheets);
  confidence.carry = carryConfidence;

  // Detect debt
  const { debt, debtConfidence } = detectDebt(gt, sheets);
  confidence.debt = debtConfidence;

  // Detect custom cells
  const customCells = detectCustomCells(gt, sheets);

  // Detect stacked scenario blocks (same label pattern repeating on a sheet).
  // This is common on PE promote/carry sheets that stack 5+ scenarios on one
  // tab — rows 1-92 then 93-184 etc. all carry the same label template.
  const scenarioBlocks = detectScenarioBlocks(gt, sheets);

  // Build manifest
  const manifest = {
    $schema: MANIFEST_VERSION,
    model: {
      name: options.source ? options.source.replace(/\.xlsx?$/i, '') : 'Untitled Model',
      type: modelType,
      source: options.source || 'unknown.xlsx',
      generatedAt: new Date().toISOString(),
      groundTruth: options.groundTruthPath || './_ground-truth.json',
      engineDir: options.engineDir || './',
    },
    timeline,
    segments,
    outputs,
    equity,
    carry,
    debt,
    lineItems: {},
    subsegments: {},
    customCells,
    scenarioBlocks,
  };

  // Resolve base case outputs
  manifest.baseCaseOutputs = resolveBaseCaseOutputs(manifest, gt);

  return { manifest, confidence, reviewChecklist: checklist };
}

// ---------------------------------------------------------------------------
// Detection helpers (heuristic, deterministic)
// ---------------------------------------------------------------------------

function detectTimeline(gt, sheets) {
  // Look for rows with sequential year-like values (2020-2035)
  const yearPatterns = {};

  for (const [addr, val] of Object.entries(gt)) {
    if (typeof val !== 'number') continue;
    if (val < 2015 || val > 2040 || val !== Math.floor(val)) continue;

    const bang = addr.lastIndexOf('!');
    const sheet = addr.substring(0, bang);
    const cellPart = addr.substring(bang + 1);
    const match = cellPart.match(/^([A-Z]+)(\d+)$/);
    if (!match) continue;

    const row = parseInt(match[2], 10);
    const key = `${sheet}!row${row}`;
    if (!yearPatterns[key]) yearPatterns[key] = { sheet, row, years: {} };
    yearPatterns[key].years[match[1]] = val;
  }

  // Find the row with the most sequential years
  let bestKey = null;
  let bestCount = 0;
  for (const [key, data] of Object.entries(yearPatterns)) {
    const years = Object.values(data.years).sort();
    let sequential = 1;
    for (let i = 1; i < years.length; i++) {
      if (years[i] === years[i - 1] + 1) sequential++;
    }
    if (sequential > bestCount) {
      bestCount = sequential;
      bestKey = key;
    }
  }

  if (!bestKey || bestCount < 3) {
    return {
      timeline: { dateRow: null, dateSheet: null, investmentYear: null, exitYear: null, periodicity: 'unknown', columnMap: {} },
      timelineConfidence: 0.2,
    };
  }

  const best = yearPatterns[bestKey];
  const years = Object.values(best.years).sort();
  const columnMap = {};
  for (const [col, year] of Object.entries(best.years)) {
    columnMap[col] = year;
  }

  return {
    timeline: {
      dateRow: best.row,
      dateSheet: best.sheet,
      investmentYear: years[0],
      exitYear: years[years.length - 1],
      exitYearRange: [Math.max(years[0] + 3, years[years.length - 1] - 3), years[years.length - 1] + 3],
      periodicity: bestCount >= 8 ? 'annual' : 'monthly', // rough heuristic
      columnMap,
    },
    timelineConfidence: bestCount >= 5 ? 0.9 : 0.6,
  };
}

function detectSegments(gt, sheets, timeline) {
  const segments = [];
  const seen = new Set();

  // Timeline columns give us the per-year cells to inspect. If the detector
  // ran without a timeline (e.g., unit tests), fall back to skipping the
  // time-series check.
  const yearCols = timeline?.columnMap ? Object.keys(timeline.columnMap) : null;

  for (const [addr, val] of Object.entries(gt)) {
    if (typeof val !== 'string') continue;
    const matched = matchFinancialLabel(val);
    if (!matched) continue;
    if (matched.field !== 'revenue' && matched.field !== 'expense' && matched.field !== 'ebitda') continue;

    const bang = addr.lastIndexOf('!');
    const sheet = addr.substring(0, bang);
    const cellPart = addr.substring(bang + 1);
    const rowMatch = cellPart.match(/^([A-Z]+)(\d+)$/);
    if (!rowMatch) continue;

    const row = parseInt(rowMatch[2], 10);
    const segKey = `${sheet}:${row}`;
    if (seen.has(segKey)) continue;
    seen.add(segKey);

    // Time-series check: when we know the year columns, require the row to
    // vary across them. Rows where every year is the same value are almost
    // always scalar assumption placeholders, not real P&L streams (this is
    // what produced "30 segments of $94K repeats" on the Outpost models).
    if (yearCols) {
      const seriesValues = [];
      for (const col of yearCols) {
        const v = gt[`${sheet}!${col}${row}`];
        if (typeof v === 'number') seriesValues.push(v);
      }
      if (seriesValues.length < 3) continue; // too sparse to be a time series
      const min = Math.min(...seriesValues);
      const max = Math.max(...seriesValues);
      // Reject constant rows (degenerate), keep rows where max > min * 1.001
      if (max === 0 && min === 0) continue;
      const denom = Math.max(Math.abs(max), Math.abs(min));
      if (denom > 0 && Math.abs(max - min) / denom < 0.001) continue;
    }

    const type = matched.field === 'ebitda' ? 'profit' : matched.field;
    const id = val.toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 30);

    segments.push({
      id,
      label: val.trim(),
      type,
      sheet,
      row,
      aggregation: 'annual_sum',
    });
  }

  return {
    segments: segments.slice(0, 30), // cap at 30
    segConfidence: segments.length > 0 ? 0.6 : 0.2,
  };
}

function detectOutputs(gt, sheets) {
  const outputs = {};
  let confidence = 0.3;

  for (const [addr, val] of Object.entries(gt)) {
    if (typeof val !== 'string') continue;
    const lower = val.toLowerCase();

    if (!outputs.ebitda && /ebitda|noi|operating (profit|income)/.test(lower)) {
      const bang = addr.lastIndexOf('!');
      const sheet = addr.substring(0, bang);
      const cellPart = addr.substring(bang + 1);
      const rowMatch = cellPart.match(/^([A-Z]+)(\d+)$/);
      if (rowMatch) {
        outputs.ebitda = {
          label: val.trim(),
          cells: { annual: { sheet, row: parseInt(rowMatch[2], 10) } },
        };
        confidence = 0.6;
      }
    }

    if (!outputs.terminalValue && /terminal.*(value|val)|exit.*value|enterprise.*value/.test(lower)) {
      const bang = addr.lastIndexOf('!');
      const sheet = addr.substring(0, bang);
      const cellPart = addr.substring(bang + 1);
      const rowMatch = cellPart.match(/^([A-Z]+)(\d+)$/);
      if (rowMatch) {
        const row = parseInt(rowMatch[2], 10);
        const best = pickRightmostInRange(gt, sheet, row, 'terminalValue');
        if (best) {
          outputs.terminalValue = { cell: best.addr };
        }
      }
    }

    if (!outputs.exitMultiple && /exit.*multiple|ebitda.*multiple|cap.*rate/.test(lower)) {
      const bang = addr.lastIndexOf('!');
      const sheet = addr.substring(0, bang);
      const cellPart = addr.substring(bang + 1);
      const rowMatch = cellPart.match(/^([A-Z]+)(\d+)$/);
      if (rowMatch) {
        const row = parseInt(rowMatch[2], 10);
        const isCapRate = /cap.*rate/.test(lower);
        const field = isCapRate ? 'capRate' : 'exitMultiple';
        const best = pickRightmostInRange(gt, sheet, row, field);
        if (best) {
          outputs.exitMultiple = { cell: best.addr, type: isCapRate ? 'cap_rate_inverse' : 'ebitda_multiple' };
        }
      }
    }
  }

  return { outputs, outputConfidence: confidence };
}

/**
 * Return the rightmost numeric cell on (sheet, row) whose value is within the
 * validated range for `field`. Used by detectors to reject label artifacts and
 * stray small numbers that happen to sit on a header row.
 */
function pickRightmostInRange(gt, sheet, row, field) {
  const candidates = [];
  const prefix = sheet + '!';
  for (const [addr, value] of Object.entries(gt)) {
    if (typeof value !== 'number') continue;
    if (!addr.startsWith(prefix)) continue;
    const m = addr.substring(prefix.length).match(/^([A-Z]+)(\d+)$/);
    if (!m || parseInt(m[2], 10) !== row) continue;
    if (!inFieldRange(field, value)) continue;
    candidates.push({ addr, col: m[1], value });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => colToNum(b.col) - colToNum(a.col));
  return candidates[0];
}

function detectEquity(gt, sheets) {
  const classes = [];
  const seenRows = new Set(); // dedupe by (sheet, row)

  // Find equity-related labels
  for (const [addr, val] of Object.entries(gt)) {
    if (typeof val !== 'string') continue;
    const lower = val.toLowerCase();
    if (!/equity.*(basis|invested|drawn|committed)|capital.*committed/.test(lower)) continue;

    const bang = addr.lastIndexOf('!');
    const sheet = addr.substring(0, bang);
    const cellPart = addr.substring(bang + 1);
    const rowMatch = cellPart.match(/^([A-Z]+)(\d+)$/);
    if (!rowMatch) continue;

    const row = parseInt(rowMatch[2], 10);
    const rowKey = `${sheet}!${row}`;
    if (seenRows.has(rowKey)) continue;
    seenRows.add(rowKey);

    // Collect all numeric values on the same row and pick the largest that's
    // in the expected equity-basis range. Previously: picked the FIRST numeric,
    // which could be a label artifact (e.g. the `5` from `Assumptions!AI48`
    // produced MOIC = terminalValue / 5 = 7.2M×).
    const rowNumerics = [];
    for (const [a2, v2] of Object.entries(gt)) {
      if (typeof v2 !== 'number') continue;
      if (!a2.startsWith(sheet + '!')) continue;
      const m2 = a2.substring(bang + 1).match(/^([A-Z]+)(\d+)$/);
      if (m2 && parseInt(m2[2], 10) === row) {
        rowNumerics.push({ addr: a2, value: v2 });
      }
    }

    const valid = rowNumerics.filter(n => inFieldRange('basisCell', n.value));
    if (valid.length === 0) continue; // skip rows with no plausible basis value

    // Prefer the largest in-range value (peak equity is typically the max)
    valid.sort((a, b) => b.value - a.value);
    classes.push({
      id: classes.length === 0 ? 'class-1' : `class-${classes.length + 1}`,
      label: val.trim(),
      basisCell: valid[0].addr,
    });

    if (classes.length >= 5) break;
  }

  // Look for IRR/MOIC near equity labels
  for (const ec of classes) {
    const sheet = ec.basisCell.substring(0, ec.basisCell.lastIndexOf('!'));
    const cellPart = ec.basisCell.substring(ec.basisCell.lastIndexOf('!') + 1);
    const baseRow = parseInt(cellPart.match(/\d+$/)[0], 10);

    for (const [addr, val] of Object.entries(gt)) {
      if (typeof val !== 'string') continue;
      if (!addr.startsWith(sheet + '!')) continue;
      const lower = val.toLowerCase();
      const rowMatch = addr.match(/(\d+)$/);
      if (!rowMatch) continue;
      const thisRow = parseInt(rowMatch[1], 10);
      if (Math.abs(thisRow - baseRow) > 20) continue;

      // Find adjacent numeric value for this label, constrained to a range.
      // Picks the rightmost in-range value (tables generally put the summary
      // number to the right of the label).
      const findValue = (labelAddr, fieldName) => {
        const lBang = labelAddr.lastIndexOf('!');
        const lSheet = labelAddr.substring(0, lBang);
        const lCell = labelAddr.substring(lBang + 1);
        const lRow = parseInt(lCell.match(/\d+$/)[0], 10);
        const candidates = [];
        for (const [a2, v2] of Object.entries(gt)) {
          if (typeof v2 !== 'number') continue;
          if (!a2.startsWith(lSheet + '!')) continue;
          const m2 = a2.substring(a2.lastIndexOf('!') + 1).match(/^([A-Z]+)(\d+)$/);
          if (!m2 || parseInt(m2[2], 10) !== lRow) continue;
          if (fieldName && !inFieldRange(fieldName, v2)) continue;
          candidates.push({ addr: a2, col: m2[1], value: v2 });
        }
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => colToNum(b.col) - colToNum(a.col));
        return candidates[0].addr;
      };

      if (/gross.*irr/i.test(lower) && !ec.grossIRR) {
        ec.grossIRR = findValue(addr, 'grossIRR');
      } else if (/net.*irr/i.test(lower) && !ec.netIRR) {
        ec.netIRR = findValue(addr, 'netIRR');
      } else if (/gross.*moic|gross.*multiple/i.test(lower) && !ec.grossMOIC) {
        ec.grossMOIC = findValue(addr, 'grossMOIC');
      } else if (/net.*moic|net.*multiple/i.test(lower) && !ec.netMOIC) {
        ec.netMOIC = findValue(addr, 'netMOIC');
      }
    }
  }

  return {
    equity: { classes },
    equityConfidence: classes.length > 0 ? 0.6 : 0.2,
  };
}

function detectCarry(gt, sheets) {
  const carry = { tiers: [], waterfall: {} };
  let confidence = 0.2;

  for (const [addr, val] of Object.entries(gt)) {
    if (typeof val !== 'string') continue;
    const lower = val.toLowerCase();

    // Carry label must contain (carry|promote|carried interest). "Total" alone
    // is ambiguous (Total Cash Flow / Total Capital / Total Profit all match too
    // loosely). And we must REJECT labels that clearly describe something else
    // — "pre-carry cash flow", "cash flow (pre-carry)", etc. all slipped through
    // historically, producing nonsense downstream. See SESSION_LOG_02_carry.md.
    const matchesCarryConcept =
      /total.*(carry|carried|promot)|carried.*interest.*total|gp.*(carry|carried|promot)/.test(lower);
    const isDisqualified =
      /pre.?(carry|promot)|cash.?flow|receivable|payable|fee|operating|capital|equity|profit/.test(lower);
    if (matchesCarryConcept && !isDisqualified) {
      const bang = addr.lastIndexOf('!');
      const sheet = addr.substring(0, bang);
      const rowMatch = addr.match(/(\d+)$/);
      if (!rowMatch) continue;
      const row = parseInt(rowMatch[1], 10);

      const best = pickRightmostInRange(gt, sheet, row, 'carryTotal');
      if (best) {
        carry.totalCell = best.addr;
        confidence = 0.7;
      }
    }

    if (/preferred.*return|pref.*return|hurdle.*rate/.test(lower)) {
      const bang = addr.lastIndexOf('!');
      const sheet = addr.substring(0, bang);
      const rowMatch = addr.match(/(\d+)$/);
      if (!rowMatch) continue;
      const row = parseInt(rowMatch[1], 10);

      const best = pickRightmostInRange(gt, sheet, row, 'prefReturn');
      if (best) {
        carry.waterfall.prefReturn = best.value;
      }
    }
  }

  return { carry, carryConfidence: confidence };
}

function detectDebt(gt, sheets) {
  const debt = {};
  let confidence = 0.2;

  for (const [addr, val] of Object.entries(gt)) {
    if (typeof val !== 'string') continue;
    const lower = val.toLowerCase();

    if (/exit.*debt|debt.*exit|exit.*balance|loan.*balance/.test(lower)) {
      const bang = addr.lastIndexOf('!');
      const sheet = addr.substring(0, bang);
      const rowMatch = addr.match(/(\d+)$/);
      if (!rowMatch) continue;
      const row = parseInt(rowMatch[1], 10);

      const best = pickRightmostInRange(gt, sheet, row, 'exitDebt');
      if (best) {
        debt.exitBalance = best.addr;
        confidence = 0.6;
      }
    }
  }

  return { debt, debtConfidence: confidence };
}

/**
 * Detect stacked scenario blocks on each sheet. Looks for repeating
 * column-A/B label sequences that indicate the sheet stacks several scenarios
 * (e.g., a PE "GPP Promote" sheet with 5 blocks at rows 1–92, 93–184, etc.).
 *
 * Returns: [{ sheet, blocks: [{ startRow, endRow, label? }] }, ...]
 *
 * Only sheets where at least 3 repeating blocks are found get included.
 */
function detectScenarioBlocks(gt, sheets) {
  const result = [];
  // Build per-sheet map: row → column-B (or A) label text
  const bySheet = {};
  for (const [addr, val] of Object.entries(gt)) {
    if (typeof val !== 'string') continue;
    if (val.length < 2 || val.length > 80) continue;
    const bang = addr.lastIndexOf('!');
    if (bang < 0) continue;
    const sheet = addr.substring(0, bang);
    const m = addr.substring(bang + 1).match(/^([A-Z]+)(\d+)$/);
    if (!m) continue;
    const col = m[1];
    if (col !== 'A' && col !== 'B') continue;
    const row = parseInt(m[2], 10);
    if (!bySheet[sheet]) bySheet[sheet] = {};
    // Prefer column B (commonly the label column in PE templates); fall back to A.
    if (col === 'B' || !bySheet[sheet][row]) bySheet[sheet][row] = val.trim();
  }

  for (const [sheet, rowLabels] of Object.entries(bySheet)) {
    const rows = Object.keys(rowLabels).map(Number).sort((a, b) => a - b);
    if (rows.length < 30) continue; // need enough rows for blocks to be meaningful

    // Build a label→first-row map to find the first repeated "anchor" label
    const firstOccurrence = {};
    const occurrences = {};
    for (const r of rows) {
      const label = rowLabels[r].toLowerCase();
      if (firstOccurrence[label] === undefined) firstOccurrence[label] = r;
      if (!occurrences[label]) occurrences[label] = [];
      occurrences[label].push(r);
    }

    // Find an anchor: a label with ≥3 occurrences, evenly spaced
    let anchorLabel = null;
    let anchorStride = null;
    for (const [label, rs] of Object.entries(occurrences)) {
      if (rs.length < 3) continue;
      const strides = [];
      for (let i = 1; i < rs.length; i++) strides.push(rs[i] - rs[i - 1]);
      const first = strides[0];
      if (first < 10 || first > 2000) continue;
      const allSame = strides.every(s => Math.abs(s - first) <= 2);
      if (!allSame) continue;
      anchorLabel = label;
      anchorStride = first;
      break;
    }

    if (!anchorLabel || !anchorStride) continue;

    // Derive logical block boundaries. Anchors typically land inside each
    // block (often near the end, since summary rows are common anchors), so
    // use the minimum labeled row as block 1's start and derive the rest from
    // the stride.
    const anchorRows = occurrences[anchorLabel];
    const globalMinRow = rows[0];
    // Offset of the anchor within its block (using the first anchor as reference)
    const anchorOffsetInBlock = ((anchorRows[0] - globalMinRow) % anchorStride);
    const blocks = [];
    for (let i = 0; i < anchorRows.length; i++) {
      const anchorRow = anchorRows[i];
      const startRow = anchorRow - anchorOffsetInBlock;
      const endRow = startRow + anchorStride - 1;
      // Attempt to name the block: look at the first few labeled rows of the block
      let blockLabel = null;
      for (let r = startRow; r <= Math.min(startRow + 4, endRow); r++) {
        const candidate = rowLabels[r];
        if (candidate && candidate.length > 2 && candidate.length < 60) {
          blockLabel = candidate;
          break;
        }
      }
      blocks.push({ startRow, endRow, anchorRow, label: blockLabel });
    }

    result.push({ sheet, blocks, anchorLabel: rowLabels[anchorRows[0]], stride: anchorStride });
  }

  return result;
}

function detectCustomCells(gt, sheets) {
  const custom = {};

  for (const [addr, val] of Object.entries(gt)) {
    if (typeof val !== 'string') continue;
    const lower = val.toLowerCase();

    const bang = addr.lastIndexOf('!');
    const sheet = addr.substring(0, bang);
    const rowMatch = addr.match(/(\d+)$/);
    if (!rowMatch) continue;
    const row = parseInt(rowMatch[1], 10);

    if (/wacc|discount.*rate|cost.*capital/.test(lower) && !custom.wacc) {
      const best = pickRightmostInRange(gt, sheet, row, 'wacc');
      if (best) custom.wacc = best.addr;
    }

    if (/shares.*outstanding|total.*shares|units.*outstanding/.test(lower) && !custom.sharesOutstanding) {
      const best = pickRightmostInRange(gt, sheet, row, 'sharesOutstanding');
      if (best) custom.sharesOutstanding = best.addr;
    }

    if (/price.*per.*share|share.*price|nav.*per.*unit/.test(lower) && !custom.pricePerShare) {
      const best = pickRightmostInRange(gt, sheet, row, 'pricePerShare');
      if (best) custom.pricePerShare = best.addr;
    }
  }

  return custom;
}

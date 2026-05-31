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
import { join, dirname, basename } from 'path';

// ---------------------------------------------------------------------------
// Schema Constants
// ---------------------------------------------------------------------------

export const MANIFEST_VERSION = 'manifest-v1.0';

export const MODEL_TYPES = [
  'pe_fund', 'pe_platform', 'pe_buyout', 're_fund', 'saas', 'venture_portfolio', 'three_statement',
  // Asset-class families added so the summary lens labels headlines correctly
  // (a credit deal's exit metric is leverage/debt-yield, not a revenue multiple;
  // a FoF's headline is blended TVPI/DPI). Before these, credit/search/FoF fell
  // through to `saas` and mislabeled headline numbers — the most serious A5 class.
  'credit', 'fund_of_funds', 'search_fund', 'infrastructure', 'real_estate_debt',
  // Corporate operating-plan / DCF (FP&A, corp-dev). Headline = Enterprise Value
  // + Equity Value (DCF deliverables), not a fund/exit-multiple framing.
  'corporate',
  'unknown',
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
  // V4 additions
  tvpi:            { min: 0,     max: 20,    label: 'TVPI (0-20x)' },
  dpi:             { min: 0,     max: 20,    label: 'DPI (0-20x)' },
  rvpi:            { min: 0,     max: 20,    label: 'RVPI (0-20x)' },
  fundSize:        { min: 1e6,   max: 100e9, label: 'fund size' },
  paidIn:          { min: 1e6,   max: 100e9, label: 'paid-in capital' },
  distributed:     { min: 0,     max: 200e9, label: 'total distributed' },
  residualValue:   { min: 0,     max: 200e9, label: 'residual NAV' },
  vintageYear:     { min: 1985,  max: 2050,  label: 'vintage year' },
  debtRate:        { min: 0,     max: 0.30,  label: 'debt rate (0-30%)' },
  debtPrincipal:   { min: 1e5,   max: 100e9, label: 'debt principal' },
  covenantRatio:   { min: 0,     max: 100,   label: 'covenant ratio' },
  ownershipPct:    { min: 0,     max: 1,     label: 'ownership fraction (0-1)' },
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
 * Resolve the directory that actually holds the converted artifacts.
 *
 * `ete init` writes the engine + manifest + ground truth into a `chunked/`
 * subdirectory, but users (and the docs' own `./my-model/` examples) naturally
 * point commands at the PARENT. `verify` already auto-resolved this; centralize
 * it so every model-dir command (summary/pnl/scenario/sensitivity/compare/carry/
 * extract/explain/query) accepts either `<dir>` or `<dir>/chunked` transparently.
 *
 * Returns the dir containing manifest.json (modelDir or modelDir/chunked), or
 * modelDir unchanged if neither has one (so callers still surface a clear error).
 */
export function resolveModelDir(modelDir) {
  if (!modelDir) return modelDir;
  if (existsSync(join(modelDir, 'manifest.json'))) return modelDir;
  if (existsSync(join(modelDir, 'chunked', 'manifest.json'))) return join(modelDir, 'chunked');
  return modelDir;
}

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
  throw new Error(`No manifest.json found in ${modelDir} or ${join(modelDir, 'chunked')}. Run: ete init <model.xlsx> --output ${modelDir}`);
}

/**
 * Load ground truth from the path specified in the manifest.
 *
 * The manifest's `model.groundTruth` is typically relative (`./_ground-truth.json`)
 * and lives next to the manifest — which may be in `modelDir` OR `modelDir/chunked`.
 * Mirror loadManifest's `chunked/` fallback so a relative ground-truth path
 * resolves regardless of which level the user pointed the command at.
 */
export function loadGroundTruth(manifest, modelDir) {
  const ref = manifest.model.groundTruth;
  let candidates;
  if (ref.startsWith('.')) {
    // Relative: try alongside a root manifest, then inside chunked/.
    candidates = [join(modelDir, ref), join(modelDir, 'chunked', ref)];
  } else {
    candidates = [ref];
  }
  for (const p of candidates) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8'));
  }
  throw new Error(
    `Ground truth not found: ${candidates.join(' or ')}. ` +
    `Point the command at the model dir (or its chunked/ subdir), or run: ete init <model.xlsx> --output ${modelDir}`,
  );
}

// ---------------------------------------------------------------------------
// Cell Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a single cell reference from ground truth.
 *
 * Accepts either a string cell reference (`"Sheet!A1"`) or an aggregate
 * object (`{ cells: ["Sheet1!A1", "Sheet2!A1"], op: "sum" }`). The aggregate
 * form lets a manifest express multi-class promote totals (e.g. a PE fund
 * with fee-paying + TRS investor classes on separate sheets) where the
 * model has no single "total carry" cell.
 *
 * @param {Object} gt - Ground truth {addr: value}
 * @param {string|Object} cellRef - cell address or `{ cells, op }`
 * @returns {*} Cell value, aggregated number, or undefined
 */
export function resolveCell(gt, cellRef) {
  if (cellRef == null) return undefined;
  if (typeof cellRef === 'string') return gt[cellRef];
  if (typeof cellRef === 'object' && Array.isArray(cellRef.cells)) {
    const vals = cellRef.cells
      .map(c => gt[c])
      .filter(v => typeof v === 'number' && Number.isFinite(v));
    if (vals.length === 0) return undefined;
    const op = (cellRef.op || 'sum').toLowerCase();
    if (op === 'sum') return vals.reduce((a, b) => a + b, 0);
    if (op === 'avg' || op === 'average') return vals.reduce((a, b) => a + b, 0) / vals.length;
    if (op === 'max') return Math.max(...vals);
    if (op === 'min') return Math.min(...vals);
    return undefined;
  }
  return undefined;
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

  // Any other manifest.outputs.<key> with a scalar cell (mirrors
  // enumerateOutputCells so the contract + base case stay in sync).
  if (manifest.outputs) {
    for (const [key, o] of Object.entries(manifest.outputs)) {
      if (key === 'ebitda' || key === 'terminalValue' || key === 'exitMultiple' || (key in outputs)) continue;
      const ref = typeof o === 'string' ? o : (o && typeof o.cell === 'string' ? o.cell : null);
      if (ref && ref.includes('!')) outputs[key] = resolveCell(gt, ref);
    }
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

  // V4: fund-level metrics
  if (manifest.fundLevel) {
    for (const [key, val] of Object.entries(manifest.fundLevel)) {
      if (typeof val === 'string' && val.includes('!')) {
        outputs[key] = resolveCell(gt, val);
      } else if (typeof val === 'number') {
        outputs[key] = val;
      }
    }
  }

  // V4: debt detail fields resolve under "debt.*" shorthand
  if (manifest.debt) {
    for (const key of ['principal', 'rate', 'maturity']) {
      if (manifest.debt[key] && typeof manifest.debt[key] === 'string') {
        outputs[`debt${key.charAt(0).toUpperCase()}${key.slice(1)}`] = resolveCell(gt, manifest.debt[key]);
      }
    }
  }

  // V4: total shares outstanding
  if (manifest.equity?.totalShares && typeof manifest.equity.totalShares === 'string') {
    outputs.totalShares = resolveCell(gt, manifest.equity.totalShares);
  }

  // V4: covenants (DSCR, LTV, ICR, leverage, occupancy) — headline answers for
  // credit / debt-monitor models. Keyed by covenant id; kept in sync with
  // enumerateOutputCells (manifest-maps.mjs) for the drift guard.
  if (Array.isArray(manifest.covenants)) {
    for (const cov of manifest.covenants) {
      if (cov && typeof cov.cell === 'string' && cov.cell.includes('!')) {
        outputs[cov.id] = resolveCell(gt, cov.cell);
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
 * Build a label index from ground truth JSON. Used as a fallback when the
 * Rust parser's chunked/_labels.json isn't present (legacy engines).
 */
export function buildLabelIndex(gt) {
  const index = {};
  for (const [addr, val] of Object.entries(gt)) {
    if (typeof val !== 'string') continue;
    const trimmed = val.trim();
    if (trimmed.length < 2 || trimmed.length > 200) continue;
    const bang = addr.lastIndexOf('!');
    if (bang < 0) continue;
    const sheet = addr.substring(0, bang);
    const cellPart = addr.substring(bang + 1);
    const m = cellPart.match(/^([A-Z]+)(\d+)$/);
    if (!m) continue;
    const key = trimmed.toLowerCase();
    if (!index[key]) index[key] = [];
    index[key].push({ sheet, col: m[1], row: parseInt(m[2], 10), text: trimmed });
  }
  return index;
}

/**
 * Load a pre-built label index from the model directory.
 * Returns { labelLower: [{ sheet, col, row, text }] } or null if absent.
 *
 * The index is emitted by the Rust parser during chunked emission as
 * `chunked/_labels.json`. When present, searchByLabel uses it for O(1) lookup
 * instead of O(N) ground-truth scanning — eliminates the 30s-per-search
 * cost flagged in SESSION_LOG_02_carry.md.
 */
export function loadLabelIndex(modelDir) {
  if (!modelDir) return null;
  const candidates = [
    join(modelDir, '_labels.json'),
    join(modelDir, 'chunked', '_labels.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf-8'));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Column-probe bounds for numericsForRow (label search). Excel's hard ceiling
// is XFD (16384); we stop after a long run of empty columns so a label-only row
// costs a few hundred O(1) lookups instead of a full ground-truth scan.
const LABEL_PROBE_MAX_COL = 16384;
const LABEL_PROBE_MAX_GAP = 256;

// 1 → "A", 26 → "Z", 27 → "AA". Inverse of the col parsing in buildLabelIndex.
function numToColLetters(num) {
  let col = '';
  while (num > 0) { const r = (num - 1) % 26; col = String.fromCharCode(65 + r) + col; num = Math.floor((num - 1) / 26); }
  return col;
}

/**
 * Search ground truth for cells matching a label pattern.
 * Returns matching labels with adjacent numeric values.
 *
 * If `options.index` is provided (from loadLabelIndex), uses it for fast
 * lookup. Otherwise falls back to a full scan of `gt`.
 *
 * Default match mode is **literal** (case-insensitive substring) so that PE
 * users can paste phrases like "Gross (portfolio" without the pattern being
 * interpreted as an unterminated regex group. Pass `options.regex: true` for
 * regex semantics (used by internal detectors and the refiner).
 *
 * When `options.caseColumn` is provided (e.g. "H"), the adjacent-value list is
 * reordered so that column appears first — the common shape for comparison
 * sheets with multiple scenario columns (H/I/J). Callers use this to select
 * a specific scenario without walking cells.
 */
export function searchByLabel(gt, pattern, options = {}) {
  const {
    sheet: filterSheet,
    maxResults = 50,
    index = null,
    regex: useRegex = false,
    caseColumn = null,
  } = options;

  const matcher = buildSearchMatcher(pattern, useRegex);
  const matches = [];

  // Collect candidate (sheet, col, row, text) entries via index if available.
  let candidates;
  if (index && typeof index === 'object') {
    candidates = [];
    for (const [lowerText, entries] of Object.entries(index)) {
      if (!matcher(lowerText)) continue;
      for (const e of entries) {
        if (filterSheet && e.sheet !== filterSheet) continue;
        candidates.push(e);
        if (candidates.length >= maxResults * 4) break;
      }
      if (candidates.length >= maxResults * 4) break;
    }
  } else {
    // Fallback: scan ground truth for string cells
    candidates = [];
    for (const [addr, value] of Object.entries(gt)) {
      if (typeof value !== 'string') continue;
      if (!matcher(value)) continue;
      const bang = addr.lastIndexOf('!');
      const sheet = addr.substring(0, bang);
      if (filterSheet && sheet !== filterSheet) continue;
      const cellPart = addr.substring(bang + 1);
      const colMatch = cellPart.match(/^([A-Z]+)(\d+)$/);
      if (!colMatch) continue;
      candidates.push({
        sheet,
        col: colMatch[1],
        row: parseInt(colMatch[2], 10),
        text: value,
      });
      if (candidates.length >= maxResults * 4) break;
    }
  }

  // For each candidate, collect adjacent numeric values on the same row.
  // Probe the row's columns on demand (memoized) rather than scanning the whole
  // ground truth once per row — the same approach the refiner uses. On a 200 MB
  // ground truth a full scan per matched row is ~tens of ms each; probing the
  // contiguous numeric block is effectively free. Stops after a long run of
  // empty columns (MAX_PROBE_GAP). A directed caseColumn lookup (below) probes
  // its exact cell separately, so a far scenario column is never missed.
  const numByRow = new Map();
  function numericsForRow(sheet, row) {
    const key = `${sheet}!${row}`;
    if (numByRow.has(key)) return numByRow.get(key);
    const vals = [];
    let gap = 0;
    for (let c = 1; c <= LABEL_PROBE_MAX_COL && gap < LABEL_PROBE_MAX_GAP; c++) {
      const col = numToColLetters(c);
      const addr = `${sheet}!${col}${row}`;
      const v = gt[addr];
      if (typeof v === 'number') { vals.push({ col, addr, value: v }); gap = 0; }
      else gap++;
    }
    numByRow.set(key, vals);
    return vals;
  }

  for (const c of candidates) {
    let adjacentValues = numericsForRow(c.sheet, c.row).slice(0, 20);
    let caseValue = null;
    if (caseColumn) {
      const target = String(caseColumn).toUpperCase();
      const hit = adjacentValues.find(v => v.col === target);
      if (hit) caseValue = hit.value;
      else {
        // Directed lookup: probe the exact cell so a scenario column beyond the
        // adjacent-block probe window is still resolved.
        const direct = gt[`${c.sheet}!${target}${c.row}`];
        if (typeof direct === 'number') caseValue = direct;
      }
      adjacentValues = adjacentValues.slice().sort((a, b) => {
        if (a.col === target) return -1;
        if (b.col === target) return 1;
        return 0;
      });
    }
    matches.push({
      label: c.text,
      labelCell: `${c.sheet}!${c.col}${c.row}`,
      sheet: c.sheet,
      col: c.col,
      row: c.row,
      values: adjacentValues,
      ...(caseColumn ? { caseColumn: String(caseColumn).toUpperCase(), caseValue } : {}),
    });
    if (matches.length >= maxResults) break;
  }

  return matches;
}

/**
 * Build a case-insensitive matcher function for label search. Returns
 * `(text) => boolean`.
 *
 * Modes (in order of attempt for the default behavior):
 *   1. Literal substring (case-insensitive). Covers the everyday case:
 *      `--search "revenue"`, `--search "Gross (portfolio)"`.
 *   2. Token AND-match — if literal substring fails, split the pattern on
 *      whitespace and require every token to appear as a word-boundary match
 *      in the label. This lets `--search "Gross MOIC"` match labels like
 *      "Gross (post carry, pre-fees) MOIC" where the substring is not
 *      contiguous. Token AND-match requires ≥2 tokens to avoid false-positives.
 *
 * With `useRegex: true`, the pattern is compiled as a regex. Invalid regex
 * falls back to mode 1+2 rather than throwing, so users who paste a phrase
 * containing regex metacharacters ("Gross (port") still get a useful result.
 */
function buildSearchMatcher(pattern, useRegex) {
  const str = String(pattern == null ? '' : pattern);

  if (useRegex) {
    try {
      const re = new RegExp(str, 'i');
      return (text) => re.test(text);
    } catch {
      /* fall through to literal + token */
    }
  }

  const literalRe = new RegExp(str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const tokens = str.split(/\s+/).filter(t => t.length >= 2);
  if (tokens.length < 2) {
    return (text) => literalRe.test(text);
  }
  const tokenRes = tokens.map(t =>
    new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
  );
  return (text) => {
    if (literalRe.test(text)) return true;
    return tokenRes.every(re => re.test(text));
  };
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
    pe_buyout: 0,
    re_fund: 0,
    saas: 0,
    venture_portfolio: 0,
    three_statement: 0,
    credit: 0,
    fund_of_funds: 0,
    search_fund: 0,
    infrastructure: 0,
    real_estate_debt: 0,
    corporate: 0,
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

  // SaaS signals. NOTE the word boundaries on \barr\b / \bmrr\b: a bare /arr/
  // matches "c{arr}ied", "c{arr}y", and "{arr}angement", which spuriously tagged
  // credit and search-fund models as SaaS. Require the standalone metric token.
  if (/\barr\b|\bmrr\b|churn|net retention|recurring revenue/i.test(text)) signals.saas += 3;
  if (/\bcac\b|payback period|cohort/i.test(text)) signals.saas += 2;

  // Venture signals
  if (/portfolio company|vintage|follow-on|markup/i.test(text)) signals.venture_portfolio += 3;
  if (/series [a-f]|seed|pre-seed|bridge/i.test(text)) signals.venture_portfolio += 2;

  // 3-statement signals
  if (/balance sheet|income statement|cash flow statement/i.test(text)) signals.three_statement += 3;
  if (/retained earnings|accounts receivable|accounts payable/i.test(text)) signals.three_statement += 2;

  // Corporate operating-plan / DCF (FP&A, corp-dev). Gate on DCF-UNIQUE tokens —
  // NOT "enterprise value"/"equity value"/"gross profit", which also appear in
  // PE/M&A/SaaS exit summaries. The DCF mechanics (discounted cash flow, Gordon
  // terminal value, WACC, operating plan) are what's specific to a corporate
  // valuation model and absent from the other families.
  if (/discounted cash flow|terminal value \(gordon|gordon growth/i.test(text)) signals.corporate += 4;
  if (/\bwacc\b|cost of capital/i.test(text)) signals.corporate += 2;
  if (/operating plan|free cash flow|pv of (terminal value|free cash flow)/i.test(text)) signals.corporate += 2;

  // Private credit / direct lending (LENDER side — yield, not equity carry).
  if (/unitranche|direct lending|original issue discount|\boid\b|credit spread|call protection|bullet repayment|all-in.*coupon|yield to lender/i.test(text)) signals.credit += 3;
  if (/interest coverage|debt ?\/ ?ebitda|funded principal|term loan|base rate|sofr/i.test(text)) signals.credit += 2;

  // Fund-of-funds (shares TVPI/DPI with venture — require an FoF-specific token).
  if (/fund.?of.?funds|\bfof\b|underlying fund|uncalled commit|unfunded commit|blended (tvpi|dpi|irr|net irr|gross irr)/i.test(text)) signals.fund_of_funds += 3;
  if (/dry powder|commitment reconcil|called % of commit|underlying fund positions/i.test(text)) signals.fund_of_funds += 2;

  // Search fund (single SMB acquisition; SDE/SBA/seller-note are the tells).
  if (/search fund|searcher|\bsde\b|seller note|\bsba\b/i.test(text)) signals.search_fund += 3;
  if (/stepped equity|co-invest|investor preferred/i.test(text)) signals.search_fund += 2;

  // Infrastructure / project finance (contracted, long-dated, debt-sculpted).
  if (/\bcfads\b|availability|concession|contracted revenue|project debt|\bppa\b/i.test(text)) signals.infrastructure += 3;
  if (/escalation|residual.*value|debt service coverage|renewable/i.test(text)) signals.infrastructure += 2;

  // Real-estate DEBT — a LENDER-side monitor (the deal is ABOUT the debt), not an
  // equity RE deal that merely carries a mortgage. GATE on a debt-FIRST headline
  // (debt yield / debt monitor / lender summary); generic DSCR/LTV alone are NOT
  // enough — every levered equity deal has them, and counting them flipped the
  // equity value-add and infra models to debt (mislabeling their cap rate/exit
  // yield as a "debt yield"). The DSCR/LTV tier and the re_fund boost only apply
  // once a debt-first headline is already present.
  if (/debt monitor|debt yield|lender summary|whole.?loan|covenant schedule/i.test(text)) signals.real_estate_debt += 4;
  if (signals.real_estate_debt >= 4 && /\bdscr\b|loan.?to.?value|senior (?:debt|facility|loan)|debt service/i.test(text)) signals.real_estate_debt += 2;
  if (signals.real_estate_debt >= 4 && signals.re_fund > 0) signals.real_estate_debt += signals.re_fund; // a debt-first RE model still IS real estate

  // pe_buyout vs pe_fund — a SINGLE-COMPANY leveraged buyout pays GP carry/pref
  // and so would otherwise win as `pe_fund` (a fund OF companies). Distinguish:
  // when single-deal LBO markers are present (entry/exit multiple, acquisition
  // leverage, a senior facility, sponsor equity) AND fund-of-companies markers
  // are ABSENT (no capital calls, LP commitments, portfolio companies, vintage,
  // fund size), it's one buyout, not a fund. Only reclassify when pe_fund is
  // already the LEADING signal, so a re_fund / search_fund / credit model that
  // merely carries a "preferred return" line is never mislabeled a buyout.
  const curMax = Math.max(...Object.values(signals));
  const singleDealLBO = /acquisition leverage|senior debt facility|sponsor equity|leveraged buyout|\blbo\b|entry.{0,15}multiple|exit.{0,15}multiple/i.test(text);
  const fundOfCompanies = /capital call|committed capital|lp commitment|limited partner|portfolio compan|vintage|fund size|drawdown|uncalled|dry powder|underlying fund/i.test(text);
  if (signals.pe_fund > 0 && signals.pe_fund >= curMax && singleDealLBO && !fundOfCompanies) {
    signals.pe_buyout = curMax + 1; // edge past pe_fund/pe_platform → unique argmax
  }

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

  // Model-family awareness for the review checklist: don't nag about concepts a
  // given asset class legitimately lacks (a VC fund has no P&L segments; a SaaS
  // or credit model has no LP/GP equity classes; RE has NOI not EBITDA).
  const _lc = modelType.toLowerCase();
  const _isFund = /fund|venture|fof|portfolio/.test(_lc);
  const _noPnLExpected = _isFund;
  const _noEbitdaExpected = _isFund || /saas|growth|re[_-]|real|infra|credit|debt/.test(_lc);
  const _noEquityClassExpected = _isFund || /saas|growth|credit|debt|corporate|3statement/.test(_lc);

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
  if (segments.length === 0 && !_noPnLExpected) {
    checklist.push('REVIEW: No revenue/expense segments detected — add manually');
  }

  // Detect outputs
  const { outputs, outputConfidence } = detectOutputs(gt, sheets, modelType);
  confidence.outputs = outputConfidence;
  if (!outputs.ebitda && !_noEbitdaExpected) {
    checklist.push('REVIEW: No EBITDA/NOI output detected — add outputs.ebitda manually');
  }

  // Detect equity
  const { equity, equityConfidence } = detectEquity(gt, sheets);
  confidence.equity = equityConfidence;
  if ((!equity.classes || equity.classes.length === 0) && !_noEquityClassExpected) {
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

  // V4: fund-level LP-facing metrics (TVPI, DPI, RVPI, netIRR, vintage year,
  // fund size, paid-in, distributed, residual). These are what LPs ask about
  // even when the underlying model is a PE platform or RE fund.
  const fundLevel = detectFundLevelMetrics(gt, sheets);

  // V4: time-series schedules (capital calls, distributions, debt balances,
  // fee streams, etc.). Generic enough to cover the long tail of extraction
  // questions — cap schedule, debt amort, LP commitments drawdown, etc.
  const schedules = detectSchedules(gt, sheets, timeline);

  // V4: expanded carry — tiered waterfall detection (pref, catch-up, residual)
  const carryTiers = detectCarryTiers(gt, sheets, carry);
  if (carryTiers.length > 0) carry.tiers = carryTiers;

  // V4: expanded debt — rate, maturity, principal
  const debtDetails = detectDebtDetails(gt, sheets);
  Object.assign(debt, debtDetails);

  // V4: expanded equity — shares and ownership fractions per class
  const capTableEnrichment = detectCapTable(gt, sheets, equity);
  Object.assign(equity, capTableEnrichment);

  // V4: covenants (ratios with thresholds)
  const covenants = detectCovenants(gt, sheets);

  // Build manifest
  const manifest = {
    $schema: MANIFEST_VERSION,
    model: {
      // Display name = the workbook's BASENAME without extension (e.g. "model"),
      // never the full path. options.source can be an absolute path (init passes
      // the resolved .xlsx path); using it verbatim leaked "C:\Users\…\model" as
      // the model name into every summary/INTEGRATION header — a recurring trust
      // dent for non-technical users. `source` keeps the full path for provenance.
      // basename() handles both \ and / on win32.
      name: options.source ? basename(options.source).replace(/\.xlsx?$/i, '') : 'Untitled Model',
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
    // V4 extensions
    fundLevel,
    schedules,
    covenants,
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
      // This detector only ever collects integer YEAR headers (2015–2040), so a
      // matched timeline is annual by construction. (Monthly/quarterly models
      // carry serial-date or "MMM-YY" headers, which fall through to 'unknown'.)
      // The old `bestCount >= 8 ? annual : monthly` mislabeled every model with
      // a normal 5–7 year hold as "monthly".
      periodicity: 'annual',
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
    // always scalar assumption placeholders, not real P&L streams (without
    // this, real-world decks produce dozens of bogus "segments" all equal to
    // the same scalar).
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

function detectOutputs(gt, sheets, modelType = 'unknown') {
  const outputs = {};
  let confidence = 0.3;

  // Exit-multiple candidates are collected and ranked AFTER the scan: a model
  // almost always has both an "Entry ... Multiple" and an "Exit ... Multiple"
  // assumption, and first-match grabbed whichever iterated first (usually
  // entry). We want the exit one.
  const exitMultCands = [];

  for (const [addr, val] of Object.entries(gt)) {
    if (typeof val !== 'string') continue;
    const lower = val.toLowerCase();

    // EBITDA/NOI row — but NOT a "... EBITDA Multiple" / "EBITDA per share"
    // label, which describes a valuation ratio, not the EBITDA line itself.
    if (!outputs.ebitda && /ebitda|noi|operating (profit|income)/.test(lower)
        && !/multiple|per\s*share|\/\s*ebitda|margin|growth|cagr/.test(lower)) {
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

    // Corporate DCF deliverables — Enterprise Value + Equity Value are the FP&A /
    // corp-dev headline (the bound `terminalValue` here is the "PV of Terminal
    // Value" stub, an intermediate). GATED to corporate models so the contracts of
    // the other families (whose terminalValue already binds an "Exit Enterprise/
    // Equity Value" label) are untouched. Reuses the terminalValue range ($1M+).
    if (modelType === 'corporate') {
      const evMatch = !outputs.enterpriseValue && /enterprise value/.test(lower)
        && !/per\s*share|\/|multiple|\bentry\b/.test(lower);
      const eqMatch = !outputs.equityValue && /equity value/.test(lower)
        && !/per\s*share|\/|multiple|book|\bentry\b/.test(lower);
      if (evMatch || eqMatch) {
        const bang = addr.lastIndexOf('!');
        const sheet = addr.substring(0, bang);
        const rowMatch = addr.substring(bang + 1).match(/^([A-Z]+)(\d+)$/);
        if (rowMatch) {
          const best = pickRightmostInRange(gt, sheet, parseInt(rowMatch[2], 10), 'terminalValue', { labelCol: rowMatch[1] });
          if (best && evMatch) outputs.enterpriseValue = { cell: best.addr };
          if (best && eqMatch) outputs.equityValue = { cell: best.addr };
        }
      }
    }

    // SaaS ARR headline cells. A land-and-expand model's ARR CAGR (≈39%) differs
    // materially from its revenue CAGR (≈30%); surfacing ending ARR + ARR CAGR
    // separately stops the summary from pinning one CAGR to both. GATED to saas;
    // flat scalar keys resolve via the generic base-case passthrough. Ending ARR
    // is the rightmost (exit-year) value, so no labelCol anchoring.
    if (modelType === 'saas') {
      if (!outputs.arrEnding && /ending arr|exit.*\barr\b|\barr\b.*exit/.test(lower)
          && !/multiple|growth|cagr|\/|per\s|target|assumption|\bplan\b|budget|goal/.test(lower)) {
        const bang = addr.lastIndexOf('!');
        const sheet = addr.substring(0, bang);
        const rowMatch = addr.substring(bang + 1).match(/^([A-Z]+)(\d+)$/);
        if (rowMatch) {
          const best = pickRightmostInRange(gt, sheet, parseInt(rowMatch[2], 10), 'terminalValue');
          if (best) outputs.arrEnding = { cell: best.addr };
        }
      }
      if (!outputs.arrCAGR && /\barr\b.*cagr|cagr.*\barr\b/.test(lower)) {
        const bang = addr.lastIndexOf('!');
        const sheet = addr.substring(0, bang);
        const rowMatch = addr.substring(bang + 1).match(/^([A-Z]+)(\d+)$/);
        if (rowMatch) {
          const best = pickRightmostInRange(gt, sheet, parseInt(rowMatch[2], 10), 'arrCAGR', { labelCol: rowMatch[1] });
          if (best) outputs.arrCAGR = { cell: best.addr };
        }
      }
    }

    // Infrastructure / project finance — the unlevered Project IRR is the metric a
    // project-finance director leads with (alongside the equity IRR/MOIC). Gated to
    // infrastructure; flat scalar key resolves via the base-case passthrough.
    if (modelType === 'infrastructure' && !outputs.projectIRR
        && /project irr|unlevered.*irr/.test(lower)) {
      const bang = addr.lastIndexOf('!');
      const sheet = addr.substring(0, bang);
      const rowMatch = addr.substring(bang + 1).match(/^([A-Z]+)(\d+)$/);
      if (rowMatch) {
        const best = pickRightmostInRange(gt, sheet, parseInt(rowMatch[2], 10), 'grossIRR', { labelCol: rowMatch[1] });
        if (best) outputs.projectIRR = { cell: best.addr };
      }
    }

    if (/exit.*multiple|ebitda.*multiple|cap.*rate|revenue.*multiple|arr.*multiple|exit.*yield|terminal.*yield/.test(lower)) {
      const bang = addr.lastIndexOf('!');
      const sheet = addr.substring(0, bang);
      const cellPart = addr.substring(bang + 1);
      const rowMatch = cellPart.match(/^([A-Z]+)(\d+)$/);
      if (rowMatch) {
        const row = parseInt(rowMatch[2], 10);
        // A cap rate or exit/terminal yield is a rate (0.01–0.30), not an x-multiple.
        const isCapRate = /cap.*rate|exit.*yield|terminal.*yield/.test(lower);
        // An ARR multiple ("Exit ARR Multiple") prices ARR, not revenue/EBITDA —
        // the lens prints "x ARR" so it isn't mislabeled "x Revenue".
        const isArr = /\barr\b.*multiple|multiple.*\barr\b/.test(lower);
        const field = isCapRate ? 'capRate' : 'exitMultiple';
        const best = pickRightmostInRange(gt, sheet, row, field, { labelCol: rowMatch[1] });
        if (best) {
          // Score: an explicit "exit" label is what we want; an "entry"
          // label is the trap. Cap-rate and plain multiples sit in between.
          let score = 0;
          if (/\bexit\b/.test(lower)) score += 5;
          if (/\bentry\b|\bpurchase\b|\bacquisition\b/.test(lower)) score -= 5;
          if (isCapRate) score += 1;
          exitMultCands.push({ cell: best.addr, isCapRate, isArr, score });
        }
      }
    }
  }

  if (exitMultCands.length > 0) {
    exitMultCands.sort((a, b) => b.score - a.score);
    const win = exitMultCands[0];
    outputs.exitMultiple = { cell: win.cell, type: win.isCapRate ? 'cap_rate_inverse' : win.isArr ? 'arr_multiple' : 'ebitda_multiple' };
  }

  return { outputs, outputConfidence: confidence };
}

/**
 * Return the best numeric cell on (sheet, row) for `field`.
 *
 * Historically the rightmost-in-range value was always returned, which is a
 * trap on rows where a restated/reference-copy cell at the far right shadows
 * the canonical formula cell close to the label. A model where the real
 * `Total Carried Interest` sits at D88 but a zero-valued copy at KU88 used to
 * bind `carry.totalCell = KU88 = 0`.
 *
 * Current ranking:
 *   1. Drop out-of-range values.
 *   2. Prefer non-zero when both zero and non-zero exist in range — a
 *      zero-valued total/balance is overwhelmingly a restated-copy or
 *      uninitialized sensitivity, not the answer. Safe on every caller.
 *   3. When `opts.labelCol` is provided, pick the non-zero cell closest to
 *      the label column; ties break leftward.
 *   4. Otherwise fall back to rightmost non-zero — this preserves the
 *      historical behavior for time-series rows (e.g. `Debt Balance` across
 *      years where the exit/last period is what you want).
 */
function pickRightmostInRange(gt, sheet, row, field, opts = {}) {
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

  const nonZero = candidates.filter(c => c.value !== 0);
  const pool = nonZero.length > 0 ? nonZero : candidates;

  if (opts.labelCol) {
    const anchor = colToNum(opts.labelCol);
    pool.sort((a, b) => {
      const da = Math.abs(colToNum(a.col) - anchor);
      const db = Math.abs(colToNum(b.col) - anchor);
      if (da !== db) return da - db;
      return colToNum(a.col) - colToNum(b.col);
    });
  } else {
    pool.sort((a, b) => colToNum(b.col) - colToNum(a.col));
  }
  return pool[0];
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

  // Note: sibling-sheet aggregation is NOT applied to equity classes. On
  // many PE models the same "Equity Drawn / (Distributions)" label can
  // appear on multiple promote sheets AND on multiple rows within each sheet
  // (fund-level vs LP-level equity positions), so merging by label would
  // collapse structurally-distinct positions. Downstream code (IRR/MOIC
  // nearby-row search) also assumes `basisCell` is a plain string. Equity
  // class modeling stays per-class-per-row.

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
      } else if ((/gross.*moic|gross.*multiple/i.test(lower) || (/equity.*(moic|multiple)/i.test(lower) && !/\bnet\b/i.test(lower))) && !ec.grossMOIC) {
        // "Equity Multiple (MOIC)" / "Equity MOIC" is the gross equity multiple —
        // an infra/RE deal labels it that way rather than "Gross MOIC". The net
        // guard keeps a "Net Equity MOIC" routed to netMOIC below.
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

/**
 * Given a cell on a sheet named like "Foo (X)", find sibling sheets "Foo (Y)"
 * that have non-zero numeric values at the same row/col. Returns either a
 * string cell ref (no siblings found) or an aggregate `{ cells, op: 'sum' }`
 * object. Used by `detectCarry` and `detectEquity` to handle multi-class
 * structures where the same financial concept is split across per-class
 * sheets that share a common prefix.
 *
 * @param {Object} gt - Ground truth
 * @param {Array<string>|Set<string>} sheets - All sheet names in the model
 * @param {string} primaryAddr - Cell ref from the primary sheet (e.g. "Foo (1.5%)!D86")
 * @returns {string | {cells: string[], op: 'sum'}} address or aggregate
 */
function resolveSiblingAggregate(gt, sheets, primaryAddr) {
  const bang = primaryAddr.lastIndexOf('!');
  if (bang < 0) return primaryAddr;
  const sheet = primaryAddr.substring(0, bang);
  const cellPart = primaryAddr.substring(bang + 1);
  const siblingMatch = sheet.match(/^(.+?)\s*\([^)]+\)\s*$/);
  if (!siblingMatch) return primaryAddr;
  const prefix = siblingMatch[1];
  const sheetList = Array.isArray(sheets) ? sheets : Array.from(sheets || []);
  const siblings = sheetList.filter(s =>
    s !== sheet &&
    typeof s === 'string' &&
    s.startsWith(prefix) &&
    /\([^)]+\)\s*$/.test(s) &&
    typeof gt[`${s}!${cellPart}`] === 'number' &&
    gt[`${s}!${cellPart}`] !== 0
  );
  if (siblings.length === 0) return primaryAddr;
  return {
    cells: [primaryAddr, ...siblings.map(s => `${s}!${cellPart}`)],
    op: 'sum',
  };
}

// Sheet-level preference tiers for detectors. Lower number = higher priority.
// Summary sheets (Cheat Sheet, UW Comparison) win first because that's where a
// model author shows the canonical headline number. Rollup sheets
// (LP Rollup-A, GP Fees - Hold) win next because they aggregate per-class
// data. Per-class numbered sheets (1-A, 2-A, ..., GP Carry (1.5%)) come last
// because picking one arbitrarily loses the other classes' contribution.
const SHEET_RANK_SUMMARY = /^(cheat\s*sheet|uw\s*comparison|summary|valuation|cover|returns|dashboard|exec\s*summary)/i;
const SHEET_RANK_ROLLUP  = /\b(roll[-\s]?up|rollup|consolidat|combined|total|aggregate|all\s+class|gp\s+fees)\b/i;
const SHEET_RANK_CLASSED = /^(\d+[-\s][A-Z]+|[A-Z]+\s*\(\s*\d+(\.\d+)?\s*%)/;  // "1-A", "GP Carry (1.5%)"

function sheetRank(sheetName) {
  if (SHEET_RANK_SUMMARY.test(sheetName)) return 0;
  if (SHEET_RANK_ROLLUP.test(sheetName)) return 1;
  if (SHEET_RANK_CLASSED.test(sheetName)) return 3;
  return 2;  // generic sheet (no explicit summary/rollup/class markers)
}

function detectCarry(gt, sheets) {
  const carry = { tiers: [], waterfall: {} };
  let confidence = 0.2;

  // Carry label must contain (carry|promote|carried interest). "Total" alone
  // is ambiguous (Total Cash Flow / Total Capital / Total Profit all match too
  // loosely). And we must REJECT labels that clearly describe something else
  // — "pre-carry cash flow", "cash flow (pre-carry)", etc. all slipped through
  // historically, producing nonsense downstream. See SESSION_LOG_02_carry.md.
  const matchesCarryConcept =
    /total.*(carry|carried|promot)|carried.*interest.*total|gp.*(carry|carried|promot)/;
  const isDisqualified =
    /pre.?(carry|promot)|cash.?flow|receivable|payable|fee|operating|capital|equity|profit/;

  // Pass 1: collect all valid candidates across sheets, tagged with sheet rank.
  // Picking the FIRST match (old behavior) or LAST (current, via overwrite)
  // is arbitrary — a model with 20+ "Total Carried Interest" labels across
  // per-class, rollup, and summary sheets picks whichever iterates last,
  // which is effectively random.
  const candidates = [];
  for (const [addr, val] of Object.entries(gt)) {
    if (typeof val !== 'string') continue;
    const lower = val.toLowerCase();
    if (!matchesCarryConcept.test(lower) || isDisqualified.test(lower)) continue;
    const bang = addr.lastIndexOf('!');
    const sheet = addr.substring(0, bang);
    const cellPart = addr.substring(bang + 1);
    const cellMatch = cellPart.match(/^([A-Z]+)(\d+)$/);
    if (!cellMatch) continue;
    const labelCol = cellMatch[1];
    const row = parseInt(cellMatch[2], 10);
    const best = pickRightmostInRange(gt, sheet, row, 'carryTotal', { labelCol });
    if (!best) continue;
    candidates.push({
      addr: best.addr,
      value: best.value,
      sheet,
      rank: sheetRank(sheet),
      nonZero: best.value !== 0,
      // A total carry is a dollar amount. A value in (0,1) is overwhelmingly a
      // carry RATE assumption ("GP Carried Interest" = 0.20) sitting next to its
      // label on an inputs tab — not the dollar total. Deprioritize it hard.
      dollarish: Math.abs(best.value) >= 1000,
    });
  }

  // Pass 2: rank. Dollar-magnitude beats fraction (rate) first of all; then
  // Summary > rollup > generic > per-class; within a tier, prefer non-zero
  // values (a 0-value in a rollup is likely a restated copy of an unpopulated
  // column; picks from live formula columns win).
  candidates.sort((a, b) => {
    if (a.dollarish !== b.dollarish) return a.dollarish ? -1 : 1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.nonZero !== b.nonZero) return a.nonZero ? -1 : 1;
    return 0;
  });

  if (candidates.length > 0) {
    const winner = candidates[0];
    confidence = 0.7;
    // Aggregate across sibling sheets (e.g. "GP Carry (Class A)" + "(Class B)")
    // if the primary sheet name matches the parenthesized-class pattern. The
    // helper returns the plain addr unchanged when no siblings exist.
    carry.totalCell = resolveSiblingAggregate(gt, sheets, winner.addr);
  }

  // Preferred-return detection (unchanged — just iterate once)
  for (const [addr, val] of Object.entries(gt)) {
    if (typeof val !== 'string') continue;
    const lower = val.toLowerCase();
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

  // Collect candidates across all sheets so we can apply sheet-rank
  // preference (summary/rollup > per-facility classed sheets), same pattern
  // as detectCarry. Models with multiple debt facilities on sibling sheets
  // (e.g. "Term Loan (A)" + "Term Loan (B)") get an aggregate instead of
  // an arbitrary single facility's exit balance.
  const candidates = [];
  for (const [addr, val] of Object.entries(gt)) {
    if (typeof val !== 'string') continue;
    const lower = val.toLowerCase();
    // Also match a roll-forward "Debt Balance — Closing" / "Ending Balance" row —
    // a lender model's real exit balance often lives there, not under an
    // "Exit Debt" label, so the old pattern missed it and left credit with no
    // dollar balance to show.
    if (!/exit.*debt|debt.*exit|exit.*balance|loan.*balance|debt.*balance|closing.*balance|ending.*balance/.test(lower)) continue;
    const bang = addr.lastIndexOf('!');
    const sheet = addr.substring(0, bang);
    const rowMatch = addr.match(/(\d+)$/);
    if (!rowMatch) continue;
    const row = parseInt(rowMatch[1], 10);
    const best = pickRightmostInRange(gt, sheet, row, 'exitDebt');
    if (!best) continue;
    // Reject leverage/coverage/yield RATIO cells masquerading as a dollar balance.
    // A label like "Exit Leverage (Debt/EBITDA)" matches /exit.*debt/ but resolves
    // to a turns-of-EBITDA multiple (~1.8) — binding it rendered "Debt at exit: $2",
    // a hard trust-kill for a lender. MAGNITUDE-gated (< $1000) so a genuine
    // multi-tranche / mezzanine balance whose label happens to contain "multiple"/
    // "coverage" is never dropped, and a small "Exit Debt Yield" rate that shares
    // the summary sheet with the real balance is rejected.
    if (Math.abs(best.value) < 1000
        && /leverage|\bratio\b|multiple|coverage|ebitda|\bturns\b|yield/.test(lower)) continue;
    candidates.push({
      addr: best.addr,
      value: best.value,
      sheet,
      rank: sheetRank(sheet),
      nonZero: best.value !== 0,
    });
  }

  candidates.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.nonZero !== b.nonZero) return a.nonZero ? -1 : 1;
    return 0;
  });

  if (candidates.length > 0) {
    const winner = candidates[0];
    // Aggregate sibling-sheet facilities (e.g. "Term Loan (A)" + "Term
    // Loan (B)") into a sum when they share a common prefix and row layout.
    debt.exitBalance = resolveSiblingAggregate(gt, sheets, winner.addr);
    confidence = 0.6;
  }

  return { debt, debtConfidence: confidence };
}

/**
 * Detect stacked scenario blocks on each sheet. Looks for repeating
 * column-A/B label sequences that indicate the sheet stacks several scenarios
 * (e.g., a PE "GP Promote" sheet with 5 blocks at rows 1–92, 93–184, etc.).
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

// ---------------------------------------------------------------------------
// V4 detectors — fund-level metrics, schedules, cap table, debt details,
// carry tiers, covenants. Each is additive: missing detections leave the
// manifest slice empty rather than failing.
// ---------------------------------------------------------------------------

/**
 * Detect LP-facing fund-level metrics: TVPI, DPI, RVPI, netIRR, vintage year,
 * fund size, paid-in, distributed, residual NAV.
 *
 * These are the questions an LP asks even when the model is a PE platform:
 *   "What's the net IRR post-fees?"
 *   "Vintage year?"
 *   "TVPI / DPI progression?"
 */
function detectFundLevelMetrics(gt, sheets) {
  const fund = {};

  const patterns = [
    { key: 'tvpi', regex: /\btvpi\b|total.*value.*paid|total.*value.*to.*paid/i, range: 'tvpi' },
    { key: 'dpi',  regex: /\bdpi\b|distribution.*to.*paid/i, range: 'dpi' },
    { key: 'rvpi', regex: /\brvpi\b|residual.*to.*paid/i, range: 'rvpi' },
    { key: 'netIRR', regex: /net.*irr|irr.*net|lp.*irr/i, range: 'netIRR' },
    { key: 'fundSize', regex: /fund.*size|total.*commitments|fund.*total/i, range: 'fundSize' },
    { key: 'paidIn', regex: /paid.?in|capital.*called|total.*drawn|contributed/i, range: 'paidIn' },
    { key: 'distributed', regex: /total.*distribut|lp.*distribut/i, range: 'distributed' },
    { key: 'residualValue', regex: /residual.*value|residual.*nav|unrealiz(ed|ed value)/i, range: 'residualValue' },
    { key: 'vintageYear', regex: /vintage.*year|vintage|first.*investment.*year/i, range: 'vintageYear' },
  ];

  for (const [addr, val] of Object.entries(gt)) {
    if (typeof val !== 'string') continue;
    const lower = val.toLowerCase();
    for (const p of patterns) {
      if (fund[p.key]) continue;
      if (!p.regex.test(lower)) continue;
      const bang = addr.lastIndexOf('!');
      const sheet = addr.substring(0, bang);
      const rowMatch = addr.match(/(\d+)$/);
      if (!rowMatch) continue;
      const row = parseInt(rowMatch[1], 10);
      const best = pickRightmostInRange(gt, sheet, row, p.range);
      if (best) fund[p.key] = best.addr;
    }
  }

  // If vintageYear wasn't resolved to a cell but timeline has investmentYear,
  // fall back to a numeric constant.
  return fund;
}

/**
 * Detect time-series schedules keyed by label. A schedule is any row where
 * multiple timeline-column cells have numeric values and the row label matches
 * a known concept: capital call, distribution, debt balance, fee, NOI, CF, etc.
 */
function detectSchedules(gt, sheets, timeline) {
  const schedules = [];
  const seen = new Set();

  // Timeline columns; without them we can't distinguish schedule rows.
  const yearCols = timeline?.columnMap ? Object.keys(timeline.columnMap) : [];
  if (yearCols.length < 3) return schedules;

  // Order matters — first match wins. Ratio rows (DSCR/debt-yield/LTV) come
  // BEFORE debt_service / debt_balance because their labels embed those words:
  // "DSCR (NOI / Debt Service)" contains "Debt Service", "Debt Yield (NOI /
  // Debt)" would not match a balance but shares "Debt". Tagging them as their
  // own ratio types (a) lets `ete extract` aggregate them as terminal/avg not
  // sum, and (b) lets the contract emit a correctly-formatted per-year series
  // (a summed debt-yield rendered the fabricated "$1" headline). debt_balance
  // is broadened to catch a roll-forward "Facility/Closing/Ending Balance" row
  // (the centerpiece amortization series a lender/CFO reads).
  const SCHEDULE_PATTERNS = [
    { type: 'capital_call', regex: /capital.*call|call.*schedule|contribut.*schedule|drawdown/i },
    { type: 'distribution', regex: /distribution|dividend|cash.*distribut|lp.*cash/i },
    { type: 'coverage', regex: /\bdscr\b|debt.*service.*coverage|coverage.*ratio|\bicr\b/i },
    { type: 'debt_yield', regex: /debt.*yield/i },
    { type: 'ltv', regex: /\bltv\b|loan.?to.?value/i },
    { type: 'debt_balance', regex: /debt.*balance|loan.*balance|principal.*balance|outstanding.*debt|facility.*balance|(?:debt|loan|facility|senior|mezz|note).*(?:closing|ending).*balance/i },
    { type: 'debt_service', regex: /debt.*service|loan.*payment|principal.*interest/i },
    { type: 'interest_expense', regex: /interest.*expense|interest.*paid|interest.*cost/i },
    { type: 'fee', regex: /management.*fee|fund.*fee|admin.*fee|monitoring.*fee/i },
    { type: 'equity_invested', regex: /equity.*invested.*cumul|cumul.*equity|invested.*capital/i },
    { type: 'cash_flow', regex: /^cash.*flow|net.*cash.*flow|free.*cash.*flow|fcf/i },
    { type: 'noi', regex: /\bnoi\b|net.*operating.*income/i },
  ];

  // Aggregation by schedule kind: balances are point-in-time levels (exit/last),
  // ratios are read at exit too, true flows accumulate over the hold.
  const POINT_IN_TIME_TYPES = new Set(['debt_balance', 'coverage', 'debt_yield', 'ltv']);
  const aggregationForType = (t) => POINT_IN_TIME_TYPES.has(t) ? 'annual_last' : 'annual_sum';

  for (const [addr, val] of Object.entries(gt)) {
    if (typeof val !== 'string') continue;
    const bang = addr.lastIndexOf('!');
    const sheet = addr.substring(0, bang);
    const cellPart = addr.substring(bang + 1);
    const m = cellPart.match(/^([A-Z]+)(\d+)$/);
    if (!m) continue;
    const col = m[1];
    if (col !== 'A' && col !== 'B') continue; // labels live in A/B columns
    const row = parseInt(m[2], 10);

    // Find first matching schedule type
    let matchedType = null;
    for (const sp of SCHEDULE_PATTERNS) {
      if (sp.regex.test(val)) { matchedType = sp.type; break; }
    }
    if (!matchedType) continue;

    // Require at least 3 numeric values across timeline columns
    const series = {};
    for (const yc of yearCols) {
      const v = gt[`${sheet}!${yc}${row}`];
      if (typeof v === 'number') {
        series[yc] = v;
      }
    }
    if (Object.keys(series).length < 3) continue;

    const segKey = `${sheet}:${row}:${matchedType}`;
    if (seen.has(segKey)) continue;
    seen.add(segKey);

    const id = val.toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 30);

    schedules.push({
      id: `${matchedType}_${id}`,
      label: val.trim(),
      type: matchedType,
      sheet,
      row,
      aggregation: aggregationForType(matchedType),
    });

    if (schedules.length >= 50) break; // cap
  }

  return schedules;
}

/**
 * Detect waterfall tiers near an existing carry total cell. Looks on the same
 * sheet as `carry.totalCell` for labeled rows that describe tier structure:
 *   "Return of Capital", "Preferred Return", "Catch-Up", "Residual"
 * Extracts hurdle and split rates when numeric cells are adjacent.
 */
function detectCarryTiers(gt, sheets, carry) {
  const tiers = [];
  if (!carry?.totalCell) return tiers;

  // totalCell can be a string ("Sheet!Cell") or an aggregate
  // ({ cells: [...], op }). For tier detection we use the primary cell's
  // sheet (first in the list) — tier labels live there.
  const primary = typeof carry.totalCell === 'string'
    ? carry.totalCell
    : Array.isArray(carry.totalCell?.cells) ? carry.totalCell.cells[0] : null;
  if (!primary) return tiers;
  const bang = primary.lastIndexOf('!');
  const sheet = primary.substring(0, bang);

  const TIER_PATTERNS = [
    { name: 'Return of Capital', type: 'return_of_capital', regex: /return.*of.*capital|roc\b|rtn.*cap/i },
    { name: 'Preferred Return',  type: 'pref',              regex: /preferred.*return|pref.*return|\bpref\b|hurdle.*rate/i },
    { name: 'Catch-Up',          type: 'catchup',           regex: /catch.?up|gp.*catch/i },
    { name: 'Residual',          type: 'residual',          regex: /residual|above.*hurdle|after.*catch/i },
  ];

  const prefix = sheet + '!';
  for (const [addr, val] of Object.entries(gt)) {
    if (typeof val !== 'string') continue;
    if (!addr.startsWith(prefix)) continue;
    const m = addr.substring(prefix.length).match(/^([A-Z]+)(\d+)$/);
    if (!m || (m[1] !== 'A' && m[1] !== 'B')) continue;
    const row = parseInt(m[2], 10);

    for (const tp of TIER_PATTERNS) {
      if (tiers.some(t => t.type === tp.type)) continue;
      if (!tp.regex.test(val)) continue;
      // Look for a numeric in the range typical for that tier
      let hurdleCell = null;
      let hurdleValue = null;
      const range = tp.type === 'pref' ? 'prefReturn' : null;
      const best = pickRightmostInRange(gt, sheet, row, range);
      if (best) { hurdleCell = best.addr; hurdleValue = best.value; }
      tiers.push({
        name: tp.name,
        type: tp.type,
        labelCell: addr,
        labelText: val.trim(),
        hurdleCell,
        hurdleValue,
      });
      break;
    }
  }

  return tiers;
}

/**
 * Detect debt-detail fields: principal, interest rate, maturity.
 */
function detectDebtDetails(gt, sheets) {
  const details = {};
  for (const [addr, val] of Object.entries(gt)) {
    if (typeof val !== 'string') continue;
    const lower = val.toLowerCase();
    const bang = addr.lastIndexOf('!');
    const sheet = addr.substring(0, bang);
    const rowMatch = addr.match(/(\d+)$/);
    if (!rowMatch) continue;
    const row = parseInt(rowMatch[1], 10);

    if (!details.principal && /loan.*principal|debt.*principal|initial.*debt|face.*value|loan.*amount/.test(lower)) {
      const best = pickRightmostInRange(gt, sheet, row, 'debtPrincipal');
      if (best) details.principal = best.addr;
    }
    if (!details.rate && /(debt|loan|interest).*rate|coupon|interest.*\brate\b/.test(lower)) {
      const best = pickRightmostInRange(gt, sheet, row, 'debtRate');
      if (best) details.rate = best.addr;
    }
    if (!details.maturity && /(debt|loan).*maturity|maturity.*date|maturity.*year|loan.*term/.test(lower)) {
      // maturity can be either a year or an absolute date; pick the first numeric
      const prefix = sheet + '!';
      for (const [a2, v2] of Object.entries(gt)) {
        if (typeof v2 !== 'number') continue;
        if (!a2.startsWith(prefix)) continue;
        const m2 = a2.substring(prefix.length).match(/^([A-Z]+)(\d+)$/);
        if (!m2 || parseInt(m2[2], 10) !== row) continue;
        details.maturity = a2;
        break;
      }
    }
  }
  return details;
}

/**
 * Enrich equity classes with shares-outstanding / ownership-fraction cells
 * near each class's basisCell.
 */
function detectCapTable(gt, sheets, equity) {
  const enrichment = {};
  if (!equity?.classes?.length) return enrichment;

  // For each class, look on the same sheet for "shares" / "ownership" labels
  // within a small row window.
  for (const ec of equity.classes) {
    if (!ec.basisCell) continue;
    const bang = ec.basisCell.lastIndexOf('!');
    const sheet = ec.basisCell.substring(0, bang);
    const baseRow = parseInt(ec.basisCell.match(/(\d+)$/)[1], 10);
    const prefix = sheet + '!';

    for (const [addr, val] of Object.entries(gt)) {
      if (typeof val !== 'string') continue;
      if (!addr.startsWith(prefix)) continue;
      const m = addr.substring(prefix.length).match(/^([A-Z]+)(\d+)$/);
      if (!m) continue;
      const row = parseInt(m[2], 10);
      if (Math.abs(row - baseRow) > 15) continue;
      const lower = val.toLowerCase();

      if (!ec.shares && /shares|units.*outstand/.test(lower)) {
        const best = pickRightmostInRange(gt, sheet, row, 'sharesOutstanding');
        if (best) ec.shares = best.addr;
      }
      if (!ec.ownershipPct && /ownership.*(pct|%|fraction)|ownership\b/.test(lower)) {
        const best = pickRightmostInRange(gt, sheet, row, 'ownershipPct');
        if (best) ec.ownershipPct = best.addr;
      }
    }
  }

  // Total shares outstanding across all classes, if detected once
  for (const [addr, val] of Object.entries(gt)) {
    if (typeof val !== 'string') continue;
    if (!/total.*(shares|units).*outstand|aggregate.*shares/i.test(val)) continue;
    const bang = addr.lastIndexOf('!');
    const sheet = addr.substring(0, bang);
    const row = parseInt(addr.match(/(\d+)$/)[1], 10);
    const best = pickRightmostInRange(gt, sheet, row, 'sharesOutstanding');
    if (best) { enrichment.totalShares = best.addr; break; }
  }

  return enrichment;
}

/**
 * Detect covenant ratios with thresholds. Looks for labels like "DSCR",
 * "LTV", "Interest Coverage", "Leverage Ratio" with an adjacent number
 * that falls in a plausible covenant range.
 */
function detectCovenants(gt, sheets) {
  const covenants = [];
  const patterns = [
    { id: 'dscr', label: 'DSCR',                regex: /\bdscr\b|debt.*service.*coverage/i },
    { id: 'ltv',  label: 'Loan-to-Value',        regex: /\bltv\b|loan.*to.*value/i },
    { id: 'icr',  label: 'Interest Coverage',    regex: /interest.*coverage|\bicr\b/i },
    { id: 'leverage', label: 'Leverage Ratio',   regex: /leverage.*ratio|debt.*to.*ebitda|debt.*to.*equity/i },
    { id: 'occupancy', label: 'Occupancy',       regex: /occupancy.*(ratio|rate|level)|minimum.*occupancy/i },
  ];
  const seen = new Set();
  for (const [addr, val] of Object.entries(gt)) {
    if (typeof val !== 'string') continue;
    for (const p of patterns) {
      if (!p.regex.test(val)) continue;
      const bang = addr.lastIndexOf('!');
      const sheet = addr.substring(0, bang);
      const rowMatch = addr.match(/(\d+)$/);
      if (!rowMatch) continue;
      const row = parseInt(rowMatch[1], 10);
      const key = `${sheet}:${row}:${p.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const best = pickRightmostInRange(gt, sheet, row, 'covenantRatio');
      if (!best) continue;
      covenants.push({
        id: p.id,
        label: val.trim(),
        sheet,
        row,
        cell: best.addr,
        value: best.value,
      });
      break;
    }
  }
  return covenants;
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

// engine.js — AUTO-GENERATED orchestrator (chunked mode)
// Imports sheet modules and executes them in topological order.
// Do not edit manually — re-run the pipeline to regenerate.

import { compute as compute_Assumptions, SHEET_NAME as name_Assumptions, SHEET_DEPENDENCIES as deps_Assumptions } from './sheets/Assumptions.mjs';
import { compute as compute_FnTest, SHEET_NAME as name_FnTest, SHEET_DEPENDENCIES as deps_FnTest } from './sheets/FnTest.mjs';
import { compute as compute_Cashflows, SHEET_NAME as name_Cashflows, SHEET_DEPENDENCIES as deps_Cashflows } from './sheets/Cashflows.mjs';
import { compute as compute_Summary, SHEET_NAME as name_Summary, SHEET_DEPENDENCIES as deps_Summary } from './sheets/Summary.mjs';

/**
 * ComputeContext — shared state for sheet-level compute functions.
 */
class ComputeContext {
  constructor() {
    /** @type {Object<string, any>} */
    this.values = {};
    /** @type {Set<string>|null} Pinned override cells — set() is a no-op for these. */
    this._locked = null;
  }

  /**
   * Get a cell value by qualified address (e.g. "Sheet1!A1").
   * Returns 0 for missing values (safe default for numeric formulas).
   */
  get(addr) {
    const v = this.values[addr];
    return v !== undefined ? v : 0;
  }

  /**
   * Set a cell value by qualified address. Pinned override cells are not
   * overwritten — without this, a sheet's "literal/input cells" pass would
   * clobber run() overrides back to their base-case values.
   */
  set(addr, value) {
    if (this._locked !== null && this._locked.has(addr)) return;
    this.values[addr] = value;
  }

  /**
   * Parse a range string into {sheet, c1, r1, c2, r2}.
   * Returns null if the range doesn't match the expected pattern.
   */
  _parseRange(rangeStr) {
    const match = rangeStr.match(/^(.+)!([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    if (!match) return null;
    const [, sheet, col1, row1, col2, row2] = match;
    return { sheet, c1: colToNum(col1), r1: parseInt(row1), c2: colToNum(col2), r2: parseInt(row2) };
  }

  /**
   * Get a range of values as a flat array.
   * @param {string} rangeStr - e.g. "Sheet1!A1:B3"
   */
  range(rangeStr) {
    const p = this._parseRange(rangeStr);
    if (!p) return [];
    const result = [];
    for (let r = p.r1; r <= p.r2; r++) {
      for (let c = p.c1; c <= p.c2; c++) {
        result.push(this.get(`${p.sheet}!${numToCol(c)}${r}`));
      }
    }
    return result;
  }

  /**
   * Get a range as a 2D array (row-major). Required for INDEX(range, row, col).
   * @param {string} rangeStr - e.g. "Sheet1!A1:C3"
   * @returns {Array<Array<any>>} - [[r1c1, r1c2, ...], [r2c1, r2c2, ...], ...]
   */
  range2d(rangeStr) {
    const p = this._parseRange(rangeStr);
    if (!p) return [];
    const result = [];
    for (let r = p.r1; r <= p.r2; r++) {
      const row = [];
      for (let c = p.c1; c <= p.c2; c++) {
        row.push(this.get(`${p.sheet}!${numToCol(c)}${r}`));
      }
      result.push(row);
    }
    return result;
  }

  /**
   * Return all formula-computed values as KPI map.
   */
  kpis() {
    return { ...this.values };
  }
}

function colToNum(col) {
  let n = 0;
  for (const ch of col) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}
function numToCol(n) {
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

const TOPO_ORDER = ["Assumptions", "FnTest", "Cashflows", "Summary"];

const SHEET_COMPUTE = {
  "Assumptions": compute_Assumptions,
  "FnTest": compute_FnTest,
  "Cashflows": compute_Cashflows,
  "Summary": compute_Summary,
};

/**
 * Execute the full model.
 * @param {Object} [inputs] - Optional cell overrides: { "Sheet!A1": value, ... }
 * @param {Object} [options]
 * @param {boolean} [options.strict] - Throw if any override cell is not read by a formula.
 * @returns {{ values: Object, kpis: Object, meta: Object, unknownOverrides: string[] }}
 */
export function run(inputs = {}, options = {}) {
  const ctx = new ComputeContext();
  const _t0 = Date.now();
  const TOL = 1e-6;
  const _clusterMeta = [];

  // Track which override cells are actually read by a formula. Only instrument
  // when overrides are present so the base case stays zero-overhead. Lets the
  // engine report no-op overrides (typos, missing sheet prefix, stale cells).
  const _overrideKeys = Object.keys(inputs);
  const _readOverrides = new Set();
  if (_overrideKeys.length > 0) {
    const _oset = new Set(_overrideKeys);
    const _origGet = ctx.get.bind(ctx);
    ctx.get = (addr) => { if (_oset.has(addr)) _readOverrides.add(addr); return _origGet(addr); };
  }

  // Apply input overrides, then pin them so each sheet's literal/input pass
  // can't clobber them back to base case.
  for (const [addr, val] of Object.entries(inputs)) {
    ctx.values[addr] = val;
  }
  if (_overrideKeys.length > 0) ctx._locked = new Set(_overrideKeys);


  // Execute sheets in topological order (no circular deps)
  for (const sheetName of TOPO_ORDER) {
    const computeFn = SHEET_COMPUTE[sheetName];
    if (computeFn) computeFn(ctx);
  }


  const _converged = _clusterMeta.every(c => c.converged);
  const _maxDelta = _clusterMeta.reduce((m, c) => Math.max(m, c.maxDelta), 0);
  const _iterations = _clusterMeta.reduce((m, c) => Math.max(m, c.iterations), 0);
  const _perSheetIterations = {};
  for (const c of _clusterMeta) for (const s of c.sheets) _perSheetIterations[s] = c.iterations;
  const meta = {
    converged: _converged,
    iterations: _iterations,
    maxDelta: _maxDelta,
    convergenceTolerance: TOL,
    clusters: _clusterMeta,
    perSheetIterations: _perSheetIterations,
    elapsedMs: Date.now() - _t0,
  };

  const unknownOverrides = _overrideKeys.filter(k => !_readOverrides.has(k));
  if (options.strict && unknownOverrides.length > 0) {
    throw new Error('engine.run(): unknown override cell(s) not read by any formula: ' + unknownOverrides.join(', '));
  }

  return {
    values: { ...ctx.values },
    kpis: ctx.kpis(),
    meta,
    unknownOverrides,
  };
}

export default { run };

// engine.js — AUTO-GENERATED orchestrator (chunked mode)
// Imports sheet modules and executes them in topological order.
// Do not edit manually — re-run the pipeline to regenerate.

import { compute as compute_Assumptions, SHEET_NAME as name_Assumptions, SHEET_DEPENDENCIES as deps_Assumptions } from './sheets/Assumptions.mjs';
import { compute as compute_Cashflows, SHEET_NAME as name_Cashflows, SHEET_DEPENDENCIES as deps_Cashflows } from './sheets/Cashflows.mjs';
import { compute as compute_Summary, SHEET_NAME as name_Summary, SHEET_DEPENDENCIES as deps_Summary } from './sheets/Summary.mjs';

/**
 * ComputeContext — shared state for sheet-level compute functions.
 */
class ComputeContext {
  constructor() {
    /** @type {Object<string, any>} */
    this.values = {};
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
   * Set a cell value by qualified address.
   */
  set(addr, value) {
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

const TOPO_ORDER = ["Assumptions", "Cashflows", "Summary"];

const SHEET_COMPUTE = {
  "Assumptions": compute_Assumptions,
  "Cashflows": compute_Cashflows,
  "Summary": compute_Summary,
};

/**
 * Execute the full model.
 * @param {Object} [inputs] - Optional overrides: { "Sheet!A1": value, ... }
 * @returns {{ values: Object, kpis: Object }}
 */
export function run(inputs = {}) {
  const ctx = new ComputeContext();

  // Apply input overrides
  for (const [addr, val] of Object.entries(inputs)) {
    ctx.set(addr, val);
  }

  // Execute sheets in topological order
  for (const sheetName of TOPO_ORDER) {
    const computeFn = SHEET_COMPUTE[sheetName];
    if (computeFn) computeFn(ctx);
  }

  return {
    values: { ...ctx.values },
    kpis: ctx.kpis(),
  };
}

export default { run };

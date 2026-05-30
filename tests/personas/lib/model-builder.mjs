/**
 * model-builder.mjs — synthetic .xlsx factory for persona usability testing.
 *
 * Produces REALISTIC Excel workbooks (real formulas + cached values + defined
 * names) that round-trip cleanly through `ete init`. All data is synthetic.
 *
 * Why this exists: simulated-user journeys must test the DOCS and UX, not
 * SheetJS plumbing bugs. This helper bakes in the two gotchas that bite every
 * hand-rolled generator:
 *   1. SheetJS-ESM has no fs binding → must write via buffer + node fs.
 *   2. The Rust parser reads CACHED values; a formula cell with no cached value
 *      yields empty ground truth. `.formula()` REQUIRES both.
 *
 * Usage:
 *   const m = new ModelBuilder('Acme Buyout', 'pe_buyout');
 *   const s = m.sheet('Assumptions');
 *   s.label('A1', 'Exit Multiple'); s.value('B1', 12);
 *   m.defineName('ExitMultiple', 'Assumptions', 'B1');
 *   m.write('out.xlsx');
 *
 * @license MIT
 */
import * as XLSX from 'xlsx';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/** A1-style helpers. */
export function colLetter(i) { // 1 -> A, 27 -> AA
  let s = '';
  while (i > 0) { i--; s = String.fromCharCode(65 + (i % 26)) + s; i = Math.floor(i / 26); }
  return s;
}
export function colIndex(letter) {
  let n = 0;
  for (const ch of letter.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function parseAddr(addr) {
  const m = addr.match(/^([A-Z]+)(\d+)$/);
  if (!m) throw new Error(`Bad cell address: ${addr}`);
  return { col: colIndex(m[1]), row: parseInt(m[2], 10) };
}

/** Compound-growth series: start, start*(1+r), ... (n values). */
export function growth(start, rate, n) {
  const out = [];
  let v = start;
  for (let i = 0; i < n; i++) { out.push(v); v = v * (1 + rate); }
  return out;
}
/** Round to cents to keep cached values tidy. */
export function r2(x) { return Math.round(x * 100) / 100; }

class SheetWriter {
  constructor(builder, name) {
    this.builder = builder;
    this.name = name;
    this.cells = {};            // addr -> SheetJS cell object
    this._minCol = Infinity; this._maxCol = 0; this._minRow = Infinity; this._maxRow = 0;
  }
  _track(addr) {
    const { col, row } = parseAddr(addr);
    this._minCol = Math.min(this._minCol, col); this._maxCol = Math.max(this._maxCol, col);
    this._minRow = Math.min(this._minRow, row); this._maxRow = Math.max(this._maxRow, row);
  }
  /** A text/label cell. */
  label(addr, text) { this.cells[addr] = { t: 's', v: String(text) }; this._track(addr); return this; }
  /** A literal numeric cell (an input/assumption). */
  value(addr, num) { this.cells[addr] = { t: 'n', v: num }; this._track(addr); return this; }
  /** A formula cell. cachedValue is REQUIRED — it becomes the ground truth. */
  formula(addr, formulaStr, cachedValue) {
    if (cachedValue === undefined || cachedValue === null || Number.isNaN(cachedValue)) {
      throw new Error(`formula(${addr}): cachedValue is required and must be a number`);
    }
    this.cells[addr] = { t: 'n', f: String(formulaStr).replace(/^=/, ''), v: cachedValue };
    this._track(addr);
    return this;
  }
  /** Write a horizontal run of labels starting at addr. */
  labelRow(addr, texts) {
    const { col, row } = parseAddr(addr);
    texts.forEach((t, i) => this.label(`${colLetter(col + i)}${row}`, t));
    return this;
  }
  /** Write a horizontal run of literal values starting at addr. */
  valueRow(addr, nums) {
    const { col, row } = parseAddr(addr);
    nums.forEach((n, i) => this.value(`${colLetter(col + i)}${row}`, n));
    return this;
  }
  /**
   * Write a horizontal run of formula cells starting at addr.
   * formulaFn(i, colL, row) -> formula string; values[i] -> cached value.
   */
  formulaRow(addr, values, formulaFn) {
    const { col, row } = parseAddr(addr);
    values.forEach((v, i) => this.formula(`${colLetter(col + i)}${row}`, formulaFn(i, colLetter(col + i), row), v));
    return this;
  }
  _toSheet() {
    const ws = {};
    for (const [addr, cell] of Object.entries(this.cells)) ws[addr] = cell;
    if (this._maxRow > 0) {
      ws['!ref'] = `${colLetter(this._minCol)}${this._minRow}:${colLetter(this._maxCol)}${this._maxRow}`;
    } else {
      ws['!ref'] = 'A1:A1';
    }
    return ws;
  }
}

export class ModelBuilder {
  /**
   * @param {string} title - model title (becomes the manifest/model title)
   * @param {string} [modelType] - informational only; the CLI re-detects type
   */
  constructor(title, modelType = 'unknown') {
    this.title = title;
    this.modelType = modelType;
    this._sheets = [];          // in insertion (topological-ish) order
    this._names = [];           // { Name, Ref }
  }
  sheet(name) {
    const existing = this._sheets.find(s => s.name === name);
    if (existing) return existing;
    const s = new SheetWriter(this, name);
    this._sheets.push(s);
    return s;
  }
  /** Define a workbook-level name (drives named-inputs.json). Excel names cannot contain spaces. */
  defineName(name, sheetName, addr) {
    if (/\s/.test(name)) throw new Error(`Defined name "${name}" cannot contain spaces`);
    const m = addr.match(/^([A-Z]+)(\d+)$/);
    if (!m) throw new Error(`defineName: bad address ${addr}`);
    this._names.push({ Name: name, Ref: `${sheetName}!$${m[1]}$${m[2]}` });
    return this;
  }
  toWorkbook() {
    const wb = XLSX.utils.book_new();
    for (const s of this._sheets) XLSX.utils.book_append_sheet(wb, s._toSheet(), s.name);
    if (this._names.length > 0) wb.Workbook = { Names: this._names };
    return wb;
  }
  write(path) {
    const wb = this.toWorkbook();
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer', cellFormula: true });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, buf);
    return path;
  }
}

export default ModelBuilder;

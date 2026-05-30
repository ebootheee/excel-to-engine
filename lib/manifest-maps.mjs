/**
 * excel-to-engine — Downstream contract maps.
 *
 * Emits the small, stable JSON artifacts that production consumers (e.g. an
 * engine-service) read INSTEAD of re-running the engine to discover which cells
 * hold the named outputs/inputs:
 *
 *   chunked/named-outputs.json  — name → { cell, baseCaseValue, type, format }
 *   chunked/named-inputs.json   — name → { cell, type, default }  (defined-names)
 *   chunked/cell-types.json     — cell → "number" | "label" | "boolean" | "empty"
 *
 * These are derived from the manifest + ground truth (always available) and,
 * when the source .xlsx is reachable, enriched with the workbook's defined-name
 * table (the model owner's curated named cells). A consumer can spot-check
 * `baseCaseValue` on import; if it doesn't match what the engine returns, the
 * cell map is stale and the build should fail loudly rather than serve NaN.
 *
 * @license MIT
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, openSync, readSync, closeSync, statSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { StringDecoder } from 'string_decoder';
import { resolveCell } from './manifest.mjs';
import { loadWorkbook, detectInputCells, buildNamedRangeMap } from './excel-parser.mjs';

// ---------------------------------------------------------------------------
// Output-cell enumeration
// ---------------------------------------------------------------------------

/**
 * Helper to locate a schedule sheet/row/label deterministically from manifest.schedules
 * or heuristically from ground truth labels.
 */
function findScheduleRow(manifest, gt, type, regex, fallbackFn = null) {
  // 1. Try manifest.schedules
  if (manifest.schedules) {
    for (const s of manifest.schedules) {
      if (s.type === type || regex.test(s.label)) {
        return { sheet: s.sheet, row: s.row, label: s.label };
      }
    }
  }

  // 2. Try fallback function
  if (fallbackFn) {
    const fb = fallbackFn(manifest, gt);
    if (fb) return fb;
  }

  if (!gt) return null;

  // 3. Try dynamic search on labeling in gt
  const yearCols = manifest.timeline?.columnMap ? Object.keys(manifest.timeline.columnMap) : [];
  if (yearCols.length >= 3) {
    for (const [addr, val] of Object.entries(gt)) {
      if (typeof val !== 'string') continue;
      if (!regex.test(val)) continue;
      const bang = addr.lastIndexOf('!');
      const sheet = addr.substring(0, bang);
      const cellPart = addr.substring(bang + 1);
      const m = cellPart.match(/^([A-Z]+)(\d+)$/);
      if (m && (m[1] === 'A' || m[1] === 'B')) {
        const row = parseInt(m[2], 10);
        let count = 0;
        for (const yc of yearCols) {
          if (typeof gt[`${sheet}!${yc}${row}`] === 'number') count++;
        }
        if (count >= 3) {
          return { sheet, row, label: val.trim() };
        }
      }
    }
  }
  return null;
}

/**
 * Walk the manifest's known output locations and yield { name: cellRef }.
 *
 * This mirrors `resolveBaseCaseOutputs` in manifest.mjs but keeps the cell ref
 * (that function discards it and returns only values). The drift test in
 * tests/cli/test-manifest-maps.mjs asserts the two stay in sync.
 *
 * @param {Object} manifest
 * @param {Object} [gt] Optional ground truth for schedule dynamic detection
 * @returns {Object<string, (string|{cells:string[],op:string})>}
 */
export function enumerateOutputCells(manifest, gt = null) {
  const out = {};

  if (manifest.outputs?.ebitda?.exitValue) out.exitEBITDA = manifest.outputs.ebitda.exitValue;
  if (manifest.outputs?.terminalValue?.cell) out.terminalValue = manifest.outputs.terminalValue.cell;
  if (manifest.outputs?.exitMultiple?.cell) out.exitMultiple = manifest.outputs.exitMultiple.cell;
  // Any other manifest.outputs.<key> with a scalar `cell` — e.g. a user mapping
  // `ete manifest set outputs.netIncome <cell>`, or a non-PE output a detector
  // added. Previously these were silently dropped from the contract.
  if (manifest.outputs) {
    for (const [key, o] of Object.entries(manifest.outputs)) {
      if (key === 'ebitda' || key === 'terminalValue' || key === 'exitMultiple' || (key in out)) continue;
      const ref = typeof o === 'string' ? o : (o && typeof o.cell === 'string' ? o.cell : null);
      if (ref && ref.includes('!')) out[key] = ref;
    }
  }

  if (manifest.equity?.classes) {
    const multi = manifest.equity.classes.length > 1;
    for (const ec of manifest.equity.classes) {
      const prefix = multi ? `${ec.id}.` : '';
      if (ec.grossMOIC) out[`${prefix}grossMOIC`] = ec.grossMOIC;
      if (ec.grossIRR) out[`${prefix}grossIRR`] = ec.grossIRR;
      if (ec.netMOIC) out[`${prefix}netMOIC`] = ec.netMOIC;
      if (ec.netIRR) out[`${prefix}netIRR`] = ec.netIRR;
      if (ec.basisCell) out[`${prefix}equityBasis`] = ec.basisCell;
    }
  }

  if (manifest.carry?.totalCell) out.totalCarry = manifest.carry.totalCell;
  if (manifest.debt?.exitBalance) out.exitDebt = manifest.debt.exitBalance;
  if (manifest.debt?.exitCash) out.exitCash = manifest.debt.exitCash;

  if (manifest.customCells) {
    for (const [key, ref] of Object.entries(manifest.customCells)) {
      if (typeof ref === 'string' && ref.includes('!')) out[key] = ref;
    }
  }

  if (manifest.equity?.totalShares && typeof manifest.equity.totalShares === 'string') {
    out.totalShares = manifest.equity.totalShares;
  }

  // V4: fund-level LP metrics (TVPI/DPI/RVPI/netIRR/distributed/paidIn/...). For
  // VC funds / FoF these ARE the headline numbers; they must cross into the
  // contract, not just live in the manifest. Mirrors resolveBaseCaseOutputs.
  if (manifest.fundLevel) {
    for (const [key, val] of Object.entries(manifest.fundLevel)) {
      if (typeof val === 'string' && val.includes('!')) out[key] = val;
    }
  }

  // V4: debt detail fields (principal/rate/maturity) under "debt.*" shorthand.
  if (manifest.debt) {
    for (const key of ['principal', 'rate', 'maturity']) {
      const ref = manifest.debt[key];
      if (typeof ref === 'string' && ref.includes('!')) {
        out[`debt${key.charAt(0).toUpperCase()}${key.slice(1)}`] = ref;
      }
    }
  }

  // V4: covenants (DSCR/LTV/ICR/...) — headline answers for credit/debt models.
  if (Array.isArray(manifest.covenants)) {
    for (const cov of manifest.covenants) {
      if (cov && typeof cov.cell === 'string' && cov.cell.includes('!')) out[cov.id] = cov.cell;
    }
  }

  // Dynamic schedule / time-series outputs (when a timeline is defined).
  if (manifest.timeline?.columnMap) {
    const cols = Object.keys(manifest.timeline.columnMap).sort((colA, colB) => {
      if (colA.length !== colB.length) return colA.length - colB.length;
      return colA.localeCompare(colB);
    });

    if (cols.length > 0) {
      const colStart = cols[0];
      const colEnd = cols[cols.length - 1];

      const addScheduleKey = (name, type, regex, fallbackFn = null) => {
        const rowData = findScheduleRow(manifest, gt, type, regex, fallbackFn);
        if (rowData) {
          out[name] = `${rowData.sheet}!${colStart}${rowData.row}:${colEnd}${rowData.row}`;
        }
      };

      // 1. distributionsToEquity
      addScheduleKey('distributionsToEquity', 'distribution', /distribution|dividend|cash.*distribut|lp.*cash/i);

      // 2. outstandingDebt
      addScheduleKey('outstandingDebt', 'debt_balance', /debt.*balance|loan.*balance|principal.*balance|outstanding.*debt/i, (m, g) => {
        if (m.debt?.exitBalance) {
          const match = m.debt.exitBalance.match(/^([^!]+)!([A-Z]+)(\d+)$/);
          if (match) {
            return {
              sheet: match[1],
              row: parseInt(match[3], 10),
              label: g ? (labelForCell(g, m.debt.exitBalance) || "Outstanding Debt Balance") : "Outstanding Debt Balance"
            };
          }
        }
        return null;
      });

      // 3. equityBase
      addScheduleKey('equityBase', 'equity_invested', /equity.*basis|equity.*base|basis.*equity|invested.*capital|cumul.*equity|nav|net.*asset.*value/i, (m, g) => {
        if (m.equity?.classes?.[0]?.basisCell) {
          const match = m.equity.classes[0].basisCell.match(/^([^!]+)!([A-Z]+)(\d+)$/);
          if (match) {
            return {
              sheet: match[1],
              row: parseInt(match[3], 10),
              label: g ? (labelForCell(g, m.equity.classes[0].basisCell) || "Equity Base / NAV") : "Equity Base / NAV"
            };
          }
        }
        return null;
      });

      // 4. freeCashFlow
      addScheduleKey('freeCashFlow', 'cash_flow', /^cash.*flow|net.*cash.*flow|free.*cash.*flow|fcf|net.*operating.*income|\bnoi\b/i);

      // 5. Per-class distributions (split by class)
      if (manifest.equity?.classes) {
        for (const ec of manifest.equity.classes) {
          if (!ec.id) continue; // a class detected via a returns anchor may lack an id; can't key a per-class schedule
          const cid = ec.id.toLowerCase();
          const clabel = (ec.label || '').toLowerCase();
          addScheduleKey(
            `${ec.id}.distributions`,
            'distribution',
            new RegExp(`(distribution|dividend|cash.*distribut).*(${cid}|${clabel})|(${cid}|${clabel}).*(distribution|dividend|cash.*distribut)`, 'i')
          );
        }
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Inference helpers
// ---------------------------------------------------------------------------

/** Collapse a name to its alphanumeric core so "Gross_MOIC" matches "grossMOIC". */
function normalizeName(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Display-format hint for a numeric value, inferred from its name (and value
 *  when available — a bare number in (-1,1) is almost always a rate/percent). */
function inferFormat(name, value) {
  const n = name.toLowerCase();
  // LTV is always a fraction; "leverage" is an LTV fraction when small (<1.5)
  // but a Debt/EBITDA multiple when large — disambiguate by value.
  if (/\bltv\b|loan.?to.?value/.test(n)) return 'fraction';
  if (/leverage/.test(n)) return (typeof value === 'number' && Math.abs(value) < 1.5) ? 'fraction' : 'multiple';
  // Ratios shown as "x": MOIC/multiple/TVPI/DPI/RVPI/DSCR/ICR/coverage.
  if (/multiple|moic|\bmoc\b|tvpi|dpi|rvpi|dscr|\bicr\b|coverage|turns/.test(n)) return 'multiple';
  // Rates/percentages shown as "%": IRR, cap rate, yield, LTV, growth, margin, retention, churn.
  if (/irr|wacc|pref|discount|yield|hurdle|\bltv\b|occupancy|margin|growth|retention|churn|escalation|\brate\b|return|\bpct\b|percent/.test(n)) return 'fraction';
  // Value-aware: a fraction in (-1,1) that isn't a price is overwhelmingly a rate.
  if (typeof value === 'number' && Math.abs(value) > 0 && Math.abs(value) < 1 && !/price|share/.test(n)) return 'fraction';
  // Dollar figures.
  if (/ebitda|terminal|value|carry|basis|gain|cash|debt|price|proceeds|revenue|equity|capital|noi|distribut|\bfund|paid|\bnav\b|commit|contribut|principal|\barr\b|income|sde|size/.test(n)) return 'currency';
  return 'number';
}

/** Find a human label for a cell: the leftmost string cell on the same row. */
function labelForCell(gt, cellRef) {
  if (typeof cellRef !== 'string' || !cellRef.includes('!')) return null;
  const bang = cellRef.lastIndexOf('!');
  const sheet = cellRef.slice(0, bang);
  const m = cellRef.slice(bang + 1).match(/^[A-Z]+(\d+)$/);
  if (!m) return null;
  const row = m[1];
  const prefix = sheet + '!';
  let best = null; // { col, text }
  for (const [addr, v] of Object.entries(gt)) {
    if (typeof v !== 'string') continue;
    if (!addr.startsWith(prefix)) continue;
    const cp = addr.slice(prefix.length);
    const cm = cp.match(/^([A-Z]+)(\d+)$/);
    if (!cm || cm[2] !== row) continue;
    if (!best || cm[1].length < best.col.length || (cm[1].length === best.col.length && cm[1] < best.col)) {
      best = { col: cm[1], text: v.trim() };
    }
  }
  return best ? best.text : null;
}

/** Humanize a camelCase / dotted name for a fallback label. Handles acronym
 *  runs so "NewARRGrowth" → "New ARR Growth" (not "New ARRGrowth"). */
function humanize(name) {
  return name
    .replace(/^[a-z]+\./, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')      // camelCase boundary
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')   // ACRONYMWord → ACRONYM Word
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Heuristic UI metadata for a lever (slider min/max/step) so an app can render
 * inputs without the developer inventing bounds. These are SUGGESTED ranges,
 * centered on the model's own default — clearly approximate, easy to override.
 */
function suggestRange(format, v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v === 0) return null;
  const niceStep = (span) => {
    if (!(span > 0)) return undefined;
    const mag = Math.pow(10, Math.floor(Math.log10(span / 10)));
    const norm = span / 10 / mag;
    const m = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
    return +(m * mag).toPrecision(2);
  };
  if (format === 'fraction') {
    // Most rates live in [0,1], but some legitimately exceed 1 (net revenue
    // retention 112%, a >1x coverage expressed as a fraction). NEVER clamp the
    // max below the default, or an app's slider would silently cap the headline.
    if (v > 1) return { min: +(Math.max(0, v - 0.5)).toFixed(2), max: +(v * 1.5).toFixed(2), step: 0.01 };
    const max = Math.min(1, Math.max(v * 2, v + 0.1));
    return { min: 0, max: +max.toFixed(4), step: v <= 0.05 ? 0.0025 : 0.01 };
  }
  if (format === 'multiple') {
    const min = Math.max(0, +(v * 0.5).toFixed(2));
    return { min, max: +(v * 1.6).toFixed(2), step: v >= 4 ? 0.5 : 0.25 };
  }
  // currency / number
  const max = v * 2;
  return { min: 0, max: +max.toPrecision(3), step: niceStep(max) };
}

/**
 * Does a schedule represent a stock/balance (a point-in-time level) rather than
 * a flow? Summing a balance across years double-counts the same standing
 * amount — the debt outstanding in 2025 is not added to the debt outstanding in
 * 2026; the meaningful scalar is the terminal (exit-year) level. Flows
 * (distributions, cash flow) genuinely accumulate, so their life-to-date sum is
 * correct. `perYear[]` remains authoritative for the full series either way.
 *
 * The schedule keys are emitted deterministically by `enumerateOutputCells`:
 * `outstandingDebt` and `equityBase` (NAV / cumulative equity) are balances;
 * `distributionsToEquity`, `freeCashFlow`, and per-class `<id>.distributions`
 * are flows. The word-boundary clause also catches any future balance schedule.
 */
function isBalanceSchedule(name) {
  return /(^|\.)(outstandingDebt|equityBase)$/.test(name) ||
    /\b(debt|balance|outstanding|nav)\b/i.test(name);
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

/**
 * Build the named-outputs map. Manifest semantic outputs are the spine;
 * single-cell defined names override the cell when they match a semantic name
 * (the model owner's curated cell is authoritative over heuristic detection).
 *
 * @param {Object} manifest
 * @param {Object} gt - ground truth { "Sheet!Cell": value }
 * @param {Map<string,string>} [namedRangeMap] - cell → defined-name
 * @returns {Object} namedOutputs map
 */
export function collectNamedOutputs(manifest, gt, namedRangeMap = new Map()) {
  // Invert the cell→name table into normalizedName → { name, cell }, single cells only.
  const definedByName = new Map();
  for (const [cell, name] of namedRangeMap.entries()) {
    if (typeof cell !== 'string' || cell.includes(':')) continue; // skip ranges
    definedByName.set(normalizeName(name), { name, cell });
  }

  const cells = enumerateOutputCells(manifest, gt);
  const result = {};

  for (const [name, manifestRef] of Object.entries(cells)) {
    let cell = manifestRef;
    let source = 'manifest';
    let excelName = typeof manifestRef === 'string' ? namedRangeMap.get(manifestRef) || null : null;
    let manifestCell;

    if (typeof manifestRef === 'string' && manifestRef.includes(':')) {
      // It is a range / schedule!
      const [sheet, range] = manifestRef.split('!');
      const row = parseInt(range.match(/\d+/)[0], 10);
      const label = labelForCell(gt, `${sheet}!A${row}`) || labelForCell(gt, `${sheet}!B${row}`) || humanize(name);

      const cols = manifest.timeline?.columnMap ? Object.keys(manifest.timeline.columnMap).sort((colA, colB) => {
        if (colA.length !== colB.length) return colA.length - colB.length;
        return colA.localeCompare(colB);
      }) : [];

      const perYear = [];
      for (const col of cols) {
        const year = manifest.timeline.columnMap[col];
        const addr = `${sheet}!${col}${row}`;
        const value = gt[addr];
        if (typeof value === 'number') {
          perYear.push({ year, value });
        }
      }

      // The scalar baseCaseValue must reflect what the series MEANS. For a
      // balance (debt outstanding, equity base/NAV) the cross-year sum is
      // meaningless double-counting — the right scalar is the terminal level;
      // for a flow it's the life-to-date sum. perYear[] is authoritative.
      const balance = isBalanceSchedule(name);
      const lastPoint = perYear.length ? perYear[perYear.length - 1] : null;
      const baseCaseValue = perYear.length === 0
        ? null
        : (balance ? lastPoint.value : perYear.reduce((acc, p) => acc + p.value, 0));

      result[name] = {
        cellRange: manifestRef,
        perYear,
        label,
        type: 'schedule',
        format: 'currency',
        // 'sum' (flows accumulate) vs 'terminal' (balances are point-in-time);
        // tells a consumer how the scalar was derived from perYear[].
        aggregation: balance ? 'terminal' : 'sum',
        baseCaseValue,
        ...(balance && lastPoint ? { terminalYear: lastPoint.year } : {}),
        source,
      };
      continue;
    }

    const match = definedByName.get(normalizeName(name));
    if (match && match.cell !== manifestRef) {
      // A defined name with this semantic name points elsewhere — trust it.
      manifestCell = manifestRef;
      cell = match.cell;
      excelName = match.name;
      source = 'defined-name';
    } else if (excelName) {
      source = 'defined-name';
    }

    const baseCaseValue = resolveCell(gt, cell);
    const entry = {
      cell,
      label: labelForCell(gt, cell) || humanize(name),
      type: 'number',
      format: inferFormat(name, baseCaseValue),
      baseCaseValue,
      source,
    };
    if (excelName) entry.excelName = excelName;
    if (manifestCell && manifestCell !== cell) entry.manifestCell = manifestCell;
    result[name] = entry;
  }

  return result;
}

function findExitYearSelector(manifest, gt) {
  if (!gt) return null;
  const targetYear = manifest.timeline?.exitYear;
  if (!targetYear) return null;
  for (const [addr, val] of Object.entries(gt)) {
    if (val === targetYear) {
      const label = labelForCell(gt, addr);
      if (label && /exit.*year|hold.*period|selection|select.*year/i.test(label)) {
        return addr;
      }
    }
  }
  return null;
}

function findHurdleCell(manifest, gt) {
  if (!gt) return null;
  const prefReturn = manifest.carry?.waterfall?.prefReturn;
  if (typeof prefReturn !== 'number') return null;
  for (const [addr, val] of Object.entries(gt)) {
    if (val === prefReturn) {
      const label = labelForCell(gt, addr);
      if (label && /pref|hurdle|minimum.*return/i.test(label)) {
        return addr;
      }
    }
  }
  return null;
}

/**
 * Build the named-inputs map from the workbook's defined-name table.
 *
 * Only cells that (a) carry a defined name and (b) are read by ≥1 formula are
 * emitted — the model owner's curated, load-bearing inputs. `affectsOutputs` is
 * intentionally absent until the dependency-graph artifact lands (Round 2).
 *
 * @param {Object} workbook - SheetJS workbook
 * @param {Object} manifest - Optional manifest to extract driver cells
 * @param {Object} gt - Optional ground truth to resolve cell values
 * @returns {Object} namedInputs map
 */
export function collectNamedInputs(workbook, manifest = null, gt = null) {
  const inputs = workbook ? detectInputCells(workbook, { namedRangesOnly: true }) : [];
  const result = {};
  for (const inp of inputs) {
    const key = inp.name; // defined-name guaranteed present (namedRangesOnly)
    if (!key || result[key]) continue;
    const format = inferFormat(key, inp.value);
    const entry = {
      cell: `${inp.sheet}!${inp.cell}`,
      label: humanize(key),
      type: inp.type === 'number' ? 'number' : inp.type,
      format,                       // so a UI formats the lever like its outputs
      default: inp.value,
      excelName: inp.name,
      referencedBy: inp.referencedBy,
      source: 'defined-name',
    };
    // Suggested slider bounds (approximate, centered on the model's default).
    const range = suggestRange(format, inp.value);
    if (range) { entry.min = range.min; entry.max = range.max; if (range.step != null) entry.step = range.step; }
    result[key] = entry;
  }

  // Pin the driver cells (Request C) if manifest + gt are available
  if (manifest && gt) {
    // 1. exitMultiple
    const exitMultCell = manifest.outputs?.exitMultiple?.cell;
    if (exitMultCell && !result.exitMultiple) {
      const val = resolveCell(gt, exitMultCell);
      result.exitMultiple = {
        cell: exitMultCell,
        label: 'Exit Multiple',
        type: 'number',
        default: typeof val === 'number' ? val : null,
        source: 'manifest-driver',
      };
    }

    // 2. exitYearSelector
    const exitYearSelectorCell = findExitYearSelector(manifest, gt);
    if (exitYearSelectorCell && !result.exitYearSelector) {
      const val = resolveCell(gt, exitYearSelectorCell);
      result.exitYearSelector = {
        cell: exitYearSelectorCell,
        label: 'Exit Year Selector',
        type: 'number',
        default: typeof val === 'number' ? val : null,
        source: 'manifest-driver',
      };
    }

    // 3. hurdleRate
    const hurdleCell = findHurdleCell(manifest, gt);
    if (hurdleCell && !result.hurdleRate) {
      const val = resolveCell(gt, hurdleCell);
      result.hurdleRate = {
        cell: hurdleCell,
        label: 'Hurdle Rate',
        type: 'number',
        default: typeof val === 'number' ? val : null,
        source: 'manifest-driver',
      };
    }
  }

  return result;
}

/**
 * Classify every ground-truth cell so consumers can tell a label string from a
 * numeric output, and a real 0 (present, "number") from a never-computed cell
 * (absent from this map entirely).
 *
 * @param {Object} gt - ground truth
 * @returns {Object<string,string>} cell → "number"|"label"|"boolean"|"empty"
 */
export function collectCellTypes(gt) {
  const types = {};
  for (const [addr, v] of Object.entries(gt)) {
    if (typeof v === 'number') types[addr] = 'number';
    else if (typeof v === 'boolean') types[addr] = 'boolean';
    else if (typeof v === 'string') types[addr] = 'label';
    else types[addr] = 'empty';
  }
  return types;
}

// ---------------------------------------------------------------------------
// Hash + orchestration
// ---------------------------------------------------------------------------

const colToNum = col => {
  let num = 0;
  for (let i = 0; i < col.length; i++) num = num * 26 + (col.charCodeAt(i) - 64);
  return num;
};
const numToCol = num => {
  let col = '';
  while (num > 0) {
    const rem = (num - 1) % 26;
    col = String.fromCharCode(65 + rem) + col;
    num = Math.floor((num - 1) / 26);
  }
  return col;
};

/**
 * Parse a qualified ref token into numeric bounds. Handles a single cell
 * (`Sheet!A1`) or a range token (`Sheet!A1:B10`). Sheet names cannot contain
 * `!` or `:`, so the split is unambiguous. Returns null for anything that isn't
 * an A1-style cell/range (defined names, malformed tokens). The dependency-graph
 * emitter (issue #32) keeps ranges as tokens, so consumers see both forms.
 *
 * @returns {{sheet:string, c1:number, r1:number, c2:number, r2:number, isRange:boolean}|null}
 */
function parseRefToken(token) {
  if (typeof token !== 'string') return null;
  const bang = token.indexOf('!');
  if (bang < 0) return null;
  const sheet = token.slice(0, bang);
  const addr = token.slice(bang + 1);
  const colon = addr.indexOf(':');
  if (colon < 0) {
    const m = /^([A-Z]+)(\d+)$/.exec(addr);
    if (!m) return null;
    const c = colToNum(m[1]);
    const r = parseInt(m[2], 10);
    return { sheet, c1: c, r1: r, c2: c, r2: r, isRange: false };
  }
  const ma = /^([A-Z]+)(\d+)$/.exec(addr.slice(0, colon));
  const mb = /^([A-Z]+)(\d+)$/.exec(addr.slice(colon + 1));
  if (!ma || !mb) return null;
  let c1 = colToNum(ma[1]); let r1 = parseInt(ma[2], 10);
  let c2 = colToNum(mb[1]); let r2 = parseInt(mb[2], 10);
  if (c1 > c2) { const t = c1; c1 = c2; c2 = t; }
  if (r1 > r2) { const t = r1; r1 = r2; r2 = t; }
  return { sheet, c1, r1, c2, r2, isRange: true };
}

function expandRange(rangeStr) {
  const p = parseRefToken(rangeStr);
  if (!p) return rangeStr && rangeStr.includes('!') ? [rangeStr] : [];
  if (!p.isRange) return [rangeStr];
  const results = [];
  for (let r = p.r1; r <= p.r2; r++) {
    for (let c = p.c1; c <= p.c2; c++) {
      results.push(`${p.sheet}!${numToCol(c)}${r}`);
    }
  }
  return results;
}

/**
 * Load the `edges` map from a (possibly >0.5 GB) `dependency-graph.json` without
 * ever materializing the whole file as one string. `readFileSync(path,'utf-8')`
 * / `JSON.parse` cap out at Node's ~512 MiB max string length — a 532 MB graph
 * threw "Cannot create a string longer than 0x1fffffe8 characters", and the
 * closures were silently dropped. The Rust emitter writes one edge per line
 * (still valid JSON), so we read the file in chunks and `JSON.parse` each small
 * `"key":[...]` line on its own. Returns the edges object, or null if the file
 * isn't the expected newline-delimited form (falls back to a whole-file parse).
 *
 * @param {string} graphPath
 * @param {number} [streamThreshold] - byte size above which to stream (testing hook)
 * @returns {Object<string,string[]>|null}
 */
export function loadDependencyEdges(graphPath, streamThreshold = 256 * 1024 * 1024) {
  // Small graphs (synthetic tests, modest models) fit comfortably in a string —
  // parse the whole thing; it tolerates any internal formatting.
  const size = statSync(graphPath).size;
  if (size < streamThreshold) {
    return JSON.parse(readFileSync(graphPath, 'utf-8')).edges || {};
  }

  // Large graph: stream it. One edge per line — parse each line independently.
  const edges = {};
  const fd = openSync(graphPath, 'r');
  try {
    const CHUNK = 1 << 26; // 64 MB
    const buf = Buffer.allocUnsafe(CHUNK);
    const decoder = new StringDecoder('utf8'); // handles multi-byte split at chunk edges
    let leftover = '';
    let n;
    const flush = (line) => {
      // Entry lines start with a quoted key; the header ('{...edges":{') and
      // footer ('},"edgeCount":N}') don't. Strip a trailing comma, wrap, parse.
      if (line.length === 0 || line.charCodeAt(0) !== 34 /* " */) return;
      const s = line.charCodeAt(line.length - 1) === 44 /* , */ ? line.slice(0, -1) : line;
      try {
        const obj = JSON.parse('{' + s + '}');
        for (const k in obj) edges[k] = obj[k];
      } catch { /* not an edge line — ignore */ }
    };
    while ((n = readSync(fd, buf, 0, CHUNK, null)) > 0) {
      const text = leftover + decoder.write(buf.subarray(0, n));
      let start = 0;
      let nl;
      while ((nl = text.indexOf('\n', start)) !== -1) {
        flush(text.slice(start, nl));
        start = nl + 1;
      }
      leftover = text.slice(start);
    }
    leftover += decoder.end();
    flush(leftover);
  } finally {
    closeSync(fd);
  }
  return edges;
}

/** First index `i` in sorted `arr` with `arr[i] >= target` (binary search). */
function lowerBound(arr, target) {
  let lo = 0; let hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < target) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * Index a set of single-cell coordinates as sheet → { cols: Map<col, sorted
 * rows>, sortedCols: number[] }, for O(log n) interval queries when a range
 * token must be expanded against it. Range/garbage tokens are skipped (callers
 * index single cells only). The `sortedCols` array lets a range query touch only
 * the columns inside [c1,c2] (binary search) instead of scanning every column of
 * the sheet — the difference between cheap and quadratic on the monster sheets,
 * where a narrow range was costing one iteration per populated column (#32).
 *
 * @param {Iterable<string>} cells - "Sheet!A1" coordinates
 * @returns {Map<string, {cols: Map<number, number[]>, sortedCols: number[]}>}
 */
function buildCellIndex(cells) {
  const idx = new Map();
  for (const cell of cells) {
    const p = parseRefToken(cell);
    if (!p || p.isRange) continue;
    let entry = idx.get(p.sheet);
    if (!entry) { entry = { cols: new Map(), sortedCols: null }; idx.set(p.sheet, entry); }
    let rows = entry.cols.get(p.c1);
    if (!rows) { rows = []; entry.cols.set(p.c1, rows); }
    rows.push(p.r1);
  }
  for (const entry of idx.values()) {
    for (const rows of entry.cols.values()) rows.sort((a, b) => a - b);
    entry.sortedCols = [...entry.cols.keys()].sort((a, b) => a - b);
  }
  return idx;
}

/**
 * Call `fn(cell)` for every indexed cell inside the range `p`. Touches only the
 * columns within [c1,c2] (binary search over `sortedCols`) and, within each, the
 * rows within [r1,r2] (binary search) — so a narrow range stays cheap even on a
 * monster sheet with thousands of populated columns. This is the lazy substitute
 * for materializing an expanded range (issue #32).
 */
function forEachCellInRange(idx, p, fn) {
  const entry = idx.get(p.sheet);
  if (!entry) return;
  const { cols, sortedCols } = entry;
  for (let ci = lowerBound(sortedCols, p.c1); ci < sortedCols.length && sortedCols[ci] <= p.c2; ci++) {
    const col = sortedCols[ci];
    const rows = cols.get(col);
    const colLetter = numToCol(col);
    for (let i = lowerBound(rows, p.r1); i < rows.length && rows[i] <= p.r2; i++) {
      fn(`${p.sheet}!${colLetter}${rows[i]}`);
    }
  }
}

/**
 * Single BFS pass per named output over the forward edge map (cell → cells/ranges
 * it reads). For each output it records (a) the named inputs it transitively
 * depends on (`dependsOnNamedInputs`) and (b) whether its closure passes through
 * an `_fn` fallback cell (`resolvesThroughFallback`); and on each named input,
 * the outputs it affects (`affectsOutputs`). Mutates the maps and returns the
 * list of fallback violations.
 *
 * Range-aware: the emitter keeps ranges as compact tokens (`Sheet!A1:B10`), so a
 * token is expanded lazily against three pre-built indexes — formula-cell keys
 * (to continue traversal), named-input cells, and fallback cells — via interval
 * queries. This produces closures identical to the old fully-expanded graph
 * without ever materializing the 37 GB expansion (issue #32).
 *
 * When `attachDeps` is false (no graph available — e.g. a slimmed dir), the dep
 * closures are not written (so a consumer can tell "not computed" from "depends
 * on nothing"), but the fallback audit still runs over the empty edge map — it
 * catches any output cell that is *itself* a stub. This matches the prior
 * audit's behavior when the graph was absent.
 *
 * @param {Object} namedOutputs - name → { cell|cellRange, ... } (mutated)
 * @param {Object} namedInputs - name → { cell, ... } (mutated)
 * @param {Object<string,string[]>} edges - cell → [cells/ranges it reads]
 * @param {Object<string,Object>} [fallbacks] - fallback cell → { function, ... }
 * @param {{attachDeps?: boolean}} [opts]
 * @returns {Array<{output:string, cell:string, function:string}>}
 */
export function computeOutputClosures(namedOutputs, namedInputs, edges, fallbacks = {}, opts = {}) {
  const attachDeps = opts.attachDeps !== false;
  const inputCellToName = new Map();
  for (const [name, info] of Object.entries(namedInputs)) {
    if (typeof info.cell === 'string') inputCellToName.set(info.cell, name);
  }
  const fallbackCells = new Set(Object.keys(fallbacks));

  // Indexes for lazy range expansion. The formula-key index is the large one
  // (one entry per formula cell); inputs + fallbacks are small.
  const formulaIdx = buildCellIndex(Object.keys(edges));
  const inputIdx = buildCellIndex(inputCellToName.keys());
  const fallbackIdx = fallbackCells.size > 0 ? buildCellIndex(fallbackCells) : null;

  const affects = {}; // input name → Set(output names)
  const violations = [];

  for (const [outName, out] of Object.entries(namedOutputs)) {
    const targets = [];
    if (typeof out.cell === 'string') targets.push(out.cell);
    else if (typeof out.cellRange === 'string') targets.push(...expandRange(out.cellRange));
    if (targets.length === 0) continue;

    const deps = new Set();
    let fallbackHit = null;
    const seen = new Set();
    const queue = [];
    // Range tokens repeat heavily (on the real model, 3.7M range refs collapse to
    // ~1M distinct tokens; expanding with repeats touches 2.8B cells vs 34M for
    // the distinct set — an ~84× blowup that made the per-output BFS take ~15 min).
    // Expanding a token once per output is sufficient: every cell it covers is
    // already added to `seen`, so a repeat yields nothing new.
    const seenRanges = new Set();

    // Discover a single cell: record interest, enqueue if it has outgoing edges.
    const discover = (cell) => {
      const inName = inputCellToName.get(cell);
      if (inName) deps.add(inName);
      if (!fallbackHit && fallbackCells.has(cell)) fallbackHit = cell;
      if (!seen.has(cell)) {
        seen.add(cell);
        if (edges[cell]) queue.push(cell);
      }
    };

    for (const t of targets) discover(t);

    for (let qi = 0; qi < queue.length; qi++) {
      const refs = edges[queue[qi]];
      if (!refs) continue;
      for (const ref of refs) {
        // Sheet names contain no ':', so a ':' marks a range token.
        if (ref.indexOf(':') === -1) {
          discover(ref);
          continue;
        }
        if (seenRanges.has(ref)) continue; // already expanded this exact token
        seenRanges.add(ref);
        const p = parseRefToken(ref);
        if (!p) continue;
        forEachCellInRange(formulaIdx, p, discover);          // continue traversal
        forEachCellInRange(inputIdx, p, discover);            // leaf named inputs
        if (fallbackIdx && !fallbackHit) forEachCellInRange(fallbackIdx, p, discover);
      }
    }

    if (attachDeps) {
      out.dependsOnNamedInputs = [...deps].sort();
      for (const inName of deps) (affects[inName] ||= new Set()).add(outName);
    }
    if (fallbackHit) {
      const fn = fallbacks[fallbackHit]?.function || 'UNKNOWN';
      out.resolvesThroughFallback = { cell: fallbackHit, function: fn };
      violations.push({ output: outName, cell: fallbackHit, function: fn });
    }
  }

  if (attachDeps) {
    for (const [name, info] of Object.entries(namedInputs)) {
      info.affectsOutputs = affects[name] ? [...affects[name]].sort() : [];
    }
  }
  return violations;
}

/**
 * Round-2 closure enrichment (back-compat wrapper): attaches
 * `dependsOnNamedInputs` / `affectsOutputs` only, no fallback audit. Prefer
 * {@link computeOutputClosures} when the fallback map is available so both run
 * in a single BFS pass.
 */
export function attachDependencyClosures(namedOutputs, namedInputs, edges) {
  computeOutputClosures(namedOutputs, namedInputs, edges, {});
}

function collectFileFallbacks(chunkedDir) {
  const sheetsDir = join(chunkedDir, 'sheets');
  const fallbacks = {};
  if (existsSync(sheetsDir)) {
    const files = readdirSync(sheetsDir).filter(f => f.endsWith('.mjs') && f !== '_helpers.mjs');
    for (const file of files) {
      const content = readFileSync(join(sheetsDir, file), 'utf-8');
      const regex = /ctx\.set\("([^"]+)",\s*([\s\S]*?)\);\r?\n/g;
      let match;
      while ((match = regex.exec(content)) !== null) {
        const cell = match[1];
        const formula = match[2];
        if (formula.includes('_fn(')) {
          const fnMatch = formula.match(/_fn\('([^']+)'/);
          const fnName = fnMatch ? fnMatch[1] : 'UNKNOWN';
          fallbacks[cell] = {
            function: fnName,
            formula: formula.trim()
          };
        }
      }
    }
  }
  return fallbacks;
}

/**
 * Carry forward dependency closures from the existing named maps on disk onto
 * freshly-built maps, when they can't be recomputed (dependency-graph.json was
 * deleted after the first init). Keeps the contract stable across refreshes.
 * Returns true if any closure was preserved.
 */
function carryForwardClosures(chunkedDir, namedOutputs, namedInputs) {
  let preserved = false;
  const tryLoad = (f) => {
    const p = join(chunkedDir, f);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
  };
  const prevOut = tryLoad('named-outputs.json');
  if (prevOut?.namedOutputs) {
    for (const [name, out] of Object.entries(namedOutputs)) {
      const prev = prevOut.namedOutputs[name];
      if (prev && Array.isArray(prev.dependsOnNamedInputs)) {
        out.dependsOnNamedInputs = prev.dependsOnNamedInputs;
        preserved = true;
      }
    }
  }
  if (namedInputs) {
    const prevIn = tryLoad('named-inputs.json');
    if (prevIn?.namedInputs) {
      for (const [name, inp] of Object.entries(namedInputs)) {
        const prev = prevIn.namedInputs[name];
        if (prev && Array.isArray(prev.affectsOutputs)) {
          inp.affectsOutputs = prev.affectsOutputs;
          preserved = true;
        }
      }
    }
  }
  return preserved;
}

/** Content hash that changes when the compiled model changes. */
function modelHash(chunkedDir, manifest) {
  const enginePath = join(chunkedDir, 'engine.js');
  const h = createHash('sha256');
  if (existsSync(enginePath)) {
    h.update(readFileSync(enginePath));
  } else {
    h.update(JSON.stringify(manifest));
  }
  return 'sha256:' + h.digest('hex');
}

/**
 * Emit named-outputs.json, named-inputs.json, and cell-types.json into a
 * chunked output directory.
 *
 * @param {string} chunkedDir - directory containing manifest.json + _ground-truth.json
 * @param {Object} [opts]
 * @param {string} [opts.excelPath] - source .xlsx, for defined-names + inputs
 * @param {string} [opts.modelTitle]
 * @param {string} [opts.version]
 * @param {Object} [opts.gt] - pre-loaded ground truth (init shares one across
 *   the manifest pipeline to avoid re-parsing a 200 MB+ file per command)
 * @returns {{ written: string[], skipped: Array<{file:string,reason:string}>, stats: Object }}
 */
export function emitManifestMaps(chunkedDir, opts = {}) {
  const manifestPath = join(chunkedDir, 'manifest.json');
  const gtPath = join(chunkedDir, '_ground-truth.json');
  if (!existsSync(manifestPath)) {
    return { written: [], skipped: [{ file: '*', reason: `manifest not found: ${manifestPath}` }], stats: {} };
  }
  if (!opts.gt && !existsSync(gtPath)) {
    return { written: [], skipped: [{ file: '*', reason: `ground truth not found: ${gtPath}` }], stats: {} };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  // Reuse init's shared ground truth when provided (read-only here), so the
  // manifest pipeline parses the GT once instead of once per command.
  const gt = opts.gt || JSON.parse(readFileSync(gtPath, 'utf-8'));

  // Best-effort workbook load for defined-names + inputs. Absence (e.g. under
  // --reuse-parse) degrades gracefully: outputs + cell-types still emit.
  let workbook = null;
  let namedRangeMap = new Map();
  let inputsSkipReason = 'no --excel path (defined-name inputs need the .xlsx)';
  if (opts.excelPath) {
    if (!existsSync(opts.excelPath)) {
      inputsSkipReason = `excel not found: ${opts.excelPath}`;
    } else {
      try {
        workbook = loadWorkbook(opts.excelPath);
        namedRangeMap = buildNamedRangeMap(workbook);
      } catch (e) {
        inputsSkipReason = `workbook unreadable: ${e.message}`;
      }
    }
  }

  const header = {
    version: opts.version || manifest.model?.source || manifest.model?.name || 'unknown',
    modelTitle: opts.modelTitle || manifest.model?.name || 'Untitled Model',
    modelHash: modelHash(chunkedDir, manifest),
    generatedAt: new Date().toISOString(),
  };

  const written = [];
  const skipped = [];
  const stats = {};

  // Build both named maps first, then enrich with dependency closures, so each
  // file is written once with affectsOutputs / dependsOnNamedInputs in place.
  const namedOutputs = collectNamedOutputs(manifest, gt, namedRangeMap);
  // named-inputs: the defined-name inputs need the workbook, but the
  // manifest-driver inputs (exitMultiple / exitYearSelector / hurdleRate) derive
  // from manifest + ground truth alone. Emit them even when the .xlsx isn't
  // reachable (e.g. `ete init --reuse-parse` against an already-parsed dir) —
  // collectNamedInputs skips the defined-name scan for a null workbook and still
  // resolves the drivers, so the contract isn't silently missing its drivers.
  const namedInputs = collectNamedInputs(workbook, manifest, gt);

  // ── Emit _fn-fallbacks.json (Request D) ──
  // Collected before the closure pass: the audit and the dependency closures now
  // share a single BFS over the edge map (computeOutputClosures).
  const fallbacks = collectFileFallbacks(chunkedDir);
  writeFileSync(
    join(chunkedDir, '_fn-fallbacks.json'),
    JSON.stringify({ ...header, fallbacks }, null, 2)
  );
  written.push('_fn-fallbacks.json');
  stats.fallbacks = Object.keys(fallbacks).length;

  // Dependency closures + fallback audit (Round 2 / #26), in ONE pass over the
  // Rust-emitted edge map. The graph keeps ranges as compact tokens (issue #32),
  // so it's read exactly once (it was parsed twice before — fatal at 37 GB) and
  // expanded lazily inside computeOutputClosures. Degrades gracefully if absent.
  //
  // The audit annotates each affected output (`resolvesThroughFallback`) and
  // records `stats.fallbackViolations` — it does NOT throw (aborting mid-emit
  // would silently drop the contract maps; many outputs legitimately still touch
  // stubs pending deeper transpiler coverage). The caller decides: `ete init`
  // warns by default, hard-fails under `--assert-no-fallbacks`.
  const graphPath = join(chunkedDir, 'dependency-graph.json');
  let edges = null;
  if (existsSync(graphPath)) {
    try {
      edges = loadDependencyEdges(graphPath); // streams; immune to Node's 512 MiB string cap
    } catch (e) {
      skipped.push({ file: 'dependency-closures', reason: `graph unreadable: ${e.message}` });
    }
  } else {
    skipped.push({ file: 'dependency-closures', reason: 'dependency-graph.json not found — it is removed from the default output after closures are baked in; re-run `ete init --emit-debug` to retain it for closure recomputation' });
  }
  // One BFS pass: closures (only when a graph is present) + fallback audit
  // (always — catches an output cell that is itself a stub even with no graph).
  const fallbackViolations = computeOutputClosures(
    namedOutputs, namedInputs, edges || {}, fallbacks, { attachDeps: edges !== null },
  );
  if (edges !== null) {
    stats.dependencyEdges = Object.keys(edges).length;
    stats.closures = true;
  }
  stats.fallbackViolations = fallbackViolations;

  // Preserve closures across re-emits: the dependency graph is deleted after the
  // first init bakes its closures, so a later refresh (manifest set/maps, or
  // --reuse-parse) would otherwise SILENTLY DROP dependsOnNamedInputs /
  // affectsOutputs. Carry them forward from the existing maps on disk so the
  // contract never regresses to "no closures" just because it was regenerated.
  if (!stats.closures) {
    const preserved = carryForwardClosures(chunkedDir, namedOutputs, namedInputs);
    if (preserved) stats.closures = 'preserved';
  }

  // named-outputs.json
  writeFileSync(
    join(chunkedDir, 'named-outputs.json'),
    JSON.stringify({ ...header, namedOutputs }, null, 2)
  );
  written.push('named-outputs.json');
  stats.outputs = Object.keys(namedOutputs).length;
  stats.outputsFromDefinedNames = Object.values(namedOutputs).filter(o => o.source === 'defined-name').length;

  // named-inputs.json
  if (namedInputs && Object.keys(namedInputs).length > 0) {
    writeFileSync(
      join(chunkedDir, 'named-inputs.json'),
      JSON.stringify({ ...header, namedInputs }, null, 2)
    );
    written.push('named-inputs.json');
    stats.inputs = Object.keys(namedInputs).length;
  } else {
    skipped.push({ file: 'named-inputs.json', reason: inputsSkipReason });
  }

  // cell-types.json
  const cellTypes = collectCellTypes(gt);
  writeFileSync(
    join(chunkedDir, 'cell-types.json'),
    JSON.stringify(cellTypes)
  );
  written.push('cell-types.json');
  stats.cellTypes = Object.keys(cellTypes).length;

  return { written, skipped, stats };
}

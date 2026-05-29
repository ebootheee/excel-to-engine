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

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
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

  // Include dynamic schedule/time-series outputs if timeline is defined
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

      // 5. Per-class distributions (Request B: split by class)
      if (manifest.equity?.classes) {
        for (const ec of manifest.equity.classes) {
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

/** Display-format hint for a numeric output, inferred from its name. */
function inferFormat(name) {
  const n = name.toLowerCase();
  if (/(moic|multiple|moc\b)/.test(n)) return 'multiple';
  if (/(irr|rate|wacc|pref|return|discount|yield|hurdle.*rate)/.test(n)) return 'fraction';
  if (/(ebitda|terminal|value|carry|basis|gain|cash|debt|price|proceeds|revenue|equity|capital|noi|distribution)/.test(n)) {
    return 'currency';
  }
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

/** Humanize a camelCase / dotted name for a fallback label. */
function humanize(name) {
  return name
    .replace(/^[a-z]+\./, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, c => c.toUpperCase());
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

      const sumOfValues = perYear.reduce((acc, p) => acc + p.value, 0);

      result[name] = {
        cellRange: manifestRef,
        perYear,
        label,
        type: 'schedule',
        format: 'currency',
        baseCaseValue: sumOfValues,
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

    const entry = {
      cell,
      label: labelForCell(gt, cell) || humanize(name),
      type: 'number',
      format: inferFormat(name),
      baseCaseValue: resolveCell(gt, cell),
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
    result[key] = {
      cell: `${inp.sheet}!${inp.cell}`,
      label: humanize(key),
      type: inp.type === 'number' ? 'number' : inp.type,
      default: inp.value,
      excelName: inp.name,
      referencedBy: inp.referencedBy,
      source: 'defined-name',
    };
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

function expandRange(rangeStr) {
  if (!rangeStr || !rangeStr.includes('!')) return [];
  const [sheet, cells] = rangeStr.split('!');
  if (!cells.includes(':')) return [rangeStr];
  const [start, end] = cells.split(':');
  const startColMatch = start.match(/^[A-Z]+/);
  const startRowMatch = start.match(/\d+$/);
  const endColMatch = end.match(/^[A-Z]+/);
  const endRowMatch = end.match(/\d+$/);
  if (!startColMatch || !startRowMatch || !endColMatch || !endRowMatch) {
    return [rangeStr];
  }
  const startCol = startColMatch[0];
  const startRow = parseInt(startRowMatch[0], 10);
  const endCol = endColMatch[0];
  const endRow = parseInt(endRowMatch[0], 10);

  const colToNum = col => {
    let num = 0;
    for (let i = 0; i < col.length; i++) {
       num = num * 26 + (col.charCodeAt(i) - 64);
    }
    return num;
  };
  const numToCol = num => {
    let col = '';
    while (num > 0) {
      let rem = (num - 1) % 26;
      col = String.fromCharCode(65 + rem) + col;
      num = Math.floor((num - 1) / 26);
    }
    return col;
  };

  const startColNum = colToNum(startCol);
  const endColNum = colToNum(endCol);

  const results = [];
  for (let r = startRow; r <= endRow; r++) {
    for (let c = startColNum; c <= endColNum; c++) {
      results.push(`${sheet}!${numToCol(c)}${r}`);
    }
  }
  return results;
}

/**
 * Attach dependency closures to the named maps (Round 2). For each named
 * output, records the named inputs it transitively depends on
 * (`dependsOnNamedInputs`); and on each named input, the outputs it affects
 * (`affectsOutputs`). Computed by BFS over the forward edge map
 * (cell → cells it reads) from `dependency-graph.json`. Mutates both maps.
 *
 * `affectsOutputs` is what lets a consumer invalidate only the affected outputs
 * on a what-if instead of regenerating an entire sensitivity grid.
 *
 * @param {Object} namedOutputs - name → { cell, ... } (mutated)
 * @param {Object} namedInputs - name → { cell, ... } (mutated)
 * @param {Object<string,string[]>} edges - cell → [cells it reads]
 */
export function attachDependencyClosures(namedOutputs, namedInputs, edges) {
  const inputCellToName = new Map();
  for (const [name, info] of Object.entries(namedInputs)) {
    if (typeof info.cell === 'string') inputCellToName.set(info.cell, name);
  }

  const affects = {}; // input name → Set(output names)

  for (const [outName, out] of Object.entries(namedOutputs)) {
    const targets = [];
    if (typeof out.cell === 'string') {
      targets.push(out.cell);
    } else if (typeof out.cellRange === 'string') {
      targets.push(...expandRange(out.cellRange));
    }
    if (targets.length === 0) continue;

    const deps = new Set();
    const seen = new Set(targets);
    const queue = [...targets];
    for (let qi = 0; qi < queue.length; qi++) {
      const outs = edges[queue[qi]];
      if (!outs) continue;
      for (const next of outs) {
        const inName = inputCellToName.get(next);
        if (inName) deps.add(inName);
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    out.dependsOnNamedInputs = [...deps].sort();
    for (const inName of deps) (affects[inName] ||= new Set()).add(outName);
  }

  for (const [name, info] of Object.entries(namedInputs)) {
    info.affectsOutputs = affects[name] ? [...affects[name]].sort() : [];
  }
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

function getTransitiveClosure(targets, edges) {
  const seen = new Set(targets);
  const queue = [...targets];
  for (let qi = 0; qi < queue.length; qi++) {
    const current = queue[qi];
    const reads = edges[current];
    if (reads) {
      for (const next of reads) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
  }
  return seen;
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
  const namedInputs = workbook ? collectNamedInputs(workbook, manifest, gt) : null;

  // Dependency closures (Round 2): needs the Rust-emitted edge map AND the
  // named inputs (defined-names from the workbook). Degrades gracefully if
  // either is absent.
  const graphPath = join(chunkedDir, 'dependency-graph.json');
  if (existsSync(graphPath) && namedInputs && Object.keys(namedInputs).length > 0) {
    try {
      const edges = JSON.parse(readFileSync(graphPath, 'utf-8')).edges || {};
      attachDependencyClosures(namedOutputs, namedInputs, edges);
      stats.dependencyEdges = Object.keys(edges).length;
      stats.closures = true;
    } catch (e) {
      skipped.push({ file: 'dependency-closures', reason: `graph unreadable: ${e.message}` });
    }
  } else if (!existsSync(graphPath)) {
    skipped.push({ file: 'dependency-closures', reason: 'dependency-graph.json not found — it is removed from the default output after closures are baked in; re-run `ete init --emit-debug` to retain it for closure recomputation' });
  }

  // ── Emit _fn-fallbacks.json (Request D) ──
  const fallbacks = collectFileFallbacks(chunkedDir);
  writeFileSync(
    join(chunkedDir, '_fn-fallbacks.json'),
    JSON.stringify({ ...header, fallbacks }, null, 2)
  );
  written.push('_fn-fallbacks.json');
  stats.fallbacks = Object.keys(fallbacks).length;

  // ── Correctness audit (Request D / #26) ──
  // Flag every named output / schedule whose transitive dependency closure passes
  // through a cell that transpiled to an unsupported-function stub (_fn). We do
  // NOT throw here: aborting mid-emit would silently drop the contract maps (the
  // caller wraps this in try/catch), and on the real models many outputs
  // legitimately still touch stubs pending deeper transpiler coverage. Instead we
  // annotate each affected output (`resolvesThroughFallback`) and record
  // `stats.fallbackViolations`, then let the caller decide: `ete init` warns by
  // default and hard-fails under `--assert-no-fallbacks`; a golden-master CI
  // check can assert the list stays empty as transpiler coverage improves.
  let edgesObj = {};
  if (existsSync(graphPath)) {
    try {
      edgesObj = JSON.parse(readFileSync(graphPath, 'utf-8')).edges || {};
    } catch { /* ignore */ }
  }

  const fallbackViolations = [];
  if (Object.keys(fallbacks).length > 0) {
    for (const [outName, out] of Object.entries(namedOutputs)) {
      const targets = [];
      if (typeof out.cell === 'string') {
        targets.push(out.cell);
      } else if (typeof out.cellRange === 'string') {
        targets.push(...expandRange(out.cellRange));
      }
      if (targets.length === 0) continue;

      const closure = getTransitiveClosure(targets, edgesObj);
      for (const cell of closure) {
        if (fallbacks[cell]) {
          out.resolvesThroughFallback = { cell, function: fallbacks[cell].function };
          fallbackViolations.push({ output: outName, cell, function: fallbacks[cell].function });
          break; // one offending cell is enough to flag the output
        }
      }
    }
  }
  stats.fallbackViolations = fallbackViolations;

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

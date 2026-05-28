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

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { resolveCell } from './manifest.mjs';
import { loadWorkbook, detectInputCells, buildNamedRangeMap } from './excel-parser.mjs';

// ---------------------------------------------------------------------------
// Output-cell enumeration
// ---------------------------------------------------------------------------

/**
 * Walk the manifest's known output locations and yield { name: cellRef }.
 *
 * This mirrors `resolveBaseCaseOutputs` in manifest.mjs but keeps the cell ref
 * (that function discards it and returns only values). The drift test in
 * tests/cli/test-manifest-maps.mjs asserts the two stay in sync.
 *
 * @param {Object} manifest
 * @returns {Object<string, (string|{cells:string[],op:string})>}
 */
export function enumerateOutputCells(manifest) {
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

  const cells = enumerateOutputCells(manifest);
  const result = {};

  for (const [name, manifestRef] of Object.entries(cells)) {
    let cell = manifestRef;
    let source = 'manifest';
    let excelName = typeof manifestRef === 'string' ? namedRangeMap.get(manifestRef) || null : null;
    let manifestCell;

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

/**
 * Build the named-inputs map from the workbook's defined-name table.
 *
 * Only cells that (a) carry a defined name and (b) are read by ≥1 formula are
 * emitted — the model owner's curated, load-bearing inputs. `affectsOutputs` is
 * intentionally absent until the dependency-graph artifact lands (Round 2).
 *
 * @param {Object} workbook - SheetJS workbook
 * @returns {Object} namedInputs map
 */
export function collectNamedInputs(workbook) {
  const inputs = detectInputCells(workbook, { namedRangesOnly: true });
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
 * @returns {{ written: string[], skipped: Array<{file:string,reason:string}>, stats: Object }}
 */
export function emitManifestMaps(chunkedDir, opts = {}) {
  const manifestPath = join(chunkedDir, 'manifest.json');
  const gtPath = join(chunkedDir, '_ground-truth.json');
  if (!existsSync(manifestPath)) {
    return { written: [], skipped: [{ file: '*', reason: `manifest not found: ${manifestPath}` }], stats: {} };
  }
  if (!existsSync(gtPath)) {
    return { written: [], skipped: [{ file: '*', reason: `ground truth not found: ${gtPath}` }], stats: {} };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const gt = JSON.parse(readFileSync(gtPath, 'utf-8'));

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

  // named-outputs.json
  const namedOutputs = collectNamedOutputs(manifest, gt, namedRangeMap);
  writeFileSync(
    join(chunkedDir, 'named-outputs.json'),
    JSON.stringify({ ...header, namedOutputs }, null, 2)
  );
  written.push('named-outputs.json');
  stats.outputs = Object.keys(namedOutputs).length;
  stats.outputsFromDefinedNames = Object.values(namedOutputs).filter(o => o.source === 'defined-name').length;

  // named-inputs.json (requires workbook)
  if (workbook) {
    const namedInputs = collectNamedInputs(workbook);
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

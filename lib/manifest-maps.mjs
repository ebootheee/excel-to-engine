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
  // Ratios shown as "x": MOIC/multiple/TVPI/DPI/RVPI/DSCR/ICR/coverage/leverage.
  if (/multiple|moic|\bmoc\b|tvpi|dpi|rvpi|dscr|\bicr\b|coverage|leverage|turns/.test(n)) return 'multiple';
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
    if (typeof out.cell !== 'string') continue;
    const deps = new Set();
    const seen = new Set([out.cell]);
    const queue = [out.cell];
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

  // Build both named maps first, then enrich with dependency closures, so each
  // file is written once with affectsOutputs / dependsOnNamedInputs in place.
  const namedOutputs = collectNamedOutputs(manifest, gt, namedRangeMap);
  const namedInputs = workbook ? collectNamedInputs(workbook) : null;

  // Dependency closures (Round 2): needs the Rust-emitted edge map AND the
  // named inputs (defined-names from the workbook). Degrades gracefully if
  // either is absent.
  const graphPath = join(chunkedDir, 'dependency-graph.json');
  if (existsSync(graphPath) && namedInputs) {
    try {
      const edges = JSON.parse(readFileSync(graphPath, 'utf-8')).edges || {};
      attachDependencyClosures(namedOutputs, namedInputs, edges);
      stats.dependencyEdges = Object.keys(edges).length;
      stats.closures = true;
    } catch (e) {
      skipped.push({ file: 'dependency-closures', reason: `graph unreadable: ${e.message}` });
    }
  }
  // Preserve closures across re-emits. The dependency graph is deleted after the
  // first init bakes its closures, so a later refresh (manifest set/maps, or
  // --reuse-parse) would otherwise SILENTLY DROP dependsOnNamedInputs /
  // affectsOutputs. Carry them forward from the existing maps so the contract
  // never regresses to "no closures" just because it was regenerated.
  if (!stats.closures) {
    const preserved = carryForwardClosures(chunkedDir, namedOutputs, namedInputs);
    if (preserved) stats.closures = 'preserved';
    else if (!existsSync(graphPath)) {
      skipped.push({ file: 'dependency-closures', reason: 'dependency-graph.json not found and no prior closures to preserve — run a fresh `ete init` (or `--emit-debug`) to (re)compute dependsOnNamedInputs / affectsOutputs' });
    }
  }

  // named-outputs.json
  writeFileSync(
    join(chunkedDir, 'named-outputs.json'),
    JSON.stringify({ ...header, namedOutputs }, null, 2)
  );
  written.push('named-outputs.json');
  stats.outputs = Object.keys(namedOutputs).length;
  stats.outputsFromDefinedNames = Object.values(namedOutputs).filter(o => o.source === 'defined-name').length;

  // named-inputs.json (requires workbook)
  if (namedInputs) {
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

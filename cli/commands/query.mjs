/**
 * ete query — Query ground truth cells.
 *
 * Four modes:
 * 1. Cell reference:  ete query ./model/ "Sheet!A1"
 * 2. Range:           ete query ./model/ "Sheet!A1:Z1"
 * 3. Manifest name:   ete query ./model/ --name exitMultiple
 * 4. Label search:    ete query ./model/ --search "headcount"
 *
 * @license MIT
 */

import { loadManifest, loadGroundTruth, resolveCell, searchByLabel } from '../../lib/manifest.mjs';
import { formatOutput } from '../format.mjs';

/**
 * Execute the query command.
 *
 * @param {string} modelDir - Path to model directory
 * @param {Object} args - Parsed CLI arguments
 * @returns {Object} Query result
 */
export function runQuery(modelDir, args) {
  const manifest = loadManifest(modelDir);
  const gt = loadGroundTruth(manifest, modelDir);

  // Mode 4: Label search
  if (args.search) {
    return queryBySearch(gt, args.search, {
      sheet: args.sheet,
      maxResults: args.limit || 20,
      context: args.context || 2,
      format: args.format,
    });
  }

  // Mode 3: Manifest name
  if (args.name) {
    return queryByName(manifest, gt, args.name, { format: args.format });
  }

  // Mode 1-2: Cell reference or range
  if (args.cells && args.cells.length > 0) {
    return queryCells(gt, args.cells, { format: args.format });
  }

  throw new Error('Usage: ete query <modelDir> [cells...] [--search <pattern>] [--name <key>]');
}

/**
 * Query by cell references.
 */
function queryCells(gt, cellRefs, options = {}) {
  const results = [];

  for (const ref of cellRefs) {
    if (ref.includes(':')) {
      // Range query: "Sheet!A1:Z1"
      const rangeResults = resolveRange(gt, ref);
      results.push(...rangeResults);
    } else {
      const val = resolveCell(gt, ref);
      results.push({ cell: ref, value: val, type: typeof val });
    }
  }

  return { mode: 'cell', results, _formatted: formatQueryResults(results, options.format) };
}

/**
 * Resolve a range reference like "Sheet!A1:C5".
 */
function resolveRange(gt, rangeRef) {
  const match = rangeRef.match(/^(.+)!([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  if (!match) return [{ cell: rangeRef, value: undefined, error: 'Invalid range format' }];

  const [, sheet, startCol, startRowStr, endCol, endRowStr] = match;
  const startRow = parseInt(startRowStr, 10);
  const endRow = parseInt(endRowStr, 10);
  const results = [];

  for (let row = startRow; row <= endRow; row++) {
    for (let colNum = colToNum(startCol); colNum <= colToNum(endCol); colNum++) {
      const col = numToCol(colNum);
      const addr = `${sheet}!${col}${row}`;
      results.push({ cell: addr, value: gt[addr], type: typeof gt[addr] });
    }
  }

  return results;
}

/**
 * Query by manifest name (dot-path into manifest).
 */
function queryByName(manifest, gt, name, options = {}) {
  // Check outputs
  if (manifest.outputs?.[name]) {
    const output = manifest.outputs[name];
    if (output.cell) {
      const val = resolveCell(gt, output.cell);
      return { mode: 'name', name, cell: output.cell, value: val, label: output.label,
        _formatted: formatNameResult(name, output.cell, val, output.label) };
    }
    if (output.exitValue) {
      const val = resolveCell(gt, output.exitValue);
      return { mode: 'name', name, cell: output.exitValue, value: val, label: output.label,
        _formatted: formatNameResult(name, output.exitValue, val, output.label) };
    }
  }

  // Check equity classes
  for (const ec of manifest.equity?.classes || []) {
    for (const key of ['grossMOIC', 'grossIRR', 'netMOIC', 'netIRR', 'basisCell']) {
      if (name === key || name === `${ec.id}.${key}`) {
        const val = resolveCell(gt, ec[key]);
        return { mode: 'name', name, cell: ec[key], value: val, label: `${ec.label} ${key}`,
          _formatted: formatNameResult(name, ec[key], val, `${ec.label} ${key}`) };
      }
    }
  }

  // Check carry
  if (name === 'totalCarry' && manifest.carry?.totalCell) {
    const val = resolveCell(gt, manifest.carry.totalCell);
    return { mode: 'name', name, cell: manifest.carry.totalCell, value: val, label: 'Total Carry',
      _formatted: formatNameResult(name, manifest.carry.totalCell, val, 'Total Carry') };
  }

  // Check custom cells
  if (manifest.customCells?.[name]) {
    const val = resolveCell(gt, manifest.customCells[name]);
    return { mode: 'name', name, cell: manifest.customCells[name], value: val, label: name,
      _formatted: formatNameResult(name, manifest.customCells[name], val, name) };
  }

  // Check baseCaseOutputs
  if (manifest.baseCaseOutputs?.[name] !== undefined) {
    return { mode: 'name', name, value: manifest.baseCaseOutputs[name], label: name,
      _formatted: formatNameResult(name, '(baseCaseOutputs)', manifest.baseCaseOutputs[name], name) };
  }

  return { mode: 'name', name, error: `"${name}" not found in manifest` };
}

/**
 * Query by label search (fuzzy text match).
 */
function queryBySearch(gt, pattern, options = {}) {
  const matches = searchByLabel(gt, pattern, {
    sheet: options.sheet,
    maxResults: options.maxResults,
  });

  // Enrich with context rows
  if (options.context > 0) {
    for (const match of matches) {
      match.contextRows = getContextRows(gt, match.sheet, match.row, options.context);
    }
  }

  return {
    mode: 'search',
    pattern,
    count: matches.length,
    matches,
    _formatted: formatSearchResults(matches, options.format),
  };
}

/**
 * Get rows above and below a match for context.
 */
function getContextRows(gt, sheet, targetRow, contextSize) {
  const rows = [];
  for (let r = targetRow - contextSize; r <= targetRow + contextSize; r++) {
    if (r < 1) continue;
    const rowData = { row: r, cells: [], isTarget: r === targetRow };

    // Scan columns A-Z for this row
    for (const col of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')) {
      const addr = `${sheet}!${col}${r}`;
      const val = gt[addr];
      if (val !== undefined) {
        rowData.cells.push({ col, value: val });
      }
    }

    if (rowData.cells.length > 0) {
      rows.push(rowData);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatQueryResults(results, format) {
  if (format === 'json') return results;

  const lines = [];
  for (const r of results) {
    const valStr = formatValue(r.value);
    lines.push(`${r.cell}  →  ${valStr}`);
  }
  return lines.join('\n');
}

function formatNameResult(name, cell, value, label) {
  return `${label || name} (${cell}): ${formatValue(value)}`;
}

function formatSearchResults(matches, format) {
  if (format === 'json') return matches;

  if (matches.length === 0) return 'No matches found.';

  const lines = [];
  for (const m of matches) {
    lines.push(`${m.sheet}!${m.col}${m.row}: "${m.label}"`);
    if (m.values.length > 0) {
      const vals = m.values.slice(0, 8).map(v => `${v.col}=${formatValue(v.value)}`).join(', ');
      lines.push(`  Values: ${vals}`);
    }
  }
  return lines.join('\n');
}

function formatValue(val) {
  if (val === undefined) return '(not found)';
  if (typeof val === 'number') {
    if (Math.abs(val) >= 1e6) return `$${(val / 1e6).toFixed(1)}M`;
    if (Math.abs(val) >= 1e3) return `$${(val / 1e3).toFixed(1)}K`;
    if (Math.abs(val) < 1 && val !== 0) return `${(val * 100).toFixed(2)}%`;
    return val.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  return String(val);
}

// ---------------------------------------------------------------------------
// Column helpers
// ---------------------------------------------------------------------------

function colToNum(col) {
  let num = 0;
  for (let i = 0; i < col.length; i++) {
    num = num * 26 + (col.charCodeAt(i) - 64);
  }
  return num;
}

function numToCol(num) {
  let col = '';
  while (num > 0) {
    const rem = (num - 1) % 26;
    col = String.fromCharCode(65 + rem) + col;
    num = Math.floor((num - 1) / 26);
  }
  return col;
}

/**
 * ete explain — Audit trail for any manifest name or cell reference.
 *
 * When a stakeholder disagrees with a number, show the full trust chain
 * in one command — no detective work required. Covers:
 *   1. Manifest resolution — which field maps to this name, what cell
 *   2. Cell value — raw from ground truth
 *   3. Adjacent label — the human-readable label on the same row
 *   4. Formula — transpiled JS + original Excel if formulas.json is present
 *   5. Dependencies — cells referenced by the formula (from dependency graph)
 *   6. Base-case lineage — where the name comes from in the manifest schema
 *
 * Usage:
 *   ete explain <modelDir> totalCarry          # manifest name
 *   ete explain <modelDir> grossIRR            # equity class metric
 *   ete explain <modelDir> "Equity!AN125"      # direct cell
 *   ete explain <modelDir> TVPI                # fund-level metric
 *
 * @license MIT
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  loadManifest, loadGroundTruth, resolveCell, resolveBaseCaseOutputs,
} from '../../lib/manifest.mjs';

export function runExplain(modelDir, target, args) {
  if (!target) {
    return { error: 'Usage: ete explain <modelDir> <name-or-cell>\n  Example: ete explain ./model/ totalCarry' };
  }

  const manifest = loadManifest(modelDir);
  const gt = loadGroundTruth(manifest, modelDir);
  const baseOutputs = resolveBaseCaseOutputs(manifest, gt);

  // Two dispatch modes:
  //   - cell ref (contains "!") → direct cell lookup
  //   - name → walk manifest for the cell, then explain that cell
  const isCellRef = target.includes('!') && /^[^!]+!\$?[A-Z]+\$?\d+$/.test(target);

  let cellRef = null;
  let manifestPath = null;
  let valueFromManifest = null;

  if (isCellRef) {
    cellRef = target;
  } else {
    const resolved = resolveManifestName(manifest, target, baseOutputs);
    if (!resolved) {
      return { error: `"${target}" is not a recognized manifest name or cell. Try: ete query ${modelDir} --search "${target}"` };
    }
    cellRef = resolved.cell;
    manifestPath = resolved.path;
    valueFromManifest = resolved.value;
  }

  const value = cellRef ? resolveCell(gt, cellRef) : valueFromManifest;
  const adjacentLabel = cellRef ? findAdjacentLabel(gt, cellRef) : null;
  const formula = cellRef ? findFormula(modelDir, cellRef) : null;

  const result = {
    target,
    manifestPath,
    cell: cellRef,
    value,
    adjacentLabel: adjacentLabel?.text || null,
    adjacentCell: adjacentLabel?.addr || null,
    formula: formula?.formula || null,
    transpiledJs: formula?.js || null,
    dependencies: formula?.deps || null,
  };

  result._formatted = formatExplain(result);
  return result;
}

// ---------------------------------------------------------------------------
// Manifest name resolution — finds the cell a name maps to.
// ---------------------------------------------------------------------------

function resolveManifestName(manifest, name, baseOutputs) {
  // 1. Top-level outputs
  const o = manifest.outputs || {};
  if (o.terminalValue?.cell && name === 'terminalValue') {
    return { path: 'outputs.terminalValue.cell', cell: o.terminalValue.cell };
  }
  if (o.exitMultiple?.cell && name === 'exitMultiple') {
    return { path: 'outputs.exitMultiple.cell', cell: o.exitMultiple.cell };
  }
  if (o.ebitda?.exitValue && (name === 'exitEBITDA' || name === 'ebitda')) {
    return { path: 'outputs.ebitda.exitValue', cell: o.ebitda.exitValue };
  }

  // 2. Equity class metrics
  for (let i = 0; i < (manifest.equity?.classes || []).length; i++) {
    const ec = manifest.equity.classes[i];
    for (const key of ['grossMOIC', 'grossIRR', 'netMOIC', 'netIRR', 'basisCell', 'shares', 'ownershipPct']) {
      if (!ec[key]) continue;
      if (name === key || name === `${ec.id}.${key}` || name === `class-${i + 1}.${key}`) {
        return { path: `equity.classes[${i}].${key}`, cell: ec[key] };
      }
    }
  }

  // 3. Carry
  if (name === 'totalCarry' && manifest.carry?.totalCell) {
    return { path: 'carry.totalCell', cell: manifest.carry.totalCell };
  }

  // 4. Debt
  for (const key of ['exitBalance', 'exitCash', 'principal', 'rate', 'maturity']) {
    if (manifest.debt?.[key] && (name === `debt.${key}` || name === `exit${cap(key)}` || name === `debt${cap(key)}`)) {
      return { path: `debt.${key}`, cell: manifest.debt[key] };
    }
  }

  // 5. Custom cells
  if (manifest.customCells?.[name]) {
    return { path: `customCells.${name}`, cell: manifest.customCells[name] };
  }

  // 6. Fund level
  if (manifest.fundLevel?.[name]) {
    return { path: `fundLevel.${name}`, cell: manifest.fundLevel[name] };
  }

  // 7. Covenants
  for (const cov of manifest.covenants || []) {
    if (name === cov.id || name === `covenants.${cov.id}`) {
      return { path: `covenants.${cov.id}`, cell: cov.cell };
    }
  }

  // 8. Segments (by id)
  for (const seg of manifest.segments || []) {
    if (name === seg.id || name === `segments.${seg.id}`) {
      // Resolve a representative cell: last column of timeline (exit year value)
      const cols = Object.keys(manifest.timeline?.columnMap || {}).sort();
      const lastCol = cols[cols.length - 1];
      if (lastCol) {
        return { path: `segments.${seg.id}.row ${seg.row}`, cell: `${seg.sheet}!${lastCol}${seg.row}` };
      }
    }
  }

  // 9. Schedule
  for (const sch of manifest.schedules || []) {
    if (name === sch.id || name === `schedules.${sch.id}`) {
      return { path: `schedules.${sch.id}.row ${sch.row}`, cell: `${sch.sheet}!A${sch.row}` };
    }
  }

  // 10. baseCaseOutputs — scalar value, no cell
  if (baseOutputs && name in baseOutputs) {
    return { path: `baseCaseOutputs.${name}`, cell: null, value: baseOutputs[name] };
  }

  return null;
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ---------------------------------------------------------------------------
// Adjacent label — B-column (or A) label on the same row as the target cell.
// ---------------------------------------------------------------------------

function findAdjacentLabel(gt, cellRef) {
  const bang = cellRef.lastIndexOf('!');
  const sheet = cellRef.substring(0, bang);
  const m = cellRef.substring(bang + 1).match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  const row = parseInt(m[2], 10);
  const prefix = sheet + '!';
  for (const col of 'ABCDEFGH'.split('')) {
    const addr = `${prefix}${col}${row}`;
    const v = gt[addr];
    if (typeof v === 'string' && v.trim().length > 2) return { text: v.trim(), addr };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Formula lookup — from chunked/formulas.json (non-chunked legacy mode
// may not have this; degrade gracefully).
// ---------------------------------------------------------------------------

function findFormula(modelDir, cellRef) {
  const candidates = [
    join(modelDir, 'formulas.json'),
    join(modelDir, 'chunked', 'formulas.json'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const data = JSON.parse(readFileSync(p, 'utf-8'));
      if (data._chunked_mode || data._compact) {
        // Chunked mode writes only metadata, not per-cell entries. Try the
        // per-sheet .mjs source for a formula comment.
        return findFormulaInSheetModule(modelDir, cellRef);
      }
      if (Array.isArray(data)) {
        const entry = data.find(e => e.qualified_address === cellRef || `${e.sheet}!${e.address}` === cellRef);
        if (entry) {
          return {
            formula: entry.formula || null,
            js: entry.transpiled || entry.js || null,
            deps: entry.dependencies || null,
          };
        }
      }
    } catch { /* ignore */ }
  }
  return findFormulaInSheetModule(modelDir, cellRef);
}

function findFormulaInSheetModule(modelDir, cellRef) {
  // Chunked per-sheet modules store formulas as inline comments near the
  // output variable. Look for `// <address>:` or `// = <formula>` markers.
  const bang = cellRef.lastIndexOf('!');
  const sheet = cellRef.substring(0, bang);
  const addr = cellRef.substring(bang + 1);
  const sheetFile = sanitizeSheetName(sheet) + '.mjs';
  const candidates = [
    join(modelDir, 'sheets', sheetFile),
    join(modelDir, 'chunked', 'sheets', sheetFile),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const src = readFileSync(p, 'utf-8');
      // Look for the comment line that precedes the var assignment for this addr
      const re = new RegExp(`//\\s*${addr}\\s*[:=]\\s*(.+)`, 'i');
      const m = src.match(re);
      if (m) return { formula: m[1].trim(), js: null, deps: null };
    } catch { /* ignore */ }
  }
  return null;
}

function sanitizeSheetName(name) {
  return name.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatExplain(r) {
  const lines = [];
  lines.push(`Explain: ${r.target}`);
  lines.push('─'.repeat(60));
  if (r.manifestPath) lines.push(`Manifest path:   ${r.manifestPath}`);
  if (r.cell) lines.push(`Cell:            ${r.cell}`);
  lines.push(`Value:           ${fmt(r.value)}`);
  if (r.adjacentLabel) lines.push(`Adjacent label:  "${r.adjacentLabel}" (${r.adjacentCell})`);
  if (r.formula) lines.push(`Formula:         ${r.formula}`);
  if (r.transpiledJs) lines.push(`Transpiled JS:   ${r.transpiledJs.substring(0, 200)}${r.transpiledJs.length > 200 ? '…' : ''}`);
  if (Array.isArray(r.dependencies) && r.dependencies.length > 0) {
    lines.push(`Dependencies:    ${r.dependencies.slice(0, 10).join(', ')}${r.dependencies.length > 10 ? ` (+${r.dependencies.length - 10} more)` : ''}`);
  }
  if (!r.formula && !r.transpiledJs) {
    lines.push(`Formula:         (not available — chunked mode skips cell-level formula metadata)`);
  }
  return lines.join('\n');
}

function fmt(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B (${v})`;
    if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M (${v})`;
    if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K (${v})`;
    if (abs < 1 && v !== 0) return `${(v * 100).toFixed(2)}% (${v})`;
    return String(v);
  }
  if (typeof v === 'string') return `"${v}"`;
  return JSON.stringify(v);
}

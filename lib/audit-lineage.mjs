/**
 * excel-to-engine — deterministic, compact audit lineage for pinned outputs.
 *
 * A full cell dependency graph can exceed 500 MB on real models and is removed
 * from the default artifact after contract maps are baked. This module turns a
 * model-owner-curated `manifest.auditTraces` configuration into a small durable
 * proof artifact while the source workbook, ground truth, and graph are all
 * available during `ete init`.
 *
 * The graph direction is output -> precedents. Paths are persisted in the more
 * natural source -> output order. A configured anchor that is not a precedent
 * is reported as `not-in-lineage`; the emitter never invents a connection.
 *
 * @license MIT
 */

import { createHash } from 'crypto';
import { basename, join } from 'path';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';

export const AUDIT_LINEAGE_SCHEMA = 'excel-audit-lineage-v1';
export const DEFAULT_MAX_VISITED = 250_000;
export const MAX_MAX_VISITED = 2_000_000;

const EXPECTATIONS = new Set(['connected', 'not-in-lineage', 'any']);

function sha256Bytes(value) {
  return 'sha256:' + createHash('sha256').update(value).digest('hex');
}

function sha256File(path) {
  return path && existsSync(path) ? sha256Bytes(readFileSync(path)) : null;
}

function normalizeCellRef(ref) {
  if (typeof ref !== 'string') return null;
  const bang = ref.lastIndexOf('!');
  if (bang <= 0) return null;
  const sheet = ref.slice(0, bang).replace(/^'(.*)'$/, '$1');
  const addr = ref.slice(bang + 1).replace(/\$/g, '');
  return /^[A-Z]+\d+$/.test(addr) ? `${sheet}!${addr}` : null;
}

function resolveRoot(root, namedOutputs) {
  if (typeof root === 'string') {
    const direct = normalizeCellRef(root);
    if (direct) return { name: null, cell: direct };
    const output = namedOutputs?.[root];
    return {
      name: root,
      cell: normalizeCellRef(typeof output?.cell === 'string' ? output.cell : null),
    };
  }
  if (root && typeof root === 'object') {
    const name = typeof root.name === 'string' ? root.name : null;
    const explicit = normalizeCellRef(root.cell);
    const output = name ? namedOutputs?.[name] : null;
    return {
      name,
      cell: explicit || normalizeCellRef(typeof output?.cell === 'string' ? output.cell : null),
    };
  }
  return { name: null, cell: null };
}

function normalizeAnchor(anchor, index) {
  if (typeof anchor === 'string') {
    return {
      name: `anchor-${index + 1}`,
      cell: normalizeCellRef(anchor),
      expect: 'connected',
    };
  }
  const expect = EXPECTATIONS.has(anchor?.expect) ? anchor.expect : 'connected';
  return {
    name: typeof anchor?.name === 'string' ? anchor.name : `anchor-${index + 1}`,
    cell: normalizeCellRef(anchor?.cell),
    expect,
  };
}

function normalizeMaxVisited(value, fallback = DEFAULT_MAX_VISITED) {
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, MAX_MAX_VISITED);
}

function parseCell(ref) {
  const bang = ref.lastIndexOf('!');
  if (bang <= 0) return null;
  const sheet = ref.slice(0, bang);
  const match = /^([A-Z]+)(\d+)$/.exec(ref.slice(bang + 1));
  return match ? { sheet, col: match[1], row: Number(match[2]) } : null;
}

function colToNumber(col) {
  let value = 0;
  for (const ch of col) value = value * 26 + ch.charCodeAt(0) - 64;
  return value;
}

function numberToCol(value) {
  let result = '';
  for (let n = value; n > 0;) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

function parseRange(ref) {
  if (typeof ref !== 'string') return null;
  const bang = ref.lastIndexOf('!');
  if (bang <= 0) return null;
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref.slice(bang + 1));
  if (!match) return null;
  let c1 = colToNumber(match[1]);
  let r1 = Number(match[2]);
  let c2 = colToNumber(match[3]);
  let r2 = Number(match[4]);
  if (c1 > c2) [c1, c2] = [c2, c1];
  if (r1 > r2) [r1, r2] = [r2, r1];
  return { sheet: ref.slice(0, bang), c1, r1, c2, r2 };
}

function rangeContains(range, cellRef) {
  const cell = parseCell(cellRef);
  if (!range || !cell || range.sheet !== cell.sheet) return false;
  const col = colToNumber(cell.col);
  return col >= range.c1 && col <= range.c2 && cell.row >= range.r1 && cell.row <= range.r2;
}

function findLabel(groundTruth, cellRef) {
  const parsed = parseCell(cellRef);
  if (!parsed) return null;
  const targetCol = colToNumber(parsed.col);

  // Financial models conventionally put a row label immediately to the left.
  // Scan a bounded window so AO270 correctly finds AL270 without walking an
  // entire 6M-cell sheet.
  for (let c = targetCol - 1; c >= Math.max(1, targetCol - 16); c--) {
    const ref = `${parsed.sheet}!${numberToCol(c)}${parsed.row}`;
    const value = groundTruth[ref];
    if (typeof value === 'string' && value.trim().length > 1) {
      return { cell: ref, text: value.trim() };
    }
  }

  // Small input tables often put the label above the value instead.
  for (let r = parsed.row - 1; r >= Math.max(1, parsed.row - 3); r--) {
    const ref = `${parsed.sheet}!${parsed.col}${r}`;
    const value = groundTruth[ref];
    if (typeof value === 'string' && value.trim().length > 1) {
      return { cell: ref, text: value.trim() };
    }
  }
  return null;
}

function workbookCell(workbook, cellRef) {
  const parsed = parseCell(cellRef);
  if (!workbook || !parsed) return null;
  return workbook.Sheets?.[parsed.sheet]?.[`${parsed.col}${parsed.row}`] || null;
}

function buildNode(cellRef, { workbook, groundTruth, edges }) {
  const cell = workbookCell(workbook, cellRef);
  const formula = cell?.f == null
    ? null
    : (String(cell.f).startsWith('=') ? String(cell.f) : `=${cell.f}`);
  const groundTruthPresent = Object.prototype.hasOwnProperty.call(groundTruth, cellRef);
  return {
    kind: formula ? 'formula' : (groundTruthPresent || cell ? 'input' : 'missing'),
    groundTruthPresent,
    groundTruthValue: groundTruthPresent ? groundTruth[cellRef] : null,
    formula,
    formulaSha256: formula ? sha256Bytes(formula) : null,
    dependsOn: Array.isArray(edges?.[cellRef]) ? [...edges[cellRef]] : [],
    label: findLabel(groundTruth, cellRef),
  };
}

function reconstructPath(root, target, parents) {
  const nodes = [target];
  const links = [];
  let current = target;
  while (current !== root) {
    const parent = parents.get(current);
    if (!parent) return { nodes: [], links: [] };
    links.push({ from: current, to: parent.cell, via: parent.via });
    current = parent.cell;
    nodes.push(current);
  }
  return { nodes, links };
}

/**
 * Find all configured anchors in one bounded traversal. `edges` point from an
 * output/formula to its precedents. Compact ranges are expanded only against
 * formula-cell keys through the caller's already-built range index; literal
 * anchors inside a range are detected directly without expanding the range.
 */
function findPaths(root, anchors, edges, forEachFormulaCellInRange, maxVisited) {
  const targets = new Set(anchors.map((a) => a.cell).filter(Boolean));
  const unresolved = new Set(targets);
  const parents = new Map([[root, null]]);
  const queue = [root];
  let qi = 0;
  let truncated = false;

  const discover = (cell, parent, via) => {
    if (!cell || parents.has(cell)) return;
    if (parents.size >= maxVisited) {
      truncated = true;
      return;
    }
    parents.set(cell, { cell: parent, via });
    unresolved.delete(cell);
    if (edges[cell]) queue.push(cell);
  };

  unresolved.delete(root);

  while (qi < queue.length && unresolved.size > 0 && !truncated) {
    const current = queue[qi++];
    for (const ref of edges[current] || []) {
      if (typeof ref !== 'string') continue;
      if (!ref.includes(':')) {
        discover(ref, current, ref);
        continue;
      }

      const range = parseRange(ref);
      if (!range) continue;
      // Literal anchors are not graph keys, so test exact range membership.
      for (const target of [...unresolved]) {
        if (rangeContains(range, target)) discover(target, current, ref);
      }
      if (truncated) break;
      if (typeof forEachFormulaCellInRange === 'function') {
        forEachFormulaCellInRange(ref, (cell) => discover(cell, current, ref));
      }
      if (truncated) break;
    }
  }

  const results = new Map();
  for (const anchor of anchors) {
    if (!anchor.cell) {
      results.set(anchor.name, { status: 'unavailable', nodes: [], links: [] });
    } else if (parents.has(anchor.cell)) {
      results.set(anchor.name, { status: 'connected', ...reconstructPath(root, anchor.cell, parents) });
    } else if (truncated) {
      results.set(anchor.name, { status: 'truncated', nodes: [], links: [] });
    } else {
      results.set(anchor.name, { status: 'not-in-lineage', nodes: [], links: [] });
    }
  }
  return { results, visited: parents.size, truncated };
}

function expectationMet(expect, status) {
  if (status === 'truncated' || status === 'unavailable') return false;
  return expect === 'any' || expect === status;
}

function normalizeTraceEntries(auditTraces) {
  if (!auditTraces || typeof auditTraces !== 'object' || Array.isArray(auditTraces)) return [];
  return Object.entries(auditTraces).sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Build a deterministic audit-lineage document. No timestamps or absolute
 * paths are included, so identical inputs produce byte-identical JSON.
 */
export function buildAuditLineage(options) {
  const {
    manifest,
    namedOutputs = {},
    workbook = null,
    groundTruth = {},
    edges = null,
    workbookPath = null,
    groundTruthPath = null,
    forEachFormulaCellInRange = null,
  } = options || {};

  const entries = normalizeTraceEntries(manifest?.auditTraces);
  if (entries.length === 0) return null;

  const traces = {};
  const nodeRefs = new Set();
  let documentComplete = true;

  for (const [traceName, specValue] of entries) {
    const spec = specValue && typeof specValue === 'object' ? specValue : {};
    const root = resolveRoot(spec.root, namedOutputs);
    const anchors = Array.isArray(spec.anchors)
      ? spec.anchors.map(normalizeAnchor)
      : [];
    const maxVisited = normalizeMaxVisited(spec.maxVisited);
    const warnings = [];
    const paths = [];
    let visited = 0;

    if (!root.cell) warnings.push('Root did not resolve to a single cell. Use a direct cell or a scalar named output.');
    if (anchors.length === 0) warnings.push('No anchors configured.');
    if (!workbook) warnings.push('Source workbook unavailable; exact formulas could not be captured.');
    if (!edges) warnings.push('Dependency graph unavailable; paths could not be verified.');

    let search = null;
    if (root.cell && anchors.length > 0 && edges) {
      search = findPaths(root.cell, anchors, edges, forEachFormulaCellInRange, maxVisited);
      visited = search.visited;
    }

    if (root.cell) nodeRefs.add(root.cell);
    for (const anchor of anchors) {
      if (anchor.cell) nodeRefs.add(anchor.cell);
      const found = search?.results.get(anchor.name) || { status: 'unavailable', nodes: [], links: [] };
      const met = expectationMet(anchor.expect, found.status);
      if (!met) warnings.push(`${anchor.name}: expected ${anchor.expect}, observed ${found.status}.`);
      for (const cell of found.nodes) nodeRefs.add(cell);
      paths.push({
        anchor: { name: anchor.name, cell: anchor.cell, expect: anchor.expect },
        from: anchor.cell,
        to: root.cell,
        status: found.status,
        expectationMet: met,
        nodes: found.nodes,
        links: found.links,
      });
    }

    const complete = Boolean(root.cell)
      && anchors.length > 0
      && Boolean(workbook)
      && Boolean(edges)
      && paths.every((path) => path.expectationMet);
    if (!complete) documentComplete = false;

    traces[traceName] = {
      root: {
        name: root.name,
        cell: root.cell,
        groundTruthValue: root.cell && Object.prototype.hasOwnProperty.call(groundTruth, root.cell)
          ? groundTruth[root.cell]
          : null,
      },
      maxVisited,
      visited,
      status: complete ? 'complete' : 'partial',
      paths,
      warnings,
    };
  }

  const nodes = {};
  for (const ref of [...nodeRefs].sort()) {
    nodes[ref] = buildNode(ref, { workbook, groundTruth, edges: edges || {} });
  }

  return {
    $schema: AUDIT_LINEAGE_SCHEMA,
    source: {
      workbook: workbookPath ? basename(workbookPath) : null,
      workbookSha256: sha256File(workbookPath),
      groundTruthSha256: sha256File(groundTruthPath),
    },
    status: documentComplete ? 'complete' : 'partial',
    traceCount: entries.length,
    traces,
    nodes,
  };
}

/**
 * Emit `audit-lineage.json`, or remove a stale copy when the manifest no longer
 * configures traces. Returns a compact status object for the init gate.
 */
export function emitAuditLineage(chunkedDir, options = {}) {
  const outputPath = join(chunkedDir, 'audit-lineage.json');
  const doc = buildAuditLineage({ ...options, groundTruthPath: options.groundTruthPath || join(chunkedDir, '_ground-truth.json') });
  if (!doc) {
    if (existsSync(outputPath)) unlinkSync(outputPath);
    return { configured: false, written: false, status: 'not-configured', traceCount: 0, outputPath: null };
  }

  writeFileSync(outputPath, JSON.stringify(doc, null, 2) + '\n');
  return {
    configured: true,
    written: true,
    status: doc.status,
    traceCount: doc.traceCount,
    outputPath,
    doc,
  };
}

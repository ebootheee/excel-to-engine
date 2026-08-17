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
export const MAX_GLOBAL_VISITED = 2_000_000;
export const MAX_TRACE_COUNT = 64;
export const MAX_ANCHORS_PER_TRACE = 256;
export const MAX_TOTAL_ANCHORS = 1_024;

const MAX_COVERAGE_SAMPLES = 100;

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
    workbookPresent: Boolean(cell),
    groundTruthPresent,
    groundTruthValue: groundTruthPresent ? groundTruth[cellRef] : null,
    formula,
    formulaSha256: formula ? sha256Bytes(formula) : null,
    dependsOn: Array.isArray(edges?.[cellRef]) ? [...edges[cellRef]] : [],
    label: findLabel(groundTruth, cellRef),
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a lazy inspector for formulas whose full read set cannot be recovered
 * by the static A1-reference extractor. Positive paths found in the graph remain
 * valid evidence; an exhausted search cannot certify absence if any reachable
 * formula has one of these runtime-addressed reads.
 */
function buildStaticDependencyInspector(workbook) {
  const cache = new Map();
  const definedNames = (workbook?.Workbook?.Names || [])
    .map((entry) => typeof entry?.Name === 'string' ? entry.Name.trim() : '')
    .filter(Boolean)
    .map((name) => ({
      name,
      regex: new RegExp(`(^|[^A-Z0-9_.])${escapeRegExp(name)}(?=$|[^A-Z0-9_.])`, 'i'),
    }));

  return (cellRef) => {
    if (cache.has(cellRef)) return cache.get(cellRef);
    const formula = workbookCell(workbook, cellRef)?.f;
    const reasons = [];
    if (formula != null) {
      const text = String(formula);
      if (/\bINDIRECT\s*\(/i.test(text)) reasons.push('INDIRECT runtime-addressed read');
      if (/\bOFFSET\s*\(/i.test(text)) reasons.push('OFFSET runtime-addressed read');
      if (/\[[^\]]+\]/.test(text)) reasons.push('external or structured reference');
      if (/(?:^|[^A-Z0-9_'])[^!,():]+:[^!,():]+![A-Z$]/i.test(text)) reasons.push('3-D sheet reference');
      if (/(?:^|[^A-Z0-9_])\$?[A-Z]{1,3}:\$?[A-Z]{1,3}(?=$|[^0-9])/i.test(text)
          || /(?:^|[^A-Z0-9_])\$?\d+:\$?\d+(?=$|[^A-Z])/i.test(text)) {
        reasons.push('whole-row or whole-column reference');
      }
      for (const named of definedNames) {
        if (named.regex.test(text)) reasons.push(`defined name ${named.name}`);
      }
    }
    const unique = [...new Set(reasons)];
    cache.set(cellRef, unique);
    return unique;
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
function findPaths(root, anchors, edges, forEachFormulaCellInRange, maxVisited, options = {}) {
  const graphIntegrity = options.graphIntegrity || {};
  const inspectStaticDependencies = options.inspectStaticDependencies;
  const coverageSamples = [];
  let coverageUnknownCount = 0;
  const inspected = new Set();
  const inspect = (cell) => {
    if (!cell || inspected.has(cell) || typeof inspectStaticDependencies !== 'function') return;
    inspected.add(cell);
    const reasons = inspectStaticDependencies(cell);
    if (!Array.isArray(reasons) || reasons.length === 0) return;
    coverageUnknownCount++;
    if (coverageSamples.length < MAX_COVERAGE_SAMPLES) coverageSamples.push({ cell, reasons });
  };

  if (maxVisited < 1) {
    return {
      results: anchors.map(() => ({ status: 'truncated', nodes: [], links: [] })),
      visited: 0,
      truncated: true,
      coverageUnknownCount: 0,
      coverageSamples: [],
    };
  }

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
    inspect(cell);
    unresolved.delete(cell);
    if (edges[cell]) queue.push(cell);
  };

  inspect(root);
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

  const absenceIsProvable = graphIntegrity.verifiedComplete === true
    && graphIntegrity.allFormulaCells === true
    && coverageUnknownCount === 0;
  const results = [];
  for (const anchor of anchors) {
    if (!anchor.cell) {
      results.push({ status: 'unavailable', nodes: [], links: [] });
    } else if (parents.has(anchor.cell)) {
      results.push({ status: 'connected', ...reconstructPath(root, anchor.cell, parents) });
    } else if (truncated) {
      results.push({ status: 'truncated', nodes: [], links: [] });
    } else if (!absenceIsProvable) {
      results.push({ status: 'unavailable', nodes: [], links: [] });
    } else {
      results.push({ status: 'not-in-lineage', nodes: [], links: [] });
    }
  }
  return {
    results,
    visited: parents.size,
    truncated,
    coverageUnknownCount,
    coverageSamples,
  };
}

function expectationMet(expect, status) {
  if (status === 'truncated' || status === 'unavailable') return false;
  return expect === 'any' || expect === status;
}

function normalizeTraceEntries(auditTraces) {
  const errors = [];
  if (!auditTraces || typeof auditTraces !== 'object' || Array.isArray(auditTraces)) {
    return { entries: [], errors };
  }
  const all = Object.entries(auditTraces).sort(([a], [b]) => a.localeCompare(b));
  if (all.length > MAX_TRACE_COUNT) {
    errors.push(`Configured ${all.length} traces; maximum is ${MAX_TRACE_COUNT}. Extra traces were not evaluated.`);
  }
  const seen = new Set();
  for (const [name] of all) {
    const key = name.trim().toLowerCase();
    if (!name.trim() || name.length > 128) errors.push(`Trace name ${JSON.stringify(name)} must contain 1-128 characters.`);
    if (seen.has(key)) errors.push(`Trace names must be unique ignoring case: ${JSON.stringify(name)}.`);
    seen.add(key);
  }
  return { entries: all.slice(0, MAX_TRACE_COUNT), errors };
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
    graphIntegrity = null,
    maxGlobalVisited = MAX_GLOBAL_VISITED,
  } = options || {};

  const normalized = normalizeTraceEntries(manifest?.auditTraces);
  const entries = normalized.entries;
  if (entries.length === 0 && normalized.errors.length === 0) return null;

  const integrity = graphIntegrity && typeof graphIntegrity === 'object'
    ? {
        format: graphIntegrity.format || null,
        declaredEdgeCount: Number.isInteger(graphIntegrity.declaredEdgeCount) ? graphIntegrity.declaredEdgeCount : null,
        parsedEdgeCount: Number.isInteger(graphIntegrity.parsedEdgeCount) ? graphIntegrity.parsedEdgeCount : null,
        verifiedComplete: graphIntegrity.verifiedComplete === true,
        allFormulaCells: graphIntegrity.allFormulaCells === true,
      }
    : {
        format: null, declaredEdgeCount: null, parsedEdgeCount: null,
        verifiedComplete: false, allFormulaCells: false,
      };
  const workbookSha256 = sha256File(workbookPath);
  const groundTruthSha256 = sha256File(groundTruthPath);
  const sourceHashesComplete = (!workbookPath || Boolean(workbookSha256))
    && (!groundTruthPath || Boolean(groundTruthSha256));
  const inspectStaticDependencies = buildStaticDependencyInspector(workbook);
  const traces = Object.create(null);
  const nodeRefs = new Set();
  const nodeCache = new Map();
  const getNode = (ref) => {
    if (!nodeCache.has(ref)) nodeCache.set(ref, buildNode(ref, { workbook, groundTruth, edges: edges || {} }));
    return nodeCache.get(ref);
  };
  const configurationErrors = [...normalized.errors];
  let documentComplete = configurationErrors.length === 0;
  const globalVisitLimit = Number.isInteger(maxGlobalVisited) && maxGlobalVisited >= 1
    ? Math.min(maxGlobalVisited, MAX_GLOBAL_VISITED)
    : MAX_GLOBAL_VISITED;
  let remainingVisited = globalVisitLimit;
  let globalVisited = 0;
  let totalAnchors = 0;

  for (const [traceName, specValue] of entries) {
    const spec = specValue && typeof specValue === 'object' ? specValue : {};
    const root = resolveRoot(spec.root, namedOutputs);
    const rawAnchors = Array.isArray(spec.anchors) ? spec.anchors : [];
    const traceConfigErrors = [];
    if (rawAnchors.length > MAX_ANCHORS_PER_TRACE) {
      traceConfigErrors.push(`Configured ${rawAnchors.length} anchors; maximum per trace is ${MAX_ANCHORS_PER_TRACE}.`);
    }
    const totalRemaining = Math.max(0, MAX_TOTAL_ANCHORS - totalAnchors);
    const anchorLimit = Math.min(MAX_ANCHORS_PER_TRACE, totalRemaining);
    const anchors = rawAnchors.slice(0, anchorLimit).map(normalizeAnchor);
    totalAnchors += anchors.length;
    if (rawAnchors.length > totalRemaining) {
      traceConfigErrors.push(`Global anchor limit ${MAX_TOTAL_ANCHORS} reached; extra anchors were not evaluated.`);
    }
    const seenAnchorNames = new Set();
    for (const anchor of anchors) {
      const key = anchor.name.trim().toLowerCase();
      if (!anchor.name.trim() || anchor.name.length > 128) {
        traceConfigErrors.push(`Anchor name ${JSON.stringify(anchor.name)} must contain 1-128 characters.`);
      }
      if (seenAnchorNames.has(key)) {
        traceConfigErrors.push(`Anchor names must be unique ignoring case: ${JSON.stringify(anchor.name)}.`);
      }
      seenAnchorNames.add(key);
    }
    configurationErrors.push(...traceConfigErrors.map((error) => `${traceName}: ${error}`));
    const maxVisited = normalizeMaxVisited(spec.maxVisited);
    const warnings = [];
    const paths = [];
    const traceNodeRefs = new Set();
    let visited = 0;

    if (!root.cell) warnings.push('Root did not resolve to a single cell. Use a direct cell or a scalar named output.');
    if (anchors.length === 0) warnings.push('No anchors configured.');
    if (!workbook) warnings.push('Source workbook unavailable; exact formulas could not be captured.');
    if (!edges) warnings.push('Dependency graph unavailable; paths could not be verified.');
    if (edges && !integrity.verifiedComplete) warnings.push('Dependency graph byte completeness is unverified; regenerate from the current parser.');
    if (edges && !integrity.allFormulaCells) warnings.push('Dependency graph does not index every formula cell; negative lineage cannot be certified.');
    if (!sourceHashesComplete) warnings.push('Source workbook or ground-truth hash could not be captured.');
    warnings.push(...traceConfigErrors);

    let search = null;
    if (root.cell && anchors.length > 0 && edges) {
      const traversalBudget = Math.min(maxVisited, remainingVisited);
      search = findPaths(root.cell, anchors, edges, forEachFormulaCellInRange, traversalBudget, {
        graphIntegrity: integrity,
        inspectStaticDependencies,
      });
      visited = search.visited;
      remainingVisited = Math.max(0, remainingVisited - visited);
      globalVisited += visited;
      if (search.coverageUnknownCount > 0) {
        warnings.push(`${search.coverageUnknownCount} reachable formula cell(s) have runtime or unsupported references; absence is unavailable, not not-in-lineage.`);
      }
    }

    if (root.cell) {
      nodeRefs.add(root.cell);
      traceNodeRefs.add(root.cell);
    }
    for (let anchorIndex = 0; anchorIndex < anchors.length; anchorIndex++) {
      const anchor = anchors[anchorIndex];
      if (anchor.cell) {
        nodeRefs.add(anchor.cell);
        traceNodeRefs.add(anchor.cell);
      }
      const found = search?.results[anchorIndex] || { status: 'unavailable', nodes: [], links: [] };
      const met = expectationMet(anchor.expect, found.status);
      if (!met) warnings.push(`${anchor.name}: expected ${anchor.expect}, observed ${found.status}.`);
      for (const cell of found.nodes) {
        nodeRefs.add(cell);
        traceNodeRefs.add(cell);
      }
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

    const evidenceIssues = [];
    for (const ref of [...traceNodeRefs].sort()) {
      const node = getNode(ref);
      if (!node.workbookPresent) evidenceIssues.push(`${ref}: source workbook cell missing`);
      if (!node.groundTruthPresent) evidenceIssues.push(`${ref}: ground-truth value missing`);
      if (Object.prototype.hasOwnProperty.call(edges || {}, ref) && !node.formula) {
        evidenceIssues.push(`${ref}: graph identifies a formula cell but source formula is missing`);
      }
    }
    if (evidenceIssues.length > 0) warnings.push(`${evidenceIssues.length} required node evidence item(s) are missing.`);

    const complete = Boolean(root.cell)
      && anchors.length > 0
      && Boolean(workbook)
      && Boolean(edges)
      && integrity.verifiedComplete
      && integrity.allFormulaCells
      && sourceHashesComplete
      && traceConfigErrors.length === 0
      && evidenceIssues.length === 0
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
      staticCoverage: {
        graphVerifiedComplete: integrity.verifiedComplete,
        allFormulaCellsIndexed: integrity.allFormulaCells,
        unknownFormulaCount: search?.coverageUnknownCount || 0,
        unknownFormulaSamples: search?.coverageSamples || [],
      },
      evidence: {
        complete: evidenceIssues.length === 0,
        issueCount: evidenceIssues.length,
        issues: evidenceIssues.slice(0, MAX_COVERAGE_SAMPLES),
      },
      paths,
      warnings,
    };
  }

  const nodes = Object.create(null);
  for (const ref of [...nodeRefs].sort()) {
    nodes[ref] = getNode(ref);
  }

  return {
    $schema: AUDIT_LINEAGE_SCHEMA,
    source: {
      workbook: workbookPath ? basename(workbookPath) : null,
      workbookSha256,
      groundTruthSha256,
      dependencyGraph: integrity,
    },
    status: documentComplete ? 'complete' : 'partial',
    traceCount: entries.length,
    configuredTraceCount: manifest?.auditTraces && typeof manifest.auditTraces === 'object'
      ? Object.keys(manifest.auditTraces).length
      : 0,
    configurationErrors,
    traversalBudget: {
      maxVisited: globalVisitLimit,
      visited: globalVisited,
      remaining: remainingVisited,
    },
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

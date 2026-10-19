#!/usr/bin/env node
/**
 * Deterministic audit-lineage tests. Fixtures are synthetic and contain no
 * proprietary model data.
 *
 * @license MIT
 */

import XLSX from 'xlsx';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { buildAuditLineage, emitAuditLineage } from '../../lib/audit-lineage.mjs';
import {
  emitManifestMaps, forEachCellInRange, loadDependencyGraph, parseRefToken,
} from '../../lib/manifest-maps.mjs';
import { emitBuildManifest } from '../../lib/build-manifest.mjs';
import { runExplain } from '../../cli/commands/explain.mjs';
import { runInit } from '../../cli/commands/init.mjs';
import { runManifestCommand } from '../../cli/commands/manifest.mjs';

const VERIFIED_GRAPH_INTEGRITY = Object.freeze({
  format: 'cell-dependency-edges-v3',
  declaredEdgeCount: 0,
  parsedEdgeCount: 0,
  verifiedComplete: true,
  allFormulaCells: true,
});

function graphDoc(edges, format = 'cell-dependency-edges-v3') {
  return { format, edges, edgeCount: Object.keys(edges).length };
}

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) passed++;
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

function assertThrows(fn, pattern, msg) {
  try {
    fn();
    assert(false, msg);
  } catch (error) {
    assert(pattern.test(String(error?.message || error)), msg);
  }
}

function baseFixture() {
  const workbook = {
    SheetNames: ['Assumptions', 'Equity'],
    Sheets: {
      Assumptions: {
        A1: { t: 's', v: 'Paid-in capital' },
        B1: { t: 'n', v: 100 },
        C1: { t: 's', v: 'Unrelated value' },
        D1: { t: 'n', v: 999 },
      },
      Equity: {
        A2: { t: 's', v: 'Shares Issued' },
        B2: { t: 'n', v: 100, f: 'Assumptions!B1' },
        A3: { t: 's', v: 'Hurdle' },
        B3: { t: 'n', v: 140, f: 'B2*1.4' },
        A4: { t: 's', v: 'MIP Proceeds' },
        B4: { t: 'n', v: 40, f: 'MAX(B3-100,0)' },
      },
    },
  };
  const groundTruth = {
    'Assumptions!A1': 'Paid-in capital',
    'Assumptions!B1': 100,
    'Assumptions!C1': 'Unrelated value',
    'Assumptions!D1': 999,
    'Equity!A2': 'Shares Issued',
    'Equity!B2': 100,
    'Equity!A3': 'Hurdle',
    'Equity!B3': 140,
    'Equity!A4': 'MIP Proceeds',
    'Equity!B4': 40,
  };
  const edges = {
    'Equity!B2': ['Assumptions!B1'],
    'Equity!B3': ['Equity!B2'],
    'Equity!B4': ['Equity!B3'],
  };
  const manifest = {
    auditTraces: {
      capitalToMip: {
        root: 'mipPayment',
        anchors: [
          { name: 'paidInCapital', cell: 'Assumptions!B1' },
          { name: 'unrelated', cell: 'Assumptions!D1', expect: 'not-in-lineage' },
        ],
      },
    },
  };
  return {
    workbook,
    groundTruth,
    edges,
    graphIntegrity: VERIFIED_GRAPH_INTEGRITY,
    manifest,
    namedOutputs: { mipPayment: { cell: 'Equity!B4' } },
  };
}

console.log('Testing: connected + explicitly absent anchors produce a complete truthful trace');
{
  const fixture = baseFixture();
  const doc = buildAuditLineage(fixture);
  const trace = doc.traces.capitalToMip;
  const connected = trace.paths.find((p) => p.anchor.name === 'paidInCapital');
  const absent = trace.paths.find((p) => p.anchor.name === 'unrelated');
  assert(doc.$schema === 'excel-audit-lineage-v1', 'schema version emitted');
  assert(doc.status === 'complete' && trace.status === 'complete', 'expected outcomes make trace complete');
  assert(connected.status === 'connected', 'paid-in capital connects to the MIP output');
  assert(JSON.stringify(connected.nodes) === JSON.stringify([
    'Assumptions!B1', 'Equity!B2', 'Equity!B3', 'Equity!B4',
  ]), `path is source → output (${JSON.stringify(connected.nodes)})`);
  assert(absent.status === 'not-in-lineage' && absent.expectationMet, 'expected absence is recorded, not invented');
  assert(doc.nodes['Equity!B3'].formula === '=B2*1.4', 'exact source formula captured');
  assert(doc.nodes['Equity!B3'].dependsOn[0] === 'Equity!B2', 'direct dependency captured');
  assert(doc.nodes['Equity!B4'].label?.text === 'MIP Proceeds', 'adjacent label captured');
  assert(doc.nodes['Equity!B4'].groundTruthValue === 40, 'ground-truth value captured');
  assert(doc.nodes['Equity!B3'].formulaSha256?.startsWith('sha256:'), 'formula hash captured');

  const doc2 = buildAuditLineage(fixture);
  assert(JSON.stringify(doc) === JSON.stringify(doc2), 'same inputs produce byte-identical document data');
}

console.log('Testing: compact range tokens traverse formula members and literal anchors');
{
  const workbook = {
    SheetNames: ['Inputs', 'Calc', 'Summary'],
    Sheets: {
      Inputs: { A2: { t: 'n', v: 5 } },
      Calc: { A2: { t: 'n', v: 10, f: 'Inputs!A2*2' } },
      Summary: { B1: { t: 'n', v: 10, f: 'SUM(Calc!A1:A3)' } },
    },
  };
  const edges = {
    'Calc!A2': ['Inputs!A2'],
    'Summary!B1': ['Calc!A1:A3'],
  };
  const doc = buildAuditLineage({
    manifest: { auditTraces: { ranged: { root: 'Summary!B1', anchors: [{ name: 'driver', cell: 'Inputs!A2' }] } } },
    workbook,
    groundTruth: { 'Inputs!A2': 5, 'Calc!A2': 10, 'Summary!B1': 10 },
    edges,
    forEachFormulaCellInRange: (range, fn) => { if (range === 'Calc!A1:A3') fn('Calc!A2'); },
  });
  const path = doc.traces.ranged.paths[0];
  assert(path.status === 'connected', 'range member continues the dependency traversal');
  assert(JSON.stringify(path.nodes) === JSON.stringify(['Inputs!A2', 'Calc!A2', 'Summary!B1']),
    `range path is exact (${JSON.stringify(path.nodes)})`);
  assert(path.links[1]?.via === 'Calc!A1:A3', 'range token retained as path evidence');
}

console.log('Testing: streamed graph load builds its range index in the same pass');
{
  const root = mkdtempSync(join(tmpdir(), 'audit-lineage-graph-'));
  const graphPath = join(root, 'dependency-graph.json');
  writeFileSync(graphPath, [
    '{"format":"cell-dependency-edges-v3","edges":{',
    '"Calc!A2":["Inputs!A2"],',
    '"Calc!A3":["Inputs!A3"]',
    '},"edgeCount":2}',
  ].join('\n'));
  const graph = loadDependencyGraph(graphPath, 0, { buildIndex: true });
  const ranged = [];
  forEachCellInRange(graph.formulaIdx, parseRefToken('Calc!A1:A4'), (cell) => ranged.push(cell));
  assert(graph.edgeCount === 2 && Object.keys(graph.edges).length === 2, 'stream loader counts both formula edges');
  assert(graph.integrity.verifiedComplete && graph.integrity.allFormulaCells, 'stream loader verifies the complete v3 contract');
  assert(JSON.stringify(ranged) === JSON.stringify(['Calc!A2', 'Calc!A3']), 'stream-built index serves compact ranges');
  rmSync(root, { recursive: true, force: true });
}

console.log('Testing: malformed, truncated, and count-mismatched graphs never become verified evidence');
{
  const root = mkdtempSync(join(tmpdir(), 'audit-lineage-corrupt-'));
  const graphPath = join(root, 'dependency-graph.json');
  const header = '{"format":"cell-dependency-edges-v3","edges":{\n';

  writeFileSync(graphPath, header + '"Calc!A1":["Inputs!A1"],\nBROKEN\n},"edgeCount":1}\n');
  assertThrows(() => loadDependencyGraph(graphPath, 0), /malformed edge line/, 'malformed edge line throws instead of being ignored');

  writeFileSync(graphPath, header + '"Calc!A1":["Inputs!A1"]\n');
  assertThrows(() => loadDependencyGraph(graphPath, 0), /truncated before its footer/, 'missing footer is reported as truncation');

  writeFileSync(graphPath, header + '"Calc!A1":["Inputs!A1"]\n},"edgeCount":2}\n');
  assertThrows(() => loadDependencyGraph(graphPath, 0), /edgeCount mismatch/, 'declared edge count must match parsed edges');

  rmSync(root, { recursive: true, force: true });
}

console.log('Testing: legacy graph shape and dynamic reads cannot certify negative lineage');
{
  const workbook = {
    SheetNames: ['S'],
    Sheets: { S: {
      A1: { t: 'n', v: 1, f: 'OFFSET(A2,0,1)' },
      A2: { t: 'n', v: 1 },
      Z9: { t: 'n', v: 9 },
    } },
  };
  const groundTruth = { 'S!A1': 1, 'S!A2': 1, 'S!Z9': 9 };
  const edges = { 'S!A1': ['S!A2'] };
  const manifest = { auditTraces: { dynamic: {
    root: 'S!A1', anchors: [{ name: 'candidate', cell: 'S!Z9', expect: 'not-in-lineage' }],
  } } };

  const legacy = buildAuditLineage({
    manifest, workbook, groundTruth, edges,
    graphIntegrity: { ...VERIFIED_GRAPH_INTEGRITY, format: 'cell-dependency-edges-v2', allFormulaCells: false },
  });
  assert(legacy.traces.dynamic.paths[0].status === 'unavailable', 'v2 graph cannot prove absence because it omits ref-less formula keys');

  const dynamic = buildAuditLineage({
    manifest, workbook, groundTruth, edges, graphIntegrity: VERIFIED_GRAPH_INTEGRITY,
  });
  assert(dynamic.traces.dynamic.paths[0].status === 'unavailable', 'reachable OFFSET makes negative lineage unavailable');
  assert(dynamic.traces.dynamic.staticCoverage.unknownFormulaCount === 1, 'dynamic coverage gap is disclosed with its formula cell');
  assert(dynamic.status === 'partial', 'dynamic uncertainty fails the completeness gate');

  const positive = buildAuditLineage({
    manifest: { auditTraces: { positive: {
      root: 'S!A1', anchors: [{ name: 'staticAnchor', cell: 'S!A2' }],
    } } },
    workbook, groundTruth, edges, graphIntegrity: VERIFIED_GRAPH_INTEGRITY,
  });
  assert(positive.traces.positive.paths[0].status === 'connected', 'a positively observed static path remains valid around a dynamic branch');
}

console.log('Testing: required evidence, unique names, and global traversal budget are enforced');
{
  const workbook = {
    SheetNames: ['S'],
    Sheets: { S: {
      A1: { t: 'n', v: 1, f: 'A2' },
      A2: { t: 'n', v: 1, f: 'A3' },
      A3: { t: 'n', v: 1 },
      Z9: { t: 'n', v: 9 },
    } },
  };
  const groundTruth = { 'S!A1': 1, 'S!A2': 1, 'S!A3': 1, 'S!Z9': 9 };
  const edges = { 'S!A1': ['S!A2'], 'S!A2': ['S!A3'] };

  const missingEvidence = buildAuditLineage({
    manifest: { auditTraces: { evidence: { root: 'S!A1', anchors: [{ name: 'source', cell: 'S!A3' }] } } },
    workbook: { SheetNames: ['S'], Sheets: { S: { A3: { t: 'n', v: 1 } } } },
    groundTruth, edges, graphIntegrity: VERIFIED_GRAPH_INTEGRITY,
  });
  assert(missingEvidence.traces.evidence.paths[0].status === 'connected', 'graph can still record the observed path');
  assert(!missingEvidence.traces.evidence.evidence.complete && missingEvidence.status === 'partial', 'missing workbook/formula evidence prevents complete status');

  const duplicateAnchors = buildAuditLineage({
    manifest: { auditTraces: { duplicates: {
      root: 'S!A1', anchors: [
        { name: 'same', cell: 'S!A3' },
        { name: 'same', cell: 'S!Z9', expect: 'not-in-lineage' },
      ],
    } } },
    workbook, groundTruth, edges, graphIntegrity: VERIFIED_GRAPH_INTEGRITY,
  });
  assert(duplicateAnchors.configurationErrors.some((e) => e.includes('Anchor names must be unique')), 'duplicate anchor names are a configuration error');
  assert(duplicateAnchors.traces.duplicates.paths[0].status === 'connected'
    && duplicateAnchors.traces.duplicates.paths[1].status === 'not-in-lineage', 'duplicate names no longer overwrite path results');

  const duplicateTraces = buildAuditLineage({
    manifest: { auditTraces: {
      Foo: { root: 'S!A1', anchors: [{ name: 'a', cell: 'S!A3' }] },
      foo: { root: 'S!A1', anchors: [{ name: 'b', cell: 'S!A3' }] },
    } },
    workbook, groundTruth, edges, graphIntegrity: VERIFIED_GRAPH_INTEGRITY,
  });
  assert(duplicateTraces.configurationErrors.some((e) => e.includes('Trace names must be unique')), 'trace names are unique ignoring case');

  const bounded = buildAuditLineage({
    manifest: { auditTraces: {
      first: { root: 'S!A1', anchors: [{ name: 'a', cell: 'S!A3' }] },
      second: { root: 'S!A1', anchors: [{ name: 'b', cell: 'S!A3' }] },
    } },
    workbook, groundTruth, edges, graphIntegrity: VERIFIED_GRAPH_INTEGRITY, maxGlobalVisited: 2,
  });
  assert(bounded.traversalBudget.visited === 2 && bounded.traversalBudget.remaining === 0, 'all traces share one hard global visit budget');
  assert(bounded.traces.second.visited === 0 && bounded.traces.second.paths[0].status === 'truncated', 'later traces stop truthfully when global budget is exhausted');
}

console.log('Testing: cycles terminate and bounded searches report truncated');
{
  const cycle = buildAuditLineage({
    manifest: { auditTraces: { cycle: {
      root: 'Cycle!A1',
      anchors: [{ name: 'outside', cell: 'Inputs!A1', expect: 'not-in-lineage' }],
    } } },
    workbook: { SheetNames: ['Cycle', 'Inputs'], Sheets: { Cycle: {}, Inputs: {} } },
    groundTruth: { 'Cycle!A1': 1, 'Cycle!A2': 1, 'Inputs!A1': 2 },
    edges: { 'Cycle!A1': ['Cycle!A2'], 'Cycle!A2': ['Cycle!A1'] },
    graphIntegrity: VERIFIED_GRAPH_INTEGRITY,
  });
  assert(cycle.traces.cycle.paths[0].status === 'not-in-lineage', 'cycle exhausts without looping forever');

  const truncated = buildAuditLineage({
    manifest: { auditTraces: { bounded: {
      root: 'Calc!A1', maxVisited: 2,
      anchors: [{ name: 'source', cell: 'Inputs!A1' }],
    } } },
    workbook: { SheetNames: ['Calc', 'Inputs'], Sheets: { Calc: {}, Inputs: {} } },
    groundTruth: { 'Calc!A1': 1, 'Calc!A2': 1, 'Calc!A3': 1, 'Inputs!A1': 1 },
    edges: { 'Calc!A1': ['Calc!A2'], 'Calc!A2': ['Calc!A3'], 'Calc!A3': ['Inputs!A1'] },
    graphIntegrity: VERIFIED_GRAPH_INTEGRITY,
  });
  assert(truncated.status === 'partial', 'truncated document is partial');
  assert(truncated.traces.bounded.paths[0].status === 'truncated', 'bounded search reports truncated, not false absence');
}

function writeIntegrationWorkbook(path) {
  const wb = XLSX.utils.book_new();
  const assumptions = XLSX.utils.aoa_to_sheet([['Paid-in capital', 100, 'Unrelated value', 999]]);
  const equity = XLSX.utils.aoa_to_sheet([
    [''],
    ['Shares Issued', 100],
    ['Hurdle', 140],
    ['MIP Proceeds', 40],
  ]);
  equity.B2 = { t: 'n', v: 100, f: 'Assumptions!B1' };
  equity.B3 = { t: 'n', v: 140, f: 'B2*1.4' };
  equity.B4 = { t: 'n', v: 40, f: 'MAX(B3-100,0)' };
  XLSX.utils.book_append_sheet(wb, assumptions, 'Assumptions');
  XLSX.utils.book_append_sheet(wb, equity, 'Equity');
  writeFileSync(path, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

console.log('Testing: contract-map hook emits lineage, build manifest locks it, explain consumes it');
{
  const root = mkdtempSync(join(tmpdir(), 'audit-lineage-'));
  const chunked = join(root, 'chunked');
  mkdirSync(join(chunked, 'sheets'), { recursive: true });
  const xlsxPath = join(root, 'model.xlsx');
  writeIntegrationWorkbook(xlsxPath);

  const gt = baseFixture().groundTruth;
  const manifest = {
    $schema: 'manifest-v1.0',
    model: {
      name: 'Synthetic audit model', source: 'model.xlsx', type: 'pe_platform',
      groundTruth: './_ground-truth.json', engineDir: './',
    },
    timeline: {}, segments: [], equity: { classes: [] },
    customCells: { mipPayment: 'Equity!B4' },
    auditTraces: baseFixture().manifest.auditTraces,
  };
  const edges = baseFixture().edges;
  writeFileSync(join(chunked, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(chunked, '_ground-truth.json'), JSON.stringify(gt));
  writeFileSync(join(chunked, 'dependency-graph.json'), JSON.stringify(graphDoc(edges)));
  writeFileSync(join(chunked, 'engine.js'), 'export function run(){return {values:{}};}\n');
  writeFileSync(join(chunked, 'sheets', 'Equity.mjs'), 'export function compute(){}\n');

  const maps = emitManifestMaps(chunked, { excelPath: xlsxPath });
  const lineagePath = join(chunked, 'audit-lineage.json');
  assert(maps.written.includes('audit-lineage.json') && existsSync(lineagePath), 'contract-map phase writes audit-lineage.json');
  assert(maps.stats.auditLineage.status === 'complete', 'contract-map stats expose complete lineage');
  const lineage = JSON.parse(readFileSync(lineagePath, 'utf-8'));
  assert(lineage.source.workbook === 'model.xlsx', 'artifact stores basename, not an absolute source path');
  assert(lineage.source.workbookSha256?.startsWith('sha256:'), 'source workbook hash minted');
  assert(lineage.source.groundTruthSha256?.startsWith('sha256:'), 'ground-truth hash minted');

  const bm1 = emitBuildManifest(chunked, { dryRun: true, generatedAt: '2026-01-01T00:00:00.000Z' });
  const lineageArtifact = bm1.artifacts.find((a) => a.path === 'audit-lineage.json');
  assert(bm1.doc.layoutVersion === '1.1', 'artifact layout bumped to 1.1');
  assert(lineageArtifact?.identity === true && lineageArtifact.role === 'audit-lineage', 'lineage is identity-hashed');
  const engineHash = bm1.engineArtifactHash;
  writeFileSync(lineagePath, readFileSync(lineagePath, 'utf-8').replace('MIP Proceeds', 'MIP Proceeds changed'));
  const bm2 = emitBuildManifest(chunked, { dryRun: true, generatedAt: '2026-01-01T00:00:00.000Z' });
  assert(bm1.contentHash !== bm2.contentHash, 'lineage tampering changes contentHash');
  assert(engineHash === bm2.engineArtifactHash, 'lineage does not change the engine-only tamper hash');

  // Restore the genuine artifact before testing explain.
  emitManifestMaps(chunked, { excelPath: xlsxPath });
  const cellExplain = runExplain(chunked, 'Equity!B4', {});
  assert(cellExplain.formula === '=MAX(B3-100,0)', 'ete explain reads exact formula from audit lineage');
  assert(cellExplain.dependencies?.[0] === 'Equity!B3', 'ete explain reads dependencies from audit lineage');
  assert(cellExplain.auditTraces?.includes('capitalToMip'), 'cell explain identifies containing trace');
  const traceExplain = runExplain(chunked, 'capitalToMip', {});
  assert(traceExplain.status === 'complete' && traceExplain.paths?.[0]?.status === 'connected', 'ete explain accepts a trace name');

  rmSync(root, { recursive: true, force: true });
}

console.log('Testing: removing trace configuration removes a stale artifact');
{
  const root = mkdtempSync(join(tmpdir(), 'audit-lineage-stale-'));
  writeFileSync(join(root, 'audit-lineage.json'), '{}');
  const result = emitAuditLineage(root, { manifest: {} });
  assert(result.status === 'not-configured' && !existsSync(join(root, 'audit-lineage.json')), 'stale lineage is deleted');
  rmSync(root, { recursive: true, force: true });
}

console.log('Testing: re-ingest preserves owner-authored pins and --require-lineage gates completeness');
{
  const makeInitDir = (withTraces) => {
    const root = mkdtempSync(join(tmpdir(), 'audit-lineage-init-'));
    const chunked = join(root, 'chunked');
    mkdirSync(join(chunked, 'sheets'), { recursive: true });
    const xlsxPath = join(root, 'model.xlsx');
    writeIntegrationWorkbook(xlsxPath);
    const manifest = {
      $schema: 'manifest-v1.0',
      model: { source: 'model.xlsx', groundTruth: './_ground-truth.json', engineDir: './' },
      timeline: {}, segments: [], equity: { classes: [] }, carry: {},
    };
    if (withTraces) {
      manifest.auditTraces = {
        capitalToMip: {
          root: 'Equity!B4',
          anchors: [{ name: 'paidInCapital', cell: 'Assumptions!B1' }],
        },
      };
    }
    writeFileSync(join(chunked, 'manifest.json'), JSON.stringify(manifest, null, 2));
    writeFileSync(join(chunked, '_ground-truth.json'), JSON.stringify(baseFixture().groundTruth));
    writeFileSync(join(chunked, 'dependency-graph.json'), JSON.stringify(graphDoc(baseFixture().edges)));
    writeFileSync(join(chunked, 'engine.js'), 'export function run(){return {values:{}};}\n');
    writeFileSync(join(chunked, 'sheets', 'Equity.mjs'), 'export function compute(){}\n');
    return { root, chunked, xlsxPath };
  };

  const preserved = makeInitDir(true);
  const regenerated = runManifestCommand('generate', preserved.chunked, { source: 'model.xlsx' });
  assert(Boolean(regenerated.manifest?.auditTraces?.capitalToMip), 'manifest generation preserves audit trace pins');
  const gatedOk = runInit(preserved.xlsxPath, {
    output: preserved.root, reuseParse: true, requireLineage: true, noTemplate: true,
  });
  assert(!gatedOk.error, `--require-lineage accepts a complete trace (${gatedOk.error || 'ok'})`);
  assert(existsSync(join(preserved.chunked, 'audit-lineage.json')), 'successful gate ships the lineage artifact');
  assert(gatedOk._formatted.indexOf('Audit-lineage preflight') < gatedOk._formatted.indexOf('Step 2/4'),
    'configured proof is emitted before heuristic manifest generation');
  rmSync(preserved.root, { recursive: true, force: true });

  const earlyFailure = makeInitDir(true);
  const badManifestPath = join(earlyFailure.chunked, 'manifest.json');
  const badManifest = JSON.parse(readFileSync(badManifestPath, 'utf-8'));
  badManifest.auditTraces.capitalToMip.anchors[0].cell = 'Assumptions!D1';
  writeFileSync(badManifestPath, JSON.stringify(badManifest, null, 2));
  const gatedEarlyFailure = runInit(earlyFailure.xlsxPath, {
    output: earlyFailure.root, reuseParse: true, requireLineage: true, noTemplate: true,
  });
  assert(gatedEarlyFailure.error?.includes('during preflight'), 'incomplete configured proof fails in the preflight');
  assert(!gatedEarlyFailure._formatted.includes('Step 2/4'), 'failed preflight stops before expensive manifest detection');
  rmSync(earlyFailure.root, { recursive: true, force: true });

  const missing = makeInitDir(false);
  const gatedMissing = runInit(missing.xlsxPath, {
    output: missing.root, reuseParse: true, requireLineage: true, noTemplate: true,
  });
  assert(gatedMissing.error?.includes('Audit-lineage gate failed'), '--require-lineage rejects an unconfigured build');
  rmSync(missing.root, { recursive: true, force: true });
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

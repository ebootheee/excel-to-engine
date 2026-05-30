#!/usr/bin/env node
/**
 * Integration tests for the cell dependency graph (Round 2, Mippy request #3/#10).
 * Builds models, parses them with the real rust-parser, and checks:
 *
 *   - chunked/dependency-graph.json emits forward edges (cell -> cells it reads)
 *   - ranges are kept as COMPACT tokens (SUM(A1:A3) -> "S!A1:A3"), not expanded
 *     to every interior cell — the issue #32 fix (the old full expansion was
 *     37 GB / 7 min on the real models and OOM-killed the closure-baking step)
 *   - cross-sheet edges are captured
 *   - emitManifestMaps computes dependsOnNamedInputs / affectsOutputs from it,
 *     including a named input that lives INSIDE a summed range (lazy expansion)
 *
 * Needs the rust-parser binary. Skips (exit 0) if it isn't built.
 *
 * Usage: node pipelines/rust/tests/test-dependency-graph.mjs
 */

import XLSX from 'xlsx';
import { writeFileSync, existsSync, mkdtempSync, rmSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { emitManifestMaps } from '../../../lib/manifest-maps.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..', '..');
const exe = process.platform === 'win32' ? '.exe' : '';
const PARSER = [
  join(ROOT, 'pipelines/rust/target/release', `rust-parser${exe}`),
  join(ROOT, 'pipelines/rust/target/debug', `rust-parser${exe}`),
].find(existsSync);

if (!PARSER) {
  console.log('SKIP: rust-parser not built (cd pipelines/rust && cargo build --release)');
  process.exit(0);
}

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); }
}

function parse(sheets, names) {
  const wb = { SheetNames: Object.keys(sheets), Sheets: sheets };
  if (names) wb.Workbook = { Names: names };
  const tmp = mkdtempSync(join(tmpdir(), 'depg-'));
  const xlsx = join(tmp, 'm.xlsx');
  writeFileSync(xlsx, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  execFileSync(PARSER, [xlsx, join(tmp, 'out'), '--chunked'], { stdio: 'pipe' });
  return { tmp, xlsx, chunked: join(tmp, 'out', 'chunked'), cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Graph emission: range expansion + cross-sheet edges
// ---------------------------------------------------------------------------
console.log('Testing: dependency-graph.json — compact range tokens + cross-sheet');
{
  const S = {
    '!ref': 'A1:B5',
    A1: { t: 'n', v: 10 }, A2: { t: 'n', v: 20 }, A3: { t: 'n', v: 30 },
    B1: { t: 's', v: 'Total' }, B2: { t: 'n', v: 60, f: 'SUM(A1:A3)' },
    B3: { t: 's', v: 'Scaled' }, B4: { t: 'n', v: 120, f: 'B2*2' },
  };
  const T = { '!ref': 'A1:A1', A1: { t: 'n', v: 60, f: 'S!B2' } };
  const { chunked, cleanup } = parse({ S, T });

  const dg = JSON.parse(readFileSync(join(chunked, 'dependency-graph.json'), 'utf-8'));
  assert(dg.format === 'cell-dependency-edges-v2', 'graph carries the v2 format tag (compact ranges)');
  const b2 = dg.edges['S!B2'] || [];
  assert(b2.length === 1 && b2[0] === 'S!A1:A3',
    `SUM(A1:A3) stays a single compact token, not 3 cells: ${JSON.stringify(b2)}`);
  assert((dg.edges['S!B4'] || []).includes('S!B2'), 'B4 depends on B2 (single cell unchanged)');
  assert((dg.edges['T!A1'] || []).includes('S!B2'), 'cross-sheet edge T!A1 -> S!B2 captured');
  assert(!('S!A1' in dg.edges), 'literal/input cells are not keys (no outgoing edges)');
  cleanup();
}

// ---------------------------------------------------------------------------
// Closure resolves THROUGH a compact range token (issue #32 correctness
// guarantee): the BFS must descend into the formula cells that live inside a
// summed range and follow their edges — even though the range is never
// expanded in the graph. Here the output sums Helper!B1:B3 (a range token);
// B1/B2 are formula cells inside it that read the named inputs directly.
// ---------------------------------------------------------------------------
console.log('Testing: closure descends into formula cells inside a range token');
{
  const A = {
    '!ref': 'A1:C2',
    A1: { t: 's', v: 'ExitMult' }, C1: { t: 'n', v: 18 },
    A2: { t: 's', v: 'Growth' }, C2: { t: 'n', v: 0.1 },
  };
  const H = {
    '!ref': 'A1:B3',
    B1: { t: 'n', v: 36, f: 'Assumptions!C1*2' },  // formula cell inside the range; reads ExitMult
    B2: { t: 'n', v: 0.2, f: 'Assumptions!C2*2' }, // formula cell inside the range; reads Growth
    B3: { t: 'n', v: 5, f: '10/2' },               // formula cell inside the range; reads nothing
  };
  const V = {
    '!ref': 'A1:C1',
    A1: { t: 's', v: 'SumViaRange' },
    C1: { t: 'n', v: 41, f: 'SUM(Helper!B1:B3)' },  // reaches B1,B2 only via the range token
  };
  const names = [
    { Name: 'ExitMult', Ref: 'Assumptions!$C$1' },
    { Name: 'Growth', Ref: 'Assumptions!$C$2' },
  ];
  const { xlsx, chunked, cleanup } = parse({ Assumptions: A, Helper: H, Valuation: V }, names);

  // Sanity: the output's edge is a single compact range token (not 3 cells).
  const dg = JSON.parse(readFileSync(join(chunked, 'dependency-graph.json'), 'utf-8'));
  assert(JSON.stringify(dg.edges['Valuation!C1']) === '["Helper!B1:B3"]',
    `output edge is one range token: ${JSON.stringify(dg.edges['Valuation!C1'])}`);

  const manifest = {
    model: { name: 'R', source: 'm.xlsx' },
    customCells: { sumViaRange: 'Valuation!C1' },
    baseCaseOutputs: {},
  };
  writeFileSync(join(chunked, 'manifest.json'), JSON.stringify(manifest));

  const res = emitManifestMaps(chunked, { excelPath: xlsx });
  assert(res.stats.closures === true, 'closures computed (range case)');
  const no = JSON.parse(readFileSync(join(chunked, 'named-outputs.json'), 'utf-8')).namedOutputs;
  assert(JSON.stringify(no.sumViaRange?.dependsOnNamedInputs) === '["ExitMult","Growth"]',
    `BFS descends into formula cells inside the range to reach inputs: ${JSON.stringify(no.sumViaRange?.dependsOnNamedInputs)}`);
  cleanup();
}

// ---------------------------------------------------------------------------
// Closures end-to-end via emitManifestMaps
// ---------------------------------------------------------------------------
console.log('Testing: closures via emitManifestMaps (real parse -> graph -> maps)');
{
  const A = { '!ref': 'A1:C2', A1: { t: 's', v: 'Exit Mult' }, C1: { t: 'n', v: 18 }, A2: { t: 's', v: 'Growth' }, C2: { t: 'n', v: 0.1 } };
  const V = {
    '!ref': 'A1:C7',
    B1: { t: 's', v: 'EBITDA' }, B2: { t: 'n', v: 100, f: '50+50' },
    A5: { t: 's', v: 'Terminal' }, C5: { t: 'n', v: 1800, f: 'B2*Assumptions!C1' },
    A6: { t: 's', v: 'Revenue' }, C6: { t: 'n', v: 110, f: 'B2*(1+Assumptions!C2)' },
    A7: { t: 's', v: 'Combined' }, C7: { t: 'n', v: 1910, f: 'C5+C6' },
  };
  const names = [
    { Name: 'Exit_Multiple', Ref: 'Assumptions!$C$1' },
    { Name: 'Growth', Ref: 'Assumptions!$C$2' },
  ];
  const { xlsx, chunked, cleanup } = parse({ Assumptions: A, Valuation: V }, names);

  // Hand-write a manifest so the named outputs are controlled.
  const manifest = {
    model: { name: 'T', source: 'm.xlsx' },
    customCells: { terminal: 'Valuation!C5', revenue: 'Valuation!C6', combined: 'Valuation!C7' },
    baseCaseOutputs: {},
  };
  writeFileSync(join(chunked, 'manifest.json'), JSON.stringify(manifest));

  const res = emitManifestMaps(chunked, { excelPath: xlsx });
  assert(res.stats.closures === true, 'closures computed');

  const no = JSON.parse(readFileSync(join(chunked, 'named-outputs.json'), 'utf-8')).namedOutputs;
  const ni = JSON.parse(readFileSync(join(chunked, 'named-inputs.json'), 'utf-8')).namedInputs;

  assert(JSON.stringify(no.terminal.dependsOnNamedInputs) === '["Exit_Multiple"]', 'terminal <- Exit_Multiple');
  assert(JSON.stringify(no.revenue.dependsOnNamedInputs) === '["Growth"]', 'revenue <- Growth');
  assert(JSON.stringify(no.combined.dependsOnNamedInputs) === '["Exit_Multiple","Growth"]', 'combined <- both');
  assert(JSON.stringify(ni.Exit_Multiple.affectsOutputs) === '["combined","terminal"]', 'Exit_Multiple -> combined,terminal');
  assert(JSON.stringify(ni.Growth.affectsOutputs) === '["combined","revenue"]', 'Growth -> combined,revenue');
  cleanup();
}

// ---------------------------------------------------------------------------
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

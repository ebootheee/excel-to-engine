#!/usr/bin/env node
/**
 * Integration tests for the runnable-engine guarantee + build manifest
 * (P1 #23/#24). Builds models with the real rust-parser and checks:
 *
 *   - chunked/engine.js exists and exports run() on EVERY build (the artifact
 *     is now emitted before the memory-heavy dependency-graph step)
 *   - the STREAMED dependency-graph.json still emits correct forward edges
 *     (range expansion + cross-sheet) with a trailing edgeCount
 *   - emitBuildManifest locks the canonical layout, hard-flags a missing
 *     required artifact (the fail-loud gate), and produces a contentHash that is
 *     stable across rebuilds of the same model and changes when the model changes
 *
 * Needs the rust-parser binary. Skips (exit 0) if it isn't built.
 *
 * Usage: node pipelines/rust/tests/test-runnable-engine.mjs
 */

import XLSX from 'xlsx';
import { writeFileSync, existsSync, mkdtempSync, rmSync, readFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { emitBuildManifest } from '../../../lib/build-manifest.mjs';
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

// Two-sheet model with a same-sheet SUM range and a cross-sheet ref, so the
// dependency graph has content to stream. `ebitda` flows into a terminal value
// on the second sheet, so changing it perturbs the compiled output (drift test).
function model(ebitda) {
  const Assumptions = {
    '!ref': 'A1:B3',
    A1: { t: 's', v: 'EBITDA' }, B1: { t: 'n', v: ebitda },
    A2: { t: 's', v: 'Mult' },   B2: { t: 'n', v: 10 },
    A3: { t: 's', v: 'Sum' },    B3: { t: 'n', v: ebitda + 10, f: 'SUM(B1:B2)' },
  };
  const Valuation = {
    '!ref': 'A1:B1',
    A1: { t: 's', v: 'TV' },
    B1: { t: 'n', v: ebitda * 10, f: 'Assumptions!B1*Assumptions!B2' },
  };
  return { Assumptions, Valuation };
}

function parse(sheets) {
  const wb = { SheetNames: Object.keys(sheets), Sheets: sheets };
  const tmp = mkdtempSync(join(tmpdir(), 'runeng-'));
  const xlsx = join(tmp, 'm.xlsx');
  writeFileSync(xlsx, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  execFileSync(PARSER, [xlsx, join(tmp, 'out'), '--chunked'], { stdio: 'pipe' });
  return {
    tmp, xlsx,
    chunked: join(tmp, 'out', 'chunked'),
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

// Mirror `ete init`'s manifest step so the chunked dir carries the full
// canonical layout: the parser emits engine.js / sheets/ / _ground-truth.json;
// the JS pipeline adds manifest.json (+ named maps). emitManifestMaps is
// best-effort here — the build manifest only *requires* the four core files.
function finalize(chunked, xlsx) {
  const manifest = {
    model: { name: 'T', source: 'm.xlsx' },
    customCells: { tv: 'Valuation!B1' },
    baseCaseOutputs: {},
  };
  writeFileSync(join(chunked, 'manifest.json'), JSON.stringify(manifest));
  try { emitManifestMaps(chunked, { excelPath: xlsx }); } catch { /* non-essential */ }
}

// ---------------------------------------------------------------------------
console.log('Testing: engine.js lands on every build + exports run()');
{
  const { chunked, cleanup } = parse(model(100));
  const enginePath = join(chunked, 'engine.js');
  assert(existsSync(enginePath), 'chunked/engine.js exists');
  const src = readFileSync(enginePath, 'utf-8');
  assert(/export function run\s*\(/.test(src), 'engine.js exports run()');
  assert(src.includes('export default'), 'engine.js has a default export');
  assert(existsSync(join(chunked, 'sheets', '_helpers.mjs')), 'sheets/_helpers.mjs present');
  cleanup();
}

// ---------------------------------------------------------------------------
console.log('Testing: streamed dependency-graph.json — schema + edges intact');
{
  const { chunked, cleanup } = parse(model(100));
  const dg = JSON.parse(readFileSync(join(chunked, 'dependency-graph.json'), 'utf-8'));
  assert(dg.format === 'cell-dependency-edges-v1', 'graph carries the format tag');
  assert(typeof dg.edgeCount === 'number', 'edgeCount present (written last, after streaming)');
  const b3 = dg.edges['Assumptions!B3'] || [];
  assert(b3.includes('Assumptions!B1') && b3.includes('Assumptions!B2'),
    `SUM(B1:B2) expands to interior cells: ${JSON.stringify(b3)}`);
  const tv = dg.edges['Valuation!B1'] || [];
  assert(tv.includes('Assumptions!B1') && tv.includes('Assumptions!B2'),
    `cross-sheet edges captured: ${JSON.stringify(tv)}`);
  assert(dg.edgeCount === Object.keys(dg.edges).length, 'edgeCount matches the streamed edge count');
  cleanup();
}

// ---------------------------------------------------------------------------
console.log('Testing: build manifest locks the layout + marks build complete');
{
  const { chunked, xlsx, cleanup } = parse(model(100));
  finalize(chunked, xlsx);
  const bm = emitBuildManifest(chunked, { toolVersion: '0.0.0-test' });
  assert(bm.ok === true, 'build is complete (all required artifacts present)');
  assert(existsSync(join(chunked, 'build-manifest.json')), 'build-manifest.json written');
  assert(typeof bm.contentHash === 'string' && bm.contentHash.startsWith('sha256:'), 'contentHash present');
  const eng = bm.artifacts.find(a => a.path === 'engine.js');
  assert(eng && eng.required === true && eng.identity === true, 'engine.js listed as a required identity artifact');
  const sheetsArt = bm.artifacts.find(a => a.path === 'sheets/');
  assert(sheetsArt && sheetsArt.files >= 2, 'sheets/ hashed as a directory with its modules');
  const doc = JSON.parse(readFileSync(join(chunked, 'build-manifest.json'), 'utf-8'));
  assert(doc.engine.entry === 'engine.js' && doc.engine.export === 'run', 'engine entry/export recorded');
  assert(doc.complete === true && doc.missingRequired.length === 0, 'doc marks build complete');
  cleanup();
}

// ---------------------------------------------------------------------------
console.log('Testing: completeness gate fails loud when engine.js is missing');
{
  const { chunked, xlsx, cleanup } = parse(model(100));
  finalize(chunked, xlsx);
  unlinkSync(join(chunked, 'engine.js')); // simulate an OOM-killed emit
  const bm = emitBuildManifest(chunked, { dryRun: true });
  assert(bm.ok === false, 'ok=false when a required artifact (engine.js) is missing');
  assert(bm.missing.includes('engine.js'), 'engine.js reported as missing-required');
  cleanup();
}

// ---------------------------------------------------------------------------
console.log('Testing: contentHash is stable across rebuilds, changes on drift');
{
  const a = parse(model(100)); finalize(a.chunked, a.xlsx);
  const b = parse(model(100)); finalize(b.chunked, b.xlsx);
  const c = parse(model(200)); finalize(c.chunked, c.xlsx);
  const ha = emitBuildManifest(a.chunked, { dryRun: true }).contentHash;
  const hb = emitBuildManifest(b.chunked, { dryRun: true }).contentHash;
  const hc = emitBuildManifest(c.chunked, { dryRun: true }).contentHash;
  assert(ha === hb, `same model → same contentHash (${ha} vs ${hb})`);
  assert(ha !== hc, 'changed model → changed contentHash (drift detected)');
  a.cleanup(); b.cleanup(); c.cleanup();
}

// ---------------------------------------------------------------------------
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

#!/usr/bin/env node
/**
 * Integration tests for artifact slimming (Round 2, Mippy request #8).
 *
 * `ete init` should, by default, drop the large debug/intermediate artifact
 * from chunked/ — the cell-level dependency-graph.json (the biggest file on real
 * models, ~0.5 GB) — and never materialize the 600+ MB root model-map.json,
 * while keeping the high-value dependency closures baked into the named maps.
 * The 3 KB sheet-level _graph.json is KEPT (eval/per-sheet-eval reads it for
 * cluster info). `--emit-debug` retains dependency-graph.json too.
 *
 * Needs the rust-parser binary. Skips (exit 0) if it isn't built.
 *
 * Usage: node tests/cli/test-artifact-slimming.mjs
 */

import XLSX from 'xlsx';
import { writeFileSync, existsSync, mkdtempSync, rmSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { runInit } from '../../cli/commands/init.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..');
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
function assert(cond, msg) { if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); } }

// A two-sheet model with two defined-name inputs read by formulas, so
// named-inputs (and their affectsOutputs closures) are non-empty.
function makeModel() {
  const Assumptions = {
    '!ref': 'A1:C2',
    A1: { t: 's', v: 'Exit Mult' }, C1: { t: 'n', v: 18 },
    A2: { t: 's', v: 'Growth' }, C2: { t: 'n', v: 0.1 },
  };
  const Valuation = {
    '!ref': 'A1:C7',
    B1: { t: 's', v: 'EBITDA' }, B2: { t: 'n', v: 100, f: '50+50' },
    A5: { t: 's', v: 'Terminal Value' }, C5: { t: 'n', v: 1800, f: 'B2*Assumptions!C1' },
    A6: { t: 's', v: 'Revenue' }, C6: { t: 'n', v: 110, f: 'B2*(1+Assumptions!C2)' },
    A7: { t: 's', v: 'Combined' }, C7: { t: 'n', v: 1910, f: 'C5+C6' },
  };
  const names = [
    { Name: 'Exit_Multiple', Ref: 'Assumptions!$C$1' },
    { Name: 'Growth', Ref: 'Assumptions!$C$2' },
  ];
  const wb = {
    SheetNames: ['Assumptions', 'Valuation'],
    Sheets: { Assumptions, Valuation },
    Workbook: { Names: names },
  };
  const tmp = mkdtempSync(join(tmpdir(), 'slim-'));
  const xlsx = join(tmp, 'm.xlsx');
  writeFileSync(xlsx, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  return { tmp, xlsx, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Default init: debug artifacts removed, closures preserved
// ---------------------------------------------------------------------------
console.log('Testing: ete init (default) slims debug artifacts, keeps closures');
{
  const { tmp, xlsx, cleanup } = makeModel();
  const out = join(tmp, 'out');
  runInit(xlsx, { output: out });
  const chunked = join(out, 'chunked');

  assert(existsSync(join(chunked, 'engine.js')), 'engine.js emitted (sanity)');
  assert(existsSync(join(chunked, '_ground-truth.json')), '_ground-truth.json kept (load-bearing)');
  assert(existsSync(join(chunked, 'named-outputs.json')), 'named-outputs.json emitted');
  assert(existsSync(join(chunked, 'named-inputs.json')), 'named-inputs.json emitted');

  assert(!existsSync(join(chunked, 'dependency-graph.json')), 'dependency-graph.json removed by default');
  assert(existsSync(join(chunked, '_graph.json')), '_graph.json KEPT by default (3 KB; eval/per-sheet-eval reads it for cluster info)');
  assert(!existsSync(join(out, 'model-map.json')), 'root model-map.json not written by default');

  // Closures must survive the deletion — they were baked into the named maps
  // before slimming. attachDependencyClosures sets affectsOutputs on every
  // named input, so its presence proves the closure pass ran pre-slim.
  const ni = JSON.parse(readFileSync(join(chunked, 'named-inputs.json'), 'utf-8')).namedInputs;
  const inputNames = Object.keys(ni);
  assert(inputNames.length >= 2, `named inputs detected (${inputNames.join(', ') || 'none'})`);
  assert(inputNames.length > 0 && inputNames.every(n => Array.isArray(ni[n].affectsOutputs)),
    'every named input carries an affectsOutputs closure (closures ran before slim)');

  // _ground-truth.json is compact (single line, no pretty-print indentation).
  const gtRaw = readFileSync(join(chunked, '_ground-truth.json'), 'utf-8');
  assert(!gtRaw.includes('\n  '), '_ground-truth.json is compact (no pretty-print indentation)');

  cleanup();
}

// ---------------------------------------------------------------------------
// --emit-debug retains everything
// ---------------------------------------------------------------------------
console.log('Testing: ete init --emit-debug retains debug artifacts');
{
  const { tmp, xlsx, cleanup } = makeModel();
  const out = join(tmp, 'out');
  runInit(xlsx, { output: out, emitDebug: true });
  const chunked = join(out, 'chunked');

  assert(existsSync(join(chunked, 'dependency-graph.json')), 'dependency-graph.json retained with --emit-debug');
  assert(existsSync(join(chunked, '_graph.json')), '_graph.json retained with --emit-debug');
  assert(existsSync(join(out, 'model-map.json')), 'root model-map.json written with --emit-debug');

  cleanup();
}

// ---------------------------------------------------------------------------
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

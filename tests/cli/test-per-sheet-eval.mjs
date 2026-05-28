#!/usr/bin/env node
/**
 * Guard test for eval/per-sheet-eval.mjs.
 *
 * per-sheet-eval generates a temp wrapper module per sheet that imports the
 * sheet's compute() by absolute path. On Windows, ESM rejects a bare absolute
 * path ("C:\..."); it must be a file:// URL. That bug made EVERY sheet "crash"
 * at load (0% accuracy) on Windows and on the real engines — and per-sheet-eval
 * wasn't in CI, so it went unnoticed. This test runs the eval on the committed
 * smoke engine and asserts no sheet crashed and accuracy is the known-good 100%,
 * so the regression can't come back (CI runs it on ubuntu AND windows).
 *
 * Also exercises --skip-clusters (used by the Outpost benchmark).
 *
 * Pure JS; uses the committed smoke chunked fixture (no parser needed).
 */

import { execFileSync } from 'child_process';
import { mkdtempSync, cpSync, rmSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..');
const SMOKE = join(ROOT, 'pipelines', 'rust', 'tests', 'output', 'chunked');
const EVAL = join(ROOT, 'eval', 'per-sheet-eval.mjs');

let passed = 0, failed = 0;
const assert = (c, m) => { if (c) passed++; else { failed++; console.error(`  FAIL: ${m}`); } };

if (!existsSync(join(SMOKE, 'engine.js')) || !existsSync(join(SMOKE, '_graph.json'))) {
  console.log('SKIP: smoke chunked fixture not found');
  process.exit(0);
}

// Copy the fixture to a temp dir so per-sheet-eval's _eval_tmp scratch never
// touches the tracked fixture.
const tmp = mkdtempSync(join(tmpdir(), 'pse-'));
const chunked = join(tmp, 'chunked');
cpSync(SMOKE, chunked, { recursive: true });

function runEval(extraArgs) {
  const out = join(tmp, `report-${extraArgs.join('') || 'base'}.json`);
  try {
    execFileSync('node', [EVAL, chunked, '--output', out, ...extraArgs],
      { encoding: 'utf-8', stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 });
  } catch { /* nonzero exit handled via report inspection */ }
  return existsSync(out) ? JSON.parse(readFileSync(out, 'utf-8')) : null;
}

console.log('Testing: per-sheet-eval runs on the smoke engine (guards the Windows ESM-import fix)');
{
  const r = runEval([]);
  assert(r !== null, 'report written');
  if (r) {
    assert(r.summary.sheetsEvaluated >= 3, `evaluated ≥3 sheets (got ${r.summary.sheetsEvaluated})`);
    assert(r.summary.sheetsWithErrors === 0,
      `no sheet crashed at import (errors: ${r.summary.sheetsWithErrors}) — guards the abs-path → file:// fix`);
    assert(r.summary.overallAccuracy === 100, `smoke accuracy 100% (got ${r.summary.overallAccuracy})`);
  }
}

console.log('Testing: --skip-clusters produces a report without error');
{
  const r = runEval(['--skip-clusters']);
  assert(r !== null, '--skip-clusters report written');
  if (r) assert(typeof r.summary.overallAccuracy === 'number', 'summary present with --skip-clusters');
}

console.log('Testing: circular-cluster convergence (synthetic SheetA↔SheetB fixture)');
{
  const CLUSTER = join(ROOT, 'tests', 'cli', 'fixtures', 'cluster-model', 'chunked');
  if (existsSync(join(CLUSTER, '_graph.json'))) {
    const ctmp = mkdtempSync(join(tmpdir(), 'pse-cl-'));
    const cchunked = join(ctmp, 'chunked');
    cpSync(CLUSTER, cchunked, { recursive: true });
    const out = join(ctmp, 'report.json');
    try {
      execFileSync('node', [EVAL, cchunked, '--output', out], { encoding: 'utf-8', stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 });
    } catch { /* inspect report */ }
    const r = existsSync(out) ? JSON.parse(readFileSync(out, 'utf-8')) : null;
    assert(r !== null, 'cluster report written');
    if (r) {
      assert(r.summary.sheetsEvaluated === 2, `both cluster sheets evaluated (got ${r.summary.sheetsEvaluated})`);
      assert(r.summary.sheetsWithErrors === 0, `cluster converged without error (errors: ${r.summary.sheetsWithErrors})`);
      // Converges to a=50,b=50,c=100,d=100 — exercises the convergence loop and
      // the scoped (written-cells-only) convergence diff.
      assert(r.summary.overallAccuracy === 100, `cluster fixture 100% via convergence (got ${r.summary.overallAccuracy})`);
    }
    rmSync(ctmp, { recursive: true, force: true });
  } else {
    console.log('  (skip: cluster fixture missing)');
  }
}

rmSync(tmp, { recursive: true, force: true });
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

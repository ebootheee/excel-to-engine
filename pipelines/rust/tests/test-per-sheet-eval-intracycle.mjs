#!/usr/bin/env node
/**
 * Regression for eval/per-sheet-eval.mjs vs intra-sheet convergence telemetry.
 *
 * PR #52 (circular-engine honesty) made emitted sheet modules with an INTRA-sheet
 * cycle write `ctx._sheetConvergence[SHEET_NAME] = {...}` from inside compute().
 * per-sheet-eval builds its OWN hand-rolled ctx in the child eval script — and it
 * did NOT initialize `_sheetConvergence`, so the moment such a sheet's compute()
 * ran, the child threw `Cannot set properties of undefined (setting '<sheet>')`.
 *
 * That silently broke the cluster recompute on any real model with an intra-sheet
 * cycle (e.g. Outpost A-1's GPP Promote) — and the existing per-sheet-eval test
 * only exercised a CROSS-sheet cluster (whose sheets have no internal loop), so
 * it never caught it.
 *
 * This builds a single-sheet model with a convergent 2-cell mutual cycle through
 * the REAL rust-parser chunked pipeline, runs per-sheet-eval on it, and asserts
 * the sheet evaluates WITHOUT error (it crashed before the `_sheetConvergence: {}`
 * fix). The cached workbook values are the algebraic fixed point so accuracy is
 * also exact.
 *
 * Needs the rust-parser binary. Skips (exit 0) if it isn't built.
 *
 * Usage: node pipelines/rust/tests/test-per-sheet-eval-intracycle.mjs
 */

import XLSX from 'xlsx';
import { writeFileSync, existsSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..', '..');
const exe = process.platform === 'win32' ? '.exe' : '';
const PARSER = [
  join(ROOT, 'pipelines/rust/target/release', `rust-parser${exe}`),
  join(ROOT, 'pipelines/rust/target/debug', `rust-parser${exe}`),
].find(existsSync);
const EVAL = join(ROOT, 'eval', 'per-sheet-eval.mjs');

if (!PARSER) {
  console.log('SKIP: rust-parser not built (cd pipelines/rust && cargo build --release)');
  process.exit(0);
}

let passed = 0, failed = 0;
const assert = (c, m) => { if (c) { passed++; } else { failed++; console.error(`  FAIL: ${m}`); } };

// Convergent 2-cell mutual cycle: A1 = 1 + 0.5*B1, B1 = A1  → fixed point A1=B1=2.
// (A self-referential single cell is an SCC of size 1 the detector ignores; the
// cycle must be between cells to trigger the intra-sheet convergence loop that
// writes ctx._sheetConvergence.) Cached values = the algebraic fixed point.
const tmp = mkdtempSync(join(tmpdir(), 'pse-intra-'));
const S = { '!ref': 'A1:B1' };
S['A1'] = { t: 'n', v: 2, f: '1+0.5*B1' };
S['B1'] = { t: 'n', v: 2, f: 'A1' };
const wb = { SheetNames: ['Loop'], Sheets: { Loop: S } };
const xlsx = join(tmp, 'm.xlsx');
writeFileSync(xlsx, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
execFileSync(PARSER, [xlsx, join(tmp, 'out'), '--chunked'], { encoding: 'utf-8', stdio: 'pipe' });
const chunked = join(tmp, 'out', 'chunked');

console.log('Testing: per-sheet-eval runs an intra-sheet-cycle sheet without crashing (PR #52 _sheetConvergence)');
const out = join(tmp, 'report.json');
try {
  execFileSync('node', [EVAL, chunked, '--output', out], { encoding: 'utf-8', stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 });
} catch { /* inspect the report */ }
const r = existsSync(out) ? JSON.parse(readFileSync(out, 'utf-8')) : null;

assert(r !== null, 'report written');
if (r) {
  assert(r.summary.sheetsWithErrors === 0,
    `intra-sheet-cycle sheet evaluated WITHOUT error (got ${r.summary.sheetsWithErrors}) — guards the _sheetConvergence ctx fix`);
  assert(r.summary.sheetsEvaluated >= 1, `the Loop sheet was evaluated (got ${r.summary.sheetsEvaluated})`);
  // Cached values are the fixed point, so a non-crashing recompute is also exact.
  assert(r.summary.overallAccuracy === 100, `intra-cycle sheet recomputes to the fixed point (got ${r.summary.overallAccuracy}%)`);
}

rmSync(tmp, { recursive: true, force: true });
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

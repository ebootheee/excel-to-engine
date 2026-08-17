#!/usr/bin/env node
/**
 * Regression: per-sheet-eval must NEVER size-skip a cross-sheet cluster member.
 *
 * Pre-fix, the MAX_SHEET_SIZE_MB gate ran before cluster routing, so an oversized
 * member was silently dropped from the cluster task and the remaining members
 * converged WITHOUT it — a silently wrong fixed point scored as if it were the
 * model (on the real A-1 model the default 150MB cap dropped the 200MB+ monster
 * sheets from the 17-sheet returns cluster with only a skip line in the log).
 *
 * Post-fix, a cluster member over the cap is included loudly; only STANDALONE
 * sheets are size-skipped. This test runs the REAL rust-parser on a 3-sheet model
 * (Bal<->Debt cross-sheet cluster + a standalone Calc sheet) with the cap forced
 * to ~0 so EVERY module is "too large":
 *   - pre-fix:  all sheets skipped -> clustersTotal === 0 (the cluster silently
 *               never forms) — this is the RED the fix turns green.
 *   - post-fix: clustersTotal === 1, converged, cluster sheets scored 100%;
 *               the standalone sheet is still skipped as 'module too large'.
 *
 * Needs the rust-parser binary. Skips (exit 0) if it isn't built.
 *
 * Usage: node pipelines/rust/tests/test-per-sheet-eval-cluster-size.mjs
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
const S = (ref, cells) => { const s = { '!ref': ref }; for (const [k, v] of Object.entries(cells)) s[k] = v; return s; };
const n = (v, f) => (f ? { t: 'n', v, f } : { t: 'n', v });

console.log('Testing: a cluster member is never size-skipped (MAX_SHEET_SIZE_MB applies to standalone sheets only)');

// Bal<->Debt form a convergent cross-sheet cluster; Calc is standalone.
const Bal = S('A1:A1', { A1: n(2, '1+0.5*Debt!A1') });
const Debt = S('A1:A2', { A1: n(2, 'Bal!A1'), A2: n(4, 'Debt!A1+Bal!A1') });
const Calc = S('A1:A2', { A1: n(7), A2: n(14, 'A1*2') });

const tmp = mkdtempSync(join(tmpdir(), 'pse-size-'));
let report = null;
try {
  writeFileSync(join(tmp, 'm.xlsx'), XLSX.write({ SheetNames: ['Bal', 'Debt', 'Calc'], Sheets: { Bal, Debt, Calc } }, { type: 'buffer', bookType: 'xlsx' }));
  execFileSync(PARSER, [join(tmp, 'm.xlsx'), join(tmp, 'out'), '--chunked'], { encoding: 'utf-8', stdio: 'pipe' });
  const out = join(tmp, 'report.json');
  // Force the size cap to ~0 so every emitted module exceeds it.
  try {
    execFileSync('node', [EVAL, join(tmp, 'out', 'chunked'), '--output', out], {
      encoding: 'utf-8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, MAX_SHEET_SIZE_MB: '0.000001' },
    });
  } catch { /* exit code reflects accuracy threshold; inspect the report */ }
  report = existsSync(out) ? JSON.parse(readFileSync(out, 'utf-8')) : null;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

assert(report !== null, 'report written');
if (report) {
  assert(report.summary.clustersTotal === 1,
    `oversized cluster members still form the cluster task (clustersTotal=${report.summary.clustersTotal}, want 1 — 0 means members were silently size-skipped)`);
  assert(report.summary.clustersConverged === 1,
    `the full cluster converges (clustersConverged=${report.summary.clustersConverged})`);
  for (const name of ['Bal', 'Debt']) {
    const row = report.sheets.find(s => s.name === name);
    assert(row && row.status === 'ok' && row.accuracy === 100,
      `${name} scored from the full-cluster fixed point (got ${row ? `${row.status}/${row.accuracy}%` : 'no row'})`);
  }
  const calcSkip = report.skipped.find(s => s.name === 'Calc');
  assert(!!calcSkip && /too large/.test(calcSkip.reason),
    `standalone sheet is still size-skipped (got ${JSON.stringify(calcSkip || report.skipped)})`);
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

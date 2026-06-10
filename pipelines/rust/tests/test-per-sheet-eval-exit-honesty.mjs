#!/usr/bin/env node
/**
 * Regression: per-sheet-eval must exit NON-ZERO when any sheet hard-fails
 * (crash/OOM/error), regardless of tested-cell accuracy.
 *
 * A crashed sheet contributes ZERO tested cells, so the old exit gate
 * (accuracy >= 85%) never saw it: the real A-1 run where the 17-sheet cluster
 * child OOMed its heap scored 99.9% on the three surviving standalone sheets
 * and exited 0 — a confident wrong summary from the canonical harness.
 *
 * This test builds a cluster + standalone model through the REAL rust-parser
 * and kills the cluster child via a 10ms EVAL_CLUSTER_TIMEOUT_MS:
 *   - pre-fix:  standalone scores 100% -> exit 0 despite the dead cluster (RED)
 *   - post-fix: hard failure forces exit 1; the report still records the
 *     standalone accuracy and the cluster's crash/oom status (honest, visible)
 *
 * Needs the rust-parser binary. Skips (exit 0) if it isn't built.
 *
 * Usage: node pipelines/rust/tests/test-per-sheet-eval-exit-honesty.mjs
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

console.log('Testing: a hard-failed sheet forces a non-zero exit (accuracy alone is a dishonest gate)');

// Bal<->Debt form a cluster (its child gets killed); Calc is a healthy standalone.
const Bal = S('A1:A1', { A1: n(2, '1+0.5*Debt!A1') });
const Debt = S('A1:A2', { A1: n(2, 'Bal!A1'), A2: n(4, 'Debt!A1+Bal!A1') });
const Calc = S('A1:A2', { A1: n(7), A2: n(14, 'A1*2') });

const tmp = mkdtempSync(join(tmpdir(), 'pse-exit-'));
let exitCode = 0, report = null;
try {
  writeFileSync(join(tmp, 'm.xlsx'), XLSX.write({ SheetNames: ['Bal', 'Debt', 'Calc'], Sheets: { Bal, Debt, Calc } }, { type: 'buffer', bookType: 'xlsx' }));
  execFileSync(PARSER, [join(tmp, 'm.xlsx'), join(tmp, 'out'), '--chunked'], { encoding: 'utf-8', stdio: 'pipe' });
  const out = join(tmp, 'report.json');
  try {
    execFileSync('node', [EVAL, join(tmp, 'out', 'chunked'), '--output', out], {
      encoding: 'utf-8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, EVAL_CLUSTER_TIMEOUT_MS: '10' }, // kill the cluster child mid-boot
    });
  } catch (e) { exitCode = e.status ?? 1; }
  report = existsSync(out) ? JSON.parse(readFileSync(out, 'utf-8')) : null;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

assert(report !== null, 'report written despite the dead cluster');
if (report) {
  const calc = report.sheets.find(s => s.name === 'Calc');
  assert(calc && calc.status === 'ok' && calc.accuracy === 100,
    `healthy standalone still scored (got ${calc ? `${calc.status}/${calc.accuracy}%` : 'no row'})`);
  const dead = report.sheets.filter(s => ['crash', 'oom', 'error'].includes(s.status));
  assert(dead.length === 2,
    `both cluster members recorded as hard-failed (got ${dead.length}: ${report.sheets.map(s => `${s.name}=${s.status}`).join(', ')})`);
  assert(report.summary.clustersConverged === 0, `cluster not reported converged (got ${report.summary.clustersConverged})`);
}
assert(exitCode !== 0,
  `eval exits NON-ZERO when a sheet hard-fails (got exit ${exitCode} — pre-fix the 100% standalone hid the dead cluster)`);

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

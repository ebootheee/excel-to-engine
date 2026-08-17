#!/usr/bin/env node
/**
 * Regression for eval/per-sheet-eval.mjs convergence LOCKSTEP with the shipped engine
 * (#57 follow-up). The #57 Commit A made the cross-sheet cluster loop transient-tolerant
 * in BOTH chunked_emitter.rs (engine.js) and per-sheet-eval.mjs. But the eval harness was
 * missing the engine's honesty NaN-fill on non-convergence: on a cluster that does NOT
 * converge (a structural #DIV/0! or a divergent cycle), the shipped engine NaN-fills every
 * cluster cell (so eng.run() returns NaN — detectably unusable), whereas the eval harness
 * kept the WARM-SEEDED ground-truth values and therefore reported those cells as ~100%
 * "measured" — over-reporting accuracy on exactly the returns/MIP named outputs the engine
 * refuses to trust (the lite/cone accuracy numbers are read from this harness).
 *
 * Fix: per-sheet-eval now NaN-fills the cells a non-converged cluster wrote (mirroring
 * chunked_emitter.rs) and stores the non-finite delta baseline so a warming cell is judged
 * on the same pass the engine judges it. This test builds cross-sheet clusters through the
 * REAL rust-parser and runs per-sheet-eval:
 *   - CONVERGENT cluster -> clustersConverged===1, ~100% accuracy (unchanged).
 *   - STRUCTURAL #DIV/0! cluster -> clustersConverged===0 AND the warm-seeded cells are
 *     NaN-filled so accuracy is LOW (pre-fix this reported ~80% by keeping the GT seed).
 *
 * Needs the rust-parser binary. Skips (exit 0) if it isn't built.
 *
 * Usage: node pipelines/rust/tests/test-per-sheet-eval-lockstep.mjs
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

function evalModel(sheets, names) {
  const tmp = mkdtempSync(join(tmpdir(), 'pse-lock-'));
  writeFileSync(join(tmp, 'm.xlsx'), XLSX.write({ SheetNames: names, Sheets: sheets }, { type: 'buffer', bookType: 'xlsx' }));
  execFileSync(PARSER, [join(tmp, 'm.xlsx'), join(tmp, 'out'), '--chunked'], { encoding: 'utf-8', stdio: 'pipe' });
  const out = join(tmp, 'report.json');
  try { execFileSync('node', [EVAL, join(tmp, 'out', 'chunked'), '--output', out], { encoding: 'utf-8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 }); } catch { /* inspect report */ }
  const r = existsSync(out) ? JSON.parse(readFileSync(out, 'utf-8')) : null;
  rmSync(tmp, { recursive: true, force: true });
  return r;
}

console.log('Testing: per-sheet-eval NaN-fills a non-converged cluster (lockstep with engine.js)');

// MODEL A — CONVERGENT cross-sheet cluster (no non-finite). Must report converged + ~100%.
{
  const Bal = S('A1:A1', { A1: n(2, '1+0.5*Debt!A1') });
  const Debt = S('A1:A2', { A1: n(2, 'Bal!A1'), A2: n(4, 'Debt!A1+Bal!A1') });
  const r = evalModel({ Bal, Debt }, ['Bal', 'Debt']);
  assert(r !== null, 'MODEL A report written');
  if (r) {
    assert(r.summary.clustersConverged === r.summary.clustersTotal && r.summary.clustersTotal >= 1,
      `MODEL A convergent cluster reports converged (got ${r.summary.clustersConverged}/${r.summary.clustersTotal})`);
    assert(r.summary.overallAccuracy === 100,
      `MODEL A convergent cluster recomputes to the fixed point, 100% (got ${r.summary.overallAccuracy}%)`);
  }
}

// MODEL B — STRUCTURAL #DIV/0! cross-sheet cluster (Bal!A1->0; Debt!A3=100/Bal!A1=Inf).
// Must report converged=false AND NaN-fill the warm-seeded cells -> LOW accuracy. Pre-fix
// the harness kept the GT seed for A2/A4 and reported ~80%.
{
  const Bal = S('A1:A1', { A1: n(0, '0.5*Debt!A1') });
  const Debt = S('A1:A4', {
    A1: n(0, 'Bal!A1'),
    A2: n(100, 'Debt!A1+100'),
    A3: n(0, 'Debt!A2/Bal!A1'),
    A4: n(100, 'Debt!A2+Debt!A1'),
  });
  const r = evalModel({ Bal, Debt }, ['Bal', 'Debt']);
  assert(r !== null, 'MODEL B report written');
  if (r) {
    assert(r.summary.clustersConverged === 0,
      `MODEL B structural #DIV/0! cluster reports converged=false (got clustersConverged=${r.summary.clustersConverged})`);
    assert(r.summary.overallAccuracy < 50,
      `MODEL B non-converged cluster is NaN-filled -> LOW accuracy (got ${r.summary.overallAccuracy}%); pre-fix kept warm-seed GT and reported ~80%`);
  }
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

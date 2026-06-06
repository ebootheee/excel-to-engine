#!/usr/bin/env node
/**
 * Engine-HONESTY regression for single-sheet circular references.
 *
 * The chunked emitter's CROSS-sheet convergence loop records telemetry
 * (_clusterMeta -> meta.converged / meta.perSheetIterations). But a model whose
 * ENTIRE cycle lives on ONE sheet has NO sheet cluster (SCC detection is
 * sheet-level, sheet_partition.rs), so before this fix it took the ACYCLIC
 * orchestrator path: _clusterMeta stayed [], converged = [].every() = true, and
 * perSheetIterations = {} — REGARDLESS of whether the single sheet actually
 * reached a fixed point. The emitted `meta` was byte-identical between a
 * converged, a slow-contractive, and a fully DIVERGENT single-sheet-cycle run.
 * A downstream lock-grade consumer had ZERO signal the answer was wrong (F4).
 *
 * Separately, the old intra/cross-sheet "stale" early-break treated a CONSTANT
 * non-zero per-iteration delta (i.e. divergence, or a ratio→1⁻ crawl) as
 * "stopped improving" and broke — returning silent garbage still labelled
 * converged:true (F2/F3).
 *
 * This test builds tiny 2-cell mutual cycles through the REAL rust-parser
 * chunked pipeline and asserts the honesty contract:
 *
 *   1. CONVERGENT cycle (x = 1 + x/2, contracting ratio 1/2) →
 *        meta.converged === true, perSheetIterations POPULATED (not {}),
 *        value is the correct fixed point (2).
 *   2. DIVERGENT cycle (x = 1 + 2x, delta doubles each pass) →
 *        meta.converged === false AND the cycle cells are NaN (not a confident
 *        wrong number). << This assertion FAILS on current main (the bug) and
 *        PASSES after the fix — the negative control. >>
 *   3. SLOW-CONTRACTIVE cycle (ratio 0.999) → must NOT silently report
 *        converged:true with a materially wrong value: either converges to the
 *        true fixed point within the cap, or honestly reports converged:false
 *        (NaN-filled).
 *
 * NON-CIRCULARITY (docs/LITE-TEST-STANDARD.md): every expected fixed point is
 * derived ALGEBRAICALLY here, independent of the engine, and the divergent case
 * is a NEGATIVE CONTROL whose "confident wrong number" the old code produced.
 *
 * Needs the rust-parser binary. Skips (exit 0) if it isn't built.
 *
 * Usage: node pipelines/rust/tests/test-circular-honesty.mjs
 */

import XLSX from 'xlsx';
import { writeFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

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

/** Build a workbook from a {sheetName: cells} spec, parse it, import engine.js. */
async function buildEngine(sheets) {
  const wb = { SheetNames: Object.keys(sheets), Sheets: sheets };
  const tmp = mkdtempSync(join(tmpdir(), 'circ-honesty-'));
  const xlsx = join(tmp, 'm.xlsx');
  writeFileSync(xlsx, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  execFileSync(PARSER, [xlsx, join(tmp, 'out'), '--chunked'], { encoding: 'utf-8', stdio: 'pipe' });
  const eng = await import(pathToFileURL(join(tmp, 'out', 'chunked', 'engine.js')).href + `?t=${Date.now()}`);
  return { eng, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

// A two-cell MUTUAL cycle: A1 = 1 + k*B1, B1 = A1. (A single self-referential
// cell A1=1+k*A1 is an SCC of size 1, which the detector deliberately ignores —
// the cycle must be between cells.) Cell values carry a small finite seed so the
// first iteration has a numeric baseline.
function cycleSheet(k) {
  const S = { '!ref': 'A1:B1' };
  S['A1'] = { t: 'n', v: 0, f: `1+${k}*B1` };
  S['B1'] = { t: 'n', v: 0, f: 'A1' };
  return { Loop: S };
}

// ---------------------------------------------------------------------------
// 1. CONVERGENT cycle — A1 = 1 + B1/2, B1 = A1. Fixed point A1 = B1 = 2.
//    Contracting ratio 1/2, reaches 1e-6 in well under the 200-iter cap.
// ---------------------------------------------------------------------------
console.log('Testing: CONVERGENT single-sheet cycle (x = 1 + x/2 -> 2)');
{
  const FIXED_POINT = 2; // algebraic: a = 1 + a/2 => a = 2 (independent of engine)
  const { eng, cleanup } = await buildEngine(cycleSheet('0.5'));
  const r = eng.run();

  assert(r.meta.converged === true,
    `convergent cycle reports meta.converged === true (got ${r.meta.converged})`);
  assert(r.meta.perSheetIterations && r.meta.perSheetIterations['Loop'] > 0,
    `perSheetIterations is POPULATED for the single-sheet cycle (not {}); ` +
    `got ${JSON.stringify(r.meta.perSheetIterations)}`);
  assert(Math.abs(r.values['Loop!A1'] - FIXED_POINT) < 1e-5,
    `A1 converges to the correct fixed point ${FIXED_POINT} (got ${r.values['Loop!A1']})`);
  assert(Math.abs(r.values['Loop!B1'] - FIXED_POINT) < 1e-5,
    `B1 converges to the correct fixed point ${FIXED_POINT} (got ${r.values['Loop!B1']})`);
  assert(r.meta.sheetConvergence && r.meta.sheetConvergence['Loop'] &&
         r.meta.sheetConvergence['Loop'].converged === true,
    `meta.sheetConvergence['Loop'].converged === true`);

  cleanup();
}

// ---------------------------------------------------------------------------
// 2. DIVERGENT cycle — A1 = 1 + 2*B1, B1 = A1.  a = 1 + 2a has no stable fixed
//    point under iteration; |delta| roughly doubles each pass (monotone up).
//    THE NEGATIVE CONTROL: old code broke on the "stale"/cap path and returned a
//    confident (huge / Infinity) number labelled converged:true. The fix must
//    report converged:false AND NaN-fill the cells.
// ---------------------------------------------------------------------------
console.log('Testing: DIVERGENT single-sheet cycle (x = 1 + 2x) — negative control');
{
  const { eng, cleanup } = await buildEngine(cycleSheet('2'));
  const r = eng.run();

  assert(r.meta.converged === false,
    `divergent cycle reports meta.converged === FALSE (got ${r.meta.converged}) ` +
    `— this is the assertion that FAILS on pre-fix main (was silently true)`);
  assert(Number.isNaN(r.values['Loop!A1']),
    `divergent A1 is NaN (detectably unusable), NOT a confident wrong number ` +
    `(got ${r.values['Loop!A1']})`);
  assert(Number.isNaN(r.values['Loop!B1']),
    `divergent B1 is NaN (got ${r.values['Loop!B1']})`);
  assert(r.meta.sheetConvergence && r.meta.sheetConvergence['Loop'] &&
         r.meta.sheetConvergence['Loop'].converged === false,
    `meta.sheetConvergence['Loop'].converged === false`);

  cleanup();
}

// ---------------------------------------------------------------------------
// 3. SLOW-CONTRACTIVE cycle — A1 = 1 + 0.999*B1, B1 = A1. True fixed point
//    A1 = 1000, but ratio 0.999 needs ~tens-of-thousands of iters to hit 1e-6;
//    at the 200-iter cap the value is still FAR from 1000. The honesty contract:
//    must NOT report converged:true with that materially-wrong value. Acceptable
//    outcomes: (a) converged:true AND value ≈ 1000, or (b) converged:false (and
//    then NaN-filled). What is FORBIDDEN is converged:true with a wrong number.
// ---------------------------------------------------------------------------
console.log('Testing: SLOW-CONTRACTIVE cycle (ratio 0.999) — must not silently lie');
{
  const TRUE_FP = 1000; // algebraic: a = 1 + 0.999a => a = 1000
  const { eng, cleanup } = await buildEngine(cycleSheet('0.999'));
  const r = eng.run();
  const a = r.values['Loop!A1'];

  if (r.meta.converged === true) {
    // If it claims convergence, the value MUST actually be the fixed point.
    assert(Math.abs(a - TRUE_FP) < 1e-3,
      `slow-contractive: if converged:true, value must be ≈ ${TRUE_FP} ` +
      `(got ${a}) — converged:true with a materially wrong value is the lie we forbid`);
  } else {
    // Honestly reported non-converged → cells NaN-filled, value not trusted.
    assert(Number.isNaN(a),
      `slow-contractive: when converged:false, cells are NaN-filled (got ${a})`);
    passed++; // record the honest-non-converged path as a covered outcome
    console.log('    (slow-contractive honestly reported converged:false — acceptable)');
  }
  // Either way, the cells must never be a confident wrong finite number.
  assert(!(Number.isFinite(a) && Math.abs(a - TRUE_FP) >= 1e-3 && r.meta.converged === true),
    `slow-contractive never returns a confident wrong number labelled converged`);

  cleanup();
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

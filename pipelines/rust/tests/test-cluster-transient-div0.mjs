#!/usr/bin/env node
/**
 * Regression for issue #57 — bare-division Infinity blocking cross-sheet cluster
 * convergence (the lock-grade "Debt!AR84" symptom).
 *
 * The emitted cross-sheet cluster convergence loop (chunked_emitter.rs) used to
 * ABORT on the first non-finite sampled cell (a `_nonFiniteStreak >= 3` early break)
 * and then NaN-fill the WHOLE cluster. On the real Outpost A-1 returns cluster, a
 * coverage/amortization ratio divides by a denominator that is a COLD 0 at iteration
 * 0 and WARMS to nonzero as the cluster solves; the bare division is transiently
 * Infinity, poisons a downstream SUM (Debt!AR84), and the loop quit at iteration 3 —
 * BEFORE the denominator warmed — reporting converged=false and destroying the
 * cluster's true (finite) fixed point. totalCarry / class-*.equityBasis measured 0%.
 *
 * The fix makes the loop TRANSIENT-TOLERANT: a non-finite cell is excluded from the
 * delta and the loop keeps iterating; non-finiteness is judged ONLY at the fixed
 * point. A TRANSIENT cold-0 warms and the cluster converges to the correct numbers;
 * a STRUCTURAL #DIV/0! that never warms stays non-finite and stays converged=false
 * (honest — the existing NaN-fill contract is preserved, never a silent wrong number).
 *
 * This builds tiny CROSS-SHEET clusters through the REAL rust-parser chunked pipeline
 * and drives the EMITTED engine via eng.run() (cold-start — the reliable surface;
 * per-sheet-eval warm-seeds full GT on a tiny model and would not reproduce the
 * transient). Pre-fix observed: MODEL A converged=false + Debt!A5=NaN. The fix only
 * relaxes the NON-finite handling, so divergence (MODEL E) and structural #DIV/0!
 * (MODEL C) still fail honestly, and the IFERROR boundary (MODEL D) is unaffected.
 *
 * Needs the rust-parser binary. Skips (exit 0) if it isn't built.
 *
 * Usage: node pipelines/rust/tests/test-cluster-transient-div0.mjs
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

let passed = 0, failed = 0;
const assert = (c, m) => { if (c) { passed++; } else { failed++; console.error(`  FAIL: ${m}`); } };
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;

const S = (ref, cells) => { const s = { '!ref': ref }; for (const [k, v] of Object.entries(cells)) s[k] = v; return s; };
const n = (v, f) => (f ? { t: 'n', v, f } : { t: 'n', v });

async function run(sheets, names, tag) {
  const tmp = mkdtempSync(join(tmpdir(), 'cl57-'));
  writeFileSync(join(tmp, 'm.xlsx'), XLSX.write({ SheetNames: names, Sheets: sheets }, { type: 'buffer', bookType: 'xlsx' }));
  execFileSync(PARSER, [join(tmp, 'm.xlsx'), join(tmp, 'out'), '--chunked'], { encoding: 'utf-8', stdio: 'pipe' });
  const eng = await import(pathToFileURL(join(tmp, 'out', 'chunked', 'engine.js')).href + `?t=${tag}`);
  const r = eng.run();
  rmSync(tmp, { recursive: true, force: true });
  return r;
}

console.log('Testing: cross-sheet cluster tolerates a TRANSIENT divide-by-cold-0 and converges (#57)');

// MODEL A — TRANSIENT: a bare division by a denominator that is 0 for >=3 passes
// (gated on the cycle warming past 1.9) then warms. The cycle Bal!A1<->Debt!A1 has
// fixed point 2; Debt!A4=200/gate is Infinity for the cold passes then 100; Debt!A5
// is a pure SUM that inherits (the Debt!AR84 analog). Pre-fix: streak>=3 break ->
// converged=false, whole cluster NaN-filled. Post-fix: warms and converges.
{
  const Bal = S('A1:A1', { A1: n(2, '1+0.5*Debt!A1') });
  const Debt = S('A1:A5', {
    A1: n(2, 'Bal!A1'),
    A2: n(2, 'IF(Bal!A1>1.9,Bal!A1,0)'),
    A3: n(200),
    A4: n(100, 'Debt!A3/Debt!A2'),
    A5: n(300, 'SUM(Debt!A3,Debt!A4)'),
  });
  const r = await run({ Bal, Debt }, ['Bal', 'Debt'], 'A');
  const v = r.values;
  assert(r.meta.converged === true, `MODEL A transient converges (got converged=${r.meta.converged}) — pre-fix this was false`);
  assert(near(v['Bal!A1'], 2, 1e-4), `MODEL A cycle reaches its true fixed point 2 (got ${v['Bal!A1']}) — pre-fix NaN-filled`);
  assert(near(v['Debt!A4'], 100, 1e-3), `MODEL A transient division resolves to 100 (got ${v['Debt!A4']})`);
  assert(near(v['Debt!A5'], 300, 1e-3), `MODEL A AR84-analog SUM is finite & correct 300 (got ${v['Debt!A5']}) — pre-fix NaN`);
  const cl = (r.meta.clusters || []).find(c => c.sheets.includes('Debt'));
  assert(cl && cl.converged === true, `MODEL A cluster meta converged (got ${JSON.stringify(cl)})`);
  assert(cl && cl.nonFiniteCell === null, `MODEL A converged cluster has no residual nonFiniteCell (got ${cl && cl.nonFiniteCell})`);
  const leaks = Object.entries(v).filter(([, x]) => typeof x === 'number' && !Number.isFinite(x));
  assert(leaks.length === 0, `MODEL A no non-finite leaks at the fixed point (got ${JSON.stringify(leaks)})`);
}

// MODEL C — STRUCTURAL #DIV/0! into the cluster (denominator -> 0 forever, NOT
// IFERROR-wrapped). Must STAY converged=false with the cell NaN (honest), NEVER a
// fabricated finite number. Guards that the transient tolerance did not slide into
// an Option-3 silent x/0 -> 0 substitution.
{
  const Bal = S('A1:A1', { A1: n(0, '0.5*Debt!A1') });
  const Debt = S('A1:A4', {
    A1: n(0, 'Bal!A1'),
    A2: n(5),
    A3: n(0, 'Debt!A2/Bal!A1'),
    A4: n(5, 'SUM(Debt!A2,Debt!A3)'),
  });
  const r = await run({ Bal, Debt }, ['Bal', 'Debt'], 'C');
  const v = r.values;
  assert(r.meta.converged === false, `MODEL C structural #DIV/0! stays converged=false (got ${r.meta.converged})`);
  assert(typeof v['Debt!A3'] === 'number' && !Number.isFinite(v['Debt!A3']),
    `MODEL C structural division is non-finite/NaN, NOT a fabricated finite value (got ${v['Debt!A3']})`);
  assert(typeof v['Debt!A4'] === 'number' && !Number.isFinite(v['Debt!A4']),
    `MODEL C SUM inheriting the structural #DIV/0! is non-finite, NOT a silent number (got ${v['Debt!A4']})`);
}

// MODEL D — STRUCTURAL #DIV/0! CAUGHT by IFERROR. The division is absorbed (no
// non-finite cell exists), so the cluster converges and the fallback flows through.
{
  const Bal = S('A1:A1', { A1: n(0, '0.5*Debt!A1') });
  const Debt = S('A1:A4', {
    A1: n(0, 'Bal!A1'),
    A2: n(5),
    A3: n(-1, 'IFERROR(Debt!A2/Bal!A1,-1)'),
    A4: n(4, 'SUM(Debt!A2,Debt!A3)'),
  });
  const r = await run({ Bal, Debt }, ['Bal', 'Debt'], 'D');
  const v = r.values;
  assert(r.meta.converged === true, `MODEL D IFERROR-caught #DIV/0! converges (got ${r.meta.converged})`);
  assert(v['Debt!A3'] === -1, `MODEL D IFERROR fallback = -1 (got ${v['Debt!A3']})`);
  assert(near(v['Debt!A4'], 4, 1e-9), `MODEL D SUM of the caught fallback = 4 (got ${v['Debt!A4']})`);
}

// MODEL E — cross-sheet DIVERGENT cycle (x = 1 + 2x, no stable fixed point; grows
// unbounded). Removing the non-finite streak-break must NOT let a divergent cluster
// falsely converge or churn to MAX_ITER — the monotone-up divergence detector must
// still fire and NaN-fill. Guards the divergence path of the changed loop.
{
  const Bal = S('A1:A1', { A1: n(1, '1+2*Debt!A1') });
  const Debt = S('A1:A1', { A1: n(1, 'Bal!A1') });
  const r = await run({ Bal, Debt }, ['Bal', 'Debt'], 'E');
  const v = r.values;
  assert(r.meta.converged === false, `MODEL E divergent cycle reports converged=false (got ${r.meta.converged})`);
  assert(typeof v['Bal!A1'] === 'number' && !Number.isFinite(v['Bal!A1']),
    `MODEL E divergent cell is NaN-filled (do-not-trust), not a confident number (got ${v['Bal!A1']})`);
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

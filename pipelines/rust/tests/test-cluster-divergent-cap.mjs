#!/usr/bin/env node
/**
 * Regression for issue #61 — the engine should not churn to MAX_ITER on a cluster that is
 * BOTH divergent AND carries a persistent (structural) non-finite cell.
 *
 * The #57 Commit A non-finite branch `continue`s before the monotone-up/flat-hot divergence
 * detector, and its structural short-circuit only advances when the FINITE surface has
 * SETTLED. A cluster whose finite surface is DIVERGING while a cell stays non-finite never
 * settles, so pre-#61 it ran all MAX_ITER=200 passes (multi-hour on the real A-1, ~1 min/pass)
 * before NaN-filling. The #61 fix adds a generous absolute non-finite-pass cap so such a
 * hopeless cluster stops well below MAX_ITER. The answer is correct/honest either way
 * (converged=false, NaN-filled) — this only bounds the wasted work.
 *
 * Builds a cross-sheet cluster that is divergent (x = 1 + 2x) AND has a structural
 * #DIV/0! (1/(A2-A2)) and asserts via eng.run() that it stops far below MAX_ITER.
 *
 * Needs the rust-parser binary. Skips (exit 0) if it isn't built.
 *
 * Usage: node pipelines/rust/tests/test-cluster-divergent-cap.mjs
 */

import XLSX from 'xlsx';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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

console.log('Testing: divergent + persistent-structural-non-finite cluster stops below MAX_ITER (#61)');

// Cross-sheet cluster Bal!A1 <-> Debt!A1, divergent (x = 1 + 2x, no stable fixed point).
// Debt!A4 = 1/(A2-A2) is a STRUCTURAL #DIV/0! (NaN) every pass, so the loop always takes the
// non-finite branch and never reaches the divergence detector — pre-#61 it ran 200 passes.
const Bal = { '!ref': 'A1:A1' };
Bal['A1'] = { t: 'n', v: 1, f: '1+2*Debt!A1' };
const Debt = { '!ref': 'A1:A4' };
Debt['A1'] = { t: 'n', v: 1, f: 'Bal!A1' };
Debt['A2'] = { t: 'n', v: 5 };
Debt['A3'] = { t: 'n', v: 0, f: 'Debt!A2-Debt!A2' };  // structural zero
Debt['A4'] = { t: 'n', v: 0, f: '1/Debt!A3' };        // 1/0 -> NaN every pass (structural)

const tmp = mkdtempSync(join(tmpdir(), 'cap61-'));
writeFileSync(join(tmp, 'm.xlsx'), XLSX.write({ SheetNames: ['Bal', 'Debt'], Sheets: { Bal, Debt } }, { type: 'buffer', bookType: 'xlsx' }));
execFileSync(PARSER, [join(tmp, 'm.xlsx'), join(tmp, 'out'), '--chunked'], { encoding: 'utf-8', stdio: 'pipe' });
const eng = await import(pathToFileURL(join(tmp, 'out', 'chunked', 'engine.js')).href);
const r = eng.run();
rmSync(tmp, { recursive: true, force: true });

const cl = (r.meta.clusters || []).find(c => c.sheets.includes('Debt'));
assert(r.meta.converged === false, `divergent+structural cluster reports converged=false (got ${r.meta.converged})`);
assert(cl && cl.iterations < 100, `cluster stops well below MAX_ITER=200 (got iterations=${cl && cl.iterations}) — pre-#61 it churned to 200`);
assert(typeof r.values['Debt!A4'] === 'number' && !Number.isFinite(r.values['Debt!A4']),
  `the structural #DIV/0! cell is non-finite/NaN (got ${r.values['Debt!A4']})`);
assert(typeof r.values['Bal!A1'] === 'number' && !Number.isFinite(r.values['Bal!A1']),
  `the divergent cycle cell is NaN-filled, not a confident number (got ${r.values['Bal!A1']})`);

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

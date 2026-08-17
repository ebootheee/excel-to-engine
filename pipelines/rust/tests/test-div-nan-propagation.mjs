#!/usr/bin/env node
/**
 * Regression for issue #60 — the latent honesty hole: an un-IFERROR'd aggregate over a
 * #DIV/0! used to return a CONFIDENT WRONG NUMBER.
 *
 * Excel #DIV/0! surfaces in JS as `x/0`->±Infinity and `0/0`->NaN. The old reducer
 * `reduce((a,b)=>a+(+b||0),0)` PROPAGATED Infinity but SILENTLY DROPPED NaN
 * (`+NaN||0 === 0`), so `=SUM(100, 0/0, 250)` returned **350** (Excel: #DIV/0!) — on
 * ACYCLIC cells the #57 convergence machinery never inspects.
 *
 * Fix (#60 / "Commit B"): route every division through `_div` (collapses `x/0` and `0/0`
 * to one NaN sentinel that IFERROR already catches post-#55) and make SUM/SUMPRODUCT/
 * AVERAGE/SUMIF/SUMIFS propagate a non-finite NUMBER as NaN — while still treating TEXT as
 * 0 (Excel ignores text in SUM). This builds tiny ACYCLIC models through the REAL
 * rust-parser and asserts Excel-faithful results via eng.run().
 *
 * Needs the rust-parser binary. Skips (exit 0) if it isn't built.
 *
 * Usage: node pipelines/rust/tests/test-div-nan-propagation.mjs
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
const isNaNv = x => typeof x === 'number' && Number.isNaN(x);

console.log('Testing: division -> _div(NaN sentinel) + SUM/AVERAGE/SUMIF/SUMPRODUCT propagate #DIV/0! (#60)');

const P = { '!ref': 'A1:D11' };
P['A1'] = { t: 'n', v: 100 };
P['A2'] = { t: 'n', v: 0 };           // a zero denominator
P['A3'] = { t: 'n', v: 250 };
P['A4'] = { t: 's', v: 'label' };     // TEXT — must be ignored (contribute 0), never NaN
// _div canonicalization: BOTH 0/0 and x/0 -> NaN
P['B1'] = { t: 'n', v: 0, f: 'A2/A2' };                  // 0/0  -> NaN
P['B2'] = { t: 'n', v: 0, f: 'A1/A2' };                  // 100/0 -> NaN (was +Infinity)
// Aggregates that inherit a #DIV/0! cell must PROPAGATE NaN (not the swallowed number)
P['B3'] = { t: 'n', v: 0, f: 'SUM(A1,B1,A3)' };          // SUM over 0/0 -> NaN (was 350)
P['B4'] = { t: 'n', v: 0, f: 'SUM(A1,B2,A3)' };          // SUM over x/0 -> NaN
P['B5'] = { t: 'n', v: 0, f: 'IFERROR(SUM(A1,B1,A3),-7)' }; // boundary IFERROR catches -> -7
P['B6'] = { t: 'n', v: 0, f: 'SUM(A1,A4,A3)' };          // TEXT ignored -> 350 (NOT NaN)
P['B7'] = { t: 'n', v: 0, f: 'SUM(1,2,3)' };             // normal sum unchanged -> 6
P['B8'] = { t: 'n', v: 0, f: 'A3/A1' };                  // normal division -> 2.5
P['B9'] = { t: 'n', v: 0, f: 'AVERAGE(A1,B1,A3)' };      // AVERAGE over 0/0 -> NaN (was 116.67)
// SUMIF / SUMPRODUCT over a sum range containing a #DIV/0!
P['C1'] = { t: 'n', v: 1 }; P['C2'] = { t: 'n', v: 1 }; P['C3'] = { t: 'n', v: 1 };
P['D1'] = { t: 'n', v: 10 }; P['D2'] = { t: 'n', v: 0, f: 'A2/A2' }; P['D3'] = { t: 'n', v: 30 };
P['B10'] = { t: 'n', v: 0, f: 'SUMIF(C1:C3,1,D1:D3)' };  // matched range has NaN -> NaN (was 40)
P['B11'] = { t: 'n', v: 0, f: 'SUMPRODUCT(C1:C3,D1:D3)' }; // -> NaN (was 40)

const tmp = mkdtempSync(join(tmpdir(), 'div60-'));
writeFileSync(join(tmp, 'm.xlsx'), XLSX.write({ SheetNames: ['P'], Sheets: { P } }, { type: 'buffer', bookType: 'xlsx' }));
execFileSync(PARSER, [join(tmp, 'm.xlsx'), join(tmp, 'out'), '--chunked'], { encoding: 'utf-8', stdio: 'pipe' });
const eng = await import(pathToFileURL(join(tmp, 'out', 'chunked', 'engine.js')).href);
const v = eng.run().values;
rmSync(tmp, { recursive: true, force: true });

assert(isNaNv(v['P!B1']), `_div(0/0) = NaN (got ${v['P!B1']})`);
assert(isNaNv(v['P!B2']), `_div(100/0) = NaN canonical, not +Infinity (got ${v['P!B2']})`);
assert(isNaNv(v['P!B3']), `SUM over a 0/0 cell = NaN, NOT the silently-dropped 350 (got ${v['P!B3']}) — the headline #60 fix`);
assert(isNaNv(v['P!B4']), `SUM over an x/0 cell = NaN (got ${v['P!B4']})`);
assert(v['P!B5'] === -7, `IFERROR over the #DIV/0! SUM returns the fallback -7 (got ${v['P!B5']})`);
assert(typeof v['P!B6'] === 'number' && Math.abs(v['P!B6'] - 350) < 1e-9, `SUM ignores TEXT (label->0) = 350, NOT NaN (got ${v['P!B6']})`);
assert(v['P!B7'] === 6, `normal SUM(1,2,3) unchanged = 6 (got ${v['P!B7']})`);
assert(typeof v['P!B8'] === 'number' && Math.abs(v['P!B8'] - 2.5) < 1e-9, `normal division 250/100 = 2.5 (got ${v['P!B8']})`);
assert(isNaNv(v['P!B9']), `AVERAGE over a 0/0 cell = NaN, NOT the doubly-wrong 116.67 (got ${v['P!B9']})`);
assert(isNaNv(v['P!B10']), `SUMIF over a sum range with a #DIV/0! = NaN, NOT 40 (got ${v['P!B10']})`);
assert(isNaNv(v['P!B11']), `SUMPRODUCT over a range with a #DIV/0! = NaN, NOT 40 (got ${v['P!B11']})`);

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

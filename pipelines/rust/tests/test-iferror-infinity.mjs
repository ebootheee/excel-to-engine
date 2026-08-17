#!/usr/bin/env node
/**
 * Regression for the IFERROR/ISERROR/ISNUMBER #DIV/0! gap.
 *
 * Excel's #DIV/0! surfaces in JS as ±Infinity (x/0 with x!=0), NOT NaN. The
 * transpiler's error guards used to test only `isNaN`, so:
 *   - IFERROR(x/0, fallback)  returned Infinity instead of the fallback,
 *   - ISERROR(x/0)            returned false instead of true,
 *   - ISNUMBER(x/0)           returned true instead of false.
 * The leaked Infinity then poisoned circular-cluster convergence on the real
 * models (lock-grade T-076: ~194k IFERROR cells on Outpost A-1, one of which —
 * N22 = IFERROR(N23/N21, 0) with N21 a SUMIFS that transiently hits 0 — went
 * non-finite and the cluster never converged).
 *
 * The fix treats any non-finite NUMBER (NaN AND ±Infinity) as an Excel error.
 * This builds tiny models through the REAL rust-parser chunked pipeline and
 * asserts Excel-faithful results. The `0/0`→NaN case (already handled) is kept
 * as a non-regression control.
 *
 * Needs the rust-parser binary. Skips (exit 0) if it isn't built.
 *
 * Usage: node pipelines/rust/tests/test-iferror-infinity.mjs
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

async function buildEngine(sheets) {
  const wb = { SheetNames: Object.keys(sheets), Sheets: sheets };
  const tmp = mkdtempSync(join(tmpdir(), 'iferr-'));
  const xlsx = join(tmp, 'm.xlsx');
  writeFileSync(xlsx, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  execFileSync(PARSER, [xlsx, join(tmp, 'out'), '--chunked'], { encoding: 'utf-8', stdio: 'pipe' });
  const eng = await import(pathToFileURL(join(tmp, 'out', 'chunked', 'engine.js')).href);
  return { eng, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

console.log('Testing: IFERROR/ISERROR/ISNUMBER treat #DIV/0! (±Infinity) as an Excel error');
{
  // A1=10, A2=0 (a denominator that is/iterates to zero).
  const S = { '!ref': 'A1:B9' };
  S['A1'] = { t: 'n', v: 10 };
  S['A2'] = { t: 'n', v: 0 };
  S['A3'] = { t: 'n', v: -7 };
  // IFERROR over #DIV/0! must return the fallback, not Infinity.
  S['B1'] = { t: 'n', v: 0, f: 'IFERROR(A1/A2,0)' };        // 10/0  -> 0
  S['B2'] = { t: 'n', v: 0, f: 'IFERROR(A3/A2,-1)' };       // -7/0  -> -1 (was -Infinity)
  S['B3'] = { t: 'n', v: 0, f: 'IFERROR(A2/A2,0)' };        // 0/0   -> 0 (NaN control, already worked)
  S['B4'] = { t: 'n', v: 0, f: 'IFERROR(A1/A1,99)' };       // 10/10 -> 1 (finite passes through)
  // ISERROR must be TRUE for #DIV/0!, FALSE for a real number.
  S['B5'] = { t: 'b', v: false, f: 'ISERROR(A1/A2)' };      // -> TRUE
  S['B6'] = { t: 'b', v: false, f: 'ISERROR(A1/A1)' };      // -> FALSE
  // ISNUMBER must be FALSE for #DIV/0!, TRUE for a real number.
  S['B7'] = { t: 'b', v: false, f: 'ISNUMBER(A1/A2)' };     // -> FALSE
  S['B8'] = { t: 'b', v: false, f: 'ISNUMBER(A1/A1)' };     // -> TRUE
  // The classic guarded-ratio idiom must land on the fallback, finite.
  S['B9'] = { t: 'n', v: 0, f: 'IF(ISERROR(A1/A2),0,A1/A2)' }; // -> 0

  const { eng, cleanup } = await buildEngine({ S });
  const v = eng.run().values;

  assert(v['S!B1'] === 0, `IFERROR(10/0,0) = 0 (got ${v['S!B1']}) — must NOT leak Infinity`);
  assert(v['S!B2'] === -1, `IFERROR(-7/0,-1) = -1 (got ${v['S!B2']}) — must NOT leak -Infinity`);
  assert(v['S!B3'] === 0, `IFERROR(0/0,0) = 0 NaN control (got ${v['S!B3']})`);
  assert(v['S!B4'] === 1, `IFERROR(10/10,99) = 1 finite pass-through (got ${v['S!B4']})`);
  assert(v['S!B5'] === true, `ISERROR(10/0) = true (got ${v['S!B5']})`);
  assert(v['S!B6'] === false, `ISERROR(10/10) = false (got ${v['S!B6']})`);
  assert(v['S!B7'] === false, `ISNUMBER(10/0) = false (got ${v['S!B7']})`);
  assert(v['S!B8'] === true, `ISNUMBER(10/10) = true (got ${v['S!B8']})`);
  assert(v['S!B9'] === 0, `IF(ISERROR(10/0),0,10/0) = 0 (got ${v['S!B9']}) — pre-IFERROR idiom`);
  // Hard invariant: NOTHING in the computed surface is non-finite.
  const nonFinite = Object.entries(v).filter(([, x]) => typeof x === 'number' && !Number.isFinite(x));
  assert(nonFinite.length === 0, `no non-finite cells leaked (got ${JSON.stringify(nonFinite)})`);

  cleanup();
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

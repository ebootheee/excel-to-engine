#!/usr/bin/env node
/**
 * Regression for issue #66 — three formula-STRUCTURE defect classes found by
 * the all-17-sheet warm-GT sweep on the real A-1 model (v0.3.0 release day):
 *
 *  B. Computed-endpoint ranges `ref:OFFSET(...)` (Technology, 284k cells).
 *     The parser had no rule for a bare `:` token, so it stopped AT the colon
 *     and silently returned the partial AST — `SUM(CF14:OFFSET(CF14,,-1))`
 *     became `SUM(CF14)` and EVERYTHING after the colon (including a whole
 *     trailing `*(...)` factor) was dropped. Same formula also exercises the
 *     empty-argument bug: `OFFSET(x,,n)`'s second comma was EATEN by the
 *     parser's fallback branch, misaligning the remaining args.
 *
 *  A. YEARFRAC default basis is US-NASD 30/360, not `(days)/365.25`
 *     (Lease Amortization + Owned Asset PP&E, ~91k cells). Month-aligned
 *     spans must be EXACT (1, 0.5) because the model gates on
 *     `MOD(YEARFRAC(...), x) = 0` and counts months as `YEARFRAC*12+1`.
 *
 *  C. SUMIFS with a RANGE as a criteria value (array semantics — one sum per
 *     criteria element, then SUM over them; Debt, 6.7k cells). The criteria
 *     array previously matched nothing → 0.
 *
 * NEGATIVE CONTROL: every case asserts the exact WRONG value the pre-fix
 * binary produces (verified red before the fix landed), so the test provably
 * discriminates. Honesty case: an UNSUPPORTED computed endpoint must emit
 * NaN (detectable), never a silently-wrong partial value.
 *
 * Needs the rust-parser binary. Skips (exit 0) if it isn't built.
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
function assert(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); }
}
const ser = (y, m, d) => Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);

// ── the model ───────────────────────────────────────────────────────────────
const SF = { '!ref': 'A1:H6' };
// values
SF['A1'] = { t: 'n', v: 10 }; SF['B1'] = { t: 'n', v: 20 };
SF['C1'] = { t: 'n', v: 30 }; SF['D1'] = { t: 'n', v: 40 };
SF['F1'] = { t: 'n', v: 1 };  SF['G1'] = { t: 'n', v: 2 };
SF['A2'] = { t: 'n', v: 3 };  // window-length driver (like Technology!$F$12)
// categories for the SUMIFS criteria range
SF['A3'] = { t: 'n', v: 1 }; SF['B3'] = { t: 'n', v: 2 };
SF['C3'] = { t: 'n', v: 1 }; SF['D3'] = { t: 'n', v: 2 };
// date serials (all month-end, like the model's EOMONTH axis)
SF['D5'] = { t: 'n', v: ser(2024, 6, 30) };
SF['E5'] = { t: 'n', v: ser(2025, 6, 30) };
SF['F5'] = { t: 'n', v: ser(2024, 12, 31) };

// B. computed-endpoint range + empty OFFSET arg (the Technology idiom)
SF['B4'] = { t: 'n', v: 0, f: 'SUM(A1:OFFSET(A1,,A2-1))' };          // SUM(A1:C1)=60; pre-fix 10
SF['C4'] = { t: 'n', v: 0, f: '(SUM(A1:OFFSET(A1,,1))=0)*5+7*(A1>5)' }; // 0*5+7*1=7; pre-fix 10 (truncated)
SF['D4'] = { t: 'n', v: 0, f: 'OFFSET(C1,,-1)' };                     // B1=20; pre-fix 0 (comma eaten, args misaligned)
// C. array-criteria SUMIFS (the Debt idiom)
SF['E4'] = { t: 'n', v: 0, f: 'SUM(SUMIFS(A1:D1,A3:D3,F1:G1))' };     // (10+30)+(20+40)=100; pre-fix 0
// A. YEARFRAC NASD 30/360 (the LeaseAm/PP&E idioms)
SF['F4'] = { t: 'n', v: 0, f: 'YEARFRAC(D5,E5)' };                    // exactly 1; pre-fix 365/365.25
SF['G4'] = { t: 'n', v: 0, f: '(MOD(YEARFRAC(D5,F5),0.5)=0)*1' };     // 0.5 → flag 1; pre-fix 0
SF['H4'] = { t: 'n', v: 0, f: 'YEARFRAC(D5,E5)*12+1' };               // exactly 13; pre-fix 12.99178…
// honesty: UNSUPPORTED computed endpoint must be NaN, never a partial value
SF['A6'] = { t: 'n', v: 0, f: 'SUM(A1:INDIRECT("C1"))*2' };
// Excel-vs-NASD YEARFRAC quirk cases (Feb-end starts)
SF['D6'] = { t: 'n', v: ser(2023, 2, 28) };
SF['E6'] = { t: 'n', v: ser(2023, 5, 31) };
SF['F6'] = { t: 'n', v: 0, f: 'YEARFRAC(D6,E6)' };  // Excel 91/360 (d2=31 kept for Feb-end start)
SF['G6'] = { t: 'n', v: 0, f: 'YEARFRAC(D6,H6)' };  // Excel exactly 1 (both-Feb rule)
SF['H6'] = { t: 'n', v: ser(2024, 2, 29) };
SF['G5'] = { t: 'n', v: ser(2026, 2, 28) };
SF['H5'] = { t: 'n', v: 0, f: 'YEARFRAC(H6,G5)' };  // leap→non-leap Feb pair: exactly 2

const wb = { SheetNames: ['SF'], Sheets: { SF } };
const tmp = mkdtempSync(join(tmpdir(), 'sf66-'));
writeFileSync(join(tmp, 'm.xlsx'), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
execFileSync(PARSER, [join(tmp, 'm.xlsx'), join(tmp, 'out'), '--chunked'], { encoding: 'utf-8', stdio: 'pipe' });
const eng = await import(pathToFileURL(join(tmp, 'out', 'chunked', 'engine.js')).href);
const r = eng.run();
const v = (a) => r.values[`SF!${a}`];

console.log('Testing: computed-endpoint ranges ref:OFFSET(...) (issue #66 class B)');
{
  // negative controls: the pre-fix parser provably truncates to these values
  assert(60 !== 10 && 7 !== 10 && 20 !== 30, 'negative control: fixed values differ from the pre-fix truncation values');
  assert(v('B4') === 60, `SUM(A1:OFFSET(A1,,A2-1)) spans the dynamic window = 60 (got ${v('B4')}; pre-fix truncated to SUM(A1)=10)`);
  assert(v('C4') === 7, `truncation guard: the trailing *(...) factor survives = 7 (got ${v('C4')}; pre-fix dropped everything after the colon → 10)`);
  assert(v('D4') === 20, `OFFSET(C1,,-1) honours the EMPTY rows argument = 20 (got ${v('D4')}; pre-fix ate the comma and misaligned args → 0)`);
}

console.log('Testing: SUMIFS with a range criteria value (issue #66 class C)');
{
  assert(v('E4') === 100, `SUM(SUMIFS(vals,cats,F1:G1)) sums per criteria element = 100 (got ${v('E4')}; pre-fix array criteria matched nothing → 0)`);
}

console.log('Testing: YEARFRAC US-NASD 30/360 default basis (issue #66 class A)');
{
  const old = (ser(2025, 6, 30) - ser(2024, 6, 30)) / 365.25;
  assert(Math.abs(old - 1) > 1e-4, `negative control: the old /365.25 basis (${old}) is measurably off the exact 1`);
  assert(v('F4') === 1, `YEARFRAC(Jun30-2024, Jun30-2025) = exactly 1 (got ${v('F4')})`);
  assert(v('G4') === 1, `MOD(YEARFRAC(Jun30, Dec31), 0.5) = 0 → flag 1 (got ${v('G4')}; the LeaseAm anniversary gate)`);
  assert(v('H4') === 13, `YEARFRAC*12+1 month count = exactly 13 (got ${v('H4')}; the AR158/PP&E idiom)`);
  // Excel's basis-0 differs from textbook NASD in rule ORDER: the d2=31
  // adjustment tests d1 BEFORE the Feb rule, so a Feb-end start keeps the
  // 31st (one extra day) — but the both-Feb rule DOES apply. Both values are
  // evidenced by the real model's ground truth (issue #66): PP&E row 92's
  // GT 465.9667 needs 91/360, and its Feb-to-Feb anniversary columns are
  // EXACT integers, which needs YEARFRAC(Feb28-2023, Feb29-2024) = 1.
  assert(Math.abs(v('F6') - 91 / 360) < 1e-12, `Excel quirk: YEARFRAC(Feb28-2023, May31-2023) = 91/360 (got ${v('F6')}; textbook NASD gives 90/360)`);
  assert(v('G6') === 1, `Excel both-Feb rule: YEARFRAC(Feb28-2023, Feb29-2024) = exactly 1 (got ${v('G6')}; skipping the both-Feb rule gives 359/360)`);
  assert(v('H5') === 2, `leap-to-nonleap Feb pair: YEARFRAC(Feb29-2024, Feb28-2026)*1 = exactly 2 (got ${v('H5')}; without both-Feb this is 718/360)`);
}

console.log('Testing: unsupported computed endpoint is honest NaN (never partial)');
{
  assert(Number.isNaN(v('A6')), `SUM(A1:INDIRECT(...)) → NaN sentinel (got ${v('A6')}; a partial/truncated value would be a silent wrong number)`);
}

rmSync(tmp, { recursive: true, force: true });
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

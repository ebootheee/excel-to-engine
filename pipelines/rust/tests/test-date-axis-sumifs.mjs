#!/usr/bin/env node
/**
 * Regression for issue #47 — DATE/EDATE/EOMONTH must lower to INTEGER Excel
 * day-serials, not the old float-month `*30.44` / `*365.25` approximation.
 *
 * Why the existing smoke test (78/78) can't catch this: the synthetic smoke
 * workbook HARD-CODES integer serials and never drives a recurrence. The bug
 * only shows up when a date axis is *built* by an EDATE/EOMONTH month-step
 * recurrence and then keyed by EXACT date-equality (SUMIFS/MINIFS), because
 * `_matchesCriteria` matches numbers only within 1e-10. Under `*30.44` the axis
 * drifts ~1.2 days off the true integer serial after ~30 months → the SUMIFS
 * MISSES → 0 → x/0 → Infinity/NaN downstream (the live Outpost A-1 collapse).
 *
 * This test builds such a model through the REAL rust-parser chunked pipeline
 * and asserts:
 *   1. an EDATE-recurrence date axis lands on EXACT integer serials,
 *   2. a SUMIFS keyed on a target serial returns the CORRECT NONZERO value
 *      (it would be 0 under the old float drift),
 *   3. EDATE day-clamping: EDATE(Jan31, 1) = Feb 28 serial,
 *   4. EOMONTH last-day + leap year: EOMONTH(Feb15-2024, 0) = Feb 29 serial,
 *   5. DATE(y,m,d) is an integer serial (no fractional days).
 *
 * NEGATIVE CONTROL / non-circularity (per docs/LITE-TEST-STANDARD.md):
 *   - Ground-truth serials are computed independently of the engine, and the
 *     key dates are pre-asserted against hard-coded integer constants
 *     (DATE_AXIS_EXPECTED) so the truth is not "whatever the engine emits".
 *   - The test ALSO recomputes what the OLD `*30.44` recurrence would have
 *     produced and asserts it is fractionally OFF the true serial (so the axis
 *     equality + SUMIFS assertions provably FAIL under the old code).
 *
 * Needs the rust-parser binary. Skips (exit 0) if it isn't built.
 *
 * Usage: node pipelines/rust/tests/test-date-axis-sumifs.mjs
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

/** Excel day-serial (days since the 1899-12-30 epoch) — independent ground truth. */
const ser = (y, m, d) => Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);

/** Build a workbook from a {sheetName: cells} spec, parse it, import engine.js. */
async function buildEngine(sheets) {
  const wb = { SheetNames: Object.keys(sheets), Sheets: sheets };
  const tmp = mkdtempSync(join(tmpdir(), 'date47-'));
  const xlsx = join(tmp, 'm.xlsx');
  writeFileSync(xlsx, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  execFileSync(PARSER, [xlsx, join(tmp, 'out'), '--chunked'], { encoding: 'utf-8', stdio: 'pipe' });
  const eng = await import(pathToFileURL(join(tmp, 'out', 'chunked', 'engine.js')).href);
  return { eng, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Model: a 36-month date axis built by an EDATE recurrence + a SUMIFS lookup.
//
// Cal!A1   = 43831 (literal seed = 2020-01-01 integer serial)
// Cal!A2.. = EDATE(A1,1), EDATE(A2,1), ...   (monthly recurrence, rows 1..36)
// Cal!B(i) = i  (an amount per month so the matched SUM is nonzero & unique)
// Cal!A38  = target serial 2022-07-01 (month index 30, value should be 31)
// Cal!A39  = SUMIFS(B:B keyed by A:A == A38)  → must equal 31, NOT 0
//
// NOTE: the lookup cells live BELOW the axis (rows 38+). The chunked emitter
// orders intra-sheet formula cells by (row, col), so a reducer over the whole
// A1:A36 axis must sit at a higher row than every axis cell to read a fully
// computed axis. (This positional ordering is a separate, pre-existing engine
// limitation; placing the SUMIFS below the axis isolates the issue-#47 date
// arithmetic, which is what this regression targets.)
// ---------------------------------------------------------------------------
const SEED = ser(2020, 1, 1);          // 43831
const N = 36;                          // 3-year monthly axis
const TARGET_MONTH_INDEX = 30;         // row 31 → 2022-07-01
const TARGET_SERIAL = ser(2022, 7, 1); // 44743
const TARGET_AMOUNT = TARGET_MONTH_INDEX + 1; // amount stored at that row = 31

// Independent ground truth for the axis: same-day-of-month, month-stepped.
const DATE_AXIS_EXPECTED = [];
for (let i = 0; i < N; i++) {
  const total = (2020 * 12 + 0) + i; // start Jan 2020
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  DATE_AXIS_EXPECTED.push(ser(y, m, 1));
}
// Pin a few axis cells to hard constants so the truth is not engine-derived.
assert(DATE_AXIS_EXPECTED[0] === 43831, `axis[0] truth pin = 43831 (got ${DATE_AXIS_EXPECTED[0]})`);
assert(DATE_AXIS_EXPECTED[12] === ser(2021, 1, 1), `axis[12] truth pin = 2021-01-01`);
assert(DATE_AXIS_EXPECTED[TARGET_MONTH_INDEX] === 44743, `axis[30] truth pin = 44743 (2022-07-01)`);

// NEGATIVE CONTROL: what the OLD `*30.44` recurrence would have produced.
let oldFloat = SEED;
for (let i = 0; i < TARGET_MONTH_INDEX; i++) oldFloat = oldFloat + 1 * 30.44;
assert(
  Math.abs(oldFloat - TARGET_SERIAL) > 1e-6,
  `negative control: old *30.44 axis (${oldFloat}) drifts off integer serial ${TARGET_SERIAL} ` +
  `→ exact-equality SUMIFS would MISS (return 0). This is what the fix prevents.`
);

console.log('Testing: EDATE-recurrence date axis + exact-equality SUMIFS (issue #47)');
{
  const LOOKUP_ROW = N + 2;        // target serial row (below the axis)
  const SUMIFS_ROW = N + 3;        // SUMIFS row
  const COUNT_ROW = N + 4;         // COUNTIFS row
  const Cal = { '!ref': `A1:D${COUNT_ROW}` };
  Cal['A1'] = { t: 'n', v: SEED };                 // literal integer seed
  Cal['B1'] = { t: 'n', v: 1 };
  for (let i = 1; i < N; i++) {
    const r = i + 1;
    // Date axis: each month = EDATE of the previous month's serial.
    Cal[`A${r}`] = { t: 'n', v: 0, f: `EDATE(A${i},1)` };
    Cal[`B${r}`] = { t: 'n', v: r };               // amount = row number
  }
  // Lookup cells BELOW the axis so they compute after the full axis is set.
  Cal[`A${LOOKUP_ROW}`] = { t: 'n', v: TARGET_SERIAL };
  Cal[`A${SUMIFS_ROW}`] = { t: 'n', v: 0, f: `SUMIFS(B1:B${N},A1:A${N},A${LOOKUP_ROW})` };
  // Also a COUNTIFS to prove exactly one row matched (not e.g. fuzzy multi-match).
  Cal[`A${COUNT_ROW}`] = { t: 'n', v: 0, f: `COUNTIFS(A1:A${N},A${LOOKUP_ROW})` };

  const { eng, cleanup } = await buildEngine({ Cal });
  const r = eng.run();

  // 1. Axis lands on exact integer serials.
  let axisOk = true;
  for (let i = 0; i < N; i++) {
    const got = r.values[`Cal!A${i + 1}`];
    if (!(Number.isInteger(got) && got === DATE_AXIS_EXPECTED[i])) {
      axisOk = false;
      console.error(`    axis[${i}] expected ${DATE_AXIS_EXPECTED[i]}, got ${got}`);
    }
  }
  assert(axisOk, 'EDATE recurrence produces EXACT integer serials at every month');

  // 2. The crux: SUMIFS keyed on the exact serial returns the correct NONZERO
  //    amount. Under the old `*30.44` drift the axis never equals the target → 0.
  assert(
    r.values[`Cal!A${SUMIFS_ROW}`] === TARGET_AMOUNT,
    `SUMIFS on exact date serial = ${TARGET_AMOUNT} (NONZERO); got ${r.values[`Cal!A${SUMIFS_ROW}`]} ` +
    `(would be 0 under the old float-drift axis)`
  );
  assert(r.values[`Cal!A${COUNT_ROW}`] === 1, `exactly one axis row matched the target serial (got ${r.values[`Cal!A${COUNT_ROW}`]})`);

  cleanup();
}

// ---------------------------------------------------------------------------
// EDATE day-clamping, EOMONTH last-day + leap year, DATE integer-serial.
// ---------------------------------------------------------------------------
console.log('Testing: EDATE clamp, EOMONTH last-day/leap-year, DATE integer serial');
{
  const Edge = { '!ref': 'A1:E11' };
  // EDATE(Jan31-2021, 1) must clamp to Feb 28 2021 (Feb has no 31st).
  Edge['A1'] = { t: 'n', v: ser(2021, 1, 31) };
  Edge['B1'] = { t: 'n', v: 0, f: 'EDATE(A1,1)' };
  // EDATE(Jan31-2020, 1) → Feb 29 2020 (leap year).
  Edge['A2'] = { t: 'n', v: ser(2020, 1, 31) };
  Edge['B2'] = { t: 'n', v: 0, f: 'EDATE(A2,1)' };
  // EOMONTH(Feb15-2024, 0) → Feb 29 2024 (leap-year last day).
  Edge['A3'] = { t: 'n', v: ser(2024, 2, 15) };
  Edge['B3'] = { t: 'n', v: 0, f: 'EOMONTH(A3,0)' };
  // EOMONTH(Jan15-2023, 1) → Feb 28 2023 (non-leap last day, +1 month).
  Edge['A4'] = { t: 'n', v: ser(2023, 1, 15) };
  Edge['B4'] = { t: 'n', v: 0, f: 'EOMONTH(A4,1)' };
  // DATE(2024,1,1) must be an integer serial (no fractional days).
  Edge['B5'] = { t: 'n', v: 0, f: 'DATE(2024,1,1)' };
  // DATE month/day roll-over: DATE(2024,13,1) → 2025-01-01 (Excel normalises).
  Edge['B6'] = { t: 'n', v: 0, f: 'DATE(2024,13,1)' };
  // EDATE with a negative month step → goes backward.
  Edge['A7'] = { t: 'n', v: ser(2022, 3, 31) };
  Edge['B7'] = { t: 'n', v: 0, f: 'EDATE(A7,-1)' }; // → Feb 28 2022 (clamp)
  // Excel 1900-epoch quirk zone (serial <= 60, before the phantom Feb 29 1900).
  // A degenerate 0 (e.g. a no-match MINIFS feeding an EOMONTH chain — live on
  // the real A-1 GPP Promote row 116) must follow Excel's serials exactly:
  // serial 0 = "Jan 0 1900" → EOMONTH(0,1) = end of Feb 1900 = 59 (NOT 60).
  Edge['A8'] = { t: 'n', v: 0 };
  Edge['B8'] = { t: 'n', v: 0, f: 'EOMONTH(A8,1)' };  // → 59
  Edge['A9'] = { t: 'n', v: 59 };
  Edge['B9'] = { t: 'n', v: 0, f: 'EOMONTH(A9,1)' };  // → Mar 31 1900 = 91
  Edge['A10'] = { t: 'n', v: 1 };
  Edge['B10'] = { t: 'n', v: 0, f: 'EOMONTH(A10,0)' }; // Jan 1 1900 → Jan 31 = 31
  // XIRR uses Excel's 365-day basis (not 365.25): -100 → +110 across the 366
  // days of leap-2020 solves to 1.1^(365/366)-1, distinguishable from the old
  // 365.25 basis by ~3.6e-5.
  Edge['D1'] = { t: 'n', v: -100 };
  Edge['D2'] = { t: 'n', v: 110 };
  Edge['E1'] = { t: 'n', v: ser(2020, 1, 1) };
  Edge['E2'] = { t: 'n', v: ser(2021, 1, 1) };
  Edge['D3'] = { t: 'n', v: 0, f: 'XIRR(D1:D2,E1:E2)' };

  const { eng, cleanup } = await buildEngine({ Edge });
  const r = eng.run();

  assert(r.values['Edge!B1'] === ser(2021, 2, 28), `EDATE(Jan31-2021,1) = Feb28-2021 serial (got ${r.values['Edge!B1']})`);
  assert(r.values['Edge!B2'] === ser(2020, 2, 29), `EDATE(Jan31-2020,1) = Feb29-2020 serial / leap (got ${r.values['Edge!B2']})`);
  assert(r.values['Edge!B3'] === ser(2024, 2, 29), `EOMONTH(Feb15-2024,0) = Feb29-2024 serial / leap (got ${r.values['Edge!B3']})`);
  assert(r.values['Edge!B4'] === ser(2023, 2, 28), `EOMONTH(Jan15-2023,1) = Feb28-2023 serial (got ${r.values['Edge!B4']})`);
  assert(r.values['Edge!B5'] === ser(2024, 1, 1) && Number.isInteger(r.values['Edge!B5']), `DATE(2024,1,1) = integer serial 45292 (got ${r.values['Edge!B5']})`);
  assert(r.values['Edge!B6'] === ser(2025, 1, 1), `DATE(2024,13,1) rolls to 2025-01-01 (got ${r.values['Edge!B6']})`);
  assert(r.values['Edge!B7'] === ser(2022, 2, 28), `EDATE(Mar31-2022,-1) = Feb28-2022 serial / backward+clamp (got ${r.values['Edge!B7']})`);
  assert(r.values['Edge!B8'] === 59, `EOMONTH(0,1) = 59, Excel's end-of-Feb-1900 with the phantom Feb 29 (got ${r.values['Edge!B8']})`);
  assert(r.values['Edge!B9'] === 91, `EOMONTH(59,1) = 91, Mar 31 1900 (got ${r.values['Edge!B9']})`);
  assert(r.values['Edge!B10'] === 31, `EOMONTH(1,0) = 31, Jan 31 1900 in the quirk zone (got ${r.values['Edge!B10']})`);
  const xirrExpected = Math.exp(Math.log(1.1) * 365 / 366) - 1; // Excel 365-day basis
  const xirrOld = Math.exp(Math.log(1.1) * 365.25 / 366) - 1;   // the old 365.25 basis
  assert(Math.abs(xirrExpected - xirrOld) > 1e-5, `negative control: 365 vs 365.25 basis differ measurably (${xirrExpected} vs ${xirrOld})`);
  assert(Math.abs(r.values['Edge!D3'] - xirrExpected) < 1e-6, `XIRR on a 366-day leap span uses the 365-day basis: ${xirrExpected.toFixed(7)} (got ${r.values['Edge!D3']})`);

  cleanup();
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

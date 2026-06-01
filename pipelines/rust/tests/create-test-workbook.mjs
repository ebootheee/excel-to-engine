/**
 * Synthetic PE financial model workbook for rust-parser end-to-end testing.
 *
 * Three sheets:
 *   Assumptions  — Col A: label, Col B: value (raw inputs)
 *   Cashflows    — Col A: label, Col B: formula value
 *   Summary      — Col A: label, Col B: formula value
 *
 * Circular reference in Cashflows:
 *   B6 = B9 * Assumptions!B5          (Interest = DebtBalance * Rate)
 *   B7 = B5 - B6                      (CashFlow = EBITDA - Interest)
 *   B9 = B8 - B7 * Assumptions!B9    (DebtBalance = InitialDebt - CashFlow * RepayRate)
 *
 * All formula cells include pre-computed values (v:) so calamine
 * has ground truth for eval accuracy testing.
 */

import XLSX from 'xlsx';
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Solve circular analytically ───────────────────────────────────────────────
// B6 = B9 * r,  B7 = EBITDA - B6,  B9 = D0 - B7 * rp
// B9 = D0 - (EBITDA - B9*r) * rp = D0 - EBITDA*rp + B9*r*rp
// B9*(1 - r*rp) = D0 - EBITDA*rp
const R = 0.06;          // InterestRate
const D0 = 500000;       // InitialDebt
const RP = 0.2;          // RepayRate
const REV = 1000000;     // Revenue
const COGS = 400000;
const OPEX = 150000;
const TAX_RATE = 0.25;
const EXIT_MULT = 12;

const EBITDA = REV - COGS - OPEX;                    // 450000
const B9 = (D0 - EBITDA * RP) / (1 - R * RP);       // DebtBalance
const B6 = B9 * R;                                    // Interest
const B7 = EBITDA - B6;                               // CashFlow
const B11 = EBITDA - B6;                              // EBT
const B12 = Math.max(0, B11 * TAX_RATE);             // Tax
const B13 = B11 - B12;                               // NetIncome
const B15 = EBITDA * EXIT_MULT;                       // ExitValue
const B16 = D0 > 0 ? (B15 - D0) / D0 : 0;           // ROE

// ── fv helper ─────────────────────────────────────────────────────────────────
const fv = (formula, value) => ({ f: formula, v: value });

// ── Assumptions sheet ─────────────────────────────────────────────────────────
function buildAssumptionsSheet() {
  const ws = {};
  const data = [
    ['Parameter',    'Value'],
    ['Revenue',      REV],
    ['COGS',         COGS],
    ['OpEx',         OPEX],
    ['InterestRate', R],
    ['InitialDebt',  D0],
    ['TaxRate',      TAX_RATE],
    ['ExitMultiple', EXIT_MULT],
    ['RepayRate',    RP],
    ['YearsToExit',  5],
  ];
  data.forEach((row, ri) => {
    row.forEach((val, ci) => {
      ws[`${String.fromCharCode(65 + ci)}${ri + 1}`] = { v: val };
    });
  });
  ws['!ref'] = `A1:B${data.length}`;
  return ws;
}

// ── Cashflows sheet ───────────────────────────────────────────────────────────
// All formula cells are in column B (rows 2-17).
// Formulas reference other B cells or Assumptions!B cells.
function buildCashflowsSheet() {
  const rows = [
    // [label,  { f: formula, v: computedValue }]
    ['Metric',       'Value'],
    ['Revenue',      fv('Assumptions!B2',          REV)],
    ['COGS',         fv('Assumptions!B3',          COGS)],
    ['OpEx',         fv('Assumptions!B4',          OPEX)],
    ['EBITDA',       fv('B2-B3-B4',               EBITDA)],
    ['Interest',     fv('B9*Assumptions!B5',       B6)],   // ← depends on B9 (circular)
    ['CashFlow',     fv('B5-B6',                  B7)],    // ← depends on B6 (circular)
    ['InitialDebt',  fv('Assumptions!B6',          D0)],
    ['DebtBalance',  fv('B8-B7*Assumptions!B9',    B9)],   // ← depends on B7 (circular)
    ['TaxRate',      fv('Assumptions!B7',          TAX_RATE)],
    ['EBT',          fv('B5-B6',                  B11)],
    ['Tax',          fv('MAX(0,B11*B10)',          B12)],
    ['NetIncome',    fv('B11-B12',                B13)],
    ['ExitMultiple', fv('Assumptions!B8',          EXIT_MULT)],
    ['ExitValue',    fv('B5*B14',                 B15)],
    ['ROE',          fv('IF(B8>0,(B15-B8)/B8,0)', B16)],
    ['SqrtROE',      fv('SQRT(MAX(0,B16))',        Math.sqrt(Math.max(0, B16)))],
  ];

  const ws = {};
  rows.forEach((row, ri) => {
    row.forEach((cell, ci) => {
      const addr = `${String.fromCharCode(65 + ci)}${ri + 1}`;
      if (typeof cell === 'object' && cell !== null && 'f' in cell) {
        ws[addr] = cell;
      } else {
        ws[addr] = { v: cell };
      }
    });
  });
  ws['!ref'] = `A1:B${rows.length}`;
  return ws;
}

// ── Summary sheet ─────────────────────────────────────────────────────────────
function buildSummarySheet() {
  const rows = [
    ['KPI',               'Value'],
    ['Revenue',           fv('Cashflows!B2',          REV)],
    ['EBITDA',            fv('Cashflows!B5',          EBITDA)],
    ['CashFlowPostDebt',  fv('Cashflows!B7',          B7)],
    ['ExitValue',         fv('Cashflows!B15',         B15)],
    ['ROE',               fv('Cashflows!B16',         B16)],
    ['MinKPI',            fv('MIN(Cashflows!B2,Cashflows!B5,Cashflows!B13)', Math.min(REV, EBITDA, B13))],
    ['MaxKPI',            fv('MAX(Cashflows!B2,Cashflows!B5,Cashflows!B13)', Math.max(REV, EBITDA, B13))],
    ['SumKey',            fv('SUM(Cashflows!B2,Cashflows!B5,Cashflows!B7)', REV + EBITDA + B7)],
    ['RatingText',        fv('IF(Cashflows!B16>1,"Strong",IF(Cashflows!B16>0,"Moderate","Weak"))', B16 > 1 ? 'Strong' : B16 > 0 ? 'Moderate' : 'Weak')],
    ['NetMargin',         fv('IF(Cashflows!B5>0,Cashflows!B13/Cashflows!B5,0)', EBITDA > 0 ? B13 / EBITDA : 0)],
    ['LeverageRatio',     fv('IF(Cashflows!B8>0,Cashflows!B9/Cashflows!B8,0)', D0 > 0 ? B9 / D0 : 0)],
  ];

  const ws = {};
  rows.forEach((row, ri) => {
    row.forEach((cell, ci) => {
      const addr = `${String.fromCharCode(65 + ci)}${ri + 1}`;
      if (typeof cell === 'object' && cell !== null && 'f' in cell) {
        ws[addr] = cell;
      } else {
        ws[addr] = { v: cell };
      }
    });
  });
  ws['!ref'] = `A1:B${rows.length}`;
  return ws;
}

// ── FnTest sheet ──────────────────────────────────────────────────────────────
// Acyclic sheet exercising the transpiler's date / criteria / array functions
// (XNPV, MINIFS, MAXIFS, FILTER) end-to-end so they resolve through real helpers
// instead of the _fn() stub. FILTER's `include` is a numeric FLAG column (an
// array), not an inline range-comparison — this engine evaluates a bare
// `range = "x"` as a scalar, so spill masks must come from a precomputed column.
const XNPV_RATE = 0.1;
const fnDates = [43831, 44197, 44562, 44927, 45292]; // 2020..2024 Jan-1 Excel serials
const fnCF    = [-1000, 300, 400, 500, 700];
const fnCat   = ['A', 'B', 'A', 'B', 'A'];
const fnVal   = [10, 50, 20, 80, 40];
const fnFlag  = [1, 0, 1, 0, 1];
// Expected ground truth, computed with the SAME math the runtime helpers use.
const XNPV_EXPECTED = fnCF.reduce((acc, cf, i) => acc + cf / Math.pow(1 + XNPV_RATE, (fnDates[i] - fnDates[0]) / 365), 0);
const MINIFS_A   = Math.min(...fnVal.filter((_, i) => fnCat[i] === 'A')); // 10
const MAXIFS_A   = Math.max(...fnVal.filter((_, i) => fnCat[i] === 'A')); // 40
const FILTER_SUM = fnVal.filter((_, i) => fnFlag[i]).reduce((a, b) => a + b, 0); // 70

function buildFnTestSheet() {
  const ws = {};
  ws['A1'] = { v: 'Date' }; ws['B1'] = { v: 'CF' }; ws['C1'] = { v: 'Cat' };
  ws['D1'] = { v: 'Val' };  ws['E1'] = { v: 'Flag' };
  for (let i = 0; i < 5; i++) {
    const r = i + 2;
    ws[`A${r}`] = { v: fnDates[i] };
    ws[`B${r}`] = { v: fnCF[i] };
    ws[`C${r}`] = { v: fnCat[i] };
    ws[`D${r}`] = { v: fnVal[i] };
    ws[`E${r}`] = { v: fnFlag[i] };
  }
  // Formula cells: label in F, formula in G — one per new function.
  // Rows 2-5 use bare Excel names; rows 6-8 use the `_xlfn.`/`_xlfn._xlws.`
  // future-function prefixes EXACTLY as Excel stores MINIFS/MAXIFS/FILTER in the
  // real models (the transpiler must strip the prefix before dispatch).
  ws['F2'] = { v: 'XNPV' };          ws['G2'] = fv('XNPV(0.1,B2:B6,A2:A6)', XNPV_EXPECTED);
  ws['F3'] = { v: 'MinValA' };       ws['G3'] = fv('MINIFS(D2:D6,C2:C6,"A")', MINIFS_A);
  ws['F4'] = { v: 'MaxValA' };       ws['G4'] = fv('MAXIFS(D2:D6,C2:C6,"A")', MAXIFS_A);
  ws['F5'] = { v: 'FlaggedSum' };    ws['G5'] = fv('SUM(FILTER(D2:D6,E2:E6))', FILTER_SUM);
  ws['F6'] = { v: 'MinValA_xlfn' };  ws['G6'] = fv('_xlfn.MINIFS(D2:D6,C2:C6,"A")', MINIFS_A);
  ws['F7'] = { v: 'MaxValA_xlfn' };  ws['G7'] = fv('_xlfn.MAXIFS(D2:D6,C2:C6,"A")', MAXIFS_A);
  ws['F8'] = { v: 'FlaggedSum_xlfn' }; ws['G8'] = fv('SUM(_xlfn._xlws.FILTER(D2:D6,E2:E6))', FILTER_SUM);
  ws['!ref'] = 'A1:G8';
  return ws;
}

// ── Write workbook ─────────────────────────────────────────────────────────────
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, buildAssumptionsSheet(), 'Assumptions');
XLSX.utils.book_append_sheet(wb, buildCashflowsSheet(), 'Cashflows');
XLSX.utils.book_append_sheet(wb, buildSummarySheet(), 'Summary');
XLSX.utils.book_append_sheet(wb, buildFnTestSheet(), 'FnTest');

const outPath = join(__dir, 'test-model.xlsx');
// Write via buffer (the SheetJS ESM build has no fs binding, so writeFile throws).
writeFileSync(outPath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

console.log(`Written: ${outPath}`);
console.log(`\nExpected ground truth:`);
console.log(`  Cashflows!B5  EBITDA        = ${EBITDA.toLocaleString()}`);
console.log(`  Cashflows!B6  Interest      = ${B6.toFixed(2)}`);
console.log(`  Cashflows!B7  CashFlow      = ${B7.toFixed(2)}`);
console.log(`  Cashflows!B9  DebtBalance   = ${B9.toFixed(2)}`);
console.log(`  Cashflows!B13 NetIncome     = ${B13.toFixed(2)}`);
console.log(`  Cashflows!B15 ExitValue     = ${B15.toLocaleString()}`);
console.log(`  Cashflows!B16 ROE           = ${B16.toFixed(4)}`);
console.log(`  Summary!B10   RatingText    = ${B16 > 1 ? 'Strong' : 'Moderate'}`);

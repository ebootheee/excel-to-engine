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

// ── Write workbook ─────────────────────────────────────────────────────────────
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, buildAssumptionsSheet(), 'Assumptions');
XLSX.utils.book_append_sheet(wb, buildCashflowsSheet(), 'Cashflows');
XLSX.utils.book_append_sheet(wb, buildSummarySheet(), 'Summary');

const outPath = join(__dir, 'test-model.xlsx');
XLSX.writeFile(wb, outPath);

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

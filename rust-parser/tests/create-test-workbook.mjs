/**
 * Create a synthetic test workbook for rust-parser end-to-end testing.
 *
 * The workbook has two sheets:
 *   - Inputs: raw numeric inputs (revenue, costs, rate, etc.)
 *   - Model:  formulas referencing Inputs and each other, including:
 *             - Simple arithmetic
 *             - SUM, IF, MIN, MAX
 *             - Cross-sheet references
 *             - A circular reference pair (interest ↔ debtBalance)
 *
 * Run: node create-test-workbook.mjs
 * Output: test-model.xlsx
 */

import XLSX from 'xlsx';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync } from 'fs';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Inputs sheet ──────────────────────────────────────────────────────────────
const inputsData = [
  ['Key',           'Value'],
  ['Revenue',       1000000],
  ['COGS',          400000],
  ['OpEx',          150000],
  ['InterestRate',  0.06],
  ['InitialDebt',   500000],
  ['TaxRate',       0.25],
  ['ExitMultiple',  12],
  ['EBITDA',        '',     '=B3-B4-B5'],   // formula: Revenue - COGS - OpEx
];

// ── Model sheet ───────────────────────────────────────────────────────────────
// Uses cross-sheet refs to Inputs!Bx
// Also has a circular: interest = debtBalance * rate;  debtBalance = InitialDebt - cashFlow * 0.2
const modelData = [
  ['Metric',              'Value',         'Notes'],
  ['Revenue',             '',              '=Inputs!B2'],
  ['COGS',                '',              '=Inputs!B3'],
  ['OpEx',                '',              '=Inputs!B4'],
  ['GrossProfit',         '',              '=B2-B3'],       // Revenue - COGS
  ['EBITDA',              '',              '=B5-B4'],       // GrossProfit - OpEx  (simplified)
  ['InterestRate',        '',              '=Inputs!B5'],
  ['InitialDebt',         '',              '=Inputs!B6'],
  // Circular: Interest (B9) <-> DebtBalance (B11)
  // B9  = B11 * B7   (Interest = DebtBalance * Rate)
  // B11 = B8 - B10*0.2  (DebtBalance = InitialDebt - CashFlow * repayRate)
  // B10 = B6 - B9    (CashFlow = EBITDA - Interest)
  // This creates the cycle: B9 -> B11 -> B10 -> B9
  ['Interest',            '',              '=B11*B7'],      // Interest = DebtBalance * Rate
  ['CashFlow',            '',              '=B6-B9'],       // CashFlow = EBITDA - Interest
  ['DebtBalance',         '',              '=B8-B10*0.2'],  // DebtBalance = InitialDebt - CashFlow * repayRate
  // More formulas
  ['TaxRate',             '',              '=Inputs!B7'],
  ['EBT',                 '',              '=B6-B9'],       // EBITDA - Interest
  ['Tax',                 '',              '=MAX(0,B13*B12)'],
  ['NetIncome',           '',              '=B13-B14'],
  ['ExitMultiple',        '',              '=Inputs!B8'],
  ['ExitValue',           '',              '=B6*B16'],      // EBITDA * ExitMultiple
  ['ReturnOnEquity',      '',              '=IF(B8>0,(B17-B8)/B8,0)'],  // (ExitValue - InitialDebt) / InitialDebt
  ['IRRProxy',            '',              '=SQRT(MAX(0,B18))'],         // Synthetic — not real IRR
  ['SumCheck',            '',              '=SUM(B2:B6)'],
  ['MinValue',            '',              '=MIN(B2,B3,B4)'],
  ['MaxValue',            '',              '=MAX(B2,B3,B4)'],
];

function createWorkbook() {
  const wb = XLSX.utils.book_new();

  // Inputs sheet: plain values in column A (key) and B (value),
  // but for EBITDA row we want a formula in C
  // XLSX.utils.aoa_to_sheet handles formulas via {f: ...} cells
  const inputsAoa = inputsData.map(row => row.map((cell, ci) => {
    if (ci === 2 && typeof cell === 'string' && cell.startsWith('=')) {
      return { f: cell.slice(1) };
    }
    return cell;
  }));
  const wsInputs = XLSX.utils.aoa_to_sheet(inputsAoa);
  XLSX.utils.book_append_sheet(wb, wsInputs, 'Inputs');

  // Model sheet: column C holds formulas, column B is the computed value slot
  // We'll put formulas in column B directly
  const modelAoa = modelData.map(row => row.map((cell, ci) => {
    if (ci === 2 && typeof cell === 'string' && cell.startsWith('=')) {
      // This is the formula — put it in col B
      return { f: cell.slice(1) };
    }
    return cell;
  }));

  // Remap: col C formula → col B formula (since col B is where calamine reads the result)
  // Actually let's just build a clean sheet with formula in col B
  const cleanModel = modelData.map(([label, _placeholder, formula]) => {
    if (formula && formula.startsWith('=')) {
      return [label, { f: formula.slice(1) }];
    }
    return [label, _placeholder ?? ''];
  });

  const wsModel = XLSX.utils.aoa_to_sheet(cleanModel);
  XLSX.utils.book_append_sheet(wb, wsModel, 'Model');

  const outPath = join(__dir, 'test-model.xlsx');
  XLSX.writeFile(wb, outPath);
  console.log(`Written: ${outPath}`);
  return outPath;
}

createWorkbook();

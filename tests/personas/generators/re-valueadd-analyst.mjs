/**
 * Persona generator: Value-add multifamily real-estate model (7-year hold).
 *
 * Synthetic data only. Built for usability testing of the excel-to-engine
 * toolkit — exercises the RE asset class:
 *   - NOI build: potential gross rent (with rent growth) → vacancy → EGI →
 *     opex → NOI, year over year, each column off the PRIOR column.
 *   - Acquisition price + renovation capex → total basis.
 *   - Agency loan sized off LTV, single balance row rolling forward by a
 *     level annual principal paydown (prior-column roll-forward).
 *   - Exit on an "Exit Cap Rate": exit value = stabilized (exit-year) NOI / cap.
 *   - Returns: exit value, equity invested, equity multiple (MOIC), and a
 *     leveraged IRR over the actual equity cash-flow stream.
 *
 * Layout rule honored throughout: time across COLUMNS, each metric is its own
 * ROW, and every roll-forward references the PRIOR COLUMN / SAME ROW. No
 * cross-row staircase (which the row-major engine would read as 0).
 *
 * Headline metrics this surfaces: grossMOIC, grossIRR, terminalValue.
 *
 * Run: node re-valueadd-analyst.mjs <out.xlsx>
 *
 * @license MIT
 */
import { ModelBuilder, colLetter, growth, r2 } from '../lib/model-builder.mjs';

/**
 * Newton-Raphson IRR — replicated EXACTLY from the engine runtime
 * (pipelines/rust/src/chunked_emitter.rs :: computeIRR). Using the identical
 * solver here guarantees the cached IRR value matches engine.run() to full
 * precision, so verifyEngine reports zero drift.
 */
function computeIRR(cashflows, guess) {
  const cfs = cashflows.map(v => +v || 0);
  let r = guess !== undefined ? +guess : 0.1;
  for (let i = 0; i < 200; i++) {
    let npv = 0, dnpv = 0;
    for (let t = 0; t < cfs.length; t++) {
      const d = Math.pow(1 + r, t);
      npv += cfs[t] / d;
      dnpv -= t * cfs[t] / (d * (1 + r));
    }
    if (Math.abs(dnpv) < 1e-15) break;
    const dr = npv / dnpv;
    r -= dr;
    if (Math.abs(dr) < 1e-10 && Math.abs(npv) < 1e-8) break;
  }
  return isFinite(r) ? r : 0;
}

export function build(outPath) {
  const m = new ModelBuilder('Maple Court — Value-Add Multifamily Acquisition', 'real_estate');

  // --- timeline (entry year .. exit year; 7-year hold) ---
  const years = [2025, 2026, 2027, 2028, 2029, 2030, 2031];
  const nY = years.length;          // 7 operating years
  const exitIdx = nY - 1;           // last operating year = stabilized / exit
  const holdYears = years[exitIdx] - years[0]; // 6

  // --- drivers (the app levers) ---
  const rentGrowth   = 0.04;   // annual rent growth
  const vacancyRate  = 0.07;   // vacancy + credit loss (% of potential rent)
  const opexRatio    = 0.42;   // operating expenses as % of effective gross income
  const exitCapRate  = 0.0525; // exit cap rate
  const ltv          = 0.65;   // agency loan loan-to-cost
  const interestRate = 0.0575; // agency loan interest rate
  const annualAmort  = 350_000; // level annual principal amortization

  // --- acquisition ---
  const acqPrice = 42_000_000;
  const renoCapex = 6_500_000;
  const totalBasis = acqPrice + renoCapex; // 48,500,000

  // ==========================================================================
  // NOI build (computed in JS first, formulas placed with cached values)
  // ==========================================================================
  const gpr0 = 4_800_000; // year-1 potential gross rent
  const gpr     = growth(gpr0, rentGrowth, nY).map(r2);     // potential gross rent
  const vacancy = gpr.map(v => r2(v * vacancyRate));         // vacancy & credit loss
  const egi     = gpr.map((v, i) => r2(v - vacancy[i]));     // effective gross income
  const opex    = egi.map(v => r2(v * opexRatio));           // operating expenses
  const noi     = egi.map((v, i) => r2(v - opex[i]));        // net operating income

  // ==========================================================================
  // Debt schedule (single balance row roll-forward) + cash flow
  // ==========================================================================
  const loanAmount = r2(totalBasis * ltv);     // initial agency loan
  const equity = r2(totalBasis - loanAmount);  // equity invested

  // Scheduled amortization per year: NONE drawn down in year 1 (the model's
  // row-4 has 0 in the entry column), level annualAmort thereafter. The JS
  // schedule MUST mirror the model exactly or debt service / cash flow drift.
  const amortSchedule = years.map((_, i) => (i === 0 ? 0 : annualAmort));
  // Debt balance (closing) per year: prior-column balance minus this year's amort.
  const debtClose = years.map((_, i) => r2(Math.max(0, loanAmount - annualAmort * i)));
  // Interest each year on the OPENING balance (= prior year's closing; year 1 opens at loanAmount).
  const interest = years.map((_, i) => r2((i === 0 ? loanAmount : debtClose[i - 1]) * interestRate));
  // Debt service = interest + scheduled amortization (matches model row 7 = row 6 + row 4).
  const debtService = interest.map((int, i) => r2(int + amortSchedule[i]));
  const leveredCF = noi.map((n, i) => r2(n - debtService[i]));

  // ==========================================================================
  // Exit
  // ==========================================================================
  const stabilizedNOI = noi[exitIdx];
  const exitValue = r2(stabilizedNOI / exitCapRate);   // terminal value
  const exitDebt = debtClose[exitIdx];
  const netSaleProceeds = r2(exitValue - exitDebt);

  // Equity cash-flow stream: Year 0 = -equity, Years 1..7 = levered CF,
  // and the final year additionally receives net sale proceeds.
  const cfStream = [-equity, ...leveredCF];
  cfStream[cfStream.length - 1] = r2(cfStream[cfStream.length - 1] + netSaleProceeds);

  const totalDistributions = r2(leveredCF.reduce((a, b) => a + b, 0) + netSaleProceeds);
  const moic = totalDistributions / equity;       // equity multiple (gross MOIC)
  const irr = computeIRR(cfStream);                // leveraged IRR

  // ==========================================================================
  // Sheet 1 — Deal Inputs (drivers + defined names)
  // ==========================================================================
  const inp = m.sheet('Deal Inputs');
  inp.label('A1', 'Maple Court — Deal Inputs (all figures synthetic)');
  inp.label('A3', 'Acquisition Price');          inp.value('B3', acqPrice);
  inp.label('A4', 'Renovation Capex');           inp.value('B4', renoCapex);
  inp.label('A5', 'Total Project Cost');
  inp.formula('B5', `B3+B4`, totalBasis);
  inp.label('A7', 'Rent Growth (annual)');       inp.value('B7', rentGrowth);
  inp.label('A8', 'Vacancy & Credit Loss');      inp.value('B8', vacancyRate);
  inp.label('A9', 'Operating Expense Ratio');    inp.value('B9', opexRatio);
  inp.label('A11', 'Exit Cap Rate');             inp.value('B11', exitCapRate);
  inp.label('A12', 'Loan-to-Cost (LTV)');        inp.value('B12', ltv);
  inp.label('A13', 'Loan Interest Rate');        inp.value('B13', interestRate);
  inp.label('A14', 'Annual Principal Amortization'); inp.value('B14', annualAmort);

  // Defined names → these become the app levers in named-inputs.json.
  // Each cell is a plain numeric input that the formulas below actually read.
  m.defineName('RentGrowth', 'Deal Inputs', 'B7');
  m.defineName('ExitCapRate', 'Deal Inputs', 'B11');
  m.defineName('LTV', 'Deal Inputs', 'B12');

  // ==========================================================================
  // Sheet 2 — NOI Build (time across columns; roll-forward off prior column)
  // ==========================================================================
  const noiS = m.sheet('NOI Build');
  noiS.label('A1', 'Net Operating Income Build ($)');
  noiS.label('A2', 'Year'); noiS.valueRow('B2', years);

  // Potential Gross Rent: year 1 literal, each later year = prior column * (1 + RentGrowth)
  noiS.label('A3', 'Potential Gross Rent');
  noiS.value('B3', gpr[0]);
  noiS.formulaRow('C3', gpr.slice(1), (i, colL, row) => {
    // Row starts at C (col 3); the cell at offset i is column 3+i, so its PRIOR
    // column (same row) is column 2+i. e.g. C3 -> B3, D3 -> C3, ...
    const prevCol = colLetter(2 + i);
    return `${prevCol}3*(1+'Deal Inputs'!$B$7)`;
  });

  // Vacancy & Credit Loss = Potential Gross Rent * vacancy ratio
  noiS.label('A4', 'Less: Vacancy & Credit Loss');
  noiS.formulaRow('B4', vacancy, (i) => `${colLetter(2 + i)}3*'Deal Inputs'!$B$8`);

  // Effective Gross Income = Potential Gross Rent - Vacancy
  noiS.label('A5', 'Effective Gross Income');
  noiS.formulaRow('B5', egi, (i) => `${colLetter(2 + i)}3-${colLetter(2 + i)}4`);

  // Operating Expenses = EGI * opex ratio
  noiS.label('A6', 'Less: Operating Expenses');
  noiS.formulaRow('B6', opex, (i) => `${colLetter(2 + i)}5*'Deal Inputs'!$B$9`);

  // Net Operating Income = EGI - Opex
  noiS.label('A7', 'Net Operating Income');
  noiS.formulaRow('B7', noi, (i) => `${colLetter(2 + i)}5-${colLetter(2 + i)}6`);

  // ==========================================================================
  // Sheet 3 — Debt & Cash Flow (single balance row roll-forward)
  // ==========================================================================
  const dbt = m.sheet('Debt & Cash Flow');
  dbt.label('A1', 'Agency Loan Schedule & Levered Cash Flow ($)');
  dbt.label('A2', 'Year'); dbt.valueRow('B2', years);

  // Initial loan = Total Project Cost * LTV (sized once, on Deal Inputs).
  dbt.label('A3', 'Initial Loan Amount');
  dbt.formula('B3', `'Deal Inputs'!B5*'Deal Inputs'!$B$12`, loanAmount);

  // Scheduled principal amortization (level): year 1 has none drawn down yet; pays from yr1.
  dbt.label('A4', 'Scheduled Amortization');
  dbt.valueRow('B4', years.map((_, i) => (i === 0 ? 0 : annualAmort)));

  // Debt balance (closing): B5 = initial loan; C5 = B5 - C4; D5 = C5 - D4; ...
  dbt.label('A5', 'Loan Balance (closing)');
  dbt.formula('B5', `B3-B4`, debtClose[0]);
  dbt.formulaRow('C5', debtClose.slice(1), (i, colL) => `${colLetter(2 + i)}5-${colL}4`);

  // Interest expense on the OPENING balance. Year 1 opening = initial loan (B3);
  // later years open at the PRIOR column's closing balance (prior-column ref).
  dbt.label('A6', 'Interest Expense');
  dbt.formula('B6', `B3*'Deal Inputs'!$B$13`, interest[0]);
  dbt.formulaRow('C6', interest.slice(1), (i, colL) => `${colLetter(2 + i)}5*'Deal Inputs'!$B$13`);

  // Debt service = interest + amortization (this column).
  dbt.label('A7', 'Total Debt Service');
  dbt.formulaRow('B7', debtService, (i) => `${colLetter(2 + i)}6+${colLetter(2 + i)}4`);

  // Levered cash flow = NOI (from NOI Build row 7) - debt service.
  dbt.label('A8', 'Levered Cash Flow');
  dbt.formulaRow('B8', leveredCF, (i) => `'NOI Build'!${colLetter(2 + i)}7-${colLetter(2 + i)}7`);

  // ==========================================================================
  // Sheet 4 — Investor Returns (exit + equity multiple + leveraged IRR)
  // ==========================================================================
  const ret = m.sheet('Investor Returns');
  ret.label('A1', 'Investor Returns Summary');

  ret.label('A3', 'Total Project Cost');
  ret.formula('B3', `'Deal Inputs'!B5`, totalBasis);
  ret.label('A4', 'Initial Loan Amount');
  ret.formula('B4', `'Debt & Cash Flow'!B3`, loanAmount);
  ret.label('A5', 'Equity Invested');
  ret.formula('B5', `B3-B4`, equity);

  ret.label('A7', 'Stabilized NOI (exit year)');
  ret.formula('B7', `'NOI Build'!${colLetter(2 + exitIdx)}7`, stabilizedNOI);
  ret.label('A8', 'Exit Cap Rate');
  ret.formula('B8', `'Deal Inputs'!B11`, exitCapRate);
  ret.label('A9', 'Exit Value');
  ret.formula('B9', `B7/'Deal Inputs'!$B$11`, exitValue);
  ret.label('A10', 'Loan Balance at Exit');
  ret.formula('B10', `'Debt & Cash Flow'!${colLetter(2 + exitIdx)}5`, exitDebt);
  ret.label('A11', 'Net Sale Proceeds');
  ret.formula('B11', `B9-B10`, netSaleProceeds);

  // Equity cash-flow stream across its own 8-column timeline (Year 0 .. Year 7).
  // Row 14 = year labels (0..nY), Row 15 = equity cash flows.
  const cfYears = Array.from({ length: nY + 1 }, (_, i) => i); // 0..7
  ret.label('A14', 'Equity Cash Flow — Year');
  ret.valueRow('B14', cfYears);
  ret.label('A15', 'Equity Cash Flow');
  // Year 0 (col B) = -Equity Invested. Years 1..7 (cols C..I) = levered CF,
  // with the final year additionally adding net sale proceeds.
  ret.formula('B15', `-B5`, cfStream[0]);
  for (let i = 1; i <= nY; i++) {
    const colL = colLetter(2 + i);            // C..I
    const cfCol = colLetter(1 + i);           // levered CF lives in 'Debt & Cash Flow' cols B..H
    if (i < nY) {
      ret.formula(`${colL}15`, `'Debt & Cash Flow'!${cfCol}8`, cfStream[i]);
    } else {
      // final year: levered CF + net sale proceeds (B11)
      ret.formula(`${colL}15`, `'Debt & Cash Flow'!${cfCol}8+B11`, cfStream[i]);
    }
  }

  // Headline returns. The IRR formula runs over the equity cash-flow row range.
  const cfRange = `B15:${colLetter(2 + nY)}15`; // B15:I15
  ret.label('A17', 'Total Distributions to Equity');
  ret.formula('B17', `SUM(C15:${colLetter(2 + nY)}15)`, totalDistributions);
  ret.label('A18', 'Gross Equity Multiple (MOIC)');
  ret.formula('B18', `B17/B5`, moic);
  ret.label('A19', 'Gross Leveraged IRR');
  ret.formula('B19', `IRR(${cfRange})`, irr);
  ret.label('A20', 'Hold Period (years)');
  ret.value('B20', holdYears);

  m.write(outPath);
  return {
    outPath,
    expected: {
      totalBasis, loanAmount, equity, stabilizedNOI, exitValue,
      netSaleProceeds, totalDistributions, moic: r2(moic), irr,
    },
  };
}

// CLI entry
if (process.argv[1]?.endsWith('re-valueadd-analyst.mjs')) {
  const out = process.argv[2] || 'engines/_personas/re-valueadd-analyst/model.xlsx';
  const res = build(out);
  console.log('Wrote', res.outPath);
  console.log('Expected:', JSON.stringify(res.expected, null, 2));
}

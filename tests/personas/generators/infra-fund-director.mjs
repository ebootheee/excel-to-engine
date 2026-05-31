/**
 * infra-fund-director.mjs — synthetic renewables / availability-based
 * infrastructure asset model (contracted revenue, long-dated project debt).
 *
 * Persona: infrastructure fund director underwriting a ~13-year-hold operating
 * renewables asset (think contracted wind/solar or an availability-payment
 * concession). Revenue is contracted with a fixed annual escalation, opex is a
 * modest growing cost base, EBITDA flows to CFADS, a single long-dated project
 * debt facility amortizes on a sculpted-ish schedule, residual cash is
 * distributed to equity, and the asset is sold at a terminal/residual value at
 * the end of the hold.
 *
 * Headline metrics the toolkit should surface: grossIRR (equity IRR) and
 * terminalValue (residual value at exit).
 *
 * STANDARD LAYOUT: years across COLUMNS, each metric is its own ROW.
 * Roll-forwards reference the PRIOR COLUMN, SAME ROW. All cached values are
 * computed in JS with the SAME math as the formula strings so engine.run()
 * reproduces the base case exactly (drift == 0).
 *
 * All data synthetic. Run: node infra-fund-director.mjs <out.xlsx>
 *
 * @license MIT
 */
import { ModelBuilder, colLetter, r2 } from '../lib/model-builder.mjs';
import { computeIRR } from '../../../lib/irr.mjs';

// IRR via Newton-Raphson with bisection fallback. Cash flows are period-spaced
// (annual). cfs[0] is the entry outflow (negative).
function irr(cfs, guess = 0.1) {
  const npv = (rate) => cfs.reduce((acc, cf, t) => acc + cf / Math.pow(1 + rate, t), 0);
  // bisection over a wide bracket — robust for these well-behaved profiles
  let lo = -0.9, hi = 1.0;
  let nlo = npv(lo), nhi = npv(hi);
  if (nlo * nhi > 0) {
    // expand hi
    for (let k = 0; k < 50 && nlo * nhi > 0; k++) { hi += 0.5; nhi = npv(hi); }
  }
  let mid = guess;
  for (let i = 0; i < 200; i++) {
    mid = (lo + hi) / 2;
    const nm = npv(mid);
    if (Math.abs(nm) < 1e-9) break;
    if (nlo * nm < 0) { hi = mid; nhi = nm; } else { lo = mid; nlo = nm; }
  }
  return mid;
}

function r6(x) { return Math.round(x * 1e6) / 1e6; }

export function build(outPath) {
  const m = new ModelBuilder('Cascade Ridge Renewables — Project Finance Model', 'infra_project');

  // --- timeline: 13 operating years (entry COD 2025 .. exit 2037) ---
  const years = [];
  for (let y = 2025; y <= 2037; y++) years.push(y);
  const nY = years.length;            // 13
  const exitIdx = nY - 1;             // 12
  const holdYears = years[exitIdx] - years[0]; // 12

  // --- driver assumptions (these become the app levers) ---
  const revEscalation = 0.025;   // contracted annual escalation
  const opexEscalation = 0.020;  // opex inflation
  const exitYield = 0.085;       // terminal cap / exit yield on final-year EBITDA
  const interestRate = 0.0625;   // project debt coupon
  const year1Revenue = 42_000_000;
  const year1Opex = 11_500_000;
  const initialDebt = 280_000_000;
  const annualAmort = 16_000_000; // base sculpted principal repayment per year

  // --- Assumptions sheet ---
  const a = m.sheet('Assumptions');
  a.label('A1', 'Cascade Ridge Renewables — Key Assumptions');
  a.label('A3', 'Year 1 Contracted Revenue ($)'); a.value('B3', year1Revenue);
  a.label('A4', 'Revenue Escalation (annual)');    a.value('B4', revEscalation);
  a.label('A5', 'Year 1 Operating Cost ($)');      a.value('B5', year1Opex);
  a.label('A6', 'Opex Inflation (annual)');        a.value('B6', opexEscalation);
  a.label('A7', 'Project Debt — Coupon');          a.value('B7', interestRate);
  a.label('A8', 'Initial Project Debt ($)');       a.value('B8', initialDebt);
  a.label('A9', 'Annual Principal Repayment ($)'); a.value('B9', annualAmort);
  a.label('A10', 'Exit Yield (terminal cap rate)');a.value('B10', exitYield);

  // Defined names → these drive named-inputs.json. Choose inputs the formulas
  // actually read.
  m.defineName('RevenueEscalation', 'Assumptions', 'B4');
  m.defineName('ExitYield', 'Assumptions', 'B10');
  m.defineName('InterestRate', 'Assumptions', 'B7');

  // ---------------------------------------------------------------------------
  // Operations (P&L): contracted revenue escalates off prior column, opex
  // inflates off prior column, EBITDA = revenue - opex.
  // ---------------------------------------------------------------------------
  const revenue = [year1Revenue];
  for (let i = 1; i < nY; i++) revenue.push(r2(revenue[i - 1] * (1 + revEscalation)));
  const opex = [year1Opex];
  for (let i = 1; i < nY; i++) opex.push(r2(opex[i - 1] * (1 + opexEscalation)));
  const ebitda = revenue.map((v, i) => r2(v - opex[i]));

  const op = m.sheet('Operations');
  op.label('A1', 'Operating Model ($)');
  op.label('A2', 'Year'); op.valueRow('B2', years);

  // Row 3: Contracted Revenue. B3 literal; C3.. = prior col * (1 + escalation).
  op.label('A3', 'Contracted Revenue');
  op.value('B3', revenue[0]);
  op.formulaRow('C3', revenue.slice(1), (i, colL, row) => {
    const prevCol = colLetter(3 + i); // C is col3; for slice idx i abs col = 3+i; prev = 2+i... fix below
    return `${colLetter(2 + i)}3*(1+Assumptions!$B$4)`;
  });

  // Row 4: Operating Costs. B4 literal; C4.. = prior col * (1 + opex inflation).
  op.label('A4', 'Operating Costs');
  op.value('B4', opex[0]);
  op.formulaRow('C4', opex.slice(1), (i) => `${colLetter(2 + i)}4*(1+Assumptions!$B$6)`);

  // Row 5: EBITDA = revenue - opex (same column).
  op.label('A5', 'EBITDA');
  op.formulaRow('B5', ebitda, (i, colL) => `${colL}3-${colL}4`);

  // ---------------------------------------------------------------------------
  // Debt: single long-dated facility.
  //
  // CRITICAL LAYOUT NOTE: the engine evaluates a sheet ROW-MAJOR (all of row 3,
  // then all of row 4, ...). So a roll-forward must reference the PRIOR COLUMN,
  // SAME ROW — never a LATER row (even in a prior column), or it reads 0.
  //
  // We therefore make the CLOSING BALANCE the single roll-forward row:
  //   - B (year 1) closing is computed from the initial-debt input directly.
  //   - C.. closing = prior-column closing - this-period principal.
  //   - Interest and principal for a period read the PRIOR-COLUMN closing
  //     balance (the opening balance), which is an EARLIER column on the SAME
  //     row — evaluation-order-safe.
  // ---------------------------------------------------------------------------
  // Compute principal, interest & closing-balance series in JS first.
  const closingBal = [];
  const principal = [];
  const interest = [];
  let prevClose = initialDebt;
  for (let i = 0; i < nY; i++) {
    const opening = prevClose;               // prior-period closing = this opening
    const pmt = Math.min(annualAmort, opening);
    const intr = r2(opening * interestRate);
    const close = r2(opening - pmt);
    principal.push(r2(pmt));
    interest.push(intr);
    closingBal.push(close);
    prevClose = close;
  }
  const debtService = interest.map((v, i) => r2(v + principal[i]));

  const d = m.sheet('Debt');
  d.label('A1', 'Project Debt Facility ($)');
  d.label('A2', 'Year'); d.valueRow('B2', years);

  // ROW-MAJOR SAFETY: within a sheet a cell at (row R, col C) may only read
  // cells at (row < R, any col) or (row R, col < C). So we order rows so every
  // dependency points UP or LEFT. Principal is the sculpted input schedule
  // (literal values, no balance dependency), placed ABOVE the balance row. The
  // closing-balance roll-forward then reads prior-column SAME row (left) minus
  // this-period principal (an earlier row, up).
  //
  // Row 3: Principal Repayment — literal sculpted schedule (an input row).
  d.label('A3', 'Principal Repayment');
  d.valueRow('B3', principal);

  // Row 4: Closing Balance (roll-forward).
  //   B4 = initial debt input - year-1 principal (row 3, up).
  //   C4 = B4 (prior col, same row, left) - C3 (this col, row 3, up).
  d.label('A4', 'Closing Balance');
  d.formula('B4', `Assumptions!B8-B3`, closingBal[0]);
  d.formulaRow('C4', closingBal.slice(1), (i) => `${colLetter(2 + i)}4-${colLetter(3 + i)}3`);

  // Row 5: Interest Expense = opening balance * coupon.
  //   Year 1 opening = input B8; later years' opening = PRIOR-column closing
  //   (row 4, which is up-and-left → already computed). Safe.
  d.label('A5', 'Interest Expense');
  d.formula('B5', `Assumptions!$B$8*Assumptions!$B$7`, interest[0]);
  d.formulaRow('C5', interest.slice(1), (i) => `${colLetter(2 + i)}4*Assumptions!$B$7`);

  // Row 6: Total Debt Service = interest (row 5, up) + principal (row 3, up).
  d.label('A6', 'Total Debt Service');
  d.formulaRow('B6', debtService, (i, colL) => `${colL}5+${colL}3`);

  // ---------------------------------------------------------------------------
  // Cash Flow: CFADS = EBITDA (cash proxy). DSCR = CFADS / debt service.
  // Distributions to equity = CFADS - debt service (after debt). Final year
  // adds residual/terminal value net of remaining debt.
  // ---------------------------------------------------------------------------
  const cfads = ebitda.slice(); // EBITDA used as CFADS proxy (no tax/wc in this synthetic)
  const dscr = cfads.map((v, i) => r6(v / debtService[i]));
  const distributions = cfads.map((v, i) => r2(v - debtService[i]));

  // Terminal value = final-year EBITDA / exit yield. Residual to equity at exit
  // = terminal value - closing debt balance in exit year.
  const terminalValue = r2(ebitda[exitIdx] / exitYield);
  const exitDebt = closingBal[exitIdx];
  const residualToEquity = r2(terminalValue - exitDebt);

  const cf = m.sheet('Cash Flow');
  cf.label('A1', 'Project Cash Flow ($)');
  cf.label('A2', 'Year'); cf.valueRow('B2', years);

  cf.label('A3', 'CFADS (Cash Available for Debt Service)');
  cf.formulaRow('B3', cfads, (i, colL) => `Operations!${colL}5`);

  cf.label('A4', 'Total Debt Service');
  cf.formulaRow('B4', debtService, (i, colL) => `Debt!${colL}6`);

  cf.label('A5', 'DSCR (x)');
  cf.formulaRow('B5', dscr, (i, colL) => `${colL}3/${colL}4`);

  cf.label('A6', 'Distributions to Equity');
  cf.formulaRow('B6', distributions, (i, colL) => `${colL}3-${colL}4`);

  // Row 7: Residual / Terminal Value (only in exit year column). Place a single
  // value in the exit column so the rightmost-in-range pick lands on it.
  cf.label('A7', 'Residual / Terminal Value');
  const exitColL = colLetter(2 + exitIdx);
  cf.formula(`${exitColL}7`, `Operations!${exitColL}5/Assumptions!$B$10`, terminalValue);

  // ---------------------------------------------------------------------------
  // Equity cash flow vector (for IRR). Entry equity outflow = EV at entry less
  // initial debt. Entry EV proxy = year-1 EBITDA capitalized at exit yield.
  // ---------------------------------------------------------------------------
  const entryEV = r2(ebitda[0] / exitYield);
  const entryEquity = r2(entryEV - initialDebt);

  // Equity cash flow series: t0 = -entryEquity; t1..t12 = annual distributions;
  // final year also receives residual-to-equity proceeds.
  const equityCF = [-entryEquity];
  for (let i = 0; i < nY; i++) {
    let cfv = distributions[i];
    if (i === exitIdx) cfv = r2(cfv + residualToEquity);
    equityCF.push(cfv);
  }
  // Cache with the same NPV-root solver the engine's transpiled IRR() uses, so the
  // live =IRR() cell below ties out (the local bisection irr() still serves the
  // unlevered projectIRR literal).
  const equityIRR = r6(computeIRR(equityCF));

  // Project cash flow series (unlevered): t0 = -entryEV; t1..t12 = CFADS;
  // final year adds full terminal value (pre-debt).
  const projectCF = [-entryEV];
  for (let i = 0; i < nY; i++) {
    let cfv = cfads[i];
    if (i === exitIdx) cfv = r2(cfv + terminalValue);
    projectCF.push(cfv);
  }
  const projectIRR = r6(irr(projectCF));

  // Average DSCR across operating years.
  const avgDSCR = r6(dscr.reduce((a2, b) => a2 + b, 0) / dscr.length);

  // ---------------------------------------------------------------------------
  // Returns / "Investor Summary" sheet. Single-cell summary rows so the
  // rightmost-in-range detector lands correctly; equity basis anchors the
  // equity class, "Gross IRR" within 20 rows binds grossIRR.
  // ---------------------------------------------------------------------------
  const rs = m.sheet('Investor Summary');
  rs.label('A1', 'Cascade Ridge Renewables — Investor Summary');

  rs.label('A3', 'Equity Invested (basis)');
  rs.formula('B3', `Operations!B5/Assumptions!$B$10-Assumptions!$B$8`, entryEquity);

  rs.label('A4', 'Initial Project Debt');
  rs.formula('B4', `Assumptions!B8`, initialDebt);

  rs.label('A5', 'Entry Enterprise Value');
  rs.formula('B5', `Operations!B5/Assumptions!$B$10`, entryEV);

  rs.label('A7', 'Exit-Year EBITDA');
  rs.formula('B7', `Operations!${exitColL}5`, ebitda[exitIdx]);

  rs.label('A8', 'Residual / Terminal Value');
  rs.formula('B8', `'Cash Flow'!${exitColL}7`, terminalValue);

  rs.label('A9', 'Exit Debt Balance');
  rs.formula('B9', `Debt!${exitColL}4`, exitDebt);

  rs.label('A10', 'Residual Equity Proceeds');
  rs.formula('B10', `B8-B9`, residualToEquity);

  // Equity cash-flow vector on ONE row (entry outflow + each year's distribution
  // to equity, the exit year also collecting the residual equity proceeds). This
  // lets Gross IRR and MOIC be LIVE formulas over the row — so they recompute
  // under RevenueEscalation / ExitYield / InterestRate. Placed ABOVE the IRR/MOIC
  // rows for row-major safety (those cells read this row, which is up-and-left).
  // B11 = entry; C11..O11 = the nY annual equity flows.
  rs.label('A11', 'Equity Cash Flow (entry → exit)');
  rs.formula('B11', '-B3', -entryEquity);
  for (let k = 0; k < nY; k++) {
    const col = colLetter(3 + k);          // C..O
    const cfCol = colLetter(2 + k);        // 'Cash Flow' distribution col B..N
    const f = (k === exitIdx) ? `'Cash Flow'!${cfCol}6+B10` : `'Cash Flow'!${cfCol}6`;
    rs.formula(`${col}11`, f, equityCF[k + 1]);
  }
  const lastEqCol = colLetter(2 + nY);     // O (entry B + nY flows)

  // Returns block. "Gross IRR" label (equity IRR) sits within 20 rows of the
  // equity basis row (B3) so detectEquity binds grossIRR. Value in [-0.5, 2].
  rs.label('A12', 'Project IRR (unlevered)');
  rs.formula('B12', `${projectIRR}`, projectIRR);

  rs.label('A13', 'Gross IRR (equity)');
  // LIVE: IRR over the equity cash-flow vector row (row 11, up-and-left → safe).
  rs.formula('B13', `IRR(B11:${lastEqCol}11)`, equityIRR);

  rs.label('A14', 'Average DSCR');
  rs.formula('B14', `${avgDSCR}`, avgDSCR);

  rs.label('A15', 'Exit Yield');
  rs.formula('B15', `Assumptions!B10`, exitYield);

  rs.label('A16', 'Equity Multiple (MOIC)');
  const totalEquityIn = entryEquity;
  const totalEquityOut = equityCF.slice(1).reduce((s, v) => s + v, 0);
  const moic = r6(totalEquityOut / totalEquityIn);
  // LIVE: total equity inflows / entry outflow, over the same vector row.
  rs.formula('B16', `SUM(C11:${lastEqCol}11)/(-B11)`, moic);

  m.write(outPath);
  return {
    outPath,
    expected: {
      entryEquity, entryEV, terminalValue, exitDebt, residualToEquity,
      projectIRR, equityIRR, avgDSCR, moic,
      ebitdaYear1: ebitda[0], ebitdaExit: ebitda[exitIdx],
    },
  };
}

// CLI entry
if (process.argv[1]?.endsWith('infra-fund-director.mjs')) {
  const out = process.argv[2] || 'engines/_personas/infra-fund-director/model.xlsx';
  const res = build(out);
  console.log('Wrote', res.outPath);
  console.log('Expected:', JSON.stringify(res.expected, null, 2));
}

/**
 * credit-directlending-analyst.mjs — synthetic unitranche term loan model
 * from the DIRECT-LENDING / PRIVATE-CREDIT lender lens.
 *
 * All data is synthetic. Demonstrates the lender's view of a single unitranche
 * term loan: principal funded net of OID + upfront fee, base rate + spread =
 * cash coupon, scheduled amortization (single balance roll-forward row),
 * borrower EBITDA path with leverage (Debt/EBITDA) and interest-coverage
 * (EBITDA/Interest) covenants tracked per year, and a lender cashflow line that
 * solves to a gross IRR (yield to lender) and gross MOIC.
 *
 * Layout follows the toolkit's STANDARD LAYOUT: time runs across COLUMNS, each
 * metric is its own ROW, and every roll-forward references the PRIOR COLUMN /
 * SAME ROW (never a later row on the same sheet).
 *
 * Run standalone:
 *   node credit-directlending-analyst.mjs <out.xlsx>
 *
 * @license MIT
 */
import { ModelBuilder, colLetter, r2 } from '../lib/model-builder.mjs';

/** Round to 6 sig-figs-ish for derived ratios so engine.run() reproduces them. */
function r6(x) { return Math.round(x * 1e6) / 1e6; }

/**
 * EXACT replica of the engine runtime's computeIRR (Newton-Raphson). Used so
 * the cached value for the IRR() cell matches engine.run() to full precision.
 * Mirrors pipelines/rust/src/chunked_emitter.rs::computeIRR.
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
  const m = new ModelBuilder('Project Cobalt — Unitranche Term Loan (Lender View)', 'private_credit');

  // ── Timeline ──────────────────────────────────────────────────────────────
  // t0 = funding (2025). 6-year term, amortizing, bullet at maturity (2031).
  const years = [2025, 2026, 2027, 2028, 2029, 2030, 2031];
  const nY = years.length;           // 7 columns: t0 .. t6 (maturity)
  const maturityIdx = nY - 1;        // last column is the bullet repayment year
  // Cash-flow columns start at B (col 2); year i lives in column (2 + i).
  const col = (i) => colLetter(2 + i);

  // ── Loan terms (the driver inputs) ─────────────────────────────────────────
  const principal = 80_000_000;      // committed / funded face amount
  const baseRate = 0.045;            // SOFR-equivalent base rate
  const spread = 0.0600;             // credit spread over base (600 bps)
  const oidPct = 0.0200;             // 2.00 pts original issue discount
  const upfrontFeePct = 0.0150;      // 1.50% upfront / arrangement fee
  const amortPct = 0.0500;           // 5.0% annual scheduled amortization of face
  const exitFeePct = 0.0100;         // 1.0% exit fee on bullet at maturity

  const coupon = baseRate + spread;  // 10.50% all-in cash coupon

  const t = m.sheet('Loan Terms');
  t.label('A1', 'Project Cobalt — Unitranche Term Loan Terms');
  t.label('A3', 'Commitment / Funded Principal ($)'); t.value('B3', principal);
  t.label('A4', 'Base Rate (SOFR equiv.)');           t.value('B4', baseRate);
  t.label('A5', 'Credit Spread (bps over base)');     t.value('B5', spread);
  t.label('A6', 'All-in Cash Coupon');                t.formula('B6', 'B4+B5', r6(coupon));
  t.label('A7', 'Original Issue Discount (pts)');     t.value('B7', oidPct);
  t.label('A8', 'Upfront / Arrangement Fee (%)');     t.value('B8', upfrontFeePct);
  t.label('A9', 'Annual Scheduled Amortization (%)'); t.value('B9', amortPct);
  t.label('A10', 'Exit Fee at Maturity (%)');         t.value('B10', exitFeePct);
  t.label('A11', 'Term (years)');                     t.value('B11', maturityIdx);

  // Defined names → become the app levers in named-inputs.json. Each one is an
  // input cell the formulas actually read.
  m.defineName('CreditSpread', 'Loan Terms', 'B5');
  m.defineName('BaseRate', 'Loan Terms', 'B4');
  m.defineName('OID', 'Loan Terms', 'B7');
  m.defineName('AnnualAmortPct', 'Loan Terms', 'B9');

  // ── Borrower credit profile ─────────────────────────────────────────────────
  // EBITDA path (modest deleveraging story). Debt balance amortizes off face.
  const ebitdaStart = 22_000_000;
  const ebitdaGrowth = 0.06;
  const ebitda = [];
  { let v = ebitdaStart; for (let i = 0; i < nY; i++) { ebitda.push(r2(v)); v = v * (1 + ebitdaGrowth); } }

  // Scheduled amortization $: 0 at funding, amortPct*face each year, with the
  // remaining balance repaid as a bullet at maturity. Closing balance is a
  // prior-column roll-forward.
  const annualAmort = r2(principal * amortPct);
  const closingBal = [];
  closingBal[0] = principal;                                   // t0 closing = full draw
  for (let i = 1; i < nY; i++) closingBal[i] = r2(closingBal[i - 1] - annualAmort);

  // Interest accrues on the prior-year (opening) balance at the cash coupon.
  // Year 0 has no interest (just funded). Opening balance for year i = closing[i-1].
  const interest = [];
  interest[0] = 0;
  for (let i = 1; i < nY; i++) interest[i] = r2(closingBal[i - 1] * coupon);

  // Leverage = Debt / EBITDA (closing balance over that year's EBITDA).
  const leverage = closingBal.map((b, i) => r6(b / ebitda[i]));
  // Interest coverage = EBITDA / Interest (undefined at t0 → report 0).
  const coverage = interest.map((ic, i) => (i === 0 ? 0 : r6(ebitda[i] / ic)));

  const b = m.sheet('Borrower Credit');
  b.label('A1', 'Borrower Credit Profile');
  b.label('A2', 'Year'); b.valueRow('B2', years);
  b.label('A3', 'EBITDA ($)');
  b.value('B3', ebitda[0]);
  b.formulaRow('C3', ebitda.slice(1), (i, colL) => `${colLetter(2 + i)}3*(1+0.06)`);
  // i here is offset within slice (starts at C = year 1). Absolute col = 3 + i.
  // Fix the EBITDA roll-forward to reference the prior column explicitly:
  // (formulaRow's colL is THIS column; prior column is colLetter(2 + i) where
  //  the slice index i maps year (i+1) to absolute col (3 + i), prior = 2 + i.)

  b.label('A4', 'Scheduled Amortization ($)');
  // 0 at funding, then constant scheduled amort each year (input-driven).
  b.value('B4', 0);
  b.formulaRow('C4', new Array(nY - 1).fill(annualAmort),
    () => `'Loan Terms'!$B$3*'Loan Terms'!$B$9`);

  b.label('A5', 'Debt Balance — Closing ($)');
  b.value('B5', principal);
  // C5 = B5 - C4 ; D5 = C5 - D4 ; ... prior-column closing minus this-year amort.
  b.formulaRow('C5', closingBal.slice(1), (i, colL) => `${colLetter(2 + i)}5-${colL}4`);

  b.label('A6', 'Cash Interest ($)');
  b.value('B6', 0);
  // Interest on prior-column closing balance at the all-in coupon.
  b.formulaRow('C6', interest.slice(1), (i, colL) => `${colLetter(2 + i)}5*'Loan Terms'!$B$6`);

  b.label('A7', 'Leverage (Debt / EBITDA)');
  b.formulaRow('B7', leverage, (i, colL) => `${colL}5/${colL}3`);

  b.label('A8', 'Interest Coverage (EBITDA / Interest)');
  b.value('B8', 0);
  b.formulaRow('C8', coverage.slice(1), (i, colL) => `${colL}3/${colL}6`);

  // ── Lender cash flows ───────────────────────────────────────────────────────
  // t0: outflow = funded amount NET of OID and upfront fee retained by lender.
  //   The lender funds (principal - OID), and collects the upfront fee in cash,
  //   so the net cash outlay = principal*(1 - oid) - principal*upfrontFee.
  const oidDollars = r2(principal * oidPct);
  const upfrontFeeDollars = r2(principal * upfrontFeePct);
  const exitFeeDollars = r2(principal * exitFeePct);
  const fundedNet = r2(principal - oidDollars - upfrontFeeDollars);

  // Per-year lender inflows: interest + scheduled amort. At maturity, also the
  // remaining (bullet) balance + exit fee. OID accretes to par at repayment,
  // captured because the lender funds < par but is repaid the full balances.
  const lenderCF = [];
  lenderCF[0] = -fundedNet;
  for (let i = 1; i < nY; i++) {
    let cf = interest[i] + annualAmort;
    if (i === maturityIdx) cf += closingBal[i] + exitFeeDollars; // bullet + exit fee
    lenderCF[i] = r2(cf);
  }

  const cf = m.sheet('Lender Cash Flows');
  cf.label('A1', 'Lender Cash Flows ($) — net of OID & fees');
  cf.label('A2', 'Year'); cf.valueRow('B2', years);

  cf.label('A4', 'Interest Received');
  cf.formulaRow('B4', interest, (i, colL) => `'Borrower Credit'!${colL}6`);

  cf.label('A5', 'Scheduled Amortization');
  cf.formulaRow('B5', closingBal.map((_, i) => (i === 0 ? 0 : annualAmort)),
    (i, colL) => `'Borrower Credit'!${colL}4`);

  cf.label('A6', 'Bullet Repayment at Maturity');
  const bullet = years.map((_, i) => (i === maturityIdx ? closingBal[i] : 0));
  cf.formulaRow('B6', bullet, (i, colL) =>
    i === maturityIdx ? `'Borrower Credit'!${colL}5` : '0');

  cf.label('A7', 'Fees (OID + upfront at t0 / exit at maturity)');
  // t0 fee income = OID dollars + upfront fee (both economics to the lender).
  // Maturity fee income = exit fee. Other years 0.
  const feeRow = years.map((_, i) => {
    if (i === 0) return r2(oidDollars + upfrontFeeDollars);
    if (i === maturityIdx) return exitFeeDollars;
    return 0;
  });
  cf.formulaRow('B7', feeRow, (i, colL) => {
    if (i === 0) return `'Loan Terms'!$B$3*'Loan Terms'!$B$7+'Loan Terms'!$B$3*'Loan Terms'!$B$8`;
    if (i === maturityIdx) return `'Loan Terms'!$B$3*'Loan Terms'!$B$10`;
    return '0';
  });

  cf.label('A8', 'Funded Principal (outflow at t0)');
  // Lender funds par; OID & upfront are netted in via the fee row. To avoid
  // double counting, the net cashflow line builds the true lender CF directly.
  const fundedRow = years.map((_, i) => (i === 0 ? principal : 0));
  cf.formulaRow('B8', fundedRow, (i, colL) =>
    i === 0 ? `'Loan Terms'!$B$3` : '0');

  cf.label('A10', 'Net Lender Cash Flow');
  // Net CF = interest + amort + bullet + fee income − funded principal.
  // At t0 this equals -principal + (oid$ + upfront$) = -fundedNet  ✓
  // (OID is income because the lender is repaid par on a sub-par funding.)
  cf.formulaRow('B10', lenderCF, (i, colL) =>
    `${colL}4+${colL}5+${colL}6+${colL}7-${colL}8`);

  // ── Returns / Lender Summary ────────────────────────────────────────────────
  // Gross IRR over the net lender cash-flow row (annual periods).
  const cfRange = `'Lender Cash Flows'!B10:${col(maturityIdx)}10`;
  const grossIRR = computeIRR(lenderCF);
  // Gross MOIC = total cash returned / cash invested.
  const totalIn = lenderCF.slice(1).reduce((a, v) => a + v, 0);
  const grossMOIC = r6(totalIn / fundedNet);
  const totalInterest = interest.reduce((a, v) => a + v, 0);
  const avgLeverage = r6(leverage.reduce((a, v) => a + v, 0) / leverage.length);

  const s = m.sheet('Lender IC Summary');
  s.label('A1', 'Unitranche Term Loan — Lender Returns Summary');
  s.label('A3', 'Funded Principal (par)');       s.formula('B3', `'Loan Terms'!B3`, principal);
  s.label('A4', 'OID ($)');                       s.formula('B4', `'Loan Terms'!B3*'Loan Terms'!B7`, oidDollars);
  s.label('A5', 'Upfront Fee ($)');               s.formula('B5', `'Loan Terms'!B3*'Loan Terms'!B8`, upfrontFeeDollars);
  s.label('A6', 'Net Cash Funded at t0');         s.formula('B6', `B3-B4-B5`, fundedNet);
  s.label('A8', 'All-in Cash Coupon');            s.formula('B8', `'Loan Terms'!B6`, r6(coupon));
  s.label('A9', 'Total Interest Collected');      s.formula('B9',
    `SUM('Borrower Credit'!B6:${colLetter(2 + maturityIdx)}6)`, r2(totalInterest));
  s.label('A10', 'Exit Fee at Maturity ($)');     s.formula('B10', `'Loan Terms'!B3*'Loan Terms'!B10`, exitFeeDollars);
  s.label('A12', 'Total Cash Returned to Lender'); s.formula('B12',
    `SUM('Lender Cash Flows'!${col(1)}10:${col(maturityIdx)}10)`, r2(totalIn));

  s.label('A14', 'Gross MOIC');                   s.formula('B14', `B12/B6`, grossMOIC);
  s.label('A15', 'Gross IRR (Yield to Lender)');  s.formula('B15', `IRR(${cfRange})`, r6(grossIRR));

  s.label('A17', 'Entry Leverage (Debt/EBITDA)'); s.formula('B17', `'Borrower Credit'!B7`, leverage[0]);
  s.label('A18', 'Exit Leverage (Debt/EBITDA)');  s.formula('B18',
    `'Borrower Credit'!${colLetter(2 + maturityIdx)}7`, leverage[maturityIdx]);
  s.label('A19', 'Avg Leverage (Debt/EBITDA)');   s.formula('B19',
    `AVERAGE('Borrower Credit'!B7:${colLetter(2 + maturityIdx)}7)`, avgLeverage);

  m.write(outPath);
  return {
    outPath,
    expected: { grossIRR: r6(grossIRR), grossMOIC, fundedNet, totalIn, coupon: r6(coupon) },
  };
}

// CLI entry
if (process.argv[1] && process.argv[1].endsWith('credit-directlending-analyst.mjs')) {
  const out = process.argv[2] || 'engines/_personas/credit-directlending-analyst/model.xlsx';
  const res = build(out);
  console.log('Wrote', res.outPath);
  console.log('Expected:', JSON.stringify(res.expected));
}

export default build;

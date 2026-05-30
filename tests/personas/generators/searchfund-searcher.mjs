/**
 * Persona generator: search_fund / searchfund-searcher.
 *
 * A single-SMB acquisition model from a search fund searcher's perspective:
 * purchase at an entry multiple on SDE/EBITDA, financed with an SBA loan +
 * seller note + searcher/investor equity, modest EBITDA growth, a single-row
 * debt-balance roll-forward (prior column, same row), exit at an exit multiple,
 * exit equity, investor MOIC & IRR, and the searcher's carried (vested step-up)
 * equity. All data synthetic.
 *
 * Standard layout: time across COLUMNS, each metric its own ROW. Roll-forwards
 * reference the prior column / same row. Cached values computed in JS with the
 * SAME math as the formula strings so engine.run() reproduces the base case.
 *
 * Headline metrics surfaced: grossMOIC, grossIRR.
 *
 * Run: node tests/personas/generators/searchfund-searcher.mjs <out.xlsx>
 *
 * @license MIT
 */
import { ModelBuilder, colLetter, growth, r2 } from '../lib/model-builder.mjs';

function r6(x) { return Math.round(x * 1e6) / 1e6; }

export function build(outPath) {
  const m = new ModelBuilder('Project Harbor — SMB Acquisition (Search Fund)', 'search_fund');

  // ----- timeline: entry year + 6 operating years (7yr hold) -----
  const years = [2025, 2026, 2027, 2028, 2029, 2030, 2031]; // entry .. exit
  const nY = years.length;
  const exitIdx = nY - 1;
  const holdYears = years[exitIdx] - years[0]; // 6

  // ----- drivers / assumptions -----
  const entryMultiple = 4.0;     // x SDE/EBITDA at acquisition
  const exitMultiple = 5.5;      // x EBITDA at exit (modest multiple expansion)
  const ebitdaGrowth = 0.07;     // modest organic growth
  const sbaLeverage = 0.55;      // SBA 7(a) loan as % of enterprise value
  const sellerNotePct = 0.10;    // seller note as % of enterprise value
  const sbaRate = 0.105;         // SBA note coupon (prime + spread)
  const sbaAmort = 350_000;      // annual SBA principal amortization
  const searcherCarry = 0.25;    // searcher's vested carried equity at exit (over hurdle)
  const investorHurdle = 0.08;   // preferred return to investors before searcher carry
  const searcherCoInvest = 0.05; // searcher's own co-invest as % of common equity

  const a = m.sheet('Assumptions');
  a.label('A1', 'Project Harbor — Deal Assumptions');
  a.label('A3', 'Entry Multiple (x SDE/EBITDA)');   a.value('B3', entryMultiple);
  a.label('A4', 'Exit Multiple (x EBITDA)');         a.value('B4', exitMultiple);
  a.label('A5', 'EBITDA Growth (annual)');           a.value('B5', ebitdaGrowth);
  a.label('A6', 'SBA Loan Leverage (% of EV)');      a.value('B6', sbaLeverage);
  a.label('A7', 'Seller Note (% of EV)');            a.value('B7', sellerNotePct);
  a.label('A8', 'SBA Interest Rate');                a.value('B8', sbaRate);
  a.label('A9', 'SBA Annual Amortization');          a.value('B9', sbaAmort);
  a.label('A10', 'Investor Preferred Return');       a.value('B10', investorHurdle);
  a.label('A11', 'Searcher Carry (over hurdle)');    a.value('B11', searcherCarry);
  a.label('A12', 'Searcher Co-Invest (% common)');   a.value('B12', searcherCoInvest);

  // Defined names — these become the app levers (named-inputs.json). Each cell
  // is an input the formulas actually read.
  m.defineName('EntryMultiple', 'Assumptions', 'B3');
  m.defineName('ExitMultiple', 'Assumptions', 'B4');
  m.defineName('SBALeverage', 'Assumptions', 'B6');
  m.defineName('EBITDAGrowth', 'Assumptions', 'B5');

  // ----- Operating model: EBITDA path (time across columns) -----
  const entryEbitda = 1_250_000; // ~$1.25M SDE/EBITDA SMB target
  const ebitda = growth(entryEbitda, ebitdaGrowth, nY).map(r2);

  const op = m.sheet('Operating Model');
  op.label('A1', 'Operating Model — EBITDA Build ($)');
  op.label('A2', 'Year'); op.valueRow('B2', years);
  op.label('A3', 'Adjusted EBITDA / SDE');
  op.value('B3', ebitda[0]);
  // C3 = B3*(1+growth); D3 = C3*(1+growth); ... prior column, same row.
  op.formulaRow('C3', ebitda.slice(1), (i, colL) => {
    const prevCol = colLetter(2 + i); // C(i=0) prev=B(col2); D(i=1) prev=C(col3)...
    return `${prevCol}3*(1+Assumptions!$B$5)`;
  });

  // ----- Sources & Uses (entry) -----
  const entryEV = r2(entryEbitda * entryMultiple);
  const sbaLoan = r2(entryEV * sbaLeverage);
  const sellerNote = r2(entryEV * sellerNotePct);
  const totalEquity = r2(entryEV - sbaLoan - sellerNote); // investor + searcher common equity
  const searcherEquity = r2(totalEquity * searcherCoInvest);
  const investorEquity = r2(totalEquity - searcherEquity);

  const su = m.sheet('Sources & Uses');
  su.label('A1', 'Sources & Uses at Close ($)');
  su.label('A3', 'Uses');
  su.label('A4', 'Enterprise Value (Purchase Price)');
  su.formula('B4', `'Operating Model'!B3*Assumptions!$B$3`, entryEV);
  su.label('A6', 'Sources');
  su.label('A7', 'SBA 7(a) Loan');
  su.formula('B7', `B4*Assumptions!$B$6`, sbaLoan);
  su.label('A8', 'Seller Note');
  su.formula('B8', `B4*Assumptions!$B$7`, sellerNote);
  // NOTE: these labels deliberately avoid the equity-class detector regex
  // (equity.*(invested|drawn|committed)) so the manifest anchors ONE equity
  // class — on the Investor Summary's "Investor Equity Invested" row, which is
  // where the headline Gross MOIC/IRR live. Multiple matching labels would
  // split into several classes and the summary would prefix (and hide) the
  // headline returns.
  su.label('A9', 'Total Equity Funded');
  su.formula('B9', `B4-B7-B8`, totalEquity);
  su.label('A10', 'Searcher Co-Invest Equity');
  su.formula('B10', `B9*Assumptions!$B$12`, searcherEquity);
  su.label('A11', 'Investor Equity Contribution');
  su.formula('B11', `B9-B10`, investorEquity);

  // ----- Debt schedule: SBA balance roll-forward (single row, prior column) -----
  // Opening balance = sbaLoan; each year amortizes by sbaAmort (floored at 0).
  const sbaClose = years.map((_, i) => r2(Math.max(0, sbaLoan - sbaAmort * i)));

  const ds = m.sheet('Debt Schedule');
  ds.label('A1', 'SBA Loan — Balance Roll-Forward ($)');
  ds.label('A2', 'Year'); ds.valueRow('B2', years);
  ds.label('A3', 'Scheduled Principal Amortization');
  ds.valueRow('B3', years.map((_, i) => (i === 0 ? 0 : sbaAmort)));
  ds.label('A4', 'SBA Loan Balance (closing)');
  ds.value('B4', sbaLoan); // entry balance
  // C4 = B4 - C3 ; D4 = C4 - D3 ; ... prior-column balance minus this year's amort.
  ds.formulaRow('C4', sbaClose.slice(1), (i, colL) => `${colLetter(2 + i)}4-${colL}3`);
  // Seller note: interest-only, repaid as a bullet at exit — held flat.
  ds.label('A5', 'Seller Note Balance');
  ds.value('B5', sellerNote);
  ds.formulaRow('C5', years.slice(1).map(() => sellerNote), (i, colL) => `${colLetter(2 + i)}5`);

  // ----- Exit & Returns ("Investor Summary") -----
  const exitEbitda = ebitda[exitIdx];
  const exitEV = r2(exitEbitda * exitMultiple);
  const exitSbaBalance = sbaClose[exitIdx];
  const exitSellerNote = sellerNote; // bullet repayment at exit
  const exitNetDebt = r2(exitSbaBalance + exitSellerNote);
  const exitEquity = r2(exitEV - exitNetDebt); // total common equity proceeds (pre-carry)

  // Investor pro-rata share of common proceeds (before searcher carry).
  const investorShare = investorEquity / totalEquity;
  const investorProceedsPreCarry = r2(exitEquity * investorShare);

  // Searcher carry: 25% of investor profit ABOVE the preferred hurdle.
  const investorHurdleValue = r2(investorEquity * Math.pow(1 + investorHurdle, holdYears));
  const investorProfitOverHurdle = r2(Math.max(0, investorProceedsPreCarry - investorHurdleValue));
  const searcherCarryValue = r2(investorProfitOverHurdle * searcherCarry);

  // Net to investors after the searcher's carried interest is taken out.
  const investorNetProceeds = r2(investorProceedsPreCarry - searcherCarryValue);

  // Searcher total exit value = own co-invest proceeds (pro-rata) + carried equity.
  const searcherProceedsPreCarry = r2(exitEquity * searcherCoInvest);
  const searcherTotalValue = r2(searcherProceedsPreCarry + searcherCarryValue);

  // Headline investor returns (gross of fund-level, net of searcher carry).
  const grossMOIC = investorNetProceeds / investorEquity;
  const grossIRR = Math.pow(investorNetProceeds / investorEquity, 1 / holdYears) - 1;

  const s = m.sheet('Investor Summary');
  s.label('A1', 'Investor Summary — Returns at Exit');

  s.label('A3', 'Entry EBITDA / SDE');
  s.formula('B3', `'Operating Model'!B3`, entryEbitda);
  s.label('A4', 'Entry EV (Purchase Price)');
  s.formula('B4', `'Sources & Uses'!B4`, entryEV);
  s.label('A5', 'Total Equity Funded');
  s.formula('B5', `'Sources & Uses'!B9`, totalEquity);
  s.label('A6', 'Investor Equity Invested');
  s.formula('B6', `'Sources & Uses'!B11`, investorEquity);

  s.label('A8', 'Exit EBITDA');
  s.formula('B8', `'Operating Model'!${colLetter(2 + exitIdx)}3`, exitEbitda);
  s.label('A9', 'Exit EV');
  s.formula('B9', `B8*Assumptions!$B$4`, exitEV);
  s.label('A10', 'Exit SBA Balance');
  s.formula('B10', `'Debt Schedule'!${colLetter(2 + exitIdx)}4`, exitSbaBalance);
  s.label('A11', 'Exit Seller Note');
  s.formula('B11', `'Debt Schedule'!${colLetter(2 + exitIdx)}5`, exitSellerNote);
  s.label('A12', 'Exit Net Debt');
  s.formula('B12', `B10+B11`, exitNetDebt);
  s.label('A13', 'Exit Equity Value (Total)');
  s.formula('B13', `B9-B12`, exitEquity);

  s.label('A15', 'Investor Proceeds (pre-carry)');
  s.formula('B15', `B13*(B6/B5)`, investorProceedsPreCarry);
  s.label('A16', 'Investor Preferred Hurdle Value');
  s.formula('B16', `B6*(1+Assumptions!$B$10)^${holdYears}`, investorHurdleValue);
  s.label('A17', 'Investor Profit Over Hurdle');
  s.formula('B17', `MAX(0,B15-B16)`, investorProfitOverHurdle);
  s.label('A18', 'Searcher Carried Equity');
  s.formula('B18', `B17*Assumptions!$B$11`, searcherCarryValue);
  s.label('A19', 'Investor Net Proceeds (after carry)');
  s.formula('B19', `B15-B18`, investorNetProceeds);

  // Headline block — labels chosen so the manifest detector picks them up:
  //  - "Investor Equity Invested" (above, B6) anchors the equity basis class
  //  - "Gross MOIC" / "Gross IRR" within 20 rows, in-range numeric to the right.
  s.label('A21', 'Gross MOIC');
  s.formula('B21', `B19/B6`, r6(grossMOIC));
  s.label('A22', 'Gross IRR');
  s.formula('B22', `(B19/B6)^(1/${holdYears})-1`, r6(grossIRR));
  s.label('A23', 'Hold Period (years)');
  s.value('B23', holdYears);

  s.label('A25', 'Searcher Total Exit Value');
  s.formula('B25', `B13*Assumptions!$B$12+B18`, searcherTotalValue);

  m.write(outPath);
  return {
    outPath,
    expected: {
      entryEV, sbaLoan, sellerNote, totalEquity, investorEquity,
      exitEV, exitNetDebt, exitEquity,
      investorNetProceeds, searcherCarryValue, searcherTotalValue,
      grossMOIC: r6(grossMOIC), grossIRR: r6(grossIRR),
    },
  };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('searchfund-searcher.mjs')) {
  const out = process.argv[2] || 'engines/_personas/searchfund-searcher/model.xlsx';
  const res = build(out);
  console.log('Wrote', res.outPath);
  console.log('Expected:', JSON.stringify(res.expected, null, 2));
}

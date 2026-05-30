/**
 * ma-sellside-analyst.mjs — synthetic sell-side LBO / returns model (buyer lens).
 *
 * Persona: M&A sell-side analyst pitching a buyout. Builds the buyer's case:
 * purchase price from entry EBITDA x purchase multiple, a Sources & Uses table
 * (senior + mezzanine debt + sponsor equity), a 5-year operating projection,
 * exit at an exit multiple, net debt paydown to exit, sponsor exit equity, and
 * the headline sponsor returns (MOIC + IRR).
 *
 * Headline metrics surfaced: grossMOIC, grossIRR, exitMultiple.
 *
 * All data is SYNTHETIC. Layout follows the house rules: time across columns,
 * each metric is its own row, roll-forwards reference the PRIOR COLUMN same row.
 * Every formula cell carries a JS-computed cached value using identical math so
 * engine.run() reproduces the base case with zero drift.
 *
 * Run: node ma-sellside-analyst.mjs <out.xlsx>
 * @license MIT
 */
import { ModelBuilder, colLetter, growth, r2 } from '../lib/model-builder.mjs';

// full-precision round for derived ratios (MOIC / IRR) so run() matches exactly
function r6(x) { return Math.round(x * 1e6) / 1e6; }

export function build(outPath) {
  const m = new ModelBuilder('Project Falcon — Sell-Side LBO & Returns', 'ma_lbo');

  // ---------------------------------------------------------------------------
  // Timeline: entry year (close) through 5-year hold to exit.
  // ---------------------------------------------------------------------------
  const years = [2025, 2026, 2027, 2028, 2029, 2030]; // close .. exit (5yr hold)
  const nY = years.length;
  const exitIdx = nY - 1;
  const holdYears = years[exitIdx] - years[0]; // 5

  // ---------------------------------------------------------------------------
  // Deal Inputs (drivers). These are the levers; the ones we defineName() are
  // actually read by formulas downstream so they surface as named-inputs.
  // ---------------------------------------------------------------------------
  const entryRevenue   = 80_000_000;  // LTM revenue at close
  const revGrowth      = 0.07;        // annual organic growth
  const ebitdaMargin   = 0.25;        // EBITDA % of revenue (held flat)
  const purchaseMult   = 9.5;         // entry EV / LTM EBITDA
  const exitMult       = 11.0;        // exit EV / exit EBITDA
  const seniorTurns    = 3.5;         // senior debt = turns x entry EBITDA
  const mezzTurns      = 1.5;         // mezzanine debt = turns x entry EBITDA
  const txnFeesPct     = 0.025;       // transaction fees as % of entry EV
  const seniorAmortPct = 0.10;        // senior debt annual mandatory amortization
  const seniorRate     = 0.085;       // senior cash interest
  const mezzRate       = 0.115;       // mezzanine cash interest (no amort, bullet)

  const di = m.sheet('Deal Inputs');
  di.label('A1', 'Project Falcon — Deal Inputs (synthetic)');
  di.label('A3', 'LTM Revenue at Close ($)');     di.value('B3', entryRevenue);
  di.label('A4', 'Revenue Growth (annual)');      di.value('B4', revGrowth);
  di.label('A5', 'EBITDA Margin (% of revenue)'); di.value('B5', ebitdaMargin);
  di.label('A6', 'Purchase Multiple (EV/EBITDA)');di.value('B6', purchaseMult);
  di.label('A7', 'Exit Multiple (EV/EBITDA)');    di.value('B7', exitMult);
  di.label('A8', 'Senior Debt (x EBITDA)');       di.value('B8', seniorTurns);
  di.label('A9', 'Mezzanine Debt (x EBITDA)');    di.value('B9', mezzTurns);
  di.label('A10', 'Transaction Fees (% of EV)');  di.value('B10', txnFeesPct);
  di.label('A11', 'Senior Amortization (% / yr)');di.value('B11', seniorAmortPct);
  di.label('A12', 'Senior Interest Rate');        di.value('B12', seniorRate);
  di.label('A13', 'Mezzanine Interest Rate');     di.value('B13', mezzRate);

  // Defined names → named-inputs levers. Each is read by a formula below.
  m.defineName('PurchaseMultiple', 'Deal Inputs', 'B6');
  m.defineName('ExitMultiple', 'Deal Inputs', 'B7');
  m.defineName('RevenueGrowth', 'Deal Inputs', 'B4');
  m.defineName('SeniorLeverage', 'Deal Inputs', 'B8');

  // ---------------------------------------------------------------------------
  // Operating Model (P&L). Time across columns; revenue rolls off prior column.
  // ---------------------------------------------------------------------------
  const rev = growth(entryRevenue, revGrowth, nY).map(r2);
  const ebitda = rev.map(v => r2(v * ebitdaMargin));
  const entryEbitda = ebitda[0];
  const exitEbitda = ebitda[exitIdx];

  const op = m.sheet('Operating Model');
  op.label('A1', 'Operating Model ($)');
  op.label('A2', 'Fiscal Year'); op.valueRow('B2', years);
  op.label('A3', 'Revenue');
  op.value('B3', rev[0]); // close-year literal
  // C3 = B3*(1+growth); D3 = C3*(1+growth); ... prior column, same row
  op.formulaRow('C3', rev.slice(1), (i, colL) => `${colLetter(2 + i)}3*(1+'Deal Inputs'!$B$4)`);
  op.label('A4', 'EBITDA');
  op.formulaRow('B4', ebitda, (i, colL) => `${colL}3*'Deal Inputs'!$B$5`);

  // ---------------------------------------------------------------------------
  // Sources & Uses (at close). Uses: purchase EV + fees. Sources: senior +
  // mezz + sponsor equity (the plug). All reference Deal Inputs / entry EBITDA.
  // ---------------------------------------------------------------------------
  const entryEV   = r2(entryEbitda * purchaseMult);
  const seniorDebt0 = r2(entryEbitda * seniorTurns);
  const mezzDebt0   = r2(entryEbitda * mezzTurns);
  const txnFees     = r2(entryEV * txnFeesPct);
  const totalUses   = r2(entryEV + txnFees);
  const sponsorEquity = r2(totalUses - seniorDebt0 - mezzDebt0); // equity plug

  const su = m.sheet('Sources & Uses');
  su.label('A1', 'Sources & Uses at Close ($)');
  // pull entry EBITDA from the operating model
  su.label('A3', 'Entry EBITDA (LTM)');     su.formula('B3', `'Operating Model'!B4`, entryEbitda);
  su.label('A5', 'USES');
  su.label('A6', 'Purchase Enterprise Value'); su.formula('B6', `B3*'Deal Inputs'!$B$6`, entryEV);
  su.label('A7', 'Transaction Fees');          su.formula('B7', `B6*'Deal Inputs'!$B$10`, txnFees);
  su.label('A8', 'Total Uses');                su.formula('B8', `B6+B7`, totalUses);
  su.label('A10', 'SOURCES');
  su.label('A11', 'Senior Debt');     su.formula('B11', `B3*'Deal Inputs'!$B$8`, seniorDebt0);
  su.label('A12', 'Mezzanine Debt');  su.formula('B12', `B3*'Deal Inputs'!$B$9`, mezzDebt0);
  su.label('A13', 'Sponsor Equity');  su.formula('B13', `B8-B11-B12`, sponsorEquity);
  su.label('A14', 'Total Sources');   su.formula('B14', `B11+B12+B13`, r2(seniorDebt0 + mezzDebt0 + sponsorEquity));

  // ---------------------------------------------------------------------------
  // Debt Schedule. Senior amortizes a fixed % of the ORIGINAL balance each year;
  // mezzanine is a bullet (no amort) until exit. Closing balance rolls off the
  // prior column (same row) minus this year's scheduled paydown.
  //   Senior closing[t] = Senior closing[t-1] - SeniorAmort[t]
  // ---------------------------------------------------------------------------
  const seniorAmortAnnual = r2(seniorDebt0 * seniorAmortPct); // fixed $ amort
  const seniorAmort = years.map((_, i) => (i === 0 ? 0 : seniorAmortAnnual));
  const seniorClose = [];
  {
    let bal = seniorDebt0;
    years.forEach((_, i) => { if (i > 0) bal = r2(bal - seniorAmortAnnual); seniorClose.push(bal); });
  }
  const mezzClose = years.map(() => mezzDebt0); // bullet
  const totalDebtClose = years.map((_, i) => r2(seniorClose[i] + mezzClose[i]));

  const ds = m.sheet('Debt Schedule');
  ds.label('A1', 'Debt Schedule ($)');
  ds.label('A2', 'Fiscal Year'); ds.valueRow('B2', years);

  // Senior amortization (fixed $ off the opening senior balance)
  ds.label('A3', 'Senior Scheduled Amort');
  ds.value('B3', 0); // no amort in close year
  ds.formulaRow('C3', seniorAmort.slice(1), () => `'Sources & Uses'!$B$11*'Deal Inputs'!$B$11`);

  // Senior closing balance: opening = S&U senior; then prior column - this amort
  ds.label('A4', 'Senior Debt (closing)');
  ds.formula('B4', `'Sources & Uses'!B11`, seniorClose[0]);
  ds.formulaRow('C4', seniorClose.slice(1), (i, colL) => `${colLetter(2 + i)}4-${colL}3`);

  // Mezzanine closing balance: bullet, carries prior column forward unchanged
  ds.label('A5', 'Mezzanine Debt (closing)');
  ds.formula('B5', `'Sources & Uses'!B12`, mezzClose[0]);
  ds.formulaRow('C5', mezzClose.slice(1), (i) => `${colLetter(2 + i)}5`);

  // Total net debt (closing) = senior + mezz, this column
  ds.label('A6', 'Total Net Debt (closing)');
  ds.formulaRow('B6', totalDebtClose, (i, colL) => `${colL}4+${colL}5`);

  // ---------------------------------------------------------------------------
  // Returns / Sponsor Cheat Sheet. Exit EV from exit EBITDA x exit multiple,
  // less net debt at exit = sponsor exit equity. MOIC + IRR vs sponsor equity in.
  // ---------------------------------------------------------------------------
  const exitEV       = r2(exitEbitda * exitMult);
  const exitNetDebt  = totalDebtClose[exitIdx];
  const exitEquity   = r2(exitEV - exitNetDebt);
  const grossMOIC    = r6(exitEquity / sponsorEquity);
  const grossIRR     = r6(Math.pow(exitEquity / sponsorEquity, 1 / holdYears) - 1);
  const exitCol      = colLetter(2 + exitIdx);

  const rs = m.sheet('Returns Cheat Sheet');
  rs.label('A1', 'Sponsor Returns — Cheat Sheet');
  rs.label('A3', 'Sponsor Equity Invested'); rs.formula('B3', `'Sources & Uses'!B13`, sponsorEquity);
  rs.label('A5', 'Exit EBITDA');             rs.formula('B5', `'Operating Model'!${exitCol}4`, exitEbitda);
  rs.label('A6', 'Exit Multiple (EV/EBITDA)'); rs.formula('B6', `'Deal Inputs'!$B$7`, exitMult);
  rs.label('A7', 'Exit Enterprise Value');   rs.formula('B7', `B5*B6`, exitEV);
  rs.label('A8', 'Net Debt at Exit');        rs.formula('B8', `'Debt Schedule'!${exitCol}6`, exitNetDebt);
  rs.label('A9', 'Sponsor Exit Equity');     rs.formula('B9', `B7-B8`, exitEquity);
  rs.label('A11', 'Hold Period (years)');    rs.value('B11', holdYears);
  rs.label('A12', 'Gross MOIC');             rs.formula('B12', `B9/B3`, grossMOIC);
  rs.label('A13', 'Gross IRR');              rs.formula('B13', `(B9/B3)^(1/B11)-1`, grossIRR);

  m.write(outPath);
  return {
    outPath,
    expected: {
      entryEbitda, entryEV, sponsorEquity, exitEbitda, exitEV,
      exitNetDebt, exitEquity, grossMOIC, grossIRR, exitMult,
    },
  };
}

// CLI entry
if (process.argv[1]?.endsWith('ma-sellside-analyst.mjs')) {
  const out = process.argv[2] || 'engines/_personas/ma-sellside-analyst/model.xlsx';
  const res = build(out);
  console.log('Wrote', res.outPath);
  console.log('Expected:', JSON.stringify(res.expected, null, 2));
}

export default build;

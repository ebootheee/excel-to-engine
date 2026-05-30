/**
 * realestate-debt-cfo.mjs — synthetic STABILIZED real-estate portfolio model
 * from the PORTFOLIO CFO lens (real-estate DEBT / leverage focus).
 *
 * All data is synthetic. This is the CFO's "how is the levered portfolio
 * holding up" view across a 10-year hold of three stabilized assets:
 *   - NOI build per property (each grows off the PRIOR COLUMN at its own rate),
 *     plus a Consolidated NOI row that sums the three properties.
 *   - A single senior debt FACILITY against the whole portfolio: one balance
 *     row rolling forward (closing = prior-column closing − this-year principal
 *     amortization), interest = facility rate × PRIOR-column (opening) balance,
 *     and total debt service = interest + amortization.
 *   - Credit metrics tracked per year: DSCR (= consolidated NOI / debt service),
 *     LTV (= debt balance / portfolio value), debt yield (= NOI / debt balance).
 *   - A CFO summary: portfolio value (terminal), total debt at exit, and the
 *     average DSCR across the hold.
 *
 * Layout rule honored throughout: time runs across COLUMNS, each metric is its
 * own ROW, and every roll-forward references the PRIOR COLUMN / SAME ROW (never
 * a later row on the same sheet — the row-major engine would read that as 0).
 *
 * Headline metrics this surfaces: terminalValue, exitDebt.
 *
 * Run standalone:
 *   node realestate-debt-cfo.mjs <out.xlsx>
 *
 * @license MIT
 */
import { ModelBuilder, colLetter, growth, r2 } from '../lib/model-builder.mjs';

/** Round derived ratios so the cached value reproduces engine.run() exactly. */
function r6(x) { return Math.round(x * 1e6) / 1e6; }

export function build(outPath) {
  const m = new ModelBuilder('Harbor Point Portfolio — Stabilized RE Debt Monitor (CFO View)', 'real_estate_debt');

  // ── Timeline ───────────────────────────────────────────────────────────────
  // 10-year hold. Year 0 (2025) is the acquisition / stabilized base year.
  const years = [2025, 2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034];
  const nY = years.length;            // 10 columns
  const exitIdx = nY - 1;             // last column = exit / disposition year
  const holdYears = years[exitIdx] - years[0]; // 9
  // Year i lives in column (2 + i): B=year0, C=year1, ...
  const col = (i) => colLetter(2 + i);

  // ── Portfolio assumptions (the CFO's levers) ─────────────────────────────────
  const facilityRate   = 0.0525;   // senior facility all-in interest rate
  const annualAmort    = 1_400_000; // level annual principal amortization ($)
  const exitCapRate    = 0.0625;   // portfolio exit cap rate (NOI / cap = value)
  const valueGrowth    = 0.025;    // annual stabilized property value appreciation

  // Per-property year-0 NOI and stabilized NOI growth.
  const props = [
    { name: 'Harbor Tower (Office)',     noi0: 6_200_000, growth: 0.020 },
    { name: 'Pier 9 Logistics (Indus.)', noi0: 4_800_000, growth: 0.035 },
    { name: 'Marina Flats (Multifam.)',  noi0: 3_500_000, growth: 0.030 },
  ];

  // Property values at acquisition (year 0) — implies entry cap rates per asset.
  const propValue0 = [108_000_000, 82_000_000, 64_000_000]; // total = 254,000,000
  const totalValue0 = propValue0.reduce((a, b) => a + b, 0);

  // ── Compute everything in JS first (then place formulas + cached values) ─────

  // Per-property NOI series (each grows off prior column at its own rate).
  const propNOI = props.map(p => growth(p.noi0, p.growth, nY).map(r2));
  // Consolidated NOI = sum of the three property NOI rows, per year.
  const consNOI = years.map((_, i) => r2(propNOI.reduce((a, s) => a + s[i], 0)));

  // Portfolio value path: total year-0 value compounding at valueGrowth.
  const portValue = growth(totalValue0, valueGrowth, nY).map(r2);

  // Senior facility sizing: 60% of year-0 portfolio value.
  const entryLTV = 0.60;
  const loanAmount = r2(totalValue0 * entryLTV); // 152,400,000

  // Debt balance (closing) per year: prior-column closing − this-year amort.
  // Year 0 closing = full draw (loanAmount). amort applies years 1..exit.
  const debtClose = [];
  debtClose[0] = loanAmount;
  for (let i = 1; i < nY; i++) debtClose[i] = r2(debtClose[i - 1] - annualAmort);

  // Interest on the OPENING (prior-column closing) balance at the facility rate.
  // Year 0 = no interest yet (just funded). Year i opens at debtClose[i-1].
  const interest = [];
  interest[0] = 0;
  for (let i = 1; i < nY; i++) interest[i] = r2(debtClose[i - 1] * facilityRate);

  // Total debt service = interest + scheduled amortization (amort starts yr 1).
  const debtService = years.map((_, i) => (i === 0 ? 0 : r2(interest[i] + annualAmort)));

  // Credit metrics (years 1..exit; year 0 has no debt service so DSCR is n/a→0).
  const dscr = years.map((_, i) => (i === 0 ? 0 : r6(consNOI[i] / debtService[i])));
  const ltv = years.map((_, i) => r6(debtClose[i] / portValue[i]));
  const debtYield = years.map((_, i) => r6(consNOI[i] / debtClose[i]));

  // Exit / summary figures.
  const stabilizedExitNOI = consNOI[exitIdx];
  const terminalValue = r2(stabilizedExitNOI / exitCapRate); // exit value via cap rate
  const exitDebt = debtClose[exitIdx];
  const netEquityAtExit = r2(terminalValue - exitDebt);
  // Average DSCR across the operating years (years 1..exit).
  const dscrOps = dscr.slice(1);
  const avgDSCR = r6(dscrOps.reduce((a, v) => a + v, 0) / dscrOps.length);
  const exitLTV = r6(exitDebt / terminalValue);

  // ===========================================================================
  // Sheet 1 — Portfolio Assumptions (drivers + defined names)
  // ===========================================================================
  const a = m.sheet('Portfolio Assumptions');
  a.label('A1', 'Harbor Point Portfolio — Key Assumptions (all figures synthetic)');
  a.label('A3', 'Senior Facility Interest Rate');        a.value('B3', facilityRate);
  a.label('A4', 'Annual Principal Amortization ($)');    a.value('B4', annualAmort);
  a.label('A5', 'Exit Cap Rate');                        a.value('B5', exitCapRate);
  a.label('A6', 'Property Value Growth (annual)');       a.value('B6', valueGrowth);
  a.label('A7', 'Entry LTV (facility sizing)');          a.value('B7', entryLTV);

  a.label('A9', 'Year-0 Portfolio Value ($)');
  a.formula('B9', `'NOI by Property'!B8`, totalValue0); // pulled from value row (see below)
  a.label('A10', 'Senior Facility — Initial Draw ($)');
  a.formula('B10', `B9*B7`, loanAmount);

  // Defined names → become the app levers in named-inputs.json. Each is an
  // input cell the formulas below actually read.
  m.defineName('FacilityRate', 'Portfolio Assumptions', 'B3');
  m.defineName('AnnualAmortization', 'Portfolio Assumptions', 'B4');
  m.defineName('ExitCapRate', 'Portfolio Assumptions', 'B5');
  m.defineName('PropertyValueGrowth', 'Portfolio Assumptions', 'B6');

  // ===========================================================================
  // Sheet 2 — NOI by Property (per-property NOI + consolidated NOI + value)
  // Rows: 3=Year, 4/5/6=property NOI, 7=Consolidated NOI, 8=Portfolio Value
  // ===========================================================================
  const noiS = m.sheet('NOI by Property');
  noiS.label('A1', 'Net Operating Income by Property ($)');
  noiS.label('A3', 'Year'); noiS.valueRow('B3', years);

  // Each property: year-0 literal, later years = prior column * (1 + own growth).
  const propRows = [4, 5, 6];
  props.forEach((p, pi) => {
    const row = propRows[pi];
    noiS.label(`A${row}`, p.name);
    noiS.value(`B${row}`, propNOI[pi][0]);
    // C..K = prior column * (1 + growth). growth rate embedded as literal so the
    // three properties can each grow at their own rate (no per-property lever).
    noiS.formulaRow(`C${row}`, propNOI[pi].slice(1),
      (i, colL) => `${colLetter(2 + i)}${row}*(1+${p.growth})`);
  });

  // Consolidated NOI = sum of the three property rows (this column).
  noiS.label('A7', 'Consolidated NOI');
  noiS.formulaRow('B7', consNOI, (i, colL) => `SUM(${colL}4:${colL}6)`);

  // Portfolio Value: year-0 literal, later years grow at PropertyValueGrowth.
  noiS.label('A8', 'Portfolio Value ($)');
  noiS.value('B8', portValue[0]);
  noiS.formulaRow('C8', portValue.slice(1),
    (i, colL) => `${colLetter(2 + i)}8*(1+'Portfolio Assumptions'!$B$6)`);

  // ===========================================================================
  // Sheet 3 — Senior Debt Facility (single balance roll-forward)
  // Rows: 3=Year, 4=Opening note, 5=Amortization, 6=Closing balance,
  //       7=Interest, 8=Total debt service
  // ===========================================================================
  const dbt = m.sheet('Senior Debt Facility');
  dbt.label('A1', 'Senior Debt Facility — Balance Roll-Forward ($)');
  dbt.label('A3', 'Year'); dbt.valueRow('B3', years);

  // Scheduled amortization: 0 at acquisition, then level amort each year.
  dbt.label('A4', 'Scheduled Principal Amortization');
  dbt.value('B4', 0);
  dbt.formulaRow('C4', new Array(nY - 1).fill(annualAmort),
    () => `'Portfolio Assumptions'!$B$4`);

  // Closing balance: B5 = initial draw; C5 = B5 - C4; D5 = C5 - D4; ...
  dbt.label('A5', 'Facility Balance — Closing');
  dbt.formula('B5', `'Portfolio Assumptions'!B10`, debtClose[0]);
  dbt.formulaRow('C5', debtClose.slice(1), (i, colL) => `${colLetter(2 + i)}5-${colL}4`);

  // Interest expense on the OPENING (prior-column closing) balance at the rate.
  // Year 0 = 0 (just funded). Year i interest = prior column closing * rate.
  dbt.label('A6', 'Interest Expense');
  dbt.value('B6', 0);
  dbt.formulaRow('C6', interest.slice(1),
    (i, colL) => `${colLetter(2 + i)}5*'Portfolio Assumptions'!$B$3`);

  // Total debt service = interest + amortization (this column).
  dbt.label('A7', 'Total Debt Service');
  dbt.formulaRow('B7', debtService, (i, colL) => `${colL}6+${colL}4`);

  // ===========================================================================
  // Sheet 4 — Credit Metrics (DSCR, LTV, Debt Yield) per year
  // Rows: 3=Year, 4=Consolidated NOI (ref), 5=Debt Service (ref),
  //       6=DSCR, 7=Debt Balance (ref), 8=Portfolio Value (ref),
  //       9=LTV, 10=Debt Yield
  // ===========================================================================
  const cm = m.sheet('Credit Metrics');
  cm.label('A1', 'Portfolio Credit & Coverage Metrics');
  cm.label('A3', 'Year'); cm.valueRow('B3', years);

  cm.label('A4', 'Consolidated NOI');
  cm.formulaRow('B4', consNOI, (i, colL) => `'NOI by Property'!${colL}7`);

  cm.label('A5', 'Total Debt Service');
  cm.formulaRow('B5', debtService, (i, colL) => `'Senior Debt Facility'!${colL}7`);

  // DSCR = NOI / debt service. Year 0 has no debt service → report 0 (avoid /0).
  cm.label('A6', 'DSCR (NOI / Debt Service)');
  cm.value('B6', 0);
  cm.formulaRow('C6', dscr.slice(1), (i, colL) => `${colL}4/${colL}5`);

  cm.label('A7', 'Facility Balance — Closing');
  cm.formulaRow('B7', debtClose, (i, colL) => `'Senior Debt Facility'!${colL}5`);

  cm.label('A8', 'Portfolio Value');
  cm.formulaRow('B8', portValue, (i, colL) => `'NOI by Property'!${colL}8`);

  // LTV = debt balance / portfolio value.
  cm.label('A9', 'LTV (Debt / Value)');
  cm.formulaRow('B9', ltv, (i, colL) => `${colL}7/${colL}8`);

  // Debt yield = NOI / debt balance.
  cm.label('A10', 'Debt Yield (NOI / Debt)');
  cm.formulaRow('B10', debtYield, (i, colL) => `${colL}4/${colL}7`);

  // ===========================================================================
  // Sheet 5 — CFO Cheat Sheet (portfolio value, total debt at exit, avg DSCR)
  // ===========================================================================
  const s = m.sheet('CFO Cheat Sheet');
  s.label('A1', 'Portfolio Debt Monitor — CFO Cheat Sheet');

  s.label('A3', 'Hold Period (years)');             s.value('B3', holdYears);
  s.label('A4', 'Year-0 Portfolio Value');          s.formula('B4', `'NOI by Property'!B8`, portValue[0]);
  s.label('A5', 'Initial Senior Facility Draw');     s.formula('B5', `'Senior Debt Facility'!B5`, loanAmount);
  s.label('A6', 'Entry LTV');                        s.formula('B6', `B5/B4`, r6(loanAmount / portValue[0]));

  s.label('A8', 'Stabilized Exit-Year NOI');
  s.formula('B8', `'NOI by Property'!${col(exitIdx)}7`, stabilizedExitNOI);
  s.label('A9', 'Exit Cap Rate');
  s.formula('B9', `'Portfolio Assumptions'!B5`, exitCapRate);
  s.label('A10', 'Portfolio Value at Exit (Terminal Value)');
  s.formula('B10', `B8/'Portfolio Assumptions'!$B$5`, terminalValue);
  s.label('A11', 'Total Debt at Exit');
  s.formula('B11', `'Senior Debt Facility'!${col(exitIdx)}5`, exitDebt);
  s.label('A12', 'Net Equity at Exit');
  s.formula('B12', `B10-B11`, netEquityAtExit);
  s.label('A13', 'Exit LTV');
  s.formula('B13', `B11/B10`, exitLTV);

  s.label('A15', 'Average DSCR (operating years)');
  s.formula('B15', `AVERAGE('Credit Metrics'!${col(1)}6:${col(exitIdx)}6)`, avgDSCR);
  s.label('A16', 'Entry DSCR');
  s.formula('B16', `'Credit Metrics'!${col(1)}6`, dscr[1]);
  s.label('A17', 'Exit DSCR');
  s.formula('B17', `'Credit Metrics'!${col(exitIdx)}6`, dscr[exitIdx]);
  s.label('A18', 'Exit Debt Yield');
  s.formula('B18', `'Credit Metrics'!${col(exitIdx)}10`, debtYield[exitIdx]);

  m.write(outPath);
  return {
    outPath,
    expected: {
      totalValue0, loanAmount, stabilizedExitNOI,
      terminalValue, exitDebt, netEquityAtExit, avgDSCR, exitLTV,
    },
  };
}

// CLI entry
if (process.argv[1] && process.argv[1].endsWith('realestate-debt-cfo.mjs')) {
  const out = process.argv[2] || 'engines/_personas/realestate-debt-cfo/model.xlsx';
  const res = build(out);
  console.log('Wrote', res.outPath);
  console.log('Expected:', JSON.stringify(res.expected, null, 2));
}

export default build;

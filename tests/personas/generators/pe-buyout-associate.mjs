/**
 * Persona generator: pe-buyout-associate
 *
 * A realistic mid-market LBO model for a PE associate who wants to turn the
 * model into an explorable web app for LPs. All data is SYNTHETIC.
 *
 * Structure (standard analyst layout: time across COLUMNS, metrics as ROWS):
 *   - "Deal Assumptions" : entry/exit EV/EBITDA multiple, leverage (LTV),
 *                          revenue growth, COGS %, opex %, pref, carry %
 *   - "Operating Model"  : Revenue -> COGS -> Gross Profit -> Opex -> EBITDA
 *   - "Senior Facility"  : single senior debt balance row, prior-column
 *                          roll-forward minus scheduled amortization
 *   - "Returns"          : entry equity, exit EV, exit net debt, exit equity,
 *                          gross MOIC, gross IRR, GP carried interest ($)
 *
 * Headline metrics surfaced: grossMOIC, grossIRR, exitMultiple, totalCarry.
 *
 * Defined names (become app levers / named-inputs.json):
 *   ExitMultiple, RevenueGrowth, Leverage
 *
 * Run standalone:
 *   node pe-buyout-associate.mjs <out.xlsx>
 *
 * @license MIT
 */
import { ModelBuilder, colLetter, growth, r2 } from '../lib/model-builder.mjs';

// Ratio cells (MOIC / IRR) are stored at FULL float precision — NOT rounded.
// Rounding the cached value (e.g. to 6 dp) introduces a ~1e-7 gap vs the value
// engine.run() computes from the unrounded inputs, which trips the strict
// display-time drift check in example.mjs (verifyEngine's looser relTol passes
// it, but it's free to make both green). The dollar P&L/debt series stay
// r2()-rounded because the formulas multiply already-rounded inputs.

export function build(outPath) {
  const m = new ModelBuilder('Project Meridian — Mid-Market LBO', 'pe_buyout');

  // --- timeline: 6-year hold (entry .. exit) ---
  const years = [2025, 2026, 2027, 2028, 2029, 2030];
  const nY = years.length;
  const exitIdx = nY - 1;
  const holdYears = years[exitIdx] - years[0]; // 5

  // --- driver assumptions ---
  const entryMultiple = 9.5;   // entry EV / EBITDA
  const exitMultiple = 11.0;   // exit EV / EBITDA
  const revGrowth = 0.07;      // annual revenue growth
  const cogsPct = 0.52;        // COGS as % of revenue
  const opexPct = 0.26;        // operating expense as % of revenue
  const leverage = 0.58;       // acquisition leverage (LTV on entry EV)
  const prefRate = 0.08;       // LP preferred return (hurdle)
  const carryPct = 0.20;       // GP carried interest %

  // -----------------------------------------------------------------------
  // Sheet 1: Deal Assumptions (drivers)
  // -----------------------------------------------------------------------
  const a = m.sheet('Deal Assumptions');
  a.label('A1', 'Project Meridian — Deal Assumptions');
  a.label('A3', 'Entry EV / EBITDA Multiple');   a.value('B3', entryMultiple);
  a.label('A4', 'Exit EV / EBITDA Multiple');     a.value('B4', exitMultiple);
  a.label('A5', 'Revenue Growth (annual)');       a.value('B5', revGrowth);
  a.label('A6', 'COGS (% of revenue)');           a.value('B6', cogsPct);
  a.label('A7', 'Operating Expense (% of rev)');  a.value('B7', opexPct);
  a.label('A8', 'Acquisition Leverage (LTV)');    a.value('B8', leverage);
  a.label('A9', 'LP Preferred Return');           a.value('B9', prefRate);
  a.label('A10', 'GP Carry %');                   a.value('B10', carryPct);

  // Defined names — the app levers. Each maps to an input cell the formulas read.
  m.defineName('ExitMultiple', 'Deal Assumptions', 'B4');
  m.defineName('RevenueGrowth', 'Deal Assumptions', 'B5');
  m.defineName('Leverage', 'Deal Assumptions', 'B8');

  // -----------------------------------------------------------------------
  // Sheet 2: Operating Model (annual P&L)
  // Compute the full series in JS first, then place formula + cached value.
  // -----------------------------------------------------------------------
  const revenue = growth(85_000_000, revGrowth, nY).map(r2);
  const cogs = revenue.map(v => r2(v * cogsPct));
  const grossProfit = revenue.map((v, i) => r2(v - cogs[i]));
  const opex = revenue.map(v => r2(v * opexPct));
  const ebitda = grossProfit.map((v, i) => r2(v - opex[i]));

  const p = m.sheet('Operating Model');
  p.label('A1', 'Operating Model ($)');
  p.label('A2', 'Fiscal Year'); p.valueRow('B2', years);

  // Revenue: year 1 is a literal input; subsequent grow off PRIOR COLUMN.
  p.label('A3', 'Revenue');
  p.value('B3', revenue[0]);
  p.formulaRow('C3', revenue.slice(1), (i, colL) => {
    // colL is the current column (C, D, ...); prior column is one left.
    const cur = colToNum(colL);
    return `${colLetter(cur - 1)}3*(1+'Deal Assumptions'!$B$5)`;
  });

  // COGS = revenue (same column) * cogs %
  p.label('A4', 'COGS');
  p.formulaRow('B4', cogs, (i, colL) => `${colL}3*'Deal Assumptions'!$B$6`);

  // Gross Profit = revenue - COGS (same column, earlier rows)
  p.label('A5', 'Gross Profit');
  p.formulaRow('B5', grossProfit, (i, colL) => `${colL}3-${colL}4`);

  // Operating Expenses = revenue * opex %
  p.label('A6', 'Operating Expenses');
  p.formulaRow('B6', opex, (i, colL) => `${colL}3*'Deal Assumptions'!$B$7`);

  // EBITDA = gross profit - opex
  p.label('A7', 'EBITDA');
  p.formulaRow('B7', ebitda, (i, colL) => `${colL}5-${colL}6`);

  // -----------------------------------------------------------------------
  // Sheet 3: Senior Facility (single debt balance row, prior-column roll)
  // -----------------------------------------------------------------------
  const entryEbitda = ebitda[0];
  const entryEV = r2(entryEbitda * entryMultiple);
  const entryDebt = r2(entryEV * leverage);
  const entryEquity = r2(entryEV - entryDebt);

  // Scheduled amortization: cash sweep pays down ~$8M/yr after year 1.
  const annualPaydown = 8_000_000;
  const debtBalance = years.map((_, i) => r2(Math.max(0, entryDebt - annualPaydown * i)));

  const d = m.sheet('Senior Facility');
  d.label('A1', 'Senior Debt Facility ($)');
  d.label('A2', 'Fiscal Year'); d.valueRow('B2', years);
  d.label('A3', 'Scheduled Amortization');
  d.valueRow('B3', years.map((_, i) => (i === 0 ? 0 : annualPaydown)));
  d.label('A4', 'Senior Debt Balance');
  // Entry balance = entry EBITDA * entry multiple * leverage. Written as a
  // FORMULA (not a literal) so the Leverage defined-name cell is actually read
  // by a formula — otherwise the input-cell detector drops it (refCount === 0)
  // and it never becomes an app lever in named-inputs.json.
  d.formula('B4', `'Operating Model'!B7*'Deal Assumptions'!$B$3*'Deal Assumptions'!$B$8`, entryDebt);
  // C4 = B4 - C3 ; D4 = C4 - D3 ; ... prior-column balance minus this year's amort.
  d.formulaRow('C4', debtBalance.slice(1), (i, colL) => {
    const cur = colToNum(colL);
    return `${colLetter(cur - 1)}4-${colL}3`;
  });

  // -----------------------------------------------------------------------
  // Sheet 4: Returns (IC summary)
  // -----------------------------------------------------------------------
  const exitEbitda = ebitda[exitIdx];
  const exitEV = r2(exitEbitda * exitMultiple);
  const exitNetDebt = debtBalance[exitIdx];
  const exitEquity = r2(exitEV - exitNetDebt);

  // Ratios: store EXACT arithmetic of the cached inputs so engine.run() matches
  // to full precision (no rounding — see note at top).
  const grossMOIC = exitEquity / entryEquity;
  const grossIRR = Math.pow(exitEquity / entryEquity, 1 / holdYears) - 1;
  const prefHurdle = r2(entryEquity * Math.pow(1 + prefRate, holdYears));
  const profitAbovePref = Math.max(0, exitEquity - prefHurdle);
  const gpCarry = r2(profitAbovePref * carryPct);

  const exitCol = colLetter(2 + exitIdx); // column for the exit year

  const s = m.sheet('Returns');
  s.label('A1', 'Investment Returns Summary');

  s.label('A3', 'Entry EBITDA');
  s.formula('B3', `'Operating Model'!B7`, entryEbitda);
  s.label('A4', 'Entry Enterprise Value');
  s.formula('B4', `B3*'Deal Assumptions'!$B$3`, entryEV);
  s.label('A5', 'Entry Net Debt');
  s.formula('B5', `'Senior Facility'!B4`, entryDebt);
  // Equity Invested — matches the equity detector (/equity.*invested/) and is
  // the basis cell that grossMOIC / grossIRR are searched near.
  s.label('A6', 'Equity Invested');
  s.formula('B6', `B4-B5`, entryEquity);

  s.label('A8', 'Exit EBITDA');
  s.formula('B8', `'Operating Model'!${exitCol}7`, exitEbitda);
  s.label('A9', 'Exit Enterprise Value');
  s.formula('B9', `B8*'Deal Assumptions'!$B$4`, exitEV);
  s.label('A10', 'Exit Net Debt');
  s.formula('B10', `'Senior Facility'!${exitCol}4`, exitNetDebt);
  s.label('A11', 'Exit Equity Value');
  s.formula('B11', `B9-B10`, exitEquity);

  s.label('A13', 'Gross MOIC');
  s.formula('B13', `B11/B6`, grossMOIC);
  s.label('A14', 'Gross IRR');
  s.formula('B14', `(B11/B6)^(1/${holdYears})-1`, grossIRR);
  s.label('A15', 'Hold Period (years)');
  s.value('B15', holdYears);

  s.label('A17', 'LP Preferred Hurdle Value');
  s.formula('B17', `B6*(1+'Deal Assumptions'!$B$9)^${holdYears}`, prefHurdle);
  // "GP Carried Interest" matches /gp.*carried/ and avoids the disqualifiers
  // (profit/capital/equity/fee); the value is dollarish (>=1000).
  s.label('A18', 'GP Carried Interest');
  s.formula('B18', `MAX(0,B11-B17)*'Deal Assumptions'!$B$10`, gpCarry);

  m.write(outPath);
  return {
    outPath,
    expected: {
      entryEquity, exitEquity, grossMOIC, grossIRR, gpCarry,
      exitMultiple, entryEV, exitEV, exitNetDebt,
    },
  };
}

/** A1 column letter -> 1-based index (A=1). Local to avoid extra imports. */
function colToNum(letter) {
  let n = 0;
  for (const ch of letter.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

// CLI entry
if (process.argv[1]?.endsWith('pe-buyout-associate.mjs')) {
  const out = process.argv[2] || 'engines/_personas/pe-buyout-associate/model.xlsx';
  const res = build(out);
  console.log('Wrote', res.outPath);
  console.log('Expected:', JSON.stringify(res.expected, null, 2));
}

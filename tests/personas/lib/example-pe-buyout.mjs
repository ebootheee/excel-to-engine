/**
 * Reference generator: a realistic mid-market PE buyout (LBO) model.
 * Synthetic data. Demonstrates the ModelBuilder primitives the persona
 * model-gen agents should follow. Run: node example-pe-buyout.mjs <out.xlsx>
 */
import { ModelBuilder, colLetter, growth, r2 } from './model-builder.mjs';

export function buildPeBuyout(outPath) {
  const m = new ModelBuilder('Project Atlas — Acquisition Model', 'pe_buyout');

  // --- timeline ---
  const years = [2024, 2025, 2026, 2027, 2028, 2029]; // entry .. exit
  const nY = years.length;
  const exitIdx = nY - 1;

  // --- assumptions (drivers) ---
  const entryMultiple = 10, exitMultiple = 12, revGrowth = 0.08;
  const cogsPct = 0.45, opexPct = 0.30, leverage = 0.55, prefRate = 0.08, carryPct = 0.20;

  const a = m.sheet('Assumptions');
  a.label('A1', 'Project Atlas — Key Assumptions');
  a.label('A3', 'Entry EV / EBITDA Multiple'); a.value('B3', entryMultiple);
  a.label('A4', 'Exit EV / EBITDA Multiple');  a.value('B4', exitMultiple);
  a.label('A5', 'Revenue Growth (annual)');    a.value('B5', revGrowth);
  a.label('A6', 'COGS (% of revenue)');        a.value('B6', cogsPct);
  a.label('A7', 'Operating Expense (% of rev)');a.value('B7', opexPct);
  a.label('A8', 'Acquisition Leverage (LTV)'); a.value('B8', leverage);
  a.label('A9', 'Preferred Return (hurdle)');  a.value('B9', prefRate);
  a.label('A10', 'GP Carried Interest');       a.value('B10', carryPct);
  m.defineName('ExitMultiple', 'Assumptions', 'B4');
  m.defineName('RevenueGrowth', 'Assumptions', 'B5');
  m.defineName('AcquisitionLeverage', 'Assumptions', 'B8');

  // --- P&L (annual) ---
  const rev = growth(100_000_000, revGrowth, nY).map(r2);
  const cogs = rev.map(v => r2(v * cogsPct));
  const gp = rev.map((v, i) => r2(v - cogs[i]));
  const opex = rev.map(v => r2(v * opexPct));
  const ebitda = gp.map((v, i) => r2(v - opex[i]));

  const p = m.sheet('P&L');
  p.label('A1', 'Income Statement ($)');
  p.label('A2', 'Year'); p.valueRow('B2', years);
  // Revenue: year 1 literal, subsequent grow off prior * (1+growth)
  p.label('A3', 'Revenue');
  p.value('B3', rev[0]);
  p.formulaRow('C3', rev.slice(1), (i, colL) => {
    const prev = colLetter(3 + i); // B is col2; C3 prev is B3 -> handle generically
    return `${prevCol('C', i)}3*(1+Assumptions!$B$5)`;
  });
  p.label('A4', 'COGS');
  p.formulaRow('B4', cogs, (i) => `${colLetter(2 + i)}3*Assumptions!$B$6`);
  p.label('A5', 'Gross Profit');
  p.formulaRow('B5', gp, (i) => `${colLetter(2 + i)}3-${colLetter(2 + i)}4`);
  p.label('A6', 'Operating Expenses');
  p.formulaRow('B6', opex, (i) => `${colLetter(2 + i)}3*Assumptions!$B$7`);
  p.label('A7', 'EBITDA');
  p.formulaRow('B7', ebitda, (i) => `${colLetter(2 + i)}5-${colLetter(2 + i)}6`);

  // --- Debt schedule ---
  const entryEbitda = ebitda[0];
  const entryEV = r2(entryEbitda * entryMultiple);
  const entryDebt = r2(entryEV * leverage);
  const entryEquity = r2(entryEV - entryDebt);
  const paydown = 10_000_000;
  const debtClose = years.map((_, i) => r2(Math.max(0, entryDebt - paydown * i)));

  // Standard layout: time across columns, metric as a row, roll-forward
  // references the PRIOR COLUMN (same row). This is how real analysts build
  // schedules and it is evaluation-order-safe (no cross-row staircase).
  const d = m.sheet('Debt Schedule');
  d.label('A1', 'Senior Debt ($)');
  d.label('A2', 'Year'); d.valueRow('B2', years);
  d.label('A3', 'Scheduled Paydown');
  d.valueRow('B3', years.map((_, i) => (i === 0 ? 0 : paydown)));
  d.label('A4', 'Debt Balance (closing)');
  d.value('B4', entryDebt);
  // C4 = B4 - C3 ; D4 = C4 - D3 ; ... (prior column balance minus this year's paydown)
  d.formulaRow('C4', debtClose.slice(1), (i, colL) => `${colLetter(2 + i)}4-${colL}3`);

  // --- Returns / IC Summary ---
  const exitEbitda = ebitda[exitIdx];
  const exitEV = r2(exitEbitda * exitMultiple);
  const exitNetDebt = debtClose[exitIdx];
  const exitEquity = r2(exitEV - exitNetDebt);
  const holdYears = years[exitIdx] - years[0];
  // Derived ratios: store EXACT arithmetic of the cached inputs (no rounding),
  // so engine.run() reproduces them to full precision.
  const moic = exitEquity / entryEquity;
  const irr = Math.pow(exitEquity / entryEquity, 1 / holdYears) - 1;
  const prefHurdleValue = r2(entryEquity * Math.pow(1 + prefRate, holdYears));
  const profitAbovePref = r2(Math.max(0, exitEquity - prefHurdleValue));
  const carry = r2(profitAbovePref * carryPct);

  const s = m.sheet('IC Summary');
  s.label('A1', 'Investment Committee — Returns Summary');
  s.label('A3', 'Entry EBITDA');        s.formula('B3', `'P&L'!B7`, entryEbitda);
  s.label('A4', 'Entry EV');            s.formula('B4', `B3*Assumptions!$B$3`, entryEV);
  s.label('A5', 'Entry Net Debt');      s.formula('B5', `'Debt Schedule'!B4`, entryDebt);
  s.label('A6', 'Entry Equity');        s.formula('B6', `B4-B5`, entryEquity);
  s.label('A8', 'Exit EBITDA');         s.formula('B8', `'P&L'!${colLetter(2 + exitIdx)}7`, exitEbitda);
  s.label('A9', 'Exit EV');             s.formula('B9', `B8*Assumptions!$B$4`, exitEV);
  s.label('A10', 'Exit Net Debt');      s.formula('B10', `'Debt Schedule'!${colLetter(2 + exitIdx)}4`, exitNetDebt);
  s.label('A11', 'Exit Equity Value');  s.formula('B11', `B9-B10`, exitEquity);
  s.label('A13', 'Gross MOIC');         s.formula('B13', `B11/B6`, moic);
  s.label('A14', 'Gross IRR');          s.formula('B14', `(B11/B6)^(1/${holdYears})-1`, r2v(irr));
  s.label('A15', 'Hold Period (years)'); s.value('B15', holdYears);
  s.label('A17', 'Preferred Hurdle Value'); s.formula('B17', `B6*(1+Assumptions!$B$9)^${holdYears}`, prefHurdleValue);
  s.label('A18', 'GP Carried Interest'); s.formula('B18', `MAX(0,B11-B17)*Assumptions!$B$10`, carry);

  m.write(outPath);
  return { outPath, expected: { entryEquity, exitEquity, moic, irr: r2v(irr), carry } };
}

// helper: previous column letter for a formulaRow starting at `startCol` (col of index 0 within the row)
function prevCol(startCol, i) {
  const start = startCol.charCodeAt(0) - 64; // assumes single-letter start (C=3)
  // index i is offset within slice; absolute col = start + i; prev = start + i - 1
  return colLetter(start + i - 1);
}
function r2v(x) { return Math.round(x * 1e6) / 1e6; }

// CLI entry
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('example-pe-buyout.mjs')) {
  const out = process.argv[2] || 'engines/_ref/pe-buyout.xlsx';
  const res = buildPeBuyout(out);
  console.log('Wrote', res.outPath);
  console.log('Expected:', JSON.stringify(res.expected));
}

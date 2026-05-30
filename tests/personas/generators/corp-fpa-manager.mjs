/**
 * corp-fpa-manager.mjs — synthetic corporate 3-statement-lite + DCF model.
 *
 * Persona: a corporate FP&A manager. 5-year operating plan with revenue by two
 * segments, gross margin, opex, EBITDA, D&A, EBIT, taxes, net income and free
 * cash flow, plus a DCF valuation tab (discount each FCF at WACC, Gordon-growth
 * terminal value, enterprise value, less net debt = equity value).
 *
 * Headline metrics surfaced: terminalValue, ebitda.
 *
 * All data is synthetic. Run: node corp-fpa-manager.mjs <out.xlsx>
 *
 * Layout rules honored:
 *  - Time runs across COLUMNS (year headers in a row); each metric is its own ROW.
 *  - No cross-row staircase: every formula reads same-row prior columns or
 *    earlier rows on the sheet (row-major safe).
 *  - Every .formula() carries a cachedValue computed in JS with identical math.
 *
 * @license MIT
 */
import { ModelBuilder, colLetter, r2 } from '../lib/model-builder.mjs';

export function build(outPath) {
  const m = new ModelBuilder('Northwind Devices — FY Operating Plan & DCF', 'corporate_3statement');

  // ----------------------------------------------------------------------
  // Timeline: 5 forecast years across columns (B..F on each sheet).
  // ----------------------------------------------------------------------
  const years = [2025, 2026, 2027, 2028, 2029];
  const nY = years.length;
  const lastIdx = nY - 1;
  const col = (i) => colLetter(2 + i); // i=0 -> B, i=1 -> C, ...

  // ----------------------------------------------------------------------
  // Drivers / assumptions
  // ----------------------------------------------------------------------
  const wacc = 0.092;            // discount rate
  const terminalGrowth = 0.025;  // Gordon-growth g
  const taxRate = 0.24;
  const netDebt = 42_000_000;    // current net debt for equity bridge

  // Segment 1: Hardware — larger, slower growth, lower gross margin
  const hwStart = 120_000_000, hwGrowth = 0.06, hwGrossMargin = 0.38;
  // Segment 2: Software/Services — smaller, faster growth, higher gross margin
  const swStart = 40_000_000, swGrowth = 0.18, swGrossMargin = 0.74;

  // Opex (% of total revenue), D&A (% of total revenue)
  const opexPct = 0.22;
  const daPct = 0.05;

  // ----------------------------------------------------------------------
  // JS series — single source of truth for cached values.
  // ----------------------------------------------------------------------
  // Segment revenues (compound growth off prior YEAR, i.e. prior column).
  const hwRev = [];
  const swRev = [];
  for (let i = 0; i < nY; i++) {
    hwRev.push(i === 0 ? hwStart : r2(hwRev[i - 1] * (1 + hwGrowth)));
    swRev.push(i === 0 ? swStart : r2(swRev[i - 1] * (1 + swGrowth)));
  }
  const totalRev = hwRev.map((v, i) => r2(v + swRev[i]));

  // Gross profit per segment, then total gross profit.
  const hwGP = hwRev.map((v) => r2(v * hwGrossMargin));
  const swGP = swRev.map((v) => r2(v * swGrossMargin));
  const grossProfit = hwGP.map((v, i) => r2(v + swGP[i]));

  // Opex, EBITDA.
  const opex = totalRev.map((v) => r2(v * opexPct));
  const ebitda = grossProfit.map((v, i) => r2(v - opex[i]));

  // D&A, EBIT.
  const da = totalRev.map((v) => r2(v * daPct));
  const ebit = ebitda.map((v, i) => r2(v - da[i]));

  // Taxes (on positive EBIT), net income.
  const taxes = ebit.map((v) => r2(Math.max(0, v) * taxRate));
  const netIncome = ebit.map((v, i) => r2(v - taxes[i]));

  // Free cash flow: NI + D&A (lite; no working-capital/capex detail).
  const fcf = netIncome.map((v, i) => r2(v + da[i]));

  // ----------------------------------------------------------------------
  // DCF computations (full precision; cached as-is).
  // ----------------------------------------------------------------------
  // Discount factor for year t (t = 1..nY).
  const discFactor = years.map((_, i) => 1 / Math.pow(1 + wacc, i + 1));
  const pvFcf = fcf.map((v, i) => v * discFactor[i]);
  const sumPvFcf = pvFcf.reduce((a, b) => a + b, 0);

  // Gordon-growth terminal value off the final-year FCF, then discounted back.
  const terminalValue = (fcf[lastIdx] * (1 + terminalGrowth)) / (wacc - terminalGrowth);
  const pvTerminalValue = terminalValue * discFactor[lastIdx];

  const enterpriseValue = sumPvFcf + pvTerminalValue;
  const equityValue = enterpriseValue - netDebt;

  // ======================================================================
  // SHEET: Drivers (assumptions / defined-name inputs)
  // ======================================================================
  const d = m.sheet('Drivers');
  d.label('A1', 'Northwind Devices — Plan Drivers');
  d.label('A3', 'WACC (discount rate)');        d.value('B3', wacc);
  d.label('A4', 'Terminal Growth (g)');         d.value('B4', terminalGrowth);
  d.label('A5', 'Tax Rate');                    d.value('B5', taxRate);
  d.label('A6', 'Hardware Revenue Growth');     d.value('B6', hwGrowth);
  d.label('A7', 'Software Revenue Growth');     d.value('B7', swGrowth);
  d.label('A8', 'Hardware Gross Margin');       d.value('B8', hwGrossMargin);
  d.label('A9', 'Software Gross Margin');       d.value('B9', swGrossMargin);
  d.label('A10', 'Opex (% of revenue)');        d.value('B10', opexPct);
  d.label('A11', 'D&A (% of revenue)');         d.value('B11', daPct);
  d.label('A12', 'Net Debt (current)');         d.value('B12', netDebt);

  m.defineName('WACC', 'Drivers', 'B3');
  m.defineName('TerminalGrowth', 'Drivers', 'B4');
  m.defineName('TaxRate', 'Drivers', 'B5');

  // ======================================================================
  // SHEET: Operating Plan (3-statement-lite P&L → FCF)
  // ======================================================================
  const p = m.sheet('Operating Plan');
  p.label('A1', 'Operating Plan ($)');
  p.label('A2', 'Fiscal Year'); p.valueRow('B2', years);

  // Row 3: Hardware revenue (year 1 literal; later years grow off prior column).
  p.label('A3', 'Hardware Revenue');
  p.value('B3', hwRev[0]);
  // formulaRow starts at C3 (col index 3); cell i sits at col 3+i, so the PRIOR
  // column (same row) is colLetter(2+i): i=0 -> B, i=1 -> C, ...
  p.formulaRow('C3', hwRev.slice(1), (i) => {
    const prev = colLetter(2 + i);
    return `${prev}3*(1+Drivers!$B$6)`;
  });

  // Row 4: Software revenue.
  p.label('A4', 'Software Revenue');
  p.value('B4', swRev[0]);
  p.formulaRow('C4', swRev.slice(1), (i) => {
    const prev = colLetter(2 + i);
    return `${prev}4*(1+Drivers!$B$7)`;
  });

  // Row 5: Total Revenue = HW + SW (same column).
  p.label('A5', 'Total Revenue');
  p.formulaRow('B5', totalRev, (i, colL) => `${colL}3+${colL}4`);

  // Row 6: Hardware gross profit.
  p.label('A6', 'Hardware Gross Profit');
  p.formulaRow('B6', hwGP, (i, colL) => `${colL}3*Drivers!$B$8`);

  // Row 7: Software gross profit.
  p.label('A7', 'Software Gross Profit');
  p.formulaRow('B7', swGP, (i, colL) => `${colL}4*Drivers!$B$9`);

  // Row 8: Total Gross Profit.
  p.label('A8', 'Gross Profit');
  p.formulaRow('B8', grossProfit, (i, colL) => `${colL}6+${colL}7`);

  // Row 9: Operating Expenses (% of total revenue).
  p.label('A9', 'Operating Expenses');
  p.formulaRow('B9', opex, (i, colL) => `${colL}5*Drivers!$B$10`);

  // Row 10: EBITDA = Gross Profit - Opex.  (headline: ebitda)
  p.label('A10', 'EBITDA');
  p.formulaRow('B10', ebitda, (i, colL) => `${colL}8-${colL}9`);

  // Row 11: D&A (% of total revenue).
  p.label('A11', 'Depreciation & Amortization');
  p.formulaRow('B11', da, (i, colL) => `${colL}5*Drivers!$B$11`);

  // Row 12: EBIT = EBITDA - D&A.
  p.label('A12', 'EBIT');
  p.formulaRow('B12', ebit, (i, colL) => `${colL}10-${colL}11`);

  // Row 13: Taxes = MAX(0, EBIT) * TaxRate.
  p.label('A13', 'Income Taxes');
  p.formulaRow('B13', taxes, (i, colL) => `MAX(0,${colL}12)*Drivers!$B$5`);

  // Row 14: Net Income = EBIT - Taxes.
  p.label('A14', 'Net Income');
  p.formulaRow('B14', netIncome, (i, colL) => `${colL}12-${colL}13`);

  // Row 15: Free Cash Flow = Net Income + D&A.
  p.label('A15', 'Free Cash Flow');
  p.formulaRow('B15', fcf, (i, colL) => `${colL}14+${colL}11`);

  // ======================================================================
  // SHEET: DCF Valuation
  // ======================================================================
  const v = m.sheet('DCF Valuation');
  v.label('A1', 'Discounted Cash Flow Valuation ($)');
  v.label('A2', 'Fiscal Year'); v.valueRow('B2', years);
  v.label('A3', 'Discount Period'); v.valueRow('B3', years.map((_, i) => i + 1));

  // Row 4: FCF pulled from Operating Plan (same columns B..F).
  v.label('A4', 'Free Cash Flow');
  v.formulaRow('B4', fcf, (i, colL) => `'Operating Plan'!${colL}15`);

  // Row 5: Discount Factor = 1/(1+WACC)^period.
  v.label('A5', 'Discount Factor');
  v.formulaRow('B5', discFactor, (i, colL) => `1/(1+Drivers!$B$3)^${colL}3`);

  // Row 6: PV of FCF = FCF * Discount Factor.
  v.label('A6', 'PV of Free Cash Flow');
  v.formulaRow('B6', pvFcf, (i, colL) => `${colL}4*${colL}5`);

  // Single-column valuation block (column B), each reads earlier rows / row 6 range.
  const fCol = colLetter(2 + lastIdx); // last forecast column letter (F)
  v.label('A8', 'Sum PV of FCF');
  v.formula('B8', `SUM(B6:${fCol}6)`, sumPvFcf);

  v.label('A9', 'Terminal Value (Gordon growth)'); // headline: terminalValue
  v.formula('B9', `${fCol}4*(1+Drivers!$B$4)/(Drivers!$B$3-Drivers!$B$4)`, terminalValue);

  v.label('A10', 'PV of Terminal Value');
  v.formula('B10', `B9*${fCol}5`, pvTerminalValue);

  v.label('A11', 'Enterprise Value');
  v.formula('B11', `B8+B10`, enterpriseValue);

  v.label('A12', 'Less: Net Debt');
  v.formula('B12', `Drivers!$B$12`, netDebt);

  v.label('A13', 'Equity Value');
  v.formula('B13', `B11-B12`, equityValue);

  m.write(outPath);
  return {
    outPath,
    expected: {
      ebitdaY1: ebitda[0],
      ebitdaY5: ebitda[lastIdx],
      terminalValue: r2(terminalValue),
      enterpriseValue: r2(enterpriseValue),
      equityValue: r2(equityValue),
    },
  };
}

// CLI entry
if (process.argv[1]?.endsWith('corp-fpa-manager.mjs')) {
  const out = process.argv[2] || 'engines/_personas/corp-fpa-manager/model.xlsx';
  const res = build(out);
  console.log('Wrote', res.outPath);
  console.log('Expected:', JSON.stringify(res.expected, null, 2));
}

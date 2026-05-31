/**
 * saas-growth-operator.mjs — synthetic SaaS growth/metrics model.
 *
 * Persona: a SaaS growth operator looking at a 5-year ARR build with the usual
 * operator KPIs (NRR, CAC, magic number, burn, gross margin, Rule of 40) and an
 * implied valuation = ending ARR x ARR multiple.
 *
 * Layout follows the HARD RULES: time runs across COLUMNS (annual headers in a
 * row), every metric is its own ROW, and the ARR roll-forward references the
 * PRIOR COLUMN, SAME ROW (ending = prior-ending + new + expansion - churn).
 *
 * All data synthetic. Run: node saas-growth-operator.mjs <out.xlsx>
 *
 * @license MIT
 */
import { ModelBuilder, colLetter, r2 } from '../lib/model-builder.mjs';

export function build(outPath) {
  const m = new ModelBuilder('Northwind Cloud — SaaS Operating Model', 'saas_metrics');

  // --- timeline: 5 annual periods across columns (B..F) ---
  const years = [2025, 2026, 2027, 2028, 2029];
  const nY = years.length;
  const exitIdx = nY - 1;
  // col index for period i (B=2)
  const C = (i) => colLetter(2 + i);

  // ---------------------------------------------------------------------------
  // Drivers / assumptions
  // ---------------------------------------------------------------------------
  const arrMultiple = 8.0;          // exit ARR multiple (x ending ARR)
  const netRetention = 1.12;        // NRR: expansion/churn implied gross retention split
  const grossMarginPct = 0.78;      // gross margin on revenue
  // ARR build drivers
  const startingARR = 12_000_000;   // beginning ARR at start of year 1
  const grossChurnPct = 0.10;       // gross $ churn as % of beginning ARR
  // New bookings (net new logos ARR) per year — declining as base grows
  const newBookings = [4_200_000, 5_400_000, 6_300_000, 7_100_000, 7_900_000];
  // Sales & marketing spend per year (drives CAC + magic number)
  const snmSpend = [6_000_000, 7_200_000, 8_300_000, 9_100_000, 9_800_000];
  // Operating cost (ex-COGS, ex-S&M) as % of revenue — for burn / Rule of 40
  const otherOpexPct = 0.34;

  const a = m.sheet('Drivers');
  a.label('A1', 'Northwind Cloud — Key Drivers (synthetic)');
  a.label('A3', 'Exit ARR Multiple (x ending ARR)'); a.value('B3', arrMultiple);
  a.label('A4', 'Net Revenue Retention (NRR)');       a.value('B4', netRetention);
  a.label('A5', 'Gross Margin (% of revenue)');       a.value('B5', grossMarginPct);
  a.label('A6', 'Gross $ Churn (% of beginning ARR)'); a.value('B6', grossChurnPct);
  a.label('A7', 'Other Opex (% of revenue)');         a.value('B7', otherOpexPct);
  m.defineName('ARRMultiple', 'Drivers', 'B3');
  m.defineName('NetRetention', 'Drivers', 'B4');
  m.defineName('GrossMargin', 'Drivers', 'B5');
  // Gross $ churn (B6) is already read by the Ending-ARR roll-forward and the
  // Gross Churned ARR row → ending ARR → implied valuation; expose it as a dial.
  m.defineName('GrossChurn', 'Drivers', 'B6');

  // ---------------------------------------------------------------------------
  // Compute the ARR build in JS first (same math the formulas will encode).
  //   beginning[i]  = (i==0) startingARR : ending[i-1]
  //   expansion[i]  = beginning[i] * (NRR - 1)          (net upsell uplift)
  //   grossChurn[i] = beginning[i] * grossChurnPct
  //   newBook[i]    = literal input
  //   ending[i]     = beginning[i] + newBook[i] + expansion[i] - grossChurn[i]
  // ---------------------------------------------------------------------------
  // NOTE: keep the recurrence math RAW (no intermediate r2) so the JS cached
  // values reproduce the formulas to full float precision. The ARR Build
  // formulas use raw Beginning*(NRR-1) and Beginning*churn, so we must too.
  const beginning = new Array(nY);
  const expansion = new Array(nY);
  const grossChurn = new Array(nY);
  const ending = new Array(nY);
  for (let i = 0; i < nY; i++) {
    beginning[i] = i === 0 ? startingARR : ending[i - 1];
    expansion[i] = beginning[i] * (netRetention - 1);
    grossChurn[i] = beginning[i] * grossChurnPct;
    ending[i] = beginning[i] + newBookings[i] + expansion[i] - grossChurn[i];
  }

  // All derived series below stay RAW (no r2) to match their formulas exactly.
  // Revenue recognized in the year ~= average of beginning & ending ARR
  // (a standard mid-period revenue approximation for a subscription book).
  const revenue = new Array(nY);
  for (let i = 0; i < nY; i++) revenue[i] = (beginning[i] + ending[i]) / 2;

  const grossProfit = revenue.map(v => v * grossMarginPct);
  // Operating expenses = S&M + other opex (% of revenue)
  const otherOpex = revenue.map(v => v * otherOpexPct);
  // Operating income (proxy for burn when negative)
  const opIncome = new Array(nY);
  for (let i = 0; i < nY; i++) opIncome[i] = grossProfit[i] - snmSpend[i] - otherOpex[i];
  // Net burn = -operating income when negative (cash burn), else 0
  const burn = opIncome.map(v => Math.max(0, -v));

  // CAC efficiency: S&M spend / net-new ARR added this year (new + expansion)
  const netNewARR = new Array(nY);
  for (let i = 0; i < nY; i++) netNewARR[i] = newBookings[i] + expansion[i];
  const cac = new Array(nY);
  for (let i = 0; i < nY; i++) cac[i] = snmSpend[i] / netNewARR[i];

  // Magic number = net-new ARR (this year) / prior-year S&M spend.
  // Year 1 uses current-year S&M as the prior proxy (common when no history).
  const magic = new Array(nY);
  for (let i = 0; i < nY; i++) {
    const priorSnm = i === 0 ? snmSpend[0] : snmSpend[i - 1];
    magic[i] = netNewARR[i] / priorSnm;
  }

  // Growth rate of revenue YoY (for Rule of 40)
  const revGrowth = new Array(nY);
  for (let i = 0; i < nY; i++) {
    revGrowth[i] = i === 0 ? 0 : (revenue[i] - revenue[i - 1]) / revenue[i - 1];
  }
  // Operating (FCF-ish) margin = opIncome / revenue
  const opMargin = new Array(nY);
  for (let i = 0; i < nY; i++) opMargin[i] = opIncome[i] / revenue[i];
  // Rule of 40 = revenue growth % + operating margin % (as fractions, summed)
  const ruleOf40 = new Array(nY);
  for (let i = 0; i < nY; i++) ruleOf40[i] = revGrowth[i] + opMargin[i];

  // ---------------------------------------------------------------------------
  // ARR Build sheet (the roll-forward).
  //
  // ROW-MAJOR SAFETY: the engine evaluates a sheet row-major (all of row N
  // across every column, then row N+1). So a roll-forward must NEVER reference
  // a LATER row of the same sheet — even via the prior column — because that
  // later row has not been computed yet when an earlier row reads it.
  //
  // We therefore make ENDING ARR the rolling row and place it ABOVE its derived
  // display rows. Each column's Ending references the PRIOR COLUMN, SAME ROW
  // (already computed: column B's row is emitted before column C's row), plus
  // its own current-column New Bookings (an earlier row in the same column):
  //
  //   C(Ending) = B(Ending) + C(New) + B(Ending)*(NRR-1) - B(Ending)*churn
  //
  // Beginning/Expansion/Churn/NRR are display rows BELOW Ending; they read the
  // prior column's Ending (row 4) which is already computed.
  // ---------------------------------------------------------------------------
  const b = m.sheet('ARR Build');
  b.label('A1', 'ARR Roll-Forward ($)');
  b.label('A2', 'Year'); b.valueRow('B2', years);

  // Row 3: New Bookings (literal inputs) — no dependencies.
  b.label('A3', 'New Bookings (ARR)');
  b.valueRow('B3', newBookings);

  // Row 4: Ending ARR (the rolling row).
  //   B4 = startingARR + B3 + startingARR*(NRR-1) - startingARR*churn
  //   C4 = B4 + C3 + B4*(NRR-1) - B4*churn   (prior col Ending = B4, same row)
  b.label('A4', 'Ending ARR');
  // Year 1: beginning is the literal startingARR constant.
  b.formula('B4', `${startingARR}+B3+${startingARR}*(Drivers!$B$4-1)-${startingARR}*Drivers!$B$6`, ending[0]);
  b.formulaRow('C4', ending.slice(1), (i) => {
    const prev = colLetter(2 + i);  // i=0 -> 'B'
    const cur = colLetter(3 + i);   // i=0 -> 'C'
    return `${prev}4+${cur}3+${prev}4*(Drivers!$B$4-1)-${prev}4*Drivers!$B$6`;
  });

  // Row 5: Beginning ARR (display). B5 literal start; C5 = prior col Ending (B4).
  b.label('A5', 'Beginning ARR');
  b.value('B5', beginning[0]);
  b.formulaRow('C5', beginning.slice(1), (i) => `${colLetter(2 + i)}4`); // C5=B4, D5=C4, ...

  // Row 6: Expansion ARR = Beginning * (NRR - 1).  (reads row 5, earlier)
  b.label('A6', 'Expansion ARR');
  b.formulaRow('B6', expansion, (i) => `${C(i)}5*(Drivers!$B$4-1)`);

  // Row 7: Gross Churned ARR = Beginning * gross churn %.
  b.label('A7', 'Gross Churned ARR');
  b.formulaRow('B7', grossChurn, (i) => `${C(i)}5*Drivers!$B$6`);

  // Row 8: Net Revenue Retention = (Beginning + Expansion - Churn)/Beginning.
  const nrrReported = new Array(nY);
  for (let i = 0; i < nY; i++) nrrReported[i] = (beginning[i] + expansion[i] - grossChurn[i]) / beginning[i];
  b.label('A8', 'Net Revenue Retention');
  b.formulaRow('B8', nrrReported, (i) => `(${C(i)}5+${C(i)}6-${C(i)}7)/${C(i)}5`);

  // Cell-reference map for downstream sheets (rows moved vs. the naive layout):
  const ROW_BEGIN = 5;   // Beginning ARR
  const ROW_END = 4;     // Ending ARR
  const ROW_NEW = 3;     // New Bookings
  const ROW_EXP = 6;     // Expansion
  const ROW_NRR = 8;     // Net Revenue Retention

  // ---------------------------------------------------------------------------
  // KPI / P&L sheet
  // ---------------------------------------------------------------------------
  const p = m.sheet('Operating Metrics');
  p.label('A1', 'Operating Metrics & P&L ($)');
  p.label('A2', 'Year'); p.valueRow('B2', years);

  // Revenue = average of beginning & ending ARR. References ARR Build rows 5 & 4.
  p.label('A3', 'Revenue');
  p.formulaRow('B3', revenue, (i) => `('ARR Build'!${C(i)}${ROW_BEGIN}+'ARR Build'!${C(i)}${ROW_END})/2`);

  // Gross Profit = Revenue * gross margin.
  p.label('A4', 'Gross Profit');
  p.formulaRow('B4', grossProfit, (i) => `${C(i)}3*Drivers!$B$5`);

  // Sales & Marketing spend (literal inputs).
  p.label('A5', 'Sales & Marketing');
  p.valueRow('B5', snmSpend);

  // Other Opex = Revenue * other opex %.
  p.label('A6', 'Other Operating Expense');
  p.formulaRow('B6', otherOpex, (i) => `${C(i)}3*Drivers!$B$7`);

  // Operating Income = GP - S&M - Other Opex.
  p.label('A7', 'Operating Income');
  p.formulaRow('B7', opIncome, (i) => `${C(i)}4-${C(i)}5-${C(i)}6`);

  // Net Burn = MAX(0, -Operating Income).
  p.label('A8', 'Net Cash Burn');
  p.formulaRow('B8', burn, (i) => `MAX(0,-${C(i)}7)`);

  // Net New ARR = New Bookings + Expansion (from ARR Build rows 3 & 6).
  p.label('A9', 'Net New ARR');
  p.formulaRow('B9', netNewARR, (i) => `'ARR Build'!${C(i)}${ROW_NEW}+'ARR Build'!${C(i)}${ROW_EXP}`);

  // CAC ratio = S&M / Net New ARR.
  p.label('A10', 'CAC Ratio (S&M / Net New ARR)');
  p.formulaRow('B10', cac, (i) => `${C(i)}5/${C(i)}9`);

  // Magic Number = Net New ARR / prior-year S&M (year 1 uses current S&M).
  p.label('A11', 'Magic Number');
  p.formula('B11', `B9/B5`, magic[0]);
  p.formulaRow('C11', magic.slice(1), (i) => `${colLetter(3 + i)}9/${colLetter(2 + i)}5`);

  // Gross Margin % = Gross Profit / Revenue.
  p.label('A12', 'Gross Margin %');
  const gmPct = grossProfit.map((v, i) => v / revenue[i]);
  p.formulaRow('B12', gmPct, (i) => `${C(i)}4/${C(i)}3`);

  // Revenue Growth % YoY. Year 1 = 0 (literal); later = (rev - priorRev)/priorRev.
  p.label('A13', 'Revenue Growth %');
  p.value('B13', revGrowth[0]);
  p.formulaRow('C13', revGrowth.slice(1), (i) => `(${colLetter(3 + i)}3-${colLetter(2 + i)}3)/${colLetter(2 + i)}3`);

  // Operating Margin % = Operating Income / Revenue.
  p.label('A14', 'Operating Margin %');
  p.formulaRow('B14', opMargin, (i) => `${C(i)}7/${C(i)}3`);

  // Rule of 40 = Revenue Growth % + Operating Margin %.
  p.label('A15', 'Rule of 40');
  p.formulaRow('B15', ruleOf40, (i) => `${C(i)}13+${C(i)}14`);

  // ---------------------------------------------------------------------------
  // Summary / "Cheat Sheet" — headline outputs (terminalValue, exitMultiple)
  // ---------------------------------------------------------------------------
  const endingARRExit = ending[exitIdx];
  const impliedValuation = endingARRExit * arrMultiple;
  const exitRevenue = revenue[exitIdx];
  const exitRuleOf40 = ruleOf40[exitIdx];
  const exitNRR = nrrReported[exitIdx];
  const arrCagr = Math.pow(ending[exitIdx] / startingARR, 1 / (nY - 1)) - 1;

  const s = m.sheet('Cheat Sheet');
  s.label('A1', 'Northwind Cloud — Investor Cheat Sheet');

  s.label('A3', 'Ending ARR (exit year)');
  s.formula('B3', `'ARR Build'!${C(exitIdx)}${ROW_END}`, endingARRExit);

  s.label('A4', 'Exit ARR Multiple');
  s.formula('B4', `Drivers!$B$3`, arrMultiple);

  s.label('A5', 'Implied Enterprise Value');
  s.formula('B5', `B3*B4`, impliedValuation);

  s.label('A6', 'Exit-Year Revenue');
  s.formula('B6', `'Operating Metrics'!${C(exitIdx)}3`, exitRevenue);

  s.label('A7', 'Exit-Year NRR');
  s.formula('B7', `'ARR Build'!${C(exitIdx)}${ROW_NRR}`, exitNRR);

  s.label('A8', 'Exit-Year Rule of 40');
  s.formula('B8', `'Operating Metrics'!${C(exitIdx)}15`, exitRuleOf40);

  s.label('A9', 'ARR CAGR (5yr)');
  s.formula('B9', `('ARR Build'!${C(exitIdx)}${ROW_END}/'ARR Build'!B${ROW_BEGIN})^(1/${nY - 1})-1`, arrCagr);

  // Implied EV / Revenue multiple — a second valuation cross-check.
  const evRevMultiple = impliedValuation / exitRevenue;
  s.label('A10', 'Implied EV / Revenue');
  s.formula('B10', `B5/B6`, evRevMultiple);

  m.write(outPath);
  return {
    outPath,
    expected: {
      endingARRExit, impliedValuation, exitRevenue, exitRuleOf40, exitNRR, arrMultiple, arrCagr,
    },
  };
}

// CLI entry
if (process.argv[1] && process.argv[1].endsWith('saas-growth-operator.mjs')) {
  const out = process.argv[2] || 'engines/_personas/saas-growth-operator/model.xlsx';
  const res = build(out);
  console.log('Wrote', res.outPath);
  console.log('Expected:', JSON.stringify(res.expected, null, 2));
}

export default build;

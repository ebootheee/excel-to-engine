/**
 * Generator: minority growth-equity stake in a SaaS company (6-year hold).
 * Synthetic data only. Persona: growth-equity VP.
 *
 * Structure (standard layout — time across COLUMNS, metrics as ROWS):
 *   - Inputs        : driver assumptions (defined names live here)
 *   - ARR Build     : ending ARR rolls forward (prior column same row) folding
 *                     in new + expansion - churn; expansion/churn/beginning are
 *                     shown as DISPLAY rows that reference EARLIER rows only.
 *   - Revenue       : recognized revenue derived from ARR
 *   - Returns       : entry stake, exit on a REVENUE multiple, MOIC, IRR
 *
 * IMPORTANT (engine eval-order constraint): the chunked engine emits a sheet's
 * cells row-major (top row fully across all columns, then the next row). A cell
 * may therefore only read an EARLIER row, or the SAME row in an EARLIER column.
 * A classic ARR bridge (Beginning row on top = prior-column Ending row at the
 * bottom) would read a LATER row and resolve to 0. So the rolling balance lives
 * on ONE row near the top (Ending ARR), references the prior column same row,
 * and the bridge components are derived as display rows BELOW it.
 *
 * Headline metrics surfaced: grossMOIC, grossIRR, exitMultiple.
 *
 * Run: node growth-equity-vp.mjs <out.xlsx>
 * @license MIT
 */
import { ModelBuilder, colLetter, r2 } from '../lib/model-builder.mjs';

function r6(x) { return Math.round(x * 1e6) / 1e6; }

export function build(outPath) {
  const m = new ModelBuilder('Project Northstar — Growth Equity Investment', 'growth_equity');

  // --- timeline: entry (year 0) .. exit (year 5), 6 columns ---
  const years = [2025, 2026, 2027, 2028, 2029, 2030];
  const nY = years.length;
  const entryIdx = 0;
  const exitIdx = nY - 1;
  const holdYears = years[exitIdx] - years[entryIdx]; // 5

  // --- driver assumptions ---
  const newARRgrowth = 0.10;     // new logo ARR grows 10%/yr off prior-year new ARR
  const expansionPct = 0.18;     // expansion = % of beginning ARR (NRR uplift)
  const churnPct = 0.09;         // gross churn = % of beginning ARR
  const revMultiple = 0.85;      // recognized revenue as a fraction of ending ARR (ramp)
  const exitRevMultiple = 7.5;   // exit EV / revenue multiple
  const ownershipPct = 0.225;    // our minority stake at entry
  const entryRevMultiple = 9.0;  // entry EV / revenue multiple (sets our cost basis)

  const beginARR0 = 24_000_000;  // beginning ARR at entry (year 2025)
  const newARR0 = 6_000_000;     // year-1 new logo ARR (grows thereafter)

  const inp = m.sheet('Inputs');
  inp.label('A1', 'Project Northstar — Investment Assumptions');
  inp.label('A3', 'New Logo ARR Growth (annual)');     inp.value('B3', newARRgrowth);
  inp.label('A4', 'Expansion (% of beginning ARR)');   inp.value('B4', expansionPct);
  inp.label('A5', 'Gross Churn (% of beginning ARR)'); inp.value('B5', churnPct);
  inp.label('A6', 'Revenue / Ending ARR (ramp)');      inp.value('B6', revMultiple);
  inp.label('A7', 'Exit EV / Revenue Multiple');       inp.value('B7', exitRevMultiple);
  inp.label('A8', 'Our Ownership at Entry');           inp.value('B8', ownershipPct);
  inp.label('A9', 'Entry EV / Revenue Multiple');      inp.value('B9', entryRevMultiple);
  // defined names -> app levers (named-inputs.json). Each is read by formulas below.
  m.defineName('ExitRevenueMultiple', 'Inputs', 'B7');
  m.defineName('NewARRGrowth', 'Inputs', 'B3');
  m.defineName('Ownership', 'Inputs', 'B8');
  m.defineName('Expansion', 'Inputs', 'B4');

  // ---------------------------------------------------------------------------
  // Compute the full series in JS using the SAME math the formulas will encode.
  //
  // Recurrence (row-major safe):
  //   newARR[i]  = newARR[i-1] * (1 + g)          (prior column, same row)
  //   endARR[i]  = endARR[i-1] * (1 + exp% - churn%) + newARR[i]
  //              = beginning*(1+exp-churn) + new    where beginning = endARR[i-1]
  // The bridge components below are mathematically identical to
  //   beginning + new + expansion - churn:
  //   beginning = endARR[i-1], expansion = beginning*exp%, churn = beginning*churn%.
  // ---------------------------------------------------------------------------
  const newARR = new Array(nY);
  const endARR = new Array(nY);
  const begARR = new Array(nY);
  const expARR = new Array(nY);
  const churnARR = new Array(nY);

  for (let i = 0; i < nY; i++) {
    newARR[i] = i === 0 ? newARR0 : r2(newARR[i - 1] * (1 + newARRgrowth));
    begARR[i] = i === 0 ? beginARR0 : endARR[i - 1];
    expARR[i] = r2(begARR[i] * expansionPct);
    churnARR[i] = r2(begARR[i] * churnPct);
    endARR[i] = r2(begARR[i] * (1 + expansionPct - churnPct) + newARR[i]);
  }
  const revenue = endARR.map(v => r2(v * revMultiple));

  // --- ARR Build sheet ---
  // Rows (row-major safe ordering — no cell reads a LATER row):
  //   2 Year
  //   3 New Logo ARR    (rolls along its own row: C3 = B3*(1+g))
  //   4 Ending ARR      (rolling balance: C4 = B4*(1+exp-churn) + C3)
  //   5 Beginning ARR   (display: C5 = B4  -> prior column Ending, earlier row)
  //   6 Expansion ARR   (display: C6 = C5*exp%)
  //   7 Gross Churn     (display: C7 = C5*churn%)
  const arr = m.sheet('ARR Build');
  arr.label('A1', 'ARR Bridge ($)');
  arr.label('A2', 'Year'); arr.valueRow('B2', years);

  arr.label('A3', 'New Logo ARR');
  arr.value('B3', newARR[0]); // entry literal
  // C3 = B3*(1+growth), ... prior column same row (row-major safe).
  arr.formulaRow('C3', newARR.slice(1), (i) => `${colLetter(2 + i)}3*(1+Inputs!$B$3)`);

  arr.label('A4', 'Ending ARR');
  arr.value('B4', endARR[0]); // entry literal (= beginning + flows for year 0)
  // C4 = B4*(1+exp%-churn%) + C3 : prior column ending (same row, earlier col)
  // plus this year's new logo (row 3, an earlier row). Both safe.
  arr.formulaRow('C4', endARR.slice(1), (i) => {
    const c = colLetter(3 + i); // current column (C, D, ...)
    const p = colLetter(2 + i); // prior column   (B, C, ...)
    return `${p}4*(1+Inputs!$B$4-Inputs!$B$5)+${c}3`;
  });

  // --- bridge display rows (reference earlier rows only) ---
  arr.label('A5', 'Beginning ARR');
  arr.value('B5', begARR[0]);
  // C5 = B4 (prior column's Ending ARR = this year's beginning). Earlier row 4.
  arr.formulaRow('C5', begARR.slice(1), (i) => `${colLetter(2 + i)}4`);

  arr.label('A6', 'Expansion ARR');
  // Expansion = beginning ARR (row 5, earlier) * expansion%
  arr.formulaRow('B6', expARR, (i) => `${colLetter(2 + i)}5*Inputs!$B$4`);

  arr.label('A7', 'Gross Churn');
  // Churn = beginning ARR (row 5, earlier) * churn%
  arr.formulaRow('B7', churnARR, (i) => `${colLetter(2 + i)}5*Inputs!$B$5`);

  // --- Revenue sheet ---
  const rsheet = m.sheet('Revenue');
  rsheet.label('A1', 'Recognized Revenue ($)');
  rsheet.label('A2', 'Year'); rsheet.valueRow('B2', years);
  rsheet.label('A3', 'Ending ARR');
  rsheet.formulaRow('B3', endARR, (i) => `'ARR Build'!${colLetter(2 + i)}4`);
  rsheet.label('A4', 'Recognized Revenue');
  rsheet.formulaRow('B4', revenue, (i) => `${colLetter(2 + i)}3*Inputs!$B$6`);

  // ---------------------------------------------------------------------------
  // Returns / exit math
  // ---------------------------------------------------------------------------
  const entryRev = revenue[entryIdx];
  const entryEV = r2(entryRev * entryRevMultiple);
  const entryEquityToUs = r2(entryEV * ownershipPct); // our cost basis (minority stake)

  const exitRev = revenue[exitIdx];
  const exitEV = r2(exitRev * exitRevMultiple);
  const exitEquityToUs = r2(exitEV * ownershipPct);   // assume ownership constant (no dilution)

  const grossMOIC = exitEquityToUs / entryEquityToUs;
  const grossIRR = Math.pow(exitEquityToUs / entryEquityToUs, 1 / holdYears) - 1;

  // --- Returns / Investor Summary sheet ---
  const sum = m.sheet('Investor Summary');
  sum.label('A1', 'Investor Summary — Gross Returns');

  sum.label('A3', 'Entry Revenue');          sum.formula('B3', `Revenue!${colLetter(2 + entryIdx)}4`, entryRev);
  sum.label('A4', 'Entry EV');               sum.formula('B4', `B3*Inputs!$B$9`, entryEV);
  sum.label('A5', 'Our Ownership %');        sum.formula('B5', `Inputs!$B$8`, ownershipPct);
  sum.label('A6', 'Entry Equity to Us');     sum.formula('B6', `B4*B5`, entryEquityToUs);

  sum.label('A8', 'Exit Revenue');           sum.formula('B8', `Revenue!${colLetter(2 + exitIdx)}4`, exitRev);
  sum.label('A9', 'Exit Revenue Multiple');  sum.formula('B9', `Inputs!$B$7`, exitRevMultiple);
  sum.label('A10', 'Exit Enterprise Value'); sum.formula('B10', `B8*B9`, exitEV);
  sum.label('A11', 'Exit Equity to Us');     sum.formula('B11', `B10*B5`, exitEquityToUs);

  sum.label('A13', 'Hold Period (years)');   sum.value('B13', holdYears);
  sum.label('A14', 'Gross MOIC');            sum.formula('B14', `B11/B6`, r6(grossMOIC));
  sum.label('A15', 'Gross IRR');             sum.formula('B15', `(B11/B6)^(1/${holdYears})-1`, r6(grossIRR));

  m.write(outPath);
  return {
    outPath,
    expected: {
      entryEquityToUs, exitEquityToUs,
      grossMOIC: r6(grossMOIC), grossIRR: r6(grossIRR),
      exitRevMultiple, endARR, revenue,
    },
  };
}

// CLI entry
if (process.argv[1]?.endsWith('growth-equity-vp.mjs')) {
  const out = process.argv[2] || 'engines/_personas/growth-equity-vp/model.xlsx';
  const res = build(out);
  console.log('Wrote', res.outPath);
  console.log('Expected:', JSON.stringify(res.expected, (k, v) => (Array.isArray(v) ? v.map(r2) : v)));
}

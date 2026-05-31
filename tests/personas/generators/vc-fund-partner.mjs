/**
 * Persona generator: early-stage VC fund (fund-of-portfolio-companies).
 *
 * Synthetic data only. Two-sheet model:
 *   1. "Portfolio"   — ~10 companies, cross-sectional table:
 *                      entry valuation, $ invested, ownership %, exit value,
 *                      proceeds (= ownership x exit). Totals row at the bottom.
 *   2. "Fund Cheat Sheet" — LP-facing returns: fund size / paid-in, distributed,
 *                      residual NAV, TVPI, DPI, RVPI, fund net IRR, fund (gross)
 *                      MOIC, GP carried interest (20% over 1.0x). Plus a J-curve
 *                      cashflow row with year headers across columns.
 *
 * Headline metrics surfaced: grossMOIC, grossIRR, tvpi, dpi.
 *
 * Layout discipline (per CLAUDE.md / persona harness HARD RULES):
 *   - Time across COLUMNS, each metric its own ROW (J-curve row).
 *   - Roll-forwards reference the PRIOR COLUMN, SAME ROW (cumulative cashflow).
 *   - No cross-row staircase (never reads a later row on the same sheet).
 *   - Every .formula() carries a cachedValue computed in JS with the SAME math.
 *
 * Run standalone:  node vc-fund-partner.mjs <out.xlsx>
 *
 * @license MIT
 */
import { ModelBuilder, colLetter, r2 } from '../lib/model-builder.mjs';
import { computeIRR } from '../../../lib/irr.mjs';

export function build(outPath) {
  const m = new ModelBuilder('Northpole Ventures Fund II — LP Reporting', 'venture_portfolio');

  // -------------------------------------------------------------------------
  // Fund-level driver inputs (these become defined-name levers / app inputs).
  // -------------------------------------------------------------------------
  const fundSize = 120_000_000;     // committed capital
  const paidInPct = 0.95;           // 95% of commitments called over the fund's life
  const carryRate = 0.20;           // GP carried interest over 1.0x return of capital
  const mgmtFeeRate = 0.02;         // 2% annual management fee (drag, informational)

  const paidIn = r2(fundSize * paidInPct); // 114,000,000

  // -------------------------------------------------------------------------
  // Portfolio: ~10 companies. Synthetic but plausible early-stage outcomes —
  // a couple of zeros (write-offs), some modest, one fund-returner.
  // ownership/exit/invested chosen so total proceeds drive ~2.5x gross.
  // -------------------------------------------------------------------------
  // Sized so total invested (~$95M) plus fees fits inside paid-in (~$114M) and
  // proceeds (~$235M) deliver a healthy ~2.5x gross / ~2.1x TVPI — a plausible
  // top-quartile early-stage outcome with two write-offs.
  const companies = [
    // name,                stage,     entryVal,    invested,    ownership, exitVal
    ['Helios Robotics',     'Seed',      8_000_000,    5_000_000,  0.18,    420_000_000],
    ['Tessellate AI',       'Series A', 24_000_000,   12_000_000,  0.16,    180_000_000],
    ['Quartzline Bio',      'Seed',     10_000_000,    6_000_000,  0.20,     65_000_000],
    ['Marlin Logistics',    'Series A', 30_000_000,   13_000_000,  0.14,     90_000_000],
    ['Beacon Health',       'Seed',      9_000_000,    5_500_000,  0.19,      0],          // write-off
    ['Cobalt Security',     'Series A', 28_000_000,   12_000_000,  0.15,     70_000_000],
    ['Driftwood Commerce',  'Seed',      7_500_000,    4_500_000,  0.17,     22_000_000],
    ['Ember Mobility',      'Series B', 60_000_000,   18_000_000,  0.10,    150_000_000],
    ['Northwind Climate',   'Seed',     11_000_000,    6_500_000,  0.21,      0],          // write-off
    ['Saffron Fintech',     'Series A', 26_000_000,   12_500_000,  0.16,     85_000_000],
  ];

  // Per-company derived: proceeds = ownership x exitVal; gain = proceeds - invested.
  const proceeds = companies.map(c => r2(c[4] * c[5]));        // ownership * exitVal
  const investedArr = companies.map(c => c[3]);
  const totalInvested = r2(investedArr.reduce((a, b) => a + b, 0));
  const totalProceeds = r2(proceeds.reduce((a, b) => a + b, 0));

  // -------------------------------------------------------------------------
  // Sheet 1: Portfolio (cross-sectional; one company per row).
  // Columns: A name | B stage | C entry val | D invested | E ownership | F exit | G proceeds
  // -------------------------------------------------------------------------
  const p = m.sheet('Portfolio');
  p.label('A1', 'Northpole Ventures Fund II — Portfolio Holdings ($)');
  p.labelRow('A3', ['Company', 'Stage', 'Entry Valuation', 'Invested', 'Ownership %', 'Exit Value', 'Proceeds']);

  const firstDataRow = 4;
  companies.forEach((c, i) => {
    const row = firstDataRow + i;
    p.label(`A${row}`, c[0]);
    p.label(`B${row}`, c[1]);
    p.value(`C${row}`, c[2]);            // entry valuation
    p.value(`D${row}`, c[3]);            // invested
    p.value(`E${row}`, c[4]);            // ownership %
    p.value(`F${row}`, c[5]);            // exit value
    // proceeds = ownership x exit value  (same-row, same-column inputs)
    p.formula(`G${row}`, `E${row}*F${row}`, proceeds[i]);
  });

  // Totals row (SUM down the columns — vertical sums are evaluation-safe).
  const totalsRow = firstDataRow + companies.length; // 14
  const lastDataRow = totalsRow - 1;
  p.label(`A${totalsRow}`, 'Total Portfolio');
  p.formula(`D${totalsRow}`, `SUM(D${firstDataRow}:D${lastDataRow})`, totalInvested);
  p.formula(`G${totalsRow}`, `SUM(G${firstDataRow}:G${lastDataRow})`, totalProceeds);

  // -------------------------------------------------------------------------
  // J-curve cashflow timeline (years across columns) on its own sheet.
  // Row layout: paid-in (negative draws), distributions (positive), net CF,
  // cumulative net CF (roll-forward = prior column + this column's net).
  // The XIRR over the dated net flows gives the fund net IRR.
  // -------------------------------------------------------------------------
  const years = [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024];
  const nY = years.length;

  // Capital calls (draws) — front-loaded J-curve, sums to paidIn (negative).
  const callFracs = [0.25, 0.25, 0.20, 0.12, 0.08, 0.05, 0.03, 0.02];
  const calls = callFracs.map(f => -r2(paidIn * f));
  // Force the call series to sum exactly to -paidIn (absorb rounding in the last).
  const callSum = r2(calls.reduce((a, b) => a + b, 0));
  calls[nY - 1] = r2(calls[nY - 1] - (callSum - -paidIn));

  // Distributions — back-loaded, a fraction of REALIZED PORTFOLIO PROCEEDS each
  // year. Written below as formulas referencing Portfolio!G{totals} so a change
  // to a holding's exit value (the TopCompanyExit lever) cascades into the fund
  // cashflow → net IRR. Cached values are the UNROUNDED product so they match the
  // transpiled formula exactly (fracs sum to 1.0, so the series sums to proceeds).
  const distFracs = [0, 0, 0.02, 0.05, 0.10, 0.18, 0.30, 0.35];
  const dists = distFracs.map(f => totalProceeds * f);
  const totalDistributed = dists.reduce((a, b) => a + b, 0); // == totalProceeds

  // Net cashflow per year + cumulative roll-forward.
  const netCF = years.map((_, i) => r2(calls[i] + dists[i]));
  const cumCF = [];
  netCF.forEach((v, i) => cumCF.push(r2((i === 0 ? 0 : cumCF[i - 1]) + v)));

  const cf = m.sheet('Cashflows');
  cf.label('A1', 'Fund Cash Flows — LP Net (J-Curve)');
  cf.label('A2', 'Year'); cf.valueRow('B2', years);
  cf.label('A3', 'Capital Called'); cf.valueRow('B3', calls);
  cf.label('A4', 'Distributions');
  // Each year = its calibrated fraction of realized portfolio proceeds (live ref).
  cf.formulaRow('B4', dists, (i) => `Portfolio!G${totalsRow}*${distFracs[i]}`);
  // Net CF row: this year's call + dist (same column, two rows above — both are
  // value rows, so reading them is evaluation-safe).
  cf.label('A5', 'Net Cash Flow');
  cf.formulaRow('B5', netCF, (i, colL) => `${colL}3+${colL}4`);
  // Cumulative net CF: first column seeds from B5; the rest are a pure
  // roll-forward referencing the PRIOR COLUMN, SAME ROW.
  cf.label('A6', 'Cumulative Net CF');
  cf.formula('B6', 'B5', cumCF[0]);
  cf.formulaRow('C6', cumCF.slice(1), (i, colL) => {
    const prev = colLetter(3 + i); // C is col3; prev of C is B, of D is C, ...
    return `${prev}6+${colL}5`;
  });

  // Fund IRR via annual IRR over the net-cashflow row (one flow per year column),
  // placed below as a live =IRR() formula so it recomputes under any lever that
  // moves the cashflows. computeIRR here uses the same NPV-root math as the
  // engine's transpiled IRR(), so the cached value ties out.
  const netIRR = computeIRR(netCF);

  // -------------------------------------------------------------------------
  // Fund-level returns math (computed in JS, placed as formulas w/ cached vals).
  // -------------------------------------------------------------------------
  const navPct = 0.12;                                   // unrealized stub vs. invested cost
  const residualNAV = r2(totalInvested * navPct);        // holdings still on the books
  // B13 = B11 (=Portfolio proceeds) + B12 (=residual NAV); cache the exact sum of
  // those two cell values so the formula ties out (totalDistributed≈proceeds).
  const totalValue = totalProceeds + residualNAV;        // distributions + NAV
  const tvpi = totalValue / paidIn;
  const dpi = totalDistributed / paidIn;
  const rvpi = residualNAV / paidIn;
  const grossMOIC = totalProceeds / totalInvested;       // fund (gross) MOIC on invested capital
  // GP carried interest: 20% of profit above 1.0x return of paid-in capital.
  const profitAboveOneX = r2(Math.max(0, totalValue - paidIn));
  const carry = r2(profitAboveOneX * carryRate);

  // -------------------------------------------------------------------------
  // Sheet 2: "Fund Cheat Sheet" — LP returns summary (vary wording from ref).
  // Anchor the equity class with "Total Equity Invested" so detectEquity finds
  // grossMOIC / grossIRR within its 20-row search window.
  // -------------------------------------------------------------------------
  const s = m.sheet('Fund Cheat Sheet');
  s.label('A1', 'Northpole Ventures Fund II — LP Returns Cheat Sheet');

  // Inputs block (defined-name levers live here).
  s.label('A3', 'Fund Size (Commitments)');     s.value('B3', fundSize);
  s.label('A4', 'Paid-In %');                    s.value('B4', paidInPct);
  s.label('A5', 'GP Carried Interest Rate');     s.value('B5', carryRate);
  s.label('A6', 'Management Fee (annual)');      s.value('B6', mgmtFeeRate);

  // Capital & value block.
  s.label('A8', 'Paid-In Capital');              s.formula('B8', 'B3*B4', paidIn);
  s.label('A9', 'Total Equity Invested');        s.formula('B9', `Portfolio!D${totalsRow}`, totalInvested);
  s.label('A10', 'Realized Proceeds');           s.formula('B10', `Portfolio!G${totalsRow}`, totalProceeds);
  // Total Distributed: the cashflow distributions were calibrated to equal the
  // realized proceeds total, so express it as that total (single, clean ref).
  s.label('A11', 'Total Distributed');           s.formula('B11', `Portfolio!G${totalsRow}`, totalProceeds);
  s.label('A12', 'Residual NAV (Unrealized)');   s.formula('B12', `Portfolio!D${totalsRow}*${navPct}`, residualNAV);
  s.label('A13', 'Total Value (Dist + NAV)');    s.formula('B13', 'B11+B12', totalValue);

  // LP multiples block.
  s.label('A15', 'TVPI');                         s.formula('B15', 'B13/B8', r6(tvpi));
  s.label('A16', 'DPI');                          s.formula('B16', 'B11/B8', r6(dpi));
  s.label('A17', 'RVPI');                         s.formula('B17', 'B12/B8', r6(rvpi));

  // Fund returns block — Gross MOIC / Gross IRR anchored near "Total Equity
  // Invested" (row 9) so the equity detector wires grossMOIC + grossIRR.
  s.label('A19', 'Fund Gross MOIC');              s.formula('B19', 'B10/B9', r6(grossMOIC));
  // Live IRR over the fund's net-cashflow row — recomputes whenever a lever moves
  // the cashflows (TopCompanyExit → proceeds → distributions → net CF → IRR).
  const cfLastCol = colLetter(1 + nY); // B..I for the 8 year columns
  s.label('A20', 'Fund Gross IRR');               s.formula('B20', `IRR(Cashflows!B5:${cfLastCol}5)`, netIRR);
  s.label('A21', 'Fund Net IRR');                 s.formula('B21', 'B20', netIRR);

  // GP economics block.
  s.label('A23', 'Profit Above 1.0x');            s.formula('B23', 'MAX(0,B13-B8)', profitAboveOneX);
  s.label('A24', 'GP Carried Interest');          s.formula('B24', 'B23*B5', carry);

  // -------------------------------------------------------------------------
  // Defined names → app levers (must be value cells read by ≥1 formula).
  //   FundSize         (B3) — read by B8 (paid-in)
  //   PaidInPct        (B4) — read by B8
  //   CarryRate        (B5) — read by B24 (carried interest)
  // -------------------------------------------------------------------------
  m.defineName('FundSize', 'Fund Cheat Sheet', 'B3');
  m.defineName('PaidInPct', 'Fund Cheat Sheet', 'B4');
  m.defineName('CarryRate', 'Fund Cheat Sheet', 'B5');
  // The "power-law winner" lever (the persona's literal ask): the top holding's
  // exit value. Read by Portfolio!G4 (proceeds), so moving it cascades through
  // proceeds → distributions → net cashflow → grossMOIC, TVPI, DPI, and live IRR.
  m.defineName('TopCompanyExit', 'Portfolio', 'F4');

  m.write(outPath);
  return {
    outPath,
    expected: {
      totalInvested, totalProceeds, totalDistributed, residualNAV, totalValue,
      tvpi: r6(tvpi), dpi: r6(dpi), rvpi: r6(rvpi),
      grossMOIC: r6(grossMOIC), grossIRR: r6(netIRR), carry, paidIn,
    },
  };
}

function r6(x) { return Math.round(x * 1e6) / 1e6; }

// CLI entry
if (process.argv[1]?.endsWith('vc-fund-partner.mjs')) {
  const out = process.argv[2] || 'engines/_personas/vc-fund-partner/model.xlsx';
  const res = build(out);
  console.log('Wrote', res.outPath);
  console.log('Expected:', JSON.stringify(res.expected, null, 2));
}

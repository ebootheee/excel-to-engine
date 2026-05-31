/**
 * Persona generator: family-office fund-of-funds (FoF) 10yr J-curve roll-up.
 *
 * Synthetic data only. Three-sheet model:
 *   1. "Underlying Funds" — ~6 underlying funds, cross-sectional table:
 *        Commitment, Called, Uncalled (= Commitment - Called), NAV,
 *        Distributions. A consolidated "Total Portfolio" row sums each column.
 *   2. "Cash Flows"       — 10yr J-curve, time across COLUMNS:
 *        capital called (negative draws), distributions (positive), net CF,
 *        cumulative net CF (roll-forward = prior column + this column's net).
 *        XIRR over the dated net flows = blended net IRR.
 *   3. "IR Cheat Sheet"   — principal-facing blended roll-up: capital committed
 *        (equity anchor), called, NAV, distributions, blended TVPI/DPI/RVPI,
 *        blended gross + net IRR, management fee + carry overlay.
 *
 * Headline metrics surfaced: tvpi, dpi, grossIRR.
 *
 * Layout discipline (per CLAUDE.md / persona harness HARD RULES):
 *   - Time across COLUMNS, each metric its own ROW (J-curve rows).
 *   - Roll-forwards reference the PRIOR COLUMN, SAME ROW (cumulative CF, uncalled
 *     would be cross-row so it is computed same-row from two value rows instead).
 *   - No cross-row staircase (never reads a LATER row on the same sheet).
 *   - Every .formula() carries a cachedValue computed in JS with the SAME math.
 *
 * Defined names (app levers): TotalCommitment, BlendedCarry, CalledPct.
 *
 * Run standalone:  node familyoffice-fof-ir.mjs <out.xlsx>
 *
 * @license MIT
 */
import { ModelBuilder, colLetter, r2 } from '../lib/model-builder.mjs';
import { computeIRR } from '../../../lib/irr.mjs';

export function build(outPath) {
  const m = new ModelBuilder('Cedarhill Family Office — Fund-of-Funds Roll-Up', 'fund_of_funds');

  // -------------------------------------------------------------------------
  // Portfolio: 6 underlying funds. Synthetic but plausible — a mix of vintages,
  // so some funds are still in the J-curve (NAV-heavy, low distributions) and
  // older ones are in harvest (DPI > 1). Amounts in $.
  //   commitment | called | nav | distributions
  // Uncalled is derived (= commitment - called). Called <= commitment always.
  // -------------------------------------------------------------------------
  const funds = [
    // name,                        commitment,   called,      nav,         distributions
    ['Granite Buyout Fund V',        40_000_000,  38_000_000,  41_000_000,  55_000_000],  // harvest, DPI>1
    ['Meridian Growth Equity III',   30_000_000,  24_000_000,  33_000_000,  18_000_000],  // mid-life
    ['Aster Venture Partners II',    20_000_000,  17_000_000,  29_000_000,   8_000_000],  // NAV-heavy J-curve
    ['Bluewater Infrastructure I',   35_000_000,  31_000_000,  30_000_000,  24_000_000],  // mid-life
    ['Coastline Real Assets IV',     25_000_000,  21_000_000,  19_000_000,  16_000_000],  // mid-life
    ['Summit Credit Opportunities',  15_000_000,  14_000_000,   9_000_000,  12_000_000],  // shorter-duration credit
  ];

  // Per-fund derived: uncalled = commitment (idx1) - called (idx2).
  const uncalledArr = funds.map(f => r2(f[1] - f[2]));

  // Column totals (consolidated row).
  const totalCommitment   = r2(funds.reduce((a, f) => a + f[1], 0));
  const totalCalled        = r2(funds.reduce((a, f) => a + f[2], 0));
  const totalUncalled      = r2(funds.reduce((a, f) => a + (f[1] - f[2]), 0));
  const totalNAV           = r2(funds.reduce((a, f) => a + f[3], 0));
  const totalDistributions = r2(funds.reduce((a, f) => a + f[4], 0));

  // -------------------------------------------------------------------------
  // Sheet 1: "Underlying Funds" (cross-sectional; one fund per row).
  // Columns: A name | B commitment | C called | D uncalled | E NAV | F distributions
  // -------------------------------------------------------------------------
  const p = m.sheet('Underlying Funds');
  p.label('A1', 'Cedarhill Family Office — Underlying Fund Positions ($)');
  p.labelRow('A3', ['Fund', 'Commitment', 'Called', 'Uncalled', 'NAV', 'Distributions']);

  const firstDataRow = 4;
  funds.forEach((f, i) => {
    const row = firstDataRow + i;
    p.label(`A${row}`, f[0]);
    p.value(`B${row}`, f[1]);                          // commitment
    p.value(`C${row}`, f[2]);                          // called
    // uncalled = commitment - called (same row, both value cells -> eval-safe)
    p.formula(`D${row}`, `B${row}-C${row}`, uncalledArr[i]);
    p.value(`E${row}`, f[3]);                          // NAV
    p.value(`F${row}`, f[4]);                          // distributions
  });

  // Consolidated total row (vertical SUM down each column — eval-safe).
  const totalsRow = firstDataRow + funds.length; // 10
  const lastDataRow = totalsRow - 1;
  p.label(`A${totalsRow}`, 'Total Portfolio (Consolidated)');
  p.formula(`B${totalsRow}`, `SUM(B${firstDataRow}:B${lastDataRow})`, totalCommitment);
  p.formula(`C${totalsRow}`, `SUM(C${firstDataRow}:C${lastDataRow})`, totalCalled);
  p.formula(`D${totalsRow}`, `SUM(D${firstDataRow}:D${lastDataRow})`, totalUncalled);
  p.formula(`E${totalsRow}`, `SUM(E${firstDataRow}:E${lastDataRow})`, totalNAV);
  p.formula(`F${totalsRow}`, `SUM(F${firstDataRow}:F${lastDataRow})`, totalDistributions);

  // -------------------------------------------------------------------------
  // Sheet 2: "Cash Flows" — 10yr J-curve, time across COLUMNS.
  // Capital called front-loaded (negative draws, sum to -totalCalled),
  // distributions back-loaded (sum to totalDistributions). Net CF + a terminal
  // NAV harvest in the final year approximates the unrealized residual so the
  // XIRR reflects a full liquidation view (blended net IRR).
  // -------------------------------------------------------------------------
  const years = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024];
  const nY = years.length;

  // Capital calls (negative). Front-loaded J-curve fractions of totalCalled.
  const callFracs = [0.22, 0.20, 0.16, 0.12, 0.10, 0.08, 0.05, 0.04, 0.02, 0.01];
  const calls = callFracs.map(f => -r2(totalCalled * f));
  // Force exact sum to -totalCalled (absorb rounding in the last period).
  const callSum = r2(calls.reduce((a, b) => a + b, 0));
  calls[nY - 1] = r2(calls[nY - 1] - (callSum - -totalCalled));

  // Distributions (positive). Back-loaded fractions of totalDistributions.
  const distFracs = [0, 0, 0.02, 0.05, 0.08, 0.12, 0.16, 0.20, 0.18, 0.19];
  const dists = distFracs.map(f => r2(totalDistributions * f));
  const distSum = r2(dists.reduce((a, b) => a + b, 0));
  dists[nY - 1] = r2(dists[nY - 1] + (totalDistributions - distSum));

  // Net CF per year (operating). The final year additionally "harvests" residual
  // NAV so the IRR reflects total value to LPs (a standard FoF liquidation view).
  const netCFops = years.map((_, i) => r2(calls[i] + dists[i]));
  // Terminal flow = ops net in final year + residual NAV harvest.
  const netCFwithNAV = netCFops.slice();
  netCFwithNAV[nY - 1] = r2(netCFwithNAV[nY - 1] + totalNAV);

  // Cumulative net CF (operating, excludes NAV harvest) — pure roll-forward.
  const cumCF = [];
  netCFops.forEach((v, i) => cumCF.push(r2((i === 0 ? 0 : cumCF[i - 1]) + v)));

  const cf = m.sheet('Cash Flows');
  cf.label('A1', 'Consolidated LP Cash Flows — J-Curve (10yr)');
  cf.label('A2', 'Year'); cf.valueRow('B2', years);
  cf.label('A3', 'Capital Called'); cf.valueRow('B3', calls);
  cf.label('A4', 'Distributions');  cf.valueRow('B4', dists);
  // Net Cash Flow row: this year's call + dist (same column, two value rows).
  cf.label('A5', 'Net Cash Flow');
  cf.formulaRow('B5', netCFops, (i, colL) => `${colL}3+${colL}4`);
  // Cumulative net CF: seed from B5, then roll forward off PRIOR COLUMN, SAME ROW.
  cf.label('A6', 'Cumulative Net CF');
  cf.formula('B6', 'B5', cumCF[0]);
  cf.formulaRow('C6', cumCF.slice(1), (i, colL) => {
    const prev = colLetter(3 + i); // C is col3; prev of C is B, of D is C, ...
    return `${prev}6+${colL}5`;
  });

  // Net CF to LP INCLUDING the terminal residual-NAV harvest (a full-liquidation
  // view). Each year mirrors Net Cash Flow (row 5); the FINAL year also collects
  // the consolidated NAV from the Underlying Funds total — so a NAV mark (the
  // TopFundNAV lever) flows through to a LIVE blended IRR over this row.
  const navTotalsCell = `'Underlying Funds'!E${totalsRow}`;
  const lastCfCol = colLetter(1 + nY); // B..K for the 10 year columns
  cf.label('A7', 'Net CF to LP (incl. residual NAV)');
  cf.formulaRow('B7', netCFwithNAV, (i, colL) => (i === nY - 1 ? `${colL}5+${navTotalsCell}` : `${colL}5`));

  // Blended net IRR over the annual LP net-cashflow row (incl. NAV harvest),
  // written below as a live =IRR() so it recomputes under the NAV-mark lever.
  // computeIRR uses the same NPV-root math as the engine's transpiled IRR().
  const blendedNetIRR = computeIRR(netCFwithNAV);
  // Blended gross IRR: net IRR before the fee/carry drag. FoF fees compress the
  // gross-to-net spread; use a modest, plausible uplift derived from the carry.
  const carryRate = 0.05;     // FoF-level carry (5% over return of capital)
  const mgmtFeeRate = 0.0075; // 0.75% annual FoF management fee (informational)

  // -------------------------------------------------------------------------
  // Blended return math (computed in JS, placed as formulas w/ cached values).
  // TVPI = (Distributions + NAV) / Called ; DPI = Distributions / Called ;
  // RVPI = NAV / Called. Blended IRR from the cashflow XIRR above.
  // -------------------------------------------------------------------------
  const totalValue = r2(totalDistributions + totalNAV);
  const tvpi = totalValue / totalCalled;
  const dpi = totalDistributions / totalCalled;
  const rvpi = totalNAV / totalCalled;

  // Gross IRR ~ net IRR grossed up for the fee/carry drag (modeled as a fixed
  // spread so it has a clean cell identity). Kept inside the IRR range.
  const grossIRRspread = 0.018; // 180bps gross-to-net spread from FoF overlay
  const blendedGrossIRR = blendedNetIRR + grossIRRspread;

  // FoF carry overlay: carryRate of profit above return of called capital.
  const profitAboveCalled = r2(Math.max(0, totalValue - totalCalled));
  const blendedCarry = r2(profitAboveCalled * carryRate);

  // -------------------------------------------------------------------------
  // Sheet 3: "IR Cheat Sheet" — principal-facing blended roll-up.
  // Anchor the equity class with "Total Capital Committed" so detectEquity wires
  // grossIRR within its 20-row search window (label matched by /capital.*committed/).
  // -------------------------------------------------------------------------
  // Annual FoF-level management fee drag ($) — fee rate on committed capital.
  const annualFeeDrag = r2(totalCommitment * mgmtFeeRate);

  const s = m.sheet('IR Cheat Sheet');
  s.label('A1', 'Cedarhill Family Office — Portfolio Returns Cheat Sheet');

  // Inputs block (defined-name levers live here). These are LITERAL value cells
  // so they qualify as app inputs (a defined name on a SUM/formula cell is an
  // OUTPUT, not a lever). TotalCommitment is the family office's committed
  // budget; a reconciliation row checks it against the consolidated SUM.
  s.label('A3', 'Total Capital Committed');      s.value('B3', totalCommitment);
  s.label('A4', 'FoF Carry Rate');               s.value('B4', carryRate);
  s.label('A5', 'FoF Management Fee (annual)');  s.value('B5', mgmtFeeRate);
  // Called % reads the committed-budget lever (B3) — makes B3 load-bearing.
  s.label('A6', 'Total Capital Called');         s.formula('B6', `'Underlying Funds'!C${totalsRow}`, totalCalled);
  s.label('A7', 'Called % of Commitment');       s.formula('B7', 'B6/B3', r6(totalCalled / totalCommitment));

  // Reconciliation: the committed-budget lever should equal the consolidated
  // SUM of per-fund commitments (reads B3 — keeps the lever load-bearing).
  s.label('A9', 'Commitment Reconciliation (vs Sum)'); s.formula('B9', `B3-'Underlying Funds'!B${totalsRow}`, 0);

  // Capital & value block.
  s.label('A11', 'Uncalled Commitment (Dry Powder)'); s.formula('B11', 'B3-B6', totalUncalled);
  s.label('A12', 'Net Asset Value (NAV)');       s.formula('B12', `'Underlying Funds'!E${totalsRow}`, totalNAV);
  s.label('A13', 'Total Distributions');         s.formula('B13', `'Underlying Funds'!F${totalsRow}`, totalDistributions);
  s.label('A14', 'Total Value (Dist + NAV)');    s.formula('B14', 'B13+B12', totalValue);
  // Annual fee drag reads the management-fee lever (B5) — makes B5 load-bearing.
  s.label('A15', 'Annual Fee Drag ($)');         s.formula('B15', 'B3*B5', annualFeeDrag);

  // Blended LP multiples block.
  s.label('A17', 'Blended TVPI');                s.formula('B17', 'B14/B6', r6(tvpi));
  s.label('A18', 'Blended DPI');                 s.formula('B18', 'B13/B6', r6(dpi));
  s.label('A19', 'Blended RVPI');                s.formula('B19', 'B12/B6', r6(rvpi));

  // Blended IRR block — Gross IRR anchored near "Total Capital Committed" (row 3)
  // so the equity detector wires grossIRR. LIVE: IRR over the LP net-cashflow row
  // (incl. NAV harvest) on the Cash Flows sheet — recomputes under the NAV lever.
  s.label('A21', 'Blended Net IRR');             s.formula('B21', `IRR('Cash Flows'!B7:${lastCfCol}7)`, r6(blendedNetIRR));
  s.label('A22', 'Blended Gross IRR');           s.formula('B22', `B21+${grossIRRspread}`, r6(blendedGrossIRR));

  // FoF carry overlay block — reads the carry-rate lever (B4).
  s.label('A24', 'Profit Above Called Capital'); s.formula('B24', 'MAX(0,B14-B6)', profitAboveCalled);
  s.label('A25', 'Blended Carry (FoF Overlay)'); s.formula('B25', 'B24*B4', blendedCarry);

  // -------------------------------------------------------------------------
  // Defined names → app levers. Each MUST be a LITERAL numeric cell read by >=1
  // formula (a defined name on a formula/SUM cell is treated as an output, not
  // an input, and is dropped from named-inputs.json).
  //   TotalCommitment (IR Cheat Sheet!B3) — committed budget; read by Called %
  //                     (B7), dry powder (B11), fee drag (B15), reconciliation (B9).
  //   BlendedCarry    (IR Cheat Sheet!B4) — FoF carry rate; read by B25.
  //   FoFMgmtFee      (IR Cheat Sheet!B5) — FoF mgmt fee; read by fee drag (B15).
  // -------------------------------------------------------------------------
  m.defineName('TotalCommitment', 'IR Cheat Sheet', 'B3');
  m.defineName('BlendedCarry', 'IR Cheat Sheet', 'B4');
  m.defineName('FoFMgmtFee', 'IR Cheat Sheet', 'B5');
  // NAV-mark lever (the classic FoF what-if): the largest underlying fund's NAV.
  // Read by the consolidated NAV SUM (Underlying Funds!E10), so flexing it moves
  // NAV → TVPI/RVPI and the residual-NAV harvest → blended IRR.
  m.defineName('TopFundNAV', 'Underlying Funds', 'E4');

  m.write(outPath);
  return {
    outPath,
    expected: {
      totalCommitment, totalCalled, totalUncalled, totalNAV, totalDistributions,
      totalValue,
      tvpi: r6(tvpi), dpi: r6(dpi), rvpi: r6(rvpi),
      blendedNetIRR: r6(blendedNetIRR), blendedGrossIRR: r6(blendedGrossIRR),
      blendedCarry, carryRate,
    },
  };
}

function r6(x) { return Math.round(x * 1e6) / 1e6; }

// CLI entry
if (process.argv[1]?.endsWith('familyoffice-fof-ir.mjs')) {
  const out = process.argv[2] || 'engines/_personas/familyoffice-fof-ir/model.xlsx';
  const res = build(out);
  console.log('Wrote', res.outPath);
  console.log('Expected:', JSON.stringify(res.expected, null, 2));
}

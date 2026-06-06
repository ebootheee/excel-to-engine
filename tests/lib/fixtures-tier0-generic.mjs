/**
 * Synthetic SECOND Tier-0 fixture (ADR-027 Phase 2 generalization test).
 *
 * A DIFFERENT carry sheet than the GPP-Promote fixture: sheet name "Carry
 * Waterfall", a DIFFERENT value column (G), and DIFFERENT tier / cashflow rows.
 * It is a deliberately MINIMAL, KB-sized, fully-synthetic ground truth (no real
 * financials) built so that:
 *   • the per-tier GP-CF cells SUM EXACTLY to the "Total Carried Interest" cell
 *     (the decomposition invariant detectTier0Layout reconciles on), and
 *   • the 4-tier monthly-accrual SHAPE differs from lib/waterfall's annual
 *     single-hurdle closed form — so the disclosed shapeResidual is non-trivial
 *     (the whole point: a second fixture must assert on the DISCLOSED shapeResidual
 *     bound, not on bit-exact carry, which would spuriously fail).
 *
 * This module exports a builder so both the positive test and the negative-control
 * (mutation) test reuse the same numbers.
 *
 * @license MIT
 */

export const SHEET = 'Carry Waterfall';
export const VALUE_COL = 'G';        // intentionally NOT 'D'
export const TOTAL_ROW = 60;         // intentionally NOT 180

// Per-tier GP cashflow rows (GP-side decomposition). Rows differ from the
// GPP-Promote fixture (128/155/169/177).
export const TIER_ROWS = {
  pref: 31,      // "Tier 1 GP CF" — pref tier, GP share is 0
  catchup: 40,   // "Tier 2 GP CF (Catch-Up)"
  resid1: 47,    // "Tier 3 GPP Distributions"
  resid2: 54,    // "Tier 4 GPP Distributions"
};
export const CF_ROW = 18;            // "Total Cash Flows (pre-carry)"
export const CUM_EQUITY_ROW = 19;    // "Cumulative Equity Drawn"

// Period cashflows (synthetic, in DOLLARS at realistic millions scale so the
// detector's dollar-magnitude gate behaves as it does on real models). Equity
// drawn in periods 0-1 (negative), then distributions. Peak cumulative equity =
// |min cumulative| = the pooled basis.
const M = 1_000_000;
const PRECARRY_CF = [-100, -50, 20, 40, 60, 110, 90].map((x) => x * M); // sum = +170M net proceeds
const CUM_EQUITY  = [-100, -150, -150, -150, -150, -150, -150].map((x) => x * M); // peak draw 150M

// GP-side per-tier dollars (the decomposition). These are the model's OWN split;
// they sum to the carry total by construction. Chosen so the catch-up-heavy split
// (catch-up ~50% of GP) DIFFERS from the annual closed form (which puts more of the
// GP in catch-up), guaranteeing a non-trivial-but-bounded shapeResidual.
const GP_PREF = 0;             // pref tier GP CF is 0 (LP-only)
const GP_CATCHUP = 9.0 * M;    // catch-up
const GP_RESID1 = 5.5 * M;     // residual 8-12%
const GP_RESID2 = 3.5 * M;     // residual >12%
const CARRY_TOTAL = GP_PREF + GP_CATCHUP + GP_RESID1 + GP_RESID2; // 18.0M

export function buildGenericGt() {
  const gt = {};
  const put = (col, row, v) => { gt[`${SHEET}!${col}${row}`] = v; };

  // Labels (col B) — the detector keys off these.
  put('B', TIER_ROWS.pref, 'Tier 1 GP CF');
  put('B', TIER_ROWS.catchup, 'Tier 2 GP CF (Catch-Up)');
  put('B', TIER_ROWS.resid1, 'Tier 3 GPP Distributions');
  put('B', TIER_ROWS.resid2, 'Tier 4 GPP Distributions');
  put('B', CF_ROW, 'Total Cash Flows (pre-carry)');
  put('B', CUM_EQUITY_ROW, 'Cumulative Equity Drawn');
  put('B', TOTAL_ROW, 'Total Carried Interest');
  // Decoy LP-side rows that MUST NOT be picked up (sit beside the GP rows).
  put('B', TIER_ROWS.catchup - 1, 'Tier 2 LP CF');
  put('B', TIER_ROWS.resid1 - 1, 'Tier 3 LP Distributions');
  // Decoy tier-HEADER rate rows (like the GPP fixture's rows 108-111) that carry
  // rate assumptions (0.5 / 0.2), NOT dollars — must be excluded by the detector.
  put('B', 10, 'Tier 2 - Catch Up');
  put('G', 10, 0.5);
  put('B', 11, 'Tier 3: Carried Interest 8.0% to 12.0%');
  put('G', 11, 0.2);

  // Value column (G): per-tier GP dollars.
  put(VALUE_COL, TIER_ROWS.pref, GP_PREF);
  put(VALUE_COL, TIER_ROWS.catchup, GP_CATCHUP);
  put(VALUE_COL, TIER_ROWS.resid1, GP_RESID1);
  put(VALUE_COL, TIER_ROWS.resid2, GP_RESID2);
  put(VALUE_COL, TOTAL_ROW, CARRY_TOTAL);
  // LP decoys carry their own (different) dollar values in G — they must be ignored.
  put(VALUE_COL, TIER_ROWS.catchup - 1, 41.0 * M);
  put(VALUE_COL, TIER_ROWS.resid1 - 1, 12.0 * M);

  // Pre-carry cashflow + cumulative-equity period vectors (cols C..I = periods).
  const periodCols = ['C', 'D', 'E', 'F', 'G', 'H', 'I'];
  // NB: VALUE_COL 'G' is also a period column on the CF rows; that is fine — the
  // CF rows are read as whole-row vectors, the scalar tier rows by value column.
  PRECARRY_CF.forEach((v, i) => { gt[`${SHEET}!${periodCols[i]}${CF_ROW}`] = v; });
  CUM_EQUITY.forEach((v, i) => { gt[`${SHEET}!${periodCols[i]}${CUM_EQUITY_ROW}`] = v; });

  // Minimal equity class + returns cells on a separate sheet.
  gt['Returns!B5'] = 'Equity Invested';
  gt['Returns!C5'] = 150 * M;      // basisCell
  gt['Returns!B6'] = 'Gross MOIC';
  gt['Returns!C6'] = 1.7;          // grossMOIC cross-ref
  gt['Returns!B7'] = 'Gross IRR';
  gt['Returns!C7'] = 0.18;         // grossIRR

  return gt;
}

export function buildGenericManifest() {
  return {
    $schema: 'manifest-v1.0',
    model: {
      name: 'Synthetic Carry Waterfall (Tier-0 generic fixture)',
      type: 'pe_platform',
      source: 'synthetic-carry-waterfall.xlsx',
      groundTruth: './_ground-truth.json',
      engineDir: './',
    },
    equity: {
      classes: [
        { id: 'fund', label: 'Fund', basisCell: 'Returns!C5', grossMOIC: 'Returns!C6', grossIRR: 'Returns!C7' },
      ],
    },
    carry: {
      totalCell: `${SHEET}!${VALUE_COL}${TOTAL_ROW}`,
      tiers: [
        { name: 'Preferred Return', type: 'pref', hurdleValue: 0.08 },
        { name: 'Catch-Up', type: 'catchup', hurdleValue: 0.5 },
        { name: 'Residual', type: 'residual' },
      ],
      waterfall: { prefReturn: 0.08, carryPercent: 0.20 },
    },
  };
}

export const EXPECTED = {
  sheet: SHEET,
  valueCol: VALUE_COL,
  totalRow: TOTAL_ROW,
  tierGpCfCells: [
    `${SHEET}!${VALUE_COL}${TIER_ROWS.pref}`,
    `${SHEET}!${VALUE_COL}${TIER_ROWS.catchup}`,
    `${SHEET}!${VALUE_COL}${TIER_ROWS.resid1}`,
    `${SHEET}!${VALUE_COL}${TIER_ROWS.resid2}`,
  ],
  cfRow: CF_ROW,
  cumEquityRow: CUM_EQUITY_ROW,
  carryTotal: CARRY_TOTAL,
};

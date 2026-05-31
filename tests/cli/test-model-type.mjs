/**
 * test-model-type.mjs — locks detectModelType's asset-class classification.
 *
 * Before the Phase-0 fix, detectModelType knew only 7 types, so credit / search-
 * fund / FoF / infra / RE-debt models fell through to `saas` or `re_fund` and the
 * summary mislabeled their headline numbers (a credit deal's exit metric is
 * leverage, not a revenue multiple). This test asserts each family is recognized
 * from representative ground-truth labels, and — critically — that the previously
 * passing families do NOT regress (the `/arr/`→`/\barr\b/` boundary fix must not
 * stop a real ARR model from reading as SaaS).
 *
 * Pure unit test over label strings — no Rust parser, no engine. Fast.
 *
 * @license MIT
 */
import { detectModelType } from '../../lib/manifest.mjs';

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} — got "${got}", want "${want}"`); }
}

// Build a ground-truth-shaped object {addr: label} from a list of labels.
function gtFrom(labels) {
  const gt = {};
  labels.forEach((l, i) => { gt[`Sheet!A${i + 1}`] = l; });
  return gt;
}

console.log('\nModel-type detection suite\n');

// --- New families (the Phase-0 fix) ---
eq('credit (unitranche / lender)', detectModelType(gtFrom([
  'Unitranche Term Loan — Lender Returns Summary', 'Original Issue Discount (pts)',
  'Credit Spread (bps over base)', 'Interest Coverage (EBITDA / Interest)',
  'Gross IRR (Yield to Lender)', 'Exit Leverage (Debt/EBITDA)',
])), 'credit');

eq('search_fund (SDE / SBA / seller note)', detectModelType(gtFrom([
  'Project Harbor — Deal Assumptions', 'Entry Multiple (x SDE/EBITDA)',
  'SBA 7(a) Loan', 'Seller Note', 'Searcher Carried Equity', 'Adjusted EBITDA / SDE',
])), 'search_fund');

eq('fund_of_funds (underlying funds / blended)', detectModelType(gtFrom([
  'Cedarhill Family Office — Underlying Fund Positions', 'Uncalled Commitment (Dry Powder)',
  'Blended TVPI', 'Blended Net IRR', 'Commitment Reconciliation (vs Sum)',
])), 'fund_of_funds');

eq('infrastructure (CFADS / contracted / project debt)', detectModelType(gtFrom([
  'Cascade Ridge Renewables — Key Assumptions', 'CFADS (Cash Available for Debt Service)',
  'Year 1 Contracted Revenue', 'Project Debt — Coupon', 'Revenue Escalation (annual)',
])), 'infrastructure');

eq('real_estate_debt (lender summary + NOI + debt yield)', detectModelType(gtFrom([
  'Real Estate Debt Portfolio — Lender Summary', 'Consolidated NOI',
  'DSCR (NOI / Debt Service)', 'Debt Yield (NOI / Loan)', 'Portfolio LTV (Loan / Value)',
  'Senior Loan Balance — Closing', 'Stabilized Portfolio Value (Cap Rate Basis)',
])), 'real_estate_debt');

eq('corporate (operating plan + DCF / WACC / Gordon TV)', detectModelType(gtFrom([
  'Northwind Devices — FY Operating Plan & DCF', 'Discounted Cash Flow Valuation ($)',
  'WACC (discount rate)', 'Terminal Value (Gordon growth)', 'Free Cash Flow',
  'Enterprise Value', 'Equity Value',
])), 'corporate');

// A corporate DCF must NOT steal an M&A/LBO sponsor-returns model (the OTHER
// `unknown` persona): it has Enterprise/Equity Value but none of the DCF-unique
// tokens (discounted cash flow / Gordon TV / WACC / operating plan).
eq('ma-sellside LBO is NOT misread as corporate', detectModelType(gtFrom([
  'Exit Enterprise Value', 'Sponsor Equity Invested', 'Gross MOIC', 'Gross IRR',
  'Purchase Multiple (EV/EBITDA)', 'Net Debt at Exit',
])), 'unknown');

// --- Regression: existing families must still classify correctly ---
eq('pe_fund (carried interest / waterfall)', detectModelType(gtFrom([
  'GP Carried Interest', 'Equity Invested', 'LP Preferred Hurdle Value', 'Exit Equity Value',
])), 'pe_fund');

eq('saas (real ARR token survives the \\barr\\b fix)', detectModelType(gtFrom([
  'ARR', 'Net Revenue Retention (NRR)', 'Gross Churn', 'CAC Payback', 'Rule of 40',
])), 'saas');

eq('venture_portfolio (portfolio company / series)', detectModelType(gtFrom([
  'Portfolio Company', 'Series A', 'Series B', 'Follow-on', 'Markup',
])), 'venture_portfolio');

eq('re_fund (NOI / cap rate, no debt-yield headline)', detectModelType(gtFrom([
  'Net Operating Income', 'Exit Cap Rate', 'Occupancy', 'Rental Income', 'Property',
])), 're_fund');

// --- The substring bug this fix closed: "carried"/"carry"/"arrangement" must
//     NOT alone make a model read as SaaS. ---
eq('credit is NOT misread as saas via "arrangement"/"carry"', detectModelType(gtFrom([
  'Unitranche Term Loan', 'Upfront / Arrangement Fee (%)', 'All-in Cash Coupon',
  'Total Cash Returned to Lender', 'Bullet Repayment at Maturity',
])), 'credit');

console.log(`\nResults: ${pass} passed, ${fail} failed, ${pass + fail} total\n`);
process.exit(fail === 0 ? 0 : 1);

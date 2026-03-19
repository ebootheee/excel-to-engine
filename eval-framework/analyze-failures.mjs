/**
 * Failure Pattern Analyzer
 *
 * Reads a comparison-report.json and produces actionable improvement
 * recommendations for the skill. Feed this output to a skill-improver agent.
 *
 * Usage: node eval-framework/analyze-failures.mjs [path-to-comparison-report.json]
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const reportPath = process.argv[2] || resolve(import.meta.dirname, 'comparison-report.json');
const report = JSON.parse(readFileSync(reportPath, 'utf-8'));

console.log('═══════════════════════════════════════════════════');
console.log('  FAILURE PATTERN ANALYSIS');
console.log('═══════════════════════════════════════════════════');
console.log(`  Score: ${report.score}%`);
console.log(`  Pass: ${report.summary.pass} / ${report.summary.total}`);
console.log(`  Fail: ${report.summary.fail}`);
console.log(`  Error: ${report.summary.error}`);
console.log('');

// ─── Categorize failures ───────────────────────────────────────────────────
const categories = {
  moic: { count: 0, totalDev: 0, examples: [] },
  irr: { count: 0, totalDev: 0, examples: [] },
  exitValue: { count: 0, totalDev: 0, examples: [] },
  waterfall: { count: 0, totalDev: 0, examples: [] },
  mip: { count: 0, totalDev: 0, examples: [] },
  perShare: { count: 0, totalDev: 0, examples: [] },
  invariant: { count: 0, totalDev: 0, examples: [] },
  other: { count: 0, totalDev: 0, examples: [] },
};

for (const f of report.failures || []) {
  const label = (f.label || '').toLowerCase();
  const dev = parseFloat(f.deviation) || 0;

  let cat = 'other';
  if (label.includes('moic')) cat = 'moic';
  else if (label.includes('irr')) cat = 'irr';
  else if (label.includes('exit') || label.includes('proceed') || label.includes('debt') || label.includes('cost') || label.includes('equity')) cat = 'exitValue';
  else if (label.includes('lp') || label.includes('gp') || label.includes('carry')) cat = 'waterfall';
  else if (label.includes('mip') || label.includes('incentive') || label.includes('promote')) cat = 'mip';
  else if (label.includes('share') || label.includes('pps')) cat = 'perShare';
  else if (label.includes('trigger') || label.includes('monoton') || label.includes('invariant')) cat = 'invariant';

  categories[cat].count++;
  categories[cat].totalDev += dev;
  if (categories[cat].examples.length < 3) {
    categories[cat].examples.push(f);
  }
}

// ─── Print category analysis ───────────────────────────────────────────────
console.log('FAILURE CATEGORIES:');
console.log('');

const sorted = Object.entries(categories)
  .filter(([, v]) => v.count > 0)
  .sort((a, b) => b[1].count - a[1].count);

for (const [cat, data] of sorted) {
  const avgDev = data.count > 0 ? (data.totalDev / data.count).toFixed(1) : '0';
  console.log(`  📊 ${cat.toUpperCase()}: ${data.count} failures (avg deviation: ${avgDev}%)`);
  for (const ex of data.examples) {
    console.log(`     └─ ${ex.label}: expected=${ex.expected}, actual=${ex.actual} (${ex.deviation})`);
  }
  console.log('');
}

// ─── Generate recommendations ──────────────────────────────────────────────
console.log('RECOMMENDATIONS:');
console.log('');

if (categories.exitValue.count > 0) {
  console.log('  🔧 EXIT VALUES are off. This is usually the root cause of all other failures.');
  console.log('     → Check: Are all 5 exit segments computed? (Owned RE, Leased, Brokered, Tech, Ops/Unalloc)');
  console.log('     → Check: Is debt payoff computed correctly? (Total debt at exit year)');
  console.log('     → Check: Are transaction costs applied? (typically 1-2% of gross exit)');
  console.log('     → Check: Is cash balance added to net proceeds?');
  console.log('');
}

if (categories.moic.count > 0) {
  console.log('  🔧 MOIC deviations. If exit values are also off, fix those first.');
  console.log('     → Check: Equity basis = sum of all equity draws (not total commitment)');
  console.log('     → Check: Gross MOIC = Net Proceeds / Equity Basis (should be calibrated)');
  console.log('     → Check: Net MOIC = LP Total After Carry / Equity Basis');
  console.log('');
}

if (categories.irr.count > 0) {
  console.log('  🔧 IRR deviations. IRR is sensitive to CF timing.');
  console.log('     → Check: Are cash flows in the right years? (draws negative, distributions positive)');
  console.log('     → Check: Is the exit distribution in the correct year?');
  console.log('     → Check: Newton-Raphson convergence (try different initial guesses)');
  console.log('');
}

if (categories.waterfall.count > 0) {
  console.log('  🔧 WATERFALL (LP/GP split) is off.');
  console.log('     → Check: Preferred return rate (typically 8% annual)');
  console.log('     → Check: Catch-up tier (50/50 up to 20% GP share)');
  console.log('     → Check: Residual split (typically 80/20 LP/GP)');
  console.log('     → Check: Monthly vs annual compounding of pref return');
  console.log('');
}

if (categories.mip.count > 0) {
  console.log('  🔧 MIP/INCENTIVE PLAN deviations.');
  console.log('     → Check: MIP hurdle (typically 1.40x MOIC)');
  console.log('     → Check: Dilution rate (typically 10-15% of excess above hurdle)');
  console.log('     → Check: MIP pool shares (fixed number, affects PPS)');
  console.log('     → Consider: MIP calibration offset (monthly vs annual waterfall differences)');
  console.log('');
}

if (categories.invariant.count > 0) {
  console.log('  🔧 INVARIANT violations — structural issues in the engine.');
  console.log('     → Check: Higher exit multiple must produce higher MOIC');
  console.log('     → Check: Earlier exit must produce higher IRR (at same MOIC)');
  console.log('     → Check: MIP triggers only above hurdle MOIC');
  console.log('');
}

// ─── Error analysis ────────────────────────────────────────────────────────
if ((report.errors || []).length > 0) {
  console.log('ERRORS (engine crashes):');
  for (const e of report.errors.slice(0, 5)) {
    console.log(`  💥 ${e.label}: ${e.error}`);
  }
  console.log('');
  console.log('  → These likely mean the engine doesn\'t handle certain input combinations.');
  console.log('  → Check: exit year out of range, zero sites, extreme multiples.');
  console.log('');
}

// ─── Score trajectory advice ───────────────────────────────────────────────
console.log('PRIORITY ORDER:');
console.log('  1. Fix exit value calculations (cascades to MOIC, IRR, waterfall, MIP)');
console.log('  2. Calibrate base case (MOIC, IRR should match Excel exactly)');
console.log('  3. Fix waterfall tiers (LP/GP split)');
console.log('  4. Calibrate MIP (add mipScale if needed)');
console.log('  5. Fix invariants (structural logic)');

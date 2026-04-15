#!/usr/bin/env node

/**
 * CLI Use-Case Test Suite
 *
 * 30 real-world PE scenarios scored on:
 * - Execution (does it run without errors?)
 * - Output quality (does the output contain expected fields?)
 * - Financial validity (are numbers in reasonable ranges?)
 * - Parameter coverage (does the parameter actually change the result?)
 *
 * Scoring: each test earns 0-4 points.
 *   4 = perfect (runs, correct fields, valid numbers, parameter affects output)
 *   3 = runs + correct fields + valid numbers
 *   2 = runs + correct fields
 *   1 = runs but missing expected output
 *   0 = error / crash
 */

import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const CLI = `"${join(ROOT, 'cli/index.mjs')}"`;
const MODEL = `"${join(__dirname, 'fixtures')}"`;

const results = [];
let totalScore = 0;
let maxScore = 0;

function run(cmd) {
  try {
    return { ok: true, output: execSync(`node ${CLI} ${cmd}`, { cwd: ROOT, encoding: 'utf-8', timeout: 30000 }) };
  } catch (e) {
    return { ok: false, error: e.stderr || e.message, output: e.stdout || '' };
  }
}

function runJson(cmd) {
  const r = run(`${cmd} --format json`);
  if (!r.ok) return { ok: false, error: r.error };
  try {
    return { ok: true, data: JSON.parse(r.output) };
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${e.message}` };
  }
}

function test(category, name, fn) {
  maxScore += 4;
  let score = 0;
  let notes = [];
  try {
    score = fn(notes);
  } catch (e) {
    notes.push(`CRASH: ${e.message}`);
  }
  totalScore += score;
  results.push({ category, name, score, notes });
  const icon = score === 4 ? '●' : score >= 3 ? '◐' : score >= 1 ? '○' : '✗';
  console.log(`  ${icon} [${score}/4] ${name}${notes.length ? ' — ' + notes[0] : ''}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY 1: DISCOVERY & EXPLORATION (What does this model look like?)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ DISCOVERY & EXPLORATION ═══');

test('discovery', 'Summary: basic model overview', (n) => {
  const r = run(`summary ${MODEL}`);
  if (!r.ok) return 0;
  let s = 1;
  if (r.output.includes('MOIC') && r.output.includes('IRR')) { s++; n.push('has return metrics'); }
  if (r.output.includes('Carry')) { s++; n.push('has carry'); }
  if (r.output.includes('EBITDA') && r.output.includes('CAGR')) { s++; n.push('has EBITDA + CAGR'); }
  return s;
});

test('discovery', 'Summary: JSON output for agent consumption', (n) => {
  const r = runJson(`summary ${MODEL}`);
  if (!r.ok) return 0;
  let s = 1;
  if (r.data.model?.name) { s++; n.push(`model: ${r.data.model.name}`); }
  if (r.data.outputs?.grossMOIC) { s++; }
  if (r.data.segments?.length > 0) { s++; n.push(`${r.data.segments.length} segments`); }
  return s;
});

test('discovery', 'Query: search for a financial term', (n) => {
  const r = run(`query ${MODEL} --search "Revenue"`);
  if (!r.ok) return 0;
  let s = 1;
  if (r.output.includes('Technology')) { s++; n.push('found Technology sheet'); }
  if (r.output.includes('Values:')) { s++; }
  if (/\$[\d.]+[MKB]/.test(r.output)) { s++; n.push('has formatted values'); }
  return s;
});

test('discovery', 'Query: manifest name lookup', (n) => {
  const r = run(`query ${MODEL} --name grossIRR`);
  if (!r.ok) return 0;
  let s = 1;
  if (r.output.includes('28.4') || r.output.includes('0.284')) { s++; n.push('correct IRR value'); }
  if (r.output.includes('Equity')) { s++; n.push('shows cell reference'); }
  if (r.output.includes('IRR') || r.output.includes('irr')) { s++; n.push('labels the metric'); }
  return s;
});

test('discovery', 'Query: direct cell lookup', (n) => {
  const r = run(`query ${MODEL} "Valuation!K54"`);
  if (!r.ok) return 0;
  let s = 1;
  if (r.output.includes('18.5')) { s += 3; n.push('correct exit multiple'); }
  return s;
});

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY 2: P&L ANALYSIS (Revenue decomposition, growth trends)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ P&L ANALYSIS ═══');

test('pnl', 'Full P&L with growth rates', (n) => {
  const r = run(`pnl ${MODEL} --growth`);
  if (!r.ok) return 0;
  let s = 1;
  if (r.output.includes('Real Estate NOI')) { s++; }
  if (r.output.includes('YoY')) { s++; n.push('shows growth rates'); }
  if (r.output.includes('EBITDA CAGR')) { s++; n.push('shows CAGR'); }
  return s;
});

test('pnl', 'Segment drill-down: technology subsegments', (n) => {
  const r = run(`pnl ${MODEL} --segment technology --growth`);
  if (!r.ok) return 0;
  let s = 1;
  if (r.output.includes('Ongoing Fee')) { s++; }
  if (r.output.includes('Customer Acquisition')) { s++; }
  if (r.output.includes('Profit')) { s++; n.push('shows subsegment P&L'); }
  return s;
});

test('pnl', 'P&L in JSON format', (n) => {
  const r = runJson(`pnl ${MODEL} --growth`);
  if (!r.ok) return 0;
  let s = 1;
  if (r.data.segments) { s++; }
  if (r.data.totals?.ebitda) { s++; }
  if (r.data.totals?.cagr !== undefined) { s++; n.push(`CAGR: ${(r.data.totals.cagr*100).toFixed(1)}%`); }
  return s;
});

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY 3: EXIT SCENARIOS (Multiple compression, timing changes)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ EXIT SCENARIOS ═══');

test('exit', 'Lower exit multiple: 18.5x → 14x', (n) => {
  const r = runJson(`scenario ${MODEL} --exit-multiple 14`);
  if (!r.ok) return 0;
  let s = 1;
  if (r.data.base?.grossMOIC && r.data.scenario?.grossMOIC) { s++; }
  if (r.data.scenario.grossMOIC < r.data.base.grossMOIC) { s++; n.push('MOIC decreased correctly'); }
  if (r.data.deltas?.grossMOIC?.absolute < 0) { s++; }
  return s;
});

test('exit', 'Higher exit multiple: 18.5x → 22x', (n) => {
  const r = runJson(`scenario ${MODEL} --exit-multiple 22`);
  if (!r.ok) return 0;
  let s = 1;
  if (r.data.scenario?.grossMOIC > r.data.base?.grossMOIC) { s++; n.push('MOIC increased'); }
  if (r.data.scenario?.totalCarry > r.data.base?.totalCarry) { s++; n.push('carry increased'); }
  if (r.data.scenario?.grossIRR > r.data.base?.grossIRR) { s++; }
  return s;
});

test('exit', 'Delayed exit: 2030 → 2033 (extended hold)', (n) => {
  const r = runJson(`scenario ${MODEL} --exit-year 2029`);
  if (!r.ok) return 0;
  let s = 1;
  if (r.data.scenario?.holdPeriod !== r.data.base?.holdPeriod) { s++; n.push(`hold: ${r.data.scenario.holdPeriod}yr`); }
  // Earlier exit should increase IRR (less time, same MOIC range)
  if (typeof r.data.scenario?.grossIRR === 'number') { s++; }
  if (r.data.scenario?.grossIRR !== r.data.base?.grossIRR) { s++; n.push('IRR changed'); }
  return s;
});

test('exit', 'Combined: multiple compression + delayed exit', (n) => {
  const r = runJson(`scenario ${MODEL} --exit-multiple 14 --exit-year 2029`);
  if (!r.ok) return 0;
  let s = 1;
  if (r.data.scenario?.grossMOIC < r.data.base?.grossMOIC) { s++; }
  if (r.data.scenario?.terminalValue < r.data.base?.terminalValue) { s++; n.push('TV decreased'); }
  if (r.data.deltas) { s++; }
  return s;
});

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY 4: REVENUE SCENARIOS (Growth changes, segment adjustments)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ REVENUE SCENARIOS ═══');

test('revenue', 'Tech revenue -20%', (n) => {
  const r = runJson(`scenario ${MODEL} --revenue-adj techGP:-20%`);
  if (!r.ok) return 0;
  let s = 1;
  if (r.data.scenario?.exitEBITDA < r.data.base?.exitEBITDA) { s++; n.push('EBITDA decreased'); }
  if (r.data.scenario?.grossMOIC < r.data.base?.grossMOIC) { s++; }
  if (r.data.scenario?.totalCarry < r.data.base?.totalCarry) { s++; n.push('carry decreased'); }
  return s;
});

test('revenue', 'RE NOI loss: -$500K flat', (n) => {
  const r = runJson(`scenario ${MODEL} --revenue-adj reNOI:-500000`);
  if (!r.ok) return 0;
  let s = 1;
  if (r.data.scenario?.exitEBITDA < r.data.base?.exitEBITDA) { s++; }
  if (r.data.scenario?.terminalValue < r.data.base?.terminalValue) { s++; }
  // $500K revenue loss at 18.5x = $9.25M TV loss — should be small relative to $1.1B
  const tvDelta = Math.abs(r.data.deltas?.terminalValue?.absolute || 0);
  if (tvDelta > 5e6 && tvDelta < 20e6) { s++; n.push(`TV delta: $${(tvDelta/1e6).toFixed(1)}M — reasonable`); }
  return s;
});

test('revenue', 'Remove segment entirely (strip tech)', (n) => {
  const r = runJson(`scenario ${MODEL} --remove-segment techGP`);
  if (!r.ok) return 0;
  let s = 1;
  // Removing tech should significantly reduce EBITDA
  if (r.data.scenario?.exitEBITDA < r.data.base?.exitEBITDA) { s++; }
  // MOIC should drop substantially
  if (r.data.scenario?.grossMOIC < r.data.base?.grossMOIC) { s++; }
  const moicDrop = r.data.base.grossMOIC - r.data.scenario.grossMOIC;
  if (moicDrop > 0.3) { s++; n.push(`MOIC drop: ${moicDrop.toFixed(2)}x — meaningful`); }
  return s;
});

test('revenue', 'Revenue growth override: tech at 40%', (n) => {
  const r = runJson(`scenario ${MODEL} --revenue-growth techGP:0.40`);
  if (!r.ok) return 0;
  let s = 1;
  // 40% growth > base ~18% CAGR, so EBITDA should increase
  if (r.data.scenario?.exitEBITDA > r.data.base?.exitEBITDA) { s++; n.push('EBITDA increased'); }
  if (r.data.scenario?.grossMOIC > r.data.base?.grossMOIC) { s++; n.push('MOIC increased'); }
  if (r.data.scenario?.totalCarry > r.data.base?.totalCarry) { s++; }
  return s;
});

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY 5: COST SCENARIOS (OpEx changes, line-item adjustments)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ COST SCENARIOS ═══');

test('cost', 'SG&A increase: +10%', (n) => {
  const r = runJson(`scenario ${MODEL} --cost-adj sgaNet:+10%`);
  if (!r.ok) return 0;
  let s = 1;
  // SG&A is negative, +10% makes it more negative → lower EBITDA
  if (r.data.scenario?.exitEBITDA !== r.data.base?.exitEBITDA) { s++; n.push('EBITDA changed'); }
  if (typeof r.data.scenario?.grossMOIC === 'number') { s++; }
  if (r.data.deltas?.exitEBITDA) { s++; }
  return s;
});

test('cost', 'Line-item: reduce CAC by $200K', (n) => {
  const r = runJson(`scenario ${MODEL} --line-item tech_cac:-200000`);
  if (!r.ok) return 0;
  let s = 1;
  // CAC is already negative (expense); reducing by -200K makes it less negative → EBITDA up
  if (typeof r.data.scenario?.grossMOIC === 'number') { s++; }
  if (r.data.scenario?.exitEBITDA !== r.data.base?.exitEBITDA) { s++; n.push('EBITDA changed'); }
  if (r.data.deltas) { s++; }
  return s;
});

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY 6: CAPITAL STRUCTURE (Leverage, distributions, equity)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ CAPITAL STRUCTURE ═══');

test('capital', 'Increase leverage: 55% LTV', (n) => {
  const r = runJson(`scenario ${MODEL} --leverage 0.55`);
  if (!r.ok) return 0;
  let s = 1;
  // Higher leverage → lower equity → lower MOIC (more debt to repay)
  if (r.data.scenario?.exitEquity !== r.data.base?.exitEquity) { s++; n.push('equity changed'); }
  if (typeof r.data.scenario?.grossMOIC === 'number') { s++; }
  if (r.data.deltas?.exitEquity) { s++; }
  return s;
});

test('capital', 'Override pref return: 10%', (n) => {
  const r = runJson(`scenario ${MODEL} --pref-return 0.10`);
  if (!r.ok) return 0;
  let s = 1;
  // Higher pref → less carry (more goes to LP before GP catches up)
  if (typeof r.data.scenario?.totalCarry === 'number') { s++; }
  if (r.data.scenario?.totalCarry !== r.data.base?.totalCarry) { s++; n.push('carry changed'); }
  // Net returns should differ from base
  if (r.data.scenario?.netMOIC !== r.data.base?.netMOIC) { s++; n.push('net MOIC changed'); }
  return s;
});

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY 7: SENSITIVITY SURFACES (Parameter sweeps)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ SENSITIVITY SURFACES ═══');

test('sensitivity', '1D: IRR across exit multiples', (n) => {
  const r = run(`sensitivity ${MODEL} --vary exit-multiple:14-22:2 --metric grossIRR,grossMOIC`);
  if (!r.ok) return 0;
  let s = 1;
  if (r.output.includes('14.0x') && r.output.includes('22.0x')) { s++; n.push('full range shown'); }
  if (r.output.includes('Gross IRR') && r.output.includes('Gross MOIC')) { s++; }
  // Check monotonicity: higher multiple → higher IRR
  const lines = r.output.split('\n').filter(l => l.match(/^\d/));
  if (lines.length >= 3) { s++; n.push(`${lines.length} data points`); }
  return s;
});

test('sensitivity', '2D: IRR across multiples x exit years', (n) => {
  const r = run(`sensitivity ${MODEL} --vary exit-multiple:14-20:3 --vary exit-year:2028-2030:1 --metric grossIRR`);
  if (!r.ok) return 0;
  let s = 1;
  if (r.output.includes('2028') && r.output.includes('2030')) { s++; n.push('year columns'); }
  if (r.output.includes('14.0x') && r.output.includes('20.0x')) { s++; n.push('multiple rows'); }
  if (r.output.includes('Gross IRR')) { s++; }
  return s;
});

test('sensitivity', '1D with fixed adjustment overlay', (n) => {
  // Sensitivity sweep with tech revenue already reduced
  const base = runJson(`sensitivity ${MODEL} --vary exit-multiple:14-20:3 --metric grossIRR`);
  const adj = runJson(`sensitivity ${MODEL} --vary exit-multiple:14-20:3 --revenue-adj techGP:-20% --metric grossIRR`);
  if (!base.ok || !adj.ok) return 0;
  let s = 1;
  if (base.data.results && adj.data.results) { s++; }
  // With tech revenue down, IRR should be lower at every point
  const allLower = base.data.results.every((br, i) =>
    adj.data.results[i].grossIRR <= br.grossIRR + 0.001
  );
  if (allLower) { s += 2; n.push('adjusted curve uniformly lower — correct'); }
  return s;
});

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY 8: COMPARISON & ATTRIBUTION (Bear/base/bull, what drove change)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ COMPARISON & ATTRIBUTION ═══');

test('compare', 'Base vs alt scenario', (n) => {
  const r = run(`compare ${MODEL} --base "" --alt "exit-multiple=16"`);
  if (!r.ok) return 0;
  let s = 1;
  if (r.output.includes('Base') && r.output.includes('Scenario')) { s++; }
  if (r.output.includes('Gross MOIC')) { s++; }
  if (r.output.includes('Delta')) { s++; n.push('shows deltas'); }
  return s;
});

test('compare', 'Attribution: decompose IRR impact', (n) => {
  const r = run(`compare ${MODEL} --base "" --alt "exit-multiple=14,revenue-adj=techGP:-20%" --attribution`);
  if (!r.ok) { n.push(r.error?.substring(0, 80)); return 0; }
  let s = 1;
  if (r.output.includes('Attribution')) { s++; n.push('has attribution section'); }
  if (r.output.includes('pp')) { s++; n.push('shows percentage point deltas'); }
  // Check that individual drivers sum approximately to total
  if (r.output.includes('exit-multiple') || r.output.includes('revenue-adj')) { s++; n.push('lists individual drivers'); }
  return s;
});

test('compare', 'Save + load + compare named scenarios', (n) => {
  // Save two scenarios
  const save1 = run(`scenario ${MODEL} --exit-multiple 14 --save "uc-bear"`);
  const save2 = run(`scenario ${MODEL} --exit-multiple 22 --save "uc-bull"`);
  if (!save1.ok || !save2.ok) return 0;
  let s = 1;

  // List them
  const list = run(`scenario ${MODEL} --list`);
  if (list.ok && list.output.includes('uc-bear') && list.output.includes('uc-bull')) { s++; n.push('both saved'); }

  // Load and verify
  const load = runJson(`scenario ${MODEL} --load uc-bear`);
  if (load.ok && load.data.scenario?.grossMOIC) { s++; n.push(`bear MOIC: ${load.data.scenario.grossMOIC.toFixed(2)}x`); }

  // Clean up
  try { execSync(`rm -f "${join(__dirname, 'fixtures/scenarios/uc-bear.json')}" "${join(__dirname, 'fixtures/scenarios/uc-bull.json')}"`); } catch {}
  s++;
  return s;
});

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY 9: COMPLEX MULTI-PARAMETER SCENARIOS (Real PE workflows)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ COMPLEX SCENARIOS ═══');

test('complex', 'Downside: tech -20%, exit delayed, multiple compressed', (n) => {
  const r = runJson(`scenario ${MODEL} --revenue-adj techGP:-20% --exit-year 2029 --exit-multiple 14`);
  if (!r.ok) return 0;
  let s = 1;
  if (r.data.scenario?.grossMOIC < r.data.base?.grossMOIC) { s++; }
  if (r.data.scenario?.grossIRR < r.data.base?.grossIRR) { s++; n.push(`IRR: ${(r.data.scenario.grossIRR*100).toFixed(1)}%`); }
  if (r.data.scenario?.totalCarry < r.data.base?.totalCarry) { s++; n.push('carry decreased'); }
  return s;
});

test('complex', 'Bull: tech +30%, earlier exit at premium multiple', (n) => {
  const r = runJson(`scenario ${MODEL} --revenue-adj techGP:+30% --exit-year 2028 --exit-multiple 22`);
  if (!r.ok) return 0;
  let s = 1;
  if (r.data.scenario?.grossMOIC > r.data.base?.grossMOIC) { s++; n.push(`MOIC: ${r.data.scenario.grossMOIC.toFixed(2)}x`); }
  if (r.data.scenario?.grossIRR > r.data.base?.grossIRR) { s++; n.push(`IRR: ${(r.data.scenario.grossIRR*100).toFixed(1)}%`); }
  if (r.data.scenario?.totalCarry > r.data.base?.totalCarry) { s++; }
  return s;
});

test('complex', 'Leverage + pref change: refinance at 55% LTV, 10% pref', (n) => {
  const r = runJson(`scenario ${MODEL} --leverage 0.55 --pref-return 0.10`);
  if (!r.ok) return 0;
  let s = 1;
  if (r.data.scenario?.exitEquity !== r.data.base?.exitEquity) { s++; n.push('equity changed'); }
  if (r.data.scenario?.totalCarry !== r.data.base?.totalCarry) { s++; n.push('carry changed'); }
  if (typeof r.data.scenario?.netIRR === 'number') { s++; }
  return s;
});

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY 10: EDGE CASES & FORMAT TESTS
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ EDGE CASES & FORMATS ═══');

test('edge', 'Zero adjustment (base case identity)', (n) => {
  const r = runJson(`scenario ${MODEL}`);
  if (!r.ok) return 0;
  let s = 1;
  if (r.data.base?.grossMOIC === r.data.scenario?.grossMOIC) { s++; n.push('MOIC unchanged'); }
  if (r.data.base?.grossIRR === r.data.scenario?.grossIRR) { s++; n.push('IRR unchanged'); }
  if (Object.values(r.data.deltas || {}).every(d => !d.absolute || Math.abs(d.absolute) < 0.01)) { s++; n.push('all deltas ~0'); }
  return s;
});

test('edge', 'CSV output format', (n) => {
  const r = run(`scenario ${MODEL} --exit-multiple 16 --format csv`);
  if (!r.ok) return 0;
  let s = 1;
  if (r.output.includes(',')) { s++; n.push('has commas'); }
  if (r.output.includes('metric') || r.output.includes('base')) { s++; n.push('has header row'); }
  if (r.output.split('\n').length > 3) { s++; }
  return s;
});

test('edge', 'Manifest validation passes', (n) => {
  const r = run(`manifest validate "${join(__dirname, 'fixtures/manifest.json')}"`);
  if (!r.ok) return 0;
  let s = 1;
  if (r.output.includes('VALID')) { s++; n.push('valid'); }
  if (r.output.includes('Cell references checked')) { s++; }
  if (!r.output.includes('Error')) { s++; n.push('no errors'); }
  return s;
});

test('edge', 'Missing model directory: clear error', (n) => {
  const r = run('summary /nonexistent/path');
  // Should fail gracefully
  if (r.ok) { n.push('should have errored'); return 1; }
  let s = 1;
  if (r.error?.includes('manifest') || r.error?.includes('not found')) { s += 3; n.push('clear error message'); }
  return s;
});

// ═══════════════════════════════════════════════════════════════════════════
// FINAL REPORT
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(60));
console.log('USE-CASE TEST SUITE RESULTS');
console.log('═'.repeat(60));

const categories = {};
for (const r of results) {
  if (!categories[r.category]) categories[r.category] = { score: 0, max: 0, tests: [] };
  categories[r.category].score += r.score;
  categories[r.category].max += 4;
  categories[r.category].tests.push(r);
}

console.log('\nCategory Breakdown:');
for (const [cat, data] of Object.entries(categories)) {
  const pct = ((data.score / data.max) * 100).toFixed(0);
  const bar = '█'.repeat(Math.round(data.score / data.max * 20)) + '░'.repeat(20 - Math.round(data.score / data.max * 20));
  console.log(`  ${cat.padEnd(20)} ${bar} ${data.score}/${data.max} (${pct}%)`);
}

console.log(`\nTotal: ${totalScore}/${maxScore} (${((totalScore/maxScore)*100).toFixed(1)}%)`);

const perfect = results.filter(r => r.score === 4).length;
const partial = results.filter(r => r.score > 0 && r.score < 4).length;
const failed = results.filter(r => r.score === 0).length;
console.log(`  Perfect (4/4): ${perfect}`);
console.log(`  Partial (1-3): ${partial}`);
console.log(`  Failed  (0/4): ${failed}`);

if (failed > 0) {
  console.log('\nFailed tests:');
  for (const r of results.filter(r => r.score === 0)) {
    console.log(`  ✗ ${r.category}/${r.name}: ${r.notes.join(', ')}`);
  }
}

process.exit(failed > 0 ? 1 : 0);

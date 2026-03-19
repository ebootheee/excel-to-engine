/**
 * Blind Evaluation Comparator
 *
 * Compares a candidate engine's outputs against the control baseline.
 * The candidate engine must export computeModel(inputs) and computeModelA2(inputs)
 * with the same input/output interface.
 *
 * Usage:
 *   node eval-framework/compare-outputs.mjs <path-to-candidate-engine-dir>
 *
 * The candidate directory must contain:
 *   - engine.js    (exports computeModel)
 *   - engine-a2.js (exports computeModelA2)
 *
 * Output: eval-framework/comparison-report.json + console summary
 */

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readFileSync, writeFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Load control baseline ─────────────────────────────────────────────────
const controlPath = resolve(__dirname, 'control-baseline.json');
const control = JSON.parse(readFileSync(controlPath, 'utf-8'));

// ─── Load candidate engines ────────────────────────────────────────────────
const candidateDir = process.argv[2];
if (!candidateDir) {
  console.error('Usage: node compare-outputs.mjs <path-to-candidate-engine-dir>');
  console.error('  The directory must contain engine.js and engine-a2.js');
  process.exit(1);
}

const candidatePath = resolve(candidateDir);
let computeModel, computeModelA2;

try {
  const eng1 = await import(resolve(candidatePath, 'engine.js'));
  computeModel = eng1.computeModel;
  if (!computeModel) throw new Error('engine.js must export computeModel');
} catch (e) {
  console.error(`Failed to load engine.js from ${candidatePath}: ${e.message}`);
  process.exit(1);
}

try {
  const eng2 = await import(resolve(candidatePath, 'engine-a2.js'));
  computeModelA2 = eng2.computeModelA2;
  if (!computeModelA2) throw new Error('engine-a2.js must export computeModelA2');
} catch (e) {
  console.error(`Failed to load engine-a2.js from ${candidatePath}: ${e.message}`);
  process.exit(1);
}

console.log(`\n🔬 Blind Evaluation: Comparing candidate at ${candidatePath}`);
console.log(`   Control: ${control.metadata.generatedAt}\n`);

// ─── Comparison helpers ────────────────────────────────────────────────────
function pctDiff(actual, expected) {
  if (expected === 0) return actual === 0 ? 0 : Infinity;
  return Math.abs(actual - expected) / Math.abs(expected);
}

function round(v, d = 6) {
  if (v == null || isNaN(v)) return null;
  return Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
}

const results = { pass: 0, fail: 0, error: 0, details: [] };
const tolerances = control.tolerances;

function compare(actual, expected, label, toleranceKey) {
  if (expected === null || expected === undefined) return; // skip missing control values
  if (actual === null || actual === undefined) {
    results.fail++;
    results.details.push({ label, status: 'FAIL', reason: 'candidate returned null/undefined', expected });
    return;
  }
  if (typeof expected === 'boolean') {
    const pass = actual === expected;
    if (pass) { results.pass++; }
    else {
      results.fail++;
      results.details.push({ label, status: 'FAIL', actual, expected });
    }
    return;
  }
  const tol = tolerances[toleranceKey] || 0.05;
  const diff = pctDiff(actual, expected);
  if (diff <= tol) {
    results.pass++;
  } else {
    results.fail++;
    results.details.push({
      label,
      status: 'FAIL',
      actual: round(actual, 6),
      expected: round(expected, 6),
      deviation: `${(diff * 100).toFixed(2)}%`,
      tolerance: `${(tol * 100).toFixed(1)}%`,
    });
  }
}

function extractAndCompare(model, controlOutputs, prefix) {
  if (!model || !controlOutputs) return;
  compare(model.returns?.grossMOIC, controlOutputs.grossMOIC, `${prefix} Gross MOIC`, 'moic');
  compare(model.returns?.netMOIC, controlOutputs.netMOIC, `${prefix} Net MOIC`, 'moic');
  compare(model.returns?.grossIRR, controlOutputs.grossIRR, `${prefix} Gross IRR`, 'irr');
  compare(model.returns?.netIRR, controlOutputs.netIRR, `${prefix} Net IRR`, 'irr');
  compare(model.exitValuation?.grossExitValue, controlOutputs.grossExitValue, `${prefix} Gross Exit`, 'exitValue');
  compare(model.exitValuation?.netProceeds, controlOutputs.netProceeds, `${prefix} Net Proceeds`, 'exitValue');
  compare(model.waterfall?.lpTotal, controlOutputs.lpTotal, `${prefix} LP Total`, 'exitValue');
  compare(model.waterfall?.gpCarry, controlOutputs.gpCarry, `${prefix} GP Carry`, 'exitValue');
  compare(model.mip?.triggered, controlOutputs.mipTriggered, `${prefix} MIP Triggered`, 'invariants');
  compare(model.mip?.payment, controlOutputs.mipPayment, `${prefix} MIP Payment`, 'mip');
  compare(model.mip?.valuePerShare, controlOutputs.mipValuePerShare, `${prefix} MIP PPS`, 'perShare');
}

// ─── Run A-1 Scenarios ─────────────────────────────────────────────────────
console.log('--- A-1 Scenarios ---');
let a1Pass = 0, a1Fail = 0, a1Error = 0;

for (const scenario of control.a1Scenarios) {
  if (scenario.error) continue; // skip scenarios that errored in control
  const prevPass = results.pass;
  const prevFail = results.fail;
  try {
    const model = computeModel(scenario.inputs);
    extractAndCompare(model, scenario.outputs, scenario.outputs.label);
  } catch (e) {
    results.error++;
    a1Error++;
    results.details.push({ label: scenario.outputs?.label || 'A1 scenario', status: 'ERROR', error: e.message });
  }
  a1Pass += results.pass - prevPass;
  a1Fail += results.fail - prevFail;
}
console.log(`  A-1: ${a1Pass} pass, ${a1Fail} fail, ${a1Error} errors (${control.a1Scenarios.length} scenarios)`);

// ─── Run A-2 Scenarios ─────────────────────────────────────────────────────
console.log('--- A-2 Scenarios ---');
let a2Pass = 0, a2Fail = 0, a2Error = 0;

for (const scenario of control.a2Scenarios) {
  if (scenario.error) continue;
  const prevPass = results.pass;
  const prevFail = results.fail;
  try {
    const model = computeModelA2(scenario.inputs);
    extractAndCompare(model, scenario.outputs, scenario.outputs.label);
  } catch (e) {
    results.error++;
    a2Error++;
    results.details.push({ label: scenario.outputs?.label || 'A2 scenario', status: 'ERROR', error: e.message });
  }
  a2Pass += results.pass - prevPass;
  a2Fail += results.fail - prevFail;
}
console.log(`  A-2: ${a2Pass} pass, ${a2Fail} fail, ${a2Error} errors (${control.a2Scenarios.length} scenarios)`);

// ─── Run Invariants ────────────────────────────────────────────────────────
console.log('--- Invariants ---');
let invPass = 0, invFail = 0;

for (const inv of control.invariants) {
  // The control baseline stores whether each invariant holds (true/false).
  // We re-derive the same check from the candidate engine.
  let holds = false;
  try {
    if (inv.rule.includes('higher Gross MOIC')) {
      // "A1: 22x multiple > 18.22x multiple → higher Gross MOIC"
      // lo and hi stored in control as .lo and .hi (MOIC values)
      // Parse the two multiples from the rule
      const match = inv.rule.match(/([\d.]+)x multiple > ([\d.]+)x multiple/);
      if (match) {
        const hiMult = parseFloat(match[1]);
        const loMult = parseFloat(match[2]);
        const mLo = computeModel({ ownedExitMultiple: loMult });
        const mHi = computeModel({ ownedExitMultiple: hiMult });
        holds = mHi.returns.grossMOIC > mLo.returns.grossMOIC;
      }
    } else if (inv.rule.includes('higher Gross IRR')) {
      // "A1 at 22x: exit 2028 > exit 2029 → higher Gross IRR"
      const match = inv.rule.match(/at ([\d.]+)x.*exit (\d{4}).*exit (\d{4})/);
      if (match) {
        const mult = parseFloat(match[1]);
        const earlyYear = parseInt(match[2]);
        const lateYear = parseInt(match[3]);
        const mEarly = computeModel({ exitYear: earlyYear, ownedExitMultiple: mult });
        const mLate = computeModel({ exitYear: lateYear, ownedExitMultiple: mult });
        holds = mEarly.returns.grossIRR > mLate.returns.grossIRR;
      }
    } else if (inv.rule.includes('NOT trigger')) {
      const match = inv.rule.match(/([\d.]+)x multiple/);
      if (match) {
        const m = computeModel({ ownedExitMultiple: parseFloat(match[1]) });
        holds = !m.mip.triggered;
      }
    } else if (inv.rule.includes('SHOULD trigger')) {
      const match = inv.rule.match(/([\d.]+)x multiple/);
      if (match) {
        const m = computeModel({ ownedExitMultiple: parseFloat(match[1]) });
        holds = m.mip.triggered;
      }
    } else if (inv.rule.includes('issuance')) {
      // "A2: $1.50 issuance > $1.35 issuance → higher per-share gross"
      const match = inv.rule.match(/\$([\d.]+).*>\s*\$([\d.]+)/);
      if (match) {
        const hiPrice = parseFloat(match[1]);
        const loPrice = parseFloat(match[2]);
        const mLo = computeModelA2({ issuancePrice: loPrice });
        const mHi = computeModelA2({ issuancePrice: hiPrice });
        holds = (mHi.perShare?.gross || 0) > (mLo.perShare?.gross || 0);
      }
    } else {
      holds = inv.holds;
    }
  } catch (e) {
    holds = false;
  }

  if (holds === inv.holds) {
    invPass++;
    results.pass++;
  } else {
    invFail++;
    results.fail++;
    results.details.push({ label: inv.rule, status: 'FAIL', expected: inv.holds, actual: holds });
  }
}
console.log(`  Invariants: ${invPass} pass, ${invFail} fail`);

// ─── Summary ───────────────────────────────────────────────────────────────
const total = results.pass + results.fail + results.error;
const score = total > 0 ? ((results.pass / total) * 100).toFixed(1) : '0.0';

console.log(`\n${'═'.repeat(60)}`);
console.log(`  BLIND EVALUATION RESULTS`);
console.log(`${'═'.repeat(60)}`);
console.log(`  Total comparisons: ${total}`);
console.log(`  Passed: ${results.pass} (${score}%)`);
console.log(`  Failed: ${results.fail}`);
console.log(`  Errors: ${results.error}`);
console.log(`${'═'.repeat(60)}`);

if (results.fail > 0) {
  console.log(`\n  Failed comparisons (first 20):`);
  for (const d of results.details.filter(d => d.status === 'FAIL').slice(0, 20)) {
    console.log(`  ❌ ${d.label}: expected=${d.expected}, actual=${d.actual} (${d.deviation || 'mismatch'})`);
  }
}
if (results.error > 0) {
  console.log(`\n  Errors (first 10):`);
  for (const d of results.details.filter(d => d.status === 'ERROR').slice(0, 10)) {
    console.log(`  💥 ${d.label}: ${d.error}`);
  }
}

// Write full report
const reportPath = resolve(__dirname, 'comparison-report.json');
writeFileSync(reportPath, JSON.stringify({
  score: parseFloat(score),
  summary: { total, pass: results.pass, fail: results.fail, error: results.error },
  failures: results.details.filter(d => d.status === 'FAIL'),
  errors: results.details.filter(d => d.status === 'ERROR'),
}, null, 2));

console.log(`\n📄 Full report: ${reportPath}`);

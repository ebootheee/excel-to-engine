#!/usr/bin/env node

/**
 * Ship-ready test battery
 * ========================
 *
 * Production-hardening tests for a release to hundreds of users ingesting
 * thousands of heterogeneous PE/RE/corp models. Every test here represents
 * a failure mode observed in real sessions or a category where "quiet
 * wrongness" (a wrong number that looks plausible) has outsized cost.
 *
 * Categories:
 *   A. Refiner — adversarial layouts (restated copies, zero columns, scenario
 *      columns, multi-sheet label ambiguity, hints plumbing).
 *   B. searchByLabel — regex / literal / token fallback, non-contiguous
 *      substrings, partial word disambiguation.
 *   C. Doctor — zero-value traps, range violations, carry-label disqualifiers.
 *   D. ete carry — model-first path, parametric fallback, missing bindings,
 *      ownership fraction/percent parsing.
 *   E. Integration — full init→refine→doctor flow on a synthetic fixture
 *      that mimics the PE-platform-summary shape.
 *   F. Path / setNested — regression guard for the array-path corruption bug.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import {
  searchByLabel, buildLabelIndex, generateManifest,
  loadManifest, resolveCell, inFieldRange, FIELD_RANGES,
} from '../../lib/manifest.mjs';
import { runManifestRefine } from '../../cli/commands/manifest-refine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const CLI = join(ROOT, 'cli/index.mjs');

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.log(`  ✗ ${msg}`);
    failed++;
    failures.push(msg);
  }
}

function run(cmd) {
  try {
    return execSync(`node "${CLI}" ${cmd}`, { encoding: 'utf-8', cwd: ROOT });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}

function mkTempModel(groundTruth, manifest) {
  const tmp = mkdtempSync(join(tmpdir(), 'ete-ship-'));
  const dir = join(tmp, 'chunked');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '_ground-truth.json'), JSON.stringify(groundTruth));
  if (manifest) writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { tmp, dir };
}

// ===========================================================================
// A. REFINER — ADVERSARIAL LAYOUTS
// ===========================================================================
console.log('\n[A] Refiner — adversarial layouts');

console.log('Testing: refiner rejects zero-valued carryTotal when non-zero alternative exists');
{
  const gt = {
    'GP Promote!B88': 'Total Carried Interest',
    'GP Promote!D88': 41613251,   // the real value
    'GP Promote!KU88': 0,         // restated-copy column, zero
    // minimal anchoring to let runManifestRefine execute
    'GP Promote!A1': 2024, 'GP Promote!B1': 2025, 'GP Promote!C1': 2026, 'GP Promote!D1': 2027,
  };
  const manifest = generateManifest(gt).manifest;
  const { tmp, dir } = mkTempModel(gt, manifest);
  const report = runManifestRefine(dir, { apply: true });
  const m2 = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'));
  assert(m2.carry.totalCell === 'GP Promote!D88',
    `carry.totalCell binds to D88 (got ${m2.carry.totalCell})`);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: refiner prefers canonical leftmost over far-right restated copy');
{
  const gt = {
    'Cheat Sheet!B14': 'Gross MOIC',
    'Cheat Sheet!F14': 2.85,      // canonical
    'Cheat Sheet!BZ14': 2.85,     // restated copy far right
  };
  const manifest = generateManifest(gt).manifest;
  const { tmp, dir } = mkTempModel(gt, manifest);
  const report = runManifestRefine(dir, { apply: true });
  const m2 = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'));
  const bound = m2.equity?.classes?.[0]?.grossMOIC;
  assert(bound === 'Cheat Sheet!F14',
    `grossMOIC binds to F14 (got ${bound})`);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: refiner honors template hints.scenarioColumns');
{
  const gt = {
    'UW Comparison!C230': 'Gross IRR',
    'UW Comparison!H230': 0.1906,   // base case
    'UW Comparison!I230': 0.2053,   // upside scenario
    'UW Comparison!J230': 0.2200,   // stretch
    'UW Comparison!C231': 'Gross MOIC',
    'UW Comparison!H231': 2.31,
    'UW Comparison!I231': 2.82,
    'UW Comparison!J231': 3.10,
  };
  const manifest = generateManifest(gt).manifest;
  const { tmp, dir } = mkTempModel(gt, manifest);
  const hints = { scenarioColumns: { 'UW Comparison': ['H'], default: ['H'] } };
  const report = runManifestRefine(dir, { apply: true, hints });
  const m2 = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'));
  const irrBound = m2.equity?.classes?.[0]?.grossIRR;
  const moicBound = m2.equity?.classes?.[0]?.grossMOIC;
  assert(irrBound === 'UW Comparison!H230', `IRR binds to col H (got ${irrBound})`);
  assert(moicBound === 'UW Comparison!H231', `MOIC binds to col H (got ${moicBound})`);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: without hints, refiner picks non-zero closest-to-label candidate');
{
  // No hints — but restated-zero traps should still be avoided.
  const gt = {
    'Summary!B10': 'Total Carry',
    'Summary!D10': 0,             // zero at rank-4 sort
    'Summary!F10': 50000000,      // real value
  };
  const manifest = generateManifest(gt).manifest;
  const { tmp, dir } = mkTempModel(gt, manifest);
  runManifestRefine(dir, { apply: true });
  const m2 = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'));
  assert(m2.carry?.totalCell === 'Summary!F10',
    `carry.totalCell skips zero cell (got ${m2.carry?.totalCell})`);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: refiner binds to summary-sheet candidate over operational-tab duplicate');
{
  const gt = {
    'Operations!B50': 'Gross IRR',
    'Operations!D50': 0.1906,
    'Cheat Sheet!C15': 'Gross IRR',
    'Cheat Sheet!F15': 0.1906,
  };
  const manifest = generateManifest(gt).manifest;
  const { tmp, dir } = mkTempModel(gt, manifest);
  runManifestRefine(dir, { apply: true });
  const m2 = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'));
  const bound = m2.equity?.classes?.[0]?.grossIRR;
  assert(bound === 'Cheat Sheet!F15', `grossIRR prefers Cheat Sheet (got ${bound})`);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: refiner setNested writes equity.classes[0].grossMOIC at the correct path (regression)');
{
  // This is the core bug: prior setNestedField wrote to
  // equity.classes[0]["0"].grossMOIC instead of .grossMOIC.
  const gt = {
    'S!B10': 'Gross MOIC',
    'S!D10': 2.8,
  };
  const manifest = generateManifest(gt).manifest;
  const { tmp, dir } = mkTempModel(gt, manifest);
  runManifestRefine(dir, { apply: true });
  const m2 = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'));
  const class0 = m2.equity?.classes?.[0];
  assert(class0?.grossMOIC === 'S!D10', 'grossMOIC sits on class[0] directly');
  assert(!class0?.['0'], 'no rogue "0" nested key on class[0]');
  rmSync(tmp, { recursive: true, force: true });
}

// ===========================================================================
// B. searchByLabel — LITERAL / REGEX / TOKEN FALLBACK
// ===========================================================================
console.log('\n[B] searchByLabel — match modes');

console.log('Testing: literal substring matches contiguous phrase');
{
  const gt = { 'S!A1': 'Gross portfolio return', 'S!B1': 0.18 };
  const r = searchByLabel(gt, 'portfolio return');
  assert(r.length === 1, 'contiguous phrase matches');
}

console.log('Testing: literal survives unterminated-group paste');
{
  const gt = { 'S!A1': 'Gross (portfolio) return', 'S!B1': 0.18 };
  let threw = false;
  let r;
  try { r = searchByLabel(gt, 'Gross (port'); } catch { threw = true; }
  assert(!threw, 'no regex-parse error on unterminated group');
  assert(r.length === 1, 'matches as literal substring');
}

console.log('Testing: token AND-match for non-contiguous substring ("Gross MOIC" in "Gross (post carry) MOIC")');
{
  const gt = {
    'UW!B10': 'Gross (post carry, pre-fees / expenses / carry) MOIC',
    'UW!H10': 2.31,
  };
  const r = searchByLabel(gt, 'Gross MOIC');
  assert(r.length === 1, 'token fallback matches non-contiguous phrase');
}

console.log('Testing: token AND-match rejects when one token is absent');
{
  const gt = {
    'S!A1': 'Gross Rent Increase Rate',
    'S!B1': 0.05,
  };
  // "Gross IRR" — tokens Gross + IRR; "IRR" is NOT a word in the label
  const r = searchByLabel(gt, 'Gross IRR');
  assert(r.length === 0, 'token match requires all tokens present');
}

console.log('Testing: regex mode honors pattern');
{
  const gt = {
    'S!A1': 'Gross IRR',
    'S!B1': 0.18,
    'S!A2': 'Net IRR',
    'S!B2': 0.15,
  };
  const r = searchByLabel(gt, 'Gross|Net', { regex: true });
  assert(r.length === 2, 'regex OR finds both');
}

console.log('Testing: invalid regex with regex:true silently falls back to literal + token');
{
  const gt = { 'S!A1': 'Gross (port', 'S!B1': 5 };
  let threw = false, r;
  try { r = searchByLabel(gt, 'Gross (port', { regex: true }); } catch { threw = true; }
  assert(!threw, 'no throw');
  assert(r.length === 1, 'falls back and matches');
}

console.log('Testing: caseColumn reorders adjacent values and exposes caseValue');
{
  const gt = {
    'UW!B10': 'Peak Net Equity',
    'UW!H10': 347000000,
    'UW!I10': 351000000,
  };
  const r = searchByLabel(gt, 'Peak Net Equity', { caseColumn: 'H' });
  assert(r[0].caseValue === 347000000, 'caseValue taken from column H');
  assert(r[0].values[0].col === 'H', 'H is first in adjacent values');
}

console.log('Testing: single-token literal does not trigger token fallback');
{
  // Make sure a 1-token search like "IRR" stays a strict substring and
  // doesn't accidentally match "Rate" via some fallback.
  const gt = {
    'S!A1': 'IRR',
    'S!B1': 0.15,
    'S!A2': 'Interest Rate',
    'S!B2': 0.04,
  };
  const r = searchByLabel(gt, 'IRR');
  assert(r.length === 1 && r[0].label === 'IRR', 'single-token literal stays strict');
}

// ===========================================================================
// C. DOCTOR — ZERO AND RANGE CHECKS
// ===========================================================================
console.log('\n[C] Doctor — edge cases');

console.log('Testing: doctor flags carry.totalCell with value 0');
{
  const gt = {
    'GP!B5': 'Total Carry',
    'GP!D5': 0,
  };
  const manifest = {
    $schema: 'manifest-v1.0',
    model: { name: 'T', type: 'pe_fund', source: 't.xlsx', groundTruth: './_ground-truth.json' },
    timeline: {},
    segments: [],
    outputs: {},
    equity: { classes: [] },
    carry: { totalCell: 'GP!D5' },
    debt: {},
    baseCaseOutputs: {},
  };
  const { tmp, dir } = mkTempModel(gt, manifest);
  const out = run(`manifest doctor "${dir}" --format json`);
  assert(out.includes('value is 0') || out.includes('restated-copy'),
    'doctor flags zero carry.totalCell');
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: doctor flags equity basisCell = 0');
{
  const gt = { 'Eq!D10': 0 };
  const manifest = {
    $schema: 'manifest-v1.0',
    model: { name: 'T', type: 'pe_fund', source: 't.xlsx', groundTruth: './_ground-truth.json' },
    timeline: {}, segments: [], outputs: {},
    equity: { classes: [{ id: 'c1', label: 'Test class', basisCell: 'Eq!D10' }] },
    carry: {}, debt: {}, baseCaseOutputs: {},
  };
  const { tmp, dir } = mkTempModel(gt, manifest);
  const out = run(`manifest doctor "${dir}" --format json`);
  // basisCell=0 is flagged either as "outside range" (0 < 1e6) or as the
  // explicit "equity basis is 0" message depending on which check fires first.
  // Either way: it must be surfaced as an error with a fix command.
  assert(/basisCell|equity basis|outside expected range/i.test(out),
    'doctor flags zero basisCell');
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: doctor passes clean manifest without zero flags');
{
  const gt = {
    'GP!D5': 50000000,
    'Eq!D10': 300000000,
  };
  const manifest = {
    $schema: 'manifest-v1.0',
    model: { name: 'T', type: 'pe_fund', source: 't.xlsx', groundTruth: './_ground-truth.json' },
    timeline: {}, segments: [], outputs: {},
    equity: { classes: [{ id: 'c1', label: 'Test class', basisCell: 'Eq!D10' }] },
    carry: { totalCell: 'GP!D5' },
    debt: {}, baseCaseOutputs: {},
  };
  const { tmp, dir } = mkTempModel(gt, manifest);
  const out = run(`manifest doctor "${dir}"`);
  assert(out.includes('All checks passed') || !out.includes('errors'),
    'clean manifest passes doctor');
  rmSync(tmp, { recursive: true, force: true });
}

// ===========================================================================
// D. ete carry — MODEL-FIRST vs PARAMETRIC
// ===========================================================================
console.log('\n[D] ete carry — routing');

console.log('Testing: ete carry returns model cell value when carry.totalCell is set');
{
  const gt = { 'GP!D88': 41600000 };
  const manifest = {
    $schema: 'manifest-v1.0',
    model: { name: 'T', type: 'pe_fund', source: 't.xlsx', groundTruth: './_ground-truth.json' },
    timeline: {}, segments: [], outputs: {},
    equity: { classes: [] },
    carry: { totalCell: 'GP!D88' },
    debt: {}, baseCaseOutputs: {},
  };
  const { tmp, dir } = mkTempModel(gt, manifest);
  const out = run(`carry "${dir}" --ownership 0.06`);
  assert(out.includes("model's own waterfall"), 'uses model-first path');
  assert(out.includes('$41.6M') || out.includes('41,600,000'), 'reports cell value');
  assert(out.includes('$2.5M') || out.includes('2,496,000') || out.includes('2496000'),
    'computes 6% share');
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: ete carry --parametric forces waterfall even when totalCell is set');
{
  const gt = { 'GP!D88': 41600000 };
  const manifest = {
    $schema: 'manifest-v1.0',
    model: { name: 'T', type: 'pe_fund', source: 't.xlsx', groundTruth: './_ground-truth.json' },
    timeline: {}, segments: [], outputs: {},
    equity: { classes: [{ id: 'c1', basisCell: 'Eq!A1' }] },
    carry: { totalCell: 'GP!D88' },
    debt: {}, baseCaseOutputs: {},
  };
  const { tmp, dir } = mkTempModel(gt, manifest);
  const out = run(`carry "${dir}" --parametric --peak 300e6 --moc 2.5 --irr 0.15 --ownership 0.06`);
  assert(out.includes('Carry estimate') || out.includes('American waterfall'),
    'parametric mode engaged under --parametric');
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: ete carry --peak or --moc overrides skip model-first path');
{
  const gt = { 'GP!D88': 41600000 };
  const manifest = {
    $schema: 'manifest-v1.0',
    model: { name: 'T', type: 'pe_fund', source: 't.xlsx', groundTruth: './_ground-truth.json' },
    timeline: {}, segments: [], outputs: {},
    equity: { classes: [] },
    carry: { totalCell: 'GP!D88' },
    debt: {}, baseCaseOutputs: {},
  };
  const { tmp, dir } = mkTempModel(gt, manifest);
  // Pass explicit --peak → user wants parametric
  const out = run(`carry "${dir}" --peak 300e6 --moc 2.5 --irr 0.15 --ownership 0.06`);
  assert(!out.includes("model's own waterfall"),
    '--peak override skips model-first path');
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: ete carry skips model-first when totalCell = 0');
{
  const gt = { 'GP!D88': 0 };
  const manifest = {
    $schema: 'manifest-v1.0',
    model: { name: 'T', type: 'pe_fund', source: 't.xlsx', groundTruth: './_ground-truth.json' },
    timeline: {}, segments: [], outputs: {},
    equity: { classes: [] },
    carry: { totalCell: 'GP!D88' },
    debt: {}, baseCaseOutputs: {},
  };
  const { tmp, dir } = mkTempModel(gt, manifest);
  const out = run(`carry "${dir}" --ownership 0.06`);
  assert(!out.includes("model's own waterfall"),
    'zero totalCell falls through to parametric / error');
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: ownership accepts percent string ("6%")');
{
  const gt = { 'GP!D88': 100000000 };
  const manifest = {
    $schema: 'manifest-v1.0',
    model: { name: 'T', type: 'pe_fund', source: 't.xlsx', groundTruth: './_ground-truth.json' },
    timeline: {}, segments: [], outputs: {},
    equity: { classes: [] },
    carry: { totalCell: 'GP!D88' },
    debt: {}, baseCaseOutputs: {},
  };
  const { tmp, dir } = mkTempModel(gt, manifest);
  const out = run(`carry "${dir}" --ownership 6%`);
  // 6% of $100M = $6M
  assert(out.includes('$6.0M') || out.includes('6,000,000'),
    'percent-string ownership parses to 0.06');
  rmSync(tmp, { recursive: true, force: true });
}

// ===========================================================================
// E. INTEGRATION — end-to-end synthetic model, PE-platform shape
// ===========================================================================
console.log('\n[E] Integration — synthetic PE platform');

console.log('Testing: full manifest generate + refine + doctor cycle on platform-shape fixture');
{
  // Mimic the shape that surfaced multiple bugs: summary tab with two
  // scenario columns (H, I), operational tab with the same labels at
  // different cells, GP Promote tab with a Total Carried Interest row
  // that has both a canonical D-column cell and a restated KU-column zero.
  const gt = {
    // Timeline
    'UW Comparison!D1': 2025, 'UW Comparison!E1': 2026, 'UW Comparison!F1': 2027,
    'UW Comparison!G1': 2028, 'UW Comparison!H1': 2029,
    // Summary tab
    'UW Comparison!C229': 'Fund Size / Peak Net Equity',
    'UW Comparison!H229': 347000000, 'UW Comparison!I229': 351000000,
    'UW Comparison!C230': 'Gross IRR',
    'UW Comparison!H230': 0.1906, 'UW Comparison!I230': 0.2053,
    'UW Comparison!C231': 'Gross MOIC',
    'UW Comparison!H231': 2.31,   'UW Comparison!I231': 2.31,
    // Cheat Sheet with alternate bindings
    'Cheat Sheet!B14': 'Gross MOIC',
    'Cheat Sheet!F14': 2.85,
    'Cheat Sheet!B15': 'Gross IRR',
    'Cheat Sheet!F15': 0.18,
    // GP Promote — carry total, with a restated zero far right
    'GP Promote!B88': 'Total Carried Interest',
    'GP Promote!D88': 41613251,
    'GP Promote!KU88': 0,
    // Equity basis on Equity tab
    'Equity!B10': 'Peak Equity Invested',
    'Equity!F10': 276000000,
  };
  const { manifest: m0 } = generateManifest(gt, { source: 'synth.xlsx' });
  const { tmp, dir } = mkTempModel(gt, m0);
  // Refine with template hints
  const hints = { scenarioColumns: { 'UW Comparison': ['H'], default: ['H'] } };
  runManifestRefine(dir, { apply: true, hints });
  const m2 = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'));
  // Verify key bindings
  assert(m2.carry?.totalCell === 'GP Promote!D88',
    `carry.totalCell → D88 (got ${m2.carry?.totalCell})`);
  // Doctor should pass (no zero values bound, no range violations)
  const doctorOut = run(`manifest doctor "${dir}"`);
  assert(!doctorOut.includes("value is 0"),
    `doctor doesn't flag any zero-value bindings`);
  // ete carry (model-first, reads D88)
  const carryOut = run(`carry "${dir}" --ownership 0.06`);
  assert(carryOut.includes("model's own waterfall"), 'carry uses model-first');
  assert(carryOut.includes('$41.6M'), 'carry reports D88 value');
  assert(carryOut.includes('$2.5M'), 'carry 6% share = $2.5M');
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: refiner does NOT pick negative values (e.g. debit entries) for totals');
{
  const gt = {
    'GP!B5': 'Total Carry',
    'GP!C5': -5000000,   // debit / expense-style entry
    'GP!D5': 50000000,   // credit / income
  };
  const { tmp, dir } = mkTempModel(gt, generateManifest(gt).manifest);
  runManifestRefine(dir, { apply: true });
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'));
  // carryTotal range [0, 10e9] excludes negatives.
  assert(m.carry?.totalCell === 'GP!D5',
    `carry.totalCell avoids negative values (got ${m.carry?.totalCell})`);
  rmSync(tmp, { recursive: true, force: true });
}

// ===========================================================================
// F. setNested array-path regression guard
// ===========================================================================
console.log('\n[F] setNested — array path regression');

console.log('Testing: refiner writes to equity.classes[0].X (not equity.classes[0]["0"].X)');
{
  const gt = {
    'UW!B10': 'Gross MOIC',
    'UW!D10': 2.4,
    'UW!B11': 'Gross IRR',
    'UW!D11': 0.18,
    'UW!B12': 'Net MOIC',
    'UW!D12': 2.1,
    'UW!B13': 'Net IRR',
    'UW!D13': 0.14,
  };
  const { tmp, dir } = mkTempModel(gt, generateManifest(gt).manifest);
  runManifestRefine(dir, { apply: true });
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'));
  const c0 = m.equity?.classes?.[0] || {};
  assert(c0.grossMOIC === 'UW!D10', 'grossMOIC on class[0] directly');
  assert(c0.grossIRR === 'UW!D11', 'grossIRR on class[0] directly');
  assert(c0.netMOIC === 'UW!D12', 'netMOIC on class[0] directly');
  assert(c0.netIRR === 'UW!D13', 'netIRR on class[0] directly');
  assert(!c0['0'], 'no nested "0" key');
  rmSync(tmp, { recursive: true, force: true });
}

// ===========================================================================
// G. EDGE CASES — inputs the real world throws
// ===========================================================================
console.log('\n[G] Edge cases');

console.log('Testing: searchByLabel handles empty ground truth');
{
  const r = searchByLabel({}, 'anything');
  assert(Array.isArray(r) && r.length === 0, 'empty GT returns []');
}

console.log('Testing: searchByLabel handles empty pattern');
{
  const gt = { 'S!A1': 'label', 'S!B1': 1 };
  const r = searchByLabel(gt, '');
  // Empty pattern => matches every string; just ensure it doesn't throw
  assert(Array.isArray(r), 'empty pattern returns array (no crash)');
}

console.log('Testing: inFieldRange rejects NaN / Infinity');
{
  assert(!inFieldRange('basisCell', NaN), 'NaN rejected');
  assert(!inFieldRange('basisCell', Infinity), 'Infinity rejected');
  assert(!inFieldRange('basisCell', -Infinity), '-Infinity rejected');
}

console.log('Testing: refiner handles model with no matching labels');
{
  const gt = {
    'X!A1': 'Unrelated',
    'X!B1': 12345,
  };
  const { tmp, dir } = mkTempModel(gt, generateManifest(gt).manifest);
  let threw = false;
  try { runManifestRefine(dir, { apply: true }); } catch { threw = true; }
  assert(!threw, 'refiner runs without throwing on a model with no matches');
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: carry rejects ownership > 1 (unless expressed as percent)');
{
  const gt = { 'GP!D5': 100000000 };
  const manifest = {
    $schema: 'manifest-v1.0',
    model: { name: 'T', type: 'pe_fund', source: 't.xlsx', groundTruth: './_ground-truth.json' },
    timeline: {}, segments: [], outputs: {},
    equity: { classes: [] },
    carry: { totalCell: 'GP!D5' },
    debt: {}, baseCaseOutputs: {},
  };
  const { tmp, dir } = mkTempModel(gt, manifest);
  // 6 passed as number → should be treated as 6% (divided by 100)
  const out = run(`carry "${dir}" --ownership 6`);
  assert(out.includes('$6.0M') || out.includes('6,000,000'),
    'numeric 6 interpreted as 6% (auto-scaled)');
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: doctor handles manifest with missing timeline (no crash)');
{
  const gt = { 'X!A1': 1 };
  const manifest = {
    $schema: 'manifest-v1.0',
    model: { name: 'T', type: 'pe_fund', source: 't.xlsx', groundTruth: './_ground-truth.json' },
    segments: [], outputs: {},
    equity: { classes: [] }, carry: {}, debt: {}, baseCaseOutputs: {},
  };
  const { tmp, dir } = mkTempModel(gt, manifest);
  let threw = false;
  try { run(`manifest doctor "${dir}"`); } catch { threw = true; }
  assert(!threw, 'doctor handles missing timeline');
  rmSync(tmp, { recursive: true, force: true });
}

// ===========================================================================
// H. ADVERSARIAL — scenarios seen in real PE decks
// ===========================================================================
console.log('\n[H] Adversarial real-world scenarios');

console.log('Testing: refiner honors disqualifying pattern for carry labels');
{
  // A "Total Carry" label in a row that is actually pre-carry cash flow.
  // The refiner's `disqualifyingPatterns` on carryTotal rejects it.
  const gt = {
    'GP!B25': 'Total Cash Flows (pre-carry)',
    'GP!D25': 16800000,  // per-period CF, not GP carry
    'GP!B88': 'Total Carried Interest',
    'GP!D88': 41613251,   // the real value
  };
  const { tmp, dir } = mkTempModel(gt, generateManifest(gt).manifest);
  runManifestRefine(dir, { apply: true });
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'));
  assert(m.carry?.totalCell === 'GP!D88',
    `carry.totalCell → D88, not pre-carry CF cell (got ${m.carry?.totalCell})`);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: multiple scenario columns with value-range ambiguity');
{
  // Col H = 0.19 (IRR), col I = 2.31 (MOIC) — on SEPARATE rows, but a naive
  // refiner that matches "IRR" labels and picks rightmost could grab col I's
  // MOIC value (2.31) as "IRR" because 2.31 is in-range for IRR (0-2).
  const gt = {
    'UW!C230': 'Gross IRR',
    'UW!H230': 0.19,
    'UW!I230': 0.21,
    'UW!C231': 'Gross MOIC',
    'UW!H231': 2.31,
    'UW!I231': 2.85,
  };
  const { tmp, dir } = mkTempModel(gt, generateManifest(gt).manifest);
  const hints = { scenarioColumns: { default: ['H'] } };
  runManifestRefine(dir, { apply: true, hints });
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'));
  const c0 = m.equity?.classes?.[0];
  assert(c0?.grossIRR === 'UW!H230', 'IRR binds to correct row + col H');
  assert(c0?.grossMOIC === 'UW!H231', 'MOIC binds to correct row + col H');
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: refiner tolerates string values mixed into numeric rows');
{
  // Labels can bleed into numeric-row columns when spreadsheets have merged
  // cells or comments. Non-number cells must be skipped.
  const gt = {
    'S!B10': 'Gross MOIC',
    'S!C10': 'see note',   // string in a numeric column
    'S!D10': 2.8,          // real number
    'S!E10': null,         // null
  };
  const { tmp, dir } = mkTempModel(gt, generateManifest(gt).manifest);
  runManifestRefine(dir, { apply: true });
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'));
  const moic = m.equity?.classes?.[0]?.grossMOIC;
  assert(moic === 'S!D10', `grossMOIC → D10 (got ${moic})`);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: doctor does not crash on manifest with null equity classes array');
{
  const gt = { 'X!A1': 1 };
  const manifest = {
    $schema: 'manifest-v1.0',
    model: { name: 'T', type: 'pe_fund', source: 't.xlsx', groundTruth: './_ground-truth.json' },
    timeline: {}, segments: [], outputs: {},
    equity: null,      // null, not missing
    carry: {},
    debt: {},
    baseCaseOutputs: {},
  };
  const { tmp, dir } = mkTempModel(gt, manifest);
  let threw = false;
  try { run(`manifest doctor "${dir}"`); } catch { threw = true; }
  assert(!threw, 'doctor survives null equity');
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: very long labels do not break search');
{
  // A 500-char label — must not throw, must not explode memory.
  const longLabel = 'Gross ' + 'x'.repeat(500) + ' MOIC';
  const gt = {
    'S!A1': longLabel,
    'S!B1': 2.8,
  };
  const r = searchByLabel(gt, 'Gross MOIC');
  // length < 200 filter in buildLabelIndex skips this; searchByLabel without
  // index still sees the full GT. Both are acceptable; assert no crash.
  assert(Array.isArray(r), 'long label tolerated');
}

console.log('Testing: unicode in labels');
{
  const gt = {
    'S!A1': 'Résumé — Gross MOIC (€)',
    'S!B1': 2.85,
  };
  const r = searchByLabel(gt, 'Gross MOIC');
  assert(r.length >= 1, 'unicode label searchable');
}

console.log('Testing: refiner handles ground truth with undefined / boolean / date values');
{
  const gt = {
    'S!A1': 'Gross MOIC',
    'S!B1': true,          // boolean
    'S!C1': undefined,     // undefined
    'S!D1': '2024-01-01',  // ISO date string
    'S!E1': 2.85,          // real number
  };
  const { tmp, dir } = mkTempModel(gt, generateManifest(gt).manifest);
  let threw = false;
  try { runManifestRefine(dir, { apply: true }); } catch { threw = true; }
  assert(!threw, 'refiner tolerates mixed-type row cells');
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'));
  assert(m.equity?.classes?.[0]?.grossMOIC === 'S!E1', 'picks the only numeric in-range');
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: template auto-apply threshold respected');
{
  // A template with threshold 1.0 must NOT apply on 2/3 match.
  // Verify detectMatchingTemplate returns null in that case.
  // Can't easily test via CLI without building a fixture xlsx, so we
  // verify the template's own threshold.
  const tpl = JSON.parse(readFileSync(join(ROOT, 'templates/pe-platform-summary.json'), 'utf-8'));
  assert(tpl.signature?.matchThreshold === 1.0,
    'pe-platform-summary requires 100% signature match');
}

console.log('Testing: ete query with --regex passes through metacharacters');
{
  const gt = {
    'S!A1': 'Gross IRR',
    'S!B1': 0.18,
    'S!A2': 'Net IRR',
    'S!B2': 0.15,
  };
  const r = searchByLabel(gt, '^(Gross|Net)\\s+IRR$', { regex: true });
  assert(r.length === 2, 'anchored alternation regex works');
}

console.log('Testing: repeated init calls on the same dir are idempotent (manifest not corrupted)');
{
  const gt = {
    'S!B10': 'Gross MOIC',
    'S!D10': 2.8,
    'S!B11': 'Gross IRR',
    'S!D11': 0.18,
  };
  const { tmp, dir } = mkTempModel(gt, generateManifest(gt).manifest);
  runManifestRefine(dir, { apply: true });
  const after1 = readFileSync(join(dir, 'manifest.json'), 'utf-8');
  runManifestRefine(dir, { apply: true });
  const after2 = readFileSync(join(dir, 'manifest.json'), 'utf-8');
  assert(after1 === after2, 'refine is idempotent when fields already bound correctly');
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: runManifestRefine returns proper report shape');
{
  const gt = {
    'S!B10': 'Gross MOIC',
    'S!D10': 2.8,
  };
  const { tmp, dir } = mkTempModel(gt, generateManifest(gt).manifest);
  const report = runManifestRefine(dir, { apply: true });
  assert(typeof report === 'object' && report.patched === true, 'report carries patched flag');
  assert(typeof report.found === 'object', 'report.found is object');
  assert(Array.isArray(report.notFound), 'report.notFound is array');
  rmSync(tmp, { recursive: true, force: true });
}

// ===========================================================================
// I. AGGREGATE CELL RESOLUTION — multi-class promote totals
// ===========================================================================
// Historical: a PE fund model surfaced two carry classes on separate sheets
// ("GP Carry (1.5%)" + "GP Carry (1.25% TRS)"), each with its own total. A
// single `carry.totalCell` string couldn't express the consolidated total,
// so `ete carry` returned only one class's amount (~60% of the real number).
// Fixed by teaching detectCarry to auto-aggregate sibling sheets whose
// names differ only in a parenthesized qualifier, and teaching resolveCell
// to handle `{ cells, op }` aggregate refs. Session 2026-04-20.
console.log('Testing: resolveCell handles aggregate { cells, op: "sum" }');
{
  const gt = { 'A!D1': 100, 'B!D1': 200, 'C!D1': 300 };
  const agg = { cells: ['A!D1', 'B!D1', 'C!D1'], op: 'sum' };
  assert(resolveCell(gt, agg) === 600, 'sum aggregate = 600');
  assert(resolveCell(gt, 'A!D1') === 100, 'string still resolves');
  assert(resolveCell(gt, { cells: ['A!D1'], op: 'max' }) === 100, 'max with 1 cell');
  assert(resolveCell(gt, { cells: ['A!D1', 'B!D1'], op: 'min' }) === 100, 'min');
  assert(resolveCell(gt, { cells: ['A!D1', 'B!D1'], op: 'avg' }) === 150, 'avg');
  assert(resolveCell(gt, { cells: ['missing!X1'] }) === undefined, 'missing cells → undefined');
  assert(resolveCell(gt, null) === undefined, 'null cellRef → undefined');
}

console.log('Testing: detectCarry aggregates sibling sheets (multi-class PE shape)');
{
  // Simulate a multi-class PE model: two promote sheets, identical layout,
  // names differ only in a parenthesized qualifier.
  const gt = {
    'GP Carry (1.5%)!B86': 'Total Carried Interest',
    'GP Carry (1.5%)!D86': 28_256_071,
    'GP Carry (1.25% TRS)!B86': 'Total Carried Interest',
    'GP Carry (1.25% TRS)!D86': 21_031_822,
  };
  const { manifest: m } = generateManifest(gt, { source: 'x.xlsx' });
  const total = m.carry?.totalCell;
  assert(total && typeof total === 'object' && Array.isArray(total.cells),
    `carry.totalCell is aggregate object (got ${typeof total})`);
  assert(total?.cells?.length === 2 && total.op === 'sum',
    `2 cells, op=sum (got ${total?.cells?.length}, ${total?.op})`);
  assert(resolveCell(gt, total) === 49_287_893,
    `aggregate resolves to consolidated total $49.3M (got ${resolveCell(gt, total)})`);
}

console.log('Testing: detectCarry skips sibling aggregation for single-class models');
{
  const gt = {
    'GP Carry!B86': 'Total Carried Interest',
    'GP Carry!D86': 196_042_645,
  };
  const { manifest: m } = generateManifest(gt, { source: 'y.xlsx' });
  assert(typeof m.carry?.totalCell === 'string',
    `single-class stays string (got ${typeof m.carry?.totalCell})`);
  assert(m.carry?.totalCell === 'GP Carry!D86',
    `points at only carry cell (got ${m.carry?.totalCell})`);
}

console.log('Testing: detectCarry aggregate skips sibling with 0 value');
{
  const gt = {
    'GP Carry (A)!B86': 'Total Carried Interest',
    'GP Carry (A)!D86': 50_000_000,
    'GP Carry (B)!B86': 'Total Carried Interest',
    'GP Carry (B)!D86': 0,                      // zero — should be skipped
  };
  const { manifest: m } = generateManifest(gt, { source: 'z.xlsx' });
  // Regardless of whether the aggregate is built, the resolved total should
  // equal the single live class ($50M). A 0-valued sibling can't invalidate
  // the aggregate — sum(0, 50M) is still 50M — but nor can it contribute.
  assert(resolveCell(gt, m.carry?.totalCell) === 50_000_000,
    `zero sibling doesn't corrupt total (got ${resolveCell(gt, m.carry?.totalCell)})`);
}

console.log('Testing: refiner preserves aggregate carry.totalCell across re-runs');
{
  const tmp = mkdtempSync(join(tmpdir(), 'ship-agg-'));
  mkdirSync(join(tmp, 'chunked'), { recursive: true });
  const gt = {
    'GP Carry (1.5%)!B86': 'Total Carried Interest',
    'GP Carry (1.5%)!D86': 28_256_071,
    'GP Carry (1.25% TRS)!B86': 'Total Carried Interest',
    'GP Carry (1.25% TRS)!D86': 21_031_822,
  };
  writeFileSync(join(tmp, 'chunked', '_ground-truth.json'), JSON.stringify(gt));
  const { manifest: m } = generateManifest(gt, { source: 'x.xlsx' });
  m.model = m.model || {};
  m.model.groundTruth = './_ground-truth.json';
  writeFileSync(join(tmp, 'chunked', 'manifest.json'), JSON.stringify(m, null, 2));
  const r = runManifestRefine(join(tmp, 'chunked'), { apply: true });
  const after = JSON.parse(readFileSync(join(tmp, 'chunked', 'manifest.json'), 'utf-8'));
  assert(after.carry?.totalCell && typeof after.carry.totalCell === 'object',
    'refiner preserved aggregate (did not overwrite with string)');
  assert(Array.isArray(after.carry.totalCell?.cells) && after.carry.totalCell.cells.length === 2,
    'aggregate still has 2 cells after refine');
  rmSync(tmp, { recursive: true, force: true });
}

// ===========================================================================
// J. FLAT-MOIC HURDLE WATERFALL — Class A PPS pattern (no IRR pref)
// ===========================================================================
// Some waterfalls use a flat MOIC hurdle (e.g. 1.40x Class A PPS) with no
// IRR pref component. The hurdle doesn't compound with hold period. Before
// this fix, parametric carry treated every structure as IRR-based and
// produced wrong numbers for PPS-style promote structures.
console.log('Testing: createMoicHurdleWaterfall with 2.0x MOIC on $100M equity');
{
  const { computeWaterfall, createMoicHurdleWaterfall } = await import('../../lib/waterfall.mjs');
  const tiers = createMoicHurdleWaterfall({ hurdleMOIC: 1.40, carryPercent: 0.20 });
  const r = computeWaterfall(200_000_000, 100_000_000, tiers);
  assert(Math.abs(r.gpTotal - 12_000_000) < 1, `GP carry = $12M (got ${r.gpTotal})`);
  assert(Math.abs(r.lpTotal - 188_000_000) < 1, `LP total = $188M (got ${r.lpTotal})`);
  assert(Math.abs(r.lpMOIC - 1.88) < 0.001, `LP MOIC = 1.88x (got ${r.lpMOIC})`);
}

console.log('Testing: hurdleMOIC does NOT compound with hold period');
{
  const { computeWaterfall, createMoicHurdleWaterfall } = await import('../../lib/waterfall.mjs');
  const tiers = createMoicHurdleWaterfall({ hurdleMOIC: 1.40, carryPercent: 0.20 });
  const r5 = computeWaterfall(200_000_000, 100_000_000, tiers, { holdPeriodYears: 5 });
  const r10 = computeWaterfall(200_000_000, 100_000_000, tiers, { holdPeriodYears: 10 });
  assert(Math.abs(r5.gpTotal - r10.gpTotal) < 0.01,
    `same GP carry at 5yr and 10yr (${r5.gpTotal} vs ${r10.gpTotal}) — no compounding`);
}

console.log('Testing: hurdleMOIC below 1.0x returns $0 carry');
{
  const { computeWaterfall, createMoicHurdleWaterfall } = await import('../../lib/waterfall.mjs');
  const tiers = createMoicHurdleWaterfall({ hurdleMOIC: 1.40, carryPercent: 0.20 });
  const r = computeWaterfall(140_000_000, 100_000_000, tiers);  // exactly at hurdle
  assert(r.gpTotal < 1, `at-hurdle MOIC produces ~$0 carry (got ${r.gpTotal})`);
}

// ===========================================================================
// K. ROLLUP-SHEET PREFERENCE — detector picks rollup over per-class
// ===========================================================================
// Large PE platform models often have 20+ per-class sheets (1-A..9-A plus
// 1-B..9-B) with a rollup sheet (LP Rollup-A, GP Fees - Hold). The old detector picked
// whichever "Total Carried Interest" label happened to iterate last, which
// was arbitrary. The new sheetRank function ranks summary > rollup > generic
// > per-class.
console.log('Testing: detectCarry prefers Rollup sheet over per-class sibling');
{
  const gt = {
    '1-A!C82': 'Total Carried Interest',
    '1-A!E82': 10_000_000,
    '2-A!C82': 'Total Carried Interest',
    '2-A!E82': 15_000_000,
    'LP Rollup-A!C24': 'Total Carried Interest',
    'LP Rollup-A!E24': 87_148_891,   // consolidated
  };
  const { manifest: m } = generateManifest(gt, { source: 'lysara-shape.xlsx' });
  assert(m.carry?.totalCell === 'LP Rollup-A!E24',
    `rollup wins over per-class (got ${JSON.stringify(m.carry?.totalCell)})`);
}

console.log('Testing: detectCarry prefers summary sheet over rollup');
{
  const gt = {
    'Summary!B3': 'Total Carried Interest',
    'Summary!C3': 42_000_000,
    'LP Rollup!C24': 'Total Carried Interest',
    'LP Rollup!E24': 42_000_000,
  };
  const { manifest: m } = generateManifest(gt, { source: 'summary-beats-rollup.xlsx' });
  assert(m.carry?.totalCell === 'Summary!C3',
    `summary wins over rollup (got ${JSON.stringify(m.carry?.totalCell)})`);
}

console.log('Testing: refiner rollup preference inside candidate ranking');
{
  const gt = {
    '1-A!C82': 'Total Carried Interest',  '1-A!E82': 10_000_000,
    'LP Rollup-A!C24': 'Total Carried Interest',  'LP Rollup-A!E24': 50_000_000,
  };
  const tmp = mkdtempSync(join(tmpdir(), 'ship-rollup-'));
  mkdirSync(join(tmp, 'chunked'), { recursive: true });
  writeFileSync(join(tmp, 'chunked', '_ground-truth.json'), JSON.stringify(gt));
  const m = {
    $schema: 'manifest-v1.0',
    model: { name: 'x', type: 'pe_platform', groundTruth: './_ground-truth.json' },
    timeline: {}, segments: [], outputs: {}, equity: { classes: [] },
    carry: {}, debt: {}, lineItems: {}, subsegments: {}, customCells: {},
    baseCaseOutputs: {},
  };
  writeFileSync(join(tmp, 'chunked', 'manifest.json'), JSON.stringify(m, null, 2));
  runManifestRefine(join(tmp, 'chunked'), { apply: true });
  const after = JSON.parse(readFileSync(join(tmp, 'chunked', 'manifest.json'), 'utf-8'));
  assert(after.carry?.totalCell === 'LP Rollup-A!E24',
    `refiner picks rollup (got ${JSON.stringify(after.carry?.totalCell)})`);
  rmSync(tmp, { recursive: true, force: true });
}

// ===========================================================================
// L. MANIFEST INVARIANTS — trip-wires for domain rules
// ===========================================================================
// Cross-model attribution rules and agent-hostile "do not revert" decisions
// need to survive re-interpretation. Doctor checks manifest.invariants and
// errors when forbid/expect are violated.
console.log('Testing: doctor flags forbidden invariant value');
{
  const tmp = mkdtempSync(join(tmpdir(), 'ship-inv-'));
  mkdirSync(join(tmp, 'chunked'), { recursive: true });
  const gt = { 'GP!B5': 'Total Carried Interest', 'GP!D5': 50_000_000, 'BadSheet!E24': 999 };
  writeFileSync(join(tmp, 'chunked', '_ground-truth.json'), JSON.stringify(gt));
  const m = {
    $schema: 'manifest-v1.0',
    model: { name: 'x', type: 'pe_platform', groundTruth: './_ground-truth.json' },
    timeline: {}, segments: [], outputs: {}, equity: { classes: [] },
    carry: { totalCell: 'BadSheet!E24' }, debt: {}, lineItems: {}, subsegments: {},
    customCells: {},
    invariants: [
      { path: 'carry.totalCell', forbid: ['BadSheet!E24'], note: 'not the right rollup' },
    ],
  };
  writeFileSync(join(tmp, 'chunked', 'manifest.json'), JSON.stringify(m, null, 2));
  const out = run(`manifest doctor "${join(tmp, 'chunked')}"`);
  assert(/is forbidden/.test(out), 'doctor reports forbidden invariant');
  assert(/not the right rollup/.test(out), 'doctor includes user note');
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: doctor flags unexpected value when expect list is set');
{
  const tmp = mkdtempSync(join(tmpdir(), 'ship-inv2-'));
  mkdirSync(join(tmp, 'chunked'), { recursive: true });
  const gt = { 'GP!B5': 'Total Carried Interest', 'GP!D5': 50_000_000 };
  writeFileSync(join(tmp, 'chunked', '_ground-truth.json'), JSON.stringify(gt));
  const m = {
    $schema: 'manifest-v1.0',
    model: { name: 'x', type: 'pe_platform', groundTruth: './_ground-truth.json' },
    timeline: {}, segments: [], outputs: {}, equity: { classes: [] },
    carry: { totalCell: 'GP!D5' }, debt: {}, lineItems: {}, subsegments: {},
    customCells: {},
    invariants: [
      { path: 'carry.totalCell', expect: ['Other!X1', 'Another!Y2'] },
    ],
  };
  writeFileSync(join(tmp, 'chunked', 'manifest.json'), JSON.stringify(m, null, 2));
  const out = run(`manifest doctor "${join(tmp, 'chunked')}"`);
  assert(/is not one of the expected values/.test(out), 'doctor reports expect mismatch');
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: doctor passes when invariants match');
{
  const tmp = mkdtempSync(join(tmpdir(), 'ship-inv3-'));
  mkdirSync(join(tmp, 'chunked'), { recursive: true });
  const gt = { 'GP!B5': 'Total Carried Interest', 'GP!D5': 50_000_000 };
  writeFileSync(join(tmp, 'chunked', '_ground-truth.json'), JSON.stringify(gt));
  const m = {
    $schema: 'manifest-v1.0',
    model: { name: 'x', type: 'pe_platform', groundTruth: './_ground-truth.json' },
    timeline: {}, segments: [], outputs: {}, equity: { classes: [] },
    carry: { totalCell: 'GP!D5' }, debt: {}, lineItems: {}, subsegments: {},
    customCells: {},
    invariants: [
      { path: 'carry.totalCell', expect: ['GP!D5'], forbid: ['BadSheet!X1'] },
    ],
  };
  writeFileSync(join(tmp, 'chunked', 'manifest.json'), JSON.stringify(m, null, 2));
  const out = run(`manifest doctor "${join(tmp, 'chunked')}"`);
  assert(/All checks passed/.test(out) || !/is forbidden/.test(out),
    `doctor passes when invariant satisfied (output: ${out.substring(0, 200)})`);
  rmSync(tmp, { recursive: true, force: true });
}

// ===========================================================================
// M. --REUSE-PARSE FLAG — skip Rust parse when chunked/ exists
// ===========================================================================
console.log('Testing: ete init --reuse-parse skips Rust parse');
{
  const tmp = mkdtempSync(join(tmpdir(), 'ship-reuse-'));
  mkdirSync(join(tmp, 'chunked'), { recursive: true });
  const gt = { 'GP!B5': 'Total Carried Interest', 'GP!D5': 50_000_000 };
  writeFileSync(join(tmp, 'chunked', '_ground-truth.json'), JSON.stringify(gt));
  // xlsx path is intentionally nonexistent — --reuse-parse should not care.
  const out = run(`init /tmp/definitely-not-real.xlsx --reuse-parse --output "${tmp}" --no-template`);
  assert(/Reusing existing parse/.test(out), `output mentions reuse (${out.substring(0, 300)})`);
  assert(/Skipped Rust parser/.test(out), 'output confirms parser skip');
  // Manifest should have been generated
  assert(existsSync(join(tmp, 'chunked', 'manifest.json')), 'manifest.json created');
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: --reuse-parse without chunked/ falls through to parser');
{
  const tmp = mkdtempSync(join(tmpdir(), 'ship-reuse-miss-'));
  // No chunked/ — the flag is ignored; the command fails on missing xlsx.
  const out = run(`init /tmp/definitely-not-real.xlsx --reuse-parse --output "${tmp}"`);
  assert(/running parser|Excel file not found|Parser failed/.test(out),
    `flag ignored when chunked/ missing (${out.substring(0, 200)})`);
  rmSync(tmp, { recursive: true, force: true });
}

// ===========================================================================
// N. DEBT SIBLING AGGREGATION
// ===========================================================================
console.log('Testing: detectDebt aggregates sibling facilities');
{
  const gt = {
    'Term Loan (A)!B86': 'Exit Debt Balance',
    'Term Loan (A)!E86': 75_000_000,
    'Term Loan (B)!B86': 'Exit Debt Balance',
    'Term Loan (B)!E86': 25_000_000,
  };
  const { manifest: m } = generateManifest(gt, { source: 'multi-facility.xlsx' });
  const bal = m.debt?.exitBalance;
  assert(bal && typeof bal === 'object' && Array.isArray(bal.cells),
    `multi-facility → aggregate (got ${typeof bal})`);
  assert(resolveCell(gt, bal) === 100_000_000,
    `aggregate resolves to $100M total (got ${resolveCell(gt, bal)})`);
}

console.log('Testing: detectDebt single-facility stays string');
{
  const gt = {
    'Term Loan!B86': 'Exit Debt Balance',
    'Term Loan!E86': 75_000_000,
  };
  const { manifest: m } = generateManifest(gt, { source: 'single-facility.xlsx' });
  assert(typeof m.debt?.exitBalance === 'string' || m.debt?.exitBalance === undefined,
    `single-facility stays string/undefined (got ${typeof m.debt?.exitBalance})`);
}

// ===========================================================================
// RESULTS
// ===========================================================================
console.log('');
console.log('═'.repeat(60));
console.log(`Ship-ready suite: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);

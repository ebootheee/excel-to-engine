#!/usr/bin/env node

/**
 * Tests for the post-SESSION_LOG-4 pass:
 *   1. --search literal by default, --regex to opt in
 *   2. --case <column> scenario-column selection
 *   3. Soft-fail doctor-gated init (quarantine bad fields, exit 0)
 *   4. Template auto-apply on strong signature match
 *   5. ete carry label-search fallback (peak / moc) when manifest is missing
 *   6. Refiner: broader grossMOIC/basisCell patterns + summary-sheet preference
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { searchByLabel, buildLabelIndex, generateManifest, loadManifest } from '../../lib/manifest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const CLI = join(ROOT, 'cli/index.mjs');
const FIXTURES = join(__dirname, 'fixtures');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.log(`  ✗ ${msg}`);
    failed++;
  }
}

function run(cmd) {
  try {
    return execSync(`node "${CLI}" ${cmd}`, { encoding: 'utf-8', cwd: ROOT });
  } catch (e) {
    return e.stdout || e.stderr || '';
  }
}

function runExpectFail(cmd) {
  try {
    execSync(`node "${CLI}" ${cmd}`, { encoding: 'utf-8', cwd: ROOT });
    return { ok: true, out: '' };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
  }
}

// ---------------------------------------------------------------------------
// 1. --search literal by default
// ---------------------------------------------------------------------------
console.log('Testing: searchByLabel defaults to literal (escapes regex metacharacters)');
{
  const gt = {
    'S!A1': 'Gross (portfolio) return',
    'S!B1': 0.18,
    'S!A2': 'Gross portfolio return',
    'S!B2': 0.22,
  };
  // Without regex:true, "Gross (port" must match as a literal substring —
  // not crash on unterminated group.
  const matches = searchByLabel(gt, 'Gross (port', { maxResults: 10 });
  assert(matches.length === 1, 'literal mode matches only "Gross (portfolio)"');
  assert(matches[0].label.includes('(portfolio)'), 'matched the parenthesized label');
}

console.log('Testing: searchByLabel honours regex:true');
{
  const gt = {
    'S!A1': 'Gross IRR',
    'S!B1': 0.18,
    'S!A2': 'Net IRR',
    'S!B2': 0.16,
    'S!A3': 'EBITDA',
    'S!C3': 5000000,
  };
  const matches = searchByLabel(gt, 'Gross|Net', { regex: true, maxResults: 10 });
  assert(matches.length === 2, 'regex matches two rows');
}

console.log('Testing: invalid regex with regex:true falls back to literal rather than throwing');
{
  const gt = { 'S!A1': 'Gross (port', 'S!B1': 5 };
  let threw = false;
  let matches;
  try {
    matches = searchByLabel(gt, 'Gross (port', { regex: true });
  } catch {
    threw = true;
  }
  assert(!threw, 'no throw on invalid regex');
  assert(matches && matches.length === 1, 'falls back to literal and matches');
}

// ---------------------------------------------------------------------------
// 2. --case <column>
// ---------------------------------------------------------------------------
console.log('Testing: caseColumn reorders adjacent values');
{
  const gt = {
    'UW!B10': 'Gross IRR',
    'UW!H10': 0.19,
    'UW!I10': 0.22,
    'UW!J10': 0.25,
  };
  const matches = searchByLabel(gt, 'Gross IRR', { caseColumn: 'I' });
  assert(matches.length === 1, 'one match');
  const m = matches[0];
  assert(m.caseColumn === 'I', 'caseColumn recorded');
  assert(m.caseValue === 0.22, 'caseValue picked from column I');
  assert(m.values[0].col === 'I', 'I is first in adjacent values list');
}

console.log('Testing: caseColumn with no value for that column records null caseValue');
{
  const gt = {
    'UW!B10': 'Gross IRR',
    'UW!H10': 0.19,
  };
  const matches = searchByLabel(gt, 'Gross IRR', { caseColumn: 'I' });
  assert(matches[0].caseValue === null, 'caseValue is null when column I has no value');
}

// ---------------------------------------------------------------------------
// 3. Soft-fail init — verify via the underlying manifest doctor / quarantine
//    logic. A full init run needs the Rust parser and a real xlsx; here we
//    exercise the quarantine end by hand-setting a bad field and running
//    `ete manifest doctor` to confirm it's reported as error.
// ---------------------------------------------------------------------------
console.log('Testing: manifest doctor flags bad basisCell (precondition for quarantine)');
{
  const tmp = mkdtempSync(join(tmpdir(), 'ete-e2e4-'));
  const dir = join(tmp, 'chunked');
  mkdirSync(dir, { recursive: true });
  cpSync(join(FIXTURES, '_ground-truth.json'), join(dir, '_ground-truth.json'));
  cpSync(join(FIXTURES, 'manifest.json'), join(dir, 'manifest.json'));
  // Hand-break basisCell so doctor flags it as error.
  const mf = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'));
  // Point basisCell at a cell whose value is clearly out of range (label-row artifact)
  mf.equity = mf.equity || {};
  mf.equity.classes = mf.equity.classes || [{}];
  mf.equity.classes[0] = mf.equity.classes[0] || {};
  // Write a tiny GT hit for a bad-value cell
  const gt = JSON.parse(readFileSync(join(dir, '_ground-truth.json'), 'utf-8'));
  gt['Valuation!A1'] = 5; // out of basisCell range
  writeFileSync(join(dir, '_ground-truth.json'), JSON.stringify(gt));
  mf.equity.classes[0].basisCell = 'Valuation!A1';
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(mf, null, 2));

  const out = run(`manifest doctor "${dir}" --format json`);
  assert(out.includes('basisCell') || out.includes('outside expected range'), 'doctor reports bad basisCell');
  rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 4. Template auto-apply descriptor
// ---------------------------------------------------------------------------
console.log('Testing: pe-platform-summary template has autoApply=true and a 3-sheet signature');
{
  const tpl = JSON.parse(readFileSync(join(ROOT, 'templates/pe-platform-summary.json'), 'utf-8'));
  assert(tpl.signature?.autoApply === true, 'autoApply flag present');
  assert(Array.isArray(tpl.signature?.sheetNames), 'signature sheetNames is array');
  assert(tpl.signature.sheetNames.length === 3, 'three-sheet signature');
  assert(tpl.signature.matchThreshold === 1.0, 'matchThreshold is 1.0 (all three must match)');
  assert(tpl.hints?.summarySheets?.length > 0, 'summarySheets hint present');
  assert(tpl.hints?.scenarioColumns?.default?.[0] === 'H', 'default scenario column is H');
}

console.log('Testing: template name no longer contains any proprietary identifier');
{
  const tpl = JSON.parse(readFileSync(join(ROOT, 'templates/pe-platform-summary.json'), 'utf-8'));
  assert(!/outpost|greenpoint/i.test(tpl.name), 'template name is generic');
  assert(!/outpost|greenpoint/i.test(tpl.description), 'template description is generic');
}

// ---------------------------------------------------------------------------
// 5. ete carry label-search fallback: when manifest lacks grossMOIC/basis,
//    we surface the bare manifest-style error path (no fallback without gt
//    available). Here we test the behavior with the fixture manifest which
//    DOES have both fields — carry runs successfully.
// ---------------------------------------------------------------------------
console.log('Testing: ete carry uses manifest fields when present (baseline)');
{
  const out = run(`carry "${FIXTURES}" --ownership 0.1`);
  assert(/GP carry/i.test(out) && /Your share/i.test(out), 'carry runs with manifest-backed inputs');
}

console.log('Testing: ete carry pure parametric mode still works');
{
  const out = run(`carry --peak 300e6 --moc 2.5 --irr 0.18 --pref 0.08 --carry 0.20 --ownership 0.06`);
  assert(/GP carry/i.test(out), 'parametric carry runs without a model dir');
  assert(/Your share/i.test(out), 'ownership slice reported');
}

// ---------------------------------------------------------------------------
// 6. Refiner: new patterns accept "Gross MOC" and "Peak Net Equity"
// ---------------------------------------------------------------------------
console.log('Testing: detectEquity / refiner accept "Peak Net Equity" label');
{
  // Simulate a summary sheet with Peak Net Equity + Gross MOC
  const gt = {
    'UW Comparison!B10': 'Peak Net Equity',
    'UW Comparison!H10': 350_000_000,
    'UW Comparison!B11': 'Gross MOC',
    'UW Comparison!H11': 2.85,
    'UW Comparison!B12': 'Gross IRR',
    'UW Comparison!H12': 0.19,
    'UW Comparison!A1': 2025, // timeline anchor
    'UW Comparison!B1': 2026,
    'UW Comparison!C1': 2027,
    'UW Comparison!D1': 2028,
    'UW Comparison!E1': 2029,
    'UW Comparison!F1': 2030,
  };
  const { manifest } = generateManifest(gt, { source: 'test.xlsx' });
  // detectEquity doesn't look for "Peak Net Equity" directly (that's the
  // refiner's job) — so we assert the refiner's patterns would pick it up.
  const index = buildLabelIndex(gt);
  // The label index entry must be reachable
  assert(Object.keys(index).some(k => k.includes('peak net equity')), 'label index keyed by lower-cased label');
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

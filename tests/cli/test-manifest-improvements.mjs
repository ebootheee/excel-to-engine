#!/usr/bin/env node

/**
 * Tests for manifest auto-generation improvements driven by the
 * 3-E2E-test session log (2026-04-16):
 *
 *  - basisCell range validation rejects label artifacts (e.g. the `5` on
 *    `Assumptions!AI48` that produced a 7.2M× MOIC)
 *  - Equity class deduplication by (sheet, row)
 *  - Segment time-series validation (constant rows = scalar assumptions)
 *  - `manifest doctor` flags suspect mappings with corrective commands
 *  - `manifest set` overrides a single cell reference
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, cpSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import {
  generateManifest, validateManifest, inFieldRange, FIELD_RANGES,
} from '../../lib/manifest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const CLI = join(ROOT, 'cli/index.mjs');
const FIXTURES = join(__dirname, 'fixtures');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

function run(cmd) {
  return execSync(`node "${CLI}" ${cmd}`, { cwd: ROOT, encoding: 'utf-8', timeout: 30000 });
}

// ---------------------------------------------------------------------------
// inFieldRange — the gatekeeper for everything below
// ---------------------------------------------------------------------------
console.log('Testing: inFieldRange');
{
  // basisCell: the scenario from the session log (5 slipped through)
  assert(!inFieldRange('basisCell', 5), 'basisCell rejects 5 (label artifact)');
  assert(!inFieldRange('basisCell', 100), 'basisCell rejects 100');
  assert(inFieldRange('basisCell', 270_000_000), 'basisCell accepts $270M');
  assert(inFieldRange('basisCell', 1e6), 'basisCell accepts lower bound');
  assert(!inFieldRange('basisCell', 60e9), 'basisCell rejects > $50B');

  // exitMultiple: 18.5x should pass, 5000 should fail
  assert(inFieldRange('exitMultiple', 18.5), 'exitMultiple accepts 18.5');
  assert(!inFieldRange('exitMultiple', 0.5), 'exitMultiple rejects 0.5');
  assert(!inFieldRange('exitMultiple', 5000), 'exitMultiple rejects 5000');

  // IRR as decimal — 0.18 in range, 500 not
  assert(inFieldRange('grossIRR', 0.185), 'grossIRR accepts 18.5%');
  assert(inFieldRange('grossIRR', -0.1), 'grossIRR accepts -10%');
  assert(!inFieldRange('grossIRR', 500), 'grossIRR rejects 500');

  // MOIC
  assert(inFieldRange('grossMOIC', 2.85), 'grossMOIC accepts 2.85x');
  assert(!inFieldRange('grossMOIC', 30), 'grossMOIC rejects 30x (absurd)');

  // Undefined field — default accept
  assert(inFieldRange('someUnknownField', 42), 'unknown field defaults to accept');

  // Non-numeric always rejected
  assert(!inFieldRange('basisCell', 'foo'), 'non-numeric rejected');
  assert(!inFieldRange('basisCell', NaN), 'NaN rejected');
}

// ---------------------------------------------------------------------------
// Auto-generation: basisCell validation + equity dedupe
// ---------------------------------------------------------------------------
console.log('Testing: generateManifest basisCell validation');
{
  // Synthetic GT where a row matches an equity label but its only number is `5`.
  // Expected: detectEquity skips the row entirely (no false mapping).
  const gt = {
    'Assumptions!B2': 'Equity Basis',
    'Assumptions!C2': 5,                 // label artifact from session log
    'Equity!B10': 'Peak Equity Invested',
    'Equity!D10': 270_000_000,            // in-range basis
    'Equity!F10': 2.85,                   // MOIC would be in range 0.1-20
    'Equity!B11': 'Capital Committed',
    'Equity!D11': 270_000_000,            // duplicate row — should be kept since different label/row
  };
  const { manifest } = generateManifest(gt, { source: 'test.xlsx' });

  const classes = manifest.equity?.classes || [];
  assert(classes.length > 0, 'at least one equity class detected');
  for (const ec of classes) {
    const val = gt[ec.basisCell];
    assert(inFieldRange('basisCell', val), `basisCell value ${val} is in range`);
  }
  assert(
    !classes.some(ec => ec.basisCell === 'Assumptions!C2'),
    'did not pick the $5 label artifact'
  );
}

console.log('Testing: generateManifest equity dedupe');
{
  // Multiple "Equity Basis" labels on the same (sheet, row) → should collapse to 1
  const gt = {
    'Equity!A10': 'Total Equity Invested',
    'Equity!B10': 'Equity Basis',          // second label on same row
    'Equity!C10': 'Capital Committed',     // third label on same row
    'Equity!D10': 270_000_000,
  };
  const { manifest } = generateManifest(gt, { source: 'test.xlsx' });
  assert(
    (manifest.equity?.classes?.length || 0) === 1,
    `expected exactly 1 equity class after dedupe, got ${manifest.equity?.classes?.length || 0}`
  );
}

// ---------------------------------------------------------------------------
// Segment time-series validation
// ---------------------------------------------------------------------------
console.log('Testing: generateManifest segment time-series');
{
  // GT with:
  //  - Row 10 (Revenue): varies across years — should be kept
  //  - Row 11 (Net NOI): constant 94000 across years — should be rejected (scalar)
  //  - Row 12 (Revenue placeholder): only one year — should be rejected (sparse)
  const gt = {
    // Timeline row
    'P&L!A5': 'Year',
    'P&L!B5': 2024, 'P&L!C5': 2025, 'P&L!D5': 2026, 'P&L!E5': 2027, 'P&L!F5': 2028,
    // Good segment: varies
    'P&L!A10': 'Total Revenue',
    'P&L!B10': 100_000, 'P&L!C10': 120_000, 'P&L!D10': 150_000, 'P&L!E10': 180_000, 'P&L!F10': 220_000,
    // Bad segment: constant (scalar assumption)
    'P&L!A11': 'Net NOI',
    'P&L!B11': 94_000, 'P&L!C11': 94_000, 'P&L!D11': 94_000, 'P&L!E11': 94_000, 'P&L!F11': 94_000,
    // Bad segment: too sparse
    'P&L!A12': 'Revenue Placeholder',
    'P&L!B12': 50_000,
  };
  const { manifest } = generateManifest(gt, { source: 'test.xlsx' });
  const rows = (manifest.segments || []).map(s => s.row);
  assert(rows.includes(10), 'time-varying segment (row 10) kept');
  assert(!rows.includes(11), 'constant segment (row 11) rejected');
  assert(!rows.includes(12), 'sparse segment (row 12) rejected');
}

// ---------------------------------------------------------------------------
// manifest doctor
// ---------------------------------------------------------------------------
console.log('Testing: manifest doctor — clean fixture');
{
  const out = run(`manifest doctor "${FIXTURES}"`);
  assert(out.includes('All checks passed'), 'doctor reports clean on good manifest');
}

console.log('Testing: manifest doctor — detects bad basisCell');
{
  // Copy fixtures to tmp, tamper with manifest, run doctor
  const tmp = mkdtempSync(join(tmpdir(), 'ete-test-'));
  cpSync(FIXTURES, tmp, { recursive: true });
  const mPath = join(tmp, 'manifest.json');
  const m = JSON.parse(readFileSync(mPath, 'utf-8'));
  m.equity.classes[0].basisCell = 'Valuation!K54'; // 18.5, an exit multiple
  writeFileSync(mPath, JSON.stringify(m, null, 2));

  const out = execSync(`node "${CLI}" manifest doctor "${tmp}"`, { cwd: ROOT, encoding: 'utf-8' });
  assert(out.includes('equity.classes[0].basisCell'), 'doctor flags basisCell');
  assert(out.includes('outside expected range'), 'doctor names the failure mode');
  assert(out.includes('ete manifest set'), 'doctor suggests set command');

  rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// manifest set
// ---------------------------------------------------------------------------
console.log('Testing: manifest set — overrides a cell');
{
  const tmp = mkdtempSync(join(tmpdir(), 'ete-test-'));
  cpSync(FIXTURES, tmp, { recursive: true });
  const mPath = join(tmp, 'manifest.json');

  const out = execSync(`node "${CLI}" manifest set "${tmp}" customCells.testFoo "Valuation!K54"`,
    { cwd: ROOT, encoding: 'utf-8' });
  assert(out.includes('Manifest updated'), 'set reports success');

  const m = JSON.parse(readFileSync(mPath, 'utf-8'));
  assert(m.customCells?.testFoo === 'Valuation!K54', 'customCells.testFoo now set');

  // Invalid cell should error
  let errored = false;
  try {
    execSync(`node "${CLI}" manifest set "${tmp}" customCells.testBar "NonexistentSheet!A1"`,
      { cwd: ROOT, encoding: 'utf-8' });
  } catch (e) {
    errored = true;
  }
  assert(errored, 'set rejects nonexistent cell');

  rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Carry-totalCell detection hardening (SESSION_LOG_02_carry.md)
// ---------------------------------------------------------------------------
console.log('Testing: carry detection rejects pre-carry CF labels');
{
  // GT with a "Total Cash Flows (pre-carry)" label next to a number — auto-gen
  // must NOT pick this as carry.totalCell (it's a per-year pre-carry CF, not
  // GP carry). Regression guard for the pre-carry-CF detection trap.
  const gt = {
    'GPP Promote!A25': 'Total Cash Flows (pre-carry)',
    'GPP Promote!AF25': 16_800_000, // plausible dollar amount but WRONG concept
    'GPP Promote!A50': 'Preferred Return',
    'GPP Promote!C50': 0.08,
  };
  const { manifest } = generateManifest(gt, { source: 'test.xlsx' });
  assert(!manifest.carry?.totalCell, 'pre-carry CF label did not capture carry.totalCell');
}

console.log('Testing: carry detection accepts real carry labels');
{
  const gt = {
    'GPP Promote!A25': 'Total Carried Interest',
    'GPP Promote!C25': 50_300_000,
  };
  const { manifest } = generateManifest(gt, { source: 'test.xlsx' });
  assert(manifest.carry?.totalCell === 'GPP Promote!C25', '"Total Carried Interest" captured');
}

console.log('Testing: doctor flags pre-carry label even if manually set');
{
  const tmp = mkdtempSync(join(tmpdir(), 'ete-test-'));
  cpSync(FIXTURES, tmp, { recursive: true });
  const mPath = join(tmp, 'manifest.json');
  const gtPath = join(tmp, '_ground-truth.json');
  const m = JSON.parse(readFileSync(mPath, 'utf-8'));
  const gt = JSON.parse(readFileSync(gtPath, 'utf-8'));
  // Inject a pre-carry label next to a plausible number, point carry.totalCell at it
  gt['Valuation!A199'] = 'Total Cash Flows (pre-carry)';
  gt['Valuation!C199'] = 16_800_000;
  m.carry = m.carry || {};
  m.carry.totalCell = 'Valuation!C199';
  writeFileSync(gtPath, JSON.stringify(gt, null, 2));
  writeFileSync(mPath, JSON.stringify(m, null, 2));

  const out = execSync(`node "${CLI}" manifest doctor "${tmp}"`, { cwd: ROOT, encoding: 'utf-8' });
  assert(out.includes('carry.totalCell'), 'doctor flags carry.totalCell');
  assert(out.includes('pre-carry') || out.includes('non-carry concept'), 'doctor identifies label issue');
  rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Scenario-block detection
// ---------------------------------------------------------------------------
console.log('Testing: scenario-block detection');
{
  const gt = {};
  // 5 scenario blocks, stride 92, on a sheet with common summary labels
  for (let block = 0; block < 5; block++) {
    const offset = block * 92;
    for (let r = 1; r <= 80; r++) gt[`GPP Promote!B${offset + r}`] = `Detail ${block}-${r}`;
    gt[`GPP Promote!B${offset + 1}`] = `Scenario ${block + 1}`;
    gt[`GPP Promote!B${offset + 85}`] = 'Pre-Promote CF';
    gt[`GPP Promote!B${offset + 86}`] = 'Post-Promote CF';
    gt[`GPP Promote!B${offset + 87}`] = 'IRR';
    gt[`GPP Promote!B${offset + 88}`] = 'Profit';
    gt[`GPP Promote!B${offset + 89}`] = 'Peak Equity';
    gt[`GPP Promote!B${offset + 90}`] = 'MoC';
  }
  const { manifest } = generateManifest(gt, { source: 'test.xlsx' });
  const blocks = manifest.scenarioBlocks?.[0];
  assert(blocks, 'scenarioBlocks populated');
  assert(blocks?.blocks?.length === 5, `expected 5 blocks, got ${blocks?.blocks?.length}`);
  assert(blocks?.stride === 92, 'stride = 92');
  assert(blocks?.blocks?.[0]?.startRow === 1 && blocks?.blocks?.[0]?.endRow === 92,
    `block 1 bounds: expected [1, 92], got [${blocks?.blocks?.[0]?.startRow}, ${blocks?.blocks?.[0]?.endRow}]`);
  assert(blocks?.blocks?.[1]?.startRow === 93, 'block 2 starts at 93');
  assert(blocks?.blocks?.[0]?.label === 'Scenario 1', `block 1 label: ${blocks?.blocks?.[0]?.label}`);
}

console.log('Testing: scenario-block detection skips non-repeating sheets');
{
  const gt = {};
  // Flat sheet with no repeating pattern
  for (let r = 1; r <= 100; r++) gt[`Flat!B${r}`] = `Unique label ${r}`;
  const { manifest } = generateManifest(gt, { source: 'test.xlsx' });
  assert((manifest.scenarioBlocks || []).length === 0, 'no false positives on flat sheet');
}

// ---------------------------------------------------------------------------
// ete carry — smoke tests
// ---------------------------------------------------------------------------
console.log('Testing: ete carry against fixture (model-first path)');
{
  // With a manifest that has a non-zero carry.totalCell, the default path
  // returns the model's own computed carry (no parametric re-run).
  const out = run(`carry "${FIXTURES}"`);
  assert(out.includes("model's own waterfall"), 'carry renders model-first header');
  assert(out.includes('Total carry'), 'carry shows total carry');
  assert(out.includes('Source:') && out.includes('totalCell'), 'carry cites source cell');
}

console.log('Testing: ete carry --parametric forces the generic waterfall');
{
  const out = run(`carry "${FIXTURES}" --parametric --peak 500000000 --moc 2.8 --life 4.7 --pref 0.08 --carry 0.20`);
  assert(out.includes('Carry estimate'), 'parametric renders waterfall header');
  assert(out.includes('Peak equity'), 'parametric shows peak');
  assert(out.includes('MoC'), 'parametric shows MoC');
  assert(out.includes('GP carry'), 'parametric shows GP total');
}

console.log('Testing: ete carry pure parametric mode');
{
  const out = run(`carry --peak 500000000 --moc 2.8 --life 4.7 --pref 0.08 --carry 0.20 --ownership 0.06 --no-catchup`);
  // Expected: $136M total carry, $8.2M at 6% (session log's "direct formula")
  assert(out.includes('$136'), `expected ~$136M total carry (session log), got: ${out.match(/GP carry:\s*\$[\d.]+[MBK]/)?.[0]}`);
  assert(out.includes('$8.2M'), 'ownership share lands at $8.2M (6% of $136M)');
}

console.log('Testing: ete carry with catch-up');
{
  const out = run(`carry --peak 500000000 --moc 2.8 --life 4.7 --pref 0.08 --carry 0.20 --ownership 0.06`);
  // With catch-up, GP total is higher (~$280M)
  assert(out.includes('GP Catch-Up'), 'catch-up tier present by default');
}

console.log('Testing: ete carry errors on missing inputs');
{
  let errored = false;
  try {
    execSync(`node "${CLI}" carry`, { cwd: ROOT, encoding: 'utf-8' });
  } catch (e) {
    errored = true;
  }
  assert(errored, 'errors when no manifest and no --peak/--moc');
}

console.log('Testing: ete carry --irr solves hold period');
{
  const out = run(`carry --peak 500000000 --moc 2.8 --irr 0.165 --pref 0.08 --carry 0.20`);
  assert(out.includes('solved from IRR'), 'indicates life solved from IRR');
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

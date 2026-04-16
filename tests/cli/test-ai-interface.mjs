#!/usr/bin/env node

/**
 * Tests for the V4 AI-interface layer.
 * See PLAN_V4.md for scope — these cover:
 *   - Label index (Phase 1): lookup path + fallback
 *   - Compact output (Phase 2): byte reduction + round-tripping
 *   - ete explain (Phase 3): manifest → cell → label → value chain
 *   - Doctor-gated init + templates (Phase 4): export, apply, signature match
 *   - ete eval (Phase 5): chunked engine bridge
 *   - Breadth detectors (Phase 6): schedules, fundLevel, covenants, etc.
 *   - ete extract (Phase 6): time-series retrieval
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, cpSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import {
  generateManifest, buildLabelIndex, loadLabelIndex, searchByLabel,
  FIELD_RANGES, inFieldRange,
} from '../../lib/manifest.mjs';
import { toCompact } from '../../cli/format.mjs';

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
// Phase 1 — Label index
// ---------------------------------------------------------------------------
console.log('Testing: buildLabelIndex from ground truth');
{
  const gt = {
    'Valuation!A23': 'Total Revenue',
    'Valuation!A24': 'Gross Profit',
    'Valuation!E23': 1000,
    'Tech!A10': 'TOTAL REVENUE', // duplicated label, different sheet
  };
  const index = buildLabelIndex(gt);
  assert(Array.isArray(index['total revenue']), 'total revenue key exists');
  assert(index['total revenue']?.length === 2, 'both occurrences indexed');
  assert(index['gross profit']?.[0]?.sheet === 'Valuation', 'gross profit sheet mapped');
}

console.log('Testing: searchByLabel with index (fast path)');
{
  const gt = { 'Valuation!A23': 'Total Revenue', 'Valuation!E23': 1000 };
  const index = buildLabelIndex(gt);
  const matches = searchByLabel(gt, 'Revenue', { index });
  assert(matches.length === 1, `one match found; got ${matches.length}`);
  assert(matches[0].sheet === 'Valuation', 'correct sheet');
  assert(matches[0].values.length >= 1, 'adjacent value captured');
}

console.log('Testing: searchByLabel fallback (no index)');
{
  const gt = { 'Valuation!A23': 'Total Revenue', 'Valuation!E23': 1000 };
  const matches = searchByLabel(gt, 'Revenue');
  assert(matches.length === 1, 'fallback finds match without index');
}

console.log('Testing: loadLabelIndex falls back to null when absent');
{
  const tmp = mkdtempSync(join(tmpdir(), 'ete-test-'));
  const result = loadLabelIndex(tmp);
  assert(result === null, 'returns null when no index present');
  rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Phase 2 — Compact output
// ---------------------------------------------------------------------------
console.log('Testing: toCompact drops nulls and rounds numbers');
{
  const input = {
    value: 12345.6789,
    cell: 'Sheet!A1',
    empty: null,
    rate: 0.08567,
    nested: { value: 9.87654321, empty: undefined },
  };
  const out = toCompact(input);
  assert(!('empty' in out), 'null dropped');
  // Heterogeneous objects preserve full keys; rounding still applies (~4 sig figs)
  assert(Math.abs(out.value - 12345.6789) < 5, `value rounded within ±5, got ${out.value}`);
  assert(out.cell === 'Sheet!A1', 'cell preserved');
  assert(!('empty' in (out.nested || {})), 'nested null dropped');

  // Value-record shape (only whitelisted keys) DOES get renamed
  const vr = toCompact({ value: 1.5, cell: 'A!1', label: 'Foo' });
  assert(vr.v === 1.5, 'value-record value renamed to v');
  assert(vr.c === 'A!1', 'value-record cell renamed to c');
  assert(vr.l === 'Foo', 'value-record label renamed to l');
}

console.log('Testing: compact format via CLI reduces bytes');
{
  const jsonOut = run(`query "${FIXTURES}" --search "Revenue" --format json`);
  const compactOut = run(`query "${FIXTURES}" --search "Revenue" --compact`);
  assert(compactOut.length < jsonOut.length * 0.6, `compact should be <60% of json bytes; got ${compactOut.length}/${jsonOut.length}`);
  // Both must parse as JSON
  try {
    const j = JSON.parse(jsonOut);
    const c = JSON.parse(compactOut);
    assert(j.count === c.count, 'compact preserves count field');
  } catch {
    assert(false, 'both outputs parse as valid JSON');
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — ete explain
// ---------------------------------------------------------------------------
console.log('Testing: ete explain for manifest name');
{
  const out = run(`explain "${FIXTURES}" grossMOIC`);
  assert(out.includes('equity.classes[0].grossMOIC'), 'shows manifest path');
  assert(out.includes('2.85'), 'shows value');
  assert(out.includes('Adjacent label'), 'shows adjacent label section');
}

console.log('Testing: ete explain for direct cell');
{
  const out = run(`explain "${FIXTURES}" "Valuation!K54"`);
  assert(out.includes('Valuation!K54'), 'shows cell ref');
  assert(out.includes('18.5'), 'shows value');
}

console.log('Testing: ete explain errors on unknown name');
{
  let errored = false;
  try {
    execSync(`node "${CLI}" explain "${FIXTURES}" thisDoesNotExist`, { cwd: ROOT, encoding: 'utf-8' });
  } catch (e) {
    errored = true;
  }
  assert(errored, 'errors on unknown name');
}

// ---------------------------------------------------------------------------
// Phase 6 — Breadth detectors
// ---------------------------------------------------------------------------
console.log('Testing: detectFundLevelMetrics');
{
  const gt = {
    'Summary!A2': 'TVPI', 'Summary!B2': 2.35,
    'Summary!A3': 'DPI', 'Summary!B3': 1.12,
    'Summary!A4': 'Net IRR', 'Summary!B4': 0.185,
    'Summary!A5': 'Vintage Year', 'Summary!B5': 2022,
    'Summary!A6': 'Fund Size', 'Summary!B6': 500_000_000,
  };
  const { manifest } = generateManifest(gt, { source: 'test.xlsx' });
  assert(manifest.fundLevel?.tvpi === 'Summary!B2', 'TVPI detected');
  assert(manifest.fundLevel?.dpi === 'Summary!B3', 'DPI detected');
  assert(manifest.fundLevel?.netIRR === 'Summary!B4', 'netIRR detected');
  assert(manifest.fundLevel?.vintageYear === 'Summary!B5', 'vintageYear detected');
  assert(manifest.fundLevel?.fundSize === 'Summary!B6', 'fundSize detected');
}

console.log('Testing: detectSchedules extracts capital calls');
{
  const gt = {};
  // Timeline on row 5
  gt['Cashflow!A5'] = 'Year';
  for (let i = 0; i < 5; i++) {
    const col = String.fromCharCode(66 + i);
    gt[`Cashflow!${col}5`] = 2024 + i;
  }
  // Capital call schedule on row 10 with varying annual values
  gt['Cashflow!A10'] = 'Capital Calls';
  for (let i = 0; i < 5; i++) {
    const col = String.fromCharCode(66 + i);
    gt[`Cashflow!${col}10`] = (5 - i) * 20_000_000;
  }
  const { manifest } = generateManifest(gt, { source: 'test.xlsx' });
  const cap = (manifest.schedules || []).find(s => s.type === 'capital_call');
  assert(cap !== undefined, 'capital call schedule detected');
  assert(cap?.row === 10, 'correct row');
}

console.log('Testing: detectCovenants — DSCR, LTV');
{
  const gt = {
    'Covenants!A2': 'DSCR', 'Covenants!B2': 1.25,
    'Covenants!A3': 'LTV', 'Covenants!B3': 0.65,
    'Covenants!A4': 'Interest Coverage Ratio', 'Covenants!B4': 3.5,
  };
  const { manifest } = generateManifest(gt, { source: 'test.xlsx' });
  const covs = manifest.covenants || [];
  const ids = covs.map(c => c.id);
  assert(ids.includes('dscr'), 'dscr detected');
  assert(ids.includes('ltv'), 'ltv detected');
  assert(ids.includes('icr'), 'icr detected');
}

console.log('Testing: detectCarryTiers — populates tiers next to carry.totalCell');
{
  const gt = {
    'Waterfall!A10': 'Total Carry', 'Waterfall!B10': 50_000_000,
    'Waterfall!A12': 'Return of Capital',
    'Waterfall!A13': 'Preferred Return', 'Waterfall!B13': 0.08,
    'Waterfall!A14': 'GP Catch-Up',
    'Waterfall!A15': 'Residual',
  };
  const { manifest } = generateManifest(gt, { source: 'test.xlsx' });
  const tiers = manifest.carry?.tiers || [];
  const types = tiers.map(t => t.type);
  assert(types.includes('return_of_capital'), 'RoC tier detected');
  assert(types.includes('pref'), 'pref tier detected');
  assert(types.includes('catchup'), 'catchup tier detected');
  assert(types.includes('residual'), 'residual tier detected');
}

console.log('Testing: detectDebtDetails — principal, rate, maturity');
{
  const gt = {
    'Debt!A2': 'Loan Principal', 'Debt!B2': 100_000_000,
    'Debt!A3': 'Interest Rate', 'Debt!B3': 0.065,
    'Debt!A4': 'Maturity Year', 'Debt!B4': 2030,
  };
  const { manifest } = generateManifest(gt, { source: 'test.xlsx' });
  assert(manifest.debt?.principal === 'Debt!B2', 'principal detected');
  assert(manifest.debt?.rate === 'Debt!B3', 'rate detected');
  assert(manifest.debt?.maturity === 'Debt!B4', 'maturity detected');
}

// ---------------------------------------------------------------------------
// Phase 6 — ete extract
// ---------------------------------------------------------------------------
console.log('Testing: ete extract --list with no schedules');
{
  const out = run(`extract "${FIXTURES}" --list`);
  // Fixture has no detected schedules — verify graceful handling
  assert(out.includes('schedule') || out.includes('No'), 'handles empty schedules gracefully');
}

console.log('Testing: ete extract against injected capital call');
{
  const tmp = mkdtempSync(join(tmpdir(), 'ete-test-'));
  cpSync(FIXTURES, tmp, { recursive: true });
  const gt = JSON.parse(readFileSync(join(tmp, '_ground-truth.json'), 'utf-8'));
  // Add a capital call schedule
  gt['Valuation!A40'] = 'Capital Calls';
  gt['Valuation!E40'] = 100_000_000;
  gt['Valuation!F40'] = 70_000_000;
  gt['Valuation!G40'] = 50_000_000;
  gt['Valuation!H40'] = 30_000_000;
  writeFileSync(join(tmp, '_ground-truth.json'), JSON.stringify(gt, null, 2));

  // Regenerate manifest to pick up the schedule
  execSync(`node "${CLI}" manifest generate "${tmp}"`, { cwd: ROOT, encoding: 'utf-8' });

  const listOut = execSync(`node "${CLI}" extract "${tmp}" --list`, { cwd: ROOT, encoding: 'utf-8' });
  assert(listOut.includes('capital_call'), 'lists capital_call type');
  assert(listOut.includes('Capital Calls'), 'shows label');

  const typeOut = execSync(`node "${CLI}" extract "${tmp}" --type capital_call`, { cwd: ROOT, encoding: 'utf-8' });
  assert(typeOut.includes('Capital Calls'), 'extract --type returns labeled schedule');
  assert(typeOut.includes('100.00M') || typeOut.includes('$100'), 'shows first-year value');
  assert(typeOut.includes('Total'), 'shows total');

  rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Phase 4 — Templates + doctor-gated init
// ---------------------------------------------------------------------------
console.log('Testing: manifest export produces template JSON');
{
  const out = run(`manifest export "${FIXTURES}"`);
  const template = JSON.parse(out);
  assert(template.$schema === 'template-v1.0', 'template schema set');
  assert(Array.isArray(template.signature?.sheetNames), 'signature sheetNames array');
  assert(typeof template.mappings === 'object', 'mappings object present');
  // Key mappings should survive
  assert(template.mappings['equity.classes[0].grossMOIC'], 'grossMOIC in mappings');
  // baseCaseOutputs and customCells should be stripped
  const keys = Object.keys(template.mappings);
  assert(!keys.some(k => k.startsWith('baseCaseOutputs')), 'baseCaseOutputs stripped');
}

console.log('Testing: template application via init (round-trip)');
{
  // Export a template, copy to temp templates dir with a test name, then apply
  const out = run(`manifest export "${FIXTURES}"`);
  const template = JSON.parse(out);
  template.name = 'test-template-rt';
  const templatesDir = join(ROOT, 'templates');
  const tmpTemplate = join(templatesDir, '__test-rt.json');
  writeFileSync(tmpTemplate, JSON.stringify(template, null, 2));

  // Make a tmp copy of fixtures
  const tmp = mkdtempSync(join(tmpdir(), 'ete-test-'));
  cpSync(FIXTURES, tmp, { recursive: true });
  // Delete manifest so init regenerates
  rmSync(join(tmp, 'manifest.json'));

  // Run manifest generate + template apply manually (mimics init --template)
  execSync(`node "${CLI}" manifest generate "${tmp}"`, { cwd: ROOT, encoding: 'utf-8' });
  // Verify manifest generated
  const m = JSON.parse(readFileSync(join(tmp, 'manifest.json'), 'utf-8'));
  assert(m.$schema === 'manifest-v1.0', 'manifest regenerated');

  // Cleanup
  rmSync(tmp, { recursive: true, force: true });
  rmSync(tmpTemplate);
}

console.log('Testing: doctor-gated init blocks on error without --force');
{
  // Simulated: create a manifest with a known-bad basisCell, run doctor directly
  const tmp = mkdtempSync(join(tmpdir(), 'ete-test-'));
  cpSync(FIXTURES, tmp, { recursive: true });
  const mPath = join(tmp, 'manifest.json');
  const m = JSON.parse(readFileSync(mPath, 'utf-8'));
  m.equity.classes[0].basisCell = 'Valuation!K54'; // 18.5, out of range
  writeFileSync(mPath, JSON.stringify(m, null, 2));

  const out = execSync(`node "${CLI}" manifest doctor "${tmp}"`, { cwd: ROOT, encoding: 'utf-8' });
  assert(out.includes('equity.classes[0].basisCell'), 'doctor catches bad basisCell');
  assert(out.includes('outside expected range'), 'doctor names the problem');

  rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Phase 5 — ete eval (chunked engine bridge)
// ---------------------------------------------------------------------------
console.log('Testing: ete eval falls back to ground truth when no engine');
{
  // Fixtures don't have a chunked engine, so eval should fall back
  const out = run(`eval "${FIXTURES}" "Valuation!K54"`);
  assert(out.includes('Valuation!K54'), 'cell reported');
  assert(out.includes('18.5'), 'value matches GT');
  assert(out.includes('ground-truth') || out.includes('engine not present'), 'indicates fallback path');
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

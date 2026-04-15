#!/usr/bin/env node

/**
 * CLI Integration Tests
 *
 * Runs all ete commands against the synthetic fixtures
 * and verifies output structure and key values.
 */

import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const CLI = join(ROOT, 'cli/index.mjs');
const FIXTURES = `"${join(__dirname, 'fixtures')}"`;
const FIXTURES_RAW = join(__dirname, 'fixtures');

let passed = 0;
let failed = 0;

function run(cmd) {
  return execSync(`node "${CLI}" ${cmd}`, { cwd: ROOT, encoding: 'utf-8', timeout: 30000 });
}

function runJson(cmd) {
  return JSON.parse(run(`${cmd} --format json`));
}

function assert(test, msg) {
  if (test) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('Testing: summary');
{
  const out = run(`summary ${FIXTURES}`);
  assert(out.includes('Synthetic PE Platform'), 'summary includes model name');
  assert(out.includes('2024'), 'summary includes investment year');
  assert(out.includes('2030'), 'summary includes exit year');
  assert(out.includes('2.85x'), 'summary includes gross MOIC');
  assert(out.includes('28.4%'), 'summary includes gross IRR');
  assert(out.includes('$50.3M'), 'summary includes carry');
}

// ---------------------------------------------------------------------------
// Query — cell
// ---------------------------------------------------------------------------
console.log('Testing: query (cell)');
{
  const out = run(`query ${FIXTURES} "Valuation!K54"`);
  assert(out.includes('18.5'), 'query returns exit multiple value');
}

// ---------------------------------------------------------------------------
// Query — search
// ---------------------------------------------------------------------------
console.log('Testing: query (search)');
{
  const out = run(`query ${FIXTURES} --search "Total Revenue"`);
  assert(out.includes('Technology'), 'search finds Technology sheet');
  assert(out.includes('22.7'), 'search shows exit year revenue');
}

// ---------------------------------------------------------------------------
// Query — name
// ---------------------------------------------------------------------------
console.log('Testing: query (name)');
{
  const out = run(`query ${FIXTURES} --name grossMOIC`);
  assert(out.includes('2.85'), 'name query returns MOIC');
}

// ---------------------------------------------------------------------------
// PnL — full
// ---------------------------------------------------------------------------
console.log('Testing: pnl (full)');
{
  const out = run(`pnl ${FIXTURES}`);
  assert(out.includes('Real Estate NOI'), 'pnl shows RE segment');
  assert(out.includes('Technology Gross Profit'), 'pnl shows tech segment');
  assert(out.includes('Platform EBITDA'), 'pnl shows EBITDA total');
  assert(out.includes('$59.0M'), 'pnl shows exit year EBITDA');
}

// ---------------------------------------------------------------------------
// PnL — segment detail
// ---------------------------------------------------------------------------
console.log('Testing: pnl (segment detail)');
{
  const out = run(`pnl ${FIXTURES} --segment technology --growth`);
  assert(out.includes('Ongoing Fee'), 'detail shows subsegment revenue types');
  assert(out.includes('Customer Acquisition'), 'detail shows subsegment expense types');
  assert(out.includes('Profit'), 'detail shows profit row');
}

// ---------------------------------------------------------------------------
// Scenario — basic
// ---------------------------------------------------------------------------
console.log('Testing: scenario (basic)');
{
  const out = run(`scenario ${FIXTURES} --exit-multiple 16`);
  assert(out.includes('Base'), 'scenario shows base column');
  assert(out.includes('Scenario'), 'scenario shows scenario column');
  assert(out.includes('Delta'), 'scenario shows delta column');
  assert(out.includes('Gross MOIC'), 'scenario shows MOIC');
}

// ---------------------------------------------------------------------------
// Scenario — JSON
// ---------------------------------------------------------------------------
console.log('Testing: scenario (json)');
{
  const data = runJson(`scenario ${FIXTURES} --exit-multiple 16`);
  assert(data.base && typeof data.base.grossMOIC === 'number', 'json has base.grossMOIC');
  assert(data.scenario && data.scenario.grossMOIC < data.base.grossMOIC, 'lower multiple = lower MOIC');
  assert(data.deltas && data.deltas.grossMOIC, 'json has deltas');
}

// ---------------------------------------------------------------------------
// Sensitivity — 1D
// ---------------------------------------------------------------------------
console.log('Testing: sensitivity (1D)');
{
  const out = run(`sensitivity ${FIXTURES} --vary exit-multiple:14-22:2 --metric grossIRR,grossMOIC`);
  assert(out.includes('14.0x'), 'sensitivity shows min value');
  assert(out.includes('22.0x'), 'sensitivity shows max value');
  assert(out.includes('Gross IRR'), 'sensitivity shows metric label');
}

// ---------------------------------------------------------------------------
// Sensitivity — 2D
// ---------------------------------------------------------------------------
console.log('Testing: sensitivity (2D)');
{
  const out = run(`sensitivity ${FIXTURES} --vary exit-multiple:14-20:2 --vary exit-year:2028-2030:1 --metric grossIRR`);
  assert(out.includes('2028'), 'matrix shows year columns');
  assert(out.includes('14.0x'), 'matrix shows multiple rows');
}

// ---------------------------------------------------------------------------
// Scenario — save/load
// ---------------------------------------------------------------------------
console.log('Testing: scenario (save/load)');
{
  // Save
  run(`scenario ${FIXTURES} --exit-multiple 14 --save "test-bear"`);
  const listOut = run(`scenario ${FIXTURES} --list`);
  assert(listOut.includes('test-bear'), 'saved scenario appears in list');

  // Load
  const loadOut = run(`scenario ${FIXTURES} --load test-bear`);
  assert(loadOut.includes('Gross MOIC'), 'loaded scenario shows MOIC');
}

// ---------------------------------------------------------------------------
// Compare — base vs alt
// ---------------------------------------------------------------------------
console.log('Testing: compare');
{
  const out = run(`compare ${FIXTURES} --base "" --alt "exit-multiple=16"`);
  assert(out.includes('Base'), 'compare shows base column');
  assert(out.includes('Scenario'), 'compare shows scenario column');
}

// ---------------------------------------------------------------------------
// Manifest — validate
// ---------------------------------------------------------------------------
console.log('Testing: manifest validate');
{
  const out = run(`manifest validate "${FIXTURES_RAW}/manifest.json"`);
  assert(out.includes('VALID') || out.includes('passed'), 'manifest validates');
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);

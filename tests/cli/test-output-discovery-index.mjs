/** Synthetic correctness and deterministic work-count checks for output discovery. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateManifest } from '../../lib/manifest.mjs';

function generate(gt) { return generateManifest(gt, { source: 'synthetic.xlsx' }); }
function measure(gt) {
  const entries = Object.entries, keys = Object.keys;
  let scans = 0;
  Object.entries = object => { if (object === gt) scans++; return entries(object); };
  Object.keys = object => { if (object === gt) scans++; return keys(object); };
  const start = performance.now();
  try {
    return { result: generate(gt), scans, elapsedMs: performance.now() - start };
  } finally {
    Object.entries = entries;
    Object.keys = keys;
  }
}
function fixture(labels) {
  const gt = {};
  for (let row = 1; row <= 20000; row++) gt[`Numeric Grid!D${row}`] = 1000 + row;
  for (let row = 1; row <= labels; row++) {
    gt[`Assumptions!A${row}`] = 'Exit Multiple';
    gt[`Assumptions!B${row}`] = 12;
  }
  return gt;
}
await test('matching labels do not multiply whole-grid enumeration', () => {
  const small = measure(fixture(1)), repeated = measure(fixture(80));
  assert.deepEqual(small.result.manifest.outputs, repeated.result.manifest.outputs);
  assert.equal(repeated.result.manifest.outputs.exitMultiple.cell, 'Assumptions!B1');
  console.log(`Synthetic 20,000-cell grid: 1 label ${small.scans} scans/${small.elapsedMs.toFixed(1)}ms; 80 labels ${repeated.scans} scans/${repeated.elapsedMs.toFixed(1)}ms`);
  assert.equal(repeated.scans, small.scans, 'whole-grid scans must not grow with matched labels');
});
await test('far sparse columns and sheet names containing ! retain selection', () => {
  const gt = {
    'Fund!Plan!A8': 'Terminal Value',
    'Fund!Plan!B8': 1000000,
    'Fund!Plan!XFD8': 2000000,
    'Fund!Plan!XFD9': 3000000,
    'Assumptions!Z2': 'Exit Multiple',
    'Assumptions!AA2': 14,
    'Assumptions!XFD2': 0,
  };
  const { manifest } = generate(gt);
  assert.equal(manifest.outputs.terminalValue.cell, 'Fund!Plan!XFD8');
  assert.equal(manifest.outputs.exitMultiple.cell, 'Assumptions!AA2');
});
await test('label anchoring, value ranges, and equal-score insertion ties are unchanged', () => {
  const gt = {
    'Assumptions!C9': 'Exit Multiple',
    'Assumptions!D9': 15,
    'Assumptions!B9': 13,
    'Assumptions!XFD9': 16,
    'Assumptions!C1': 'Exit Multiple',
    'Assumptions!B1': 11,
    'Assumptions!D1': 12,
    'Assumptions!B8': 5000000,
  };
  assert.equal(generate(gt).manifest.outputs.exitMultiple.cell, 'Assumptions!B9');
  gt['Assumptions!B9'] = 5000000;
  assert.equal(generate(gt).manifest.outputs.exitMultiple.cell, 'Assumptions!D9');
});
await test('regenerating after mutations rebuilds column discovery', () => {
  const gt = { 'Summary!A2': 'Terminal Value', 'Summary!B2': 1000000 };
  assert.equal(generate(gt).manifest.outputs.terminalValue.cell, 'Summary!B2');
  gt['Summary!XFD2'] = 2000000;
  assert.equal(generate(gt).manifest.outputs.terminalValue.cell, 'Summary!XFD2');
  delete gt['Summary!XFD2'];
  gt['Summary!B2'] = 'no value';
  gt['Summary!C2'] = 3000000;
  assert.equal(generate(gt).manifest.outputs.terminalValue.cell, 'Summary!C2');
});
await test('noncanonical row spellings retain their original source addresses', () => {
  const gt = {
    'Summary!A2': 'Terminal Value',
    'Summary!B02': 1000000,
    'Summary!AA02': 2000000,
  };
  assert.equal(generate(gt).manifest.outputs.terminalValue.cell, 'Summary!AA02');
});
await test('family-specific output selection uses the same row semantics', () => {
  const corporate = {
    'Summary!A1': 'WACC', 'Summary!B1': 0.1,
    'Summary!A2': 'Enterprise Value', 'Summary!B2': 5000000, 'Summary!XFD2': 0,
    'Summary!A3': 'Equity Value', 'Summary!B3': 4000000,
    'Summary!A4': 'DCF',
  };
  const { manifest } = generate(corporate);
  assert.equal(manifest.model.type, 'corporate');
  assert.equal(manifest.outputs.enterpriseValue.cell, 'Summary!B2');
  assert.equal(manifest.outputs.equityValue.cell, 'Summary!B3');
});

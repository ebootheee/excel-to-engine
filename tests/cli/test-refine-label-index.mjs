#!/usr/bin/env node
/**
 * Tests for the refine label-index optimization.
 *
 * `ete manifest refine` now sources labels from the Rust parser's
 * `chunked/_labels.json` when present (an O(labels) read instead of scanning
 * every cell) and resolves same-row numerics lazily by probing the row's
 * columns — rather than bucketing every numeric in a multi-million-cell
 * workbook up front. These tests assert:
 *
 *   1. refine finds the key metrics off `_labels.json`;
 *   2. it produces *identical* mappings whether `_labels.json` is present or it
 *      falls back to the legacy ground-truth scan (the optimization is
 *      behavior-preserving);
 *   3. the lazy numeric probe handles far / gapped columns and respects each
 *      field's value range;
 *   4. refine genuinely *consumes* `_labels.json` — a label that exists only in
 *      the index (not as a ground-truth string) is still resolved, which the
 *      GT-scan fallback provably cannot do.
 *
 * Pure JS — constructs the chunked artifacts directly, so it needs no parser.
 *
 * Usage: node tests/cli/test-refine-label-index.mjs
 */

import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runManifestRefine } from '../../cli/commands/manifest-refine.mjs';

let passed = 0;
let failed = 0;
function assert(cond, msg) { if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); } }

const BASE_MANIFEST = {
  manifestVersion: '1.0',
  model: { groundTruth: './_ground-truth.json' },
  equity: { classes: [{}] },
  carry: {},
  outputs: {},
  baseCaseOutputs: {},
};

// Write a self-contained chunked dir. Pass `labels: null` to omit _labels.json
// and exercise the legacy GT-scan fallback.
function makeDir({ gt, labels, manifest = BASE_MANIFEST }) {
  const dir = mkdtempSync(join(tmpdir(), 'refine-idx-'));
  writeFileSync(join(dir, '_ground-truth.json'), JSON.stringify(gt));
  if (labels) writeFileSync(join(dir, '_labels.json'), JSON.stringify(labels));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

// Build a _labels.json index ({ lower: [{sheet,col,row,text}] }) from
// [addr, text] pairs — the same shape the Rust parser emits.
function labelsFrom(pairs) {
  const idx = {};
  for (const [addr, text] of pairs) {
    const bang = addr.lastIndexOf('!');
    const sheet = addr.slice(0, bang);
    const m = addr.slice(bang + 1).match(/^([A-Z]+)(\d+)$/);
    (idx[text.toLowerCase()] ||= []).push({ sheet, col: m[1], row: +m[2], text });
  }
  return idx;
}

// A clean PE-summary ground truth: metric labels in col A, values in col C,
// plus a block of *unlabeled* numerics (a stand-in for a giant PP&E grid) that
// refine must never consult.
function summaryGt() {
  const gt = {
    'Summary!A1': 'Gross IRR', 'Summary!C1': 0.185,
    'Summary!A2': 'Net IRR', 'Summary!C2': 0.151,
    'Summary!A3': 'Gross MOIC', 'Summary!C3': 2.85,
    'Summary!A4': 'Net MOIC', 'Summary!C4': 2.45,
    'Summary!A5': 'Peak Net Equity', 'Summary!C5': 270_000_000,
  };
  for (let i = 1; i <= 50; i++) gt[`PPE!D${i}`] = 1000 + i; // unlabeled grid
  return gt;
}

const EXPECTED = {
  'Gross IRR': 'Summary!C1',
  'Net IRR': 'Summary!C2',
  'Gross MOIC': 'Summary!C3',
  'Net MOIC': 'Summary!C4',
  'Equity Basis / Peak Equity': 'Summary!C5',
};

// ---------------------------------------------------------------------------
// 1) Correctness — finds metrics via _labels.json
// ---------------------------------------------------------------------------
console.log('Testing: refine finds metrics via _labels.json');
{
  const gt = summaryGt();
  const labels = labelsFrom([
    ['Summary!A1', 'Gross IRR'], ['Summary!A2', 'Net IRR'],
    ['Summary!A3', 'Gross MOIC'], ['Summary!A4', 'Net MOIC'],
    ['Summary!A5', 'Peak Net Equity'],
  ]);
  const dir = makeDir({ gt, labels });
  const r = runManifestRefine(dir, { apply: false });
  for (const [label, cell] of Object.entries(EXPECTED)) {
    assert(r.found[label]?.cell === cell, `${label} -> ${cell} (got ${r.found[label]?.cell})`);
  }
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 2) Parity — _labels.json path == legacy GT-scan fallback
// ---------------------------------------------------------------------------
console.log('Testing: identical result with _labels.json vs GT-scan fallback');
{
  const gt = summaryGt();
  const labels = labelsFrom([
    ['Summary!A1', 'Gross IRR'], ['Summary!A2', 'Net IRR'],
    ['Summary!A3', 'Gross MOIC'], ['Summary!A4', 'Net MOIC'],
    ['Summary!A5', 'Peak Net Equity'],
  ]);
  const dirIdx = makeDir({ gt, labels });
  const dirScan = makeDir({ gt, labels: null }); // no _labels.json -> fallback
  const withIdx = runManifestRefine(dirIdx, { apply: false });
  const fallback = runManifestRefine(dirScan, { apply: false });

  assert(Object.keys(withIdx.found).length === Object.keys(fallback.found).length,
    `same field count (idx ${Object.keys(withIdx.found).length} vs scan ${Object.keys(fallback.found).length})`);
  for (const key of Object.keys(withIdx.found)) {
    assert(withIdx.found[key].cell === fallback.found[key]?.cell,
      `parity for ${key}: idx=${withIdx.found[key].cell} scan=${fallback.found[key]?.cell}`);
  }
  rmSync(dirIdx, { recursive: true, force: true });
  rmSync(dirScan, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 3) Lazy probe — far/gapped column + value-range filtering
// ---------------------------------------------------------------------------
console.log('Testing: lazy probe handles gapped far columns and value ranges');
{
  // Exit Multiple's value sits in a far column (AA, gaps before it); a
  // near-column decimal is out of the [1,50] range and must be rejected.
  const gt = {
    'Summary!A1': 'Exit Multiple',
    'Summary!B1': 0.5,   // out of range -> rejected
    'Summary!AA1': 18,   // in range, far column -> selected
  };
  const labels = labelsFrom([['Summary!A1', 'Exit Multiple']]);
  const dir = makeDir({ gt, labels });
  const r = runManifestRefine(dir, { apply: false });
  assert(r.found['Exit Multiple']?.cell === 'Summary!AA1',
    `far-column probe past gaps + range filter (got ${r.found['Exit Multiple']?.cell})`);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 4) Consumption proof — a label present only in the index is still resolved
// ---------------------------------------------------------------------------
console.log('Testing: refine consumes _labels.json (label only in index, not GT)');
{
  // No 'Summary!A7' label string in the GT — only the numeric. The label lives
  // solely in _labels.json. Resolving it proves the index was the source.
  const gt = { 'Summary!C7': 0.20 };
  const labels = labelsFrom([['Summary!A7', 'Gross IRR']]);
  const dir = makeDir({ gt, labels });
  const r = runManifestRefine(dir, { apply: false });
  assert(r.found['Gross IRR']?.cell === 'Summary!C7',
    `index-only label resolved (got ${r.found['Gross IRR']?.cell})`);

  // Inverse: with no _labels.json the GT scan cannot find a label absent from
  // the GT — confirming the index, not a GT string, drove the match above.
  const dirScan = makeDir({ gt, labels: null });
  const rScan = runManifestRefine(dirScan, { apply: false });
  assert(!rScan.found['Gross IRR'],
    'GT-scan fallback cannot resolve a label that is absent from the ground truth');

  rmSync(dir, { recursive: true, force: true });
  rmSync(dirScan, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

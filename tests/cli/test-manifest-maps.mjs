#!/usr/bin/env node

/**
 * Tests for the downstream contract maps (named-outputs / named-inputs /
 * cell-types) emitted per the Mippy engine-integration request (2026-05-27):
 *
 *  - named-outputs.json mirrors the manifest's resolved base-case outputs but
 *    keeps the cell ref (no drift vs resolveBaseCaseOutputs)
 *  - defined-name enrichment: a workbook named cell tags the output, and a
 *    defined name that disagrees with heuristic detection overrides it
 *  - named-inputs.json picks up defined-name cells that are read by ≥1 formula
 *  - cell-types.json distinguishes label / number / boolean / empty
 *  - emitManifestMaps writes all three (and skips inputs gracefully w/o .xlsx)
 */

import XLSX from 'xlsx';
import { readFileSync, existsSync, mkdtempSync, cpSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { resolveBaseCaseOutputs } from '../../lib/manifest.mjs';
import {
  collectNamedOutputs, collectNamedInputs, collectCellTypes, enumerateOutputCells,
  emitManifestMaps,
} from '../../lib/manifest-maps.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); }
}

const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf-8'));
const gt = JSON.parse(readFileSync(join(FIXTURES, '_ground-truth.json'), 'utf-8'));

// ---------------------------------------------------------------------------
// named-outputs: shape + no drift vs resolveBaseCaseOutputs
// ---------------------------------------------------------------------------
console.log('Testing: collectNamedOutputs shape + drift');
{
  const no = collectNamedOutputs(manifest, gt);
  assert(Object.keys(no).length >= 10, `at least 10 outputs (got ${Object.keys(no).length})`);

  const moic = no.grossMOIC;
  assert(moic?.cell === 'Equity!AN887', 'grossMOIC points at Equity!AN887');
  assert(moic?.baseCaseValue === 2.85, 'grossMOIC baseCaseValue = 2.85');
  assert(moic?.type === 'number', 'grossMOIC type number');
  assert(moic?.format === 'multiple', 'grossMOIC format multiple');
  assert(moic?.label === 'Gross MOIC', 'grossMOIC label pulled from the row');
  assert(no.grossIRR?.format === 'fraction', 'grossIRR format fraction');
  assert(no.terminalValue?.format === 'currency', 'terminalValue format currency');

  // Every output that overlaps baseCaseOutputs must agree (drift guard).
  const bco = resolveBaseCaseOutputs(manifest, gt);
  let drift = 0;
  for (const [k, v] of Object.entries(no)) {
    if (k in bco && bco[k] !== v.baseCaseValue) drift++;
  }
  assert(drift === 0, `no drift vs resolveBaseCaseOutputs (got ${drift})`);

  // enumerateOutputCells keys are a superset of what we emit (1:1 here).
  assert(Object.keys(enumerateOutputCells(manifest)).length === Object.keys(no).length,
    'enumerateOutputCells matches emitted output count');
}

// ---------------------------------------------------------------------------
// named-outputs: defined-name enrichment + override
// ---------------------------------------------------------------------------
console.log('Testing: defined-name enrichment and override');
{
  const m = { equity: { classes: [{ id: 'a', grossMOIC: 'Equity!Z9' }] } };
  const g = { 'Equity!Z9': 2.85, 'Equity!Q5': 2.90 };

  // Same cell carries a defined name → enrich (no override).
  const enrich = collectNamedOutputs(m, g, new Map([['Equity!Z9', 'Gross_MOIC']]));
  assert(enrich.grossMOIC.source === 'defined-name', 'enriched output marked defined-name');
  assert(enrich.grossMOIC.excelName === 'Gross_MOIC', 'enriched output carries excelName');
  assert(enrich.grossMOIC.cell === 'Equity!Z9', 'enriched output keeps the cell');
  assert(enrich.grossMOIC.manifestCell === undefined, 'no manifestCell when cells agree');

  // A defined name matching the semantic name but pointing elsewhere → override.
  const override = collectNamedOutputs(m, g, new Map([['Equity!Q5', 'Gross_MOIC']]));
  assert(override.grossMOIC.cell === 'Equity!Q5', 'defined-name overrides heuristic cell');
  assert(override.grossMOIC.baseCaseValue === 2.90, 'override resolves the defined cell value');
  assert(override.grossMOIC.manifestCell === 'Equity!Z9', 'override records the displaced manifest cell');
}

// ---------------------------------------------------------------------------
// cell-types
// ---------------------------------------------------------------------------
console.log('Testing: collectCellTypes');
{
  const types = collectCellTypes({ 'S!A1': 'Label', 'S!B1': 42, 'S!C1': 0, 'S!D1': true, 'S!E1': null });
  assert(types['S!A1'] === 'label', 'string → label');
  assert(types['S!B1'] === 'number', 'number → number');
  assert(types['S!C1'] === 'number', 'zero → number (a real zero, not missing)');
  assert(types['S!D1'] === 'boolean', 'boolean → boolean');
  assert(types['S!E1'] === 'empty', 'null → empty');
  assert(!('S!Z9' in types), 'never-computed cell is absent (distinguishable from a real 0)');
}

// ---------------------------------------------------------------------------
// named-inputs from a synthetic workbook with defined names
// ---------------------------------------------------------------------------
console.log('Testing: collectNamedInputs (defined-name inputs read by a formula)');
function buildWorkbook() {
  const assumptions = {
    '!ref': 'A1:B3',
    A1: { t: 's', v: 'Exit Year' },
    B1: { t: 'n', v: 2029 },
    A2: { t: 's', v: 'Owned Exit Multiple' },
    B2: { t: 'n', v: 18.22 },
    A3: { t: 's', v: 'Unreferenced Scratch' },
    B3: { t: 'n', v: 99 }, // has a name but no formula reads it → excluded
  };
  const summary = {
    '!ref': 'A1:B1',
    A1: { t: 's', v: 'Combined' },
    B1: { t: 'n', v: 2047.22, f: 'Assumptions!B1+Assumptions!B2' },
  };
  return {
    SheetNames: ['Assumptions', 'Summary'],
    Sheets: { Assumptions: assumptions, Summary: summary },
    Workbook: {
      Names: [
        { Name: 'Exit_Year', Ref: 'Assumptions!$B$1' },
        { Name: 'Owned_Exit_Multiple', Ref: 'Assumptions!$B$2' },
        { Name: 'Scratch', Ref: 'Assumptions!$B$3' },
      ],
    },
  };
}
{
  const inputs = collectNamedInputs(buildWorkbook());
  assert(inputs.Exit_Year?.cell === 'Assumptions!B1', 'Exit_Year cell resolved');
  assert(inputs.Exit_Year?.default === 2029, 'Exit_Year default captured');
  assert(inputs.Exit_Year?.type === 'number', 'Exit_Year typed number');
  assert(inputs.Owned_Exit_Multiple?.default === 18.22, 'Owned_Exit_Multiple default captured');
  assert(inputs.Exit_Year?.referencedBy >= 1, 'Exit_Year confirmed read by ≥1 formula');
  assert(!('Scratch' in inputs), 'named-but-unreferenced cell excluded (not a real input)');
  assert(inputs.Exit_Year?.affectsOutputs === undefined, 'affectsOutputs absent in Round 1');
}

// ---------------------------------------------------------------------------
// emitManifestMaps end-to-end (with and without .xlsx)
// ---------------------------------------------------------------------------
console.log('Testing: emitManifestMaps without .xlsx (graceful skip)');
{
  const tmp = mkdtempSync(join(tmpdir(), 'ete-maps-'));
  cpSync(FIXTURES, tmp, { recursive: true });
  const res = emitManifestMaps(tmp, {});
  assert(res.written.includes('named-outputs.json'), 'outputs written w/o xlsx');
  assert(res.written.includes('cell-types.json'), 'cell-types written w/o xlsx');
  assert(!res.written.includes('named-inputs.json'), 'inputs skipped w/o xlsx');
  assert(res.skipped.some(s => s.file === 'named-inputs.json'), 'skip reason recorded');

  const out = JSON.parse(readFileSync(join(tmp, 'named-outputs.json'), 'utf-8'));
  assert(typeof out.modelHash === 'string' && out.modelHash.startsWith('sha256:'), 'modelHash present');
  assert(out.namedOutputs && Object.keys(out.namedOutputs).length >= 10, 'namedOutputs populated');
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: emitManifestMaps with .xlsx (full set)');
{
  const tmp = mkdtempSync(join(tmpdir(), 'ete-maps-'));
  cpSync(FIXTURES, tmp, { recursive: true });
  const xlsxPath = join(tmp, 'model.xlsx');
  writeFileSync(xlsxPath, XLSX.write(buildWorkbook(), { type: 'buffer', bookType: 'xlsx' }));

  const res = emitManifestMaps(tmp, { excelPath: xlsxPath });
  assert(res.written.includes('named-inputs.json'), 'inputs written with xlsx');
  assert(existsSync(join(tmp, 'named-inputs.json')), 'named-inputs.json on disk');

  const ni = JSON.parse(readFileSync(join(tmp, 'named-inputs.json'), 'utf-8'));
  assert(ni.namedInputs?.Exit_Year?.cell === 'Assumptions!B1', 'emitted inputs include Exit_Year');
  assert(res.stats.inputs >= 2, `at least 2 inputs emitted (got ${res.stats.inputs})`);
  rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

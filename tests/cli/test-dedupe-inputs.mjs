/**
 * test-dedupe-inputs.mjs — locks dedupeInputsByCell (Phase-0 Fix #3).
 *
 * A workbook defined name (e.g. ExitCapRate) and a manifest-driver (exitMultiple)
 * frequently resolve to the SAME input cell. collectNamedInputs guarded driver
 * insertion by KEY NAME, not by cell, so both landed — and the human-named one
 * showed affectsOutputs:[] while the cryptic driver twin held the real closure.
 * dedupeInputsByCell collapses them post-closure: one entry per cell, keeping the
 * defined-name identity + the UNION of affectsOutputs. This unit test pins that
 * contract on synthetic input maps (no parser/engine — fast).
 *
 * @license MIT
 */
import { dedupeInputsByCell } from '../../lib/manifest-maps.mjs';

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('\nDedupe-inputs (Fix #3) suite\n');

// 1. The canonical case: defined-name (inert) + manifest-driver (real closure)
//    on one cell → one entry, defined-name identity, unioned closure.
{
  const ni = {
    ExitCapRate: { cell: 'Deal!B11', source: 'defined-name', excelName: 'ExitCapRate', format: 'fraction', affectsOutputs: [], min: 0, max: 0.1 },
    exitMultiple: { cell: 'Deal!B11', source: 'manifest-driver', affectsOutputs: ['grossIRR', 'grossMOIC', 'terminalValue'] },
    LTV: { cell: 'Deal!B12', source: 'defined-name', excelName: 'LTV', affectsOutputs: ['exitDebt'] },
  };
  const { merged } = dedupeInputsByCell(ni);
  const keys = Object.keys(ni);
  ok('merged exactly one duplicate', merged === 1, `merged=${merged}`);
  ok('only one entry remains for the shared cell',
    keys.filter(k => ni[k].cell === 'Deal!B11').length === 1);
  ok('kept the defined-name identity (ExitCapRate, not exitMultiple)',
    !!ni.ExitCapRate && !ni.exitMultiple, `keys=${keys.join(',')}`);
  ok('surviving lever carries the UNION closure (aff=3)',
    (ni.ExitCapRate?.affectsOutputs || []).length === 3,
    JSON.stringify(ni.ExitCapRate?.affectsOutputs));
  ok('records mergedFrom for auditability',
    Array.isArray(ni.ExitCapRate?.mergedFrom) && ni.ExitCapRate.mergedFrom.includes('exitMultiple'));
  ok('preserved the defined-name metadata (format/min/max)',
    ni.ExitCapRate?.format === 'fraction' && ni.ExitCapRate?.min === 0);
  ok('untouched lever on a different cell is unchanged', ni.LTV?.cell === 'Deal!B12');
}

// 2. No duplicates → no-op (and merged === 0).
{
  const ni = {
    A: { cell: 'S!B1', source: 'defined-name', affectsOutputs: ['x'] },
    B: { cell: 'S!B2', source: 'manifest-driver', affectsOutputs: ['y'] },
  };
  const before = JSON.stringify(ni);
  const { merged } = dedupeInputsByCell(ni);
  ok('no-op when all cells distinct', merged === 0 && JSON.stringify(ni) === before);
}

// 3. Two defined names on one cell (no driver) → still collapses to one, union closure.
{
  const ni = {
    PrimaryName: { cell: 'S!B1', source: 'defined-name', excelName: 'PrimaryName', affectsOutputs: ['a'] },
    AliasName: { cell: 'S!B1', source: 'defined-name', excelName: 'AliasName', affectsOutputs: ['b'] },
  };
  const { merged } = dedupeInputsByCell(ni);
  ok('two defined-names on one cell collapse to one', merged === 1 && Object.keys(ni).length === 1);
  const only = Object.values(ni)[0];
  ok('union closure across both defined names (aff=2)', (only.affectsOutputs || []).length === 2,
    JSON.stringify(only.affectsOutputs));
}

console.log(`\nResults: ${pass} passed, ${fail} failed, ${pass + fail} total\n`);
process.exit(fail === 0 ? 0 : 1);

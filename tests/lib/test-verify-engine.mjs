/** Synthetic trust-boundary regressions; no workbook or parser required. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyEngine, resolveOutput, close } from '../../lib/verify-engine.mjs';
import { emitIntegrationDoc, selectGroundTruthSubset } from '../../lib/integration-doc.mjs';

const scalar = { value: { cell: 'Results!B1', baseCaseValue: 12 } };
function fixture(t, code, outputs = scalar, gt = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ete-verify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'engine.js'), code);
  writeFileSync(join(dir, 'named-outputs.json'), JSON.stringify({ namedOutputs: outputs }));
  writeFileSync(join(dir, '_ground-truth.json'), JSON.stringify(gt));
  return dir;
}
const engine = (values, meta = '') => `export function run() { return { values: ${values}${meta ? `, meta: ${meta}` : ''} }; }`;

await test('loads all lazy dependencies and awaits run before comparison', async t => {
  const dir = fixture(t, `let ready = false;
    export async function load(options) {
      if (options !== undefined) throw new Error('full verification must load every sheet');
      await new Promise(resolve => setTimeout(resolve, 5)); ready = true;
    }
    export async function run() {
      if (!ready) throw new Error('not loaded');
      return { values: { 'Results!B1': 12 }, meta: { converged: true } };
    }`);
  const result = await verifyEngine(dir);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.checked, 1);
});
await test('default-export engine methods retain their receiver', async t => {
  const dir = fixture(t, `export default {
    ready: false, async load() { this.ready = true; },
    async run() { if (!this.ready) throw new Error('not loaded'); return { values: { 'Results!B1': 12 } }; }
  };`);
  const result = await verifyEngine(dir);
  assert.equal(result.ok, true);
  assert.equal(result.checked, 1);
});
for (const [name, code, error] of [
  ['load rejection', `export async function load() { throw new Error('load failed'); } ${engine("{'Results!B1':12}")}`, /load\(\).*load failed/],
  ['async run rejection', `export async function run() { throw new Error('run failed'); }`, /run\(\).*run failed/],
]) {
  await test(name, async t => {
    const result = await verifyEngine(fixture(t, code));
    assert.equal(result.ok, false);
    assert.match(result.error, error);
  });
}
for (const [name, outputs] of [
  ['no named outputs', {}],
  ['no recorded baselines', { optional: { cell: 'Results!B2' } }],
]) {
  await test(`${name} cannot pass with zero comparisons`, async t => {
    const result = await verifyEngine(fixture(t, engine('{}'), outputs));
    assert.equal(result.ok, false);
    assert.equal(result.checked, 0);
  });
}
for (const [name, values] of [['absent value', '{}'], ['undefined value', "{'Results!B1':undefined}"], ['null value', "{'Results!B1':null}"], ['NaN', "{'Results!B1':NaN}"], ['Infinity', "{'Results!B1':Infinity}"]]) {
  await test(`${name} fails even when another output matches`, async t => {
    const outputs = { ...scalar, other: { cell: 'Results!C1', baseCaseValue: 7 } };
    const result = await verifyEngine(fixture(t, engine(`{...${values}, 'Results!C1':7}`), outputs));
    assert.equal(result.ok, false);
    assert.equal(result.matched, 1);
    assert.equal(result.drifted[0].name, 'value');
  });
}
await test('missing zero is not a match', async t => {
  const result = await verifyEngine(fixture(t, engine('{}'), { zero: { cell: 'Results!B1', baseCaseValue: 0 } }));
  assert.equal(result.ok, false);
  assert.equal(result.drifted[0].reason, 'missing computed value');
});
await test('optional outputs are reported separately and GT fallback stays supported', async t => {
  const result = await verifyEngine(fixture(t, engine("{'Results!B1':12}"), {
    value: { cell: 'Results!B1' }, optional: { cell: 'Results!B2', baseCaseValue: null },
  }, { 'Results!B1': 12 }));
  assert.equal(result.ok, true);
  assert.equal(result.checked, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].name, 'optional');
});
await test('text and boolean outputs retain exact comparison semantics', async t => {
  const result = await verifyEngine(fixture(t, engine("{'Results!A1':'Ready','Results!A2':false}"), {
    label: { cell: 'Results!A1', baseCaseValue: 'Ready' }, flag: { cell: 'Results!A2', baseCaseValue: false },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.matched, 2);
});
await test('finite tolerances remain additive; non-finite values never match', () => {
  assert.equal(close(100.00005, 100), true);
  assert.equal(close(0.0000005, 0), true);
  assert.equal(close(1.1, 1, 0, 0.2), true);
  assert.equal(close(Infinity, Infinity), false);
  assert.equal(close(NaN, NaN), false);
});
for (const [name, meta] of [
  ['aggregate', '{converged:false}'],
  ['cluster', '{clusters:[{converged:false}]}'],
  ['sheet', '{converged:true,sheetConvergence:{Results:{converged:false}}}'],
]) {
  await test(`explicit ${name} non-convergence prevents a pass`, async t => {
    const result = await verifyEngine(fixture(t, engine("{'Results!B1':12}", meta)));
    assert.equal(result.ok, false);
    assert.equal(result.matched, 1);
    assert.match(result.error, /converg/i);
  });
}
await test('legacy engines without convergence metadata remain supported', async t => {
  assert.equal((await verifyEngine(fixture(t, engine("{'Results!B1':12}")))).ok, true);
});
await test('flow schedules cannot silently discard absent cells', async t => {
  const outputs = { flow: { cellRange: 'Results!B1:D1', aggregation: 'sum', baseCaseValue: 12 } };
  assert.equal((await verifyEngine(fixture(t, engine("{'Results!B1':5,'Results!D1':7}"), outputs))).ok, false);
  assert.equal((await verifyEngine(fixture(t, engine("{'Results!B1':5,'Results!C1':0,'Results!D1':7}"), outputs))).ok, true);
});
await test('members the source workbook left empty are blanks when ground truth is present', async t => {
  const outputs = { flow: { cellRange: 'Results!B1:D1', aggregation: 'sum', baseCaseValue: 12 } };
  const gt = { 'Results!B1': 5, 'Results!D1': 7 }; // C1 has no value in Excel
  assert.equal((await verifyEngine(fixture(t, engine("{'Results!B1':5,'Results!D1':7}"), outputs, gt))).ok, true);
  // ...but a recorded numeric member the engine dropped is still a hole.
  const dropped = await verifyEngine(fixture(t, engine("{'Results!B1':5}"), outputs, gt));
  assert.equal(dropped.ok, false);
  assert.equal(dropped.drifted[0].reason, 'missing computed value');
});
await test('terminal schedules require the terminal cell, not the last available one', () => {
  const output = { cellRange: 'Results!B1:D1', aggregation: 'terminal' };
  assert.equal(resolveOutput(output, { 'Results!B1': 12 }), undefined);
  assert.equal(resolveOutput(output, { 'Results!D1': 12 }), 12);
});
await test('complete schedules retain sum semantics for explicit text blanks', () => {
  assert.equal(resolveOutput({ cellRange: 'Results!B1:D1', aggregation: 'sum' }, {
    'Results!B1': 5, 'Results!C1': '', 'Results!D1': 7,
  }), 12);
});
for (const [name, code, outputs, expectedStatus, gt = {}] of [
  ['matching lazy', `let loaded=false; export async function load(){loaded=true;} export function run(){if(!loaded)throw new Error('load first');return {values:{'Results!B1':12}};}`, scalar, 0],
  ['known blank flow', engine("{'Results!B1':5,'Results!D1':7}"), { flow: { cellRange: 'Results!B1:D1', aggregation: 'sum', baseCaseValue: 12 } }, 0, { 'Results!B1': 5, 'Results!C1': null, 'Results!D1': 7 }],
  ['source-blank flow', engine("{'Results!B1':5,'Results!D1':7}"), { flow: { cellRange: 'Results!B1:D1', aggregation: 'sum', baseCaseValue: 12 } }, 0, { 'Results!B1': 5, 'Results!D1': 7 }],
  ['missing numeric flow', engine("{'Results!B1':5,'Results!D1':7}"), { flow: { cellRange: 'Results!B1:D1', aggregation: 'sum', baseCaseValue: 12 } }, 1, { 'Results!B1': 5, 'Results!C1': 0, 'Results!D1': 7 }],
  // Ground truth exists but records none of the range members: with the full map
  // the CLI treats C1 as a source blank; the demo's empty slice must agree.
  ['unrelated ground truth only', engine("{'Results!B1':5,'Results!D1':7}"), { flow: { cellRange: 'Results!B1:D1', aggregation: 'sum', baseCaseValue: 12 } }, 0, { 'Other!A1': 1 }],
  ['optional skipped', engine("{'Results!B1':12}"), { ...scalar, optional: { cell: 'Results!B2' } }, 0],
  ['text and boolean', engine("{'Results!B1':'Ready','Results!B2':false}"), { text: { cell: 'Results!B1', baseCaseValue: 'Ready' }, flag: { cell: 'Results!B2', baseCaseValue: false } }, 0],
  ['GT fallback', engine("{'Results!B1':12}"), { value: { cell: 'Results!B1' } }, 0, { 'Results!B1': 12 }],
  ['missing zero', engine('{}'), { zero: { cell: 'Results!B1', baseCaseValue: 0 } }, 1],
  ['drift', engine("{'Results!B1':13}"), scalar, 1],
  ['non-converged', engine("{'Results!B1':12}", '{converged:false}'), scalar, 1],
  ['empty', engine('{}'), {}, 1],
  ['all unverified', engine('{}'), { optional: { cell: 'Results!B1' } }, 1],
]) {
  await test(`CLI and generated standalone demo: ${name}`, async t => {
    const dir = fixture(t, code, outputs, gt);
    emitIntegrationDoc(dir);
    for (const args of [[resolve('cli/index.mjs'), 'verify', dir], [resolve('cli/index.mjs'), 'verify', dir, '--format', 'json'], [join(dir, 'example.mjs')]]) {
      const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, expectedStatus, `${args[0]}: ${result.stdout}\n${result.stderr}`);
      if (args.includes('json')) assert.equal(JSON.parse(result.stdout).ok, expectedStatus === 0);
      if (name === 'optional skipped') {
        assert.match(result.stdout, /skipped/i);
        assert.doesNotMatch(result.stdout, /all outputs match/);
      }
      if (expectedStatus !== 0) assert.doesNotMatch(result.stdout, /all outputs match|Safe to hand|reproduces the model's base case/);
    }
  });
}

await test('recorded numeric schedule member cannot be replaced by null or text', async t => {
  for (const value of [null, '']) {
    const outputs = { flow: { cellRange: 'Results!B1:C1', aggregation: 'sum', baseCaseValue: 12 } };
    const dir = fixture(t, engine(JSON.stringify({ 'Results!B1': 12, 'Results!C1': value })), outputs,
      { 'Results!B1': 12, 'Results!C1': 0 });
    assert.equal((await verifyEngine(dir)).ok, false);
  }
});

await test('gtPresent overrides key-derived presence; omitted keeps the full-map rule', () => {
  const flow = { cellRange: 'Results!B1:D1', aggregation: 'sum' };
  const values = { 'Results!B1': 5, 'Results!D1': 7 };
  assert.equal(resolveOutput(flow, values, {}), undefined);               // no GT: unverifiable
  assert.equal(resolveOutput(flow, values, { 'Other!A1': 1 }), 12);       // full GT present: C1 is a blank
  assert.equal(resolveOutput(flow, values, {}, true), 12);                // empty slice, GT existed at build
  assert.equal(resolveOutput(flow, values, { 'Other!A1': 1 }, false), undefined);
  assert.equal(resolveOutput(flow, values, { 'Results!C1': 0 }, true), undefined); // recorded hole still fails
});

await test('ground-truth slice holds only scalar output cells and schedule range members', t => {
  const outputs = {
    flow: { cellRange: 'Results!B1:D1', aggregation: 'sum', baseCaseValue: 12 },
    terminal: { cell: 'Results!D2', cellRange: 'Results!B2:D2', aggregation: 'terminal', baseCaseValue: 3 },
    legacy: { cell: 'Results!B3' },                      // baseline comes from GT
    unrecorded: { cell: 'Results!B4', baseCaseValue: 1 }, // not in GT: nothing to copy
  };
  const gt = { 'Results!B1': 5, 'Results!D1': 7, 'Results!B2': 1, 'Results!C2': 2, 'Results!D2': 3, 'Results!B3': 9, 'Results!B4:D4': 0 };
  for (let i = 0; i < 500; i++) gt[`Bulk!A${i + 1}`] = i; // the part of a real file that must NOT ship
  const want = { 'Results!B1': 5, 'Results!D1': 7, 'Results!B2': 1, 'Results!C2': 2, 'Results!D2': 3, 'Results!B3': 9 };
  const sel = selectGroundTruthSubset(outputs, gt);
  assert.deepEqual(sel, { subset: want, present: true, cells: 6 });
  assert.deepEqual(selectGroundTruthSubset(outputs, {}), { subset: {}, present: false, cells: 0 });
  assert.deepEqual(selectGroundTruthSubset(outputs, null), { subset: {}, present: false, cells: 0 });

  // The emitted demo inlines exactly that slice and no longer reads the file.
  const dir = fixture(t, engine("{'Results!B1':5,'Results!D1':7,'Results!D2':3,'Results!B3':9,'Results!B4':1}"), outputs, gt);
  emitIntegrationDoc(dir);
  const src = readFileSync(join(dir, 'example.mjs'), 'utf8');
  assert.doesNotMatch(src, /readFileSync|node:fs|import\.meta\.url/);
  const m = src.match(/^const gt = (.*);$/m);
  assert.ok(m, 'example.mjs inlines a single-line gt slice');
  const inlined = JSON.parse(m[1]);
  assert.deepEqual(inlined, want);
  assert.equal(Object.keys(inlined).length, 6);
  assert.ok(Object.keys(inlined).every(k => !k.startsWith('Bulk!')));
  assert.match(src, /^const GT_PRESENT = true;$/m);
  assert.ok(src.length < 20000, `example.mjs is small (${src.length} bytes) despite a 500-cell ground truth`);
});

await test('generated demo passes with _ground-truth.json deleted when the slice covers its cells', t => {
  const cases = [
    // flow with a source-blank member: only the slice + GT_PRESENT make C1 a blank
    [engine("{'Results!B1':5,'Results!D1':7}"), { flow: { cellRange: 'Results!B1:D1', aggregation: 'sum', baseCaseValue: 12 } }, { 'Results!B1': 5, 'Results!D1': 7, 'Other!Z9': 1 }],
    // scalar whose baseline exists only in ground truth
    [engine("{'Results!B1':12}"), { value: { cell: 'Results!B1' } }, { 'Results!B1': 12, 'Other!Z9': 1 }],
    // ground truth present but recording none of the members (the GT_PRESENT edge)
    [engine("{'Results!B1':5,'Results!D1':7}"), { flow: { cellRange: 'Results!B1:D1', aggregation: 'sum', baseCaseValue: 12 } }, { 'Other!Z9': 1 }],
  ];
  for (const [code, outputs, gt] of cases) {
    const dir = fixture(t, code, outputs, gt);
    emitIntegrationDoc(dir);
    rmSync(join(dir, '_ground-truth.json'));
    assert.equal(existsSync(join(dir, '_ground-truth.json')), false);
    const result = spawnSync(process.execPath, [join(dir, 'example.mjs')], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /1 outputs match baseCaseValue/);
  }
  // Negative control: built without ground truth, the same absent member stays a
  // hole — the slice cannot manufacture presence the build never had.
  const dir = fixture(t, engine("{'Results!B1':5,'Results!D1':7}"), { flow: { cellRange: 'Results!B1:D1', aggregation: 'sum', baseCaseValue: 12 } }, {});
  emitIntegrationDoc(dir);
  assert.match(readFileSync(join(dir, 'example.mjs'), 'utf8'), /^const GT_PRESENT = false;$/m);
  rmSync(join(dir, '_ground-truth.json'));
  const result = spawnSync(process.execPath, [join(dir, 'example.mjs')], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /missing computed value/);
});

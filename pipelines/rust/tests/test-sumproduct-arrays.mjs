#!/usr/bin/env node
// Synthetic end-to-end regression: parse an XLSX, import emitted JS, execute formulas.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import XLSX from 'xlsx';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const parser = join(root, 'pipelines/rust/target/release', process.platform === 'win32' ? 'rust-parser.exe' : 'rust-parser');
assert.ok(existsSync(parser), 'Build the release parser before running this regression');
const tmp = mkdtempSync(join(tmpdir(), 'ete-sumproduct-'));
const formulas = [
  ['SUMPRODUCT(B1:B3)', 60],
  ['SUMPRODUCT(B1:B3,C1:C3)', 140],
  ['SUMPRODUCT(B1:B3,C1:C3,D1:D3)', 370],
  ['SUMPRODUCT(B1:B3,C1:C3,D1:D3,C1:C3)', 990],
  ['SUMPRODUCT(--(A1:A3=A1),B1:B3,C1:C3)', 100],
  ['SUMPRODUCT((A1:A3=A1)*B1:B3*C$1:C$3)', 100],
  ['SUMPRODUCT(B1:B3/C1:C3)', 30],
  ['SUMPRODUCT(2*B1:B3)', 120],
  ['SUMPRODUCT(--(B1:B3>=20),C1:C3)', 5],
  ['SUMPRODUCT(--(B1:B3=C1:C3*10),B1:B3)', 60],
  ['SUMPRODUCT(B1:B3,C1:C2)', NaN],
  ['SUMPRODUCT(B1:B2,C1:C3)', NaN],
  ['SUMPRODUCT(B1:B3+C1:C2)', NaN],
  ['SUMPRODUCT(B1:B3,D1:D3,E1:E3)', NaN],
  ['IFERROR(SUMPRODUCT(--(E1:E3=0),B1:B3),-9)', -9],
  ['SUMPRODUCT(B1:B3,C1:C3,F1:F3)', 90],
  ['SUMPRODUCT(2,3,4)', 24],
];
const sheet = XLSX.utils.aoa_to_sheet([
  ['group-a', 10, 1, 2, 1, 'text'],
  ['group-b', 20, 2, 2, 1, null],
  ['group-a', 30, 3, 3, 1, 1],
]);
sheet.E2 = { t: 'n', f: '1/0', v: 0 };
formulas.forEach(([f], i) => { sheet[`H${i + 1}`] = { t: 'n', f, v: -777 }; });
sheet['!ref'] = `A1:H${formulas.length}`;
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, sheet, 'Synthetic');
try {
  const source = join(tmp, 'synthetic.xlsx');
  writeFileSync(source, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  execFileSync(parser, [source, tmp, '--chunked', '--lazy-engine'], { stdio: 'pipe' });
  const engine = await import(pathToFileURL(join(tmp, 'chunked/engine.js')));
  await engine.load();
  const baseline = engine.run({}, { strict: true }).values;
  formulas.forEach(([f, expected], i) => {
    assert.equal(baseline[`Synthetic!H${i + 1}`], expected, f);
  });
  const changed = engine.run({ 'Synthetic!A1': 'group-b', 'Synthetic!B1': 15 }, { strict: true }).values;
  assert.equal(changed['Synthetic!H5'], 55, 'mask and values recompute after input changes');
  assert.equal(changed['Synthetic!H6'], 55, 'single-expression form recomputes too');
  console.log(`PASS: ${formulas.length + 2} SUMPRODUCT execution checks`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

/**
 * End-to-end regression for the COL$ROW mixed-reference bug (T-078).
 *
 * Complements the transpiler-level `formula_ast.rs` unit tests with a full
 * parse → emit → engine.run() check: a relative-column/absolute-row reference
 * like `B$1` (the header/date-row anchor idiom) must compute the right VALUE,
 * not `number * "B"` = NaN (and the rest of the formula must not be dropped).
 * 240,973 such cells on the real Outpost A-1 model. Skips if rust-parser is absent.
 *
 * Usage: node tests/cli/test-colrow-ref.mjs
 * @license MIT
 */
import XLSX from 'xlsx';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..');
const exe = process.platform === 'win32' ? '.exe' : '';
const PARSER = [
  join(ROOT, 'pipelines/rust/target/release', `rust-parser${exe}`),
  join(ROOT, 'pipelines/rust/target/debug', `rust-parser${exe}`),
].find(existsSync);
if (!PARSER) { console.log('SKIP: rust-parser not built'); process.exit(0); }

let passed = 0, failed = 0;
const assert = (c, m) => { if (c) passed++; else { failed++; console.error(`  FAIL: ${m}`); } };

const num = (v, f) => (f ? { t: 'n', v, f } : { t: 'n', v });
const S = {
  '!ref': 'A1:F3',
  A1: num(5), B1: num(10), B2: num(20), B3: num(30),
  C1: num(0, 'A1*B$1'),       // THE BUG CASE: relative col, absolute row
  D1: num(0, 'A1*$B$1'),      // control: both-absolute (already worked)
  E1: num(0, 'SUM(B$1:B$3)'), // range whose start is a mixed ref
};
const tmp = mkdtempSync(join(tmpdir(), 'colrow-test-'));
try {
  const xlsx = join(tmp, 'm.xlsx');
  writeFileSync(xlsx, XLSX.write({ SheetNames: ['S'], Sheets: { S } }, { type: 'buffer', bookType: 'xlsx' }));
  execFileSync(PARSER, [xlsx, join(tmp, 'out'), '--chunked'], { stdio: 'pipe' });

  const mod = readFileSync(join(tmp, 'out', 'chunked', 'sheets', 'S.mjs'), 'utf-8');
  console.log('Testing: COL$ROW transpiles to a cell ref, not a string-multiply');
  assert(/ctx\.set\("S!C1",\s*\(ctx\.get\("S!A1"\)\s*\*\s*ctx\.get\("S!B1"\)\)\)/.test(mod), 'A1*B$1 → ctx.get("S!A1") * ctx.get("S!B1")');
  const strMul = mod.match(/\* `[A-Za-z]{1,3}`/g) || [];
  assert(strMul.length === 0, 'no bareword string-multiplies remain (found ' + strMul.length + ')');

  console.log('Testing: COL$ROW formulas compute correctly');
  const v = (await import(pathToFileURL(join(tmp, 'out', 'chunked', 'engine.js')).href)).run({}).values;
  assert(Math.abs(v['S!C1'] - 50) < 1e-9, `C1 = A1*B$1 = 50 (got ${v['S!C1']})`);
  assert(Math.abs(v['S!D1'] - 50) < 1e-9, `D1 = A1*$B$1 = 50 (got ${v['S!D1']})`);
  assert(Math.abs(v['S!E1'] - 60) < 1e-9, `E1 = SUM(B$1:B$3) = 60 (got ${v['S!E1']})`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

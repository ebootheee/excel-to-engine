#!/usr/bin/env node
/**
 * Regression: OFFSET / computed-endpoint helpers must answer #REF! (honest NaN)
 * past Excel's sheet bounds (1,048,576 rows x 16,384 cols) — never materialize
 * a value-sized rectangle.
 *
 * A displacement (or height/width) that comes from a poisoned/diverging cell can
 * be ~1e7+. Pre-fix, _offsetAddr happily produced "Sheet!A20000001", _dynRange
 * spanned the rectangle, and ctx.range() allocated it: a multi-GB allocation
 * that fatally OOMed the A-1 canonical eval MID-PASS at ~56 min under BOTH a
 * 12GB and a 20GB heap (cap-independent death — the alloc is proportional to
 * the VALUE, not the model). Excel's own answer past the bounds is #REF!.
 *
 * Pre-fix RED states this test discriminates:
 *   - scalar OFFSET out of bounds returned a SILENT 0 (missing-cell read)
 *   - SUM over an out-of-bounds computed-endpoint range returned a confident
 *     finite number after a multi-million-row materialization
 * Post-fix: all three out-of-bounds shapes are NaN; in-bounds shapes unchanged.
 *
 * Needs the rust-parser binary. Skips (exit 0) if it isn't built.
 *
 * Usage: node pipelines/rust/tests/test-offset-ref-bounds.mjs
 */

import XLSX from 'xlsx';
import { writeFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..', '..');
const exe = process.platform === 'win32' ? '.exe' : '';
const PARSER = [
  join(ROOT, 'pipelines/rust/target/release', `rust-parser${exe}`),
  join(ROOT, 'pipelines/rust/target/debug', `rust-parser${exe}`),
].find(existsSync);

if (!PARSER) {
  console.log('SKIP: rust-parser not built (cd pipelines/rust && cargo build --release)');
  process.exit(0);
}

let passed = 0, failed = 0;
const assert = (c, m) => { if (c) { passed++; } else { failed++; console.error(`  FAIL: ${m}`); } };
const n = (v, f) => (f ? { t: 'n', v, f } : { t: 'n', v });

console.log('Testing: OFFSET/_dynRange answer #REF! (NaN) past sheet bounds, never a value-sized allocation');

const S = {
  '!ref': 'A1:H3',
  A1: n(1), A2: n(2), A3: n(3),
  B1: n(2000000),                                         // poisoned-scale displacement (> max row)
  C1: n(0, 'SUM(A1:OFFSET(A1,B1,0))'),                    // computed endpoint past bounds -> NaN
  D1: n(0, 'OFFSET(A1,1500000,0)'),                       // scalar OFFSET past bounds -> NaN (was silent 0)
  E1: n(2, 'OFFSET(A1,1,0)'),                             // in-bounds scalar (regression)
  F1: n(6, 'SUM(A1:OFFSET(A1,2,0))'),                     // in-bounds computed endpoint (regression)
  G1: n(3, 'SUM(OFFSET(A1,0,0,2,1))'),                    // in-bounds multi-cell OFFSET (regression)
  H1: n(0, 'SUM(OFFSET(A1,0,0,2000000,1))'),              // poisoned HEIGHT -> NaN (was a 2M-row loop)
};

const tmp = mkdtempSync(join(tmpdir(), 'refb-'));
try {
  writeFileSync(join(tmp, 'm.xlsx'), XLSX.write({ SheetNames: ['S'], Sheets: { S } }, { type: 'buffer', bookType: 'xlsx' }));
  execFileSync(PARSER, [join(tmp, 'm.xlsx'), join(tmp, 'out'), '--chunked'], { encoding: 'utf-8', stdio: 'pipe' });
  const eng = await import(pathToFileURL(join(tmp, 'out', 'chunked', 'engine.js')).href);
  const t0 = Date.now();
  const { values } = eng.run();
  const secs = (Date.now() - t0) / 1000;

  assert(Number.isNaN(values['S!C1']), `out-of-bounds computed-endpoint SUM is NaN (got ${values['S!C1']})`);
  assert(Number.isNaN(values['S!D1']), `out-of-bounds scalar OFFSET is NaN (got ${values['S!D1']} — pre-fix: silent 0)`);
  assert(Number.isNaN(values['S!H1']), `out-of-bounds OFFSET height is NaN (got ${values['S!H1']})`);
  assert(values['S!E1'] === 2, `in-bounds scalar OFFSET unchanged (got ${values['S!E1']})`);
  assert(values['S!F1'] === 6, `in-bounds computed-endpoint SUM unchanged (got ${values['S!F1']})`);
  assert(values['S!G1'] === 3, `in-bounds multi-cell OFFSET unchanged (got ${values['S!G1']})`);
  assert(secs < 5, `no value-sized materialization (run took ${secs.toFixed(1)}s — pre-fix the 2M-row spans dominate)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

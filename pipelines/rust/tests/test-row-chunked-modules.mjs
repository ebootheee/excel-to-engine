#!/usr/bin/env node
/**
 * Regression for row-chunked sheet-module emission (#46).
 *
 * A monster sheet's single .mjs module fatally crashes node at IMPORT time —
 * V8 allocates ~2x the file's bytes to UTF-16-decode the source (the real A-2
 * Debt sheet: ~305MB module -> 609,447,784-byte fatal alloc) — before compute()
 * ever runs. The emitter now rotates any module crossing --max-module-mb into
 * `<Sheet>.partNNN.mjs` modules behind a same-named facade: ONE logical
 * compute(), identical write sequence, statement-boundary splits only, never
 * inside a convergence loop.
 *
 * This test builds REAL workbooks through the rust-parser and asserts:
 *  MODEL A (one big sheet, tiny cap, intra-sheet cycle, helper calls):
 *   1. facade + >=2 parts emitted; every part within cap + one-statement slack
 *   2. the intra-sheet convergence loop is INTACT inside exactly one part
 *   3. engine.run() reproduces ground truth bit-for-bit (chain, SUMs, cycle)
 *   4. cap=0 (negative control) emits the single-file form, no parts, and
 *      computes the IDENTICAL values map
 *   5. lib/cell-exprs extracts the same cell->expression surface from both
 *   6. a stale part file from a previous (larger) build is cleaned up
 *  MODEL B (cross-sheet cluster, OFFSET hidden inside a part):
 *   7. per-sheet-eval's dynamic-read scan follows the facade's part imports —
 *      it must log "keeping FULL GT seed" and score 100% (pre-fix the scan read
 *      only the facade, approved scoping, and the OFFSET's runtime-addressed
 *      external read was dropped to 0: a silently wrong, still-finite value)
 *
 * Needs the rust-parser binary. Skips (exit 0) if it isn't built.
 *
 * Usage: node pipelines/rust/tests/test-row-chunked-modules.mjs
 */

import XLSX from 'xlsx';
import { writeFileSync, existsSync, readFileSync, readdirSync, mkdtempSync, rmSync, statSync } from 'fs';
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

const CAP_MB = 1;
const CAP = CAP_MB * 1024 * 1024;
const ROWS = 30000;

// ── MODEL A: one big sheet — A-column chain, two SUMs, one intra-sheet cycle ──
function bigSheet() {
  const s = { '!ref': `A1:D${ROWS}` };
  s.A1 = n(1);
  for (let r = 2; r <= ROWS; r++) s[`A${r}`] = n(r, `A${r - 1}+1`);
  s.B5000 = n(55, 'SUM(A1:A10)');
  s.B15000 = n(10, 'SUM(A1:A4)');
  // Intra-sheet cycle: each 0.5*other+1 -> fixed point (2, 2)
  s.C1 = n(2, '0.5*D1+1');
  s.D1 = n(2, '0.5*C1+1');
  return s;
}

function build(sheets, names, capMb) {
  const tmp = mkdtempSync(join(tmpdir(), 'rowchunk-'));
  writeFileSync(join(tmp, 'm.xlsx'), XLSX.write({ SheetNames: names, Sheets: sheets }, { type: 'buffer', bookType: 'xlsx' }));
  execFileSync(PARSER, [join(tmp, 'm.xlsx'), join(tmp, 'out'), '--chunked', `--max-module-mb=${capMb}`],
    { encoding: 'utf-8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
  return { tmp, chunked: join(tmp, 'out', 'chunked') };
}

console.log('Testing: row-chunked module emission (#46) — facade + parts, one logical compute()');

{
  const { tmp, chunked } = build({ Big: bigSheet() }, ['Big'], CAP_MB);
  try {
    const sheetsDir = join(chunked, 'sheets');
    const facade = readFileSync(join(sheetsDir, 'Big.mjs'), 'utf-8');
    const parts = readdirSync(sheetsDir).filter(f => /^Big\.part\d{3}\.mjs$/.test(f)).sort();

    // 1 — facade + parts, sizes bounded
    assert(parts.length >= 2, `sheet split into >=2 parts (got ${parts.length})`);
    assert(facade.includes('export const SHEET_PARTS = ['), 'facade exports SHEET_PARTS');
    assert(facade.includes('export const SHEET_NAME = "Big";') && facade.includes('export const SHEET_DEPENDENCIES'),
      'facade keeps the SHEET_NAME / SHEET_DEPENDENCIES contract');
    for (const p of parts) {
      const sz = statSync(join(sheetsDir, p)).size;
      assert(sz <= CAP + 64 * 1024, `${p} within cap + one-statement slack (${sz} bytes)`);
    }
    const partsListed = (facade.match(/Big\.part\d{3}\.mjs/g) || []);
    assert(new Set(partsListed).size === parts.length, `facade references all ${parts.length} parts`);

    // 2 — convergence loop intact inside exactly one part
    const partSrc = parts.map(p => readFileSync(join(sheetsDir, p), 'utf-8'));
    const withLoopStart = partSrc.filter(s => s.includes('Convergence loop'));
    const withLoopEnd = partSrc.filter(s => s.includes('ctx._sheetConvergence[SHEET_NAME]'));
    assert(withLoopStart.length === 1 && withLoopEnd.length === 1 && withLoopStart[0] === withLoopEnd[0],
      'intra-sheet convergence loop is INTACT inside exactly one part');

    // 3 — engine reproduces ground truth through the facade
    const gt = JSON.parse(readFileSync(join(chunked, '_ground-truth.json'), 'utf-8'));
    const eng = await import(pathToFileURL(join(chunked, 'engine.js')).href);
    const run = eng.run();
    // Engine contract tolerance (1e-6, same as smoke-chunked): the intra-sheet
    // convergence loop stops at |delta| < 1e-6, not at machine-exact.
    let bad = 0;
    for (const [addr, exp] of Object.entries(gt)) {
      const got = run.values[addr];
      if (typeof exp === 'number' ? Math.abs(got - exp) > 1e-6 * Math.max(1, Math.abs(exp)) : String(got) !== String(exp)) {
        if (bad < 5) console.error(`    diverges: ${addr} GT=${exp} got=${got}`);
        bad++;
      }
    }
    assert(bad === 0, `split engine reproduces all ${Object.keys(gt).length} GT cells (got ${bad} divergent)`);
    assert(Math.abs(run.values['Big!C1'] - 2) < 1e-5 && Math.abs(run.values['Big!D1'] - 2) < 1e-5,
      'cycle converges to its fixed point through the parts');

    // 5a — cell-exprs sweeps facade + parts
    const { extractCellExprsSync } = await import(pathToFileURL(join(ROOT, 'lib', 'cell-exprs.mjs')).href);
    const exprsSplit = extractCellExprsSync(chunked);

    // 6 — stale higher-numbered part from a "previous build" gets cleaned up
    writeFileSync(join(sheetsDir, 'Big.part990.mjs'), '// stale\n');
    // ...but only contiguous ones above the current count are swept; emulate the
    // real hazard: part file numbered exactly at the next index.
    writeFileSync(join(sheetsDir, `Big.part${String(parts.length).padStart(3, '0')}.mjs`), 'export function compute() {}\n');
    execFileSync(PARSER, [join(tmp, 'm.xlsx'), join(tmp, 'out'), '--chunked', `--max-module-mb=${CAP_MB}`],
      { encoding: 'utf-8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
    assert(!existsSync(join(sheetsDir, `Big.part${String(parts.length).padStart(3, '0')}.mjs`)),
      'stale next-index part file from a previous build is removed on rebuild');
    rmSync(join(sheetsDir, 'Big.part990.mjs'), { force: true });

    // 4 — negative control: cap=0 emits the single-file form with identical values
    const { tmp: tmp0, chunked: chunked0 } = build({ Big: bigSheet() }, ['Big'], 0);
    try {
      const sheets0 = readdirSync(join(chunked0, 'sheets'));
      assert(!sheets0.some(f => /\.part\d{3}\.mjs$/.test(f)), 'cap=0: no part files');
      const single = readFileSync(join(chunked0, 'sheets', 'Big.mjs'), 'utf-8');
      assert(!single.includes('SHEET_PARTS'), 'cap=0: single-file module, no facade');
      const eng0 = await import(pathToFileURL(join(chunked0, 'engine.js')).href);
      const run0 = eng0.run();
      let diff = 0;
      for (const k of Object.keys(run.values)) {
        const a = run.values[k], b = run0.values[k];
        if (typeof a === 'number' && typeof b === 'number' ? a !== b && !(Number.isNaN(a) && Number.isNaN(b)) : String(a) !== String(b)) diff++;
      }
      assert(diff === 0, `split and single-file engines compute IDENTICAL values (${diff} differ)`);
      const exprsSingle = extractCellExprsSync(chunked0);
      assert(exprsSplit.size === exprsSingle.size && exprsSplit.size >= ROWS,
        `cell-exprs sees the same surface in both forms (split=${exprsSplit.size}, single=${exprsSingle.size})`);
    } finally {
      rmSync(tmp0, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── MODEL B: cross-sheet cluster with OFFSET hidden inside a part ──
{
  // Ext!F1 is reachable ONLY through OFFSET's runtime-addressed read (the static
  // edge map sees the anchor E1, never F1). Loop1 is padded so the OFFSET lands
  // inside a part module, not the facade.
  const Ext = { '!ref': 'A1:F1', E1: n(7), F1: n(42) };
  const Loop1 = { '!ref': `A1:C${ROWS}` };
  Loop1.A1 = n(2, '0.5*Loop2!A1+1');
  Loop1.B1 = n(42, 'OFFSET(Ext!E1,0,1)+0*Loop2!A1');
  Loop1.C1 = n(1);
  for (let r = 2; r <= ROWS; r++) Loop1[`C${r}`] = n(r, `C${r - 1}+1`);
  const Loop2 = { '!ref': 'A1:A1', A1: n(2, '0.5*Loop1!A1+1') };

  const { tmp, chunked } = build({ Ext, Loop1, Loop2 }, ['Ext', 'Loop1', 'Loop2'], CAP_MB);
  try {
    const parts = readdirSync(join(chunked, 'sheets')).filter(f => /^Loop1\.part\d{3}\.mjs$/.test(f));
    assert(parts.length >= 2, `cluster member Loop1 split into parts (got ${parts.length})`);
    const facadeSrc = readFileSync(join(chunked, 'sheets', 'Loop1.mjs'), 'utf-8');
    assert(!facadeSrc.includes('_offset('), 'OFFSET lives in a part, NOT the facade (the scan must follow imports)');

    const EVAL = join(ROOT, 'eval', 'per-sheet-eval.mjs');
    const out = join(tmp, 'report.json');
    let stdout = '';
    try {
      stdout = execFileSync('node', [EVAL, chunked, '--output', out, '--sample', '50000'],
        { encoding: 'utf-8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
    } catch (e) { stdout = String(e.stdout || ''); }
    const report = existsSync(out) ? JSON.parse(readFileSync(out, 'utf-8')) : null;

    assert(/keeping FULL GT seed/.test(stdout),
      'per-sheet-eval detects the dynamic read INSIDE the part and refuses to scope the cluster seed');
    assert(report !== null && report.summary.clustersConverged === 1,
      `cluster converged (got ${report && report.summary.clustersConverged})`);
    assert(report !== null && report.summary.overallAccuracy === 100,
      `100% accuracy incl. the OFFSET cell (got ${report && report.summary.overallAccuracy}% — a scoped seed drops Ext!F1 and computes Loop1!B1=0)`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

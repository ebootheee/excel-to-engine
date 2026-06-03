#!/usr/bin/env node
/**
 * Runtime contract tests for the generated chunked engine (Round 1 Rust half,
 * Mippy request 2026-05-27). Builds tiny models, parses them with the real
 * rust-parser, imports engine.js, and asserts the run() API:
 *
 *   - meta: convergence telemetry (converged / iterations / maxDelta / clusters)
 *   - unknownOverrides: override cells not read by any formula
 *   - options.strict: throws on unknown overrides
 *   - override pinning: an input override actually propagates (not clobbered by
 *     the sheet's literal/input pass)
 *
 * Needs the rust-parser binary. Skips (exit 0) if it isn't built — mirrors the
 * smoke test's binary dependency.
 *
 * Usage: node pipelines/rust/tests/test-engine-runtime.mjs
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

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); }
}
const near = (a, b, eps = 1e-3) => typeof a === 'number' && Math.abs(a - b) < eps;

/** Build a workbook from a {sheetName: cells} spec, parse it, import engine.js. */
async function buildEngine(sheets, names) {
  const wb = { SheetNames: Object.keys(sheets), Sheets: sheets };
  if (names) wb.Workbook = { Names: names };
  const tmp = mkdtempSync(join(tmpdir(), 'eng-rt-'));
  const xlsx = join(tmp, 'm.xlsx');
  writeFileSync(xlsx, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  execFileSync(PARSER, [xlsx, join(tmp, 'out'), '--chunked'], { encoding: 'utf-8', stdio: 'pipe' });
  const eng = await import(pathToFileURL(join(tmp, 'out', 'chunked', 'engine.js')).href);
  return { eng, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Acyclic model: telemetry, override pinning, unknownOverrides, strict
// ---------------------------------------------------------------------------
console.log('Testing: acyclic model — meta, override pin, unknownOverrides, strict');
{
  const Calc = {
    '!ref': 'A1:B3',
    A1: { t: 's', v: 'Input' }, B1: { t: 'n', v: 10 },
    A2: { t: 's', v: 'Doubled' }, B2: { t: 'n', v: 20, f: 'B1*2' },
    A3: { t: 's', v: 'Plus' }, B3: { t: 'n', v: 30, f: 'B2+B1' },
  };
  const { eng, cleanup } = await buildEngine({ Calc });

  const base = eng.run();
  assert(base.values['Calc!B2'] === 20 && base.values['Calc!B3'] === 30, 'base case computes (B2=20, B3=30)');
  assert(base.meta?.converged === true, 'no-cluster model reports converged:true');
  assert(base.meta?.iterations === 0, 'no-cluster iterations=0');
  assert(Array.isArray(base.meta?.clusters) && base.meta.clusters.length === 0, 'no clusters');
  assert(typeof base.meta?.elapsedMs === 'number', 'meta.elapsedMs present');
  assert(Array.isArray(base.unknownOverrides) && base.unknownOverrides.length === 0, 'no overrides → empty unknownOverrides');

  // Override pinning: the input override must propagate, not be clobbered.
  const ov = eng.run({ 'Calc!B1': 100 });
  assert(ov.values['Calc!B1'] === 100, 'override value pinned (not reset to 10)');
  assert(ov.values['Calc!B2'] === 200, 'override propagates: B2 = 100*2 = 200');
  assert(ov.values['Calc!B3'] === 300, 'override propagates: B3 = 200+100 = 300');
  assert(ov.unknownOverrides.length === 0, 'valid override cell is not flagged unknown');

  // Unknown / typo'd override cell.
  const bogus = eng.run({ 'Nope!Z9': 5 });
  assert(bogus.unknownOverrides.includes('Nope!Z9'), 'bogus override flagged in unknownOverrides');
  assert(bogus.values['Calc!B2'] === 20, 'bogus override has no effect on outputs');

  // strict mode.
  let threw = false;
  try { eng.run({ 'Nope!Z9': 5 }, { strict: true }); } catch { threw = true; }
  assert(threw, 'strict mode throws on unknown override');
  let threwValid = false;
  try { eng.run({ 'Calc!B1': 100 }, { strict: true }); } catch { threwValid = true; }
  assert(!threwValid, 'strict mode does not throw on a valid override');

  cleanup();
}

// ---------------------------------------------------------------------------
// Cross-sheet circular model: cluster convergence telemetry
// ---------------------------------------------------------------------------
console.log('Testing: cross-sheet circular model — cluster convergence telemetry');
{
  // A!B1 = 100 + B!B1*0.1 ; B!B1 = A!B1*0.5  → fixed point A≈105.26, B≈52.63
  const A = { '!ref': 'A1:B1', A1: { t: 's', v: 'A' }, B1: { t: 'n', v: 0, f: '100+SheetB!B1*0.1' } };
  const B = { '!ref': 'A1:B1', A1: { t: 's', v: 'B' }, B1: { t: 'n', v: 0, f: 'SheetA!B1*0.5' } };
  const { eng, cleanup } = await buildEngine({ SheetA: A, SheetB: B });

  const r = eng.run();
  assert(r.meta?.clusters?.length >= 1, `cross-sheet cycle forms a cluster (got ${r.meta?.clusters?.length})`);
  assert(r.meta?.converged === true, 'cluster converged');
  assert(r.meta.iterations > 0 && r.meta.iterations < 200, `iterations in (0,200): ${r.meta.iterations}`);
  assert(r.meta.maxDelta < 1e-6, `final maxDelta below tolerance: ${r.meta.maxDelta}`);
  assert(near(r.values['SheetA!B1'], 105.263), `SheetA!B1 converged ~105.26 (got ${r.values['SheetA!B1']})`);
  assert(near(r.values['SheetB!B1'], 52.631), `SheetB!B1 converged ~52.63 (got ${r.values['SheetB!B1']})`);
  const psi = r.meta.perSheetIterations || {};
  assert('SheetA' in psi && 'SheetB' in psi, 'perSheetIterations covers both cluster sheets');

  cleanup();
}

// ---------------------------------------------------------------------------
// Non-contractive cross-sheet cluster: must NOT false-converge (stale guard)
// ---------------------------------------------------------------------------
console.log('Testing: oscillating cross-sheet cluster reports converged=false');
{
  // A!B1 = 30 - B!B1 ; B!B1 = A!B1 → fixed point 15, but the iteration has
  // eigenvalue -1: it oscillates (30,0,30,0...) and never reaches a fixed point.
  // The sampled convergence loop must catch this via the staleness guard and
  // report converged=false rather than locking a non-converged result.
  const A = { '!ref': 'A1:B1', A1: { t: 's', v: 'A' }, B1: { t: 'n', v: 0, f: '30-SheetB!B1' } };
  const B = { '!ref': 'A1:B1', A1: { t: 's', v: 'B' }, B1: { t: 'n', v: 0, f: 'SheetA!B1' } };
  const { eng, cleanup } = await buildEngine({ SheetA: A, SheetB: B });

  const r = eng.run();
  assert(r.meta?.clusters?.length >= 1, 'oscillating cross-sheet cycle forms a cluster');
  assert(r.meta?.converged === false, 'oscillating cluster is NOT reported converged');
  assert(r.meta.iterations < 200, `staleness guard breaks early, not MAX_ITER (got ${r.meta.iterations})`);

  cleanup();
}

// ---------------------------------------------------------------------------
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

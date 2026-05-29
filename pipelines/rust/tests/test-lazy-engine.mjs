#!/usr/bin/env node
/**
 * Tests for the opt-in `--lazy-engine` chunked orchestrator (#22, Wall A).
 *
 * Builds a small acyclic model two ways — default (eager) and `--lazy-engine` —
 * with the real rust-parser, imports each engine.js, and asserts:
 *
 *   - the lazy engine.js does NOT statically import sheet modules (no
 *     `... from './sheets/...'`), so importing it doesn't pull every module
 *     into memory; it exports run / load / runScoped
 *   - run() before load() throws the no-sheets-loaded guard
 *   - after `await load()`, run(inputs) === the EAGER engine's run(inputs)
 *     (base case and an override that propagates cross-sheet)
 *   - output-cone scoping: load({ sheets: [leaf] }) loads only the leaf's
 *     transitive dependency closure (not unrelated sheets), and run() then
 *     computes exactly that cone
 *   - runScoped(inputs, { cells: [...] }) loads the cone + runs in one await
 *
 * Needs the rust-parser binary. Skips (exit 0) if it isn't built — mirrors the
 * other rust/tests/*.mjs.
 *
 * Usage: node pipelines/rust/tests/test-lazy-engine.mjs
 */

import XLSX from 'xlsx';
import { writeFileSync, existsSync, mkdtempSync, rmSync, readFileSync } from 'fs';
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

function valuesEqual(a, b) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!(k in b)) return false;
    const x = a[k], y = b[k];
    if (x !== y && !(Number.isNaN(x) && Number.isNaN(y))) return false;
  }
  return true;
}

/**
 * Build a workbook from {sheetName: cells}, parse it (optionally with
 * --lazy-engine), and import the resulting chunked engine.js.
 */
async function build(sheets, { lazy }) {
  const wb = { SheetNames: Object.keys(sheets), Sheets: sheets };
  const tmp = mkdtempSync(join(tmpdir(), lazy ? 'lazy-eng-' : 'eager-eng-'));
  const xlsx = join(tmp, 'm.xlsx');
  writeFileSync(xlsx, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  const argv = [xlsx, join(tmp, 'out'), '--chunked'];
  if (lazy) argv.push('--lazy-engine');
  execFileSync(PARSER, argv, { encoding: 'utf-8', stdio: 'pipe' });
  const chunked = join(tmp, 'out', 'chunked');
  const eng = await import(pathToFileURL(join(chunked, 'engine.js')).href);
  return {
    chunked,
    eng,
    src: readFileSync(join(chunked, 'engine.js'), 'utf-8'),
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

// Acyclic model: Delta is independent; Gamma <- Beta <- Alpha (cross-sheet).
//   Alpha!B1 = 10            (input)
//   Beta!B1  = Alpha!B1 * 2  (= 20)
//   Gamma!B1 = Beta!B1 + 5   (= 25)
//   Delta!B1 = 100           (independent input)
// So the dependency cone of Gamma is {Gamma, Beta, Alpha} — Delta is outside it.
function model() {
  const Alpha = { '!ref': 'A1:B1', A1: { t: 's', v: 'Alpha' }, B1: { t: 'n', v: 10 } };
  const Beta  = { '!ref': 'A1:B1', A1: { t: 's', v: 'Beta' },  B1: { t: 'n', v: 20, f: 'Alpha!B1*2' } };
  const Gamma = { '!ref': 'A1:B1', A1: { t: 's', v: 'Gamma' }, B1: { t: 'n', v: 25, f: 'Beta!B1+5' } };
  const Delta = { '!ref': 'A1:B1', A1: { t: 's', v: 'Delta' }, B1: { t: 'n', v: 100 } };
  return { Alpha, Beta, Gamma, Delta };
}

// ---------------------------------------------------------------------------
console.log('Testing: lazy engine shape — no static sheet imports, exports run/load/runScoped');
const eager = await build(model(), { lazy: false });
const lazyAll = await build(model(), { lazy: true });
{
  assert(!lazyAll.src.includes("from './sheets/"),
    'lazy engine.js has NO static `... from ./sheets/...` import');
  assert(lazyAll.src.includes("=> import('./sheets/"),
    'lazy engine.js uses dynamic import() loaders');
  assert(typeof lazyAll.eng.run === 'function', 'exports run()');
  assert(typeof lazyAll.eng.load === 'function', 'exports load()');
  assert(typeof lazyAll.eng.runScoped === 'function', 'exports runScoped()');
  // Sanity: the eager engine DOES statically import (contrast).
  assert(eager.src.includes("from './sheets/"), 'eager engine.js DOES statically import (contrast)');
}

// ---------------------------------------------------------------------------
console.log('Testing: run() before load() throws; after load() it matches the eager engine');
{
  let threw = false;
  try { lazyAll.eng.run(); } catch (e) { threw = /no sheets loaded/i.test(String(e.message)); }
  assert(threw, 'run() before load() throws the no-sheets-loaded guard');

  const loaded = await lazyAll.eng.load();
  assert(loaded.count === 4, `load() (no opts) loads all sheets (got ${loaded.count})`);

  // Base case parity.
  const eBase = eager.eng.run();
  const lBase = lazyAll.eng.run();
  assert(valuesEqual(eBase.values, lBase.values), 'lazy base-case values === eager base-case values');
  assert(lBase.values['Gamma!B1'] === 25 && lBase.values['Delta!B1'] === 100, 'lazy base values correct');

  // Override that propagates cross-sheet: Alpha!B1 100 -> Beta 200 -> Gamma 205.
  const eOv = eager.eng.run({ 'Alpha!B1': 100 });
  const lOv = lazyAll.eng.run({ 'Alpha!B1': 100 });
  assert(valuesEqual(eOv.values, lOv.values), 'lazy override values === eager override values');
  assert(lOv.values['Beta!B1'] === 200 && lOv.values['Gamma!B1'] === 205, 'override propagates through lazy engine');
}

// ---------------------------------------------------------------------------
console.log('Testing: output-cone scoping — load({sheets}) loads only the dependency closure');
{
  const coneBuild = await build(model(), { lazy: true });
  const loaded = await coneBuild.eng.load({ sheets: ['Gamma'] });
  const set = new Set(loaded.loaded);
  assert(loaded.count === 3, `cone of Gamma is 3 sheets (got ${loaded.count})`);
  assert(set.has('Gamma') && set.has('Beta') && set.has('Alpha'), 'cone includes Gamma + its transitive deps Beta, Alpha');
  assert(!set.has('Delta'), 'cone EXCLUDES the unrelated Delta sheet');

  const r = coneBuild.eng.run();
  assert(r.values['Gamma!B1'] === 25, 'cone run computes Gamma!B1 = 25');
  assert(!('Delta!B1' in r.values), 'unloaded Delta is not computed (absent from values)');
  coneBuild.cleanup();
}

// ---------------------------------------------------------------------------
console.log('Testing: runScoped() loads the cone of the requested cells and runs in one call');
{
  const scopedBuild = await build(model(), { lazy: true });
  const r = await scopedBuild.eng.runScoped({}, { cells: ['Gamma!B1'] });
  assert(r.values['Gamma!B1'] === 25, 'runScoped({cells:[Gamma!B1]}) computes Gamma!B1 = 25');
  assert(!('Delta!B1' in r.values), 'runScoped scoped to the cell cone (Delta absent)');
  scopedBuild.cleanup();
}

eager.cleanup();
lazyAll.cleanup();

// ---------------------------------------------------------------------------
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

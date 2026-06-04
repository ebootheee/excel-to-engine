/**
 * Tests for lib/cone-emit.mjs + lib/cell-exprs.mjs (engine-speed L1/L2; ADR-026).
 *
 * Builds a small synthetic model with the REAL pathology (a cross-sheet cycle on a
 * cluster sheet that ALSO carries a big acyclic schedule), then proves:
 *   - the SCOPED cone (L2) reproduces the full-run outputs for base case + what-ifs
 *     within 1e-6, while folding the whole schedule to ONE boundary constant;
 *   - the FULL executor (L1) reproduces ALL cells (incl. deep acyclic) while
 *     iterating only the true cycle cells;
 *   - the C3 run() contract shape is preserved (values/kpis/meta/unknownOverrides,
 *     honest meta.converged, strict-mode throw);
 *   - cell-exprs extraction round-trips the emitted per-cell expressions.
 *
 * Skips cleanly if the rust-parser isn't built.
 *
 * Usage: node tests/lib/test-cone-emit.mjs
 * @license MIT
 */

import XLSX from 'xlsx';
import { writeFileSync, existsSync, mkdtempSync, rmSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { performance } from 'perf_hooks';

import { buildCone, buildFullExecutor, buildConesFromManifest } from '../../lib/cone-emit.mjs';
import { extractCellExprs } from '../../lib/cell-exprs.mjs';
import { close } from '../../lib/verify-engine.mjs';

const setEq = (a, b) => { const A = new Set(a), B = new Set(b); if (A.size !== B.size) return false; for (const x of A) if (!B.has(x)) return false; return true; };

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..');
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
function assert(cond, msg) { if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); } }

const num = (v, f) => (f ? { t: 'n', v, f } : { t: 'n', v });
const str = (v) => ({ t: 's', v });

// Same shape as benchmarks/fixtures/_build.mjs, small scale. Big acyclic schedule
// (Assets!C) on the cluster sheet; 3-cell cross-sheet cycle Assets!B1↔B2↔CF!B2.
const SCALE = 40;
function workbook() {
  const termC = `C${SCALE}`;
  const Assets = { '!ref': `A1:C${SCALE}` };
  for (let r = 1; r <= SCALE; r++) {
    Assets[`A${r}`] = num(1 + ((r * 7) % 13) * 0.5);
    Assets[`C${r}`] = r === 1 ? num(0, 'A1') : num(0, `C${r - 1}+A${r}`);
  }
  Assets.B1 = num(0, 'Assets!B2*0.05');
  Assets.B2 = num(0, `CF!B2+Assets!${termC}`);
  const CF = { '!ref': 'A1:B2', A1: str('cash'), B2: num(0, 'Assets!B1*0.30+100000') };
  const Out = {
    '!ref': 'A1:B2',
    A1: str('MIP'), B1: num(0, 'CF!B2*2+Assets!B1'),
    A2: str('Total'), B2: num(0, `Out!B1+Assets!${termC}`),
  };
  return { SheetNames: ['Assets', 'CF', 'Out'], Sheets: { Assets, CF, Out } };
}

function build() {
  const tmp = mkdtempSync(join(tmpdir(), 'cone-emit-'));
  const xlsx = join(tmp, 'm.xlsx');
  writeFileSync(xlsx, XLSX.write(workbook(), { type: 'buffer', bookType: 'xlsx' }));
  execFileSync(PARSER, [xlsx, join(tmp, 'out'), '--chunked', '--emit-debug'], { encoding: 'utf-8', stdio: 'pipe' });
  return { chunked: join(tmp, 'out', 'chunked'), cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

async function loadRun(p) {
  const m = await import(pathToFileURL(p).href + `?t=${performance.now()}`);
  return m.run || m.default?.run;
}

const built = build();
const chunked = built.chunked;
const baselineRun = await loadRun(join(chunked, 'engine.js'));
const baseVals = baselineRun({}).values;

const NAMED = ['Out!B1', 'Out!B2', 'Assets!B1', 'CF!B2', 'Assets!B2'];
const LEVER = `Assets!A${SCALE}`;
const SCOPE_OUT = ['Out!B1', 'Out!B2'];

// ── cell-exprs round-trip ─────────────────────────────────────────────────────
console.log('Testing: extractCellExprs lifts per-cell expressions from sheet modules');
{
  const exprs = await extractCellExprs(chunked);
  assert(exprs.has('Assets!B1') && exprs.get('Assets!B1').includes('ctx.get'), 'Assets!B1 expr extracted (reads via ctx.get)');
  assert(exprs.has('Assets!C2') && exprs.get('Assets!C2').includes('ctx.get'), 'deep schedule cell Assets!C2 expr extracted');
  assert(exprs.has(`Assets!${`C${SCALE}`}`), 'schedule terminal expr extracted');
  assert(exprs.size >= SCALE, `extracted at least ${SCALE} cell exprs (got ${exprs.size})`);
}

// ── L2 scoped cone ────────────────────────────────────────────────────────────
console.log('Testing: scoped cone reproduces full-run outputs (base + what-ifs) within 1e-6');
const cone = await buildCone(chunked, { inputs: [LEVER], outputs: SCOPE_OUT, baseValues: baseVals, write: true });
{
  assert(cone.missingBoundary.length === 0, `no boundary cell lacks a base value (got ${cone.missingBoundary.length})`);
  // The entire schedule folds: active set is tiny, boundary is ~1 cell.
  assert(cone.plan.stats.activeCells <= 8, `scoped active set is tiny (${cone.plan.stats.activeCells} cells)`);
  assert(cone.plan.stats.boundaryCells <= 3, `scoped boundary folds the schedule (${cone.plan.stats.boundaryCells} constant(s))`);
  assert(cone.plan.stats.cycleCells === 3, `scoped active cycle is the 3-cell cross-sheet loop (${cone.plan.stats.cycleCells})`);

  const coneRun = await loadRun(cone.path);
  // base case
  const cb = coneRun({}), bb = baselineRun({});
  for (const c of SCOPE_OUT) assert(close(cb.values[c], bb.values[c]), `base case ${c}: cone==full (${cb.values[c]} vs ${bb.values[c]})`);
  // what-ifs
  for (const v of [0, 7, 50, -3]) {
    const cw = coneRun({ [LEVER]: v }), bw = baselineRun({ [LEVER]: v });
    for (const c of SCOPE_OUT) assert(close(cw.values[c], bw.values[c]), `what-if ${LEVER}=${v} ${c}: cone==full`);
  }
}

console.log('Testing: scoped cone preserves the C3 run() contract');
{
  const coneRun = await loadRun(cone.path);
  const r = coneRun({});
  for (const f of ['values', 'kpis', 'meta', 'unknownOverrides']) assert(f in r, `return has field "${f}"`);
  assert(r.values === r.kpis, 'kpis aliases values (single snapshot)');
  for (const f of ['converged', 'iterations', 'maxDelta', 'convergenceTolerance', 'clusters', 'perSheetIterations', 'elapsedMs']) assert(f in r.meta, `meta has field "${f}"`);
  assert(r.meta.converged === true, 'base case converged honestly');
  // unknown-override reporting + strict throw
  const r2 = coneRun({ 'Nope!Z9': 1 });
  assert(r2.unknownOverrides.includes('Nope!Z9'), 'unknown override reported');
  let threw = false;
  try { coneRun({ 'Nope!Z9': 1 }, { strict: true }); } catch { threw = true; }
  assert(threw, 'strict mode throws on an override no active cell reads');
  // a real lever is NOT unknown
  assert(coneRun({ [LEVER]: 1 }).unknownOverrides.length === 0, 'a real lever override is recognized (read by an active cell)');
}

// ── L1 full executor ──────────────────────────────────────────────────────────
console.log('Testing: full executor reproduces ALL cells while iterating only the cycle');
{
  const full = await buildFullExecutor(chunked, { baseValues: baseVals, write: true });
  assert(full.plan.stats.activeCells === full.plan.stats.totalFormulaCells, 'full executor recomputes every formula cell');
  assert(full.plan.stats.cycleCells === 3, `full executor true cycle is 3 cells (${full.plan.stats.cycleCells})`);

  const fullRun = await loadRun(full.path);
  const fr = fullRun({}), br = baselineRun({});
  for (const c of NAMED) assert(close(fr.values[c], br.values[c]), `full base case ${c}: full==baseline`);
  // deep acyclic schedule cells reproduce exactly
  for (const c of ['Assets!C2', 'Assets!C20', `Assets!C${SCALE}`]) assert(close(fr.values[c], br.values[c]), `full deep acyclic ${c}: full==baseline`);
  // cells-iterated/pass is the cycle, not the whole cluster sheet
  assert(fr.meta.cellsIteratedPerPass === 3, `full executor iterates 3 cells/pass (${fr.meta.cellsIteratedPerPass}), not the ~${SCALE} schedule cells`);
  // what-if through the full executor too
  const fw = fullRun({ [LEVER]: 9 }), bw = baselineRun({ [LEVER]: 9 });
  for (const c of NAMED) assert(close(fw.values[c], bw.values[c]), `full what-if ${LEVER}=9 ${c}: full==baseline`);
}

// ── init integration: buildConesFromManifest ─────────────────────────────────
console.log('Testing: buildConesFromManifest derives + emits the MIP-grid cone from named maps');
{
  // Author named maps with explicit lever→output coupling (independent of the
  // manifest output-detection heuristics) — the shape emitManifestMaps produces.
  writeFileSync(join(chunked, 'named-inputs.json'), JSON.stringify({ namedInputs: {
    Lever: { cell: LEVER, label: 'lever', affectsOutputs: ['MIP', 'Total'] },
  } }, null, 2));
  writeFileSync(join(chunked, 'named-outputs.json'), JSON.stringify({ namedOutputs: {
    MIP: { cell: 'Out!B1', label: 'MIP', dependsOnNamedInputs: ['Lever'] },
    Total: { cell: 'Out!B2', label: 'Total', dependsOnNamedInputs: ['Lever'] },
  } }, null, 2));
  // Inject the engine base run as base values (the synthetic fixture's GT cache is
  // a 0-placeholder; real models' _ground-truth.json IS the gated base case).
  const res = buildConesFromManifest(chunked, { write: true, baseValues: baseVals });
  assert(!res.skipped, `cone emitted from named maps (skipped=${res.skipped || 'no'})`);
  assert(res.scopes.length === 1, 'one combined MIP-grid scope');
  assert(res.indexPath && existsSync(res.indexPath), 'cones/_index.json written');
  const s = res.scopes[0];
  assert(setEq(s.inputs, [LEVER]) && setEq(s.outputs, ['Out!B1', 'Out!B2']), 'scope = lever → MIP/Total cells');
  const coneRun = await loadRun(s.path);
  const cb = coneRun({}), bb = baselineRun({});
  for (const c of ['Out!B1', 'Out!B2']) assert(close(cb.values[c], bb.values[c]), `manifest cone base ${c}: cone==engine`);
  // and a what-if
  const cw = coneRun({ [LEVER]: 11 }), bw = baselineRun({ [LEVER]: 11 });
  for (const c of ['Out!B1', 'Out!B2']) assert(close(cw.values[c], bw.values[c]), `manifest cone what-if ${c}: cone==engine`);
}

console.log('Testing: buildConesFromManifest skips cleanly when there is no coupling');
{
  writeFileSync(join(chunked, 'named-inputs.json'), JSON.stringify({ namedInputs: {} }, null, 2));
  writeFileSync(join(chunked, 'named-outputs.json'), JSON.stringify({ namedOutputs: {} }, null, 2));
  const res = buildConesFromManifest(chunked, { write: true });
  assert(res.skipped && res.scopes.length === 0, `no-coupling → skipped (${res.skipped})`);
}

built.cleanup();
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

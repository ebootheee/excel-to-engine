/**
 * excel-to-engine — cone-module / full-executor emitter (engine-speed L1/L2; ADR-026).
 *
 * Given a `ScopePlan` (from `lib/scope-plan.mjs`) and the per-cell transpiled
 * expressions (from `lib/cell-exprs.mjs`), render a SINGLE standalone `.mjs` that
 * recomputes ONLY the active subgraph and constant-folds everything else — exposing
 * the same `run(inputs, options)` contract (C3) as the default `engine.js`.
 *
 *   - L2 (scoped cone, `buildCone`): scope = (MIP levers → MIP/returns). The active
 *     set is the returns/waterfall core (a few k cells); the entire upstream model
 *     folds to BOUNDARY constants. Module is a few MB — NO 190 MB sheet module is
 *     imported. This is the targeted what-if path (the Mippy MIP grid).
 *   - L1 (full executor, `buildFullExecutor`): active = every formula cell. Computes
 *     each acyclic cell ONCE in topo order, then iterates ONLY the true cycle cells
 *     (≤2,992 on the real model) — vs the default engine re-running 17 whole cluster
 *     sheets per pass. Proves the cells-iterated/pass ÷N thesis on the midi fixture;
 *     on the real model the module is sheet-module-sized (the default-engine fix is
 *     the Rust emitter — Wave 3), so the full executor is the midi-scale proof +
 *     reference implementation, not the real-model default.
 *
 * Correctness (ADR-026 §Why it's correct): every active cell reads only active
 * cells (recomputed), the levers (pinned to the override), or boundary cells
 * (pinned to base) — exactly what it would read in a full run — so the requested
 * outputs reproduce the full-run values. Cycles inside the active set iterate to
 * convergence with the SAME tolerance + sampled-delta + NaN-guard contract as the
 * default engine (mirrored from chunked_emitter.rs emit_run_function).
 *
 * @license MIT
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import buildScopePlan, { buildFullPlan } from './scope-plan.mjs';
import { extractCellExprs, extractCellExprsSync } from './cell-exprs.mjs';
import { loadDependencyEdges } from './manifest-maps.mjs';

const TOL = 1e-6;
const MAX_ITER = 200;

// ── runtime block (kept byte-identical in spirit to engine.js's ComputeContext) ──
// The emitted cone is self-contained: it inlines the same ComputeContext the
// orchestrator uses (get/set with override pinning, range/range2d for SUMIFS-style
// helpers) so a lifted expression evaluates exactly as it does in its sheet module.
// If engine.js's ComputeContext changes, mirror it here.
const RUNTIME = `class ComputeContext {
  constructor() { this.values = {}; this._locked = null; }
  get(addr) { const v = this.values[addr]; return v !== undefined ? v : 0; }
  set(addr, value) { if (this._locked !== null && this._locked.has(addr)) return; this.values[addr] = value; }
  _parseRange(rangeStr) {
    const match = rangeStr.match(/^(.+)!([A-Z]+)(\\d+):([A-Z]+)(\\d+)$/);
    if (!match) return null;
    const [, sheet, col1, row1, col2, row2] = match;
    return { sheet, c1: colToNum(col1), r1: parseInt(row1), c2: colToNum(col2), r2: parseInt(row2) };
  }
  range(rangeStr) {
    const p = this._parseRange(rangeStr); if (!p) return [];
    const result = [];
    for (let r = p.r1; r <= p.r2; r++) for (let c = p.c1; c <= p.c2; c++) result.push(this.get(\`\${p.sheet}!\${numToCol(c)}\${r}\`));
    return result;
  }
  range2d(rangeStr) {
    const p = this._parseRange(rangeStr); if (!p) return [];
    const result = [];
    for (let r = p.r1; r <= p.r2; r++) { const row = []; for (let c = p.c1; c <= p.c2; c++) row.push(this.get(\`\${p.sheet}!\${numToCol(c)}\${r}\`)); result.push(row); }
    return result;
  }
  kpis() { return { ...this.values }; }
}
function colToNum(col) { let n = 0; for (const ch of col) n = n * 26 + ch.charCodeAt(0) - 64; return n; }
function numToCol(n) { let s = ''; while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); } return s; }`;

/** Lift the `import { ... } from './_helpers.mjs'` line from any sheet module and
 *  rewrite its path for a module living in chunked/cones/. Keeps the helper set in
 *  sync with the emitter automatically (no hand-maintained list to drift). */
function helperImportLine(chunkedDir) {
  const sheetsDir = join(chunkedDir, 'sheets');
  for (const f of readdirSync(sheetsDir)) {
    if (!f.endsWith('.mjs') || f.startsWith('_')) continue;
    for (const line of readFileSync(join(sheetsDir, f), 'utf-8').split('\n', 40)) {
      if (line.startsWith('import') && line.includes('_helpers.mjs')) {
        return line.replace('./_helpers.mjs', '../sheets/_helpers.mjs');
      }
    }
  }
  // No helper import found (a model with no helper-using formulas) — import nothing.
  return '';
}

/** JS source for one cycle unit's convergence loop. Mirrors the intra-sheet
 *  convergence pattern + the lock-grade NaN-guard (non-finite ⇒ never "converged").
 *  Pushes a cell-level cluster meta entry. */
function emitCycleLoop(addrs, cellExprs, idx) {
  const L = [];
  const exprList = addrs.map(a => {
    const e = cellExprs.get(a);
    if (e === undefined) throw new Error(`cone-emit: active cycle cell ${a} has no transpiled expression`);
    return { a, e };
  });
  const sheets = [...new Set(addrs.map(a => a.slice(0, a.indexOf('!'))))];
  const getArr = addrs.map(a => `ctx.get(${JSON.stringify(a)})`).join(', ');
  L.push(`  { // ── active cycle ${idx} (${addrs.length} cell${addrs.length === 1 ? '' : 's'}) ──`);
  L.push(`    const _addrs = ${JSON.stringify(addrs)};`);
  L.push(`    let _conv = false, _iters = 0, _maxDelta = Infinity, _nonFinite = null, _streak = 0, _prevDelta = Infinity, _stale = 0;`);
  L.push(`    for (let _ci = 0; _ci < ${MAX_ITER}; _ci++) {`);
  L.push(`      _iters = _ci + 1;`);
  L.push(`      const _prev = [${getArr}];`);
  for (const { a, e } of exprList) L.push(`      ctx.set(${JSON.stringify(a)}, ${e});`);
  L.push(`      const _curr = [${getArr}];`);
  L.push(`      let _d = 0, _bad = null;`);
  L.push(`      for (let i = 0; i < _curr.length; i++) { const c = _curr[i]; if (typeof c === 'number' && !Number.isFinite(c)) { _bad = _addrs[i]; break; } const b = _prev[i]; if (typeof b !== 'number' || typeof c !== 'number') { _d = Infinity; continue; } _d = Math.max(_d, Math.abs(c - b)); }`);
  L.push(`      if (_bad !== null) { _nonFinite = _bad; _streak++; _prevDelta = Infinity; if (_streak >= 3) break; continue; }`);
  L.push(`      _streak = 0; _maxDelta = _d;`);
  L.push(`      if (_d < ${TOL}) { _conv = true; break; }`);
  L.push(`      _stale = (Math.abs(_d - _prevDelta) < ${TOL} * 0.01) ? _stale + 1 : 0;`);
  L.push(`      if (_stale >= 5) break;`);
  L.push(`      _prevDelta = _d;`);
  L.push(`    }`);
  L.push(`    _cycleMeta.push({ sheets: ${JSON.stringify(sheets)}, cells: ${addrs.length}, iterations: _iters, converged: _conv, maxDelta: _maxDelta, nonFiniteCell: _nonFinite });`);
  L.push(`  }`);
  return L.join('\n');
}

/**
 * Render the cone/executor module source for a plan.
 *
 * @param {object} args
 * @param {ScopePlan} args.plan  - from buildScopePlan / buildFullPlan (needs activeOrder)
 * @param {Map<string,string>} args.cellExprs - cell → transpiled expr
 * @param {string} args.chunkedDir - for the helper import line
 * @param {string} [args.label] - human label for the header comment
 * @returns {{ source: string, missingBoundary: string[] }}
 */
export function generateConeSource({ plan, cellExprs, chunkedDir, label = '' }) {
  if (!plan || !Array.isArray(plan.activeOrder)) throw new Error('generateConeSource: plan.activeOrder required (rebuild plan with current scope-plan.mjs)');
  const boundaryBase = plan.boundaryBase || {};
  const missingBoundary = plan.boundary.filter(c => !(c in boundaryBase));
  const cellsIteratedPerPass = plan.stats.cycleCells;

  const out = [];
  out.push(`// chunked/cones/${plan.scopeId}.mjs — AUTO-GENERATED ${plan.full ? 'full executor (L1)' : 'cone module (L2)'} (ADR-026)`);
  out.push(`// Scope: ${label || (plan.full ? 'whole model' : `${plan.inputs.length} input(s) -> ${plan.outputs.length} output(s)`)}`);
  out.push(`// Recomputes ${plan.stats.activeCells} active cell(s) (${plan.stats.cycleCells} in cycles); folds ${plan.stats.boundaryCells} boundary constant(s).`);
  out.push(`// Do not edit — regenerate via lib/cone-emit.mjs. Valid only for modelHash ${plan.modelHash}.`);
  const imp = helperImportLine(chunkedDir);
  if (imp) out.push(imp);
  out.push('');
  out.push(RUNTIME);
  out.push('');
  out.push(`export const SCOPE_ID = ${JSON.stringify(plan.scopeId)};`);
  out.push(`export const MODEL_HASH = ${JSON.stringify(plan.modelHash)};`);
  out.push(`export const SCOPE_INPUTS = ${JSON.stringify(plan.inputs)};`);
  out.push(`export const SCOPE_OUTPUTS = ${JSON.stringify(plan.outputs)};`);
  out.push('');
  out.push(`// Boundary constants — cells an active cell reads that are constant under the scope.`);
  out.push(`const BOUNDARY = ${JSON.stringify(boundaryBase)};`);
  out.push(`// Lever BASE values — the base case when a lever is not overridden (an active`);
  out.push(`// cell reading an un-overridden lever must see its base value, not 0).`);
  out.push(`const INPUT_BASE = ${JSON.stringify(plan.inputBase || {})};`);
  out.push('');
  out.push(`export function run(inputs = {}, options = {}) {`);
  out.push(`  const ctx = new ComputeContext();`);
  out.push(`  const _t0 = Date.now();`);
  out.push(`  const _cycleMeta = [];`);
  out.push(`  // Track which override cells are actually read (mirrors engine.js).`);
  out.push(`  const _overrideKeys = Object.keys(inputs);`);
  out.push(`  const _readOverrides = new Set();`);
  out.push(`  if (_overrideKeys.length > 0) {`);
  out.push(`    const _oset = new Set(_overrideKeys);`);
  out.push(`    const _origGet = ctx.get.bind(ctx);`);
  out.push(`    ctx.get = (addr) => { if (_oset.has(addr)) _readOverrides.add(addr); return _origGet(addr); };`);
  out.push(`  }`);
  out.push(`  // Boundary + lever base constants, then the lever overrides (pinned so nothing clobbers them).`);
  out.push(`  Object.assign(ctx.values, BOUNDARY, INPUT_BASE);`);
  out.push(`  for (const [addr, val] of Object.entries(inputs)) ctx.values[addr] = val;`);
  out.push(`  if (_overrideKeys.length > 0) ctx._locked = new Set(_overrideKeys);`);
  out.push('');
  out.push(`  // ── Active subgraph in reads-first order (acyclic cells set once; cycles iterate) ──`);
  let cycleIdx = 0;
  for (const unit of plan.activeOrder) {
    if (Array.isArray(unit)) {
      out.push(emitCycleLoop(unit, cellExprs, cycleIdx++));
    } else {
      const e = cellExprs.get(unit);
      if (e === undefined) throw new Error(`cone-emit: active cell ${unit} has no transpiled expression`);
      out.push(`  ctx.set(${JSON.stringify(unit)}, ${e});`);
    }
  }
  out.push('');
  out.push(`  const _converged = _cycleMeta.every(c => c.converged);`);
  out.push(`  const _maxDelta = _cycleMeta.reduce((m, c) => Math.max(m, c.maxDelta), 0);`);
  out.push(`  const _iterations = _cycleMeta.reduce((m, c) => Math.max(m, c.iterations), 0);`);
  out.push(`  const _perSheetIterations = {};`);
  out.push(`  for (const c of _cycleMeta) for (const s of (c.sheets || [])) _perSheetIterations[s] = Math.max(_perSheetIterations[s] || 0, c.iterations);`);
  out.push(`  const meta = {`);
  out.push(`    converged: _cycleMeta.length === 0 ? true : _converged,`);
  out.push(`    iterations: _iterations,`);
  out.push(`    maxDelta: _maxDelta,`);
  out.push(`    convergenceTolerance: ${TOL},`);
  out.push(`    clusters: _cycleMeta,`);
  out.push(`    perSheetIterations: _perSheetIterations,`);
  out.push(`    elapsedMs: Date.now() - _t0,`);
  out.push(`    cellsIteratedPerPass: ${cellsIteratedPerPass},`);
  out.push(`    activeCells: ${plan.stats.activeCells},`);
  out.push(`    scoped: ${plan.full ? 'false' : 'true'},`);
  out.push(`  };`);
  out.push(`  const unknownOverrides = _overrideKeys.filter(k => !_readOverrides.has(k));`);
  out.push(`  if (options.strict && unknownOverrides.length > 0) throw new Error('cone.run(): unknown override cell(s) not read by any active cell: ' + unknownOverrides.join(', '));`);
  out.push(`  const _snapshot = { ...ctx.values };`);
  out.push(`  return { values: _snapshot, kpis: _snapshot, meta, unknownOverrides };`);
  out.push(`}`);
  out.push('');
  out.push(`export default { run };`);
  out.push('');
  return { source: out.join('\n'), missingBoundary };
}

/** Resolve the base-case value map: caller-provided, else the GT sidecar
 *  (_ground-truth.json), which IS the base-case values. Used both for boundary
 *  membership (range-leaf rescue — the gtKeys landmine) AND boundary base folding. */
function resolveBaseValues(chunkedDir, baseValues) {
  if (baseValues) return baseValues;
  const gtPath = join(chunkedDir, '_ground-truth.json');
  if (existsSync(gtPath)) {
    const gt = JSON.parse(readFileSync(gtPath, 'utf-8'));
    // _ground-truth.json may be { "Sheet!A1": {value|v} } or a flat { cell: value }.
    const flat = {};
    for (const [k, v] of Object.entries(gt)) flat[k] = (v && typeof v === 'object') ? (v.value ?? v.v ?? v) : v;
    return flat;
  }
  return undefined;
}

/** Render the cone source for a plan + cellExprs and (optionally) write it. Shared
 *  by the async + sync builders. */
function assembleCone({ chunkedDir, plan, cellExprs, label, write, fileName }) {
  const { source, missingBoundary } = generateConeSource({ plan, cellExprs, chunkedDir, label });
  let path = null;
  if (write) {
    const conesDir = join(chunkedDir, 'cones');
    mkdirSync(conesDir, { recursive: true });
    path = join(conesDir, fileName || `${plan.scopeId}.mjs`);
    writeFileSync(path, source);
  }
  return { scopeId: plan.scopeId, path, source, plan, missingBoundary };
}

/**
 * Build a SCOPED cone module (L2) for a (inputs → outputs) what-if and (optionally)
 * write it to chunked/cones/<scopeId>.mjs.
 *
 * CRITICAL (the L0 review landmine): we pass the base-value map as `gtKeys` so
 * range-member RAW-LEAF boundary cells are NOT dropped (ADR-026 invariant #6) and
 * so boundaryBase is populated for folding.
 *
 * @returns {Promise<{ scopeId, path|null, source, plan, missingBoundary }>}
 */
export async function buildCone(chunkedDir, { inputs = [], outputs = [], baseValues, modelHash, label, write = false } = {}) {
  const edges = loadDependencyEdges(join(chunkedDir, 'dependency-graph.json'));
  const plan = buildScopePlan({ edges, inputs, outputs, gtKeys: resolveBaseValues(chunkedDir, baseValues), modelHash });
  const cellExprs = await extractCellExprs(chunkedDir);
  return assembleCone({ chunkedDir, plan, cellExprs, label, write });
}

/** Synchronous {@link buildCone}, for sync callers (the init pipeline). */
export function buildConeSync(chunkedDir, { inputs = [], outputs = [], baseValues, modelHash, label, write = false } = {}) {
  const edges = loadDependencyEdges(join(chunkedDir, 'dependency-graph.json'));
  const plan = buildScopePlan({ edges, inputs, outputs, gtKeys: resolveBaseValues(chunkedDir, baseValues), modelHash });
  const cellExprs = extractCellExprsSync(chunkedDir);
  return assembleCone({ chunkedDir, plan, cellExprs, label, write });
}

/**
 * Build the WHOLE-MODEL full executor (L1) — cell-level cycle resolution over every
 * formula cell. Used by the efficacy `cycle` variant to prove cells-iterated/pass ÷N.
 *
 * @returns {Promise<{ scopeId, path|null, source, plan, missingBoundary }>}
 */
export async function buildFullExecutor(chunkedDir, { baseValues, modelHash, write = false } = {}) {
  const edges = loadDependencyEdges(join(chunkedDir, 'dependency-graph.json'));
  const plan = buildFullPlan({ edges, gtKeys: resolveBaseValues(chunkedDir, baseValues), modelHash });
  const cellExprs = await extractCellExprs(chunkedDir);
  return assembleCone({ chunkedDir, plan, cellExprs, label: 'whole model (full executor)', write, fileName: `full-${plan.scopeId}.mjs` });
}

/**
 * Build the registered cone(s) for a model from its named maps and write them +
 * a cones/_index.json. The MIP-grid scope is seeded per ADR-026 from
 * `named-inputs.affectsOutputs` ∩ `named-outputs.dependsOnNamedInputs`: the levers
 * (named inputs that drive ≥1 named output) → the outputs they drive. This is the
 * targeted what-if surface (the Mippy `{exit, value, hurdle} → MIP/returns` grid).
 *
 * Best-effort and self-describing: returns `{ scopes: [], skipped: '<reason>' }`
 * when the graph or named maps are absent (so an init caller can no-op safely).
 *
 * Synchronous (the init pipeline is sync). Loads the dependency graph + sheet
 * modules whole — fine under the init heap; runs BEFORE graph slimming.
 *
 * @param {string} chunkedDir
 * @param {object} [opts]
 * @param {boolean} [opts.write=true]
 * @param {string} [opts.modelHash]
 * @param {Object<string,*>} [opts.baseValues] - base-case value map for boundary
 *        folding; defaults to `_ground-truth.json` (the gated base case for real
 *        models). Inject a base engine run when GT cached values can't be trusted.
 * @returns {{ scopes: Array, indexPath: string|null, skipped?: string }}
 */
export function buildConesFromManifest(chunkedDir, { write = true, modelHash, baseValues } = {}) {
  const graphPath = join(chunkedDir, 'dependency-graph.json');
  if (!existsSync(graphPath)) return { scopes: [], indexPath: null, skipped: 'no dependency-graph.json (run with --emit-debug / before slimming)' };
  const niPath = join(chunkedDir, 'named-inputs.json');
  const noPath = join(chunkedDir, 'named-outputs.json');
  if (!existsSync(niPath) || !existsSync(noPath)) return { scopes: [], indexPath: null, skipped: 'named-inputs.json / named-outputs.json not found' };

  const ni = JSON.parse(readFileSync(niPath, 'utf-8'));
  const no = JSON.parse(readFileSync(noPath, 'utf-8'));
  const inputsMap = ni.namedInputs || ni;
  const outputsMap = no.namedOutputs || no;

  const inputCells = [...new Set(Object.values(inputsMap)
    .filter(v => v && v.cell && Array.isArray(v.affectsOutputs) && v.affectsOutputs.length > 0)
    .map(v => v.cell))];
  const outputCells = [...new Set(Object.values(outputsMap)
    .filter(v => v && v.cell && Array.isArray(v.dependsOnNamedInputs) && v.dependsOnNamedInputs.length > 0)
    .map(v => v.cell))];

  if (inputCells.length === 0 || outputCells.length === 0) {
    return { scopes: [], indexPath: null, skipped: `no lever→output coupling in named maps (inputs=${inputCells.length}, outputs=${outputCells.length})` };
  }

  // One combined cone for the whole lever→output surface (the grid). Reuse
  // buildConeSync which loads edges + base values (GT) and writes chunked/cones/<id>.mjs.
  const cone = buildConeSync(chunkedDir, {
    inputs: inputCells, outputs: outputCells, modelHash, baseValues,
    label: `MIP grid: ${inputCells.length} lever(s) -> ${outputCells.length} output(s)`,
    write,
  });
  const scopes = [{
    scopeId: cone.scopeId, path: cone.path,
    inputs: inputCells, outputs: outputCells,
    stats: cone.plan.stats, missingBoundary: cone.missingBoundary.length,
  }];

  let indexPath = null;
  if (write) {
    const conesDir = join(chunkedDir, 'cones');
    mkdirSync(conesDir, { recursive: true });
    indexPath = join(conesDir, '_index.json');
    writeFileSync(indexPath, JSON.stringify({
      modelHash: cone.plan.modelHash,
      generated: 'lib/cone-emit.mjs buildConesFromManifest',
      scopes: scopes.map(s => ({ scopeId: s.scopeId, module: `cones/${s.scopeId}.mjs`, inputs: s.inputs, outputs: s.outputs, stats: s.stats })),
    }, null, 2) + '\n');
  }
  return { scopes, indexPath };
}

export default buildCone;

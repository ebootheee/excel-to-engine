#!/usr/bin/env node
/**
 * Tests for lib/scope-plan.mjs (engine-speed Lane 0; C1 ScopePlan, ADR-026).
 *
 * Builds a small model with the REAL rust-parser (the `build()` pattern from
 * pipelines/rust/tests/test-lazy-engine.mjs — no cargo), reads its
 * `dependency-graph.json` + `_ground-truth.json`, runs `buildScopePlan`, and
 * asserts against a HAND-DERIVED expectation.
 *
 * The model has BOTH a cross-sheet cycle and an acyclic tail:
 *   Assum!B1 = 200                          (lever / input)
 *   Debt!B1  = Debt!B2 * Debt!B3            (interest)   ─┐ cross-sheet
 *   Debt!B2  = CF!B1 + 100                  (balance)     │ 3-cell cycle
 *   CF!B1    = Assum!B1 - Debt!B1           (cash)       ─┘ {Debt!B1,Debt!B2,CF!B1}
 *   Debt!B3  = 0.1                          (rate — constant, NOT downstream of lever)
 *   Sched!B1 = Assum!B1 * 2                 (acyclic, reads lever)
 *   Sched!B2 = Debt!B1 + Sched!B1           (OUTPUT — downstream of cycle + tail)
 *
 * Forward edges (cell → cells it READS), as the parser emits them:
 *   Debt!B1 → Debt!B2, Debt!B3
 *   Debt!B2 → CF!B1
 *   CF!B1   → Assum!B1, Debt!B1
 *   Sched!B1→ Assum!B1
 *   Sched!B2→ Debt!B1, Sched!B1
 *
 * Scope: inputs=[Assum!B1], outputs=[Sched!B2]. Hand-derived plan:
 *   backwardCone(out) = all 7 cells (output depends on everything upstream).
 *   forwardCone(lever)= {Assum!B1,CF!B1,Sched!B1,Debt!B2,Sched!B2,Debt!B1}
 *                       — Debt!B3 (rate) is NOT downstream of the lever.
 *   active (formula ∩ both cones, minus lever)
 *                     = {CF!B1, Debt!B1, Debt!B2, Sched!B1, Sched!B2}  (5)
 *   activeCycles      = [{CF!B1, Debt!B1, Debt!B2}]                    (3)
 *   activeAcyclic     = {Sched!B1, Sched!B2}, Sched!B1 BEFORE Sched!B2 (2)
 *   boundary          = {Debt!B3}  (read by active Debt!B1, ∉ fwdCone) (1), base 0.1
 *
 * Usage: node tests/lib/test-scope-plan.mjs   (skips if rust-parser isn't built)
 */

import XLSX from 'xlsx';
import { writeFileSync, existsSync, mkdtempSync, rmSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

import { buildScopePlan } from '../../lib/scope-plan.mjs';
import { loadDependencyEdges } from '../../lib/manifest-maps.mjs';

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

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); }
}
const setEq = (a, b) => { const A = new Set(a), B = new Set(b); if (A.size !== B.size) return false; for (const x of A) if (!B.has(x)) return false; return true; };

/** Build the workbook with the real parser; return the chunked dir + cleanup. */
function build(sheets) {
  const wb = { SheetNames: Object.keys(sheets), Sheets: sheets };
  const tmp = mkdtempSync(join(tmpdir(), 'scope-plan-'));
  const xlsx = join(tmp, 'm.xlsx');
  writeFileSync(xlsx, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  execFileSync(PARSER, [xlsx, join(tmp, 'out'), '--chunked'], { encoding: 'utf-8', stdio: 'pipe' });
  return { chunked: join(tmp, 'out', 'chunked'), cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

function model() {
  const Assum = { '!ref': 'A1:B1', A1: { t: 's', v: 'opcash' }, B1: { t: 'n', v: 200 } };
  const Debt = {
    '!ref': 'A1:B3',
    A1: { t: 's', v: 'interest' }, B1: { t: 'n', v: 1, f: 'Debt!B2*Debt!B3' },
    A2: { t: 's', v: 'balance' },  B2: { t: 'n', v: 1, f: 'CF!B1+100' },
    A3: { t: 's', v: 'rate' },     B3: { t: 'n', v: 0.1 },
  };
  const CF = { '!ref': 'A1:B1', A1: { t: 's', v: 'cash' }, B1: { t: 'n', v: 1, f: 'Assum!B1-Debt!B1' } };
  const Sched = {
    '!ref': 'A1:B2',
    A1: { t: 's', v: 's1' },  B1: { t: 'n', v: 5, f: 'Assum!B1*2' },
    A2: { t: 's', v: 'out' }, B2: { t: 'n', v: 5, f: 'Debt!B1+Sched!B1' },
  };
  return { Assum, Debt, CF, Sched };
}

// ---------------------------------------------------------------------------
const built = build(model());
const edges = loadDependencyEdges(join(built.chunked, 'dependency-graph.json'));
const gt = JSON.parse(readFileSync(join(built.chunked, '_ground-truth.json'), 'utf-8'));

const inputs = ['Assum!B1'];
const outputs = ['Sched!B2'];
const plan = buildScopePlan({ edges, inputs, outputs, gtKeys: gt });

// Flatten active = acyclic + cycle members, for set comparisons.
const cycleCells = plan.activeCycles.flat();
const activeAll = [...plan.activeAcyclic, ...cycleCells];

// (a) active set == hand-derived expectation
console.log('Testing: active set == hand-derived {CF!B1, Debt!B1, Debt!B2, Sched!B1, Sched!B2}');
{
  const EXPECT_ACTIVE = ['CF!B1', 'Debt!B1', 'Debt!B2', 'Sched!B1', 'Sched!B2'];
  assert(setEq(activeAll, EXPECT_ACTIVE), `active set is the 5 formula cells in both cones (got ${[...activeAll].sort().join(', ')})`);
  assert(!activeAll.includes('Assum!B1'), 'the lever Assum!B1 is NOT in active (pinned to override, not recomputed)');
  assert(!activeAll.includes('Debt!B3'), 'the rate Debt!B3 is NOT active (not downstream of the lever)');
}

// cycle vs acyclic split
console.log('Testing: cycle = {CF!B1,Debt!B1,Debt!B2}; acyclic = {Sched!B1,Sched!B2}');
{
  assert(plan.activeCycles.length === 1, `exactly one multi-cell cycle (got ${plan.activeCycles.length})`);
  assert(setEq(plan.activeCycles[0] || [], ['CF!B1', 'Debt!B1', 'Debt!B2']), 'cycle is the cross-sheet 3-cell SCC');
  assert(setEq(plan.activeAcyclic, ['Sched!B1', 'Sched!B2']), 'acyclic tail = {Sched!B1, Sched!B2}');
}

// (b) every activeAcyclic cell appears after its active reads (valid topo order)
console.log('Testing: activeAcyclic is a valid reads-first topo order over the active DAG');
{
  // condensed active reads: cycle members collapse to one unit; a cell that reads
  // any cycle member must come after ALL acyclic cells it reads (cycle is a unit
  // handled separately, so we check acyclic→acyclic and acyclic→cycle ordering).
  const cycleSet = new Set(cycleCells);
  const pos = new Map(plan.activeAcyclic.map((c, i) => [c, i]));
  let ok = true;
  for (const cell of plan.activeAcyclic) {
    for (const ref of edges[cell] || []) {
      if (!pos.has(ref)) continue;                 // ref is a cycle member / boundary / input
      if (pos.get(ref) >= pos.get(cell)) ok = false; // a read must appear earlier
    }
  }
  assert(ok, 'each activeAcyclic cell appears after every active acyclic cell it reads');
  assert((pos.get('Sched!B1') ?? -1) < (pos.get('Sched!B2') ?? 999), 'Sched!B1 (read by Sched!B2) is ordered before Sched!B2');
  assert(plan.activeAcyclic.every(c => !cycleSet.has(c)), 'no cycle member leaks into activeAcyclic');
}

// (c) a cell upstream-but-not-in-fwdCone(inputs) lands in boundary, not active
console.log('Testing: Debt!B3 (upstream, constant under the lever) is BOUNDARY, not active');
{
  assert(plan.boundary.includes('Debt!B3'), 'Debt!B3 is in boundary (read by active Debt!B1, ∉ fwdCone of lever)');
  assert(!activeAll.includes('Debt!B3'), 'Debt!B3 is NOT active');
  assert(setEq(plan.boundary, ['Debt!B3']), `boundary is exactly {Debt!B3} (got ${plan.boundary.join(', ')})`);
  // base value attached from GT (gtKeys passed as a value map)
  assert(plan.boundaryBase && plan.boundaryBase['Debt!B3'] === 0.1, 'boundary base value Debt!B3 = 0.1 from ground truth');
  // the lever is pinned (override), so it is NOT folded into boundary
  assert(!plan.boundary.includes('Assum!B1'), 'the lever Assum!B1 is not in boundary');
}

// (d) cone/cycle counts internally consistent with stats
console.log('Testing: stats are internally consistent');
{
  assert(plan.stats.activeCells === activeAll.length, `stats.activeCells (${plan.stats.activeCells}) == |acyclic|+|cycle| (${activeAll.length})`);
  assert(plan.stats.activeCells === plan.activeAcyclic.length + cycleCells.length, 'activeCells == acyclic + cycle cell counts');
  assert(plan.stats.cycleCells === cycleCells.length, `stats.cycleCells (${plan.stats.cycleCells}) == sum of cycle sizes (${cycleCells.length})`);
  assert(plan.stats.boundaryCells === plan.boundary.length, `stats.boundaryCells (${plan.stats.boundaryCells}) == |boundary| (${plan.boundary.length})`);
  assert(plan.stats.totalFormulaCells === Object.keys(edges).length, `stats.totalFormulaCells (${plan.stats.totalFormulaCells}) == |edges keys| (${Object.keys(edges).length})`);
  // active + boundary cells are a subset of (formula cells + leaves), no double-count
  const overlap = plan.boundary.filter(b => new Set(activeAll).has(b));
  assert(overlap.length === 0, 'active and boundary are disjoint');
}

// C1 contract shape
console.log('Testing: ScopePlan has the exact C1 field set + stable ids');
{
  for (const f of ['scopeId', 'modelHash', 'inputs', 'outputs', 'activeAcyclic', 'activeCycles', 'boundary', 'stats']) {
    assert(f in plan, `plan has field "${f}"`);
  }
  assert(typeof plan.scopeId === 'string' && plan.scopeId.length > 0, 'scopeId is a non-empty string');
  assert(plan.modelHash.startsWith('sha256:'), 'modelHash is a sha256: stamp');
  assert(setEq(plan.inputs, inputs) && setEq(plan.outputs, outputs), 'inputs/outputs echoed back');
  // determinism: same inputs/outputs/graph ⇒ identical scopeId + modelHash
  const plan2 = buildScopePlan({ edges, inputs, outputs, gtKeys: gt });
  assert(plan2.scopeId === plan.scopeId && plan2.modelHash === plan.modelHash, 'scopeId/modelHash are deterministic across runs');
  // a different scope ⇒ a different scopeId
  const plan3 = buildScopePlan({ edges, inputs, outputs: ['Sched!B1'], gtKeys: gt });
  assert(plan3.scopeId !== plan.scopeId, 'a different output scope yields a different scopeId');
}

built.cleanup();

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

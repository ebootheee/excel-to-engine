#!/usr/bin/env node
/**
 * analyze-cone.mjs — measure the structural headroom for targeted/cone evaluation
 * and cell-level cycle resolution, straight off a model's compact cell
 * dependency-graph.json (emit with `ete init --emit-debug`).
 *
 * Answers three questions that size the engine-speed wins:
 *   1. CROSS-SHEET COUPLING — how many distinct cells cross a sheet boundary?
 *      Bounds the interface that forces the sheet-level SCC.
 *   2. CONE SIZE — for a sampled output cell, how many cells must be computed to
 *      produce it (its transitive dependency closure)? vs the whole model. This
 *      is the targeted-evaluation (Tier 3) headroom.
 *   3. TRUE CELL-LEVEL CYCLE — the largest strongly-connected component of CELLS
 *      (range-aware Tarjan), vs the 17-sheet cluster the chunked engine iterates
 *      today. This is the convergence (Tier 2) headroom.
 *
 * Range tokens (`Sheet!A1:B10`) are expanded LAZILY against the formula-cell set
 * (only formula cells matter for traversal), so we never materialize the 37 GB
 * full expansion. Edges are forward (cell -> cells it reads), so cone = forward
 * reachability.
 *
 * Output is AGGREGATE ONLY — counts and sizes, never a cell address or value —
 * so it is safe to run against proprietary models and paste the result.
 *
 * Usage:
 *   node --max-old-space-size=16000 benchmarks/analyze-cone.mjs <chunkedDir> [--sample 3000]
 *
 * @license MIT
 */

import { loadDependencyEdges } from '../lib/manifest-maps.mjs';
import { join, resolve } from 'path';
import { existsSync, statSync } from 'fs';

// ── args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const chunkedDir = resolve(argv.find(a => !a.startsWith('--')) || '.');
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SAMPLE = parseInt(flag('sample', '3000'));
const graphPath = join(chunkedDir, 'dependency-graph.json');
if (!existsSync(graphPath)) {
  console.error(`No dependency-graph.json in ${chunkedDir} — regenerate with: rust-parser <xlsx> <out> --chunked --emit-debug`);
  process.exit(2);
}

// ── small ref helpers (mirror lib/manifest-maps.mjs internals) ──────────────
const colToNum = c => { let n = 0; for (let i = 0; i < c.length; i++) n = n * 26 + (c.charCodeAt(i) - 64); return n; };
const numToCol = n => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
function parseRef(tok) {
  const bang = tok.indexOf('!'); if (bang < 0) return null;
  const sheet = tok.slice(0, bang), addr = tok.slice(bang + 1), colon = addr.indexOf(':');
  if (colon < 0) { const m = /^([A-Z]+)(\d+)$/.exec(addr); if (!m) return null; const c = colToNum(m[1]), r = +m[2]; return { sheet, c1: c, r1: r, c2: c, r2: r, isRange: false }; }
  const a = /^([A-Z]+)(\d+)$/.exec(addr.slice(0, colon)), b = /^([A-Z]+)(\d+)$/.exec(addr.slice(colon + 1));
  if (!a || !b) return null;
  let c1 = colToNum(a[1]), r1 = +a[2], c2 = colToNum(b[1]), r2 = +b[2];
  if (c1 > c2) [c1, c2] = [c2, c1]; if (r1 > r2) [r1, r2] = [r2, r1];
  return { sheet, c1, r1, c2, r2, isRange: true };
}

function pct(n, d) { return d ? (100 * n / d).toFixed(3) + '%' : 'n/a'; }
const t0 = Date.now();
const lap = (m) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

// ── load + index ────────────────────────────────────────────────────────────
console.log(`analyze-cone: ${chunkedDir}`);
console.log(`  dependency-graph.json: ${(statSync(graphPath).size / 1e6).toFixed(0)} MB`);
const edges = loadDependencyEdges(graphPath);          // { cell: [refs/range-tokens] }
const nodes = Object.keys(edges);
const N = nodes.length;
lap(`loaded ${N.toLocaleString()} formula nodes`);

// integer ids + per-sheet column/row index of formula cells (for range expansion)
const id = new Map();
const idxBySheet = new Map(); // sheet -> Map(col -> sorted rows[])
for (let i = 0; i < N; i++) {
  const cell = nodes[i]; id.set(cell, i);
  const p = parseRef(cell); if (!p || p.isRange) continue;
  let e = idxBySheet.get(p.sheet); if (!e) { e = new Map(); idxBySheet.set(p.sheet, e); }
  let rows = e.get(p.c1); if (!rows) { rows = []; e.set(p.c1, rows); }
  rows.push(p.r1);
}
const sortedColsBySheet = new Map();
for (const [sh, cols] of idxBySheet) { for (const rows of cols.values()) rows.sort((a, b) => a - b); sortedColsBySheet.set(sh, [...cols.keys()].sort((a, b) => a - b)); }
lap(`indexed ${idxBySheet.size} sheets`);

const lb = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };
// call fn(formulaNodeId) for each FORMULA cell inside range p
function forEachFormulaInRange(p, fn) {
  const cols = idxBySheet.get(p.sheet); if (!cols) return;
  const sc = sortedColsBySheet.get(p.sheet);
  for (let ci = lb(sc, p.c1); ci < sc.length && sc[ci] <= p.c2; ci++) {
    const col = sc[ci], rows = cols.get(col), letter = numToCol(col);
    for (let i = lb(rows, p.r1); i < rows.length && rows[i] <= p.r2; i++) {
      const nid = id.get(`${p.sheet}!${letter}${rows[i]}`); if (nid !== undefined) fn(nid);
    }
  }
}

// ── build CSR forward adjacency (formula -> formula) + cross-sheet coupling ──
// pass 1: count degrees + cross-sheet interface
const offsets = new Int32Array(N + 1);
const crossSheetTargets = new Set(); // distinct cells (formula or not) read across a sheet boundary
let scalarEdges = 0, rangeTokens = 0, crossSheetReadOps = 0;
function eachNeighbor(srcCell, refs, visit) {
  const sBang = srcCell.indexOf('!'); const srcSheet = srcCell.slice(0, sBang);
  for (const ref of refs) {
    const colon = ref.indexOf(':');
    if (colon === -1) {
      scalarEdges++;
      const rb = ref.indexOf('!');
      if (rb > 0 && ref.slice(0, rb) !== srcSheet) { crossSheetReadOps++; crossSheetTargets.add(ref); }
      const nid = id.get(ref); if (nid !== undefined) visit(nid);
    } else {
      rangeTokens++;
      const p = parseRef(ref); if (!p) continue;
      if (p.sheet !== srcSheet) { crossSheetReadOps++; }
      forEachFormulaInRange(p, (nid) => {
        if (p.sheet !== srcSheet) crossSheetTargets.add(nodes[nid]);
        visit(nid);
      });
    }
  }
}
for (let i = 0; i < N; i++) {
  let deg = 0; const refs = edges[nodes[i]];
  if (refs) eachNeighbor(nodes[i], refs, () => deg++);
  offsets[i + 1] = offsets[i] + deg;
}
const E = offsets[N];
lap(`degree pass: ${E.toLocaleString()} formula->formula edges (${scalarEdges.toLocaleString()} scalar refs, ${rangeTokens.toLocaleString()} range tokens)`);
console.log(`  cross-sheet read ops: ${crossSheetReadOps.toLocaleString()}  |  DISTINCT cross-sheet target cells: ${crossSheetTargets.size.toLocaleString()} (${pct(crossSheetTargets.size, N)} of formula cells)`);

// pass 2: fill targets
const targets = new Int32Array(E);
const cursor = offsets.slice(0, N);
for (let i = 0; i < N; i++) {
  const refs = edges[nodes[i]];
  if (refs) eachNeighbor(nodes[i], refs, (nid) => { targets[cursor[i]++] = nid; });
}
lap(`built CSR adjacency`);
// free the heavy maps we no longer need
for (const k in edges) delete edges[k];

// ── cone sizes (forward reachability) over a sample ─────────────────────────
function coneSize(start) {
  const seen = new Uint8Array(0); // placeholder; use a Set for sparse
  const visited = new Set([start]); const stack = [start];
  while (stack.length) { const u = stack.pop(); for (let e = offsets[u]; e < offsets[u + 1]; e++) { const v = targets[e]; if (!visited.has(v)) { visited.add(v); stack.push(v); } } }
  return visited.size;
}
// deterministic stride sample
const sampleSizes = [];
const stride = Math.max(1, Math.floor(N / SAMPLE));
for (let i = 0; i < N; i += stride) sampleSizes.push(coneSize(i));
sampleSizes.sort((a, b) => a - b);
const q = (p) => sampleSizes[Math.min(sampleSizes.length - 1, Math.floor(p * sampleSizes.length))];
lap(`cone sample (${sampleSizes.length} cells):`);
console.log(`    median cone: ${q(0.5).toLocaleString()} cells (${pct(q(0.5), N)})`);
console.log(`    p90 cone:    ${q(0.9).toLocaleString()} (${pct(q(0.9), N)})`);
console.log(`    p99 cone:    ${q(0.99).toLocaleString()} (${pct(q(0.99), N)})`);
console.log(`    MAX cone:    ${sampleSizes[sampleSizes.length - 1].toLocaleString()} (${pct(sampleSizes[sampleSizes.length - 1], N)})`);

// ── range-aware Tarjan SCC over CSR (iterative) ─────────────────────────────
lap(`running Tarjan SCC over ${N.toLocaleString()} nodes / ${E.toLocaleString()} edges...`);
const index = new Int32Array(N).fill(-1);
const low = new Int32Array(N);
const onStack = new Uint8Array(N);
const tindex = new Int32Array(N); // saved neighbor cursor per node (iterative DFS)
const sccSizes = [];
let idxCounter = 0;
const S = []; // tarjan stack
const work = []; // DFS work stack of node ids
for (let s = 0; s < N; s++) {
  if (index[s] !== -1) continue;
  work.push(s);
  while (work.length) {
    const u = work[work.length - 1];
    if (index[u] === -1) { index[u] = low[u] = idxCounter++; S.push(u); onStack[u] = 1; tindex[u] = offsets[u]; }
    let recursed = false;
    for (let e = tindex[u]; e < offsets[u + 1]; e++) {
      const v = targets[e];
      if (index[v] === -1) { tindex[u] = e + 1; work.push(v); recursed = true; break; }
      else if (onStack[v]) { if (index[v] < low[u]) low[u] = index[v]; }
    }
    if (recursed) continue;
    // done with u: update parent low, pop SCC if root
    if (low[u] === index[u]) {
      let size = 0, w;
      do { w = S.pop(); onStack[w] = 0; size++; } while (w !== u);
      if (size > 1) sccSizes.push(size);
    }
    work.pop();
    if (work.length) { const par = work[work.length - 1]; if (low[u] < low[par]) low[par] = low[u]; }
  }
}
sccSizes.sort((a, b) => b - a);
const inAnyCycle = sccSizes.reduce((a, b) => a + b, 0);
lap(`Tarjan done`);
console.log(`    multi-cell SCCs: ${sccSizes.length}`);
console.log(`    cells in ANY cycle: ${inAnyCycle.toLocaleString()} (${pct(inAnyCycle, N)} of formula cells)`);
console.log(`    LARGEST cycle: ${(sccSizes[0] || 0).toLocaleString()} cells (${pct(sccSizes[0] || 0, N)})`);
console.log(`    top 8 cycle sizes: ${sccSizes.slice(0, 8).map(x => x.toLocaleString()).join(', ')}`);

console.log('\n=== SUMMARY (aggregate; safe to share) ===');
console.log(JSON.stringify({
  formulaCells: N,
  formulaToFormulaEdges: E,
  distinctCrossSheetTargets: crossSheetTargets.size,
  coneMedian: q(0.5), coneP90: q(0.9), coneP99: q(0.99), coneMax: sampleSizes[sampleSizes.length - 1],
  multiCellSCCs: sccSizes.length,
  cellsInAnyCycle: inAnyCycle,
  largestCycle: sccSizes[0] || 0,
  elapsedSec: +((Date.now() - t0) / 1000).toFixed(1),
}, null, 2));

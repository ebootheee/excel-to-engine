/**
 * excel-to-engine — Scope-plan library (engine-speed Lane 0; ADR-026).
 *
 * `buildScopePlan({ edges, inputs, outputs, gtKeys })` computes the C1 ScopePlan:
 * the minimal subgraph that must be recomputed for a `(inputs → outputs)` what-if,
 * with everything else constant-folded to its base value. Lanes 1 (in-engine
 * cell-level cycle resolution) and 2 (scoped cone module) consume it.
 *
 * The graph is the compact forward edge map (`cell → [cells/range-tokens it
 * READS]`) emitted by every chunked build (`dependency-graph.json`,
 * `cell-dependency-edges-v2`). Only formula cells appear as keys; ranges stay as
 * tokens and are expanded LAZILY against the formula-cell set, so we never
 * materialize the 37 GB full expansion (issue #32) and the plan scales to the
 * 535 MB A-1 graph (typed-array CSR, like `benchmarks/analyze-cone.mjs`).
 *
 * Cone semantics (forward edges = reads, so directions flip):
 *   - backwardCone(outputs) — cells the outputs DEPEND ON (upstream) — is forward
 *     reachability FROM the outputs (mirrors `computeOutputClosures`' seen-set).
 *   - forwardCone(inputs) — cells AFFECTED BY the inputs (downstream) — is REVERSE
 *     reachability from the inputs (one reverse CSR, built once).
 *   - active = formula cells in forwardCone ∩ backwardCone (minus the inputs
 *     themselves, which are pinned to the lever value, not recomputed).
 *   - boundary = every cell an active cell reads that is NOT in forwardCone —
 *     constant under the what-if, pinned to its base value.
 *
 * Correctness (ADR-026 §Why it's correct): every active cell sees exactly the
 * inputs it would in a full run — active reads recompute, input reads are the
 * lever, boundary reads are base constants — so the requested outputs reproduce
 * the full-run values. Cycles inside the active set iterate as a unit.
 *
 * @license MIT
 */

import { createHash } from 'crypto';
import {
  parseRefToken,
  buildCellIndex,
  forEachCellInRange,
} from './manifest-maps.mjs';

const colToNum = col => { let n = 0; for (let i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64); return n; };
const numToCol = num => { let s = ''; while (num > 0) { const r = (num - 1) % 26; s = String.fromCharCode(65 + r) + s; num = Math.floor((num - 1) / 26); } return s; };

// ── per-sheet formula-cell index, for lazy range → formula-id expansion ──────
// Mirrors analyze-cone.mjs: sheet → Map(col → sorted rows[]) + sorted col list,
// keyed straight to the integer ids so a range token resolves to formula ids
// without ever expanding the range. (`buildCellIndex` from manifest-maps yields
// the same structure but maps to addresses; here we want ids for the CSR.)
const lowerBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };

/**
 * Build integer ids for every formula cell (keys of `edges`) + a per-sheet
 * column/row index so a range token can be resolved to the formula ids it covers
 * via interval queries (binary search), never by materializing the range.
 *
 * @param {string[]} nodes - formula cell addresses (Object.keys(edges))
 * @returns {{ id: Map<string,number>, forEachFormulaIdInRange: (p, fn)=>void }}
 */
function buildFormulaIndex(nodes) {
  const N = nodes.length;
  const id = new Map();
  const idxBySheet = new Map();           // sheet → Map(col → rows[])
  for (let i = 0; i < N; i++) {
    const cell = nodes[i];
    id.set(cell, i);
    const p = parseRefToken(cell);
    if (!p || p.isRange) continue;
    let cols = idxBySheet.get(p.sheet);
    if (!cols) { cols = new Map(); idxBySheet.set(p.sheet, cols); }
    let rows = cols.get(p.c1);
    if (!rows) { rows = []; cols.set(p.c1, rows); }
    rows.push(p.r1);
  }
  const sortedColsBySheet = new Map();
  for (const [sh, cols] of idxBySheet) {
    for (const rows of cols.values()) rows.sort((a, b) => a - b);
    sortedColsBySheet.set(sh, [...cols.keys()].sort((a, b) => a - b));
  }
  function forEachFormulaIdInRange(p, fn) {
    const cols = idxBySheet.get(p.sheet);
    if (!cols) return;
    const sc = sortedColsBySheet.get(p.sheet);
    for (let ci = lowerBound(sc, p.c1); ci < sc.length && sc[ci] <= p.c2; ci++) {
      const col = sc[ci], rows = cols.get(col), letter = numToCol(col);
      for (let i = lowerBound(rows, p.r1); i < rows.length && rows[i] <= p.r2; i++) {
        const nid = id.get(`${p.sheet}!${letter}${rows[i]}`);
        if (nid !== undefined) fn(nid);
      }
    }
  }
  return { id, forEachFormulaIdInRange };
}

/**
 * Build the forward formula→formula CSR (each formula cell → the formula cells it
 * reads). Two passes (degree, then fill) like analyze-cone.mjs so the target array
 * is exactly sized. Range tokens are expanded lazily to formula ids. Non-formula
 * reads (raw inputs/constants) are not edges — they have no id — so they fall out
 * of the CSR and are handled as leaves during boundary collection.
 *
 * @returns {{ offsets: Int32Array, targets: Int32Array }}
 */
function buildForwardCSR(edges, nodes, id, forEachFormulaIdInRange) {
  const N = nodes.length;
  const eachTarget = (srcCell, visit) => {
    const refs = edges[srcCell];
    if (!refs) return;
    for (const ref of refs) {
      if (typeof ref !== 'string') continue;
      if (ref.indexOf(':') === -1) {
        const nid = id.get(ref);
        if (nid !== undefined) visit(nid);
      } else {
        const p = parseRefToken(ref);
        if (p) forEachFormulaIdInRange(p, visit);
      }
    }
  };
  const offsets = new Int32Array(N + 1);
  for (let i = 0; i < N; i++) {
    let deg = 0;
    eachTarget(nodes[i], () => deg++);
    offsets[i + 1] = offsets[i] + deg;
  }
  const E = offsets[N];
  const targets = new Int32Array(E);
  const cursor = offsets.slice(0, N);
  for (let i = 0; i < N; i++) {
    eachTarget(nodes[i], (nid) => { targets[cursor[i]++] = nid; });
  }
  return { offsets, targets };
}

/** Transpose a CSR adjacency (forward → reverse) in two linear passes. */
function transposeCSR(offsets, targets, N) {
  const E = targets.length;
  const rOffsets = new Int32Array(N + 1);
  for (let e = 0; e < E; e++) rOffsets[targets[e] + 1]++;
  for (let i = 0; i < N; i++) rOffsets[i + 1] += rOffsets[i];
  const rTargets = new Int32Array(E);
  const cursor = rOffsets.slice(0, N);
  for (let u = 0; u < N; u++) {
    for (let e = offsets[u]; e < offsets[u + 1]; e++) {
      const v = targets[e];
      rTargets[cursor[v]++] = u;        // reverse edge v → u
    }
  }
  return { offsets: rOffsets, targets: rTargets };
}

/**
 * Mark every node reachable from `seeds` over the CSR (forward closure). Returns a
 * Uint8Array reachability bitmap (the seen-set IS the cone). Iterative stack —
 * no recursion, so it never blows the call stack on the deep real graph.
 */
function reachable(offsets, targets, N, seeds) {
  const seen = new Uint8Array(N);
  const stack = [];
  for (const s of seeds) if (s !== undefined && !seen[s]) { seen[s] = 1; stack.push(s); }
  while (stack.length) {
    const u = stack.pop();
    for (let e = offsets[u]; e < offsets[u + 1]; e++) {
      const v = targets[e];
      if (!seen[v]) { seen[v] = 1; stack.push(v); }
    }
  }
  return seen;
}

/**
 * Range-aware iterative Tarjan SCC over the (forward) CSR, restricted to the
 * `active` node set. Lifts the integer-id iterative Tarjan from
 * analyze-cone.mjs (no recursion → no stack overflow on deep graphs), but only
 * descends into active neighbors so the SCCs are computed within the active
 * subgraph. Returns:
 *   - sccOf:   Int32Array node → its SCC root id (or -1 if inactive)
 *   - cycles:  Array of node-id arrays, one per multi-node SCC (size > 1)
 * Single-node SCCs that have no self-loop are acyclic; a single node WITH a
 * self-loop (rare: a cell reading itself) is reported as a 1-node cycle so the
 * cone module iterates it.
 */
function tarjanActive(offsets, targets, N, active) {
  const index = new Int32Array(N).fill(-1);
  const low = new Int32Array(N);
  const onStack = new Uint8Array(N);
  const tcursor = new Int32Array(N);     // saved neighbor cursor per node
  const sccOf = new Int32Array(N).fill(-1);
  const cycles = [];
  let idxCounter = 0;
  const S = [];                          // tarjan stack
  const work = [];                       // DFS work stack
  for (let s = 0; s < N; s++) {
    if (!active[s] || index[s] !== -1) continue;
    work.push(s);
    while (work.length) {
      const u = work[work.length - 1];
      if (index[u] === -1) { index[u] = low[u] = idxCounter++; S.push(u); onStack[u] = 1; tcursor[u] = offsets[u]; }
      let recursed = false;
      for (let e = tcursor[u]; e < offsets[u + 1]; e++) {
        const v = targets[e];
        if (!active[v]) continue;        // stay inside the active subgraph
        if (index[v] === -1) { tcursor[u] = e + 1; work.push(v); recursed = true; break; }
        else if (onStack[v]) { if (index[v] < low[u]) low[u] = index[v]; }
      }
      if (recursed) continue;
      if (low[u] === index[u]) {
        const members = [];
        let w;
        do { w = S.pop(); onStack[w] = 0; sccOf[w] = u; members.push(w); } while (w !== u);
        if (members.length > 1) cycles.push(members);
        else {
          // 1-node SCC: a cycle only if the node reads itself (active self-loop).
          let selfLoop = false;
          for (let e = offsets[u]; e < offsets[u + 1]; e++) { if (targets[e] === u) { selfLoop = true; break; } }
          if (selfLoop) cycles.push(members);
        }
      }
      work.pop();
      if (work.length) { const par = work[work.length - 1]; if (low[u] < low[par]) low[par] = low[u]; }
    }
  }
  return { sccOf, cycles };
}

/**
 * Topologically order the active ACYCLIC cells (single-node SCCs) so each appears
 * AFTER the active cells it reads (reads-first evaluation order). Multi-node SCCs
 * are condensed to a single unit; an acyclic cell that reads into a cycle is
 * ordered after that cycle's members. We order over the condensation DAG (Kahn's
 * algorithm on SCC supernodes) and emit, for each finished supernode, its
 * single-node members in dependency order — exactly the order the cone module
 * sets them in.
 *
 * @returns {string[]} active acyclic cell addresses, topo (reads-first) order
 */
function topoOrderAcyclic(offsets, targets, N, active, sccOf, nodes, cycleRoots) {
  // Condensation: supernode = SCC root id. Build inter-SCC edges (dedup) on the
  // REVERSED relation so Kahn yields reads-first order: forward edge u→v (u reads
  // v) means v must come before u, i.e. supernode(v) → supernode(u) in eval order.
  const succ = new Map();                // evalEdge: scc → Set(scc that come after)
  const indeg = new Map();
  const ensure = (r) => { if (!succ.has(r)) { succ.set(r, new Set()); indeg.set(r, 0); } };
  for (let u = 0; u < N; u++) {
    if (!active[u]) continue;
    const ru = sccOf[u];
    ensure(ru);
    for (let e = offsets[u]; e < offsets[u + 1]; e++) {
      const v = targets[e];
      if (!active[v]) continue;
      const rv = sccOf[v];
      if (rv === ru) continue;           // intra-SCC edge (handled by the cycle unit)
      ensure(rv);
      if (!succ.get(rv).has(ru)) { succ.get(rv).add(ru); indeg.set(ru, indeg.get(ru) + 1); }
    }
  }
  // Kahn over supernodes (deterministic: process the smallest root id first).
  const ready = [];
  for (const [r, d] of indeg) if (d === 0) ready.push(r);
  ready.sort((a, b) => a - b);
  const order = [];
  const cycleRootSet = new Set(cycleRoots);
  while (ready.length) {
    const r = ready.shift();
    if (!cycleRootSet.has(r)) order.push(nodes[r]);   // single-node acyclic SCC = the cell itself
    const outs = [...succ.get(r)].sort((a, b) => a - b);
    for (const w of outs) {
      indeg.set(w, indeg.get(w) - 1);
      if (indeg.get(w) === 0) { let i = 0; while (i < ready.length && ready[i] < w) i++; ready.splice(i, 0, w); }
    }
  }
  return order;
}

/**
 * Build the C1 ScopePlan for a `(inputs → outputs)` what-if.
 *
 * @param {object}   args
 * @param {Object<string,string[]>} args.edges - forward edge map (cell → [reads]),
 *        as loaded by `loadDependencyEdges`.
 * @param {string[]} args.inputs  - lever cell addresses ("Sheet!A1").
 * @param {string[]} args.outputs - requested output cell addresses.
 * @param {Iterable<string>|Object<string,*>} [args.gtKeys] - ground-truth cell
 *        addresses (Set/array) for boundary membership, or a `{cell: value}` map
 *        to additionally attach boundary base values (`boundaryBase`).
 * @param {string} [args.modelHash] - model identity stamp (else derived from the
 *        sorted formula-cell set — same graph ⇒ same hash).
 * @returns {ScopePlan}
 */
export function buildScopePlan({ edges, inputs = [], outputs = [], gtKeys, modelHash: modelHashArg } = {}) {
  if (!edges || typeof edges !== 'object') throw new Error('buildScopePlan: edges (forward edge map) is required');
  const inputList = [...inputs];
  const outputList = [...outputs];

  const nodes = Object.keys(edges);
  const N = nodes.length;
  const { id, forEachFormulaIdInRange } = buildFormulaIndex(nodes);

  // gtKeys may be a key collection (membership) or a {cell: value} map (values).
  let gtValues = null;
  let gtKeyIter = gtKeys;
  if (gtKeys && !(gtKeys instanceof Set) && !Array.isArray(gtKeys) && typeof gtKeys === 'object') {
    gtValues = gtKeys;
    gtKeyIter = Object.keys(gtKeys);
  }
  const gtSet = gtKeyIter ? (gtKeyIter instanceof Set ? gtKeyIter : new Set(gtKeyIter)) : null;
  const gtIdx = gtSet ? buildCellIndex(gtSet) : null;   // lazy range → GT-leaf membership

  // CSR (forward) + reverse CSR (built once) over formula cells.
  const fwd = buildForwardCSR(edges, nodes, id, forEachFormulaIdInRange);
  const rev = transposeCSR(fwd.offsets, fwd.targets, N);

  // backwardCone(outputs): forward reachability FROM the outputs (upstream deps).
  const outSeeds = outputList.map(c => id.get(c)).filter(v => v !== undefined);
  const backCone = reachable(fwd.offsets, fwd.targets, N, outSeeds);

  // forwardCone(inputs): reverse reachability from the inputs (downstream impact).
  // An input is usually a RAW LEAF (a constant cell, so not a key in `edges` → no
  // formula id), and leaves are not CSR nodes. So the reverse-cone seeds are the
  // formula cells that DIRECTLY READ an input (+ the input itself if it happens to
  // be a formula key). Found by one scan over each formula cell's reads, expanding
  // range tokens lazily against an input-cell index (issue #32). Everything
  // transitively downstream then follows the reverse CSR.
  const inputSet = new Set(inputList);
  const inputIdx = buildCellIndex(inputSet);
  const seedSet = new Set();
  for (let i = 0; i < N; i++) {
    const c = nodes[i];
    if (inputSet.has(c)) { seedSet.add(i); continue; }   // input is itself a formula cell
    const refs = edges[c];
    if (!refs) continue;
    for (const ref of refs) {
      if (typeof ref !== 'string') continue;
      if (ref.indexOf(':') === -1) {
        if (inputSet.has(ref)) { seedSet.add(i); break; }
      } else {
        const p = parseRefToken(ref);
        if (!p) continue;
        let hit = false;
        forEachCellInRange(inputIdx, p, () => { hit = true; });
        if (hit) { seedSet.add(i); break; }
      }
    }
  }
  const fwdCone = reachable(rev.offsets, rev.targets, N, seedSet);

  // active = formula cells in both cones, minus the input cells themselves.
  const active = new Uint8Array(N);
  let activeCount = 0;
  for (let i = 0; i < N; i++) {
    if (fwdCone[i] && backCone[i] && !inputSet.has(nodes[i])) { active[i] = 1; activeCount++; }
  }

  // SCCs within the active subgraph → cycle units; the rest is the acyclic DAG.
  const { sccOf, cycles } = tarjanActive(fwd.offsets, fwd.targets, N, active);
  const cycleRoots = cycles.map(members => sccOf[members[0]]);
  const activeCycles = cycles.map(members => members.map(nid => nodes[nid]).sort());
  let cycleCells = 0;
  for (const c of activeCycles) cycleCells += c.length;

  // Topo (reads-first) order of the acyclic active cells, cycles condensed.
  const activeAcyclic = topoOrderAcyclic(fwd.offsets, fwd.targets, N, active, sccOf, nodes, cycleRoots);

  // boundary = cells read by an active cell that are NOT in forwardCone(inputs):
  //   constant under the what-if → pin to base. A formula read outside fwdCone is
  //   a constant-folded formula cell; a leaf read (raw input/constant) that is not
  //   itself a lever is a constant. (Leaves are never in fwdCone unless they ARE a
  //   lever, so this captures every non-active, non-lever read.)
  const boundary = new Set();
  const considerRef = (ref) => {
    if (typeof ref !== 'string') return;
    if (ref.indexOf(':') === -1) {
      if (inputSet.has(ref)) return;             // lever → pinned to override
      const nid = id.get(ref);
      if (nid !== undefined) {
        if (!fwdCone[nid]) boundary.add(ref);     // formula cell, constant under what-if
      } else {
        boundary.add(ref);                        // leaf (raw input/constant)
      }
    } else {
      const p = parseRefToken(ref);
      if (!p) return;
      // formula cells in the range: boundary iff outside fwdCone (and not a lever)
      forEachFormulaIdInRange(p, (nid) => { if (!fwdCone[nid] && !inputSet.has(nodes[nid])) boundary.add(nodes[nid]); });
      // leaf cells in the range: any GT cell that is not a formula key (and not a
      // lever) is a constant the active cell reads → boundary.
      if (gtIdx) forEachCellInRange(gtIdx, p, (cell) => { if (!id.has(cell) && !inputSet.has(cell)) boundary.add(cell); });
    }
  };
  for (let i = 0; i < N; i++) {
    if (!active[i]) continue;
    const refs = edges[nodes[i]];
    if (refs) for (const ref of refs) considerRef(ref);
  }

  const boundaryList = [...boundary].sort();

  // modelHash: caller-supplied stamp, else derived from the sorted formula-cell
  // set (same graph ⇒ same hash; cheap and deterministic).
  const modelHash = typeof modelHashArg === 'string'
    ? modelHashArg
    : 'sha256:' + createHash('sha256').update(nodes.slice().sort().join('\n')).digest('hex');

  // scopeId: stable id over sorted(inputs)+sorted(outputs)+modelHash.
  const scopeId = createHash('sha256')
    .update(JSON.stringify({
      inputs: inputList.slice().sort(),
      outputs: outputList.slice().sort(),
      modelHash,
    }))
    .digest('hex')
    .slice(0, 16);

  const plan = {
    scopeId,
    modelHash,
    inputs: inputList.slice().sort(),
    outputs: outputList.slice().sort(),
    activeAcyclic,
    activeCycles,
    boundary: boundaryList,
    stats: {
      activeCells: activeCount,
      cycleCells,
      boundaryCells: boundaryList.length,
      totalFormulaCells: N,
    },
  };

  // Additive: when gtKeys carried values, attach boundary base constants so a
  // consumer (Lane 2 cone module) can fold them without re-reading GT. The frozen
  // C1 `boundary` field stays an address list; this is a sidecar.
  if (gtValues) {
    const boundaryBase = {};
    for (const cell of boundaryList) if (cell in gtValues) boundaryBase[cell] = gtValues[cell];
    plan.boundaryBase = boundaryBase;
  }

  return plan;
}

export default buildScopePlan;

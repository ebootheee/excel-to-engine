# ADR-026 — Scoped-subgraph transpile (#22 / T-078)

- **Status:** Proposed (design only — no implementation in this change)
- **Date:** 2026-06-03
- **Branch this was scoped on:** `feat/engine-perf` (off `main@9ef55c5`)
- **Supersedes/relates:** #22 (output scoping / scaling walls), #33 (returns-cone shrinking / monster-module row-chunking), T-076 (NaN-guard convergence), ADR-nil sheet-level `--lazy-engine`.

## Context

The converted Outpost engine must become a **lock-grade reproducibility artifact for the MIP cone** and serve a `{exit year, exit value, hurdle} → MIP/returns` what-if grid for the downstream consumer (Mippy). The remaining wall is **memory + recompute breadth**, not seed size or `_fn` stubs (those were closed in waves 1–2b).

### What main already has (do not rebuild)
- **Sampled-delta convergence** (`chunked_emitter.rs` `emit_run_function`, ~L694–793): per-pass diff over a cluster-cell sample, not a full-ctx `JSON.stringify`.
- **`--lazy-engine`** (`generate_orchestrator_lazy`, ~L839–979): `load({sheets|cells})` + `runScoped()` + a cone closure.
- **GT-seed scoping** (`computeClusterSeed`, `lib/manifest-maps.mjs` ~L866) cut the cluster seed 23.6× (6.06M → 257K).
- **Cell-level cone primitives** in `lib/manifest-maps.mjs`: `loadDependencyEdges` (streams a >0.5 GB graph, ~L800), `computeOutputClosures` (range-aware forward-closure BFS whose `seen` set **is** a cone, ~L991), `buildCellIndex`/`forEachCellInRange`/`parseRefToken`/`expandRange` (lazy range expansion, no 37 GB blowup — issue #32).
- **Compact cell graph**: `dependency-graph.json` is emitted every chunked build (`RangeMode::Keep`, ~535 MB on the real model) but **deleted by default after closures bake** unless `--emit-debug` (`cli/commands/init.mjs` ~L431).

### The two confirmed blockers (research, this ADR)
1. **`runScoped`/`load` is SHEET-level, not cell-level.** `load({cells})` extracts the sheet prefix of each cell, walks `SHEET_DEPS`, and **any cluster member pulls in ALL cluster sheets** (`chunked_emitter.rs` ~L916–955, esp. L940–942). 
2. **Sheet modules are monolithic** — one `compute(ctx)` per sheet with every cell inlined as `ctx.set(...)` (`generate_sheet_module` ~L297–447). So computing *any* cell in a sheet imports the *whole* module. The 17-sheet returns cluster is **776 MB** (Owned Asset PP&E 190 MB, Future Owned Acquisitions 144 MB, Technology 114 MB, Debt 100 MB, …) — it exceeds an 8 GB heap before any seed is applied.

> **Therefore sheet-level scoping provably cannot beat the wall**: the unit of import is a (sometimes 190 MB) sheet, and a single cluster cell drags in all 17.

### Measured structural headroom (off the real A-1 cell graph; `benchmarks/analyze-cone.mjs`)
| Quantity | Measured | % of 5,579,816 formula cells |
|---|---:|---:|
| Largest **true cell-level cycle** (SCC) | **2,992** | 0.054% |
| All cells in any cycle (1,527 SCCs) | 10,684 | 0.19% |
| Cone — median output | 21,190 | 0.38% |
| Cone — p90 / p99 / max | 476,554 / 3.66M / 3.68M | 8.5% / 66% / 66% |
| Distinct cross-sheet target cells (coupling) | 1,301,221 | 23.3% |

The 17-sheet cluster is **99.8% artifact** — real circularity is ≤ 0.19% of cells. A *full* backward cone of a headline return is large (66%), **but it is mostly the static upstream model**; the part that actually moves under a what-if is tiny (see Decision).

## Decision

Introduce a **build-time scoped-subgraph (“cone module”) transpile**: given a registered scope `(inputCells → outputCells)`, emit a single standalone `cone-<id>.mjs` (a few MB) that recomputes **only the active subgraph** and constant-folds everything else.

**Active subgraph = `forwardCone(inputs) ∩ backwardCone(outputs)`.**
- A cell is recomputed **iff** it is downstream of a moved input *and* upstream of a requested output.
- Every other cell an active cell reads is, by construction, either also active or **unchanged from base case** → pinned to its **base constant** (from `_ground-truth.json`).
- This **exactly reproduces** the full-run value for the requested outputs (proof sketch below) while touching thousands of cells in a few-MB module instead of 776 MB across 17 sheets.

This is the ROADMAP’s “emit/run ONLY the input→output cone, constant-folding the rest.” It is the minimal thing that flips lock-grade for the `{exit, value, hurdle} → MIP` grid.

### Why it’s correct (and small)
- **Correct:** Partition cells into `active` (∈ both cones), `boundary` (read by an active cell, ∉ forwardCone → value == base), and `irrelevant` (∉ backwardCone → never read by an active cell). Boundary cells are pinned to base; active cells recompute from active + boundary inputs; therefore each active cell sees exactly the inputs it would in a full run → identical values. Cycles inside the active set iterate to convergence (same TOL/MAX_ITER contract).
- **Small:** The full backward cone of a return is 66%, but most of it is *upstream of the outputs yet not downstream of {exit, value, hurdle}* — i.e. revenue/cost/schedule cells that don’t change → fold to constants. The active subgraph for the MIP levers is the returns/waterfall core: the ≤2,992-cell cycle plus a modest acyclic tail. No 190 MB schedule module is loaded.

### Artifact shape (chosen)
A per-scope **cone module** emitted at build time:
```
chunked/cones/<scope-id>.mjs
  import { _sumifs, computeXIRR, … } from '../sheets/_helpers.mjs';   // shared, pure
  const BOUNDARY = { "Sheet!A1": <baseConst>, … };                    // folded constants
  export function run(inputs = {}, options = {}) {                    // SAME contract
    const ctx = new ComputeContext();                                // reused runtime
    Object.assign(ctx.values, BOUNDARY);
    for (const [a,v] of Object.entries(inputs)) ctx.values[a] = v;    // + _locked pinning
    // active acyclic cells, topo order:  ctx.set("Sheet!X", <expr>);
    // active cycle cells: convergence loop (reuse intra-sheet pattern ~L382–433)
    return { values, kpis, meta, unknownOverrides };                  // unchanged shape
  }
```
- **Reuses** `transpile()` per active cell (each formula transpiles independently — `transpiler.rs` ~L133–183), the `ComputeContext` runtime, the intra-sheet cycle-loop emitter, and `_helpers.mjs`.
- **New:** the *scope plan* (Lane 0) and the cone-module emitter (Lane 2). See `docs/PLAN-engine-speed.md`.

### Contract invariants the cone module MUST preserve (from the consumer research)
1. Return shape `{ values, kpis, meta:{converged,iterations,maxDelta,convergenceTolerance,clusters,perSheetIterations,elapsedMs}, unknownOverrides }`.
2. **Override pinning** (`_locked`) — overrides survive the (now folded) literal pass.
3. **`strict`** mode → throw on overrides not read by any active cell.
4. **`meta.converged` honest** — false if the active cycle hits MAX_ITER / non-finite (T-076).
5. **baseCaseValue reproducibility** — `run()` (no overrides) reproduces `named-outputs.json` `baseCaseValue` within 1e-6 rel + 1e-6 abs (`lib/verify-engine.mjs`). This is the acceptance oracle.
6. Missing-cell-reads-0 semantics unchanged (boundary covers every cell an active cell reads, so this should not trigger; assert it does not).

## Alternatives considered
- **(A) Per-named-output cone module that still loads whole sheets.** Rejected: doesn’t beat the wall (sheet-atomic import; a cluster cell still pulls 190 MB modules).
- **(B) Runtime cell-level executor** (load per-cell expressions + dep graph at runtime, compute the cone on demand). Viable generalization; deferred. Needs the dep graph present at runtime (it’s deleted by default — `--emit-debug`) and per-cell compute units. Build-time cone modules are the smaller, deterministic first step that nails the known MIP scope; the runtime executor is the follow-on for arbitrary scopes.
- **(C) Row-chunk the monster sheets (#33).** Complementary, not a substitute — it shrinks per-import bytes but a cluster still spans many chunks. Pursue after the cone module as defense-in-depth.

## Consequences / risks
- **Risk: scope registry.** Build-time cones require knowing the `(inputs→outputs)` scopes up front. Seed from `named-inputs.affectsOutputs` ∩ `named-outputs.dependsOnNamedInputs` (already computed). The MIP grid scope (`{exit year, exit value, hurdle} → MIP/returns`) is the first registered scope.
- **Risk: active cycle correctness.** The active set can contain part of a cross-sheet cycle; it must iterate as a unit. Reuse the convergence contract; validate against full-run/GT.
- **Risk: graph availability.** The scope plan (Lane 0) needs `dependency-graph.json`. Build cones during `init` *before* the graph is slimmed, or gate behind `--emit-debug`. (Decision: build registered cones in the init pipeline while the graph is in memory.)
- **Risk: drift.** A cone is only valid for its `modelHash`; stamp it and fail the consumer check on mismatch (same pattern as named-maps).
- **Win:** unblocks the cone *measurement* and the MIP grid; each what-if pass touches ~10³ cells in a few-MB module, not 776 MB — the targeted-query path goes from infeasible/minutes to ms (≈100×+ for the grid; see measured cones).

## Open questions (for the build agents)
1. Cone module per scope vs. one parameterized module keyed by scope-id?
2. Where to source boundary constants — bake into the cone module, or load a small `cone-<id>-boundary.json`?
3. Cell-level SCC for Lane 1 (full-run convergence): compute in Rust at emit (range-aware Tarjan over `Keep` edges) or reuse Lane 0’s JS plan? (Leaning Rust-at-emit so the default engine improves without a JS post-step.)

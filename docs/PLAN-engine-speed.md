# Engine-speed plan — parallel lanes + rapid-iteration harness

**Goal:** make the converted engine fast enough to *use* — full recompute in ~one pass and targeted what-ifs in ms — by exploiting the measured structural headroom. Design rationale + correctness proof live in `docs/adr/ADR-026-scoped-subgraph-transpile.md`. Measured numbers from `benchmarks/analyze-cone.mjs` (real A-1):

- true largest cell cycle = **2,992 cells (0.054%)**; all cycles = 10,684 (0.19%) → the 17-sheet cluster is 99.8% artifact.
- median output cone = **0.38%**, p90 = 8.5%, max = 66% → typical/intermediate queries need ~0.4% of cells; even the heaviest needs ≤66%.
- the 17-sheet cluster is **776 MB of monolithic modules**; `runScoped` is **sheet-level** so it can’t shrink that (ADR-026 §Context).

**Three wins, mapped to lanes:**
- **Tier 1 (certain, load/memory):** drop the double return-clone; compile cache; lazy-by-default. → Lane 3.
- **Tier 2 (full-run speed + feasibility):** iterate the **~3K-cell true cycle**, not all 5.5M, in the in-engine cluster loop. → Lane 1.
- **Tier 3 (targeted/what-if, the Mippy case):** the **scoped cone module** (ADR-026). → Lane 2 (design done; code next).

---

## Frozen contracts (freeze these BEFORE parallel coding starts)

These are the seams that let lanes proceed independently. Land them first (Lane 0 + Lane 4), then L1/L2/L3 code against them.

### C1 — Scope plan (Lane 0 output; Lane 1 & 2 input)
`lib/scope-plan.mjs → buildScopePlan({ edges, inputs, outputs, gtKeys }) → ScopePlan`
```jsonc
ScopePlan = {
  scopeId: "mip-grid",                 // stable id (hash of inputs+outputs+modelHash)
  modelHash: "sha256:…",
  inputs:  ["Valuation!AA54", …],      // the levers
  outputs: ["GPP Promote!G24", …],     // requested cells (named-output cells)
  activeAcyclic: ["Sheet!X", …],       // in fwdCone(inputs) ∩ backCone(outputs), no cycle, TOPO ORDER
  activeCycles:  [["A!1","B!2",…], …], // SCCs within the active set (iterate as units)
  boundary:      ["Sheet!Y", …],       // read by an active cell, NOT in fwdCone → pin to base const
  stats: { activeCells, cycleCells, boundaryCells, totalFormulaCells }
}
```
Reuses `loadDependencyEdges`, `buildCellIndex`/`forEachCellInRange`/`parseRefToken` (EXPORT these from `lib/manifest-maps.mjs` — currently module-private), and a new range-aware Tarjan over the compact graph.

### C2 — Fixture + golden oracle (Lane 4 output; all lanes consume)
- A fixture is a `chunked/` dir + `golden.json = { "<namedOutput>": <value>, … }`.
- Golden source: full `run()` for synthetic fixtures (correct & fast there) or `_ground-truth.json` for outpost.
- `--bless` records/refreshes golden for a fixture.

### C3 — `run()` return contract (already frozen; ALL lanes preserve)
`{ values, kpis, meta:{converged,iterations,maxDelta,convergenceTolerance,clusters,perSheetIterations,elapsedMs}, unknownOverrides }` + override pinning (`_locked`) + `strict` + honest `meta.converged` + baseCaseValue reproducibility within 1e-6 rel/abs (`lib/verify-engine.mjs`).

---

## Lanes (codeable in parallel once C1/C2 are frozen)

### Lane 0 — Scope-plan library  *(foundation; pure JS; no Rust)* — ✅ LANDED (Wave 1, 2026-06-04)
- **Files:** new `lib/scope-plan.mjs`; export the 4 graph helpers from `lib/manifest-maps.mjs`.
- **Do:** cell-level range-aware **Tarjan** over `Keep` edges; `forwardCone(inputs)`; `backwardCone(outputs)` (reverse edges — build once); intersect; topo-order the acyclic active set; collect boundary cells + their base values.
- **Out:** C1 ScopePlan.
- **Accept:** on `mini-cyclic`, plan’s active set == hand-derived; cone/cycle sizes match `analyze-cone.mjs`. ⚠️ **The "<2 s on the 535 MB A-1 graph" target was WRONG** — measured Wave 2 (real graph, 5.58 M cells / 1.76 B edges): graph-load ≈14 s, `buildScopePlan` ≈**20 min**, peak ≈**16 GB** (off-heap typed-array CSR). The cost is intrinsic full-graph processing (forward+reverse CSR + 2 reachability scans + Tarjan over ALL cells), **independent of cone size**, rebuilt per call. This is acceptable as a **one-time BUILD** (the cone is emitted once at `init`; the runtime `cone.run()` what-if is ms). **Wave-3 fix:** build the CSR once and limit per-scope work to the cone (CSR cache / streaming cone extraction), so a second scope isn't another 20 min.
- **Risk:** med (reverse-graph memory on A-1 — reuse the CSR/typed-array approach from `analyze-cone.mjs`). **Depends on:** nothing (uses existing graph). **Unblocks:** L1, L2.

### Lane 1 — Cell-level cycle resolution in the engine (Tier 2)  — ✅ LANDED as JS full-executor reference (Wave 2); Rust default-engine port = Wave 3
> **Wave 2 result:** delivered as `buildFullExecutor` (`lib/cone-emit.mjs`) + the efficacy `cycle`
> variant — the same generator as L2, over `buildFullPlan` (active = every formula cell). It sets each
> acyclic cell once in topo order and iterates ONLY the true cycle cells, proving **cells-iterated/pass
> ÷33,334 on midi** (target ÷500), parity OK. Because active=everything, the full-executor *module* is
> sheet-module-sized on the real model — so this is the midi-scale proof + the reference the Rust port
> mirrors; making the *default* `engine.js` cell-level (no big module) is the `chunked_emitter.rs`
> follow-on (Wave 3). Below = the original Rust-emitter spec for that port.

- **Files:** `pipelines/rust/src/chunked_emitter.rs` (`emit_run_function`, cluster loop); new range-aware Tarjan over the compact cross-sheet edges (or consume an emitted cycle-set).
- **Do:** for a cross-sheet cluster, compute acyclic members **once** in cell topo order, then **iterate only the true cycle cells** (≤2,992) to convergence — instead of re-running 17 whole sheets each pass.
- **Out:** faster default `engine.js`; same contract.
- **Accept:** full `run()` == GT within 1e-6; convergence passes unchanged or fewer; **cells-iterated/pass drops ~500×** (measure via the harness on `midi` + outpost gate).
- **Risk:** HIGH (per-cell execution within a cluster; preserve sampled-delta + NaN-guard). **Depends on:** C2 (oracle), L0 SCC (or its own Rust Tarjan). **Unblocks:** lock-grade full-run.

### Lane 2 — Scoped cone-module transpile (Tier 3, #22/T-078)  — ✅ LANDED (Wave 2, 2026-06-04)
> **Wave 2 result:** `buildCone` (`lib/cone-emit.mjs`) emits `chunked/cones/<scopeId>.mjs` = boundary
> constants + active-acyclic (topo) + active-cycle loops, C3 `run()` contract. Wired into `ete init
> --emit-cones` (seeded from the named maps). Measured on midi: **scoped == full within 1e-6, ÷33,334
> cells/pass, 855× faster, 898× smaller module** — beats the Tier-3 targets (≥100×, no big module
> loaded). Implemented as a JS post-emit step (lifts per-cell exprs from the sheet modules) rather than
> a new Rust `generate_cone_module`, per the "or a JS post-emit step" option below.
> **Build cost caveat (measured):** emitting the cone at A-1 scale is a ~20 min / ~16 GB one-time step
> (dominated by `buildScopePlan` over the full graph — see Lane 0 accept). The RUNTIME what-if is ms;
> the build is folded into `init` and amortized over the grid. Speeding the build = Wave 3.
>
> **⚠ Wave-2 gate finding (real A-1 cone FAILED — `init --emit-cones` is EXPERIMENTAL).** Building a
> real A-1 cone (UW returns) and diffing vs GT gave `converged=false`, 0/4 match. Root cause is an
> UPSTREAM transpiler bug, not the cone: thousands of sheet-module cells are emitted as `expr * COL`
> (multiply by a bare column-letter string → `number * "DB"` = NaN; `* AO` x1467, `* DB` x1204, ...).
> The named outputs dodge these (lockgrade still passes), but a scoped cone's static backward-cone
> pulls them in -> the NaN poisons the active cycle. The cone faithfully reproduces the buggy engine.
> The size thesis held (A-1 cone = 7.8 MB vs 788 MB sheet modules, 101x). **Wave-3 prerequisite for a
> correct real-model cone: fix the transpiler string-multiply emission, then re-gate.** Seeding the
> cycle from base values does NOT fix it (confirmed) -- it is a computation-fidelity bug, not convergence.
>
> **✅ Root cause FIXED (2026-06-05, T-078) — re-gate still pending.** The `* COL` emission was a
> tokenizer bug: an absolute-ROW mixed reference with a relative column (`R$8`, `AM$8:AM$22`, `A$1` —
> ubiquitous in row-anchored finance formulas) was not parsed as a reference and fell through to a bare
> identifier → JS string literal → `number * "R"` = NaN. (`$R8`/`$R$8` already worked; only the
> relative-col + absolute-row shape broke.) Fix: parse the `COL$ROW[:…]` shape as a real ref/range;
> emit unresolved bare identifiers as numeric-safe `null` (Excel `#NAME?`, → 0 in arithmetic, never NaN)
> via a new `Expr::Name` variant; also fixed a `$`-leaks-into-column latent bug in `parse_simple_cell_ref`.
> Verified at the transpiler oracle: `SUMPRODUCT(J8:J22*R$8:R$22)` now emits a real range product.
> **Remaining before lifting EXPERIMENTAL:** the full real-A1 end-to-end re-gate requires rebuilding the
> Outpost chunked artifact from the source xlsx (gitignored / R2-only — not runnable in a clean checkout)
> with this parser, then `efficacy --fixture outpost-a1 --compare baseline` (note: `outpost-a1` is not yet
> a registered fixture in `benchmarks/fixtures/_build.mjs` — it was run ad-hoc). See CHANGELOG 2026-06-05.

- **Files:** new emitter `generate_cone_module` (or a JS post-emit step consuming C1 + per-cell transpiled exprs); wire into `init` while the graph is in memory; register the MIP-grid scope.
- **Do:** emit `chunked/cones/<scopeId>.mjs` = boundary constants + active acyclic (topo) + active cycle loop, exposing the C3 `run()` contract for the scoped outputs.
- **Accept:** `coneRun(inputs) == fullRun(inputs)` for scoped outputs within 1e-6; module is few-MB; **no 190 MB sheet module imported** (assert bytes-loaded); what-if pass touches ~10³ cells.
- **Risk:** med-high. **Depends on:** L0 (ScopePlan), C2. **Unblocks:** MIP grid, Mippy targeted queries.

### Lane 3 — Tier 1 quick wins  *(independent; ship first)* — ✅ LANDED (Wave 1, 2026-06-04)
- **Files:** `chunked_emitter.rs` return (drop `kpis: ctx.kpis()` second clone → alias/getter; keep shape); CLI engine loader (`module.enableCompileCache()` / `NODE_COMPILE_CACHE`); evaluate `--lazy-engine` default for `init`.
- **Accept:** byte-identical outputs; −~400 MB alloc/run; repeat import amortized; harness shows no correctness regression.
- **Risk:** LOW. **Depends on:** nothing. **Unblocks:** immediate UX.

### Lane 4 — Efficacy harness + fixtures  *(foundation; ship first, with L0)* — ✅ LANDED (Wave 1, 2026-06-04)
- See next section. **Unblocks:** every lane’s acceptance check.

### Parallelization map
```
        ┌──────────────── Lane 3 (Tier 1)  ── independent, ship now
start ──┤
        ├── Lane 4 (harness+fixtures) ─┐
        └── Lane 0 (scope-plan) ───────┼── then ─┬── Lane 1 (Tier 2, Rust)
                                        │         └── Lane 2 (Tier 3, cone module)
                                        └── C1/C2 frozen here
```
Critical path: **L4 + L0 → L1/L2**. L3 runs fully in parallel from t0.

---

## Rapid-iteration test loop (the efficacy harness)

**Principle:** the inner loop must be **seconds** and must **prove correctness against an oracle** every run, with speed/memory/structure tracked over time. The real model is the *gate*, not the inner loop.

### Fixtures (tiered)
1. **`mini-cyclic`** (inner loop, <1 s) — synthetic, built with the real parser via the `build(sheets,{lazy})` pattern in `pipelines/rust/tests/test-lazy-engine.mjs`. Must reproduce the pathology: ≥3 sheets, a **cross-sheet cycle** (e.g. `Debt!interest → CF!cash → Debt!balance → Debt!interest`), one **big acyclic schedule** sheet (few-thousand cells), and ≥1 **named output downstream of the cycle**. Golden = full `run()` (correct & instant here). This is where L0/L1/L2 logic is debugged.
2. **`midi-cyclic`** (seconds–~1 min) — same shape, ~50–200K cells, to measure **speedup curves** and stress lazy range expansion. Golden = full `run()`.
3. **`outpost-a1` / `outpost-a2`** (minutes, **gated** — pre-merge/nightly) — the real models. Golden = `_ground-truth.json`. Validates on the actual 776 MB / 5.8M-cell case. Never the inner loop.

Fixtures live under `benchmarks/fixtures/` and `engines/…` (real, gitignored). **Wave-1 decision:** commit only the fixture SPEC (`_build.mjs`) + `golden.json`; the generated `chunked/` dir is gitignored and regenerated on demand by the harness (it is parser-version-dependent, so committing it would drift from the emitter). `mini-cyclic` is built + blessed; `midi-cyclic` is defined in `_build.mjs` and built on first `--fixture midi-cyclic` use (deferred to Wave 2, when the speedup curve needs it).

### Harness — `benchmarks/efficacy.mjs`
```
node benchmarks/efficacy.mjs --fixture mini-cyclic --variant scoped [--compare baseline] [--bless]
```
Per run, measure + record:
- **Correctness (gate):** each named output vs golden, % within 1e-6 rel+abs (reuse `verify-engine.mjs` `close()`); max rel err. **Exit non-zero if any output drifts** (CI gate).
- **Speed:** scope-plan build ms, scoped/cycle run ms, full-run ms, convergence passes, cells-iterated/pass.
- **Memory:** peak RSS; **bytes of sheet/cone modules imported** (proves no 190 MB load).
- **Structure:** active cells, cycle cells, cone size (from the ScopePlan / `analyze-cone`).
- **A/B (`--compare`):** run baseline + variant on the same fixture, **assert value parity**, print speedup× and memory×.

Outputs:
- `benchmarks/results/<ts>-<fixture>-<variant>.json` — full detail, **gitignored** (may carry real cell counts; never values).
- `benchmarks/efficacy-history.jsonl` — one sanitized line/run (timings, sizes, %correct).
- `benchmarks/EFFICACY.md` — committed aggregate table (no cell values/labels), regenerated each run; diff it to see the needle move. Mirrors the privacy rules already in `benchmarks/bench.mjs`.
- `benchmarks/fixtures/<fixture>/golden.json` — blessed oracle values.

### The loop
1. Make a change in a lane.
2. `efficacy.mjs --fixture mini-cyclic --variant <lane> --compare baseline` → **seconds** → PASS/FAIL + speedup×.
3. Iterate on `mini` (then `midi` for the curve) until green + target speedup.
4. **Gate:** `--fixture outpost-a1` (minutes) before merge — confirms on the real 776 MB case.
5. `efficacy-history.jsonl` / `EFFICACY.md` show the trend per commit.

### Targets (acceptance, measured on outpost gate)
- Tier 1: −~400 MB/run; repeat import → ~0; **0 output drift**.
- Tier 2: full run cells-iterated/pass **÷ ~500**; full run feasible at default heap; **0 output drift** vs GT.
- Tier 3: MIP-grid what-if **no 190 MB module loaded**, pass touches ~10³ cells, **scoped == full within 1e-6**; ≥100× vs a full pass for the grid.

### Reuse (don’t reinvent)
- `pipelines/rust/tests/test-lazy-engine.mjs` `build()` — construct fixtures with the real parser.
- `lib/verify-engine.mjs` `close()` / `resolveOutput()` — correctness oracle + schedule aggregation.
- `benchmarks/analyze-cone.mjs` — structural metrics (cone/cycle) + the CSR/typed-array pattern for big graphs.
- `benchmarks/bench.mjs` — existing per-sheet accuracy + the privacy/anonymization pattern for committed summaries.

---

## Wave 2 — ✅ LANDED (2026-06-04, branch `feat/engine-perf-wave2`)

**L1 (full-executor reference + `cycle` variant) and L2 (scoped cone module + `ete init --emit-cones`)
are implemented, tested, and benchmarked** — see the CHANGELOG "Wave 2 landed" entry and the lane
notes above. Measured (midi, `--compare baseline`, parity OK): L2 scoped ÷33,334 cells/pass · 855× ·
898× smaller module; L1 cycle ÷33,334 cells/pass. Tests: scope-plan 45/45, cone-emit 59/59.
**Next (Wave 3):** port L1 into `chunked_emitter.rs` so the *default* `engine.js` resolves cycles
cell-level (the JS full executor is the reference); optional runtime cell-executor for arbitrary
scopes (ADR-026 alt B); row-chunk the monster sheets (#33). The original handoff follows for context.

---

Wave 1 (L0/L3/L4) is **landed on `feat/engine-perf`** (read the tip with `git rev-parse --short feat/engine-perf`). L1/L2 build ON Wave 1.

**Branching.** Wave 1 (L0/L3/L4) is **MERGED to `main`** (fast-forward, 2026-06-04, tip `5daeb6e`). Branch L1/L2 off **current `origin/main`** as usual — it now contains `lib/scope-plan.mjs` (L0) and `benchmarks/efficacy.mjs` (L4). `git fetch` first (main drifts fast — the re-baseline rule). Suggested: `feat/engine-perf-wave2` off `origin/main`. Test + benchmark there; small PRs per CLAUDE.md git discipline.

**How to benchmark your lane (the point of L4).** `benchmarks/efficacy.mjs` exposes pluggable variant hooks: `VARIANTS = { baseline, scoped, cycle }`. `baseline` is the full eager `run()` (the oracle). Fill your lane's hook — signature `async (chunkedDir, inputs) => ({ values, meta, runMs, moduleBytes })` — then:
```
node benchmarks/efficacy.mjs --fixture mini-cyclic --variant cycle  --compare baseline   # L1
node benchmarks/efficacy.mjs --fixture midi-cyclic --variant scoped --compare baseline   # L2
```
`--compare baseline` asserts **value parity** (variant == full run within 1e-6 — the correctness gate, exit-nonzero on drift) and prints **speedup× / module-bytes×**. `--bless` records goldens. `midi-cyclic` (100K cells) builds on first use; it is the speedup-curve fixture.

**Measured Wave-1 baselines (targets to beat):** mini full `run()` ≈ 1.7 ms / 14 passes; midi ≈ 205 ms / 15 passes / 100,011 cells; midi sheet modules ≈ 5.3 MB on disk (the "no 190 MB module loaded" proxy a scoped variant must shrink).

### L1 — cell-level cycle resolution (Tier 2, `chunked_emitter.rs`)
- Iterate ONLY the true cycle cells (≤2,992 on the real model), not all 17 cluster sheets/pass. **Preserve** the sampled-delta convergence + NaN-guard + honest `meta.converged` already in `emit_run_function` (~L694–793) and the full C3 return shape.
- SCC source: compute the cell-level SCC in Rust at emit (range-aware Tarjan over `Keep` edges — leaning this so the *default* engine improves with no JS post-step), or consume L0's `buildScopePlan().activeCycles` (ADR-026 open question #3).
- Accept: full `run()` == GT within 1e-6; cells-iterated/pass ÷ ~500 (measure on midi; gate on outpost).

### L2 — scoped cone-module transpile (Tier 3, #22 / T-078 — the keystone)
- Emit `chunked/cones/<scopeId>.mjs` per ADR-026: BOUNDARY base-constants + active-acyclic (topo) + active-cycle loop, exposing the C3 `run()` for the scoped outputs. Reuse `transpile()` per active cell + `ComputeContext` + the intra-sheet cycle-loop emitter + `_helpers.mjs`.
- **CRITICAL (from the L0 review):** call `buildScopePlan({ edges, inputs, outputs, gtKeys })` **WITH `gtKeys`** (the `_ground-truth.json` map). Without it, range-member RAW-LEAF boundary cells drop from `boundary` → they'd hit missing-cell-reads-0 and violate ADR-026 invariant #6. When `gtKeys` is a `{cell:value}` map, L0 attaches those base values as the additive `plan.boundaryBase` sidecar — bake them into the cone's BOUNDARY block (or read GT directly; ADR-026 open question #2).
- **L0 is UNVALIDATED at A-1 scale** — `buildScopePlan` has run only on synthetic fixtures, not the real 535 MB `dependency-graph.json` (the <2 s target is unverified). Run it on the real graph EARLY. A scratch graph may exist at `engines/_scratch_probe/oa1-dbg/chunked/` (gitignored, ~535 MB); else regenerate with `rust-parser <xlsx> <out> --chunked --emit-debug`.
- Register the first scope = the MIP grid `{exit year, exit value, hurdle} → MIP/returns`; seed scopes from `named-inputs.affectsOutputs` ∩ `named-outputs.dependsOnNamedInputs`. Build cones in `init` while the graph is in memory.
- Accept: `coneRun(inputs) == fullRun(inputs)` within 1e-6; module few-MB; assert **no 190 MB sheet module imported** (`moduleBytes` ≪ baseline); what-if pass touches ~10³ cells; ≥100× vs a full pass for the grid.

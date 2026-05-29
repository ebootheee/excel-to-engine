# HANDOFF — excel-to-engine next session

Start-here doc for a fresh agent. Read this, then `ROADMAP.md` (full backlog),
`PLAN.md` (status), `benchmarks/BASELINE.md` (accuracy numbers), and the two
memory files (`project_outpost_models_shape`, `project_mippy_contract`).

_Last updated: 2026-05-28._

## Where things stand

**Merged to `main` this session:** artifact slimming (#17), GitHub Actions CI
(#18, ubuntu+windows), `refine` consumes `_labels.json` + lazy numerics (#19),
single-GT-parse per `init` (#20).

**Open PR — review/merge first:** **#21 `feat/next-wave`** (CI green). Contains
the Outpost accuracy **benchmark + baseline**, a **per-sheet-eval Windows crash
fix**, `searchByLabel` lazy numerics, **lib/ unit tests** (43), the
**scoped cluster-convergence diff** + the first circular-cluster fixture/test,
and the Mippy regeneration findings in ROADMAP. **If #21 isn't merged yet, branch
off `feat/next-wave`; otherwise off `main`.**

**Baseline (real models, `npm run bench:outpost`):** outpost-a1 **84.3%**,
outpost-a2 **85.5%** — but **standalone sheets only**. The 17-sheet circular
cluster and the 190 MB PP&E sheet are skipped, so ~80% of each model is currently
unmeasured (see P0 below).

## How to run

```bash
npm test                 # full JS suite (387 assertions): lib, cli, manifest, eval, etc.
npm run smoke            # chunked-engine accuracy 78/78
npm run bench:outpost --  --root "<abs path>/engines"   # accuracy + efficacy on the real models
# per-sheet accuracy on one engine (skips clusters by default in the bench):
node eval/per-sheet-eval.mjs <chunkedDir> --concurrency 3 [--skip-clusters]
cd pipelines/rust && cargo build --release   # the parser (needed by smoke/slimming/bench)
```

The real Outpost models live in the **gitignored** `engines/` dir (proprietary —
never commit values/labels). The Mippy agent's fresh regen is in
`engines/outpost-a{1,2}-v2/` (the *better* build: dates fixed, slimmed); the old
build is alongside in `engines/outpost-a{1,2}/`.

## Prioritized backlog (do in this order)

### P0 — Cluster-once eval (THE keystone) ★ highest impact
Unblocks measuring ~80% of each model. The circular cluster is **17 of 21
sheets** (and the array-formula `Headcount` sheet is *inside* it). Today
`eval/per-sheet-eval.mjs` re-runs the **entire** cluster convergence once per
member sheet (17×) → it won't finish on the real model, so the benchmark runs
`--skip-clusters`. **Fix:** one task per cluster — converge once, score every
member from that converged state — then drop `--skip-clusters` from the
benchmark and re-baseline.
- Files: `eval/per-sheet-eval.mjs` (task-building loop ~120-185, `evalOneSheet`
  ~190-365, the cluster `evalScript` template ~230-320, aggregation ~375-390).
- Test oracle READY: `tests/cli/fixtures/cluster-model/` (synthetic SheetA↔SheetB
  converging to a=50,b=50,c=100,d=100). Add a cluster-once assertion to
  `tests/cli/test-per-sheet-eval.mjs` (it already runs that fixture).
- Validate: fixture 100% + smoke unaffected + then a real `--with-clusters` run
  on `engines/outpost-a1-v2` completes in reasonable time and yields a cluster
  accuracy. The scoped-diff (already landed) helps but is NOT sufficient alone.

### P0/P1 — Generation robustness on big models (issue #23) — blocks clean builds
A clean `ete init` on a real model **does not complete**: the Rust parser is
OOM-killed at the cell-level dependency-graph step, and `ete init`'s 10-min
`spawnSync` cap times out → `engine.js` (the `run()` orchestrator) and
`dependency-graph.json` closures don't land (they're written after the OOM
step); the Mippy regen worked around it with direct-parse + `--reuse-parse`.
- Fix directions: stream/incrementalize the dep-graph build or raise its memory
  headroom; within-sheet parallelism; streaming writes; configurable init
  timeout. Mostly `pipelines/rust/` + `cli/commands/init.mjs` timeout.
- Impact: until fixed, the downstream consumer can't get a clean full artifact
  set (closures + orchestrator) from one command.

### P1 — Transpiler coverage: 11,813 `_fn()` fallbacks ★ big accuracy lever
That many formula cells per engine transpile to a generic unsupported-function
stub (unchanged old→new, so it predates this work). Almost certainly a large
slice of the ~15% standalone-sheet gap. **Inventory which Excel functions hit
the `_fn()` fallback, rank by frequency, implement the top offenders.**
- Files: `pipelines/rust/src/` (transpiler). Measure on `engines/*-v2`.

### P1 — Refiner mis-maps returns to the "UW Comparison" tab ★ quick + concrete
Auto-manifest picks an underwriting-comparison cell (2.305x) over the canonical
Version Tracker returns (2.349x) because `SUMMARY_SHEET_PATTERN` over-ranks
"UW Comparison" — forcing manual per-model pinning. Make the refiner recognize
canonical returns / "Version Tracker" tabs, or de-prioritize
underwriting-comparison tabs.
- File: `cli/commands/manifest-refine.mjs` (`SUMMARY_SHEET_PATTERN` line ~24,
  ranking in `searchForFieldIndexed`). Add/extend a manifest **invariant** so it
  can't silently revert. Validate with `tests/cli/test-refine-label-index.mjs`.

### P1 — Golden-master CI assert ★ near-free regression guard
A-1's regenerated ground truth reproduces the hand-port's canonical returns to
full float precision (Version Tracker row 22: grossMOIC L22 ≈2.34916, grossIRR
M22 ≈0.19233, netMOIC T22 ≈2.23137, netIRR U22 ≈0.18240). The committed
`named-outputs.json` `baseCaseValue`s (for a pinned A-1 manifest) make a ready
golden-master. **Add a CI test that diffs those against the known values.** Note:
the engine artifacts are gitignored; commit only the small contract JSON (or
hard-code the canonical values in the test).

### P2 — `--output-profile` / guided `ete create` (issue #22)
Skip the ~752 MB per-sheet engine emit when a consumer only needs ground truth +
contract maps. Scope artifacts to the actual need.

### P2 — Large-sheet eval (190 MB PP&E)
Exceeds the 150 MB per-sheet limit in `per-sheet-eval` → skipped. Needs
streaming/sharded per-sheet eval or a higher limit with chunked compute.

### P2 — Manifest-pipeline perf on ~6M-cell models
`generate` detectors, `maps` cell-type pass, and `refine`'s `buildLabelIndex`
fallback are O(N) on the full GT and slow. Profile + optimize. (Distinct from the
Rust-side #23; this is the JS pipeline.)

### P3 — Polish → Publish remainder
lib/ unit tests done. Remaining: npm publish prep (`bin`, `files`, repo
metadata), synthetic example project, contributing guide. (Arguably hold publish
until accuracy blockers close.)

### P3 — Lower priority / model-owner
- `named-inputs.json` is empty when a workbook has no formula-referenced
  defined-names (the Outpost case) — heuristic fallback or documented manual path.
- MIP-as-output (request #7): modeled across per-block "MIP Proceeds" cells, not
  a single GT cell — a model-owner question, surface via aggregate mapping.

## Gotchas (will bite you)

- **`engines/` is gitignored** (real financials). Read-only; report only
  aggregate metrics. `_eval_tmp/` and `benchmarks/results/` are gitignored too.
- **`_computed-values.json` in these engines is a byte-identical COPY of ground
  truth** (seeded). It is NOT a valid accuracy source — accuracy must be live
  recompute (per-sheet-eval). The benchmark already avoids it.
- **per-sheet-eval was Windows-broken** (bare absolute ESM import). Fixed via
  `pathToFileURL`; guarded by `tests/cli/test-per-sheet-eval.mjs` on windows CI.
  Don't reintroduce bare absolute `import` paths.
- **`benchmarks/outpost-bench.mjs` `discoverModels()` gates on `engine.js`** —
  but the `-v2` regen dirs may LACK `engine.js` (OOM, see #23) while having
  `_graph.json` + `sheets/` (what per-sheet-eval actually needs). If the bench
  skips `-v2`, relax the gate to `_graph.json` + `sheets/`.
- **CI runs ubuntu + windows.** Anything touching child-process paths or the
  parser binary must work on both.

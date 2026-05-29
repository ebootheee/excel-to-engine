# HANDOFF — excel-to-engine next session

Start-here doc for a fresh agent. Read this, then `ROADMAP.md` (full backlog),
`PLAN.md` (status), `benchmarks/BASELINE.md` (accuracy numbers), and the two
memory files (`project_outpost_models_shape`, `project_mippy_contract`).

_Last updated: 2026-05-28._

## The job, in one line

**Make the full Outpost model a reliable Mippy calibration oracle: runnable,
with the MIP coefficients exposed as named-outputs, and no stubbed value cells.**
Everything Mippy-specific stays in Mippy — this repo just produces a trustworthy,
sample-able engine + contract.

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
outpost-a2 **85.5%** — standalone sheets only (cluster + 190 MB PP&E skipped).

## How to run

```bash
npm test                 # full JS suite (387 assertions)
npm run smoke            # chunked-engine accuracy 78/78
npm run bench:outpost --  --root "<abs path>/engines"   # accuracy + efficacy on the real models
node eval/per-sheet-eval.mjs <chunkedDir> --concurrency 3 [--skip-clusters]
cd pipelines/rust && cargo build --release   # the parser
```

Real Outpost models live in the **gitignored** `engines/` dir (proprietary —
never commit values/labels). The Mippy agent's fresh regen is in
`engines/outpost-a{1,2}-v2/` (the *better* build: dates fixed, slimmed) alongside
the old `engines/outpost-a{1,2}/`.

## P1–P3 — Mippy calibration-oracle feature set (do in this order)

All filed on ebootheee/excel-to-engine. Done-criteria are the contract.

### P1 · #23 + #24 — reliably emit a runnable `engine.js` ★ blocks everything
A clean `ete init` on a real model currently **does not finish**: the Rust parser
is OOM-killed at the cell-level dependency-graph step, and `ete init` hits its
10-min `spawnSync` cap → `engine.js` (the `run()` orchestrator) + the
`dependency-graph.json` closures **don't land** (written after the OOM step).
- **Done =** `chunked/engine.js` with `export function run()` exists on **every**
  build; the build **errors hard** if it can't — **never a partial artifact**.
- #24 also: **lock the artifact layout + emit a content hash** so downstream
  consumes without per-version reconciliation.
- Without a runnable engine we can't sample MIP to calibrate/validate — this
  gates everything below.
- Files: `pipelines/rust/` (dep-graph build: stream/incrementalize or raise
  headroom; fail-loud), `cli/commands/init.mjs` (configurable timeout; don't
  swallow a failed emit).

### P2 · #25 — pin the value-bearing cells as named-outputs
Per-class **MIP Proceeds**, **hurdle/threshold**, **participation %**, **equity
basis**, **valuation / shares** — not just MOIC/IRR.
- **Done =** those appear in `named-outputs.json` with base-case values. **These
  ARE the parametric coefficients Mippy calibrates against.**
- Files: `lib/manifest-maps.mjs` (`enumerateOutputCells` — extend beyond
  MOIC/IRR/TV/carry; `customCells` is the current escape hatch),
  `cli/commands/manifest*.mjs`. Pin per-model (the auto-manifest mis-maps —
  see the refiner fix under "supporting").

### P2 · #26 — `_fn` fallback audit: emit `_fn-fallbacks.json` (correctness gate)
- **Done =** we can **assert no MIP / value / return cell resolves through an
  unsupported-function stub.** (Auditing/gating the value cells — distinct from
  fixing all 11,813 fallbacks, which is the deeper transpiler work below.)
- Files: `pipelines/rust/` (emit the audit during transpile) + a check that the
  P2/#25 named-output cells aren't in it.

### P3 (nice-to-have) · #22 — output-cone scoping
Scope generated artifacts to the consumer's need (skip the ~752 MB per-sheet
emit). Makes the oracle cheaper to run; **not required** — we don't ship the blob.

## Supporting work — makes the oracle *trustworthy* (after P1, alongside P2/P3)

These aren't on Mippy's critical path but back the "reliable" in "reliable
calibration oracle":
- **Golden-master CI assert** — A-1's regenerated GT matches the hand-port's
  canonical returns to full float precision (Version Tracker row 22: grossMOIC
  L22 ≈2.34916, grossIRR M22 ≈0.19233, netMOIC T22 ≈2.23137, netIRR U22
  ≈0.18240). Add a CI test diffing the committed `named-outputs.baseCaseValue`s
  (or hard-coded values; engine artifacts are gitignored). Pairs with #25/#26.
- **Refiner mis-maps returns to a "UW Comparison" tab** (2.305x vs canonical
  2.349x) — `SUMMARY_SHEET_PATTERN` over-ranks it. Fix so #25's value cells pin
  to canonical/Version-Tracker tabs without manual per-model pinning. Add a
  manifest invariant. File: `cli/commands/manifest-refine.mjs`.
- **Deeper transpiler coverage** — the 11,813 `_fn()` offenders behind #26's
  audit; inventory by frequency, implement top ones. `pipelines/rust/src/`.
- **Cluster-once eval** (our accuracy harness, not Mippy's path): the 17-sheet
  cluster is unmeasured because `per-sheet-eval` re-runs the whole convergence
  once per member (17×). Make it one task per cluster (converge once, score all),
  then drop `--skip-clusters` and re-baseline. Lets us *verify* the oracle's
  cluster math. Fixture oracle ready: `tests/cli/fixtures/cluster-model/`. (The
  shipped `engine.js` `run()` converges clusters itself — this is measurement.)
- **Large-sheet eval** (190 MB PP&E > 150 MB limit) and **manifest-pipeline
  perf** (generate detectors / maps cell-types / refine fallback on ~6M cells).

## Polish → Publish
lib/ unit tests done. Remaining: npm publish prep (`bin`, `files`, metadata),
synthetic example project, contributing guide. Lower: empty `named-inputs.json`
fallback (no formula-referenced defined-names in the Outpost workbooks);
MIP-as-output beyond the pinned cells is a model-owner question.

## Gotchas (will bite you)

- **`engines/` is gitignored** (real financials). Read-only; aggregate metrics
  only. `_eval_tmp/` + `benchmarks/results/` are gitignored too.
- **`_computed-values.json` in these engines is a byte-identical COPY of ground
  truth** (seeded). NOT a valid accuracy source — use live recompute.
- **per-sheet-eval was Windows-broken** (bare absolute ESM import → `pathToFileURL`
  fix; guarded by `tests/cli/test-per-sheet-eval.mjs` on windows CI). Don't
  reintroduce bare absolute `import` paths.
- **`benchmarks/outpost-bench.mjs` `discoverModels()` gates on `engine.js`** — but
  the `-v2` regen dirs may LACK it (the #23 OOM) while having `_graph.json` +
  `sheets/`. If the bench skips `-v2`, relax the gate. (Fixing #23 makes this moot.)
- **CI runs ubuntu + windows** — child-process/path/parser code must work on both.
- After any change, update CHANGELOG/PLAN/ROADMAP per CLAUDE.md.

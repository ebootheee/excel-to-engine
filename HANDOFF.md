# HANDOFF — excel-to-engine next session

Start-here doc for a fresh agent. Read this, then `ROADMAP.md` (full backlog),
`PLAN.md` (status), `benchmarks/BASELINE.md` (accuracy numbers), and your two
project memory files (the Mippy contract + the real-model shape/baseline notes,
auto-loaded from your memory index).

_Last updated: 2026-05-28._

## The job, in one line

**Make the full PE model a reliable Mippy calibration oracle: runnable,
with the MIP coefficients exposed as named-outputs, and no stubbed value cells.**
Everything Mippy-specific stays in Mippy — this repo just produces a trustworthy,
sample-able engine + contract.

## Where things stand

**Merged to `main` this session:** artifact slimming (#17), GitHub Actions CI
(#18, ubuntu+windows), `refine` consumes `_labels.json` + lazy numerics (#19),
single-GT-parse per `init` (#20).

**Merged since this handoff:** **#21 `feat/next-wave`** + **#27** (privacy scrub)
are now on `main`. #21 brought the PE model accuracy **benchmark + baseline**, a
**per-sheet-eval Windows crash fix**, `searchByLabel` lazy numerics, **lib/ unit
tests** (43), the **scoped cluster-convergence diff** + the first circular-cluster
fixture/test, and the Mippy regeneration findings in ROADMAP.

**This session:** **P1 (#23 + #24) is DONE** on branch `feat/runnable-engine`
(see the P1 section below). Next session starts at **P2 (#25)** — branch off
`main` once P1 merges.

**Baseline (real models, `npm run bench`):** Model A **84.3%**,
Model B **85.5%** — standalone sheets only (cluster + 190 MB PP&E skipped).

## How to run

```bash
npm test                 # full JS suite (387 assertions)
npm run smoke            # chunked-engine accuracy 78/78
npm run bench --  --root "<abs path>/engines"   # accuracy + efficacy on the real models
node eval/per-sheet-eval.mjs <chunkedDir> --concurrency 3 [--skip-clusters]
cd pipelines/rust && cargo build --release   # the parser
```

The real PE models live in the **gitignored** `engines/` dir (proprietary —
never commit values/labels). The Mippy agent's fresh regen is in
`the regenerated `-v2` engine dirs` (the *better* build: dates fixed, slimmed) alongside
the old `the `engines/` model dirs`.

## P1–P3 — Mippy calibration-oracle feature set (do in this order)

All filed on ebootheee/excel-to-engine. Done-criteria are the contract.

### P1 · #23 + #24 — reliably emit a runnable `engine.js` ✅ DONE (2026-05-28, `feat/runnable-engine`)
Was: a clean `ete init` on a real model **did not finish** — the chunked emitter
built the cell-level dependency graph as a full in-memory map + serialized string
(OOM on multi-million-cell models), and `engine.js` was emitted *after* it, so the
runnable engine never landed; the fixed 10-min `spawnSync` cap compounded it.
- **Fixed:** `emit_chunked` now writes `engine.js` **before** the dep-graph step
  (it depends only on the sheet DAG + partitions); the dep-graph is **streamed**
  to disk one entry at a time (`write_dependency_graph`) — the OOM fix.
- `ete init --timeout <seconds>` (default 1800; `0` disables), verifies
  `engine.js` after a fresh parse (fail loud, never partial; `--reuse-parse`
  exempt), and emits `chunked/build-manifest.json` — locked layout + stable
  `contentHash` over the identity artifacts (#24). `--quiet` carries `contentHash`.
- Tests: `npm run test:runnable` (+ CI). New `lib/build-manifest.mjs`.
- Files touched: `pipelines/rust/src/chunked_emitter.rs`, `cli/commands/init.mjs`,
  `lib/build-manifest.mjs`, `cli/index.mjs`, `.github/workflows/ci.yml`.

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
  canonical gross/net MOIC & IRR (Version Tracker row 22) to full float
  precision. Add a CI test diffing those `named-outputs.baseCaseValue`s. The
  canonical figures live in the gitignored `named-outputs.json` + project memory
  — **do NOT commit the figures to this public repo.** Pairs with #25/#26.
- **Refiner mis-maps returns to a "UW Comparison" tab** instead of the canonical
  Version Tracker returns — `SUMMARY_SHEET_PATTERN` over-ranks it. Fix so #25's
  value cells pin to canonical/Version-Tracker tabs without manual per-model
  pinning. Add a manifest invariant. File: `cli/commands/manifest-refine.mjs`.
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
fallback (no formula-referenced defined-names in the PE workbooks);
MIP-as-output beyond the pinned cells is a model-owner question.

## Gotchas (will bite you)

- **`engines/` is gitignored** (real financials). Read-only; aggregate metrics
  only. `_eval_tmp/` + `benchmarks/results/` are gitignored too.
- **`_computed-values.json` in these engines is a byte-identical COPY of ground
  truth** (seeded). NOT a valid accuracy source — use live recompute.
- **per-sheet-eval was Windows-broken** (bare absolute ESM import → `pathToFileURL`
  fix; guarded by `tests/cli/test-per-sheet-eval.mjs` on windows CI). Don't
  reintroduce bare absolute `import` paths.
- **`benchmarks/bench.mjs` `discoverModels()` gates on `engine.js`** — but
  the `-v2` regen dirs may LACK it (the #23 OOM) while having `_graph.json` +
  `sheets/`. If the bench skips `-v2`, relax the gate. (Fixing #23 makes this moot.)
- **CI runs ubuntu + windows** — child-process/path/parser code must work on both.
- After any change, update CHANGELOG/PLAN/ROADMAP per CLAUDE.md.

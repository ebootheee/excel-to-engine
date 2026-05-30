# HANDOFF — excel-to-engine next session

Start-here doc for a fresh agent. Read this, then `ROADMAP.md` (full backlog),
`PLAN.md` (status), `benchmarks/BASELINE.md` (accuracy numbers), and your two
project memory files (the Mippy contract + the real-model shape/baseline notes,
auto-loaded from your memory index).

_Last updated: 2026-05-29._

## The job, in one line

**Make the full PE model a reliable Mippy calibration oracle: runnable,
with the MIP coefficients exposed as named-outputs, and no stubbed value cells.**
Everything Mippy-specific stays in Mippy — this repo just produces a trustworthy,
sample-able engine + contract.

## Where things stand

**Latest session (#32 + #33, 2026-05-29):** a clean **full `ete init`** now
completes on the real Outpost A-1/A-2 models — previously the Rust parse finished
(post-#22) but the JS closure-baking step OOM'd. Both A-1 and A-2 regenerated;
benchmark in `benchmarks/BASELINE.md`.
- **#32 — done (three layered fixes).** (1) Cell-level `dependency-graph.json`
  no longer expands ranges (37 GB / 7 min → ~0.5 GB compact `Sheet!A1:B10`
  tokens, schema v2, `extract_refs_ranges`). (2) ~0.5 GB still > Node's ~512 MiB
  max string, so the graph is **newline-delimited** and read by a chunked
  `StringDecoder` streamer (`loadDependencyEdges`) — `readFileSync(utf8)` threw
  and silently dropped the closures before this. (3) The closure BFS
  (`computeOutputClosures`) expands each range token once per output
  (`seenRanges`): repeats touched 2.8 B cells vs 34 M distinct → ~15 min became
  ~2.6 min; tokens expand lazily via column-indexed binary search (identical
  closures, parsed once, both consumers one pass). `ete init` re-execs with a
  12 GB heap (closure-bake peaks ~7.4 GB).
- **#33 — streamed module writer done; cone-shrink deferred.**
  `write_sheet_module<W: Write>` streams to the file (no `Vec<String>`+join);
  emit peak ~2.4 GB. The returns-cone shrink needs **cluster-breaking** (returns
  are in a 17-of-20-sheet atomic cluster) → coupled to cluster-once eval, not
  rushed.
- New `scripts/verify-contract.mjs` machine-checks the Mippy contract.
- **Remaining build-time cost:** the manifest pipeline's full-GT O(N) passes
  (generate/refine/doctor) are now the dominant `ete init` step on these models —
  the clear next perf target (tracked in `project_outpost_models_shape` memory).


**Merged to `main` this session:** artifact slimming (#17), GitHub Actions CI
(#18, ubuntu+windows), `refine` consumes `_labels.json` + lazy numerics (#19),
single-GT-parse per `init` (#20).

**Merged since this handoff:** **#21 `feat/next-wave`** + **#27** (privacy scrub)
are now on `main`. #21 brought the PE model accuracy **benchmark + baseline**, a
**per-sheet-eval Windows crash fix**, `searchByLabel` lazy numerics, **lib/ unit
tests** (43), the **scoped cluster-convergence diff** + the first circular-cluster
fixture/test, and the Mippy regeneration findings in ROADMAP.

**This session:** **P1 (#23 + #24) and P2 (#25 + #26) are fully complete** (landed 2026-05-29). We've successfully delivered:
- Time-series schedules and timelines (such as debt, equity base, cash flows, and investor class distributions) as `named-outputs`.
- Coordinate range expansion (`expandRange()`) to support multi-cell range schedules as discrete transitive dependencies.
- Key model drivers (`exitMultiple`, `exitYearSelector`, `hurdleRate`) written to `named-inputs.json` (normal init path; skipped under `--reuse-parse` w/o the workbook — follow-up).
- A static fallback scanner → `_fn-fallbacks.json`, and a closure audit that flags any named output/schedule resolving through an `_fn()` stub. It **reports** by default (annotates outputs + `stats.fallbackViolations`; `ete init` warns) and **hard-fails only under `--assert-no-fallbacks`** — the real models still carry ~11,813 fallbacks, so a default-hard gate would block every build. A golden-master CI check should assert the list trends to empty as transpiler coverage improves.

**Latest session (golden-master + P2 follow-ups, 2026-05-29):** the trustworthiness pass is done.
- **Golden-master CI assert** — `eval/golden-master.mjs` + `npm run test:golden` + a dedicated CI step. `--assert-no-fallbacks` fails if any return/value output resolves through an `_fn` stub; `--canonical <file>` diffs `named-outputs.baseCaseValue`s to full float precision. CI runs a synthetic committed fixture; run it against the real A-1 build with `ETE_GOLDEN_DIR=<chunkedDir>` + a gitignored `<chunkedDir>/canonical-returns.json` (figures stay out of this public repo).
- **Refiner UW-Comparison fix** — `refineSheetTier` ranks canonical actuals (Version Tracker / Track Record) above an underwriting "UW Comparison" tab, so #25's returns pin to canonical tabs without per-model pinning. Invariant pattern documented in `skill/SKILL.md`.
- **Two follow-ups closed** — driver named-inputs now emit under `--reuse-parse` w/o the workbook; schedule `baseCaseValue` uses the terminal level for balances (sum for flows, via a new `aggregation` field), `perYear` authoritative.

**Latest session (chunked-build partition hang, 2026-05-29):** a clean `ete init`
on the full models hung ~12h in the chunked emitter, right after
`[chunked] Partitioning N sheets...` — the stall is **inside `partition_sheets`**
(sheet_partition.rs), *before* the dep-graph step P1 fixed. Cause: it called the
range-expanding `extract_refs` (which, post-Round-2, explodes every range to ≤1000
cell strings per formula, then partition discards the same-sheet ones) on the
1.62M-formula PP&E sheet → ~10⁹ throwaway allocations → swap thrash. Fix: new
`collect_sheet_deps()` (sheet-names only, no expansion); `detect_intra_sheet_cycles`
→ `extract_refs_shallow()` (it was the next wall); `write_dependency_graph` keeps
the full expander so the contract is unchanged. ~2000× faster on range-heavy
formulas. Validated: `cargo test` 17/17, `smoke` 78/78, `test:depgraph`/`runnable`/
`engine` 11/20/21. **Rebuild the release parser** (`cd pipelines/rust && cargo
build --release`) before re-running the regen — the fix is in the binary.

**Latest session (chunked-build scaling walls, 2026-05-29):** the three #22 walls
are closed. A clean build got *past* partitioning but the module-emit step drove
the parser past 18 GB (it `collect()`ed all ~800 MB of generated module strings
before writing any), and even a complete engine was slow to *run* (eager imports).
- **Wall C (streamed emit):** `chunked_emitter.rs` writes each sheet module to
  disk the instant it's generated and drops the string (heavy sheets ≥200k
  formulas one-at-a-time, light ones parallel) — peak ≈ one monster module, files
  land incrementally. **This is the fix for the 18 GB OOM the regen hit.**
- **Wall B (borrowed partitions):** `SheetPartition<'a>` holds `Vec<&CellData>`
  (`sheet_partition.rs`) instead of cloning ~6M cells — no more peak-memory
  doubling during emit.
- **Wall A (opt-in lazy engine):** `ete init --lazy-engine` (parser
  `--lazy-engine`) emits an engine whose sheet modules load on demand via async
  `load()`/`runScoped()` with **output-cone scoping** (`load({sheets})` /
  `load({cells})` loads only the dependency closure, whole clusters included);
  sync `run()` preserved, guarded against pre-load calls. **Default engine.js is
  unchanged** (eager + sync) — Mippy / `ete eval` / smoke / engine suite untouched.
  Eager & lazy share the `run()` body so they can't drift. New
  `npm run test:lazy-engine` (19) + CI. **Rebuild the release parser before regen.**

Next session (none on the critical path): **a clean A1/A2 regen** to confirm the
emit completes within memory (couldn't be measured here — models are gitignored);
then **row-chunk the 3 monster sheets** (Owned_Asset_PP_E, Future_Owned_Acquisitions,
Technology) so even one is small to generate (`generate_sheet_module` still builds
a `Vec<String>` then joins, ~2× a monster transiently) and import. Plus the rest of
**#22's umbrella** (`--output-profile contract` to skip the per-sheet emit for
contract-only consumers; guided `ete create` skill), **deeper transpiler coverage**
(the 11,813 `_fn` offenders behind #26), and **cluster-once eval**. The Mippy
contract + its trust gates are complete.

**Baseline (real models, `npm run bench`, regenerated 2026-05-29):** Model A
**98.0%** (1733/1768), Model B **97.8%** (1928/1971) — standalone sheets only,
live recompute (cluster + 190 MB PP&E skipped). Up from the prior 84.3% / 85.5%
(older build). Full `ete init` ~21 min/model. `golden-master
--assert-no-fallbacks` shows the returns still resolve through 4 untranspiled
functions — `XNPV`, `FILTER`, `MINIFS`, `MAXIFS` (the concrete coverage target).

## How to run

```bash
npm test                 # full JS suite
npm run smoke            # chunked-engine accuracy 78/78
npm run test:golden      # golden-master gate (synthetic fixture; CI step)
ETE_GOLDEN_DIR=<abs chunkedDir> npm run test:golden   # + real-model canonical diff (opt-in)
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
- **Golden-master CI assert ✅ DONE (2026-05-29).** `eval/golden-master.mjs` +
  `npm run test:golden` + a CI step diff `named-outputs.baseCaseValue`s against
  canonical returns to full float precision and assert no return resolves through
  an `_fn` stub. CI runs a synthetic committed fixture
  (`tests/cli/fixtures/golden-master/`); the canonical figures stay **gitignored**
  (never committed to this public repo) and are diffed only when
  `ETE_GOLDEN_DIR=<chunkedDir>` + `<chunkedDir>/canonical-returns.json` are present.
- **Refiner mis-maps returns to a "UW Comparison" tab ✅ DONE (2026-05-29).**
  `refineSheetTier` (`cli/commands/manifest-refine.mjs`) ranks canonical actuals
  (Version Tracker / Track Record) above the underwriting tab, so #25's value
  cells pin to canonical tabs without manual per-model pinning. The manifest
  invariant trip-wire pattern is documented in `skill/SKILL.md`.
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

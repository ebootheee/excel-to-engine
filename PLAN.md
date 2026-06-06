# excel-to-engine — Plan

## Status: 2026-06-06 — Lite package (ADR-027) Phases 1–7 LANDED; cone re-gate VACUOUS

The ADR-027 lite package is implemented end-to-end on `main`: Tier-0 closed-form, driver-scope, tier
recommender, evaluator adapters, Tier-1 surrogate + honesty gate, consolidated provenance + handoff,
and the `ete lite` front door + `skill/lite/SKILL.md` + a day-in-the-life e2e — all behind the shared
test standard (`docs/LITE-TEST-STANDARD.md`). See the CHANGELOG (2026-06-06 entries) and ADR-027.
Separately: the ADR-026 cone re-gate was RUN and is **vacuous** (scope output `GPP Promote!KU159` ≡ 0,
so `0==0` PASS proves nothing; the override recompute OOM'd) — `init --emit-cones` STAYS EXPERIMENTAL
until a real re-gate on a non-zero, lever-sensitive output (base-case-only compare). See ROADMAP item 1.

## Status: cone/cycle MEASURED + scoped-subgraph DESIGNED (2026-06-03, branch `feat/engine-perf`)

The module wall now has a measured, designed remedy. On the real A-1 cell graph
(`benchmarks/analyze-cone.mjs`): the true largest cell cycle is **2,992 cells (0.054%)** and output
cones are **median 0.38% / max 66%** of 5.58M formula cells — so the 17-sheet convergence cluster is
**99.8% artifact** and the active subgraph for a MIP what-if is tiny. `runScoped` was confirmed
**sheet-level** (can't beat the 776 MB wall; cell-level is required). Design + build plan:
**`docs/adr/ADR-026-scoped-subgraph-transpile.md`** (scoped cone module = fwdCone(inputs) ∩
backCone(outputs), boundary-pinned) and **`docs/PLAN-engine-speed.md`** (parallel lanes L0–L4 +
rapid-iteration efficacy harness). Next: execute the lanes (L4 harness + L0 scope-plan first).

## Status: A-2 returns cone STUB-FREE; remaining wall = monster modules, not the seed (2026-06-03, branch `feat/transpile-averageifs`)

Rebuilt + measured the Outpost A-2 cone on the post-wave-2 engine. Two results:
- **AVERAGEIFS transpiled → A-2 cone is stub-free.** The A-2 rebuild showed net MOIC/IRR still
  resolving through `AVERAGEIFS` (×3103 — the one fn left after wave 1; outside the cone on A-1,
  inside it on A-2). Transpiled it (mirrors SUMIFS/MINIFS). Fresh A-2 rebuild: **0 `_fn()`
  fallback cells**, no output through a stub → the function-level `--assert-no-fallbacks` AFTER is
  green on the real A-2.
- **GT-seed scoping validated but NOT sufficient.** It cut the cluster seed 23.6× (6.06M → 257K),
  but the cone still OOMs at 600s because the 17 cluster sheets are **776 MB of JS modules**
  (loading them exceeds the 8 GB heap before any seed). The seed was never the binding constraint
  for this cluster.

**Remaining to flip `MIPPY_LOCK_GRADE_CONFIRMED`:** the convergence measurement is now blocked on
the module wall, NOT the seed or stubs. The remedy is the **scoped-subgraph transpile (#22 / T-078,
ADR-026)** — emit/run ONLY the input→output cone, not all 776 MB of 17 sheets. Posture HOLDS. See
CHANGELOG 2026-06-03.

## Status: Lock-grade wave 2 — cone-rebuild enablers BUILT (2026-06-03, branch `feat/lockgrade-wave2`)

The pieces that were "remaining" on 2026-06-01 are now built and adversarially reviewed (9
confirmed findings, all fixed): **GT-seed scoping** (`computeClusterSeed` + `GT_SEED_SCOPE` —
seed the cluster's external reads, not all 5.8M cells, so the cone can converge without the
8 GB OOM) and the **sampled-delta convergence loop** (~8.8 min/pass → O(sample)/iter). Plus
two data-correctness items: the **FoF NAV** overstatement fix (`pickFundNav` → scalar NAV,
$184.8M → $161.0M) and **#25** per-class value-bearing named-outputs. All on synthetics + full
`npm test` green. **Remaining to flip `MIPPY_LOCK_GRADE_CONFIRMED`:** rebuild the Outpost A-2
artifact off this branch's parser **with `ete init --emit-debug`** (dependency-graph.json is
slimmed by default and GT-seed scoping needs it), then measure the 17-sheet cone end-to-end on
the rebuilt engine and regenerate the contract so `--assert-no-fallbacks` runs. Posture HOLDS.
See CHANGELOG 2026-06-03.

## Status: Lock-grade engine — Outpost A-1 MIP cone (2026-06-01, branch `feat/lockgrade-cone`)

Closing the two gaps that block lock-grade for the Outpost A-1 MIP (a legal
reproducibility artifact). **Both gaps' code is done and confirmed against the real
model:** (1) the returns no longer resolve through `_fn()` stubs — XNPV/FILTER/MINIFS/
MAXIFS transpiled (with `_xlfn.`/`_xlfn._xlws.` prefix-stripping); a fresh real parse
shows **0** stubs of the four in the returns cone. (2) a single-pass cluster orchestrator
converges the 17-sheet returns cluster once and scores all members, so the cone can be
measured (was `--skip-clusters`'d). Plus a convergence **NaN-guard** (honest
non-convergence contract) for the T-076 cold-probe — diagnosed as waterfall fragility, NOT
the override-convergence bug PR #37 addresses. Remaining before flipping
`MIPPY_LOCK_GRADE_CONFIRMED` / moving ADR-026 off Proposed: measure the real cone
end-to-end (a single convergence over 5.8M seeded cells does NOT finish even at 12 GB /
900 s — needs **GT-seed scoping**, the scoped-subgraph #22/T-078 approach, not just more
resources) and regenerate the contract so the formal `--assert-no-fallbacks` gate runs on
the rebuilt real engine. Posture HOLDS — parametric `v1_1_outpost_a1` keeps shipping. See
CHANGELOG 2026-06-01.

## Status: Analyst-UX gate at **12/12** (Wave 7 measured 2026-05-31 — first clean sweep)

The persona-journey gate has moved 2/12 → 3/12 → 7/12 (Wave 5) → 8/12 (Wave 6) → **12/12
(Wave 7)** — the first time the whole panel clears the gate. avg A7 (woah) **4.08**, C5
(coder) **4.50**, A5 (trust) **4.92** (all 12 `accuracyVerified=true`). Wave 7 shipped three
rolling commits to `main` — schedule-aggregation semantics (flips re-debt), derived-dial
suppression + concept-based output formatting (flips infra), and model-type-aware labeling
(`pe_buyout`/corp budget lens — flips corp + pe-buyout) — plus scoped family levers. A
4-reviewer adversarial-review workflow's `fix-now` findings were all fixed before merge. The
dimensions still at exactly 4 (A6/A7/C5 on the debt/credit family + saas) are now polish, not
correctness: net-of-fee returns, a deal-name header, a name-keyed `run()` overload (see
ROADMAP "Next"). Full scoreboard + per-persona detail in `tests/personas/BENCHMARKS.md`.
History (Wave 1 detail) below.

## Status: Analyst onboarding + coding-agent handoff (Wave 1) — in progress 2026-05-29

Usability initiative: make the toolkit usable by a non-technical finance analyst
working through an AI assistant, with the explicit end-to-end target — *"PE
analyst wants an explorable web app for LPs → points an AI agent at this repo →
'walk me through it' → hands the JS engine to a coding agent → coding agent finds
it easy and exactly what it needs."* Wave 1 (landed on `feat/analyst-onboarding`):
detector accuracy fixes (periodicity / exit-multiple / carry-rate-vs-dollar), the
`INTEGRATION.md` + `example.mjs` handoff bundle from `ete init`,
`lib/verify-engine.mjs`, a rewritten README + new `GETTING_STARTED.md`, a guided
onboarding play in `skill/SKILL.md`, cross-platform `check-env`. New
`tests/cli/test-onboarding.mjs` + `tests/personas/` synthetic-model harness.

**Wave 2 (landed):** model-family awareness driven by the 12-persona simulation
(baseline 2/12 passing the benchmark gate). Contract now emits fund-level +
covenant outputs + per-input UI metadata (min/max/step/format) with closures
preserved across re-emits; the summary is lens-aware (fund/credit/RE/SaaS, no
fabricated EBITDA, correct multiple basis); doctor validates cap-rate/exit-yield
by type; `ete manifest set` self-refreshes the handoff bundle (catch-22 fixed);
review checklist is family-aware.

**Waves 3–4 (landed):** family-aware coverage report (the #1 trust-killer),
doctor-validates-by-type (cap rate/yield), self-refreshing `manifest set`,
input UI-metadata fixes, `outputs.*` promotion, delta-cascade honesty guard,
exit-value labeled by its real cell, Net-dash explainer, doctor reconciliation.

**Capstone acceptance scenario: PASSED** (5/5 both sides) — see
`ANALYST_UX_REPORT.md`. A non-technical PE associate converts the LBO and hands
off; a fresh coding agent builds a real LP what-if web app from the bundle alone
with a headless smoke test that ties out.

**Backlog (documented, not benchmark-blocking):** multi-sheet IRR so fund/infra
returns aren't static literals; engine intra-sheet topological ordering (Rust
emitter, gated by smoke + engine suites — Mippy depends on `run()`); per-year
time-series outputs (debt/covenant monitors); non-defined-name driver levers
(corporate budget); model-type classification (lens already compensates for
display). See `tests/personas/FINDINGS.md`.
> **Next session:** a clean **full `ete init`** now completes end-to-end on the
> real Outpost A-1/A-2 models — the last two regen blockers are fixed. **#32**: the
> cell-level dependency graph no longer expands ranges (37 GB / 7 min → ~0.5 GB
> compact tokens), so the JS closure-baking step parses it without OOM; closures
> are computed by a range-aware indexed BFS and `ete init` re-execs with a 12 GB
> heap. **#33**: `generate_sheet_module` streams to the file instead of building a
> `Vec<String>` + join. Both A-1 and A-2 regenerated; see `benchmarks/BASELINE.md`.
> **Still open:** the #33 returns-cone shrink needs **cluster-breaking** (the
> returns sit in a 17-of-20-sheet atomic cluster) — coupled to **cluster-once
> eval**; the manifest pipeline's full-GT O(N) passes (generate/refine/doctor) are
> the remaining build-time cost; deeper transpiler coverage (11,813 `_fn`).

## Status: `ete init` completes on the real models + A-1/A-2 regenerated + benchmarked (#32, #33) — landed 2026-05-29

A clean **full `ete init`** now runs end-to-end on both Outpost models and emits a
complete, Mippy-consumable contract. **#32** (three layered fixes): compact range
tokens (37 GB → ~0.5 GB), newline-delimited graph + a chunked streaming loader
(~0.5 GB still exceeds Node's 512 MiB string cap — `readFileSync` was silently
dropping the closures), and per-output range-token dedup (closure bake ~15 min →
~2.6 min); plus a 12 GB `init` heap re-exec guard. **#33**: streamed sheet-module
writer (no `Vec<String>`+join). Also fixed a slimming bug that dropped the 3 KB
`_graph.json` the benchmark needs; added `scripts/verify-contract.mjs`.

**Regenerated A-1 + A-2 (~21 min each):** both pass `verify-contract` —
**closures baked 17/17 and 18/18** (A-2's 539 MB graph was the exact prior failure
case). **Accuracy 98.0% / 97.8%** standalone, live recompute (up from 84.3% /
85.5% on the older build; cluster + 190 MB PP&E still skipped). Build mem: emit
~2.4 GB, closure-bake ~7.4 GB. `golden-master --assert-no-fallbacks` shows the
returns resolve through 4 untranspiled functions (`XNPV`, `FILTER`, `MINIFS`,
`MAXIFS`) — the concrete next transpiler-coverage target. **Remaining build cost:**
the manifest pipeline's full-GT O(N) passes (generate/refine/doctor) +
`collectFileFallbacks` reading the monster modules now dominate `ete init`.

## Status: Chunked-build scaling walls closed (streamed emit + borrowed partitions + opt-in lazy engine) — landed 2026-05-29

With the partition hang fixed, a clean build got *past* partitioning but then the
module-emit step drove the parser past 18 GB (it materialized all ~800 MB of
generated module strings before writing any), and even a complete ~800 MB engine
was slow to *run* (eager imports). Three walls (#22) closed:

- **Wall C — streamed emit (`chunked_emitter.rs`).** Each sheet module is written
  to disk the instant it's generated and the string dropped, instead of
  collect-all-then-write; heavy sheets (≥200k formulas) emit one-at-a-time, light
  ones in parallel. Peak emit memory ≈ one monster module, not the whole output.
- **Wall B — borrowed partitions (`sheet_partition.rs`).** `SheetPartition<'a>`
  holds `Vec<&'a CellData>` instead of cloning ~6M cells; removes the second
  full copy that doubled peak memory during emit.
- **Wall A — opt-in `--lazy-engine` (`chunked_emitter.rs`, `main.rs`, `cli/`).**
  Emits a chunked `engine.js` whose sheet modules load on demand via async
  `load()`/`runScoped()` with output-cone scoping; sync `run()` is preserved
  (guarded against pre-load calls). **Default engine.js is unchanged** (eager +
  sync) — the Mippy contract and all in-repo consumers are untouched. Eager/lazy
  share the `run()` body, so they can't drift.

New `npm run test:lazy-engine` (19) + CI. Validated: `cargo test` 17/17, `smoke`
78/78, `test:engine`/`test:runnable`/`test:depgraph` 21/20/11, `test:lazy-engine`
19/19, `test:slimming`/`test:golden` 13/20, full `npm test`, `ete init
--lazy-engine` e2e. **Residual (deferred):** `generate_sheet_module` still builds
a `Vec<String>` then joins (~2× a monster transiently), and a single monster
module is still heavy to import — row-chunking the monster sheets is the next step.

## Status: Chunked-build partition hang fixed — landed 2026-05-29

A clean `ete init` on the full models hung ~12h in the chunked emitter, right
after `[chunked] Partitioning N sheets...`. The stall was **inside
`partition_sheets`** (sheet_partition.rs), *before* the dependency-graph step
that P1 (#23) addressed — so P1's streaming fix exposed it as the next wall.

- **Cause:** `partition_sheets` only needs sheet-level edges, but called the
  range-expanding `extract_refs`. After Round 2 (`59810f6`) taught `is_cell_ref`
  to accept ranges, that exploded every range to ≤1000 cell strings per formula
  (pushed + de-duped), then threw away all the same-sheet ones. ~10⁹ throwaway
  allocations on the 1.62M-formula PP&E sheet → swap thrash.
- **Fix:** new `collect_sheet_deps()` records just referenced sheet *names* (no
  expansion, no per-cell allocation); `detect_intra_sheet_cycles` switched to a
  new `extract_refs_shallow()` (the same blowup would have hit the sheet-module
  phase next). `write_dependency_graph` keeps the full expander, so the
  dependency-graph contract is unchanged. ~2000× faster on range-heavy formulas
  (synthetic parity test).
- **Validated:** `cargo test` 17/17, `smoke` 78/78, `test:depgraph` 11/11,
  `test:runnable` 20/20, `test:engine` 21/21, full `npm test`.

## Status: Golden-master gate + P2 follow-ups — landed 2026-05-29

A trustworthiness pass closing out the P2 contract work.

- **Golden-master CI assert.** `eval/golden-master.mjs` + `npm run test:golden`
  + a dedicated CI step: asserts no return/value output resolves through an `_fn`
  stub (`--assert-no-fallbacks`) and diffs `named-outputs.baseCaseValue`s against
  canonical returns to full float precision. CI runs a synthetic committed
  fixture; the proprietary figures stay gitignored and are diffed only when
  `ETE_GOLDEN_DIR` points at the real model.
- **Refiner Version-Tracker fix.** `refineSheetTier` ranks canonical actuals
  (Version Tracker / Track Record) above an underwriting "UW Comparison" tab, so
  returns pin to the canonical tab without per-model pinning. Invariant trip-wire
  pattern documented in `skill/SKILL.md`.
- **Schedule `baseCaseValue` correctness.** Balances (debt, equity base/NAV) use
  the terminal level; flows keep the life-to-date sum; a new `aggregation` field
  records which. `perYear[]` stays authoritative.
- **Drivers under `--reuse-parse`.** The manifest-driver inputs (`exitMultiple` /
  `exitYearSelector` / `hurdleRate`) now emit even without the workbook (they
  derive from manifest + ground truth); only the defined-name inputs need the
  `.xlsx`.

## Status: P2 (#25 + #26) — contract maps, schedule extraction, and correctness gate — landed 2026-05-29

The Mippy calibration-oracle contract now surfaces schedule fields, timelines,
and investor-class distributions; pins drivable named-inputs; and ships a
fallback audit with an opt-in correctness gate.

- **Request A & B: Time-series schedules and distributions.** Pinned per-year schedules — `outstandingDebt`, `equityBase`, `freeCashFlow`, `distributionsToEquity`, and per-class arrays `classes[].distributions` — into `named-outputs.json` (gated on `manifest.timeline.columnMap`), each as a `cellRange` + `perYear[]`. `expandRange()` converts `Sheet!A10:H10` to discrete cells so schedules participate in the transitive closures (`dependsOnNamedInputs` / `affectsOutputs`).
- **Request C: Drivable named inputs.** Added `exitMultiple`, `exitYearSelector`, and `hurdleRate` to `named-inputs.json` (`source: manifest-driver`). Pinned in the normal init path (the `.xlsx` is available); skipped under `--reuse-parse` without the workbook (follow-up).
- **Request D: Fallback audit + opt-in gate.** A static scanner finds `_fn()` stubs across the generated sheet modules → `_fn-fallbacks.json`, and the closure of every named output/schedule is checked against it. It **reports** by default — affected outputs get `resolvesThroughFallback`, `stats.fallbackViolations` lists them, `ete init` warns — and **hard-fails only under `--assert-no-fallbacks`** (CI/golden-master gate). (Review fix: the gate first `throw`ew mid-emit and was swallowed by init, silently dropping the contract; now it emits all maps then surfaces the result.)

## Status: P1 (#23 + #24) — runnable engine guaranteed — landed 2026-05-28

A clean `ete init` on the real models now finishes and always yields a runnable
engine, or fails loud. The chunked emitter writes `engine.js` **before** the
cell-level dependency graph (which it depends on nothing for), and that graph is
now **streamed** to disk instead of built as a full in-memory map + serialized
string — the allocation that OOM-killed the parser on multi-million-cell models.
`ete init` gained a configurable `--timeout` (default 1800s; the old fixed 10-min
cap killed legitimate builds), verifies `engine.js` landed after a fresh parse,
and emits `chunked/build-manifest.json` (#24): the locked canonical artifact set
+ a stable `contentHash` over the identity artifacts (engine.js, sheets/,
_ground-truth.json, manifest.json) so a downstream consumer pins a build and
detects drift. New `npm run test:runnable` + CI step.

**Next (Mippy oracle, per HANDOFF):** P2 #25 (pin value-bearing MIP cells as
named-outputs), P2 #26 (`_fn-fallbacks.json` correctness gate), then the
supporting golden-master CI + refiner UW-Comparison fix + cluster-once eval.

## Status: PE-model accuracy benchmark + eval fixes — in progress 2026-05-28

Standing up the multi-wave "next wave" effort on `feat/next-wave`, keystone
first: a repeatable accuracy + efficacy benchmark over the real PE models
(`benchmarks/bench.mjs` → `benchmarks/BASELINE.md`, aggregate-only).

**Baseline:** Model A 84.3%, Model B 85.5% on standalone sheets; the
17-sheet circular cluster and the 190 MB PP&E sheet are skipped pending deeper
fixes. Landed alongside: a **Windows crash fix** in `per-sheet-eval` (bare
absolute ESM import → `pathToFileURL`; it had silently zeroed accuracy on
Windows/real engines and wasn't in CI — now guarded by `test-per-sheet-eval`),
a `--skip-clusters` flag, and the **searchByLabel lazy-numerics** wave
(query/carry stop scanning the full GT for adjacent values).

**Wave status (this branch):**
- ✅ Keystone benchmark + baseline; ✅ searchByLabel (query/carry).
- 🔜 Accuracy blockers — now precisely diagnosed: single-pass orchestrator eval
  for the 17-sheet cluster (it's re-run once per member today), large-sheet eval
  (190 MB PP&E > 150 MB limit), array formulas (the Headcount sheet lives inside
  the cluster). `_computed-values.json` is a GT copy — not an accuracy source.
- 🔜 Manifest-pipeline perf (generate detectors / maps cell-types on ~6M cells).
- 🔜 Polish→Publish (lib/ unit tests, npm publish prep, example project,
  contributing guide).

## Status: single GT parse per init — landed 2026-05-28

`ete init` now loads the ground truth once and shares the parsed object across
the whole manifest pipeline — generate → refine → doctor → maps — instead of
each step re-reading and re-parsing the full ground truth from disk (up to four
parses of a 200 MB+ file; ~3.6 s per parse on the real PE models). This was
the dominant cost of init on large models and the real driver behind the
"~2.5 min" refine loop. The GT is read-only in all four consumers, so a single
shared object is safe; each command falls back to loading the GT itself when no
injection is supplied (standalone `ete manifest …` is unchanged). New
`test-init-shared-gt.mjs` (8) proves each consumer honors the injected GT and
never touches disk for it.

This closes the refine-perf thread opened by the label-index work; Tier B (the
row-values artifact) was measured on the real ~200 MB models and deprioritized
(they're dense-label, so it'd be only ~1.6× while inflating output ~60% — see
ROADMAP). Remaining follow-up: apply the same lazy-numerics path to
`searchByLabel` (`query`/`carry`).

## Status: refine label-index optimization — landed 2026-05-28

`ete manifest refine` now sources labels from the parser's `_labels.json`
(O(labels), no full GT scan) and resolves same-row numerics lazily by probing,
instead of bucketing every numeric in the workbook up front (`buildIndex`). The
giant unlabeled grids that dominate big models — the very thing that made refine
slow — are no longer touched. Behavior-preserving (rankings unchanged; suites
green). New `tests/cli/test-refine-label-index.mjs` (14) proves consumption +
parity. The remaining cost floor is the ground-truth JSON parse; lifting that
would need a parser-emitted row-values artifact (Tier B). The same lazy-numerics
treatment is still open for `searchByLabel` (the `query`/`carry` path), and the
per-command GT re-parse multiplier in `init` (generate → refine → doctor → maps
each reload the GT) remains a separate follow-up.

## Status: Continuous integration — landed 2026-05-28

`.github/workflows/ci.yml` runs the full test matrix (Rust build + 11 unit
tests, the 7 JS suites = 132 assertions, and smoke/depgraph/engine/slimming)
on `ubuntu-latest` + `windows-latest` for every push/PR to `main`. Nothing
guarded the suite on push before. First item of the Polish→Publish phase
checked off; the rest (lib/ unit tests, npm publish prep, example project,
contributing guide) remain.

## Status: Artifact slimming (Round 2, part 2) — landed 2026-05-28

`ete init`'s default `chunked/` output no longer ships the large
debug/intermediate artifacts (request #8). The cell-level
`dependency-graph.json` (ranges expand → the biggest file) is consumed for its
closures, baked into the named maps, then deleted; the sheet-level `_graph.json`
(read by nothing) is deleted; and the Rust parser no longer writes the root
`model-map.json` (600+ MB) in `--chunked` mode at all. `--emit-debug` (on both
`ete init` and the parser) retains them. The load-bearing `_ground-truth.json`
that must ship is now compact JSON (≈half the size). New `npm run test:slimming`
(13). The high-value data is preserved as the closures inside the named maps.

**Still open in Round 2:** engine perf (#9: base-case hot cache, partial
recompute for the grid generator). MIP gating (#7) remains a model-owner
question.

## Status: Dependency graph + closures (Round 2, part 1) — landed 2026-05-27

The Rust parser now emits `chunked/dependency-graph.json` (cell-level forward
edges, ranges expanded), and `emitManifestMaps` uses it to attach
`dependsOnNamedInputs` (named outputs) + `affectsOutputs` (named inputs) — the
closure that lets a consumer invalidate only affected outputs on a what-if.
Fixed a real `extract_refs` bug: same-sheet ranges were truncated to the
post-colon endpoint (`SUM(A1:A3)` saw only `A3`), so interior named inputs were
invisible to the closure; `is_cell_ref` now accepts ranges. New
`npm run test:depgraph` (11) + closure unit tests.

**Still open in Round 2:** `model-map.json` / `dependency-graph.json` slimming
(sharding or zstd; `--emit-debug` gating, #8) — the full graph can be large on
big models. Engine perf (#9: base-case hot cache, partial recompute for the
grid generator). MIP gating (#7) remains a model-owner question.

## Status: Engine run() API — telemetry + override pinning + strict (Round 1, Rust half) — landed 2026-05-27

`generate_orchestrator` now emits a `run()` that returns `meta` (convergence
telemetry: converged/iterations/maxDelta/perSheetIterations/clusters/elapsedMs)
and `unknownOverrides` (override cells not read by any formula), with
`run(inputs, { strict: true })` throwing on unknowns. Additive return — existing
`values`/`kpis` unchanged. Building it exposed and fixed two latent correctness
bugs: input-cell overrides were clobbered by the sheet literal pass (now pinned
via `ComputeContext._locked`), and the cross-sheet cluster loop falsely
"converged" after one iteration (undefined→number now counts as a change). New
`npm run test:engine` (21 assertions). Request #4 (typed returns) is satisfied
by the JS-half `cell-types.json` sidecar — Option A (breaking) not pursued.

**Next (Round 2):** dependency-graph artifact (unblocks `affectsOutputs` +
read-set override validation), `model-map.json` slimming, engine perf. MIP
gating (#7) is a model-owner question, not a pipeline bug.

## Status: Downstream contract maps (Round 1, JS half) — landed 2026-05-27

A production consumer (Mippy) integrating the chunked engine had no
build-time manifest of which cells hold the named outputs/inputs, so it ran
the engine (9 min/call) to discover them — and shipped a silent-`NaN` bug
from guessing wrong. `ete init` now emits three small artifacts into
`chunked/`: `named-outputs.json` (the downstream contract: name → cell +
base-case value, defined-name-authoritative), `named-inputs.json`
(defined-name cells read by ≥1 formula), and `cell-types.json` (label vs
number vs empty; disambiguates real-0 from never-computed). New
`lib/manifest-maps.mjs` + `ete manifest maps` subcommand; new
`test-manifest-maps.mjs` (40 assertions) in `npm test`. Also fixed
`loadWorkbook` (SheetJS ESM has no fs binding → read via buffer).

**Next (Round 1, Rust half):** convergence telemetry, strict/`unknownOverrides`
overrides, and typed cell returns in `generate_orchestrator`
(`pipelines/rust/src/chunked_emitter.rs`). Then Round 2: dependency-graph
artifact (unblocks `affectsOutputs` + read-set validation), `model-map.json`
slimming, engine-perf.

## Status: Security audit pass (v0.2.0) — landed 2026-05-07

External security review (PR #13) closed five concrete attack primitives:
shell injection in `ete init`, prototype pollution in three `setNested`
variants, code injection in generated child-process scripts, path
traversal in `--template`, and a remote arbitrary-file-execution
primitive in the monitor WebSocket. `xlsx` upgraded 0.18.5 → 0.20.3
(via SheetJS CDN; closes CVE-2023-30533 + CVE-2024-22363, neither fix
on npm). Package bumped to v0.2.0 to mark the post-audit baseline. Test
suite: 397/397 green. See `CHANGELOG.md` for the full list and the
non-blocking follow-ups.

## Status: Platform upgrades from real-world rebuild — landed 2026-04-20

Post-rebuild reflection pass found 5 more gaps worth closing. All landed
in the same PR branch: flat-MOIC hurdles in the parametric waterfall,
rollup-sheet preference in auto-detection, `ete init --reuse-parse` for
fast manifest iteration (68s → 2s on big models), manifest-level
`invariants` with doctor enforcement, and generalized sibling-sheet
aggregation now applied to debt (multi-facility exit balances) in addition
to carry. Ship-ready suite 78 → 97 (+19). Full test suite 378/378 green.
Downstream consumer app still validates clean against its own pre-deploy check.

## Status: Aggregate cell refs — landed 2026-04-20

A real end-to-end downstream engine rebuild exposed the one remaining
"quiet wrongness" path after the ship-readiness pass: multi-class promote
structures. A PE fund model's carry was split across two investor-class
sheets (`GP Carry (1.5%)` + `GP Carry (1.25% TRS)`), and the single-cell
`carry.totalCell` schema could only capture one of them — `ete carry`
returned $28.3M instead of the consolidated $49.3M. Closed by teaching
`resolveCell` to accept aggregate `{ cells, op }` refs, teaching
`detectCarry` to auto-aggregate sibling sheets whose names differ only in
a parenthesized qualifier, and updating refiner + doctor + `ete carry` to
handle aggregates end-to-end. Suite: 378 green (63 ship-ready + 15 new
aggregate-category assertions + 132 use-case + prior layers).

## Status: Ship-readiness pass — landed 2026-04-17

A live accuracy verification on two real PE platform models found that the
CLI's parametric carry was ~3× the model's own computed carry, exposing a
cluster of silent refiner bugs. All seven fixed and gated by a 63-assertion
ship-ready test battery: array-path corruption in `setNestedField`,
zero-valued candidate preference, restated-copy cell shadowing (KU88 vs
D88), doctor zero-value flags, `ete carry` model-first routing, template
hints threading into refiner column selection, and token-fallback for
non-contiguous label substrings. Total suite: 363 green, Rust smoke 78/78.
End-to-end verified: `ete carry --ownership 0.06` returns $2.5M (A-1) /
$4.7M (A-2) — matching the models' own Total Carried Interest cells.

## Status: Post-SESSION_LOG-4 workflow pass — landed 2026-04-17

A third end-to-end run against two PE platform models surfaced a workflow
stall (60+ cell-coordinate probes trying to pick a scenario column) and a
cluster of auto-gen/auto-apply friction points. All closed in this pass.
Key changes: `--search` is literal by default, `--case <col>` picks a
scenario column, `ete init` soft-fails (quarantines suspect fields), the
refiner prefers summary tabs and accepts "Peak Net Equity" / "Gross MOC",
templates can auto-apply on strong signature matches, and `ete carry`
falls back to label search. `skill/SKILL.md` now opens with an explicit
anti-stall "never walk cell coordinates" rule. See `CHANGELOG.md` for the
full list.

## Status: V4 AI Interface Layer — landed 2026-04-17

V4 reframes the tool as an **AI-navigable index over complex Excel models**
covering ~20-30 PE stakeholder use cases. All six V4 phases landed: label
index, compact output, `ete explain`, `ete eval` (chunked-engine bridge),
doctor-gated init + model-family templates, and the breadth pass (new
detectors + manifest schema + `ete extract`). See `PLAN_V4.md` for design
and `CHANGELOG.md` for the complete list.

## Status: V3 Implemented + Manifest Robustness Pass + Carry Command (2026-04-16)

The CLI, manifest system, and skill layer are in production use. Two
production-driven improvement passes on 2026-04-16 closed real pain points
surfaced by live end-to-end sessions against two 76–83 MB PE platform
models — see CHANGELOG.md for the complete list.

**AM pass** — manifest robustness: value-range validation at auto-gen time
(blocking the cascade where a label artifact like `5` produced a 7.2M× MOIC),
equity class dedupe, segment time-series check, `manifest doctor`/`set`
subcommands, `--terse`/`--quiet` flags, redundant `model-map.json` cleanup.

**PM pass** — carry + label hardening: `ete carry` command wrapping
`lib/waterfall.mjs` (collapses the 7-min manual investigation to one CLI call),
`carry.totalCell` detector refuses pre-carry CF labels, scenario-block
detection for stacked PE promote sheets, skill docs teach new sessions to
validate the manifest before trusting it and to reach for Python over the CLI
for bulk scans.

## Objective

Build an open-source toolkit that converts complex financial Excel models (.xlsx) into JavaScript computation engines. Two pipeline options: a fast Rust transpiler for large models, and a Claude-reasoning approach for smaller ones. Unified blind eval validates both.

## Architecture

```
excel-to-engine/
├── pipelines/
│   ├── rust/                    # Fast: Rust parser + formula transpiler + chunked compilation
│   │   ├── src/ (8 modules)    # parser, transpiler, AST, dependency, chunked_emitter, etc.
│   │   └── tests/              # Synthetic model smoke test (78/78 = 100%)
│   └── js-reasoning/            # Original: Claude reads Excel → reasons → writes engine.js
│       ├── skill/SKILL.md       # 4-phase pipeline skill
│       ├── templates/           # Engine, eval, dashboard templates
│       └── eval-framework/      # generate-control, compare-outputs
├── eval/                        # Unified eval tools
│   ├── blind-eval.mjs           # Blind Claude API eval (50/50 on mid-size model)
│   ├── generate-questions.mjs   # Question generator from ground truth
│   ├── analyze-report.mjs       # Failure analysis + fix recommendations
│   ├── iterate.mjs              # Auto-iteration container loop
│   ├── Dockerfile, run.sh       # Containerized overnight runs
│   └── pipeline.mjs             # Pipeline orchestrator
├── lib/                         # Shared JS libraries (irr, waterfall, calibration, etc.)
└── tests/synthetic-pe-model/    # Integration test
```

## Completed Phases

### Phase 1 — Core Libraries (DONE)
- [x] `lib/irr.mjs` — Newton-Raphson IRR with bisection fallback + XIRR
- [x] `lib/waterfall.mjs` — PE distribution waterfall (American + European)
- [x] `lib/calibration.mjs` — Auto-calibration with ratio/offset modes
- [x] `lib/sensitivity.mjs` — Surface extraction, slope comparison, multi-point calibration
- [x] `lib/excel-parser.mjs` — Cell reading, sheet fingerprinting, year detection, field mapping

### Phase 2 — Sheet Intelligence (DONE)
- [x] Sheet fingerprinting with 50+ financial term aliases
- [x] Year detection, multi-year extraction, escalation detection
- [x] Asset classification (leased/managed)
- [x] Sensitivity surface validation (40% → 100% at breakpoints)

### Phase 3 — Rust Parser + Transpiler (DONE)
- [x] 8 Rust modules: parser, formula_ast, transpiler, dependency, circular, model_map, sheet_partition, chunked_emitter
- [x] ~60 Excel functions transpiled (SUM, IF, VLOOKUP, INDEX/MATCH, IRR, SUMIF, etc.)
- [x] Tarjan SCC for circular reference detection + convergence loops
- [x] Chunked compilation: per-sheet .mjs modules (solves OOM for large models)
- [x] Rayon parallelization (3.8x speedup)
- [x] Synthetic model: 78/78 (100%)

### Phase 4 — Eval System (DONE)
- [x] Blind eval with Claude API tool_use (50/50 = 100% on mid-size model)
- [x] Question generator from ground truth
- [x] Analysis reporter with fix recommendations
- [x] Auto-iteration container (Docker, Mac + Windows compatible)
- [x] Per-sheet eval for memory safety on large models
- [x] Resource monitoring in terminal

### Phase 5 — Repo Restructure (DONE)
- [x] Two clean pipelines: `pipelines/rust/` and `pipelines/js-reasoning/`
- [x] Unified eval in `eval/`
- [x] All proprietary references scrubbed
- [x] Merged to main

## Current Phase — Accuracy Improvement

### Best Results So Far
| Model | Sheets | Cells | Per-Sheet Eval | Blind Eval |
|-------|--------|-------|---------------|------------|
| Synthetic | 3 | 78 | 100% (78/78) | 100% (10/10) |
| Mid-size | 38-60 | 1.7M | 70-76% | 100% (50/50) |
| Large | 82 | 3.7M | 87.6% (2532/2890) | In progress |
| Very Large | 21 | 6M | 71.4% (24K/34K) | 98% (49/50) |
| 6 production models | 2-60 | 5.7K-5.8M | — | 99.3% (149/150) |

### Fixes Applied (latest)
- [x] INDIRECT dynamic references + ROW()/COLUMN() context
- [x] ExcelDateTime → numeric serial values
- [x] Security: template literal injection, API key isolation, non-root container, safe .env
- [x] EOMONTH/EDATE numeric coercion
- [x] Convergence: 200 iterations, 1e-6 tolerance, stale detection

### Active Improvement Areas
- [ ] Array formulas (FILTER, UNIQUE, CHOOSEROWS) — Headcount still ~18%
- [ ] Circular cluster convergence — large circular clusters (17+ sheets) need orchestrator eval
- [ ] Large sheet eval — Owned Asset PP&E (190MB module) can't be evaluated
- [ ] Wide sheet column disambiguation for blind eval

## Next Phase — Polish + Publish
- [x] Unit tests for all lib/ modules — `tests/lib/test-lib.mjs` (43: irr,
      waterfall, calibration, sensitivity), in `npm test`/CI (2026-05-28)
- [x] GitHub Actions CI — `.github/workflows/ci.yml` (ubuntu + windows; Rust
      build/tests + JS suite + smoke/depgraph/engine/slimming), landed 2026-05-28
- [ ] npm publish preparation
- [ ] Example project with synthetic data
- [ ] Contributing guide

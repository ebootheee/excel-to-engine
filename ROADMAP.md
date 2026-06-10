# excel-to-engine — Roadmap

## Now — post-v0.3.1: fidelity DONE to the floor; next = convergence measure + scale (2026-06-09)

**v0.3.0 + v0.3.1 shipped same day.** Sweep progression (all 17 cluster sheets, fresh warm-GT
seed, one pass each): pre-#62 **1/17 clean / ~5.9M** → #62 9/17 / 391k → #64 11/17 / 383k →
**#67 (v0.3.1): 14/17 EXACT, 266 residual (−99.995%)** — every named output's sheet at ZERO;
the 266 = the documented fidelity floor (250 Debt cells downstream of `=0` gates on half-ULP
GT dust like −5.96e-8, + 16 sub-1e-6 jitter cells). #47/#57/#66 closed.

Next, in order:
1. **Re-run the full-cluster convergence measure (#33)** — now unblocked: with 14/17 exact the
   warm-seeded fixed point should hold (~2 passes × ~12 min). Use the lean probe
   (`engines/a1-after/diag-cluster-converge.mjs`) first; then a cold `eng.run()` overnight for
   the true pass count. Watch the Debt float-dust gates — they may inject small churn.
2. **Slim per-sheet-eval's cluster child** — single GT copy (parse directly into ctx), and
   never size-skip a CLUSTER member (the default `MAX_SHEET_SIZE_MB=150` silently drops
   monster modules from the convergence loop). Target: canonical harness fits 31 GB.
3. **Row-chunk monster modules at emit (#46/#33)** — the 609 MB fatal alloc on A-2 is the
   UTF-16 decode at module import (~2× the 305 MB source); chunked sub-modules fix #46, shrink
   per-pass working set, and serve the #33 row-chunk direction. Then the VM measurement day
   (canonical full-cluster eval + ADR-026 cone re-gate) — see the #33 thread.
- Cosmetic follow-ups: `TEXT()` format codes (labels only); `CELL("filename")` → "null" label.
- #54 remediation unblocked from the returns cone (A-1 fallbacks file is empty).

The lock-grade cluster non-convergence (T-076) was **multi-root** (div-by-zero leaking ±Inf/NaN). **ALL
in-repo div-by-zero roots are merged**: **#55** IFERROR-treats-Infinity, **#56** per-sheet-eval
`_sheetConvergence`, **#57 Commit A** transient-tolerant convergence (PR #58), **#59** per-sheet-eval
lockstep NaN-fill, **#60** `_div` + NaN-propagating reducers (`fdf1b1d`), **#61** churn-cap + divergence
detector (`fdf1b1d`). All synthetic-proven with negative controls; full `npm test` green.

**The real A-1 run (2026-06-09) reframed #57** — see PLAN.md + the #57 thread:
- **#60 real-A-1 gate PASSED** — 13/23 named outputs unchanged & matching GT; the 10 it moved
  (`totalCarry`, `equityBasis`, …) were already-wrong silently-dropped `#DIV/0!` zeros, now honest NaN.
- **The blocker is STRUCTURAL, not convergence:** from a warm GT seed the returns denominators
  (`Equity!AN122`, `GPP Promote!D88`) compute `0` where Excel has nonzero → `#DIV/0!`. Likely a #47
  date-keyed `SUMIFS` miss or a #54 unsupported-fn stub. **Next: trace the `#DIV/0!` feeding those cells.**
- **Scale wall (#33/#46):** the 17-sheet cluster is ~11–13 min/PASS → full convergence (~10 hrs) is
  infeasible on a 31 GB box (both per-sheet-eval runs timed out). The convergence machinery is correct
  (synthetic-proven); making the real recompute feasible is the separate perf track.

## Earlier — two open threads (2026-06-05) — see `docs/HANDOFF-lite-and-cone.md`

1. **Re-gate the real-model scoped cone (ADR-026 Tier 2) — re-gate was VACUOUS; label STAYS.** The
   Wave-2 A-1 cone gate failed *only* because of the `COL$ROW` `* `COL`` transpiler NaN bug, fixed on
   main (PR #43). The 2026-06-06 re-gate (`engines/_scratch_probe/cone-gate.mjs`, input `GPP Promote!C108`
   → output `GPP Promote!KU159`) printed cone==engine==GT relErr 0.000 PASS — but **`KU159` is
   identically 0**, so every verdict is a vacuous `0==0` and proves nothing; the lever what-if was
   inconclusive and the full-engine override recompute OOM'd at ~7.2 GB. **Do NOT lift the EXPERIMENTAL
   label on `init --emit-cones`.** A real re-gate needs (a) a scope output that is NONZERO at base AND
   varies with the lever, and (b) a base-case-only cone-vs-engine compare (the override recompute OOMs →
   needs a memory-bounded path). Wave-3: speed the ~20 min/16 GB cone build (CSR cache); port L1
   cell-level cycle resolution into `chunked_emitter.rs`; #33 row-chunking.
2. **Build the "lite" package (ADR-027) — Phases 1–7 LANDED.** Tier-0 closed-form (`lib/lite-tier0.mjs`)
   → driver-scope → Tier-1 surrogate (cascade samples, breakpoint escalation) → recommender → shared
   provenance/handoff (`lib/lite-provenance.mjs`) → **Phase 7 FRONT DOOR: `ete lite` (`cli/commands/lite.mjs`)
   + `skill/lite/SKILL.md` + the day-in-the-life e2e (`tests/cli/test-lite-e2e.mjs`).** Next: generalize
   `emitTier0` beyond the single GPP-Promote fixture (manifest-derived tier GP cells); lift the cone
   (Tier 2) once ADR-026 re-gates; named-output-keyed lever derivation for non-PE model families.

## Earlier — Lock-grade engine for the Outpost A-1 MIP cone (2026-06-01)

Make the converted engine a legal reproducibility artifact for the Outpost A-1 MIP.
Two gaps, both closed in code on `feat/lockgrade-cone` and confirmed on the real model:
- **Returns transpiled (no `_fn` stubs):** XNPV / FILTER / MINIFS / MAXIFS + `_xlfn.` /
  `_xlfn._xlws.` prefix-stripping; a fresh real parse → **0** stubs of the four in the
  returns cone (`Lease Amortization!AO87`, `Equity!AN234`, `GPP Promote!G24`, …).
- **Single-pass cluster orchestrator:** the 17-sheet returns cluster converges once and
  every member is scored (was `--skip-clusters`'d → cone unmeasured).
- **NaN-guard** convergence (T-076 honest non-convergence contract); diagnosis: waterfall
  fragility, not the override bug PR #37 fixes.

**Wave 2 (2026-06-03, branch `feat/lockgrade-wave2`) — cone-rebuild enablers BUILT:**
- **GT-seed scoping — DONE.** `computeClusterSeed` + `GT_SEED_SCOPE` seed only the cluster's
  external reads (range refs expanded via the #32 index), so the cone converges without the
  8 GB / 900 s OOM. Default `cluster` scope warm-starts own cells (avoids the cold-start NaN);
  `external` is the strict cold-start; OFFSET/INDIRECT clusters keep the full seed.
- **Sampled-delta convergence — DONE.** Dropped the per-iteration full-ctx `JSON.stringify`
  (~8.8 min/pass → O(sample)/iter). Adversarially reviewed (9 findings fixed); FoF NAV (#)
  + #25 per-class value-bearing outputs shipped alongside.

**Wave 2b (2026-06-03, branch `feat/transpile-averageifs`) — rebuilt + measured A-2:**
- **AVERAGEIFS transpiled — DONE.** A-2 rebuild showed net MOIC/IRR still resolving through
  `AVERAGEIFS` (×3103 — last fn after wave 1; outside the cone on A-1, inside it on A-2).
  Transpiled it → A-2 rebuild now has **0 `_fn()` fallback cells** and **no output through a
  stub** (function-level `--assert-no-fallbacks` AFTER green on the real A-2).
- **GT-seed scoping measured on the real model — validated but not sufficient.** Cut the cluster
  seed 23.6× (6.06M → 257K), but the cone still OOMs at 600s: the 17 cluster sheets are **776 MB
  of JS modules**, so loading them exceeds the 8 GB heap before any seed. The seed was never the
  binding constraint for this dominant cluster.

**Next (to actually flip lock-grade — the wall is now the modules, not seed or stubs):**
- **Scoped-subgraph transpile (#22 / T-078, ADR-026) — ✅ BUILT (Wave 2, 2026-06-04, `feat/engine-perf-wave2`).**
  Emit/run ONLY the input→output cone (the cells between {exit year, exit value, hurdle} and
  MIP/returns), constant-folding the rest, so each pass touches thousands of cells across a few-MB
  module, not 776 MB of 17 sheets — the unblock for the cone measurement AND the MIP what-if grid.
  - **DELIVERED:** `lib/cone-emit.mjs` (`buildCone` → `chunked/cones/<scopeId>.mjs`, C3 `run()`
    contract) over `lib/scope-plan.mjs` (`buildScopePlan` + new `activeOrder`/`buildFullPlan`),
    lifting per-cell exprs from the emitted sheet modules (`lib/cell-exprs.mjs`). Wired into `ete init
    --emit-cones`. Measured on the midi fixture (`--compare baseline`, parity OK): **scoped == full
    within 1e-6, ÷33,334 cells/pass, 855× faster, 898× smaller module** — beats the Tier-3 targets.
    L1 (`buildFullExecutor` / efficacy `cycle` variant) proves cell-level cycle resolution
    (÷33,334 cells/pass) as the reference for the Wave-3 Rust port.
  - **NEXT (Wave 3):** validate the cone at A-1 scale (the L0 `buildScopePlan` real-graph timing was
    measured separately; build a real MIP cone next), port L1 into `chunked_emitter.rs` so the default
    engine is cell-level, and pursue #33 (row-chunk monster sheets) as defense-in-depth.
  - **MEASURED (2026-06-03, `benchmarks/analyze-cone.mjs` on the real A-1 cell graph):** true largest
    cell cycle **2,992 cells (0.054%)**, all cycles 10,684 (0.19%), output cones median **0.38%** /
    max 66% — the 17-sheet cluster is **99.8% artifact**, so the active subgraph for a MIP what-if is
    tiny. Design: `docs/adr/ADR-026-scoped-subgraph-transpile.md`; build plan + harness in
    `docs/PLAN-engine-speed.md`. Confirmed: `runScoped` is sheet-level (can't beat the 776 MB wall)
    → cell-level was required, and is now built.
- Row-chunk the monster cluster sheets (#33) as the complementary lever (Owned Asset PP&E 190MB,
  Future Owned Acquisitions 144MB, Technology 114MB, Debt 100MB).

## Now — Analyst usability + coding-agent handoff (2026-05-29)

Make the toolkit genuinely usable by a non-technical finance analyst (PE/VC/RE/
IB/corp-dev) working through an AI assistant, end-to-end to a web-app handoff.

**Wave 1 — done (branch `feat/analyst-onboarding`):**
- Coding-agent handoff bundle from `ete init`: `chunked/INTEGRATION.md` +
  runnable `chunked/example.mjs`; `lib/verify-engine.mjs` (base-case fidelity).
- Detector accuracy: annual periodicity; exit-multiple prefers Exit over Entry;
  carry total prefers dollar over the rate fraction (+ doctor guard).
- Onboarding: README reframe, `GETTING_STARTED.md`, guided play in `skill/SKILL.md`,
  cross-platform `check-env`, `npm run build:parser`.
- `tests/personas/` synthetic-model harness + `tests/cli/test-onboarding.mjs`.

**Waves 2–4 — done:** persona-matrix simulation (12 personas × 3 rounds);
model-family-aware summary + coverage; fund/covenant outputs + input UI-metadata
+ durable closures in the contract; cap-rate doctor; self-refreshing `manifest
set`; delta-cascade honesty guard; exit-value labeling + Net-dash explainer.
Summary segment/EBITDA clarity fixed (Wave 1–2). **Capstone acceptance scenario
PASSED** (`ANALYST_UX_REPORT.md`).

**Wave 5 — done (measured 1/12 → 7/12, 2026-05-30):** five Phase-0 fixes — schedule
scalar `cell`; live `=IRR()`; `chunked/` auto-resolve; asset-class detection; lever
dedup. avg A5 4.42→4.58, C4=true ×12.

**Wave 6 — done (measured 7/12 → 8/12, 2026-05-31; A5 perfect 5.00):** per-family
HEADLINE blocks + detection — `corporate` family + EV/Equity headline; credit
Lender-Returns block + the "$2 debt-at-exit" ratio-cell fix; saas "x ARR" + split
Revenue/ARR CAGR; infra returns-led headline (Project/Equity IRR + DSCR); + 6
adversarial-review fixes. credit + saas flipped; corp/infra A4/A7 lifted; all 12
`accuracyVerified=true`. Scoreboard in `tests/personas/BENCHMARKS.md`.

**Wave 7 — done (measured 8/12 → 12/12, 2026-05-31; FIRST CLEAN SWEEP):** the 4 remaining
fails (re-debt, infra, corp, pe-buyout) all flip; no passing persona regresses. avg A7
3.83→4.08, C5 4.92→4.50, A5 5.00→4.92 (one A5 slipped on judge noise; all 12
`accuracyVerified=true`). Three rolling commits: (1) schedule-aggregation semantics — never
SUM a ratio series, per-year DSCR/debt-yield/LTV, Facility-Balance roll-forward bound,
unit-aware `extract`; (2) suppress derived/backsolved dials + format outputs by concept
(cap-rate/yield → `%`, not `"0.09x"`); (3) model-type-aware labeling (`pe_buyout`/`buyout`
lens, corp `Forecast`/`P&L Summary`, drop "Platform EBITDA"). Plus scoped family levers
(infra Opex/Amort, saas GrossChurn, re-debt EntryLTV). A 4-reviewer adversarial-review
workflow's `fix-now` findings were all fixed before merge. Scoreboard in
`tests/personas/BENCHMARKS.md`.

**Next — durability + depth (gate is clean; from the Wave 7 run synthesis):**
1. **Net-of-fee returns** where the model has the inputs — derive a clearly-labeled Net
   IRR/MOIC from gross + carry + fees (the single most-cited gap; lifts LP-facing A7 4→5).
2. **Echo the deal/workbook name** instead of the generic "model" placeholder in the summary
   + INTEGRATION.md title.
3. **Name-keyed `run()` overload** so apps can call `run({ ExitMultiple: 14 })` without
   hand-mapping each human name to its `Sheet!A1` cell.

<!-- superseded by the Wave 7 result above (kept for history):
**Wave 7 — was-next (the 4 remaining fails, from the run synthesis — all three for 12/12):**
1. **Schedule-output aggregation semantics** — never SUM a `fraction|percent` series
   (use terminal/avg); emit the per-year debt-balance/DSCR series into named-outputs;
   make `extract --type debt_balance` find "Balance Roll-Forward" sheets. *Flips re-debt;
   removes the fabricated `$1` freeCashFlow (a ratio summed as dollars).*
2. **Suppress derived/backsolved cells as what-if dials + format outputs by unit** —
   `equityBasis` (backsolved) must not be a slider (a higher exit-yield demo inflates
   MOIC 6.7x→41.7x); cap-rate/exit-yield outputs format as `%`, never `"0.09x"`. *Flips
   infra; lifts re-valueadd/credit.*
3. **Model-type-aware labeling** — `pe_buyout` vs `pe_fund`; corp 3-statement → budget
   lens ("Forecast" not "Exit", P&L-led, revenue/opex/margin levers); drop "Platform"/
   "Segments"-over-P&L jargon. *Flips corp + pe-buyout (A4).*
Plus scoped family levers (infra Opex/Amort, saas GrossChurn, re-debt EntryLTV — generator
`defineName`s + DSCR/LTV promoted to outputs so the closure tracks them).
-->

**Open (documented in `tests/personas/FINDINGS.md`, not benchmark-blocking):**
- Engine fidelity: intra-sheet topological ordering so cross-row "staircase"
  schedules compute correctly — only the standard column=time / row=metric layout
  is evaluation-safe today. Rust emitter; gate with smoke + engine suites (Mippy
  depends on `run()`).
- Multi-sheet IRR so fund/infra returns aren't static literal cells.
- Per-year time-series outputs (debt amortization / covenant series) for the
  credit/debt-monitor personas; non-defined-name driver levers (corporate budget).
- Model-type classification (credit/FoF/search → "saas"); the summary lens
  compensates for display but the type label is cosmetically wrong.
- `npx ete` / `npm link` ergonomics so users type `ete` not `node cli/index.mjs`.
## Now — Real-model `ete init` completes end-to-end (#32 done, #33 partial, 2026-05-29)

Regenerating the gitignored Outpost A-1/A-2 engines (after the #22 walls) surfaced
the last two blockers to a clean **full `ete init`** (parser + JS manifest pipeline)
on the real models. Both addressed:

- **[#32] dependency-graph 37 GB → ~0.5 GB. ✅ DONE.** The cell-level graph
  expanded every range to interior cells (`SUM(A1:A1000)` → 1000 edges) → 37 GB /
  ~7 min on A-1, and `ete init` then `JSON.parse`d it → OOM. Now emits **compact
  range tokens** (`extract_refs_ranges` / `RangeMode::Keep`, schema v2); 504 MB
  (A-1) / 532 MB (A-2). The JS closure BFS (`computeOutputClosures`) expands tokens
  lazily via column-indexed binary-search interval queries — identical closures,
  no materialization; graph read once; both consumers share one pass. `ete init`
  re-execs with a 12 GB heap for the ~7.4 GB closure-bake peak.
- **[#33] streamed module writer. ✅ DONE (emit half).** `write_sheet_module<W>`
  streams each sheet module straight to its file instead of `Vec<String>` + join
  (~2× a 190 MB monster transiently). Emit peak ~2.4 GB.
- **[#33] returns-cone shrinking — OPEN (deferred, needs cluster-breaking).** The
  other #33 direction can't be done by row-chunking alone: the returns live in a
  **17-of-20-sheet circular cluster** that loads atomically (incl. all 3 monster
  modules), so `--lazy-engine` cone scoping can't shrink the returns load until the
  cluster is broken/scoped. That's correctness-sensitive and coupled to
  **cluster-once eval** — tracked there, not rushed (the eager engine Mippy
  consumes must stay stable).
- New `scripts/verify-contract.mjs` — machine-checks a build against the Mippy
  consumer contract (layout, `contentHash`, runnable engine, value cells + closures,
  fallback audit) without running the full engine.

[#32]: https://github.com/ebootheee/excel-to-engine/issues/32
[#33]: https://github.com/ebootheee/excel-to-engine/issues/33

## Now — Engine-integration contract (Mippy request, 2026-05-27)

Surfaced by a production consumer wiring the chunked engine into a Tier-1
RPC service. Round 1 split into a low-risk JS half (done) and a Rust half
(`generate_orchestrator` in `pipelines/rust/src/chunked_emitter.rs`, queued).

**Done (JS half, 2026-05-27):**
- `named-outputs.json`, `named-inputs.json`, `cell-types.json` emitted by
  `ete init`; `ete manifest maps` to regenerate. See CHANGELOG.

**Done (Rust half, 2026-05-27):**
- `engine.run()` returns `meta` (convergence telemetry) + `unknownOverrides`;
  `run(inputs, { strict })` throws on unknowns. Additive return.
- Bonus fixes the telemetry exposed: input-cell overrides were clobbered
  (now pinned via `ComputeContext._locked`); cross-sheet cluster loop
  falsely "converged" after one iteration (undefined→number now a change).
- `npm run test:engine` (21 assertions).
- Request #4 (typed returns) satisfied by the `cell-types.json` sidecar;
  the breaking Option A (typed `values`) deliberately not pursued.

**Round 2 — done (part 1, 2026-05-27):**
- **`dependency-graph.json`** (cell→cells forward edges, ranges expanded) +
  `dependsOnNamedInputs` / `affectsOutputs` closures on the named maps
  (request #3/#10). Fixed an `extract_refs` same-sheet range-truncation bug
  along the way. `npm run test:depgraph`.

**Round 2 — done (part 2, 2026-05-28):**
- **Artifact slimming (request #8)** — default `chunked/` output drops the
  large debug/intermediate artifacts: `dependency-graph.json` (consumed for its
  closures, then deleted), `_graph.json` (read by nothing), and the root
  `model-map.json` (no longer written by the parser in `--chunked` mode).
  `--emit-debug` retains them. `_ground-truth.json` (load-bearing) is now
  compact JSON. The high-value closures live in the named maps regardless.
  `npm run test:slimming`.

**Round 2 — still open:**
- **Engine perf** — base-case hot cache + partial recompute for the grid
  generator; revisit only if parallel cloud workers prove insufficient. (#9)
- **MIP gating (request #7)** is a model-owner question, not a pipeline bug
  (engine faithfully reproduces an Excel base case of 0). Surface via a
  `requiredFor` field if/when named-inputs gains one.

## Now — Mippy calibration oracle (e2e agent's job, priority feature set)

The refined "fully ready for Mippy" target: make the full model a **reliable
calibration oracle** — runnable, with the MIP coefficients exposed as
named-outputs, and no stubbed value cells. Everything Mippy-specific stays in
Mippy. Order (issues on ebootheee/excel-to-engine; the Done line is the contract):

- **P1 · [#23] + [#24] — reliably emit a runnable `engine.js`. ✅ DONE
  (2026-05-28).** The chunked emitter writes `engine.js` **before** the
  cell-level dependency graph (independent of it), and that graph is now
  **streamed** to disk rather than built as a full in-memory map + serialized
  string — the OOM that was killing the parser. `ete init` gained a configurable
  `--timeout` (default 1800s), verifies `engine.js` landed after a fresh parse
  (fail loud, never a partial), and emits `chunked/build-manifest.json` (#24):
  the locked artifact layout + a stable `contentHash` over the identity
  artifacts. New `npm run test:runnable` + CI. See CHANGELOG/PLAN.
  **CORRECTION (2026-06-06 triage): the 2026-05-28 "DONE" covered only axes 1/2/5
  (always-emit-engine.js, stable layout, manifest one-location). Axes 3 & 4 were
  still open and landed 2026-06-06 (PR #48):** a consumer-spec `engineArtifactHash`
  (single sha256 over engine.js bytes then each `sheets/` file sorted by filename —
  matching the Mippy tamper guard; distinct from the internal `contentHash`) +
  `versionTag`/platform/class identity (version-free dir). **Remaining:** share a
  golden vector with the Mippy team + add a manifest invariant locking the algorithm.
- **P2 · [#25] — pin the value-bearing cells as named-outputs. ⚠️ MECHANISM DONE; real-model reconciliation pending.** **CORRECTION (2026-06-06 triage): the 2026-05-29 "DONE" was over-claimed** — only the per-year SCHEDULES + the value-cell pinning *support* had shipped; `detectEquity` never auto-populated proceeds/valuation/hurdle and there was no per-block MIP aggregator. Landed 2026-06-06 (PR #49): `detectMipValueCells` auto-detects per-class MIP/promote **Proceeds** (per-block `{cells,op:'sum'}` aggregate), **hurdle/threshold**, and **valuation** cells, fail-soft. Drivable inputs (`exitMultiple`/`exitYearSelector`/`hurdleRate`) remain mapped under `named-inputs.json`. **Remaining:** reconcile the summed per-block MIP aggregate against the real A-1 MIP total (`ETE_GOLDEN_DIR`) before Mippy trusts the auto-detected proceeds.
- **P2 · [#26] — `_fn` fallback audit (`_fn-fallbacks.json`). ✅ DONE (2026-05-29).** Scans the generated sheet modules → `_fn-fallbacks.json`, and checks each named output/schedule's dependency closure against it. **Reports** by default (annotates affected outputs with `resolvesThroughFallback`, records `stats.fallbackViolations`, `ete init` warns); **hard-fails only under `--assert-no-fallbacks`** so the gate doesn't block the real models (~11,813 fallbacks today). The "assert no value cell uses a stub" target is the golden-master CI check below, run with `--assert-no-fallbacks`.
- **P3 · [#22] — scaling walls + lazy sheet loading. ✅ DONE (2026-05-29).**
  Three walls closed so the real models both *build* and *run* at scale:
  **(C) streamed emit** — write each sheet module to disk as generated and drop
  the string (was: hold all ~800 MB before writing → 18 GB peak); heavy sheets
  emit one-at-a-time. **(B) borrowed partitions** — `SheetPartition<'a>` holds
  `Vec<&CellData>` (was: clone ~6M cells → peak-memory doubling). **(A) opt-in
  `ete init --lazy-engine`** — emits an engine whose sheet modules load on demand
  via async `load()`/`runScoped()` with output-cone scoping; sync `run()`
  preserved; **default engine unchanged** (eager + sync, Mippy untouched).
  `npm run test:lazy-engine` (19) + CI. Still open under #22's original umbrella:
  the `--output-profile contract` knob (skip the per-sheet emit entirely for
  contract-only consumers) and a guided `ete create` skill.

Supporting (makes the oracle trustworthy, not on the critical path):
- **Golden-master CI assert ✅ DONE (2026-05-29).** `eval/golden-master.mjs` +
  `npm run test:golden` + a dedicated CI step. Asserts no return/value output
  resolves through an `_fn` stub (`--assert-no-fallbacks`) and diffs
  `named-outputs.baseCaseValue`s against canonical returns to full float
  precision. CI exercises the mechanism on a synthetic committed fixture; the
  proprietary figures stay gitignored and are diffed only when `ETE_GOLDEN_DIR`
  points at the real model.
- **Refiner UW-Comparison fix ✅ DONE (2026-05-29).** `refineSheetTier` ranks a
  canonical Version-Tracker / Track-Record tab above an underwriting "UW
  Comparison" tab, so #25's returns pin to canonical tabs without per-model
  pinning. Invariant trip-wire pattern documented in `skill/SKILL.md`.
- **Two P2 follow-ups closed (2026-05-29):** driver named-inputs now emit under
  `--reuse-parse` without the workbook; schedule `baseCaseValue` no longer sums
  balances across years (terminal level for stocks, sum for flows).

Still open: deeper transpiler coverage (the 11,813 `_fn` offenders behind #26),
cluster-once eval (our accuracy harness), large-sheet eval, pipeline perf. See
`HANDOFF.md` for the full ordering + Done criteria.

[#24]: https://github.com/ebootheee/excel-to-engine/issues/24
[#25]: https://github.com/ebootheee/excel-to-engine/issues/25
[#26]: https://github.com/ebootheee/excel-to-engine/issues/26

## Now — PE-model regeneration findings (Mippy consumer, 2026-05-28)

The downstream Mippy agent regenerated both PE engines from `main` (current
excel-to-engine) → `the regenerated `-v2` engine dirs`, old build left alongside.
Confirmed the new build is clearly better and surfaced concrete follow-ups.
Issues filed: [#22] (output scoping) and [#23] (parser/emitter perf).

**Confirmed better than the old (pre-our-work) build:**
- **Dates fixed.** Old leaked Rust debug strings (`ExcelDateTime { value: 45960.0,
  … }` — 2,686 in A-1, breaking date math); new emits serial numbers, 0 leaks.
- **~42–45% smaller** (~1.9–2.0 GB → ~1.1 GB): `model-map.json` (606 MB) +
  `_computed-values.json` (192 MB) gone — the #8 slimming + dropping the GT-copy.
- Semantic manifest + ADR-017 contract maps emitted; circular refs now run
  per-cluster fixed-point loops.
- **Golden master PASS.** Regenerated `_ground-truth.json` reproduces the
  hand-port's canonical A-1 gross/net MOIC & IRR (Version Tracker row 22) to full
  float precision. ✅ **Done (2026-05-29):** `eval/golden-master.mjs` +
  `npm run test:golden` diff `named-outputs.baseCaseValue`s against canonical
  returns and assert no return resolves through an `_fn` stub. Run it against the
  real A-1 build with `ETE_GOLDEN_DIR=<chunkedDir>` and a gitignored
  `<chunkedDir>/canonical-returns.json` (the figures stay out of this public repo;
  CI runs the synthetic fixture).

**Open follow-ups:**
- **Generation robustness on big models ([#23]).** The original OOM (parser killed
  at the cell-level dependency-graph step, `engine.js` + closures written after it
  so they never landed) was fixed by P1 — `engine.js` now writes first and the
  dep-graph is streamed. ✅ **A second, distinct hang fixed (2026-05-29):** a clean
  build then stalled ~12h *earlier*, inside `partition_sheets`, which called the
  range-expanding `extract_refs` (post-Round-2 it explodes every range to ≤1000
  cells per formula, then discards the same-sheet ones) on the 1.62M-formula PP&E
  sheet → swap thrash. Now uses a sheet-names-only scanner (`collect_sheet_deps`);
  cycle detection uses `extract_refs_shallow`. ✅ **Two more walls fixed
  (2026-05-29, #22):** the emit was materializing all ~800 MB of generated module
  strings before writing any (18 GB peak) — now **streamed** (write + drop per
  module, heavy sheets one-at-a-time); and `partition_sheets` cloned every cell
  (peak-memory doubling) — now **borrows** (`Vec<&CellData>`). The eager
  `engine.js` still imports all modules, so `ete init --lazy-engine` adds an
  on-demand engine for the run-the-oracle path. **Residual (deferred):**
  `generate_sheet_module` builds a `Vec<String>` then joins (~2× a monster
  transiently), and a single ~200 MB monster module is still heavy to import →
  **row-chunk the 3 monster sheets** into smaller lazy modules. Also still wanted:
  within-sheet parallelism for the heaviest sheets. **Not yet measured on the real
  models** (gitignored) — a clean A1/A2 regen should confirm the emit completes.
- **`--output-profile` / guided `ete create` ([#22]).** Skip the ~752 MB
  per-sheet engine emit when a consumer only needs ground truth + contract maps.
- **Transpiler coverage — 11,813 `_fn()` fallbacks (unchanged old→new).** That
  many formula cells still transpile to a generic unsupported-function stub — a
  prime accuracy suspect once cluster eval makes per-sheet accuracy measurable.
  Inventory the missing Excel functions and prioritize by frequency. (See
  Transpiler Coverage below.)
- **Refiner mis-maps returns to the "UW Comparison" tab. ✅ DONE (2026-05-29).**
  `refineSheetTier` (cli/commands/manifest-refine.mjs) now ranks canonical
  actuals (Version Tracker / Track Record) above summary → rollup → underwriting
  ("UW Comparison") → operational tabs, so returns pin to the canonical tab
  automatically. A `skill/SKILL.md` invariant pattern lets a model owner lock it.
- **`named-inputs.json` empty** when a workbook exposes no formula-referenced
  defined-names (this case) — ADR-019 ranged inputs can't be auto-derived;
  needs a heuristic fallback or a documented manual-input path.
- **MIP isn't a generated output (request #7).** The MIP figure is a hand-port
  calibration, not a single GT cell — MIP is modeled across per-block "MIP
  Proceeds" cells. Surface via a `requiredFor`/aggregate mapping, not a
  single-cell expectation. (See the Round 2 MIP-gating note above.)

[#22]: https://github.com/ebootheee/excel-to-engine/issues/22
[#23]: https://github.com/ebootheee/excel-to-engine/issues/23

## Now — Security Hardening Follow-ups (post-PR #13)

Non-blocking items surfaced during the v0.2.0 security audit pass. Open
when we next touch the monitor server or auth surface.

- **Monitor `Origin` allowlist for non-loopback `HOST`.** Currently
  hardcodes `http://localhost:${PORT}` / `http://127.0.0.1:${PORT}`. If
  someone sets `HOST=0.0.0.0` to expose the dashboard on a LAN/dev box,
  any explicit `Origin` from another hostname will 403. Either compute
  the allowlist from `HOST` + a configurable extra list, or document the
  loopback-only constraint in `eval/monitor/README` (and require an auth
  layer for any non-loopback bind).
- **Auth layer for non-loopback monitor.** The post-PR #13 server is safe
  on loopback. If we ever expose it publicly we need real auth (signed
  token, mTLS, or upstream SSO) before re-enabling anything beyond the
  upload→POST /run flow.
- **`MAX_UPLOAD_BYTES` review.** Default 200 MB covers tested PE platform
  models (~83 MB largest). Re-evaluate if we add multi-fund consolidated
  workbooks or pre-parsed bundles.
- **Mirror/airgapped install path for `xlsx`.** The CDN tarball
  (`cdn.sheetjs.com`) is a single point of failure for reproducible
  builds. Document the mirror approach (vendor the tarball into the repo
  or a private registry) before any locked-down deployment.

## Now — V3 Polish + Production Validation

### CLI Field Testing
- Run `ete` against all 6 production models (2-82 sheets)
- Compare CLI scenario outputs to existing bespoke analysis scripts
- Test scenario file workflow end-to-end with PE team

### Manifest Refinement (continuing)
- Model-family templates — recognize a family by its sheet signature and pick
  known cells directly (summary tabs, promote tab, etc.).
- Pre-indexed label→cell map.
  - **Done (2026-05-28):** `ete manifest refine` now consumes the parser's
    `chunked/_labels.json` for labels (it previously ignored it and rebuilt a
    full label+numeric index over the whole GT) and resolves same-row numerics
    lazily by probing — so it no longer indexes the giant unlabeled grids that
    dominate big models. The removed `buildIndex` pass was ~7.9 s on a 6.4 M-cell
    GT; the work skipped scales with total cell count. `test-refine-label-index`.
  - **Done (2026-05-28): single GT parse per `init`.** `init` now loads the
    ground truth once and shares the parsed object across
    generate → refine → doctor → maps (each previously re-parsed the full
    200 MB+ GT). The GT is read-only in all of them. `test-init-shared-gt`.
  - **Tier B (row-values artifact) — measured and deprioritized.** Gauged on
    the two real ~200 MB PE models: both are **dense-label** (≈90% of rows
    labeled, ≈93% of numerics on labeled rows), *not* the giant-grid case the
    100× idea assumed. A general row-values artifact is ≈30% of GT (≈60% of the
    post-#17 compact GT) → only ~1.6× on refine while inflating output ~60%,
    which fights the #17 slimming. Refine's *actual* need is tiny (~100 rows /
    ~70 KB) but extracting it cheaply would couple the parser to refine's metric
    vocabulary. Not worth it on these models; revisit only if a genuinely
    giant-grid model (mostly unlabeled numeric grids) shows up.
  - **Done (2026-05-28):** applied the same lazy-numerics path to `searchByLabel`
    (`query` / `carry`) — probes the matched row's columns instead of scanning
    the whole GT, with a directed `caseColumn` probe so a far scenario column is
    never missed.
- Manifest migration tooling for model updates (vN → vN+1 shape diff).

---

## Done — V3: Model Analysis CLI + Skill Layer (2026-04-15)

### CLI Tool (`cli/`)
- 8 commands: `init`, `manifest`, `query`, `pnl`, `scenario`, `sensitivity`, `compare`, `summary`
- 25+ scenario parameters (exit multiple/year, revenue adj/growth, cost adj, line-item, capitalize, leverage, distributions, sum-of-parts, pref return, hold period)
- Delta cascade engine: adjustments → P&L → TV → equity → MOIC → IRR → carry
- Scenario file support (JSON), save/load/list, attribution analysis
- 1D sweeps and 2D sensitivity surfaces
- Cross-model comparison
- 4 output formats: table, json, csv, markdown
- 34/34 integration tests pass

### Model Manifest (`lib/manifest.mjs`)
- Schema v1.0 with segments, equity classes, carry tiers, line items, custom cells
- Heuristic auto-generation from ground truth (no LLM required)
- Validation against ground truth with confidence scores
- Base case output resolution from manifest + ground truth

### Extractors (`cli/extractors/`)
- Date detector, annual aggregator, segment detector, waterfall detector, line-item resolver
- Growth rate computation (YoY, CAGR)

### Claude Code Skill (`skill/SKILL.md`)
- PE language → CLI parameter translation guide
- Command chaining patterns (discovery → analysis → scenario → comparison)
- Model type templates (PE fund, platform, RE, SaaS, venture)
- Interpretation guidance with benchmarks

---

## Ongoing — Accuracy Improvement + Production Learnings

### Transpiler Coverage
- **Concrete return-path targets (golden-master `--assert-no-fallbacks`, 2026-05-29):**
  on the regenerated A-1/A-2 the returns (`grossMOIC`/`IRR`, `netMOIC`/`IRR`,
  `equityBasis`, `totalCarry`) resolve through `_fn` stubs for exactly **four**
  unsupported functions — **`XNPV`, `FILTER` (`_XLFN._XLWS.FILTER`), `MINIFS`,
  `MAXIFS`**. Implementing these four is what makes `golden-master
  --assert-no-fallbacks` pass on the real models (the highest-leverage transpiler
  work — it directly unblocks the value cells Mippy calibrates against). `ete init
  --assert-no-fallbacks` / `eval/golden-master.mjs --assert-no-fallbacks` print the
  exact offending cell + function per output.
- **Measured (2026-05-29 regen): ~11,782 (A-1) / 11,785 (A-2) `_fn()`
  fallbacks per engine** — that many formula cells transpile to a generic stub.
  The four above are the subset on the *return* paths; the rest are the long tail.
  Inventory by frequency, implement top offenders.
- Implement INDIRECT function (dynamic cell references)
- Fix 2D range handling edge cases for very large sheets
- Handle array formulas / CSE (Ctrl+Shift+Enter) patterns
- Improve SUBTOTAL dispatch (function_num variants beyond SUM)

### Production-Informed Fixes (from 6-vehicle carry project)
- **Cash flow series extraction** — Ground truth only stores terminal values. Need to extract the full distribution series for accurate IRR computation. The `MOIC^(1/years) - 1` approximation diverges badly for long holds with interim distributions.
- **Waterfall structure detection** — Detect multi-tier waterfalls (pref, catch-up, residual, IRR hurdle tiers) and emit as structured metadata in model-map.json. Current models have 4+ tiers but the metadata doesn't capture this.
- **SKILL.md guidance** — Add guidance for when downstream consumers should use actual parsed engine output vs simplified parametric wrappers. The carry project used simplified wrappers and diverged 29-60% on 4/6 vehicles.
- **Pref compounding for long holds** — 12-year 8% compound pref = 2.52x hurdle, which exceeds many MOIC targets. Need to detect when models use quarterly cash flow waterfalls vs bullet maturity and adjust accordingly.

### Eval System
- **Done (2026-05-28):** repeatable accuracy + efficacy benchmark over the real
  PE models — `benchmarks/bench.mjs` → `benchmarks/BASELINE.md`
  (aggregate-only). Baseline: a1 84.3%, a2 85.5% on standalone sheets. Also
  **fixed a Windows crash** in `per-sheet-eval` (bare absolute ESM import →
  `pathToFileURL`; it had zeroed accuracy on Windows/real engines and wasn't in
  CI — now guarded by `test-per-sheet-eval`, run on windows-latest).
- **Large-sheet eval (190 MB PP&E):** confirmed it exceeds the 150 MB per-sheet
  limit and is skipped. Needs streaming/sharded per-sheet eval or a higher limit
  with chunked compute. The standalone sheets at ~85% also need attention (array
  formulas / wide-sheet disambiguation) — visible now that the eval runs.
- Increase blind eval question diversity; add time-period-aware questions.

### Convergence Loop Accuracy
- **Diagnosed (2026-05-28):** on the real models the circular cluster is **17 of
  21 sheets**, and `per-sheet-eval` re-runs the *entire* cluster convergence once
  per member sheet (O(cluster²)) — that's why clustered big models "won't
  evaluate." The array-formula Headcount sheet lives inside this cluster, so it's
  unmeasurable until this is fixed. `--skip-clusters` skips them for now.
- **Done (2026-05-28):** scoped the convergence diff to written cells
  (`ctx._written`) instead of all ~6M seeded cells per iteration. Added a
  synthetic 2-sheet circular fixture (`tests/cli/fixtures/cluster-model/`) + the
  first cluster test. Measured: scoped-diff alone is **not** enough — the 17×
  per-member redundancy dominates.
- **Remaining key fix (cluster-once):** single-pass orchestrator eval — converge
  the cluster once, then score every member from that converged state (one task
  per cluster, not per sheet); then drop `--skip-clusters` from the benchmark.
  The cluster fixture is the ready test oracle.
- Consider lazy subgraph evaluation (only compute transitive closure of targets).

## Near-Term

### Unit Test Suite
- **Done (2026-05-28):** `tests/lib/test-lib.mjs` (43) — `lib/irr.mjs` (known
  IRR/NPV/XIRR cases), `lib/waterfall.mjs` (American/European/MOIC-hurdle +
  conservation invariant), `lib/calibration.mjs` (nested get/set, validate),
  `lib/sensitivity.mjs` (flattenOutputs). In `npm test` / CI.
- Still open: `lib/calibration.mjs` convergence/edge cases (calibrate loop),
  `lib/sensitivity.mjs` surface extraction + elasticity/breakpoints, and
  `lib/excel-parser.mjs` fingerprinting with synthetic workbooks.

### CI Pipeline
- **Done (2026-05-28):** `.github/workflows/ci.yml` — on push/PR to `main`,
  matrix across `ubuntu-latest` + `windows-latest`: `cargo build`/`cargo test`
  (release) + the full JS suite (`npm test`) + `smoke` / `test:depgraph` /
  `test:engine` / `test:slimming`. Rust + npm caching; concurrency-cancel.
- Still open: blind-eval-on-synthetic gate + accuracy regression detection
  (compare against previous run) — needs a committed synthetic model + a
  baseline-accuracy artifact to diff against.

### Synthetic Example Project
- Create a dummy PE fund model in Excel (no real data)
- Run the full pipeline to produce engine + tests + dashboard
- Include as `examples/synthetic-fund/` for reference

## Medium-Term

### WASM Build
- Compile Rust parser to WASM for browser-side Excel parsing
- Upload .xlsx → get model-map instantly in browser
- No server needed for the parse step

### Dashboard 2.0
- Wire up the generated engine.js to an interactive dashboard
- Scenario comparison mode (base vs bull vs bear)
- Export to PDF
- Dark mode

### TypeScript Support
- Generate `engine.ts` with full type definitions
- Zod validation for inputs

### Cloud Deployment
- Deploy engine as API endpoint (Cloudflare Workers / Vercel Edge)
- Webhook for re-running eval on model changes

## Done

### Ship-readiness pass — accuracy verification + refiner hardening (2026-04-17)
- setNestedField array-path corruption fixed (refiner patches were landing in a dead `"0"` sub-object)
- Refiner rejects zero-valued candidates when non-zero alternatives exist
- `pickRightmostInRange` supports `labelCol` anchor; prefers closest-to-label, time-series rows still get rightmost
- Doctor flags zero `totalCell` / `basisCell` / `terminalValue` etc. as errors
- `ete carry` model-first: returns `manifest.carry.totalCell` × ownership directly when set and non-zero
- Template `hints.scenarioColumns` drives refiner column selection (init now applies template BEFORE refine)
- `--search` token fallback: `"Gross MOIC"` matches `"Gross (post carry) MOIC"` via all-words AND-match
- Refiner picks top candidate when multiple summary-sheet entries compete (alternates recorded in report)
- +63 ship-ready assertions (363 total across suite)

### Multi-class promote aggregation (2026-04-20)
- `resolveCell` accepts aggregate `{ cells: [...], op }` refs — first-class
  manifest concept, backwards-compatible with string refs
- `detectCarry` auto-aggregates sibling sheets (e.g. `GP Carry (1.5%)` +
  `GP Carry (1.25% TRS)` → sum to consolidated total)
- Refiner + doctor + `ete carry` all handle aggregate refs
- +15 ship-ready assertions (category I: aggregate resolution, sibling
  detection, 0-value filtering, refiner preservation); 378 total

### Platform upgrades from rebuild reflection (2026-04-20)
- Flat-MOIC hurdle waterfall: `hurdleMOIC` tier prop + `createMoicHurdleWaterfall`
  helper + `ete carry --hurdle-moic`. No IRR compounding with hold.
- Rollup-sheet preference in `detectCarry` and refiner ranking: summary >
  rollup > generic > per-class-numbered
- `ete init --reuse-parse`: skip Rust parse when `chunked/` already exists
  (68s → 2s on big models)
- `manifest.invariants[]` with doctor enforcement — trip-wires for domain
  rules that need to survive agent reinterpretation
- `resolveSiblingAggregate` helper extracted; extended to `detectDebt`
  (multi-facility exit balances). Not applied to equity (see CHANGELOG).
- +19 ship-ready assertions (categories J-N); 397 total

### Post-SESSION_LOG-4 workflow + auto-gen fixes (2026-04-17)
- `--search` literal substring by default, `--regex` opt-in; invalid regex falls back to literal
- `--case <col>` scenario-column selection on `ete query` (and surfaced to `ete carry`)
- Soft-fail `ete init` — bad fields are quarantined, chunked dir is written, exit 0; `--strict` for CI
- Template auto-apply on strong signature match with `signature.autoApply` + `matchThreshold` flags
- Templates carry a `hints` block (summary-sheet preference, default scenario column, peak-equity vocabulary)
- Refiner — new patterns for "Peak Net Equity" / "Gross MOC", summary-sheet preference in candidate ranking
- `ete carry` label-search fallback when the manifest lacks `basisCell`/`grossMOIC`
- `skill/SKILL.md` opens with explicit anti-stall rules (never walk cell coordinates, assume + verify)
- Public-release hygiene: proprietary identifiers removed from templates/docs

### V4 AI Interface Layer (2026-04-17)
- Rust parser emits `chunked/_labels.json` — O(1) label search (30s → <100ms on
  200MB GT models)
- `--compact` / `--format compact` output mode (~60% token savings)
- `ete explain <name-or-cell>` — full audit trail (manifest → cell → label → value → formula)
- `ete eval <cell>` — chunked-engine bridge for non-linear formulas with
  `--inputs` override
- `ete extract [--list | --type | --id]` — time-series schedules (capital
  calls, distributions, debt balances, fees, NOI, CF, interest)
- Manifest schema extensions: `fundLevel`, `schedules`, `covenants`,
  `equity.classes[i].shares/ownershipPct`, `debt.principal/rate/maturity`,
  `carry.tiers`
- 7 new detectors: fund-level, schedules, cap-table, debt-details, carry tiers, covenants
- Model-family templates (`templates/pe-platform-summary.json`, `pe-fund-generic`,
  `re-fund-generic`) with auto-suggestion + `--template` application +
  `ete manifest export` to build new ones
- Doctor-gated init (exits non-zero on errors; `--force` to bypass)
- 57 new test assertions (274 total, all green)

### Deferred (acknowledged, not yet built)
- Rent roll 2D table extraction (needs tabular detection heuristics)
- MIP tier detection (too model-variable for generic detector)
- FX hedge extraction (rare across model families)
- Daemon / persistent-cache mode for CLI (cache manifest + GT across calls)
- Richer dependency graph output for `ete explain` (requires chunked emitter
  to persist formula→deps map)

### Carry Command + Label Hardening (2026-04-16 PM)
- `ete carry` — waterfall GP carry command wrapping `lib/waterfall.mjs`
  (American + European structures, `--ownership`, `--combined`, `--no-catchup`,
  IRR-solved hold period)
- Scenario-block detection in `lib/manifest.mjs` — recognizes stacked repeating
  blocks (PE promote sheets with 5 scenarios on one tab), emits to
  `manifest.scenarioBlocks`, surfaced in `ete summary`
- `manifest doctor` carry-label sanity check — flags pre-carry CF /
  cash flow / capital / equity / profit labels adjacent to `carry.totalCell`
- Carry detection regex accepts "Carried Interest" (previously missed)
- `disqualifyingPatterns` in refiner field specs — labels describing another
  concept can no longer satisfy field patterns
- SKILL.md + README updated with ete carry examples and "validate manifest
  before trusting" workflow

### Manifest Robustness Pass (2026-04-16)
- Enforced `FIELD_RANGES` value-range validation in manifest auto-generation
  (`basisCell`, terminal value, exit multiple, carry, debt, WACC, shares, etc.)
- Equity-class dedupe by `(sheet, row)`
- Segment time-series validation (constant rows = scalar assumptions, rejected)
- `ete manifest doctor` — diagnose suspect mappings with corrective commands
- `ete manifest set` — targeted cell override (replaces hand-patched JSON)
- `ete summary` flags suspect segments inline + `--terse` mode
- `ete init --quiet` — machine-readable JSON summary for CI/agent contexts
- `ete init` cleans up redundant root `model-map.json` / `formulas.json` in
  chunked mode (`--keep-model-map` to opt out)
- Rust build: 13 dead-code warnings → 0
- 31-assertion test suite for manifest improvements + full `npm test` runner

### Security Hardening + Root Cause Fixes (2026-03-29)
- Template literal `${}` injection blocked in cell value emission
- `escape_js_string` complete (newlines, CR, tabs, `${}`)
- API key stripped from child process environment
- Container runs as non-root user
- Safe `.env` loading (no shell injection via xargs)
- INDIRECT dynamic refs resolve correctly (`INDIRECT("P"&ROW())` → `ctx.get("Sheet!P20")`)
- ROW()/COLUMN() emit actual cell position (was always 0)
- ExcelDateTime → numeric serial value (3,300+ cells fixed)
- Convergence: 200 max iterations, 1e-6 tolerance, stale detection

### E2E Test 2 — Large Corporate Model (2026-03-29)
- 80MB model, 21 sheets, 6M cells
- Blind eval: 49/50 (98%), per-sheet: 71.4%
- Full red team security audit: 8 HIGH + 7 MEDIUM findings → all P0s fixed

### Repo Restructure (2026-03-25)
- Two clean pipelines: `pipelines/rust/` and `pipelines/js-reasoning/`
- Unified eval tools in `eval/`
- All proprietary references scrubbed
- Merged to main

### Blind Eval System (2026-03-25)
- `eval/blind-eval.mjs` — Independent Claude API validation with tool_use
- `eval/generate-questions.mjs` — Natural-language financial questions from ground truth
- `eval/analyze-report.mjs` — Structured failure analysis with fix recommendations
- 50/50 (100%) on mid-size 38-sheet model

### Auto-Iteration Container (2026-03-24)
- Docker container: parse → eval → Claude API diagnose → patch → rebuild → re-eval → loop
- Resource monitoring in terminal (CPU/mem/network)
- Mac + Windows compatible
- Handles 3 models sequentially

### Chunked Compilation (2026-03-24)
- Per-sheet JS modules instead of monolithic engine
- Sheet-level dependency DAG with convergence loops for circular references
- 82 sheets compile and run without OOM
- Compact mode auto-enables for workbooks >50K cells

### Rust Parser + Transpiler (2026-03-23)
- 8 Rust modules, ~5,000 lines
- ~60 Excel functions transpiled
- Rayon parallelization (3.8x speedup)
- Iterative Tarjan SCC (handles 3M+ nodes)
- 87.6% accuracy on 82-sheet model (2532/2890 cells)

### Sensitivity Surface Validation (2026-03-23)
- `lib/sensitivity.mjs` — surface extraction, comparison, multi-point calibration
- Proves multi-point calibration improves accuracy from 40% → 100% at breakpoints

### Sheet Intelligence (2026-03-21)
- Sheet fingerprinting with 50+ financial term aliases
- Year detection, multi-year extraction, escalation detection
- Asset classification

### Core Libraries + Skill (2026-03-19)
- IRR, waterfall, calibration, Excel parser, self-eval libraries
- Claude Code skill for 4-phase pipeline
- Dashboard templates (Tailwind + Chart.js, zero build step)

## Telemetry & Developer Dashboard
- [ ] Emit usage metrics to D1 (page views, API calls, errors)
- [ ] Feed structured feedback into code-review dashboard
- [ ] Add health check endpoint for automated monitoring

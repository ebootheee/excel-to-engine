# excel-to-engine — Roadmap

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
- **P2 · [#25] — pin the value-bearing cells as named-outputs. ✅ DONE (2026-05-29).** Per-class MIP Proceeds, hurdle/threshold, participation %, equity basis, valuation/shares — not just MOIC/IRR. Schedules and timeline timelines (such as debt, equity base, cash flow) are now surfaced and participate fully in closure analysis via range expansion. Drivable driver-inputs (`exitMultiple`, `exitYearSelector`, and `hurdleRate`) are also mapped under `named-inputs.json`.
- **P2 · [#26] — `_fn` fallback audit (`_fn-fallbacks.json`). ✅ DONE (2026-05-29).** Scans the generated sheet modules → `_fn-fallbacks.json`, and checks each named output/schedule's dependency closure against it. **Reports** by default (annotates affected outputs with `resolvesThroughFallback`, records `stats.fallbackViolations`, `ete init` warns); **hard-fails only under `--assert-no-fallbacks`** so the gate doesn't block the real models (~11,813 fallbacks today). The "assert no value cell uses a stub" target is the golden-master CI check below, run with `--assert-no-fallbacks`.
- **P3 (nice-to-have) · [#22] — output-cone scoping.** Cheaper oracle; not
  required (we don't ship the blob).

Supporting (makes the oracle trustworthy, not on the critical path): golden-master
CI assert (A-1 canonical returns), the refiner UW-Comparison fix (so #25's cells
pin to canonical tabs), deeper transpiler coverage (the 11,813 `_fn` offenders
behind #26), cluster-once eval (our accuracy harness), large-sheet eval, pipeline
perf. See `HANDOFF.md` for the full ordering + Done criteria.

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
  float precision. Pinning A-1's manifest to those cells makes
  `named-outputs.baseCaseValue` a ready CI golden-master assert. **Do this:** add
  a golden-master test diffing those baseCaseValues. (Canonical figures stay in
  the gitignored artifacts + project memory — not committed to this public repo.)

**Open follow-ups:**
- **Generation robustness on big models ([#23]) — blocks a clean full build.**
  Plain `ete init` hit its 10-min `spawnSync` cap, and the Rust parser was
  OOM-killed at the cell-level dependency-graph step → `engine.js` (the `run()`
  orchestrator) and `dependency-graph.json` closures **didn't land** (written
  after the OOM step); regen needed direct-parse then `--reuse-parse`. Needs:
  stream/incrementalize the dep-graph build (or raise its memory headroom),
  within-sheet parallelism, streaming writes, and a higher/configurable init
  timeout.
- **`--output-profile` / guided `ete create` ([#22]).** Skip the ~752 MB
  per-sheet engine emit when a consumer only needs ground truth + contract maps.
- **Transpiler coverage — 11,813 `_fn()` fallbacks (unchanged old→new).** That
  many formula cells still transpile to a generic unsupported-function stub — a
  prime accuracy suspect once cluster eval makes per-sheet accuracy measurable.
  Inventory the missing Excel functions and prioritize by frequency. (See
  Transpiler Coverage below.)
- **Refiner mis-maps returns to the "UW Comparison" tab.** Auto-manifest picked an
  underwriting-comparison cell over the canonical Version Tracker returns —
  `SUMMARY_SHEET_PATTERN` over-ranks "UW Comparison". The refiner should recognize
  canonical returns / Version-Tracker tabs (or de-prioritize
  underwriting-comparison tabs) so returns don't need manual per-model pinning.
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
- **Measured (Mippy regen, 2026-05-28): 11,813 `_fn()` unsupported-function
  fallbacks per the PE model engine** — that many formula cells transpile to a generic
  stub instead of real logic, a prime accuracy suspect. First step: inventory
  which Excel functions hit the fallback and rank by frequency, then implement
  the top offenders. (Was unchanged old→new, so it predates our work.)
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

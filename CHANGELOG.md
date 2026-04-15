# excel-to-engine — Changelog

## 2026-04-15 — PLAN V3 Amended: PE-Focused CLI Design

### Amended: PLAN_V3.md
Thorough redesign of the CLI plan based on deep analysis of 12 downstream projects and role-playing through real PE principal workflows.

**Key additions to the plan:**
- **Scenario files** (JSON) for complex multi-parameter scenarios (5-15 adjustments), in addition to CLI flags
- **Line-item adjustments** — row-level deltas (e.g., "reduce tech headcount by $2M"), not just segment-level
- **Growth rate overrides** — compound growth changes per segment (e.g., "tech grows at 40% instead of 30%")
- **Sum-of-parts valuation** — per-segment exit multiples (tech at 12x revenue, RE at 15x NOI)
- **Attribution analysis** — decompose "IRR dropped 7.5pp" into per-driver contributions (revenue -3.2pp, timing -2.8pp, multiple -1.5pp)
- **Cross-model comparison** — compare returns across different models (e.g., Fund A vs Fund B)
- **Named scenario management** — save/load/list scenarios per model
- **CapEx reclassification** — capitalize OpEx over N years (common PE restructuring scenario)
- **Interim distributions** — model special dividends / recap events
- **Label-based search** in query command (find cells by financial term, not just by address)
- **1D sensitivity sweeps** in addition to 2D surfaces
- **Delta cascade formalization** — explicit financial math for how adjustments flow to returns
- **PE language translation guide** in SKILL.md — maps real analyst phrasing to CLI parameters across PE, venture, RE, and corporate model types
- **Expanded parameter set** — ~25 parameters (up from 15), covering the full PE scenario space

**Architecture additions:**
- `cli/extractors/line-item-resolver.mjs` — row-level adjustment engine
- `cli/solvers/delta-cascade.mjs` — the core financial computation chain (adjustments → P&L → TV → equity → returns → carry)
- `scenarios/` directory for saved scenario files
- `package.json` bin entry for `ete` command

**Estimated scope:** ~2,500 lines JS + ~600 lines SKILL.md (up from ~2,000 + ~400)
**Implementation steps:** 19 (up from 14), resequenced with delta cascade as the critical path

---

## 2026-04-14 — PLAN V3: Model Analysis CLI + Skill Layer

### New: PLAN_V3.md
- Designed the consumption layer for converted models: CLI tool + manifest schema + Claude Code skill
- **Model manifest** — JSON schema (v1.0) that maps generic financial concepts (EBITDA, exit multiple, carry tiers, equity classes) to specific cells in any parsed model's ground truth
- **Auto-generation pipeline** — heuristic pattern matching (not LLM) scans ground truth for financial structures: date columns, revenue segments, exit multiples, waterfall tiers, equity/debt
- **CLI commands** — `ete init`, `manifest`, `query`, `pnl`, `scenario`, `sensitivity`, `compare`, `summary`
- **Scenario parameter suite** — 15+ financial adjustment parameters (exit multiple, revenue adj, cost ratios, magic number, leverage, hold period, etc.) that replicate common Excel model adjustments
- **SKILL file design** — teaches Claude Code to compose CLI commands for any manifested model
- **Generic design** — no proprietary model references; works with any Excel model converted by the Rust parser
- 14-step implementation order with dependency mapping, estimated ~1,500-2,000 lines JS + 400 lines skill

### Context
- Inspired by a production carry project's scenario analysis script — a bespoke CLI that wraps one model's ground truth into parameterized scenarios with IRR/MOIC/sensitivity
- V3 generalizes that pattern so any converted model gets the same capability without writing custom code

---

## 2026-04-13 — Two-Tier Engine Workflow + Ground Truth Delta Approach

### New: Dual-engine workflow documentation
- Defined Tier 1 (hand-crafted engines, fast) vs Tier 2 (ground truth + chunked modules, cell-level)
- Added decision logic: use Tier 1 for named-input sensitivity, Tier 2 for segment P&L changes
- Documented the **ground truth + delta approach** — load `_ground-truth.json`, compute scenario deltas, apply to base case returns. Faster and more reliable than running the full chunked engine.
- Added complete code examples showing how to search ground truth by label, read annual data by row, and compute MOIC/IRR impact

### Updated: SKILL.md
- Added TWO-TIER ENGINE WORKFLOW section with decision logic and code examples
- Instructs agents to always generate both tiers and route queries to the right one at runtime
- Documents why the ground truth + delta approach is ~6x more accurate than hand-crafted engine approximation for segment-level questions

### Updated: CLAUDE.md, README.md
- Added "Using Parsed Output" section to CLAUDE.md with workflow and code snippets
- Added "Two-Tier Engine Workflow" section to README with comparison table and examples
- Added new Claude prompt example: "Query ground truth for cell-level analysis"

---

## 2026-03-31 — Engine Validation Script + _sources Pattern

### New: `eval/validate-engine.mjs`
- Generic pre-deploy validation: checks engine base case values against `_ground-truth.json`
- Supports `_sources` metadata pattern: `cells` (direct lookups) and `aggregates` (multi-cell sums)
- Default 0.5% tolerance, `--strict` for 0.01%, `--json` for CI output
- Catches wrong-sheet, wrong-model, wrong-column, and arithmetic-estimate errors
- Exits non-zero on failure — use as a deploy gate

### Documentation
- Added Engine Validation section to CLAUDE.md with `_sources` pattern, common errors, and usage
- Added Step 5 (Validate Engine Values) to README with `_sources` example and CLI usage
- Updated project structure in both files to include `validate-engine.mjs`

---

## 2026-03-29 — Security Hardening + Root Cause Accuracy Fixes

### E2E Test 2 Results (80MB corporate model, 21 sheets, 6M cells)
- **Blind eval: 49/50 (98%)** — 1 failure from column ambiguity on wide sheet
- **Per-sheet eval: 71.4%** (24,266/33,971 cells) — 4 sheets >95%, 6 sheets <65%
- **Red team audit: 8 HIGH, 7 MEDIUM** security findings identified and fixed

### Security Fixes (from red team audit)
- **VULN-1**: Escape `${}` in template literals — blocks RCE via Excel text cells
- **VULN-8**: Complete `escape_js_string` — blocks string breakout via newlines/CR
- **VULN-9**: Strip `ANTHROPIC_API_KEY` from child process environment
- **VULN-4**: Container runs as non-root user (`USER node`)
- **VULN-5**: Safe `.env` loading — line-by-line parser instead of unsafe `xargs`

### Root Cause Accuracy Fixes
- **Root Cause 1 (INDIRECT)**: `INDIRECT("P"&ROW())` was emitting `ctx.get("P0")` because ROW() always returned 0. Fixed: ROW()/COLUMN() now emit actual cell position. INDIRECT auto-prepends sheet name. Expected impact: Headcount 18.6%→~75%, G&A 45.9%→~75%.
- **Root Cause 2 (DateTime)**: `ExcelDateTime { value: 45322.0, ... }` stored as debug string instead of numeric 45322.0. Fixed: `Data::DateTime(dt)` now emits `dt.as_f64()`. Fixes 3,300+ date cells across all models.
- **Root Cause 3 (SUMIFS criteria)**: Cascade from INDIRECT fix — `">"&K$7` now resolves cell value correctly.

---

## 2026-03-29 — V1 Fixes from Zero-Basis E2E Test

### E2E Test Results (fresh Opus 4.6 session, zero prior knowledge)
A fresh Claude Code session cloned the repo and ran the full pipeline on a 60-sheet, 1.8M-cell model with zero prior context. Results:
- **Parser: A+** — 1.8M cells parsed in 71s, zero errors
- **Blind eval: 50/50 (100%)** — Perfect on natural language queries
- **Per-sheet eval: 70.1%** — Top sheets 92-95%, dragged down by EOMONTH/INDIRECT bugs

### Fixes Applied

**Blockers:**
- `iterate.mjs` now auto-detects local vs Docker paths — works without container
- New `eval/per-sheet-eval.mjs` — standalone per-sheet accuracy testing without Docker
- New `eval/run-all.mjs` — one command for full eval pipeline (parse → questions → blind eval → per-sheet → report)

**Accuracy:**
- Fixed EOMONTH transpilation: was concatenating array fragments, now returns single serial number
- Fixed INDIRECT: was returning column letters ("Z", "AA"), now resolves to ctx.get() calls
- Convergence loop: increased max iterations to 200, tolerance to 1e-6, added stale detection

**UX:**
- README: added npm install step, cargo PATH note, memory requirements table
- New `npm run setup` — one-command fresh clone setup
- New `scripts/check-env.mjs` — verifies Node, cargo, npm deps, API key, rust binary
- Per-sheet eval cleans up temp files after completion
- Clearer sheet count reporting (tested vs succeeded vs skipped)

**Documentation:**
- Updated SKILL.md with production learnings (cash flow series, waterfall detection, pref compounding)
- Updated CLAUDE.md with new eval workflow
- Updated ROADMAP.md with production-informed priorities
- Updated PLAN.md to reflect current state

---

## 2026-03-25 — Production Eval + Doc Updates

### Production Use Evaluation
Evaluated the toolkit's output quality on a real 6-vehicle carry computation project that used the Rust parser. Key findings:

**What worked well:**
- All 6 models (5.7K to 5.8M cells) parsed successfully with `--chunked` mode
- Ground truth extraction captured carry-relevant cells across complex sheet structures
- Small fund models (2-7 sheets) parsed in <1 second, large models in ~15 minutes
- Per-sheet module architecture worked without OOM even on 5.8M-cell models

**Accuracy gaps identified in downstream use:**
- Simplified parametric waterfall engines diverged 29-60% from model actuals on 4/6 vehicles
- IRR approximation via `MOIC^(1/years) - 1` is very inaccurate for models with interim distributions
- Long-hold pref compounding (12 years at 8%) creates unrealistically high hurdles
- Multi-tier waterfalls (4+ tiers with IRR hurdles) not captured in model metadata

**Improvements needed (added to ROADMAP):**
- Cash flow series extraction from ground truth (not just terminal values)
- Waterfall structure detection and metadata in model map
- Guidance in SKILL.md for when to use actual parsed engine vs simplified wrappers

### Documentation Updates
- All MD files updated to reflect current status (PLAN, ROADMAP, CHANGELOG, CLAUDE.md, README)
- Historical docs in `docs/` annotated with path migration notes
- SKILL.md template paths updated for new `pipelines/js-reasoning/` location
- README expanded with development journey, scale progression, accuracy metrics, and production learnings

### Scale Data (from production use)
| Model | Sheets | Cells | Formulas | Parse Time |
|-------|--------|-------|----------|------------|
| Small (2 sheets) | 2 | 5,684 | 5,271 | 56ms |
| Medium (7 sheets) | 7 | 96,390 | 86,812 | 718ms |
| Large (34 sheets) | 34 | ~1.4M | ~1.2M | ~3min |
| XL (50 sheets) | 50 | ~1.5M | ~1.3M | ~4min |
| XXL (20 sheets) | 20 | 5,817,116 | 5,580,221 | ~15min |

---

## 2026-03-25 — Repo Restructure + Blind Eval + Merge to Main

### Repository Reorganization
- **Two clean pipelines**: `pipelines/rust/` (fast Rust parser) and `pipelines/js-reasoning/` (Claude-driven)
- **Unified eval**: All eval tools consolidated in `eval/` (iterate, blind-eval, questions, analysis, pipeline, Dockerfile)
- **Cleaned up**: Removed stale `_extract*.py`, `_extracted/`, duplicate container files, empty directories
- **Updated docs**: CLAUDE.md, README.md rewritten for new structure

### Blind Eval System (New)
- `eval/generate-questions.mjs` — Generates natural-language financial questions from ground truth
- `eval/blind-eval.mjs` — Independent Claude API validation with tool_use (zero engine knowledge)
- `eval/analyze-report.mjs` — Structured analysis of eval results with fix recommendations
- **50/50 (100%)** on blind eval for 38-sheet model — proves the engine data is navigable and correct

### Chunked Compilation (Option C)
- Per-sheet JS modules instead of monolithic engine (no more multi-GB files)
- Sheet-level dependency DAG with convergence loops for circular references
- 82 sheets for large model, 38 for mid-size — all compile and run
- Compact mode auto-enables for workbooks >50K cells

### Auto-Iteration Container
- Docker container: parse → eval → Claude API diagnose → patch transpiler → rebuild → re-eval → loop
- Resource monitoring in terminal (CPU/mem/network)
- Ctrl+C cleanly kills container + monitor
- Windows + Mac compatible (MSYS_NO_PATHCONV, .gitattributes LF)

### Performance
- Rayon parallelization: 3.8x faster (14min → 3:36 for 82-sheet model)
- Iterative Tarjan SCC: handles 3M+ nodes without stack overflow
- Ground truth coverage fix: +682K literal cells (+22%)

---

## 2026-03-23 — Rust Engine Pipeline (Phase 1 + 2 + Docker skeleton)

### rust-parser/ — New Rust Crate

Full Excel → JS transpiler in Rust (calamine + serde_json). Parses workbooks in <2ms (release build).

**src/parser.rs**
- Parses `.xlsx` with calamine — all sheets, all cells (values + computed formula results)
- Separate pass for formula strings via `worksheet_formula`
- Outputs `model-map.json` matching v1.1.0 schema (sheets, numeric/text/formula cells, stats)

**src/dependency.rs**
- Builds cell dependency graph from extracted formula references
- Lightweight regex-free ref extractor handles simple refs, cross-sheet refs (Sheet1!A1, 'Sheet Name'!A1), and ranges (A1:B10)
- Tarjan's SCC algorithm for cycle detection
- Self-referential cells (cell depends on itself) also detected as convergence candidates
- Condensation + Kahn's topological sort (fixed: dependencies before dependents)
- Outputs `dependency-graph.json` with nodes, edges, cycles, topo_order, convergence_clusters

**src/formula_ast.rs**
- Full Excel formula tokenizer: numbers, strings, booleans, errors, cell refs, ranges, operators, functions
- Handles quoted sheet names ('Sheet Name'!A1), absolute refs ($A$1), percent postfix
- Recursive descent parser → Expr AST
- Handles all operator precedences: comparison, concat, add/sub, mul/div, exponentiation (right-assoc), unary, percent

**src/transpiler.rs**
- AST → JavaScript code generation
- Cell refs → `s_SheetName_A1` flat variable names (configurable)
- Range expansion → `[s_Sheet_A1, s_Sheet_A2, ...]` inline arrays
- ~60 Excel functions transpiled: SUM, IF, MIN/MAX, ABS/ROUND, IRR/XIRR/NPV, VLOOKUP/HLOOKUP/INDEX/MATCH, AND/OR/NOT, IFERROR, text functions, date functions, financial (PMT/PV/FV/RATE)
- Unknown functions → `_fn('NAME', [...args])` placeholder

**src/circular.rs**
- Generates convergence loop JS for circular reference clusters
- Template: `for (let _ci_N = 0; _ci_N < 100; _ci_N++) { assignments; convergence check; }`

**src/model_map.rs**
- `build_formulas_json()` — all formula cells with formula string, transpiled JS, Excel result, parse errors
- `generate_raw_engine.js()` — complete JS module with runtime helpers, input declarations, dependency-ordered formula assignments, convergence loops, and `computeModel(inputs)` export

**src/main.rs**
- CLI: `rust-parser <input.xlsx> [output_dir]`
- Four output files: model-map.json, formulas.json, dependency-graph.json, raw-engine.js
- Timing per phase (parse, model-map, transpile, dep-graph, engine gen)

**Test Results**
- Synthetic 2-sheet workbook (22 formula cells, 1 circular cluster {B9, B10, B11})
- Circular Interest ↔ CashFlow ↔ DebtBalance correctly wrapped in convergence loop
- Topo order correct: inputs first, convergence cluster after prerequisites, outputs last
- Release binary parse time: **1ms** for test workbook (40 cells, 22 formulas)

### container/ — Docker Pipeline Skeleton

**container/Dockerfile** — Multi-stage: Rust build → Node.js 20 runtime
**container/pipeline.mjs** — Orchestrates parse → validate → eval-loop → output with WebSocket event streaming
**container/eval-loop.mjs** — Automated calibration loop: eval accuracy → detect scale mismatches → apply corrections → re-eval
**container/validate-extraction.mjs** — Cross-sheet ref validation, parse error rates, ground truth coverage

---

## 2026-03-23 — (previous entry)

### Sensitivity Surface Validation & Multi-Point Calibration

Addresses the core failure mode: engines match at base case but get the response curve wrong when inputs change. Waterfall hurdles, MIP thresholds, and other nonlinearities break single-point calibration.

**lib/sensitivity.mjs — New Library:**
- `extractSurface()` — Run engine across input grid, produce response surface with level and slope data
- `compareSurfaces()` — Compare engine vs Excel surfaces: level errors, slope errors, breakpoint mismatches
- `computeElasticity()` — % change in output / % change in input at each grid point
- `detectBreakpoints()` — Find where response curve changes slope sharply (waterfall hurdle crossings, MIP triggers)
- `multiPointCalibrate()` — Fit piecewise-linear corrections across multiple known points instead of single scale factor
- `applyPiecewiseCorrection()` — Apply segment-specific corrections at runtime
- `printSensitivityReport()` — Console report with level/slope accuracy, worst errors, breakpoint detection

**lib/calibration.mjs — Export Helpers:**
- Exported `getNestedValue()` and `setNestedValue()` for reuse by sensitivity.mjs

**tests/synthetic-pe-model/ — Proof of Concept:**
- `engine.js` — Deliberately buggy PE model (simple interest pref hurdle instead of compound)
- `excel-surface.mjs` — Ground truth using correct compound interest
- `test-sensitivity.mjs` — Demonstrates the full workflow:
  - Before multi-point calibration: 40% level accuracy, 69% slope accuracy
  - After multi-point calibration: 100% level accuracy, 100% slope accuracy
  - GP carry error at 1.6x exit: 87% → <1%

**skill/SKILL.md — Sensitivity Guidance:**
- Added "Sensitivity Surface Extraction" section to Phase 1 (extract outputs at multiple input values, not just base case)
- Added "Multi-Point Calibration" section to Phase 2 (use piecewise corrections when Excel surface data available)
- Added "Sensitivity Surface Validation" section to Phase 3 (validate slopes, not just levels)

---

## 2026-03-21

### Sheet Fingerprinting, Multi-Year Extraction & Build Log Improvements

Incorporated learnings from a 37-asset real estate model build into the core toolkit.

**lib/excel-parser.mjs — New Features:**
- `matchLabel()` — Fuzzy label matcher with 50+ financial term aliases mapping to canonical field names (revenue, EBITDA/EBITDAR/NOI, rent, IRR, MOIC, capex, cash flow, etc.)
- `fingerprintSheet()` / `fingerprintWorkbook()` — Scans label columns across all sheets, matches to canonical fields, groups sheets by identical row patterns. Solves the #1 pain point: figuring out which rows contain which data across dozens of identical per-asset sheets
- `detectYearRow()` — Auto-detects rows with sequential year values (2023, 2024, 2025...) and maps columns to calendar years
- `extractMultiYear()` — Extracts a time series for any field across all year columns
- `extractByYear()` — Extracts all fields for a specific reference year (combines fingerprint + year detection)
- `detectEscalation()` — Computes year-over-year growth rates for any field, flags escalating values (catches rent escalation that caused 10-15% errors in production builds)
- `classifyAsset()` — Auto-classifies assets as leased/managed/mixed based on rent presence, coverage ratios, and label text signals

**skill/SKILL.md — Phase 1 Improvements:**
- Added Sheet Structure Fingerprinting section with full usage examples
- Added Reference Year Selection guidance (default to first full stabilized projection year, not closing date)
- Added Cross-Sheet Validation section (validate extraction before engine generation)
- Added Asset Classification step for mixed-type portfolios
- Updated model-map.json schema to v1.1.0 with `referenceYear`, `sheetGroups`, `yearColumns`, `assets` fields
- Renumbered Phase 1 steps (1-8) to include new fingerprinting, year detection, and classification steps

**README.md:**
- Replaced ASCII architecture diagram with image (`docs/architecture.png`)
- Updated excel-parser library docs to show new fingerprinting, year detection, and classification APIs

**ROADMAP.md:**
- Added Incremental Re-extraction to Near-Term (diff model versions, generate changes report)
- Moved completed fingerprinting/classification work to Done section

---

## 2026-03-19 (evening)

### Skill Improvements from Blind Testing Feedback

**SKILL.md — Financial Terminology Mapping:**
- Added comprehensive alias table mapping equivalent terms across sectors (MIP = Promote = Carried Interest Pool = LTIP = Phantom Equity, etc.)
- Covers incentive structures, waterfall/distribution terms, return metrics, and share/unit economics
- Instructs Claude to normalize all variants to standardized engine output field names

**SKILL.md — Parallelization Guidance:**
- Added section on when/how to parallelize across the 4 phases
- Phase 1: read sheets in parallel, prioritize summary tabs
- Phase 2: build multi-series engines concurrently
- Phase 3: base case sequential, then cascade tests in parallel
- Phase 4: only after engines pass eval
- Explicit warnings on when NOT to parallelize (calibration, waterfall debugging)

**SKILL.md — Cheat Sheet Pattern:**
- Added guidance to search for Summary/Cheat Sheet/Overview/Dashboard tabs before diving into detail sheets

**Eval Framework — generate-control.mjs (new):**
- Reads BASE_CASE dynamically from reference engine instead of hardcoding input ranges
- Generates test matrix centered on actual base case values with configurable ±range per input type
- Produces control-baseline.json with base case outputs and single-variable sweep results

**Eval Framework — compare-outputs.mjs (new):**
- Compares candidate engine against control baseline within configurable tolerance
- Input normalization layer with alias mapping (e.g., ownedExitMultiple = exitMultiple = capRateMultiple)
- Handles canonical-to-alias, alias-to-canonical, and sibling alias resolution
- Reports per-output and per-sweep-point pass/fail with deviation percentages

---

## 2026-03-19

### Initial Build — Core Libraries + Templates

**Libraries:**
- `lib/irr.mjs` — Newton-Raphson IRR solver with bisection fallback, includes XIRR for irregular dates, NPV/NPV derivative utilities
- `lib/waterfall.mjs` — Generic PE distribution waterfall supporting American-style (pref + catch-up + residual) and European-style (multi-hurdle) structures. Configurable tiers with LP/GP splits, return-of-capital, catch-up provisions
- `lib/calibration.mjs` — Auto-calibration framework computing ratio/offset scale factors to align JS engine outputs with Excel targets. Includes validation and apply-calibration utilities
- `lib/excel-parser.mjs` — Excel reader using SheetJS (xlsx). Reads cells/ranges/columns, detects input cells (no formula, referenced by formulas), output cells (formula, end of chain), intermediate cells. Builds complete model-map.json with financial pattern detection (IRR, DCF, waterfall, sensitivity)

**Templates:**
- `templates/engine-template.js` — Engine skeleton with BASE_CASE, EXCEL_TARGETS, calibration initialization, `_computeRaw()` placeholder, and `computeModel()` public API
- `templates/dashboard/` — 2-tab HTML dashboard using Tailwind CDN + Chart.js. Tab 1: model explorer (output cards, input sliders, sensitivity heatmap, cash flow chart, waterfall chart). Tab 2: eval results (accuracy table, deviation chart, monotonicity/consistency checks)

**Skill:**
- `skill/SKILL.md` — Claude Code skill definition for the 4-phase pipeline (Analyze, Generate, Test, Dashboard) with detailed instructions for each phase

**Project:**
- README.md, CLAUDE.md, package.json, MIT LICENSE
- Project management files (PLAN.md, CHANGELOG.md, ROADMAP.md)

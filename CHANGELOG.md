# excel-to-engine — Changelog

## 2026-04-17 — Post-SESSION_LOG-4 workflow + auto-gen fixes

A fresh-instance end-to-end session against two PE platform models surfaced
a cluster of friction points, headlined by a mid-session workflow stall
where the agent ran 60+ sequential cell-coordinate probes trying to reverse-
engineer a scenario column. This pass closes each one.

### Workflow stall prevention
- **`skill/SKILL.md`** — new "Core rules" block at the top: never walk cell
  coordinates, assume + verify beats probe + prove, templates do the guessing
  when they match, ask the user when unsure, `--search` is literal by default.
  This is the first block a new session reads and it names the anti-pattern
  explicitly.
- **`--search` is literal substring (case-insensitive) by default.** Users
  can paste phrases like `--search "Gross (portfolio)"` without triggering
  an unterminated-regex crash. Opt in to regex with `--regex`. Invalid
  regex silently falls back to literal rather than throwing.
- **`--case <column>` on `ete query`.** Comparison sheets with multiple
  scenario columns (H, I, J...) can now be targeted directly — matches show
  the named column's value as the primary hit. `hints.scenarioColumns` in
  templates suggest the conventional base-case column.

### Soft-fail init (no more abort-on-first-bad-field)
- **`ete init` quarantines bad fields and exits 0 by default.** A single
  `basisCell`/`exitMultiple` mis-bind used to abort the full 8-minute parse.
  Now each error-level finding is set to null in the manifest, the user
  sees the exact fix command, and the chunked directory is written.
- **`--strict`** re-enables hard-fail (for CI / agent pipelines).
- **`--force`** preserved as a no-op alias so old scripts still work.

### Refiner hardening
- **Peak Net Equity / Gross MOC patterns** added to refiner's
  `REQUIRED_FIELDS`. Previous patterns missed "Peak Net Equity",
  "Fund Size / Peak Net Equity", and "Gross MOC" (no trailing IC). Both
  failed to bind on the production-session models.
- **Summary-sheet preference** in the refiner: candidates on
  `Cheat Sheet` / `UW Comparison` / `Summary` / `Valuation` / `Cover` /
  `Returns` / `Dashboard` / `Exec Summary` tabs rank above the same label
  on operational tabs. Ambiguous matches collapse to the single
  summary-sheet entry when exactly one exists.

### Template auto-apply on strong signature match
- **`templates/pe-platform-summary.json`** — replaces the previous file with
  a generic PE platform template keyed by a 3-tab signature (the common
  shape of PE models that separate summary and promote tabs).
- `signature.autoApply` + `matchThreshold` fields let a template declare
  when it wants `ete init` to apply it automatically vs. just suggest it.
- **`--no-template`** opts out of auto-apply per-run.
- `detectMatchingTemplate()` returns a best-match descriptor with hit
  counts; ties break toward the larger signature (more specific).
- Template now carries a `hints` block: summary-sheet list, per-sheet
  scenario-column defaults, peak-equity label vocabulary.

### `ete carry` label-search fallback
- When `--peak` / `--moc` aren't provided and the manifest hasn't bound
  them, `ete carry` now searches the ground truth by label (uses the
  Phase-1 label index) and either adopts the single unambiguous candidate
  or lists candidates with the exact `ete manifest set` fix command.
- The formatted output reports "via label lookup at <cell>" when a value
  was resolved this way so the user knows where the number came from.
- Works with `--case` to prefer a specific scenario column's value.

### Public-release hygiene
- All proprietary identifiers (private-company and vendor names) scrubbed
  from templates, docs, plans, changelog, and inline comments. The previous
  PE-platform template file has been renamed to
  `templates/pe-platform-summary.json`; any call sites passing an older
  template name to `--template` must migrate to this generic name.

### Tests
- +23 assertions in new `tests/cli/test-e2e4-fixes.mjs` (297 total across
  the suite; all green).
- Rust smoke 78/78.

## 2026-04-17 — V4 AI Interface Layer

Reframe: this tool is an **AI-navigable index over complex Excel models**
covering ~20-30 PE stakeholder use cases (analyst, VP, partner, LP,
portfolio CFO, IR), not just carry/scenarios. Six priorities — all landed.
See `PLAN_V4.md` for the full design.

### Phase 1 — Label index (infrastructure)
- **Rust parser** (`chunked_emitter.rs`, `sheet_partition.rs`) now emits
  `chunked/_labels.json` during chunked emission: `{ labelLower → [{sheet, col, row, text}] }`.
  One extra pass over string cells (~1% of total parse time).
- **CLI** (`lib/manifest.mjs`) exports `loadLabelIndex()` and `buildLabelIndex()`.
  `searchByLabel()` uses the index when present — eliminates the 30s-per-search
  cost flagged in SESSION_LOG_02_carry.md. Fallback to GT scan when legacy engines
  don't have the index file.

### Phase 2 — Token-efficient output (`--compact`)
- `cli/format.mjs` exports `toCompact()`. New `--compact` / `--format compact`
  routes all commands through a compressor:
  - Numbers rounded to 4 sig figs
  - Null/undefined dropped
  - Value-record objects renamed to short keys (`v`/`c`/`l`/`t`/`s`/`r`/`k`)
- Measured: `ete query --search` output shrinks 4247 → 1461 bytes (~65% reduction).
  Agents get 3× more questions per context window.

### Phase 3 — `ete explain <name-or-cell>`
New command. Full audit trail for any manifest name or cell reference:
- Manifest path (which field maps here)
- Cell reference + value
- Adjacent label (column A/B on same row)
- Formula (from `formulas.json` if present, else searches per-sheet `.mjs`)
- Dependencies (from dependency graph if available)

Use: `ete explain <modelDir> totalCarry` or `ete explain <modelDir> "Equity!AN125"`.

### Phase 4 — Doctor-gated init + model-family templates
- **Doctor gate:** `ete init` now runs `manifest doctor` after refine.
  Errors abort init with non-zero exit. `--force` bypasses.
- **Templates:** new `templates/` directory with `pe-platform-summary.json`,
  `pe-fund-generic.json`, `re-fund-generic.json`. Each is a partial manifest
  with layout hints and optional pre-mapped cell references.
- **`--template <name>`:** `ete init model.xlsx --template pe-platform-summary`
  applies the template after auto-generation, overriding detected cells with
  known-good mappings for the family.
- **Auto-suggest:** when no template is specified, `init` checks whether the
  model's sheet names match any known template (≥75% overlap) and prints a
  suggestion.
- **`ete manifest export <modelDir>`:** export a hand-corrected manifest as a
  reusable template. Strips base-case values, keeps structural mappings.

### Phase 5 — `ete eval <cell>` (chunked engine bridge)
New command invokes the chunked engine to compute a cell using the actual
transpiled Excel formulas. Escape hatch from the delta cascade (linear
approximation) for non-linear scenarios: covenants, MIP, pref compounding
with irregular calls, FX hedges. Supports `--inputs '{"Sheet!A1": value}'`
to override base-case cells.

### Phase 6 — Breadth of extraction primitives
Manifest schema extensions + detectors + extraction command for the long
tail of stakeholder questions:

**New manifest sections:**
- `fundLevel` — TVPI, DPI, RVPI, netIRR, vintageYear, fundSize, paidIn,
  distributed, residualValue (LP-facing metrics)
- `schedules[]` — time-series rows tagged with type: `capital_call`,
  `distribution`, `debt_balance`, `debt_service`, `interest_expense`, `fee`,
  `equity_invested`, `cash_flow`, `noi`
- `covenants[]` — DSCR, LTV, ICR, leverage ratio, occupancy
- `equity.classes[i].shares`, `.ownershipPct`, `equity.totalShares` (cap-table)
- `debt.principal`, `.rate`, `.maturity` (debt-detail)
- `carry.tiers[]` — detected waterfall tiers (return_of_capital, pref, catchup, residual)

**New command:**
- `ete extract <modelDir> [--list | --type <t> | --id <id>]` — retrieve any
  detected schedule as `{year: value}` series + total.

**New field ranges:** 12 new entries in `FIELD_RANGES` covering TVPI, DPI,
RVPI, fund size, paid-in, distributed, vintage year, debt rate/principal,
covenant ratio, ownership fraction. Used by `doctor` + detector validation.

### Tests
- 57 new assertions in `tests/cli/test-ai-interface.mjs`: label index,
  compact output, explain, eval, extract, templates, every new detector.
- Full test surface: **274 assertions** (34 CLI + 51 manifest + 57 AI-interface
  + 132 use-case), all green.

### Documentation
- `skill/SKILL.md` — rewritten Intent→Command table organized by stakeholder:
  analyst/VP (scenarios), LP (fund-level metrics + schedules), CFO (debt +
  covenants + eval), audit ("why" questions via explain).
- `README.md` — new "What AI agents can ask this tool" section with
  representative questions per stakeholder.
- `CLAUDE.md` — updated command count (12), added `extract`/`explain`/`eval`
  to the reference table.
- `templates/README.md` — template schema + how to build new ones.

---

## 2026-04-16 (PM) — Carry Command + Label Hardening (SESSION_LOG_02_carry.md)

Follow-on pass driven by a second 3-E2E-test session: computing "carry at 2.8×
MoC with 6% ownership" across A-1 + A-2 deployments. The investigation took
~7 min and relied on manual Python scripts because the toolkit didn't expose
the waterfall math, the `carry.totalCell` auto-detection was wrong, and bulk
label scans over a 200 MB ground truth had to be done outside the CLI.

### Added
- **`ete carry`** — compute GP carry under an American or European waterfall.
  Falls back to manifest values for peak equity / MoC / pref / carry%; accepts
  explicit overrides. Solves hold period from IRR via `n = ln(MoC)/ln(1+IRR)`
  when timeline data is missing. Supports `--ownership` for per-holder share,
  `--combined` to sum multi-class equity basis, `--no-catchup` for
  pure 80/20-above-pref, and `--structure european` for multi-hurdle aggregate
  waterfalls. Wraps the pre-existing `lib/waterfall.mjs` which was previously
  only callable from JS code.
- **Scenario-block detection** — `lib/manifest.mjs` now detects stacked
  repeating blocks on a sheet (e.g. 5 scenarios at rows 1-92, 93-184, ... on a
  PE "GPP Promote" tab) and emits them to `manifest.scenarioBlocks`. `ete
  summary` surfaces them with block labels and stride so users can target a
  specific scenario without row arithmetic.
- **`manifest doctor` carry-label sanity check** — inspects the adjacent
  B/A-column label of `carry.totalCell` and flags disqualifying descriptors
  ("pre-carry", "cash flow", "receivable", "payable"). Catches the common
  bug where `carry.totalCell` auto-binds to a Promote-tab cell whose adjacent
  label says "Total Cash Flows (pre-carry)".

### Fixed
- **`carry.totalCell` auto-detection rejected pre-carry CF labels.** Added
  `disqualifyingPatterns` to the refiner's field spec and equivalent logic
  to the detector in `lib/manifest.mjs`. Labels containing "pre-carry",
  "cash flow", "receivable", "payable", "fee", "operating", "capital",
  "equity", or "profit" no longer satisfy the carry regex even if the rest
  of the label matches.
- **Carry regex matches "Total Carried Interest".** Previous regex required
  the literal substring "carry" which `carried` does not contain (differ by
  5th letter y/i). Now accepts `carry|carried|promot`.

### Documentation
- **`skill/SKILL.md`** — added "Validate the Manifest Before Trusting It"
  (run doctor once per session), "When to Use Python Over the CLI" (bulk
  scans shouldn't go through `ete query`), expanded Returns & Carry table
  with `ete carry` examples, and added carry caveats (catch-up semantics,
  IRR-solved hold period limits, `--combined` for multi-class).
- **README.md** — added `ete carry` section with examples + output.

### Tests
- +20 assertions added to `tests/cli/test-manifest-improvements.mjs` (now 51
  assertions total, 217 across the full suite): carry detection accepts/rejects
  labels correctly, doctor flags manually-set bad carry cells, scenario-block
  detection on repeating vs non-repeating sheets, `ete carry` against fixture
  + parametric mode + IRR-solved-life + error handling.

### Session log reference
See `3-E2E-test/SESSION_LOG_02_carry.md` for the full investigation, the two
first-principles math methods that bracketed the answer, and the specific
CLI friction points this pass addresses.

---

## 2026-04-16 — Manifest Robustness Pass (informed by 3-E2E-test session log)

End-to-end run on two 76–83 MB PE platform models surfaced a cluster of
auto-detection failures that cascaded into garbage scenarios. All addressed here.

### Fixed
- **`basisCell` value-range validation on initial auto-generation.** Auto-gen
  previously accepted the first numeric on an equity-labeled row regardless of
  magnitude, so a `5` on `Assumptions!AI48` got written to manifest and produced
  `MOIC = terminalValue / 5 = 7.2M×` on scenarios. Introduced shared
  `FIELD_RANGES` + `inFieldRange()` in `lib/manifest.mjs` and enforced on
  `detectEquity`, `detectOutputs` (terminal value, exit multiple, cap rate),
  `detectCarry` (total carry, pref return), `detectDebt`, and `detectCustomCells`
  (WACC, shares outstanding, price per share). The existing refiner reused the
  same ranges.
- **Equity class dedupe by `(sheet, row)`.** `detectEquity` produced multiple
  identical `class-N` entries because several "Equity Basis" / "Capital
  Committed" labels on the same row each triggered a new class. Now collapses
  to one class per row.
- **Segment time-series validation.** `ete summary` showed "30 segments of $94K
  repeats" because `detectSegments` grabbed any revenue/expense labeled row,
  including scalar assumption rows that just replicated one number across year
  columns. Added a timeline-aware check: segments must have ≥3 numeric values in
  the timeline columns AND those values must vary by ≥0.1%.
- **Rust build: 13 dead-code warnings → 0.** Cleaned up unused variable
  destructures (`sheet_name`, `n_inputs`, `finished_v`, `loop_var`, `start`,
  `saved_pos`, `input_cells`, dead `parse_errors` assignment). Marked
  intentionally-retained helpers with `#[allow(dead_code)]` + reason comments
  (`convert_vars_to_ctx_get`, `extract_cell_addr_from_var`, `ClusterCode` fields,
  `ArrayLiteral` AST variant, `expect_comma`).

### Added
- **`ete manifest doctor <modelDir>`** — diagnoses suspect cell mappings after
  the fact. Runs value-range checks on every scalar field, per-equity-class
  metric, and time-series check on every segment. For each issue, reports the
  bad cell + value + expected range, and suggests a corrective `ete query` /
  `ete manifest set` command.
- **`ete manifest set <modelDir> <path> <cellRef>`** — targeted single-cell
  override for when auto-detection misses. Verifies the cell exists in ground
  truth before writing, refreshes `baseCaseOutputs` when applicable, and
  preserves manifest formatting. Replaces the "hand-patch JSON with Python"
  workflow used in the session log.
- **`ete summary` suspect-segment warnings.** Segments whose values are constant
  across all years are marked inline with `⚠` and a footer note directs the
  user to `ete manifest doctor`. Added `--terse` flag to hide suspect segments
  for clean headline output.
- **`ete init --quiet`** — machine-readable JSON summary instead of narrative
  logs. For CI / agent contexts where init's 600+ lines of per-sheet progress
  are noise.
- **`ete init` now cleans up redundant root `model-map.json` + `formulas.json`.**
  In chunked mode these files at the output root (up to 636 MB on large models)
  are redundant — the CLI reads exclusively from `chunked/`. Opt out with
  `--keep-model-map` for the eval pipeline.
- **`tests/cli/test-manifest-improvements.mjs`** — 31 assertions covering range
  validation edge cases, equity dedupe, segment time-series rejection, and
  doctor/set end-to-end.
- **`npm test`** runs the full suite: 34 CLI integration + 31 manifest + 132
  use-case scenarios = 197 assertions, all green.

### Session log reference
See `3-E2E-test/SESSION_LOG.md` for the production workflow that exposed each
of the above issues and what took manual intervention to work around.

---

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

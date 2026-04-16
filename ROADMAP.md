# excel-to-engine — Roadmap

## Now — V3 Polish + Production Validation

### CLI Field Testing
- Run `ete` against all 6 production models (2-82 sheets)
- Compare CLI scenario outputs to existing bespoke analysis scripts
- Test scenario file workflow end-to-end with PE team

### Manifest Refinement (continuing)
- Model-family templates (Outpost-like sheet templates: Version Tracker,
  Assumptions, Financial Statements, Equity, Debt, Valuation, GPP Promote,
  Cheat Sheet) — recognize the family and pick known cells directly.
- Pre-indexed label→cell map built once during parsing (the session log noted
  `manifest refine` took 2.5 min CPU on a 200 MB ground truth; a pre-index
  from the Rust parser would cut this 10–100×).
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
- Increase blind eval question diversity (computed questions, cross-sheet aggregations)
- Add time-period-aware questions ("What was X in Q3 2025?")
- Profile and optimize per-sheet eval for sheets >150MB

### Convergence Loop Accuracy
- The 62-sheet circular cluster in the large model is the biggest accuracy blocker
- Investigate running eval through the orchestrator (not per-sheet isolation) for circular sheets
- Consider lazy subgraph evaluation (only compute transitive closure of target cells)

## Near-Term

### Unit Test Suite
- Tests for `lib/irr.mjs` with known IRR cases
- Tests for `lib/waterfall.mjs` with standard structures
- Tests for `lib/calibration.mjs` convergence and edge cases
- Tests for `lib/excel-parser.mjs` fingerprinting with synthetic workbooks

### CI Pipeline
- GitHub Actions: cargo build + smoke test + blind eval on synthetic model
- Regression detection: compare accuracy against previous run

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

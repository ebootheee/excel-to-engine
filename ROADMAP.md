# excel-to-engine — Roadmap

## Now — Accuracy Improvement + Production Learnings

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

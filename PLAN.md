# excel-to-engine — Plan

## Status: Rust Pipeline Complete, Eval Loop Validated, Improving Accuracy

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
| Model | Per-Sheet Eval | Blind Eval |
|-------|---------------|------------|
| Synthetic (3 sheets) | 100% (78/78) | 100% (10/10) |
| Mid-size (38 sheets) | 75.9% | 100% (50/50) |
| Large (82 sheets) | 87.6% (2532/2890) | In progress |

### Active Improvement Areas
- [ ] Implement missing Excel functions (INDIRECT, array formulas)
- [ ] Fix 2D range handling edge cases for large sheets
- [ ] Improve convergence loop accuracy for 62-sheet circular cluster
- [ ] Reduce per-sheet eval memory for sheets >150MB

## Next Phase — Polish + Publish
- [ ] Unit tests for all lib/ modules
- [ ] GitHub Actions CI
- [ ] npm publish preparation
- [ ] Example project with synthetic data
- [ ] Contributing guide

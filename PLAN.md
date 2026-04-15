# excel-to-engine — Plan

## Status: V3 Implemented — Model Analysis CLI + Skill Layer (see PLAN_V3.md for design)

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
- [ ] Unit tests for all lib/ modules
- [ ] GitHub Actions CI
- [ ] npm publish preparation
- [ ] Example project with synthetic data
- [ ] Contributing guide

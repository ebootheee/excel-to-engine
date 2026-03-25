# excel-to-engine — Claude Code Instructions

## What This Project Is

A toolkit for converting complex financial Excel models (.xlsx) into JavaScript computation engines. Two pipeline options: a fast Rust parser + transpiler, and an original Claude-reasoning-only approach. Unified eval tools validate both.

## Repository Structure

```
excel-to-engine/
├── pipelines/
│   ├── rust/                    # Fast: Rust parser + formula transpiler + chunked compilation
│   │   ├── src/                 # 8 Rust modules (parser, transpiler, AST, dependency graph, etc.)
│   │   ├── tests/               # Synthetic model smoke test (27/27 = 100%)
│   │   └── Cargo.toml
│   └── js-reasoning/            # Original: Claude reads Excel → reasons → writes engine.js
│       ├── skill/SKILL.md       # Claude Code skill (4-phase pipeline)
│       ├── templates/           # Engine, eval, and dashboard templates
│       └── eval-framework/      # generate-control.mjs, compare-outputs.mjs
├── eval/                        # Unified eval tools (works with both pipelines)
│   ├── iterate.mjs              # Auto-iteration: parse → eval → Claude API diagnose → patch → loop
│   ├── blind-eval.mjs           # Blind Claude API eval (50/50 on test model)
│   ├── generate-questions.mjs   # Generate test questions from ground truth
│   ├── analyze-report.mjs       # Analyze eval results, recommend fixes
│   ├── pipeline.mjs             # Pipeline orchestrator (parse → validate → eval)
│   ├── Dockerfile               # Container for running eval (Rust + Node)
│   ├── run.sh                   # Runner script for Docker
│   └── models/                  # Place .xlsx files here (gitignored)
├── lib/                         # Shared JS financial libraries
│   ├── irr.mjs                  # IRR/XIRR solver
│   ├── waterfall.mjs            # PE distribution waterfall
│   ├── calibration.mjs          # Auto-calibration framework
│   ├── sensitivity.mjs          # Sensitivity surface analysis
│   └── excel-parser.mjs         # Excel reader + sheet fingerprinting
├── tests/synthetic-pe-model/    # Integration test (sensitivity validation)
├── docs/                        # Historical pipeline logs and plans
├── CLAUDE.md                    # This file
├── README.md, CHANGELOG.md, ROADMAP.md, PLAN.md
└── .gitignore
```

## Two Pipelines

### Rust Pipeline (fast, automated)
Best for large models (50+ sheets, millions of cells). Parses Excel in seconds, transpiles formulas to JS, generates per-sheet modules with convergence loops for circular references.

```bash
# Build the parser
cd pipelines/rust && cargo build --release

# Parse a model (outputs chunked/ directory with per-sheet .mjs modules)
./target/release/rust-parser model.xlsx output-dir --chunked

# Run containerized eval loop (auto-improves with Claude API)
cd eval && ./run.sh
```

### JS Reasoning Pipeline (Claude-driven)
Best for smaller models where you need Claude to understand the financial logic. Uses the skill to orchestrate a 4-phase pipeline: Analyze → Generate → Test → Dashboard.

The skill is at `pipelines/js-reasoning/skill/SKILL.md`. Triggers on: "Convert this Excel model", "Build an engine from this spreadsheet".

## How to Run Eval

### Blind Eval (independent validation)
```bash
# 1. Parse the model
./pipelines/rust/target/release/rust-parser model.xlsx output-dir --chunked

# 2. Generate test questions
node eval/generate-questions.mjs output-dir/chunked --count 50 --output output-dir/test-questions.json

# 3. Run blind eval (needs ANTHROPIC_API_KEY)
node eval/blind-eval.mjs output-dir/chunked --questions output-dir/test-questions.json

# 4. Analyze results
node eval/analyze-report.mjs output-dir/eval-report.json output-dir/analysis.json
```

### Containerized Auto-Iteration
```bash
cd eval
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
cp /path/to/models/*.xlsx models/
./run.sh
```

## Key Libraries (lib/)

| File | Purpose |
|------|---------|
| `lib/irr.mjs` | Newton-Raphson IRR solver with bisection fallback + XIRR |
| `lib/waterfall.mjs` | PE distribution waterfall (American + European structures) |
| `lib/calibration.mjs` | Auto-calibration with ratio/offset modes |
| `lib/sensitivity.mjs` | Sensitivity surface extraction, comparison, multi-point calibration |
| `lib/excel-parser.mjs` | Excel reader, sheet fingerprinting, year detection, field mapping |

## Templates

Located at `pipelines/js-reasoning/templates/`:
- `engine-template.js` — Engine skeleton with calibration system
- `eval-template.mjs` — Eval suite template
- `dashboard/` — HTML dashboard (Tailwind + Chart.js, zero build step)

## Important Notes

- Public open-source project — never include proprietary data, real financials, or participant names
- All examples use synthetic/dummy data
- Licensed under MIT

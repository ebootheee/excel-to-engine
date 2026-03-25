# excel-to-engine

> Convert complex financial Excel models into live, testable JavaScript computation engines.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What It Does

Takes a `.xlsx` financial model (PE fund models, real estate waterfalls, DCF analyses, corporate M&A) and produces:

1. **Per-sheet JS modules** — Each Excel sheet becomes a self-contained `.mjs` file with all formulas transpiled to JavaScript
2. **An orchestrator** (`engine.js`) — Wires sheets together in dependency order, handles circular references with convergence loops
3. **Ground truth** — Every cell value from Excel, for automated accuracy testing
4. **A blind eval system** — Independent validation using Claude API with zero knowledge of the engine's internals

## Two Pipelines

### Rust Pipeline (fast, automated) — `pipelines/rust/`

Best for large models. Parses Excel with calamine (10-50x faster than SheetJS), transpiles formulas to JS, generates per-sheet modules. Handles 3.7M cells in ~3 minutes.

```bash
cd pipelines/rust && cargo build --release
./target/release/rust-parser model.xlsx output-dir --chunked
```

**Outputs:** `chunked/sheets/*.mjs` + `engine.js` + `_ground-truth.json` + `_graph.json`

### JS Reasoning Pipeline (Claude-driven) — `pipelines/js-reasoning/`

Best for smaller models where Claude should understand the financial logic. Uses the `excel-to-engine` skill to orchestrate: Analyze → Generate → Test → Dashboard.

```
Open in Claude Code → "Convert this Excel model into a JavaScript engine"
```

## Quick Start

### Prerequisites

- Node.js 18+
- Rust toolchain (for the Rust pipeline): `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Docker (for containerized eval)

### Using the Rust Pipeline

```bash
# 1. Build the parser
cd pipelines/rust && cargo build --release

# 2. Parse a model
./target/release/rust-parser /path/to/model.xlsx ./output --chunked

# 3. Run blind eval (validates engine independently)
cd ../../eval
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
node generate-questions.mjs ../output/chunked --count 50 --output ../output/test-questions.json
node blind-eval.mjs ../output/chunked --questions ../output/test-questions.json
node analyze-report.mjs ../output/eval-report.json ../output/analysis.json
```

### Containerized Auto-Iteration (overnight runs)

```bash
cd eval
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
cp /path/to/models/*.xlsx models/
./run.sh
```

Processes all models sequentially: parse → eval → Claude API diagnosis → patch transpiler → rebuild → re-eval → loop until 90% accuracy or 30 iterations.

## Project Structure

```
excel-to-engine/
├── pipelines/
│   ├── rust/                    # Rust parser + formula transpiler
│   │   ├── src/                 # parser, transpiler, chunked_emitter, dependency, formula_ast, etc.
│   │   ├── tests/               # Synthetic model (27/27 = 100%)
│   │   └── Cargo.toml
│   └── js-reasoning/            # Claude-reasoning pipeline
│       ├── skill/SKILL.md       # Claude Code skill definition
│       ├── templates/           # Engine, eval, dashboard templates
│       └── eval-framework/      # Blind testing tools
├── eval/                        # Unified eval (works with both pipelines)
│   ├── iterate.mjs              # Auto-iteration loop
│   ├── blind-eval.mjs           # Blind Claude API eval
│   ├── generate-questions.mjs   # Question generator
│   ├── analyze-report.mjs       # Analysis reporter
│   ├── pipeline.mjs             # Pipeline orchestrator
│   ├── Dockerfile               # Container (Rust + Node)
│   └── run.sh                   # Docker runner
├── lib/                         # Shared JS libraries
│   ├── irr.mjs                  # IRR/XIRR solver
│   ├── waterfall.mjs            # PE distribution waterfall
│   ├── calibration.mjs          # Auto-calibration
│   ├── sensitivity.mjs          # Sensitivity surface analysis
│   └── excel-parser.mjs         # Excel reader + fingerprinting
├── tests/synthetic-pe-model/    # Integration test
└── docs/                        # Historical logs
```

## Accuracy Results

| Model | Size | Sheets | Cells | Rust Pipeline | Blind Eval |
|-------|------|--------|-------|--------------|------------|
| Synthetic (3-sheet PE) | 3 KB | 3 | 78 | 100% (27/27) | 100% (10/10) |
| Mid-size (38 sheets) | 21 MB | 38 | 1.7M | 75.9% | 100% (50/50) |
| Large (82 sheets) | 52 MB | 82 | 3.7M | 43.9% | In progress |

## Libraries

| Library | Purpose |
|---------|---------|
| `lib/irr.mjs` | Newton-Raphson IRR with bisection fallback, XIRR for irregular dates |
| `lib/waterfall.mjs` | American + European PE waterfall structures |
| `lib/calibration.mjs` | Scale factor calibration against Excel targets |
| `lib/sensitivity.mjs` | Surface extraction, slope comparison, breakpoint detection, multi-point calibration |
| `lib/excel-parser.mjs` | Cell reading, sheet fingerprinting, year detection, field mapping |

## License

MIT

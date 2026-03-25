# excel-to-engine

> Convert complex financial Excel models into live, testable JavaScript computation engines.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What It Does

Takes a `.xlsx` financial model (PE fund models, real estate waterfalls, DCF analyses, corporate M&A) and produces:

1. **Per-sheet JS modules** — Each Excel sheet becomes a self-contained `.mjs` file with all formulas transpiled to JavaScript
2. **An orchestrator** (`engine.js`) — Wires sheets together in dependency order, handles circular references with convergence loops
3. **Ground truth** — Every cell value from Excel, for automated accuracy testing
4. **A blind eval system** — Independent validation using Claude API with zero knowledge of the engine's internals

## Development Journey

This project evolved through several architectural iterations, each solving a different scale problem:

### Timeline

| Date | Milestone | Key Metrics |
|------|-----------|-------------|
| Mar 19 | Core JS libraries (IRR, waterfall, calibration, Excel parser) | 6 libraries, ~3,100 lines |
| Mar 19 | Claude Code skill for 4-phase pipeline (Analyze → Generate → Test → Dashboard) | 42KB skill definition |
| Mar 21 | Sheet fingerprinting + multi-year extraction | 50+ financial term aliases, fuzzy matching |
| Mar 23 | Sensitivity surface validation + multi-point calibration | 40% → 100% accuracy on synthetic breakpoints |
| Mar 23 | Rust parser v1: monolithic engine generation | 2,789 lines of Rust, 1ms parse for test model |
| Mar 23 | **Problem**: 5.4GB JSON output for 1.3M formula models — OOM crashes |
| Mar 24 | Chunked compilation (Option C): per-sheet modules | 82 sheets compile in 3.5min, no OOM |
| Mar 24 | Convergence loops for circular references | 62-sheet circular cluster solved in ~5 iterations |
| Mar 24 | Auto-iteration container with Claude API | Parse → eval → diagnose → patch → rebuild → loop |
| Mar 24 | Rayon parallelization | 14min → 3:36 (3.8x speedup) |
| Mar 24 | Iterative Tarjan SCC | Handles 3M+ dependency nodes without stack overflow |
| Mar 25 | Blind eval system | 50/50 (100%) on 38-sheet model |
| Mar 25 | Repo restructure + merge to main | Two clean pipelines + unified eval |

### Scale Progression

| Metric | Synthetic | Mid-size (38 sheets) | Large (82 sheets) |
|--------|-----------|---------------------|-------------------|
| Excel file size | 3 KB | 21 MB | 52 MB |
| Total cells | 78 | 1,686,218 | 3,726,754 |
| Formula cells | 27 | 1,312,865 | 3,044,793 |
| Circular ref clusters | 1 (3 cells) | 0 | 1 (62 sheets) |
| Parse time | 1ms | 12s | 3.5min |
| Output (chunked) | 9 KB | ~90 MB | ~450 MB |
| Ground truth entries | 78 | 1,685,973 | 3,726,751 |

### Accuracy Progression

| Model | Initial | After Iteration | Blind Eval |
|-------|---------|----------------|------------|
| Synthetic (3-sheet PE) | 100% | 100% | 100% (10/10) |
| Mid-size (38 sheets) | 71.6% | 75.9% | 100% (50/50) |
| Large (82 sheets) | 40.7% | 43.9% | In progress |

### Key Technical Decisions

1. **Chunked compilation over monolithic** — Solved the 5.4GB JSON / OOM problem. Each sheet is a self-contained module with `ctx.get()`/`ctx.set()` interface. No single file exceeds a few MB.

2. **Ground truth from Excel, not engine** — The blind eval uses Excel's computed values directly, not the engine's output. This means we can validate the engine's accuracy independently.

3. **Blind eval with fresh Claude context** — The testing Claude has zero knowledge of the engine's internals. It gets a lookup tool and natural language questions. This prevents overfitting.

4. **Convergence loops for circular refs** — Financial models intentionally have circular references (interest ↔ debt ↔ cash flow). The Rust transpiler detects cycles via Tarjan's SCC and wraps them in iterative convergence loops.

5. **Per-sheet eval for memory safety** — Large models can't be evaluated monolithically (16GB+ heap). The eval runs each sheet independently against ground truth.

### Codebase Stats

| Component | Language | Lines | Files |
|-----------|----------|-------|-------|
| Rust parser + transpiler | Rust | ~5,000 | 8 modules |
| Eval tools | JavaScript | ~3,500 | 7 scripts |
| JS libraries | JavaScript | ~3,100 | 6 modules |
| Claude Code skill | Markdown | ~1,800 | 1 file |
| Templates | JS/HTML/CSS | ~1,200 | 5 files |
| **Total** | | **~14,600** | **27 files** |

### Excel Functions Transpiled

The Rust transpiler handles ~60 Excel functions covering arithmetic, logic, lookup, financial, text, date, and statistical operations:

`SUM`, `IF`, `MIN`, `MAX`, `ABS`, `ROUND`, `ROUNDUP`, `ROUNDDOWN`, `IRR`, `XIRR`, `NPV`, `PMT`, `PV`, `FV`, `RATE`, `NPER`, `VLOOKUP`, `HLOOKUP`, `INDEX`, `MATCH`, `SUMIF`, `SUMIFS`, `COUNTIF`, `COUNTIFS`, `SUMPRODUCT`, `SUBTOTAL`, `OFFSET`, `INDIRECT`, `AND`, `OR`, `NOT`, `IFERROR`, `ISERROR`, `ISBLANK`, `CONCATENATE`, `LEFT`, `RIGHT`, `MID`, `LEN`, `TRIM`, `UPPER`, `LOWER`, `TEXT`, `VALUE`, `DATE`, `YEAR`, `MONTH`, `DAY`, `EOMONTH`, `EDATE`, `LARGE`, `SMALL`, `RANK`, `AVERAGE`, `COUNT`, `COUNTA`, `INT`, `MOD`, `POWER`, `SQRT`, `LOG`, `LN`, `EXP`

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

### Using the Generated Engine

Once the engine is built, any Claude session (or any JS environment) can use it:

```javascript
import { run } from './chunked/engine.js';

// Run the full model
const result = run();
console.log(result.values['Summary!B5']); // Net IRR

// Override an input
const scenario = run({ 'Assumptions!B8': 15.0 }); // Exit multiple = 15x
console.log(scenario.values['Summary!B5']); // IRR under new scenario
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
│   │   ├── tests/               # Synthetic model (78/78 = 100%)
│   │   └── Cargo.toml
│   └── js-reasoning/            # Claude-reasoning pipeline
│       ├── skill/SKILL.md       # Claude Code skill definition
│       ├── templates/           # Engine, eval, dashboard templates
│       └── eval-framework/      # Blind testing tools
├── eval/                        # Unified eval (works with both pipelines)
│   ├── iterate.mjs              # Auto-iteration loop with Claude API
│   ├── blind-eval.mjs           # Blind Claude API eval (tool_use)
│   ├── generate-questions.mjs   # Question generator from ground truth
│   ├── analyze-report.mjs       # Analysis reporter with fix recommendations
│   ├── pipeline.mjs             # Pipeline orchestrator
│   ├── Dockerfile               # Container (Rust + Node)
│   └── run.sh                   # Docker runner (Mac + Windows)
├── lib/                         # Shared JS financial libraries
│   ├── irr.mjs                  # IRR/XIRR solver
│   ├── waterfall.mjs            # PE distribution waterfall
│   ├── calibration.mjs          # Auto-calibration
│   ├── sensitivity.mjs          # Sensitivity surface analysis
│   └── excel-parser.mjs         # Excel reader + fingerprinting
├── tests/synthetic-pe-model/    # Integration test
└── docs/                        # Historical pipeline logs
```

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

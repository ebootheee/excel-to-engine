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

Tested across 9 real financial models ranging from 2 to 82 sheets:

| Model Size | Sheets | Cells | Formulas | Parse Time | Output |
|------------|--------|-------|----------|------------|--------|
| 3 KB (synthetic) | 3 | 78 | 27 | 1ms | 9 KB |
| 332 KB | 2 | 5,684 | 5,271 | 56ms | 579 KB |
| 1.5 MB | 7 | 96,390 | 86,812 | 718ms | 9 MB |
| 21 MB | 38 | 1,686,218 | 1,312,865 | 12s | ~90 MB |
| 23 MB | 34 | ~1,400,000 | ~1,200,000 | ~3min | ~60 MB |
| 23 MB | 50 | ~1,500,000 | ~1,300,000 | ~4min | ~65 MB |
| 52 MB | 82 | 3,726,754 | 3,044,793 | 3.5min | ~450 MB |
| 77 MB | 20 | 5,817,116 | 5,580,221 | ~15min | ~200 MB |
| 84 MB | 20 | ~5,600,000 | ~5,400,000 | ~15min | ~200 MB |

### Accuracy — Blind Eval Results

Blind eval gives a fresh Claude API session zero knowledge of the engine's internals. It gets the parsed ground truth as a lookup tool and 25 randomized natural-language financial questions per model. Results across 6 production financial models:

| Model | Sheets | Cells | Blind Eval | Avg Tool Calls | Avg Time/Q |
|-------|--------|-------|------------|----------------|------------|
| Fund model A (2 sheets) | 2 | 5.7K | **25/25 (100%)** | 3.4 | 4.3s |
| Fund model B (7 sheets) | 7 | 96K | **25/25 (100%)** | 3.3 | 4.2s |
| Platform model A (51 sheets) | 51 | 1.8M | **25/25 (100%)** | 3.3 | 5.3s |
| Platform model B (60 sheets) | 60 | 1.8M | **25/25 (100%)** | 3.6 | 5.9s |
| Corporate model A (20 sheets) | 20 | 5.8M | **25/25 (100%)** | 3.5 | 5.0s |
| Corporate model B (21 sheets) | 21 | 6.1M | **24/25 (96%)** | 3.7 | 5.2s |
| **Total** | | **15.5M cells** | **149/150 (99.3%)** | 3.5 | 5.0s |

The single failure (Corporate model B) was a column ambiguity on a wide sheet — Claude found the correct row but returned a value from an adjacent column.

### Accuracy — Per-Sheet Cell Eval

Per-sheet eval tests every formula cell against Excel's computed value (mechanical, no LLM):

| Model | Per-Sheet Eval |
|-------|---------------|
| Synthetic (3-sheet PE) | 100% (78/78) |
| Mid-size (38 sheets) | 75.9% |
| Large (82 sheets) | 87.6% (2532/2890) |

### Key Technical Decisions

1. **Chunked compilation over monolithic** — Solved the 5.4GB JSON / OOM problem. Each sheet is a self-contained module with `ctx.get()`/`ctx.set()` interface. No single file exceeds a few MB.

2. **Ground truth from Excel, not engine** — The blind eval uses Excel's computed values directly, not the engine's output. This means we can validate the engine's accuracy independently.

3. **Blind eval with fresh Claude context** — The testing Claude has zero knowledge of the engine's internals. It gets a lookup tool and natural language questions. This prevents overfitting.

4. **Convergence loops for circular refs** — Financial models intentionally have circular references (interest ↔ debt ↔ cash flow). The Rust transpiler detects cycles via Tarjan's SCC and wraps them in iterative convergence loops.

5. **Per-sheet eval for memory safety** — Large models can't be evaluated monolithically (16GB+ heap). The eval runs each sheet independently against ground truth.

### Why This Approach (Token Economics)

A real-world example: querying the Outpost A-2 model (23MB Excel, 21 sheets, 6M cells, 5.8M formulas).

**What the Rust pipeline enables:**

| Approach | Feasible? | Tokens | Time | Accuracy |
|----------|-----------|--------|------|----------|
| **Rust parse → ground truth query** | **Yes** | **~165K** | **~10 min** | **Exact Excel values** |
| Load full XLSX into context | No | ~500M+ | Impossible | N/A |
| Load key sheets as CSV | Barely | ~5-40M | Exceeds context | Partial |
| Load just summary sheet | Yes | ~5K | 30 sec | Missing detail |

The ground truth JSON is 201MB / ~6M entries. A typical query session pulls targeted slices (20-30KB of actual data into the context window), costing ~$3-5 at Opus rates across ~12 tool calls.

**The token cost is roughly 3,000x smaller than trying to load the raw model**, and you get exact values instead of approximations. Without the pipeline, you'd need to manually identify which of 6M cells matter, extract them by hand, and paste them in — which is essentially what the pipeline automates.

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

### Step 1: Parse the Model

```bash
cd pipelines/rust && cargo build --release
./target/release/rust-parser /path/to/model.xlsx ./output --chunked
```

This produces `output/chunked/` with per-sheet `.mjs` modules, `engine.js` orchestrator, and `_ground-truth.json` (every cell value from Excel).

### Step 2: Run Blind Eval

The blind eval is an independent test — a fresh Claude API session with zero knowledge of the engine answers 50 randomized financial questions using only the engine's output data.

```bash
cd eval
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
node generate-questions.mjs ../output/chunked --count 50 --output ../output/test-questions.json
node blind-eval.mjs ../output/chunked --questions ../output/test-questions.json
node analyze-report.mjs ../output/eval-report.json ../output/analysis.json
```

The `analysis.json` output identifies which questions failed and why — providing specific, actionable fix recommendations.

### Step 3: Iterate with Claude Code

Open a **new Claude Code session** (clean context, no knowledge of the eval results) and give it the analysis:

```
Read eval/output/analysis.json. It contains failures from our blind eval.
Read the Rust transpiler at pipelines/rust/src/transpiler.rs.
Fix the top failure category, rebuild (cargo build --release), and re-parse the model.
```

This separation is intentional: **Step 2 tests honestly** (blind context), **Step 3 fixes intelligently** (full context). They never cross-contaminate.

### Step 4: Re-run Blind Eval

After fixes, re-parse and re-run the blind eval to measure improvement:

```bash
# Re-parse with updated transpiler
cd pipelines/rust
./target/release/rust-parser /path/to/model.xlsx ./output --chunked

# Re-run blind eval (same questions for fair comparison)
cd ../../eval
node blind-eval.mjs ../output/chunked --questions ../output/test-questions.json
node analyze-report.mjs ../output/eval-report.json ../output/analysis.json
```

Repeat Steps 3-4 until accuracy reaches target.

### Using the Generated Engine

Once the engine passes eval, any Claude session (or any JS environment) can use it:

```javascript
import { run } from './chunked/engine.js';

// Run the full model
const result = run();
console.log(result.values['Summary!B5']); // Net IRR

// Override an input
const scenario = run({ 'Assumptions!B8': 15.0 }); // Exit multiple = 15x
console.log(scenario.values['Summary!B5']); // IRR under new scenario
```

### Containerized Auto-Iteration (overnight, hands-off)

For unattended runs, the Docker container automates the full loop:

```bash
cd eval
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
cp /path/to/models/*.xlsx models/
./run.sh
```

Processes all models: parse → eval → Claude API diagnosis → patch transpiler → rebuild → re-eval → loop until 90% accuracy or 30 iterations. Results in `eval/output/`.

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

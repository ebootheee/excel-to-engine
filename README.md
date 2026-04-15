# excel-to-engine

> Convert complex financial Excel models into live, testable JavaScript computation engines. Two engines: (1) A Claude SKILL that can build an entire Javascript engine; (2) A Rust-based parallelized transpiler with 60+ predefined Excel functions. Use the Claude SKILL for simple models (100-40,000 cells), and use the Rust transpiler for big models with circular/iterative logic, multi-sheet/file references, and complex formula logic (40,000-6,000,000 cells).
> Point Claude (preferably Claude Code, 'bypass permissions' highly recommended as this calls A LOT of tools) at this repo and tell it to read up, 'git clone' and execute on your preferred method. Ensure it has access to your target XLSX files in the same folder.
> Once it is done building, you have a fully functioning code-based mathematicall replica of your target model with a 99% reduced context window and 5-10x the processing speed with AI agents and applications.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What It Does

Takes a `.xlsx` financial model (PE fund models, real estate waterfalls, DCF analyses, corporate M&A) and produces:

1. **Per-sheet JS modules** — Each Excel sheet becomes a self-contained `.mjs` file with all formulas transpiled to JavaScript
2. **An orchestrator** (`engine.js`) — Wires sheets together in dependency order, handles circular references with convergence loops
3. **Ground truth** — Every cell value from Excel, for automated accuracy testing
4. **A blind eval system** — Independent validation using Claude API with zero knowledge of the engine's internals; can run as a simple script, or can point a Claude or OpenAI API key to it and generate random queries for the model with progressive difficulty (good for production runs where others will blindly accept your outputs)
Tested across 9 financial models from 3KB to 84MB (2–82 sheets, up to 6M cells). Blind eval accuracy: **99.3%** (149/150 questions across 15.5M cells).

## Quick Start

### For Agents

- Read CLAUDE.md and guide your user through the repo clone, dependency installs, and choosing the right engine creator per this README file. Utilize eval tools to ensure accuracy (script-based, blind agent-based eval with token, and iterative Docker instance all available)

### Prerequisites

- Node.js 18+
- Rust toolchain: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`

### 1. Build the parser

```bash
cd pipelines/rust && cargo build --release
```

### 2. Parse an Excel model

```bash
./target/release/rust-parser /path/to/model.xlsx ./output --chunked
```

Produces `output/chunked/` with per-sheet `.mjs` modules, `engine.js` orchestrator, and `_ground-truth.json` (every cell value from Excel).

### 3. Use the engine

```javascript
import { run } from './output/chunked/engine.js';

// Run the full model
const result = run();
console.log(result.values['Summary!B5']); // Net IRR

// Override an input
const scenario = run({ 'Assumptions!B8': 15.0 }); // Exit multiple = 15x
console.log(scenario.values['Summary!B5']); // IRR under new scenario
```

## Claude Code Prompts

The toolkit is designed to work with Claude Code. Here are the primary workflows:

### Parse a model and explore it

```
Parse model.xlsx with the Rust parser and tell me what's in it.
```

Claude will build the parser (if needed), run it, and summarize the sheets, cell counts, and key financial metrics found in ground truth.

### Convert a model into a computation engine

```
Convert this Excel model into a JavaScript engine.
```

Triggers the JS Reasoning pipeline skill (`pipelines/js-reasoning/skill/SKILL.md`). Claude analyzes the model, generates an engine, runs tests, and builds a dashboard — 4-phase pipeline.

### Ask questions about a parsed model

```
Read the ground truth for my parsed model in output/chunked/ and tell me:
what is the fund's gross IRR, net MOIC, and total carry?
```

Claude looks up specific cells in `_ground-truth.json` to answer. Works with any model, any size.

### Run blind eval

```
Run blind eval on my parsed model in output/chunked/ with 50 questions.
```

Claude generates test questions, runs them through a fresh API session with zero engine knowledge, and reports accuracy.

### Fix eval failures

```
Read eval/output/analysis.json. It contains failures from our blind eval.
Read the Rust transpiler at pipelines/rust/src/transpiler.rs.
Fix the top failure category, rebuild, and re-parse the model.
```

The builder session (full context) fixes issues identified by the eval session (blind context). They never cross-contaminate — this prevents overfitting.

### Build a downstream app from ground truth

```
I have a parsed financial model in engines/my-model/chunked/.
Build a carry calculator that reads base case values from the ground truth
and sensitizes carry proportionally to MOIC adjustments.
```

Claude reads `_ground-truth.json`, identifies the relevant waterfall cells, and builds an engine with `_sources` metadata for validation.

### Query ground truth for cell-level analysis

```
Load the ground truth for my model in output/chunked/_ground-truth.json.
What is the Technology segment's total revenue by year? What are the G&A
allocations to the tech segment? What if G&A consumed 100% of net new ARR?
```

Claude loads the ground truth JSON, finds labeled rows (e.g., `Technology!H23 = "Total Revenue"`), reads annual data across projection columns, and computes scenario deltas against base case returns. This uses the **ground truth + delta approach** — faster and more precise than the hand-crafted engine for questions that require segment-level P&L changes.

## Two-Tier Engine Workflow

The Rust pipeline produces two outputs that serve different use cases. **Keep both:**

| Tier | Files | Use For | Speed |
|------|-------|---------|-------|
| **1: Hand-crafted engine** | `engine.js` + `shared.js` | MOIC/IRR sensitivity, carry, exit year, dashboard sliders | Milliseconds |
| **2: Ground truth + chunked** | `_ground-truth.json` + `sheets/*.mjs` | Segment P&L, G&A reallocation, cost line items, any cell-level question | Seconds (GT lookup) |

**When to use which:** If the question maps to a named input (exit multiple, carry rate, exit year), Tier 1. If it requires changing something inside a segment P&L that the engine doesn't expose, Tier 2.

**Ground truth + delta** (recommended for Tier 2): Load `_ground-truth.json`, find the cells by label, read the data, compute your scenario delta, and apply it to base case returns. This avoids running the full chunked engine (8GB heap, 10+ minutes).

```javascript
import { readFileSync } from 'fs';
const gt = JSON.parse(readFileSync('./output/chunked/_ground-truth.json', 'utf-8'));

// Find cells by label
const revenueRows = Object.entries(gt)
  .filter(([k, v]) => typeof v === 'string' && /Total Revenue/i.test(v))
  .filter(([k]) => k.startsWith('Technology!'));

// Read annual data, compute delta, apply to base MOIC/IRR
const cols = ['L','M','N','O','P','Q'];
const techRev = cols.map(c => gt['Technology!' + c + '23'] || 0);
// ... see SKILL.md for complete example
```

## Validate Engine Values

If you build a downstream engine that stores base case values from ground truth (e.g., a carry calculator or scenario dashboard), add `_sources` metadata and validate before deploying:

```javascript
export const VEHICLE_A = {
  _sources: {
    groundTruth: 'my-model',             // directory containing _ground-truth.json
    cells: {
      totalCarry: 'Waterfall!D86',       // direct cell lookup
      grossMOIC: 'Summary!C15',
      'tiers.catchUp': 'Waterfall!D61',  // dot-path into nested objects
    },
    aggregates: {                         // optional: sum across multiple cells
      totalCarry: {
        cells: ['ClassA!D86', 'ClassB!D86'],
        op: 'sum',
      },
    },
  },
  base: {
    totalCarry: 49_287_893,
    grossMOIC: 2.56,
    tiers: { catchUp: 16_152_014 },
  },
};
```

```bash
# Validate all exports with _sources against ground truth
node eval/validate-engine.mjs ./my-engine.js --gt-root ./parsed-models/

# Strict mode (0.01% tolerance — catches display rounding)
node eval/validate-engine.mjs ./my-engine.js --gt-root ./parsed-models/ --strict

# JSON output for CI integration
node eval/validate-engine.mjs ./my-engine.js --gt-root ./parsed-models/ --json
```

The validator reads each `_sources.cells` entry, looks it up in `_ground-truth.json`, and flags mismatches beyond tolerance. Catches wrong-sheet, wrong-model, and arithmetic-estimate errors before they ship.

## Eval Pipeline

### Blind eval

A fresh Claude API session with zero knowledge of the engine answers randomized financial questions using only ground truth as a lookup tool.

```bash
cd eval
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
node generate-questions.mjs ../output/chunked --count 50 --output ../output/test-questions.json
node blind-eval.mjs ../output/chunked --questions ../output/test-questions.json
node analyze-report.mjs ../output/eval-report.json ../output/analysis.json
```

### One-command full eval

```bash
node eval/run-all.mjs model.xlsx --questions 50 --output output/
```

Runs: parse → generate questions → blind eval → per-sheet eval → combined report.

### Containerized auto-iteration (overnight, hands-free)

```bash
cd eval
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
cp /path/to/models/*.xlsx models/
./run.sh
```

Processes all models: parse → eval → Claude API diagnosis → patch transpiler → rebuild → re-eval → loop until 90% accuracy or 30 iterations.

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
│   ├── validate-engine.mjs      # Validate engine _sources against ground truth
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

## Accuracy

### Blind Eval (99.3%)

A fresh Claude API session with zero knowledge of the engine's internals gets ground truth as a lookup tool and 25 randomized natural-language financial questions per model:

| Model | Sheets | Cells | Blind Eval | Avg Tool Calls | Avg Time/Q |
|-------|--------|-------|------------|----------------|------------|
| Fund model A (2 sheets) | 2 | 5.7K | **25/25 (100%)** | 3.4 | 4.3s |
| Fund model B (7 sheets) | 7 | 96K | **25/25 (100%)** | 3.3 | 4.2s |
| Platform model A (51 sheets) | 51 | 1.8M | **25/25 (100%)** | 3.3 | 5.3s |
| Platform model B (60 sheets) | 60 | 1.8M | **25/25 (100%)** | 3.6 | 5.9s |
| Corporate model A (20 sheets) | 20 | 5.8M | **25/25 (100%)** | 3.5 | 5.0s |
| Corporate model B (21 sheets) | 21 | 6.1M | **24/25 (96%)** | 3.7 | 5.2s |
| **Total** | | **15.5M cells** | **149/150 (99.3%)** | 3.5 | 5.0s |

### Per-Sheet Cell Eval

Tests every formula cell against Excel's computed value (mechanical, no LLM):

| Model | Per-Sheet Eval |
|-------|---------------|
| Synthetic (3-sheet PE) | 100% (78/78) |
| Mid-size (38 sheets) | 75.9% |
| Large (82 sheets) | 87.6% (2532/2890) |

### Scale Progression

Tested across 9 financial models:

| Model Size | Sheets | Cells | Formulas | Parse Time |
|------------|--------|-------|----------|------------|
| 3 KB (synthetic) | 3 | 78 | 27 | 1ms |
| 332 KB | 2 | 5,684 | 5,271 | 56ms |
| 1.5 MB | 7 | 96,390 | 86,812 | 718ms |
| 21 MB | 38 | 1.7M | 1.3M | 12s |
| 23 MB | 34–50 | 1.4–1.5M | 1.2–1.3M | 3–4min |
| 52 MB | 82 | 3.7M | 3.0M | 3.5min |
| 77–84 MB | 20–21 | 5.6–5.8M | 5.4–5.6M | ~15min |

### Excel Functions Transpiled (~60)

`SUM`, `IF`, `MIN`, `MAX`, `ABS`, `ROUND`, `ROUNDUP`, `ROUNDDOWN`, `IRR`, `XIRR`, `NPV`, `PMT`, `PV`, `FV`, `RATE`, `NPER`, `VLOOKUP`, `HLOOKUP`, `INDEX`, `MATCH`, `SUMIF`, `SUMIFS`, `COUNTIF`, `COUNTIFS`, `SUMPRODUCT`, `SUBTOTAL`, `OFFSET`, `INDIRECT`, `AND`, `OR`, `NOT`, `IFERROR`, `ISERROR`, `ISBLANK`, `CONCATENATE`, `LEFT`, `RIGHT`, `MID`, `LEN`, `TRIM`, `UPPER`, `LOWER`, `TEXT`, `VALUE`, `DATE`, `YEAR`, `MONTH`, `DAY`, `EOMONTH`, `EDATE`, `LARGE`, `SMALL`, `RANK`, `AVERAGE`, `COUNT`, `COUNTA`, `INT`, `MOD`, `POWER`, `SQRT`, `LOG`, `LN`, `EXP`

## Design

### Architecture: Game Engine Parallels

The Rust transpiler shares core design patterns with video game engines — both evaluate a massive graph of interdependent computations efficiently, handling cycles through iterative convergence while keeping memory bounded by modularizing the workload.

| Concept | Game Engine | Excel-to-Engine |
|---------|-------------|-----------------|
| **Asset Pipeline** | Raw assets → compiled runtime formats | Raw Excel formulas → transpiled JS modules |
| **Scene Graph** | Directed graph; parent transforms propagate | Cell dependency graph; upstream values propagate |
| **Physics Solver** | Iterative constraint solving for feedback loops, ~10-20 iterations/frame | Convergence loops for circular refs (interest ↔ debt ↔ cash flow), ~5-200 iterations |
| **Per-Asset Modules** | Each mesh/shader/texture self-contained | Each sheet a self-contained `.mjs` module |
| **Deterministic Simulation** | Same inputs → same frame, every tick | Same inputs → same cell values, every evaluation |

### Key Technical Decisions

1. **Chunked compilation over monolithic** — Solved the 5.4GB JSON / OOM problem. Each sheet is a self-contained module. No single file exceeds a few MB.
2. **Ground truth from Excel, not engine** — Blind eval uses Excel's computed values directly, validating engine accuracy independently.
3. **Blind eval with fresh Claude context** — The testing Claude has zero knowledge of the engine. This prevents overfitting.
4. **Convergence loops for circular refs** — Financial models intentionally have circular references. The transpiler detects cycles via Tarjan's SCC and wraps them in iterative convergence loops.
5. **Per-sheet eval for memory safety** — Large models can't be evaluated monolithically (16GB+ heap). Eval runs each sheet independently.

### Token Economics

A real-world example: querying a 23MB model (21 sheets, 6M cells).

| Approach | Feasible? | Tokens | Accuracy |
|----------|-----------|--------|----------|
| **Rust parse → ground truth query** | **Yes** | **~165K** | **Exact Excel values** |
| Load full XLSX into context | No | ~500M+ | N/A |
| Load key sheets as CSV | Barely | ~5-40M | Partial |
| Load just summary sheet | Yes | ~5K | Missing detail |

The ground truth JSON is 201MB / ~6M entries. A typical query pulls 20-30KB into context (~$3-5 at Opus rates). **~3,000x smaller than loading the raw model.**

## License

MIT

# Rust Engine Pipeline — Plan

## Vision

Replace the slow, Claude-reasoning-heavy engine generation loop with a fast, containerized pipeline:

```
Excel (.xlsx)
    │
    ▼  ← Rust (calamine)
┌──────────────────┐
│  Fast Parse       │  Parse all sheets, build cell graph, extract formulas
│  + Transpile      │  Convert Excel formulas → JS expressions
└────────┬─────────┘
         │  model-map.json + dependency-graph.json + raw-engine.js
         ▼  ← Node.js in container
┌──────────────────┐
│  Eval & Iterate   │  Run engine, compare to Excel values,
│  (automated)      │  adjust calibration, re-run, loop
└────────┬─────────┘
         │  engine.js (calibrated) + eval-results.json + sensitivity-surface.json
         ▼  ← Only when iteration plateaus
┌──────────────────┐
│  Claude Reasoning │  Diagnose remaining failures, fix logic errors,
│  (on-demand)      │  handle edge cases that brute-force can't solve
└──────────────────┘
```

**Key insight**: Most of the iteration loop is mechanical (parse, run, compare, adjust). Only the "why is this output wrong and how do I fix the formula?" step needs reasoning. By doing the mechanical work in Rust + Node at native speed, Claude gets a pre-optimized engine with clear diagnostics about what's still broken.

## Decisions (from user input)

- **Formula coverage**: INDEX/MATCH and VLOOKUP are the primary lookup patterns. OFFSET and array formulas are low priority. No macros needed.
- **Circular references**: YES — build an iterative solver. Real financial models have circular refs (interest ↔ debt ↔ cash flow). The transpiler must detect cycles in the dependency graph and wrap them in a convergence loop.
- **Named ranges**: Low priority — most target models use cell references. Support basic named range resolution but don't over-invest here.
- **Container registry**: GitHub Container Registry. Test locally with Docker first. Future deployment target is Cloudflare Containers (not now).

## Architecture

### Component 1: `rust-parser/` — Rust Excel Parser + Transpiler

**Crate**: Binary that reads `.xlsx` and outputs structured JSON + JS.

**Dependencies**:
- `calamine` — Fast XLSX/XLS/ODS parser (10-50x faster than SheetJS)
- `serde` / `serde_json` — JSON serialization

**Outputs**:
1. **`model-map.json`** — Same schema as current (v1.1.0) but generated in <500ms even for 84-sheet workbooks
2. **`dependency-graph.json`** — Cell dependency DAG: which cells reference which, topologically sorted. Circular refs identified and grouped into convergence clusters.
3. **`formulas.json`** — Every formula cell with its parsed AST and transpiled JS expression
4. **`raw-engine.js`** — Auto-generated JS engine where each formula is directly transpiled (no human reasoning needed). Circular ref clusters wrapped in iterative convergence loops.

**Excel Functions to Transpile** (covers ~90% of financial models):

| Excel Function | JS Transpilation |
|---|---|
| `SUM(A1:A10)` | `[a1, a2, ..., a10].reduce((a,b) => a+b, 0)` |
| `IF(cond, true, false)` | `(cond) ? true : false` |
| `MIN/MAX` | `Math.min/Math.max` |
| `ABS/ROUND/ROUNDUP/ROUNDDOWN` | `Math.abs/Math.round/Math.ceil/Math.floor` |
| `IRR(range)` | `computeIRR([...])` (from lib/irr.mjs) |
| `XIRR(values, dates)` | `computeXIRR([...])` (from lib/irr.mjs) |
| `NPV(rate, range)` | `npv(rate, [...])` |
| `SUMPRODUCT` | Zip + multiply + sum |
| `INDEX/MATCH` | Array lookup (primary lookup pattern) |
| `VLOOKUP/HLOOKUP` | Table search |
| `AND/OR/NOT` | `&&` / `\|\|` / `!` |
| `+, -, *, /, ^` | Direct operators |
| `IFERROR/ISERROR` | `try/catch` or `isNaN` guard |
| `CONCATENATE/&` | Template literals |
| Cell references | Variable names (`sheet_A1`) |
| Cross-sheet refs | `sheets['Sheet1'].A1` |

**Circular Reference Handling**:
1. Detect cycles in the dependency graph (Tarjan's SCC algorithm)
2. Group circular cells into "convergence clusters"
3. In the generated engine, wrap each cluster in an iterative loop:
   ```javascript
   // Convergence cluster: interest ↔ debt ↔ cashFlow
   let _prev = {}, _maxIter = 100, _tol = 0.0001;
   for (let _i = 0; _i < _maxIter; _i++) {
     interest = debtBalance * rate;
     cashFlow = revenue - opex - interest;
     debtBalance = initialDebt - cashFlow * repaymentRate;
     if (Math.abs(interest - (_prev.interest || 0)) < _tol) break;
     _prev = { interest, cashFlow, debtBalance };
   }
   ```
4. Report convergence stats in diagnostics (iterations needed, final residual)

**WASM target**: The Rust binary also compiles to WASM, so the parser can run in-browser for the dashboard's "upload and analyze" flow.

### Component 2: `container/` — Docker Pipeline

**Dockerfile**: Multi-stage build
- Stage 1: Rust build (compile parser binary)
- Stage 2: Node.js 20 runtime + Rust binary + our JS libs

**Pipeline script** (`container/pipeline.mjs`):

```
1. PARSE:    rust-parser model.xlsx → model-map.json + formulas.json + raw-engine.js
2. VALIDATE: node validate-extraction.mjs (cross-sheet validation)
3. EVAL:     node eval-loop.mjs raw-engine.js
             - Run engine at base case, compare to Excel targets
             - Extract sensitivity surface
             - Run multi-point calibration (lib/sensitivity.mjs)
             - Loop: adjust calibration → re-eval → check improvement
             - Exit when: accuracy > 95% OR improvement < 0.5% per iteration OR max 20 iterations
4. OUTPUT:   engine.js (calibrated) + eval-results.json + sensitivity-surface.json + diagnostics.json
```

**diagnostics.json** — What Claude gets when automated iteration plateaus:
```json
{
  "finalScore": 87.3,
  "iterations": 12,
  "convergenceClusters": [
    { "cells": ["B12", "B15", "B18"], "convergedIn": 8, "residual": 0.00003 }
  ],
  "stuckOutputs": [
    {
      "key": "waterfall.gpCarry",
      "error": "23.4%",
      "atInputs": { "exitMultiple": 1.6 },
      "diagnosis": "slope_mismatch_near_breakpoint",
      "excelValue": 2610000,
      "engineValue": 4900000,
      "suggestion": "Waterfall pref hurdle may use compound interest — engine uses simple"
    }
  ],
  "surfaceComparison": { ... },
  "breakpointMismatches": [ ... ]
}
```

### Component 3: Browser Monitor Dashboard

A local web UI that shows the pipeline running in real time. Runs alongside the container on `localhost:3000`.

**Features**:
- **Live pipeline status**: Which phase is running (Parse → Transpile → Eval → Iterate), with timing
- **Console log stream**: Real-time stdout/stderr from the container via WebSocket
- **Iteration progress**: Chart showing accuracy score per iteration (watch it converge)
- **Dependency graph visualization**: Interactive DAG of cell dependencies, circular clusters highlighted
- **Sensitivity surface heatmap**: Live-updating as the eval loop runs
- **Diagnostics panel**: When iteration plateaus, shows the stuck outputs and suggested fixes
- **Upload & Run**: Drag-drop an .xlsx to kick off the pipeline

**Stack**: Vanilla HTML + Chart.js + WebSocket (no build step, consistent with the rest of the project). The container exposes a WS endpoint that streams progress events.

### Component 4: WASM Build (Stretch)

The Rust parser compiles to two targets:
- **Native binary** (x86_64-linux for Docker, aarch64-apple-darwin for local)
- **WASM** (`wasm32-wasi` or `wasm32-unknown-unknown` with wasm-bindgen)

The WASM build enables:
- Browser-side Excel parsing (upload .xlsx, get model-map instantly)
- Dashboard "analyze" button that doesn't need a server
- Future: Cloudflare Containers deployment

## File Structure

```
excel-to-engine/
├── rust-parser/
│   ├── Cargo.toml
│   ├── src/
│   │   ├── main.rs           # CLI entry point
│   │   ├── parser.rs         # Excel parsing (calamine)
│   │   ├── formula_ast.rs    # Excel formula → AST parser
│   │   ├── transpiler.rs     # AST → JavaScript code generation
│   │   ├── dependency.rs     # Cell dependency graph + cycle detection (Tarjan's SCC)
│   │   ├── circular.rs       # Convergence cluster generation for circular refs
│   │   └── model_map.rs      # model-map.json generation
│   └── tests/
├── container/
│   ├── Dockerfile            # Multi-stage: Rust build + Node.js runtime
│   ├── pipeline.mjs          # Orchestration: parse → validate → eval → output
│   ├── eval-loop.mjs         # Automated eval + multi-point calibration loop
│   ├── validate-extraction.mjs
│   └── monitor/              # Browser monitor dashboard
│       ├── index.html        # Live pipeline monitor UI
│       ├── monitor.js        # WebSocket client + Chart.js visualizations
│       └── server.mjs        # Express + WS server streaming pipeline events
├── lib/                      # Existing JS libs (unchanged)
├── skill/                    # Updated to reference pipeline
└── ...
```

## Implementation Phases

### Phase 1: Rust Parser + CLI (Session 1)
- Set up `rust-parser/` Cargo project with `calamine` + `serde`
- Parse workbook → enumerate sheets, read all cells (values + formulas)
- Output `model-map.json` matching current schema (v1.1.0)
- Output `formulas.json` with raw formula strings + cell metadata
- Build dependency graph with cycle detection (Tarjan's SCC)
- Output `dependency-graph.json` with topological order and convergence clusters
- Test: parse a synthetic test workbook, verify output matches expected JSON

### Phase 2: Formula Transpiler (Session 1-2)
- Build Excel formula tokenizer (handle operators, functions, cell refs, strings, numbers)
- Parse tokens into AST (recursive descent parser)
- Implement JS code generation for the full function set above
- Handle cross-sheet references (`Sheet1!A1` → `sheets.Sheet1.A1`)
- Generate `raw-engine.js` with:
  - Dependency-ordered variable declarations
  - Circular ref clusters wrapped in convergence loops
  - `computeModel(inputs)` export matching existing API contract
- Test: transpiled engine produces same values as calamine-read cell values

### Phase 3: Docker Pipeline + Eval Loop (Session 2)
- Dockerfile: multi-stage (Rust build → Node.js runtime)
- `pipeline.mjs`: orchestrates parse → validate → eval-loop → output
- `eval-loop.mjs`: automated iteration using lib/sensitivity.mjs + lib/calibration.mjs
  - Base case eval → sensitivity surface → multi-point calibration → re-eval → loop
  - Convergence detection: stop when accuracy > 95% or improvement < 0.5%
  - Output: engine.js (calibrated) + diagnostics.json
- Test locally: `docker build . && docker run -v ./model.xlsx:/data/model.xlsx pipeline`

### Phase 4: Browser Monitor (Session 2-3)
- Express + WebSocket server that streams pipeline events
- HTML dashboard with:
  - Phase progress bar with timing
  - Live console log stream
  - Iteration accuracy chart (line chart, score per iteration)
  - Dependency graph visualization (highlight circular clusters)
  - Diagnostics panel for stuck outputs
- Upload & run: drag-drop .xlsx → starts pipeline → watch progress
- No build step — vanilla HTML + Chart.js + WS

### Phase 5: WASM Target (Stretch)
- `wasm-pack` build for browser use
- JS bindings for parse + transpile
- Integration with dashboard template

## What This Changes

**Before**: Claude reads Excel → reasons about formulas → writes engine.js → runs eval → reasons about failures → fixes → repeats (minutes per iteration, uses API tokens)

**After**: Rust parses Excel → transpiles formulas → Node runs eval loop → calibrates automatically → only hands off to Claude when stuck (seconds per iteration, zero API tokens for the mechanical work)

**Expected speedup**:
- Parse: 5s → <500ms (10x)
- Initial engine generation: 3-5min (Claude) → <2s (transpiler)
- Eval iteration: 20 automated iterations in <10s vs 3-5 manual Claude cycles over 15min
- Total pipeline: 15-30min → <30s for the automated part, then Claude only touches the hard cases

# excel-to-engine

> Turn a complex financial Excel model into a live, testable JavaScript computation engine — in one Claude Code session.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What It Does

A Claude Code skill + reusable library set that takes a `.xlsx` financial model (PE fund models, real estate waterfalls, DCF analyses, corporate M&A) and produces:

1. **`engine.js`** — A pure JavaScript computation engine that replicates the model's calculations, calibrated to match Excel at base case
2. **`tests/eval.mjs`** — An automated test suite that validates accuracy against the original Excel
3. **`dashboard/`** — A zero-build interactive HTML dashboard with input sliders, sensitivity heatmaps, and eval results

## Architecture

The project uses a two-layer architecture:

```
Layer 1: Deterministic Transpilation (Rust)
  Excel (.xlsx) → Parse (calamine) → Formula AST → JavaScript
  Handles: ~60 Excel functions, circular refs, cross-sheet deps
  Output: raw-engine.js (mechanically correct, cell-ref variable names)

Layer 2: LLM Semantic Layer (Claude)
  raw-engine.js → Naming, structure, gap-filling → engine.js
  Handles: Input/output identification, dashboards, testing, docs
  Calibration used for verification + fallback on unsupported formulas
```

The Rust transpiler is the **primary path** — it produces correct JS deterministically in milliseconds. The LLM operates on the transpiled output rather than reverse-engineering Excel math.

## Prerequisites

- **Node.js 18+**
- **npm** (for xlsx package)
- **Rust toolchain** (optional — for building the transpiler from source)

```bash
npm install
```

## Quick Start

### Using Claude Code (Recommended)

Open this project in Claude Code and say:

> "Convert this Excel model into a JavaScript engine"

The `excel-to-engine` skill will guide the pipeline automatically.

### Using the Rust Transpiler Directly

```bash
# Build the transpiler
cd rust-parser && cargo build --release

# Transpile an Excel model
./target/release/rust-parser model.xlsx output/
# Produces: model-map.json, formulas.json, dependency-graph.json, raw-engine.js
```

### Using the Container Pipeline

```bash
# Run the full automated pipeline
docker build -t excel-to-engine container/
docker run -v ./model.xlsx:/data/model.xlsx excel-to-engine
# Produces: calibrated engine.js + eval-results.json + diagnostics.json
```

### Using the JS Libraries Directly

```javascript
import { loadWorkbook, buildModelMap } from './lib/excel-parser.mjs';
import { computeIRR } from './lib/irr.mjs';
import { computeWaterfall } from './lib/waterfall.mjs';
import { calibrate } from './lib/calibration.mjs';

// 1. Parse Excel
const wb = loadWorkbook('path/to/model.xlsx');
const modelMap = buildModelMap(wb);

// 2. Use the libraries directly
const irr = computeIRR([-1000, 200, 200, 200, 200, 200, 200, 200, 200]);
console.log(`IRR: ${(irr * 100).toFixed(2)}%`);

// 3. Compute a waterfall
const result = computeWaterfall(
  200_000_000,  // net proceeds
  100_000_000,  // equity basis
  [
    { name: 'Return of Capital', hurdle: 0, lpSplit: 1.0, gpSplit: 0.0, type: 'return_of_capital' },
    { name: 'Preferred Return', hurdle: 0.08, lpSplit: 1.0, gpSplit: 0.0 },
    { name: 'GP Catch-Up', hurdle: 0, lpSplit: 0.0, gpSplit: 1.0, type: 'catchup', catchupTarget: 0.20 },
    { name: 'Residual 80/20', hurdle: Infinity, lpSplit: 0.80, gpSplit: 0.20 },
  ],
  { holdPeriodYears: 5 }
);
```

## Project Structure

```
excel-to-engine/
├── rust-parser/              # Layer 1: Deterministic transpilation
│   ├── src/
│   │   ├── main.rs           # CLI entry point
│   │   ├── parser.rs         # Excel parsing (calamine, 10-50x faster than SheetJS)
│   │   ├── formula_ast.rs    # Excel formula tokenizer + AST parser
│   │   ├── transpiler.rs     # AST → JavaScript code generation (~60 functions)
│   │   ├── dependency.rs     # Cell dependency graph + Tarjan's SCC cycle detection
│   │   ├── circular.rs       # Convergence loop generation for circular refs
│   │   └── model_map.rs      # Model map + raw engine generation
│   └── tests/
├── container/                # Automated pipeline (Docker)
│   ├── Dockerfile            # Multi-stage: Rust build → Node.js runtime
│   ├── pipeline.mjs          # Orchestration: parse → validate → eval → output
│   ├── eval-loop.mjs         # Automated calibration loop
│   └── monitor/              # Browser dashboard for pipeline progress
├── lib/                      # Layer 2: JS libraries (used by LLM + pipeline)
│   ├── irr.mjs               # Newton-Raphson IRR solver (+ XIRR)
│   ├── waterfall.mjs         # PE distribution waterfall calculator
│   ├── calibration.mjs       # Auto-calibration framework (verification + fallback)
│   ├── sensitivity.mjs       # Sensitivity surface validation + multi-point calibration
│   ├── self-eval.mjs         # Interactive self-eval with diagnostics
│   └── excel-parser.mjs      # Excel reader + sheet fingerprinting
├── auto-iterate/             # Claude API-driven improvement loop
│   └── iterate.mjs           # Diagnose stuck outputs via LLM, patch, re-eval
├── templates/
│   ├── engine-template.js    # Engine skeleton with calibration system
│   └── dashboard/            # HTML dashboard (Tailwind CDN + Chart.js)
├── eval-framework/           # Blind testing framework
│   ├── generate-control.mjs
│   └── compare-outputs.mjs
├── tests/
│   └── synthetic-pe-model/   # Sensitivity validation proof-of-concept
├── skill/
│   └── SKILL.md              # Claude Code skill definition
├── CLAUDE.md                 # Instructions for Claude Code (architecture philosophy)
├── ROADMAP.md                # What's next
├── CHANGELOG.md              # What's been done
└── PLAN.md                   # Project status
```

## Libraries

### `lib/irr.mjs` — IRR Solver

Newton-Raphson with bisection fallback. Handles edge cases (no sign change, divergence).

```javascript
import { computeIRR, computeXIRR, npv } from './lib/irr.mjs';

computeIRR([-100, 150]);           // 0.5 (50%)
computeIRR([-1000, 0, 0, 2000]);   // ~0.2599

// Irregular dates
computeXIRR([
  { date: new Date('2024-01-01'), amount: -1000 },
  { date: new Date('2026-06-15'), amount: 1500 },
]);
```

### `lib/waterfall.mjs` — Distribution Waterfall

Supports standard American and European PE waterfall structures.

```javascript
import { computeWaterfall, createAmericanWaterfall, createEuropeanWaterfall } from './lib/waterfall.mjs';

// Quick American-style 80/20 with 8% pref
const tiers = createAmericanWaterfall({
  prefReturn: 0.08,
  carryPercent: 0.20,
  residualLPSplit: 0.80,
});
const result = computeWaterfall(200e6, 100e6, tiers, { holdPeriodYears: 5 });
```

### `lib/calibration.mjs` — Calibration Framework

Computes scale factors to match engine outputs to known Excel values at base case.

```javascript
import { calibrate, applyCalibration, validateOutputs } from './lib/calibration.mjs';

const { factors, converged } = calibrate(
  computeModel, BASE_CASE,
  [
    { key: 'returns.grossMOIC', excelValue: 2.15 },
    { key: 'returns.netIRR', excelValue: 0.1847 },
  ]
);
```

### `lib/sensitivity.mjs` — Sensitivity Surface Validation

Captures how outputs *respond to input changes*, not just their static values. Detects breakpoints (waterfall hurdles, MIP thresholds), compares slopes between engine and Excel, and provides multi-point calibration that works across the full input range.

```javascript
import {
  extractSurface, compareSurfaces, computeElasticity,
  detectBreakpoints, multiPointCalibrate, printSensitivityReport,
} from './lib/sensitivity.mjs';

// Extract how the engine responds to exit multiple changes
const engineSurface = extractSurface(computeModel, BASE_CASE, {
  exitMultiple: { min: 14, max: 26, steps: 7 },
});

// Compare against Excel's response surface
const comparison = compareSurfaces(engineSurface, excelSurface);
printSensitivityReport(comparison);
// Shows: level errors, slope errors, breakpoint mismatches

// Multi-point calibration: piecewise corrections instead of flat scale factors
const { corrections, apply } = multiPointCalibrate(computeModel, BASE_CASE, excelSurface);
const correctedOutput = apply(rawOutput, inputs);
```

### `lib/excel-parser.mjs` — Excel Reader + Sheet Fingerprinting

Reads cells, detects model structure, builds model maps. Includes automated sheet fingerprinting, fuzzy label matching, year detection, multi-year extraction, escalation detection, and asset classification.

```javascript
import {
  loadWorkbook, readCell, detectInputCells, buildModelMap,
  fingerprintWorkbook, detectYearRow, extractByYear,
  extractMultiYear, detectEscalation, classifyAsset,
} from './lib/excel-parser.mjs';

const wb = loadWorkbook('model.xlsx');

// Auto-detect row mappings across identically-structured sheets
const { commonPattern, commonSheets } = fingerprintWorkbook(wb);

// Detect year columns and extract data for a reference year
const yearInfo = detectYearRow(wb, commonSheets[0]);
const data = extractByYear(wb, commonSheets[0], 2026, { fieldMap: commonPattern, yearInfo });

// Detect rent escalation rates
const rentByYear = extractMultiYear(wb, commonSheets[0], commonPattern.rent.row, yearInfo.columnMap);
const escalation = detectEscalation(rentByYear);

// Auto-classify asset type
const type = classifyAsset(data.fields);
```

## How It Works

### Primary Path: Rust Transpiler

The Rust transpiler deterministically converts Excel formulas to JavaScript:

1. **Parse** — Read all sheets, cells, and formulas with calamine (10-50x faster than SheetJS)
2. **Build dependency graph** — Map which cells reference which, detect circular refs (Tarjan's SCC)
3. **Transpile** — Convert each formula AST to a JS expression, ordered topologically
4. **Handle circular refs** — Wrap circular clusters in convergence loops with tolerance checks
5. **Output** — `raw-engine.js` with a `computeModel(inputs)` export

The transpiler handles ~60 Excel functions (SUM, IF, IRR/XIRR, INDEX/MATCH, VLOOKUP, etc.). Unknown functions emit a `_fn('NAME', [...args])` placeholder for the LLM to fill.

### Calibration (Verification + Fallback)

After transpilation, calibration confirms the engine matches Excel:

- **Single-point**: Scale factors at base case — fast, works when transpilation is complete
- **Multi-point**: Piecewise-linear corrections across input range — handles waterfall hurdles and MIP thresholds where response curves are nonlinear

Calibration is a **verification step** for the transpiler's output, and a **fallback** for the ~5% of formulas the transpiler can't yet handle. The goal is to shrink the calibration surface over time as transpiler coverage grows.

## Eval Framework

The project includes tools for validating engine accuracy:

### Self-Eval (during development)

```javascript
import { selfEval, printComparisonTable, diagnoseFailures } from './lib/self-eval.mjs';

const result = selfEval(computeModel, BASE_CASE, EXCEL_TARGETS);
printComparisonTable(result);
// Shows: Metric | Engine | Excel | Status
//        Gross MOIC | 2.50x | 2.35x | ⚠️ 6.4%

const fixes = diagnoseFailures(result.results.filter(r => !r.pass));
// Returns: [{ priority: 1, category: 'waterfall', fix: 'lpTotal should be netProceeds - gpCarry' }]
```

### Control Baseline (for blind testing)

```bash
# Generate a control baseline from a reference engine
node eval-framework/generate-control.mjs ./reference/engine.js

# Score a candidate engine against the baseline
node eval-framework/compare-outputs.mjs ./candidate/
```

### Interactive Improvement Loop

The skill supports an interactive eval cycle — build the engine, see where it's off, fix, repeat:

1. **Run 1 improvement cycle** — fix worst failures, re-eval
2. **Auto-loop until >95%** — autonomous fixing (max 5 iterations)
3. **Accept current state** — lock the engine and proceed
4. **Show detailed analysis** — failure diagnostics with fix suggestions

## Using Your Engine

After the engine is built and locked, you can use it anywhere:

### In Claude Code or Claude Chat
```
Upload engine.js to a Claude Project as knowledge.
Ask: "Run the model with exit multiple 22x and tell me the IRR."
```

### In a Web App
```html
<script type="module">
  import { computeModel } from './engine.js';
  const result = computeModel({ exitMultiple: 22 });
  document.getElementById('irr').textContent =
    (result.returns.grossIRR * 100).toFixed(1) + '%';
</script>
```

### As an API
```javascript
import { computeModel } from './engine.js';
app.get('/api/model', (req, res) => {
  const result = computeModel(req.query);
  res.json(result);
});
```

### With the Dashboard
```bash
# Open the interactive dashboard
npx serve dashboard/
# or just open dashboard/index.html in any browser
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run the test suite: `node tests/eval.mjs`
5. Submit a pull request

### Design Principles

- **Zero build step** — Dashboard works by opening index.html
- **Pure functions** — All library functions are side-effect free
- **ES modules** — Modern import/export throughout
- **Practical accuracy** — Calibration over exact replication
- **Financial-first** — Built for PE, RE, and fund models

## License

MIT

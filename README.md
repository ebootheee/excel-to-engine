# excel-to-engine

> Turn a complex financial Excel model into a live, testable JavaScript computation engine — in one Claude Code session.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What It Does

A Claude Code skill + reusable library set that takes a `.xlsx` financial model (PE fund models, real estate waterfalls, DCF analyses, corporate M&A) and produces:

1. **`engine.js`** — A pure JavaScript computation engine that replicates the model's calculations, calibrated to match Excel at base case
2. **`tests/eval.mjs`** — An automated test suite that validates accuracy against the original Excel
3. **`dashboard/`** — A zero-build interactive HTML dashboard with input sliders, sensitivity heatmaps, and eval results

## Architecture

![excel-to-engine pipeline: 4 phases from Excel file through Parse & Analyze, Generate Engine, Generate Tests, to Generate Dashboard](docs/architecture.png)

## Prerequisites

- **Node.js 18+**
- **npm** (for xlsx package)

```bash
npm install
```

## Quick Start

### Using Claude Code (Recommended)

Open this project in Claude Code and say:

> "Convert this Excel model into a JavaScript engine"

The `excel-to-engine` skill will guide the 4-phase pipeline automatically.

### Manual Usage

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
├── lib/
│   ├── irr.mjs            # Newton-Raphson IRR solver (+ XIRR)
│   ├── waterfall.mjs       # PE distribution waterfall calculator
│   ├── calibration.mjs     # Auto-calibration framework
│   ├── sensitivity.mjs     # Sensitivity surface validation + multi-point calibration
│   ├── self-eval.mjs       # Interactive self-eval with diagnostics
│   └── excel-parser.mjs    # Excel reader + sheet fingerprinting
├── templates/
│   ├── engine-template.js  # Engine skeleton with calibration system
│   └── dashboard/
│       ├── index.html      # 2-tab dashboard template
│       ├── styles.css      # Styling (works with Tailwind CDN)
│       └── app.js          # Dashboard logic (reads engine + model map)
├── eval-framework/         # Blind testing framework
│   ├── generate-control.mjs
│   └── compare-outputs.mjs
├── tests/
│   └── synthetic-pe-model/ # Sensitivity validation test
│       ├── engine.js       # Buggy engine (simple interest pref)
│       ├── excel-surface.mjs # Ground truth (compound interest)
│       └── test-sensitivity.mjs
├── skill/
│   └── SKILL.md            # Claude Code skill definition
├── package.json
├── CLAUDE.md               # Instructions for Claude Code
├── README.md               # This file
├── PLAN.md
├── CHANGELOG.md
├── ROADMAP.md
└── LICENSE
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

## How Calibration Works

Financial models in Excel use hundreds of intermediate formulas. Replicating every cell exactly in JavaScript is impractical. Instead, excel-to-engine:

1. Implements the core economic logic (growth, discounting, waterfall splits)
2. Runs the engine at base case inputs
3. Compares each output against the known Excel value
4. Computes a multiplicative scale factor: `factor = excelValue / engineValue`
5. Applies factors to all subsequent computations

This means the engine is exact at base case and approximately correct for nearby inputs. The eval suite validates that deviations stay within tolerance across the input range.

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

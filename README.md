# excel-to-engine

Convert complex financial Excel models into JavaScript computation engines with auto-generated test suites and interactive dashboards.

## What It Does

Takes a `.xlsx` financial model (PE fund models, real estate waterfalls, DCF analyses) and produces:

1. **`engine.js`** — A pure JavaScript computation engine that replicates the model's calculations, calibrated to match Excel at base case
2. **`tests/eval.mjs`** — An automated test suite that validates accuracy against the original Excel
3. **`dashboard/`** — A zero-build interactive HTML dashboard with input sliders, sensitivity heatmaps, and eval results

## Architecture

```
Excel File (.xlsx)
       │
       ▼
┌─────────────────┐
│  Phase 1: Parse │  excel-parser.mjs reads cells, detects inputs/outputs,
│  & Analyze      │  identifies financial patterns (IRR, waterfall, DCF)
└────────┬────────┘
         │  model-map.json
         ▼
┌─────────────────┐
│  Phase 2:       │  Translates Excel logic into JS using engine-template.js
│  Generate       │  Auto-calibrates against Excel base case values
│  Engine         │  Uses lib/irr.mjs + lib/waterfall.mjs
└────────┬────────┘
         │  engine.js
         ▼
┌─────────────────┐
│  Phase 3:       │  Reads expected values from Excel, compares with engine
│  Generate       │  Tests: base case accuracy, monotonicity, consistency
│  Tests          │  Outputs eval-results.json
└────────┬────────┘
         │  tests/eval.mjs
         ▼
┌─────────────────┐
│  Phase 4:       │  Copies dashboard template, wires up engine + model map
│  Generate       │  Sliders, charts, heatmaps — no build step
│  Dashboard      │  Open index.html in any browser
└─────────────────┘
```

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
│   └── excel-parser.mjs    # Excel reader + cell detection
├── templates/
│   ├── engine-template.js  # Engine skeleton with calibration system
│   └── dashboard/
│       ├── index.html      # 2-tab dashboard template
│       ├── styles.css      # Styling (works with Tailwind CDN)
│       └── app.js          # Dashboard logic (reads engine + model map)
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

Computes scale factors to match engine outputs to known Excel values.

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

### `lib/excel-parser.mjs` — Excel Reader

Reads cells, detects model structure, builds model maps.

```javascript
import { loadWorkbook, readCell, detectInputCells, buildModelMap } from './lib/excel-parser.mjs';

const wb = loadWorkbook('model.xlsx');
const cell = readCell(wb, 'Summary', 'B12');
const inputs = detectInputCells(wb);
const map = buildModelMap(wb);
```

## How Calibration Works

Financial models in Excel use hundreds of intermediate formulas. Replicating every cell exactly in JavaScript is impractical. Instead, excel-to-engine:

1. Implements the core economic logic (growth, discounting, waterfall splits)
2. Runs the engine at base case inputs
3. Compares each output against the known Excel value
4. Computes a multiplicative scale factor: `factor = excelValue / engineValue`
5. Applies factors to all subsequent computations

This means the engine is exact at base case and approximately correct for nearby inputs. The eval suite validates that deviations stay within tolerance across the input range.

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

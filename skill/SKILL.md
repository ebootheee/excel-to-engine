---
name: excel-to-engine
description: Convert a complex financial Excel model into a JavaScript computation engine with auto-generated test suite and interactive dashboard
triggers:
  - convert this Excel model
  - build an engine from this spreadsheet
  - financial model to code
  - excel to javascript engine
  - turn this spreadsheet into code
  - generate engine from Excel
  - create computation engine
---

# excel-to-engine

Convert a financial Excel model (.xlsx) into a JavaScript computation engine with calibration, automated tests, and an interactive dashboard.

## Overview

This skill runs a 4-phase pipeline:

1. **Analyze** — Parse the Excel file, identify inputs/outputs/intermediates, detect financial patterns
2. **Generate** — Create `engine.js` with calibrated computations matching Excel at base case
3. **Test** — Generate `tests/eval.mjs` that validates engine accuracy against Excel
4. **Dashboard** — Generate an interactive HTML dashboard with sliders, charts, and eval results

## Prerequisites

- Node.js 18+
- The xlsx npm package: `npm install xlsx`
- The Excel file (.xlsx) must be accessible at a known path

## Phase 1 — Analyze

Read the Excel workbook and produce a `model-map.json` that describes the model structure.

### Steps

1. **Load the workbook** using the excel-parser library:

```javascript
import { loadWorkbook, buildModelMap } from './lib/excel-parser.mjs';

const wb = loadWorkbook('/path/to/model.xlsx');
const modelMap = buildModelMap(wb, {
  inputSheets: ['Assumptions', 'Inputs'],   // Adjust to actual sheet names
  outputSheets: ['Summary', 'Returns'],      // Adjust to actual sheet names
});
```

2. **Review detected inputs and outputs.** The parser identifies:
   - **Input cells**: Numeric values with no formula that are referenced by formulas elsewhere
   - **Output cells**: Formula cells that are NOT referenced by other formulas (end of chain)
   - **Intermediates**: Formula cells that ARE referenced by other formulas

3. **Detect financial patterns** — The parser looks for:
   - IRR/XIRR formulas
   - NPV/XNPV formulas (DCF)
   - Waterfall/distribution sheets
   - Sensitivity/scenario tables
   - Cash flow timelines

4. **Produce `model-map.json`** with this structure:

```json
{
  "version": "1.0.0",
  "modelName": "Example Fund Model",
  "generatedAt": "2025-01-15T10:30:00Z",
  "excelFile": "model.xlsx",
  "sheets": ["Assumptions", "Cash Flows", "Waterfall", "Summary"],
  "inputs": [
    {
      "name": "Acquisition Price",
      "sheet": "Assumptions",
      "cell": "C5",
      "type": "number",
      "format": "currency",
      "baseCase": 50000000,
      "range": [25000000, 100000000],
      "referencedBy": 12
    }
  ],
  "outputs": [
    {
      "name": "Gross MOIC",
      "key": "returns.grossMOIC",
      "sheet": "Summary",
      "cell": "C15",
      "type": "number",
      "format": "multiple",
      "baseCase": 2.15
    }
  ],
  "intermediateCount": 234,
  "patterns": {
    "hasIRR": true,
    "hasMOIC": true,
    "hasWaterfall": true,
    "hasSensitivity": false
  }
}
```

5. **Ask the user to confirm/adjust the model map.** Show them:
   - The detected inputs (name, base case value, inferred range)
   - The detected outputs (name, base case value)
   - Detected patterns
   - Ask: "Does this look right? Should I add/remove any inputs or outputs?"

### Important Notes

- Not all detected input cells are meaningful model inputs. Filter by `referencedBy` count and let the user curate.
- Add human-readable `format` hints: "currency", "percent", "multiple", "integer", "years"
- Add `key` to outputs mapping to the engine return structure (e.g., "returns.grossMOIC")
- The `range` for each input should be a reasonable sensitivity range (50%-200% of base case for most; tighter for percentages)

## Phase 2 — Generate

Create `engine.js` as an ES module. Use `templates/engine-template.js` as the starting skeleton.

### Steps

1. **Copy the template** to the project directory as `engine.js`

2. **Fill in BASE_CASE** from model-map.json inputs:

```javascript
export const BASE_CASE = {
  acquisitionPrice: 50_000_000,
  equityInvested: 25_000_000,
  holdPeriodYears: 5,
  exitCapRate: 0.055,
  // ... all inputs from model-map.json
};
```

3. **Implement `_computeRaw(inputs)`** — the core calculation logic:
   - Replicate the Excel's calculation chain in JavaScript
   - Use `computeIRR()` from `lib/irr.mjs` for IRR calculations
   - Use `computeWaterfall()` from `lib/waterfall.mjs` for distribution waterfalls
   - Structure intermediate calculations to mirror the Excel's flow
   - When formulas are complex, simplify but preserve the economic logic

4. **Set EXCEL_TARGETS** with known-good values read from the Excel file:

```javascript
const EXCEL_TARGETS = {
  'returns.grossMOIC': 2.15,
  'returns.netMOIC': 1.89,
  'returns.grossIRR': 0.2134,
  'returns.netIRR': 0.1847,
  'waterfall.gpCarry': 5_200_000,
};
```

5. **The calibration system auto-initializes** on module load, computing scale factors for each target.

### Return Object Structure

The engine must return this structure:

```javascript
{
  inputs: { ...inputs },
  returns: {
    grossMOIC,     // Gross multiple on invested capital
    netMOIC,       // Net multiple (after fees and carry)
    grossIRR,      // Gross internal rate of return
    netIRR,        // Net IRR to LPs
  },
  exitValuation: {
    grossExitValue,  // Total exit proceeds
    netProceeds,     // After debt payoff
    // ... model-specific fields
  },
  waterfall: {
    lpTotal,         // Total LP distributions
    gpCarry,         // Total GP carried interest
    tiers,           // Per-tier breakdown
  },
  mip: {             // Management Incentive Plan (if applicable)
    triggered,       // Boolean
    payment,         // Total MIP payment
    valuePerShare,   // Per-share value
  },
  equityCashFlows: {
    years,           // [0, 1, 2, ..., N]
    draws,           // Negative cash flows (investments)
    distributions,   // Positive cash flows (returns)
  },
  perShare: {
    gross,
    net,
  },
}
```

### Key Principles

- **Match Excel at base case.** The calibration system handles small deviations, but the core logic should be close.
- **Use the library functions.** `lib/irr.mjs` for IRR, `lib/waterfall.mjs` for waterfalls, `lib/calibration.mjs` for calibration.
- **Keep it readable.** Name variables clearly, add comments explaining the financial logic.
- **Handle edge cases.** Division by zero, negative values, missing inputs should all produce safe defaults.

## Phase 3 — Test

Generate `tests/eval.mjs` that validates the engine against Excel.

### Steps

1. **Create `tests/eval.mjs`** with these test categories:

```javascript
import XLSX from 'xlsx';
import { computeModel, BASE_CASE } from '../engine.js';
import { readCell } from '../lib/excel-parser.mjs';

const EXCEL_PATH = '../path/to/model.xlsx';
const TOLERANCE = 0.01; // 1% tolerance

// ---- Test 1: Base Case Accuracy ----
// Read expected values directly from Excel cells
// Compare engine output at BASE_CASE against Excel within tolerance

// ---- Test 2: Input Cascade ----
// For each input, vary it across its range (5 steps)
// Verify engine doesn't throw errors and outputs are reasonable

// ---- Test 3: Monotonicity Invariants ----
// Higher acquisition price → lower MOIC (all else equal)
// Higher equity → lower leverage → different IRR profile
// Higher exit cap rate → lower exit value

// ---- Test 4: Internal Consistency ----
// LP distributions + GP carry = Net proceeds
// Gross returns > Net returns (fees reduce returns)
// MOIC > 0 when proceeds > 0
// IRR sign matches MOIC direction (MOIC > 1 → IRR > 0)
```

2. **Test structure:**

```javascript
async function runEval() {
  const wb = XLSX.readFile(EXCEL_PATH);
  const results = {
    baseCaseResults: [],
    monotonicityResults: [],
    consistencyResults: [],
    tolerance: TOLERANCE,
    timestamp: new Date().toISOString(),
  };

  // Run all tests...
  // Print clear pass/fail report
  // Write results to tests/eval-results.json for the dashboard

  console.log('\n' + '='.repeat(60));
  console.log(allPassed ? '  ALL TESTS PASSED' : '  SOME TESTS FAILED');
  console.log('='.repeat(60));

  // Write results for dashboard consumption
  fs.writeFileSync('tests/eval-results.json', JSON.stringify(results, null, 2));
}
```

3. **Run with:** `node tests/eval.mjs`

### Monotonicity Invariants to Check

These are common financial invariants. Adapt to the specific model:

| Input Change | Expected Output Direction |
|---|---|
| Higher acquisition price | Lower MOIC, lower IRR |
| Higher exit value | Higher MOIC, higher IRR |
| Longer hold period | Lower IRR (same MOIC) |
| Higher leverage | Higher equity MOIC (if profitable) |
| Higher management fees | Lower net returns |
| Higher cap rate (exit) | Lower exit value |
| Higher preferred return | More to LP, less GP carry |

### Consistency Checks

- `LP distributions + GP carry ≈ Net distributable proceeds`
- `Gross MOIC > Net MOIC` (fees and carry reduce returns)
- `Gross IRR > Net IRR`
- `MOIC > 1.0 ↔ IRR > 0`
- `Total cash in = Total equity drawn`
- `Waterfall tiers sum = Total distributed`

## Phase 4 — Dashboard

Generate an interactive HTML dashboard from `templates/dashboard/`.

### Steps

1. **Copy the dashboard template** to the project's `dashboard/` directory

2. **Replace template placeholders** in `app.js`:
   - `{{ENGINE_PATH}}` → relative path to engine.js (e.g., `'../engine.js'`)
   - `{{MODEL_MAP_PATH}}` → relative path to model-map.json (e.g., `'../model-map.json'`)
   - `{{EVAL_DATA_PATH}}` → relative path to eval results (e.g., `'../tests/eval-results.json'`)

3. **Replace title placeholder** in `index.html`:
   - `{{MODEL_NAME}}` → model name from model-map.json

4. **Test the dashboard** by opening `dashboard/index.html` in a browser:
   - Verify sliders control all inputs
   - Verify output cards update in real-time
   - Verify sensitivity heatmap renders
   - Verify cash flow and waterfall charts display
   - If eval data exists, verify eval tab shows results

### Dashboard Features

**Tab 1 — Model Explorer:**
- Output cards showing key metrics (MOIC, IRR, etc.) with delta from base case
- Input sliders auto-generated from model-map.json
- 2D sensitivity heatmap (select any two inputs + one output)
- Cash flow bar chart (draws vs distributions by year)
- Waterfall chart (LP vs GP by tier)

**Tab 2 — Eval Results:**
- Summary banner (pass/fail count)
- Base case accuracy table (expected vs actual vs deviation)
- Deviation distribution chart
- Monotonicity test results
- Internal consistency check results

### No Build Step

The dashboard uses:
- Tailwind CSS via CDN
- Chart.js via CDN
- ES modules for engine import

Just open `index.html` in a browser. For local development, use a simple server:
```bash
npx serve dashboard/
```

## Project Structure

After running the full pipeline, the project should look like:

```
your-model/
├── engine.js              ← Generated computation engine
├── model-map.json         ← Model structure definition
├── tests/
│   ├── eval.mjs           ← Test suite
│   └── eval-results.json  ← Test results (generated by eval.mjs)
├── dashboard/
│   ├── index.html         ← Interactive dashboard
│   ├── styles.css
│   └── app.js
└── lib/                   ← Shared libraries (symlinked or copied)
    ├── irr.mjs
    ├── waterfall.mjs
    ├── calibration.mjs
    └── excel-parser.mjs
```

## Tips

- **Start with the Summary sheet.** Most financial models have a summary sheet with the key outputs. Start there and work backward to find inputs.
- **Don't replicate every formula.** Focus on the economic logic, not cell-by-cell replication. The calibration system handles small differences.
- **Test early.** Run `eval.mjs` after Phase 2 to see how close you are. Iterate on the engine logic until base case accuracy is within 1%.
- **Use named ranges.** If the Excel model uses named ranges, they make great input/output identifiers.
- **Ask the user.** Financial models have nuances that automated detection can't capture. Always confirm the model map with the user.

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

## Financial Terminology Mapping

Financial models use inconsistent terminology across firms and sectors. When analyzing an Excel model, map any of these equivalent terms to the standardized engine output field names.

### Incentive Structures

All of these refer to the same economic concept — a performance-based payout to operators/managers carved from investment returns:

| Term | Context |
|------|---------|
| MIP (Management Incentive Plan) | PE operating companies |
| Profit Interest Plan / Profit Share | Pass-through entities, LLCs |
| Promote | Real estate partnerships |
| Carried Interest Pool | Operating company level (not fund level) |
| Performance Allocation | Tax/legal documents |
| Value Creation Plan (VCP) | European PE |
| Long-Term Incentive Plan (LTIP) | Corporate, listed companies |
| Phantom Equity Plan | Non-equity-issuing entities |
| Co-Investment Plan | GP/management co-invest structures |

Map all of these to `mip.payment`, `mip.triggered`, `mip.valuePerShare` in the engine output.

### Waterfall / Distribution Terms

| Standardized | Equivalent Terms |
|---|---|
| Distribution Waterfall | Promote Structure, Carried Interest Waterfall |
| Return Hurdle | Preferred Return, Pref, Hurdle Rate |
| Catch-Up | GP Catch-Up, Make-Whole |
| Residual Split | Back-End Split, Tail Economics |
| GP Promote | GP Carry, GP Performance Fee |
| LP Preferred Return | LP Pref, LP Hurdle |
| GP Co-Invest | GP Commitment, GP Capital |

Map to `waterfall.lpTotal`, `waterfall.gpCarry`, `waterfall.tiers`.

### Return Metrics

| Standardized | Equivalent Terms |
|---|---|
| MOIC | MoC, Multiple on Invested Capital, Money Multiple, Return Multiple |
| IRR | Internal Rate of Return, Annualized Return |
| Gross | Pre-Carry, Pre-Promote, Pre-Fee |
| Net | Post-Carry, Post-Promote, Post-Fee, After Carry |

Map to `returns.grossMOIC`, `returns.netMOIC`, `returns.grossIRR`, `returns.netIRR`.

### Share/Unit Economics

| Standardized | Equivalent Terms |
|---|---|
| Issuance Price | Strike Price, Grant Price, Unit Price, Share Price |
| PPS (Price Per Share) | Per Share, Per Unit, Value Per Share |
| Pool | Allocation Pool, Share Pool, Unit Pool |
| Dilution | Pool Percentage, Participation Rate |

Map to `perShare.gross`, `perShare.net`, `mip.valuePerShare`.

### How to Apply

When analyzing an Excel model, if you encounter any term in the "Equivalent Terms" column, treat it as the standardized term in the "Standardized" column. Use the standardized engine output field names (`grossMOIC`, `netIRR`, `lpTotal`, `gpCarry`, `mipPayment`, etc.) regardless of what the Excel model calls them.

---

## Parallelization Guidance

### Phase 1 (Analyze) — Parallelize sheet reads

- Read multiple Excel sheets simultaneously using separate agent calls
- Look for summary/cheat sheet/overview tabs FIRST before diving into detail sheets
- If multi-series model (e.g. A-1 + A-2), the later series usually contains the earlier — focus extraction on the most complete sheet

### Phase 2 (Generate) — Parallelize engine builds

- If multi-series, build both engines concurrently as separate agents
- Each engine should be self-contained (own BASE_CASE, own calibration)
- Combine after both are built

### Phase 3 (Test) — Sequential then parallel

- Build base-case test FIRST (sequential — needs calibration)
- Then run cascade tests in parallel batches

### Phase 4 (Dashboard) — After engines pass tests

- Only build dashboard after engines achieve >90% accuracy on eval

### When NOT to parallelize

- Calibration (must be sequential — base case first, then scale factors)
- Waterfall debugging (iterative by nature)

---

## Phase 1 — Analyze

Read the Excel workbook and produce a `model-map.json` that describes the model structure.

### Cheat Sheet Pattern

Before diving into detailed sheets, search for tabs named "Summary", "Cheat Sheet", "Overview", "Dashboard", or "Key Metrics". These often contain the base case inputs and outputs in a condensed format, saving significant analysis time. Extract base case values from these tabs first, then cross-reference with detail sheets only as needed.

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

### CRITICAL: Base Case Value Extraction

**The most common source of engine failure is incorrect base case values.** You MUST extract the EXACT base case from the Excel, not approximate or round them.

1. **Input values must be EXACT**: If the Excel shows an exit multiple of `18.22`, use `18.22` — NOT `18` or `18.2`. Read the cell value directly.
2. **Cross-reference multiple sheets**: The same input may appear in "Assumptions", "Inputs", AND "Summary" sheets. They should agree. If they don't, use the "Assumptions" tab value.
3. **Use Python openpyxl for precision**: When xlsx (SheetJS) returns rounded values, fall back to Python:
   ```python
   from openpyxl import load_workbook
   wb = load_workbook('model.xlsx', data_only=True)
   ws = wb['Assumptions']
   exit_multiple = ws['G7'].value  # Gets the exact computed value
   ```
4. **BASE_CASE must contain the exact values the Excel uses for its "base case" scenario.** Look for scenario selectors, toggle cells, or "Base Case" labels.

### CRITICAL: Net Proceeds Calculation (Sources & Uses Bridge)

Net equity proceeds follow this universal formula across ALL financial models:

```
Net Proceeds = Gross Exit Value - Transaction Costs - Debt Payoff + Cash at Exit
```

Where:
- **Gross Exit Value** = sum of all asset/segment exit values
- **Transaction Costs** = typically 1-3% of gross exit (look for "transaction costs", "closing costs", "disposition costs")
- **Debt Payoff** = GROSS debt outstanding at exit (not "net debt" — that already subtracts cash)
- **Cash at Exit** = cash/reserves on the balance sheet at exit date

**Common mistake**: Using "net debt" (debt - cash) instead of separately handling debt and cash. This causes a ~15% error in net proceeds.

### CRITICAL: Equity Basis Definition

Models define equity basis differently. You MUST determine which definition the Excel uses:

| Definition | Meaning | Typical Context |
|---|---|---|
| **Total Commitment** | Total equity pledged by LPs | Fund-level models |
| **Equity Deployed** | Capital actually drawn/invested | Operating company models |
| **Peak Equity** | Maximum cumulative equity outstanding | Waterfall/promote models |
| **Equity at Cost** | Sum of all equity draws (no distributions netted) | Cash flow models |

Look in the Excel's "Equity" or "Cash Flow" sheet for the cell that feeds into MOIC: `MOIC = Net Proceeds / [equity basis]`. That denominator IS the equity basis. Read it directly.

### CRITICAL: Waterfall Implementation

Distribution waterfalls are the #1 source of large deviations. **Do NOT simplify the waterfall.**

1. **Find the waterfall sheet**: Look for tabs named "GPP Promote", "Waterfall", "Distribution", "Carry", or "Promote Structure"
2. **Count the tiers**: Most PE waterfalls have 3-5 tiers. Read ALL of them:
   - Tier 1: LP Preferred Return (100% to LP until X% return achieved)
   - Tier 2: GP Catch-Up (50/50 or similar until GP has X% of total profit)
   - Tier 3+: Residual Split (e.g., 80/20 LP/GP)
   - Additional tiers may have higher GP shares above higher return hurdles
3. **Read the EXACT tier parameters from Excel**: hurdle rates, LP/GP split percentages, catch-up ratios
4. **Use `lib/waterfall.mjs`** with the exact tier structure:

```javascript
import { computeWaterfall } from './lib/waterfall.mjs';

const waterfall = computeWaterfall(netProceeds, equityBasis, [
  { name: 'Preferred Return', hurdle: 0.08, lpSplit: 1.0, gpSplit: 0.0 },
  { name: 'Catch-Up', hurdle: 0.0, lpSplit: 0.5, gpSplit: 0.5 },
  { name: 'Residual 80/20', hurdle: 0.08, lpSplit: 0.8, gpSplit: 0.2 },
  { name: 'Above 12%', hurdle: 0.12, lpSplit: 0.8, gpSplit: 0.2 },
]);
```

5. **Verify**: `waterfall.lpTotal + waterfall.gpCarry` MUST equal `netProceeds`. If it doesn't, your tier parameters are wrong.

### CRITICAL: Calibration Implementation (Step-by-Step)

Calibration is NOT optional. Without it, engines typically deviate 10-30% from Excel. Here's exactly how to implement it:

```javascript
// 1. Define Excel target values (read from Excel cells)
const EXCEL_TARGETS = {
  grossMOIC: 2.35,      // from Excel cell N50 (or wherever MOIC is displayed)
  netIRR: 0.1923,       // from Excel cell S50
  gpCarry: 43_411_674,  // from GPP Promote sheet total carry
  mipPayment: 51_876_337, // from Equity sheet MIP cell
};

// 2. Run the engine at base case WITHOUT calibration to get raw outputs
const rawResult = _computeRaw(BASE_CASE);

// 3. Compute calibration scale factors
const _cal = {};
for (const [key, excelValue] of Object.entries(EXCEL_TARGETS)) {
  const rawValue = getNestedValue(rawResult, key); // e.g., rawResult.returns.grossMOIC
  _cal[key] = (rawValue !== 0) ? excelValue / rawValue : 1.0;
}

// 4. In computeModel(), apply calibration to raw outputs:
export function computeModel(inputs = {}) {
  const raw = _computeRaw({ ...BASE_CASE, ...inputs });
  // Apply calibration
  raw.returns.grossMOIC *= _cal.grossMOIC;
  raw.waterfall.gpCarry *= _cal.gpCarry;
  raw.mip.payment *= _cal.mipPayment;
  // ... etc
  return raw;
}
```

**At base case, calibrated outputs will EXACTLY match Excel.** At non-base-case inputs, they'll be close (within 2-5%) because the calibration scale factors are multiplicative.

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

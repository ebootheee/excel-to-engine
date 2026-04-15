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

## Two Pipelines Available

This skill is the **JS Reasoning Pipeline** — best for smaller models (<20 sheets) where Claude should understand the financial logic and build a hand-crafted engine.

For **larger models** (20+ sheets, millions of cells), use the **Rust Pipeline** instead:
```bash
cd pipelines/rust && cargo build --release
./target/release/rust-parser model.xlsx output-dir --chunked
```
The Rust pipeline automatically transpiles formulas to JS, generates per-sheet modules, and handles circular references. It processes 3.7M cells in ~3 minutes. See `CLAUDE.md` for the full eval workflow.

**When to use which:**
- **This skill (JS Reasoning)**: Models where you need Claude to understand the business logic, <20 sheets, or where you want a hand-crafted engine with named fields (grossIRR, lpTotal, gpCarry)
- **Rust Pipeline**: Large models with many sheets, models where mechanical formula transpilation is sufficient, or when running automated eval/iteration loops

## Prerequisites

- Node.js 18+
- The xlsx npm package: `npm install xlsx`
- The Excel file (.xlsx) must be accessible at a known path

## Phase 0 — User Intake

Before analyzing anything, ask the user these questions:

1. **Which files?** Auto-detect `.xlsx` files in the working directory and list them. Ask: "I found these Excel files — which should I work with?"
2. **Related models?** If multiple files: "Are these related (e.g., different investment series for the same platform)? Or separate models?" If related, auto-detect cross-file naming patterns and shared cell references.
3. **Model type?** "What kind of model is this?" Options: real estate, PE/venture, corporate M&A, infrastructure, debt/credit, fund-of-funds, other
4. **Priority outputs?** "What outputs matter most to you?" (IRR, per-share values, waterfall accuracy, cash flow timing, etc.)
5. **Helpful context?** "Anything else I should know?" (e.g., "4-tier waterfall with 50% catch-up", "monthly compounding", "two share classes")

This context dramatically improves analysis accuracy.

## Step 0 — Read the Evaluation Contract

If a comparator (`compare-outputs.mjs`) or control baseline exists in the project:

1. **Read the comparator** to understand the API contract: what function signatures it calls, what inputs it passes, what output field paths it checks, what tolerances it uses. The comparator IS the spec.
2. **Read the control baseline's STRUCTURE** (not values): Check what input fields exist per scenario, how many scenarios, what grid dimensions. Do NOT memorize output values — that's cheating. But understanding the test matrix shape tells you what inputs your engine MUST support.
3. **Identify ALL input dimensions** before writing any code. A 100% base case score means nothing if you're missing an entire input dimension (like `issuancePrice` or `numFutureAcquisitions`).

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
- If multi-series model (e.g. Series 1 + Series 2), the later series usually contains the earlier — focus extraction on the most complete sheet

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

### Sheet Structure Fingerprinting

For workbooks with many identically-structured sheets (e.g., per-asset P&Ls), use the fingerprinter to auto-detect row mappings instead of manually inspecting each sheet:

```javascript
import {
  loadWorkbook, buildModelMap, fingerprintWorkbook,
  detectYearRow, extractMultiYear, extractByYear,
  detectEscalation, classifyAsset, matchLabel,
} from './lib/excel-parser.mjs';

const wb = loadWorkbook('/path/to/model.xlsx');

// 1. Fingerprint all sheets — finds common row patterns across similar sheets
const { sheetMaps, commonPattern, commonSheets, sheetGroups } = fingerprintWorkbook(wb);
// commonPattern: { revenue: { row: 48, label: "Total Revenue" }, ebitda: { row: 67 }, ... }
// commonSheets: ["Asset 1", "Asset 2", ..., "Asset 37"]

// 2. Detect year columns on any sheet in the group
const yearInfo = detectYearRow(wb, commonSheets[0]);
// { yearRow: 39, columnMap: { E: 2023, F: 2023, G: 2024, H: 2025, I: 2026 }, years: [2023, 2024, ...] }

// 3. Extract all fields for a specific reference year
const data = extractByYear(wb, 'Asset 1', 2026, { fieldMap: commonPattern, yearInfo });
// { fields: { revenue: { value: 1500000 }, ebitda: { value: 850000 } }, yearColumn: 'I' }

// 4. Extract multi-year time series for a field
const rentByYear = extractMultiYear(wb, 'Asset 1', commonPattern.rent.row, yearInfo.columnMap);
// { 2023: 500000, 2024: 515000, 2025: 530450, 2026: 546364 }

// 5. Detect escalation rates (catches rent escalation, revenue growth)
const escalation = detectEscalation(rentByYear);
// { rates: { "2023-2024": 0.03, "2024-2025": 0.03 }, avgRate: 0.03, isEscalating: true }

// 6. Auto-classify asset type (leased vs managed)
const classification = classifyAsset(data.fields);
// { classification: 'leased', confidence: 0.85, signals: ['has positive rent → leased', ...] }
```

**Why this matters**: The hardest part of building engines from multi-asset models is figuring out which rows contain which data across dozens of identical sheets. The fingerprinter automates this by fuzzy-matching row labels to canonical financial terms, then confirming the pattern is consistent across sheets.

### Reference Year Selection

Always specify a reference year when extracting data. The default should be the first full stabilized projection year (typically current year + 1). This avoids pulling stale closing-date values that miss years of escalation.

**Common pitfall**: Pulling rent values from the acquisition date column instead of the projection year column. A 3% annual escalation over 3-4 years means rents are 10-15% higher at the reference date. The `detectEscalation()` function helps flag fields where the starting value differs significantly from the projected value.

### Steps

1. **Load the workbook** using the excel-parser library:

```javascript
const wb = loadWorkbook('/path/to/model.xlsx');
const modelMap = buildModelMap(wb, {
  inputSheets: ['Assumptions', 'Inputs'],   // Adjust to actual sheet names
  outputSheets: ['Summary', 'Returns'],      // Adjust to actual sheet names
});
```

2. **Fingerprint the workbook** to find identical sheet structures:

```javascript
const { commonPattern, commonSheets, sheetGroups } = fingerprintWorkbook(wb);
// If sheetGroups shows N sheets with the same pattern, these are per-asset sheets
```

3. **Review detected inputs and outputs.** The parser identifies:
   - **Input cells**: Numeric values with no formula that are referenced by formulas elsewhere
   - **Output cells**: Formula cells that are NOT referenced by other formulas (end of chain)
   - **Intermediates**: Formula cells that ARE referenced by other formulas

4. **Detect financial patterns** — The parser looks for:
   - IRR/XIRR formulas
   - NPV/XNPV formulas (DCF)
   - Waterfall/distribution sheets
   - Sensitivity/scenario tables
   - Cash flow timelines

5. **Detect year columns and extract by reference year** — Don't default to the first data column:

```javascript
const yearInfo = detectYearRow(wb, commonSheets[0]);
// Pick the first full stabilized projection year
const referenceYear = Math.max(...yearInfo.years.filter(y => y <= new Date().getFullYear() + 1));
```

6. **Classify assets** if the model has mixed types (leased vs managed, operated vs third-party):

```javascript
for (const sheetName of commonSheets) {
  const data = extractByYear(wb, sheetName, referenceYear, { fieldMap: commonPattern, yearInfo });
  const type = classifyAsset(data.fields);
  console.log(`${sheetName}: ${type.classification} (${type.confidence})`);
}
```

7. **Produce `model-map.json`** with this structure:

```json
{
  "version": "1.1.0",
  "modelName": "Example Fund Model",
  "generatedAt": "2025-01-15T10:30:00Z",
  "excelFile": "model.xlsx",
  "referenceYear": 2026,
  "sheets": ["Assumptions", "Cash Flows", "Waterfall", "Summary"],
  "sheetGroups": [
    {
      "sheets": ["Asset 1", "Asset 2", "Asset 3"],
      "pattern": { "revenue": { "row": 48 }, "ebitda": { "row": 67 } },
      "count": 3
    }
  ],
  "yearColumns": { "E": 2023, "F": 2024, "G": 2025, "H": 2026 },
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
  "assets": [
    {
      "sheet": "Asset 1",
      "classification": "leased",
      "classificationConfidence": 0.85,
      "fields": { "revenue": 1500000, "rent": 546364, "rentCover": 1.56 }
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

8. **Ask the user to confirm/adjust the model map.** Show them:
   - The detected inputs (name, base case value, inferred range)
   - The detected outputs (name, base case value)
   - Detected patterns
   - Ask: "Does this look right? Should I add/remove any inputs or outputs?"

### Important Notes

- Not all detected input cells are meaningful model inputs. Filter by `referencedBy` count and let the user curate.
- Add human-readable `format` hints: "currency", "percent", "multiple", "integer", "years"
- Add `key` to outputs mapping to the engine return structure (e.g., "returns.grossMOIC")
- The `range` for each input should be a reasonable sensitivity range (50%-200% of base case for most; tighter for percentages)

### Cross-Sheet Validation

After extracting data, auto-generate a comparator that reads back from the Excel and validates. This catches errors before they propagate into the engine:

1. For each extracted field per asset sheet, read the cell value from Excel at the reference year column
2. Compare against the value stored in the model map
3. Use field-type-specific tolerances: tighter for inputs (rent: 0.1%), looser for calculated fields (IRR: 2%)
4. Output a structured report: `{ totalChecks, passed, failed, warnings }`
5. Any failure should block engine generation until resolved

This should run as part of Phase 1, not as a separate step. The eval in Phase 3 tests the *engine*; cross-sheet validation tests the *extraction*.

### Sensitivity Surface Extraction (CRITICAL)

**Why this matters**: The #1 source of engine failures is not static accuracy — it's getting the *response curve* wrong when inputs change. Waterfall hurdles, MIP thresholds, and debt covenants create nonlinear breakpoints where a single-point calibration factor breaks down. An engine that matches perfectly at base case can be 50-80% wrong near a waterfall breakpoint.

**After extracting base case values, also extract outputs at multiple input values:**

```javascript
import { extractSurface, compareSurfaces, detectBreakpoints } from './lib/sensitivity.mjs';

// Define the key input range to test (e.g., exit multiple from 1.0x to 3.0x)
const inputConfig = {
  exitMultiple: { min: 14, max: 26, steps: 7 },  // or whatever the model's primary driver is
};

// If the Excel has a sensitivity/data table, read it directly into this format:
const excelSurface = {
  baseCaseInputs: BASE_CASE,
  baseCaseOutputs: { 'returns.grossMOIC': 2.15, 'waterfall.gpCarry': 5200000, ... },
  inputGrid: { exitMultiple: [14, 16, 18, 20, 22, 24, 26] },
  points: [
    { inputs: { ...BASE_CASE, exitMultiple: 14 }, outputs: { 'returns.grossMOIC': 1.52, ... } },
    { inputs: { ...BASE_CASE, exitMultiple: 16 }, outputs: { 'returns.grossMOIC': 1.78, ... } },
    // ... one point per grid value
  ],
};

// If no data table exists, manually read Excel output cells at each input value
// (change the input cell in Excel, read the output cells, record the values)
```

**How to read sensitivity data from Excel:**
1. Look for sheets named "Sensitivity", "Data Table", "Scenario Analysis", or similar
2. If found, read the table directly — it already has outputs at multiple input values
3. If not found, identify the 1-2 most important inputs (usually exit multiple and hold period) and read outputs at 5-7 values across the expected range
4. Store the surface as `sensitivity-surface.json` alongside `model-map.json`

**Detect breakpoints early:**

```javascript
const breakpoints = detectBreakpoints(excelSurface, 'waterfall.gpCarry');
// Tells you where the waterfall hurdle crossing is, where MIP triggers, etc.
// Use these to set up the waterfall tiers correctly in Phase 2
```

This surface data will be used in Phase 2 for multi-point calibration instead of single-point calibration.

### Production Learnings — Common Pitfalls

These patterns caused 29-60% accuracy divergence in real production use:

**1. Never approximate IRR from MOIC.**
`MOIC^(1/years) - 1` diverges badly for long holds with interim distributions. Always extract the actual cash flow series from the ground truth and pass to `computeIRR()`. Look for rows labeled "Cash Flow", "Net Cash Flow", "Distributions", "CF to LP/GP".

**2. Don't simplify waterfall tiers.**
Real models have 4+ tiers with IRR hurdles, catch-up provisions, and quarterly compounding. Extract the actual tier structure from ground truth (look for "Preferred Return", "Pref", "Catch-Up", "Tier 1/2/3/4", "Residual Split" labels). Don't flatten to 2 tiers.

**3. Watch for compound pref on long holds.**
12-year 8% compound pref = 2.52x hurdle — this exceeds many MOIC targets. Detect whether the model uses quarterly cash flow waterfalls (interim distributions reduce the pref base) vs bullet maturity. If quarterly: extract actual pref amount, don't compute.

**4. Use parsed engine output, not parametric wrappers.**
When building downstream apps that consume engine output: read the actual computed values from the engine, don't build simplified parametric models that approximate the engine's logic. The approximations accumulate.

**5. Check for `extractWaterfallStructure()` and `extractCashFlowSeries()` in `lib/excel-parser.mjs`.**
These helpers auto-detect waterfall tiers, hurdle rates, carry percentages, and cash flow series from ground truth data.

## Phase 2 — Generate

Create `engine.js` as an ES module. Use `pipelines/js-reasoning/templates/engine-template.js` as the starting skeleton.

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

### CRITICAL: Use Actual Engine Output, NOT Simplified Approximations

**Production lesson**: A 6-vehicle carry computation project that used the Rust parser achieved only 29-60% accuracy on 4/6 vehicles because it built simplified parametric waterfall wrappers instead of using the actual parsed engine output. The parser extracted the data correctly — the problem was downstream approximation.

**Rules to prevent this:**

1. **NEVER approximate IRR from MOIC.** The formula `IRR ≈ MOIC^(1/years) - 1` assumes a single lump-sum exit. Real models have interim distributions, capital calls over time, etc. Always extract the actual cash flow series and use `computeIRR()` from `lib/irr.mjs`.

2. **Extract the actual cash flow time series.** Look for rows labeled "Cash Flow", "Net Cash Flow", "Distributions", "Pre-Carry Cash Flows" on the carry/promote/returns sheets. Use `extractCashFlowSeries()` from `lib/excel-parser.mjs`.

3. **For pref calculations on long-hold models (>7 years)**, check whether the model uses quarterly/annual cash flow waterfalls with interim distributions (most real models do) vs. bullet maturity. If it uses periodic distributions, compounding 8% over 12 years (=2.52x) will wildly overstate the hurdle. Extract the actual pref amount from the model instead of computing it.

4. **Detect multi-tier waterfalls.** Real PE waterfalls have 3-4+ tiers (pref return, catch-up, residual split, and sometimes a secondary IRR hurdle). Use `extractWaterfallStructure()` from `lib/excel-parser.mjs` to auto-detect the tier structure.

5. **For the Rust pipeline**: If the ground truth has the values you need, use them directly. The chunked engine output has every cell value from Excel. Don't rebuild a simplified model on top of that data.

### RECOMMENDED: Model-Anchored Sensitization

When building a dashboard or sensitivity tool on top of a parsed engine, **anchor on model actuals and scale proportionally** rather than recomputing from scratch. This avoids all compounding, interim-distribution, and multi-tier errors.

**Pattern** (proven on 6 production vehicles — 0.0% error at base case on all 6):

```javascript
// Store EXACT values from ground truth with _sources metadata for validation
export const MY_VEHICLE = {
  _sources: {
    groundTruth: 'output-dir',              // directory containing _ground-truth.json
    cells: {
      totalCarry: 'Waterfall!D86',          // direct cell lookup
      grossMOIC: 'Summary!C15',
      'tiers.tier3GP': 'Waterfall!D77',     // dot-path into nested objects
      'tiers.tier4GP': 'Waterfall!D85',
    },
    aggregates: {                            // optional: sum across multiple cells/classes
      totalCarry: {
        cells: ['ClassA!D86', 'ClassB!D86'],
        op: 'sum',
      },
    },
  },
  base: {
    totalCarry: 41_613_251,     // Waterfall!D86
    grossMOIC: 2.026,           // Summary!C15
    prefHurdleMOIC: 1.469,      // 1.08^holdYears (or extract from model)
    tiers: {
      catchUp: 0,
      tier3GP: 18_327_170,      // Waterfall!D77
      tier4GP: 23_286_081,      // Waterfall!D85
    },
  },
};

// Sensitize by computing a carry multiplier
function computeCarrySensitized(targetMOIC) {
  if (targetMOIC <= base.prefHurdleMOIC) return 0;  // Below pref hurdle

  const baseExcess = base.grossMOIC - base.prefHurdleMOIC;
  const targetExcess = targetMOIC - base.prefHurdleMOIC;
  const multiplier = targetExcess / baseExcess;

  return base.totalCarry * multiplier;  // Exact at base, proportional elsewhere
}
```

**Why this works better than recomputing:**
- At base case: **0.0% error** (uses exact model values)
- Near base case: proportional scaling preserves the carry composition
- Below hurdle: correctly drops to $0
- No compounding errors, no interim-distribution timing issues
- Per-tier breakdowns scale proportionally, preserving the waterfall structure

**Always validate after building.** Run the validation script to check every `_sources.cells` entry against ground truth:

```bash
node eval/validate-engine.mjs ./my-engine.js --gt-root ./parsed-models/
```

This catches wrong-sheet, wrong-model, wrong-column, and arithmetic-estimate errors before deployment. Exit code 1 = failures found. Use `--strict` for 0.01% tolerance, `--json` for CI output.

**When NOT to use this:** If you need the engine to run with completely different input assumptions (new assets, changed debt structure, etc.), you need the full transpiled engine. Model-anchored sensitization only works for sensitivity analysis around a known base case.

### TWO-TIER ENGINE WORKFLOW

When building engines from parsed models, **always generate both tiers** and teach the agent when to use each:

**Tier 1: Hand-crafted engine** (fast, dashboard-friendly)
- Stores ~10-20 named inputs (exit year, multiples, carry rate)
- Returns named outputs (grossMOIC, grossIRR, waterfall tiers)
- Runs in milliseconds, works in browser
- **Use for:** Dashboard sliders, carry sensitivity, exit year analysis, quick "what's MOIC at X?" questions

**Tier 2: Ground truth + chunked modules** (cell-level, exact)
- `_ground-truth.json` = every cell value from Excel (millions of cells)
- `chunked/sheets/*.mjs` = every formula transpiled to JS
- **Use for:** Segment P&L analysis, "what if G&A increases by $X?", any question that requires changing something INSIDE a segment that the hand-crafted engine doesn't expose as an input

**How to decide at runtime:** If the user's question maps cleanly to one of the hand-crafted engine's named inputs, use Tier 1. If it requires changing something the hand-crafted engine doesn't expose (e.g., tech headcount, specific cost line items, G&A allocation), switch to Tier 2.

**Tier 2: Ground truth + delta approach** (recommended over running the full chunked engine):

```javascript
import { readFileSync } from 'fs';
const gt = JSON.parse(readFileSync('./chunked/model/chunked/_ground-truth.json', 'utf-8'));

// 1. Find the cells you need by searching labels
const labels = Object.entries(gt)
  .filter(([k, v]) => typeof v === 'string' && /Total Revenue/i.test(v))
  .filter(([k]) => k.startsWith('Technology!'));
// → Technology!H23 = "Total Revenue" (annual section)

// 2. Read annual data for that row
const annualCols = ['L','M','N','O','P','Q'];  // projection years
const techRev = annualCols.map(c => gt['Technology!' + c + '23'] || 0);

// 3. Compute your scenario delta
const netNewARR = techRev.map((r, i) => i > 0 ? r - techRev[i-1] : r);
const additionalGA = netNewARR.map(n => n > 0 ? -n : 0);  // expense
const cumImpact = additionalGA.reduce((a, b) => a + b, 0);

// 4. Apply delta to base case returns
const afterTaxHit = cumImpact * (1 - 0.25);  // 25% tax rate
const baseProfit = gt['Equity!AN346'];
const baseEquity = gt['Equity!AN345'];
const baseMOIC = gt['Equity!AN347'];
const newMOIC = (baseEquity + baseProfit + afterTaxHit) / baseEquity;
```

This is faster and more reliable than running the full chunked engine (which requires 8GB+ heap and 10+ minutes for large models). The ground truth gives you exact Excel values; you compute only the delta from your scenario.

**Why this matters:** A hand-crafted engine with `techRevenueMultiple` as its only tech lever will overstate impact ~6x for a question like "what if G&A = 100% of net new ARR?" because it bluntly cuts the exit multiple. The ground truth approach gives exact cell-by-cell P&L data showing the actual cumulative impact is much smaller.

6. **MIP (Management Incentive Plan) deductions** should happen BEFORE the carry waterfall, not separately. Check the model's order of operations: typically gross value → MIP deduction → net to LP/GP → waterfall → carry.

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

1. **Find the waterfall sheet**: Look for tabs named "GP Promote", "Waterfall", "Distribution", "Carry", or "Promote Structure"
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
  gpCarry: 43_411_674,  // from GP Promote sheet total carry
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

### PREFERRED: Multi-Point Calibration (when Excel surface data is available)

Single-point calibration (above) assumes the error is constant across the input range. This fails at waterfall breakpoints, MIP thresholds, and other nonlinearities — the engine can be 50%+ wrong near hurdle crossings even though it's exact at base case.

If you extracted a sensitivity surface in Phase 1 (see "Sensitivity Surface Extraction"), use multi-point calibration instead:

```javascript
import { multiPointCalibrate, extractSurface, compareSurfaces, printSensitivityReport } from './lib/sensitivity.mjs';

// excelSurface was built in Phase 1 from Excel data tables or manual extraction
const { corrections, apply } = multiPointCalibrate(
  computeModel,        // your engine's raw compute function
  BASE_CASE,
  excelSurface,        // the Excel response surface
  { primaryInput: 'exitMultiple' }  // which input drives the key breakpoints
);

// In computeModel(), apply piecewise corrections instead of flat scale factors:
export function computeModel(inputs = {}) {
  const raw = _computeRaw({ ...BASE_CASE, ...inputs });
  return apply(raw, inputs);  // applies segment-specific corrections
}
```

This fits piecewise-linear corrections that adapt across the input range, with segment boundaries at detected breakpoints. In testing, this improves accuracy from ~40% to ~100% across the full input range.

**When to use which:**
- **Single-point** (lib/calibration.mjs): When you only have base case Excel values. Fast, good enough for simple models.
- **Multi-point** (lib/sensitivity.mjs): When you have Excel values at multiple input points. Required for models with waterfall hurdles, MIP thresholds, or other nonlinearities.

### CRITICAL: LP Total Definition

`waterfall.lpTotal` is the TOTAL amount LPs receive after the GP takes their carry:

```
lpTotal = netProceeds - gpCarry
```

This is NOT the sum of LP distributions from individual waterfall tiers. It's the residual.
Verify: `lpTotal + gpCarry === netProceeds` (must balance exactly).

A common mistake is summing tier-level LP distributions instead of computing `netProceeds - gpCarry`. The tier distributions are intermediate calculations; `lpTotal` is the final LP take-home.

### CRITICAL: Exit Value Must Scale with Exit Year

The exit valuation MUST change when `exitYear` changes. A model exiting in 2028 has lower asset values than one exiting in 2031 because:
- NOI/EBITDA grows over time (rent escalations, lease-up, new acquisitions)
- More future acquisitions have been completed in later years
- Debt may be different (amortization, refinancing)

**How to implement**: The Excel has year-by-year projections. Read the exit value components (NOI, revenue, etc.) for EACH possible exit year, not just the base case. Store these as lookup arrays:

```javascript
// NOI by exit year (read from Excel for each year)
const NOI_BY_YEAR = {
  2028: 58_000_000,
  2029: 71_997_341,   // base case
  2030: 85_000_000,
  2031: 95_000_000,
};

// In computeModel:
const noi = NOI_BY_YEAR[exitYear] || interpolate(exitYear, NOI_BY_YEAR);
const grossExit = noi * ownedExitMultiple + otherSegments;
```

If you use a single base-case exit value for all years, your engine will produce identical outputs regardless of exit year — which is wrong and causes ~60% of scenarios to fail.

### CRITICAL: MIP Formula

The MIP (Management Incentive Plan) payment formula is:

```
mipPayment = dilutionRate × max(0, lpTotal - mipHurdle × equityBasis)
```

Where:
- `dilutionRate` = typically 10-15% (read from Excel — look for "Class B %", "MIP %", "dilution")
- `lpTotal` = LP total AFTER carry (from waterfall)
- `mipHurdle` = typically 1.40x (MOIC threshold — look for "hurdle", "return threshold")
- `equityBasis` = the equity basis used in MOIC calculation

**Common mistakes:**
1. Using `(grossMOIC - hurdle) × equityBasis × rate` — this is wrong because grossMOIC already includes carry
2. Using `netProceeds` instead of `lpTotal` — MIP comes from LP excess, not total proceeds
3. Not gating on `lpTotal > hurdle × equityBasis` — MIP should be zero when returns are below hurdle

The `mip.valuePerShare` is simply `mipPayment / totalMIPShares` where `totalMIPShares` is a fixed number from the Excel (the incentive pool size).

### CRITICAL: Multi-Series — issuancePrice Must Affect Outputs

For models with multiple investment series (Series 1, Series 2, etc.), the `issuancePrice` input determines how many shares are issued:

```
totalShares = totalCommitment / issuancePrice
```

This affects:
- `perShare.gross` = grossPerShareValue = netProceeds / totalShares
- `perShare.net` = netPerShareValue = lpTotal / totalShares
- `mip.valuePerShare` = mipPayment / mipPoolShares (where mipPoolShares may also depend on issuancePrice)

If issuancePrice doesn't affect your outputs, your secondary series engine will produce identical results for all issuance prices — which fails 33% of scenarios for that series.

### CRITICAL: MOIC Definition Matters

"Gross MOIC" can mean different things depending on context:
- **(a)** Raw gross before ALL deductions (fees, carry, MIP)
- **(b)** Post-MIP but pre-carry
- **(c)** Post-fees but pre-carry

Check the comparator and control baseline to confirm which definition is expected. In many PE models, "Gross MOIC" is `netProceeds / equityBasis` (before carry is split out), while "Net MOIC" is `lpTotal / equityBasis` (after carry). Getting this wrong cascades into every downstream metric.

### CRITICAL: Waterfall Library Caveat

`lib/waterfall.mjs` uses **simplified annual compounding**. Many Excel models use **monthly cash flows with monthly compounding and interim distributions**. The library may overestimate carry by 20-30% due to this timing difference.

Options:
1. **Calibrate aggressively** — Apply calibration to `waterfall.gpCarry` and `waterfall.lpTotal` to force-match Excel values
2. **Data-driven parametric approach** — Instead of replicating waterfall math, extract carry amounts at known data points from Excel and interpolate

### Data-Driven Parametric Strategy

When the Excel model is too complex to replicate formula-by-formula (monthly waterfalls, circular references, macro-driven logic), use a data-driven approach:

1. **Identify input dimensions and grid values** from the sensitivity tables in Excel
2. **Read known outputs at grid points** directly from Excel (e.g., at 14x/18x/22x/26x multiples, read the Gross MOIC, Net IRR, GP carry, etc.)
3. **Derive parametric relationships**: `grossExit = NOI × multiple + constant` (linear); `carry = f(netProceeds, equityBasis)` (tiered)
4. **Interpolate between grid points** for inputs between the Excel's scenario values
5. **Calibrate at base case** to ensure exact match

This achieves higher accuracy than physics-based replication for complex models, and is faster to build.

### CRITICAL: Boolean Output Handling

Boolean outputs (like `mip.triggered`) cannot be linearly interpolated. A MIP can be "triggered" (plan exists) with $0 payment (returns below hurdle). Use explicit threshold logic:

```javascript
mip.triggered = lpTotal > (mipHurdle * equityBasis);
mip.payment = mip.triggered ? dilutionRate * (lpTotal - mipHurdle * equityBasis) : 0;
```

Do NOT set `triggered = (mipPayment > 0)` — the plan can be triggered with zero payment if returns exactly equal the hurdle.

### CRITICAL: Calibrate ALL Outputs, Not Just MOIC/IRR

A common mistake is calibrating MOIC and IRR but forgetting to calibrate:
- `waterfall.lpTotal` — must match Excel's LP total
- `waterfall.gpCarry` — must match Excel's total carry
- `mip.payment` — must match Excel's MIP payment
- `exitValuation.netProceeds` — must match Excel's net proceeds

Calibrate every output that has a known Excel target value. The more targets you calibrate, the higher your score.

## Phase 2.5 — Self-Eval & Improvement Loop

After generating the initial engine, enter an interactive improvement loop. **Do NOT skip this phase.** The initial engine will typically score 30-60% — the loop gets it to 95%+.

### Step 1: Run Self-Eval

```javascript
import { selfEval, printComparisonTable, printMenu } from './lib/self-eval.mjs';
import { computeModel, BASE_CASE, EXCEL_TARGETS } from './engine.js';

const result = selfEval(computeModel, BASE_CASE, EXCEL_TARGETS);
printComparisonTable(result);
printMenu(result.score, 0);
```

### Step 2: Ask the User

Present the comparison table and ask what they want to do:

1. **Run 1 improvement cycle** — Fix the worst failures, re-eval, show updated score
2. **Auto-loop until >95%** (max 5 iterations) — Autonomous fixing with progress updates
3. **Accept current state** — Lock the engine, proceed to Phase 3
4. **Show detailed analysis** — Failure diagnostics with specific fix suggestions

### Step 3: Improvement Cycle

When the user picks option 1 or 2:

1. Run `diagnoseFailures()` to get prioritized fix suggestions
2. For each suggestion (highest priority first):
   a. Re-read the relevant Excel cells for that specific output
   b. Apply the fix (adjust formula, add/adjust calibration, fix definition)
   c. Re-run selfEval
   d. Show updated score: "Iteration 3: 45% → 67% → 82%"
3. If auto-looping, continue until target or max iterations
4. Stop and present to user when score plateaus (< 2% improvement between iterations)

### Step 4: Lock Engine

When user accepts (option 3):
- Save final score to `engine-eval.json`
- Log iteration history
- Proceed to Phase 3 (external test suite)

### Fail Fast

Run the eval EARLY — even before the engine is complete. A skeleton engine that crashes on unknown inputs tells you what you're missing. Better to discover you need `issuancePrice` support after 5 minutes than after 30 minutes of polishing other calculations.

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

### Sensitivity Surface Validation (if Excel surface data available)

If you extracted a sensitivity surface in Phase 1, add sensitivity validation to the test suite:

```javascript
import { extractSurface, compareSurfaces, printSensitivityReport } from '../lib/sensitivity.mjs';

// Load the Excel surface (saved in Phase 1)
const excelSurface = JSON.parse(fs.readFileSync('sensitivity-surface.json', 'utf8'));

// Extract engine surface with the same grid
const engineSurface = extractSurface(computeModel, BASE_CASE, {
  exitMultiple: { min: 14, max: 26, steps: 7 },
});

// Compare — checks levels AND slopes
const comparison = compareSurfaces(engineSurface, excelSurface);
printSensitivityReport(comparison);

// Fail if slope errors are too high (this catches dynamics errors, not just levels)
const slopeFails = comparison.summary.slopeFailCount;
if (slopeFails > 0) {
  console.log(`⚠️  ${slopeFails} slope checks failed — engine responds differently than Excel to input changes`);
}
```

This is the key test that catches the class of bug where the engine matches at base case but diverges when inputs change. Slope errors > 15% typically indicate a waterfall tier is wrong, a hurdle is at the wrong level, or a nonlinear relationship was linearized.

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

Generate an interactive HTML dashboard from `pipelines/js-reasoning/templates/dashboard/`.

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

## Phase 5 — Deliver the Engine

After the engine passes testing, show the user how to use it:

### In Claude Code
```javascript
import { computeModel } from './engine.js';
const result = computeModel({ exitMultiple: 22 });
console.log(`Gross IRR: ${(result.returns.grossIRR * 100).toFixed(1)}%`);
```

### In a Web App
```html
<script type="module">
  import { computeModel } from './engine.js';
  const result = computeModel({ exitMultiple: 22 });
  document.getElementById('irr').textContent = (result.returns.grossIRR * 100).toFixed(1) + '%';
</script>
```

### As an API
```javascript
import { computeModel } from './engine.js';
app.get('/api/model', (req, res) => res.json(computeModel(req.query)));
```

### With the Dashboard
Open `dashboard/index.html` in any browser — no build step needed.

### Python Engine (Opt-In)

If the user asks for a Python version, generate `engine.py` with:
- Same `BASE_CASE` dictionary
- Same `EXCEL_TARGETS` dictionary
- Same `compute_model(inputs)` function signature
- Same calibration approach
- Same return structure (as a nested dict)

This is opt-in only — do NOT generate Python by default.

## Recommended Eval Workflow

For validating any engine (JS reasoning or Rust pipeline):

1. **Parse the model** → produces ground truth + chunked modules
2. **Validate engine values** → checks `_sources` metadata against ground truth (catches wrong-sheet/wrong-model errors)
3. **Run blind eval** → fresh Claude API session answers business questions (independent test)
4. **Take the eval report** → give to a NEW Claude Code session
5. **That session reads failures, fixes the engine/transpiler, pushes code**
6. **Re-parse and re-eval** (blind again — clean context)

This separation is critical: the builder has full context, the evaluator has zero context. This prevents overfitting and catches real usability issues.

```bash
# Validate engine base case values against ground truth (do this FIRST):
node eval/validate-engine.mjs ./my-engine.js --gt-root ./parsed-models/

# One-command eval (local, no Docker needed):
node eval/run-all.mjs model.xlsx --questions 50

# Or step by step:
node eval/generate-questions.mjs output/chunked --count 50 --output output/test-questions.json
ANTHROPIC_API_KEY=... node eval/blind-eval.mjs output/chunked --questions output/test-questions.json
node eval/analyze-report.mjs output/eval-report.json output/analysis.json
node eval/per-sheet-eval.mjs output/chunked --output output/per-sheet-report.json
```

## Tips

- **Start with the Summary sheet.** Most financial models have a summary sheet with the key outputs. Start there and work backward to find inputs.
- **Don't replicate every formula.** Focus on the economic logic, not cell-by-cell replication. The calibration system handles small differences.
- **Test early.** Run `eval.mjs` after Phase 2 to see how close you are. Iterate on the engine logic until base case accuracy is within 1%.
- **Use named ranges.** If the Excel model uses named ranges, they make great input/output identifiers.
- **Ask the user.** Financial models have nuances that automated detection can't capture. Always confirm the model map with the user.
- **Never approximate IRR from MOIC.** Extract actual cash flow series from ground truth. The MOIC^(1/n)-1 shortcut diverges for long holds with interim distributions.
- **Check for waterfall structure helpers.** `extractWaterfallStructure(groundTruth)` and `extractCashFlowSeries(groundTruth)` in `lib/excel-parser.mjs` auto-detect multi-tier waterfalls and distribution series.
- **Always add `_sources` metadata** when storing ground truth values in an engine. Map every base case field to its exact cell reference. Run `node eval/validate-engine.mjs` before deploying — it catches wrong-sheet, wrong-model, and wrong-column errors automatically.
- **Watch for multi-model sourcing.** If a vehicle has both standalone and combined deployment models, use the combined model (it's the base case). Document which ground truth directory each vehicle sources from in `_sources.groundTruth`.

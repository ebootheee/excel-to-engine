# excel-to-engine — PLAN V3: Model Analysis CLI + Skill Layer

## Status: Implemented — All 19 Steps Complete, 34/34 Tests Pass

## Context

V1-V2 built two pipelines (Rust transpiler + JS reasoning) that convert any Excel model into a JavaScript computation engine with ground truth validation. That infrastructure is **production-ready** — 99.3% blind eval accuracy across 15.5M cells, 6 models, 2-82 sheets.

V3 adds the **consumption layer**: a CLI tool and Claude Code skill that lets anyone run scenario analysis, sensitivity surfaces, and financial queries against any converted model — without writing custom code for each one.

### The Gap V3 Closes

Today, using a converted engine requires manual work:
1. Knowing which cells contain which financial outputs (exit EBITDA, carry, IRR, etc.)
2. Writing bespoke scenario scripts per model
3. Manually aggregating monthly data into annual summaries
4. Building IRR/MOIC/carry calculations from scratch for each vehicle
5. Manually computing delta cascades (revenue change → EBITDA → terminal value → equity → returns)

The 12 downstream projects built on excel-to-engine all solved these problems individually. V3 generalizes the patterns so any converted model gets the same capability.

### Who Uses This

The CLI is consumed by **Claude Code agents**, not directly by PE professionals. The PE principal says "What if tech grows at 40% instead of 30%?" and Claude translates that to CLI commands, runs them, and interprets the results. The CLI must therefore be:

1. **Composable** — chain multiple adjustments in one command or via scenario files
2. **Machine-parseable** — JSON output for agent consumption
3. **Self-describing** — the agent can query the manifest to discover what parameters exist
4. **Deterministic** — same inputs always produce same outputs (no LLM in the loop)

---

## Architecture

```
excel-to-engine/
├── pipelines/
│   ├── rust/                        # EXISTING — Excel → Engine (unchanged)
│   └── js-reasoning/                # EXISTING — Claude reasoning pipeline (unchanged)
├── eval/                            # EXISTING — Blind eval, per-sheet eval (unchanged)
├── lib/                             # EXISTING — IRR, waterfall, calibration, etc.
│   └── manifest.mjs                 # NEW — Manifest schema, auto-gen, validation
├── cli/                             # NEW — Analysis CLI
│   ├── index.mjs                    # CLI entry point (argument parsing, bin entry)
│   ├── commands/
│   │   ├── init.mjs                 # Parse + manifest in one step
│   │   ├── manifest.mjs             # Generate / validate / edit manifests
│   │   ├── query.mjs                # Query ground truth (cell, label search, manifest name)
│   │   ├── pnl.mjs                  # Extract annual/quarterly P&L by segment
│   │   ├── scenario.mjs             # Run scenario analysis (flags or scenario file)
│   │   ├── sensitivity.mjs          # 1D sweep or 2D surface generation
│   │   ├── compare.mjs              # Compare scenarios, models, or named saves
│   │   └── summary.mjs              # One-shot model overview
│   ├── extractors/
│   │   ├── annual-aggregator.mjs    # Monthly → annual/quarterly aggregation
│   │   ├── date-detector.mjs        # Column-to-year mapping
│   │   ├── segment-detector.mjs     # Revenue/expense/subsegment identification
│   │   ├── waterfall-detector.mjs   # Carry tier structure detection
│   │   └── line-item-resolver.mjs   # Row-level cell lookup + delta application
│   └── solvers/
│       ├── delta-cascade.mjs        # Adjustment → EBITDA → TV → equity → returns
│       └── scenario-engine.mjs      # Orchestrates extractors + cascade + IRR/carry
├── skill/                           # NEW — Claude Code skill
│   └── SKILL.md                     # PE analyst intent → CLI commands
├── scenarios/                       # NEW — Named scenario files (per model or shared)
│   └── examples/
│       ├── downside.json            # Example: bear case scenario definition
│       └── bull-tech-exit.json      # Example: tech segment upside
├── tests/
│   ├── synthetic-pe-model/          # EXISTING
│   └── cli/                         # NEW — CLI integration tests
│       ├── test-manifest-gen.mjs
│       ├── test-query.mjs
│       ├── test-pnl.mjs
│       ├── test-scenario.mjs
│       ├── test-sensitivity.mjs
│       ├── test-compare.mjs
│       └── fixtures/
│           ├── synthetic-gt.json
│           └── synthetic-manifest.json
└── package.json                     # UPDATED — "bin": { "ete": "./cli/index.mjs" }
```

---

## Phase 1 — Model Manifest Schema + Auto-Generation

### 1.1 Manifest Schema (v1.0)

The manifest maps generic financial concepts to specific cells/rows in a parsed model. It sits alongside the chunked output and bridges "cell `Valuation!AA53`" to "exit EBITDA."

**Changes from original design:**
- Added `valuation` config per segment (for sum-of-parts exit)
- Added `lineItems` section (for row-level adjustments)
- Added `baseCaseScenario` (stores base case output values for delta computation)
- Added `growthRates` per segment (for growth override scenarios)

```json
{
  "$schema": "manifest-v1.0",
  "model": {
    "name": "Example Fund Model",
    "type": "pe_platform",
    "source": "model.xlsx",
    "generatedAt": "2026-04-15T00:00:00Z",
    "groundTruth": "./chunked/_ground-truth.json",
    "engineDir": "./chunked/"
  },

  "timeline": {
    "dateRow": 7,
    "dateSheet": "Financial Statements",
    "investmentYear": 2023,
    "exitYear": 2031,
    "exitYearRange": [2028, 2034],
    "periodicity": "monthly",
    "columnMap": { "E": "2023-01", "F": "2023-02" }
  },

  "segments": [
    {
      "id": "reNOI",
      "label": "Real Estate NOI",
      "type": "revenue",
      "sheet": "Valuation",
      "row": 14,
      "aggregation": "annual_sum",
      "valuation": {
        "metric": "noi",
        "defaultMultiple": 15.0,
        "multipleType": "cap_rate_inverse"
      }
    },
    {
      "id": "techGP",
      "label": "Technology Gross Profit",
      "type": "revenue",
      "sheet": "Valuation",
      "row": 28,
      "aggregation": "annual_sum",
      "valuation": {
        "metric": "revenue",
        "defaultMultiple": 12.0,
        "multipleType": "revenue_multiple"
      }
    },
    {
      "id": "sgaNet",
      "label": "SG&A Net of Capitalized Fees",
      "type": "expense",
      "sheet": "Valuation",
      "row": 29,
      "aggregation": "annual_sum"
    }
  ],

  "outputs": {
    "ebitda": {
      "label": "Platform EBITDA",
      "cells": { "annual": { "sheet": "Valuation", "row": 30 } },
      "exitValue": "Valuation!AA53"
    },
    "terminalValue": {
      "cell": "Valuation!AA55"
    },
    "exitMultiple": {
      "cell": "Valuation!AA54",
      "type": "ebitda_multiple"
    }
  },

  "equity": {
    "classes": [
      {
        "id": "series-a",
        "label": "Series A",
        "basisCell": "Equity!AN885",
        "grossMOIC": "Equity!AN887",
        "grossIRR": "Equity!AN888",
        "netMOIC": "Equity!AN896",
        "netIRR": "Equity!AN897"
      }
    ],
    "drawSchedule": {
      "sheet": "Equity",
      "row": 62,
      "aggregation": "annual_sum"
    },
    "distributions": {
      "sheet": "Equity",
      "row": 118,
      "aggregation": "annual_sum"
    }
  },

  "carry": {
    "totalCell": "GP Promote!D88",
    "tiers": [
      { "name": "catchUp", "cell": "GP Promote!D77" },
      { "name": "tier3_8to12pct", "cell": "GP Promote!D85" },
      { "name": "tier4_above12pct", "cell": "GP Promote!D88" }
    ],
    "waterfall": {
      "prefReturn": 0.08,
      "carryRate": 0.20,
      "catchUpType": "none"
    }
  },

  "debt": {
    "exitBalance": "Valuation!AA71",
    "exitCash": "Valuation!AA72"
  },

  "subsegments": {
    "technology": {
      "sheet": "Technology",
      "revenueRow": 23,
      "expenseRow": 28,
      "profitRow": 30,
      "revenueTypes": [
        { "id": "recurring", "label": "Ongoing Fee", "row": 21 },
        { "id": "setup", "label": "Gate Set-up Fee", "row": 20 },
        { "id": "intercompany", "label": "Intercompany", "row": 22 }
      ],
      "expenseTypes": [
        { "id": "cac", "label": "Customer Acquisition", "row": 25 },
        { "id": "setup_cost", "label": "Gate Set-up Costs", "row": 26 },
        { "id": "ongoing_opex", "label": "Ongoing Opex", "row": 27 }
      ]
    }
  },

  "lineItems": {
    "tech_headcount": {
      "label": "Technology Headcount",
      "sheet": "Technology",
      "row": 25,
      "type": "expense",
      "parent": "technology"
    },
    "re_ground_rent": {
      "label": "Ground Rent",
      "sheet": "Owned Assets",
      "row": 14,
      "type": "expense",
      "parent": "reNOI"
    }
  },

  "customCells": {
    "wacc": "Valuation!AA57",
    "transactionCostRate": "Valuation!V36",
    "sharesOutstanding": "Valuation!AA81",
    "pricePerShare": "Valuation!AA82"
  },

  "baseCaseOutputs": {
    "exitEBITDA": 34200000,
    "terminalValue": 633000000,
    "exitEquity": 312000000,
    "grossMOIC": 2.85,
    "grossIRR": 0.284,
    "netMOIC": 2.45,
    "netIRR": 0.241,
    "totalCarry": 50000000,
    "pricePerShare": 1823.45
  }
}
```

**Design principles:**
- Every value is traceable to a specific cell or row in the ground truth
- Segments are arrays (any number, any model structure)
- Equity classes are arrays (handles single-class funds through complex multi-tranche)
- `lineItems` enables row-level adjustments (what the PE analyst actually wants to change)
- `baseCaseOutputs` stores resolved base values (scenario engine computes deltas against these)
- Per-segment `valuation` config enables sum-of-parts exit analysis
- `customCells` is a catch-all for model-specific outputs
- No hardcoded financial logic — the manifest is purely a map

### 1.2 Auto-Generation Pipeline

The manifest generator scans the ground truth and model-map.json to propose an initial manifest. Heuristic pattern matching, not AI — deterministic and auditable.

**Detection strategies:**

| Pattern | Detection Method |
|---------|-----------------|
| Date columns | Scan row 7 (or configurable) for ExcelDateTime values; group by year |
| Revenue segments | Find rows where label column contains "Revenue", "NOI", "Rent", "Gross Profit"; verify corresponding data columns have numeric values |
| Expense segments | Same as revenue but labels contain "Expense", "Cost", "SG&A", "OpEx" |
| EBITDA | Label contains "EBITDA" and is a sum of revenue - expense rows |
| Exit multiple | Numeric cell in range 5-30 near a cell labeled "multiple" or "cap rate" |
| Terminal value | Large number (>10x EBITDA) near "terminal" or "exit" label |
| Equity basis | Label contains "equity" + "basis" or "committed" or "invested" |
| IRR / MOIC | Decimal in (0, 1) near "IRR" label; number in (0.5, 10) near "MOIC" label |
| Carry / Promote | Label contains "carry", "promote", "GP" + "interest" |
| Waterfall tiers | Successive rows with carry-like values summing to total carry |
| Debt | Label contains "debt" or "loan" + large negative number |
| Line items | Named expense/revenue rows within subsegment sheets |
| Growth rates | YoY changes in revenue segment rows (using `detectEscalation()`) |
| Model type | PE fund (has carry + equity classes), RE (has NOI + cap rate), SaaS (has ARR + churn), 3-statement (has BS + IS + CF) |

**The generator produces a draft manifest + confidence scores + base case outputs.** Low-confidence mappings are flagged for human review.

```bash
ete manifest generate ./output/chunked/
# → writes manifest.json with "confidence" annotations
# → resolves baseCaseOutputs from ground truth
# → prints review checklist to stdout

ete manifest validate ./output/chunked/manifest.json
# → checks all referenced cells exist in ground truth
# → checks values are reasonable (MOIC > 0, IRR in range, etc.)
# → checks baseCaseOutputs match ground truth
```

### 1.3 Implementation (`lib/manifest.mjs`)

```
lib/manifest.mjs
├── schema definition (JSON Schema)
├── generateManifest(groundTruthPath, modelMapPath) → manifest + confidence
├── validateManifest(manifest, groundTruthPath) → { valid, errors, warnings }
├── resolveCell(manifest, groundTruth, cellRef) → value
├── resolveAnnualRow(manifest, groundTruth, segment) → { year: value }
├── resolveEquityClass(manifest, groundTruth, classId) → full metrics
├── resolveLineItem(manifest, groundTruth, lineItemId) → { year: value }
├── resolveBaseCaseOutputs(manifest, groundTruth) → baseCaseOutputs
└── detectModelType(groundTruth) → "pe_fund" | "re_platform" | "saas" | "three_statement" | "venture_portfolio"
```

---

## Phase 2 — CLI Tool (`cli/`)

### 2.1 Command Structure

```bash
# Parse + generate manifest in one step
ete init model.xlsx --output ./my-model/

# Manifest management
ete manifest generate ./my-model/chunked/
ete manifest validate ./my-model/manifest.json

# Query ground truth — by cell, by label search, or by manifest name
ete query ./my-model/ "Valuation!AA53"
ete query ./my-model/ --search "headcount"
ete query ./my-model/ --name exitMultiple
ete query ./my-model/ --search "Total Revenue" --sheet Technology

# Extract annual P&L (with growth rates)
ete pnl ./my-model/ --years 2025-2031
ete pnl ./my-model/ --segment technology --detail
ete pnl ./my-model/ --segment technology --detail --growth

# Run scenario analysis (CLI flags)
ete scenario ./my-model/ \
  --exit-multiple 18.5 \
  --exit-year 2031 \
  --revenue-adj techGP:+50% \
  --cost-adj technology.cac:-200000

# Run scenario from file
ete scenario ./my-model/ --file scenarios/downside.json

# Run scenario and save result
ete scenario ./my-model/ --exit-multiple 16 --save "bear-case"

# Sensitivity surface (1D or 2D)
ete sensitivity ./my-model/ \
  --vary exit-multiple:14-22:1 \
  --metric irr,moic

ete sensitivity ./my-model/ \
  --vary exit-multiple:14-22:1 \
  --vary exit-year:2028-2034:1 \
  --metric irr

# Compare scenarios, saved results, or different models
ete compare ./my-model/ --base "" --alt "exit-multiple=16"
ete compare ./my-model/ --scenarios "base,bear-case,bull-case"
ete compare --models ./fund-v1/ ./fund-v2/ --metric irr,moic
ete compare ./my-model/ --base "" --alt "exit-multiple=16" --attribution

# One-shot summary
ete summary ./my-model/ --format json
ete summary ./my-model/ --format table
```

### 2.2 Commands in Detail

#### `ete init`
Full pipeline: parse Excel → generate chunked engine → auto-generate manifest → validate → print summary.
Wraps the Rust parser and adds manifest generation. This is the zero-to-queryable command.

```bash
ete init model.xlsx --output ./my-model/
# 1. Calls rust-parser model.xlsx ./my-model/ --chunked
# 2. Runs manifest generate on ./my-model/chunked/
# 3. Validates manifest
# 4. Prints model summary + review checklist
```

#### `ete query`
Reads ground truth JSON, resolves cell references. Four modes:

| Mode | Example | Behavior |
|------|---------|----------|
| Cell reference | `ete query ./m/ "Sheet!A1"` | Direct ground truth lookup |
| Range | `ete query ./m/ "Sheet!A1:Z1"` | Returns all cells in range |
| Manifest name | `ete query ./m/ --name exitMultiple` | Resolves via manifest `outputs`, `equity`, `carry`, `customCells` |
| Label search | `ete query ./m/ --search "headcount"` | Scans all cells for label match, returns matching rows with adjacent values |

Label search is the most important for agent use — it answers "where is this thing in the model?" without knowing the cell address. Returns `[{label, labelCell, valueCell, value, sheet, row}]`.

Additional flags:
- `--sheet <name>` — restrict search to one sheet
- `--format json|table|csv` — output format
- `--context <n>` — show n rows above/below match (default 2)

#### `ete pnl`
Extracts annual profit & loss from manifest segments.

- Reads each segment's row from ground truth
- Aggregates monthly columns into annual buckets using date row mapping
- `--segment <id>` drills into subsegments (e.g., technology revenue by type)
- `--detail` shows subsegment line items
- `--growth` appends YoY growth rates per segment
- `--quarterly` aggregates by quarter instead of year
- `--years <range>` filters to specific years (default: investment to exit)
- `--format table|json|csv|markdown`

**Output example (table):**
```
                     2025      2026      2027      2028      2029      2030      2031
RE NOI            45.2M     46.8M     48.1M     49.2M     50.0M     51.1M     52.1M
  YoY                       +3.5%     +2.8%     +2.3%     +1.6%     +2.2%     +2.0%
Tech GP            8.3M     11.2M     14.8M     17.9M     19.8M     21.3M     22.7M
  YoY                      +34.9%    +32.1%    +20.9%    +10.6%     +7.6%     +6.6%
SG&A             (12.1M)   (13.2M)   (14.0M)   (14.5M)   (15.1M)   (15.4M)   (15.8M)
─────────────────────────────────────────────────────────────────────────────────────
Platform EBITDA   41.4M     44.8M     48.9M     52.6M     54.7M     57.0M     59.0M
```

#### `ete scenario`
The core command. Applies adjustments to base case and computes resulting returns.

**Scenario Parameters — Full Set:**

##### Exit Parameters
| Parameter | Description | Example |
|-----------|-------------|---------|
| `--exit-year <year>` | Override exit year | `--exit-year 2033` |
| `--exit-multiple <n>` | Override exit EBITDA multiple | `--exit-multiple 16` |
| `--revenue-multiple <n>` | Exit on revenue instead of EBITDA (global) | `--revenue-multiple 10` |

##### Revenue Adjustments
| Parameter | Description | Example |
|-----------|-------------|---------|
| `--revenue-adj <seg>:<adj>` | Adjust segment revenue (%, $) | `--revenue-adj techGP:+50%` |
| `--revenue-adj <seg>:<adj>` | Absolute dollar adjustment | `--revenue-adj reNOI:-500000` |
| `--revenue-growth <seg>:<rate>` | Override compound growth rate | `--revenue-growth techGP:0.40` |
| `--remove-segment <id>` | Zero out a segment entirely | `--remove-segment techGP` |
| `--add-revenue <year>:<amount>` | Inject one-time revenue | `--add-revenue 2030:5e6` |
| `--override-arr <amount>` | Override exit-year recurring revenue | `--override-arr 32e6` |

##### Cost Adjustments
| Parameter | Description | Example |
|-----------|-------------|---------|
| `--cost-adj <seg>:<adj>` | Adjust segment costs (%, $) | `--cost-adj technology:+10%` |
| `--line-item <id>:<adj>` | Adjust a named line item | `--line-item tech_headcount:-2e6` |
| `--cost-ratio <seg>:<ratio>` | Set cost-to-revenue ratio (magic number) | `--cost-ratio technology:1.0` |
| `--capitalize <item>:<years>` | Reclassify OpEx as CapEx over N years | `--capitalize tech_headcount:5` |

##### Capital Structure
| Parameter | Description | Example |
|-----------|-------------|---------|
| `--leverage <ltv>` | Override exit debt as % of TV | `--leverage 0.55` |
| `--equity-override <amount>` | Override total equity invested | `--equity-override 500e6` |
| `--distribution <year>:<amount>` | Add interim distribution | `--distribution 2027:20e6` |

##### Waterfall / Returns
| Parameter | Description | Example |
|-----------|-------------|---------|
| `--pref-return <rate>` | Override preferred return hurdle | `--pref-return 0.08` |
| `--hold-period <years>` | Override hold period | `--hold-period 6` |
| `--discount-rate <rate>` | WACC / discount rate for NPV | `--discount-rate 0.085` |

##### Sum-of-Parts Valuation
| Parameter | Description | Example |
|-----------|-------------|---------|
| `--segment-multiple <seg>:<n>` | Per-segment exit multiple (uses segment's valuation metric) | `--segment-multiple techGP:12` |
| `--sotp` | Use sum-of-parts instead of single EBITDA multiple | `--sotp --segment-multiple techGP:12 --segment-multiple reNOI:15` |

##### Output Control
| Parameter | Description | Example |
|-----------|-------------|---------|
| `--metric <list>` | Select output metrics | `--metric irr,moic,carry,ebitda` |
| `--format json\|table\|csv\|md` | Output format | `--format json` |
| `--save <name>` | Save scenario to `./scenarios/<name>.json` | `--save "bear-case"` |
| `--file <path>` | Load scenario from JSON file | `--file scenarios/downside.json` |

**Output:** For each metric requested, shows base case value, scenario value, and delta. Default metrics: IRR, MOIC, total carry, exit EBITDA, terminal value, equity value, price per share (if applicable).

```
Scenario: exit-multiple=16, revenue-adj=techGP:-20%
                          Base        Scenario      Delta
Exit EBITDA              $34.2M       $29.6M       -$4.6M (-13.5%)
Terminal Value           $633M        $474M        -$160M (-25.2%)
Exit Equity              $312M        $222M        -$90M (-28.8%)
Gross MOIC               2.85x        2.03x       -0.82x (-28.8%)
Gross IRR                28.4%        18.1%       -10.3pp
Net MOIC                 2.45x        1.78x       -0.67x (-27.3%)
Net IRR                  24.1%        15.6%        -8.5pp
Total Carry              $50.0M       $28.2M      -$21.8M (-43.6%)
Price/Share              $1,823       $1,302       -$521 (-28.6%)
```

#### `ete scenario` — Scenario Files

For complex multi-parameter scenarios, a JSON file is cleaner than 10+ CLI flags. The agent constructs these programmatically.

```json
{
  "name": "downside-q4-2026",
  "description": "Conservative exit: tech headwinds, delayed timeline, multiple compression",
  "baseModel": "./fund-v2/",
  "adjustments": {
    "exit": { "year": 2033, "multiple": 14 },
    "revenue": [
      { "segment": "techGP", "adj": "-20%" },
      { "segment": "reNOI", "adj": "-500000" }
    ],
    "cost": [
      { "segment": "technology", "adj": "+10%" }
    ],
    "lineItems": [
      { "id": "tech_headcount", "adj": "-2000000", "note": "RIF in Q4" }
    ],
    "capital": { "leverage": 0.50 }
  },
  "metrics": ["irr", "moic", "carry", "ebitda", "pricePerShare"]
}
```

Usage:
```bash
# Run from file
ete scenario ./my-model/ --file scenarios/downside-q4.json

# Run from flags, save to file
ete scenario ./my-model/ --exit-multiple 16 --revenue-adj techGP:-20% --save "bear-case"

# List saved scenarios
ete scenario ./my-model/ --list

# Run a saved scenario
ete scenario ./my-model/ --load "bear-case"
```

#### `ete sensitivity`
Generates 1D sweep or 2D surface. Varies any parameter(s) from the scenario list.

**1D sweep** (single `--vary`):
```bash
ete sensitivity ./my-model/ --vary exit-multiple:14-22:1 --metric irr,moic
# → Table: one row per exit multiple value, columns for each metric

Exit Multiple    Gross IRR    Gross MOIC    Net IRR    Net MOIC
14.0x            18.2%        2.03x         15.1%      1.76x
15.0x            20.4%        2.18x         17.0%      1.88x
...
22.0x            34.1%        3.42x         29.3%      2.94x
```

**2D surface** (two `--vary`):
```bash
ete sensitivity ./my-model/ \
  --vary exit-multiple:14-22:2 \
  --vary exit-year:2028-2034:1 \
  --metric irr
# → Matrix: rows = exit multiples, columns = exit years
```

**Combined with scenario adjustments:**
```bash
# "How does IRR change across exit multiples if tech revenue drops 20%?"
ete sensitivity ./my-model/ \
  --vary exit-multiple:14-22:1 \
  --revenue-adj techGP:-20% \
  --metric irr
```

#### `ete compare`
Four comparison modes:

**1. Base vs. single scenario:**
```bash
ete compare ./my-model/ --base "" --alt "exit-multiple=16,exit-year=2033"
```

**2. Multiple named scenarios:**
```bash
ete compare ./my-model/ --scenarios "bear-case,management-case,bull-case"
# → Side-by-side table of all metrics across scenarios
```

**3. Cross-model comparison:**
```bash
ete compare --models ./fund-v1/ ./fund-v2/ ./platform-c/ --metric irr,moic,carry
# → Table comparing base case returns across different models
```

**4. Attribution analysis:**
```bash
ete compare ./my-model/ \
  --base "" \
  --alt "revenue-adj=techGP:-20%,exit-year=2033,exit-multiple=14" \
  --attribution
```

**Attribution output:**
```
IRR Impact Attribution (base → scenario)
  Base case IRR:             25.3%
  Scenario IRR:              17.8%
  Total delta:               -7.5pp

  Revenue: techGP -20%       -3.2pp   (42.7%)
  Exit year: 2031→2033       -2.8pp   (37.3%)
  Exit multiple: 18.5→14     -1.5pp   (20.0%)
  ─────────────────────────────────────
  Interaction effects          0.0pp    (0.0%)
```

Attribution works by running each adjustment individually and measuring its marginal impact. The sum of individual impacts plus interaction effects equals the total delta.

#### `ete summary`
Quick one-shot model overview. Reads manifest + ground truth, formats key metrics.

**Output example (table):**
```
Model: Example Fund Model (pe_platform)
Source: model.xlsx | Parsed: 2026-04-14
Period: 2023-2031 (8yr, monthly) | Exit: 2031 @ 18.5x EBITDA

Revenue Segments                    Invest.     Exit     CAGR
  Real Estate NOI                   $45.2M    $52.1M    +1.8%
  Technology Gross Profit            $8.3M    $22.7M   +13.4%
  Operations                         $3.1M     $5.8M    +8.2%

Platform EBITDA                     $12.4M    $34.2M   +13.5%
Terminal Value                                $633M
Exit Equity                                   $312M

Returns                     Gross      Net
  MOIC                      2.85x     2.45x
  IRR                       28.4%     24.1%

Carry: $50.0M (3 tiers: catch-up + 8-12% + >12%)
Equity: 1 class (Series A), basis $109M
Debt at exit: $321M | Cash at exit: $0
Price per share: $1,823
```

**JSON output** includes all values structured for agent consumption — model metadata, segment breakdown with annual time series, returns, waterfall, equity classes. Designed so another Claude session can read the JSON and reason about the model without loading ground truth.

### 2.3 Output Formats

All commands support `--format`:
- `table` (default) — terminal-friendly ASCII tables
- `json` — structured output for programmatic consumption
- `csv` — spreadsheet-compatible
- `markdown` — for documentation / chat contexts

The `json` format is the agent's primary interface — Claude reads JSON output and interprets it for the PE user.

---

## Phase 3 — Extractors + Solvers

### 3.1 Extractors (`cli/extractors/`)

Reusable primitives that the CLI commands compose.

#### Date Detector
- Scans a configurable row for ExcelDateTime values
- Maps each column to a `(year, month)` tuple
- Identifies monthly, quarterly, and annual periodicity
- Returns column ranges per year for annual aggregation
- Leverages existing `detectYearRow()` from `lib/excel-parser.mjs`

#### Annual Aggregator
- Given a sheet, row, and date mapping → returns `{ 2025: sum, 2026: sum, ... }`
- Handles both sum aggregation (flows: revenue, expenses) and point-in-time (balances: debt, equity — take last month)
- Quarterly mode: `{ "2025-Q1": sum, "2025-Q2": sum, ... }`
- Computes YoY growth rates when requested
- Configurable aggregation mode per segment in the manifest

#### Segment Detector
- Scans label column (typically column A or AL) for financial terms
- Uses the same 50+ alias list from `lib/excel-parser.mjs` (via `matchLabel()`)
- Groups consecutive labeled rows into segments
- Identifies header vs data rows
- Detects line items within subsegments (expense detail rows)
- Proposes segment and lineItem entries for the manifest

#### Waterfall Detector
- Finds carry/promote sheets by label matching
- Identifies tier structure (preferred return, catch-up, residual split)
- Detects hurdle rates and carry percentages
- Leverages existing `extractWaterfallStructure()` from `lib/excel-parser.mjs`
- Maps to the manifest `carry.tiers` schema

#### Line-Item Resolver (new)
- Given a line item ID (from manifest `lineItems` section) or a direct `Sheet!row` reference:
  - Resolves to annual values using the date detector + aggregator
  - Applies adjustments (%, $, or growth rate override)
  - Returns delta per year: `{ 2025: +200K, 2026: +200K, ... }`
- Handles `capitalize` mode: moves OpEx to CapEx with amortization schedule
- This is the bridge between "change tech headcount by -$2M" and the delta cascade

### 3.2 Delta Cascade (`cli/solvers/delta-cascade.mjs`)

The delta cascade is the core financial computation. It computes how adjustments flow through to returns.

**The chain:**
```
User adjustments
  → Annual P&L deltas (per segment, per year)
    → Exit-year EBITDA delta (or revenue delta for revenue-multiple exits)
      → Terminal value delta (EBITDA × multiple)
        → Equity value delta (TV - debt + cash)
          → MOIC delta (equity / basis)
            → IRR delta (from cash flow series)
              → Carry delta (from waterfall)
```

**Implementation:**

```javascript
// delta-cascade.mjs

/**
 * Given a manifest, ground truth, and set of adjustments, compute
 * the base case and scenario returns.
 *
 * @param {Object} manifest - Model manifest
 * @param {Object} groundTruth - Ground truth {addr: value}
 * @param {Object} adjustments - Parsed from CLI flags or scenario file
 * @returns {Object} { base, scenario, deltas, annualPnL }
 */
export function computeScenario(manifest, groundTruth, adjustments) {
  // 1. Resolve base case annual P&L from ground truth
  const basePnL = resolveAnnualPnL(manifest, groundTruth);

  // 2. Apply revenue/cost adjustments to get scenario P&L
  const scenarioPnL = applyAdjustments(basePnL, adjustments, manifest);

  // 3. Compute exit-year values
  const exitYear = adjustments.exitYear || manifest.timeline.exitYear;
  const baseExitEBITDA = basePnL.ebitda[exitYear];
  const scenarioExitEBITDA = scenarioPnL.ebitda[exitYear];

  // 4. Compute terminal value
  //    - Single multiple: TV = EBITDA × multiple
  //    - Revenue multiple: TV = Revenue × multiple
  //    - Sum-of-parts: TV = Σ(segment_metric × segment_multiple)
  const baseTV = computeTerminalValue(manifest, basePnL, exitYear, {});
  const scenarioTV = computeTerminalValue(manifest, scenarioPnL, exitYear, adjustments);

  // 5. Compute equity value
  //    exitEquity = TV - debt + cash
  //    If leverage changed: debt = TV × LTV
  const baseEquity = computeExitEquity(manifest, groundTruth, baseTV, {});
  const scenarioEquity = computeExitEquity(manifest, groundTruth, scenarioTV, adjustments);

  // 6. Compute returns
  const equityBasis = resolveEquityBasis(manifest, groundTruth, adjustments);
  const baseMOIC = baseEquity / equityBasis;
  const scenarioMOIC = scenarioEquity / equityBasis;

  // 7. Compute IRR from cash flow series
  const holdPeriod = adjustments.holdPeriod || (exitYear - manifest.timeline.investmentYear);
  const baseIRR = computeIRR(buildCashFlows(manifest, groundTruth, baseEquity, holdPeriod, {}));
  const scenarioIRR = computeIRR(buildCashFlows(manifest, groundTruth, scenarioEquity, holdPeriod, adjustments));

  // 8. Compute carry from waterfall
  const baseCarry = computeCarry(manifest, baseMOIC, equityBasis);
  const scenarioCarry = computeCarry(manifest, scenarioMOIC, equityBasis);

  return { base: {...}, scenario: {...}, deltas: {...}, annualPnL: { base: basePnL, scenario: scenarioPnL } };
}
```

**Key design decisions in the cascade:**

1. **MOIC before IRR:** MOIC = equity_out / equity_in (simple ratio). IRR requires cash flow timing. If the manifest has a draw schedule, use actual cash flows. Otherwise, approximate as bullet: [-equity_basis at t=0, +exit_equity at t=holdPeriod].

2. **Terminal value modes:**
   - `ebitda_multiple` (default): TV = exit_EBITDA × multiple
   - `revenue_multiple`: TV = exit_revenue × multiple (for high-growth SaaS/tech)
   - `sotp` (sum of parts): TV = Σ(segment_i_metric × segment_i_multiple)

3. **Carry from MOIC, not from cell:** The scenario changes returns, so carry must be recomputed through the waterfall. Use `lib/waterfall.mjs` with the manifest's waterfall parameters and the scenario's net proceeds.

4. **Leverage interaction:** If leverage changes, debt changes, which changes equity, which changes MOIC. The cascade handles this: `exit_debt = TV × LTV` → `exit_equity = TV - exit_debt + cash`.

5. **Capitalization reclassification:** Moving $X from OpEx to CapEx means: EBITDA increases by $X per year, but amortization of ($X / amort_years) reduces net income. For PE (EBITDA-based valuation), only the EBITDA effect matters for terminal value. The CapEx itself doesn't affect EBITDA.

### 3.3 Scenario Engine (`cli/solvers/scenario-engine.mjs`)

Orchestrates the full scenario computation:

```javascript
// scenario-engine.mjs

/**
 * Run a complete scenario analysis.
 *
 * @param {string} modelDir - Path to parsed model directory
 * @param {Object} adjustments - From CLI flags or scenario file
 * @param {Object} options - { metrics, format, save, attribution }
 * @returns {Object} Full scenario result
 */
export function runScenario(modelDir, adjustments, options = {}) {
  const manifest = loadManifest(modelDir);
  const groundTruth = loadGroundTruth(manifest);

  const result = computeScenario(manifest, groundTruth, adjustments);

  if (options.attribution) {
    result.attribution = computeAttribution(manifest, groundTruth, adjustments);
  }

  if (options.save) {
    saveScenario(modelDir, options.save, adjustments, result);
  }

  return result;
}
```

**Attribution algorithm:**

```javascript
function computeAttribution(manifest, groundTruth, adjustments) {
  const base = computeScenario(manifest, groundTruth, {});
  const full = computeScenario(manifest, groundTruth, adjustments);

  // Run each adjustment individually
  const contributions = {};
  for (const [key, adj] of Object.entries(flattenAdjustments(adjustments))) {
    const individual = computeScenario(manifest, groundTruth, { [key]: adj });
    contributions[key] = {
      irrDelta: individual.scenario.irr - base.base.irr,
      moicDelta: individual.scenario.moic - base.base.moic,
      carryDelta: individual.scenario.carry - base.base.carry,
    };
  }

  // Interaction = total - sum of individual
  const sumOfIndividual = Object.values(contributions).reduce((s, c) => s + c.irrDelta, 0);
  contributions._interaction = {
    irrDelta: (full.scenario.irr - base.base.irr) - sumOfIndividual,
  };

  return contributions;
}
```

---

## Phase 4 — Claude Code Skill (`skill/SKILL.md`)

The skill is the agent's playbook for translating PE-speak into CLI commands. It's the most critical file for end-user experience.

### 4.1 Skill Triggers
```
- "What if [financial adjustment]?"
- "Run a scenario on this model"
- "What's the IRR if we change the exit multiple?"
- "Show me the P&L breakdown"
- "Compare base case vs downside"
- "Generate a sensitivity table"
- "What's the carry at 2.5x?"
- "Find [metric] in the model"
- "Summarize this model"
```

### 4.2 Skill Workflow

```
1. LOCATE the model:
   - If user provides path → use it
   - If only one model in working directory → use it
   - If multiple → ask user which

2. CHECK manifest:
   - Exists → proceed
   - Missing → run `ete manifest generate`, ask user to review

3. IDENTIFY intent → map to command:

   Intent                              Command
   ─────────────────────────────────────────────────────────────
   "What is X?"                     → ete query (search or name)
   "Show the P&L"                   → ete pnl
   "What if X changes?"             → ete scenario
   "How sensitive is IRR to X?"     → ete sensitivity
   "Compare A vs B"                 → ete compare
   "Summarize the model"            → ete summary
   "Find where X is in the model"   → ete query --search

4. TRANSLATE user language to parameters:
   - "drops by 2 turns"             → --exit-multiple [base - 2]
   - "push exit to 2033"            → --exit-year 2033
   - "tech grows at 40%"            → --revenue-growth techGP:0.40
   - "lose $500K of rent"           → --revenue-adj reNOI:-500000
   - "capitalize headcount over 5y" → --capitalize tech_headcount:5
   - "add a special dividend"       → --distribution 2027:20e6
   - "value tech at 12x revenue"    → --sotp --segment-multiple techGP:12
   - "conservative case"            → load saved scenario or compose one

5. RUN the command(s), capture JSON output

6. INTERPRET for the user:
   - Highlight key metric changes
   - Flag if returns cross important thresholds (1.0x MOIC, pref hurdle, MIP trigger)
   - Compare to benchmarks if known (PE median IRR ~20%, venture ~25%)
   - Note any limitations (first-order approximation, not full cell-level recompute)
```

### 4.3 PE Language → Parameter Translation Guide

The skill includes a comprehensive translation table. These are patterns from actual PE professional queries observed across 12 production projects:

#### Platform / Holding Company Models
| PE Principal Says | Agent Translates To |
|---|---|
| "What if we lose some rent on the London assets?" | `--revenue-adj reNOI:-{amount}` |
| "What if tech gross margin drops to 60%?" | `--cost-adj technology:+{delta_to_achieve_60%}` |
| "Capitalize the dev team expense over 5 years" | `--capitalize tech_headcount:5` |
| "What if G&A eats 100% of net new ARR?" | `--cost-ratio sgaNet:{ratio_that_consumes_arr}` |
| "Value the tech business at 12x revenue separately" | `--sotp --segment-multiple techGP:12 --segment-multiple reNOI:15` |
| "Delay exit two years" | `--exit-year {base + 2}` |
| "Refinance at 55% LTV, distribute the excess" | `--leverage 0.55 --distribution {year}:{excess_proceeds}` |
| "Show me carry by tier at this scenario" | `--metric carry-detail` |
| "What price per share does this trade at?" | `--metric pricePerShare` |

#### Venture Portfolio Models
| PE Principal Says | Agent Translates To |
|---|---|
| "TechCo grows at 40% instead of 30%" | `--revenue-growth techco:0.40` |
| "What multiple does TechCo need to exit at for a 3x fund?" | `ete sensitivity --vary segment-multiple.techco:5-20:1 --metric moic` (find where moic = 3.0) |
| "Remove the bridge round from portfolio" | `--remove-segment bridge_round` |
| "What if we mark down FinCo to 0.5x?" | `--segment-multiple finco:0.5` |

#### Real Estate Fund Models
| PE Principal Says | Agent Translates To |
|---|---|
| "Cap rate expands 50bps at exit" | `--exit-multiple {1/(base_cap_rate + 0.005)}` |
| "Vacancy increases to 8%" | `--revenue-adj noi:-{vacancy_delta}` |
| "Construction costs overrun 15%" | `--cost-adj construction:+15%` |

#### 3-Statement / Corporate Models
| PE Principal Says | Agent Translates To |
|---|---|
| "Revenue growth slows to 15%" | `--revenue-growth total_revenue:0.15` |
| "EBITDA margin compresses 200bps" | Compute cost adjustment needed, apply via `--cost-adj` |
| "What leverage can the business support at 4x EBITDA?" | `--leverage {TV*ltv/TV}` (iterate via sensitivity) |

### 4.4 Chaining Commands (Multi-Step Analysis)

The agent often needs to compose multiple commands:

```
User: "I want to understand what happens if tech underperforms. Walk me through it."

Agent:
1. ete summary ./model/                              # understand the model
2. ete pnl ./model/ --segment technology --detail --growth  # see current trajectory
3. ete scenario ./model/ --revenue-growth techGP:0.15 --metric irr,moic,carry,ebitda
4. ete compare ./model/ --base "" --alt "revenue-growth=techGP:0.15" --attribution
5. ete sensitivity ./model/ --vary revenue-growth.techGP:0-0.30:0.05 --metric irr
```

```
User: "Build me a bear, base, and bull case for the Q4 board deck."

Agent:
1. ete scenario ./model/ --revenue-adj techGP:-20% --exit-multiple 14 --exit-year 2033 --save "bear"
2. ete scenario ./model/ --save "base"   # base case = no adjustments
3. ete scenario ./model/ --revenue-adj techGP:+30% --exit-multiple 22 --exit-year 2029 --save "bull"
4. ete compare ./model/ --scenarios "bear,base,bull" --format markdown
```

### 4.5 Interpretation Guidance

The skill includes guidelines for interpreting results:

**Return Benchmarks (by model type):**
| Type | Median IRR | Median MOIC | Strong | Weak |
|------|-----------|-------------|--------|------|
| PE Buyout | 18-22% | 2.0-2.5x | >25% / >3.0x | <15% / <1.5x |
| Growth Equity | 25-30% | 3.0-4.0x | >35% / >5.0x | <20% / <2.0x |
| Venture | 20-30% | 2.5-3.5x | >40% / >5.0x | <15% / <2.0x |
| Real Estate | 12-18% | 1.5-2.0x | >20% / >2.5x | <10% / <1.3x |

**Key Thresholds to Flag:**
- MOIC < 1.0x → capital loss
- MOIC crosses pref hurdle (typically 1.08-1.10x per year compounded)
- IRR crosses carried interest hurdle (typically 8%)
- MIP/promote triggers (model-specific)
- Leverage ratio > 5x EBITDA (risky)

**Common Gotchas:**
- MOIC vs IRR divergence: high MOIC + low IRR = long hold; low MOIC + high IRR = short hold with leverage
- Leverage amplification: 1pp multiple change has 2-3x bigger effect on MOIC when leveraged
- Terminal value sensitivity: exit EBITDA × exit multiple = terminal value, and TV typically = 70-90% of total enterprise value. So a 10% EBITDA change has a 7-9% equity impact.
- Growth rate compounding: "40% vs 30% growth" over 5 years = 5.38x vs 3.71x (45% more revenue, not 33%)

---

## Phase 5 — Testing + Examples

### 5.1 Synthetic Example

Extend the existing `tests/synthetic-pe-model/` into a full worked example:
- Synthetic Excel model (3-statement PE fund, no proprietary data)
- Parsed engine output (chunked) with ground truth
- Auto-generated manifest
- Example CLI runs with expected outputs
- Saved scenario files (bear, base, bull)
- Documented in README as the "getting started" tutorial

### 5.2 CLI Integration Tests

```
tests/cli/
├── test-manifest-gen.mjs    # Auto-generation on synthetic model
├── test-query.mjs           # Cell, range, label search, manifest name queries
├── test-pnl.mjs             # Annual P&L extraction + growth rates
├── test-scenario.mjs        # Scenario with known expected outputs (15+ parameter types)
├── test-sensitivity.mjs     # 1D sweep + 2D surface generation
├── test-compare.mjs         # Scenario comparison + attribution
├── test-delta-cascade.mjs   # Unit tests for the financial math
└── fixtures/
    ├── synthetic-gt.json    # Small ground truth for testing
    ├── synthetic-manifest.json
    └── scenarios/
        ├── bear.json
        └── bull.json
```

### 5.3 Accuracy Validation

The scenario engine's outputs are validated against known results:
- For the synthetic model, compute expected IRR/MOIC by hand for each scenario
- For any model with existing bespoke analysis scripts, compare CLI output to the bespoke output
- **Tolerance:** 0.01% for IRR, 0.1% for MOIC, $1 for carry

### 5.4 Delta Cascade Unit Tests

Critical to validate the financial math independently:
- Revenue adjustment → EBITDA delta (direct pass-through)
- Exit multiple change → TV delta (linear in EBITDA)
- Leverage change → equity delta (TV - debt)
- Growth rate override → compound trajectory (verify against manual calculation)
- Capitalization → EBITDA + amort impact (verify CapEx doesn't affect EBITDA for PE valuation)
- Sum-of-parts → TV = Σ(segment × multiple) (verify cross-segment)
- Attribution → sum of individual deltas + interaction ≈ total delta

---

## Implementation Order

| Order | Component | Depends On | Effort |
|-------|-----------|------------|--------|
| **1** | `lib/manifest.mjs` — schema + validation + resolvers | Nothing | Medium |
| **2** | `cli/extractors/date-detector.mjs` | Ground truth format | Small |
| **3** | `cli/extractors/annual-aggregator.mjs` | Date detector | Small |
| **4** | `cli/extractors/segment-detector.mjs` | Ground truth labels | Medium |
| **5** | `cli/extractors/waterfall-detector.mjs` | Ground truth labels | Small |
| **6** | `cli/extractors/line-item-resolver.mjs` | Date detector + aggregator | Medium |
| **7** | `cli/commands/query.mjs` | Manifest schema | Medium |
| **8** | `cli/commands/pnl.mjs` | Aggregator + segments | Medium |
| **9** | `cli/commands/manifest.mjs` (auto-gen) | All extractors | Medium |
| **10** | `cli/solvers/delta-cascade.mjs` | Aggregator + line-item + lib/irr + lib/waterfall | Large |
| **11** | `cli/solvers/scenario-engine.mjs` | Delta cascade | Medium |
| **12** | `cli/commands/scenario.mjs` | Scenario engine | Medium |
| **13** | `cli/commands/sensitivity.mjs` | Scenario engine | Medium |
| **14** | `cli/commands/compare.mjs` (+ attribution) | Scenario engine | Medium |
| **15** | `cli/commands/summary.mjs` | PnL + query + manifest | Small |
| **16** | `cli/commands/init.mjs` | Manifest + Rust parser | Small |
| **17** | `cli/index.mjs` — CLI entry point + bin config | All commands | Small |
| **18** | `skill/SKILL.md` | All commands documented | Large |
| **19** | Synthetic example + tests | All above | Medium |

**Estimated total: ~2,500 lines of JavaScript + ~600 lines of SKILL.md.**

The extractors (1-6) and query/pnl commands (7-8) are the foundation — get those right and the scenario engine composes on top. The delta cascade (10) is the most critical single piece — it contains all the financial math.

---

## Design Decisions

### Why a manifest file instead of runtime detection?

1. **Deterministic** — same manifest always produces same results. No LLM-in-the-loop variance.
2. **Auditable** — a human can review exactly which cells map to which concepts.
3. **Portable** — the manifest travels with the model. Any tool can consume it.
4. **Cached** — detection runs once; the manifest is reused forever (until the model changes).
5. **Self-describing** — the agent reads the manifest to discover what parameters and segments exist.

### Why Node.js CLI instead of extending the Rust parser?

1. **Consumption, not parsing** — the Rust parser is fast at Excel→Engine. The CLI is about reading the already-parsed output. Node is fine for reading JSON.
2. **Library reuse** — `lib/irr.mjs`, `lib/waterfall.mjs`, `lib/excel-parser.mjs` are all JS. The CLI composes them directly.
3. **Claude Code integration** — Claude runs Node natively. A JS CLI is immediately usable in skill workflows.
4. **Contributor accessibility** — JS has a lower barrier than Rust for open-source contributors.

### Why not just use the Claude API for detection?

The auto-generation is heuristic, not LLM-based, because:
1. **Offline** — works without API keys or network
2. **Reproducible** — same input always produces same manifest
3. **Fast** — scans 200MB ground truth in seconds, not minutes
4. **Auditable** — every detection has a code path, not a prompt

The LLM layer is in the *skill*, not the *tool*. Claude interprets user intent and constructs CLI commands — the CLI itself is deterministic.

### Why scenario files in addition to CLI flags?

Real PE scenarios involve 5-15 adjustments. CLI flags become unwieldy:
```bash
# This is painful:
ete scenario ./model/ --exit-multiple 14 --exit-year 2033 --revenue-adj techGP:-20% \
  --cost-adj technology:+10% --line-item tech_headcount:-2e6 --leverage 0.50 --pref-return 0.10

# This is clean:
ete scenario ./model/ --file scenarios/downside-q4.json
```

Scenario files also enable:
- Version control (commit scenario definitions alongside the model)
- Collaboration (share scenario definitions across team)
- Batch execution (run all scenarios, output comparison table)
- Reproducibility (exact same parameters every time)

### Why the delta cascade approach instead of re-running the full engine?

The full chunked engine requires 8GB+ heap and 10+ minutes for large models. The delta cascade:
1. Loads base case from ground truth (instant — it's a JSON lookup)
2. Applies adjustments proportionally (fast — arithmetic only)
3. Recomputes derived values through the financial chain (fast — ~10 computations)
4. Uses `lib/irr.mjs` and `lib/waterfall.mjs` for returns (fast — Newton-Raphson + waterfall)

**Trade-off:** This is a first-order approximation. It's accurate for:
- Linear adjustments (revenue %, cost %, multiple changes)
- Exit timing changes
- Leverage changes

It's less accurate for:
- Highly non-linear scenarios (MIP triggers, pref hurdle crossings with compounding)
- Complex inter-segment dependencies (where changing tech revenue affects RE valuation)

For production-grade accuracy on non-linear scenarios, use Tier 2 (full chunked engine run). The skill should note this limitation.

---

## Success Criteria

1. **Any model converted by the Rust parser can have a manifest generated in <30 seconds**
2. **`ete pnl` produces annual segment P&L with growth rates for any manifested model**
3. **`ete scenario` computes IRR/MOIC/carry for arbitrary parameter adjustments (25+ parameter types)**
4. **`ete scenario --file` loads complex multi-parameter scenarios from JSON**
5. **`ete compare --attribution` decomposes return deltas into per-driver contributions**
6. **`ete sensitivity` produces 1D sweeps and 2D surfaces across any scenario parameter**
7. **`ete query --search` finds any financial metric by label without knowing cell addresses**
8. **The SKILL.md enables Claude Code to translate natural PE language into CLI commands for any model type (PE fund, RE, SaaS, venture, 3-statement)**
9. **The synthetic example works end-to-end: init → summary → pnl → scenario → sensitivity → compare**
10. **Zero proprietary data in the repo** — synthetic model only, no real fund names or numbers

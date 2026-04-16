# excel-to-engine

> Turn any Excel financial model into a queryable scenario engine. Three commands from `.xlsx` to IRR sensitivity tables.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## From Excel to Scenario Analysis in 60 Seconds

```bash
# 1. Build the parser (one-time)
cd pipelines/rust && cargo build --release && cd ../..

# 2. Parse your model — handles everything: parse, manifest, auto-detect metrics
node cli/index.mjs init model.xlsx --output ./my-model/

# 3. Ask questions
node cli/index.mjs summary ./my-model/chunked/
node cli/index.mjs scenario ./my-model/chunked/ --exit-multiple 16 --revenue-adj techGP:-20%
node cli/index.mjs sensitivity ./my-model/chunked/ --vary exit-multiple:14-22:2 --vary exit-year:2028-2034:1 --metric grossIRR
```

**That's it.** The CLI auto-generates a model manifest (maps EBITDA, IRR, carry, equity to the right cells), runs a smart refinement pass, and is ready for scenarios immediately.

## What You Get

| Input | Output |
|-------|--------|
| A `.xlsx` file (PE fund, RE waterfall, DCF, 3-statement, venture portfolio) | Every cell value as queryable JSON, a semantic manifest mapping financial concepts to cells, and a CLI for scenario analysis |

Works on models from 3KB to 84MB (2–82 sheets, up to 6M cells). Tested across 9 financial models with 99.3% blind eval accuracy (149/150 questions across 15.5M cells).

## Prerequisites

- **Node.js 18+**
- **Rust toolchain:** `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`

```bash
git clone https://github.com/ebootheee/excel-to-engine.git
cd excel-to-engine
npm install
cd pipelines/rust && cargo build --release && cd ../..
```

## CLI Commands

### `ete summary` — Model Overview

```
$ node cli/index.mjs summary ./my-model/chunked/

Model: Example Fund (pe_platform)
Period: 2024–2030 (6yr, annual) | Exit: 2030 @ 18.5x EBITDA

Revenue Segments                       Start        Exit        CAGR
  Real Estate NOI                     $45.2M      $52.1M        2.4%
  Technology Gross Profit              $8.3M      $22.7M       18.3%

Platform EBITDA             $41.4M → $59.0M  (CAGR: 6.1%)
Terminal Value              $1.1B

Returns                    Gross         Net
  MOIC                     2.85x       2.45x
  IRR                      28.4%       24.1%

Carry: $50.3M (3 tiers), 8% pref
Equity: 1 class (Series A), basis $270.0M
```

### `ete pnl` — Revenue Breakdown

```bash
node cli/index.mjs pnl ./my-model/chunked/ --growth

# Drill into a specific segment
node cli/index.mjs pnl ./my-model/chunked/ --segment technology --detail --growth
```

Shows annual P&L by segment with YoY growth rates and CAGR. `--detail` drills into subsegment revenue and expense line items.

### `ete query` — Find Anything

```bash
# Search by financial term (find cells by label, not by address)
node cli/index.mjs query ./my-model/chunked/ --search "headcount"
node cli/index.mjs query ./my-model/chunked/ --search "Total Revenue"

# Look up a specific cell
node cli/index.mjs query ./my-model/chunked/ "Valuation!K54"

# Look up by manifest name
node cli/index.mjs query ./my-model/chunked/ --name grossIRR
```

### `ete scenario` — What-If Analysis

```bash
# Simple: change exit multiple
node cli/index.mjs scenario ./my-model/chunked/ --exit-multiple 16

# Complex: multiple adjustments
node cli/index.mjs scenario ./my-model/chunked/ \
  --exit-multiple 14 \
  --exit-year 2033 \
  --revenue-adj techGP:-20% \
  --cost-adj technology:+10%

# Save and reload scenarios
node cli/index.mjs scenario ./my-model/chunked/ --exit-multiple 14 --save "bear"
node cli/index.mjs scenario ./my-model/chunked/ --load "bear"
```

**Output:**
```
Scenario: exit-multiple=16

                        Base      Scenario         Delta
────────────────────────────────────────────────────
Exit EBITDA           $59.0M        $59.0M       $0 (0%)
Terminal Value         $1.1B       $944.0M    -$148M (-14%)
Gross MOIC             2.77x         2.24x      -0.53x
Gross IRR              18.5%         14.4%      -4.1pp
Total Carry          $140.6M        $88.6M     -$52M (-37%)
```

**Full parameter set:**

| Category | Parameters |
|----------|-----------|
| Exit | `--exit-year`, `--exit-multiple`, `--revenue-multiple` |
| Revenue | `--revenue-adj seg:±%/$`, `--revenue-growth seg:rate`, `--remove-segment`, `--add-revenue`, `--override-arr` |
| Cost | `--cost-adj seg:±%/$`, `--line-item id:adj`, `--cost-ratio seg:ratio`, `--capitalize item:years` |
| Capital | `--leverage ltv`, `--equity-override`, `--distribution year:amount` |
| Valuation | `--sotp`, `--segment-multiple seg:n`, `--discount-rate` |
| Returns | `--pref-return rate`, `--hold-period years` |
| Scenarios | `--file scenario.json`, `--save name`, `--load name`, `--list` |
| Output | `--metric list`, `--format table\|json\|csv\|markdown`, `--attribution` |

### `ete sensitivity` — IRR/MOIC Surfaces

```bash
# 1D sweep: IRR across exit multiples
node cli/index.mjs sensitivity ./my-model/chunked/ \
  --vary exit-multiple:14-22:2 --metric grossIRR,grossMOIC

# 2D surface: IRR matrix across multiples and exit years
node cli/index.mjs sensitivity ./my-model/chunked/ \
  --vary exit-multiple:14-22:2 \
  --vary exit-year:2028-2034:1 \
  --metric grossIRR
```

**Output (2D):**
```
Gross IRR: exitMultiple (rows) x exitYear (columns)

                2028      2029      2030      2031
14.0x          12.3%     11.3%     10.4%      9.7%
16.0x          18.7%     16.2%     14.4%     13.0%
18.0x          24.3%     20.4%     17.8%     15.9%
20.0x          29.1%     24.1%     20.7%     18.3%
22.0x          33.5%     27.4%     23.4%     20.5%
```

### `ete carry` — Waterfall GP Carry Calculation

```bash
# Uses manifest's peak equity, pref, carry%, MoC
node cli/index.mjs carry ./my-model/chunked/

# Fully parametric (no manifest needed)
node cli/index.mjs carry --peak 500e6 --moc 2.8 --life 4.7 --pref 0.08 --carry 0.20 --ownership 0.06

# Solve hold period from IRR when cash flows are irregular
node cli/index.mjs carry --peak 500e6 --moc 2.8 --irr 0.165 --ownership 0.06
```

**Output:**
```
Carry estimate (American waterfall)
──────────────────────────────────────────────────
Inputs:
  Peak equity:    $500.0M
  MoC (gross):    2.80×
  Hold period:    4.70yr
  Pref return:    8.0%
  GP carry:       20.0%
  Ownership:      6.00%

Waterfall:
  Return of Capital                    dist $500.0M   LP $500.0M   GP       $0
  Preferred Return (8.0%)              dist $217.9M   LP $217.9M   GP       $0
  GP Catch-Up                          dist $180.0M   LP       $0   GP $180.0M
  Residual 80/20                       dist $502.1M   LP $401.7M   GP $100.4M

Totals:
  GP carry:       $280.4M   (31.2% of profit)
  Your share:     $16.8M   (at 6.00% of GP carry)
```

Pass `--no-catchup` for pure 80/20-above-pref (no catch-up tier). Pass `--structure european` for aggregate-fund European waterfall.

### `ete compare` — Side-by-Side Analysis

```bash
# Base vs scenario with attribution (shows what drove the change)
node cli/index.mjs compare ./my-model/chunked/ \
  --base "" --alt "exit-multiple=14,revenue-adj=techGP:-20%" --attribution

# Bear / base / bull comparison
node cli/index.mjs scenario ./my-model/chunked/ --exit-multiple 14 --save "bear"
node cli/index.mjs scenario ./my-model/chunked/ --save "base"
node cli/index.mjs scenario ./my-model/chunked/ --exit-multiple 22 --save "bull"
node cli/index.mjs compare ./my-model/chunked/ --scenarios "bear,base,bull"

# Cross-model comparison
node cli/index.mjs compare --models ./fund-a/chunked/ ./fund-b/chunked/ --metric grossIRR,grossMOIC
```

### `ete manifest` — Model Configuration

The manifest maps financial concepts (EBITDA, IRR, carry tiers) to specific cells in each model. It's auto-generated and auto-refined — you rarely need to touch it.

```bash
# Auto-generate (done automatically by `ete init`)
node cli/index.mjs manifest generate ./my-model/chunked/

# Smart refinement — searches for IRR, MOIC, carry, equity across all cells
node cli/index.mjs manifest refine ./my-model/chunked/ --apply

# Diagnose suspect cell mappings (out-of-range values, constant time-series)
node cli/index.mjs manifest doctor ./my-model/chunked/

# Override a single field (replaces the old "hand-patch JSON" workflow)
node cli/index.mjs manifest set ./my-model/chunked/ equity.classes[0].grossIRR "Cheat Sheet!F15"

# Validate all cell references resolve correctly
node cli/index.mjs manifest validate ./my-model/chunked/manifest.json
```

**Manifest robustness.** Auto-generation enforces value ranges on first-pass
detection (e.g. `basisCell` must be between $1M and $50B, so a stray `5` never
gets written), dedupes equity classes by `(sheet, row)`, and rejects segment
rows whose values are constant across the timeline (scalar assumptions rather
than P&L streams). When something still looks wrong, `ete manifest doctor`
flags the specific field and suggests the fix command.

## What AI agents can ask this tool

The CLI is an **AI-navigable index over complex Excel models**. An agent can
answer questions across the PE stakeholder chain without loading the whole
model into context:

**Analyst / VP:**
- "Show the P&L by segment with YoY growth" → `ete pnl --growth`
- "What's IRR if exit multiple drops 2 turns?" → `ete scenario --exit-multiple X`
- "Sensitivity of MOIC to exit timing and multiple" → `ete sensitivity --vary ...`
- "Find the Peak Equity on the Cheat Sheet tab" → `ete query --search "Peak Equity" --sheet "Cheat Sheet"`

**Partner / Principal:**
- "Summarize for the IC memo" → `ete summary`
- "Attribution — why did IRR drop 5pp?" → `ete compare --attribution`
- "Bear / base / bull in one view" → `ete scenario --save` + `ete compare --scenarios`

**LP / IR:**
- "TVPI / DPI / RVPI / net IRR" → `ete query --name tvpi` (and friends)
- "Vintage year, fund size, paid-in" → `ete query --name vintageYear`
- "Capital call schedule" → `ete extract --type capital_call`
- "Distribution schedule" → `ete extract --type distribution`

**Portfolio CFO:**
- "Debt amortization / interest expense over time" → `ete extract --type debt_balance`
- "Covenant ratios" → `ete query --name dscr` (and `ltv`, `icr`, `leverage`)
- "What's FCF if rates go up 100bps?" → `ete eval <cell> --inputs '{"Assumptions!Rate": 0.08}'`

**Audit / "why" questions:**
- "Where does totalCarry come from?" → `ete explain totalCarry`
- "What formula computes Equity!AN125?" → `ete explain "Equity!AN125"`

Use `--compact` on any agent-consumed output — ~60% fewer tokens than `--format json`.

## Use with Claude Code

The toolkit includes a Claude Code skill (`skill/SKILL.md`) that translates natural language into CLI commands. You don't need to know the CLI syntax — just ask questions:

```
"What happens to returns if tech grows at 40% instead of 30%?"
→ ete scenario --revenue-growth techGP:0.40

"Show me a sensitivity table for exit multiples and timing"
→ ete sensitivity --vary exit-multiple:14-22:1 --vary exit-year:2028-2034:1

"Capitalize the dev headcount over 5 years — what does that do to IRR?"
→ ete scenario --capitalize tech_headcount:5

"Build me bear, base, and bull cases for the board deck"
→ ete scenario --save "bear" ... → --save "base" ... → --save "bull" ... → ete compare --scenarios "bear,base,bull"

"What if we value tech at 12x revenue and RE at 15x NOI separately?"
→ ete scenario --sotp --segment-multiple techGP:12 --segment-multiple reNOI:15
```

The skill handles manifest creation transparently — the PE user never needs to know about manifests, cell references, or ground truth files.

## Scenario Files

For complex multi-parameter scenarios, use JSON files:

```json
{
  "name": "downside-q4",
  "description": "Conservative: tech headwinds, delayed exit, multiple compression",
  "adjustments": {
    "exit": { "year": 2033, "multiple": 14 },
    "revenue": [
      { "segment": "techGP", "adj": "-20%" }
    ],
    "cost": [
      { "segment": "technology", "adj": "+10%" }
    ],
    "capital": { "leverage": 0.50 }
  }
}
```

```bash
node cli/index.mjs scenario ./my-model/chunked/ --file scenarios/downside.json
```

## How It Works

### The Pipeline

```
Excel (.xlsx)
  → Rust parser (calamine, 10-50x faster than SheetJS)
    → Per-sheet JS modules (formulas transpiled to JavaScript)
    → Ground truth JSON (every cell value from Excel)
    → Model manifest (semantic mapping of financial concepts to cells)
      → CLI scenario engine (delta cascade: adjustments → P&L → TV → equity → returns → carry)
```

### The Delta Cascade

When you run a scenario, the CLI doesn't re-execute the full engine (which can take 10+ minutes on large models). Instead, it:

1. Reads base case values from ground truth (instant — JSON lookup)
2. Applies your adjustments to the annual P&L
3. Recomputes the chain: **exit EBITDA → terminal value → exit equity → MOIC → IRR → carry**
4. Uses `lib/irr.mjs` (Newton-Raphson) and `lib/waterfall.mjs` (American/European PE structures) for returns

This is a first-order approximation — accurate for linear sensitivities (revenue %, cost %, multiple changes, exit timing, leverage). For highly non-linear scenarios (MIP triggers, complex pref compounding), use the full chunked engine.

### Project Structure

```
excel-to-engine/
├── cli/                         # The `ete` command
│   ├── index.mjs                # Entry point + arg parsing
│   ├── commands/                # init, summary, query, pnl, scenario, sensitivity, compare, manifest
│   ├── extractors/              # date-detector, annual-aggregator, segment-detector, waterfall-detector, line-item-resolver
│   └── solvers/                 # delta-cascade (financial math), scenario-engine (orchestrator)
├── skill/SKILL.md               # Claude Code skill (PE language → CLI translation)
├── pipelines/
│   ├── rust/                    # Excel → JS transpiler (8 Rust modules, ~60 Excel functions)
│   └── js-reasoning/            # Claude-driven pipeline for smaller models
├── eval/                        # Blind eval, per-sheet eval, auto-iteration
├── lib/                         # Financial libraries (IRR, waterfall, calibration, sensitivity, manifest)
└── tests/cli/                   # 166 tests (34 integration + 132 use-case scenarios)
```

### Libraries

| Library | Purpose |
|---------|---------|
| `lib/manifest.mjs` | Manifest schema, auto-generation, validation, cell resolvers, label search |
| `lib/irr.mjs` | Newton-Raphson IRR with bisection fallback, XIRR for irregular dates |
| `lib/waterfall.mjs` | American + European PE waterfall structures |
| `lib/calibration.mjs` | Scale factor calibration against Excel targets |
| `lib/sensitivity.mjs` | Surface extraction, slope comparison, breakpoint detection |
| `lib/excel-parser.mjs` | Cell reading, sheet fingerprinting, year detection, field mapping |

## Accuracy

### Blind Eval (99.3%)

A fresh Claude API session with zero knowledge of the engine answers 25 randomized financial questions per model:

| Model | Sheets | Cells | Blind Eval |
|-------|--------|-------|------------|
| Fund model A | 2 | 5.7K | **25/25 (100%)** |
| Fund model B | 7 | 96K | **25/25 (100%)** |
| Platform model A | 51 | 1.8M | **25/25 (100%)** |
| Platform model B | 60 | 1.8M | **25/25 (100%)** |
| Corporate model A | 20 | 5.8M | **25/25 (100%)** |
| Corporate model B | 21 | 6.1M | **24/25 (96%)** |
| **Total** | | **15.5M cells** | **149/150 (99.3%)** |

### Scale

| Model Size | Sheets | Cells | Parse Time |
|------------|--------|-------|------------|
| 3 KB | 3 | 78 | 1ms |
| 332 KB | 2 | 5.7K | 56ms |
| 1.5 MB | 7 | 96K | 718ms |
| 21 MB | 38 | 1.7M | 12s |
| 52 MB | 82 | 3.7M | 3.5min |
| 84 MB | 21 | 6.1M | ~15min |

~60 Excel functions transpiled: `SUM`, `IF`, `VLOOKUP`, `INDEX/MATCH`, `IRR`, `XIRR`, `NPV`, `PMT`, `SUMIFS`, `COUNTIFS`, `INDIRECT`, `OFFSET`, and more.

## Eval Pipeline

```bash
# One-command full eval
node eval/run-all.mjs model.xlsx --questions 50 --output output/

# Containerized auto-iteration (overnight, hands-free)
cd eval && echo "ANTHROPIC_API_KEY=sk-ant-..." > .env && cp /path/to/*.xlsx models/ && ./run.sh
```

## License

MIT

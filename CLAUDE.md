# excel-to-engine — Claude Code Instructions

## What This Project Is

A toolkit for converting complex financial Excel models (.xlsx) into JavaScript computation engines. Two pipeline options: a fast Rust parser + transpiler, and an original Claude-reasoning-only approach. Unified eval tools validate both.

## Repository Structure

```
excel-to-engine/
├── pipelines/
│   ├── rust/                    # Fast: Rust parser + formula transpiler + chunked compilation
│   │   ├── src/                 # 8 Rust modules (parser, transpiler, AST, dependency graph, etc.)
│   │   ├── tests/               # Synthetic model smoke test (27/27 = 100%)
│   │   └── Cargo.toml
│   └── js-reasoning/            # Original: Claude reads Excel → reasons → writes engine.js
│       ├── skill/SKILL.md       # Claude Code skill (4-phase pipeline)
│       ├── templates/           # Engine, eval, and dashboard templates
│       └── eval-framework/      # generate-control.mjs, compare-outputs.mjs
├── eval/                        # Unified eval tools (works with both pipelines)
│   ├── iterate.mjs              # Auto-iteration: parse → eval → Claude API diagnose → patch → loop
│   ├── blind-eval.mjs           # Blind Claude API eval (50/50 on test model)
│   ├── generate-questions.mjs   # Generate test questions from ground truth
│   ├── analyze-report.mjs       # Analyze eval results, recommend fixes
│   ├── validate-engine.mjs      # Validate engine _sources against ground truth
│   ├── pipeline.mjs             # Pipeline orchestrator (parse → validate → eval)
│   ├── Dockerfile               # Container for running eval (Rust + Node)
│   ├── run.sh                   # Runner script for Docker
│   └── models/                  # Place .xlsx files here (gitignored)
├── lib/                         # Shared JS financial libraries
│   ├── irr.mjs                  # IRR/XIRR solver
│   ├── waterfall.mjs            # PE distribution waterfall
│   ├── calibration.mjs          # Auto-calibration framework
│   ├── sensitivity.mjs          # Sensitivity surface analysis
│   └── excel-parser.mjs         # Excel reader + sheet fingerprinting
├── tests/synthetic-pe-model/    # Integration test (sensitivity validation)
├── docs/                        # Historical pipeline logs and plans
├── CLAUDE.md                    # This file
├── README.md, CHANGELOG.md, ROADMAP.md, PLAN.md
└── .gitignore
```

## Two Pipelines

### Rust Pipeline (fast, automated)
Best for large models (50+ sheets, millions of cells). Parses Excel in seconds, transpiles formulas to JS, generates per-sheet modules with convergence loops for circular references.

```bash
# Build the parser
cd pipelines/rust && cargo build --release

# Parse a model (outputs chunked/ directory with per-sheet .mjs modules)
./target/release/rust-parser model.xlsx output-dir --chunked

# Run containerized eval loop (auto-improves with Claude API)
cd eval && ./run.sh
```

### JS Reasoning Pipeline (Claude-driven)
Best for smaller models where you need Claude to understand the financial logic. Uses the skill to orchestrate a 4-phase pipeline: Analyze → Generate → Test → Dashboard.

The skill is at `pipelines/js-reasoning/skill/SKILL.md`. Triggers on: "Convert this Excel model", "Build an engine from this spreadsheet".

## Using Parsed Output: Two-Tier Engine Workflow

The Rust pipeline produces two complementary outputs. **Always keep both** — they serve different use cases:

### Tier 1: Hand-crafted engines (fast, ~10 inputs)
Build a JS engine with named inputs/outputs for dashboard use. Stores base case values from ground truth, sensitizes proportionally. Runs in milliseconds, works in browsers.

**Use for:** MOIC/IRR sensitivity, exit year, carry calculations, real-time sliders.

### Tier 2: Ground truth + chunked modules (cell-level, exact)
`_ground-truth.json` has every cell value from Excel. `sheets/*.mjs` has every formula transpiled.

**Use for:** Segment P&L analysis, changing cost line items, G&A allocation scenarios — anything the hand-crafted engine doesn't expose as a named input.

### How to decide at runtime
If the user's question maps to a hand-crafted engine input parameter (exit year, exit multiple, carry rate), use Tier 1. If it requires changing something inside a segment P&L (tech headcount, specific G&A line, customer acquisition cost), use Tier 2.

### Ground truth + delta approach (recommended for Tier 2)
Rather than running the full chunked engine (which requires 8GB+ heap and ~10min for large models), load ground truth and compute deltas:

```javascript
import { readFileSync } from 'fs';
const gt = JSON.parse(readFileSync('./output/chunked/_ground-truth.json', 'utf-8'));

// Search for cells by label
const labels = Object.entries(gt)
  .filter(([k, v]) => typeof v === 'string' && /Total Revenue/i.test(v));

// Read annual data for a row
const cols = ['L','M','N','O','P','Q'];
const revenue = cols.map(c => gt['Technology!' + c + '23'] || 0);

// Compute scenario delta and apply to base case returns
const baseProfit = gt['Equity!AN346'];
const baseMOIC = gt['Equity!AN347'];
// ... (see SKILL.md for full example)
```

## How to Run Eval

### One-Command Full Eval (recommended)
```bash
node eval/run-all.mjs model.xlsx --questions 50 --output output/
```
This runs: parse → generate questions → blind eval → per-sheet eval → combined report.

### Step by Step
```bash
# 1. Parse the model
./pipelines/rust/target/release/rust-parser model.xlsx output-dir --chunked

# 2. Generate test questions
node eval/generate-questions.mjs output-dir/chunked --count 50 --output output-dir/test-questions.json

# 3. Run blind eval (needs ANTHROPIC_API_KEY)
ANTHROPIC_API_KEY=... node eval/blind-eval.mjs output-dir/chunked --questions output-dir/test-questions.json

# 4. Run per-sheet mechanical eval
node eval/per-sheet-eval.mjs output-dir/chunked --output output-dir/per-sheet-report.json

# 5. Analyze results
node eval/analyze-report.mjs output-dir/eval-report.json output-dir/analysis.json
```

### Improvement Cycle (the right way)
1. Run eval (produces analysis.json with failures)
2. Open a NEW Claude Code session (clean context)
3. Point it at analysis.json + the Rust source
4. It reads failures → fixes transpiler → rebuilds → pushes
5. Re-run eval (blind again)
6. Repeat until target accuracy

The builder session has full context. The eval session has zero context. This prevents overfitting.

### Containerized Auto-Iteration (overnight, hands-off)
```bash
cd eval
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
cp /path/to/models/*.xlsx models/
./run.sh
```

## Key Libraries (lib/)

| File | Purpose |
|------|---------|
| `lib/irr.mjs` | Newton-Raphson IRR solver with bisection fallback + XIRR |
| `lib/waterfall.mjs` | PE distribution waterfall (American + European structures) |
| `lib/calibration.mjs` | Auto-calibration with ratio/offset modes |
| `lib/sensitivity.mjs` | Sensitivity surface extraction, comparison, multi-point calibration |
| `lib/excel-parser.mjs` | Excel reader, sheet fingerprinting, year detection, field mapping, waterfall detection, cash flow extraction |

### New in excel-parser.mjs (production-informed)
- `extractWaterfallStructure(groundTruth)` — Auto-detect waterfall tiers, hurdle rates, carry %, and cash flow series from ground truth
- `extractCashFlowSeries(groundTruth)` — Extract time series for IRR computation (avoids MOIC^(1/n) approximation)
- New label aliases: carry, prefReturn, catchUp, distributions, peakEquity, waterfallTier, mip

## Templates

Located at `pipelines/js-reasoning/templates/`:
- `engine-template.js` — Engine skeleton with calibration system
- `eval-template.mjs` — Eval suite template
- `dashboard/` — HTML dashboard (Tailwind + Chart.js, zero build step)

## Engine Validation

When building engines that consume ground truth values (carry calculators, scenario dashboards, etc.), use `_sources` metadata and the validation script to prevent wrong-sheet/wrong-model errors.

### The _sources pattern

Add a `_sources` block to any exported object that stores values from ground truth:

```javascript
export const MY_VEHICLE = {
  _sources: {
    groundTruth: 'output-dir',          // directory containing _ground-truth.json
    cells: {
      totalCarry: 'Sheet!D86',          // direct cell reference
      'tiers.catchUp': 'Sheet!D61',     // dot-path into nested base object
    },
    aggregates: {                        // optional: sum across multiple cells
      totalCarry: {
        cells: ['ClassA!D86', 'ClassB!D86'],
        op: 'sum',
      },
    },
  },
  base: {
    totalCarry: 49_287_893,
    tiers: { catchUp: 16_152_014 },
  },
};
```

### Validate before deploying

```bash
node eval/validate-engine.mjs path/to/engine.js --gt-root path/to/engines/
node eval/validate-engine.mjs path/to/engine.js --strict   # 0.01% tolerance
```

The script reads `_sources.cells` and checks every value against `_ground-truth.json`. Exits non-zero on failure.

### Common errors this catches

- **Wrong model**: Using a standalone A-1 ground truth when a combined A-2 exists
- **Wrong sheet**: Looking up a value from the wrong investor class or waterfall tab
- **Wrong column**: Ground truth column M contains a label string, column N has the value
- **Arithmetic estimates**: Computing carry as `(grossMOIC - netMOIC) × equity` instead of using the model's actual waterfall cell
- **Multi-class understatement**: Forgetting to sum carry across multiple investor classes

## Important Notes

- Public open-source project — never include proprietary data, real financials, or participant names
- All examples use synthetic/dummy data
- Licensed under MIT

## Mandatory: Update Project Files on Every Change

After ANY code change, deploy, or meaningful work session:
1. **CHANGELOG.md** — Add entry with today's date and what changed
2. **PLAN.md** — Update status/phase if it changed
3. **ROADMAP.md** — Move completed items, add discovered work
4. **README.md** — Update if architecture/setup/structure changed

These updates are NOT optional. The daily code review reads these files.

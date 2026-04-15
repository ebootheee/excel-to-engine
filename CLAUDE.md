# excel-to-engine — Claude Code Instructions

## What This Project Is

A toolkit for converting complex financial Excel models (.xlsx) into JavaScript computation engines, then querying and analyzing them via a CLI. Three layers:

1. **Pipelines** — Rust parser or Claude-reasoning pipeline converts Excel → ground truth + JS modules
2. **CLI (`ete`)** — Scenario analysis, sensitivity, P&L extraction, and queries against any converted model
3. **Eval** — Blind evaluation and accuracy testing

## Repository Structure

```
excel-to-engine/
├── cli/                             # Analysis CLI (the `ete` command)
│   ├── index.mjs                    # Entry point + arg parsing
│   ├── commands/                    # 8 commands: init, manifest, query, pnl, scenario, sensitivity, compare, summary
│   ├── extractors/                  # Date detector, annual aggregator, segment detector, waterfall detector, line-item resolver
│   ├── solvers/                     # Delta cascade (financial math chain), scenario engine
│   └── format.mjs                   # Output formatting (table, json, csv, markdown)
├── skill/                           # Claude Code skill for the CLI
│   └── SKILL.md                     # PE language → CLI parameter translation
├── pipelines/
│   ├── rust/                        # Rust parser + formula transpiler + chunked compilation
│   │   ├── src/                     # 8 modules (parser, transpiler, AST, dependency, etc.)
│   │   └── tests/                   # Synthetic model smoke test (78/78 = 100%)
│   └── js-reasoning/                # Claude reads Excel → reasons → writes engine.js
│       ├── skill/SKILL.md           # 4-phase pipeline skill
│       └── templates/               # Engine, eval, dashboard templates
├── eval/                            # Unified eval tools
│   ├── blind-eval.mjs              # Blind Claude API eval
│   ├── validate-engine.mjs          # Validate engine _sources against ground truth
│   └── ...
├── lib/                             # Shared JS financial libraries
│   ├── manifest.mjs                 # Manifest schema, auto-gen, validation
│   ├── irr.mjs                      # IRR/XIRR solver
│   ├── waterfall.mjs                # PE distribution waterfall
│   ├── calibration.mjs              # Auto-calibration framework
│   ├── sensitivity.mjs              # Sensitivity surface analysis
│   └── excel-parser.mjs             # Excel reader + sheet fingerprinting
├── tests/
│   ├── cli/                         # CLI integration tests (34/34 pass)
│   └── synthetic-pe-model/          # Sensitivity validation test
└── scenarios/examples/              # Example scenario files
```

## CLI Usage (`ete`)

The CLI is the primary interface for analyzing converted models. It reads manifest + ground truth and computes scenarios without re-running the full engine.

### Quick Start

```bash
# Parse a model and generate manifest
node cli/index.mjs init model.xlsx --output ./my-model/

# Get a model overview
node cli/index.mjs summary ./my-model/chunked/

# Extract annual P&L
node cli/index.mjs pnl ./my-model/chunked/ --growth

# Run a scenario
node cli/index.mjs scenario ./my-model/chunked/ --exit-multiple 16 --revenue-adj techGP:-20%

# Sensitivity table
node cli/index.mjs sensitivity ./my-model/chunked/ --vary exit-multiple:14-22:1 --metric grossIRR,grossMOIC

# Compare scenarios
node cli/index.mjs compare ./my-model/chunked/ --base "" --alt "exit-multiple=16" --attribution
```

### Command Reference

| Command | Purpose |
|---------|---------|
| `init` | Parse Excel → chunked engine → manifest in one step |
| `summary` | One-shot model overview (segments, returns, carry, debt) |
| `query` | Cell lookup, label search, or manifest name resolution |
| `pnl` | Annual P&L by segment with growth rates and subsegment detail |
| `scenario` | Run scenario with 25+ adjustment parameters |
| `sensitivity` | 1D sweep or 2D surface across any parameter |
| `compare` | Base vs alt, named scenarios, cross-model, attribution analysis |
| `manifest` | Generate or validate model manifest |

### Scenario Parameters (Full Set)

**Exit:** `--exit-year`, `--exit-multiple`, `--revenue-multiple`
**Revenue:** `--revenue-adj seg:±%/$`, `--revenue-growth seg:rate`, `--remove-segment`, `--add-revenue`, `--override-arr`
**Cost:** `--cost-adj seg:±%/$`, `--line-item id:adj`, `--cost-ratio seg:ratio`, `--capitalize item:years`
**Capital:** `--leverage ltv`, `--equity-override`, `--distribution year:amount`
**Valuation:** `--sotp`, `--segment-multiple seg:n`, `--discount-rate`
**Returns:** `--pref-return`, `--hold-period`
**Management:** `--file scenario.json`, `--save name`, `--load name`, `--list`
**Output:** `--metric list`, `--format table|json|csv|markdown`, `--attribution`

### Claude Code Skill

The skill at `skill/SKILL.md` teaches Claude to translate PE analyst language into CLI commands:
- "What if tech grows at 40%?" → `--revenue-growth techGP:0.40`
- "Drop the multiple 2 turns" → `--exit-multiple {base - 2}`
- "Capitalize headcount over 5y" → `--capitalize tech_headcount:5`

See the skill file for the full translation guide, command chaining patterns, and interpretation guidance.

## Manifest System

Every converted model needs a `manifest.json` that maps financial concepts to specific cells. The manifest is auto-generated by heuristic pattern matching:

```bash
node cli/index.mjs manifest generate ./my-model/chunked/
node cli/index.mjs manifest validate ./my-model/chunked/manifest.json
```

The manifest maps segments (revenue/expense rows), outputs (EBITDA, terminal value), equity classes (MOIC, IRR cells), carry tiers, debt, and custom cells. All scenario commands read this manifest to know where things are in the model.

## Two Pipelines

### Rust Pipeline (fast, automated)
Best for large models (50+ sheets, millions of cells). Parses Excel in seconds, transpiles formulas to JS, generates per-sheet modules.

```bash
cd pipelines/rust && cargo build --release
./target/release/rust-parser model.xlsx output-dir --chunked
```

### JS Reasoning Pipeline (Claude-driven)
Best for smaller models where Claude should understand the financial logic. Skill at `pipelines/js-reasoning/skill/SKILL.md`.

## Key Libraries (lib/)

| File | Purpose |
|------|---------|
| `lib/manifest.mjs` | Manifest schema, auto-generation, validation, cell resolvers |
| `lib/irr.mjs` | Newton-Raphson IRR solver with bisection fallback + XIRR |
| `lib/waterfall.mjs` | PE distribution waterfall (American + European structures) |
| `lib/calibration.mjs` | Auto-calibration with ratio/offset modes |
| `lib/sensitivity.mjs` | Sensitivity surface extraction, comparison, multi-point calibration |
| `lib/excel-parser.mjs` | Excel reader, sheet fingerprinting, year detection |

## Eval Pipeline

```bash
# One-command full eval
node eval/run-all.mjs model.xlsx --questions 50 --output output/

# Validate engine base case values
node eval/validate-engine.mjs path/to/engine.js --gt-root path/to/models/
```

The script reads `_sources.cells` and checks every value against `_ground-truth.json`. Exits non-zero on failure.

### Common errors this catches

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

# excel-to-engine — Claude Code Instructions

## What This Project Is

A toolkit for converting financial Excel models (.xlsx) into JavaScript computation engines. It provides reusable libraries (IRR, waterfall, calibration, Excel parsing), a Claude Code skill for the full pipeline, and dashboard templates.

## Architecture Philosophy

This project has two distinct layers, and LLMs working on it need to understand which layer they're operating in.

### Layer 1: Deterministic Transpilation (Rust parser — the primary path)

The Rust parser (`rust-parser/`) reads Excel formulas, builds an AST, and emits mechanically correct JavaScript. This is the **default path** for converting Excel to JS. It handles ~60 Excel functions, circular references (Tarjan's SCC + convergence loops), cross-sheet dependencies, and topological ordering.

This layer converges. There's a finite set of Excel functions and patterns used in financial models. As the transpiler encounters new models, its coverage expands until it handles ~95%+ of formulas. Once there, it's done — the transpiler ships and produces correct engines without any LLM involvement.

**What it produces**: A `raw-engine.js` file that is mechanically correct but has no semantic understanding — variables are named after cell references, there's no concept of "inputs" vs "outputs", and no human-readable structure.

### Layer 2: LLM as Read/Write/Iterate Tool (on the transpiled JS)

The LLM's job is to **work with the transpiled JS**, not to reverse-engineer Excel math. Specifically:

- **Semantic layer**: Name variables meaningfully, identify what's an input vs output vs intermediate, add structure
- **Gap-filling**: When the transpiler leaves placeholders (unsupported formulas, macros), the LLM fills them — reading surrounding transpiled code for context
- **Dashboard & UX**: Generate interactive dashboards, write documentation, answer user questions about the model
- **Testing**: Design eval suites, monotonicity invariants, consistency checks
- **Diagnosis**: When automated calibration plateaus, the LLM reads `diagnostics.json` and fixes the specific stuck outputs

### How Calibration Fits In

Calibration (`lib/calibration.mjs`, `lib/sensitivity.mjs`) is a **verification and fallback** mechanism, not the primary strategy:

- **Verification**: After transpilation, calibration confirms the engine matches Excel. If it does, no correction needed.
- **Single-point fallback**: For the ~5% of formulas the transpiler can't handle, scale factors patch the gap.
- **Multi-point fallback**: For nonlinearities near waterfall hurdles and MIP thresholds, piecewise-linear corrections handle breakpoints where single-point fails.

The goal is to shrink the calibration surface over time as the transpiler's formula coverage grows.

## How to Use the Skill

The `skill/SKILL.md` file defines the `excel-to-engine` skill. It triggers on phrases like:
- "Convert this Excel model"
- "Build an engine from this spreadsheet"
- "Financial model to code"

The skill runs a 4-phase pipeline: Analyze, Generate, Test, Dashboard.

## Key Files

| File | Purpose |
|------|---------|
| `skill/SKILL.md` | Claude Code skill — orchestrates the full pipeline |
| `lib/irr.mjs` | Newton-Raphson IRR solver with bisection fallback |
| `lib/waterfall.mjs` | Standard PE distribution waterfall calculator |
| `lib/calibration.mjs` | Auto-calibration framework for matching Excel |
| `lib/excel-parser.mjs` | Excel reader, cell detection, model map builder |
| `lib/sensitivity.mjs` | Multi-point calibration, breakpoint detection, surface analysis |
| `rust-parser/src/formula_ast.rs` | Excel formula tokenizer + AST parser |
| `rust-parser/src/transpiler.rs` | AST → JavaScript code generation (~60 Excel functions) |
| `rust-parser/src/dependency.rs` | Cell dependency graph + circular ref detection (Tarjan's SCC) |
| `container/pipeline.mjs` | Automated pipeline: parse → validate → eval → output |
| `templates/engine-template.js` | Starting skeleton for generated engines |
| `templates/dashboard/` | HTML dashboard template (index.html, styles.css, app.js) |

## Where Templates Are

- **Engine template**: `templates/engine-template.js` — Copy to target project as `engine.js`, fill in inputs/logic
- **Dashboard template**: `templates/dashboard/` — Copy to target project's `dashboard/`, replace `{{PLACEHOLDERS}}`

## How to Run Tests

After generating an engine and eval suite for a specific model:

```bash
# Install dependencies
npm install

# Run eval suite
node tests/eval.mjs

# View dashboard
npx serve dashboard/
# or just open dashboard/index.html in a browser
```

## How to Iterate on an Engine

1. Run `node tests/eval.mjs` to see current accuracy
2. Look at failing tests — which outputs deviate most?
3. Improve the calculation logic in `engine.js` for those outputs
4. Re-run eval — the calibration system auto-adjusts scale factors
5. Repeat until all tests pass within tolerance (default 1%)

## Dependencies

- `xlsx` (SheetJS) — for reading Excel files. Install with `npm install xlsx`.
- No other runtime dependencies. The libraries are pure JavaScript ES modules.
- Dashboard uses Tailwind CSS and Chart.js via CDN (no build step).

## Important Notes

- This is a public open-source project — never include proprietary data, real financials, or participant names
- All examples use synthetic/dummy data
- The libraries work for any PE/RE financial model, not just specific funds
- Licensed under MIT

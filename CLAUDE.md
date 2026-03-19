# excel-to-engine — Claude Code Instructions

## What This Project Is

A toolkit for converting financial Excel models (.xlsx) into JavaScript computation engines. It provides reusable libraries (IRR, waterfall, calibration, Excel parsing), a Claude Code skill for the full pipeline, and dashboard templates.

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

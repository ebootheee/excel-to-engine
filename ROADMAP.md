# excel-to-engine — Roadmap

## Near-Term (Next)

### Unit Test Suite
- Tests for `lib/irr.mjs` with known IRR cases (simple, multi-year, edge cases)
- Tests for `lib/waterfall.mjs` with standard American and European structures
- Tests for `lib/calibration.mjs` convergence and edge cases
- Tests for `lib/excel-parser.mjs` with a synthetic test workbook

### Synthetic Example Project
- Create a dummy PE fund model in Excel (no real data)
- Run the full pipeline to produce engine + tests + dashboard
- Include as `examples/synthetic-fund/` for reference

### CLI Tool
- `npx excel-to-engine analyze model.xlsx` — produce model-map.json
- `npx excel-to-engine generate model-map.json` — produce engine.js skeleton
- `npx excel-to-engine test engine.js model.xlsx` — run eval suite
- `npx excel-to-engine dashboard` — generate dashboard from engine + model map

## Medium-Term

### Enhanced Pattern Detection
- Detect sensitivity tables (data tables in Excel)
- Detect scenario switches (base/bull/bear toggles)
- Detect debt schedule structures
- Detect depreciation/amortization schedules

### Multi-Sheet Engine Support
- Generate engines with module-per-sheet architecture
- Cross-sheet reference tracking in model map
- Dependency graph visualization

### TypeScript Support
- Generate `engine.ts` with full type definitions
- Type-safe model-map.json schema
- Zod validation for inputs

### Dashboard Enhancements
- Scenario comparison mode (base vs bull vs bear)
- Export to PDF
- Shareable URL with encoded inputs
- Dark mode

## Long-Term

### Excel Formula Transpiler
- Direct Excel formula to JavaScript transpilation
- Support common Excel functions (SUMPRODUCT, INDEX/MATCH, VLOOKUP, IF chains)
- Reduce reliance on calibration for simple models

### Cloud Deployment
- One-click deploy dashboard to Vercel/Netlify
- API endpoint wrapping computeModel()
- Webhook for re-running eval on model changes

### Plugin System
- Custom financial patterns (MIP, promote, clawback)
- Custom output formatters
- Custom chart types for the dashboard

# excel-to-engine — Roadmap

## Near-Term (Next)

### Incremental Re-extraction
- Store extraction metadata (which cells were read, what values were found) alongside model-map.json
- On re-extraction, diff against previous values and only update changed fields
- Generate a "model changes" report showing what moved between versions (e.g., Q3 → Q4 model update)

### Automated Test Harness
- CI-friendly wrapper that runs `generate-control.mjs` then `compare-outputs.mjs` in sequence
- Configurable tolerance per output key (tighter for returns, looser for intermediates)
- HTML report generation from comparison-results.json
- Regression detection: compare current baseline against previous baseline

### Unit Test Suite
- Tests for `lib/irr.mjs` with known IRR cases (simple, multi-year, edge cases)
- Tests for `lib/waterfall.mjs` with standard American and European structures
- Tests for `lib/calibration.mjs` convergence and edge cases
- Tests for `lib/excel-parser.mjs` fingerprinting, year detection, classification with a synthetic test workbook

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

## Done

### Sensitivity Surface Validation & Multi-Point Calibration (2026-03-23)
- `lib/sensitivity.mjs` — full sensitivity analysis library: surface extraction, comparison, elasticity, breakpoint detection, multi-point calibration
- Synthetic PE model test proving multi-point calibration improves accuracy from 40% → 100% at breakpoints
- SKILL.md updated with sensitivity extraction (Phase 1), multi-point calibration (Phase 2), and slope validation (Phase 3)

### Sheet Fingerprinting & Multi-Year Extraction (2026-03-21)
- `fingerprintSheet()` / `fingerprintWorkbook()` — auto-detect row-to-field mappings across identical sheets using fuzzy label matching
- `matchLabel()` — fuzzy matcher with 50+ financial term aliases (revenue, EBITDA/EBITDAR/NOI, rent, IRR, MOIC, etc.)
- `detectYearRow()` — auto-detect year row and map columns to calendar years
- `extractMultiYear()` / `extractByYear()` — extract field values across years or for a specific reference year
- `detectEscalation()` — detect growth/escalation rates between adjacent years (catches rent escalation)
- `classifyAsset()` — auto-classify assets as leased/managed based on rent presence, labels, and metadata signals
- SKILL.md updated with fingerprinting workflow, reference year guidance, cross-sheet validation, and asset classification
- Model map schema updated to v1.1.0 with `referenceYear`, `sheetGroups`, `yearColumns`, and `assets` fields

### Eval Framework (2026-03-19)
- `eval-framework/generate-control.mjs` — reads BASE_CASE from engine, generates test matrix
- `eval-framework/compare-outputs.mjs` — compares candidate vs control with input alias normalization

### Skill: Terminology Mapping (2026-03-19)
- Financial term aliases in SKILL.md (incentive structures, waterfall, returns, share economics)
- Parallelization guidance across all 4 phases
- Cheat sheet pattern for fast Excel analysis

# excel-to-engine — Plan

## Status: Phase 1.5 — Core Libraries + Sheet Intelligence Built

## Objective

Build an open-source toolkit that converts complex financial Excel models (.xlsx) into JavaScript computation engines with calibrated accuracy, automated test suites, and interactive dashboards.

## Architecture

```
excel-to-engine/
├── lib/               # Reusable financial computation libraries
│   ├── irr.mjs        # Newton-Raphson IRR solver
│   ├── waterfall.mjs  # PE distribution waterfall
│   ├── calibration.mjs # Auto-calibration framework
│   └── excel-parser.mjs # Excel reader + model detection
├── templates/         # Code generation templates
│   ├── engine-template.js
│   └── dashboard/     # HTML dashboard (Tailwind + Chart.js)
├── skill/             # Claude Code skill definition
│   └── SKILL.md
└── tests/             # (generated per-model)
```

## Phases

### Phase 1 — Core Libraries (DONE)
- [x] `lib/irr.mjs` — Newton-Raphson IRR with bisection fallback + XIRR
- [x] `lib/waterfall.mjs` — Generic PE waterfall (American + European)
- [x] `lib/calibration.mjs` — Auto-calibration with ratio/offset modes
- [x] `lib/excel-parser.mjs` — Cell reading, input/output detection, model map builder
- [x] `templates/engine-template.js` — Engine skeleton with calibration system
- [x] `templates/dashboard/` — 2-tab HTML dashboard (explorer + eval)
- [x] `skill/SKILL.md` — Claude Code skill for 4-phase pipeline
- [x] Project documentation (README, CLAUDE.md, PLAN, CHANGELOG, ROADMAP)

### Phase 1.5 — Sheet Intelligence (DONE)
- [x] Sheet fingerprinting — auto-detect row-to-field mappings with fuzzy label matching
- [x] Year detection — auto-detect year rows and column-to-year mapping
- [x] Multi-year extraction — extract time series per field across years
- [x] Reference year extraction — extract all fields for a target projection year
- [x] Escalation detection — compute year-over-year growth rates
- [x] Asset classification — auto-classify leased/managed from metadata signals
- [x] SKILL.md updated with fingerprinting workflow, cross-sheet validation, reference year guidance

### Phase 1.75 — Sensitivity Surface Validation (DONE)
- [x] `lib/sensitivity.mjs` — surface extraction, comparison, elasticity, breakpoint detection
- [x] Multi-point calibration with piecewise-linear corrections
- [x] Synthetic PE model test (`tests/synthetic-pe-model/`) proving 40% → 100% accuracy improvement
- [x] SKILL.md updated with sensitivity extraction, multi-point calibration, and slope validation guidance
- [x] Exported `getNestedValue`/`setNestedValue` from calibration.mjs

### Phase 2 — Testing + Validation (Next)
- [ ] Unit tests for lib/irr.mjs (known IRR cases)
- [ ] Unit tests for lib/waterfall.mjs (standard structures)
- [ ] Unit tests for lib/calibration.mjs (convergence)
- [x] Integration test with a synthetic PE model (sensitivity surface validation)
- [ ] CI pipeline

### Phase 3 — Polish + Publish
- [ ] npm publish preparation
- [ ] GitHub Actions CI
- [ ] Example project with synthetic data
- [ ] Contributing guide

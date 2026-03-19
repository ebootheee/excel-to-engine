# excel-to-engine — Plan

## Status: Phase 1 Complete — Core Libraries + Templates Built

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

### Phase 2 — Testing + Validation (Next)
- [ ] Unit tests for lib/irr.mjs (known IRR cases)
- [ ] Unit tests for lib/waterfall.mjs (standard structures)
- [ ] Unit tests for lib/calibration.mjs (convergence)
- [ ] Integration test with a synthetic Excel model
- [ ] CI pipeline

### Phase 3 — Polish + Publish
- [ ] npm publish preparation
- [ ] GitHub Actions CI
- [ ] Example project with synthetic data
- [ ] Contributing guide

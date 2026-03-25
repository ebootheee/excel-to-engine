# excel-to-engine — Plan

## Status: Rust Transpiler is Primary Path — Skill & Docs Update Next

## Objective

Build an open-source toolkit that converts complex financial Excel models (.xlsx) into JavaScript computation engines with deterministic accuracy, automated test suites, and interactive dashboards.

## Architecture

Two-layer approach:

```
Layer 1: Rust Transpiler (deterministic, fast, primary)
  Excel → Parse → AST → JS
  Converges as function coverage grows toward ~95%+

Layer 2: LLM Semantic Layer (on transpiled output)
  raw-engine.js → naming, gap-filling, dashboards, testing
  Calibration for verification + fallback
```

## Completed

- [x] Core JS libraries (IRR, waterfall, calibration, excel-parser, sensitivity, self-eval)
- [x] Engine + dashboard templates
- [x] Claude Code skill (SKILL.md) — 4-phase pipeline
- [x] Sheet fingerprinting, year detection, multi-year extraction, asset classification
- [x] Sensitivity surface validation + multi-point calibration
- [x] Eval framework (generate-control, compare-outputs)
- [x] Rust transpiler — formula AST, ~60 Excel functions, Tarjan's SCC, convergence loops
- [x] Container pipeline — Docker, automated eval loop, WebSocket monitor
- [x] Architecture philosophy documented (CLAUDE.md)

## Next: Skill & Documentation for LLM-on-Transpiled-JS Workflow

- [ ] Update SKILL.md Phase 2 to default to Rust transpiler output
- [ ] Define LLM's role on transpiled JS: semantic naming, gap-filling, dashboard generation
- [ ] Document how LLMs read diagnostics.json when automated calibration plateaus
- [ ] Add guidance: when to fix transpiler coverage (root cause) vs when to calibrate (patch)
- [ ] Expand transpiler function coverage as real-world models reveal gaps

## Future

- [ ] Unit tests for core libraries
- [ ] CI pipeline (GitHub Actions)
- [ ] npm publish
- [ ] WASM build for browser-side parsing
- [ ] CLI tool (`npx excel-to-engine analyze model.xlsx`)

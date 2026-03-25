# Rust Engine Pipeline Plan (Chunked Compilation)

Date: 2026-03-23  
Owner: Active agent handoff plan  
Status: In progress (Model-A UAT started, 59.3% accuracy on spot-check)

## Objective

Implement **Option C: Chunked Compilation** in `rust-parser` so the parser compiles Excel models directly into sheet-level JavaScript modules plus a minimal orchestrator/manifest for scalable evaluation.

### Success Criteria

- No monolithic graph/code artifact required for evaluation.
- Output directory contains:
  - `sheets/<SheetName>.mjs` (sheet-local compute modules)
  - `_graph.json` (sheet-level DAG)
  - `_ground-truth.json` (KPI address/value checks)
  - `engine.js` (orchestrator loading sheets in topo order)
- Generated engine can execute end-to-end for synthetic test workbook.
- Eval path can validate generated outputs against control values.

## Architecture Contract

### Inputs

- Parsed workbook model from existing Rust parser pipeline
- Cell formulas, literals, ranges, sheet names, and dependency map

### Outputs

- **Per-sheet module**: `sheets/<SheetName>.mjs`
  - Exports:
    - `SHEET_NAME`
    - `SHEET_DEPENDENCIES` (array of sheet names)
    - `compute(ctx)` function
  - `ctx` contract:
    - `ctx.values`: map of fully qualified cell addresses (`Sheet!A1`) -> value
    - `ctx.get(addr)`: safe getter
    - `ctx.set(addr, value)`: setter
- **Manifest**: `_graph.json`
  - `{ sheets: [{ name, deps: string[] }], topoOrder: string[] }`
- **Ground truth**: `_ground-truth.json`
  - `{ "Sheet!A1": expectedValue, ... }` (KPI subset only)
- **Orchestrator**: `engine.js`
  - Imports sheet modules
  - Validates topo order
  - Executes `compute` in order
  - Exports `run(inputs?) -> { values, kpis }`

### Error Modes

- Circular sheet dependencies: fail generation with cycle report
- Missing referenced sheet: fail generation with unresolved-reference report
- Unsupported formulas/functions: emit diagnostic and either
  - hard-fail in strict mode, or
  - emit `undefined` assignment in permissive mode with warning

## Sheet Module Design

Each `sheets/<SheetName>.mjs` should follow this skeleton:

```js
export const SHEET_NAME = "CashFlow";
export const SHEET_DEPENDENCIES = ["Assumptions"];

export function compute(ctx) {
  // literal/input cells
  // formula cells translated to JS expressions
  // ctx.set("CashFlow!B12", expr)
}
```

### Translation Rules (MVP)

- Address normalization: always `Sheet!A1`
- Intra-sheet refs: direct `ctx.get("Sheet!A1")`
- Cross-sheet refs: also via `ctx.get("Other!B3")` (import metadata used for DAG, not value transport)
- Ranges: represent as helper calls (`ctx.range("Sheet!A1:B5")`) only if runtime helper exists; otherwise expand for small ranges during compile
- Deterministic ordering inside sheet:
  1. input/literal assignments
  2. formula assignments in dependency order (cell-level topo within sheet)

## Implementation Milestones

1. **Inventory + integration points**
   - Locate current emit/transpile modules and CLI entrypoint.
   - Identify where single-artifact generation occurs.
2. **Add sheet partition pass**
   - Group cells by worksheet.
   - Compute sheet-level deps from existing cell deps.
3. **Emit per-sheet modules**
   - Create `sheets/` folder output.
   - Generate one `.mjs` per sheet with stable sort.
4. **Emit minimal manifest + ground truth**
   - `_graph.json` and `_ground-truth.json`.
5. **Emit orchestrator `engine.js`**
   - Static imports and topo execution.
6. **Pipeline/eval wiring**
   - Update JS eval path to load generated engine artifacts.
7. **Validation/UAT**
   - Synthetic model
   - Model-B (21MB), Model-A (52MB), Model-C (80MB)

## Edge Cases Checklist

- Empty sheets and hidden sheets
- Named ranges spanning sheets
- Cross-sheet circular refs detected at sheet layer
- Volatile/unsupported Excel functions
- Non-numeric cell types (text/boolean/error)

## Verification Gates

- **Build**: `cargo build` in `rust-parser`
- **Tests**: `cargo test` (existing + new generation tests)
- **Smoke run**: generate chunked output for a synthetic workbook and execute `engine.js`
- **Eval check**: compare `_ground-truth.json` KPI results

Record each gate as PASS/FAIL in `LOG-rust-pipeline.md`.

## Handoff Protocol

Any incoming agent should:

1. Read this file and `LOG-rust-pipeline.md` first.
2. Continue from the first unchecked milestone.
3. Append log entries (do not rewrite history).
4. Keep output contract backward-compatible unless explicitly versioned.

## Immediate Next Actions

- Isolate root vs. cascading failures to get true per-formula accuracy.
- Implement SUMIF/COUNTIF runtime evaluation (currently stubbed as 0).
- Improve OFFSET handling for dynamic ranges.
- Investigate SUM range truncation in formula parser.
- Test against Model-B (21MB) and Model-C (80MB) models.

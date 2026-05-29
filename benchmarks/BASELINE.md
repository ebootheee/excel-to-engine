# model benchmark — baseline & history

Real accuracy: each standalone sheet recomputed live vs ground truth via
`eval/per-sheet-eval.mjs` (numbers within 1% rel. tol, strings exact).
Circular-cluster sheets and oversized sheets are **skipped** for now (see
the Skipped column + blockers below) pending the single-pass orchestrator
eval; run with `--with-clusters` once that lands. Aggregate-only — no cell
values or full sheet inventory. Regenerate:
`node benchmarks/bench.mjs --root <engines>`. Full per-sheet detail
lands in the gitignored `benchmarks/results/`.

_Last run: baseline-2026-05-28_

| Model | Accuracy | Cells matched | Sheets ≥95% | Skipped | Eval time | GT |
|-------|---------:|------:|:-----------:|:-------:|----------:|---:|
| Model A | 84.33% | 1491/1768 | 1/3 | 17 | 41s | 201.5 MB |
| Model B | 85.54% | 1686/1971 | 2/4 | 17 | 45s | 211 MB |

## Known blocker categories

Tracked by name because PLAN.md already calls them out; values are accuracy %, not financials.

- **Model A**: 1/3 sheets clean; blockers: Owned Asset PP&E (skipped: module too large (190MB > 150MB limit)); Headcount (skipped: circular cluster (--skip-clusters; needs single-pass orchestrator eval))
- **Model B**: 2/4 sheets clean; blockers: Owned Asset PP&E (skipped: module too large (190MB > 150MB limit)); Headcount (skipped: circular cluster (--skip-clusters; needs single-pass orchestrator eval))

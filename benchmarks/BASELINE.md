# model benchmark — baseline & history

Real accuracy: each standalone sheet recomputed live vs ground truth via
`eval/per-sheet-eval.mjs` (numbers within 1% rel. tol, strings exact).
Circular-cluster sheets and oversized sheets are **skipped** for now (see
the Skipped column + blockers below) pending the single-pass orchestrator
eval; run with `--with-clusters` once that lands. Aggregate-only — no cell
values or full sheet inventory. Regenerate:
`node benchmarks/bench.mjs --root <engines>`. Full per-sheet detail
lands in the gitignored `benchmarks/results/`.

_Last run: 2026-05-29T20-23-15-471Z_

| Model | Accuracy | Cells matched | Sheets ≥95% | Skipped | Eval time | GT |
|-------|---------:|------:|:-----------:|:-------:|----------:|---:|
| Model A | 98.02% | 1733/1768 | 2/3 | 17 | 31s | 177 MB |
| Model B | 97.82% | 1928/1971 | 3/4 | 17 | 42s | 185.4 MB |

## Known blocker categories

Tracked by name because PLAN.md already calls them out; values are accuracy %, not financials.

- **Model A**: 2/3 sheets clean; blockers: Owned Asset PP&E (skipped: module too large (190MB > 150MB limit)); Headcount (skipped: circular cluster (--skip-clusters; needs single-pass orchestrator eval))
- **Model B**: 3/4 sheets clean; blockers: Owned Asset PP&E (skipped: module too large (190MB > 150MB limit)); Headcount (skipped: circular cluster (--skip-clusters; needs single-pass orchestrator eval))

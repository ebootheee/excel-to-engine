# engine-speed efficacy — correctness gate + speed/memory/structure history

The rapid-iteration loop for the engine-speed lanes. Each run recomputes the
committed synthetic fixtures and PROVES every named output against the blessed
golden within 1e-6 (rel+abs) — any drift exits non-zero. Aggregate-only: no cell
values or labels (fixtures are synthetic; full detail stays in the gitignored
`benchmarks/results/`). Regenerate:

```
node benchmarks/efficacy.mjs --fixture mini-cyclic --variant baseline --bless     # (re)record golden
node benchmarks/efficacy.mjs --fixture mini-cyclic --variant baseline --compare baseline
```

Variants: `baseline` (full run, implemented) · `scoped` (Lane 2 cone module — Wave 2) · `cycle` (Lane 1 cell-level cycle — Wave 2).

## Latest per fixture × variant

| Fixture | Variant | Correct | maxRelErr | Run ms | Speedup× | Cells/pass | ÷ratio | Module MB | Mod× | Converged |
|---------|---------|--------:|----------:|-------:|---------:|-----------:|-------:|----------:|-----:|:---------:|
| midi-cyclic | baseline | 100% | 0 | 205.18 | — | — | — | 5.72 | — | yes |
| midi-cyclic | cycle | 100% | 0 | 165.67 | 1.587 | 3 | ÷33334.7 | 5.06 | 1.13× | yes |
| midi-cyclic | scoped | 100% | 0 | 0.32 | 1075.414 | 3 | ÷33334.7 | 0.01 | 895.203× | yes |
| mini-cyclic | baseline | 100% | 0 | 5.88 | 0.812 | — | — | 0.08 | 1× | yes |
| mini-cyclic | cycle | 100% | 0 | 1.71 | 2.353 | 3 | ÷401.3 | 0.06 | 1.282× | yes |
| mini-cyclic | scoped | 100% | 0 | 0.38 | 9.834 | 3 | ÷401.3 | 0.01 | 12.549× | yes |

_Last run: 2026-06-04T22:12:59.653Z · 15 run(s) recorded._

## Recent runs

| Time (UTC) | Fixture | Variant | OK | Correct | Run ms | Speedup× |
|------------|---------|---------|:--:|--------:|-------:|---------:|
| 2026-06-04T04:39:23.742Z | mini-cyclic | baseline | ✓ | 100% | 1.67 | — |
| 2026-06-04T04:39:24.032Z | mini-cyclic | baseline | ✓ | 100% | 3.93 | 0.466 |
| 2026-06-04T21:30:31.524Z | mini-cyclic | baseline | ✓ | 100% | 3.81 | — |
| 2026-06-04T21:34:57.898Z | mini-cyclic | scoped | ✓ | 100% | 0.26 | 13.396 |
| 2026-06-04T21:35:09.790Z | mini-cyclic | cycle | ✓ | 100% | 1.74 | 2.23 |
| 2026-06-04T21:35:24.658Z | midi-cyclic | baseline | ✓ | 100% | 205.18 | — |
| 2026-06-04T21:35:35.258Z | midi-cyclic | scoped | ✓ | 100% | 0.31 | 855.846 |
| 2026-06-04T21:35:36.939Z | midi-cyclic | cycle | ✓ | 100% | 165.67 | 1.587 |
| 2026-06-04T22:02:34.747Z | mini-cyclic | scoped | ✓ | 100% | 0.29 | 12.585 |
| 2026-06-04T22:02:42.720Z | mini-cyclic | cycle | ✓ | 100% | 2.36 | 1.943 |
| 2026-06-04T22:02:49.852Z | midi-cyclic | scoped | ✓ | 100% | 0.54 | 773.896 |
| 2026-06-04T22:05:10.498Z | mini-cyclic | baseline | ✓ | 100% | 5.88 | 0.812 |
| 2026-06-04T22:05:10.869Z | mini-cyclic | scoped | ✓ | 100% | 0.38 | 9.834 |
| 2026-06-04T22:05:11.359Z | mini-cyclic | cycle | ✓ | 100% | 1.71 | 2.353 |
| 2026-06-04T22:12:59.653Z | midi-cyclic | scoped | ✓ | 100% | 0.32 | 1075.414 |

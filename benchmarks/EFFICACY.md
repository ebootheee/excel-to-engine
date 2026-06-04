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

| Fixture | Variant | Correct | maxRelErr | Run ms | Speedup× | Passes | Converged | Formula cells | Cyc.sheets | Module MB |
|---------|---------|--------:|----------:|-------:|---------:|-------:|:---------:|--------------:|-----------:|----------:|
| mini-cyclic | baseline | 100% | 0 | 3.93 | 0.466 | 14 | yes | 605 | 2 | 0.08 |

_Last run: 2026-06-04T04:39:24.032Z · 2 run(s) recorded._

## Recent runs

| Time (UTC) | Fixture | Variant | OK | Correct | Run ms | Speedup× |
|------------|---------|---------|:--:|--------:|-------:|---------:|
| 2026-06-04T04:39:23.742Z | mini-cyclic | baseline | ✓ | 100% | 1.67 | — |
| 2026-06-04T04:39:24.032Z | mini-cyclic | baseline | ✓ | 100% | 3.93 | 0.466 |

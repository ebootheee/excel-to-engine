# Hard-wave findings

Empirical results from stressing the engine with harder synthetic models than the
12 persona models (which are all small / acyclic / clean). Every number below is
from a real `run()` against a generated model, cross-checked to a closed form.
Each finding ties to a backlog item and/or the Mippy lock-grade engine work
(excel-to-engine #22 / Mippy T-078, see memory `project_lockgrade_engine`).

## Probe setup

Throwaway model at `engines/_circular-probe/` (gitignored). A true single-period
cash-sweep revolver — a genuine 2-cell cycle, not the `×0` trick:

```
Interest    = EndingDebt × rate          (Model!B1)
EndingDebt  = OpeningDebt − (EBITDA − Interest)   (Model!B2)
closed form:  EndingDebt = (OpeningDebt − EBITDA) / (1 − rate)
```
OpeningDebt 50M, EBITDA 10M. `make.mjs` writes the .xlsx, `ete init` + `ete verify`
confirm base-case reproduction, `probe.mjs` sweeps `rate` across the divergence
boundary, `determinism.mjs` checks purity.

## F1 — Convergence is EXACT for fast-contractive cycles ✅

For rate well below 1 the solver lands on the exact fixed point:

| rate | engine EndingDebt | closed form | abs error |
|------|-------------------|-------------|-----------|
| 0.08 (base) | 43,478,260.87 | 43,478,260.87 | exact |
| 0.50 | 79,999,999.99 | 80,000,000 | ~6e-7 |
| 0.90 | 399,999,999.72 | 400,000,000 | 0.28 |

So the Tarjan-SCC + convergence-loop machinery is sound when the iteration is
comfortably contractive. The next findings are about the edges — where Mippy got
burned.

## F2 — Slow-contractive cycles terminate EARLY with a wrong value, still report converged ✅→🐛

As `rate → 1⁻` the iteration ratio approaches 1 and convergence slows. The engine
stops before reaching the true fixed point but still reports success:

| rate | engine EndingDebt | closed form | error | meta.converged |
|------|-------------------|-------------|-------|----------------|
| 0.95 | 799,971,957.87 | 800,000,000 | 0.0035% | true |
| 0.99 | 3,464,081,300.57 | 4,000,000,000 | **13.4%** | **true** |

A 13% error reported as a clean, converged answer is a trust failure: a consumer
has no signal the number is wrong.

## F3 — Divergent cycles return SILENT garbage, report converged ✅→🐛 (the serious one)

At `rate ≥ 1` the recurrence `x ← (OpeningDebt − EBITDA) + rate·x` is
non-contractive — there is no finite fixed point — yet the engine never raises,
never returns NaN, and always reports `converged: true`:

| rate | engine EndingDebt | truth | meta.converged |
|------|-------------------|-------|----------------|
| 1.00 | 240,000,000 | ∞ (no fixed point) | **true** |
| 1.05 | 13,833,264,652,128 | →∞ | **true** |
| 2.00 | 6.43e67 | →∞ | **true** |

**Root cause of the rate=1.0 number (exact):** override runs **cold-start the cycle
cells from 0** (not from the cached base — confirmed: a warm start from 43.5M would
give 283.5M, not 240M). The iteration is `xₙ₊₁ = 40M + rate·xₙ`; at rate=1 from a
zero seed: 40M, 80M, 120M, 160M, 200M, **240M**. The staleness heuristic
(`if |maxDelta − prevDelta| < TOL·0.01 for 5 consecutive iters: break`) sees a
**constant** +40M per-iter delta, counts it as "stopped improving," and breaks at
the 6th pass — returning exactly 6×40M = 240,000,000. Constant nonzero delta
(linear divergence) is misclassified as convergence. (Note for Mippy: this engine
cold-starts override cycles, so its warm-start NaN must live in the *real* engine's
cross-sheet seeding, not in this code path — see F5.)

## F4 — Intra-sheet cycles emit NO real convergence telemetry 🐛

For a cycle whose cells live on ONE sheet, `meta` is **always exactly**:
```json
{"converged":true,"iterations":0,"maxDelta":0,"convergenceTolerance":1e-6,
 "clusters":[],"perSheetIterations":{},"elapsedMs":0}
```
— byte-identical across base, slow-contractive (rate=0.99), and fully divergent
(rate=1.0, 2.0). The orchestrator sees no cross-sheet cluster, takes the acyclic
path (`iterations:0`), and the intra-sheet convergence loop inside the sheet module
never surfaces its result: `perSheetIterations` is a declared field built for
exactly this telemetry but comes back **empty**, and `converged` is structurally
pinned to `true`. So `meta.converged` is useless as a guard for single-sheet
circular models. (Cross-sheet clusters DO populate `meta.clusters[]` and the
top-level fields; only intra-sheet cycles are dark — `perSheetIterations` is where
the fix must write.)

## F5 — `run()` is pure / history-independent ✅ (rules out one Mippy hypothesis)

`determinism.mjs`: `run({rate:1.0})` returns 240,000,000 whether called cold,
after a base run, after a divergent run, or twice back-to-back; base case is
identical across repeated calls. So the engine carries NO cross-call state in this
case. **Implication for Mippy:** the T-076 NaN is therefore NOT a universal
cross-call-state bug in `run()`. It must come from (a) a denominator that an
iterated quantity drives toward 0 (coverage/ratio/`1/(1−x)` — this linear revolver
diverges by *growing*, never by dividing, so it never NaNs), and/or (b) the real
engine's specific warm-start seeding for large cross-sheet clusters. The next repro
(lock-grade lane) must add a cross-sheet coverage-ratio division and test
cold-vs-warm seeding.

## Fixes this wave should make (ROI order)

1. **Honest non-convergence contract (F2/F3/F4).** When a cycle (intra- OR
   cross-sheet) fails to converge, `meta.converged` must be `false` AND the values
   must be detectably unusable (NaN-fill the cluster, or a per-cluster flag the
   consumer must check). Surface intra-sheet convergence into `meta` (iterations,
   converged, maxDelta) the way cross-sheet clusters already are. Fix in the Rust
   emitter (`chunked_emitter.rs`). Gate hard with smoke + test:engine +
   test:runnable + test:lazy-engine (Mippy `run()` depends on these).
2. **Fix the staleness misclassification (F3).** Constant nonzero per-iter delta is
   divergence, not staleness — detect monotone/constant-delta growth and mark
   non-converged instead of breaking as "stable."
3. **Document the contract** in INTEGRATION.md so a consumer (Mippy, a coding
   agent) knows to check `meta.converged` and that a `false` means "do not trust."

These three turn a silent-wrong-answer failure mode into a loud, checkable one —
which is exactly the guarantee the engine's "zero hallucinated figures" promise
needs at the circular edge.

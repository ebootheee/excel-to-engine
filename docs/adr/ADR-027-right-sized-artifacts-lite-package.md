# ADR-027 — Right-sized artifacts + the "lite" package (guided, tiered extraction)

- **Status:** Accepted (design; Phase 1 implementation in this change)
- **Date:** 2026-06-05
- **Branch:** `feat/lite-package` (off `main` after ADR-026 Wave 2 / PR #41 merged)
- **Relates:** ADR-026 (scoped cone = Tier 2 here); the analyst-onboarding initiative (this is the
  self-serve front door); the Mippy contract (Tier 1/2 are its targeted-query needs).
- **Pressure-tested by:** the `pressure-test-lite-package` workflow (3 probes — surrogate-fit math,
  skill UX, no-parser sampling — + synthesis). Decisions below reflect the user's answers.

## Context

`excel-to-engine` today optimizes for ONE thing: **1e-6 reproduction of the whole model** (the
chunked engine + the lock-grade cone). That's the wrong objective for the common downstream apps
(Mippy, the GPP Carry tools): they don't need every one of ~5.8M cells — they need a handful of
levers → a handful of outputs (carry, IRR/MOIC, MIP, a P&L line) at the precision their use case
actually requires. We want a **right-sized** path: the smallest artifact that answers *this* question
at *good-enough* fidelity, fronted by a skill that guides a non-technical analyst to it — and that
**ships as a Claude Code package**.

### The load-bearing finding (from the pressure-test)

**SheetJS (the repo's sole runtime dep) reads cached values + formula strings but CANNOT recompute.**
So "sample the model at perturbed inputs with no Rust" is *false in general*. This reshapes the design:
sampling needs an evaluator, and the honest sources are (a) the chunked engine (exact, needs Rust),
(b) the delta-cascade (`cli/solvers/delta-cascade.mjs`, no Rust, but an approximation), or (c)
analyst-re-saved `.xlsx` variants whose cached values Excel computed (exact, no Rust, but manual).

### What already exists (≈70% of the ladder is built)

`lib/waterfall.mjs` (American/European/flat-MOIC hurdle, catch-up), `lib/irr.mjs` (Newton-Raphson +
bisection + XIRR), `lib/sensitivity.mjs` (`extractSurface`, slope/elasticity, **breakpoint
detection**), `lib/calibration.mjs` (ratio/offset), `lib/manifest.mjs` + named-inputs/outputs
(discovery + ranges), `lib/cone-emit.mjs` + `lib/scope-plan.mjs` (Tier 2), `lib/excel-parser.mjs`
(SheetJS read), `lib/integration-doc.mjs` (handoff bundle), `skill/SKILL.md` (PE-language → CLI).

## Decision

A **guided, tiered extraction** shipped as a curated package. Two parts:

### 1. The front door — a guiding skill (3 questions → recommend → generate → verify → hand off)

| Question | Pins down |
|---|---|
| What are you working on? | model file + domain → structure templates, lever locations |
| What's your target output? | carry / IRR / MOIC / MIP / P&L line → **the scope** |
| What's your use case? | one-off · what-if grid (app) · embedded surrogate · dashboard → **tier + precision budget** |

Plus a hidden 4th the skill answers itself by inspection: *can we re-evaluate this model without the
Rust engine?* (named ranges present? cyclic? size?). **Two personas, one skill** (per the answer):
"one-off / dashboard" analyst → default **Tier 0/1**; "embed in an app (Mippy)" integrator → default
**Tier 2** cone.

### 2. The artifact ladder (recommend the smallest tier that meets the precision budget)

| Tier | Artifact | Fidelity | Footprint | Needs Rust? |
|---|---|---|---|---|
| **0 Closed-form** | `lib/waterfall`+`lib/irr` bound to a few extracted cells | exact *for that structure* | KB / instant | **No** |
| **1 Surrogate** | sample → fit `out = base·∏(1+βᵢΔᵢ)` (poly fallback) → coeffs + r² | reported r² (~0.9–0.99) | KB / multiplies | **No** (cascade/variant samples) |
| **2 Scoped cone** | ADR-026 `cone-emit` | 1e-6 over driver ranges | few MB | Yes (+ build cost) |
| **3 Full engine** | existing chunked engine | 1e-6 everywhere | 100s MB | Yes |

### 3. The "0.9 r-value" driver extraction

For each target output, sweep candidate inputs (reuse `lib/sensitivity.mjs` as the sampling spine) and
rank by variance-explained (r²); keep the smallest driver set explaining ≥ the threshold (default
0.9). That set IS the scope. New code = a thin rank-by-r² selector over the existing sweep.

### 4. Sampling source (the reshaping decision — **cascade default + workbook-variant upgrade**)

Tier 1 trains its surrogate from the **delta-cascade** by default (instant, no-Rust) **with a loud
disclosure + an r² floor + spot-checks vs the engine where available** (the surrogate's r² measures
fit to the cascade, not the real model — disclose that). Offer the **analyst-re-saved `.xlsx` DOE
variants** path as the exact, no-Rust upgrade (Excel did the recalc; we read cached values via
SheetJS). Reserve engine-sampling for when Rust is already in play. **Do NOT** add a JS recalc dep
(hyperformula) — it reintroduces the formula-coverage problem the Rust transpiler exists to solve.

### 5. Safety gates (non-negotiable — surrogates are unsafe exactly where PE money is decided)

- **Kink gate:** auto-escalate ANY output with a detected breakpoint in the swept range (reuse
  `lib/sensitivity.mjs` breakpoint detection) to Tier 2 — multiplicative surrogates mis-price carry
  near a hurdle / MIP near a threshold. r² floors are **output-class** (0.99 monetary/carry, 0.97
  IRR/MOIC), not a single global number.
- **Provenance:** every artifact (Tier 0/1/2) is stamped with the model's `modelHash` (reuse the
  scope-plan discipline) + an r²/maxResidual provenance block, and the loader **refuses on mismatch**
  — a stale surrogate must not silently misprice for the non-technical user least able to catch it.

### 6. Packaging — **curated `ete lite` entrypoint + a published skill** (not a separate npm package yet)

Reuse the existing libs + test suite; carve out a standalone npm package only once the tier-selection
+ r² gate are proven. Avoids premature dependency/version/test duplication.

## Phased build plan (small increments)

1. **Tier 0 (no new deps):** closed-form emitter — read N cells via `lib/excel-parser.mjs`, bind to
   `lib/waterfall`+`lib/irr`, emit a params JSON + a `run()` shim, calibrate vs base case. Test on a
   fixture's carry/IRR. **Shippable, exact, Rust-free — the proof the package can exist.** ← this PR.
2. **Driver analysis core:** `lib/driver-scope.mjs` — sweep candidate inputs through a pluggable
   evaluator `(inputs)=>outputs`, reuse `sensitivity` extractSurface + breakpoints, rank by r²,
   return the smallest set ≥0.9. Pure, unit-tested on synthetic monotone + kinked outputs.
3. **Evaluator adapters:** delta-cascade + chunked `engine.run()` behind the increment-2 interface;
   workbook-variant adapter as its own increment.
4. **Tier 1 surrogate emitter + honesty gate:** multiplicative-first / poly-fallback; emit coeffs +
   r² + maxResidual; hard-gate on output-class r² floor + auto-escalate on detected breakpoints.
5. **Tier recommender:** target outputs + use-case + model traits → Tier 0/1/2/3 (cone path already
   exists via `init --emit-cones`). Pure decision table, snapshot-tested.
6. **Artifact provenance:** modelHash + provenance for every tier; refuse-on-mismatch loader; extend
   `lib/integration-doc.mjs` to document the chosen artifact.
7. **Front-door skill:** the guiding SKILL.md (3 questions + the hidden evaluator question, two
   personas, the tier ladder copy), wired to the increments; smallest end-to-end demo on a fixture.

## Consequences / risks

- **Sampling is not free** (SheetJS can't recompute): Tier 0 is no-Rust; Tier 1 is no-Rust only via
  cascade (approx, disclosed) or workbook variants. The skill copy must say so.
- **Double-approximation:** a cascade-sampled surrogate's r² is fit-to-cascade, not fit-to-model —
  spot-check cascade vs engine and report THAT error alongside r².
- **Tier 2 (cone) is gated on the transpiler `* `COL`` NaN bug** (ADR-026 Wave-2 gate finding) before
  it's correct on real models — until then the integrator persona's default falls back to the full
  engine or a disclosed surrogate.
- **Branch drift:** build off `main` in small, pushed increments (the cone foundation is recent).

## Alternatives considered

- **Separate npm package now** — rejected (premature; duplicates deps/tests before the gate is proven).
- **hyperformula in-process recalc** — rejected (reintroduces formula-coverage risk).
- **Surrogate everywhere** — rejected (unsafe at waterfall/MIP kinks; the breakpoint gate is mandatory).

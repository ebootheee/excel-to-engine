# Analyst-UX benchmarks — quantitative quality over time

This is the **living scoreboard** for the analyst-usability initiative. Every
iteration MUST append a row so we can prove we're moving forward, not sideways.
Numbers come from the persona-journey simulation (see "How to measure" below).

## The benchmark gate

A persona **passes** when, in one end-to-end run:
`A4,A5,A6,A7 ≥ 4` (analyst journey) **AND** `C4 = 5` **AND** `C5 ≥ 4` (coding-agent
handoff). See `tests/personas/lib/rubric.md` for the 0–5 dimension definitions.
The headline scalars we track each round:

- **pass/12** — personas clearing the full gate.
- **A7 "woah it worked"** — analyst's overall confidence (avg across 12).
- **C5 "exactly what I need"** — coding agent's verdict (avg across 12).
- **A5 "trust/accuracy"** — the historically-binding dimension (avg across 12).

## History

| Date | After | pass/12 | avg A7 (woah) | avg C5 (exact) | avg A5 (trust) | Notes |
|------|-------|:------:|:-----:|:-----:|:-----:|-------|
| 2026-05-29 | Wave 1 (accuracy + handoff bundle) | **2/12** | 3.50 | 3.33 | ~3.1 | baseline; tool was PE-buyout-centric |
| 2026-05-29 | Wave 2 (model-family summary + contract) | **3/12** | 3.92 | 3.83 | ~3.1 | handoff C-scores jump to mostly 5s |
| 2026-05-29 | Wave 3 (family coverage + cascade guard) | **3/12** | 4.00 | 3.75 | 3.50 | A5 climbs; most fails now single-dimension |
| 2026-05-29 | Wave 4 (TV label, Net note, doctor reconcile) | capstone only* | — | — | — | **capstone PASSED 5/5 both sides** |

\* Wave 4 targeted the exact residual A5=3 causes but was only validated via the
single-persona capstone (`pe-buyout-associate`, 5/5). **First action for the next
agent: re-run the full 12-persona journey to quantify the Wave-4 lift and append
a real row.** Expectation: the "only A5=3" personas (searchfund, corp, saas,
credit) should flip to pass.

> Scoring is stochastic (LLM judges), so a ±1 swing on a single dimension is
> noise. Track the **aggregate** (avg A5/A7/C5) and the **set of binding
> dimensions**, not just pass/12. A round that doesn't move pass/12 but lifts an
> aggregate or removes a recurring blocker is still progress — record why.

## Per-round binding constraints (what to fix next)

- **Wave 3 → 4:** every non-passing persona failed on `A5=3` and/or a C-side gap.
  Recurring A5 causes (now fixed in Wave 4, pending re-measure): `terminalValue`
  mislabeled as equity value; Net-return "—" read as broken; doctor "All checks
  passed" contradicting the summary.
- **Still C-side bound (need engine/feature work, see HANDOFF backlog):**
  `vc-fund-partner`, `infra-fund-director`, `familyoffice-fof-ir` cap on C4/C5
  because headline IRR/MOIC are **static literal cells** (multi-sheet IRR can't be
  one transpiled formula) and there are no per-year time-series outputs.
  `corp-fpa-manager` needs non-defined-name driver levers.

## How to measure (the simulation loop)

The loop is run with the **Workflow tool** (multi-agent orchestration). Two
phases, both over the 12 personas in `tests/personas/personas.json`:

1. **Generate models** (once per matrix change): each subagent builds a synthetic
   `.xlsx` for its persona via `tests/personas/lib/model-builder.mjs`, self-verifies
   through `ete init` + `lib/verify-engine.mjs` (drift must be 0), and writes its
   generator to `tests/personas/generators/<slug>.mjs`. The 12 generators are
   committed; regenerate a model with:
   `node tests/personas/generators/<slug>.mjs engines/_personas/<slug>/model.xlsx`
2. **Journey + handoff** (every iteration): for each persona, one subagent
   role-plays the analyst's AI assistant doing the real onboarding using ONLY the
   repo docs (README / GETTING_STARTED / SKILL / --help), and a separate fresh
   "coding agent" gets ONLY the output bundle and must actually build + run an
   integration. Both score on `rubric.md`; the workflow computes the gate.

**Reproduce a single persona by hand** (no workflow needed for spot-checks):
```bash
node tests/personas/generators/pe-buyout-associate.mjs engines/_personas/pe-buyout-associate/model.xlsx
node cli/index.mjs init    engines/_personas/pe-buyout-associate/model.xlsx --output engines/_personas/pe-buyout-associate
node cli/index.mjs summary engines/_personas/pe-buyout-associate/chunked
node cli/index.mjs verify  engines/_personas/pe-buyout-associate/chunked
```

**Regression gate (CI):** `npm test` includes `tests/cli/test-onboarding.mjs`
(13 assertions) which locks in the accuracy fixes + handoff bundle + engine
base-case fidelity on a synthetic model. Keep it green.

> `engines/` is gitignored (synthetic + real proprietary models). Generators,
> rubric, personas.json, and this file are committed so the matrix + scoreboard
> are reproducible.

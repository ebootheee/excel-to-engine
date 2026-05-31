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
| 2026-05-30 | Phase 0 re-baseline (full 12, hardened harness†) | **1/12** | 3.00 | 4.00 | **4.42** | re-baseline shock, not a backslide — see below |
| 2026-05-30 | Wave 5 — Phase-0 five-fix‡ | **7/12** | 3.75 | 4.67 | **4.58** | +6 personas; A6/A7 handoff debt cleared; C4=true ×12 |
| 2026-05-31 | Wave 6 — per-family headline blocks§ | **8/12** | 3.83 | **4.92** | **5.00** | credit+saas flip; **A5 perfect ×12**; A5/C5/A7 all up; corp/infra A4/A7 lift |
| 2026-05-31 | Wave 7 — schedule semantics + dial/format + model-type labeling¶ | **12/12** ✅ | **4.08** | 4.50 | 4.92 | **first clean sweep**; all 4 remaining fails flip; A7 +0.25; 11/12 `accuracyVerified` (FoF latent NAV-cell bug, see ¶) |

\* Wave 4 targeted the exact residual A5=3 causes but was only validated via the
single-persona capstone (`pe-buyout-associate`, 5/5).

† **Phase 0 (2026-05-30) re-ran the full 12-persona journey with a hardened harness**
(separate grounded trust-auditor for A5 that checks every headline number against
`_ground-truth.json`; empirical coding-agent that actually writes+runs an integration;
gate computed deterministically in code, not by an LLM). Result: **A5 trust ROSE to
4.42** (W3 3.50 → 4.42 — Wave 4's labeling/doctor fixes worked) and C5 held at 4.00,
but **pass/12 fell to 1/12** because the gate is `AND`-ed and the harder full panel
exposed **shared handoff debt** in A6/A7. This is a measurement of the real surface,
not a regression of prior work. The expected flips (searchfund/corp/saas/credit) did
NOT happen — same systemic defects, not persona-specific.

**Binding-dimension frequency across the 11 fails:** `A6` 11 · `A7` 9 · `A4` 4 ·
`A5` 3 · `C4` 1 · `C5` 1. Only `growth-equity-vp` cleared the gate.

‡ **Wave 5 (2026-05-30) — the five Phase-0 fixes, measured.** After shipping all
five fixes (schedule scalar `cell`; live `=IRR()`; `chunked/` auto-resolve;
asset-class detection; lever dedup) the same hardened journey re-ran: **1/12 → 7/12**,
avg A5 4.42→**4.58**, A7 3.00→**3.75**, C5 4.00→**4.67**, and **C4=true for all 12**
(every coding-agent integration ran, tied to base case, and a lever moved). Newly
passing (+6): pe-buyout-associate, vc-fund-partner, re-valueadd-analyst,
ma-sellside-analyst, searchfund-searcher, familyoffice-fof-ir (growth-equity-vp held).

§ **Wave 6 (2026-05-31) — per-family HEADLINE blocks + detection, measured.** After the
five Wave-6 commits (corp `corporate` family + EV/Equity headline; credit Lender-Returns
block + the "$2 debt-at-exit" ratio-cell fix; saas "x ARR" + split Revenue/ARR CAGR; infra
returns-led headline; + adversarial-review fixes) the same hardened journey re-ran:
**7/12 → 8/12**, **avg A5 4.58 → 5.00 (perfect — every persona converts AND verifies; all
12 `accuracyVerified=true`)**, A7 3.75 → **3.83**, C5 4.67 → **4.92**, **C4=true ×12**.
- **Flipped to PASS (+2):** `credit-directlending-analyst` (A5 3→5 — Lender headline + real
  $56M balance) and `saas-growth-operator` (A4 3→4 — "8.0x ARR" + ARR/Revenue CAGR split).
- **Lifted but still binding:** `corp-fpa-manager` (A7 3→4; A4 still 3) and
  `infra-fund-director` (A4 3→4; A6/A7 still 3).
- **Regressed on noise:** `pe-buyout-associate` A4 4→3 on **byte-identical output** (judge
  variance on the pre-existing `pe_fund` tag / "Segments"-over-P&L / "Platform EBITDA"
  jargon) — net 7→8.

**Still failing (4) — two clusters:**
- **A4 (labeling): `pe-buyout-associate`, `corp-fpa-manager`.** Model-type/lens mislabel:
  LBO tagged `pe_fund`; "Segments" header over P&L lines (Revenue/COGS/EBITDA/Net Income);
  "Platform EBITDA" jargon; corp headline says **"Exit: 2029"** (wrong vocabulary — it's a
  forecast horizon) and leads with a DCF block instead of a P&L/budget view.
- **A6/A7 (contract behaves wrong): `infra-fund-director`, `realestate-debt-cfo`.** Two
  distinct contract defects:
  - infra: `equityBasis` is a **backsolved/derived** cell wired as a what-if dial → the demo
    example.mjs raises ExitYield and reports grossMOIC **6.73x→41.68x** (backwards); and the
    exit-yield output is force-fit into the `exitMultiple` slot with `format:"multiple"` →
    renders **"0.09x"**. Base case correct; the *what-if* and *output format* read as broken.
  - re-debt: `freeCashFlow` baseCaseValue shows **$1** because the contract SUM-aggregates a
    per-year **ratio** (debt yield 9.5%…13.25%) — you can't sum a ratio (a fabricated-looking
    headline); and the amortization series ("Facility Balance — Closing", $152M) is absent
    from named-outputs / `extract --type debt_balance` dead-ends.

**Next-wave ROI (Wave 7, from the run synthesis — all three needed for 12/12):**
1. **Schedule-output aggregation semantics** — never SUM a `fraction|percent` series (use
   terminal/avg); emit the per-year debt-balance/DSCR series into named-outputs and make
   `extract --type debt_balance` find "Balance Roll-Forward" sheets. **Flips re-debt**
   (removes the fabricated $1 FCF — the closest thing to an accuracy bug).
2. **Suppress derived/backsolved cells as dials + format outputs by detected unit** — mark
   backsolved cells (`equityBasis`) read-only so the what-if explorer never wires them; key
   output `format` off the concept (cap rate / exit yield → `%`, never `multiple`). **Flips
   infra**; also lifts re-valueadd/credit (same `exitMultiple`-as-"0.0Nx" stumble).
3. **Model-type-aware labeling** — `pe_buyout` vs `pe_fund`; corp 3-statement → budget lens
   ("Forecast" not "Exit", P&L-led, revenue/opex/margin levers); LBO → drop "Platform"/"fund"
   jargon; "Segments"→"P&L Summary" when rows are P&L lines. **Flips corp + pe-buyout** (A4).
Plus the scoped **family-lever** additions (infra OpexEscalation/AnnualAmortization, saas
GrossChurn, re-debt EntryLTV) for richer A6 dials once the contract semantics above are fixed.

**Still failing (5)** — bindings below are the deterministic per-code gate
(A4/A5/A6/A7≥4 ∧ C4 ∧ C5≥4), recomputed from each persona's scores and matched
1:1 to the workflow's `binding`:
- `credit-directlending-analyst` [**A5**] (scores A4 4·A5 3·A6 4·A7 4·C5 4) — lone
  accuracy fail; classifies as `credit` but the summary HEADLINE is still equity-shaped
  (exit "multiple"/MOIC, not yield-to-lender / debt yield / exit leverage). Needs a
  credit-lens *headline block*, not just the label.
- `infra-fund-director` [**A4,A6,A7**] (A4 3·A5 5·A6 3·A7 3) — DSCR/CFADS not surfaced
  as the headline; only ExitYield is a lever (escalator/gearing aren't).
- `saas-growth-operator` [**A4,A6,A7**] (A4 3·A5 5·A6 3·A7 3) — "8.0x Revenue" should be
  "8.0x ARR" + the Revenue/ARR line conflates one CAGR for two metrics; NRR/churn/
  bookings aren't levers.
- `realestate-debt-cfo` [**A6,A7**] (A4 4·A5 5·A6 3·A7 3) — debt-yield headline is
  correct now (A5=5); only the cap-rate lever moves (rate/amort/LTV aren't levers).
- `corp-fpa-manager` [**A4,A7**] (A4 3·A5 5·A6 4·A7 3) — model type still `unknown` → no
  family lens, reads generic; needs a 3-statement/corporate-budget lens + driver levers
  (rev growth %, opex %, WACC).

**Binding frequency across the 5 fails:** `A7` 4 · `A4` 3 · `A6` 3 · `A5` 1.

**Accuracy flags (from the run's LLM synthesis — VERIFY before acting, narrative not
deterministic):** all 12 came back `accuracyVerified=true` except growth/fof/credit.
Two to check: (1) **familyoffice-fof-ir (PASSES the gate) may report NAV from the wrong
cell** — synthesis claims `Cash Flows!K7` ("Net CF to LP incl. residual NAV", ~$184.8M)
instead of `IR Cheat Sheet!B12` (~$161M), a ~15% overstatement under an LP-facing NAV
heading. If real, it's the most serious live defect (a wrong number in a *passing*
persona). (2) credit's `Debt at exit` cell mapping (the recon's "$2"/leverage-vs-balance
issue). growth's flag was only "couldn't re-dump _ground-truth mid-run", not a wrong
value (it ties out via verify 4/4). These are synthesis *claims* — confirm against
ground truth on a clean tick before treating as bugs.

**Next-wave ROI order (from the run's synthesis):** (1) per-family HEADLINE blocks
(credit YTM/debt-yield/leverage, infra project-IRR+DSCR, corp EV/equity-value) — flips
credit, lifts infra/corp A4; (2) expose more levers per family (infra escalator/gearing,
saas NRR/churn, re-debt rate/amort/LTV) — up to 3 more passes; (3) saas "x ARR" + split
CAGR; (4) corp three_statement detection + a clean model name (drop the absolute path —
recurs in nearly every persona's A2/A7 notes, a cheap cross-cutting win).

> **Data provenance (2026-05-30):** numbers are from the workflow result's `board`
> object; the full `scored[]` array was independently re-extracted from the saved task
> output and is clean (12 entries, 12 distinct), and a code-recomputed gate
> (A4/A5/A6/A7≥4 ∧ C4 ∧ C5≥4) matched the workflow's per-persona `binding` for all 12 —
> so the row above is internally consistent, not estimated. (An earlier note here
> claimed a mangled `scored[]`; that was a misread of the *truncated* completion
> notification, not the saved output — corrected.) Scoring is LLM-judged so treat single
> dimensions as ±1 noise and avg decimals as ±~0.1; the **1/12→7/12** jump is far beyond
> that floor.

> Scoring is stochastic (LLM judges), so a ±1 swing on a single dimension is
> noise. Track the **aggregate** (avg A5/A7/C5) and the **set of binding
> dimensions**, not just pass/12. A round that doesn't move pass/12 but lifts an
> aggregate or removes a recurring blocker is still progress — record why.

## Per-round binding constraints (what to fix next)

- **Phase 0 (2026-05-30) — A6/A7 are now the gate, driven by three shared defects
  (ROI order; full detail in `FINDINGS.md` + the run synthesis):**
  1. **Schedule-output `cell: undefined` (the #1 A7 binder).** Schedule outputs
     (`outstandingDebt`, `freeCashFlow`, `equityBase`, `distributionsToEquity`,
     per-class `distributions`) carry `cellRange`+`perYear` but **no scalar `.cell`**.
     `example.mjs` and INTEGRATION.md read `values[o.cell]` = `values[undefined]` →
     prints the false **"N output(s) drifted — contract may be stale"** — the exact
     trust signal the docs tell users to require. False-fails on every model with a
     schedule output. Pure metadata + codegen/doc fix, no engine math. **Fix first.**
  2. **Static-literal headline returns (the #1 A6 binder).** `grossIRR/netIRR/tvpi/
     dpi/MOIC` are hardcoded literal cells, so no lever moves them (`— static`) —
     the "what-if explorer" has no working dial on the numbers that matter. Crushes
     FoF/VC/infra. (Backlog: multi-sheet IRR de-literalization.)
  3. **Inert / duplicate levers.** The headline driver (`ExitCapRate`, `ExitYield`,
     `ExitMultiple`) ships with `affectsOutputs: []` while a twin on the same cell
     holds the real closure → the named slider looks dead. Hits re-valueadd (the
     cap-rate slider IS the project), searchfund, RE-debt.
  - **Secondary:** model-type misclassification (credit/search/RE-debt/FoF → `saas`/
    `unknown`) leaks SaaS/equity labels onto non-equity headlines — the root of the
    5 `accuracyVerified=false` personas (the most serious class: right number, wrong
    label, e.g. RE-debt "13.2% cap rate" is a debt yield). Degrades A4 + A5.
  - **CLI papercut:** `summary <dir>` (and other dir-commands) require `<dir>/chunked/`
    and error otherwise, while `verify` auto-resolves it and GETTING_STARTED's examples
    point at the parent — the first documented command dead-ends a non-coder.

- **Carried from Wave 3→4 (still relevant):** `vc-fund-partner`, `infra-fund-director`,
  `familyoffice-fof-ir` cap because headline IRR/MOIC are static literals (overlaps #2);
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

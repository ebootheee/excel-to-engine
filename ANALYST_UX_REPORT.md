# Analyst-usability initiative — overnight report

**Branch:** `feat/analyst-onboarding` (worktree `.claude/worktrees/analyst-ux`, based off `user-qol` HEAD)
**Goal (verbatim):** make the engine usable by an average financial analyst with
no technical expertise, end-to-end to this benchmark —
*"I'm a PE analyst, I want to turn this model into an explorable web app for my
LPs… walk me through it"* → *"woah, it worked — I'll hand this to my coding
agent"* → coding agent: *"this is easy to understand and exactly what I need."*

## Method

1. **Read the product cold** and found it was powerful but **PE-buyout-centric**
   and written for AI agents / a downstream RPC consumer — the README opened with
   `cargo build`, the summary fabricated PE numbers for non-PE models, and the
   developer handoff had no glue.
2. **Built a persona matrix** (`tests/personas/personas.json`) — 12 personas
   across asset class × skill level × seniority × goal (PE buyout, growth equity,
   VC fund, real estate, infra, private credit, corporate FP&A, M&A sell-side,
   SaaS, search fund, family-office FoF, RE-debt CFO).
3. **De-risked the harness**: a `ModelBuilder` (`tests/personas/lib/`) that emits
   realistic synthetic `.xlsx` (real formulas + cached values + defined names),
   plus `lib/verify-engine.mjs` proving `engine.run()` reproduces the spreadsheet.
4. **Ran a simulation loop with subagent workflows**:
   - *Workflow A* — 12 subagents blindly generate a synthetic model for their
     persona and self-verify it through `ete init` (all 12 came out drift-free).
   - *Workflow B* — for each persona, one subagent role-plays the analyst's AI
     assistant doing the real onboarding via the docs, and a separate fresh
     "coding agent" gets ONLY the output bundle and must actually build + run an
     integration. Both score on `tests/personas/lib/rubric.md`; the script
     computes the benchmark gate.
   - Iterated: read findings → fix → re-run. Three full rounds, four fix waves.

## Measured results (Workflow B, same rubric each round)

| Round | Personas passing gate | avg "woah" (A7) | avg "exactly what I need" (C5) | avg trust (A5) |
|------:|:---------------------:|:---------------:|:------------------------------:|:--------------:|
| Wave 1 baseline | **2 / 12** | 3.50 | 3.33 | ~3.1 |
| Wave 2 | **3 / 12** | 3.92 | 3.83 | ~3.1 |
| Wave 3 | **3 / 12** | 4.00 | 3.75 | 3.50 |

Handoff quality rose fastest (coding-agent C-scores are now mostly 5s; several
personas score a perfect 5,5,5,5,5). The benchmark gate is strict (six AND-ed
conditions) with stochastic agent scoring, so the headline pass count understates
the lift — by Wave 3 most non-passing personas fail on a *single* dimension
(usually A5=3 on one specific, now-fixed cause). Wave 4 targets exactly those.

> Capstone result (the exact named scenario): **PASSED** — see end of this file.

## What changed (by wave; every change test-gated, suite stayed green)

**Accuracy / trust at first glance**
- Periodicity no longer mislabels a 5–7yr model "monthly".
- Exit multiple picks the *Exit* cell (not *Entry*); EBITDA detection skips
  "… Multiple/margin" labels.
- Carry total picks the dollar cell, not the 0.20 carry-rate fraction.
- "Platform EBITDA" no longer fabricated/double-counted on non-PE models.
- **Model-family-aware summary**: a lens (fund / credit / realestate / saas /
  equity) renders the right headline — Fund (LP) metrics (TVPI/DPI/RVPI/Net IRR),
  Covenants (DSCR/LTV/ICR), cap-rate + Exit Value, or ARR — with the correct
  exit-multiple basis ("@ 12.0x EBITDA" / "Revenue" / "5.25% cap rate"). Exit
  value labeled by its real cell ("Exit Equity Value", not a generic "Terminal
  Value"). Net dashes get a plain-English explainer.
- **Family-aware coverage report**: the init "Coverage: 2/8 / Missing: Gross IRR,
  MOIC, Carry…" PE yardstick (the #1 trust-killer for non-PE users) now reads
  "Coverage 5/5 (equity deal)" / "1/1 (operating / budget)" with inapplicable
  fields shown as "Not applicable — no action needed".
- Doctor validates cap-rate/exit-yield by type (no false quarantine on RE/infra);
  doctor reconciles "All checks passed" with the summary's dashes.
- **Delta-cascade honesty guard**: scenario/sensitivity warn loudly when the fast
  preview can't reproduce the base case ("preview 15.60 vs model 2.57 — use the
  engine"), instead of silently shipping a wrong sensitivity table.

**The coding-agent handoff**
- `ete init` emits a model-tailored `chunked/INTEGRATION.md` + a runnable
  `chunked/example.mjs` (base case + a real what-if, with a drift check).
- New `ete verify` — visible "engine reproduces your spreadsheet ✓" trust signal.
- Contract (`named-outputs/inputs.json`) now carries fund-level + covenant
  outputs, per-input UI metadata (format + suggested min/max/step), and
  dependency closures that **survive re-emits**. `ete manifest set` self-refreshes
  the whole bundle (fixing the "the fix never reaches the developer" catch-22).
- Any `manifest.outputs.*` mapping now reaches the contract (was a PE whitelist).

**Onboarding (human + agent)**
- README reframed around the analyst + AI-assistant journey; Rust moved to a
  one-time `npm run build:parser`. New `GETTING_STARTED.md`. Guided onboarding
  play in `skill/SKILL.md`. Cross-platform `check-env` (was Windows-broken).

## Known remaining limitations (documented, not yet fixed)

- **Static literal IRR/MOIC** in some synthetic models (the model-gen agents
  authored IRR as a constant because a multi-sheet IRR can't be one transpiled
  cell formula) — the contract honestly flags these `static`, but a fund/infra
  "IRR explorer" wants a live figure. Real fix is multi-sheet IRR support.
- **Engine intra-sheet evaluation is row-major** (no intra-sheet topological
  sort), so a cross-row "staircase" (opening = prior row's closing) reads 0.
  The standard column=time / row=metric layout is safe; documented in SKILL.
  Real fix is a topo-sort in the Rust emitter (gate with smoke + engine suites;
  Mippy depends on `run()`).
- **Per-year time-series outputs** (debt amortization / covenant series) and
  **non-defined-name driver levers** (corporate budget) are new features the
  credit/debt/FP&A personas want.
- **Model-type classification** still mislabels some families (credit/FoF/search
  → "saas"); the summary lens compensates for display, but the type label is
  cosmetic-wrong.

## How to reproduce

```bash
# from the worktree
npm test                                   # full suite incl. test-onboarding (green)
node tests/personas/generators/<slug>.mjs engines/_personas/<slug>/model.xlsx
node cli/index.mjs init engines/_personas/<slug>/model.xlsx --output engines/_personas/<slug>
node cli/index.mjs summary engines/_personas/<slug>/chunked
node cli/index.mjs verify  engines/_personas/<slug>/chunked
```

Simulation workflows were run via the Workflow tool (scripts persisted under the
session dir). `engines/` is gitignored (synthetic + the real proprietary models);
the generators (`tests/personas/generators/`) are committed so the matrix is
reproducible.

## Capstone — the exact acceptance scenario (PASSED)

A non-technical PE associate's AI assistant converted the LBO and a separate
coding agent (given only the output folder) built a real, dependency-free LP
what-if web app (`chunked/app/index.html` + `app.mjs` + a headless `smoke.mjs`
that ties out). Every rubric dimension scored **5/5** on both sides.

- **Analyst (A1–A7 all 5; would hand off):**
  *"Good news — it worked, and I checked the math myself: it pulled your LBO
  straight out of Excel and every headline ties out exactly (3.02x gross MOIC,
  24.8% gross IRR, $23.2M of carry on $74.6M of equity at an 11.0x exit), the
  engine reproduces your base case 8-for-8, and the chunked/ folder is ready to
  hand your developer to build the LP what-if explorer."*

- **Coding agent (C1–C5 all 5; built the app, smoke test passed, "exactly what I
  need" = true):**
  *"I dropped this folder in cold, ran example.mjs once, and had a live LP what-if
  explorer wired straight to the contract in minutes — base case ties out to the
  penny and every lever pushes the outputs the right way."*

Capstone nits fixed afterward: INTEGRATION.md now notes the Node `file://`
dynamic-import + browser "serve, don't double-click" caveats; README lists
`verify` and `explain` in its command table.

Residual nits left as backlog (low impact): model title flows from the filename
(use a meaningful `.xlsx` name), `explain` has no formula in default chunked mode
(use `--emit-debug`/`eval`), and per-lever hard guardrails are "suggested" only.

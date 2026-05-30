# HANDOFF — analyst-usability backlog (next session)

_Last updated: 2026-05-29. Companion to `ANALYST_UX_REPORT.md` (what shipped) and
`tests/personas/BENCHMARKS.md` (the living scoreboard). This file is the
**backlog + test process** for continuing the work. (Separate from the Mippy
`HANDOFF.md`.)_

## The job, in one line

Keep raising the persona-benchmark — make the toolkit trustworthy and turnkey for
**every** finance persona working through an AI assistant, not just PE buyout —
and **prove it quantitatively each iteration** in `tests/personas/BENCHMARKS.md`.

## Where it stands (merged to `main`, PR #35)

4 waves shipped, simulation-driven. Benchmark 2/12 → 3/12 + a **5/5 capstone**
(the exact "PE analyst → coding agent builds an LP web app" scenario). Avg trust
(A5) 3.1 → 3.5, avg "woah" 3.5 → 4.0, coding-agent handoff mostly perfect. The
summary is model-family-aware, the contract carries fund/covenant outputs + input
slider metadata + durable closures, `ete verify` + `INTEGRATION.md` + `example.mjs`
make the handoff turnkey, and scenario/sensitivity are honest when the fast
approximation can't reproduce the base case.

## ▶ Do this first

**Re-run the full 12-persona journey simulation to quantify the Wave-4 lift.**
Wave 4 (exit-value labeling, Net-dash explainer, doctor reconciliation) fixed the
exact `A5=3` causes that were blocking ~4 personas, but was only validated via the
single capstone. Re-measure all 12, append a row to `tests/personas/BENCHMARKS.md`,
and confirm the "only-A5" personas (searchfund, corp, saas, credit) flipped to
pass. (See "Test process" for how.)

## Backlog (prioritized; all documented in `tests/personas/FINDINGS.md`)

These are the remaining benchmark blockers, in rough ROI order. None are
trivial — they're the deep items the quick fixes deferred.

1. **Multi-sheet IRR / MOIC (static-literal returns).** `vc-fund-partner`,
   `infra-fund-director`, `familyoffice-fof-ir` cap on C4/C5 because their
   headline IRR/MOIC are hardcoded literal cells — a fund/infra "IRR explorer"
   whose IRR never moves under a lever is the worst failure mode. The transpiler
   can't express an IRR over a multi-sheet cash-flow vector as one cell formula.
   Options: (a) teach the engine to compute IRR/XIRR over a declared cash-flow
   range at run() time (helpers already exist in `sheets/_helpers.mjs`), or
   (b) emit the cash-flow series as a named output + document that the app calls
   `computeXIRR`. The contract already flags these `static` — make them live.

2. **Engine intra-sheet topological ordering.** Sheet modules compute roughly
   row-major with NO intra-sheet topo sort, so a cross-row "staircase" (opening =
   prior row's closing) silently reads 0. Only the standard column=time /
   row=metric layout is evaluation-safe. Fix in the Rust emitter
   (`pipelines/rust/src/chunked_emitter.rs`): topo-sort non-cyclic intra-sheet
   cells before emission (the cycle path already does dep analysis). **Gate hard
   with `npm run smoke` + `test:engine` + `test:runnable` + `test:lazy-engine` —
   Mippy depends on `run()`.** Until then, `lib/verify-engine.mjs` catches it as
   drift; `skill/SKILL.md` documents the safe layout.

3. **Per-year time-series outputs.** `credit-directlending-analyst` and
   `realestate-debt-cfo` (covenant monitors) want DSCR/LTV/debt-balance **by
   year** with thresholds, not just scalar exit values. Main already emits some
   `type:"schedule"` outputs (`outstandingDebt`, `equityBase` with `perYear[]`) —
   extend to covenants + carry per-facility thresholds (`manifest.covenants` has
   the values; add `threshold`/`direction`). `lib/verify-engine.mjs` currently
   **skips** schedule/range outputs — revisit if you want them verified (sum/
   terminal-aggregate the range from engine values).

4. **Non-defined-name driver levers.** `corp-fpa-manager`'s budget drivers
   (growth %, opex %) aren't Excel defined names, so they never become
   `named-inputs`. Either let `ete manifest set inputs.<name> <cell>` add a lever,
   or detect a "Drivers"/"Assumptions" sheet's numeric rows as candidate inputs.

5. **Model-type classification.** credit/FoF/search/growth still misclassify as
   `saas`/`unknown`. The summary **lens** compensates for display, but the type
   label is cosmetically wrong and could mis-route type-specific behavior. Improve
   `detectModelType` (lib/manifest.mjs) to recognize LBO / credit / FoF / search /
   corporate-budget signatures; consider model-family templates in `templates/`.

6. **Smaller nits** (from capstone + journeys): init step counter shows
   "Step 1/3 … 5/6" (inconsistent denominators — confidence dent); ship a minimal
   `package.json` (`{"type":"module"}`) in `chunked/` for turnkey bundler import;
   per-lever **hard** guardrails (current min/max are "suggested"); model title
   flows from the filename (use a meaningful `.xlsx` name or propagate the doc
   title).

## Test process (how we measure — keep it rigorous)

The benchmark is run with the **Workflow tool** (multi-agent). Full methodology +
single-persona repro + the living scoreboard are in `tests/personas/BENCHMARKS.md`.
In short, each iteration:

1. (If you changed `cli/`/`lib/`) **don't edit core code while a journey workflow
   is running** — live edits confound the agents' results.
2. Run the 12-persona **journey + handoff** workflow; each persona is scored on
   `tests/personas/lib/rubric.md`; the script computes the gate.
3. **Append a row to `BENCHMARKS.md`** with pass/12 + avg A5/A7/C5 + the binding
   dimensions. If pass/12 didn't move, say what aggregate moved and why — we want
   monotonic progress on *something* measurable every round.
4. Read the agents' `stumbles`/`blockingIssues`/`missing`/`suggestions` — they are
   the next round's work-list. Fix → re-run → re-measure.
5. Keep `npm test` green (`tests/cli/test-onboarding.mjs` is the CI regression
   gate for the accuracy fixes + handoff bundle + engine base-case fidelity).

**Synthetic-model rules** (so the harness tests docs/UX, not generator bugs):
standard column=time / row=metric layout; roll-forwards reference the PRIOR
COLUMN same row (never a later row — see backlog #2); every `.formula(addr, f,
cachedValue)` must pass a cached value computed with the SAME math (or `engine.run()`
won't match Excel); ≥2 defined names for driver inputs. `tests/personas/lib/
model-builder.mjs` enforces the SheetJS gotchas; `example-pe-buyout.mjs` is the
reference.

## Gotchas (will bite you)

- **`engines/` is gitignored** (synthetic + real proprietary models). Never commit
  values/labels. Regenerate synthetic models from `tests/personas/generators/`.
- **Rebuild the parser after touching `pipelines/rust/`** (`npm run build:parser`)
  before running parser-dependent suites — a stale binary tests old behavior.
- **CI runs ubuntu + windows.** Keep child-process / path / parser code
  cross-platform (the `check-env` + dynamic-import `file://` lessons).
- The full quality bar is `npm test` + `smoke` + `test:engine`/`test:runnable`/
  `test:lazy-engine`/`test:depgraph`/`test:slimming`/`test:golden` — all must stay
  green (they were at merge).

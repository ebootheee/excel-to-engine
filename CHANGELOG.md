# excel-to-engine — Changelog

## 2026-06-10 — #33 warm-convergence measured (2 passes, fixed point == GT); per-sheet-eval fits the box; #46 row-chunked modules

- **#33 warm-seed convergence measure (the post-v0.3.1 unblock, posted to #33):** the lean
  warm-GT probe against the v0.3.1 build (`a1-66c`, identity verified) — **converged=true in
  exactly 2 passes** (12.2 + 12.6 min/pass, 6GB working set), nonFinite=0 on every pass, fixed
  point vs GT **290,767/290,781 = 100.00%** (all 14 divergent cells previously documented:
  Debt fidelity-floor rows + 1 sub-1e-6 jitter + 2 cosmetic TEXT labels), **all 17 cluster-
  resident named outputs exact**. Pass-2 maxDelta = 5.96e-8 @ Debt!CQ2724 — the documented
  dust constant churns but sits 2 orders of magnitude below tolerance. The GT fixed point is
  stable under recompute; only the cold-start pass count remains (deferred overnight run).
- **PR #69 MERGED** (`9150af5`, FF) — per-sheet-eval cluster child slimmed to the ENGINE's
  exact loop (it OOMed 16GB/61min on A-1): GT parsed directly into ctx (was two full copies),
  the `_written` Set (~4.7M fresh strings) + per-cell `prevSnapshot` object replaced by the
  engine's sampled surface + `_before` baseline array — which is simultaneously a lockstep
  fix (the old surface diffed/NaN-filled non-member-sheet writes and skipped member-sheet
  input cells). **A cluster member is never size-skipped** (`MAX_SHEET_SIZE_MB` silently
  dropped the monster sheets from the cluster → partial-cluster wrong fixed point; regression
  red pre-fix with `clustersTotal=0`). New `EVAL_CLUSTER_TIMEOUT_MS` (default 60min).
- **per-sheet-eval dynamic-read scan knows the #66 helpers** — the v0.3.1 emitter lowers
  `ref:OFFSET(...)` through `_dynRange`/`_offsetAddr` with no bare `_offset(` call, so the
  GT-seed-scoping scan approved scoping on exactly the builds where ranges are runtime-
  addressed (observed live on the a1-66c canonical eval). Markers added (red pre-fix in the
  new MODEL C). Defense-in-depth today: `_dynRange` anchors are same-sheet-only because a
  sheet-qualified computed-endpoint range refuses to parse (honest NaN) — filed **#71**.
- **#46 row-chunked sheet modules** (`--max-module-mb=N`, default 64, 0 disables): any sheet
  module crossing the cap rotates into `<Sheet>.partNNN.mjs` modules behind a same-named
  facade — ONE logical `compute()`, identical write sequence, statement-boundary splits only,
  never inside a convergence loop; under-cap sheets stay byte-identical single files; stale
  parts from previous builds are swept. Fixes the import-time fatal alloc (V8 UTF-16-decodes
  ~2x the module bytes at import — A-2's ~305MB Debt = the 609,447,784-byte crash). The
  per-sheet-eval dynamic-read scan now follows facade part imports (red pre-fix: it approved
  GT-seed scoping for exactly the monster sheets most likely to use OFFSET). Regression
  `test-row-chunked-modules.mjs` (19 asserts: facade/parts/sizes, loop indivisibility, GT
  reproduction, split-vs-single identical values, cell-exprs parity, stale-part sweep,
  eval-scan companion).

## 2026-06-09 — v0.3.1: #66 CLOSED same day — 5.9M → 266 divergent cells (−99.995%), 14/17 sheets exact

**PR #67 MERGED** (`77b2959`, FF, 3 commits) — all #66 structure-fidelity classes fixed, each
negative-controlled in `test-structure-fidelity.mjs` (13/13; RED pre-fix with the predicted
wrong values) and validated by four A-1 rebuild+sweep cycles (~25 min each):

- **Computed-endpoint ranges** `ref:OFFSET(...)` (Technology 284,568 → **0**): the parser had
  no rule for a bare `:` — it stopped at the colon and silently returned the partial AST
  (dropping whole trailing factors). New `Expr::DynRange` + `_dynRange`/`_offsetAddr`.
  **`parse_formula` now refuses partial parses** (trailing tokens → None) and parse-error
  cells emit **NaN, not 0**, in both emitters. Also fixed: the EMPTY-argument bug
  (`OFFSET(x,,n)`'s comma was eaten, misaligning later args) and `A1:MAX(...)` folding the
  function name into a column-range endpoint.
- **YEARFRAC basis-0 = Excel's exact 30/360** (PP&E 84,468 → **0**, Lease Am 7,300 → **0**):
  was `(b−a)/365.25`. Took THREE iterations, each corrected by the model's own ground truth:
  textbook NASD → Excel orders the d2=31 rule BEFORE the Feb adjustment
  (`YEARFRAC(Feb28-2023, May31-2023)=91/360`, hand-verified to 1/360 on PP&E row 92) → the
  both-Feb rule DOES apply (Feb→Feb anniversary columns are exact integers). The middle
  iteration's test PASSED while wrong — it validated the hypothesis against itself; only
  real-model GT is the oracle. Bases 0–4 implemented.
- **Array-criteria SUMIFS** (Debt array formulas): `SUM(SUMIFS(vals, cats, $EK$973:$EK$977))`
  yields one sum per criteria element (Excel array semantics); previously matched nothing → 0.
- **The fidelity floor, documented (not fixable):** Debt's residual 250 cells gate `=0`
  against GT values like **−5.96e-8** — half-ULP dust from Excel's own computation; our
  recompute produces a clean 0 (value-identical at 1e-6) and the gate flips. Bit-exact
  reproduction of Excel's FP operation order is out of scope. Plus 16 cells of sub-1e-6
  jitter (Financial Statements 14, Existing Owned 2).

**Final sweep: 14/17 cluster sheets reproduce GT exactly from a warm seed; 17/17 within
float-noise-or-documented-floor; every named output's sheet at ZERO. #66 closed.**
Full-cluster convergence measurement (#33) is now unblocked.

## 2026-06-09 — v0.3.0 RELEASED: "Never a Silent Wrong Number" (first tagged release)

**Booked the correctness campaign as the first tagged release** (`v0.3.0`, notes at
`docs/releases/v0.3.0.md`). Same-day landings:

- **PR #62 MERGED to main** (`e5072bd`, FF) — the calamine $-anchor fix (entry below). Issue
  comments posted to #57 (trace + result) and #47; **#47 CLOSED** (date-axis mechanism verified
  exact 0/301; residual symptoms were the calamine root).
- **PR #63 MERGED** (`20aedcc`, FF) — `lib/irr.mjs` CLI-side XIRR now Excel's 365-day basis
  (was 365.25), closing the follow-up noted in the #62 entry. Negative-controlled leap-span
  regression in `tests/lib/test-lib.mjs` (RED pre-fix with exactly the 365.25-basis value).
- **`ete` help crash FIXED** — `printHelp()`'s template literal contained nested backticks
  (`` `* `COL`` ``) from the --emit-cones help text, which parsed as a tagged template and threw
  `TypeError: "COL" is not a function` on every bare/unknown invocation. Rewrote the stale text
  (the COL$ROW bug it referenced was fixed in #43; the cone's EXPERIMENTAL label now stems from
  the vacuous re-gate) + help smoke test in `test-cli.mjs` (36/36).
- **PR #64 MERGED** (`92ca242`, FF) — found by the release-day re-measure: **`YEAR`/`MONTH`/`DAY`
  lowerings used LOCAL-time `Date` getters**, so any engine runtime west of UTC read every Excel
  serial one day early (`DAY(Jun-30-2023)=29`; the `DATE(YEAR(x),MONTH(x),DAY(x))` idiom on
  `Valuation!G7` rebuilt 45107 as 45106) — date-keyed COUNTIFS/SUMIFS windows shifted a day and
  0/1 flags flipped across sheets; **the engine's answers depended on the machine timezone.**
  Now routed through `_serialToYMD` (UTC integer math, epoch-quirk aware). Regression runs the
  engine in TZ-pinned children (America/Denver + Pacific/Auckland) with a hazard probe as the
  negative control — RED pre-fix with the A-1-observed values, 26/26 GREEN post.
- **Convergence re-measured (the discipline that caught #64):** per-sheet warm-GT sweep of all
  17 cluster sheets — pre-fix baseline 1/17 clean / ~5.9M numeric divergences; post-#62
  9/17 exactly clean (entire returns chain → 0), ~391k residual (−93%) all carrying the one-day
  signature; post-#64 rebuild: **11/17 exactly clean, 13/17 within float noise, 383k residual (−93.5% from
  pre-#62)** — returns/promote/equity chain all at ZERO; residual = 4 sheets (Technology 285k,
  PP&E 84k, Lease Am 7.3k, Debt 6.7k) carrying a NEW defect class (formula-STRUCTURE mismatch:
  `Technology!CG14` computes 1 from exact-GT inputs where Excel computed 0 — transpiled AST ≠
  workbook formula; next campaign, see the residual-fidelity issue). The canonical per-sheet-eval
  cluster child OOMs a 16 GB heap after 61 min on a 31 GB box (#33 = memory-bound; duplicate GT
  copy + 4.7M-string `_written` set + per-cell snapshots identified as the avoidable overhead).
  See `docs/releases/v0.3.0.md` and the #33 thread.
- README refreshed (`ete lite`, templates, `--reuse-parse`, **Correctness & honesty** section,
  three-ways-to-compute, test counts); package.json `0.2.0 → 0.3.0` + repository URL fixed
  (pointed at a nonexistent org); release notes + boothe.io post drafted.

## 2026-06-09 — #57 structural root FOUND & FIXED: calamine $-blind shared-formula expansion corrupted 1.75M A-1 cells

**The trace.** A one-pass warm-GT recompute (`ctx` seeded with all 5.8M ground-truth values,
one `compute()` sweep, every `set()` diffed against GT — a faithful formula MUST reproduce GT
from a warm seed) showed 9,819 Equity divergences starting at rows 17–19 (the capital-call
schedule), with `got(Y17) == GT(N17)`: the row was **column-shifted**. The xlsx master formula
`AVERAGEIFS($AO17:$MC17, $AO$7:$MC$7, ">"&L$7, …)` (shared group, filled M17:AJ17) was expanded
by **calamine 0.26.1's `replace_cell_names()`, which is `$`-blind**: a `$` splits the ref token,
so `$AO17` (column-absolute) was offset as if relative (wrongly SHIFTED) and `L$7`/`AO$698`
(row-anchored, column-relative) never parsed as refs (wrongly FROZEN). Plain-relative and
fully-absolute refs both behave by accident — which is why 13/23 named outputs were fine and
exactly the mixed-anchor financial idioms (AVERAGEIFS/SUMIFS windows, ratio rows) collapsed.
Blast radius on A-1: **1,745,461 of 4.69M shared-formula member cells (30% of the model)**
received a corrupted formula. This — not date drift (#47's mechanism is already fixed and
verified: row-7 axis 0/301 divergent) and not fn stubs (#54: `_fn-fallbacks` is empty) — is what
zeroed `Equity!AN122` (class equityBasis) and `GPP Promote!D88` (totalCarry): their cash-flow
rows aggregate corrupted schedule rows to 0, then #60's honest NaN surfaced the 0/0.

**The fixes** (branch `fix/calamine-shared-formula-anchors`):
1. **calamine 0.26 → 0.35** (`pipelines/rust/Cargo.toml`) — upstream fixed $-anchor handling in
   shared-formula expansion (0.32) and `LOG10`-parsed-as-cell-ref (0.35). Zero API churn.
2. **`formula_ast.rs`: a name followed by `(` is a function call, never a cell ref** — our own
   tokenizer had the same LOG10 bug (parsed as column LOG, row 10 → `#NAME?`-style 0).
3. **`chunked_emitter.rs` helpers: Excel 1900-epoch quirk for serials ≤ 60** — `EOMONTH(0,1)`
   now = 59 like Excel (phantom 1900-02-29 / "Jan 0" handling in `_serialToYMD` /
   `_excelSerialFromYMD`); live on A-1 GPP row 116 where a no-match MINIFS seeds an EOMONTH
   chain from 0. And **`computeXIRR` now uses Excel's 365-day basis** (was 365.25) — this was
   the residual 4th-decimal IRR drift on all 14 Equity IRR cells.

**Result (one-pass warm-GT recompute, full rebuild):** Equity 9,819 → **1** divergence (the
cosmetic `CELL("filename")` label); GPP Promote 4.62M set-divergences → **30** (all cosmetic
`TEXT()` percent labels). `Equity!AN122` = 1.3191e7 == GT, `GPP Promote!D88` = 4.1613e7 == GT,
row 116 and every IRR exact. **Zero numeric divergence on both traced sheets.**

New regression `pipelines/rust/tests/test-shared-formula-anchors.mjs` (hand-zipped xlsx with
REAL `<f t="shared">` groups — SheetJS never writes them, which is why the 78/78 smoke suite
missed this class; negative-controlled RED on 0.26 with the predicted wrong values 22/23/5/7,
GREEN on 0.35) + epoch-quirk & XIRR-365 cases in `test-date-axis-sumifs.mjs`. Both in `npm test`.

Follow-up noted: `lib/irr.mjs` (CLI-side XIRR) still uses 365.25 — separate consumer, tracked
in ROADMAP. #33/#46 (scale wall) unchanged by this fix.

## 2026-06-08 — #DIV/0! honesty (#60) + convergence churn bound (#61)

**#60 — un-IFERROR'd aggregates no longer turn a `#DIV/0!` into a confident wrong number.**
Excel `#DIV/0!` is `x/0`->±Infinity / `0/0`->NaN in JS. The old reducer `(+b||0)` PROPAGATED
Infinity but SILENTLY DROPPED NaN (`+NaN||0===0`), so `=SUM(100, 0/0, 250)` returned **350**
(Excel: `#DIV/0!`) — on **acyclic** cells the #57 convergence machinery never inspects. Fix:
route every division through `_div` (collapses `x/0` and `0/0` to one **NaN** sentinel that
`IFERROR`/`ISERROR`/`ISNUMBER` already catch post-#55), and make `SUM`/`SUBTOTAL`/`SUMPRODUCT`/
`AVERAGE`/`SUMIF`/`SUMIFS` propagate a non-finite **number** as NaN via a shared `_aggNum`
helper — while still treating **text** as 0 (Excel ignores text in SUM; the naive fix would
wrongly poison label cells). `_div`+`_aggNum` land in BOTH emitters (`chunked_emitter.rs`
runtime helpers + the per-sheet-module import list, and `model_map.rs` raw-engine helpers);
the cone inherits them via its lifted `_helpers.mjs` import. The `isFinite`-filtering
criteria-aggregators (`MINIFS`/`MAXIFS`/`AVERAGEIF`/`AVERAGEIFS`) already exclude non-finite
and are left as-is. New regression `pipelines/rust/tests/test-div-nan-propagation.mjs`.

**#61 — bound convergence churn on a hopeless cluster.** The #57 Commit-A non-finite branch
`continue`s before the divergence detector and only short-circuits when the FINITE surface has
SETTLED, so a cluster that is BOTH divergent AND carries a persistent structural non-finite
ran all `MAX_ITER=200` passes (multi-hour on real A-1) before NaN-filling. Added a generous
absolute non-finite-pass cap (50) in `chunked_emitter.rs`; ported the monotone-up/flat-hot
divergence detector + the cap into `eval/per-sheet-eval.mjs` (it had neither, so a divergent
cluster churned to 200 then NaN-filled); and **removed the dead pre-#57 cluster loop** in
`per-sheet-eval.mjs` `evalOneSheet` (a reactivation hazard — it still had the old
non-finite-poisoning behavior). Correctness-safe (converged=false + NaN-fill either way). New
regression `test-cluster-divergent-cap.mjs`. Both tests wired into `npm test`.

NOTE: #60 can move base-case numbers wherever a model relied on the silent drop, so it was
gated on a real-A-1 before/after re-measure (see the gate run recorded with this change).

## 2026-06-08 — per-sheet-eval true lockstep with the engine: NaN-fill on non-convergence + engine-faithful warming delta (#57 follow-up)

An adversarial verification of #57 Commit A found my "lockstep" claim was overstated: the
`eval/per-sheet-eval.mjs` cluster loop mirrored the transient-tolerant loop *body*, but the
shipped engine (`chunked_emitter.rs`) also **NaN-fills every cluster cell when the cluster
does not converge** (the PR #52 honesty contract), and the eval harness did **not**. So a
non-converged returns/MIP cluster (a structural `#DIV/0!` or a divergent cycle) had its
**warm-seeded** ground-truth values left in place and reported as ~100% "measured", while
`eng.run()` returns NaN for those exact cells — the fast harness over-reported accuracy on a
cluster the engine refuses to trust (and the lite/cone accuracy numbers are read from here).

Fix: per-sheet-eval now (a) stores the non-finite value as the delta baseline (mirroring the
engine's `_before[i]=_cur`, and dropping the old `prevSnapshot||0`) so a warming cell is judged
on the **same pass** the engine judges it; and (b) **NaN-fills the cells a non-converged cluster
wrote** before the comparison + named-output harvest, so a non-converged cluster reports NaN
(detectably unusable) instead of warm-seed GT. New regression
`pipelines/rust/tests/test-per-sheet-eval-lockstep.mjs`: a convergent cross-sheet cluster still
reports 100%; a structural `#DIV/0!` cluster now reports `clustersConverged=0` and **low**
accuracy (NaN-filled) — the negative control confirmed pre-fix it reported ~80% by keeping the
warm seed. Wired into `npm test`.

KNOWN REMAINING GAP (tracked separately, not a correctness issue): per-sheet-eval still lacks the
engine's monotone-up/flat-hot **divergence detector**, so a divergent cluster churns to
`MAX_ITER` before the NaN-fill (honest result, just slower); and the engine itself does not
short-circuit a cluster that is *both* divergent *and* carries a persistent structural non-finite
(it runs to `MAX_ITER` then NaN-fills — correct, but the Commit-A note's "does not churn to
MAX_ITER" only holds for the structural-but-*settled* case).

## 2026-06-08 — Transient-tolerant cluster convergence: a divide-by-cold-0 no longer aborts the cluster (#57, Commit A)

The cross-sheet cluster convergence loop (`chunked_emitter.rs`) aborted on the **first** non-finite
sampled cell (`_nonFiniteStreak >= 3` early break) and then NaN-filled the **whole** cluster. On the
real Outpost A-1 returns cluster a coverage/amortization ratio divides by a denominator that is a
**cold 0 at iteration 0** and **warms** to nonzero as the cluster solves; the bare division was
transiently `Infinity`, poisoned a downstream `SUM` (`Debt!AR84`), and the loop quit at iteration 3 —
**before** the denominator warmed — reporting `converged:false` and destroying the cluster's true
(finite) fixed point (`totalCarry` / `class-*.equityBasis` measured 0%).

Fix: the loop is now **transient-tolerant** — a non-finite cell is excluded from the delta and the
loop keeps iterating; non-finiteness is judged **only at the fixed point**. A TRANSIENT cold-0 warms
and the cluster converges to the correct numbers; a STRUCTURAL `#DIV/0!` that never warms stays
non-finite and stays `converged:false` (honest — the existing NaN-fill contract from PR #52 is
preserved, never a silent wrong number). A structural-but-settled cell short-circuits after a few
passes so a hopeless case does not churn to `MAX_ITER`. Mirrored in `eval/per-sheet-eval.mjs` so the
fast eval harness and the shipped engine agree (lockstep). Division emission is **unchanged** (bare).

New regression `pipelines/rust/tests/test-cluster-transient-div0.mjs` builds cross-sheet clusters
through the real rust-parser and drives `eng.run()` (cold-start — the surface that reproduces the
transient; per-sheet-eval warm-seeds full GT on a tiny model and would not): MODEL A transient
converges (pre-fix `converged:false` + NaN — the negative control verified red on the pre-fix
emitter), MODEL C structural `#DIV/0!` stays `converged:false` with NaN (not a fabricated value),
MODEL D `IFERROR`-caught converges, MODEL E divergent cycle still NaN-fills. Wired into `npm test`.

NOTE: this is the **convergence** half of #57 (Commit A). The separate latent honesty hole — the
`SUM` reducer `(+b||0)` propagates `Infinity` but **silently drops** a `0/0` `NaN` (turns a real
`#DIV/0!` into a confident wrong number) — is fixed in a follow-up (`_div` canonical NaN sentinel +
NaN-propagating reducers) that is gated behind a real-A-1 before/after re-measure (it can move
base-case numbers) and is therefore tracked separately, not in this change.

## 2026-06-08 — per-sheet-eval: initialize `_sheetConvergence` in the child ctx [eval regression]

PR #52 (circular-engine honesty) made emitted sheet modules with an intra-sheet cycle write
`ctx._sheetConvergence[SHEET_NAME]` from inside `compute()`. `eval/per-sheet-eval.mjs` builds its own
hand-rolled ctx in the child eval script and did not initialize `_sheetConvergence`, so the moment such
a sheet ran it threw `Cannot set properties of undefined (setting '<sheet>')`. This silently broke the
cluster recompute on any real model with an intra-sheet cycle (e.g. Outpost A-1's GPP Promote — the
cluster ran ~10 min then crashed). `npm test` missed it because the only per-sheet-eval cluster fixture
is **cross-sheet** (its sheets have no internal loop).

Fix: add `_sheetConvergence: {}` to both child ctx templates (standalone + cluster). New parser-backed
regression `pipelines/rust/tests/test-per-sheet-eval-intracycle.mjs` builds a single-sheet convergent
mutual cycle and asserts per-sheet-eval evaluates it without error (wired into `npm test`).

## 2026-06-08 — Transpiler error-guards: #DIV/0! (±Infinity) treated as an Excel error [engine defect]

Found by running the real Outpost A-1 17-sheet returns cluster end-to-end. Excel's `#DIV/0!`
surfaces in JS as **±Infinity** (`x/0`, x≠0), **not** NaN, but the transpiler's error guards tested
only `isNaN`:

- **`IFERROR(expr, fb)`** (`transpiler.rs`) returned **Infinity** instead of `fb` for `x/0` — on A-1
  alone this is **194,175** IFERROR cells. The leaked Infinity then propagates through downstream sums
  and poisons the circular-cluster convergence (a major root cause of the lock-grade non-convergence,
  T-076): in an A/B recompute the first non-finite cell moved from `Owned Asset PP&E!N22`
  (`=IFERROR(N23/N21,0)`, N21 a date-keyed SUMIFS that iterates to 0) past N22 once fixed.
- **`ISERROR`/`ISNUMBER`** had the same gap (`IF(ISERROR(x/0),…)` is the pre-IFERROR idiom and leaked
  the same Infinity).

Fix: the numeric guards now treat any **non-finite number** (NaN **and** ±Infinity) as the error case
(`!Number.isFinite` / `!isFinite` / `isFinite`), typeof-guarded so strings/finite/NaN behaviour is
unchanged. New unit tests (`transpiler::error_guard_lowering_tests`) and an end-to-end regression
(`pipelines/rust/tests/test-iferror-infinity.mjs`, wired into `npm test`). cargo 29/29, smoke 126/126.

NOTE: this is necessary but **not sufficient** for a converged A-1 base case — bare (non-IFERROR)
divisions still leak Infinity, where Excel propagates `#DIV/0!`. Tracked separately (lock-grade
convergence).

## 2026-06-06 — Outstanding-work triage: 6 PRs merged (engine defects + contract + lite follow-ups)

A verified triage (adversarial workflow — every open issue/ADR/follow-up re-checked against `main` +
a skeptic cross-check) reprioritized all outstanding work; a fan-out of build→test agents then landed
the **in-repo-gateable** fixes as six small FF-merged PRs (each individually green; master reviewed +
merged + re-ran the full integrated suite). The two real-model-only items (#46/#33 row-block submodule
emission) were **deliberately HELD** — they can't be honestly gated without the 200 MB models.

- **#47 (PR #51) — date-axis float drift [engine defect, P0].** `DATE`/`EDATE`/`EOMONTH` now transpile
  to INTEGER Excel day-serials via calendar-exact `_excelSerialFromYMD`/`_edate`/`_eomonth` runtime
  helpers (day-of-month clamping; EOMONTH last-day; leap-year correct) instead of the `*30.44`
  float-month approximation that drifted EDATE/EOMONTH date axes off integer serials and silently
  zeroed exact-match `SUMIFS`/`MINIFS` date-key lookups (→ `x/0` → Inf/NaN across the MIP/returns cone).
  New `pipelines/rust/tests/test-date-axis-sumifs.mjs` drives an EDATE-recurrence axis + exact-equality
  SUMIFS (with a verified negative control: reverting to `*30.44` returns 0). **Real-model A-1 re-gate
  still pending** (200 MB model not in repo).
- **circular-engine honesty F2/F3/F4 (PR #52) — silent non-convergence [engine defect, P0].**
  Single-sheet cycles previously reported `meta.converged:true` / `perSheetIterations:{}` unconditionally
  (the acyclic orchestrator path emitted no telemetry), and a constant per-iteration delta was misread
  as "stale" → divergent/slow-contractive runs returned confident garbage labeled converged. Now: intra-
  sheet convergence telemetry surfaces into `meta.sheetConvergence`/`perSheetIterations`, and a real
  monotone-up / flat-but-hot divergence check (at both convergence sites) sets `converged:false` and
  **NaN-fills** the affected cells (detectably unusable, never a confident wrong number; locked input
  overrides preserved). `lib/integration-doc.mjs` documents the `converged:false = do-not-trust` contract.
  New `test-circular-honesty.mjs` (negative control: the pre-fix emitter returns `converged:true` +
  `A1≈1.6e60`). Behavior change is strictly in the honest direction; smoke 126/126 + test:engine 24/24
  confirm convergent cases are 0-drift. (P2-14 intra-sheet cell topo-sort left as a separate follow-up.)
- **#24 axes 3 & 4 (PR #48) — downstream-consumable artifact [contract, P1].** Emits a consumer-spec
  `engineArtifactHash` (single sha256 over `engine.js` bytes then each `sheets/` file sorted by
  filename, filename-then-bytes; engine.js + sheets/ only — NOT the internal structured `contentHash`,
  which stays for cross-rebuild stability) + `versionTag`/`platform`/`class` identity fields (output dir
  stays version-free). Non-circular golden-vector + mutation-guard test. **Was over-claimed "DONE" — only
  3/5 axes were real.** Still pending: share a golden vector with the Mippy team + add a manifest invariant.
- **#25 (PR #49) — value-bearing MIP outputs [contract, P1].** `detectMipValueCells` auto-detects, per
  equity class, the per-block MIP/promote **proceeds** (aggregated into a `{cells,op:'sum'}` ref),
  **hurdle**, and **valuation** cells from ground truth — fail-soft (unset, never a wrong cell, when
  labels don't resolve). Aggregate-path round-trip + detection + mutation-guard coverage added.
  **Was over-claimed "DONE" — only the schedules + pinning SUPPORT had shipped.** Mechanism validated on
  synthetic fixtures; **real A-1 MIP-total reconciliation pending** before Mippy trusts auto-detected proceeds.
- **ADR-027 follow-up #1 (PR #53) — generalize Tier-0.** `detectTier0Layout` derives the per-tier
  GP-cashflow cells + cashflow rows from ground truth, gated on the carry-total reconciliation invariant
  (fail-soft); `emitTier0` is now manifest-driven and fail-loud-escalates to Tier 1 when the layout is
  absent — no longer limited to the GPP-Promote fixture. Second synthetic fixture asserts on the
  **disclosed `shapeResidual`** (2-tier annual `lib/waterfall` vs a 4-tier split), not bit-exactness.
- **ADR-027 follow-up #2 (PR #50) — disclosure reconciliation.** `ete lite` no longer prints the
  a-priori "BY-REQUEST SURROGATE BELOW FLOOR" disclosure when the MEASURED surrogate r² actually clears
  the output-class floor (anchored strip in `cli/commands/lite.mjs` only; the recommender's pure
  prediction + its snapshot test are untouched; the measured per-output gate stays the sole authority).
- **Hygiene (reconciled by the triage):** #32 (dep-graph 37 GB) and #26 (`_fn-fallbacks.json` audit) are
  **fixed-unclosed** — done on `main`, to be CLOSED on GitHub (#26 after filing the ~11,813-fallback
  coverage-debt tracker). The stale ADR-026 "Proposed" status + HANDOFF "re-gate unblocked by #43" drift
  remain to be corrected; the cone stays EXPERIMENTAL (re-gate blocked on #47).

## 2026-06-06 — Lite package Phase 7: the FRONT DOOR (`ete lite` + skill + day-in-the-life e2e)

The capstone that makes the ADR-027 lite package usable end-to-end by a non-technical analyst
pointing a coding agent at the repo. NO Rust, NO network.

- **`ete lite <dir> --output grossIRR,totalCarry --use-case one-off`** (`cli/commands/lite.mjs`,
  wired additively into `cli/index.mjs`): answers the three front-door questions, builds a no-Rust
  `cascadeEvaluator`, derives the candidate levers (exitMultiple; exitYear only via
  `--with-exit-year` — adding it false-escalates a 0.97-floor return output on an interaction-free
  fit), `recommendTier` → persona/tier/budget, `selectDrivers` → scope, then EMITS the chosen tier:
  Tier 0 via `emitTier0` with an HONEST fall-back to Tier 1 on the single-fixture layout guard (the
  fixtures' carry sheet is `GP Promote`, not `GPP Promote`); Tier 1 via `emitSurrogate` (honesty-
  gated). Because `ete lite` is the NO-RUST front door it never auto-builds Tier 2/3; it ESCALATES to
  the cone — surfacing the exact `ete init --emit-cones` command — whenever EITHER a measured per-
  output escalation fires (kink / below-floor) OR the recommender capped DOWN from the cone
  (`no-rust-cap` / `r2-floor`, e.g. an `app-integration` carry request whose Tier-2 cone default is
  unreachable without Rust). The recommender's class-specific disclosures (e.g. "NO-RUST FALLBACK",
  "carry surrogate below floor") are now surfaced, never dropped. Writes a standalone `INTEGRATION.md`
  from `documentLiteArtifact` (the fixtures dir has no engine.js so `emitIntegrationDoc` skips).
  Escalated outputs report `{escalated:true}` — NEVER a fabricated number.
- **Usability fixes (post-review):** the headline command `ete lite <dir> --output grossIRR
  --use-case one-off` (no `--out-dir`) now CREATES the default `<dir>/lite-out` before emitting (was
  a raw ENOENT crash — neither emit path mkdir'd); `--no-write` now actually previews without writing
  (the arg parser camelCases it to `noWrite`, which was unread, so writes still happened); each output
  is labelled with its OWN class in the summary (`grossIRR (irr)`, `totalCarry (carry)` — not one
  lumped class); the run-file's exact grouped key is shown next to the friendly name; the local
  r²-floor table was replaced by the canonical `R2_FLOORS` import (single source of truth).
- **Kink-aware recommender (post-merge master fix):** `runLite` now runs `selectDrivers` BEFORE
  `recommendTier` and feeds its real breakpoint finding as `modelTraits.hasBreakpointInRange`, so
  the recommender's kink gate is accurate (a kinked money output escalates to the cone at the
  recommendation step, not only later at surrogate-emit) and the spurious "BREAKPOINT CHECK NOT RUN
  … UNVERIFIED" disclosure no longer fires on a clean, already-checked output.
- **`skill/lite/SKILL.md`** — the focused, plain-language front-door skill (three questions, the
  hidden 4th, two personas, the tier ladder, the exact command, how to read the result, the honesty
  caveats, the handoff). Now states plainly that `ete lite` is no-Rust and only ESCALATES to the cone
  (never auto-builds it), and documents the disclosures + grouped run() keys. One-line pointer added
  from `skill/SKILL.md`.
- **`tests/cli/test-lite-e2e.mjs`** — the day-in-the-life e2e (45 assertions, 1 mutation guard): real
  CLI via spawnSync (exits 0, recommends a tier + rationale, Tier-0→1 fallback quoted); the literal
  front-door command with NO `--out-dir` (creates the default `lite-out`, no ENOENT); `--no-write`
  previews without writing; the integrator cone lane (`app-integration` carry surfaces the
  `ete init --emit-cones` command + the NO-RUST FALLBACK disclosure); KB-sized artifact (< 64 KB) +
  run file; NON-CIRCULAR base fidelity vs the independently-computed cascade base; handoff NAMES the
  lever + fidelity + escalations; HONEST escalation negative control on the synthetic MIP@1.5× kink
  (gpCarry/mip escalate, grossMOIC ships; same outputs ship clean on a no-kink range); refuse-on-
  mismatch on a tampered beta. Gates green: test-lite-e2e (45/45), test-cli (34/34), test-onboarding
  (15/15).

## 2026-06-06 — Lite package Phases 3, 4, 6 + a shared test standard

The lib layer beneath the Phase-7 front door, each built adversarially (spec → build → 3-lens review
with mutation testing → fix) and FF-merged small with the full suite green. NO Rust, NO network.

- **Test standard** (`tests/lib/_lite-harness.mjs` + `docs/LITE-TEST-STANDARD.md`): a counted
  assert/near/throws harness plus `mutationGuard` — the anti-tautology check Phase 1 lacked. The
  rules every lite test follows: non-circular truth, a negative control, a mandatory mutation guard,
  refuse-on-mismatch provenance MUST be tested, honesty-gate escalation MUST be tested, committed
  fixtures only, no network/clock/random.
- **Phase 3 — evaluator adapters** (`lib/lite-evaluators.mjs`, 98 assertions): the pluggable
  `(inputs)=>groupedResult` contract driver-scope + the surrogate consume — `cascadeEvaluator`
  (no-Rust delta-cascade → grouped), `directEvaluator` (already-grouped compute fn / engine.run),
  `engineRunEvaluator` (chunked `run()` + outputsSpec), and a documented workbook-variant stub. Only
  finite/boolean leaves are emitted (null carry below the hurdle, NaN, object `carryDetail` omitted);
  non-finite / unmapped / malformed-map driver values throw loud.
- **Phase 4 — Tier-1 surrogate emitter + honesty gate** (`lib/lite-surrogate.mjs`, 79 assertions, 6
  mutation guards): `emitSurrogate`/`loadSurrogate`. Multiplicative `out = base·∏(1+βᵢΔᵢ)` fit with a
  per-driver quadratic fallback; r²/maxResidual MEASURED on the fitted surrogate (never the
  `selectedR2` proxy). Ordered honesty gate: a detected kink ALWAYS escalates to Tier 2 and OVERRIDES
  the by-request carve-out; coverage-below-floor escalates; below-class-floor escalates unless
  `useCase==='embedded-surrogate'` (then ships under a LOUD disclosure, ADR §5). A signed `gateHash`
  over the gate decision + coeff/base floats + r²/disclosure means `loadSurrogate` refuses a tampered
  β or a force-shipped kinked output; an escalated output returns `{escalated:true}`, never a
  fabricated money number (verified by an independent adversarial probe).
- **Phase 6 — provenance consolidation + handoff** (`lib/lite-provenance.mjs`, 40 assertions):
  single canonical home for `structuralRefs`/`hashStructuralRefs`/`deriveModelHash`/`stableStringify`/
  `fitSignature` + `verifyModelLayer` (the shared model-identity (A)/(B)/(C) refusal logic). lite-tier0
  + lite-surrogate now import it and drop their duplicates (behavior-preserving — tier0 50/50 +
  surrogate 79/79 unchanged; `deriveModelHash` confirmed == a hand sha256). `documentLiteArtifact` +
  `emitIntegrationDoc` now append a lite-artifact section to the handoff when a params file is present
  (byte-identical when absent).

## 2026-06-05 — "Lite" package: design accepted (ADR-027) — implementation pending

A guided, tiered extraction that produces the smallest artifact answering a specific question at
good-enough fidelity, fronted by a skill, shipped as a Claude Code package. **Design only — no code
yet**; pressure-tested by the `pressure-test-lite-package` workflow. See `docs/adr/ADR-027`.

- 3-question guiding skill (+ two personas) → 4-tier ladder (Tier 0 closed-form · Tier 1 surrogate ·
  Tier 2 scoped cone (ADR-026) · Tier 3 full engine) → "0.9 r-value" driver extraction (reuse
  `lib/sensitivity.mjs`). **Load-bearing finding:** SheetJS can't recompute, so Tier-1 sampling = the
  delta-cascade (no-Rust, disclosed approximation) + an analyst-re-saved-`.xlsx`-variant exact upgrade,
  NOT a new recalc dep. Safety gates: auto-escalate breakpoint outputs (carry/MIP kinks) to the cone;
  stamp every artifact with `modelHash` + refuse-on-mismatch. Curated `ete lite` entrypoint + skill.
- **Next (the handoff):** Phase 1 = the Tier-0 closed-form proof (`lib/lite-tier0.mjs` binding a few
  extracted cells to `lib/waterfall` + `lib/irr`, no Rust). See `docs/HANDOFF-lite-and-cone.md` +
  ADR-027's phased build plan.

## 2026-06-05 — Transpiler root-cause fix: absolute-row mixed references (the real-A1 `* `COL`` NaN bug)

Branch `t078/lock-grade-cone` (off `origin/main`). Root-caused and fixed the upstream transpiler bug
the real-A1 cone gate exposed in commit `de2261b` (the `expr * `COL`` → `number * "DB"` = NaN that
demoted `init --emit-cones` to EXPERIMENTAL).

**Root cause (two coupled tokenizer defects in `pipelines/rust/src/formula_ast.rs`):**

1. **Absolute-row mixed references with a non-absolute column were dropped.** A ref like `R$8`,
   `AM$8:AM$22`, or `A$1` (absolute row, relative column — extremely common in financial models that
   anchor a row band) was not parsed as a reference at all. The tokenizer's `read_ident_or_ref` reads
   bare letters but stops at `$`; the generic `read_cell_ref_part` only fires when a ref *starts* with
   `$` or a sheet `!`. So `R$8` fell through to a **bare identifier** → `Expr::StringLit("R")` →
   transpiled as the JS template `` `R` ``. In an arithmetic context — e.g. the J-weighted
   `SUMPRODUCT(J8:J22*R$8:R$22)` on the audited-assets sheets — `range * "R"` = **NaN**, which a scoped
   cone's backward-cone pulls into the active cycle and the NaN poisons convergence (`converged=false`).
   (`$R8` and `$R$8` already parsed correctly; only the *relative-column + absolute-row* shape broke.)
2. **A bare unresolved identifier was emitted as a JS string literal, not a numeric-safe value.** The
   parser's fallback was `Expr::StringLit(name)` with the comment "treat as 0 for now" — but a StringLit
   transpiles to `` `name` ``, and `number * "name"` = NaN, not 0. Intent and behaviour diverged.

**Fixes:**
- New `Expr::Name(String)` AST variant for a bare unresolved identifier (Excel `#NAME?` / unresolved
  named range), transpiled to `/* #NAME? <name> */ null` — **numeric-safe** (`null` coerces to 0 in
  `*`/`+`/SUM, never NaN), matching the historical "treat as 0" intent without the poison. Genuine
  undefined names still surface as `#NAME?` in an audit comment.
- `read_ident_or_ref` now recognises the `COL$ROW[:…]` shape (absolute row, relative column) and parses
  it as a real cell ref / range via two small helpers (`read_row_digits`, `read_ref_after_colon`).
- Range second endpoints with a `$`-row (`R8:R$22`) parse via a new `$`-tolerant
  `looks_like_cell_ref_dollar` instead of silently collapsing to the first endpoint.
- Fixed a latent bug in `parse_simple_cell_ref` surfaced by the above: the column slice was taken
  *after* consuming the row `$`, leaking it into `col` (`R$22` → `"R$"` → broken `ctx.range("…R$22")`).

**Evidence / validation:**
- Confirmed by direct transpiler reproduction: `SUMPRODUCT(J8:J22*R$8:R$22)` now emits
  `(ctx.range("S!J8:J22") * ctx.range("S!R8:R22"))` (was `… * /* #NAME? R */ null`, previously
  `… * `R``). All five `$`-placements of `R$8:R$22` normalise to a clean `ctx.range("S!R8:R22")`.
- The real-A1 artifact's affected cells (`Assets - Q4-25 (audited)!{R,AM}{25..27}`, `Assets - Q1-26`)
  were the `* `COL`` shape; the bare identifiers (`R`, `AM`) are real data columns on those sheets, so
  the references must resolve — not fold to 0/NaN. Fix proven at the transpiler level.
- **Honest limitation:** a full real-A1 *end-to-end* cone re-gate could NOT be run here — the Outpost
  source workbook is gitignored / R2-only and is not in this checkout. The fix is validated against
  the transpiler oracle + the synthetic cone gate; the end-to-end re-gate (rebuild the chunked artifact
  from the Outpost xlsx with this parser, then `--compare baseline`) is the remaining step before the
  EXPERIMENTAL label can be lifted. `init --emit-cones` therefore stays EXPERIMENTAL pending that re-gate.

**Tests:** new Rust regression tests in `formula_ast.rs` (`name_fallback_tests`): the exact real-A1
`SUMPRODUCT` shape never emits a bareword string-template; absolute-row mixed refs in all five
`$`-placements parse as references; genuine undefined names still resolve to `#NAME?`; quoted strings
unaffected. Full suite green: cargo 23/23, chunked smoke 126/126 (100%), JS lib/cli/cone 500+ tests,
engine 24, depgraph 14, runnable 20, lazy-engine 19, slimming 13, golden 20, efficacy mini-cyclic
5/5 @1e-6 parity OK. No gate weakened, nothing skip-listed.

## 2026-06-04 — Engine-speed Wave 2 landed: scoped cone module (L2) + cell-level full executor (L1)

Branch `feat/engine-perf-wave2` (off `origin/main`). The ADR-026 keystone. One JS post-emit
generator serves both lanes by **lifting each cell's transpiled expression straight out of the
emitted sheet modules** (the `ctx.set("addr", <expr>)` lines) and recomputing only the active
subgraph — no Rust rewrite, exact reproduction of the default engine by construction.

- **L0 extension — `lib/scope-plan.mjs`.** Added the additive `plan.activeOrder`: the unified
  reads-first order of the active subgraph (acyclic cells + cycle-unit arrays **interleaved**), so
  a consumer can emit cells in the exact order it must evaluate them. This was the missing piece —
  an output that *reads* a cycle is acyclic but must be set *after* the cycle converges, which the
  acyclic-only `activeAcyclic` list cannot express. Added `buildFullPlan({edges,gtKeys})` (every
  formula cell active, cell-level SCCs, leaves as boundary) for L1, and `plan.inputBase` so a cone
  reproduces the base case when a lever is not overridden. Behaviour-preserving refactor of the
  shared boundary collection; `activeAcyclic` stays byte-identical.
- **L1/L2 core — `lib/cell-exprs.mjs` + `lib/cone-emit.mjs`.** `extractCellExprs` (streaming, robust
  on the 190 MB monster modules) lifts the per-cell expressions. `generateConeSource` renders a
  standalone module = BOUNDARY/INPUT_BASE constants + active-acyclic (topo) + active-cycle loops
  (the intra-sheet convergence pattern + lock-grade NaN-guard), exposing the **C3 `run()` contract**
  (override pinning, strict, honest `meta.converged`). `buildCone` (L2 scoped) passes base values as
  `gtKeys` so range-member leaf boundary cells are not dropped (**ADR-026 invariant #6** — the L0
  review landmine). `buildFullExecutor` (L1) runs the same generator over `buildFullPlan`: each
  acyclic cell once in topo order, only the true cycle cells iterate.
- **Harness + fixtures — `benchmarks/`.** Reshaped the synthetic fixtures so the big acyclic
  schedule lives **on a cluster sheet** — the real pathology (the Wave-1 fixture put it on its own
  acyclic sheet, so L1 had nothing to optimise). Wired the `scoped` + `cycle` variants + a
  cells-iterated/pass metric into `efficacy.mjs`; `--compare baseline` gates value parity and prints
  speedup× / module-bytes× / ÷cells-ratio.
- **Init integration — `cli ... init --emit-cones`.** Opt-in: emits `chunked/cones/<scopeId>.mjs` +
  `cones/_index.json` for the MIP-grid surface (seeded from the named maps), before graph slimming,
  best-effort.

**Measured (`--compare baseline`, value parity OK):**

| Fixture (cells) | Variant | Correct | Cells/pass | Speedup | Module |
|---|---|---|---|---|---|
| midi (50,005) | scoped (L2) | 5/5 @1e-6 | 3 vs 100,004 → **÷33,334** | **855×** | **898× smaller** |
| midi (50,005) | cycle (L1)  | 5/5 @1e-6 | 3 vs 100,004 → **÷33,334** | 1.59× wall | ~1× |
| mini (605)    | scoped (L2) | 5/5 @1e-6 | 3 vs 1,204 → ÷401 | 13.4× | 12.5× smaller |

L2 smashes the Tier-3 targets (≥100× for the grid; no big module loaded). L1's cells-iterated/pass
÷33,334 far exceeds the ÷500 target; its modest wall-clock on midi reflects midi's 15 cluster passes
(the per-pass reduction dominates on the real cluster's ~200 passes). The L1 full-executor module is
sheet-module-sized on the real model (active=everything), so it is the **midi-scale proof + reference
implementation**; making it the *default* engine is the Rust-emitter follow-on (Wave 3).

**Scale finding (honest):** L0 `buildScopePlan` was validated on the real 535 MB A-1 graph (5.58 M
cells / 1.76 B edges) for the first time — it COMPLETES correctly, but the PLAN's "<2 s" target was
wrong: graph-load ≈14 s, `buildScopePlan` ≈**20 min**, peak ≈**16 GB** (off-heap CSR). The cost is
intrinsic full-graph processing, independent of cone size. This is a one-time **BUILD** cost (the cone
is emitted once at `init --emit-cones`; the runtime `cone.run()` what-if stays ms) and amortizes over
the MIP grid, but `--emit-cones` on the largest models needs ~16 GB and minutes. **Wave-3 fix:** build
the CSR once and limit per-scope work to the cone (CSR cache / streaming extraction). The synthetic
fixtures prove the RUNTIME thesis; the at-scale BUILD is the next optimization.

**Real-model gate finding (honest — the cone is EXPERIMENTAL on real models).** Building a real A-1
cone (UW returns scope) and diffing vs ground truth FAILED: `converged=false`, 0/4 returns match (the
cone is honest — the NaN-guard reported non-convergence rather than returning garbage). Root cause is
**upstream, not the cone**: thousands of cells in the *sheet modules themselves* (the default engine)
are transpiled as `expr * `COL`` — a multiply by a bare column-letter STRING (`* `AO`` ×1467, `* `DB``
×1204, …) → `number * "DB"` = **NaN**. The named outputs dodge those cells (so lockgrade base-case
verification still passes), but a scoped cone's static backward-cone pulls them in and the NaN poisons
the active cycle. The cone faithfully reproduces the (buggy) engine; the blocker is the transpiler. So
`init --emit-cones` is shipped **EXPERIMENTAL** (synthetic-validated; verify `cone.run()==engine.run()`
before production use). Follow-ups: fix the transpiler `* `COL`` emission, then re-gate the cone.
The cone size/structure thesis DID hold at scale: the A-1 cone module was **7.8 MB vs 788 MB of sheet
modules (101× smaller)** and imports only `_helpers.mjs`.

Tests: `tests/lib/test-scope-plan.mjs` 47/47 (+14: activeOrder incl. multi-cycle topo, buildFullPlan),
new `tests/lib/test-cone-emit.mjs` 59/59 (scoped/full/manifest cones == engine for base + what-ifs, C3
contract, strict, cell-exprs round-trip). Both wired into `npm test`; full suite green.

## 2026-06-04 — Engine-speed Wave 1 landed: scope-plan lib (C1) + efficacy harness (C2) + Tier-1 quick wins

Branch `feat/engine-perf`. First code wave off the ADR-026 plan — three independent lanes, each
implemented and adversarially reviewed, then integrated green.

- **Lane 0 — `lib/scope-plan.mjs` (contract C1).** `buildScopePlan({edges,inputs,outputs,gtKeys})`
  → `ScopePlan` { scopeId, modelHash, inputs, outputs, activeAcyclic (reads-first topo), activeCycles
  (SCC units), boundary, stats }. Cell-level: active = `forwardCone(inputs)` (reverse-edge reach) ∩
  `backwardCone(outputs)` (forward-edge reach); boundary = cells an active cell reads that are constant
  under the levers → pinned to base. Range-aware iterative Tarjan + integer-id CSR (lifted from
  `analyze-cone.mjs`, no recursion). Exported `parseRefToken`/`expandRange`/`buildCellIndex`/
  `forEachCellInRange` from `lib/manifest-maps.mjs` (behaviour-preserving). New
  `tests/lib/test-scope-plan.mjs` (33/33). Foundation for L1/L2.
- **Lane 4 — `benchmarks/efficacy.mjs` + fixtures (contract C2).** Seconds-fast inner loop that PROVES
  every named output against a blessed `golden.json` within 1e-6 (reuses `verify-engine.mjs`
  `close()`/`resolveOutput()`) — any drift exits non-zero. Synthetic `mini-cyclic` fixture
  (`benchmarks/fixtures/_build.mjs`, built with the real parser) reproduces the pathology: a cross-sheet
  cycle (Debt↔CF) + a big acyclic schedule + named outputs downstream of the cycle. `--bless` records
  golden; `--compare` asserts variant parity + speedup×/memory×. `baseline` variant implemented;
  `scoped` (L2) / `cycle` (L1) are pluggable hooks for Wave 2. Sanitized `efficacy-history.jsonl` +
  committed `EFFICACY.md`; full detail → gitignored `benchmarks/results/`. Generated `chunked/` dirs are
  gitignored and regenerated on demand (committed fixture = spec + golden, never stale).
- **Lane 3 — Tier-1 quick wins.** Dropped the double return-clone in the emitted `run()`
  (`chunked_emitter.rs`): `values` and `kpis` now share ONE `{...ctx.values}` snapshot instead of cloning
  the (up to ~5.8M-entry) map twice — `kpis()` was already `{...this.values}`, so content + shape are
  unchanged (≈−400 MB alloc/run on the real model). Enabled the V8 compile cache in `cli/index.mjs`
  (`module.enableCompileCache()`, guarded; honors `NODE_COMPILE_CACHE`) to amortize repeat engine
  imports. `--lazy-engine`-as-default deferred (conservative). Byte-correct outputs: smoke 126/126,
  lazy-engine 19/19, engine-runtime 24/24.

Full `npm test` green. Next (Wave 2, gated on C1/C2): **L1** cell-level cycle resolution in the engine
and **L2 / #22 / T-078** scoped cone-module transpile (the ADR-026 keystone).

## 2026-06-03 — Cell-level cone/cycle MEASURED + scoped-subgraph design (ADR-026) + parallel-lane plan

Branch `feat/engine-perf` (off `main@9ef55c5`). **Design + measurement only — no engine code changed.**

**Measured the real A-1 cell graph** (`benchmarks/analyze-cone.mjs`, new): emitted the compact
`dependency-graph.json` (535 MB, `--emit-debug`) and ran a range-aware CSR/Tarjan over all
**5,579,816 formula cells** (1.76B expanded edges). Results: the true largest cell-level cycle is
**2,992 cells (0.054%)**; all cycles together 10,684 (0.19%); output cones are **median 0.38%, p90
8.5%, max 66%**; distinct cross-sheet target cells 1.30M (23%). Conclusion: **the 17-sheet
convergence cluster is 99.8% artifact** — real circularity ≤0.19% of cells — because chunked mode
clusters at SHEET granularity (`main.rs:252` skips cell-level cycle detection).

**Confirmed the scoping gap** (4-lane research): `--lazy-engine` `runScoped`/`load` is **sheet-level**
(extracts the sheet prefix, walks `SHEET_DEPS`, and any cluster cell pulls all 17 modules) and sheet
modules are **monolithic** (one `compute()` each), so a single needed cell forces a 190 MB import.
Sheet-level scoping therefore cannot beat the **776 MB module wall**; only cell-level can.

**Authored the design + plan:**
- `docs/adr/ADR-026-scoped-subgraph-transpile.md` — the scoped-subgraph (cone-module) design:
  recompute only the **active subgraph = fwdCone(inputs) ∩ backCone(outputs)** and constant-fold the
  rest (boundary cells pinned to base values). Correctness proof, artifact shape, reuse of the
  existing cone primitives (`computeOutputClosures`, `loadDependencyEdges`, lazy range expansion),
  preserved `run()` contract invariants, alternatives, risks.
- `docs/PLAN-engine-speed.md` — parallel coding lanes (L0 scope-plan lib · L1 in-engine cell-level
  cycle resolution · L2 cone-module transpile · L3 Tier-1 quick wins · L4 efficacy harness) with
  frozen inter-lane contracts and a tiered rapid-iteration test harness (mini/midi synthetic inner
  loop + outpost gate, golden-value oracle, A/B speedup, sanitized history).

## 2026-06-03 — AVERAGEIFS transpiled (A-2 returns cone stub-free) + cone-measurement findings

Branch `feat/transpile-averageifs` (off `main`). Two outcomes from rebuilding and measuring the
Outpost A-2 returns cone on the post-wave-2 engine.

**AVERAGEIFS/AVERAGEIF transpiled — the A-2 returns cone is now stub-free.** Rebuilding A-2 off the
wave-2 parser (`ete init --emit-debug`) showed the net-returns outputs (`class-1.netMOIC`,
`class-1.netIRR`) still resolving through an `_fn()` stub — `AVERAGEIFS` (×3103), the one function
left after the wave-1 XNPV/FILTER/MINIFS/MAXIFS work. On A-1 it sat OUTSIDE the cone; on A-2 it's
inside it. Added the transpiler arm (`transpiler.rs`, mirroring SUMIFS/MINIFS criteria-pair
handling) + runtime helpers `_averageif`/`_averageifs` (`chunked_emitter.rs`; mean of matching
numeric+finite values, 0 on no-match per the engine's IFS convention; stored bare — no `_xlfn`
prefix). A fresh A-2 rebuild reports **0 `_fn()` fallback cells** (was 3103) and **no output
resolves through a stub** — the function-level `--assert-no-fallbacks` AFTER is green on the real
A-2 model. FnTest fixture exercises both (smoke 126/126, test:engine 24/24, cargo 18/18).

**Cone-measurement finding — GT-seed scoping is validated, but the wall is the MODULES, not the
seed.** Measured the 17-sheet returns cluster on the rebuilt A-2 engine. GT-seed scoping (#33, wave
2) cut the cluster seed **23.6×** (6.06M → 257K cells, `GT_SEED_SCOPE=external`) — a real reduction
that worked on the real model. But the cluster still failed at the 600s ceiling under BOTH `cluster`
and `external` scope, because the 17 cluster sheets total **776 MB of JS modules** (Owned Asset PP&E
190MB, Future Owned Acquisitions 144MB, Technology 114MB, Debt 100MB, …) — loading them into one
process exceeds the 8 GB heap before any seed is applied. So the seed was never the binding
constraint for this dominant cluster; the remedy is the **scoped-subgraph transpile (#22 / T-078,
ADR-026)** — emit/run ONLY the input→output cone, not all 776 MB of 17 sheets. Standalone sheets
re-baseline at 99.5% (Term SOFR 100%, UW Comparison 100%, Version Tracker 99.8%, Cheat Sheet 96.8%).
Lock-grade posture HOLDS: the function-level stub gate is now green on A-2, but the convergence
measurement remains blocked on the module wall.

## 2026-06-03 — Lock-grade wave 2: cone-rebuild enablers (sampled-delta, GT-seed scoping, FoF NAV, #25) + adversarial review

Branch `feat/lockgrade-wave2` (off origin/main `e259296`, the PR #38 merge). Four lanes that
unblock rebuilding the Outpost A-2 artifact off the post-#38 transpiler and measuring the
17-sheet returns cone, plus the data-correctness items an equity platform needs. Every lane
shipped with a synthetic smoke test; the whole diff then went through a 4-reviewer adversarial
pass (one verifier per finding) — **9 confirmed-real findings, all fixed**.

**Sampled-delta cluster convergence (perf).** The chunked orchestrator's convergence loop
`JSON.stringify`'d the entire (up to 5.8M-cell) ctx every iteration (~8.8 min/pass on the real
model). Replaced with a sampled delta — every numeric cell on the cluster's own sheets + a bounded
strided safety net, diffed by direct numeric reads (O(sample)/iter). NaN-guard, the undefined→number
first-pass guard, staleness, and `_clusterMeta` telemetry preserved. **Review fix:** a non-finite
pass left the sampled baseline stale, which could false-report `converged=true` on an oscillating
cluster with a transient non-finite cell (reproduced) — the baseline is now invalidated after a NaN
pass (strictly stricter, ≤1 extra iteration), plus an empty-sample guard and an oscillating-cluster
regression test (the non-contractive path had no coverage). test:engine 24/24, smoke 122/122.

**GT-seed scoping for the single-pass cone (#33).** The cluster orchestrator seeded all ~5.8M GT
cells into every cluster child (8 GB+ OOM — the wall that blocked measuring the cone). Added
`computeClusterSeed` (lib/manifest-maps.mjs): seed only the cluster's external reads (upstream
inputs; range refs expanded lazily via the #32 `buildCellIndex`/`forEachCellInRange`) + a warm
start for its own cells; the non-cluster bulk is excluded. Wired into `per-sheet-eval` with
`GT_SEED_SCOPE` (`cluster` default / `external` / `full`) and a per-cluster scoped GT file; falls
back to full-seed (logged) when edges are absent — **the cone rebuild needs `ete init --emit-debug`**
since `dependency-graph.json` is slimmed from the default build. **Review fixes:** clusters using
OFFSET/INDIRECT keep the full seed (their runtime-addressed reads aren't in the static edge map);
an empty edge map normalizes to the full-seed fallback; documented that the default scope reports an
**upper bound** on cone accuracy (use `GT_SEED_SCOPE=external` for the cold-start honest number).

**FoF headline NAV (correctness).** `detectFundLevelMetrics` bound `residualValue` first-match-wins
to a cashflow row label "Net CF to LP (incl. residual NAV)" — a terminal cash flow (`Cash Flows!K7`
= $184.8M, +14.8% over the scalar NAV `IR Cheat Sheet!B12` = $161M), and self-inconsistent with the
RVPI on the line above. Resolved by `pickFundNav`: scalar-over-series (timeline-column count) + RVPI
reconciliation (NAV = RVPI × paid-in) + NAV-label preference. **Review fixes:** anchor to the
label-adjacent cell (`{ labelCol }`, not the rightmost — a trailing column would hijack it); make
scalar-over-series dominant over the reconciliation bonus; gate the broadened NAV match on a
fund-shaped model (no spurious binding on non-fund models). NAV $184.8M → $161.0M, reconciles with
RVPI × Called.

**Per-class value-bearing named-outputs (#25).** `enumerateOutputCells` **and** `resolveBaseCaseOutputs`
now pin per-class `proceeds`/`valuation`/`hurdle` when the manifest carries them (set by a detector
or `ete manifest set`); `inferFormat` maps proceeds/valuation→currency, hurdle→fraction. Auto-detecting
those cells is a follow-up; this lands the pinning support, kept in sync across both resolvers.

All green: `npm test` (use-case 132/132, manifest-maps 102/102, manifest-improvements 61/61),
test:engine 24/24, smoke 122/122, cargo 18/18.

## 2026-06-01 — Lock-grade engine: returns transpiled (no _fn stubs) + single-pass cluster cone + NaN-guard

Closing the two named gaps that kept the Outpost A-1 MIP cone from being lock-grade
(branch `feat/lockgrade-cone`, off origin/main Wave 7 `7e103b9`). Both gaps confirmed
against the **real** model, not just synthetics.

**Gap 2 — the returns no longer resolve through `_fn()` stubs.** The golden gate on the
real `outpost-a1`/`a2` builds showed the returns cone (grossMOIC / grossIRR / netMOIC /
netIRR / equityBasis) resolving through exactly four unimplemented functions: `XNPV`,
`_XLFN._XLWS.FILTER`, `_XLFN.MINIFS`, `_XLFN.MAXIFS`. Added transpiler arms + runtime
helpers for all four (`transpiler.rs`, `chunked_emitter.rs`): `computeXNPV` (Excel
365-day basis), `_minifs`/`_maxifs` (numeric-matched, blank/text-ignoring like Excel),
`_filter` (single-cell array value; `include` = a precomputed flag column, since the
engine evaluates a bare `range = x` as a scalar — no spill). **Critical:** Excel stores
newer functions with future-function prefixes (`_xlfn.`, `_xlfn._xlws.`) —
`transpile_function` now strips them before dispatch, or FILTER/MINIFS/MAXIFS would still
stub on the real model (only XNPV is stored bare; a bare-name fixture gave a false green).
Re-parsing the real `Outpost-A-1.xlsx` (76 MB, 5.8M cells) with the fixed parser: **0**
`_fn` stubs of the four functions remain; the exact flagged cells now compute for real
(`Lease Amortization!AO87 → computeXNPV`, `Equity!AN234 → computeXIRR(_filter(…))`,
`GPP Promote!G24 → _minifs`). Helper usage on the real model: computeXNPV ×7921,
_minifs ×644, _maxifs ×148, _filter ×81. Synthetic `FnTest` fixture exercises all four
(bare + `_xlfn`-prefixed); smoke 122/122. (`AVERAGEIFS` is also stubbed ×3101 but is NOT
in the returns cone — the obvious next add.)

**Gap 1 — single-pass cluster orchestrator measures the MIP cone.** `eval/per-sheet-eval.mjs`
re-ran the full convergence loop once per cluster member (O(cluster²)), so the real
models' 17-sheet circular returns cluster was `--skip-clusters`'d and the cone went
unmeasured. Now a cross-sheet cluster is ONE task: import every member, converge once,
score all members from the shared fixed point (one result row per member; standalone path
untouched; membership from `_graph.json` SCC). `--skip-clusters` flips to OPT-OUT;
`bench.mjs` renders a "Returns / MIP cone" section (named-output accuracy %, never the
figure). Fixture test: 1 convergence, 2 members, 100% (test:per-sheet-eval 10/10). On the
REAL cone this eliminates the 17× redundancy but surfaces a SECOND wall: a SINGLE
convergence over 16 large modules seeded from all 5.8M ground-truth cells does NOT complete
even at 12 GB / 900 s (confirmed — ran the full 900 s then was killed). The bottleneck is
the seed-everything-per-child design, so measuring the cone needs **GT-seed scoping** (seed
only the cluster's external reads — the scoped-subgraph #22/T-078 approach), NOT just more
resources. `EVAL_TIMEOUT_MS` is now configurable; standalone sheets re-baseline at
**99.94%** (1767/1768); the 17-sheet returns cluster is not yet measured.

**T-076 cold-probe diagnosis + NaN-guard.** The grid-sample NaN is **waterfall/convergence
fragility, NOT the override-convergence bug PR #37 fixes**: an override cold-starts the
cluster from 0 (`ctx.get → 0`), a waterfall/coverage formula divides by a not-yet-converged
0 → Inf/NaN, and the convergence loop had no finite-check so NaN was sticky (ran to
MAX_ITER, `converged:false`, poisoned values). PR #37's override lock pins the override
cell but does nothing about the OTHER cluster cells seeding from 0. Added a NaN-guard to
the convergence loop (`chunked_emitter.rs`): a non-finite cell is recorded
(`meta.nonFiniteCell`) and stops the loop with `converged:false` — the honest
non-convergence contract (refuse to lock on `converged:false`). Healthy clusters unchanged.
Full eager `run()` is infeasible on the 5.8M-cell model (confirmed — climbs past 3 GB with
no output), so the grid samples via the scoped/lazy path.

Posture unchanged: `MIPPY_LOCK_GRADE_CONFIRMED` stays unflipped / ADR-026 stays Proposed
until the cone is measured end-to-end and the no-fallback gate is green on the rebuilt real
engine. This wave closes both engine-side gaps; the remaining lock-grade work is the
cone-measurement resourcing (heap / GT-seed scoping) and regenerating the contract
(named-outputs) so the formal `--assert-no-fallbacks` gate runs on the rebuilt real engine.
Tests green: cargo 18/18, smoke 122/122, test:engine 21, test:runnable 20, test:lazy-engine
19, test:per-sheet-eval 10, npm test.

## 2026-05-31 — Wave 7 MEASURED: schedule semantics + dial/format + model-type labeling → **12/12 (first clean sweep)**

Re-ran the full hardened 12-persona journey after the Wave-7 wave. **pass/12: 8 → 12** — the
first time the whole panel clears the gate. avg A7 (woah) 3.83 → **4.08**, C5 (coder) 4.92 →
4.50, A5 (trust) 5.00 → 4.92 (gate floor A5≥4 held for all 12). **Flipped to PASS (+4):** the
exact four the wave targeted — `realestate-debt-cfo`, `infra-fund-director`, `corp-fpa-manager`,
`pe-buyout-associate`. No previously-passing persona regressed below the gate (a Source-normalized
regen-diff kept the 8 passing summaries byte-identical; only the 4 targets changed). One
`accuracyVerified=false` — `familyoffice-fof-ir` (still PASSES; A5=4 meets the floor) — is **not
a Wave 7 regression** (byte-identical to Wave 6, where it verified true); the auditor caught a
latent pre-existing manifest bug (FoF `residualValue` maps NAV to the wrong cell, ~15% high). The
remaining dimensions sitting at exactly 4 (A6/A7/C5 on the debt/credit family + saas) are now
polish — net-of-fee returns, a deal-name in the header, a name-keyed `run()` overload — not
correctness or labeling. The FoF NAV remap is the highest-priority next-wave fix. Three rolling commits, merged to `main` (read the live tip via
`git rev-parse --short origin/main`). Method: understand-map → rolling commits w/ per-commit
regen-diff → adversarial-review workflow (4 reviewers / 10 findings / 16 verified; all `fix-now`
items fixed before commit) → FF main → re-measure. Scoreboard + per-persona detail in
`tests/personas/BENCHMARKS.md` (Wave 7 / ¶). Measurement only — no code change in this entry.

The Wave 7 code is in the three entries below (originally logged as "code complete; measurement
pending"); this entry records the measured result.

### Wave 7 — schedule semantics, derived-dial suppression, model-type labeling (2026-05-31)

The four remaining persona fails (re-debt, infra, corp, pe-buyout). Four workstreams:

- **Schedule-aggregation semantics (flips re-debt).** A per-year RATIO series (debt yield, DSCR,
  LTV) is no longer SUM-aggregated — `collectNamedOutputs` infers the series unit and uses the
  terminal (exit) value with a `fraction`/`multiple` format, so a debt-yield headline reads
  `13.2%` not the fabricated `$1`. `detectSchedules` gained `coverage`/`debt_yield`/`ltv` types
  (ordered before `debt_balance`/`debt_service`); `debt_balance` (debt-gated) now matches a
  roll-forward "Facility/Closing/Ending Balance" row, so `outstandingDebt` binds the real
  $152.4M→$139.8M amortization series and `extract --type debt_balance` finds it. New per-year
  `dscrByYear`/`debtYieldByYear`/`ltvByYear` outputs; `freeCashFlow` no longer mis-binds the
  debt-yield row. `ete extract` reports a type-aware aggregate (Exit/Average/Total, never a
  summed ratio) and formats ratios as `x`/`%`, never `$` (a DSCR was printing `$2`); periods
  sort numerically so the terminal pick is the true last year.
- **Suppress backsolved dials + format outputs by unit (flips infra).** A `cap_rate_inverse`
  output formats as `fraction`, never `multiple` (killed the `0.09x` render); no phantom
  `exitMultiple` driver is minted on a yield cell; a named input whose own cell is a formula
  target is flagged `derived`; the INTEGRATION demo picks a non-derived, monotonic-positive
  lever (camelCase-aware, so `ExitYield`/`TaxRate`/`CostOfCapital` are demoted) — the worked
  what-if no longer shows returns falling as you raise a rate.
- **Model-type-aware labeling (flips corp + pe-buyout).** New `pe_buyout` type + `buyout` lens —
  a single-company LBO is distinguished from a `pe_fund` and shows `EBITDA` not "Platform
  EBITDA". A `corporate` model reads `Forecast: 2025–2029` (not "Exit: 2029") with a `P&L
  Summary` / `End` section. `summary` Source: shows the workbook basename, not a full path.
- **Scoped family levers.** infra `OpexEscalation` + `AnnualAmortization` (the debt principal
  row now reads the input cell), saas `GrossChurn`, re-debt `EntryLTV` — each verified to carry
  a non-empty `affectsOutputs`.

## 2026-05-31 — Wave 6 MEASURED: per-family headline blocks move the gate 7/12 → 8/12 (A5 perfect)

Re-ran the full hardened 12-persona journey after the Wave-6 headline/detection wave.
**pass/12: 7 → 8.** avg **A5 (trust) 4.58 → 5.00 — perfect across all 12** (every persona
converts AND its headline numbers tie out to ground truth; `accuracyVerified=true` ×12),
A7 3.75 → 3.83, C5 4.67 → **4.92**, **C4=true ×12**. Flipped to PASS: credit (Lender
headline + real $56M balance) and saas ("8.0x ARR" + split CAGR). corp (A7 3→4) and infra
(A4 3→4) lifted but still bind; pe-buyout slipped A4 4→3 on byte-identical output (judge
noise on the pre-existing `pe_fund`/"Segments"/"Platform EBITDA" labels). **No accuracy
regressions** — the closest defects are presentation/contract-shape, not wrong numbers.
Full board + the Wave-7 plan in `tests/personas/BENCHMARKS.md`. Measurement only — no code
change in this entry.

**Wave 7 (next, from the run synthesis — all three needed for 12/12):** (1) schedule-output
aggregation semantics — never SUM a ratio series; expose the per-year debt-balance/DSCR
series (flips re-debt, kills the fabricated `$1` freeCashFlow); (2) suppress derived/
backsolved cells as what-if dials + format yield outputs as `%` not `"0.09x"` (flips infra);
(3) model-type-aware labeling — `pe_buyout` vs `pe_fund`, corp budget lens ("Forecast" not
"Exit", P&L-led), drop "Platform"/"Segments" jargon (flips corp + pe-buyout). Plus the scoped
family levers (infra Opex/Amort, saas GrossChurn, re-debt EntryLTV).

## 2026-05-31 — Wave 6: adversarial-review fixes (SaaS "Revenue" mislabel + 5 robustness fixes)

A 4-dimension adversarial review (per-finding verified against a live persona) of the
Wave-6 headline diff surfaced one real bug and several latent fragilities; all fixed:
- **(major) SaaS "Revenue $45.0M" contradicted the Revenue segment row ($40.9M).** The
  operating line printed `s.ebitda` = Σ(revenue-typed rows) − Σ(expenses), which on a
  multi-row SaaS model (imperfect segment typing) overstates revenue. Relabeling it
  "Revenue" in the prior commit turned an ambiguous blend into a false claim. Fix: the
  SaaS lens shows **no operating line** — Revenue/Operating-Income are already segment
  rows and ARR is its own line. (growth-equity-vp's identical-but-redundant line also
  drops; its Recognized-Revenue segment row is unchanged.)
- **(regression) `three_statement` → corp lens** lost its headline (EV/Equity bind only
  for `corporate`; corp lens suppresses terminalValue). Fix: route only `corporate` to the
  corp lens — a 3-statement model keeps the default equity lens + its terminalValue.
- **(robustness) detectDebt guard over-rejected** legit dollar balances whose label
  contains "multiple"/"coverage" (multi-tranche / mezzanine). Fix: magnitude-gate the
  ratio rejection (only reject values < $1000 with a ratio-ish label) — also rejects a
  small "Exit Debt Yield" rate that shares the summary sheet with the real balance.
- **(robustness) SaaS arrEnding** could bind an "Ending ARR (target)" assumption row by
  iteration order. Fix: exclude target/assumption/plan/budget/goal labels.
- **(edge) infra net-only** vehicles would show an empty returns block. Fix: the infra
  block falls back to net IRR/MOIC when no gross/project return exists.
- **(nit) credit/fund** double blank line before the first headline block. Fix: skip the
  trailing blank when the prior line is already blank.

Regen diff vs the post-headline state = only the two SaaS-lens operating lines removed +
cosmetic blank collapses; no value changed, no debt line changed. All 12 verify 0-drift;
`npm test` 132/132 + 15/15.

## 2026-05-31 — Wave 6: infrastructure returns-led headline (Project IRR + Equity IRR/MOIC + DSCR)

Infra borrowed the real-estate lens → headline `@ 8.5% cap rate` + `Residual / Terminal
Value $492.9M`, while the metrics a project-finance director leads with were absent or
broken: **Project IRR (unlevered)** wasn't bound at all, **Equity MOIC** was unmapped
(Returns showed `MOIC —`), and DSCR was buried in a trailing Covenants line.
- **`lib/manifest.mjs`**: broaden the equity-MOIC matcher to capture "Equity Multiple
  (MOIC)" (net-guarded) so `grossMOIC` resolves to `Investor Summary!B16` (6.73x); add
  `projectIRR` detection gated to infrastructure (`Investor Summary!B12`, 11.1%).
- **`cli/commands/summary.mjs`**: new dedicated **`infra` lens** (split out of `realestate`)
  with a returns-led headline block — Project IRR (unlevered) / Equity IRR / Equity MOIC /
  DSCR coverage / Exit yield. The `@ cap rate` header suffix, the generic Gross/Net Returns
  table (with its wrong "net of carry" footnote), and the standalone Covenants line are all
  suppressed for the lens; Residual/Terminal Value now follows the returns.

infra now leads with `Project IRR 11.1% / Equity IRR 16.8% / Equity MOIC 6.73x / DSCR
1.95x · 1.35x / Exit yield 8.5%`. verify 0-drift (15 outputs). Regen diff = only the infra
persona; all others byte-identical. `npm test` green.

## 2026-05-31 — Wave 6: SaaS ARR headline — "x ARR" basis + split Revenue/ARR CAGR

SaaS-growth headlined `@ 8.0x Revenue` (the multiple is actually EV/ARR = 8.0 exact;
EV/Revenue = 8.84), and the operating line `Revenue / ARR … (CAGR 30.2%)` pinned **one**
CAGR to two metrics whose growth genuinely differs (revenue 30.2% vs ARR 39.3%). Fixes:
- **Data-driven exit basis** (`lib/manifest.mjs` `detectOutputs` + `summary.mjs` `exitBasis`):
  an "Exit ARR Multiple" label now tags the exit multiple `type: 'arr_multiple'`, and the
  header reads "x ARR" off the **type**, not the lens. Critically this leaves
  **growth-equity-vp** (same `saas` lens but priced EV/Revenue = 7.5x) reading "x Revenue"
  — no false "x ARR".
- **Split the CAGR** (`summary.mjs`): the operating line is relabeled "Revenue" (its CAGR is
  the revenue CAGR), and a separate **Ending ARR** line carries the true ARR figure + its own
  CAGR. The ARR cells (`arrEnding`, `arrCAGR`) are detected gated-to-`saas` as flat scalar
  outputs (resolved via the existing base-case passthrough). growth-equity, which tracks a
  real ARR bridge, correctly gains an accurate `Ending ARR $96.9M` line.

saas now: `@ 8.0x ARR` / `Revenue … (CAGR 30.2%)` / `Ending ARR $45.2M (CAGR 39.3%)`.
saas verify 0-drift. Regen diff = only the two saas-lens personas; all others byte-identical.
`npm test` green.

## 2026-05-31 — Wave 6: credit (direct-lending) lender headline + the "$2 debt at exit" bug

The lone accuracy fail (A5). Two defects, both fixed:
- **`Debt at exit: $2`** — `detectDebt` bound `debt.exitBalance` to `Lender IC Summary!B18`,
  the **"Exit Leverage (Debt/EBITDA)" RATIO cell** (1.79), because its label matches
  `/exit.*debt/`. Rendered "$2", a hard trust-kill for a lender. Meanwhile the real
  closing balance (`Borrower Credit!H5` ≈ $56M, label "Debt Balance — Closing ($)") was
  *missed* — the old pattern required "exit"/"loan" next to "balance". Fix (`lib/manifest.mjs`
  `detectDebt`): reject leverage/coverage/ratio-style labels, and broaden the match to
  `debt balance` / `closing balance` / `ending balance` so the roll-forward closing row is
  found. Credit now shows `Debt at exit: $56.0M`; re-debt (`$139.8M`) is unchanged.
- **Equity-shaped headline** — returns were correct (MOIC 1.62x, IRR 11.6%) but rendered
  as a generic Gross/Net table with a "net of carry not shown" footnote, and the header
  read `@ 1.8x EBITDA` (a buyout purchase-multiple framing). Fix (`cli/commands/summary.mjs`):
  a **Lender Returns** block for the credit lens — Yield to Lender (Gross IRR) / MOIC /
  Exit Leverage (Debt/EBITDA) — and the header drops the misleading `@ 1.8x EBITDA`
  (the leverage now lives in the block). `real_estate_debt` shares the credit lens but has
  no gross IRR/MOIC, so it skips the block and keeps its correct `@ 13.2% debt yield`.

credit verify 0-drift (8 outputs). Full-12 regen diff = exactly the credit + corp deltas,
all 7 passing personas byte-identical. `npm test` green.

## 2026-05-31 — Wave 6: corporate (FP&A / DCF) family — detection + EV/Equity headline

The corp-FP&A persona (operating plan + DCF) classified as `unknown` (every
`detectModelType` signal scored 0) → no family lens → its headline led with **"PV of
Terminal Value $510.5M"**, an intermediate discounting stub, while the **Enterprise Value
($667.4M) and Equity Value ($625.4M)** an FP&A/corp-dev manager actually leads with were
never even bound as outputs (`terminalValue` grabbed the "PV of Terminal Value" row by
iteration order). Fix, three parts:
- **`detectModelType`** (`lib/manifest.mjs`): new `corporate` family gated on **DCF-unique**
  tokens (`discounted cash flow` / `terminal value (gordon` / `gordon growth` +4; `wacc` /
  `cost of capital` +2; `operating plan` / `free cash flow` / `pv of …` +2). Deliberately
  NOT `enterprise value` / `equity value` / `gross profit` — those also appear in PE/M&A/
  SaaS exit summaries (a persona-safety scan confirmed the gated tokens are unique to the
  corp model; the M&A-sellside LBO, the other `unknown`, stays `unknown`).
- **`detectOutputs`** (`lib/manifest.mjs`): bind `enterpriseValue` + `equityValue`, **gated
  to `modelType === 'corporate'`** so the other 11 families' contracts are byte-identical.
- **summary** (`cli/commands/summary.mjs`): new `corp` lens → headline block (Enterprise
  Value / Equity Value / WACC), generic terminal-value line suppressed for the lens, the
  operating EBITDA line relabeled "Operating EBITDA".

corp now: `Model: model (corporate)` → `Enterprise Value $667.4M / Equity Value $625.4M /
WACC 9.2%`. `ete verify` 0-drift (5 outputs). `test-model-type.mjs` +2 assertions (corp
classifies; ma-sellside NOT misread as corporate); full `npm test` green (132/132 + 15/15).

## 2026-05-30 — Wave 6 (start): clean model name in the summary header (drop the absolute path)

The summary/INTEGRATION header printed the **full absolute workbook path** as the model
name (`Model: C:\Users\…\engines\_personas\pe-buyout-associate\model`) — a recurring
"looks leaky/unfinished" trust dent in nearly every persona's A2/A7 notes from the Wave-5
journey. Root cause: `lib/manifest.mjs` set `model.name = options.source.replace(/\.xlsx?$/,'')`,
and `options.source` is the resolved ABSOLUTE path, so stripping only the extension left the
whole path. Fix: `model.name = basename(options.source)` without extension (handles `\` and
`/` on win32); `model.source` keeps the full path for provenance. Now `Model: model (pe_fund)`;
real workbooks (`Project Meridian LBO.xlsx`) get a genuinely good name. No math change; all 12
re-init clean, full `npm test` green. First Wave-6 item (cheap cross-cutting A2/A7 win);
per-family headline blocks + more levers still to come.

## 2026-05-30 — Wave 5 measured: the five Phase-0 fixes move the gate 1/12 → 7/12

Re-ran the full hardened 12-persona journey after shipping all five Phase-0 fixes.
**pass/12: 1 → 7.** avg A5 (trust) 4.42→4.58, A7 (woah) 3.00→3.75, C5 (coder) 4.00→4.67;
**C4=true for all 12** (every coding-agent integration ran, tied to base case, moved a
lever). Newly passing (+6): pe-buyout, vc-fund, re-valueadd, ma-sellside, searchfund,
familyoffice-fof (growth-equity held). Still failing (5): credit [A5 — needs a credit
HEADLINE not just label], infra [A4,A6,A7], saas [A4,A6,A7], re-debt [A6,A7], corp-fpa
[A4,A7 — still `unknown` type]. Next-wave ROI (per the run's synthesis): per-family
headline blocks > more levers per family > saas "x ARR" label > corp three_statement
detection + clean model name. Full detail in `tests/personas/BENCHMARKS.md` (board + a
code-recomputed gate match all 12 personas; data internally consistent). No code
change in this entry — measurement only.

## 2026-05-30 — Phase 0 fix #3: collapse duplicate-cell levers (inert-slider fix)

The #1 cause of "dead slider" A6 complaints: a workbook defined name (`ExitCapRate`,
`ExitMultiple`, `ExitYield`, `ExitRevenueMultiple`) and a manifest-driver (`exitMultiple`)
often resolve to the SAME input cell. `collectNamedInputs` guarded driver insertion by KEY
NAME (`!result.exitMultiple`), not by cell, so BOTH landed in `named-inputs.json` — and
because `affectsOutputs` is computed per input *name*, the human-named lever showed
`affectsOutputs: []` while a cryptic `exitMultiple` twin held the real closure. The analyst's
actual slider ("Exit Cap Rate") looked inert. Affected 6 of 12 personas (incl. pe-buyout).

Fix (`lib/manifest-maps.mjs`): new exported `dedupeInputsByCell()`, run in `emitManifestMaps`
AFTER closures are baked, collapses entries sharing a `cell` into one — keeping the
defined-name identity (+ excelName) but carrying the UNION of `affectsOutputs` and the richer
format/min/max/step, tagged `mergedFrom` for audit. Result: re-valueadd `ExitCapRate` aff 0→5,
infra `ExitYield` 0→6, pe-buyout/ma/searchfund `ExitMultiple` 0→4/5, growth `ExitRevenueMultiple`
0→4; re-debt correctly NOT merged (its two exit levers are genuinely different cells). No more
duplicate-cell levers across any persona. New `tests/cli/test-dedupe-inputs.mjs` (10 assertions)
wired into `npm test`; full suite green.

## 2026-05-30 — Phase 0 fix #4: asset-class detection (correct headline labels — most serious A5 class)

The root of the model-type accuracy failures (right number, wrong asset-class label).
`detectModelType` knew only 7 types, so credit/search-fund/FoF/infra/RE-debt fell through
to `saas` or `re_fund` and the summary mislabeled headlines: credit "Exit @ 1.8x **Revenue**"
(it's exit leverage), search "@ 5.5x **Revenue**" (EBITDA/SDE), RE-debt "@ 13.2% **cap rate**"
(it's a debt yield, NOI/loan). A contributing substring bug: a bare `/arr/` matched
"c**arr**ied"/"c**arr**y"/"**arr**angement", which is *why* credit & search-fund read as SaaS.

Fix (two coordinated changes, no engine/tool behavior change):
- `lib/manifest.mjs`: add `credit`, `fund_of_funds`, `search_fund`, `infrastructure`,
  `real_estate_debt` to MODEL_TYPES + detectModelType (lender/fund/SDE/CFADS/debt-yield
  signals); tighten `/arr/`→`/\barr\b/` (+ `\bmrr\b`, `\bcac\b`); boost real_estate_debt by
  re_fund so it wins over plain RE.
- `cli/commands/summary.mjs`: detectLens maps the new types (credit + real_estate_debt →
  credit lens; fund_of_funds → fund; infrastructure → realestate); a `cap_rate_inverse`
  exit reads "debt yield" under the credit lens; `exitBasis` returns EBITDA for credit.

Result: all 12 personas classify correctly (credit→1.8x EBITDA, search→5.5x EBITDA,
RE-debt→13.2% debt yield); pe_fund/saas/venture_portfolio/re_fund unchanged (no regression;
corp/ma stay `unknown`→equity lens, not a wrong label). New `tests/cli/test-model-type.mjs`
(10 assertions incl. regression + substring-bug guards), wired into `npm test`. Full suite green.

## 2026-05-30 — Phase 0 fix #5: dir-commands auto-resolve chunked/ (first-command dead-end)

A non-technical analyst following GETTING_STARTED (whose examples point at `./my-model/`)
hit `Error: Ground truth not found` on the very FIRST command, because `ete summary
<dir>` (and pnl/scenario/sensitivity/compare/carry/extract/explain/query) required
`<dir>/chunked/` while `verify` already auto-resolved it. Root cause: `loadManifest`
probed `chunked/` but `loadGroundTruth` resolved the manifest's relative
`./_ground-truth.json` only against the passed dir.

Fix (`lib/manifest.mjs`, one place → all consumers): `loadGroundTruth` now mirrors
`loadManifest`'s `chunked/` fallback, and both errors carry a remediation hint. Added a
`resolveModelDir()` helper for callers that need the resolved dir directly. `ete summary
engines/.../pe-buyout-associate/` now works (was the documented dead-end); chunked/ still
works; bogus dirs exit non-zero with a clear message. New `test-onboarding.mjs` assertions
lock both forms (15/15). Full `npm test` green.

## 2026-05-30 — Phase 0 fix #2: headline returns are LIVE (static-literal IRR → real =IRR())

The #1 A6 ("what-if expressiveness") binder: `grossIRR`/`netIRR`/`tvpi`/`dpi`/`MOIC`
shipped as **static literal cells** in three personas, so no lever moved them — the
"what-if explorer" had no working dial on the numbers that matter. Root cause was
generator-side, not engine-side: the transpiler + engine already support live IRR
(`transpiler.rs` emits `computeIRR`/`computeXIRR`; every engine ships `_helpers.mjs`
with them), but the generators pinned IRR via a `value*1` identity with an outdated
"IRR has no closed-form cell-formula" comment.

Rewrote the three generators to use **real `=IRR()` over a live cash-flow row**, the
way an actual fund model does:
- **vc-fund-partner**: distributions now reference realized portfolio proceeds;
  `=IRR(Cashflows!B5:I5)`; new **`TopCompanyExit`** power-law lever → grossIRR
  0.112→0.162, MOIC 1.82→2.16, TVPI 1.62→1.90, DPI 1.52→1.80 (all were STATIC).
- **infra-fund-director**: equity cash-flow vector on one row; `grossIRR`=`IRR(...)`,
  `MOIC`=`SUM(...)/-entry`; driven by existing RevenueEscalation/ExitYield/InterestRate
  → grossIRR 0.168→0.198.
- **familyoffice-fof-ir**: added a "Net CF to LP (incl. residual NAV)" row; blended
  `IRR()` over it; new **`TopFundNAV`** mark lever → grossIRR 0.155→0.172, netIRR
  0.137→0.154, TVPI 2.03→2.16, RVPI 0.11→0.20. (DPI correctly stays NAV-independent.)

All 12 personas re-verify **0-drift**; full `npm test` green. No tool/engine changes —
purely making the synthetic models realistic so their headline returns are live.

## 2026-05-30 — Phase 0 fix #1: schedule outputs carry a scalar cell (kills false "contract may be stale")

The full 12-persona re-baseline (see BENCHMARKS.md) showed trust ROSE (avg A5 4.42)
but the gate cratered to 1/12 on **A6/A7 (handoff readiness + confidence)**. The #1
binder: schedule-type named outputs (`outstandingDebt`, `equityBase`, …) carried
`cellRange` + `perYear` + `baseCaseValue` but **no scalar `cell`**, so the generated
`example.mjs` read `values[undefined]` and printed the false **"N output(s) drifted —
contract may be stale"** — the exact trust signal the docs tell users to require before
handoff. Meanwhile `ete verify` *skipped* schedules entirely, so the two trust checks
disagreed.

Fix (3 coordinated edits, additive to the contract):
- `lib/manifest-maps.mjs`: a **balance** schedule now also emits `cell` = the last
  populated cell of its range (the terminal level it already reports as `baseCaseValue`).
  Flows (aggregation `sum`) keep no scalar cell. Closure-baking expands `cellRange` AND
  `cell` so the dependency closure still spans every year.
- `lib/verify-engine.mjs` + generated `example.mjs`: a shared `resolveOutput()` helper
  resolves any output to one number — scalar cell, balance terminal cell, or summed flow
  range — so `verify` and `example.mjs` finally agree and schedules are checked, not skipped.
- `INTEGRATION.md`: outputs table renders `cell || cellRange` (+ `(terminal)`/`(sum)` tag)
  instead of `undefined`; the 30-second snippet picks a scalar-cell output.

Result: `ete verify` on pe-buyout now checks **10 (was 8), 0 drift**; `example.mjs` prints
"(all outputs match baseCaseValue ✓)" with schedules showing real values, and the what-if
shows `outstandingDebt $63.0M → $66.0M` *moving* (lifts A6 too). All 12 personas re-verify
0-drift; full `npm test` green (lib 43, cli 34, manifest-maps 78, ship-ready 102, use-case
132, onboarding 13, + the rest). Contract change is additive — safe for Mippy.

## 2026-05-30 — Hard-wave kickoff: training-dataset capture + benchmark prep runner

Start of the "hard wave" (harder synthetic models + lock-grade engine). Two durable
pieces landed first, both regenerable (tooling committed, output gitignored):

- **Training-dataset capture** (`tools/capture-dataset.mjs`): snapshots every
  conversion as a verified `(input.xlsx → surface.json → target/manifest+contract →
  engine/)` triple with provenance + drift verdict, appending to `dataset/index.jsonl`.
  Makes assembling a fine-tune dataset a free side-effect of conversion — the model is
  a commodity; the verified spreadsheet→mapping dataset is the durable asset.
- **Persona benchmark prep runner** (`tests/personas/run-prep.mjs`): generates all 12
  synthetic models, runs `ete init` + `ete verify`, captures each into the dataset —
  the deterministic (non-LLM) half of a benchmark round. Emits
  `tests/personas/prep-report.json`. Current status: **12/12 clean conversions, 0 drift.**

## 2026-05-29 — Analyst usability Waves 3–4 + capstone

Wave 3 (family-aware coverage, doctor-by-type, self-refreshing `manifest set`,
input-metadata fixes, `outputs.*` promotion, delta-cascade honesty guard) and
Wave 4 (exit-value labeled by its real cell, Net-dash explainer, doctor
reconciliation) closed the residual A5-trust cap. Across the simulation rounds:
benchmark 2/12 → 3/12 passing, avg "woah" 3.50→4.00, avg trust 3.1→3.5, and
coding-agent handoff mostly perfect.

**Capstone (the exact acceptance scenario) PASSED, all 5/5 both sides:** a
non-technical PE associate's assistant converted the LBO ("…every headline ties
out exactly… ready to hand your developer"), and a fresh coding agent built a
real, dependency-free LP what-if web app from the bundle alone, with a headless
smoke test that ties out ("…a live LP what-if explorer wired straight to the
contract in minutes… every lever pushes the outputs the right way"). See
`ANALYST_UX_REPORT.md`. Follow-ups: INTEGRATION.md documents the browser-serve +
Node `file://` import caveats; README lists `ete verify`.

## 2026-05-29 — Analyst usability Wave 2 (model-family awareness)

Driven by a 12-persona simulation (synthetic models across PE/VC/RE/infra/credit/
corp/SaaS/FoF/search × skill × seniority, each run through the full
journey + coding-agent handoff and scored on `tests/personas/lib/rubric.md`).
Wave-1 baseline was **2/12** personas passing the benchmark gate; the tool was
PE-buyout-centric and lost trust (summary A5 mostly 2-3) and contract
completeness (C3/C4/C5 low) for every other asset class. Wave 2 makes it
family-aware.

### Contract (`lib/manifest-maps.mjs`, `lib/integration-doc.mjs`)
- `named-outputs.json` now emits `manifest.fundLevel` (TVPI/DPI/RVPI/netIRR/
  distributed/paidIn/...) + `covenants[]` (DSCR/LTV/ICR/...) + debt details — the
  headline numbers for VC/FoF/credit/debt finally cross into the contract.
- `named-inputs.json` gains `format` + suggested `min`/`max`/`step` per lever
  (the universal handoff ask). Value-aware format inference (a bare value in
  (-1,1) is a rate). `inferFormat` learns tvpi/dpi/rvpi/dscr/leverage→multiple,
  ltv/yield/growth/margin→fraction, arr/fund/nav→currency.
- **Closures preserved across re-emits** — `manifest set`/`maps`/`--reuse-parse`
  no longer silently drop `dependsOnNamedInputs`/`affectsOutputs` once the
  dependency graph is slimmed away.
- `example.mjs` uses the same tolerance as `ete verify` (no false DRIFT on
  rounded base values). INTEGRATION.md tables add labels, input format/range,
  static-output + override-by-cell notes. `humanize` handles acronym runs.

### Summary (`cli/commands/summary.mjs`)
- Model-family **lens** (fund / credit / realestate / saas / equity): renders a
  Fund (LP) metrics block, a Covenants block, cap-rate + Exit Value, or ARR
  basis — instead of forcing a PE frame. Exit line shows the real basis
  (`@ 12.0x EBITDA` / `Revenue` / `NOI` / `5.25% cap rate`). No more fabricated
  "Platform EBITDA" on non-PE models. Returns block resolves class-prefixed keys.
  Segments table drops ratio rows. Hold period = period count (consistent with
  the year range).

### Doctor / refresh / checklist (`cli/commands/manifest.mjs`, `lib/manifest.mjs`)
- Doctor validates `outputs.exitMultiple` by **type**: a cap-rate / exit-yield is
  checked against [1%,30%], not [1,50] — no more false error + quarantine on
  clean RE/infra models.
- `ete manifest set` propagates a fix into the full contract + handoff bundle
  (closures preserved), so the developer artifacts never lag a correction —
  resolves the "fix never reaches the bundle / re-init wipes it" catch-22.
- Review checklist is model-family aware (no "add EBITDA/equity" nag for
  funds/SaaS/credit/RE).

## 2026-05-29 — Analyst onboarding + coding-agent handoff (Wave 1)

Reframes the toolkit around a non-technical finance user who wants to convert
their Excel model — often to "build a web app for my LPs" — working through an AI
assistant. Two halves: make the human on-ramp obvious, and make the developer
handoff bundle so clear a coding agent can build from it immediately. Driven by
running realistic synthetic models through the full pipeline and watching where
trust breaks.

### Coding-agent handoff bundle (emitted by `ete init`)
- New `lib/integration-doc.mjs` → `chunked/INTEGRATION.md` (a guide tailored to
  the specific model: `run()` API, input/output tables with base-case values,
  a web-app wiring sketch) + a runnable `chunked/example.mjs` (base case + a real
  what-if, with an automatic base-case drift check).
- New `lib/verify-engine.mjs` (`verifyEngine`) — confirms `engine.run()`
  reproduces the spreadsheet's base case for every named output.

### Detector accuracy (trust at first glance)
- **Periodicity** no longer mislabels a normal 5–7-year model as "monthly" (the
  year-header detector only ever sees integer years → annual by construction).
- **Exit multiple** prefers an *Exit*-labeled cell over the *Entry* one (was
  first-match, usually grabbing entry); EBITDA-row detection skips
  "… EBITDA Multiple / per share / margin" labels.
- **Carry total** prefers a dollar-magnitude cell over the carry-*rate* fraction
  (a "GP Carried Interest" = 0.20 assumption no longer masquerades as the total).
  `ete manifest doctor` now flags a carry total that resolves to a fraction.

### Onboarding (human + agent)
- `README.md` rewritten to lead with the analyst + AI-assistant journey; Rust /
  `cargo` moved to a one-time "manual setup" section behind `npm run build:parser`.
- New `GETTING_STARTED.md` — the guided "walk me through it" companion with
  copy-paste prompts and a "build a web app" handoff section.
- `skill/SKILL.md` gains a **Guided onboarding** play (setup → convert →
  sanity-check WITH the user → verify fidelity → hand off) + an engine-fidelity /
  `run()` contract note documenting the intra-sheet *staircase* limitation and
  the standard column=time, row=metric layout that avoids it. `CLAUDE.md` points
  to it.
- `scripts/check-env.mjs` rewritten: cross-platform (Windows `where` + `.exe`),
  separates REQUIRED (Node, parser, deps) from OPTIONAL (eval, API key), prints
  exact next-step commands. New `npm run build:parser`. Friendlier
  "parser not found" error in `ete init`.

### Tests / harness
- `tests/personas/lib/model-builder.mjs` — synthetic `.xlsx` factory (bakes in
  the SheetJS-ESM buffer-write gotcha and formula↔cached-value consistency) +
  a realistic PE-buyout reference generator. The basis for persona usability
  testing.
- `tests/cli/test-onboarding.mjs` (11 assertions) wired into `npm test`: detector
  fixes + bundle emission + `node example.mjs` + engine base-case fidelity.
## 2026-05-29 — Compact dependency graph + streamed module writer: `ete init` completes on the real models (#32, #33)

With the #22 scaling walls closed, the **Rust parser** finished on the real
models — but a full `ete init` (parser + JS manifest pipeline) still could not.
Two follow-ups surfaced by regenerating the gitignored Outpost A-1/A-2 engines,
now fixed; a clean `ete init` runs end-to-end and the contract maps land.

- **#32 — compact dependency graph (was 37 GB / 7 min → ~0.5 GB).** The
  cell-level `dependency-graph.json` expanded every range to its interior cells:
  `SUM(A1:A1000)` became 1000 edge strings. On A-1 that was **37 GB / ~7 min**,
  and `ete init`'s closure-baking step then `JSON.parse`d it back into Node →
  guaranteed OOM. The emitter now keeps ranges as **compact tokens**
  (`Sheet!A1:B10`) via a new `extract_refs_ranges` / `RangeMode::Keep`
  (`dependency.rs`, `chunked_emitter.rs`); the graph is **504 MB (A-1) / 532 MB
  (A-2)** — ~70× smaller — and parses without OOM. Schema bumped to
  `cell-dependency-edges-v2`.
- **#32 — newline-delimited graph + streaming loader (the >512 MiB string cap).**
  Even at ~0.5 GB the graph still broke `readFileSync(path,'utf-8')`: Node caps a
  *string* at ~512 MiB, so the 532 MB A-2 graph threw "Cannot create a string
  longer than 0x1fffffe8 characters" — caught and silently skipped, so the
  closures never baked. The emitter now writes **one edge per line** (still valid
  JSON), and `loadDependencyEdges` (`lib/manifest-maps.mjs`) reads it in 64 MB
  chunks with a `StringDecoder`, `JSON.parse`-ing each small line — no >512 MiB
  string ever exists. Tested on both the whole-file and forced-streaming paths.
- **#32 — range-aware closure BFS + range-token dedup (`lib/manifest-maps.mjs`).**
  The two consumers (`dependsOnNamedInputs`/`affectsOutputs` closures + the `_fn`
  fallback audit) expand a range token **lazily** against three column-indexed
  structures (formula-cell keys, named-input cells, fallback cells) with
  binary-search interval queries — identical closures, no materialization, graph
  read once, both consumers in one pass (`computeOutputClosures`). Crucially, each
  output's BFS expands a given range token **once** (`seenRanges`): on A-1 the
  3.7M range refs collapse to ~1M distinct tokens, and expanding with repeats
  touches **2.8 billion** cells vs **34 million** distinct — the ~84× blowup that
  made the per-output closure pass take ~15 min; it's now ~2.6 min. New
  `extract_refs_ranges` Rust test + closure-through-a-range + streaming-loader
  tests.
- **#32 — `ete init` heap guard (`cli/index.mjs`).** Baking closures on a
  ~6M-cell model peaks at ~7.4 GB (graph + ground truth + indexes + BFS), over
  Node's ~4 GB default — and 8 GB left no margin. `init` now re-execs itself once
  with a **12 GB** old-space (`--max-old-space-size`, gated to `init`, opt out
  `ETE_NO_REEXEC=1`, size `ETE_INIT_HEAP_MB`) so a consumer never has to know to
  pass `NODE_OPTIONS`.
- **Slimming keeps `_graph.json` (`cli/commands/init.mjs`).** The default slim
  dropped the 3 KB sheet-level `_graph.json` claiming nothing read it — but
  `eval/per-sheet-eval.mjs` reads it for circular-cluster membership, so the
  benchmark was silently mis-scoring cluster sheets. Only the ~0.5 GB
  `dependency-graph.json` is slimmed now.
- **#33 — streamed sheet-module writer (`chunked_emitter.rs`).**
  `generate_sheet_module` built a `Vec<String>` of every line then `.join("\n")`
  — for a monster sheet (PP&E ~190 MB of JS) that held the line vector *and* the
  joined string at once (~2× transiently). `write_sheet_module<W: Write>` now
  streams each line straight to the file's buffered writer; live memory is one
  transpiled cell expression plus the writer buffer, regardless of module size.
  Emit peak on the real build stays ~2.4 GB. Output is byte-identical.
- **#33 — cone-shrinking deferred (documented).** The other #33 direction —
  shrinking the `--lazy-engine` returns cone — needs **cluster-breaking**: the
  returns sit in a 17-of-20-sheet circular cluster that loads atomically (incl.
  all 3 monster modules), so row-chunking alone can't shrink it (the issue's own
  analysis). That's correctness-sensitive and coupled to cluster-once eval; left
  as a tracked follow-up rather than risk the eager engine Mippy consumes.
- New `scripts/verify-contract.mjs` — asserts a built `chunked/` satisfies the
  Mippy consumer contract (layout complete + `contentHash`, `engine.js` parses +
  exports `run`, value cells pinned with real base-case values, closures baked,
  fallback audit ran) without running the full engine.
- **Regenerated A-1 + A-2 (clean full `ete init`, ~21 min each).** Both pass
  `verify-contract` — **closures baked 17/17 (A-1) and 18/18 (A-2)** (the A-2
  539 MB graph was the exact case that previously dropped all closures via the
  string cap). Live-recompute accuracy on the standalone sheets is **98.0% (A-1)
  / 97.8% (A-2)** — up from the 84.3% / 85.5% baseline (the prior baseline was
  measured on an older build; same sheets, more cells match). The 17-sheet
  cluster + 190 MB PP&E sheet remain skipped (cluster-once / large-sheet eval).
  `golden-master --assert-no-fallbacks` pinpoints the returns' transpiler debt to
  **4 functions** — `XNPV`, `FILTER`, `MINIFS`, `MAXIFS` — a concrete coverage
  target list (replaces the vague "11,813 fallbacks" for the return path).
- Validated: `cargo test` 18/18, `smoke` 78/78, `test-manifest-maps` 78/78 (incl.
  the streaming-loader path), `test:engine`/`test:runnable`/`test:depgraph`/
  `test:lazy-engine`/`test:slimming`/`test:golden` 21/20/14/19/13/20, full
  `npm test`, and a clean full `ete init` on real A-1 + A-2 (build perf + accuracy
  in `benchmarks/BASELINE.md`; Mippy contract checked by
  `scripts/verify-contract.mjs`).

## 2026-05-29 — Chunked-build scaling walls: streamed emit, borrowed partitions, opt-in lazy engine (#22)

With the partition-hang fixed, a clean `ete init` on the real models got *past*
partitioning but then drove the parser past 18 GB in the module-emit step (and a
complete build was still slow to *run* as an oracle). Three walls closed — two
internal memory fixes done unconditionally, one opt-in runtime feature.

- **Wall C — streamed module emit (`chunked_emitter.rs`).** The emit did
  `partitions.par_iter().map(generate_sheet_module).collect()` and wrote in a
  *second* pass — holding **all ~800 MB** of generated JS in memory at once (on
  top of the multi-million-cell workbook), with nothing in `sheets/` until every
  module finished. It now **writes each module the instant it's generated and
  drops the string**; the few "heavy" sheets (≥200k formula cells) are emitted
  one-at-a-time (peak ≈ one big module) while the many light sheets stay parallel.
  Files land incrementally; a write failure is still fatal.
- **Wall B — `SheetPartition` borrows cells instead of cloning
  (`sheet_partition.rs`).** `partition_sheets` did `cell.clone()` into the
  partition while `workbook.sheets` still held the originals — a full second copy
  of ~6M `CellData` (addresses + values + formula strings) → peak-memory doubling.
  `SheetPartition<'a>` now holds `Vec<&'a CellData>` (the workbook outlives every
  partition), so the partition is a few pointers per cell. The four consumers are
  read-only, so they're unchanged beyond the borrow.
- **Wall A — opt-in `--lazy-engine` (`chunked_emitter.rs`, `main.rs`,
  `cli/`).** The default `engine.js` statically imports every sheet module, so
  `import('engine.js')` pulls ~800 MB into the heap before `run()` can be called.
  `ete init --lazy-engine` (parser `--lazy-engine`) now emits a lazy orchestrator:
  sheet modules load on demand via `export async function load(options)` (with
  **output-cone scoping** — `load({ sheets })` / `load({ cells })` loads only the
  requested sheets' transitive dependency closure, expanding whole clusters), a
  synchronous `run()` guarded against being called before any load, and
  `runScoped(inputs, options)` (load + run in one await). **The default engine is
  unchanged** — it stays eager + synchronous, so the Mippy contract, `ete eval`,
  the smoke test, and the engine suite are untouched. The eager and lazy engines
  share the `run()` body via `emit_run_function`, so they can't drift.
- New `npm run test:lazy-engine` (19) + CI step: asserts the lazy engine has no
  static sheet imports, exports `run`/`load`/`runScoped`, throws before load,
  matches the eager engine's `run()` output after load (base + cross-sheet
  override), and that cone scoping loads only the closure.
- Validated: `cargo build --release`, `cargo test` 17/17, `smoke` 78/78,
  `test:engine` 21/21, `test:runnable` 20/20, `test:depgraph` 11/11,
  `test:lazy-engine` 19/19, `test:slimming` 13/13, `test:golden` 20/20, full
  `npm test`, and an `ete init --lazy-engine` end-to-end build.
- **Residual (deeper, deferred):** `generate_sheet_module` builds a `Vec<String>`
  of lines then `.join("\n")` — ~2× a monster module transiently; and even one
  ~200 MB monster module is heavy to import. Row-chunking the monster sheets
  (Owned_Asset_PP_E, Future_Owned_Acquisitions, Technology) into smaller lazy
  modules is the next step to make them usable, not just emittable.

## 2026-05-29 — Fix chunked-build hang in `partition_sheets` (range-expansion blowup)

A clean `ete init` on the full real models hung for ~12h in the chunked emitter,
right after `[chunked] Partitioning N sheets...`. Root cause: a Round-2
regression in dependency extraction, not the dependency-graph step that P1 (#23)
fixed.

- **`partition_sheets` no longer expands ranges (`sheet_partition.rs`,
  `dependency.rs`).** It needs only sheet-level edges (which *other sheets* each
  formula references), but it called the range-expanding `extract_refs`, which —
  after Round 2 taught `is_cell_ref` to accept ranges — exploded every range to
  ≤1000 individual cell strings per formula, pushed and de-duped them, then
  discarded all the same-sheet ones. On a 1.62M-formula sheet that's ~10⁹
  throwaway allocations on a single core → swap thrash → the 12h stall. New
  `collect_sheet_deps()` scans for `Name!` / `'Sheet Name'!` tokens and records
  just the sheet name — no range expansion, no per-cell allocation. A synthetic
  parity test measures **~2000× faster** on range-heavy formulas.
- **Intra-sheet cycle detection no longer expands ranges either
  (`chunked_emitter.rs`).** `detect_intra_sheet_cycles` would have been the *next*
  wall in the sheet-module phase for the same reason. It now uses a new
  `extract_refs_shallow()` (top-left endpoint only) — restoring the pre-Round-2
  behaviour the known-good engines were built with, and avoiding spurious
  self-cycles from `B10=SUM(B1:B10)`-style ranges.
- **The dependency-graph contract is untouched.** `write_dependency_graph` still
  uses the full range-expanding `extract_refs`, so `dependency-graph.json` /
  the `affectsOutputs` / `dependsOnNamedInputs` closures remain complete
  (`test:depgraph` 11/11). The fix is behaviour-preserving for the sheet
  dependency set (parity test) and for engine accuracy (smoke 78/78,
  `test:engine` 21/21 incl. cluster convergence).
- Validated: `cargo test` 17/17, `smoke` 78/78, `test:depgraph`/`test:runnable`/
  `test:engine` 11/20/21, full `npm test`.
- **Still open (not the cause of this hang):** the partition step still
  `clone()`s every cell (peak-memory doubling) and the generated `engine.js`
  eagerly imports ~800 MB of sheet modules (load-time wall) — both are scaling
  ceilings for actually *running* the oracle, tracked under #22 (output-cone
  scoping) / lazy sheet loading.

## 2026-05-29 — Golden-master CI gate + P2 follow-ups (schedules, drivers, refiner)

Trustworthiness pass on the P2 contract: a golden-master CI assert plus the three
follow-ups the P2 work left open.

- **Golden-master gate (`eval/golden-master.mjs` + `npm run test:golden`, CI step).**
  A post-build assert for the named-outputs contract. `--assert-no-fallbacks`
  fails if any **return / value-bearing** output (`moic|irr|carry|mip|proceeds|
  hurdle|…`) carries `resolvesThroughFallback` (i.e. its closure passes through an
  `_fn` stub); `--canonical <file>` diffs every named output's `baseCaseValue`
  against a canonical returns map to **full float precision** (`Object.is`, with an
  optional `--epsilon` relative tolerance). CI exercises the mechanism on a
  **synthetic committed fixture** (`tests/cli/fixtures/golden-master/`); the real
  per-model figures stay **gitignored** (never committed to this public repo) and
  are diffed only when `ETE_GOLDEN_DIR` (+ a gitignored `canonical-returns.json`)
  points at a real build. New `tests/cli/test-golden-master.mjs` (20). Graceful
  skip (exit 0) when the model/artifacts/canonical file are absent, so public CI
  passes without the proprietary data.
- **Refiner: canonical returns outrank "UW Comparison" (`cli/commands/manifest-refine.mjs`).**
  `SUMMARY_SHEET_PATTERN` lumped an underwriting "UW Comparison" tab into the top
  tier, so returns (Gross/Net MOIC & IRR) mis-mapped to *projected* figures instead
  of the model owner's actuals. New `refineSheetTier` ranks **canonical actuals
  (Version Tracker / Track Record) → summary → rollup → underwriting → operational**,
  so #25's value cells pin to the canonical tab without per-model pinning. Documented
  the durable invariant trip-wire in `skill/SKILL.md`. Regression tests added (the
  ranking + the invariant); existing single-sheet "UW" bindings are unaffected
  (tier only breaks cross-sheet ties).
- **Schedule `baseCaseValue` no longer sums balances across years (`lib/manifest-maps.mjs`).**
  A schedule's scalar was a blind cross-year sum — correct for flows
  (distributions, cash flow) but meaningless for **balances** (debt outstanding,
  equity base/NAV), which double-counted a point-in-time level. Schedules are now
  classified: balances use the **terminal** (last-year) level with `terminalYear`,
  flows keep the life-to-date **sum**, and each entry records which via a new
  `aggregation: "sum"|"terminal"` field. An empty series yields `null` (honest),
  not a spurious `0`. `perYear[]` remains authoritative.
- **Driver named-inputs emit under `--reuse-parse` without the workbook.** The
  manifest-driver inputs (`exitMultiple` / `exitYearSelector` / `hurdleRate`)
  derive from the manifest + ground truth alone, but `emitManifestMaps` only built
  `named-inputs.json` when a workbook was present, dropping the drivers when the
  `.xlsx` wasn't reachable. It now always resolves them (the defined-name scan is
  still skipped without the workbook). `named-outputs`/`cell-types`/drivers all
  emit; only the defined-name inputs need the `.xlsx`.
- **Tests.** `npm test` green (full JS suite); new golden-master suite + refiner
  and schedule regressions. CI gains a dedicated **Golden-master gate** step
  (ubuntu + windows).

## 2026-05-29 — P2 (#25 + #26): time-series schedules, drivable inputs, fallback audit

- **Schedules and distributions (Request A & B)**: pin per-year time-series outputs as schedules inside `named-outputs.json` — `distributionsToEquity`, `outstandingDebt`, `equityBase`, `freeCashFlow`, and per-class distribution arrays (`classes[].distributions`), gated on `manifest.timeline.columnMap`. Each schedule entry carries a `cellRange` + `perYear: [{year,value}]`. `expandRange()` expands `Sheet!C15:K15` to its constituent cells so schedules participate in the dependency closures (`dependsOnNamedInputs` / `affectsOutputs`). (Note: a schedule's scalar `baseCaseValue` is a sum across years — meaningful for flows, less so for balances; `perYear` is authoritative.)
- **Drivable named inputs (Request C)**: pin `exitMultiple`, `exitYearSelector`, and `hurdleRate` into `named-inputs.json` (`source: manifest-driver`) so downstream models can sweep exit/return parameters. Pinned in the normal `ete init` path (the `.xlsx` is present); under `--reuse-parse` without the workbook they are currently skipped (follow-up).
- **Fallback audit + correctness gate (Request D / #26)**: emit `_fn-fallbacks.json` (cell → unsupported function) by scanning the generated sheet modules, and flag every named output/schedule whose dependency closure passes through a stub. The audit **reports, it does not silently gate**: affected outputs are annotated with `resolvesThroughFallback` and listed in `stats.fallbackViolations`; `ete init` prints a warning by default and **hard-fails under `--assert-no-fallbacks`** (CI / golden-master gate). Review-hardening fix: the gate originally `throw`ew mid-emit, which `ete init`'s try/catch swallowed — silently dropping the entire contract (named-outputs/inputs/cell-types) while still reporting success. It now emits all maps first, then surfaces the result so it can never be swallowed.

## 2026-05-28 — P1 (#23 + #24): reliably emit a runnable engine.js

A clean `ete init` on the real PE models did not finish: the chunked emitter
built the **cell-level dependency graph** (every formula cell → its expanded
refs) as a full in-memory `BTreeMap`, then serialized the whole document into a
second in-memory `String` — ~doubling peak memory on top of an already-large
workbook and OOM-killing the parser. Because `engine.js` (the `run()`
orchestrator) was emitted **after** that step, the runnable engine never landed,
and `ete init`'s fixed 10-minute `spawnSync` cap compounded it.

- **engine.js now lands on every build.** `emit_chunked` writes the orchestrator
  **before** the dependency-graph step (it depends only on the sheet-level DAG +
  partitions, never the cell-level edges), so a runnable `run()` survives even a
  hard kill of the later step. A write failure is fatal (`Err` → exit 1).
- **Dependency graph is streamed to disk.** `write_dependency_graph` emits
  `dependency-graph.json` one entry at a time through a `BufWriter`, never
  materializing the full map or full JSON string — the OOM fix. Schema unchanged
  (`cell-dependency-edges-v1`; consumers read only `.edges`); `edgeCount` is
  written last. Output is deterministic (partition + sorted-cell order).
- **Configurable parser timeout.** `ete init --timeout <seconds>` (default bumped
  600 → 1800; `0` disables the cap). The fixed 10-minute cap was killing
  legitimate large-model builds mid-emit.
- **Fail loud, never a partial artifact.** After a fresh parse, `init` verifies
  `chunked/engine.js` exists (fast fail before the minutes-long manifest
  pipeline) and **won't swallow a failed emit**. `--reuse-parse` (use `chunked/`
  as-is for manifest iteration) is exempt — it records the incomplete state
  instead of blocking.
- **#24 — locked artifact layout + content hash.** New `lib/build-manifest.mjs`
  writes `chunked/build-manifest.json`: the canonical artifact set with
  per-file/dir sha256, and a single top-level `contentHash` over the
  *identity* artifacts (engine.js, sheets/, _ground-truth.json, manifest.json).
  The derived contract maps carry a `generatedAt` and are hashed for integrity
  but excluded from identity, so `contentHash` is **stable across rebuilds of the
  same workbook** and **changes on drift** — a downstream consumer pins a build
  and detects mismatch without per-version reconciliation. `--quiet` now emits
  `contentHash`. This is also the comprehensive completeness gate: a fresh build
  missing a required artifact hard-fails.
- **Tests.** New `npm run test:runnable` (parser → engine.js exports `run()`,
  streamed dep-graph edges intact, build-manifest layout/gate, contentHash
  stable-across-rebuilds + drift-sensitive), wired into CI on ubuntu+windows.
  Full suite green: smoke 78/78, test:engine 21, test:depgraph 11, test:slimming
  13, Rust units 11, `npm test` (387).

## 2026-05-28 — Privacy scrub: genericize the real model name + figures

This repo is public; CLAUDE.md forbids committing real financials or participant
names. Two cleanups before merging the next-wave PR:

- **Removed the real return figures** (gross/net MOIC & IRR, the UW-comparison
  multiple, the MIP dollar amount) from the committed docs. The findings stay
  (golden-master match on Version Tracker row 22; refiner UW-Comparison mis-map;
  MIP is a hand-port calibration) — only the numbers are gone. Canonical values
  live in the gitignored artifacts + local notes and feed the golden-master test
  from there.
- **Genericized the real model name** out of all committed files: renamed the
  benchmark script → `benchmarks/bench.mjs` (npm script `bench`),
  and the benchmark now **anonymizes model identity** in printed + committed
  output (Model A, Model B, …) — real dir names stay only in the gitignored
  detail JSON. Prose in HANDOFF/ROADMAP/PLAN/CHANGELOG now says "the real PE
  models" / "Model A/B". (The `test-e2e4-fixes` scrub-guard that asserts template
  names are generic is intentionally kept.)

## 2026-05-28 — Mippy calibration-oracle feature set (priority amendment)

Refined the "fully ready for Mippy" target: the e2e agent's job is to make the
full model a **reliable calibration oracle** — runnable, MIP coefficients exposed
as named-outputs, no stubbed value cells. Documented the priority order in
ROADMAP ("Now — Mippy calibration oracle") and HANDOFF.md, and in the
`project_mippy_contract` memory:

- **P1 · #23 + #24** — reliably emit a runnable `engine.js` (fix dep-graph OOM;
  fail loud, never a partial artifact; lock layout + content hash).
- **P2 · #25** — pin value-bearing cells (per-class MIP Proceeds, hurdle,
  participation %, equity basis, valuation/shares) as named-outputs.
- **P2 · #26** — emit `_fn-fallbacks.json`; assert no value cell uses an
  unsupported-function stub.
- **P3 · #22** — output-cone scoping (nice-to-have).

Supporting/trustworthiness (off critical path): golden-master CI, refiner
UW-Comparison fix, deeper `_fn` coverage, cluster-once eval.

## 2026-05-28 — HANDOFF.md (fresh-agent entry point)

Added `HANDOFF.md` — the prioritized next-session plan (P0 cluster-once eval →
generation robustness #23 → `_fn()` transpiler coverage → refiner UW-Comparison
fix → golden-master CI → output-profile/large-sheet/perf → Polish), with current
state, run commands, and the gotchas (gitignored real models, the GT-copy
`_computed-values.json`, the per-sheet-eval Windows fix, the bench
`discoverModels` gate vs the `-v2` regen). PLAN points to it.

## 2026-05-28 — Roadmap: PE-model regeneration findings (Mippy consumer)

The downstream Mippy agent regenerated both PE engines from `main` and
reported back. Captured the findings in ROADMAP.md ("Now — PE-model regeneration
findings"). Confirmed wins vs the old build: **dates fixed** (old leaked
`ExcelDateTime { … }` debug strings — 2,686 in A-1; new emits serial numbers, 0
leaks), **~42–45% smaller** (model-map.json + the GT-copy `_computed-values.json`
gone), contract maps emitted, circular refs converge, and a **golden-master PASS**
— the regenerated ground truth reproduces the hand-port's canonical A-1 returns
to full float precision (Version Tracker row 22). New follow-ups: generation
robustness on big models (dep-graph OOM + `init` 10-min timeout — issue #23),
`--output-profile` to scope artifacts (#22), the **11,813 `_fn()` unsupported-
function fallbacks** per engine (transpiler-coverage accuracy suspect), the
refiner mis-mapping returns to a "UW Comparison" tab, empty `named-inputs.json`
when no formula-referenced defined-names exist, and MIP-as-output (#7). A
ready-made golden-master CI assert (diff committed `named-outputs.baseCaseValue`)
is noted.

## 2026-05-28 — Circular-cluster eval: scoped convergence diff + first cluster test

Progress on the circular-cluster accuracy blocker (the 17-of-21-sheet cluster on
the real models that wouldn't evaluate).

- **Scoped convergence diff.** The cluster convergence loop in
  `per-sheet-eval.mjs` checked for a fixed point by diffing **every** cell in the
  context each iteration — and the context is seeded with the full (multi-million-
  cell) ground truth, so that was O(all cells) × up to 200 iterations. It now
  tracks the cells `compute()` actually writes (`ctx._written`) and diffs only
  those (the cluster's own outputs). Behavior-preserving; large constant-factor
  win on big clusters.
- **First circular-cluster test + fixture.** `tests/cli/fixtures/cluster-model/`
  is a synthetic 2-sheet circular model (SheetA ↔ SheetB, converges to
  a=50,b=50,c=100,d=100). `tests/cli/test-per-sheet-eval.mjs` now evaluates it
  through the convergence loop and asserts 100% — the cluster path had no
  coverage before, and this guards the scoped-diff change.

**Still the key fix (cluster-once):** measured on the real model, scoped-diff
alone is *not* enough — `per-sheet-eval` re-runs the entire cluster convergence
**once per member sheet** (17×), and engine inaccuracies keep some clusters from
converging (200 iters). The remaining work is single-pass orchestrator eval:
converge the cluster once, then score every member from that converged state
(one task per cluster, not per sheet). The fixture above is the ready-made test
oracle. Until then the benchmark runs with `--skip-clusters`.

## 2026-05-28 — Unit tests for lib/ (Polish→Publish)

The shared financial libraries had no direct coverage. Added
`tests/lib/test-lib.mjs` (43 known-answer assertions), wired into `npm test`
(runs first) so CI guards them on every push:

- **`lib/irr.mjs`** — NPV/NPV-derivative identities; IRR of classic cash-flow
  series (−100→+150 = 50%, −1000 then 200×8 ≈ 11.89%, 3-year bullet); Newton ≡
  bisection agreement; NPV(IRR) ≈ 0; null on no-sign-change; XIRR on dated flows.
- **`lib/waterfall.mjs`** — American 80/20 + 8% pref + catch-up (LP/GP splits,
  carry %), no-catch-up variant, loss case (no carry), the flat-MOIC-hurdle
  promote (incl. the hold-period-independence invariant), European builder; the
  LP+GP = distributed conservation invariant across structures.
- **`lib/calibration.mjs`** — nested get/set; `validateOutputs` pass/fail +
  suggested corrective factor.
- **`lib/sensitivity.mjs`** — `flattenOutputs` group/type filtering.

## 2026-05-28 — PE-model accuracy benchmark + eval-tooling fixes

Stood up a repeatable accuracy + efficacy benchmark over the real ~200 MB
PE models so improvements can be tracked over time, and fixed the eval
tooling that was silently broken on them.

### Benchmark (`benchmarks/bench.mjs`, `npm run bench`)

- Wraps `eval/per-sheet-eval.mjs` (live engine-vs-ground-truth) for every model
  under a root dir; reports overall accuracy, per-sheet pass/skip counts, and
  timings. **Aggregate-only** results go to the committed `benchmarks/BASELINE.md`;
  full per-sheet detail stays in the gitignored `benchmarks/results/`. No cell
  value or label is ever committed.
- **Baseline (2026-05-28):** Model A **84.3%**, Model B **85.5%** on the
  standalone sheets. (The 17-sheet circular cluster and the 190 MB PP&E sheet are
  skipped for now — see below.)

### per-sheet-eval fixes (it wasn't in CI, so these went unnoticed)

- **Windows crash fixed.** The generated per-sheet wrapper imported each sheet's
  `compute()` by a bare absolute path (`"C:\\..."`), which Node ESM rejects on
  Windows — so *every* sheet "crashed" at load (0% accuracy) on Windows and on
  the real engines. Now uses `pathToFileURL()`. New `tests/cli/test-per-sheet-eval.mjs`
  (6) guards it; CI runs it on **windows-latest** too.
- **`--skip-clusters`** flag: record circular-cluster sheets as skipped instead
  of evaluating them. The current convergence path re-runs the *whole* cluster
  once per member sheet (O(cluster²)), which is infeasible on big models; this
  yields a fast, real number for the standalone sheets while the single-pass
  orchestrator eval is built (ROADMAP).

### searchByLabel: lazy numerics (query / carry)

`searchByLabel` previously scanned the entire ground truth once per matched row
to collect adjacent numerics. It now probes the row's columns on demand (same
approach as the refiner), with a directed `caseColumn` lookup probing its exact
cell so a far scenario column is never missed. Behavior-preserving (query/carry/
ai-interface suites green).

### Findings that scope the accuracy-blocker work

- The 190 MB PP&E sheet exceeds the 150 MB per-sheet limit → **large-sheet eval**
  blocker confirmed.
- The circular cluster is **17 of 21 sheets** and is evaluated redundantly
  (once per member) → the concrete reason behind "circular-cluster won't
  evaluate." Single-pass orchestrator eval is the fix.
- `_computed-values.json` in these engines is **byte-identical to ground truth**
  (a seeded copy), so it is not a valid accuracy source — accuracy must come from
  live recompute.

## 2026-05-28 — `init` parses the ground truth once (shared across the pipeline)

The real driver behind the "~2.5 min" refine loop wasn't one command — it was
that `ete init` runs **generate → refine → doctor → maps** in sequence and
**each independently re-read and re-parsed the full ground truth** from disk. On
the real ~200 MB PE models that's four parses of a 200 MB+ file at ~3.6 s
each, plus each command's own O(N) scan.

### What changed

- `init` now loads the ground truth (and label index) **once**, after the parse,
  and shares the parsed object across all four manifest steps. The GT is
  read-only in every consumer (verified — no `gt[...] =` / `delete` / `assign`
  anywhere), so a single shared object is safe.
- Each consumer (`runGenerate`, `runManifestRefine`, `runDoctor`,
  `emitManifestMaps`) gained an optional injected GT (`_gt` / `opts.gt`) and
  label index. When absent — i.e. standalone `ete manifest generate|refine|
  doctor|maps` — they load from disk exactly as before. Fully backward-compatible.
- Eliminates 3 of the 4 full-GT parses per init (~11 s on a 200 MB GT) at **zero
  disk cost** — and it's independent of model shape, unlike a row-values artifact.

### Why not the row-values artifact (Tier B)

Measured on both real ~200 MB PE models: they're **dense-label** (≈90% of
rows labeled, ≈93% of numerics on labeled rows), not the giant-grid case Tier B's
big win assumed. A general row-values artifact would be ≈30% of GT (≈60% of the
post-#17 compact GT) — only ~1.6× on refine while inflating output ~60%, fighting
the #17 slimming. Deprioritized in favor of this shared-parse change. See ROADMAP.

### Tests

- `tests/cli/test-init-shared-gt.mjs` (8), wired into `npm test`: with **no**
  `_ground-truth.json` on disk, an injected GT makes generate/refine/doctor/maps
  all succeed and produce correct results (a consumer that read disk would
  error); a negative control confirms disk is otherwise the only source.

## 2026-05-28 — refine consumes `_labels.json` + lazy numeric probes

`ete manifest refine` rebuilt a full label+numeric index over the **entire**
ground truth on every run (`buildIndex`), even though it only ever inspects
numerics on a *matched label's own row*. On big models the bulk of that work
indexed giant **unlabeled** grids (e.g. a 190 MB PP&E depreciation schedule)
that the refiner never consults — pure waste. (Investigation also found refine
did **not** consume the parser's `_labels.json` at all, despite that index
existing since V4.)

### What changed

- **Labels now come from `chunked/_labels.json`** when the parser emitted it —
  an O(labels) read instead of scanning every cell. Legacy engines without the
  index fall back to a one-time GT scan (`buildLabelIndex`), so nothing breaks.
- **Numerics are resolved lazily, per matched row**, by probing that row's
  columns on demand (`numericsForRow`, memoized) — instead of bucketing every
  numeric in a multi-million-cell workbook up front. The giant unlabeled grids
  are never touched.
- **Behavior-preserving:** the candidate ranking, dedup, value-range, and
  summary/rollup/hint logic are untouched. The full manifest + ship-ready
  suites stay green.

### Impact

The eliminated `buildIndex` pass scales with *total* cell count; the new probe
cost scales with *matched label rows* (a few dozen). On a synthetic giant-grid
ground truth the removed pass alone was ~1.4 s (1.4 M cells) / ~7.9 s (6.4 M
cells); end-to-end refine now finishes in less time than the old index build
took. The remaining floor is the unavoidable JSON parse of the ground truth — a
follow-up could lift that with a parser-emitted row-values artifact (see
ROADMAP), and the same lazy-numerics treatment could be extended to
`searchByLabel` (the `query` / `carry` path).

### Tests

- `tests/cli/test-refine-label-index.mjs` (14), wired into `npm test`:
  correctness off `_labels.json`; **parity** between the index path and the
  GT-scan fallback; lazy-probe far/gapped columns + value ranges; and a
  **consumption proof** — a label present only in the index (not as a GT
  string) is still resolved, which the fallback provably cannot do.

## 2026-05-28 — Continuous integration (GitHub Actions)

The test suite is now substantial (132 JS assertions across 7 suites, plus the
Rust unit tests and the `smoke` / `test:depgraph` / `test:engine` /
`test:slimming` integration suites) but nothing guarded it on push. Added
`.github/workflows/ci.yml`.

### What runs

- **On every push to `main` and every PR to `main`**, a matrix across
  **`ubuntu-latest` + `windows-latest`** (this project is developed on Windows
  but ships cross-platform, so both are required; `fail-fast: false` so one
  OS's failure doesn't mask the other).
- Steps per OS: `npm ci` → `cargo build --release` → `cargo test --release`
  (11 Rust unit tests) → `npm test` (the 7 JS suites) → `npm run smoke`
  (78/78 chunked-engine accuracy) → `test:depgraph` → `test:engine` →
  `test:slimming`. Each integration suite is its own step for clear failure
  attribution.
- Rust builds are cached with `Swatinem/rust-cache`; npm via `setup-node`'s
  built-in cache. `concurrency` cancels superseded runs on the same ref;
  `permissions: contents: read` keeps the token least-privilege.

This unblocks the Polish→Publish track (a green CI badge is table stakes before
npm publish) and makes every subsequent refactor safer by guarding the whole
suite automatically.

## 2026-05-28 — Artifact slimming (Round 2, part 2)

Round 2 of the Mippy request, #8: keep the default `chunked/` output small.
A production consumer wires the engine into a Tier-1 RPC service; shipping a
600 MB+ artifact set per model is a non-starter. The large artifacts are all
either intermediate (their high-value derivative is already extracted) or pure
debug, so they move behind `--emit-debug`.

### Default output drops the large debug/intermediate artifacts

- **`dependency-graph.json`** (cell-level forward edges, ranges expanded → the
  biggest file on real models) is now **removed from the default output** after
  `ete init` bakes its closures (`dependsOnNamedInputs` / `affectsOutputs`) into
  the named maps. The parser still emits it so the closure pass can consume it;
  init deletes it afterward. The high-value data survives in the named maps.
- **`_graph.json`** (sheet-level DAG) — nothing in the toolkit reads it — is
  removed from the default output too.
- **root `model-map.json`** (600+ MB on big models) is no longer written by the
  Rust parser in `--chunked` mode. It was already being deleted by `ete init`;
  now it's never materialized, avoiding the write-then-delete and the large
  in-memory build on the biggest models.
- **`--emit-debug`** (on both `ete init` and the Rust parser) retains all three.

### Load-bearing artifacts that stay are smaller

- **`_ground-truth.json`** (read by the CLI + manifest, so it must ship) and
  **`_graph.json`** now serialize as compact JSON instead of pretty-printed —
  roughly halves the on-disk size of the ground truth for no functional change
  (it's machine-read).

### Tests

- `npm run test:slimming` (`tests/cli/test-artifact-slimming.mjs`, 13
  assertions): runs `runInit` end-to-end through the real parser and asserts the
  default output excludes the debug artifacts while the named-input closures
  survive, that ground truth is compact, and that `--emit-debug` retains
  everything. Skips cleanly if the parser isn't built.
- Smoke (78/78), `test:depgraph` (11), `test:engine` (21), and the full JS
  suite (132/132) all still green — the parser still emits the graph for the
  closure pipeline; only the *default-output* lifecycle changed.

### Still open in Round 2

- **Engine perf (#9)** — base-case hot cache + partial recompute for the grid
  generator. MIP gating (#7) remains a model-owner question.

## 2026-05-27 — Dependency graph + closures (Round 2, part 1)

Round 2 of the Mippy request — the dependency-graph artifact (#3/#10), which
unblocks the grid-generator's "which outputs does this input affect?" question.

### New artifact + closure fields

- **`chunked/dependency-graph.json`** — cell-level forward edges
  (`cell → [cells it reads]`), emitted by the Rust parser. Ranges are expanded
  to every interior cell, so the graph is complete for transitive reachability.
  Only formula cells are keys. Format-tagged `cell-dependency-edges-v1`.
- **`named-outputs.json` → `dependsOnNamedInputs`** and **`named-inputs.json` →
  `affectsOutputs`** — transitive closures computed (BFS over the edge map) in
  `emitManifestMaps`. `affectsOutputs` lets a consumer invalidate only the
  affected outputs on a what-if instead of regenerating an entire grid.

### Correctness fix in `extract_refs` (dependency.rs)

Same-sheet ranges were **silently truncated**: `is_cell_ref("A1:A3")` required
consuming the whole string, so the range branch was skipped and only the
post-colon endpoint (`A3`) was captured — `SUM(A1:A3)` recorded a dependency on
`A3` but **not** `A1`/`A2`. Any named input in the interior of a same-sheet range
would have been invisible to the closure. `is_cell_ref` now accepts a range, so
the full span is expanded. (Cross-sheet ranges already took a correct path.)
This also makes intra-sheet cycle detection and the sheet DAG more accurate.

### Tests

- `npm run test:depgraph` (11 assertions): graph emission, range expansion,
  cross-sheet edges, and closures end-to-end (real parse → graph → maps).
- `test-manifest-maps.mjs` +7: `attachDependencyClosures` unit tests
  (multi-hop transitive, inverse `affectsOutputs`, leaf/unused, self-consistency).

### Scope / caveat

Round 2 part 1. The full `dependency-graph.json` can be large for big models
(ranges expand) — **`model-map.json` slimming / sharding / `--emit-debug`
gating (#8)** and **engine perf (#9)** are still open. The high-value closures
live in the named maps (small) regardless of graph size. `affectsOutputs`
requires the source `.xlsx` (named inputs are defined-name-sourced); without it
the closures are skipped and the graph still emits for consumer-side use.

## 2026-05-27 — Engine run() API: telemetry, override pinning, strict (Round 1, Rust half)

Round 1 Rust half of the Mippy request. All changes are in
`generate_orchestrator` (`pipelines/rust/src/chunked_emitter.rs`); the
generated `run()` return is **additive** (existing `values`/`kpis` unchanged).

### `engine.run()` now returns `meta` + `unknownOverrides`

- **`meta`** — convergence telemetry: `{ converged, iterations, maxDelta,
  convergenceTolerance, clusters: [{ sheets, iterations, converged, maxDelta }],
  perSheetIterations, elapsedMs }`. `converged:false` means a circular-dependency
  cluster exhausted `MAX_ITER` (or stalled) — a non-converged result is silently
  garbage, so consumers should refuse to lock on it. No-cluster models report
  `converged:true, iterations:0`.
- **`unknownOverrides`** — override cells not read by any formula. `run()`
  instruments `ctx.get` (only when overrides are present, so the base case stays
  zero-overhead) to record which override keys are actually consumed. Catches
  typos, missing sheet prefixes, and stale cell maps after a model rebuild.
- **`run(inputs, { strict: true })`** throws if any override is unknown.

### Two correctness fixes the telemetry exposed

- **Override pinning.** Generated sheet modules set their literal/input cells
  unconditionally, so an override applied before compute was **clobbered back to
  base case** — input-cell overrides silently no-op'd (exactly the "silently
  running base-case math" failure Mippy feared). `ComputeContext` now carries a
  `_locked` set; `set()` skips pinned override cells, so overrides propagate.
- **Cross-sheet convergence false-positive.** The cluster loop's delta only
  compared cells that were numbers in *both* snapshots, so the first pass — where
  every cluster cell goes `undefined → number` — looked like `maxDelta=0` and
  "converged" after one iteration (returning garbage, e.g. `A=100, B=0` for a
  fixed point of `A≈105.26, B≈52.63`). Newly-computed cells now count as a
  change. The bug was latent because no committed model had a cross-sheet cycle.

### Tests

- `pipelines/rust/tests/test-engine-runtime.mjs` (21 assertions, `npm run
  test:engine`): builds models, parses with the real rust-parser, imports
  `engine.js`, and asserts telemetry, override pinning/propagation,
  `unknownOverrides`, strict mode, and cross-sheet cluster convergence to the
  correct fixed point. Skips cleanly if the parser isn't built.
- Fixed `create-test-workbook.mjs` (`XLSX.writeFile` → buffer write, same
  SheetJS-ESM-no-fs-binding issue as `loadWorkbook`). Smoke test still 78/78.

### Note on request #4 (typed cell returns)

Satisfied by the `cell-types.json` sidecar from the JS half (Mippy's Option B).
Option A (changing `values` to typed `CellValue` objects) is a breaking API
change with broad blast radius (CLI, eval, smoke all read `values` directly) and
is **not** done — the sidecar already meets the acceptance criteria.

## 2026-05-27 — Downstream contract maps (Round 1, JS half)

Driven by the Mippy engine-integration request (2026-05-27): a consumer
wiring the chunked engine into a production RPC service had to *run the
engine* (9 min/call) and value-match numeric cells to discover which cells
hold the named outputs — then shipped a silent-`NaN` bug from guessing the
wrong cells. The fix surfaces what the manifest pipeline already knows as
small, stable JSON artifacts consumers can read at boot.

### New artifacts (emitted into `chunked/` by `ete init`)

- **`named-outputs.json`** — `name → { cell, label, type, format,
  baseCaseValue, source }`. The contract for downstream apps: look up
  `grossMOIC` and get its cell + base-case value to spot-check on import.
  Derived from the manifest's resolved outputs (a drift test pins it to
  `resolveBaseCaseOutputs`), enriched from the workbook's defined-name
  table. A defined name that disagrees with heuristic detection **overrides**
  it (the model owner's curated cell wins; the displaced cell is recorded
  as `manifestCell`).
- **`named-inputs.json`** — `name → { cell, type, default, referencedBy }`
  for every Excel **defined-name** cell that is **read by ≥1 formula**
  (curated, load-bearing inputs only — not every numeric constant).
  `affectsOutputs` is intentionally deferred until the dependency-graph
  artifact lands (Round 2). Requires the source `.xlsx`.
- **`cell-types.json`** — `cell → "number" | "label" | "boolean" |
  "empty"`. Lets consumers tell a label string from a numeric output, and a
  real `0` (present, `"number"`) from a never-computed cell (absent from the
  map) — closing the silent-zero ambiguity in the engine's `get()` default.

### Implementation

- New `lib/manifest-maps.mjs`: `collectNamedOutputs`, `collectNamedInputs`,
  `collectCellTypes`, `emitManifestMaps`. Outputs + cell-types need only
  manifest + ground truth (no `xlsx` dependency); inputs + defined-name
  enrichment use the workbook when reachable and **degrade gracefully**
  (e.g. under `--reuse-parse`) with a recorded skip reason.
- `ete manifest maps <chunkedDir> [--excel <path>]` regenerates the maps for
  an already-parsed model without a re-parse.
- **Fix:** `loadWorkbook` now reads bytes via Node `fs` and parses with
  `XLSX.read(buffer)` instead of `XLSX.readFile`. The SheetJS ESM build
  ships without an fs binding, so `readFile` threw "Cannot access file" —
  this path was previously unexercised (init parses via Rust, not SheetJS).
- `buildNamedRangeMap` exported from `lib/excel-parser.mjs`.

### Tests

- `tests/cli/test-manifest-maps.mjs` (40 assertions): output shape +
  no-drift guard, defined-name enrichment + override, cell-type
  classification incl. the real-0-vs-missing distinction, named-input
  detection (incl. excluding named-but-unreferenced cells), and
  `emitManifestMaps` end-to-end with and without an `.xlsx`. Added to
  `npm test`.

### Scope

Round 1 JS half. The engine-API items from the same request — convergence
telemetry, `unknownOverrides`/strict mode, typed cell returns — are the
Rust half (`generate_orchestrator`) and land next. `model-map.json`
slimming, the dependency-graph artifact, and engine-perf work are Round 2+.

## 2026-05-07 — Security audit pass (PR #13, v0.2.0)

External security review by @shanedog. Two commits, 8 files, 397/397
tests green after merge. Each fix targets a concrete attack primitive
rather than a theoretical hardening — none break the public CLI surface.

### Dependency upgrade

- **`xlsx` 0.18.5 → 0.20.3** via SheetJS CDN tarball
  (`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`). Closes
  CVE-2023-30533 (prototype pollution, fixed upstream in 0.19.3) and
  CVE-2024-22363 (ReDoS, fixed in 0.20.2). Neither fix is on npm — SheetJS
  now ships exclusively via their own CDN. Lockfile shrinks ~88 lines
  because the CDN tarball bundles transitive deps (adler-32, cfb,
  codepage, crc-32, ssf, wmf, word). Mirror/airgapped installs need to
  allow-list `cdn.sheetjs.com`.
- **Package version bump 0.1.0 → 0.2.0** to mark the post-audit baseline.

### Security fixes

1. **Monitor server hardening** (`eval/monitor/server.mjs`).
   - Bind `127.0.0.1` by default (was `0.0.0.0`); override with `HOST=0.0.0.0`.
   - Multipart filename sanitized via `basename` + `[\w.\-]` charset whitelist
     + timestamp prefix (was: raw `Content-Disposition` filename → path
     traversal into `UPLOADS_DIR`).
   - `MAX_UPLOAD_BYTES` cap (default 200 MB) on both declared
     `Content-Length` and streamed bytes (was: unbounded buffer).
   - `Origin` allowlist on POST /run **and** WebSocket `verifyClient`.
   - **Dropped the WS `{action:'run', path}` handler entirely.** It was a
     remote-arbitrary-file-execution primitive — any connected client could
     spawn the pipeline against any local path. The supported flow is
     upload → POST /run; nothing in the dashboard used the dropped action.
2. **Shell-injection via crafted Excel paths** (`cli/commands/init.mjs`).
   `execSync` with shell-concatenated `"${parserBin}" "${excelPath}"` →
   `spawnSync(parserBin, [excelPath, ...], {})` array form. A `.xlsx` path
   containing `$()`, backticks, or quote characters can no longer escape
   into the shell. Parser binary now resolved from `PACKAGE_ROOT` instead
   of `process.cwd()`, so a hostile cwd can't ship a fake binary at
   `pipelines/rust/target/release/rust-parser`.
3. **Prototype-pollution guards in three `setNested` variants**
   (`cli/commands/{init,manifest,manifest-refine}.mjs`). Reject any path
   segment matching `__proto__` / `constructor` / `prototype`. CLI
   `manifest set`, template `mappings`, and refiner-derived paths can no
   longer pollute `Object.prototype`. `runSet` returns a clean error up
   front instead of silently no-op-ing.
4. **Code injection in generated child-process scripts**
   (`eval/{per-sheet-eval,blind-eval}.mjs`). All path interpolation now
   goes through `JSON.stringify()` instead of bare `'${path}'` template
   literals — a path containing a single quote or backslash can no longer
   break out of the source string and inject code into the spawned `node`
   process.
5. **Path-traversal in `--template`** (`cli/commands/init.mjs::findTemplate`).
   `--template ../../etc/foo` previously resolved outside `TEMPLATES_DIR`.
   Restrict template name to `/^[\w.\-]+$/` and verify the resolved path
   stays inside the templates root (defense in depth).

### Test surface

`npm test`: 397/397 (34 cli + 54 manifest-improvements + 57 ai-interface
+ 23 e2e4-fixes + 97 ship-ready + 132 use-case). `npm install` clean,
xlsx loads at 0.20.3.

### Follow-ups (none blocking)

- Origin allowlist hardcodes `http://localhost:${PORT}` /
  `http://127.0.0.1:${PORT}`. If we ever expose the monitor via
  `HOST=0.0.0.0`, the allowlist also needs widening — currently any
  explicit `Origin` from a non-loopback hostname will 403.
- `MAX_UPLOAD_BYTES` defaults to 200 MB. Largest tested model so far is
  ~83 MB (PE platform models); 200 MB covers expected upload sizes.

## 2026-04-20 — Post-rebuild platform upgrades (5 items)

After shipping the aggregate-cell-refs pass, the follow-on downstream
integration work surfaced five more gaps. All now fixed in the same
branch / PR.

1. **Flat-MOIC hurdle waterfall** (`lib/waterfall.mjs`). Tiers now accept
   a `hurdleMOIC` property — a fixed MOIC threshold that does NOT compound
   with hold period. Common in VC Class A PPS waterfalls. New helper
   `createMoicHurdleWaterfall({ hurdleMOIC, carryPercent })` builds the
   3-tier structure. `ete carry --hurdle-moic <n>` wires it end-to-end.
   When `--hurdle-moic` is set, `--life` / `--irr` are optional.
2. **Rollup-sheet preference** in both `detectCarry` and the refiner's
   candidate ranking. New `sheetRank` function: summary > rollup > generic
   > per-class-numbered. Fixes the case where 20+ "Total Carried
   Interest" labels across per-class, rollup, and summary sheets caused
   arbitrary cell selection. Large multi-rollup PE platform models now
   auto-detect the right consolidated carry sheet out of the box
   instead of picking a single per-class value.
3. **`ete init --reuse-parse`** flag skips the Rust parser when
   `chunked/_ground-truth.json` already exists. Turns 68s parse + manifest
   iteration into 2s manifest iteration. Silently falls through to a
   normal parse if `chunked/` is missing.
4. **Manifest-level invariants** (`manifest.invariants[]`) enforced by
   `ete manifest doctor`. Schema: `{ path, forbid?, expect?, note? }`.
   Use for cross-model attribution rules and domain decisions that
   agent-driven workflows have a tendency to revert. String-equality only
   (deliberate — regex would invite ambiguity). Failures surface as doctor
   errors with the user-supplied `note`.
5. **Sibling-sheet aggregation generalized.** Extracted
   `resolveSiblingAggregate(gt, sheets, primaryAddr)` helper. Applied to
   `detectCarry` (existing use) and `detectDebt` (new — multi-facility
   exit balances). Not applied to equity: the "class" abstraction already
   captures per-sheet splits, and downstream IRR/MOIC neighbor-search
   assumes string cells.

### Test surface
Ship-ready suite: 78 → 97 (+19 new assertions across categories J-N).
Full `npm test`: 378/378 green.

## 2026-04-20 — Aggregate cell refs for multi-class promote structures

End-to-end driven by a real downstream integration rebuild. `ete init`
on a PE fund model with two parenthesized investor-class sheets
(`GP Carry (1.5%)` and `GP Carry (1.25% TRS)`) returned only one
class's carry total instead of the consolidated sum across both —
the manifest schema had no way to express "total carry = sum of these
two cells."

### Changes

1. **`lib/manifest.mjs::resolveCell` accepts aggregate refs.** A
   `carry.totalCell` (or any cell-returning field) may now be either a
   string `"Sheet!A1"` or an object `{ cells: ["A!D1", "B!D1"], op: 'sum' }`.
   Supported ops: `sum` (default), `avg`, `min`, `max`. Missing cells are
   skipped; if none resolve to numbers, returns `undefined`. Backwards-
   compatible: every existing string ref still resolves identically.

2. **`detectCarry` auto-aggregates sibling sheets.** After locating a carry
   cell on a sheet whose name ends in a parenthesized qualifier
   (`"GP Carry (1.5%)"`), the detector scans for sibling sheets with the
   same prefix + non-zero value at the same row/col and upgrades
   `carry.totalCell` to an aggregate automatically. Single-class models
   (no parenthesized suffix, no siblings, or sibling with 0 value) fall
   through unchanged — the 63 prior ship-ready tests all still pass.

3. **Refiner preserves aggregates.** `resolveFieldFromManifest` now
   treats aggregate objects as "already set," so the refiner no longer
   overwrites a detector-built `carry.totalCell` aggregate with a single
   string cell. Prevents a silent downgrade that was shadowing the
   aggregation.

4. **Doctor + carry CLI handle aggregates.** The doctor label-sanity
   check (pre-carry / cash-flow disqualifier) unwraps aggregate refs and
   runs against the primary cell only. `ete carry` formats the source
   line as `sum(A!D1, B!D1)` for human-readable provenance.

5. **Ship-ready suite grows to 78 assertions.** Added category I with
   15 new assertions across: aggregate resolution of all four ops,
   missing-cell / null handling, sibling-sheet detection on multi-class
   shape, single-class pass-through, 0-valued sibling filtering, and
   refiner idempotency on aggregates.

6. **End-to-end validated.** `ete carry` on a re-parsed multi-class
   PE fund model now returns the consolidated total — matching the sum
   of both class cells (`GP Carry (1.5%)!D86 + GP Carry (1.25% TRS)!D86`)
   rather than just one class.

## 2026-04-17 — Ship-readiness pass (accuracy verification + refiner hardening)

A live accuracy check ran `ete carry` against two real PE platform models and
compared the outputs to the models' own computed carry cells in Excel. The
check found that the CLI's answer was ~3× the model's real number, exposing
seven bugs that silently produced "plausible but wrong" outputs. All seven
are fixed, with a 63-assertion ship-ready test battery gating regressions.

### Fixes

1. **Array-path corruption in the refiner** (critical, silent). The previous
   `setNestedField` walked `equity.classes[0].grossMOIC` as
   `equity → classes → 0 → grossMOIC` and wrote the value to a nested `"0"`
   sub-object instead of to the target class. Every refiner patch for
   `equity.classes[i].grossMOIC / grossIRR / netMOIC / netIRR` had been
   landing in a dead key — which is why `ete carry` from manifest kept
   erroring with "MoC not determined" even when the refine report said 8/8
   coverage. Replaced with the simpler iterative setter used by init.mjs
   and manifest.mjs.
2. **Refiner rejects zero-valued candidates when non-zero alternatives
   exist.** `carry.totalCell` used to bind to a restated-copy column cell
   that happened to be zero (e.g. `GPP Promote!KU88 = 0` shadowing
   `D88 = $41.6M`), because `0` passed the `[0, 10e9]` range check. Now
   any non-zero same-row candidate wins over zero. Safe across every
   caller because a zero total/basis is overwhelmingly wrong.
3. **Refiner + `pickRightmostInRange` prefer "closest-to-label" when
   given a labelCol anchor.** Paired with (2), this fixes the D-vs-KU
   trap: the label at column B anchors the search, the canonical formula
   cell in column D wins over restated copies in column KU. Time-series
   rows (e.g. `Debt Balance` with per-year values) still fall back to
   rightmost when no anchor is supplied.
4. **Doctor flags zero-value `totalCell` / `basisCell` / `terminalValue` /
   `exitMultiple` / `wacc` / `sharesOutstanding` / `pricePerShare` as
   errors.** New `mustBeNonZero: true` flag on `DOCTOR_FIELDS`. Zero debt
   at exit is still legal (post-refi models).
5. **`ete carry` model-first path.** When `manifest.carry.totalCell`
   resolves to a non-zero number and the user hasn't passed `--peak` /
   `--moc` / `--parametric`, the command returns the model's own computed
   carry × ownership. No parametric re-compute, no waterfall-structure
   guessing — exact to whatever tier structure (IRR hurdle bands, MIP
   overlays, catch-up variants) the model implements.
6. **Template `hints.scenarioColumns` drives refiner column selection.**
   Init now runs template-apply BEFORE refine, threading the template's
   hints block into the refiner. Candidates in the template's declared
   base-case column rank above the same label in other scenario columns.
7. **`--search` token fallback for non-contiguous substrings.** Pasting
   `"Gross MOIC"` now matches labels like
   `"Gross (post carry, pre-fees / expenses / carry) MOIC"` — the literal
   substring fails but the token AND-match ("Gross" and "MOIC" both
   present as words) succeeds. Requires ≥2 tokens to avoid
   false-positives on single terms. `--regex` still honored; invalid
   regex silently falls back.
8. **Refiner picks top candidate when multiple summary-sheet entries
   compete.** A file with repeated summary blocks (e.g. Post-MIP MOIC
   shown on both "A-1 Management" and "A-1 TVP" rows) now binds to the
   top-ranked candidate and records alternates in the refine report,
   instead of leaving the field unbound as "ambiguous".

### Tests
- +63 ship-ready assertions in `tests/cli/test-ship-ready.mjs` covering
  adversarial refiner layouts, search edge cases (regex / literal / token
  fallback), doctor zero-value flags, `ete carry` routing matrix,
  end-to-end synthetic platform fixture, and real-world stressors
  (unicode, mixed types, null equity, long labels, idempotent refinement).
- Total assertion count: 363 (34 + 54 + 57 + 23 + 63 + 132).
- Rust smoke: 78/78. Cargo build: zero warnings.
- Verified on two live 77-84 MB PE platform models: `ete carry` now
  returns `$2.5M` (A-1) and `$4.7M` (A-2) at 6% ownership — matching the
  models' own Total Carried Interest cells exactly.

## 2026-04-17 — Post-SESSION_LOG-4 workflow + auto-gen fixes

A fresh-instance end-to-end session against two PE platform models surfaced
a cluster of friction points, headlined by a mid-session workflow stall
where the agent ran 60+ sequential cell-coordinate probes trying to reverse-
engineer a scenario column. This pass closes each one.

### Workflow stall prevention
- **`skill/SKILL.md`** — new "Core rules" block at the top: never walk cell
  coordinates, assume + verify beats probe + prove, templates do the guessing
  when they match, ask the user when unsure, `--search` is literal by default.
  This is the first block a new session reads and it names the anti-pattern
  explicitly.
- **`--search` is literal substring (case-insensitive) by default.** Users
  can paste phrases like `--search "Gross (portfolio)"` without triggering
  an unterminated-regex crash. Opt in to regex with `--regex`. Invalid
  regex silently falls back to literal rather than throwing.
- **`--case <column>` on `ete query`.** Comparison sheets with multiple
  scenario columns (H, I, J...) can now be targeted directly — matches show
  the named column's value as the primary hit. `hints.scenarioColumns` in
  templates suggest the conventional base-case column.

### Soft-fail init (no more abort-on-first-bad-field)
- **`ete init` quarantines bad fields and exits 0 by default.** A single
  `basisCell`/`exitMultiple` mis-bind used to abort the full 8-minute parse.
  Now each error-level finding is set to null in the manifest, the user
  sees the exact fix command, and the chunked directory is written.
- **`--strict`** re-enables hard-fail (for CI / agent pipelines).
- **`--force`** preserved as a no-op alias so old scripts still work.

### Refiner hardening
- **Peak Net Equity / Gross MOC patterns** added to refiner's
  `REQUIRED_FIELDS`. Previous patterns missed "Peak Net Equity",
  "Fund Size / Peak Net Equity", and "Gross MOC" (no trailing IC). Both
  failed to bind on the production-session models.
- **Summary-sheet preference** in the refiner: candidates on
  `Cheat Sheet` / `UW Comparison` / `Summary` / `Valuation` / `Cover` /
  `Returns` / `Dashboard` / `Exec Summary` tabs rank above the same label
  on operational tabs. Ambiguous matches collapse to the single
  summary-sheet entry when exactly one exists.

### Template auto-apply on strong signature match
- **`templates/pe-platform-summary.json`** — replaces the previous file with
  a generic PE platform template keyed by a 3-tab signature (the common
  shape of PE models that separate summary and promote tabs).
- `signature.autoApply` + `matchThreshold` fields let a template declare
  when it wants `ete init` to apply it automatically vs. just suggest it.
- **`--no-template`** opts out of auto-apply per-run.
- `detectMatchingTemplate()` returns a best-match descriptor with hit
  counts; ties break toward the larger signature (more specific).
- Template now carries a `hints` block: summary-sheet list, per-sheet
  scenario-column defaults, peak-equity label vocabulary.

### `ete carry` label-search fallback
- When `--peak` / `--moc` aren't provided and the manifest hasn't bound
  them, `ete carry` now searches the ground truth by label (uses the
  Phase-1 label index) and either adopts the single unambiguous candidate
  or lists candidates with the exact `ete manifest set` fix command.
- The formatted output reports "via label lookup at <cell>" when a value
  was resolved this way so the user knows where the number came from.
- Works with `--case` to prefer a specific scenario column's value.

### Public-release hygiene
- All proprietary identifiers (private-company and vendor names) scrubbed
  from templates, docs, plans, changelog, and inline comments. The previous
  PE-platform template file has been renamed to
  `templates/pe-platform-summary.json`; any call sites passing an older
  template name to `--template` must migrate to this generic name.

### Tests
- +23 assertions in new `tests/cli/test-e2e4-fixes.mjs` (297 total across
  the suite; all green).
- Rust smoke 78/78.

## 2026-04-17 — V4 AI Interface Layer

Reframe: this tool is an **AI-navigable index over complex Excel models**
covering ~20-30 PE stakeholder use cases (analyst, VP, partner, LP,
portfolio CFO, IR), not just carry/scenarios. Six priorities — all landed.
See `PLAN_V4.md` for the full design.

### Phase 1 — Label index (infrastructure)
- **Rust parser** (`chunked_emitter.rs`, `sheet_partition.rs`) now emits
  `chunked/_labels.json` during chunked emission: `{ labelLower → [{sheet, col, row, text}] }`.
  One extra pass over string cells (~1% of total parse time).
- **CLI** (`lib/manifest.mjs`) exports `loadLabelIndex()` and `buildLabelIndex()`.
  `searchByLabel()` uses the index when present — eliminates the 30s-per-search
  cost flagged in SESSION_LOG_02_carry.md. Fallback to GT scan when legacy engines
  don't have the index file.

### Phase 2 — Token-efficient output (`--compact`)
- `cli/format.mjs` exports `toCompact()`. New `--compact` / `--format compact`
  routes all commands through a compressor:
  - Numbers rounded to 4 sig figs
  - Null/undefined dropped
  - Value-record objects renamed to short keys (`v`/`c`/`l`/`t`/`s`/`r`/`k`)
- Measured: `ete query --search` output shrinks 4247 → 1461 bytes (~65% reduction).
  Agents get 3× more questions per context window.

### Phase 3 — `ete explain <name-or-cell>`
New command. Full audit trail for any manifest name or cell reference:
- Manifest path (which field maps here)
- Cell reference + value
- Adjacent label (column A/B on same row)
- Formula (from `formulas.json` if present, else searches per-sheet `.mjs`)
- Dependencies (from dependency graph if available)

Use: `ete explain <modelDir> totalCarry` or `ete explain <modelDir> "Equity!AN125"`.

### Phase 4 — Doctor-gated init + model-family templates
- **Doctor gate:** `ete init` now runs `manifest doctor` after refine.
  Errors abort init with non-zero exit. `--force` bypasses.
- **Templates:** new `templates/` directory with `pe-platform-summary.json`,
  `pe-fund-generic.json`, `re-fund-generic.json`. Each is a partial manifest
  with layout hints and optional pre-mapped cell references.
- **`--template <name>`:** `ete init model.xlsx --template pe-platform-summary`
  applies the template after auto-generation, overriding detected cells with
  known-good mappings for the family.
- **Auto-suggest:** when no template is specified, `init` checks whether the
  model's sheet names match any known template (≥75% overlap) and prints a
  suggestion.
- **`ete manifest export <modelDir>`:** export a hand-corrected manifest as a
  reusable template. Strips base-case values, keeps structural mappings.

### Phase 5 — `ete eval <cell>` (chunked engine bridge)
New command invokes the chunked engine to compute a cell using the actual
transpiled Excel formulas. Escape hatch from the delta cascade (linear
approximation) for non-linear scenarios: covenants, MIP, pref compounding
with irregular calls, FX hedges. Supports `--inputs '{"Sheet!A1": value}'`
to override base-case cells.

### Phase 6 — Breadth of extraction primitives
Manifest schema extensions + detectors + extraction command for the long
tail of stakeholder questions:

**New manifest sections:**
- `fundLevel` — TVPI, DPI, RVPI, netIRR, vintageYear, fundSize, paidIn,
  distributed, residualValue (LP-facing metrics)
- `schedules[]` — time-series rows tagged with type: `capital_call`,
  `distribution`, `debt_balance`, `debt_service`, `interest_expense`, `fee`,
  `equity_invested`, `cash_flow`, `noi`
- `covenants[]` — DSCR, LTV, ICR, leverage ratio, occupancy
- `equity.classes[i].shares`, `.ownershipPct`, `equity.totalShares` (cap-table)
- `debt.principal`, `.rate`, `.maturity` (debt-detail)
- `carry.tiers[]` — detected waterfall tiers (return_of_capital, pref, catchup, residual)

**New command:**
- `ete extract <modelDir> [--list | --type <t> | --id <id>]` — retrieve any
  detected schedule as `{year: value}` series + total.

**New field ranges:** 12 new entries in `FIELD_RANGES` covering TVPI, DPI,
RVPI, fund size, paid-in, distributed, vintage year, debt rate/principal,
covenant ratio, ownership fraction. Used by `doctor` + detector validation.

### Tests
- 57 new assertions in `tests/cli/test-ai-interface.mjs`: label index,
  compact output, explain, eval, extract, templates, every new detector.
- Full test surface: **274 assertions** (34 CLI + 51 manifest + 57 AI-interface
  + 132 use-case), all green.

### Documentation
- `skill/SKILL.md` — rewritten Intent→Command table organized by stakeholder:
  analyst/VP (scenarios), LP (fund-level metrics + schedules), CFO (debt +
  covenants + eval), audit ("why" questions via explain).
- `README.md` — new "What AI agents can ask this tool" section with
  representative questions per stakeholder.
- `CLAUDE.md` — updated command count (12), added `extract`/`explain`/`eval`
  to the reference table.
- `templates/README.md` — template schema + how to build new ones.

---

## 2026-04-16 (PM) — Carry Command + Label Hardening (SESSION_LOG_02_carry.md)

Follow-on pass driven by a second 3-E2E-test session: computing "carry at 2.8×
MoC with 6% ownership" across A-1 + A-2 deployments. The investigation took
~7 min and relied on manual Python scripts because the toolkit didn't expose
the waterfall math, the `carry.totalCell` auto-detection was wrong, and bulk
label scans over a 200 MB ground truth had to be done outside the CLI.

### Added
- **`ete carry`** — compute GP carry under an American or European waterfall.
  Falls back to manifest values for peak equity / MoC / pref / carry%; accepts
  explicit overrides. Solves hold period from IRR via `n = ln(MoC)/ln(1+IRR)`
  when timeline data is missing. Supports `--ownership` for per-holder share,
  `--combined` to sum multi-class equity basis, `--no-catchup` for
  pure 80/20-above-pref, and `--structure european` for multi-hurdle aggregate
  waterfalls. Wraps the pre-existing `lib/waterfall.mjs` which was previously
  only callable from JS code.
- **Scenario-block detection** — `lib/manifest.mjs` now detects stacked
  repeating blocks on a sheet (e.g. 5 scenarios at rows 1-92, 93-184, ... on a
  PE "GP Promote" tab) and emits them to `manifest.scenarioBlocks`. `ete
  summary` surfaces them with block labels and stride so users can target a
  specific scenario without row arithmetic.
- **`manifest doctor` carry-label sanity check** — inspects the adjacent
  B/A-column label of `carry.totalCell` and flags disqualifying descriptors
  ("pre-carry", "cash flow", "receivable", "payable"). Catches the common
  bug where `carry.totalCell` auto-binds to a Promote-tab cell whose adjacent
  label says "Total Cash Flows (pre-carry)".

### Fixed
- **`carry.totalCell` auto-detection rejected pre-carry CF labels.** Added
  `disqualifyingPatterns` to the refiner's field spec and equivalent logic
  to the detector in `lib/manifest.mjs`. Labels containing "pre-carry",
  "cash flow", "receivable", "payable", "fee", "operating", "capital",
  "equity", or "profit" no longer satisfy the carry regex even if the rest
  of the label matches.
- **Carry regex matches "Total Carried Interest".** Previous regex required
  the literal substring "carry" which `carried` does not contain (differ by
  5th letter y/i). Now accepts `carry|carried|promot`.

### Documentation
- **`skill/SKILL.md`** — added "Validate the Manifest Before Trusting It"
  (run doctor once per session), "When to Use Python Over the CLI" (bulk
  scans shouldn't go through `ete query`), expanded Returns & Carry table
  with `ete carry` examples, and added carry caveats (catch-up semantics,
  IRR-solved hold period limits, `--combined` for multi-class).
- **README.md** — added `ete carry` section with examples + output.

### Tests
- +20 assertions added to `tests/cli/test-manifest-improvements.mjs` (now 51
  assertions total, 217 across the full suite): carry detection accepts/rejects
  labels correctly, doctor flags manually-set bad carry cells, scenario-block
  detection on repeating vs non-repeating sheets, `ete carry` against fixture
  + parametric mode + IRR-solved-life + error handling.

### Session log reference
See `3-E2E-test/SESSION_LOG_02_carry.md` for the full investigation, the two
first-principles math methods that bracketed the answer, and the specific
CLI friction points this pass addresses.

---

## 2026-04-16 — Manifest Robustness Pass (informed by 3-E2E-test session log)

End-to-end run on two 76–83 MB PE platform models surfaced a cluster of
auto-detection failures that cascaded into garbage scenarios. All addressed here.

### Fixed
- **`basisCell` value-range validation on initial auto-generation.** Auto-gen
  previously accepted the first numeric on an equity-labeled row regardless of
  magnitude, so a `5` on `Assumptions!AI48` got written to manifest and produced
  `MOIC = terminalValue / 5 = 7.2M×` on scenarios. Introduced shared
  `FIELD_RANGES` + `inFieldRange()` in `lib/manifest.mjs` and enforced on
  `detectEquity`, `detectOutputs` (terminal value, exit multiple, cap rate),
  `detectCarry` (total carry, pref return), `detectDebt`, and `detectCustomCells`
  (WACC, shares outstanding, price per share). The existing refiner reused the
  same ranges.
- **Equity class dedupe by `(sheet, row)`.** `detectEquity` produced multiple
  identical `class-N` entries because several "Equity Basis" / "Capital
  Committed" labels on the same row each triggered a new class. Now collapses
  to one class per row.
- **Segment time-series validation.** `ete summary` showed "30 segments of $94K
  repeats" because `detectSegments` grabbed any revenue/expense labeled row,
  including scalar assumption rows that just replicated one number across year
  columns. Added a timeline-aware check: segments must have ≥3 numeric values in
  the timeline columns AND those values must vary by ≥0.1%.
- **Rust build: 13 dead-code warnings → 0.** Cleaned up unused variable
  destructures (`sheet_name`, `n_inputs`, `finished_v`, `loop_var`, `start`,
  `saved_pos`, `input_cells`, dead `parse_errors` assignment). Marked
  intentionally-retained helpers with `#[allow(dead_code)]` + reason comments
  (`convert_vars_to_ctx_get`, `extract_cell_addr_from_var`, `ClusterCode` fields,
  `ArrayLiteral` AST variant, `expect_comma`).

### Added
- **`ete manifest doctor <modelDir>`** — diagnoses suspect cell mappings after
  the fact. Runs value-range checks on every scalar field, per-equity-class
  metric, and time-series check on every segment. For each issue, reports the
  bad cell + value + expected range, and suggests a corrective `ete query` /
  `ete manifest set` command.
- **`ete manifest set <modelDir> <path> <cellRef>`** — targeted single-cell
  override for when auto-detection misses. Verifies the cell exists in ground
  truth before writing, refreshes `baseCaseOutputs` when applicable, and
  preserves manifest formatting. Replaces the "hand-patch JSON with Python"
  workflow used in the session log.
- **`ete summary` suspect-segment warnings.** Segments whose values are constant
  across all years are marked inline with `⚠` and a footer note directs the
  user to `ete manifest doctor`. Added `--terse` flag to hide suspect segments
  for clean headline output.
- **`ete init --quiet`** — machine-readable JSON summary instead of narrative
  logs. For CI / agent contexts where init's 600+ lines of per-sheet progress
  are noise.
- **`ete init` now cleans up redundant root `model-map.json` + `formulas.json`.**
  In chunked mode these files at the output root (up to 636 MB on large models)
  are redundant — the CLI reads exclusively from `chunked/`. Opt out with
  `--keep-model-map` for the eval pipeline.
- **`tests/cli/test-manifest-improvements.mjs`** — 31 assertions covering range
  validation edge cases, equity dedupe, segment time-series rejection, and
  doctor/set end-to-end.
- **`npm test`** runs the full suite: 34 CLI integration + 31 manifest + 132
  use-case scenarios = 197 assertions, all green.

### Session log reference
See `3-E2E-test/SESSION_LOG.md` for the production workflow that exposed each
of the above issues and what took manual intervention to work around.

---

## 2026-04-15 — PLAN V3 Amended: PE-Focused CLI Design

### Amended: PLAN_V3.md
Thorough redesign of the CLI plan based on deep analysis of 12 downstream projects and role-playing through real PE principal workflows.

**Key additions to the plan:**
- **Scenario files** (JSON) for complex multi-parameter scenarios (5-15 adjustments), in addition to CLI flags
- **Line-item adjustments** — row-level deltas (e.g., "reduce tech headcount by $2M"), not just segment-level
- **Growth rate overrides** — compound growth changes per segment (e.g., "tech grows at 40% instead of 30%")
- **Sum-of-parts valuation** — per-segment exit multiples (tech at 12x revenue, RE at 15x NOI)
- **Attribution analysis** — decompose "IRR dropped 7.5pp" into per-driver contributions (revenue -3.2pp, timing -2.8pp, multiple -1.5pp)
- **Cross-model comparison** — compare returns across different models (e.g., Fund A vs Fund B)
- **Named scenario management** — save/load/list scenarios per model
- **CapEx reclassification** — capitalize OpEx over N years (common PE restructuring scenario)
- **Interim distributions** — model special dividends / recap events
- **Label-based search** in query command (find cells by financial term, not just by address)
- **1D sensitivity sweeps** in addition to 2D surfaces
- **Delta cascade formalization** — explicit financial math for how adjustments flow to returns
- **PE language translation guide** in SKILL.md — maps real analyst phrasing to CLI parameters across PE, venture, RE, and corporate model types
- **Expanded parameter set** — ~25 parameters (up from 15), covering the full PE scenario space

**Architecture additions:**
- `cli/extractors/line-item-resolver.mjs` — row-level adjustment engine
- `cli/solvers/delta-cascade.mjs` — the core financial computation chain (adjustments → P&L → TV → equity → returns → carry)
- `scenarios/` directory for saved scenario files
- `package.json` bin entry for `ete` command

**Estimated scope:** ~2,500 lines JS + ~600 lines SKILL.md (up from ~2,000 + ~400)
**Implementation steps:** 19 (up from 14), resequenced with delta cascade as the critical path

---

## 2026-04-14 — PLAN V3: Model Analysis CLI + Skill Layer

### New: PLAN_V3.md
- Designed the consumption layer for converted models: CLI tool + manifest schema + Claude Code skill
- **Model manifest** — JSON schema (v1.0) that maps generic financial concepts (EBITDA, exit multiple, carry tiers, equity classes) to specific cells in any parsed model's ground truth
- **Auto-generation pipeline** — heuristic pattern matching (not LLM) scans ground truth for financial structures: date columns, revenue segments, exit multiples, waterfall tiers, equity/debt
- **CLI commands** — `ete init`, `manifest`, `query`, `pnl`, `scenario`, `sensitivity`, `compare`, `summary`
- **Scenario parameter suite** — 15+ financial adjustment parameters (exit multiple, revenue adj, cost ratios, magic number, leverage, hold period, etc.) that replicate common Excel model adjustments
- **SKILL file design** — teaches Claude Code to compose CLI commands for any manifested model
- **Generic design** — no proprietary model references; works with any Excel model converted by the Rust parser
- 14-step implementation order with dependency mapping, estimated ~1,500-2,000 lines JS + 400 lines skill

### Context
- Inspired by a production carry project's scenario analysis script — a bespoke CLI that wraps one model's ground truth into parameterized scenarios with IRR/MOIC/sensitivity
- V3 generalizes that pattern so any converted model gets the same capability without writing custom code

---

## 2026-04-13 — Two-Tier Engine Workflow + Ground Truth Delta Approach

### New: Dual-engine workflow documentation
- Defined Tier 1 (hand-crafted engines, fast) vs Tier 2 (ground truth + chunked modules, cell-level)
- Added decision logic: use Tier 1 for named-input sensitivity, Tier 2 for segment P&L changes
- Documented the **ground truth + delta approach** — load `_ground-truth.json`, compute scenario deltas, apply to base case returns. Faster and more reliable than running the full chunked engine.
- Added complete code examples showing how to search ground truth by label, read annual data by row, and compute MOIC/IRR impact

### Updated: SKILL.md
- Added TWO-TIER ENGINE WORKFLOW section with decision logic and code examples
- Instructs agents to always generate both tiers and route queries to the right one at runtime
- Documents why the ground truth + delta approach is ~6x more accurate than hand-crafted engine approximation for segment-level questions

### Updated: CLAUDE.md, README.md
- Added "Using Parsed Output" section to CLAUDE.md with workflow and code snippets
- Added "Two-Tier Engine Workflow" section to README with comparison table and examples
- Added new Claude prompt example: "Query ground truth for cell-level analysis"

---

## 2026-03-31 — Engine Validation Script + _sources Pattern

### New: `eval/validate-engine.mjs`
- Generic pre-deploy validation: checks engine base case values against `_ground-truth.json`
- Supports `_sources` metadata pattern: `cells` (direct lookups) and `aggregates` (multi-cell sums)
- Default 0.5% tolerance, `--strict` for 0.01%, `--json` for CI output
- Catches wrong-sheet, wrong-model, wrong-column, and arithmetic-estimate errors
- Exits non-zero on failure — use as a deploy gate

### Documentation
- Added Engine Validation section to CLAUDE.md with `_sources` pattern, common errors, and usage
- Added Step 5 (Validate Engine Values) to README with `_sources` example and CLI usage
- Updated project structure in both files to include `validate-engine.mjs`

---

## 2026-03-29 — Security Hardening + Root Cause Accuracy Fixes

### E2E Test 2 Results (80MB corporate model, 21 sheets, 6M cells)
- **Blind eval: 49/50 (98%)** — 1 failure from column ambiguity on wide sheet
- **Per-sheet eval: 71.4%** (24,266/33,971 cells) — 4 sheets >95%, 6 sheets <65%
- **Red team audit: 8 HIGH, 7 MEDIUM** security findings identified and fixed

### Security Fixes (from red team audit)
- **VULN-1**: Escape `${}` in template literals — blocks RCE via Excel text cells
- **VULN-8**: Complete `escape_js_string` — blocks string breakout via newlines/CR
- **VULN-9**: Strip `ANTHROPIC_API_KEY` from child process environment
- **VULN-4**: Container runs as non-root user (`USER node`)
- **VULN-5**: Safe `.env` loading — line-by-line parser instead of unsafe `xargs`

### Root Cause Accuracy Fixes
- **Root Cause 1 (INDIRECT)**: `INDIRECT("P"&ROW())` was emitting `ctx.get("P0")` because ROW() always returned 0. Fixed: ROW()/COLUMN() now emit actual cell position. INDIRECT auto-prepends sheet name. Expected impact: Headcount 18.6%→~75%, G&A 45.9%→~75%.
- **Root Cause 2 (DateTime)**: `ExcelDateTime { value: 45322.0, ... }` stored as debug string instead of numeric 45322.0. Fixed: `Data::DateTime(dt)` now emits `dt.as_f64()`. Fixes 3,300+ date cells across all models.
- **Root Cause 3 (SUMIFS criteria)**: Cascade from INDIRECT fix — `">"&K$7` now resolves cell value correctly.

---

## 2026-03-29 — V1 Fixes from Zero-Basis E2E Test

### E2E Test Results (fresh Opus 4.6 session, zero prior knowledge)
A fresh Claude Code session cloned the repo and ran the full pipeline on a 60-sheet, 1.8M-cell model with zero prior context. Results:
- **Parser: A+** — 1.8M cells parsed in 71s, zero errors
- **Blind eval: 50/50 (100%)** — Perfect on natural language queries
- **Per-sheet eval: 70.1%** — Top sheets 92-95%, dragged down by EOMONTH/INDIRECT bugs

### Fixes Applied

**Blockers:**
- `iterate.mjs` now auto-detects local vs Docker paths — works without container
- New `eval/per-sheet-eval.mjs` — standalone per-sheet accuracy testing without Docker
- New `eval/run-all.mjs` — one command for full eval pipeline (parse → questions → blind eval → per-sheet → report)

**Accuracy:**
- Fixed EOMONTH transpilation: was concatenating array fragments, now returns single serial number
- Fixed INDIRECT: was returning column letters ("Z", "AA"), now resolves to ctx.get() calls
- Convergence loop: increased max iterations to 200, tolerance to 1e-6, added stale detection

**UX:**
- README: added npm install step, cargo PATH note, memory requirements table
- New `npm run setup` — one-command fresh clone setup
- New `scripts/check-env.mjs` — verifies Node, cargo, npm deps, API key, rust binary
- Per-sheet eval cleans up temp files after completion
- Clearer sheet count reporting (tested vs succeeded vs skipped)

**Documentation:**
- Updated SKILL.md with production learnings (cash flow series, waterfall detection, pref compounding)
- Updated CLAUDE.md with new eval workflow
- Updated ROADMAP.md with production-informed priorities
- Updated PLAN.md to reflect current state

---

## 2026-03-25 — Production Eval + Doc Updates

### Production Use Evaluation
Evaluated the toolkit's output quality on a real 6-vehicle carry computation project that used the Rust parser. Key findings:

**What worked well:**
- All 6 models (5.7K to 5.8M cells) parsed successfully with `--chunked` mode
- Ground truth extraction captured carry-relevant cells across complex sheet structures
- Small fund models (2-7 sheets) parsed in <1 second, large models in ~15 minutes
- Per-sheet module architecture worked without OOM even on 5.8M-cell models

**Accuracy gaps identified in downstream use:**
- Simplified parametric waterfall engines diverged 29-60% from model actuals on 4/6 vehicles
- IRR approximation via `MOIC^(1/years) - 1` is very inaccurate for models with interim distributions
- Long-hold pref compounding (12 years at 8%) creates unrealistically high hurdles
- Multi-tier waterfalls (4+ tiers with IRR hurdles) not captured in model metadata

**Improvements needed (added to ROADMAP):**
- Cash flow series extraction from ground truth (not just terminal values)
- Waterfall structure detection and metadata in model map
- Guidance in SKILL.md for when to use actual parsed engine vs simplified wrappers

### Documentation Updates
- All MD files updated to reflect current status (PLAN, ROADMAP, CHANGELOG, CLAUDE.md, README)
- Historical docs in `docs/` annotated with path migration notes
- SKILL.md template paths updated for new `pipelines/js-reasoning/` location
- README expanded with development journey, scale progression, accuracy metrics, and production learnings

### Scale Data (from production use)
| Model | Sheets | Cells | Formulas | Parse Time |
|-------|--------|-------|----------|------------|
| Small (2 sheets) | 2 | 5,684 | 5,271 | 56ms |
| Medium (7 sheets) | 7 | 96,390 | 86,812 | 718ms |
| Large (34 sheets) | 34 | ~1.4M | ~1.2M | ~3min |
| XL (50 sheets) | 50 | ~1.5M | ~1.3M | ~4min |
| XXL (20 sheets) | 20 | 5,817,116 | 5,580,221 | ~15min |

---

## 2026-03-25 — Repo Restructure + Blind Eval + Merge to Main

### Repository Reorganization
- **Two clean pipelines**: `pipelines/rust/` (fast Rust parser) and `pipelines/js-reasoning/` (Claude-driven)
- **Unified eval**: All eval tools consolidated in `eval/` (iterate, blind-eval, questions, analysis, pipeline, Dockerfile)
- **Cleaned up**: Removed stale `_extract*.py`, `_extracted/`, duplicate container files, empty directories
- **Updated docs**: CLAUDE.md, README.md rewritten for new structure

### Blind Eval System (New)
- `eval/generate-questions.mjs` — Generates natural-language financial questions from ground truth
- `eval/blind-eval.mjs` — Independent Claude API validation with tool_use (zero engine knowledge)
- `eval/analyze-report.mjs` — Structured analysis of eval results with fix recommendations
- **50/50 (100%)** on blind eval for 38-sheet model — proves the engine data is navigable and correct

### Chunked Compilation (Option C)
- Per-sheet JS modules instead of monolithic engine (no more multi-GB files)
- Sheet-level dependency DAG with convergence loops for circular references
- 82 sheets for large model, 38 for mid-size — all compile and run
- Compact mode auto-enables for workbooks >50K cells

### Auto-Iteration Container
- Docker container: parse → eval → Claude API diagnose → patch transpiler → rebuild → re-eval → loop
- Resource monitoring in terminal (CPU/mem/network)
- Ctrl+C cleanly kills container + monitor
- Windows + Mac compatible (MSYS_NO_PATHCONV, .gitattributes LF)

### Performance
- Rayon parallelization: 3.8x faster (14min → 3:36 for 82-sheet model)
- Iterative Tarjan SCC: handles 3M+ nodes without stack overflow
- Ground truth coverage fix: +682K literal cells (+22%)

---

## 2026-03-23 — Rust Engine Pipeline (Phase 1 + 2 + Docker skeleton)

### rust-parser/ — New Rust Crate

Full Excel → JS transpiler in Rust (calamine + serde_json). Parses workbooks in <2ms (release build).

**src/parser.rs**
- Parses `.xlsx` with calamine — all sheets, all cells (values + computed formula results)
- Separate pass for formula strings via `worksheet_formula`
- Outputs `model-map.json` matching v1.1.0 schema (sheets, numeric/text/formula cells, stats)

**src/dependency.rs**
- Builds cell dependency graph from extracted formula references
- Lightweight regex-free ref extractor handles simple refs, cross-sheet refs (Sheet1!A1, 'Sheet Name'!A1), and ranges (A1:B10)
- Tarjan's SCC algorithm for cycle detection
- Self-referential cells (cell depends on itself) also detected as convergence candidates
- Condensation + Kahn's topological sort (fixed: dependencies before dependents)
- Outputs `dependency-graph.json` with nodes, edges, cycles, topo_order, convergence_clusters

**src/formula_ast.rs**
- Full Excel formula tokenizer: numbers, strings, booleans, errors, cell refs, ranges, operators, functions
- Handles quoted sheet names ('Sheet Name'!A1), absolute refs ($A$1), percent postfix
- Recursive descent parser → Expr AST
- Handles all operator precedences: comparison, concat, add/sub, mul/div, exponentiation (right-assoc), unary, percent

**src/transpiler.rs**
- AST → JavaScript code generation
- Cell refs → `s_SheetName_A1` flat variable names (configurable)
- Range expansion → `[s_Sheet_A1, s_Sheet_A2, ...]` inline arrays
- ~60 Excel functions transpiled: SUM, IF, MIN/MAX, ABS/ROUND, IRR/XIRR/NPV, VLOOKUP/HLOOKUP/INDEX/MATCH, AND/OR/NOT, IFERROR, text functions, date functions, financial (PMT/PV/FV/RATE)
- Unknown functions → `_fn('NAME', [...args])` placeholder

**src/circular.rs**
- Generates convergence loop JS for circular reference clusters
- Template: `for (let _ci_N = 0; _ci_N < 100; _ci_N++) { assignments; convergence check; }`

**src/model_map.rs**
- `build_formulas_json()` — all formula cells with formula string, transpiled JS, Excel result, parse errors
- `generate_raw_engine.js()` — complete JS module with runtime helpers, input declarations, dependency-ordered formula assignments, convergence loops, and `computeModel(inputs)` export

**src/main.rs**
- CLI: `rust-parser <input.xlsx> [output_dir]`
- Four output files: model-map.json, formulas.json, dependency-graph.json, raw-engine.js
- Timing per phase (parse, model-map, transpile, dep-graph, engine gen)

**Test Results**
- Synthetic 2-sheet workbook (22 formula cells, 1 circular cluster {B9, B10, B11})
- Circular Interest ↔ CashFlow ↔ DebtBalance correctly wrapped in convergence loop
- Topo order correct: inputs first, convergence cluster after prerequisites, outputs last
- Release binary parse time: **1ms** for test workbook (40 cells, 22 formulas)

### container/ — Docker Pipeline Skeleton

**container/Dockerfile** — Multi-stage: Rust build → Node.js 20 runtime
**container/pipeline.mjs** — Orchestrates parse → validate → eval-loop → output with WebSocket event streaming
**container/eval-loop.mjs** — Automated calibration loop: eval accuracy → detect scale mismatches → apply corrections → re-eval
**container/validate-extraction.mjs** — Cross-sheet ref validation, parse error rates, ground truth coverage

---

## 2026-03-23 — (previous entry)

### Sensitivity Surface Validation & Multi-Point Calibration

Addresses the core failure mode: engines match at base case but get the response curve wrong when inputs change. Waterfall hurdles, MIP thresholds, and other nonlinearities break single-point calibration.

**lib/sensitivity.mjs — New Library:**
- `extractSurface()` — Run engine across input grid, produce response surface with level and slope data
- `compareSurfaces()` — Compare engine vs Excel surfaces: level errors, slope errors, breakpoint mismatches
- `computeElasticity()` — % change in output / % change in input at each grid point
- `detectBreakpoints()` — Find where response curve changes slope sharply (waterfall hurdle crossings, MIP triggers)
- `multiPointCalibrate()` — Fit piecewise-linear corrections across multiple known points instead of single scale factor
- `applyPiecewiseCorrection()` — Apply segment-specific corrections at runtime
- `printSensitivityReport()` — Console report with level/slope accuracy, worst errors, breakpoint detection

**lib/calibration.mjs — Export Helpers:**
- Exported `getNestedValue()` and `setNestedValue()` for reuse by sensitivity.mjs

**tests/synthetic-pe-model/ — Proof of Concept:**
- `engine.js` — Deliberately buggy PE model (simple interest pref hurdle instead of compound)
- `excel-surface.mjs` — Ground truth using correct compound interest
- `test-sensitivity.mjs` — Demonstrates the full workflow:
  - Before multi-point calibration: 40% level accuracy, 69% slope accuracy
  - After multi-point calibration: 100% level accuracy, 100% slope accuracy
  - GP carry error at 1.6x exit: 87% → <1%

**skill/SKILL.md — Sensitivity Guidance:**
- Added "Sensitivity Surface Extraction" section to Phase 1 (extract outputs at multiple input values, not just base case)
- Added "Multi-Point Calibration" section to Phase 2 (use piecewise corrections when Excel surface data available)
- Added "Sensitivity Surface Validation" section to Phase 3 (validate slopes, not just levels)

---

## 2026-03-21

### Sheet Fingerprinting, Multi-Year Extraction & Build Log Improvements

Incorporated learnings from a 37-asset real estate model build into the core toolkit.

**lib/excel-parser.mjs — New Features:**
- `matchLabel()` — Fuzzy label matcher with 50+ financial term aliases mapping to canonical field names (revenue, EBITDA/EBITDAR/NOI, rent, IRR, MOIC, capex, cash flow, etc.)
- `fingerprintSheet()` / `fingerprintWorkbook()` — Scans label columns across all sheets, matches to canonical fields, groups sheets by identical row patterns. Solves the #1 pain point: figuring out which rows contain which data across dozens of identical per-asset sheets
- `detectYearRow()` — Auto-detects rows with sequential year values (2023, 2024, 2025...) and maps columns to calendar years
- `extractMultiYear()` — Extracts a time series for any field across all year columns
- `extractByYear()` — Extracts all fields for a specific reference year (combines fingerprint + year detection)
- `detectEscalation()` — Computes year-over-year growth rates for any field, flags escalating values (catches rent escalation that caused 10-15% errors in production builds)
- `classifyAsset()` — Auto-classifies assets as leased/managed/mixed based on rent presence, coverage ratios, and label text signals

**skill/SKILL.md — Phase 1 Improvements:**
- Added Sheet Structure Fingerprinting section with full usage examples
- Added Reference Year Selection guidance (default to first full stabilized projection year, not closing date)
- Added Cross-Sheet Validation section (validate extraction before engine generation)
- Added Asset Classification step for mixed-type portfolios
- Updated model-map.json schema to v1.1.0 with `referenceYear`, `sheetGroups`, `yearColumns`, `assets` fields
- Renumbered Phase 1 steps (1-8) to include new fingerprinting, year detection, and classification steps

**README.md:**
- Replaced ASCII architecture diagram with image (`docs/architecture.png`)
- Updated excel-parser library docs to show new fingerprinting, year detection, and classification APIs

**ROADMAP.md:**
- Added Incremental Re-extraction to Near-Term (diff model versions, generate changes report)
- Moved completed fingerprinting/classification work to Done section

---

## 2026-03-19 (evening)

### Skill Improvements from Blind Testing Feedback

**SKILL.md — Financial Terminology Mapping:**
- Added comprehensive alias table mapping equivalent terms across sectors (MIP = Promote = Carried Interest Pool = LTIP = Phantom Equity, etc.)
- Covers incentive structures, waterfall/distribution terms, return metrics, and share/unit economics
- Instructs Claude to normalize all variants to standardized engine output field names

**SKILL.md — Parallelization Guidance:**
- Added section on when/how to parallelize across the 4 phases
- Phase 1: read sheets in parallel, prioritize summary tabs
- Phase 2: build multi-series engines concurrently
- Phase 3: base case sequential, then cascade tests in parallel
- Phase 4: only after engines pass eval
- Explicit warnings on when NOT to parallelize (calibration, waterfall debugging)

**SKILL.md — Cheat Sheet Pattern:**
- Added guidance to search for Summary/Cheat Sheet/Overview/Dashboard tabs before diving into detail sheets

**Eval Framework — generate-control.mjs (new):**
- Reads BASE_CASE dynamically from reference engine instead of hardcoding input ranges
- Generates test matrix centered on actual base case values with configurable ±range per input type
- Produces control-baseline.json with base case outputs and single-variable sweep results

**Eval Framework — compare-outputs.mjs (new):**
- Compares candidate engine against control baseline within configurable tolerance
- Input normalization layer with alias mapping (e.g., ownedExitMultiple = exitMultiple = capRateMultiple)
- Handles canonical-to-alias, alias-to-canonical, and sibling alias resolution
- Reports per-output and per-sweep-point pass/fail with deviation percentages

---

## 2026-03-19

### Initial Build — Core Libraries + Templates

**Libraries:**
- `lib/irr.mjs` — Newton-Raphson IRR solver with bisection fallback, includes XIRR for irregular dates, NPV/NPV derivative utilities
- `lib/waterfall.mjs` — Generic PE distribution waterfall supporting American-style (pref + catch-up + residual) and European-style (multi-hurdle) structures. Configurable tiers with LP/GP splits, return-of-capital, catch-up provisions
- `lib/calibration.mjs` — Auto-calibration framework computing ratio/offset scale factors to align JS engine outputs with Excel targets. Includes validation and apply-calibration utilities
- `lib/excel-parser.mjs` — Excel reader using SheetJS (xlsx). Reads cells/ranges/columns, detects input cells (no formula, referenced by formulas), output cells (formula, end of chain), intermediate cells. Builds complete model-map.json with financial pattern detection (IRR, DCF, waterfall, sensitivity)

**Templates:**
- `templates/engine-template.js` — Engine skeleton with BASE_CASE, EXCEL_TARGETS, calibration initialization, `_computeRaw()` placeholder, and `computeModel()` public API
- `templates/dashboard/` — 2-tab HTML dashboard using Tailwind CDN + Chart.js. Tab 1: model explorer (output cards, input sliders, sensitivity heatmap, cash flow chart, waterfall chart). Tab 2: eval results (accuracy table, deviation chart, monotonicity/consistency checks)

**Skill:**
- `skill/SKILL.md` — Claude Code skill definition for the 4-phase pipeline (Analyze, Generate, Test, Dashboard) with detailed instructions for each phase

**Project:**
- README.md, CLAUDE.md, package.json, MIT LICENSE
- Project management files (PLAN.md, CHANGELOG.md, ROADMAP.md)

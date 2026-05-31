# Phase 0 → fixes backlog (from the 2026-05-30 re-baseline)

The full 12-persona re-baseline scored **1/12** (only `growth-equity-vp`), but
trust ROSE (avg A5 4.42, avg C5 4.00) — Wave 4 worked. The gate now binds on **A6**
(what-if expressiveness, 11/11 fails) and **A7** (handoff trust, 9/11). All three
top causes are shared infrastructure debt, not persona-specific. Fix in ROI order.

Binding frequency across the 11 fails: `A6` 11 · `A7` 9 · `A4` 4 · `A5` 3 · `C4` 1 · `C5` 1.

---

## Fix #1 — ✅ DONE (2026-05-30). Schedule outputs ship `cell: undefined` → false "contract may be stale" (THE #1 A7 binder)

**SHIPPED.** Balances now emit a scalar `cell` (terminal populated cell); `verify-engine`
+ generated `example.mjs` share a `resolveOutput()` helper (scalar / balance-terminal /
summed-flow); INTEGRATION.md renders `cell || cellRange`. pe-buyout verify 8→10 checks,
0 drift; example.mjs prints "(all outputs match ✓)" and the what-if shows outstandingDebt
$63.0M→$66.0M moving. All 12 re-verify 0-drift; npm test green. Original analysis kept below.



**Verified root cause (pe-buyout-associate `chunked/named-outputs.json`):**
schedule outputs have **`cell: undefined`, `baseCaseValue: undefined`** but DO carry
everything needed:
```json
"outstandingDebt": {
  "type": "schedule", "aggregation": "terminal",
  "cellRange": "'Senior Facility'!B4:G4",
  "terminal": 63037000, "terminalYear": 2030,
  "perYear": [177650000,169650000,161650000,153650000,145650000,63037000]
}
```
`lib/verify-engine.mjs:51-53` SKIPS these (`cell == null → continue`), so `ete verify`
shows a clean 8/8 — but the generated **`example.mjs` does NOT skip them**: it iterates
every output and reads `base.values[o.cell]` = `values[undefined]` → prints
`undefined` and counts drift → **"N output(s) drifted — contract may be stale"**, the
exact trust signal GETTING_STARTED tells users to require before handoff. INTEGRATION.md
likewise renders `cell = undefined` rows and an `alt.values[undefined]` snippet.

**The fix (clean, at the source — propagates to verify + example + INTEGRATION at once):**
In `lib/manifest-maps.mjs` where a schedule output object is built, also set:
- `cell` = the **terminal cell** of `cellRange` (last cell; e.g. `B4:G4` → `'Senior Facility'!G4`).
- `baseCaseValue` = `terminal` when `aggregation === "terminal"`, else `sum(perYear)`
  when `aggregation === "sum"` (the `aggregation` field already exists for this).

Then `verify-engine` picks them up and they PASS (the terminal cell genuinely computes
to `terminal` — confirmed: `perYear[last] === terminal === 63037000`, and `G4` is a real
computed cell), `example.mjs` reads a real value (no `undefined`, drift stays 0), and
INTEGRATION.md shows a real cell. **Pure metadata, no engine math.**

**Helper needed:** terminal-cell-of-range. `'Sheet'!B4:G4` → `'Sheet'!G4`. Parse the
range end (handle quoted sheet names). A range like `B4:B9` (vertical) → `B9`.

**Acceptance:** regenerate pe-buyout (`node tests/personas/generators/pe-buyout-associate.mjs
engines/_personas/pe-buyout-associate/model.xlsx && node cli/index.mjs init … && node …/example.mjs`),
confirm `example.mjs` prints `(all outputs match baseCaseValue ✓)` with the two schedule
rows now showing 63,037,000 not `undefined`. Add an assertion to `tests/cli/test-onboarding.mjs`
that no named output has `cell:undefined`/`baseCaseValue:undefined` and that example.mjs
reports 0 drift. Estimated to clear A7 for ~8 personas.

**CAVEAT to check while here:** pe-buyout's `equityBase` schedule has the SAME cellRange
as `outstandingDebt` (`'Senior Facility'!B4:G4`) — equityBase is mis-mapped onto the debt
row. That's a manifest-detection bug (separate from this metadata fix); note it but don't
let it block #1.

---

## Fix #2 — ✅ DONE (2026-05-30). Static-literal headline returns (THE #1 A6 binder)

**SHIPPED.** Root cause was generator-side (the engine already supports live IRR via
`transpiler.rs` → `_helpers.mjs computeIRR/computeXIRR`). Rewrote vc/infra/fof generators
to use real `=IRR()` over live cash-flow rows: vc gains a `TopCompanyExit` power-law
lever (grossIRR 0.112→0.162, MOIC 1.82→2.16), infra's grossIRR/MOIC go live on existing
RevEsc/ExitYield/InterestRate (0.168→0.198), fof gains a `TopFundNAV` mark lever
(grossIRR 0.155→0.172, TVPI 2.03→2.16). All 12 re-verify 0-drift; npm test green.
DPI correctly stays NAV-independent (realized cash). Original analysis below.



`grossIRR/netIRR/tvpi/dpi/MOIC` are hardcoded literal cells, so no lever cascades into
them → the summary shows them `— static` and the "what-if explorer" has no working dial
on the numbers that matter. Crushes FoF/VC/infra (A6=2). This is backlog "multi-sheet IRR
de-literalization": compute IRR/XIRR/TVPI from the cashflow `perYear` schedule at `run()`
time (helpers in `sheets/_helpers.mjs`) OR emit the cashflow series as a named output and
document a consumer-side `computeXIRR`. The engine already exposes `perYear` schedules, so
the data path exists. Also surfaces e.g. infra MOIC `Investor Summary!B16 = 6.73x` currently
shown as a dash. Lifts A6 2→4 for 3-5 personas.

---

## Fix #3 — Inert / duplicate levers

Headline drivers (`ExitCapRate`, `ExitYield`, `ExitMultiple`) ship with
`affectsOutputs: []` while a twin entry on the SAME cell holds the real closure → the
named slider looks dead. In re-valueadd the cap-rate slider (the whole project) is inert;
in credit `exitMultiple` points at a derived formula cell (a fake lever that snaps back).
Collapse to one canonical lever per cell with the real `affectsOutputs` closure; drop
pseudo-levers pointing at formula cells. Lifts A6 and removes the searchfund C4 fail.
Flips re-valueadd, searchfund, RE-debt (~3).

### Fix #3 — ✅ DONE (2026-05-30). Implemented `dedupeInputsByCell` in lib/manifest-maps.mjs

**SHIPPED.** Post-closure dedup-by-cell keeps the defined-name identity + union of
affectsOutputs. 6 personas fixed (ExitCapRate/ExitYield/ExitMultiple/ExitRevenueMultiple
aff 0→real); re-debt correctly not merged (different cells). No duplicate-cell levers remain;
test-dedupe-inputs.mjs (10 assertions) in npm test; full suite green. Design below.

### Original design (diagnosed 2026-05-30)

CONFIRMED duplicate-cell levers (from `named-inputs.json`, two personas, same shape):
- re-valueadd `Deal Assumptions!B4`: `ExitCapRate`(aff=0, src=defined-name) +
  `exitMultiple`(aff=4, src=manifest-driver)
- infra `Assumptions!B10`: `ExitYield`(aff=0, src=defined-name) +
  `exitMultiple`(aff=4, src=manifest-driver)

ROOT CAUSE: `enumerateInputCells` / the named-input emitter in `lib/manifest-maps.mjs`
adds BOTH (a) the manifest-driver levers (`exitMultiple`/`exitYearSelector`/`hurdleRate`
— these get the real `affectsOutputs` closure from the BFS) AND (b) every workbook
defined-name input. When a defined name (`ExitCapRate`) points at the SAME cell as a
manifest-driver (`exitMultiple` → B4), TWO entries land in `named-inputs.json` for one
cell. The human-recognizable defined-name one shows `affectsOutputs: []` (the closure was
computed under the driver key, not the defined-name key) → the analyst's actual slider
("Exit Cap Rate") looks inert while a cryptic `exitMultiple` twin holds the real wiring.

THE FIX (dedup-by-cell with closure union, in lib/manifest-maps.mjs):
After both input sets are built and closures baked, collapse entries that share a `cell`:
keep ONE canonical entry per cell, preferring the **defined-name's human name + excelName**
(what the analyst recognizes) but carrying the **union of affectsOutputs** (so it's not
inert) and the richest format/min/max/step. Drop the redundant twin. Pseudo-code:
```
const byCell = new Map();
for (const [name, v] of Object.entries(namedInputs)) {
  const prev = byCell.get(v.cell);
  if (!prev) { byCell.set(v.cell, [name, v]); continue; }
  // merge: prefer defined-name identity, union the closures
  const [pn, pv] = prev;
  const keepDefined = v.source === 'defined-name' ? [name, v] : [pn, pv];
  const other = v.source === 'defined-name' ? [pn, pv] : [name, v];
  const merged = { ...other[1], ...keepDefined[1],
    affectsOutputs: [...new Set([...(pv.affectsOutputs||[]), ...(v.affectsOutputs||[])])],
    excelName: keepDefined[1].excelName || other[1].excelName };
  byCell.set(v.cell, [keepDefined[0], merged]);
}
// rebuild namedInputs from byCell (one entry per cell)
```
EDGE CASES: (1) keep insertion order stable for INTEGRATION.md readability; (2) if a
manifest-driver points at a FORMULA cell (not a literal input) it should be DROPPED, not
merged — a derived cell can't be a real lever (the recon noted credit's `exitMultiple`
points at a derived cell; confirm against cell-types.json and drop if type!=='number'
literal). (3) Don't merge across different cells that happen to share a name.

VERIFY (needs reliable channel): regenerate all 12, assert no two named-inputs share a
cell, assert ExitCapRate/ExitYield now carry aff>0; re-run the affected personas' summary;
npm test green; add a test-manifest-maps assertion (no duplicate-cell inputs + the
defined-name retains the closure).

---

## Fix #4 — ✅ DONE (2026-05-30, commits 74761a0 + regression f193972). Model-type misclassification (root of accuracy failures)

**SHIPPED.** Added credit/fund_of_funds/search_fund/infrastructure/real_estate_debt to
detectModelType + fixed the `/arr/`→`/\barr\b/` substring bug (was matching "carried"/
"arrangement" → credit/search misread as saas); mapped the new types through detectLens +
exitBasis + the cap_rate_inverse→"debt yield" exit string. All 12 classify correctly:
credit→"1.8x EBITDA", search→"5.5x EBITDA", RE-debt→"13.2% debt yield" (all were wrong);
pe_fund/saas/venture/re_fund unchanged. New test-model-type.mjs (10 assertions) wired into
npm test; full suite green. saas-CAGR remains a SEPARATE bug (see note below). Design below.



**Precise design (investigated 2026-05-30; implementation deferred to a clean tick —
do NOT half-apply: it touches two shared functions and needs all-12 + npm test
verification, which a flaky Bash channel blocked this tick).**

Current detected types (4 wrong): credit→`saas`, searchfund→`saas`, fof→`saas`,
corp→`unknown`, ma→`unknown`; growth→`saas` (OK, it IS saas-ish), infra→`re_fund`
(acceptable). Accuracy-FALSE personas (from the structured scoreboard, 4 not 5):
credit, saas-growth, searchfund, realestate-debt.

Root cause (traced in code, not just symptom):
- `detectModelType` (lib/manifest.mjs:715-760) scores only 7 types — there is NO
  `credit`/`fund_of_funds`/`search_fund`/`infrastructure`, so those fall through to
  whatever weak signal hits (credit/search/fof all land on `saas`).
- `detectLens` (cli/commands/summary.mjs:324-335) reads `manifest.model.type`. credit
  shows "@1.8x **Revenue**" because type=saas → the `t==='saas'` branch (line 332) →
  `exitBasis()` (line 346) returns 'Revenue'. The `credit` lens DOES exist (line 329)
  but only fires on `covenants.length>=2`, which aren't being detected on these models
  — so **type is the binding cause**, and editing detectModelType alone routes credit
  to the `equity` lens (→ 'EBITDA' basis, better but not ideal).

TWO-PART fix (both required):
1. `lib/manifest.mjs` MODEL_TYPES + detectModelType: add `credit`, `fund_of_funds`,
   `search_fund`, `infrastructure` with signals. Suggested (tune against all 12; keep
   existing weights so currently-correct types don't regress):
   - credit: /unitranche|direct lending|\bOID\b|call protection|spread.*(bps|over)|
     debt yield|interest coverage|\bICR\b|leverage.*ebitda|loan to/ (+3); guard:
     borrower-EBITDA + a lender yield, NOT equity carry.
   - fund_of_funds: /fund.?of.?funds|\bFoF\b|underlying fund|uncalled|unfunded
     commitment|blended (tvpi|dpi|irr)/ (+3). NOTE overlaps VC (TVPI/DPI) — require an
     FoF-specific token (underlying/uncalled/commitment) to beat venture_portfolio.
   - search_fund: /search fund|\bSDE\b|seller note|\bSBA\b|searcher|stepped equity/ (+3).
   - infrastructure: /availability|concession|contracted revenue|escalat|project
     debt|\bCFADS\b|renewable|\bPPA\b/ (+3).
2. `cli/commands/summary.mjs` detectLens: map `t==='credit'`→'credit';
   `t==='fund_of_funds'||t.includes('fund')`→'fund'; `t==='search_fund'`→'equity'
   (EBITDA/SDE basis, NOT revenue); `t==='infrastructure'`→'realestate' OR a new
   'infra' lens (NOI/yield basis). Also extend `exitBasis()`: credit → 'EBITDA'
   (leverage turns) or 'Debt/EBITDA'; search → 'EBITDA / SDE'; re-debt → ensure the
   exit "13.2% cap rate" renders as "debt yield" (it's `cap_rate_inverse` today but the
   label should be yield for a debt model — gate on credit/debt lens).

NOTE: saas-growth's accuracy failure is NOT model-type (it IS saas) — it's a CAGR
conflation (30.2% Revenue-segment CAGR pinned to the ARR row; ARR CAGR is 39.3%). That's
a separate segment/CAGR-labeling bug, track under its own item, do not fold into #4.

VERIFY (mandatory, needs reliable Bash): regenerate is NOT required (type is detected at
init from the existing .xlsx) — just re-run `node cli/index.mjs summary <each>` for the 4
failing personas to confirm corrected headers, re-run all 12 via run-prep (drift unaffected
by type but confirms no crash), and `npm test` green. detectModelType has NO unit test today
— add one in test-manifest-improvements or a new test asserting the 4 corrected types.

REGRESSION GUARD: the only persona currently passing the gate is growth-equity-vp (saas
lens) — confirm it still detects saas and still passes after the change.

---

### Original analysis

credit/search/RE-debt/FoF mis-tag as `saas`/`unknown`, leaking SaaS/equity labels onto
non-equity headlines: credit "@ 1.8x Revenue" is exit leverage (Debt/EBITDA); RE-debt
"13.2% cap rate" is a debt yield; searchfund "@ 5.5x Revenue" is an EBITDA/SDE multiple;
saas CAGR 30.2% pinned to ARR when ARR CAGR is 39.3%. Right number, wrong label = the
rubric's most serious class (these are the `accuracyVerified=false` personas). Improve
`detectModelType` (`lib/manifest.mjs`) to recognize LBO/credit/FoF/search/corporate-budget
signatures; prerequisite for trustworthy A5 on the harder half of the panel.

---

## Fix #5 — ✅ DONE (2026-05-30). CLI papercut: dir-commands don't auto-resolve `chunked/`

**SHIPPED.** `loadGroundTruth` (lib/manifest.mjs) now mirrors `loadManifest`'s `chunked/`
fallback (the relative `./_ground-truth.json` resolves at either level) + remediation hints
+ new `resolveModelDir()` helper. `ete summary <parent>` works (was the dead-end); chunked/
still works; bogus dir exits non-zero with a clear message. test-onboarding locks both forms
(15/15). Original analysis below.



`summary <dir>` (and pnl/scenario/etc.) require `<dir>/chunked/` and else error
"Ground truth not found" with no remediation, while `verify` auto-resolves it
(`cli/commands/verify.mjs:16-20 resolveChunked()`) and GETTING_STARTED's examples point
at the parent. The first documented command dead-ends a non-coder (confirmed:
`summary <parent>` errors, `verify <parent>` works). **Fix:** give every dir-taking
command the same `resolveChunked()` (lift it to a shared `lib/` helper), or at minimum
change the error in `lib/manifest.mjs:147` to "No ground truth in <dir>. Did you mean
<dir>/chunked/ ?". Cheap, high-impact A2/A4.

---

## Engine bugs found in parallel (circular axis — see HARD-WAVE-FINDINGS.md)

F3 divergent cycles return silent garbage but report `converged:true`; F4 intra-sheet
cycles emit no real `meta` telemetry (`perSheetIterations:{}`). These feed the lock-grade
engine work (#22 / Mippy T-078). Fix: honest non-convergence contract + intra-sheet
telemetry in `chunked_emitter.rs`, gated by smoke/test:engine/test:runnable/test:lazy-engine.

---

## Fix #1 — exact implementation spec (ready to apply on a clean tick)

Root cause fully traced (grep-verified line refs; the `Read` tool was corrupting
views of `lib/manifest-maps.mjs` this tick, so the edit was deliberately NOT applied
under unreliable reads — apply when reads are clean and re-confirm each line).

Three coordinated edits:

1. **`lib/manifest-maps.mjs`** (schedule builder, ~lines 384–416):
   - In the `for (const col of cols)` loop, track the address of the last populated
     cell: `let lastAddr = null;` and set `lastAddr = addr;` inside the
     `if (typeof value === 'number')` block (right after the `perYear.push`).
   - In the emitted `result[name] = { … }` object, for BALANCE schedules add a scalar
     `cell: lastAddr` (the terminal *populated* cell — NOT `terminalCellOf(cellRange)`,
     because e.g. `equityBase` has cellRange `Returns!B6:G6` but only B6 is populated;
     the last-populated addr is the correct scalar). Balance ⇒ `values[cell] ===
     baseCaseValue` (verified: outstandingDebt G4=63037000, equityBase B6=74613000).
     Flows (aggregation 'sum') keep NO scalar `cell` — no single cell equals the sum.
2. **`lib/manifest-maps.mjs`** (closure-baking, ~lines 803–806): make the dependency
   target collection expand `cellRange` even when `cell` is now also present, so adding
   `cell` to balances doesn't narrow the closure:
   `if (typeof out.cellRange === 'string') targets.push(...expandRange(out.cellRange));`
   `if (typeof out.cell === 'string') targets.push(out.cell);` (Set dedupes.)
3. **`lib/verify-engine.mjs`** (line 66) + **`lib/integration-doc.mjs`** (renderExample
   ~289–314, renderMarkdown table ~150–157): stop SKIPPING schedules. Add one shared
   reader: `scalarFromValues(o, values)` = `values[o.cell]` if `o.cell`; else expand
   `o.cellRange`, take numeric values, return `sum` (flows) or last (terminal). Use it
   in verify's compare loop AND in the generated example's drift loop, and render
   `o.cell ?? o.cellRange` in the INTEGRATION.md Cell column. This makes `ete verify`
   and `example.mjs` AGREE (today verify skips → 8/8 clean, example reads
   `values[undefined]` → false "contract may be stale"), and covers flows too.

**Contract impact (Mippy):** additive only — balance schedule outputs gain a `cell`
field; `type:'schedule'`, `cellRange`, `perYear`, `baseCaseValue`, `aggregation` all
unchanged. Safe for the engine-service consumer ([[project_mippy_contract]]).

**Acceptance:** regenerate pe-buyout → `init` → `node …/example.mjs` prints
`(all outputs match baseCaseValue ✓)` with outstandingDebt/equityBase showing real
$ not `undefined`; `ete verify` checks 10/10 (was 8/8, +2 schedules) drift 0; add a
`test-onboarding.mjs` assertion that no named output has `cell===undefined &&
baseCaseValue!=null` unhandled and example.mjs reports 0 drift; `npm test` green.
Then re-run the journey workflow and measure the A7 lift (expected to clear A7 for
~8 personas).

**Separate manifest-detection bug (do NOT fold into Fix #1):** pe-buyout `equityBase`
shares cellRange `Returns!B6:G6` with the equity-invested row and has only 1 perYear
point — equityBase is mis-mapped onto a scalar row. Track under model-type/detection.

> STATUS (2026-05-30): root causes VERIFIED empirically; the source edit was held
> because the `Read` tool corrupted `lib/manifest-maps.mjs` views twice this tick
> (fabricated a `result_entry_placeholder` line, falsely reported EOF at 419 vs the
> real ~1109). Do NOT edit that file until a Read returns it cleanly (cross-check
> against `grep -n`). Everything else this tick (scoreboard, findings, dataset,
> cleanup) is complete and correct.

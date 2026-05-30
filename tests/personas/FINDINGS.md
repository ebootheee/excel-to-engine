# Persona simulation — findings & Wave 2 plan

Synthesized from Workflow A (12 synthetic models, all drift-free) + Workflow B
(journeys + coding-agent handoffs). Ordered by benchmark impact. The benchmark
gate (see `lib/rubric.md`) needs trustworthy summaries (A5), no scary false
errors (A2/A4), and the headline metrics present in the contract (C3/C4/C5).

## P0 — benchmark-blocking, broad

1. **Fund-level LP metrics dropped from the contract AND the summary** (VC, FoF —
   the personas for whom TVPI/DPI/RVPI/netIRR ARE the headline).
   `enumerateOutputCells()` (lib/manifest-maps.mjs) never walks
   `manifest.fundLevel`; `summary.mjs` never prints a fund-multiples block;
   `inferFormat()` doesn't tag tvpi/dpi/rvpi as `multiple`. → emit fundLevel as
   named outputs + a summary LP block + format.

2. **Summary fabricates "Platform EBITDA" on non-PE models** (RE/infra/credit/
   FoF/debt). With no EBITDA row it sums NOI rows — and double-counts when both
   components AND a subtotal row are tagged segments (debt-cfo: 3 NOIs + the
   consolidated subtotal = 2×). → only show an EBITDA/NOI line when a real
   profit/NOI output exists; make the label/units match; drop subtotal rows.

3. **Segment detector over-grabs non-revenue rows** (≈all personas): COGS, OpEx,
   Interest Expense, taxes, Net Income, and pure ratio rows (DSCR, Debt Yield,
   Leverage, Revenue Growth %) all listed as "Segments", ratios shown with $ and
   bogus CAGRs. → exclude ratio/below-the-line/subtotal rows; classify type
   properly (taxes≠revenue).

4. **Doctor false-quarantines cap-rate / exit-yield outputs** (RE, infra). A
   `cap_rate_inverse` exitMultiple (0.0525) or "Exit Yield" (0.085) is validated
   against the exitMultiple range [1,50] → ERROR + quarantined to null on a clean
   model. → doctor must validate by the output's `type` (cap_rate_inverse →
   capRate range); exit-multiple detector should classify yield/cap-rate wording
   as cap_rate, not multiple.

5. **Summary header hardcodes "EBITDA"** for the exit multiple regardless of
   basis: "@ 7.5x EBITDA" on a revenue-multiple (growth/SaaS), leverage ratio
   (credit), or cap rate (RE). → label the basis from the output type.

6. **Multiple equity classes suppress headline returns** (searchfund): when >1
   class is detected, summary only prints class-prefixed outputs, so the
   un-prefixed Returns table shows "—" even though class-1 MOIC/IRR are correct.
   → when only one class carries returns, surface them un-prefixed.

## P1 — trust/clarity

7. **Review-checklist false positives**: "No EBITDA/NOI output" / "No equity
   classes" nagged for growth/VC/FoF/credit where those are valid absences. →
   model-family-aware checklist + refiner coverage scoring.
8. **terminalValue first-match-wins picks wrong cell** (corp DCF picked "PV of
   Terminal Value" over "Terminal Value (Gordon growth)"). → prefer the cleanest
   exact label; deterministic row order.
9. **Period off-by-one**: 5 columns reported as "4yr" (uses exitYear−investYear,
   not column count).
10. **example.mjs vs verify-engine tolerance mismatch** — example flags drift
    that verify clears for the same value. → share tolerance (absTol 1e-6).
11. **humanize() garbles acronyms**: FoF→"Fo F", NewARRGrowth→"New ARRGrowth".
12. **run() silent no-op on a wrong override key** (excel-name or nested shape
    returns base case). `unknownOverrides` exists but isn't surfaced to humans;
    INTEGRATION.md should warn that overrides are by CELL address.

## P2 — deeper (assess after B scores; benchmark uses run(), not cascade)

13. **Delta-cascade scenario/sensitivity wrong on some models** (ma-sellside:
    no-op scenario 15.6x vs base 2.57x; sensitivity inflated ~6×). engine.run()
    override path is correct. Affects analyst CLI exploration, not the app.
14. **Engine intra-sheet row-major eval** — forward refs (later row, or same-row
    later col) silently read 0. Standard column=time/row=metric layout is safe;
    documented. Real fix = topo-sort non-cyclic intra-sheet cells in the Rust
    emitter (gate with smoke + engine suites; Mippy depends on run()).
15. **Model-type misclassification** (pe_buyout→pe_fund, growth/credit/search/
    FoF→saas). Drives wrong summary framing + scaffolding.
16. **Row-shaped outputs omitted from named-outputs** (corp ebitda time-series
    has no scalar cell). → derive an exit-year scalar.
17. **modelTitle = filename**, not workbook title; **exitDebt** only one facility.

## Resolution status (Waves 2–3)

Baseline 2/12 → Wave 2 **3/12** (avg woah 3.50→3.92, exactly 3.33→3.83). Wave 3
targets the residual A5-trust cap + handoff gaps:

- ✅ P0-1 fund metrics in contract + summary (Wave 2)
- ✅ P0-2/3 fabricated EBITDA / segment over-grab (Wave 2 summary lens)
- ✅ P0-4 doctor cap-rate false-quarantine (Wave 3)
- ✅ P0-5 exit-multiple basis label (Wave 2)
- ✅ P0-6 multi-class headline suppression (Wave 2)
- ✅ **Coverage "2/8 / Missing…" PE-yardstick trust-killer** → family-aware (Wave 3)
- ✅ P1-9 period off-by-one, P1-10 example tolerance, P1-11 humanize (Wave 2)
- ✅ input min/max/step + format incl NRR>1 & LTV/leverage (Wave 2–3)
- ✅ contract refresh catch-22 (`manifest set` self-refreshes, closures preserved) (Wave 3)
- ✅ `outputs.*` promotion so `manifest set outputs.x` reaches the contract (Wave 3)
- ✅ P2-13 delta-cascade: honesty warning when it can't reproduce base (Wave 3)
- ⏳ P2-14 engine intra-sheet topo-sort (deep Rust; documented + verify catches)
- ⏳ P2-15 model-type classification (lens compensates for display)
- ⏳ static literal IRR/MOIC in some synthetic models (model-authoring + engine)
- ⏳ per-year time-series outputs (credit/debt monitor) — new feature
- ⏳ non-defined-name driver levers (corp budget) — new feature

## Process note
Do NOT edit cli/ or lib/ while a journey/model workflow is running — live edits
confound the agents' results (observed: "Platform EBITDA unstable across runs"
was caused by editing annual-aggregator.mjs mid-run). Land Wave 2, then re-run.

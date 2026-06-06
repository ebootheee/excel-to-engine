# Handoff — lite package (ADR-027) + cone re-gate (ADR-026 Tier 2)

**As of 2026-06-05. Everything below is on `main` unless noted. Two threads are open for the next agent.**

## What just landed on main (context)
- **Wave 2 engine-speed (PR #41, `de2261b`):** L0 `lib/scope-plan.mjs` (`buildScopePlan`/`buildFullPlan`,
  `activeOrder`), `lib/cell-exprs.mjs`, `lib/cone-emit.mjs` (scoped cone module = ADR-026 Tier 2 +
  whole-model full executor), efficacy harness `scoped`/`cycle` variants, `ete init --emit-cones`
  (**EXPERIMENTAL**). Synthetic: 113 tests green. Real-A1 cone gate **FAILED** — but it caught a real
  upstream bug, not a cone flaw.
- **Transpiler root-cause fix (PR #43, `431d7f6`):** the `COL$ROW` mixed-ref bug (`expr * `COL`` →
  `number * "DB"` = NaN; **240,973 cells** on A-1, formula tails silently dropped). Fixed in
  `formula_ast.rs` (+ `Expr::Name` → numeric-safe `null` for genuinely-unresolved names). Verified at
  scale (regenerated outpost-a1 → string-multiplies **240,973 → 0**). cargo 23/23, smoke 126/126, npm green.
- **Closed as superseded:** #42 (duplicate of #43; its e2e test salvaged into #43), #37 (override-lock
  already shipped via `emit_run_function` `ctx._locked`).

## Thread A — RE-GATE the real-model cone (ADR-026 Tier 2) — STILL BLOCKED (on #47)
**CORRECTION (2026-06-06 triage):** the `COL$ROW` fix (#43) was necessary but NOT sufficient. The prior
re-gate is VACUOUS — scope output `GPP Promote!KU159` ≡ 0, so the `0==0` PASS proves nothing, and the
full-engine override OOM'd (~7.2 GB). And **#47 date-axis float drift** (`*30.44` month-step → exact-match
SUMIFS date keys miss → the MIP/returns cone collapses to 0/NaN) was predicted to make any re-gate fail;
it is now FIXED on `main` (PR #51) but a STALE A-1 build will NOT show it. The cone machinery reproduces
the engine faithfully, so once #47 is in the rebuilt binary it *should* converge — verify, don't assume.
**Do this (in order):**
0. Rebuild A-1 from the **post-#51** parser (the date-serial fix must be in the binary), and re-gate on a
   **NON-ZERO, lever-sensitive** output (NOT `KU159`) with a **base-case-only** compare.
1. Rebuild the A-1 chunked artifact with the fixed parser **and the dependency graph**:
   `node --max-old-space-size=20480 cli/index.mjs init engines/Outpost-A-1.xlsx --output <tmp> --emit-cones --emit-debug`
   (the `Outpost-A-1.xlsx` IS in the checkout — `engines/Outpost-A-1.xlsx`, 77 MB; parse ≈ 65 s, then
   the cone build's `buildScopePlan` ≈ **20 min / ~16 GB** — see the cost caveat in PLAN-engine-speed).
2. Diff the emitted cone vs ground truth AND vs `engine.run({})` for the scope outputs (UW IRR/MOIC,
   terminal value), within 1e-6. The cone's **contract** is cone == full engine (ADR-026 invariant #5),
   so cone-vs-engine is the authoritative check; cone-vs-GT also exercises engine-vs-Excel fidelity.
3. **If it converges + matches:** lift the EXPERIMENTAL label on `init --emit-cones` (cli/index.mjs +
   cli/commands/init.mjs Step 5d) and update ADR-026 / PLAN-engine-speed (drop the gate-finding caveat).
4. **If it still drifts:** characterize the next blocker the same way (the earlier gate used
   `buildCone` on the scratch graph + a manifest-derived scope; pinpoint the first non-finite active
   cell and inspect its reads — that's how the `* COL` bug was found).
- **Wave-3 follow-ons (separate):** speed the cone BUILD (cache the CSR / streaming extraction so
  `buildScopePlan` isn't 20 min); port L1 cell-level cycle resolution into `chunked_emitter.rs` so the
  *default* engine is cell-level (the JS `buildFullExecutor` is the reference oracle); #33 row-chunking.

## Thread B — BUILD the lite package, Phase 1 (ADR-027)
Design is **accepted** (`docs/adr/ADR-027`); pressure-tested. Decisions locked by the user:
- **Tier-1 sampling** = delta-cascade default (no-Rust, disclosed approximation + r² floor + spot-check
  vs engine) + analyst-re-saved-`.xlsx`-variant exact upgrade. **Do NOT** add a JS recalc dep (SheetJS
  can't recompute — that's the load-bearing finding).
- **Two personas, one skill** (analyst → Tier 0/1 default; app-integrator/Mippy → Tier 2 cone default).
- **Packaging:** curated `ete lite` entrypoint + a published skill — NOT a separate npm package yet.
- **Safety (non-negotiable):** auto-escalate any output with a detected breakpoint (carry near a hurdle,
  MIP near a threshold) to the cone — reuse `lib/sensitivity.mjs` breakpoint detection; output-class r²
  floors (0.99 monetary/carry, 0.97 IRR/MOIC). Stamp every artifact with `modelHash` + refuse-on-mismatch.

**Phase 1 (start here) = the Tier-0 closed-form proof** (the smallest thing that proves the package can
exist, no Rust): `lib/lite-tier0.mjs` — read a handful of cells (`lib/excel-parser.mjs` / a chunked dir),
bind to `lib/waterfall.mjs` (`computeWaterfall` + `createAmerican/European/MoicHurdleWaterfall`) +
`lib/irr.mjs`, emit a tiny params JSON + a standalone `run()` shim, **calibrate** vs the model's base case
(`lib/calibration.mjs`). Test on a real manifest (e.g. `engines/outpost-a2-v3` has `totalCarry` at
`GPP Promote!D180` + `hurdleRate` coupling). Then the remaining ADR-027 increments (driver-scope,
evaluator adapters, Tier-1 surrogate + honesty gate, recommender, provenance, the guiding skill).

Branch off `main` (ADR-027 is already on main). ~70 % of the ladder already exists — see ADR-027 §"What
already exists" for the reuse map.

## Gotchas / state to know
- `buildScopePlan` on A-1 is **~20 min / ~16 GB** (intrinsic full-graph CSR; cone-size-independent).
  Cone = a one-time BUILD artifact; runtime `cone.run()` is ms. Don't expect interactive cone builds yet.
- Real `Outpost-A-1.xlsx` (77 MB) IS committed-ignored in `engines/`; the 535 MB dependency-graph +
  177 MB GT scratch live at `engines/_scratch_probe/oa1-dbg/chunked/` (gitignored). The `cones/` subdir
  there was a scratch artifact and has been removed.
- Efficacy harness inner loop: `node benchmarks/efficacy.mjs --fixture mini-cyclic --variant scoped --compare baseline`
  (synthetic, seconds, parity-gated). midi-cyclic for the speedup curve.
- Git discipline (repo norm): branch off `origin/main`, small commits, push promptly, PRs, never guess
  hashes, commit/push are solo calls.

## Pointers
`docs/adr/ADR-026` (cone design + Wave-2 gate finding), `docs/adr/ADR-027` (lite ladder + phased plan),
`docs/PLAN-engine-speed.md` (lanes + measured numbers), `CHANGELOG.md` (2026-06-04/05 entries),
`benchmarks/efficacy.mjs` + `benchmarks/EFFICACY.md`, `lib/{scope-plan,cone-emit,cell-exprs,waterfall,irr,sensitivity,calibration}.mjs`.

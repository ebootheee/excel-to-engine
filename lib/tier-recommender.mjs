/**
 * excel-to-engine — ADR-027 Lite Package, Tier recommender (Phase 5)
 *
 * A PURE decision table that maps the front-door answers — (target outputs +
 * use-case + model traits) — to one of the four artifact tiers:
 *
 *   Tier 0  Closed-form   lib/waterfall + lib/irr bound to a few cells   no Rust
 *   Tier 1  Surrogate     sampled fit out = base·∏(1+βᵢΔᵢ) + r²          no Rust*
 *   Tier 2  Scoped cone   ADR-026 `ete init --emit-cones`                Rust + build
 *   Tier 3  Full engine   existing chunked engine                        Rust, 100s MB
 *
 * This module ONLY decides the tier + rationale + escalations + the precision
 * budget. It DOES NOT emit any artifact — Tier 0 via lib/lite-tier0.mjs, Tier 2
 * via `ete init --emit-cones`, Tier 3 via the chunked engine. It is the
 * implementation of ADR-027 §"Phased build plan" item 5 ("Tier recommender …
 * Pure decision table, snapshot-tested").
 *
 * --- The mapping, in one paragraph (see DECISION TABLE comment for the full grid)
 *
 * 1. Pick a PERSONA from the use case (ADR §1, "two personas, one skill"):
 *    one-off / dashboard analyst  → defaults to the Tier 0/1 (cheap, no-Rust) lane;
 *    embed-in-an-app integrator    → defaults to the Tier 2 cone lane.
 * 2. Pick a BASE tier inside that lane from the question pair (target output +
 *    use case) along the §2 ladder.
 * 3. Apply the MANDATORY escalation/cap rules from §5 + the Consequences:
 *      - a detected breakpoint in the swept range forces Tier 2 (the "kink gate"),
 *        regardless of persona — multiplicative surrogates misprice carry near a
 *        hurdle / MIP near a threshold;
 *      - the output class sets the r² FLOOR the precision budget must promise
 *        (0.99 monetary/carry, 0.97 IRR/MOIC, else 0.95) — a budget below the floor
 *        is itself an escalation trigger off Tier 1;
 *      - if Rust is NOT available (or the model can't be re-evaluated honestly:
 *        cyclic / huge / no named ranges), the Rust tiers (2/3) are unreachable and
 *        the cone-requiring cases DOWNGRADE to a *disclosed* Tier 1 surrogate (or
 *        Tier 0 when even surrogate sampling is impossible) — this is the
 *        "integrator default falls back" Consequence.
 *    These rules are NOT silently skippable; each one that fires records an entry
 *    in `escalations[]` so the caller (and the non-technical analyst least able to
 *    catch it) sees WHY the tier moved.
 *
 * @license MIT
 */

// ---------------------------------------------------------------------------
// Enumerations — the precise input domain (also the contract surface).
// ---------------------------------------------------------------------------

/**
 * Use cases (ADR §1, question 3). Each is bucketed into one of two personas.
 *   one-off          — a single what-if an analyst runs once (analyst persona)
 *   dashboard        — a read-only sensitivity view / report (analyst persona)
 *   what-if-grid     — an interactive grid/app the analyst drives (analyst persona,
 *                      but app-shaped: wants a cheap surrogate, not just a level)
 *   embedded-surrogate — embed a coeff surrogate inside another app, no Rust at
 *                      runtime (integrator persona — but explicitly surrogate-shaped)
 *   app-integration  — embed in an app (Mippy) that needs exact targeted queries
 *                      (integrator persona — the cone default)
 */
export const USE_CASES = Object.freeze([
  'one-off',
  'dashboard',
  'what-if-grid',
  'embedded-surrogate',
  'app-integration',
]);

/** Persona buckets (ADR §1, "two personas, one skill"). */
export const PERSONAS = Object.freeze(['analyst', 'integrator']);

/** Output classes that set the r² floor (ADR §5). */
export const OUTPUT_CLASSES = Object.freeze(['monetary', 'carry', 'irr', 'moic', 'mip', 'pnl', 'other']);

/**
 * Output-class r² floors (ADR §5: "r² floors are output-class … not a single
 * global number"). Monetary/carry decisions need the tightest fit; IRR/MOIC a
 * touch looser; everything else a sane default. A surrogate (Tier 1) whose
 * precision budget cannot promise the floor for its tightest output is escalated
 * off Tier 1.
 *
 * ADR §5 states ONLY two floors literally: 0.99 monetary/carry and 0.97 IRR/MOIC.
 * The remaining three are reasoned EXTRAPOLATIONS (not ratified ADR text) and are
 * marked as such so a reviewer can see they are interpolations, not citations:
 *   - mip  → 0.99: a threshold-bonus is monetary-grade money AND kink-prone, so it
 *            inherits the monetary/carry floor (ADR §5 names MIP among the kink-
 *            prone money outputs the gates protect).
 *   - pnl  → 0.97: a P&L line is a reported figure, not a money-distribution
 *            decision — grouped with IRR/MOIC rather than the 0.99 tier.
 *   - other→ 0.95: the sane catch-all default for an unclassified output.
 * If/when the ADR is amended to state mip/pnl/other, this comment becomes a citation.
 */
export const R2_FLOORS = Object.freeze({
  monetary: 0.99, // ADR §5 (literal)
  carry: 0.99,    // ADR §5 (literal)
  mip: 0.99,      // EXTRAPOLATION: monetary-grade + kink-prone → inherits the 0.99 floor
  irr: 0.97,      // ADR §5 (literal)
  moic: 0.97,     // ADR §5 (literal)
  pnl: 0.97,      // EXTRAPOLATION: a reported line, grouped with IRR/MOIC
  other: 0.95,    // EXTRAPOLATION: sane catch-all default
});

// Tier-ladder fidelity/footprint copy (ADR §2) — surfaced in the rationale so the
// caller can show the analyst what each tier promises. Pure metadata, no logic.
const TIER_LADDER = Object.freeze({
  0: { name: 'closed-form', fidelity: 'exact for that structure (calibrated at base)', footprint: 'KB / instant', needsRust: false },
  1: { name: 'surrogate', fidelity: 'reported r² (~0.9–0.99)', footprint: 'KB / multiplies', needsRust: false },
  2: { name: 'scoped cone', fidelity: '1e-6 over driver ranges', footprint: 'few MB', needsRust: true },
  3: { name: 'full engine', fidelity: '1e-6 everywhere', footprint: '100s MB', needsRust: true },
});

// ---------------------------------------------------------------------------
// Helpers — persona, output class, r² floor, Rust honesty.
// ---------------------------------------------------------------------------

/** Map a use case to its persona (ADR §1). */
function personaForUseCase(useCase) {
  switch (useCase) {
    case 'one-off':
    case 'dashboard':
    case 'what-if-grid':
      return 'analyst';
    case 'embedded-surrogate':
    case 'app-integration':
      return 'integrator';
    default:
      return 'analyst';
  }
}

/**
 * Normalize the requested output class(es) to the SINGLE governing class — the
 * one with the highest r² floor (the tightest output drives the budget). Accepts
 * a string class, an array of classes, or the convenience `targetOutputs` shape.
 */
function governingOutputClass(outputClass) {
  const classes = Array.isArray(outputClass) ? outputClass : [outputClass];
  const known = classes.filter((c) => c in R2_FLOORS);
  if (known.length === 0) return 'other';
  // tightest floor wins
  return known.reduce((best, c) => (R2_FLOORS[c] > R2_FLOORS[best] ? c : best), known[0]);
}

/** The r² floor for the governing output class (ADR §5). */
function r2FloorFor(outputClass) {
  return R2_FLOORS[governingOutputClass(outputClass)];
}

/**
 * Can this model be re-evaluated *honestly* without the Rust engine? (ADR §1's
 * hidden 4th evaluator question + §"load-bearing finding": SheetJS can't
 * recompute, so a no-Rust surrogate needs the delta-cascade — which needs named
 * ranges to map levers, breaks on cyclic models, and is impractical on huge ones.)
 *
 * Returns { ok, reasons[] }. `ok=false` means even Tier 1 sampling is unsafe and
 * we must drop to a calibrated Tier 0 (no sweep).
 */
function noRustSamplingFeasible(traits) {
  const reasons = [];
  if (traits.cyclic) reasons.push('model is cyclic — the delta-cascade cannot resolve a fixed point without an iterative engine');
  if (traits.hasNamedRanges === false) reasons.push('no named ranges — levers cannot be mapped to cells for a cascade sweep');
  if (typeof traits.sizeCells === 'number' && traits.sizeCells > HUGE_CELLS) {
    reasons.push(`model is huge (${traits.sizeCells} cells > ${HUGE_CELLS}) — cascade sampling is impractical`);
  }
  return { ok: reasons.length === 0, reasons };
}

// "huge" threshold (cells). Above this, no-Rust cascade sampling is impractical
// and a cone/full path (which needs Rust) is the only honest sweep source. EXTRA-
// POLATION: the ADR does not state a numeric cell threshold; it only cites the
// ~5.8M-cell real models as the motivating size. Chosen well below that, above
// typical lite targets. Not ratified ADR text — tune as real lite targets land.
const HUGE_CELLS = 2_000_000;

// ---------------------------------------------------------------------------
// The public recommender.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ModelTraits
 * @property {boolean}  [hasNamedRanges]      named-input/output ranges discovered (lib/manifest). undefined ⇒ unknown (treated as present)
 * @property {boolean}  [cyclic]              the model has circular references (iterative calc)
 * @property {number}   [sizeCells]           total non-empty cell count (drives the "huge" cap)
 * @property {boolean}  [rustAvailable]       the Rust parser/engine is available in this environment
 * @property {boolean}  [hasBreakpointInRange] a breakpoint was detected in the swept driver range (lib/sensitivity detectBreakpoints) for a target output
 * @property {string|string[]} [outputClass]  output class(es) being targeted (drives the r² floor). Falls back to targetOutputs.
 */

/**
 * @typedef {Object} TargetOutputs
 * @property {string|string[]} [class]  output class(es): 'carry'|'irr'|'moic'|'mip'|'monetary'|'pnl'|'other'
 * @property {string[]}        [names]  optional human names of the outputs (carried into rationale only)
 */

/**
 * Recommend the smallest artifact tier that meets the precision budget.
 *
 * PURE: no I/O, no Date, no randomness — same inputs ⇒ same output (snapshot-safe).
 *
 * @param {Object} req
 * @param {TargetOutputs|string|string[]} [req.targetOutputs] - the outputs in play (class drives the r² floor)
 * @param {string}   req.useCase     - one of USE_CASES
 * @param {ModelTraits} [req.modelTraits] - the hidden-4th-question evaluator facts
 * @returns {{
 *   tier: 0|1|2|3,
 *   persona: 'analyst'|'integrator',
 *   rationale: string,
 *   escalations: Array<{ rule: string, from: number, to: number, mandatory: boolean, detail: string }>,
 *   precisionBudget: { outputClass: string, r2Floor: number, fidelity: string, footprint: string, needsRust: boolean, disclosures: string[] }
 * }}
 */
export function recommendTier(req = {}) {
  const useCase = req.useCase;
  if (!USE_CASES.includes(useCase)) {
    throw new Error(
      `recommendTier: unknown useCase '${useCase}'. Expected one of ${USE_CASES.join(', ')}.`,
    );
  }
  const traits = req.modelTraits || {};

  // --- target output class → r² floor (the precision budget anchor) ---
  const outputClass =
    req.targetOutputs && typeof req.targetOutputs === 'object' && !Array.isArray(req.targetOutputs)
      ? req.targetOutputs.class
      : (req.targetOutputs ?? traits.outputClass);
  const govClass = governingOutputClass(outputClass);
  const r2Floor = R2_FLOORS[govClass];

  // --- persona (ADR §1) ---
  const persona = personaForUseCase(useCase);

  // --- (1) BASE tier from (persona × use case) along the §2 ladder ---
  const base = baseTier(useCase, persona);
  let tier = base.tier;
  const escalations = [];
  const disclosures = [];

  // --- (2) MANDATORY rules (ADR §5 + Consequences). Order matters: caps before
  //     up-escalations, so a no-Rust environment can't end on a Rust tier, and the
  //     kink gate then has the final say WITHIN reachability. ---

  const sampling = noRustSamplingFeasible(traits);
  const rustAvailable = traits.rustAvailable !== false; // undefined ⇒ assume available

  // Defensive coercion of the kink-gate's driving trait. The kink gate is the ONLY
  // non-suppressible protection for kink-prone money outputs, so a wiring mistake
  // (passing a breakpoints array or a count instead of the boolean) must be LOUD,
  // never silently fail-open to "no breakpoint" (finding #7). `undefined` is the
  // legitimate "not detected yet" signal and is handled below; anything else that
  // is not a strict boolean is a caller error.
  if (
    traits.hasBreakpointInRange !== undefined &&
    typeof traits.hasBreakpointInRange !== 'boolean'
  ) {
    throw new Error(
      `recommendTier: modelTraits.hasBreakpointInRange must be a boolean or undefined ` +
      `(got ${typeof traits.hasBreakpointInRange}: ${JSON.stringify(traits.hasBreakpointInRange)}). ` +
      `Pass the result of breakpoint detection as true/false, not an array/count — the kink gate ` +
      `is the only non-suppressible money-safety rule and must not fail open on a wiring mistake.`,
    );
  }
  const breakpointSignalKnown = traits.hasBreakpointInRange !== undefined;

  // (2a) KINK GATE — a detected breakpoint REQUIRES Tier 2, regardless of persona
  // (ADR §5: "auto-escalate ANY output with a detected breakpoint … to Tier 2").
  // This is the strongest UP rule; recorded before reachability so a no-Rust cap
  // can later DOWNGRADE it (with its own disclosure) but never silently drop it.
  // We record the kink as fired whenever a breakpoint is present and Tier 2 is the
  // mandated answer — even when the base ALREADY sits at Tier 2 (the cone-default
  // integrator). In that case the breakpoint is the REASON the cone is now
  // mandatory rather than discretionary, and a downstream no-Rust cap must surface
  // the unresolved-kink risk; so we still stamp a (no-op-on-tier) escalation.
  let kinkFired = false;
  if (traits.hasBreakpointInRange === true && tier <= 2) {
    escalations.push({
      rule: 'kink-gate',
      from: tier,
      to: 2,
      mandatory: true,
      detail:
        tier < 2
          ? `a breakpoint was detected in the swept driver range — a multiplicative ` +
            `surrogate misprices ${govClass} near a hurdle/threshold; ADR §5 forces Tier 2 (cone).`
          : `a breakpoint was detected in the swept driver range — ADR §5 makes the cone ` +
            `MANDATORY (not discretionary) for ${govClass} here; a downgrade would misprice near the kink.`,
    });
    tier = 2;
    kinkFired = true;
  }

  // (2b) r² FLOOR — a Tier-1 surrogate that cannot promise the output-class floor
  // is escalated to the cone (ADR §5: "r² floors are output-class"). Modeled as a
  // gate on the BUDGET, not the achieved fit (we have no samples here): for
  // monetary/carry/mip outputs (floor ≥ 0.99) a plain Tier-1 surrogate is not
  // trustworthy enough on its own.
  //
  // BY-REQUEST CARVE-OUT (ADR §5, ratified 2026-06-06): the ONE exemption. An
  // EXPLICIT `embedded-surrogate` request — the integrator persona knowingly choosing
  // a lightweight coeff surrogate to embed — MAY ship a 0.99-class output as Tier 1
  // UNDER LOUD DISCLOSURE; the requester has accepted the floor risk. This is NOT
  // "surrogate everywhere" (still rejected): it fires ONLY on an explicit request,
  // never by default, and the KINK GATE above still overrides it (a detected
  // breakpoint already forced Tier 2, so this branch is unreachable when a kink is
  // present). For every OTHER use case the 0.99 floor escalates to the cone.
  let r2FloorFired = false;
  if (tier === 1 && r2Floor >= 0.99) {
    if (useCase === 'embedded-surrogate') {
      disclosures.push(
        `BY-REQUEST SURROGATE BELOW FLOOR: you explicitly requested an embedded surrogate for ` +
        `'${govClass}' (r² floor ${r2Floor}); a base-case-calibrated surrogate cannot promise that ` +
        `floor. Per the ADR §5 by-request carve-out this ships as Tier 1 UNDER DISCLOSURE — treat it ` +
        `as INDICATIVE near hurdles/thresholds and re-validate against the cone/engine before money decisions.`,
      );
    } else {
      escalations.push({
        rule: 'r2-floor',
        from: tier,
        to: 2,
        mandatory: true,
        detail:
          `output class '${govClass}' has an r² floor of ${r2Floor}; a base-case-calibrated ` +
          `surrogate cannot promise that floor — ADR §5 escalates to Tier 2 (cone) for an exact ` +
          `answer (the by-request carve-out applies only to an explicit embedded-surrogate request).`,
      });
      tier = 2;
      r2FloorFired = true;
    }
  }

  // (2c) REACHABILITY CAP — if Rust is unavailable, Tiers 2/3 are unreachable. The
  // cone/full requirement DOWNGRADES to a disclosed Tier 1 surrogate (or Tier 0 if
  // even surrogate sampling is impossible). ADR Consequences: "until [the cone is
  // un-gated] the integrator persona's default falls back to the full engine or a
  // disclosed surrogate." This is a CAP, never silently skippable — it records a
  // down escalation AND a loud disclosure.
  if (tier >= 2 && !rustAvailable) {
    const fallbackTier = sampling.ok ? 1 : 0;
    escalations.push({
      rule: 'no-rust-cap',
      from: tier,
      to: fallbackTier,
      mandatory: true,
      detail:
        `Tier ${tier} needs the Rust engine, which is not available here — capping to Tier ` +
        `${fallbackTier} (${fallbackTier === 1 ? 'disclosed cascade-sampled surrogate' : 'closed-form, no sweep'}).` +
        (sampling.ok ? '' : ' ' + sampling.reasons.join('; ')),
    });
    tier = fallbackTier;
    // Branch the disclosure on WHY the tier reached ≥2 — dropping the load-bearing
    // reason here would tell the analyst "the cone was requested" when in fact a
    // safety rule forced it, and would give a carry surrogate the same vanilla note
    // an IRR surrogate gets (finding #8). Kink takes precedence (most dangerous),
    // then the r²-floor (class-specific), then the genuine integrator cone default.
    if (kinkFired) {
      disclosures.push(
        'UNRESOLVED KINK: a breakpoint was detected but the cone (Tier 2) is unreachable without ' +
        'Rust — the delivered ' + (fallbackTier === 1 ? 'surrogate' : 'closed-form') + ' WILL misprice ' +
        'near that hurdle/threshold. Treat results away from the base case as indicative only.',
      );
    } else if (r2FloorFired) {
      disclosures.push(
        `${govClass.toUpperCase()} SURROGATE BELOW FLOOR: output class '${govClass}' needs ` +
        `r² ≥ ${r2Floor}, which a base-case ${fallbackTier === 1 ? 'surrogate' : 'closed-form'} ` +
        `cannot promise; the r²-floor gate forced the cone (Tier 2) but Rust is unavailable so the ` +
        `cone fallback is impossible — treat the delivered ` +
        (fallbackTier === 1 ? 'surrogate' : 'closed-form') + ` as INDICATIVE for ${govClass} ` +
        `decisions, not authoritative.`,
      );
    } else {
      disclosures.push(
        'NO-RUST FALLBACK: the cone (Tier 2, the integrator default) is the right-sized artifact here ' +
        'but Rust is unavailable; this ' +
        (fallbackTier === 1 ? 'surrogate is an approximation (r² disclosed)' : 'closed-form is honest only near the base case') +
        '.',
      );
    }
  }

  // (2d) SAMPLING-FEASIBILITY CAP — Tier 1 needs a no-Rust sweep source (the
  // delta-cascade). If that's not honestly possible (cyclic / huge / no named
  // ranges) AND Rust isn't available to sweep instead, Tier 1 can't be honored;
  // drop to Tier 0 (the load-bearing finding: SheetJS can't recompute).
  if (tier === 1 && !sampling.ok && !rustAvailable) {
    escalations.push({
      rule: 'sampling-infeasible-cap',
      from: 1,
      to: 0,
      mandatory: true,
      detail:
        `Tier 1 needs a no-Rust sweep but it is not feasible (${sampling.reasons.join('; ')}) and ` +
        `Rust is unavailable — capping to Tier 0 closed-form (honest only near the base case).`,
    });
    tier = 0;
    disclosures.push(
      'NO SWEEP AVAILABLE: surrogate sampling is infeasible and Rust is unavailable; ' +
      'the Tier-0 closed-form is calibrated at the base case only.',
    );
  }

  // --- (3) assemble disclosures from the always-on ADR honesty notes ---

  // KINK CHECK NOT RUN — the kink gate is the only non-suppressible protection for
  // kink-prone money outputs (carry/MIP/monetary, floor ≥ 0.99). If the breakpoint
  // signal was never supplied (undefined) AND we are about to ship something that
  // could misprice near a hurdle (a Tier 0/1 closed-form/surrogate), the gate could
  // not evaluate — so treat the ABSENT signal as unsafe-by-default and disclose it
  // loudly rather than fail open silently (finding #7). A Tier 2/3 artifact is the
  // exact answer near a kink regardless, so no disclosure is needed there.
  if (!breakpointSignalKnown && r2Floor >= 0.99 && tier <= 1) {
    disclosures.push(
      `BREAKPOINT CHECK NOT RUN: the kink gate could not evaluate (no breakpoint signal ` +
      `supplied) for output class '${govClass}' (floor ${r2Floor}). A Tier-${tier} ` +
      `${tier === 0 ? 'closed-form' : 'surrogate'} near a carry hurdle / MIP threshold is ` +
      `UNVERIFIED — run breakpoint detection and re-recommend before trusting away-from-base results.`,
    );
  }

  if (tier === 1) {
    disclosures.push(
      'Tier-1 surrogate r² measures fit to the delta-cascade sample, NOT the real model ' +
      '(ADR §4 double-approximation) — spot-check the cascade vs the engine where available.',
    );
  }
  if (tier === 0) {
    disclosures.push(
      'Tier-0 closed-form is calibrated at the base case; it is honest only at/near that base ' +
      '— sweeping across a pref/catch-up kink must escalate to Tier 2 (cone).',
    );
  }
  if (tier === 2 && rustAvailable) {
    disclosures.push(
      'Tier-2 cone is 1e-6 over the driver ranges only; it depends on the Rust transpiler being ' +
      'correct on this model (ADR Consequences: the cone was gated on the transpiler bug).',
    );
  }

  const ladder = TIER_LADDER[tier];
  const rationale = buildRationale({ tier, persona, useCase, govClass, r2Floor, base, escalations, ladder });

  return {
    tier,
    persona,
    rationale,
    escalations,
    precisionBudget: {
      outputClass: govClass,
      r2Floor,
      fidelity: ladder.fidelity,
      footprint: ladder.footprint,
      needsRust: ladder.needsRust,
      disclosures,
    },
  };
}

// ---------------------------------------------------------------------------
// DECISION TABLE — base tier from (use case × persona), before §5 rules.
//
// ADR §2 ladder + §1 personas. The base tier is the SMALLEST artifact that
// answers the question shape; §5 rules then escalate (kink/r²) or cap (no-Rust).
//
//   USE CASE            PERSONA      BASE TIER   WHY (ADR)
//   ------------------- ------------ ----------- -----------------------------------
//   one-off             analyst      0           a single what-if → closed-form is
//                                                 instant + exact for the structure.
//                                                 NB: ADR §1 gives the analyst lane a
//                                                 "Tier 0/1" RANGE; this pins one-off→0
//                                                 (the cheapest end) as the chosen
//                                                 refinement — not literal ADR text.
//   dashboard           analyst      1           a read-only sensitivity VIEW needs
//                                                 the response shape across a range →
//                                                 a cheap surrogate (multiplies); the
//                                                 kink gate upgrades it if a hurdle
//                                                 is in range. NB: ADR §1's analyst
//                                                 "Tier 0/1" range is pinned here to 1
//                                                 (a VIEW needs the response SHAPE, not
//                                                 just a base level) — chosen refinement.
//   what-if-grid        analyst      1           an interactive grid that the analyst
//                                                 drives → surrogate (cheap, no-Rust);
//                                                 app-shaped but analyst-owned
//   embedded-surrogate  integrator   1           explicitly a coeff surrogate to embed
//                                                 (no Rust at runtime) → Tier 1 BY
//                                                 REQUEST as the BASE tier. ADR §5
//                                                 by-request carve-out (ratified
//                                                 2026-06-06): an EXPLICIT request MAY
//                                                 keep a monetary/carry/mip (0.99-floor)
//                                                 output at Tier 1 UNDER DISCLOSURE —
//                                                 the ONE floor exemption (not
//                                                 "surrogate everywhere"). The kink
//                                                 gate still overrides it: a detected
//                                                 breakpoint forces Tier 2 regardless.
//   app-integration     integrator   2           embed in an app (Mippy) needing
//                                                 exact targeted queries → the scoped
//                                                 cone is the integrator default
//
// Tier 3 (full engine) is never a BASE recommendation here — it's the universe's
// fallback, reachable only by the no-Rust cap inverting (i.e. it's the thing the
// cone replaces). The recommender's job is the RIGHT-SIZED artifact; Tier 3 is the
// un-sized baseline and is surfaced via escalation detail, not chosen as a target.
// ---------------------------------------------------------------------------

function baseTier(useCase, persona) {
  switch (useCase) {
    case 'one-off':
      return { tier: 0, why: 'a single what-if → closed-form (instant, exact for the structure)' };
    case 'dashboard':
      return { tier: 1, why: 'a read-only sensitivity view needs the response shape across a range → cheap surrogate' };
    case 'what-if-grid':
      return { tier: 1, why: 'an interactive analyst-driven grid → cheap no-Rust surrogate' };
    case 'embedded-surrogate':
      return { tier: 1, why: 'an explicitly requested coeff surrogate to embed (no Rust at runtime); the ADR §5 by-request carve-out keeps a 0.99-class at Tier 1 under disclosure, but the kink gate still overrides it' };
    case 'app-integration':
      return { tier: 2, why: 'embed in an app needing exact targeted queries → the scoped cone (integrator default)' };
    default:
      // unreachable (validated in recommendTier), defensive default
      return { tier: persona === 'integrator' ? 2 : 0, why: 'persona default' };
  }
}

function buildRationale({ tier, persona, useCase, govClass, r2Floor, base, escalations, ladder }) {
  const head =
    `${persona} persona, use case '${useCase}', target output class '${govClass}' (r² floor ${r2Floor}). ` +
    `Base tier ${base.tier}: ${base.why}.`;
  if (escalations.length === 0) {
    return `${head} No escalations — Tier ${tier} (${ladder.name}): ${ladder.fidelity}, ${ladder.footprint}.`;
  }
  const chain = escalations
    .map((e) => `${e.rule} [${e.from}→${e.to}]: ${e.detail}`)
    .join(' ');
  return `${head} ${escalations.length} mandatory rule(s) applied → ${chain} Final: Tier ${tier} (${ladder.name}).`;
}

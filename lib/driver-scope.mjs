/**
 * excel-to-engine — Driver Scope Selection (ADR-027 Phase 2)
 *
 * Given a PLUGGABLE evaluator (inputs)=>outputs and a set of candidate input
 * ranges, this picks — PER target output — the SMALLEST set of input "drivers"
 * whose cumulative variance-explained reaches a threshold (ADR default 0.9), and
 * raises a MANDATORY Tier-2 escalation flag whenever a selected driver shows a
 * detected breakpoint (a hurdle/MIP kink) OR the r2 floor is not met.
 *
 * It does NOT re-implement sweeping: lib/sensitivity.mjs is the sampling spine.
 * driver-scope calls extractSurface ONCE in mode:'independent' (one-input-at-a-
 * time) and only READS surface.points + surface.baseCaseOutputs, then reuses
 * detectBreakpoints verbatim for the kink gate.
 *
 * ─── HONESTY / PROVENANCE (read before trusting an r2) ────────────────────────
 *  • EVALUATOR-DEPENDENT r2: r2 here measures linear fit to whatever the pluggable
 *    evaluator returns. If the evaluator is a delta-cascade approximation (the
 *    increment-3 adapter), the r2 is fit-TO-CASCADE, not fit-to-model. This file
 *    returns NO provenance stamp; the CALLER (tier-recommender / surrogate
 *    emitter) is responsible for recording the evaluator source and spot-checking
 *    cascade-vs-engine error alongside r2. Do NOT present r2 as model fidelity.
 *  • INDEPENDENT (one-at-a-time) DESIGN MISSES INTERACTION/MULTICOLLINEARITY: each
 *    per-input r2 comes from a disjoint single-input sweep. Two correlated levers
 *    that only jointly drive an output will be under-ranked. extractSurface only
 *    supports a true cross grid for EXACTLY 2 inputs, so a joint multivariate R2 is
 *    out of scope. This is the correct, defensible "which levers move this output"
 *    notion — it is NOT a partitioned ANOVA of a joint model. Disclosed, not solved.
 *    SHARPER CONSEQUENCE (read this): a MULTIPLICATIVELY-ESSENTIAL co-driver can be
 *    DROPPED from `selected` while `met` stays TRUE. For a product output such as
 *    carry = 0.20*(moc-1.5)*basis, each one-at-a-time sweep is individually perfectly
 *    linear (r2=1), so the design reports the output as fully explained by the single
 *    dominant axis and `selected` may contain only `moc` with met=true even at a
 *    0.999999 threshold — yet carry is literally proportional to `basis`. A caller
 *    pricing a product/interaction MUST NOT rely on `selected` alone; use a 2-input
 *    cross grid (mode:'cross') for the top drivers. This is NOT escalated here.
 *  • NON-MONOTONE (V / hump / threshold) DRIVERS ARE INVISIBLE TO SELECTION: ranking
 *    uses varianceExplained = r2(k)*SStot(k)/Σ SStot, and a symmetric V/hump has an
 *    OLS slope ~0 -> r2 ~0 -> ve ~0. So a non-monotone input can be the SINGLE LARGEST
 *    mover of an output yet be assigned ve=0 and dropped from `selected` and from the
 *    top-level `drivers` union. This is BROADER than the monotone-curved disclosure
 *    below: a non-monotone mover is not merely under-ranked, it is invisible to the
 *    selector. It is made SAFE by the OUTPUT-LEVEL kink gate (see STEP 4): a detected
 *    breakpoint on ANY candidate input — selected or not — escalates the output to
 *    Tier 2, so a V-hurdle that the selector cannot see still fires escalation. A
 *    smooth non-monotone hump with no detectable kink can still be silently dropped;
 *    callers must not treat `selected`/`drivers` as the complete lever set for an
 *    output the selector cannot linearly explain.
 *  • LINEAR-FIT r2 vs NONLINEAR MONOTONE: rSquaredOfSweep fits a straight line. A
 *    strongly monotone-but-curved driver (compounding) can show r2 < threshold and
 *    force escalation rather than be silently fit with a higher-order term. That is
 *    intentional: an unmet linear floor escalates to Tier-2/cone.
 *  • `selectedR2` IS A LINEAR-COVERAGE FRACTION, NOT A TRUE VARIANCE-EXPLAINED SHARE.
 *    It is Σ ve over the selected set, where ve(k)=r2(k)*SStot(k)/Σ SStot KEEPS each
 *    sweep's curvature variance in the DENOMINATOR but drops it from the NUMERATOR.
 *    So for a curved output the per-input ve shares do NOT sum to 1, and `met` (=
 *    selectedR2>=threshold) can be FALSE even when the selected set captures every
 *    mover (e.g. a sole exp-curved driver explains 100% of the real variance but
 *    selectedR2 == its r2 < 1). This UNDER-reports coverage BY DESIGN, in the safe
 *    direction: a curved output that the linear floor cannot cover escalates. Do NOT
 *    read selectedR2 as "fraction of output variance explained"; it is "fraction of
 *    output variance a straight-line response to the selected set explains."
 *  • r2 FLOORS ARE NOT OUTPUT-CLASS-AWARE IN THIS FILE. The default threshold is a
 *    single global 0.9 (DEFAULT_THRESHOLD). ADR-5's class map (monetary 0.99,
 *    IRR/MOIC 0.97) is delegated to options.perTargetThreshold, which the CALLER (the
 *    tier-recommender) MUST supply. With the bare 0.9 default a moderately-curved
 *    MONETARY output lands in the dangerous band [0.90, 0.99): met=true,
 *    escalateTier2=false — i.e. money silently scoped below the ADR monetary floor.
 *    This file CANNOT see an output's class; the per-target `classAware` flag in the
 *    return shape is FALSE whenever the default floor was applied so the caller can
 *    detect (and refuse) a money output scoped under the non-class-aware default.
 *  • escalateTier2 is a BOOLEAN the caller is contractually required to honor
 *    (= breakpoint || !met || coverageBelowFloor), not a soft warning. A multiplicative
 *    surrogate mis-prices carry near a hurdle / MIP near a threshold — exactly where PE
 *    money is decided. The kink gate is OUTPUT-LEVEL: a kinked output cannot be silently
 *    scoped as a clean driver even when a different, linear input dominates its variance
 *    (ADR-5). This module enforces it FIRES; it cannot enforce the caller obeys.
 *
 * @license MIT
 */

import { extractSurface, detectBreakpoints } from './sensitivity.mjs';

// ---------------------------------------------------------------------------
// Tunables / constants
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLD = 0.9;   // ADR default cumulative variance-explained target
const DEFAULT_STEPS = 7;         // default grid steps per candidate
const FLAT_TOL = 1e-12;          // |y - base| below this across the whole surface => degenerate
const COVERAGE_FLOOR = 1.0;      // any sweep failure (coverage < 1) escalates: a model that
                                 // throws/returns non-finite over part of its candidate range
                                 // must not be scoped as a clean driver (safety lens).

// ---------------------------------------------------------------------------
// Pure helpers (individually unit-tested)
// ---------------------------------------------------------------------------

/**
 * R^2 of an OLS straight-line fit y = a*x + b over a sweep of {x,y} points.
 * R^2 = 1 - SSres/SStot, where SStot = Σ(y-ȳ)^2 and SSres = Σ(y-(a x+b))^2.
 *
 * Returns 0 (NOT NaN) when SStot ~ 0 (flat output: the input does not move it),
 * and 0 for fewer than 2 points. Also returns the fitted slope/intercept so
 * callers can read slope sign without re-fitting.
 *
 * @param {Array<{x:number,y:number}>} sweep
 * @returns {number} R^2 in [0,1] (clamped); 0 when undefined
 */
export function rSquaredOfSweep(sweep) {
  return fitLine(sweep).r2;
}

/**
 * Fit y = a*x + b by ordinary least squares and return { slope, intercept, r2 }.
 * Internal-but-exported-shaped via rSquaredOfSweep; kept separate so slopeSign
 * and r2 come from the SAME fit.
 */
function fitLine(sweep) {
  const pts = (sweep || []).filter(
    (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y),
  );
  const n = pts.length;
  if (n < 2) return { slope: 0, intercept: n === 1 ? pts[0].y : 0, r2: 0 };

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const { x, y } of pts) {
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }
  const meanY = sumY / n;

  // SStot — total variance of y about its mean.
  let ssTot = 0;
  for (const { y } of pts) ssTot += (y - meanY) * (y - meanY);

  // Flat output: input does not move it. r2 is undefined (0/0); define as 0.
  if (ssTot <= FLAT_TOL) return { slope: 0, intercept: meanY, r2: 0 };

  const denom = n * sumX2 - sumX * sumX;
  // Degenerate x (all sample x equal): cannot fit a line; no variance explained.
  if (Math.abs(denom) <= 1e-20) return { slope: 0, intercept: meanY, r2: 0 };

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  let ssRes = 0;
  for (const { x, y } of pts) {
    const pred = slope * x + intercept;
    ssRes += (y - pred) * (y - pred);
  }

  let r2 = 1 - ssRes / ssTot;
  // Clamp rounding noise into [0,1]; OLS R^2 is mathematically in [0,1].
  if (r2 < 0) r2 = 0;
  if (r2 > 1) r2 = 1;
  return { slope, intercept, r2 };
}

/**
 * Reconstruct the one-at-a-time sweeps for a single candidate input from the
 * PUBLIC surface.points. Mirrors sensitivity's internal extractSweep rule (keep
 * points where every OTHER candidate input equals its base value), but exposes
 * ALL output keys for that input at once.
 *
 * @param {Object} surface - ResponseSurface from extractSurface
 * @param {string} inputKey
 * NOTE — duplicate base point: an independent-mode surface samples each input's
 * base value once PER swept input, so the shared base point (e.g. x=base) shows up
 * multiple times in the "others-at-base" set. Those duplicates carry no new
 * information (identical x AND y) but poison finite-difference slopes (a zero-width
 * segment yields a spurious 0 slope) and over-weight the base point in OLS. We
 * therefore COLLAPSE duplicate-x points to a single representative — the same x
 * value cannot appear twice in a true one-at-a-time sweep.
 *
 * @returns {Object<string, Array<{x:number,y:number}>>} outputKey -> sorted, deduped sweep
 */
export function extractInputSweep(surface, inputKey) {
  const baseInputs = surface.baseCaseInputs || {};
  const byOutput = {};

  for (const pt of surface.points || []) {
    if (pt.error) continue;

    // Keep only points where every OTHER input is at its base value.
    let othersAtBase = true;
    for (const [k, v] of Object.entries(baseInputs)) {
      if (k === inputKey) continue;
      if (pt.inputs[k] !== v) {
        othersAtBase = false;
        break;
      }
    }
    if (!othersAtBase) continue;

    const x = pt.inputs[inputKey];
    for (const [outputKey, y] of Object.entries(pt.outputs)) {
      if (typeof y !== 'number' || !Number.isFinite(y)) continue;
      (byOutput[outputKey] ||= []).push({ x, y });
    }
  }

  for (const k of Object.keys(byOutput)) {
    byOutput[k] = dedupeByX(byOutput[k].sort((a, b) => a.x - b.x));
  }
  return byOutput;
}

/** Collapse consecutive duplicate-x points (sorted input) to one each. */
function dedupeByX(sortedSweep) {
  const out = [];
  for (const p of sortedSweep) {
    if (out.length === 0 || out[out.length - 1].x !== p.x) out.push(p);
  }
  return out;
}

/**
 * Whether a sweep is monotone (its finite differences never change sign).
 * Flat segments (zero diff) do not break monotonicity.
 */
function isMonotone(sweep) {
  if (!sweep || sweep.length < 3) return true;
  let sign = 0;
  for (let i = 1; i < sweep.length; i++) {
    const d = sweep[i].y - sweep[i - 1].y;
    if (d === 0) continue;
    const s = d > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/**
 * Rank all candidate inputs by variance-explained for one output, and report
 * which inputs tripped a breakpoint for that output.
 *
 * TWO DISTINCT QUANTITIES, by design (see contract STEP 1):
 *  • `r2`  — the PURE per-sweep OLS linear-fit quality of input k's own sweep
 *           (1 = perfectly linear response, 0 = flat / no linear structure). This
 *           is what rSquaredOfSweep returns and is reported for transparency.
 *  • `varianceExplained` — the FRACTION OF THIS OUTPUT'S TOTAL variance (across
 *           all candidate sweeps) that a linear response to k explains:
 *               ve(k) = r2(k) * SStot(k) / Σ_j SStot(j)
 *           This is the COMMON-DENOMINATOR share that makes ranking + greedy
 *           accumulation meaningful and additive (Σ ve ≤ 1). A pure-linear but
 *           low-variance lever has r2≈1 yet a small ve; a dominant-but-curved
 *           lever has the larger ve. RANKING AND SELECTION USE ve, NOT r2 — so the
 *           lever that actually moves the output wins even if it is nonlinear.
 *
 * The denominator Σ SStot(j) is the total one-at-a-time variance across the
 * independent design; there are no cross terms in the sample, so per-input
 * variances are disjoint and directly comparable (multicollinearity/interaction
 * is NOT modeled — see file header).
 *
 * @param {Object} surface
 * @param {string} outputKey
 * @param {Object} [breakpointOptions] - forwarded to detectBreakpoints
 * @returns {{ ranked: Array, breakpointDrivers: string[], degenerate: boolean,
 *            baseValue: number, coverage: number, errorPoints: number, totalPoints: number }}
 *          coverage = fraction of sampled points that produced a usable numeric value
 *          for this output (1 = the model never failed over the candidate range).
 */
export function rankByVarianceExplained(surface, outputKey, breakpointOptions = {}) {
  const inputKeys = Object.keys(surface.inputGrid || {});
  const baseValue = surface.baseCaseOutputs?.[outputKey];

  // DEGENERATE GUARD: is the output flat across the ENTIRE surface?
  // (max |y - baseValue| < FLAT_TOL over every sampled point for this output).
  // Also tally SWEEP COVERAGE: how many sampled points produced a usable numeric
  // value for THIS output vs how many errored / returned non-finite. A model that
  // throws over part of its candidate range must NOT be silently scoped as a clean
  // linear driver — the caller needs the coverage to gate escalation (issue: error
  // points were dropped and reported nowhere, so a partial-failure model fit a
  // perfect line over the survivors with met=true).
  let maxDev = 0;
  let sawValue = false;
  let totalPoints = 0;
  let errorPoints = 0;
  for (const pt of surface.points || []) {
    totalPoints++;
    const y = pt && !pt.error ? pt.outputs[outputKey] : undefined;
    if (typeof y !== 'number' || !Number.isFinite(y)) {
      errorPoints++; // errored, missing, or non-finite for this output
      continue;
    }
    sawValue = true;
    const ref = typeof baseValue === 'number' ? baseValue : y;
    const dev = Math.abs(y - ref);
    if (dev > maxDev) maxDev = dev;
  }
  const coverage = totalPoints > 0 ? (totalPoints - errorPoints) / totalPoints : 0;
  const degenerate = !sawValue || maxDev < FLAT_TOL;

  // Per-input fit. Capture each sweep's SStot and the linearly-explained portion
  // (r2 * SStot) so we can normalize to a common denominator.
  const rows = [];
  let totalVar = 0;
  for (const input of inputKeys) {
    const sweep = extractInputSweep(surface, input)[outputKey] || [];
    const fit = degenerate ? { slope: 0, intercept: 0, r2: 0 } : fitLine(sweep);
    const ssTot = sweepSSTot(sweep);
    const ssExpl = fit.r2 * ssTot; // linearly-explained variance of THIS sweep
    totalVar += ssTot;
    rows.push({
      input,
      r2: fit.r2,
      slope: fit.slope,
      slopeSign: fit.slope > 0 ? 1 : fit.slope < 0 ? -1 : 0,
      monotone: isMonotone(sweep),
      ssExpl,
    });
  }

  // Common-denominator variance-explained share.
  const ranked = rows.map((row) => ({
    input: row.input,
    r2: row.r2,
    varianceExplained:
      degenerate || totalVar <= FLAT_TOL ? 0 : row.ssExpl / totalVar,
    slope: row.slope,
    slopeSign: row.slopeSign,
    monotone: row.monotone,
  }));

  // Stable rank: varianceExplained desc, then |slope| desc, then input key asc.
  ranked.sort((a, b) => {
    if (b.varianceExplained !== a.varianceExplained) {
      return b.varianceExplained - a.varianceExplained;
    }
    const absA = Math.abs(a.slope);
    const absB = Math.abs(b.slope);
    if (absB !== absA) return absB - absA;
    return a.input < b.input ? -1 : a.input > b.input ? 1 : 0;
  });

  // Breakpoint detection is independent of degeneracy (a constant output has no
  // kink, so this naturally returns nothing for a degenerate output). We run it on
  // a DEDUPED surface: detectBreakpoints internally re-derives sweeps from
  // surface.points and the raw independent surface carries duplicate base points
  // (see extractInputSweep) that would fabricate a zero-width segment / spurious
  // 0-slope at the base value and FALSE-fire a breakpoint on every input. The
  // deduped surface gives it one clean point per grid value.
  const cleanSurface = dedupeSurface(surface, outputKey);
  const bp = detectBreakpoints(cleanSurface, outputKey, breakpointOptions);
  const breakpointDrivers = inputKeys.filter((k) => (bp[k] || []).length > 0);

  // Strip the raw slope from the public ranked entries (slopeSign carries the sign).
  const publicRanked = ranked.map(({ slope, ...rest }) => rest);

  return {
    ranked: publicRanked,
    breakpointDrivers,
    degenerate,
    baseValue,
    coverage,
    errorPoints,
    totalPoints,
  };
}

/**
 * Build a minimal surface for detectBreakpoints with EXACTLY one point per
 * (input, grid value) for the given output — collapsing the duplicate base points
 * the raw independent surface carries.
 *
 * detectBreakpoints' internal extractSweep keeps points where every OTHER input is
 * at base. To make that reconstruction clean we must emit the shared base point
 * EXACTLY ONCE globally (its inputs are {all at base}) and, for every input, only
 * its NON-base grid points (others pinned at base). Then for input k, the internal
 * filter matches k's own non-base points PLUS the single global base point = one
 * clean grid sweep with no duplicate at the base value. Emitting the base point
 * per-input (the naive approach) reintroduces the duplicate via every input's
 * "others-at-base" match — exactly the artifact this routine removes.
 */
function dedupeSurface(surface, outputKey) {
  const baseInputs = surface.baseCaseInputs || {};
  const inputKeys = Object.keys(surface.inputGrid || {});
  const points = [];

  // The single shared base point (all inputs at base).
  const basePt = {
    inputs: { ...baseInputs },
    outputs: { [outputKey]: surface.baseCaseOutputs?.[outputKey] },
    error: false,
  };
  if (typeof basePt.outputs[outputKey] === 'number') points.push(basePt);

  for (const inputKey of inputKeys) {
    const sweep = extractInputSweep(surface, inputKey)[outputKey] || [];
    for (const { x, y } of sweep) {
      if (x === baseInputs[inputKey]) continue; // base point already emitted once
      points.push({
        inputs: { ...baseInputs, [inputKey]: x },
        outputs: { [outputKey]: y },
        error: false,
      });
    }
  }

  return {
    baseCaseInputs: baseInputs,
    inputGrid: surface.inputGrid,
    baseCaseOutputs: surface.baseCaseOutputs,
    points,
  };
}

/** Total variance of a sweep's y about its mean (Σ(y-ȳ)^2). 0 for <2 points. */
function sweepSSTot(sweep) {
  const pts = (sweep || []).filter(
    (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y),
  );
  if (pts.length < 2) return 0;
  let sumY = 0;
  for (const { y } of pts) sumY += y;
  const meanY = sumY / pts.length;
  let ss = 0;
  for (const { y } of pts) ss += (y - meanY) * (y - meanY);
  return ss;
}

/**
 * Greedy smallest set: walk ranked (already varianceExplained-desc) accumulating
 * cumulative variance-explained until it reaches threshold, |selected| hits
 * maxDrivers, or candidates are exhausted. Returns the prefix of the sorted list
 * — provably the smallest set crossing the threshold under a sum-of-sorted-
 * contributions accumulator (any other equal-size set has cumulative
 * variance-explained <= this prefix's).
 *
 * Accumulates each entry's `varianceExplained` (the common-denominator share),
 * NOT its raw per-sweep r2 — summing raw r2 would over-count (every linear sweep
 * is ~1). selectedR2 is the cumulative variance-explained, capped at 1 to guard
 * rounding / near-collinear double-counting.
 *
 * Drivers that contribute literally nothing (varianceExplained === 0) are never
 * added — a flat input is not a "driver" even if the threshold is unmet.
 *
 * @param {Array<{input:string,varianceExplained:number}>} ranked
 * @param {number} threshold
 * @param {number} maxDrivers
 * @returns {{ selected: string[], selectedR2: number, met: boolean }}
 */
export function smallestSetAboveThreshold(ranked, threshold, maxDrivers) {
  const cap = Number.isFinite(maxDrivers) && maxDrivers > 0
    ? maxDrivers
    : ranked.length;

  const selected = [];
  let cum = 0;
  for (const entry of ranked) {
    if (selected.length >= cap) break;
    const ve = entry.varianceExplained ?? 0;
    if (ve <= 0) break; // remaining contribute nothing; do not pad the set
    selected.push(entry.input);
    cum += ve;
    if (cum >= threshold) break;
  }

  const selectedR2 = Math.min(cum, 1);
  const met = selectedR2 >= threshold;
  return { selected, selectedR2, met };
}

// ---------------------------------------------------------------------------
// Primary entry point
// ---------------------------------------------------------------------------

/**
 * Select the smallest driver set per target output and decide Tier-2 escalation.
 *
 * Per-output escalation (escalateTier2) fires when ANY of:
 *   • breakpoint           — a kink is detected on ANY candidate input (OUTPUT-LEVEL,
 *                            not just selected drivers; ADR-5), or
 *   • !met                 — the selected set does not reach the (effective) r2 floor, or
 *   • coverageBelowFloor   — the model failed/returned non-finite over part of the
 *                            candidate range (coverage < 1).
 *
 * Each per-target entry also carries `coverage` (fraction of sampled points usable for
 * the output) and `classAware` (FALSE when the non-class-aware default floor was used —
 * the caller must refuse a met=true MONETARY output with classAware=false; see header).
 *
 * @param {Function} evaluator - (inputs:Object<string,number>) => outputs, shaped
 *        for sensitivity.flattenOutputs (nested groups returns/waterfall/mip/
 *        exitValuation/perShare, or top-level numerics). A flat {totalCarry:n}
 *        yields NO keys — wrap it (e.g. {waterfall:{totalCarry}}).
 * @param {Object<string,{base:number,min:number,max:number,steps?:number}>} candidateInputs
 * @param {Object} [options]
 * @param {string[]} [options.targetOutputKeys] - default: all numeric baseCaseOutputs keys
 * @param {number} [options.threshold=0.9]
 * @param {Object<string,number>} [options.perTargetThreshold] - class-aware floors the
 *        caller supplies (ADR-5: monetary 0.99, IRR/MOIC 0.97). An output present here
 *        is marked classAware=true; absent outputs fall back to the global default and
 *        are classAware=false.
 * @param {number} [options.steps=7] - default grid steps when a candidate omits its own
 * @param {Object} [options.breakpointOptions] - forwarded to detectBreakpoints (default {threshold:0.5})
 * @param {number} [options.maxDrivers] - safety cap (default: candidateInputs count)
 * @returns {DriverScope}
 */
export function selectDrivers(evaluator, candidateInputs, options = {}) {
  if (typeof evaluator !== 'function') {
    throw new TypeError('selectDrivers: evaluator must be a function (inputs)=>outputs');
  }
  if (!candidateInputs || typeof candidateInputs !== 'object') {
    throw new TypeError('selectDrivers: candidateInputs must be an object of {base,min,max,steps?}');
  }

  const candidateKeys = Object.keys(candidateInputs);
  if (candidateKeys.length === 0) {
    throw new Error('selectDrivers: candidateInputs is empty — nothing to scope');
  }

  const {
    threshold = DEFAULT_THRESHOLD,
    perTargetThreshold = {},
    steps = DEFAULT_STEPS,
    breakpointOptions = {},
    maxDrivers = candidateKeys.length,
  } = options;

  // STEP 0: build the base-case inputs + inputConfig, then sample ONCE.
  const baseCaseInputs = {};
  const inputConfig = {};
  for (const k of candidateKeys) {
    const c = candidateInputs[k];
    if (typeof c.base !== 'number' || !Number.isFinite(c.base)) {
      throw new Error(`selectDrivers: candidate "${k}" must have a numeric base`);
    }
    baseCaseInputs[k] = c.base;
    inputConfig[k] = { min: c.min, max: c.max, steps: c.steps ?? steps };
  }

  // Determine targets BEFORE filtering the surface (so we can pass outputKeys).
  // If none specified, sample base case once via extractSurface and read its
  // numeric baseCaseOutputs keys.
  const surface = extractSurface(evaluator, baseCaseInputs, inputConfig, {
    outputKeys: options.targetOutputKeys || null,
    mode: 'independent',
  });

  const targetOutputKeys =
    options.targetOutputKeys && options.targetOutputKeys.length > 0
      ? options.targetOutputKeys.slice()
      : Object.keys(surface.baseCaseOutputs).filter(
          (k) => typeof surface.baseCaseOutputs[k] === 'number',
        );

  // STEP 1-4 per target output.
  const perTarget = {};
  const driverUnion = new Set();
  let escalate = false;

  for (const outputKey of targetOutputKeys) {
    const hasClassThreshold = Object.prototype.hasOwnProperty.call(
      perTargetThreshold,
      outputKey,
    );
    const effThreshold = hasClassThreshold ? perTargetThreshold[outputKey] : threshold;

    const { ranked, breakpointDrivers, degenerate, baseValue, coverage } =
      rankByVarianceExplained(surface, outputKey, breakpointOptions);

    // STEP 3: greedy smallest set. A degenerate output never selects anything.
    let selected = [];
    let selectedR2 = 0;
    let met = false;
    if (!degenerate) {
      const sss = smallestSetAboveThreshold(ranked, effThreshold, maxDrivers);
      selected = sss.selected;
      selectedR2 = sss.selectedR2;
      met = sss.met;
    }

    // STEP 4: OUTPUT-LEVEL kink gate -> mandatory escalation (ADR-5).
    // A kinked OUTPUT cannot be silently scoped as a clean driver, regardless of
    // WHICH input carries the kink. The previous driver-level gate filtered the
    // detected breakpoints to the SELECTED set, so a hurdle/MIP kink on a
    // non-selected input (e.g. a non-monotone V whose OLS-line ve is ~0 and is
    // therefore dropped from `selected`, or a secondary kinked driver out-weighted
    // by an unrelated linear input) was silently discarded and the output scoped
    // with escalateTier2=false. Now ANY detected breakpoint on ANY candidate input
    // escalates the output. A degenerate (constant) output has no kink by
    // construction, so this naturally contributes nothing there.
    const breakpointForOutput = degenerate ? [] : breakpointDrivers.slice();
    const breakpoint = breakpointForOutput.length > 0;

    // COVERAGE gate: a model that throws / returns non-finite over part of its
    // candidate range is not trustworthy enough to scope to a surrogate. Treat any
    // sweep failure (coverage below the floor) as an escalation trigger and never
    // report met=true for it.
    const coverageBelowFloor = coverage < COVERAGE_FLOOR;
    if (coverageBelowFloor) met = false;

    const escalateTier2 = breakpoint || !met || coverageBelowFloor;

    perTarget[outputKey] = {
      ranked,
      selected,
      selectedR2,
      threshold: effThreshold,
      met,
      breakpoint,
      breakpointDrivers: breakpointForOutput,
      escalateTier2,
      baseValue,
      degenerate,
      coverage,
      coverageBelowFloor,
      // FALSE whenever the non-class-aware default floor was applied (no explicit
      // per-target threshold). A caller scoping a MONETARY output must refuse a
      // met=true result with classAware=false (ADR-5 monetary floor is 0.99, not
      // the bare 0.9 default this file cannot infer from the output name).
      classAware: hasClassThreshold,
    };

    for (const k of selected) driverUnion.add(k);
    if (escalateTier2) escalate = true;
  }

  const drivers = Array.from(driverUnion).sort();

  return {
    perTarget,
    drivers,
    escalate,
    meta: {
      totalPoints: surface.points.length,
      candidateInputs: candidateKeys.slice(),
      targetOutputKeys,
      thresholdDefault: threshold,
      mode: 'independent',
    },
  };
}

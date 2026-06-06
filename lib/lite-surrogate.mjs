/**
 * excel-to-engine — ADR-027 Lite Package, Tier-1 surrogate emitter (Phase 4)
 *
 * Tier 1 of the right-sized extraction ladder (closed-form → SURROGATE → cone →
 * full). It samples a model at perturbed inputs and FITS a KB-sized coefficient
 * surrogate that multiplies at runtime — no Rust, no engine:
 *
 *   MULTIPLICATIVE (primary)  out = base · ∏ᵢ (1 + βᵢ·Δᵢ)
 *   POLY (per-driver fallback) out = base + Σᵢ (aᵢ·Δᵢ + bᵢ·Δᵢ²)
 *
 * with Δᵢ = (xᵢ − baseᵢ)/baseᵢ, fit ONLY over the SELECTED drivers (others held at
 * base ⇒ Δ=0 ⇒ no contribution). It is the implementation of ADR-027 §2's Tier-1
 * row and §5's honesty gate.
 *
 * ─── THE HONESTY GATE IS THE PRIMARY DELIVERABLE (ADR §5) ─────────────────────
 * A wrong surrogate misprices PE money. Per target output, in THIS ORDER:
 *   (a) breakpoint (a hurdle/MIP/pref KINK in the swept range) → ESCALATE Tier 2,
 *       ALWAYS — even an explicit embedded-surrogate request CANNOT override the
 *       kink gate (ADR §5 explicit). The kink signal is selectDrivers' verbatim,
 *       NOT a weaker local heuristic (single source of truth).
 *   (b) coverageBelowFloor (model threw/non-finite over part of the range) → ESCALATE.
 *   (c) the FITTED surrogate's OWN measured r² < the output-class floor:
 *         - useCase 'embedded-surrogate' AND the output is class-aware → SHIP under a
 *           LOUD by-request disclosure (ADR §5 carve-out, ratified 2026-06-06);
 *         - else → ESCALATE Tier 2.
 *   (d) else → SHIP clean.
 *
 * ─── PROVENANCE SIGNS THE GATE DECISION *AND* THE RUN-TIME VALUES (read this) ──
 * Because a wrong surrogate misprices PE money, the refuse-on-mismatch loader must
 * defend the ACTUAL numbers, not just "which model". The artifact stamps a SIGNED
 * gateHash (in BOTH provenance modes) over a per-output gateRecord that captures:
 *   - the gate decision (escalateTier2),
 *   - the fit shape (fitForm + ordered drivers),
 *   - the LOAD-BEARING VALUES run() consumes: the per-output base value and the
 *     fitted coeff floats (rounded to a stable precision),
 *   - the gate-outcome fields (rSquared, classFloor, useCase, whether a BY-REQUEST
 *     disclosure is present).
 * loadSurrogate re-derives gateHash from the LIVE params (perTarget + base block)
 * and THROWS on any mismatch — so a flipped escalation flag, a tampered beta, a
 * drifted base, an r² lie, or a stripped disclosure are all caught in BOTH modes.
 * It ALSO re-asserts the floor invariant directly (a shipped output below its floor
 * with no by-request disclosure is refused). The model-IDENTITY hash (structuralHash)
 * and the self-contained fitSignature remain as the "which model" layer on top.
 *
 * ─── r² IS FIT-TO-SAMPLE, NOT FIT-TO-MODEL (read before trusting it) ──────────
 *  • The SHIPPED gate uses the EMITTER'S OWN refit rSquared/maxResidual measured on
 *    the fitted surrogate's predictions over the sampled points — NEVER selectDrivers'
 *    selectedR2 (a linear variance proxy that can be met=true while the fitted
 *    multiplicative surrogate is materially off, or below floor while a poly fit is
 *    exact). Trusting selectedR2 would both mis-gate AND make a test circular.
 *  • INTERACTION/MULTICOLLINEARITY OUT OF SCOPE: per-axis βᵢ are fit on independent
 *    one-at-a-time sweeps (driver-scope's documented limitation). The stamped r²/
 *    maxResidual are therefore ON-AXIS metrics. A multi-driver shipped output carries
 *    a machine-readable per-target flag (offAxisUnverified:true + driverCount) so a
 *    downstream consumer cannot read its on-axis r² as joint-surface fidelity. Prefer
 *    single-driver scopes for 0.99-class outputs, or escalate.
 *
 * Rust-free: pure JS, zero new deps (fs/crypto/path/url + existing lib/*).
 *
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname, relative, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

import { selectDrivers, extractInputSweep } from './driver-scope.mjs';
import { extractSurface } from './sensitivity.mjs';
import { R2_FLOORS, OUTPUT_CLASSES } from './tier-recommender.mjs';
import {
  deriveModelHash, structuralRefs, hashStructuralRefs,
  fitSignature, stableStringify, verifyModelLayer,
} from './lite-provenance.mjs';

const ARTIFACT_TAG = 'ete-lite-surrogate-v1';

const FLAT_TOL = 1e-12; // SStot at/below this ⇒ rSquared defined as 0 (flat output)

// Coeff/base values are folded into the signed gateHash at this fixed precision so
// the digest is stable across JSON round-trips (a coeff written as 1 reads back 1,
// 0.333333333333 reads back the rounded string) while still catching any material
// value tamper (1 → 999, base 2 → 5, etc.).
const SIGN_PRECISION = 12;

const DISCLOSURE =
  'Tier-1 surrogate r2 is fit-to-sample, not fit-to-model; spot-check the cascade/engine. ' +
  'Multiplicative betas are fit on independent one-at-a-time sweeps (no interaction terms), ' +
  'so a multi-driver surrogate can be confidently wrong off-axis (see per-target offAxisUnverified). ' +
  'Honest only over the sampled driver ranges; a kinked output escalates to Tier 2 (cone). ' +
  'Rust-free, zero new deps.';

const KINK_WARNING =
  'Outputs are piecewise in their drivers with kinks at pref/catch-up/MIP hurdles. A shipped ' +
  'surrogate is honest only away from a detected kink; a kinked output is NOT shipped (escalated ' +
  'to Tier 2 cone) — even a by-request embedded surrogate cannot override the kink gate (ADR §5).';

// ---------------------------------------------------------------------------
// Output-class → governing r² floor (reuse the tier-recommender rule verbatim).
// ---------------------------------------------------------------------------

/**
 * The SINGLE governing class for an output's declared class(es): the tightest
 * floor wins when an output maps to several (reuse-by-R2_FLOORS reduce — the same
 * rule tier-recommender uses). Unknown/absent classes fall back to 'other'.
 *
 * @param {string|string[]} [outputClass]
 * @returns {string} a key of R2_FLOORS
 */
function governingClass(outputClass) {
  const classes = Array.isArray(outputClass) ? outputClass : [outputClass];
  const known = classes.filter((c) => c in R2_FLOORS);
  if (known.length === 0) return 'other';
  return known.reduce((best, c) => (R2_FLOORS[c] > R2_FLOORS[best] ? c : best), known[0]);
}

/** Whether the output declared at least one recognized OUTPUT_CLASSES class. */
function hasDeclaredClass(outputClass) {
  const classes = Array.isArray(outputClass) ? outputClass : [outputClass];
  return classes.some((c) => typeof c === 'string' && OUTPUT_CLASSES.includes(c));
}

/** The r² floor an output must promise to ship clean (ADR §5). */
function floorFor(outputClass) {
  return R2_FLOORS[governingClass(outputClass)];
}

// ---------------------------------------------------------------------------
// Fit math — PER OUTPUT, over the SELECTED drivers only.
// ---------------------------------------------------------------------------

/**
 * Fit a SINGLE multiplicative beta on one driver's one-at-a-time sweep:
 *   minimize Σ(y − base·(1 + β·Δ))² ⇒ β = Σ((y−base)·(base·Δ)) / Σ((base·Δ)²)
 * where Δ = (x − baseX)/baseX. Linear in β (the base point Δ=0 contributes 0 to
 * both sums, so it is harmless). Returns null when there is no leverage (baseX=0
 * or a degenerate denominator) — the caller treats a null coeff as unfittable.
 *
 * @param {Array<{x:number,y:number}>} sweep
 * @param {number} base    base-case output value
 * @param {number} baseX   base value of this driver
 * @returns {number|null} beta, or null if not fittable
 */
function fitBeta(sweep, base, baseX) {
  if (!Number.isFinite(baseX) || baseX === 0) return null;
  let num = 0;
  let den = 0;
  for (const { x, y } of sweep) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const d = (x - baseX) / baseX;
    const bd = base * d;
    num += (y - base) * bd;
    den += bd * bd;
  }
  if (Math.abs(den) <= FLAT_TOL) return null;
  return num / den;
}

/**
 * Fit a per-driver 2-term polynomial of (y − base) on [Δ, Δ²] by the 2×2 normal
 * equations: out = base + a·Δ + b·Δ². Returns {a,b} or null when singular.
 *
 * @param {Array<{x:number,y:number}>} sweep
 * @param {number} base
 * @param {number} baseX
 * @returns {{a:number,b:number}|null}
 */
function fitPoly(sweep, base, baseX) {
  if (!Number.isFinite(baseX) || baseX === 0) return null;
  let s11 = 0, s12 = 0, s22 = 0, t1 = 0, t2 = 0;
  for (const { x, y } of sweep) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const d = (x - baseX) / baseX;
    const z = y - base;
    const d2 = d * d;
    s11 += d2;        // Σ Δ²
    s12 += d2 * d;    // Σ Δ³
    s22 += d2 * d2;   // Σ Δ⁴
    t1 += d * z;      // Σ Δ·z
    t2 += d2 * z;     // Σ Δ²·z
  }
  const det = s11 * s22 - s12 * s12;
  if (Math.abs(det) <= FLAT_TOL) return null;
  const a = (t1 * s22 - t2 * s12) / det;
  const b = (s11 * t2 - s12 * t1) / det;
  return { a, b };
}

/**
 * Evaluate the multiplicative surrogate from per-driver betas:
 *   out = base · ∏ᵢ (1 + βᵢ·Δᵢ),  Δᵢ = (xᵢ − baseᵢ)/baseᵢ.
 *
 * @param {number} base
 * @param {Object<string,number>} betas   driverKey → beta
 * @param {Object<string,number>} baseX   driverKey → base value
 * @param {Object<string,number>} inputs  driverKey → overridden value (others at base)
 * @returns {number}
 */
function predictMultiplicative(base, betas, baseX, inputs) {
  let prod = 1;
  for (const k of Object.keys(betas)) {
    const bx = baseX[k];
    if (!Number.isFinite(bx) || bx === 0) continue;
    const x = inputs[k];
    if (x === undefined) continue; // driver at base ⇒ Δ=0 ⇒ factor 1
    const d = (x - bx) / bx;
    prod *= 1 + betas[k] * d;
  }
  return base * prod;
}

/**
 * Evaluate the poly surrogate from per-driver {a,b}:
 *   out = base + Σᵢ (aᵢ·Δᵢ + bᵢ·Δᵢ²).
 *
 * @param {number} base
 * @param {Object<string,{a:number,b:number}>} polys
 * @param {Object<string,number>} baseX
 * @param {Object<string,number>} inputs
 * @returns {number}
 */
function predictPoly(base, polys, baseX, inputs) {
  let sum = base;
  for (const k of Object.keys(polys)) {
    const bx = baseX[k];
    if (!Number.isFinite(bx) || bx === 0) continue;
    const x = inputs[k];
    if (x === undefined) continue;
    const d = (x - bx) / bx;
    const { a, b } = polys[k];
    sum += a * d + b * d * d;
  }
  return sum;
}

/**
 * MEASURE r² + maxResidual of a FITTED surrogate on the SAME sampled points the
 * selector used (every selected-driver sweep point). rSquared = 1 − SSres/SStot
 * clamped to [0,1]; 0 when SStot ≤ FLAT_TOL (flat output). maxResidual = max|y−ŷ|.
 *
 * @param {Array<{inputs:Object<string,number>,y:number}>} samples one row per sampled point
 * @param {(inputs:Object<string,number>)=>number} predict the fitted surrogate
 * @returns {{rSquared:number,maxResidual:number,n:number}}
 */
function measureFit(samples, predict) {
  const pts = samples.filter((s) => Number.isFinite(s.y));
  const n = pts.length;
  if (n === 0) return { rSquared: 0, maxResidual: Infinity, n: 0 };
  let mean = 0;
  for (const s of pts) mean += s.y;
  mean /= n;
  let ssTot = 0;
  let ssRes = 0;
  let maxResidual = 0;
  for (const s of pts) {
    const yhat = predict(s.inputs);
    const r = s.y - yhat;
    const ar = Math.abs(r);
    if (ar > maxResidual) maxResidual = ar;
    ssRes += r * r;
    ssTot += (s.y - mean) * (s.y - mean);
  }
  let r2 = ssTot <= FLAT_TOL ? 0 : 1 - ssRes / ssTot;
  if (r2 < 0) r2 = 0;
  if (r2 > 1) r2 = 1;
  return { rSquared: r2, maxResidual, n };
}

/**
 * Collect the FLAT sample set for an output over its SELECTED drivers: each
 * selected driver's one-at-a-time sweep contributes its swept points as
 * {inputs:{driver:x}, y}. The shared base point appears once per driver but is
 * harmless (Δ=0 ⇒ exact base). Returns [] when no driver is fittable.
 *
 * @param {Object} surface  the independent-mode ResponseSurface
 * @param {string} outputKey
 * @param {string[]} selected
 * @returns {Array<{inputs:Object<string,number>,y:number}>}
 */
function collectSamples(surface, outputKey, selected) {
  const samples = [];
  for (const driver of selected) {
    const sweep = extractInputSweep(surface, driver)[outputKey] || [];
    for (const { x, y } of sweep) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      samples.push({ inputs: { [driver]: x }, y });
    }
  }
  return samples;
}

// ---------------------------------------------------------------------------
// Provenance — mirror lite-tier0 EXACTLY, plus a SIGNED gateHash over the
// per-output gate decision + the load-bearing run() values (both modes).
// ---------------------------------------------------------------------------

// hashStructuralRefs / fitSignature / stableStringify live in lib/lite-provenance.mjs
// (imported above) — the single canonical home shared with lite-tier0.

/** A relative path from `from` to `to` if `to` is inside it, else the abs path. */
function relativeIfInside(from, to) {
  const rel = relative(from, to);
  if (!rel) return '.';
  return rel.startsWith('..') || isAbsolute(rel) ? to : './' + rel.split('\\').join('/');
}

/** Round a finite number to a stable signing precision; pass non-finite through. */
function roundForSign(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return x ?? null;
  return Number(x.toFixed(SIGN_PRECISION));
}

/** Stably round a coeffs block ({betas} or {polys}) for signing. */
function roundCoeffs(coeffs) {
  if (!coeffs || typeof coeffs !== 'object') return null;
  if (coeffs.betas) {
    const betas = {};
    for (const k of Object.keys(coeffs.betas).sort()) betas[k] = roundForSign(coeffs.betas[k]);
    return { betas };
  }
  if (coeffs.polys) {
    const polys = {};
    for (const k of Object.keys(coeffs.polys).sort()) {
      const pc = coeffs.polys[k] || {};
      polys[k] = { a: roundForSign(pc.a), b: roundForSign(pc.b) };
    }
    return { polys };
  }
  return null;
}

/**
 * The per-output gateRecord — the SIGNED envelope the loader re-derives from the
 * LIVE params (perTarget + base block) and the artifact's declared useCase. It
 * captures BOTH the gate decision AND the load-bearing run() values, so a flipped
 * escalation flag, a tampered coeff/base, an r² lie, or a stripped disclosure are
 * all caught by a single hash compare in BOTH provenance modes.
 *
 * Derived purely from on-disk params (NOT closure state) so loadSurrogate can
 * recompute it independently. `outputClasses`/`useCase` are read from params.inputs.
 *
 * @param {Object} target   a perTarget entry
 * @param {*} baseValue     params.base.outputs[k] (the value run() actually consumes)
 * @param {Object} baseX    params.base.baseX[k] (per-driver base values run() uses)
 * @param {string} useCase  the artifact's useCase (drives the by-request invariant)
 * @returns {Object} a deterministic, JSON-stable record
 */
function gateRecordFor(target, baseValue, baseX, useCase) {
  if (target.escalateTier2) {
    return { escalated: true };
  }
  const drivers = (target.selected || []).slice().sort();
  return {
    escalated: false,
    fitForm: target.fitForm,
    drivers,
    coeffs: roundCoeffs(target.coeffs),
    base: roundForSign(baseValue),
    baseX: drivers.reduce((acc, d) => { acc[d] = roundForSign((baseX || {})[d]); return acc; }, {}),
    rSquared: roundForSign(target.rSquared),
    classFloor: roundForSign(target.classFloor),
    hasDisclosure: !!target.disclosure,
    useCase,
  };
}

/**
 * Build the SIGNED gateHash over every output's gateRecord. Derived from the
 * on-disk perTarget + base block + useCase, so emit and load compute the SAME hash.
 *
 * @param {Object} perTarget   params.perTarget
 * @param {Object} baseBlock    params.base ({outputs, baseX})
 * @param {string} useCase
 * @returns {{ gateHash:string, records:Object }}
 */
function signGateRecords(perTarget, baseBlock, useCase) {
  const records = {};
  const outputs = baseBlock?.outputs || {};
  const baseXs = baseBlock?.baseX || {};
  for (const k of Object.keys(perTarget).sort()) {
    records[k] = gateRecordFor(perTarget[k], outputs[k], baseXs[k], useCase);
  }
  const gateHash = 'sha256:' + createHash('sha256').update(stableStringify(records)).digest('hex');
  return { gateHash, records };
}

/**
 * The coeffs-spec for one shipped output — the shape the run() formula depends on
 * (fitForm + ordered drivers + per-driver coeff shape), NOT the float values.
 * (Model-identity layer for the self-contained fitSignature only.)
 */
function coeffsSpecFor(shipped) {
  return {
    fitForm: shipped.fitForm,
    drivers: shipped.selected.slice(),
    shape: shipped.fitForm === 'poly' ? 'ab-per-driver' : 'beta-per-driver',
  };
}

// ---------------------------------------------------------------------------
// emitSurrogate — the public emitter.
// ---------------------------------------------------------------------------

/**
 * Emit a Tier-1 surrogate artifact for a pluggable evaluator.
 *
 * @param {Function} evaluator - (inputs:Object<string,number>) => groupedResult
 *        (lib/lite-evaluators directEvaluator/cascadeEvaluator shape).
 * @param {Object<string,{base:number,min:number,max:number,steps?:number}>} candidateInputs
 * @param {Object} [opts]
 * @param {Object<string,string>} [opts.outputClasses] - outputKey → one of OUTPUT_CLASSES
 * @param {string}  [opts.useCase='one-off'] - drives the by-request carve-out
 * @param {string}  [opts.outDir]            - artifact dir (when write===true)
 * @param {boolean} [opts.write=false]       - write params + run shim to disk
 * @param {string}  [opts.modelHash]         - (reserved) explicit model identity
 * @param {string}  [opts.chunkedDir]        - model dir (enables model-identity provenance)
 * @param {Object}  [opts.manifest]          - loaded manifest (enables model-identity provenance)
 * @param {string[]}[opts.targetOutputKeys]  - restrict targets (default: all numeric outputs)
 * @param {('auto'|'multiplicative'|'poly')} [opts.fitForm='auto']
 * @param {number}  [opts.steps]             - default grid steps when a candidate omits its own
 * @param {Object}  [opts.breakpointOptions] - forwarded to detectBreakpoints
 * @returns {{ paramsPath?:string, runPath?:string, params:Object, perTarget:Object, escalated:string[] }}
 */
export function emitSurrogate(evaluator, candidateInputs, opts = {}) {
  if (typeof evaluator !== 'function') {
    throw new TypeError('emitSurrogate: evaluator must be a function (inputs)=>groupedResult');
  }
  if (!candidateInputs || typeof candidateInputs !== 'object' || Object.keys(candidateInputs).length === 0) {
    throw new TypeError('emitSurrogate: candidateInputs must be a non-empty {base,min,max,steps?} map');
  }
  const {
    outputClasses = {},
    useCase = 'one-off',
    write = false,
    fitForm = 'auto',
    targetOutputKeys = null,
    steps,
    breakpointOptions = {},
  } = opts;
  if (!['auto', 'multiplicative', 'poly'].includes(fitForm)) {
    throw new Error(`emitSurrogate: fitForm must be 'auto'|'multiplicative'|'poly' (got ${fitForm}).`);
  }

  // --- STEP 1: class-aware driver scope. classFloors[outputKey] = governing floor. ---
  const classFloors = {};
  const keysForFloors = targetOutputKeys || Object.keys(outputClasses);
  for (const k of keysForFloors) {
    classFloors[k] = floorFor(outputClasses[k]);
  }
  const scope = selectDrivers(evaluator, candidateInputs, {
    perTargetThreshold: classFloors,
    targetOutputKeys: targetOutputKeys || undefined,
    steps,
    breakpointOptions,
  });

  // --- re-sample ONCE for the fit (independent design, same grid). We re-derive
  //     the surface here so the emitter measures its OWN fit on the SAME points
  //     the selector used — never trusting selectedR2. ---
  const baseCaseInputs = {};
  const inputConfig = {};
  for (const [k, c] of Object.entries(candidateInputs)) {
    baseCaseInputs[k] = c.base;
    inputConfig[k] = { min: c.min, max: c.max, steps: c.steps ?? steps ?? 7 };
  }
  const targets = scope.meta.targetOutputKeys;
  const surface = extractSurface(evaluator, baseCaseInputs, inputConfig, {
    mode: 'independent',
    outputKeys: targets,
  });

  // --- STEP 2-3: per target, FIT + apply the honesty gate. ---
  const perTarget = {};
  const escalated = [];
  const undeclaredClassTargets = [];
  let anyKink = false;

  for (const outputKey of targets) {
    const st = scope.perTarget[outputKey];
    const classKey = governingClass(outputClasses[outputKey]);
    const classFloor = classFloors[outputKey] ?? floorFor(outputClasses[outputKey]);
    const declaredClass = hasDeclaredClass(outputClasses[outputKey]);
    if (!declaredClass) undeclaredClassTargets.push(outputKey);
    const base = surface.baseCaseOutputs[outputKey];
    const selected = st.selected.slice();

    // (a) KINK GATE — first, overrides everything (ADR §5 explicit). Honor the
    //     selector's breakpoint verbatim — do NOT add a weaker local heuristic.
    if (st.breakpoint === true) {
      anyKink = true;
      perTarget[outputKey] = escalation(outputKey, selected, st, classFloor,
        'a breakpoint (hurdle/MIP/pref kink) was detected in the swept range — a surrogate ' +
        'misprices near a kink; ADR §5 forces Tier 2 (cone). The kink gate cannot be overridden ' +
        'by a by-request embedded surrogate.');
      escalated.push(outputKey);
      continue;
    }

    // (b) COVERAGE gate — the model failed/non-finite over part of the range.
    if (st.coverageBelowFloor === true) {
      perTarget[outputKey] = escalation(outputKey, selected, st, classFloor,
        `the model failed or returned non-finite over part of the candidate range ` +
        `(coverage ${st.coverage}); not trustworthy enough to ship — escalating to Tier 2.`);
      escalated.push(outputKey);
      continue;
    }

    // Degenerate / no fittable driver ⇒ cannot fit a surrogate ⇒ escalate.
    if (st.degenerate === true || selected.length === 0) {
      perTarget[outputKey] = escalation(outputKey, selected, st, classFloor,
        st.degenerate
          ? 'output is flat across the entire candidate range — no surrogate to fit.'
          : 'no driver explained this output — nothing to fit; escalating to Tier 2.');
      escalated.push(outputKey);
      continue;
    }

    // --- FIT over the selected drivers; measure the FITTED surrogate's OWN r². ---
    const baseX = {};
    for (const d of selected) baseX[d] = baseCaseInputs[d];
    const samples = collectSamples(surface, outputKey, selected);

    const fitMult = () => {
      const betas = {};
      for (const d of selected) {
        const sweep = extractInputSweep(surface, d)[outputKey] || [];
        const beta = fitBeta(sweep, base, baseX[d]);
        if (beta === null) return null;
        betas[d] = beta;
      }
      const { rSquared, maxResidual } = measureFit(samples, (inp) => predictMultiplicative(base, betas, baseX, inp));
      return { fitForm: 'multiplicative', coeffs: { betas }, rSquared, maxResidual };
    };
    const fitPolyForm = () => {
      const polys = {};
      for (const d of selected) {
        const sweep = extractInputSweep(surface, d)[outputKey] || [];
        const pc = fitPoly(sweep, base, baseX[d]);
        if (pc === null) return null;
        polys[d] = pc;
      }
      const { rSquared, maxResidual } = measureFit(samples, (inp) => predictPoly(base, polys, baseX, inp));
      return { fitForm: 'poly', coeffs: { polys }, rSquared, maxResidual };
    };

    let fit;
    if (fitForm === 'multiplicative') {
      fit = fitMult();
    } else if (fitForm === 'poly') {
      fit = fitPolyForm();
    } else {
      // 'auto': multiplicative first; if its FITTED r² < floor, try poly, keep the
      // better fitted r² (NOT selectedR2 — see file header).
      const m = fitMult();
      if (m && m.rSquared >= classFloor) {
        fit = m;
      } else {
        const p = fitPolyForm();
        if (!m) fit = p;
        else if (!p) fit = m;
        else fit = p.rSquared > m.rSquared ? p : m;
      }
    }

    if (!fit) {
      perTarget[outputKey] = escalation(outputKey, selected, st, classFloor,
        'the selected drivers had no fittable leverage (zero base value or degenerate sweep) — escalating to Tier 2.');
      escalated.push(outputKey);
      continue;
    }

    // (c) FITTED r² < classFloor → carve-out or escalate. The escalation entry
    //     keeps the MEASURED fit (how far below floor) for triage (honesty signal).
    if (fit.rSquared < classFloor) {
      // The by-request carve-out applies ONLY to an explicit embedded-surrogate
      // request on a CLASS-AWARE output (the requester knowingly accepted the floor
      // risk). The kink gate above already returned, so a kinked output never reaches
      // this branch — the carve-out cannot resurrect a kinked output.
      if (useCase === 'embedded-surrogate' && st.classAware === true) {
        const disclosure =
          `BY-REQUEST SURROGATE BELOW FLOOR: you explicitly requested an embedded surrogate for ` +
          `'${outputKey}' (class '${classKey}', r2 floor ${classFloor}); the fitted ${fit.fitForm} ` +
          `surrogate measured r2 ${fit.rSquared.toFixed(6)} < ${classFloor}. Per the ADR §5 by-request ` +
          `carve-out (ratified 2026-06-06) this ships as Tier 1 UNDER DISCLOSURE — treat it as ` +
          `INDICATIVE; re-validate against the cone/engine before money decisions.`;
        perTarget[outputKey] = shipped(outputKey, selected, st, classFloor, base, fit, disclosure);
      } else {
        perTarget[outputKey] = escalation(outputKey, selected, st, classFloor,
          `the fitted ${fit.fitForm} surrogate measured r2 ${fit.rSquared.toFixed(6)} < the class ` +
          `floor ${classFloor} for '${classKey}'; ADR §5 escalates to Tier 2 (cone). ` +
          `The by-request carve-out applies only to an explicit embedded-surrogate request on a ` +
          `class-aware output.`, fit);
        escalated.push(outputKey);
      }
      continue;
    }

    // (d) SHIP clean.
    perTarget[outputKey] = shipped(outputKey, selected, st, classFloor, base, fit, undefined);
  }

  // --- STEP 4: provenance. Model-identity OR self-contained, mirroring lite-tier0.
  //     The SIGNED gateHash (built below) is stamped in BOTH modes. ---
  const outDir = opts.outDir || (opts.chunkedDir ?? process.cwd());
  const baseBlock = buildBaseBlock(surface, perTarget, baseCaseInputs);
  const leanPerTarget = stripRanked(perTarget);
  const provenance = buildProvenance({
    opts, perTarget: leanPerTarget, baseBlock, candidateInputs, scope, useCase,
    surface, anyKink, outDir, undeclaredClassTargets,
  });

  const params = {
    $artifact: ARTIFACT_TAG,
    provenance,
    base: baseBlock,
    perTarget: leanPerTarget,
    inputs: {
      candidateInputs,
      drivers: scope.drivers,
      targetOutputKeys: targets,
      outputClasses,
      useCase,
      fitForm,
    },
  };

  let paramsPath;
  let runPath;
  if (write === true) {
    paramsPath = join(outDir, 'lite-surrogate.params.json');
    runPath = join(outDir, 'lite-surrogate.run.mjs');
    writeFileSync(paramsPath, JSON.stringify(params, null, 2));
    writeFileSync(runPath, renderRunShim(outDir));
  }

  return { paramsPath, runPath, params, perTarget, escalated };
}

/** Build a SHIPPED per-target entry (carries coeffs, fit metrics, optional disclosure). */
function shipped(outputKey, selected, st, classFloor, base, fit, disclosure) {
  const multiDriver = selected.length > 1;
  return {
    outputKey,
    fitForm: fit.fitForm,
    coeffs: fit.coeffs,
    base, // base-case output value; per-driver baseX is stamped on params.base.baseX
    rSquared: fit.rSquared,
    maxResidual: fit.maxResidual,
    classFloor,
    selected,
    driverCount: selected.length,
    breakpoint: st.breakpoint,
    coverage: st.coverage,
    escalateTier2: false,
    // ON-AXIS-ONLY metric flag: r²/maxResidual are measured on independent one-at-a-
    // time sweeps. For a multi-driver output they describe only the axes, NOT the
    // joint surface — a downstream consumer MUST NOT read the stamped r² as
    // joint-surface fidelity (ADR §5 interaction limitation). Single-driver outputs
    // are fully on-axis so the flag is false.
    offAxisUnverified: multiDriver,
    ...(disclosure ? { disclosure } : {}),
    ...(multiDriver
      ? { offAxisNote:
            `r2 ${fit.rSquared.toFixed(6)} and maxResidual are ON-AXIS metrics over ${selected.length} ` +
            `independent one-at-a-time sweeps (${selected.join(', ')}); the multiplicative form has no ` +
            `interaction term, so joint moves can be confidently wrong off-axis. Re-validate joint ` +
            `queries against the cone/engine; prefer a single-driver scope for 0.99-class outputs.` }
      : {}),
  };
}

/**
 * Build an ESCALATED per-target entry (NO coeffs — never a fabricated number).
 * When a fit WAS measured (a below-floor escalation), the measured r²/maxResidual
 * are stamped as measuredRSquared/measuredMaxResidual so an operator can see HOW
 * far below floor the fit landed without re-running (honesty signal).
 */
function escalation(outputKey, selected, st, classFloor, reason, fit) {
  return {
    outputKey,
    fitForm: null,
    coeffs: null,
    base: st.baseValue,
    rSquared: null,
    maxResidual: null,
    classFloor,
    selected,
    breakpoint: st.breakpoint,
    coverage: st.coverage,
    escalateTier2: true,
    reason,
    recommendedTier: 2,
    ...(fit ? { measuredRSquared: fit.rSquared, measuredMaxResidual: fit.maxResidual } : {}),
  };
}

/** Strip the bulky `ranked` arrays selectDrivers carried — keep the perTarget lean. */
function stripRanked(perTarget) {
  const out = {};
  for (const [k, v] of Object.entries(perTarget)) {
    const { ranked, ...rest } = v;
    out[k] = rest;
  }
  return out;
}

/**
 * The base block: per shipped output, its base value + the base value of each of
 * its selected drivers (baseX), so run() can compute Δ with no candidate ranges.
 */
function buildBaseBlock(surface, perTarget, baseCaseInputs) {
  const outputs = {};
  const baseX = {};
  for (const [k, v] of Object.entries(perTarget)) {
    outputs[k] = surface.baseCaseOutputs[k];
    if (!v.escalateTier2) {
      const bx = {};
      for (const d of v.selected) bx[d] = baseCaseInputs[d];
      baseX[k] = bx;
    }
  }
  return { outputs, baseX, inputs: baseCaseInputs };
}

/**
 * Build the provenance block. MODEL-IDENTITY mode (chunkedDir/manifest given)
 * stamps modelHash/structuralHash/structuralRefs like lite-tier0; SELF-CONTAINED
 * mode stamps a fitSignature so the artifact self-verifies with zero external files.
 * The SIGNED gateHash (per-output gate decision + load-bearing run() values) is
 * stamped in BOTH modes — it is the integrity layer the loader re-derives to refuse
 * a forced-ship, a value tamper, an r² lie, or a stripped disclosure.
 */
function buildProvenance({ opts, perTarget, baseBlock, candidateInputs, scope, useCase, surface, anyKink, outDir, undeclaredClassTargets }) {
  const prov = {
    disclosure: DISCLOSURE,
    kinkWarning: KINK_WARNING,
    anyKink,
    generatedAt: new Date().toISOString(),
  };

  // A non-fatal honesty signal: monetary-shaped money can be silently scoped under
  // the loose 'other' floor (0.95) if a caller forgets to declare its class. We
  // record (not throw — the class is the caller's contract) so it is visible.
  if (undeclaredClassTargets && undeclaredClassTargets.length > 0) {
    prov.undeclaredClassTargets = undeclaredClassTargets.slice();
    prov.undeclaredClassWarning =
      `these outputs were scoped under the default 'other' r2 floor (${R2_FLOORS.other}) because no ` +
      `output class was declared: ${undeclaredClassTargets.join(', ')}. If any is monetary/carry/mip, ` +
      `declare its class so the 0.99 floor governs — an undeclared money output can silently ship below ` +
      `its real floor.`;
  }

  // ── SIGNED gateHash (BOTH modes): per-output gate decision + run() values. ──
  const { gateHash, records } = signGateRecords(perTarget, baseBlock, useCase);
  prov.gateHash = gateHash;
  prov.gateRecords = records;

  // The coeffs-spec map the self-contained fitSignature digests (shape, NOT values).
  const perOutputBase = {};
  const coeffsSpec = {};
  for (const [k, v] of Object.entries(perTarget)) {
    perOutputBase[k] = surface.baseCaseOutputs[k];
    coeffsSpec[k] = v.escalateTier2 ? { escalated: true } : coeffsSpecFor(v);
  }

  const haveModelIdentity = (opts.chunkedDir && existsSync(join(opts.chunkedDir, 'manifest.json')))
    || (opts.manifest && typeof opts.manifest === 'object');

  if (haveModelIdentity) {
    const manifest = opts.manifest || undefined;
    const refs = manifest ? structuralRefs(manifest) : structuralRefs(loadManifestSafe(opts.chunkedDir));
    prov.mode = 'model-identity';
    prov.modelHash = opts.modelHash
      || (opts.chunkedDir ? deriveModelHash(opts.chunkedDir, manifest) : hashStructuralRefs(refs));
    prov.structuralHash = hashStructuralRefs(refs);
    prov.structuralRefs = refs;
    if (opts.chunkedDir) prov.chunkedDir = relativeIfInside(outDir, opts.chunkedDir);
  } else {
    prov.mode = 'self-contained';
    prov.fitSignature = fitSignature({
      candidateInputs,
      drivers: scope.drivers,
      perOutputBase,
      coeffsSpec,
      useCase,
    });
    // Embed the inputs the fitSignature digests so loadSurrogate can re-derive it.
    prov.fitSignatureInputs = {
      candidateInputs,
      drivers: scope.drivers,
      perOutputBase,
      coeffsSpec,
      useCase,
    };
  }
  return prov;
}

/** loadManifest without importing manifest.mjs at top level (only when needed). */
function loadManifestSafe(chunkedDir) {
  const p = join(chunkedDir, 'manifest.json');
  return JSON.parse(readFileSync(p, 'utf-8'));
}

/** Render the tiny generated run() shim (.mjs). Dependency-free, KB-sized. */
function renderRunShim(outDir) {
  const __dir = dirname(fileURLToPath(import.meta.url)); // .../lib
  let rel = relative(outDir, join(__dir, 'lite-surrogate.mjs')).split('\\').join('/');
  if (!rel.startsWith('.')) rel = './' + rel;
  return [
    '// excel-to-engine — Tier-1 surrogate run() shim (ADR-027). Generated; do not edit.',
    '// Refuses to load on a tampered/stale artifact (see params.provenance).',
    `import { loadSurrogate } from '${rel}';`,
    "export const run = loadSurrogate(new URL('./lite-surrogate.params.json', import.meta.url));",
    'export default run;',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// loadSurrogate — refuse-on-mismatch loader (mirror loadTier0 EXACTLY, plus the
// UNCONDITIONAL gateHash + floor-invariant re-gate that protects the money).
// ---------------------------------------------------------------------------

/**
 * Load a surrogate params artifact and return a bound run() closure. Refuses on
 * mismatch like loadTier0: throws on a wrong artifact tag, a missing verifiable
 * field, a self-integrity re-digest disagreement (TAMPER), or a stale model hash.
 *
 * The PRIMARY safety defense runs UNCONDITIONALLY (both provenance modes), BEFORE
 * any mode-specific check: re-derive the signed gateHash from the live params and
 * re-assert the floor invariant. This catches a forced-ship of a kinked/below-floor
 * output, a tampered coeff/base value, an r² lie, or a stripped by-request
 * disclosure — in self-contained AND model-identity mode alike.
 *
 * @param {string|URL} paramsPath
 * @returns {function(Object=): Object} run(overrides)
 */
export function loadSurrogate(paramsPath) {
  const p = paramsPath instanceof URL ? fileURLToPath(paramsPath) : paramsPath;
  const params = JSON.parse(readFileSync(p, 'utf-8'));
  if (params.$artifact !== ARTIFACT_TAG) {
    throw new Error(`Not a ${ARTIFACT_TAG} artifact: ${p} (found ${params.$artifact}).`);
  }
  const prov = params.provenance || {};
  const mode = prov.mode;

  // ── (0) UNCONDITIONAL gateHash re-derivation — the money-defending check. It
  //    signs the gate DECISION (escalateTier2) AND the load-bearing run() values
  //    (per-output base + coeff floats) AND the gate-outcome fields (rSquared,
  //    classFloor, disclosure presence, useCase). Re-derive from the LIVE params
  //    and compare; a mismatch is a tamper in EITHER provenance mode. ──────────────
  const useCase = params.inputs?.useCase;
  if (typeof prov.gateHash !== 'string' || !prov.gateRecords || typeof prov.gateRecords !== 'object') {
    throw new Error(
      `Surrogate artifact ${p} cannot be provenance-verified: missing provenance.gateHash / ` +
      `gateRecords (the signed per-output gate decision + run() values). Re-run emitSurrogate.`,
    );
  }
  const { gateHash: liveGate, records: liveRecords } = signGateRecords(params.perTarget || {}, params.base || {}, useCase);
  if (liveGate !== prov.gateHash) {
    throw new Error(
      `Surrogate artifact tampered: gateHash ${prov.gateHash} != ${liveGate} (re-derive of the live ` +
      `per-output gate decision + run() values). A flipped escalation flag, a tampered coeff/base, an ` +
      `r2 lie, or a stripped disclosure changes this digest. Re-run emitSurrogate.`,
    );
  }
  // Belt-and-braces: the live records must also equal the EMBEDDED gateRecords
  // (catches a tamper that somehow preserves the hash but edited the stamped record).
  if (stableStringify(liveRecords) !== stableStringify(prov.gateRecords)) {
    throw new Error(
      `Surrogate artifact tampered: live gateRecords disagree with the embedded provenance.gateRecords ` +
      `for ${p}. Re-run emitSurrogate.`,
    );
  }
  // Floor invariant (re-asserted directly, not only via the hash): a SHIPPED output
  // below its class floor must carry a BY-REQUEST disclosure AND the artifact's
  // useCase must be embedded-surrogate (ADR §5 carve-out). Otherwise refuse.
  assertFloorInvariant(p, params.perTarget || {}, useCase);

  // ── (A) self-integrity check of the "which model" layer (mode-specific). ──────
  if (mode === 'self-contained') {
    if (!prov.fitSignature || !prov.fitSignatureInputs) {
      throw new Error(
        `Surrogate artifact ${p} cannot be provenance-verified: missing ` +
        `provenance.fitSignature / fitSignatureInputs. Re-run emitSurrogate.`,
      );
    }
    const live = fitSignature(prov.fitSignatureInputs);
    if (live !== prov.fitSignature) {
      throw new Error(
        `Surrogate artifact tampered: fitSignature ${prov.fitSignature} != ${live} ` +
        `(re-digest of embedded fitSignatureInputs). Re-run emitSurrogate.`,
      );
    }
    // The embedded coeffsSpec must agree with the SHIPPED perTarget shape (shape layer).
    assertSpecMatchesPerTarget(p, prov.fitSignatureInputs.coeffsSpec, params.perTarget);
  } else if (mode === 'model-identity') {
    // (A) self-integrity / (B) live-model / (C) graph-free guard — the
    // byte-throw-identical block shared with loadTier0, now in lib/lite-provenance.
    // (The UNCONDITIONAL gateHash + floor invariant above stay LOCAL — they are the
    // surrogate-specific money-defending layer.)
    verifyModelLayer({ prov, paramsPath: p, label: 'Surrogate' });
  } else {
    throw new Error(
      `Surrogate artifact ${p} has no recognized provenance.mode ('${mode}'); ` +
      `cannot be provenance-verified. Re-run emitSurrogate.`,
    );
  }

  return buildSurrogateRun(params);
}

/**
 * Re-assert the ADR §5 floor invariant on EVERY shipped output, directly from the
 * live params (independent of the hash). A shipped output (escalateTier2 falsy)
 * whose rSquared < classFloor is ILLEGAL unless it carries a BY-REQUEST disclosure
 * AND the artifact's useCase is 'embedded-surrogate'. A shipped output missing its
 * rSquared/classFloor is also refused (it cannot be floor-checked).
 */
function assertFloorInvariant(p, perTarget, useCase) {
  for (const [k, t] of Object.entries(perTarget || {})) {
    if (t.escalateTier2) continue; // escalated outputs ship no number — nothing to floor-check
    const r2 = t.rSquared;
    const floor = t.classFloor;
    if (typeof r2 !== 'number' || typeof floor !== 'number') {
      throw new Error(
        `Surrogate artifact ${p} tampered: shipped output '${k}' is missing a numeric ` +
        `rSquared/classFloor — it cannot be floor-verified. Re-run emitSurrogate.`,
      );
    }
    if (r2 < floor) {
      const byRequestOK = !!t.disclosure
        && /BY-REQUEST SURROGATE BELOW FLOOR/.test(t.disclosure)
        && useCase === 'embedded-surrogate';
      if (!byRequestOK) {
        throw new Error(
          `Surrogate artifact ${p} tampered: shipped output '${k}' has rSquared ${r2} < classFloor ` +
          `${floor} but no BY-REQUEST disclosure under an embedded-surrogate useCase (useCase '${useCase}'). ` +
          `ADR §5 forbids silently shipping a below-floor output — it must escalate, or ship by-request ` +
          `under a LOUD disclosure. Re-run emitSurrogate.`,
        );
      }
    }
  }
}

/**
 * Cross-check that the embedded coeffsSpec (which the fitSignature digests) agrees
 * with the SHIPPED perTarget shape. Catches a half-tamper: editing a shipped coeff
 * value/fitForm without editing the signed coeffsSpec leaves the two disagreeing.
 * (Self-contained-mode shape layer; the gateHash above is the authoritative,
 * mode-independent defense.)
 */
function assertSpecMatchesPerTarget(p, coeffsSpec, perTarget) {
  for (const [k, spec] of Object.entries(coeffsSpec || {})) {
    const t = (perTarget || {})[k];
    if (!t) {
      throw new Error(`Surrogate artifact ${p} tampered: signed output '${k}' is missing from perTarget.`);
    }
    if (spec.escalated) {
      if (!t.escalateTier2) {
        throw new Error(
          `Surrogate artifact ${p} tampered: output '${k}' is signed as ESCALATED but perTarget ` +
          `ships it (escalateTier2!=true) — a kinked/below-floor output cannot be silently shipped.`,
        );
      }
      continue;
    }
    if (t.escalateTier2 || t.fitForm !== spec.fitForm) {
      throw new Error(
        `Surrogate artifact ${p} tampered: output '${k}' fitForm/escalation disagrees with the ` +
        `signed spec (signed fitForm '${spec.fitForm}', perTarget fitForm '${t.fitForm}', ` +
        `escalated ${t.escalateTier2}).`,
      );
    }
    const drivers = spec.fitForm === 'poly' ? Object.keys(t.coeffs?.polys || {}) : Object.keys(t.coeffs?.betas || {});
    const want = spec.drivers.slice().sort().join(',');
    const got = drivers.slice().sort().join(',');
    if (want !== got) {
      throw new Error(
        `Surrogate artifact ${p} tampered: output '${k}' coeff drivers disagree with the signed spec ` +
        `(signed ${want}, coeffs ${got}).`,
      );
    }
  }
}

/**
 * Build the bound run() closure from a verified params object. For each SHIPPED
 * output it evaluates the surrogate formula over the OVERRIDDEN selected drivers
 * (others at base ⇒ Δ=0). An ESCALATED output is ABSENT from the result map — its
 * key returns {escalated:true, recommendedTier:2} — NEVER a fabricated number.
 *
 * @param {Object} params
 * @returns {function(Object=): Object}
 */
export function buildSurrogateRun(params) {
  const baseOutputs = params.base?.outputs || {};
  const baseX = params.base?.baseX || {};
  const perTarget = params.perTarget || {};

  return function run(overrides = {}) {
    const out = {};
    for (const [k, t] of Object.entries(perTarget)) {
      if (t.escalateTier2) {
        // Surface the escalation explicitly — never a number.
        out[k] = { escalated: true, recommendedTier: t.recommendedTier ?? 2 };
        continue;
      }
      const base = baseOutputs[k];
      const bx = baseX[k] || {};
      // Build the per-driver overridden inputs (only this output's selected drivers).
      const inputs = {};
      for (const d of t.selected) {
        if (overrides[d] !== undefined) inputs[d] = overrides[d];
      }
      out[k] = t.fitForm === 'poly'
        ? predictPoly(base, t.coeffs.polys, bx, inputs)
        : predictMultiplicative(base, t.coeffs.betas, bx, inputs);
    }
    return out;
  };
}

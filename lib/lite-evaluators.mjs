/**
 * excel-to-engine — Lite Evaluator Adapters (ADR-027 Phase 3)
 *
 * driver-scope (lib/driver-scope.mjs) and the Phase-4 surrogate fit need a
 * uniform PLUGGABLE evaluator
 *
 *     evaluator: (inputs:{[key:string]:number}) => groupedResult
 *
 * where `groupedResult` is shaped for lib/sensitivity.mjs flattenOutputs(): it
 * walks the nested groups ['returns','waterfall','mip','exitValuation','perShare']
 * and emits a dot-path key per NUMERIC-or-BOOLEAN leaf (e.g. {returns:{grossMOIC:2}}
 * -> "returns.grossMOIC"). A FLAT {totalCarry:n} yields ZERO keys, so every adapter
 * here MUST return the grouped shape.
 *
 * This file provides three REAL adapters plus one documented stub:
 *   • cascadeEvaluator       — wraps cli/solvers/delta-cascade.mjs computeScenario,
 *                              reshaping its FLAT scenario into the grouped shape.
 *   • directEvaluator        — wraps a compute fn that ALREADY returns the grouped
 *                              shape (synthetic-pe-model computeModel, or an
 *                              already-grouped engine.run); returns it VERBATIM.
 *   • engineRunEvaluator     — generic adapter over a chunked engine run(overrides)
 *                              plus an outputsSpec mapping engine cells -> grouped
 *                              dot-paths.
 *   • workbookVariantEvaluator — documented STUB (Phase 3 follow-on); throws.
 *
 * ─── SHAPE INVARIANTS (read before changing any reshape) ──────────────────────
 *  (1) Only numeric/finite or boolean leaves are PRESENT. null (delta-cascade
 *      returns totalCarry:null below the pref hurdle, pricePerShare:null when
 *      sharesOutstanding is absent), undefined, NaN, and object leaves (carryDetail)
 *      are OMITTED — never set — so flattenOutputs never emits a dead key.
 *  (2) A group whose only leaves were omitted is dropped entirely (no empty group).
 *  (3) A FLAT {totalCarry:n} is NEVER returned (it would yield zero keys downstream).
 *  (4) directEvaluator does NOT reshape — the synthetic engine already emits the
 *      grouped shape; reshaping would corrupt perShare.gross/net. It validates a
 *      known group exists and returns the upstream object as-is.
 *
 * @license MIT
 */

import { computeScenario } from '../cli/solvers/delta-cascade.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Groups flattenOutputs walks; an adapter must place leaves under one of these. */
export const KNOWN_GROUPS = ['returns', 'waterfall', 'mip', 'exitValuation', 'perShare'];

/**
 * Scalar adjustment fields read directly off `adjustments` by computeScenario
 * (enumerated from cli/solvers/delta-cascade.mjs). A bare driverKey that matches
 * one of these passes through to adjustments[key]. Object/array fields
 * (revenueAdj, revenueGrowth, costAdj, removeSegments, lineItems, capitalize,
 * distributions, sotp/segmentMultiples) require a FUNCTION-form inputMap entry.
 */
export const KNOWN_SCALAR_ADJUSTMENTS = [
  'exitYear',
  'exitMultiple',
  'revenueMultiple',
  'leverage',
  'holdPeriod',
  'prefReturn',
  'equityOverride',
];

/**
 * Default cascade reshape: { groupName: { destLeaf: srcKeyInFlatScenario } }.
 * Used by cascadeEvaluator unless opts.mapping overrides it.
 */
export const DEFAULT_CASCADE_MAPPING = {
  returns: {
    grossMOIC: 'grossMOIC',
    grossIRR: 'grossIRR',
    netMOIC: 'netMOIC',
    netIRR: 'netIRR',
  },
  waterfall: { totalCarry: 'totalCarry' },
  exitValuation: {
    exitEBITDA: 'exitEBITDA',
    terminalValue: 'terminalValue',
    exitEquity: 'exitEquity',
  },
  perShare: { price: 'pricePerShare' },
};

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

/** A leaf survives only if it is a finite number or a boolean. */
function isLiveLeaf(v) {
  return (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean';
}

/**
 * Reshape a FLAT scenario object into the nested grouped shape flattenOutputs
 * walks, keeping ONLY numeric/finite or boolean leaves.
 *
 * For each destination leaf, reads flatScenario[srcKey] and includes it iff it is
 * a finite number or a boolean. null (cascade totalCarry below the hurdle,
 * pricePerShare without shares), undefined, NaN, and object leaves (carryDetail)
 * are SKIPPED. A group with zero surviving leaves is omitted entirely so
 * flattenOutputs never emits a dead/non-numeric key. Pure, no deps.
 *
 * @param {Object<string,*>} flatScenario - flat result (e.g. computeScenario(...).scenario)
 * @param {Object<string,Object<string,string>>} mapping - { group: { destLeaf: srcKey } }
 * @returns {Object} grouped result containing only live leaves
 */
export function toGroupedOutputs(flatScenario, mapping) {
  const flat = flatScenario || {};
  const grouped = {};
  for (const [group, leaves] of Object.entries(mapping || {})) {
    const dest = {};
    for (const [destLeaf, srcKey] of Object.entries(leaves)) {
      const v = flat[srcKey];
      if (isLiveLeaf(v)) dest[destLeaf] = v;
    }
    if (Object.keys(dest).length > 0) grouped[group] = dest;
  }
  return grouped;
}

/** True iff `o` is a non-null object carrying at least one KNOWN_GROUPS key. */
function hasKnownGroup(o) {
  return (
    o != null &&
    typeof o === 'object' &&
    KNOWN_GROUPS.some((g) => Object.prototype.hasOwnProperty.call(o, g))
  );
}

// ---------------------------------------------------------------------------
// 1) cascadeEvaluator — delta-cascade computeScenario
// ---------------------------------------------------------------------------

/**
 * Build an evaluator over cli/solvers/delta-cascade.mjs computeScenario for a
 * given manifest + ground truth. The returned closure maps numeric `inputs` to a
 * computeScenario `adjustments` object, runs the cascade, and reshapes the FLAT
 * scenario into the grouped shape (via toGroupedOutputs).
 *
 * driverKey -> adjustment resolution (per key):
 *   • opts.inputMap[key] is a STRING -> adjustments[that field] = value
 *     (aliases a driverKey onto a scalar adjustment field, e.g. { exitYr:'exitYear' }).
 *   • opts.inputMap[key] is a FUNCTION -> fn(value, adjustments) mutates adjustments
 *     (the ONLY way to push into array/object fields like revenueAdj / segmentMultiples).
 *   • opts.inputMap[key] is PRESENT but not string|function -> THROW (a malformed
 *     mapping is a caller bug; never silently fall through to the scalar pass-through).
 *   • key absent from inputMap AND key is a KNOWN_SCALAR_ADJUSTMENTS field -> pass
 *     through adjustments[key] = value (default).
 *   • otherwise -> THROW (an unmapped, unknown driverKey fails loud, never silently
 *     no-ops — a typo'd lever would otherwise look like "this lever does nothing").
 *
 * A non-finite numeric driver value (NaN / Infinity) THROWS before mapping:
 * computeScenario reads scalar levers with a truthy `||`, so NaN would be silently
 * discarded (base-case fallback) and Infinity would drop a whole grouped group —
 * either masquerading as a valid sweep sample. Fail loud is the safe direction.
 *
 * @param {Object} manifest - model manifest
 * @param {Object} gt - ground truth {addr: value}
 * @param {Object} [opts]
 * @param {Object<string, (string|Function)>} [opts.inputMap] - driverKey -> field|fn
 * @param {Object} [opts.baseAdjustments] - seed adjustments before per-input mapping
 * @param {Object} [opts.mapping] - reshape map (default DEFAULT_CASCADE_MAPPING)
 * @returns {(inputs:Object<string,number>)=>Object} grouped-result evaluator
 */
export function cascadeEvaluator(manifest, gt, opts = {}) {
  if (!manifest || typeof manifest !== 'object') {
    throw new TypeError('cascadeEvaluator: manifest must be an object');
  }
  if (!gt || typeof gt !== 'object') {
    throw new TypeError('cascadeEvaluator: gt (ground truth) must be an object');
  }
  const inputMap = opts.inputMap || {};
  const mapping = opts.mapping ?? DEFAULT_CASCADE_MAPPING;

  return function evaluate(inputs = {}) {
    // Seed shared constant levers, then apply per-input mapping.
    const adjustments = opts.baseAdjustments
      ? JSON.parse(JSON.stringify(opts.baseAdjustments))
      : {};

    for (const [key, value] of Object.entries(inputs)) {
      // Reject a non-finite numeric driver value LOUDLY. computeScenario reads
      // scalar levers with a truthy `||`, so a NaN value is FALSY and silently
      // discarded -> the evaluator would return the BASE case for a corrupt input
      // (NaN), or drop a whole group (Infinity), masquerading as a valid sample in
      // a driver sweep. Fail fast instead so the caller pre-validates its grid.
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new Error(
          `cascadeEvaluator: non-finite value for driver "${key}": ${value}. ` +
            `A NaN/Infinity lever would silently fall back to the base case or ` +
            `drop a group; callers must pass finite numeric driver values.`,
        );
      }
      const mapped = inputMap[key];
      if (typeof mapped === 'string') {
        adjustments[mapped] = value;
      } else if (typeof mapped === 'function') {
        mapped(value, adjustments);
      } else if (mapped !== undefined) {
        // A present-but-malformed inputMap entry (not string|function) is a caller
        // bug — never silently fall through to the scalar pass-through, which would
        // mask the typo when the driverKey ALSO happens to be a known scalar field.
        throw new Error(
          `cascadeEvaluator: inputMap["${key}"] must be a string field name or ` +
            `a (value, adj)=>void mutator; got ${typeof mapped}.`,
        );
      } else if (KNOWN_SCALAR_ADJUSTMENTS.includes(key)) {
        adjustments[key] = value;
      } else {
        throw new Error(
          `cascadeEvaluator: unmapped/unknown driverKey "${key}". Provide ` +
            `opts.inputMap["${key}"] (a scalar adjustment field name, or a ` +
            `(value, adj)=>void mutator for array/object levers), or use one of ` +
            `the known scalar fields: ${KNOWN_SCALAR_ADJUSTMENTS.join(', ')}.`,
        );
      }
    }

    const result = computeScenario(manifest, gt, adjustments);
    return toGroupedOutputs(result.scenario, mapping);
  };
}

// ---------------------------------------------------------------------------
// 2) directEvaluator — compute fn that ALREADY returns the grouped shape
// ---------------------------------------------------------------------------

/**
 * Wrap a compute fn that ALREADY returns the grouped shape (synthetic-pe-model
 * computeModel, or a chunked engine.run that is already grouped). The returned
 * closure merges { ...opts.baseInputs, ...inputs }, calls computeFn(merged), and
 * returns the result VERBATIM after validating it carries >=1 known group. It does
 * NOT reshape — reshaping an already-grouped engine would corrupt its leaves.
 *
 * @param {Function} computeFn - (inputs)=>groupedResult
 * @param {Object} [opts]
 * @param {Object<string,number>} [opts.baseInputs] - merged UNDER `inputs` (inputs win)
 * @returns {(inputs:Object<string,number>)=>Object} grouped-result evaluator
 */
export function directEvaluator(computeFn, opts = {}) {
  if (typeof computeFn !== 'function') {
    throw new TypeError('directEvaluator: computeFn must be a function (inputs)=>groupedResult');
  }
  const baseInputs = opts.baseInputs || {};

  return function evaluate(inputs = {}) {
    const merged = { ...baseInputs, ...inputs };
    const result = computeFn(merged);
    if (!hasKnownGroup(result)) {
      const keys =
        result && typeof result === 'object' ? Object.keys(result).join(', ') : String(result);
      throw new Error(
        'directEvaluator: computeFn returned no known output group ' +
          '(returns/waterfall/mip/exitValuation/perShare); got keys: ' +
          keys,
      );
    }
    return result;
  };
}

// ---------------------------------------------------------------------------
// 3) engineRunEvaluator — chunked engine run(overrides) + outputsSpec
// ---------------------------------------------------------------------------

/**
 * Generic adapter over an already-loaded chunked engine `run(overrides) => cellMap`
 * plus an outputsSpec that maps engine output cells/named-outputs to grouped
 * dot-paths. Because the committed chunked fixtures carry NO named-outputs map,
 * this is unit-tested with a deterministic stub run() + a tiny outputsSpec.
 *
 * @param {Object} cfg
 * @param {(overrides:Object)=>Object<string,*>} cfg.run - engine run; flat cellRef->value map
 * @param {Array<{cell:string,group:string,leaf:string,class?:('monetary'|'ratio'|'flag')}>} cfg.outputsSpec
 *        - `class` is advisory metadata for callers, NOT used in reshaping.
 * @param {Object<string,(string|Function)>} [cfg.inputMap] - driverKey -> cellRef | (value, overrides)=>void
 * @returns {(inputs:Object<string,number>)=>Object} grouped-result evaluator
 */
export function engineRunEvaluator({ run, outputsSpec, inputMap } = {}) {
  if (typeof run !== 'function') {
    throw new TypeError('engineRunEvaluator: run must be a function (overrides)=>cellMap');
  }
  if (!Array.isArray(outputsSpec) || outputsSpec.length === 0) {
    throw new TypeError('engineRunEvaluator: outputsSpec must be a non-empty array');
  }
  const map = inputMap || {};

  return function evaluate(inputs = {}) {
    // 1) translate numeric inputs -> engine overrides
    const overrides = {};
    for (const [key, value] of Object.entries(inputs)) {
      const mapped = map[key];
      if (typeof mapped === 'string') {
        overrides[mapped] = value;
      } else if (typeof mapped === 'function') {
        mapped(value, overrides);
      } else {
        overrides[key] = value; // default pass-through
      }
    }

    // 2) run the engine -> flat {cellRef: value} map. Validate the RETURN type:
    // a half-wired engine that returns a scalar (number/string) would otherwise be
    // indistinguishable from "all outputs missing" — every leaf omitted, an empty
    // grouped result that a sweep reads as a degenerate/error point with no
    // diagnostic. null/undefined is the sanctioned "no cells" sentinel -> {}.
    const cellMap = run(overrides);
    if (cellMap != null && typeof cellMap !== 'object') {
      throw new TypeError(
        `engineRunEvaluator: run() must return a {cellRef:value} object (or null), ` +
          `got ${typeof cellMap}.`,
      );
    }
    const cells = cellMap || {};

    // 3) reshape per spec; omit missing/non-live cells.
    const grouped = {};
    for (const spec of outputsSpec) {
      const v = cells[spec.cell];
      if (!isLiveLeaf(v)) continue;
      (grouped[spec.group] ||= {})[spec.leaf] = v;
    }
    return grouped;
  };
}

// ---------------------------------------------------------------------------
// 4) workbookVariantEvaluator — documented STUB (Phase 3 follow-on)
// ---------------------------------------------------------------------------

/**
 * DOCUMENTED STUB (ADR-027 Phase 3 follow-on) — NOT yet implemented.
 *
 * Intended real signature: given a set of pre-saved .xlsx design-of-experiments
 * variants keyed by input vector (an analyst re-saves the workbook at each DOE
 * point), recompute each variant through a workbook engine and return the grouped
 * shape for the variant whose input vector matches `inputs`. Calling it (or its
 * returned closure) throws a clear not-implemented error so callers fail loudly.
 *
 * @param {Object} _opts - reserved (variant set, key vector, workbook engine)
 * @returns {never}
 */
export function workbookVariantEvaluator(_opts) {
  throw new Error(
    'not implemented: analyst re-saved .xlsx DOE variants — ADR-027 Phase 3 follow-on',
  );
}

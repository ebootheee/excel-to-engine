#!/usr/bin/env node
/**
 * Tests for lib/lite-evaluators.mjs — ADR-027 Phase 3 evaluator adapters.
 *
 * Follows docs/LITE-TEST-STANDARD.md: non-circular truth (expected values are
 * derived INDEPENDENTLY — from computeScenario(...).base / first-principles
 * arithmetic / a hand-built stub map — never read back from the adapter under
 * test), >=1 NEGATIVE control, >=1 t.mutationGuard, committed fixtures only, no
 * network, no clock/random. Runs standalone:
 *
 *   node tests/lib/test-lite-evaluators.mjs
 *
 * @license MIT
 */

import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { makeHarness, clone } from './_lite-harness.mjs';
import {
  toGroupedOutputs,
  cascadeEvaluator,
  directEvaluator,
  engineRunEvaluator,
  workbookVariantEvaluator,
  DEFAULT_CASCADE_MAPPING,
} from '../../lib/lite-evaluators.mjs';
import { computeScenario } from '../../cli/solvers/delta-cascade.mjs';
import { computeModel } from '../../tests/synthetic-pe-model/engine.js';
import { selectDrivers } from '../../lib/driver-scope.mjs';
import { flattenOutputs } from '../../lib/sensitivity.mjs';

const t = makeHarness('lib/lite-evaluators.mjs');

// Committed fixtures (the only sanctioned cascade inputs).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, '..', 'cli', 'fixtures');
const manifest = JSON.parse(fs.readFileSync(path.join(FIX, 'synthetic-manifest.json'), 'utf8'));
const gt = JSON.parse(fs.readFileSync(path.join(FIX, 'synthetic-gt.json'), 'utf8'));

// ═════════════════════════════════════════════════════════════════════════════
// toGroupedOutputs — UNIT (hand-built flat, non-circular)
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing toGroupedOutputs unit reshaping + null/object-leaf omission');
{
  const g = toGroupedOutputs(
    {
      grossMOIC: 2.5,
      grossIRR: 0.18,
      totalCarry: 1000,
      exitEBITDA: 59,
      pricePerShare: 42,
      carryDetail: { x: 1 },
    },
    DEFAULT_CASCADE_MAPPING,
  );
  // Assert group/leaf PRESENCE before dereferencing so a dropped group reports a
  // labeled FAIL (and names the missing group) instead of crashing the file on a
  // raw TypeError — keeps a future "mapping drops a whole group" mutation diagnosable.
  t.assert(g.returns && 'grossMOIC' in g.returns, 'returns.grossMOIC present');
  t.eq(g.returns.grossMOIC, 2.5, 'returns.grossMOIC reshaped from flat grossMOIC');
  t.eq(g.returns.grossIRR, 0.18, 'returns.grossIRR reshaped');
  t.assert(g.waterfall && 'totalCarry' in g.waterfall, 'waterfall.totalCarry present');
  t.eq(g.waterfall.totalCarry, 1000, 'waterfall.totalCarry reshaped');
  t.assert(g.exitValuation && 'exitEBITDA' in g.exitValuation, 'exitValuation.exitEBITDA present');
  t.eq(g.exitValuation.exitEBITDA, 59, 'exitValuation.exitEBITDA reshaped');
  t.assert(g.perShare && 'price' in g.perShare, 'perShare.price present');
  t.eq(g.perShare.price, 42, 'perShare.price reshaped from pricePerShare');
  t.assert(!('carryDetail' in (g.waterfall || {})), 'object leaf carryDetail never appears (skipped)');

  // null / NaN / object-leaf omission -> whole group dropped when no live leaf.
  const g2 = toGroupedOutputs(
    { grossMOIC: 2.5, totalCarry: null, pricePerShare: NaN, carryDetail: { a: 1 } },
    DEFAULT_CASCADE_MAPPING,
  );
  t.assert(!('totalCarry' in (g2.waterfall || {})), 'null totalCarry omitted');
  t.assert(!('waterfall' in g2), 'waterfall group omitted entirely (its only leaf was null)');
  t.assert(!('price' in (g2.perShare || {})), 'NaN pricePerShare omitted');
  t.assert(!('perShare' in g2), 'perShare group omitted (its only leaf was NaN)');
  t.assert(g2.returns && g2.returns.grossMOIC === 2.5, 'the live returns.grossMOIC survives');

  // No dead keys reach the sweeper.
  const fo = flattenOutputs(g2);
  t.assert('returns.grossMOIC' in fo, 'flattenOutputs keeps the live returns.grossMOIC');
  t.assert(!('waterfall.totalCarry' in fo), 'flattenOutputs emits NO dead waterfall.totalCarry key');
}

// ═════════════════════════════════════════════════════════════════════════════
// cascadeEvaluator — BASE CASE (non-circular truth from computeScenario.base)
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing cascadeEvaluator base case (non-circular) + shape coupling');
{
  const evalC = cascadeEvaluator(manifest, gt);
  const base = evalC({});

  // Truth #1: derived from computeScenario(...).base, NOT from evalC.
  const expectedMOIC = computeScenario(manifest, gt, {}).base.grossMOIC;
  t.near(base.returns.grossMOIC, expectedMOIC, 1e-9, 'base returns.grossMOIC == computeScenario base.grossMOIC');

  // Truth #2: first-principles arithmetic (exitEquity / equityBasis).
  const b = computeScenario(manifest, gt, {}).base;
  const truthMOIC = b.exitEquity / b.equityBasis; // 748670000 / 270000000 = 2.77285...
  t.near(base.returns.grossMOIC, truthMOIC, 1e-9, 'base returns.grossMOIC == exitEquity/equityBasis (2.77285...)');
  t.near(truthMOIC, 748670000 / 270000000, 1e-12, 'design: truthMOIC is the hand value');

  // SHAPE coupling: the grouped shape survives the real sweeper, NO flat leak.
  const fo = flattenOutputs(base);
  t.assert('returns.grossMOIC' in fo, 'flattenOutputs sees returns.grossMOIC');
  t.assert('exitValuation.terminalValue' in fo, 'flattenOutputs sees exitValuation.terminalValue');
  t.assert('exitValuation.exitEquity' in fo, 'flattenOutputs sees exitValuation.exitEquity');
  t.assert('perShare.price' in fo, 'flattenOutputs sees perShare.price');
  t.assert('waterfall.totalCarry' in fo, 'flattenOutputs sees waterfall.totalCarry (above hurdle at base)');
  t.assert(!('grossMOIC' in fo), 'NO flat top-level grossMOIC key leaks (it is nested under returns)');
}

// ═════════════════════════════════════════════════════════════════════════════
// cascadeEvaluator — MONOTONIC exitMultiple sweep (truth from computeScenario)
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing cascadeEvaluator monotonic exitMultiple sweep');
{
  const evalC = cascadeEvaluator(manifest, gt);
  const ems = [14, 16, 18.5, 20, 22];
  let prev = -Infinity;
  for (const em of ems) {
    const got = evalC({ exitMultiple: em }).returns.grossMOIC;
    // strictly increasing
    t.assert(got > prev, `grossMOIC strictly increases at exitMultiple=${em} (got ${got} > prev ${prev})`);
    prev = got;
    // direction matches independent truth from computeScenario.scenario
    const truth = computeScenario(manifest, gt, { exitMultiple: em }).scenario.grossMOIC;
    t.near(got, truth, 1e-9, `grossMOIC at em=${em} matches computeScenario.scenario (non-circular)`);
  }

  // NULL-LEAF live case: below the pref hurdle, totalCarry is null -> omitted.
  const low = evalC({ exitMultiple: 12 });
  t.assert(!('totalCarry' in (low.waterfall || {})), 'below-hurdle totalCarry omitted at exitMultiple=12');
  // sanity: computeScenario really returns null there (the trigger we are guarding)
  t.eq(computeScenario(manifest, gt, { exitMultiple: 12 }).scenario.totalCarry, null,
    'design: computeScenario totalCarry IS null at exitMultiple=12');
}

// ═════════════════════════════════════════════════════════════════════════════
// cascadeEvaluator — DECLARATIVE inputMap (non-scalar lever via fn form)
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing cascadeEvaluator declarative inputMap (revenueAdj push)');
{
  const evalG = cascadeEvaluator(manifest, gt, {
    inputMap: {
      techCut: (v, adj) => {
        (adj.revenueAdj ||= []).push({ segment: 'techGP', type: 'percent', value: v });
      },
    },
  });
  const got = evalG({ techCut: -0.2 }).exitValuation.exitEBITDA;
  // Independent truth: feed computeScenario the equivalent adjustments directly.
  const truth = computeScenario(manifest, gt, {
    revenueAdj: [{ segment: 'techGP', type: 'percent', value: -0.2 }],
  }).scenario.exitEBITDA; // = 54460000
  t.near(got, truth, 1e-6, 'fn-form inputMap pushes revenueAdj; exitEBITDA matches computeScenario');
  t.eq(truth, 54460000, 'design: techGP -20% exitEBITDA is the hand value 54460000');

  // STRING-form alias: driverKey 'exitYr' -> adjustments.exitYear.
  const evalAlias = cascadeEvaluator(manifest, gt, { inputMap: { exitYr: 'exitYear' } });
  const aliasGot = evalAlias({ exitYr: 2029 }).returns.grossMOIC;
  const aliasTruth = computeScenario(manifest, gt, { exitYear: 2029 }).scenario.grossMOIC;
  t.near(aliasGot, aliasTruth, 1e-9, 'string-form inputMap aliases exitYr -> adjustments.exitYear');
}

// ═════════════════════════════════════════════════════════════════════════════
// cascadeEvaluator — NEGATIVE CONTROL #1: unmapped unknown lever throws
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing cascadeEvaluator negative control (unmapped lever throws)');
{
  t.throws(
    () => cascadeEvaluator(manifest, gt)({ bogusLever: 5 }),
    /bogusLever|unknown|unmapped/,
    'an unmapped unknown driverKey throws, does not silently no-op',
  );
  // also: non-object manifest/gt rejected up front
  t.throws(() => cascadeEvaluator(null, gt), /manifest/, 'null manifest rejected');
  t.throws(() => cascadeEvaluator(manifest, null), /gt|ground/, 'null gt rejected');
}

// ═════════════════════════════════════════════════════════════════════════════
// cascadeEvaluator — NON-FINITE input rejected (NaN base-case fallback / Inf group-drop)
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing cascadeEvaluator non-finite input guard (NaN/Infinity throw)');
{
  const evalC = cascadeEvaluator(manifest, gt);
  // Independent proof of the hazard: computeScenario SILENTLY swallows a NaN lever
  // (truthy `||` read) -> base case; Infinity -> the returns group is dropped.
  const baseMOIC = computeScenario(manifest, gt, {}).base.grossMOIC;
  const nanScenarioMOIC = computeScenario(manifest, gt, { exitMultiple: NaN }).scenario.grossMOIC;
  t.near(nanScenarioMOIC, baseMOIC, 1e-9,
    'design: computeScenario silently swallows NaN exitMultiple -> base case (the hazard)');
  // The adapter must convert that silent base-case fallback into a LOUD failure.
  t.throws(() => evalC({ exitMultiple: NaN }), /non-finite|finite/,
    'NaN driver value throws (no silent base-case fallback)');
  t.throws(() => evalC({ exitMultiple: Infinity }), /non-finite|finite/,
    'Infinity driver value throws (no silent group-drop)');
  t.throws(() => evalC({ holdPeriod: -Infinity }), /non-finite|finite/,
    '-Infinity driver value throws');
}

// ═════════════════════════════════════════════════════════════════════════════
// cascadeEvaluator — MALFORMED inputMap entry rejected (not string|function)
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing cascadeEvaluator malformed inputMap guard');
{
  // A number-valued inputMap entry is a caller bug. Even though `exitMultiple` is a
  // KNOWN_SCALAR_ADJUSTMENTS field (so it WOULD pass through if the malformed entry
  // were ignored), the adapter must throw rather than silently mask the typo.
  const evalBad = cascadeEvaluator(manifest, gt, { inputMap: { exitMultiple: 999 } });
  t.throws(() => evalBad({ exitMultiple: 14 }), /inputMap.*string|string.*field|mutator/,
    'a number-valued inputMap entry throws (not silently ignored even for a scalar key)');
}

// ═════════════════════════════════════════════════════════════════════════════
// directEvaluator — synthetic engine (returns grouped shape verbatim)
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing directEvaluator on synthetic-pe-model computeModel');
{
  const evalD = directEvaluator(computeModel);
  const out = evalD({});
  const fo = flattenOutputs(out);
  t.assert('returns.grossMOIC' in fo, 'flattenOutputs sees returns.grossMOIC');
  t.assert('waterfall.gpCarry' in fo, 'flattenOutputs sees waterfall.gpCarry');
  t.assert('mip.triggered' in fo, 'flattenOutputs sees mip.triggered (boolean leaf)');

  // NON-CIRCULAR truth: the engine IS the upstream truth; the adapter returns it verbatim.
  t.near(out.returns.grossMOIC, computeModel({}).returns.grossMOIC, 1e-12, 'grossMOIC == upstream computeModel (verbatim)');
  t.eq(out.mip.triggered, true, 'mip.triggered === true at base case');

  // VERBATIM (no-reshape) invariant (4): the synthetic engine emits perShare:{gross,net}
  // (cascade emits perShare:{price}). directEvaluator must NOT route through
  // toGroupedOutputs — that would collapse these to {price} and silently drop them.
  // This is the leaf the invariant exists to protect; assert it survives untouched.
  t.assert(out.perShare && 'gross' in out.perShare, 'perShare.gross present (verbatim, not collapsed to {price})');
  t.assert('net' in out.perShare, 'perShare.net survives (verbatim)');
  t.near(out.perShare.gross, computeModel({}).perShare.gross, 1e-12, 'perShare.gross passed through verbatim (no reshape)');
  t.near(out.perShare.net, computeModel({}).perShare.net, 1e-12, 'perShare.net passed through verbatim (no reshape)');
  t.assert(!('price' in out.perShare), 'no reshape: perShare has NO {price} key (that is cascade-only)');

  // baseInputs merge: inputs OVERRIDE baseInputs.
  const evalD2 = directEvaluator(computeModel, { baseInputs: { exitMultiple: 1.2 } });
  t.near(evalD2({}).returns.grossMOIC, computeModel({ exitMultiple: 1.2 }).returns.grossMOIC, 1e-12,
    'baseInputs applied when inputs omit the key');
  t.near(evalD2({ exitMultiple: 2.6 }).returns.grossMOIC, computeModel({ exitMultiple: 2.6 }).returns.grossMOIC, 1e-12,
    'inputs override baseInputs (merge order)');
}

// ═════════════════════════════════════════════════════════════════════════════
// directEvaluator + selectDrivers END-TO-END (the required proof)
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing directEvaluator + selectDrivers end-to-end (driver pick)');
{
  const r = selectDrivers(
    directEvaluator(computeModel),
    {
      exitMultiple: { base: 2, min: 1.2, max: 2.6 },
      prefReturn: { base: 0.08, min: 0.06, max: 0.10 },
    },
    { threshold: 0.9 },
  );
  // Scope to the TARGET (NOT r.escalate — the MIP kink escalates OTHER outputs).
  const tgt = r.perTarget['returns.grossMOIC'];
  t.eqArr(tgt.selected, ['exitMultiple'], 'exitMultiple is the dominant driver of returns.grossMOIC');
  t.assert(tgt.ranked[0].input === 'exitMultiple', 'ranked[0] is exitMultiple');
  t.assert(tgt.ranked[0].varianceExplained > 0.99, 'exitMultiple varianceExplained > 0.99');
  // CLEAN half (rule 5): grossMOIC is linear -> its OWN escalation is false even
  // though the top-level r.escalate is true (from the kinked waterfall/mip outputs).
  t.assert(tgt.escalateTier2 === false, 'returns.grossMOIC own escalateTier2 is false (clean linear)');
  t.assert(tgt.breakpoint === false, 'returns.grossMOIC has no breakpoint');

  // KINKED half (rule 5 — load-bearing): the SAME committed fixture's MIP@1.5x +
  // simple-interest pref kink MUST escalate the waterfall/mip outputs. A regression
  // that silenced the output-level kink gate would leave grossMOIC clean (above) yet
  // ALSO drop these — so assert BOTH halves on the one selectDrivers run.
  t.assert(r.escalate === true, 'top-level escalate fires (MIP/pref kink present in fixture)');
  const mip = r.perTarget['mip.payment'];
  t.assert(mip && mip.escalateTier2 === true, 'kinked mip.payment escalates (rule 5 positive half)');
  t.assert(mip.breakpoint === true, 'mip.payment kink detected by the output-level gate');
  const carry = r.perTarget['waterfall.gpCarry'];
  t.assert(carry && carry.breakpoint === true, 'waterfall.gpCarry kink detected');
  t.assert(carry.escalateTier2 === true, 'kinked waterfall.gpCarry escalates (rule 5)');
}

// ═════════════════════════════════════════════════════════════════════════════
// directEvaluator — NEGATIVE CONTROL #2: flat (ungrouped) result rejected
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing directEvaluator negative control (flat result rejected)');
{
  t.throws(
    () => directEvaluator(() => ({ totalCarry: 5 }))({}),
    /no known output group|grouped/,
    'a FLAT (ungrouped) computeFn result is rejected (would yield zero keys)',
  );
  t.throws(() => directEvaluator('notafn'), /function/, 'non-function computeFn rejected (TypeError)');
}

// ═════════════════════════════════════════════════════════════════════════════
// engineRunEvaluator — STUB run() reshaping (deterministic, fixture-free)
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing engineRunEvaluator reshaping over a deterministic stub run()');
{
  // Deterministic fake engine — NO clock/random. 'Val!EM' override flows to MOIC2.
  const run = (ov) => ({
    'Eq!MOIC': 2.0 + (ov['Val!EM'] ?? 0) * 0,
    'Eq!MOIC2': ov['Val!EM'] ?? 2.0,
    'GP!Carry': 14000000,
    'MIP!Flag': true,
    'Val!TV': 1.0915e9,
  });
  const outputsSpec = [
    { cell: 'Eq!MOIC2', group: 'returns', leaf: 'grossMOIC', class: 'ratio' },
    { cell: 'GP!Carry', group: 'waterfall', leaf: 'totalCarry', class: 'monetary' },
    { cell: 'MIP!Flag', group: 'mip', leaf: 'triggered', class: 'flag' },
    { cell: 'Val!TV', group: 'exitValuation', leaf: 'terminalValue' },
    { cell: 'NoSuch!X', group: 'returns', leaf: 'netMOIC' }, // missing cell -> omitted
  ];
  const evalE = engineRunEvaluator({ run, outputsSpec, inputMap: { exitMultiple: 'Val!EM' } });
  const o = evalE({ exitMultiple: 2.5 });

  // Presence guards so a "writes to spec.group key instead of spec.leaf" mutation
  // reports a labeled FAIL naming the dropped group, not a raw TypeError.
  t.assert(o.returns && 'grossMOIC' in o.returns, 'returns.grossMOIC present');
  t.assert(o.waterfall && 'totalCarry' in o.waterfall, 'waterfall.totalCarry present');
  t.assert(o.mip && 'triggered' in o.mip, 'mip.triggered present');
  t.assert(o.exitValuation && 'terminalValue' in o.exitValuation, 'exitValuation.terminalValue present');

  // NON-CIRCULAR truth: computed by hand from the stub map, not from the adapter.
  t.near(o.returns.grossMOIC, 2.5, 1e-12, 'exitMultiple override flows through Val!EM to grossMOIC');
  t.eq(o.waterfall.totalCarry, 14000000, 'GP!Carry -> waterfall.totalCarry');
  t.eq(o.mip.triggered, true, 'MIP!Flag boolean -> mip.triggered');
  t.near(o.exitValuation.terminalValue, 1.0915e9, 1, 'Val!TV -> exitValuation.terminalValue');

  // MISSING-CELL omission: the spec leaf for an absent cell is not set.
  t.assert(!('netMOIC' in o.returns), 'missing engine cell -> leaf omitted (not undefined-set)');

  // Shape survives flattenOutputs.
  const fo = flattenOutputs(o);
  for (const key of ['returns.grossMOIC', 'waterfall.totalCarry', 'mip.triggered', 'exitValuation.terminalValue']) {
    t.assert(key in fo, `flattenOutputs sees ${key}`);
  }
  t.assert(!('returns.netMOIC' in fo), 'flattenOutputs emits no dead returns.netMOIC key');
}

// ═════════════════════════════════════════════════════════════════════════════
// engineRunEvaluator — NEGATIVE CONTROL #3: bad run / empty spec
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing engineRunEvaluator negative control (bad run / empty spec / bad return)');
{
  // ISOLATE the run-type guard: pass a VALID non-empty outputsSpec so the only thing
  // that can make this throw is the null run check (the previous combined
  // {run:null,outputsSpec:[]} let the empty-spec check satisfy the regex and let a
  // removed run guard survive — see M19). Regex pins the RUN message specifically.
  const validSpec = [{ cell: 'A', group: 'returns', leaf: 'grossMOIC' }];
  t.throws(() => engineRunEvaluator({ run: null, outputsSpec: validSpec }), /run must be a function/,
    'null run rejected (valid spec isolates the run-type guard)');
  t.throws(() => engineRunEvaluator({ run: 42, outputsSpec: validSpec }), /run must be a function/,
    'non-function run rejected (valid spec)');
  // ISOLATE the spec guard: pass a VALID run.
  t.throws(() => engineRunEvaluator({ run: () => ({}), outputsSpec: [] }), /outputsSpec/, 'empty outputsSpec rejected (valid run)');
  t.throws(() => engineRunEvaluator({ run: () => ({}), outputsSpec: 'nope' }), /outputsSpec/, 'non-array outputsSpec rejected');

  // RUN RETURN-TYPE guard: a half-wired engine returning a scalar (truthy 42) must
  // NOT be silently treated as "all cells missing" -> empty result. It throws lazily
  // at call time (construction can't see the return). null is the sanctioned sentinel.
  const evalScalarRun = engineRunEvaluator({ run: () => 42, outputsSpec: validSpec });
  t.throws(() => evalScalarRun({}), /run\(\) must return|cellRef.*object|object/,
    'run() returning a scalar throws (not a phantom-empty sample)');
  // null/undefined return IS allowed (means "no cells") -> empty grouped result, no throw.
  const evalNullRun = engineRunEvaluator({ run: () => null, outputsSpec: validSpec });
  t.eq(Object.keys(evalNullRun({})).length, 0, 'run()->null yields an empty grouped result (no throw)');
}

// ═════════════════════════════════════════════════════════════════════════════
// workbookVariantEvaluator — NEGATIVE CONTROL #4: documented stub throws
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing workbookVariantEvaluator stub (not-implemented)');
{
  t.throws(
    () => workbookVariantEvaluator({}),
    /not implemented.*Phase 3 follow-on/i,
    'documented stub throws a clear not-implemented error',
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// MUTATION GUARD #1 — cascade base-case fidelity catches a broken mapping
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing mutation guard #1 (corrupt cascade mapping is caught)');
t.mutationGuard('cascade grossMOIC mapping', () => {
  // Corrupt a CLONE: point returns.grossMOIC at the WRONG source key (netMOIC).
  const badMapping = clone(DEFAULT_CASCADE_MAPPING);
  badMapping.returns.grossMOIC = 'netMOIC';
  const bad = cascadeEvaluator(manifest, gt, { mapping: badMapping });
  const got = bad({}).returns.grossMOIC;
  const truth = computeScenario(manifest, gt, {}).base.grossMOIC;
  // The broken mapping makes grossMOIC != truth -> a real equality test WOULD catch it.
  return Math.abs(got - truth) > 1e-6;
});

// ═════════════════════════════════════════════════════════════════════════════
// MUTATION GUARD #2 — directEvaluator group-validation catches an ungrouped break
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing mutation guard #2 (ungrouped result is rejected)');
t.mutationGuard('grouped-shape validation', () => {
  let threw = false;
  try {
    directEvaluator(() => ({ grossMOIC: 2.0 }))({}); // flat, not nested under a group
  } catch {
    threw = true;
  }
  return threw; // PASSES only because the adapter rejects the flat shape
});

// ═════════════════════════════════════════════════════════════════════════════
// MUTATION GUARD #3 — cascade non-finite guard is load-bearing
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing mutation guard #3 (non-finite driver value is caught)');
t.mutationGuard('cascade non-finite input guard', () => {
  // PROBE: if the guard were removed, NaN would silently fall back to base case.
  // Prove the adapter REJECTS it (throws) AND that the base case it would otherwise
  // return is indeed degenerate (== {}), so a removed guard would be a silent no-op.
  const evalC = cascadeEvaluator(manifest, gt);
  let threw = false;
  try { evalC({ exitMultiple: NaN }); } catch { threw = true; }
  // The silent-fallback value the guard prevents: identical to the no-input base.
  const baseMOIC = computeScenario(manifest, gt, {}).base.grossMOIC;
  const fallbackMOIC = computeScenario(manifest, gt, { exitMultiple: NaN }).scenario.grossMOIC;
  const wouldBeSilent = Math.abs(fallbackMOIC - baseMOIC) < 1e-9;
  return threw && wouldBeSilent; // guard fired AND the masked hazard is real
});

// ═════════════════════════════════════════════════════════════════════════════
// MUTATION GUARD #4 — engineRunEvaluator run-return-type guard is load-bearing
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing mutation guard #4 (scalar run() return is caught)');
t.mutationGuard('engineRun run-return-type guard', () => {
  // PROBE: a scalar run() return (truthy 42) WOULD reshape to an empty grouped
  // result if the guard were dropped (42['cell'] === undefined -> every leaf omitted),
  // an indistinguishable phantom-empty sample. Prove the adapter THROWS instead.
  const validSpec = [{ cell: 'A', group: 'returns', leaf: 'grossMOIC' }];
  const evalScalar = engineRunEvaluator({ run: () => 42, outputsSpec: validSpec });
  let threw = false;
  try { evalScalar({}); } catch { threw = true; }
  return threw; // PASSES only because the adapter rejects the scalar return
});

t.done();

#!/usr/bin/env node
/**
 * Tests for lib/lite-surrogate.mjs — ADR-027 Tier-1 surrogate emitter + honesty gate.
 *
 * This is the MOST safety-critical lite phase: a wrong surrogate misprices PE
 * money, so the honesty gate (kink → escalate; below-floor → escalate, except a
 * by-request embedded-surrogate carve-out) and the refuse-on-mismatch provenance
 * loader are the primary deliverables. Follows docs/LITE-TEST-STANDARD.md:
 * non-circular truth, ≥1 negative control, ≥1 mutation guard, committed fixtures,
 * no network/clock/PRNG in assertions.
 *
 * Coverage:
 *  • CLEAN FIT (non-circular): returns.grossMOIC over the committed kinked PE model
 *    fits an EXACT multiplicative surrogate. The expected beta (=1) and r2 (=1) are
 *    derived by an INDEPENDENT hand fit in the test, never read back from the emitter.
 *    run() reproduces the base case and tracks the evaluator within maxResidual.
 *  • MULTI-DRIVER (off-axis honesty): a 2-driver additive output ships with
 *    offAxisUnverified===true + driverCount===2; an off-axis joint query is wrong
 *    (the on-axis r2 is NOT joint-surface fidelity) — asserted explicitly.
 *  • KINKED ESCALATES (negative control): waterfall.gpCarry's exitMultiple sweep
 *    crosses the MIP/pref kink → breakpoint → escalateTier2, NO coeffs, run() returns
 *    {escalated:true} not a number. The escalation REASON isolates the kink branch.
 *  • BY-REQUEST CARVE-OUT (5 cases) on a synthetic CURVED-but-monotone monetary output;
 *    multiplicative-pinned AND auto-mode escalation paths covered.
 *  • PROVENANCE REFUSAL (negative control): self-contained AND model-identity modes
 *    refuse a tampered artifact — including a forced-ship in model-identity mode, a
 *    tampered coeff/base value, an r2 lie, and a stripped BY-REQUEST disclosure.
 *  • MUTATION GUARDS (≥6): force-ship a kinked output (self-contained AND model-identity),
 *    drop a shipped r2 below floor w/o disclosure (loader THROWS), tamper a coeff value,
 *    drift base.outputs, corrupt a stamped hash.
 *
 * Usage: node tests/lib/test-lite-surrogate.mjs
 *
 * @license MIT
 */

import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { makeHarness, clone } from './_lite-harness.mjs';
import {
  emitSurrogate, loadSurrogate, buildSurrogateRun,
} from '../../lib/lite-surrogate.mjs';
import { computeModel } from '../../tests/synthetic-pe-model/engine.js';
import { directEvaluator } from '../../lib/lite-evaluators.mjs';
import { structuralRefs } from '../../lib/lite-tier0.mjs';

const t = makeHarness('lib/lite-surrogate.mjs');

const MOIC_FLOOR = 0.97;     // R2_FLOORS.moic
const MONETARY_FLOOR = 0.99; // R2_FLOORS.monetary / carry

// The committed kinked PE model. The grid {2.0 / 1.0..2.5 / 9 steps} crosses the
// MIP threshold (1.5×) and the pref hurdle, so returns.grossMOIC is CLEAN
// (bp=false, exact) while waterfall.gpCarry KINKS (bp=true) — empirically confirmed.
const ev = directEvaluator(computeModel);
const candidate = { exitMultiple: { base: 2.0, min: 1.0, max: 2.5, steps: 9 } };
const BASE_X = 2.0;

// Synthetic CURVED-but-monotone monetary evaluator (below the 0.99 floor
// multiplicatively, NO kink). The committed fixture is piecewise-linear above its
// kink and cannot produce a below-floor-WITHOUT-kink monetary output, so a synthetic
// in-memory evaluator is the documented pattern for the carve-out cases.
const curved = (inp) => { const x = inp.x ?? 1; return { waterfall: { totalCarry: 1000 * x + 300 * x * x } }; };
const curvedCand = { x: { base: 1, min: 0, max: 2, steps: 9 } };

// ── INDEPENDENT hand fit of the CLEAN driver (NON-CIRCULAR truth) ─────────────
// Sample the evaluator directly across the same grid and hand-fit the single
// multiplicative beta + r2 + maxResidual. These are the expected values the
// emitter must reproduce; they are NEVER read back from emitSurrogate.
function linspace(min, max, steps) {
  if (steps <= 1) return [min];
  const out = [];
  for (let i = 0; i < steps; i++) out.push(min + (max - min) * (i / (steps - 1)));
  return out;
}
function handFitMultiplicative(evaluator, outputKey, driver, baseX, grid) {
  const base = readOut(evaluator({ [driver]: baseX }), outputKey);
  const sweep = grid.map((x) => ({ x, y: readOut(evaluator({ [driver]: x }), outputKey) }));
  let num = 0, den = 0;
  for (const { x, y } of sweep) {
    const d = (x - baseX) / baseX;
    const bd = base * d;
    num += (y - base) * bd;
    den += bd * bd;
  }
  const beta = den === 0 ? 0 : num / den;
  let ssr = 0, sst = 0, maxRes = 0;
  const mean = sweep.reduce((a, p) => a + p.y, 0) / sweep.length;
  for (const { x, y } of sweep) {
    const d = (x - baseX) / baseX;
    const yhat = base * (1 + beta * d);
    const r = Math.abs(y - yhat);
    if (r > maxRes) maxRes = r;
    ssr += (y - yhat) ** 2;
    sst += (y - mean) ** 2;
  }
  const r2 = sst <= 1e-12 ? 0 : 1 - ssr / sst;
  return { base, beta, r2, maxRes };
}
function readOut(grouped, dotKey) {
  const [g, leaf] = dotKey.split('.');
  return grouped[g][leaf];
}

/** Emit a curved monetary surrogate into a fresh tmp dir; returns {tmp, r}. Caller cleans up. */
function emitCurvedTmp(extra = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'surr-'));
  const r = emitSurrogate(curved, curvedCand, {
    outputClasses: { 'waterfall.totalCarry': 'monetary' },
    useCase: 'embedded-surrogate', fitForm: 'multiplicative',
    write: true, outDir: tmp, ...extra,
  });
  return { tmp, r };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) CLEAN FIT — returns.grossMOIC fits exactly; matches an independent hand fit.
// ─────────────────────────────────────────────────────────────────────────────
t.section('clean fit (returns.grossMOIC)');
{
  const grid = linspace(1.0, 2.5, 9);
  const hand = handFitMultiplicative(ev, 'returns.grossMOIC', 'exitMultiple', BASE_X, grid);
  // sanity: the committed fixture really is the exact-linear MOIC=exitMultiple line
  t.near(hand.beta, 1, 1e-9, 'hand-fit grossMOIC beta == 1 (independent truth)');
  t.near(hand.r2, 1, 1e-9, 'hand-fit grossMOIC r2 == 1 (independent truth)');
  t.near(hand.maxRes, 0, 1e-9, 'hand-fit grossMOIC maxResidual == 0 (independent truth)');

  const r = emitSurrogate(ev, candidate, {
    outputClasses: { 'returns.grossMOIC': 'moic' },
    targetOutputKeys: ['returns.grossMOIC'],
    useCase: 'one-off',
  });
  const tgt = r.perTarget['returns.grossMOIC'];

  t.assert(!tgt.escalateTier2, 'clean grossMOIC does NOT escalate');
  t.assert(tgt.rSquared >= MOIC_FLOOR, `clean grossMOIC fitted r2 (${tgt.rSquared}) >= moic floor ${MOIC_FLOOR}`);
  // the emitter's coeff MATCHES the independent hand fit (not read back from the gate)
  t.near(tgt.coeffs.betas.exitMultiple, hand.beta, 1e-9, 'emitted beta matches the independent hand fit (==1)');
  t.near(tgt.rSquared, hand.r2, 1e-9, 'emitted r2 matches the independent hand fit (==1)');
  t.near(tgt.maxResidual, hand.maxRes, 1e-9, 'emitted maxResidual matches the independent hand fit (==0)');
  t.assert(tgt.fitForm === 'multiplicative', 'clean output ships the multiplicative form');
  t.assert(tgt.offAxisUnverified === false, 'single-driver clean output is NOT offAxisUnverified');
  t.assert(tgt.driverCount === 1, 'single-driver clean output reports driverCount===1');
  t.assert(r.escalated.length === 0, 'escalated[] empty for the clean-only emit');

  // loadSurrogate.run() reproduces base case + tracks the evaluator within maxResidual.
  const run = buildSurrogateRun(r.params);
  const baseRun = run({});
  t.near(baseRun['returns.grossMOIC'], 2.0, Math.max(tgt.maxResidual, 1e-9), 'run({}) reproduces the base case (~2.0)');
  for (const x of [1.25, 1.9375, 2.3125]) { // ≥3 swept points
    const got = run({ exitMultiple: x })['returns.grossMOIC'];
    const want = ev({ exitMultiple: x }).returns.grossMOIC;
    t.near(got, want, Math.max(tgt.maxResidual, 1e-9), `run({exitMultiple:${x}}) tracks the evaluator within maxResidual`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1b) MULTI-DRIVER off-axis honesty. A 2-driver additive output (out = a + b)
//     ships clean on-axis (each axis is exactly multiplicative-fittable) but the
//     multiplicative form has no interaction term, so a JOINT move is wrong. The
//     stamped r2 must NOT be read as joint fidelity — assert the per-target flag
//     AND that an off-axis query genuinely diverges (independent truth: a+b).
// ─────────────────────────────────────────────────────────────────────────────
t.section('multi-driver off-axis honesty');
{
  const additive = (inp) => { const a = inp.a ?? 1; const b = inp.b ?? 1; return { waterfall: { totalCarry: a + b } }; };
  const cand = { a: { base: 1, min: 0.5, max: 1.5, steps: 7 }, b: { base: 1, min: 0.5, max: 1.5, steps: 7 } };
  const r = emitSurrogate(additive, cand, {
    outputClasses: { 'waterfall.totalCarry': 'monetary' },
    targetOutputKeys: ['waterfall.totalCarry'],
    useCase: 'embedded-surrogate', fitForm: 'multiplicative',
  });
  const tgt = r.perTarget['waterfall.totalCarry'];
  if (!tgt.escalateTier2) {
    t.assert(tgt.driverCount === 2, 'multi-driver output reports driverCount===2');
    t.assert(tgt.offAxisUnverified === true, 'multi-driver shipped output is flagged offAxisUnverified');
    t.assert(typeof tgt.offAxisNote === 'string' && tgt.offAxisNote.length > 0, 'multi-driver output carries an off-axis note');
    // Independent truth: at base a=b=1, out=2. A joint move a=1.5,b=1.5 → 3.0 exactly,
    // but the multiplicative surrogate (no interaction) is provably off. We assert
    // the surrogate does NOT secretly nail the joint point (which would falsely imply
    // joint fidelity); the on-axis r2 is therefore not a joint-surface claim.
    const run = buildSurrogateRun(r.params);
    const joint = run({ a: 1.5, b: 1.5 })['waterfall.totalCarry'];
    const truth = additive({ a: 1.5, b: 1.5 }).waterfall.totalCarry; // 3.0
    t.assert(Math.abs(joint - truth) > 1e-6, `off-axis joint query diverges from truth (got ${joint}, truth ${truth}) — on-axis r2 is NOT joint fidelity`);
  } else {
    // If the implementation chooses to escalate multi-driver monetary, that is also honest.
    t.assert(tgt.coeffs == null, 'a multi-driver output that escalates ships NO coeffs');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) KINKED ESCALATES — waterfall.gpCarry (NEGATIVE CONTROL).
// ─────────────────────────────────────────────────────────────────────────────
t.section('kinked output escalates (negative control)');
let kinkEmit;
{
  kinkEmit = emitSurrogate(ev, candidate, {
    outputClasses: { 'returns.grossMOIC': 'moic', 'waterfall.gpCarry': 'carry' },
    targetOutputKeys: ['returns.grossMOIC', 'waterfall.gpCarry'],
    useCase: 'one-off',
  });
  const gp = kinkEmit.perTarget['waterfall.gpCarry'];
  t.assert(gp.breakpoint === true, 'gpCarry actually reports breakpoint===true (kink signal is live)');
  t.assert(gp.escalateTier2 === true, 'kinked gpCarry escalateTier2 === true');
  t.assert(gp.recommendedTier === 2, 'kinked gpCarry recommendedTier === 2');
  t.assert(gp.coeffs == null, 'kinked gpCarry ships NO coeffs (rule 5)');
  t.assert(gp.fitForm == null, 'kinked gpCarry has no fitForm');
  // ISOLATE the kink branch: the reason must name the kink (a floor-only escalation
  // would NOT match), so a build with the kink gate removed could not satisfy this.
  t.assert(/breakpoint|kink/i.test(gp.reason || ''), 'kinked gpCarry escalation reason names the kink (isolates the kink branch)');
  t.assert(kinkEmit.escalated.includes('waterfall.gpCarry'), 'escalated[] includes waterfall.gpCarry');

  // run() must NOT surface a fabricated number for the escalated output.
  const run = buildSurrogateRun(kinkEmit.params);
  const res = run({ exitMultiple: 2.3 });
  const v = res['waterfall.gpCarry'];
  t.assert(v != null && typeof v === 'object' && v.escalated === true, 'run() returns {escalated:true} for the kinked output, never a number');
  t.assert(typeof v.recommendedTier === 'number', 'escalated run() result carries recommendedTier');
  // the clean output is still present and numeric in the same run.
  t.assert(typeof res['returns.grossMOIC'] === 'number', 'the clean output is still numeric in a mixed run()');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) BY-REQUEST CARVE-OUT (5 cases). multiplicative-pinned + auto-mode paths.
// ─────────────────────────────────────────────────────────────────────────────
t.section('by-request carve-out (5 cases)');
{
  // Independent truth: multiplicative r2 is below 0.99 (hand-verified ~0.9744),
  // and there is NO kink → so the gate decision is purely the floor + carve-out.
  const hand = handFitMultiplicative(curved, 'waterfall.totalCarry', 'x', 1, linspace(0, 2, 9));
  t.assert(hand.r2 < MONETARY_FLOOR, `independent: curved monetary mult r2 (${hand.r2.toFixed(4)}) < monetary floor ${MONETARY_FLOOR}`);

  // (1) embedded-surrogate + class-aware monetary → SHIPS with a BY-REQUEST disclosure.
  const emb = emitSurrogate(curved, curvedCand, {
    outputClasses: { 'waterfall.totalCarry': 'monetary' },
    useCase: 'embedded-surrogate', fitForm: 'multiplicative',
  });
  const e1 = emb.perTarget['waterfall.totalCarry'];
  t.assert(!e1.escalateTier2, '(1) embedded-surrogate below-floor monetary SHIPS (carve-out)');
  t.assert(e1.coeffs != null, '(1) the by-request shipped output carries coeffs');
  t.assert(/BY-REQUEST SURROGATE BELOW FLOOR/.test(e1.disclosure || ''), '(1) ships a BY-REQUEST disclosure string');
  t.near(e1.rSquared, hand.r2, 1e-9, '(1) fitted r2 matches the independent hand fit (~0.9744)');

  // (2) SAME below-floor output, useCase dashboard → ESCALATES (no carve-out).
  const dash = emitSurrogate(curved, curvedCand, {
    outputClasses: { 'waterfall.totalCarry': 'monetary' },
    useCase: 'dashboard', fitForm: 'multiplicative',
  });
  const e2 = dash.perTarget['waterfall.totalCarry'];
  t.assert(e2.escalateTier2 === true, '(2) dashboard below-floor monetary ESCALATES');
  t.assert(e2.coeffs == null, '(2) escalated output ships NO coeffs');
  // the escalation records HOW far below floor it landed (honesty signal, not dropped).
  t.near(e2.measuredRSquared, hand.r2, 1e-9, '(2) below-floor escalation keeps the measured r2 (~0.9744)');
  t.assert(typeof e2.measuredMaxResidual === 'number', '(2) below-floor escalation keeps the measured maxResidual');
  t.assert(dash.escalated.includes('waterfall.totalCarry'), '(2) escalated[] includes the below-floor output');

  // (3) a KINKED output with embedded-surrogate → STILL escalates (kink overrides).
  const kinkEmb = emitSurrogate(ev, candidate, {
    outputClasses: { 'waterfall.gpCarry': 'carry' },
    targetOutputKeys: ['waterfall.gpCarry'],
    useCase: 'embedded-surrogate',
    fitForm: 'multiplicative',
  });
  const e3 = kinkEmb.perTarget['waterfall.gpCarry'];
  t.assert(e3.breakpoint === true, '(3) the gpCarry sweep is kinked (breakpoint===true)');
  t.assert(e3.escalateTier2 === true, '(3) kinked output with embedded-surrogate STILL escalates (kink overrides the carve-out)');
  t.assert(e3.coeffs == null, '(3) kink-escalated output ships NO coeffs even by-request');
  t.assert(!e3.disclosure, '(3) a kink-escalated output gets NO by-request disclosure (it was not shipped)');

  // (4) AUTO-MODE below-floor: a genuinely curved monetary where poly does NOT rescue.
  //     exp-curved (e^{4x}) over a wide range is below floor for BOTH the multiplicative
  //     fit AND a 2-term poly (independently verified ~0.94), so auto-mode must escalate
  //     under one-off and ship-with-disclosure under embedded (the carve-out path). A
  //     gentler curve (e^{2x}) lets the poly rescue it above 0.99 — which is correct/honest,
  //     just not the below-floor branch this case is exercising.
  const expCurved = (inp) => { const x = inp.x ?? 1; return { waterfall: { totalCarry: Math.exp(4 * x) } }; };
  const handMul = handFitMultiplicative(expCurved, 'waterfall.totalCarry', 'x', 1, linspace(0.3, 1.7, 13));
  t.assert(handMul.r2 < MONETARY_FLOOR, `(4) independent: exp-curved mult r2 (${handMul.r2.toFixed(4)}) < ${MONETARY_FLOOR}`);
  const expCand = { x: { base: 1, min: 0.3, max: 1.7, steps: 13 } };
  const auto1 = emitSurrogate(expCurved, expCand, {
    outputClasses: { 'waterfall.totalCarry': 'monetary' }, useCase: 'one-off', fitForm: 'auto',
  });
  const a1 = auto1.perTarget['waterfall.totalCarry'];
  t.assert(a1.escalateTier2 === true, '(4) auto-mode below-floor monetary under one-off ESCALATES (poly did not rescue)');
  t.assert(typeof a1.measuredRSquared === 'number' && a1.measuredRSquared < MONETARY_FLOOR, '(4) escalation kept a below-floor measured r2');

  const auto2 = emitSurrogate(expCurved, expCand, {
    outputClasses: { 'waterfall.totalCarry': 'monetary' }, useCase: 'embedded-surrogate', fitForm: 'auto',
  });
  const a2 = auto2.perTarget['waterfall.totalCarry'];
  t.assert(!a2.escalateTier2, '(5) auto-mode below-floor monetary under embedded-surrogate SHIPS (carve-out)');
  t.assert(/BY-REQUEST SURROGATE BELOW FLOOR/.test(a2.disclosure || ''), '(5) the auto-mode by-request ship carries a BY-REQUEST disclosure');
  t.assert(a2.rSquared < MONETARY_FLOOR, '(5) the by-request ship really is below floor');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3b) UNDECLARED-CLASS warning — a target scoped with no declared class lands on
//     the loose 'other' floor; the artifact must record the warning so a forgotten
//     monetary class can't silently downgrade the floor unnoticed.
// ─────────────────────────────────────────────────────────────────────────────
t.section('undeclared-class warning');
{
  // curved monetary r2 ~0.9744, which is >= the 'other' floor 0.95 → would ship
  // CLEAN under the loose floor. The artifact must flag the missing class.
  const r = emitSurrogate(curved, curvedCand, {
    targetOutputKeys: ['waterfall.totalCarry'], // class deliberately NOT declared
    useCase: 'one-off', fitForm: 'multiplicative',
  });
  const prov = r.params.provenance;
  t.assert(Array.isArray(prov.undeclaredClassTargets) && prov.undeclaredClassTargets.includes('waterfall.totalCarry'),
    'undeclared-class target is recorded in provenance.undeclaredClassTargets');
  t.assert(/undeclared|other/i.test(prov.undeclaredClassWarning || ''), 'a warning string explains the loose-floor risk');
  const tgt = r.perTarget['waterfall.totalCarry'];
  t.assert(Math.abs(tgt.classFloor - 0.95) < 1e-12, 'undeclared target uses the loose 0.95 (other) floor');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) PROVENANCE REFUSAL (NEGATIVE CONTROL) — both modes refuse a tampered artifact,
//    INCLUDING value tampers (coeff/base/r2) and a forced-ship in BOTH modes.
// ─────────────────────────────────────────────────────────────────────────────
t.section('provenance refusal (negative control)');
{
  // --- self-contained mode ---
  const tmp = mkdtempSync(join(tmpdir(), 'surr-sc-'));
  try {
    const r = emitSurrogate(curved, curvedCand, {
      outputClasses: { 'waterfall.totalCarry': 'monetary' },
      useCase: 'embedded-surrogate', fitForm: 'multiplicative',
      write: true, outDir: tmp,
    });
    t.assert(r.params.provenance.mode === 'self-contained', 'self-contained mode stamped when no model files given');
    t.assert(typeof r.params.provenance.gateHash === 'string', 'a signed gateHash is stamped (self-contained)');
    // positive control: untampered loads + returns a function.
    const run = loadSurrogate(r.paramsPath);
    t.assert(typeof run === 'function', 'untampered self-contained artifact loads (positive control)');

    // (a) corrupted fitSignature → throw.
    {
      const p = clone(r.params);
      p.provenance.fitSignature = 'sha256:deadbeef';
      const f = join(tmp, 'a.params.json');
      writeFileSync(f, JSON.stringify(p));
      t.throws(() => loadSurrogate(f), /tampered|stale|mismatch/, '(a) corrupted fitSignature throws');
    }
    // (b) mutated signed inputs (drift the embedded base) → re-digest disagrees → throw.
    {
      const p = clone(r.params);
      const k = Object.keys(p.provenance.fitSignatureInputs.perOutputBase)[0];
      p.provenance.fitSignatureInputs.perOutputBase[k] += 1; // tamper a signed input
      const f = join(tmp, 'b.params.json');
      writeFileSync(f, JSON.stringify(p));
      t.throws(() => loadSurrogate(f), /tampered|mismatch/, '(b) mutated signed fitSignatureInputs throws');
    }
    // (e) TAMPER A SHIPPED COEFF VALUE (beta) — the gateHash signs the float coeff. → throw.
    {
      const p = clone(r.params);
      const k = Object.keys(p.perTarget)[0];
      const d = Object.keys(p.perTarget[k].coeffs.betas)[0];
      p.perTarget[k].coeffs.betas[d] = 999; // poison the money-pricing coeff
      const f = join(tmp, 'e.params.json');
      writeFileSync(f, JSON.stringify(p));
      t.throws(() => loadSurrogate(f), /tampered|mismatch|gateHash/, '(e) tampered coeff VALUE throws (value-signed)');
    }
    // (f) DRIFT run()'s base output value — the gateHash signs base. → throw.
    {
      const p = clone(r.params);
      const k = Object.keys(p.base.outputs)[0];
      p.base.outputs[k] = p.base.outputs[k] + 12345; // drift the base run() consumes
      const f = join(tmp, 'f.params.json');
      writeFileSync(f, JSON.stringify(p));
      t.throws(() => loadSurrogate(f), /tampered|mismatch|gateHash/, '(f) drifted base.outputs value throws (value-signed)');
    }
    // (g) STRIP THE BY-REQUEST DISCLOSURE from a below-floor ship → throw.
    {
      const p = clone(r.params);
      const k = Object.keys(p.perTarget)[0];
      delete p.perTarget[k].disclosure; // remove the honesty contract
      const f = join(tmp, 'g.params.json');
      writeFileSync(f, JSON.stringify(p));
      t.throws(() => loadSurrogate(f), /tampered|mismatch|below floor|disclosure/i, '(g) stripped BY-REQUEST disclosure throws');
    }
    // (h) LIE about a shipped r2 (claim a perfect fit) → gateHash mismatch → throw.
    {
      const p = clone(r.params);
      const k = Object.keys(p.perTarget)[0];
      p.perTarget[k].rSquared = 1.0; // pretend the below-floor fit is perfect
      const f = join(tmp, 'h.params.json');
      writeFileSync(f, JSON.stringify(p));
      t.throws(() => loadSurrogate(f), /tampered|mismatch|gateHash/, '(h) r2 lie throws (rSquared is signed)');
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // --- model-identity mode (graph-free, modelHash == structuralHash) ---
  const tmp2 = mkdtempSync(join(tmpdir(), 'surr-mi-'));
  try {
    const manifest = {
      carry: { totalCell: 'GPP Promote!D180', tiers: [{ hurdleCell: 'GPP Promote!C108', labelCell: 'GPP Promote!F109' }] },
      equity: { classes: [{ basisCell: 'GPP Promote!E27' }] },
    };
    // sanity: structuralRefs is non-empty (the field the loader re-digests).
    t.assert(structuralRefs(manifest).length === 4, 'manifest yields 4 structural refs (the verifiable field)');
    writeFileSync(join(tmp2, 'manifest.json'), JSON.stringify(manifest));
    // A two-target model-identity emit so we have BOTH a clean shipped output AND a
    // kinked escalated output to force-ship in this mode.
    const evMi = (inp) => {
      const x = inp.exitMultiple ?? 2;
      // grossMOIC linear/clean; gpCarry kinks at the 1.5x MIP threshold.
      const gp = x < 1.5 ? 0 : 100 * (x - 1.5);
      return { returns: { grossMOIC: x }, waterfall: { gpCarry: gp } };
    };
    const r = emitSurrogate(evMi, candidate, {
      outputClasses: { 'returns.grossMOIC': 'moic', 'waterfall.gpCarry': 'carry' },
      targetOutputKeys: ['returns.grossMOIC', 'waterfall.gpCarry'],
      useCase: 'one-off', manifest, chunkedDir: tmp2, outDir: tmp2, write: true,
    });
    t.assert(r.params.provenance.mode === 'model-identity', 'model-identity mode stamped when manifest given');
    t.assert(r.params.provenance.modelHash === r.params.provenance.structuralHash, 'graph-free emit: modelHash == structuralHash');
    t.assert(typeof r.params.provenance.gateHash === 'string', 'a signed gateHash is stamped (model-identity)');
    t.assert(r.perTarget['waterfall.gpCarry'].escalateTier2 === true, 'model-identity gpCarry actually escalates (kink)');
    const run = loadSurrogate(r.paramsPath);
    t.assert(typeof run === 'function', 'untampered model-identity artifact loads (positive control)');

    // (c) corrupted structuralHash → throw.
    {
      const p = clone(r.params);
      p.provenance.structuralHash = 'sha256:dead';
      const f = join(tmp2, 'c.params.json');
      writeFileSync(f, JSON.stringify(p));
      t.throws(() => loadSurrogate(f), /tampered|mismatch/, '(c) corrupted structuralHash throws');
    }
    // (d) tampered embedded structuralRefs → self-hash mismatch → throw.
    {
      const p = clone(r.params);
      p.provenance.structuralRefs = [...p.provenance.structuralRefs, 'GPP Promote!ZZ999'];
      const f = join(tmp2, 'd.params.json');
      writeFileSync(f, JSON.stringify(p));
      t.throws(() => loadSurrogate(f), /tampered|mismatch/, '(d) tampered embedded structuralRefs throws');
    }
    // (i) FORCE-SHIP THE KINKED OUTPUT IN MODEL-IDENTITY MODE → gateHash mismatch → throw.
    //     This is the critical gate hole the review found: the gateHash is signed in
    //     BOTH modes now, so the loader refuses the forced-ship regardless of mode.
    {
      const p = clone(r.params);
      p.perTarget['waterfall.gpCarry'].escalateTier2 = false;
      p.perTarget['waterfall.gpCarry'].fitForm = 'multiplicative';
      p.perTarget['waterfall.gpCarry'].coeffs = { betas: { exitMultiple: 1 } };
      p.perTarget['waterfall.gpCarry'].rSquared = 1.0;
      p.perTarget['waterfall.gpCarry'].classFloor = 0.99;
      p.base.baseX['waterfall.gpCarry'] = { exitMultiple: 2.0 };
      p.base.outputs['waterfall.gpCarry'] = 50;
      const f = join(tmp2, 'i.params.json');
      writeFileSync(f, JSON.stringify(p));
      t.throws(() => loadSurrogate(f), /tampered|mismatch|gateHash|escalated/i, '(i) MODEL-IDENTITY forced-ship of a kinked output throws (gate hole closed)');
    }
  } finally {
    rmSync(tmp2, { recursive: true, force: true });
  }

  // --- (j) provenance isolation: corrupt structuralHash in a MANIFEST-FREE dir so
  //     ONLY the self-integrity re-digest can fire (no live-manifest fallback). ---
  const tmp3 = mkdtempSync(join(tmpdir(), 'surr-iso-'));
  try {
    const manifest = {
      carry: { totalCell: 'GPP Promote!D180', tiers: [{ hurdleCell: 'GPP Promote!C108', labelCell: 'GPP Promote!F109' }] },
      equity: { classes: [{ basisCell: 'GPP Promote!E27' }] },
    };
    const evMo = (inp) => ({ returns: { grossMOIC: inp.exitMultiple ?? 2 } });
    // pass manifest via opts (NOT co-located) so the artifact is model-identity but
    // ships into a dir with NO manifest.json → only the self-integrity guard applies.
    const r = emitSurrogate(evMo, candidate, {
      outputClasses: { 'returns.grossMOIC': 'moic' },
      useCase: 'one-off', manifest, outDir: tmp3, write: true,
    });
    t.assert(r.params.provenance.mode === 'model-identity', '(j) model-identity stamped from opts.manifest');
    const p = clone(r.params);
    p.provenance.structuralRefs = [...p.provenance.structuralRefs, 'GPP Promote!ZZ999'];
    const f = join(tmp3, 'j.params.json');
    writeFileSync(f, JSON.stringify(p));
    // No co-located manifest → the live-model fallback cannot fire; the throw can
    // ONLY come from the self-integrity re-digest of structuralRefs.
    t.throws(() => loadSurrogate(f), /tampered/, '(j) manifest-free dir: self-integrity re-digest alone catches the tamper');
  } finally {
    rmSync(tmp3, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) MUTATION GUARDS (≥6) — clone, break, FEED THROUGH THE LOADER, prove it CATCHES.
// ─────────────────────────────────────────────────────────────────────────────
t.section('mutation guards');
{
  // Guard 1: force a kinked output's gate flag off + inject coeffs so a NAIVE
  // loader would WRONGLY ship a number for it — the signed gateHash + coeffsSpec
  // cross-check must catch the disagreement. Self-contained artifact.
  t.mutationGuard('kinked output forced-shipped is caught by the signed gate (self-contained)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'surr-g1-'));
    try {
      const r = emitSurrogate(ev, candidate, {
        outputClasses: { 'waterfall.gpCarry': 'carry' },
        targetOutputKeys: ['waterfall.gpCarry'],
        useCase: 'one-off', write: true, outDir: tmp,
      });
      const p = clone(r.params);
      p.perTarget['waterfall.gpCarry'].escalateTier2 = false;
      p.perTarget['waterfall.gpCarry'].fitForm = 'multiplicative';
      p.perTarget['waterfall.gpCarry'].coeffs = { betas: { exitMultiple: 1 } };
      p.perTarget['waterfall.gpCarry'].rSquared = 1.0;
      p.perTarget['waterfall.gpCarry'].classFloor = 0.99;
      p.base.baseX['waterfall.gpCarry'] = { exitMultiple: 2.0 };
      const f = join(tmp, 'broken.params.json');
      writeFileSync(f, JSON.stringify(p));
      let caught = false;
      try { loadSurrogate(f); } catch (e) { caught = /tampered|gateHash|escalated|mismatch/i.test(e.message); }
      return caught;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Guard 1b: the SAME force-ship in MODEL-IDENTITY mode must also be caught (the
  // critical hole the review found — the gateHash is mode-independent now).
  t.mutationGuard('kinked output forced-shipped is caught by the signed gate (MODEL-IDENTITY)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'surr-g1b-'));
    try {
      const manifest = {
        carry: { totalCell: 'GPP Promote!D180', tiers: [{ hurdleCell: 'GPP Promote!C108', labelCell: 'GPP Promote!F109' }] },
        equity: { classes: [{ basisCell: 'GPP Promote!E27' }] },
      };
      writeFileSync(join(tmp, 'manifest.json'), JSON.stringify(manifest));
      const r = emitSurrogate(ev, candidate, {
        outputClasses: { 'waterfall.gpCarry': 'carry' },
        targetOutputKeys: ['waterfall.gpCarry'],
        useCase: 'one-off', manifest, chunkedDir: tmp, outDir: tmp, write: true,
      });
      const p = clone(r.params);
      p.perTarget['waterfall.gpCarry'].escalateTier2 = false;
      p.perTarget['waterfall.gpCarry'].fitForm = 'multiplicative';
      p.perTarget['waterfall.gpCarry'].coeffs = { betas: { exitMultiple: 1 } };
      p.perTarget['waterfall.gpCarry'].rSquared = 1.0;
      p.perTarget['waterfall.gpCarry'].classFloor = 0.99;
      p.base.baseX['waterfall.gpCarry'] = { exitMultiple: 2.0 };
      p.base.outputs['waterfall.gpCarry'] = 50;
      const f = join(tmp, 'broken.params.json');
      writeFileSync(f, JSON.stringify(p));
      let caught = false;
      try {
        const run = loadSurrogate(f);
        // If the loader WRONGLY accepted it, run() would fabricate a number — that is the failure.
        run({ exitMultiple: 2.4 });
      } catch (e) { caught = /tampered|gateHash|escalated|mismatch/i.test(e.message); }
      return caught;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Guard 2: lower a SHIPPED clean output's stamped r2 below floor AND remove its
  // disclosure, write it, and FEED IT TO loadSurrogate — the loader's floor-invariant
  // re-gate must THROW (not a tautological in-test boolean).
  t.mutationGuard('shipped output dropped below floor without disclosure makes loadSurrogate throw', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'surr-g2-'));
    try {
      const r = emitSurrogate(ev, candidate, {
        outputClasses: { 'returns.grossMOIC': 'moic' },
        targetOutputKeys: ['returns.grossMOIC'],
        useCase: 'one-off', write: true, outDir: tmp,
      });
      const p = clone(r.params);
      const tgt = p.perTarget['returns.grossMOIC'];
      tgt.rSquared = tgt.classFloor - 0.5; // well below floor
      delete tgt.disclosure; // no by-request contract
      const f = join(tmp, 'broken.params.json');
      writeFileSync(f, JSON.stringify(p));
      let caught = false;
      try { loadSurrogate(f); } catch (e) { caught = /tampered|below floor|mismatch|gateHash|disclosure/i.test(e.message); }
      return caught;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Guard 3: tamper a shipped coeff VALUE (1 → 999), write it, feed to loadSurrogate
  // → the value-signed gateHash must THROW (the money-pricing payload is protected).
  t.mutationGuard('tampered coefficient VALUE makes loadSurrogate throw', () => {
    const { tmp, r } = emitCurvedTmp();
    try {
      const p = clone(r.params);
      const k = Object.keys(p.perTarget)[0];
      const d = Object.keys(p.perTarget[k].coeffs.betas)[0];
      p.perTarget[k].coeffs.betas[d] = 999;
      const f = join(tmp, 'broken.params.json');
      writeFileSync(f, JSON.stringify(p));
      let caught = false;
      try { loadSurrogate(f); } catch (e) { caught = /tampered|gateHash|mismatch/i.test(e.message); }
      return caught;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Guard 4: drift run()'s base output value, feed to loadSurrogate → value-signed
  // gateHash must THROW (run()'s base is protected, not just the shape).
  t.mutationGuard('drifted base.outputs value makes loadSurrogate throw', () => {
    const { tmp, r } = emitCurvedTmp();
    try {
      const p = clone(r.params);
      const k = Object.keys(p.base.outputs)[0];
      p.base.outputs[k] = p.base.outputs[k] + 99999;
      const f = join(tmp, 'broken.params.json');
      writeFileSync(f, JSON.stringify(p));
      let caught = false;
      try { loadSurrogate(f); } catch (e) { caught = /tampered|gateHash|mismatch/i.test(e.message); }
      return caught;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Guard 5: corrupt a stamped hash on a clone → loadSurrogate throws.
  t.mutationGuard('corrupted stamped hash makes loadSurrogate throw', () => {
    const { tmp, r } = emitCurvedTmp();
    try {
      const p = clone(r.params);
      p.provenance.fitSignature = p.provenance.fitSignature + '00';
      const f = join(tmp, 'g5.params.json');
      writeFileSync(f, JSON.stringify(p));
      let caught = false;
      try { loadSurrogate(f); } catch (e) { caught = /tampered|mismatch|stale/i.test(e.message); }
      return caught;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

t.done();

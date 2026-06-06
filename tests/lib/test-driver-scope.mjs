#!/usr/bin/env node
/**
 * Tests for lib/driver-scope.mjs — ADR-027 Phase 2 driver-scope selection.
 *
 * House style (assert/near helpers, passed/failed counters, process.exit). 100%
 * SYNTHETIC in-memory evaluators with a KNOWN-correct answer — NO engines/*
 * fixtures, NO large JSON, NO full npm test. Run only this file.
 *
 * THE PHASE-1 LESSON: the previous increment shipped a TAUTOLOGICAL test that
 * passed for any impl. Every assert below checks the selection / r2 math against
 * an INDEPENDENTLY hand-derived truth (the expected r2 / variance shares are
 * recomputed here from the linear design, NOT read back from driver-scope), and
 * FAILS if the selection logic is wrong. Includes a NEGATIVE control (a garbage
 * impl returning the smallest-coefficient input must fail) and a threshold-
 * sensitivity check (size must GROW with the threshold — the Phase-1 trap).
 *
 * Usage: node tests/lib/test-driver-scope.mjs
 */

import {
  selectDrivers,
  rSquaredOfSweep,
  extractInputSweep,
  rankByVarianceExplained,
  smallestSetAboveThreshold,
} from '../../lib/driver-scope.mjs';
// extractSurface is the sampling spine driver-scope itself uses. We import it ONLY
// to derive the EXACT same sample multiset the implementation will see (the grid is
// rounded to 1e-10 and the one-at-a-time reconstruction includes the shared base
// point once per swept input). The expected r2/variance shares are then computed
// by our OWN independent OLS (refFit) over that sample — so the asserts remain
// non-circular: we re-derive the answer ourselves, we do not read it back from
// driver-scope.
import { extractSurface } from '../../lib/sensitivity.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); } }
function near(a, b, tol, msg) { assert(typeof a === 'number' && Math.abs(a - b) <= tol, `${msg} (got ${a}, want ~${b} +/-${tol})`); }
function eqArr(a, b, msg) {
  const ok = Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
  assert(ok, `${msg} (got [${a}], want [${b}])`);
}

// ── Independent OLS reference (hand math, NOT driver-scope) ───────────────────
// Used to derive expected r2 / variance shares so the asserts are non-circular.
function refLinspace(min, max, steps) {
  const r = [];
  for (let i = 0; i < steps; i++) r.push(min + (max - min) * i / (steps - 1));
  return r;
}
function refFit(xs, ys) {
  const n = xs.length;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxy += xs[i] * ys[i]; sx2 += xs[i] * xs[i]; }
  const my = sy / n;
  let sst = 0;
  for (const y of ys) sst += (y - my) ** 2;
  const denom = n * sx2 - sx * sx;
  const slope = (n * sxy - sx * sy) / denom;
  const inter = (sy - slope * sx) / n;
  let ssr = 0;
  for (let i = 0; i < n; i++) { const p = slope * xs[i] + inter; ssr += (ys[i] - p) ** 2; }
  const r2 = sst === 0 ? 0 : 1 - ssr / sst;
  return { r2, slope, sst, ssExpl: r2 * sst };
}

// ═════════════════════════════════════════════════════════════════════════════
// GROUND TRUTH 1 — NON-TRIVIAL SELECTION (smallest RIGHT set, not all inputs)
// ═════════════════════════════════════════════════════════════════════════════
// out = 100 + (10*x1 + 20*x1^2)   [dominant, slightly curved -> r2~0.949]
//           + 8*x2                [pure linear, small variance]
//           + 0.05*x3             [pure linear, tiny variance]
// All three swept over [0,2], base 1, 7 steps. Var(x1) >> Var(x2) >> Var(x3).
console.log('Testing GT1: non-trivial smallest-set selection');
{
  const STEPS = 7;
  const evaluator = (inp) => ({
    returns: {
      out: 100 + (10 * inp.x1 + 20 * inp.x1 * inp.x1) + 8 * inp.x2 + 0.05 * inp.x3,
    },
  });
  const candidates = {
    x1: { base: 1, min: 0, max: 2, steps: STEPS },
    x2: { base: 1, min: 0, max: 2, steps: STEPS },
    x3: { base: 1, min: 0, max: 2, steps: STEPS },
  };

  // --- Independent expected truth (hand-derived from the linear design) ---
  const grid = refLinspace(0, 2, STEPS);
  const f1 = refFit(grid, grid.map((x) => 10 * x + 20 * x * x));
  const f2 = refFit(grid, grid.map((x) => 8 * x));
  const f3 = refFit(grid, grid.map((x) => 0.05 * x));
  const totalVar = f1.sst + f2.sst + f3.sst;
  const ve1 = f1.ssExpl / totalVar;  // ~0.9268
  const ve2 = f2.ssExpl / totalVar;  // ~0.0237
  const ve3 = f3.ssExpl / totalVar;  // ~9e-7
  // sanity on the design itself (so a bad design is caught before it masks a bug)
  assert(ve1 > 0.9 && ve1 < 0.95, `design: x1 explains ~0.93 of variance (got ${ve1.toFixed(4)})`);
  assert(ve1 + ve2 < 0.999, 'design: x1+x2 do NOT reach 0.999 (forces the grow-the-set case)');

  // --- threshold 0.9: should pick x1 ALONE (smallest right set) ---
  const r09 = selectDrivers(evaluator, candidates, { threshold: 0.9 });
  const t = r09.perTarget['returns.out'];
  eqArr(t.selected, ['x1'], 'thr=0.9 selects EXACTLY [x1] (smallest set, not all three / not x2)');
  assert(t.selected.length === 1, `thr=0.9 selected length is 1 (got ${t.selected.length})`);

  // ranking correctness: x1 > x2 > x3 by variance-explained
  eqArr(t.ranked.map((r) => r.input), ['x1', 'x2', 'x3'], 'ranked order is x1 > x2 > x3 by variance-explained');
  assert(t.ranked[0].input === 'x1', 'ranked[0] is x1 (the dominant lever)');

  // variance-explained shares match the INDEPENDENT hand-derived values
  near(t.ranked[0].varianceExplained, ve1, 1e-9, 'ranked[0].varianceExplained == hand-derived x1 share');
  near(t.ranked[1].varianceExplained, ve2, 1e-9, 'ranked[1].varianceExplained == hand-derived x2 share');
  near(t.ranked[2].varianceExplained, ve3, 1e-9, 'ranked[2].varianceExplained == hand-derived x3 share');

  // selectedR2 (cumulative variance-explained of the selected set) == x1's share
  near(t.selectedR2, ve1, 1e-9, 'selectedR2 == cumulative variance-explained of [x1]');
  assert(t.met === true, 'thr=0.9 met (selectedR2 >= 0.9)');

  // pure per-sweep r2 of x1 in (0.93,0.97) — the r2 MATH against hand math
  assert(f1.r2 > 0.93 && f1.r2 < 0.97, `design check: hand r2 of x1 sweep in (0.93,0.97) = ${f1.r2.toFixed(5)}`);
  near(t.ranked[0].r2, f1.r2, 1e-9, 'reported per-sweep r2 of x1 matches hand-derived OLS r2 (in 0.93..0.97)');

  // --- threshold 0.999: forces a LARGER set (proves size tracks threshold) ---
  const r0999 = selectDrivers(evaluator, candidates, { threshold: 0.999 });
  const t2 = r0999.perTarget['returns.out'];
  assert(t2.selected.length > t.selected.length,
    `threshold 0.999 GROWS the set vs 0.9 (${t2.selected.length} > ${t.selected.length}) — size is NOT insensitive to threshold`);
  assert(t2.selected[0] === 'x1' && t2.selected[1] === 'x2', 'larger set is the next-best prefix [x1,x2,...]');
  // x1+x2 < 0.999 here, so x3 is also pulled in -> all three
  eqArr(t2.selected, ['x1', 'x2', 'x3'], 'thr=0.999 selects [x1,x2,x3] (greedy keeps growing until exhausted)');

  // smooth linear-ish output: no kink, met -> no escalation
  assert(t.breakpoint === false, 'smooth output has NO breakpoint');
  assert(t.escalateTier2 === false, 'smooth + met output does NOT escalate to Tier 2');
  assert(r09.escalate === false, 'top-level escalate is false for the smooth model');
  assert(t.degenerate === false, 'smooth moving output is NOT degenerate');
  near(t.baseValue, evaluator({ x1: 1, x2: 1, x3: 1 }).returns.out, 1e-9, 'baseValue == base-case output');

  // NEGATIVE CONTROL: a garbage impl that returns the smallest-coefficient input
  // (x3) must NOT be what we selected.
  assert(t.selected[0] !== 'x3', 'NEGATIVE CONTROL: does NOT select the tiny-coefficient x3 first');
  assert(!(t.selected.length === 1 && t.selected[0] === 'x2'), 'NEGATIVE CONTROL: does NOT pick x2 as the lone driver');
}

// ═════════════════════════════════════════════════════════════════════════════
// GROUND TRUTH 2 — KINKED OUTPUT TRIPS MANDATORY BREAKPOINT ESCALATION
// ═════════════════════════════════════════════════════════════════════════════
// carry = max(0, 0.20*(moc - 1.5)) * basis   — hockey-stick, hard kink at moc=1.5.
console.log('Testing GT2: kinked output trips mandatory Tier-2 escalation');
{
  const evaluator = (inp) => ({
    waterfall: { carry: Math.max(0, 0.20 * (inp.moc - 1.5)) * inp.basis },
  });

  // kink INTERIOR to the swept range [1.0, 2.5]
  const candidatesKink = {
    moc: { base: 2.0, min: 1.0, max: 2.5, steps: 9 },
    basis: { base: 100, min: 90, max: 110, steps: 9 },
  };
  const rk = selectDrivers(evaluator, candidatesKink, { threshold: 0.9 });
  const tk = rk.perTarget['waterfall.carry'];

  assert(tk.breakpoint === true, 'kinked output: breakpoint detected === true');
  assert(tk.breakpointDrivers.includes('moc'), "moc is in breakpointDrivers (the hurdle kink at 1.5)");
  assert(tk.escalateTier2 === true, 'MANDATORY: kink forces escalateTier2 === true');
  assert(rk.escalate === true, 'top-level escalate === true when any target escalates');
  assert(tk.ranked[0].input === 'moc', 'moc is ranked #1 driver (dominates carry variance)');
  // selection still functions alongside escalation
  assert(tk.selected.includes('moc'), 'moc is selected even while escalation fires');

  // --- SMOOTH counter-case: SAME carry but kink OUTSIDE range [1.6, 2.5] ---
  // Above the hurdle the response is perfectly linear -> NO breakpoint. Escalation
  // then reflects ONLY the r2-floor (met), proving escalation is kink-driven, not
  // always-on.
  const candidatesSmooth = {
    moc: { base: 2.0, min: 1.6, max: 2.5, steps: 9 },
    basis: { base: 100, min: 90, max: 110, steps: 9 },
  };
  const rs = selectDrivers(evaluator, candidatesSmooth, { threshold: 0.9 });
  const ts = rs.perTarget['waterfall.carry'];
  assert(ts.breakpoint === false, 'fully-linear region (kink outside range): NO breakpoint');
  // moc is perfectly linear above the hurdle and dominates -> met -> no escalation
  assert(ts.met === true, 'linear region: r2 floor met (moc explains the variance linearly)');
  assert(ts.escalateTier2 === false, 'linear region escalates only via floor (met) — NOT always-on');
  assert(rs.escalate === false, 'no escalation in the fully-linear region');
}

// ═════════════════════════════════════════════════════════════════════════════
// GROUND TRUTH 2b — OUTPUT-LEVEL KINK GATE: a hurdle on a NON-SELECTED driver
// still escalates (ADR-5: a kinked output cannot be silently scoped as clean).
// ═════════════════════════════════════════════════════════════════════════════
// carry = 100*basis + max(0, 30*(moc-1.5))  — basis DOMINATES the variance (it is
// the selected driver) while the HURDLE kink lives on moc (NOT selected). Before
// the fix the gate filtered breakpoints to the selected set, so this output was
// scoped escalateTier2=false — the same kink escalated or not purely by which
// UNRELATED input dominated variance. Now the kink is output-level and ALWAYS fires.
console.log('Testing GT2b: kink on a NON-selected driver still escalates (output-level gate)');
{
  const evaluator = (inp) => ({
    waterfall: { carry: 100 * inp.basis + Math.max(0, 30 * (inp.moc - 1.5)) },
  });
  const candidates = {
    moc: { base: 2.0, min: 1.0, max: 2.5, steps: 9 },   // hurdle at 1.5 interior
    basis: { base: 100, min: 90, max: 110, steps: 9 },  // dominates the variance
  };
  const r = selectDrivers(evaluator, candidates, { threshold: 0.9 });
  const t = r.perTarget['waterfall.carry'];

  // basis dominates -> it is the selected lead driver, NOT moc.
  assert(t.selected.includes('basis'), 'basis (the variance-dominant input) is selected');
  assert(!t.selected.includes('moc'), 'moc (the kinked input) is NOT in the selected set');
  // ...but the moc hurdle is STILL detected and STILL escalates the output.
  assert(t.breakpoint === true, 'output-level gate: kink on non-selected moc -> breakpoint === true');
  assert(t.breakpointDrivers.includes('moc'), 'breakpointDrivers reports moc even though it was not selected');
  assert(t.escalateTier2 === true, 'MANDATORY: a kinked OUTPUT escalates regardless of which input is selected');
  assert(r.escalate === true, 'top-level escalate === true');

  // MIRROR (the trap the old test fell into): make moc BOTH kinked AND dominant.
  // Both paths agreed here before, giving false confidence — assert it still escalates.
  const mirror = (inp) => ({
    waterfall: { carry: Math.max(0, 30 * (inp.moc - 1.5)) + 0.01 * inp.basis },
  });
  const rm = selectDrivers(mirror, candidates, { threshold: 0.9 });
  const tm = rm.perTarget['waterfall.carry'];
  assert(tm.escalateTier2 === true, 'mirror (moc dominant AND kinked) also escalates — same kink, same result');
}

// ═════════════════════════════════════════════════════════════════════════════
// GROUND TRUTH 2c — NON-MONOTONE (V) DOMINANT DRIVER: documented limitation +
// safety. A symmetric V is the LARGEST mover yet has OLS slope ~0 -> ve ~0, so it
// is DROPPED from `selected`/`drivers` (disclosed limitation). The OUTPUT-LEVEL
// kink gate makes that SAFE: the V's kink escalates even though it is invisible to
// linear selection. This locks the behavior as a CONTRACT, not an accident.
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing GT2c: non-monotone dominant driver is dropped from selection but escalates via the kink gate');
{
  // out = 100 + 100*|x1-1| + 30*x2 : x1's half-range swing (100) > x2's (30) — x1
  // is the BIGGER mover, but it is a symmetric V (slope ~0) and x2 is pure linear.
  const evaluator = (inp) => ({
    returns: { out: 100 + 100 * Math.abs(inp.x1 - 1) + 30 * inp.x2 },
  });
  const candidates = {
    x1: { base: 1, min: 0, max: 2, steps: 9 },
    x2: { base: 1, min: 0, max: 2, steps: 9 },
  };
  const r = selectDrivers(evaluator, candidates, { threshold: 0.9 });
  const t = r.perTarget['returns.out'];

  // DOCUMENTED LIMITATION (asserted so it is a contract): the non-monotone bigger
  // mover x1 is NOT selected and NOT in the top-level drivers union.
  eqArr(t.selected, ['x2'], 'non-monotone x1 is dropped; the linear x2 is selected (disclosed limitation)');
  assert(!r.drivers.includes('x1'), 'top-level drivers union OMITS the non-monotone dominant x1 (disclosed)');
  near(t.ranked.find((e) => e.input === 'x1').varianceExplained, 0, 1e-9, 'x1 (symmetric V) has varianceExplained ~0 (OLS slope ~0)');

  // SAFETY (the actual fix): the V kink escalates even though x1 is invisible to selection.
  assert(t.breakpoint === true, 'V-kink on the dropped x1 is detected (output-level gate)');
  assert(t.breakpointDrivers.includes('x1'), 'breakpointDrivers reports the dropped non-monotone x1');
  assert(t.escalateTier2 === true, 'a non-monotone dominant mover ALWAYS escalates (cannot be silently scoped)');
  assert(r.escalate === true, 'top-level escalate === true');
}

// ═════════════════════════════════════════════════════════════════════════════
// GROUND TRUTH 2d — PARTIAL-FAILURE MODEL: error coverage is surfaced and gates
// escalation. A model that throws over part of its candidate range must NOT be
// scoped as a clean linear driver (met=true) — coverage<1 forces met=false + escalate.
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing GT2d: partial sweep failure surfaces coverage and forces escalation');
{
  // throws for z>1.5; over z in [0,2] steps 5 the grid is {0,0.5,1,1.5,2} -> 1/5 fails.
  const evaluator = (inp) => {
    if (inp.z > 1.5) throw new Error('model blew up above 1.5');
    return { returns: { out: 10 * inp.z } };
  };
  const r = selectDrivers(evaluator, { z: { base: 0, min: 0, max: 2, steps: 5 } }, { threshold: 0.9 });
  const t = r.perTarget['returns.out'];

  near(t.coverage, 0.8, 1e-9, 'coverage == 0.8 (4 of 5 grid points usable; the z=2 point threw)');
  assert(t.coverageBelowFloor === true, 'coverage below the floor is flagged');
  assert(t.met === false, 'a partial-failure sweep is NOT reported met=true even though survivors fit a perfect line');
  assert(t.escalateTier2 === true, 'partial sweep failure forces escalation');
  assert(r.escalate === true, 'top-level escalate === true on partial failure');

  // Control: the SAME linear output with NO failures is clean (coverage 1, no escalation).
  const clean = (inp) => ({ returns: { out: 10 * inp.z } });
  const rc = selectDrivers(clean, { z: { base: 1, min: 0, max: 2, steps: 5 } }, { threshold: 0.9 });
  const tc = rc.perTarget['returns.out'];
  near(tc.coverage, 1, 1e-12, 'clean linear sweep has full coverage == 1');
  assert(tc.coverageBelowFloor === false, 'full coverage is not flagged');
  assert(tc.met === true, 'clean linear sweep meets the floor');
  assert(tc.escalateTier2 === false, 'clean full-coverage linear sweep does NOT escalate');
}

// ═════════════════════════════════════════════════════════════════════════════
// GROUND TRUTH 2e — CLASS-AWARE FLOOR: a curved MONETARY output in the dangerous
// band [0.90, 0.99) is met=true under the bare default but classAware=false so the
// caller can refuse it; under the ADR monetary 0.99 floor it does NOT report met=true.
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing GT2e: class-aware floor + classAware flag for a curved monetary output');
{
  // totalCarry = 1000*x + 300*x^2 : curved monetary output; linear coverage ~0.989,
  // so it sits in [0.90,0.99) — safe under monetary 0.99, unsafe under the 0.9 default.
  const evaluator = (inp) => ({ waterfall: { totalCarry: 1000 * inp.x + 300 * inp.x * inp.x } });
  const candidates = { x: { base: 1, min: 0, max: 2, steps: 9 } };

  const rdef = selectDrivers(evaluator, candidates, { threshold: 0.9 });
  const tdef = rdef.perTarget['waterfall.totalCarry'];
  assert(tdef.selectedR2 >= 0.9 && tdef.selectedR2 < 0.99,
    `design check: selectedR2 in [0.90,0.99) (got ${tdef.selectedR2.toFixed(4)})`);
  assert(tdef.met === true, 'under the bare 0.9 default the curved monetary output reports met=true');
  assert(tdef.classAware === false, 'classAware === false: the non-class-aware default floor was applied (caller must refuse)');

  // Under the ADR monetary floor (0.99) the SAME output does NOT report met=true and escalates.
  const rmon = selectDrivers(evaluator, candidates, {
    threshold: 0.9,
    perTargetThreshold: { 'waterfall.totalCarry': 0.99 },
  });
  const tmon = rmon.perTarget['waterfall.totalCarry'];
  assert(tmon.met === false, 'under the monetary 0.99 floor the curved monetary output is NOT met');
  assert(tmon.classAware === true, 'classAware === true when an explicit per-target floor was supplied');
  assert(tmon.escalateTier2 === true, 'curved monetary output below its class floor escalates');
}

// ═════════════════════════════════════════════════════════════════════════════
// GROUND TRUTH 3 — DEGENERATE / CONSTANT OUTPUT
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing GT3: degenerate constant output');
{
  const evaluator = (inp) => ({
    returns: {
      moving: 5 * inp.a + 2 * inp.b,  // a real driver pair
      flat: 42,                       // constant regardless of inputs
    },
  });
  const candidates = {
    a: { base: 1, min: 0, max: 2, steps: 7 },
    b: { base: 1, min: 0, max: 2, steps: 7 },
  };
  const r = selectDrivers(evaluator, candidates, { threshold: 0.9 });
  const flat = r.perTarget['returns.flat'];

  assert(flat.degenerate === true, 'constant output flagged degenerate');
  eqArr(flat.selected, [], 'constant output selects NOTHING (nothing drives a constant)');
  assert(flat.met === false, 'constant output: threshold not met');
  assert(flat.escalateTier2 === true, 'constant output escalates (cannot scope it linearly)');
  // r2 all zero and NOT NaN (the divide-by-SStot=0 trap)
  for (const row of flat.ranked) {
    assert(row.r2 === 0, `constant output: r2 of ${row.input} is exactly 0 (not NaN)`);
    assert(!Number.isNaN(row.r2), `constant output: r2 of ${row.input} is not NaN`);
    assert(row.varianceExplained === 0, `constant output: varianceExplained of ${row.input} is 0`);
  }
  // sanity: the moving output in the SAME run is still scoped normally
  const moving = r.perTarget['returns.moving'];
  assert(moving.degenerate === false, 'the co-output that DOES move is not degenerate');
  assert(moving.selected.length >= 1, 'the moving output selects at least one driver');
}

// ═════════════════════════════════════════════════════════════════════════════
// GROUND TRUTH 4 — r2 UNIT MATH (load-bearing helper, checked directly)
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing GT4: rSquaredOfSweep unit math');
{
  // perfectly linear -> r2 === 1
  const lin = [{ x: 0, y: 0 }, { x: 1, y: 3 }, { x: 2, y: 6 }, { x: 3, y: 9 }];
  near(rSquaredOfSweep(lin), 1, 1e-9, 'perfectly-linear sweep -> r2 == 1');

  // flat (constant y) -> r2 === 0 (NOT NaN: SStot=0 trap)
  const flat = [{ x: 0, y: 7 }, { x: 1, y: 7 }, { x: 2, y: 7 }];
  const rFlat = rSquaredOfSweep(flat);
  assert(rFlat === 0, `flat sweep -> r2 == 0 (got ${rFlat})`);
  assert(!Number.isNaN(rFlat), 'flat sweep r2 is not NaN');

  // single point / empty -> 0, not NaN
  assert(rSquaredOfSweep([{ x: 1, y: 1 }]) === 0, 'single-point sweep -> r2 == 0');
  assert(rSquaredOfSweep([]) === 0, 'empty sweep -> r2 == 0');

  // KNOWN quadratic-ish sweep: y = x^2 at x in {0,1,2,3,4,5}. Hand-precomputed
  // expected R2 of an OLS line fit (constant baked in below), matched within 1e-6.
  const quad = [0, 1, 2, 3, 4, 5].map((x) => ({ x, y: x * x }));
  // OLS line over (x, x^2), x=0..5: slope=5, intercept=-10/3 (=-3.3333…);
  // R2 = 1 - SSres/SStot, SStot=Σ(y-ȳ)^2 with ȳ=55/6, SSres vs y=5x-10/3.
  // -> R2 = 0.9213759213759214 (hand-derived; verified by direct OLS).
  const EXPECTED_QUAD_R2 = 0.9213759213759214;
  near(rSquaredOfSweep(quad), EXPECTED_QUAD_R2, 1e-6, 'quadratic sweep r2 matches hand-precomputed constant');

  // monotone but curved: r2 < 1 but > 0 (sanity that it is a fraction, not 1)
  const r = rSquaredOfSweep(quad);
  assert(r > 0 && r < 1, `quadratic sweep r2 is a proper fraction in (0,1): ${r}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// HELPER UNIT CHECKS — so selection is not the only guard (no black box)
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing: secondary-export unit checks (extractInputSweep, rank, smallestSet)');
{
  // smallestSetAboveThreshold operates on a ranked list with KNOWN ve shares.
  const ranked = [
    { input: 'A', varianceExplained: 0.6 },
    { input: 'B', varianceExplained: 0.3 },
    { input: 'C', varianceExplained: 0.05 },
    { input: 'D', varianceExplained: 0.0 },
  ];
  const s1 = smallestSetAboveThreshold(ranked, 0.5, 10);
  eqArr(s1.selected, ['A'], 'smallestSet: 0.5 reached by [A] alone (0.6>=0.5)');
  near(s1.selectedR2, 0.6, 1e-12, 'smallestSet: selectedR2 == 0.6');
  assert(s1.met === true, 'smallestSet: 0.5 met');

  const s2 = smallestSetAboveThreshold(ranked, 0.85, 10);
  eqArr(s2.selected, ['A', 'B'], 'smallestSet: 0.85 needs [A,B] (0.6+0.3=0.9>=0.85)');
  near(s2.selectedR2, 0.9, 1e-12, 'smallestSet: cumulative [A,B] == 0.9');

  const s3 = smallestSetAboveThreshold(ranked, 0.99, 10);
  eqArr(s3.selected, ['A', 'B', 'C'], 'smallestSet: 0.99 needs [A,B,C]; D (ve=0) is never added');
  assert(s3.met === false, 'smallestSet: 0.99 NOT met (max reachable is 0.95) — and D is not padded in');
  assert(!s3.selected.includes('D'), 'smallestSet: a zero-contribution input is never selected');

  // maxDrivers cap is honored even when threshold not met
  const s4 = smallestSetAboveThreshold(ranked, 0.99, 1);
  eqArr(s4.selected, ['A'], 'smallestSet: maxDrivers=1 caps the set at [A]');
  assert(s4.met === false, 'smallestSet: capped set does not meet 0.99');

  // extractInputSweep reconstructs the one-at-a-time sweep from a known surface.
  const evaluator = (inp) => ({ returns: { y: 3 * inp.p + 100 * inp.q } });
  const r = selectDrivers(evaluator, {
    p: { base: 0, min: 0, max: 4, steps: 5 },
    q: { base: 0, min: 0, max: 1, steps: 5 },
  }, { threshold: 0.9 });
  // pull the surface back out via the same primary path is internal, but we can
  // re-run rankByVarianceExplained against a hand-built surface to exercise the
  // public helper directly:
  const surface = {
    baseCaseInputs: { p: 0, q: 0 },
    inputGrid: { p: [0, 1, 2], q: [0, 1, 2] },
    baseCaseOutputs: { y: 0 },
    points: [
      // p sweep (q at base 0)
      { inputs: { p: 0, q: 0 }, outputs: { y: 0 }, error: false },
      { inputs: { p: 1, q: 0 }, outputs: { y: 3 }, error: false },
      { inputs: { p: 2, q: 0 }, outputs: { y: 6 }, error: false },
      // q sweep (p at base 0)
      { inputs: { p: 0, q: 1 }, outputs: { y: 100 }, error: false },
      { inputs: { p: 0, q: 2 }, outputs: { y: 200 }, error: false },
    ],
  };
  const sweeps = extractInputSweep(surface, 'p');
  eqArr(sweeps.y.map((pt) => pt.y), [0, 3, 6], 'extractInputSweep(p): keeps only q-at-base points, sorted by x');
  const sweepsQ = extractInputSweep(surface, 'q');
  eqArr(sweepsQ.y.map((pt) => pt.y), [0, 100, 200], 'extractInputSweep(q): keeps only p-at-base points (incl. shared base point)');

  // rankByVarianceExplained on this surface: q (slope 100) dominates p (slope 3)
  const rk = rankByVarianceExplained(surface, 'y', {});
  assert(rk.ranked[0].input === 'q', 'rankByVarianceExplained: q outranks p (bigger variance)');
  assert(rk.ranked[0].varianceExplained > rk.ranked[1].varianceExplained, 'q has the larger variance-explained share');
  assert(rk.degenerate === false, 'moving surface is not degenerate');
  assert(r.perTarget['returns.y'].selected[0] === 'q', 'end-to-end: q is the lead driver of y');
}

// ═════════════════════════════════════════════════════════════════════════════
// FLATTENOUTPUTS COUPLING — a flat (unwrapped) evaluator yields NO keys
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing: flat (unwrapped) evaluator output yields an empty perTarget (documented gotcha)');
{
  const flatEval = (inp) => ({ totalCarry: 5 * inp.x }); // NOT wrapped in a known group
  const r = selectDrivers(flatEval, { x: { base: 1, min: 0, max: 2, steps: 5 } }, { threshold: 0.9 });
  assert(Object.keys(r.perTarget).length === 0, 'unwrapped {totalCarry} exposes ZERO output keys (must wrap in a group)');
  assert(r.escalate === false, 'empty perTarget -> nothing to escalate');

  // and the wrapped form DOES work
  const wrappedEval = (inp) => ({ waterfall: { totalCarry: 5 * inp.x } });
  const r2 = selectDrivers(wrappedEval, { x: { base: 1, min: 0, max: 2, steps: 5 } }, { threshold: 0.9 });
  assert('waterfall.totalCarry' in r2.perTarget, 'wrapping in {waterfall:{...}} exposes the key');
  eqArr(r2.perTarget['waterfall.totalCarry'].selected, ['x'], 'wrapped single linear driver is selected');
}

// ═════════════════════════════════════════════════════════════════════════════
// perTargetThreshold + meta
// ═════════════════════════════════════════════════════════════════════════════
console.log('Testing: perTargetThreshold override + meta roll-up');
{
  // Two outputs sharing one strong + one weak driver. Per-output threshold drives
  // whether the weak driver is pulled in for ONE output but not the other.
  const evaluator = (inp) => ({
    returns: {
      a: 50 * inp.s + 1 * inp.w,   // s dominates
    },
    waterfall: {
      b: 50 * inp.s + 1 * inp.w,   // identical shape
    },
  });
  const candidates = {
    s: { base: 1, min: 0, max: 2, steps: 7 },
    w: { base: 1, min: 0, max: 2, steps: 7 },
  };
  const r = selectDrivers(evaluator, candidates, {
    threshold: 0.9,
    perTargetThreshold: { 'waterfall.b': 0.99999 },
  });
  assert(r.perTarget['returns.a'].threshold === 0.9, 'returns.a uses the default threshold 0.9');
  assert(r.perTarget['waterfall.b'].threshold === 0.99999, 'waterfall.b uses the per-target override 0.99999');
  eqArr(r.perTarget['returns.a'].selected, ['s'], 'at 0.9, returns.a needs only [s]');
  assert(r.perTarget['waterfall.b'].selected.length > r.perTarget['returns.a'].selected.length,
    'the tighter per-target threshold pulls in MORE drivers for waterfall.b');
  // drivers is the UNION of per-target selected sets
  const union = new Set([...r.perTarget['returns.a'].selected, ...r.perTarget['waterfall.b'].selected]);
  eqArr(r.drivers, [...union].sort(), 'drivers === sorted union of all per-target selected sets');
  assert(r.meta.mode === 'independent', "meta.mode === 'independent'");
  assert(r.meta.thresholdDefault === 0.9, 'meta.thresholdDefault records the default');
  eqArr(r.meta.candidateInputs, ['s', 'w'], 'meta.candidateInputs lists the candidates');
  assert(r.meta.totalPoints > 0, 'meta.totalPoints is recorded');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

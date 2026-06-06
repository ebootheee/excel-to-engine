#!/usr/bin/env node
/**
 * test-lite-tier0-generic.mjs — ADR-027 Phase 2: the MANIFEST-DRIVEN Tier-0
 * generalization proof (open follow-up #1).
 *
 * The original emitTier0 was layout-gated to ONE fixture (GPP-Promote: hardcoded
 * sheet 'GPP Promote', per-tier GP cells D128/D155/D169/D177, cashflow rows
 * 117/118). This test proves the generalized, manifest-driven emitter works on a
 * SECOND, fully-synthetic carry model with a DIFFERENT sheet name ('Carry
 * Waterfall'), a DIFFERENT value column (G), and DIFFERENT tier/cashflow rows.
 *
 * Per docs/LITE-TEST-STANDARD.md:
 *   1. NON-CIRCULAR truth: the EXPECTED layout cells/rows are spelled out in the
 *      committed fixture module (hand-written), NOT read back from the detector.
 *   5. HONESTY GATE (the acceptance nuance): lib/waterfall is a 2-tier annual
 *      single-hurdle model while the fixture's per-tier split is catch-up-heavy, so
 *      the DISCLOSED shapeResidual is non-trivial. We assert on the disclosed
 *      shapeResidual (surfaced + within a stated bound), NOT on bit-exact carry —
 *      bit-exact would spuriously fail and would be the wrong claim.
 *   3. MUTATION GUARD (negative control): a manifest MISSING the layout fields →
 *      emitTier0 THROWS the clear "layout not in manifest" error (fail-loud
 *      preserved) and does NOT emit. Plus a detection fail-soft control: a broken
 *      decomposition (sum != total) → detectTier0Layout returns null.
 *   6. Committed/synthetic fixtures only; no network/clock/random.
 *
 * Usage: node tests/lib/test-lite-tier0-generic.mjs
 *
 * @license MIT
 */

import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { makeHarness, clone } from './_lite-harness.mjs';
import { detectTier0Layout } from '../../lib/manifest.mjs';
import { emitTier0, loadTier0 } from '../../lib/lite-tier0.mjs';
import {
  buildGenericGt, buildGenericManifest, EXPECTED, SHEET, VALUE_COL, TIER_ROWS,
} from './fixtures-tier0-generic.mjs';

const t = makeHarness('lib/lite-tier0 (generic / manifest-driven)');

const tmpDirs = [];
function mktmp() { const d = mkdtempSync(join(tmpdir(), 'tier0-generic-')); tmpDirs.push(d); return d; }
function cleanup() { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } } }

/** Write a {gt, manifest} fixture into a fresh temp model dir and return its path. */
function writeFixture(gt, manifest) {
  const dir = mktmp();
  writeFileSync(join(dir, '_ground-truth.json'), JSON.stringify(gt));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

// ===========================================================================
// (1) DETECTION — the generalization: detectTier0Layout derives the layout for a
//     DIFFERENT sheet/column/rows from ground truth, gated on the model's own
//     sum-reconciliation invariant. Truth is the HAND-WRITTEN fixture EXPECTED.
// ===========================================================================
t.section('detectTier0Layout generalizes to a different sheet/column/rows');

const gt = buildGenericGt();
const manifest = buildGenericManifest();
const layout = detectTier0Layout(gt, manifest.carry);

t.ok(layout != null, 'detectTier0Layout returns a layout for the second carry model');
t.eq(layout.sheet, EXPECTED.sheet, `layout.sheet is the SECOND sheet name (${EXPECTED.sheet}, not GPP Promote)`);
t.eq(layout.valueCol, EXPECTED.valueCol, `layout.valueCol is the second model's value column (${EXPECTED.valueCol}, not D)`);
t.eqArr(layout.tierGpCfCells, EXPECTED.tierGpCfCells,
  'detector finds EXACTLY the hand-written per-tier GP cells (different rows than the GPP fixture)');
t.eq(layout.cfRow, EXPECTED.cfRow, `cfRow is the second model's pre-carry row (${EXPECTED.cfRow})`);
t.eq(layout.cumEquityRow, EXPECTED.cumEquityRow, `cumEquityRow is the second model's row (${EXPECTED.cumEquityRow})`);
t.ok(layout.reconRelErr <= 1e-9, `layout reconciles to the carry total (relErr ${layout.reconRelErr})`);

// The detector must NOT have grabbed the LP-side decoy rows or the rate-header
// decoy rows that sit in the block (those would break the sum reconciliation).
const lpDecoy = `${SHEET}!${VALUE_COL}${TIER_ROWS.catchup - 1}`; // "Tier 2 LP CF"
t.ok(!layout.tierGpCfCells.includes(lpDecoy), 'LP-side decoy row is NOT mistaken for a GP-CF cell');
t.ok(!layout.tierGpCfCells.includes(`${SHEET}!${VALUE_COL}10`),
  'a rate-header decoy ("Tier 2 - Catch Up" = 0.5) is NOT mistaken for a GP-CF dollar cell');

// ===========================================================================
// (2) EMIT — emitTier0 produces a Tier-0 artifact for the second model (no throw,
//     no Tier-1 escalation), DERIVING the layout from the manifest.
// ===========================================================================
t.section('emitTier0 emits a Tier-0 artifact for the second model (manifest-derived layout)');

manifest.carry.tier0Layout = layout; // the builder (ete init) would have set this
const dir = writeFixture(gt, manifest);

let emit;
try {
  emit = emitTier0(dir, { write: true });
} catch (e) {
  emit = { error: e.message };
}
t.ok(emit && !emit.error, `emitTier0 did not throw on the second fixture (${emit && emit.error ? emit.error.slice(0, 120) : 'ok'})`);

if (emit && !emit.error) {
  const { params, calibration } = emit;
  t.ok(params.$artifact === 'lite-tier0-v1', 'emitted a tier0 artifact (no Tier-1 escalation)');
  t.ok(existsSync(emit.paramsPath) && existsSync(emit.runPath), 'wrote params + run shim to disk');

  // The artifact targeted the second model's layout, not the hardcoded GPP cells.
  t.eqArr(params.inputs.tierGpCfCells, EXPECTED.tierGpCfCells,
    'artifact.inputs.tierGpCfCells are the second model cells (manifest-derived, not hardcoded GPP)');
  t.eq(params.inputs.cashflowRows.sheet, EXPECTED.sheet, 'artifact records the second sheet for the cashflow rows');
  t.eq(params.provenance.scope.includes('manifest-derived'), true, 'scope discloses the manifest-derived layout');

  // LEVEL: a ratio fit lands the calibration anchor (tier-sum) BY CONSTRUCTION —
  // we assert THAT identity (modelCarry == tierSum == carry total), which is the
  // honest claim, not "the closed form equals the model carry without calibration".
  t.near(calibration.tierSum, EXPECTED.carryTotal, 1e-6,
    'non-circular calibration target == the hand-written carry total (sum of tier GP cells)');
  t.near(params.base.modelCarry, EXPECTED.carryTotal, 1e-6, 'recorded modelCarry == the carry total');

  // ── THE ACCEPTANCE NUANCE: assert on the DISCLOSED shapeResidual, NOT bit-exact.
  //    lib/waterfall (annual, single-hurdle) cannot reproduce a 4-tier catch-up-heavy
  //    monthly split, so shapeResidual is materially > 0 and is DISCLOSED. We bound
  //    it: a real-but-finite structural error. Asserting carry exactness here would
  //    be wrong and would spuriously fail. ──
  t.ok(typeof params.provenance.shapeResidual === 'number' && Number.isFinite(params.provenance.shapeResidual),
    'shapeResidual is surfaced as a finite number (the honesty metric)');
  t.ok(params.provenance.shapeResidual > 0.01,
    `shapeResidual is materially > 0 — the annual closed form does NOT match the 4-tier split (${params.provenance.shapeResidual.toFixed(3)})`);
  t.ok(params.provenance.shapeResidual < 0.6,
    `shapeResidual is within a stated bound (< 0.6; got ${params.provenance.shapeResidual.toFixed(3)}) — a disclosed, finite structural gap`);
  // levelGap (|factor-1|) is likewise materially != 1 and disclosed (not a proof of accuracy).
  t.ok(Math.abs(calibration.factor - 1) > 0.05 && Math.abs(params.provenance.levelGap - Math.abs(calibration.factor - 1)) < 1e-9,
    `levelGap == |factor-1| and is materially != 0 (factor ${calibration.factor.toFixed(3)}) — disclosed level gap`);
  // The artifact must NOT advertise a tautological maxResidual.
  t.ok(!('maxResidual' in params.provenance), 'no tautological maxResidual shipped (ratio fit is exact-by-construction)');

  // The loader reproduces the calibrated base carry (lands the level by construction).
  const run = loadTier0(emit.paramsPath);
  const baseOut = run();
  t.near(baseOut.totalCarry, EXPECTED.carryTotal, 1e-6,
    'loadTier0().run({}) reproduces the calibrated base carry (level lands by construction)');
  t.ok(baseOut.validOnlyNearBase === true && baseOut.tier === 'tier0', 'run() flags tier0 + valid-only-near-base');
}

// ===========================================================================
// (3) MUTATION GUARD / NEGATIVE CONTROL (mandatory) — a manifest MISSING the
//     layout fields → emitTier0 THROWS the clear "layout not in manifest" error
//     (fail-loud), and does NOT emit a wrong artifact.
// ===========================================================================
t.section('fail-loud: a manifest without the layout throws (does not mis-target)');

t.mutationGuard('emitTier0 refuses a manifest lacking carry.tier0Layout', () => {
  const m = clone(manifest);
  delete m.carry.tier0Layout; // break it: strip the manifest-derived layout
  const d = writeFixture(gt, m);
  // The throw message must be the clear, actionable "lacks the Tier-0 layout" error
  // — AND nothing must be written (no confidently-wrong artifact).
  const threw = t.throws(() => emitTier0(d, { write: true }), /LACKS the Tier-0 layout|tier0Layout/i,
    'emitTier0 throws the clear layout-missing error');
  const wroteAnyway = existsSync(join(d, 'lite-tier0.params.json'));
  t.ok(!wroteAnyway, 'no params artifact written when the layout is missing (fail-loud, not mis-target)');
  return threw && !wroteAnyway;
});

// A partial layout (e.g. only 1 tier cell, below the >=2 floor) is also refused.
t.mutationGuard('emitTier0 refuses a half-populated layout (< 2 tier GP cells)', () => {
  const m = clone(manifest);
  m.carry.tier0Layout = { ...clone(layout), tierGpCfCells: [layout.tierGpCfCells[0]] };
  const d = writeFixture(gt, m);
  return t.throws(() => emitTier0(d, { write: true }), /LACKS the Tier-0 layout|tierGpCfCells/i,
    'emitTier0 throws on a half-populated layout');
});

// FAIL-SOFT detection control: a broken decomposition (a tier cell value mutated so
// the sum no longer reconciles to the total) → detectTier0Layout returns null (it
// does NOT ship a layout that fails its own invariant). This is the upstream half of
// fail-loud: detection refuses, the manifest carries no layout, emit then throws.
t.mutationGuard('detectTier0Layout returns null when the decomposition does not reconcile', () => {
  const badGt = clone(gt);
  // Corrupt one GP-CF cell so sum(tier cells) != carry total.
  badGt[EXPECTED.tierGpCfCells[1]] = badGt[EXPECTED.tierGpCfCells[1]] + 5_000_000;
  const got = detectTier0Layout(badGt, manifest.carry);
  return t.ok(got === null, 'a non-reconciling decomposition yields null (fail-soft), not a wrong layout');
});

// ===========================================================================
cleanup();
t.done();

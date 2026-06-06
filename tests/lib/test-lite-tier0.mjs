#!/usr/bin/env node
/**
 * Tests for lib/lite-tier0.mjs — ADR-027 Tier-0 closed-form lite emitter.
 *
 * House style (assert/near helpers, passed/failed counters, exit code). SKIPS +
 * exit 0 if the a2-v3 fixture ground truth is absent (mirrors test-scope-plan's
 * parser-missing skip), so it is safe in `npm test` on machines without the
 * 185MB fixture.
 *
 * THREE independent, NON-tautological checks + a refuse-on-mismatch loader test:
 *
 *  (1) STREAMING-READ UNIT CHECK (no waterfall): streamReadCells pulls the four
 *      per-tier GP CF cells and asserts their SUM === carry.totalCell (D180)
 *      within 1e-6 rel — a known invariant of the model, independent of any
 *      emit. Also asserts heapUsed stays bounded and the scan short-circuits.
 *
 *  (2) FACTOR-INVARIANT SHAPE CHECK (the real, non-tautological accuracy probe):
 *      a single global ratio factor scales every tier UNIFORMLY, so it cannot
 *      change the closed form's per-tier GP SPLIT. We therefore compare the
 *      closed form's catch-up-vs-residual GP fractions to the MODEL's per-tier GP
 *      fractions (D155 vs D169+D177). This is factor-invariant: a structurally
 *      wrong waterfall fails it; a 1000x-wrong gpTotal does NOT pass it. We also
 *      ASSERT the shape gap is real (the closed form does NOT match the model's
 *      shape — disclosed) and that the level factor is materially != 1. We do NOT
 *      assert calibratedGp==tierSum (that is exact by construction — a tautology).
 *
 *  (3) HELD-OUT PERTURBATION CHECK: run({moc: base.moc*1.10}) strictly increases
 *      carry, run({moc*0.90}) strictly decreases it, and the perturbed carry
 *      matches an INDEPENDENT hand-written analytic closed form (residual-tier
 *      carry ≈ carry% × proceeds-above-the-catch-up × factor) — so a regression
 *      in lib/waterfall's tier logic is caught, not just self-consistency.
 *
 *  (4) loadTier0 REFUSE-ON-MISMATCH: (a) tamper provenance.modelHash with the
 *      real fixture co-located and assert loadTier0 THROWS; (b) ship the artifact
 *      to a dir WITHOUT _graph.json/manifest.json, tamper structuralRefs, and
 *      assert loadTier0 THROWS (the primary graph-free handoff scenario).
 *
 * Usage: node tests/lib/test-lite-tier0.mjs
 */

import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import { openSync, readSync, closeSync, statSync } from 'fs';

import {
  emitTier0, loadTier0, streamReadCells, streamReadRows, rowToVector, deriveModelHash,
} from '../../lib/lite-tier0.mjs';
import { computeWaterfall, createAmericanWaterfall } from '../../lib/waterfall.mjs';
import { loadManifest, detectTier0Layout } from '../../lib/manifest.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..');
const CHUNKED = join(ROOT, 'engines', 'outpost-a2-v3', 'chunked');
const GT = join(CHUNKED, '_ground-truth.json');
const MANIFEST = join(CHUNKED, 'manifest.json');

if (!existsSync(GT) || !existsSync(MANIFEST)) {
  console.log('SKIP: a2-v3 fixture ground truth not present at ' + GT);
  process.exit(0);
}

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); } }
function near(a, b, tol, msg) { assert(typeof a === 'number' && Math.abs(a - b) <= tol, `${msg} (got ${a}, want ~${b} +/-${tol})`); }
function relNear(a, b, relTol, msg) {
  const r = b !== 0 ? Math.abs((a - b) / b) : Math.abs(a - b);
  assert(typeof a === 'number' && r <= relTol, `${msg} (got ${a}, want ~${b}, relErr ${r.toExponential(3)} > ${relTol})`);
}

const manifest = loadManifest(CHUNKED);
const totalCell = manifest.carry.totalCell; // "GPP Promote!D180"
const TIER_GP_CELLS = ['GPP Promote!D128', 'GPP Promote!D155', 'GPP Promote!D169', 'GPP Promote!D177'];

// ── ADR-027 Phase 2: emitTier0 is now MANIFEST-DRIVEN — it reads
// manifest.carry.tier0Layout (per-tier GP-CF cells + cashflow rows) rather than a
// hardcoded fixture constant. Derive that layout HERE from a streamed slice of the
// carry sheet via the real detector (detectTier0Layout) and ensure the on-disk
// manifest carries it, so the rest of the suite exercises the manifest-derived
// path end-to-end. We assert the detector reproduced EXACTLY the known GPP-Promote
// layout (the original fixture constants), proving the generalization is faithful.
function streamSheetSlice(gtPath, sheet, cols) {
  // Pull every `${sheet}!${col}${row}` scalar for the requested columns in ONE
  // streaming pass (labels in A/B + the value column), keyed for detectTier0Layout.
  const wantCols = new Set(cols);
  const prefix = sheet + '!';
  const re = /"((?:[^"\\]|\\.)*)":(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|"(?:[^"\\]|\\.)*"|true|false|null)/g;
  const cellRe = new RegExp('^' + sheet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '!([A-Z]+)(\\d+)$');
  const fd = openSync(gtPath, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  const out = {};
  let tail = '', pos = 0;
  try {
    while (true) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break; pos += n;
      const hay = tail + buf.toString('utf8', 0, n);
      re.lastIndex = 0; let m, lastEnd = 0;
      while ((m = re.exec(hay)) !== null) {
        lastEnd = re.lastIndex;
        const key = m[1];
        if (!key.startsWith(prefix)) continue;
        const cm = cellRe.exec(key);
        if (cm && wantCols.has(cm[1])) out[key] = JSON.parse(m[2]);
      }
      tail = hay.slice(Math.max(lastEnd, hay.length - 512));
    }
  } finally { closeSync(fd); }
  return out;
}

const valueCol = totalCell.split('!')[1].match(/^([A-Z]+)/)[1]; // 'D'
const carrySheet = totalCell.split('!')[0];                     // 'GPP Promote'
const sheetSlice = streamSheetSlice(GT, carrySheet, ['A', 'B', valueCol]);
const derivedLayout = detectTier0Layout(sheetSlice, manifest.carry);
assert(derivedLayout != null, 'detectTier0Layout derives a layout for the GPP-Promote carry from ground truth');
if (derivedLayout) {
  assert(JSON.stringify(derivedLayout.tierGpCfCells) === JSON.stringify(TIER_GP_CELLS),
    `detector reproduces the known per-tier GP cells exactly (got ${JSON.stringify(derivedLayout.tierGpCfCells)})`);
  assert(derivedLayout.cfRow === 117 && derivedLayout.cumEquityRow === 118,
    `detector reproduces the known cashflow rows 117/118 (got ${derivedLayout.cfRow}/${derivedLayout.cumEquityRow})`);
  assert(derivedLayout.reconRelErr <= 1e-6, `detector layout reconciles to the carry total (relErr ${derivedLayout.reconRelErr})`);
  // Ensure the on-disk manifest carries the derived layout so emitTier0 (which
  // reloads from disk) finds it. The a2-v3 manifest is a local-only artifact.
  if (!manifest.carry.tier0Layout) {
    const onDisk = JSON.parse(readFileSync(MANIFEST, 'utf-8'));
    onDisk.carry.tier0Layout = derivedLayout;
    writeFileSync(MANIFEST, JSON.stringify(onDisk, null, 2));
    manifest.carry.tier0Layout = derivedLayout;
  }
}

// ── (1) STREAMING-READ UNIT CHECK ────────────────────────────────────────────
console.log('Testing: streamReadCells — tier GP cells sum == carry.totalCell (model invariant)');
let tierSum, d180;
{
  const heap0 = process.memoryUsage().heapUsed;
  const { values, stats } = streamReadCells(GT, new Set([...TIER_GP_CELLS, totalCell]));
  const heap1 = process.memoryUsage().heapUsed;

  for (const c of TIER_GP_CELLS) assert(c in values, `streamed cell ${c} found`);
  assert(totalCell in values, `streamed totalCell ${totalCell} found`);

  tierSum = TIER_GP_CELLS.reduce((s, c) => s + values[c], 0);
  d180 = values[totalCell];
  relNear(tierSum, d180, 1e-6, 'SUM(tier GP cells) == D180 (the non-circular anchor)');
  assert(values['GPP Promote!D128'] === 0, 'Tier-1 (LP pref) GP cashflow is 0');

  // memory contract: bounded heap + short-circuit before EOF
  const heapMB = (heap1 - heap0) / 1e6;
  assert(heapMB < 150, `streaming read heap delta < 150MB (got ${heapMB.toFixed(1)}MB)`);
  assert(stats.scannedBytes < stats.fileBytes, `scan short-circuits before EOF (${(stats.scannedBytes / 1e6).toFixed(0)}/${(stats.fileBytes / 1e6).toFixed(0)}MB)`);
}

// chunk-boundary correctness: a cell late in the file (>90MB offset) is still found
console.log('Testing: streamReadRows — late cells (>90MB offset) are not lost at chunk boundaries');
let cfVec, cumVec, netProceeds, equityBasis;
{
  const { rows, stats } = streamReadRows(GT, 'GPP Promote', [117, 118]);
  cfVec = rowToVector(rows['117']);
  cumVec = rowToVector(rows['118']);
  assert(cfVec.length > 200, `row 117 has the full period vector (got ${cfVec.length} cols)`);
  assert(cumVec.length > 200, `row 118 has the full period vector (got ${cumVec.length} cols)`);
  const nonzero = cfVec.filter((v) => v !== 0).length;
  assert(nonzero >= 40, `row 117 has the expected ~42 nonzero periods (got ${nonzero})`);
  netProceeds = cfVec.reduce((a, b) => a + b, 0);
  equityBasis = Math.abs(Math.min(...cumVec, 0));
  assert(netProceeds > 5e8, `row 117 sum is the ~645M pre-carry proceeds (got ${(netProceeds / 1e6).toFixed(0)}M)`);
  assert(equityBasis > 1e8, `row 118 peak equity is a >100M pooled denominator (got ${(equityBasis / 1e6).toFixed(0)}M)`);
  // the row scan reaches EOF (full pass) — proves late cells survive boundaries
  assert(stats.scannedBytes >= stats.fileBytes * 0.99, 'row scan reaches EOF (late cells across all boundaries seen)');
}

// ── (2) FACTOR-INVARIANT SHAPE CHECK (the real, non-tautological probe) ───────
console.log('Testing: closed-form per-tier GP SPLIT shape vs the model decomposition (factor-invariant)');
let factor, life;
{
  // emit the artifact (writes params + run shim alongside the manifest)
  const { params, calibration } = emitTier0(CHUNKED, { includeCashflows: true });
  factor = calibration.factor;
  life = calibration.life;

  // the calibration anchor is the tier-SUM, not D180-the-cell (real model invariant)
  relNear(calibration.tierSum, d180, 1e-6, 'calibration target (tier-sum) equals D180 invariant');

  // The pref simplification is disclosed (single simple-pref period).
  const prefPeriods = params.waterfall.prefPeriods;
  assert(prefPeriods === 1, 'closed-form pref is a single simple-pref period (disclosed simplification)');

  // FACTOR-INVARIANT SHAPE: rebuild the RAW (uncalibrated) closed form from the
  // model's own upstream cashflows; take its per-tier GP SPLIT (catch-up vs the
  // residual carry tier). The single ratio factor scales both tiers uniformly, so
  // these FRACTIONS do not depend on the factor at all — a wrong waterfall
  // structure would have wrong fractions regardless of calibration.
  const tiers = createAmericanWaterfall({ prefReturn: 0.08, carryPercent: 0.20, residualLPSplit: 0.80, hasCatchup: true });
  const w = computeWaterfall(netProceeds, equityBasis, tiers, { holdPeriodYears: prefPeriods, compoundHurdles: false });
  const cfCatchup = w.tiers.find((t) => /catch-?up/i.test(t.name)).gpAmount;
  const cfResidual = w.gpTotal - cfCatchup;
  const cfCatchupFrac = cfCatchup / w.gpTotal;     // factor-invariant
  const cfResidualFrac = cfResidual / w.gpTotal;   // factor-invariant

  // The model's per-tier GP fractions (D155 = catch-up; D169+D177 = residual carry).
  const mCatchup = streamReadCells(GT, ['GPP Promote!D155']).values['GPP Promote!D155'];
  const mResidual = tierSum - mCatchup; // D169+D177 (D128 pref-tier GP is 0)
  const mCatchupFrac = mCatchup / tierSum;
  const mResidualFrac = mResidual / tierSum;

  // PROVE these fractions are factor-invariant: scaling gpTotal by ANY k leaves
  // them unchanged (this is what makes the comparison a real, non-tautological
  // test — the calibration factor cannot move it).
  const scaled = w.tiers.map((t) => ({ ...t, gpAmount: t.gpAmount * 1e6 }));
  const scaledTotal = scaled.reduce((s, t) => s + t.gpAmount, 0);
  const scaledCatchupFrac = scaled.find((t) => /catch-?up/i.test(t.name)).gpAmount / scaledTotal;
  relNear(scaledCatchupFrac, cfCatchupFrac, 1e-12, 'per-tier GP fraction is factor-invariant (×1e6 unchanged)');

  // The HONEST finding: the abstract annual closed form does NOT match the model's
  // per-tier shape (catch-up ~65% closed-form vs ~45% model). Assert the gap EXISTS
  // (calibration does not fix it) — this is the structural error the artifact
  // discloses, NOT a precision pass. shapeResidual records its magnitude.
  const shapeGap = Math.max(
    Math.abs(cfCatchupFrac - mCatchupFrac),
    Math.abs(cfResidualFrac - mResidualFrac),
  );
  console.log(`  shape: closed-form catch-up=${(cfCatchupFrac * 100).toFixed(1)}% / model catch-up=${(mCatchupFrac * 100).toFixed(1)}%  (gap ${(shapeGap * 100).toFixed(1)}pp, factor=${factor.toFixed(3)})`);
  assert(shapeGap > 0.05, `closed-form vs model SHAPE gap is real and disclosed, not masked by the factor (${(shapeGap * 100).toFixed(1)}pp)`);
  relNear(params.provenance.shapeResidual, shapeGap, 1e-9, 'provenance.shapeResidual equals the measured factor-invariant shape gap');

  // The level factor is materially != 1: the raw closed-form LEVEL is far from the
  // model carry (the factor carries that gap). This is honest disclosure of a
  // structural simplification, NOT evidence of test validity.
  assert(Math.abs(factor - 1) > 0.05, `level factor materially != 1 (${factor.toFixed(4)}) — raw closed form is structurally off (disclosed, not a proof of accuracy)`);
  relNear(params.provenance.levelGap, Math.abs(factor - 1), 1e-9, 'provenance.levelGap == |factor-1|');

  // The artifact must NOT advertise a tautological maxResidual=0.
  assert(!('maxResidual' in params.provenance), 'provenance does NOT ship a tautological maxResidual (ratio fit is exact-by-construction)');
  assert(params.provenance.calibrationIdentity === 'exact-by-construction', 'calibration identity labeled exact-by-construction (not a precision metric)');

  // Dropped-terms disclosure: the manifest catch-up RATE (0.5) is not modeled.
  assert(Array.isArray(params.provenance.droppedTerms) && params.provenance.droppedTerms.some((d) => /catch-?up rate/i.test(d)), 'provenance.droppedTerms discloses the dropped 0.5 catch-up rate');

  // Scope disclosure: ADR-027 Phase 2 — manifest-DERIVED layout (no longer a
  // hardcoded single fixture), reconciled to the carry total, with the honest
  // "annual approximation" structural caveat retained.
  assert(typeof params.provenance.scope === 'string' && /manifest-derived/i.test(params.provenance.scope),
    'provenance.scope discloses the manifest-derived layout (no longer hardcoded single-fixture)');
  assert(/reconciled to|relErr/i.test(params.provenance.scope),
    'provenance.scope discloses the sum-reconciliation that gated the layout');
  assert(/approximation|honest only near/i.test(params.provenance.scope),
    'provenance.scope retains the honest annual-approximation structural caveat');
  // The shipped artifact also records the resolved layout it targeted.
  assert(params.provenance.tier0Layout && Array.isArray(params.provenance.tier0Layout.tierGpCfCells)
    && params.provenance.tier0Layout.tierGpCfCells.length === TIER_GP_CELLS.length,
    'provenance.tier0Layout records the manifest-derived per-tier GP cells');

  // params artifact shape + honest disclosure baked in
  assert(params.$artifact === 'lite-tier0-v1', 'artifact tag stamped');
  assert(params.provenance.modelHash.startsWith('sha256:'), 'modelHash stamped (sha256:)');
  assert(params.provenance.structuralHash.startsWith('sha256:'), 'self-verifiable structuralHash stamped');
  assert(Array.isArray(params.provenance.structuralRefs) && params.provenance.structuralRefs.length > 0, 'structuralRefs embedded for graph-free self-verification');
  assert(typeof params.provenance.disclosure === 'string' && /Tier-0/.test(params.provenance.disclosure), 'Tier-0 disclosure baked in');
  assert(/closed-form/i.test(params.provenance.disclosure), 'exact-for-structure / closed-form disclosure present');
  assert(/Rust-free/.test(params.provenance.disclosure), 'Rust-free disclosure present');
  assert(typeof params.provenance.kinkWarning === 'string' && /kink/i.test(params.provenance.kinkWarning), 'breakpoint/kink escalation note present');
  assert(params.provenance.calibratedTo === totalCell, 'provenance records the cross-check cell (D180)');
  assert(params.base.tierGpCells['GPP Promote!D155'] === streamReadCells(GT, ['GPP Promote!D155']).values['GPP Promote!D155'], 'tierGpCells recorded from the stream, not hardcoded');
}

// ── (3) HELD-OUT PERTURBATION CHECK ──────────────────────────────────────────
console.log('Testing: run({moc*1.10}) increases carry and tracks a fresh computeWaterfall x factor');
{
  const paramsPath = join(CHUNKED, 'lite-tier0.params.json');
  const run = loadTier0(paramsPath);

  const baseOut = run();
  const params = JSON.parse(readFileSync(paramsPath, 'utf-8'));

  // base case reproduces the model carry (= tier-sum) after calibration
  relNear(baseOut.totalCarry, params.base.modelCarry, 1e-6, 'run() base case reproduces the model carry (calibrated)');
  assert(baseOut.calibrated === true && baseOut.tier === 'tier0', 'run() output flags calibrated + tier0');
  assert(baseOut.validOnlyNearBase === true, 'run() flags valid-only-near-base (honest about kink risk)');

  const pertMoc = params.base.moc * 1.10;
  const pertOut = run({ moc: pertMoc });
  assert(pertOut.totalCarry > baseOut.totalCarry, `+10% MoC strictly increases carry (${(pertOut.totalCarry / 1e6).toFixed(1)}M > ${(baseOut.totalCarry / 1e6).toFixed(1)}M)`);

  // INDEPENDENT analytic closed form (hand-written here, NOT a call back into
  // lib/waterfall): the American waterfall with a single simple-pref period and a
  // full 100%-to-GP catch-up to carry% of profit, then carry% of the residual.
  // A regression in lib/waterfall's tier logic would make run() diverge from this.
  const E = params.base.equityBasis;
  const pref = params.waterfall.prefReturn;     // 0.08
  const c = params.waterfall.carryPercent;      // 0.20
  const factorStored = params.provenance.factor;
  function analyticGp(P) {
    const afterRoC = Math.max(P - E, 0);             // return of capital first
    const afterPref = Math.max(afterRoC - E * pref, 0); // single simple-pref period
    const totalProfit = Math.max(P - E, 0);
    const catchup = Math.min(afterPref, c * totalProfit); // 100%-to-GP catch-up to c of profit
    const residual = Math.max(afterPref - catchup, 0) * c; // carry% of the remainder
    return (catchup + residual) * factorStored;            // x stored ratio factor
  }
  const pertNet = E * pertMoc;
  relNear(pertOut.totalCarry, analyticGp(pertNet), 1e-6,
    'run() perturbed matches an INDEPENDENT analytic closed form (catches lib/waterfall tier regressions)');

  // not a constant: a DIFFERENT override yields a different answer, and also tracks
  // the independent analytic form on the way DOWN.
  const downOut = run({ moc: params.base.moc * 0.90 });
  assert(downOut.totalCarry < baseOut.totalCarry, '-10% MoC strictly decreases carry (run() is a real function of inputs)');
  relNear(downOut.totalCarry, analyticGp(E * params.base.moc * 0.90), 1e-6,
    'run() down-perturbed also matches the independent analytic closed form');
}

// ── (4) loadTier0 REFUSE-ON-MISMATCH ─────────────────────────────────────────
console.log('Testing: loadTier0 refuses a stale artifact (tampered modelHash)');
{
  const tmp = mkdtempSync(join(tmpdir(), 'lite-tier0-'));
  try {
    const srcParams = join(CHUNKED, 'lite-tier0.params.json');
    const params = JSON.parse(readFileSync(srcParams, 'utf-8'));
    // point chunkedDir at the real fixture so the live hash is derivable, then
    // tamper the recorded hash so it MUST mismatch the re-derived one.
    params.provenance.chunkedDir = CHUNKED;
    const liveHash = deriveModelHash(CHUNKED);
    assert(params.provenance.modelHash === liveHash, 'emitted hash matches live hash (sanity)');
    params.provenance.modelHash = 'sha256:deadbeef';
    const tampered = join(tmp, 'lite-tier0.params.json');
    writeFileSync(tampered, JSON.stringify(params));
    let threw = false;
    try { loadTier0(tampered); } catch (e) { threw = /stale|modelHash/i.test(e.message); }
    assert(threw, 'loadTier0 throws on a modelHash mismatch (refuse-on-mismatch)');

    // and an untampered copy (chunkedDir → fixture) loads fine
    params.provenance.modelHash = liveHash;
    const good = join(tmp, 'good.params.json');
    writeFileSync(good, JSON.stringify(params));
    let ok = false;
    try { const r = loadTier0(good); ok = typeof r === 'function'; } catch { ok = false; }
    assert(ok, 'loadTier0 accepts a matching modelHash and returns a run() closure');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── (4b) GRAPH-FREE HANDOFF: refuse a tampered artifact with NO _graph/manifest ─
// The PRIMARY lite-package scenario: ship the KB params JSON WITHOUT the 564MB
// graph / 185MB GT. Provenance must still be enforced from the artifact ALONE via
// the embedded structuralRefs + structuralHash. Tampering must THROW, not silently
// load (the original bug: hash check was gated behind existsSync(_graph.json)).
console.log('Testing: loadTier0 refuses a tampered artifact shipped WITHOUT _graph.json/manifest.json');
{
  const tmp = mkdtempSync(join(tmpdir(), 'lite-tier0-shipped-'));
  try {
    const srcParams = join(CHUNKED, 'lite-tier0.params.json');
    const base = JSON.parse(readFileSync(srcParams, 'utf-8'));
    // Confirm the tmp dir really is graph-free + manifest-free (the handoff case).
    assert(!existsSync(join(tmp, '_graph.json')) && !existsSync(join(tmp, 'manifest.json')), 'shipped dir has no graph/manifest (graph-free handoff)');

    // (a) tamper the embedded structuralRefs → self-hash MUST mismatch → throw,
    //     even though there is no graph/manifest to check against.
    {
      const p = structuredClone(base);
      p.provenance.chunkedDir = '.'; // resolves to tmp (graph-free, manifest-free)
      p.provenance.structuralRefs = [...(p.provenance.structuralRefs || []), 'GPP Promote!ZZ999'];
      const f = join(tmp, 'lite-tier0.params.json');
      writeFileSync(f, JSON.stringify(p));
      let threw = false, msg = '';
      try { loadTier0(f); } catch (e) { threw = /tamper|structuralHash/i.test(e.message); msg = e.message; }
      assert(threw, `loadTier0 throws on tampered structuralRefs with no co-located graph (got: ${msg.slice(0, 80)})`);
    }

    // (b) tamper the graph-derived modelHash on a graph-free artifact → the
    //     value cannot be re-verified → throw (do NOT silently trust it).
    {
      const p = structuredClone(base);
      p.provenance.chunkedDir = '.';
      p.provenance.modelHash = 'sha256:deadbeefTAMPERED'; // graph-derived, unverifiable here
      const f = join(tmp, 'lite-tier0.params.json');
      writeFileSync(f, JSON.stringify(p));
      let threw = false, msg = '';
      try { loadTier0(f); } catch (e) { threw = /cannot be re-verified|ships without|stale/i.test(e.message); msg = e.message; }
      assert(threw, `loadTier0 throws on an unverifiable graph-derived modelHash in a graph-free dir (got: ${msg.slice(0, 80)})`);
    }

    // (c) a self-consistent graph-free artifact (modelHash == structuralHash,
    //     refs intact) loads fine — the legitimate graph-free handoff.
    {
      const p = structuredClone(base);
      p.provenance.chunkedDir = '.';
      p.provenance.modelHash = p.provenance.structuralHash; // graph-free identity
      const f = join(tmp, 'lite-tier0.params.json');
      writeFileSync(f, JSON.stringify(p));
      let ok = false, msg = '';
      try { const r = loadTier0(f); ok = typeof r === 'function'; } catch (e) { ok = false; msg = e.message; }
      assert(ok, `loadTier0 accepts a self-consistent graph-free artifact (err: ${msg.slice(0, 80)})`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

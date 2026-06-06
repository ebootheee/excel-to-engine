/**
 * excel-to-engine — ADR-027 Lite Package, Tier-0 closed-form emitter
 *
 * Tier 0 of the right-sized extraction ladder (closed-form → surrogate → cone →
 * full). It distills a model's GP-carry waterfall into a KB-sized params JSON
 * plus a dependency-free `run()` shim, by:
 *   1. reading the MINIMAL set of cells out of the (huge) ground-truth file with a
 *      streaming chunked reader — never JSON.parse the 177MB GT (proven OOM at
 *      512MB);
 *   2. building the closed-form PE waterfall from manifest.carry via lib/waterfall;
 *   3. CALIBRATING the closed-form carry to the model's tier-GP sum with a single
 *      ratio factor — an exact-by-construction LEVEL fit at the base case.
 *
 * HONESTY (baked into every artifact, see provenance.disclosure):
 *   • Tier-0 = closed-form, calibrated-at-base. A single ratio factor lands the
 *     LEVEL on the model carry BY CONSTRUCTION (so there is NO meaningful
 *     "maxResidual" — that would be a tautological 0). The two REAL accuracy
 *     metrics are stamped instead:
 *       – provenance.levelGap     = |factor-1|, how far the raw closed-form LEVEL is.
 *       – provenance.shapeResidual = the FACTOR-INVARIANT per-tier GP-split error
 *         vs the model decomposition — the structural error calibration CANNOT fix.
 *   • The real promote is a monthly-accrual 4-tier waterfall; lib/waterfall is an
 *     annual single-hurdle model, so the SHAPE gap remains and the artifact is
 *     honest ONLY at/near the calibrated base case. Sweeping MoC across the
 *     pref / catch-up KINKS must escalate to Tier 2 (cone).
 *   • SINGLE-FIXTURE (ADR-027 Phase 1): the per-tier GP cells + cashflow rows are
 *     the GPP-Promote layout (see FIXTURE_LAYOUT). emitTier0 hard-throws on any
 *     other carry sheet (assertFixtureLayout) rather than silently mis-targeting.
 *   • Rust-free: pure JS, zero new deps (fs/crypto/path + existing lib/*).
 *
 * @license MIT
 */

import { openSync, readSync, closeSync, statSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname, relative, isAbsolute } from 'path';
import { fileURLToPath } from 'url';

import { resolveModelDir, loadManifest } from './manifest.mjs';
import {
  computeWaterfall, createAmericanWaterfall, createEuropeanWaterfall,
} from './waterfall.mjs';
import { computeIRR } from './irr.mjs';
import { calibrate, validateOutputs } from './calibration.mjs';
import {
  structuralRefs, hashStructuralRefs, deriveModelHash, verifyModelLayer,
} from './lite-provenance.mjs';

// Re-export the model-identity primitives so existing importers (test-lite-tier0,
// test-lite-surrogate) keep importing them from lite-tier0 unchanged. The canonical
// home is now lib/lite-provenance.mjs.
export { structuralRefs, deriveModelHash } from './lite-provenance.mjs';

const ARTIFACT_TAG = 'lite-tier0-v1';

const DISCLOSURE =
  'Tier-0 closed-form (ADR-027). The LEVEL is ratio-calibrated to the model carry at the ' +
  'base case (exact-by-construction there); the per-tier SHAPE is NOT exact — see ' +
  'provenance.shapeResidual / levelGap. The real promote is a monthly-accrual multi-tier ' +
  'waterfall, so this is honest ONLY at/near the calibrated base case — sweeping MoC across ' +
  'the pref/catch-up kinks must escalate to Tier 2 (cone). Rust-free, zero new deps.';

// ---------------------------------------------------------------------------
// 1. Streaming ground-truth reader — THE load-bearing primitive.
//    Never JSON.parse the GT; never split (GT is one minified line). Read 1MB
//    chunks into a reused buffer; carry a 512-byte tail across chunk boundaries
//    so a key/value pair straddling a boundary is not missed; JSON.parse only the
//    matched scalar token; short-circuit once every wanted cell is found.
// ---------------------------------------------------------------------------

const CHUNK = 1024 * 1024; // 1MB
const TAIL = 512;          // carry-tail bytes
// "key":scalar  where scalar is a number | quoted string | true|false|null
const SCALAR_RE = /"((?:[^"\\]|\\.)*)":(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|"(?:[^"\\]|\\.)*"|true|false|null)/g;

/**
 * Read a minimal SET of cell refs out of the GT file via a streaming chunked scan.
 *
 * @param {string} gtPath - path to _ground-truth.json
 * @param {Set<string>|string[]} wantSet - cell refs to extract (e.g. "GPP Promote!D180")
 * @returns {{ values: Object<string, number|string>, stats: { scannedBytes, fileBytes, shortCircuited } }}
 */
export function streamReadCells(gtPath, wantSet) {
  const want = wantSet instanceof Set ? wantSet : new Set(wantSet);
  const fileBytes = statSync(gtPath).size;
  const fd = openSync(gtPath, 'r');
  const buf = Buffer.alloc(CHUNK);
  const values = {};
  let tail = '';
  let pos = 0;
  let scannedBytes = 0;
  let shortCircuited = false;
  try {
    while (want.size > 0) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      scannedBytes += n;
      const hay = tail + buf.toString('utf8', 0, n);
      SCALAR_RE.lastIndex = 0;
      let m;
      let lastEnd = 0;
      while ((m = SCALAR_RE.exec(hay)) !== null) {
        lastEnd = SCALAR_RE.lastIndex;
        const key = m[1];
        if (want.has(key) && !(key in values)) {
          values[key] = JSON.parse(m[2]);
        }
      }
      // every wanted cell found → stop scanning the rest of the file
      let allFound = true;
      for (const k of want) { if (!(k in values)) { allFound = false; break; } }
      if (allFound) { shortCircuited = scannedBytes < fileBytes; break; }
      // carry the unconsumed tail so a boundary-split pair is re-seen next chunk
      const keepFrom = Math.max(lastEnd, hay.length - TAIL);
      tail = hay.slice(keepFrom);
    }
  } finally {
    closeSync(fd);
  }
  return { values, stats: { scannedBytes, fileBytes, shortCircuited } };
}

/**
 * Read whole ROWS of a sheet (e.g. the pre-carry cashflow row) via the same
 * streaming scan. Returns { [row]: { [COL]: number } } for the requested rows.
 *
 * @param {string} gtPath
 * @param {string} sheet - sheet name (left of "!")
 * @param {number[]} rows - row numbers to pull
 * @returns {{ rows: Object<string, Object<string, number>>, stats: {...} }}
 */
export function streamReadRows(gtPath, sheet, rows) {
  const wantRows = new Set(rows.map(String));
  const prefix = sheet + '!';
  const rowRe = new RegExp(
    '^' + sheet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '!([A-Z]+)(\\d+)$',
  );
  const fileBytes = statSync(gtPath).size;
  const fd = openSync(gtPath, 'r');
  const buf = Buffer.alloc(CHUNK);
  const out = {};
  for (const r of wantRows) out[r] = {};
  let tail = '';
  let pos = 0;
  let scannedBytes = 0;
  try {
    while (true) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      scannedBytes += n;
      const hay = tail + buf.toString('utf8', 0, n);
      SCALAR_RE.lastIndex = 0;
      let m;
      let lastEnd = 0;
      while ((m = SCALAR_RE.exec(hay)) !== null) {
        lastEnd = SCALAR_RE.lastIndex;
        const key = m[1];
        if (key.length < prefix.length || key[prefix.length - 1] !== '!') continue;
        if (!key.startsWith(prefix)) continue;
        const rm = rowRe.exec(key);
        if (rm && wantRows.has(rm[2])) {
          const v = JSON.parse(m[2]);
          if (typeof v === 'number') out[rm[2]][rm[1]] = v;
        }
      }
      const keepFrom = Math.max(lastEnd, hay.length - TAIL);
      tail = hay.slice(keepFrom);
    }
  } finally {
    closeSync(fd);
  }
  return { rows: out, stats: { scannedBytes, fileBytes } };
}

/** Column-letter → 1-based index, for ordering streamed row cells left→right. */
function colNum(col) {
  let n = 0;
  for (let i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64);
  return n;
}

/** Ordered (left→right) numeric vector for a streamed row object {COL: value}. */
export function rowToVector(rowObj) {
  return Object.keys(rowObj)
    .sort((a, b) => colNum(a) - colNum(b))
    .map((c) => rowObj[c]);
}

// ---------------------------------------------------------------------------
// 3. Model-identity hashes (structuralRefs / hashStructuralRefs / deriveModelHash)
//    + the (A)/(B)/(C) verifyModelLayer live in lib/lite-provenance.mjs and are
//    imported above. They are cheap + deterministic, never hashing the 177MB GT.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers: minimal cell set + waterfall construction.
// ---------------------------------------------------------------------------

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURE LAYOUT (single-model Phase-1 scope — see ADR-027 Phase 1).
//
// emitTier0 is NOT yet a generic, manifest-driven emitter. The per-tier GP
// cashflow cells, the pre-carry cashflow/cumulative-equity rows, and the promote
// sheet name below are the outpost-a2-v3 GPP-Promote layout. manifest.carry.tiers
// for this model records the hurdle/label cells (C108/F109/BR159), NOT these
// decomposition rows, so there is no manifest derivation path to them yet.
//
// To prevent silently mis-targeting a DIFFERENT model that happens to have
// numbers at these refs, emitTier0 hard-throws (assertFixtureLayout) unless the
// manifest's carry sheet matches FIXTURE_LAYOUT.sheet. The artifact also stamps
// provenance.scope so it discloses the over-fit. See TODO at assertFixtureLayout.
//
// TODO(adr-027 phase-2): derive tierGpCfCells + cashflowRows from a new
// manifest.carry field (e.g. per-tier gpCfCell + cashflowRows) populated by the
// refiner, so a second model can be emitted without editing this constant.
// ─────────────────────────────────────────────────────────────────────────────
const FIXTURE_LAYOUT = {
  // The manifest carry sheet this layout is verified against. assertFixtureLayout
  // throws if manifest.carry.totalCell is on a different sheet.
  sheet: 'GPP Promote',
  // Per-tier GP cashflow cells — the calibration TARGET decomposition. Their sum
  // == carry.totalCell (D180) EXACTLY (rel err 0, verified). The model computes
  // this per-tier decomposition BEFORE the D180 total formula, so reproducing the
  // SHAPE of this decomposition is a real (factor-invariant) check, not a
  // tautology against D180. Rows: pref(0) / catch-up / 8-12% / >12%.
  tierGpCfCells: [
    'GPP Promote!D128', // Tier 1 (LP pref) GP cashflow — 0
    'GPP Promote!D155', // Tier 2 (catch-up) GP cashflow
    'GPP Promote!D169', // Tier 3 (8-12%) GP cashflow
    'GPP Promote!D177', // Tier 4 (>12%) GP cashflow
  ],
  cfRow: 117,        // Total Cash Flows (pre-carry)
  cumEquityRow: 118, // Cumulative Equity Drawn
};

// Back-compat module aliases (read-only). New code should read FIXTURE_LAYOUT.
const TIER_GP_CF_CELLS = FIXTURE_LAYOUT.tierGpCfCells;
const PROMOTE_SHEET = FIXTURE_LAYOUT.sheet;
const CF_ROW = FIXTURE_LAYOUT.cfRow;
const CUM_EQUITY_ROW = FIXTURE_LAYOUT.cumEquityRow;

/** Sheet name (left of "!") for a cell ref like "GPP Promote!D180". */
function sheetOf(ref) {
  if (typeof ref !== 'string') return null;
  const i = ref.indexOf('!');
  return i > 0 ? ref.slice(0, i) : null;
}

/**
 * Hard guard: refuse to emit unless the manifest's carry layout matches the
 * single fixture this emitter is verified against. Without this, a model with
 * unrelated numbers at GPP Promote!D128 etc. would silently mis-calibrate and
 * ship a confidently-wrong artifact. Phase-1 is a one-fixture proof BY DESIGN;
 * this turns "wrong layout" from silent-mis-target into a clean throw.
 */
function assertFixtureLayout(manifest) {
  const carrySheet = sheetOf(manifest.carry?.totalCell);
  if (carrySheet !== FIXTURE_LAYOUT.sheet) {
    throw new Error(
      `emitTier0 is a single-fixture emitter (ADR-027 Phase 1): it only supports the ` +
      `'${FIXTURE_LAYOUT.sheet}' layout (per-tier GP cells ` +
      `${FIXTURE_LAYOUT.tierGpCfCells.join(', ')}, cashflow rows ` +
      `${FIXTURE_LAYOUT.cfRow}/${FIXTURE_LAYOUT.cumEquityRow}). This model's carry sheet is ` +
      `'${carrySheet}' (carry.totalCell=${manifest.carry?.totalCell}). Refusing to emit rather ` +
      `than silently mis-target. TODO(phase-2): derive tier GP cells from the manifest.`,
    );
  }
}

/** First numeric basisCell ref of each equity class (string refs only). */
function equityBasisCells(manifest) {
  return (manifest.equity?.classes || [])
    .map((c) => c.basisCell)
    .filter((c) => typeof c === 'string');
}

/**
 * Build the closed-form waterfall tier array from the manifest's carry block.
 * American (default for this promote): return-of-capital → 8% pref → 50%
 * catch-up → 20% residual carry. European path provided for completeness.
 */
function buildTiers({ structure, prefReturn, carryPercent, hasCatchup }) {
  if (structure === 'european') {
    return createEuropeanWaterfall([
      { hurdle: prefReturn, carry: 0.0 },
      { hurdle: Infinity, carry: carryPercent },
    ]);
  }
  return createAmericanWaterfall({
    prefReturn, carryPercent, residualLPSplit: 1 - carryPercent, hasCatchup,
  });
}

/** Infer structure from manifest.carry.tiers types. */
function inferStructure(manifest) {
  const types = (manifest.carry?.tiers || []).map((t) => t.type);
  // a catch-up tier ⇒ American deal-by-deal style; otherwise European aggregate.
  return types.includes('catchup') ? 'american' : 'european';
}

// ---------------------------------------------------------------------------
// 2. emitTier0 — the public emitter.
// ---------------------------------------------------------------------------

/**
 * Emit a Tier-0 closed-form lite artifact for a converted model.
 *
 * @param {string} manifestDirOrPath - model dir, its chunked/ subdir, or a
 *                                      manifest.json path.
 * @param {Object} [opts]
 * @param {string} [opts.outDir]      - where to write artifacts (default: chunked dir)
 * @param {string} [opts.structure]   - 'american' | 'european' (default: inferred)
 * @param {number} [opts.tolerance]   - calibration tolerance, rel (default 1e-6)
 * @param {string} [opts.gtPath]      - override ground-truth path
 * @param {boolean}[opts.includeCashflows] - embed the raw pre-carry CF vectors
 *                                           in the artifact (default false; keeps
 *                                           the artifact KB-sized)
 * @param {boolean}[opts.write]        - write files to disk (default true)
 * @returns {{ paramsPath, runPath, params, calibration }}
 */
export function emitTier0(manifestDirOrPath, opts = {}) {
  const {
    structure: structureOpt,
    tolerance = 1e-6,
    gtPath: gtPathOpt,
    includeCashflows = false,
    write = true,
  } = opts;

  // --- (a) resolve manifest + chunked dir ---
  let chunkedDir;
  if (manifestDirOrPath.endsWith('manifest.json')) {
    chunkedDir = dirname(manifestDirOrPath);
  } else {
    chunkedDir = resolveModelDir(manifestDirOrPath);
  }
  const manifest = loadManifest(chunkedDir);
  const outDir = opts.outDir || chunkedDir;

  // --- single-fixture guard: throw (not silently mis-target) on a wrong layout ---
  assertFixtureLayout(manifest);

  // --- (b) derive modelHash (cheap; never hashes the GT). Also stamp the
  //     manifest-fallback (structural-refs) hash + the refs themselves so the
  //     shipped artifact can re-verify its OWN integrity with no external files. ---
  const refs = structuralRefs(manifest);
  const modelHash = deriveModelHash(chunkedDir, manifest);
  const structuralHash = hashStructuralRefs(refs);

  // --- (c) locate the ground truth (relative path resolves alongside manifest) ---
  let gtPath = gtPathOpt;
  if (!gtPath) {
    const ref = manifest.model?.groundTruth || './_ground-truth.json';
    const candidates = ref.startsWith('.')
      ? [join(chunkedDir, ref), join(chunkedDir, 'chunked', ref)]
      : [ref];
    gtPath = candidates.find(existsSync);
    if (!gtPath) {
      throw new Error(`Ground truth not found for ${chunkedDir} (tried ${candidates.join(', ')}).`);
    }
  }

  // --- (d) extract the MINIMAL scalar cell set via the streaming reader ---
  const structure = structureOpt || inferStructure(manifest);
  const prefReturn = manifest.carry?.waterfall?.prefReturn
    ?? (manifest.carry?.tiers || []).find((t) => t.type === 'pref')?.hurdleValue
    ?? 0.08;
  // residual carry %: read from the manifest if recorded, else the PE-standard 20%.
  const carryPercent = manifest.carry?.waterfall?.carryPercent
    ?? manifest.carry?.carryPercent
    ?? 0.20;
  const hasCatchup = (manifest.carry?.tiers || []).some((t) => t.type === 'catchup');

  // The manifest records a catch-up RATE (hurdleValue on the catchup tier, here
  // 0.5 = a 50% catch-up split). lib/waterfall's createAmericanWaterfall models a
  // FULL (100%-to-GP) catch-up only — it has no partial-rate catch-up tier — so a
  // non-100% manifest catch-up rate is DROPPED and absorbed by the ratio factor.
  // Disclose it in provenance.droppedTerms rather than hiding it.
  const catchupTier = (manifest.carry?.tiers || []).find((t) => t.type === 'catchup');
  const manifestCatchupRate = catchupTier ? catchupTier.hurdleValue : null;
  const droppedTerms = [];
  if (hasCatchup && typeof manifestCatchupRate === 'number' && Math.abs(manifestCatchupRate - 1) > 1e-9) {
    droppedTerms.push(
      `catch-up rate ${manifestCatchupRate} not modeled — lib/waterfall uses a full ` +
      `100%-to-GP catch-up; the difference is absorbed by the ratio factor.`,
    );
  }

  const basisCells = equityBasisCells(manifest);
  const class0Basis = basisCells[0];
  const totalCell = manifest.carry?.totalCell;
  const grossMoCCell = manifest.equity?.classes?.[0]?.grossMOIC;
  const grossIRRCell = manifest.equity?.classes?.[0]?.grossIRR;

  const wantScalars = new Set([
    ...TIER_GP_CF_CELLS,
    ...(totalCell ? [totalCell] : []),
    ...basisCells,
    ...(grossMoCCell ? [grossMoCCell] : []),
    ...(grossIRRCell ? [grossIRRCell] : []),
  ]);
  const { values: cells } = streamReadCells(gtPath, wantScalars);

  for (const need of [...TIER_GP_CF_CELLS, totalCell].filter(Boolean)) {
    if (!(need in cells)) {
      throw new Error(`Tier-0 emit: required cell ${need} not found in ${gtPath} (streaming reader).`);
    }
  }

  // --- pre-carry cashflow rows: source the promote-pool equity denominator ---
  // netProceeds = total pre-carry proceeds (sum of positive+negative CF), and the
  // equity basis = peak cumulative equity drawn (|min| of the cumulative row).
  const { rows: cfRows } = streamReadRows(gtPath, PROMOTE_SHEET, [CF_ROW, CUM_EQUITY_ROW]);
  const cfVec = rowToVector(cfRows[String(CF_ROW)]);
  const cumEquityVec = rowToVector(cfRows[String(CUM_EQUITY_ROW)]);
  const netProceeds = cfVec.reduce((a, b) => a + b, 0);
  const equityBasis = Math.abs(Math.min(...cumEquityVec, 0));

  // --- base MoC: the PROMOTE-POOL multiple consistent with the chosen base
  // inputs (netProceeds / equityBasis), so run({moc: base.moc}) reproduces
  // base.netProceeds exactly. The class-1 grossMOIC cell (a smaller, different
  // basis) is recorded separately as a cross-reference, NOT used as base.moc. ---
  const moc = equityBasis > 0 ? netProceeds / equityBasis : 1;
  const grossMOIC = grossMoCCell ? cells[grossMoCCell] : null;

  // --- hold life: timeline span, else solve from MoC/IRR (n=ln(MoC)/ln(1+IRR)) ---
  const investYear = manifest.timeline?.investmentYear;
  const exitYear = manifest.timeline?.exitYear;
  const grossIRR = grossIRRCell ? cells[grossIRRCell] : undefined;
  let life;
  if (Number.isFinite(investYear) && Number.isFinite(exitYear) && exitYear > investYear) {
    life = exitYear - investYear;
  } else if (Number.isFinite(grossIRR) && grossIRR > 0 && moc > 1) {
    life = Math.log(moc) / Math.log(1 + grossIRR);
  } else {
    life = 1;
  }

  // --- (e) NON-CIRCULAR calibration target: SUM of the per-tier GP CF cells ---
  const tierGpCells = {};
  for (const c of TIER_GP_CF_CELLS) tierGpCells[c] = cells[c];
  const tierSum = TIER_GP_CF_CELLS.reduce((s, c) => s + cells[c], 0);
  const modelCarry = totalCell ? cells[totalCell] : tierSum;

  // --- build the closed-form engine + calibrate gpTotal → tierSum (ratio) ---
  const tiers = buildTiers({ structure, prefReturn, carryPercent, hasCatchup });
  // STRUCTURAL SIMPLIFICATION (disclosed): lib/waterfall applies the pref as an
  // annual hurdle on the FULL basis at t=0. Compounded over the true 17y life
  // that pref dwarfs the pooled proceeds and zeroes GP; the real promote accrues
  // pref monthly against gradually-drawn capital, so the t=0 full-basis annual
  // hurdle is not the right shape. We therefore apply the pref as a SINGLE
  // simple-pref period (prefPeriods=1, no compounding) — the same convention
  // tests/lib/test-lib.mjs uses for the canonical American waterfall — and let the
  // ratio factor absorb the resulting level gap. The TRUE hold life is still
  // recorded in base.life / provenance.calibratedAt for documentation.
  const PREF_PERIODS = 1;
  const wfOptions = { holdPeriodYears: PREF_PERIODS, compoundHurdles: false };
  const engineFn = (inputs) => {
    const w = computeWaterfall(inputs.netProceeds, inputs.equityBasis, tiers, wfOptions);
    return { totalCarry: w.gpTotal };
  };
  const baseInputs = { netProceeds, equityBasis };
  const calTargets = [{ key: 'totalCarry', excelValue: tierSum, type: 'ratio' }];
  const calResult = calibrate(engineFn, baseInputs, calTargets, { tolerance, maxIter: 5 });
  const factor = calResult.factors.totalCarry;

  // ── HONEST accuracy metrics (NOT a tautological maxResidual) ────────────────
  // A single global ratio fit sets factor = tierSum/rawGp, so calibratedGp ==
  // tierSum BY CONSTRUCTION — that "residual" is identically 0 and conveys ZERO
  // accuracy information. We instead report two real numbers:
  //
  //  • levelGap  = |factor - 1| — how far the raw (uncalibrated) closed-form LEVEL
  //                is from the model carry. Large ⇒ the abstract annual waterfall is
  //                structurally off and the factor is doing the heavy lifting.
  //  • shapeResidual — the FACTOR-INVARIANT per-tier shape error: the closed form's
  //                GP split across {catch-up, residual} vs the model's per-tier GP
  //                fractions (catch-up=D155, post-catch-up=D169+D177). Because the
  //                ratio scales every tier uniformly, it CANNOT change these
  //                fractions, so a nonzero shapeResidual is a true measure of the
  //                structural (shape) error that calibration does NOT fix.
  const rawW = computeWaterfall(netProceeds, equityBasis, tiers, wfOptions);
  const rawGp = rawW.gpTotal;
  const levelGap = Math.abs(factor - 1);

  // Model per-tier GP fractions (factor-invariant): collapse to catch-up vs the
  // post-catch-up residual carry (8-12% + >12%), matching the closed form's two
  // GP-bearing tiers (GP Catch-Up + Residual).
  const mCatchup = cells[TIER_GP_CF_CELLS[1]];                       // D155
  const mResidual = cells[TIER_GP_CF_CELLS[2]] + cells[TIER_GP_CF_CELLS[3]]; // D169+D177
  const mGpTotal = mCatchup + mResidual;
  // Closed-form per-tier GP fractions from the raw (uncalibrated) waterfall.
  const cfCatchupTier = rawW.tiers.find((t) => /catch-?up/i.test(t.name));
  const cfCatchupGp = cfCatchupTier ? cfCatchupTier.gpAmount : 0;
  const cfResidualGp = rawW.gpTotal - cfCatchupGp;
  const cfGpTotal = rawW.gpTotal;
  const shapeResidual =
    (mGpTotal > 0 && cfGpTotal > 0)
      ? Math.max(
          Math.abs(cfCatchupGp / cfGpTotal - mCatchup / mGpTotal),
          Math.abs(cfResidualGp / cfGpTotal - mResidual / mGpTotal),
        )
      : null;

  // --- assemble the params artifact (KB-sized) ---
  const params = {
    $artifact: ARTIFACT_TAG,
    provenance: {
      modelHash,
      // Self-verifiable integrity: the manifest-fallback hash + the exact ref list
      // it digests, so a shipped artifact (no graph, no manifest) can re-derive and
      // compare its OWN structural hash with zero external files (see loadTier0).
      structuralHash,
      structuralRefs: refs,
      calibratedTo: totalCell || null,
      calibrationTarget: 'sum(' + TIER_GP_CF_CELLS.join('+') + ')',
      calibrationMode: 'ratio',
      factor,
      // NOTE: a ratio fit lands on the anchor BY CONSTRUCTION (calibratedGp ==
      // tierSum identically), so we do NOT report a tautological maxResidual=0.
      // These two are the real, factor-invariant honesty metrics:
      levelGap,             // |factor-1|: how far the raw closed-form LEVEL is from the model
      shapeResidual,        // factor-invariant per-tier GP-split error (calibration cannot fix this)
      calibrationIdentity: 'exact-by-construction',
      rSquared: null,
      // Single-fixture Phase-1 scope disclosure (see FIXTURE_LAYOUT / assertFixtureLayout).
      scope:
        `single-fixture: ${FIXTURE_LAYOUT.sheet} layout (per-tier GP cells ` +
        `${FIXTURE_LAYOUT.tierGpCfCells.join('/')}, cashflow rows ` +
        `${FIXTURE_LAYOUT.cfRow}/${FIXTURE_LAYOUT.cumEquityRow} hardcoded). NOT a generic emitter.`,
      droppedTerms,         // manifest terms the closed form cannot express (absorbed by factor)
      generatedAt: new Date().toISOString(),
      chunkedDir: relativeIfInside(outDir, chunkedDir),
      source: manifest.model?.source || null,
      disclosure: DISCLOSURE,
      calibratedAt: { equityBasis, netProceeds, moc, life, prefReturn, carryPercent },
      kinkWarning:
        'Carry is piecewise in MoC with kinks at the pref/catch-up hurdles. ' +
        'run() is honest only at/near calibratedAt; sweeping MoC across a hurdle → escalate to Tier 2 (cone).',
    },
    waterfall: {
      structure,
      prefReturn,
      carryPercent,
      hasCatchup,
      compoundHurdles: wfOptions.compoundHurdles,
      prefPeriods: PREF_PERIODS,
      tiers: tiers.map((t) => ({
        name: t.name,
        type: t.type || 'standard',
        hurdle: t.hurdle === Infinity ? null : t.hurdle,
        lpSplit: t.lpSplit,
        gpSplit: t.gpSplit,
        ...(t.catchupTarget != null ? { catchupTarget: t.catchupTarget } : {}),
      })),
    },
    base: {
      equityBasis,
      moc,
      life,
      netProceeds,
      modelCarry,
      grossMOIC,
      tierGpCells,
    },
    inputs: {
      equityBasisCells: basisCells,
      carryTotalCell: totalCell || null,
      tierGpCfCells: TIER_GP_CF_CELLS,
      grossMOICCell: grossMoCCell || null,
      grossIRRCell: grossIRRCell || null,
      cashflowRows: { sheet: PROMOTE_SHEET, cfRow: CF_ROW, cumEquityRow: CUM_EQUITY_ROW },
    },
  };
  if (includeCashflows) {
    params.base.cashflows = { preCarry: cfVec, cumulativeEquity: cumEquityVec };
  }

  // --- write the params + run() shim ---
  const paramsPath = join(outDir, 'lite-tier0.params.json');
  const runPath = join(outDir, 'lite-tier0.run.mjs');
  if (write) {
    writeFileSync(paramsPath, JSON.stringify(params, null, 2));
    writeFileSync(runPath, renderRunShim(modelHash, outDir));
  }

  const calibration = {
    factor,
    levelGap,
    shapeResidual,
    converged: calResult.converged,
    tierSum,
    modelCarry,
    rawGp,
    calibratedGp: rawGp * factor, // == tierSum by construction (ratio fit)
    droppedTerms,
    structure,
    life,
  };

  return { paramsPath, runPath, params, calibration };
}

/** A relative path from `from` to `to` if `to` is inside it, else the abs path. */
function relativeIfInside(from, to) {
  const rel = relative(from, to);
  if (!rel) return '.';
  return rel.startsWith('..') || isAbsolute(rel) ? to : './' + rel.split('\\').join('/');
}

/**
 * Render the tiny generated run() shim (.mjs). Dependency-free, KB-sized.
 * Locates lib/lite-tier0.mjs relative to the artifact dir.
 */
function renderRunShim(modelHash, outDir) {
  const __dir = dirname(fileURLToPath(import.meta.url)); // .../lib
  let rel = relative(outDir, join(__dir, 'lite-tier0.mjs')).split('\\').join('/');
  if (!rel.startsWith('.')) rel = './' + rel;
  return [
    '// excel-to-engine — Tier-0 lite run() shim (ADR-027). Generated; do not edit.',
    `// Valid only for modelHash ${modelHash} — refuses to load on mismatch.`,
    '// Closed-form, calibrated-at-base; honest only near the base case (see params.provenance).',
    `import { loadTier0 } from '${rel}';`,
    "export const run = loadTier0(new URL('./lite-tier0.params.json', import.meta.url));",
    'export default run;',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 4. loadTier0 — refuse-on-mismatch loader (ADR §5 Provenance).
// ---------------------------------------------------------------------------

/**
 * Load a Tier-0 params artifact and return a bound run() closure. RE-DERIVES the
 * modelHash from the recorded chunkedDir and THROWS on mismatch.
 *
 * @param {string|URL} paramsPath
 * @returns {function(Object=): Object} run(overrides)
 */
export function loadTier0(paramsPath) {
  const p = paramsPath instanceof URL ? fileURLToPath(paramsPath) : paramsPath;
  const params = JSON.parse(readFileSync(p, 'utf-8'));
  if (params.$artifact !== ARTIFACT_TAG) {
    throw new Error(`Not a ${ARTIFACT_TAG} artifact: ${p} (found ${params.$artifact}).`);
  }

  // ── Model-IDENTITY provenance (A self-integrity / B live-model / C graph-free
  //    guard) — the byte-throw-identical block shared with loadSurrogate, now in
  //    lib/lite-provenance.mjs. The $artifact tag check above stays LOCAL. ──────
  verifyModelLayer({ prov: params.provenance, paramsPath: p, label: 'Tier-0' });

  return buildRun(params);
}

// ---------------------------------------------------------------------------
// 5. run — the standalone shim. Closure-captures params; reproduces the base
//    case with no overrides; applies the stored ratio factor so the calibrated
//    base lands on the model carry.
// ---------------------------------------------------------------------------

/**
 * Build the bound run() closure from a params object.
 * @param {Object} params
 * @returns {function(Object=): Object}
 */
export function buildRun(params) {
  const wf = params.waterfall;
  const base = params.base;
  const factor = params.provenance.factor;
  const compoundHurdles = wf.compoundHurdles ?? false;
  // Reconstruct the lib/waterfall tier array (Infinity sentinel survives JSON as null).
  const tiers = wf.tiers.map((t) => ({
    name: t.name,
    hurdle: t.hurdle == null ? Infinity : t.hurdle,
    lpSplit: t.lpSplit,
    gpSplit: t.gpSplit,
    ...(t.type && t.type !== 'standard' ? { type: t.type } : {}),
    ...(t.catchupTarget != null ? { catchupTarget: t.catchupTarget } : {}),
  }));

  // The pref hurdle is a single simple-pref period in the closed form (see emit);
  // base.life is the documented true hold life, NOT the waterfall period count.
  const prefPeriods = wf.prefPeriods ?? 1;

  return function run(overrides = {}) {
    const equityBasis = overrides.equityBasis ?? base.equityBasis;
    const pref = overrides.pref ?? wf.prefReturn;
    const carry = overrides.carry ?? wf.carryPercent;
    const life = overrides.life ?? base.life;

    // netProceeds precedence: explicit netProceeds > moc override > base.
    let netProceeds;
    if (overrides.netProceeds != null) {
      netProceeds = overrides.netProceeds;
    } else if (overrides.moc != null) {
      netProceeds = equityBasis * overrides.moc;
    } else {
      netProceeds = base.netProceeds;
    }

    // If pref/carry overridden, rebuild the tier set; else use the stored tiers.
    let activeTiers = tiers;
    if (overrides.pref != null || overrides.carry != null) {
      activeTiers = buildTiers({
        structure: wf.structure, prefReturn: pref, carryPercent: carry, hasCatchup: wf.hasCatchup,
      });
    }

    const w = computeWaterfall(netProceeds, equityBasis, activeTiers, { holdPeriodYears: prefPeriods, compoundHurdles });
    const gpTotal = w.gpTotal * factor;
    const lpTotal = netProceeds - gpTotal;
    return {
      totalCarry: gpTotal,
      gpTotal,
      lpTotal,
      lpMOIC: equityBasis > 0 ? lpTotal / equityBasis : 0,
      tiers: w.tiers.map((t) => ({ name: t.name, lpAmount: t.lpAmount, gpAmount: t.gpAmount * factor })),
      inputs: { netProceeds, equityBasis, pref, carry, life },
      calibrated: true,
      tier: 'tier0',
      disclosure: params.provenance.disclosure,
      validOnlyNearBase: true,
    };
  };
}

export { validateOutputs, computeIRR };

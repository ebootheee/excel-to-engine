/**
 * excel-to-engine — ADR-027 Lite Package, shared provenance primitives (Phase 6)
 *
 * The single canonical home for the model-IDENTITY hashing + verification logic
 * that lite-tier0 and lite-surrogate previously each carried (verbatim copies of
 * structuralRefs / hashStructuralRefs / deriveModelHash, plus a byte-identical
 * (A)/(B)/(C) self-integrity → live-model → graph-free-guard block inside each
 * loader). Factoring it here removes the duplication WITHOUT changing any digest
 * or any throw/no-throw decision:
 *
 *   • structuralRefs / hashStructuralRefs / deriveModelHash — the model-identity
 *     hashes. Moved VERBATIM from lite-tier0 (byte-for-byte same digests).
 *   • stableStringify / fitSignature — the surrogate's fit-signature primitives.
 *     Moved VERBATIM from lite-surrogate.
 *   • verifyModelLayer({ prov, paramsPath, label }) — the (A)/(B)/(C) model-identity
 *     verification that was duplicated in loadTier0 and loadSurrogate's
 *     model-identity branch. Same throw decisions; message text may differ (per
 *     spec, the test suites match keyword regexes, NOT the label prefix).
 *   • documentLiteArtifact(chunkedDir) — detect a shipped lite-tier0 / lite-surrogate
 *     params artifact and render a handoff markdown section + machine-readable
 *     summary, additively appended to INTEGRATION.md by lib/integration-doc.mjs.
 *
 * Dependency arrow is ONE-WAY: lite-tier0 and lite-surrogate import FROM here;
 * this module imports only node builtins + loadManifest from ./manifest.mjs (so
 * there is no import cycle).
 *
 * @license MIT
 */

import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';

import { loadManifest } from './manifest.mjs';

// ---------------------------------------------------------------------------
// Model-identity hashes (moved VERBATIM from lite-tier0 — same digests).
// ---------------------------------------------------------------------------

/**
 * Stable list of the structural cell refs the artifact depends on. Pulled out of
 * deriveModelHash so the SAME inputs can be embedded in the params artifact —
 * letting a shipped-without-graph artifact re-verify its own hash (see loadTier0).
 *
 * @param {Object} manifest
 * @returns {string[]} sorted ref strings
 */
export function structuralRefs(manifest) {
  const refs = [];
  for (const t of manifest.carry?.tiers || []) {
    if (t.hurdleCell) refs.push(t.hurdleCell);
    if (t.labelCell) refs.push(t.labelCell);
  }
  if (manifest.carry?.totalCell) refs.push(manifest.carry.totalCell);
  for (const c of manifest.equity?.classes || []) {
    if (typeof c.basisCell === 'string') refs.push(c.basisCell);
  }
  refs.sort();
  return refs;
}

/**
 * sha256 of the structural-refs digest. Used as the manifest-fallback hash.
 * (Was a private impl in BOTH lite-tier0 and lite-surrogate — byte-identical.)
 *
 * @param {string[]} refs
 * @returns {string} "sha256:<hex>"
 */
export function hashStructuralRefs(refs) {
  return 'sha256:' + createHash('sha256').update(refs.join('\n')).digest('hex');
}

/**
 * Cheap + deterministic model hash, mirroring scope-plan's discipline. sha256 over
 * the small _graph.json bytes if present, else over a stable digest of the
 * manifest's structural cell refs. NEVER hashes the 177MB ground truth.
 *
 * @param {string} chunkedDir - the dir containing manifest.json (+ _graph.json)
 * @param {Object} [manifest] - already-loaded manifest (avoids a re-read)
 * @returns {string} "sha256:<hex>"
 */
export function deriveModelHash(chunkedDir, manifest) {
  const graphPath = join(chunkedDir, '_graph.json');
  if (existsSync(graphPath)) {
    const bytes = readFileSync(graphPath);
    return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  }
  const mf = manifest || loadManifest(chunkedDir);
  // Stable digest of the structural cell refs the artifact depends on.
  return hashStructuralRefs(structuralRefs(mf));
}

// ---------------------------------------------------------------------------
// Surrogate fit-signature primitives (moved VERBATIM from lite-surrogate).
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON: object keys sorted recursively so the digest is stable.
 *
 * @param {*} v
 * @returns {string}
 */
export function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(
      (k) => JSON.stringify(k) + ':' + stableStringify(v[k]),
    ).join(',') + '}';
  }
  return JSON.stringify(v);
}

/**
 * A STABLE JSON digest of the fit signature — the spec the run() formula depends
 * on (model identity layer for self-contained mode), NOT the float coeff values.
 * The float values + gate decisions live in the gateHash (signGateRecords) instead.
 *
 * @param {Object} sig { candidateInputs, drivers, perOutputBase, coeffsSpec, useCase }
 * @returns {string} "sha256:<hex>"
 */
export function fitSignature(sig) {
  return 'sha256:' + createHash('sha256').update(stableStringify(sig)).digest('hex');
}

// ---------------------------------------------------------------------------
// verifyModelLayer — the (A)/(B)/(C) model-identity verification, lifted
// VERBATIM from the byte-throw-identical model-identity branch of loadTier0 /
// loadSurrogate as they stood prior to Phase 6 (that code now lives ONLY here —
// no specific line numbers, so this comment cannot rot). Same throw decisions;
// the literal label prefix is the ONLY difference and is parameterised.
// ---------------------------------------------------------------------------

/**
 * Verify the model-IDENTITY provenance layer of a shipped lite artifact. THROWS on
 * any failure of:
 *   (A) self-integrity — re-digest the embedded structuralRefs and compare to the
 *       stamped structuralHash (catches a tampered/corrupt artifact with NO model
 *       files co-located — the primary handoff scenario);
 *   (B) live-model — when the recorded chunkedDir resolves with a _graph.json,
 *       re-derive the graph-based modelHash and compare; else when a manifest.json
 *       is present, compare the manifest-fallback hash to the structuralHash;
 *   (C) graph-free guard — when neither is co-located, a graph-derived modelHash
 *       (!= structuralHash) cannot be re-verified from the artifact alone → throw.
 *
 * Returns normally (void) when all three pass.
 *
 * @param {Object} args
 * @param {Object} args.prov        the params.provenance block (model-identity mode)
 * @param {string} args.paramsPath  the ALREADY-RESOLVED params file path (a string,
 *                                   not a URL) — used for dirname() relative
 *                                   resolution of prov.chunkedDir AND message text
 * @param {string} args.label       'Tier-0' | 'Surrogate' — message prefix only;
 *                                   does NOT change any throw decision
 * @returns {void}
 */
export function verifyModelLayer({ prov, paramsPath, label }) {
  const p = paramsPath;
  const recorded = prov?.modelHash;
  const recordedStructural = prov?.structuralHash;
  const embeddedRefs = prov?.structuralRefs;

  // ── (A) self-integrity check (the PRIMARY handoff scenario) ──────────────────
  if (!Array.isArray(embeddedRefs) || typeof recordedStructural !== 'string') {
    throw new Error(
      `${label} artifact ${p} cannot be provenance-verified: missing ` +
      `provenance.structuralRefs / structuralHash. Re-run the emitter to stamp them.`,
    );
  }
  const liveStructural = hashStructuralRefs(embeddedRefs);
  if (liveStructural !== recordedStructural) {
    throw new Error(
      `${label} artifact tampered: structuralHash ${recordedStructural} != ` +
      `${liveStructural} (re-digest of embedded structuralRefs). Re-run the emitter.`,
    );
  }

  // ── (B) Live-model check when resolvable (graph present → strongest hash) ────
  const chunkedRef = prov?.chunkedDir;
  let chunkedDir = chunkedRef;
  if (chunkedRef && chunkedRef.startsWith('.')) {
    chunkedDir = join(dirname(p), chunkedRef);
  }
  const hasGraph = chunkedDir && existsSync(join(chunkedDir, '_graph.json'));
  const hasManifest = chunkedDir && existsSync(join(chunkedDir, 'manifest.json'));

  if (hasGraph) {
    const live = deriveModelHash(chunkedDir);
    if (live !== recorded) {
      throw new Error(`${label} artifact stale: modelHash ${recorded} != ${live}. Re-run the emitter.`);
    }
  } else if (hasManifest) {
    const liveManifestHash = deriveModelHash(chunkedDir); // manifest fallback
    if (liveManifestHash !== recordedStructural) {
      throw new Error(
        `${label} artifact stale: manifest structural hash ${liveManifestHash} != ` +
        `recorded ${recordedStructural}. Re-run the emitter.`,
      );
    }
  } else {
    // ── (C) SHIPPED WITHOUT THE GRAPH/MANIFEST — graph-free handoff guard ──────
    if (recorded !== recordedStructural) {
      throw new Error(
        `${label} artifact ${p} ships without its _graph.json/manifest.json and its ` +
        `modelHash (${recorded}) is graph-derived — it cannot be re-verified from the ` +
        `artifact alone. Re-emit from a graph-free dir (so modelHash == structuralHash) ` +
        `or ship _graph.json alongside it.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// documentLiteArtifact — handoff documentation for a shipped lite artifact.
// Detects lite-tier0.params.json | lite-surrogate.params.json (KB-sized; NEVER
// touches the ground truth) and renders an additive INTEGRATION.md section +
// a machine-readable summary. All values are READ from the params (no recompute).
// ---------------------------------------------------------------------------

const TIER0_PARAMS = 'lite-tier0.params.json';
const SURROGATE_PARAMS = 'lite-surrogate.params.json';

/** JSON.parse a small params file; return null on any read/parse error (treat as absent). */
function readParams(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

/** Markdown blockquote of a multi-line string (one '> ' per line). */
function blockquote(s) {
  return String(s).split('\n').map((l) => `> ${l}`).join('\n');
}

/**
 * Render the Tier-0 handoff section + summary from a lite-tier0 params object.
 * @param {Object} params
 * @returns {{ markdown: string, summary: Object }}
 */
function documentTier0(params) {
  const prov = params.provenance || {};
  const runFile = 'lite-tier0.run.mjs';
  // The overrides buildRun(params).run() accepts (see lite-tier0 buildRun).
  // NOTE: Tier-0 params do not (yet) persist the accepted-override key list, so
  // this MUST be kept in lockstep with lite-tier0 buildRun()'s destructured
  // overrides (moc / equityBasis / pref / carry / life / netProceeds). When
  // ADR-027 phase-2 stamps params.inputs.runOverrides, read it here instead.
  const drivers = ['moc', 'equityBasis', 'pref', 'carry', 'life'];
  const summary = {
    tier: 'tier-0',
    runFile,
    drivers,
    escalated: [], // Tier-0 escalates the WHOLE artifact off-base via kinkWarning, not per-output.
    fidelity: {
      kind: 'exact-by-construction-at-base',
      levelGap: prov.levelGap,
      shapeResidual: prov.shapeResidual,
      calibrationIdentity: prov.calibrationIdentity,
    },
    disclosure: prov.disclosure,
    kinkWarning: prov.kinkWarning,
    droppedTerms: prov.droppedTerms,
    scope: prov.scope,
  };

  const L = [];
  L.push('');
  L.push('## Lite artifact (right-sized extraction)');
  L.push('');
  L.push('This folder also ships a **Tier-0 closed-form** lite artifact: a KB-sized `run()` that needs no engine.');
  L.push('');
  L.push(`Run it: \`import run from "./${runFile}"\` (or \`node ${runFile}\` patterns).`);
  L.push('');
  L.push('**Drivers / levers:**');
  L.push('');
  for (const d of drivers) L.push(`- \`${d}\``);
  L.push('');
  L.push('**Fidelity:**');
  L.push('');
  const lg = Number.isFinite(prov.levelGap) ? prov.levelGap : 'n/a';
  const sr = Number.isFinite(prov.shapeResidual) ? prov.shapeResidual : 'n/a';
  L.push(`Exact at the calibrated base case (levelGap ${lg}, shapeResidual ${sr}); honest ONLY near base.`);
  L.push('');
  L.push('**Escalated outputs (NOT in this artifact — use the cone/full engine):**');
  L.push('');
  L.push('- Tier-0 calibrates the LEVEL at base; sweeping across the pref / catch-up kinks must escalate to Tier 2 (cone).');
  if (Array.isArray(prov.droppedTerms) && prov.droppedTerms.length) {
    for (const dt of prov.droppedTerms) L.push(`- dropped term: ${dt}`);
  }
  if (prov.disclosure) {
    L.push('');
    L.push('**Disclosure:**');
    L.push('');
    L.push(blockquote(prov.disclosure));
  }
  if (prov.kinkWarning) {
    L.push('');
    L.push('**Kink warning:**');
    L.push('');
    L.push(blockquote(prov.kinkWarning));
  }
  L.push('');
  return { markdown: L.join('\n'), summary };
}

/**
 * Render the Tier-1 surrogate handoff section + summary from a lite-surrogate
 * params object. Walks params.perTarget: shipped = entries with !escalateTier2;
 * escalated = entries with escalateTier2.
 * @param {Object} params
 * @returns {{ markdown: string, summary: Object }}
 */
function documentSurrogate(params) {
  const prov = params.provenance || {};
  const inputs = params.inputs || {};
  const runFile = 'lite-surrogate.run.mjs';
  const perTarget = params.perTarget || {};

  const shipped = [];
  const escalated = [];
  const perOutputFidelity = {};
  for (const k of Object.keys(perTarget)) {
    const tEntry = perTarget[k];
    if (tEntry.escalateTier2) {
      escalated.push({
        outputKey: k,
        reason: tEntry.reason,
        recommendedTier: tEntry.recommendedTier ?? 2,
        ...(tEntry.measuredRSquared != null ? { measuredRSquared: tEntry.measuredRSquared } : {}),
      });
    } else {
      shipped.push({
        outputKey: k,
        fitForm: tEntry.fitForm,
        drivers: (tEntry.selected || []).slice(),
        rSquared: tEntry.rSquared,
        maxResidual: tEntry.maxResidual,
        classFloor: tEntry.classFloor,
        offAxisUnverified: !!tEntry.offAxisUnverified,
        ...(tEntry.disclosure ? { disclosure: tEntry.disclosure } : {}),
      });
      perOutputFidelity[k] = {
        rSquared: tEntry.rSquared,
        maxResidual: tEntry.maxResidual,
        classFloor: tEntry.classFloor,
        offAxisUnverified: !!tEntry.offAxisUnverified,
      };
    }
  }

  const summary = {
    tier: 'tier-1',
    runFile,
    drivers: inputs.drivers || [],
    shipped,
    escalated: escalated.map((e) => e.outputKey),
    fidelity: { kind: 'per-output-rSquared', perOutput: perOutputFidelity },
    disclosure: prov.disclosure,
    kinkWarning: prov.kinkWarning,
    useCase: inputs.useCase,
  };

  const L = [];
  L.push('');
  L.push('## Lite artifact (right-sized extraction)');
  L.push('');
  L.push('This folder also ships a **Tier-1 surrogate** lite artifact: a KB-sized `run()` that needs no engine.');
  L.push('');
  L.push(`Run it: \`import run from "./${runFile}"\` (or \`node ${runFile}\` patterns).`);
  L.push('');
  L.push('**Drivers / levers:**');
  L.push('');
  const driverList = inputs.drivers || [];
  if (driverList.length) {
    for (const d of driverList) L.push(`- \`${d}\``);
  } else {
    L.push('- none');
  }
  L.push('');
  L.push('**Fidelity:**');
  L.push('');
  if (shipped.length) {
    L.push('| Output | r2 | maxResidual | floor | off-axis? |');
    L.push('|---|---|---|---|---|');
    for (const s of shipped) {
      const r2 = s.rSquared == null ? 'n/a' : s.rSquared;
      const mr = s.maxResidual == null ? 'n/a' : s.maxResidual;
      const fl = s.classFloor == null ? 'n/a' : s.classFloor;
      L.push(`| \`${s.outputKey}\` | ${r2} | ${mr} | ${fl} | ${s.offAxisUnverified ? 'yes' : 'no'} |`);
    }
  } else {
    L.push('_No outputs shipped clean — every target escalated (see below)._');
  }
  L.push('');
  L.push('**Escalated outputs (NOT in this artifact — use the cone/full engine):**');
  L.push('');
  if (escalated.length) {
    for (const e of escalated) {
      L.push(`- \`${e.outputKey}\` — ${e.reason || 'escalated to Tier ' + e.recommendedTier}`);
    }
  } else {
    L.push('- none');
  }
  if (prov.disclosure) {
    L.push('');
    L.push('**Disclosure:**');
    L.push('');
    L.push(blockquote(prov.disclosure));
  }
  if (prov.kinkWarning) {
    L.push('');
    L.push('**Kink warning:**');
    L.push('');
    L.push(blockquote(prov.kinkWarning));
  }
  L.push('');
  return { markdown: L.join('\n'), summary };
}

/**
 * Detect a shipped lite artifact in a chunked dir and document it for the handoff.
 * Reads lite-tier0.params.json or lite-surrogate.params.json (KB-sized; NEVER the
 * ground truth). Returns present:false + empty markdown/summary when neither
 * exists. All documented values are READ from the params (no recompute), so the
 * doc reflects the LIVE artifact.
 *
 * @param {string} chunkedDir
 * @returns {{ present: boolean, markdown: string, summary: Object }}
 */
export function documentLiteArtifact(chunkedDir) {
  const tier0 = readParams(join(chunkedDir, TIER0_PARAMS));
  if (tier0 && tier0.$artifact && /tier0/i.test(tier0.$artifact)) {
    const { markdown, summary } = documentTier0(tier0);
    return { present: true, markdown, summary };
  }
  const surrogate = readParams(join(chunkedDir, SURROGATE_PARAMS));
  if (surrogate && surrogate.$artifact && /surrogate/i.test(surrogate.$artifact)) {
    const { markdown, summary } = documentSurrogate(surrogate);
    return { present: true, markdown, summary };
  }
  return { present: false, markdown: '', summary: {} };
}

#!/usr/bin/env node
/**
 * Tests for lib/lite-provenance.mjs — ADR-027 Phase 6 shared provenance primitives
 * + the lib/integration-doc.mjs lite-artifact documentation extension.
 *
 * Follows docs/LITE-TEST-STANDARD.md: non-circular truth (hashes compared to a
 * hand-computed sha256, NOT read back from the code under test), ≥1 negative
 * control (verifyModelLayer refuses a tampered structuralHash — provenance rule 4),
 * ≥1 mutation guard (corrupt the artifact, prove the doc/verifier catches it),
 * committed-fixture-free (everything synthesized in tmp), no network/clock/PRNG.
 *
 * Coverage:
 *  • structuralRefs / hashStructuralRefs / deriveModelHash determinism AND that the
 *    factored hashes equal an INDEPENDENT inline sha256 (non-circular, rule 1).
 *  • verifyModelLayer: positive control (clean graph-free prov loads), then refuses
 *    a tampered structuralHash, a tampered structuralRefs (self-integrity), and an
 *    unverifiable graph-derived modelHash in a graph-free dir (rule 4 negative ctrl).
 *  • documentLiteArtifact: present:false for an empty dir; detects a synthesized
 *    surrogate params, names its drivers + shipped + escalated outputs + discloses
 *    fidelity. Independent truth = the values are hand-written into the fixture.
 *  • emitIntegrationDoc extension: APPENDS the lite section when a params file is
 *    present, byte-identical when absent (synthesized tmp engine + named-outputs).
 *  • ≥2 MUTATION GUARDS: a corrupted structuralHash makes verifyModelLayer throw;
 *    a corrupted artifact (flip escalateTier2) makes documentLiteArtifact track it
 *    under summary.escalated, not summary.shipped.
 *
 * Usage: node tests/lib/test-lite-provenance.mjs
 *
 * @license MIT
 */

import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

import { makeHarness, clone } from './_lite-harness.mjs';
import {
  structuralRefs, hashStructuralRefs, deriveModelHash, stableStringify,
  fitSignature, verifyModelLayer, documentLiteArtifact,
} from '../../lib/lite-provenance.mjs';
import { emitIntegrationDoc } from '../../lib/integration-doc.mjs';

const t = makeHarness('lib/lite-provenance.mjs');

// Independent sha256 helper for non-circular truth (NOT the code under test).
function sha256(s) {
  return 'sha256:' + createHash('sha256').update(s).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) structuralRefs / hashStructuralRefs — non-circular determinism (rule 1).
// ─────────────────────────────────────────────────────────────────────────────
t.section('structuralRefs / hashStructuralRefs (non-circular)');
const MANIFEST = {
  carry: { totalCell: 'GPP Promote!D180', tiers: [{ hurdleCell: 'GPP Promote!C108', labelCell: 'GPP Promote!F109' }] },
  equity: { classes: [{ basisCell: 'GPP Promote!E27' }] },
};
{
  // Hand-listed expected refs (sorted) — NOT read back from structuralRefs.
  const expected = ['GPP Promote!C108', 'GPP Promote!D180', 'GPP Promote!E27', 'GPP Promote!F109'];
  const refs = structuralRefs(MANIFEST);
  t.eqArr(refs, expected, 'structuralRefs returns the 4 sorted refs (hand-listed truth)');

  // Non-circular: compute the expected hash with an INDEPENDENT inline sha256.
  const handHash = sha256(expected.join('\n'));
  t.eq(hashStructuralRefs(expected), handHash, 'hashStructuralRefs matches a hand sha256 of refs.join("\\n")');
  // Determinism: same input → same digest.
  t.eq(hashStructuralRefs(expected), hashStructuralRefs(expected), 'hashStructuralRefs is deterministic');
  // A different ref set → a different digest (so the digest is load-bearing).
  t.assert(hashStructuralRefs([...expected, 'GPP Promote!ZZ9']) !== handHash, 'a changed ref set changes the digest');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) deriveModelHash — manifest-fallback path AND graph-bytes path.
// ─────────────────────────────────────────────────────────────────────────────
t.section('deriveModelHash (manifest fallback + graph bytes)');
{
  // (a) manifest-fallback path: a dir with manifest.json only (no _graph.json).
  const tmp = mkdtempSync(join(tmpdir(), 'prov-dmh-'));
  try {
    writeFileSync(join(tmp, 'manifest.json'), JSON.stringify(MANIFEST));
    const viaDir = deriveModelHash(tmp);
    const viaRefs = hashStructuralRefs(structuralRefs(MANIFEST));
    t.eq(viaDir, viaRefs, 'deriveModelHash (manifest fallback) == hashStructuralRefs(structuralRefs(manifest))');
    t.eq(deriveModelHash(tmp), viaDir, 'deriveModelHash is stable across calls (manifest fallback)');

    // (b) graph-bytes path: a _graph.json present → hash over its bytes.
    const graphBytes = '{"nodes":[1,2,3],"edges":[]}';
    writeFileSync(join(tmp, '_graph.json'), graphBytes);
    const viaGraph = deriveModelHash(tmp);
    t.eq(viaGraph, sha256(graphBytes), 'deriveModelHash (graph present) == independent sha256 of the graph bytes');
    t.assert(viaGraph !== viaRefs, 'graph path and manifest-fallback path produce different hashes (expected)');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // stableStringify / fitSignature sanity (moved verbatim, used by surrogate).
  t.eq(stableStringify({ b: 1, a: [2, { d: 4, c: 3 }] }), '{"a":[2,{"c":3,"d":4}],"b":1}', 'stableStringify sorts keys recursively');
  t.eq(fitSignature({ b: 1, a: 2 }), sha256(stableStringify({ b: 1, a: 2 })), 'fitSignature == sha256(stableStringify(sig))');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) verifyModelLayer — positive control + NEGATIVE controls (provenance rule 4).
// ─────────────────────────────────────────────────────────────────────────────
t.section('verifyModelLayer (refuse-on-mismatch)');
{
  const tmp = mkdtempSync(join(tmpdir(), 'prov-vml-'));
  try {
    const refs = structuralRefs(MANIFEST);
    const sh = hashStructuralRefs(refs);
    // A valid graph-free prov: modelHash == structuralHash, refs intact, no graph.
    const goodProv = { structuralRefs: refs, structuralHash: sh, modelHash: sh, chunkedDir: '.' };
    const f = join(tmp, 'lite-tier0.params.json');
    writeFileSync(f, JSON.stringify({ provenance: goodProv }));

    // POSITIVE control: a self-consistent graph-free artifact verifies (no throw).
    let ok = true;
    try { verifyModelLayer({ prov: goodProv, paramsPath: f, label: 'X' }); } catch { ok = false; }
    t.assert(ok, 'verifyModelLayer accepts a self-consistent graph-free prov (positive control)');

    // NEGATIVE control (rule 4): tamper the stamped structuralHash → throw.
    const tamperedHash = clone(goodProv);
    tamperedHash.structuralHash = 'sha256:dead';
    t.throws(() => verifyModelLayer({ prov: tamperedHash, paramsPath: f, label: 'X' }),
      /tampered|mismatch/i, 'tampered structuralHash refused');

    // Tamper the embedded structuralRefs (leave structuralHash) → self-integrity throws.
    const tamperedRefs = clone(goodProv);
    tamperedRefs.structuralRefs = [...refs, 'GPP Promote!ZZ999'];
    t.throws(() => verifyModelLayer({ prov: tamperedRefs, paramsPath: f, label: 'X' }),
      /tampered|mismatch/i, 'tampered structuralRefs refused (self-integrity re-digest)');

    // Graph-derived modelHash (!= structuralHash) in a graph-free dir → cannot verify.
    const graphDerived = clone(goodProv);
    graphDerived.modelHash = 'sha256:deadbeefGRAPH';
    t.throws(() => verifyModelLayer({ prov: graphDerived, paramsPath: f, label: 'X' }),
      /ships without|cannot be re-verified|stale/i, 'graph-derived modelHash in graph-free dir refused (C guard)');

    // Missing refs/hash entirely → cannot be provenance-verified → throw.
    t.throws(() => verifyModelLayer({ prov: { modelHash: sh }, paramsPath: f, label: 'X' }),
      /cannot be provenance-verified|missing/i, 'missing structuralRefs/structuralHash refused');

    // ── (B) graph-PRESENT stale path (the strongest hash) — direct negative control.
    // verifyModelLayer is now the canonical home for this branch, so its own suite
    // must defend it (the tier0 integration test should not be the ONLY net). Write a
    // _graph.json into the resolved chunkedDir, stamp modelHash to the hash of a
    // DIFFERENT byte string (stale), and assert verifyModelLayer throws /stale/.
    {
      const graphBytes = '{"nodes":[1,2,3],"edges":[[1,2]]}';
      writeFileSync(join(tmp, '_graph.json'), graphBytes);
      const liveGraphHash = sha256(graphBytes); // independent truth (not from the code)
      // Positive control first: a prov whose modelHash MATCHES the live graph verifies.
      const freshGraph = { structuralRefs: refs, structuralHash: sh, modelHash: liveGraphHash, chunkedDir: '.' };
      let graphOk = true;
      try { verifyModelLayer({ prov: freshGraph, paramsPath: f, label: 'X' }); } catch { graphOk = false; }
      t.assert(graphOk, 'verifyModelLayer accepts a prov whose modelHash matches the live _graph.json (B positive)');
      // NEGATIVE control: a stale modelHash (!= the live graph bytes hash) → throw /stale/.
      const staleGraph = clone(freshGraph);
      staleGraph.modelHash = sha256('{"nodes":[9,9,9],"edges":[]}'); // hash of OTHER bytes
      t.throws(() => verifyModelLayer({ prov: staleGraph, paramsPath: f, label: 'X' }),
        /stale/i, 'graph-present stale modelHash refused (B branch — direct negative control)');
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: synthesize a minimal, schema-valid lite-surrogate params object.
// Independent truth — the values are hand-written here and asserted to appear,
// NEVER read back from any emitter.
// ─────────────────────────────────────────────────────────────────────────────
function synthSurrogateParams() {
  return {
    $artifact: 'ete-lite-surrogate-v1',
    provenance: {
      mode: 'self-contained',
      disclosure: 'SYNTH DISCLOSURE: indicative only, spot-check the engine.',
      kinkWarning: 'SYNTH KINK WARNING: kinked outputs escalate to Tier 2.',
    },
    base: { outputs: { 'returns.grossMOIC': 2.0 }, baseX: { 'returns.grossMOIC': { exitMultiple: 2.0 } } },
    perTarget: {
      'returns.grossMOIC': {
        outputKey: 'returns.grossMOIC',
        fitForm: 'multiplicative',
        coeffs: { betas: { exitMultiple: 1 } },
        base: 2.0,
        rSquared: 0.985,
        maxResidual: 0.001,
        classFloor: 0.97,
        selected: ['exitMultiple'],
        driverCount: 1,
        escalateTier2: false,
        offAxisUnverified: false,
        disclosure: 'BY-REQUEST SURROGATE BELOW FLOOR (synth).',
      },
      'waterfall.gpCarry': {
        outputKey: 'waterfall.gpCarry',
        fitForm: null,
        coeffs: null,
        escalateTier2: true,
        reason: 'a breakpoint (hurdle/MIP/pref kink) was detected in the swept range',
        recommendedTier: 2,
        measuredRSquared: 0.6,
      },
    },
    inputs: { drivers: ['exitMultiple', 'revenueGrowth'], useCase: 'embedded-surrogate' },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) documentLiteArtifact — present:false + detection of a synthesized surrogate.
// ─────────────────────────────────────────────────────────────────────────────
t.section('documentLiteArtifact');
{
  // present:false for a dir with no artifact.
  const empty = mkdtempSync(join(tmpdir(), 'prov-doc-empty-'));
  try {
    const r = documentLiteArtifact(empty);
    t.assert(r.present === false, 'present:false for a dir with no lite params');
    t.eq(r.markdown, '', 'markdown is empty when absent');
    t.eq(r.summary, {}, 'summary is {} when absent');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }

  // detect a synthesized lite-surrogate.params.json.
  const dir = mkdtempSync(join(tmpdir(), 'prov-doc-surr-'));
  try {
    const params = synthSurrogateParams();
    writeFileSync(join(dir, 'lite-surrogate.params.json'), JSON.stringify(params, null, 2));
    const r = documentLiteArtifact(dir);
    t.assert(r.present === true, 'present:true when a surrogate params file exists');
    t.eq(r.summary.tier, 'tier-1', 'summary.tier === tier-1');
    t.eq(r.summary.runFile, 'lite-surrogate.run.mjs', 'summary.runFile names the surrogate run entry');
    t.assert(r.summary.drivers.includes('exitMultiple'), 'summary.drivers names the driver (exitMultiple)');
    t.assert(r.summary.escalated.includes('waterfall.gpCarry'), 'summary.escalated includes the escalated key');
    t.assert(!r.summary.escalated.includes('returns.grossMOIC'), 'the shipped output is NOT in summary.escalated');
    // markdown discloses the shipped output, its r2/floor, the escalated key, the disclosure text.
    t.assert(/returns\.grossMOIC/.test(r.markdown), 'markdown names the shipped output');
    t.assert(/0\.985/.test(r.markdown), 'markdown discloses the shipped r2 (fidelity)');
    t.assert(/0\.97/.test(r.markdown), 'markdown discloses the class floor');
    t.assert(/waterfall\.gpCarry/.test(r.markdown), 'markdown names the escalated output');
    t.assert(/SYNTH DISCLOSURE/.test(r.markdown), 'markdown blockquotes the disclosure text');
    t.assert(/## Lite artifact/.test(r.markdown), 'markdown begins the Lite artifact H2 section');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) emitIntegrationDoc extension — additive when present, byte-identical absent.
// ─────────────────────────────────────────────────────────────────────────────
t.section('integration-doc lite append');
{
  const dir = mkdtempSync(join(tmpdir(), 'prov-idoc-'));
  try {
    // Minimal synthesized engine + contract files (no Rust, no network).
    writeFileSync(join(dir, 'engine.js'), 'export function run() { return { values: {} }; }\n');
    writeFileSync(join(dir, 'named-outputs.json'), JSON.stringify({
      modelTitle: 'Synth',
      namedOutputs: { grossMOIC: { cell: 'IC!B5', baseCaseValue: 2.0, format: 'multiple', dependsOnNamedInputs: [] } },
    }));
    writeFileSync(join(dir, 'named-inputs.json'), JSON.stringify({ namedInputs: {} }));

    // (a) NO lite params present → baseline INTEGRATION.md has no lite section.
    emitIntegrationDoc(dir);
    const baseline = readFileSync(join(dir, 'INTEGRATION.md'), 'utf-8');
    t.assert(!/## Lite artifact/.test(baseline), 'baseline INTEGRATION.md has NO Lite artifact section (absent)');

    // (b) drop a lite-surrogate params into the SAME dir → re-emit appends the section.
    writeFileSync(join(dir, 'lite-surrogate.params.json'), JSON.stringify(synthSurrogateParams(), null, 2));
    emitIntegrationDoc(dir);
    const withLite = readFileSync(join(dir, 'INTEGRATION.md'), 'utf-8');
    t.assert(withLite.startsWith(baseline), 'INTEGRATION.md is byte-identical up to the baseline, then appends (additive)');
    t.assert(/## Lite artifact/.test(withLite), 'the appended section is present when a params file exists');
    t.assert(/lite-surrogate\.run\.mjs/.test(withLite), 'the appended section names the run entry file');
    t.assert(/exitMultiple/.test(withLite), 'the appended section names a driver');
    t.assert(/waterfall\.gpCarry/.test(withLite), 'the appended section names the escalated output');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6) MUTATION GUARDS (rule 3) — clone, break, prove the code catches it.
// ─────────────────────────────────────────────────────────────────────────────
t.section('mutation guards');
{
  // Guard 1: a corrupted structuralHash must make verifyModelLayer THROW.
  t.mutationGuard('verifyModelLayer catches a corrupted structuralHash', () => {
    const refs = structuralRefs(MANIFEST);
    const sh = hashStructuralRefs(refs);
    const prov = clone({ structuralRefs: refs, structuralHash: sh, modelHash: sh, chunkedDir: '.' });
    prov.structuralHash = 'sha256:bad'; // break it
    let caught = false;
    try {
      verifyModelLayer({ prov, paramsPath: join(tmpdir(), 'nope', 'p.json'), label: 'X' });
    } catch (e) { caught = /tampered|mismatch/i.test(e.message); }
    return caught;
  });

  // Guard 2: corrupting the artifact (flip escalateTier2 + drop coeffs on a shipped
  // output) must make documentLiteArtifact reflect the LIVE artifact — the formerly
  // shipped output now appears under summary.escalated, NOT summary.shipped. Proves
  // the doc reads the live params, not a cached/fabricated view.
  t.mutationGuard('documentLiteArtifact summary tracks a corrupted artifact (live, not cached)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prov-mg2-'));
    try {
      const params = synthSurrogateParams();
      // sanity baseline: grossMOIC ships clean before corruption.
      writeFileSync(join(dir, 'lite-surrogate.params.json'), JSON.stringify(params));
      const before = documentLiteArtifact(dir);
      const shippedBefore = before.summary.shipped.some((s) => s.outputKey === 'returns.grossMOIC');
      // CORRUPT: flip the shipped output to escalated + remove coeffs.
      const broken = clone(params);
      broken.perTarget['returns.grossMOIC'].escalateTier2 = true;
      broken.perTarget['returns.grossMOIC'].coeffs = null;
      broken.perTarget['returns.grossMOIC'].reason = 'forced escalation (mutation test)';
      writeFileSync(join(dir, 'lite-surrogate.params.json'), JSON.stringify(broken));
      const after = documentLiteArtifact(dir);
      const escalatedAfter = after.summary.escalated.includes('returns.grossMOIC');
      const notShippedAfter = !after.summary.shipped.some((s) => s.outputKey === 'returns.grossMOIC');
      return shippedBefore && escalatedAfter && notShippedAfter;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

t.done();

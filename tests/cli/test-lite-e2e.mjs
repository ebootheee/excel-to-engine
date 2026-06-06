#!/usr/bin/env node
/**
 * test-lite-e2e.mjs — the ADR-027 Phase 7 "day in the life" e2e for `ete lite`.
 *
 * Simulates a NON-TECHNICAL analyst pointing a coding agent at this repo with a
 * converted model and asserts the "wow, that was easy" path END-TO-END, with NO
 * Rust and NO network, on COMMITTED fixtures. It drives the REAL CLI via
 * spawnSync (process.execPath + cli/index.mjs lite …) for the headline path, and
 * uses the lib API on the synthetic engine (directEvaluator(computeModel)) for
 * precise fidelity + the honest-escalation negative control.
 *
 * Per docs/LITE-TEST-STANDARD.md:
 *   1. NON-CIRCULAR truth — base-case fidelity is checked against the cascade base
 *      computed INDEPENDENTLY in this test, never read back from the artifact;
 *      the kink/clean split is asserted against the synthetic engine's own values.
 *   2. NEGATIVE CONTROL — a money output whose lever range crosses the MIP@1.5×
 *      kink is reported ESCALATED (run() returns {escalated:true}, not a number),
 *      while a clean output ships; the SAME output ships clean on a no-kink range
 *      (proving the gate is signal, not always-on).
 *   3. MUTATION GUARD — tamper a shipped beta in the emitted artifact and assert
 *      loadSurrogate THROWS (refuse-on-mismatch).
 *   4. Committed fixtures only; no network/clock/random.
 *   5. harness.done() exits non-zero on any failure.
 *
 * The "wow" is concrete: (1) ete lite exits 0 + recommends a tier with a
 * rationale; (2) emits a KB-SIZED artifact (< 64 KB) + a run file; (3) loading
 * the artifact reproduces the base case within the tier precision budget; (4) the
 * handoff (INTEGRATION.md) NAMES the scoped lever + per-output fidelity + the
 * escalated-outputs section; (5) the honest escalation negative control; (6)
 * refuse-on-mismatch on a tampered artifact.
 *
 * Usage: node tests/cli/test-lite-e2e.mjs
 *
 * @license MIT
 */

import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

import { makeHarness, clone } from '../lib/_lite-harness.mjs';
import { cascadeEvaluator, directEvaluator } from '../../lib/lite-evaluators.mjs';
import { emitSurrogate, loadSurrogate } from '../../lib/lite-surrogate.mjs';
import { documentLiteArtifact } from '../../lib/lite-provenance.mjs';
import { loadManifest, loadGroundTruth } from '../../lib/manifest.mjs';
import { computeModel } from '../synthetic-pe-model/engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const CLI = join(REPO, 'cli', 'index.mjs');
const FIXTURES = join(REPO, 'tests', 'cli', 'fixtures');

const t = makeHarness('cli/lite (e2e)');

const IRR_FLOOR = 0.97;     // R2_FLOORS.irr — the Tier-1 precision budget for grossIRR
const MONETARY_FLOOR = 0.99; // R2_FLOORS.monetary/carry

const tmpDirs = [];
function mktmp(prefix) { const d = mkdtempSync(join(tmpdir(), prefix)); tmpDirs.push(d); return d; }
function cleanup() { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } } }

// ===========================================================================
// (1) THE CLI / CASCADE HEADLINE PATH — `ete lite` exits 0, recommends a tier
//     with a rationale, transparently falls back Tier 0 → Tier 1.
// ===========================================================================
t.section('CLI headline path (no Rust, real CLI)');

const outDir1 = mktmp('lite-e2e-cli-');
const run1 = spawnSync(
  process.execPath,
  [CLI, 'lite', FIXTURES, '--output', 'grossIRR', '--use-case', 'one-off', '--out-dir', outDir1, '--format', 'json'],
  { encoding: 'utf-8' },
);

t.ok(run1.status === 0, `ete lite exits 0 (status=${run1.status}; stderr: ${(run1.stderr || '').slice(0, 200)})`);

let res = null;
try { res = JSON.parse(run1.stdout); } catch { /* parsed below */ }
t.ok(res && typeof res === 'object', 'ete lite emits parseable JSON');

if (res) {
  t.ok(Number.isInteger(res.recommendedTier) && res.recommendedTier >= 0 && res.recommendedTier <= 3,
    `recommendedTier is 0..3 (got ${res.recommendedTier})`);
  t.ok(typeof res.rationale === 'string' && res.rationale.length > 0, 'rationale is a non-empty string');
  // one-off recommends Tier 0; emitTier0 throws on the fixture's 'GP Promote' carry
  // sheet (not the 'GPP Promote' single-fixture layout) → falls back to Tier 1.
  t.ok(res.tier0FellBackToTier1 === true, 'Tier 0 fell back to Tier 1 (single-fixture layout guard)');
  t.ok(res.recommendedTier === 1, `final recommendedTier is 1 after fallback (got ${res.recommendedTier})`);
  t.ok(typeof res.tier0FallbackReason === 'string' && /single-fixture|GPP Promote|layout/i.test(res.tier0FallbackReason),
    'fallback note quotes the layout guard');
  t.eqArr(res.drivers, ['exitMultiple'], 'scoped the single dominant lever exitMultiple');
}

// --- THE LITERAL FRONT-DOOR COMMAND: no --out-dir (the default <dir>/lite-out).
//     This is the EXACT command the SKILL/spec tells the analyst to run. It must
//     create the default dir, exit 0, and leave a real artifact on disk. The
//     committed fixtures stay PRISTINE — we rmSync the default lite-out after. ---
t.section('Default out-dir (the literal front-door command, no --out-dir)');

const defaultOutDir = join(FIXTURES, 'lite-out');
try { rmSync(defaultOutDir, { recursive: true, force: true }); } catch { /* pre-clean */ }
const runDefault = spawnSync(
  process.execPath,
  [CLI, 'lite', FIXTURES, '--output', 'grossIRR', '--use-case', 'one-off'],
  { encoding: 'utf-8' },
);
t.ok(runDefault.status === 0,
  `ete lite (no --out-dir) exits 0 (status=${runDefault.status}; stderr: ${(runDefault.stderr || '').slice(0, 200)})`);
t.ok(!/ENOENT/.test(runDefault.stderr || ''), 'no raw ENOENT — the default out-dir is created, not crashed on');
t.ok(existsSync(join(defaultOutDir, 'lite-surrogate.params.json')),
  'default <dir>/lite-out artifact exists (the dir was created)');
t.ok(/Right-sized extraction/.test(runDefault.stdout || ''), 'prints the plain-language recommendation');
// Keep the committed fixtures pristine.
try { rmSync(defaultOutDir, { recursive: true, force: true }); } catch { /* best-effort */ }

// --- --no-write PREVIEWS without touching disk. The documented preview flag must
//     (a) exit 0, (b) report a recommendation in-memory, (c) write NOTHING. ---
t.section('--no-write previews without writing');

const noWriteOutDir = mktmp('lite-e2e-nowrite-');
const runNoWrite = spawnSync(
  process.execPath,
  [CLI, 'lite', FIXTURES, '--output', 'grossIRR', '--use-case', 'one-off',
    '--out-dir', noWriteOutDir, '--no-write', '--format', 'json'],
  { encoding: 'utf-8' },
);
t.ok(runNoWrite.status === 0,
  `ete lite --no-write exits 0 (status=${runNoWrite.status}; stderr: ${(runNoWrite.stderr || '').slice(0, 200)})`);
let nwRes = null;
try { nwRes = JSON.parse(runNoWrite.stdout); } catch { /* asserted below */ }
t.ok(nwRes && Number.isInteger(nwRes.recommendedTier),
  '--no-write still reports a recommendation in-memory');
t.ok(nwRes && nwRes.artifactPath == null, '--no-write reports no artifactPath (preview only)');
t.ok(!existsSync(join(noWriteOutDir, 'lite-surrogate.params.json')),
  '--no-write writes NOTHING to the out-dir');

// --- INTEGRATOR / CONE LANE: app-integration carry is the documented Tier-2 cone
//     default. The no-Rust front door cannot BUILD a cone, so it ships a disclosed
//     surrogate — but it MUST honestly point the analyst at `ete init --emit-cones`
//     (the previously-dead Tier-2 branch). This is the integrator-honesty control. ---
t.section('Integrator cone lane is surfaced honestly (app-integration carry)');

const coneOutDir = mktmp('lite-e2e-cone-');
const runCone = spawnSync(
  process.execPath,
  [CLI, 'lite', FIXTURES, '--output', 'totalCarry', '--use-case', 'app-integration',
    '--out-dir', coneOutDir, '--format', 'json'],
  { encoding: 'utf-8' },
);
t.ok(runCone.status === 0,
  `ete lite app-integration exits 0 (status=${runCone.status}; stderr: ${(runCone.stderr || '').slice(0, 200)})`);
let coneRes = null;
try { coneRes = JSON.parse(runCone.stdout); } catch { /* asserted below */ }
if (coneRes) {
  t.ok(coneRes.persona === 'integrator', 'app-integration → integrator persona');
  t.ok(coneRes.coneRecommended === true,
    'the cone is recommended (the no-rust cap from the Tier-2 default is surfaced, not silently shipped)');
  const hasConeStep = (coneRes.nextSteps || []).some((s) => /--emit-cones/.test(s));
  t.ok(hasConeStep, 'a next step gives the EXACT cone command `ete init --emit-cones`');
  const hasNoRustDisclosure = (coneRes.disclosures || []).some((d) => /NO-RUST FALLBACK|cone/i.test(d));
  t.ok(hasNoRustDisclosure,
    'the recommender NO-RUST FALLBACK disclosure (cone was right-sized but Rust unavailable) reaches the analyst');
}

// ===========================================================================
// (2) KB-SIZED ARTIFACT + RUN FILE
// ===========================================================================
t.section('KB-sized artifact + run file');

let artifactPath = res && res.artifactPath;
let runFile = res && res.runFile;
t.ok(typeof artifactPath === 'string' && existsSync(artifactPath), 'artifact params file exists');
t.ok(typeof runFile === 'string' && existsSync(runFile), 'run file (lite-surrogate.run.mjs) exists');
if (artifactPath && existsSync(artifactPath)) {
  const bytes = statSync(artifactPath).size;
  t.ok(bytes < 64 * 1024, `artifact is KB-sized (< 64 KB; got ${bytes} bytes)`);
}

// ===========================================================================
// (3) BASE-CASE FIDELITY within the tier budget — NON-CIRCULAR.
//     Truth = the cascade base computed INDEPENDENTLY here, not read from the
//     artifact. The artifact must reproduce it (exactly, at the base point).
// ===========================================================================
t.section('Base-case fidelity (non-circular vs the cascade)');

if (artifactPath && existsSync(artifactPath)) {
  // Independent truth: rebuild the SAME no-Rust cascade and read its base grossIRR.
  const manifest = loadManifest(FIXTURES);
  const gt = loadGroundTruth(manifest, FIXTURES);
  const cascade = cascadeEvaluator(manifest, gt);
  const truthBaseIRR = cascade({}).returns.grossIRR;
  t.ok(Number.isFinite(truthBaseIRR), 'cascade base grossIRR is finite (independent truth)');

  const run = loadSurrogate(artifactPath);
  const reproduced = run({})['returns.grossIRR'];
  t.ok(typeof reproduced === 'number', 'artifact ships grossIRR as a NUMBER (not escalated)');
  // At the base point Δ=0 so the multiplicative surrogate is exact — reproduce to 1e-6.
  t.near(reproduced, truthBaseIRR, 1e-6, 'loadSurrogate().run({}) reproduces the cascade base within the Tier-1 budget');

  // The CLI reported a measured r² that clears the IRR floor (honest, not fabricated).
  const fid = res.fidelity && res.fidelity.grossIRR;
  t.ok(fid && typeof fid.rSquared === 'number' && fid.rSquared >= IRR_FLOOR,
    `reported grossIRR r² (${fid && fid.rSquared}) clears the IRR floor ${IRR_FLOOR}`);
}

// ===========================================================================
// (4) HANDOFF NAMES THE LEVERS — INTEGRATION.md in the out-dir names the scoped
//     lever, a per-output fidelity row, and the Escalated-outputs section.
// ===========================================================================
t.section('Handoff names the levers + fidelity + escalations');

const handoffPath = (res && res.handoffPath) || join(outDir1, 'INTEGRATION.md');
t.ok(existsSync(handoffPath), 'handoff INTEGRATION.md exists');
if (existsSync(handoffPath)) {
  const md = readFileSync(handoffPath, 'utf-8');
  t.ok(md.includes('exitMultiple'), 'handoff NAMES the scoped lever exitMultiple');
  t.ok(/grossIRR/.test(md) && /r2|r²/i.test(md), 'handoff has a per-output fidelity row for grossIRR');
  t.ok(/Escalated/i.test(md), 'handoff has the Escalated-outputs section');
}
// Cross-check via the lib API (independent of the CLI's rendering).
const doc = documentLiteArtifact(outDir1);
t.ok(doc.present, 'documentLiteArtifact detects the emitted artifact');
t.ok(Array.isArray(doc.summary.drivers) && doc.summary.drivers.includes('exitMultiple'),
  'documentLiteArtifact().summary.drivers includes exitMultiple');

// ===========================================================================
// (5) HONEST ESCALATION (NEGATIVE CONTROL) via the lib API on the synthetic
//     engine. A range crossing the MIP@1.5× kink → kinked money outputs escalate
//     (NOT shipped as numbers); a clean output ships. The SAME outputs ship clean
//     on a no-kink range — proving the gate is signal, not always-on.
// ===========================================================================
t.section('Honest escalation negative control (synthetic engine kink)');

const synEv = directEvaluator(computeModel);
const SYN_CLASSES = { 'returns.grossMOIC': 'moic', 'waterfall.gpCarry': 'carry', 'mip.payment': 'monetary' };
const SYN_KEYS = Object.keys(SYN_CLASSES);

// Independent truth from the synthetic engine itself: the MIP triggers at 1.5×, so
// sampling BELOW it (1.2×) leaves the piecewise region — gpCarry/mip kink.
const below = computeModel({ exitMultiple: 1.2 });
const above = computeModel({ exitMultiple: 2.0 });
t.ok(below.mip.triggered === false && above.mip.triggered === true,
  'synthetic MIP@1.5× kink is real (off below 1.5×, on at 2.0×) — independent truth');

// KINK RANGE (crosses 1.5×).
const kinkDir = mktmp('lite-e2e-kink-');
const kinkCand = { exitMultiple: { base: 2.0, min: 1.2, max: 2.4, steps: 13 } };
const kinkRes = emitSurrogate(synEv, kinkCand, {
  outDir: kinkDir, write: true, useCase: 'one-off', outputClasses: SYN_CLASSES, targetOutputKeys: SYN_KEYS,
});
t.ok(kinkRes.escalated.includes('waterfall.gpCarry'), 'kinked waterfall.gpCarry ESCALATES (not shipped)');
t.ok(kinkRes.escalated.includes('mip.payment'), 'kinked mip.payment ESCALATES (not shipped)');
t.ok(!kinkRes.escalated.includes('returns.grossMOIC'), 'clean returns.grossMOIC is NOT escalated');

// run() returns {escalated:true} for the kinked money output — NEVER a number.
const kinkRun = loadSurrogate(kinkRes.paramsPath);
const kinkOut = kinkRun({});
t.eq(kinkOut['waterfall.gpCarry'], { escalated: true, recommendedTier: 2 },
  'run() returns {escalated:true,recommendedTier:2} for the kinked output — never a fabricated number');
t.ok(typeof kinkOut['returns.grossMOIC'] === 'number', 'run() ships returns.grossMOIC as a number (clean)');

// CLEAN RANGE (entirely above the 1.5× kink) — the SAME outputs now ship clean +
// reproduce base exactly (grossMOIC is exactly proportional, r²=1.0).
const cleanDir = mktmp('lite-e2e-clean-');
const cleanCand = { exitMultiple: { base: 2.0, min: 1.6, max: 2.4, steps: 9 } };
const cleanRes = emitSurrogate(synEv, cleanCand, {
  outDir: cleanDir, write: true, useCase: 'one-off', outputClasses: SYN_CLASSES, targetOutputKeys: SYN_KEYS,
});
t.eqArr(cleanRes.escalated, [], 'on a no-kink range NOTHING escalates — the gate is signal, not always-on');
const cleanRun = loadSurrogate(cleanRes.paramsPath);
const cleanOut = cleanRun({});
// Independent truth: the engine's own base values (computed here, not read back).
const synBase = computeModel({ exitMultiple: 2.0 });
t.near(cleanOut['returns.grossMOIC'], synBase.returns.grossMOIC, 1e-6,
  'clean grossMOIC reproduces the engine base exactly');
t.near(cleanOut['waterfall.gpCarry'], synBase.waterfall.gpCarry, 1e-6,
  'clean gpCarry reproduces the engine base exactly (ships above the kink)');

// ===========================================================================
// (6) REFUSE-ON-MISMATCH (MUTATION GUARD) — tamper a shipped beta in the emitted
//     artifact; loadSurrogate must THROW on the gateHash re-derivation.
// ===========================================================================
t.section('Refuse-on-mismatch (mutation guard)');

t.mutationGuard('surrogate tamper (flipped beta) is refused on load', () => {
  // Clone the CLEAN emitted params (a real, on-disk artifact), flip a shipped beta,
  // write to a temp path, and assert the loader throws. clone() never touches the
  // committed fixture or the real artifact.
  const params = clone(JSON.parse(readFileSync(cleanRes.paramsPath, 'utf-8')));
  const target = params.perTarget['returns.grossMOIC'];
  if (target && target.coeffs && target.coeffs.betas) {
    const k = Object.keys(target.coeffs.betas)[0];
    target.coeffs.betas[k] = target.coeffs.betas[k] + 0.5; // material value tamper
  } else {
    return false; // no shipped beta to tamper — guard cannot run
  }
  const tamperedPath = join(cleanDir, 'tampered.params.json');
  writeFileSync(tamperedPath, JSON.stringify(params, null, 2));
  return t.throws(() => loadSurrogate(tamperedPath), /tampered|stale|mismatch/i,
    'loadSurrogate refuses a tampered artifact');
});

// ===========================================================================
cleanup();
t.done();

/**
 * ete lite — ADR-027 Lite Package, the FRONT DOOR (Phase 7).
 *
 * The capstone that lets a NON-TECHNICAL analyst point a coding agent at a
 * converted model and get a RIGHT-SIZED, KB-sized extraction — no Rust, no
 * network. It answers the three front-door questions (1 what model? 2 what target
 * output? 3 what use case?) and the hidden 4th the agent answers by inspection
 * (can we re-evaluate with no Rust? — yes, via the delta-cascade), then:
 *
 *   (a) maps the requested output NAMES (grossIRR, totalCarry, …) to the grouped
 *       evaluator keys + their output classes (drives the r² floor);
 *   (b) builds a NO-RUST cascadeEvaluator over the manifest + ground truth;
 *   (c) derives candidate input levers from the manifest (exitMultiple range,
 *       optional exitYear) — a sane default the cascade understands;
 *   (d) recommendTier(...) for the persona / tier / precision budget;
 *   (e) selectDrivers(...) to scope the levers per target;
 *   (f) EMITS the artifact for the chosen tier. `ete lite` is the NO-RUST front
 *       door, so the recommender (called with rustAvailable:false) only ever
 *       returns Tier 0 or 1 as a BASE — Tier 2/3 are never auto-built here, only
 *       ESCALATED to (with the build command):
 *        Tier 0 → try emitTier0; on its single-fixture layout-guard THROW
 *                 (any non-GPP-Promote model, incl. these fixtures whose carry
 *                 sheet is 'GP Promote') FALL BACK to Tier 1 with a clear note;
 *        Tier 1 → emitSurrogate (honesty-gated; some outputs may escalate);
 *        Cone (Tier 2) → recommended (NOT built) with the exact command
 *                 `ete init --emit-cones` (EXPERIMENTAL) whenever EITHER a measured
 *                 per-output escalation fires (kink / below-floor) OR the recommender
 *                 capped DOWN from the cone (no-rust-cap / r2-floor: the cone was the
 *                 right-sized artifact but Rust is unavailable). The recommender's
 *                 class-specific disclosures are surfaced, never dropped.
 *   (g) writes a HANDOFF: emitIntegrationDoc when engine.js is co-located (it
 *       appends the lite section), AND a standalone INTEGRATION.md from
 *       documentLiteArtifact(outDir) so the handoff names the levers / fidelity /
 *       escalations regardless of engine.js presence.
 *
 * HONESTY: an escalated output (kink / below-floor) is reported as
 * {escalated:true, recommendedTier:2} — NEVER a fabricated number. The plain-
 * language summary points the analyst at the cone for those, and the recommender's
 * disclosures (e.g. "carry surrogate below floor", "NO-RUST FALLBACK") are surfaced.
 *
 * Purely additive: returns a result object ({ error } on failure); the index.mjs
 * harness applies --compact/--format. runLite is SYNC (matches the runX contract).
 *
 * @license MIT
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import { resolveModelDir, loadManifest, loadGroundTruth } from '../../lib/manifest.mjs';
import { cascadeEvaluator } from '../../lib/lite-evaluators.mjs';
import { recommendTier, USE_CASES, R2_FLOORS } from '../../lib/tier-recommender.mjs';
import { selectDrivers } from '../../lib/driver-scope.mjs';
import { emitTier0 } from '../../lib/lite-tier0.mjs';
import { emitSurrogate } from '../../lib/lite-surrogate.mjs';
import { documentLiteArtifact } from '../../lib/lite-provenance.mjs';
import { emitIntegrationDoc } from '../../lib/integration-doc.mjs';

// ---------------------------------------------------------------------------
// Output NAME → grouped key + output class. Mirrors DEFAULT_CASCADE_MAPPING in
// lib/lite-evaluators.mjs (keep in LOCKSTEP — a drift silently scopes the wrong
// key). The analyst types a friendly name (grossIRR); we resolve it to the
// grouped evaluator key the cascade emits (returns.grossIRR) + its class.
// ---------------------------------------------------------------------------
const NAME_TO_GROUPED = Object.freeze({
  grossIRR: { key: 'returns.grossIRR', class: 'irr' },
  netIRR: { key: 'returns.netIRR', class: 'irr' },
  grossMOIC: { key: 'returns.grossMOIC', class: 'moic' },
  netMOIC: { key: 'returns.netMOIC', class: 'moic' },
  totalCarry: { key: 'waterfall.totalCarry', class: 'carry' },
  terminalValue: { key: 'exitValuation.terminalValue', class: 'monetary' },
  exitEquity: { key: 'exitValuation.exitEquity', class: 'monetary' },
  exitEBITDA: { key: 'exitValuation.exitEBITDA', class: 'monetary' },
  price: { key: 'perShare.price', class: 'monetary' },
});

/** Tightest r² floor wins → the governing class drives the precision budget. */
const CLASS_RANK = Object.freeze({ monetary: 4, carry: 4, mip: 4, irr: 2, moic: 2, pnl: 2, other: 1 });

/**
 * Parse the comma-list --output flag into requested output names. Accepts a
 * string ("grossIRR,totalCarry"), a single name, or the array the arg parser
 * produces from repeated --output flags. Defaults to ['grossIRR'].
 */
function parseOutputNames(raw) {
  if (raw == null || raw === true) return ['grossIRR'];
  const list = Array.isArray(raw) ? raw : [raw];
  const names = list
    .flatMap((s) => String(s).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length ? names : ['grossIRR'];
}

/**
 * Parse --output-class overrides ("grossIRR:irr,totalCarry:monetary") into a
 * { name: class } map. Accepts a string or an array (repeated flags).
 */
function parseClassOverrides(raw) {
  const out = {};
  if (raw == null || raw === true) return out;
  const list = Array.isArray(raw) ? raw : [raw];
  for (const item of list.flatMap((s) => String(s).split(','))) {
    const [name, cls] = item.split(':').map((s) => (s || '').trim());
    if (name && cls) out[name] = cls;
  }
  return out;
}

/**
 * Derive the candidate input levers from the manifest, falling back to a sane
 * default scalar set the cascade understands (KNOWN_SCALAR_ADJUSTMENTS).
 *
 * The PRIMARY lever is exitMultiple { base, min:base*0.75, max:base*1.2,
 * steps:9 } — the single dominant driver of returns on a buyout/promote model,
 * and a clean single-axis sweep (so a 0.97-floor IRR/MOIC output can ship
 * clean). exitYear is included ONLY when --with-exit-year is set: adding it as a
 * second candidate makes the selector pick BOTH axes for a return output, and an
 * INDEPENDENT one-at-a-time multiplicative fit has no interaction term, so the
 * joint fit drops below the IRR/MOIC floor and the output false-escalates
 * (driver-scope's documented off-axis limitation). Keeping a single dominant
 * lever by default is the honest, right-sized choice; the caller can opt into
 * the wider scope. Ranges sit within/above the smooth region; the kink gate
 * handles any breakpoint honestly.
 *
 * @param {Object} manifest
 * @param {Object} [opts]
 * @param {boolean} [opts.withExitYear=false]
 */
function deriveCandidateInputs(manifest, opts = {}) {
  const candidate = {};
  const emBase =
    (typeof manifest.baseCaseOutputs?.exitMultiple === 'number' && manifest.baseCaseOutputs.exitMultiple) ||
    (typeof manifest.outputs?.exitMultiple?.base === 'number' && manifest.outputs.exitMultiple.base) ||
    18.5;
  candidate.exitMultiple = {
    base: emBase,
    min: +(emBase * 0.75).toFixed(6),
    max: +(emBase * 1.2).toFixed(6),
    steps: 9,
  };

  const range = manifest.timeline?.exitYearRange;
  const exitYear = manifest.timeline?.exitYear;
  if (opts.withExitYear &&
      Array.isArray(range) && range.length === 2 &&
      typeof range[0] === 'number' && typeof range[1] === 'number' && range[1] > range[0]) {
    const base = typeof exitYear === 'number' ? exitYear : Math.round((range[0] + range[1]) / 2);
    candidate.exitYear = { base, min: range[0], max: range[1], steps: (range[1] - range[0]) + 1 };
  }
  return candidate;
}

/**
 * Run the lite front door.
 *
 * @param {string} modelDir - the model dir (or its chunked/ subdir)
 * @param {Object} args - parsed CLI flags
 * @returns {Object} result object (or { error })
 */
export function runLite(modelDir, args = {}) {
  if (!modelDir) {
    return { error: 'lite: missing model dir. Usage: ete lite <dir> --output grossIRR,totalCarry --use-case one-off' };
  }

  // --- dir resolve + load (no Rust). loadManifest/loadGroundTruth handle the
  //     chunked/ fallback; the fixtures have manifest.json at the top level. ---
  const resolvedDir = resolveModelDir(modelDir);
  let manifest;
  let gt;
  try {
    manifest = loadManifest(resolvedDir);
    gt = loadGroundTruth(manifest, resolvedDir);
  } catch (err) {
    return { error: err.message };
  }

  // --- flags ---
  const useCase = typeof args.useCase === 'string' && USE_CASES.includes(args.useCase) ? args.useCase : 'one-off';
  if (typeof args.useCase === 'string' && !USE_CASES.includes(args.useCase)) {
    return { error: `lite: unknown --use-case '${args.useCase}'. Expected one of ${USE_CASES.join(', ')}.` };
  }
  // --no-write parses to args.noWrite (the arg parser camelCases the negative
  // flag); --write false / --write=false also disable. Honor BOTH so the
  // documented preview flag actually previews (no disk writes).
  const write =
    args.write !== false &&
    args.write !== 'false' &&
    args.noWrite !== true &&
    args.noWrite !== 'true';
  const outDir = (typeof args.outDir === 'string' && args.outDir) || join(resolvedDir, 'lite-out');
  const requestedNames = parseOutputNames(args.output);
  const classOverrides = parseClassOverrides(args.outputClass);

  // --- (a) map requested output NAMES → grouped keys + output classes ---
  const unknownNames = [];
  const targetOutputKeys = [];
  const outputClasses = {};
  const nameByKey = {};
  for (const name of requestedNames) {
    const m = NAME_TO_GROUPED[name];
    if (!m) { unknownNames.push(name); continue; }
    targetOutputKeys.push(m.key);
    outputClasses[m.key] = classOverrides[name] || m.class;
    nameByKey[m.key] = name;
  }
  if (targetOutputKeys.length === 0) {
    return {
      error:
        `lite: no recognized --output names (${requestedNames.join(', ')}). ` +
        `Known names: ${Object.keys(NAME_TO_GROUPED).join(', ')}.`,
    };
  }

  // governing output class (tightest r² floor) for the recommender.
  const governingClass = Object.values(outputClasses).reduce(
    (best, c) => ((CLASS_RANK[c] || 0) > (CLASS_RANK[best] || 0) ? c : best),
    Object.values(outputClasses)[0],
  );

  // --- (b) cascadeEvaluator — NO Rust ---
  const evaluator = cascadeEvaluator(manifest, gt);

  // --- (c) candidate input levers ---
  const withExitYear = args.withExitYear === true || args.withExitYear === 'true';
  const candidateInputs = deriveCandidateInputs(manifest, { withExitYear });

  // --- (d) scope the drivers FIRST (per-target class floors) so the recommender
  //     gets a REAL breakpoint signal instead of guessing. selectDrivers runs
  //     detectBreakpoints over the actual swept range — it is the kink authority. ---
  const classFloors = {};
  for (const k of targetOutputKeys) classFloors[k] = floorForClass(outputClasses[k]);
  const scope = selectDrivers(evaluator, candidateInputs, {
    perTargetThreshold: classFloors,
    targetOutputKeys,
  });
  // Any requested output with a detected kink in its swept range. Feeding this to
  // the recommender makes its kink gate accurate (a kinked money output escalates
  // to the cone HERE, not only later at surrogate-emit) and suppresses the
  // "breakpoint check not run" disclosure that would otherwise fire on a clean,
  // already-checked output.
  const hasBreakpointInRange = Object.values(scope.perTarget).some((t) => t.breakpoint === true);

  // --- (e) recommend the tier / persona / precision budget, kink-aware ---
  const rec = recommendTier({
    targetOutputs: { class: governingClass, names: requestedNames },
    useCase,
    // lite default: no Rust (the no-Rust front door); selectDrivers (above) is the
    // kink source of truth and now feeds the recommender directly.
    modelTraits: { rustAvailable: false, hasBreakpointInRange },
  });

  // The recommender's own honesty signals. With the no-Rust front door
  // (rustAvailable:false) the recommender can only return Tier 0/1 — but when the
  // RIGHT-SIZED artifact was actually the cone (Tier 2) it records a `no-rust-cap`
  // or `r2-floor` escalation and a loud disclosure. Surface those so the analyst
  // is pointed at the cone instead of silently shipping a downgraded surrogate.
  const recCappedFromCone = rec.escalations.some(
    (e) => e.rule === 'no-rust-cap' || e.rule === 'r2-floor',
  );
  const recDisclosures = (rec.precisionBudget && rec.precisionBudget.disclosures) || [];

  // --- (f) emit the artifact for the chosen tier ---
  const result = {
    recommendedTier: rec.tier,
    persona: rec.persona,
    rationale: rec.rationale,
    drivers: scope.drivers,
    artifactPath: null,
    runFile: null,
    fidelity: {},
    escalations: [],
    // The recommender's structured class-specific honesty notes (kept distinct
    // from the per-output MEASURED escalations below) — never silently dropped.
    disclosures: recDisclosures,
    handoffPath: null,
    nextSteps: [],
  };

  // Ensure the out-dir exists BEFORE any emit — emitTier0/emitSurrogate
  // writeFileSync into outDir but do NOT create it, so the default
  // `<dir>/lite-out` (and any not-yet-existing --out-dir) would otherwise crash
  // with a raw ENOENT. Guarded by `write` so --no-write never touches disk.
  if (write) {
    try {
      mkdirSync(outDir, { recursive: true });
    } catch (err) {
      return { error: `lite: could not create output dir '${posix(outDir)}': ${err.message}` };
    }
  }

  let emittedArtifact = false;
  let tier0FellBackToTier1 = false;

  // Tier 0 → try the closed-form; fall back to Tier 1 on the layout guard throw.
  if (rec.tier === 0) {
    try {
      const t0 = emitTier0(resolvedDir, { write, outDir });
      result.artifactPath = t0.paramsPath || null;
      result.runFile = t0.runPath || null;
      emittedArtifact = true;
      result.recommendedTier = 0;
    } catch (err) {
      tier0FellBackToTier1 = true;
      result.tier0FellBackToTier1 = true;
      result.tier0FallbackReason = err.message;
      result.recommendedTier = 1; // we ship a Tier-1 surrogate instead
    }
  }

  // Tier 1 (recommended OR fallen-back-to) → surrogate.
  if (rec.tier === 1 || tier0FellBackToTier1) {
    const sur = emitSurrogate(evaluator, candidateInputs, {
      outDir, write, useCase, outputClasses, targetOutputKeys,
      chunkedDir: resolvedDir, manifest,
    });
    result.artifactPath = sur.paramsPath || null;
    result.runFile = sur.runPath || null;
    result.drivers = scope.drivers;
    emittedArtifact = true;
    result.recommendedTier = 1;

    // Per-output fidelity + escalations from the MEASURED surrogate (never fabricated).
    for (const [key, tEntry] of Object.entries(sur.perTarget)) {
      const friendly = nameByKey[key] || key;
      if (tEntry.escalateTier2) {
        result.escalations.push({
          output: friendly,
          key,
          escalated: true,
          recommendedTier: tEntry.recommendedTier ?? 2,
          reason: tEntry.reason || 'escalated to Tier 2 (cone) — see surrogate honesty gate',
        });
        // HONEST: an escalated output reports {escalated:true}, NOT a number.
        result.fidelity[friendly] = { escalated: true, recommendedTier: tEntry.recommendedTier ?? 2 };
      } else {
        result.fidelity[friendly] = {
          rSquared: tEntry.rSquared,
          maxResidual: tEntry.maxResidual,
          classFloor: tEntry.classFloor,
          offAxisUnverified: !!tEntry.offAxisUnverified,
          ...(tEntry.disclosure ? { byRequestDisclosure: tEntry.disclosure } : {}),
        };
      }
    }
  }

  // The cone pointer. `ete lite` is the NO-RUST front door, so the recommender
  // never returns Tier 2/3 as a base here — but a cone escalation can arrive two
  // honest ways, and BOTH must tell the analyst exactly how to get the exact
  // answer (a per-output escalation that says "use the cone" with no command is
  // not actionable):
  //   1. a MEASURED per-output escalation above (a kink / below-floor money output
  //      the surrogate refused to ship); OR
  //   2. the recommender CAPPED DOWN from the cone (no-rust-cap / r2-floor): the
  //      right-sized artifact was the Tier-2 cone but Rust is unavailable, so it
  //      shipped a disclosed surrogate instead.
  // Either way the EXACT answer is the scoped cone — surface the one command that
  // builds it. (Tier 2/3 are never a *base* recommendation in the no-Rust front
  // door; the cone is only ever an ESCALATION target, never silently shipped.)
  const coneEscalated = result.escalations.some((e) => (e.recommendedTier ?? 2) >= 2);
  if (coneEscalated || recCappedFromCone) {
    const escNames = result.escalations.map((e) => e.output);
    const which = escNames.length
      ? `output(s) ${escNames.join(', ')}`
      : `output class '${governingClass}' (r² floor ${floorForClass(governingClass)})`;
    result.coneRecommended = true;
    result.nextSteps.push(
      `For the EXACT answer on ${which}, build the scoped cone: ` +
      `\`ete init <model>.xlsx --emit-cones\` (EXPERIMENTAL; needs the Rust transpiler + a ` +
      `~minutes / ~16 GB build; runtime is ms). The cone is 1e-6 over the lever ranges — ` +
      `\`ete lite\` does NOT build it because it is the no-Rust front door.`,
    );
  }

  // The recommender's disclosures describe the tier IT picked (rec.tier). When a
  // Tier-0 recommendation FELL BACK to a Tier-1 surrogate, the Tier-0-specific
  // "closed-form calibrated at base" note describes an artifact we did NOT ship —
  // drop it so the disclosures match what's actually on disk. (The standing
  // Honesty footer + per-output fidelity already cover the Tier-1 surrogate.)
  if (tier0FellBackToTier1) {
    result.disclosures = result.disclosures.filter((d) => !/^Tier-0 closed-form is calibrated/.test(d));
  }

  // --- (g) handoff. If engine.js is co-located, emitIntegrationDoc appends the
  //     lite section; the fixtures dir has NO engine.js → it skips, so ALSO write
  //     a standalone INTEGRATION.md from documentLiteArtifact(outDir). ---
  if (emittedArtifact && write) {
    try {
      const idoc = emitIntegrationDoc(resolvedDir);
      if (idoc && Array.isArray(idoc.written) && idoc.written.includes('INTEGRATION.md')) {
        result.handoffPath = join(resolvedDir, 'INTEGRATION.md');
      }
    } catch { /* best-effort: a missing/odd engine dir must not break the handoff */ }

    // Standalone handoff in the out-dir — guarantees a doc that names the levers
    // / per-output fidelity / escalations regardless of engine.js presence.
    try {
      const doc = documentLiteArtifact(outDir);
      if (doc.present) {
        const standalone = join(outDir, 'INTEGRATION.md');
        writeFileSync(standalone, doc.markdown);
        if (!result.handoffPath) result.handoffPath = standalone;
        result.handoffSummary = doc.summary;
      }
    } catch { /* best-effort */ }
  }

  // friendly NAME → the grouped key run() actually returns (returns.grossIRR,
  // waterfall.totalCarry, …) + the per-output class. Surfaced so a non-technical
  // reader who calls run() themselves can connect the key they SEE to the name
  // they TYPED, and the header can label each output with its own class.
  const keyByName = {};
  const classByName = {};
  for (const k of targetOutputKeys) {
    const friendly = nameByKey[k];
    keyByName[friendly] = k;
    classByName[friendly] = outputClasses[k];
  }

  // --- next steps + plain-language summary ---
  if (result.runFile) {
    // Name the exact key run() returns next to the friendly name the analyst typed
    // (the run() shim returns grouped keys, e.g. { "returns.grossIRR": … }).
    const sampleName = requestedNames.find((n) => keyByName[n]) || requestedNames[0];
    const sampleKey = keyByName[sampleName];
    const keyHint = sampleKey
      ? ` run({}) returns { "${sampleKey}": … } (your ${sampleName}).`
      : '';
    result.nextSteps.unshift(
      `Run the artifact: \`import run from "${posix(result.runFile)}"\` — call run({}) for the base case, ` +
      `run({ exitMultiple: <n> }) for a what-if.${keyHint}`,
    );
  }
  if (result.handoffPath) {
    result.nextSteps.push(
      `Hand the artifact + ${posix(result.handoffPath)} to a coding agent — the handoff names the levers, per-output fidelity, and any escalations.`,
    );
  }

  result._formatted = formatLite(result, { useCase, requestedNames, candidateInputs, governingClass, classByName, keyByName });
  if (args.format === 'json') {
    const { _formatted, ...data } = result;
    result._formatted = JSON.stringify(data, null, 2);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// SINGLE SOURCE OF TRUTH for the r² floors — import the canonical R2_FLOORS from
// the recommender rather than hand-copying the table (a silent drift would scope
// the wrong floor / mislabel fidelity).
function floorForClass(c) { return R2_FLOORS[c] ?? R2_FLOORS.other; }

/** Normalize Windows backslashes to forward slashes for human-readable paths. */
function posix(p) { return typeof p === 'string' ? p.split('\\').join('/') : p; }

/**
 * Plain-language analyst-facing summary (table mode). The reader is a finance
 * person, not a programmer — say what was right-sized, what ships, and what
 * escalates (honestly), and how to hand it off.
 */
function formatLite(r, { useCase, requestedNames, candidateInputs, governingClass, classByName = {}, keyByName = {} }) {
  const TIER_NAME = { 0: 'closed-form', 1: 'surrogate', 2: 'scoped cone', 3: 'full engine' };
  const L = [];
  L.push(`Right-sized extraction → Tier ${r.recommendedTier} (${TIER_NAME[r.recommendedTier] || '?'})`);
  // Label EACH output with its OWN class (grossIRR is irr, totalCarry is carry) —
  // showing only the single governing class mislabels the looser outputs.
  const outLabels = requestedNames
    .map((n) => (classByName[n] ? `${n} (${classByName[n]})` : n))
    .join(', ');
  L.push(`Persona: ${r.persona}  |  Use case: ${useCase}  |  Outputs: ${outLabels}`);
  L.push('');

  if (r.tier0FellBackToTier1) {
    L.push('Note: a Tier-0 closed-form was the cheapest fit, but this model is not the single');
    L.push('layout the closed-form supports, so it fell back to a Tier-1 surrogate. Reason:');
    L.push(`  ${truncate(r.tier0FallbackReason, 220)}`);
    L.push('');
  }

  L.push(`Rationale: ${r.rationale}`);
  L.push('');

  L.push(`Levers that move your number(s): ${r.drivers.length ? r.drivers.join(', ') : '(none scoped)'}`);
  const em = candidateInputs.exitMultiple;
  if (em) L.push(`  exitMultiple swept ${em.min}–${em.max} (base ${em.base}, ${em.steps} steps)`);
  L.push('');

  if (r.artifactPath) {
    L.push(`Artifact (KB-sized): ${posix(r.artifactPath)}`);
    if (r.runFile) L.push(`Run file:           ${posix(r.runFile)}`);
    L.push('');
  }

  // Fidelity table — honest about what ships vs escalates.
  const fidKeys = Object.keys(r.fidelity);
  if (fidKeys.length) {
    L.push('Fidelity (per output):');
    for (const name of fidKeys) {
      const f = r.fidelity[name];
      if (f.escalated) {
        L.push(`  ${pad(name, 16)} ESCALATED → Tier ${f.recommendedTier} (use the cone/full engine; NOT shipped as a number)`);
      } else {
        const r2 = typeof f.rSquared === 'number' ? f.rSquared.toFixed(4) : 'n/a';
        const off = f.offAxisUnverified ? '  [off-axis unverified — multi-driver]' : '';
        const byreq = f.byRequestDisclosure ? '  [BY-REQUEST below floor — indicative only]' : '';
        L.push(`  ${pad(name, 16)} r²=${r2} (floor ${f.classFloor})${off}${byreq}`);
      }
    }
    L.push('');
  }

  if (r.escalations.length) {
    // Lead the analyst with the plain consequence, then the WHY as a parenthetical.
    L.push('Escalated outputs — NOT shipped as a number (build the cone for the exact answer):');
    for (const e of r.escalations) {
      L.push(`  - ${e.output}: this output is below the safe fit, so it is NOT shipped.`);
      L.push(`      why: ${truncate(e.reason, 220)}`);
    }
    L.push('');
  } else if (r.coneRecommended && r.artifactPath) {
    // The surrogate SHIPPED a number, but the recommender flagged that the cone was
    // the right-sized artifact (a money-grade class below the surrogate floor).
    L.push('Heads-up: a shipped surrogate output is a money-grade class that really wants the');
    L.push('cone for an exact answer (see disclosures + next steps). The surrogate is indicative.');
    L.push('');
  } else if (r.recommendedTier <= 1 && r.artifactPath) {
    L.push('No escalations — every requested output ships clean in the artifact.');
    L.push('');
  }

  // Recommender honesty notes (class-specific: "below floor", "breakpoint check not
  // run", "no-rust cone fallback"). These are the recommender's structured signals,
  // distinct from the per-output measured fidelity above — surface them, never drop.
  if (Array.isArray(r.disclosures) && r.disclosures.length) {
    L.push('Disclosures (read before any money decision):');
    for (const d of r.disclosures) L.push(`  - ${truncate(d, 260)}`);
    L.push('');
  }

  if (r.handoffPath) L.push(`Handoff: ${posix(r.handoffPath)}`);
  if (r.nextSteps.length) {
    L.push('');
    L.push('Next steps:');
    for (const s of r.nextSteps) L.push(`  - ${s}`);
  }

  L.push('');
  L.push('Honesty: a Tier-1 surrogate r² is fit-to-cascade (the no-Rust sampler), not');
  L.push('fit-to-the-real-model — spot-check against the engine where you can. A kinked or');
  L.push('below-floor money output (carry near a hurdle, a MIP near its threshold) escalates');
  L.push('to the cone and is NOT shipped as a confident number.');

  return L.join('\n');
}

function pad(s, w) { s = String(s); return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function truncate(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

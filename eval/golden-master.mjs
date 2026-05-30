#!/usr/bin/env node
/**
 * golden-master.mjs — Post-build golden-master gate for a chunked engine.
 *
 * Two assertions, both meant to run against a build that `ete init` already
 * produced (it emits the `named-outputs.json` this reads):
 *
 *   1. --assert-no-fallbacks — no RETURN / MIP / value-bearing output resolves
 *      through an unsupported-function (`_fn`) stub. `ete init` annotates each
 *      such output with `resolvesThroughFallback`; this gate fails the build if
 *      any return/value output carries that flag. (The build-time
 *      `ete init --assert-no-fallbacks` is the same gate at emit time; this is
 *      the standalone post-build / CI form.)
 *
 *   2. baseCaseValue precision diff — every output named in a canonical returns
 *      file matches the engine's emitted `baseCaseValue` to full float precision
 *      (`Object.is`, or within `--epsilon` relative error). This is the
 *      golden-master: a regenerated model's gross/net MOIC & IRR (and any other
 *      canonical figure) must equal the hand-port's authoritative numbers.
 *
 *      The canonical figures are PER-MODEL and PROPRIETARY — keep the canonical
 *      file gitignored (e.g. alongside the gitignored engine). It is NEVER
 *      committed to this public repo. CI exercises the *mechanism* on a
 *      synthetic fixture (tests/cli/test-golden-master.mjs); a local run points
 *      `--canonical` at the real model's gitignored figures.
 *
 * Usage:
 *   node eval/golden-master.mjs <chunkedDir> [--canonical <file>] \
 *        [--assert-no-fallbacks] [--all-outputs] [--epsilon <n>] [--json]
 *
 * Options:
 *   --canonical <file>     Canonical baseCaseValue map { outputName: number }.
 *                          Defaults to <chunkedDir>/canonical-returns.json if present.
 *   --assert-no-fallbacks  Fail if any return/value output resolves through a stub.
 *   --all-outputs          Widen the fallback check from returns to ALL outputs.
 *   --epsilon <n>          Relative tolerance for the canonical diff (default 0 = exact).
 *   --json                 Emit a JSON report instead of human-readable text.
 *
 * Exit codes:
 *   0 = passed, or gracefully skipped (no dir / no named-outputs / no canonical)
 *   1 = a fallback violation or a baseCaseValue mismatch
 *   2 = usage error
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Outputs that must never resolve through a stub or drift: returns, MIP /
// promote economics, and the value-bearing #25 cells (proceeds, hurdle,
// participation, equity basis, valuation / shares).
const RETURN_KEY = /moic|irr|carry|promote|mip|proceeds|tvpi|dpi|hurdle|threshold|participation|terminalvalue|equitybasis|valuation|shares|nav/i;

/** Read chunked/named-outputs.json; returns the parsed `namedOutputs` map or null. */
export function loadNamedOutputs(chunkedDir) {
  const p = join(chunkedDir, 'named-outputs.json');
  if (!existsSync(p)) return null;
  const doc = JSON.parse(readFileSync(p, 'utf-8'));
  return doc.namedOutputs || null;
}

/**
 * Outputs whose dependency closure passes through an `_fn()` stub, as annotated
 * by `ete init` (`resolvesThroughFallback`). Restricted to return/value outputs
 * unless `allOutputs` is set.
 */
export function fallbackViolations(namedOutputs, { allOutputs = false } = {}) {
  const out = [];
  for (const [name, o] of Object.entries(namedOutputs || {})) {
    if (!o || !o.resolvesThroughFallback) continue;
    if (!allOutputs && !RETURN_KEY.test(name)) continue;
    out.push({ output: name, ...o.resolvesThroughFallback });
  }
  return out;
}

/**
 * Diff named-output baseCaseValues against a canonical map. With `epsilon === 0`
 * the match is exact (`Object.is`, so NaN≠number and -0≠0 are caught); a
 * positive epsilon allows |actual-expected| <= epsilon*|expected| relative error.
 * A canonical key with no corresponding output is a mismatch (actual: null).
 */
export function baseCaseMismatches(namedOutputs, canonical, { epsilon = 0 } = {}) {
  const out = [];
  for (const [key, expected] of Object.entries(canonical || {})) {
    if (key.startsWith('_')) continue; // comment keys (e.g. "_comment")
    const o = namedOutputs?.[key];
    const actual = o ? o.baseCaseValue : undefined;
    let ok;
    if (epsilon > 0 && typeof actual === 'number' && typeof expected === 'number') {
      const denom = Math.abs(expected) || 1;
      ok = Math.abs(actual - expected) <= epsilon * denom;
    } else {
      ok = Object.is(actual, expected);
    }
    if (!ok) out.push({ key, expected, actual: actual === undefined ? null : actual });
  }
  return out;
}

/**
 * Run the golden-master gate against a chunked dir. Returns a result object;
 * never throws on a missing dir/artifact (returns `{ skipped }` instead) so the
 * CI step passes cleanly when the proprietary model isn't present.
 */
export function runGoldenMaster(chunkedDir, opts = {}) {
  if (!chunkedDir || !existsSync(chunkedDir)) {
    return { ok: true, skipped: true, reason: `no chunked dir: ${chunkedDir || '(none)'}` };
  }
  const namedOutputs = loadNamedOutputs(chunkedDir);
  if (!namedOutputs) {
    return { ok: true, skipped: true, reason: `no named-outputs.json in ${chunkedDir} (run \`ete init\` first)` };
  }

  const result = { ok: true, skipped: false, chunkedDir, fallbackViolations: [], mismatches: [] };

  if (opts.assertNoFallbacks) {
    result.fallbackViolations = fallbackViolations(namedOutputs, { allOutputs: opts.allOutputs });
    if (result.fallbackViolations.length > 0) result.ok = false;
  }

  const canonicalPath = opts.canonicalPath ||
    (existsSync(join(chunkedDir, 'canonical-returns.json')) ? join(chunkedDir, 'canonical-returns.json') : null);
  if (canonicalPath && existsSync(canonicalPath)) {
    const canonical = JSON.parse(readFileSync(canonicalPath, 'utf-8'));
    result.canonicalPath = canonicalPath;
    result.mismatches = baseCaseMismatches(namedOutputs, canonical, { epsilon: opts.epsilon || 0 });
    if (result.mismatches.length > 0) result.ok = false;
  } else {
    result.canonicalSkipped = true;
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set(['--canonical', '--epsilon']);

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { chunkedDir: undefined, canonicalPath: undefined, assertNoFallbacks: false, allOutputs: false, epsilon: 0, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--canonical') { out.canonicalPath = args[++i]; }
    else if (a === '--epsilon') { out.epsilon = Number(args[++i]); }
    else if (a === '--assert-no-fallbacks') { out.assertNoFallbacks = true; }
    else if (a === '--all-outputs') { out.allOutputs = true; }
    else if (a === '--json') { out.json = true; }
    else if (!a.startsWith('--') && out.chunkedDir === undefined) { out.chunkedDir = a; }
  }
  return out;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.chunkedDir) {
    console.error('Usage: node eval/golden-master.mjs <chunkedDir> [--canonical <file>] [--assert-no-fallbacks] [--all-outputs] [--epsilon <n>] [--json]');
    process.exit(2);
  }

  const res = runGoldenMaster(opts.chunkedDir, opts);

  if (opts.json) {
    console.log(JSON.stringify(res, null, 2));
  } else if (res.skipped) {
    console.log(`golden-master: skipped — ${res.reason}`);
  } else {
    const lines = [`Golden-master gate: ${res.chunkedDir}`, '═'.repeat(50)];
    if (opts.assertNoFallbacks) {
      lines.push(res.fallbackViolations.length === 0
        ? '  ✓ no return/value output resolves through an _fn() stub'
        : `  ✗ ${res.fallbackViolations.length} return/value output(s) resolve through a stub:`);
      for (const v of res.fallbackViolations.slice(0, 10)) lines.push(`      ${v.output} ← ${v.cell} (${v.function})`);
    }
    if (res.canonicalSkipped) {
      lines.push('  • canonical diff skipped (no canonical-returns.json; pass --canonical to enable)');
    } else {
      lines.push(res.mismatches.length === 0
        ? `  ✓ all canonical baseCaseValues match to full float precision (${res.canonicalPath})`
        : `  ✗ ${res.mismatches.length} baseCaseValue mismatch(es):`);
      for (const m of res.mismatches.slice(0, 20)) lines.push(`      ${m.key}: expected ${m.expected}, got ${m.actual}`);
    }
    lines.push('', res.ok ? 'PASS' : 'FAIL');
    console.log(lines.join('\n'));
  }

  process.exit(res.ok ? 0 : 1);
}

// Run as CLI only when invoked directly (not when imported by the test suite).
import { fileURLToPath } from 'url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv);
}

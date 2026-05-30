#!/usr/bin/env node

/**
 * Golden-master gate tests (eval/golden-master.mjs).
 *
 * The real golden-master diffs a regenerated model's named-output baseCaseValues
 * (gross/net MOIC & IRR, …) against the hand-port's canonical figures to full
 * float precision, and asserts no return/value output resolves through an
 * unsupported-function (`_fn`) stub. Those canonical figures are proprietary and
 * gitignored — never committed here — so CI exercises the *mechanism* on the
 * synthetic committed fixture:
 *
 *   - clean build → no fallback violations, baseCaseValues match the snapshot
 *   - a stubbed output cell → --assert-no-fallbacks fails (the return resolves
 *     through a stub)
 *   - a drifted canonical value → the precision diff catches it (exact float),
 *     and --epsilon relaxes it
 *   - missing dir / artifacts → graceful skip (so CI passes without the model)
 *   - the CLI exits 0 on pass, 1 on fail
 *
 * A real local run is opt-in: set ETE_GOLDEN_DIR to a chunked dir that has a
 * (gitignored) canonical-returns.json and this suite runs the gate against it.
 */

import { readFileSync, existsSync, mkdtempSync, cpSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { emitManifestMaps } from '../../lib/manifest-maps.mjs';
import {
  runGoldenMaster, loadNamedOutputs, fallbackViolations, baseCaseMismatches,
} from '../../eval/golden-master.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');
const CANONICAL = join(FIXTURES, 'golden-master', 'expected-returns.json');
const GOLDEN_CLI = resolve(__dirname, '..', '..', 'eval', 'golden-master.mjs');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); }
}

/** Copy the base fixture into a fresh tmp dir and emit the contract maps. */
function buildFixture({ stub = false } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'ete-golden-'));
  cpSync(FIXTURES, tmp, { recursive: true });
  if (stub) {
    const sheetsDir = join(tmp, 'sheets');
    mkdirSync(sheetsDir, { recursive: true });
    // The fixture pins carry.totalCell → "GP Promote!D88"; stub that cell so the
    // totalCarry return output resolves through an unsupported-function stub.
    writeFileSync(join(sheetsDir, 'Promote.mjs'), `// mock
    ctx.set("GP Promote!D88", _fn('UNSUPPORTED_FN', []));
  `);
  }
  emitManifestMaps(tmp, {});
  return tmp;
}

// ---------------------------------------------------------------------------
console.log('Testing: clean build passes the golden-master gate');
{
  const tmp = buildFixture();
  const res = runGoldenMaster(tmp, { assertNoFallbacks: true, canonicalPath: CANONICAL });
  assert(res.ok === true, 'clean build passes');
  assert(res.skipped === false, 'clean build is not skipped');
  assert(res.fallbackViolations.length === 0, 'no fallback violations on a clean build');
  assert(res.mismatches.length === 0, `baseCaseValues match canonical snapshot (got ${JSON.stringify(res.mismatches)})`);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: --assert-no-fallbacks fails when a return resolves through a stub');
{
  const tmp = buildFixture({ stub: true });
  const no = loadNamedOutputs(tmp);
  assert(no.totalCarry?.resolvesThroughFallback?.function === 'UNSUPPORTED_FN',
    'totalCarry annotated with resolvesThroughFallback by ete init');

  const res = runGoldenMaster(tmp, { assertNoFallbacks: true, canonicalPath: CANONICAL });
  assert(res.ok === false, 'stubbed build fails the gate');
  assert(res.fallbackViolations.some(v => v.output === 'totalCarry' && v.cell === 'GP Promote!D88'),
    'totalCarry flagged as resolving through a stub');

  // Without --assert-no-fallbacks the gate ignores stubs (canonical diff only).
  const res2 = runGoldenMaster(tmp, { canonicalPath: CANONICAL });
  assert(res2.ok === true, 'stub ignored when --assert-no-fallbacks is off');
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: baseCaseValue diff is exact to full float precision');
{
  const tmp = buildFixture();
  const no = loadNamedOutputs(tmp);

  // A value off by 1e-9 is a mismatch under exact (full-precision) comparison...
  const drifted = { grossMOIC: 2.85 + 1e-9 };
  const exact = baseCaseMismatches(no, drifted);
  assert(exact.length === 1 && exact[0].key === 'grossMOIC', 'exact diff catches a 1e-9 drift');

  // ...but tolerated under an explicit relative epsilon.
  const loose = baseCaseMismatches(no, drifted, { epsilon: 1e-6 });
  assert(loose.length === 0, '--epsilon relaxes the precision match');

  // A canonical key with no emitted output is a mismatch (actual: null).
  const missing = baseCaseMismatches(no, { notAnOutput: 1.23 });
  assert(missing.length === 1 && missing[0].actual === null, 'missing output is a mismatch');

  // Comment keys are ignored.
  assert(baseCaseMismatches(no, { _comment: 'ignore me', grossMOIC: 2.85 }).length === 0,
    'underscore comment keys are skipped');
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: fallback check is scoped to returns unless --all-outputs');
{
  // A non-return output (e.g. a custom cell) carrying a stub is ignored by
  // default but caught with allOutputs.
  const no = {
    grossMOIC: { baseCaseValue: 2.85 },
    wacc: { baseCaseValue: 0.085, resolvesThroughFallback: { cell: 'V!K57', function: 'XNPV' } },
  };
  assert(fallbackViolations(no).length === 0, 'non-return stub ignored by default');
  assert(fallbackViolations(no, { allOutputs: true }).length === 1, 'caught with allOutputs');
}

console.log('Testing: graceful skip when the model/artifacts are absent');
{
  const skipDir = runGoldenMaster(join(tmpdir(), 'ete-golden-does-not-exist-xyz'), { assertNoFallbacks: true });
  assert(skipDir.skipped === true && skipDir.ok === true, 'missing dir → skipped, ok');

  const tmp = mkdtempSync(join(tmpdir(), 'ete-golden-empty-'));
  const skipNo = runGoldenMaster(tmp, { assertNoFallbacks: true });
  assert(skipNo.skipped === true && skipNo.ok === true, 'dir without named-outputs → skipped, ok');
  rmSync(tmp, { recursive: true, force: true });
}

console.log('Testing: CLI exit codes (0 pass / 1 fail)');
{
  const clean = buildFixture();
  const okRun = spawnSync(process.execPath, [GOLDEN_CLI, clean, '--assert-no-fallbacks', '--canonical', CANONICAL], { encoding: 'utf-8' });
  assert(okRun.status === 0, `CLI exits 0 on a clean build (got ${okRun.status})`);
  rmSync(clean, { recursive: true, force: true });

  const stubbed = buildFixture({ stub: true });
  const failRun = spawnSync(process.execPath, [GOLDEN_CLI, stubbed, '--assert-no-fallbacks', '--canonical', CANONICAL], { encoding: 'utf-8' });
  assert(failRun.status === 1, `CLI exits 1 when a return resolves through a stub (got ${failRun.status})`);
  assert(/resolve through a stub/.test(failRun.stdout), 'CLI reports the stub violation');
  rmSync(stubbed, { recursive: true, force: true });

  // No args → usage error (exit 2).
  const usage = spawnSync(process.execPath, [GOLDEN_CLI], { encoding: 'utf-8' });
  assert(usage.status === 2, `CLI exits 2 on usage error (got ${usage.status})`);
}

// ---------------------------------------------------------------------------
// Opt-in: run the gate against the real (gitignored) model when present.
// ---------------------------------------------------------------------------
if (process.env.ETE_GOLDEN_DIR) {
  console.log(`Testing: real model golden-master (ETE_GOLDEN_DIR=${process.env.ETE_GOLDEN_DIR})`);
  const res = runGoldenMaster(process.env.ETE_GOLDEN_DIR, {
    assertNoFallbacks: true,
    canonicalPath: process.env.ETE_GOLDEN_CANONICAL, // defaults to <dir>/canonical-returns.json
    epsilon: process.env.ETE_GOLDEN_EPSILON ? Number(process.env.ETE_GOLDEN_EPSILON) : 0,
  });
  if (res.skipped) {
    console.log(`  (skipped — ${res.reason})`);
  } else {
    assert(res.fallbackViolations.length === 0,
      `no return resolves through a stub (got ${JSON.stringify(res.fallbackViolations.slice(0, 5))})`);
    assert(res.mismatches.length === 0,
      `canonical returns match to full float precision (got ${JSON.stringify(res.mismatches.slice(0, 5))})`);
  }
} else {
  console.log('Skipping real-model golden-master (set ETE_GOLDEN_DIR to enable)');
}

// ---------------------------------------------------------------------------
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

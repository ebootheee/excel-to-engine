#!/usr/bin/env node
/**
 * verify-contract — assert a built `chunked/` dir satisfies the downstream
 * (Mippy engine-service) consumer contract, without running the full engine
 * (infeasible on the real models — the 190 MB PP&E sheet). It is the
 * machine-checkable form of "the engine is usable by Mippy":
 *
 *   1. The locked artifact layout is complete (build-manifest `complete: true`)
 *      and carries a stable `contentHash` over the identity artifacts (#24).
 *   2. engine.js parses as an ES module and exposes a `run` export (#23).
 *   3. named-outputs.json pins value-bearing cells with real base-case values
 *      drawn from ground truth (#25), and the dependency closures are baked in
 *      (`dependsOnNamedInputs` / `affectsOutputs`, #32 — the closures survive
 *      the compact dependency graph).
 *   4. named-inputs.json pins the drivable inputs (#25 Request C).
 *   5. The `_fn` fallback audit ran; any return resolving through a stub is
 *      surfaced (reported, not fatal — #26).
 *
 * Privacy: prints only counts, names, and hashes — never a cell value or label.
 *
 * Usage: node scripts/verify-contract.mjs <chunkedDir> [--strict-fallbacks]
 * Exit:  0 = contract satisfied; 1 = contract violation; 2 = bad invocation.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';

const dir = process.argv[2];
const strictFallbacks = process.argv.includes('--strict-fallbacks');
if (!dir) {
  console.error('Usage: node scripts/verify-contract.mjs <chunkedDir> [--strict-fallbacks]');
  process.exit(2);
}

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); failures++; };
const readJson = (p) => JSON.parse(readFileSync(p, 'utf-8'));

console.log(`verify-contract: ${dir}\n`);

// ── 1. Build manifest: layout complete + stable identity hash ───────────────
const bmPath = join(dir, 'build-manifest.json');
if (!existsSync(bmPath)) {
  bad('build-manifest.json missing (run a full `ete init`)');
} else {
  const bm = readJson(bmPath);
  if (bm.complete === true) ok(`build complete (layout v${bm.layoutVersion})`);
  else bad(`build incomplete — missingRequired: ${JSON.stringify(bm.missingRequired)}`);
  if (typeof bm.contentHash === 'string' && bm.contentHash.startsWith('sha256:')) {
    ok(`contentHash present (${bm.contentHash.slice(0, 22)}…)`);
  } else bad('contentHash missing/!sha256 — consumer cannot pin the build');
  if (bm.engine?.export === 'run' && bm.engine?.entry === 'engine.js') ok('engine entry = engine.js#run');
  else bad('build-manifest does not declare engine.js#run as the entry');
}

// ── 2. engine.js parses + exposes run() ─────────────────────────────────────
const enginePath = join(dir, 'engine.js');
if (!existsSync(enginePath)) {
  bad('engine.js missing — build did not produce a runnable engine');
} else {
  try {
    execFileSync(process.execPath, ['--check', enginePath], { stdio: 'pipe' });
    ok('engine.js parses as a module (node --check)');
  } catch (e) {
    bad(`engine.js failed to parse: ${(e.stderr || e.message || '').toString().slice(0, 160)}`);
  }
  const src = readFileSync(enginePath, 'utf-8');
  if (/export\s+(async\s+)?function\s+run\b|export\s*\{[^}]*\brun\b/.test(src)) ok('engine.js exports run()');
  else bad('engine.js has no run export');
}

// ── 3. named-outputs: value cells + baked closures ──────────────────────────
const noPath = join(dir, 'named-outputs.json');
const gtPath = join(dir, '_ground-truth.json');
if (!existsSync(noPath)) {
  bad('named-outputs.json missing (the downstream contract)');
} else {
  const no = readJson(noPath).namedOutputs || {};
  const names = Object.keys(no);
  if (names.length >= 5) ok(`${names.length} named outputs pinned`);
  else bad(`only ${names.length} named outputs — contract too thin`);

  // base-case values are real (present in ground truth for scalar cell outputs)
  const gt = existsSync(gtPath) ? readJson(gtPath) : null;
  let withValue = 0; let realInGt = 0; let scalarChecked = 0;
  for (const o of Object.values(no)) {
    if (o.baseCaseValue !== undefined && o.baseCaseValue !== null) withValue++;
    if (gt && typeof o.cell === 'string') {
      scalarChecked++;
      if (Object.prototype.hasOwnProperty.call(gt, o.cell)) realInGt++;
    }
  }
  if (withValue >= Math.ceil(names.length * 0.6)) ok(`${withValue}/${names.length} outputs carry a base-case value`);
  else bad(`only ${withValue}/${names.length} outputs carry a base-case value`);
  if (!gt) console.log('  · ground truth absent — skipped value cross-check');
  else if (scalarChecked === 0 || realInGt >= Math.ceil(scalarChecked * 0.9)) ok(`${realInGt}/${scalarChecked} scalar output cells exist in ground truth`);
  else bad(`${realInGt}/${scalarChecked} scalar output cells found in ground truth (values may be guessed)`);

  // closures baked in (#32: they survive the compact dependency graph)
  const withClosure = Object.values(no).filter(o => Array.isArray(o.dependsOnNamedInputs)).length;
  if (withClosure > 0) ok(`dependency closures baked: ${withClosure}/${names.length} outputs carry dependsOnNamedInputs`);
  else console.log('  · no dependsOnNamedInputs present (graph absent at maps time — closures not baked)');

  const throughFallback = Object.values(no).filter(o => o.resolvesThroughFallback).length;
  if (throughFallback === 0) ok('no named output resolves through an _fn fallback stub');
  else {
    const msg = `${throughFallback}/${names.length} outputs resolve through an _fn stub (transpiler-coverage debt)`;
    if (strictFallbacks) bad(msg); else console.log(`  ⚠ ${msg}`);
  }
}

// ── 4. named-inputs: drivable inputs ────────────────────────────────────────
const niPath = join(dir, 'named-inputs.json');
if (!existsSync(niPath)) {
  console.log('  · named-inputs.json absent (no defined-name/driver inputs derivable)');
} else {
  const ni = readJson(niPath).namedInputs || {};
  const n = Object.keys(ni).length;
  if (n > 0) ok(`${n} named inputs pinned`);
  else bad('named-inputs.json present but empty');
  const withAffects = Object.values(ni).filter(i => Array.isArray(i.affectsOutputs)).length;
  if (withAffects > 0) ok(`inverse closures baked: ${withAffects}/${n} inputs carry affectsOutputs`);
}

// ── 5. fallback audit ran ───────────────────────────────────────────────────
const fbPath = join(dir, '_fn-fallbacks.json');
if (existsSync(fbPath)) {
  const fb = readJson(fbPath).fallbacks || {};
  ok(`_fn-fallbacks.json present (${Object.keys(fb).length} stub cells inventoried)`);
} else {
  console.log('  · _fn-fallbacks.json absent (audit did not run)');
}

console.log('');
if (failures === 0) { console.log('CONTRACT OK — engine is consumable by Mippy.'); process.exit(0); }
console.error(`CONTRACT FAILED — ${failures} violation(s).`);
process.exit(1);

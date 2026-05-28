#!/usr/bin/env node
/**
 * Tests for single-GT-parse-per-init.
 *
 * `ete init` now loads the ground truth (and label index) ONCE and shares the
 * parsed object across the whole manifest pipeline — generate → refine →
 * doctor → maps — instead of each step re-reading and re-parsing the full
 * ground truth from disk (up to four parses of a file that can exceed 200 MB,
 * the dominant cost of init on large models). The GT is read-only in all of
 * them, so a single shared object is safe.
 *
 * Method: each consumer accepts an injected ground truth (`_gt` for the
 * manifest subcommands, `opts.gt` for emitManifestMaps). To prove it actually
 * uses the injection and does NOT read disk, we write NO _ground-truth.json —
 * a consumer that ignored the injection and read disk would error (file
 * absent). A negative control confirms disk is otherwise the only source.
 *
 * Pure JS — no parser needed.
 *
 * Usage: node tests/cli/test-init-shared-gt.mjs
 */

import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runManifestCommand } from '../../cli/commands/manifest.mjs';
import { emitManifestMaps } from '../../lib/manifest-maps.mjs';

let passed = 0;
let failed = 0;
function assert(cond, msg) { if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); } }

// A small but detection-friendly ground truth (metrics + a revenue segment).
function makeGt() {
  return {
    'Summary!A1': 'Gross IRR', 'Summary!C1': 0.185,
    'Summary!A2': 'Net IRR', 'Summary!C2': 0.151,
    'Summary!A3': 'Gross MOIC', 'Summary!C3': 2.85,
    'Summary!A4': 'Peak Net Equity', 'Summary!C4': 270_000_000,
    'Summary!A5': 'Terminal Value', 'Summary!C5': 1_800_000_000,
    'P&L!A1': 'Revenue', 'P&L!B1': 100_000_000, 'P&L!C1': 110_000_000,
  };
}

// Dir with a manifest but DELIBERATELY no _ground-truth.json on disk.
function dirWithManifest(manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'shared-gt-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

const MINI = {
  manifestVersion: '1.0',
  model: { groundTruth: './_ground-truth.json' },
  equity: { classes: [{ grossIRR: 'Summary!C1' }] },
  outputs: { terminalValue: { cell: 'Summary!C5' } },
  carry: {},
  baseCaseOutputs: {},
};

// ---------------------------------------------------------------------------
console.log('Testing: generate honors injected _gt (no disk GT)');
{
  const dir = dirWithManifest({});
  const r = runManifestCommand('generate', dir, { _gt: makeGt(), source: 'x.xlsx' });
  assert(!r.error, `generate ran off injected _gt (error: ${r.error})`);
  assert(existsSync(join(dir, 'manifest.json')), 'manifest written');
  rmSync(dir, { recursive: true, force: true });
}

console.log('Testing: refine honors injected _gt (no disk GT)');
{
  const dir = dirWithManifest(MINI);
  const r = runManifestCommand('refine', dir, { _gt: makeGt(), apply: false });
  assert(!r.error, `refine ran off injected _gt (error: ${r.error})`);
  // Net IRR isn't pre-mapped in MINI, so refine must find it — proving it read
  // the injected gt's labels + values, not disk.
  assert(r.found?.['Net IRR']?.cell === 'Summary!C2',
    `refine used injected gt (Net IRR -> ${r.found?.['Net IRR']?.cell})`);
  rmSync(dir, { recursive: true, force: true });
}

console.log('Testing: doctor honors injected _gt (no disk GT)');
{
  const dir = dirWithManifest(MINI);
  const r = runManifestCommand('doctor', dir, { _gt: makeGt() });
  // Reached the validation pass (returns an issues array) instead of throwing
  // on a missing GT file — proves it used the injected gt.
  assert(Array.isArray(r.issues), `doctor ran off injected _gt (issues: ${r.issues && 'array'})`);
  rmSync(dir, { recursive: true, force: true });
}

console.log('Testing: maps honors injected gt (no disk GT)');
{
  const dir = dirWithManifest(MINI);
  const r = emitManifestMaps(dir, { gt: makeGt() });
  assert(r.written.includes('named-outputs.json'),
    `maps emitted named-outputs off injected gt (written: ${r.written.join(',') || 'none'}; skipped: ${r.skipped.map(s => s.file).join(',')})`);
  assert((r.stats?.outputs ?? 0) >= 1, `maps resolved outputs from injected gt (outputs: ${r.stats?.outputs})`);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Negative control: without injection AND no disk GT, the disk path is taken
// and errors — confirming the injected gt above was genuinely the source.
// ---------------------------------------------------------------------------
console.log('Testing: without injection + no disk GT, generate errors (disk is the only other source)');
{
  const dir = dirWithManifest({});
  const r = runManifestCommand('generate', dir, { source: 'x.xlsx' });
  assert(!!r.error, 'generate errors without injection when GT absent from disk');
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

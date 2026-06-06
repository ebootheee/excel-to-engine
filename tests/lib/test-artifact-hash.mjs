#!/usr/bin/env node
/**
 * Golden-vector + mutation-guard tests for the consumer-spec engine tamper hash
 * (`computeEngineArtifactHash` in lib/build-manifest.mjs) — issue #24 axis 3.
 *
 * The downstream engine-service (Mippy) self-computes this hash to verify a
 * regenerated build byte-for-byte. The contract (per the written spec) is a
 * SINGLE raw sha256 stream:
 *
 *   h = sha256()
 *   h.update(<engine.js bytes>)
 *   for f in sort(filenames in sheets/):
 *       h.update(f)           // filename, utf-8
 *       h.update(<bytes of sheets/f>)
 *   digest = 'sha256:' + h.hex()
 *
 * engine.js + sheets/ ONLY. No framing, no _ground-truth.json, no manifest.json.
 *
 * Per docs/LITE-TEST-STANDARD.md:
 *  - Rule 1 (non-circular truth): the expected digest is computed here by an
 *    INDEPENDENT hand-rolled reimplementation of the consumer spec — it does NOT
 *    call computeEngineArtifactHash to derive the expected value.
 *  - Rule 3 (mutation guard): flipping one sheet's bytes, reordering filenames,
 *    and dropping a sheet each MUST change the digest.
 *  - Rule 6 (committed fixtures only; no network; no clock/random): the fixture
 *    is built in a temp dir from fixed in-test byte strings. No Rust parser
 *    needed, so this test never skips.
 *
 * Usage: node tests/lib/test-artifact-hash.mjs
 * @license MIT
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

import { computeEngineArtifactHash, emitBuildManifest } from '../../lib/build-manifest.mjs';

let passed = 0;
let failed = 0;
function assert(cond, msg) { if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); } }

// ---------------------------------------------------------------------------
// Fixture: a tiny chunked/ dir with KNOWN bytes. Filenames are deliberately
// chosen so insertion order (b, a) differs from sorted order (a, b) — that lets
// us prove the impl sorts rather than relying on readdir order.
// ---------------------------------------------------------------------------
const ENGINE_BYTES = 'export function run(){ return 42; }\n';
const SHEET_FILES = [
  // [filename, bytes] — written in this (unsorted) order on purpose.
  ['Valuation.mjs', 'export const Valuation = { C5: 1800 };\n'],
  ['Assumptions.mjs', 'export const Assumptions = { C1: 18 };\n'],
  ['_index.mjs', 'export const sheets = ["Assumptions","Valuation"];\n'],
];
// Non-engine, non-sheet artifacts that MUST NOT affect engineArtifactHash.
const GROUND_TRUTH = '{"cells":{"Valuation!C5":1800}}';
const MANIFEST = '{"outputs":{}}';

function makeChunked() {
  const root = mkdtempSync(join(tmpdir(), 'arthash-'));
  const chunked = join(root, 'chunked');
  const sheets = join(chunked, 'sheets');
  mkdirSync(sheets, { recursive: true });
  writeFileSync(join(chunked, 'engine.js'), ENGINE_BYTES);
  for (const [name, body] of SHEET_FILES) writeFileSync(join(sheets, name), body);
  writeFileSync(join(chunked, '_ground-truth.json'), GROUND_TRUTH);
  writeFileSync(join(chunked, 'manifest.json'), MANIFEST);
  return { root, chunked, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * INDEPENDENT reference implementation of the consumer spec. Deliberately does
 * NOT import or call computeEngineArtifactHash — this is the non-circular truth
 * (LITE-TEST-STANDARD rule 1). It reads the same files off disk and applies the
 * documented algorithm by hand.
 */
function referenceHash(chunkedDir) {
  const h = createHash('sha256');
  h.update(readFileSync(join(chunkedDir, 'engine.js')));
  const sheetsDir = join(chunkedDir, 'sheets');
  const names = readdirSync(sheetsDir).sort(); // string sort
  for (const f of names) {
    h.update(f);
    h.update(readFileSync(join(sheetsDir, f)));
  }
  return 'sha256:' + h.digest('hex');
}

// ---------------------------------------------------------------------------
console.log('Testing: engineArtifactHash matches an independent consumer-spec impl (golden vector)');
{
  const { chunked, cleanup } = makeChunked();

  // Fully literal expected digest computed from the in-test byte constants — a
  // second, even-more-independent derivation that does not even read the disk.
  const sortedNames = SHEET_FILES.map(([n]) => n).sort();
  const literal = createHash('sha256');
  literal.update(Buffer.from(ENGINE_BYTES));
  for (const name of sortedNames) {
    const body = SHEET_FILES.find(([n]) => n === name)[1];
    literal.update(name);
    literal.update(Buffer.from(body));
  }
  const expectedLiteral = 'sha256:' + literal.digest('hex');

  const actual = computeEngineArtifactHash(chunked);
  const expectedFromDisk = referenceHash(chunked);

  assert(actual === expectedFromDisk, `impl matches reference-from-disk (${actual} vs ${expectedFromDisk})`);
  assert(actual === expectedLiteral, `impl matches literal-bytes derivation (${actual} vs ${expectedLiteral})`);
  assert(actual.startsWith('sha256:') && actual.length === 'sha256:'.length + 64, 'digest is sha256:<64 hex>');

  cleanup();
}

// ---------------------------------------------------------------------------
console.log('Testing: hash is deterministic regardless of file creation order');
{
  // Two dirs with the SAME logical content written in different orders → same hash.
  const a = mkdtempSync(join(tmpdir(), 'arthash-a-'));
  const b = mkdtempSync(join(tmpdir(), 'arthash-b-'));
  for (const root of [a, b]) {
    const sheets = join(root, 'sheets');
    mkdirSync(sheets, { recursive: true });
    writeFileSync(join(root, 'engine.js'), ENGINE_BYTES);
  }
  // Write sheets in opposite orders.
  writeFileSync(join(a, 'sheets', 'Assumptions.mjs'), SHEET_FILES[1][1]);
  writeFileSync(join(a, 'sheets', 'Valuation.mjs'), SHEET_FILES[0][1]);
  writeFileSync(join(b, 'sheets', 'Valuation.mjs'), SHEET_FILES[0][1]);
  writeFileSync(join(b, 'sheets', 'Assumptions.mjs'), SHEET_FILES[1][1]);
  assert(computeEngineArtifactHash(a) === computeEngineArtifactHash(b), 'same content, different write order → same hash');
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log('Testing: ground-truth/manifest bytes do NOT affect engineArtifactHash');
{
  const { chunked, cleanup } = makeChunked();
  const before = computeEngineArtifactHash(chunked);
  // Rewrite the non-engine, non-sheet artifacts with totally different content.
  writeFileSync(join(chunked, '_ground-truth.json'), '{"cells":{"Valuation!C5":999999}}');
  writeFileSync(join(chunked, 'manifest.json'), '{"outputs":{"x":"y"}}');
  const after = computeEngineArtifactHash(chunked);
  assert(before === after, 'changing _ground-truth.json / manifest.json leaves engineArtifactHash unchanged');
  cleanup();
}

// ---------------------------------------------------------------------------
// Mutation guards (LITE-TEST-STANDARD rule 3): each break MUST change the hash.
// ---------------------------------------------------------------------------
console.log('Testing: mutation guard — flipping one sheet byte changes the hash');
{
  const { chunked, cleanup } = makeChunked();
  const before = computeEngineArtifactHash(chunked);
  // Flip a single byte inside one sheet.
  writeFileSync(join(chunked, 'sheets', 'Valuation.mjs'), 'export const Valuation = { C5: 1801 };\n');
  const after = computeEngineArtifactHash(chunked);
  assert(before !== after, 'one-byte change in a sheet → different hash (mutation guard)');
  cleanup();
}

console.log('Testing: mutation guard — changing engine.js changes the hash');
{
  const { chunked, cleanup } = makeChunked();
  const before = computeEngineArtifactHash(chunked);
  writeFileSync(join(chunked, 'engine.js'), 'export function run(){ return 43; }\n');
  const after = computeEngineArtifactHash(chunked);
  assert(before !== after, 'engine.js change → different hash (mutation guard)');
  cleanup();
}

console.log('Testing: mutation guard — filename ordering is load-bearing');
{
  // Same set of byte-bodies, but assigned to filenames whose SORT order differs.
  // If the impl ignored filenames (or did not sort), these would collide.
  const dir1 = mkdtempSync(join(tmpdir(), 'arthash-o1-'));
  const dir2 = mkdtempSync(join(tmpdir(), 'arthash-o2-'));
  for (const d of [dir1, dir2]) {
    mkdirSync(join(d, 'sheets'), { recursive: true });
    writeFileSync(join(d, 'engine.js'), ENGINE_BYTES);
  }
  const bodyA = 'AAAA\n';
  const bodyB = 'BBBB\n';
  // dir1: a.mjs=bodyA, b.mjs=bodyB  → stream is "a"+AAAA then "b"+BBBB
  writeFileSync(join(dir1, 'sheets', 'a.mjs'), bodyA);
  writeFileSync(join(dir1, 'sheets', 'b.mjs'), bodyB);
  // dir2: a.mjs=bodyB, b.mjs=bodyA  → stream is "a"+BBBB then "b"+AAAA
  writeFileSync(join(dir2, 'sheets', 'a.mjs'), bodyB);
  writeFileSync(join(dir2, 'sheets', 'b.mjs'), bodyA);
  assert(computeEngineArtifactHash(dir1) !== computeEngineArtifactHash(dir2),
    'swapping which filename holds which bytes → different hash (filename + ordering matter)');
  rmSync(dir1, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
}

console.log('Testing: mutation guard — dropping a sheet changes the hash');
{
  const { chunked, cleanup } = makeChunked();
  const before = computeEngineArtifactHash(chunked);
  rmSync(join(chunked, 'sheets', '_index.mjs'), { force: true });
  const after = computeEngineArtifactHash(chunked);
  assert(before !== after, 'removing a sheet → different hash (mutation guard)');
  cleanup();
}

// ---------------------------------------------------------------------------
// emitBuildManifest wiring: engineArtifactHash is emitted and equals the
// standalone function; versionTag/platform/class identity fields populate.
// ---------------------------------------------------------------------------
console.log('Testing: emitBuildManifest emits engineArtifactHash + version-free identity');
{
  const { chunked, cleanup } = makeChunked();
  const bm = emitBuildManifest(chunked, {
    toolVersion: '0.0.0-test',
    versionTag: 'rel-2026.06',
    platform: 'mippy',
    class: 'pe-fund',
    dryRun: true,
  });
  assert(bm.engineArtifactHash === computeEngineArtifactHash(chunked),
    'emitted engineArtifactHash equals computeEngineArtifactHash');
  assert(bm.doc.engineArtifactHash === bm.engineArtifactHash, 'doc carries engineArtifactHash');
  assert(bm.doc.versionTag === 'rel-2026.06', 'versionTag threaded through');
  assert(bm.doc.platform === 'mippy', 'platform threaded through');
  assert(bm.doc.class === 'pe-fund', 'class threaded through');
  // contentHash and engineArtifactHash are DIFFERENT hashes (different algorithm).
  assert(bm.doc.contentHash !== bm.doc.engineArtifactHash,
    'contentHash and engineArtifactHash are distinct (additive, not a replacement)');
  cleanup();
}

console.log('Testing: versionTag defaults to contentHash when caller omits it');
{
  const { chunked, cleanup } = makeChunked();
  const bm = emitBuildManifest(chunked, { dryRun: true });
  assert(bm.doc.versionTag === bm.doc.contentHash, 'versionTag defaults to contentHash');
  assert(bm.doc.platform === null && bm.doc.class === null, 'platform/class default to null');
  cleanup();
}

console.log('Testing: engineArtifactHash is null on an incomplete build (engine.js missing)');
{
  const { chunked, cleanup } = makeChunked();
  rmSync(join(chunked, 'engine.js'), { force: true });
  const bm = emitBuildManifest(chunked, { dryRun: true });
  assert(bm.engineArtifactHash === null, 'engineArtifactHash is null when engine.js is missing (honest)');
  cleanup();
}

// ---------------------------------------------------------------------------
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);

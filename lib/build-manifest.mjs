/**
 * excel-to-engine — Build manifest (artifact-layout lock + content hash).
 *
 * A downstream consumer (e.g. the Mippy engine-service) needs to know, without
 * re-deriving it per version, (a) exactly which files a finished `ete init`
 * build is expected to contain, and (b) a single stable identifier for "this
 * compiled model" so it can pin a build and detect drift instead of silently
 * serving a half-written or mismatched directory.
 *
 * `emitBuildManifest` writes `chunked/build-manifest.json` enumerating the
 * canonical artifact layout with per-file hashes, and a top-level `contentHash`
 * computed over the *identity* artifacts only — the deterministic compiled
 * outputs (engine.js, sheets/, _ground-truth.json, manifest.json). The derived
 * contract maps (named-outputs/inputs) carry a `generatedAt` timestamp and so
 * are listed + hashed for integrity but deliberately excluded from the identity
 * hash, which therefore stays stable across rebuilds of the same workbook.
 *
 * It also enforces the #23 guarantee: if any `required` artifact is missing
 * (above all `engine.js`), it reports it and the caller (`ete init`) hard-errors
 * rather than finalizing an unrunnable build.
 *
 * @license MIT
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'fs';
import { join, relative, sep } from 'path';
import { createHash } from 'crypto';

/** Bump when the set/shape of artifacts a consumer should expect changes. */
export const LAYOUT_VERSION = '1.0';

/**
 * The canonical chunked/ layout after a finished `ete init`.
 *
 * - `required`: the build is incomplete without it → caller hard-errors.
 * - `identity`: contributes to `contentHash` (the stable model identifier).
 *   Only deterministic, timestamp-free compiled outputs are identity artifacts.
 *
 * Debug-only artifacts (dependency-graph.json, _graph.json) are intentionally
 * absent: they are slimmed out of the default output, so they are neither
 * required nor part of the locked layout.
 */
export const ARTIFACTS = [
  { path: 'engine.js',          role: 'engine',        kind: 'file', required: true,  identity: true },
  { path: 'sheets',             role: 'sheet-modules', kind: 'dir',  required: true,  identity: true },
  { path: '_ground-truth.json', role: 'ground-truth',  kind: 'file', required: true,  identity: true },
  { path: 'manifest.json',      role: 'manifest',      kind: 'file', required: true,  identity: true },
  { path: 'named-outputs.json', role: 'contract',      kind: 'file', required: false, identity: false },
  { path: 'named-inputs.json',  role: 'contract',      kind: 'file', required: false, identity: false },
  { path: 'cell-types.json',    role: 'contract',      kind: 'file', required: false, identity: false },
  { path: '_labels.json',       role: 'label-index',   kind: 'file', required: false, identity: false },
];

function hashFileHex(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function listFilesRecursive(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) listFilesRecursive(full, out);
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

/**
 * Hash a directory's contents order-independently: sha256 over the sorted list
 * of "<relpath>\0<filehash>" lines. Relative paths are normalized to forward
 * slashes so the hash is identical on Windows and POSIX.
 */
function hashDir(dir) {
  const entries = listFilesRecursive(dir).map((f) => ({
    rel: relative(dir, f).split(sep).join('/'),
    size: statSync(f).size,
    hash: hashFileHex(f),
  }));
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const h = createHash('sha256');
  let bytes = 0;
  for (const e of entries) {
    h.update(e.rel + '\0' + e.hash + '\n');
    bytes += e.size;
  }
  return { sha256: h.digest('hex'), files: entries.length, bytes };
}

/**
 * Build (and optionally write) the build manifest for a finished chunked dir.
 *
 * @param {string} chunkedDir
 * @param {Object} [opts]
 * @param {string} [opts.toolVersion] - package version, recorded for provenance
 * @param {string} [opts.generatedAt] - ISO timestamp (defaults to now)
 * @param {boolean} [opts.dryRun] - compute but don't write the file
 * @returns {{ ok: boolean, contentHash: string, missing: string[], artifacts: Object[], doc: Object, written: boolean }}
 */
export function emitBuildManifest(chunkedDir, opts = {}) {
  const artifacts = [];
  const missing = [];

  for (const spec of ARTIFACTS) {
    const abs = join(chunkedDir, spec.path);
    if (!existsSync(abs)) {
      if (spec.required) missing.push(spec.path);
      continue;
    }
    if (spec.kind === 'dir') {
      const d = hashDir(abs);
      artifacts.push({
        path: spec.path + '/',
        role: spec.role,
        required: spec.required,
        identity: spec.identity,
        sha256: 'sha256:' + d.sha256,
        files: d.files,
        bytes: d.bytes,
      });
    } else {
      artifacts.push({
        path: spec.path,
        role: spec.role,
        required: spec.required,
        identity: spec.identity,
        sha256: 'sha256:' + hashFileHex(abs),
        bytes: statSync(abs).size,
      });
    }
  }

  // Single identity hash over the deterministic compiled artifacts, in the
  // fixed ARTIFACTS order. Excludes timestamped derived maps so it stays stable
  // across rebuilds of the same workbook.
  const ch = createHash('sha256');
  ch.update('layout:' + LAYOUT_VERSION + '\n');
  for (const a of artifacts) {
    if (!a.identity) continue;
    ch.update(a.role + '\0' + a.path + '\0' + a.sha256 + '\n');
  }
  const contentHash = 'sha256:' + ch.digest('hex');

  const doc = {
    layoutVersion: LAYOUT_VERSION,
    tool: 'excel-to-engine',
    toolVersion: opts.toolVersion || null,
    generatedAt: opts.generatedAt || new Date().toISOString(),
    // The runnable entry point and how to call it — the consumer's contract.
    engine: { entry: 'engine.js', export: 'run', module: true },
    // Stable identifier for this compiled model (identity artifacts only).
    contentHash,
    complete: missing.length === 0,
    missingRequired: missing,
    artifacts,
  };

  let written = false;
  if (!opts.dryRun) {
    writeFileSync(join(chunkedDir, 'build-manifest.json'), JSON.stringify(doc, null, 2));
    written = true;
  }

  return { ok: missing.length === 0, contentHash, missing, artifacts, doc, written };
}

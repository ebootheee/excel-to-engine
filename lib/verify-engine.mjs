/**
 * verify-engine.mjs — does engine.run() reproduce the model's known base case?
 *
 * The single most important trust signal for both the analyst ("did it actually
 * work?") and the coding agent ("do the numbers match the spreadsheet?"). Runs
 * the generated engine with no overrides and compares each named output's
 * computed value against its recorded baseCaseValue (and, when present, the raw
 * ground-truth cell). Pure read-only; no mutation.
 *
 * Note: engine.run() executes the full model. On very large models this can be
 * slow or memory-heavy — callers should gate it (opt-in) accordingly.
 *
 * @license MIT
 */
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

function readJSON(p) { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } }

export function close(a, b, relTol = 1e-6, absTol = 1e-6) {
  if (typeof a !== 'number' || typeof b !== 'number') return a === b;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= Math.abs(b) * relTol + absTol;
}

// Minimal A1 range expander: "Sheet!B4:G4" -> ["Sheet!B4",...,"Sheet!G4"].
// Local (no cross-module import) so this stays a leaf trust util.
export function expandRange(ref) {
  if (typeof ref !== 'string') return [];
  const bang = ref.lastIndexOf('!');
  if (bang < 0) return [ref];
  const sheet = ref.slice(0, bang), rng = ref.slice(bang + 1);
  const m = rng.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  if (!m) return [ref];
  const c2n = (s) => { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };
  const n2c = (n) => { let s = ''; while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); } return s; };
  const [, c1, r1, c2, r2] = m;
  const out = [];
  for (let r = +r1; r <= +r2; r++) for (let c = c2n(c1); c <= c2n(c2); c++) out.push(`${sheet}!${n2c(c)}${r}`);
  return out;
}

// Resolve a named output to a single scalar from the engine's values map.
// - scalar output: values[cell].
// - schedule BALANCE: values[cell] (the terminal cell we now emit).
// - schedule FLOW (no scalar cell): aggregate the cellRange — sum for flows,
//   terminal for balances — so the drift check resolves a real number instead
//   of reading values[undefined] and false-flagging "contract may be stale".
// `gt` may be the full ground truth (CLI) or a build-time slice of it holding
// only the cells these checks consult (the standalone demo). `gtPresent` says
// whether ground truth existed at all; when omitted it is derived from `gt`
// having at least one key, which is exact for the full map.
export function resolveOutput(o, values, gt = {}, gtPresent) {
  if (typeof o.cell === 'string' && !o.cell.includes(':')) return values[o.cell];
  if (typeof o.cellRange === 'string') {
    const cells = expandRange(o.cellRange);
    if (!cells.length) return undefined;
    if (o.aggregation !== 'sum') return values[cells[cells.length - 1]];
    // The parser records every valued source cell in _ground-truth.json, so when
    // ground truth is present a member absent from BOTH maps is a genuine Excel
    // blank. Without ground truth an absent member is unverifiable.
    let hasGt = gtPresent === true;
    if (gtPresent === undefined) for (const key in gt) { hasGt = true; break; }
    let sum = 0;
    for (const cell of cells) {
      const value = values[cell];
      if (typeof value === 'number') sum += value;
      // A recorded numeric member the engine did not produce is a hole, not a blank.
      else if (typeof gt[cell] === 'number') return undefined;
      // Excel SUM ignores text/blank/boolean range members; those are safe to skip.
      else if (value === undefined && !hasGt) return undefined;
    }
    return sum;
  }
  return undefined;
}

// Pure helpers are also embedded in the generated standalone example, so its
// pass/fail rules cannot drift away from the CLI verifier.
export function compareOutputs(outMap, values, opts = {}) {
  const { gt = {}, gtPresent, relTol = 1e-6, absTol = 1e-6, meta } = opts;
  const drifted = [], skipped = [];
  let matched = 0;
  for (const [name, o] of Object.entries(outMap)) {
    const cell = o.cell || o.cellRange;
    const expected = o.baseCaseValue != null
      ? o.baseCaseValue
      : (typeof o.cell === 'string' ? gt[o.cell] : undefined);
    if (expected == null) {
      skipped.push({ name, cell, reason: 'no recorded base-case value' });
      continue;
    }
    const computed = resolveOutput(o, values, gt, gtPresent);
    if (computed != null && close(computed, expected, relTol, absTol)) matched++;
    else drifted.push({ name, cell, computed, expected, reason: computed == null
      ? 'missing computed value' : 'value differs from base case' });
  }
  const checked = matched + drifted.length;
  const nonConverged = meta?.converged === false ||
    (meta?.clusters || []).some(c => c.converged === false) ||
    Object.values(meta?.sheetConvergence || {}).some(s => s.converged === false);
  const error = nonConverged ? 'engine did not converge'
    : checked === 0 ? 'no named outputs with recorded base-case values to check' : undefined;
  return { ok: !error && drifted.length === 0, checked, matched, drifted, skipped,
    ...(error ? { error } : {}), meta };
}

/**
 * @param {string} chunkedDir
 * @param {object} [opts] - { relTol, absTol }
 * @returns {Promise<{ ok, checked, matched, drifted: Array, skipped?: Array, error?: string }>}
 */
export async function verifyEngine(chunkedDir, opts = {}) {
  const relTol = opts.relTol ?? 1e-6;
  const absTol = opts.absTol ?? 1e-6;
  const enginePath = join(chunkedDir, 'engine.js');
  if (!existsSync(enginePath)) return { ok: false, checked: 0, matched: 0, drifted: [], error: 'engine.js not found' };

  const outputs = readJSON(join(chunkedDir, 'named-outputs.json'));
  const gt = readJSON(join(chunkedDir, '_ground-truth.json')) || {};
  const outMap = outputs?.namedOutputs || {};
  const names = Object.keys(outMap);
  if (names.length === 0) return { ok: false, checked: 0, matched: 0, drifted: [], skipped: [], error: 'no named outputs to check' };

  let mod;
  try {
    mod = await import(pathToFileURL(resolve(enginePath)).href);
  } catch (e) {
    return { ok: false, checked: 0, matched: 0, drifted: [], error: `import failed: ${e.message}` };
  }
  const engine = typeof mod.run === 'function' ? mod : mod.default;
  if (typeof engine?.run !== 'function') return { ok: false, checked: 0, matched: 0, drifted: [], error: 'engine.js has no run() export' };

  // Full-model verification must not inherit an earlier, partially loaded cone.
  if (typeof engine.load === 'function') {
    try { await engine.load(); } catch (e) {
      return { ok: false, checked: 0, matched: 0, drifted: [], error: `load() threw: ${e.message}` };
    }
  }
  let res;
  try { res = await engine.run(); } catch (e) {
    return { ok: false, checked: 0, matched: 0, drifted: [], error: `run() threw: ${e.message}` };
  }
  return compareOutputs(outMap, res?.values || {}, { gt, relTol, absTol, meta: res?.meta });
}

export default verifyEngine;

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

function close(a, b, relTol = 1e-6, absTol = 1e-6) {
  if (typeof a !== 'number' || typeof b !== 'number') return a === b;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  return Math.abs(a - b) <= Math.abs(b) * relTol + absTol;
}

/**
 * @param {string} chunkedDir
 * @param {object} [opts] - { relTol, absTol }
 * @returns {Promise<{ ok, checked, matched, drifted: Array, error?: string }>}
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
  if (names.length === 0) return { ok: true, checked: 0, matched: 0, drifted: [], error: 'no named outputs to check' };

  let mod;
  try {
    mod = await import(pathToFileURL(resolve(enginePath)).href);
  } catch (e) {
    return { ok: false, checked: 0, matched: 0, drifted: [], error: `import failed: ${e.message}` };
  }
  const run = mod.run || mod.default?.run;
  if (typeof run !== 'function') return { ok: false, checked: 0, matched: 0, drifted: [], error: 'engine.js has no run() export' };

  let res;
  try { res = run(); } catch (e) {
    return { ok: false, checked: 0, matched: 0, drifted: [], error: `run() threw: ${e.message}` };
  }
  const values = res?.values || {};

  const drifted = [];
  let matched = 0;
  for (const name of names) {
    const o = outMap[name];
    const computed = values[o.cell];
    const expected = o.baseCaseValue != null ? o.baseCaseValue : gt[o.cell];
    if (expected == null) continue; // nothing to compare against
    if (close(computed, expected, relTol, absTol)) matched++;
    else drifted.push({ name, cell: o.cell, computed, expected });
  }
  const checked = matched + drifted.length;
  return { ok: drifted.length === 0, checked, matched, drifted, meta: res?.meta };
}

export default verifyEngine;

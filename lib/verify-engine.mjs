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

// Minimal A1 range expander: "Sheet!B4:G4" -> ["Sheet!B4",...,"Sheet!G4"].
// Local (no cross-module import) so this stays a leaf trust util.
function expandRange(ref) {
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
function resolveOutput(o, values) {
  if (typeof o.cell === 'string' && !o.cell.includes(':')) return values[o.cell];
  if (typeof o.cellRange === 'string') {
    const nums = expandRange(o.cellRange).map((c) => values[c]).filter((v) => typeof v === 'number');
    if (nums.length === 0) return undefined;
    return o.aggregation === 'sum' ? nums.reduce((a, b) => a + b, 0) : nums[nums.length - 1];
  }
  return undefined;
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
    // Resolve scalars AND schedules (balance via terminal cell, flow via summed
    // range). Only skip outputs we genuinely can't resolve to a number.
    const computed = resolveOutput(o, values);
    if (computed === undefined) continue;
    const expected = o.baseCaseValue != null
      ? o.baseCaseValue
      : (typeof o.cell === 'string' ? gt[o.cell] : null);
    if (expected == null) continue; // nothing to compare against
    if (close(computed, expected, relTol, absTol)) matched++;
    else drifted.push({ name, cell: o.cell || o.cellRange, computed, expected });
  }
  const checked = matched + drifted.length;
  return { ok: drifted.length === 0, checked, matched, drifted, meta: res?.meta };
}

export default verifyEngine;

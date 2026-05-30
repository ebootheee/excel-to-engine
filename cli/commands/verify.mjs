/**
 * ete verify — does the generated engine reproduce the model's base case?
 *
 * The visible trust signal for "did it actually work?". Runs engine.run() with
 * no overrides and compares each named output to its recorded baseCaseValue.
 * Read-only. Note: runs the full engine, so it can be slow/heavy on very large
 * models — it's an explicit command (and an opt-in `ete init --verify`), never
 * on the default init path.
 *
 * @license MIT
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { verifyEngine } from '../../lib/verify-engine.mjs';

function resolveChunked(modelDir) {
  if (!modelDir) return null;
  if (existsSync(join(modelDir, 'engine.js'))) return modelDir;
  if (existsSync(join(modelDir, 'chunked', 'engine.js'))) return join(modelDir, 'chunked');
  return modelDir; // let verifyEngine report the missing-engine error
}

function fmt(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a !== 0 && a < 1) return v.toFixed(4);
  return String(Math.round(v * 1e4) / 1e4);
}

export async function runVerify(modelDir, args = {}) {
  const chunked = resolveChunked(modelDir);
  if (!chunked) return { error: 'Usage: ete verify <modelDir>' };

  const res = await verifyEngine(chunked, {
    relTol: args.tol ? Number(args.tol) : undefined,
  });

  if (args.format === 'json') {
    return { ...res, _formatted: JSON.stringify(res, null, 2) };
  }

  const lines = [];
  if (res.error && res.checked === 0 && res.matched === 0 && res.drifted.length === 0) {
    // hard failure (no engine / no outputs) vs. clean pass with a note
    if (/not found|no run|import failed|threw/.test(res.error)) {
      return { error: res.error, _formatted: `Error: ${res.error}` };
    }
  }
  lines.push('Engine base-case verification');
  lines.push('─'.repeat(52));
  lines.push(`  Outputs checked: ${res.checked}`);
  lines.push(`  Match base case: ${res.matched}`);
  lines.push(`  Drifted:         ${res.drifted.length}`);
  if (res.meta?.elapsedMs != null) lines.push(`  Engine run:      ${res.meta.elapsedMs} ms`);
  lines.push('');
  if (res.drifted.length > 0) {
    lines.push('  These outputs do NOT match the spreadsheet base case:');
    for (const d of res.drifted) {
      lines.push(`    ${d.name}  (${d.cell})  computed ${fmt(d.computed)}  vs base ${fmt(d.expected)}`);
    }
    lines.push('');
    lines.push('  Likely causes: a mis-mapped output cell (run: ete manifest doctor <dir>),');
    lines.push('  or a model with an intra-sheet "staircase" (a cell reading a later row on');
    lines.push('  the same sheet). See skill/SKILL.md → "Engine fidelity".');
  } else if (res.checked === 0) {
    lines.push(`  Nothing to verify: ${res.error || 'no named outputs with base-case values'}.`);
  } else {
    lines.push('  ✓ engine.run() reproduces the model\'s base case exactly.');
    lines.push('  Safe to hand the chunked/ bundle to a developer.');
  }

  return { ...res, _formatted: lines.join('\n') };
}

export default runVerify;

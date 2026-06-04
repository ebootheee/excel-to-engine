/**
 * excel-to-engine — per-cell transpiled-expression extractor (engine-speed L1/L2).
 *
 * The chunked emitter writes every cell as a single line
 *   `  ctx.set("Sheet!Cell", <transpiled-js-expr>);`
 * in its sheet module (`chunked/sheets/<Sheet>.mjs`) — one `ctx.set` per cell,
 * literal cells included (literals render as a backtick string / number / etc).
 * The cone-module / full-executor emitters (Lane 1 & 2, ADR-026) recompute the
 * ACTIVE subgraph, and they need each active cell's exact transpiled expression.
 * Rather than re-transpile (which needs the Rust parser + the formula source), we
 * lift the expressions straight out of the already-emitted sheet modules — same
 * bytes the default engine runs, so the cone reproduces the full run by construction.
 *
 * The address argument never contains a quote (`"Sheet!A1"`), and each `ctx.set`
 * is exactly one line, so a per-line regex is robust even when the expression
 * itself contains nested `)`, `;`, or string literals (it greedily matches to the
 * trailing `);`). Sheet modules can be 190 MB on the real model, so we stream them
 * line-by-line instead of reading the whole file into a string.
 *
 * @license MIT
 */

import { createReadStream, existsSync, readdirSync } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';

// `  ctx.set("<addr>", <expr>);`  — addr has no embedded quote; expr is the rest
// of the line up to the final `);`. Greedy `(.+)` + anchored `\);\s*$` so a nested
// `);` inside the expression (e.g. `_sumifs(ctx.range("A!1:2"), ...)`) stays in expr.
const SET_RE = /^\s*ctx\.set\("([^"]+)",\s*(.+)\);\s*$/;

/**
 * Extract a cell → transpiled-expression map from ONE generated sheet module.
 * Streams the file (handles the 190 MB monster modules). Last write wins (a cell
 * is emitted once, so this only matters defensively).
 *
 * @param {string} modulePath - path to a chunked/sheets/<Sheet>.mjs
 * @param {Map<string,string>} [into] - existing map to fill (else a fresh one)
 * @returns {Promise<Map<string,string>>}
 */
export async function extractSheetExprs(modulePath, into = new Map()) {
  const rl = createInterface({ input: createReadStream(modulePath, { encoding: 'utf-8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    // Cheap pre-filter before the regex — most lines in a big module are ctx.set,
    // but imports/comments/loop scaffolding are not.
    if (line.indexOf('ctx.set(') === -1) continue;
    const m = SET_RE.exec(line);
    if (m) into.set(m[1], m[2]);
  }
  return into;
}

/**
 * Extract the cell → expression map for an ENTIRE chunked engine: every cell the
 * engine sets, across all sheet modules. Keyed by qualified address ("Sheet!A1").
 *
 * @param {string} chunkedDir - a `chunked/` dir (has a `sheets/` subdir)
 * @returns {Promise<Map<string,string>>}
 */
export async function extractCellExprs(chunkedDir) {
  const sheetsDir = join(chunkedDir, 'sheets');
  if (!existsSync(sheetsDir)) throw new Error(`extractCellExprs: no sheets/ under ${chunkedDir}`);
  const out = new Map();
  for (const f of readdirSync(sheetsDir)) {
    if (!f.endsWith('.mjs') || f.startsWith('_')) continue; // skip _helpers.mjs etc.
    await extractSheetExprs(join(sheetsDir, f), out);
  }
  return out;
}

export default extractCellExprs;

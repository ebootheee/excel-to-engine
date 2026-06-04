#!/usr/bin/env node
/**
 * _build.mjs — construct the committed synthetic fixtures for the efficacy
 * harness, using the REAL rust-parser (the same `build()` pattern as
 * pipelines/rust/tests/test-lazy-engine.mjs). A fixture is a `chunked/` dir +
 * a golden.json the harness blesses separately.
 *
 * Each fixture deliberately reproduces the real-model pathology so the
 * scope-plan / cycle / cone lanes can be debugged in seconds:
 *   - >= 3 sheets,
 *   - a real CROSS-SHEET cycle (Debt!balance -> Debt!interest -> CF!cash ->
 *     Debt!balance), iterated to convergence by the engine's cluster loop,
 *   - one big ACYCLIC schedule sheet (a few thousand cells for mini, scaled up
 *     for midi) — the static upstream a cone must constant-fold,
 *   - >= 1 NAMED OUTPUT downstream of the cycle (on the Out sheet).
 *
 * All data is synthetic/dummy — no real financials, labels, or values (CLAUDE.md
 * privacy rule). The committed artifact is the parser's JSON/JS output (no
 * .xlsx; the workbook is built in a temp dir and discarded).
 *
 * Usage (normally invoked via efficacy.mjs --bless):
 *   node benchmarks/fixtures/_build.mjs mini-cyclic
 *   node benchmarks/fixtures/_build.mjs midi-cyclic
 *
 * Needs the rust-parser binary (release or debug). Exits 3 if it isn't built.
 *
 * @license MIT
 */

import XLSX from 'xlsx';
import { writeFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, cpSync, rmdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..');
const exe = process.platform === 'win32' ? '.exe' : '';
const PARSER = [
  join(ROOT, 'pipelines/rust/target/release', `rust-parser${exe}`),
  join(ROOT, 'pipelines/rust/target/debug', `rust-parser${exe}`),
].find(existsSync);

// ── A1 helpers ──────────────────────────────────────────────────────────────
const num = (v, f) => (f ? { t: 'n', v, f } : { t: 'n', v });
const str = (v) => ({ t: 's', v });

/**
 * Build the workbook for a fixture. `scale` is the schedule sheet length (rows
 * of the big acyclic schedule); mini ~1.2K cells, midi tens of thousands.
 *
 * Shape (identical across tiers; only `scale` differs):
 *   Sched  — big ACYCLIC running schedule. Sched!Bn = Sched!B(n-1) + An (const).
 *            Its terminal cell Sched!B{scale} feeds the cycle via CF.
 *   Debt   — interest = balance * rate ; balance = CF!cash + principal-floor.
 *   CF     — cash = Debt!interest * payout + Sched!terminal      <-- closes cycle
 *            CF!cash -> Debt!balance -> Debt!interest -> CF!cash
 *   Out    — MIP (NAMED OUTPUT, downstream of the cycle) = CF!cash * 2 + Debt!interest
 *            Total                                          = MIP + Sched!terminal
 */
function workbook(scale) {
  const schedRef = `B${scale}`; // terminal schedule cell, e.g. B1200
  // Big acyclic schedule: A column constants, B column running cumulative sum.
  const Sched = { '!ref': `A1:B${scale}` };
  for (let r = 1; r <= scale; r++) {
    // deterministic synthetic constants — a gentle ramp, no real data
    Sched[`A${r}`] = num(1 + ((r * 7) % 13) * 0.5);
    Sched[`B${r}`] = r === 1
      ? num(0, `A1`)
      : num(0, `B${r - 1}+A${r}`);
  }

  // Cross-sheet cycle (damped so it converges): the classic debt<->cashflow loop.
  const Debt = {
    '!ref': 'A1:B2',
    A1: str('interest'), B1: num(0, 'Debt!B2*0.05'),         // interest = balance * 5%
    A2: str('balance'),  B2: num(0, 'CF!B2+100000'),         // balance = cash + principal floor
  };
  const CF = {
    '!ref': 'A1:B2',
    A1: str('cash'),
    // cash = interest * payout + schedule terminal  -> closes Debt<->CF cycle and
    // pulls the big acyclic schedule in as a boundary input.
    B1: str('drivers'),
    B2: num(0, `Debt!B1*0.30+Sched!${schedRef}`),
  };
  // Named outputs, both DOWNSTREAM of the cycle.
  const Out = {
    '!ref': 'A1:B2',
    A1: str('MIP'),   B1: num(0, 'CF!B2*2+Debt!B1'),
    A2: str('Total'), B2: num(0, `Out!B1+Sched!${schedRef}`),
  };

  return {
    SheetNames: ['Sched', 'Debt', 'CF', 'Out'],
    Sheets: { Sched, Debt, CF, Out },
  };
}

// Named outputs authored alongside the fixture (the parser does not emit
// named-outputs.json; the manifest step in `ete init` does, which this harness
// must not depend on). Shape matches lib/verify-engine.mjs resolveOutput().
function namedOutputs() {
  return {
    namedOutputs: {
      MIP: { cell: 'Out!B1', label: 'synthetic MIP (downstream of cycle)' },
      Total: { cell: 'Out!B2', label: 'synthetic Total (downstream of cycle)' },
      DebtInterest: { cell: 'Debt!B1', label: 'synthetic cycle interest' },
      CFCash: { cell: 'CF!B2', label: 'synthetic cycle cash' },
    },
  };
}

const FIXTURES = {
  'mini-cyclic': { scale: 600 },   // ~600 sched rows * 2 cols + cycle/out ~= 1.2K cells, <1s
  'midi-cyclic': { scale: 50000 }, // ~50K sched rows * 2 cols ~= 100K cells, seconds
};

export function buildFixture(name) {
  if (!PARSER) {
    const msg = 'rust-parser not built (cd pipelines/rust && cargo build --release)';
    const e = new Error(msg); e.code = 'NO_PARSER';
    throw e;
  }
  const spec = FIXTURES[name];
  if (!spec) throw new Error(`unknown fixture '${name}' (have: ${Object.keys(FIXTURES).join(', ')})`);

  const wb = workbook(spec.scale);
  const tmp = mkdtempSync(join(tmpdir(), `fixbuild-${name}-`));
  try {
    const xlsx = join(tmp, 'm.xlsx');
    writeFileSync(xlsx, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    // --emit-debug keeps dependency-graph.json so the harness can compute the
    // active/cycle/cone STRUCTURE metrics (analyze-cone pattern).
    execFileSync(PARSER, [xlsx, join(tmp, 'out'), '--chunked', '--emit-debug'], {
      encoding: 'utf-8', stdio: 'pipe',
    });
    const srcChunked = join(tmp, 'out', 'chunked');

    const dstFixture = join(__dir, name);
    const dstChunked = join(dstFixture, 'chunked');
    // Replace any prior build of this fixture's chunked dir (golden.json lives
    // one level up and is preserved / re-blessed separately).
    if (existsSync(dstChunked)) rmSync(dstChunked, { recursive: true, force: true });
    mkdirSync(dstChunked, { recursive: true });
    cpSync(srcChunked, dstChunked, { recursive: true });

    // Author the named-outputs map (verify-engine oracle reads this).
    writeFileSync(
      join(dstChunked, 'named-outputs.json'),
      JSON.stringify(namedOutputs(), null, 2) + '\n',
    );

    return { name, chunked: dstChunked, fixtureDir: dstFixture, scale: spec.scale };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export const FIXTURE_NAMES = Object.keys(FIXTURES);

// CLI entry: build the named fixture(s).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const names = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const targets = names.length ? names : FIXTURE_NAMES;
  for (const n of targets) {
    const r = buildFixture(n);
    console.log(`built fixture '${r.name}' (scale=${r.scale}) -> ${r.chunked}`);
  }
}

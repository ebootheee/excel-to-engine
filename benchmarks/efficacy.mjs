#!/usr/bin/env node
/**
 * efficacy.mjs — the rapid-iteration test loop for the engine-speed lanes.
 *
 * The inner loop must be SECONDS and must PROVE CORRECTNESS against an oracle on
 * every run, while tracking speed / memory / structure over time so we can see
 * the needle move per commit. The real model is the GATE (run `--fixture
 * outpost-a1` pre-merge), never the inner loop — that runs on the committed
 * synthetic fixtures (mini-cyclic, midi-cyclic) built by ./fixtures/_build.mjs,
 * each of which reproduces the real pathology (a cross-sheet cycle + a big
 * acyclic schedule + a named output downstream of the cycle).
 *
 * A "variant" is one way of computing the model:
 *   - baseline : the full eager engine.run() (implemented now; the oracle for the
 *                others). Golden values are blessed from it.
 *   - scoped   : the Lane 2 cone module (ADR-026). Wave 2 — pluggable hook.
 *   - cycle    : the Lane 1 cell-level cycle resolution. Wave 2 — pluggable hook.
 *
 * Correctness is a HARD GATE: each named output is compared to the blessed
 * golden within 1e-6 rel+abs (reusing lib/verify-engine.mjs close()/
 * resolveOutput()); ANY drift exits non-zero. `--compare <variant>` additionally
 * asserts value PARITY between two variants and reports speedup× / memory×.
 *
 * Privacy (mirrors benchmarks/bench.mjs): the fixtures are synthetic/dummy, but
 * we still never write cell VALUES or labels to the committed artifacts. Full
 * per-run detail (incl. computed values) lands only in the gitignored
 * benchmarks/results/. The committed efficacy-history.jsonl + EFFICACY.md carry
 * AGGREGATE metrics only — timings, sizes, %-correct, structure counts.
 *
 * Usage:
 *   node benchmarks/efficacy.mjs --fixture mini-cyclic --variant baseline --bless
 *   node benchmarks/efficacy.mjs --fixture mini-cyclic --variant baseline --compare baseline
 *   node benchmarks/efficacy.mjs --fixture midi-cyclic --variant baseline
 *
 * @license MIT
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, appendFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { performance } from 'perf_hooks';

import { close, resolveOutput } from '../lib/verify-engine.mjs';
import { loadDependencyEdges } from '../lib/manifest-maps.mjs';
import { buildFixture, FIXTURE_NAMES } from './fixtures/_build.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = __dir + '/fixtures';
const RESULTS_DIR = join(__dir, 'results');         // gitignored
const HISTORY_PATH = join(__dir, 'efficacy-history.jsonl'); // committed (sanitized)
const EFFICACY_MD = join(__dir, 'EFFICACY.md');     // committed (aggregate)

const REL_TOL = 1e-6;
const ABS_TOL = 1e-6;

// ── args ──────────────────────────────────────────────────────────────────
function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
function has(name) { return process.argv.includes(`--${name}`); }

const FIXTURE = flag('fixture', 'mini-cyclic');
const VARIANT = flag('variant', 'baseline');
const COMPARE = flag('compare', null);
const BLESS = has('bless');

// ── variant runners ─────────────────────────────────────────────────────────
// Each returns { values, meta, runMs, moduleBytes } for a fixture's chunked dir.
// Wave 2 lights up `scoped` (Lane 2) and `cycle` (Lane 1); they are wired as
// hooks now so the harness, history, and EFFICACY.md schema are stable.
function notImplemented(label) {
  return async () => {
    const e = new Error(`variant '${label}' is not implemented yet — Wave 2. Run --variant baseline for now.`);
    e.code = 'VARIANT_NYI';
    throw e;
  };
}

/** Sum the on-disk bytes of the sheet modules an eager engine imports — the
 *  structural memory ceiling. For scoped/cone variants (Wave 2) this is the cone
 *  subset, which is how we prove "no 190 MB sheet module loaded". */
function sheetModuleBytes(chunked) {
  const dir = join(chunked, 'sheets');
  if (!existsSync(dir)) return 0;
  let bytes = 0;
  for (const f of readdirSync(dir)) if (f.endsWith('.mjs')) bytes += statSync(join(dir, f)).size;
  return bytes;
}

async function runBaseline(chunked, inputs) {
  // Fresh import per call (cache-bust) so repeated runs in --compare each pay a
  // real compile + run, not a cached module hit.
  const url = pathToFileURL(join(chunked, 'engine.js')).href + `?t=${performance.now()}`;
  const eng = await import(url);
  const run = eng.run || eng.default?.run;
  if (typeof run !== 'function') throw new Error('engine.js has no run() export');
  const t0 = performance.now();
  const res = run(inputs || {});
  const runMs = performance.now() - t0;
  return { values: res.values || {}, meta: res.meta || {}, runMs, moduleBytes: sheetModuleBytes(chunked) };
}

const VARIANTS = {
  baseline: runBaseline,
  scoped: notImplemented('scoped (Lane 2 cone module, ADR-026)'),
  cycle: notImplemented('cycle (Lane 1 cell-level cycle resolution)'),
};

// ── structure metrics (cheap on the synthetic fixtures) ──────────────────────
// Counts only — no addresses, no values. dependency-graph.json is present when
// the fixture was built with --emit-debug (it is). Cluster info comes from the
// engine's own convergence telemetry (meta.clusters), which is the sheet-level
// signal; cell-level active/cone sizes arrive with the Lane 0 scope plan in Wave 2.
function structure(chunked, meta) {
  let formulaCells = null;
  const graphPath = join(chunked, 'dependency-graph.json');
  if (existsSync(graphPath)) {
    try { formulaCells = Object.keys(loadDependencyEdges(graphPath)).length; } catch { /* ignore */ }
  }
  const clusters = Array.isArray(meta.clusters) ? meta.clusters : [];
  const cycleSheets = clusters.reduce((n, c) => n + (c.sheets ? c.sheets.length : 0), 0);
  return { formulaCells, clusters: clusters.length, cycleSheets };
}

// ── correctness gate ─────────────────────────────────────────────────────────
function readNamedOutputs(chunked) {
  const p = join(chunked, 'named-outputs.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf-8')).namedOutputs || {}; } catch { return {}; }
}

function gradeCorrectness(outMap, golden, values) {
  const rows = [];
  let withinTol = 0, maxRelErr = 0, comparable = 0;
  for (const [name, o] of Object.entries(outMap)) {
    const computed = resolveOutput(o, values);
    const expected = golden[name];
    if (computed === undefined || expected === undefined) { rows.push({ name, computed, expected, status: 'unresolved' }); continue; }
    comparable++;
    const ok = close(computed, expected, REL_TOL, ABS_TOL);
    const relErr = typeof computed === 'number' && typeof expected === 'number' && expected !== 0
      ? Math.abs((computed - expected) / expected) : (ok ? 0 : Infinity);
    if (ok) withinTol++; else maxRelErr = Math.max(maxRelErr, relErr);
    rows.push({ name, computed, expected, status: ok ? 'ok' : 'DRIFT', relErr });
  }
  return { rows, comparable, withinTol, maxRelErr, pctWithinTol: comparable ? +(100 * withinTol / comparable).toFixed(4) : null };
}

// ── golden oracle ─────────────────────────────────────────────────────────────
function goldenPath(name) { return join(FIXTURES_DIR, name, 'golden.json'); }

async function blessGolden(name, chunked) {
  const outMap = readNamedOutputs(chunked);
  const { values } = await runBaseline(chunked, {});
  const golden = {};
  for (const [n, o] of Object.entries(outMap)) {
    const v = resolveOutput(o, values);
    if (v !== undefined) golden[n] = v;
  }
  writeFileSync(goldenPath(name), JSON.stringify(golden, null, 2) + '\n');
  return golden;
}

// ── reporting ─────────────────────────────────────────────────────────────────
function nowStamp() { return new Date().toISOString(); }
const mb = (b) => b == null ? null : +(b / 1e6).toFixed(2);

function appendHistory(line) {
  // One sanitized line per run: metrics only, never a cell value or label.
  appendFileSync(HISTORY_PATH, JSON.stringify(line) + '\n');
}

function renderEfficacyMd() {
  const lines = existsSync(HISTORY_PATH)
    ? readFileSync(HISTORY_PATH, 'utf-8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  const L = [];
  L.push('# engine-speed efficacy — correctness gate + speed/memory/structure history');
  L.push('');
  L.push('The rapid-iteration loop for the engine-speed lanes. Each run recomputes the');
  L.push('committed synthetic fixtures and PROVES every named output against the blessed');
  L.push('golden within 1e-6 (rel+abs) — any drift exits non-zero. Aggregate-only: no cell');
  L.push('values or labels (fixtures are synthetic; full detail stays in the gitignored');
  L.push('`benchmarks/results/`). Regenerate:');
  L.push('');
  L.push('```');
  L.push('node benchmarks/efficacy.mjs --fixture mini-cyclic --variant baseline --bless     # (re)record golden');
  L.push('node benchmarks/efficacy.mjs --fixture mini-cyclic --variant baseline --compare baseline');
  L.push('```');
  L.push('');
  L.push('Variants: `baseline` (full run, implemented) · `scoped` (Lane 2 cone module — Wave 2) · `cycle` (Lane 1 cell-level cycle — Wave 2).');
  L.push('');
  // Latest entry per (fixture × variant).
  const latest = new Map();
  for (const e of lines) latest.set(`${e.fixture}::${e.variant}`, e);
  L.push('## Latest per fixture × variant');
  L.push('');
  L.push('| Fixture | Variant | Correct | maxRelErr | Run ms | Speedup× | Passes | Converged | Formula cells | Cyc.sheets | Module MB |');
  L.push('|---------|---------|--------:|----------:|-------:|---------:|-------:|:---------:|--------------:|-----------:|----------:|');
  for (const e of [...latest.values()].sort((a, b) => (a.fixture + a.variant).localeCompare(b.fixture + b.variant))) {
    L.push(`| ${e.fixture} | ${e.variant} | ${e.pctWithinTol == null ? 'n/a' : e.pctWithinTol + '%'} | ${e.maxRelErr ?? 0} | ${e.runMs} | ${e.speedupX ?? '—'} | ${e.iterations ?? '—'} | ${e.converged === undefined ? '—' : (e.converged ? 'yes' : 'NO')} | ${e.formulaCells ?? '—'} | ${e.cycleSheets ?? '—'} | ${e.moduleMB ?? '—'} |`);
  }
  L.push('');
  L.push(`_Last run: ${lines.length ? lines[lines.length - 1].ts : 'n/a'} · ${lines.length} run(s) recorded._`);
  L.push('');
  // Recent history tail.
  L.push('## Recent runs');
  L.push('');
  L.push('| Time (UTC) | Fixture | Variant | OK | Correct | Run ms | Speedup× |');
  L.push('|------------|---------|---------|:--:|--------:|-------:|---------:|');
  for (const e of lines.slice(-15)) {
    L.push(`| ${e.ts} | ${e.fixture} | ${e.variant} | ${e.ok ? '✓' : '✗'} | ${e.pctWithinTol == null ? 'n/a' : e.pctWithinTol + '%'} | ${e.runMs} | ${e.speedupX ?? '—'} |`);
  }
  L.push('');
  writeFileSync(EFFICACY_MD, L.join('\n'));
}

// ── main ────────────────────────────────────────────────────────────────────
function fail(msg, code = 1) { console.error(`efficacy: ${msg}`); process.exit(code); }

if (!FIXTURE_NAMES.includes(FIXTURE)) fail(`unknown fixture '${FIXTURE}' (have: ${FIXTURE_NAMES.join(', ')})`, 2);
if (!VARIANTS[VARIANT]) fail(`unknown variant '${VARIANT}' (have: ${Object.keys(VARIANTS).join(', ')})`, 2);

const fixtureDir = join(FIXTURES_DIR, FIXTURE);
let chunked = join(fixtureDir, 'chunked');

// Build the fixture if missing or if blessing (a fresh build + fresh golden).
if (BLESS || !existsSync(join(chunked, 'engine.js'))) {
  try {
    process.stdout.write(`efficacy: building fixture '${FIXTURE}' ... `);
    const built = buildFixture(FIXTURE);
    chunked = built.chunked;
    console.log(`done (scale=${built.scale})`);
  } catch (e) {
    if (e.code === 'NO_PARSER') fail(`cannot build fixture — ${e.message}`, 3);
    throw e;
  }
}

if (BLESS) {
  const golden = await blessGolden(FIXTURE, chunked);
  console.log(`efficacy: blessed golden for '${FIXTURE}' (${Object.keys(golden).length} named outputs) -> ${goldenPath(FIXTURE)}`);
}

const golden = existsSync(goldenPath(FIXTURE)) ? JSON.parse(readFileSync(goldenPath(FIXTURE), 'utf-8')) : null;
if (!golden) fail(`no golden.json for '${FIXTURE}' — run once with --bless to record it`, 2);

const outMap = readNamedOutputs(chunked);

// ── run the variant under test ────────────────────────────────────────────────
let primary;
try {
  primary = await VARIANTS[VARIANT](chunked, {});
} catch (e) {
  if (e.code === 'VARIANT_NYI') fail(e.message, 4);
  throw e;
}

const grade = gradeCorrectness(outMap, golden, primary.values);
const struct = structure(chunked, primary.meta);

// ── optional A/B compare ────────────────────────────────────────────────────
let speedupX = null, memoryX = null, parityOk = null;
if (COMPARE) {
  if (!VARIANTS[COMPARE]) fail(`unknown --compare variant '${COMPARE}'`, 2);
  let cmp;
  try { cmp = await VARIANTS[COMPARE](chunked, {}); }
  catch (e) { if (e.code === 'VARIANT_NYI') fail(`--compare ${e.message}`, 4); throw e; }
  // Value parity between the two variants on every named output.
  let mism = 0;
  for (const [name, o] of Object.entries(outMap)) {
    const a = resolveOutput(o, primary.values), b = resolveOutput(o, cmp.values);
    if (a === undefined && b === undefined) continue;
    if (!close(a, b, REL_TOL, ABS_TOL)) mism++;
  }
  parityOk = mism === 0;
  speedupX = primary.runMs > 0 ? +(cmp.runMs / primary.runMs).toFixed(3) : null;
  memoryX = primary.moduleBytes > 0 ? +(cmp.moduleBytes / primary.moduleBytes).toFixed(3) : null;
}

// ── verdict ───────────────────────────────────────────────────────────────────
const drift = grade.rows.filter((r) => r.status === 'DRIFT');
const ok = drift.length === 0 && (parityOk === null || parityOk === true);

console.log('');
console.log(`efficacy: ${FIXTURE} / ${VARIANT}${COMPARE ? ` (vs ${COMPARE})` : ''}`);
console.log(`  correctness: ${grade.withinTol}/${grade.comparable} within 1e-6  (maxRelErr ${grade.maxRelErr})`);
console.log(`  speed:       run ${primary.runMs.toFixed(2)} ms · ${primary.meta.iterations ?? 0} cluster pass(es) · converged=${primary.meta.converged}`);
console.log(`  structure:   ${struct.formulaCells ?? '?'} formula cells · ${struct.clusters} cluster(s) · ${struct.cycleSheets} sheet(s) in cycle`);
console.log(`  memory:      sheet modules ${mb(primary.moduleBytes)} MB on disk`);
if (COMPARE) console.log(`  A/B:         parity=${parityOk ? 'OK' : 'MISMATCH'} · speedup ${speedupX}× · module-bytes ${memoryX}×`);
if (drift.length) for (const d of drift) console.log(`  DRIFT: ${d.name} computed=${d.computed} expected=${d.expected} relErr=${d.relErr}`);

// Full detail -> gitignored results/ (may carry counts; values are synthetic).
mkdirSync(RESULTS_DIR, { recursive: true });
const stamp = nowStamp().replace(/[:.]/g, '-');
writeFileSync(join(RESULTS_DIR, `${stamp}-${FIXTURE}-${VARIANT}.json`),
  JSON.stringify({ ts: nowStamp(), fixture: FIXTURE, variant: VARIANT, compare: COMPARE, ok, grade, struct, primary: { runMs: primary.runMs, meta: primary.meta, moduleBytes: primary.moduleBytes }, speedupX, memoryX, parityOk }, null, 2));

// Sanitized history line (committed). No values, no labels.
appendHistory({
  ts: nowStamp(), fixture: FIXTURE, variant: VARIANT, compare: COMPARE, ok,
  outputs: grade.comparable, pctWithinTol: grade.pctWithinTol, maxRelErr: grade.maxRelErr,
  runMs: +primary.runMs.toFixed(2), speedupX, memoryX,
  iterations: primary.meta.iterations ?? null, converged: primary.meta.converged ?? null,
  formulaCells: struct.formulaCells, clusters: struct.clusters, cycleSheets: struct.cycleSheets,
  moduleMB: mb(primary.moduleBytes),
});
renderEfficacyMd();

console.log(`  -> history + EFFICACY.md updated; detail in benchmarks/results/`);
console.log(ok ? 'efficacy: PASS' : 'efficacy: FAIL (drift or parity mismatch)');
process.exit(ok ? 0 : 1);

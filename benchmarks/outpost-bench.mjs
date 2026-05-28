#!/usr/bin/env node
/**
 * Outpost benchmark — repeatable accuracy + efficacy tracking over the real
 * models, so we can see whether each improvement actually moves the needle.
 *
 * It wraps `eval/per-sheet-eval.mjs` (which runs each sheet module live against
 * ground truth, converges circular clusters, and skips/handles oversized
 * sheets) for every model under a root dir, then aggregates. Accuracy is real
 * (engine recompute vs ground truth, 1% rel. tol / exact strings) — NOT the
 * `_computed-values.json` snapshot, which is a copy of ground truth (trivially
 * 100%), nor the full-engine `run()`, which is infeasible on these models (the
 * 190 MB PP&E sheet).
 *
 * Privacy: the real models are proprietary (gitignored). Full per-sheet detail
 * (incl. per-cell failures) stays in the gitignored `benchmarks/results/`. Only
 * AGGREGATE, non-identifying metrics — overall accuracy, sheet pass/skip counts,
 * timings, and the already-public blocker categories (PP&E, Headcount) — go to
 * the committed `benchmarks/BASELINE.md`. No cell value or label is ever
 * printed or committed.
 *
 * Usage:
 *   node benchmarks/outpost-bench.mjs [--root <dir>] [--concurrency 3] [--stamp <label>]
 *
 * Run it after any change that could affect accuracy or pipeline speed, then
 * diff benchmarks/BASELINE.md to see the delta.
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const EVAL_SCRIPT = join(REPO_ROOT, 'eval', 'per-sheet-eval.mjs');
const RESULTS_DIR = join(__dirname, 'results');

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ROOT = resolve(flag('root', join(REPO_ROOT, 'engines')));
const CONCURRENCY = flag('concurrency', '3');
const STAMP = flag('stamp', new Date().toISOString().replace(/[:.]/g, '-'));

function discoverModels(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    const chunked = join(root, name, 'chunked');
    if (existsSync(join(chunked, 'engine.js')) && existsSync(join(chunked, '_ground-truth.json'))) {
      out.push({ name, chunked });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function benchModel(model) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const reportPath = join(RESULTS_DIR, `persheet-${model.name}-${STAMP}.json`);
  const gtSizeMB = +(statSync(join(model.chunked, '_ground-truth.json')).size / 1e6).toFixed(1);

  const t = Date.now();
  let evalError = null;
  try {
    // --skip-clusters by default: circular-cluster sheets need the single-pass
    // orchestrator eval (a follow-up); evaluating them per-sheet is infeasible on
    // big models. Pass --with-clusters once that lands. Standalone sheets give a
    // fast, real accuracy number; skipped sheets are reported with their reason.
    const evalArgs = ['--max-old-space-size=8192', EVAL_SCRIPT, model.chunked, '--output', reportPath, '--concurrency', String(CONCURRENCY)];
    if (!process.argv.includes('--with-clusters')) evalArgs.push('--skip-clusters');
    await execFileAsync('node', evalArgs, { maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    evalError = (e.stderr || e.message || String(e)).slice(0, 200);
  }
  const wallMs = Date.now() - t;

  if (!existsSync(reportPath)) {
    return { name: model.name, evalError: evalError || 'no report produced', efficacy: { wallMs, gtSizeMB } };
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
  // Strip topFailures (real cell values) from anything we keep in memory for the
  // committed summary; the gitignored report file retains full detail.
  const sheets = (report.sheets || [])
    .map(s => ({ name: s.name, status: s.status, accuracy: s.accuracy, correct: s.correct, total: s.total }))
    .sort((a, b) => a.accuracy - b.accuracy);

  return {
    name: model.name,
    evalError,
    summary: report.summary,
    skipped: report.skipped || [],
    sheets,
    efficacy: { wallMs, gtSizeMB },
  };
}

// ── Run ──────────────────────────────────────────────────────────────────────
const models = discoverModels(ROOT);
if (models.length === 0) {
  console.error(`No models found under ${ROOT} (need <model>/chunked/engine.js + _ground-truth.json).`);
  console.error('Point --root at a dir of parsed engines (the real Outpost engines live in the gitignored engines/).');
  process.exit(2);
}

console.log(`Outpost benchmark — ${models.length} model(s) under ${ROOT}\n`);
const results = [];
for (const m of models) {
  process.stdout.write(`  ${m.name} ... `);
  const r = await benchModel(m);
  results.push(r);
  if (r.evalError && !r.summary) console.log(`eval FAILED (${r.evalError})`);
  else {
    const s = r.summary;
    console.log(`acc ${s.overallAccuracy}%  (${s.totalCellsCorrect}/${s.totalCellsTested})  ` +
      `${s.sheetsPassing}/${s.sheetsEvaluated} sheets ≥95%, ${s.sheetsSkipped} skipped  [${(r.efficacy.wallMs / 1000).toFixed(0)}s]`);
  }
}

mkdirSync(RESULTS_DIR, { recursive: true });
const detailPath = join(RESULTS_DIR, `summary-${STAMP}.json`);
writeFileSync(detailPath, JSON.stringify({ stamp: STAMP, root: ROOT, results }, null, 2));
console.log(`\nDetail (gitignored): ${detailPath}`);

// ── Committed aggregate (no values, no full sheet inventory) ──────────────────
function renderBaseline(stamp, results) {
  const L = [];
  L.push('# Outpost benchmark — baseline & history');
  L.push('');
  L.push('Real accuracy: each standalone sheet recomputed live vs ground truth via');
  L.push('`eval/per-sheet-eval.mjs` (numbers within 1% rel. tol, strings exact).');
  L.push('Circular-cluster sheets and oversized sheets are **skipped** for now (see');
  L.push('the Skipped column + blockers below) pending the single-pass orchestrator');
  L.push('eval; run with `--with-clusters` once that lands. Aggregate-only — no cell');
  L.push('values or full sheet inventory. Regenerate:');
  L.push('`node benchmarks/outpost-bench.mjs --root <engines>`. Full per-sheet detail');
  L.push('lands in the gitignored `benchmarks/results/`.');
  L.push('');
  L.push(`_Last run: ${stamp}_`);
  L.push('');
  L.push('| Model | Accuracy | Cells matched | Sheets ≥95% | Skipped | Eval time | GT |');
  L.push('|-------|---------:|------:|:-----------:|:-------:|----------:|---:|');
  for (const r of results) {
    if (!r.summary) { L.push(`| ${r.name} | eval failed | — | — | — | — | ${r.efficacy.gtSizeMB} MB |`); continue; }
    const s = r.summary;
    L.push(`| ${r.name} | ${s.overallAccuracy}% | ${s.totalCellsCorrect}/${s.totalCellsTested} | ` +
      `${s.sheetsPassing}/${s.sheetsEvaluated} | ${s.sheetsSkipped} | ${(r.efficacy.wallMs / 1000).toFixed(0)}s | ${r.efficacy.gtSizeMB} MB |`);
  }
  L.push('');
  L.push('## Known blocker categories');
  L.push('');
  L.push('Tracked by name because PLAN.md already calls them out; values are accuracy %, not financials.');
  L.push('');
  const PUBLIC = [/pp&?e/i, /headcount/i];
  for (const r of results) {
    if (!r.summary) { L.push(`- **${r.name}**: eval failed`); continue; }
    const blockers = [];
    for (const sk of r.skipped) if (PUBLIC.some(re => re.test(sk.name))) blockers.push(`${sk.name} (skipped: ${sk.reason})`);
    for (const sh of r.sheets) if (PUBLIC.some(re => re.test(sh.name))) blockers.push(`${sh.name} ${sh.accuracy}%`);
    const lowest = r.sheets.filter(s => s.status !== 'ok' || s.accuracy < 95).length;
    L.push(`- **${r.name}**: ${r.summary.sheetsEvaluated - lowest}/${r.summary.sheetsEvaluated} sheets clean; ` +
      `blockers: ${blockers.join('; ') || 'none surfaced'}`);
  }
  L.push('');
  return L.join('\n');
}
const baselinePath = join(__dirname, 'BASELINE.md');
writeFileSync(baselinePath, renderBaseline(STAMP, results));
console.log(`Baseline (committed): ${baselinePath}`);

/**
 * per-sheet-eval.mjs — Standalone per-sheet accuracy evaluation
 *
 * Loads chunked output from the Rust parser, runs each sheet module independently,
 * and compares computed values against ground truth. Designed to run locally
 * (not inside Docker) with concurrent child processes.
 *
 * Usage:
 *   node per-sheet-eval.mjs <chunked-dir> [--output report.json] [--concurrency 6] [--sample 2000]
 *
 * Example:
 *   node per-sheet-eval.mjs pipelines/rust/tests/output/chunked
 *   node per-sheet-eval.mjs output/my-model/chunked --output my-report.json --concurrency 4
 */

import { readFile, writeFile, mkdir, stat, readdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── CLI args ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const chunkedDir = resolve(args.find(a => !a.startsWith('--')) || '.');

function getFlag(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const OUTPUT_FILE = getFlag('output', join(chunkedDir, '..', 'per-sheet-report.json'));
const CONCURRENCY = parseInt(getFlag('concurrency', '6'));
const SAMPLE_SIZE = parseInt(getFlag('sample', '2000'));

// ── Validate inputs ────────────────────────────────────────────────────────
const gtPath = join(chunkedDir, '_ground-truth.json');
const graphPath = join(chunkedDir, '_graph.json');
const sheetsDir = join(chunkedDir, 'sheets');

if (!existsSync(gtPath)) {
  console.error(`Error: _ground-truth.json not found in ${chunkedDir}`);
  console.error('Make sure you pass the chunked output directory from the Rust parser.');
  process.exit(1);
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();

  console.log('');
  console.log('='.repeat(60));
  console.log('  Per-Sheet Eval');
  console.log('='.repeat(60));
  console.log(`  Chunked dir: ${chunkedDir}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log(`  Sample size: ${SAMPLE_SIZE} cells/sheet`);
  console.log('');

  // Load ground truth
  const allGt = JSON.parse(await readFile(gtPath, 'utf8'));
  const totalCells = Object.keys(allGt).length;
  console.log(`  Ground truth: ${totalCells} cells`);

  // Group ground truth by sheet
  const gtBySheet = {};
  for (const [addr, val] of Object.entries(allGt)) {
    const bang = addr.indexOf('!');
    if (bang < 0) continue;
    const sheet = bang > 0 ? addr.slice(0, bang) : 'Unknown';
    if (!gtBySheet[sheet]) gtBySheet[sheet] = {};
    gtBySheet[sheet][addr] = val;
  }

  // Sort sheets by formula count (largest first)
  const sheetEntries = Object.entries(gtBySheet)
    .map(([name, gt]) => {
      const formulaCount = Object.values(gt).filter(v => typeof v === 'number').length;
      return { name, gt, totalCount: Object.keys(gt).length, formulaCount };
    })
    .sort((a, b) => b.formulaCount - a.formulaCount);

  console.log(`  Sheets: ${sheetEntries.length}`);

  // Load graph for topo order and circular clusters
  let topoOrder = null;
  let sheetClusters = [];  // arrays of sheet names that form circular deps
  let clusterSheetSet = new Set();  // flat set of all sheets in any cluster
  if (existsSync(graphPath)) {
    try {
      const graph = JSON.parse(await readFile(graphPath, 'utf8'));
      topoOrder = graph.topoOrder || graph.sheets?.map(s => s.name) || null;
      sheetClusters = graph.sheetClusters || [];
      for (const cluster of sheetClusters) {
        for (const s of cluster) clusterSheetSet.add(s);
      }
      if (sheetClusters.length > 0) {
        console.log(`  Circular clusters: ${sheetClusters.length} (${clusterSheetSet.size} sheets total)`);
        console.log(`  Cluster sheets will run through convergence loop, not in isolation.`);
      }
    } catch { /* ignore */ }
  }

  // Write full ground truth to a temp file for child processes
  const tmpDir = join(chunkedDir, '_eval_tmp');
  await mkdir(tmpDir, { recursive: true });
  const gtTmpPath = join(tmpDir, '_gt_full.json');
  await writeFile(gtTmpPath, JSON.stringify(allGt));

  // Build task list
  const tasks = [];
  const skipped = [];

  for (const entry of sheetEntries) {
    const sanitized = entry.name.replace(/[^a-zA-Z0-9]/g, '_');
    const modulePath = join(sheetsDir, `${sanitized}.mjs`);

    if (!existsSync(modulePath)) {
      skipped.push({ name: entry.name, reason: 'module not found' });
      continue;
    }

    // Check module size
    try {
      const modStat = await stat(modulePath);
      const sizeMB = modStat.size / (1024 * 1024);
      if (sizeMB > 150) {
        skipped.push({ name: entry.name, reason: `module too large (${sizeMB.toFixed(0)}MB)` });
        continue;
      }
    } catch {
      skipped.push({ name: entry.name, reason: 'stat failed' });
      continue;
    }

    // Sample ground truth if sheet has too many entries
    let sampleGt = entry.gt;
    if (entry.totalCount > SAMPLE_SIZE) {
      sampleGt = {};
      const keys = Object.keys(entry.gt);
      const step = Math.max(1, Math.floor(keys.length / SAMPLE_SIZE));
      for (let i = 0; i < keys.length && Object.keys(sampleGt).length < SAMPLE_SIZE; i += step) {
        sampleGt[keys[i]] = entry.gt[keys[i]];
      }
    }

    // Write per-sheet GT to temp
    const sheetGtPath = join(tmpDir, `_gt_${sanitized}.json`);
    await writeFile(sheetGtPath, JSON.stringify(sampleGt));

    tasks.push({
      sheetName: entry.name,
      sanitized,
      modulePath: resolve(modulePath),
      sheetGtPath: resolve(sheetGtPath),
      gtTmpPath: resolve(gtTmpPath),
      gtCount: Object.keys(sampleGt).length,
      totalCount: entry.totalCount,
    });
  }

  if (skipped.length > 0) {
    console.log(`  Skipped ${skipped.length} sheets:`);
    for (const s of skipped) {
      console.log(`    - ${s.name}: ${s.reason}`);
    }
  }
  console.log(`  Evaluating ${tasks.length} sheets...`);
  console.log('');

  // Run eval tasks with concurrency limit
  const results = [];
  let completed = 0;

  async function evalOneSheet(task) {
    const { sheetName, sanitized, modulePath, sheetGtPath, gtTmpPath: gtFullPath, gtCount } = task;

    // Determine if this sheet is in a circular cluster
    const cluster = sheetClusters.find(c => c.includes(sheetName));
    const clusterModules = cluster ? cluster.map(s => {
      const san = s.replace(/[^a-zA-Z0-9]/g, '_');
      const modPath = join(sheetsDir, `${san}.mjs`).replace(/\\/g, '/');
      return { name: s, sanitized: san, path: modPath };
    }).filter(m => existsSync(join(sheetsDir, `${m.sanitized}.mjs`))) : [];

    // Build a child process script that loads the sheet module(s) and compares
    const clusterImports = clusterModules.length > 0
      ? clusterModules.map(m => `import { compute as compute_${m.sanitized} } from '${m.path}';`).join('\n')
      : '';
    const clusterComputeBlock = clusterModules.length > 0
      ? `
  // Convergence loop for circular cluster (${clusterModules.length} sheets)
  const clusterFns = [${clusterModules.map(m => `compute_${m.sanitized}`).join(', ')}];
  const MAX_ITER = 200;
  const TOL = 1e-6;
  let prevSnapshot = {};
  for (let _ci = 0; _ci < MAX_ITER; _ci++) {
    for (const fn of clusterFns) fn(ctx);
    // Check convergence on numeric values
    let maxDelta = 0;
    const snapshot = {};
    for (const [k, v] of Object.entries(ctx.values)) {
      if (typeof v === 'number') {
        snapshot[k] = v;
        const prev = prevSnapshot[k] || 0;
        const d = Math.abs(v - prev);
        if (d > maxDelta) maxDelta = d;
      }
    }
    prevSnapshot = snapshot;
    if (_ci > 0 && maxDelta < TOL) break;
  }
`
      : `
  // Single sheet (not in circular cluster)
  compute(ctx);
`;

    const evalScript = `
import { readFile } from 'fs/promises';
import { compute } from '${modulePath.replace(/\\/g, '/')}';
${clusterImports}

const allGt = JSON.parse(await readFile('${gtFullPath.replace(/\\/g, '/')}', 'utf8'));
const sheetGt = JSON.parse(await readFile('${sheetGtPath.replace(/\\/g, '/')}', 'utf8'));

const cn = s => { let n=0; for(const c of s) n = n*26+c.charCodeAt(0)-64; return n; };
const nc = n => { let s=''; while(n>0){n--;s=String.fromCharCode(65+(n%26))+s;n=Math.floor(n/26);} return s; };
const ctx = {
  values: {},
  get(addr) { return this.values[addr] !== undefined ? this.values[addr] : 0; },
  set(addr, value) { this.values[addr] = value; },
  _parseRange(rangeStr) {
    const m = rangeStr.match(/^(.+)!([A-Z]+)(\\d+):([A-Z]+)(\\d+)$/);
    if (!m) return null;
    const [, sheet, c1, r1, c2, r2] = m;
    return { sheet, c1: cn(c1), r1: +r1, c2: cn(c2), r2: +r2 };
  },
  range(rangeStr) {
    const p = this._parseRange(rangeStr);
    if (!p) return [];
    const result = [];
    for (let r = p.r1; r <= p.r2; r++)
      for (let c = p.c1; c <= p.c2; c++)
        result.push(this.get(p.sheet+'!'+nc(c)+r));
    return result;
  },
  range2d(rangeStr) {
    const p = this._parseRange(rangeStr);
    if (!p) return [];
    const result = [];
    for (let r = p.r1; r <= p.r2; r++) {
      const row = [];
      for (let c = p.c1; c <= p.c2; c++)
        row.push(this.get(p.sheet+'!'+nc(c)+r));
      result.push(row);
    }
    return result;
  }
};

// Seed context with full ground truth (upstream sheet values)
for (const [addr, val] of Object.entries(allGt)) {
  ctx.values[addr] = val;
}

// Run compute (with convergence loop for circular clusters)
try {
${clusterComputeBlock}
} catch (e) {
  process.stdout.write(JSON.stringify({
    error: e.message,
    stack: (e.stack || '').split('\\n').slice(0, 5).join('\\n'),
    accuracy: 0, correct: 0, total: 0, failures: []
  }));
  process.exit(0);
}

// Compare
let correct = 0, total = 0;
const failures = [];
for (const [addr, expected] of Object.entries(sheetGt)) {
  const actual = ctx.values[addr];
  if (actual === undefined || actual === null) {
    if (failures.length < 30) failures.push({ address: addr, expected, actual: null, relError: 1.0 });
    total++;
    continue;
  }
  total++;
  if (typeof expected === 'string' || typeof actual === 'string') {
    if (String(actual) === String(expected)) { correct++; }
    else if (failures.length < 30) { failures.push({ address: addr, expected, actual, relError: 1.0 }); }
    continue;
  }
  const relError = Math.abs(expected) < 1e-9 ? Math.abs(actual) : Math.abs((actual - expected) / expected);
  if (relError < 0.01) { correct++; }
  else if (failures.length < 30) { failures.push({ address: addr, expected, actual, relError }); }
}
process.stdout.write(JSON.stringify({ accuracy: total > 0 ? correct/total : 0, correct, total, failures }));
`;

    const tmpScript = join(tmpDir, `_eval_${sanitized}.mjs`);
    await writeFile(tmpScript, evalScript);

    const evalStart = Date.now();
    try {
      // SECURITY: Strip secrets from child process environment (VULN-9)
      const safeEnv = { ...process.env };
      delete safeEnv.ANTHROPIC_API_KEY;
      const { stdout: evalOut } = await execAsync(
        'node',
        ['--max-old-space-size=8192', tmpScript],
        { timeout: 300000, maxBuffer: 50 * 1024 * 1024, env: safeEnv }
      );
      const result = JSON.parse(evalOut);
      completed++;
      const elapsed = Date.now() - evalStart;

      if (result.error) {
        const icon = 'XX';
        console.log(`  ${icon} ${sheetName}: ERROR - ${result.error.slice(0, 120)}  [${completed}/${tasks.length}] ${elapsed}ms`);
        return { sheetName, ...result, elapsed, status: 'error' };
      }

      const pct = result.total > 0 ? (result.correct / result.total * 100).toFixed(1) : '0.0';
      const icon = result.accuracy >= 0.95 ? 'OK' : result.accuracy >= 0.70 ? '--' : '!!';
      console.log(`  ${icon} ${sheetName}: ${pct}% (${result.correct}/${result.total})  [${completed}/${tasks.length}] ${elapsed}ms`);
      return { sheetName, ...result, elapsed, status: 'ok' };
    } catch (err) {
      completed++;
      const elapsed = Date.now() - evalStart;
      const isOOM = err.killed || err.signal === 'SIGKILL' || (err.message && err.message.includes('ENOMEM'));
      const reason = isOOM ? 'OOM' : (err.signal || 'crash');

      console.log(`  XX ${sheetName}: ${reason}  [${completed}/${tasks.length}] ${elapsed}ms`);

      return {
        sheetName,
        accuracy: 0, correct: 0, total: 0,
        failures: [],
        elapsed,
        status: isOOM ? 'oom' : 'crash',
        error: isOOM ? `OOM (killed after ${(elapsed / 1000).toFixed(1)}s)` : err.message?.slice(0, 200),
      };
    }
  }

  // Run with concurrency limit
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(evalOneSheet));
    results.push(...batchResults);
  }

  // Aggregate
  let totalCorrect = 0, totalTested = 0;
  let sheetsOk = 0, sheetsError = 0, sheetsOom = 0;
  const allFailures = [];

  for (const r of results) {
    totalCorrect += r.correct || 0;
    totalTested += r.total || 0;
    if (r.status === 'ok' && r.accuracy >= 0.95) sheetsOk++;
    if (r.status === 'error' || r.status === 'crash') sheetsError++;
    if (r.status === 'oom') sheetsOom++;
    if (r.failures) allFailures.push(...r.failures);
  }

  const overallAccuracy = totalTested > 0 ? totalCorrect / totalTested : 0;
  const totalElapsed = Date.now() - startTime;

  // Clean up temp files
  try {
    const tmpFiles = await readdir(tmpDir);
    for (const f of tmpFiles) {
      await unlink(join(tmpDir, f)).catch(() => {});
    }
    await unlink(tmpDir).catch(() => {});
  } catch { /* best effort */ }

  // Build report
  const report = {
    summary: {
      chunkedDir,
      totalGroundTruthCells: totalCells,
      sheetsEvaluated: tasks.length,
      sheetsSkipped: skipped.length,
      sheetsPassing: sheetsOk,
      sheetsWithErrors: sheetsError,
      sheetsOom: sheetsOom,
      totalCellsTested: totalTested,
      totalCellsCorrect: totalCorrect,
      overallAccuracy: parseFloat((overallAccuracy * 100).toFixed(2)),
      elapsedMs: totalElapsed,
      concurrency: CONCURRENCY,
      sampleSize: SAMPLE_SIZE,
    },
    sheets: results.map(r => ({
      name: r.sheetName,
      status: r.status,
      accuracy: r.total > 0 ? parseFloat((r.correct / r.total * 100).toFixed(2)) : 0,
      correct: r.correct,
      total: r.total,
      elapsedMs: r.elapsed,
      error: r.error || null,
      topFailures: (r.failures || []).slice(0, 5),
    })),
    skipped,
    topFailures: allFailures
      .sort((a, b) => Math.abs(b.relError) - Math.abs(a.relError))
      .slice(0, 30),
  };

  await writeFile(OUTPUT_FILE, JSON.stringify(report, null, 2));

  // Print summary table
  console.log('');
  console.log('='.repeat(60));
  console.log('  Summary');
  console.log('-'.repeat(60));
  console.log(`  Sheets evaluated:    ${tasks.length}`);
  console.log(`  Sheets passing >95%: ${sheetsOk}`);
  console.log(`  Sheets with errors:  ${sheetsError}`);
  console.log(`  Sheets OOM:          ${sheetsOom}`);
  console.log(`  Total cells tested:  ${totalTested}`);
  console.log(`  Total cells correct: ${totalCorrect}`);
  console.log(`  Overall accuracy:    ${(overallAccuracy * 100).toFixed(1)}%`);
  console.log(`  Time:                ${(totalElapsed / 1000).toFixed(1)}s`);
  console.log(`  Report:              ${OUTPUT_FILE}`);
  console.log('='.repeat(60));
  console.log('');

  // Exit code: 0 if >85% accuracy, 1 otherwise
  process.exit(overallAccuracy >= 0.85 ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

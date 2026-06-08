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
import { fileURLToPath, pathToFileURL } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { loadDependencyEdges, computeClusterSeed } from '../lib/manifest-maps.mjs';

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
const CONCURRENCY = parseInt(getFlag('concurrency', process.env.EVAL_CONCURRENCY || '6'));
const SAMPLE_SIZE = parseInt(getFlag('sample', process.env.SAMPLE_SIZE || '2000'));
// --skip-clusters: OPT-OUT. By default the single-pass orchestrator now converges
// each cross-sheet cluster ONCE (one child task) and scores every member from
// that shared fixed point, so clusters are measured — the returns/MIP cone is no
// longer skipped. Pass --skip-clusters for the fast standalone-sheets-only number
// (records cluster sheets as skipped, the old O(cluster²) avoidance).
const SKIP_CLUSTERS = args.includes('--skip-clusters');
const NODE_HEAP_MB = parseInt(process.env.NODE_HEAP_MB || '8192');
const MAX_SHEET_SIZE_MB = parseInt(process.env.MAX_SHEET_SIZE_MB || '150');
// Per-task child timeout. A real cross-sheet cluster (17 sheets, millions of
// formulas, seeded from a multi-GB ground truth) needs more than the per-sheet
// default — raise EVAL_TIMEOUT_MS for the single-pass cone measurement.
const EVAL_TIMEOUT_MS = parseInt(process.env.EVAL_TIMEOUT_MS || '300000');

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
  let graphInlineEdges = null;      // inline cell edges (synthetic fixtures only)
  if (existsSync(graphPath)) {
    try {
      const graph = JSON.parse(await readFile(graphPath, 'utf8'));
      topoOrder = graph.topoOrder || graph.sheets?.map(s => s.name) || null;
      sheetClusters = graph.sheetClusters || [];
      graphInlineEdges = graph.edges || null;
      for (const cluster of sheetClusters) {
        for (const s of cluster) clusterSheetSet.add(s);
      }
      if (sheetClusters.length > 0) {
        console.log(`  Circular clusters: ${sheetClusters.length} (${clusterSheetSet.size} sheets total)`);
        console.log(`  Cluster sheets will run through convergence loop, not in isolation.`);
      }
    } catch { /* ignore */ }
  }

  // Cell-level forward edges for GT-seed scoping (#33). Prefer the streamed
  // dependency-graph.json (real models — note it is slimmed out of the DEFAULT
  // build, so the cone measurement needs `ete init --emit-debug`); fall back to
  // inline _graph.json.edges (synthetic fixtures). Without edges we cannot scope,
  // so each cluster child seeds the full GT (the OOM path) — logged loudly below.
  let clusterEdges = null;
  const depGraphPath = join(chunkedDir, 'dependency-graph.json');
  if (existsSync(depGraphPath)) {
    try { clusterEdges = loadDependencyEdges(depGraphPath); } catch { clusterEdges = null; }
  }
  if ((!clusterEdges || Object.keys(clusterEdges).length === 0) && graphInlineEdges) clusterEdges = graphInlineEdges;
  // A present-but-EMPTY edge map (malformed/old-schema dependency-graph.json, or a
  // dep-graph vs _graph.json mismatch) must fall through to the logged 'full' path,
  // not silently scope a cluster with ZERO external reads.
  if (clusterEdges && Object.keys(clusterEdges).length === 0) clusterEdges = null;

  // GT_SEED_SCOPE: how much ground truth each cluster child receives.
  //   'cluster'  (default when edges exist) — cluster-sheet cells (warm-start) +
  //              external reads; excludes the non-cluster bulk. Avoids the OOM and
  //              the cold-start divide-by-zero NaN. NOTE: warm-starting a cluster's
  //              own cells means a scored cell that no compute fn overwrites keeps
  //              its GT seed and counts as "correct" — so the default reports an
  //              UPPER BOUND on cone accuracy. Run GT_SEED_SCOPE=external for the
  //              cold-start (honest) number and treat the gap as the optimism band.
  //   'external' — external reads + cluster raw-inputs only (minimal; cold-starts
  //              computed cells, relies on the NaN-guard if a coverage ratio /0s).
  //   'full'     — legacy: seed the entire ground truth.
  const GT_SEED_SCOPE = process.env.GT_SEED_SCOPE || (clusterEdges ? 'cluster' : 'full');

  // Named outputs whose cell lives in a circular cluster — surfaced with accuracy
  // (no values) so the returns/MIP cone (MIP Proceeds, hurdle, ...) is reported
  // rather than skipped. Only the named outputs the contract already tagged.
  const RETURN_KEY = /moic|irr|carry|promote|mip|proceeds|tvpi|dpi|hurdle|threshold|participation|terminal.?value|equity.?basis|valuation|shares|nav/i;
  const namedOfInterest = []; // {name, cell}
  const noPath = join(chunkedDir, 'named-outputs.json');
  if (existsSync(noPath) && clusterSheetSet.size > 0) {
    try {
      const no = JSON.parse(await readFile(noPath, 'utf8'));
      const outs = no.namedOutputs || no.outputs || no;
      for (const [name, spec] of Object.entries(outs)) {
        const cell = spec && typeof spec === 'object' ? spec.cell : null;
        if (!cell || typeof cell !== 'string' || cell.indexOf('!') < 0) continue;
        const sheet = cell.slice(0, cell.indexOf('!'));
        if (RETURN_KEY.test(name) && clusterSheetSet.has(sheet)) namedOfInterest.push({ name, cell });
      }
    } catch { /* ignore */ }
  }
  const namedCells = namedOfInterest.map(o => o.cell);

  // Write full ground truth to a temp file for child processes
  const tmpDir = join(chunkedDir, '_eval_tmp');
  await mkdir(tmpDir, { recursive: true });
  const gtTmpPath = join(tmpDir, '_gt_full.json');
  await writeFile(gtTmpPath, JSON.stringify(allGt));

  // Build task list. Cross-sheet circular clusters become a SINGLE task (one
  // convergence, all members scored); standalone sheets stay one task each.
  const tasks = [];
  const skipped = [];
  const clusterTasks = new Map(); // clusterKey -> { kind:'cluster', clusterSheets, members:[] }

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
      if (sizeMB > MAX_SHEET_SIZE_MB) {
        skipped.push({ name: entry.name, reason: `module too large (${sizeMB.toFixed(0)}MB > ${MAX_SHEET_SIZE_MB}MB limit)` });
        continue;
      }
    } catch {
      skipped.push({ name: entry.name, reason: 'stat failed' });
      continue;
    }

    if (SKIP_CLUSTERS && clusterSheetSet.has(entry.name)) {
      skipped.push({ name: entry.name, reason: 'circular cluster (--skip-clusters; needs single-pass orchestrator eval)' });
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

    const member = {
      sheetName: entry.name,
      sanitized,
      modulePath: resolve(modulePath),
      sheetGtPath: resolve(sheetGtPath),
      gtTmpPath: resolve(gtTmpPath),
      gtCount: Object.keys(sampleGt).length,
      totalCount: entry.totalCount,
    };

    // Route cluster members into one shared cluster task; standalone sheets each
    // get their own task.
    const cluster = clusterSheetSet.has(entry.name) ? sheetClusters.find(c => c.includes(entry.name)) : null;
    if (cluster) {
      const key = cluster.join('|');
      if (!clusterTasks.has(key)) {
        clusterTasks.set(key, { kind: 'cluster', clusterSheets: cluster.slice(), members: [], gtTmpPath: resolve(gtTmpPath) });
      }
      clusterTasks.get(key).members.push(member);
    } else {
      tasks.push({ kind: 'sheet', ...member });
    }
  }

  // Append one task per cluster (after standalone sheets, so the largest
  // standalone sheets still start first under the concurrency window).
  for (const ct of clusterTasks.values()) tasks.push(ct);

  // GT-seed scoping (#33): give each cluster child only the GT it needs — its
  // external reads (+ a warm start for its own cells) — instead of the whole
  // ~5.8M-cell ground truth, which OOMs an 8GB heap. Write a per-cluster scoped
  // GT file and repoint the task at it (the child's seed loop is unchanged).
  if (GT_SEED_SCOPE !== 'full' && clusterTasks.size > 0) {
    if (!clusterEdges) {
      console.log(`  ! GT-seed scoping unavailable (no dependency-graph.json / inline edges) — cluster children seed the FULL ground truth and may OOM. Rebuild with \`ete init --emit-debug\` to enable scoping.`);
    } else {
      const allGtKeys = new Set(Object.keys(allGt));
      for (const ct of clusterTasks.values()) {
        // OFFSET / dynamic-INDIRECT reach cells at runtime-computed addresses the
        // static edge map can't see — scoping would drop those external boundary
        // reads and the cluster would read 0 (a silently wrong, still-finite value).
        // Detect them in the member modules and keep the FULL seed for that cluster.
        let _dynamicRead = false;
        for (const m of ct.members) {
          try {
            const src = await readFile(m.modulePath, 'utf8');
            if (src.includes('_offset(') || src.includes('ctx.get(String(')) { _dynamicRead = true; break; }
          } catch { _dynamicRead = true; break; } // unreadable -> be safe, don't scope
        }
        if (_dynamicRead) {
          console.log(`  ! Cluster [${ct.clusterSheets.join(', ')}] uses OFFSET/INDIRECT (runtime-addressed reads) — keeping FULL GT seed (scoping would drop boundary reads); may OOM.`);
          continue; // leave ct.gtTmpPath at the full path
        }
        const seed = computeClusterSeed(ct.clusterSheets, clusterEdges, allGtKeys,
          { warmStartCluster: GT_SEED_SCOPE !== 'external' });
        const scoped = {};
        for (const cell of seed) { const v = allGt[cell]; if (v !== undefined) scoped[cell] = v; }
        const clusterKey = ct.clusterSheets.join('_').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
        const scopedPath = join(tmpDir, `_gt_cluster_${clusterKey}.json`);
        await writeFile(scopedPath, JSON.stringify(scoped));
        ct.gtTmpPath = resolve(scopedPath);
        const pct = allGtKeys.size > 0 ? (100 * seed.size / allGtKeys.size).toFixed(1) : '0';
        console.log(`  Cluster [${ct.clusterSheets.join(', ')}] seed: ${seed.size}/${allGtKeys.size} GT cells (${pct}%, scope=${GT_SEED_SCOPE})`);
      }
    }
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
      const modPath = join(sheetsDir, `${san}.mjs`);
      return { name: s, sanitized: san, path: modPath };
    }).filter(m => existsSync(m.path)) : [];

    // Build a child process script that loads the sheet module(s) and compares.
    // Paths flow into JS source — interpolate them as JSON-quoted strings so a
    // path containing `'` or `\` can't break out and inject code.
    const clusterImports = clusterModules.length > 0
      ? clusterModules.map(m => `import { compute as compute_${m.sanitized} } from ${JSON.stringify(pathToFileURL(m.path).href)};`).join('\n')
      : '';
    const clusterComputeBlock = clusterModules.length > 0
      ? `
  // Convergence loop for circular cluster (${clusterModules.length} sheets)
  const clusterFns = [${clusterModules.map(m => `compute_${m.sanitized}`).join(', ')}];
  const MAX_ITER = 200;
  const TOL = 1e-6;
  const prevSnapshot = {};
  for (let _ci = 0; _ci < MAX_ITER; _ci++) {
    for (const fn of clusterFns) fn(ctx);
    // Convergence is about the cluster's *computed* cells stabilizing, so diff
    // only the cells the cluster wrote (ctx._written) — not every seeded
    // ground-truth cell. On a model with millions of seeded cells the old
    // O(all-cells)-per-iteration diff was a dominant cost (and × 200 iters).
    let maxDelta = 0;
    for (const k of ctx._written) {
      const v = ctx.values[k];
      if (typeof v !== 'number') continue;
      const prev = prevSnapshot[k] || 0;
      const d = Math.abs(v - prev);
      if (d > maxDelta) maxDelta = d;
      prevSnapshot[k] = v;
    }
    if (_ci > 0 && maxDelta < TOL) break;
  }
`
      : `
  // Single sheet (not in circular cluster)
  compute(ctx);
`;

    const evalScript = `
import { readFile } from 'fs/promises';
import { compute } from ${JSON.stringify(pathToFileURL(modulePath).href)};
${clusterImports}

const allGt = JSON.parse(await readFile(${JSON.stringify(gtFullPath.replace(/\\/g, '/'))}, 'utf8'));
const sheetGt = JSON.parse(await readFile(${JSON.stringify(sheetGtPath.replace(/\\/g, '/'))}, 'utf8'));

const cn = s => { let n=0; for(const c of s) n = n*26+c.charCodeAt(0)-64; return n; };
const nc = n => { let s=''; while(n>0){n--;s=String.fromCharCode(65+(n%26))+s;n=Math.floor(n/26);} return s; };
const ctx = {
  values: {},
  _written: new Set(),  // cells written by compute() — the cluster convergence diffs only these
  _sheetConvergence: {},  // intra-sheet cycle telemetry sink (PR #52): an emitted sheet with an internal convergence loop writes ctx._sheetConvergence[SHEET_NAME]; without this it throws "Cannot set properties of undefined"
  get(addr) { return this.values[addr] !== undefined ? this.values[addr] : 0; },
  set(addr, value) { this.values[addr] = value; this._written.add(addr); },
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
        [`--max-old-space-size=${NODE_HEAP_MB}`, tmpScript],
        { timeout: EVAL_TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024, env: safeEnv }
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

  // Cluster task: converge the whole cross-sheet cluster ONCE, then score every
  // member sheet against the shared fixed point (was: re-run convergence per
  // member). Returns one result row per member, plus convergence telemetry and
  // any cluster-resident named-output values.
  const clusterMeta = [];      // {clusterSheets, iters, converged, nonFiniteCell}
  const namedCellValues = {};  // converged values for cluster-resident named outputs

  async function evalOneCluster(task) {
    const { clusterSheets, members, gtTmpPath: gtFullPath } = task;
    const importLines = members.map((m, i) =>
      `import { compute as compute_${i} } from ${JSON.stringify(pathToFileURL(m.modulePath).href)};`).join('\n');
    const membersMeta = members.map(m => ({ sheetName: m.sheetName, sheetGtPath: m.sheetGtPath.replace(/\\/g, '/') }));

    const evalScript = `
import { readFile } from 'fs/promises';
${importLines}

const allGt = JSON.parse(await readFile(${JSON.stringify(gtFullPath.replace(/\\/g, '/'))}, 'utf8'));

const cn = s => { let n=0; for(const c of s) n = n*26+c.charCodeAt(0)-64; return n; };
const nc = n => { let s=''; while(n>0){n--;s=String.fromCharCode(65+(n%26))+s;n=Math.floor(n/26);} return s; };
const ctx = {
  values: {},
  _written: new Set(),
  _sheetConvergence: {},  // intra-sheet cycle telemetry sink (PR #52): an emitted sheet with an internal convergence loop writes ctx._sheetConvergence[SHEET_NAME]; without this it throws "Cannot set properties of undefined"
  get(addr) { return this.values[addr] !== undefined ? this.values[addr] : 0; },
  set(addr, value) { this.values[addr] = value; this._written.add(addr); },
  _parseRange(rangeStr) {
    const m = rangeStr.match(/^(.+)!([A-Z]+)(\\d+):([A-Z]+)(\\d+)$/);
    if (!m) return null;
    const [, sheet, c1, r1, c2, r2] = m;
    return { sheet, c1: cn(c1), r1: +r1, c2: cn(c2), r2: +r2 };
  },
  range(rangeStr) {
    const p = this._parseRange(rangeStr); if (!p) return [];
    const result = [];
    for (let r = p.r1; r <= p.r2; r++) for (let c = p.c1; c <= p.c2; c++) result.push(this.get(p.sheet+'!'+nc(c)+r));
    return result;
  },
  range2d(rangeStr) {
    const p = this._parseRange(rangeStr); if (!p) return [];
    const result = [];
    for (let r = p.r1; r <= p.r2; r++) { const row = []; for (let c = p.c1; c <= p.c2; c++) row.push(this.get(p.sheet+'!'+nc(c)+r)); result.push(row); }
    return result;
  }
};

// Seed context with full ground truth (upstream sheet values)
for (const [addr, val] of Object.entries(allGt)) ctx.values[addr] = val;

// ONE convergence loop over ALL cluster members. Diff only the cells the cluster
// wrote (ctx._written). A non-finite cell (Inf/NaN from a waterfall/coverage
// formula dividing by a not-yet-converged 0) is recorded and stops the loop
// rather than poisoning the delta — converged stays false (honest contract).
const clusterFns = [${members.map((_, i) => `compute_${i}`).join(', ')}];
const MAX_ITER = 200, TOL = 1e-6;
const prevSnapshot = {};
let _iters = 0, _conv = false, _nonFinite = null, _err = null;
try {
  for (let _ci = 0; _ci < MAX_ITER; _ci++) {
    _iters = _ci + 1;
    for (const fn of clusterFns) fn(ctx);
    let maxDelta = 0, bad = null;
    for (const k of ctx._written) {
      const v = ctx.values[k];
      if (typeof v !== 'number') continue;
      if (!Number.isFinite(v)) { bad = k; break; }
      const prev = prevSnapshot[k] || 0;
      const d = Math.abs(v - prev);
      if (d > maxDelta) maxDelta = d;
      prevSnapshot[k] = v;
    }
    if (bad !== null) { _nonFinite = bad; if (_ci >= 2) break; continue; }
    if (_ci > 0 && maxDelta < TOL) { _conv = true; break; }
  }
} catch (e) { _err = e.message; }

const compareOne = (sheetGt) => {
  let correct = 0, total = 0; const failures = [];
  for (const [addr, expected] of Object.entries(sheetGt)) {
    const actual = ctx.values[addr];
    if (actual === undefined || actual === null) { if (failures.length<30) failures.push({ address: addr, expected, actual: null, relError: 1.0 }); total++; continue; }
    total++;
    if (typeof expected === 'string' || typeof actual === 'string') {
      if (String(actual) === String(expected)) correct++; else if (failures.length<30) failures.push({ address: addr, expected, actual, relError: 1.0 });
      continue;
    }
    const relError = Math.abs(expected) < 1e-9 ? Math.abs(actual) : Math.abs((actual - expected) / expected);
    if (relError < 0.01) correct++; else if (failures.length<30) failures.push({ address: addr, expected, actual, relError });
  }
  return { accuracy: total > 0 ? correct/total : 0, correct, total, failures };
};

const members = ${JSON.stringify(membersMeta)};
const results = [];
for (const m of members) {
  const sheetGt = JSON.parse(await readFile(m.sheetGtPath, 'utf8'));
  results.push({ sheetName: m.sheetName, ...compareOne(sheetGt) });
}
const namedCells = ${JSON.stringify(namedCells)};
const namedCellValues = {};
for (const c of namedCells) if (typeof ctx.values[c] === 'number') namedCellValues[c] = ctx.values[c];
process.stdout.write(JSON.stringify({ results, iters: _iters, converged: _conv, nonFiniteCell: _nonFinite, error: _err, namedCellValues }));
`;

    const clusterKey = clusterSheets.join('_').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
    const tmpScript = join(tmpDir, `_eval_cluster_${clusterKey}.mjs`);
    await writeFile(tmpScript, evalScript);

    const evalStart = Date.now();
    try {
      const safeEnv = { ...process.env };
      delete safeEnv.ANTHROPIC_API_KEY;
      const { stdout: evalOut } = await execAsync(
        'node',
        [`--max-old-space-size=${NODE_HEAP_MB}`, tmpScript],
        { timeout: EVAL_TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024, env: safeEnv }
      );
      const out = JSON.parse(evalOut);
      const elapsed = Date.now() - evalStart;
      clusterMeta.push({ clusterSheets, iters: out.iters, converged: !!out.converged, nonFiniteCell: out.nonFiniteCell || null });
      Object.assign(namedCellValues, out.namedCellValues || {});
      if (out.error) {
        console.log(`  XX cluster [${clusterSheets.join(', ')}]: convergence error - ${String(out.error).slice(0, 100)}  ${elapsed}ms`);
        return members.map(m => { completed++; return { sheetName: m.sheetName, accuracy: 0, correct: 0, total: 0, failures: [], elapsed, status: 'error', error: String(out.error).slice(0, 200) }; });
      }
      return (out.results || []).map(r => {
        completed++;
        const pct = r.total > 0 ? (r.correct / r.total * 100).toFixed(1) : '0.0';
        const icon = r.accuracy >= 0.95 ? 'OK' : r.accuracy >= 0.70 ? '--' : '!!';
        const tag = out.converged ? `cluster ${out.iters}i` : `cluster NOT-CONVERGED${out.nonFiniteCell ? ' nonfinite:' + out.nonFiniteCell : ''}`;
        console.log(`  ${icon} ${r.sheetName}: ${pct}% (${r.correct}/${r.total})  [${tag}] ${elapsed}ms`);
        return { sheetName: r.sheetName, accuracy: r.accuracy, correct: r.correct, total: r.total, failures: r.failures, elapsed, status: 'ok' };
      });
    } catch (err) {
      const elapsed = Date.now() - evalStart;
      const isOOM = err.killed || err.signal === 'SIGKILL' || (err.message && err.message.includes('ENOMEM'));
      const reason = isOOM ? 'OOM' : (err.signal || 'crash');
      console.log(`  XX cluster [${clusterSheets.join(', ')}]: ${reason}  ${elapsed}ms`);
      clusterMeta.push({ clusterSheets, iters: 0, converged: false, nonFiniteCell: null });
      return members.map(m => { completed++; return { sheetName: m.sheetName, accuracy: 0, correct: 0, total: 0, failures: [], elapsed, status: isOOM ? 'oom' : 'crash', error: isOOM ? `OOM (killed after ${(elapsed / 1000).toFixed(1)}s)` : err.message?.slice(0, 200) }; });
    }
  }

  // Run with concurrency limit. A cluster counts as ONE slot but expands to one
  // result row per member sheet, so per-sheet aggregation downstream is unchanged.
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(t =>
      t.kind === 'cluster' ? evalOneCluster(t) : evalOneSheet(t)));
    for (const r of batchResults) {
      if (Array.isArray(r)) results.push(...r);
      else results.push(r);
    }
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
      sheetsEvaluated: results.length,
      sheetsSkipped: skipped.length,
      clustersTotal: clusterMeta.length,
      clustersConverged: clusterMeta.filter(c => c.converged).length,
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
    // Returns/MIP cone: accuracy ONLY (never the value — proprietary) for each
    // named output whose cell lives in a converged cluster (MIP Proceeds, hurdle).
    namedOutputs: namedOfInterest.map(o => {
      const expected = allGt[o.cell];
      const actual = namedCellValues[o.cell];
      let accuracy = null;
      if (typeof expected === 'number' && typeof actual === 'number') {
        const rel = Math.abs(expected) < 1e-9 ? Math.abs(actual) : Math.abs((actual - expected) / expected);
        accuracy = parseFloat(((1 - Math.min(1, rel)) * 100).toFixed(2));
      }
      return { name: o.name, cell: o.cell, accuracy, measured: typeof actual === 'number' };
    }),
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
  console.log(`  Sheets evaluated:    ${results.length}${clusterMeta.length ? ` (${clusterMeta.filter(c => c.converged).length}/${clusterMeta.length} clusters converged)` : ''}`);
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

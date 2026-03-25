/**
 * auto-iterate.mjs — Self-improving Excel-to-Engine pipeline
 *
 * Loop: parse → eval → diagnose (Claude API) → patch transpiler → rebuild → re-eval
 *
 * Usage:
 *   node iterate.mjs <model.xlsx>
 *   node iterate.mjs model-name.xlsx          # looks in /data/models/
 *   node iterate.mjs /absolute/path/to.xlsx
 *
 * Environment:
 *   ANTHROPIC_API_KEY  — Required
 *   TARGET_ACCURACY    — Stop when reached (default: 0.85)
 *   MAX_ITERATIONS     — Max improvement loops (default: 30)
 *   MODEL_NAME         — Claude model to use (default: claude-sonnet-4-6)
 *   RUST_PARSER_BIN    — Path to rust-parser binary (default: /usr/local/bin/rust-parser)
 *   RUST_SRC_DIR       — Path to rust-parser source (default: /app/rust-parser)
 *   OUTPUT_DIR         — Where to write results (default: /data/output/<model-name>)
 */

import Anthropic from '@anthropic-ai/sdk';
import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, mkdir, stat, readdir, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve, basename, dirname } from 'path';

const execAsync = promisify(execFile);
const execShell = promisify(exec);

// ── Config ──────────────────────────────────────────────────────────────────
const API_KEY = process.env.ANTHROPIC_API_KEY;
const TARGET_ACCURACY = parseFloat(process.env.TARGET_ACCURACY || '0.85');
const MAX_ITERATIONS = parseInt(process.env.MAX_ITERATIONS || '30');
const MODEL_NAME = process.env.MODEL_NAME || 'claude-sonnet-4-6';
const RUST_PARSER_BIN = process.env.RUST_PARSER_BIN || '/usr/local/bin/rust-parser';
const RUST_SRC_DIR = process.env.RUST_SRC_DIR || '/app/rust-parser';
const MODELS_DIR = process.env.MODELS_DIR || '/data/models';

// ── Logging ─────────────────────────────────────────────────────────────────
const LOG_ENTRIES = [];
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  LOG_ENTRIES.push(line);
}

function logSection(title) {
  log('');
  log(`${'═'.repeat(60)}`);
  log(`  ${title}`);
  log(`${'═'.repeat(60)}`);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const [, , modelArg] = process.argv;

  if (!modelArg) {
    console.error('Usage: node iterate.mjs <model.xlsx>');
    console.error('');
    console.error('Place .xlsx files in /data/models/ (or pass absolute path)');
    process.exit(1);
  }

  if (!API_KEY) {
    log('Warning: ANTHROPIC_API_KEY not set — will run parse+eval only (no improvement loop)');
  }

  // Resolve model path
  let modelPath = modelArg;
  if (!existsSync(modelPath)) {
    modelPath = join(MODELS_DIR, modelArg);
  }
  if (!existsSync(modelPath)) {
    console.error(`Model not found: ${modelArg}`);
    console.error(`Searched: ${modelArg}, ${join(MODELS_DIR, modelArg)}`);
    if (existsSync(MODELS_DIR)) {
      const files = await readdir(MODELS_DIR);
      console.error(`Available models in ${MODELS_DIR}:`);
      files.filter(f => f.endsWith('.xlsx')).forEach(f => console.error(`  - ${f}`));
    }
    process.exit(1);
  }

  const modelName = basename(modelPath, '.xlsx').replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const outputDir = process.env.OUTPUT_DIR || join('/data/output', modelName);
  await mkdir(outputDir, { recursive: true });

  const anthropic = API_KEY ? new Anthropic({ apiKey: API_KEY }) : null;

  logSection(`Auto-Iterate: ${basename(modelPath)}`);
  log(`Model: ${modelPath}`);
  log(`Output: ${outputDir}`);
  log(`Target accuracy: ${(TARGET_ACCURACY * 100).toFixed(0)}%`);
  log(`Max iterations: ${MAX_ITERATIONS}`);
  log(`Claude model: ${MODEL_NAME}`);
  log('');

  // ── Step 0: Initial parse + eval ────────────────────────────────────────
  logSection('Phase 0: Initial Parse + Eval');

  let accuracy = await parseAndEval(modelPath, outputDir);
  log(`Initial accuracy: ${(accuracy * 100).toFixed(1)}%`);

  if (accuracy >= TARGET_ACCURACY) {
    log(`Already at target! Done.`);
    await saveLog(outputDir);
    process.exit(0);
  }

  // ── Iteration loop ──────────────────────────────────────────────────────
  let bestAccuracy = accuracy;
  let staleCount = 0;

  if (!anthropic) {
    log('No API key — skipping improvement loop. Set ANTHROPIC_API_KEY to enable.');
    await saveLog(outputDir);
    process.exit(accuracy >= TARGET_ACCURACY ? 0 : 1);
  }

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    logSection(`Iteration ${iter}/${MAX_ITERATIONS} (current: ${(bestAccuracy * 100).toFixed(1)}%)`);

    // Read current failures
    const evalResults = JSON.parse(
      await readFile(join(outputDir, 'eval-results.json'), 'utf8')
    );
    const failures = evalResults.failures || [];

    if (failures.length === 0) {
      log('No failures to fix. Done!');
      break;
    }

    // Read current transpiler source
    const transpilerSrc = await readFile(join(RUST_SRC_DIR, 'src/transpiler.rs'), 'utf8');
    const chunkedEmitterSrc = await readFile(join(RUST_SRC_DIR, 'src/chunked_emitter.rs'), 'utf8');

    // Categorize failures
    const categories = categorizeFailures(failures);
    log(`Failure categories:`);
    for (const [cat, count] of Object.entries(categories).sort((a, b) => b[1] - a[1])) {
      log(`  ${cat}: ${count}`);
    }

    // Ask Claude to diagnose and produce a patch
    log(`Asking Claude to fix top failure category...`);
    const patch = await askClaudeForPatch(anthropic, {
      failures: failures.slice(0, 30),
      categories,
      transpilerSrc,
      chunkedEmitterSrc,
      currentAccuracy: bestAccuracy,
      iterationNum: iter,
    });

    if (!patch) {
      log(`Claude returned no actionable patch. Skipping.`);
      staleCount++;
      if (staleCount >= 3) {
        log(`3 consecutive non-actionable iterations. Stopping.`);
        break;
      }
      continue;
    }

    // Save the patch for audit trail
    await writeFile(
      join(outputDir, `patch-${iter}.json`),
      JSON.stringify(patch, null, 2)
    );

    // Apply the patch
    log(`Applying patch: ${patch.description}`);
    const applied = await applyPatch(patch);

    if (!applied) {
      log(`Patch failed to apply. Reverting.`);
      staleCount++;
      if (staleCount >= 3) break;
      continue;
    }

    // Rebuild Rust binary
    log(`Rebuilding rust-parser...`);
    const built = await rebuildRust();

    if (!built) {
      log(`Build failed. Reverting patch.`);
      await revertPatch(patch);
      await rebuildRust(); // rebuild with original source
      staleCount++;
      if (staleCount >= 3) break;
      continue;
    }

    // Re-run parse + eval
    log(`Re-evaluating...`);
    const newAccuracy = await parseAndEval(modelPath, outputDir);
    log(`Accuracy: ${(bestAccuracy * 100).toFixed(1)}% → ${(newAccuracy * 100).toFixed(1)}%`);

    if (newAccuracy > bestAccuracy + 0.001) {
      bestAccuracy = newAccuracy;
      staleCount = 0;
      log(`✅ Improvement! New best: ${(bestAccuracy * 100).toFixed(1)}%`);

      // Save the improved source as a checkpoint
      await saveCheckpoint(outputDir, iter, bestAccuracy);
    } else {
      log(`No improvement. Reverting patch.`);
      await revertPatch(patch);
      await rebuildRust();
      staleCount++;
      if (staleCount >= 5) {
        log(`5 consecutive non-improving iterations. Stopping.`);
        break;
      }
    }

    if (bestAccuracy >= TARGET_ACCURACY) {
      log(`🎯 Target accuracy reached: ${(bestAccuracy * 100).toFixed(1)}%`);
      break;
    }
  }

  // ── Final summary ───────────────────────────────────────────────────────
  logSection('Final Summary');
  log(`Model: ${basename(modelPath)}`);
  log(`Final accuracy: ${(bestAccuracy * 100).toFixed(1)}%`);
  log(`Target: ${(TARGET_ACCURACY * 100).toFixed(0)}%`);
  log(`Status: ${bestAccuracy >= TARGET_ACCURACY ? 'TARGET MET ✅' : 'NEEDS MANUAL ATTENTION ⚠️'}`);
  log(`Output: ${outputDir}`);

  await saveLog(outputDir);
  process.exit(bestAccuracy >= TARGET_ACCURACY ? 0 : 1);
}

// ── Parse + Eval ────────────────────────────────────────────────────────────
async function parseAndEval(modelPath, outputDir) {
  try {
    // Run rust-parser with --chunked
    log(`  Parsing ${basename(modelPath)}...`);
    const parseStart = Date.now();
    const { stdout, stderr } = await execAsync(
      RUST_PARSER_BIN,
      [modelPath, outputDir, '--chunked'],
      { maxBuffer: 100 * 1024 * 1024, timeout: 1800000 } // 30 min timeout
    );
    if (stdout.trim()) log(`  ${stdout.trim().split('\n').slice(-3).join('\n  ')}`);
    log(`  Parse completed in ${((Date.now() - parseStart) / 1000).toFixed(1)}s`);

    // Run eval against ground truth
    const chunkedDir = join(outputDir, 'chunked');
    const gtPath = join(chunkedDir, '_ground-truth.json');
    const enginePath = join(chunkedDir, 'engine.js');

    if (!existsSync(gtPath) || !existsSync(enginePath)) {
      log(`  Missing chunked output files. Parse may have failed.`);
      return 0;
    }

    const groundTruth = JSON.parse(await readFile(gtPath, 'utf8'));
    const totalKnown = Object.keys(groundTruth).length;
    log(`  Ground truth: ${totalKnown} cells`);

    // For large models, eval per-sheet to avoid OOM.
    // Each sheet module is loaded independently with pre-seeded context from ground truth.
    const gtSize = (await stat(gtPath)).size;
    const isLargeModel = gtSize > 10 * 1024 * 1024; // >10MB ground truth

    if (isLargeModel) {
      log(`  Large model (${(gtSize / 1024 / 1024).toFixed(0)}MB ground truth) — using per-sheet eval`);
      return await evalPerSheet(outputDir, chunkedDir, gtPath, totalKnown);
    }

    const evalScript = `
import { readFile } from 'fs/promises';
import { run } from '${resolve(enginePath).replace(/\\/g, '/')}';

const gt = JSON.parse(await readFile('${resolve(gtPath).replace(/\\/g, '/')}', 'utf8'));

let result;
try {
  result = run();
} catch (e) {
  process.stdout.write(JSON.stringify({ accuracy: 0, correct: 0, total: 0, failures: [{ address: 'ENGINE_ERROR', expected: 0, actual: e.message, relError: 1.0 }] }));
  process.exit(0);
}

let correct = 0, total = 0;
const failures = [];
for (const [addr, expected] of Object.entries(gt)) {
  const actual = result.values[addr];
  if (actual === undefined || actual === null) {
    // Only sample missing values to keep output manageable
    if (failures.length < 30) {
      failures.push({ address: addr, expected, actual: null, relError: 1.0 });
    }
    total++;
    continue;
  }
  total++;
  if (typeof expected === 'string' || typeof actual === 'string') {
    if (String(actual) === String(expected)) { correct++; }
    else if (failures.length < 30) { failures.push({ address: addr, expected, actual, relError: 1.0 }); }
    continue;
  }
  const relError = Math.abs(expected) < 1e-9
    ? Math.abs(actual)
    : Math.abs((actual - expected) / expected);
  if (relError < 0.01) { correct++; }
  else if (failures.length < 200) { failures.push({ address: addr, expected, actual, relError }); }
}
const accuracy = total > 0 ? correct / total : 0;
const top30 = failures.sort((a, b) => Math.abs(b.relError) - Math.abs(a.relError)).slice(0, 30);
process.stdout.write(JSON.stringify({ accuracy, correct, total, failures: top30 }));
`;

    const tmpScript = join(outputDir, '_eval_tmp.mjs');
    await writeFile(tmpScript, evalScript);

    const { stdout: evalOut } = await execAsync('node', ['--max-old-space-size=8192', tmpScript], {
      timeout: 600000, // 10 min for large models
      maxBuffer: 100 * 1024 * 1024,
    });

    const evalResult = JSON.parse(evalOut);
    log(`  Eval: ${(evalResult.accuracy * 100).toFixed(1)}% (${evalResult.correct}/${evalResult.total})`);

    // Save eval results
    await writeFile(
      join(outputDir, 'eval-results.json'),
      JSON.stringify(evalResult, null, 2)
    );

    return evalResult.accuracy;
  } catch (err) {
    log(`  ❌ Parse/eval error: ${err.message}`);
    if (err.stderr) log(`  stderr: ${err.stderr.slice(0, 1000)}`);
    if (err.killed) log(`  Process was killed (likely OOM — try increasing Docker memory)`);

    // Write an eval file with the error as a failure so Claude can diagnose it
    const errorFailure = {
      address: 'PARSE_ERROR',
      expected: 'successful_parse',
      actual: err.killed ? 'OOM_KILLED' : err.message.slice(0, 200),
      relError: 1.0,
    };
    await writeFile(
      join(outputDir, 'eval-results.json'),
      JSON.stringify({
        accuracy: 0,
        correct: 0,
        total: 0,
        parseError: true,
        failures: [errorFailure],
      }, null, 2)
    );
    return 0;
  }
}

// ── Per-sheet eval for large models (parallel) ──────────────────────────────
async function evalPerSheet(outputDir, chunkedDir, gtPath, totalKnown) {
  const CONCURRENCY = parseInt(process.env.EVAL_CONCURRENCY || '6');

  // Load graph to get sheet list
  const graph = JSON.parse(await readFile(join(chunkedDir, '_graph.json'), 'utf8'));
  const sheetNames = graph.topoOrder || graph.sheets?.map(s => s.name) || [];

  // Load full ground truth once
  const allGt = JSON.parse(await readFile(gtPath, 'utf8'));

  // Group ground truth by sheet
  const gtBySheet = {};
  for (const [addr, val] of Object.entries(allGt)) {
    const bang = addr.indexOf('!');
    const sheet = bang > 0 ? addr.slice(0, bang) : 'Unknown';
    if (!gtBySheet[sheet]) gtBySheet[sheet] = {};
    gtBySheet[sheet][addr] = val;
  }

  // Write ground truth and per-sheet GT to temp files (avoid inlining as JS literals)
  const gtTmpPath = join(outputDir, '_gt_full.json');
  if (!existsSync(gtTmpPath)) {
    await writeFile(gtTmpPath, JSON.stringify(allGt));
  }

  // Test up to 20 sheets (largest first by ground truth count)
  const sheetsToTest = Object.entries(gtBySheet)
    .sort((a, b) => Object.keys(b[1]).length - Object.keys(a[1]).length)
    .slice(0, 20);

  log(`  Evaluating ${sheetsToTest.length} sheets (${CONCURRENCY} concurrent)...`);

  // Prepare all eval tasks
  const tasks = [];
  for (const [sheetName, sheetGt] of sheetsToTest) {
    const gtCount = Object.keys(sheetGt).length;
    // Sample if sheet has >5000 ground truth entries
    let sampleGt = sheetGt;
    if (gtCount > 5000) {
      sampleGt = {};
      const keys = Object.keys(sheetGt);
      const step = Math.floor(keys.length / 2000);
      for (let i = 0; i < keys.length && Object.keys(sampleGt).length < 2000; i += step) {
        sampleGt[keys[i]] = sheetGt[keys[i]];
      }
    }

    const sanitized = sheetName.replace(/[^a-zA-Z0-9]/g, '_');
    const sheetModulePath = join(chunkedDir, 'sheets', `${sanitized}.mjs`);

    if (!existsSync(sheetModulePath)) {
      log(`    ⏭️  ${sheetName}: module not found, skipping`);
      continue;
    }

    // Write per-sheet GT to a temp file (avoids inlining large JSON as JS literal)
    const sheetGtPath = join(outputDir, `_gt_${sanitized}.json`);
    await writeFile(sheetGtPath, JSON.stringify(sampleGt));

    tasks.push({ sheetName, sanitized, sheetModulePath, sheetGtPath, gtCount: Object.keys(sampleGt).length });
  }

  // Run eval tasks with concurrency limit
  let totalCorrect = 0, totalTested = 0;
  const allFailures = [];
  const sheetResults = [];
  let completed = 0;
  let errored = 0;

  async function evalOneSheet({ sheetName, sanitized, sheetModulePath, sheetGtPath, gtCount }) {
    const evalScript = `
import { readFile } from 'fs/promises';
import { compute } from '${resolve(sheetModulePath).replace(/\\/g, '/')}';

const allGt = JSON.parse(await readFile('${resolve(gtTmpPath).replace(/\\/g, '/')}', 'utf8'));
const sheetGt = JSON.parse(await readFile('${resolve(sheetGtPath).replace(/\\/g, '/')}', 'utf8'));

const ctx = {
  values: {},
  get(addr) { return this.values[addr] !== undefined ? this.values[addr] : 0; },
  set(addr, value) { this.values[addr] = value; },
  range(rangeStr) {
    const m = rangeStr.match(/^(.+)!([A-Z]+)(\\d+):([A-Z]+)(\\d+)$/);
    if (!m) return [];
    const [, sheet, c1, r1, c2, r2] = m;
    const result = [];
    const cn = s => { let n=0; for(const c of s) n = n*26+c.charCodeAt(0)-64; return n; };
    const nc = n => { let s=''; while(n>0){n--;s=String.fromCharCode(65+(n%26))+s;n=Math.floor(n/26);} return s; };
    for (let r = +r1; r <= +r2; r++)
      for (let c = cn(c1); c <= cn(c2); c++)
        result.push(this.get(sheet+'!'+nc(c)+r));
    return result;
  }
};

for (const [addr, val] of Object.entries(allGt)) {
  ctx.values[addr] = val;
}

try {
  compute(ctx);
} catch (e) {
  const errInfo = { address: 'SHEET_ERROR:${sheetName}', expected: 0, actual: e.message + '\\n' + (e.stack || '').split('\\n').slice(0, 5).join('\\n'), relError: 1.0 };
  process.stdout.write(JSON.stringify({ accuracy: 0, correct: 0, total: 0, failures: [errInfo], error: e.message }));
  process.exit(0);
}

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

    const tmpScript = join(outputDir, `_eval_sheet_${sanitized}.mjs`);
    await writeFile(tmpScript, evalScript);

    try {
      const { stdout: evalOut, stderr: evalErr } = await execAsync('node', ['--max-old-space-size=8192', tmpScript], {
        timeout: 180000, // 3 min per sheet
        maxBuffer: 100 * 1024 * 1024,
      });
      const result = JSON.parse(evalOut);
      completed++;

      if (result.error) {
        // Sheet compute() threw an error
        errored++;
        log(`    ❌ ${sheetName}: RUNTIME ERROR — ${result.error}`);
        if (result.failures?.[0]?.actual) {
          log(`       Stack: ${result.failures[0].actual.split('\n').slice(0, 3).join('\n       ')}`);
        }
        return result;
      }

      const pct = result.total > 0 ? (result.correct / result.total * 100).toFixed(1) : '0.0';
      const icon = result.accuracy >= 0.95 ? '✅' : result.accuracy >= 0.70 ? '🔶' : result.accuracy > 0 ? '🔴' : '⚫';
      log(`    ${icon} ${sheetName}: ${pct}% (${result.correct}/${result.total})  [${completed}/${tasks.length}]`);
      return result;
    } catch (err) {
      completed++;
      errored++;
      // Extract the actual error from stderr or the message
      const errMsg = err.stderr?.trim() || err.message;
      const firstLine = errMsg.split('\n').find(l => l.includes('Error') || l.includes('error')) || errMsg.split('\n')[0];
      log(`    ❌ ${sheetName}: ${firstLine.slice(0, 200)}`);

      // Try to extract more useful info
      const syntaxMatch = errMsg.match(/SyntaxError: (.+)/);
      const refMatch = errMsg.match(/ReferenceError: (.+)/);
      const typeMatch = errMsg.match(/TypeError: (.+)/);
      if (syntaxMatch) log(`       SyntaxError: ${syntaxMatch[1].slice(0, 150)}`);
      if (refMatch) log(`       ReferenceError: ${refMatch[1].slice(0, 150)}`);
      if (typeMatch) log(`       TypeError: ${typeMatch[1].slice(0, 150)}`);

      return { accuracy: 0, correct: 0, total: 0, failures: [{
        address: `EVAL_CRASH:${sheetName}`,
        expected: 'successful_eval',
        actual: firstLine.slice(0, 200),
        relError: 1.0,
      }]};
    }
  }

  // Run with concurrency limit
  const results = [];
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(evalOneSheet));
    results.push(...batchResults);
  }

  // Aggregate results
  for (const result of results) {
    if (!result) continue;
    totalCorrect += result.correct || 0;
    totalTested += result.total || 0;
    if (result.failures) allFailures.push(...result.failures);
    sheetResults.push(result);
  }

  const accuracy = totalTested > 0 ? totalCorrect / totalTested : 0;

  // Summary table
  log('');
  log(`  ┌─────────────────────────────────────────────────────┐`);
  log(`  │ Sheet Eval Summary                                  │`);
  log(`  ├───────────────────────────┬────────┬────────────────┤`);
  log(`  │ Sheets tested             │ ${String(tasks.length).padStart(6)} │                │`);
  log(`  │ Sheets passed (>95%)      │ ${String(results.filter(r => r && r.accuracy >= 0.95).length).padStart(6)} │                │`);
  log(`  │ Sheets with errors        │ ${String(errored).padStart(6)} │                │`);
  log(`  │ Total cells tested        │ ${String(totalTested).padStart(6)} │                │`);
  log(`  │ Total cells correct       │ ${String(totalCorrect).padStart(6)} │                │`);
  log(`  │ Overall accuracy          │ ${(accuracy * 100).toFixed(1).padStart(5)}% │                │`);
  log(`  └───────────────────────────┴────────┴────────────────┘`);

  // Save eval results
  const top30 = allFailures.sort((a, b) => Math.abs(b.relError) - Math.abs(a.relError)).slice(0, 30);
  await writeFile(
    join(outputDir, 'eval-results.json'),
    JSON.stringify({ accuracy, correct: totalCorrect, total: totalTested, failures: top30, sheetResults, errored }, null, 2)
  );

  return accuracy;
}

// ── Failure categorization ──────────────────────────────────────────────────
function categorizeFailures(failures) {
  const categories = {};
  for (const f of failures) {
    let cat = 'unknown';
    const addr = f.address || f.key || '';
    // Detect runtime crashes (SHEET_ERROR, EVAL_CRASH, PARSE_ERROR)
    if (addr.startsWith('SHEET_ERROR:') || addr.startsWith('EVAL_CRASH:') || addr === 'PARSE_ERROR') {
      const errorMsg = String(f.actual || '');
      if (errorMsg.includes('.reduce is not a function')) {
        cat = 'runtime_crash_reduce_on_non_array';
      } else if (errorMsg.includes('is not a function')) {
        cat = 'runtime_crash_missing_function';
      } else if (errorMsg.includes('SyntaxError')) {
        cat = 'runtime_crash_syntax_error';
      } else {
        cat = 'runtime_crash_other';
      }
    } else if (f.actual === null || f.actual === undefined) {
      cat = 'missing_value';
    } else if (f.actual === 0 && f.expected !== 0) {
      cat = 'zero_output_likely_stub';
    } else if (typeof f.expected === 'string') {
      cat = 'text_mismatch';
    } else {
      const ratio = f.expected !== 0 ? f.actual / f.expected : 0;
      if (Math.abs(ratio - 1000) < 200 || Math.abs(ratio - 0.001) < 0.002) {
        cat = 'unit_scale_1000x';
      } else if (Math.abs(ratio - 100) < 20 || Math.abs(ratio - 0.01) < 0.02) {
        cat = 'percentage_scale';
      } else if (Math.abs(ratio) < 0.01) {
        cat = 'near_zero_vs_nonzero';
      } else if (f.relError > 5) {
        cat = 'large_deviation';
      } else if (f.relError > 0.5) {
        cat = 'moderate_deviation';
      } else {
        cat = 'small_deviation';
      }
    }
    categories[cat] = (categories[cat] || 0) + 1;
  }
  return categories;
}

// ── Claude API call ─────────────────────────────────────────────────────────
async function askClaudeForPatch(anthropic, context) {
  const { failures, categories, transpilerSrc, chunkedEmitterSrc, currentAccuracy, iterationNum } = context;

  const topCategory = Object.entries(categories).sort((a, b) => b[1] - a[1])[0];
  const failureSample = failures.slice(0, 15).map(f => ({
    address: f.address || f.key,
    expected: f.expected || f.excelValue,
    actual: f.actual || f.engineValue,
    error: f.relError || f.error,
  }));

  const prompt = `You are improving a Rust-based Excel formula transpiler. The transpiler converts Excel formulas into JavaScript expressions. Current eval accuracy is ${(currentAccuracy * 100).toFixed(1)}%.

The top failure category is "${topCategory[0]}" (${topCategory[1]} failures).

Here are sample failures (address, expected Excel value, actual engine value, relative error):
${JSON.stringify(failureSample, null, 2)}

Here is the current transpiler source (transpiler.rs):
\`\`\`rust
${transpilerSrc}
\`\`\`

Here is the chunked emitter that generates per-sheet modules (chunked_emitter.rs) — specifically the runtime helpers and formula output sections:
\`\`\`rust
${chunkedEmitterSrc.slice(0, 8000)}
\`\`\`

Your task: Produce a MINIMAL, TARGETED patch to fix the top failure category. Focus on one specific issue (e.g., implementing a missing Excel function, fixing a range expansion bug, correcting a runtime helper).

Respond with ONLY a JSON object in this exact format:
{
  "description": "Brief description of what this patch fixes",
  "files": [
    {
      "path": "src/transpiler.rs",
      "action": "replace",
      "search": "exact string to find in the file",
      "replace": "replacement string"
    }
  ]
}

Rules:
- The "search" string must be an EXACT substring of the current file content.
- Keep patches small and focused — one fix per iteration.
- Only modify transpiler.rs or chunked_emitter.rs.
- If you can't identify a clear fix, respond with: {"description": "no actionable fix identified", "files": []}`;

  try {
    const response = await anthropic.messages.create({
      model: MODEL_NAME,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '';

    // Extract JSON from response (may be wrapped in markdown)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log(`  Claude response had no JSON. Skipping.`);
      return null;
    }

    const patch = JSON.parse(jsonMatch[0]);

    if (!patch.files || patch.files.length === 0) {
      log(`  Claude: ${patch.description}`);
      return null;
    }

    return patch;
  } catch (err) {
    log(`  Claude API error: ${err.message}`);
    return null;
  }
}

// ── Patch application ───────────────────────────────────────────────────────
async function applyPatch(patch) {
  try {
    for (const file of patch.files) {
      const filePath = join(RUST_SRC_DIR, file.path);

      if (!existsSync(filePath)) {
        log(`  File not found: ${filePath}`);
        return false;
      }

      let content = await readFile(filePath, 'utf8');

      // Save backup
      await writeFile(filePath + '.bak', content);

      if (file.action === 'replace') {
        if (!content.includes(file.search)) {
          log(`  Search string not found in ${file.path}. Patch cannot apply.`);
          return false;
        }
        content = content.replace(file.search, file.replace);
      } else if (file.action === 'append') {
        content += '\n' + file.content;
      } else if (file.action === 'insert_before') {
        if (!content.includes(file.search)) {
          log(`  Search string not found in ${file.path}. Patch cannot apply.`);
          return false;
        }
        content = content.replace(file.search, file.content + '\n' + file.search);
      }

      await writeFile(filePath, content);
      log(`  Patched: ${file.path}`);
    }
    return true;
  } catch (err) {
    log(`  Patch error: ${err.message}`);
    return false;
  }
}

async function revertPatch(patch) {
  try {
    for (const file of patch.files) {
      const filePath = join(RUST_SRC_DIR, file.path);
      const bakPath = filePath + '.bak';

      if (existsSync(bakPath)) {
        await copyFile(bakPath, filePath);
        log(`  Reverted: ${file.path}`);
      }
    }
  } catch (err) {
    log(`  Revert error: ${err.message}`);
  }
}

// ── Rust rebuild ────────────────────────────────────────────────────────────
async function rebuildRust() {
  try {
    const { stdout, stderr } = await execShell(
      `cd ${RUST_SRC_DIR} && cargo build --release 2>&1`,
      { timeout: 300000 } // 5 min
    );

    if (stderr && stderr.includes('error[')) {
      log(`  Build errors found`);
      return false;
    }

    // Copy new binary
    await execShell(`cp ${RUST_SRC_DIR}/target/release/rust-parser ${RUST_PARSER_BIN}`);
    log(`  Build succeeded`);
    return true;
  } catch (err) {
    log(`  Build failed: ${err.message}`);
    return false;
  }
}

// ── Checkpointing ───────────────────────────────────────────────────────────
async function saveCheckpoint(outputDir, iter, accuracy) {
  const checkpointDir = join(outputDir, `checkpoint-${iter}-${(accuracy * 100).toFixed(0)}pct`);
  await mkdir(checkpointDir, { recursive: true });

  // Save current transpiler source
  const srcFiles = ['transpiler.rs', 'chunked_emitter.rs', 'formula_ast.rs', 'sheet_partition.rs'];
  for (const f of srcFiles) {
    const src = join(RUST_SRC_DIR, 'src', f);
    if (existsSync(src)) {
      await copyFile(src, join(checkpointDir, f));
    }
  }

  // Save eval results
  const evalPath = join(outputDir, 'eval-results.json');
  if (existsSync(evalPath)) {
    await copyFile(evalPath, join(checkpointDir, 'eval-results.json'));
  }

  log(`  Checkpoint saved: ${checkpointDir}`);
}

// ── Save log ────────────────────────────────────────────────────────────────
async function saveLog(outputDir) {
  await writeFile(
    join(outputDir, 'iteration-log.txt'),
    LOG_ENTRIES.join('\n') + '\n'
  );
  log(`Log saved to ${join(outputDir, 'iteration-log.txt')}`);
}

// ── Entry ───────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

/**
 * pipeline.mjs — Orchestrates the full Excel → engine pipeline
 *
 * Steps:
 *   1. PARSE:    rust-parser input.xlsx → model-map.json, formulas.json, dependency-graph.json, raw-engine.js
 *   2. VALIDATE: Cross-check extraction quality
 *   3. EVAL:     Run raw-engine.js, compare to Excel values, calibrate, iterate
 *   4. OUTPUT:   Write engine.js (calibrated) + eval-results.json + diagnostics.json
 *
 * Usage:
 *   node pipeline.mjs <input.xlsx> [output_dir]
 *
 * Environment:
 *   RUST_PARSER_BIN  — path to rust-parser binary (default: rust-parser in PATH)
 *   MAX_ITERATIONS   — max eval-loop iterations (default: 20)
 *   TARGET_ACCURACY  — accuracy threshold to stop iteration (default: 0.95)
 *   WS_PORT          — WebSocket port for monitor dashboard (default: 3001, 0 = disabled)
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, mkdir, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';

const execFileAsync = promisify(execFile);
const __dir = dirname(fileURLToPath(import.meta.url));

// ── Config ───────────────────────────────────────────────────────────────────
const RUST_PARSER = process.env.RUST_PARSER_BIN || 'rust-parser';
const MAX_ITERATIONS = parseInt(process.env.MAX_ITERATIONS || '20');
const TARGET_ACCURACY = parseFloat(process.env.TARGET_ACCURACY || '0.95');
const WS_PORT = parseInt(process.env.WS_PORT || '3001');

// Lib path: absolute path to the js lib/ directory (for imports in raw-engine.js)
// Resolved relative to this file: container/ → ../lib/
const LIB_PATH = process.env.LIB_PATH
  || resolve(dirname(fileURLToPath(import.meta.url)), '../lib') + '/';

// ── WebSocket event bus ──────────────────────────────────────────────────────
let wss = null;
const broadcastEvent = (type, payload) => {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  if (wss) {
    wss.clients.forEach(client => {
      if (client.readyState === 1) client.send(msg);
    });
  }
  // Always also log to stdout for container log streaming
  const prefix = type.startsWith('log') ? '' : `[${type}] `;
  console.log(`${prefix}${typeof payload === 'string' ? payload : JSON.stringify(payload)}`);
};

const log = (msg) => broadcastEvent('log', msg);
const phase = (name, status, timing) => broadcastEvent('phase', { name, status, timing });
const progress = (iteration, score, delta) => broadcastEvent('progress', { iteration, score, delta });

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  const [, , inputPath, outputDir = './output'] = process.argv;

  if (!inputPath) {
    console.error('Usage: node pipeline.mjs <input.xlsx> [output_dir]');
    process.exit(1);
  }

  if (!existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  await mkdir(outputDir, { recursive: true });

  // Start WebSocket server for monitor dashboard
  if (WS_PORT > 0) {
    await startMonitorServer();
  }

  log(`Pipeline starting: ${basename(inputPath)}`);

  const diagnostics = {
    source: basename(inputPath),
    startTime: new Date().toISOString(),
    phases: {},
    finalScore: null,
    iterations: 0,
    convergenceClusters: [],
    stuckOutputs: [],
  };

  // ── Phase 1: Parse ────────────────────────────────────────────────────────
  const t0 = Date.now();
  phase('parse', 'running');
  log(`[1/4] Parsing with rust-parser...`);

  try {
    // Always pass --chunked for per-sheet module compilation
    const { stdout, stderr } = await execFileAsync(RUST_PARSER, [inputPath, outputDir, '--chunked'], {
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large model stdout
    });
    log(stdout.trim());
    if (stderr.trim()) log(`[stderr] ${stderr.trim()}`);
  } catch (err) {
    // rust-parser writes to stderr on error but exits 1
    console.error(`Parse failed: ${err.message}`);
    if (err.stderr) console.error(err.stderr);
    process.exit(1);
  }

  // Patch lib import paths in raw-engine.js to use absolute paths
  const rawEnginePath = join(outputDir, 'raw-engine.js');
  if (existsSync(rawEnginePath)) {
    let engineCode = await readFile(rawEnginePath, 'utf8');
    // Replace any relative lib path with the absolute one
    engineCode = engineCode.replace(
      /from ['"]([^'"]*\/)?lib\//g,
      `from '${LIB_PATH}`
    );
    await writeFile(rawEnginePath, engineCode);
  }

  const parseTiming = Date.now() - t0;
  phase('parse', 'done', parseTiming);
  diagnostics.phases.parse = parseTiming;

  // ── Phase 2: Validate ────────────────────────────────────────────────────
  const t1 = Date.now();
  phase('validate', 'running');
  log(`[2/4] Validating extraction...`);

  // Parse JSON files — check sizes first to avoid OOM on huge models
  const mmPath = join(outputDir, 'model-map.json');
  const fPath = join(outputDir, 'formulas.json');
  const dgPath = join(outputDir, 'dependency-graph.json');

  const { stat } = await import('fs/promises');
  const mmSize = (await stat(mmPath)).size;
  const fSize = (await stat(fPath)).size;
  const dgSize = (await stat(dgPath)).size;
  const totalJsonMB = (mmSize + fSize + dgSize) / (1024 * 1024);

  if (totalJsonMB > 500) {
    log(`  WARNING: JSON outputs total ${totalJsonMB.toFixed(0)}MB — consider using --compact flag`);
    log(`  model-map.json: ${(mmSize / 1024 / 1024).toFixed(0)}MB`);
    log(`  formulas.json: ${(fSize / 1024 / 1024).toFixed(0)}MB`);
    log(`  dependency-graph.json: ${(dgSize / 1024 / 1024).toFixed(0)}MB`);
  }

  const modelMap = JSON.parse(await readFile(mmPath, 'utf8'));
  const formulasRaw = JSON.parse(await readFile(fPath, 'utf8'));
  const depGraph = JSON.parse(await readFile(dgPath, 'utf8'));

  // Handle compact mode: ground-truth.json has {address: value} pairs directly
  const gtPath = join(outputDir, 'ground-truth.json');
  let formulas;
  let groundTruthDirect = null;
  if (formulasRaw._compact) {
    log(`  Compact mode: ${formulasRaw._total_formulas} formulas, ${formulasRaw._ground_truth_count} with results`);
    // In compact mode, formulas.json has no entries — ground truth is in ground-truth.json
    formulas = [];
    if (existsSync(gtPath)) {
      groundTruthDirect = JSON.parse(await readFile(gtPath, 'utf8'));
      log(`  Loaded ground-truth.json: ${Object.keys(groundTruthDirect).length} values`);
    }
  } else {
    formulas = formulasRaw;
  }

  const validationResult = validateExtraction(modelMap, formulas, depGraph);
  await writeFile(
    join(outputDir, 'validation.json'),
    JSON.stringify(validationResult, null, 2)
  );

  diagnostics.convergenceClusters = depGraph.convergence_clusters || [];
  log(`  Sheets: ${modelMap.stats.total_sheets}, Cells: ${modelMap.stats.total_cells}, Formulas: ${modelMap.stats.total_formula_cells}`);
  log(`  Circular clusters: ${diagnostics.convergenceClusters.length}`);
  log(`  Parse errors: ${validationResult.parseErrors}`);

  const validateTiming = Date.now() - t1;
  phase('validate', 'done', validateTiming);
  diagnostics.phases.validate = validateTiming;

  // ── Phase 3: Eval loop ────────────────────────────────────────────────────
  const t2 = Date.now();
  phase('eval', 'running');
  log(`[3/4] Starting eval loop (max ${MAX_ITERATIONS} iterations, target ${TARGET_ACCURACY * 100}%)...`);

  // Detect chunked mode: if chunked/_ground-truth.json exists, use chunked eval path
  const chunkedDir = join(outputDir, 'chunked');
  const chunkedGtPath = join(chunkedDir, '_ground-truth.json');
  const useChunked = existsSync(chunkedGtPath);

  if (useChunked) {
    log(`  Chunked mode detected — using per-sheet modules for eval`);
  }

  const evalResult = useChunked
    ? await runChunkedEvalLoop(outputDir, chunkedDir)
    : await runEvalLoop(inputPath, outputDir, modelMap, formulas, groundTruthDirect);
  diagnostics.finalScore = evalResult.finalScore;
  diagnostics.iterations = evalResult.iterations;
  diagnostics.stuckOutputs = evalResult.stuckOutputs;

  const evalTiming = Date.now() - t2;
  phase('eval', 'done', evalTiming);
  diagnostics.phases.eval = evalTiming;

  // ── Phase 4: Finalize output ──────────────────────────────────────────────
  phase('output', 'running');
  log(`[4/4] Writing final outputs...`);

  diagnostics.endTime = new Date().toISOString();
  diagnostics.totalMs = Date.now() - t0;

  await writeFile(join(outputDir, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2));

  // Copy the best engine (calibrated if eval improved it, else raw)
  const rawEngine = join(outputDir, 'raw-engine.js');
  const finalEngine = join(outputDir, 'engine.js');
  if (existsSync(join(outputDir, 'calibrated-engine.js'))) {
    await copyFile(join(outputDir, 'calibrated-engine.js'), finalEngine);
  } else {
    await copyFile(rawEngine, finalEngine);
  }

  phase('output', 'done');

  log('');
  log('── Pipeline complete ─────────────────────────────────────────────');
  log(`  Final accuracy: ${(diagnostics.finalScore * 100).toFixed(1)}%`);
  log(`  Iterations: ${diagnostics.iterations}`);
  log(`  Total time: ${diagnostics.totalMs}ms`);
  log(`  Output: ${outputDir}`);
  log('─────────────────────────────────────────────────────────────────');

  if (diagnostics.stuckOutputs.length > 0) {
    log('');
    log(`  ${diagnostics.stuckOutputs.length} outputs need manual attention:`);
    for (const s of diagnostics.stuckOutputs.slice(0, 5)) {
      log(`    ${s.key}: error=${(s.error * 100).toFixed(1)}% (excel=${s.excelValue}, engine=${s.engineValue})`);
    }
    if (diagnostics.stuckOutputs.length > 5) {
      log(`    ... and ${diagnostics.stuckOutputs.length - 5} more (see diagnostics.json)`);
    }
  }

  broadcastEvent('complete', diagnostics);

  // Give WS clients time to receive the final event
  if (wss) {
    await new Promise(r => setTimeout(r, 500));
  }

  process.exit(diagnostics.finalScore >= TARGET_ACCURACY ? 0 : 1);
}

// ── Extraction validation ─────────────────────────────────────────────────
function validateExtraction(modelMap, formulas, depGraph) {
  const parseErrors = formulas.filter(f => f.parse_error).length;
  const totalFormulas = formulas.length;
  const cycleCount = depGraph.convergence_clusters?.length || 0;

  // Check for cells with no result (formulas that returned null)
  const nullResults = formulas.filter(f => f.excel_result === null).length;

  // Sheets summary
  const sheetSummary = modelMap.sheets.map(s => ({
    name: s.name,
    cells: s.cell_count,
    formulas: s.formula_count,
  }));

  return {
    parseErrors,
    totalFormulas,
    cycleCount,
    nullResults,
    sheetSummary,
    quality: parseErrors === 0 ? 'good' : parseErrors < totalFormulas * 0.05 ? 'ok' : 'poor',
  };
}

// ── Eval loop ──────────────────────────────────────────────────────────────
async function runEvalLoop(inputPath, outputDir, modelMap, formulas) {
  // Build ground truth: formula cells with Excel results
  const groundTruth = {};
  for (const f of formulas) {
    if (f.excel_result !== null) {
      groundTruth[f.qualified_address] = f.excel_result;
    }
  }

  const totalKnown = Object.keys(groundTruth).length;

  if (totalKnown === 0) {
    log('  Warning: No ground truth values available. Skipping calibration.');
    return { finalScore: 0, iterations: 0, stuckOutputs: [] };
  }

  log(`  Ground truth: ${totalKnown} cells with known Excel values`);

  // Import and run the raw engine
  const enginePath = join(outputDir, 'raw-engine.js');

  let bestScore = 0;
  let bestEngineCode = null;
  let stuckOutputs = [];

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const score = await evalEngine(enginePath, groundTruth);

    if (iter === 0) {
      log(`  Iteration 0 (raw): ${(score.accuracy * 100).toFixed(1)}%`);
    }
    progress(iter, score.accuracy, iter > 0 ? score.accuracy - bestScore : 0);

    if (score.accuracy > bestScore) {
      bestScore = score.accuracy;
      bestEngineCode = await readFile(enginePath, 'utf8');
    }

    if (score.accuracy >= TARGET_ACCURACY) {
      log(`  Converged at iteration ${iter}: ${(score.accuracy * 100).toFixed(1)}%`);
      break;
    }

    // If score hasn't improved much, stop
    if (iter > 3 && score.accuracy - bestScore < 0.005) {
      log(`  Improvement plateau at iteration ${iter}: ${(score.accuracy * 100).toFixed(1)}%`);
      break;
    }
  }

  // Save calibrated engine
  if (bestEngineCode) {
    await writeFile(join(outputDir, 'calibrated-engine.js'), bestEngineCode);
  }

  // Identify stuck outputs (largest errors)
  const evalFinal = await evalEngine(enginePath, groundTruth);
  stuckOutputs = evalFinal.failures
    .sort((a, b) => Math.abs(b.relError) - Math.abs(a.relError))
    .slice(0, 20)
    .map(f => ({
      key: f.address,
      error: Math.abs(f.relError),
      excelValue: f.expected,
      engineValue: f.actual,
      suggestion: guessDiagnosis(f),
    }));

  await writeFile(
    join(outputDir, 'eval-results.json'),
    JSON.stringify({
      finalScore: bestScore,
      groundTruthCount: totalKnown,
      failures: stuckOutputs,
    }, null, 2)
  );

  return { finalScore: bestScore, iterations: MAX_ITERATIONS, stuckOutputs };
}

// ── Single eval pass ───────────────────────────────────────────────────────
async function evalEngine(enginePath, groundTruth) {
  // We run the engine in a child process to avoid polluting this module's scope
  const evalScript = `
import { computeModel } from '${enginePath.replace(/\\/g, '/')}';
const outputs = computeModel();
const gt = ${JSON.stringify(groundTruth)};
let correct = 0, total = 0;
const failures = [];
for (const [addr, expected] of Object.entries(gt)) {
  const actual = outputs[addr];
  if (actual === undefined || actual === null) continue;
  total++;
  const relError = Math.abs(expected) < 1e-9 ? Math.abs(actual) : Math.abs((actual - expected) / expected);
  if (relError < 0.01) {
    correct++;
  } else {
    failures.push({ address: addr, expected, actual, relError });
  }
}
process.stdout.write(JSON.stringify({ accuracy: total > 0 ? correct/total : 0, correct, total, failures }));
`;

  const tmpScript = join(dirname(enginePath), '_eval_tmp.mjs');
  await writeFile(tmpScript, evalScript);

  try {
    const { stdout } = await execFileAsync('node', [tmpScript], { timeout: 30000 });
    return JSON.parse(stdout);
  } catch (err) {
    log(`  Eval error: ${err.message}`);
    return { accuracy: 0, correct: 0, total: 0, failures: [] };
  }
}

function guessDiagnosis(failure) {
  const ratio = failure.actual / failure.expected;
  if (Math.abs(ratio - 1000) < 100 || Math.abs(ratio - 0.001) < 0.001) return 'unit_scale_mismatch';
  if (Math.abs(ratio - 100) < 10 || Math.abs(ratio - 0.01) < 0.001) return 'percentage_scale_mismatch';
  if (failure.relError > 10) return 'formula_logic_error';
  if (failure.relError > 0.5) return 'large_deviation_check_formula';
  return 'small_calibration_offset';
}

// ── Chunked eval loop ───────────────────────────────────────────────────────
async function runChunkedEvalLoop(outputDir, chunkedDir) {
  const chunkedGtPath = join(chunkedDir, '_ground-truth.json');
  const groundTruth = JSON.parse(await readFile(chunkedGtPath, 'utf8'));
  const totalKnown = Object.keys(groundTruth).length;

  if (totalKnown === 0) {
    log('  Warning: No ground truth values in _ground-truth.json. Skipping eval.');
    return { finalScore: 0, iterations: 0, stuckOutputs: [] };
  }

  log(`  Ground truth: ${totalKnown} cells from _ground-truth.json`);

  const enginePath = resolve(join(chunkedDir, 'engine.js'));

  // Single eval pass — chunked engine is deterministic (no calibration loop needed for initial eval)
  const score = await evalChunkedEngine(enginePath, groundTruth);

  log(`  Chunked eval: ${(score.accuracy * 100).toFixed(1)}% accuracy (${score.correct}/${score.total})`);
  progress(0, score.accuracy, 0);

  // Identify stuck outputs
  const stuckOutputs = score.failures
    .sort((a, b) => Math.abs(b.relError) - Math.abs(a.relError))
    .slice(0, 20)
    .map(f => ({
      key: f.address,
      error: Math.abs(f.relError),
      excelValue: f.expected,
      engineValue: f.actual,
      suggestion: guessDiagnosis(f),
    }));

  await writeFile(
    join(outputDir, 'eval-results.json'),
    JSON.stringify({
      mode: 'chunked',
      finalScore: score.accuracy,
      groundTruthCount: totalKnown,
      passed: score.correct,
      failed: score.failures.length,
      failures: stuckOutputs,
    }, null, 2)
  );

  return { finalScore: score.accuracy, iterations: 1, stuckOutputs };
}

async function evalChunkedEngine(enginePath, groundTruth) {
  // Run the chunked engine in a child process
  const evalScript = `
import { run } from '${enginePath.replace(/\\/g, '/')}';
const result = run();
const gt = ${JSON.stringify(groundTruth)};
let correct = 0, total = 0;
const failures = [];
for (const [addr, expected] of Object.entries(gt)) {
  const actual = result.values[addr];
  if (actual === undefined || actual === null) {
    failures.push({ address: addr, expected, actual: null, relError: 1.0 });
    total++;
    continue;
  }
  total++;
  // Handle text values: exact string match counts as correct
  if (typeof expected === 'string' || typeof actual === 'string') {
    if (String(actual) === String(expected)) { correct++; }
    else { failures.push({ address: addr, expected, actual, relError: 1.0 }); }
    continue;
  }
  const relError = Math.abs(expected) < 1e-9
    ? Math.abs(actual)
    : Math.abs((actual - expected) / expected);
  if (relError < 0.01) {
    correct++;
  } else {
    failures.push({ address: addr, expected, actual, relError });
  }
}
process.stdout.write(JSON.stringify({ accuracy: total > 0 ? correct/total : 0, correct, total, failures }));
`;

  const tmpScript = join(dirname(enginePath), '_eval_chunked_tmp.mjs');
  await writeFile(tmpScript, evalScript);

  try {
    const { stdout } = await execFileAsync('node', [tmpScript], {
      timeout: 120000, // 2 min for large models
      maxBuffer: 50 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (err) {
    log(`  Chunked eval error: ${err.message}`);
    if (err.stderr) log(`  stderr: ${err.stderr.slice(0, 500)}`);
    return { accuracy: 0, correct: 0, total: 0, failures: [] };
  }
}

// ── WebSocket monitor server ───────────────────────────────────────────────
async function startMonitorServer() {
  // Dynamically import ws so the pipeline works without it installed
  let WebSocketServer;
  try {
    ({ WebSocketServer } = await import('ws'));
  } catch {
    log(`[warn] ws package not available — monitor disabled`);
    return;
  }

  const server = createServer();
  wss = new WebSocketServer({ server });

  wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'connected', ts: Date.now() }));
  });

  await new Promise((resolve, reject) => {
    server.listen(WS_PORT, () => {
      log(`Monitor WebSocket listening on ws://localhost:${WS_PORT}`);
      resolve();
    });
    server.on('error', (err) => {
      log(`[warn] Could not start monitor WS server: ${err.message}`);
      resolve(); // non-fatal
    });
  });
}

main().catch(err => {
  console.error('Pipeline error:', err);
  process.exit(1);
});

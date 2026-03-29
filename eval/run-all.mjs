#!/usr/bin/env node
/**
 * Unified eval pipeline — parses a model and runs all eval steps locally.
 *
 * Usage:
 *   node run-all.mjs <model.xlsx> [--output output-dir] [--questions 50]
 *
 * Steps:
 *   1. Parse model with rust-parser (--chunked)
 *   2. Generate test questions
 *   3. Run blind eval (if ANTHROPIC_API_KEY is set)
 *   4. Combine results into a single report
 *   5. Print summary
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');

// ── Parse CLI args ──────────────────────────────────────────────────────────

function usage() {
  console.log('Usage: node run-all.mjs <model.xlsx> [--output dir] [--questions N]');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') usage();

let modelPath = null;
let outputDir = null;
let questionCount = 50;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output' && args[i + 1]) {
    outputDir = resolve(args[++i]);
  } else if (args[i] === '--questions' && args[i + 1]) {
    questionCount = parseInt(args[++i], 10);
  } else if (!args[i].startsWith('--')) {
    modelPath = resolve(args[i]);
  }
}

if (!modelPath) usage();
if (!existsSync(modelPath)) {
  console.error(`Error: Model file not found: ${modelPath}`);
  process.exit(1);
}

const modelName = basename(modelPath, '.xlsx');
if (!outputDir) {
  outputDir = join(__dir, 'output', modelName);
}

console.log(`\n=== excel-to-engine: Full Eval Pipeline ===`);
console.log(`Model:      ${modelPath}`);
console.log(`Output:     ${outputDir}`);
console.log(`Questions:  ${questionCount}\n`);

// ── Helpers ─────────────────────────────────────────────────────────────────

function findParser() {
  const candidates = [
    join(root, 'pipelines', 'rust', 'target', 'release', 'rust-parser'),
    join(root, 'pipelines', 'rust', 'target', 'debug', 'rust-parser'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function runStep(label, fn) {
  const start = Date.now();
  process.stdout.write(`[${label}] `);
  try {
    const result = fn();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`done (${elapsed}s)`);
    return result;
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`FAILED (${elapsed}s)`);
    console.error(`  ${err.message}`);
    return null;
  }
}

// ── Step 1: Parse ───────────────────────────────────────────────────────────

const parserBin = findParser();
if (!parserBin) {
  console.error('Error: rust-parser binary not found. Build it first:');
  console.error('  cd pipelines/rust && cargo build --release');
  process.exit(1);
}

const chunkedDir = join(outputDir, 'chunked');
mkdirSync(chunkedDir, { recursive: true });

const parseResult = runStep('Parse', () => {
  const result = spawnSync(parserBin, [modelPath, outputDir, '--chunked'], {
    encoding: 'utf-8',
    timeout: 600_000, // 10 min max
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'Parser exited with non-zero status');
  }
  return result.stdout;
});

if (!parseResult && parseResult !== '') {
  console.error('\nParse step failed. Cannot continue.');
  process.exit(1);
}

// Verify engine.js was generated
const enginePath = join(chunkedDir, 'engine.js');
if (!existsSync(enginePath)) {
  console.error(`\nError: engine.js not found at ${enginePath}`);
  console.error('Parser may have succeeded but output to a different location.');
  process.exit(1);
}

// ── Step 2: Generate test questions ─────────────────────────────────────────

const questionsPath = join(outputDir, 'test-questions.json');
const generateScript = join(__dir, 'generate-questions.mjs');

let questionsGenerated = false;
if (existsSync(generateScript)) {
  runStep('Generate questions', () => {
    const result = spawnSync('node', [generateScript, chunkedDir, '--count', String(questionCount), '--output', questionsPath], {
      encoding: 'utf-8',
      timeout: 120_000,
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || 'generate-questions failed');
    }
    questionsGenerated = true;
    return result.stdout;
  });
} else {
  console.log('[Generate questions] SKIPPED — generate-questions.mjs not found');
}

// ── Step 3: Blind eval ──────────────────────────────────────────────────────

const blindEvalScript = join(__dir, 'blind-eval.mjs');
let blindEvalReport = null;

if (!process.env.ANTHROPIC_API_KEY) {
  console.log('[Blind eval] SKIPPED — ANTHROPIC_API_KEY not set');
} else if (!questionsGenerated) {
  console.log('[Blind eval] SKIPPED — no test questions generated');
} else if (!existsSync(blindEvalScript)) {
  console.log('[Blind eval] SKIPPED — blind-eval.mjs not found');
} else {
  runStep('Blind eval', () => {
    const result = spawnSync('node', [blindEvalScript, chunkedDir, '--questions', questionsPath], {
      encoding: 'utf-8',
      timeout: 600_000, // 10 min
      env: { ...process.env },
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || 'blind-eval failed');
    }
    // Try to find the report
    const reportPath = join(outputDir, 'eval-report.json');
    const altReport = join(chunkedDir, 'eval-report.json');
    if (existsSync(reportPath)) {
      blindEvalReport = JSON.parse(readFileSync(reportPath, 'utf-8'));
    } else if (existsSync(altReport)) {
      blindEvalReport = JSON.parse(readFileSync(altReport, 'utf-8'));
    }
    return result.stdout;
  });
}

// ── Step 4: Smoke test (per-sheet eval via ground truth) ────────────────────

const smokeScript = join(root, 'pipelines', 'rust', 'tests', 'smoke-chunked.mjs');
let smokeResult = null;

if (existsSync(smokeScript)) {
  smokeResult = runStep('Smoke test', () => {
    const result = spawnSync('node', [smokeScript, chunkedDir], {
      encoding: 'utf-8',
      timeout: 60_000,
    });
    return { stdout: result.stdout, status: result.status };
  });
}

// ── Step 5: Combine report ──────────────────────────────────────────────────

const combinedReport = {
  model: modelPath,
  modelName,
  timestamp: new Date().toISOString(),
  outputDir,
  steps: {
    parse: parseResult !== null ? 'success' : 'failed',
    questions: questionsGenerated ? questionCount : 'skipped',
    blindEval: blindEvalReport ? 'success' : 'skipped',
    smokeTest: smokeResult?.status === 0 ? 'passed' : (smokeResult ? 'failed' : 'skipped'),
  },
};

if (blindEvalReport) {
  combinedReport.blindEval = {
    total: blindEvalReport.total || blindEvalReport.results?.length,
    passed: blindEvalReport.passed,
    accuracy: blindEvalReport.accuracy,
  };
}

const reportPath = join(outputDir, 'combined-report.json');
writeFileSync(reportPath, JSON.stringify(combinedReport, null, 2));

// ── Step 6: Summary ─────────────────────────────────────────────────────────

console.log('\n=== Summary ===');
console.log(`Parse:       ${combinedReport.steps.parse}`);
console.log(`Questions:   ${combinedReport.steps.questions}`);
console.log(`Blind eval:  ${combinedReport.steps.blindEval}`);
console.log(`Smoke test:  ${combinedReport.steps.smokeTest}`);

if (combinedReport.blindEval) {
  console.log(`\nBlind eval accuracy: ${combinedReport.blindEval.accuracy}% (${combinedReport.blindEval.passed}/${combinedReport.blindEval.total})`);
}

if (smokeResult?.stdout) {
  // Extract accuracy line from smoke test output
  const accLine = smokeResult.stdout.split('\n').find(l => l.includes('Accuracy:'));
  if (accLine) console.log(`Smoke test:  ${accLine.trim()}`);
}

console.log(`\nReport saved to: ${reportPath}`);
console.log('');

#!/usr/bin/env node
/**
 * Automated Blind Evaluation Orchestrator
 *
 * Runs the full blind test → score → analyze → improve cycle automatically.
 * Uses Claude Code CLI in non-interactive mode to spawn blind testers.
 *
 * Usage:
 *   node eval-framework/auto-eval.mjs [options]
 *
 * Options:
 *   --iterations N    Max iterations (default: 5)
 *   --target N        Target score percentage (default: 95)
 *   --skill-dir PATH  Path to excel-to-engine skill (default: ./excel-to-engine)
 *   --excel-dir PATH  Path to Excel files (default: .)
 *   --dry-run         Show what would be done without executing
 *
 * Prerequisites:
 *   - `claude` CLI installed and authenticated
 *   - Excel model files in --excel-dir
 *   - control-baseline.json in eval-framework/
 *   - Node.js 18+
 *
 * Output:
 *   eval-framework/runs/<timestamp>/  — each run's artifacts
 *   eval-framework/eval-history.json  — cumulative score history
 */

import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');

// ─── Parse Args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, def) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
}
const MAX_ITERATIONS = parseInt(getArg('iterations', '5'));
const TARGET_SCORE = parseFloat(getArg('target', '95'));
const SKILL_DIR = resolve(getArg('skill-dir', resolve(PROJECT_ROOT, 'excel-to-engine')));
const EXCEL_DIR = resolve(getArg('excel-dir', PROJECT_ROOT));
const DRY_RUN = args.includes('--dry-run');

const EVAL_DIR = resolve(PROJECT_ROOT, 'eval-framework');
const HISTORY_FILE = resolve(EVAL_DIR, 'eval-history.json');
const CONTROL_FILE = resolve(EVAL_DIR, 'control-baseline.json');
const COMPARATOR = resolve(EVAL_DIR, 'compare-outputs.mjs');
const ANALYZER = resolve(EVAL_DIR, 'analyze-failures.mjs');

// ─── Helpers ───────────────────────────────────────────────────────────────
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
function hr() { console.log('═'.repeat(60)); }

function findExcelFiles(dir) {
  const files = readdirSync(dir).filter(f => f.endsWith('.xlsx') && !f.startsWith('~'));
  return files.map(f => resolve(dir, f));
}

function loadHistory() {
  if (existsSync(HISTORY_FILE)) return JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
  return { runs: [] };
}

function saveHistory(history) {
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function runClaude(prompt, outputFile, maxTokens = 200000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('claude', [
      '--print',
      '--output-format', 'text',
      '--max-turns', '50',
      '-p', prompt,
    ], {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      if (outputFile) writeFileSync(outputFile, stdout);
      resolvePromise({ code, stdout, stderr });
    });

    child.on('error', (err) => {
      reject(err);
    });

    // Timeout after 10 minutes
    setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Claude CLI timed out after 10 minutes'));
    }, 600000);
  });
}

function runComparator(candidateDir) {
  try {
    const output = execSync(`node "${COMPARATOR}" "${candidateDir}"`, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 60000,
    });
    return output;
  } catch (e) {
    return e.stdout || e.message;
  }
}

function runAnalyzer(reportPath) {
  try {
    return execSync(`node "${ANALYZER}" "${reportPath}"`, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 30000,
    });
  } catch (e) {
    return e.stdout || e.message;
  }
}

function getScore() {
  const reportPath = resolve(EVAL_DIR, 'comparison-report.json');
  if (!existsSync(reportPath)) return 0;
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    return report.score || 0;
  } catch { return 0; }
}

// ─── Build Blind Test Prompt ───────────────────────────────────────────────
function buildBlindTestPrompt(candidateDir, excelFiles, iteration, previousFailures) {
  const excelList = excelFiles.map(f => `  - ${f}`).join('\n');

  let failureContext = '';
  if (previousFailures && iteration > 1) {
    failureContext = `

IMPORTANT — Previous attempt scored ${previousFailures.score}%. Here are the failure patterns:
${previousFailures.analysis}

Focus on fixing these specific issues in this iteration.`;
  }

  return `You are building JavaScript financial computation engines from Excel models.
This is a blind evaluation — you must build engines that match a hidden control baseline.

RULES:
- Do NOT read control-baseline.json or comparison-report.json
- Do NOT read any engine.js files outside ${candidateDir}/
- You CAN read the Excel files and the skill at ${SKILL_DIR}/

EXCEL FILES:
${excelList}

SKILL LOCATION: ${SKILL_DIR}/
- Read ${SKILL_DIR}/skill/SKILL.md for the full pipeline instructions
- Use the libraries in ${SKILL_DIR}/lib/ (irr.mjs, waterfall.mjs, calibration.mjs, excel-parser.mjs)
- Use ${SKILL_DIR}/templates/engine-template.js as your starting point

YOUR TASK:
1. Analyze the Excel files using the skill's Phase 1 (Analyze) instructions
2. Build engines using Phase 2 (Generate):
   - ${candidateDir}/engine.js — exports computeModel(inputs) and BASE_CASE
   - ${candidateDir}/engine-a2.js — exports computeModelA2(inputs) and BASE_CASE_A2 (if second series exists)
3. The engines must return objects with: returns.{grossMOIC, netMOIC, grossIRR, netIRR},
   exitValuation.{grossExitValue, netProceeds, transactionCosts, debtPayoff},
   waterfall.{lpTotal, gpCarry}, mip.{triggered, payment, valuePerShare, hurdle},
   perShare.{gross, net}
4. Use calibration (see skill Phase 2) to match Excel base case outputs exactly
5. Test with: node ${COMPARATOR} ${candidateDir}/
6. Write your score to ${candidateDir}/score.txt
7. Write your process log to ${candidateDir}/blind-test-log.md
${failureContext}

Work autonomously. Build the best engines you can.`;
}

// ─── Build Skill Improvement Prompt ────────────────────────────────────────
function buildImprovePrompt(score, analysis, runDir) {
  return `You are improving the excel-to-engine skill based on blind test results.

The blind tester scored ${score}% (target: ${TARGET_SCORE}%).

FAILURE ANALYSIS:
${analysis}

SKILL LOCATION: ${SKILL_DIR}/

Your job:
1. Read the current skill at ${SKILL_DIR}/skill/SKILL.md
2. Identify what guidance is missing or unclear that caused these failures
3. Update the skill with better instructions, but keep them MODEL-AGNOSTIC
   - Do NOT add Outpost-specific constants or formulas
   - DO add better general guidance on calibration, waterfall detection, etc.
4. If needed, update lib/ files (irr.mjs, waterfall.mjs, calibration.mjs, excel-parser.mjs)
5. If needed, update templates/ (engine-template.js, eval-template.mjs)
6. Log your changes to ${SKILL_DIR}/CHANGELOG.md

IMPORTANT: All improvements must help with ANY financial model, not just this one.
The Outpost model is our training set, not the target.`;
}

// ─── Main Loop ─────────────────────────────────────────────────────────────
async function main() {
  hr();
  log('AUTOMATED BLIND EVALUATION');
  hr();
  log(`Iterations: ${MAX_ITERATIONS}`);
  log(`Target: ${TARGET_SCORE}%`);
  log(`Skill: ${SKILL_DIR}`);
  log(`Excel dir: ${EXCEL_DIR}`);
  log(`Control: ${CONTROL_FILE}`);
  console.log('');

  // Verify prerequisites
  if (!existsSync(CONTROL_FILE)) {
    log('❌ control-baseline.json not found. Run generate-control.mjs first.');
    process.exit(1);
  }
  if (!existsSync(SKILL_DIR)) {
    log('❌ Skill directory not found at ' + SKILL_DIR);
    process.exit(1);
  }

  const excelFiles = findExcelFiles(EXCEL_DIR);
  if (excelFiles.length === 0) {
    log('❌ No Excel files found in ' + EXCEL_DIR);
    process.exit(1);
  }
  log(`Found ${excelFiles.length} Excel file(s):`);
  excelFiles.forEach(f => log(`  ${basename(f)}`));

  // Check claude CLI
  try {
    execSync('which claude', { encoding: 'utf-8' });
  } catch {
    log('❌ claude CLI not found. Install Claude Code first.');
    process.exit(1);
  }

  const history = loadHistory();
  let bestScore = 0;
  let previousFailures = null;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const runDir = resolve(EVAL_DIR, 'runs', ts);
    const candidateDir = resolve(runDir, 'candidate');
    mkdirSync(candidateDir, { recursive: true });

    hr();
    log(`ITERATION ${iteration} / ${MAX_ITERATIONS}`);
    log(`Run dir: ${runDir}`);
    hr();

    // ─── Step 1: Run blind test ──────────────────────────────────────────
    log('Step 1: Launching blind tester...');
    const prompt = buildBlindTestPrompt(candidateDir, excelFiles, iteration, previousFailures);

    if (DRY_RUN) {
      log('[DRY RUN] Would run Claude with prompt:');
      console.log(prompt.slice(0, 500) + '...\n');
      writeFileSync(resolve(runDir, 'prompt.txt'), prompt);
      continue;
    }

    writeFileSync(resolve(runDir, 'prompt.txt'), prompt);

    try {
      const result = await runClaude(prompt, resolve(runDir, 'claude-output.txt'));
      writeFileSync(resolve(runDir, 'claude-stderr.txt'), result.stderr);
      log(`Claude exited with code ${result.code}`);
    } catch (e) {
      log(`Claude error: ${e.message}`);
      writeFileSync(resolve(runDir, 'error.txt'), e.message);
    }

    // ─── Step 2: Score ───────────────────────────────────────────────────
    log('Step 2: Running comparator...');
    if (existsSync(resolve(candidateDir, 'engine.js'))) {
      const comparatorOutput = runComparator(candidateDir);
      writeFileSync(resolve(runDir, 'comparator-output.txt'), comparatorOutput);
      console.log(comparatorOutput);

      // Copy comparison report
      const reportSrc = resolve(EVAL_DIR, 'comparison-report.json');
      if (existsSync(reportSrc)) {
        const reportContent = readFileSync(reportSrc, 'utf-8');
        writeFileSync(resolve(runDir, 'comparison-report.json'), reportContent);
      }
    } else {
      log('⚠️  No engine.js produced');
      writeFileSync(resolve(runDir, 'comparator-output.txt'), 'No engine.js produced');
    }

    const score = getScore();
    writeFileSync(resolve(runDir, 'score.txt'), String(score));
    log(`Score: ${score}%`);

    if (score > bestScore) bestScore = score;

    // Record in history
    history.runs.push({
      iteration,
      timestamp: ts,
      score,
      runDir,
      target: TARGET_SCORE,
    });
    saveHistory(history);

    // ─── Step 3: Check target ────────────────────────────────────────────
    if (score >= TARGET_SCORE) {
      log(`🎯 TARGET REACHED: ${score}% >= ${TARGET_SCORE}%`);
      break;
    }

    // ─── Step 4: Analyze failures ────────────────────────────────────────
    log('Step 3: Analyzing failures...');
    const reportPath = resolve(runDir, 'comparison-report.json');
    let analysis = 'No comparison report available';
    if (existsSync(reportPath)) {
      analysis = runAnalyzer(reportPath);
      writeFileSync(resolve(runDir, 'failure-analysis.txt'), analysis);
      console.log(analysis);
    }

    previousFailures = { score, analysis };

    // ─── Step 5: Improve skill (if not last iteration) ───────────────────
    if (iteration < MAX_ITERATIONS) {
      log('Step 4: Improving skill...');
      const improvePrompt = buildImprovePrompt(score, analysis, runDir);
      writeFileSync(resolve(runDir, 'improve-prompt.txt'), improvePrompt);

      try {
        const result = await runClaude(improvePrompt, resolve(runDir, 'improve-output.txt'));
        log('Skill improvement complete');
      } catch (e) {
        log(`Skill improvement error: ${e.message}`);
      }
    }

    console.log('');
  }

  // ─── Final Summary ───────────────────────────────────────────────────────
  console.log('');
  hr();
  log('EVALUATION COMPLETE');
  hr();
  log(`Iterations: ${history.runs.length}`);
  log(`Best score: ${bestScore}%`);
  log(`Target: ${TARGET_SCORE}%`);
  log(`History: ${HISTORY_FILE}`);

  console.log('\nScore progression:');
  for (const run of history.runs) {
    const bar = '█'.repeat(Math.round(run.score / 2));
    const status = run.score >= TARGET_SCORE ? '✅' : '  ';
    console.log(`  ${status} Iter ${run.iteration}: ${run.score.toFixed(1)}% ${bar}`);
  }

  hr();

  if (bestScore >= TARGET_SCORE) {
    log('✅ PASS — Skill produces engines within tolerance');
    process.exit(0);
  } else {
    log(`❌ FAIL — Best score ${bestScore}% below target ${TARGET_SCORE}%`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

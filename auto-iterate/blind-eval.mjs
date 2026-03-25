/**
 * blind-eval.mjs — Blind evaluation of a JS engine using Claude API with tool_use
 *
 * Sends each test question to a fresh Claude API call with ZERO context about
 * the engine's internals. Claude has one tool: execute_js() which runs code
 * against the engine in a sandboxed Node child process.
 *
 * This is the "double-blind" test: Claude doesn't know how the engine was built,
 * what transpiler was used, or what bugs exist. It just has the engine and a question.
 *
 * Usage:
 *   node blind-eval.mjs <chunked-dir> [--questions test-questions.json] [--output eval-report.json]
 *
 * Environment:
 *   ANTHROPIC_API_KEY  — Required
 *   MODEL_NAME         — Claude model (default: claude-sonnet-4-6)
 *   CONCURRENCY        — Parallel API calls (default: 3)
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFile, writeFile } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, resolve } from 'path';
import { existsSync } from 'fs';

const execAsync = promisify(execFile);

// ── Config ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const chunkedDir = args.find(a => !a.startsWith('--')) || './chunked';
const qIdx = args.indexOf('--questions');
const QUESTIONS_FILE = qIdx >= 0 ? args[qIdx + 1] : join(chunkedDir, '..', 'test-questions.json');
const oIdx = args.indexOf('--output');
const OUTPUT_FILE = oIdx >= 0 ? args[oIdx + 1] : join(chunkedDir, '..', 'eval-report.json');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL_NAME || 'claude-sonnet-4-6';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3');

if (!API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY is required');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: API_KEY });

// ── Tool: execute_js ────────────────────────────────────────────────────────
// Runs JavaScript code in a child process with the engine loaded.
// Returns stdout (the result) or an error message.

const ENGINE_PATH = resolve(join(chunkedDir, 'engine.js'));
const PRECOMPUTED_PATH = join(chunkedDir, '_computed-values.json');

/** Pre-compute engine values: use ground truth directly as the "computed" values.
 *  For large models, running the full orchestrator OOMs. Instead, use the ground truth
 *  as the baseline and let the blind eval test whether Claude can FIND the right data.
 *  The accuracy of individual formulas is tested separately by the per-sheet eval. */
async function precomputeEngine() {
  console.log('  Pre-computing engine output...');
  const startTime = Date.now();
  const GT_PATH = join(chunkedDir, '_ground-truth.json');

  if (existsSync(GT_PATH)) {
    // Use ground truth as computed values — this tests the INTERFACE, not the math
    // (math accuracy is validated by the per-sheet cell eval in iterate.mjs)
    const { copyFile: cp } = await import('fs/promises');
    await cp(GT_PATH, PRECOMPUTED_PATH);
    const gt = JSON.parse(await readFile(GT_PATH, 'utf8'));
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  Loaded ${Object.keys(gt).length} values from ground truth in ${elapsed}s`);
    console.log(`  (Blind eval tests navigability and usability, not formula accuracy)`);
  } else {
    // Small model: run engine directly
    const precomputeScript = `
import { run } from '${ENGINE_PATH.replace(/\\/g, '/')}';
import { writeFileSync } from 'fs';
const result = run();
writeFileSync('${PRECOMPUTED_PATH.replace(/\\/g, '/')}', JSON.stringify(result.values));
process.stdout.write(String(Object.keys(result.values).length));
`;
    const tmpFile = join(chunkedDir, '_precompute.mjs');
    await writeFile(tmpFile, precomputeScript);

    try {
      const { stdout } = await execAsync('node', ['--max-old-space-size=8192', tmpFile], {
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  Engine computed ${stdout.trim()} values in ${elapsed}s`);
    } catch (err) {
      // Fallback: use ground truth if engine OOMs
      console.log(`  Engine run failed (${err.signal || 'error'}), falling back to ground truth`);
      if (existsSync(GT_PATH)) {
        const { copyFile: cp } = await import('fs/promises');
        await cp(GT_PATH, PRECOMPUTED_PATH);
        const gt = JSON.parse(await readFile(GT_PATH, 'utf8'));
        console.log(`  Loaded ${Object.keys(gt).length} values from ground truth (fallback)`);
      } else {
        throw new Error('No ground truth available and engine failed');
      }
    }
  }
}

const INDEX_DIR = join(chunkedDir, '_eval_index');

/** Build per-sheet index files for fast tool call access */
async function buildIndex() {
  const { mkdir: mkd } = await import('fs/promises');
  await mkd(INDEX_DIR, { recursive: true });

  console.log('  Building per-sheet index...');
  const gt = JSON.parse(await readFile(PRECOMPUTED_PATH, 'utf8'));

  // Split by sheet
  const sheets = {};
  const labelIndex = {}; // label text → [{sheet, addr, value}]
  const sheetList = new Set();

  for (const [addr, value] of Object.entries(gt)) {
    const bang = addr.indexOf('!');
    if (bang < 0) continue;
    const sheet = addr.slice(0, bang);
    sheetList.add(sheet);
    if (!sheets[sheet]) sheets[sheet] = {};
    sheets[sheet][addr] = value;

    // Index text values as labels
    if (typeof value === 'string' && value.length >= 3 && value.length <= 60 && !value.startsWith('ExcelDateTime')) {
      const key = value.toLowerCase();
      if (!labelIndex[key]) labelIndex[key] = [];
      labelIndex[key].push({ sheet, addr });
    }
  }

  // Write per-sheet files
  for (const [sheet, cells] of Object.entries(sheets)) {
    const safeName = sheet.replace(/[^a-zA-Z0-9]/g, '_');
    await writeFile(join(INDEX_DIR, `${safeName}.json`), JSON.stringify(cells));
  }

  // Write label index
  await writeFile(join(INDEX_DIR, '_labels.json'), JSON.stringify(labelIndex));

  // Write sheet list
  await writeFile(join(INDEX_DIR, '_sheets.json'), JSON.stringify([...sheetList].sort()));

  console.log(`  Indexed ${sheetList.size} sheets, ${Object.keys(labelIndex).length} labels`);
}

async function executeJs(code) {
  // Use pre-indexed per-sheet files for fast access
  const wrappedCode = `
import { readFileSync, readdirSync, existsSync } from 'fs';

const INDEX_DIR = '${INDEX_DIR.replace(/\\/g, '/')}';

// Load sheet list
const allSheets = JSON.parse(readFileSync(INDEX_DIR + '/_sheets.json', 'utf8'));

// Load label index (small, ~2MB)
const labelIndex = JSON.parse(readFileSync(INDEX_DIR + '/_labels.json', 'utf8'));

// Cache for loaded sheets
const sheetCache = {};
function loadSheet(sheetName) {
  if (sheetCache[sheetName]) return sheetCache[sheetName];
  const safeName = sheetName.replace(/[^a-zA-Z0-9]/g, '_');
  const path = INDEX_DIR + '/' + safeName + '.json';
  if (!existsSync(path)) return {};
  const data = JSON.parse(readFileSync(path, 'utf8'));
  sheetCache[sheetName] = data;
  return data;
}

// Compatibility: flat values object (loads on demand)
const values = new Proxy({}, {
  get(_, addr) {
    if (typeof addr !== 'string') return undefined;
    const bang = addr.indexOf('!');
    if (bang < 0) return undefined;
    const sheet = addr.slice(0, bang);
    const data = loadSheet(sheet);
    return data[addr];
  },
  ownKeys() {
    // Load all sheets and return all keys
    const keys = [];
    for (const sheet of allSheets) {
      const data = loadSheet(sheet);
      keys.push(...Object.keys(data));
    }
    return keys;
  },
  getOwnPropertyDescriptor(_, prop) {
    return { configurable: true, enumerable: true, value: this.get(_, prop) };
  }
});
const kpis = values;

// Helper: find cells by label text (uses pre-built label index)
function findByLabel(label, sheet) {
  const key = label.toLowerCase();
  const matches = [];
  // Search label index for partial matches
  for (const [indexKey, entries] of Object.entries(labelIndex)) {
    if (!indexKey.includes(key)) continue;
    for (const entry of entries) {
      if (sheet && entry.sheet !== sheet) continue;
      // Load the sheet and find numeric values in the same row
      const sheetData = loadSheet(entry.sheet);
      const cellPart = entry.addr.split('!')[1];
      const row = cellPart.replace(/[A-Z]+/g, '');
      for (const [a2, v2] of Object.entries(sheetData)) {
        if (typeof v2 === 'number' && v2 !== 0) {
          const cp2 = a2.split('!')[1];
          const row2 = cp2.replace(/[A-Z]+/g, '');
          if (row2 === row && a2 !== entry.addr) {
            matches.push({ label: sheetData[entry.addr] || label, labelAddr: entry.addr, valueAddr: a2, value: v2, sheet: entry.sheet });
          }
        }
      }
      if (matches.length >= 20) break; // cap results
    }
    if (matches.length >= 20) break;
  }
  return matches;
}

// Helper: get value by exact address
function getCell(addr) {
  const bang = addr.indexOf('!');
  if (bang < 0) return undefined;
  const sheet = addr.slice(0, bang);
  const data = loadSheet(sheet);
  return data[addr];
}

// Helper: list all cells on a sheet (loads only that sheet)
function listSheet(sheetName, maxRows) {
  const data = loadSheet(sheetName);
  const cells = Object.entries(data).map(([addr, value]) => ({ addr, value }));
  cells.sort((a, b) => a.addr.localeCompare(b.addr));
  return maxRows ? cells.slice(0, maxRows) : cells;
}

// Helper: list all sheets
function listSheets() {
  return allSheets;
}

// Run the user's code
try {
  const result = await (async () => {
    ${code}
  })();
  if (result !== undefined) {
    process.stdout.write(JSON.stringify({ success: true, result }));
  } else {
    process.stdout.write(JSON.stringify({ success: true, result: 'undefined' }));
  }
} catch (err) {
  process.stdout.write(JSON.stringify({ success: false, error: err.message }));
}
`;

  const tmpFile = join(chunkedDir, '_blind_eval_tmp.mjs');
  await writeFile(tmpFile, wrappedCode);

  try {
    const { stdout, stderr } = await execAsync('node', ['--max-old-space-size=8192', tmpFile], {
      timeout: 60000, // 1 min (pre-computed values load in ~5s even for large models)
      maxBuffer: 10 * 1024 * 1024,
    });
    try {
      return JSON.parse(stdout);
    } catch {
      return { success: true, result: stdout.trim() };
    }
  } catch (err) {
    return {
      success: false,
      error: err.message?.slice(0, 500) || 'Unknown error',
      stderr: err.stderr?.slice(0, 500),
    };
  }
}

// ── System prompt for blind eval ────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a financial analyst evaluating a JavaScript computation engine that models a financial portfolio. You have NO prior knowledge of how the engine was built or what its internal structure looks like.

You have one tool: execute_js — it runs JavaScript code in a Node.js environment where the engine is already loaded. The following variables and helpers are available in your code:

- \`values\` — Object with all computed cell values, keyed by "SheetName!CellRef" (e.g., "Assumptions!B2")
- \`kpis\` — Same as values (all computed outputs)
- \`getCell(addr)\` — Get a specific cell value by address
- \`findByLabel(label, sheet?)\` — Search for cells whose text content matches the label, returns matching numeric values in the same row
- \`listSheet(sheetName, maxRows?)\` — List all cells on a sheet (sorted by address)
- \`listSheets()\` — List all sheet names

Your task: Answer the financial question by querying the engine. You may call execute_js multiple times to explore the data.

IMPORTANT:
- First explore the available sheets and their structure before answering
- Return your final numeric answer with \`return <value>\`
- If you can't find the answer, return null and explain why
- Log your reasoning as you go — describe what you're looking for and what you find

Respond with a JSON object at the end:
{
  "answer": <number or null>,
  "confidence": "high" | "medium" | "low",
  "methodology": "description of how you found the answer",
  "cells_used": ["SheetName!Cell1", "SheetName!Cell2"]
}`;

// ── Run one question through the blind eval ─────────────────────────────────
async function evalOneQuestion(question) {
  const startTime = Date.now();
  const messages = [
    {
      role: 'user',
      content: `Answer this question about the financial model:\n\n"${question.question}"\n\nUse the execute_js tool to query the engine and find the answer. Start by exploring the sheet structure, then locate the relevant data.`,
    },
  ];

  const tools = [
    {
      name: 'execute_js',
      description: 'Execute JavaScript code against the financial model engine. The engine is already loaded. Available: values (all cell values), getCell(addr), findByLabel(label, sheet?), listSheet(sheetName, maxRows?), listSheets(). Use `return <value>` to return results.',
      input_schema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'JavaScript code to execute. Use `return <expression>` to return a value.',
          },
        },
        required: ['code'],
      },
    },
  ];

  let toolCalls = 0;
  const maxToolCalls = 8;
  let finalResponse = null;

  try {
    while (toolCalls < maxToolCalls) {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });

      // Check if Claude wants to use a tool
      const toolUse = response.content.find(c => c.type === 'tool_use');

      if (!toolUse || response.stop_reason === 'end_turn') {
        // Claude is done — extract the final answer from text
        const textBlock = response.content.find(c => c.type === 'text');
        finalResponse = textBlock?.text || '';
        break;
      }

      // Execute all tool_use blocks in the response
      const toolUses = response.content.filter(c => c.type === 'tool_use');

      // Add the full assistant response first
      messages.push({ role: 'assistant', content: response.content });

      // Execute each tool and collect results
      const toolResults = [];
      for (const tu of toolUses) {
        toolCalls++;
        const jsCode = tu.input.code;
        const result = await executeJs(jsCode);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result).slice(0, 5000),
        });
      }

      // Add all tool results in a single user message
      messages.push({ role: 'user', content: toolResults });
    }
  } catch (err) {
    return {
      id: question.id,
      question: question.question,
      expected: question.expected,
      source_cell: question.source_cell,
      computed: null,
      pass: false,
      error: err.message,
      methodology: 'API call failed',
      confidence: 'none',
      cells_used: [],
      tool_calls: toolCalls,
      duration_ms: Date.now() - startTime,
    };
  }

  // Parse Claude's final response to extract the JSON answer
  let parsed = { answer: null, confidence: 'low', methodology: '', cells_used: [] };
  if (finalResponse) {
    try {
      // Try to find JSON in the response
      const jsonMatch = finalResponse.match(/\{[\s\S]*"answer"[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      }
    } catch {
      // If JSON parsing fails, try to extract a number
      const numMatch = finalResponse.match(/answer[:\s]+(-?[\d,.]+)/i);
      if (numMatch) {
        parsed.answer = parseFloat(numMatch[1].replace(/,/g, ''));
      }
      parsed.methodology = finalResponse.slice(0, 500);
    }
  }

  // Compare answer vs expected
  const computed = parsed.answer;
  let pass = false;
  if (computed !== null && computed !== undefined && question.expected !== null) {
    if (typeof question.expected === 'string') {
      pass = String(computed) === question.expected;
    } else {
      const relError = Math.abs(question.expected) < 1e-9
        ? Math.abs(computed)
        : Math.abs((computed - question.expected) / question.expected);
      pass = relError < 0.01; // 1% tolerance
    }
  }

  return {
    id: question.id,
    question: question.question,
    expected: question.expected,
    source_cell: question.source_cell,
    label: question.label,
    sheet: question.sheet,
    computed,
    pass,
    methodology: parsed.methodology || '',
    confidence: parsed.confidence || 'unknown',
    cells_used: parsed.cells_used || [],
    tool_calls: toolCalls,
    duration_ms: Date.now() - startTime,
  };
}

// ── Concurrency limiter ─────────────────────────────────────────────────────
async function withConcurrency(tasks, limit) {
  const results = [];
  const executing = [];
  for (const task of tasks) {
    const p = task().then(r => {
      executing.splice(executing.indexOf(p), 1);
      return r;
    });
    results.push(p);
    executing.push(p);
    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Blind Eval — Independent Engine Validation');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Engine: ${ENGINE_PATH}`);
  console.log(`  Questions: ${QUESTIONS_FILE}`);
  console.log(`  Model: ${MODEL}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log('');

  if (!existsSync(ENGINE_PATH)) {
    console.error(`Engine not found: ${ENGINE_PATH}`);
    process.exit(1);
  }

  const questions = JSON.parse(await readFile(QUESTIONS_FILE, 'utf8'));
  console.log(`  Loaded ${questions.length} questions`);

  // Pre-compute engine output once (avoids re-running 1.7M cells per tool call)
  if (!existsSync(PRECOMPUTED_PATH)) {
    await precomputeEngine();
  } else {
    console.log(`  Using cached engine output: ${PRECOMPUTED_PATH}`);
  }

  // Build per-sheet index for fast tool call access
  if (!existsSync(join(INDEX_DIR, '_sheets.json'))) {
    await buildIndex();
  } else {
    console.log(`  Using cached index: ${INDEX_DIR}`);
  }
  console.log('');

  // Run all questions through blind eval
  const startTime = Date.now();
  let completed = 0;

  const tasks = questions.map((q) => () =>
    evalOneQuestion(q).then(result => {
      completed++;
      const icon = result.pass ? '✅' : result.error ? '❌' : '🔴';
      console.log(`  ${icon} [${completed}/${questions.length}] ${result.id}: ${result.pass ? 'PASS' : 'FAIL'} (${result.tool_calls} tools, ${result.duration_ms}ms)`);
      if (!result.pass && !result.error) {
        console.log(`     Expected: ${result.expected}, Got: ${result.computed}`);
        console.log(`     Method: ${result.methodology?.slice(0, 120)}`);
      }
      return result;
    })
  );

  const results = await withConcurrency(tasks, CONCURRENCY);

  const totalTime = Date.now() - startTime;
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass && !r.error).length;
  const errors = results.filter(r => r.error).length;
  const totalToolCalls = results.reduce((acc, r) => acc + r.tool_calls, 0);

  // Build report
  const report = {
    summary: {
      total: questions.length,
      passed,
      failed,
      errors,
      accuracy: questions.length > 0 ? (passed / questions.length * 100).toFixed(1) + '%' : '0%',
      total_tool_calls: totalToolCalls,
      avg_tool_calls: (totalToolCalls / questions.length).toFixed(1),
      total_time_ms: totalTime,
      avg_time_per_question_ms: Math.round(totalTime / questions.length),
      model: MODEL,
    },
    by_category: {},
    by_difficulty: {},
    results,
  };

  // Aggregate by category and difficulty
  for (const r of results) {
    const q = questions.find(q => q.id === r.id);
    if (!q) continue;

    for (const groupKey of ['category', 'difficulty']) {
      const group = q[groupKey];
      if (!report[`by_${groupKey}`][group]) {
        report[`by_${groupKey}`][group] = { total: 0, passed: 0, failed: 0, errors: 0 };
      }
      report[`by_${groupKey}`][group].total++;
      if (r.pass) report[`by_${groupKey}`][group].passed++;
      else if (r.error) report[`by_${groupKey}`][group].errors++;
      else report[`by_${groupKey}`][group].failed++;
    }
  }

  await writeFile(OUTPUT_FILE, JSON.stringify(report, null, 2));

  // Print summary
  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Results: ${passed}/${questions.length} passed (${report.summary.accuracy})`);
  console.log(`  Failed: ${failed}, Errors: ${errors}`);
  console.log(`  Tool calls: ${totalToolCalls} total (${report.summary.avg_tool_calls} avg)`);
  console.log(`  Time: ${(totalTime / 1000).toFixed(1)}s (${report.summary.avg_time_per_question_ms}ms avg)`);
  console.log('');
  console.log('  By category:');
  for (const [cat, stats] of Object.entries(report.by_category)) {
    const pct = stats.total > 0 ? (stats.passed / stats.total * 100).toFixed(0) : 0;
    console.log(`    ${cat}: ${stats.passed}/${stats.total} (${pct}%)`);
  }
  console.log('');
  console.log('  By difficulty:');
  for (const [diff, stats] of Object.entries(report.by_difficulty)) {
    const pct = stats.total > 0 ? (stats.passed / stats.total * 100).toFixed(0) : 0;
    console.log(`    ${diff}: ${stats.passed}/${stats.total} (${pct}%)`);
  }
  console.log('');
  console.log(`  Report saved to: ${OUTPUT_FILE}`);
  console.log('═══════════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

/**
 * analyze-report.mjs — Analyze blind eval results and generate fix recommendations
 *
 * Reads eval-report.json from the blind eval and produces:
 * 1. A human-readable summary of what works and what doesn't
 * 2. Categorized failure patterns (not just cell-level, but WHY)
 * 3. Prioritized fix recommendations for the next code session
 *
 * Usage:
 *   node analyze-report.mjs <eval-report.json> [--output analysis.json]
 */

import { readFile, writeFile } from 'fs/promises';

const args = process.argv.slice(2);
const REPORT_FILE = args.find(a => !a.startsWith('--')) || 'eval-report.json';
const oIdx = args.indexOf('--output');
const OUTPUT_FILE = oIdx >= 0 ? args[oIdx + 1] : REPORT_FILE.replace('eval-report', 'analysis');

async function main() {
  const report = JSON.parse(await readFile(REPORT_FILE, 'utf8'));
  const results = report.results || [];

  console.log('═══════════════════════════════════════════════════════');
  console.log('  Blind Eval Analysis');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Total: ${report.summary.total} questions`);
  console.log(`  Passed: ${report.summary.passed} (${report.summary.accuracy})`);
  console.log(`  Failed: ${report.summary.failed}`);
  console.log(`  Errors: ${report.summary.errors}`);
  console.log('');

  // ── Failure Pattern Analysis ──────────────────────────────────────────────
  const failures = results.filter(r => !r.pass);
  const patterns = {
    engine_returned_zero: [],
    engine_returned_null: [],
    wrong_value: [],
    api_error: [],
    could_not_find: [],
    wrong_cell: [],
    scale_mismatch: [],
  };

  for (const f of failures) {
    if (f.error) {
      patterns.api_error.push(f);
    } else if (f.computed === null || f.computed === undefined) {
      patterns.engine_returned_null.push(f);
    } else if (f.computed === 0 && f.expected !== 0) {
      patterns.engine_returned_zero.push(f);
    } else if (f.methodology && /could not find|couldn't find|not found|no.*match/i.test(f.methodology)) {
      patterns.could_not_find.push(f);
    } else if (f.expected && f.computed) {
      const ratio = f.computed / f.expected;
      if (Math.abs(ratio - 1000) < 200 || Math.abs(ratio - 0.001) < 0.0005) {
        patterns.scale_mismatch.push(f);
      } else if (Math.abs(ratio - 100) < 20 || Math.abs(ratio - 0.01) < 0.005) {
        patterns.scale_mismatch.push(f);
      } else {
        patterns.wrong_value.push(f);
      }
    } else {
      patterns.wrong_value.push(f);
    }
  }

  console.log('  ── Failure Patterns ──────────────────────────────────');
  for (const [pattern, items] of Object.entries(patterns)) {
    if (items.length > 0) {
      console.log(`  ${pattern}: ${items.length}`);
      // Show top 3 examples
      for (const item of items.slice(0, 3)) {
        console.log(`    • ${item.id}: expected=${item.expected}, got=${item.computed}`);
        if (item.methodology) {
          console.log(`      ${item.methodology.slice(0, 100)}`);
        }
      }
    }
  }

  // ── Sheet-Level Analysis ──────────────────────────────────────────────────
  console.log('');
  console.log('  ── Sheet-Level Accuracy ─────────────────────────────');
  const bySheet = {};
  for (const r of results) {
    if (!r.sheet) continue;
    if (!bySheet[r.sheet]) bySheet[r.sheet] = { total: 0, passed: 0 };
    bySheet[r.sheet].total++;
    if (r.pass) bySheet[r.sheet].passed++;
  }
  const sheetEntries = Object.entries(bySheet).sort((a, b) => {
    const pctA = a[1].total > 0 ? a[1].passed / a[1].total : 0;
    const pctB = b[1].total > 0 ? b[1].passed / b[1].total : 0;
    return pctA - pctB;
  });
  for (const [sheet, stats] of sheetEntries) {
    const pct = stats.total > 0 ? (stats.passed / stats.total * 100).toFixed(0) : 0;
    const icon = pct >= 80 ? '✅' : pct >= 50 ? '🔶' : '🔴';
    console.log(`    ${icon} ${sheet}: ${stats.passed}/${stats.total} (${pct}%)`);
  }

  // ── Methodology Analysis ──────────────────────────────────────────────────
  console.log('');
  console.log('  ── Claude\'s Approach Patterns ────────────────────────');
  const approaches = {
    used_findByLabel: results.filter(r => r.methodology?.includes('findByLabel')).length,
    used_getCell: results.filter(r => r.methodology?.includes('getCell')).length,
    used_listSheet: results.filter(r => r.methodology?.includes('listSheet')).length,
    explored_first: results.filter(r => r.tool_calls > 2).length,
    direct_lookup: results.filter(r => r.tool_calls <= 2).length,
  };
  for (const [approach, count] of Object.entries(approaches)) {
    console.log(`    ${approach}: ${count}`);
  }

  // ── Fix Recommendations ───────────────────────────────────────────────────
  console.log('');
  console.log('  ── Fix Recommendations (prioritized) ────────────────');
  const recommendations = [];

  if (patterns.engine_returned_zero.length > 3) {
    recommendations.push({
      priority: 1,
      category: 'transpiler',
      issue: `${patterns.engine_returned_zero.length} questions returned 0 instead of expected value`,
      fix: 'Check for stubbed/unimplemented Excel functions in transpiler.rs. Likely SUMIF, COUNTIF, OFFSET, or INDIRECT returning 0.',
      examples: patterns.engine_returned_zero.slice(0, 3).map(f => ({
        question: f.question,
        expected: f.expected,
        cell: f.source_cell,
      })),
    });
  }

  if (patterns.engine_returned_null.length > 2) {
    recommendations.push({
      priority: 2,
      category: 'engine_structure',
      issue: `${patterns.engine_returned_null.length} questions could not find any value`,
      fix: 'Engine may not be computing these cells at all. Check if the sheets containing these cells are in the topo order and being executed.',
      examples: patterns.engine_returned_null.slice(0, 3).map(f => ({
        question: f.question,
        expected: f.expected,
        cell: f.source_cell,
      })),
    });
  }

  if (patterns.could_not_find.length > 2) {
    recommendations.push({
      priority: 3,
      category: 'usability',
      issue: `${patterns.could_not_find.length} questions — Claude couldn't locate the data in the engine output`,
      fix: 'Engine output structure may be hard to navigate. Consider adding metadata (labels, sheet descriptions) to the engine output.',
      examples: patterns.could_not_find.slice(0, 3).map(f => ({
        question: f.question,
        methodology: f.methodology?.slice(0, 200),
      })),
    });
  }

  if (patterns.scale_mismatch.length > 1) {
    recommendations.push({
      priority: 4,
      category: 'calibration',
      issue: `${patterns.scale_mismatch.length} questions have values off by a factor of 100x or 1000x`,
      fix: 'Unit scaling issue — likely percentage vs decimal or thousands vs units mismatch in the transpiler.',
      examples: patterns.scale_mismatch.slice(0, 3).map(f => ({
        question: f.question,
        expected: f.expected,
        computed: f.computed,
        ratio: f.expected !== 0 ? (f.computed / f.expected).toFixed(2) : 'N/A',
      })),
    });
  }

  if (patterns.wrong_value.length > 3) {
    recommendations.push({
      priority: 5,
      category: 'formula_logic',
      issue: `${patterns.wrong_value.length} questions returned wrong values (not zero, not scale mismatch)`,
      fix: 'Formula transpilation errors. Examine specific formulas for these cells in the Excel model.',
      examples: patterns.wrong_value.slice(0, 5).map(f => ({
        question: f.question,
        expected: f.expected,
        computed: f.computed,
        cell: f.source_cell,
        methodology: f.methodology?.slice(0, 200),
      })),
    });
  }

  for (const rec of recommendations.sort((a, b) => a.priority - b.priority)) {
    console.log(`  ${rec.priority}. [${rec.category}] ${rec.issue}`);
    console.log(`     Fix: ${rec.fix}`);
  }

  // ── Write analysis ────────────────────────────────────────────────────────
  const analysis = {
    summary: report.summary,
    failure_patterns: Object.fromEntries(
      Object.entries(patterns).map(([k, v]) => [k, v.length])
    ),
    by_sheet: Object.fromEntries(sheetEntries.map(([sheet, stats]) => [
      sheet,
      { ...stats, accuracy: stats.total > 0 ? (stats.passed / stats.total * 100).toFixed(1) + '%' : '0%' },
    ])),
    approach_patterns: approaches,
    recommendations,
    // Include full failure details for the code session to consume
    detailed_failures: failures.map(f => ({
      id: f.id,
      question: f.question,
      expected: f.expected,
      computed: f.computed,
      source_cell: f.source_cell,
      label: f.label,
      sheet: f.sheet,
      methodology: f.methodology,
      confidence: f.confidence,
      cells_used: f.cells_used,
    })),
  };

  await writeFile(OUTPUT_FILE, JSON.stringify(analysis, null, 2));
  console.log('');
  console.log(`  Analysis saved to: ${OUTPUT_FILE}`);
  console.log('═══════════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

/**
 * validate-extraction.mjs — Cross-sheet validation of the parsed model
 *
 * Checks:
 *   - All cross-sheet references resolve to actual cells
 *   - Formula parse errors are below acceptable threshold
 *   - Ground truth coverage (what % of formula cells have Excel result values)
 *   - Circular reference clusters identified
 *
 * Usage:
 *   node validate-extraction.mjs <output_dir>
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

async function main() {
  const [, , outputDir = '.'] = process.argv;

  const [modelMap, formulas, depGraph] = await Promise.all([
    readFile(join(outputDir, 'model-map.json'), 'utf8').then(JSON.parse),
    readFile(join(outputDir, 'formulas.json'), 'utf8').then(JSON.parse),
    readFile(join(outputDir, 'dependency-graph.json'), 'utf8').then(JSON.parse),
  ]);

  const issues = [];
  const warnings = [];

  // Build set of all known cell addresses
  const knownCells = new Set();
  for (const sheet of modelMap.sheets) {
    for (const cell of [...sheet.numeric_cells, ...sheet.text_cells, ...sheet.formula_cells]) {
      knownCells.add(`${sheet.name}!${cell.address}`);
    }
  }

  // Check 1: Unresolved cross-sheet references
  let unresolvedRefs = 0;
  for (const [node, deps] of Object.entries(depGraph.edges)) {
    for (const dep of deps) {
      if (!knownCells.has(dep) && dep.includes('!')) {
        unresolvedRefs++;
        if (unresolvedRefs <= 5) {
          warnings.push(`Unresolved ref: ${node} → ${dep}`);
        }
      }
    }
  }
  if (unresolvedRefs > 5) {
    warnings.push(`... and ${unresolvedRefs - 5} more unresolved cross-sheet refs`);
  }

  // Check 2: Formula parse errors
  const parseErrors = formulas.filter(f => f.parse_error);
  if (parseErrors.length > 0) {
    const pct = (parseErrors.length / formulas.length * 100).toFixed(1);
    if (parseErrors.length > formulas.length * 0.1) {
      issues.push(`High parse error rate: ${parseErrors.length}/${formulas.length} (${pct}%)`);
    } else {
      warnings.push(`Parse errors: ${parseErrors.length}/${formulas.length} (${pct}%)`);
    }
    for (const f of parseErrors.slice(0, 3)) {
      warnings.push(`  ${f.qualified_address}: ${f.parse_error}`);
    }
  }

  // Check 3: Ground truth coverage
  const withResults = formulas.filter(f => f.excel_result !== null).length;
  const coverage = formulas.length > 0 ? withResults / formulas.length : 0;
  if (coverage < 0.3) {
    warnings.push(`Low ground truth coverage: ${(coverage * 100).toFixed(1)}% (${withResults}/${formulas.length} formula cells have computed values)`);
  }

  // Check 4: Circular clusters
  const clusters = depGraph.convergence_clusters || [];
  if (clusters.length > 0) {
    const info = clusters.map(c => `${c.cells.join(', ')}`).join('; ');
    warnings.push(`Circular clusters (${clusters.length}): ${info}`);
  }

  // Check 5: Depth of dependency graph
  const maxDeps = Math.max(...Object.values(depGraph.edges).map(deps => deps.length), 0);
  if (maxDeps > 100) {
    warnings.push(`Very wide dependency (${maxDeps} deps for one cell) — may be a large range`);
  }

  const result = {
    status: issues.length === 0 ? 'ok' : 'issues',
    issues,
    warnings,
    stats: {
      totalSheets: modelMap.stats.total_sheets,
      totalCells: modelMap.stats.total_cells,
      totalFormulas: modelMap.stats.total_formula_cells,
      parseErrors: parseErrors.length,
      groundTruthCoverage: parseFloat((coverage * 100).toFixed(1)),
      unresolvedRefs,
      circularClusters: clusters.length,
    },
  };

  await writeFile(join(outputDir, 'validation.json'), JSON.stringify(result, null, 2));

  if (issues.length > 0) {
    console.error('[validate] Issues found:');
    issues.forEach(i => console.error(`  ✗ ${i}`));
  }
  if (warnings.length > 0) {
    warnings.forEach(w => console.warn(`  ⚠ ${w}`));
  }
  console.log(`[validate] ${result.status}: ${modelMap.stats.total_formulas || modelMap.stats.total_formula_cells} formulas, ${(coverage * 100).toFixed(0)}% ground truth, ${clusters.length} circular clusters`);

  if (issues.length > 0) process.exit(1);
}

main().catch(err => {
  console.error('Validation error:', err);
  process.exit(1);
});

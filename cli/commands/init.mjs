/**
 * ete init — Parse Excel model + generate manifest in one step.
 *
 * Wraps the Rust parser and manifest generation into
 * a single zero-to-queryable command.
 *
 * @license MIT
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { runManifestCommand } from './manifest.mjs';
import { runSummary } from './summary.mjs';

/**
 * Execute the init command.
 */
export function runInit(excelPath, args) {
  const outputDir = args.output || excelPath.replace(/\.xlsx?$/i, '');
  const absOutput = resolve(outputDir);
  const chunkedDir = join(absOutput, 'chunked');

  // Step 1: Find and run the Rust parser
  const parserPaths = [
    join(process.cwd(), 'pipelines/rust/target/release/rust-parser'),
    join(process.cwd(), 'pipelines/rust/target/debug/rust-parser'),
  ];

  let parserBin = parserPaths.find(p => existsSync(p));

  if (!parserBin) {
    return {
      error: 'Rust parser not found. Build it first:\n  cd pipelines/rust && cargo build --release',
      _formatted: 'Error: Rust parser not found.\n\nBuild it:\n  cd pipelines/rust && cargo build --release\n\nThen re-run:\n  ete init ' + excelPath,
    };
  }

  if (!existsSync(excelPath)) {
    return { error: `Excel file not found: ${excelPath}` };
  }

  const lines = [];
  lines.push(`Parsing: ${excelPath}`);
  lines.push(`Output:  ${absOutput}`);
  lines.push('');

  // Run parser
  try {
    lines.push('Step 1/3: Running Rust parser...');
    const cmd = `"${parserBin}" "${resolve(excelPath)}" "${absOutput}" --chunked`;
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 600000 });
    lines.push('  Parser completed.');

    // Extract key stats from parser output
    const cellMatch = output.match(/Total cells:\s*([\d,]+)/);
    const sheetMatch = output.match(/Total sheets:\s*(\d+)/);
    if (cellMatch) lines.push(`  Cells: ${cellMatch[1]}`);
    if (sheetMatch) lines.push(`  Sheets: ${sheetMatch[1]}`);
  } catch (e) {
    return {
      error: `Parser failed: ${e.message}`,
      _formatted: `Error: Rust parser failed.\n${e.stderr || e.message}`,
    };
  }

  // Step 2: Generate manifest
  lines.push('');
  lines.push('Step 2/4: Generating manifest...');
  const manifestResult = runManifestCommand('generate', chunkedDir, {
    source: excelPath.split('/').pop(),
  });

  if (manifestResult.error) {
    lines.push(`  Warning: ${manifestResult.error}`);
  } else {
    lines.push(`  Manifest written: ${manifestResult.outputPath}`);
    lines.push(`  Model type: ${manifestResult.manifest.model.type}`);
    lines.push(`  Segments: ${manifestResult.manifest.segments.length}`);
  }

  // Step 3: Refine manifest (smart search for key financial metrics)
  lines.push('');
  lines.push('Step 3/4: Refining manifest (searching for IRR, MOIC, carry, equity)...');
  try {
    const refineResult = runManifestCommand('refine', chunkedDir, { apply: true });
    if (refineResult._formatted) {
      // Show just the found/not-found summary, not the full report
      const foundCount = Object.keys(refineResult.found || {}).length;
      const existingCount = Object.keys(refineResult.existing || {}).length;
      const totalFields = foundCount + existingCount + (refineResult.notFound || []).length;
      lines.push(`  Coverage: ${foundCount + existingCount}/${totalFields} key fields mapped`);
      if (foundCount > 0) lines.push(`  Refined: ${foundCount} new fields found and patched`);
      if (refineResult.notFound?.length > 0) {
        lines.push(`  Missing: ${refineResult.notFound.join(', ')}`);
      }
    }
  } catch (e) {
    lines.push(`  (Refinement skipped: ${e.message})`);
  }

  // Step 4: Print summary
  lines.push('');
  lines.push('Step 4/4: Model summary');
  lines.push('─'.repeat(60));

  try {
    const summary = runSummary(chunkedDir, { format: 'table' });
    if (summary._formatted) {
      lines.push(summary._formatted);
    }
  } catch (e) {
    lines.push(`  (Summary unavailable: ${e.message})`);
  }

  // Review checklist
  if (manifestResult.reviewChecklist?.length > 0) {
    lines.push('');
    lines.push('Review checklist:');
    for (const item of manifestResult.reviewChecklist) {
      lines.push(`  ${item}`);
    }
  }

  lines.push('');
  lines.push(`Ready. Try: ete summary ${chunkedDir}`);

  return {
    outputDir: absOutput,
    chunkedDir,
    manifest: manifestResult.manifest,
    _formatted: lines.join('\n'),
  };
}

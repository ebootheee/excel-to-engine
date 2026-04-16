/**
 * ete init — Parse Excel model + generate manifest in one step.
 *
 * Wraps the Rust parser and manifest generation into
 * a single zero-to-queryable command.
 *
 * @license MIT
 */

import { execSync } from 'child_process';
import { existsSync, unlinkSync, statSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runManifestCommand } from './manifest.mjs';
import { runSummary } from './summary.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '..', '..', 'templates');

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

  // Clean up redundant root-level model-map.json in chunked mode. The CLI
  // reads exclusively from chunked/. On large models the root file can be
  // 600+ MB while serving no downstream consumer. Opt out with --keep-model-map.
  if (!args.keepModelMap) {
    const rootModelMap = join(absOutput, 'model-map.json');
    const rootFormulas = join(absOutput, 'formulas.json');
    if (existsSync(rootModelMap)) {
      try {
        const size = statSync(rootModelMap).size;
        unlinkSync(rootModelMap);
        if (size > 1e6) lines.push(`  Cleaned up redundant model-map.json (${(size / 1e6).toFixed(0)} MB)`);
      } catch { /* ignore */ }
    }
    if (existsSync(rootFormulas)) {
      try { unlinkSync(rootFormulas); } catch { /* ignore */ }
    }
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
  lines.push('Step 3/5: Refining manifest (searching for IRR, MOIC, carry, equity)...');
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

  // Step 3b: Apply template if specified
  // Also auto-detect when a template matches this model's sheet names and
  // suggest it (prints a hint, no automatic apply).
  if (args.template) {
    lines.push('');
    lines.push(`Applying template: ${args.template}`);
    const templateResult = applyTemplate(chunkedDir, args.template);
    if (templateResult.error) {
      lines.push(`  Warning: ${templateResult.error}`);
    } else {
      lines.push(`  Applied ${templateResult.applied} cell mappings from ${templateResult.path}`);
    }
  } else {
    const suggestion = detectMatchingTemplate(chunkedDir);
    if (suggestion) {
      lines.push('');
      lines.push(`  Template suggestion: this model matches "${suggestion}" — re-run with --template ${suggestion} to apply known cell mappings.`);
    }
  }

  // Step 3c: Doctor-gated validation
  // See PLAN_V4.md Phase 4b. Doctor runs after refine+template. Errors abort
  // init unless --force (CI / known-quirky models) is passed.
  lines.push('');
  lines.push('Step 4/5: Doctor validation...');
  let doctorResult;
  try {
    doctorResult = runManifestCommand('doctor', chunkedDir, {});
    const errors = (doctorResult.issues || []).filter(i => i.severity === 'error');
    const warnings = (doctorResult.issues || []).filter(i => i.severity === 'warn');
    if (errors.length > 0) {
      lines.push(`  ✗ ${errors.length} error(s), ${warnings.length} warning(s)`);
      for (const e of errors) {
        lines.push(`    ${e.field}: ${e.message}`);
        if (e.fix) lines.push(`      fix: ${e.fix}`);
      }
      if (!args.force) {
        return {
          error: `Manifest validation failed with ${errors.length} error(s). Fix the issues above or re-run with --force.`,
          _formatted: lines.join('\n') + '\n\nManifest validation failed. Pass --force to continue anyway.',
        };
      } else {
        lines.push('  (proceeding with --force despite errors)');
      }
    } else if (warnings.length > 0) {
      lines.push(`  ${warnings.length} warning(s); run 'ete manifest doctor ${chunkedDir}' for details`);
    } else {
      lines.push('  All checks passed.');
    }
  } catch (e) {
    lines.push(`  (Doctor skipped: ${e.message})`);
  }

  // Step 5: Print summary
  lines.push('');
  lines.push('Step 5/5: Model summary');
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

  // Machine-readable quiet output: skips all the narrative, returns a
  // compact JSON-ready summary for CI/agent contexts.
  if (args.quiet) {
    const m = manifestResult.manifest;
    const quiet = {
      ok: true,
      outputDir: absOutput,
      chunkedDir,
      modelType: m?.model?.type,
      sheets: m ? (Object.keys(new Set((Object.keys(m.baseCaseOutputs || {}))) )).length : undefined,
      segments: m?.segments?.length || 0,
      equityClasses: m?.equity?.classes?.length || 0,
      timeline: m?.timeline ? {
        investmentYear: m.timeline.investmentYear,
        exitYear: m.timeline.exitYear,
        periodicity: m.timeline.periodicity,
      } : null,
      baseCaseOutputs: m?.baseCaseOutputs || {},
    };
    return {
      outputDir: absOutput,
      chunkedDir,
      manifest: manifestResult.manifest,
      _formatted: JSON.stringify(quiet, null, 2),
    };
  }

  return {
    outputDir: absOutput,
    chunkedDir,
    manifest: manifestResult.manifest,
    _formatted: lines.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Template application
// ---------------------------------------------------------------------------

/**
 * Apply a named template's cell mappings to the manifest in `chunkedDir`.
 * Returns { applied, path } on success or { error } on failure.
 */
function applyTemplate(chunkedDir, templateName) {
  const templatePath = findTemplate(templateName);
  if (!templatePath) {
    return { error: `Template "${templateName}" not found in ${TEMPLATES_DIR}` };
  }
  const manifestPath = join(chunkedDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { error: `No manifest found at ${manifestPath}` };
  }

  const template = JSON.parse(readFileSync(templatePath, 'utf-8'));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  let applied = 0;
  for (const [path, cellRef] of Object.entries(template.mappings || {})) {
    if (path.startsWith('_')) continue; // comment keys
    if (typeof cellRef !== 'string' || !cellRef.includes('!')) continue;
    setNested(manifest, path, cellRef);
    applied++;
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { applied, path: templatePath };
}

/**
 * Detect whether the model matches a known template signature by checking
 * if manifest.model.sheets (or the derived set) contains all of the
 * template's signature.sheetNames. Returns the template name or null.
 */
function detectMatchingTemplate(chunkedDir) {
  if (!existsSync(TEMPLATES_DIR)) return null;

  const gtPath = join(chunkedDir, '_ground-truth.json');
  if (!existsSync(gtPath)) return null;
  const gt = JSON.parse(readFileSync(gtPath, 'utf-8'));

  // Extract unique sheet names from GT addresses
  const sheetSet = new Set();
  for (const addr of Object.keys(gt)) {
    const bang = addr.lastIndexOf('!');
    if (bang > 0) sheetSet.add(addr.substring(0, bang));
  }

  const files = readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'));
  for (const f of files) {
    try {
      const template = JSON.parse(readFileSync(join(TEMPLATES_DIR, f), 'utf-8'));
      const required = template.signature?.sheetNames || [];
      if (required.length === 0) continue;
      const hitCount = required.filter(n => sheetSet.has(n)).length;
      // Match if at least 75% of the signature sheet names are present.
      if (hitCount / required.length >= 0.75) {
        return template.name;
      }
    } catch { /* skip malformed templates */ }
  }
  return null;
}

function findTemplate(name) {
  if (!existsSync(TEMPLATES_DIR)) return null;
  // Allow both "outpost-platform" and "outpost-platform.json"
  const candidates = [
    join(TEMPLATES_DIR, name),
    join(TEMPLATES_DIR, `${name}.json`),
  ];
  return candidates.find(p => existsSync(p) && p.endsWith('.json')) || null;
}

function setNested(obj, path, value) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const nextIsIndex = /^\d+$/.test(parts[i + 1]);
    if (cur[key] == null) cur[key] = nextIsIndex ? [] : {};
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
}

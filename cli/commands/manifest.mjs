/**
 * ete manifest — Generate and validate model manifests.
 *
 * Subcommands:
 *   ete manifest generate <chunkedDir>  — Auto-generate from ground truth
 *   ete manifest validate <manifestPath> — Validate against ground truth
 *
 * @license MIT
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { generateManifest, validateManifest, loadGroundTruth } from '../../lib/manifest.mjs';
import { runManifestRefine } from './manifest-refine.mjs';

/**
 * Execute the manifest command.
 */
export function runManifestCommand(subcommand, targetPath, args) {
  switch (subcommand) {
    case 'generate':
      return runGenerate(targetPath, args);
    case 'validate':
      return runValidate(targetPath, args);
    case 'refine':
      return runManifestRefine(targetPath, args);
    default:
      return { error: 'Usage: ete manifest <generate|validate|refine> <path>' };
  }
}

/**
 * Generate a manifest from a chunked output directory.
 */
function runGenerate(chunkedDir, args) {
  // Find ground truth
  const gtPath = join(chunkedDir, '_ground-truth.json');
  if (!existsSync(gtPath)) {
    return { error: `Ground truth not found: ${gtPath}. Run the Rust parser first.` };
  }

  const gt = JSON.parse(readFileSync(gtPath, 'utf-8'));

  const { manifest, confidence, reviewChecklist } = generateManifest(gt, {
    groundTruthPath: './_ground-truth.json',
    engineDir: './',
    source: args.source,
  });

  // Write manifest
  const outPath = join(chunkedDir, 'manifest.json');
  writeFileSync(outPath, JSON.stringify(manifest, null, 2));

  // Format output
  const lines = [];
  lines.push(`Manifest generated: ${outPath}`);
  lines.push('');
  lines.push(`Model type: ${manifest.model.type} (confidence: ${(confidence.modelType * 100).toFixed(0)}%)`);
  lines.push(`Segments detected: ${manifest.segments.length}`);
  lines.push(`Timeline: ${manifest.timeline.investmentYear || '?'}–${manifest.timeline.exitYear || '?'} (${manifest.timeline.periodicity})`);
  lines.push(`Equity classes: ${manifest.equity?.classes?.length || 0}`);
  lines.push(`Carry tiers: ${manifest.carry?.tiers?.length || 0}`);
  lines.push(`Base case outputs: ${Object.keys(manifest.baseCaseOutputs || {}).length} resolved`);
  lines.push('');

  // Confidence scores
  lines.push('Confidence:');
  for (const [key, score] of Object.entries(confidence)) {
    const bar = '█'.repeat(Math.round(score * 10)) + '░'.repeat(10 - Math.round(score * 10));
    lines.push(`  ${key.padEnd(15)} ${bar} ${(score * 100).toFixed(0)}%`);
  }

  // Review checklist
  if (reviewChecklist.length > 0) {
    lines.push('');
    lines.push('Review checklist:');
    for (const item of reviewChecklist) {
      lines.push(`  ⚠ ${item}`);
    }
  }

  return {
    manifest,
    confidence,
    reviewChecklist,
    outputPath: outPath,
    _formatted: lines.join('\n'),
  };
}

/**
 * Validate a manifest against its ground truth.
 */
function runValidate(manifestPath, args) {
  if (!existsSync(manifestPath)) {
    return { error: `Manifest not found: ${manifestPath}` };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  // Resolve ground truth path relative to manifest
  const manifestDir = manifestPath.replace(/[/\\][^/\\]+$/, '');
  const gt = loadGroundTruth(manifest, manifestDir);

  const result = validateManifest(manifest, gt);

  const lines = [];
  lines.push(`Manifest: ${manifestPath}`);
  lines.push(`Status: ${result.valid ? 'VALID' : 'INVALID'}`);
  lines.push(`Cell references checked: ${result.cellRefsChecked}`);
  lines.push('');

  if (result.errors.length > 0) {
    lines.push(`Errors (${result.errors.length}):`);
    for (const err of result.errors) {
      lines.push(`  ✗ ${err}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push(`Warnings (${result.warnings.length}):`);
    for (const warn of result.warnings) {
      lines.push(`  ⚠ ${warn}`);
    }
  }

  if (result.valid && result.errors.length === 0 && result.warnings.length === 0) {
    lines.push('All checks passed.');
  }

  return { ...result, _formatted: lines.join('\n') };
}

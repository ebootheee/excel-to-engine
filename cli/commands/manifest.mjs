/**
 * ete manifest — Generate, validate, refine, doctor, and set manifest fields.
 *
 * Subcommands:
 *   ete manifest generate <chunkedDir>           Auto-generate from ground truth
 *   ete manifest validate <manifestPath>         Validate against ground truth
 *   ete manifest refine <chunkedDir> --apply     Smart search + patch
 *   ete manifest doctor <chunkedDir>             Flag suspect cell mappings
 *   ete manifest set <chunkedDir> <path> <cell>  Override a single cell reference
 *
 * @license MIT
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  generateManifest, validateManifest, loadGroundTruth, loadManifest,
  resolveCell, FIELD_RANGES, inFieldRange,
} from '../../lib/manifest.mjs';
import { runManifestRefine } from './manifest-refine.mjs';

/**
 * Execute the manifest command.
 */
export function runManifestCommand(subcommand, targetPath, args, extraArgs = []) {
  switch (subcommand) {
    case 'generate':
      return runGenerate(targetPath, args);
    case 'validate':
      return runValidate(targetPath, args);
    case 'refine':
      return runManifestRefine(targetPath, args);
    case 'doctor':
      return runDoctor(targetPath, args);
    case 'set':
      return runSet(targetPath, extraArgs[0], extraArgs[1], args);
    default:
      return { error: 'Usage: ete manifest <generate|validate|refine|doctor|set> <path>' };
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

// ---------------------------------------------------------------------------
// doctor — diagnose suspect mappings (value out of range, constant time-series)
// ---------------------------------------------------------------------------

// Fields to inspect with their FIELD_RANGES key for value-range checks.
const DOCTOR_FIELDS = [
  { path: 'outputs.terminalValue.cell',      field: 'terminalValue',  label: 'Terminal Value' },
  { path: 'outputs.exitMultiple.cell',       field: 'exitMultiple',   label: 'Exit Multiple' },
  { path: 'carry.totalCell',                 field: 'carryTotal',     label: 'Total Carry' },
  { path: 'debt.exitBalance',                field: 'exitDebt',       label: 'Exit Debt' },
  { path: 'customCells.wacc',                field: 'wacc',           label: 'WACC' },
  { path: 'customCells.sharesOutstanding',   field: 'sharesOutstanding', label: 'Shares Outstanding' },
  { path: 'customCells.pricePerShare',       field: 'pricePerShare',  label: 'Price Per Share' },
];

function runDoctor(modelDir, args) {
  const manifest = loadManifest(modelDir);
  const gt = loadGroundTruth(manifest, modelDir);

  const issues = [];
  const lines = [];
  lines.push('Manifest doctor');
  lines.push('═'.repeat(50));

  // Scalar-field value-range checks
  for (const spec of DOCTOR_FIELDS) {
    const cellRef = getNested(manifest, spec.path);
    if (!cellRef) continue;
    const val = resolveCell(gt, cellRef);
    if (val === undefined) {
      issues.push({
        severity: 'error',
        field: spec.path,
        cell: cellRef,
        message: `cell does not exist in ground truth`,
        fix: `ete query ${modelDir} --search "${spec.label.toLowerCase()}"`,
      });
      continue;
    }
    if (typeof val !== 'number') {
      issues.push({
        severity: 'warn',
        field: spec.path,
        cell: cellRef,
        value: val,
        message: `value is "${val}" (expected number)`,
        fix: `ete manifest set ${modelDir} ${spec.path} <cellRef>`,
      });
      continue;
    }
    if (!inFieldRange(spec.field, val)) {
      const range = FIELD_RANGES[spec.field];
      issues.push({
        severity: 'error',
        field: spec.path,
        cell: cellRef,
        value: val,
        message: `value ${val} outside expected range [${range.min}, ${range.max}] — ${range.label}`,
        fix: `ete query ${modelDir} --search "${spec.label.toLowerCase()}"  →  ete manifest set ${modelDir} ${spec.path} <goodCell>`,
      });
    }
  }

  // Equity class checks
  for (let i = 0; i < (manifest.equity?.classes || []).length; i++) {
    const ec = manifest.equity.classes[i];
    for (const field of ['basisCell', 'grossIRR', 'netIRR', 'grossMOIC', 'netMOIC']) {
      if (!ec[field]) continue;
      const val = resolveCell(gt, ec[field]);
      if (val === undefined) {
        issues.push({
          severity: 'error',
          field: `equity.classes[${i}].${field}`,
          cell: ec[field],
          message: 'cell does not exist in ground truth',
          fix: `ete query ${modelDir} --search "${field}"`,
        });
        continue;
      }
      if (typeof val !== 'number') {
        issues.push({
          severity: 'warn',
          field: `equity.classes[${i}].${field}`,
          cell: ec[field],
          value: val,
          message: `value is "${val}" (expected number)`,
          fix: `ete manifest set ${modelDir} equity.classes[${i}].${field} <cellRef>`,
        });
        continue;
      }
      if (!inFieldRange(field, val)) {
        const range = FIELD_RANGES[field];
        issues.push({
          severity: 'error',
          field: `equity.classes[${i}].${field}`,
          cell: ec[field],
          value: val,
          message: `value ${val} outside expected range [${range.min}, ${range.max}] — ${range.label}`,
          fix: `ete manifest set ${modelDir} equity.classes[${i}].${field} <goodCell>`,
        });
      }
    }
  }

  // Carry-specific label sanity check. Historically `carry.totalCell` has been
  // mapped to cells whose adjacent B-column label is "Total Cash Flows
  // (pre-carry)" or similar — any value above zero looks plausible without this
  // check. See SESSION_LOG_02_carry.md.
  if (manifest.carry?.totalCell) {
    const cell = manifest.carry.totalCell;
    const bang = cell.lastIndexOf('!');
    const sheet = cell.substring(0, bang);
    const rowMatch = cell.substring(bang + 1).match(/^([A-Z]+)(\d+)$/);
    if (rowMatch) {
      const row = parseInt(rowMatch[2], 10);
      const labelText = findRowLabel(gt, sheet, row);
      const lower = (labelText || '').toLowerCase();
      const isDisqualified = /pre.?(carry|promot)|cash.?flow|receivable|payable/.test(lower);
      if (isDisqualified) {
        issues.push({
          severity: 'error',
          field: 'carry.totalCell',
          cell,
          value: resolveCell(gt, cell),
          message: `adjacent label "${labelText}" describes a non-carry concept`,
          fix: `ete query ${modelDir} --search "Total (Carry|Promote|Carried Interest)" --sheet "${sheet}"  →  ete manifest set ${modelDir} carry.totalCell <goodCell>`,
        });
      }
    }
  }

  // Segment time-series check — each segment row should vary across timeline cols
  const yearCols = manifest.timeline?.columnMap ? Object.keys(manifest.timeline.columnMap) : [];
  for (const seg of manifest.segments || []) {
    if (yearCols.length < 3) break;
    const series = [];
    for (const col of yearCols) {
      const v = gt[`${seg.sheet}!${col}${seg.row}`];
      if (typeof v === 'number') series.push(v);
    }
    if (series.length < 3) {
      issues.push({
        severity: 'warn',
        field: `segments.${seg.id}`,
        message: `fewer than 3 numeric values on ${seg.sheet}!row ${seg.row} — not a time series`,
        fix: `ete query ${modelDir} --search "${seg.label.substring(0, 30)}"`,
      });
      continue;
    }
    const min = Math.min(...series);
    const max = Math.max(...series);
    const denom = Math.max(Math.abs(max), Math.abs(min));
    if (denom > 0 && Math.abs(max - min) / denom < 0.001) {
      issues.push({
        severity: 'warn',
        field: `segments.${seg.id}`,
        message: `row ${seg.sheet}!${seg.row} is constant across all years (${series[0]}) — likely a scalar assumption, not a P&L stream`,
        fix: `Remove from segments in manifest.json, or ete query ${modelDir} --search "${seg.label.substring(0, 30)}"`,
      });
    }
  }

  // Report
  if (issues.length === 0) {
    lines.push('All checks passed.');
  } else {
    const errorCount = issues.filter(i => i.severity === 'error').length;
    const warnCount = issues.filter(i => i.severity === 'warn').length;
    lines.push(`Found ${issues.length} issue(s): ${errorCount} error, ${warnCount} warn`);
    lines.push('');
    for (const issue of issues) {
      const icon = issue.severity === 'error' ? '✗' : '⚠';
      lines.push(`  ${icon} ${issue.field}`);
      if (issue.cell) lines.push(`      cell: ${issue.cell}${issue.value !== undefined ? ` = ${issue.value}` : ''}`);
      lines.push(`      ${issue.message}`);
      if (issue.fix) lines.push(`      fix:  ${issue.fix}`);
    }
  }

  return {
    issues,
    valid: issues.filter(i => i.severity === 'error').length === 0,
    _formatted: lines.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// set — override a single cell reference
// ---------------------------------------------------------------------------

function runSet(modelDir, fieldPath, cellRef, args) {
  if (!fieldPath || !cellRef) {
    return { error: 'Usage: ete manifest set <modelDir> <fieldPath> <cellRef>\n  Example: ete manifest set ./model/chunked/ equity.classes[0].grossIRR "Cheat Sheet!F15"' };
  }
  if (!/^[^!]+!(\$?[A-Z]+\$?\d+)$/.test(cellRef)) {
    return { error: `Invalid cell reference "${cellRef}". Expected format: Sheet!A1` };
  }

  const manifestPath = findManifestPath(modelDir);
  if (!existsSync(manifestPath)) {
    return { error: `Manifest not found at ${manifestPath}` };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const gt = loadGroundTruth(manifest, modelDir);

  // Verify cell exists
  const val = resolveCell(gt, cellRef);
  if (val === undefined) {
    return { error: `Cell ${cellRef} does not exist in ground truth. Check spelling and sheet name.` };
  }

  // Apply
  const oldRef = getNested(manifest, fieldPath);
  setNested(manifest, fieldPath, cellRef);

  // Also refresh baseCaseOutputs for known shorthand keys
  const shortKey = fieldPath.split('.').pop().replace(/^\[\d+\]$/, '').replace(/Cell$/, '');
  if (manifest.baseCaseOutputs && shortKey in manifest.baseCaseOutputs) {
    manifest.baseCaseOutputs[shortKey] = val;
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const lines = [];
  lines.push(`Manifest updated: ${manifestPath}`);
  lines.push(`  ${fieldPath}`);
  if (oldRef) lines.push(`  before: ${oldRef}`);
  lines.push(`  after:  ${cellRef} = ${formatVal(val)}`);

  return { field: fieldPath, oldRef, newRef: cellRef, value: val, _formatted: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Helpers (shared with refine)
// ---------------------------------------------------------------------------

function findManifestPath(modelDir) {
  const candidates = [
    join(modelDir, 'manifest.json'),
    join(modelDir, 'chunked', 'manifest.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return join(modelDir, 'manifest.json');
}

function getNested(obj, path) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
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

// Given a cell reference, find the human-readable label on its row — typically
// in column A or B. Returns null if no string label is on that row.
function findRowLabel(gt, sheet, row) {
  const prefix = sheet + '!';
  for (const col of 'ABCDEFGH'.split('')) {
    const v = gt[`${prefix}${col}${row}`];
    if (typeof v === 'string' && v.trim().length > 2) return v.trim();
  }
  return null;
}

function formatVal(val) {
  if (typeof val !== 'number') return String(val);
  if (Math.abs(val) >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
  if (Math.abs(val) >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
  if (Math.abs(val) >= 1e3) return `$${(val / 1e3).toFixed(1)}K`;
  if (Math.abs(val) < 1 && val !== 0) return `${(val * 100).toFixed(2)}%`;
  return val.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * ete manifest refine — Systematically search for key financial metrics
 * and patch the manifest with correct cell mappings.
 *
 * This is the "smart" pass after auto-generation. It searches ground truth
 * for the fields that matter most (IRR, MOIC, equity, carry) using broad
 * pattern matching and value-range validation.
 *
 * @license MIT
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { loadManifest, loadGroundTruth, resolveCell, MANIFEST_VERSION } from '../../lib/manifest.mjs';

// ---------------------------------------------------------------------------
// Required fields and their search strategies
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS = [
  {
    key: 'equity.classes[0].grossIRR',
    label: 'Gross IRR',
    patterns: [/gross.*irr|irr.*pre.*promot|irr.*pre.*carry|irr.*pre.*fee|levered.*irr|fund.*irr/i],
    valueRange: [0, 1],        // IRR as decimal
    valueHint: 'decimal 0-1 (e.g., 0.18 = 18%)',
  },
  {
    key: 'equity.classes[0].netIRR',
    label: 'Net IRR',
    patterns: [/net.*irr|irr.*post.*promot|irr.*post.*carry|irr.*after|lp.*irr/i],
    valueRange: [0, 1],
    valueHint: 'decimal 0-1',
  },
  {
    key: 'equity.classes[0].grossMOIC',
    label: 'Gross MOIC',
    patterns: [/gross.*mo[ic]|mo[ic].*pre.*promot|multiple.*pre|pre.*promot.*mo[ic]|tvpi.*pre|moc.*pre/i],
    valueRange: [0.5, 20],
    valueHint: 'number 0.5-20 (e.g., 2.85)',
  },
  {
    key: 'equity.classes[0].netMOIC',
    label: 'Net MOIC',
    patterns: [/net.*mo[ic]|mo[ic].*post.*promot|multiple.*post|post.*promot.*mo[ic]|tvpi.*post|moc.*post|lp.*mo[ic]/i],
    valueRange: [0.5, 20],
    valueHint: 'number 0.5-20',
  },
  {
    key: 'equity.classes[0].basisCell',
    label: 'Equity Basis / Peak Equity',
    patterns: [/peak.*equity|equity.*basis|equity.*invested|total.*equity|committed.*capital|capital.*committed|equity.*drawn/i],
    valueRange: [1e6, 50e9],   // $1M to $50B
    valueHint: 'large number (equity invested)',
  },
  {
    key: 'carry.totalCell',
    label: 'Total Carry / Promote',
    patterns: [/total.*(carry|promot)|carried.*interest.*total|(carry|promot).*total|gp.*(carry|promot)/i],
    valueRange: [0, 10e9],
    valueHint: 'number (total GP carry)',
  },
  {
    key: 'outputs.terminalValue.cell',
    label: 'Terminal / Enterprise Value',
    patterns: [/terminal.*val|enterprise.*val|exit.*val|total.*val.*exit|ev\b/i],
    valueRange: [1e6, 100e9],
    valueHint: 'large number (terminal value)',
  },
  {
    key: 'outputs.exitMultiple.cell',
    label: 'Exit Multiple',
    patterns: [/exit.*multiple|ebitda.*multiple|cap.*rate|exit.*ev.*ebitda/i],
    valueRange: [1, 50],
    valueHint: 'number 1-50 (EBITDA or revenue multiple)',
  },
];

/**
 * Build a pre-index of the ground truth for fast searching.
 * Groups string labels by sheet+row and numeric values by sheet+row.
 */
function buildIndex(gt) {
  const labels = [];       // { addr, text, sheet, col, row }
  const numsByRow = {};    // "sheet!row" → [{ addr, value, col }]

  for (const [addr, val] of Object.entries(gt)) {
    const bang = addr.lastIndexOf('!');
    if (bang < 0) continue;
    const sheet = addr.substring(0, bang);
    const cellPart = addr.substring(bang + 1);
    const match = cellPart.match(/^([A-Z]+)(\d+)$/);
    if (!match) continue;
    const col = match[1];
    const row = parseInt(match[2], 10);
    const rowKey = `${sheet}!${row}`;

    if (typeof val === 'string' && val.length > 2 && val.length < 200) {
      labels.push({ addr, text: val, sheet, col, row, rowKey });
    } else if (typeof val === 'number') {
      if (!numsByRow[rowKey]) numsByRow[rowKey] = [];
      numsByRow[rowKey].push({ addr, value: val, col });
    }
  }

  return { labels, numsByRow };
}

/**
 * Run manifest refinement.
 *
 * @param {string} modelDir - Path to model directory with manifest + ground truth
 * @param {Object} args
 * @returns {Object} Refinement report with proposed patches
 */
export function runManifestRefine(modelDir, args) {
  const manifest = loadManifest(modelDir);
  const gt = loadGroundTruth(manifest, modelDir);

  // Pre-index for fast searching (single pass over GT)
  const index = buildIndex(gt);

  const report = {
    existing: {},     // Fields already mapped
    found: {},        // New fields found and patched
    notFound: [],     // Fields we couldn't find
    ambiguous: {},    // Fields with multiple candidates
    patched: false,
  };

  const lines = [];
  lines.push('Manifest refinement report');
  lines.push('═'.repeat(50));

  // Check which required fields are already mapped
  for (const field of REQUIRED_FIELDS) {
    const current = resolveFieldFromManifest(manifest, field.key);
    if (current) {
      const val = resolveCell(gt, current);
      if (val !== undefined) {
        report.existing[field.label] = { cell: current, value: val };
        lines.push(`  ✓ ${field.label}: ${current} = ${formatVal(val)}`);
        continue;
      }
    }

    // Search for this field using pre-index
    const candidates = searchForFieldIndexed(index, field);

    if (candidates.length === 0) {
      report.notFound.push(field.label);
      lines.push(`  ✗ ${field.label}: not found`);
    } else if (candidates.length === 1) {
      report.found[field.label] = candidates[0];
      lines.push(`  + ${field.label}: ${candidates[0].cell} = ${formatVal(candidates[0].value)} (from "${candidates[0].labelText}")`);
    } else {
      report.ambiguous[field.label] = candidates;
      lines.push(`  ? ${field.label}: ${candidates.length} candidates`);
      for (const c of candidates.slice(0, 3)) {
        lines.push(`      ${c.cell} = ${formatVal(c.value)} (from "${c.labelText}")`);
      }
    }
  }

  // Apply patches if --apply flag
  if (args.apply && Object.keys(report.found).length > 0) {
    const patched = applyPatches(manifest, report.found);
    const manifestPath = findManifestPath(modelDir);
    writeFileSync(manifestPath, JSON.stringify(patched, null, 2));
    report.patched = true;
    lines.push('');
    lines.push(`Manifest patched: ${Object.keys(report.found).length} fields updated`);
    lines.push(`Written to: ${manifestPath}`);
  } else if (Object.keys(report.found).length > 0) {
    lines.push('');
    lines.push(`Run with --apply to patch ${Object.keys(report.found).length} found fields into manifest`);
  }

  // Suggest manual search for not-found fields
  if (report.notFound.length > 0) {
    lines.push('');
    lines.push('Fields not found automatically. Try searching manually:');
    for (const label of report.notFound) {
      const field = REQUIRED_FIELDS.find(f => f.label === label);
      const searchTerm = field.patterns[0].source.split('|')[0].replace(/\\/g, '').replace(/\.\*/g, ' ');
      lines.push(`  node cli/index.mjs query <modelDir> --search "${searchTerm}"`);
    }
  }

  // Summary
  const total = REQUIRED_FIELDS.length;
  const mapped = Object.keys(report.existing).length + Object.keys(report.found).length;
  lines.push('');
  lines.push(`Coverage: ${mapped}/${total} fields mapped (${Object.keys(report.existing).length} existing + ${Object.keys(report.found).length} new)`);

  return { ...report, _formatted: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Search logic
// ---------------------------------------------------------------------------

/**
 * Search for a field using the pre-built index (O(labels) instead of O(gt^2)).
 */
function searchForFieldIndexed(index, field) {
  const candidates = [];

  // Pass 1: Find label matches (scan pre-extracted labels only)
  const labelMatches = [];
  for (const label of index.labels) {
    for (const pattern of field.patterns) {
      if (pattern.test(label.text)) {
        labelMatches.push(label);
        break;
      }
    }
  }

  // Pass 2: For each label, look up same-row numeric values from index
  for (const lm of labelMatches) {
    const rowNums = index.numsByRow[lm.rowKey] || [];

    const inRange = rowNums.filter(n => {
      if (!field.valueRange) return true;
      return n.value >= field.valueRange[0] && n.value <= field.valueRange[1];
    });

    if (inRange.length > 0) {
      // Prefer rightward columns (more likely to be the value)
      inRange.sort((a, b) => colToNum(b.col) - colToNum(a.col));
      const best = inRange[0];
      candidates.push({
        cell: best.addr,
        value: best.value,
        labelAddr: lm.addr,
        labelText: lm.text.trim(),
        sheet: lm.sheet,
      });
    }
  }

  // Deduplicate by cell
  const seen = new Set();
  return candidates.filter(c => {
    if (seen.has(c.cell)) return false;
    seen.add(c.cell);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Patch application
// ---------------------------------------------------------------------------

function applyPatches(manifest, found) {
  const patched = JSON.parse(JSON.stringify(manifest));

  for (const [label, match] of Object.entries(found)) {
    const field = REQUIRED_FIELDS.find(f => f.label === label);
    if (!field) continue;

    setNestedField(patched, field.key, match.cell);

    // Also update baseCaseOutputs
    const shortKey = field.key.split('.').pop().replace(/Cell$/, '');
    if (patched.baseCaseOutputs) {
      patched.baseCaseOutputs[shortKey] = match.value;
    }
  }

  return patched;
}

function setNestedField(obj, path, value) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const nextKey = parts[i + 1];

    if (!current[key]) {
      current[key] = isNaN(nextKey) ? {} : [];
    }

    // Handle array index
    if (Array.isArray(current[key])) {
      const idx = parseInt(nextKey, 10);
      if (!current[key][idx]) current[key][idx] = {};
    }

    current = Array.isArray(current[key]) ? current[key][parseInt(nextKey, 10)] : current[key];
    if (Array.isArray(current)) {
      // Skip the index part since we already navigated into it
      i++;
      if (i >= parts.length - 1) break;
      if (!current[parts[i]]) current[parts[i]] = {};
      current = current[parts[i]];
    }
  }

  current[parts[parts.length - 1]] = value;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveFieldFromManifest(manifest, path) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let current = manifest;
  for (const part of parts) {
    if (!current) return null;
    current = current[part];
  }
  if (typeof current === 'string' && current.includes('!')) return current;
  return null;
}

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

function formatVal(val) {
  if (typeof val === 'number') {
    if (Math.abs(val) >= 1e9) return `$${(val / 1e9).toFixed(1)}B`;
    if (Math.abs(val) >= 1e6) return `$${(val / 1e6).toFixed(1)}M`;
    if (Math.abs(val) >= 1e3) return `$${(val / 1e3).toFixed(0)}K`;
    if (Math.abs(val) < 1 && val !== 0) return `${(val * 100).toFixed(2)}%`;
    return val.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  return String(val);
}

function colToNum(col) {
  let num = 0;
  for (let i = 0; i < col.length; i++) {
    num = num * 26 + (col.charCodeAt(i) - 64);
  }
  return num;
}

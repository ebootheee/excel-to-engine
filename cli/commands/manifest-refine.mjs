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

// Sheet-name hints: labels on these sheets get scored higher during refinement.
// The pattern here is common across PE models — a dedicated summary/comparison
// tab holds the clean, "final" number, while the same label on operational
// tabs may point to a sub-total or per-period figure.
const SUMMARY_SHEET_PATTERN = /^(cheat\s*sheet|uw\s*comparison|summary|valuation|cover|returns|dashboard|exec\s*summary)/i;

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
    // Accept MOIC, MoC, MoIC, MOC. Historical regex only matched `mo[ic]` which
    // excluded `MOC` (no trailing IC). PE models frequently label this as
    // "Gross MOC" or "Gross Multiple".
    label: 'Gross MOIC',
    patterns: [/gross.*mo(i?c|ic)\b|gross.*multiple|mo(i?c|ic).*pre.*promot|multiple.*pre|pre.*promot.*mo(i?c|ic)|tvpi.*pre/i],
    valueRange: [0.5, 20],
    valueHint: 'number 0.5-20 (e.g., 2.85)',
  },
  {
    key: 'equity.classes[0].netMOIC',
    label: 'Net MOIC',
    patterns: [/net.*mo(i?c|ic)\b|net.*multiple|mo(i?c|ic).*post.*promot|multiple.*post|post.*promot.*mo(i?c|ic)|tvpi.*post|lp.*mo(i?c|ic)\b/i],
    valueRange: [0.5, 20],
    valueHint: 'number 0.5-20',
  },
  {
    key: 'equity.classes[0].basisCell',
    // Broadened to catch "Peak Net Equity" and "Fund Size / Peak Net Equity"
    // patterns that appear on Comparison/Summary tabs.
    label: 'Equity Basis / Peak Equity',
    patterns: [/peak.*(net.*)?equity|fund.*size.*(\/|\s)\s*peak|equity.*basis|equity.*invested|total.*equity|committed.*capital|capital.*committed|equity.*drawn|max.*equity.*invested/i],
    valueRange: [1e6, 50e9],   // $1M to $50B
    valueHint: 'large number (equity invested)',
  },
  {
    key: 'carry.totalCell',
    label: 'Total Carry / Promote',
    patterns: [/total.*(carry|carried|promot)|carried.*interest.*total|(carry|carried|promot).*total|gp.*(carry|carried|promot)/i],
    // Reject labels that clearly describe something else. Historically the
    // refiner mapped `carry.totalCell` to `GPP Promote!AF25` = "Total Cash Flows
    // (pre-carry)" — a single-year pre-carry CF, not GP carry. See
    // 3-E2E-test/SESSION_LOG_02_carry.md.
    disqualifyingPatterns: [/pre.?(carry|promot)|cash.?flow|receivable|payable|fee|operating|capital|equity|profit/i],
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

  // Resolve refinement hints: either passed in via args.hints (used by init
  // when a template has been applied), or read from a hand-edited manifest
  // (manifest._refineHints, if present).
  const hints = args?.hints || manifest._refineHints || {};

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
    const candidates = searchForFieldIndexed(index, field, { hints });

    if (candidates.length === 0) {
      report.notFound.push(field.label);
      lines.push(`  ✗ ${field.label}: not found`);
    } else if (candidates.length === 1) {
      report.found[field.label] = candidates[0];
      lines.push(`  + ${field.label}: ${candidates[0].cell} = ${formatVal(candidates[0].value)} (from "${candidates[0].labelText}")`);
    } else {
      // Multiple candidates — always pick the top-ranked one so the CLI has a
      // usable binding, but record the full candidate list as `report.alternates`
      // so downstream users can see what else was in play. The top candidate
      // comes out of the ranking (summary-sheet → hinted col → non-zero →
      // closest to label).
      const best = candidates[0];
      const otherSummary = candidates.slice(1).filter(c => c.onSummarySheet).length;
      const otherNonSummary = candidates.length - 1 - otherSummary;
      report.found[field.label] = best;
      report.alternates = report.alternates || {};
      report.alternates[field.label] = candidates.slice(1, 6);
      const tag = best.onSummarySheet ? ' on summary tab' : '';
      const note = `; ${candidates.length - 1} other candidate(s) available (${otherSummary} summary / ${otherNonSummary} other)`;
      lines.push(`  + ${field.label}: ${best.cell} = ${formatVal(best.value)} (from "${best.labelText}"${tag}${note})`);
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
 *
 * Candidate ranking (most → least preferred):
 *   1. On a summary/comparison sheet (Cheat Sheet / UW Comparison / Summary /
 *      Valuation / ...) — the "final" number usually lives here.
 *   2. Match the template's declared scenario column when `opts.hints` carries
 *      `scenarioColumns[sheet]` or `scenarioColumns.default`.
 *   3. Non-zero value (a zero in a totals column is almost always a restated-
 *      copy cell or an uninitialized sensitivity, not the answer).
 *   4. Closer to the label's own column. Far-right restated copies (e.g. KU
 *      when the real cell is D) lose to the canonical leftmost formula cell.
 *
 * Each preference applies only when it breaks a tie — so single-candidate
 * rows are unaffected and plain sheets still work without templates.
 */
function searchForFieldIndexed(index, field, opts = {}) {
  const hints = opts.hints || {};
  const scenarioColumns = hints.scenarioColumns || {};
  const candidates = [];

  // Pass 1: Find label matches (scan pre-extracted labels only)
  const labelMatches = [];
  for (const label of index.labels) {
    if (field.disqualifyingPatterns) {
      let disq = false;
      for (const p of field.disqualifyingPatterns) {
        if (p.test(label.text)) { disq = true; break; }
      }
      if (disq) continue;
    }
    for (const pattern of field.patterns) {
      if (pattern.test(label.text)) {
        labelMatches.push(label);
        break;
      }
    }
  }

  // Pass 2: For each matching label, select the best same-row numeric cell.
  for (const lm of labelMatches) {
    const rowNums = index.numsByRow[lm.rowKey] || [];
    const labelColNum = colToNum(lm.col);

    const inRange = rowNums.filter(n => {
      if (!field.valueRange) return true;
      return n.value >= field.valueRange[0] && n.value <= field.valueRange[1];
    });
    if (inRange.length === 0) continue;

    // Template-hinted scenario column for this sheet (falls back to default).
    const preferredCols = scenarioColumns[lm.sheet] || scenarioColumns.default || null;
    const hitsHint = preferredCols && preferredCols.length
      ? inRange.filter(n => preferredCols.includes(n.col))
      : [];

    // Prefer non-zero values when we have both zero and non-zero candidates.
    const nonZero = inRange.filter(n => n.value !== 0);
    const pool = hitsHint.length > 0
      ? (hitsHint.some(n => n.value !== 0) ? hitsHint.filter(n => n.value !== 0) : hitsHint)
      : (nonZero.length > 0 ? nonZero : inRange);

    // Rank within the pool: closest to label column wins (ascending distance).
    // Ties broken by ascending column index (leftmost) so restated "copy"
    // cells at the far right can't shadow the canonical formula cell.
    pool.sort((a, b) => {
      const da = Math.abs(colToNum(a.col) - labelColNum);
      const db = Math.abs(colToNum(b.col) - labelColNum);
      if (da !== db) return da - db;
      return colToNum(a.col) - colToNum(b.col);
    });

    const best = pool[0];
    candidates.push({
      cell: best.addr,
      value: best.value,
      labelAddr: lm.addr,
      labelText: lm.text.trim(),
      sheet: lm.sheet,
      onSummarySheet: SUMMARY_SHEET_PATTERN.test(lm.sheet),
      matchedHintCol: preferredCols ? preferredCols.includes(best.col) : null,
    });
  }

  // Deduplicate by cell; then rank with summary-sheet candidates first.
  const seen = new Set();
  const deduped = candidates.filter(c => {
    if (seen.has(c.cell)) return false;
    seen.add(c.cell);
    return true;
  });
  deduped.sort((a, b) => {
    if (a.onSummarySheet && !b.onSummarySheet) return -1;
    if (!a.onSummarySheet && b.onSummarySheet) return 1;
    if (a.matchedHintCol && !b.matchedHintCol) return -1;
    if (!a.matchedHintCol && b.matchedHintCol) return 1;
    return 0;
  });
  return deduped;
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

// The array-aware nested setter. Path syntax uses dot + bracket for indices:
//   "equity.classes[0].grossMOIC"
// → parts ["equity", "classes", "0", "grossMOIC"]; arrays are auto-created when
// the next key is numeric. Works identically to `setNested` in
// cli/commands/manifest.mjs and init.mjs — the previous implementation here
// had a subtle bug that wrote values into a nested "0" sub-object instead of
// the target array element, silently losing every refiner patch.
function setNestedField(obj, path, value) {
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

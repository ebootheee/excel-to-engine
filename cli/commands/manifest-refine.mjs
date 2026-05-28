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
import {
  loadManifest, loadGroundTruth, resolveCell, MANIFEST_VERSION,
  loadLabelIndex, buildLabelIndex,
} from '../../lib/manifest.mjs';

// ---------------------------------------------------------------------------
// Required fields and their search strategies
// ---------------------------------------------------------------------------

// Sheet-name hints: labels on these sheets get scored higher during refinement.
// The pattern here is common across PE models — a dedicated summary/comparison
// tab holds the clean, "final" number, while the same label on operational
// tabs may point to a sub-total or per-period figure.
const SUMMARY_SHEET_PATTERN = /^(cheat\s*sheet|uw\s*comparison|summary|valuation|cover|returns|dashboard|exec\s*summary)/i;

// Rollup sheets aggregate per-class data and are almost always what you want
// when both a rollup sheet and its underlying per-class sheets share a label.
// Example: a PE platform model with 1-A..9-A per-class sheets plus an
// "LP Rollup-A" sheet — the rollup is the authoritative consolidation. A
// "GP Fees - Hold" aggregation sheet plays the same role. Both should
// outrank any single underlying class sheet.
const ROLLUP_SHEET_PATTERN = /\b(roll[-\s]?up|rollup|consolidat|combined|total|aggregate|all\s+class|gp\s+fees)\b/i;

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
    // refiner mapped `carry.totalCell` to a promote-tab cell whose label was
    // "Total Cash Flows (pre-carry)" — a single-year pre-carry CF, not GP
    // carry. See the session logs for context.
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

// Excel's hard column ceiling (XFD = 16384). numericsForRow probes a row's
// columns left-to-right and stops after this many consecutive empty columns —
// generous enough to span any realistic financial layout (and far-right
// restated copies lose to the canonical leftmost cell in ranking anyway), while
// bounding the probe cost on a label-only row to a few hundred hash lookups.
const MAX_PROBE_COL = 16384;
const MAX_PROBE_GAP = 256;

/**
 * Build a search index over the ground truth.
 *
 * Labels come from the Rust parser's pre-built index (`chunked/_labels.json`)
 * when present — an O(labels) read instead of scanning every cell — and fall
 * back to a one-time ground-truth scan (`buildLabelIndex`) for legacy engines
 * that predate the index.
 *
 * Numeric values are resolved **lazily, per matched row**, by direct probing
 * (see `numericsForRow`). The refiner only ever inspects numerics on a label's
 * own row, so the old approach — bucketing every numeric in a multi-million-cell
 * workbook up front — was almost entirely wasted: on a big model the bulk of
 * those cells live in giant *unlabeled* grids (e.g. a PP&E depreciation
 * schedule) the refiner never consults. Skipping that build is the win; the
 * one remaining full pass is the unavoidable JSON parse of the ground truth.
 *
 * @param {Object} gt - Ground truth { addr: value }
 * @param {string} [modelDir] - Model dir, for loading `_labels.json`
 * @returns {{ labels: Array, numericsForRow: (sheet: string, row: number) => Array }}
 */
function buildIndex(gt, modelDir) {
  const labelIndex = (modelDir && loadLabelIndex(modelDir)) || buildLabelIndex(gt);
  const labels = [];
  for (const entries of Object.values(labelIndex)) {
    for (const e of entries) {
      labels.push({
        addr: `${e.sheet}!${e.col}${e.row}`,
        text: e.text,
        sheet: e.sheet,
        col: e.col,
        row: e.row,
        rowKey: `${e.sheet}!${e.row}`,
      });
    }
  }

  const rowCache = new Map();   // "sheet!row" → [{ addr, value, col }]
  function numericsForRow(sheet, row) {
    const key = `${sheet}!${row}`;
    const cached = rowCache.get(key);
    if (cached) return cached;
    const nums = [];
    let gap = 0;
    for (let c = 1; c <= MAX_PROBE_COL && gap < MAX_PROBE_GAP; c++) {
      const col = numToCol(c);
      const addr = `${sheet}!${col}${row}`;
      const v = gt[addr];
      if (typeof v === 'number') {
        nums.push({ addr, value: v, col });
        gap = 0;
      } else {
        gap++;
      }
    }
    rowCache.set(key, nums);
    return nums;
  }

  return { labels, numericsForRow };
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

  // Pre-index for fast searching. Labels come from `_labels.json` when the
  // parser emitted it (no GT scan); numerics are probed lazily per matched row.
  const index = buildIndex(gt, modelDir);

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
    const rowNums = index.numericsForRow(lm.sheet, lm.row);
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
      onRollupSheet: ROLLUP_SHEET_PATTERN.test(lm.sheet),
      matchedHintCol: preferredCols ? preferredCols.includes(best.col) : null,
    });
  }

  // Deduplicate by cell; then rank with summary-sheet candidates first,
  // rollup-sheet candidates next, then hint-matched cols, then by distance.
  // This matters most for multi-class PE models where the same label appears
  // on N per-class sheets plus a rollup — we always want the rollup.
  const seen = new Set();
  const deduped = candidates.filter(c => {
    if (seen.has(c.cell)) return false;
    seen.add(c.cell);
    return true;
  });
  deduped.sort((a, b) => {
    if (a.onSummarySheet && !b.onSummarySheet) return -1;
    if (!a.onSummarySheet && b.onSummarySheet) return 1;
    if (a.onRollupSheet && !b.onRollupSheet) return -1;
    if (!a.onRollupSheet && b.onRollupSheet) return 1;
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
// Reject path segments that would walk into `Object.prototype`. Refiner paths
// can be derived from manifest content; without this guard a malicious manifest
// could pollute the global prototype.
const FORBIDDEN_REFINE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function setNestedField(obj, path, value) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  if (parts.some(p => FORBIDDEN_REFINE_KEYS.has(p))) return;
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
  // Aggregate: { cells: ["Sheet!A1", ...], op: 'sum' } — treat as set so the
  // refiner doesn't stomp on multi-class carry.totalCell bindings that the
  // detector already aggregated across sibling sheets.
  if (current && typeof current === 'object' && Array.isArray(current.cells) && current.cells.length > 0) {
    return current;
  }
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

// Inverse of colToNum: 1 → "A", 26 → "Z", 27 → "AA". Used by numericsForRow to
// reconstruct cell addresses when probing a row's columns.
function numToCol(num) {
  let col = '';
  while (num > 0) {
    const rem = (num - 1) % 26;
    col = String.fromCharCode(65 + rem) + col;
    num = Math.floor((num - 1) / 26);
  }
  return col;
}

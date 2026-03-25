/**
 * generate-questions.mjs — Generate blind eval questions from ground truth + model map
 *
 * Reads the chunked output artifacts and produces test-questions.json:
 * natural-language financial questions that a blind Claude API call
 * should be able to answer using only the JS engine.
 *
 * Usage:
 *   node generate-questions.mjs <chunked-dir> [--count 75] [--output test-questions.json]
 *
 * Algorithm:
 *   1. Load _ground-truth.json and _graph.json
 *   2. Build a label→value map by detecting row labels (text in col A-C)
 *      paired with numeric values in the same row on later columns
 *   3. Categorize questions by difficulty:
 *      - "direct": single named cell (e.g., "What is Revenue on the Assumptions sheet?")
 *      - "lookup": value identified by label + sheet (e.g., "What is Total NOI for LYSARA MASTER UK?")
 *      - "aggregated": cross-sheet or summary values (e.g., "What is the portfolio net IRR?")
 *   4. Randomize and select N questions across categories
 *   5. Write test-questions.json
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

// ── Config ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const chunkedDir = args.find(a => !a.startsWith('--')) || './chunked';
const countIdx = args.indexOf('--count');
const QUESTION_COUNT = countIdx >= 0 ? parseInt(args[countIdx + 1]) : 75;
const outputIdx = args.indexOf('--output');
const OUTPUT_FILE = outputIdx >= 0 ? args[outputIdx + 1] : join(chunkedDir, '..', 'test-questions.json');

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Parse a cell address like "Sheet Name!AB12" into {sheet, col, row} */
function parseAddr(addr) {
  const bang = addr.lastIndexOf('!');
  if (bang < 0) return null;
  const sheet = addr.slice(0, bang);
  const cellPart = addr.slice(bang + 1);
  const match = cellPart.match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;
  return { sheet, col: match[1], row: parseInt(match[2]), addr };
}

/** Column letters to number (A=1, B=2, ..., Z=26, AA=27) */
function colToNum(col) {
  let n = 0;
  for (const ch of col) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}

/** Shuffle array in-place (Fisher-Yates) */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Check if a string looks like a financial label (not a date, not junk) */
function isValidLabel(text) {
  if (!text || typeof text !== 'string') return false;
  if (text.length < 3 || text.length > 60) return false;
  if (text.startsWith('ExcelDateTime')) return false;
  if (/^\d+$/.test(text)) return false;
  if (/^[A-Z]{1,3}\d+$/.test(text)) return false; // cell ref
  return true;
}

/** Classify a label into a financial category */
function categorizeLabel(label) {
  const l = label.toLowerCase();
  if (/revenue|rent|income|noi|nri/.test(l)) return 'revenue';
  if (/expense|cost|opex|capex|g&a|overhead/.test(l)) return 'expense';
  if (/debt|loan|interest|principal|amort/.test(l)) return 'debt';
  if (/irr|moic|roe|return|yield|multiple/.test(l)) return 'returns';
  if (/tax|vat/.test(l)) return 'tax';
  if (/cash|flow|cf|ebitda|ebit/.test(l)) return 'cashflow';
  if (/equity|capital|invest|nav/.test(l)) return 'equity';
  if (/fee|promote|carry|incentive|mip/.test(l)) return 'fees';
  if (/total|sum|aggregate|portfolio/.test(l)) return 'aggregated';
  return 'other';
}

/** Generate a natural-language question for a label+value pair */
function generateQuestion(label, sheet, value, addr, category) {
  const templates = {
    revenue: [
      `What is the ${label} on the ${sheet} sheet?`,
      `What revenue figure does the model show for ${label} in ${sheet}?`,
    ],
    expense: [
      `What is ${label} according to the ${sheet} sheet?`,
      `What does the model calculate for ${label} in ${sheet}?`,
    ],
    debt: [
      `What is ${label} on the ${sheet} sheet?`,
      `What debt figure is shown for ${label} in ${sheet}?`,
    ],
    returns: [
      `What is the ${label} shown on the ${sheet} sheet?`,
      `What return metric does the model compute for ${label} in ${sheet}?`,
    ],
    cashflow: [
      `What is ${label} on the ${sheet} sheet?`,
      `What cash flow figure does the model show for ${label} in ${sheet}?`,
    ],
    tax: [
      `What is ${label} on the ${sheet} sheet?`,
    ],
    equity: [
      `What is ${label} according to ${sheet}?`,
    ],
    fees: [
      `What is ${label} on the ${sheet} sheet?`,
    ],
    aggregated: [
      `What is ${label} according to the ${sheet} sheet?`,
      `What aggregate value does the model show for ${label} in ${sheet}?`,
    ],
    other: [
      `What is the value of ${label} on the ${sheet} sheet?`,
    ],
  };

  const options = templates[category] || templates.other;
  return options[Math.floor(Math.random() * options.length)];
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Loading ground truth from ${chunkedDir}...`);

  const gt = JSON.parse(await readFile(join(chunkedDir, '_ground-truth.json'), 'utf8'));
  const graph = JSON.parse(await readFile(join(chunkedDir, '_graph.json'), 'utf8'));

  const totalEntries = Object.keys(gt).length;
  console.log(`  Ground truth: ${totalEntries} entries`);
  console.log(`  Sheets: ${graph.sheets.length}`);

  // Step 1: Parse all cells into structured form
  const parsed = {};
  for (const [addr, value] of Object.entries(gt)) {
    const p = parseAddr(addr);
    if (p) {
      p.value = value;
      parsed[addr] = p;
    }
  }

  // Step 2: Build label→value map
  // For each sheet, find text cells in early columns (A-D) and pair with
  // numeric values in the same row on later columns
  const candidates = [];
  const sheetRows = {};

  for (const [addr, p] of Object.entries(parsed)) {
    const key = `${p.sheet}!${p.row}`;
    if (!sheetRows[key]) sheetRows[key] = [];
    sheetRows[key].push(p);
  }

  for (const [key, cells] of Object.entries(sheetRows)) {
    // Find labels (text in early columns)
    const labels = cells.filter(c =>
      typeof c.value === 'string' &&
      isValidLabel(c.value) &&
      colToNum(c.col) <= 4 // columns A-D
    );
    // Find numeric values in later columns
    const values = cells.filter(c =>
      typeof c.value === 'number' &&
      c.value !== 0 &&
      colToNum(c.col) > 4
    );

    if (labels.length === 0 || values.length === 0) continue;

    const label = labels[0]; // primary label
    // Pick a non-zero value from the row (prefer middle columns for "representative" year)
    const sortedVals = values.sort((a, b) => colToNum(a.col) - colToNum(b.col));
    const midVal = sortedVals[Math.floor(sortedVals.length / 2)];

    const category = categorizeLabel(label.value);

    candidates.push({
      label: label.value,
      sheet: label.sheet,
      value: midVal.value,
      source_cell: midVal.addr,
      label_cell: label.addr,
      category,
      difficulty: 'lookup',
    });
  }

  console.log(`  Candidate questions: ${candidates.length}`);

  // Step 3: Also add "direct" questions for simple named cells
  // (cells where column A has a label and column B has a value)
  const directCandidates = [];
  for (const [key, cells] of Object.entries(sheetRows)) {
    const colA = cells.find(c => c.col === 'A' && typeof c.value === 'string' && isValidLabel(c.value));
    const colB = cells.find(c => c.col === 'B' && typeof c.value === 'number' && c.value !== 0);
    if (colA && colB) {
      directCandidates.push({
        label: colA.value,
        sheet: colA.sheet,
        value: colB.value,
        source_cell: colB.addr,
        label_cell: colA.addr,
        category: categorizeLabel(colA.value),
        difficulty: 'direct',
      });
    }
  }

  // Step 4: Add "aggregated" questions for summary/total rows
  const aggregatedCandidates = candidates.filter(c =>
    /total|sum|net|portfolio|aggregate|overall|grand/i.test(c.label)
  ).map(c => ({ ...c, difficulty: 'aggregated' }));

  console.log(`  Direct candidates: ${directCandidates.length}`);
  console.log(`  Aggregated candidates: ${aggregatedCandidates.length}`);

  // Step 5: Balance selection across categories and difficulties
  const allCandidates = [...candidates, ...directCandidates];
  shuffle(allCandidates);

  // Ensure mix: ~30% direct, ~20% aggregated, ~50% lookup
  const directCount = Math.floor(QUESTION_COUNT * 0.3);
  const aggCount = Math.floor(QUESTION_COUNT * 0.2);
  const lookupCount = QUESTION_COUNT - directCount - aggCount;

  const selected = [
    ...shuffle(directCandidates).slice(0, directCount),
    ...shuffle(aggregatedCandidates).slice(0, aggCount),
    ...shuffle(candidates.filter(c => c.difficulty === 'lookup')).slice(0, lookupCount),
  ];

  // If we didn't get enough, fill from all candidates
  if (selected.length < QUESTION_COUNT) {
    const remaining = shuffle(allCandidates.filter(c => !selected.includes(c)));
    selected.push(...remaining.slice(0, QUESTION_COUNT - selected.length));
  }

  // Step 6: Generate natural language questions
  const questions = selected.slice(0, QUESTION_COUNT).map((c, i) => ({
    id: `q${String(i + 1).padStart(3, '0')}-${c.category}-${c.difficulty}`,
    question: generateQuestion(c.label, c.sheet, c.value, c.source_cell, c.category),
    expected: c.value,
    source_cell: c.source_cell,
    label_cell: c.label_cell,
    label: c.label,
    sheet: c.sheet,
    category: c.category,
    difficulty: c.difficulty,
  }));

  // Step 7: Write output
  await writeFile(OUTPUT_FILE, JSON.stringify(questions, null, 2));

  // Print summary
  const byCat = {};
  const byDiff = {};
  for (const q of questions) {
    byCat[q.category] = (byCat[q.category] || 0) + 1;
    byDiff[q.difficulty] = (byDiff[q.difficulty] || 0) + 1;
  }

  console.log(`\n  Generated ${questions.length} questions → ${OUTPUT_FILE}`);
  console.log(`  By category: ${JSON.stringify(byCat)}`);
  console.log(`  By difficulty: ${JSON.stringify(byDiff)}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

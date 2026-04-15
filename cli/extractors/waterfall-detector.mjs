/**
 * Waterfall Detector — Identifies carry tier structure from ground truth.
 *
 * Finds carry/promote sheets, detects tier labels, hurdle rates,
 * carry percentages, and maps to manifest carry schema.
 *
 * @license MIT
 */

import { matchFinancialLabel } from '../../lib/manifest.mjs';

/**
 * Detect waterfall / carry structure from ground truth.
 *
 * @param {Object} gt - Ground truth {addr: value}
 * @returns {{ found: boolean, sheets: string[], totalCell: string|null, tiers: Array, waterfall: Object }}
 */
export function detectWaterfall(gt) {
  // Find carry/promote related sheets
  const carrySheets = findCarrySheets(gt);

  if (carrySheets.length === 0) {
    return { found: false, sheets: [], totalCell: null, tiers: [], waterfall: {} };
  }

  // Detect tiers within carry sheets
  const tiers = [];
  let totalCell = null;
  const waterfall = {};

  for (const sheet of carrySheets) {
    const sheetTiers = detectTiers(gt, sheet);
    tiers.push(...sheetTiers.tiers);

    if (sheetTiers.totalCell && !totalCell) {
      totalCell = sheetTiers.totalCell;
    }
    if (sheetTiers.prefReturn !== null && !waterfall.prefReturn) {
      waterfall.prefReturn = sheetTiers.prefReturn;
    }
    if (sheetTiers.carryRate !== null && !waterfall.carryRate) {
      waterfall.carryRate = sheetTiers.carryRate;
    }
  }

  return {
    found: tiers.length > 0 || totalCell !== null,
    sheets: carrySheets,
    totalCell,
    tiers,
    waterfall,
  };
}

/**
 * Find sheets that contain waterfall/carry/promote content.
 */
function findCarrySheets(gt) {
  const sheetScores = {};

  for (const [addr, val] of Object.entries(gt)) {
    if (typeof val !== 'string') continue;
    const bang = addr.lastIndexOf('!');
    if (bang < 0) continue;
    const sheet = addr.substring(0, bang);

    if (!sheetScores[sheet]) sheetScores[sheet] = 0;

    const lower = val.toLowerCase();
    if (/carry|carried interest|promote|gp promote|incentive/i.test(lower)) {
      sheetScores[sheet] += 2;
    }
    if (/waterfall|distribution|preferred return|hurdle/i.test(lower)) {
      sheetScores[sheet] += 1;
    }
    if (/catch.?up|residual|tier|tranche/i.test(lower)) {
      sheetScores[sheet] += 1;
    }
  }

  // Also check sheet names
  const allSheets = new Set();
  for (const addr of Object.keys(gt)) {
    const bang = addr.lastIndexOf('!');
    if (bang > 0) {
      const sheet = addr.substring(0, bang);
      allSheets.add(sheet);
      if (/carry|promote|waterfall|distribution/i.test(sheet)) {
        sheetScores[sheet] = (sheetScores[sheet] || 0) + 5;
      }
    }
  }

  return Object.entries(sheetScores)
    .filter(([, score]) => score >= 3)
    .sort((a, b) => b[1] - a[1])
    .map(([sheet]) => sheet);
}

/**
 * Detect carry tiers within a specific sheet.
 */
function detectTiers(gt, sheet) {
  const rows = [];
  let totalCell = null;
  let prefReturn = null;
  let carryRate = null;

  // Collect all labeled rows in this sheet
  for (const [addr, val] of Object.entries(gt)) {
    if (typeof val !== 'string') continue;
    if (!addr.startsWith(sheet + '!')) continue;

    const cellPart = addr.substring(addr.lastIndexOf('!') + 1);
    const match = cellPart.match(/^([A-Z]+)(\d+)$/);
    if (!match) continue;

    const col = match[1];
    const row = parseInt(match[2], 10);
    const lower = val.toLowerCase();

    // Check for total carry
    if (/total.*(carry|promote)|carried.*interest.*total|gp.*total/i.test(lower)) {
      const numVal = findAdjacentNumber(gt, sheet, row);
      if (numVal) {
        totalCell = numVal.addr;
      }
    }

    // Check for pref return rate
    if (/preferred.*return|pref.*return|hurdle.*rate/i.test(lower)) {
      const numVal = findAdjacentNumber(gt, sheet, row, { range: [0, 0.5] });
      if (numVal) {
        prefReturn = numVal.value;
      }
    }

    // Check for carry rate
    if (/carry.*rate|carry.*%|promote.*%|gp.*split/i.test(lower)) {
      const numVal = findAdjacentNumber(gt, sheet, row, { range: [0, 0.5] });
      if (numVal) {
        carryRate = numVal.value;
      }
    }

    // Check for tier labels
    if (/catch.?up|tier|tranche|residual|split|above.*%|below.*%/i.test(lower)) {
      const numVal = findAdjacentNumber(gt, sheet, row);
      rows.push({
        name: val.trim(),
        row,
        cell: numVal?.addr || null,
        value: numVal?.value || null,
      });
    }
  }

  // Build tier array
  const tiers = rows
    .filter(r => r.cell)
    .map(r => ({
      name: r.name,
      cell: r.cell,
    }));

  return { tiers, totalCell, prefReturn, carryRate };
}

/**
 * Find a numeric value adjacent to a label on the same row.
 */
function findAdjacentNumber(gt, sheet, row, options = {}) {
  const { range } = options;

  for (const [addr, val] of Object.entries(gt)) {
    if (typeof val !== 'number') continue;
    if (!addr.startsWith(sheet + '!')) continue;

    const cellPart = addr.substring(addr.lastIndexOf('!') + 1);
    const match = cellPart.match(/^([A-Z]+)(\d+)$/);
    if (!match || parseInt(match[2], 10) !== row) continue;

    if (range) {
      if (val < range[0] || val > range[1]) continue;
    }

    return { addr, value: val, col: match[1] };
  }

  return null;
}

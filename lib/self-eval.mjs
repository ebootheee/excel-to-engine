/**
 * excel-to-engine — Self-Evaluation Module
 *
 * Compares engine outputs against known Excel values during the
 * build -> eval -> fix loop. Works with ANY engine that follows
 * the standard return structure.
 *
 * @license MIT
 */

// ============================================================================
// NUMBER FORMATTING
// ============================================================================

/**
 * Format a number for display based on its magnitude and context.
 * @param {number} value
 * @param {string} key - Dot-path key to infer format from context
 * @returns {string}
 */
function formatValue(value, key) {
  if (value == null || isNaN(value)) return 'N/A';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';

  const lower = key.toLowerCase();

  // MOIC / multiples
  if (lower.includes('moic') || lower.includes('multiple')) {
    return value.toFixed(2) + 'x';
  }

  // IRR / rates / percentages
  if (lower.includes('irr') || lower.includes('rate') || lower.includes('yield')) {
    return (value * 100).toFixed(1) + '%';
  }

  // Triggered / boolean-like
  if (lower.includes('triggered')) {
    return value ? 'Yes' : 'No';
  }

  // Per-share values (typically smaller numbers)
  if (lower.includes('pershare') || lower.includes('valuepershare') || lower.includes('per_share')) {
    if (Math.abs(value) >= 1_000) {
      return '$' + commify(value, 2);
    }
    return '$' + value.toFixed(2);
  }

  // Large dollar amounts
  if (Math.abs(value) >= 1_000_000_000) {
    return '$' + (value / 1_000_000_000).toFixed(1) + 'B';
  }
  if (Math.abs(value) >= 1_000_000) {
    return '$' + (value / 1_000_000).toFixed(1) + 'M';
  }
  if (Math.abs(value) >= 1_000) {
    return '$' + commify(value, 0);
  }

  // Small numbers
  if (Math.abs(value) < 0.01 && value !== 0) {
    return value.toExponential(2);
  }

  return value.toFixed(2);
}

/**
 * Add commas to a number string.
 */
function commify(n, decimals = 0) {
  const parts = n.toFixed(decimals).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}

// ============================================================================
// NESTED VALUE ACCESS
// ============================================================================

function getNestedValue(obj, path) {
  return path.split('.').reduce((curr, key) => curr?.[key], obj);
}

// ============================================================================
// DEFAULT TOLERANCES
// ============================================================================

const DEFAULT_TOLERANCES = {};

/**
 * Get the default tolerance for a given key based on its type.
 * - IRR: 5% tolerance (volatile, small absolute changes are large relative)
 * - MOIC/multiples: 2%
 * - Dollar amounts: 2%
 * - Booleans: exact match
 */
function getDefaultTolerance(key) {
  const lower = key.toLowerCase();
  if (lower.includes('irr') || lower.includes('rate') || lower.includes('yield')) return 0.05;
  if (lower.includes('moic') || lower.includes('multiple')) return 0.02;
  if (lower.includes('triggered')) return 0; // exact match for booleans
  return 0.02; // 2% for dollar amounts and everything else
}

// ============================================================================
// SELF-EVAL
// ============================================================================

/**
 * Compare engine output against Excel targets.
 *
 * @param {Function} computeModel - The engine's compute function
 * @param {Object} baseCaseInputs - BASE_CASE inputs
 * @param {Object} excelTargets - Known-good values from Excel, keyed by dot-path
 *   e.g., { 'returns.grossMOIC': 2.35, 'waterfall.lpTotal': 500000000 }
 * @param {Object} tolerances - Per-key tolerance overrides (default varies by type)
 * @returns {Object} { score, total, pass, fail, results: [...] }
 */
export function selfEval(computeModel, baseCaseInputs, excelTargets, tolerances = {}) {
  // Run engine at base case
  const output = computeModel(baseCaseInputs);

  const results = [];
  let passCount = 0;
  let failCount = 0;

  for (const [key, excelValue] of Object.entries(excelTargets)) {
    // Skip null/undefined targets (placeholders not yet filled)
    if (excelValue == null) continue;

    const engineValue = getNestedValue(output, key);
    const tolerance = tolerances[key] ?? getDefaultTolerance(key);

    let pass = false;
    let deviation = null;
    let deviationPct = null;

    if (engineValue == null || (typeof engineValue === 'number' && isNaN(engineValue))) {
      // Engine didn't produce this value
      pass = false;
      deviation = null;
      deviationPct = null;
    } else if (typeof excelValue === 'boolean') {
      // Boolean comparison: exact match
      pass = Boolean(engineValue) === excelValue;
      deviation = pass ? 0 : 1;
      deviationPct = pass ? 0 : 100;
    } else if (typeof excelValue === 'number') {
      if (Math.abs(excelValue) < 1e-12) {
        // Excel value is zero — use absolute comparison
        deviation = Math.abs(engineValue);
        deviationPct = deviation > 0 ? 100 : 0;
        pass = deviation < 1e-6;
      } else {
        deviation = Math.abs(engineValue - excelValue);
        deviationPct = Math.abs((engineValue - excelValue) / excelValue) * 100;
        pass = (deviationPct / 100) <= tolerance;
      }
    }

    if (pass) passCount++;
    else failCount++;

    results.push({
      key,
      engineValue,
      excelValue,
      tolerance,
      pass,
      deviation,
      deviationPct,
    });
  }

  const total = passCount + failCount;
  const score = total > 0 ? Math.round((passCount / total) * 100) : 0;

  return { score, total, pass: passCount, fail: failCount, results };
}

// ============================================================================
// COMPARISON TABLE
// ============================================================================

/**
 * Print a formatted comparison table to console.
 * @param {Object} evalResult - Return value from selfEval()
 */
export function printComparisonTable(evalResult) {
  const { results, score, pass, fail, total } = evalResult;

  if (results.length === 0) {
    console.log('\n  No targets to compare. Fill in EXCEL_TARGETS first.\n');
    return;
  }

  // Compute column widths
  const rows = results.map(r => ({
    metric: friendlyName(r.key),
    engine: formatValue(r.engineValue, r.key),
    excel: formatValue(r.excelValue, r.key),
    status: r.pass
      ? '\u2705 Pass'
      : (r.engineValue == null
        ? '\u274C Missing'
        : `\u26A0\uFE0F  ${r.deviationPct != null ? r.deviationPct.toFixed(1) + '%' : '???'}`),
  }));

  const colWidths = {
    metric: Math.max(6, ...rows.map(r => r.metric.length)),
    engine: Math.max(6, ...rows.map(r => r.engine.length)),
    excel:  Math.max(5, ...rows.map(r => r.excel.length)),
    status: Math.max(6, ...rows.map(r => stripAnsi(r.status).length)),
  };

  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - stripAnsi(s).length));
  const line = (l, m, r, fill = '\u2500') => {
    return l
      + fill.repeat(colWidths.metric + 2)
      + m
      + fill.repeat(colWidths.engine + 2)
      + m
      + fill.repeat(colWidths.excel + 2)
      + m
      + fill.repeat(colWidths.status + 2)
      + r;
  };

  console.log('');
  console.log(line('\u250C', '\u252C', '\u2510'));
  console.log(
    '\u2502 ' + pad('Metric', colWidths.metric) + ' '
    + '\u2502 ' + pad('Engine', colWidths.engine) + ' '
    + '\u2502 ' + pad('Excel', colWidths.excel) + ' '
    + '\u2502 ' + pad('Status', colWidths.status) + ' \u2502'
  );
  console.log(line('\u251C', '\u253C', '\u2524'));

  for (const row of rows) {
    console.log(
      '\u2502 ' + pad(row.metric, colWidths.metric) + ' '
      + '\u2502 ' + pad(row.engine, colWidths.engine) + ' '
      + '\u2502 ' + pad(row.excel, colWidths.excel) + ' '
      + '\u2502 ' + pad(row.status, colWidths.status) + ' \u2502'
    );
  }

  console.log(line('\u2514', '\u2534', '\u2518'));
  console.log('');
  console.log(`  Overall: ${pass}/${total} within tolerance (${score}%)`);
  console.log('');
}

/**
 * Convert a dot-path key to a friendly display name.
 */
function friendlyName(key) {
  const nameMap = {
    'returns.grossMOIC':           'Gross MOIC',
    'returns.netMOIC':             'Net MOIC',
    'returns.grossIRR':            'Gross IRR',
    'returns.netIRR':              'Net IRR',
    'exitValuation.grossExitValue': 'Gross Exit Value',
    'exitValuation.netProceeds':   'Net Proceeds',
    'waterfall.lpTotal':           'LP Total',
    'waterfall.gpCarry':           'GP Carry',
    'mip.payment':                 'MIP Payment',
    'mip.triggered':               'MIP Triggered',
    'mip.valuePerShare':           'MIP Per Share',
    'perShare.gross':              'Gross Per Share',
    'perShare.net':                'Net Per Share',
  };

  if (nameMap[key]) return nameMap[key];

  // Auto-generate from dot-path: 'waterfall.tier1LpPortion' -> 'Tier1 LP Portion'
  const last = key.split('.').pop();
  return last
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, s => s.toUpperCase())
    .trim();
}

/**
 * Strip ANSI escape codes and emoji width for padding calculation.
 */
function stripAnsi(s) {
  // Remove ANSI codes
  let clean = s.replace(/\u001b\[[0-9;]*m/g, '');
  // Emoji characters take 2 columns but JS counts them as length 1-2.
  // For simple padding, just return the string — close enough for console output.
  return clean;
}

// ============================================================================
// DIAGNOSE FAILURES
// ============================================================================

/**
 * Diagnose failures and suggest fixes.
 *
 * @param {Array} failures - Failed comparisons from selfEval results
 * @returns {Array} Suggested fixes, ordered by priority
 */
export function diagnoseFailures(failures) {
  const suggestions = [];

  // Group failures by category
  const moicFailures = failures.filter(f => f.key.toLowerCase().includes('moic'));
  const irrFailures = failures.filter(f => f.key.toLowerCase().includes('irr'));
  const waterfallFailures = failures.filter(f => f.key.toLowerCase().includes('waterfall') || f.key.toLowerCase().includes('lpTotal') || f.key.toLowerCase().includes('gpCarry'));
  const mipFailures = failures.filter(f => f.key.toLowerCase().includes('mip'));
  const exitFailures = failures.filter(f => f.key.toLowerCase().includes('exit') || f.key.toLowerCase().includes('proceeds'));
  const perShareFailures = failures.filter(f => f.key.toLowerCase().includes('pershare') || f.key.toLowerCase().includes('per_share'));

  // Check for "everything off by same %" — indicates missing calibration
  const deviations = failures
    .filter(f => f.deviationPct != null && f.deviationPct > 0)
    .map(f => f.deviationPct);

  if (deviations.length >= 3) {
    const avg = deviations.reduce((a, b) => a + b, 0) / deviations.length;
    const spread = Math.max(...deviations) - Math.min(...deviations);
    if (spread < avg * 0.3) {
      suggestions.push({
        priority: 0,
        category: 'calibration',
        message: `All outputs off by ~${avg.toFixed(1)}% (spread ${spread.toFixed(1)}%). Calibration may not be applied.`,
        fix: 'Verify EXCEL_TARGETS are filled with real Excel values and calibration is running at module init.',
      });
    }
  }

  // Exit value / net proceeds issues
  for (const f of exitFailures) {
    if (f.deviationPct != null && f.deviationPct > 10) {
      suggestions.push({
        priority: 1,
        category: 'exit-valuation',
        message: `${friendlyName(f.key)} is ${f.deviationPct.toFixed(1)}% off (engine: ${formatValue(f.engineValue, f.key)}, Excel: ${formatValue(f.excelValue, f.key)}).`,
        fix: 'Re-read the exit valuation from Excel. Check: Gross Exit = sum of segment exits. Net Proceeds = Gross Exit - Transaction Costs - Debt Payoff + Cash. Do NOT use "net debt" — handle debt and cash separately.',
      });
    }
  }

  // Waterfall issues (high priority — cascades to LP/GP/MIP)
  for (const f of waterfallFailures) {
    if (f.deviationPct != null && f.deviationPct > 5) {
      const isLarge = f.deviationPct > 20;
      suggestions.push({
        priority: isLarge ? 1 : 2,
        category: 'waterfall',
        message: `${friendlyName(f.key)} is ${f.deviationPct.toFixed(1)}% off (engine: ${formatValue(f.engineValue, f.key)}, Excel: ${formatValue(f.excelValue, f.key)}).`,
        fix: isLarge
          ? 'Waterfall tiers are likely wrong. Re-read ALL tier parameters from Excel: hurdle rates, LP/GP splits, catch-up ratios. Remember: lpTotal = netProceeds - gpCarry (not sum of tier LP distributions).'
          : 'Waterfall is close but not exact. Check tier boundaries and catch-up provisions. Verify: lpTotal + gpCarry === netProceeds.',
      });
    }
  }

  // MOIC issues
  for (const f of moicFailures) {
    if (f.deviationPct != null && f.deviationPct > 5) {
      suggestions.push({
        priority: 2,
        category: 'returns',
        message: `${friendlyName(f.key)} is ${f.deviationPct.toFixed(1)}% off (engine: ${formatValue(f.engineValue, f.key)}, Excel: ${formatValue(f.excelValue, f.key)}).`,
        fix: 'Re-read equity basis from Excel. MOIC = Net Proceeds / Equity Basis. Check which equity definition the model uses: total commitment, equity deployed, peak equity, or equity at cost.',
      });
    }
  }

  // IRR off but MOIC ok — timing issue
  if (irrFailures.length > 0 && moicFailures.length === 0) {
    for (const f of irrFailures) {
      if (f.deviationPct != null && f.deviationPct > 5) {
        suggestions.push({
          priority: 3,
          category: 'cash-flow-timing',
          message: `${friendlyName(f.key)} is ${f.deviationPct.toFixed(1)}% off but MOIC is correct.`,
          fix: 'Cash flow timing is wrong. IRR depends on WHEN cash flows happen, not just totals. Check: (1) Hold period matches Excel, (2) Interim distributions are included, (3) Cash flows are placed at correct year-end dates.',
        });
      }
    }
  }

  // IRR off AND MOIC off — broader issue
  if (irrFailures.length > 0 && moicFailures.length > 0) {
    for (const f of irrFailures) {
      if (f.deviationPct != null && f.deviationPct > 5) {
        suggestions.push({
          priority: 2,
          category: 'returns',
          message: `${friendlyName(f.key)} is ${f.deviationPct.toFixed(1)}% off (engine: ${formatValue(f.engineValue, f.key)}, Excel: ${formatValue(f.excelValue, f.key)}).`,
          fix: 'Both MOIC and IRR are off. Fix MOIC first (equity basis and net proceeds), then IRR should improve. If MOIC is fixed but IRR is still off, check cash flow timing.',
        });
      }
    }
  }

  // MIP issues
  for (const f of mipFailures) {
    if (f.deviationPct != null && f.deviationPct > 5) {
      suggestions.push({
        priority: 3,
        category: 'mip',
        message: `${friendlyName(f.key)} is ${f.deviationPct.toFixed(1)}% off (engine: ${formatValue(f.engineValue, f.key)}, Excel: ${formatValue(f.excelValue, f.key)}).`,
        fix: 'Check MIP formula: mipPayment = dilutionRate * max(0, lpTotal - mipHurdle * equityBasis). Use lpTotal (not netProceeds) and verify dilutionRate and mipHurdle from Excel.',
      });
    }
  }

  // Per-share issues
  for (const f of perShareFailures) {
    if (f.deviationPct != null && f.deviationPct > 5) {
      suggestions.push({
        priority: 4,
        category: 'per-share',
        message: `${friendlyName(f.key)} is ${f.deviationPct.toFixed(1)}% off (engine: ${formatValue(f.engineValue, f.key)}, Excel: ${formatValue(f.excelValue, f.key)}).`,
        fix: 'Per-share values depend on totalShares = totalCommitment / issuancePrice. Verify issuancePrice and totalCommitment from Excel. Also check that MIP shares are computed correctly.',
      });
    }
  }

  // Check for missing values (engine returned null/undefined)
  const missing = failures.filter(f => f.engineValue == null || (typeof f.engineValue === 'number' && isNaN(f.engineValue)));
  if (missing.length > 0) {
    suggestions.push({
      priority: 0,
      category: 'missing-output',
      message: `${missing.length} output(s) are missing from engine: ${missing.map(f => friendlyName(f.key)).join(', ')}.`,
      fix: 'The engine is not producing these outputs. Check that _computeRaw() returns all required fields in the standard structure (returns, exitValuation, waterfall, mip, perShare).',
    });
  }

  // Check for exit values that don't scale with year
  const exitValueResults = failures.filter(f =>
    f.key.includes('exitValuation') && f.deviationPct != null && f.deviationPct > 30
  );
  if (exitValueResults.length > 0) {
    suggestions.push({
      priority: 1,
      category: 'exit-year-scaling',
      message: `Exit valuation is off by >30%. This often means exit values are not scaling with exit year.`,
      fix: 'Read year-by-year NOI/EBITDA/revenue projections from Excel. Store as lookup arrays (NOI_BY_YEAR) and interpolate for the given exit year. A flat exit value for all years is wrong.',
    });
  }

  // Sort by priority (lowest number = highest priority)
  suggestions.sort((a, b) => a.priority - b.priority);

  return suggestions;
}

// ============================================================================
// INTERACTIVE MENU
// ============================================================================

/**
 * Print the interactive menu for the eval loop.
 *
 * @param {number} score - Current accuracy score (0-100)
 * @param {number} iterationCount - Number of improvement iterations so far
 */
export function printMenu(score, iterationCount) {
  const scoreBar = buildScoreBar(score);

  console.log('\u2500'.repeat(60));
  console.log('');
  console.log(`  Accuracy: ${scoreBar}  ${score}%`);
  if (iterationCount > 0) {
    console.log(`  Iteration: ${iterationCount}`);
  }
  console.log('');
  console.log('  What would you like to do?');
  console.log('');
  console.log('  [1] Run 1 improvement cycle');
  console.log('  [2] Auto-loop until >95% (max 5 iterations)');
  console.log('  [3] Accept current state & lock engine');
  console.log('  [4] Show detailed failure analysis');
  console.log('  [5] Show which Excel cells to re-read');
  console.log('');
  console.log('\u2500'.repeat(60));
}

/**
 * Build a simple ASCII progress bar.
 */
function buildScoreBar(score) {
  const width = 20;
  const filled = Math.round((score / 100) * width);
  const empty = width - filled;
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
  return `[${bar}]`;
}

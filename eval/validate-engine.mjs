#!/usr/bin/env node
/**
 * validate-engine.mjs — Validate a JS engine's declared values against ground truth
 *
 * Checks every value in an engine file that has _sources metadata against the
 * corresponding _ground-truth.json. Catches wrong-sheet, wrong-model, and
 * arithmetic-estimate errors before they ship.
 *
 * The engine file should export objects with this structure:
 *
 *   export const MY_VEHICLE = {
 *     _sources: {
 *       groundTruth: 'path/to/chunked',   // directory containing _ground-truth.json
 *       cells: {
 *         fieldName: 'Sheet!CellRef',      // direct cell lookup
 *         'nested.field': 'Sheet!CellRef', // dot-path into base object
 *       },
 *       aggregates: {                      // optional: multi-cell operations
 *         fieldName: {
 *           cells: ['Sheet!A1', 'Sheet!A2'],
 *           op: 'sum',                     // currently only 'sum' supported
 *         },
 *       },
 *     },
 *     base: {
 *       fieldName: 12345,
 *       nested: { field: 67890 },
 *     },
 *   };
 *
 * Usage:
 *   node validate-engine.mjs <engine-file> [--strict] [--json] [--vehicle <name>]
 *
 * Options:
 *   --strict         Use 0.01% tolerance (default: 0.5%)
 *   --json           Output JSON report instead of human-readable
 *   --vehicle <name> Validate only the named export
 *   --gt-root <dir>  Root directory for ground truth lookups (default: same dir as engine file)
 *
 * Examples:
 *   node validate-engine.mjs ./app/engines.js
 *   node validate-engine.mjs ./app/engines.js --strict --vehicle MY_VEHICLE
 *   node validate-engine.mjs ./my-engine.js --gt-root ./parsed-models/
 *
 * Exit codes:
 *   0 = all validations passed
 *   1 = one or more validations failed
 *   2 = usage error (missing file, bad args)
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve, isAbsolute } from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_TOLERANCE = 0.005;   // 0.5% — covers rounding from display values
const STRICT_TOLERANCE  = 0.0001;  // 0.01%

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flags = {
  strict: args.includes('--strict'),
  json: args.includes('--json'),
  vehicle: null,
  gtRoot: null,
};

// Extract --vehicle <name>
const vIdx = args.indexOf('--vehicle');
if (vIdx !== -1 && args[vIdx + 1]) flags.vehicle = args[vIdx + 1];

// Extract --gt-root <dir>
const gIdx = args.indexOf('--gt-root');
if (gIdx !== -1 && args[gIdx + 1]) flags.gtRoot = args[gIdx + 1];

const enginePath = args.find(a => !a.startsWith('--') && a !== flags.vehicle && a !== flags.gtRoot);

if (!enginePath) {
  console.error('Usage: node validate-engine.mjs <engine-file> [--strict] [--json] [--vehicle <name>] [--gt-root <dir>]');
  console.error('');
  console.error('Validates engine base case values against _ground-truth.json files.');
  console.error('Engine exports must include _sources metadata with cell references.');
  process.exit(2);
}

const tolerance = flags.strict ? STRICT_TOLERANCE : DEFAULT_TOLERANCE;
const engineDir = dirname(resolve(enginePath));
const gtRoot = flags.gtRoot ? resolve(flags.gtRoot) : engineDir;

// ---------------------------------------------------------------------------
// Parse engine file (extract exported objects with _sources)
// ---------------------------------------------------------------------------

function parseEngineFile(filePath) {
  const src = readFileSync(filePath, 'utf-8');
  const vehicles = [];
  const exportRegex = /export\s+const\s+(\w+)\s*=\s*\{/g;
  let match;

  while ((match = exportRegex.exec(src)) !== null) {
    const name = match[1];
    const startIdx = match.index + match[0].length - 1;

    // Find matching closing brace
    let depth = 0, endIdx = startIdx;
    for (let i = startIdx; i < src.length; i++) {
      if (src[i] === '{') depth++;
      if (src[i] === '}') depth--;
      if (depth === 0) { endIdx = i + 1; break; }
    }

    const block = src.slice(startIdx, endIdx);

    // Strip compute() methods that reference imports
    const stripped = block.replace(/compute\s*\([^)]*\)\s*\{[\s\S]*?\n  \},?/g, '');

    try {
      const obj = new Function(`return (${stripped})`)();
      if (obj._sources) {
        vehicles.push({ name, obj });
      }
    } catch {
      // Skip objects that can't be eval'd (arrays, functions, etc.)
    }
  }

  return vehicles;
}

// ---------------------------------------------------------------------------
// Load ground truth
// ---------------------------------------------------------------------------

function loadGroundTruth(gtId) {
  // Try multiple locations
  const candidates = [
    join(gtRoot, gtId, 'chunked', '_ground-truth.json'),
    join(gtRoot, gtId, '_ground-truth.json'),
    join(gtRoot, '_ground-truth.json'),  // single-model case
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, 'utf-8'));
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolve dotted path (e.g. "tiers.catchUp") against an object
// ---------------------------------------------------------------------------

function getNestedValue(obj, path) {
  return path.split('.').reduce((o, k) => (o != null ? o[k] : undefined), obj);
}

// ---------------------------------------------------------------------------
// Validate one vehicle
// ---------------------------------------------------------------------------

function validateVehicle(name, vehicle) {
  const src = vehicle._sources;
  if (!src || !src.groundTruth) {
    return { name, status: 'skip', reason: 'No _sources.groundTruth' };
  }

  const gt = loadGroundTruth(src.groundTruth);
  if (!gt) {
    return { name, status: 'error', reason: `Ground truth not found for "${src.groundTruth}"` };
  }

  const checks = [];

  // Direct cell lookups
  if (src.cells) {
    for (const [field, cellRef] of Object.entries(src.cells)) {
      const engineVal = getNestedValue(vehicle.base, field);
      const gtVal = gt[cellRef];

      if (gtVal === undefined || gtVal === null) {
        checks.push({ field, cellRef, status: 'missing', engineVal, gtVal: null });
        continue;
      }
      if (typeof gtVal === 'string') {
        checks.push({ field, cellRef, status: 'label', engineVal, gtVal });
        continue;
      }

      compareValues(checks, field, cellRef, engineVal, gtVal);
    }
  }

  // Aggregates (sums, etc.)
  if (src.aggregates) {
    for (const [field, agg] of Object.entries(src.aggregates)) {
      const engineVal = getNestedValue(vehicle.base, field);
      let gtSum = 0, allFound = true;

      for (const cellRef of agg.cells) {
        const v = gt[cellRef];
        if (v === undefined || v === null || typeof v === 'string') {
          allFound = false;
          break;
        }
        // Use absolute values — models may show outflows as negative
        gtSum += agg.op === 'sum' ? Math.abs(v) : v;
      }

      if (!allFound) {
        checks.push({ field, cellRef: `SUM(${agg.cells.length} cells)`, status: 'missing', engineVal, gtVal: null });
        continue;
      }

      compareValues(checks, field, `SUM(${agg.cells.length} cells)`, engineVal, gtSum);
    }
  }

  const failures = checks.filter(c => c.status === 'FAIL');
  const missing = checks.filter(c => c.status === 'missing' || c.status === 'label');
  const passed = checks.filter(c => c.status === 'pass');

  return {
    name,
    status: failures.length > 0 ? 'FAIL' : missing.length > 0 ? 'warn' : 'pass',
    passed: passed.length,
    failed: failures.length,
    missing: missing.length,
    checks,
  };
}

function compareValues(checks, field, cellRef, engineVal, gtVal) {
  const absGT = Math.abs(gtVal);
  const absEngine = Math.abs(engineVal);
  const diff = Math.abs(absEngine - absGT);
  const pctDiff = absGT > 0 ? diff / absGT : (absEngine > 0 ? 1 : 0);

  if (pctDiff > tolerance) {
    checks.push({ field, cellRef, status: 'FAIL', engineVal, gtVal: absGT, pctDiff });
  } else {
    checks.push({ field, cellRef, status: 'pass', engineVal, gtVal: absGT, pctDiff });
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function fmtNum(v) {
  if (v == null) return 'null';
  if (typeof v === 'string') return `"${v}"`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) < 1) return v.toFixed(4);
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function printHumanReport(results) {
  console.log('');
  console.log('═'.repeat(60));
  console.log('  Engine Validation Report');
  console.log('═'.repeat(60));
  console.log(`  Tolerance: ${(tolerance * 100).toFixed(2)}%${flags.strict ? ' (strict)' : ''}`);
  console.log('');

  for (const r of results) {
    const icon = r.status === 'pass' ? '✅' : r.status === 'FAIL' ? '❌' : r.status === 'warn' ? '⚠️' : '⏭️';
    console.log(`  ${icon} ${r.name}`);

    if (r.reason) {
      console.log(`     ${r.reason}`);
    } else {
      console.log(`     ${r.passed} pass, ${r.failed} fail, ${r.missing} missing`);
      for (const c of (r.checks || [])) {
        if (c.status === 'FAIL') {
          console.log(`     ❌ ${c.field}: engine=${fmtNum(c.engineVal)} gt=${fmtNum(c.gtVal)} (${(c.pctDiff * 100).toFixed(2)}% off) [${c.cellRef}]`);
        } else if (c.status === 'missing') {
          console.log(`     ⚠️  ${c.field}: cell not found [${c.cellRef}]`);
        } else if (c.status === 'label') {
          console.log(`     ⚠️  ${c.field}: cell contains label "${c.gtVal}" [${c.cellRef}]`);
        }
      }
    }
    console.log('');
  }

  const totalFail = results.filter(r => r.status === 'FAIL').length;
  console.log('─'.repeat(60));
  if (totalFail > 0) {
    console.log(`  🚨 ${totalFail} vehicle(s) FAILED validation. Fix before deploying.`);
  } else {
    console.log(`  ✅ All ${results.length} vehicle(s) validated. Safe to deploy.`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (!existsSync(enginePath)) {
  console.error(`File not found: ${enginePath}`);
  process.exit(2);
}

const vehicles = parseEngineFile(enginePath);

if (vehicles.length === 0) {
  console.error('No exports with _sources metadata found in the engine file.');
  console.error('');
  console.error('Ensure your exports include _sources: { groundTruth, cells }.');
  console.error('See README.md for the expected format.');
  process.exit(2);
}

const filtered = flags.vehicle
  ? vehicles.filter(v => v.name === flags.vehicle)
  : vehicles;

if (filtered.length === 0) {
  console.error(`Vehicle "${flags.vehicle}" not found. Available: ${vehicles.map(v => v.name).join(', ')}`);
  process.exit(2);
}

const results = filtered.map(v => validateVehicle(v.name, v.obj));

if (flags.json) {
  console.log(JSON.stringify({ tolerance, results }, null, 2));
} else {
  if (flags.strict) console.log(`Using strict tolerance: ${STRICT_TOLERANCE * 100}%`);
  printHumanReport(results);
}

const anyFail = results.some(r => r.status === 'FAIL');
process.exit(anyFail ? 1 : 0);

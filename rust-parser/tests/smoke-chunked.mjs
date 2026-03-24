#!/usr/bin/env node
/**
 * Smoke test for chunked engine output.
 *
 * Imports the generated engine.js, calls run(), and compares outputs
 * against _ground-truth.json. Reports PASS/FAIL per KPI.
 *
 * Usage:
 *   node tests/smoke-chunked.mjs [chunked_dir]
 *
 * Default chunked_dir: tests/output/chunked
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const chunkedDir = process.argv[2] || join(__dir, 'output', 'chunked');

// Load ground truth
const gtPath = join(chunkedDir, '_ground-truth.json');
const groundTruth = JSON.parse(readFileSync(gtPath, 'utf-8'));

// Dynamically import the generated engine
const engineUrl = pathToFileURL(join(chunkedDir, 'engine.js')).href;
const engine = await import(engineUrl);

// Run the model
const result = engine.run();

// Compare
const tolerance = 1e-6;
let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

for (const [addr, expected] of Object.entries(groundTruth)) {
  const actual = result.values[addr];

  if (typeof expected === 'string') {
    if (actual === expected) {
      passed++;
    } else {
      failed++;
      failures.push({ addr, expected, actual, type: 'string' });
    }
  } else if (typeof expected === 'number') {
    if (typeof actual !== 'number' || isNaN(actual)) {
      // Check if actual is close enough via coercion
      const numActual = Number(actual);
      if (!isNaN(numActual) && Math.abs(numActual - expected) < tolerance * Math.max(1, Math.abs(expected))) {
        passed++;
      } else {
        failed++;
        failures.push({ addr, expected, actual, type: 'number' });
      }
    } else if (Math.abs(actual - expected) < tolerance * Math.max(1, Math.abs(expected))) {
      passed++;
    } else {
      failed++;
      failures.push({ addr, expected, actual, type: 'number', diff: Math.abs(actual - expected) });
    }
  } else if (typeof expected === 'boolean') {
    if (actual === expected) {
      passed++;
    } else {
      failed++;
      failures.push({ addr, expected, actual, type: 'boolean' });
    }
  } else {
    skipped++;
  }
}

console.log(`\n=== Chunked Engine Smoke Test ===`);
console.log(`Ground truth entries: ${Object.keys(groundTruth).length}`);
console.log(`Passed:  ${passed}`);
console.log(`Failed:  ${failed}`);
console.log(`Skipped: ${skipped}`);

if (failures.length > 0) {
  console.log(`\nFailures:`);
  for (const f of failures) {
    console.log(`  ${f.addr}: expected=${JSON.stringify(f.expected)}, actual=${JSON.stringify(f.actual)}${f.diff ? ` (diff=${f.diff.toExponential(2)})` : ''}`);
  }
}

const total = passed + failed;
const pct = total > 0 ? ((passed / total) * 100).toFixed(1) : '0.0';
console.log(`\nAccuracy: ${pct}% (${passed}/${total})`);

if (failed === 0) {
  console.log(`\n✅ SMOKE TEST PASSED`);
  process.exit(0);
} else {
  console.log(`\n❌ SMOKE TEST FAILED`);
  process.exit(1);
}

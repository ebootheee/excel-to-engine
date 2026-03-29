#!/usr/bin/env node
/**
 * Environment check for excel-to-engine.
 * Verifies all prerequisites are in place before running the pipeline.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');

let allGood = true;

function check(label, ok, fixMsg) {
  if (ok) {
    console.log(`  OK  ${label}`);
  } else {
    console.log(`  FAIL  ${label}`);
    if (fixMsg) console.log(`        Fix: ${fixMsg}`);
    allGood = false;
  }
}

console.log('\nexcel-to-engine environment check\n');

// 1. Node.js version >= 18
const nodeVersion = process.versions.node;
const nodeMajor = parseInt(nodeVersion.split('.')[0], 10);
check(
  `Node.js >= 18 (found ${nodeVersion})`,
  nodeMajor >= 18,
  'Install Node.js 18+ from https://nodejs.org/'
);

// 2. cargo available
let cargoVersion = null;
try {
  cargoVersion = execSync('which cargo', { encoding: 'utf-8' }).trim();
} catch {}
check(
  `cargo available${cargoVersion ? ` (${cargoVersion})` : ''}`,
  !!cargoVersion,
  'Install Rust: curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh'
);

// 3. eval/node_modules exists
const evalModules = existsSync(join(root, 'eval', 'node_modules'));
check(
  'eval/node_modules installed',
  evalModules,
  'Run: cd eval && npm install'
);

// 4. ANTHROPIC_API_KEY set
const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
check(
  'ANTHROPIC_API_KEY set',
  hasApiKey,
  'Export your API key: export ANTHROPIC_API_KEY=sk-ant-...'
);

// 5. Rust parser binary built
const parserPaths = [
  join(root, 'pipelines', 'rust', 'target', 'release', 'rust-parser'),
  join(root, 'pipelines', 'rust', 'target', 'debug', 'rust-parser'),
];
const parserExists = parserPaths.some(p => existsSync(p));
const whichPath = parserPaths.find(p => existsSync(p));
check(
  `Rust parser binary built${whichPath ? ` (${whichPath.includes('release') ? 'release' : 'debug'})` : ''}`,
  parserExists,
  'Build: cd pipelines/rust && cargo build --release'
);

console.log('');
if (allGood) {
  console.log('All checks passed. Ready to run.\n');
} else {
  console.log('Some checks failed. See fix instructions above.\n');
  process.exit(1);
}

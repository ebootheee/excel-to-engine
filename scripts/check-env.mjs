#!/usr/bin/env node
/**
 * Environment check for excel-to-engine.
 *
 * Audience: the AI coding agent setting this up on an analyst's behalf (and the
 * occasional human). Distinguishes what's REQUIRED to convert a model from
 * what's OPTIONAL (only the blind-eval harness needs an API key). Cross-platform
 * (Windows/macOS/Linux). Prints the exact next-step command for anything missing.
 */
import { execSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');
const isWin = process.platform === 'win32';
const exe = isWin ? '.exe' : '';

let requiredOk = true;

function line(status, label, hint) {
  const tag = status === 'ok' ? ' OK ' : status === 'warn' ? 'WARN' : 'MISS';
  console.log(`  [${tag}] ${label}`);
  if (status !== 'ok' && hint) console.log(`         ${hint}`);
}
function have(cmd) {
  // Resolve a binary cross-platform without relying on `which` (absent on Win).
  const probe = isWin ? spawnSync('where', [cmd], { encoding: 'utf-8' })
                      : spawnSync('command', ['-v', cmd], { encoding: 'utf-8', shell: true });
  if (probe.status === 0 && (probe.stdout || '').trim()) return (probe.stdout || '').trim().split(/\r?\n/)[0];
  // Fallback: try `<cmd> --version`
  try { execSync(`${cmd} --version`, { stdio: 'ignore' }); return cmd; } catch { return null; }
}

console.log('\nexcel-to-engine environment check\n');
console.log('REQUIRED — to convert a model and produce an engine:');

// 1. Node >= 18
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor >= 18) line('ok', `Node.js ${process.versions.node}`);
else { requiredOk = false; line('miss', `Node.js ${process.versions.node} (need >= 18)`, 'Install from https://nodejs.org/'); }

// 2. The Rust parser binary — the only thing `ete init` actually shells out to.
const parserPaths = [
  join(root, 'pipelines', 'rust', 'target', 'release', `rust-parser${exe}`),
  join(root, 'pipelines', 'rust', 'target', 'debug', `rust-parser${exe}`),
];
const parserBin = parserPaths.find(existsSync);
const cargo = have('cargo');
if (parserBin) {
  line('ok', `Rust parser built (${parserBin.includes('release') ? 'release' : 'debug'})`);
} else if (cargo) {
  requiredOk = false;
  line('miss', 'Rust parser not built (but cargo is available)', 'Build it:  npm run build:parser');
} else {
  requiredOk = false;
  line('miss', 'Rust parser not built and Rust (cargo) not found',
    isWin ? 'Install Rust from https://rustup.rs/ (or `winget install Rustlang.Rustup`), then: npm run build:parser'
          : "Install Rust:  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   then: npm run build:parser");
}

// 3. xlsx dependency present (node_modules)
const xlsxOk = existsSync(join(root, 'node_modules', 'xlsx'));
if (xlsxOk) line('ok', 'npm dependencies installed (xlsx)');
else { requiredOk = false; line('miss', 'npm dependencies not installed', 'Run:  npm install'); }

console.log('\nOPTIONAL — only for the blind-eval accuracy harness (eval/):');

// 4. eval deps
line(existsSync(join(root, 'eval', 'node_modules')) ? 'ok' : 'warn', 'eval/node_modules installed',
  'Only needed for `node eval/...`. Run: cd eval && npm install');

// 5. API key
line(process.env.ANTHROPIC_API_KEY ? 'ok' : 'warn', 'ANTHROPIC_API_KEY set',
  'Only needed for blind eval. You do NOT need this to convert models or build an app.');

console.log('');
if (requiredOk) {
  console.log('Ready to convert a model:  node cli/index.mjs init <your-model>.xlsx --output ./my-model/\n');
} else {
  console.log('Some REQUIRED items are missing — see the next-step commands above.\n');
  process.exit(1);
}

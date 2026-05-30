/**
 * run-prep.mjs — deterministic prep for the persona benchmark.
 *
 * For every persona in personas.json:
 *   1. generate the synthetic .xlsx (its committed generator)
 *   2. `ete init` -> chunked/ engine + contract
 *   3. `ete verify` -> base-case drift (must be 0)
 *   4. capture the conversion into the training dataset (tools/capture-dataset.mjs)
 *
 * This is the non-LLM half of a benchmark round: it builds the artifacts the
 * journey-simulation workflow then judges. Emits tests/personas/prep-report.json.
 *
 * Usage: node tests/personas/run-prep.mjs [--only slug,slug] [--no-capture]
 *
 * @license MIT
 */
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { captureConversion } from '../../tools/capture-dataset.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const CLI = join(REPO, 'cli', 'index.mjs');
const DATASET = join(REPO, 'dataset');

const argv = process.argv.slice(2);
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx >= 0 ? new Set(argv[onlyIdx + 1].split(',')) : null;
const capture = !argv.includes('--no-capture');

const personas = JSON.parse(readFileSync(join(HERE, 'personas.json'), 'utf8')).personas;

function run(args) {
  return execFileSync('node', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function parseDrift(verifyOut) {
  const num = (re) => { const m = verifyOut.match(re); return m ? parseInt(m[1], 10) : null; };
  return {
    outputs: num(/Outputs checked:\s*(\d+)/),
    matched: num(/Match base case:\s*(\d+)/),
    drifted: num(/Drifted:\s*(\d+)/),
  };
}

const results = [];
for (const p of personas) {
  if (only && !only.has(p.slug)) continue;
  const modelDir = join(REPO, 'engines', '_personas', p.slug);
  const xlsx = join(modelDir, 'model.xlsx');
  const r = { slug: p.slug, assetClass: p.assetClass, generated: false, initOk: false, drift: null, captured: false, error: null };
  try {
    mkdirSync(modelDir, { recursive: true });
    const gen = await import(pathToFileURL(join(HERE, 'generators', `${p.slug}.mjs`)).href);
    if (typeof gen.build !== 'function') throw new Error('generator has no build(outPath) export');
    gen.build(xlsx);
    r.generated = true;

    run([CLI, 'init', xlsx, '--output', modelDir]);
    r.initOk = true;

    const verifyOut = run([CLI, 'verify', modelDir]);
    r.drift = parseDrift(verifyOut);

    if (capture) {
      captureConversion({ modelDir, slug: p.slug, persona: p, drift: r.drift, datasetRoot: DATASET });
      r.captured = true;
    }
  } catch (e) {
    r.error = (e.stderr || e.message || String(e)).toString().split('\n').slice(0, 6).join('\n');
  }
  const ok = r.drift && r.drift.drifted === 0;
  console.log(`${ok ? '✓' : '✗'} ${p.slug.padEnd(28)} ${r.drift ? `drift ${r.drift.drifted}/${r.drift.outputs}` : 'FAILED'}${r.error ? '  ' + r.error.split('\n')[0] : ''}`);
  results.push(r);
}

const summary = {
  ranAt: new Date().toISOString(),
  total: results.length,
  cleanConversions: results.filter(r => r.drift && r.drift.drifted === 0).length,
  failed: results.filter(r => !r.drift || r.drift.drifted !== 0).map(r => r.slug),
  results,
};
mkdirSync(HERE, { recursive: true });
writeFileSync(join(HERE, 'prep-report.json'), JSON.stringify(summary, null, 2));
console.log(`\n${summary.cleanConversions}/${summary.total} clean conversions. Report: tests/personas/prep-report.json`);
if (capture) console.log(`Dataset: ${DATASET} (index.jsonl)`);

/**
 * test-onboarding.mjs — locks in the analyst-onboarding / coding-agent-handoff
 * wave: detector accuracy fixes + the integration bundle emitted by `ete init`
 * + engine base-case fidelity.
 *
 * Builds a small but complete, formula+value-consistent synthetic model with
 * the ModelBuilder, runs the real `ete init` (Rust parser), and asserts the
 * things a non-technical analyst and their coding agent actually rely on.
 *
 * @license MIT
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { ModelBuilder, growth } from '../personas/lib/model-builder.mjs';
import { verifyEngine } from '../../lib/verify-engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const CLI = join(ROOT, 'cli', 'index.mjs');
const OUT = join(ROOT, 'engines', '_test_onboarding');
const XLSX_PATH = join(OUT, 'mini.xlsx');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function buildMini(path) {
  const m = new ModelBuilder('Mini Buyout', 'pe_buyout');
  const years = [2024, 2025, 2026, 2027, 2028];
  const nY = years.length, exitIdx = nY - 1;
  const entryMult = 9, exitMult = 13, g = 0.10;

  const a = m.sheet('Assumptions');
  a.label('A1', 'Assumptions');
  a.label('A3', 'Entry Multiple'); a.value('B3', entryMult);
  a.label('A4', 'Exit Multiple');  a.value('B4', exitMult);
  a.label('A5', 'Revenue Growth'); a.value('B5', g);
  a.label('A6', 'GP Carried Interest'); a.value('B6', 0.20); // the RATE trap
  m.defineName('ExitMultiple', 'Assumptions', 'B4');
  m.defineName('RevenueGrowth', 'Assumptions', 'B5');

  const rev = growth(80_000_000, g, nY);
  const ebitda = rev.map(v => v * 0.25);
  const p = m.sheet('Summary');
  p.label('A1', 'Returns');
  p.label('A2', 'Year'); p.valueRow('B2', years);
  p.label('A3', 'Revenue'); p.value('B3', rev[0]);
  p.formulaRow('C3', rev.slice(1), (i, colL, row) => `${prevColSameRow(colL)}3*(1+Assumptions!$B$5)`);
  p.label('A4', 'EBITDA');
  p.formulaRow('B4', ebitda, (i, colL) => `${colL}3*0.25`);

  const entryEbitda = ebitda[0], exitEbitda = ebitda[exitIdx];
  const entryEquity = entryEbitda * entryMult;     // unlevered for simplicity
  const exitEquity = exitEbitda * exitMult;
  const moic = exitEquity / entryEquity;
  const hold = years[exitIdx] - years[0];
  const irr = Math.pow(moic, 1 / hold) - 1;
  const carry = (exitEquity - entryEquity) * 0.20;

  const s = m.sheet('IC Summary');
  s.label('A1', 'IC Summary');
  s.label('A3', 'Entry Equity'); s.formula('B3', `Summary!B4*Assumptions!$B$3`, entryEquity);
  s.label('A4', 'Exit Equity');  s.formula('B4', `Summary!${col(2 + exitIdx)}4*Assumptions!$B$4`, exitEquity);
  s.label('A5', 'Gross MOIC');   s.formula('B5', `B4/B3`, moic);
  s.label('A6', 'Gross IRR');    s.formula('B6', `(B4/B3)^(1/${hold})-1`, irr);
  s.label('A7', 'GP Carried Interest'); s.formula('B7', `(B4-B3)*Assumptions!$B$6`, carry);

  m.write(path);
  return { exitMult, carry, periodicity: 'annual' };
}
function col(i) { let s = ''; while (i > 0) { i--; s = String.fromCharCode(65 + (i % 26)) + s; i = Math.floor(i / 26); } return s; }
function prevColSameRow(colL) { return col(colL.charCodeAt(0) - 64 - 1); }

console.log('\nOnboarding / handoff suite\n');

try { rmSync(OUT, { recursive: true, force: true }); } catch {}
const expected = buildMini(XLSX_PATH);

const res = spawnSync('node', [CLI, 'init', XLSX_PATH, '--output', OUT, '--quiet'], { encoding: 'utf-8', timeout: 120000 });
ok('ete init exits 0', res.status === 0, (res.stderr || '').slice(0, 200));

const chunked = join(OUT, 'chunked');
const manifest = JSON.parse(readFileSync(join(chunked, 'manifest.json'), 'utf-8'));

// --- Detector accuracy fixes ---
ok('periodicity is annual (not monthly)', manifest.timeline?.periodicity === 'annual',
  `got ${manifest.timeline?.periodicity}`);

const exitMultVal = manifest.baseCaseOutputs?.exitMultiple;
ok('exit multiple = 13 (exit, not entry 9)', exitMultVal === expected.exitMult, `got ${exitMultVal}`);

const totalCarry = manifest.baseCaseOutputs?.totalCarry;
ok('carry total is a dollar amount (not the 0.20 rate)', typeof totalCarry === 'number' && totalCarry > 1e6,
  `got ${totalCarry}`);

// --- Integration bundle ---
ok('INTEGRATION.md emitted', existsSync(join(chunked, 'INTEGRATION.md')));
ok('example.mjs emitted', existsSync(join(chunked, 'example.mjs')));
if (existsSync(join(chunked, 'INTEGRATION.md'))) {
  const ig = readFileSync(join(chunked, 'INTEGRATION.md'), 'utf-8');
  ok('INTEGRATION.md documents run() API', /import \{ run \}/.test(ig) && /run\(/.test(ig));
  ok('INTEGRATION.md lists named outputs with cells', /grossMOIC|grossIRR|terminalValue|exitMultiple/.test(ig));
}

// --- example.mjs actually runs ---
const exRes = spawnSync('node', [join(chunked, 'example.mjs')], { encoding: 'utf-8', timeout: 60000 });
ok('node example.mjs runs cleanly', exRes.status === 0, (exRes.stderr || '').slice(0, 200));
ok('example.mjs reports base case matches', /match baseCaseValue/.test(exRes.stdout || ''));

// --- engine reproduces base case (fidelity) ---
const v = await verifyEngine(chunked);
ok('engine.run() reproduces base case (no drift)', v.ok, v.drifted?.map(d => d.name).join(','));

try { rmSync(OUT, { recursive: true, force: true }); } catch {}

console.log(`\nResults: ${pass} passed, ${fail} failed, ${pass + fail} total\n`);
process.exit(fail === 0 ? 0 : 1);

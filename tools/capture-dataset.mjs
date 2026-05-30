/**
 * capture-dataset.mjs — snapshot a converted model as a clean training triple.
 *
 * WHY: every excel-to-engine conversion already produces a *verified* mapping
 * from a spreadsheet to a deterministic engine. Captured systematically, those
 * become supervised fine-tuning examples for a future "spreadsheet -> mapping"
 * model — the durable asset (the model is a commodity; the verified dataset is
 * the moat). This util makes capture a cheap side-effect of any conversion.
 *
 * WHAT a captured example contains (under <datasetRoot>/<slug>/):
 *   - input.xlsx            the source workbook (the model the analyst had)
 *   - surface.json          a compact, model-agnostic view of the workbook:
 *                           per sheet, every non-empty cell {addr,label?,formula?,value}
 *                           + the defined names. This is the SFT *input*.
 *   - target/               the verified conversion output (the SFT *target*):
 *                           manifest.json (concept->cell mapping — the hard part),
 *                           named-inputs.json, named-outputs.json, cell-types.json
 *   - engine/               (optional) engine.js + sheets/ — the executable target
 *   - meta.json             provenance: persona, drift verdict, headline metrics,
 *                           capture timestamp, file inventory, engine convergence
 * A single line is appended to <datasetRoot>/index.jsonl per capture.
 *
 * The pair the dataset teaches: surface.json (workbook) -> target/manifest.json
 * (the cell mapping). engine/ is kept for end-to-end / execution-grounded eval.
 *
 * Usage (library):
 *   import { captureConversion } from './tools/capture-dataset.mjs';
 *   captureConversion({ modelDir, slug, persona, drift, datasetRoot });
 *
 * Usage (CLI):
 *   node tools/capture-dataset.mjs <modelDir> <slug> [--dataset dataset/] [--no-engine]
 *   # modelDir holds model.xlsx + chunked/ ; persona metadata is read from
 *   # tests/personas/personas.json by <slug> when present.
 *
 * @license MIT
 */
import {
  readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, appendFileSync, readdirSync,
} from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

/** Read a JSON file, or return `fallback` if missing/unreadable. */
function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

/**
 * Build a compact, model-agnostic "surface" of a converted workbook from the
 * chunked artifacts (no SheetJS needed): cell address -> {label, formula, value}.
 * - values come from _ground-truth.json (authoritative cached values)
 * - labels come from _labels.json when present
 * - formulas are recovered from the per-sheet engine modules' _sources block
 *   if available; otherwise omitted (value-only surface still trains mapping).
 */
function buildSurface(chunkedDir) {
  const gt = readJson(join(chunkedDir, '_ground-truth.json'), {}) || {};
  const labels = readJson(join(chunkedDir, '_labels.json'), {}) || {};
  const namedInputs = readJson(join(chunkedDir, 'named-inputs.json'), {}) || {};
  const namedOutputs = readJson(join(chunkedDir, 'named-outputs.json'), {}) || {};

  // gt is { "Sheet!A1": value, ... }. Group by sheet, keep label if known.
  const sheets = {};
  for (const [ref, value] of Object.entries(gt)) {
    const bang = ref.lastIndexOf('!');
    if (bang < 0) continue;
    const sheet = ref.slice(0, bang);
    const addr = ref.slice(bang + 1);
    (sheets[sheet] ||= {})[addr] = {
      ...(labels[ref] !== undefined ? { label: labels[ref] } : {}),
      value,
    };
  }
  return {
    sheets,
    definedNames: namedInputs,     // app levers (Excel defined names read by formulas)
    declaredOutputs: namedOutputs, // headline outputs the contract exposes
    cellCount: Object.keys(gt).length,
  };
}

/**
 * Capture one conversion into the dataset.
 * @param {object} o
 * @param {string} o.modelDir   dir containing model.xlsx + chunked/
 * @param {string} o.slug       stable id for this example
 * @param {object} [o.persona]  persona metadata (role/assetClass/goal/headlineMetrics)
 * @param {object} [o.drift]    verify result {outputs, matched, drifted}
 * @param {string} [o.datasetRoot]  default <repo>/dataset
 * @param {boolean} [o.includeEngine]  copy engine.js + sheets/ (default true)
 * @param {string}  [o.stamp]   ISO timestamp; defaults to now (caller may pin)
 * @returns {{dir:string, meta:object}}
 */
export function captureConversion({
  modelDir, slug, persona = null, drift = null,
  datasetRoot = join(REPO, 'dataset'), includeEngine = true, stamp = null,
}) {
  const chunked = join(modelDir, 'chunked');
  if (!existsSync(chunked)) throw new Error(`captureConversion: no chunked/ in ${modelDir}`);
  const outDir = join(datasetRoot, slug);
  mkdirSync(join(outDir, 'target'), { recursive: true });

  // --- input: source workbook + compact surface ---
  const srcXlsx = ['model.xlsx', `${slug}.xlsx`].map(f => join(modelDir, f)).find(existsSync);
  if (srcXlsx) cpSync(srcXlsx, join(outDir, 'input.xlsx'));
  const surface = buildSurface(chunked);
  writeFileSync(join(outDir, 'surface.json'), JSON.stringify(surface, null, 2));

  // --- target: the verified mapping artifacts ---
  const targetFiles = ['manifest.json', 'named-inputs.json', 'named-outputs.json', 'cell-types.json'];
  for (const f of targetFiles) {
    const src = join(chunked, f);
    if (existsSync(src)) cpSync(src, join(outDir, 'target', f));
  }

  // --- optional executable target ---
  let engineKept = false;
  if (includeEngine) {
    if (existsSync(join(chunked, 'engine.js'))) {
      cpSync(join(chunked, 'engine.js'), join(outDir, 'engine', 'engine.js'), { recursive: false });
      engineKept = true;
    }
    if (existsSync(join(chunked, 'sheets'))) {
      cpSync(join(chunked, 'sheets'), join(outDir, 'engine', 'sheets'), { recursive: true });
      engineKept = true;
    }
    if (existsSync(join(chunked, '_ground-truth.json'))) {
      cpSync(join(chunked, '_ground-truth.json'), join(outDir, 'engine', '_ground-truth.json'));
    }
  }

  const manifest = readJson(join(chunked, 'manifest.json'), {}) || {};
  const capturedAt = stamp || new Date().toISOString();
  const meta = {
    slug,
    title: manifest.title || persona?.role || slug,
    capturedAt,
    persona: persona ? {
      role: persona.role, assetClass: persona.assetClass, skillLevel: persona.skillLevel,
      seniority: persona.seniority, goal: persona.goal, headlineMetrics: persona.headlineMetrics,
    } : null,
    detectedModelType: manifest.modelType || manifest.detectedType || null,
    drift: drift || null,                       // {outputs, matched, drifted}
    verified: drift ? drift.drifted === 0 : null,
    cellCount: surface.cellCount,
    sheetCount: Object.keys(surface.sheets).length,
    namedInputCount: Object.keys(surface.definedNames || {}).length,
    declaredOutputCount: Object.keys(surface.declaredOutputs || {}).length,
    engineKept,
    files: {
      input: srcXlsx ? 'input.xlsx' : null,
      surface: 'surface.json',
      target: targetFiles.filter(f => existsSync(join(outDir, 'target', f))).map(f => `target/${f}`),
      engine: engineKept ? 'engine/' : null,
    },
  };
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

  // --- append to the dataset index (one JSONL line per example) ---
  mkdirSync(datasetRoot, { recursive: true });
  appendFileSync(join(datasetRoot, 'index.jsonl'), JSON.stringify({
    slug, capturedAt, verified: meta.verified, drift: meta.drift,
    assetClass: persona?.assetClass || null, cellCount: meta.cellCount,
    sheetCount: meta.sheetCount, dir: slug,
  }) + '\n');

  return { dir: outDir, meta };
}

/** Read a persona record from tests/personas/personas.json by slug (best-effort). */
export function personaBySlug(slug) {
  const data = readJson(join(REPO, 'tests', 'personas', 'personas.json'), { personas: [] });
  return (data.personas || []).find(p => p.slug === slug) || null;
}

// --- CLI ---
if (process.argv[1] && process.argv[1].endsWith('capture-dataset.mjs')) {
  const args = process.argv.slice(2);
  const modelDir = args[0];
  const slug = args[1];
  if (!modelDir || !slug) {
    console.error('usage: node tools/capture-dataset.mjs <modelDir> <slug> [--dataset dir] [--no-engine]');
    process.exit(2);
  }
  const dsIdx = args.indexOf('--dataset');
  const datasetRoot = dsIdx >= 0 ? resolve(args[dsIdx + 1]) : join(REPO, 'dataset');
  const includeEngine = !args.includes('--no-engine');
  const { dir, meta } = captureConversion({
    modelDir, slug, persona: personaBySlug(slug), datasetRoot, includeEngine,
  });
  console.log(`captured ${slug} -> ${dir}`);
  console.log(`  verified=${meta.verified} cells=${meta.cellCount} sheets=${meta.sheetCount}`);
}

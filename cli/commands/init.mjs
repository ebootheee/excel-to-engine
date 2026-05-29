/**
 * ete init — Parse Excel model + generate manifest in one step.
 *
 * Wraps the Rust parser and manifest generation into
 * a single zero-to-queryable command.
 *
 * @license MIT
 */

import { spawnSync } from 'child_process';
import { existsSync, unlinkSync, statSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, resolve, dirname, sep as PATH_SEP } from 'path';
import { fileURLToPath } from 'url';
import { runManifestCommand } from './manifest.mjs';
import { runSummary } from './summary.mjs';
import { emitManifestMaps } from '../../lib/manifest-maps.mjs';
import { emitBuildManifest } from '../../lib/build-manifest.mjs';
import { loadLabelIndex } from '../../lib/manifest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '..', '..', 'templates');
const PACKAGE_ROOT = resolve(__dirname, '..', '..');

/**
 * Execute the init command.
 */
export function runInit(excelPath, args) {
  const outputDir = args.output || excelPath.replace(/\.xlsx?$/i, '');
  const absOutput = resolve(outputDir);
  const chunkedDir = join(absOutput, 'chunked');

  const lines = [];
  lines.push(`Parsing: ${excelPath}`);
  lines.push(`Output:  ${absOutput}`);
  lines.push('');

  // Parser wall-clock cap. The cell-level parse + chunked emit on a
  // multi-million-cell model legitimately runs for several minutes; the old
  // fixed 10-min cap killed real builds mid-emit. Configurable via
  // --timeout <seconds> (0 disables the cap entirely). Default 30 min.
  let parseTimeoutMs = 1800 * 1000;
  if (args.timeout === true) {
    lines.push('Note: --timeout needs a value in seconds (e.g. --timeout 1800); using default 1800s.');
    lines.push('');
  } else if (args.timeout != null) {
    const t = Number(args.timeout);
    if (!Number.isFinite(t) || t < 0) {
      lines.push(`Note: ignoring invalid --timeout "${args.timeout}"; using default 1800s.`);
      lines.push('');
    } else if (t === 0) {
      parseTimeoutMs = undefined; // disabled — no wall-clock cap
    } else {
      parseTimeoutMs = t * 1000;
    }
  }

  // --reuse-parse: skip the Rust parse step when chunked/_ground-truth.json
  // already exists. Useful when iterating on manifest configuration against
  // an already-parsed large model — a 50+ sheet PE platform parse can take
  // 60-90s, but the manifest → refine → doctor loop only needs the existing
  // ground truth. Silently ignored if the chunked dir is missing.
  const groundTruthPath = join(chunkedDir, '_ground-truth.json');
  const canReuse = args.reuseParse && existsSync(groundTruthPath);

  if (canReuse) {
    lines.push('Step 1/3: Reusing existing parse (--reuse-parse)');
    lines.push(`  Ground truth: ${groundTruthPath}`);
    try {
      const size = statSync(groundTruthPath).size;
      lines.push(`  Size: ${(size / 1e6).toFixed(1)} MB`);
    } catch { /* ignore */ }
    lines.push('  Skipped Rust parser — using chunked/ as-is.');
  } else {
    if (args.reuseParse) {
      lines.push('Note: --reuse-parse requested but chunked/_ground-truth.json not found; running parser.');
      lines.push('');
    }

    // Step 1: Find and run the Rust parser. Resolve relative to the package
    // install location, not process.cwd() — running `ete init` from an
    // attacker-controlled directory shouldn't pick up a hostile binary at
    // `./pipelines/rust/target/release/rust-parser`.
    // Windows builds the binary as rust-parser.exe; Unix has no extension.
    const exe = process.platform === 'win32' ? '.exe' : '';
    const parserPaths = [
      join(PACKAGE_ROOT, `pipelines/rust/target/release/rust-parser${exe}`),
      join(PACKAGE_ROOT, `pipelines/rust/target/debug/rust-parser${exe}`),
    ];

    const parserBin = parserPaths.find(p => existsSync(p));

    if (!parserBin) {
      return {
        error: 'Rust parser not found. Build it first:\n  cd pipelines/rust && cargo build --release',
        _formatted: 'Error: Rust parser not found.\n\nBuild it:\n  cd pipelines/rust && cargo build --release\n\nThen re-run:\n  ete init ' + excelPath,
      };
    }

    if (!existsSync(excelPath)) {
      return { error: `Excel file not found: ${excelPath}` };
    }

    // Run parser. Use spawnSync with array args (no shell) — execSync with a
    // shell-concatenated string would let a crafted .xlsx path containing $(),
    // backticks, or quote characters inject commands.
    try {
      lines.push('Step 1/3: Running Rust parser...');
      // --emit-debug retains the large root model-map.json (the parser skips it
      // in chunked mode by default; see request #8 slimming).
      const parserArgs = [resolve(excelPath), absOutput, '--chunked'];
      if (args.emitDebug) parserArgs.push('--emit-debug');
      const result = spawnSync(
        parserBin,
        parserArgs,
        { encoding: 'utf-8', timeout: parseTimeoutMs, maxBuffer: 50 * 1024 * 1024 }
      );
      if (result.error) throw result.error;
      if (result.status !== 0) {
        const detail = result.stderr || result.stdout || `exit ${result.status}`;
        throw new Error(detail);
      }
      const output = result.stdout || '';
      lines.push('  Parser completed.');

      // Extract key stats from parser output
      const cellMatch = output.match(/Total cells:\s*([\d,]+)/);
      const sheetMatch = output.match(/Total sheets:\s*(\d+)/);
      if (cellMatch) lines.push(`  Cells: ${cellMatch[1]}`);
      if (sheetMatch) lines.push(`  Sheets: ${sheetMatch[1]}`);
    } catch (e) {
      return {
        error: `Parser failed: ${e.message}`,
        _formatted: `Error: Rust parser failed.\n${e.stderr || e.message}`,
      };
    }
  }

  // Fail-loud: a successful parse MUST yield a runnable engine. The chunked
  // emitter writes engine.js before the memory-heavy dependency-graph step and
  // errors hard if it can't — but a process the OS OOM-kills mid-emit can still
  // surface a non-zero exit without engine.js. Verify the load-bearing artifact
  // landed rather than proceeding to build a manifest around a directory with no
  // engine ("don't swallow a failed emit"). Cheap check here fails fast, before
  // the minutes-long manifest pipeline; emitBuildManifest re-checks at the end.
  const enginePath = join(chunkedDir, 'engine.js');
  if (!existsSync(enginePath)) {
    if (!canReuse) {
      // A fresh parse MUST yield a runnable engine — fail hard rather than build
      // a manifest around an engine-less directory.
      return {
        error: `No runnable engine: ${enginePath} is missing after the parse step.`,
        _formatted: [
          ...lines,
          '',
          'Error: no runnable engine.js was produced — this build is incomplete.',
          '  The parser exited without writing chunked/engine.js (most likely an out-of-memory',
          '  kill during chunked emission). Re-run on a machine with more memory, or scope the model.',
        ].join('\n'),
      };
    }
    // --reuse-parse: the user opted into the existing chunked/ as-is (for fast
    // manifest iteration). A missing engine isn't fatal here, but the dir isn't
    // runnable — surface it; the build manifest below records complete:false.
    lines.push('  Note: reused chunked/ has no engine.js — manifest steps will still run,');
    lines.push('        but the build is not runnable. Re-run without --reuse-parse to rebuild it.');
  }

  // Clean up redundant root-level model-map.json / formulas.json in chunked
  // mode. The CLI reads exclusively from chunked/. The parser now skips writing
  // the 600+ MB root model-map.json by default (request #8), so this is mostly a
  // safety net for older parser binaries — but it also clears the small root
  // formulas.json stub. Skipped under --emit-debug (keep everything the parser
  // emitted) or --keep-model-map.
  if (!canReuse && !args.keepModelMap && !args.emitDebug) {
    const rootModelMap = join(absOutput, 'model-map.json');
    const rootFormulas = join(absOutput, 'formulas.json');
    if (existsSync(rootModelMap)) {
      try {
        const size = statSync(rootModelMap).size;
        unlinkSync(rootModelMap);
        if (size > 1e6) lines.push(`  Cleaned up redundant model-map.json (${(size / 1e6).toFixed(0)} MB)`);
      } catch { /* ignore */ }
    }
    if (existsSync(rootFormulas)) {
      try { unlinkSync(rootFormulas); } catch { /* ignore */ }
    }
  }

  // Load the ground truth + label index ONCE and share them across the entire
  // manifest pipeline below (generate → refine → doctor → maps). Each of those
  // steps previously re-read and re-parsed the full ground truth independently —
  // up to four parses of a file that can exceed 200 MB, which was the dominant
  // cost of `init` on large models. The GT is read-only in all of them, so a
  // single shared parse is safe. Falls back to per-command loading if it can't
  // be pre-loaded.
  let sharedGt = null;
  let sharedLabelIndex = null;
  try {
    sharedGt = JSON.parse(readFileSync(groundTruthPath, 'utf-8'));
    sharedLabelIndex = loadLabelIndex(chunkedDir); // null if parser didn't emit _labels.json
  } catch (e) {
    lines.push(`  (Note: could not pre-load ground truth for sharing — commands will load it individually: ${e.message})`);
  }
  const shared = sharedGt ? { _gt: sharedGt, _labelIndex: sharedLabelIndex } : {};

  // Step 2: Generate manifest
  lines.push('');
  lines.push('Step 2/4: Generating manifest...');
  const manifestResult = runManifestCommand('generate', chunkedDir, {
    source: excelPath.split('/').pop(),
    ...shared,
  });

  if (manifestResult.error) {
    lines.push(`  Warning: ${manifestResult.error}`);
  } else {
    lines.push(`  Manifest written: ${manifestResult.outputPath}`);
    lines.push(`  Model type: ${manifestResult.manifest.model.type}`);
    lines.push(`  Segments: ${manifestResult.manifest.segments.length}`);
  }

  // Step 3a: Resolve a template BEFORE refine so refine can consume its hints
  // (summarySheets, scenarioColumns, peakEquityLabels). Without this ordering
  // the refiner can't prefer the template's declared base-case column for
  // rows where multiple scenarios sit side-by-side.
  let templateApplied = null;      // { name, hints }
  if (args.noTemplate) {
    // skip entirely
  } else if (args.template) {
    lines.push('');
    lines.push(`Applying template: ${args.template}`);
    const templateResult = applyTemplate(chunkedDir, args.template);
    if (templateResult.error) {
      lines.push(`  Warning: ${templateResult.error}`);
    } else {
      lines.push(`  Applied ${templateResult.applied} cell mappings from ${templateResult.path}`);
      templateApplied = { name: args.template, hints: templateResult.hints || {} };
    }
  } else {
    const match = detectMatchingTemplate(chunkedDir);
    if (match) {
      lines.push('');
      if (match.autoApply) {
        lines.push(`Template auto-applied: ${match.name} (${match.hits}/${match.required} signature sheets matched)`);
        const templateResult = applyTemplate(chunkedDir, match.name);
        if (templateResult.error) {
          lines.push(`  Warning: ${templateResult.error}`);
        } else {
          lines.push(`  Applied ${templateResult.applied} cell mappings from ${templateResult.path}`);
          lines.push(`  (override with --no-template, or pick a different one with --template <name>)`);
          templateApplied = { name: match.name, hints: templateResult.hints || {} };
        }
      } else {
        lines.push(`  Template suggestion: this model matches "${match.name}" — re-run with --template ${match.name} to apply known cell mappings.`);
      }
    }
  }

  // Step 3b: Refine manifest (smart search for key financial metrics)
  lines.push('');
  lines.push('Step 3/5: Refining manifest (searching for IRR, MOIC, carry, equity)...');
  try {
    const refineResult = runManifestCommand('refine', chunkedDir, {
      apply: true,
      hints: templateApplied ? templateApplied.hints : null,
      ...shared,
    });
    if (refineResult._formatted) {
      // Show just the found/not-found summary, not the full report
      const foundCount = Object.keys(refineResult.found || {}).length;
      const existingCount = Object.keys(refineResult.existing || {}).length;
      const totalFields = foundCount + existingCount + (refineResult.notFound || []).length;
      lines.push(`  Coverage: ${foundCount + existingCount}/${totalFields} key fields mapped`);
      if (foundCount > 0) lines.push(`  Refined: ${foundCount} new fields found and patched`);
      if (refineResult.notFound?.length > 0) {
        lines.push(`  Missing: ${refineResult.notFound.join(', ')}`);
      }
    }
  } catch (e) {
    lines.push(`  (Refinement skipped: ${e.message})`);
  }

  // Step 3c: Doctor-gated validation
  // Default behavior (changed 2026-04-17 post-SESSION_LOG-4): soft-fail. A
  // single bad basisCell or exitMultiple mapping should NOT block the whole
  // init — it wastes an 8-minute parse and leaves the user without a working
  // directory. Instead, we quarantine (null out) the offending field in the
  // manifest, print the doctor output inline, and exit 0. The user can re-run
  // `ete manifest set` to fix the field against the working chunked dir.
  //
  // `--strict` opts back in to hard-fail (CI / agent pipelines).
  // `--force` is preserved as a no-op alias (old sessions may still pass it).
  lines.push('');
  lines.push('Step 4/5: Doctor validation...');
  let doctorResult;
  let quarantined = [];
  try {
    doctorResult = runManifestCommand('doctor', chunkedDir, { ...shared });
    const errors = (doctorResult.issues || []).filter(i => i.severity === 'error');
    const warnings = (doctorResult.issues || []).filter(i => i.severity === 'warn');
    if (errors.length > 0) {
      lines.push(`  ✗ ${errors.length} error(s), ${warnings.length} warning(s)`);
      for (const e of errors) {
        lines.push(`    ${e.field}: ${e.message}`);
        if (e.fix) lines.push(`      fix: ${e.fix}`);
      }
      if (args.strict) {
        return {
          error: `Manifest validation failed with ${errors.length} error(s) (strict mode).`,
          _formatted: lines.join('\n') + '\n\nManifest validation failed. Omit --strict to soft-fail (quarantine offending fields and proceed).',
        };
      }
      // Soft-fail: quarantine the offending fields so downstream commands
      // won't silently consume a cell that doctor flagged.
      if (!args.keepSuspect) {
        quarantined = quarantineSuspectFields(chunkedDir, errors);
        if (quarantined.length > 0) {
          lines.push(`  Quarantined (set to null): ${quarantined.join(', ')}`);
          lines.push(`  Fix with: ete manifest set ${chunkedDir} <field> <cellRef>`);
          lines.push(`  Or run:   ete query ${chunkedDir} --search "<label>" --sheet "<summary tab>"`);
        }
      }
    } else if (warnings.length > 0) {
      lines.push(`  ${warnings.length} warning(s); run 'ete manifest doctor ${chunkedDir}' for details`);
    } else {
      lines.push('  All checks passed.');
    }
  } catch (e) {
    lines.push(`  (Doctor skipped: ${e.message})`);
  }

  // Step 5: Emit downstream contract maps (named-outputs/inputs, cell-types).
  // These let production consumers wire up cells by name without re-running the
  // engine to discover them. named-inputs needs the .xlsx (defined-names);
  // outputs + cell-types come from manifest + ground truth alone.
  lines.push('');
  lines.push('Step 5/6: Emitting downstream contract maps...');
  try {
    const maps = emitManifestMaps(chunkedDir, { excelPath, gt: sharedGt });
    if (maps.written.length > 0) {
      lines.push(`  Wrote: ${maps.written.join(', ')}`);
      const s = maps.stats;
      lines.push(`  Outputs: ${s.outputs ?? 0} (${s.outputsFromDefinedNames ?? 0} from defined-names)` +
        (s.inputs != null ? `, inputs: ${s.inputs}` : ''));
    }
    for (const sk of maps.skipped) {
      lines.push(`  Skipped ${sk.file}: ${sk.reason}`);
    }

    // #26 correctness audit: named outputs whose dependency closure passes
    // through an unsupported-function stub (_fn). Surfaced, never swallowed:
    // a warning by default (the real models still carry many fallbacks), or a
    // hard failure under --assert-no-fallbacks (CI / golden-master gate).
    const violations = maps.stats?.fallbackViolations || [];
    if (violations.length > 0) {
      const names = violations.map(v => v.output);
      if (args.assertNoFallbacks) {
        return {
          error: `Correctness gate: ${violations.length} named output(s) resolve through an unsupported-function stub.`,
          _formatted: [
            ...lines,
            `  ✗ --assert-no-fallbacks: ${violations.length} output(s) depend on _fn() stubs:`,
            ...violations.slice(0, 10).map(v => `      ${v.output} ← ${v.cell} (${v.function})`),
            violations.length > 10 ? `      …and ${violations.length - 10} more (see chunked/_fn-fallbacks.json)` : '',
            '  Add transpiler coverage for those functions, or omit --assert-no-fallbacks to proceed.',
          ].filter(Boolean).join('\n'),
        };
      }
      lines.push(`  ⚠ ${violations.length} output(s) resolve through an _fn() stub` +
        ` (annotated in named-outputs.json; see _fn-fallbacks.json; --assert-no-fallbacks to gate):` +
        ` ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}`);
    }
  } catch (e) {
    lines.push(`  (Map emission skipped: ${e.message})`);
  }

  // Step 5b: Slim the default chunked/ output. The cell-level
  // dependency-graph.json (ranges expanded → the largest artifact on big
  // models) and the sheet-level _graph.json are intermediate/debug: the
  // high-value derivative — the dependsOnNamedInputs / affectsOutputs closures —
  // was just baked into the named maps by Step 5, and nothing in the toolkit
  // reads _graph.json. Remove them unless --emit-debug (request #8: keep the
  // default output small; the contract lives in the named maps).
  if (!args.emitDebug) {
    let freed = 0;
    for (const f of ['dependency-graph.json', '_graph.json']) {
      const p = join(chunkedDir, f);
      if (existsSync(p)) {
        try { freed += statSync(p).size; unlinkSync(p); } catch { /* ignore */ }
      }
    }
    if (freed > 1e6) {
      lines.push(`  Slimmed debug artifacts: ${(freed / 1e6).toFixed(0)} MB freed (--emit-debug to retain)`);
    }
  } else {
    lines.push('  --emit-debug: retained dependency-graph.json + _graph.json');
  }

  // Step 5c: Finalize — lock the artifact layout + emit a content hash so a
  // downstream consumer can pin this exact build and detect drift without
  // re-deriving the expected file set per version. Runs AFTER slimming so it
  // describes the shipped layout. This is also the comprehensive completeness
  // gate (#23/#24): if any required artifact (above all engine.js) is missing,
  // the build is incomplete and init fails hard rather than reporting success.
  let buildContentHash = null;
  lines.push('');
  lines.push('Finalizing: build manifest (artifact lock + content hash)...');
  try {
    const bm = emitBuildManifest(chunkedDir, { toolVersion: readToolVersion() });
    buildContentHash = bm.contentHash;
    if (!bm.ok && !canReuse) {
      // Fresh build is missing a required artifact (above all engine.js) — the
      // comprehensive completeness gate. Fail hard rather than report success.
      return {
        error: `Incomplete build — missing required artifact(s): ${bm.missing.join(', ')}.`,
        _formatted: [
          ...lines,
          `  ✗ Missing required: ${bm.missing.join(', ')}`,
          '  The build was NOT finalized; chunked/ must not be treated as runnable.',
        ].join('\n'),
      };
    }
    if (!bm.ok) {
      // --reuse-parse: record the incomplete state honestly, don't block.
      lines.push(`  Build incomplete (reused dir): missing ${bm.missing.join(', ')} — re-run without --reuse-parse for a runnable build.`);
    } else {
      lines.push(`  build-manifest.json written — ${bm.contentHash}`);
    }
  } catch (e) {
    return {
      error: `Failed to write build manifest: ${e.message}`,
      _formatted: [...lines, `  ✗ build manifest failed: ${e.message}`].join('\n'),
    };
  }

  // Step 6: Print summary
  lines.push('');
  lines.push('Step 6/6: Model summary');
  lines.push('─'.repeat(60));

  try {
    const summary = runSummary(chunkedDir, { format: 'table' });
    if (summary._formatted) {
      lines.push(summary._formatted);
    }
  } catch (e) {
    lines.push(`  (Summary unavailable: ${e.message})`);
  }

  // Review checklist
  if (manifestResult.reviewChecklist?.length > 0) {
    lines.push('');
    lines.push('Review checklist:');
    for (const item of manifestResult.reviewChecklist) {
      lines.push(`  ${item}`);
    }
  }

  lines.push('');
  lines.push(`Ready. Try: ete summary ${chunkedDir}`);

  // Machine-readable quiet output: skips all the narrative, returns a
  // compact JSON-ready summary for CI/agent contexts.
  if (args.quiet) {
    const m = manifestResult.manifest;
    const quiet = {
      ok: true,
      outputDir: absOutput,
      chunkedDir,
      contentHash: buildContentHash,
      modelType: m?.model?.type,
      sheets: m ? (Object.keys(new Set((Object.keys(m.baseCaseOutputs || {}))) )).length : undefined,
      segments: m?.segments?.length || 0,
      equityClasses: m?.equity?.classes?.length || 0,
      timeline: m?.timeline ? {
        investmentYear: m.timeline.investmentYear,
        exitYear: m.timeline.exitYear,
        periodicity: m.timeline.periodicity,
      } : null,
      baseCaseOutputs: m?.baseCaseOutputs || {},
    };
    return {
      outputDir: absOutput,
      chunkedDir,
      manifest: manifestResult.manifest,
      _formatted: JSON.stringify(quiet, null, 2),
    };
  }

  return {
    outputDir: absOutput,
    chunkedDir,
    manifest: manifestResult.manifest,
    _formatted: lines.join('\n'),
  };
}

/** Best-effort tool version from package.json, for build-manifest provenance. */
function readToolVersion() {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8')).version || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Template application
// ---------------------------------------------------------------------------

/**
 * Apply a named template's cell mappings to the manifest in `chunkedDir`.
 * Returns `{ applied, path, hints }` on success or `{ error }` on failure.
 *
 * The `hints` block is persisted on the manifest as `_refineHints` so that
 * downstream refinement runs (including future re-runs from the same dir)
 * can consume it even if they aren't going through `ete init`.
 */
function applyTemplate(chunkedDir, templateName) {
  const templatePath = findTemplate(templateName);
  if (!templatePath) {
    return { error: `Template "${templateName}" not found in ${TEMPLATES_DIR}` };
  }
  const manifestPath = join(chunkedDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { error: `No manifest found at ${manifestPath}` };
  }

  const template = JSON.parse(readFileSync(templatePath, 'utf-8'));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  let applied = 0;
  for (const [path, cellRef] of Object.entries(template.mappings || {})) {
    if (path.startsWith('_')) continue; // comment keys
    if (typeof cellRef !== 'string' || !cellRef.includes('!')) continue;
    setNested(manifest, path, cellRef);
    applied++;
  }

  // Persist hints onto the manifest for the refine step and any later reruns.
  const hints = template.hints || {};
  if (Object.keys(hints).length > 0) {
    manifest._refineHints = hints;
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { applied, path: templatePath, hints };
}

/**
 * Detect whether the model matches a known template signature by checking the
 * sheet-name set derived from ground truth against each template's
 * `signature.sheetNames`. Returns the best match descriptor
 * `{ name, hits, required, autoApply }` or null if nothing crosses the
 * per-template threshold (default 0.75).
 *
 * When multiple templates match, the one with the highest hit fraction wins.
 * Ties go to the template with the larger signature (more specific match).
 */
function detectMatchingTemplate(chunkedDir) {
  if (!existsSync(TEMPLATES_DIR)) return null;

  const gtPath = join(chunkedDir, '_ground-truth.json');
  if (!existsSync(gtPath)) return null;
  const gt = JSON.parse(readFileSync(gtPath, 'utf-8'));

  const sheetSet = new Set();
  for (const addr of Object.keys(gt)) {
    const bang = addr.lastIndexOf('!');
    if (bang > 0) sheetSet.add(addr.substring(0, bang));
  }

  const files = readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'));
  let best = null;
  for (const f of files) {
    try {
      const template = JSON.parse(readFileSync(join(TEMPLATES_DIR, f), 'utf-8'));
      const required = template.signature?.sheetNames || [];
      if (required.length === 0) continue;
      const threshold = typeof template.signature?.matchThreshold === 'number'
        ? template.signature.matchThreshold
        : 0.75;
      const hits = required.filter(n => sheetSet.has(n)).length;
      const fraction = hits / required.length;
      if (fraction < threshold) continue;

      const candidate = {
        name: template.name,
        hits,
        required: required.length,
        fraction,
        autoApply: template.signature?.autoApply === true,
      };

      if (!best) {
        best = candidate;
        continue;
      }
      if (candidate.fraction > best.fraction) best = candidate;
      else if (candidate.fraction === best.fraction && candidate.required > best.required) best = candidate;
    } catch { /* skip malformed templates */ }
  }
  return best;
}

function findTemplate(name) {
  if (!existsSync(TEMPLATES_DIR)) return null;
  // Reject anything that isn't a plain template name. Without this,
  // `--template ../../etc/some.json` resolves outside TEMPLATES_DIR.
  if (typeof name !== 'string' || !/^[\w.\-]+$/.test(name)) return null;
  const templatesRoot = resolve(TEMPLATES_DIR);
  const candidates = [
    join(TEMPLATES_DIR, name),
    join(TEMPLATES_DIR, `${name}.json`),
  ];
  return candidates.find(p => {
    if (!p.endsWith('.json')) return false;
    if (!existsSync(p)) return false;
    // Defense in depth: ensure the resolved path stays inside the templates dir.
    const abs = resolve(p);
    return abs === templatesRoot || abs.startsWith(templatesRoot + PATH_SEP);
  }) || null;
}

// Reject path segments that walk into `Object.prototype`. A template or CLI
// caller shouldn't be able to set Object.prototype.x by passing a crafted path
// like "constructor.prototype.foo" or "__proto__.foo".
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function setNested(obj, path, value) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  if (parts.some(p => FORBIDDEN_KEYS.has(p))) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const nextIsIndex = /^\d+$/.test(parts[i + 1]);
    if (cur[key] == null) cur[key] = nextIsIndex ? [] : {};
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
}

function getNested(obj, path) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Quarantine manifest fields that doctor flagged as errors. Sets each path to
 * null (preserving the manifest shape) and also removes the matching entry from
 * baseCaseOutputs so downstream commands can't silently consume the bad value.
 * Returns the list of paths that were actually quarantined.
 */
function quarantineSuspectFields(chunkedDir, errors) {
  const manifestPath = join(chunkedDir, 'manifest.json');
  if (!existsSync(manifestPath)) return [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    return [];
  }

  const quarantined = [];
  for (const err of errors) {
    const path = err.field;
    if (!path) continue;
    // Skip non-cell paths (e.g., "segments.<id>" describes a row, not a cell ref).
    if (path.startsWith('segments.')) continue;
    const existing = getNested(manifest, path);
    if (existing == null) continue;
    setNested(manifest, path, null);
    quarantined.push(path);

    // Also clear the mirrored baseCaseOutputs shorthand key if present.
    const shortKey = path.split('.').pop().replace(/^\[\d+\]$/, '').replace(/Cell$/, '');
    if (manifest.baseCaseOutputs && shortKey in manifest.baseCaseOutputs) {
      delete manifest.baseCaseOutputs[shortKey];
    }
  }

  if (quarantined.length > 0) {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
  return quarantined;
}

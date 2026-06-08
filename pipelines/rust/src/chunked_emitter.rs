/// Chunked emitter — generates per-sheet `.mjs` modules, `_graph.json`,
/// `_ground-truth.json`, and `engine.js` orchestrator.
///
/// This implements **Option C: Chunked Compilation** from PLAN-rust-pipeline.md.

use crate::dependency::{extract_refs_ranges, extract_refs_shallow};
use crate::formula_ast::parse_formula;
use crate::parser::{CellValue, WorkbookData};
use crate::sheet_partition::{
    build_sheet_graph, extract_ground_truth, extract_labels_index, partition_sheets, SheetGraph, SheetPartition,
};
use crate::transpiler::{transpile, TranspileConfig};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Generate all chunked output artifacts into `output_dir`.
/// Returns a summary string of what was emitted.
pub fn emit_chunked(
    workbook: &WorkbookData,
    output_dir: &Path,
    lazy_engine: bool,
) -> Result<String, String> {
    let t_start = Instant::now();

    eprintln!("[chunked] Partitioning {} sheets...", workbook.sheets.len());
    let t0 = Instant::now();
    let partitions = partition_sheets(workbook);
    eprintln!("[chunked] Partitioned in {}ms", t0.elapsed().as_millis());

    eprintln!("[chunked] Building sheet-level DAG...");
    let t0 = Instant::now();
    let sheet_graph = build_sheet_graph(&partitions)?;
    eprintln!(
        "[chunked] DAG built in {}ms — {} sheets, topo order: [{}]",
        t0.elapsed().as_millis(),
        sheet_graph.sheets.len(),
        if sheet_graph.topo_order.len() <= 10 {
            sheet_graph.topo_order.join(", ")
        } else {
            format!(
                "{}, ... ({} more)",
                sheet_graph.topo_order[..5].join(", "),
                sheet_graph.topo_order.len() - 5
            )
        }
    );

    // Create sheets/ subdirectory
    let sheets_dir = output_dir.join("sheets");
    fs::create_dir_all(&sheets_dir)
        .map_err(|e| format!("Failed to create sheets/ directory: {}", e))?;

    // Write shared runtime helpers module (once, not per-sheet)
    let helpers_code = generate_helpers_module();
    fs::write(sheets_dir.join("_helpers.mjs"), &helpers_code)
        .map_err(|e| format!("Failed to write _helpers.mjs: {}", e))?;
    eprintln!("[chunked] _helpers.mjs written ({})", human_size(helpers_code.len()));

    // 1. Emit per-sheet modules — STREAMED twice over: (a) each module is
    //    written to disk as it's generated rather than collected (an earlier
    //    version held ALL ~800 MB of generated JS at once → 18 GB peak with an
    //    empty sheets/ until the very end), and (b) write_sheet_module now
    //    streams each module straight to the file's buffered writer instead of
    //    building a Vec<String> + join (issue #33: a monster sheet was held ~2×
    //    transiently). Live memory is now one transpiled cell expression plus the
    //    writer buffer, regardless of module size; files land incrementally
    //    (progress + partial durability). A write failure is still fatal.
    let total_sheets = partitions.len();
    eprintln!("[chunked] Emitting {} sheet modules (streamed)...", total_sheets);
    let t_emit = Instant::now();
    let completed = AtomicUsize::new(0);

    // Generate one module, write it, drop the string; return only small metadata
    // (file name + counts), never the code. Shared by the parallel (light) and
    // sequential (heavy) passes below. All captures are Sync, so this is usable
    // as a rayon map operator.
    let emit_one = |partition: &SheetPartition| -> Result<(String, usize, usize), String> {
        let file_name = format!("{}.mjs", sanitize_sheet_name(&partition.name));
        let path = sheets_dir.join(&file_name);
        let n_formulas = partition.formula_cells.len();
        // Stream the module straight to the file — no full-module String ever
        // materializes (the #33 fix; a monster sheet was held twice via Vec+join).
        let file = fs::File::create(&path)
            .map_err(|e| format!("Failed to create {}: {}", file_name, e))?;
        let mut bw = std::io::BufWriter::with_capacity(1 << 20, file);
        write_sheet_module(partition, &mut bw)
            .map_err(|e| format!("Failed to write {}: {}", file_name, e))?;
        bw.flush().map_err(|e| format!("Failed to flush {}: {}", file_name, e))?;
        drop(bw);
        let code_len = fs::metadata(&path).map(|m| m.len() as usize).unwrap_or(0);
        let done = completed.fetch_add(1, Ordering::Relaxed) + 1;
        if done % 5 == 0 || done == total_sheets {
            eprint!("\r[chunked]   [{}/{}] modules written...", done, total_sheets);
            std::io::stderr().flush().ok();
        }
        Ok((file_name, n_formulas, code_len))
    };

    // A single transpiled monster sheet can be hundreds of MB. Emit "heavy"
    // sheets one-at-a-time so two are never materialized concurrently; emit the
    // many "light" sheets in parallel. On small models every sheet is light, so
    // this stays fully parallel — same behaviour as before, minus the retention.
    const HEAVY_FORMULA_THRESHOLD: usize = 200_000;
    let (heavy, light): (Vec<&SheetPartition>, Vec<&SheetPartition>) = partitions
        .iter()
        .partition(|p| p.formula_cells.len() >= HEAVY_FORMULA_THRESHOLD);

    let mut metas: Vec<(String, usize, usize)> = light
        .into_par_iter()
        .map(|p| emit_one(p))
        .collect::<Result<Vec<_>, String>>()?;
    for p in heavy {
        metas.push(emit_one(p)?);
    }

    eprintln!(); // newline after progress

    let sheet_files: Vec<String> = metas.iter().map(|(f, _, _)| f.clone()).collect();
    let total_formulas_emitted: usize = metas.iter().map(|(_, n, _)| *n).sum();
    let total_bytes_emitted: usize = metas.iter().map(|(_, _, b)| *b).sum();

    eprintln!(
        "[chunked] All {} sheet modules emitted in {:.1}s ({} formulas, {})",
        total_sheets,
        t_emit.elapsed().as_secs_f64(),
        total_formulas_emitted,
        human_size(total_bytes_emitted)
    );

    // 2. Emit _graph.json (compact — machine-read only; pretty-printing roughly
    //    doubled the on-disk size for no consumer benefit)
    eprint!("[chunked] Writing _graph.json...");
    std::io::stderr().flush().ok();
    let graph_json = serde_json::to_string(&sheet_graph)
        .map_err(|e| format!("Failed to serialize graph: {}", e))?;
    fs::write(output_dir.join("_graph.json"), &graph_json)
        .map_err(|e| format!("Failed to write _graph.json: {}", e))?;
    eprintln!(" done ({})", human_size(graph_json.len()));

    // 3. Emit _ground-truth.json
    eprint!("[chunked] Extracting ground truth...");
    std::io::stderr().flush().ok();
    let t0 = Instant::now();
    let ground_truth = extract_ground_truth(workbook);
    // Compact — load-bearing (CLI + manifest read it) so it must ship, but
    // pretty-printing ~doubled its size. It is machine-read; compact is fine.
    let gt_json = serde_json::to_string(&ground_truth)
        .map_err(|e| format!("Failed to serialize ground truth: {}", e))?;
    fs::write(output_dir.join("_ground-truth.json"), &gt_json)
        .map_err(|e| format!("Failed to write _ground-truth.json: {}", e))?;
    eprintln!(
        " done — {} entries ({}) in {}ms",
        ground_truth.len(),
        human_size(gt_json.len()),
        t0.elapsed().as_millis()
    );

    // 4. Emit _labels.json — label → [{sheet, col, row, text}]
    //    Enables O(1) label search in the CLI (replaces 30s GT scans per
    //    query --search call). See PLAN_V4.md Phase 1.
    eprint!("[chunked] Building label index...");
    std::io::stderr().flush().ok();
    let t_lbl = Instant::now();
    let labels = extract_labels_index(workbook);
    let labels_json = serde_json::to_string(&labels)
        .map_err(|e| format!("Failed to serialize labels: {}", e))?;
    fs::write(output_dir.join("_labels.json"), &labels_json)
        .map_err(|e| format!("Failed to write _labels.json: {}", e))?;
    let label_count = labels.as_object().map(|o| o.len()).unwrap_or(0);
    eprintln!(
        " done — {} unique labels ({}) in {}ms",
        label_count,
        human_size(labels_json.len()),
        t_lbl.elapsed().as_millis()
    );

    // 5. Emit engine.js orchestrator — the load-bearing runnable artifact.
    //    Emitted BEFORE the dependency graph (step 6) on purpose: engine.js
    //    depends only on the sheet-level DAG + partitions (both already built),
    //    never on the cell-level edge map. The dependency-graph step is the
    //    single most memory-intensive part of the build; emitting the engine
    //    first guarantees a runnable `run()` lands even if that later step is
    //    killed. A write failure here is fatal (Err → exit 1) — we never leave a
    //    chunked/ dir without an engine.
    eprint!(
        "[chunked] Writing engine.js orchestrator{}...",
        if lazy_engine { " (lazy)" } else { "" }
    );
    std::io::stderr().flush().ok();
    let engine_js = if lazy_engine {
        generate_orchestrator_lazy(&sheet_graph)
    } else {
        generate_orchestrator(&sheet_graph, &partitions)
    };
    fs::write(output_dir.join("engine.js"), &engine_js)
        .map_err(|e| format!("Failed to write engine.js: {}", e))?;
    eprintln!(" done ({})", human_size(engine_js.len()));

    // 6. Emit dependency-graph.json — cell-level forward edges (cell → cells it
    //    reads). Lets consumers compute a named output's dependency closure
    //    without re-running the engine or parsing the full model-map.
    //    STREAMED to disk one entry at a time: the previous version built the
    //    entire edge map in a BTreeMap and then serialized the whole document
    //    into a second in-memory String, ~doubling peak memory on top of an
    //    already-large workbook and OOM-killing the parser on multi-million-cell
    //    models (the cell-level map with ranges expanded is the largest single
    //    structure in the build). Streaming caps the extra memory at one cell's
    //    refs at a time. Schema unchanged (cell-dependency-edges-v1; consumers
    //    read only `.edges`).
    eprint!("[chunked] Building dependency graph (streamed)...");
    std::io::stderr().flush().ok();
    let t_dep = Instant::now();
    let dep_path = output_dir.join("dependency-graph.json");
    let dep_count = write_dependency_graph(&partitions, &dep_path)?;
    let dep_size = fs::metadata(&dep_path).map(|m| m.len() as usize).unwrap_or(0);
    eprintln!(
        " done — {} formula cells ({}) in {}ms",
        dep_count,
        human_size(dep_size),
        t_dep.elapsed().as_millis()
    );

    eprintln!(
        "[chunked] ✅ Complete in {:.1}s",
        t_start.elapsed().as_secs_f64()
    );

    // Summary
    let cluster_info = if sheet_graph.sheet_clusters.is_empty() {
        "no circular deps".to_string()
    } else {
        format!(
            "{} convergence cluster(s) ({} sheets)",
            sheet_graph.sheet_clusters.len(),
            sheet_graph.sheet_clusters.iter().map(|c| c.len()).sum::<usize>()
        )
    };
    let summary = format!(
        "Chunked output: {} sheet modules, _graph.json ({} sheets, {}), \
         _ground-truth.json ({} entries), engine.js",
        sheet_files.len(),
        sheet_graph.sheets.len(),
        cluster_info,
        ground_truth.len()
    );

    Ok(summary)
}

// ---------------------------------------------------------------------------
// Per-sheet module generation
// ---------------------------------------------------------------------------

/// Stream the JavaScript module code for a single sheet directly to `w`.
///
/// Previously this built a `Vec<String>` of every line and `.join("\n")`d it
/// into one String — for a monster sheet (PP&E ~190 MB of generated JS) that's
/// the line Vec *and* the joined String live at once, ~2× transiently (issue
/// #33). Writing each line straight to the file's buffered writer caps live
/// memory at one line plus the writer's buffer, regardless of module size; the
/// per-cell transpiled expression is the only sizeable transient.
///
/// Output is line-for-line identical to the old `join("\n")` form (trailing
/// newline after the closing brace).
fn write_sheet_module<W: Write>(partition: &SheetPartition<'_>, w: &mut W) -> std::io::Result<()> {
    let sheet_name = &partition.name;

    // Header
    writeln!(w, "// sheets/{}.mjs — AUTO-GENERATED by rust-parser (chunked mode)", sanitize_sheet_name(sheet_name))?;
    writeln!(w, "// Do not edit manually — re-run the pipeline to regenerate.")?;
    writeln!(w)?;

    // Exports: SHEET_NAME, SHEET_DEPENDENCIES
    writeln!(w, "export const SHEET_NAME = \"{}\";", escape_js_string(sheet_name))?;

    let deps_arr: Vec<String> = partition
        .sheet_dependencies
        .iter()
        .map(|d| format!("\"{}\"", escape_js_string(d)))
        .collect();
    writeln!(w, "export const SHEET_DEPENDENCIES = [{}];", deps_arr.join(", "))?;
    writeln!(w)?;

    // Runtime helpers for Excel functions — import from shared module
    writeln!(w, "{}", "import { _index, _match, _vlookup, _hlookup, _large, _small, _rank, _fn, _sumif, _sumifs, _countif, _countifs, _offset, _matchesCriteria, _colNum, _numToCol, computeNPV, computeIRR, computeXIRR, computePMT, computePV, computeFV, computeRATE, computeNPER, computeXNPV, _minifs, _maxifs, _averageif, _averageifs, _filter, _excelSerialFromYMD, _edate, _eomonth } from './_helpers.mjs';")?;
    writeln!(w)?;

    // compute(ctx) function
    writeln!(w, "/**")?;
    writeln!(w, " * Compute all cells for sheet \"{}\".", escape_js_string(sheet_name))?;
    writeln!(w, "{}", " * @param {{Object}} ctx - Context with get(addr), set(addr, val), values map")?;
    writeln!(w, " */")?;
    writeln!(w, "{}", "export function compute(ctx) {")?;

    // Phase 1: input/literal cells
    if !partition.input_cells.is_empty() {
        writeln!(w, "  // ── Literal / input cells ──")?;
        for cell in &partition.input_cells {
            let qualified = format!("{}!{}", sheet_name, cell.address);
            let val_js = cell_value_to_js(&cell.value);
            writeln!(w, "  ctx.set(\"{}\", {});", qualified, val_js)?;
        }
        writeln!(w)?;
    }

    // Phase 2: formula cells — detect intra-sheet cycles and wrap in convergence loops
    if !partition.formula_cells.is_empty() {
        // Build per-cell transpiled expressions
        let mut cell_exprs: Vec<(String, String)> = Vec::new(); // (qualified_addr, js_expr)
        for cell in &partition.formula_cells {
            if let Some(formula) = &cell.formula {
                let qualified = format!("{}!{}", sheet_name, cell.address);
                // Set current cell position so ROW()/COLUMN() resolve correctly
                let cell_config = TranspileConfig {
                    default_sheet: sheet_name.clone(),
                    use_flat_vars: false,
                    use_ctx_get: true,
                    current_row: cell.row + 1,  // Excel is 1-based
                    current_col: cell.col + 1,
                };
                let js_expr = match parse_formula(formula) {
                    Some(ast) => transpile(&ast, &cell_config),
                    None => format!("/* parse error: {} */ 0", escape_js_string(formula)),
                };
                cell_exprs.push((qualified, js_expr));
            }
        }

        // Detect intra-sheet circular references
        let circular_cells = detect_intra_sheet_cycles(partition, sheet_name);

        if circular_cells.is_empty() {
            // No cycles — emit linearly
            writeln!(w, "  // ── Formula cells ──")?;
            for (addr, expr) in &cell_exprs {
                writeln!(w, "  ctx.set(\"{}\", {});", addr, expr)?;
            }
        } else {
            // Split into: pre-cycle, cycle (convergence loop), post-cycle
            let cycle_set: HashSet<String> = circular_cells.iter().cloned().collect();

            // Pre-cycle cells (not in cycle)
            let pre: Vec<&(String, String)> = cell_exprs
                .iter()
                .take_while(|(addr, _)| !cycle_set.contains(addr))
                .collect();

            // Cycle cells
            let cycle: Vec<&(String, String)> = cell_exprs
                .iter()
                .filter(|(addr, _)| cycle_set.contains(addr))
                .collect();

            // Post-cycle cells (after all cycle cells)
            let last_cycle_idx = cell_exprs
                .iter()
                .rposition(|(addr, _)| cycle_set.contains(addr))
                .unwrap_or(0);
            let post: Vec<&(String, String)> = cell_exprs
                .iter()
                .skip(last_cycle_idx + 1)
                .filter(|(addr, _)| !cycle_set.contains(addr))
                .collect();

            if !pre.is_empty() {
                writeln!(w, "  // ── Formula cells (pre-cycle) ──")?;
                for (addr, expr) in &pre {
                    writeln!(w, "  ctx.set(\"{}\", {});", addr, expr)?;
                }
                writeln!(w)?;
            }

            // Convergence loop for circular cells.
            //
            // Honesty contract (engine-honesty F2/F3/F4):
            //  - Records per-sheet telemetry onto ctx._sheetConvergence so the
            //    orchestrator can surface { iterations, converged, maxDelta } into
            //    run().meta (a single-sheet cycle is otherwise invisible to the
            //    cross-sheet cluster telemetry — meta was byte-identical between a
            //    converged and a divergent run).
            //  - Real divergence detection replaces the old constant-delta "stale"
            //    early-break: a delta that is INCREASING (monotone up) or holding
            //    CONSTANT and non-zero (not shrinking toward _tol) is divergence, NOT
            //    convergence. Such a run is classified converged=false AND its cycle
            //    cells are NaN-filled so a consumer can't silently trust a wrong
            //    number. A genuinely contracting run (delta shrinking) converges
            //    exactly as before.
            let cycle_addrs: Vec<String> = cycle.iter().map(|(a, _)| a.clone()).collect();
            let non_cycle_in_range: Vec<&(String, String)> = cell_exprs
                .iter()
                .skip(pre.len())
                .take(last_cycle_idx + 1 - pre.len())
                .filter(|(addr, _)| !cycle_set.contains(addr))
                .collect();

            writeln!(w, "  // ── Convergence loop ({} circular cells) ──", cycle.len())?;
            writeln!(w, "  const _maxIter = 200;")?;
            writeln!(w, "  const _tol = 1e-6;")?;
            writeln!(w, "  let _converged = false;")?;
            writeln!(w, "  let _delta = Infinity;")?;
            writeln!(w, "  let _iters = 0;")?;
            // Rolling window of recent deltas — used to classify monotone-up /
            // constant-non-zero divergence (vs a genuine contraction).
            writeln!(w, "  let _deltaHist = [];")?;
            writeln!(w, "{}", "  for (let _ci = 0; _ci < _maxIter; _ci++) {")?;
            writeln!(w, "    _iters = _ci + 1;")?;

            // Save previous values of cycle cells
            writeln!(
                w,
                "    const _prev = [{}];",
                cycle_addrs
                    .iter()
                    .map(|a| format!("ctx.get(\"{}\")", a))
                    .collect::<Vec<_>>()
                    .join(", ")
            )?;

            // Re-evaluate all cycle cells
            for (addr, expr) in &cycle {
                writeln!(w, "    ctx.set(\"{}\", {});", addr, expr)?;
            }

            // Also re-evaluate non-cycle cells between the cycle cells that depend on cycle outputs
            for (addr, expr) in &non_cycle_in_range {
                writeln!(w, "    ctx.set(\"{}\", {});", addr, expr)?;
            }

            // Convergence check
            writeln!(
                w,
                "    const _curr = [{}];",
                cycle_addrs
                    .iter()
                    .map(|a| format!("ctx.get(\"{}\")", a))
                    .collect::<Vec<_>>()
                    .join(", ")
            )?;
            // A non-finite cycle cell (Inf/NaN, e.g. a divide-by-cold-0) can never
            // be a trustworthy fixed point — force a non-converging delta.
            writeln!(w, "{}", "    _delta = _prev.reduce((mx, v, i) => { const c = _curr[i]; if (!Number.isFinite(c)) return Infinity; return Math.max(mx, Math.abs(v - (c || 0))); }, 0);")?;
            writeln!(w, "{}", "    if (_delta < _tol) { _converged = true; break; }")?;
            // Real divergence detection (replaces the old constant-delta stale break,
            // which silently STOPPED on a constant non-zero delta and returned that
            // garbage labelled converged). Keep a short window of deltas and, once we
            // have a few, declare divergence when the delta is NOT trending down:
            // either strictly increasing (monotone up) or essentially flat & non-zero
            // (max-min across the window within _tol of each other, and well above
            // _tol). A genuine contraction shrinks the delta, so it never matches.
            writeln!(w, "    _deltaHist.push(_delta);")?;
            writeln!(w, "    if (_deltaHist.length > 5) _deltaHist.shift();")?;
            writeln!(w, "{}", "    if (_deltaHist.length >= 4) {")?;
            writeln!(w, "{}", "      const _w = _deltaHist;")?;
            writeln!(w, "{}", "      const _mn = Math.min(..._w), _mx = Math.max(..._w);")?;
            writeln!(w, "{}", "      const _monoUp = _w.every((d, i) => i === 0 || d >= _w[i - 1] - _tol) && (_w[_w.length - 1] > _w[0] + _tol);")?;
            writeln!(w, "{}", "      const _flatHot = (_mx - _mn) < _tol && _mn > _tol * 100;")?;
            writeln!(w, "{}", "      if (_monoUp || _flatHot) break; // diverging / stuck non-zero — NOT converged")?;
            writeln!(w, "    }}")?;
            writeln!(w, "  }}")?;

            // Honesty contract: if we exhausted iterations / broke on divergence
            // without reaching tolerance, the cycle cells are NOT a fixed point.
            // NaN-fill them so a downstream consumer reads NaN (detectably unusable)
            // rather than a confident wrong number.
            writeln!(w, "{}", "  if (!_converged) {")?;
            for addr in &cycle_addrs {
                writeln!(w, "    ctx.set(\"{}\", NaN);", addr)?;
            }
            writeln!(w, "  }}")?;
            // Record telemetry for the orchestrator to fold into run().meta.
            writeln!(
                w,
                "  ctx._sheetConvergence[SHEET_NAME] = {{ iterations: _iters, converged: _converged, maxDelta: _delta }};"
            )?;

            if !post.is_empty() {
                writeln!(w)?;
                writeln!(w, "  // ── Formula cells (post-cycle) ──")?;
                for (addr, expr) in &post {
                    writeln!(w, "  ctx.set(\"{}\", {});", addr, expr)?;
                }
            }
        }
    }

    writeln!(w, "}}")?;
    Ok(())
}

/// Convert flat variable references (s_SheetName_A1) to ctx.get("SheetName!A1") calls.
#[allow(dead_code)] // retained for optional cross-sheet emission mode
fn convert_vars_to_ctx_get(js: &str, _default_sheet: &str) -> String {
    // Match pattern: s_<SheetName>_<ColRow>
    // We use a simple scan approach since the variable names follow a strict pattern
    let mut result = String::with_capacity(js.len());
    let bytes = js.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        // Look for s_ prefix that starts a variable reference
        if i + 2 < len && bytes[i] == b's' && bytes[i + 1] == b'_' {
            let start = i;
            i += 2; // skip "s_"

            // Read sheet name part (everything up to the last _ before col+row)
            let mut parts: Vec<u8> = Vec::new();
            while i < len && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                parts.push(bytes[i]);
                i += 1;
            }

            let var_body = String::from_utf8_lossy(&parts).to_string();

            // Parse: find the last underscore that separates sheet name from cell address
            // Cell address is like A1, B12, AA100 (uppercase letters followed by digits)
            if let Some(addr_info) = extract_cell_addr_from_var(&var_body) {
                let sheet_part = &var_body[..var_body.len() - addr_info.len() - 1]; // -1 for underscore
                // Reverse the sanitization: underscores back to spaces (best effort)
                let sheet_name = sheet_part.to_string();
                result.push_str(&format!("ctx.get(\"{}!{}\")", sheet_name, addr_info));
            } else {
                // Couldn't parse — keep original
                result.push_str(&js[start..i]);
            }
        } else {
            result.push(bytes[i] as char);
            i += 1;
        }
    }

    result
}

/// Try to extract a cell address (like "A1", "B12", "AA100") from the end of a variable body.
/// Returns the cell address if found.
#[allow(dead_code)] // companion to convert_vars_to_ctx_get
fn extract_cell_addr_from_var(var_body: &str) -> Option<String> {
    // Scan from the end: digits first, then uppercase letters
    let bytes = var_body.as_bytes();
    let len = bytes.len();
    if len == 0 {
        return None;
    }

    // Read digits from end
    let mut i = len;
    while i > 0 && bytes[i - 1].is_ascii_digit() {
        i -= 1;
    }
    let digit_start = i;
    if digit_start == len {
        return None; // no digits
    }

    // Read uppercase letters before digits
    while i > 0 && bytes[i - 1].is_ascii_uppercase() {
        i -= 1;
    }
    let letter_start = i;
    if letter_start == digit_start {
        return None; // no letters
    }

    // Must have underscore before the cell address (separator from sheet name)
    if letter_start == 0 {
        return None; // no sheet name
    }
    if bytes[letter_start - 1] != b'_' {
        return None;
    }

    Some(var_body[letter_start..].to_string())
}

// ---------------------------------------------------------------------------
// Orchestrator (engine.js) generation
// ---------------------------------------------------------------------------

fn generate_orchestrator(graph: &SheetGraph, _partitions: &[SheetPartition<'_>]) -> String {
    let mut lines: Vec<String> = Vec::new();

    lines.push("// engine.js — AUTO-GENERATED orchestrator (chunked mode)".to_string());
    lines.push("// Imports sheet modules and executes them in topological order.".to_string());
    lines.push("// Do not edit manually — re-run the pipeline to regenerate.".to_string());
    lines.push(String::new());

    // Import all sheet modules
    for name in &graph.topo_order {
        let safe = sanitize_sheet_name(name);
        lines.push(format!(
            "import {{ compute as compute_{safe}, SHEET_NAME as name_{safe}, SHEET_DEPENDENCIES as deps_{safe} }} from './sheets/{safe}.mjs';",
            safe = safe
        ));
    }
    lines.push(String::new());

    // Runtime context class
    lines.push(generate_ctx_runtime());
    lines.push(String::new());

    // Topo order constant
    let topo_strs: Vec<String> = graph
        .topo_order
        .iter()
        .map(|s| format!("\"{}\"", escape_js_string(s)))
        .collect();
    lines.push(format!(
        "const TOPO_ORDER = [{}];",
        topo_strs.join(", ")
    ));
    lines.push(String::new());

    // Sheet compute map
    lines.push("const SHEET_COMPUTE = {".to_string());
    for name in &graph.topo_order {
        let safe = sanitize_sheet_name(name);
        lines.push(format!(
            "  \"{}\": compute_{},",
            escape_js_string(name),
            safe
        ));
    }
    lines.push("};".to_string());
    lines.push(String::new());

    // Sheet clusters (circular dependency groups that need convergence loops).
    // Eager engine emits these only when the model actually has them.
    lines.extend(emit_clusters_block(graph, false));

    // run() — shared with the lazy orchestrator (eager passes lazy=false, so no
    // load() guard and the output is identical to the original hand-written run).
    lines.extend(emit_run_function(graph, false));
    lines.push(String::new());

    // Default export
    lines.push("export default { run };".to_string());
    lines.push(String::new());

    lines.join("\n")
}

/// Emit the `SHEET_CLUSTERS` + `CLUSTER_SHEETS` constants. The eager engine emits
/// them only when the model has circular clusters (`force=false`, matching the
/// original output). The lazy engine passes `force=true` so its cone loader can
/// always reference `SHEET_CLUSTERS` (an empty array when the model is acyclic).
fn emit_clusters_block(graph: &SheetGraph, force: bool) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    if graph.sheet_clusters.is_empty() && !force {
        return lines;
    }
    lines.push("// Sheet clusters — groups of sheets with circular dependencies".to_string());
    lines.push("// These are executed in convergence loops until values stabilize.".to_string());
    lines.push("const SHEET_CLUSTERS = [".to_string());
    for cluster in &graph.sheet_clusters {
        let names: Vec<String> = cluster
            .iter()
            .map(|s| format!("\"{}\"", escape_js_string(s)))
            .collect();
        lines.push(format!("  [{}],", names.join(", ")));
    }
    lines.push("];".to_string());
    lines.push(String::new());

    // Build a set of all sheets that belong to a cluster
    lines.push("const CLUSTER_SHEETS = new Set(SHEET_CLUSTERS.flat());".to_string());
    lines.push(String::new());
    lines
}

/// Emit the `run()` function — shared by the eager and lazy orchestrators. Both
/// reference the same `SHEET_COMPUTE` / `TOPO_ORDER` / `SHEET_CLUSTERS` /
/// `CLUSTER_SHEETS`, so the body is identical. With `lazy=true` a guard is
/// inserted that throws if no sheets have been loaded (the lazy engine's footgun);
/// with `lazy=false` the output is byte-identical to the original eager run().
fn emit_run_function(graph: &SheetGraph, lazy: bool) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();

    // JSDoc + signature
    lines.push(r#"/**
 * Execute the full model.
 * @param {Object} [inputs] - Optional cell overrides: { "Sheet!A1": value, ... }
 * @param {Object} [options]
 * @param {boolean} [options.strict] - Throw if any override cell is not read by a formula.
 * @returns {{ values: Object, kpis: Object, meta: Object, unknownOverrides: string[] }}
 */
export function run(inputs = {}, options = {}) {"#.to_string());

    if lazy {
        lines.push(r#"  // Lazy engine: sheet modules load on demand via load()/runScoped(). Guard the
  // footgun of calling run() before anything is loaded (it would otherwise no-op
  // every sheet and silently return an all-zero model). A cone-scoped load()
  // intentionally leaves out-of-cone sheets unloaded; those are skipped by the
  // `if (computeFn)` checks below, which is the correct behaviour for a scoped run.
  if (Object.keys(SHEET_COMPUTE).length === 0) {
    throw new Error('engine.run(): no sheets loaded — call `await load()` (or `await load({ sheets: [...] })` / `load({ cells: [...] })`) first, or use `await runScoped(inputs, options)`.');
  }"#.to_string());
    }

    // Body preamble (ctx + override tracking + apply/pin). Joining after the
    // signature line above reproduces the original single-string preamble.
    lines.push(r#"  const ctx = new ComputeContext();
  const _t0 = Date.now();
  const TOL = 1e-6;
  const _clusterMeta = [];

  // Track which override cells are actually read by a formula. Only instrument
  // when overrides are present so the base case stays zero-overhead. Lets the
  // engine report no-op overrides (typos, missing sheet prefix, stale cells).
  const _overrideKeys = Object.keys(inputs);
  const _readOverrides = new Set();
  if (_overrideKeys.length > 0) {
    const _oset = new Set(_overrideKeys);
    const _origGet = ctx.get.bind(ctx);
    ctx.get = (addr) => { if (_oset.has(addr)) _readOverrides.add(addr); return _origGet(addr); };
  }

  // Apply input overrides, then pin them so each sheet's literal/input pass
  // can't clobber them back to base case.
  for (const [addr, val] of Object.entries(inputs)) {
    ctx.values[addr] = val;
  }
  if (_overrideKeys.length > 0) ctx._locked = new Set(_overrideKeys);
"#.to_string());

    if graph.sheet_clusters.is_empty() {
        lines.push(r#"
  // Execute sheets in topological order (no circular deps)
  for (const sheetName of TOPO_ORDER) {
    const computeFn = SHEET_COMPUTE[sheetName];
    if (computeFn) computeFn(ctx);
  }
"#.to_string());
    } else {
        lines.push(r#"
  // Execute sheets in topological order, with convergence loops for clusters
  const MAX_ITER = 200;
  const executed = new Set();
  for (const sheetName of TOPO_ORDER) {
    if (executed.has(sheetName)) continue;
    if (CLUSTER_SHEETS.has(sheetName)) {
      const cluster = SHEET_CLUSTERS.find(c => c.includes(sheetName));
      if (cluster && !cluster.some(s => executed.has(s))) {
        // Run the entire cluster in a convergence loop, recording telemetry.
        let _iters = 0, _lastDelta = Infinity, _conv = false;
        let _nonFiniteCell = null, _nonFiniteStreak = 0;
        // Rolling window of recent deltas — used to classify monotone-up /
        // constant-non-zero divergence (vs a genuine contraction). Replaces the
        // old constant-delta "stale" early-break, which STOPPED on a constant
        // non-zero delta and returned that garbage labelled converged (F2/F3).
        let _clusterDeltaHist = [];
        // Lock-grade convergence via a SAMPLED delta — diff only a fixed subset of
        // cells each iteration instead of JSON.stringify-ing the whole (up to 5.8M-
        // cell) ctx every pass (~8.8min/pass -> ~1min/pass on the real model). The
        // sample = every numeric cell on the cluster's OWN sheets (exactly the cells
        // the cluster solves) plus a bounded strided safety net over the rest of ctx
        // (catches a cell the cluster writes onto a non-member sheet). Built ONCE,
        // after the first compute pass, when the cluster's cells exist as numbers.
        const _clusterSet = new Set(cluster);
        const _SAMPLE_SAFETY_CAP = 4000;
        let _sampleKeys = null, _before = null;
        for (let iter = 0; iter < MAX_ITER; iter++) {
          _iters = iter + 1;
          for (const s of cluster) {
            const fn = SHEET_COMPUTE[s];
            if (fn) fn(ctx);
          }
          const v = ctx.values;
          if (_sampleKeys === null) {
            // First pass done: the cluster's cells now exist. Capture the sample.
            _sampleKeys = [];
            for (const key in v) {
              const _bang = key.indexOf('!');
              if (_bang > 0 && _clusterSet.has(key.slice(0, _bang)) && typeof v[key] === 'number') _sampleKeys.push(key);
            }
            const _allKeys = Object.keys(v);
            const _stride = Math.max(1, Math.floor(_allKeys.length / _SAMPLE_SAFETY_CAP));
            for (let i = 0; i < _allKeys.length; i += _stride) {
              if (typeof v[_allKeys[i]] === 'number') _sampleKeys.push(_allKeys[i]);
            }
            // All slots undefined -> Infinity delta on this build pass, so the first
            // pass (every cell newly computed) can never falsely "converge".
            _before = new Array(_sampleKeys.length);
            // No observable cluster cells: we can't confirm a fixed point, so don't
            // let an empty scan read maxDelta=0 and falsely converge on pass 0.
            if (_sampleKeys.length === 0) break; // converged stays false (honest)
          }
          let maxDelta = 0;
          let _anyNonFinite = false;
          for (let i = 0; i < _sampleKeys.length; i++) {
            const _cur = v[_sampleKeys[i]];
            if (typeof _cur !== 'number') continue;
            // TRANSIENT-TOLERANT non-finite handling (#57). A non-finite cell (Inf/NaN
            // — typically a coverage/amortization formula dividing by a denominator
            // that is a COLD 0 at iteration 0 and WARMS to nonzero as the cluster
            // solves) must NOT abort the loop the way the old streak>=3 break did
            // (it quit before the denominator could warm, NaN-filling a cluster whose
            // true fixed point is finite — the Debt!AR84 lock-grade symptom). Instead:
            // exclude it from the delta, remember it, and KEEP iterating. Non-finiteness
            // is judged ONLY at the fixed point (below) — a TRANSIENT cold-0 warms and
            // converges; a STRUCTURAL #DIV/0! stays non-finite and stays converged=false.
            if (!Number.isFinite(_cur)) { _anyNonFinite = true; _nonFiniteCell = _sampleKeys[i]; _before[i] = _cur; continue; }
            const _b = _before[i];
            // A cell going undefined -> number is a change, not convergence.
            // (Skipping these would let the first pass — every cluster cell newly
            // computed — look like maxDelta=0 and falsely "converge". Keep updating
            // _before so the next iteration still has a full baseline.)
            if (typeof _b !== 'number') { maxDelta = Infinity; _before[i] = _cur; continue; }
            maxDelta = Math.max(maxDelta, Math.abs(_cur - _b));
            _before[i] = _cur;
          }
          if (_anyNonFinite) {
            // A non-finite pass can never be a fixed point. Force a non-converging
            // delta and keep iterating so a TRANSIENT cold-0 denominator can warm.
            // BUT if the FINITE surface has already settled (maxDelta<TOL) while a cell
            // stays non-finite across several consecutive passes, it is STRUCTURAL
            // (a genuine #DIV/0! that never warms) — stop and report converged=false
            // (honest); the NaN-fill below then blanks the cluster (PR #52 contract).
            _lastDelta = Infinity;
            _clusterDeltaHist.length = 0;
            if (maxDelta < TOL) { _nonFiniteStreak++; if (_nonFiniteStreak >= 4) break; }
            else _nonFiniteStreak = 0;
            continue;
          }
          _nonFiniteStreak = 0;
          _lastDelta = maxDelta;
          // Fixed point reached with the whole sampled surface finite: a transient
          // cold-0 (if any) has fully warmed, so clear its residual telemetry.
          if (maxDelta < TOL) { _conv = true; _nonFiniteCell = null; break; }
          // Real divergence detection (replaces the old constant-delta stale
          // break). Keep a short window of deltas; once we have a few, declare
          // divergence when the delta is NOT trending down: either strictly
          // increasing (monotone up) or essentially flat & non-zero (window
          // spread within TOL and well above TOL). A genuine contraction shrinks
          // the delta, so it never matches and converges exactly as before.
          _clusterDeltaHist.push(maxDelta);
          if (_clusterDeltaHist.length > 5) _clusterDeltaHist.shift();
          if (_clusterDeltaHist.length >= 4) {
            const _w = _clusterDeltaHist;
            const _mn = Math.min(..._w), _mx = Math.max(..._w);
            const _monoUp = _w.every((d, i) => i === 0 || d >= _w[i - 1] - TOL) && (_w[_w.length - 1] > _w[0] + TOL);
            const _flatHot = (_mx - _mn) < TOL && _mn > TOL * 100;
            if (_monoUp || _flatHot) break; // diverging / stuck non-zero — NOT converged
          }
        }
        // Honesty contract: a cluster that did not reach tolerance is NOT a fixed
        // point. NaN-fill its cells (on the cluster's own sheets) so a consumer
        // reads NaN (detectably unusable) rather than a confident wrong number.
        if (!_conv) {
          for (const key in ctx.values) {
            const _b = key.indexOf('!');
            if (_b > 0 && _clusterSet.has(key.slice(0, _b)) && typeof ctx.values[key] === 'number'
                && !(ctx._locked && ctx._locked.has(key))) {
              ctx.values[key] = NaN;
            }
          }
        }
        _clusterMeta.push({ sheets: cluster.slice(), iterations: _iters, converged: _conv, maxDelta: _lastDelta, nonFiniteCell: _nonFiniteCell });
        for (const s of cluster) executed.add(s);
      }
    } else {
      const computeFn = SHEET_COMPUTE[sheetName];
      if (computeFn) computeFn(ctx);
      executed.add(sheetName);
    }
  }
"#.to_string());
    }

    // Shared meta computation + return.
    //
    // converged folds BOTH cross-sheet cluster telemetry (_clusterMeta) AND
    // intra-sheet convergence telemetry (ctx._sheetConvergence, populated by any
    // sheet that ran an internal convergence loop). A model whose entire cycle
    // lives on ONE sheet has NO sheet cluster (SCC detection is sheet-level), so
    // before this fix it took the acyclic path, _clusterMeta stayed [], and
    // converged=[].every()=true regardless of whether the single sheet actually
    // reached a fixed point — meta was byte-identical between a converged and a
    // divergent run (engine-honesty F4). Now perSheetIterations is populated and
    // converged=false flows through for an intra-sheet divergence too.
    //
    // converged=false means a cluster OR a single sheet exhausted its iteration
    // cap / was detected diverging — its affected cells are NaN-filled and the
    // result must not be trusted (consumers should refuse to lock on it).
    lines.push(r#"
  const _intra = Object.entries(ctx._sheetConvergence || {});
  const _converged = _clusterMeta.every(c => c.converged) && _intra.every(([, m]) => m.converged);
  const _maxDelta = Math.max(
    _clusterMeta.reduce((m, c) => Math.max(m, c.maxDelta), 0),
    _intra.reduce((m, [, s]) => Math.max(m, Number.isFinite(s.maxDelta) ? s.maxDelta : 0), 0),
  );
  const _iterations = Math.max(
    _clusterMeta.reduce((m, c) => Math.max(m, c.iterations), 0),
    _intra.reduce((m, [, s]) => Math.max(m, s.iterations), 0),
  );
  const _perSheetIterations = {};
  for (const c of _clusterMeta) for (const s of c.sheets) _perSheetIterations[s] = c.iterations;
  // Intra-sheet entries: surface BOTH the iteration count (so perSheetIterations
  // is no longer {} for a single-sheet cycle) and per-sheet converged flags.
  for (const [s, m] of _intra) _perSheetIterations[s] = m.iterations;
  const _sheetConvergence = {};
  for (const [s, m] of _intra) _sheetConvergence[s] = { iterations: m.iterations, converged: m.converged, maxDelta: m.maxDelta };
  const meta = {
    converged: _converged,
    iterations: _iterations,
    maxDelta: _maxDelta,
    convergenceTolerance: TOL,
    clusters: _clusterMeta,
    perSheetIterations: _perSheetIterations,
    sheetConvergence: _sheetConvergence,
    elapsedMs: Date.now() - _t0,
  };

  const unknownOverrides = _overrideKeys.filter(k => !_readOverrides.has(k));
  if (options.strict && unknownOverrides.length > 0) {
    throw new Error('engine.run(): unknown override cell(s) not read by any formula: ' + unknownOverrides.join(', '));
  }

  // Clone the computed cell map ONCE. `kpis` is the documented alias of `values`
  // (see chunked/INTEGRATION.md) — it shares the same snapshot instead of taking a
  // second full spread of the (up to ~5.8M-entry) ctx.values map, which on the real
  // model doubled the per-run allocation for no observable difference (the two
  // objects were already deep-equal). Shape is unchanged: both keys are present and
  // each is the complete value snapshot.
  const _snapshot = { ...ctx.values };
  return {
    values: _snapshot,
    kpis: _snapshot,
    meta,
    unknownOverrides,
  };
}"#.to_string());

    lines
}

/// Lazy orchestrator — emitted for `--lazy-engine`. Identical `run()` semantics to
/// the eager engine, but sheet modules are NOT statically imported: they load on
/// demand via an async `load()` (optionally scoped to an output cone), so
/// `import('engine.js')` no longer pulls ~800 MB of modules into the heap before
/// `run()` can be called. `run()` stays synchronous; the consumer awaits `load()`
/// (or `runScoped()`) first. This is the opt-in fix for Wall A (#22); the default
/// engine.js stays eager + synchronous so existing consumers are untouched.
fn generate_orchestrator_lazy(graph: &SheetGraph) -> String {
    let mut lines: Vec<String> = Vec::new();

    lines.push("// engine.js — AUTO-GENERATED orchestrator (chunked mode, LAZY)".to_string());
    lines.push("// Sheet modules are imported ON DEMAND by load()/runScoped(), not at".to_string());
    lines.push("// module-load time — so importing this file is cheap regardless of model size.".to_string());
    lines.push("// run() is synchronous: await load() (or use runScoped()) before calling it.".to_string());
    lines.push("// Do not edit manually — re-run the pipeline to regenerate.".to_string());
    lines.push(String::new());

    // Runtime context class (no static sheet imports)
    lines.push(generate_ctx_runtime());
    lines.push(String::new());

    // Topo order constant
    let topo_strs: Vec<String> = graph
        .topo_order
        .iter()
        .map(|s| format!("\"{}\"", escape_js_string(s)))
        .collect();
    lines.push(format!("const TOPO_ORDER = [{}];", topo_strs.join(", ")));
    lines.push(String::new());

    // Lazy module loaders — thunks that dynamically import each sheet module.
    lines.push("// Lazy loaders — each returns a Promise of its sheet module. load() awaits".to_string());
    lines.push("// only the ones it needs (requested sheets/cells + their transitive deps),".to_string());
    lines.push("// so a cone-scoped run never imports modules outside the cone.".to_string());
    lines.push("const SHEET_LOADERS = {".to_string());
    for name in &graph.topo_order {
        let safe = sanitize_sheet_name(name);
        lines.push(format!(
            "  \"{}\": () => import('./sheets/{}.mjs'),",
            escape_js_string(name),
            safe
        ));
    }
    lines.push("};".to_string());
    lines.push(String::new());

    // Per-sheet forward-dependency map (for the output-cone closure).
    lines.push("// Sheet-level forward deps (sheet -> sheets it reads) for cone expansion.".to_string());
    lines.push("const SHEET_DEPS = {".to_string());
    for entry in &graph.sheets {
        let deps: Vec<String> = entry
            .deps
            .iter()
            .map(|d| format!("\"{}\"", escape_js_string(d)))
            .collect();
        lines.push(format!(
            "  \"{}\": [{}],",
            escape_js_string(&entry.name),
            deps.join(", ")
        ));
    }
    lines.push("};".to_string());
    lines.push(String::new());

    // Clusters — always emitted (force=true) so the cone closure can pull in
    // whole clusters even when the consumer seeds only one member.
    lines.extend(emit_clusters_block(graph, true));

    // Compute map filled lazily by load(), plus load-state tracking.
    lines.push("const SHEET_COMPUTE = {};".to_string());
    lines.push("const _loaded = new Set();".to_string());
    lines.push(String::new());

    // load() + the output-cone closure.
    lines.push(r#"/**
 * Load sheet modules into SHEET_COMPUTE. Call (and await) before run().
 * @param {Object} [options]
 * @param {string[]} [options.sheets] - Sheet names to load (with their transitive deps).
 * @param {string[]} [options.cells]  - Qualified cell addrs ("Sheet!A1"); each cell's
 *                                       sheet prefix seeds the cone.
 *   With neither, ALL sheets load (still lazy, but complete). To scope to named
 *   outputs, map their names -> cells via named-outputs.json, then pass `cells`.
 * @returns {Promise<{ loaded: string[], count: number }>}
 */
export async function load(options = {}) {
  // Seed set: explicit sheets + the sheet owning each requested cell.
  let seeds = null;
  if (Array.isArray(options.sheets) || Array.isArray(options.cells)) {
    seeds = new Set(options.sheets || []);
    for (const cell of (options.cells || [])) {
      const i = String(cell).indexOf('!');
      if (i > 0) seeds.add(String(cell).slice(0, i));
    }
  }

  // Target set: everything, or the transitive forward-dependency closure of the
  // seeds. Any sheet in a circular cluster pulls in ALL of its cluster members —
  // a cluster converges as a unit, so a partial load would be wrong.
  let targets;
  if (seeds === null) {
    targets = Object.keys(SHEET_LOADERS);
  } else {
    const want = new Set();
    const stack = [...seeds];
    while (stack.length) {
      const s = stack.pop();
      if (want.has(s)) continue;
      want.add(s);
      for (const d of (SHEET_DEPS[s] || [])) if (!want.has(d)) stack.push(d);
      const cluster = CLUSTER_SHEETS.has(s) ? SHEET_CLUSTERS.find(c => c.includes(s)) : null;
      if (cluster) for (const m of cluster) if (!want.has(m)) stack.push(m);
    }
    targets = [...want].filter(s => SHEET_LOADERS[s]);
  }

  const toLoad = targets.filter(s => !_loaded.has(s));
  await Promise.all(toLoad.map(async (s) => {
    const mod = await SHEET_LOADERS[s]();
    SHEET_COMPUTE[s] = mod.compute;
    _loaded.add(s);
  }));
  return { loaded: [..._loaded], count: _loaded.size };
}
"#.to_string());

    // run() — shared body, with the no-sheets-loaded guard.
    lines.extend(emit_run_function(graph, true));
    lines.push(String::new());

    // runScoped() convenience.
    lines.push(r#"/**
 * Convenience: load (optionally cone-scoped), then run, in one await.
 * @param {Object} [inputs] - Cell overrides, as for run().
 * @param {Object} [options] - { sheets?, cells?, strict? } — passed to load() and run().
 * @returns {Promise<{ values: Object, kpis: Object, meta: Object, unknownOverrides: string[] }>}
 */
export async function runScoped(inputs = {}, options = {}) {
  await load(options);
  return run(inputs, options);
}"#.to_string());
    lines.push(String::new());

    // Default export
    lines.push("export default { run, load, runScoped };".to_string());
    lines.push(String::new());

    lines.join("\n")
}

fn generate_ctx_runtime() -> String {
    r#"/**
 * ComputeContext — shared state for sheet-level compute functions.
 */
class ComputeContext {
  constructor() {
    /** @type {Object<string, any>} */
    this.values = {};
    /** @type {Set<string>|null} Pinned override cells — set() is a no-op for these. */
    this._locked = null;
    /**
     * Intra-sheet convergence telemetry, keyed by sheet name. A sheet whose
     * compute() ran an internal convergence loop records
     * { iterations, converged, maxDelta } here so the orchestrator can fold it
     * into run().meta. Without this, a single-sheet-cycle model produced a meta
     * byte-identical between a converged and a divergent run (engine-honesty bug
     * F4). Stays empty for purely linear sheets — zero overhead.
     * @type {Object<string, {iterations:number, converged:boolean, maxDelta:number}>}
     */
    this._sheetConvergence = {};
  }

  /**
   * Get a cell value by qualified address (e.g. "Sheet1!A1").
   * Returns 0 for missing values (safe default for numeric formulas).
   */
  get(addr) {
    const v = this.values[addr];
    return v !== undefined ? v : 0;
  }

  /**
   * Set a cell value by qualified address. Pinned override cells are not
   * overwritten — without this, a sheet's "literal/input cells" pass would
   * clobber run() overrides back to their base-case values.
   */
  set(addr, value) {
    if (this._locked !== null && this._locked.has(addr)) return;
    this.values[addr] = value;
  }

  /**
   * Parse a range string into {sheet, c1, r1, c2, r2}.
   * Returns null if the range doesn't match the expected pattern.
   */
  _parseRange(rangeStr) {
    const match = rangeStr.match(/^(.+)!([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    if (!match) return null;
    const [, sheet, col1, row1, col2, row2] = match;
    return { sheet, c1: colToNum(col1), r1: parseInt(row1), c2: colToNum(col2), r2: parseInt(row2) };
  }

  /**
   * Get a range of values as a flat array.
   * @param {string} rangeStr - e.g. "Sheet1!A1:B3"
   */
  range(rangeStr) {
    const p = this._parseRange(rangeStr);
    if (!p) return [];
    const result = [];
    for (let r = p.r1; r <= p.r2; r++) {
      for (let c = p.c1; c <= p.c2; c++) {
        result.push(this.get(`${p.sheet}!${numToCol(c)}${r}`));
      }
    }
    return result;
  }

  /**
   * Get a range as a 2D array (row-major). Required for INDEX(range, row, col).
   * @param {string} rangeStr - e.g. "Sheet1!A1:C3"
   * @returns {Array<Array<any>>} - [[r1c1, r1c2, ...], [r2c1, r2c2, ...], ...]
   */
  range2d(rangeStr) {
    const p = this._parseRange(rangeStr);
    if (!p) return [];
    const result = [];
    for (let r = p.r1; r <= p.r2; r++) {
      const row = [];
      for (let c = p.c1; c <= p.c2; c++) {
        row.push(this.get(`${p.sheet}!${numToCol(c)}${r}`));
      }
      result.push(row);
    }
    return result;
  }

  /**
   * Return all formula-computed values as KPI map.
   */
  kpis() {
    return { ...this.values };
  }
}

function colToNum(col) {
  let n = 0;
  for (const ch of col) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}
function numToCol(n) {
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}"#
    .to_string()
}

// ---------------------------------------------------------------------------
// Intra-sheet cycle detection
// ---------------------------------------------------------------------------

/// Stream the cell-level forward dependency edge map (cell → cells it reads) to
/// `path` as `dependency-graph.json`, writing one entry at a time so the full
/// map is never materialized in memory.
///
/// Refs use [`extract_refs_ranges`]: ranges are kept as **compact tokens**
/// (`Sheet!A1:B10`), not expanded to every interior cell. Full expansion
/// produced a 37 GB / 7 min graph on the real models and OOM-killed the Node
/// closure-baking step that reads it back (issue #32); a single `SUM(A1:A1000)`
/// went from 1000 edge strings to 1. Reachability stays complete — the consumer
/// expands a range token lazily against the (small) sets of cells it cares about
/// (named inputs, fallback cells) plus the formula-cell keys, via indexed
/// interval queries. Schema bumped to `cell-dependency-edges-v2`.
///
/// Only formula cells with ≥1 detected ref appear as keys; literal/input cells
/// and ref-less formulas (e.g. `=TODAY()`) are omitted. Iteration follows
/// partition order then cell order — stable for a given workbook, so the output
/// is deterministic across builds of the same model. Returns the entry count.
fn write_dependency_graph(partitions: &[SheetPartition<'_>], path: &Path) -> Result<usize, String> {
    let file = fs::File::create(path)
        .map_err(|e| format!("Failed to create {}: {}", path.display(), e))?;
    let mut w = std::io::BufWriter::new(file);
    let werr = |e: std::io::Error| format!("Failed to write dependency-graph.json: {}", e);

    // Header up to (and including) the opening brace of the "edges" object,
    // then a newline so EVERY edge entry lands on its own line. The file stays
    // valid JSON (small consumers / tests can still `JSON.parse` the whole
    // thing), but a large-model consumer can read it line-by-line and never
    // build the >0.5 GB single string that `JSON.parse`/`readFileSync(utf8)`
    // chokes on (Node caps a string at ~512 MiB; a 532 MB graph threw "Cannot
    // create a string longer than 0x1fffffe8 characters" and the closures were
    // silently dropped). See `loadDependencyEdges` in lib/manifest-maps.mjs.
    w.write_all(
        br#"{"format":"cell-dependency-edges-v2","note":"Forward edges: cell -> [cells/ranges it reads]. Ranges are kept as compact tokens (Sheet!A1:B10), not expanded; consumers expand lazily against cells of interest. Only formula cells appear as keys. One edge per line (newline-delimited) so the file is readable without materializing a >512 MiB string.","edges":{
"#,
    )
    .map_err(werr)?;

    // Still the heaviest sequential step on big models (one pass over every
    // formula cell), though compact range tokens make it far lighter than the
    // old full expansion. Bounded-memory (streamed); emit per-sheet progress so
    // it's not mistaken for a hang.
    let total_sheets = partitions.len();
    let mut count: usize = 0;
    for (si, partition) in partitions.iter().enumerate() {
        for cell in &partition.formula_cells {
            if let Some(formula) = &cell.formula {
                let refs = extract_refs_ranges(formula, &partition.name);
                if refs.is_empty() {
                    continue;
                }
                let key = format!("{}!{}", partition.name, cell.address);
                // serde_json handles all JSON string/array escaping; only a
                // single entry is held in memory at a time.
                let key_json = serde_json::to_string(&key)
                    .map_err(|e| format!("Failed to encode dependency key: {}", e))?;
                let refs_json = serde_json::to_string(&refs)
                    .map_err(|e| format!("Failed to encode dependency refs: {}", e))?;
                if count > 0 {
                    w.write_all(b",\n").map_err(werr)?; // comma + newline: one entry per line
                }
                w.write_all(key_json.as_bytes()).map_err(werr)?;
                w.write_all(b":").map_err(werr)?;
                w.write_all(refs_json.as_bytes()).map_err(werr)?;
                count += 1;
            }
        }
        eprint!(
            "\r[chunked]   dep-graph: {}/{} sheets, {} edges...",
            si + 1,
            total_sheets,
            count
        );
        std::io::stderr().flush().ok();
    }
    eprintln!(); // newline after progress

    // Newline, then close the "edges" object and append edgeCount last (we only
    // know it after streaming). The leading "\n" keeps the closing `}` on its own
    // line so the line-reader never sees it merged with the last entry. Consumers
    // read `.edges`; edgeCount is informational.
    write!(w, "\n}},\"edgeCount\":{}}}", count).map_err(werr)?;
    w.flush().map_err(werr)?;
    Ok(count)
}

/// Detect cells within a single sheet that form circular references.
/// Returns the set of qualified addresses involved in cycles.
fn detect_intra_sheet_cycles(partition: &SheetPartition<'_>, sheet_name: &str) -> Vec<String> {
    // Build intra-sheet dependency graph
    let mut edges: HashMap<String, Vec<String>> = HashMap::new();
    let mut all_addrs: HashSet<String> = HashSet::new();

    for cell in &partition.formula_cells {
        if let Some(formula) = &cell.formula {
            let qualified = format!("{}!{}", sheet_name, cell.address);
            all_addrs.insert(qualified.clone());

            // Shallow (non-expanding) on purpose: cycles between cells are what
            // we care about, and exploding every same-sheet range to ≤1000 cells
            // here is both ruinously expensive on large sheets and a source of
            // spurious self-cycles (B10=SUM(B1:B10)). This matches the behaviour
            // the known-good engines were built with.
            let refs = extract_refs_shallow(formula, sheet_name);
            let intra_refs: Vec<String> = refs
                .into_iter()
                .filter(|r| {
                    // Keep only references to cells within this same sheet
                    r.starts_with(&format!("{}!", sheet_name))
                })
                .collect();
            edges.insert(qualified, intra_refs);
        }
    }

    // Tarjan's SCC — O(V+E) single-pass cycle detection
    // Any SCC with size > 1 means those cells are in a cycle.
    let nodes: Vec<String> = all_addrs.iter().cloned().collect();
    let node_index: HashMap<&str, usize> = nodes.iter().enumerate().map(|(i, n)| (n.as_str(), i)).collect();
    let n = nodes.len();

    let mut index_counter: usize = 0;
    let mut stack: Vec<usize> = Vec::new();
    let mut on_stack = vec![false; n];
    let mut indices = vec![usize::MAX; n]; // usize::MAX = undefined
    let mut lowlinks = vec![0usize; n];
    let mut in_cycle: HashSet<String> = HashSet::new();

    // Iterative Tarjan's to avoid stack overflow on deep graphs
    // Each frame: (node, edge_index, is_root_call)
    let mut call_stack: Vec<(usize, usize, bool)> = Vec::new();

    for start in 0..n {
        if indices[start] != usize::MAX {
            continue;
        }
        call_stack.push((start, 0, true));

        while let Some((v, ei, is_init)) = call_stack.last_mut() {
            let v = *v;
            if *is_init {
                indices[v] = index_counter;
                lowlinks[v] = index_counter;
                index_counter += 1;
                stack.push(v);
                on_stack[v] = true;
                *is_init = false;
            }

            let neighbors: Vec<usize> = edges
                .get(&nodes[v])
                .map(|deps| {
                    deps.iter()
                        .filter_map(|d| node_index.get(d.as_str()).copied())
                        .collect()
                })
                .unwrap_or_default();

            let ei_val = *ei;
            if ei_val < neighbors.len() {
                let w = neighbors[ei_val];
                *ei = ei_val + 1; // advance edge pointer
                if indices[w] == usize::MAX {
                    call_stack.push((w, 0, true));
                    continue;
                } else if on_stack[w] {
                    lowlinks[v] = lowlinks[v].min(indices[w]);
                }
            } else {
                // All neighbors processed — check if v is an SCC root
                if lowlinks[v] == indices[v] {
                    let mut scc: Vec<usize> = Vec::new();
                    loop {
                        let w = stack.pop().unwrap();
                        on_stack[w] = false;
                        scc.push(w);
                        if w == v {
                            break;
                        }
                    }
                    if scc.len() > 1 {
                        for &idx in &scc {
                            in_cycle.insert(nodes[idx].clone());
                        }
                    }
                }
                let finished_low = lowlinks[v];
                call_stack.pop();
                // Update parent's lowlink
                if let Some((parent, _, _)) = call_stack.last() {
                    lowlinks[*parent] = lowlinks[*parent].min(finished_low);
                }
            }
        }
    }

    // Return in deterministic order
    let mut result: Vec<String> = in_cycle.into_iter().collect();
    result.sort();
    result
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Generate runtime helper functions for Excel lookups and other functions
/// that the transpiler emits as _fn() calls.
fn generate_runtime_helpers() -> String {
    r#"// ── Runtime helpers ──
function _index(arr, rowNum, colNum) {
  if (arr == null) return 0;
  if (!Array.isArray(arr)) return arr;
  const r = +rowNum || 0;
  const c = +colNum || 0;
  // If row=0, return entire column (as array) for use in MATCH etc.
  if (r === 0) return arr;
  const idx = r - 1;
  if (idx < 0 || idx >= arr.length) return 0;
  const row = arr[idx];
  // 2D: if element is itself an array, use colNum
  if (Array.isArray(row)) {
    const ci = (c || 1) - 1;
    return row[ci] ?? 0;
  }
  return row ?? 0;
}

function _match(val, arr, matchType) {
  if (!Array.isArray(arr)) return 0;
  const mt = matchType === undefined ? 1 : +matchType;
  // Exact match (mt === 0)
  if (mt === 0) {
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] === val || (typeof arr[i] === 'number' && typeof val === 'number' && Math.abs(arr[i] - val) < 1e-10)) {
        return i + 1;
      }
      // String wildcard / case-insensitive
      if (typeof arr[i] === 'string' && typeof val === 'string' && arr[i].toLowerCase() === val.toLowerCase()) {
        return i + 1;
      }
    }
    return 0;
  }
  // Try exact match first for any match type
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === val || (typeof arr[i] === 'number' && typeof val === 'number' && Math.abs(arr[i] - val) < 1e-10)) {
      return i + 1;
    }
  }
  // Approximate match: mt=1 (default) sorted ascending → largest <= val
  if (mt === 1) {
    let best = -1;
    for (let i = 0; i < arr.length; i++) {
      if (typeof arr[i] === 'number' && typeof val === 'number' && arr[i] <= val) {
        best = i;
      }
    }
    return best >= 0 ? best + 1 : 0;
  }
  // mt=-1: sorted descending → smallest >= val
  if (mt === -1) {
    let best = -1;
    for (let i = 0; i < arr.length; i++) {
      if (typeof arr[i] === 'number' && typeof val === 'number' && arr[i] >= val) {
        best = i;
      }
    }
    return best >= 0 ? best + 1 : 0;
  }
  return 0;
}

function _vlookup(val, table, colIdx, exact) {
  if (!Array.isArray(table)) return 0;
  const ci = (+colIdx || 1) - 1;
  if (exact) {
    for (const row of table) {
      if (Array.isArray(row) && row[0] === val) return row[ci] ?? 0;
    }
    return 0;
  }
  // Approximate match: find last row where first col <= val (assumes sorted ascending)
  let best = -1;
  for (let i = 0; i < table.length; i++) {
    const row = table[i];
    if (Array.isArray(row) && typeof row[0] === 'number' && row[0] <= val) best = i;
  }
  return best >= 0 ? (table[best][ci] ?? 0) : 0;
}

function _hlookup(val, table, rowIdx, exact) {
  if (!Array.isArray(table) || table.length === 0) return 0;
  const firstRow = table[0];
  if (!Array.isArray(firstRow)) return 0;
  for (let c = 0; c < firstRow.length; c++) {
    if (firstRow[c] === val || (!exact && typeof firstRow[c] === 'number' && typeof val === 'number' && firstRow[c] <= val)) {
      const ri = (+rowIdx || 1) - 1;
      return table[ri]?.[c] ?? 0;
    }
  }
  return 0;
}

function _large(arr, k) {
  if (!Array.isArray(arr)) return 0;
  const sorted = arr.filter(v => typeof v === 'number').sort((a, b) => b - a);
  return sorted[(+k || 1) - 1] ?? 0;
}

function _small(arr, k) {
  if (!Array.isArray(arr)) return 0;
  const sorted = arr.filter(v => typeof v === 'number').sort((a, b) => a - b);
  return sorted[(+k || 1) - 1] ?? 0;
}

function _rank(val, arr, order) {
  if (!Array.isArray(arr)) return 0;
  const nums = arr.filter(v => typeof v === 'number');
  const sorted = order ? nums.sort((a, b) => a - b) : nums.sort((a, b) => b - a);
  for (let i = 0; i < sorted.length; i++) {
    if (Math.abs(sorted[i] - val) < 1e-10) return i + 1;
  }
  return 0;
}

function _fn(name, args) {
  // Fallback for unsupported functions
  return 0;
}

function _matchesCriteria(val, criteria) {
  if (criteria === undefined || criteria === null) return false;
  if (typeof criteria === 'number') return typeof val === 'number' && Math.abs(val - criteria) < 1e-10;
  if (typeof criteria === 'boolean') return val === criteria;
  const s = String(criteria);
  if (s.startsWith('>=')) return typeof val === 'number' && val >= +s.slice(2);
  if (s.startsWith('<=')) return typeof val === 'number' && val <= +s.slice(2);
  if (s.startsWith('<>')) { const cv = +s.slice(2); return isNaN(cv) ? String(val) !== s.slice(2) : val !== cv; }
  if (s.startsWith('>'))  return typeof val === 'number' && val > +s.slice(1);
  if (s.startsWith('<'))  return typeof val === 'number' && val < +s.slice(1);
  if (s.startsWith('='))  { const cv = +s.slice(1); return isNaN(cv) ? String(val) === s.slice(1) : typeof val === 'number' && Math.abs(val - cv) < 1e-10; }
  const n = +s;
  if (!isNaN(n)) return typeof val === 'number' && Math.abs(val - n) < 1e-10;
  return String(val).toLowerCase() === s.toLowerCase();
}

function _sumif(range, criteria, sumRange) {
  if (!Array.isArray(range)) return 0;
  const sr = Array.isArray(sumRange) ? sumRange : range;
  let total = 0;
  for (let i = 0; i < range.length; i++) {
    if (_matchesCriteria(range[i], criteria)) {
      total += (+sr[i] || 0);
    }
  }
  return total;
}

function _sumifs(sumRange, criteriaPairs) {
  if (!Array.isArray(sumRange)) return 0;
  let total = 0;
  for (let i = 0; i < sumRange.length; i++) {
    let allMatch = true;
    for (const [cr, cv] of criteriaPairs) {
      if (!Array.isArray(cr) || !_matchesCriteria(cr[i], cv)) { allMatch = false; break; }
    }
    if (allMatch) total += (+sumRange[i] || 0);
  }
  return total;
}

function _countif(range, criteria) {
  if (!Array.isArray(range)) return 0;
  let count = 0;
  for (let i = 0; i < range.length; i++) {
    if (_matchesCriteria(range[i], criteria)) count++;
  }
  return count;
}

function _countifs(criteriaPairs) {
  if (!Array.isArray(criteriaPairs) || criteriaPairs.length === 0) return 0;
  const len = Array.isArray(criteriaPairs[0][0]) ? criteriaPairs[0][0].length : 0;
  let count = 0;
  for (let i = 0; i < len; i++) {
    let allMatch = true;
    for (const [cr, cv] of criteriaPairs) {
      if (!Array.isArray(cr) || !_matchesCriteria(cr[i], cv)) { allMatch = false; break; }
    }
    if (allMatch) count++;
  }
  return count;
}

function _minifs(valueRange, criteriaPairs) {
  if (!Array.isArray(valueRange)) return 0;
  const matched = [];
  for (let i = 0; i < valueRange.length; i++) {
    let ok = true;
    for (const [cr, cv] of criteriaPairs) {
      if (!Array.isArray(cr) || !_matchesCriteria(cr[i], cv)) { ok = false; break; }
    }
    if (ok && typeof valueRange[i] === 'number' && isFinite(valueRange[i])) matched.push(valueRange[i]);
  }
  return matched.length ? Math.min(...matched) : 0; // Excel MINIFS: 0 when no match
}

function _maxifs(valueRange, criteriaPairs) {
  if (!Array.isArray(valueRange)) return 0;
  const matched = [];
  for (let i = 0; i < valueRange.length; i++) {
    let ok = true;
    for (const [cr, cv] of criteriaPairs) {
      if (!Array.isArray(cr) || !_matchesCriteria(cr[i], cv)) { ok = false; break; }
    }
    if (ok && typeof valueRange[i] === 'number' && isFinite(valueRange[i])) matched.push(valueRange[i]);
  }
  return matched.length ? Math.max(...matched) : 0; // Excel MAXIFS: 0 when no match
}

function _averageif(range, criteria, avgRange) {
  if (!Array.isArray(range)) return 0;
  if (!Array.isArray(avgRange)) avgRange = range;
  let sum = 0, n = 0;
  for (let i = 0; i < range.length; i++) {
    if (_matchesCriteria(range[i], criteria) && typeof avgRange[i] === 'number' && isFinite(avgRange[i])) { sum += avgRange[i]; n++; }
  }
  return n ? sum / n : 0; // Excel AVERAGEIF: #DIV/0! when no match; engine convention is 0
}

function _averageifs(valueRange, criteriaPairs) {
  if (!Array.isArray(valueRange)) return 0;
  let sum = 0, n = 0;
  for (let i = 0; i < valueRange.length; i++) {
    let ok = true;
    for (const [cr, cv] of criteriaPairs) {
      if (!Array.isArray(cr) || !_matchesCriteria(cr[i], cv)) { ok = false; break; }
    }
    if (ok && typeof valueRange[i] === 'number' && isFinite(valueRange[i])) { sum += valueRange[i]; n++; }
  }
  return n ? sum / n : 0; // Excel AVERAGEIFS: #DIV/0! when no match; engine convention is 0
}

function _filter(array, include, ifEmpty) {
  if (!Array.isArray(array)) return array;
  const arr = array.flat();
  const inc = Array.isArray(include) ? include.flat() : arr.map(() => include);
  const out = arr.filter((_, i) => { const f = inc[i]; return f === true || (typeof f === 'number' && f !== 0); });
  return out.length ? out : (ifEmpty !== undefined ? ifEmpty : 0);
}

// ── Date helpers (integer Excel day-serials; issue #47) ──
// Excel stores dates as integer day-serials (days since the 1899-12-30 epoch).
// EDATE/EOMONTH recurrences must stay on exact integers or downstream
// exact-equality SUMIFS/MINIFS date-key lookups miss (drift → 0 → x/0 → NaN).
// We round-trip through UTC midnight so DST never shifts the serial.
function _excelSerialFromYMD(y, m, d) {
  y = Math.trunc(+y); m = Math.trunc(+m); d = Math.trunc(+d);
  // Excel DATE normalises out-of-range month/day by rolling over (Date.UTC does too).
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

function _serialToYMD(serial) {
  // Inverse of _excelSerialFromYMD for normal modern dates (serial >= 61, i.e.
  // 1900-03-01 onward, where Excel's leap-year-1900 bug does not apply).
  const ms = Math.round(+serial) * 86400000 + Date.UTC(1899, 11, 30);
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function _daysInMonth(y, m) {
  // m is 1-based; day 0 of the next month is the last day of month m.
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function _edate(serial, months) {
  serial = Math.round(+serial || 0); months = Math.trunc(+months || 0);
  const { y, m, d } = _serialToYMD(serial);
  // Add months, normalising into a valid 1..12 month + year.
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1; // 1-based
  // Excel clamps the day to the last day of the target month (EDATE(Jan31,1)=Feb28/29).
  const nd = Math.min(d, _daysInMonth(ny, nm));
  return _excelSerialFromYMD(ny, nm, nd);
}

function _eomonth(serial, months) {
  serial = Math.round(+serial || 0); months = Math.trunc(+months || 0);
  const { y, m } = _serialToYMD(serial);
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1; // 1-based
  // Last day of the target month.
  return _excelSerialFromYMD(ny, nm, _daysInMonth(ny, nm));
}

function _colNum(col) {
  let n = 0;
  for (const ch of col) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}

function _numToCol(n) {
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

function _offset(ctx, refAddr, rowOffset, colOffset, height, width) {
  // refAddr is like "Sheet!A1"
  if (typeof refAddr !== 'string') return 0;
  const m = refAddr.match(/^(.+)!([A-Z]+)(\d+)$/);
  if (!m) return 0;
  const [, sheet, col, row] = m;
  const newRow = parseInt(row) + (+rowOffset || 0);
  const newCol = _colNum(col) + (+colOffset || 0);
  const h = +height || 1;
  const w = +width || 1;
  if (h === 1 && w === 1) {
    return ctx.get(`${sheet}!${_numToCol(newCol)}${newRow}`);
  }
  // Return array for multi-cell OFFSET
  const result = [];
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      result.push(ctx.get(`${sheet}!${_numToCol(newCol + c)}${newRow + r}`));
    }
  }
  return result;
}

// ── Financial functions ──
function computeNPV(rate, cashflows) {
  if (!Array.isArray(cashflows)) return 0;
  return cashflows.reduce((acc, cf, i) => acc + (+cf || 0) / Math.pow(1 + rate, i + 1), 0);
}

function computeIRR(cashflows, guess) {
  if (!Array.isArray(cashflows)) return 0;
  const cfs = cashflows.map(v => +v || 0);
  let r = guess !== undefined ? +guess : 0.1;
  for (let i = 0; i < 200; i++) {
    let npv = 0, dnpv = 0;
    for (let t = 0; t < cfs.length; t++) {
      const d = Math.pow(1 + r, t);
      npv += cfs[t] / d;
      dnpv -= t * cfs[t] / (d * (1 + r));
    }
    if (Math.abs(dnpv) < 1e-15) break;
    const dr = npv / dnpv;
    r -= dr;
    if (Math.abs(dr) < 1e-10 && Math.abs(npv) < 1e-8) break;
  }
  return isFinite(r) ? r : 0;
}

function computeXIRR(cashflows, dates, guess) {
  if (!Array.isArray(cashflows) || !Array.isArray(dates)) return 0;
  const cfs = cashflows.map(v => +v || 0);
  const ds = dates.map(d => typeof d === 'number' ? d : Date.parse(d) / 86400000 + 25569);
  const d0 = ds[0];
  let r = guess !== undefined ? +guess : 0.1;
  for (let i = 0; i < 200; i++) {
    let f = 0, df = 0;
    for (let t = 0; t < cfs.length; t++) {
      const years = (ds[t] - d0) / 365.25;
      const disc = Math.pow(1 + r, years);
      f += cfs[t] / disc;
      df -= years * cfs[t] / (disc * (1 + r));
    }
    if (Math.abs(df) < 1e-15) break;
    const dr = f / df;
    r -= dr;
    if (Math.abs(dr) < 1e-10 && Math.abs(f) < 1e-8) break;
  }
  return isFinite(r) ? r : 0;
}

function computeXNPV(rate, cashflows, dates) {
  if (!Array.isArray(cashflows) || !Array.isArray(dates)) return 0;
  const cfs = cashflows.flat().map(v => +v || 0);
  const ds = dates.flat().map(d => typeof d === 'number' ? d : Date.parse(d) / 86400000 + 25569);
  const d0 = ds[0];
  let npv = 0;
  for (let t = 0; t < cfs.length; t++) {
    const years = (ds[t] - d0) / 365; // Excel XNPV uses a 365-day basis
    npv += cfs[t] / Math.pow(1 + rate, years);
  }
  return npv;
}

function computePMT(rate, nper, pv) {
  rate = +rate || 0; nper = +nper || 0; pv = +pv || 0;
  if (rate === 0) return nper === 0 ? 0 : -pv / nper;
  return -pv * rate * Math.pow(1 + rate, nper) / (Math.pow(1 + rate, nper) - 1);
}

function computePV(rate, nper, pmt) {
  rate = +rate || 0; nper = +nper || 0; pmt = +pmt || 0;
  if (rate === 0) return -pmt * nper;
  return -pmt * (1 - Math.pow(1 + rate, -nper)) / rate;
}

function computeFV(rate, nper, pmt) {
  rate = +rate || 0; nper = +nper || 0; pmt = +pmt || 0;
  if (rate === 0) return -pmt * nper;
  return -pmt * (Math.pow(1 + rate, nper) - 1) / rate;
}

function computeRATE(nper, pmt, pv) {
  nper = +nper || 0; pmt = +pmt || 0; pv = +pv || 0;
  let r = 0.1;
  for (let i = 0; i < 100; i++) {
    const f = pv * Math.pow(1+r, nper) + pmt * (Math.pow(1+r, nper) - 1) / r;
    const df = nper * pv * Math.pow(1+r, nper-1) + pmt * (nper * Math.pow(1+r, nper-1) * r - Math.pow(1+r, nper) + 1) / (r * r);
    if (Math.abs(df) < 1e-15) break;
    const dr = -f / df;
    r += dr;
    if (Math.abs(dr) < 1e-10) break;
  }
  return isFinite(r) ? r : 0;
}

function computeNPER(rate, pmt, pv) {
  rate = +rate || 0; pmt = +pmt || 0; pv = +pv || 0;
  if (rate === 0) return pmt === 0 ? 0 : -pv / pmt;
  return Math.log(-pmt / (pmt + pv * rate)) / Math.log(1 + rate);
}"#
    .to_string()
}

/// Generate the shared `_helpers.mjs` module with exported runtime helpers.
fn generate_helpers_module() -> String {
    // Re-use the same helper code but prefix each function with `export`
    let raw = generate_runtime_helpers();
    let mut out = String::with_capacity(raw.len() + 256);
    out.push_str("// _helpers.mjs — Shared runtime helpers for chunked sheet modules\n");
    out.push_str("// AUTO-GENERATED by rust-parser — do not edit manually.\n\n");
    for line in raw.lines() {
        if line.starts_with("function ") {
            out.push_str("export ");
            out.push_str(line);
        } else if line.starts_with("// ── Runtime helpers") {
            // Skip the old section header
            continue;
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    out
}

fn cell_value_to_js(value: &Option<CellValue>) -> String {
    match value {
        Some(CellValue::Number(n)) => {
            if *n == n.floor() && n.abs() < 1e15 {
                format!("{}", *n as i64)
            } else {
                format!("{}", n)
            }
        }
        // SECURITY: Escape ${ to prevent template literal injection (VULN-1)
        Some(CellValue::Text(s)) => format!("`{}`",
            s.replace('\\', "\\\\")
             .replace('`', "\\`")
             .replace("${", "\\${")
        ),
        Some(CellValue::Bool(b)) => b.to_string(),
        Some(CellValue::Error(e)) => format!("/* {} */ null", e),
        Some(CellValue::Empty) | None => "null".to_string(),
    }
}

fn sanitize_sheet_name(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect()
}

fn escape_js_string(s: &str) -> String {
    s.replace('\\', "\\\\")
     .replace('"', "\\\"")
     .replace('\n', "\\n")
     .replace('\r', "\\r")
     .replace('\t', "\\t")
     .replace("${", "\\${")
}

fn human_size(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.2} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::{CellData, CellValue, SheetData, WorkbookData};

    fn make_cell(
        row: u32,
        col: u32,
        addr: &str,
        val: Option<CellValue>,
        formula: Option<&str>,
    ) -> CellData {
        CellData {
            row,
            col,
            address: addr.to_string(),
            value: val,
            formula: formula.map(|s| s.to_string()),
        }
    }

    fn make_test_workbook() -> WorkbookData {
        let assumptions = SheetData {
            name: "Assumptions".to_string(),
            cells: vec![
                make_cell(0, 0, "A1", Some(CellValue::Text("Revenue".into())), None),
                make_cell(0, 1, "B1", Some(CellValue::Number(1000000.0)), None),
                make_cell(1, 1, "B2", Some(CellValue::Number(0.5)), None),
            ],
            row_count: 2,
            col_count: 2,
            formula_cells: vec![],
        };

        let cashflows = SheetData {
            name: "Cashflows".to_string(),
            cells: vec![
                make_cell(0, 1, "B1", Some(CellValue::Number(1000000.0)), Some("Assumptions!B1")),
                make_cell(1, 1, "B2", Some(CellValue::Number(500000.0)), Some("B1*Assumptions!B2")),
            ],
            row_count: 2,
            col_count: 2,
            formula_cells: vec!["B1".to_string(), "B2".to_string()],
        };

        let summary = SheetData {
            name: "Summary".to_string(),
            cells: vec![
                make_cell(0, 1, "B1", Some(CellValue::Number(1000000.0)), Some("Cashflows!B1")),
            ],
            row_count: 1,
            col_count: 2,
            formula_cells: vec!["B1".to_string()],
        };

        WorkbookData {
            sheet_names: vec!["Assumptions".into(), "Cashflows".into(), "Summary".into()],
            sheets: vec![assumptions, cashflows, summary],
            total_cells: 6,
            total_formula_cells: 3,
        }
    }

    /// Test convenience: capture `write_sheet_module`'s streamed output as a
    /// String. Production code streams straight to the file (issue #33) — this
    /// just lets the assertions inspect the generated module in memory.
    fn generate_sheet_module(partition: &SheetPartition<'_>, _workbook: &WorkbookData) -> String {
        let mut buf: Vec<u8> = Vec::new();
        write_sheet_module(partition, &mut buf).expect("writing to a Vec never fails");
        String::from_utf8(buf).expect("generated module must be valid UTF-8")
    }

    #[test]
    fn test_generate_sheet_module_has_correct_exports() {
        let wb = make_test_workbook();
        let partitions = partition_sheets(&wb);
        let code = generate_sheet_module(&partitions[1], &wb); // Cashflows

        assert!(code.contains("export const SHEET_NAME = \"Cashflows\";"));
        assert!(code.contains("export const SHEET_DEPENDENCIES = [\"Assumptions\"];"));
        assert!(code.contains("export function compute(ctx)"));
        assert!(code.contains("ctx.set(\"Cashflows!B1\""));
        assert!(code.contains("ctx.set(\"Cashflows!B2\""));
    }

    #[test]
    fn test_generate_sheet_module_uses_ctx_get() {
        let wb = make_test_workbook();
        let partitions = partition_sheets(&wb);
        let code = generate_sheet_module(&partitions[1], &wb); // Cashflows

        // Cross-sheet references should use ctx.get()
        assert!(
            code.contains("ctx.get(\"Assumptions!B1\")") || code.contains("ctx.get(\"Assumptions!B2\")"),
            "Should contain ctx.get() for cross-sheet refs. Code:\n{}",
            code
        );
    }

    #[test]
    fn test_extract_cell_addr_from_var() {
        assert_eq!(extract_cell_addr_from_var("Sheet1_A1"), Some("A1".to_string()));
        assert_eq!(extract_cell_addr_from_var("My_Sheet_B12"), Some("B12".to_string()));
        assert_eq!(extract_cell_addr_from_var("X_AA100"), Some("AA100".to_string()));
        assert_eq!(extract_cell_addr_from_var(""), None);
        assert_eq!(extract_cell_addr_from_var("nope"), None);
    }

    #[test]
    fn test_convert_vars_to_ctx_get() {
        let input = "s_Sheet1_A1 + s_Sheet1_B2 * 2";
        let output = convert_vars_to_ctx_get(input, "Sheet1");
        assert!(output.contains("ctx.get(\"Sheet1!A1\")"), "Got: {}", output);
        assert!(output.contains("ctx.get(\"Sheet1!B2\")"), "Got: {}", output);
    }

    #[test]
    fn test_orchestrator_has_imports_and_run() {
        let wb = make_test_workbook();
        let partitions = partition_sheets(&wb);
        let graph = build_sheet_graph(&partitions).unwrap();
        let code = generate_orchestrator(&graph, &partitions);

        assert!(code.contains("import {"), "Should have imports");
        assert!(code.contains("export function run("), "Should have run()");
        assert!(code.contains("TOPO_ORDER"), "Should have topo order");
        assert!(code.contains("class ComputeContext"), "Should have context class");
    }

    #[test]
    fn test_cell_value_to_js() {
        assert_eq!(cell_value_to_js(&Some(CellValue::Number(42.0))), "42");
        assert_eq!(cell_value_to_js(&Some(CellValue::Number(3.14))), "3.14");
        assert_eq!(cell_value_to_js(&Some(CellValue::Bool(true))), "true");
        assert_eq!(cell_value_to_js(&Some(CellValue::Text("hello".into()))), "`hello`");
        assert_eq!(cell_value_to_js(&None), "null");
    }

    #[test]
    fn test_sanitize_sheet_name() {
        assert_eq!(sanitize_sheet_name("Sheet1"), "Sheet1");
        assert_eq!(sanitize_sheet_name("Cash Flow"), "Cash_Flow");
        assert_eq!(sanitize_sheet_name("P&L (2024)"), "P_L__2024_");
    }
}

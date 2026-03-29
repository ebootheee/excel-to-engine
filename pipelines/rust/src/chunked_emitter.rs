/// Chunked emitter — generates per-sheet `.mjs` modules, `_graph.json`,
/// `_ground-truth.json`, and `engine.js` orchestrator.
///
/// This implements **Option C: Chunked Compilation** from PLAN-rust-pipeline.md.

use crate::dependency::extract_refs;
use crate::formula_ast::parse_formula;
use crate::parser::{CellValue, WorkbookData};
use crate::sheet_partition::{
    build_sheet_graph, extract_ground_truth, partition_sheets, SheetGraph, SheetPartition,
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
pub fn emit_chunked(workbook: &WorkbookData, output_dir: &Path) -> Result<String, String> {
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

    // 1. Emit per-sheet modules (parallel via rayon)
    let total_sheets = partitions.len();
    eprintln!("[chunked] Emitting {} sheet modules (parallel)...", total_sheets);
    let t_emit = Instant::now();

    let completed = AtomicUsize::new(0);

    // Generate all modules in parallel
    let sheet_results: Vec<(String, String, String, usize, usize, usize)> = partitions
        .par_iter()
        .map(|partition| {
            let code = generate_sheet_module(partition, &workbook);
            let safe_name = sanitize_sheet_name(&partition.name);
            let file_name = format!("{}.mjs", safe_name);
            let code_len = code.len();
            let n_formulas = partition.formula_cells.len();
            let n_inputs = partition.input_cells.len();

            let done = completed.fetch_add(1, Ordering::Relaxed) + 1;
            if done % 5 == 0 || done == total_sheets {
                eprint!(
                    "\r[chunked]   [{}/{}] generating modules...",
                    done, total_sheets
                );
                std::io::stderr().flush().ok();
            }

            (partition.name.clone(), file_name, code, n_formulas, n_inputs, code_len)
        })
        .collect();

    eprintln!(); // newline after progress

    // Write files sequentially (fast — just I/O)
    let mut sheet_files: Vec<String> = Vec::new();
    let mut total_formulas_emitted: usize = 0;
    let mut total_bytes_emitted: usize = 0;
    for (sheet_name, file_name, code, n_formulas, n_inputs, code_len) in &sheet_results {
        let file_path = sheets_dir.join(file_name);
        fs::write(&file_path, code)
            .map_err(|e| format!("Failed to write {}: {}", file_name, e))?;
        sheet_files.push(file_name.clone());
        total_formulas_emitted += n_formulas;
        total_bytes_emitted += code_len;
    }

    eprintln!(
        "[chunked] All {} sheet modules emitted in {:.1}s ({} formulas, {})",
        total_sheets,
        t_emit.elapsed().as_secs_f64(),
        total_formulas_emitted,
        human_size(total_bytes_emitted)
    );

    // 2. Emit _graph.json
    eprint!("[chunked] Writing _graph.json...");
    std::io::stderr().flush().ok();
    let graph_json = serde_json::to_string_pretty(&sheet_graph)
        .map_err(|e| format!("Failed to serialize graph: {}", e))?;
    fs::write(output_dir.join("_graph.json"), &graph_json)
        .map_err(|e| format!("Failed to write _graph.json: {}", e))?;
    eprintln!(" done ({})", human_size(graph_json.len()));

    // 3. Emit _ground-truth.json
    eprint!("[chunked] Extracting ground truth...");
    std::io::stderr().flush().ok();
    let t0 = Instant::now();
    let ground_truth = extract_ground_truth(workbook);
    let gt_json = serde_json::to_string_pretty(&ground_truth)
        .map_err(|e| format!("Failed to serialize ground truth: {}", e))?;
    fs::write(output_dir.join("_ground-truth.json"), &gt_json)
        .map_err(|e| format!("Failed to write _ground-truth.json: {}", e))?;
    eprintln!(
        " done — {} entries ({}) in {}ms",
        ground_truth.len(),
        human_size(gt_json.len()),
        t0.elapsed().as_millis()
    );

    // 4. Emit engine.js orchestrator
    eprint!("[chunked] Writing engine.js orchestrator...");
    std::io::stderr().flush().ok();
    let engine_js = generate_orchestrator(&sheet_graph, &partitions);
    fs::write(output_dir.join("engine.js"), &engine_js)
        .map_err(|e| format!("Failed to write engine.js: {}", e))?;
    eprintln!(" done ({})", human_size(engine_js.len()));

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

/// Generate the JavaScript module code for a single sheet.
fn generate_sheet_module(partition: &SheetPartition, _workbook: &WorkbookData) -> String {
    let mut lines: Vec<String> = Vec::new();
    let sheet_name = &partition.name;

    // Header
    lines.push(format!(
        "// sheets/{}.mjs — AUTO-GENERATED by rust-parser (chunked mode)",
        sanitize_sheet_name(sheet_name)
    ));
    lines.push("// Do not edit manually — re-run the pipeline to regenerate.".to_string());
    lines.push(String::new());

    // Exports: SHEET_NAME, SHEET_DEPENDENCIES
    lines.push(format!(
        "export const SHEET_NAME = \"{}\";",
        escape_js_string(sheet_name)
    ));

    let deps_arr: Vec<String> = partition
        .sheet_dependencies
        .iter()
        .map(|d| format!("\"{}\"", escape_js_string(d)))
        .collect();
    lines.push(format!(
        "export const SHEET_DEPENDENCIES = [{}];",
        deps_arr.join(", ")
    ));
    lines.push(String::new());

    // Runtime helpers for Excel functions — import from shared module
    lines.push("import { _index, _match, _vlookup, _hlookup, _large, _small, _rank, _fn, _sumif, _sumifs, _countif, _countifs, _offset, _matchesCriteria, _colNum, _numToCol, computeNPV, computeIRR, computeXIRR, computePMT, computePV, computeFV, computeRATE, computeNPER } from './_helpers.mjs';".to_string());
    lines.push(String::new());

    // compute(ctx) function
    lines.push("/**".to_string());
    lines.push(format!(
        " * Compute all cells for sheet \"{}\".",
        escape_js_string(sheet_name)
    ));
    lines.push(" * @param {{Object}} ctx - Context with get(addr), set(addr, val), values map".to_string());
    lines.push(" */".to_string());
    lines.push("export function compute(ctx) {".to_string());

    // Phase 1: input/literal cells
    if !partition.input_cells.is_empty() {
        lines.push("  // ── Literal / input cells ──".to_string());
        for cell in &partition.input_cells {
            let qualified = format!("{}!{}", sheet_name, cell.address);
            let val_js = cell_value_to_js(&cell.value);
            lines.push(format!("  ctx.set(\"{}\", {});", qualified, val_js));
        }
        lines.push(String::new());
    }

    // Phase 2: formula cells — detect intra-sheet cycles and wrap in convergence loops
    if !partition.formula_cells.is_empty() {
        let config = TranspileConfig {
            default_sheet: sheet_name.clone(),
            use_flat_vars: false,
            use_ctx_get: true,
        };

        // Build per-cell transpiled expressions
        let mut cell_exprs: Vec<(String, String)> = Vec::new(); // (qualified_addr, js_expr)
        for cell in &partition.formula_cells {
            if let Some(formula) = &cell.formula {
                let qualified = format!("{}!{}", sheet_name, cell.address);
                let js_expr = match parse_formula(formula) {
                    Some(ast) => transpile(&ast, &config),
                    None => format!("/* parse error: {} */ 0", escape_js_string(formula)),
                };
                cell_exprs.push((qualified, js_expr));
            }
        }

        // Detect intra-sheet circular references
        let circular_cells = detect_intra_sheet_cycles(partition, sheet_name);

        if circular_cells.is_empty() {
            // No cycles — emit linearly
            lines.push("  // ── Formula cells ──".to_string());
            for (addr, expr) in &cell_exprs {
                lines.push(format!("  ctx.set(\"{}\", {});", addr, expr));
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
                lines.push("  // ── Formula cells (pre-cycle) ──".to_string());
                for (addr, expr) in &pre {
                    lines.push(format!("  ctx.set(\"{}\", {});", addr, expr));
                }
                lines.push(String::new());
            }

            // Convergence loop for circular cells
            lines.push(format!(
                "  // ── Convergence loop ({} circular cells) ──",
                cycle.len()
            ));
            lines.push("  const _maxIter = 200;".to_string());
            lines.push("  const _tol = 1e-6;".to_string());
            lines.push("  let _staleCount = 0;".to_string());
            lines.push("  let _prevDelta = Infinity;".to_string());
            lines.push("  for (let _ci = 0; _ci < _maxIter; _ci++) {".to_string());

            // Save previous values of cycle cells
            let cycle_addrs: Vec<String> = cycle.iter().map(|(a, _)| a.clone()).collect();
            lines.push(format!(
                "    const _prev = [{}];",
                cycle_addrs
                    .iter()
                    .map(|a| format!("ctx.get(\"{}\")", a))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));

            // Re-evaluate all cycle cells
            for (addr, expr) in &cycle {
                lines.push(format!("    ctx.set(\"{}\", {});", addr, expr));
            }

            // Also re-evaluate non-cycle cells between the cycle cells that depend on cycle outputs
            let non_cycle_in_range: Vec<&(String, String)> = cell_exprs
                .iter()
                .skip(pre.len())
                .take(last_cycle_idx + 1 - pre.len())
                .filter(|(addr, _)| !cycle_set.contains(addr))
                .collect();
            for (addr, expr) in &non_cycle_in_range {
                lines.push(format!("    ctx.set(\"{}\", {});", addr, expr));
            }

            // Convergence check
            lines.push(format!(
                "    const _curr = [{}];",
                cycle_addrs
                    .iter()
                    .map(|a| format!("ctx.get(\"{}\")", a))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
            lines.push(
                "    const _delta = _prev.reduce((mx, v, i) => Math.max(mx, Math.abs(v - (_curr[i] || 0))), 0);"
                    .to_string(),
            );
            lines.push("    if (_delta < _tol) break;".to_string());
            lines.push(
                "    _staleCount = (Math.abs(_delta - _prevDelta) < _tol * 0.01) ? _staleCount + 1 : 0;"
                    .to_string(),
            );
            lines.push("    if (_staleCount >= 5) break; // stale — values stopped improving".to_string());
            lines.push("    _prevDelta = _delta;".to_string());
            lines.push("  }".to_string());

            if !post.is_empty() {
                lines.push(String::new());
                lines.push("  // ── Formula cells (post-cycle) ──".to_string());
                for (addr, expr) in &post {
                    lines.push(format!("  ctx.set(\"{}\", {});", addr, expr));
                }
            }
        }
    }

    lines.push("}".to_string());
    lines.push(String::new());

    lines.join("\n")
}

/// Convert flat variable references (s_SheetName_A1) to ctx.get("SheetName!A1") calls.
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

fn generate_orchestrator(graph: &SheetGraph, _partitions: &[SheetPartition]) -> String {
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

    // Sheet clusters (circular dependency groups that need convergence loops)
    if !graph.sheet_clusters.is_empty() {
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
    }

    // run() function
    lines.push("/**".to_string());
    lines.push(" * Execute the full model.".to_string());
    lines.push(" * @param {Object} [inputs] - Optional overrides: { \"Sheet!A1\": value, ... }".to_string());
    lines.push(" * @returns {{ values: Object, kpis: Object }}".to_string());
    lines.push(" */".to_string());
    lines.push("export function run(inputs = {}) {".to_string());
    lines.push("  const ctx = new ComputeContext();".to_string());
    lines.push(String::new());
    lines.push("  // Apply input overrides".to_string());
    lines.push("  for (const [addr, val] of Object.entries(inputs)) {".to_string());
    lines.push("    ctx.set(addr, val);".to_string());
    lines.push("  }".to_string());
    lines.push(String::new());

    if graph.sheet_clusters.is_empty() {
        // Simple case: no circular deps, just execute in topo order
        lines.push("  // Execute sheets in topological order".to_string());
        lines.push("  for (const sheetName of TOPO_ORDER) {".to_string());
        lines.push("    const computeFn = SHEET_COMPUTE[sheetName];".to_string());
        lines.push("    if (computeFn) computeFn(ctx);".to_string());
        lines.push("  }".to_string());
    } else {
        // Complex case: execute with convergence loops for clusters
        lines.push("  // Execute sheets in topological order with convergence loops for circular deps".to_string());
        lines.push("  const MAX_ITER = 200;".to_string());
        lines.push("  const TOL = 1e-6;".to_string());
        lines.push("  const executed = new Set();".to_string());
        lines.push(String::new());
        lines.push("  for (const sheetName of TOPO_ORDER) {".to_string());
        lines.push("    if (executed.has(sheetName)) continue;".to_string());
        lines.push(String::new());
        lines.push("    // Check if this sheet is part of a cluster".to_string());
        lines.push("    if (CLUSTER_SHEETS.has(sheetName)) {".to_string());
        lines.push("      const cluster = SHEET_CLUSTERS.find(c => c.includes(sheetName));".to_string());
        lines.push("      if (cluster && !cluster.some(s => executed.has(s))) {".to_string());
        lines.push("        // Run the entire cluster in a convergence loop".to_string());
        lines.push("        let _prevClusterDelta = Infinity, _clusterStale = 0;".to_string());
        lines.push("        for (let iter = 0; iter < MAX_ITER; iter++) {".to_string());
        lines.push("          const snapshot = JSON.stringify(ctx.values);".to_string());
        lines.push("          for (const s of cluster) {".to_string());
        lines.push("            const fn = SHEET_COMPUTE[s];".to_string());
        lines.push("            if (fn) fn(ctx);".to_string());
        lines.push("          }".to_string());
        lines.push("          // Check convergence".to_string());
        lines.push("          const after = ctx.values;".to_string());
        lines.push("          const before = JSON.parse(snapshot);".to_string());
        lines.push("          let maxDelta = 0;".to_string());
        lines.push("          for (const key in after) {".to_string());
        lines.push("            if (typeof after[key] === 'number' && typeof before[key] === 'number') {".to_string());
        lines.push("              maxDelta = Math.max(maxDelta, Math.abs(after[key] - before[key]));".to_string());
        lines.push("            }".to_string());
        lines.push("          }".to_string());
        lines.push("          if (maxDelta < TOL) break;".to_string());
        lines.push("          _clusterStale = (Math.abs(maxDelta - _prevClusterDelta) < TOL * 0.01) ? _clusterStale + 1 : 0;".to_string());
        lines.push("          if (_clusterStale >= 5) break; // stale — values stopped improving".to_string());
        lines.push("          _prevClusterDelta = maxDelta;".to_string());
        lines.push("        }".to_string());
        lines.push("        for (const s of cluster) executed.add(s);".to_string());
        lines.push("      }".to_string());
        lines.push("    } else {".to_string());
        lines.push("      const computeFn = SHEET_COMPUTE[sheetName];".to_string());
        lines.push("      if (computeFn) computeFn(ctx);".to_string());
        lines.push("      executed.add(sheetName);".to_string());
        lines.push("    }".to_string());
        lines.push("  }".to_string());
    }

    lines.push(String::new());
    lines.push("  return {".to_string());
    lines.push("    values: { ...ctx.values },".to_string());
    lines.push("    kpis: ctx.kpis(),".to_string());
    lines.push("  };".to_string());
    lines.push("}".to_string());
    lines.push(String::new());

    // Default export
    lines.push("export default { run };".to_string());
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
   * Set a cell value by qualified address.
   */
  set(addr, value) {
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

/// Detect cells within a single sheet that form circular references.
/// Returns the set of qualified addresses involved in cycles.
fn detect_intra_sheet_cycles(partition: &SheetPartition, sheet_name: &str) -> Vec<String> {
    // Build intra-sheet dependency graph
    let mut edges: HashMap<String, Vec<String>> = HashMap::new();
    let mut all_addrs: HashSet<String> = HashSet::new();

    for cell in &partition.formula_cells {
        if let Some(formula) = &cell.formula {
            let qualified = format!("{}!{}", sheet_name, cell.address);
            all_addrs.insert(qualified.clone());

            let refs = extract_refs(formula, sheet_name);
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
                let finished_v = v;
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
        Some(CellValue::Text(s)) => format!("`{}`", s.replace('\\', "\\\\").replace('`', "\\`")),
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
    s.replace('\\', "\\\\").replace('"', "\\\"")
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

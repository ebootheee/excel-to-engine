mod chunked_emitter;
mod circular;
mod dependency;
mod formula_ast;
mod model_map;
mod parser;
mod sheet_partition;
mod transpiler;

use dependency::build_graph;
use model_map::{build_formulas_json, generate_raw_engine, FormulaEntry};
use parser::{build_model_map, parse_workbook};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::Path;
use std::time::Instant;

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        eprintln!("Usage: rust-parser <input.xlsx> [output_dir] [--compact] [--chunked]");
        eprintln!("");
        eprintln!("Outputs (written to output_dir or current directory):");
        eprintln!("  model-map.json        -- Sheet/cell metadata (v1.1.0 schema)");
        eprintln!("  formulas.json         -- All formula cells with transpiled JS");
        eprintln!("  dependency-graph.json -- Cell dependency DAG + cycle detection");
        eprintln!("  raw-engine.js         -- Auto-generated computation engine");
        eprintln!("");
        eprintln!("Options:");
        eprintln!("  --compact  Auto-enabled for large workbooks (>50K cells).");
        eprintln!("             Skips raw numeric/text cell dumps in model-map.json,");
        eprintln!("             uses compact JSON, and filters engine to referenced cells only.");
        eprintln!("  --chunked  Emit chunked output (Option C): per-sheet .mjs modules,");
        eprintln!("             _graph.json, _ground-truth.json, and engine.js orchestrator.");
        std::process::exit(1);
    }

    let compact_flag = args.iter().any(|a| a == "--compact");
    let chunked_flag = args.iter().any(|a| a == "--chunked");

    // Filter out flags from positional args
    let positional: Vec<&String> = args.iter().skip(1).filter(|a| !a.starts_with("--")).collect();

    let input_path = Path::new(positional[0]);
    let output_dir = if positional.len() >= 2 {
        Path::new(positional[1]).to_path_buf()
    } else {
        std::env::current_dir().unwrap()
    };

    if !input_path.exists() {
        eprintln!("Error: file not found: {}", input_path.display());
        std::process::exit(1);
    }

    fs::create_dir_all(&output_dir).expect("Failed to create output directory");

    let source_name = input_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown.xlsx".to_string());

    // Phase 1: Parse workbook
    let t0 = Instant::now();
    println!("[rust-parser] Parsing: {}", input_path.display());

    let workbook = match parse_workbook(input_path) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("Parse error: {}", e);
            std::process::exit(1);
        }
    };

    // Auto-enable compact mode for large workbooks
    let compact = compact_flag || workbook.total_cells > 50_000;
    if compact && !compact_flag {
        println!(
            "[rust-parser] Auto-enabling compact mode ({} cells > 50K threshold)",
            workbook.total_cells
        );
    }

    println!(
        "[rust-parser] Parsed {} sheets, {} cells, {} formula cells in {}ms{}",
        workbook.sheets.len(),
        workbook.total_cells,
        workbook.total_formula_cells,
        t0.elapsed().as_millis(),
        if compact { " [compact]" } else { "" }
    );

    // Phase 2: Build model-map.json
    let t1 = Instant::now();
    let model_map = build_model_map(&workbook, &source_name);
    let model_map_json = if compact {
        // In compact mode, write a slim version: stats + sheet summaries only (no raw cell dumps)
        let slim = serde_json::json!({
            "version": model_map.version,
            "source": model_map.source,
            "stats": model_map.stats,
            "sheets": model_map.sheets.iter().map(|s| serde_json::json!({
                "name": s.name,
                "row_count": s.row_count,
                "col_count": s.col_count,
                "cell_count": s.cell_count,
                "formula_count": s.formula_count,
                // Only include formula cells (not raw numeric/text) in compact mode
                "formula_cells": s.formula_cells,
            })).collect::<Vec<_>>()
        });
        serde_json::to_string(&slim).expect("JSON serialization failed")
    } else {
        serde_json::to_string_pretty(&model_map).expect("JSON serialization failed")
    };
    let model_map_path = output_dir.join("model-map.json");
    fs::write(&model_map_path, &model_map_json).expect("Failed to write model-map.json");
    println!(
        "[rust-parser] model-map.json written in {}ms ({})",
        t1.elapsed().as_millis(),
        human_size(model_map_json.len())
    );

    // Phase 3: Build formulas.json (parse + transpile all formulas)
    let t2 = Instant::now();
    let formula_entries = build_formulas_json(&workbook);
    let total_formulas = formula_entries.len();
    let parse_errors = formula_entries
        .iter()
        .filter(|e| e.parse_error.is_some())
        .count();
    let formulas_path = output_dir.join("formulas.json");
    let formulas_written_size: usize;
    if compact && total_formulas > 50_000 {
        // For large models, write TWO files:
        // 1. ground-truth.json: just {address: value} pairs for the eval loop (~20-50MB vs 5GB)
        // 2. formulas.json: compact metadata only (stats + error sample, no full entries)

        let mut gt_map = serde_json::Map::new();
        let mut gt_count = 0usize;
        for e in &formula_entries {
            if let Some(val) = e.excel_result {
                gt_map.insert(
                    e.qualified_address.clone(),
                    serde_json::Value::Number(
                        serde_json::Number::from_f64(val).unwrap_or(serde_json::Number::from(0))
                    ),
                );
                gt_count += 1;
            }
        }
        let gt_json = serde_json::to_string(&gt_map).expect("JSON serialization failed");
        let gt_path = output_dir.join("ground-truth.json");
        fs::write(&gt_path, &gt_json).expect("Failed to write ground-truth.json");
        println!(
            "[rust-parser] ground-truth.json: {} values ({})",
            gt_count, human_size(gt_json.len())
        );

        // Write a slim formulas.json with just stats + error sample
        let error_sample: Vec<&FormulaEntry> = formula_entries
            .iter()
            .filter(|e| e.parse_error.is_some())
            .take(50)
            .collect();
        let slim = serde_json::json!({
            "_compact": true,
            "_total_formulas": total_formulas,
            "_ground_truth_count": gt_count,
            "_parse_errors": parse_errors,
            "_error_sample": error_sample,
        });
        let formulas_json = serde_json::to_string(&slim).expect("JSON serialization failed");
        formulas_written_size = formulas_json.len();
        fs::write(&formulas_path, &formulas_json).expect("Failed to write formulas.json");
        println!(
            "[rust-parser] formulas.json (compact metadata): {} parse errors in {}ms ({})",
            parse_errors, t2.elapsed().as_millis(),
            human_size(formulas_written_size)
        );
    } else {
        let formulas_json = if compact {
            serde_json::to_string(&formula_entries).expect("JSON serialization failed")
        } else {
            serde_json::to_string_pretty(&formula_entries).expect("JSON serialization failed")
        };
        formulas_written_size = formulas_json.len();
        fs::write(&formulas_path, &formulas_json).expect("Failed to write formulas.json");
        println!(
            "[rust-parser] formulas.json: {} formulas, {} parse errors in {}ms ({})",
            total_formulas, parse_errors, t2.elapsed().as_millis(),
            human_size(formulas_written_size)
        );
    }

    // Phase 4: Build dependency graph + cycle detection
    let t3 = Instant::now();

    let formula_triples: Vec<(String, String, String)> = workbook
        .sheets
        .iter()
        .flat_map(|sheet| {
            sheet.cells.iter().filter_map(move |cell| {
                cell.formula.as_ref().map(|f| {
                    (
                        format!("{}!{}", sheet.name, cell.address),
                        f.clone(),
                        sheet.name.clone(),
                    )
                })
            })
        })
        .collect();

    let dep_graph = build_graph(&formula_triples);
    let cycle_count = dep_graph.cycles.iter().filter(|c| c.len() > 1).count();
    let dep_json = if compact {
        serde_json::to_string(&dep_graph).expect("JSON serialization failed")
    } else {
        serde_json::to_string_pretty(&dep_graph).expect("JSON serialization failed")
    };
    let dep_path = output_dir.join("dependency-graph.json");
    fs::write(&dep_path, &dep_json).expect("Failed to write dependency-graph.json");
    println!(
        "[rust-parser] dependency-graph.json: {} nodes, {} cycles in {}ms ({})",
        dep_graph.nodes.len(),
        cycle_count,
        t3.elapsed().as_millis(),
        human_size(dep_json.len())
    );

    // Phase 5: Generate raw-engine.js
    // Lib path: prefer env var, then sibling lib/ relative to binary, then relative ../lib/
    let lib_path = std::env::var("LIB_PATH").unwrap_or_else(|_| {
        // Try to find lib/ relative to the binary's location
        let exe = std::env::current_exe().unwrap_or_default();
        let candidate = exe.parent().unwrap_or(std::path::Path::new("."))
            .join("lib/");
        if candidate.exists() {
            format!("{}/", candidate.display())
        } else {
            // Fallback: absolute path from output_dir up to project lib/
            // (works when output is inside the project tree)
            let abs_output = output_dir.canonicalize()
                .unwrap_or_else(|_| output_dir.to_path_buf());
            // Walk up until we find a lib/ dir
            let mut search = abs_output.as_path();
            loop {
                let candidate = search.join("lib/irr.mjs");
                if candidate.exists() {
                    break format!("{}/", search.join("lib").display());
                }
                match search.parent() {
                    Some(p) if p != search => search = p,
                    _ => break "../lib/".to_string(),
                }
            }
        }
    });
    // In compact mode, compute the set of cells actually referenced by formulas
    // so the engine only declares variables that are needed
    let referenced_cells: Option<HashSet<String>> = if compact {
        let mut refs: HashSet<String> = HashSet::new();
        // Every node is a formula cell address
        for node in &dep_graph.nodes {
            refs.insert(node.clone());
        }
        // Every edge target is a cell referenced by a formula
        for (_src, deps) in &dep_graph.edges {
            for dep in deps {
                refs.insert(dep.clone());
            }
        }
        println!(
            "[rust-parser] Compact mode: {} referenced cells (vs {} total)",
            refs.len(),
            workbook.total_cells
        );
        Some(refs)
    } else {
        None
    };

    let t4 = Instant::now();
    let engine_js = generate_raw_engine(&workbook, &dep_graph, &formula_entries, &lib_path, &referenced_cells);
    let engine_path = output_dir.join("raw-engine.js");
    fs::write(&engine_path, &engine_js).expect("Failed to write raw-engine.js");
    println!(
        "[rust-parser] raw-engine.js written in {}ms ({})",
        t4.elapsed().as_millis(),
        human_size(engine_js.len())
    );

    // Phase 6: Chunked compilation (Option C) — per-sheet modules + orchestrator
    if chunked_flag {
        let t5 = Instant::now();
        let chunked_dir = output_dir.join("chunked");
        fs::create_dir_all(&chunked_dir).expect("Failed to create chunked/ directory");

        match chunked_emitter::emit_chunked(&workbook, &chunked_dir) {
            Ok(summary) => {
                println!(
                    "[rust-parser] Chunked output written in {}ms: {}",
                    t5.elapsed().as_millis(),
                    summary
                );
            }
            Err(e) => {
                eprintln!("[rust-parser] Chunked emission failed: {}", e);
                std::process::exit(1);
            }
        }
    }

    // Summary
    println!("");
    println!("Output files:");
    println!("  {} ({})", model_map_path.display(), human_size(model_map_json.len()));
    println!("  {} ({})", formulas_path.display(), human_size(formulas_written_size));
    println!("  {} ({})", dep_path.display(), human_size(dep_json.len()));
    println!("  {} ({})", engine_path.display(), human_size(engine_js.len()));
    if chunked_flag {
        println!("  {}/chunked/ (per-sheet modules + engine.js)", output_dir.display());
    }
    println!(
        "Total: {}ms | {} sheets | {} cells | {} formulas | {} cycles{}{}",
        t0.elapsed().as_millis(),
        workbook.sheets.len(),
        workbook.total_cells,
        total_formulas,
        cycle_count,
        if compact { " | compact" } else { "" },
        if chunked_flag { " | chunked" } else { "" }
    );
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

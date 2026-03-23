mod circular;
mod dependency;
mod formula_ast;
mod model_map;
mod parser;
mod transpiler;

use dependency::build_graph;
use model_map::{build_formulas_json, generate_raw_engine};
use parser::{build_model_map, parse_workbook};
use std::env;
use std::fs;
use std::path::Path;
use std::time::Instant;

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        eprintln!("Usage: rust-parser <input.xlsx> [output_dir]");
        eprintln!("");
        eprintln!("Outputs (written to output_dir or current directory):");
        eprintln!("  model-map.json        -- Sheet/cell metadata (v1.1.0 schema)");
        eprintln!("  formulas.json         -- All formula cells with transpiled JS");
        eprintln!("  dependency-graph.json -- Cell dependency DAG + cycle detection");
        eprintln!("  raw-engine.js         -- Auto-generated computation engine");
        std::process::exit(1);
    }

    let input_path = Path::new(&args[1]);
    let output_dir = if args.len() >= 3 {
        Path::new(&args[2]).to_path_buf()
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

    println!(
        "[rust-parser] Parsed {} sheets, {} cells, {} formula cells in {}ms",
        workbook.sheets.len(),
        workbook.total_cells,
        workbook.total_formula_cells,
        t0.elapsed().as_millis()
    );

    // Phase 2: Build model-map.json
    let t1 = Instant::now();
    let model_map = build_model_map(&workbook, &source_name);
    let model_map_json =
        serde_json::to_string_pretty(&model_map).expect("JSON serialization failed");
    let model_map_path = output_dir.join("model-map.json");
    fs::write(&model_map_path, &model_map_json).expect("Failed to write model-map.json");
    println!(
        "[rust-parser] model-map.json written in {}ms",
        t1.elapsed().as_millis()
    );

    // Phase 3: Build formulas.json (parse + transpile all formulas)
    let t2 = Instant::now();
    let formula_entries = build_formulas_json(&workbook);
    let total_formulas = formula_entries.len();
    let parse_errors = formula_entries
        .iter()
        .filter(|e| e.parse_error.is_some())
        .count();
    let formulas_json =
        serde_json::to_string_pretty(&formula_entries).expect("JSON serialization failed");
    let formulas_path = output_dir.join("formulas.json");
    fs::write(&formulas_path, &formulas_json).expect("Failed to write formulas.json");
    println!(
        "[rust-parser] formulas.json: {} formulas, {} parse errors in {}ms",
        total_formulas,
        parse_errors,
        t2.elapsed().as_millis()
    );

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
    let dep_json =
        serde_json::to_string_pretty(&dep_graph).expect("JSON serialization failed");
    let dep_path = output_dir.join("dependency-graph.json");
    fs::write(&dep_path, &dep_json).expect("Failed to write dependency-graph.json");
    println!(
        "[rust-parser] dependency-graph.json: {} nodes, {} cycles in {}ms",
        dep_graph.nodes.len(),
        cycle_count,
        t3.elapsed().as_millis()
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
    let t4 = Instant::now();
    let engine_js = generate_raw_engine(&workbook, &dep_graph, &formula_entries, &lib_path);
    let engine_path = output_dir.join("raw-engine.js");
    fs::write(&engine_path, &engine_js).expect("Failed to write raw-engine.js");
    println!(
        "[rust-parser] raw-engine.js written in {}ms",
        t4.elapsed().as_millis()
    );

    // Summary
    println!("");
    println!("Output files:");
    println!("  {}", model_map_path.display());
    println!("  {}", formulas_path.display());
    println!("  {}", dep_path.display());
    println!("  {}", engine_path.display());
    println!(
        "Total: {}ms | {} sheets | {} cells | {} formulas | {} cycles",
        t0.elapsed().as_millis(),
        workbook.sheets.len(),
        workbook.total_cells,
        total_formulas,
        cycle_count
    );
}

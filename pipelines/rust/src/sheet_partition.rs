/// Sheet-level partitioning and DAG construction for chunked compilation.
///
/// Groups cells by worksheet, computes cross-sheet dependencies at the sheet level,
/// and produces a topological ordering of sheets for evaluation.

use crate::dependency::extract_refs;
use crate::parser::{CellData, CellValue, WorkbookData};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// A single sheet's partition: its cells grouped for emission.
#[derive(Debug, Clone)]
pub struct SheetPartition {
    pub name: String,
    /// Cells that are literals / inputs (no formula)
    pub input_cells: Vec<CellData>,
    /// Cells that have formulas, in intra-sheet dependency order
    pub formula_cells: Vec<CellData>,
    /// Names of other sheets this sheet depends on (cross-sheet refs)
    pub sheet_dependencies: BTreeSet<String>,
}

/// Sheet-level DAG + topological order (supports circular dependencies via clusters).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SheetGraph {
    pub sheets: Vec<SheetGraphEntry>,
    /// Flattened topological order of all sheets (clusters appear in sequence)
    #[serde(rename = "topoOrder")]
    pub topo_order: Vec<String>,
    /// Groups of sheets that form circular dependencies and need convergence loops.
    /// Empty if the sheet graph is acyclic.
    #[serde(rename = "sheetClusters", skip_serializing_if = "Vec::is_empty", default)]
    pub sheet_clusters: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SheetGraphEntry {
    pub name: String,
    pub deps: Vec<String>,
}

// ---------------------------------------------------------------------------
// Sheet partitioning
// ---------------------------------------------------------------------------

/// Partition a workbook into per-sheet groups with cross-sheet dependency metadata.
pub fn partition_sheets(workbook: &WorkbookData) -> Vec<SheetPartition> {
    let sheet_names: HashSet<String> = workbook.sheet_names.iter().cloned().collect();

    // Process each sheet in parallel — extract_refs is the bottleneck (3M cells)
    let partitions: Vec<SheetPartition> = workbook
        .sheets
        .par_iter()
        .map(|sheet| {
            let mut input_cells = Vec::new();
            let mut formula_cells = Vec::new();
            let mut sheet_deps: BTreeSet<String> = BTreeSet::new();

            for cell in &sheet.cells {
                if let Some(formula) = &cell.formula {
                    formula_cells.push(cell.clone());

                    // Extract cross-sheet references
                    let refs = extract_refs(formula, &sheet.name);
                    for r in &refs {
                        if let Some(bang) = r.find('!') {
                            let ref_sheet = &r[..bang];
                            if ref_sheet != sheet.name && sheet_names.contains(ref_sheet) {
                                sheet_deps.insert(ref_sheet.to_string());
                            }
                        }
                    }
                } else if cell.value.is_some() {
                    input_cells.push(cell.clone());
                }
            }

            // Sort formula cells by intra-sheet dependency order (simple row/col sort as fallback)
            formula_cells.sort_by(|a, b| a.row.cmp(&b.row).then(a.col.cmp(&b.col)));

            // Sort input cells deterministically
            input_cells.sort_by(|a, b| a.row.cmp(&b.row).then(a.col.cmp(&b.col)));

            SheetPartition {
                name: sheet.name.clone(),
                input_cells,
                formula_cells,
                sheet_dependencies: sheet_deps,
            }
        })
        .collect();

    partitions
}

// ---------------------------------------------------------------------------
// Sheet-level DAG + topo sort
// ---------------------------------------------------------------------------

/// Build sheet-level dependency graph and compute topological order.
/// Handles circular sheet dependencies by grouping them into convergence clusters
/// (using Tarjan SCC), then topologically ordering the condensed graph.
pub fn build_sheet_graph(partitions: &[SheetPartition]) -> Result<SheetGraph, String> {
    let mut entries: Vec<SheetGraphEntry> = Vec::new();
    let mut adj: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();

    for p in partitions {
        adj.entry(p.name.clone()).or_default();
        for dep in &p.sheet_dependencies {
            adj.entry(dep.clone()).or_default();
            adj.get_mut(&p.name).unwrap().insert(dep.clone());
        }
        entries.push(SheetGraphEntry {
            name: p.name.clone(),
            deps: p.sheet_dependencies.iter().cloned().collect(),
        });
    }

    // Collect all sheet names in deterministic order
    let all_names: Vec<String> = adj.keys().cloned().collect();

    // Run Tarjan SCC on the sheet-level graph
    let sccs = sheet_tarjan_scc(&all_names, &adj);

    // Identify multi-sheet clusters (circular deps)
    let sheet_clusters: Vec<Vec<String>> = sccs
        .iter()
        .filter(|scc| scc.len() > 1)
        .cloned()
        .collect();

    // Map each sheet to its SCC index
    let mut sheet_to_scc: HashMap<String, usize> = HashMap::new();
    for (i, scc) in sccs.iter().enumerate() {
        for name in scc {
            sheet_to_scc.insert(name.clone(), i);
        }
    }

    // Build condensation graph and topo-sort it (Kahn's)
    let n = sccs.len();
    let mut cond_edges: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); n];
    let mut in_deg = vec![0usize; n];

    for (node, deps) in &adj {
        let src_scc = sheet_to_scc[node];
        for dep in deps {
            if let Some(&dep_scc) = sheet_to_scc.get(dep) {
                if dep_scc != src_scc {
                    if cond_edges[dep_scc].insert(src_scc) {
                        in_deg[src_scc] += 1;
                    }
                }
            }
        }
    }

    let mut queue: VecDeque<usize> = (0..n).filter(|&i| in_deg[i] == 0).collect();
    let mut cond_topo: Vec<usize> = Vec::new();

    while let Some(v) = queue.pop_front() {
        cond_topo.push(v);
        for &w in &cond_edges[v] {
            in_deg[w] -= 1;
            if in_deg[w] == 0 {
                queue.push_back(w);
            }
        }
    }

    // Flatten: expand each SCC into its sheets (sorted for determinism)
    let mut topo_order: Vec<String> = Vec::new();
    for &scc_idx in &cond_topo {
        let mut scc_sheets = sccs[scc_idx].clone();
        scc_sheets.sort();
        topo_order.extend(scc_sheets);
    }

    if !sheet_clusters.is_empty() {
        eprintln!(
            "[rust-parser] Sheet-level circular dependencies found: {} cluster(s) ({} sheets total)",
            sheet_clusters.len(),
            sheet_clusters.iter().map(|c| c.len()).sum::<usize>()
        );
    }

    Ok(SheetGraph {
        sheets: entries,
        topo_order,
        sheet_clusters,
    })
}

/// Tarjan SCC for sheet-level graph (iterative to avoid stack overflow).
fn sheet_tarjan_scc(
    names: &[String],
    adj: &BTreeMap<String, BTreeSet<String>>,
) -> Vec<Vec<String>> {
    let mut index_counter: usize = 0;
    let mut stack: Vec<String> = Vec::new();
    let mut on_stack: HashSet<String> = HashSet::new();
    let mut indices: HashMap<String, usize> = HashMap::new();
    let mut lowlinks: HashMap<String, usize> = HashMap::new();
    let mut sccs: Vec<Vec<String>> = Vec::new();

    struct Frame {
        node: String,
        deps: Vec<String>,
        dep_idx: usize,
        returned_from: Option<String>,
    }

    for start in names {
        if indices.contains_key(start) {
            continue;
        }

        indices.insert(start.clone(), index_counter);
        lowlinks.insert(start.clone(), index_counter);
        index_counter += 1;
        stack.push(start.clone());
        on_stack.insert(start.clone());

        let deps: Vec<String> = adj
            .get(start)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default();

        let mut call_stack = vec![Frame {
            node: start.clone(),
            deps,
            dep_idx: 0,
            returned_from: None,
        }];

        loop {
            let stack_len = call_stack.len();
            if stack_len == 0 {
                break;
            }
            let fi = stack_len - 1;

            if let Some(child) = call_stack[fi].returned_from.take() {
                let ll_child = lowlinks[child.as_str()];
                let node = &call_stack[fi].node;
                let ll_v = lowlinks[node.as_str()];
                lowlinks.insert(node.clone(), ll_v.min(ll_child));
            }

            let current = call_stack[fi].node.clone();
            let mut child_to_push: Option<(String, Vec<String>)> = None;

            while call_stack[fi].dep_idx < call_stack[fi].deps.len() {
                let w = call_stack[fi].deps[call_stack[fi].dep_idx].clone();
                call_stack[fi].dep_idx += 1;

                if !indices.contains_key(&w) {
                    indices.insert(w.clone(), index_counter);
                    lowlinks.insert(w.clone(), index_counter);
                    index_counter += 1;
                    stack.push(w.clone());
                    on_stack.insert(w.clone());

                    let w_deps: Vec<String> = adj
                        .get(&w)
                        .map(|s| s.iter().cloned().collect())
                        .unwrap_or_default();
                    child_to_push = Some((w, w_deps));
                    break;
                } else if on_stack.contains(&w) {
                    let idx_w = indices[&w];
                    let ll_v = lowlinks[&current];
                    lowlinks.insert(current.clone(), ll_v.min(idx_w));
                }
            }

            if let Some((child, child_deps)) = child_to_push {
                call_stack[fi].returned_from = Some(child.clone());
                call_stack.push(Frame {
                    node: child,
                    deps: child_deps,
                    dep_idx: 0,
                    returned_from: None,
                });
                continue;
            }

            // All deps done — check if root
            if lowlinks[&current] == indices[&current] {
                let mut scc = Vec::new();
                loop {
                    let w = stack.pop().unwrap();
                    on_stack.remove(&w);
                    scc.push(w.clone());
                    if w == current {
                        break;
                    }
                }
                sccs.push(scc);
            }

            call_stack.pop();
            if let Some(parent) = call_stack.last_mut() {
                parent.returned_from = Some(current);
            }
        }
    }

    sccs
}

// ---------------------------------------------------------------------------
// Ground truth extraction
// ---------------------------------------------------------------------------

/// Extract ground truth values from all formula cells that have a computed Excel value.
pub fn extract_ground_truth(workbook: &WorkbookData) -> BTreeMap<String, serde_json::Value> {
    let mut gt: BTreeMap<String, serde_json::Value> = BTreeMap::new();

    for sheet in &workbook.sheets {
        for cell in &sheet.cells {
            // Include ALL cells with values (both formula results and literal inputs)
            // This ensures cross-sheet references to literal cells are available
            let qualified = format!("{}!{}", sheet.name, cell.address);
            match &cell.value {
                Some(CellValue::Number(n)) => {
                    if let Some(jn) = serde_json::Number::from_f64(*n) {
                        gt.insert(qualified, serde_json::Value::Number(jn));
                    }
                }
                Some(CellValue::Text(s)) => {
                    gt.insert(qualified, serde_json::Value::String(s.clone()));
                }
                Some(CellValue::Bool(b)) => {
                    gt.insert(qualified, serde_json::Value::Bool(*b));
                }
                _ => {}
            }
        }
    }

    gt
}

/// Extract a label index from the workbook. Maps lowercased label text to
/// the list of cells containing that text. Enables O(1) label lookup instead
/// of O(N) ground-truth scanning.
///
/// Output shape:
///   { "total revenue": [ { "sheet": "Valuation", "col": "A", "row": 23,
///                          "text": "Total Revenue" }, ... ], ... }
pub fn extract_labels_index(workbook: &WorkbookData) -> serde_json::Value {
    let mut index: BTreeMap<String, Vec<serde_json::Value>> = BTreeMap::new();

    for sheet in &workbook.sheets {
        for cell in &sheet.cells {
            if let Some(CellValue::Text(s)) = &cell.value {
                let trimmed = s.trim();
                // Skip near-empty and very long strings (unlikely to be labels)
                if trimmed.len() < 2 || trimmed.len() > 200 {
                    continue;
                }
                let key = trimmed.to_lowercase();
                // Parse address into col + row
                let (col, row) = split_address(&cell.address);
                index.entry(key).or_default().push(serde_json::json!({
                    "sheet": sheet.name,
                    "col": col,
                    "row": row,
                    "text": trimmed,
                }));
            }
        }
    }

    serde_json::to_value(index).unwrap_or(serde_json::Value::Object(Default::default()))
}

/// Split a cell address like "AA125" into ("AA", 125). Returns ("", 0) on parse failure.
fn split_address(addr: &str) -> (String, u32) {
    let mut col = String::new();
    let mut row_str = String::new();
    let mut in_row = false;
    for c in addr.chars() {
        if in_row {
            row_str.push(c);
        } else if c.is_ascii_alphabetic() {
            col.push(c);
        } else if c.is_ascii_digit() {
            in_row = true;
            row_str.push(c);
        }
    }
    let row = row_str.parse::<u32>().unwrap_or(0);
    (col, row)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::{CellData, CellValue, SheetData, WorkbookData};

    fn make_cell(row: u32, col: u32, addr: &str, val: Option<CellValue>, formula: Option<&str>) -> CellData {
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
            ],
            row_count: 1,
            col_count: 2,
            formula_cells: vec![],
        };

        let cashflows = SheetData {
            name: "Cashflows".to_string(),
            cells: vec![
                make_cell(0, 0, "A1", Some(CellValue::Text("Revenue".into())), None),
                make_cell(0, 1, "B1", Some(CellValue::Number(1000000.0)), Some("Assumptions!B1")),
                make_cell(1, 1, "B2", Some(CellValue::Number(500000.0)), Some("B1*0.5")),
            ],
            row_count: 2,
            col_count: 2,
            formula_cells: vec!["B1".to_string(), "B2".to_string()],
        };

        let summary = SheetData {
            name: "Summary".to_string(),
            cells: vec![
                make_cell(0, 1, "B1", Some(CellValue::Number(1000000.0)), Some("Cashflows!B1")),
                make_cell(1, 1, "B2", Some(CellValue::Number(500000.0)), Some("Cashflows!B2")),
            ],
            row_count: 2,
            col_count: 2,
            formula_cells: vec!["B1".to_string(), "B2".to_string()],
        };

        WorkbookData {
            sheet_names: vec!["Assumptions".into(), "Cashflows".into(), "Summary".into()],
            sheets: vec![assumptions, cashflows, summary],
            total_cells: 7,
            total_formula_cells: 4,
        }
    }

    #[test]
    fn test_partition_sheets() {
        let wb = make_test_workbook();
        let partitions = partition_sheets(&wb);

        assert_eq!(partitions.len(), 3);

        // Assumptions has no formula cells
        assert_eq!(partitions[0].name, "Assumptions");
        assert_eq!(partitions[0].formula_cells.len(), 0);
        assert_eq!(partitions[0].input_cells.len(), 2);
        assert!(partitions[0].sheet_dependencies.is_empty());

        // Cashflows depends on Assumptions
        assert_eq!(partitions[1].name, "Cashflows");
        assert_eq!(partitions[1].formula_cells.len(), 2);
        assert!(partitions[1].sheet_dependencies.contains("Assumptions"));

        // Summary depends on Cashflows
        assert_eq!(partitions[2].name, "Summary");
        assert_eq!(partitions[2].formula_cells.len(), 2);
        assert!(partitions[2].sheet_dependencies.contains("Cashflows"));
    }

    #[test]
    fn test_sheet_graph_topo_order() {
        let wb = make_test_workbook();
        let partitions = partition_sheets(&wb);
        let graph = build_sheet_graph(&partitions).expect("should not have cycles");

        // Assumptions must come before Cashflows, Cashflows before Summary
        let order = &graph.topo_order;
        let idx_a = order.iter().position(|s| s == "Assumptions").unwrap();
        let idx_c = order.iter().position(|s| s == "Cashflows").unwrap();
        let idx_s = order.iter().position(|s| s == "Summary").unwrap();
        assert!(idx_a < idx_c, "Assumptions should come before Cashflows");
        assert!(idx_c < idx_s, "Cashflows should come before Summary");
    }

    #[test]
    fn test_ground_truth_extraction() {
        let wb = make_test_workbook();
        let gt = extract_ground_truth(&wb);

        assert!(gt.contains_key("Cashflows!B1"));
        assert!(gt.contains_key("Summary!B2"));
        assert_eq!(gt.get("Cashflows!B1").unwrap(), &serde_json::json!(1000000.0));
    }

    #[test]
    fn test_circular_sheet_dep_detection() {
        // Create two sheets that depend on each other
        let sheet_a = SheetData {
            name: "A".to_string(),
            cells: vec![
                make_cell(0, 0, "A1", Some(CellValue::Number(1.0)), Some("B!A1")),
            ],
            row_count: 1,
            col_count: 1,
            formula_cells: vec!["A1".to_string()],
        };
        let sheet_b = SheetData {
            name: "B".to_string(),
            cells: vec![
                make_cell(0, 0, "A1", Some(CellValue::Number(2.0)), Some("A!A1")),
            ],
            row_count: 1,
            col_count: 1,
            formula_cells: vec!["A1".to_string()],
        };
        let wb = WorkbookData {
            sheet_names: vec!["A".into(), "B".into()],
            sheets: vec![sheet_a, sheet_b],
            total_cells: 2,
            total_formula_cells: 2,
        };

        let partitions = partition_sheets(&wb);
        let result = build_sheet_graph(&partitions);
        // Should succeed but identify the circular cluster
        assert!(result.is_ok(), "Should handle circular sheet deps via clusters");
        let graph = result.unwrap();
        assert_eq!(graph.sheet_clusters.len(), 1, "Should have 1 cluster");
        assert_eq!(graph.sheet_clusters[0].len(), 2, "Cluster should have 2 sheets");
        assert_eq!(graph.topo_order.len(), 2, "All sheets should be in topo order");
    }
}

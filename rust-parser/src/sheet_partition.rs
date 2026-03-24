/// Sheet-level partitioning and DAG construction for chunked compilation.
///
/// Groups cells by worksheet, computes cross-sheet dependencies at the sheet level,
/// and produces a topological ordering of sheets for evaluation.

use crate::dependency::extract_refs;
use crate::parser::{CellData, CellValue, WorkbookData};
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

/// Sheet-level DAG + topological order.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SheetGraph {
    pub sheets: Vec<SheetGraphEntry>,
    #[serde(rename = "topoOrder")]
    pub topo_order: Vec<String>,
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

    let mut partitions: Vec<SheetPartition> = Vec::new();

    for sheet in &workbook.sheets {
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

        partitions.push(SheetPartition {
            name: sheet.name.clone(),
            input_cells,
            formula_cells,
            sheet_dependencies: sheet_deps,
        });
    }

    partitions
}

// ---------------------------------------------------------------------------
// Sheet-level DAG + topo sort
// ---------------------------------------------------------------------------

/// Build sheet-level dependency graph and compute topological order.
/// Returns an error string if a cycle is detected at the sheet level.
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

    // Kahn's algorithm for topo sort
    // adj[node] lists what node depends on.
    // So edge goes dep → node. in_degree[node] = count of deps.
    let mut in_deg: HashMap<String, usize> = HashMap::new();
    for name in adj.keys() {
        in_deg.insert(name.clone(), 0);
    }
    for (node, deps) in &adj {
        in_deg.entry(node.clone()).or_insert(0);
        // node depends on each dep. So there's an edge dep→node. in_deg[node] += 1 per dep.
        *in_deg.get_mut(node).unwrap() = deps.len();
    }

    let mut queue: VecDeque<String> = in_deg
        .iter()
        .filter(|(_, &d)| d == 0)
        .map(|(k, _)| k.clone())
        .collect();

    // Sort the initial queue for determinism
    let mut sorted_queue: Vec<String> = queue.drain(..).collect();
    sorted_queue.sort();
    for item in sorted_queue {
        queue.push_back(item);
    }

    let mut topo_order: Vec<String> = Vec::new();

    while let Some(node) = queue.pop_front() {
        topo_order.push(node.clone());
        // Find all nodes that depend on `node` and decrement their in-degree
        let mut next_batch: Vec<String> = Vec::new();
        for (other, deps) in &adj {
            if deps.contains(&node) {
                let deg = in_deg.get_mut(other).unwrap();
                *deg -= 1;
                if *deg == 0 {
                    next_batch.push(other.clone());
                }
            }
        }
        next_batch.sort();
        for n in next_batch {
            queue.push_back(n);
        }
    }

    if topo_order.len() != adj.len() {
        let remaining: Vec<String> = adj
            .keys()
            .filter(|k| !topo_order.contains(k))
            .cloned()
            .collect();
        return Err(format!(
            "Circular sheet-level dependency detected among: {:?}",
            remaining
        ));
    }

    Ok(SheetGraph {
        sheets: entries,
        topo_order,
    })
}

// ---------------------------------------------------------------------------
// Ground truth extraction
// ---------------------------------------------------------------------------

/// Extract ground truth values from all formula cells that have a computed Excel value.
pub fn extract_ground_truth(workbook: &WorkbookData) -> BTreeMap<String, serde_json::Value> {
    let mut gt: BTreeMap<String, serde_json::Value> = BTreeMap::new();

    for sheet in &workbook.sheets {
        for cell in &sheet.cells {
            if cell.formula.is_some() {
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
    }

    gt
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
        assert!(result.is_err(), "Should detect circular sheet dependency");
    }
}

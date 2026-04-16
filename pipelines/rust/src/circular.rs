/// Generate JavaScript convergence loops for circular reference clusters.
///
/// Each cluster is wrapped in:
///   let _prev_N = {}, _maxIter = 100, _tol = 1e-6;
///   for (let _i = 0; _i < _maxIter; _i++) {
///     <formula assignments for all cells in cluster>
///     if (<convergence check>) break;
///     Object.assign(_prev_N, { cell1, cell2, ... });
///   }

use crate::dependency::ConvergenceCluster;

#[allow(dead_code)] // cluster_id and cells held for diagnostic/future use
pub struct ClusterCode {
    pub cluster_id: usize,
    pub cells: Vec<String>,
    pub js: String,
}

/// Generate the convergence loop JS for one cluster.
/// `cell_js_map` maps qualified_address → JS expression for that cell's formula.
pub fn generate_cluster_loop(
    cluster: &ConvergenceCluster,
    cell_js_map: &std::collections::HashMap<String, String>,
    var_for_addr: &dyn Fn(&str) -> String,
) -> ClusterCode {
    let id = cluster.id;
    let cells = &cluster.cells;
    let _loop_var = &cluster.loop_var; // reserved for future convergence hinting

    let mut lines = Vec::new();

    // Declare convergence state
    lines.push(format!("  // Convergence cluster {}: {} cells", id, cells.len()));
    lines.push(format!("  let _prev_{id} = {{}};"));
    lines.push(format!("  const _maxIter_{id} = 100;"));
    lines.push(format!("  const _tol_{id} = 1e-6;"));
    lines.push(format!("  for (let _ci_{id} = 0; _ci_{id} < _maxIter_{id}; _ci_{id}++) {{"));

    // All formula assignments inside the loop
    for addr in cells {
        let var_name = var_for_addr(addr);
        let expr = cell_js_map
            .get(addr)
            .map(|s| s.as_str())
            .unwrap_or("/* missing */ 0");
        lines.push(format!("    {} = {};", var_name, expr));
    }

    // Convergence check: test the first numeric cell in the cluster
    // (a proxy for overall convergence)
    let check_var = cells
        .first()
        .map(|a| var_for_addr(a))
        .unwrap_or_else(|| "0".to_string());

    lines.push(format!(
        "    if (Math.abs({check} - (_prev_{id}.{check} || 0)) < _tol_{id}) break;",
        check = check_var,
        id = id
    ));

    // Save previous values
    let prev_assignments: Vec<String> = cells
        .iter()
        .map(|a| {
            let v = var_for_addr(a);
            format!("{}: {}", v, v)
        })
        .collect();
    lines.push(format!(
        "    Object.assign(_prev_{id}, {{ {} }});",
        prev_assignments.join(", "),
        id = id
    ));

    lines.push(format!("  }} // end cluster {}", id));

    ClusterCode {
        cluster_id: id,
        cells: cells.clone(),
        js: lines.join("\n"),
    }
}

/// Cell dependency graph construction and cycle detection via Tarjan's SCC algorithm.
///
/// A "qualified address" is `SheetName!CellAddr` (e.g., `Sheet1!B12`).
/// For cells on the same sheet as the formula, the sheet name is implicit and
/// is added by the caller.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct DependencyGraph {
    /// List of all formula cells (qualified address)
    pub nodes: Vec<String>,
    /// Adjacency list: cell → [cells it depends on]
    pub edges: HashMap<String, Vec<String>>,
    /// Tarjan SCC result: groups of strongly-connected cells (cycles)
    pub cycles: Vec<Vec<String>>,
    /// Topological order of non-cyclic nodes (cycle clusters appear as a unit)
    pub topo_order: Vec<TopoNode>,
    /// Convergence clusters (same as cycles but with extra metadata)
    pub convergence_clusters: Vec<ConvergenceCluster>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum TopoNode {
    Single { address: String },
    Cluster { id: usize, cells: Vec<String> },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ConvergenceCluster {
    pub id: usize,
    pub cells: Vec<String>,
    /// Suggested iteration variable name for the convergence loop
    pub loop_var: String,
}

// ---------------------------------------------------------------------------
// Dependency extraction from raw formula strings
// ---------------------------------------------------------------------------

/// How [`extract_refs_impl`] renders a range reference (`A1:B10`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RangeMode {
    /// Enumerate every interior cell (capped at 1000): `A1:A3` → A1,A2,A3.
    /// Complete but O(range size) strings — the source of the 37 GB graph.
    Expand,
    /// Top-left endpoint only: `A1:B10` → A1. Cheap *shape* (cycle detection).
    TopLeft,
    /// Keep the range as a single token: `A1:B10` → "A1:B10". Lossless and
    /// compact (one string per range, regardless of size); the consumer
    /// expands lazily against its cells of interest. This is what the
    /// dependency-graph contract uses so reachability stays complete without
    /// materializing billions of edges.
    Keep,
}

/// Very lightweight cell-reference extractor.  We only need the *shape* of the
/// dependency graph here — the full AST parse happens in formula_ast.rs.
/// We look for patterns:
///   • Simple refs: A1, B12, AA100 (col letters + row digits)
///   • Cross-sheet: Sheet1!A1  or  'Sheet Name'!B3
///   • Ranges: A1:B10 — **expanded to every interior cell** (capped at 1000).
///
/// Range expansion is the expensive part: a single `SUM(A1:A1000)` yields 1000
/// strings. Callers that only need dependency *shape* (which sheets, or which
/// cells form a cycle) — not every interior cell — must use
/// [`extract_refs_shallow`] or [`collect_sheet_deps`] instead; expanding here and
/// discarding the result is what hung the chunked build on multi-million-formula
/// models (see those functions). The dependency-graph emitter uses
/// [`extract_refs_ranges`] (compact range tokens) for the same reason.
pub fn extract_refs(formula: &str, current_sheet: &str) -> Vec<String> {
    extract_refs_impl(formula, current_sheet, RangeMode::Expand)
}

/// Like [`extract_refs`] but **does not expand ranges**: `A1:B10` contributes
/// only its top-left endpoint. Use this where you need the dependency *shape*
/// cheaply (e.g. intra-sheet cycle detection) and exploding every range to ≤1000
/// cells would be catastrophic. This restores the pre-Round-2 behaviour for
/// cycle detection — same-sheet ranges are not enumerated — which is what the
/// known-good engines were built with; self-including ranges (`B10=SUM(B1:B10)`)
/// stay benign because single-node SCCs aren't treated as cycles.
pub fn extract_refs_shallow(formula: &str, current_sheet: &str) -> Vec<String> {
    extract_refs_impl(formula, current_sheet, RangeMode::TopLeft)
}

/// Like [`extract_refs`] but **keeps ranges as single tokens**: `A1:B10`
/// contributes the one string `"A1:B10"` instead of every interior cell. This is
/// the cell-level dependency-graph emitter's extractor: it preserves complete
/// reachability information (the full range, not a truncated endpoint) while
/// emitting O(refs-per-formula) strings instead of O(cells-covered). A consumer
/// reconstructs interior membership by expanding the token against the (small)
/// sets of cells it actually cares about. Eliminates the 37 GB / 7 min
/// dependency-graph blowup on multi-million-formula models (issue #32).
pub fn extract_refs_ranges(formula: &str, current_sheet: &str) -> Vec<String> {
    extract_refs_impl(formula, current_sheet, RangeMode::Keep)
}

fn extract_refs_impl(formula: &str, current_sheet: &str, mode: RangeMode) -> Vec<String> {
    let mut refs = Vec::new();
    let bytes = formula.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        // Skip string literals
        if bytes[i] == b'"' {
            i += 1;
            while i < len && bytes[i] != b'"' {
                if bytes[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            i += 1;
            continue;
        }

        // Check for quoted sheet name: 'Sheet Name'!
        if bytes[i] == b'\'' {
            let start = i + 1;
            i += 1;
            while i < len && bytes[i] != b'\'' {
                i += 1;
            }
            if i >= len {
                continue;
            }
            let sheet_name = &formula[start..i];
            i += 1; // skip closing '
            if i < len && bytes[i] == b'!' {
                i += 1;
                // Now read cell reference
                if let Some((addr, consumed)) = read_cell_or_range(&formula[i..], mode) {
                    for a in addr {
                        refs.push(format!("{}!{}", sheet_name, a));
                    }
                    i += consumed;
                    continue;
                }
            }
            continue;
        }

        // Check for unquoted sheet name: SheetName!  (no spaces in name)
        // Heuristic: sequence of word chars followed by '!'
        if bytes[i].is_ascii_alphabetic() || bytes[i] == b'_' {
            let start = i;
            let mut j = i;
            while j < len && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_' || bytes[j] == b' ') {
                j += 1;
            }
            if j < len && bytes[j] == b'!' {
                // It's a cross-sheet ref
                let sheet_name = &formula[start..j];
                i = j + 1;
                if let Some((addr, consumed)) = read_cell_or_range(&formula[i..], mode) {
                    for a in addr {
                        refs.push(format!("{}!{}", sheet_name, a));
                    }
                    i += consumed;
                    continue;
                }
                continue;
            }
            // Not a sheet ref — might be a function name or just letters; read as potential cell ref
            if let Some((addr, consumed)) = read_cell_or_range(&formula[start..], mode) {
                // Only if we consumed more than zero and it looks like a cell address
                // (We need to check it's not just a function name like SUM)
                // A cell ref must start with letters then have digits
                let candidate = &formula[start..start + consumed];
                if is_cell_ref(candidate) {
                    for a in addr {
                        refs.push(format!("{}!{}", current_sheet, a));
                    }
                    i = start + consumed;
                    continue;
                }
            }
            // Skip identifier (function name, named range, etc.)
            while i < len && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            continue;
        }

        i += 1;
    }

    // Deduplicate
    let mut seen = HashSet::new();
    refs.retain(|r| seen.insert(r.clone()));
    refs
}

/// Read a cell reference or range starting at `s`.
/// Returns (list of cell addresses, chars consumed). The [`RangeMode`] controls
/// how a range is rendered (expand to interior cells / top-left only / keep as
/// one token); `consumed` is identical across modes, so scanning is unaffected.
fn read_cell_or_range(s: &str, mode: RangeMode) -> Option<(Vec<String>, usize)> {
    let bytes = s.as_bytes();
    let len = bytes.len();
    if len == 0 {
        return None;
    }

    // Read column letters
    let mut i = 0;
    // Allow optional $ for absolute refs
    if i < len && bytes[i] == b'$' {
        i += 1;
    }
    let col_start = i;
    while i < len && bytes[i].is_ascii_uppercase() {
        i += 1;
    }
    let col_end = i;
    if col_end == col_start {
        return None;
    }

    // Read optional $
    if i < len && bytes[i] == b'$' {
        i += 1;
    }
    // Read row digits
    let row_start = i;
    while i < len && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let row_end = i;
    if row_end == row_start {
        return None;
    }

    let col_str = &s[col_start..col_end];
    let row_str = &s[row_start..row_end];

    // Validate col (max 3 letters) and row (max 7 digits, reasonable for Excel)
    if col_str.len() > 3 || row_str.len() > 7 {
        return None;
    }

    let first_addr = format!("{}{}", col_str, row_str);

    // Check if it's a range A1:B10
    if i + 1 < len && bytes[i] == b':' {
        let rest = &s[i + 1..];
        if let Some((second, consumed2)) = read_cell_or_range(rest, mode) {
            match mode {
                RangeMode::Expand => {
                    // Expand range to individual cells.
                    let cells = expand_range(&first_addr, &second[0]);
                    return Some((cells, i + 1 + consumed2));
                }
                RangeMode::TopLeft => {
                    // Top-left endpoint only — never enumerate the interior.
                    return Some((vec![first_addr], i + 1 + consumed2));
                }
                RangeMode::Keep => {
                    // Keep the whole range as one token (e.g. "A1:B10"); the
                    // consumer expands it lazily. `second[0]` is the bottom-right
                    // endpoint (inner read is a single cell, mode-independent).
                    return Some((
                        vec![format!("{}:{}", first_addr, second[0])],
                        i + 1 + consumed2,
                    ));
                }
            }
        }
    }

    Some((vec![first_addr], i))
}

/// Check if a string looks like a cell reference (letters + digits, e.g. A1, B12, AA100)
fn is_cell_ref(s: &str) -> bool {
    let bytes = s.as_bytes();

    // Consume one A1-style address starting at `i`; return the end index, or
    // None if `i` doesn't begin a valid address.
    fn consume_cell(bytes: &[u8], mut i: usize) -> Option<usize> {
        if i < bytes.len() && bytes[i] == b'$' {
            i += 1;
        }
        let col_start = i;
        while i < bytes.len() && bytes[i].is_ascii_uppercase() {
            i += 1;
        }
        if i == col_start || i - col_start > 3 {
            return None;
        }
        if i < bytes.len() && bytes[i] == b'$' {
            i += 1;
        }
        let row_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == row_start {
            return None;
        }
        Some(i)
    }

    // Accept a single cell ("A1") or a range ("A1:B10"). A range must fully
    // consume the string — otherwise "A1:A3" failed this guard and the
    // same-sheet range branch was skipped, dropping the interior cells.
    let Some(mut i) = consume_cell(bytes, 0) else {
        return false;
    };
    if i < bytes.len() && bytes[i] == b':' {
        match consume_cell(bytes, i + 1) {
            Some(j) => i = j,
            None => return false,
        }
    }
    i == bytes.len()
}

/// True if `s` begins with an A1-style cell reference: optional `$`, 1–3
/// uppercase letters, optional `$`, 1–7 digits. This is exactly the prefix
/// `read_cell_or_range` accepts (same column/row length caps), so it tells us
/// whether a `Name!…` token is a real cross-sheet *cell* reference vs. e.g. a
/// defined name (`Sheet!MyRange`) — without allocating anything.
fn starts_with_cell_ref(s: &str) -> bool {
    let bytes = s.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    if i < len && bytes[i] == b'$' {
        i += 1;
    }
    let col_start = i;
    while i < len && bytes[i].is_ascii_uppercase() {
        i += 1;
    }
    let col_len = i - col_start;
    if col_len == 0 || col_len > 3 {
        return false;
    }
    if i < len && bytes[i] == b'$' {
        i += 1;
    }
    let row_start = i;
    while i < len && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let row_len = i - row_start;
    row_len >= 1 && row_len <= 7
}

/// Collect the set of *other* sheet names referenced by `formula` into `out`.
///
/// This is the cheap counterpart to [`extract_refs`] for sheet-level
/// partitioning, which only needs to know *which sheets* a formula touches — not
/// every cell. Crucially it **never expands ranges** and **never allocates a
/// string per referenced cell**: calling the range-expanding `extract_refs`
/// here meant a single `SUM(A1:A1000)` produced 1000 throwaway strings (then
/// the de-dup cloned them), and `partition_sheets` discarded every same-sheet
/// one — O(formula_cells × range_size) wasted work that hung the chunked build
/// on multi-million-formula sheets.
///
/// Tokenisation mirrors `extract_refs` exactly, and a dependency is recorded
/// only when a `Name!` / `'Sheet Name'!` token is followed by a real cell
/// reference (the old `read_cell_or_range`-returned-`Some` gate), the name is
/// not `current_sheet`, and the name is a member of `sheet_names`. So the
/// detected sheet-dependency set is identical to the old extract-then-filter
/// path — this is a pure performance fix, not a behaviour change.
pub fn collect_sheet_deps(
    formula: &str,
    current_sheet: &str,
    sheet_names: &HashSet<String>,
    out: &mut BTreeSet<String>,
) {
    let bytes = formula.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        // Skip string literals
        if bytes[i] == b'"' {
            i += 1;
            while i < len && bytes[i] != b'"' {
                if bytes[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            i += 1;
            continue;
        }

        // Quoted sheet name: 'Sheet Name'!
        if bytes[i] == b'\'' {
            let start = i + 1;
            i += 1;
            while i < len && bytes[i] != b'\'' {
                i += 1;
            }
            if i >= len {
                break;
            }
            let sheet_name = &formula[start..i];
            i += 1; // skip closing '
            if i < len && bytes[i] == b'!' {
                i += 1;
                if starts_with_cell_ref(&formula[i..])
                    && sheet_name != current_sheet
                    && sheet_names.contains(sheet_name)
                {
                    out.insert(sheet_name.to_string());
                }
            }
            continue;
        }

        // Unquoted sheet name: Name!  (word chars + spaces, per extract_refs)
        if bytes[i].is_ascii_alphabetic() || bytes[i] == b'_' {
            let start = i;
            let mut j = i;
            while j < len && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_' || bytes[j] == b' ') {
                j += 1;
            }
            if j < len && bytes[j] == b'!' {
                let sheet_name = &formula[start..j];
                let after = j + 1;
                if starts_with_cell_ref(&formula[after..])
                    && sheet_name != current_sheet
                    && sheet_names.contains(sheet_name)
                {
                    out.insert(sheet_name.to_string());
                }
                i = after;
                continue;
            }
            // Not a sheet ref — skip this identifier run (same-sheet cells are
            // irrelevant to sheet-level partitioning).
            i = if j > i { j } else { i + 1 };
            continue;
        }

        i += 1;
    }
}

/// Expand a range like A1:C3 into all cell addresses.
/// Capped at 1000 cells to avoid exploding memory on large ranges.
fn expand_range(top_left: &str, bottom_right: &str) -> Vec<String> {
    fn parse_addr(addr: &str) -> Option<(u32, u32)> {
        let addr = addr.trim_matches('$');
        let bytes = addr.as_bytes();
        let mut i = 0;
        while i < bytes.len() && bytes[i].is_ascii_uppercase() {
            i += 1;
        }
        if i == 0 || i == bytes.len() {
            return None;
        }
        let col_str = &addr[..i];
        let row_str = &addr[i..];
        let row: u32 = row_str.parse().ok()?;
        let col = col_str
            .bytes()
            .fold(0u32, |acc, c| acc * 26 + (c - b'A' + 1) as u32);
        Some((row, col))
    }

    fn col_to_letters(mut col: u32) -> String {
        let mut s = String::new();
        while col > 0 {
            col -= 1;
            s.insert(0, (b'A' + (col % 26) as u8) as char);
            col /= 26;
        }
        s
    }

    let (r1, c1) = match parse_addr(top_left) {
        Some(v) => v,
        None => return vec![top_left.to_string()],
    };
    let (r2, c2) = match parse_addr(bottom_right) {
        Some(v) => v,
        None => return vec![top_left.to_string()],
    };

    let mut cells = Vec::new();
    let max_cells = 1000;
    'outer: for r in r1..=r2 {
        for c in c1..=c2 {
            cells.push(format!("{}{}", col_to_letters(c), r));
            if cells.len() >= max_cells {
                break 'outer;
            }
        }
    }
    cells
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

/// Build the full dependency graph from a list of (qualified_address, formula, sheet_name) tuples.
pub fn build_graph(
    formula_cells: &[(String, String, String)], // (qualified_addr, formula, sheet_name)
) -> DependencyGraph {
    let mut edges: HashMap<String, Vec<String>> = HashMap::new();
    let mut nodes: Vec<String> = Vec::new();
    let mut node_set: HashSet<String> = HashSet::new();

    for (addr, formula, sheet) in formula_cells {
        let deps = extract_refs(formula, sheet);
        edges.insert(addr.clone(), deps);
        if node_set.insert(addr.clone()) {
            nodes.push(addr.clone());
        }
    }

    // Run Tarjan's SCC
    let cycles = tarjan_scc(&nodes, &edges);

    // Build topological order (condensation graph)
    let topo_order = condensation_topo(&nodes, &edges, &cycles);

    // Build convergence clusters from:
    //   (a) multi-cell SCCs (proper cycles between distinct cells), OR
    //   (b) single-cell SCCs that have a self-edge (cell depends on itself)
    let convergence_clusters: Vec<ConvergenceCluster> = cycles
        .iter()
        .enumerate()
        .filter(|(_, c)| {
            c.len() > 1
                || c.first()
                    .and_then(|v| edges.get(v))
                    .map_or(false, |deps| deps.contains(&c[0]))
        })
        .map(|(id, cells)| ConvergenceCluster {
            id,
            cells: cells.clone(),
            loop_var: format!("_cluster{}", id),
        })
        .collect();

    DependencyGraph {
        nodes,
        edges,
        cycles,
        topo_order,
        convergence_clusters,
    }
}

// ---------------------------------------------------------------------------
// Tarjan's Strongly Connected Components
// ---------------------------------------------------------------------------

struct TarjanState {
    index: usize,
    stack: Vec<String>,
    on_stack: HashSet<String>,
    indices: HashMap<String, usize>,
    lowlinks: HashMap<String, usize>,
    sccs: Vec<Vec<String>>,
}

pub fn tarjan_scc(nodes: &[String], edges: &HashMap<String, Vec<String>>) -> Vec<Vec<String>> {
    // Build a HashSet for O(1) node membership checks (critical for large graphs)
    let node_set: HashSet<&str> = nodes.iter().map(|s| s.as_str()).collect();

    let mut state = TarjanState {
        index: 0,
        stack: Vec::new(),
        on_stack: HashSet::new(),
        indices: HashMap::new(),
        lowlinks: HashMap::new(),
        sccs: Vec::new(),
    };

    // Iterative Tarjan's to avoid stack overflow on deep chains (3M+ nodes)
    for node in nodes {
        if !state.indices.contains_key(node.as_str()) {
            strongconnect_iterative(node, &node_set, edges, &mut state);
        }
    }

    state.sccs
}

/// Iterative version of Tarjan's strongconnect to handle millions of nodes
/// without risking stack overflow.
fn strongconnect_iterative(
    start: &str,
    node_set: &HashSet<&str>,
    edges: &HashMap<String, Vec<String>>,
    state: &mut TarjanState,
) {
    // Each frame tracks: the node, its neighbor index progress, and whether
    // we've just returned from a recursive call (and if so, which child).
    struct Frame {
        node: String,
        dep_idx: usize,         // which dependency we're currently processing
        returned_from: Option<String>, // child we just returned from (for lowlink update)
    }

    let mut call_stack: Vec<Frame> = Vec::new();

    // Initialize start node
    let idx = state.index;
    state.indices.insert(start.to_string(), idx);
    state.lowlinks.insert(start.to_string(), idx);
    state.index += 1;
    state.stack.push(start.to_string());
    state.on_stack.insert(start.to_string());

    call_stack.push(Frame {
        node: start.to_string(),
        dep_idx: 0,
        returned_from: None,
    });

    loop {
        let stack_len = call_stack.len();
        if stack_len == 0 {
            break;
        }

        // Work with index to avoid borrow issues
        let frame_idx = stack_len - 1;

        // If we just returned from a child, update lowlink
        if let Some(child) = call_stack[frame_idx].returned_from.take() {
            let ll_child = state.lowlinks.get(child.as_str()).copied().unwrap_or(usize::MAX);
            let node = &call_stack[frame_idx].node;
            let ll_v = state.lowlinks.get(node.as_str()).copied().unwrap_or(usize::MAX);
            state.lowlinks.insert(node.clone(), ll_v.min(ll_child));
        }

        // Get the deps for this node
        let current_node = call_stack[frame_idx].node.clone();
        let deps: Vec<String> = edges
            .get(current_node.as_str())
            .cloned()
            .unwrap_or_default();

        // Find next unprocessed dependency
        let mut child_to_push: Option<String> = None;
        let dep_idx = &mut call_stack[frame_idx].dep_idx;
        while *dep_idx < deps.len() {
            let w = &deps[*dep_idx];
            *dep_idx += 1;

            if !state.indices.contains_key(w.as_str()) {
                if node_set.contains(w.as_str()) {
                    // Initialize w
                    let idx = state.index;
                    state.indices.insert(w.clone(), idx);
                    state.lowlinks.insert(w.clone(), idx);
                    state.index += 1;
                    state.stack.push(w.clone());
                    state.on_stack.insert(w.clone());

                    child_to_push = Some(w.clone());
                    break;
                }
            } else if state.on_stack.contains(w.as_str()) {
                let idx_w = *state.indices.get(w.as_str()).unwrap_or(&usize::MAX);
                let ll_v = state.lowlinks.get(current_node.as_str()).copied().unwrap_or(usize::MAX);
                state.lowlinks.insert(current_node.clone(), ll_v.min(idx_w));
            }
        }

        if let Some(child) = child_to_push {
            call_stack[frame_idx].returned_from = Some(child.clone());
            call_stack.push(Frame {
                node: child,
                dep_idx: 0,
                returned_from: None,
            });
            continue;
        }

        // All deps processed — check if this node is an SCC root
        if state.lowlinks.get(current_node.as_str()) == state.indices.get(current_node.as_str()) {
            let mut scc = Vec::new();
            loop {
                let w = state.stack.pop().unwrap();
                state.on_stack.remove(&w);
                scc.push(w.clone());
                if w == current_node {
                    break;
                }
            }
            state.sccs.push(scc);
        }

        // Pop this frame and set returned_from on parent
        call_stack.pop();
        if let Some(parent) = call_stack.last_mut() {
            parent.returned_from = Some(current_node);
        }
    }
}

// ---------------------------------------------------------------------------
// Condensation + topological sort
// ---------------------------------------------------------------------------

fn condensation_topo(
    nodes: &[String],
    edges: &HashMap<String, Vec<String>>,
    sccs: &[Vec<String>],
) -> Vec<TopoNode> {
    // Map each node to its SCC index
    let mut node_to_scc: HashMap<&str, usize> = HashMap::new();
    for (i, scc) in sccs.iter().enumerate() {
        for node in scc {
            node_to_scc.insert(node.as_str(), i);
        }
    }

    // Build condensation edges: dependency → dependent
    // (dependency must be computed before dependent, so edge goes dep → src)
    // In Kahn's algorithm, nodes with zero in-degree come first.
    // We add edge dep_scc → src_scc so dep_scc has 0 in-degree and is processed first.
    let n = sccs.len();
    let mut cond_edges: Vec<HashSet<usize>> = vec![HashSet::new(); n];
    for node in nodes {
        let src_scc = match node_to_scc.get(node.as_str()) {
            Some(i) => *i,
            None => continue,
        };
        if let Some(deps) = edges.get(node) {
            for dep in deps {
                if let Some(&dep_scc) = node_to_scc.get(dep.as_str()) {
                    if dep_scc != src_scc {
                        // dep_scc must come before src_scc: edge dep_scc → src_scc
                        cond_edges[dep_scc].insert(src_scc);
                    }
                }
            }
        }
    }

    // Kahn's algorithm for topological sort of the condensation graph
    let mut in_degree = vec![0usize; n];
    for i in 0..n {
        for &j in &cond_edges[i] {
            in_degree[j] += 1;
        }
    }

    let mut queue: std::collections::VecDeque<usize> =
        (0..n).filter(|&i| in_degree[i] == 0).collect();
    let mut topo = Vec::new();

    while let Some(v) = queue.pop_front() {
        topo.push(v);
        for &w in &cond_edges[v] {
            in_degree[w] -= 1;
            if in_degree[w] == 0 {
                queue.push_back(w);
            }
        }
    }

    // Convert to TopoNode list
    topo.into_iter()
        .flat_map(|scc_idx| {
            let scc = &sccs[scc_idx];
            if scc.len() == 1 {
                vec![TopoNode::Single {
                    address: scc[0].clone(),
                }]
            } else {
                vec![TopoNode::Cluster {
                    id: scc_idx,
                    cells: scc.clone(),
                }]
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeSet, HashSet};

    fn names(list: &[&str]) -> HashSet<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn sheet_deps(formula: &str, current: &str, sheets: &HashSet<String>) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        collect_sheet_deps(formula, current, sheets, &mut out);
        out
    }

    /// The pre-fix derivation: expand every ref, then keep distinct cross-sheet
    /// sheet names. `collect_sheet_deps` must match this exactly.
    fn legacy_sheet_deps(formula: &str, current: &str, sheets: &HashSet<String>) -> BTreeSet<String> {
        let mut deps = BTreeSet::new();
        for r in extract_refs(formula, current) {
            if let Some(bang) = r.find('!') {
                let ref_sheet = &r[..bang];
                if ref_sheet != current && sheets.contains(ref_sheet) {
                    deps.insert(ref_sheet.to_string());
                }
            }
        }
        deps
    }

    #[test]
    fn extract_refs_full_expands_ranges() {
        // The dependency-graph contract relies on full expansion.
        let refs = extract_refs("SUM(A1:A1000)", "PP&E");
        assert_eq!(refs.len(), 1000, "full extract_refs must enumerate the range");
        assert!(refs.contains(&"PP&E!A1".to_string()));
        assert!(refs.contains(&"PP&E!A1000".to_string()));
    }

    #[test]
    fn extract_refs_shallow_keeps_only_top_left() {
        // Same formula, shallow: one ref, not 1000 — this is the blowup that
        // hung the build (1000x fewer allocations per range).
        let refs = extract_refs_shallow("SUM(A1:A1000)", "PP&E");
        assert_eq!(refs, vec!["PP&E!A1".to_string()]);

        // Single cells are unaffected.
        assert_eq!(
            extract_refs_shallow("A1+B2", "S"),
            vec!["S!A1".to_string(), "S!B2".to_string()]
        );

        // Cross-sheet ranges are also not enumerated.
        let refs = extract_refs_shallow("Other!C1:C500", "S");
        assert_eq!(refs, vec!["Other!C1".to_string()]);
    }

    #[test]
    fn extract_refs_ranges_keeps_range_tokens() {
        // The dependency-graph emitter uses this: one compact token per range,
        // not 1000 cells (issue #32) and not a lossy top-left endpoint.
        let refs = extract_refs_ranges("SUM(A1:A1000)", "PP&E");
        assert_eq!(refs, vec!["PP&E!A1:A1000".to_string()]);

        // Single cells are unchanged (no colon → no range token).
        assert_eq!(
            extract_refs_ranges("A1+B2", "S"),
            vec!["S!A1".to_string(), "S!B2".to_string()]
        );

        // Cross-sheet ranges keep the qualified token.
        assert_eq!(
            extract_refs_ranges("Other!C1:C500", "S"),
            vec!["Other!C1:C500".to_string()]
        );

        // Mixed: a multi-column range token + a single cross-sheet cell.
        let refs = extract_refs_ranges("SUM(A1:C10)+Debt!B7", "Cash Flow");
        assert!(refs.contains(&"Cash Flow!A1:C10".to_string()));
        assert!(refs.contains(&"Debt!B7".to_string()));
    }

    #[test]
    fn starts_with_cell_ref_matches_read_cell_or_range_gate() {
        assert!(starts_with_cell_ref("A1"));
        assert!(starts_with_cell_ref("$A$1"));
        assert!(starts_with_cell_ref("AA100)"));
        assert!(starts_with_cell_ref("ZZ9999999")); // 7 digits ok
        assert!(!starts_with_cell_ref("A"));        // no row
        assert!(!starts_with_cell_ref("1"));        // no col
        assert!(!starts_with_cell_ref("ABCD1"));    // 4 col letters
        assert!(!starts_with_cell_ref("A12345678")); // 8 digits
        assert!(!starts_with_cell_ref("MyRange"));  // defined name, not a cell
        assert!(!starts_with_cell_ref(""));
    }

    #[test]
    fn collect_sheet_deps_basic() {
        let sheets = names(&["Summary", "Cash Flow", "Debt", "Other"]);

        // Cross-sheet (quoted + unquoted), same-sheet ranges, function names.
        assert_eq!(
            sheet_deps("'Cash Flow'!A1 + Debt!B2:B10 + SUM(C1:C5)", "Summary", &sheets),
            BTreeSet::from(["Cash Flow".to_string(), "Debt".to_string()])
        );

        // A range-heavy same-sheet formula yields NO sheet deps (the case that
        // was generating ~2000 throwaway strings per cell in partition_sheets).
        assert!(sheet_deps("SUM(A1:A1000)+SUM(B1:B1000)", "PP&E", &names(&["PP&E", "Other"])).is_empty());

        // Self-reference via explicit sheet name is not a dependency.
        assert!(sheet_deps("Summary!A1", "Summary", &sheets).is_empty());

        // A name not in the workbook's sheet set is ignored (e.g. a function-like
        // token before '!' that isn't a real sheet).
        assert!(sheet_deps("Bogus!A1", "Summary", &sheets).is_empty());

        // `Sheet!DefinedName` (no cell ref after '!') is NOT counted — matches
        // the old read_cell_or_range gate.
        assert!(sheet_deps("Debt!MyRange", "Summary", &sheets).is_empty());
    }

    #[test]
    fn collect_sheet_deps_matches_legacy_on_varied_formulas() {
        let sheets = names(&["Summary", "Cash Flow", "Debt", "Other", "Assumptions"]);
        let cur = "Summary";
        let cases = [
            "Other!A1",
            "Other!A1:Z99",
            "'Cash Flow'!B2 + Debt!C3:C40 - Assumptions!D1",
            "SUM(A1:A100) + Other!B1*2",
            "IF(Debt!A1>0, 'Cash Flow'!B2, 0)",
            "VLOOKUP(A1, Other!$A$1:$D$500, 3, FALSE)",
            "Summary!A1 + A2 + B3:B9",         // self + same-sheet only
            "Bogus!A1 + Other!ZZ100",          // unknown sheet ignored
            "Debt!MyDefinedName + Other!E5",   // defined name not a dep; E5 is
            "\"Other!A1\" & Debt!B2",          // string literal must be skipped
            "1+2*3",                            // no refs
        ];
        for f in cases {
            assert_eq!(
                sheet_deps(f, cur, &sheets),
                legacy_sheet_deps(f, cur, &sheets),
                "sheet-dep parity mismatch for formula: {f}"
            );
        }
    }

    #[test]
    fn collect_sheet_deps_parity_and_speed_at_scale() {
        // Mimics a heavy operational sheet: every formula carries a big
        // same-sheet range (discarded by partitioning) plus one cross-sheet
        // range. The legacy path expanded ~2000 cells per formula and threw
        // almost all of them away; collect_sheet_deps never allocates them.
        let sheets = names(&["PP&E", "Debt"]);
        let cur = "PP&E";
        const N: usize = 2_000;
        let formulas: Vec<String> = (1..=N)
            .map(|r| format!("SUM(A{r}:A1000)+Debt!C1:C1000+B{r}"))
            .collect();

        let t0 = std::time::Instant::now();
        let mut legacy_total = 0usize;
        for f in &formulas {
            legacy_total += legacy_sheet_deps(f, cur, &sheets).len();
        }
        let legacy_ms = t0.elapsed().as_secs_f64() * 1000.0;

        let t1 = std::time::Instant::now();
        let mut new_total = 0usize;
        for f in &formulas {
            new_total += sheet_deps(f, cur, &sheets).len();
        }
        let new_ms = t1.elapsed().as_secs_f64() * 1000.0;

        // Same answer (each formula depends on exactly "Debt").
        assert_eq!(legacy_total, new_total);
        assert_eq!(new_total, N);

        eprintln!(
            "[partition-scan] {N} range-heavy formulas: legacy(extract+filter)={legacy_ms:.1}ms, \
             collect_sheet_deps={new_ms:.1}ms ({:.0}x faster)",
            if new_ms > 0.0 { legacy_ms / new_ms } else { 0.0 }
        );
    }
}

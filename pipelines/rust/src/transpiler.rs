/// AST → JavaScript code generator.
///
/// Variable naming convention:
///   - Cell "Sheet1!A1"  → `s_Sheet1_A1`   (sheet prefix)
///   - Cell "A1" (no sheet) → `A1`  (short form for single-sheet models)
///
/// We use the qualified form to avoid collisions across sheets.

use crate::formula_ast::{CellRef, Expr};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

pub struct TranspileConfig {
    /// Default sheet name (formulas without explicit sheet get this prefix)
    pub default_sheet: String,
    /// Whether to use `sheets.SheetName.A1` style or flat `s_SheetName_A1` style
    pub use_flat_vars: bool,
    /// Whether to emit `ctx.get("Sheet!A1")` calls instead of variable names.
    /// When true, overrides use_flat_vars. Preserves original sheet names.
    pub use_ctx_get: bool,
    /// Current cell's row number (1-based, for ROW() function). 0 = unknown.
    pub current_row: u32,
    /// Current cell's column number (1-based, for COLUMN() function). 0 = unknown.
    pub current_col: u32,
}

impl Default for TranspileConfig {
    fn default() -> Self {
        TranspileConfig {
            default_sheet: "Sheet1".to_string(),
            use_flat_vars: true,
            use_ctx_get: false,
            current_row: 0,
            current_col: 0,
        }
    }
}

// ---------------------------------------------------------------------------
// Cell reference → JS variable name
// ---------------------------------------------------------------------------

pub fn cell_ref_to_var(r: &CellRef, config: &TranspileConfig) -> String {
    let sheet = r.sheet.as_deref().unwrap_or(&config.default_sheet);
    if config.use_ctx_get {
        let escaped_sheet = sheet.replace('\\', "\\\\").replace('"', "\\\"");
        format!("ctx.get(\"{}!{}{}\")", escaped_sheet, r.col, r.row)
    } else if config.use_flat_vars {
        // Sanitize sheet name: spaces and special chars → underscore
        let safe_sheet: String = sheet
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '_' })
            .collect();
        format!("s_{}_{}{}", safe_sheet, r.col, r.row)
    } else {
        format!("sheets['{}']['{}{}']", sheet, r.col, r.row)
    }
}

/// Build the variable name for a cell given sheet name + address string
pub fn addr_to_var(sheet: &str, addr: &str, config: &TranspileConfig) -> String {
    if config.use_ctx_get {
        let escaped_sheet = sheet.replace('\\', "\\\\").replace('"', "\\\"");
        format!("ctx.get(\"{}!{}\")", escaped_sheet, addr)
    } else if config.use_flat_vars {
        let safe_sheet: String = sheet
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '_' })
            .collect();
        format!("s_{}_{}", safe_sheet, addr)
    } else {
        format!("sheets['{}']['{}']", sheet, addr)
    }
}

// ---------------------------------------------------------------------------
// Range expansion helper
// ---------------------------------------------------------------------------

fn expand_range_to_vars(r1: &CellRef, r2: &CellRef, config: &TranspileConfig) -> String {
    // In ctx.get mode, emit ctx.range("Sheet!A1:B10") for efficiency
    // This avoids expanding large ranges into thousands of individual ctx.get() calls
    if config.use_ctx_get {
        let sheet = r1.sheet.as_deref().unwrap_or(r2.sheet.as_deref().unwrap_or(&config.default_sheet));
        let escaped = sheet.replace('\\', "\\\\").replace('"', "\\\"");
        return format!(
            "ctx.range(\"{}!{}{}:{}{}\")",
            escaped, r1.col, r1.row, r2.col, r2.row
        );
    }

    // Parse column letters to numbers
    fn col_num(col: &str) -> u32 {
        col.bytes().fold(0u32, |acc, b| acc * 26 + (b - b'A' + 1) as u32)
    }
    fn num_to_col(mut n: u32) -> String {
        let mut s = String::new();
        while n > 0 {
            n -= 1;
            s.insert(0, (b'A' + (n % 26) as u8) as char);
            n /= 26;
        }
        s
    }

    let c1 = col_num(&r1.col);
    let c2 = col_num(&r2.col);
    let row1 = r1.row;
    let row2 = r2.row;
    let sheet = r1.sheet.as_deref().unwrap_or(r2.sheet.as_deref().unwrap_or("Sheet1"));

    let mut vars = Vec::new();
    let max_cells = 1000; // safety cap
    'outer: for r in row1..=row2 {
        for c in c1..=c2 {
            let col_str = num_to_col(c);
            vars.push(addr_to_var(sheet, &format!("{}{}", col_str, r), config));
            if vars.len() >= max_cells {
                break 'outer;
            }
        }
    }

    format!("[{}]", vars.join(", "))
}

// ---------------------------------------------------------------------------
// Main transpile function
// ---------------------------------------------------------------------------

pub fn transpile(expr: &Expr, config: &TranspileConfig) -> String {
    match expr {
        Expr::Number(n) => {
            // Avoid -0.0 and unnecessary decimal points
            if *n == n.floor() && n.abs() < 1e15 {
                format!("{}", *n as i64)
            } else {
                format!("{}", n)
            }
        }
        Expr::StringLit(s) => {
            // Escape backticks and backslashes
            let escaped = s.replace('\\', "\\\\").replace('`', "\\`").replace("${", "\\${");
            format!("`{}`", escaped)
        }
        Expr::Bool(b) => if *b { "true".to_string() } else { "false".to_string() },
        Expr::Error(e) => format!("/* {} */ null", e),
        // Unresolved bare identifier (Excel `#NAME?` / unresolved named range).
        // Emit `null` (numeric-safe: coerces to 0 in arithmetic, never NaN) with
        // an audit comment carrying the original name. NEVER emit a string literal
        // here — `number * "AO"` = NaN and poisons the dependent cone. See T-078.
        Expr::Name(name) => {
            let escaped = name.replace("*/", "* /");
            format!("/* #NAME? {} */ null", escaped)
        }

        Expr::CellRef(r) => cell_ref_to_var(r, config),

        Expr::Range(r1, r2) => expand_range_to_vars(r1, r2, config),

        Expr::DynRange { start, end } => {
            // Computed-endpoint range (`CF14:OFFSET(CF14,,-($F$12-2))`):
            // resolve both endpoints to corner-address expressions and span
            // the rectangle at runtime. An endpoint we cannot resolve to an
            // address (INDEX/INDIRECT/...) is an HONEST NaN — never a
            // truncated partial range (issue #66).
            if !config.use_ctx_get {
                return "(NaN /* computed range endpoint unsupported in flat-var mode */)".to_string();
            }
            match (dyn_range_corners(start, config), dyn_range_corners(end, config)) {
                (Some(a), Some(b)) => {
                    let mut corners = a;
                    corners.extend(b);
                    format!("_dynRange(ctx, [{}])", corners.join(", "))
                }
                _ => "(NaN /* unsupported computed range endpoint */)".to_string(),
            }
        }

        Expr::UnaryOp { op, operand } => {
            let inner = transpile(operand, config);
            match op.as_str() {
                "-" => format!("(-({}))", inner),
                "+" => inner,
                _ => format!("({}{})", op, inner),
            }
        }

        Expr::BinOp { op, left, right } => {
            let l = transpile(left, config);
            let r = transpile(right, config);
            match op.as_str() {
                "=" => format!("({} === {})", l, r),
                "<>" => format!("({} !== {})", l, r),
                "^" => format!("Math.pow({}, {})", l, r),
                "&" => format!("(String({}) + String({}))", l, r),
                // Excel `A/0` and `0/0` both produce #DIV/0!. Route every division through
                // _div so both collapse to ONE canonical sentinel (NaN) that IFERROR/
                // ISERROR/ISNUMBER already catch (post-#55, they test !Number.isFinite) —
                // instead of bare `(l / r)` which yields signed Infinity for `A/0` (which the
                // SUM reducer then PROPAGATES) and NaN for `0/0` (which it silently DROPS).
                "/" => format!("_div({}, {})", l, r),
                _ => format!("({} {} {})", l, op, r),
            }
        }

        Expr::FunctionCall { name, args } => transpile_function(name, args, config),

        Expr::ArrayLiteral(items) => {
            let parts: Vec<String> = items.iter().map(|e| transpile(e, config)).collect();
            format!("[{}]", parts.join(", "))
        }
    }
}

// ---------------------------------------------------------------------------
// Function transpilation
// ---------------------------------------------------------------------------

/// Resolve a DynRange endpoint to the JS expression(s) for its corner
/// address(es): a `"Sheet!A1"` literal for refs, `_offsetAddr(...)` calls for
/// an OFFSET endpoint (near + far corner when height/width are present).
/// `None` = the endpoint cannot be resolved to an address statically.
fn dyn_range_corners(e: &Expr, config: &TranspileConfig) -> Option<Vec<String>> {
    let lit = |r: &crate::formula_ast::CellRef| {
        let sheet_owned;
        let sheet = match &r.sheet {
            Some(s) => s.as_str(),
            None => {
                sheet_owned = config.default_sheet.clone();
                sheet_owned.as_str()
            }
        };
        let escaped = sheet.replace('\\', "\\\\").replace('"', "\\\"");
        format!("\"{}!{}{}\"", escaped, r.col, r.row)
    };
    match e {
        Expr::CellRef(r) => Some(vec![lit(r)]),
        Expr::Range(r1, r2) => Some(vec![lit(r1), lit(r2)]),
        Expr::FunctionCall { name, args } if name.to_uppercase() == "OFFSET" && !args.is_empty() => {
            let base = match &args[0] {
                Expr::CellRef(r) => lit(r),
                _ => return None,
            };
            let t = |i: usize, dflt: &str| {
                args.get(i)
                    .map(|a| transpile(a, config))
                    .unwrap_or_else(|| dflt.to_string())
            };
            let rows = t(1, "0");
            let cols = t(2, "0");
            let mut corners = vec![format!("_offsetAddr({}, ({}), ({}))", base, rows, cols)];
            if args.len() >= 4 {
                // height/width extend the endpoint to its far corner
                let h = t(3, "1");
                let w = t(4, "1");
                corners.push(format!(
                    "_offsetAddr({}, ({}) + ({}) - 1, ({}) + ({}) - 1)",
                    base, rows, h, cols, w
                ));
            }
            Some(corners)
        }
        _ => None,
    }
}

fn transpile_function(name: &str, args: &[Expr], config: &TranspileConfig) -> String {
    // Excel stores newer functions with future-function prefixes in the file
    // format: `_xlfn.` (e.g. MINIFS/MAXIFS/XNPV) and `_xlfn._xlws.` (dynamic-array
    // spills like FILTER/SORT/UNIQUE). Strip them so dispatch matches the bare
    // Excel name — otherwise `_XLFN._XLWS.FILTER` etc. fall through to the _fn()
    // stub even though the function is implemented.
    let raw_upper = name.to_uppercase();
    let name_upper = raw_upper
        .strip_prefix("_XLFN._XLWS.")
        .or_else(|| raw_upper.strip_prefix("_XLFN."))
        .or_else(|| raw_upper.strip_prefix("_XLWS."))
        .unwrap_or(&raw_upper)
        .to_string();

    // Helper: transpile a single arg
    let arg = |i: usize| -> String {
        args.get(i).map(|e| transpile(e, config)).unwrap_or_else(|| "undefined".to_string())
    };

    // Helper: transpile all args as array elements
    let args_joined = |sep: &str| -> String {
        args.iter().map(|e| transpile(e, config)).collect::<Vec<_>>().join(sep)
    };

    match name_upper.as_str() {
        // ----------------------------------------------------------------
        // Math / aggregation
        // ----------------------------------------------------------------
        "SUM" | "SUBTOTAL" => {
            // SUBTOTAL(function_num, range) — function_num 9 or 109 = SUM
            // We treat all SUBTOTAL variants as SUM for now (ignoring hidden rows)
            let sum_args = if name_upper == "SUBTOTAL" && args.len() >= 2 {
                &args[1..] // skip function_num argument
            } else {
                &args[..]
            };
            // Always use [].flat().reduce() pattern to safely handle both arrays and scalars
            let parts: Vec<String> = sum_args.iter().map(|a| {
                transpile(a, config)
            }).collect();
            format!("[{}].flat().reduce((a,b)=>a+_aggNum(b),0)", parts.join(","))
        }

        "SUMPRODUCT" => {
            // SUMPRODUCT(array1, array2, ...) → zip and multiply then sum.
            // _aggNum propagates a non-finite NUMBER (#DIV/0!) as NaN but treats text as 0.
            if args.len() == 1 {
                let arr = transpile(&args[0], config);
                return format!("[{}].flat().reduce((a,b)=>a+_aggNum(b),0)", arr);
            }
            if args.len() == 2 {
                let a0 = transpile(&args[0], config);
                let a1 = transpile(&args[1], config);
                // Wrap in IIFE to make self-contained expression
                // (prevents paren mismatches when used in SUMPRODUCT/SUM or IFERROR)
                return format!("(()=>{{const _a=[{}].flat(),_b=[{}].flat();return _a.reduce((acc,v,i)=>acc+(_aggNum(v)*_aggNum(_b[i])),0);}})()", a0, a1);
            }
            // 3+ arrays: multiply element-wise then sum (IIFE-wrapped)
            let arrays: Vec<String> = args.iter().map(|a| transpile(a, config)).collect();
            let arr_decls: Vec<String> = arrays.iter().enumerate()
                .map(|(i, a)| format!("const _a{}=[{}].flat()", i, a))
                .collect();
            let products: String = (1..arrays.len())
                .map(|i| format!("_aggNum(_a{}[i])", i))
                .collect::<Vec<_>>()
                .join("*");
            format!("(()=>{{{};return _a0.reduce((acc,v,i)=>acc+(_aggNum(v)*{}),0);}})()",
                arr_decls.join(","), products)
        }

        "SUMIF" | "SUMIFS" => {
            if name_upper == "SUMIF" {
                // SUMIF(criteria_range, criteria, [sum_range])
                let range = transpile(&args[0], config);
                let criteria = arg(1);
                let sum_range = if args.len() >= 3 {
                    transpile(&args[2], config)
                } else {
                    range.clone()
                };
                format!("_sumif({}, {}, {})", range, criteria, sum_range)
            } else {
                // SUMIFS(sum_range, criteria_range1, criteria1, criteria_range2, criteria2, ...)
                let sum_range = transpile(&args[0], config);
                let mut pairs = Vec::new();
                let mut i = 1;
                while i + 1 < args.len() {
                    let cr = transpile(&args[i], config);
                    let cv = transpile(&args[i + 1], config);
                    pairs.push(format!("[{}, {}]", cr, cv));
                    i += 2;
                }
                format!("_sumifs({}, [{}])", sum_range, pairs.join(", "))
            }
        }

        "COUNTIF" | "COUNTIFS" => {
            if name_upper == "COUNTIF" {
                // COUNTIF(range, criteria)
                let range = transpile(&args[0], config);
                let criteria = arg(1);
                format!("_countif({}, {})", range, criteria)
            } else {
                // COUNTIFS(criteria_range1, criteria1, criteria_range2, criteria2, ...)
                let mut pairs = Vec::new();
                let mut i = 0;
                while i + 1 < args.len() {
                    let cr = transpile(&args[i], config);
                    let cv = transpile(&args[i + 1], config);
                    pairs.push(format!("[{}, {}]", cr, cv));
                    i += 2;
                }
                format!("_countifs([{}])", pairs.join(", "))
            }
        }

        "MIN" => {
            let parts: Vec<String> = args.iter().map(|a| transpile(a, config)).collect();
            format!("Math.min(...[{}].flat())", parts.join(","))
        }

        "MAX" => {
            let parts: Vec<String> = args.iter().map(|a| transpile(a, config)).collect();
            format!("Math.max(...[{}].flat())", parts.join(","))
        }

        "MINIFS" | "MAXIFS" => {
            // MINIFS/MAXIFS(value_range, criteria_range1, criteria1, ...) —
            // mirrors SUMIFS criteria-pair handling, reducing to min/max instead of sum.
            let value_range = transpile(&args[0], config);
            let mut pairs = Vec::new();
            let mut i = 1;
            while i + 1 < args.len() {
                let cr = transpile(&args[i], config);
                let cv = transpile(&args[i + 1], config);
                pairs.push(format!("[{}, {}]", cr, cv));
                i += 2;
            }
            let helper = if name_upper == "MINIFS" { "_minifs" } else { "_maxifs" };
            format!("{}({}, [{}])", helper, value_range, pairs.join(", "))
        }

        "AVERAGEIF" | "AVERAGEIFS" => {
            if name_upper == "AVERAGEIF" {
                // AVERAGEIF(criteria_range, criteria, [average_range])
                let range = transpile(&args[0], config);
                let criteria = arg(1);
                let avg_range = if args.len() >= 3 {
                    transpile(&args[2], config)
                } else {
                    range.clone()
                };
                format!("_averageif({}, {}, {})", range, criteria, avg_range)
            } else {
                // AVERAGEIFS(average_range, criteria_range1, criteria1, ...) —
                // mirrors SUMIFS criteria-pair handling, reducing to the mean of matches.
                let value_range = transpile(&args[0], config);
                let mut pairs = Vec::new();
                let mut i = 1;
                while i + 1 < args.len() {
                    let cr = transpile(&args[i], config);
                    let cv = transpile(&args[i + 1], config);
                    pairs.push(format!("[{}, {}]", cr, cv));
                    i += 2;
                }
                format!("_averageifs({}, [{}])", value_range, pairs.join(", "))
            }
        }

        "ABS" => format!("Math.abs({})", arg(0)),
        "SQRT" => format!("Math.sqrt({})", arg(0)),
        "EXP" => format!("Math.exp({})", arg(0)),
        "LN" => format!("Math.log({})", arg(0)),
        "LOG" => {
            if args.len() >= 2 {
                format!("Math.log({}) / Math.log({})", arg(0), arg(1))
            } else {
                format!("Math.log10({})", arg(0))
            }
        }
        "LOG10" => format!("Math.log10({})", arg(0)),
        "INT" => format!("Math.trunc({})", arg(0)),
        "MOD" => format!("({} % {})", arg(0), arg(1)),
        "SIGN" => format!("Math.sign({})", arg(0)),
        "POWER" => format!("Math.pow({}, {})", arg(0), arg(1)),

        "ROUND" => format!("(Math.round(({}) * Math.pow(10, {})) / Math.pow(10, {}))", arg(0), arg(1), arg(1)),
        "ROUNDUP" => format!("(Math.ceil(({}) * Math.pow(10, {})) / Math.pow(10, {}))", arg(0), arg(1), arg(1)),
        "ROUNDDOWN" => format!("(Math.floor(({}) * Math.pow(10, {})) / Math.pow(10, {}))", arg(0), arg(1), arg(1)),
        "CEILING" | "CEILING.MATH" => format!("Math.ceil(({}) / ({})) * ({})", arg(0), arg(1), arg(1)),
        "FLOOR" | "FLOOR.MATH" => format!("Math.floor(({}) / ({})) * ({})", arg(0), arg(1), arg(1)),
        "TRUNC" => format!("Math.trunc({})", arg(0)),

        // ----------------------------------------------------------------
        // Logic
        // ----------------------------------------------------------------
        "IF" => format!("(({}) ? ({}) : ({}))", arg(0), arg(1), arg(2)),
        "IFS" => {
            // IFS(cond1, val1, cond2, val2, ...) → nested ternaries
            let mut result = String::from("undefined");
            for i in (0..args.len()).step_by(2).rev() {
                let cond = arg(i);
                let val = arg(i + 1);
                result = format!("(({}) ? ({}) : ({}))", cond, val, result);
            }
            result
        }
        "AND" => format!("({})", args.iter().map(|a| transpile(a, config)).collect::<Vec<_>>().join(" && ")),
        "OR" => format!("({})", args.iter().map(|a| transpile(a, config)).collect::<Vec<_>>().join(" || ")),
        "NOT" => format!("(!({}))", arg(0)),
        "TRUE" => "true".to_string(),
        "FALSE" => "false".to_string(),
        // Excel errors include #DIV/0! — which surfaces in JS as ±Infinity (x/0,
        // x!=0), NOT NaN. These predicates must treat any NON-FINITE number (NaN
        // AND ±Infinity) as an error, else IFERROR(x/0, fallback) leaks Infinity
        // and poisons the circular-cluster convergence (the lock-grade T-076
        // non-convergence root cause: ~194k IFERROR cells on Outpost A-1). The
        // `0/0`->NaN case was already caught; `x/0`->Infinity was the gap.
        "IFERROR" => format!("((() => {{ try {{ const _v = ({}); return (typeof _v === 'number' && !Number.isFinite(_v)) ? ({}) : _v; }} catch(e) {{ return {}; }} }})())", arg(0), arg(1), arg(1)),
        // `IF(ISERROR(x/0),…)` is the pre-IFERROR idiom and leaked the same Infinity.
        // `!isFinite` (coercing, like the old `isNaN`) catches NaN AND ±Infinity.
        "ISERROR" | "ISERR" => format!("(!isFinite({}) || ({}) === null)", arg(0), arg(0)),
        // #DIV/0! (Infinity) is not a number in Excel — `isFinite` excludes NaN/±Inf.
        "ISNUMBER" => format!("(typeof ({}) === 'number' && isFinite({}))", arg(0), arg(0)),
        "ISBLANK" => format!("(({}) == null || ({}) === ``)", arg(0), arg(0)),
        "ISTEXT" => format!("(typeof ({}) === 'string')", arg(0)),
        "ISLOGICAL" => format!("(typeof ({}) === 'boolean')", arg(0)),

        // ----------------------------------------------------------------
        // Lookup
        // ----------------------------------------------------------------
        "VLOOKUP" => {
            // VLOOKUP(lookup_value, table_array, col_index, [range_lookup])
            let val = arg(0);
            // VLOOKUP table must be 2D for col_index to work
            let arr = if config.use_ctx_get {
                match args.get(1) {
                    Some(Expr::Range(r1, r2)) => {
                        let sheet = r1.sheet.as_deref().unwrap_or(r2.sheet.as_deref().unwrap_or(&config.default_sheet));
                        let escaped = sheet.replace('\\', "\\\\").replace('"', "\\\"");
                        format!("ctx.range2d(\"{}!{}{}:{}{}\")", escaped, r1.col, r1.row, r2.col, r2.row)
                    }
                    _ => transpile(args.get(1).unwrap_or(&Expr::Number(0.0)), config),
                }
            } else {
                transpile(args.get(1).unwrap_or(&Expr::Number(0.0)), config)
            };
            let col_idx = arg(2);
            let exact = args.get(3)
                .map(|a| match a { Expr::Bool(false) => "true", Expr::Number(n) if *n == 0.0 => "true", _ => "false" })
                .unwrap_or("false");
            format!("_vlookup({}, {}, {}, {})", val, arr, col_idx, exact)
        }

        "HLOOKUP" => {
            let val = arg(0);
            // HLOOKUP table must be 2D for row_index to work
            let arr = if config.use_ctx_get {
                match args.get(1) {
                    Some(Expr::Range(r1, r2)) => {
                        let sheet = r1.sheet.as_deref().unwrap_or(r2.sheet.as_deref().unwrap_or(&config.default_sheet));
                        let escaped = sheet.replace('\\', "\\\\").replace('"', "\\\"");
                        format!("ctx.range2d(\"{}!{}{}:{}{}\")", escaped, r1.col, r1.row, r2.col, r2.row)
                    }
                    _ => transpile(args.get(1).unwrap_or(&Expr::Number(0.0)), config),
                }
            } else {
                transpile(args.get(1).unwrap_or(&Expr::Number(0.0)), config)
            };
            let row_idx = arg(2);
            let exact = args.get(3)
                .map(|a| match a { Expr::Bool(false) => "true", Expr::Number(n) if *n == 0.0 => "true", _ => "false" })
                .unwrap_or("false");
            format!("_hlookup({}, {}, {}, {})", val, arr, row_idx, exact)
        }

        "MATCH" => {
            let val = arg(0);
            let arr = transpile(args.get(1).unwrap_or(&Expr::Number(0.0)), config);
            let match_type = arg(2);
            format!("_match({}, {}, {})", val, arr, match_type)
        }

        "INDEX" => {
            let row_num = arg(1);
            let col_num = if args.len() >= 3 { arg(2) } else { "1".to_string() };
            // If the first arg is a Range and we have both row+col, use range2d for 2D lookup
            let has_col = args.len() >= 3;
            let arr = if config.use_ctx_get && has_col {
                // Check if first arg is a Range — emit range2d instead of range
                match args.first() {
                    Some(Expr::Range(r1, r2)) => {
                        let sheet = r1.sheet.as_deref().unwrap_or(r2.sheet.as_deref().unwrap_or(&config.default_sheet));
                        let escaped = sheet.replace('\\', "\\\\").replace('"', "\\\"");
                        format!("ctx.range2d(\"{}!{}{}:{}{}\")", escaped, r1.col, r1.row, r2.col, r2.row)
                    }
                    _ => arg(0), // fallback to normal transpilation
                }
            } else {
                arg(0)
            };
            format!("_index({}, {}, {})", arr, row_num, col_num)
        }

        "CHOOSE" => {
            // CHOOSE(index_num, val1, val2, ...) → array lookup
            let idx = arg(0);
            let vals: Vec<String> = args[1..].iter().map(|a| transpile(a, config)).collect();
            format!("[{}][({}) - 1]", vals.join(", "), idx)
        }

        "OFFSET" => {
            // OFFSET(reference, rows, cols, [height], [width])
            // First arg is a reference — we need the address string, not the value
            let ref_addr = match &args[0] {
                Expr::CellRef(r) => {
                    let sheet = r.sheet.as_deref().unwrap_or(&config.default_sheet);
                    let escaped = sheet.replace('\\', "\\\\").replace('"', "\\\"");
                    format!("\"{}!{}{}\"", escaped, r.col, r.row)
                }
                _ => {
                    // Fallback: emit the transpiled value (may not work for dynamic refs)
                    format!("\"__unknown__\"")
                }
            };
            let rows = arg(1);
            let cols = arg(2);
            let height = if args.len() >= 4 { arg(3) } else { "1".to_string() };
            let width = if args.len() >= 5 { arg(4) } else { "1".to_string() };
            format!("_offset(ctx, {}, {}, {}, {}, {})", ref_addr, rows, cols, height, width)
        }

        // ----------------------------------------------------------------
        // Text
        // ----------------------------------------------------------------
        "CONCATENATE" => {
            let parts: Vec<String> = args.iter().map(|a| format!("String({})", transpile(a, config))).collect();
            format!("({})", parts.join(" + "))
        }
        "CONCAT" | "TEXTJOIN" => {
            // Simplified — just concatenate
            let parts: Vec<String> = args.iter().map(|a| format!("String({})", transpile(a, config))).collect();
            format!("({})", parts.join(" + "))
        }
        "LEFT" => format!("String({}).slice(0, {})", arg(0), arg(1)),
        "RIGHT" => format!("String({}).slice(-({}))", arg(0), arg(1)),
        "MID" => format!("String({}).slice(({}) - 1, ({}) - 1 + ({}))", arg(0), arg(1), arg(1), arg(2)),
        "LEN" => format!("String({}).length", arg(0)),
        "TRIM" => format!("String({}).trim()", arg(0)),
        "UPPER" => format!("String({}).toUpperCase()", arg(0)),
        "LOWER" => format!("String({}).toLowerCase()", arg(0)),
        "TEXT" => format!("/* TEXT format */ String({})", arg(0)),
        "VALUE" => format!("Number({})", arg(0)),
        "FIND" | "SEARCH" => format!("(String({}).indexOf(String({})) + 1)", arg(1), arg(0)),
        "SUBSTITUTE" => format!("String({}).replaceAll(String({}), String({}))", arg(0), arg(1), arg(2)),
        "REPLACE" => format!("(String({}).slice(0, ({}) - 1) + String({}) + String({}).slice(({}) - 1 + ({})))", arg(0), arg(1), arg(3), arg(0), arg(1), arg(2)),
        "REPT" => format!("String({}).repeat({})", arg(0), arg(1)),
        "EXACT" => format!("(String({}) === String({}))", arg(0), arg(1)),
        "CHAR" => format!("String.fromCharCode({})", arg(0)),
        "CODE" => format!("String({}).charCodeAt(0)", arg(0)),

        // ----------------------------------------------------------------
        // Date / Time (approximate — use serial numbers)
        // ----------------------------------------------------------------
        "TODAY" => "/* TODAY */ 0".to_string(),
        "NOW" => "/* NOW */ 0".to_string(),
        // YEAR/MONTH/DAY must use the UTC/epoch-quirk-aware serial helper. The old
        // `new Date((s - 25569) * 86400000).getMonth()` used LOCAL-time getters, so
        // any runtime west of UTC read every serial one day early (DAY(Jun-30)=29),
        // shifting date-keyed COUNTIFS/SUMIFS windows and DATE(y,MONTH(x),DAY(x))
        // reconstructions by one day.
        "YEAR" => format!("/* YEAR */ _serialToYMD({}).y", arg(0)),
        "MONTH" => format!("/* MONTH */ _serialToYMD({}).m", arg(0)),
        "DAY" => format!("/* DAY */ _serialToYMD({}).d", arg(0)),
        // DATE/EDATE/EOMONTH return INTEGER Excel day-serials via calendar-exact
        // helpers. The old `*365.25`/`*30.44` float approximation drifted up to
        // ~2.88 days/year, breaking exact-equality SUMIFS/MINIFS date-key lookups
        // (issue #47). EDATE clamps short months; EOMONTH returns the last day.
        "DATE" => format!("/* DATE */ _excelSerialFromYMD({}, {}, {})", arg(0), arg(1), arg(2)),
        "DAYS" => format!("({} - {})", arg(0), arg(1)),
        "DATEDIF" => format!("/* DATEDIF */ ({} - {})", arg(1), arg(0)),
        // YEARFRAC's default basis 0 is US-NASD 30/360 — month-aligned spans
        // are EXACT (1, 0.5), which real models gate on with equality tests
        // like `MOD(YEARFRAC(...), x) = 0` and month counts `YEARFRAC*12+1`.
        // The old `(b-a)/365.25` drifted every such gate (issue #66).
        "YEARFRAC" => {
            let basis = if args.len() >= 3 { arg(2) } else { "0".to_string() };
            format!("_yearfrac({}, {}, {})", arg(0), arg(1), basis)
        }
        "EDATE" => format!("_edate({}, {})", arg(0), arg(1)),
        "EOMONTH" => format!("_eomonth({}, {})", arg(0), arg(1)),
        "NETWORKDAYS" => format!("/* NETWORKDAYS */ ({} - {})", arg(1), arg(0)),

        // ----------------------------------------------------------------
        // Financial
        // ----------------------------------------------------------------
        "IRR" => {
            let arr = transpile(args.get(0).unwrap_or(&Expr::Number(0.0)), config);
            format!("computeIRR({})", arr)
        }
        "XIRR" => {
            let vals = transpile(args.get(0).unwrap_or(&Expr::Number(0.0)), config);
            let dates = transpile(args.get(1).unwrap_or(&Expr::Number(0.0)), config);
            format!("computeXIRR({}, {})", vals, dates)
        }
        "NPV" => {
            let rate = arg(0);
            let cf_parts: Vec<String> = args[1..].iter().flat_map(|a| {
                if let Expr::Range(_, _) = a {
                    vec![format!("...{}", transpile(a, config))]
                } else {
                    vec![transpile(a, config)]
                }
            }).collect();
            format!("computeNPV({}, [{}])", rate, cf_parts.join(", "))
        }
        "PMT" => {
            // PMT(rate, nper, pv, [fv], [type])
            format!("computePMT({}, {}, {})", arg(0), arg(1), arg(2))
        }
        "PV" => format!("computePV({}, {}, {})", arg(0), arg(1), arg(2)),
        "FV" => format!("computeFV({}, {}, {})", arg(0), arg(1), arg(2)),
        "RATE" => format!("computeRATE({}, {}, {})", arg(0), arg(1), arg(2)),
        "NPER" => format!("computeNPER({}, {}, {})", arg(0), arg(1), arg(2)),
        "XNPV" => {
            // XNPV(rate, values, dates) — date-aware NPV (Excel 365-day basis)
            let rate = arg(0);
            let vals = transpile(args.get(1).unwrap_or(&Expr::Number(0.0)), config);
            let dates = transpile(args.get(2).unwrap_or(&Expr::Number(0.0)), config);
            format!("computeXNPV({}, {}, {})", rate, vals, dates)
        }

        // ----------------------------------------------------------------
        // Statistical
        // ----------------------------------------------------------------
        "AVERAGE" | "MEAN" => {
            // _aggNum propagates a #DIV/0! (non-finite number) into the numerator as NaN, so
            // AVERAGE over a #DIV/0! cell is #DIV/0! (was silently dropped, yielding e.g. 1.333).
            let parts: Vec<String> = args.iter().map(|a| transpile(a, config)).collect();
            format!("(()=>{{const _a=[{}].flat();return _a.reduce((a,b)=>a+_aggNum(b),0)/_a.filter(v=>v!=null).length}})()", parts.join(","))
        }
        "COUNT" | "COUNTA" => {
            let parts: Vec<String> = args.iter().map(|a| transpile(a, config)).collect();
            format!("[{}].flat().filter(v=>v!=null&&v!==``).length", parts.join(","))
        }
        "LARGE" => format!("_large({}, {})", arg(0), arg(1)),
        "SMALL" => format!("_small({}, {})", arg(0), arg(1)),
        "RANK" => format!("_rank({}, {}, {})", arg(0), arg(1), arg(2)),

        // ----------------------------------------------------------------
        // Misc / passthrough
        // ----------------------------------------------------------------
        "NA" => "null".to_string(),
        "ERROR.TYPE" => "null".to_string(),
        "ROW" => {
            if args.is_empty() && config.current_row > 0 {
                format!("{}", config.current_row)
            } else if !args.is_empty() {
                // ROW(ref) — extract row from reference (best-effort)
                format!("/* ROW(ref) */ 0")
            } else {
                format!("/* ROW: unknown cell */ 0")
            }
        }
        "COLUMN" => {
            if args.is_empty() && config.current_col > 0 {
                format!("{}", config.current_col)
            } else {
                format!("/* COLUMN */ 0")
            }
        }
        "ROWS" => format!("/* ROWS */ 1"),
        "COLUMNS" => format!("/* COLUMNS */ 1"),
        "TRANSPOSE" => format!("/* TRANSPOSE */ {}", arg(0)),
        "ADDRESS" => format!("(`R${{{}}}C${{{}}}`)", arg(0), arg(1)),
        "INDIRECT" => {
            if config.use_ctx_get {
                // In chunked/ctx.get mode, INDIRECT resolves a string address at runtime
                let sheet_prefix = format!("\"{}!\" + ", config.default_sheet);
                match args.first() {
                    Some(Expr::StringLit(s)) => {
                        // Static string like INDIRECT("Sheet!A1") → ctx.get("Sheet!A1")
                        let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
                        if escaped.contains('!') {
                            format!("ctx.get(\"{}\")", escaped)
                        } else {
                            // No sheet prefix — add the default sheet
                            format!("ctx.get(\"{}!{}\")", config.default_sheet, escaped)
                        }
                    }
                    _ => {
                        // Dynamic expression like INDIRECT("P"&ROW())
                        // Transpile the arg (& becomes string concat) and wrap in ctx.get()
                        // If the expression doesn't contain "!", prefix with the current sheet
                        let addr_expr = arg(0);
                        let addr_str = addr_expr.to_string();
                        if addr_str.contains('!') || addr_str.contains("\"!\"") {
                            format!("ctx.get(String({}))", addr_expr)
                        } else {
                            // Prefix with default sheet name
                            format!("ctx.get({}String({}))", sheet_prefix, addr_expr)
                        }
                    }
                }
            } else {
                format!("/* INDIRECT: dynamic ref not supported */ null")
            }
        }
        "CELL" => format!("/* CELL info */ null"),
        "TYPE" => format!("/* TYPE */ 1"),
        "N" => format!("(+({}) || 0)", arg(0)),
        "T" => format!("(typeof ({}) === 'string' ? ({}) : ``)", arg(0), arg(0)),

        "FILTER" => {
            // FILTER(array, include, [if_empty]) — subset of `array` where the
            // parallel `include` mask is truthy. Single-cell array value (this
            // engine has no multi-cell spill); replaces the _fn stub with real math.
            let array = transpile(&args[0], config);
            let include = transpile(args.get(1).unwrap_or(&Expr::Number(1.0)), config);
            let if_empty = if args.len() >= 3 { arg(2) } else { "0".to_string() };
            format!("_filter({}, {}, {})", array, include, if_empty)
        }

        // ----------------------------------------------------------------
        // Unknown function — emit a runtime placeholder call
        // ----------------------------------------------------------------
        other => {
            let a = args_joined(", ");
            format!("/* {} */ _fn('{}', {})", other, other, if a.is_empty() { "[]".to_string() } else { format!("[{}]", a) })
        }
    }
}

#[cfg(test)]
mod date_lowering_tests {
    use super::*;
    use crate::formula_ast::parse_formula;

    fn lower(formula: &str) -> String {
        let ast = parse_formula(formula).expect("formula should parse");
        transpile(&ast, &TranspileConfig::default())
    }

    // Issue #47: DATE/EDATE/EOMONTH must lower to the integer-serial calendar
    // helpers, NOT the old float-month `*30.44` / `*365.25` approximation that
    // drifted off integer Excel serials and broke exact-equality SUMIFS lookups.

    #[test]
    fn date_lowers_to_serial_helper() {
        let js = lower("DATE(2024,1,1)");
        assert!(js.contains("_excelSerialFromYMD("), "DATE should call helper, got: {js}");
        // Negative control: must NOT use the old float approximation.
        assert!(!js.contains("30.44"), "DATE must not use *30.44, got: {js}");
        assert!(!js.contains("365.25"), "DATE must not use *365.25, got: {js}");
    }

    #[test]
    fn edate_lowers_to_helper() {
        let js = lower("EDATE(A1,1)");
        assert!(js.contains("_edate("), "EDATE should call _edate, got: {js}");
        assert!(!js.contains("30.44"), "EDATE must not use *30.44, got: {js}");
    }

    #[test]
    fn eomonth_lowers_to_helper() {
        let js = lower("EOMONTH(A1,0)");
        assert!(js.contains("_eomonth("), "EOMONTH should call _eomonth, got: {js}");
        assert!(!js.contains("30.44"), "EOMONTH must not use *30.44, got: {js}");
    }
}

#[cfg(test)]
mod error_guard_lowering_tests {
    use super::*;
    use crate::formula_ast::parse_formula;

    fn lower(formula: &str) -> String {
        let ast = parse_formula(formula).expect("formula should parse");
        transpile(&ast, &TranspileConfig::default())
    }

    // Excel #DIV/0! surfaces as ±Infinity in JS (x/0, x!=0), NOT NaN. IFERROR /
    // ISERROR / ISNUMBER must treat any non-finite NUMBER as an error, else
    // IFERROR(x/0, fallback) leaks Infinity and poisons circular-cluster
    // convergence (lock-grade T-076 root cause).

    #[test]
    fn iferror_guards_infinity_not_just_nan() {
        let js = lower("IFERROR(A1/A2,0)");
        assert!(js.contains("!Number.isFinite(_v)"),
            "IFERROR must guard non-finite (NaN AND Infinity), got: {js}");
        assert!(!js.contains("isNaN(_v) &&"),
            "IFERROR must not use the NaN-only guard that leaks Infinity, got: {js}");
    }

    #[test]
    fn iserror_is_true_for_div_by_zero() {
        let js = lower("ISERROR(A1)");
        assert!(js.contains("!isFinite("),
            "ISERROR must be true for ±Infinity (#DIV/0!), got: {js}");
    }

    #[test]
    fn isnumber_is_false_for_div_by_zero() {
        let js = lower("ISNUMBER(A1)");
        assert!(js.contains("isFinite("),
            "ISNUMBER must exclude ±Infinity/NaN via isFinite, got: {js}");
        assert!(!js.contains("!isNaN("),
            "ISNUMBER must not use the NaN-only test that admits Infinity, got: {js}");
    }
}

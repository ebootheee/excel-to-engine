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
}

impl Default for TranspileConfig {
    fn default() -> Self {
        TranspileConfig {
            default_sheet: "Sheet1".to_string(),
            use_flat_vars: true,
        }
    }
}

// ---------------------------------------------------------------------------
// Cell reference → JS variable name
// ---------------------------------------------------------------------------

pub fn cell_ref_to_var(r: &CellRef, config: &TranspileConfig) -> String {
    let sheet = r.sheet.as_deref().unwrap_or(&config.default_sheet);
    if config.use_flat_vars {
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
    if config.use_flat_vars {
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

        Expr::CellRef(r) => cell_ref_to_var(r, config),

        Expr::Range(r1, r2) => expand_range_to_vars(r1, r2, config),

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

fn transpile_function(name: &str, args: &[Expr], config: &TranspileConfig) -> String {
    let name_upper = name.to_uppercase();

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
        "SUM" => {
            if args.len() == 1 {
                if let Expr::Range(_, _) = &args[0] {
                    let arr = transpile(&args[0], config);
                    return format!("{}.reduce((a,b)=>a+(+b||0),0)", arr);
                }
            }
            let parts: Vec<String> = args.iter().map(|a| {
                if let Expr::Range(_, _) = a {
                    format!("...{}", transpile(a, config))
                } else {
                    transpile(a, config)
                }
            }).collect();
            format!("[{}].reduce((a,b)=>a+(+b||0),0)", parts.join(","))
        }

        "SUMPRODUCT" => {
            // SUMPRODUCT(array1, array2, ...) → zip and multiply then sum
            if args.len() == 1 {
                let arr = transpile(&args[0], config);
                return format!("{}.reduce((a,b)=>a+(+b||0),0)", arr);
            }
            // Two arrays
            let a0 = transpile(&args[0], config);
            let a1 = transpile(&args[1], config);
            format!("{}.reduce((acc,v,i)=>acc+(+v||0)*({})[(i)]||0),0)", a0, a1)
        }

        "SUMIF" | "SUMIFS" => {
            // Approximate: return 0 (requires runtime data — engine should override)
            format!("/* SUMIF/SUMIFS approximated */ 0")
        }

        "COUNTIF" | "COUNTIFS" => {
            format!("/* COUNTIF/COUNTIFS approximated */ 0")
        }

        "MIN" => {
            let all: Vec<String> = args.iter().flat_map(|a| {
                if let Expr::Range(_, _) = a {
                    vec![format!("...{}", transpile(a, config))]
                } else {
                    vec![transpile(a, config)]
                }
            }).collect();
            format!("Math.min({})", all.join(","))
        }

        "MAX" => {
            let all: Vec<String> = args.iter().flat_map(|a| {
                if let Expr::Range(_, _) = a {
                    vec![format!("...{}", transpile(a, config))]
                } else {
                    vec![transpile(a, config)]
                }
            }).collect();
            format!("Math.max({})", all.join(","))
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
        "IFERROR" => format!("((() => {{ try {{ const _v = {}; return (isNaN(_v) && typeof _v === 'number') ? ({}) : _v; }} catch(e) {{ return {}; }} }})()", arg(0), arg(1), arg(1)),
        "ISERROR" | "ISERR" => format!("(isNaN({}) || ({}) === null)", arg(0), arg(0)),
        "ISNUMBER" => format!("(typeof ({}) === 'number' && !isNaN({}))", arg(0), arg(0)),
        "ISBLANK" => format!("(({}) == null || ({}) === ``)", arg(0), arg(0)),
        "ISTEXT" => format!("(typeof ({}) === 'string')", arg(0)),
        "ISLOGICAL" => format!("(typeof ({}) === 'boolean')", arg(0)),

        // ----------------------------------------------------------------
        // Lookup
        // ----------------------------------------------------------------
        "VLOOKUP" => {
            // VLOOKUP(lookup_value, table_array, col_index, [range_lookup])
            let val = arg(0);
            let arr = transpile(args.get(1).unwrap_or(&Expr::Number(0.0)), config);
            let col_idx = arg(2);
            let exact = args.get(3)
                .map(|a| match a { Expr::Bool(false) => "true", Expr::Number(n) if *n == 0.0 => "true", _ => "false" })
                .unwrap_or("false");
            format!("_vlookup({}, {}, {}, {})", val, arr, col_idx, exact)
        }

        "HLOOKUP" => {
            let val = arg(0);
            let arr = transpile(args.get(1).unwrap_or(&Expr::Number(0.0)), config);
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
            let arr = arg(0);
            let row_num = arg(1);
            let col_num = if args.len() >= 3 { arg(2) } else { "1".to_string() };
            format!("_index({}, {}, {})", arr, row_num, col_num)
        }

        "CHOOSE" => {
            // CHOOSE(index_num, val1, val2, ...) → array lookup
            let idx = arg(0);
            let vals: Vec<String> = args[1..].iter().map(|a| transpile(a, config)).collect();
            format!("[{}][({}) - 1]", vals.join(", "), idx)
        }

        "OFFSET" => {
            // OFFSET requires dynamic range — emit a comment + approximate with the reference
            format!("/* OFFSET: {} */ {}", args_joined(", "), arg(0))
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
        "YEAR" => format!("/* YEAR */ new Date(({} - 25569) * 86400000).getFullYear()", arg(0)),
        "MONTH" => format!("/* MONTH */ (new Date(({} - 25569) * 86400000).getMonth() + 1)", arg(0)),
        "DAY" => format!("/* DAY */ new Date(({} - 25569) * 86400000).getDate()", arg(0)),
        "DATE" => format!("/* DATE */ ({} * 365.25 + {} * 30.44 + {} - 25569)", arg(0), arg(1), arg(2)),
        "DAYS" => format!("({} - {})", arg(0), arg(1)),
        "DATEDIF" => format!("/* DATEDIF */ ({} - {})", arg(1), arg(0)),
        "YEARFRAC" => format!("/* YEARFRAC */ (({} - {}) / 365.25)", arg(1), arg(0)),
        "EDATE" => format!("({} + {} * 30.44)", arg(0), arg(1)),
        "EOMONTH" => format!("({} + {} * 30.44)", arg(0), arg(1)),
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

        // ----------------------------------------------------------------
        // Statistical
        // ----------------------------------------------------------------
        "AVERAGE" | "MEAN" => {
            let all: Vec<String> = args.iter().flat_map(|a| {
                if let Expr::Range(_, _) = a {
                    vec![format!("...{}", transpile(a, config))]
                } else {
                    vec![transpile(a, config)]
                }
            }).collect();
            let arr = format!("[{}]", all.join(", "));
            format!("({}.reduce((a,b)=>a+(+b||0),0) / {}.filter(v=>v!=null).length)", arr, arr)
        }
        "COUNT" | "COUNTA" => {
            let all: Vec<String> = args.iter().flat_map(|a| {
                if let Expr::Range(_, _) = a {
                    vec![format!("...{}", transpile(a, config))]
                } else {
                    vec![transpile(a, config)]
                }
            }).collect();
            format!("[{}].filter(v=>v!=null&&v!==``).length", all.join(", "))
        }
        "LARGE" => format!("_large({}, {})", arg(0), arg(1)),
        "SMALL" => format!("_small({}, {})", arg(0), arg(1)),
        "RANK" => format!("_rank({}, {}, {})", arg(0), arg(1), arg(2)),

        // ----------------------------------------------------------------
        // Misc / passthrough
        // ----------------------------------------------------------------
        "EOMONTH" => format!("({} + {} * 30)", arg(0), arg(1)),
        "NA" => "null".to_string(),
        "ERROR.TYPE" => "null".to_string(),
        "ROW" => {
            // ROW() with no args is hard to know statically — emit 0
            format!("/* ROW */ 0")
        }
        "COLUMN" => format!("/* COLUMN */ 0"),
        "ROWS" => format!("/* ROWS */ 1"),
        "COLUMNS" => format!("/* COLUMNS */ 1"),
        "TRANSPOSE" => format!("/* TRANSPOSE */ {}", arg(0)),
        "ADDRESS" => format!("(`R${{{}}}C${{{}}}`)", arg(0), arg(1)),
        "INDIRECT" => format!("/* INDIRECT: dynamic ref not supported */ null"),
        "CELL" => format!("/* CELL info */ null"),
        "TYPE" => format!("/* TYPE */ 1"),
        "N" => format!("(+({}) || 0)", arg(0)),
        "T" => format!("(typeof ({}) === 'string' ? ({}) : ``)", arg(0), arg(0)),

        // ----------------------------------------------------------------
        // Unknown function — emit a runtime placeholder call
        // ----------------------------------------------------------------
        other => {
            let a = args_joined(", ");
            format!("/* {} */ _fn('{}', {})", other, other, if a.is_empty() { "[]".to_string() } else { format!("[{}]", a) })
        }
    }
}

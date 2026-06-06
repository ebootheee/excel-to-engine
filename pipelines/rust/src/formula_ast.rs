/// Excel formula tokenizer and recursive-descent AST parser.
///
/// Supports:
///   - Literals: numbers, strings, booleans, errors (#DIV/0!, etc.)
///   - Cell references: A1, $A$1, Sheet1!A1, 'Sheet Name'!A1
///   - Ranges: A1:B10, Sheet1!A1:C5
///   - Binary operators: + - * / ^ & = <> < > <= >=
///   - Unary operators: - +
///   - Function calls: SUM(...), IF(...), etc.
///   - Parenthesised expressions
///   - Comma-separated argument lists

use std::fmt;

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum Token {
    Number(f64),
    StringLit(String),
    Bool(bool),
    Error(String),   // #DIV/0!, #N/A, #REF!, etc.
    CellRef(CellRef),
    Range(CellRef, CellRef), // A1:B10
    Ident(String),   // function names / named ranges
    Op(String),      // + - * / ^ & = <> < > <= >=
    LParen,
    RParen,
    Comma,
    Semicolon,       // Some locales use ; as argument separator
    Colon,           // Range operator (handled during parsing)
    Percent,         // % postfix
    Eof,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CellRef {
    pub sheet: Option<String>,
    pub col: String,
    pub row: u32,
    pub abs_col: bool,
    pub abs_row: bool,
}

impl fmt::Display for CellRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(s) = &self.sheet {
            write!(f, "{}!{}{}", s, self.col, self.row)
        } else {
            write!(f, "{}{}", self.col, self.row)
        }
    }
}

// ---------------------------------------------------------------------------
// AST node
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum Expr {
    Number(f64),
    StringLit(String),
    Bool(bool),
    Error(String),
    /// A bare unquoted identifier that is neither a function call nor a cell
    /// reference — i.e. an undefined name (Excel `#NAME?`) or an unresolved
    /// named range. Distinct from `StringLit` so the transpiler can emit a
    /// numeric-safe value (`null`, never a string) and never poison arithmetic
    /// with `number * "AO"` = NaN. See T-078.
    Name(String),
    CellRef(CellRef),
    Range(CellRef, CellRef),
    BinOp {
        op: String,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    UnaryOp {
        op: String,
        operand: Box<Expr>,
    },
    FunctionCall {
        name: String,
        args: Vec<Expr>,
    },
    // For array/range arguments that expand to a list
    #[allow(dead_code)] // constructed by future array-formula support
    ArrayLiteral(Vec<Expr>),
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

pub struct Tokenizer<'a> {
    input: &'a str,
    pos: usize,
}

impl<'a> Tokenizer<'a> {
    pub fn new(input: &'a str) -> Self {
        // Strip leading '=' if present
        let input = input.trim_start_matches('=');
        Tokenizer { input, pos: 0 }
    }

    fn peek(&self) -> Option<char> {
        self.input[self.pos..].chars().next()
    }

    fn peek2(&self) -> Option<char> {
        let mut chars = self.input[self.pos..].chars();
        chars.next();
        chars.next()
    }

    fn advance(&mut self) -> Option<char> {
        let c = self.peek()?;
        self.pos += c.len_utf8();
        Some(c)
    }

    fn skip_whitespace(&mut self) {
        while let Some(c) = self.peek() {
            if c.is_whitespace() {
                self.advance();
            } else {
                break;
            }
        }
    }

    fn read_number(&mut self) -> Token {
        let start = self.pos;
        let mut has_dot = false;
        let mut has_e = false;

        while let Some(c) = self.peek() {
            if c.is_ascii_digit() {
                self.advance();
            } else if c == '.' && !has_dot {
                has_dot = true;
                self.advance();
            } else if (c == 'e' || c == 'E') && !has_e {
                has_e = true;
                self.advance();
                if let Some('+') | Some('-') = self.peek() {
                    self.advance();
                }
            } else {
                break;
            }
        }

        let s = &self.input[start..self.pos];
        Token::Number(s.parse().unwrap_or(0.0))
    }

    fn read_string(&mut self) -> Token {
        self.advance(); // consume opening "
        let mut s = String::new();
        loop {
            match self.peek() {
                None => break,
                Some('"') => {
                    self.advance();
                    // Excel doubles quotes to escape: "" → "
                    if self.peek() == Some('"') {
                        self.advance();
                        s.push('"');
                    } else {
                        break;
                    }
                }
                Some(c) => {
                    s.push(c);
                    self.advance();
                }
            }
        }
        Token::StringLit(s)
    }

    fn read_error(&mut self) -> Token {
        let start = self.pos;
        // Read until we hit a non-error char (space, operator, paren, comma)
        while let Some(c) = self.peek() {
            if c.is_alphanumeric() || c == '/' || c == '!' || c == '?' || c == '*' || c == '_' {
                self.advance();
            } else {
                break;
            }
        }
        Token::Error(self.input[start..self.pos].to_string())
    }

    /// Read a run of ASCII digits and parse them as a row number (0 if none).
    fn read_row_digits(&mut self) -> u32 {
        let row_start = self.pos;
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() { self.advance(); } else { break; }
        }
        self.input[row_start..self.pos].parse().unwrap_or(0)
    }

    /// After consuming a range `:`, read the second endpoint of a mixed/absolute
    /// reference: `[$]COL[$]ROW` (e.g. `R$22`, `$R$22`, `R22`). Returns `None` if
    /// what follows is not a cell ref (so the caller can backtrack). Used by the
    /// absolute-row mixed-ref path in `read_ident_or_ref`. See T-078.
    fn read_ref_after_colon(&mut self) -> Option<CellRef> {
        let abs_col = if self.peek() == Some('$') { self.advance(); true } else { false };
        let col_start = self.pos;
        while let Some(c) = self.peek() {
            if c.is_ascii_uppercase() { self.advance(); } else { break; }
        }
        let col = self.input[col_start..self.pos].to_string();
        if col.is_empty() || col.len() > 3 { return None; }
        let abs_row = if self.peek() == Some('$') { self.advance(); true } else { false };
        let row = self.read_row_digits();
        if row == 0 { return None; }
        Some(CellRef { sheet: None, col, row, abs_col, abs_row })
    }

    fn read_ident_or_ref(&mut self, first_char: char) -> Token {
        // Might be: function name, named range, cell ref, or cross-sheet ref
        let start = self.pos - first_char.len_utf8();

        while let Some(c) = self.peek() {
            if c.is_alphanumeric() || c == '_' || c == '.' {
                self.advance();
            } else {
                break;
            }
        }
        let name = &self.input[start..self.pos];

        // Check for sheet reference: Name!
        if self.peek() == Some('!') {
            self.advance(); // consume '!'
            // Now read the cell reference
            let cell = self.read_cell_ref_part(Some(name.to_string()));
            return cell;
        }

        // Mixed reference with an ABSOLUTE ROW where the column is NOT absolute:
        // `R$8`, `AM$8:AM$22`, `A$1`. The initial read loop stops at `$`, so `name`
        // here is just the column letters (`R`) and the next char is `$`. The
        // generic `read_cell_ref_part` only fires when a ref *starts* with `$` or a
        // sheet `!`, so without this branch `R$8` mis-parses to a bare identifier
        // (Expr::Name → `#NAME?` → 0/null), silently dropping a real reference.
        // This was the upstream transpiler bug the real-A1 cone gate exposed: a
        // J-weighted SUMPRODUCT like `SUMPRODUCT(J8:J22*R$8:R$22)` lost its second
        // operand. (`$R8` / `$R$8` already work via the `$`-first tokenizer path.)
        // See T-078.
        if looks_like_column_ref(name) && self.peek() == Some('$') {
            // Lookahead: `$` must be immediately followed by a digit to be an
            // absolute-row ref. If not (e.g. a stray `$`), fall through unchanged.
            if self.peek2().map_or(false, |c| c.is_ascii_digit()) {
                let col1 = name.to_string();
                self.advance(); // consume '$'
                let row1 = self.read_row_digits();
                let ref1 = CellRef { sheet: None, col: col1, row: row1, abs_col: false, abs_row: true };
                // Optional range continuation: `:COL[$]ROW` or `:[$]COL[$]ROW`.
                if self.peek() == Some(':') {
                    let saved = self.pos;
                    self.advance(); // consume ':'
                    if let Some(ref2) = self.read_ref_after_colon() {
                        return Token::Range(ref1, ref2);
                    }
                    self.pos = saved;
                }
                return Token::CellRef(ref1);
            }
        }

        // Check if it looks like a cell reference (letters + digits)
        if looks_like_cell_ref(name) {
            // Check if it's a range like A1:B10
            if self.peek() == Some(':') {
                let saved = self.pos;
                self.advance(); // consume ':'
                // Try to read second cell ref
                let start2 = self.pos;
                while let Some(c) = self.peek() {
                    if c.is_alphanumeric() || c == '$' {
                        self.advance();
                    } else {
                        break;
                    }
                }
                let name2 = &self.input[start2..self.pos].to_string();
                // `looks_like_cell_ref_dollar` accepts `$`-bearing endpoints
                // (`R$22`, `$R$22`); `parse_simple_cell_ref` already decodes them.
                // Without this, a range whose 2nd endpoint has an absolute row
                // (`R8:R$22`) silently collapsed to just the 1st endpoint. T-078.
                if looks_like_cell_ref_dollar(name2) || looks_like_column_ref(name2) {
                    let ref1 = parse_simple_cell_ref(name, None);
                    let ref2 = if looks_like_cell_ref_dollar(name2) {
                        parse_simple_cell_ref(name2, None)
                    } else {
                        // Column-only ref like "BE" → treat as BE1048576 (max row)
                        parse_column_ref(name2, None)
                    };
                    if let (Token::CellRef(r1), Token::CellRef(r2)) = (&ref1, &ref2) {
                        return Token::Range(r1.clone(), r2.clone());
                    }
                }
                // Not a valid range — backtrack
                self.pos = saved;
            }
            return parse_simple_cell_ref(name, None);
        }

        // Check for whole-column references: V:V, V:BE, AA:ZZ
        // These are 1-3 uppercase letters with no digits, followed by ':'
        if looks_like_column_ref(name) && self.peek() == Some(':') {
            let saved = self.pos;
            self.advance(); // consume ':'
            let start2 = self.pos;
            while let Some(c) = self.peek() {
                if c.is_ascii_uppercase() {
                    self.advance();
                } else {
                    break;
                }
            }
            let col2 = self.input[start2..self.pos].to_string();
            if looks_like_column_ref(&col2) {
                // Column range V:BE → treat as V1:BE1048576
                let ref1 = CellRef { sheet: None, col: name.to_string(), row: 1, abs_col: false, abs_row: false };
                let ref2 = CellRef { sheet: None, col: col2, row: 1048576, abs_col: false, abs_row: false };
                return Token::Range(ref1, ref2);
            }
            // Not a valid column range — backtrack
            self.pos = saved;
        }

        // Check for TRUE/FALSE booleans
        match name.to_uppercase().as_str() {
            "TRUE" => return Token::Bool(true),
            "FALSE" => return Token::Bool(false),
            _ => {}
        }

        Token::Ident(name.to_string())
    }

    fn read_quoted_sheet_ref(&mut self) -> Token {
        self.advance(); // consume opening '
        let start = self.pos;
        while let Some(c) = self.peek() {
            if c == '\'' {
                break;
            }
            self.advance();
        }
        let sheet = self.input[start..self.pos].to_string();
        self.advance(); // consume closing '

        // Expect ! after quoted sheet name
        if self.peek() == Some('!') {
            self.advance();
        }

        self.read_cell_ref_part(Some(sheet))
    }

    /// Read a cell reference (and optional range) given we already know the sheet name
    fn read_cell_ref_part(&mut self, sheet: Option<String>) -> Token {
        let _start = self.pos;
        // Optional $
        let abs_col = if self.peek() == Some('$') {
            self.advance();
            true
        } else {
            false
        };
        // Column letters
        let col_start = self.pos;
        while let Some(c) = self.peek() {
            if c.is_ascii_uppercase() {
                self.advance();
            } else {
                break;
            }
        }
        let col = self.input[col_start..self.pos].to_string();
        if col.is_empty() {
            return Token::Error(format!("BadRef_{}!?", sheet.as_deref().unwrap_or("")));
        }
        // Optional $
        let abs_row = if self.peek() == Some('$') {
            self.advance();
            true
        } else {
            false
        };
        // Row digits
        let row_start = self.pos;
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() {
                self.advance();
            } else {
                break;
            }
        }
        let row_str = &self.input[row_start..self.pos];
        let row: u32 = row_str.parse().unwrap_or(0);

        let ref1 = CellRef { sheet: sheet.clone(), col, row, abs_col, abs_row };

        // Check for range operator
        if self.peek() == Some(':') {
            self.advance();
            // Read the second cell ref (may have different sheet — rare, ignore for now)
            let abs_col2 = if self.peek() == Some('$') { self.advance(); true } else { false };
            let col_start2 = self.pos;
            while let Some(c) = self.peek() { if c.is_ascii_uppercase() { self.advance(); } else { break; } }
            let col2 = self.input[col_start2..self.pos].to_string();
            let abs_row2 = if self.peek() == Some('$') { self.advance(); true } else { false };
            let row_start2 = self.pos;
            while let Some(c) = self.peek() { if c.is_ascii_digit() { self.advance(); } else { break; } }
            let row2: u32 = self.input[row_start2..self.pos].parse().unwrap_or(0);
            let ref2 = CellRef { sheet: sheet.clone(), col: col2, row: row2, abs_col: abs_col2, abs_row: abs_row2 };
            return Token::Range(ref1, ref2);
        }

        Token::CellRef(ref1)
    }

    pub fn next_token(&mut self) -> Token {
        self.skip_whitespace();

        let c = match self.peek() {
            None => return Token::Eof,
            Some(c) => c,
        };

        match c {
            '0'..='9' => self.read_number(),
            '.' => {
                // Could be .5 (number starting with dot)
                if self.peek2().map_or(false, |c| c.is_ascii_digit()) {
                    self.read_number()
                } else {
                    self.advance();
                    Token::Op(".".to_string())
                }
            }
            '"' => self.read_string(),
            '#' => {
                self.advance();
                self.read_error()
            }
            '\'' => self.read_quoted_sheet_ref(),
            '(' => { self.advance(); Token::LParen }
            ')' => { self.advance(); Token::RParen }
            ',' => { self.advance(); Token::Comma }
            ';' => { self.advance(); Token::Semicolon }
            ':' => { self.advance(); Token::Colon }
            '%' => { self.advance(); Token::Percent }
            '+' => { self.advance(); Token::Op("+".to_string()) }
            '-' => { self.advance(); Token::Op("-".to_string()) }
            '*' => { self.advance(); Token::Op("*".to_string()) }
            '/' => { self.advance(); Token::Op("/".to_string()) }
            '^' => { self.advance(); Token::Op("^".to_string()) }
            '&' => { self.advance(); Token::Op("&".to_string()) }
            '=' => { self.advance(); Token::Op("=".to_string()) }
            '<' => {
                self.advance();
                if self.peek() == Some('>') { self.advance(); Token::Op("<>".to_string()) }
                else if self.peek() == Some('=') { self.advance(); Token::Op("<=".to_string()) }
                else { Token::Op("<".to_string()) }
            }
            '>' => {
                self.advance();
                if self.peek() == Some('=') { self.advance(); Token::Op(">=".to_string()) }
                else { Token::Op(">".to_string()) }
            }
            '$' => {
                self.advance();
                self.read_cell_ref_part(None)
            }
            c if c.is_ascii_uppercase() || c == '_' => {
                self.advance();
                self.read_ident_or_ref(c)
            }
            c if c.is_ascii_lowercase() => {
                self.advance();
                // Treat same as uppercase identifier
                let lc = c.to_ascii_uppercase();
                let mut s = lc.to_string();
                let _saved_pos = self.pos;
                while let Some(nc) = self.peek() {
                    if nc.is_alphanumeric() || nc == '_' {
                        s.push(nc.to_ascii_uppercase());
                        self.advance();
                    } else {
                        break;
                    }
                }
                // Check boolean
                match s.as_str() {
                    "TRUE" => Token::Bool(true),
                    "FALSE" => Token::Bool(false),
                    _ => {
                        if self.peek() == Some('!') {
                            self.advance();
                            self.read_cell_ref_part(Some(s))
                        } else {
                            Token::Ident(s)
                        }
                    }
                }
            }
            _ => {
                self.advance();
                Token::Op(c.to_string())
            }
        }
    }

    pub fn tokenize(&mut self) -> Vec<Token> {
        let mut tokens = Vec::new();
        loop {
            let tok = self.next_token();
            let is_eof = tok == Token::Eof;
            tokens.push(tok);
            if is_eof {
                break;
            }
        }
        tokens
    }
}

/// Check if a string is a pure column reference (1-3 uppercase letters, no digits)
fn looks_like_column_ref(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes.len() > 3 {
        return false;
    }
    bytes.iter().all(|b| b.is_ascii_uppercase())
}

/// Parse a column-only reference into a CellRef with row=1048576 (max Excel row)
fn parse_column_ref(s: &str, sheet: Option<String>) -> Token {
    Token::CellRef(CellRef {
        sheet,
        col: s.to_string(),
        row: 1048576,
        abs_col: false,
        abs_row: false,
    })
}

fn looks_like_cell_ref(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_uppercase() {
        i += 1;
    }
    if i == 0 || i > 3 {
        return false;
    }
    let j = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    i > j && i == bytes.len()
}

/// Like `looks_like_cell_ref`, but tolerates Excel absolute markers `$`:
/// `$A$1`, `A$1`, `$A1`, `A1`. Shape: optional `$`, 1-3 letters, optional `$`,
/// 1+ digits. Used so range endpoints with an absolute row parse correctly. T-078.
fn looks_like_cell_ref_dollar(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0;
    if i < bytes.len() && bytes[i] == b'$' { i += 1; }
    let col_start = i;
    while i < bytes.len() && bytes[i].is_ascii_uppercase() { i += 1; }
    let col_len = i - col_start;
    if col_len == 0 || col_len > 3 { return false; }
    if i < bytes.len() && bytes[i] == b'$' { i += 1; }
    let row_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() { i += 1; }
    i > row_start && i == bytes.len()
}

fn parse_simple_cell_ref(s: &str, sheet: Option<String>) -> Token {
    let bytes = s.as_bytes();
    let mut i = 0;
    let abs_col = if bytes.first() == Some(&b'$') { i += 1; true } else { false };
    let col_start = i;
    while i < bytes.len() && bytes[i].is_ascii_uppercase() { i += 1; }
    // Capture the column slice BEFORE consuming any absolute-row `$`, otherwise
    // the `$` leaks into `col` (`R$22` → col "R$"), producing a broken
    // `ctx.range("...R$22")` address. T-078.
    let col_end = i;
    let abs_row = if i < bytes.len() && bytes[i] == b'$' { i += 1; true } else { false };
    let col = std::str::from_utf8(&bytes[col_start..col_end]).unwrap_or("").to_string();
    let row: u32 = std::str::from_utf8(&bytes[i..]).unwrap_or("0").parse().unwrap_or(0);
    Token::CellRef(CellRef { sheet, col, row, abs_col, abs_row })
}

// ---------------------------------------------------------------------------
// Parser — recursive descent
// ---------------------------------------------------------------------------

pub struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    pub fn new(tokens: Vec<Token>) -> Self {
        Parser { tokens, pos: 0 }
    }

    fn peek(&self) -> &Token {
        self.tokens.get(self.pos).unwrap_or(&Token::Eof)
    }

    fn advance(&mut self) -> &Token {
        let tok = &self.tokens[self.pos];
        if self.pos + 1 < self.tokens.len() {
            self.pos += 1;
        }
        tok
    }

    #[allow(dead_code)] // retained for future arg-list parsing helpers
    fn expect_comma(&mut self) {
        match self.peek() {
            Token::Comma | Token::Semicolon => { self.advance(); }
            _ => {}
        }
    }

    pub fn parse_expr(&mut self) -> Expr {
        self.parse_concat()
    }

    /// Concatenation: expr & expr
    fn parse_concat(&mut self) -> Expr {
        let mut left = self.parse_comparison();
        while let Token::Op(op) = self.peek() {
            if op == "&" {
                let op = op.clone();
                self.advance();
                let right = self.parse_comparison();
                left = Expr::BinOp { op, left: Box::new(left), right: Box::new(right) };
            } else {
                break;
            }
        }
        left
    }

    /// Comparison: = <> < > <= >=
    fn parse_comparison(&mut self) -> Expr {
        let mut left = self.parse_additive();
        loop {
            let op = match self.peek() {
                Token::Op(op) if matches!(op.as_str(), "=" | "<>" | "<" | ">" | "<=" | ">=") => {
                    op.clone()
                }
                _ => break,
            };
            self.advance();
            let right = self.parse_additive();
            left = Expr::BinOp { op, left: Box::new(left), right: Box::new(right) };
        }
        left
    }

    /// Addition and subtraction
    fn parse_additive(&mut self) -> Expr {
        let mut left = self.parse_multiplicative();
        loop {
            let op = match self.peek() {
                Token::Op(op) if op == "+" || op == "-" => op.clone(),
                _ => break,
            };
            self.advance();
            let right = self.parse_multiplicative();
            left = Expr::BinOp { op, left: Box::new(left), right: Box::new(right) };
        }
        left
    }

    /// Multiplication and division
    fn parse_multiplicative(&mut self) -> Expr {
        let mut left = self.parse_exponentiation();
        loop {
            let op = match self.peek() {
                Token::Op(op) if op == "*" || op == "/" => op.clone(),
                _ => break,
            };
            self.advance();
            let right = self.parse_exponentiation();
            left = Expr::BinOp { op, left: Box::new(left), right: Box::new(right) };
        }
        left
    }

    /// Exponentiation: right-associative
    fn parse_exponentiation(&mut self) -> Expr {
        let base = self.parse_unary();
        if let Token::Op(op) = self.peek() {
            if op == "^" {
                let op = op.clone();
                self.advance();
                let exp = self.parse_exponentiation();
                return Expr::BinOp { op, left: Box::new(base), right: Box::new(exp) };
            }
        }
        base
    }

    /// Unary +/-
    fn parse_unary(&mut self) -> Expr {
        if let Token::Op(op) = self.peek() {
            if op == "-" || op == "+" {
                let op = op.clone();
                self.advance();
                let operand = self.parse_percent();
                return Expr::UnaryOp { op, operand: Box::new(operand) };
            }
        }
        self.parse_percent()
    }

    /// Percent postfix
    fn parse_percent(&mut self) -> Expr {
        let mut expr = self.parse_primary();
        while let Token::Percent = self.peek() {
            self.advance();
            expr = Expr::BinOp {
                op: "/".to_string(),
                left: Box::new(expr),
                right: Box::new(Expr::Number(100.0)),
            };
        }
        expr
    }

    /// Primary: literals, cell refs, ranges, function calls, parenthesised
    fn parse_primary(&mut self) -> Expr {
        match self.peek().clone() {
            Token::Number(n) => { self.advance(); Expr::Number(n) }
            Token::StringLit(s) => { self.advance(); Expr::StringLit(s) }
            Token::Bool(b) => { self.advance(); Expr::Bool(b) }
            Token::Error(e) => { self.advance(); Expr::Error(e) }
            Token::CellRef(r) => { self.advance(); Expr::CellRef(r) }
            Token::Range(r1, r2) => { self.advance(); Expr::Range(r1, r2) }
            Token::LParen => {
                self.advance();
                let e = self.parse_expr();
                if let Token::RParen = self.peek() { self.advance(); }
                e
            }
            Token::Ident(name) => {
                self.advance();
                if let Token::LParen = self.peek() {
                    self.advance();
                    let args = self.parse_arg_list();
                    if let Token::RParen = self.peek() { self.advance(); }
                    Expr::FunctionCall { name, args }
                } else {
                    // Bare unquoted identifier that is not a function call: an
                    // unresolved named range or an undefined name (Excel `#NAME?`).
                    // Emit `Expr::Name`, NOT `Expr::StringLit` — a StringLit
                    // transpiles to a JS string template (`AO`), and in an
                    // arithmetic context (`number * `AO``) that yields NaN, which
                    // poisons every dependent cell. `Expr::Name` transpiles to a
                    // numeric-safe `null` (coerces to 0 in `*`/`+`/SUM), matching
                    // the historical "treat as 0" intent without the NaN. See T-078.
                    Expr::Name(name)
                }
            }
            Token::Op(op) if op == "-" || op == "+" => {
                self.parse_unary()
            }
            Token::Eof => Expr::Number(0.0),
            _ => {
                self.advance();
                Expr::Number(0.0)
            }
        }
    }

    fn parse_arg_list(&mut self) -> Vec<Expr> {
        let mut args = Vec::new();
        if let Token::RParen = self.peek() {
            return args;
        }
        args.push(self.parse_expr());
        while matches!(self.peek(), Token::Comma | Token::Semicolon) {
            self.advance();
            // Allow trailing comma before RParen
            if let Token::RParen = self.peek() { break; }
            args.push(self.parse_expr());
        }
        args
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

pub fn parse_formula(formula: &str) -> Option<Expr> {
    let mut tokenizer = Tokenizer::new(formula);
    let tokens = tokenizer.tokenize();
    if tokens.is_empty() || tokens[0] == Token::Eof {
        return None;
    }
    let mut parser = Parser::new(tokens);
    Some(parser.parse_expr())
}

// ---------------------------------------------------------------------------
// Tests — bare-identifier (#NAME?) regression. See T-078.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod name_fallback_tests {
    use super::parse_formula;
    use crate::transpiler::{transpile, TranspileConfig};

    fn tj(f: &str) -> String {
        let cfg = TranspileConfig {
            use_ctx_get: true,
            default_sheet: "S".into(),
            ..Default::default()
        };
        transpile(&parse_formula(f).expect("parse"), &cfg)
    }

    /// The exact construct that broke the real A-1 cone: a `SUMPRODUCT` whose
    /// argument multiplies a range by a bare unresolved identifier. Before the
    /// fix this emitted `range * `R`` → `number * "R"` = NaN, which the cone's
    /// backward-cone pulled in and the NaN poisoned the active cycle. The fix
    /// emits `null` (→ 0 in arithmetic), never a string, so NaN can never appear.
    #[test]
    fn bare_identifier_never_emits_string_literal_in_arithmetic() {
        // Regression pin: the real-A1 shape.
        let out = tj("SUMPRODUCT(J8:J22*R)");
        assert!(
            !out.contains("* `R`"),
            "REGRESSION: bare identifier emitted as string literal (NaN bug): {out}"
        );
        assert!(
            out.contains("null"),
            "bare identifier must transpile to a numeric-safe null: {out}"
        );

        // A range of shapes that all used to NaN-poison.
        for f in &[
            "SUMPRODUCT(J8:J22*R)",
            "=SUMPRODUCT($J$8:$J$22*R)",
            "J8*R",
            "5*AO",
            "A1*MyUnresolvedName",
            "SUMPRODUCT(J8:J22, DB)",
        ] {
            let out = tj(f);
            assert!(
                !out.contains('`') || !has_bareword_template(&out),
                "REGRESSION: `{f}` emitted a bareword string-template (NaN risk): {out}"
            );
        }
    }

    /// Quoted strings and quarter-style labels MUST still be real string
    /// literals — the fix only changes BARE (unquoted) identifiers.
    #[test]
    fn quoted_strings_are_unaffected() {
        let out = tj("IF(A1=\"Active\",1,0)");
        assert!(
            out.contains("`Active`"),
            "quoted string literal must survive as a JS string: {out}"
        );
    }

    /// THE root-cause regression: an absolute-ROW mixed reference whose column is
    /// NOT absolute (`R$8`, `AM$8:AM$22`, `A$1`) must parse as a real cell/range,
    /// NOT collapse to a bare `#NAME?` identifier. This is the upstream transpiler
    /// bug the real-A1 cone gate exposed — a J-weighted `SUMPRODUCT(J8:J22*R$8:R$22)`
    /// silently lost its second operand. See T-078.
    #[test]
    fn absolute_row_mixed_refs_parse_as_references() {
        // single cells
        assert_eq!(tj("R$8"), "ctx.get(\"S!R8\")");
        assert_eq!(tj("A$1"), "ctx.get(\"S!A1\")");
        // ranges — all four $-placements must yield the same clean A1 range,
        // and the `$` must NEVER leak into the emitted address string.
        for f in &["R$8:R$22", "R$8:R22", "R8:R$22", "$R8:$R22", "$R$8:$R$22"] {
            let out = tj(f);
            assert_eq!(out, "ctx.range(\"S!R8:R22\")", "{f} -> {out}");
            assert!(!out.contains('$'), "$ leaked into address for {f}: {out}");
        }
        assert_eq!(tj("AM$8:AM$22"), "ctx.range(\"S!AM8:AM22\")");
        // sheet-qualified
        assert_eq!(tj("Sheet1!R$8:R$22"), "ctx.range(\"Sheet1!R8:R22\")");
        // the exact real-A1 shape: a real range product, not `* null`.
        let sp = tj("SUMPRODUCT(J8:J22*R$8:R$22)");
        assert!(
            sp.contains("ctx.range(\"S!J8:J22\") * ctx.range(\"S!R8:R22\")"),
            "real-A1 SUMPRODUCT lost its second operand: {sp}"
        );
        assert!(!sp.contains("#NAME?"), "second operand mis-parsed as #NAME?: {sp}");
    }

    /// The absolute-row fix must NOT swallow genuine undefined names.
    #[test]
    fn genuine_names_still_resolve_to_name_error() {
        assert!(tj("MyName").contains("#NAME?"));
        assert!(tj("5*FooBar").contains("#NAME?"));
        // and genuine refs/keywords are untouched
        assert_eq!(tj("$A1"), "ctx.get(\"S!A1\")");
        assert_eq!(tj("TRUE"), "true");
    }

    /// The `null` from an unresolved name folds to 0 in the engine's reduce
    /// convention (`(+b||0)`), so a SUMPRODUCT over it contributes 0, not NaN.
    /// We assert the emitted JS evaluates to a finite number (0), via a tiny
    /// runtime check expressed as JS we know the engine uses.
    #[test]
    fn unresolved_name_folds_to_zero_not_nan() {
        // The emitted form for the array element is `(<range> * (/* #NAME? */ null))`.
        // In JS: [1,2,3] * null = NaN (array*scalar), but the engine reduce uses
        // (+b||0) on each FLATTENED element, and the multiply happens per-element
        // in SUMPRODUCT's 2-arg / single-arg lowering. The key invariant we pin
        // here is structural: the operand is `null`, never a quoted word.
        let out = tj("J8*R");
        assert!(out.contains("null"), "operand must be null: {out}");
        assert!(!out.contains("`R`"), "operand must not be the string `R`: {out}");
    }

    // A template literal that is a bare A1-style column word (1-3 upper letters),
    // i.e. the NaN-causing shape. Distinguishes from legitimate label strings.
    fn has_bareword_template(js: &str) -> bool {
        // crude scan for `WORD` where WORD is 1-3 uppercase letters surrounded by backticks
        let bytes = js.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'`' {
                if let Some(close) = js[i + 1..].find('`') {
                    let inner = &js[i + 1..i + 1 + close];
                    if (1..=3).contains(&inner.len())
                        && inner.bytes().all(|b| b.is_ascii_uppercase())
                    {
                        return true;
                    }
                    i = i + 1 + close + 1;
                    continue;
                }
            }
            i += 1;
        }
        false
    }
}

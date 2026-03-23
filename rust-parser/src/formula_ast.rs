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

        // Check if it looks like a cell reference (letters + digits)
        if looks_like_cell_ref(name) {
            return parse_simple_cell_ref(name, None);
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
        let start = self.pos;
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
                let saved_pos = self.pos;
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

fn parse_simple_cell_ref(s: &str, sheet: Option<String>) -> Token {
    let bytes = s.as_bytes();
    let mut i = 0;
    let abs_col = if bytes.first() == Some(&b'$') { i += 1; true } else { false };
    let col_start = i;
    while i < bytes.len() && bytes[i].is_ascii_uppercase() { i += 1; }
    let abs_row = if i < bytes.len() && bytes[i] == b'$' { i += 1; true } else { false };
    let col = std::str::from_utf8(&bytes[col_start..i]).unwrap_or("").to_string();
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
                    // Named range or unknown identifier — treat as 0 for now
                    Expr::StringLit(name)
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

use calamine::{open_workbook, Data, Range, Reader, Xlsx};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;

/// A single cell's extracted data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CellData {
    pub row: u32,
    pub col: u32,
    pub address: String,
    pub value: Option<CellValue>,
    pub formula: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "value")]
pub enum CellValue {
    Number(f64),
    Text(String),
    Bool(bool),
    Error(String),
    Empty,
}

/// A sheet's parsed data
#[derive(Debug, Serialize, Deserialize)]
pub struct SheetData {
    pub name: String,
    pub cells: Vec<CellData>,
    pub row_count: u32,
    pub col_count: u32,
    pub formula_cells: Vec<String>,
}

/// Full workbook parse result
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkbookData {
    pub sheets: Vec<SheetData>,
    pub sheet_names: Vec<String>,
    pub total_cells: usize,
    pub total_formula_cells: usize,
}

/// Convert column index (0-based) to Excel letter (A, B, ..., Z, AA, ...)
pub fn col_to_letter(col: u32) -> String {
    let mut result = String::new();
    let mut n = col + 1;
    while n > 0 {
        n -= 1;
        result.insert(0, (b'A' + (n % 26) as u8) as char);
        n /= 26;
    }
    result
}

/// Convert (row, col) to Excel address like "A1" (both 0-based)
pub fn cell_address(row: u32, col: u32) -> String {
    format!("{}{}", col_to_letter(col), row + 1)
}

pub fn parse_workbook(path: &Path) -> Result<WorkbookData, Box<dyn std::error::Error>> {
    let mut workbook: Xlsx<_> = open_workbook(path)?;
    let sheet_names: Vec<String> = workbook.sheet_names().to_vec();

    let mut sheets = Vec::new();
    let mut total_cells = 0usize;
    let mut total_formula_cells = 0usize;

    for (si, sheet_name) in sheet_names.clone().iter().enumerate() {
        eprint!(
            "\r[rust-parser]   Parsing sheet [{}/{}] {}...",
            si + 1,
            sheet_names.len(),
            sheet_name
        );
        std::io::stderr().flush().ok();
        match workbook.worksheet_range(sheet_name) {
            Ok(range) => {
                let sheet = parse_sheet(sheet_name, &range);
                total_cells += sheet.cells.len();
                total_formula_cells += sheet.formula_cells.len();
                sheets.push(sheet);
            }
            Err(e) => {
                eprintln!("\n[warn] Could not read sheet '{}': {}", sheet_name, e);
            }
        }
    }
    eprintln!(); // newline after progress

    // Extract formulas via worksheet_formula (requires separate pass)
    let mut workbook2: Xlsx<_> = open_workbook(path)?;
    eprintln!("[rust-parser]   Extracting formulas...");
    for (si, sheet) in sheets.iter_mut().enumerate() {
        eprint!(
            "\r[rust-parser]   Formulas [{}/{}] {} ({} cells)...",
            si + 1,
            sheet_names.len(),
            sheet.name,
            sheet.cells.len()
        );
        std::io::stderr().flush().ok();
        match workbook2.worksheet_formula(&sheet.name) {
            Ok(formula_range) => {
                // Build index: address -> position in cells vec for O(1) lookup
                let cell_index: HashMap<String, usize> = sheet
                    .cells
                    .iter()
                    .enumerate()
                    .map(|(i, c)| (c.address.clone(), i))
                    .collect();
                let formula_set: std::collections::HashSet<String> =
                    sheet.formula_cells.iter().cloned().collect();

                let (min_row, min_col) = formula_range.start().unwrap_or((0, 0));
                for (row_idx, row) in formula_range.rows().enumerate() {
                    for (col_idx, formula_str) in row.iter().enumerate() {
                        if formula_str.is_empty() {
                            continue;
                        }
                        let abs_row = min_row + row_idx as u32;
                        let abs_col = min_col + col_idx as u32;
                        let addr = cell_address(abs_row, abs_col);

                        if let Some(&idx) = cell_index.get(&addr) {
                            sheet.cells[idx].formula = Some(formula_str.clone());
                            if !formula_set.contains(&addr) {
                                sheet.formula_cells.push(addr);
                                total_formula_cells += 1;
                            }
                        } else {
                            // Formula cell with no computed value in the range
                            sheet.cells.push(CellData {
                                row: abs_row,
                                col: abs_col,
                                address: addr.clone(),
                                value: None,
                                formula: Some(formula_str.clone()),
                            });
                            if !formula_set.contains(&addr) {
                                sheet.formula_cells.push(addr);
                                total_formula_cells += 1;
                            }
                        }
                    }
                }
            }
            Err(_) => {
                // worksheet_formula not available for this sheet — skip
            }
        }
    }
    eprintln!(); // newline after formula progress
    Ok(WorkbookData {
        sheet_names,
        total_cells,
        total_formula_cells,
        sheets,
    })
}

fn parse_sheet(name: &str, range: &Range<Data>) -> SheetData {
    let mut cells = Vec::new();

    let (start_row, start_col) = range.start().unwrap_or((0, 0));
    let row_count = range.height() as u32;
    let col_count = range.width() as u32;

    for (row_idx, row) in range.rows().enumerate() {
        for (col_idx, cell) in row.iter().enumerate() {
            let abs_row = start_row + row_idx as u32;
            let abs_col = start_col + col_idx as u32;
            let addr = cell_address(abs_row, abs_col);

            let value = match cell {
                Data::Empty => None,
                Data::Float(f) => Some(CellValue::Number(*f)),
                Data::Int(i) => Some(CellValue::Number(*i as f64)),
                Data::String(s) => {
                    if s.is_empty() {
                        None
                    } else {
                        Some(CellValue::Text(s.clone()))
                    }
                }
                Data::Bool(b) => Some(CellValue::Bool(*b)),
                Data::Error(e) => Some(CellValue::Error(format!("{:?}", e))),
                Data::DateTime(dt) => Some(CellValue::Text(format!("{:?}", dt))),
                Data::DateTimeIso(s) => Some(CellValue::Text(s.clone())),
                Data::DurationIso(s) => Some(CellValue::Text(s.clone())),
            };

            if value.is_some() {
                cells.push(CellData {
                    row: abs_row,
                    col: abs_col,
                    address: addr,
                    value,
                    formula: None,
                });
            }
        }
    }

    SheetData {
        name: name.to_string(),
        cells,
        formula_cells: Vec::new(),
        row_count,
        col_count,
    }
}

// ---------------------------------------------------------------------------
// model-map.json schema (matches v1.1.0)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct ModelMap {
    pub version: String,
    pub source: String,
    pub sheets: Vec<SheetMeta>,
    pub stats: ModelStats,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SheetMeta {
    pub name: String,
    pub row_count: u32,
    pub col_count: u32,
    pub cell_count: usize,
    pub formula_count: usize,
    pub numeric_cells: Vec<NumericCell>,
    pub text_cells: Vec<TextCell>,
    pub formula_cells: Vec<FormulaCellMeta>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NumericCell {
    pub address: String,
    pub row: u32,
    pub col: u32,
    pub value: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TextCell {
    pub address: String,
    pub row: u32,
    pub col: u32,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FormulaCellMeta {
    pub address: String,
    pub row: u32,
    pub col: u32,
    pub formula: String,
    pub result: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ModelStats {
    pub total_sheets: usize,
    pub total_cells: usize,
    pub total_formula_cells: usize,
    pub total_numeric_cells: usize,
    pub total_text_cells: usize,
}

pub fn build_model_map(workbook: &WorkbookData, source_name: &str) -> ModelMap {
    let mut sheets = Vec::new();
    let mut total_numeric = 0usize;
    let mut total_text = 0usize;

    for sheet in &workbook.sheets {
        let mut numeric_cells = Vec::new();
        let mut text_cells = Vec::new();
        let mut formula_cells_meta = Vec::new();

        for cell in &sheet.cells {
            if let Some(formula) = &cell.formula {
                let result = match &cell.value {
                    Some(CellValue::Number(n)) => Some(*n),
                    _ => None,
                };
                formula_cells_meta.push(FormulaCellMeta {
                    address: cell.address.clone(),
                    row: cell.row,
                    col: cell.col,
                    formula: formula.clone(),
                    result,
                });
            } else {
                match &cell.value {
                    Some(CellValue::Number(n)) => {
                        numeric_cells.push(NumericCell {
                            address: cell.address.clone(),
                            row: cell.row,
                            col: cell.col,
                            value: *n,
                        });
                        total_numeric += 1;
                    }
                    Some(CellValue::Text(s)) => {
                        text_cells.push(TextCell {
                            address: cell.address.clone(),
                            row: cell.row,
                            col: cell.col,
                            value: s.clone(),
                        });
                        total_text += 1;
                    }
                    _ => {}
                }
            }
        }

        let formula_count = formula_cells_meta.len();

        sheets.push(SheetMeta {
            name: sheet.name.clone(),
            row_count: sheet.row_count,
            col_count: sheet.col_count,
            cell_count: sheet.cells.len(),
            formula_count,
            numeric_cells,
            text_cells,
            formula_cells: formula_cells_meta,
        });
    }

    let stats = ModelStats {
        total_sheets: workbook.sheets.len(),
        total_cells: workbook.total_cells,
        total_formula_cells: workbook.total_formula_cells,
        total_numeric_cells: total_numeric,
        total_text_cells: total_text,
    };

    ModelMap {
        version: "1.1.0".to_string(),
        source: source_name.to_string(),
        sheets,
        stats,
    }
}

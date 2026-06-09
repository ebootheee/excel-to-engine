#!/usr/bin/env node
/**
 * Regression for the #57 structural root — calamine's shared-formula expansion
 * corrupting mixed-anchor ($-anchored) references.
 *
 * xlsx stores a filled formula range ONCE (`<f t="shared" ref="C7:E7" si="0">` on
 * the master cell); every other member cell is just `<f t="shared" si="0"/>` and
 * the reader must re-derive its formula by offsetting the master's relative refs
 * while honoring `$` anchors. calamine 0.26.1's `replace_cell_names()` was
 * $-blind: a `$` split the ref token, so
 *   - `$AO17` (column-absolute)  was offset as if fully relative  → wrongly SHIFTED
 *   - `L$7` / `AO$698` (row-anchored, column-relative) never parsed → wrongly FROZEN
 * On Outpost A-1 this corrupted 1,745,461 member cells (30% of the model) and is
 * the structural root of the returns-cone zero-collapse (#57): the Equity capital
 * call schedule (AVERAGEIFS with frozen "&L$7" criteria + shifted $AO17:$MC17
 * ranges) computes 0 from a warm GT seed, zeroing class equityBasis
 * (Equity!AN122) and totalCarry (GPP Promote!D88) via honest #DIV/0! NaN (#60).
 * Fixed upstream in calamine 0.32 (absolute refs) + 0.35 (LOG10-as-cell-ref).
 *
 * SheetJS never writes shared formulas (each cell gets its full formula), which is
 * why the existing synthetic suite missed this class entirely. This test hand-zips
 * a minimal xlsx with REAL `<f t="shared">` groups, runs the REAL rust-parser
 * --chunked, and drives the emitted engine. RED on calamine 0.26 (D7=22 not 31,
 * cumulative SUMIFS D16=5 not 6), GREEN on >=0.35.
 *
 * Needs the rust-parser binary. Skips (exit 0) if it isn't built.
 *
 * Usage: node pipelines/rust/tests/test-shared-formula-anchors.mjs
 */

import { writeFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..', '..');
const exe = process.platform === 'win32' ? '.exe' : '';
const PARSER = [
  join(ROOT, 'pipelines/rust/target/release', `rust-parser${exe}`),
  join(ROOT, 'pipelines/rust/target/debug', `rust-parser${exe}`),
].find(existsSync);

if (!PARSER) {
  console.log('SKIP: rust-parser not built (cd pipelines/rust && cargo build --release)');
  process.exit(0);
}

let passed = 0, failed = 0;
const assert = (c, m) => { if (c) { passed++; } else { failed++; console.error(`  FAIL: ${m}`); } };
const near = (a, b, tol = 1e-9) => typeof a === 'number' && Math.abs(a - b) <= tol;

// ── minimal store-only ZIP writer (no deps; xlsx is just a zip) ──────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};
function zipStore(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameB = Buffer.from(name), data = Buffer.from(text), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameB.length, 26);
    locals.push(local, nameB, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameB.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ── fixture: one sheet, four shared-formula groups, cached <v> = Excel truth ──
// keys  row 2:  B2=10 C2=20 D2=30 E2=40
// vals  row 5:  B5=1  C5=2  D5=3  E5=4
// G1 (horizontal, master C7, ref C7:E7): =$B5+C$2
//     Excel: C7=21 D7=31 E7=41          calamine 0.26: D7=C5+C2=22, E7=D5+C2=23
// G2 (vertical, master C10, ref C10:C12): =C$2+$B10   with B10..B12=100,200,300
//     Excel: 120/220/320 (vertical fill is accident-correct on 0.26 — pin it anyway)
// G3 (horizontal, master C14, ref C14:E14): =LOG10(100)+C5
//     Excel: 4/5/6                       calamine <0.35 mangles LOG10 as a cell ref
// G4 (horizontal, master C16, ref C16:E16): =SUMIFS($B5:$E5,$B$2:$E$2,"<="&C$2)
//     cumulative window — a +1 range shift CANNOT cancel a frozen criteria key:
//     Excel: C16=3 D16=6 E16=10          calamine 0.26: D16=5, E16=7
const v = (r, val) => `<c r="${r}"><v>${val}</v></c>`;
const fm = (r, f, val, si, ref) => si === undefined
  ? `<c r="${r}"><f>${f}</f><v>${val}</v></c>`
  : ref
    ? `<c r="${r}"><f t="shared" ref="${ref}" si="${si}">${f}</f><v>${val}</v></c>`
    : `<c r="${r}"><f t="shared" si="${si}"/><v>${val}</v></c>`;

const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="B2:E16"/><sheetData>
<row r="2">${v('B2', 10)}${v('C2', 20)}${v('D2', 30)}${v('E2', 40)}</row>
<row r="5">${v('B5', 1)}${v('C5', 2)}${v('D5', 3)}${v('E5', 4)}</row>
<row r="7">${fm('C7', '$B5+C$2', 21, 0, 'C7:E7')}${fm('D7', '', 31, 0)}${fm('E7', '', 41, 0)}</row>
<row r="10">${v('B10', 100)}${fm('C10', 'C$2+$B10', 120, 1, 'C10:C12')}</row>
<row r="11">${v('B11', 200)}${fm('C11', '', 220, 1)}</row>
<row r="12">${v('B12', 300)}${fm('C12', '', 320, 1)}</row>
<row r="14">${fm('C14', 'LOG10(100)+C5', 4, 2, 'C14:E14')}${fm('D14', '', 5, 2)}${fm('E14', '', 6, 2)}</row>
<row r="16">${fm('C16', 'SUMIFS($B5:$E5,$B$2:$E$2,"&lt;="&amp;C$2)', 3, 3, 'C16:E16')}${fm('D16', '', 6, 3)}${fm('E16', '', 10, 3)}</row>
</sheetData></worksheet>`;

const xlsx = zipStore([
  ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
  ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
  ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`],
  ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
  ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf/></cellXfs></styleSheet>`],
  ['xl/worksheets/sheet1.xml', sheetXml],
]);

console.log('Testing: shared-formula $-anchor expansion through the real rust-parser (#57 structural root)');

const tmp = mkdtempSync(join(tmpdir(), 'shanchor-'));
let values;
try {
  writeFileSync(join(tmp, 'm.xlsx'), xlsx);
  execFileSync(PARSER, [join(tmp, 'm.xlsx'), join(tmp, 'out'), '--chunked'], { encoding: 'utf-8', stdio: 'pipe' });
  const eng = await import(pathToFileURL(join(tmp, 'out', 'chunked', 'engine.js')).href);
  values = eng.run().values;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// G1 — the A-1 killer: row-anchored key must SHIFT, column-absolute ref must FREEZE
assert(near(values['S!C7'], 21), `master C7 = $B5+C$2 = 21 (got ${values['S!C7']})`);
assert(near(values['S!D7'], 31), `member D7 must be $B5+D$2 = 31 (got ${values['S!D7']}) — 0.26 froze C$2 and shifted $B5 -> 22`);
assert(near(values['S!E7'], 41), `member E7 must be $B5+E$2 = 41 (got ${values['S!E7']}) — 0.26 gave 23`);

// G2 — vertical fill with both anchor kinds stays correct
assert(near(values['S!C10'], 120), `master C10 = 120 (got ${values['S!C10']})`);
assert(near(values['S!C11'], 220), `member C11 = C$2+$B11 = 220 (got ${values['S!C11']})`);
assert(near(values['S!C12'], 320), `member C12 = C$2+$B12 = 320 (got ${values['S!C12']})`);

// G3 — LOG10 must not be offset as a cell reference (calamine 0.35 fix)
assert(near(values['S!C14'], 4), `master C14 = LOG10(100)+C5 = 4 (got ${values['S!C14']})`);
assert(near(values['S!D14'], 5), `member D14 = LOG10(100)+D5 = 5 (got ${values['S!D14']}) — <0.35 mangled LOG10 into a shifted cell ref`);
assert(near(values['S!E14'], 6), `member E14 = LOG10(100)+E5 = 6 (got ${values['S!E14']})`);

// G4 — cumulative SUMIFS with frozen $ ranges + shifting key (no shift/freeze cancellation)
assert(near(values['S!C16'], 3), `master C16 = SUMIFS(.. "<="&C$2) = 3 (got ${values['S!C16']})`);
assert(near(values['S!D16'], 6), `member D16 = SUMIFS($B5:$E5, $B$2:$E$2, "<="&D$2) = 6 (got ${values['S!D16']}) — 0.26 shifted the $ range and froze the key -> 5`);
assert(near(values['S!E16'], 10), `member E16 = 10 (got ${values['S!E16']}) — 0.26 gave 7`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

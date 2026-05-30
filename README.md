# excel-to-engine

> Turn your Excel financial model into a live, queryable engine — and a clean
> JavaScript bundle your developer (or AI coding agent) can drop into a web app.
> **You don't have to be a programmer to use it.**

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## Who this is for

You built (or inherited) a financial model in Excel — an LBO, a fund waterfall,
a real-estate pro forma, a 3-statement model, a venture portfolio. You want to:

- **explore scenarios** without breaking the spreadsheet ("what's IRR if we exit at 12×?"), or
- **turn it into an interactive web app** — e.g. a what-if explorer you can share with LPs or an IC.

This toolkit does both. It reads your `.xlsx`, reproduces every formula in
JavaScript, and hands you (a) a question-answering CLI and (b) a self-contained
JS **engine** with a documented input/output contract a developer can wire into
an app in an afternoon.

> **The easiest way to use this is with an AI coding assistant** (Claude Code,
> Cursor, Copilot, etc.). You talk; it runs the commands. See **[GETTING_STARTED.md](GETTING_STARTED.md)**
> for the copy-paste prompts. If you'd rather drive it yourself, the manual
> steps are below.

---

## The 3-minute path (with an AI assistant)

1. **Open this repo in your AI coding assistant** and put your model file next to it.
2. Say:

   > *"I'm not a programmer. I have a financial model at `my-model.xlsx`. Set this
   > repo up and convert my model into an engine, then walk me through what it found."*

3. The assistant runs the one-time setup, runs `init`, and shows you a plain-English
   summary. **Sanity-check the numbers against your spreadsheet.** If something
   looks off, just say so — there are built-in tools to correct it.
4. When you're happy, say:

   > *"Great. Now give me the engine bundle and a guide so my developer can build
   > a web app from it."*

   You'll get a folder containing the engine plus an **`INTEGRATION.md`** and a
   runnable **`example.mjs`** — everything a coding agent needs.

That's the whole journey: **Excel → verified engine → web app**, with the
assistant doing the typing.

---

## What you get

| Input | Output |
|-------|--------|
| One `.xlsx` file | A JS **engine** (`engine.js` with a `run()` function), a machine-readable **input/output contract** (`named-inputs.json` / `named-outputs.json`), a **scenario CLI** (`ete`), and a tailored **integration guide** for developers. |

- **The engine reproduces your spreadsheet's math.** `run()` executes the actual
  transpiled formulas, so the numbers match Excel. A built-in check confirms it
  reproduces your base case.
- **A documented contract.** Every lever (input) and answer (output) has a human
  name, a cell address, a base-case value, and a "what does this affect" map — so
  a developer never has to reverse-engineer your spreadsheet.
- Works on models from 3 KB to 84 MB (2–82 sheets, up to 6M cells). Validated at
  **99.3%** blind-eval accuracy across a suite of real models (149/150 questions,
  15.5M cells).

---

## For the developer / coding agent

If an analyst handed you a converted model folder, **open `chunked/INTEGRATION.md`
and run `node chunked/example.mjs`.** That's the fast path. In short:

```js
import { run } from './engine.js';

const base = run();                                   // base case (matches Excel)
const alt  = run({ "Assumptions!B4": 14 });           // override a lever, recompute everything
console.log(alt.values["IC Summary!B13"]);            // read an output by cell
```

- `named-outputs.json` maps friendly names → cells (+ base-case values to spot-check against).
- `named-inputs.json` lists the levers (+ which outputs each one affects).
- It's plain ES modules, zero dependencies — runs in Node and the browser.

See **[GETTING_STARTED.md](GETTING_STARTED.md)** → *"Build a web app"* for a full wiring sketch.

---

## Manual setup (if you're not using an assistant)

**Prerequisites:** Node.js 18+ and (one-time) the Rust toolchain to build the parser.

```bash
git clone https://github.com/ebootheee/excel-to-engine.git
cd excel-to-engine
npm install

# One-time: build the Excel parser (this is the only build step)
npm run build:parser          # = cargo build --release in pipelines/rust
#   No Rust? Install it from https://rustup.rs/ first.

# Check everything is ready (tells you exactly what's missing, if anything):
npm run check-env
```

Then convert a model and ask questions:

```bash
# Parse your model → engine + manifest + contract + integration guide, in one step
node cli/index.mjs init my-model.xlsx --output ./my-model/

# Look at what it found
node cli/index.mjs summary ./my-model/chunked/

# Explore scenarios
node cli/index.mjs scenario ./my-model/chunked/ --exit-multiple 16
node cli/index.mjs sensitivity ./my-model/chunked/ --vary exit-multiple:14-22:2 --metric grossIRR
```

> Tip: `npm link` (or `npx ete`) lets you type `ete …` instead of
> `node cli/index.mjs …`. The examples below use the long form so they work
> without linking.

---

## CLI Commands

### `ete summary` — Model Overview

```
$ node cli/index.mjs summary ./my-model/chunked/

Model: Example Fund (pe_platform)
Period: 2024–2030 (6yr, annual) | Exit: 2030 @ 18.5x EBITDA

Revenue Segments                       Start        Exit        CAGR
  Real Estate NOI                     $45.2M      $52.1M        2.4%
  Technology Gross Profit              $8.3M      $22.7M       18.3%

Platform EBITDA             $41.4M → $59.0M  (CAGR: 6.1%)
Terminal Value              $1.1B

Returns                    Gross         Net
  MOIC                     2.85x       2.45x
  IRR                      28.4%       24.1%

Carry: $50.3M (3 tiers), 8% pref
Equity: 1 class (Series A), basis $270.0M
```

### `ete verify` — Confirm the engine matches your spreadsheet

```bash
node cli/index.mjs verify ./my-model/chunked/
# → "✓ engine.run() reproduces the model's base case exactly. Safe to hand off."
```

Runs the generated engine with no overrides and checks every named output against
its base-case value. The trust signal to run before handing the bundle to a
developer (also available as `ete init --verify`).

### `ete query` — Find Anything

```bash
node cli/index.mjs query ./my-model/chunked/ --search "headcount"     # search by label
node cli/index.mjs query ./my-model/chunked/ "Valuation!K54"          # look up a cell
node cli/index.mjs query ./my-model/chunked/ --name grossIRR          # look up by name
```

### `ete scenario` — What-If Analysis

```bash
node cli/index.mjs scenario ./my-model/chunked/ --exit-multiple 16
node cli/index.mjs scenario ./my-model/chunked/ \
  --exit-multiple 14 --exit-year 2033 --revenue-adj techGP:-20% --cost-adj technology:+10%
node cli/index.mjs scenario ./my-model/chunked/ --exit-multiple 14 --save "bear"
```

**Full parameter set:**

| Category | Parameters |
|----------|-----------|
| Exit | `--exit-year`, `--exit-multiple`, `--revenue-multiple` |
| Revenue | `--revenue-adj seg:±%/$`, `--revenue-growth seg:rate`, `--remove-segment`, `--add-revenue`, `--override-arr` |
| Cost | `--cost-adj seg:±%/$`, `--line-item id:adj`, `--cost-ratio seg:ratio`, `--capitalize item:years` |
| Capital | `--leverage ltv`, `--equity-override`, `--distribution year:amount` |
| Valuation | `--sotp`, `--segment-multiple seg:n`, `--discount-rate` |
| Returns | `--pref-return rate`, `--hold-period years` |
| Scenarios | `--file scenario.json`, `--save name`, `--load name`, `--list` |
| Output | `--metric list`, `--format table\|json\|csv\|markdown`, `--attribution` |

### `ete sensitivity` — IRR/MOIC Surfaces

```bash
node cli/index.mjs sensitivity ./my-model/chunked/ --vary exit-multiple:14-22:2 --metric grossIRR,grossMOIC
node cli/index.mjs sensitivity ./my-model/chunked/ --vary exit-multiple:14-22:2 --vary exit-year:2028-2034:1 --metric grossIRR
```

### `ete carry` — Waterfall GP Carry

```bash
node cli/index.mjs carry ./my-model/chunked/                              # from the manifest
node cli/index.mjs carry --peak 500e6 --moc 2.8 --life 4.7 --pref 0.08 --carry 0.20 --ownership 0.06
```

### `ete compare`, `ete extract`, `ete explain`, `ete eval`, `ete manifest`

Side-by-side scenarios with attribution; time-series schedules (capital calls,
distributions, debt); audit trails; exact formula evaluation; and manifest
configuration. Run `node cli/index.mjs --help` for the full list, or see
[skill/SKILL.md](skill/SKILL.md).

---

## How It Works

```
Excel (.xlsx)
  → Rust parser (calamine, 10–50x faster than SheetJS)
    → Per-sheet JS modules (formulas transpiled to JavaScript)  ──┐
    → Ground truth JSON (every cell value from Excel)             │
    → Model manifest (financial concepts → cells)                 ├─→  engine.js (run())
    → Contract maps (named-outputs / named-inputs / cell-types)  ─┘    + INTEGRATION.md + example.mjs
      → CLI scenario engine (instant what-ifs via a delta cascade)
```

`ete init` does all of this in one step and finishes by emitting the developer
handoff bundle (`INTEGRATION.md` + `example.mjs`) into the output folder.

### Two ways to compute a scenario

- **`engine.run()`** executes the model's actual transpiled formulas — exact,
  the right choice for an app's production math.
- **The CLI's `scenario`/`sensitivity`** use a fast first-order approximation (a
  "delta cascade") for instant analyst queries. Great for exploration; use
  `run()` when you need numbers that tie out to the penny.

### Downstream contract artifacts

`ete init` emits small JSON files so an app can wire up the engine **by name, at
build time** — without running it to discover which cells hold the outputs:

| File | Shape | Use |
|------|-------|-----|
| **`named-outputs.json`** | `name → { cell, baseCaseValue, format, dependsOnNamedInputs }` | The answers your UI shows. Spot-check `run().values[cell]` vs `baseCaseValue`. |
| **`named-inputs.json`** | `name → { cell, default, affectsOutputs }` | The levers. Drive `run({ [cell]: value })`. |
| **`cell-types.json`** | `cell → "number" \| "label" \| "boolean" \| "empty"` | Tell a label from a number, a real `0` from a never-computed cell. |
| **`INTEGRATION.md`** + **`example.mjs`** | docs + runnable demo | The developer/coding-agent on-ramp. |

---

## Accuracy

A fresh Claude API session with zero knowledge of the engine answers 25
randomized financial questions per model:

| Model | Sheets | Cells | Blind Eval |
|-------|--------|-------|------------|
| Fund model A | 2 | 5.7K | **25/25 (100%)** |
| Fund model B | 7 | 96K | **25/25 (100%)** |
| Platform model A | 51 | 1.8M | **25/25 (100%)** |
| Platform model B | 60 | 1.8M | **25/25 (100%)** |
| Corporate model A | 20 | 5.8M | **25/25 (100%)** |
| Corporate model B | 21 | 6.1M | **24/25 (96%)** |
| **Total** | | **15.5M cells** | **149/150 (99.3%)** |

~60 Excel functions transpiled: `SUM`, `IF`, `VLOOKUP`, `INDEX/MATCH`, `IRR`,
`XIRR`, `NPV`, `PMT`, `SUMIFS`, `COUNTIFS`, `INDIRECT`, `OFFSET`, and more.

---

## Use with Claude Code (or any AI assistant)

The toolkit ships a skill (`skill/SKILL.md`) that translates natural language
into CLI commands, so you can ask questions instead of memorizing flags:

```
"What happens to returns if tech grows at 40% instead of 30%?"
"Show me a sensitivity table for exit multiples and timing"
"Build me bear, base, and bull cases for the board deck"
```

The assistant handles model conversion, cell references, and the manifest behind
the scenes. See **[GETTING_STARTED.md](GETTING_STARTED.md)** for the guided flow.

---

## Project Structure

```
excel-to-engine/
├── cli/                 # The `ete` command (init, summary, query, pnl, scenario, …)
├── lib/                 # IRR, waterfall, manifest, contract maps, integration-doc, verify-engine
├── skill/SKILL.md       # AI-assistant skill (natural language → CLI)
├── pipelines/rust/      # Excel → JS transpiler (the parser you build once)
├── eval/                # Blind-eval accuracy harness (optional; needs an API key)
├── tests/               # CLI + onboarding + use-case suites
└── GETTING_STARTED.md   # The guided "walk me through it" companion
```

## License

MIT

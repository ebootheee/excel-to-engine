# excel-to-engine

> Turn your Excel financial model into a live, queryable engine — and a clean
> JavaScript bundle your developer (or AI coding agent) can drop into a web app.
> **You don't have to be a programmer to use it.**

[![CI](https://github.com/ebootheee/excel-to-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/ebootheee/excel-to-engine/actions/workflows/ci.yml)
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

### `ete lite` — Right-sized extraction (KB instead of MB)

```bash
node cli/index.mjs lite ./my-model/chunked/ --output grossIRR,totalCarry --use-case dashboard
```

When a consumer only needs a handful of outputs (a dashboard tile, a what-if
slider), it shouldn't have to ship a multi-MB engine. `lite` walks a 4-tier
ladder — closed-form formula → fitted surrogate → scoped cone → full engine —
and emits the **smallest artifact that meets the precision budget**, with a
signed provenance record and an honesty gate: anything non-linear (a waterfall
kink, a breakpoint) automatically escalates to an exact tier rather than
shipping a smooth approximation of a cliff.

### `ete compare`, `ete extract`, `ete explain`, `ete eval`, `ete manifest`

Side-by-side scenarios with attribution; time-series schedules (capital calls,
distributions, debt); audit trails; exact formula evaluation; and manifest
configuration (`generate | validate | refine | doctor | set | export` — run
`doctor` before trusting carry/basis cells; `export` turns a tuned manifest
into a reusable template for `ete init --template <name>`). Run
`node cli/index.mjs --help` for the full list, or see
[skill/SKILL.md](skill/SKILL.md).

> Iterating on a manifest? `ete init model.xlsx --reuse-parse` skips the Rust
> parse when `chunked/` already exists — a 60–90s rebuild becomes ~2s.

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

### Three ways to compute a scenario

- **`engine.run()`** executes the model's actual transpiled formulas — exact,
  the right choice for an app's production math.
- **The CLI's `scenario`/`sensitivity`** use a fast first-order approximation (a
  "delta cascade") for instant analyst queries. Great for exploration; use
  `run()` when you need numbers that tie out to the penny.
- **`ete lite`** emits a KB-sized artifact (closed-form or fitted surrogate,
  escalating to exact tiers when the math has kinks) for consumers that only
  need a few outputs and don't want to ship the engine at all.

### Downstream contract artifacts

`ete init` emits a few small JSON files into `chunked/` so other apps can wire
up the engine **by name, at build time** — without running the engine to
discover which cells hold the outputs (and without shipping the silent-`NaN`
bug you get from guessing the wrong cell):

| File | Shape | Use |
|------|-------|-----|
| **`named-outputs.json`** | `name → { cell, label, type, format, baseCaseValue, source, dependsOnNamedInputs }` | The contract for downstream apps. Look up `grossMOIC`, get its cell + base-case value, spot-check on import. If your observed value ≠ `baseCaseValue`, your cell map is stale — fail the build. Time-series outputs are `type:"schedule"` with `cellRange` + `perYear:[{year,value}]`; their scalar `baseCaseValue` is a life-to-date `sum` for flows and the `terminal` level for balances (`aggregation` says which) — `perYear` is authoritative. |
| **`named-inputs.json`** | `name → { cell, type, default, referencedBy, affectsOutputs }` | Drive `engine.run({ [cell]: value })` for what-ifs. `affectsOutputs` says which outputs to invalidate (don't regenerate the whole grid). Lists Excel **defined-name** cells **read by ≥1 formula** plus the model drivers `exitMultiple` / `exitYearSelector` / `hurdleRate` (`source:"manifest-driver"`, derived from the manifest + ground truth, so they emit even without the `.xlsx`). |
| **`cell-types.json`** | `cell → "number" \| "label" \| "boolean" \| "empty"` | Tell a label string from a numeric output, and a real `0` (present, `"number"`) from a never-computed cell (absent from this map). |
| **`build-manifest.json`** | `{ layoutVersion, engine:{ entry, export }, contentHash, complete, artifacts[] }` | The locked artifact layout + a stable `contentHash` over the identity artifacts (engine.js, sheets/, _ground-truth.json, manifest.json). Pin a build by its `contentHash`; it's stable across rebuilds of the same workbook and changes on drift, so you reconcile deliberately, not per version. `complete:false` / `missingRequired` flag an unrunnable build. |
| **`dependency-graph.json`** *(debug)* | `{ format:"cell-dependency-edges-v2", edges: cell → [cells/ranges it reads] }` | Cell-level forward edges — the raw material for the `dependsOnNamedInputs` / `affectsOutputs` closures above. Ranges are kept as **compact tokens** (`Sheet!A1:B10`), not expanded to interior cells: full expansion was 37 GB / ~7 min on the real models and OOM-killed the closure-baking step (#32); the compact form is ~0.5 GB. Written **one edge per line** (still valid JSON) so a >512 MiB graph can be read line-by-line without exceeding Node's max string length. Consumers expand a token lazily against the cells they care about. **Removed from the default output** once the closures are baked into the named maps; re-run `ete init --emit-debug` to keep it (plus the root `model-map.json`) for offline analysis or closure recomputation. |

**Names come from the workbook's defined-name table** (the model owner's
curated named cells) when present — these are authoritative and override
heuristic detection. Regenerate without a re-parse:
`ete manifest maps ./my-model/chunked/ --excel model.xlsx`.

> Note: the **defined-name** inputs and defined-name enrichment of outputs
> require the source `.xlsx`. Without it (e.g. `--reuse-parse` against an
> already-parsed dir), outputs + cell-types + the **manifest-driver** inputs
> (`exitMultiple` / `exitYearSelector` / `hurdleRate`) still emit from the
> manifest and ground truth; only the defined-name inputs are skipped.

**Default output stays small.** `ete init` keeps only what consumers and the
CLI actually read: the engine modules, `_ground-truth.json` (compact),
`_labels.json`, the sheet-level `_graph.json` (3 KB — topo order + clusters, read
by the per-sheet eval), the contract maps, the manifest, and
`build-manifest.json`. The large intermediate/debug artifacts — the cell-level
`dependency-graph.json` (~0.5 GB) and the root `model-map.json` (600+ MB on the
biggest models) — are dropped after the closures are computed. The high-value
data survives as the closures inside the named maps. Pass `--emit-debug` to
retain `dependency-graph.json`.

**Golden-master gate.** `eval/golden-master.mjs` (run via `npm run golden <chunkedDir>`)
is the post-build assert for these artifacts: with `--assert-no-fallbacks` it
fails if any return/value output resolves through an unsupported-function (`_fn`)
stub, and with `--canonical <file>` it diffs `named-outputs.baseCaseValue`s
against a canonical returns map to **full float precision**. CI runs it on a
synthetic fixture (`npm run test:golden`); point it at a real build with
`ETE_GOLDEN_DIR` + a gitignored `canonical-returns.json` to verify a regenerated
model still reproduces the hand-port's gross/net MOIC & IRR exactly.

### Lazy engine for large models (`--lazy-engine`)

The default `engine.js` statically imports every per-sheet module, so
`import('engine.js')` pulls **all** of them into memory (hundreds of MB on the
big PE models — dominated by a couple of monster sheets) before `run()` can be
called. For a consumer that only needs to *sample* the model (the calibration-
oracle use case), that load is the wall.

`ete init --lazy-engine` emits an engine that imports sheet modules **on demand**:

```js
import engine from './my-model/chunked/engine.js';

// Load only what you need, then run() synchronously (same return shape as always).
await engine.load({ cells: ['Returns!D22', 'Returns!E22'] }); // loads just the
                                                               // dependency cone
const { values, meta } = engine.run({ 'Assumptions!B3': 18 });  // override + run

// Or do both in one call:
const r = await engine.runScoped({ 'Assumptions!B3': 18 }, { cells: ['Returns!D22'] });
```

- **`load(options)`** — `{ sheets: [...] }` and/or `{ cells: ['Sheet!A1', ...] }`
  loads only those sheets plus their transitive dependency closure (whole
  circular clusters are pulled in as a unit). No options ⇒ load everything (still
  lazy, but complete). To scope to named outputs, map their names → cells via
  `named-outputs.json`, then pass `cells`.
- **`run(inputs, options)`** — unchanged synchronous semantics; throws if called
  before anything is loaded. Sheets outside the loaded cone are simply skipped.
- **`runScoped(inputs, options)`** — `await load(options)` then `run(inputs, options)`.

The **default build is unchanged** — `engine.js` stays eager and `run()` stays
synchronous, so existing integrations are untouched. `--lazy-engine` is purely
opt-in. (Per-sheet modules are emitted either way; the flag only changes how
`engine.js` loads them.)

### The Delta Cascade

When you run a scenario, the CLI doesn't re-execute the full engine (which can take 10+ minutes on large models). Instead, it:

1. Reads base case values from ground truth (instant — JSON lookup)
2. Applies your adjustments to the annual P&L
3. Recomputes the chain: **exit EBITDA → terminal value → exit equity → MOIC → IRR → carry**
4. Uses `lib/irr.mjs` (Newton-Raphson) and `lib/waterfall.mjs` (American/European PE structures) for returns

This is a first-order approximation — accurate for linear sensitivities (revenue %, cost %, multiple changes, exit timing, leverage). For highly non-linear scenarios (MIP triggers, complex pref compounding), use the full chunked engine.

### Project Structure

```
excel-to-engine/
├── cli/                         # The `ete` command
│   ├── index.mjs                # Entry point + arg parsing
│   ├── commands/                # init, summary, query, pnl, scenario, sensitivity, compare, manifest
│   ├── extractors/              # date-detector, annual-aggregator, segment-detector, waterfall-detector, line-item-resolver
│   └── solvers/                 # delta-cascade (financial math), scenario-engine (orchestrator)
├── skill/SKILL.md               # Claude Code skill (PE language → CLI translation)
├── pipelines/
│   ├── rust/                    # Excel → JS transpiler (8 Rust modules, ~60 Excel functions)
│   └── js-reasoning/            # Claude-driven pipeline for smaller models
├── eval/                        # Blind eval, per-sheet eval, golden-master gate, auto-iteration
├── lib/                         # Financial libraries (IRR, waterfall, calibration, sensitivity, manifest)
└── tests/                       # 37 suites in npm test (CLI integration, use-case, engine/transpiler regressions)
```

### Libraries

| Library | Purpose |
|---------|---------|
| `lib/manifest.mjs` | Manifest schema, auto-generation, validation, cell resolvers, label search |
| `lib/manifest-maps.mjs` | Downstream contract maps (named-outputs/inputs.json, cell-types.json) |
| `lib/build-manifest.mjs` | Locked artifact layout + content hash (build-manifest.json) |
| `lib/irr.mjs` | Newton-Raphson IRR with bisection fallback, XIRR for irregular dates |
| `lib/waterfall.mjs` | American + European PE waterfall structures |
| `lib/calibration.mjs` | Scale factor calibration against Excel targets |
| `lib/sensitivity.mjs` | Surface extraction, slope comparison, breakpoint detection |
| `lib/excel-parser.mjs` | Cell reading, sheet fingerprinting, year detection, field mapping |

## Correctness & honesty

Financial numbers that are *plausible but wrong* are worse than no numbers.
The engine is built around a small set of non-negotiable rules:

- **Ground truth is the oracle.** Every cell value Excel computed ships with
  the build (`_ground-truth.json`); every claim the engine makes is checkable
  against it. The eval harness seeds a recompute from those values — a faithful
  formula must reproduce them exactly, so any divergence is a transpiler defect
  by definition, not a "model quirk."
- **Never a silent wrong number.** Excel's `#DIV/0!` propagates as `NaN`
  through `SUM`/`SUMIFS`/`AVERAGE`/… (the naive `(+x||0)` reducer would quietly
  turn `=SUM(100, 0/0, 250)` into `350`). `IFERROR`/`ISERROR` catch it exactly
  where Excel would.
- **Honest convergence.** Real models have circular references (returns ↔ debt
  ↔ fees). The engine converges them transient-tolerantly — a divide-by-cold-0
  that warms as the cluster solves is fine — but a cluster that does **not**
  reach a fixed point reports `converged: false` and NaN-fills its cells:
  detectably unusable beats confidently stale. The fast eval harness applies
  the *same* contract in lockstep, so measured accuracy is the accuracy you
  get from `run()`.
- **Excel fidelity down to the quirks.** Dates are integer Excel day-serials
  (including the phantom 1900-02-29 epoch quirk: `EOMONTH(0,1) = 59`), XIRR and
  XNPV use Excel's 365-day basis, and shared-formula groups expand with exact
  `$`-anchor semantics — each one a class of bug found on real models and now
  pinned by a negative-controlled regression (the test must fail on the old
  code with the predicted wrong value before the fix counts).

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

Cell-level fidelity is gated by a warm-ground-truth sweep (seed every cell with
Excel's value, recompute, diff every write — any divergence is a transpiler
defect by definition). On the largest real model (5.8M cells, a 17-sheet
circular cluster), 11/17 cluster sheets currently reproduce Excel **exactly**,
including every sheet a named output lives on; the residual is tracked openly
in the issues.

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

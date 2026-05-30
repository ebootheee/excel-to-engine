# Getting started — turn your Excel model into an engine (and an app)

This is the friendly, no-jargon walkthrough. **You do not need to know how to
code.** The fastest path is to let an AI coding assistant (Claude Code, Cursor,
Copilot Chat, etc.) run the commands while you steer. Copy-paste prompts are
provided throughout — say them in your own words.

If you're a developer who was handed a converted model folder, skip to
[**Build a web app**](#build-a-web-app).

---

## What you'll end up with

1. A plain-English **summary** of your model you can sanity-check.
2. A **scenario CLI** to ask "what if…" questions.
3. A **JavaScript engine** + an **integration guide** (`INTEGRATION.md`) and a
   runnable **`example.mjs`** — the bundle you hand to a developer to build an app.

---

## Step 0 — One-time setup (let your assistant do this)

Open this repository in your AI assistant and say:

> *"Set up this repo for me. I'm not a programmer — run whatever's needed and tell
> me if anything has to be installed. Then run `npm run check-env` and show me the
> result."*

Under the hood that's: `npm install`, then `npm run build:parser` (a one-time
build of the Excel reader), then `npm run check-env` (which prints exactly what,
if anything, is missing). If the assistant says you need to install **Node** or
**Rust**, those are normal free developer tools — let it guide you, or ask a
colleague to install them once.

You only do Step 0 once per machine.

---

## Step 1 — Convert your model

Put your `.xlsx` somewhere in the project folder, then say:

> *"Convert `my-model.xlsx` into an engine and walk me through what it found.
> Flag anything that looks wrong."*

The assistant runs:

```bash
node cli/index.mjs init my-model.xlsx --output ./my-model/
```

This parses every sheet, reproduces the formulas in JavaScript, figures out where
your key numbers live (IRR, MOIC, EBITDA, carry, debt, equity), and prints a
summary like:

```
Model: my-model (pe_buyout)
Period: 2024–2029 (5yr, annual) | Exit: 2029 @ 12.0x EBITDA
Returns      Gross
  MOIC       3.14x
  IRR        25.7%
Carry: $37.6M, 8% pref
```

---

## Step 2 — Sanity-check it (the important part)

**Compare the summary to what you know is true in your spreadsheet.** The tool is
very accurate, but every model is laid out differently, so give it a once-over:

- Are the exit year, hold period, and exit multiple right?
- Does base-case IRR / MOIC match your model's headline numbers?
- Is carry a dollar amount in the right ballpark (not a percentage)?

If something's off, just say so:

> *"The exit multiple should be 14×, not 12× — it picked the wrong cell. Fix it."*

The assistant can pinpoint and correct any mapping (it uses `ete manifest doctor`
to diagnose and `ete manifest set` to repair — no spreadsheet editing, no JSON by
hand). Re-running the summary confirms the fix.

> **Why this matters:** the engine is only as right as where it thinks your
> numbers live. Two minutes of sanity-checking here is what makes the rest
> trustworthy.

To be extra sure, ask:

> *"Verify the engine reproduces my model's base case exactly."*

This runs the generated `example.mjs`, which recomputes everything from the
formulas and confirms each headline output matches the value from your
spreadsheet. You want to see **"all outputs match baseCaseValue ✓."**

---

## Step 3 — Explore scenarios (analyst path)

Now ask questions in plain English. Examples (the assistant translates each into a command):

| You say | What happens |
|---|---|
| "What's IRR if we exit at 14× instead of 12×?" | `scenario --exit-multiple 14` |
| "Drop revenue growth to 5% — show me the hit to MOIC." | `scenario --revenue-growth ...` |
| "Build bear / base / bull and compare them." | three `scenario --save` + `compare` |
| "How sensitive is IRR to exit multiple and timing?" | a 2-D `sensitivity` table |
| "What's GP carry at a 2.5× MOIC?" | `carry --moc 2.5` |
| "Give me the capital-call and distribution schedules." | `extract --type capital_call` / `distribution` |

You can stop here if all you wanted was scenario analysis.

---

## Build a web app

This is the **"hand it to my developer / coding agent"** path — e.g. an
interactive what-if explorer to share with LPs or an IC.

### What to hand off

Give your developer (or coding agent) the output folder. The important part is
`my-model/chunked/`, which contains:

- **`engine.js`** — the model as a function. `import { run } from './engine.js'`.
- **`INTEGRATION.md`** — a guide tailored to *your* model: the exact inputs,
  outputs, base-case values, and a web-app wiring sketch.
- **`example.mjs`** — a runnable demo. `node example.mjs` prints the base case and
  a sample what-if.
- **`named-inputs.json` / `named-outputs.json`** — the levers and answers, by name.

A good prompt for the coding agent:

> *"This folder is a JavaScript engine for a financial model. Read
> `INTEGRATION.md`, run `node example.mjs`, then build me a single-page what-if
> explorer: sliders for the inputs in `named-inputs.json`, and cards showing the
> outputs in `named-outputs.json`, recomputed live with `run()`."*

### The 60-second version of the contract

```js
import { run } from './engine.js';

// Base case — matches your spreadsheet:
const base = run();

// Change one lever and recompute everything downstream:
const alt = run({ "Assumptions!B4": 14 });   // e.g. exit multiple -> 14

// Read any output by its cell address:
console.log(alt.values["IC Summary!B13"]);   // grossMOIC
```

Wiring inputs and outputs generically:

```js
import { run } from './engine.js';
import outputs from './named-outputs.json' with { type: 'json' };
import inputs  from './named-inputs.json'  with { type: 'json' };

// Render `inputs.namedInputs` as sliders (seed each with its `default`).
// On change, collect overrides as { [cell]: value } and:
function compute(overrides) {
  const { values } = run(overrides);
  return Object.fromEntries(
    Object.entries(outputs.namedOutputs).map(([name, o]) => [name, values[o.cell]])
  );
}
```

The engine is plain ES modules with **no dependencies** — it runs in Node and in
the browser. Wrap `run()` in an HTTP handler for an API, or import it directly in
a static site / React app.

### Trust check for the developer

On import, call `run()` once and confirm each output equals its `baseCaseValue`
in `named-outputs.json`. A mismatch means the engine was regenerated from a
changed model — re-pull the contract files. (`example.mjs` already does this.)

---

## If you get stuck

- `node cli/index.mjs --help` — all commands and flags.
- `npm run check-env` — what's installed / missing, with fix commands.
- Ask your assistant: *"Run the doctor on my model and explain any warnings."* →
  `ete manifest doctor` flags suspect mappings and prints the one-line fix.
- The deeper reference for assistants is [`skill/SKILL.md`](skill/SKILL.md).

---

## Frequently asked

**Do I need to share my real financials with anyone?** No. Everything runs
locally on your machine. Nothing is uploaded.

**Will the app's numbers match my spreadsheet?** Yes — `engine.run()` executes
your model's actual formulas. The `example.mjs` check confirms it on the base
case. (The CLI's instant `scenario` previews use a fast approximation; the engine
itself is exact.)

**My model is huge (50+ sheets).** That's fine — it's been tested up to 82 sheets
/ 6M cells. The first parse can take a minute or two; after that, queries are
instant.

**Can I re-run after I update the spreadsheet?** Yes. Re-run `init` on the new
`.xlsx`. The contract files regenerate, and the base-case check tells you if any
headline number moved.

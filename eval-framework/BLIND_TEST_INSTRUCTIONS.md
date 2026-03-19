# Blind Evaluation — Instructions for the Test Instance

> **IMPORTANT**: You are a fresh Claude Code instance evaluating a skill that converts Excel financial models into JavaScript engines. You have NEVER seen the target outputs. Your job is to use the skill to build engines from the provided Excel files and produce outputs that match a hidden control baseline.

## What You Have

1. **Two Excel financial models** (provided by the evaluator):
   - `A-1 Model.xlsx` — A standalone investment series model
   - `A-2 Model.xlsx` — A second investment series model (builds on A-1's asset base)

2. **The `excel-to-engine` skill** — installed in this Claude Code session
   - Located at: `./excel-to-engine/`
   - Contains: skill definition, lib utilities, engine template, dashboard template

3. **The comparator script** — `eval-framework/compare-outputs.mjs`
   - You will run this AFTER building your engines to see how well they match

4. **The control baseline** — `eval-framework/control-baseline.json`
   - ⚠️ **DO NOT READ THIS FILE** — it contains the answer key
   - The comparator reads it automatically

## Your Task

### Step 1: Build the A-1 Engine

Use the excel-to-engine skill to analyze `A-1 Model.xlsx` and generate:
- `candidate/engine.js` — exports `computeModel(inputs)` and `BASE_CASE`

The engine must accept these inputs (all optional, with defaults from the Excel base case):
```javascript
computeModel({
  exitYear,           // integer year (e.g., 2029)
  ownedExitMultiple,  // cap rate multiple for owned RE (e.g., 18.22)
  numFutureAcquisitions, // number of future sites (e.g., 10)
  // ... any other inputs you identify in the Excel
})
```

And return an object with AT LEAST these fields:
```javascript
{
  returns: {
    grossMOIC,    // gross multiple on invested capital
    netMOIC,      // net MOIC (after carry)
    grossIRR,     // gross internal rate of return (decimal, e.g., 0.1923)
    netIRR,       // net IRR (after carry)
  },
  exitValuation: {
    grossExitValue,    // total gross exit value ($)
    netProceeds,       // net equity proceeds after debt/costs ($)
    transactionCosts,  // transaction costs ($)
    debtPayoff,        // debt repayment ($)
  },
  waterfall: {
    lpTotal,     // LP total distribution ($)
    gpCarry,     // GP carried interest ($)
  },
  mip: {
    triggered,      // boolean: does MIP trigger?
    payment,        // MIP payment amount ($)
    valuePerShare,  // MIP value per share ($)
    hurdle,         // MIP hurdle multiplier (e.g., 1.40)
  },
  equityCashFlows: {
    years,          // array of years [2023, 2024, ...]
    draws,          // array of equity draws (negative $)
    distributions,  // array of distributions (positive $)
  },
  perShare: {
    gross,         // gross value per share ($)
    net,           // net value per share ($)
  },
}
```

### Step 2: Build the A-2 Engine

Same process for `A-2 Model.xlsx`:
- `candidate/engine-a2.js` — exports `computeModelA2(inputs)` and `BASE_CASE_A2`

Additional input for A-2:
```javascript
computeModelA2({
  exitYear,
  ownedExitMultiple,
  numFutureAcquisitions,
  issuancePrice,  // share issuance price (e.g., 1.35)
  // ... any other inputs
})
```

### Step 3: Run the Comparator

```bash
node eval-framework/compare-outputs.mjs candidate/
```

This will:
1. Run your engines across 200 scenarios (varying exit years, multiples, sites, issuance prices)
2. Compare each output against the hidden control baseline
3. Check 10 monotonicity invariants
4. Report pass/fail with deviation percentages

### Step 4: Iterate

If your score is below 95%, iterate:
1. Read the comparison report: `eval-framework/comparison-report.json`
2. Identify which outputs are deviating and by how much
3. Adjust your engine (calibration, formulas, waterfall structure)
4. Re-run the comparator
5. Repeat until ≥95%

## Tolerances

The comparator uses these tolerances (percentage deviation):
- MOIC: 2%
- IRR: 5%
- Exit values / dollar amounts: 2%
- MIP payment: 5%
- Per-share values: 3%
- Invariants: must match exactly (boolean)

## Rules

1. **DO NOT read `control-baseline.json`** — that defeats the purpose
2. **DO NOT look at any `engine.js` or `engine-a2.js` outside the `candidate/` directory** — those are the hand-built reference implementations
3. **You CAN read the Excel files** — that's the whole point
4. **You CAN use the `excel-to-engine` skill** — that's what you're evaluating
5. **You CAN read `compare-outputs.mjs`** — to understand the output interface
6. **You CAN iterate** — run the comparator as many times as you need

## Deliverables

When you're done, provide:
1. Your final `candidate/engine.js` and `candidate/engine-a2.js`
2. The final comparator output (score and any remaining failures)
3. A brief log of what you did:
   - How many iterations did it take?
   - What was the hardest part?
   - What did the skill get right/wrong on the first pass?
   - What manual adjustments did you have to make?

## How to Submit Results

Save your log to: `eval-framework/blind-test-log.md`

The evaluator will review:
- Your final score (target: ≥95%)
- The iteration count
- The log narrative
- Whether you followed the rules (no peeking!)

---

*Good luck! The skill should handle most of the heavy lifting. Your job is to guide it and iterate on the calibration.*

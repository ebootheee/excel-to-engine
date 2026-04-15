# excel-to-engine CLI Skill

## Triggers

- "What if [financial adjustment]?"
- "Run a scenario on this model"
- "What's the IRR if we change the exit multiple?"
- "Show me the P&L breakdown"
- "Compare base case vs downside"
- "Generate a sensitivity table"
- "What's the carry at 2.5x?"
- "Find [metric] in the model"
- "Summarize this model"
- "Analyze this financial model"
- "Query a cell from the model"

## First Contact with a New Model

When the user points you at a model for the first time, the CLI handles manifest creation automatically. You don't need to mention manifests to the user — just run the commands and interpret results.

### If only an .xlsx file exists (never parsed):
```bash
node cli/index.mjs init model.xlsx --output ./my-model/
```
This runs: parse → auto-generate manifest → refine (smart search for IRR/MOIC/carry/equity) → summary. The model is ready to query immediately.

### If a chunked directory exists but no manifest:
```bash
node cli/index.mjs manifest generate ./my-model/chunked/
node cli/index.mjs manifest refine ./my-model/chunked/ --apply
```
Generate creates the base manifest. Refine searches the ground truth for key financial metrics (IRR, MOIC, equity basis, carry) using broad pattern matching and patches the manifest.

### If the manifest is missing key fields after auto-generation:
Use `ete query --search` to find the cells manually, then patch the manifest:
```bash
# Find where IRR lives
node cli/index.mjs query ./my-model/chunked/ --search "IRR"
# Find carry
node cli/index.mjs query ./my-model/chunked/ --search "Carry"
# Find equity
node cli/index.mjs query ./my-model/chunked/ --search "Equity"
```
Then edit `manifest.json` to add the correct cell references to `equity.classes[0].grossIRR`, `carry.totalCell`, etc.

### Manifest is model-specific
Each model gets its own `manifest.json` because cell addresses differ across spreadsheets. The manifest maps generic financial concepts (EBITDA, IRR, carry tiers) to specific cells in that model's ground truth. Once created, it's reused for all future queries and scenarios.

## Workflow

### 1. Locate the Model

- If user provides a path, use it
- If only one model directory exists in the working directory, use it
- If multiple models, ask which one
- Check for `manifest.json` — if missing, run init or generate+refine (see above)

### 2. Identify Intent → Map to Command

| User Intent | Command |
|---|---|
| "What is X?" / "Find X" | `ete query --search "X"` or `ete query --name X` |
| "Show the P&L" / "Revenue breakdown" | `ete pnl [--segment id] [--detail] [--growth]` |
| "What if X changes?" | `ete scenario --param value` |
| "How sensitive is IRR to X?" | `ete sensitivity --vary param:range:step` |
| "Compare A vs B" | `ete compare --base "" --alt "params"` |
| "Summarize the model" | `ete summary` |
| "Build me bear/base/bull cases" | `ete scenario --save` for each, then `ete compare --scenarios` |

### 3. Translate PE Language to CLI Parameters

#### Exit & Valuation

| PE Principal Says | CLI Translation |
|---|---|
| "Push exit to 2033" | `--exit-year 2033` |
| "Drop the multiple by 2 turns" | Read manifest for base multiple, subtract 2: `--exit-multiple {base - 2}` |
| "Exit at 16x" | `--exit-multiple 16` |
| "Value on revenue instead of EBITDA" | `--revenue-multiple 10` |
| "Value tech at 12x revenue, RE at 15x NOI" | `--sotp --segment-multiple techGP:12 --segment-multiple reNOI:15` |
| "Cap rate expands 50bps" | Convert: `--exit-multiple {1/(base_cap_rate + 0.005)}` |

#### Revenue

| PE Principal Says | CLI Translation |
|---|---|
| "Tech grows at 40% instead of 30%" | `--revenue-growth techGP:0.40` |
| "Lose $500K of rent" | `--revenue-adj reNOI:-500000` |
| "Tech revenue up 50%" | `--revenue-adj techGP:+50%` |
| "Strip out the tech segment" | `--remove-segment techGP` |
| "Add $5M license revenue in 2030" | `--add-revenue 2030:5e6` |
| "Override exit ARR to $32M" | `--override-arr 32e6` |

#### Costs

| PE Principal Says | CLI Translation |
|---|---|
| "Operating costs up 10%" | `--cost-adj operations:+10%` |
| "Reduce customer acquisition by $200K" | `--line-item tech_cac:-200000` |
| "Tech gross margin drops to 60%" | Compute cost delta needed, use `--cost-adj` |
| "Capitalize dev headcount over 5 years" | `--capitalize tech_headcount:5` |
| "Magic number of 1.0x" | `--cost-ratio technology:1.0` |

#### Capital Structure

| PE Principal Says | CLI Translation |
|---|---|
| "Refinance at 55% LTV" | `--leverage 0.55` |
| "Pay a $20M special dividend in 2027" | `--distribution 2027:20e6` |
| "What if we invested $500M instead?" | `--equity-override 500e6` |
| "Extend hold period to 8 years" | `--hold-period 8` |

#### Returns & Carry

| PE Principal Says | CLI Translation |
|---|---|
| "What's carry at 2.5x MOIC?" | Run scenario that produces ~2.5x, read carry |
| "Override pref to 10%" | `--pref-return 0.10` |
| "Show me carry by tier" | `--metric carry-detail` or read `carryDetail` from JSON output |
| "What discount rate brings NPV to zero?" | `--discount-rate X` (iterate via sensitivity) |

### 4. Run Commands

Always use `--format json` when processing output programmatically. Use default table format when presenting to user.

```bash
# Read the model directory from context
MODEL_DIR="./my-model/chunked"

# Run command
node cli/index.mjs scenario "$MODEL_DIR" --exit-multiple 16 --format json
```

### 5. Interpret Results

After running a command, interpret the results for the user:

**Key things to highlight:**
- Direction and magnitude of change (e.g., "IRR drops 5.2pp from 28.4% to 23.2%")
- Whether returns cross important thresholds (1.0x MOIC, pref hurdle, carry triggers)
- Which driver has the biggest impact (if attribution was run)
- Whether the scenario is realistic (flag extreme values)

**Return benchmarks by model type:**

| Type | Median IRR | Median MOIC | Strong | Weak |
|------|-----------|-------------|--------|------|
| PE Buyout | 18-22% | 2.0-2.5x | >25% / >3.0x | <15% / <1.5x |
| Growth Equity | 25-30% | 3.0-4.0x | >35% / >5.0x | <20% / <2.0x |
| Venture | 20-30% | 2.5-3.5x | >40% / >5.0x | <15% / <2.0x |
| Real Estate | 12-18% | 1.5-2.0x | >20% / >2.5x | <10% / <1.3x |

**Common gotchas to flag:**
- **MOIC vs IRR divergence:** High MOIC + low IRR = long hold. Low MOIC + high IRR = short hold with leverage.
- **Leverage amplification:** 1pp multiple change has 2-3x impact on MOIC when leveraged.
- **Terminal value sensitivity:** TV = EBITDA x multiple, and TV is typically 70-90% of enterprise value. A 10% EBITDA change has a 7-9% equity impact.
- **Growth compounding:** "40% vs 30%" over 5 years = 5.38x vs 3.71x (45% more revenue, not 33%).

## Command Chaining Patterns

### Discovery → Analysis Flow
```bash
# 1. Understand the model
node cli/index.mjs summary "$MODEL_DIR"

# 2. Find specific metrics
node cli/index.mjs query "$MODEL_DIR" --search "headcount"

# 3. See current trajectory
node cli/index.mjs pnl "$MODEL_DIR" --segment technology --detail --growth

# 4. Run scenario
node cli/index.mjs scenario "$MODEL_DIR" --revenue-growth techGP:0.40 --format json

# 5. Decompose impact
node cli/index.mjs compare "$MODEL_DIR" --base "" --alt "revenue-growth=techGP:0.40" --attribution
```

### Bear/Base/Bull Construction
```bash
# Create three scenarios
node cli/index.mjs scenario "$MODEL_DIR" --revenue-adj techGP:-20% --exit-multiple 14 --exit-year 2033 --save "bear"
node cli/index.mjs scenario "$MODEL_DIR" --save "base"
node cli/index.mjs scenario "$MODEL_DIR" --revenue-adj techGP:+30% --exit-multiple 22 --exit-year 2029 --save "bull"

# Compare all three
node cli/index.mjs compare "$MODEL_DIR" --scenarios "bear,base,bull"
```

### Sensitivity Deep-Dive
```bash
# 1D: IRR across exit multiples
node cli/index.mjs sensitivity "$MODEL_DIR" --vary exit-multiple:14-22:1 --metric grossIRR,grossMOIC

# 2D: IRR across multiples and exit years
node cli/index.mjs sensitivity "$MODEL_DIR" --vary exit-multiple:14-22:2 --vary exit-year:2028-2034:1 --metric grossIRR

# With a fixed adjustment applied
node cli/index.mjs sensitivity "$MODEL_DIR" --vary exit-multiple:14-22:1 --revenue-adj techGP:-20% --metric grossIRR
```

### Complex Scenario from File
```bash
# Create scenario file
cat > scenarios/downside.json << 'EOF'
{
  "name": "downside-q4",
  "description": "Conservative: tech headwinds, delayed exit, multiple compression",
  "adjustments": {
    "exit": { "year": 2033, "multiple": 14 },
    "revenue": [
      { "segment": "techGP", "adj": "-20%" }
    ],
    "cost": [
      { "segment": "technology", "adj": "+10%" }
    ],
    "capital": { "leverage": 0.50 }
  }
}
EOF

# Run it
node cli/index.mjs scenario "$MODEL_DIR" --file scenarios/downside.json
```

## Output Formats

All commands support `--format`:
- `table` (default) — human-readable ASCII tables
- `json` — structured for programmatic consumption
- `csv` — spreadsheet-compatible
- `markdown` — for reports and chat contexts

The `json` format is preferred when chaining commands or when the agent needs to extract specific values from the output.

## Limitations

- **First-order approximation:** The delta cascade applies adjustments proportionally to base case values. It's accurate for linear sensitivities (revenue %, cost %, multiple changes) but less accurate for highly non-linear scenarios (MIP triggers, pref hurdle crossings with complex compounding).
- **No full engine re-execution:** The CLI reads ground truth and computes deltas. It does NOT re-run the full chunked engine (which would require 8GB+ heap and 10+ minutes for large models).
- **Manifest quality matters:** If the manifest has wrong cell references, all downstream outputs will be wrong. Always validate: `ete manifest validate`.
- **Annual granularity:** The P&L and scenario commands aggregate to annual. Monthly cash flow patterns (front-loaded vs back-loaded) affect IRR but are approximated with bullet cash flows unless the manifest includes a draw schedule.

## Model Type Templates

### PE Fund (carry + equity classes)
Key segments: portfolio company returns, management fees, fund expenses.
Key outputs: Fund IRR, Fund MOIC, total carry, per-LP distributions.
Typical sensitivity: exit multiples, exit year, portfolio company growth rates.

### PE Platform (operating company with segments)
Key segments: revenue by business line (RE, tech, ops), costs by segment.
Key outputs: Platform EBITDA, exit equity, carry, price per share.
Typical sensitivity: exit multiple, segment growth, cost structure.

### Real Estate Fund
Key segments: NOI by property/region, development pipeline.
Key outputs: NOI, cap rate, equity value, distributions.
Typical sensitivity: cap rate (= 1/exit multiple), vacancy, rent growth.

### SaaS / Growth Equity
Key segments: ARR, net retention, new bookings.
Key outputs: Revenue, ARR multiple, cash flow, equity value.
Typical sensitivity: revenue multiple, growth rate, burn rate.

### Venture Portfolio
Key segments: portfolio company valuations.
Key outputs: Fund MOIC/IRR, carry, DPI.
Typical sensitivity: individual company exit multiples, growth rates.

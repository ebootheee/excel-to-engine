# PLAN V4 — AI Interface Layer

## Context

Two production sessions against Outpost Corporate Models (SESSION_LOG.md,
SESSION_LOG_02_carry.md) shipped in PR #8. A third conversation clarified
the actual value prop: this is an **AI-navigable index over complex Excel
models**, serving ~20-30 PE stakeholder use cases (analyst, VP, partner,
LP, portfolio CFO, IR), not just the few use cases the session logs
surfaced.

The previous plans optimized for "make the next Outpost session smoother."
V4 optimizes for "answer anything an analyst, principal, partner, LP, or
CFO might ask against any PE/RE/corp model — with token efficiency, fast
lookup, auditability, and enough model-concept coverage."

## Scope — All six priorities from the reordered list

1. Breadth of extraction primitives (biggest scope, biggest value)
2. Label index at parse time (infrastructure)
3. Token-efficient output modes (AI consumption)
4. Chunked-engine bridge (non-linear questions)
5. `ete explain <name>` (audit trail)
6. Doctor-gated init + model-family templates (trust + reuse)

Ordering below reflects build sequence (foundation first), not priority.

---

## Phase 1 — Label index infrastructure

### Goal
Eliminate the 30s-per-search cost. Every stakeholder question starts with
"find X"; current search scans the 200 MB ground truth on each call.

### Design
- **New file:** `chunked/_labels.json` — `{ lowerCasedLabel: [{ sheet, col, row, text }] }`
- **Rust parser** (`pipelines/rust/src/chunked_emitter.rs`) emits this during chunking. Single pass over cells, ~O(string cells).
- **Fallback:** if `_labels.json` is missing (legacy engines), CLI falls back to scanning GT. `lib/manifest.mjs:searchByLabel` handles both paths.
- **Contract:** an entry exists for every string cell on the model (not just the "interesting" labels) — cheap because the parser already iterates cells.

### Touchpoints
- `pipelines/rust/src/chunked_emitter.rs` — add label emission
- `lib/manifest.mjs` — new `loadLabelIndex(modelDir)`, updated `searchByLabel` to prefer index
- `cli/commands/query.mjs` — uses the index for search
- Test: verify search is correct with/without index

### Risk
Rust parser changes require recompilation. To avoid breaking existing models, `loadLabelIndex` returns `null` when the file is absent and `searchByLabel` falls back gracefully.

---

## Phase 2 — Token-efficient output modes

### Goal
An agent asking 30 questions per context window needs ~10× fewer tokens per answer.

### Design
- **New global flag:** `--compact` (applies to all commands emitting data)
- **Compact JSON schema:** short keys (`v`/`c`/`l` instead of `value`/`cell`/`label`), numeric rounding to 4 sig figs or 2 decimals for percentages, dropped nulls, arrays-of-objects → arrays-of-tuples where order is stable
- **Format routing:** `cli/format.mjs` already has `formatOutput(result, format)`. Add a `compact` case that walks the object tree and compresses.
- **Command-level override:** commands can implement their own `result._compact` for custom compression (e.g., pnl drops labels in compact mode, keeps only year→value maps)

### Touchpoints
- `cli/format.mjs` — add `compact` formatter
- `cli/index.mjs` — recognize `--compact` as alias for `--format compact`
- `cli/commands/*.mjs` — expose meaningful compact output for pnl, scenario, sensitivity, query, extract

### Contract
Compact output must remain parseable JSON. No binary or ad-hoc formats.

---

## Phase 3 — `ete explain <name>`

### Goal
When a stakeholder disagrees with a number, show the full trust chain in one command — no detective work.

### Design
`ete explain <modelDir> <name-or-cell>` emits:
1. **Manifest resolution** — which field in manifest maps to this name, the cell ref it points to, and confidence if available
2. **Cell value** — raw from ground truth
3. **Adjacent label** — column A/B on the same row (if any)
4. **Formula** — from chunked `formulas.json` if available (transpiled JS + original Excel)
5. **Dependencies** — cells referenced by the formula (from dependency graph if chunked emitter produces one)
6. **Base-case lineage** — if the name is a `baseCaseOutputs` entry, show which manifest path produced it

Output is both human (table) and AI-friendly (compact JSON).

### Touchpoints
- New command: `cli/commands/explain.mjs`
- Uses: `lib/manifest.mjs` (resolution), chunked `formulas.json` if present
- Graceful degradation when formulas.json is absent (chunked mode skips it, so need a fallback scan of per-sheet modules for the formula comment)

### Contract
Never fail silently. If data is missing, say "formula not available (chunked mode skipped transpilation metadata)" — don't omit the field.

---

## Phase 4 — Doctor-gated init + model-family templates

### Goal
Catch bad auto-detection at parse time, and let teams reuse validated manifests across model families (reduce auto-detection dependency for common shops).

### Design

**Doctor-gated init:**
- `ete init` runs `manifest doctor` on the freshly-generated manifest after refine
- If errors are found, exit non-zero with actionable messages
- `--force` bypasses (for CI / batch / known-quirky models)
- `--skip-validation` as alias

**Templates:**
- New directory: `templates/`
- Template files: `outpost-platform.json`, `pe-fund-generic.json`, `re-fund-generic.json` (2-3 starter templates based on known model families)
- Template = partial manifest with known cell refs + optional regex patterns to recognize the family
- **Apply:** `ete init <xlsx> --template outpost-platform` uses the template's cell refs instead of auto-detection where possible; falls back to auto-detect for unmapped fields
- **Export:** `ete manifest export <modelDir> --template > template.json` creates a reusable template from a hand-corrected manifest
- **Auto-match:** during init (no --template specified), sample sheet names are hashed against template signatures — if a match is found, user is prompted to apply it

### Touchpoints
- `cli/commands/init.mjs` — doctor check + template flag
- `cli/commands/manifest.mjs` — `export` subcommand
- `lib/manifest.mjs` — template application logic
- `templates/` directory with starter files
- `README.md` — document templates

### Templates to ship
1. `outpost-platform.json` — 8-sheet GreenPoint/Outpost platform template
2. `pe-fund-generic.json` — traditional PE fund (Assumptions, Cash Flows, Waterfall, IRR tabs)
3. `re-fund-generic.json` — RE fund (Rent Roll, NOI, Cap Rate, Waterfall tabs)

### Contract
Templates are declarative only — no code execution. Applied manifest must still pass `doctor`.

---

## Phase 5 — Chunked-engine bridge

### Goal
Give the AI an escape hatch to exact formula evaluation when the delta cascade (linear approximation) breaks: covenants, MIP, non-linear pref compounding, FX.

### Design
New command: `ete eval <modelDir> <cell> [--inputs '{...}']`

- Loads the appropriate chunked/sheets/*.mjs module for the target sheet
- Creates a ctx that resolves cell lookups via ground truth (base case) overlaid with any `--inputs`
- Runs the transpiled formula for the target cell and returns the result
- For cells in circular clusters, runs the full engine.js orchestrator (slower)

### Touchpoints
- New command: `cli/commands/eval.mjs`
- Uses: `chunked/engine.js` for cross-sheet dependencies, `chunked/sheets/*.mjs` for per-sheet
- Contract: falls back to ground-truth value if formula can't be evaluated (e.g., missing dep)

### Scope note
This is a bridge, not a replacement. The delta cascade stays the default for scenarios; `eval` is opt-in when the user explicitly needs formula-accurate math.

---

## Phase 6 — Breadth of extraction primitives (biggest scope)

### Goal
Close the 70% coverage gap — add manifest concepts + detectors + extraction commands for the long tail of stakeholder questions.

### Manifest schema extensions

```
manifest = {
  ...existing,

  // NEW: generic time-series schedules
  schedules: [
    { id, label, sheet, row, type, columnMap, aggregation }
  ],
  //   type ∈ 'capital_call' | 'distribution' | 'debt_balance' | 'debt_service'
  //        | 'interest_expense' | 'fee' | 'equity_invested' | 'cash_flow'
  //        | 'noi' | 'revenue' | 'generic'

  // NEW: fund-level metrics (LP-facing)
  fundLevel: {
    tvpi: cellRef,
    dpi: cellRef,
    rvpi: cellRef,
    netIRR: cellRef,
    vintageYear: number,
    fundSize: cellRef,
    paidIn: cellRef,
    distributed: cellRef,
    residual: cellRef,
  },

  // NEW: cap-table extensions
  equity: {
    classes: [
      ...existing,
      shares: cellRef,         // NEW
      ownershipPct: cellRef,   // NEW
      priority: number,        // NEW
      seniorTo: [classIds],    // NEW
    ],
    totalShares: cellRef,      // NEW
  },

  // EXPANDED: debt with schedule
  debt: {
    exitBalance: cellRef,      // existing
    exitCash: cellRef,          // existing
    principal: cellRef,         // NEW
    rate: cellRef,              // NEW
    maturity: number|cellRef,   // NEW
    schedule: scheduleRef,      // NEW (id of schedules[] entry)
  },

  // EXPANDED: carry with tiers
  carry: {
    totalCell: cellRef,         // existing
    tiers: [                    // NEW: detected tiers
      { name, hurdle, lpSplit, gpSplit, type }
    ],
    waterfall: { ...existing }
  },

  // NEW: covenants (ratio thresholds)
  covenants: [
    { id, label, sheet, row, ratio, threshold, direction }
  ],
}
```

### New detectors (`lib/manifest.mjs`)
- `detectSchedules(gt, sheets, timeline)` — generic time-series rows keyed by label pattern
- `detectFundLevelMetrics(gt, sheets)` — TVPI/DPI/RVPI/netIRR/vintageYear
- `detectCapTable(gt, sheets)` — shares, ownership columns
- `detectDebtDetails(gt, sheets)` — rate, maturity, principal
- `detectCarryTiers(gt, sheets)` — tier rows near carry.totalCell
- `detectCovenants(gt, sheets)` — ratio labels with thresholds

Each new detector adds to the manifest, is validated by `doctor`, and feeds new extraction commands.

### New commands
- `ete extract <modelDir> --type <type>` — returns all schedules matching a type
- `ete extract <modelDir> --id <id>` — returns a specific schedule
- `ete extract <modelDir> --list` — lists all detected schedules
- Expansions to `ete query --name` for `tvpi`, `dpi`, `rvpi`, `netIRR`, `vintageYear`, `paidIn`, `distributed`

### Scope cuts
Defer these (too model-specific without sample data):
- Rent roll table extraction (needs 2D table detection)
- MIP tier detection (too variable)
- FX hedge extraction (rare)

These stay as roadmap items with manifest hooks reserved.

### Touchpoints
- `lib/manifest.mjs` — all new detectors, extended schema
- `cli/commands/manifest.mjs` — doctor checks for new fields
- `cli/commands/extract.mjs` — new command
- `cli/commands/query.mjs` — expanded `--name` resolution
- `cli/commands/summary.mjs` — show fund-level metrics when present
- `skill/SKILL.md` — update intent→command mapping table with new primitives

---

## Documentation + skill updates

- `skill/SKILL.md` — comprehensive rewrite of the intent→command mapping table, covering ~25 stakeholder use cases across analyst/VP/partner/LP/CFO
- `README.md` — add "What AI agents can ask this tool" section listing representative questions per stakeholder
- `CLAUDE.md` — update command count and manifest schema reference
- `CHANGELOG.md` — single V4 entry summarizing all six phases
- `ROADMAP.md` — move V4 items to Done, list deferred items

---

## Testing strategy

- Existing: 197 assertions (34 CLI + 31 manifest + 132 use-case) — must stay green
- New: `tests/cli/test-ai-interface.mjs` — ~60 assertions covering label index, compact output, explain, templates, eval, extract, all new detectors
- `npm test` wraps all three test files
- Rust smoke test stays 78/78

---

## Sequencing for execution

Phases listed above are build order. Key dependencies:
- Label index (Phase 1) must precede Extract commands (Phase 6) for performance
- Compact output (Phase 2) touches the formatter — do early to apply across new commands
- Doctor-gated init (Phase 4) depends on new doctor checks in Phase 6 to be useful
- Templates (Phase 4) can ship independently

Execute in this order:
1. Label index (Phase 1)
2. Compact output routing (Phase 2)
3. Manifest schema extension + new detectors (Phase 6 core)
4. `ete extract` command (Phase 6 surface)
5. `ete explain` command (Phase 3)
6. `ete eval` command (Phase 5)
7. Templates + template export (Phase 4)
8. Doctor-gated init (Phase 4)
9. Doctor checks for new manifest fields (Phase 6 closure)
10. Tests for everything
11. Docs pass (README, SKILL, CLAUDE, CHANGELOG, ROADMAP)
12. Commit + PR

---

## Resumption notes

If this session is interrupted, the state to check:
- `git status` + `git log --oneline origin/main..HEAD` on `feat/ai-interface-v4`
- This file (`PLAN_V4.md`) tracks the plan; `CHANGELOG.md` tracks executed work
- `TaskList` in-session tracks phase-level progress
- All new code is under `cli/commands/`, `lib/manifest.mjs`, `pipelines/rust/src/chunked_emitter.rs`, `templates/`
- Test harness: `npm test`

# Model-family templates

Each file here is a partial manifest with layout hints (and, optionally,
pre-mapped cell references) for a specific model family. Apply explicitly
with:

```bash
ete init model.xlsx --output ./my-model/ --template pe-platform-summary
```

Or let `ete init` auto-apply a template when the model's sheet set matches
the template's signature. Auto-apply can be turned off per-run with
`--no-template`.

When a template is applied, the CLI still runs auto-detection. Any cell
references in `mappings` override heuristic detection for those fields.
`hints` steer the detectors (e.g. prefer a summary tab for Peak Equity).

## Building a template from a corrected manifest

After hand-correcting a manifest (via `ete manifest set`) and confirming
`doctor` is clean, you can export a reusable template:

```bash
ete manifest export ./my-model/chunked/ > templates/my-family.json
```

The export strips base-case values (model-specific) and keeps the structural
mapping. Edit the `signature.sheetNames` field to control auto-match.

## Template schema

```json
{
  "$schema": "template-v1.0",
  "name": "pe-platform-summary",
  "description": "Human description of the model family",
  "signature": {
    "sheetNames": ["UW Comparison", "Cheat Sheet", "GP Promote"],
    "matchThreshold": 1.0,
    "autoApply": true
  },
  "mappings": {
    "equity.classes[0].grossIRR": "Cheat Sheet!F15",
    "equity.classes[0].grossMOIC": "Cheat Sheet!F14"
  },
  "hints": {
    "summarySheets": ["UW Comparison", "Cheat Sheet"],
    "scenarioColumns": { "UW Comparison": ["H", "I"], "default": ["H"] },
    "peakEquityLabels": ["Peak Net Equity", "Peak Equity"]
  },
  "auditTraces": {
    "capitalToMip": {
      "root": "mipPayment",
      "anchors": [
        { "name": "paidInCapital", "cell": "Inputs!B4" },
        { "name": "excludedCheck", "cell": "Inputs!B5", "expect": "not-in-lineage" }
      ],
      "maxVisited": 250000
    }
  }
}
```

Signature fields:
- `sheetNames` — the set of sheet-name strings that identify the model family
- `matchThreshold` — fraction (0-1) of signature sheets required for a match;
  default 0.75
- `autoApply` — when true, a matching signature triggers automatic application
  during `ete init`; otherwise only a suggestion is printed

Mappings are cell references; the CLI writes them verbatim into the
generated manifest.

`auditTraces` is optional model-owner configuration. `root` is either a named
output (preferred) or a direct `Sheet!A1` cell. Each anchor has a stable name,
cell, and optional expectation: `connected` (default), `not-in-lineage`, or
`any`. `maxVisited` bounds traversal (default 250,000; maximum 2,000,000). An
unresolved or bounded search is reported honestly as `unavailable` or
`truncated`; it is never converted into a false `not-in-lineage`. The whole
block survives template export and manifest regeneration.

When configured, `ete init` emits `chunked/audit-lineage.json`. Add
`--require-lineage` to make an incomplete or mismatched trace fail the build.

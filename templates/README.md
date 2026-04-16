# Model-family templates

Each file here is a partial manifest with pre-mapped cell references for a
specific model family. Apply with:

```bash
ete init model.xlsx --output ./my-model/ --template outpost-platform
```

When a template is applied, the CLI still runs auto-detection, but the
template's cell references override heuristic detection for the fields it
specifies. The template also carries a `signature` regex that's matched
against sheet names — `ete init` prints a suggestion when a model matches
a known template.

## Building a template from a corrected manifest

After hand-correcting a manifest (via `ete manifest set`) and confirming
`doctor` is clean, you can export a reusable template:

```bash
ete manifest export ./my-model/chunked/ --template > templates/my-family.json
```

The export strips base-case values (model-specific) and keeps the structural
mapping. Edit the `signature.sheetNames` field to control auto-match.

## Template schema

```json
{
  "$schema": "template-v1.0",
  "name": "outpost-platform",
  "description": "Human description of the model family",
  "signature": {
    "sheetNames": ["Version Tracker", "Assumptions", "Financial Statements",
                   "Equity", "Debt", "Valuation", "GPP Promote", "Cheat Sheet"]
  },
  "mappings": {
    "equity.classes[0].grossIRR": "Equity!AN125",
    "equity.classes[0].grossMOIC": "Equity!AN124",
    "equity.classes[0].basisCell": "Equity!AN123",
    "carry.totalCell": "GPP Promote!AL253",
    ...
  }
}
```

Mappings are cell references; the CLI writes them verbatim into the
generated manifest.

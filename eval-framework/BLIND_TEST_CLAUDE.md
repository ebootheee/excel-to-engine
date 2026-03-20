# Blind Evaluation — Build & Score

## Your Job

Build JavaScript engines from the Excel models in this directory. Score them against the hidden control baseline. Report your results.

## Rules

- **DO NOT read** `eval-framework/control-baseline.json`, `reference-model/`, or `reference-mip/`
- **DO read** the Excel files, `excel-to-engine/` skill, and `eval-framework/compare-outputs.mjs`

## Build

1. `npm init -y && npm install xlsx`
2. Read both Excel files using Python openpyxl (for exact values) and xlsx (for structure)
3. **Read the skill thoroughly**: `excel-to-engine/skill/SKILL.md` — every CRITICAL section matters
4. Create:
   - `candidate/engine.js` → exports `computeModel(inputs)` and `BASE_CASE`
   - `candidate/engine-a2.js` → exports `computeModelA2(inputs)` and `BASE_CASE_A2`
5. Both must return: `{ returns: {grossMOIC, netMOIC, grossIRR, netIRR}, exitValuation: {grossExitValue, netProceeds, transactionCosts, debtPayoff}, waterfall: {lpTotal, gpCarry}, mip: {triggered, payment, valuePerShare, hurdle}, perShare: {gross, net} }`
6. Use libs from `excel-to-engine/lib/` (irr.mjs, waterfall.mjs, calibration.mjs)
7. Implement calibration for ALL outputs — MOIC, IRR, lpTotal, gpCarry, mipPayment, netProceeds

## Verification Checklist (run before scoring)

Before running the comparator, verify these in your engine:

- [ ] `BASE_CASE.ownedExitMultiple` has the EXACT value from Excel (not rounded)
- [ ] `waterfall.lpTotal + waterfall.gpCarry === exitValuation.netProceeds` (must balance)
- [ ] `waterfall.lpTotal = netProceeds - gpCarry` (NOT the sum of tier LP distributions)
- [ ] Changing `exitYear` produces different `grossExitValue` and `netProceeds`
- [ ] Changing `issuancePrice` (A-2 only) produces different `perShare` values
- [ ] `mip.payment = dilutionRate × max(0, lpTotal - hurdle × equityBasis)` (uses lpTotal, not netProceeds)
- [ ] `mip.triggered === false` when MOIC < hurdle (e.g., at 14x multiple)
- [ ] Calibration scales ALL outputs (not just MOIC/IRR) to match Excel at base case

## Score

```bash
node eval-framework/compare-outputs.mjs candidate/
```

## Output

Save these files:
- `candidate/engine.js` and `candidate/engine-a2.js` — your engines
- `candidate/score.txt` — your final score (just the number)
- `candidate/blind-test-log.md` — brief log:
  - Final score and pass/fail counts
  - What you found hardest
  - Key decisions you made (equity basis, waterfall tiers, etc.)

Paste the full comparator output at the end of your session.

## IMPORTANT: Stop After Scoring

**Do NOT iterate or try to fix failures.** Run the comparator once, report your score, save your files, and stop. The evaluator will analyze failures and improve the skill separately. Your job is a single clean build attempt following the skill instructions.

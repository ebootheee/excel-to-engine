#!/bin/bash
#
# Automated Blind Evaluation Harness
#
# Runs a fresh Claude Code instance with the excel-to-engine skill against
# the source Excel files, then scores the output against the control baseline.
#
# Usage:
#   ./eval-framework/run-blind-eval.sh [--iterations N] [--target SCORE]
#
# Prerequisites:
#   - Claude Code CLI (`claude`) installed and authenticated
#   - Both Excel files in the project root
#   - control-baseline.json in eval-framework/
#
# Output:
#   - eval-framework/runs/<timestamp>/  — each run's candidate engines + reports
#   - eval-framework/eval-history.json  — cumulative score history
#

set -euo pipefail

# ─── Configuration ──────────────────────────────────────────────────────────
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVAL_DIR="$PROJECT_ROOT/eval-framework"
SKILL_DIR="$PROJECT_ROOT/excel-to-engine"
MAX_ITERATIONS="${1:-3}"
TARGET_SCORE="${2:-95.0}"
HISTORY_FILE="$EVAL_DIR/eval-history.json"

# Excel files (adjust paths as needed)
A1_EXCEL="$PROJECT_ROOT/Outpost Corporate Model (2025.03.04) v2_A-1 Standalone.xlsx"
A2_EXCEL="$PROJECT_ROOT/Outpost Corporate Model_A-2 Deployment (2025.03.17) v5.xlsx"

# ─── Helpers ────────────────────────────────────────────────────────────────
timestamp() { date +"%Y%m%d_%H%M%S"; }
log() { echo "[$(date +%H:%M:%S)] $*"; }

# Initialize history file if needed
if [ ! -f "$HISTORY_FILE" ]; then
  echo '{"runs":[]}' > "$HISTORY_FILE"
fi

# ─── Main Loop ──────────────────────────────────────────────────────────────
ITERATION=0
BEST_SCORE=0

while [ "$ITERATION" -lt "$MAX_ITERATIONS" ]; do
  ITERATION=$((ITERATION + 1))
  TS=$(timestamp)
  RUN_DIR="$EVAL_DIR/runs/$TS"
  CANDIDATE_DIR="$RUN_DIR/candidate"

  mkdir -p "$CANDIDATE_DIR"
  log "═══════════════════════════════════════════════════"
  log "  ITERATION $ITERATION / $MAX_ITERATIONS"
  log "  Run directory: $RUN_DIR"
  log "═══════════════════════════════════════════════════"

  # ─── Step 1: Run blind test via Claude Code ─────────────────────────────
  log "Step 1: Launching blind Claude Code instance..."

  PROMPT="You are building JavaScript financial computation engines from Excel models.

IMPORTANT RULES:
- Do NOT read control-baseline.json
- Do NOT read any engine.js or engine-a2.js outside your candidate/ directory
- You CAN read the Excel files and the excel-to-engine skill

Your task:
1. Use the excel-to-engine skill at $SKILL_DIR to analyze both Excel models
2. Build engines and place them at:
   - $CANDIDATE_DIR/engine.js (exports computeModel, BASE_CASE)
   - $CANDIDATE_DIR/engine-a2.js (exports computeModelA2, BASE_CASE_A2)
3. The engines must match the interface defined in $EVAL_DIR/BLIND_TEST_INSTRUCTIONS.md
4. Run: node $EVAL_DIR/compare-outputs.mjs $CANDIDATE_DIR/
5. Save the score to $RUN_DIR/score.txt
6. Save your iteration log to $RUN_DIR/blind-test-log.md

Excel files:
- A-1: $A1_EXCEL
- A-2: $A2_EXCEL

Work autonomously. Build both engines, run the comparator, log your score."

  # Run Claude Code in non-interactive mode
  # Note: adjust the claude command based on your installation
  claude --print "$PROMPT" \
    --allowedTools "Read,Write,Edit,Bash,Glob,Grep,Agent" \
    --output-file "$RUN_DIR/claude-output.txt" \
    2>&1 | tee "$RUN_DIR/claude-log.txt" || true

  # ─── Step 2: Run comparator ────────────────────────────────────────────
  log "Step 2: Running comparator..."

  if [ -f "$CANDIDATE_DIR/engine.js" ]; then
    node "$EVAL_DIR/compare-outputs.mjs" "$CANDIDATE_DIR/" 2>&1 | tee "$RUN_DIR/comparator-output.txt" || true

    # Extract score from comparison report
    if [ -f "$EVAL_DIR/comparison-report.json" ]; then
      cp "$EVAL_DIR/comparison-report.json" "$RUN_DIR/"
      SCORE=$(node -e "const r=require('$EVAL_DIR/comparison-report.json'); console.log(r.score)")
      echo "$SCORE" > "$RUN_DIR/score.txt"
      log "Score: ${SCORE}%"
    else
      SCORE=0
      echo "0" > "$RUN_DIR/score.txt"
      log "Score: 0% (no comparison report)"
    fi
  else
    SCORE=0
    echo "0" > "$RUN_DIR/score.txt"
    log "Score: 0% (no engine.js produced)"
  fi

  # ─── Step 3: Record in history ─────────────────────────────────────────
  node -e "
    const fs = require('fs');
    const h = JSON.parse(fs.readFileSync('$HISTORY_FILE'));
    h.runs.push({
      iteration: $ITERATION,
      timestamp: '$TS',
      score: $SCORE,
      runDir: '$RUN_DIR'
    });
    fs.writeFileSync('$HISTORY_FILE', JSON.stringify(h, null, 2));
  "

  # Track best score
  if (( $(echo "$SCORE > $BEST_SCORE" | bc -l) )); then
    BEST_SCORE=$SCORE
  fi

  # ─── Step 4: Check if target reached ───────────────────────────────────
  if (( $(echo "$SCORE >= $TARGET_SCORE" | bc -l) )); then
    log "🎯 TARGET REACHED: ${SCORE}% >= ${TARGET_SCORE}%"
    break
  fi

  # ─── Step 5: Analyze failures and improve skill ────────────────────────
  if [ "$ITERATION" -lt "$MAX_ITERATIONS" ]; then
    log "Step 5: Analyzing failures and improving skill..."

    IMPROVE_PROMPT="You are improving the excel-to-engine skill based on blind test results.

The blind tester scored ${SCORE}% (target: ${TARGET_SCORE}%).

Failure report: $(cat "$RUN_DIR/comparator-output.txt" 2>/dev/null || echo 'No output')

Comparison details: $(cat "$RUN_DIR/comparison-report.json" 2>/dev/null | head -100 || echo 'No report')

Blind tester log: $(cat "$RUN_DIR/blind-test-log.md" 2>/dev/null | head -200 || echo 'No log')

Analyze the failure patterns and update the skill at $SKILL_DIR to help future blind testers avoid these issues. Focus on:
1. Calibration guidance — are the instructions clear enough?
2. Input/output interface — does the skill specify the exact field names?
3. Waterfall structure — does the skill explain the tier structure clearly?
4. Base case detection — does the skill tell Claude where to find base case values?

Update skill/SKILL.md and any relevant lib/ or template files."

    claude --print "$IMPROVE_PROMPT" \
      --allowedTools "Read,Write,Edit,Bash,Glob,Grep" \
      --output-file "$RUN_DIR/improve-output.txt" \
      2>&1 | tee "$RUN_DIR/improve-log.txt" || true

    log "Skill updated. Starting next iteration..."
  fi
done

# ─── Final Summary ──────────────────────────────────────────────────────────
log ""
log "═══════════════════════════════════════════════════"
log "  EVALUATION COMPLETE"
log "═══════════════════════════════════════════════════"
log "  Iterations: $ITERATION"
log "  Best score: ${BEST_SCORE}%"
log "  Target: ${TARGET_SCORE}%"
log "  History: $HISTORY_FILE"
log "═══════════════════════════════════════════════════"

if (( $(echo "$BEST_SCORE >= $TARGET_SCORE" | bc -l) )); then
  log "✅ PASS — Skill produces engines within tolerance"
  exit 0
else
  log "❌ FAIL — Best score ${BEST_SCORE}% below target ${TARGET_SCORE}%"
  exit 1
fi

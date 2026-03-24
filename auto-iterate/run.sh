#!/bin/bash
#
# Run the auto-iterate container on one or more Excel models.
#
# Usage:
#   ./run.sh                          # Run all .xlsx files in ./models/
#   ./run.sh model.xlsx               # Run a specific model
#   ./run.sh /path/to/model.xlsx      # Absolute path
#
# Prerequisites:
#   - Docker installed and running
#   - ANTHROPIC_API_KEY set in environment (or .env file)
#   - Model files in ./models/ directory
#
# Configuration (environment variables):
#   ANTHROPIC_API_KEY   — Required (or in .env file)
#   TARGET_ACCURACY     — Stop threshold (default: 0.85)
#   MAX_ITERATIONS      — Max improvement loops (default: 30)
#   MODEL_NAME          — Claude model (default: claude-sonnet-4-20250514)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MODELS_DIR="${SCRIPT_DIR}/models"
OUTPUT_DIR="${SCRIPT_DIR}/output"
IMAGE_NAME="excel-iterate"

# Load .env if present
if [ -f "${SCRIPT_DIR}/.env" ]; then
  export $(grep -v '^#' "${SCRIPT_DIR}/.env" | xargs)
fi

# Check API key
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Error: ANTHROPIC_API_KEY is not set."
  echo "Set it in your environment or create auto-iterate/.env with:"
  echo "  ANTHROPIC_API_KEY=sk-ant-..."
  exit 1
fi

# Build the container
echo "Building container..."
docker build -t "$IMAGE_NAME" -f "${SCRIPT_DIR}/Dockerfile" "$PROJECT_DIR"

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Determine which models to run
if [ $# -gt 0 ]; then
  MODELS=("$@")
else
  if [ ! -d "$MODELS_DIR" ]; then
    echo "No models directory found at $MODELS_DIR"
    echo "Create it and add .xlsx files, or pass a model path as an argument."
    echo ""
    echo "Example:"
    echo "  mkdir -p ${MODELS_DIR}"
    echo "  cp /path/to/model.xlsx ${MODELS_DIR}/"
    echo "  ./run.sh"
    exit 1
  fi
  MODELS=("$MODELS_DIR"/*.xlsx)
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Auto-Iterate Pipeline"
echo "  Models: ${#MODELS[@]}"
echo "  Target: ${TARGET_ACCURACY:-85}%"
echo "  Max iterations: ${MAX_ITERATIONS:-30}"
echo "  Output: ${OUTPUT_DIR}"
echo "═══════════════════════════════════════════════════════"
echo ""

for MODEL in "${MODELS[@]}"; do
  # If it's a filename (not a path), look in models dir
  if [ ! -f "$MODEL" ] && [ -f "${MODELS_DIR}/$(basename "$MODEL")" ]; then
    MODEL="${MODELS_DIR}/$(basename "$MODEL")"
  fi

  if [ ! -f "$MODEL" ]; then
    echo "⚠️  Model not found: $MODEL — skipping"
    continue
  fi

  MODEL_BASENAME="$(basename "$MODEL")"
  echo "▶ Running: ${MODEL_BASENAME}"
  echo "  Started: $(date)"

  # Mount the model's parent directory so Docker can access it
  MODEL_DIR="$(cd "$(dirname "$MODEL")" && pwd)"
  MODEL_FILE="$(basename "$MODEL")"

  docker run --rm \
    -v "${MODEL_DIR}:/data/models:ro" \
    -v "${OUTPUT_DIR}:/data/output" \
    -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
    -e TARGET_ACCURACY="${TARGET_ACCURACY:-0.85}" \
    -e MAX_ITERATIONS="${MAX_ITERATIONS:-30}" \
    -e MODEL_NAME="${MODEL_NAME:-claude-sonnet-4-20250514}" \
    "$IMAGE_NAME" \
    "/data/models/${MODEL_FILE}" \
    2>&1 | tee "${OUTPUT_DIR}/${MODEL_FILE%.xlsx}-console.log"

  EXIT_CODE=${PIPESTATUS[0]}
  if [ $EXIT_CODE -eq 0 ]; then
    echo "  ✅ Completed: ${MODEL_BASENAME}"
  else
    echo "  ⚠️  Finished with issues: ${MODEL_BASENAME} (exit code: $EXIT_CODE)"
  fi
  echo "  Finished: $(date)"
  echo ""
done

echo "═══════════════════════════════════════════════════════"
echo "  All models processed. Output: ${OUTPUT_DIR}"
echo "═══════════════════════════════════════════════════════"

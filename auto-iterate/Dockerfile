# auto-iterate — Self-improving Excel-to-Engine pipeline
#
# Runs: parse → eval → diagnose (Claude API) → patch → rebuild → re-eval → loop
#
# Usage:
#   docker build -t excel-iterate ./auto-iterate
#   docker run -v /path/to/models:/data/models \
#              -v /path/to/output:/data/output \
#              -e ANTHROPIC_API_KEY=sk-... \
#              excel-iterate model-name.xlsx

# ─── Stage 1: Rust build ────────────────────────────────────────────────────
FROM rust:1.82-slim-bookworm AS rust-builder

WORKDIR /build/rust-parser

# Copy Cargo files for dependency caching
COPY rust-parser/Cargo.toml rust-parser/Cargo.lock* ./

# Pre-fetch deps with dummy main
RUN mkdir -p src && echo 'fn main() {}' > src/main.rs
RUN cargo build --release 2>&1 || true

# Copy real source and build
COPY rust-parser/src ./src
RUN touch src/main.rs && cargo build --release

# ─── Stage 2: Node.js runtime ───────────────────────────────────────────────
FROM node:20-slim AS runtime

WORKDIR /app

# Install cargo for rebuilds during iteration
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl build-essential pkg-config libssl-dev && \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && \
    rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.cargo/bin:${PATH}"

# Copy the initial Rust binary
COPY --from=rust-builder /build/rust-parser/target/release/rust-parser /usr/local/bin/rust-parser

# Copy Rust source (for patching during iteration)
COPY rust-parser/ /app/rust-parser/

# Install Node dependencies
COPY auto-iterate/package.json ./
RUN npm install --production

# Copy iteration script + pipeline
COPY auto-iterate/iterate.mjs ./
COPY container/pipeline.mjs ./pipeline.mjs
COPY lib ./lib/

# Data directories (mount models + output here)
VOLUME ["/data/models", "/data/output"]

# Environment defaults
ENV ANTHROPIC_API_KEY=""
ENV TARGET_ACCURACY="0.90"
ENV MAX_ITERATIONS="30"
ENV MODEL_NAME="claude-sonnet-4-6-20260220"
ENV RUST_PARSER_BIN="/usr/local/bin/rust-parser"

# Entry: pass the xlsx filename as the argument
ENTRYPOINT ["node", "iterate.mjs"]

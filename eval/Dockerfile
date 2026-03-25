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
COPY pipelines/rust/Cargo.toml pipelines/rust/Cargo.lock* ./

# Pre-fetch deps with dummy main
RUN mkdir -p src && echo 'fn main() {}' > src/main.rs
RUN cargo build --release 2>&1 || true

# Copy real source and build
COPY pipelines/rust/src ./src
RUN touch src/main.rs && cargo build --release

# ─── Stage 2: Node.js runtime ───────────────────────────────────────────────
FROM node:20-slim AS runtime

WORKDIR /app

# Install build tools for Rust rebuilds during iteration
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config libssl-dev && \
    rm -rf /var/lib/apt/lists/*

# Copy Rust toolchain from builder stage (avoids curl + rustup issues)
COPY --from=rust-builder /usr/local/cargo /usr/local/cargo
COPY --from=rust-builder /usr/local/rustup /usr/local/rustup
ENV RUSTUP_HOME="/usr/local/rustup"
ENV CARGO_HOME="/usr/local/cargo"
ENV PATH="/usr/local/cargo/bin:${PATH}"

# Copy the initial Rust binary
COPY --from=rust-builder /build/rust-parser/target/release/rust-parser /usr/local/bin/rust-parser

# Copy Rust source AND the pre-built target dir (for fast rebuilds during iteration)
COPY pipelines/rust/ /app/rust-parser/
COPY --from=rust-builder /build/rust-parser/target /app/rust-parser/target

# Install Node dependencies
COPY eval/package.json ./
RUN npm install --production

# Copy iteration script + pipeline
COPY eval/iterate.mjs ./
COPY eval/pipeline.mjs ./pipeline.mjs
COPY lib ./lib/

# Data directories (mount models + output here)
VOLUME ["/data/models", "/data/output"]

# Environment defaults
ENV ANTHROPIC_API_KEY=""
ENV TARGET_ACCURACY="0.90"
ENV MAX_ITERATIONS="30"
ENV MODEL_NAME="claude-sonnet-4-6"
ENV RUST_PARSER_BIN="/usr/local/bin/rust-parser"

# Entry: pass the xlsx filename as the argument
ENTRYPOINT ["node", "iterate.mjs"]

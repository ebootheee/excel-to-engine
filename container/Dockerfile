# Multi-stage Dockerfile for the excel-to-engine pipeline
#
# Stage 1: Build the Rust parser binary
# Stage 2: Node.js runtime with the compiled binary + JS pipeline

# ─── Stage 1: Rust build ───────────────────────────────────────────────────
FROM rust:1.76-slim-bookworm AS rust-builder

WORKDIR /build/rust-parser

# Copy only Cargo files first for layer caching
COPY rust-parser/Cargo.toml rust-parser/Cargo.lock* ./

# Create a dummy main.rs to pre-fetch dependencies
RUN mkdir -p src && echo 'fn main() {}' > src/main.rs
RUN cargo build --release 2>&1 || true

# Now copy the real source and build
COPY rust-parser/src ./src
RUN touch src/main.rs && cargo build --release

# ─── Stage 2: Node.js + binary runtime ────────────────────────────────────
FROM node:20-slim AS runtime

WORKDIR /app

# Copy the compiled Rust binary
COPY --from=rust-builder /build/rust-parser/target/release/rust-parser /usr/local/bin/rust-parser

# Copy JS pipeline files
COPY container/package.json ./
RUN npm install --production

COPY container/pipeline.mjs ./
COPY container/eval-loop.mjs ./
COPY container/validate-extraction.mjs ./

# Copy the JS libraries
COPY lib ./lib/

# Data directory (mount your .xlsx here)
VOLUME ["/data"]

# Default command: run the pipeline on /data/model.xlsx
CMD ["node", "pipeline.mjs", "/data/model.xlsx", "/data/output"]

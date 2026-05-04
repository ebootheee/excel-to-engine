/**
 * monitor/server.mjs — Browser Monitor Dashboard Server
 *
 * Serves the HTML dashboard at http://localhost:3000
 * Runs the pipeline as a child process and streams events via WebSocket.
 * Also accepts .xlsx file uploads to kick off the pipeline from the browser.
 *
 * Usage:
 *   node container/monitor/server.mjs
 *
 * Then open: http://localhost:3000
 */

import { createServer } from 'http';
import { readFile, mkdir } from 'fs/promises';
import { existsSync, createWriteStream } from 'fs';
import { basename, join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { WebSocketServer } from 'ws';

const __dir = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dir, '../..');
const CONTAINER_DIR = resolve(__dir, '..');
const UPLOADS_DIR = resolve(__dir, '../../.pipeline-uploads');
const OUTPUTS_DIR = resolve(__dir, '../../.pipeline-outputs');

const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '127.0.0.1';
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || String(200 * 1024 * 1024)); // 200 MB
const ALLOWED_ORIGIN = `http://localhost:${PORT}`;
const RUST_PARSER = process.env.RUST_PARSER_BIN
  || resolve(PROJECT_ROOT, 'rust-parser/target/release/rust-parser');

function isOriginAllowed(req) {
  const origin = req.headers.origin;
  // Same-origin browser requests omit Origin; CLI/curl also omit it. Only reject
  // when an explicit Origin header is present and doesn't match the bind addr.
  if (!origin) return true;
  return origin === ALLOWED_ORIGIN || origin === `http://127.0.0.1:${PORT}`;
}

function safeUploadPath(rawFilename) {
  // Strip any path components and restrict to a conservative charset. The base
  // name might still collide between users; prefix with a timestamp to avoid
  // overwriting an active upload.
  const base = basename(String(rawFilename || ''));
  const cleaned = base.replace(/[^\w.\-]/g, '_').slice(0, 200);
  const safe = cleaned.length > 0 ? cleaned : 'upload.xlsx';
  return join(UPLOADS_DIR, `${Date.now()}-${safe}`);
}

await mkdir(UPLOADS_DIR, { recursive: true });
await mkdir(OUTPUTS_DIR, { recursive: true });

// Track active pipeline run
let activeRun = null;
const clients = new Set();

// ── HTTP server ───────────────────────────────────────────────────────────────
const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Serve dashboard HTML
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = await readFile(join(__dir, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // File upload endpoint
  if (req.method === 'POST' && url.pathname === '/run') {
    if (!isOriginAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Origin not allowed' }));
      return;
    }
    if (activeRun) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Pipeline already running' }));
      return;
    }

    // Parse multipart upload manually (avoid multer for simplicity)
    const boundary = req.headers['content-type']?.match(/boundary=(.+)/)?.[1];
    if (!boundary) {
      res.writeHead(400);
      res.end('Expected multipart/form-data');
      return;
    }

    const declaredLen = parseInt(req.headers['content-length'] || '0', 10);
    if (declaredLen && declaredLen > MAX_UPLOAD_BYTES) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Upload too large (>${MAX_UPLOAD_BYTES} bytes)` }));
      return;
    }

    const chunks = [];
    let received = 0;
    let aborted = false;
    for await (const chunk of req) {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) {
        aborted = true;
        break;
      }
      chunks.push(chunk);
    }
    if (aborted) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upload exceeded MAX_UPLOAD_BYTES' }));
      return;
    }
    const body = Buffer.concat(chunks);

    // Extract file from multipart body
    const headerEnd = body.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      res.writeHead(400);
      res.end('Malformed multipart body');
      return;
    }
    const fileStart = headerEnd + 4;
    const fileEnd = body.lastIndexOf('\r\n--' + boundary);
    if (fileEnd <= fileStart) {
      res.writeHead(400);
      res.end('Malformed multipart body');
      return;
    }
    const fileData = body.slice(fileStart, fileEnd);

    // Get filename from Content-Disposition header. Sanitize to prevent path
    // traversal — `filename="../../etc/foo"` would otherwise escape UPLOADS_DIR.
    const headerSection = body.slice(0, headerEnd).toString();
    const filenameMatch = headerSection.match(/filename="([^"]+)"/);
    const uploadPath = safeUploadPath(filenameMatch?.[1]);
    const outputDir = join(OUTPUTS_DIR, `${Date.now()}`);
    await mkdir(outputDir, { recursive: true });

    const ws = createWriteStream(uploadPath);
    ws.write(fileData);
    await new Promise(r => ws.end(r));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, filename: basename(uploadPath) }));

    // Start pipeline (non-blocking)
    runPipeline(uploadPath, outputDir);
    return;
  }

  // Status endpoint
  if (req.method === 'GET' && url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ running: !!activeRun }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket server ──────────────────────────────────────────────────────────
// `verifyClient` rejects WS upgrades whose Origin isn't the dashboard. Without
// this, an attacker page in the user's browser could trigger pipeline runs.
const wss = new WebSocketServer({
  server: httpServer,
  verifyClient: (info) => isOriginAllowed(info.req),
});

wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'connected', running: !!activeRun }));
  ws.on('close', () => clients.delete(ws));

  // The previous WS `run` action accepted an arbitrary local path from any
  // connected client and spawned the pipeline against it. That's a remote
  // arbitrary-file-execution primitive — even with the Origin gate above, we
  // don't need it: the supported flow is upload → POST /run. Drop the action.
  ws.on('message', () => { /* no-op: WS is broadcast-only */ });
});

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// ── Pipeline runner ───────────────────────────────────────────────────────────
function runPipeline(inputPath, outputDir) {
  if (activeRun) return;

  broadcast('pipeline_start', { file: inputPath, outputDir });

  const env = {
    ...process.env,
    RUST_PARSER_BIN: RUST_PARSER,
    WS_PORT: '0',  // Pipeline doesn't need its own WS; we stream from here
    LIB_PATH: resolve(PROJECT_ROOT, 'lib') + '/',
  };

  const child = spawn('node', [join(CONTAINER_DIR, 'pipeline.mjs'), inputPath, outputDir], {
    env,
    cwd: CONTAINER_DIR,
  });

  activeRun = child;

  child.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      // Try to parse structured events from the pipeline
      if (line.startsWith('[phase] ') || line.startsWith('[progress] ') || line.startsWith('[complete] ')) {
        try {
          const bracket = line.indexOf(']');
          const eventType = line.slice(1, bracket);
          const payload = JSON.parse(line.slice(bracket + 2));
          broadcast(eventType, payload);
          continue;
        } catch {}
      }
      broadcast('log', line);
    }
  });

  child.stderr.on('data', (data) => {
    broadcast('log', `[stderr] ${data.toString().trim()}`);
  });

  child.on('close', async (code) => {
    activeRun = null;

    // Try to read diagnostics.json and broadcast it
    const diagPath = join(outputDir, 'diagnostics.json');
    if (existsSync(diagPath)) {
      try {
        const diag = JSON.parse(await readFile(diagPath, 'utf8'));
        broadcast('diagnostics', diag);
      } catch {}
    }

    broadcast('pipeline_end', { code, outputDir });
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
// Bind to loopback by default so the dashboard isn't exposed on LAN/WAN. Set
// HOST=0.0.0.0 explicitly if you need to expose it (and add an auth layer).
httpServer.listen(PORT, HOST, () => {
  console.log(`Monitor dashboard: http://${HOST}:${PORT}`);
  console.log(`WebSocket:         ws://${HOST}:${PORT}`);
  console.log(`Rust parser:       ${RUST_PARSER}`);
  console.log(`Max upload:        ${MAX_UPLOAD_BYTES} bytes`);
  console.log(`Press Ctrl+C to stop.`);
});

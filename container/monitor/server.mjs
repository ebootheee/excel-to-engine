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
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { WebSocketServer } from 'ws';

const __dir = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dir, '../..');
const CONTAINER_DIR = resolve(__dir, '..');
const UPLOADS_DIR = resolve(__dir, '../../.pipeline-uploads');
const OUTPUTS_DIR = resolve(__dir, '../../.pipeline-outputs');

const PORT = parseInt(process.env.PORT || '3000');
const RUST_PARSER = process.env.RUST_PARSER_BIN
  || resolve(PROJECT_ROOT, 'rust-parser/target/release/rust-parser');

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

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    // Extract file from multipart body
    const boundaryBuf = Buffer.from('--' + boundary);
    const headerEnd = body.indexOf('\r\n\r\n');
    const fileStart = headerEnd + 4;
    const fileEnd = body.lastIndexOf('\r\n--' + boundary);
    const fileData = body.slice(fileStart, fileEnd);

    // Get filename from Content-Disposition header
    const headerSection = body.slice(0, headerEnd).toString();
    const filenameMatch = headerSection.match(/filename="([^"]+)"/);
    const filename = filenameMatch?.[1] || `upload-${Date.now()}.xlsx`;

    const uploadPath = join(UPLOADS_DIR, filename);
    const outputDir = join(OUTPUTS_DIR, `${Date.now()}`);
    await mkdir(outputDir, { recursive: true });

    const ws = createWriteStream(uploadPath);
    ws.write(fileData);
    await new Promise(r => ws.end(r));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, filename }));

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
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'connected', running: !!activeRun }));
  ws.on('close', () => clients.delete(ws));

  // Allow clients to trigger a run via WS (send JSON: { action: 'run', path: '...' })
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.action === 'run' && msg.path && !activeRun) {
        const outputDir = join(OUTPUTS_DIR, `${Date.now()}`);
        await mkdir(outputDir, { recursive: true });
        runPipeline(msg.path, outputDir);
      }
    } catch {}
  });
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
httpServer.listen(PORT, () => {
  console.log(`Monitor dashboard: http://localhost:${PORT}`);
  console.log(`WebSocket:         ws://localhost:${PORT}`);
  console.log(`Rust parser:       ${RUST_PARSER}`);
  console.log(`Press Ctrl+C to stop.`);
});

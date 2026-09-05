// Simple HTTP proxy to capture OpenCode's requests to llama-server.
// Usage: node proxy.js
// Then point OpenCode to http://localhost:8099 instead of the real endpoint.
// Captures the first large request body to .kv-warmup-request.json for analysis.

import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const TARGET_HOST = '100.77.65.108';
const TARGET_PORT = 8090;
const LISTEN_PORT = 8099;

const configDir = process.env.XDG_CONFIG_HOME
  ? join(process.env.XDG_CONFIG_HOME, 'opencode')
  : join(os.homedir(), '.config', 'opencode');

const CAPTURE_PATH = join(configDir, '.kv-warmup-request.json');
let captured = false;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    // Capture first large request (the real conversation, not title gen)
    if (!captured && body.length > 5000 && req.url.includes('/chat/completions')) {
      try {
        const parsed = JSON.parse(body);
        const info = {
          url: req.url,
          method: req.method,
          body: parsed,
          timestamp: new Date().toISOString(),
          bodySize: body.length,
          hasTools: !!(parsed.tools && parsed.tools.length),
          toolCount: (parsed.tools || []).length,
          messageCount: (parsed.messages || []).length,
        };
        writeFileSync(CAPTURE_PATH, JSON.stringify(info, null, 2), 'utf8');
        console.log(`[proxy] captured request: ${body.length} chars, ${info.toolCount} tools, ${info.messageCount} messages`);
        captured = true;
      } catch {}
    }

    // Forward to real server
    const proxyReq = http.request({
      hostname: TARGET_HOST,
      port: TARGET_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error(`[proxy] error: ${err.message}`);
      res.writeHead(502);
      res.end('Bad Gateway');
    });

    proxyReq.write(body);
    proxyReq.end();
  });
});

server.listen(LISTEN_PORT, () => {
  console.log(`[proxy] listening on :${LISTEN_PORT}, forwarding to ${TARGET_HOST}:${TARGET_PORT}`);
  console.log(`[proxy] will capture first large request to ${CAPTURE_PATH}`);
});

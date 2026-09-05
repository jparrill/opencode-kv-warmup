// kv-warmup — opencode plugin
//
// Pre-warms llama-server KV cache on session start to reduce TTFT.
//
// Architecture: embedded reverse proxy
//   - Plugin starts an HTTP proxy on localhost (port from config)
//   - OpenCode's provider baseURL points to the proxy
//   - Proxy forwards all requests to the real llama-server endpoint
//   - Proxy captures the latest large request body for future warmup
//   - On next boot, plugin replays the captured request directly to the
//     real endpoint (max_tokens:1), filling the KV cache before the user types
//
// Config: ~/.config/opencode/kv-warmup.json
//   {
//     "enabled": true,
//     "endpoint": "http://100.77.65.108:8090",
//     "proxyPort": 8099,
//     "smallModelEndpoint": "http://100.77.65.108:8091/v1",
//     "clearCache": false        // set true to delete capture for current dir (auto-resets)
//   }
//
// Hot-reload: proxy re-reads config on every request.
//   enabled: false  → proxy becomes transparent passthrough (no capture, no warmup on restart)
//   clearCache: true → deletes capture for current dir, resets to false
//
// OpenCode provider baseURL must point to: http://localhost:<proxyPort>/v1

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';

function configDir() {
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, 'opencode');
  }
  return join(os.homedir(), '.config', 'opencode');
}

const CAPTURES_DIR = join(configDir(), '.kv-warmup-captures');
const DEBUG_DIR = join(configDir(), '.kv-warmup-debug');
const CONFIG_PATH = join(configDir(), 'kv-warmup.json');
const STATUS_PATH = join(configDir(), '.kv-warmup-status.json');

function dirHash(dir) {
  return createHash('sha256').update(dir).digest('hex').slice(0, 12);
}

function requestPath() {
  return join(CAPTURES_DIR, `${dirHash(process.cwd())}.json`);
}

function writeStatus(state, detail) {
  try {
    writeFileSync(STATUS_PATH, JSON.stringify({
      state,
      detail: detail || '',
      updated: new Date().toISOString(),
      pid: process.pid,
    }, null, 2), 'utf8');
  } catch {}
}

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { enabled: true, endpoint: '', proxyPort: 8099 };
  }
}

function loadCapturedRequest() {
  try {
    return JSON.parse(readFileSync(requestPath(), 'utf8'));
  } catch {
    return null;
  }
}

function saveCapturedRequest(body) {
  try {
    mkdirSync(CAPTURES_DIR, { recursive: true });
    writeFileSync(requestPath(), JSON.stringify({
      body,
      directory: process.cwd(),
      timestamp: new Date().toISOString(),
      bodySize: JSON.stringify(body).length,
    }, null, 2), 'utf8');
  } catch {}
}

function deleteCapturedRequest() {
  try {
    unlinkSync(requestPath());
    return true;
  } catch {
    return false;
  }
}

function saveConfig(cfg) {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  } catch {}
}

let warmupInFlight = false;
let warmupAbort = null;
let capturedThisSession = false;

function log() {}

function logError(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[kv-warmup ${ts}] ${msg}\n`);
}

function dumpRequestForDiff(parsed) {
  try {
    mkdirSync(DEBUG_DIR, { recursive: true });
    const hash = dirHash(process.cwd());
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(DEBUG_DIR, `${hash}_${ts}.json`);
    writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf8');
  } catch {}
}

// ─── Warmup ───

function buildWarmupBody(requestBody) {
  const body = {
    ...requestBody,
    max_tokens: 1,
    stream: false,
    messages: requestBody.messages.map(m =>
      m.role === 'user' ? { ...m, content: 'ping' } : m
    ),
  };
  delete body.stream_options;
  return body;
}

async function sendWarmup(endpoint, requestBody, signal) {
  const body = buildWarmupBody(requestBody);
  const url = endpoint.replace(/\/+$/, '') + '/v1/chat/completions';
  writeStatus('warming', 'priming KV cache...');

  const start = Date.now();
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (resp.ok) {
      const result = await resp.json().catch(() => ({}));
      const tokens = result?.usage?.prompt_tokens || '?';
      writeStatus('ready', `KV cache primed in ${elapsed}s (${tokens} tokens)`);
      return true;
    } else {
      logError(`warmup failed (${resp.status}) after ${elapsed}s`);
      writeStatus('error', `HTTP ${resp.status} after ${elapsed}s`);
      return false;
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      logError(`warmup error: ${err.message}`);
      writeStatus('error', `${err.message} after ${elapsed}s`);
    }
    return false;
  }
}

function initWarmup(config) {
  if (!config.enabled || !config.endpoint) {
    writeStatus(config.enabled ? 'error' : 'disabled',
      config.enabled ? 'no endpoint in kv-warmup.json' : 'set enabled: true in kv-warmup.json');
    return;
  }
  const cached = loadCapturedRequest();
  if (!cached || !cached.body?.messages?.length) {
    writeStatus('no-cache', 'will capture on first message');
    return;
  }
  sendWarmup(config.endpoint, cached.body);
}

// ─── Embedded Proxy ───

let inlineWarmupDone = false;

function forwardRequest(targetHost, targetPort, req, res, rawBody) {
  const proxyReq = http.request({
    hostname: targetHost,
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `${targetHost}:${targetPort}` },
  }, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', err => {
    logError(`proxy forward error: ${err.message}`);
    res.writeHead(502);
    res.end(JSON.stringify({
      error: { message: `kv-warmup proxy: cannot reach ${targetHost}:${targetPort} — ${err.message}` },
    }));
  });

  proxyReq.write(rawBody);
  proxyReq.end();
}

function startProxy(config) {
  const targetUrl = new URL(config.endpoint);
  const targetHost = targetUrl.hostname;
  const targetPort = parseInt(targetUrl.port) || 80;
  const proxyPort = config.proxyPort || 8099;

  const server = http.createServer((req, res) => {
    let chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const rawBody = Buffer.concat(chunks).toString();
      const isChatCompletion = rawBody.length > 5000 && req.url.includes('/chat/completions');

      const hotConfig = loadConfig();

      if (hotConfig.clearCache) {
        deleteCapturedRequest();
        capturedThisSession = false;
        inlineWarmupDone = false;
        hotConfig.clearCache = false;
        saveConfig(hotConfig);
        writeStatus('cache-cleared', 'capture deleted, will re-capture on next message');
      }

      // Disabled: inline warmup adds 43.5s when KV is cold.
      // TODO: re-enable once we fix the ~32% system prompt token drift between sessions.

      if (isChatCompletion && hotConfig.enabled !== false && !capturedThisSession) {
        capturedThisSession = true;
        try {
          const parsed = JSON.parse(rawBody);
          saveCapturedRequest(parsed);
          dumpRequestForDiff(parsed);
        } catch {}
      }

      forwardRequest(targetHost, targetPort, req, res, rawBody);
    });
  });

  return new Promise((resolve) => {
    server.on('error', err => {
      if (err.code === 'EADDRINUSE') {
        resolve({ started: true, server: null });
      } else {
        logError(`proxy FAILED to start: ${err.message}`);
        resolve({ started: false, error: err.message });
      }
    });

    server.listen(proxyPort, '127.0.0.1', () => {
      resolve({ started: true, server });
    });
  });
}

// ─── Fallback: direct mode without proxy ───
// If the proxy fails to start, requests go directly to the real endpoint.
// Warmup still works, but capture is unavailable (no auto-refresh).

async function startFallbackHealthCheck(config) {
  const proxyPort = config.proxyPort || 8099;
  const targetHost = new URL(config.endpoint).hostname;
  const targetPort = parseInt(new URL(config.endpoint).port) || 80;

  // Start a minimal server that returns a clear error
  const server = http.createServer((_req, res) => {
    res.writeHead(502);
    res.end(JSON.stringify({
      error: { message: `kv-warmup proxy failed to start. Requests should go directly to ${targetHost}:${targetPort}` },
    }));
  });

  server.on('error', () => {});
  server.listen(proxyPort, '127.0.0.1', () => {
    log(`fallback error server on :${proxyPort} — returns 502 with instructions`);
  });
}

// ─── Small Model Health Cache ───
// Cache health check result to avoid 2s timeout on every title gen

let smallModelHealthy = null;
let smallModelHealthCheckedAt = 0;
const HEALTH_CACHE_MS = 30_000;

async function isSmallModelHealthy(smallUrl) {
  const now = Date.now();
  if (smallModelHealthy !== null && (now - smallModelHealthCheckedAt) < HEALTH_CACHE_MS) {
    return smallModelHealthy;
  }
  try {
    const resp = await fetch(smallUrl.replace(/\/v1\/?$/, '') + '/health', {
      signal: AbortSignal.timeout(2000),
    });
    smallModelHealthy = resp.ok;
  } catch {
    smallModelHealthy = false;
  }
  smallModelHealthCheckedAt = now;
  if (!smallModelHealthy) {
    log('MoE server unhealthy — title gen will hit dense server (KV cache at risk)');
    writeStatus('warning', 'MoE server down — title gen may evict KV cache');
  }
  return smallModelHealthy;
}

// ─── Plugin Entry ───

export const KvWarmupPlugin = async (_ctx) => {
  const config = loadConfig();
  if (!config.enabled) {
    writeStatus('disabled', 'set enabled: true in kv-warmup.json');
    return {};
  }

  // Start embedded proxy
  let proxyOk = false;
  if (config.endpoint) {
    const result = await startProxy(config);
    proxyOk = result.started;

    if (!proxyOk) {
      logError(`CRITICAL: proxy failed — OpenCode baseURL points to dead port`);
      logError(`FIX: either fix the port conflict or change baseURL in opencode.json to ${config.endpoint}/v1`);
      writeStatus('error', `proxy failed to start: ${result.error}. Change baseURL to ${config.endpoint}/v1`);
      await startFallbackHealthCheck(config);
    }
  }

  initWarmup(config);

  return {
    event: async ({ event } = {}) => {
      if (event && event.type === 'session.created') {
        // Reset small model health cache on new session
        smallModelHealthy = null;
      }
    },

    // Redirect small model tasks (title gen) to a secondary endpoint
    // so they don't evict the warmed KV cache on the primary server.
    'experimental.provider.small_model': async (_input, output) => {
      const cfg = loadConfig();
      const smallUrl = cfg.smallModelEndpoint;
      if (!smallUrl) return;

      const healthy = await isSmallModelHealthy(smallUrl);
      if (!healthy) return;

      output.model = {
        id: 'kv-warmup-small-model',
        providerID: 'kv-warmup-moe',
        api: {
          id: 'kv-warmup-moe',
          url: smallUrl,
          npm: '@ai-sdk/openai-compatible',
        },
        name: 'KV Warmup Small Model',
        capabilities: {
          temperature: true,
          reasoning: false,
          attachment: false,
          toolcall: false,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 131072, output: 8192 },
        status: 'active',
        options: { apiKey: 'not-needed' },
        headers: {},
        release_date: '2025-01-01',
      };
    },

    // System transform — no modifications. Status shown in TUI sidebar.
    'experimental.chat.system.transform': async (_input, _output) => {
      // DO NOT inject status into system prompt — breaks prefix cache matching.
    },
  };
};

export default KvWarmupPlugin;

// kv-warmup — opencode plugin
//
// Pre-warms llama-server KV cache on session start to reduce TTFT.
//
// Strategy: replays a captured real request body (from proxy capture) to
// llama-server with max_tokens:1. This creates an EXACT prefix match in the
// KV cache, so the first real request skips prompt processing.
//
// Setup:
//   1. Run proxy.js once to capture a real request
//   2. This plugin reads the captured request on boot and replays it
//   3. llama-server must run with -np 2 to avoid title-gen KV eviction
//
// Config: ~/.config/opencode/kv-warmup.json
//   {
//     "enabled": true,
//     "endpoints": ["http://100.77.65.108:8090"]
//   }
//
// Files:
//   ~/.config/opencode/.kv-warmup-request.json — captured real request (from proxy)
//   ~/.config/opencode/.kv-warmup-status.json  — warmup state for sidebar

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import os from 'node:os';

function configDir() {
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, 'opencode');
  }
  return join(os.homedir(), '.config', 'opencode');
}

const REQUEST_PATH = join(configDir(), '.kv-warmup-request.json');
const CONFIG_PATH = join(configDir(), 'kv-warmup.json');
const STATUS_PATH = join(configDir(), '.kv-warmup-status.json');

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
    return { enabled: true, endpoints: [] };
  }
}

function loadCapturedRequest() {
  try {
    const data = JSON.parse(readFileSync(REQUEST_PATH, 'utf8'));
    return data.body || null;
  } catch {
    return null;
  }
}

// Save the real request body captured via system.transform + hooks.
// This is a FALLBACK capture — the proxy capture produces better results.
// The system.transform hook captures messages, but NOT tools in their
// compact form. If .kv-warmup-request.json already exists from proxy
// capture, this function preserves the tools from it.
function saveCapturedRequest(messages) {
  try {
    let existing = null;
    try { existing = JSON.parse(readFileSync(REQUEST_PATH, 'utf8')); } catch {}

    const body = {
      messages,
      model: existing?.body?.model || 'any',
      max_tokens: 1,
      stream: false,
    };

    // Preserve tools from proxy capture if available
    if (existing?.body?.tools) {
      body.tools = existing.body.tools;
    }

    const data = {
      body,
      timestamp: new Date().toISOString(),
      bodySize: JSON.stringify(body).length,
      hasTools: !!(body.tools && body.tools.length),
      toolCount: (body.tools || []).length,
      source: existing?.body?.tools ? 'hook+proxy-tools' : 'hook-only',
    };

    mkdirSync(dirname(REQUEST_PATH), { recursive: true });
    writeFileSync(REQUEST_PATH, JSON.stringify(data, null, 2), 'utf8');
    return data;
  } catch {
    return null;
  }
}

let warmupInFlight = false;
let warmupAbort = null;
let promptCaptured = false;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[kv-warmup ${ts}] ${msg}\n`);
}

async function sendWarmup(endpoint, requestBody) {
  if (warmupInFlight) {
    log('warmup already in flight, skipping');
    return;
  }

  warmupInFlight = true;
  warmupAbort = new AbortController();

  // Build warmup request from captured body
  const body = {
    ...requestBody,
    max_tokens: 1,
    stream: false,
    // Replace user message with "ping" — prefix (system+tools) stays identical
    messages: requestBody.messages.map((m, i) => {
      if (m.role === 'user') return { ...m, content: 'ping' };
      return m;
    }),
  };

  // Remove streaming options
  delete body.stream_options;

  const url = endpoint.replace(/\/+$/, '') + '/v1/chat/completions';
  const msgChars = body.messages.reduce((s, m) => s + (m.content || '').length, 0);
  const toolCount = (body.tools || []).length;
  log(`warmup start: ${url} (~${msgChars} chars, ${toolCount} tools)`);
  writeStatus('warming', `${url} — ~${msgChars} chars, ${toolCount} tools`);

  const start = Date.now();
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: warmupAbort.signal,
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (resp.ok) {
      const result = await resp.json().catch(() => ({}));
      const tokens = result?.usage?.prompt_tokens || '?';
      log(`warmup done in ${elapsed}s — ${tokens} tokens primed`);
      writeStatus('ready', `KV cache primed in ${elapsed}s (${tokens} tokens)`);
    } else {
      const text = await resp.text().catch(() => '');
      log(`warmup failed (${resp.status}) after ${elapsed}s: ${text.slice(0, 200)}`);
      writeStatus('error', `HTTP ${resp.status} after ${elapsed}s`);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      log('warmup aborted (user sent message before warmup finished)');
      writeStatus('cancelled', 'user typed before warmup finished');
    } else {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      log(`warmup error after ${elapsed}s: ${err.message}`);
      writeStatus('error', `${err.message} after ${elapsed}s`);
    }
  } finally {
    warmupInFlight = false;
    warmupAbort = null;
  }
}

function cancelWarmup() {
  if (warmupAbort) {
    warmupAbort.abort();
    warmupAbort = null;
    warmupInFlight = false;
  }
}

function triggerWarmup() {
  const config = loadConfig();
  if (!config.enabled) {
    log('disabled by config');
    writeStatus('disabled', 'set enabled: true in kv-warmup.json');
    return;
  }

  const endpoints = config.endpoints || [];
  if (endpoints.length === 0) {
    log('no endpoints configured');
    writeStatus('error', 'no endpoints in kv-warmup.json');
    return;
  }

  const captured = loadCapturedRequest();
  if (!captured || !captured.messages || captured.messages.length === 0) {
    log('no captured request — run proxy.js first, or send a message to capture');
    writeStatus('no-cache', 'no captured request — send a message to capture one');
    return;
  }

  const msgChars = captured.messages.reduce((s, m) => s + (m.content || '').length, 0);
  const toolCount = (captured.tools || []).length;
  log(`loaded captured request: ${captured.messages.length} msgs, ~${msgChars} chars, ${toolCount} tools`);

  for (const endpoint of endpoints) {
    sendWarmup(endpoint, captured);
  }
}

export const KvWarmupPlugin = async (_ctx) => {
  triggerWarmup();

  return {
    event: async ({ event } = {}) => {
      if (event && event.type === 'session.created') {
        promptCaptured = false;
      }
    },

    'experimental.chat.system.transform': async (_input, output) => {
      if (!output || !Array.isArray(output.system)) return;

      // DO NOT inject warmup status into system prompt — it modifies the
      // prompt tokens and breaks prefix cache matching with the warmup
      // request. Status is shown in the TUI sidebar instead.

      if (promptCaptured) return;

      const systemContent = output.system.join('\n\n');
      if (systemContent.length < 3000) {
        log(`skipped short prompt (${systemContent.length} chars)`);
        return;
      }

      cancelWarmup();

      // Only save if NO proxy capture exists — proxy capture has the exact
      // request body (2 system messages, compact tools) that matches what
      // OpenCode sends. Hook-based capture produces a different format
      // (1 joined system message, full schemas) that doesn't prefix-match.
      const existing = loadCapturedRequest();
      if (!existing || !existing.tools || existing.tools.length === 0) {
        const messages = [
          { role: 'system', content: systemContent },
          { role: 'user', content: 'ping' },
        ];
        saveCapturedRequest(messages);
        log(`system prompt captured as fallback (${systemContent.length} chars)`);
      } else {
        log(`proxy capture preserved (${systemContent.length} chars current prompt)`);
      }
      promptCaptured = true;
    },
  };
};

export default KvWarmupPlugin;

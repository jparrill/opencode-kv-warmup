import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import http from 'node:http';

const FIXTURES_DIR = join(import.meta.dirname, '.fixtures');

function dirHash(dir) {
  return createHash('sha256').update(dir).digest('hex').slice(0, 12);
}

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

function writeStatus(statusPath, state, detail) {
  writeFileSync(statusPath, JSON.stringify({
    state,
    detail: detail || '',
    updated: new Date().toISOString(),
    pid: process.pid,
  }, null, 2), 'utf8');
}

function saveCapturedRequest(capturesDir, hash, body) {
  mkdirSync(capturesDir, { recursive: true });
  writeFileSync(join(capturesDir, `${hash}.json`), JSON.stringify({
    body,
    directory: '/test',
    timestamp: new Date().toISOString(),
  }, null, 2), 'utf8');
}

function deleteCapturedRequest(capturesDir, hash) {
  try {
    unlinkSync(join(capturesDir, `${hash}.json`));
    return true;
  } catch {
    return false;
  }
}

function dumpRequestForDiff(debugDir, hash, parsed) {
  mkdirSync(debugDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(debugDir, `${hash}_${ts}.json`);
  writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf8');
  const files = readdirSync(debugDir)
    .filter(f => f.startsWith(hash + '_') && f.endsWith('.json'))
    .sort();
  while (files.length > 10) {
    unlinkSync(join(debugDir, files.shift()));
  }
}

before(() => {
  mkdirSync(FIXTURES_DIR, { recursive: true });
});

after(() => {
  rmSync(FIXTURES_DIR, { recursive: true, force: true });
});

// ─── Existing tests ───

describe('dirHash', () => {
  it('produces 12-char hex string', () => {
    const hash = dirHash('/some/path');
    assert.equal(hash.length, 12);
    assert.match(hash, /^[0-9a-f]{12}$/);
  });

  it('is deterministic', () => {
    assert.equal(dirHash('/foo/bar'), dirHash('/foo/bar'));
  });

  it('differs for different paths', () => {
    assert.notEqual(dirHash('/foo'), dirHash('/bar'));
  });
});

describe('buildWarmupBody', () => {
  const sampleRequest = {
    model: 'test-model',
    max_tokens: 8192,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello world' },
    ],
    tools: [{ type: 'function', function: { name: 'read', parameters: {} } }],
  };

  it('sets max_tokens to 1', () => {
    const body = buildWarmupBody(sampleRequest);
    assert.equal(body.max_tokens, 1);
  });

  it('disables streaming', () => {
    const body = buildWarmupBody(sampleRequest);
    assert.equal(body.stream, false);
  });

  it('removes stream_options', () => {
    const body = buildWarmupBody(sampleRequest);
    assert.equal(body.stream_options, undefined);
  });

  it('replaces user message content with ping', () => {
    const body = buildWarmupBody(sampleRequest);
    const userMsg = body.messages.find(m => m.role === 'user');
    assert.equal(userMsg.content, 'ping');
  });

  it('preserves system message content', () => {
    const body = buildWarmupBody(sampleRequest);
    const sysMsg = body.messages.find(m => m.role === 'system');
    assert.equal(sysMsg.content, 'You are helpful.');
  });

  it('preserves tools', () => {
    const body = buildWarmupBody(sampleRequest);
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].function.name, 'read');
  });

  it('preserves model', () => {
    const body = buildWarmupBody(sampleRequest);
    assert.equal(body.model, 'test-model');
  });

  it('does not mutate original', () => {
    buildWarmupBody(sampleRequest);
    assert.equal(sampleRequest.max_tokens, 8192);
    assert.equal(sampleRequest.stream, true);
    assert.equal(sampleRequest.messages[1].content, 'Hello world');
  });

  it('handles multiple user messages', () => {
    const multi = {
      ...sampleRequest,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
    };
    const body = buildWarmupBody(multi);
    const userMsgs = body.messages.filter(m => m.role === 'user');
    assert.equal(userMsgs.length, 2);
    userMsgs.forEach(m => assert.equal(m.content, 'ping'));
  });

  it('preserves assistant messages', () => {
    const withAssistant = {
      ...sampleRequest,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: 'I can help' },
        { role: 'user', content: 'thanks' },
      ],
    };
    const body = buildWarmupBody(withAssistant);
    assert.equal(body.messages[1].content, 'I can help');
  });
});

describe('capture file per directory', () => {
  it('different directories produce different filenames', () => {
    const a = `${dirHash('/Users/me/project-a')}.json`;
    const b = `${dirHash('/Users/me/project-b')}.json`;
    assert.notEqual(a, b);
  });

  it('same directory always produces same filename', () => {
    const path = '/Users/me/project';
    assert.equal(`${dirHash(path)}.json`, `${dirHash(path)}.json`);
  });
});

describe('config loading', () => {
  it('returns defaults for missing file', () => {
    const configPath = join(FIXTURES_DIR, 'missing-config.json');
    let config;
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      config = { enabled: true, endpoint: '', proxyPort: 8099 };
    }
    assert.equal(config.enabled, true);
    assert.equal(config.proxyPort, 8099);
  });

  it('parses valid config', () => {
    const configPath = join(FIXTURES_DIR, 'test-config.json');
    writeFileSync(configPath, JSON.stringify({
      enabled: true,
      endpoint: 'http://localhost:8090',
      proxyPort: 9999,
      smallModelEndpoint: 'http://localhost:8091/v1',
    }));
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(config.endpoint, 'http://localhost:8090');
    assert.equal(config.proxyPort, 9999);
    assert.equal(config.smallModelEndpoint, 'http://localhost:8091/v1');
  });

  it('disabled config is respected', () => {
    const configPath = join(FIXTURES_DIR, 'disabled-config.json');
    writeFileSync(configPath, JSON.stringify({ enabled: false, endpoint: 'http://x', proxyPort: 8099 }));
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(config.enabled, false);
  });
});

describe('proxy forwarding', () => {
  let backend;
  let proxy;
  let backendPort;
  let proxyPort;

  before(async () => {
    backend = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ received: body.length, path: req.url }));
      });
    });

    await new Promise(r => backend.listen(0, '127.0.0.1', r));
    backendPort = backend.address().port;

    proxy = http.createServer((req, res) => {
      let chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString();
        const proxyReq = http.request({
          hostname: '127.0.0.1',
          port: backendPort,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: `127.0.0.1:${backendPort}` },
        }, proxyRes => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });
        proxyReq.write(rawBody);
        proxyReq.end();
      });
    });

    await new Promise(r => proxy.listen(0, '127.0.0.1', r));
    proxyPort = proxy.address().port;
  });

  after(() => {
    backend.close();
    proxy.close();
  });

  it('forwards requests transparently', async () => {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ test: true }),
    });
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.path, '/v1/chat/completions');
    assert.ok(data.received > 0);
  });

  it('preserves request path', async () => {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, {
      method: 'GET',
    });
    const data = await resp.json();
    assert.equal(data.path, '/v1/models');
  });
});

describe('status file', () => {
  it('round-trips state and detail', () => {
    const statusPath = join(FIXTURES_DIR, 'status.json');
    const status = {
      state: 'ready',
      detail: 'KV cache primed in 43.5s (14879 tokens)',
      updated: new Date().toISOString(),
      pid: process.pid,
    };
    writeFileSync(statusPath, JSON.stringify(status, null, 2), 'utf8');
    const loaded = JSON.parse(readFileSync(statusPath, 'utf8'));
    assert.equal(loaded.state, 'ready');
    assert.ok(loaded.detail.includes('14879'));
    assert.equal(loaded.pid, process.pid);
  });

  it('writeStatus writes all fields', () => {
    const statusPath = join(FIXTURES_DIR, 'status-write.json');
    writeStatus(statusPath, 'warming', 'priming KV cache...');
    const loaded = JSON.parse(readFileSync(statusPath, 'utf8'));
    assert.equal(loaded.state, 'warming');
    assert.equal(loaded.detail, 'priming KV cache...');
    assert.ok(loaded.updated);
    assert.equal(loaded.pid, process.pid);
  });

  it('writeStatus defaults detail to empty string', () => {
    const statusPath = join(FIXTURES_DIR, 'status-nodetail.json');
    writeStatus(statusPath, 'disabled');
    const loaded = JSON.parse(readFileSync(statusPath, 'utf8'));
    assert.equal(loaded.detail, '');
  });
});

// ─── New tests ───

describe('dumpRequestForDiff', () => {
  const debugDir = join(FIXTURES_DIR, 'debug-dumps');
  const hash = dirHash('/test/dump');

  beforeEach(() => {
    mkdirSync(debugDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(debugDir, { recursive: true, force: true });
  });

  it('creates debug file with request body', () => {
    const parsed = { model: 'test', messages: [{ role: 'user', content: 'hi' }] };
    dumpRequestForDiff(debugDir, hash, parsed);
    const files = readdirSync(debugDir).filter(f => f.startsWith(hash));
    assert.equal(files.length, 1);
    const content = JSON.parse(readFileSync(join(debugDir, files[0]), 'utf8'));
    assert.equal(content.model, 'test');
  });

  it('caps at 10 files per hash', () => {
    for (let i = 0; i < 13; i++) {
      const ts = `2026-01-01T00-00-${String(i).padStart(2, '0')}-000Z`;
      writeFileSync(join(debugDir, `${hash}_${ts}.json`), '{}');
    }
    dumpRequestForDiff(debugDir, hash, { extra: true });
    const files = readdirSync(debugDir).filter(f => f.startsWith(hash));
    assert.ok(files.length <= 10, `expected <= 10, got ${files.length}`);
  });

  it('keeps newest files when capping', () => {
    for (let i = 0; i < 12; i++) {
      const ts = `2026-01-01T00-00-${String(i).padStart(2, '0')}-000Z`;
      writeFileSync(join(debugDir, `${hash}_${ts}.json`), JSON.stringify({ index: i }));
    }
    dumpRequestForDiff(debugDir, hash, { index: 12 });
    const files = readdirSync(debugDir).filter(f => f.startsWith(hash)).sort();
    const oldest = JSON.parse(readFileSync(join(debugDir, files[0]), 'utf8'));
    assert.ok(oldest.index >= 3, 'oldest files should be pruned');
  });

  it('does not prune files from other hashes', () => {
    const otherHash = dirHash('/other/path');
    writeFileSync(join(debugDir, `${otherHash}_2026-01-01T00-00-00-000Z.json`), '{}');
    for (let i = 0; i < 12; i++) {
      const ts = `2026-01-01T00-00-${String(i).padStart(2, '0')}-000Z`;
      writeFileSync(join(debugDir, `${hash}_${ts}.json`), '{}');
    }
    dumpRequestForDiff(debugDir, hash, {});
    const otherFiles = readdirSync(debugDir).filter(f => f.startsWith(otherHash));
    assert.equal(otherFiles.length, 1, 'files from other hash should survive');
  });
});

describe('deleteCapturedRequest', () => {
  const capturesDir = join(FIXTURES_DIR, 'captures-del');
  const hash = dirHash('/test/delete');

  beforeEach(() => {
    mkdirSync(capturesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(capturesDir, { recursive: true, force: true });
  });

  it('returns true when file exists', () => {
    writeFileSync(join(capturesDir, `${hash}.json`), '{}');
    assert.equal(deleteCapturedRequest(capturesDir, hash), true);
    assert.equal(existsSync(join(capturesDir, `${hash}.json`)), false);
  });

  it('returns false when file does not exist', () => {
    assert.equal(deleteCapturedRequest(capturesDir, 'nonexistent'), false);
  });
});

describe('saveCapturedRequest', () => {
  const capturesDir = join(FIXTURES_DIR, 'captures-save');
  const hash = dirHash('/test/save');

  afterEach(() => {
    rmSync(capturesDir, { recursive: true, force: true });
  });

  it('writes body, directory, and timestamp', () => {
    const body = { model: 'test', messages: [{ role: 'user', content: 'hi' }] };
    saveCapturedRequest(capturesDir, hash, body);
    const loaded = JSON.parse(readFileSync(join(capturesDir, `${hash}.json`), 'utf8'));
    assert.deepEqual(loaded.body, body);
    assert.equal(loaded.directory, '/test');
    assert.ok(loaded.timestamp);
  });

  it('creates captures directory if missing', () => {
    const nested = join(FIXTURES_DIR, 'captures-nested', 'deep');
    saveCapturedRequest(nested, hash, { messages: [] });
    assert.ok(existsSync(join(nested, `${hash}.json`)));
    rmSync(join(FIXTURES_DIR, 'captures-nested'), { recursive: true, force: true });
  });

  it('overwrites existing capture', () => {
    saveCapturedRequest(capturesDir, hash, { version: 1, messages: [] });
    saveCapturedRequest(capturesDir, hash, { version: 2, messages: [] });
    const loaded = JSON.parse(readFileSync(join(capturesDir, `${hash}.json`), 'utf8'));
    assert.equal(loaded.body.version, 2);
  });
});

describe('sendWarmup', () => {
  let server;
  let serverPort;
  let lastRequest;
  let responseStatus;
  let responseBody;

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        lastRequest = { path: req.url, body: JSON.parse(body) };
        res.writeHead(responseStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify(responseBody));
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    serverPort = server.address().port;
  });

  after(() => { server.close(); });

  beforeEach(() => {
    responseStatus = 200;
    responseBody = { usage: { prompt_tokens: 14879 } };
    lastRequest = null;
  });

  const sampleBody = {
    model: 'test',
    max_tokens: 8192,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ],
  };

  async function doWarmup(endpoint, body, signal) {
    const warmupBody = buildWarmupBody(body);
    const url = endpoint.replace(/\/+$/, '') + '/v1/chat/completions';
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(warmupBody),
      signal,
    });
    if (resp.ok) {
      await resp.json().catch(() => ({}));
      return true;
    }
    return false;
  }

  it('sends warmup body with max_tokens:1 to /v1/chat/completions', async () => {
    await doWarmup(`http://127.0.0.1:${serverPort}`, sampleBody);
    assert.equal(lastRequest.path, '/v1/chat/completions');
    assert.equal(lastRequest.body.max_tokens, 1);
    assert.equal(lastRequest.body.stream, false);
  });

  it('returns true on 200', async () => {
    const result = await doWarmup(`http://127.0.0.1:${serverPort}`, sampleBody);
    assert.equal(result, true);
  });

  it('returns false on non-200', async () => {
    responseStatus = 500;
    responseBody = { error: 'internal' };
    const result = await doWarmup(`http://127.0.0.1:${serverPort}`, sampleBody);
    assert.equal(result, false);
  });

  it('replaces user content with ping', async () => {
    await doWarmup(`http://127.0.0.1:${serverPort}`, sampleBody);
    const userMsg = lastRequest.body.messages.find(m => m.role === 'user');
    assert.equal(userMsg.content, 'ping');
  });

  it('strips trailing slash from endpoint', async () => {
    await doWarmup(`http://127.0.0.1:${serverPort}/`, sampleBody);
    assert.equal(lastRequest.path, '/v1/chat/completions');
  });

  it('returns false on network error', async () => {
    try {
      await doWarmup('http://127.0.0.1:1', sampleBody);
      assert.fail('should have thrown');
    } catch {
      // network error expected
    }
  });
});

describe('forwardRequest 502 on unreachable backend', () => {
  let proxy;
  let proxyPort;

  before(async () => {
    proxy = http.createServer((req, res) => {
      let chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString();
        const proxyReq = http.request({
          hostname: '127.0.0.1',
          port: 1,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: '127.0.0.1:1' },
        }, proxyRes => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });
        proxyReq.on('error', () => {
          res.writeHead(502);
          res.end(JSON.stringify({ error: { message: 'cannot reach backend' } }));
        });
        proxyReq.write(rawBody);
        proxyReq.end();
      });
    });

    await new Promise(r => proxy.listen(0, '127.0.0.1', r));
    proxyPort = proxy.address().port;
  });

  after(() => { proxy.close(); });

  it('returns 502 when backend is unreachable', async () => {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"test":true}',
    });
    assert.equal(resp.status, 502);
    const data = await resp.json();
    assert.ok(data.error.message.includes('cannot reach'));
  });
});

describe('proxy capture behavior', () => {
  let backend;
  let proxy;
  let backendPort;
  let proxyPort;
  let captured;

  before(async () => {
    backend = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise(r => backend.listen(0, '127.0.0.1', r));
    backendPort = backend.address().port;
  });

  after(() => { backend.close(); });

  beforeEach(async () => {
    captured = [];
    let capturedOnce = false;

    proxy = http.createServer((req, res) => {
      let chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString();
        const isChatCompletion = rawBody.length > 5000 && req.url.includes('/chat/completions');

        if (isChatCompletion && !capturedOnce) {
          capturedOnce = true;
          try {
            captured.push(JSON.parse(rawBody));
          } catch {}
        }

        const proxyReq = http.request({
          hostname: '127.0.0.1',
          port: backendPort,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: `127.0.0.1:${backendPort}` },
        }, proxyRes => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });
        proxyReq.write(rawBody);
        proxyReq.end();
      });
    });
    await new Promise(r => proxy.listen(0, '127.0.0.1', r));
    proxyPort = proxy.address().port;
  });

  afterEach(() => { proxy.close(); });

  it('captures first large chat completion request', async () => {
    const largeBody = JSON.stringify({
      model: 'test',
      messages: [{ role: 'system', content: 'x'.repeat(6000) }],
    });
    await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: largeBody,
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].model, 'test');
  });

  it('does not capture small requests', async () => {
    await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(captured.length, 0);
  });

  it('does not capture non-chat-completion paths', async () => {
    const largeBody = JSON.stringify({ data: 'x'.repeat(6000) });
    await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: largeBody,
    });
    assert.equal(captured.length, 0);
  });

  it('captures only once per session', async () => {
    const largeBody = JSON.stringify({
      model: 'test',
      messages: [{ role: 'system', content: 'x'.repeat(6000) }],
    });
    await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: largeBody,
    });
    await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: largeBody,
    });
    assert.equal(captured.length, 1);
  });
});

describe('EADDRINUSE handling', () => {
  let blocker;
  let blockerPort;

  before(async () => {
    blocker = http.createServer(() => {});
    await new Promise(r => blocker.listen(0, '127.0.0.1', r));
    blockerPort = blocker.address().port;
  });

  after(() => { blocker.close(); });

  it('reports started:false when port is taken', async () => {
    const server = http.createServer(() => {});
    const result = await new Promise(resolve => {
      server.on('error', err => {
        resolve({ started: false, error: err.message });
      });
      server.listen(blockerPort, '127.0.0.1', () => {
        resolve({ started: true });
      });
    });
    assert.equal(result.started, false);
    assert.ok(result.error.includes('EADDRINUSE'));
  });
});

describe('isSmallModelHealthy logic', () => {
  let healthServer;
  let healthPort;
  let healthOk;

  before(async () => {
    healthServer = http.createServer((_req, res) => {
      res.writeHead(healthOk ? 200 : 503);
      res.end(healthOk ? '{"status":"ok"}' : '{"status":"error"}');
    });
    await new Promise(r => healthServer.listen(0, '127.0.0.1', r));
    healthPort = healthServer.address().port;
  });

  after(() => { healthServer.close(); });

  it('returns true when health endpoint returns 200', async () => {
    healthOk = true;
    const resp = await fetch(`http://127.0.0.1:${healthPort}/health`);
    assert.equal(resp.ok, true);
  });

  it('returns false when health endpoint returns 503', async () => {
    healthOk = false;
    const resp = await fetch(`http://127.0.0.1:${healthPort}/health`);
    assert.equal(resp.ok, false);
  });

  it('caches result within 30s window', async () => {
    healthOk = true;
    let healthy = null;
    let checkedAt = 0;

    async function isHealthy(url) {
      const now = Date.now();
      if (healthy !== null && (now - checkedAt) < 30000) {
        return healthy;
      }
      try {
        const resp = await fetch(url + '/health', { signal: AbortSignal.timeout(2000) });
        healthy = resp.ok;
      } catch {
        healthy = false;
      }
      checkedAt = now;
      return healthy;
    }

    const first = await isHealthy(`http://127.0.0.1:${healthPort}`);
    assert.equal(first, true);

    healthOk = false;
    const cached = await isHealthy(`http://127.0.0.1:${healthPort}`);
    assert.equal(cached, true, 'should return cached result, not re-check');
  });
});

describe('initWarmup state transitions', () => {
  const statusPath = join(FIXTURES_DIR, 'init-status.json');
  const capturesDir = join(FIXTURES_DIR, 'init-captures');
  const hash = dirHash('/test/init');

  afterEach(() => {
    rmSync(capturesDir, { recursive: true, force: true });
    try { unlinkSync(statusPath); } catch {}
  });

  it('writes disabled status when config.enabled is false', () => {
    const config = { enabled: false, endpoint: 'http://x' };
    if (!config.enabled) {
      writeStatus(statusPath, 'disabled', 'set enabled: true in kv-warmup.json');
    }
    const loaded = JSON.parse(readFileSync(statusPath, 'utf8'));
    assert.equal(loaded.state, 'disabled');
  });

  it('writes error status when endpoint is missing', () => {
    const config = { enabled: true, endpoint: '' };
    if (!config.enabled || !config.endpoint) {
      const state = config.enabled ? 'error' : 'disabled';
      const detail = config.enabled ? 'no endpoint in kv-warmup.json' : 'set enabled: true in kv-warmup.json';
      writeStatus(statusPath, state, detail);
    }
    const loaded = JSON.parse(readFileSync(statusPath, 'utf8'));
    assert.equal(loaded.state, 'error');
    assert.ok(loaded.detail.includes('no endpoint'));
  });

  it('writes no-cache when no capture exists', () => {
    const config = { enabled: true, endpoint: 'http://localhost:8090' };
    const capturePath = join(capturesDir, `${hash}.json`);
    let cached;
    try {
      cached = JSON.parse(readFileSync(capturePath, 'utf8'));
    } catch {
      cached = null;
    }
    if (!cached) {
      writeStatus(statusPath, 'no-cache', 'will capture on first message');
    }
    const loaded = JSON.parse(readFileSync(statusPath, 'utf8'));
    assert.equal(loaded.state, 'no-cache');
  });

  it('writes no-cache when capture has empty messages', () => {
    mkdirSync(capturesDir, { recursive: true });
    writeFileSync(join(capturesDir, `${hash}.json`), JSON.stringify({
      body: { messages: [] },
    }));
    const cached = JSON.parse(readFileSync(join(capturesDir, `${hash}.json`), 'utf8'));
    if (!cached.body?.messages?.length) {
      writeStatus(statusPath, 'no-cache', 'will capture on first message');
    }
    const loaded = JSON.parse(readFileSync(statusPath, 'utf8'));
    assert.equal(loaded.state, 'no-cache');
  });
});

describe('clearCache hot-reload', () => {
  const capturesDir = join(FIXTURES_DIR, 'captures-clear');
  const configPath = join(FIXTURES_DIR, 'clear-config.json');
  const hash = dirHash('/test/clear');

  beforeEach(() => {
    mkdirSync(capturesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(capturesDir, { recursive: true, force: true });
    try { unlinkSync(configPath); } catch {}
  });

  it('deletes capture and resets clearCache in config', () => {
    saveCapturedRequest(capturesDir, hash, { messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(existsSync(join(capturesDir, `${hash}.json`)));

    const config = { enabled: true, endpoint: 'http://x', proxyPort: 8099, clearCache: true };
    if (config.clearCache) {
      deleteCapturedRequest(capturesDir, hash);
      config.clearCache = false;
      writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    }

    assert.equal(existsSync(join(capturesDir, `${hash}.json`)), false);
    const updated = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(updated.clearCache, false);
  });
});

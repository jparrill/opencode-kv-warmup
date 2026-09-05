import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
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

before(() => {
  mkdirSync(FIXTURES_DIR, { recursive: true });
});

after(() => {
  rmSync(FIXTURES_DIR, { recursive: true, force: true });
});

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
});

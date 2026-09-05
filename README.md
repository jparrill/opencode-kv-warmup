# kv-warmup

OpenCode plugin that pre-warms llama-server's KV cache at boot, reducing first-turn TTFT from ~65s to ~2.6s.

## Problem

When using OpenCode with a local llama-server, every new conversation pays a full prompt-processing cost on the first turn. The system prompt, tool definitions, CLAUDE.md, skills, and AGENTS.md add up to ~15K tokens. At ~340 tok/s prompt processing speed (Qwen3.8-27B dense on AMD Ryzen AI Max+ 395), that's **~45-65 seconds** before the model produces its first token.

Subsequent turns within the same conversation are fast (~0.5s) because llama-server's prefix cache reuses the KV state from the previous turn. But every time you open a new conversation, the full prompt is reprocessed from scratch.

## Solution

The plugin embeds a reverse proxy inside the plugin process. OpenCode sends all requests through this proxy, which:

1. **Forwards** every request to the real llama-server endpoint transparently
2. **Captures** the latest large request body (system prompt + tools + messages) automatically
3. On next OpenCode boot, **replays** the captured request directly to llama-server with `max_tokens: 1`, filling the KV cache before the user types

Additionally, for single-slot mode (`-np 1`), the plugin redirects OpenCode's internal "small model" tasks (title generation, etc.) to a secondary MoE endpoint via the `experimental.provider.small_model` hook. This prevents title gen from evicting the warmed KV cache.

**Result: TTFT drops from ~65s to ~2.6s (96% reduction) with `-np 1`.**

## Why it works this way

Three constraints forced this architecture:

### 1. Exact token match is required

llama-server's prefix cache compares the incoming request's token sequence against what's already in a KV slot. Even a single token difference at position N invalidates everything from N onwards. Early attempts using plugin hooks to reconstruct the request failed because:

- The `tool.definition` hook provides full JSON schemas (~60K chars), but OpenCode sends compact versions (~24K chars)
- The `experimental.chat.system.transform` hook joins system messages into one string, but OpenCode sends them as separate messages
- Injecting status text into the system prompt changes the token sequence vs. the captured request

The only reliable approach is capturing the **exact request body** that OpenCode sends to the API and replaying it verbatim.

### 2. Title gen evicts KV cache on single slot

With `-np 1`, OpenCode's internal title-generation request evicts the warmed KV cache before the user's real request arrives:

```
warmup fills slot 0 (KV primed)
title gen evicts slot 0 (KV lost!)
user request reprocesses from scratch (warmup wasted)
```

The plugin solves this by redirecting title gen to a separate MoE endpoint (`smallModelEndpoint`), so the dense server's KV cache is never touched by non-conversation requests.

### 3. System prompt varies by directory

System prompt content changes with working directory, CLAUDE.md, loaded skills, and MCP config. A static capture becomes stale when you switch directories. The embedded proxy solves this by auto-capturing every request — the warmup data is always from the latest real conversation, regardless of directory changes.

### 4. The plugin must not modify the system prompt

Any modification to `output.system` in the `experimental.chat.system.transform` hook changes what OpenCode sends to the API, breaking the prefix match with the captured request. Warmup status is shown in the TUI sidebar panel instead.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│ OpenCode                                                 │
│  provider baseURL → http://127.0.0.1:8099/v1             │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ plugin.js (runs inside OpenCode process)             │ │
│  │                                                      │ │
│  │  On boot:                                            │ │
│  │    1. Start HTTP proxy on 127.0.0.1:8099             │ │
│  │    2. Load last captured request from disk            │ │
│  │    3. Replay to real endpoint (max_tokens:1)         │ │
│  │                                                      │ │
│  │  Proxy (always running):                             │ │
│  │    All requests → capture large ones → forward       │ │
│  │                                                      │ │
│  │  Small model hook:                                   │ │
│  │    Title gen → MoE endpoint (8091)                   │ │
│  │    (prevents KV eviction on dense server)            │ │
│  └─────────────┬────────────────────────────────────────┘ │
└────────────────┼──────────────────────────────────────────┘
                 │
    ┌────────────┼─────────────────┐
    │ warmup     │ proxy forward   │
    │ (direct)   │                 │
    ▼            ▼                 │
┌─────────────────────┐    ┌──────┴──────────┐
│ Dense server :8090  │    │ MoE server :8091│
│ (KV cache primed)   │    │ (title gen)     │
└─────────────────────┘    └─────────────────┘
```

```
┌─────────────────────────────────────────────────────┐
│ TUI sidebar (tui.tsx)                               │
│                                                     │
│  Reads .kv-warmup-status.json every 1.5s            │
│  Shows: ● Ready | ◐ Warming | ◌ Cancelled | ✗ Error│
└─────────────────────────────────────────────────────┘
```

## Files

| File | Purpose |
|------|---------|
| `plugin.js` | Embedded proxy + warmup on boot + small model redirect |
| `tui.tsx` | TUI sidebar panel: shows warmup state with colored indicators |
| `proxy.js` | Legacy standalone capture proxy (superseded by embedded proxy) |
| `package.json` | Package metadata |

### Runtime files (in `~/.config/opencode/`)

| File | Purpose |
|------|---------|
| `kv-warmup.json` | Plugin config |
| `.kv-warmup-request.json` | Auto-captured request body (from embedded proxy) |
| `.kv-warmup-status.json` | Current warmup state (read by TUI) |

## Setup

### 1. Register the plugin

In `~/.config/opencode/opencode.json`:

```json
{
  "provider": {
    "auriga-dense": {
      "options": {
        "baseURL": "http://127.0.0.1:8099/v1"
      }
    }
  },
  "plugin": [
    "/path/to/kv-warmup/plugin.js"
  ]
}
```

Note: `baseURL` points to the proxy, not the real server.

In `~/.config/opencode/tui.json`:

```json
{
  "plugin": [
    "/path/to/kv-warmup/tui.tsx"
  ]
}
```

### 2. Create plugin config

```bash
cat > ~/.config/opencode/kv-warmup.json << 'EOF'
{
  "enabled": true,
  "endpoint": "http://your-llama-server:8090",
  "proxyPort": 8099,
  "smallModelEndpoint": "http://your-llama-server:8091/v1"
}
EOF
```

- `endpoint`: real llama-server URL (proxy forwards here)
- `proxyPort`: local proxy port (must match baseURL in opencode.json)
- `smallModelEndpoint`: secondary server for title gen (prevents KV eviction)

### 3. First run (bootstrap)

On first boot, no captured request exists. The plugin logs `no captured request — will capture on first message`. Send any message — the proxy captures it. On the **second** boot, warmup uses that capture.

### 4. Verify

Start OpenCode. The sidebar should show `◐ Warming...` then `● Ready` after ~46s. Send a message — TTFT should be ~2-5s instead of ~65s.

Check llama-server logs for `LCP similarity` — values above 0.95 confirm prefix cache hit.

## Measured results

| Metric | Before | After |
|--------|--------|-------|
| Turn 1 TTFT | ~65s | 2.6s |
| LCP similarity | 0% (no warmup) | 99.9% |
| Tokens reprocessed | 15,657 (all) | 15 (user message only) |
| Warmup time (background) | — | 46s |

Hardware: AMD Ryzen AI Max+ 395, 128GB unified RAM, Qwen3.8-27B-UD-Q4_K_XL.gguf

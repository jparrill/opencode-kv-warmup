# kv-warmup

OpenCode plugin that pre-warms llama-server's KV cache at boot, reducing first-turn TTFT from ~44s to ~1s.

## Problem

When using OpenCode with a local llama-server, every new conversation pays a full prompt-processing cost on the first turn. The system prompt, tool definitions, CLAUDE.md, skills, and AGENTS.md add up to ~15K tokens. At ~340 tok/s prompt processing speed (Qwen3.8-27B dense on AMD Ryzen AI Max+ 395), that's **~44 seconds** before the model produces its first token.

Subsequent turns within the same conversation are fast (~0.5s) because llama-server's prefix cache reuses the KV state from the previous turn. But every time you open a new conversation, the full prompt is reprocessed from scratch.

## Solution

The plugin embeds a reverse proxy inside the plugin process. OpenCode sends all requests through this proxy, which:

1. **Forwards** every request to the real llama-server endpoint transparently
2. **Captures** the first large request body per session, stored per working directory
3. On next OpenCode boot, **replays** the captured request directly to llama-server with `max_tokens: 1`, filling the KV cache before the user types

Additionally, for single-slot mode (`-np 1`), the plugin redirects OpenCode's internal "small model" tasks (title generation, etc.) to a secondary MoE endpoint via the `experimental.provider.small_model` hook. This prevents title gen from evicting the warmed KV cache.

**Result: TTFT drops from ~44s to ~1s with `-np 1`.**

## Why a proxy is required

The proxy is not optional. No combination of OpenCode plugin hooks can produce a request body that matches what OpenCode actually sends to the API.

### The problem: exact token match

llama-server's prefix cache compares the incoming request's token sequence against what's already in a KV slot. Even a single token difference at position N invalidates everything from N onwards. That means the warmup request must be **byte-identical** to what OpenCode will send.

### What was tried (and failed)

1. **Reconstructing from hooks**: the `tool.definition` hook provides full JSON schemas (~60K chars), but OpenCode sends compact versions (~24K chars). Different tokens, no cache hit.

2. **System prompt hooks**: the `experimental.chat.system.transform` hook joins system messages into one string, but OpenCode sends them as separate messages. Different structure, different tokens.

3. **Injecting status into the system prompt**: any text added via the system transform hook changes the token sequence vs. the real request. Status must be shown in the TUI sidebar instead.

4. **Hardcoded/static warmup bodies**: the system prompt changes by directory (different CLAUDE.md, skills, env block). A static body only works for one directory and breaks on any OpenCode update.

### What works: capturing the real request

The embedded proxy intercepts the actual HTTP request that OpenCode sends. This is the **only** way to get the exact bytes that will be tokenized. The capture is stored per directory and replayed on next boot. Since the plugin adds no middleware that modifies the request, the replayed capture matches the real request exactly (LCP 0.999).

The proxy is ~50 lines of `http.createServer` with no dependencies. It runs in-process, adds no measurable latency to forwarded requests, and requires only changing `baseURL` from `http://server:8090/v1` to `http://localhost:8099/v1`.

## Prerequisites: deterministic system prompt

For KV cache reuse across sessions, the system prompt token sequence must be identical between consecutive OpenCode launches in the same directory on the same day.

**Critical**: if skills are symlinked into multiple discovery directories (e.g., both `~/.agents/skills/` and `~/.claude/skills/`), OpenCode loads them with unbounded concurrency. Which copy "wins" for a given skill name is random per session, causing the `<location>` tag in the system prompt to flip between paths. This breaks prefix matching (~32% token drift, LCP drops from 0.999 to 0.68).

**Fix**: link each skill to exactly **one** directory (e.g., `~/.agents/skills/` only). Both Claude Code and OpenCode discover skills from `~/.agents/skills/`.

## Other design constraints

### Title gen evicts KV cache on single slot

With `-np 1`, OpenCode's internal title-generation request evicts the warmed KV cache before the user's real request arrives:

```
warmup fills slot 0 (KV primed)
title gen evicts slot 0 (KV lost!)
user request reprocesses from scratch (warmup wasted)
```

The plugin redirects title gen to a separate MoE endpoint (`smallModelEndpoint`), so the dense server's KV cache is never touched by non-conversation requests.

### The plugin must not modify the system prompt

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
│  │    2. Load captured request for cwd from disk        │ │
│  │    3. Replay to real endpoint (max_tokens:1)         │ │
│  │                                                      │ │
│  │  Proxy (always running):                             │ │
│  │    All requests → capture first large one → forward  │ │
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
| `package.json` | Package metadata |

### Runtime files (in `~/.config/opencode/`)

| File | Purpose |
|------|---------|
| `kv-warmup.json` | Plugin config (hot-reloaded on every request) |
| `.kv-warmup-captures/<hash>.json` | Per-directory captured request bodies |
| `.kv-warmup-debug/<hash>_<ts>.json` | Debug dumps for cross-session diff analysis |
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

### 3. Ensure deterministic skills

Link each skill to **one** discovery directory only:

```bash
# Good: one destination
DESTS=("$HOME/.agents/skills")

# Bad: duplicates cause non-deterministic <location> tags
DESTS=("$HOME/.agents/skills" "$HOME/.claude/skills")
```

### 4. First run (bootstrap)

On first boot in a directory, no captured request exists. The sidebar shows `No cache`. Send any message — the proxy captures it. On the **second** boot in that directory, warmup uses that capture.

### 5. Verify

Start OpenCode. The sidebar should show `Warming...` then `Ready` after ~44s. Send a message — TTFT should be ~1s instead of ~44s.

Check llama-server logs for `LCP similarity` — values above 0.95 confirm prefix cache hit.

### Hot-reload controls

Edit `kv-warmup.json` while OpenCode is running (changes apply on next request):

- `"enabled": false` — proxy becomes transparent passthrough, no capture or warmup on restart
- `"clearCache": true` — deletes capture for current directory, auto-resets to false

## Measured results

| Metric | Before | After |
|--------|--------|-------|
| Turn 1 TTFT | ~44s | ~1s |
| LCP similarity | 0.68 (non-deterministic skills) | 0.999 |
| Tokens reprocessed | 14,879 (all) | 13 (user message only) |
| Warmup time (background) | — | ~44s |

Hardware: AMD Ryzen AI Max+ 395, 128GB unified RAM, Qwen3.8-27B-UD-Q4_K_XL.gguf

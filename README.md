# kv-warmup

OpenCode plugin that pre-warms llama-server's KV cache at boot, reducing first-turn TTFT from ~65s to ~2.6s.

## Problem

When using OpenCode with a local llama-server, every new conversation pays a full prompt-processing cost on the first turn. The system prompt, tool definitions, CLAUDE.md, skills, and AGENTS.md add up to ~15K tokens. At ~340 tok/s prompt processing speed (Qwen3.8-27B dense on AMD Ryzen AI Max+ 395), that's **~45-65 seconds** before the model produces its first token.

Subsequent turns within the same conversation are fast (~0.5s) because llama-server's prefix cache reuses the KV state from the previous turn. But every time you open a new conversation, the full prompt is reprocessed from scratch.

## Solution

The plugin replays a previously captured request to llama-server at OpenCode boot time, with `max_tokens: 1`. This populates the KV cache with the exact token sequence that OpenCode will send on the first real request. When the actual request arrives, llama-server's LCP (Longest Common Prefix) matching detects 99.9% overlap and skips prompt processing entirely.

**Result: TTFT drops from ~65s to ~2.6s (96% reduction).**

## Why it works this way

Three constraints forced this architecture:

### 1. Exact token match is required

llama-server's prefix cache compares the incoming request's token sequence against what's already in a KV slot. Even a single token difference at position N invalidates everything from N onwards. Early attempts using plugin hooks to reconstruct the request failed because:

- The `tool.definition` hook provides full JSON schemas (~60K chars), but OpenCode sends compact versions (~24K chars) — different tokens
- The `experimental.chat.system.transform` hook joins system messages into one string, but OpenCode sends them as separate messages — different chat template rendering
- Injecting status text into the system prompt (e.g., `[kv-warmup] KV cache pre-warmed`) changes the token sequence vs. the captured request

The only reliable approach is capturing the **exact request body** that OpenCode sends to the API and replaying it verbatim.

### 2. Two parallel slots are required (`-np 2`)

With a single slot (`-np 1`), OpenCode's internal title-generation request evicts the warmed KV cache before the user's real request arrives:

```
warmup → slot 0 (KV primed)
title gen → slot 0 (KV evicted!)
user request → slot 0 (full reprocessing, warmup wasted)
```

With two slots (`-np 2`), llama-server's LCP-based slot selection routes each request to the best-matching slot:

```
warmup → slot 1 (KV primed, 15K tokens)
title gen → slot 0 (empty, no match with warmup)
user request → slot 1 (LCP 99.9%, 15 tokens to process)
```

### 3. The plugin must not modify the system prompt

Any modification to `output.system` in the `experimental.chat.system.transform` hook changes what OpenCode sends to the API, breaking the prefix match with the captured request. Warmup status is shown in the TUI sidebar panel instead.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│ OpenCode boot                                       │
│                                                     │
│  plugin.js loads → reads .kv-warmup-request.json    │
│  → sends captured request to llama-server            │
│     (max_tokens: 1, replaces user msg with "ping")  │
│  → llama-server processes ~15K tokens (~46s)        │
│  → KV cache primed in slot 1                        │
│                                                     │
│  User types first message                           │
│  → title gen → slot 0 (no KV match)                 │
│  → real request → slot 1 (LCP 99.9%)               │
│  → only ~15 new tokens processed                    │
│  → TTFT: 2.6s                                       │
└─────────────────────────────────────────────────────┘

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
| `plugin.js` | Server-side plugin: warmup on boot, fallback capture via hooks |
| `tui.tsx` | TUI sidebar panel: shows warmup state with colored indicators |
| `proxy.js` | One-time capture tool: intercepts OpenCode's real request body |
| `package.json` | Package metadata |

### Runtime files (in `~/.config/opencode/`)

| File | Purpose |
|------|---------|
| `kv-warmup.json` | Plugin config: `enabled`, `endpoints` |
| `.kv-warmup-request.json` | Captured request body (from proxy) |
| `.kv-warmup-status.json` | Current warmup state (read by TUI) |

## Setup

### 1. Configure llama-server with `-np 2`

Add `-np 2` to your llama-server launch flags. With `auriga-cli`:

```yaml
# ~/.config/auriga/config.yaml
qwen3.8-27b-q4:
    flags:
        - -np
        - '2'
```

Then restart: `auriga profile switch qwen3.8-27b-q4 --persistent`

### 2. Register the plugin

In `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "/path/to/kv-warmup/plugin.js"
  ]
}
```

In `~/.config/opencode/tui.json`:

```json
{
  "plugin": [
    "/path/to/kv-warmup/tui.tsx"
  ]
}
```

### 3. Create plugin config

```bash
cat > ~/.config/opencode/kv-warmup.json << 'EOF'
{
  "enabled": true,
  "endpoints": ["http://your-llama-server:8090"]
}
EOF
```

### 4. Capture a real request (one-time)

Edit the `TARGET_HOST` and `TARGET_PORT` constants in `proxy.js` to match your llama-server endpoint. Then:

```bash
# 1. Point OpenCode to the proxy temporarily
# In opencode.json, change baseURL to http://localhost:8099/v1

# 2. Disable warmup during capture
echo '{"enabled": false, "endpoints": []}' > ~/.config/opencode/kv-warmup.json

# 3. Run the proxy
node proxy.js

# 4. Start OpenCode and send any message
# The proxy captures the first large request

# 5. Restore opencode.json to the real endpoint
# 6. Re-enable warmup in kv-warmup.json
```

### 5. Verify

Start OpenCode. The sidebar should show `◐ Warming...` then `● Ready` after ~46s. Send a message — TTFT should be ~2-5s instead of ~65s.

## When to re-capture

Run the proxy capture again if:

- OpenCode updates change tool definitions
- You modify CLAUDE.md, AGENTS.md, or skill files significantly
- You switch to a different llama-server model (different chat template)

The symptom of a stale capture is TTFT reverting to ~50-65s. Check llama-server logs for `LCP similarity` — values below 0.95 indicate a prompt mismatch.

## Measured results

| Metric | Before | After |
|--------|--------|-------|
| Turn 1 TTFT | ~65s | 2.6s |
| LCP similarity | 0% (no warmup) | 99.9% |
| Tokens reprocessed | 15,657 (all) | 15 (user message only) |
| Warmup time (background) | — | 46s |

Hardware: AMD Ryzen AI Max+ 395, 128GB unified RAM, Qwen3.8-27B-UD-Q4_K_XL.gguf

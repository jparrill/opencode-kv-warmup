/** @jsxImportSource @opentui/solid */

// kv-warmup TUI sidebar panel
//
// Shows KV cache warmup status in OpenCode's right sidebar.
// Reads status from a JSON file written by the server-side plugin.js.
// Uses dynamic import for node:fs to gracefully handle restricted runtimes.

import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup } from "solid-js"

const id = "kv-warmup"
const SIDEBAR_ORDER = 160
const REFRESH_MS = 1500

interface WarmupStatus {
  state: string
  detail: string
  updated: string
}

const FALLBACK: WarmupStatus = { state: "idle", detail: "", updated: "" }

function getStatusPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ""
  const base = process.env.XDG_CONFIG_HOME || `${home}/.config`
  return `${base}/opencode/.kv-warmup-status.json`
}

let fsModule: any = null

async function initFs() {
  try {
    fsModule = await import("node:fs")
  } catch {
    fsModule = null
  }
}

function readStatus(): WarmupStatus {
  if (!fsModule) return FALLBACK
  try {
    const raw = fsModule.readFileSync(getStatusPath(), "utf8")
    return JSON.parse(raw)
  } catch {
    return FALLBACK
  }
}

function stateLabel(state: string): string {
  switch (state) {
    case "warming": return "Warming..."
    case "ready": return "Ready"
    case "cancelled": return "Cancelled"
    case "error": return "Error"
    case "no-cache": return "No cache"
    case "disabled": return "Disabled"
    default: return "Idle"
  }
}

function stateIcon(state: string): string {
  switch (state) {
    case "warming": return "◐"
    case "ready": return "●"
    case "cancelled": return "◌"
    case "error": return "✗"
    case "no-cache": return "○"
    case "disabled": return "−"
    default: return "·"
  }
}

function SidebarWarmupView(props: { api: any }) {
  const [status, setStatus] = createSignal<WarmupStatus>(readStatus())

  const interval = setInterval(() => setStatus(readStatus()), REFRESH_MS)
  onCleanup(() => clearInterval(interval))

  const color = () => {
    switch (status().state) {
      case "ready": return "#4ade80"
      case "warming": return "#facc15"
      case "error": return "#f87171"
      case "cancelled": return "#94a3b8"
      default: return props.api.theme.current.textMuted
    }
  }

  return (
    <box gap={0}>
      <text fg={props.api.theme.current.text}>
        <b>KV Warmup</b>
      </text>
      <text fg={color()} wrapMode="none">
        {stateIcon(status().state)} {stateLabel(status().state)}
      </text>
      {status().detail && (
        <text fg={props.api.theme.current.textMuted} wrapMode="none">
          {status().detail.slice(0, 40)}
        </text>
      )}
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  await initFs()

  api.slots.register({
    order: SIDEBAR_ORDER,
    slots: {
      sidebar_content(_ctx: any, _props: { session_id: string }) {
        return <SidebarWarmupView api={api} />
      },
    },
  })
}

const pluginModule: TuiPluginModule & { id: string } = { id, tui }
export default pluginModule

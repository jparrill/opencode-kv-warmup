/** @jsxImportSource @opentui/solid */

// kv-warmup TUI plugin
//
// Shows KV cache warmup status in:
//   1. Home screen footer (visible before first message)
//   2. Session sidebar (visible during conversation)
//
// Reads status from a JSON file written by the server-side plugin.js.

import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup } from "solid-js"

const id = "kv-warmup"
const SIDEBAR_ORDER = 160
const HOME_ORDER = 90
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
    case "cache-cleared": return "Cleared"
    case "diagnostic": return "Diagnostic"
    default: return "Idle"
  }
}

function stateColor(state: string, theme: any): string {
  switch (state) {
    case "ready": return "#4ade80"
    case "warming": return "#facc15"
    case "error": return "#f87171"
    case "cancelled":
    case "disabled": return "#94a3b8"
    default: return theme.textMuted
  }
}

function useStatus() {
  const [status, setStatus] = createSignal<WarmupStatus>(readStatus())
  const interval = setInterval(() => setStatus(readStatus()), REFRESH_MS)
  onCleanup(() => clearInterval(interval))
  return status
}

function SidebarView(props: { api: any }) {
  const status = useStatus()

  return (
    <box gap={0}>
      <text fg={props.api.theme.current.text}>
        <b>KV Warmup</b>
      </text>
      <text fg={stateColor(status().state, props.api.theme.current)} wrapMode="none">
        {stateLabel(status().state)}
      </text>
      {status().detail && (
        <text fg={props.api.theme.current.textMuted} wrapMode="none">
          {status().detail.slice(0, 40)}
        </text>
      )}
    </box>
  )
}

function HomeFooterView(props: { api: any }) {
  const status = useStatus()
  const theme = () => props.api.theme.current

  return (
    <box gap={1} flexDirection="row" flexShrink={0}>
      <text fg={stateColor(status().state, theme())}>KV</text>
      <text fg={theme().textMuted}>{stateLabel(status().state)}</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  await initFs()

  api.slots.register({
    order: SIDEBAR_ORDER,
    slots: {
      sidebar_content(_ctx: any, _props: { session_id: string }) {
        return <SidebarView api={api} />
      },
    },
  })

  api.slots.register({
    order: HOME_ORDER,
    slots: {
      home_footer() {
        return <HomeFooterView api={api} />
      },
    },
  })
}

const pluginModule: TuiPluginModule & { id: string } = { id, tui }
export default pluginModule

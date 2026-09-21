/**
 * `window.api` for the browser build. In Electron the preload provides it over ipcRenderer; when the renderer is
 * served by the gateway (src/gateway) this module speaks the gateway's WebSocket RPC instead, so every component keeps
 * calling `window.api.invoke(...)` unchanged.
 *
 * The bearer token arrives once as `#token=…` in the URL, is kept in localStorage, and is removed from the address
 * bar so it does not end up in screenshots or history.
 */
import type { IpcApi, IpcEvents } from '@shared/ipc'

type Api = Window['api']

const TOKEN_KEY = 'gateway.token'

function readToken(): string {
  const m = /[#&]token=([^&]+)/.exec(location.hash)
  if (m) {
    const t = decodeURIComponent(m[1])
    try { localStorage.setItem(TOKEN_KEY, t) } catch { /* private mode */ }
    history.replaceState(null, '', location.pathname + location.search)
    return t
  }
  try { return localStorage.getItem(TOKEN_KEY) ?? '' } catch { return '' }
}

/** Calls handled in the browser itself because the gateway machine has no clipboard / browser / file dialogs. */
async function local(channel: string, args: unknown[]): Promise<{ handled: boolean; value?: unknown }> {
  switch (channel) {
    case 'clipboard:write': {
      const text = String(args[0] ?? '')
      try { await navigator.clipboard.writeText(text) } catch {
        // Plain-http origins have no async clipboard; fall back to the legacy copy command.
        const ta = document.createElement('textarea')
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove()
      }
      return { handled: true }
    }
    case 'shell:open': window.open(String(args[0]), '_blank', 'noopener'); return { handled: true }
    case 'theme:set': return { handled: true }
    case 'dialog:pickFile': return { handled: true, value: null }
    default: return { handled: false }
  }
}

export function createWsApi(): Api {
  let token = readToken()
  if (!token) {
    token = window.prompt('Gateway access token') ?? ''
    try { localStorage.setItem(TOKEN_KEY, token) } catch { /* private mode */ }
  }
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(token)}`

  let ws: WebSocket | null = null
  let nextId = 1
  let attempt = 0
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const waiting: string[] = []
  const listeners = new Map<string, Set<(payload: unknown) => void>>()

  const connect = (): void => {
    ws = new WebSocket(url)
    ws.onopen = () => {
      attempt = 0
      for (const m of waiting) ws!.send(m)
      waiting.length = 0
    }
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { t: string; id?: number; result?: unknown; message?: string; channel?: string; payload?: unknown }
      if (msg.t === 'result' || msg.t === 'error') {
        const p = pending.get(msg.id!)
        if (!p) return
        pending.delete(msg.id!)
        if (msg.t === 'result') p.resolve(msg.result)
        else p.reject(new Error(msg.message ?? 'Request failed'))
      } else if (msg.t === 'event' && msg.channel) {
        for (const cb of listeners.get(msg.channel) ?? []) cb(msg.payload)
      }
    }
    ws.onclose = (ev) => {
      ws = null
      const unauthorized = ev.code === 1006 && attempt === 0 && !ev.wasClean
      for (const p of pending.values()) p.reject(new Error('Gateway connection lost'))
      pending.clear()
      if (unauthorized && attempt === 0) {
        // A refused upgrade shows as an immediate abnormal close; give the user a way to fix a bad token.
        try { localStorage.removeItem(TOKEN_KEY) } catch { /* ignore */ }
      }
      attempt += 1
      setTimeout(connect, Math.min(15_000, 500 * 2 ** Math.min(attempt, 5)))
    }
  }
  connect()

  return {
    invoke<K extends keyof IpcApi>(channel: K, ...args: Parameters<IpcApi[K]>): ReturnType<IpcApi[K]> {
      return (async () => {
        const l = await local(channel, args)
        if (l.handled) return l.value
        const id = nextId++
        const data = JSON.stringify({ t: 'call', id, channel, args })
        const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(data)
        else waiting.push(data)
        return result
      })() as ReturnType<IpcApi[K]>
    },
    on<K extends keyof IpcEvents>(channel: K, cb: (payload: IpcEvents[K]) => void): () => void {
      const set = listeners.get(channel) ?? new Set()
      listeners.set(channel, set)
      set.add(cb as (p: unknown) => void)
      return () => set.delete(cb as (p: unknown) => void)
    },
    pathForFile(): string {
      throw new Error('Dropping local files is only available in the desktop app')
    }
  }
}

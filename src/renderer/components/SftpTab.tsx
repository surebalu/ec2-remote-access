import { useEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactElement } from 'react'
import type { SftpEntry, SftpSessionInfo, SftpTransfer } from '@shared/types'
import { useStore, type Tab } from '../store'
import { Icon } from './icons'
import HostActions from './HostActions'

/* Both sides are POSIX paths (macOS locally, Linux remotely). */
const parentOf = (p: string): string => p.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/'
const joinPath = (dir: string, name: string): string => (dir === '/' ? '' : dir.replace(/\/+$/, '')) + '/' + name

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}
const fmtDate = (ms: number): string => (ms ? new Date(ms).toLocaleString([], { year: '2-digit', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')

type Side = 'local' | 'remote'
const DRAG_MIME = 'application/x-ec2ra-files'
interface DragPayload {
  side: Side
  entries: SftpEntry[]
}

/** What a pane needs to browse and edit one filesystem; local and remote are IPC-backed implementations. */
interface Adapter {
  list: (path: string) => Promise<SftpEntry[]>
  realpath: (path: string) => Promise<string>
  mkdir: (path: string) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  remove: (entries: SftpEntry[]) => Promise<void>
  reveal?: (path: string) => Promise<void>
  removeVerb: string
}

const localAdapter: Adapter = {
  list: (p) => window.api.invoke('local:list', p),
  realpath: (p) => window.api.invoke('local:realpath', p),
  mkdir: (p) => window.api.invoke('local:mkdir', p),
  rename: (a, b) => window.api.invoke('local:rename', a, b),
  remove: (es) => window.api.invoke('local:trash', es.map((e) => e.path)),
  reveal: (p) => window.api.invoke('local:reveal', p),
  removeVerb: 'Move to Trash'
}
const remoteAdapter = (sessionId: string): Adapter => ({
  list: (p) => window.api.invoke('sftp:list', sessionId, p),
  realpath: (p) => window.api.invoke('sftp:realpath', sessionId, p),
  mkdir: (p) => window.api.invoke('sftp:mkdir', sessionId, p),
  rename: (a, b) => window.api.invoke('sftp:rename', sessionId, a, b),
  remove: (es) => window.api.invoke('sftp:delete', sessionId, es),
  removeVerb: 'Delete'
})

interface PaneProps {
  side: Side
  title: string
  adapter: Adapter
  enabled: boolean
  /** Directory to show once available (home). */
  startPath: string
  /** Bump to reload the current directory. */
  refreshSignal: number
  onCwd: (cwd: string) => void
  onSelection: (entries: SftpEntry[]) => void
  /** Items dragged from the other side (or from Finder) landed on `targetDir`. */
  onReceive: (payload: DragPayload | { finderPaths: string[] }, targetDir: string) => void
  /** Double-click on a file. */
  onOpenFile: (e: SftpEntry) => void
  /** Placeholder shown while disabled. */
  placeholder?: string
}

function FilePane(p: PaneProps): ReactElement {
  const toast = useStore((s) => s.toast)
  const [cwd, setCwd] = useState('')
  const [pathInput, setPathInput] = useState('')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showHidden, setShowHidden] = useState(false)
  const [newFolder, setNewFolder] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const cwdRef = useRef('')

  const load = async (path: string): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const list = await p.adapter.list(path)
      setEntries(list)
      setCwd(path)
      cwdRef.current = path
      setPathInput(path)
      setSelected(new Set())
      setRenaming(null)
      p.onCwd(path)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }
  const go = async (path: string): Promise<void> => {
    try {
      await load(await p.adapter.realpath(path.trim() || '/'))
    } catch (e) {
      toast('error', `Cannot open ${path}: ${(e as Error).message}`)
      setPathInput(cwdRef.current)
    }
  }

  useEffect(() => {
    if (p.startPath && p.enabled) void load(p.startPath)
  }, [p.startPath, p.enabled]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (p.refreshSignal && cwdRef.current) void load(cwdRef.current)
  }, [p.refreshSignal]) // eslint-disable-line react-hooks/exhaustive-deps

  const visible = showHidden ? entries : entries.filter((e) => !e.name.startsWith('.'))
  const selectedEntries = entries.filter((e) => selected.has(e.path))
  useEffect(() => {
    p.onSelection(selectedEntries)
  }, [selected, entries]) // eslint-disable-line react-hooks/exhaustive-deps

  const onRowClick = (e: SftpEntry, ev: MouseEvent): void => {
    setSelected((prev) => {
      if (ev.metaKey || ev.ctrlKey) {
        const n = new Set(prev)
        if (n.has(e.path)) n.delete(e.path)
        else n.add(e.path)
        return n
      }
      if (ev.shiftKey && prev.size > 0) {
        const idx = visible.findIndex((x) => x.path === e.path)
        const anchors = visible.map((x, i) => (prev.has(x.path) ? i : -1)).filter((i) => i >= 0)
        return new Set(visible.slice(Math.min(idx, ...anchors), Math.max(idx, ...anchors) + 1).map((x) => x.path))
      }
      return new Set([e.path])
    })
  }

  const remove = async (): Promise<void> => {
    if (selectedEntries.length === 0) return
    const label = selectedEntries.length === 1 ? `"${selectedEntries[0].name}"` : `${selectedEntries.length} items`
    const warn = p.side === 'remote' ? ' Folders are deleted with all their contents. This cannot be undone.' : ''
    if (!window.confirm(`${p.adapter.removeVerb} ${label}?${warn}`)) return
    try {
      await p.adapter.remove(selectedEntries)
    } catch (e) {
      toast('error', `${p.adapter.removeVerb} failed: ${(e as Error).message}`)
    }
    void load(cwd)
  }
  const commitNewFolder = async (): Promise<void> => {
    const name = (newFolder ?? '').trim()
    setNewFolder(null)
    if (!name) return
    try {
      await p.adapter.mkdir(joinPath(cwd, name))
      await load(cwd)
    } catch (e) {
      toast('error', `Create folder failed: ${(e as Error).message}`)
    }
  }
  const commitRename = async (): Promise<void> => {
    if (!renaming) return
    const { path, name } = renaming
    setRenaming(null)
    const target = name.trim()
    const current = entries.find((e) => e.path === path)
    if (!target || !current || target === current.name) return
    try {
      await p.adapter.rename(path, joinPath(cwd, target))
      await load(cwd)
    } catch (e) {
      toast('error', `Rename failed: ${(e as Error).message}`)
    }
  }

  /* ---- drag & drop ---- */
  const onDragStart = (e: SftpEntry, ev: DragEvent): void => {
    const items = selected.has(e.path) ? selectedEntries : [e]
    ev.dataTransfer.setData(DRAG_MIME, JSON.stringify({ side: p.side, entries: items } satisfies DragPayload))
    ev.dataTransfer.effectAllowed = 'copy'
  }
  const acceptable = (ev: DragEvent): boolean => {
    if (!p.enabled) return false
    const types = Array.from(ev.dataTransfer.types)
    if (types.includes(DRAG_MIME)) return true
    return p.side === 'remote' && types.includes('Files')
  }
  const onDragOverTarget = (targetDir: string, ev: DragEvent): void => {
    if (!acceptable(ev)) return
    ev.preventDefault()
    ev.stopPropagation()
    ev.dataTransfer.dropEffect = 'copy'
    if (dropTarget !== targetDir) setDropTarget(targetDir)
  }
  const onDropTarget = (targetDir: string, ev: DragEvent): void => {
    if (!acceptable(ev)) return
    ev.preventDefault()
    ev.stopPropagation()
    setDropTarget(null)
    const raw = ev.dataTransfer.getData(DRAG_MIME)
    if (raw) {
      const payload = JSON.parse(raw) as DragPayload
      if (payload.side === p.side) return // same side: nothing to transfer
      p.onReceive(payload, targetDir)
      return
    }
    const finderPaths = Array.from(ev.dataTransfer.files)
      .map((f) => {
        try {
          return window.api.pathForFile(f)
        } catch {
          return ''
        }
      })
      .filter(Boolean)
    if (finderPaths.length) p.onReceive({ finderPaths }, targetDir)
  }

  return (
    <div
      className="relative flex h-full min-w-0 flex-1 flex-col"
      onDragOver={(ev) => onDragOverTarget(cwd, ev)}
      onDragLeave={(ev) => {
        if (!ev.currentTarget.contains(ev.relatedTarget as Node)) setDropTarget(null)
      }}
      onDrop={(ev) => onDropTarget(cwd, ev)}
    >
      <div className="panel flex items-center gap-1 border-b px-2 py-1 text-[11px]" style={{ borderColor: 'var(--border)' }}>
        <span className="section-title mr-1 truncate" title={p.title}>
          {p.title}
        </span>
        <button className="btn btn-sm btn-icon" title="Up one level" disabled={!p.enabled || cwd === '/'} onClick={() => void load(parentOf(cwd))}>
          <span className="inline-flex" style={{ transform: 'rotate(-90deg)' }}>
            <Icon.chevron />
          </span>
        </button>
        <button className="btn btn-sm btn-icon" title="Home" disabled={!p.enabled || !p.startPath} onClick={() => void load(p.startPath)}>
          ⌂
        </button>
        <button className="btn btn-sm btn-icon" title="Refresh" disabled={!p.enabled} onClick={() => void load(cwd)}>
          <Icon.refresh className={loading ? 'animate-spin' : ''} />
        </button>
        <input
          className="input mono !h-6 min-w-0 flex-1 text-[11px]"
          value={pathInput}
          disabled={!p.enabled}
          spellCheck={false}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void go(pathInput)
            if (e.key === 'Escape') setPathInput(cwd)
          }}
          onBlur={() => setPathInput(cwd)}
        />
        <label className="muted flex items-center gap-1 whitespace-nowrap" title="Show dotfiles">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Hidden
        </label>
      </div>
      <div className="panel flex items-center gap-1 border-b px-2 py-1 text-[11px]" style={{ borderColor: 'var(--border)' }}>
        <button className="btn btn-sm" disabled={!p.enabled} title="New folder" onClick={() => setNewFolder('')}>
          <Icon.folder /> New folder
        </button>
        <button className="btn btn-sm" disabled={!p.enabled || selectedEntries.length !== 1} onClick={() => selectedEntries[0] && setRenaming({ path: selectedEntries[0].path, name: selectedEntries[0].name })}>
          Rename
        </button>
        <button className="btn btn-sm" disabled={!p.enabled || selectedEntries.length === 0} style={{ color: 'var(--err)' }} onClick={() => void remove()}>
          {p.adapter.removeVerb}
        </button>
        {p.adapter.reveal && (
          <button className="btn btn-sm" disabled={!p.enabled} title="Show in Finder" onClick={() => void p.adapter.reveal!(selectedEntries[0]?.path ?? cwd)}>
            Finder
          </button>
        )}
        <span className="flex-1" />
        <span className="muted whitespace-nowrap">
          {selectedEntries.length ? `${selectedEntries.length} selected` : `${visible.length} item${visible.length === 1 ? '' : 's'}`}
        </span>
      </div>

      <div className={`min-h-0 flex-1 overflow-auto ${dropTarget === cwd ? 'drop-active' : ''}`} onClick={() => setSelected(new Set())}>
        {error && (
          <div className="m-3 rounded-md border px-3 py-2 text-xs" style={{ borderColor: 'var(--err)', color: 'var(--err)' }}>
            {error}
          </div>
        )}
        {!p.enabled && !error && <div className="muted m-3 text-xs">{p.placeholder ?? 'Not connected.'}</div>}
        {p.enabled && cwd && (
          <table className="w-full text-xs" onClick={(e) => e.stopPropagation()}>
            <thead>
              <tr>
                <th>Name</th>
                <th className="w-20 text-right">Size</th>
                <th className="w-36">Modified</th>
              </tr>
            </thead>
            <tbody>
              {newFolder !== null && (
                <tr>
                  <td colSpan={3}>
                    <div className="flex items-center gap-2">
                      <Icon.folder className="muted" />
                      <input
                        autoFocus
                        className="input !h-6 max-w-xs text-xs"
                        placeholder="New folder name"
                        value={newFolder}
                        onChange={(e) => setNewFolder(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitNewFolder()
                          if (e.key === 'Escape') setNewFolder(null)
                        }}
                        onBlur={() => void commitNewFolder()}
                      />
                    </div>
                  </td>
                </tr>
              )}
              {cwd !== '/' && (
                <tr
                  className={`row cursor-default ${dropTarget === parentOf(cwd) ? 'selected' : ''}`}
                  onDoubleClick={() => void load(parentOf(cwd))}
                  onDragOver={(ev) => onDragOverTarget(parentOf(cwd), ev)}
                  onDrop={(ev) => onDropTarget(parentOf(cwd), ev)}
                >
                  <td className="muted" colSpan={3}>
                    <span className="inline-flex items-center gap-2">
                      <Icon.folder /> ..
                    </span>
                  </td>
                </tr>
              )}
              {visible.map((e) => (
                <tr
                  key={e.path}
                  draggable={renaming?.path !== e.path}
                  className={`row cursor-default ${selected.has(e.path) || dropTarget === e.path ? 'selected' : ''}`}
                  onClick={(ev) => onRowClick(e, ev)}
                  onDoubleClick={() => (e.type === 'dir' ? void load(e.path) : p.onOpenFile(e))}
                  onDragStart={(ev) => onDragStart(e, ev)}
                  onDragOver={e.type === 'dir' ? (ev) => onDragOverTarget(e.path, ev) : undefined}
                  onDrop={e.type === 'dir' ? (ev) => onDropTarget(e.path, ev) : undefined}
                >
                  <td>
                    <span className="inline-flex max-w-full items-center gap-2">
                      {e.type === 'dir' ? (
                        <span className="inline-flex" style={{ color: 'var(--accent)' }}>
                          <Icon.folder />
                        </span>
                      ) : (
                        <Icon.layers className="muted" />
                      )}
                      {renaming?.path === e.path ? (
                        <input
                          autoFocus
                          className="input !h-6 max-w-xs text-xs"
                          value={renaming.name}
                          onChange={(ev) => setRenaming({ path: e.path, name: ev.target.value })}
                          onKeyDown={(ev) => {
                            if (ev.key === 'Enter') void commitRename()
                            if (ev.key === 'Escape') setRenaming(null)
                          }}
                          onBlur={() => void commitRename()}
                          onClick={(ev) => ev.stopPropagation()}
                        />
                      ) : (
                        <span className="truncate" title={e.path}>
                          {e.name}
                          {e.type === 'link' && <span className="muted"> →</span>}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="mono muted text-right">{e.type === 'dir' ? '' : fmtSize(e.size)}</td>
                  <td className="mono muted">{fmtDate(e.mtime)}</td>
                </tr>
              ))}
              {visible.length === 0 && newFolder === null && (
                <tr>
                  <td className="muted py-6 text-center" colSpan={3}>
                    {loading ? 'Loading…' : entries.length ? 'Only hidden files here.' : 'Empty folder.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      {dropTarget !== null && (
        <div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 rounded-md border px-3 py-1.5 text-center text-[11px] font-medium" style={{ borderColor: 'var(--accent)', background: 'var(--panel)', color: 'var(--accent)' }}>
          {p.side === 'remote' ? 'Upload to' : 'Download to'} <span className="mono">{dropTarget}</span>
        </div>
      )}
    </div>
  )
}

/* ============================================================ tab */

export default function SftpTab({ tab, active }: { tab: Tab; active: boolean }): ReactElement {
  const updateTab = useStore((s) => s.updateTab)
  const toast = useStore((s) => s.toast)
  const [info, setInfo] = useState<SftpSessionInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [localHome, setLocalHome] = useState('')
  const [transfers, setTransfers] = useState<SftpTransfer[]>([])
  const [panelOpen, setPanelOpen] = useState(true)
  const [localRefresh, setLocalRefresh] = useState(0)
  const [remoteRefresh, setRemoteRefresh] = useState(0)
  const localCwd = useRef('')
  const remoteCwd = useRef('')
  const localSel = useRef<SftpEntry[]>([])
  const remoteSel = useRef<SftpEntry[]>([])
  const refreshTimers = useRef<{ local?: ReturnType<typeof setTimeout>; remote?: ReturnType<typeof setTimeout> }>({})
  const id = tab.id
  const req = tab.sftpRequest!
  const remote = useRef(remoteAdapter(id)).current

  const bump = (side: Side): void => {
    clearTimeout(refreshTimers.current[side])
    refreshTimers.current[side] = setTimeout(() => (side === 'local' ? setLocalRefresh((n) => n + 1) : setRemoteRefresh((n) => n + 1)), 400)
  }

  const connect = async (): Promise<void> => {
    setError(null)
    updateTab(id, { status: 'connecting', message: 'Connecting…' })
    try {
      const i = await window.api.invoke('sftp:open', { ...req, sessionId: id })
      setInfo(i)
      updateTab(id, { status: 'connected', route: i.route, message: `${i.user}@${i.host} · SFTP` })
    } catch (e) {
      const m = (e as Error).message
      setError(m)
      updateTab(id, { status: 'error', message: m })
      toast('error', `SFTP: ${m}`)
      useStore.getState().noteOperationError(m)
    }
  }

  useEffect(() => {
    void window.api.invoke('local:home').then(setLocalHome)
    void connect()
    void window.api.invoke('sftp:transfers', id).then(setTransfers).catch(() => undefined)
    const offT = window.api.on('sftp:transfer', (t) => {
      if (t.sessionId !== id) return
      setTransfers((prev) => {
        const i = prev.findIndex((x) => x.id === t.id)
        if (i < 0) return [...prev, t]
        const next = prev.slice()
        next[i] = t
        return next
      })
      if (t.status === 'done') {
        if (t.kind === 'upload' && parentOf(t.remotePath) === remoteCwd.current) bump('remote')
        if (t.kind === 'download' && parentOf(t.localPath) === localCwd.current) bump('local')
      }
    })
    const offE = window.api.on('sftp:event', (ev) => {
      if (ev.sessionId !== id) return
      setError(ev.message ?? ev.type)
      updateTab(id, { status: ev.type === 'closed' ? 'closed' : 'error', message: ev.message })
    })
    return () => {
      offT()
      offE()
      clearTimeout(refreshTimers.current.local)
      clearTimeout(refreshTimers.current.remote)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (active && info) bump('remote')
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  const connected = tab.status === 'connected' && !!info

  const upload = async (paths: string[], remoteDir: string): Promise<void> => {
    if (!paths.length) return
    try {
      const n = await window.api.invoke('sftp:upload', id, paths, remoteDir)
      toast('info', n ? `${n} file${n === 1 ? '' : 's'} queued for upload to ${remoteDir}.` : 'Nothing to upload (empty folder?).')
      if (n) bump('remote')
    } catch (e) {
      toast('error', `Upload failed: ${(e as Error).message}`)
    }
  }
  const download = async (entries: SftpEntry[], localDir: string): Promise<void> => {
    if (!entries.length) return
    try {
      const n = await window.api.invoke('sftp:downloadTo', id, entries, localDir)
      toast('info', n ? `${n} file${n === 1 ? '' : 's'} queued for download to ${localDir}.` : 'Nothing to download.')
      if (n) bump('local')
    } catch (e) {
      toast('error', `Download failed: ${(e as Error).message}`)
    }
  }

  const activeTransfers = transfers.filter((t) => t.status === 'queued' || t.status === 'running')
  const totalDone = activeTransfers.reduce((a, t) => a + t.done, 0)
  const totalAll = activeTransfers.reduce((a, t) => a + t.total, 0)

  return (
    <div className="flex h-full flex-col">
      <div className="panel flex items-center gap-2 border-b px-2 py-1 text-[11px]" style={{ borderColor: 'var(--border)' }}>
        <span className="muted truncate">{tab.message ?? 'Connecting…'}</span>
        <span className="flex-1" />
        <span className="muted hidden xl:inline">Drag between panes, or drop files from Finder on the remote side.</span>
        <HostActions instanceKey={tab.instanceKey} current="sftp" />
        {(tab.status === 'closed' || tab.status === 'error') && (
          <button className="btn btn-sm" onClick={() => void connect()}>
            Reconnect
          </button>
        )}
        <button className="btn btn-sm" onClick={() => void useStore.getState().closeTab(id)}>
          Disconnect
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <FilePane
          side="local"
          title="This Mac"
          adapter={localAdapter}
          enabled={!!localHome}
          startPath={localHome}
          refreshSignal={localRefresh}
          onCwd={(c) => (localCwd.current = c)}
          onSelection={(es) => (localSel.current = es)}
          onReceive={(payload, targetDir) => {
            if ('entries' in payload) void download(payload.entries, targetDir)
          }}
          onOpenFile={(e) => connected && void upload([e.path], remoteCwd.current)}
        />
        <div className="flex w-12 shrink-0 flex-col items-center justify-center gap-2 border-x" style={{ borderColor: 'var(--border)', background: 'var(--panel-2)' }}>
          <button className="btn btn-icon" title="Upload the files selected on the left into the remote folder" disabled={!connected} onClick={() => void upload(localSel.current.map((e) => e.path), remoteCwd.current)}>
            →
          </button>
          <button className="btn btn-icon" title="Download the files selected on the right into the local folder" disabled={!connected} onClick={() => void download(remoteSel.current, localCwd.current)}>
            ←
          </button>
        </div>
        <FilePane
          side="remote"
          title={info ? `${info.user}@${info.host}` : 'Remote'}
          adapter={remote}
          enabled={connected}
          startPath={info?.home ?? ''}
          refreshSignal={remoteRefresh}
          placeholder={error ?? 'Connecting…'}
          onCwd={(c) => (remoteCwd.current = c)}
          onSelection={(es) => (remoteSel.current = es)}
          onReceive={(payload, targetDir) => {
            if ('finderPaths' in payload) void upload(payload.finderPaths, targetDir)
            else void upload(payload.entries.map((e) => e.path), targetDir)
          }}
          onOpenFile={(e) => void download([e], localCwd.current)}
        />
      </div>

      {transfers.length > 0 && (
        <div className="panel border-t text-[11px]" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-2 px-3 py-1">
            <button className="muted flex items-center gap-1" onClick={() => setPanelOpen(!panelOpen)}>
              <Icon.chevron open={panelOpen} />
              Transfers
            </button>
            {activeTransfers.length > 0 ? (
              <span className="muted">
                {activeTransfers.length} active · {fmtSize(totalDone)} / {fmtSize(totalAll)}
              </span>
            ) : (
              <span className="muted">{transfers.length} finished</span>
            )}
            <span className="flex-1" />
            <button
              className="btn btn-ghost btn-sm"
              disabled={activeTransfers.length === transfers.length}
              onClick={() => {
                void window.api.invoke('sftp:clearTransfers', id)
                setTransfers(activeTransfers)
              }}
            >
              Clear finished
            </button>
          </div>
          {panelOpen && (
            <div className="max-h-36 overflow-auto px-3 pb-2">
              {transfers
                .slice()
                .reverse()
                .map((t) => (
                  <div key={t.id} className="flex items-center gap-2 py-0.5">
                    <span className="mono w-3 text-center" title={t.kind}>
                      {t.kind === 'upload' ? '→' : '←'}
                    </span>
                    <span className="w-56 truncate" title={`${t.localPath}\n${t.remotePath}`}>
                      {t.name}
                    </span>
                    <span className="progress flex-1">
                      <span style={{ width: `${t.total ? Math.min(100, (t.done / t.total) * 100) : t.status === 'done' ? 100 : 0}%`, background: t.status === 'error' ? 'var(--err)' : t.status === 'cancelled' ? 'var(--muted)' : 'var(--accent)' }} />
                    </span>
                    <span className="mono muted w-28 text-right">{t.status === 'running' ? `${fmtSize(t.done)} / ${fmtSize(t.total)}` : t.status === 'done' ? fmtSize(t.total) : t.status}</span>
                    {t.status === 'error' && (
                      <span className="w-40 truncate" style={{ color: 'var(--err)' }} title={t.message}>
                        {t.message}
                      </span>
                    )}
                    {(t.status === 'queued' || t.status === 'running') && (
                      <button className="muted hover:!opacity-100" title="Cancel" onClick={() => void window.api.invoke('sftp:cancel', t.id)}>
                        <Icon.x />
                      </button>
                    )}
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

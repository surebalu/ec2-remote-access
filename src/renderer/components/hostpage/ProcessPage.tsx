import { useEffect, useRef, useState, type ReactElement } from 'react'
import { catalogOf } from '@shared/services'
import { formatBytes, formatDuration, formatPct, levelOf, LIMITS } from '@shared/plmHealth'
import { peers, portName, type HostSnapshot, type ProcessDetail } from '@shared/hostInsight'
import type { Instance } from '@shared/types'
import { useStore } from '../../store'
import { Icon } from '../icons'
import { Bar, lvl } from '../health/parts'
import LineChart from './LineChart'
import { PeerList, ProcessList } from './HostPage'

/**
 * One process on the host page: what it is, its CPU and memory read every ten seconds while the page is in front (the
 * charts are this visit's readings: no exporter keeps per-process history), its files, ports and connections, and the
 * service it belongs to, with a way into Services for that unit.
 */

const EVERY_MS = 10_000
const KEEP = 90
const seen = new Map<string, { at: number[]; cpu: (number | null)[]; rss: (number | null)[]; last: ProcessDetail }>()

export default function ProcessPage({ inst, pid, shown, snap, peerName, onPeer, onProcess }: {
  inst: Instance
  pid: number
  shown: boolean
  snap: HostSnapshot | null
  peerName: (ip: string) => string | null
  onPeer: (ip: string) => void
  onProcess: (pid: number) => void
}): ReactElement {
  const key = `${inst.key}|${pid}`
  const [d, setD] = useState(seen.get(key) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const busy = useRef(false)
  const settings = useStore((s) => s.settings)

  const load = async (): Promise<void> => {
    if (busy.current) return
    busy.current = true
    try {
      const p = await window.api.invoke('host:process', inst.key, pid)
      const prev = seen.get(key)
      const next = {
        at: [...(prev?.at ?? []), p.at].slice(-KEEP), cpu: [...(prev?.cpu ?? []), p.gone ? null : p.cpuPct].slice(-KEEP),
        rss: [...(prev?.rss ?? []), p.gone ? null : p.rssBytes].slice(-KEEP), last: p
      }
      seen.set(key, next)
      setD(next)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      busy.current = false
    }
  }

  useEffect(() => {
    setD(seen.get(key) ?? null)
    if (!shown) return
    void load()
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible' && document.hasFocus() && !seen.get(key)?.last.gone) void load()
    }, EVERY_MS)
    return () => window.clearInterval(t)
  }, [key, shown])

  const p = d?.last ?? null
  const fromSnap = snap?.processes.find((x) => x.pid === pid)
  const name = p?.comm || fromSnap?.comm || `Process ${pid}`
  const unit = p?.unit ?? fromSnap?.unit ?? null
  const controllable = !!unit && catalogOf(settings?.serviceCatalog).some((s) => s.units.includes(unit))
  const siblings = snap && unit ? snap.processes.filter((x) => x.unit === unit && x.pid !== pid) : []
  const children = snap ? snap.processes.filter((x) => x.ppid === pid) : []
  const fdPct = p?.fds && p.fdLimit ? (p.fds / p.fdLimit) * 100 : null
  const memPct = p?.rssBytes && snap?.memTotal ? (p.rssBytes / snap.memTotal) * 100 : null
  const inbound = p ? peers(p.connections, 'in', peerName) : []
  const outbound = p ? peers(p.connections, 'out', peerName) : []
  const start = d?.at[0] ?? Date.now()
  const copy = (text: string): void => { void window.api.invoke('clipboard:write', text).then(() => useStore.getState().toast('success', 'Copied')) }

  return (
    <div className="hp-body">
      <div className="hp-head hp-proc-head">
        <div className="hp-avatar proc" aria-hidden="true"><Icon.activity /></div>
        <div className="min-w-0 flex-1">
          <div className="hp-title-row">
            <h2 className="hp-title">{name}</h2>
            <span className="hp-port">PID {pid}</span>
            {p && !p.gone && <span className="hp-state on"><i />{p.state.replace(/^\w \(|\)$/g, '') || 'running'}</span>}
            {p?.gone && <span className="hp-state"><i />ended</span>}
          </div>
          <div className="hp-sub">{[p?.tech ?? fromSnap?.tech, p?.user ? `runs as ${p.user}` : null, unit, inst.name].filter(Boolean).join(' · ')}</div>
        </div>
        <div className="hp-actions">
          {controllable && <button type="button" className="btn btn-sm" onClick={() => useStore.getState().set({ servicesFor: { targets: [{ key: inst.key }], title: inst.name } })}><Icon.layers /> Services</button>}
          <button type="button" className="btn btn-ghost btn-sm btn-icon" title="Read again" aria-label="Read again" onClick={() => void load()}><Icon.refresh /></button>
        </div>
      </div>

      {error && <div className="hp-notice err">Could not read the process: {error}</div>}
      {p?.gone && <div className="hp-notice">Process {pid} has ended. <button type="button" className="hp-link" onClick={() => useStore.getState().hostBack()}>Back to the processes</button></div>}
      {!d && !error && <div className="hp-notice"><Icon.refresh className="animate-spin" /> Asking the server through SSM…</div>}

      {p && !p.gone && (
        <>
          <div className="hp-tiles">
            <div className={`hp-tile ${lvl(levelOf(p.cpuPct, LIMITS.cpu))}`}><div className="hp-tile-label">CPU</div><div className="hp-tile-value">{formatPct(p.cpuPct)}</div><div className="hp-tile-sub">of the whole server, over a second</div></div>
            <div className={`hp-tile ${lvl(levelOf(memPct, LIMITS.mem))}`}><div className="hp-tile-label">Memory</div><div className="hp-tile-value">{formatBytes(p.rssBytes, 1)}</div><div className="hp-tile-sub">{memPct !== null ? `${formatPct(memPct)} of the server · ` : ''}peak {formatBytes(p.hwmBytes, 1)}</div></div>
            <div className="hp-tile lvl-ok"><div className="hp-tile-label">Threads</div><div className="hp-tile-value">{p.threads ?? '–'}</div><div className="hp-tile-sub">{p.swapBytes ? `${formatBytes(p.swapBytes)} swapped` : 'nothing swapped'}</div></div>
            <div className={`hp-tile ${lvl(levelOf(fdPct, LIMITS.disk))}`}><div className="hp-tile-label">Open files</div><div className="hp-tile-value">{p.fds ?? '–'}</div><div className="hp-tile-sub">{p.fdLimit ? `limit ${p.fdLimit.toLocaleString()}` : 'no limit'}</div>{fdPct !== null && <div className="hp-tile-bar"><Bar pct={fdPct} level={levelOf(fdPct, LIMITS.disk)} /></div>}</div>
            <div className="hp-tile lvl-ok"><div className="hp-tile-label">Up for</div><div className="hp-tile-value">{formatDuration(p.uptimeSec)}</div><div className="hp-tile-sub" title={p.started}>since {p.started || '–'}</div></div>
            <div className="hp-tile lvl-ok"><div className="hp-tile-label">Ports</div><div className="hp-tile-value">{new Set(p.listening.map((l) => l.port)).size}</div><div className="hp-tile-sub">{p.connections.reduce((a, c) => a + c.count, 0)} connections</div></div>
          </div>

          <section className="hp-section">
            <div className="hp-section-head"><h3>Since you opened it</h3><span className="hp-section-sub">Read every ten seconds while this page is in front</span></div>
            <div className="hp-charts">
              <LineChart title="CPU" series={[{ label: 'CPU', values: d?.cpu ?? [], slot: 1 }]} start={start} step={EVERY_MS / 1000} hours={1} format={formatPct} hover={hover} onHover={setHover} />
              <LineChart title="Memory" series={[{ label: 'Memory', values: d?.rss ?? [], slot: 1 }]} start={start} step={EVERY_MS / 1000} hours={1} bytes format={(v) => formatBytes(v, 1)} hover={hover} onHover={setHover} />
            </div>
          </section>

          <section className="hp-section">
            <div className="hp-section-head"><h3>Command</h3><span className="flex-1" /><button type="button" className="hp-link" onClick={() => copy(p.args)}><Icon.copy /> Copy</button></div>
            <pre className="hp-cmd select-text">{p.args}</pre>
            <dl className="hp-props two">
              <div><dt>Executable</dt><dd className="mono select-text">{p.exe || '–'}</dd></div>
              <div><dt>Working folder</dt><dd className="mono select-text">{p.cwd || '–'}</dd></div>
              <div><dt>Parent</dt><dd>{p.ppid && p.ppid > 1 ? <button type="button" className="hp-link" onClick={() => onProcess(p.ppid!)}>{snap?.processes.find((x) => x.pid === p.ppid)?.comm ?? 'process'} ({p.ppid})</button> : 'systemd (1)'}</dd></div>
              <div><dt>Service</dt><dd className="mono">{unit ?? '–'}</dd></div>
            </dl>
          </section>

          {p.listening.length > 0 && (
            <section className="hp-section">
              <div className="hp-section-head"><h3>Listens on</h3></div>
              <div className="hp-chips static">{[...new Map(p.listening.map((l) => [l.port, l])).values()].sort((a, b) => a.port - b.port).map((l) => (
                <span key={l.port} className="hp-port">{l.port}{portName(l.port) ? ` ${portName(l.port)}` : ''}{l.addr === '127.0.0.1' ? ' · local only' : ''}</span>
              ))}</div>
            </section>
          )}
          <div className="hp-cols">
            <section className="hp-section"><div className="hp-section-head"><h3>Called by</h3></div><PeerList list={inbound} dir="in" onPeer={onPeer} /></section>
            <section className="hp-section"><div className="hp-section-head"><h3>Talks to</h3></div><PeerList list={outbound} dir="out" onPeer={onPeer} /></section>
          </div>
          {(siblings.length > 0 || children.length > 0) && (
            <section className="hp-section">
              <div className="hp-section-head"><h3>{siblings.length ? `Also in ${unit}` : 'Started by it'}</h3></div>
              <ProcessList ps={[...new Map([...siblings, ...children].map((x) => [x.pid, x])).values()]} memTotal={snap?.memTotal ?? null} onPick={onProcess} compact />
            </section>
          )}
        </>
      )}
    </div>
  )
}

import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { GC_RANGES, formatBytes, formatDuration, formatPct, levelOf, LIMITS, type Level } from '@shared/plmHealth'
import { formatRate, fullestOwnDisk, peers, portName, technologies, type HostHistory, type HostSnapshot, type Peer, type ProcInfo } from '@shared/hostInsight'
import type { Instance } from '@shared/types'
import { allInstances, useStore, type HostPageTab } from '../../store'
import { metaFor } from '../../colors'
import { hasBrowser, openFilesFor, openInConsole, openSshFor } from '../../quickConnect'
import { Icon } from '../icons'
import { Bar, Spark, lvl } from '../health/parts'
import LineChart from './LineChart'
import ProcessPage from './ProcessPage'

/**
 * The host page: one server in depth, in place of the hosts list (clicking a name there, or a server in Services or
 * Health). Live state comes from one SSM command (main/hostInsight.ts) every 30 seconds while the window has focus;
 * the charts from Prometheus, or CloudWatch when no exporter watches the host. A breadcrumb leads back along the trail
 * (store `trail`): the Services dialog or Health tab it was opened from, an earlier host, the list.
 */

const TABS: { id: HostPageTab; label: string }[] = [
  { id: 'overview', label: 'Overview' }, { id: 'processes', label: 'Processes' }, { id: 'disks', label: 'Disks' },
  { id: 'network', label: 'Network' }, { id: 'connections', label: 'Connections' }, { id: 'properties', label: 'Properties' }
]
const HOURS_KEY = 'ui.hostpage.hours'
const LIVE_MS = 30_000
const HISTORY_MS = 60_000
const snaps = new Map<string, HostSnapshot>()
const hists = new Map<string, HostHistory>()
const readHours = (): number => { try { const n = Number(localStorage.getItem(HOURS_KEY)); return GC_RANGES.some((r) => r.hours === n) ? n : 6 } catch { return 6 } }
/** In the Mac app only while its window has focus (each read is an SSM command); a phone or iPad pauses hidden pages itself. */
export const mayRefresh = (): boolean => document.visibilityState === 'visible' && (!hasBrowser() || document.hasFocus())

export const pctOf = (used: number | null, total: number | null): number | null => (used !== null && total ? (used / total) * 100 : null)

export default function HostPage(): ReactElement | null {
  const view = useStore((s) => s.hostPage)
  const shown = useStore((s) => s.activeTab === 'hosts' && !s.gridView && !!s.hostPage)
  const trail = useStore((s) => s.trail)
  const instances = useStore((s) => s.instances)
  const manualHosts = useStore((s) => s.settings?.manualHosts)
  const settings = useStore((s) => s.settings)
  const inst = useMemo(() => (view ? allInstances(useStore.getState()).find((i) => i.key === view.key) ?? null : null), [view, instances, manualHosts])
  const nameOf = useMemo(() => {
    const m = new Map<string, Instance>()
    for (const i of allInstances(useStore.getState())) { if (i.privateIp) m.set(i.privateIp, i); if (i.publicIp) m.set(i.publicIp, i) }
    return m
  }, [instances, manualHosts])
  const key = view?.key ?? ''
  const [snap, setSnap] = useState<HostSnapshot | null>(snaps.get(key) ?? null)
  const [snapErr, setSnapErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [hours, setHours] = useState(readHours)
  const [hist, setHist] = useState<HostHistory | null>(hists.get(`${key}|${hours}`) ?? null)
  const [hover, setHover] = useState<number | null>(null)
  const busy = useRef(false)
  const linux = !!inst && inst.platform !== 'windows'

  const loadSnap = async (): Promise<void> => {
    if (!inst || !linux || busy.current) return
    busy.current = true
    setLoading(true)
    try {
      const s = await window.api.invoke('host:snapshot', inst.key)
      snaps.set(inst.key, s)
      if (useStore.getState().hostPage?.key === inst.key) { setSnap(s); setSnapErr(null) }
    } catch (e) {
      if (useStore.getState().hostPage?.key === inst.key) setSnapErr((e as Error).message)
    } finally {
      busy.current = false
      setLoading(false)
    }
  }
  const loadHist = async (): Promise<void> => {
    if (!inst || inst.manual) return
    const k = `${inst.key}|${hours}`
    try {
      const h = await window.api.invoke('host:history', inst.key, hours)
      hists.set(k, h)
      if (useStore.getState().hostPage?.key === inst.key) setHist(h)
    } catch { /* the charts say there is no data */ }
  }

  useEffect(() => {
    setSnap(snaps.get(key) ?? null)
    setSnapErr(null)
    setHist(hists.get(`${key}|${hours}`) ?? null)
  }, [key])
  useEffect(() => {
    if (!shown || !inst) return
    const fresh = snaps.get(inst.key)
    if (!fresh || Date.now() - fresh.at > LIVE_MS / 2) void loadSnap()
    const t = window.setInterval(() => { if (mayRefresh() && !useStore.getState().hostPage?.pid) void loadSnap() }, LIVE_MS)
    const back = (): void => { const s = snaps.get(inst.key); if (!s || Date.now() - s.at > LIVE_MS) void loadSnap() }
    window.addEventListener('focus', back)
    return () => { window.clearInterval(t); window.removeEventListener('focus', back) }
  }, [shown, inst?.key])
  useEffect(() => {
    if (!shown || !inst) return
    setHist(hists.get(`${inst.key}|${hours}`) ?? null)
    void loadHist()
    const t = window.setInterval(() => { if (mayRefresh()) void loadHist() }, HISTORY_MS)
    return () => window.clearInterval(t)
  }, [shown, inst?.key, hours])

  // The mouse's back button, as in a browser.
  useEffect(() => {
    if (!shown) return
    const up = (e: MouseEvent): void => { if (e.button === 3) { e.preventDefault(); useStore.getState().hostBack() } }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [shown])

  if (!view) return null
  const st = useStore.getState
  const setTab = (tab: HostPageTab): void => st().set({ hostPage: { ...view, tab, pid: undefined } })
  const pickHours = (h: number): void => { setHours(h); try { localStorage.setItem(HOURS_KEY, String(h)) } catch { /* storage unavailable */ } }
  const meta = inst ? metaFor(inst.profile, settings) : null
  const peerName = (ip: string): string | null => nameOf.get(ip)?.name ?? null
  const openPeer = (ip: string): void => { const i = nameOf.get(ip); if (i && inst) st().openHostPage(i.key, { from: inst.name }) }
  const openProcess = (pid: number): void => st().set({ hostPage: { ...view, tab: 'processes', pid } })

  const crumbs = (
    <nav className="hp-crumbs" aria-label="Where you came from">
      <button type="button" className="hp-back" title="Back (⌘[ or the mouse's back button)" aria-label="Back" onClick={() => st().hostBack()}><Icon.back /></button>
      {trail.map((t, i) => <span key={i} className="hp-crumb"><button type="button" onClick={() => st().hostBackTo(i)}>{t.label}</button><Icon.chevron /></span>)}
      <span className="hp-crumb"><button type="button" onClick={() => st().set({ hostPage: null, trail: [] })}>Hosts</button><Icon.chevron /></span>
      {view.pid
        ? <><span className="hp-crumb"><button type="button" onClick={() => setTab('processes')}>{inst?.name ?? view.key}</button><Icon.chevron /></span><span className="hp-crumb current" aria-current="page">Process {view.pid}</span></>
        : <span className="hp-crumb current" aria-current="page">{inst?.name ?? view.key}</span>}
    </nav>
  )

  if (!inst) {
    return (
      <div className="host-page">
        <div className="hp-top">{crumbs}</div>
        <div className="hp-body"><div className="hp-notice">This host is no longer in the inventory. Rescan, or go back to the list.</div></div>
      </div>
    )
  }

  if (view.pid) {
    return (
      <div className="host-page" data-accent={meta?.color}>
        <div className="hp-top">{crumbs}</div>
        <ProcessPage inst={inst} pid={view.pid} shown={shown} snap={snap} peerName={peerName} onPeer={openPeer} onProcess={openProcess} />
      </div>
    )
  }

  const running = inst.state === 'running'
  const memPct = snap ? pctOf(snap.memTotal !== null && snap.memAvailable !== null ? snap.memTotal - snap.memAvailable : null, snap.memTotal) : null
  const disk = snap ? fullestOwnDisk(snap.disks) : null
  const diskPct = disk ? (disk.used / disk.size) * 100 : null
  const rx = snap?.nets.reduce((a, n) => a + n.rxBps, 0) ?? null
  const tx = snap?.nets.reduce((a, n) => a + n.txBps, 0) ?? null
  const inbound = snap ? peers(snap.connections, 'in', peerName) : []
  const outbound = snap ? peers(snap.connections, 'out', peerName) : []
  const why = !running ? `The instance is ${inst.state}.` : inst.manual ? 'Live details need SSM, which a server added by hand does not have.' : !linux ? 'Processes, disks and connections are read on Linux servers; Windows shows its metrics only.' : !inst.ssmOnline ? 'The SSM agent is not online, so the server cannot be asked.' : null

  return (
    <div className="host-page" data-accent={meta?.color}>
      <div className="hp-top">
        {crumbs}
        <div className="hp-head">
          <div className={`hp-avatar ${linux ? '' : 'win'}`} aria-hidden="true">{linux ? <Icon.linux /> : <Icon.windows />}</div>
          <div className="min-w-0 flex-1">
            <div className="hp-title-row">
              <h2 className="hp-title">{inst.name}</h2>
              {meta && <span className="env-chip">{meta.label}</span>}
              <span className={`hp-state ${running ? 'on' : ''}`}><i />{inst.state}</span>
            </div>
            <div className="hp-sub">
              {[inst.instanceType, inst.privateIp, snap?.os || inst.osHint, snap?.cpus ? `${snap.cpus} cores` : null, snap?.memTotal ? `${formatBytes(snap.memTotal, 0)} memory` : null, snap?.uptimeSec ? `up ${formatDuration(snap.uptimeSec)}` : null].filter(Boolean).join(' · ')}
            </div>
          </div>
          <div className="hp-actions">
            {linux && <button type="button" className="btn btn-sm" disabled={!running} onClick={() => openSshFor(inst.key)}><Icon.terminal /> SSH</button>}
            <button type="button" className="btn btn-sm" disabled={!running} onClick={() => openFilesFor(inst.key)}><Icon.folder /> Files</button>
            {linux && !inst.manual && <button type="button" className="btn btn-sm" disabled={!running || !inst.ssmOnline} onClick={() => st().set({ servicesFor: { targets: [{ key: inst.key }], title: inst.name } })}><Icon.layers /> Services</button>}
            {!inst.manual && <button type="button" className="btn btn-sm" disabled={!running || !inst.ssmOnline} onClick={() => st().set({ runCommandFor: { keys: [inst.key] } })}><Icon.broadcast /> Run command</button>}
            {!inst.manual && <button type="button" className="btn btn-ghost btn-sm btn-icon" title="Open in the AWS console" aria-label="Open in the AWS console" onClick={() => openInConsole(inst)}><Icon.globe /></button>}
            {linux && running && !inst.manual && <button type="button" className="btn btn-ghost btn-sm btn-icon" title={snap ? `Read ${new Date(snap.at).toLocaleTimeString()}; read again` : 'Read again'} aria-label="Read again" disabled={loading} onClick={() => void loadSnap()}><Icon.refresh className={loading ? 'animate-spin' : ''} /></button>}
          </div>
        </div>
        <div className="hp-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={view.tab === t.id} className={view.tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === 'processes' && snap ? <span className="hp-count">{snap.processes.length}</span> : null}
              {t.id === 'connections' && snap ? <span className="hp-count">{inbound.length + outbound.length}</span> : null}
            </button>
          ))}
        </div>
      </div>
      <div className="hp-body">
        {why && view.tab !== 'properties' && <div className="hp-notice">{why}</div>}
        {snapErr && <div className="hp-notice err">Could not read the server: {snapErr}</div>}
        {!snap && !snapErr && !why && view.tab !== 'properties' && <div className="hp-notice"><Icon.refresh className="animate-spin" /> Asking the server through SSM (a few seconds)…</div>}

        {view.tab === 'overview' && (
          <>
            <div className="hp-tiles">
              <Tile label="CPU" value={formatPct(snap?.cpuPct ?? last(hist?.cpu))} level={levelOf(snap?.cpuPct ?? last(hist?.cpu) ?? null, LIMITS.cpu)} spark={hist?.cpu} max={100}
                sub={snap?.cpus ? `${snap.cpus} cores` : undefined} />
              <Tile label="Memory" value={formatPct(memPct ?? last(hist?.memPct))} level={levelOf(memPct ?? last(hist?.memPct) ?? null, LIMITS.mem)} spark={hist?.memPct} max={100}
                sub={snap?.memTotal && snap.memAvailable !== null ? `${formatBytes(snap.memTotal - snap.memAvailable)} of ${formatBytes(snap.memTotal, 0)}` : undefined} />
              <Tile label="Load" value={snap?.load ? snap.load[0].toFixed(2) : '–'} level={snap?.load && snap.cpus ? (snap.load[0] / snap.cpus > 1.5 ? 'crit' : snap.load[0] / snap.cpus > 1 ? 'warn' : 'ok') : 'unknown'}
                sub={snap?.load ? `5 min ${snap.load[1].toFixed(2)} · 15 min ${snap.load[2].toFixed(2)}` : undefined} />
              <Tile label="Fullest disk" value={formatPct(diskPct)} level={levelOf(diskPct, LIMITS.disk)} sub={disk ? `${disk.mount} · ${formatBytes(disk.avail)} free` : undefined}
                bar={diskPct} />
              <Tile label="Network" value={rx === null ? '–' : formatRate(rx)} level={rx === null ? 'unknown' : 'ok'} sub={tx === null ? undefined : `in · ${formatRate(tx)} out`} spark={hist?.netIn} />
              <Tile label="Processes" value={snap ? String(snap.processes.length) : '–'} level={snap ? 'ok' : 'unknown'}
                sub={snap ? `${snap.listening.length} listening ports · ${snap.connections.reduce((a, c) => a + c.count, 0)} connections` : undefined} />
            </div>

            <Section title="Over time" right={<Ranges hours={hours} onPick={pickHours} />} sub={hist?.source === 'prometheus' ? 'From Prometheus' : hist?.note}>
              <div className="hp-charts">
                <LineChart title="CPU" series={[{ label: 'CPU', values: hist?.cpu ?? [], slot: 1 }]} start={hist?.start ?? 0} step={hist?.step ?? 60} hours={hours} max={100} format={formatPct} hover={hover} onHover={setHover} />
                <LineChart title="Memory in use" series={[{ label: 'Memory', values: hist?.memPct ?? [], slot: 1 }]} start={hist?.start ?? 0} step={hist?.step ?? 60} hours={hours} max={100} format={formatPct} hover={hover} onHover={setHover}
                  note={hist?.source === 'cloudwatch' ? 'EC2 does not report memory without its agent.' : undefined} />
                <LineChart title="Network" series={[{ label: 'In', values: hist?.netIn ?? [], slot: 1 }, { label: 'Out', values: hist?.netOut ?? [], slot: 2 }]} start={hist?.start ?? 0} step={hist?.step ?? 60} hours={hours} bytes format={formatRate} hover={hover} onHover={setHover} />
                <LineChart title="Disk I/O" series={[{ label: 'Read', values: hist?.diskRead ?? [], slot: 1 }, { label: 'Write', values: hist?.diskWrite ?? [], slot: 2 }]} start={hist?.start ?? 0} step={hist?.step ?? 60} hours={hours} bytes format={formatRate} hover={hover} onHover={setHover} />
              </div>
            </Section>

            {snap && (
              <div className="hp-cols">
                <Section title="Technologies" sub="What runs here, by memory">
                  <Technologies ps={snap.processes} total={snap.memTotal} onPick={() => setTab('processes')} />
                </Section>
                <Section title="Top processes" sub="By memory" right={<button type="button" className="hp-link" onClick={() => setTab('processes')}>All processes</button>}>
                  <ProcessList ps={[...snap.processes].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, 7)} memTotal={snap.memTotal} onPick={openProcess} compact />
                </Section>
              </div>
            )}
            {snap && (
              <div className="hp-cols">
                <Section title="Called by" sub="Machines connected to this one" right={<button type="button" className="hp-link" onClick={() => setTab('connections')}>All connections</button>}>
                  <PeerList list={inbound.slice(0, 6)} dir="in" onPeer={openPeer} />
                </Section>
                <Section title="Talks to" sub="Machines this one is connected to">
                  <PeerList list={outbound.slice(0, 6)} dir="out" onPeer={openPeer} />
                </Section>
              </div>
            )}
            {snap && (
              <Section title="Disks" right={<button type="button" className="hp-link" onClick={() => setTab('disks')}>Details</button>}>
                <DiskBars snap={snap} />
              </Section>
            )}
          </>
        )}

        {view.tab === 'processes' && snap && <ProcessesTab snap={snap} onPick={openProcess} />}
        {view.tab === 'disks' && snap && <DisksTab snap={snap} hist={hist} hours={hours} hover={hover} onHover={setHover} onHours={pickHours} />}
        {view.tab === 'network' && snap && <NetworkTab snap={snap} hist={hist} hours={hours} hover={hover} onHover={setHover} onHours={pickHours} onProcess={openProcess} />}
        {view.tab === 'connections' && snap && (
          <>
            <Section title="Called by" sub="Established connections to a port this server listens on"><PeerList list={inbound} dir="in" onPeer={openPeer} full /></Section>
            <Section title="Talks to" sub="Established connections this server opened"><PeerList list={outbound} dir="out" onPeer={openPeer} full /></Section>
          </>
        )}
        {view.tab === 'properties' && <Properties inst={inst} />}
      </div>
    </div>
  )
}

const last = (v?: (number | null)[]): number | null => (v ? [...v].reverse().find((x) => x !== null) ?? null : null)

function Section({ title, sub, right, children }: { title: string; sub?: ReactNode; right?: ReactNode; children: ReactNode }): ReactElement {
  return (
    <section className="hp-section">
      <div className="hp-section-head"><h3>{title}</h3>{sub && <span className="hp-section-sub">{sub}</span>}<span className="flex-1" />{right}</div>
      {children}
    </section>
  )
}

function Ranges({ hours, onPick }: { hours: number; onPick: (h: number) => void }): ReactElement {
  return (
    <div className="hp-ranges" role="group" aria-label="Time window">
      {GC_RANGES.filter((r) => r.hours <= 168).map((r) => <button key={r.hours} type="button" className={r.hours === hours ? 'on' : ''} aria-pressed={r.hours === hours} onClick={() => onPick(r.hours)}>{r.label}</button>)}
    </div>
  )
}

function Tile({ label, value, sub, level, spark, max, bar }: { label: string; value: string; sub?: string; level: Level; spark?: (number | null)[]; max?: number; bar?: number | null }): ReactElement {
  return (
    <div className={`hp-tile ${lvl(level)}`}>
      <div className="hp-tile-label">{label}</div>
      <div className="hp-tile-value">{value}</div>
      {sub && <div className="hp-tile-sub" title={sub}>{sub}</div>}
      {spark && <Spark values={spark} level={level === 'unknown' ? 'ok' : level} min={max ? 0 : undefined} max={max} height={26} className="hp-tile-spark" />}
      {bar !== undefined && <div className="hp-tile-bar"><Bar pct={bar} level={level} marks={[LIMITS.disk[1]]} /></div>}
    </div>
  )
}

function Technologies({ ps, total, onPick }: { ps: ProcInfo[]; total: number | null; onPick: () => void }): ReactElement {
  const list = technologies(ps).filter((t) => t.tech !== 'Linux kernel')
  return (
    <div className="hp-tech">
      {list.map((t) => (
        <button key={t.tech} type="button" className="hp-tech-row" onClick={onPick}>
          <span className="hp-tech-name">{t.tech}</span>
          <span className="hp-tech-meta">{t.processes} {t.processes === 1 ? 'process' : 'processes'}{t.cpuPct >= 0.5 ? ` · ${formatPct(t.cpuPct)} CPU` : ''}</span>
          <span className="hp-tech-mem">{formatBytes(t.rssBytes, 1)}</span>
          <span className="hp-tech-bar"><i style={{ width: `${total ? Math.min(100, (t.rssBytes / total) * 100) : 0}%` }} /></span>
        </button>
      ))}
    </div>
  )
}

export function ProcessList({ ps, memTotal, onPick, compact }: { ps: ProcInfo[]; memTotal: number | null; onPick: (pid: number) => void; compact?: boolean }): ReactElement {
  return (
    <div className={`hp-plist ${compact ? 'compact' : ''}`}>
      {ps.map((p) => (
        <button key={p.pid} type="button" className="hp-prow" onClick={() => onPick(p.pid)} title={p.args}>
          <span className="hp-pname"><strong>{p.comm}</strong><span className="muted">{p.unit ?? p.tech}</span></span>
          <span className="hp-pnum">{formatPct(p.cpuPct)}</span>
          <span className="hp-pnum">{formatBytes(p.rssBytes, 1)}</span>
          <span className="hp-tech-bar"><i style={{ width: `${memTotal ? Math.min(100, (p.rssBytes / memTotal) * 100) : 0}%` }} /></span>
        </button>
      ))}
    </div>
  )
}

export function PeerList({ list, dir, onPeer, full }: { list: Peer[]; dir: 'in' | 'out'; onPeer: (ip: string) => void; full?: boolean }): ReactElement {
  if (!list.length) return <p className="hp-empty">{dir === 'in' ? 'Nothing is connected to this server right now.' : 'This server has no open connections right now.'}</p>
  return (
    <div className={`hp-peers ${full ? 'full' : ''}`}>
      {list.map((p) => (
        <div key={p.remote} className="hp-peer">
          <span className="hp-peer-who">
            {p.name ? <button type="button" className="hp-link" onClick={() => onPeer(p.remote)} title={`Open ${p.name}'s host page`}>{p.name}</button> : <span>{p.remote}</span>}
            {p.name && <span className="muted mono">{p.remote}</span>}
          </span>
          <span className="hp-peer-ports">{p.ports.slice(0, 4).map((port) => <span key={port} className="hp-port">{port}{portName(port) ? ` ${portName(port)}` : ''}</span>)}{p.ports.length > 4 ? <span className="muted">+{p.ports.length - 4}</span> : null}</span>
          {full && <span className="hp-peer-proc muted truncate">{p.processes.join(', ')}</span>}
          <span className="hp-peer-n" title={`${p.connections} connections`}>{p.connections}</span>
        </div>
      ))}
    </div>
  )
}

function DiskBars({ snap }: { snap: HostSnapshot }): ReactElement {
  return (
    <div className="hp-disks">
      {snap.disks.map((d) => {
        const pct = d.size ? (d.used / d.size) * 100 : null
        const shared = /^(nfs|cifs|smb|fuse)/.test(d.fs)
        return (
          <div key={d.mount} className={`hp-disk ${lvl(shared ? 'unknown' : levelOf(pct, LIMITS.disk))}`}>
            <span className="hp-disk-mount mono truncate" title={`${d.device} (${d.fs})`}>{d.mount}</span>
            <Bar pct={pct} level={shared ? 'unknown' : levelOf(pct, LIMITS.disk)} marks={[LIMITS.disk[1]]} />
            <span className="hp-disk-num">{formatPct(pct)}</span>
            <span className="hp-disk-free muted">{formatBytes(d.avail)} free of {formatBytes(d.size, 0)}{shared ? ' · shared' : ''}</span>
          </div>
        )
      })}
    </div>
  )
}

type SortKey = 'cpu' | 'mem' | 'threads' | 'up' | 'name'

function ProcessesTab({ snap, onPick }: { snap: HostSnapshot; onPick: (pid: number) => void }): ReactElement {
  const [q, setQ] = useState('')
  const [tech, setTech] = useState<string | null>(null)
  const [sort, setSort] = useState<SortKey>('mem')
  const techs = technologies(snap.processes)
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const rows = snap.processes
    .filter((p) => (!tech || p.tech === tech) && words.every((w) => `${p.comm} ${p.args} ${p.user} ${p.unit ?? ''} ${p.pid} ${p.tech}`.toLowerCase().includes(w)))
    .sort((a, b) => sort === 'cpu' ? (b.cpuPct ?? 0) - (a.cpuPct ?? 0) || b.rssBytes - a.rssBytes
      : sort === 'mem' ? b.rssBytes - a.rssBytes
        : sort === 'threads' ? b.threads - a.threads
          : sort === 'up' ? b.uptimeSec - a.uptimeSec
            : a.comm.localeCompare(b.comm))
  const head = (k: SortKey, label: string, cls = ''): ReactElement => (
    <button type="button" className={`hp-th ${cls} ${sort === k ? 'on' : ''}`} aria-pressed={sort === k} onClick={() => setSort(k)}>{label}{sort === k && <Icon.arrowDown />}</button>
  )
  return (
    <Section title="Processes" sub={`The largest and busiest ${snap.processes.length}, read ${new Date(snap.at).toLocaleTimeString()}`}
      right={<input className="input hp-search" placeholder="Filter by name, user, service…" aria-label="Filter processes" value={q} onChange={(e) => setQ(e.target.value)} />}>
      <div className="hp-chips" role="group" aria-label="Technology">
        <button type="button" className={!tech ? 'on' : ''} onClick={() => setTech(null)}>All</button>
        {techs.map((t) => <button key={t.tech} type="button" className={tech === t.tech ? 'on' : ''} onClick={() => setTech(tech === t.tech ? null : t.tech)}>{t.tech} <b>{t.processes}</b></button>)}
      </div>
      <div className="hp-table hp-ptable" role="table" aria-label="Processes">
        <div className="hp-tr hp-thead" role="row">
          {head('name', 'Process')}<span className="hp-th">PID</span><span className="hp-th">User</span>{head('cpu', 'CPU', 'num')}{head('mem', 'Memory', 'num')}{head('threads', 'Threads', 'num')}{head('up', 'Up for', 'num')}<span className="hp-th">Service</span>
        </div>
        {rows.map((p) => (
          <button key={p.pid} type="button" role="row" className="hp-tr" onClick={() => onPick(p.pid)}>
            <span className="hp-td hp-pcell"><strong>{p.comm}</strong><span className="muted truncate" title={p.args}>{p.args}</span></span>
            <span className="hp-td mono">{p.pid}</span>
            <span className="hp-td truncate">{p.user}</span>
            <span className="hp-td num">{formatPct(p.cpuPct)}</span>
            <span className="hp-td num">{formatBytes(p.rssBytes, 1)}</span>
            <span className="hp-td num">{p.threads}</span>
            <span className="hp-td num">{formatDuration(p.uptimeSec)}</span>
            <span className="hp-td truncate">{p.unit ?? <span className="muted">{p.tech}</span>}</span>
          </button>
        ))}
        {!rows.length && <p className="hp-empty">No process matches.</p>}
      </div>
    </Section>
  )
}

function DisksTab({ snap, hist, hours, hover, onHover, onHours }: { snap: HostSnapshot; hist: HostHistory | null; hours: number; hover: number | null; onHover: (i: number | null) => void; onHours: (h: number) => void }): ReactElement {
  return (
    <>
      <Section title="Disks" sub={`Read ${new Date(snap.at).toLocaleTimeString()}; I/O over two seconds`}>
        <div className="hp-table hp-dtable" role="table" aria-label="Disks">
          <div className="hp-tr hp-thead" role="row">
            <span className="hp-th">Mount</span><span className="hp-th">Device</span><span className="hp-th">Used</span><span className="hp-th num">Size</span><span className="hp-th num">Free</span><span className="hp-th num">Read</span><span className="hp-th num">Write</span><span className="hp-th num">IOPS</span>
          </div>
          {snap.disks.map((d) => {
            const pct = d.size ? (d.used / d.size) * 100 : null
            return (
              <div key={d.mount} role="row" className="hp-tr">
                <span className="hp-td mono truncate">{d.mount}</span>
                <span className="hp-td truncate muted" title={d.device}>{d.device.replace(/^\/dev\//, '')} · {d.fs}</span>
                <span className="hp-td hp-used"><Bar pct={pct} level={levelOf(pct, LIMITS.disk)} marks={[LIMITS.disk[1]]} /><span>{formatPct(pct)}</span></span>
                <span className="hp-td num">{formatBytes(d.size, 0)}</span>
                <span className="hp-td num">{formatBytes(d.avail)}</span>
                <span className="hp-td num">{formatRate(d.readBps)}</span>
                <span className="hp-td num">{formatRate(d.writeBps)}</span>
                <span className="hp-td num">{d.readIops === null ? '–' : Math.round((d.readIops ?? 0) + (d.writeIops ?? 0))}</span>
              </div>
            )
          })}
        </div>
      </Section>
      <Section title="Disk I/O over time" right={<Ranges hours={hours} onPick={onHours} />}>
        <LineChart title="Disk I/O" series={[{ label: 'Read', values: hist?.diskRead ?? [], slot: 1 }, { label: 'Write', values: hist?.diskWrite ?? [], slot: 2 }]} start={hist?.start ?? 0} step={hist?.step ?? 60} hours={hours} bytes format={formatRate} hover={hover} onHover={onHover} />
      </Section>
    </>
  )
}

function NetworkTab({ snap, hist, hours, hover, onHover, onHours, onProcess }: { snap: HostSnapshot; hist: HostHistory | null; hours: number; hover: number | null; onHover: (i: number | null) => void; onHours: (h: number) => void; onProcess: (pid: number) => void }): ReactElement {
  const ports = [...snap.listening].sort((a, b) => a.port - b.port).filter((l, i, all) => all.findIndex((x) => x.port === l.port && x.pid === l.pid) === i)
  return (
    <>
      <Section title="Interfaces" sub="Over two seconds; errors and drops since boot">
        <div className="hp-table hp-ntable" role="table" aria-label="Network interfaces">
          <div className="hp-tr hp-thead" role="row"><span className="hp-th">Interface</span><span className="hp-th num">In</span><span className="hp-th num">Out</span><span className="hp-th num">Packets in/out</span><span className="hp-th num">Errors</span><span className="hp-th num">Drops</span></div>
          {snap.nets.map((n) => (
            <div key={n.iface} role="row" className="hp-tr">
              <span className="hp-td mono">{n.iface}</span>
              <span className="hp-td num">{formatRate(n.rxBps)}</span>
              <span className="hp-td num">{formatRate(n.txBps)}</span>
              <span className="hp-td num">{Math.round(n.rxPps)}/s · {Math.round(n.txPps)}/s</span>
              <span className={`hp-td num ${n.rxErrs + n.txErrs ? 'hp-bad' : ''}`}>{n.rxErrs + n.txErrs}</span>
              <span className={`hp-td num ${n.rxDrop + n.txDrop ? 'hp-bad' : ''}`}>{n.rxDrop + n.txDrop}</span>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Traffic over time" right={<Ranges hours={hours} onPick={onHours} />}>
        <LineChart title="Network" series={[{ label: 'In', values: hist?.netIn ?? [], slot: 1 }, { label: 'Out', values: hist?.netOut ?? [], slot: 2 }]} start={hist?.start ?? 0} step={hist?.step ?? 60} hours={hours} bytes format={formatRate} hover={hover} onHover={onHover} />
      </Section>
      <Section title="Listening ports" sub={`${ports.length} ports`}>
        <div className="hp-table hp-ltable" role="table" aria-label="Listening ports">
          <div className="hp-tr hp-thead" role="row"><span className="hp-th num">Port</span><span className="hp-th">Usually</span><span className="hp-th">Address</span><span className="hp-th">Process</span></div>
          {ports.map((l) => (
            <div key={`${l.addr}:${l.port}:${l.pid}`} role="row" className="hp-tr">
              <span className="hp-td num mono">{l.port}</span>
              <span className="hp-td muted">{portName(l.port) ?? ''}</span>
              <span className="hp-td mono">{l.addr === '0.0.0.0' || l.addr === '::' ? 'every address' : l.addr === '127.0.0.1' || l.addr === '::1' ? 'this server only' : l.addr}</span>
              <span className="hp-td">{l.pid ? <button type="button" className="hp-link" onClick={() => onProcess(l.pid!)}>{l.process} ({l.pid})</button> : <span className="muted">{l.process ?? '–'}</span>}</span>
            </div>
          ))}
        </div>
      </Section>
    </>
  )
}

function Properties({ inst }: { inst: Instance }): ReactElement {
  const fields: [string, string | undefined][] = [
    ['Instance ID', inst.instanceId], ['Account', inst.accountId], ['Profile', inst.profile], ['Region', inst.region], ['Availability zone', inst.az],
    ['Instance type', inst.instanceType || undefined], ['Private IP', inst.privateIp], ['Public IP', inst.publicIp], ['VPC', inst.vpcId], ['Subnet', inst.subnetId],
    ['AMI', inst.imageId], ['Key pair', inst.keyName], ['SSM agent', inst.ssmAgentVersion], ['Launched', inst.launchTime ? new Date(inst.launchTime).toLocaleString() : undefined]
  ]
  return (
    <div className="hp-cols">
      <Section title="Instance">
        <dl className="hp-props">{fields.filter(([, v]) => v).map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="mono select-text">{v}</dd></div>)}</dl>
      </Section>
      <Section title="Tags">
        {Object.keys(inst.tags).length
          ? <dl className="hp-props">{Object.entries(inst.tags).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => <div key={k}><dt className="break-all">{k}</dt><dd className="break-words select-text">{v || '—'}</dd></div>)}</dl>
          : <p className="hp-empty">No tags.</p>}
      </Section>
    </div>
  )
}

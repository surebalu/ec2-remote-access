import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import type { MonitorSample, OpenApp } from '@shared/macApps'
import { reportSize, type CleanItem } from '@shared/cleanup'
import { ago, bytes, plural } from '@shared/storage'
import { Icon } from '../icons'
import { AreaChart, Ring } from './charts'
import { Badge, Footer, Intro, ItemIcon, Row, Segmented, Squircle, TopBar, useIcons } from './parts'
import { measureReport, quitApps, setRoom, trashItems, useStorage } from './state'

/**
 * Monitor: the processor, memory, disk, network and battery, read every two seconds while the room is shown, charted
 * over five minutes to an hour, with the open apps working hardest. Optimize: apps nobody is using, and junk nobody
 * will miss, cleared in one press after showing what goes.
 */

/** The last hour of readings, kept while the page lives so the charts survive a trip to another room. */
const history: MonitorSample[] = []
const KEEP = 1800
const RANGES = { '5': 5 * 60_000, '15': 15 * 60_000, '60': 60 * 60_000 }

const rate = (n: number): string => `${bytes(n, '0 B')}/s`.replace(' bytes/s', ' B/s')
const duration = (s: number): string => { const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60); return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min` }
const pct = (v: number): string => `${Math.round(v)}%`

export function Monitor({ active }: { active: boolean }): ReactElement {
  const disk = useStorage((s) => s.disk)
  const [samples, setSamples] = useState<MonitorSample[]>(() => [...history])
  const [range, setRange] = useState<'5' | '15' | '60'>('5')
  const [top, setTop] = useState<'cpu' | 'memory'>('cpu')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!active) return
    let on = true
    // Only while the room is in front. Not gated on document.hidden: macOS reports a covered window, or one on another
    // Space, as hidden, which would stop the charts while the window is plainly in use (Health learned this).
    const read = (): void => {
      window.api.invoke('storage:monitor').then((s) => {
        history.push(s)
        if (history.length > KEEP) history.splice(0, history.length - KEEP)
        if (on) { setSamples([...history]); setError(null) }
      }, (e: Error) => { if (on) setError(e.message) })
    }
    read()
    const t = setInterval(read, 2000)
    return () => { on = false; clearInterval(t) }
  }, [active])
  const s = samples.at(-1)
  const win = useMemo(() => { const from = Date.now() - RANGES[range]; return samples.slice(1).filter((x) => x.at >= from) }, [samples, range])
  const times = win.map((x) => x.at)
  const apps = useMemo(() => (s ? [...s.apps].filter((a) => !a.system || a.cpu > 1).sort((a, b) => (top === 'cpu' ? b.cpu - a.cpu : b.memory - a.memory)) : []), [s, top])
  const icons = useIcons(s?.apps.map((a) => (a.path.endsWith('.app') ? a.path : undefined)) ?? [])
  const m = s?.memory
  const pressure = m ? ((m.wired + m.compressed) / m.total) * 100 : 0
  const pressureTone = m?.pressure === 'critical' ? 'crit' : m?.pressure === 'warn' ? 'warn' : 'ok'
  const diskUsed = disk ? disk.total - disk.free : 0

  return (
    <div className="st-room">
      <TopBar title="Monitor" />
      <Intro actions={<Segmented value={range} onChange={setRange} options={[{ id: '5', label: '5 Min' }, { id: '15', label: '15 Min' }, { id: '60', label: '1 Hour' }]} />}>
        Real-time system performance and storage health{s ? `, up ${duration(s.uptime)}` : ''}. It reads them only while this room is open.
      </Intro>
      <div className="st-scroll">
        {error && <div className="plan-error"><Icon.alert />{error}</div>}
        {!s && <div className="st-empty"><div className="st-spinner" /><h3>Reading this Mac…</h3></div>}
        {s && m && (
          <>
            <div className="st-mon-grid four">
              <Card title="CPU" icon={<Icon.activity />} corner={`${s.cores.length} cores`}>
                <div className="st-mon-big"><b>{pct(s.cpu)}</b><span>CPU usage</span></div>
                <AreaChart stacked max={100} format={(v) => `${Math.round(v)}%`} times={times} series={[{ label: 'User', color: '#3b82f6', values: win.map((x) => x.cpuUser) }, { label: 'System', color: '#8b5cf6', values: win.map((x) => x.cpuSys) }]} />
                <Legend items={[['User', pct(s.cpuUser), '#3b82f6'], ['System', pct(s.cpuSys), '#8b5cf6'], ['Idle', pct(100 - s.cpu), '#64748b']]} />
              </Card>
              <Card title="Memory" icon={<Icon.layers />} corner={<Badge tone={pressureTone}>{m.pressure === 'critical' ? 'High' : m.pressure === 'warn' ? 'Raised' : 'Normal'}</Badge>}>
                <div className="st-mon-big"><b>{bytes(m.used)}</b><span>of {Math.round(m.total / 1024 ** 3)} GB used</span></div>
                <AreaChart stacked max={m.total} format={(v) => `${Math.round(v / 1e9)} GB`} times={times} series={[{ label: 'App', color: '#22c55e', values: win.map((x) => x.memory.app) }, { label: 'Wired', color: '#8b5cf6', values: win.map((x) => x.memory.wired) }, { label: 'Compressed', color: '#3b82f6', values: win.map((x) => x.memory.compressed) }]} />
                <Legend items={[['App', bytes(m.app), '#22c55e'], ['Wired', bytes(m.wired), '#8b5cf6'], ['Compressed', bytes(m.compressed), '#3b82f6'], ['Free', bytes(m.free), '#64748b']]} />
              </Card>
              <Card title="Disk" icon={<Icon.disk />} corner={disk?.name ?? 'Macintosh HD'}>
                <div className="st-mon-big"><b>{bytes(diskUsed)}</b><span>of {bytes(disk?.total ?? 0)} used</span></div>
                <div className="st-meter"><span style={{ width: `${disk ? (diskUsed / disk.total) * 100 : 0}%` }} /></div>
                <p className="st-mon-note">{disk ? `${bytes(disk.free)} free · ${Math.round((diskUsed / disk.total) * 100)}% full` : ''}</p>
                <AreaChart format={(v) => rate(v)} times={times} height={80} series={[{ label: 'Read', color: '#3b82f6', values: win.map((x) => x.disk.read) }, { label: 'Write', color: '#f59e0b', values: win.map((x) => x.disk.write) }]} />
                <Legend items={[['Read', rate(s.disk.read), '#3b82f6'], ['Write', rate(s.disk.write), '#f59e0b']]} />
              </Card>
              {s.battery ? (
                <Card title="Battery" icon={<Icon.plug />}>
                  <div className="st-mon-big"><b>{s.battery.percent}%</b></div>
                  <div className="st-meter green"><span style={{ width: `${s.battery.percent}%` }} /></div>
                  <dl className="st-mon-dl">
                    <div><dt>Charge Level</dt><dd>{s.battery.percent}%</dd></div>
                    <div><dt>Time Left</dt><dd>{s.battery.minutes ? `${Math.floor(s.battery.minutes / 60)} h ${s.battery.minutes % 60} min` : s.battery.charging ? 'Estimating' : s.battery.plugged ? 'On power' : 'Estimating'}</dd></div>
                    <div><dt>Power Source</dt><dd>{s.battery.plugged ? 'Power Adapter' : 'Battery'}</dd></div>
                    <div><dt>Cycle Count</dt><dd>{s.battery.cycles ?? '—'}</dd></div>
                    <div><dt>Health</dt><dd>{s.battery.health !== null ? `${s.battery.health}%${s.battery.health < 80 ? ', service recommended' : ''}` : '—'}</dd></div>
                  </dl>
                </Card>
              ) : (
                <Card title="Power" icon={<Icon.plug />}><p className="st-mon-note">This Mac has no battery; it runs on power whenever it is on.</p></Card>
              )}
            </div>
            <div className="st-mon-grid three">
              <Card title="Network" icon={<Icon.globe />} corner={s.address ? `Connected · ${s.address}` : 'No network'}>
                <div className="st-mon-rates"><span><Icon.arrowDown /><b>{rate(s.net.rx)}</b><small>Download</small></span><span><Icon.arrowUp /><b>{rate(s.net.tx)}</b><small>Upload</small></span></div>
                <AreaChart format={(v) => rate(v)} times={times} height={90} series={[{ label: 'In', color: '#3b82f6', values: win.map((x) => x.net.rx) }, { label: 'Out', color: '#a855f7', values: win.map((x) => x.net.tx) }]} />
              </Card>
              <Card title="Processes" icon={<Icon.list />} corner={plural(s.apps.filter((a) => !a.system).length, 'app')} wide>
                <div className="st-proc">
                  <div className="st-proc-head"><span>App</span><span>CPU</span><span>Memory</span></div>
                  {[...s.apps].sort((a, b) => b.cpu - a.cpu).slice(0, 6).map((a) => (
                    <div key={a.path} className="st-proc-row">
                      <span className="st-proc-name">{a.path.endsWith('.app') ? <ItemIcon path={a.path} icons={icons} size={16} /> : <span className="st-proc-dot" />}{a.name}</span>
                      <span>{a.cpu.toFixed(1)}%</span><span>{bytes(a.memory)}</span>
                    </div>
                  ))}
                </div>
              </Card>
              <Card title="Memory Pressure" icon={<Icon.gauge />} corner={<Badge tone={pressureTone}>{m.pressure === 'critical' ? 'High' : m.pressure === 'warn' ? 'Raised' : 'Normal'}</Badge>}>
                <div className="st-mon-split">
                  <div><div className="st-mon-big"><b>{pct(pressure)}</b></div><div className={`st-meter ${pressureTone}`}><span style={{ width: `${pressure}%` }} /></div></div>
                  <dl className="st-mon-dl">
                    <div><dt>Physical Memory</dt><dd>{Math.round(m.total / 1024 ** 3)} GB</dd></div>
                    <div><dt>Memory Used</dt><dd>{bytes(m.used)}</dd></div>
                    <div><dt>Compressed</dt><dd>{bytes(m.compressed)}</dd></div>
                    <div><dt>Cached Files</dt><dd>{bytes(m.cached)}</dd></div>
                    <div><dt>Swap Used</dt><dd>{bytes(m.swap, '0 KB')}</dd></div>
                  </dl>
                </div>
              </Card>
            </div>
            <div className="st-mon-grid two">
              <Card title="Disk Activity" icon={<Icon.disk />} corner="All disks">
                <Legend items={[['Read', rate(s.disk.read), '#3b82f6'], ['Write', rate(s.disk.write), '#f59e0b']]} />
                <AreaChart format={(v) => rate(v)} times={times} height={120} series={[{ label: 'Read', color: '#3b82f6', values: win.map((x) => x.disk.read) }, { label: 'Write', color: '#f59e0b', values: win.map((x) => x.disk.write) }]} />
              </Card>
              <Card title="Top Apps" icon={<Icon.apps />} corner={<Segmented small value={top} onChange={setTop} options={[{ id: 'cpu', label: 'CPU' }, { id: 'memory', label: 'Memory' }]} />}>
                <div className="st-topapps">
                  {apps.slice(0, 6).map((a) => {
                    const max = top === 'cpu' ? Math.max(100, apps[0]?.cpu ?? 1) : apps[0]?.memory || 1
                    const v = top === 'cpu' ? a.cpu : a.memory
                    return (
                      <div key={a.path} className="st-topapp">
                        <span className="st-proc-name">{a.path.endsWith('.app') ? <ItemIcon path={a.path} icons={icons} size={16} /> : <span className="st-proc-dot" />}{a.name}</span>
                        <b>{top === 'cpu' ? `${Math.round(a.cpu)}%` : bytes(a.memory)}</b>
                        <span className="st-meter thin"><span style={{ width: `${(v / max) * 100}%` }} /></span>
                        {!a.system && a.path.endsWith('.app') ? <button type="button" className="st-link" title="Asks it to quit, as Command-Q does" onClick={() => void quitApps(a.pids, [a.name])}>Quit</button> : <span />}
                      </div>
                    )
                  })}
                </div>
              </Card>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Card({ title, icon, corner, children, wide }: { title: string; icon: ReactNode; corner?: ReactNode; children: ReactNode; wide?: boolean }): ReactElement {
  return (
    <section className={`st-panel st-mon-card ${wide ? 'wide' : ''}`}>
      <header><span className="st-mon-icon">{icon}</span><h3>{title}</h3><span className="flex-1" /><span className="st-mon-corner">{corner}</span></header>
      {children}
    </section>
  )
}

function Legend({ items }: { items: [string, string, string][] }): ReactElement {
  return <div className="st-mon-legend">{items.map(([k, v, c]) => <span key={k}><i style={{ background: c }} />{k}<b>{v}</b></span>)}</div>
}

export function Optimize(): ReactElement {
  const junk = useStorage((s) => s.reports.junk)
  const [open, setOpen] = useState<{ apps: OpenApp[]; watchedFor: number } | null>(null)
  const [ticks, setTicks] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const load = (): void => {
    void window.api.invoke('storage:openApps').then((o) => { setOpen(o); setTicks(new Set(o.apps.filter((a) => a.idle).map((a) => a.pid))) })
    measureReport('junk')
  }
  useEffect(load, [])
  const icons = useIcons(open?.apps.map((a) => a.path) ?? [])
  const safeJunk: CleanItem[] = useMemo(() => junk?.groups.flatMap((g) => g.items.filter((i) => i.safe && !i.blocked)) ?? [], [junk])
  const junkBytes = junk ? reportSize(junk, true) : 0
  const quit = open?.apps.filter((a) => ticks.has(a.pid)) ?? []
  const quitBytes = quit.reduce((s, a) => s + a.memory, 0)
  const nothing = !!open && !!junk && !quit.length && !safeJunk.length

  const go = async (): Promise<void> => {
    setBusy(true)
    try {
      if (quit.length) await quitApps(quit.map((a) => a.pid), quit.map((a) => a.name))
      if (safeJunk.length) await trashItems(safeJunk.map((i) => ({ path: i.path, size: i.size, dir: i.dir })), 'Optimize')
    } finally {
      setBusy(false)
      setTimeout(load, 1500)
    }
  }

  return (
    <div className="st-room">
      <TopBar title="Optimize" back={() => setRoom('overview')} />
      <Intro actions={<button type="button" className="st-button" onClick={load}><Icon.refresh />Look Again</button>}>Moves junk nobody will miss to the Trash, and asks apps you are not using to quit. Nothing that is working is touched.</Intro>
      <div className="st-scroll">
        <div className="st-opt-hero">
          <Ring colors={['#fb7185', '#f97316', '#ef4444', '#f43f5e']} size={170} onClick={nothing || busy || !open || !junk ? undefined : () => void go()} title="Optimize now">
            <Icon.wand /><span className="st-ring-big sm">{busy ? 'Working…' : nothing ? 'All clear' : 'Optimize'}</span>
            <span className="st-ring-sub warm">{!open || !junk ? 'Checking…' : `${bytes(junkBytes + quitBytes)}`}</span>
          </Ring>
          <div>
            <h2>{!open || !junk ? 'Checking caches, logs and what each open app is doing…' : nothing ? 'Nothing worth clearing right now' : 'This Mac can be lighter'}</h2>
            <p>{open && junk && !nothing ? `${safeJunk.length ? `${bytes(junkBytes)} of junk to the Trash` : 'No junk'}${quit.length ? `, and ${plural(quit.length, 'app')} holding ${bytes(quitBytes)} asked to quit` : ''}. Quitting works like Quit in the app itself: anything unsaved asks first.` : 'Caches of open apps and macOS\'s own stay. Apps doing something right now are never interrupted.'}</p>
          </div>
        </div>
        <section className="st-panel st-opt-card">
          <header><Squircle look="unused" size={30} /><h3>Apps nobody is using</h3><span className="muted">{open ? `watched for ${duration(Math.round(open.watchedFor / 1000))}: unused after half an hour out of front` : ''}</span></header>
          {open?.apps.map((a) => {
            const locked = a.busy || a.front
            return (
              <Row key={a.pid} checked={ticks.has(a.pid)} onCheck={locked ? undefined : (v) => setTicks((t) => { const x = new Set(t); if (v) x.add(a.pid); else x.delete(a.pid); return x })} lock={locked}
                icon={<ItemIcon path={a.path} icons={icons} size={26} />} title={a.name}
                badges={<>{a.front && <Badge tone="info">In front</Badge>}{a.busy && <Badge tone="warn">Working</Badge>}{a.keep && !a.busy && <Badge>Keeps you notified</Badge>}</>}
                sub={a.front ? 'In use' : a.busy ? `Using ${a.cpu}% of the processor, so it is left alone` : a.lastFront ? `In front ${ago(a.lastFront)}` : 'Not in front since the app started watching'}
                size={a.memory} />
            )
          })}
          {open && !open.apps.length && <p className="muted st-card-empty">No open apps.</p>}
        </section>
        <section className="st-panel st-opt-card">
          <header><Squircle look="junk" size={30} /><h3>Junk nobody will miss</h3><span className="muted">{junk ? `${plural(safeJunk.length, 'item')} · ${bytes(junkBytes)}` : 'measuring…'}</span><span className="flex-1" /><button type="button" className="st-button sm" onClick={() => setRoom('junk')}>See it in Junk Files</button></header>
          {junk?.groups.filter((g) => g.items.some((i) => i.safe && !i.blocked)).map((g) => {
            const items = g.items.filter((i) => i.safe && !i.blocked)
            return <Row key={g.id} icon={<Squircle look={g.look ?? 'items'} size={26} />} title={g.title} sub={plural(items.length, 'item')} size={items.reduce((s, i) => s + i.size, 0)} />
          })}
          {junk && !safeJunk.length && <p className="muted st-card-empty">No junk worth clearing.</p>}
        </section>
      </div>
      <Footer count={quit.length + safeJunk.length} size={junkBytes} note="Junk goes to the Trash, and can be put back; apps are asked to quit, never forced.">
        <button type="button" className="st-primary" disabled={busy || nothing || !open || !junk} onClick={() => void go()}><Icon.wand />{busy ? 'Working…' : 'Optimize'}</button>
      </Footer>
    </div>
  )
}

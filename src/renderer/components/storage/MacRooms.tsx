import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import type { Level } from '@shared/plmHealth'
import type { MonitorSample, OpenApp } from '@shared/macApps'
import { reportSize, type CleanItem } from '@shared/cleanup'
import { ago, bytes, plural } from '@shared/storage'
import { Icon } from '../icons'
import { Gauge, Spark } from '../health/parts'
import { RoomHead } from './parts'
import { quitApps, setRoom, trashItems, useStorage } from './state'

/**
 * Monitor: the processor, memory, disk, network and battery, read every two seconds while the room is shown (and the
 * window is), with the open apps working hardest. Optimize: apps nobody is using, and junk nobody will miss, cleared
 * in one press after showing what goes.
 */

/** The last five minutes of readings, kept while the page lives so the charts survive a trip to another room. */
const history: MonitorSample[] = []
const KEEP = 150

const pctLevel = (v: number, warn: number, crit: number): Level => (v >= crit ? 'crit' : v >= warn ? 'warn' : 'ok')
const rate = (n: number): string => `${bytes(n, '0 KB')}/s`
const duration = (s: number): string => { const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60); return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min` }

export function Monitor({ active }: { active: boolean }): ReactElement {
  const [samples, setSamples] = useState<MonitorSample[]>(() => [...history])
  const [by, setBy] = useState<'cpu' | 'memory'>('cpu')
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
  const series = (f: (x: MonitorSample) => number): number[] => samples.slice(1).map(f)
  const apps = useMemo(() => (s ? [...s.apps].sort((a, b) => (by === 'cpu' ? b.cpu - a.cpu : b.memory - a.memory)).slice(0, 12) : []), [s, by])
  const memPct = s ? (s.memory.used / s.memory.total) * 100 : 0

  return (
    <div className="plan-scroll st-scroll">
      <RoomHead icon={<Icon.gauge />} title="Monitor" sub={s ? `Up ${duration(s.uptime)}${s.address ? ` · ${s.address}` : ''}` : 'Reading this Mac…'} />
      {error && <div className="plan-error st-pad"><Icon.alert />{error}</div>}
      {s && (
        <div className="st-monitor">
          <Card title="Processor" icon={<Icon.activity />} level={pctLevel(s.cpu, 75, 90)}
            big={<Gauge pct={s.cpu} level={pctLevel(s.cpu, 75, 90)} size={84}><b>{Math.round(s.cpu)}%</b></Gauge>}
            spark={series((x) => x.cpu)} max={100}
            rows={[['Load, last minute', s.load[0].toFixed(2)], ['Cores', String(s.cores.length)], ['Heat', s.thermal === 'warm' ? 'Warm: it is working hard' : 'Normal']]}
            extra={<div className="st-cores">{s.cores.map((c, i) => <span key={i} title={`Core ${i + 1}: ${Math.round(c)}%`}><i style={{ height: `${Math.max(3, c)}%` }} /></span>)}</div>} />
          <Card title="Memory" icon={<Icon.layers />} level={s.memory.pressure === 'critical' ? 'crit' : s.memory.pressure === 'warn' ? 'warn' : 'ok'}
            big={<Gauge pct={memPct} level={s.memory.pressure === 'critical' ? 'crit' : s.memory.pressure === 'warn' ? 'warn' : 'ok'} size={84}><b>{Math.round(memPct)}%</b></Gauge>}
            spark={series((x) => (x.memory.used / x.memory.total) * 100)} max={100}
            rows={[['Used', `${bytes(s.memory.used)} of ${bytes(s.memory.total)}`], ['Pressure', s.memory.pressure === 'critical' ? 'High: macOS is short of memory' : s.memory.pressure === 'warn' ? 'Raised: compressing to make room' : 'Normal: memory to spare'], ['Compressed', bytes(s.memory.compressed)], ['Swap', s.memory.swap ? bytes(s.memory.swap) : 'None']]} />
          <Card title="Disk" icon={<Icon.disk />} level="ok"
            big={<div className="st-mon-rates"><span><Icon.arrowDown />{rate(s.disk.read)}</span><span><Icon.arrowUp />{rate(s.disk.write)}</span></div>}
            spark={series((x) => x.disk.read + x.disk.write)}
            rows={[['Reading', rate(s.disk.read)], ['Writing', rate(s.disk.write)]]} />
          <Card title="Network" icon={<Icon.globe />} level="ok"
            big={<div className="st-mon-rates"><span><Icon.arrowDown />{rate(s.net.rx)}</span><span><Icon.arrowUp />{rate(s.net.tx)}</span></div>}
            spark={series((x) => x.net.rx + x.net.tx)}
            rows={[['In', rate(s.net.rx)], ['Out', rate(s.net.tx)], ['Address', s.address ?? 'No network right now']]} />
          {s.battery && (
            <Card title="Battery" icon={<Icon.plug />} level={s.battery.health !== null && s.battery.health < 80 ? 'warn' : 'ok'}
              big={<Gauge pct={s.battery.percent} level={s.battery.percent < 15 && !s.battery.plugged ? 'crit' : 'ok'} size={84}><b>{s.battery.percent}%</b></Gauge>}
              rows={[
                ['Power', s.battery.charging ? 'Charging' : s.battery.plugged ? 'On power, not charging' : 'On battery'],
                ['Time', s.battery.minutes ? `${Math.floor(s.battery.minutes / 60)} h ${s.battery.minutes % 60} min ${s.battery.charging ? 'to full' : 'left'}` : '—'],
                ['Health', s.battery.health !== null ? `${s.battery.health}% of new${s.battery.health < 80 ? ': macOS recommends service' : ''}` : 'Not reported'],
                ['Cycles', s.battery.cycles !== null ? String(s.battery.cycles) : '—']
              ]} />
          )}
        </div>
      )}
      {s && (
        <section className="st-card">
          <h3 className="st-card-title">
            Open apps
            <span className="muted">{by === 'cpu' ? 'working hardest right now' : 'holding the most memory'}, with their helpers, as Activity Monitor adds them up</span>
            <span className="flex-1" />
            <span className="plan-segment" role="radiogroup" aria-label="Order">
              <button type="button" role="radio" aria-checked={by === 'cpu'} className={by === 'cpu' ? 'on' : ''} onClick={() => setBy('cpu')}>Processor</button>
              <button type="button" role="radio" aria-checked={by === 'memory'} className={by === 'memory' ? 'on' : ''} onClick={() => setBy('memory')}>Memory</button>
            </span>
          </h3>
          {apps.map((a) => (
            <div key={a.path} className="st-mon-app">
              <span className="st-mon-name" title={a.path}>{a.name}{a.system && <span className="st-badge">macOS</span>}</span>
              <span className="st-mon-num">{a.cpu.toFixed(1)}%</span>
              <span className="st-mon-num">{bytes(a.memory)}</span>
              {!a.system && a.path.endsWith('.app') ? <button type="button" className="btn btn-sm btn-ghost" title="Asks it to quit, as Command-Q does" onClick={() => void quitApps(a.pids, [a.name])}>Quit</button> : <span className="st-mon-quit" />}
            </div>
          ))}
        </section>
      )}
    </div>
  )
}

function Card({ title, icon, level, big, spark, max, rows, extra }: { title: string; icon: ReactNode; level: Level; big: ReactNode; spark?: number[]; max?: number; rows: [string, string][]; extra?: ReactNode }): ReactElement {
  return (
    <section className={`st-mon-card lvl-${level}`}>
      <h3>{icon}{title}</h3>
      <div className="st-mon-top">
        {big}
        {spark && <Spark values={spark} level={level} min={0} max={max} height={56} />}
      </div>
      {extra}
      <dl>{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    </section>
  )
}

export function Optimize(): ReactElement {
  const junk = useStorage((s) => s.reports.junk)
  const [open, setOpen] = useState<{ apps: OpenApp[]; watchedFor: number } | null>(null)
  const [ticks, setTicks] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [measuring, setMeasuring] = useState(false)
  const load = (): void => {
    void window.api.invoke('storage:openApps').then((o) => { setOpen(o); setTicks(new Set(o.apps.filter((a) => a.idle).map((a) => a.pid))) })
    if (!useStorage.getState().reports.junk) {
      setMeasuring(true)
      void window.api.invoke('storage:junk').then((r) => useStorage.setState((s) => ({ reports: { ...s.reports, junk: r } }))).finally(() => setMeasuring(false))
    }
  }
  useEffect(load, [])
  const safeJunk: CleanItem[] = useMemo(() => junk?.groups.flatMap((g) => g.items.filter((i) => i.safe && !i.blocked)) ?? [], [junk])
  const junkBytes = junk ? reportSize(junk, true) : 0
  const quit = open?.apps.filter((a) => ticks.has(a.pid)) ?? []
  const quitBytes = quit.reduce((s, a) => s + a.memory, 0)
  const nothing = open && junk && !quit.length && !safeJunk.length

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
    <div className="plan-scroll st-scroll">
      <RoomHead icon={<Icon.wand />} title="Optimize" sub="Junk nobody will miss, and apps nobody is using." >
        <button type="button" className="btn btn-sm" onClick={load}><Icon.refresh />Look again</button>
      </RoomHead>
      <div className={`st-banner ${nothing ? 'info' : 'warn'}`}>
        {nothing ? <Icon.check /> : <Icon.wand />}
        <div>
          <b>{!open || (measuring && !junk) ? 'Checking caches, logs and what each open app is doing…' : nothing ? 'Nothing worth clearing right now.' : 'This Mac can be lighter'}</b>
          <p>{open && junk && !nothing ? `${safeJunk.length ? `${bytes(junkBytes)} of junk to the Trash` : 'No junk'}${quit.length ? `, and ${plural(quit.length, 'app')} holding ${bytes(quitBytes)} asked to quit` : ''}. Nothing that is working is touched; quitting works like Quit in the app itself, so anything unsaved asks first.` : 'Caches of open apps and macOS\'s own stay. Apps doing something right now are never interrupted.'}</p>
        </div>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || !!nothing || !open || !junk} onClick={() => void go()}><Icon.wand />{busy ? 'Working…' : 'Optimize'}</button>
      </div>

      <section className="st-card">
        <h3 className="st-card-title">Open apps <span className="muted">{open ? `watched for ${duration(Math.round(open.watchedFor / 1000))}: an app counts as unused after half an hour out of front` : ''}</span></h3>
        {open?.apps.map((a) => {
          const locked = a.busy || a.front
          return (
            <div key={a.pid} className="st-mon-app">
              <input type="checkbox" className="st-check" checked={ticks.has(a.pid)} disabled={locked} aria-label={`Quit ${a.name}`}
                onChange={(e) => setTicks((t) => { const n = new Set(t); if (e.target.checked) n.add(a.pid); else n.delete(a.pid); return n })} />
              <span className="st-mon-name">{a.name}
                {a.front && <span className="st-badge info">In front</span>}
                {a.busy && <span className="st-badge warn">Working</span>}
                {a.keep && !a.busy && <span className="st-badge">Keeps you notified</span>}
              </span>
              <span className="st-mon-note muted">{a.front ? 'In use' : a.busy ? 'Doing something right now, so it is left alone' : a.lastFront ? `In front ${ago(a.lastFront)}` : 'Not in front since the app started watching'}</span>
              <span className="st-mon-num">{a.cpu.toFixed(1)}%</span>
              <span className="st-mon-num">{bytes(a.memory)}</span>
            </div>
          )
        })}
        {open && !open.apps.length && <p className="muted">No open apps.</p>}
      </section>

      <section className="st-card">
        <h3 className="st-card-title">Junk nobody will miss <span className="muted">{junk ? `${plural(safeJunk.length, 'item')} · ${bytes(junkBytes)}` : measuring ? 'measuring…' : ''}</span><span className="flex-1" /><button type="button" className="btn btn-sm btn-ghost" onClick={() => setRoom('junk')}>See it in Junk Files</button></h3>
        {junk?.groups.filter((g) => g.items.some((i) => i.safe && !i.blocked)).map((g) => {
          const items = g.items.filter((i) => i.safe && !i.blocked)
          return <div key={g.id} className="st-mon-app"><span className="st-mon-name">{g.title}</span><span className="st-mon-note muted">{plural(items.length, 'item')}</span><span className="st-mon-num">{bytes(items.reduce((s, i) => s + i.size, 0))}</span></div>
        })}
        {junk && !safeJunk.length && <p className="muted">No junk worth clearing.</p>}
      </section>
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import {
  ENV_NAMES, LIMITS, ago, formatBytes, formatDuration, formatMs, formatPct, levelOf, worst,
  type AlbHealth, type HostHealth, type Issue, type Level, type PlmEnvHealth, type PlmEnvId, type PlmHealthSnapshot, type ServiceHealth
} from '@shared/plmHealth'
import { useStore, type Tab } from '../../store'
import { setTabKeys, type TabKey } from '../../shortcuts'
import { openSshFor } from '../../quickConnect'
import { Icon } from '../icons'
import Popover from '../Popover'
import { Bar, Dot, Empty, Gauge, Pill, SectionHead, Spark, StatusRing, lvl } from './parts'

/**
 * The Health tab: the 3DEXPERIENCE platform at a glance, one environment at a time, from main/plmHealth.ts. It reads
 * again every 30 seconds while it is on screen (never in the background), keeps the last picture across closing and
 * reopening, and works the same in the Mac app and through the gateway on a phone or iPad.
 */

let last: PlmHealthSnapshot | null = null
const ENV_KEY = 'ui.health.env'
const POLL_MS = 30_000

const readEnv = (): PlmEnvId | null => { try { return (localStorage.getItem(ENV_KEY) as PlmEnvId | null) || null } catch { return null } }
const saveEnv = (e: PlmEnvId): void => { try { localStorage.setItem(ENV_KEY, e) } catch { /* storage off */ } }

/** A letter pair and a hue for each part of the platform, so the cards can be told apart at a glance. */
const MARKS: Record<string, [string, number]> = {
  passport: ['Pa', 262], dashboard: ['Da', 214], space: ['Sp', 196], search: ['Se', 26], fcs: ['Fc', 150], index: ['Ft', 44], comment: ['Co', 328],
  swym: ['Sw', 182], notification: ['No', 4], docs: ['Do', 222], tif: ['Ti', 18], converter: ['Dc', 240], cad: ['Ca', 286], apache: ['Ap', 352]
}

const isAuthError = (m: string): boolean => /sso|token|expired|sign.?in|credential|login/i.test(m)

export default function HealthTab({ active }: { tab: Tab; active: boolean }): ReactElement {
  const toast = useStore((s) => s.toast)
  const grafanaUrl = useStore((s) => s.settings?.grafanaUrl ?? '')
  const [snap, setSnap] = useState<PlmHealthSnapshot | null>(last)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [envId, setEnvId] = useState<PlmEnvId | null>(readEnv)
  const [now, setNow] = useState(Date.now())
  const [sourceAnchor, setSourceAnchor] = useState<HTMLElement | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const inFlight = useRef(false)

  const load = useCallback(async (force = false): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setLoading(true)
    try {
      const s = await window.api.invoke('health:snapshot', force)
      last = s
      setSnap(s)
      setError(null)
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }, [])

  // On screen: read now (unless the last picture is fresh) and every 30 s after, while the window is visible.
  useEffect(() => {
    if (!active) return
    if (!last || Date.now() - last.at > POLL_MS / 2) void load()
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load() }, POLL_MS)
    const vis = (): void => { if (document.visibilityState === 'visible' && last && Date.now() - last.at > POLL_MS) void load() }
    document.addEventListener('visibilitychange', vis)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis) }
  }, [active, load])
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])

  const envs = snap?.envs ?? []
  const env = envs.find((e) => e.id === envId) ?? envs[0] ?? null
  const pickEnv = (id: PlmEnvId): void => { setEnvId(id); saveEnv(id); scroller.current?.scrollTo({ top: 0, behavior: 'smooth' }) }

  // ⌘R reads again, ⌘1…⌘3 pick the environment, while the tab is in front.
  const keys = useRef<(k: TabKey) => boolean>(() => false)
  keys.current = (k: TabKey): boolean => {
    if (k.ctrl || k.alt) return false
    if (k.key === 'r' && !k.shift) { void load(true); return true }
    const n = Number(k.key)
    if (n >= 1 && n <= envs.length && !k.shift) { pickEnv(envs[n - 1].id); return true }
    return false
  }
  useEffect(() => {
    if (!active) return
    setTabKeys('health', (k) => keys.current(k))
    return () => setTabKeys('health', null)
  }, [active])

  const jump = (section: string): void => {
    const el = scroller.current?.querySelector(`#hl-${section}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setFlash(section)
    setTimeout(() => setFlash((f) => (f === section ? null : f)), 1400)
  }
  const openGrafana = (): void => { if (grafanaUrl) void window.api.invoke('shell:open', grafanaUrl).catch((e: Error) => toast('error', e.message)) }

  return (
    <div className="hl" ref={scroller} data-flash={flash ?? undefined}>
      <header className="hl-top">
        <div className="hl-brand">
          <span className="hl-brand-icon"><Icon.health /></span>
          <div className="min-w-0">
            <h1>Health</h1>
            <p>3DEXPERIENCE platform</p>
          </div>
        </div>
        {envs.length > 0 && (
          <nav className="hl-envs" aria-label="Environment">
            {envs.map((e, i) => {
              const n = e.issues.filter((x) => x.level === 'crit' || x.level === 'warn').length
              return (
                <button key={e.id} type="button" className={`hl-env ${env?.id === e.id ? 'on' : ''} ${lvl(e.level)}`} aria-pressed={env?.id === e.id} title={`${e.name}: ${e.headline} (⌘${i + 1})`} onClick={() => pickEnv(e.id)}>
                  <Dot level={e.level} />
                  <span>{e.name}</span>
                  {n > 0 && <span className="hl-env-count">{n}</span>}
                </button>
              )
            })}
          </nav>
        )}
        <div className="hl-actions">
          {snap && (
            <span className={`hl-live ${error ? 'stale' : ''}`} title={error ? `Could not refresh: ${error}` : `Reads again every 30 seconds while on screen. ${snap.source}`}>
              <i />{error ? 'Stale' : 'Live'} · {ago(snap.at, now)}
            </span>
          )}
          <button type="button" className="hl-icon-btn" aria-label="Refresh" title="Refresh (⌘R)" onClick={() => void load(true)} disabled={loading}>
            <Icon.refresh className={loading ? 'animate-spin' : ''} />
          </button>
          {grafanaUrl && (
            <button type="button" className="hl-btn" onClick={openGrafana} title={grafanaUrl}><Icon.external />Grafana</button>
          )}
        </div>
      </header>

      {!snap && !error && <Skeleton />}
      {!snap && error && <ErrorCard message={error} onRetry={() => void load(true)} onSource={(el) => setSourceAnchor(el)} />}
      {snap && error && (
        <div className="hl-banner lvl-warn"><Icon.alert /><span className="min-w-0 flex-1">Could not refresh ({error}). Showing what was read {ago(snap.at, now)}.</span><button type="button" className="hl-btn sm" onClick={() => void load(true)}>Try again</button></div>
      )}
      {env && <EnvView env={env} now={now} onJump={jump} />}

      {snap && (
        <footer className="hl-foot">
          <span className="min-w-0"><Icon.server /> {snap.source}</span>
          {env?.gaps.map((g) => <span key={g} className="hl-gap"><Icon.alert /> {g}</span>)}
          <span className="muted">Limits follow the monitoring server's alert rules: CPU, memory and disk at {LIMITS.disk[1]}%.</span>
          <span className="flex-1" />
          <button type="button" className="hl-link" onClick={(e) => setSourceAnchor(e.currentTarget)}>Data source{grafanaUrl ? '' : ' and Grafana link'}…</button>
        </footer>
      )}
      {sourceAnchor && <SourceMenu anchor={sourceAnchor} onClose={() => setSourceAnchor(null)} onSaved={() => { setSourceAnchor(null); void load(true) }} />}
    </div>
  )
}

// ---------- one environment ----------

function EnvView({ env, now, onJump }: { env: PlmEnvHealth; now: number; onJump: (section: string) => void }): ReactElement {
  const services = env.services
  const upServices = services.filter((s) => s.level === 'ok' || s.level === 'warn').length
  const running = env.hosts.filter((h) => h.state !== 'stopped').length
  const stopped = env.hosts.length - running
  const front = env.albs.find((a) => !a.internal) ?? env.albs[0]
  const alerts = env.alerts.filter((a) => !a.muted)
  const errors = front ? (front.target5xx ?? 0) + (front.elb5xx ?? 0) : null
  const frontMs = front?.responseMs ?? avgFront(services)
  return (
    <div className="hl-body" key={env.id}>
      <section className={`hl-hero ${lvl(env.level)}`}>
        <div className="hl-hero-main">
          <StatusRing level={env.level} />
          <div className="min-w-0">
            <div className="hl-eyebrow">{env.name}</div>
            <h2 className="hl-headline">{env.headline}</h2>
            <div className="hl-hero-sub">
              {upServices} of {services.length} services up · {running} {running === 1 ? 'server' : 'servers'} running{stopped ? ` · ${stopped} stopped` : ''}
            </div>
          </div>
        </div>
        <div className="hl-kpis">
          <Kpi label="Services" value={`${upServices}/${services.length}`} level={worst(services.map((s) => s.level))} onClick={() => onJump('services')} />
          <Kpi label="Response" value={formatMs(frontMs)} level={levelOf(frontMs, LIMITS.albMs)} spark={front?.latencySpark} onClick={() => onJump('alb')} />
          <Kpi label="Requests" value={front?.requestsPerMin !== null && front?.requestsPerMin !== undefined ? `${Math.round(front.requestsPerMin)}/min` : '–'} level="ok" spark={front?.reqSpark} onClick={() => onJump('alb')} />
          <Kpi label="5xx · 15 min" value={errors === null ? '–' : String(Math.round(errors))} level={front?.problems.some((p) => /5xx/.test(p)) ? front.level : errors === null ? 'unknown' : 'ok'} onClick={() => onJump('alb')} />
          <Kpi label="Database CPU" value={formatPct(env.db?.cpu)} level={env.db ? levelOf(env.db.cpu, LIMITS.dbCpu) : 'unknown'} spark={env.db?.cpuSpark} sparkMax={100} onClick={() => onJump('db')} />
          <Kpi label="Alerts" value={String(alerts.length)} level={alerts.length ? worst(alerts.map((a) => a.level)) : 'ok'} onClick={() => onJump('alerts')} />
        </div>
        {env.issues.length > 0 && <Issues issues={env.issues} onJump={onJump} />}
      </section>

      <SectionHead id="hl-services" icon={<Icon.layers />} title="Services" sub="Through the load balancer, and on each server" />
      <div className="hl-grid services">
        {services.map((s) => <ServiceCard key={s.id} s={s} />)}
        {!services.length && <Empty>No service checks for this environment.</Empty>}
      </div>

      {env.jvms.length > 0 && (
        <>
          <SectionHead id="hl-jvm" icon={<Icon.activity />} title="3DSpace application servers" sub="Java heap, garbage collection and threads (JMX)" />
          <div className="hl-grid jvms">{env.jvms.map((j) => <JvmCard key={`${j.ip}${j.label}`} j={j} />)}</div>
        </>
      )}

      <div className="hl-split">
        <div className="min-w-0">
          <SectionHead id="hl-db" icon={<Icon.database />} title="Database" sub={env.db ? `${env.db.engine.replace(/^oracle-se2/i, 'Oracle SE2')} on RDS` : undefined} />
          {env.db ? <DbCard db={env.db} /> : <Empty>No database found for this environment.</Empty>}
        </div>
        <div className="min-w-0">
          <SectionHead id="hl-alb" icon={<Icon.balancer />} title="Load balancer" sub="CloudWatch, last 3 hours" />
          {env.albs.length ? env.albs.map((a) => <AlbCard key={a.name} a={a} />) : <Empty>No load balancer found for this environment.</Empty>}
        </div>
      </div>

      {env.apaches.length > 0 && (
        <>
          <SectionHead id="hl-web" icon={<Icon.globe />} title="Web tier" sub="Apache reverse proxies" />
          <div className="hl-grid web">{env.apaches.map((a) => <ApacheCard key={`${a.ip}${a.label}`} a={a} />)}</div>
        </>
      )}

      <Storage env={env} />
      <Servers env={env} />
      <Alerts env={env} now={now} />
      <Certs env={env} />
    </div>
  )
}

const avgFront = (services: ServiceHealth[]): number | null => {
  const ms = services.flatMap((s) => s.fronts.map((f) => f.ms)).filter((v): v is number => v !== null)
  return ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null
}

function Kpi({ label, value, level, spark, sparkMax, onClick }: { label: string; value: string; level: Level; spark?: (number | null)[]; sparkMax?: number; onClick: () => void }): ReactElement {
  return (
    <button type="button" className={`hl-kpi ${lvl(level)}`} onClick={onClick}>
      <span className="hl-kpi-label">{label}</span>
      <span className="hl-kpi-value">{value}</span>
      {spark && <Spark values={spark} level={level === 'unknown' ? 'ok' : level} min={0} max={sparkMax} height={22} />}
    </button>
  )
}

function Issues({ issues, onJump }: { issues: Issue[]; onJump: (section: string) => void }): ReactElement {
  const [all, setAll] = useState(false)
  const shown = all ? issues : issues.slice(0, 6)
  return (
    <ul className="hl-issues">
      {shown.map((i, n) => (
        <li key={n}>
          <button type="button" className={lvl(i.level)} onClick={() => onJump(i.section === 'servers' ? 'servers' : i.section)}>
            <Dot level={i.level} />
            <span className="min-w-0 flex-1">{i.text}</span>
            <Icon.chevron className="hl-issue-go" />
          </button>
        </li>
      ))}
      {issues.length > 6 && <li><button type="button" className="hl-more" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `${issues.length - 6} more`}</button></li>}
    </ul>
  )
}

// ---------- cards ----------

function ServiceCard({ s }: { s: ServiceHealth }): ReactElement {
  const [mark, hue] = MARKS[s.id] ?? [s.name.slice(0, 2), 220]
  const main = s.fronts[0]
  const ms = main?.ms ?? s.nodes.find((n) => !n.stopped)?.ms ?? null
  const spark = main?.spark ?? s.nodes.find((n) => !n.stopped)?.spark
  return (
    <article className={`hl-card hl-svc ${lvl(s.level)}`} style={{ ['--hue' as string]: hue }}>
      <div className="hl-svc-top">
        <span className="hl-mark">{mark}</span>
        <div className="min-w-0 flex-1">
          <h4 title={s.name}>{s.name}</h4>
          <p>{s.blurb}</p>
        </div>
        <Pill level={s.level}>{s.level === 'ok' ? 'Up' : s.level === 'warn' ? 'Degraded' : undefined}</Pill>
      </div>
      <div className="hl-svc-mid">
        <div>
          {s.level === 'crit' && main?.level === 'crit'
            ? <span className="hl-big none">No answer</span>
            : <span className="hl-big">{formatMs(ms)}</span>}
          <span className="hl-unit">{main ? `via load balancer${main.status && main.level === 'crit' ? ` · HTTP ${main.status}` : ''}` : 'server check'}</span>
        </div>
        <Spark values={spark} level={s.level === 'crit' ? 'crit' : 'ok'} min={0} />
      </div>
      <div className="hl-svc-foot">
        <div className="hl-nodes">
          {s.fronts.slice(1).map((f) => <span key={f.url} className={`hl-node ${lvl(f.level)}`} title={`${f.url}\nHTTP ${f.status ?? '–'} · ${formatMs(f.ms)}`}><i />{/\/internal\//.test(f.url) ? 'internal (LB)' : 'alt (LB)'}</span>)}
          {s.nodes.map((n) => (
            <span key={n.url} className={`hl-node ${lvl(n.level)}`} title={`${n.name}${n.ip ? ` · ${n.ip}` : ''}\n${n.url}\n${n.stopped ? 'Stopped in EC2' : `HTTP ${n.status ?? '–'} · ${formatMs(n.ms)}`}`}>
              <i />{n.label || 'server'}
            </span>
          ))}
        </div>
        <span className="hl-svc-summary">{s.summary}</span>
      </div>
    </article>
  )
}

function JvmCard({ j }: { j: PlmEnvHealth['jvms'][number] }): ReactElement {
  const heapLevel = j.reporting ? levelOf(j.heapPct, LIMITS.heap) : j.level
  return (
    <article className={`hl-card hl-jvm ${lvl(j.level)}`}>
      <div className="hl-card-head">
        <h4>3DSpace {j.label}</h4>
        <span className="hl-card-sub" title={j.ip ?? ''}>{j.name}</span>
        <span className="flex-1" />
        <Pill level={j.level}>{!j.reporting ? (j.level === 'off' ? 'Stopped' : 'No metrics') : undefined}</Pill>
      </div>
      {j.reporting ? (
        <div className="hl-jvm-body">
          <Gauge pct={j.heapPct} level={heapLevel} size={116}>
            <strong>{formatPct(j.heapPct)}</strong>
            <span>heap</span>
            <em>{j.heapUsed === null ? '' : (j.heapUsed / 1024 ** 3).toFixed(1)}/{formatBytes(j.heapMax, 0)}</em>
          </Gauge>
          <div className="hl-stats">
            <Stat label="GC time" value={formatPct(j.gcPct)} level={levelOf(j.gcPct, LIMITS.gc)} />
            <Stat label="Threads" value={j.threads === null ? '–' : String(Math.round(j.threads))} />
            <Stat label="Process CPU" value={formatPct(j.cpu)} level={levelOf(j.cpu, LIMITS.cpu)} />
            <Stat label="Open files" value={formatPct(j.fdsPct)} level={levelOf(j.fdsPct, LIMITS.fds)} />
            <Stat label="Up for" value={formatDuration(j.uptimeSec)} />
          </div>
          <div className="hl-jvm-spark">
            <span className="hl-mini-label">Heap, last hour</span>
            <Spark values={j.heapSpark} level={heapLevel} min={0} max={100} height={36} />
          </div>
        </div>
      ) : (
        <p className="hl-card-note">{j.level === 'off' ? 'The server is stopped in EC2.' : 'The JMX exporter on this server does not answer.'}</p>
      )}
    </article>
  )
}

function Stat({ label, value, level }: { label: string; value: string; level?: Level }): ReactElement {
  return (
    <div className={`hl-stat ${level ? lvl(level) : ''}`}>
      <span className="hl-stat-label">{label}</span>
      <span className="hl-stat-value">{value}</span>
    </div>
  )
}

function DbCard({ db }: { db: NonNullable<PlmEnvHealth['db']> }): ReactElement {
  const freePct = db.freeStorageBytes !== null && db.storageBytes ? (db.freeStorageBytes / db.storageBytes) * 100 : null
  const usedPct = freePct === null ? null : 100 - freePct
  return (
    <article className={`hl-card hl-db ${lvl(db.level)}`}>
      <div className="hl-card-head">
        <h4>{db.id}</h4>
        <span className="hl-chips">
          {db.instanceClass && <span className="hl-chip">{db.instanceClass}</span>}
          {db.multiAz && <span className="hl-chip">Multi-AZ</span>}
        </span>
        <span className="flex-1" />
        <Pill level={db.level}>{db.status === 'available' ? (db.level === 'ok' ? 'Available' : undefined) : db.status}</Pill>
      </div>
      <div className="hl-db-grid">
        <Metric label="CPU" value={formatPct(db.cpu)} level={levelOf(db.cpu, LIMITS.dbCpu)} spark={db.cpuSpark} max={100} />
        <Metric label="Connections" value={db.connections === null ? '–' : String(Math.round(db.connections))} level="ok" spark={db.connSpark} />
        <div className="hl-metric">
          <span className="hl-stat-label">Storage used</span>
          <span className="hl-stat-value">{formatPct(usedPct)} <span className="muted">of {formatBytes(db.storageBytes, 0)}</span></span>
          <Bar pct={usedPct} level={freePct === null ? 'unknown' : freePct <= 10 ? 'crit' : freePct <= 20 ? 'warn' : 'ok'} marks={[80, 90]} />
          <span className="hl-metric-note">{formatBytes(db.freeStorageBytes)} free</span>
        </div>
        <div className="hl-metric">
          <span className="hl-stat-label">Disk latency</span>
          <span className="hl-stat-value">{formatMs(db.readLatencyMs)} <span className="muted">read</span></span>
          <span className="hl-stat-value sm">{formatMs(db.writeLatencyMs)} <span className="muted">write</span></span>
          <span className="hl-metric-note">{formatBytes(db.freeMemBytes)} memory free</span>
        </div>
      </div>
    </article>
  )
}

function Metric({ label, value, level, spark, max }: { label: string; value: string; level: Level; spark?: (number | null)[]; max?: number }): ReactElement {
  return (
    <div className={`hl-metric ${lvl(level)}`}>
      <span className="hl-stat-label">{label}</span>
      <span className="hl-stat-value">{value}</span>
      <Spark values={spark} level={level === 'unknown' ? 'ok' : level} min={0} max={max} height={34} />
    </div>
  )
}

function AlbCard({ a }: { a: AlbHealth }): ReactElement {
  const errors = a.target5xx === null && a.elb5xx === null ? null : (a.target5xx ?? 0) + (a.elb5xx ?? 0)
  return (
    <article className={`hl-card hl-alb ${lvl(a.level)}`}>
      <div className="hl-card-head">
        <h4>{a.name}</h4>
        {a.internal && <span className="hl-chip">internal</span>}
        <span className="flex-1" />
        <Pill level={a.level} />
      </div>
      <div className="hl-db-grid">
        <Metric label="Requests" value={a.requestsPerMin === null ? '–' : `${Math.round(a.requestsPerMin)}/min`} level="ok" spark={a.reqSpark} />
        <Metric label="Response time" value={formatMs(a.responseMs)} level={levelOf(a.responseMs, LIMITS.albMs)} spark={a.latencySpark} />
        <div className={`hl-metric ${lvl(errors ? (a.problems.some((p) => /5xx/.test(p)) ? a.level : 'ok') : 'ok')}`}>
          <span className="hl-stat-label">Server errors · 15 min</span>
          <span className="hl-stat-value">{errors === null ? '–' : Math.round(errors)}</span>
          <span className="hl-metric-note">{a.target5xx === null ? '' : `${Math.round(a.target5xx)} from servers · ${Math.round(a.elb5xx ?? 0)} from the balancer`}</span>
        </div>
        <div className="hl-metric">
          <span className="hl-stat-label">Targets</span>
          <span className="hl-stat-value">{a.healthy === null ? '–' : `${a.healthy} healthy`}</span>
          <span className={`hl-metric-note ${a.unhealthy ? 'bad' : ''}`}>{a.unhealthy === null ? 'No target groups found' : a.unhealthy ? `${a.unhealthy} unhealthy` : 'none unhealthy'}</span>
        </div>
      </div>
    </article>
  )
}

function ApacheCard({ a }: { a: PlmEnvHealth['apaches'][number] }): ReactElement {
  const total = (a.busy ?? 0) + (a.idle ?? 0)
  const busyPct = total ? ((a.busy ?? 0) / total) * 100 : null
  return (
    <article className={`hl-card hl-apache ${lvl(a.level)}`}>
      <div className="hl-card-head">
        <h4>Apache {a.label}</h4>
        <span className="hl-card-sub">{a.name}</span>
        <span className="flex-1" />
        <Pill level={a.level}>{!a.reporting ? (a.level === 'off' ? 'Stopped' : 'No metrics') : undefined}</Pill>
      </div>
      {a.reporting ? (
        <div className="hl-apache-body">
          <div className="min-w-0 flex-1">
            <span className="hl-stat-label">Workers</span>
            <span className="hl-stat-value">{a.busy ?? '–'} busy <span className="muted">· {a.idle ?? '–'} idle</span></span>
            <Bar pct={busyPct} level={levelOf(busyPct, LIMITS.apacheBusy)} marks={[LIMITS.apacheBusy[0]]} />
          </div>
          <div className="hl-apache-req">
            <span className="hl-stat-label">Requests</span>
            <span className="hl-stat-value">{a.reqPerSec === null ? '–' : `${a.reqPerSec.toFixed(1)}/s`}</span>
            <Spark values={a.spark} min={0} height={26} />
          </div>
        </div>
      ) : (
        <p className="hl-card-note">{a.level === 'off' ? 'The server is stopped in EC2.' : 'The Apache exporter does not answer.'}</p>
      )}
    </article>
  )
}

// ---------- lists ----------

function Storage({ env }: { env: PlmEnvHealth }): ReactElement | null {
  const [all, setAll] = useState(false)
  if (!env.storage.length) return null
  const notable = env.storage.filter((s) => s.pct >= 50 || s.level !== 'ok')
  const shown = all ? env.storage : notable.length ? notable : env.storage.slice(0, 5)
  return (
    <>
      <SectionHead id="hl-storage" icon={<Icon.disk />} title="Storage" sub="Shared file stores and the fullest disks" right={env.storage.length > shown.length || all ? <button type="button" className="hl-link" onClick={() => setAll(!all)}>{all ? 'Fullest only' : `All ${env.storage.length}`}</button> : undefined} />
      <div className="hl-card hl-list">
        {shown.map((s) => (
          <div key={`${s.device}${s.mount}${s.hosts[0]}`} className={`hl-row hl-storage-row ${lvl(s.level)}`}>
            <div className="min-w-0">
              <div className="hl-row-title"><Dot level={s.level} /><span className="truncate">{s.mount}</span>{s.shared && <span className="hl-chip">shared</span>}</div>
              <div className="hl-row-sub truncate" title={s.device}>{s.hosts.join(' · ')}{s.shared ? ` · ${s.device}` : ''}</div>
            </div>
            <Bar pct={s.pct} level={s.level} marks={[LIMITS.disk[0], LIMITS.disk[1]]} />
            <div className="hl-row-num"><strong>{formatPct(s.pct)}</strong><span>{formatBytes(s.sizeBytes - s.usedBytes)} free of {formatBytes(s.sizeBytes, 0)}</span></div>
          </div>
        ))}
      </div>
    </>
  )
}

type ServerFilter = 'all' | 'problems' | 'stopped'

function Servers({ env }: { env: PlmEnvHealth }): ReactElement {
  const [filter, setFilter] = useState<ServerFilter>('all')
  const problems = env.hosts.filter((h) => h.level === 'crit' || h.level === 'warn')
  const stopped = env.hosts.filter((h) => h.state === 'stopped')
  const shown = filter === 'problems' ? problems : filter === 'stopped' ? stopped : env.hosts
  const chip = (f: ServerFilter, label: string, n: number): ReactElement => (
    <button type="button" className={filter === f ? 'on' : ''} aria-pressed={filter === f} onClick={() => setFilter(f)}>{label}<span>{n}</span></button>
  )
  return (
    <>
      <SectionHead id="hl-servers" icon={<Icon.server />} title="Servers" sub="CPU, memory and disk from each machine"
        right={<div className="hl-seg">{chip('all', 'All', env.hosts.length)}{chip('problems', 'Problems', problems.length)}{chip('stopped', 'Stopped', stopped.length)}</div>} />
      <div className="hl-card hl-list hl-servers">
        <div className="hl-srv-head" aria-hidden="true"><span>Server</span><span>CPU</span><span>Memory</span><span>Fullest disk</span><span>Load</span><span>Up for</span><span /></div>
        {shown.map((h) => <ServerRow key={`${h.ip}${h.role}${h.label}`} h={h} />)}
        {!shown.length && <Empty>{filter === 'problems' ? 'No server needs attention.' : 'No stopped servers.'}</Empty>}
      </div>
    </>
  )
}

function ServerRow({ h }: { h: HostHealth }): ReactElement {
  const st = useStore.getState
  const off = h.state === 'stopped'
  const cell = (label: string, pct: number | null, limits: readonly [number, number], extra?: ReactNode): ReactElement => (
    <div className="hl-srv-cell" data-label={label}>
      {pct === null ? <span className="muted">–</span> : <><span className="hl-srv-num">{formatPct(pct)}</span><Bar pct={pct} level={levelOf(pct, limits)} marks={[limits[1]]} /></>}
      {extra}
    </div>
  )
  return (
    <div className={`hl-row hl-srv ${lvl(h.level)} ${off ? 'off' : ''}`}>
      <div className="hl-srv-name min-w-0">
        <div className="hl-row-title"><Dot level={h.level} /><span className="truncate">{h.role}{h.label ? ` ${h.label}` : ''}</span>{h.os === 'windows' && <Icon.windows />}</div>
        <div className="hl-row-sub truncate" title={`${h.name} · ${h.ip}${h.instanceType ? ` · ${h.instanceType}` : ''}`}>{h.name} · {h.ip}</div>
        {h.problems.length > 0 && !off && <div className="hl-row-problem">{h.problems.join(' · ')}</div>}
      </div>
      {off || !h.reporting ? (
        <div className="hl-srv-wide">{off ? <Pill level="off">Stopped in EC2</Pill> : <Pill level="crit">Not reporting</Pill>}</div>
      ) : (
        <>
          {cell('CPU', h.cpu, LIMITS.cpu)}
          {cell('Memory', h.mem, LIMITS.mem, h.memBytes ? <span className="hl-srv-sub">{formatBytes(h.memBytes, 0)}</span> : undefined)}
          {cell('Disk', h.disk?.pct ?? null, h.os === 'windows' ? LIMITS.diskWindows : LIMITS.disk, h.disk ? <span className="hl-srv-sub truncate">{h.disk.mount}</span> : undefined)}
          <div className="hl-srv-cell" data-label="Load"><span className="hl-srv-num">{h.load === null ? '–' : h.load.toFixed(2)}</span>{h.cores ? <span className="hl-srv-sub">{h.cores} {h.cores === 1 ? 'core' : 'cores'}</span> : null}</div>
          <div className="hl-srv-cell" data-label="Up for"><span className="hl-srv-num">{formatDuration(h.uptimeSec)}</span></div>
        </>
      )}
      <div className="hl-srv-actions">
        {h.instanceKey && h.os === 'linux' && !off && <button type="button" className="hl-btn sm" title={`Open a shell on ${h.name}`} onClick={() => openSshFor(h.instanceKey!)}><Icon.terminal />SSH</button>}
        {h.instanceKey && <button type="button" className="hl-icon-btn sm" title="Show in the host list" aria-label="Show in the host list" onClick={() => st().revealHost(h.instanceKey!)}><Icon.info /></button>}
      </div>
    </div>
  )
}

function Alerts({ env, now }: { env: PlmEnvHealth; now: number }): ReactElement {
  const [showMuted, setShowMuted] = useState(false)
  const live = env.alerts.filter((a) => !a.muted)
  const muted = env.alerts.filter((a) => a.muted)
  const list = showMuted ? env.alerts : live
  return (
    <>
      <SectionHead id="hl-alerts" icon={<Icon.alert />} title="Alerts" sub="Firing in Prometheus"
        right={muted.length ? <button type="button" className="hl-link" onClick={() => setShowMuted(!showMuted)}>{showMuted ? 'Hide' : 'Show'} {muted.length} about stopped servers</button> : undefined} />
      <div className="hl-card hl-list">
        {list.map((a, i) => (
          <div key={`${a.name}${a.target}${i}`} className={`hl-row hl-alert ${lvl(a.level)}`}>
            <Dot level={a.level} />
            <div className="min-w-0 flex-1">
              <div className="hl-row-title"><span>{prettyAlert(a.name)}</span><span className="hl-row-target truncate">{a.target}</span></div>
              {a.summary && <div className="hl-row-sub">{a.muted ? 'Its server is stopped in EC2. ' : ''}{a.summary.replace(/\s*\(Instance: [^)]*\)/, '')}</div>}
            </div>
            {a.since && <span className="hl-row-when" title={new Date(a.since).toLocaleString()}>{ago(a.since, now).replace(' ago', '')}</span>}
          </div>
        ))}
        {!list.length && <div className="hl-all-clear"><Icon.check /> Nothing firing{muted.length ? ` (${muted.length} about stopped servers set aside)` : ''}.</div>}
      </div>
    </>
  )
}

const prettyAlert = (name: string): string => name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\bC P U\b/, 'CPU').replace(/^(\w)/, (m) => m.toUpperCase())

function Certs({ env }: { env: PlmEnvHealth }): ReactElement | null {
  if (!env.certs.length) return null
  const first = env.certs[0]
  const same = env.certs.every((c) => Math.abs(c.days - first.days) <= 1)
  return (
    <>
      <SectionHead id="hl-certs" icon={<Icon.shield />} title="Certificates" sub="TLS on the public addresses" />
      <div className={`hl-card hl-certs ${lvl(worst(env.certs.map((c) => c.level)))}`}>
        {same ? (
          <div className="hl-cert-all">
            <Gauge pct={Math.min(100, (first.days / 365) * 100)} level={first.level} size={72}><strong>{first.days}</strong><span>days</span></Gauge>
            <div className="min-w-0">
              <div className="hl-row-title">All {env.certs.length} certificates are valid until {new Date(first.expires).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</div>
              <div className="hl-cert-hosts">{env.certs.map((c) => <span key={c.host} className="hl-chip">{c.host.replace(/\.mainspring\.network$/, '')}</span>)}</div>
            </div>
          </div>
        ) : env.certs.map((c) => (
          <div key={c.host} className={`hl-row ${lvl(c.level)}`}>
            <Dot level={c.level} /><span className="min-w-0 flex-1 truncate">{c.host}</span><strong>{c.days} days</strong>
          </div>
        ))}
      </div>
    </>
  )
}

// ---------- states ----------

function Skeleton(): ReactElement {
  return (
    <div className="hl-body" aria-busy="true">
      <div className="hl-hero hl-skel" style={{ height: 220 }} />
      <div className="hl-grid services">{Array.from({ length: 8 }, (_, i) => <div key={i} className="hl-card hl-skel" style={{ height: 150, animationDelay: `${i * 60}ms` }} />)}</div>
      <p className="hl-loading-note">Opening a tunnel to the monitoring server…</p>
    </div>
  )
}

function ErrorCard({ message, onRetry, onSource }: { message: string; onRetry: () => void; onSource: (el: HTMLElement) => void }): ReactElement {
  const auth = isAuthError(message)
  const [signing, setSigning] = useState(false)
  return (
    <div className="hl-error">
      <span className="hl-error-icon"><Icon.alert /></span>
      <h2>{auth ? 'Sign in to AWS to see the platform' : 'Cannot reach the monitoring server'}</h2>
      <p>{message}</p>
      <div className="hl-error-actions">
        {auth && (
          <button type="button" className="btn btn-primary" disabled={signing} onClick={() => { setSigning(true); void useStore.getState().refreshToken().finally(() => { setSigning(false); onRetry() }) }}>
            {signing ? 'Waiting for sign-in…' : 'Sign in'}
          </button>
        )}
        <button type="button" className={`btn ${auth ? '' : 'btn-primary'}`} onClick={onRetry}>Try again</button>
        <button type="button" className="btn" onClick={(e) => onSource(e.currentTarget)}>Data source…</button>
      </div>
    </div>
  )
}

function SourceMenu({ anchor, onClose, onSaved }: { anchor: HTMLElement; onClose: () => void; onSaved: () => void }): ReactElement {
  const settings = useStore((s) => s.settings)
  const instances = useStore((s) => s.instances)
  const candidates = useMemo(() => instances.filter((i) => i.state === 'running' && i.ssmOnline && i.platform !== 'windows').sort((a, b) => Number(!/monitor|prometheus/i.test(a.name)) - Number(!/monitor|prometheus/i.test(b.name)) || a.name.localeCompare(b.name)), [instances])
  const [key, setKey] = useState(settings?.healthSource?.instanceKey ?? '')
  const [host, setHost] = useState(settings?.healthSource?.host ?? '')
  const [port, setPort] = useState(settings?.healthSource?.port ? String(settings.healthSource.port) : '')
  const [grafana, setGrafana] = useState(settings?.grafanaUrl ?? '')
  const auto = candidates.find((i) => /monitor|prometheus/i.test(i.name))
  const save = (): void => {
    const p = Number(port)
    const g = grafana.trim()
    if (g && !/^https?:\/\//i.test(g)) { useStore.getState().toast('error', 'The Grafana link starts with https://'); return }
    void useStore.getState().saveSettings({
      healthSource: { instanceKey: key || undefined, host: host.trim() || undefined, port: p > 0 && p < 65536 ? p : undefined },
      grafanaUrl: g || undefined
    }).then(onSaved, (e: Error) => useStore.getState().toast('error', e.message))
  }
  return (
    <Popover anchor={anchor} align="right" width={340} onClose={onClose}>
      <div className="hl-source">
        <div className="hl-source-title">Data source</div>
        <p className="muted">The Prometheus server the platform reports to, reached over SSM. Leave a field empty for the automatic choice.</p>
        <label>Monitoring server
          <select className="input" value={key} onChange={(e) => setKey(e.target.value)}>
            <option value="">Automatic{auto ? ` (${auto.name})` : ''}</option>
            {candidates.map((i) => <option key={i.key} value={i.key}>{i.name} · {i.profile}</option>)}
          </select>
        </label>
        <div className="hl-source-row">
          <label>Prometheus address<input className="input" placeholder={auto?.privateIp ?? 'its private address'} value={host} onChange={(e) => setHost(e.target.value)} /></label>
          <label className="w-24">Port<input className="input" inputMode="numeric" placeholder="9090" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} /></label>
        </div>
        <label>Grafana link<input className="input" placeholder="https://grafana.example.com" value={grafana} onChange={(e) => setGrafana(e.target.value)} /></label>
        <div className="hl-source-actions">
          <button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={save}>Save</button>
        </div>
      </div>
    </Popover>
  )
}

